export const FAILURE_CLASSES = [
  'TRANSIENT_PROVIDER', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE',
  'MODEL_PROTOCOL', 'MODEL_CONTEXT_OVERFLOW', 'MODEL_UNAVAILABLE',
  'TOOL_VALIDATION_FAILED', 'TOOL_EXECUTION_FAILED', 'TOOL_TIMEOUT', 'TOOL_OUTCOME_UNKNOWN',
  'POLICY_DENIED', 'APPROVAL_REQUIRED', 'CODE_FAILURE', 'BUILD_FAILED', 'TEST_FAILED',
  'LINT_FAILED', 'TYPECHECK_FAILED', 'ARTIFACT_CONTRACT_FAILED', 'WORKSPACE_CONFLICT',
  'STALE_EDIT', 'RESOURCE_EXHAUSTED', 'MODEL_ADMISSION_DENIED', 'NON_RECOVERABLE', 'CANCELLED',
  // Provider account states. Neither is transient: retrying an auth failure cannot succeed,
  // and an exhausted quota only recovers at its reset, so both are excluded from retries.
  'AUTH_FAILED', 'QUOTA_EXHAUSTED',
] as const;

export type FailureClass = typeof FAILURE_CLASSES[number];

export class ExecutionFailure extends Error {
  constructor(readonly failureClass: FailureClass, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExecutionFailure';
  }
}

export function isFailureClass(value: unknown): value is FailureClass {
  return typeof value === 'string' && (FAILURE_CLASSES as readonly string[]).includes(value);
}

/** Prefer explicit controller facts; never infer compiler or policy success from prose. */
export function classifyFailure(error: unknown): FailureClass {
  if (typeof error !== 'object' || error === null) return 'NON_RECOVERABLE';
  const value = error as { failureClass?: unknown; code?: unknown; status?: unknown; name?: unknown; message?: unknown; cause?: { code?: unknown } };
  if (isFailureClass(value.failureClass)) return value.failureClass;
  if (isFailureClass(value.code)) return value.code;
  if (value.name === 'AbortError') return 'CANCELLED';
  if (value.name === 'TimeoutError') return 'TIMEOUT';
  if (value.status === 401 || value.status === 403) return 'AUTH_FAILED';
  if (value.status === 429) return 'RATE_LIMIT';
  if (typeof value.status === 'number' && value.status >= 500 && value.status < 600) return 'SERVER';
  const code = value.cause?.code ?? value.code;
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'TIMEOUT';
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(String(code))) return 'TRANSPORT';
  // Fetch transport errors are TypeErrors. Arbitrary TypeErrors (including bugs in
  // request serialization) are not transient and must not be retried.
  if (value.name === 'TypeError' && typeof value.message === 'string' &&
      /^(fetch failed|failed to fetch|networkerror when attempting to fetch resource\.?|load failed)$/i.test(value.message)) return 'TRANSPORT';
  return 'NON_RECOVERABLE';
}

export function isProviderRetryable(failureClass: FailureClass): boolean {
  return ['TRANSIENT_PROVIDER', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'].includes(failureClass);
}

/**
 * Parses an HTTP `Retry-After` value (delta-seconds or an HTTP date) into milliseconds.
 * Returns undefined when absent or unparseable; never negative.
 */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Math.round(Number(trimmed) * 1000));
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

// Quota/billing exhaustion as worded by providers. A 429 carrying one of these is not a
// transient rate limit: waiting a few seconds will not help, only the quota reset will.
const QUOTA_PATTERN = /insufficient_quota|quota (?:has been )?exceeded|exceeded your (?:current )?quota|usage limit|credit balance is too low|billing|out of credits|monthly limit|daily limit reached|RESOURCE_EXHAUSTED/i;
const CONTEXT_PATTERN = /context[_ ]length|context window|maximum context|too many tokens|prompt is too long|n_ctx/i;

/** Classifies a failed HTTP response from a model provider using its status and body. */
export function classifyHttpFailure(status: number, body = ''): FailureClass {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (QUOTA_PATTERN.test(body) && (status === 429 || status === 402 || status === 403 || status === 400)) return 'QUOTA_EXHAUSTED';
  if (status === 402) return 'QUOTA_EXHAUSTED';
  if (status === 429) return 'RATE_LIMIT';
  if ((status === 400 || status === 413) && CONTEXT_PATTERN.test(body)) return 'MODEL_CONTEXT_OVERFLOW';
  if (status === 404) return 'MODEL_UNAVAILABLE';
  if (status === 408) return 'TIMEOUT';
  // Same class classifyFailure() gives a 5xx, so a request's retry events and final error agree.
  if (status >= 500 && status < 600) return 'SERVER';
  return 'NON_RECOVERABLE';
}
