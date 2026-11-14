export interface ProviderLimits {
  maxConcurrent: number;
  maxQueueDepth: number;
  minCooldownMs: number;
  maxRetryBudgetPerMinute: number;
}

export interface ProviderBackpressureOptions {
  defaults?: Partial<ProviderLimits>;
  providers?: Record<string, Partial<ProviderLimits>>;
  retryWindowMs?: number;
  maxActiveRetryRatio?: number;
}

export interface ProviderOutcome {
  status?: number;
  retryAfterMs?: number;
  rateLimitRemainingRequests?: number;
  rateLimitRemainingTokens?: number;
  resetAtMs?: number;
  isRetry?: boolean;
}

export interface ProviderLease {
  release(outcome?: ProviderOutcome): void;
}

export interface ProviderState {
  inFlight: number;
  queued: number;
  cooldownRemainingMs: number;
  retriesInWindow: number;
  totalAdmitted: number;
  totalRejected: number;
  totalRateLimited: number;
}

interface Waiter {
  priority: number;
  isRetry: boolean;
  deadline: number;
  resolve: (lease: ProviderLease) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
interface State {
  limits: ProviderLimits;
  inFlight: number;
  activeRetries: number;
  queue: Waiter[];
  cooldownUntilMs: number;
  retries: number[];
  totalAdmitted: number;
  totalRejected: number;
  totalRateLimited: number;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULTS: ProviderLimits = {
  maxConcurrent: 4, maxQueueDepth: 100, minCooldownMs: 1_000, maxRetryBudgetPerMinute: 30,
};

/** Equal-attempt decorrelated jitter, with Retry-After acting as a hard lower bound. */
export function computeBackoffWithJitter(
  attempt: number, baseDelayMs = 1_000, maxDelayMs = 60_000, retryAfterMs = 0,
): number {
  if (![attempt, baseDelayMs, maxDelayMs, retryAfterMs].every(Number.isFinite)
    || attempt < 0 || baseDelayMs < 0 || maxDelayMs < baseDelayMs || retryAfterMs < 0) {
    throw new RangeError('Invalid backoff parameters');
  }
  // Reconstruct a decorrelated sequence without sharing mutable state across providers.
  let delay = baseDelayMs;
  for (let i = 0; i <= Math.min(Math.floor(attempt), 100); i++) {
    delay = Math.min(maxDelayMs, baseDelayMs + Math.random() * (delay * 3 - baseDelayMs));
  }
  return Math.max(retryAfterMs, Math.ceil(delay));
}

/** Provider-local admission, cooldowns and retry budgets. Higher priorities run first; ties are FIFO. */
export class ProviderBackpressureGovernor {
  private readonly states = new Map<string, State>();
  private readonly retryWindowMs: number;
  private readonly retryRatio: number;

  constructor(private readonly options: ProviderBackpressureOptions = {}) {
    this.retryWindowMs = options.retryWindowMs ?? 60_000;
    this.retryRatio = options.maxActiveRetryRatio ?? 0.5;
    if (!Number.isFinite(this.retryWindowMs) || this.retryWindowMs <= 0
      || !Number.isFinite(this.retryRatio) || this.retryRatio <= 0 || this.retryRatio > 1) {
      throw new RangeError('Invalid retry window or ratio');
    }
    this.validate({ ...DEFAULTS, ...options.defaults });
    for (const limits of Object.values(options.providers ?? {})) {
      this.validate({ ...DEFAULTS, ...options.defaults, ...limits });
    }
  }

  private validate(limits: ProviderLimits): void {
    for (const key of ['maxConcurrent', 'maxQueueDepth', 'maxRetryBudgetPerMinute'] as const) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < (key === 'maxConcurrent' ? 1 : 0)) {
        throw new RangeError(`Invalid ${key}`);
      }
    }
    if (!Number.isFinite(limits.minCooldownMs) || limits.minCooldownMs < 0) {
      throw new RangeError('Invalid minCooldownMs');
    }
  }

  private state(providerId: string): State {
    let state = this.states.get(providerId);
    if (!state) {
      state = {
        limits: { ...DEFAULTS, ...this.options.defaults, ...this.options.providers?.[providerId] },
        inFlight: 0, activeRetries: 0, queue: [], cooldownUntilMs: 0, retries: [],
        totalAdmitted: 0, totalRejected: 0, totalRateLimited: 0,
      };
      this.states.set(providerId, state);
    }
    state.retries = state.retries.filter(time => time > Date.now() - this.retryWindowMs);
    return state;
  }

