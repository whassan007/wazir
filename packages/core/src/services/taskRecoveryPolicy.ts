import { classifyFailure, isFailureClass, type FailureClass } from '@wazir/shared';
import type { AgentErrorKind, TerminationReason } from '../types/agent.js';
import type { JobTaskOutcome } from '../types/job.js';

/**
 * Orchestrator-level recovery decisions for a failed task attempt.
 *
 * The provider layer already retries transient HTTP failures, and CodingAgent already
 * bounds its own repair cycles, protocol budget and model escalation. This policy sits
 * one level up — it decides whether the *whole task attempt* is worth running again —
 * and reuses the shared FailureClass taxonomy rather than inventing another one.
 *
 * Invariants:
 *  - every decision is bounded by maxRetries (no recursion, no unbounded loop);
 *  - budget, policy, approval, auth, quota and cancellation stops are never retried,
 *    because a fresh attempt would silently reset the boundary that stopped it;
 *  - an attempt that fails with the same signature as the previous one is treated as
 *    no progress and stops early instead of burning the remaining retries;
 *  - only transient infrastructure failures wait (exponential backoff with jitter).
 */

export type RecoveryCategory =
  | 'transient_infrastructure'
  | 'model_protocol'
  | 'code_or_test'
  | 'tool_or_policy'
  | 'resource_budget'
  | 'nonrecoverable'
  | 'cancelled'
  /** No structured classification and nothing recognisable in the error text. Retried
   *  within maxRetries exactly as before this policy existed, to stay compatible with
   *  executors that do not classify their failures. */
  | 'unclassified';

export type RecoveryStrategy =
  | 'retry_with_backoff'
  | 'retry'
  | 'stop';

export interface TaskFailureClassification {
  category: RecoveryCategory;
  failureClass?: FailureClass;
  terminationReason?: TerminationReason;
  /** Stable identity of this failure, used for no-progress detection and the feedback log. */
  signature: string;
}

export interface TaskRecoveryDecision extends TaskFailureClassification {
  strategy: RecoveryStrategy;
  retry: boolean;
  delayMs: number;
  /** Machine-readable reason for the decision. */
  reason:
    | 'retryable'
    | 'retry_budget_exhausted'
    | 'not_retryable'
    | 'no_progress';
  attempt: number;
  maxRetries: number;
}

export interface TaskRecoveryPolicyOptions {
  /** Base backoff for transient infrastructure failures. Default 500ms. */
  backoffBaseMs?: number;
  /** Backoff cap. Default 30s. */
  backoffMaxMs?: number;
  /** Identical consecutive failure signatures tolerated before stopping. Default 2. */
  maxIdenticalFailures?: number;
  random?: () => number;
}

const BUDGET_STOPS = new Set<TerminationReason>(['MAX_TOKENS', 'MAX_WALL_CLOCK', 'RESOURCE_EXHAUSTED']);
const PROTOCOL_STOPS = new Set<TerminationReason>([
  'MODEL_PROTOCOL_BUDGET_EXHAUSTED', 'MAX_TURNS', 'MAX_MODEL_CALLS', 'MAX_TOOL_CALLS', 'NO_PROGRESS', 'REPEATED_ACTION',
]);
const CODE_STOPS = new Set<TerminationReason>(['VERIFICATION_FAILED', 'MAX_REPAIRS']);

