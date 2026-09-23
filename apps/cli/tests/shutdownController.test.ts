import { describe, it, expect, vi, afterEach } from 'vitest';
import { ShutdownController } from '../src/shutdownController.js';

describe('ShutdownController', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    exitSpy?.mockRestore();
    vi.useRealTimers();
  });

  it('runs every registered disposer and exits 0 on a graceful SIGTERM', async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const controller = new ShutdownController({ gracefulTimeoutMs: 5000 });
    const order: string[] = [];
    controller.register('slow', async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('slow');
    });
    controller.register('fast', () => {
      order.push('fast');
    });

    await controller.shutdown('SIGTERM');

    expect(order.sort()).toEqual(['fast', 'slow']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 130 on SIGINT', async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const controller = new ShutdownController();
    await controller.shutdown('SIGINT');
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('force-exits once gracefulTimeoutMs elapses even if a disposer never resolves — the exact bug this replaces (server.close() with no timeout)', async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const controller = new ShutdownController({ gracefulTimeoutMs: 50 });
    controller.register('hung', () => new Promise(() => {})); // never resolves

    const start = Date.now();
    await controller.shutdown('SIGTERM');
    const elapsed = Date.now() - start;

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(elapsed).toBeLessThan(500); // bounded, not "hangs forever"
  });

  it('a disposer that throws does not block the other disposers or the exit', async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const controller = new ShutdownController({ gracefulTimeoutMs: 1000 });
    let otherRan = false;
    controller.register('broken', () => { throw new Error('disposer-boom'); });
    controller.register('other', () => { otherRan = true; });

    await controller.shutdown('SIGTERM');

    expect(otherRan).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('disposer-boom'))).toBe(true);
    stderrSpy.mockRestore();
  });

  it('a second shutdown call while already shutting down force-exits immediately without waiting for the first to finish', async () => {
    let resolveHung: (() => void) | undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const controller = new ShutdownController({ gracefulTimeoutMs: 60_000 });
    controller.register('hung', () => new Promise<void>((resolve) => { resolveHung = resolve; }));

    // Don't await the first call — it's intentionally still in flight (hung
    // disposer, 60s timeout) when the second signal arrives, mirroring a real
    // "Ctrl-C again because the first one didn't seem to do anything" case.
    void controller.shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 20));

    const start = Date.now();
    await controller.shutdown('SIGINT');
    const elapsed = Date.now() - start;

    expect(exitSpy).toHaveBeenCalledWith(130); // second signal was SIGINT
    expect(elapsed).toBeLessThan(200); // didn't wait for the 60s timeout
    resolveHung?.();
  });

  it('install() only registers process signal handlers once even if called twice', () => {
    const onSpy = vi.spyOn(process, 'on');
    const controller = new ShutdownController();
    controller.install();
    const callCountAfterFirst = onSpy.mock.calls.length;
    controller.install();
    expect(onSpy.mock.calls.length).toBe(callCountAfterFirst);
    onSpy.mockRestore();
  });
});
