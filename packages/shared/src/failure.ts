export const FAILURE_CLASSES = [
  'TRANSIENT_PROVIDER', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE',
  'MODEL_PROTOCOL', 'MODEL_CONTEXT_OVERFLOW', 'MODEL_UNAVAILABLE',
  'TOOL_VALIDATION_FAILED', 'TOOL_EXECUTION_FAILED', 'TOOL_TIMEOUT', 'TOOL_OUTCOME_UNKNOWN',
  'POLICY_DENIED', 'APPROVAL_REQUIRED', 'CODE_FAILURE', 'BUILD_FAILED', 'TEST_FAILED',
  'LINT_FAILED', 'TYPECHECK_FAILED', 'ARTIFACT_CONTRACT_FAILED', 'WORKSPACE_CONFLICT',
  'STALE_EDIT', 'RESOURCE_EXHAUSTED', 'MODEL_ADMISSION_DENIED', 'NON_RECOVERABLE', 'CANCELLED',
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
