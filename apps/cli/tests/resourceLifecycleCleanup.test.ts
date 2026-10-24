import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ShutdownController,
  shutdownController,
  resetShutdownControllerForTest,
  resetShutdownControllerForTests,
  register,
  unregister,
  install,
  shutdown,
  type TrackedSubprocessHandle,
} from '../src/shutdownController.js';

class FakeChildProcess extends EventEmitter implements TrackedSubprocessHandle {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  signalsReceived: Array<NodeJS.Signals | number | undefined> = [];
  private readonly autoExitOnSigterm: boolean;

  constructor(options: { autoExitOnSigterm?: boolean } = {}) {
    super();
    this.autoExitOnSigterm = options.autoExitOnSigterm ?? true;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signalsReceived.push(signal);
    if (signal === 'SIGKILL') {
      this.killed = true;
      this.signalCode = 'SIGKILL';
      this.exitCode = null;
      this.emit('exit', null, 'SIGKILL');
      this.emit('close', null, 'SIGKILL');
      return true;
    }
    if (this.autoExitOnSigterm) {
      this.killed = true;
      this.signalCode = (typeof signal === 'string' ? signal : 'SIGTERM') as NodeJS.Signals;
      this.exitCode = 0;
      queueMicrotask(() => {
        this.emit('exit', 0, this.signalCode);
        this.emit('close', 0, this.signalCode);
      });
    }
    return true;
  }
}

