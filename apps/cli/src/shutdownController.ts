/**
 * A single, centralized exit/disposal path for long-running CLI commands
 * (`wa chat`, `wa dashboard`, a worker, the API server). Before this, each of
 * those registered its own ad hoc SIGINT/SIGTERM/SIGHUP handler directly —
 * `dashboard`'s `server.close(() => process.exit(0))` had no timeout at all
 * (a stuck connection means `close`'s callback never fires and the process
 * hangs on Ctrl-C forever), `chat` only handled SIGHUP and nothing else, and
 * neither handled a second Ctrl-C during an already-hung shutdown.
 *
 * One-shot leaf commands (`wa jobs list`, `wa models load`, ...) are
 * deliberately NOT routed through this — they hold no open resources or
 * signal handlers; their `process.exit(result.code)` is just reporting a
 * result, not a lifecycle to manage.
 */

export interface ShutdownControllerOptions {
  /** How long registered disposers get to finish before a forced exit. Default 5000ms. */
  gracefulTimeoutMs?: number;
  /** How long tracked subprocesses get after SIGTERM before escalating to SIGKILL. Default min(500, gracefulTimeoutMs / 2). */
  subprocessKillGraceMs?: number;
}

export interface TrackedSubprocessHandle {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  killed?: boolean;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
  once?: (event: string, listener: (...args: any[]) => void) => any;
  on?: (event: string, listener: (...args: any[]) => void) => any;
  off?: (event: string, listener: (...args: any[]) => void) => any;
  removeListener?: (event: string, listener: (...args: any[]) => void) => any;
}

export interface TrackedListenerTarget {
  on?: (ev: string, fn: (...args: any[]) => void) => any;
  addListener?: (ev: string, fn: (...args: any[]) => void) => any;
  addEventListener?: (ev: string, fn: (...args: any[]) => void) => any;
  off?: (ev: string, fn: (...args: any[]) => void) => any;
  removeListener?: (ev: string, fn: (...args: any[]) => void) => any;
  removeEventListener?: (ev: string, fn: (...args: any[]) => void) => any;
  listeners?: (ev: string) => Array<(...args: any[]) => void>;
}

export interface CleanupAllResult {
  disposed: string[];
  failed: Array<{ name: string; error: string }>;
  subprocessesTerminated: number;
  timersCleared: number;
  listenersRemoved: number;
}

export interface ShutdownControllerStats {
  disposers: number;
  subprocesses: number;
  timers: number;
  listeners: number;
  installed: boolean;
}

type Disposer = () => void | Promise<void>;
type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

interface TrackedSubprocessEntry {
  id: string;
  child: TrackedSubprocessHandle;
  detachExitListeners: () => void;
}

interface TrackedTimerEntry {
  id: string;
  timer: TimerHandle;
  kind?: 'timeout' | 'interval';
}

interface TrackedListenerEntry {
  id: string;
  target: TrackedListenerTarget;
  event: string;
  listener: (...args: any[]) => void;
  detach: () => void;
}

// Deliberately matching the directive's stated codes rather than the stricter
// POSIX 128+signum convention (SIGTERM would normally be 143): 0 for any
// clean/graceful termination including a handled SIGTERM, 130 for SIGINT.
const EXIT_CODE_CLEAN = 0;
const EXIT_CODE_SIGINT = 130;
const EXIT_CODE_FORCED = 1;

function isSubprocessTerminated(child: TrackedSubprocessHandle): boolean {
  if (child.exitCode !== undefined && child.exitCode !== null) {
    return true;
  }
  if (child.signalCode !== undefined && child.signalCode !== null) {
    return true;
  }
  if (child.killed === true && child.exitCode === undefined && child.signalCode === undefined) {
    return true;
  }
  return false;
}

function clearTimerHandle(timer: TimerHandle, kind?: 'timeout' | 'interval'): void {
  if (kind === 'interval') {
    clearInterval(timer);
    return;
  }
  if (kind === 'timeout') {
    clearTimeout(timer);
    return;
  }
  clearTimeout(timer);
  clearInterval(timer);
}

