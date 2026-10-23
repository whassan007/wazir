/** Reference ModelRouter, GoalGovernance and RecoveryService. */
import type { KeyValueStore } from '@wazir/shared';
import {
  GOAL_STORE_KEYS,
  type GoalGovernance,
  type GoalRunLedger,
  type GoalStudioEvent,
  type GoalTarget,
  type GovernanceDecision,
  type ModelRouteDecision,
  type ModelRouter,
  type RecoveryDecision,
  type RecoveryService,
  type ResourceLimits,
  type TargetAttempt,
  type AcceptanceGateDecision,
  type GoalStudioError,
} from '../../../packages/goals/src/contracts.js';
import { pad, sha256Hex, systemClock, type Clock } from './util.js';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface FakeModel {
  modelId: string;
  runtimeId: string;
  computerId?: string;
  hosted: boolean;
  capabilities: string[];
  costUsd: number;
  /** Verified-ready (responded to a real probe). Unready models are never routed. */
  ready: boolean;
}

export class FakeModelRouter implements ModelRouter {
  private readonly clock: Clock;
  constructor(private readonly models: FakeModel[], opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  async route(input: { requiredCapabilities: string[]; remainingHostedBudgetUsd: number; localFirst: boolean; excludeModelIds?: string[] }): Promise<ModelRouteDecision | undefined> {
    const rejected: Array<{ modelId: string; reason: string }> = [];
    const candidates: FakeModel[] = [];
    for (const m of this.models) {
      if (input.excludeModelIds?.includes(m.modelId)) rejected.push({ modelId: m.modelId, reason: 'excluded' });
      else if (!m.ready) rejected.push({ modelId: m.modelId, reason: 'not verified ready' });
      else if (!input.requiredCapabilities.every((c) => m.capabilities.includes(c))) rejected.push({ modelId: m.modelId, reason: 'missing capability' });
      else if (m.hosted && !(input.remainingHostedBudgetUsd > 0 && m.costUsd <= input.remainingHostedBudgetUsd)) rejected.push({ modelId: m.modelId, reason: 'hosted budget' });
      else candidates.push(m);
    }
    candidates.sort((a, b) => (input.localFirst && a.hosted !== b.hosted ? (a.hosted ? 1 : -1) : a.costUsd - b.costUsd) || a.modelId.localeCompare(b.modelId));
    const pick = candidates[0];
    if (!pick) return undefined;
    for (const other of candidates.slice(1)) rejected.push({ modelId: other.modelId, reason: 'lower preference' });
    return {
      modelId: pick.modelId,
      runtimeId: pick.runtimeId,
      ...(pick.computerId ? { computerId: pick.computerId } : {}),
      hosted: pick.hosted,
      estimatedCostUsd: pick.hosted ? pick.costUsd : 0,
      reasons: [pick.hosted ? 'hosted within budget' : 'local model', `capabilities: ${input.requiredCapabilities.join(',') || 'none'}`],
      rejected,
      decidedAt: this.clock().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export type LimitsResolver = (run: GoalRunLedger) => ResourceLimits | undefined;

export function approvalScope(runId: string, targetId: string, attempt: number, action: string): string {
  return `approval:${runId}:${targetId}:${attempt}:${action}`;
}

export class FakeGoalGovernance implements GoalGovernance {
  private readonly granted = new Set<string>();
  private auditSeq = 0;
  readonly audited: GoalStudioEvent[] = [];
  constructor(private readonly store: KeyValueStore, private readonly limitsFor: LimitsResolver) {}

  /** Fake-only: records a human approval for exactly one scope. */
  grant(scope: string, principal: string): void {
    if (!principal.startsWith('user:')) throw new Error('only human principals can approve');
    this.granted.add(scope);
  }

  async preflight(input: { run: GoalRunLedger; target: GoalTarget; route?: ModelRouteDecision; principal: string }): Promise<GovernanceDecision> {
    if (!input.principal || input.principal.startsWith('model:')) return { effect: 'deny', reasons: ['the executing model is never a principal'] };
    const limits = this.limitsFor(input.run);
    if (!limits) return { effect: 'deny', reasons: ['resource limits unknown for run (fail closed)'] };
    if (input.route?.hosted) {
      const spend = this.authorizeSpend(input.run, input.route.estimatedCostUsd);
      if (spend.effect !== 'allow') return spend;
    }
    if (input.run.resource.tasksStarted >= limits.maxTasksPerRun) return { effect: 'deny', reasons: ['maxTasksPerRun reached'] };
    if (input.target.requiresApproval) {
      const attempt = Math.max(1, input.run.targets[input.target.id]?.attempts ?? 1);
      const scope = approvalScope(input.run.runId, input.target.id, attempt, 'execute');
      if (!this.granted.has(scope)) return { effect: 'ask', reasons: ['target requires human approval'], approvalScope: scope };
    }
    return { effect: 'allow', reasons: ['within limits and policy'] };
  }

  authorizeSpend(run: GoalRunLedger, amountUsd: number): GovernanceDecision {
    if (!Number.isFinite(amountUsd) || amountUsd < 0) return { effect: 'deny', reasons: ['invalid amount'] };
    const limits = this.limitsFor(run);
    if (!limits) return { effect: 'deny', reasons: ['resource limits unknown for run (fail closed)'] };
    if (amountUsd === 0) return { effect: 'allow', reasons: ['no spend'] };
    if (limits.hostedSpendUsd <= 0) return { effect: 'deny', reasons: ['hostedSpendUsd is 0: hosted inference denied'] };
    if (run.resource.hostedSpendUsd + amountUsd > limits.hostedSpendUsd) return { effect: 'deny', reasons: ['hosted spend ceiling would be exceeded'] };
    return { effect: 'allow', reasons: ['within hosted spend ceiling'] };
  }

  async audit(event: GoalStudioEvent): Promise<void> {
    this.auditSeq += 1;
    const key = GOAL_STORE_KEYS.audit(`${Date.now()}-${pad(this.auditSeq, 8)}`);
    this.audited.push(event);
    await this.store.put(key, event);
  }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

const POLICY_CODES = new Set(['POLICY_DENIED', 'FORBIDDEN', 'UNAUTHORIZED', 'BUDGET_EXCEEDED', 'APPROVAL_REQUIRED']);

/** Gate rejections are expressed as a VERIFICATION_FAILED error so they can be stored on the attempt. */
export function gateError(gate: AcceptanceGateDecision): GoalStudioError {
  const failing = gate.perCriterion.filter((c) => c.verdict !== 'PASS').map((c) => c.criterion).sort();
  return { code: 'VERIFICATION_FAILED', message: `failing criteria: ${failing.join(' | ')}`, retryable: false };
}

/** Deterministic fingerprint: same code + normalized message => same signature. */
export function failureSignature(error: GoalStudioError | undefined): string {
  const msg = (error?.message ?? '').replace(/\d+/g, '#').trim();
  return sha256Hex(JSON.stringify([error?.code ?? 'NONE', msg])).slice(0, 16);
}

export class FakeRecoveryService implements RecoveryService {
  constructor(private readonly limitsFor: LimitsResolver) {}

  async decide(input: { run: GoalRunLedger; target: GoalTarget; attempt: TargetAttempt; priorAttempts: TargetAttempt[]; gate?: AcceptanceGateDecision; error?: GoalStudioError }): Promise<RecoveryDecision> {
    const effectiveError = input.error ?? (input.gate ? gateError(input.gate) : undefined);
    const signature = failureSignature(effectiveError);
    const limits = this.limitsFor(input.run);
    const base = { failureSignature: signature };
    if (!limits) return { ...base, action: 'block', failureClass: 'unknown', diagnosis: 'limits unknown', reasons: ['fail closed'] };
    if (input.error && POLICY_CODES.has(input.error.code)) {
      return { ...base, action: 'block', failureClass: 'policy', diagnosis: input.error.message, reasons: ['policy failures are not retried'] };
    }
    const prior = input.priorAttempts.filter((a) => a.id !== input.attempt.id);
    const sameSig = prior.filter((a) => a.outcome === 'failed' && a.error && failureSignature(a.error) === signature).length;
    if (sameSig >= limits.maxSameActionNoProgress) {
      return { ...base, action: 'block', failureClass: 'no_progress', diagnosis: 'same failure repeated', reasons: [`signature ${signature} seen ${sameSig + 1} times`] };
    }
    const repairs = input.run.targets[input.target.id]?.repairs ?? 0;
    if (input.error?.retryable && !input.gate) {
      if (input.attempt.attempt > limits.maxRepairsPerTask + 1) return { ...base, action: 'block', failureClass: 'transient', diagnosis: 'retries exhausted', reasons: ['attempt cap'] };
      return { ...base, action: 'retry', failureClass: 'transient', diagnosis: input.error.message, reasons: ['retryable error'] };
    }
    if (repairs >= limits.maxRepairsPerTask) {
      return { ...base, action: 'block', failureClass: input.gate ? 'verification' : 'deterministic', diagnosis: 'repair budget exhausted', reasons: [`repairs ${repairs} >= ${limits.maxRepairsPerTask}`] };
    }
    const priorHypotheses = new Set(prior.map((a) => a.repairHypothesis).filter(Boolean));
    let n = priorHypotheses.size + 1;
    let hypothesis = `H${n}: address ${input.gate ? 'failing acceptance criteria' : (input.error?.code ?? 'failure')} for ${input.target.id} (${signature})`;
    while (priorHypotheses.has(hypothesis)) hypothesis = `H${++n}: alternate repair for ${input.target.id} (${signature})`;
    return { ...base, action: 'repair', failureClass: input.gate ? 'verification' : 'deterministic', diagnosis: input.error?.message ?? 'acceptance gate rejected attempt', hypothesis, reasons: ['repairable within budget'] };
  }
}
