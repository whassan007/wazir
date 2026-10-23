import type { Task } from '../types/task.js';
import type { ModelCapabilityCategory } from '../types/modelIntelligence.js';
import { classifyComplexity } from '../services/complexity.js';
import { costUsd, pricingFor } from './accounts.js';
import type { TokenBudgetManager } from './budgetManager.js';
import { estimateOutputTokens } from './estimator.js';
import type { BudgetMode, PolicyMode, RoutingWeights, WorkloadClass } from './types.js';

/**
 * Maps a task to a workload class using Wazir's existing signals (task type, priority,
 * capability category, prompt complexity). Mirrors the routing table: routine coding, tests,
 * debugging and summarization stay local; architecture and difficult repair are "complex";
 * high-priority review is "critical-review".
 */
export function classifyWorkload(task: Pick<Task, 'type' | 'priority' | 'input'> & { description?: string }, primaryCategory?: ModelCapabilityCategory): WorkloadClass {
  const text = `${task.description ?? ''} ${typeof task.input === 'string' ? task.input : ''}`;
  const complexity = classifyComplexity(text);
  if (task.type === 'review' && (task.priority === 'high' || task.priority === 'critical')) return 'critical-review';
  if (task.type === 'architecture' || primaryCategory === 'architecture_reasoning') return 'complex';
  if (task.type === 'document_analysis' || /\bsummari[sz]e|\bsummary\b|\btl;?dr\b/i.test(text)) return 'summarization';
  if (task.type === 'benchmark' || task.type === 'evaluation') return 'bulk';
  if (complexity === 'complex' && (primaryCategory === 'bug_localization' || primaryCategory === 'compile_repair' || primaryCategory === 'test_repair')) return 'complex';
  if (complexity === 'complex' && task.priority === 'critical') return 'complex';
  return 'routine';
}

export const DEFAULT_WEIGHTS: Record<PolicyMode, RoutingWeights> = {
  balanced: { quality: 1, reliability: 1, capacity: 0.5, cost: 0.5, latency: 0.3, quotaRisk: 0.7 },
  'local-first': { quality: 0.8, reliability: 1, capacity: 0.5, cost: 1.5, latency: 0.2, quotaRisk: 1.5 },
  'quality-first': { quality: 3, reliability: 1.2, capacity: 0.3, cost: 0.2, latency: 0.2, quotaRisk: 0.3 },
  'budget-first': { quality: 0.5, reliability: 0.8, capacity: 0.5, cost: 2, latency: 0.2, quotaRisk: 2 },
};

const QUOTA_RISK: Record<BudgetMode, number> = { normal: 0, advisory: 0.3, unknown: 0.4, conserve: 0.7, critical: 0.9, exhausted: 1 };

/** Minimum empirical sample count required before outcome-based routing trusts measured success rates. */
export const MIN_MEASURED_SAMPLES = 3;

