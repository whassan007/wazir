import {
  GOAL_STORE_KEYS,
  GoalStudioFailure,
  type AcceptanceGateDecision,
  type GoalGraphRevisionRecord,
  type GoalRunLedger,
  type GoalStudioDeps,
  type GoalStudioError,
  type GoalTarget,
  type RecoveryDecision,
  type RecoveryService,
  type ResourceLimits,
  type TargetAttempt,
} from '../contracts.js';
import { classifyGoalFailure, type FailureClassification } from './classify.js';
import { computeFailureSignature } from './signature.js';
import {
  buildFailureIntelligence,
  createRuleBasedHypothesisGenerator,
  diagnoseHistory,
  isDuplicateHypothesis,
  isUnsafeHypothesis,
  sanitizeHypothesis,
  type RepairHypothesisGenerator,
  type RepairHypothesisRequest,
} from './hypothesis.js';

export interface RecoveryLimits {
  /** Repairs (new hypotheses) allowed per target before it is blocked. */
  maxRepairsPerTask: number;
  /** A non-transient failure signature observed this many times blocks the target as no_progress. */
  maxSameActionNoProgress: number;
  /** Consecutive transient retries allowed before the target is blocked. */
  maxTransientRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

/** Defaults match the Nobel fixture constitution (max_repairs_per_task 3, max_same_action_no_progress 2). */
export const DEFAULT_RECOVERY_LIMITS: Readonly<RecoveryLimits> = Object.freeze({
  maxRepairsPerTask: 3,
  maxSameActionNoProgress: 2,
  maxTransientRetries: 2,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
});

/** Absolute ceilings no configuration can exceed. Guarantees every path terminates. */
export const RECOVERY_HARD_CAPS = Object.freeze({
  maxRepairsPerTask: 10,
  maxSameActionNoProgress: 10,
  maxTransientRetries: 5,
  maxAttemptsPerTarget: 30,
  backoffMaxMs: 15 * 60_000,
});

export type RecoveryLimitSource = Partial<RecoveryLimits> & Partial<Pick<ResourceLimits, 'maxRepairsPerTask' | 'maxSameActionNoProgress'>>;

export interface RecoveryServiceDeps extends GoalStudioDeps {
  /** Optional proposal source tried before the deterministic rule-based generator. */
  hypothesisGenerator?: RepairHypothesisGenerator;
  /** Operator defaults; overridden by the run's pinned graph constitution. */
  limits?: Partial<RecoveryLimits>;
  /**
   * Resolves the run's limits (highest precedence). When absent the service reads the
   * pinned graph revision `GOAL_STORE_KEYS.graphRevision(run.graphId, run.graphRevision)`
   * from `store` (read-only) and uses its constitution's resource limits.
   */
  resolveLimits?: (run: GoalRunLedger) => RecoveryLimitSource | undefined | Promise<RecoveryLimitSource | undefined>;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Merges limit sources (later wins) and clamps everything to the hard caps. */
export function resolveRecoveryLimits(...sources: Array<RecoveryLimitSource | undefined>): RecoveryLimits {
  const merged: Partial<RecoveryLimits> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) if (typeof value === 'number') (merged as Record<string, number>)[key] = value;
  }
  const d = DEFAULT_RECOVERY_LIMITS;
  const backoffMaxMs = clampInt(merged.backoffMaxMs, d.backoffMaxMs, 0, RECOVERY_HARD_CAPS.backoffMaxMs);
  return {
    maxRepairsPerTask: clampInt(merged.maxRepairsPerTask, d.maxRepairsPerTask, 0, RECOVERY_HARD_CAPS.maxRepairsPerTask),
    // A first failure is never "no progress", so the effective minimum is 2 observations.
    maxSameActionNoProgress: clampInt(merged.maxSameActionNoProgress, d.maxSameActionNoProgress, 2, RECOVERY_HARD_CAPS.maxSameActionNoProgress),
    maxTransientRetries: clampInt(merged.maxTransientRetries, d.maxTransientRetries, 0, RECOVERY_HARD_CAPS.maxTransientRetries),
    backoffBaseMs: clampInt(merged.backoffBaseMs, d.backoffBaseMs, 0, backoffMaxMs),
    backoffMaxMs,
  };
}

