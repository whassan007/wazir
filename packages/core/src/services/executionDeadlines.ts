/**
 * Deterministic execution deadlines and cascading cancellation.
 *
 * An execution has one overall deadline. Every phase (planning, model calls,
 * tool dispatch, verification, recovery) must fit inside what is left of it,
 * so a slow tool call can never silently push the run past its budget. Abort
 * reasons are propagated synchronously and in registration order so that the
 * same sequence of events always produces the same cancellation trace, and
 * every timer/listener is released on dispose so long-running hosts don't leak.
 */

export type CancellationReason = 'DEADLINE_EXCEEDED' | 'PARENT_CANCELLED' | 'EXPLICIT_CANCEL';

export type ExecutionPhase =
  | 'planning'
  | 'model_call'
  | 'tool_dispatch'
  | 'verification'
  | 'recovery'
  | (string & {});

export class DeadlineExceededError extends Error {
  readonly code = 'DEADLINE_EXCEEDED' as const;
  readonly phase?: string;
  /** Budget remaining (after any reserve) when the deadline was hit; 0 or negative. */
  readonly remainingMs: number;
  /** Timeout that was in force, when known. */
  readonly timeoutMs?: number;

  constructor(details: { phase?: string; remainingMs?: number; timeoutMs?: number; message?: string } = {}) {
    const where = details.phase ? ` during phase "${details.phase}"` : '';
    super(details.message ?? `Execution deadline exceeded${where}`);
    this.name = 'DeadlineExceededError';
    this.phase = details.phase;
    this.remainingMs = details.remainingMs ?? 0;
    this.timeoutMs = details.timeoutMs;
  }
}

export class ExecutionCancelledError extends Error {
  readonly code: CancellationReason;
  readonly reason: CancellationReason;
  readonly phase?: string;

  constructor(reason: CancellationReason, phase?: string) {
    const where = phase ? ` during phase "${phase}"` : '';
    super(`Execution cancelled (${reason})${where}`);
    this.name = 'ExecutionCancelledError';
    this.code = reason;
    this.reason = reason;
    this.phase = phase;
  }
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface DeadlineBudgetOptions {
  /** Absolute epoch-ms deadline. Takes precedence over totalBudgetMs when both are set. */
  deadlineAtMs?: number;
  /** Relative budget measured from startedAtMs (or now). */
  totalBudgetMs?: number;
  /** Start time used with totalBudgetMs. Defaults to clock(). */
  startedAtMs?: number;
  /** Per-phase timeout caps; also used as the default when no timeout is requested. */
  phaseBudgetsMs?: Partial<Record<ExecutionPhase, number>>;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  clock?: () => number;
}

export type PhaseAllocation =
  | { ok: true; phase: string; timeoutMs: number }
  | { ok: false; phase: string; error: DeadlineExceededError };

export class ExecutionDeadlineBudget {
  /** Absolute deadline in epoch ms, or Infinity when unbounded. */
  readonly deadlineAtMs: number;
  readonly startedAtMs: number;
  private readonly phaseBudgetsMs: Partial<Record<string, number>>;
  private readonly clock: () => number;

  constructor(options: DeadlineBudgetOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.startedAtMs = options.startedAtMs ?? this.clock();
    this.phaseBudgetsMs = { ...(options.phaseBudgetsMs ?? {}) };
    if (options.deadlineAtMs !== undefined) {
      this.deadlineAtMs = options.deadlineAtMs;
    } else if (options.totalBudgetMs !== undefined) {
      this.deadlineAtMs = this.startedAtMs + Math.max(0, options.totalBudgetMs);
    } else {
      this.deadlineAtMs = Infinity;
    }
  }

  get isBounded(): boolean {
    return Number.isFinite(this.deadlineAtMs);
  }

  /** Milliseconds left before the overall deadline: 0 once expired, Infinity when unbounded. */
  remainingMs(now: number = this.clock()): number {
    if (!this.isBounded) return Infinity;
    return Math.max(0, this.deadlineAtMs - now);
  }

  isExpired(now: number = this.clock()): boolean {
    return this.remainingMs(now) <= 0;
  }

  phaseBudgetMs(phase: string): number | undefined {
    return this.phaseBudgetsMs[phase];
  }