export class ShutdownController {
  private readonly disposers = new Map<string, Disposer>();
  private readonly subprocesses = new Map<string, TrackedSubprocessEntry>();
  private readonly timers = new Map<string, TrackedTimerEntry>();
  private readonly listeners = new Map<string, TrackedListenerEntry>();
  private readonly gracefulTimeoutMs: number;
  private readonly subprocessKillGraceMs: number;
  private shuttingDown = false;
  private installed = false;
  private signalHandlers: Partial<Record<NodeJS.Signals, () => void>> = {};

  constructor(options: ShutdownControllerOptions = {}) {
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5000;
    this.subprocessKillGraceMs =
      options.subprocessKillGraceMs ?? Math.min(250, Math.max(20, Math.floor(this.gracefulTimeoutMs / 4)));
  }

  /** Registers a cleanup step, keyed so a caller can safely register-then-replace (e.g. across a reconnect) without leaking duplicate disposers. */
  register(name: string, disposer: Disposer): void {
    this.disposers.set(name, disposer);
  }

  unregister(name: string): void {
    this.disposers.delete(name);
  }

  /**
   * Tracks a child subprocess and automatically unregisters it when `'exit'` or `'close'` fires.
   * Remaining tracked subprocesses are deterministically terminated (`SIGTERM` -> `SIGKILL`) on `cleanupAll()` / `shutdown()`.
   */
  trackSubprocess(id: string, child: TrackedSubprocessHandle): () => void {
    const existing = this.subprocesses.get(id);
    if (existing) {
      existing.detachExitListeners();
      this.subprocesses.delete(id);
    }

    if (isSubprocessTerminated(child)) {
      return () => {
        this.subprocesses.delete(id);
      };
    }

    const onDone = () => {
      const current = this.subprocesses.get(id);
      if (current && current.child === child) {
        current.detachExitListeners();
        this.subprocesses.delete(id);
      }
    };

    const detachCallbacks: Array<() => void> = [];
    for (const ev of ['exit', 'close'] as const) {
      if (typeof child.once === 'function') {
        child.once(ev, onDone);
        detachCallbacks.push(() => {
          if (typeof child.off === 'function') {
            child.off(ev, onDone);
          } else if (typeof child.removeListener === 'function') {
            child.removeListener(ev, onDone);
          }
        });
      } else if (typeof child.on === 'function') {
        child.on(ev, onDone);
        detachCallbacks.push(() => {
          if (typeof child.off === 'function') {
            child.off(ev, onDone);
          } else if (typeof child.removeListener === 'function') {
            child.removeListener(ev, onDone);
          }
        });
      }
    }

    const detachExitListeners = () => {
      while (detachCallbacks.length > 0) {
        const fn = detachCallbacks.pop();
        try {
          fn?.();
        } catch {
          // ignore detach errors
        }
      }
    };

    this.subprocesses.set(id, { id, child, detachExitListeners });

    return () => {
      const current = this.subprocesses.get(id);
      if (current && current.child === child) {
        current.detachExitListeners();
        this.subprocesses.delete(id);
      }
    };
  }

  /**
   * Tracks a timeout or interval handle and clears it deterministically during `cleanupAll()` / `shutdown()`.
   */
  trackTimer(
    id: string,
    timer: TimerHandle,
    kind?: 'timeout' | 'interval',
  ): () => void {
    const existing = this.timers.get(id);
    if (existing && existing.timer !== timer) {
      clearTimerHandle(existing.timer, existing.kind);
    }
    this.timers.set(id, { id, timer, kind });

    return () => {
      const current = this.timers.get(id);
      if (current && current.timer === timer) {
        this.timers.delete(id);
        clearTimerHandle(timer, kind);
      }
    };
  }