/** Total failed attempts a target may accumulate under `limits` (and never above the hard cap). */
export function maxAttemptsFor(limits: RecoveryLimits): number {
  return Math.min(RECOVERY_HARD_CAPS.maxAttemptsPerTarget, (limits.maxRepairsPerTask + 1) * (limits.maxTransientRetries + 1));
}

/** Exponential backoff hint for the n-th consecutive transient retry (1-based). */
export function backoffMs(retryNumber: number, limits: RecoveryLimits, retryAfterMs?: number): number {
  const exp = limits.backoffBaseMs * 2 ** Math.max(0, Math.min(retryNumber - 1, 20));
  const hinted = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
  return Math.min(limits.backoffMaxMs, Math.max(exp, hinted));
}

interface ObservedFailure {
  attempt: TargetAttempt;
  classification: FailureClassification;
  signature: string;
}

function observe(targetId: string, attempt: TargetAttempt, error?: GoalStudioError, gate?: AcceptanceGateDecision): ObservedFailure {
  const classification = classifyGoalFailure({ error, gate });
  return { attempt, classification, signature: computeFailureSignature(targetId, classification, error) };
}

function isFailedAttempt(attempt: TargetAttempt): boolean {
  return attempt.outcome === 'failed' || attempt.outcome === 'blocked' || (attempt.error !== undefined && attempt.outcome !== 'succeeded');
}

function uniqueHypotheses(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const clean = sanitizeHypothesis(value);
    if (clean && !out.some((prior) => isDuplicateHypothesis(clean, prior))) out.push(clean);
  }
  return out;
}

/** GoalStudioError to record on an attempt that failed at the acceptance gate, so later decisions see the same signature. */
export function attemptErrorFromGate(gate: AcceptanceGateDecision): GoalStudioError {
  const failedCriteria = [...new Set(gate.perCriterion.filter((row) => row.verdict !== 'PASS').map((row) => row.criterion.trim()))].sort();
  return {
    code: 'VERIFICATION_FAILED',
    message: `Acceptance gate decided ${gate.decision}`,
    retryable: false,
    details: { failedCriteria, gateReasons: gate.reasons.slice(0, 10) },
  };
}

/** Blocker text for the ledger entry of a blocked target. */
export function recoveryBlocker(decision: RecoveryDecision): string {
  return `recovery:${decision.failureClass}:${decision.failureSignature} ${decision.diagnosis}`.slice(0, 500);
}

/** Error to record on the attempt when recovery blocks the target. */
export function recoveryBlockError(decision: RecoveryDecision): GoalStudioError {
  const code = decision.failureClass === 'policy' ? 'POLICY_DENIED' : decision.failureClass === 'no_progress' ? 'NO_PROGRESS' : 'RETRY_EXHAUSTED';
  return { code, message: decision.diagnosis.slice(0, 500), retryable: false, details: { failureSignature: decision.failureSignature, reasons: decision.reasons } };
}

/** Payload for the `recovery.decided` GoalStudioEvent. */
export function recoveryEventData(decision: RecoveryDecision): Record<string, unknown> {
  return { action: decision.action, failureClass: decision.failureClass, failureSignature: decision.failureSignature, diagnosis: decision.diagnosis, hypothesis: decision.hypothesis, reasons: decision.reasons };
}

async function limitsFromStore(deps: Partial<RecoveryServiceDeps>, run: GoalRunLedger): Promise<RecoveryLimitSource | undefined> {
  if (!deps.store) return undefined;
  try {
    const record = await deps.store.get<GoalGraphRevisionRecord>(GOAL_STORE_KEYS.graphRevision(run.graphId, run.graphRevision));
    const limits = record?.definition?.constitution?.resourceLimits;
    // Only trust the pinned revision the run was created from.
    if (!limits || (record.digest && run.graphDigest && record.digest !== run.graphDigest)) return undefined;
    return { maxRepairsPerTask: limits.maxRepairsPerTask, maxSameActionNoProgress: limits.maxSameActionNoProgress };
  } catch {
    return undefined;
  }
}