export interface RouteCandidate {
  modelId: string;
  runtimeId: string;
  /** Capability/evidence score from the scheduler (higher = better suited). */
  capabilityScore: number;
  /** Optional harness identifier (e.g. 'native', 'claude-code', 'codex') for cross-harness routing. */
  harnessId?: string;
  /** Optional worker / computer identifier where this candidate would execute. */
  workerId?: string;
  /** Optional explicit account identifier override. */
  accountId?: string;
  /**
   * Local only: is the model resident with enough context for this request? A model that
   * must be loaded or reloaded costs memory and load time, so it is penalised and explained.
   */
  residency?: 'ready' | 'reload' | 'load';
  /** Empirically measured verified success rate in [0, 1] for this task type/category. */
  verifiedSuccessRate?: number;
  /** Number of empirical execution/benchmark samples backing `verifiedSuccessRate`. */
  sampleCount?: number;
  /** Statistical uncertainty (e.g. Wilson interval half-width) in [0, 1]. */
  uncertainty?: number;
  /** Estimated cold-start or context-reload latency in milliseconds when not ready. */
  estimatedLoadMs?: number;
  /** Measured or estimated generation completion latency in milliseconds (excluding cold load). */
  avgLatencyMs?: number;
  /** True when loading this model on its target computer requires evicting a resident model. */
  evictionRequired?: boolean;
  /** False when usable GPU VRAM on target hardware cannot fit model weights + KV cache. */
  kvCacheFits?: boolean;
  /** False when the candidate's target runtime is unhealthy or unreachable. */
  runtimeAvailable?: boolean;
  /** False when the candidate's target worker/computer is offline or lacks capacity. */
  workerAvailable?: boolean;
  /** Expected USD cost of running verification checks for this candidate. */
  expectedVerificationCostUsd?: number;
  /** Expected USD cost of retries when an attempt fails verification. */
  expectedRetryCostUsd?: number;
  /** Expected USD cost of cold-starting or provisioning the harness/runtime/model. */
  expectedColdStartCostUsd?: number;
  /** Hard completion deadline in milliseconds for this candidate. */
  deadlineMs?: number;
  /** Hard maximum total cost in USD for this candidate. */
  maxCostUSD?: number;
}

export interface RouteAssessment extends RouteCandidate {
  accountId?: string;
  harnessId?: string;
  workerId?: string;
  admissible: boolean;
  reasons: string[];
  /** Normalised factors in [0, 1]. */
  factors?: { quality: number; reliability: number; capacity: number; cost: number; latency: number; quotaRisk: number };
  /** Expected total USD cost per verified successful task (accounts for retry probability). */
  effectiveCostPerSuccessUsd?: number;
  /**
   * Calibrated probability of verified completion in [0, 1].
   * Never derived from raw model self-confidence; uses empirical `verifiedSuccessRate * reliability`
   * when `sampleCount >= MIN_MEASURED_SAMPLES`, or rule-based account reliability prior when insufficient.
   */
  predictedVerifiedSuccessProb?: number;
  /** Expected single-attempt model execution USD cost. */
  expectedExecutionCostUsd?: number;
  /** Expected verification USD cost. */
  expectedVerificationCostUsd?: number;
  /** Expected retry USD cost given failure probability. */
  expectedRetryCostUsd?: number;
  /** Expected cold-start USD cost. */
  expectedColdStartCostUsd?: number;
  /** Expected total USD cost (execution + verification + retry + cold-start). */
  expectedTotalCostUsd?: number;
  /** Expected end-to-end completion latency in milliseconds (generation + cold-start/reload). */
  expectedCompletionLatencyMs?: number;
  /** Alias for `expectedCompletionLatencyMs` per shared telemetry contracts. */
  expectedLatencyMs?: number;
  /** Normalised quota exhaustion risk in [0, 1] from the account's current budget mode. */
  quotaExhaustionRisk?: number;
  /** True when empirical sampleCount < MIN_MEASURED_SAMPLES (or unmeasured), falling back to rule-based routing. */
  fallbackRuleBased?: boolean;
  /** Structured explanation of the outcome-based cost/quality/latency scoring decision. */
  scoringRationale?: string[];
  /** Alias for `scoringRationale` per shared contracts. */
  rationale?: string[];
  score?: number;
  local?: boolean;
}

export interface RouteAssessInput {
  task: Pick<Task, 'id'>;
  workload: WorkloadClass;
  estimatedInputTokens: number;
  estimatedOutputTokens?: number;
  candidates: RouteCandidate[];
  /** Hard maximum total expected USD cost allowed for this task. */
  maxCostUSD?: number;
  /** Hard completion deadline in milliseconds for this task. */
  deadlineMs?: number;
  /** Minimum empirically calibrated verified success rate in [0, 1]. */
  minVerifiedSuccessRate?: number;
}