  /**
   * Tracks an event listener on an EventEmitter or EventTarget, attaching it if not already attached,
   * and deterministically removes it on `cleanupAll()` / `shutdown()` or when the returned disposer runs.
   */
  trackListener(
    id: string,
    target: TrackedListenerTarget,
    event: string,
    listener: (...args: any[]) => void,
  ): () => void {
    const existing = this.listeners.get(id);
    if (existing) {
      existing.detach();
      this.listeners.delete(id);
    }

    const alreadyAttached =
      typeof target.listeners === 'function' &&
      Array.isArray(target.listeners(event)) &&
      target.listeners(event).includes(listener);

    if (!alreadyAttached) {
      if (typeof target.on === 'function') {
        target.on(event, listener);
      } else if (typeof target.addListener === 'function') {
        target.addListener(event, listener);
      } else if (typeof target.addEventListener === 'function') {
        target.addEventListener(event, listener);
      }
    }

    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      if (typeof target.off === 'function') {
        target.off(event, listener);
      } else if (typeof target.removeListener === 'function') {
        target.removeListener(event, listener);
      } else if (typeof target.removeEventListener === 'function') {
        target.removeEventListener(event, listener);
      }
    };

    this.listeners.set(id, { id, target, event, listener, detach });

    return () => {
      const current = this.listeners.get(id);
      if (current && current.listener === listener && current.target === target && current.event === event) {
        this.listeners.delete(id);
      }
      detach();
    };
  }

  /** Installs the process-level signal handlers. Idempotent. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const sig of signals) {
      const handler = () => void this.shutdown(sig);
      this.signalHandlers[sig] = handler;
      process.on(sig, handler);
    }
  }

  /** Removes the process-level signal handlers installed by `install()`. Idempotent. */
  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    for (const [sig, handler] of Object.entries(this.signalHandlers) as Array<[NodeJS.Signals, (() => void) | undefined]>) {
      if (handler) {
        process.off(sig, handler);
      }
    }
    this.signalHandlers = {};
  }

  /** Returns live counts of tracked lifecycle resources for leak detection and verification. */
  getStats(): ShutdownControllerStats {
    return {
      disposers: this.disposers.size,
      subprocesses: this.subprocesses.size,
      timers: this.timers.size,
      listeners: this.listeners.size,
      installed: this.installed,
    };
  }

  private async terminateSubprocessEntry(entry: TrackedSubprocessEntry): Promise<boolean> {
    const { child } = entry;
    entry.detachExitListeners();
    if (isSubprocessTerminated(child)) {
      return false;
    }

    let exitResolve: (() => void) | undefined;
    const exitPromise = new Promise<void>((resolve) => {
      exitResolve = resolve;
    });

    const onExit = () => {
      exitResolve?.();
    };

    if (typeof child.once === 'function') {
      child.once('exit', onExit);
      child.once('close', onExit);
    } else if (typeof child.on === 'function') {
      child.on('exit', onExit);
      child.on('close', onExit);
    }

    try {
      child.kill?.('SIGTERM');
    } catch {
      // ignore kill errors (e.g. ESRCH)
    }

    if (isSubprocessTerminated(child)) {
      if (typeof child.off === 'function') {
        child.off('exit', onExit);
        child.off('close', onExit);
      } else if (typeof child.removeListener === 'function') {
        child.removeListener('exit', onExit);
        child.removeListener('close', onExit);
      }
      return true;
    }

    const canObserveExit = typeof child.once === 'function' || typeof child.on === 'function';
    if (canObserveExit && this.subprocessKillGraceMs > 0) {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const gracePromise = new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, this.subprocessKillGraceMs);
        graceTimer.unref?.();
      });
      await Promise.race([exitPromise, gracePromise]);
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
    }

    if (!isSubprocessTerminated(child)) {
      try {
        child.kill?.('SIGKILL');
      } catch {
        // ignore kill errors
      }
    }

    if (typeof child.off === 'function') {
      child.off('exit', onExit);
      child.off('close', onExit);
    } else if (typeof child.removeListener === 'function') {
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
    }

    return true;
  }

  /**
   * Deterministically cleans up all tracked timers, event listeners, subprocesses, and registered disposers
   * without calling `process.exit()`, bounded by `gracefulTimeoutMs`.
   */
  async cleanupAll(): Promise<CleanupAllResult> {
    const disposed: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    // 1. Clear all tracked timers immediately.
    const timerEntries = [...this.timers.values()];
    this.timers.clear();
    let timersCleared = 0;
    for (const entry of timerEntries) {
      try {
        clearTimerHandle(entry.timer, entry.kind);
        timersCleared++;
      } catch {
        // ignore timer clear errors
      }
    }

    // 2. Remove all tracked event listeners immediately.
    const listenerEntries = [...this.listeners.values()];
    this.listeners.clear();
    let listenersRemoved = 0;
    for (const entry of listenerEntries) {
      try {
        entry.detach();
        listenersRemoved++;
      } catch {
        // ignore listener removal errors
      }
    }

    // 3. Terminate tracked subprocesses and run registered disposers concurrently under gracefulTimeoutMs.
    const subprocessEntries = [...this.subprocesses.values()];
    this.subprocesses.clear();

    let subprocessesTerminated = 0;
    const subprocessTasks = subprocessEntries.map(async (entry) => {
      const terminated = await this.terminateSubprocessEntry(entry);
      if (terminated) {
        subprocessesTerminated++;
      }
    });

    const disposerEntries = [...this.disposers.entries()];
    this.disposers.clear();

    const disposals = disposerEntries.map(async ([name, dispose]) => {
      try {
        await dispose();
        disposed.push(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ name, error: message });
        process.stderr.write(`wa: shutdown step '${name}' failed: ${message}\n`);
      }
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, this.gracefulTimeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      await Promise.race([Promise.all([...subprocessTasks, ...disposals]), timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }

    // Ensure any subprocesses still alive if gracefulTimeoutMs fired before subprocessKillGraceMs are SIGKILLed.
    for (const entry of subprocessEntries) {
      if (!isSubprocessTerminated(entry.child)) {
        try {
          entry.child.kill?.('SIGKILL');
        } catch {
          // ignore
        }
      }
    }

    return {
      disposed,
      failed,
      subprocessesTerminated,
      timersCleared,
      listenersRemoved,
    };
  }

  /** Runs every registered disposer and cleans up tracked resources, bounded by gracefulTimeoutMs, then exits with the code matching `signal`. A second call while already shutting down force-exits immediately instead of waiting again. */
  async shutdown(signal: NodeJS.Signals): Promise<never> {
    if (this.shuttingDown) {
      process.stderr.write('\nwa: second interrupt — forcing exit\n');
      process.exit(signal === 'SIGINT' ? EXIT_CODE_SIGINT : EXIT_CODE_FORCED);
      // process.exit() never returns in real Node, but nothing here should
      // rely on that: a wrapped/mocked exit (as in this module's own tests)
      // must not fall through into re-running the full disposer sequence a
      // second time, including a wait for whatever hung the first attempt.
      return undefined as never;
    }
    this.shuttingDown = true;

    await this.cleanupAll();
    process.exit(signal === 'SIGINT' ? EXIT_CODE_SIGINT : EXIT_CODE_CLEAN);
    return undefined as never;
  }
}

let instance: ShutdownController | undefined;

/** The process-wide controller. Created and installed on first use. */
export function shutdownController(): ShutdownController {
  if (!instance) {
    instance = new ShutdownController();
    instance.install();
  }
  return instance;
}

/** Test-only: replaces the singleton so tests don't leak signal handlers or state across each other. */
export function resetShutdownControllerForTests(): void {
  instance?.uninstall();
  instance = undefined;
}

/** Alias for test helpers expecting the singular name. */
export const resetShutdownControllerForTest = resetShutdownControllerForTests;

/** Convenience wrapper that delegates `register` to the singleton `shutdownController()`. */
export function register(name: string, disposer: Disposer): void {
  shutdownController().register(name, disposer);
}

/** Convenience wrapper that delegates `unregister` to the singleton `shutdownController()`. */
export function unregister(name: string): void {
  shutdownController().unregister(name);
}

/** Convenience wrapper that delegates `install` to the singleton `shutdownController()`. */
export function install(): void {
  shutdownController().install();
}

/** Convenience wrapper that delegates `shutdown` to the singleton `shutdownController()`. */
export function shutdown(signal: NodeJS.Signals): Promise<never> {
  return shutdownController().shutdown(signal);
}