export function createRecoveryService(deps: Partial<RecoveryServiceDeps> = {}): RecoveryService {
  const fallbackGenerator = createRuleBasedHypothesisGenerator();

  async function proposeHypothesis(request: RepairHypothesisRequest, reasons: string[]): Promise<string | undefined> {
    const generators: Array<{ generator: RepairHypothesisGenerator; trusted: boolean }> = [];
    if (deps.hypothesisGenerator) generators.push({ generator: deps.hypothesisGenerator, trusted: false });
    generators.push({ generator: fallbackGenerator, trusted: true });
    let rejected = 0;
    for (const { generator, trusted } of generators) {
      let candidates: unknown[];
      try {
        const proposed = await generator.propose(request);
        candidates = Array.isArray(proposed) ? proposed.slice(0, 32) : [];
      } catch (error) {
        reasons.push(`hypothesis generator ${generator.id} failed (${error instanceof Error ? error.message.slice(0, 120) : 'error'}); falling back`);
        continue;
      }
      for (const raw of candidates) {
        const candidate = sanitizeHypothesis(raw);
        if (!candidate) continue;
        if (!trusted && isUnsafeHypothesis(candidate)) {
          reasons.push(`rejected unsafe proposal from ${generator.id}`);
          continue;
        }
        if (request.priorHypotheses.some((prior) => isDuplicateHypothesis(candidate, prior))) {
          rejected += 1;
          continue;
        }
        if (rejected > 0) reasons.push(`rejected ${rejected} non-novel hypothesis candidate(s)`);
        reasons.push(`hypothesis from ${generator.id}`);
        return candidate;
      }
    }
    if (rejected > 0) reasons.push(`rejected ${rejected} non-novel hypothesis candidate(s)`);
    return undefined;
  }

  return {
    async decide(input) {
      const { run, target, attempt, gate } = input;
      if (!run || !target || !attempt) throw new GoalStudioFailure('VALIDATION', 'recovery.decide requires run, target and attempt');
      if (attempt.targetId !== target.id) throw new GoalStudioFailure('VALIDATION', `attempt ${attempt.id} belongs to ${attempt.targetId}, not ${target.id}`);
      const explicitError = input.error ?? attempt.error;
      if (!explicitError && (!gate || gate.decision === 'completed' || gate.decision === 'needs_approval' || gate.decision === 'awaiting_external')) {
        throw new GoalStudioFailure('VALIDATION', `recovery.decide called without a failure (gate decision: ${gate?.decision ?? 'none'}); route the target by its gate decision instead`, { details: { targetId: target.id } });
      }

      // Gate-only failures are normalized to the same error shape the controller records on
      // the attempt (attemptErrorFromGate), so their signatures match on later decisions.
      const error = explicitError ?? attemptErrorFromGate(gate!);
      const limits = resolveRecoveryLimits(deps.limits, await limitsFromStore(deps, run), deps.resolveLimits ? await deps.resolveLimits(run) : undefined);
      const prior: ObservedFailure[] = (input.priorAttempts ?? [])
        .filter((a) => a && a.targetId === target.id && a.id !== attempt.id && isFailedAttempt(a))
        .sort((a, b) => a.attempt - b.attempt || a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
        .map((a) => observe(target.id, a, a.error));
      const current = observe(target.id, attempt, error, gate);
      const { classification, signature } = current;
      const reasons = [...classification.reasons];
      const decision = (action: RecoveryDecision['action'], extra: { hypothesis?: string; failureClass?: RecoveryDecision['failureClass']; diagnosis?: string } = {}): RecoveryDecision => ({
        action,
        failureClass: extra.failureClass ?? classification.failureClass,
        diagnosis: extra.diagnosis ?? classification.diagnosis,
        ...(extra.hypothesis ? { hypothesis: extra.hypothesis } : {}),
        failureSignature: signature,
        reasons,
      });

      // 1. Never retry or repair around a policy denial or an explicit terminal failure.
      if (classification.terminal) {
        reasons.push('blocked: terminal failure class');
        return decision('block');
      }

      // 2. Absolute attempt cap (belt and braces: no path can loop forever).
      const failedSoFar = prior.length + 1;
      const attemptCap = maxAttemptsFor(limits);
      const ledgerAttempts = run.targets?.[target.id]?.attempts ?? 0;
      if (failedSoFar >= attemptCap || ledgerAttempts >= attemptCap) {
        reasons.push(`blocked: attempt cap ${attemptCap} reached (failed attempts ${failedSoFar}, ledger attempts ${ledgerAttempts})`);
        return decision('block', { diagnosis: `Attempt cap reached: ${classification.diagnosis}` });
      }

      // 3. Transient / retryable environment failures: bounded retry with backoff.
      if (classification.retryable) {
        let streak = 1;
        for (let i = prior.length - 1; i >= 0 && prior[i].classification.retryable; i -= 1) streak += 1;
        if (streak > limits.maxTransientRetries) {
          reasons.push(`blocked: ${streak - 1} consecutive transient retries exhausted (limit ${limits.maxTransientRetries})`);
          return decision('block', { diagnosis: `Transient retries exhausted: ${classification.diagnosis}` });
        }
        const retryAfter = error?.details?.retryAfterMs;
        const wait = backoffMs(streak, limits, typeof retryAfter === 'number' ? retryAfter : undefined);
        reasons.push(`retry ${streak}/${limits.maxTransientRetries}`, `backoff_ms=${wait}`);
        return decision('retry');
      }

      // 4. No-progress: the same non-transient failure keeps recurring.
      const occurrences = 1 + prior.filter((p) => !p.classification.retryable && p.signature === signature).length;
      if (occurrences >= limits.maxSameActionNoProgress) {
        reasons.push(`blocked: failure signature observed ${occurrences} times with no progress (limit ${limits.maxSameActionNoProgress})`);
        return decision('block', { failureClass: 'no_progress', diagnosis: `No progress: ${classification.diagnosis}` });
      }

      // 5. Repair budget.
      const priorHypotheses = uniqueHypotheses([...prior.map((p) => p.attempt.repairHypothesis), attempt.repairHypothesis]);
      const repairsUsed = Math.max(run.targets?.[target.id]?.repairs ?? 0, priorHypotheses.length);
      if (repairsUsed >= limits.maxRepairsPerTask) {
        reasons.push(`blocked: repair budget exhausted (${repairsUsed}/${limits.maxRepairsPerTask})`);
        return decision('block', { diagnosis: `Repair budget exhausted: ${classification.diagnosis}` });
      }

      // 6. Novel repair hypothesis.
      const history = [...prior, current].filter((o) => !o.classification.retryable);
      const intelligence = buildFailureIntelligence({
        history: history.map((o) => ({ attempt: o.attempt, coreCategory: o.classification.coreCategory, signature: o.signature, isRetryable: o.classification.retryable, phase: o.classification.failureClass === 'verification' ? 'verification' : 'execution' })),
      });
      const evidence = classification.failedCriteria.map((c) => `failing: ${c}`);
      const { hints, repairContext } = diagnoseHistory(intelligence!, evidence);
      const hypothesis = await proposeHypothesis({
        run, target, attempt,
        failureClass: classification.failureClass,
        coreCategory: classification.coreCategory,
        diagnosis: classification.diagnosis,
        failureSignature: signature,
        failedCriteria: classification.failedCriteria,
        priorHypotheses,
        repairNumber: repairsUsed + 1,
        hints,
        repairContext,
      }, reasons);
      if (!hypothesis) {
        reasons.push('blocked: no novel repair hypothesis');
        return decision('block', { diagnosis: `No novel repair hypothesis: ${classification.diagnosis}` });
      }
      reasons.push(`repair ${repairsUsed + 1}/${limits.maxRepairsPerTask}`, ...hints.slice(0, 3).map((h) => `hint: ${h}`));
      return decision('repair', { hypothesis });
    },
  };
}
