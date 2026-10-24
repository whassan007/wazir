import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeadlineExceededError,
  ExecutionCancellationScope,
  ExecutionCancelledError,
  ExecutionDeadlineBudget,
  runWithDeadline,
  type CancellationReason,
} from '../src/services/executionDeadlines.js';

describe('ExecutionDeadlineBudget', () => {
  it('reports Infinity remaining and never expires when unbounded', () => {
    const budget = new ExecutionDeadlineBudget({ clock: () => 1_000 });
    expect(budget.isBounded).toBe(false);
    expect(budget.remainingMs()).toBe(Infinity);
    expect(budget.isExpired()).toBe(false);
    expect(budget.allocatePhaseTimeout('model_call')).toBe(Infinity);
    expect(budget.allocatePhaseTimeout('model_call', 5_000)).toBe(5_000);
  });

  it('computes remaining time from totalBudgetMs and clamps to 0 once expired', () => {
    let now = 10_000;
    const budget = new ExecutionDeadlineBudget({ totalBudgetMs: 3_000, clock: () => now });
    expect(budget.deadlineAtMs).toBe(13_000);
    expect(budget.remainingMs()).toBe(3_000);
    now = 12_500;
    expect(budget.remainingMs()).toBe(500);
    expect(budget.isExpired()).toBe(false);
    now = 14_000;
    expect(budget.remainingMs()).toBe(0);
    expect(budget.isExpired()).toBe(true);
    expect(budget.remainingMs(11_000)).toBe(2_000);
  });

  it('prefers an absolute deadlineAtMs over totalBudgetMs', () => {
    const budget = new ExecutionDeadlineBudget({ deadlineAtMs: 5_000, totalBudgetMs: 60_000, clock: () => 4_000 });
    expect(budget.remainingMs()).toBe(1_000);
  });

  it('clamps requested timeouts to remaining budget minus reserve and to phase caps', () => {
    let now = 0;
    const budget = new ExecutionDeadlineBudget({
      totalBudgetMs: 10_000,
      phaseBudgetsMs: { tool_dispatch: 2_000, verification: 8_000 },
      clock: () => now,
    });

    // Requested within budget → granted as-is.
    expect(budget.allocatePhaseTimeout('model_call', 4_000)).toBe(4_000);
    // Requested beyond budget → clamped to remaining minus reserve.
    expect(budget.allocatePhaseTimeout('model_call', 30_000, 1_000)).toBe(9_000);
    // Phase cap wins over a larger request and acts as the default.
    expect(budget.allocatePhaseTimeout('tool_dispatch', 5_000)).toBe(2_000);
    expect(budget.allocatePhaseTimeout('tool_dispatch')).toBe(2_000);
    // No request, no cap → whole remainder minus reserve.
    expect(budget.allocatePhaseTimeout('planning', undefined, 500)).toBe(9_500);

    now = 7_000;
    // Phase cap (8s) exceeds what is left (3s) → remaining budget wins.
    expect(budget.allocatePhaseTimeout('verification')).toBe(3_000);
    expect(budget.allocatePhaseTimeout('verification', undefined, 1_000)).toBe(2_000);
  });

  it('throws a structured DeadlineExceededError when the budget is exhausted', () => {
    let now = 0;
    const budget = new ExecutionDeadlineBudget({ totalBudgetMs: 1_000, clock: () => now });

    now = 1_000;
    let thrown: unknown;
    try {
      budget.allocatePhaseTimeout('recovery', 500);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeadlineExceededError);
    expect(thrown).toMatchObject({ code: 'DEADLINE_EXCEEDED', phase: 'recovery', remainingMs: 0, timeoutMs: 500 });

    const result = budget.tryAllocatePhaseTimeout('recovery', 500);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(DeadlineExceededError);
  });

  it('fails allocation when the reserve consumes all remaining budget', () => {
    const budget = new ExecutionDeadlineBudget({ totalBudgetMs: 1_000, clock: () => 0 });
    expect(() => budget.allocatePhaseTimeout('model_call', 5_000, 1_000)).toThrow(DeadlineExceededError);
    expect(budget.tryAllocatePhaseTimeout('model_call', 5_000, 999)).toEqual({ ok: true, phase: 'model_call', timeoutMs: 1 });
  });
});

