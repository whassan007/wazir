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

export interface RetryOptions {
  /** Maximum number of attempts, including the first. Default 4. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Default 250. */
  baseDelayMs?: number;
  /** Delay cap in ms, before jitter. Default 8000. */
  maxDelayMs?: number;
  /** Called before each sleep, with the attempt number (1-based) and the error that triggered it — durably record the pending retry (e.g. into the job log) so recovery survives a crash mid-backoff. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void | Promise<void>;
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
  if (error instanceof RetryableHttpError) return error.status === 429 || (error.status >= 500 && error.status < 600);
  if (error instanceof Error) {
    // Network-level failures: fetch throws a plain TypeError for DNS/connection
    // failures in undici/browsers; Node's `cause` sometimes carries the real
    // errno code (ECONNREFUSED, ECONNRESET, ETIMEDOUT) for a connection drop.
    const cause = (error as { cause?: { code?: string } }).cause;
    if (error.name === 'TypeError' || error.name === 'AbortError') return true;
    if (cause?.code && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(cause.code)) return true;
  }
  return false;
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
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 8000;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;
  for (let n = 1; n <= maxAttempts; n++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (n === maxAttempts || !isRetryable(error)) throw error;
      const delayMs = jitteredDelay(n, baseDelayMs, maxDelayMs);
      await options.onRetry?.(n, delayMs, error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Unreachable — the loop always returns or throws — but keeps TS satisfied.
  throw lastError;
}