export interface RouterOptions {
  budget: TokenBudgetManager;
  resolveAccount: (runtimeId: string, modelId: string) => string | undefined;
}

function minDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined && Number.isFinite(v));
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

/**
 * Resource-aware scoring for candidates the scheduler already found capable:
 *   score = q·quality + r·reliability + c·capacity − k·cost − l·latency − u·quotaRisk
 * Hard constraints (account refuses: privacy, auth, emergency stop, paid not authorised,
 * exhausted, conservation mode) are applied first via a dry-run admission, so a constrained
 * candidate is rejected with its reason rather than scored.
 */
export class ResourceRouter {
  constructor(private readonly opts: RouterOptions) {}

  private weights(): RoutingWeights {
    const p = this.opts.budget.policy;
    return { ...DEFAULT_WEIGHTS[p.mode], ...(p.weights ?? {}) };
  }

  /** Recent success rate of a model on an account (provider errors vs settled requests). */
  private reliability(accountId: string, modelId: string): number {
    const ledger = this.opts.budget.ledger;
    const since = ledger.now() - 7 * 86_400_000;
    const ok = ledger.usageRows({ since, accountId }).filter((u) => u.modelId === modelId && u.source !== 'conservative').length;
    const failed = ledger.events({ kind: 'provider_error', since, limit: 1000 }).filter((e) => e.accountId === accountId && e.data.retry !== true).length
      + ledger.events({ kind: 'ambiguous', since, limit: 1000 }).filter((e) => e.accountId === accountId).length;
    const total = ok + failed;
    return total < 3 ? 0.8 : ok / total;
  }

  /** Measured milliseconds per output token for a model (undefined when never measured). */
  private msPerToken(modelId: string): number | undefined {
    const rows = this.opts.budget.ledger.usageRows({ since: this.opts.budget.ledger.now() - 7 * 86_400_000 })
      .filter((u) => u.modelId === modelId && u.durationMs && u.outputTokens > 20 && u.source === 'provider-reported').slice(-50);
    if (rows.length === 0) return undefined;
    return rows.reduce((n, u) => n + u.durationMs! / u.outputTokens, 0) / rows.length;
  }