  acquire(providerId: string, options: {
    signal?: AbortSignal; timeoutMs?: number; priority?: number; isRetry?: boolean;
  } = {}): Promise<ProviderLease> {
    const state = this.state(providerId);
    const reject = (reason: string) => {
      state.totalRejected++;
      return Promise.reject<ProviderLease>(new Error(reason));
    };
    if (options.signal?.aborted) return reject('ACQUIRE_ABORTED');
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      return reject('INVALID_TIMEOUT');
    }
    if (options.priority !== undefined && !Number.isFinite(options.priority)) return reject('INVALID_PRIORITY');
    if (state.cooldownUntilMs - Date.now() > (options.timeoutMs ?? Infinity)) return reject('ACQUIRE_TIMEOUT');
    if (options.isRetry && state.activeRetries >= this.retryCap(state)) return reject('RETRY_STORM_CIRCUIT_OPEN');
    if (state.inFlight < state.limits.maxConcurrent && state.cooldownUntilMs <= Date.now() && !state.queue.length) {
      return Promise.resolve(this.admit(state, options.isRetry ?? false));
    }
    if (options.timeoutMs === 0) return reject('ACQUIRE_TIMEOUT');
    if (state.queue.length >= state.limits.maxQueueDepth) return reject('QUEUE_FULL');
    return new Promise((resolve, rejectPromise) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cancel = (reason: string) => {
        const index = state.queue.indexOf(waiter);
        if (index < 0) return;
        state.queue.splice(index, 1);
        waiter.cleanup();
        state.totalRejected++;
        rejectPromise(new Error(reason));
        this.drain(state);
      };
      const abort = () => cancel('ACQUIRE_ABORTED');
      const waiter: Waiter = {
        priority: options.priority ?? 0, isRetry: options.isRetry ?? false,
        deadline: Date.now() + (options.timeoutMs ?? Infinity), resolve, reject: rejectPromise,
        cleanup: () => { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); },
      };
      state.queue.push(waiter);
      state.queue.sort((a, b) => b.priority - a.priority);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeoutMs !== undefined) timeout = setTimeout(() => cancel('ACQUIRE_TIMEOUT'), options.timeoutMs);
      this.drain(state);
    });
  }

  private retryCap(state: State): number {
    return Math.max(1, Math.floor(state.limits.maxConcurrent * this.retryRatio));
  }

  private admit(state: State, isRetry: boolean): ProviderLease {
    state.inFlight++;
    state.totalAdmitted++;
    if (isRetry) state.activeRetries++;
    let released = false;
    return { release: (outcome = {}) => {
      if (released) return;
      released = true;
      state.inFlight--;
      if (isRetry) state.activeRetries--;
      // Retry outcomes from callers that do not mark acquire are still counted.
      if (outcome.isRetry && !isRetry) state.retries.push(Date.now());
      if (outcome.status === 429 || outcome.retryAfterMs !== undefined
        || outcome.rateLimitRemainingRequests === 0 || outcome.rateLimitRemainingTokens === 0) {
        state.totalRateLimited++;
        state.cooldownUntilMs = Math.max(state.cooldownUntilMs,
          Date.now() + Math.max(state.limits.minCooldownMs,
            Number.isFinite(outcome.retryAfterMs) ? Math.max(0, outcome.retryAfterMs!) : 0),
          Number.isFinite(outcome.resetAtMs) ? outcome.resetAtMs! : 0);
      }
      this.drain(state);
    } };
  }

  private drain(state: State): void {
    clearTimeout(state.timer);
    state.timer = undefined;
    const now = Date.now();
    for (const waiter of [...state.queue]) {
      if (waiter.deadline <= now || state.cooldownUntilMs > waiter.deadline) {
        state.queue.splice(state.queue.indexOf(waiter), 1);
        waiter.cleanup();
        state.totalRejected++;
        waiter.reject(new Error('ACQUIRE_TIMEOUT'));
      }
    }
    if (!state.queue.length) return;
    if (state.cooldownUntilMs > now) {
      state.timer = setTimeout(() => this.drain(state), Math.min(2_147_483_647, state.cooldownUntilMs - now));
      return;
    }
    while (state.inFlight < state.limits.maxConcurrent && state.queue.length) {
      const index = state.queue.findIndex(waiter => !waiter.isRetry || state.activeRetries < this.retryCap(state));
      if (index < 0) break;
      const waiter = state.queue.splice(index, 1)[0]!;
      waiter.cleanup();
      waiter.resolve(this.admit(state, waiter.isRetry));
    }
  }

  /** A successful call consumes one retry authorization; call once before each retry. */
  canRetry(providerId: string): { allowed: boolean; reason?: string; retryDelayMs: number } {
    const state = this.state(providerId);
    const cooldown = Math.max(0, state.cooldownUntilMs - Date.now());
    if (state.retries.length >= state.limits.maxRetryBudgetPerMinute || state.activeRetries >= this.retryCap(state)) {
      const budgetDelay = state.retries.length >= state.limits.maxRetryBudgetPerMinute
        ? (state.retries[0] ?? Date.now()) + this.retryWindowMs - Date.now() : 0;
      return { allowed: false, reason: 'RETRY_STORM_CIRCUIT_OPEN',
        retryDelayMs: Math.max(1, cooldown, budgetDelay, state.limits.minCooldownMs) };
    }
    if (cooldown > 0) return { allowed: false, reason: 'PROVIDER_COOLDOWN', retryDelayMs: cooldown };
    state.retries.push(Date.now());
    return { allowed: true, retryDelayMs: 0 };
  }

  computeBackoffWithJitter(attempt: number, baseDelayMs: number, maxDelayMs: number, retryAfterMs = 0): number {
    return computeBackoffWithJitter(attempt, baseDelayMs, maxDelayMs, retryAfterMs);
  }

  getProviderState(providerId: string): ProviderState {
    const state = this.state(providerId);
    return {
      inFlight: state.inFlight, queued: state.queue.length,
      cooldownRemainingMs: Math.max(0, state.cooldownUntilMs - Date.now()),
      retriesInWindow: state.retries.length, totalAdmitted: state.totalAdmitted,
      totalRejected: state.totalRejected, totalRateLimited: state.totalRateLimited,
    };
  }

  getAllStates(): Record<string, ProviderState> {
    return Object.fromEntries([...this.states.keys()].map(id => [id, this.getProviderState(id)]));
  }
}