describe('ExecutionCancellationScope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires DEADLINE_EXCEEDED when its timer elapses and aborts the signal with a DeadlineExceededError', () => {
    const scope = new ExecutionCancellationScope({ timeoutMs: 100, phase: 'model_call' });
    const reasons: CancellationReason[] = [];
    scope.onCancel((reason) => reasons.push(reason));

    expect(scope.hasActiveTimer).toBe(true);
    vi.advanceTimersByTime(99);
    expect(scope.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);

    expect(scope.signal.aborted).toBe(true);
    expect(scope.reason).toBe('DEADLINE_EXCEEDED');
    expect(scope.signal.reason).toBeInstanceOf(DeadlineExceededError);
    expect(reasons).toEqual(['DEADLINE_EXCEEDED']);
    expect(scope.hasActiveTimer).toBe(false);
    expect(() => scope.throwIfCancelled()).toThrow(DeadlineExceededError);
    scope.dispose();
  });

  it('cascades parent cancellation to child scopes and callbacks in deterministic order', () => {
    const external = new AbortController();
    const root = new ExecutionCancellationScope({ parentSignal: external.signal });
    const childA = root.createChild({ phase: 'tool_dispatch' });
    const childB = root.createChild({ phase: 'verification' });
    const grandchild = childA.createChild();

    const trace: string[] = [];
    root.onCancel((reason) => trace.push(`root:${reason}`));
    root.onCancel(() => trace.push('root:second'));
    childA.onCancel((reason) => trace.push(`A:${reason}`));
    grandchild.onCancel((reason) => trace.push(`A1:${reason}`));
    childB.onCancel((reason) => trace.push(`B:${reason}`));

    external.abort();

    expect(trace).toEqual([
      'root:PARENT_CANCELLED',
      'root:second',
      'A:PARENT_CANCELLED',
      'A1:PARENT_CANCELLED',
      'B:PARENT_CANCELLED',
    ]);
    for (const scope of [root, childA, childB, grandchild]) {
      expect(scope.signal.aborted).toBe(true);
      expect(scope.reason).toBe('PARENT_CANCELLED');
    }
    expect(childA.signal.reason).toBeInstanceOf(ExecutionCancelledError);
    root.dispose();
  });

  it('propagates EXPLICIT_CANCEL downward only and keeps cancel idempotent', () => {
    const root = new ExecutionCancellationScope();
    const child = root.createChild();
    const callback = vi.fn();
    child.onCancel(callback);

    child.cancel();
    child.cancel('DEADLINE_EXCEEDED');

    expect(child.reason).toBe('EXPLICIT_CANCEL');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(root.isCancelled).toBe(false);

    root.cancel();
    expect(root.reason).toBe('EXPLICIT_CANCEL');
    expect(child.reason).toBe('EXPLICIT_CANCEL');

    const late = root.createChild();
    expect(late.reason).toBe('PARENT_CANCELLED');
    const lateCallback = vi.fn();
    root.onCancel(lateCallback);
    expect(lateCallback).toHaveBeenCalledWith('EXPLICIT_CANCEL', root);
    root.dispose();
  });

  it('starts cancelled when the parent signal is already aborted, without attaching a listener', () => {
    const external = new AbortController();
    external.abort();
    const addSpy = vi.spyOn(external.signal, 'addEventListener');
    const scope = new ExecutionCancellationScope({ parentSignal: external.signal, timeoutMs: 1_000 });

    expect(scope.reason).toBe('PARENT_CANCELLED');
    expect(addSpy).not.toHaveBeenCalled();
    expect(scope.hasActiveTimer).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates throwing callbacks so propagation still reaches every subscriber', () => {
    const scope = new ExecutionCancellationScope();
    const child = scope.createChild();
    const boom = new Error('boom');
    const after = vi.fn();
    scope.onCancel(() => {
      throw boom;
    });
    scope.onCancel(after);

    scope.cancel();
    expect(after).toHaveBeenCalledTimes(1);
    expect(child.isCancelled).toBe(true);
    expect(scope.callbackErrors).toEqual([boom]);
    scope.dispose();
  });

  it('releases timers, parent listeners, and child links on dispose', () => {
    const external = new AbortController();
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener');
    const root = new ExecutionCancellationScope({ parentSignal: external.signal, timeoutMs: 5_000 });
    const child = root.createChild({ timeoutMs: 1_000 });
    const callback = vi.fn();
    child.onCancel(callback);

    expect(vi.getTimerCount()).toBe(2);
    expect(root.hasParentListener).toBe(true);
    expect(root.childCount).toBe(1);

    root.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(root.hasParentListener).toBe(false);
    expect(root.hasActiveTimer).toBe(false);
    expect(child.hasActiveTimer).toBe(false);
    expect(child.isDisposed).toBe(true);
    expect(root.childCount).toBe(0);

    // Neither the timer nor the parent abort may fire anything after dispose.
    external.abort();
    vi.advanceTimersByTime(10_000);
    expect(callback).not.toHaveBeenCalled();
    expect(root.signal.aborted).toBe(false);
    expect(child.signal.aborted).toBe(false);
  });

  it('detaches a disposed child from its parent', () => {
    const root = new ExecutionCancellationScope();
    const child = root.createChild({ timeoutMs: 50 });
    expect(root.childCount).toBe(1);
    child.dispose();
    expect(root.childCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    root.cancel();
    expect(child.isCancelled).toBe(false);
  });

  it('arms phase scopes from the execution budget', () => {
    let now = 0;
    const budget = new ExecutionDeadlineBudget({ totalBudgetMs: 1_000, clock: () => now });
    const scope = budget.createPhaseScope('tool_dispatch', { requestedTimeoutMs: 10_000, reserveMs: 200 });

    vi.advanceTimersByTime(799);
    expect(scope.isCancelled).toBe(false);
    vi.advanceTimersByTime(1);
    expect(scope.reason).toBe('DEADLINE_EXCEEDED');
    expect(scope.phase).toBe('tool_dispatch');

    now = 1_000;
    expect(() => budget.createPhaseScope('verification')).toThrow(DeadlineExceededError);
    scope.dispose();
  });
});