const CATEGORY_BY_CLASS: Record<FailureClass, RecoveryCategory> = {
  TRANSIENT_PROVIDER: 'transient_infrastructure',
  RATE_LIMIT: 'transient_infrastructure',
  SERVER: 'transient_infrastructure',
  TIMEOUT: 'transient_infrastructure',
  TRANSPORT: 'transient_infrastructure',
  EMPTY_RESPONSE: 'transient_infrastructure',
  MODEL_PROTOCOL: 'model_protocol',
  MODEL_CONTEXT_OVERFLOW: 'model_protocol',
  MODEL_UNAVAILABLE: 'transient_infrastructure',
  TOOL_VALIDATION_FAILED: 'model_protocol',
  TOOL_EXECUTION_FAILED: 'code_or_test',
  TOOL_TIMEOUT: 'transient_infrastructure',
  // A dispatched mutation whose effect is unknown must be reconciled, not re-run.
  TOOL_OUTCOME_UNKNOWN: 'nonrecoverable',
  POLICY_DENIED: 'tool_or_policy',
  APPROVAL_REQUIRED: 'tool_or_policy',
  CODE_FAILURE: 'code_or_test',
  BUILD_FAILED: 'code_or_test',
  TEST_FAILED: 'code_or_test',
  LINT_FAILED: 'code_or_test',
  TYPECHECK_FAILED: 'code_or_test',
  ARTIFACT_CONTRACT_FAILED: 'code_or_test',
  WORKSPACE_CONFLICT: 'code_or_test',
  STALE_EDIT: 'code_or_test',
  RESOURCE_EXHAUSTED: 'resource_budget',
  MODEL_ADMISSION_DENIED: 'resource_budget',
  NON_RECOVERABLE: 'nonrecoverable',
  CANCELLED: 'cancelled',
  AUTH_FAILED: 'nonrecoverable',
  QUOTA_EXHAUSTED: 'resource_budget',
};

const RETRYABLE: ReadonlySet<RecoveryCategory> = new Set([
  'transient_infrastructure', 'model_protocol', 'code_or_test', 'unclassified',
]);

const CATEGORY_BY_KIND: Partial<Record<AgentErrorKind, RecoveryCategory>> = {
  protocol: 'model_protocol',
  verification: 'code_or_test',
  policy: 'tool_or_policy',
  cancelled: 'cancelled',
  infrastructure: 'transient_infrastructure',
};

// Explicit FailureClass / TerminationReason tokens that executors already embed in error
// text (e.g. "TOOL_OUTCOME_UNKNOWN: ...", "QUOTA_EXHAUSTED"). Word-bounded, upper-case only,
// so ordinary prose never matches.
const TOKEN_PATTERN = /\b([A-Z][A-Z_]{4,})\b/g;

function tokenFromText(text: string | undefined): { failureClass?: FailureClass; terminationReason?: TerminationReason } {
  if (!text) return {};
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[1];
    if (isFailureClass(token)) return { failureClass: token };
    if (BUDGET_STOPS.has(token as TerminationReason) || PROTOCOL_STOPS.has(token as TerminationReason)
      || CODE_STOPS.has(token as TerminationReason) || token === 'POLICY_DENIED') {
      return { terminationReason: token as TerminationReason };
    }
  }
  return {};
}

function legacyPolicyDenial(outcome: Pick<JobTaskOutcome, 'error' | 'reasons'>): boolean {
  return Boolean(
    outcome.error?.toLowerCase().includes('policy') ||
    outcome.error?.toLowerCase().includes('denied') ||
    outcome.reasons?.some((r) => r.toLowerCase().includes('policy') || r.toLowerCase().includes('deny')),
  );
}

