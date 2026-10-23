import { isFailureClass, isProviderRetryable, type FailureClass as CoreFailureClass } from '@wazir/shared';
import type { AcceptanceGateDecision, FailureClass, GoalStudioError, GoalStudioErrorCode } from '../contracts.js';

/** Result of classifying one failed attempt. Pure function of its inputs. */
export interface FailureClassification {
  failureClass: FailureClass;
  /** Finer-grained category from @wazir/shared, used for hints and hypotheses. */
  coreCategory: CoreFailureClass;
  /** Never retry or repair around this failure (policy, cancellation, explicit exhaustion). */
  terminal: boolean;
  /** Retrying the same action unchanged may succeed. */
  retryable: boolean;
  /** Acceptance criteria that did not PASS (sorted, deduplicated). */
  failedCriteria: string[];
  diagnosis: string;
  reasons: string[];
}

export interface ClassifyInput {
  error?: GoalStudioError;
  gate?: AcceptanceGateDecision;
}

const POLICY_CODES: ReadonlySet<GoalStudioErrorCode> = new Set(['POLICY_DENIED', 'FORBIDDEN', 'UNAUTHORIZED', 'APPROVAL_REQUIRED', 'BUDGET_EXCEEDED', 'CANCELLED']);
const POLICY_CORE: ReadonlySet<CoreFailureClass> = new Set(['POLICY_DENIED', 'APPROVAL_REQUIRED', 'MODEL_ADMISSION_DENIED', 'CANCELLED']);
const ENVIRONMENT_CORE: ReadonlySet<CoreFailureClass> = new Set(['MODEL_UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'WORKSPACE_CONFLICT', 'AUTH_FAILED', 'QUOTA_EXHAUSTED', 'TOOL_OUTCOME_UNKNOWN']);
/** Environment failures that cannot clear by waiting (an operator must act). */
const ENVIRONMENT_TERMINAL_CORE: ReadonlySet<CoreFailureClass> = new Set(['AUTH_FAILED', 'QUOTA_EXHAUSTED']);
const DETERMINISTIC_CORE: ReadonlySet<CoreFailureClass> = new Set([
  'CODE_FAILURE', 'BUILD_FAILED', 'TEST_FAILED', 'LINT_FAILED', 'TYPECHECK_FAILED', 'ARTIFACT_CONTRACT_FAILED',
  'TOOL_VALIDATION_FAILED', 'TOOL_EXECUTION_FAILED', 'STALE_EDIT', 'MODEL_PROTOCOL', 'MODEL_CONTEXT_OVERFLOW',
]);

/**
 * Category hints from execution output. Used only to pick a finer category for
 * hypotheses; prose never upgrades a failure to `policy` (never inferred from text)
 * and only unambiguous network/HTTP fragments upgrade to transient.
 */
const PROSE_CATEGORIES: Array<[RegExp, CoreFailureClass]> = [
  [/\b(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)\b/, 'TIMEOUT'],
  [/\b(ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|UND_ERR_SOCKET)\b/, 'TRANSPORT'],
  [/\b(429|too many requests|rate limit(ed)?)\b/i, 'RATE_LIMIT'],
  [/\b(502|503|504) (bad gateway|service unavailable|gateway timeout)\b/i, 'SERVER'],
  [/\berror TS\d{4}\b|\btype ?check(ing)? failed\b/i, 'TYPECHECK_FAILED'],
  [/\bbuild failed\b|\bcompilation failed\b|\bcannot find module\b/i, 'BUILD_FAILED'],
  [/\blint(ing)? failed\b|\beslint\b/i, 'LINT_FAILED'],
  [/\btests? failed\b|\bassertionerror\b|\bfailing tests?\b|\bexpected .{1,80} to (be|equal)\b/i, 'TEST_FAILED'],
  [/\bmissing artifact\b|\bartifact contract\b/i, 'ARTIFACT_CONTRACT_FAILED'],
  [/\bstale (edit|file)\b/i, 'STALE_EDIT'],
  [/\bcontext (length|window)\b|\btoo many tokens\b/i, 'MODEL_CONTEXT_OVERFLOW'],
];

function coreCategoryOf(error: GoalStudioError | undefined): { category?: CoreFailureClass; fromProse: boolean } {
  const detailsClass = error?.details?.failureClass;
  if (isFailureClass(detailsClass)) return { category: detailsClass, fromProse: false };
  const text = [error?.message, typeof error?.details?.stderr === 'string' ? error.details.stderr : undefined]
    .filter((part): part is string => typeof part === 'string').join('\n').slice(0, 20_000);
  for (const [pattern, category] of PROSE_CATEGORIES) if (pattern.test(text)) return { category, fromProse: true };
  return { fromProse: false };
}

function failedCriteriaOf(input: ClassifyInput): string[] {
  const criteria = new Set<string>();
  for (const row of input.gate?.perCriterion ?? []) {
    if (row && row.verdict !== 'PASS' && typeof row.criterion === 'string') criteria.add(row.criterion.trim());
  }
  const fromError = input.error?.details?.failedCriteria;
  if (Array.isArray(fromError)) for (const c of fromError) if (typeof c === 'string' && c.trim()) criteria.add(c.trim());
  return [...criteria].sort();
}

function result(failureClass: FailureClass, coreCategory: CoreFailureClass, flags: { terminal?: boolean; retryable?: boolean }, failedCriteria: string[], diagnosis: string, reasons: string[]): FailureClassification {
  return { failureClass, coreCategory, terminal: flags.terminal ?? false, retryable: flags.retryable ?? false, failedCriteria, diagnosis, reasons };
}

/**
 * Classifies a failed attempt from its GoalStudioError, acceptance-gate decision and
 * execution error details. Deterministic. Policy-like failures are always terminal,
 * regardless of the `retryable` flag on the error.
 */
export function classifyGoalFailure(input: ClassifyInput): FailureClassification {
  const { error, gate } = input;
  const failedCriteria = failedCriteriaOf(input);
  const code = error?.code;
  const { category, fromProse } = coreCategoryOf(error);
  const reasons: string[] = [];
  if (code) reasons.push(`error code ${code}${error?.retryable ? ' (retryable)' : ''}`);
  if (category) reasons.push(`category ${category}${fromProse ? ' (inferred from output)' : ''}`);
  if (gate) reasons.push(`gate decision ${gate.decision}`);
  const message = error?.message ? `: ${error.message.slice(0, 300)}` : '';

  // 1. Policy / control-plane denials: never retried or repaired around.
  if ((code && POLICY_CODES.has(code)) || (category && !fromProse && POLICY_CORE.has(category))) {
    const core: CoreFailureClass = category && POLICY_CORE.has(category) ? category
      : code === 'APPROVAL_REQUIRED' ? 'APPROVAL_REQUIRED' : code === 'CANCELLED' ? 'CANCELLED' : 'POLICY_DENIED';
    reasons.push('policy denial: never retried or repaired around');
    return result('policy', core, { terminal: true }, failedCriteria, `Policy or control-plane denial (${code ?? core})${message}`, reasons);
  }

  // 2. Explicit exhaustion from upstream.
  if (code === 'NO_PROGRESS' || code === 'RETRY_EXHAUSTED') {
    reasons.push(`${code} reported upstream`);
    return result('no_progress', category ?? 'NON_RECOVERABLE', { terminal: true }, failedCriteria, `Upstream reported ${code}${message}`, reasons);
  }
  if (category === 'NON_RECOVERABLE' && !fromProse) {
    reasons.push('execution reported NON_RECOVERABLE');
    return result('deterministic', 'NON_RECOVERABLE', { terminal: true }, failedCriteria, `Non-recoverable execution failure${message}`, reasons);
  }
  if (code === 'STALE_LEASE') {
    reasons.push('run lease lost: this holder must not continue the target');
    return result('environment', 'WORKSPACE_CONFLICT', { terminal: true }, failedCriteria, `Run lease lost${message}`, reasons);
  }

  // 3. Gate-only decisions.
  if (gate?.decision === 'blocked' && (!error || error.code === 'VERIFICATION_FAILED')) {
    return result('verification', 'ARTIFACT_CONTRACT_FAILED', { terminal: true }, failedCriteria, `Acceptance gate blocked the target: ${gate.reasons.join('; ').slice(0, 300)}`, reasons);
  }

  // 4. Transient.
  const transientCore = category !== undefined && isProviderRetryable(category);
  const retryableExecution = error?.retryable === true && (code === 'EXECUTION_FAILED' || code === 'INTERNAL')
    && !(category && (DETERMINISTIC_CORE.has(category) || ENVIRONMENT_CORE.has(category)));
  if (code === 'LEDGER_CONFLICT' || transientCore || retryableExecution) {
    const core: CoreFailureClass = transientCore ? category! : category === 'TOOL_TIMEOUT' ? 'TOOL_TIMEOUT' : 'TRANSIENT_PROVIDER';
    reasons.push('transient: the same action may succeed on retry');
    return result('transient', core, { retryable: true }, failedCriteria, `Transient failure (${core})${message}`, reasons);
  }
  if (category === 'TOOL_TIMEOUT') {
    reasons.push('tool timeout: retryable once the tool is responsive');
    return result('transient', 'TOOL_TIMEOUT', { retryable: true }, failedCriteria, `Tool timed out${message}`, reasons);
  }

  // 5. Environment.
  if (code === 'NO_ROUTE' || (category && ENVIRONMENT_CORE.has(category))) {
    const core: CoreFailureClass = category && ENVIRONMENT_CORE.has(category) ? category : 'MODEL_UNAVAILABLE';
    const terminal = ENVIRONMENT_TERMINAL_CORE.has(core);
    const retryable = !terminal && (error?.retryable ?? false);
    reasons.push(terminal ? 'environment: needs an operator, not a retry' : retryable ? 'environment: retry after backoff' : 'environment: not retryable');
    return result('environment', core, { terminal: terminal || !retryable, retryable }, failedCriteria, `Environment unavailable (${core})${message}`, reasons);
  }

  // 6. Verification failures (repairable).
  if (code === 'VERIFICATION_FAILED' || (!error && gate?.decision === 'repair')) {
    const core: CoreFailureClass = category && DETERMINISTIC_CORE.has(category) ? category : 'ARTIFACT_CONTRACT_FAILED';
    const which = failedCriteria.length ? `; failing criteria: ${failedCriteria.join(' | ').slice(0, 300)}` : '';
    return result('verification', core, {}, failedCriteria, `Independent verification failed${message}${which}`, reasons);
  }

  // 7. Deterministic execution failures (repairable).
  if (code === 'EXECUTION_FAILED' || code === 'VALIDATION' || (category && DETERMINISTIC_CORE.has(category))) {
    const core: CoreFailureClass = category && DETERMINISTIC_CORE.has(category) ? category : 'CODE_FAILURE';
    return result('deterministic', core, {}, failedCriteria, `Deterministic execution failure (${core})${message}`, reasons);
  }

  // 8. Unknown (repairable within the same caps).
  reasons.push('unclassified failure: treated as repairable within caps');
  return result('unknown', category ?? 'CODE_FAILURE', {}, failedCriteria, `Unclassified failure${code ? ` (${code})` : ''}${message}`, reasons);
}