describe('ShutdownController — Resource Lifecycle Cleanup (Agent 05)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    exitSpy?.mockRestore();
    exitSpy = undefined;
    resetShutdownControllerForTests();
    vi.useRealTimers();
  });

  describe('Subprocess tracking and termination', () => {
    it('tracks a subprocess and automatically unregisters it when "exit" is emitted', () => {
      const controller = new ShutdownController();
      const child = new FakeChildProcess();

      controller.trackSubprocess('worker-1', child);
      expect(controller.getStats().subprocesses).toBe(1);

      child.exitCode = 0;
      child.emit('exit', 0, null);

      expect(controller.getStats().subprocesses).toBe(0);
    });

    it('automatically unregisters when "close" is emitted or when the returned disposer is called', () => {
      const controller = new ShutdownController();
      const child1 = new FakeChildProcess();
      const child2 = new FakeChildProcess();

      controller.trackSubprocess('worker-close', child1);
      const untrack2 = controller.trackSubprocess('worker-manual', child2);
      expect(controller.getStats().subprocesses).toBe(2);

      child1.emit('close', 0, null);
      expect(controller.getStats().subprocesses).toBe(1);

      untrack2();
      expect(controller.getStats().subprocesses).toBe(0);
    });

    it('terminates running subprocesses with SIGTERM during cleanupAll() and escalates to SIGKILL when unresponsive', async () => {
      const controller = new ShutdownController({
        gracefulTimeoutMs: 1000,
        subprocessKillGraceMs: 30,
      });

      const politeChild = new FakeChildProcess({ autoExitOnSigterm: true });
      const stubbornChild = new FakeChildProcess({ autoExitOnSigterm: false });

      controller.trackSubprocess('polite', politeChild);
      controller.trackSubprocess('stubborn', stubbornChild);
      expect(controller.getStats().subprocesses).toBe(2);

      const result = await controller.cleanupAll();

      expect(result.subprocessesTerminated).toBe(2);
      expect(politeChild.signalsReceived).toEqual(['SIGTERM']);
      expect(stubbornChild.signalsReceived).toEqual(['SIGTERM', 'SIGKILL']);
      expect(controller.getStats().subprocesses).toBe(0);
    });

    it('skips tracking subprocesses that have already exited', async () => {
      const controller = new ShutdownController();
      const alreadyExited = new FakeChildProcess();
      alreadyExited.exitCode = 0;

      controller.trackSubprocess('done', alreadyExited);
      expect(controller.getStats().subprocesses).toBe(0);

      const result = await controller.cleanupAll();
      expect(result.subprocessesTerminated).toBe(0);
      expect(alreadyExited.signalsReceived).toEqual([]);
    });
  });

  describe('Timer and interval tracking', () => {
    it('tracks timeouts and intervals and deterministically clears them during cleanupAll()', async () => {
      const controller = new ShutdownController();
      let timeoutFired = false;
      let intervalCount = 0;

      const timeout = setTimeout(() => {
        timeoutFired = true;
      }, 40);
      const interval = setInterval(() => {
        intervalCount++;
      }, 15);

      controller.trackTimer('t1', timeout, 'timeout');
      controller.trackTimer('i1', interval, 'interval');
      expect(controller.getStats().timers).toBe(2);

      const result = await controller.cleanupAll();
      expect(result.timersCleared).toBe(2);
      expect(controller.getStats().timers).toBe(0);

      await new Promise((r) => setTimeout(r, 70));
      expect(timeoutFired).toBe(false);
      expect(intervalCount).toBe(0);
    });

    it('clears a timer immediately when its returned disposer is invoked or when replaced by the same id', async () => {
      const controller = new ShutdownController();
      let firstFired = false;
      let secondFired = false;

      const t1 = setTimeout(() => {
        firstFired = true;
      }, 30);
      const t2 = setTimeout(() => {
        secondFired = true;
      }, 30);

      controller.trackTimer('poll', t1, 'timeout');
      // Replacing under the same id clears the previous timer automatically
      const untrackSecond = controller.trackTimer('poll', t2, 'timeout');
      expect(controller.getStats().timers).toBe(1);

      untrackSecond();
      expect(controller.getStats().timers).toBe(0);

      await new Promise((r) => setTimeout(r, 60));
      expect(firstFired).toBe(false);
      expect(secondFired).toBe(false);
    });
  });

  describe('Event listener tracking and leak prevention', () => {
    it('attaches and removes EventEmitter listeners on cleanupAll() without leaking listeners', async () => {
      const controller = new ShutdownController();
      const emitter = new EventEmitter();
      emitter.setMaxListeners(2);

      const received: string[] = [];
      const handler1 = (msg: string) => received.push(`h1:${msg}`);
      const handler2 = (msg: string) => received.push(`h2:${msg}`);

      controller.trackListener('l1', emitter, 'data', handler1);
      controller.trackListener('l2', emitter, 'data', handler2);

      expect(controller.getStats().listeners).toBe(2);
      expect(emitter.listenerCount('data')).toBe(2);

      emitter.emit('data', 'ping');
      expect(received).toEqual(['h1:ping', 'h2:ping']);

      const result = await controller.cleanupAll();
      expect(result.listenersRemoved).toBe(2);
      expect(controller.getStats().listeners).toBe(0);
      expect(emitter.listenerCount('data')).toBe(0);

      emitter.emit('data', 'after-cleanup');
      expect(received).toEqual(['h1:ping', 'h2:ping']);
    });

    it('supports DOM/EventTarget style addEventListener/removeEventListener and manual disposer', () => {
      const controller = new ShutdownController();
      const added: Array<{ ev: string; fn: (...args: any[]) => void }> = [];
      const removed: Array<{ ev: string; fn: (...args: any[]) => void }> = [];

      const domTarget = {
        addEventListener(ev: string, fn: (...args: any[]) => void) {
          added.push({ ev, fn });
        },
        removeEventListener(ev: string, fn: (...args: any[]) => void) {
          removed.push({ ev, fn });
        },
      };

      const fn = () => {};
      const dispose = controller.trackListener('dom-abort', domTarget, 'abort', fn);
      expect(added).toHaveLength(1);
      expect(controller.getStats().listeners).toBe(1);

      dispose();
      expect(removed).toHaveLength(1);
      expect(controller.getStats().listeners).toBe(0);
    });

    it('does not double-attach a listener that was already attached to an EventEmitter', async () => {
      const controller = new ShutdownController();
      const emitter = new EventEmitter();
      let calls = 0;
      const fn = () => {
        calls++;
      };

      emitter.on('tick', fn);
      controller.trackListener('pre-attached', emitter, 'tick', fn);

      expect(emitter.listenerCount('tick')).toBe(1);
      emitter.emit('tick');
      expect(calls).toBe(1);

      await controller.cleanupAll();
      expect(emitter.listenerCount('tick')).toBe(0);
    });
  });

  describe('Disposer error isolation and timeout enforcement in cleanupAll()', () => {
    it('isolates failing disposers and returns detailed cleanup summary', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const controller = new ShutdownController({ gracefulTimeoutMs: 500 });

      controller.register('db-close', async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      controller.register('exploding-step', () => {
        throw new Error('socket-reset');
      });

      const result = await controller.cleanupAll();

      expect(result.disposed).toEqual(['db-close']);
      expect(result.failed).toEqual([{ name: 'exploding-step', error: 'socket-reset' }]);
      expect(controller.getStats().disposers).toBe(0);
      stderrSpy.mockRestore();
    });

    it('enforces gracefulTimeoutMs when a disposer hangs during cleanupAll()', async () => {
      const controller = new ShutdownController({ gracefulTimeoutMs: 60 });
      let fastCompleted = false;

      controller.register('fast', () => {
        fastCompleted = true;
      });
      controller.register('hung', () => new Promise(() => {}));

      const start = Date.now();
      const result = await controller.cleanupAll();
      const elapsed = Date.now() - start;

      expect(fastCompleted).toBe(true);
      expect(result.disposed).toContain('fast');
      expect(elapsed).toBeLessThan(400);
    });
  });

  describe('install() / uninstall() idempotency and singleton helpers', () => {
    it('installs and uninstalls SIGINT, SIGTERM, and SIGHUP handlers without leaking process listeners', () => {
      const controller = new ShutdownController();
      const baseInt = process.listenerCount('SIGINT');
      const baseTerm = process.listenerCount('SIGTERM');
      const baseHup = process.listenerCount('SIGHUP');

      controller.install();
      controller.install(); // idempotent second call
      expect(controller.getStats().installed).toBe(true);
      expect(process.listenerCount('SIGINT')).toBe(baseInt + 1);
      expect(process.listenerCount('SIGTERM')).toBe(baseTerm + 1);
      expect(process.listenerCount('SIGHUP')).toBe(baseHup + 1);

      controller.uninstall();
      controller.uninstall(); // idempotent second call
      expect(controller.getStats().installed).toBe(false);
      expect(process.listenerCount('SIGINT')).toBe(baseInt);
      expect(process.listenerCount('SIGTERM')).toBe(baseTerm);
      expect(process.listenerCount('SIGHUP')).toBe(baseHup);
    });

    it('preserves backward-compatible module-level exports and cleans up on shutdown()', async () => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);

      let disposedViaHelper = false;
      install();
      register('helper-step', () => {
        disposedViaHelper = true;
      });
      register('removed-step', () => {
        throw new Error('should not run');
      });
      unregister('removed-step');

      expect(shutdownController().getStats().disposers).toBe(1);

      await shutdown('SIGTERM');

      expect(disposedViaHelper).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(0);

      resetShutdownControllerForTest();
      expect(shutdownController().getStats().disposers).toBe(0);
    });
  });
});