/** Normalised so retries of the same defect hash identically (ids, numbers, paths stripped). */
export function failureSignature(category: RecoveryCategory, detail: string | undefined): string {
  const normalised = (detail ?? '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/(?:\/[\w.@-]+)+/g, '<path>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return `${category}:${normalised}`;
}

function classificationFor(category: RecoveryCategory, detail: string | undefined,
  extra: { failureClass?: FailureClass; terminationReason?: TerminationReason }): TaskFailureClassification {
  return { category, ...extra, signature: failureSignature(category, detail) };
}

function categoryFor(failureClass?: FailureClass, terminationReason?: TerminationReason): RecoveryCategory | undefined {
  if (terminationReason) {
    if (BUDGET_STOPS.has(terminationReason)) return 'resource_budget';
    if (terminationReason === 'POLICY_DENIED') return 'tool_or_policy';
    if (terminationReason === 'CANCELLED') return 'cancelled';
    if (PROTOCOL_STOPS.has(terminationReason)) return 'model_protocol';
    if (CODE_STOPS.has(terminationReason)) return 'code_or_test';
  }
  return failureClass ? CATEGORY_BY_CLASS[failureClass] : undefined;
}

/** Classifies a failed executor outcome. Structured fields win over text. */
export function classifyTaskOutcome(outcome: JobTaskOutcome): TaskFailureClassification {
  const detail = outcome.error ?? outcome.reasons?.join('; ');
  const fromText = tokenFromText(outcome.error);
  const failureClass = outcome.failureClass ?? fromText.failureClass;
  const terminationReason = outcome.terminationReason ?? fromText.terminationReason;
  // Budget/policy/cancel stops are the most specific and must not be masked by a coarser
  // errorKind such as 'other' or 'protocol'.
  const specific = categoryFor(failureClass, terminationReason);
  if (specific && !RETRYABLE.has(specific)) return classificationFor(specific, detail, { failureClass, terminationReason });
  const byKind = outcome.errorKind ? CATEGORY_BY_KIND[outcome.errorKind] : undefined;
  if (byKind) return classificationFor(byKind, detail, { failureClass, terminationReason });
  if (specific) return classificationFor(specific, detail, { failureClass, terminationReason });
  if (legacyPolicyDenial(outcome)) return classificationFor('tool_or_policy', detail, { failureClass: 'POLICY_DENIED' });
  return classificationFor('unclassified', detail, {});
}

/** Classifies an exception thrown by an executor. */
export function classifyTaskError(error: unknown): TaskFailureClassification {
  const message = error instanceof Error ? error.message : String(error);
  const structured = typeof error === 'object' && error !== null
    && ('failureClass' in error || 'code' in error || 'status' in error || (error as Error).name === 'AbortError' || (error as Error).name === 'TimeoutError');
  const failureClass = structured ? classifyFailure(error) : tokenFromText(message).failureClass;
  // classifyFailure's catch-all NON_RECOVERABLE for an unrecognised `code` is not an
  // explicit claim; keep the legacy bounded retry for those.
  const explicitClass = failureClass === 'NON_RECOVERABLE'
    && !(typeof error === 'object' && error !== null && (error as { failureClass?: unknown }).failureClass === 'NON_RECOVERABLE')
    && !message.includes('NON_RECOVERABLE')
    ? undefined : failureClass;
  const terminationReason = tokenFromText(message).terminationReason;
  const category = categoryFor(explicitClass, terminationReason)
    ?? (message.toLowerCase().includes('policy') || message.toLowerCase().includes('denied') ? 'tool_or_policy' : 'unclassified');
  return classificationFor(category, message, { failureClass: explicitClass, terminationReason });
}

export class TaskRecoveryPolicy {
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxIdenticalFailures: number;
  private readonly random: () => number;

  constructor(options: TaskRecoveryPolicyOptions = {}) {
    this.backoffBaseMs = Math.max(0, options.backoffBaseMs ?? 500);
    this.backoffMaxMs = Math.max(this.backoffBaseMs, options.backoffMaxMs ?? 30_000);
    this.maxIdenticalFailures = Math.max(1, options.maxIdenticalFailures ?? 2);
    this.random = options.random ?? Math.random;
  }

  /**
   * @param retriesUsed retries already consumed by this task (0 on first failure)
   * @param previousSignatures signatures of this task's earlier failed attempts, oldest first
   */
  decide(classification: TaskFailureClassification, retriesUsed: number, maxRetries: number,
    previousSignatures: readonly string[] = []): TaskRecoveryDecision {
    const base = { ...classification, attempt: retriesUsed + 1, maxRetries };
    if (!RETRYABLE.has(classification.category)) {
      return { ...base, strategy: 'stop', retry: false, delayMs: 0, reason: 'not_retryable' };
    }
    if (retriesUsed >= maxRetries) {
      return { ...base, strategy: 'stop', retry: false, delayMs: 0, reason: 'retry_budget_exhausted' };
    }
    // Unclassified failures keep the old behaviour; their text is too unreliable to compare.
    if (classification.category !== 'unclassified' && classification.category !== 'transient_infrastructure') {
      let identical = 1;
      for (let i = previousSignatures.length - 1; i >= 0 && previousSignatures[i] === classification.signature; i--) identical++;
      if (identical > this.maxIdenticalFailures) {
        return { ...base, strategy: 'stop', retry: false, delayMs: 0, reason: 'no_progress' };
      }
    }
    if (classification.category === 'transient_infrastructure') {
      const exp = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** retriesUsed);
      const delayMs = Math.round(exp / 2 + this.random() * (exp / 2));
      return { ...base, strategy: 'retry_with_backoff', retry: true, delayMs, reason: 'retryable' };
    }
    return { ...base, strategy: 'retry', retry: true, delayMs: 0, reason: 'retryable' };
  }
}