  assess(input: RouteAssessInput): RouteAssessment[] {
    const { budget } = this.opts;
    const w = this.weights();
    const estOutput = input.estimatedOutputTokens ?? estimateOutputTokens({}, input.workload);
    const maxCapability = Math.max(1, ...input.candidates.map((c) => c.capabilityScore));
    const minCorrectness = input.minVerifiedSuccessRate ?? budget.policy.minVerifiedSuccessRate;
    const policyMaxLatencyMs = budget.policy.maxLatencyMs;

    const ledger = budget.ledger;
    const since = ledger.now() - 7 * 86_400_000;
    const recentUsageRows = ledger.usageRows({ since });
    const recentProviderErrors = ledger.events({ kind: 'provider_error', since, limit: 1000 });
    const recentAmbiguousEvents = ledger.events({ kind: 'ambiguous', since, limit: 1000 });

    const failedByAccount = new Map<string, number>();
    const getAccountFailedCount = (accountId: string): number => {
      let count = failedByAccount.get(accountId);
      if (count === undefined) {
        count = recentProviderErrors.filter((e) => e.accountId === accountId && e.data.retry !== true).length
          + recentAmbiguousEvents.filter((e) => e.accountId === accountId).length;
        failedByAccount.set(accountId, count);
      }
      return count;
    };

    const reliabilityCache = new Map<string, number>();
    const getReliability = (accountId: string, modelId: string): number => {
      const key = `${accountId}::${modelId}`;
      let rel = reliabilityCache.get(key);
      if (rel === undefined) {
        const ok = recentUsageRows.filter((u) => u.accountId === accountId && u.modelId === modelId && u.source !== 'conservative').length;
        const failed = getAccountFailedCount(accountId);
        const total = ok + failed;
        rel = total < 3 ? 0.8 : ok / total;
        reliabilityCache.set(key, rel);
      }
      return rel;
    };

    const msPerTokenCache = new Map<string, number | undefined>();
    const getMsPerToken = (modelId: string): number | undefined => {
      if (msPerTokenCache.has(modelId)) return msPerTokenCache.get(modelId);
      const rows = recentUsageRows
        .filter((u) => u.modelId === modelId && u.durationMs && u.outputTokens > 20 && u.source === 'provider-reported')
        .slice(-50);
      const val = rows.length === 0 ? undefined : rows.reduce((n, u) => n + u.durationMs! / u.outputTokens, 0) / rows.length;
      msPerTokenCache.set(modelId, val);
      return val;
    };

    const previewCache = new Map<string, ReturnType<typeof budget.preview>>();
    const statusCache = new Map<string, ReturnType<typeof budget.status>>();
    const getStatus = (accountId: string) => {
      if (!statusCache.has(accountId)) {
        statusCache.set(accountId, budget.status(accountId));
      }
      return statusCache.get(accountId);
    };

    const buildBaseRationale = (
      c: RouteCandidate,
      accountId: string | undefined,
      fallbackRuleBased: boolean,
      predictedVerifiedSuccessProb: number | undefined,
      costs: {
        execution: number;
        verification: number;
        retry: number;
        coldStart: number;
        total: number;
        effectivePerSuccess: number;
      } | undefined,
      expectedCompletionLatencyMs: number | undefined,
      quotaRisk: number | undefined,
      mode: BudgetMode | undefined,
    ): string[] => {
      const lines: string[] = [
        `candidate: harness=${c.harnessId ?? 'default'} model=${c.modelId} runtime=${c.runtimeId} worker=${c.workerId ?? 'local'} account=${accountId ?? 'unassigned'}`,
      ];
      if (fallbackRuleBased) {
        if (c.sampleCount !== undefined && c.sampleCount < MIN_MEASURED_SAMPLES) {
          lines.push(`fallback: rule-based prior used because empirical sampleCount (${c.sampleCount}) < MIN_MEASURED_SAMPLES (${MIN_MEASURED_SAMPLES})`);
        } else {
          lines.push('fallback: rule-based prior used (no empirical verifiedSuccessRate measurement)');
        }
      } else {
        lines.push(
          `empirical: verifiedSuccessRate=${((c.verifiedSuccessRate ?? 0) * 100).toFixed(1)}% over ${c.sampleCount ?? 'sufficient'} samples` +
            (c.uncertainty !== undefined ? ` (uncertainty=${(c.uncertainty * 100).toFixed(1)}%)` : '') +
            `, predictedVerifiedSuccessProb=${((predictedVerifiedSuccessProb ?? 0) * 100).toFixed(1)}%`,
        );
      }
      if (costs) {
        lines.push(
          `cost: execution=$${costs.execution.toFixed(6)} verification=$${costs.verification.toFixed(6)} retry=$${costs.retry.toFixed(6)} coldStart=$${costs.coldStart.toFixed(6)} total=$${costs.total.toFixed(6)} effectivePerSuccess=$${costs.effectivePerSuccess.toFixed(6)}`,
        );
      }
      if (expectedCompletionLatencyMs !== undefined) {
        lines.push(`latency: expectedCompletionLatencyMs=${expectedCompletionLatencyMs}ms`);
      }
      if (quotaRisk !== undefined) {
        lines.push(`quotaRisk: ${(quotaRisk * 100).toFixed(0)}% (mode=${mode ?? 'normal'})`);
      }
      return lines;
    };

    const prelim = input.candidates.map((c): RouteAssessment & { estCost: number; ms?: number; mode?: BudgetMode } => {
      const hasSufficientEmpiricalSamples =
        c.verifiedSuccessRate !== undefined &&
        (c.sampleCount === undefined || c.sampleCount >= MIN_MEASURED_SAMPLES);
      const fallbackRuleBased = !hasSufficientEmpiricalSamples;

      const accountId = c.accountId ?? this.opts.resolveAccount(c.runtimeId, c.modelId);
      const account = accountId ? budget.accounts.get(accountId) : undefined;
      if (!accountId || !account) {
        const reasons = ['no account is configured for this runtime/model'];
        const scoringRationale = [
          ...buildBaseRationale(c, accountId, fallbackRuleBased, undefined, undefined, undefined, undefined, undefined),
          `rejected: ${reasons.join('; ')}`,
        ];
        return {
          ...c,
          accountId,
          admissible: false,
          reasons,
          fallbackRuleBased,
          scoringRationale,
          rationale: scoringRationale,
          estCost: 0,
        };
      }

      const pricing = pricingFor(account, c.modelId);
      const singleCallCost = costUsd(pricing, input.estimatedInputTokens, estOutput);
      const rel = getReliability(accountId, c.modelId);
      const rawSuccessProb = hasSufficientEmpiricalSamples ? c.verifiedSuccessRate! * rel : rel;
      const successProb = Math.max(0.05, Math.min(1, rawSuccessProb));
      const predictedVerifiedSuccessProb = Number(successProb.toFixed(4));

      const verificationCost = Math.max(0, c.expectedVerificationCostUsd ?? 0);
      const coldStartCost = Math.max(0, c.expectedColdStartCostUsd ?? 0);
      const retryCost = c.expectedRetryCostUsd !== undefined
        ? Math.max(0, c.expectedRetryCostUsd)
        : (singleCallCost + verificationCost) * ((1 - successProb) / successProb);

      const expectedExecutionCostUsd = Number(singleCallCost.toFixed(6));
      const expectedVerificationCostUsd = Number(verificationCost.toFixed(6));
      const expectedRetryCostUsd = Number(retryCost.toFixed(6));
      const expectedColdStartCostUsd = Number(coldStartCost.toFixed(6));
      const rawTotalCost = singleCallCost + verificationCost + retryCost + coldStartCost;
      const expectedTotalCostUsd = Number(rawTotalCost.toFixed(6));
      const effectiveCostPerSuccess = c.expectedRetryCostUsd !== undefined
        ? rawTotalCost / successProb
        : rawTotalCost;
      const effectiveCostPerSuccessUsd = Number(effectiveCostPerSuccess.toFixed(6));

      const tokenMs = getMsPerToken(c.modelId);
      const loadPenaltyMs = c.residency && c.residency !== 'ready'
        ? (c.estimatedLoadMs ?? 4_000)
        : (c.residency === undefined && c.estimatedLoadMs !== undefined && c.estimatedLoadMs > 0 ? c.estimatedLoadMs : 0);
      const genLatencyMs = c.avgLatencyMs !== undefined
        ? c.avgLatencyMs
        : (tokenMs !== undefined ? tokenMs * estOutput : undefined);
      const totalLatencyMs = genLatencyMs !== undefined
        ? genLatencyMs + loadPenaltyMs
        : (loadPenaltyMs > 0 ? loadPenaltyMs : undefined);
      const expectedCompletionLatencyMs = totalLatencyMs !== undefined ? Math.round(totalLatencyMs) : undefined;

      const hasModelCtxLimit = account.contextLimits?.[c.modelId] !== undefined;
      const previewKey = hasModelCtxLimit
        ? `model:${accountId}:${c.modelId}`
        : `acct:${accountId}:${pricing ? `${pricing.inputPerMTok}:${pricing.outputPerMTok}:${pricing.cachedInputPerMTok ?? 0}` : 'free'}`;
      let preview = previewCache.get(previewKey);
      if (!preview) {
        preview = budget.preview({
          requestId: `route-${input.task.id}-${c.modelId}`, accountId, modelId: c.modelId, workload: input.workload, taskId: input.task.id,
          estimatedInputTokens: input.estimatedInputTokens, estimatedOutputTokens: estOutput,
        });
        previewCache.set(previewKey, preview);
      }
      const quotaExhaustionRisk = QUOTA_RISK[preview.mode ?? 'normal'];
      const costBreakdown = {
        execution: expectedExecutionCostUsd,
        verification: expectedVerificationCostUsd,
        retry: expectedRetryCostUsd,
        coldStart: expectedColdStartCostUsd,
        total: expectedTotalCostUsd,
        effectivePerSuccess: effectiveCostPerSuccessUsd,
      };

      const makeRejected = (reasons: string[], estCostVal = 0): RouteAssessment & { estCost: number; ms?: number; mode?: BudgetMode } => {
        const scoringRationale = [
          ...buildBaseRationale(c, accountId, fallbackRuleBased, predictedVerifiedSuccessProb, costBreakdown, expectedCompletionLatencyMs, quotaExhaustionRisk, preview.mode),
          `rejected: ${reasons.join('; ')}`,
        ];
        return {
          ...c,
          accountId,
          admissible: false,
          local: account.kind === 'local',
          reasons,
          predictedVerifiedSuccessProb,
          expectedExecutionCostUsd,
          expectedVerificationCostUsd,
          expectedRetryCostUsd,
          expectedColdStartCostUsd,
          expectedTotalCostUsd,
          effectiveCostPerSuccessUsd,
          expectedCompletionLatencyMs,
          expectedLatencyMs: expectedCompletionLatencyMs,
          quotaExhaustionRisk,
          fallbackRuleBased,
          scoringRationale,
          rationale: scoringRationale,
          estCost: estCostVal,
          mode: preview.mode,
        };
      };

      if (c.runtimeAvailable === false) {
        return makeRejected([`runtime '${c.runtimeId}' is unavailable`]);
      }
      if (c.workerAvailable === false) {
        return makeRejected([`worker '${c.workerId ?? 'unknown'}' is unavailable or lacks capacity`]);
      }
      if (c.kvCacheFits === false) {
        return makeRejected(['insufficient usable GPU VRAM to fit model weights and KV cache for required context']);
      }
      if (minCorrectness !== undefined && hasSufficientEmpiricalSamples && c.verifiedSuccessRate! < minCorrectness) {
        return makeRejected([`calibrated correctness ${(c.verifiedSuccessRate! * 100).toFixed(0)}% is below policy minimum ${(minCorrectness * 100).toFixed(0)}%`]);
      }
      const quality = c.capabilityScore / maxCapability;
      if ((input.workload === 'complex' || input.workload === 'critical-review') && quality < 0.5) {
        return makeRejected([`capability ${c.capabilityScore} is below half of the best candidate (${maxCapability}) for ${input.workload} work; not substituted`]);
      }
      const effectiveMaxLatencyMs = minDefined(input.deadlineMs, c.deadlineMs, policyMaxLatencyMs);
      if (effectiveMaxLatencyMs !== undefined && totalLatencyMs !== undefined && totalLatencyMs > effectiveMaxLatencyMs) {
        return makeRejected(
          [`estimated latency ${Math.round(totalLatencyMs)}ms exceeds maxLatencyMs ${effectiveMaxLatencyMs}ms (deadline exceeded)`],
          effectiveCostPerSuccess,
        );
      }
      const effectiveMaxCostUsd = minDefined(input.maxCostUSD, c.maxCostUSD);
      if (effectiveMaxCostUsd !== undefined && expectedTotalCostUsd > effectiveMaxCostUsd) {
        return makeRejected(
          [`expected total cost $${expectedTotalCostUsd.toFixed(4)} exceeds maxCostUSD budget $${effectiveMaxCostUsd.toFixed(4)}`],
          effectiveCostPerSuccess,
        );
      }
      if (preview.outcome !== 'admitted') {
        return makeRejected([`${preview.outcome}: ${preview.reasons.join('; ')}`], effectiveCostPerSuccess);
      }

      const baseRationale = buildBaseRationale(
        c,
        accountId,
        fallbackRuleBased,
        predictedVerifiedSuccessProb,
        costBreakdown,
        expectedCompletionLatencyMs,
        quotaExhaustionRisk,
        preview.mode,
      );

      return {
        ...c,
        accountId,
        local: account.kind === 'local',
        admissible: true,
        reasons: preview.reasons,
        estCost: effectiveCostPerSuccess,
        effectiveCostPerSuccessUsd,
        predictedVerifiedSuccessProb,
        expectedExecutionCostUsd,
        expectedVerificationCostUsd,
        expectedRetryCostUsd,
        expectedColdStartCostUsd,
        expectedTotalCostUsd,
        expectedCompletionLatencyMs,
        expectedLatencyMs: expectedCompletionLatencyMs,
        quotaExhaustionRisk,
        fallbackRuleBased,
        scoringRationale: baseRationale,
        rationale: baseRationale,
        ms: totalLatencyMs !== undefined ? totalLatencyMs / Math.max(1, estOutput) : tokenMs,
        mode: preview.mode,
      };
    });

    const admissible = prelim.filter((p) => p.admissible);
    const maxCost = Math.max(0, ...admissible.map((p) => p.estCost));
    const measured = admissible.map((p) => p.ms).filter((m): m is number => m !== undefined);
    const maxMs = measured.length ? Math.max(...measured) : 0;

    return prelim.map(({ estCost, ms, mode, ...p }) => {
      if (!p.admissible) return p;
      const status = getStatus(p.accountId!);
      const account = status!.account;
      const slotCapacity = account.maxConcurrent ? 1 - status!.inFlight / account.maxConcurrent : 1;
      const residencyFactor = p.residency === 'reload' ? 0.3 : p.residency === 'load' ? (p.evictionRequired ? 0.1 : 0.2) : 1;
      const capacity = account.kind === 'local'
        ? slotCapacity * residencyFactor
        : status!.limits.some((l) => l.utilization !== undefined)
          ? 1 - Math.max(...status!.limits.map((l) => l.utilization ?? 0))
          : 0.5;
      const rel = getReliability(p.accountId!, p.modelId);
      const hasSufficientSamples = !p.fallbackRuleBased && p.verifiedSuccessRate !== undefined;
      const factors = {
        quality: p.capabilityScore / maxCapability,
        reliability: hasSufficientSamples
          ? Math.max(0, Math.min(1, p.verifiedSuccessRate! * rel))
          : rel,
        capacity: Math.max(0, Math.min(1, capacity)),
        cost: maxCost > 0 ? estCost / maxCost : 0,
        latency: ms !== undefined && maxMs > 0 ? ms / maxMs : 0.5,
        quotaRisk: QUOTA_RISK[mode ?? 'normal'],
      };
      const score = w.quality * factors.quality + w.reliability * factors.reliability + w.capacity * factors.capacity
        - w.cost * factors.cost - w.latency * factors.latency - w.quotaRisk * factors.quotaRisk;
      const roundedScore = Number(score.toFixed(4));
      const reasons = [...p.reasons];
      if (p.residency === 'reload') reasons.push('loaded with too little context: needs a reload (memory + load time)');
      else if (p.residency === 'load') reasons.push(`not loaded: needs cold load${p.estimatedLoadMs ? ` (~${p.estimatedLoadMs}ms)` : ''} (memory + load time)`);
      if (p.evictionRequired) reasons.push('loading requires evicting a resident model on target hardware');
      const scoringRationale = [
        ...(p.scoringRationale ?? []),
        `utility: score=${roundedScore.toFixed(4)} (quality=${factors.quality.toFixed(2)}, reliability=${factors.reliability.toFixed(2)}, capacity=${factors.capacity.toFixed(2)}, cost=${factors.cost.toFixed(2)}, latency=${factors.latency.toFixed(2)}, quotaRisk=${factors.quotaRisk.toFixed(2)})`,
      ];
      return {
        ...p,
        reasons,
        factors,
        score: roundedScore,
        scoringRationale,
        rationale: scoringRationale,
      };
    });
  }