  /**
   * Non-throwing variant of allocatePhaseTimeout. The granted timeout is the
   * smallest of: the requested timeout, the phase cap, and remaining budget
   * minus reserveMs. Fails when nothing usable is left.
   */
  tryAllocatePhaseTimeout(
    phase: string,
    requestedTimeoutMs?: number,
    reserveMs = 0,
    now: number = this.clock(),
  ): PhaseAllocation {
    const remaining = this.remainingMs(now);
    const available = remaining - Math.max(0, reserveMs);
    const phaseCap = this.phaseBudgetsMs[phase];

    let timeoutMs = available;
    if (phaseCap !== undefined) timeoutMs = Math.min(timeoutMs, phaseCap);
    if (requestedTimeoutMs !== undefined) timeoutMs = Math.min(timeoutMs, requestedTimeoutMs);

    if (remaining <= 0 || !(timeoutMs > 0)) {
      return {
        ok: false,
        phase,
        error: new DeadlineExceededError({
          phase,
          remainingMs: Number.isFinite(available) ? available : 0,
          timeoutMs: requestedTimeoutMs,
          message:
            remaining <= 0
              ? `Execution deadline exceeded before phase "${phase}" could start`
              : `Insufficient execution budget for phase "${phase}" (remaining ${remaining}ms, reserve ${reserveMs}ms)`,
        }),
      };
    }
    return { ok: true, phase, timeoutMs: Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : Infinity };
  }

  /**
   * Clamp a phase/tool/model timeout to the remaining execution budget minus
   * reserveMs. Throws DeadlineExceededError when no budget remains.
   */
  allocatePhaseTimeout(phase: string, requestedTimeoutMs?: number, reserveMs = 0): number {
    const allocation = this.tryAllocatePhaseTimeout(phase, requestedTimeoutMs, reserveMs);
    if ('error' in allocation) throw allocation.error;
    return allocation.timeoutMs;
  }

  /** Allocate a phase timeout and arm a cancellation scope with it. */
  createPhaseScope(
    phase: string,
    options: { requestedTimeoutMs?: number; reserveMs?: number; parentSignal?: AbortSignal; parent?: ExecutionCancellationScope } = {},
  ): ExecutionCancellationScope {
    const timeoutMs = this.allocatePhaseTimeout(phase, options.requestedTimeoutMs, options.reserveMs);
    const scopeOptions: CancellationScopeOptions = { timeoutMs, phase, parentSignal: options.parentSignal };
    return options.parent ? options.parent.createChild(scopeOptions) : new ExecutionCancellationScope(scopeOptions);
  }
}

// ---------------------------------------------------------------------------
// Cancellation scope
// ---------------------------------------------------------------------------

export interface CancellationScopeOptions {
  /** External signal (e.g. a request's AbortSignal) whose abort cancels this scope. */
  parentSignal?: AbortSignal;
  /** Arms a deadline timer; <= 0 cancels immediately. Infinity/undefined means no timer. */
  timeoutMs?: number;
  phase?: string;
}

export type CancelCallback = (reason: CancellationReason, scope: ExecutionCancellationScope) => void;

export class ExecutionCancellationScope {
  readonly phase?: string;
  /** Errors thrown by onCancel callbacks; collected so propagation is never interrupted. */
  readonly callbackErrors: unknown[] = [];

  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private parentSignal: AbortSignal | undefined;
  private parentScope: ExecutionCancellationScope | undefined;
  private readonly children: ExecutionCancellationScope[] = [];
  private callbacks: CancelCallback[] = [];
  private cancelReason: CancellationReason | undefined;
  private disposed = false;

  private readonly onParentAbort = (): void => {
    this.cancel('PARENT_CANCELLED');
  };

  constructor(options: CancellationScopeOptions = {}, parentScope?: ExecutionCancellationScope) {
    this.phase = options.phase;
    this.parentScope = parentScope;

    if (options.parentSignal) {
      if (options.parentSignal.aborted) {
        this.cancel('PARENT_CANCELLED');
        return;
      }
      this.parentSignal = options.parentSignal;
      this.parentSignal.addEventListener('abort', this.onParentAbort, { once: true });
    }

    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
      if (timeoutMs <= 0) {
        this.cancel('DEADLINE_EXCEEDED');
      } else {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.cancel('DEADLINE_EXCEEDED');
        }, timeoutMs);
      }
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get reason(): CancellationReason | undefined {
    return this.cancelReason;
  }

