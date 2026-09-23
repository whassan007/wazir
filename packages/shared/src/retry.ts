/**
 * Exponential backoff with jitter for transient runtime-adapter failures
 * (connection drops, 5xx, 429). Runtime adapters previously failed
 * immediately on any of these — especially costly against LM Studio, which
 * legitimately takes seconds to lazily swap a model into VRAM and can 5xx or
 * refuse connections during that window.
 *
 * Scoped deliberately to the *connect* phase of a request, not an entire
 * streaming generation: once a streaming response has started yielding
 * tokens to a caller, retrying would either duplicate output already
 * consumed or silently drop it — there is no safe way to "retry" partway
 * through a stream without the caller's cooperation. `retryConnect` wraps
 * only the call that establishes the response (the fetch before any bytes
 * are read from its body); the caller is responsible for treating a
 * successful connect as a hard boundary past which this helper is no longer
 * involved.
 */

import { classifyFailure, isProviderRetryable, type FailureClass } from './failure.js';

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitter: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxRetries: 5, initialDelayMs: 500, maxDelayMs: 10_000, jitter: 0.10,
});

export function resolveRetryPolicy(options: Partial<RetryPolicy> = {}): RetryPolicy {
  const policy = { ...DEFAULT_RETRY_POLICY, ...options };
  if (!Number.isSafeInteger(policy.maxRetries) || policy.maxRetries < 0 ||
      !Number.isFinite(policy.initialDelayMs) || policy.initialDelayMs < 0 ||
      !Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.initialDelayMs ||
      !Number.isFinite(policy.jitter) || policy.jitter < 0 || policy.jitter > 1) {
    throw new RangeError('Invalid retry policy');
  }
  return policy;
}

export interface RetryDecision {
  retry: boolean;
  attempt: number;
  failureClass: FailureClass;
  delayMs: number;
  reason: 'transient_provider_failure' | 'failure_not_retryable' | 'retry_budget_exhausted';
}

/** attemptsMade includes the failed initial request. This policy never replays tools. */
export function providerRetryDecision(
  failureClass: FailureClass,
  attemptsMade: number,
  options: Partial<RetryPolicy> = {},
  random: () => number = Math.random,
): RetryDecision {
  const policy = resolveRetryPolicy(options);
  if (!Number.isSafeInteger(attemptsMade) || attemptsMade < 1) throw new RangeError('Invalid retry attempt');
  if (!isProviderRetryable(failureClass)) return { retry: false, attempt: attemptsMade, failureClass, delayMs: 0, reason: 'failure_not_retryable' };
  if (attemptsMade > policy.maxRetries) return { retry: false, attempt: attemptsMade, failureClass, delayMs: 0, reason: 'retry_budget_exhausted' };
  const exponential = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** Math.min(52, attemptsMade - 1));
  const delayMs = Math.min(policy.maxDelayMs, Math.max(0, Math.round(exponential * (1 + policy.jitter * (2 * random() - 1)))));
  return { retry: true, attempt: attemptsMade + 1, failureClass, delayMs, reason: 'transient_provider_failure' };
}

/** Cancellation interrupts backoff instead of waiting for the next provider attempt. */
export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOptions {
  policy?: Partial<RetryPolicy>;
  signal?: AbortSignal;
  /** Maximum number of attempts, including the first. Default 4. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Default 250. */
  baseDelayMs?: number;
  /** Delay cap in ms, before jitter. Default 8000. */
  maxDelayMs?: number;
  /** Called before each sleep, with the attempt number (1-based) and the error that triggered it — durably record the pending retry (e.g. into the job log) so recovery survives a crash mid-backoff. */
  onRetry?: (attempt: number, delayMs: number, error: unknown, decision: RetryDecision) => void | Promise<void>;
  /** Decides whether `error` is worth retrying. Default: RetryableHttpError classification below, or a thrown network error (TypeError from fetch, ECONNREFUSED, etc). */
  isRetryable?: (error: unknown) => boolean;
}

/** Thrown by a caller's `attempt` function to signal an HTTP response that should be retried, carrying its status for classification/logging. */
export class RetryableHttpError extends Error {
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message ?? `retryable HTTP ${status}`);
    this.name = 'RetryableHttpError';
    this.status = status;
  }
}

function defaultIsRetryable(error: unknown): boolean {
  return isProviderRetryable(classifyFailure(error));
}

/**
 * Exported separately from `retryConnect` for callers that can't use a plain
 * retry-a-promise wrapper — an async generator that needs to `yield` a
 * progress event between attempts (see the LM Studio/Ollama adapters' own
 * `generate()`) can't be expressed as a single `attempt()` callback.
 */
export function jitteredDelay(attempt: number, baseDelayMs = 250, maxDelayMs = 8000): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/** True for a response status worth retrying: 429 (rate limited) or any 5xx. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Retries `attempt()` with exponential backoff + jitter. `attempt` should
 * throw `RetryableHttpError` for a 5xx/429 response it doesn't want to
 * accept, or let a genuine network error propagate — both are classified by
 * `isRetryable` (or the default classifier) to decide whether to retry.
 */
export async function retryConnect<T>(attempt: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const policy = resolveRetryPolicy({
    maxRetries: options.maxAttempts === undefined ? 3 : options.maxAttempts - 1,
    initialDelayMs: options.baseDelayMs ?? 250,
    maxDelayMs: options.maxDelayMs ?? 8000,
    ...options.policy,
  });
  const maxAttempts = policy.maxRetries + 1;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;
  for (let n = 1; n <= maxAttempts; n++) {
    options.signal?.throwIfAborted();
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      // A custom predicate may narrow retry eligibility, but cannot override a
      // controller-classified policy/code/tool/cancellation failure.
      const decision = providerRetryDecision(classifyFailure(error), n, policy);
      if (!decision.retry || !isRetryable(error)) throw error;
      await options.onRetry?.(n, decision.delayMs, error, decision);
      await waitForRetry(decision.delayMs, options.signal);
    }
  }
  // Unreachable — the loop always returns or throws — but keeps TS satisfied.
  throw lastError;
}