  /**
   * Evaluates `Candidate = Harness + Model + Runtime + Worker + Account` against all hard
   * constraints (`minVerifiedSuccessRate`, `maxCostUSD`, authorization, runtime availability,
   * hardware capacity, `deadlineMs` / `maxLatencyMs`) and selects the optimal admissible
   * candidate minimizing expected cost per verified completion or maximizing policy utility.
   */
  selectOptimalCandidate(
    input: RouteAssessInput & { optimizeFor?: 'cost_per_verified_success' | 'policy_score' },
  ): RouteAssessment | undefined {
    const assessments = this.assess(input);
    const admissible = assessments.filter((a) => a.admissible);
    if (admissible.length === 0) {
      this.record(input.task.id, input.workload, undefined, assessments);
      return undefined;
    }

    const optimizeCost = input.optimizeFor === 'cost_per_verified_success' || this.opts.budget.policy.mode === 'budget-first';
    admissible.sort((a, b) => {
      if (optimizeCost) {
        const costDiff = (a.effectiveCostPerSuccessUsd ?? Number.POSITIVE_INFINITY) - (b.effectiveCostPerSuccessUsd ?? Number.POSITIVE_INFINITY);
        if (Math.abs(costDiff) > 1e-9) return costDiff;
      }
      const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
      if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
      const costTie = (a.effectiveCostPerSuccessUsd ?? Number.POSITIVE_INFINITY) - (b.effectiveCostPerSuccessUsd ?? Number.POSITIVE_INFINITY);
      if (Math.abs(costTie) > 1e-9) return costTie;
      const probTie = (b.predictedVerifiedSuccessProb ?? 0) - (a.predictedVerifiedSuccessProb ?? 0);
      if (Math.abs(probTie) > 1e-9) return probTie;
      return `${a.harnessId ?? ''}:${a.modelId}:${a.runtimeId}:${a.workerId ?? ''}`.localeCompare(
        `${b.harnessId ?? ''}:${b.modelId}:${b.runtimeId}:${b.workerId ?? ''}`,
      );
    });

    const chosen = admissible[0];
    this.record(input.task.id, input.workload, chosen, assessments);
    return chosen;
  }