  get isCancelled(): boolean {
    return this.cancelReason !== undefined;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Leak introspection: true while a deadline timer is armed. */
  get hasActiveTimer(): boolean {
    return this.timer !== undefined;
  }

  /** Leak introspection: true while subscribed to the parent signal. */
  get hasParentListener(): boolean {
    return this.parentSignal !== undefined;
  }

  get childCount(): number {
    return this.children.length;
  }

  get callbackCount(): number {
    return this.callbacks.length;
  }

  /**
   * Create a child scope that is cancelled with PARENT_CANCELLED whenever this
   * scope is cancelled. A child created after cancellation starts cancelled.
   */
  createChild(options: Omit<CancellationScopeOptions, 'parentSignal'> & { parentSignal?: AbortSignal } = {}): ExecutionCancellationScope {
    const child = new ExecutionCancellationScope({ phase: this.phase, ...options }, this);
    if (this.disposed) {
      child.dispose();
      return child;
    }
    if (this.isCancelled) {
      child.cancel('PARENT_CANCELLED');
      return child;
    }
    this.children.push(child);
    return child;
  }

  /**
   * Register a callback invoked once on cancellation. If already cancelled the
   * callback runs synchronously. Returns an unsubscribe function.
   */
  onCancel(callback: CancelCallback): () => void {
    if (this.cancelReason !== undefined) {
      this.invoke(callback, this.cancelReason);
      return () => {};
    }
    if (this.disposed) return () => {};
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((cb) => cb !== callback);
    };
  }

  /**
   * Cancel this scope and everything beneath it. Order is fixed: own signal
   * aborts, then onCancel callbacks (registration order), then children
   * (creation order, depth-first) with PARENT_CANCELLED. Idempotent.
   */
  cancel(reason: CancellationReason = 'EXPLICIT_CANCEL'): void {
    if (this.cancelReason !== undefined || this.disposed) return;
    this.cancelReason = reason;
    this.releaseResources();

    this.controller.abort(
      reason === 'DEADLINE_EXCEEDED'
        ? new DeadlineExceededError({ phase: this.phase })
        : new ExecutionCancelledError(reason, this.phase),
    );

    const callbacks = this.callbacks;
    this.callbacks = [];
    for (const callback of callbacks) this.invoke(callback, reason);

    for (const child of [...this.children]) child.cancel('PARENT_CANCELLED');
  }

  throwIfCancelled(): void {
    if (this.cancelReason === undefined) return;
    throw this.cancelReason === 'DEADLINE_EXCEEDED'
      ? new DeadlineExceededError({ phase: this.phase })
      : new ExecutionCancelledError(this.cancelReason, this.phase);
  }

  /**
   * Release the timer, the parent-signal listener, callbacks, and the link to
   * the parent scope, and dispose all children. Does not abort the signal.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseResources();
    this.callbacks = [];
    for (const child of [...this.children]) child.dispose();
    this.children.length = 0;
    if (this.parentScope) {
      this.parentScope.detachChild(this);
      this.parentScope = undefined;
    }
  }

  private detachChild(child: ExecutionCancellationScope): void {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
  }

  private releaseResources(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.parentSignal) {
      this.parentSignal.removeEventListener('abort', this.onParentAbort);
      this.parentSignal = undefined;
    }
  }

  private invoke(callback: CancelCallback, reason: CancellationReason): void {
    try {
      callback(reason, this);
    } catch (error) {
      this.callbackErrors.push(error);
    }
  }
}

// ---------------------------------------------------------------------------
// runWithDeadline
// ---------------------------------------------------------------------------

export interface RunWithDeadlineOptions {
  timeoutMs: number;
  parentSignal?: AbortSignal;
  phase?: string;
  /** Awaited before the DeadlineExceededError is thrown. Errors are swallowed. */
  onTimeout?: () => void | Promise<void>;
}

/**
 * Run an operation under a deadline. Rejects with DeadlineExceededError on
 * timeout (after awaiting onTimeout) or ExecutionCancelledError when the
 * parent signal aborts. The timer and parent listener are always released.
 */
export async function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: RunWithDeadlineOptions,
): Promise<T> {
  const { timeoutMs, parentSignal, phase, onTimeout } = options;
  const scope = new ExecutionCancellationScope({ timeoutMs, parentSignal, phase });

  const toError = async (reason: CancellationReason): Promise<Error> => {
    if (reason === 'DEADLINE_EXCEEDED') {
      if (onTimeout) {
        try {
          await onTimeout();
        } catch {
          // The deadline is the primary failure; a failing cleanup hook must not mask it.
        }
      }
      return new DeadlineExceededError({ phase, timeoutMs });
    }
    return new ExecutionCancelledError(reason, phase);
  };

  try {
    if (scope.reason !== undefined) throw await toError(scope.reason);

    const cancelled = new Promise<never>((_, reject) => {
      scope.onCancel((reason) => {
        toError(reason).then(reject, reject);
      });
    });

    let work: Promise<T>;
    try {
      work = Promise.resolve(operation(scope.signal));
    } catch (error) {
      work = Promise.reject(error);
    }
    // If the deadline wins the race, a late rejection from the operation must not surface as unhandled.
    work.catch(() => {});

    return await Promise.race([work, cancelled]);
  } finally {
    scope.dispose();
  }
}