describe('runWithDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the operation result and leaves no timers behind', async () => {
    const external = new AbortController();
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener');
    const result = await runWithDeadline(async (signal) => {
      expect(signal.aborted).toBe(false);
      return 42;
    }, { timeoutMs: 1_000, parentSignal: external.signal });

    expect(result).toBe(42);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('rejects with DeadlineExceededError on timeout, aborts the operation signal, and awaits onTimeout', async () => {
    const order: string[] = [];
    let operationSignal: AbortSignal | undefined;
    const onTimeout = vi.fn(async () => {
      order.push('onTimeout');
    });

    const pending = runWithDeadline((signal) => {
      operationSignal = signal;
      return new Promise<string>(() => {});
    }, { timeoutMs: 250, phase: 'model_call', onTimeout });
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'DeadlineExceededError',
      code: 'DEADLINE_EXCEEDED',
      phase: 'model_call',
      timeoutMs: 250,
    });

    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    order.push('rejected');

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['onTimeout', 'rejected']);
    expect(operationSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with ExecutionCancelledError on parent abort without calling onTimeout', async () => {
    const external = new AbortController();
    const onTimeout = vi.fn();
    let operationSignal: AbortSignal | undefined;

    const pending = runWithDeadline((signal) => {
      operationSignal = signal;
      return new Promise<void>(() => {});
    }, { timeoutMs: 10_000, parentSignal: external.signal, phase: 'tool_dispatch', onTimeout });
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'ExecutionCancelledError',
      reason: 'PARENT_CANCELLED',
      phase: 'tool_dispatch',
    });

    external.abort();
    await assertion;

    expect(onTimeout).not.toHaveBeenCalled();
    expect(operationSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start the operation when the parent is already aborted or the timeout is non-positive', async () => {
    const operation = vi.fn(async () => 'never');
    const external = new AbortController();
    external.abort();

    await expect(runWithDeadline(operation, { timeoutMs: 1_000, parentSignal: external.signal })).rejects.toBeInstanceOf(
      ExecutionCancelledError,
    );
    const onTimeout = vi.fn();
    await expect(runWithDeadline(operation, { timeoutMs: 0, onTimeout })).rejects.toBeInstanceOf(DeadlineExceededError);

    expect(operation).not.toHaveBeenCalled();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates operation errors and still disposes, including synchronous throws', async () => {
    const failure = new Error('tool failed');
    await expect(runWithDeadline(async () => {
      throw failure;
    }, { timeoutMs: 1_000 })).rejects.toBe(failure);
    await expect(runWithDeadline(() => {
      throw failure;
    }, { timeoutMs: 1_000 })).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces the deadline even if onTimeout throws and the operation later rejects', async () => {
    let rejectOperation: (error: Error) => void = () => {};
    const pending = runWithDeadline(
      () => new Promise<void>((_, reject) => {
        rejectOperation = reject;
      }),
      {
        timeoutMs: 100,
        onTimeout: () => {
          throw new Error('cleanup failed');
        },
      },
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineExceededError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    rejectOperation(new Error('late failure'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});