  /** Records a routing decision in the audit trail, with the factors behind it. */
  record(taskId: string, workload: WorkloadClass, chosen: RouteAssessment | undefined, all: RouteAssessment[]): void {
    this.opts.budget.ledger.appendEvent('routing', { accountId: chosen?.accountId, taskId }, {
      workload, mode: this.opts.budget.policy.mode, chosen: chosen ? `${chosen.modelId}@${chosen.runtimeId}` : null,
      chosenHarness: chosen?.harnessId ?? null,
      chosenWorker: chosen?.workerId ?? null,
      candidates: all.map((a) => ({
        harness: a.harnessId,
        model: a.modelId,
        runtime: a.runtimeId,
        worker: a.workerId,
        account: a.accountId,
        admissible: a.admissible,
        score: a.score,
        predictedVerifiedSuccessProb: a.predictedVerifiedSuccessProb,
        expectedTotalCostUsd: a.expectedTotalCostUsd,
        effectiveCostPerSuccessUsd: a.effectiveCostPerSuccessUsd,
        expectedCompletionLatencyMs: a.expectedCompletionLatencyMs,
        fallbackRuleBased: a.fallbackRuleBased,
        factors: a.factors,
        reasons: a.reasons,
        scoringRationale: a.scoringRationale,
      })),
    });
  }
}
