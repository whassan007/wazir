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

export interface RouteCandidate {
  modelId: string;
  runtimeId: string;
  /** Capability/evidence score from the scheduler (higher = better suited). */
  capabilityScore: number;
  /**
   * Local only: is the model resident with enough context for this request? A model that
   * must be loaded or reloaded costs memory and load time, so it is penalised and explained.
   */
  residency?: 'ready' | 'reload' | 'load';
  /** Empirically measured verified success rate in [0, 1] for this task type/category. */
  verifiedSuccessRate?: number;
  /** Estimated cold-start or context-reload latency in milliseconds when not ready. */
  estimatedLoadMs?: number;
  /** True when loading this model on its target computer requires evicting a resident model. */
  evictionRequired?: boolean;
  /** False when usable GPU VRAM on target hardware cannot fit model weights + KV cache. */
  kvCacheFits?: boolean;
}

export interface RouteAssessment extends RouteCandidate {
  accountId?: string;
  admissible: boolean;
  reasons: string[];
  /** Normalised factors in [0, 1]. */
  factors?: { quality: number; reliability: number; capacity: number; cost: number; latency: number; quotaRisk: number };
  /** Expected USD cost per successful request, using request reliability and verified task evidence when available. */
  effectiveCostPerSuccessUsd?: number;
  costEstimate?: { status: 'estimated' | 'unknown'; usd?: number };
  reliabilityEvidence?: {
    status: 'measured' | 'insufficient' | 'unknown';
    successfulRequests: number;
    failedRequests: number;
    samples: number;
    confidence: number;
    /** Scoring prior or sample-adjusted request reliability; not task correctness. */
    scoreValue: number;
  };
  latencyEstimate?: { status: 'measured' | 'insufficient' | 'unknown'; samples: number; msPerOutputToken?: number; confidence: number };
  score?: number;
  local?: boolean;
}

const MIN_RELIABILITY_SAMPLES = 3;
const RELIABILITY_PRIOR = 0.8;
const RELIABILITY_PRIOR_STRENGTH = 5;

export interface RouterOptions {
  budget: TokenBudgetManager;
  resolveAccount: (runtimeId: string, modelId: string) => string | undefined;
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

  /** Recent per-account, model and workload request reliability; this is not task correctness. */
  private reliability(accountId: string, modelId: string, workload: WorkloadClass) {
    const ledger = this.opts.budget.ledger;
    const since = ledger.now() - 7 * 86_400_000;
    const provider = this.opts.budget.accounts.get(accountId)?.provider;
    const counts = ledger.routingOutcomeCounts({ since, accountId, provider: provider ?? '', modelId, workload });
    const samples = counts.successfulRequests + counts.failedRequests;
    const status = samples >= MIN_RELIABILITY_SAMPLES ? 'measured' as const : samples > 0 ? 'insufficient' as const : 'unknown' as const;
    const scoreValue = status === 'measured'
      ? (counts.successfulRequests + RELIABILITY_PRIOR * RELIABILITY_PRIOR_STRENGTH) / (samples + RELIABILITY_PRIOR_STRENGTH)
      : RELIABILITY_PRIOR;
    return {
      status, ...counts, samples,
      confidence: status === 'measured' ? samples / (samples + RELIABILITY_PRIOR_STRENGTH) : 0,
      scoreValue,
    };
  }

  /** Robust latency summary scoped to the same account/model/workload. */
  private latency(accountId: string, modelId: string, workload: WorkloadClass) {
    const rows = this.opts.budget.ledger.usageRows({ since: this.opts.budget.ledger.now() - 7 * 86_400_000 })
      .filter((u) => u.accountId === accountId && u.modelId === modelId && u.workload === workload
        && u.durationMs && u.outputTokens > 20 && u.source === 'provider-reported').slice(-50);
    const values = rows.map((u) => u.durationMs! / u.outputTokens).sort((a, b) => a - b);
    const samples = values.length;
    const status = samples >= MIN_RELIABILITY_SAMPLES ? 'measured' as const : samples > 0 ? 'insufficient' as const : 'unknown' as const;
    const middle = Math.floor(samples / 2);
    const median = samples === 0 ? undefined : samples % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    return {
      status, samples, confidence: status === 'measured' ? samples / (samples + MIN_RELIABILITY_SAMPLES) : 0,
      ...(median !== undefined ? { msPerOutputToken: median } : {}),
    };
  }

  assess(input: { task: Pick<Task, 'id'>; workload: WorkloadClass; estimatedInputTokens: number; candidates: RouteCandidate[] }): RouteAssessment[] {
    const { budget } = this.opts;
    const w = this.weights();
    const estOutput = estimateOutputTokens({}, input.workload);
    const minCorrectness = budget.policy.minVerifiedSuccessRate;
    const maxLatencyMs = budget.policy.maxLatencyMs;
    // A candidate that cannot be admitted (no account, insufficient context/VRAM,
    // unauthorised or out of budget) must not make every usable complex model look weaker.
    const admissibleCapabilities = input.candidates.filter((c) => {
      const accountId = this.opts.resolveAccount(c.runtimeId, c.modelId);
      const account = accountId ? budget.accounts.get(accountId) : undefined;
      if (!account || c.kvCacheFits === false) return false;
      if (minCorrectness !== undefined && c.verifiedSuccessRate !== undefined && c.verifiedSuccessRate < minCorrectness) return false;
      return budget.preview({
        requestId: `route-${input.task.id}-${c.modelId}`, accountId: account.id, modelId: c.modelId,
        workload: input.workload, taskId: input.task.id,
        estimatedInputTokens: input.estimatedInputTokens, estimatedOutputTokens: estOutput,
      }).outcome === 'admitted';
    }).map((c) => c.capabilityScore);
    const maxCapability = Math.max(1, ...admissibleCapabilities);

    const prelim = input.candidates.map((c): RouteAssessment & { estCost: number | undefined; ms?: number; mode?: BudgetMode } => {
      const accountId = this.opts.resolveAccount(c.runtimeId, c.modelId);
      if (!accountId) return { ...c, admissible: false, reasons: ['no account is configured for this runtime/model'], estCost: 0 };
      const account = budget.accounts.get(accountId)!;
      if (c.kvCacheFits === false) {
        return {
          ...c, accountId, admissible: false, local: account.kind === 'local', estCost: 0,
          reasons: ['insufficient usable GPU VRAM to fit model weights and KV cache for required context'],
        };
      }
      if (minCorrectness !== undefined && c.verifiedSuccessRate !== undefined && c.verifiedSuccessRate < minCorrectness) {
        return {
          ...c, accountId, admissible: false, local: account.kind === 'local', estCost: 0,
          reasons: [`calibrated correctness ${(c.verifiedSuccessRate * 100).toFixed(0)}% is below policy minimum ${(minCorrectness * 100).toFixed(0)}%`],
        };
      }
      const preview = budget.preview({
        requestId: `route-${input.task.id}-${c.modelId}`, accountId, modelId: c.modelId, workload: input.workload, taskId: input.task.id,
        estimatedInputTokens: input.estimatedInputTokens, estimatedOutputTokens: estOutput,
      });
      const quality = c.capabilityScore / maxCapability;
      if ((input.workload === 'complex' || input.workload === 'critical-review') && c.capabilityScore < maxCapability) {
        return { ...c, accountId, admissible: false, local: account.kind === 'local', estCost: 0,
          reasons: [`capability ${c.capabilityScore} is below the best candidate (${maxCapability}) for ${input.workload} work; not substituted because cost cannot compensate for lower capability`] };
      }
      const pricing = pricingFor(account, c.modelId);
      const costKnown = account.kind === 'local' || pricing !== undefined;
      const singleCallCost = costKnown ? costUsd(pricing, input.estimatedInputTokens, estOutput) : undefined;
      const rel = this.reliability(accountId, c.modelId, input.workload);
      const successProb = Math.max(0.05, Math.min(1, c.verifiedSuccessRate !== undefined ? c.verifiedSuccessRate * rel.scoreValue : rel.scoreValue));
      const effectiveCostPerSuccess = singleCallCost === undefined ? undefined : singleCallCost / successProb;
      const latency = this.latency(accountId, c.modelId, input.workload);
      const tokenMs = latency.status === 'measured' ? latency.msPerOutputToken : undefined;
      const loadPenaltyMs = c.residency && c.residency !== 'ready' ? (c.estimatedLoadMs ?? 4_000) : 0;
      const totalLatencyMs = tokenMs !== undefined ? tokenMs * estOutput + loadPenaltyMs : (loadPenaltyMs > 0 ? loadPenaltyMs : undefined);
      if (maxLatencyMs !== undefined && totalLatencyMs !== undefined && totalLatencyMs > maxLatencyMs) {
        return {
          ...c, accountId, admissible: false, local: account.kind === 'local', estCost: effectiveCostPerSuccess,
          ...(effectiveCostPerSuccess !== undefined ? { effectiveCostPerSuccessUsd: Number(effectiveCostPerSuccess.toFixed(6)) } : {}),
          costEstimate: costKnown ? { status: 'estimated', usd: effectiveCostPerSuccess } : { status: 'unknown' },
          reliabilityEvidence: rel,
          latencyEstimate: latency,
          reasons: [`estimated latency ${Math.round(totalLatencyMs)}ms exceeds maxLatencyMs ${maxLatencyMs}ms`],
        };
      }
      return {
        ...c, accountId, local: account.kind === 'local', admissible: preview.outcome === 'admitted',
        reasons: preview.outcome === 'admitted' ? preview.reasons : [`${preview.outcome}: ${preview.reasons.join('; ')}`],
        estCost: effectiveCostPerSuccess,
        ...(effectiveCostPerSuccess !== undefined ? { effectiveCostPerSuccessUsd: Number(effectiveCostPerSuccess.toFixed(6)) } : {}),
        costEstimate: costKnown ? { status: 'estimated', usd: effectiveCostPerSuccess } : { status: 'unknown' },
        reliabilityEvidence: rel,
        latencyEstimate: latency,
        ms: totalLatencyMs !== undefined ? totalLatencyMs / Math.max(1, estOutput) : tokenMs,
        mode: preview.mode,
      };
    });

    const admissible = prelim.filter((p) => p.admissible);
    const maxCost = Math.max(0, ...admissible.map((p) => p.estCost ?? 0));
    const measured = admissible.map((p) => p.ms).filter((m): m is number => m !== undefined);
    const maxMs = measured.length ? Math.max(...measured) : 0;

    return prelim.map(({ estCost, ms, mode, ...p }) => {
      if (!p.admissible) return p;
      const status = budget.status(p.accountId!);
      const account = status!.account;
      const slotCapacity = account.maxConcurrent ? 1 - status!.inFlight / account.maxConcurrent : 1;
      const residencyFactor = p.residency === 'reload' ? 0.3 : p.residency === 'load' ? (p.evictionRequired ? 0.1 : 0.2) : 1;
      const capacity = account.kind === 'local'
        ? slotCapacity * residencyFactor
        : status!.limits.some((l) => l.utilization !== undefined)
          ? 1 - Math.max(...status!.limits.map((l) => l.utilization ?? 0))
          : 0.5;
      const factors = {
        quality: p.capabilityScore / maxCapability,
        reliability: p.verifiedSuccessRate !== undefined
          ? Math.max(0, Math.min(1, p.verifiedSuccessRate * (p.reliabilityEvidence?.scoreValue ?? RELIABILITY_PRIOR)))
          : (p.reliabilityEvidence?.scoreValue ?? RELIABILITY_PRIOR),
        capacity: Math.max(0, Math.min(1, capacity)),
        cost: estCost !== undefined ? (maxCost > 0 ? estCost / maxCost : 0) : (maxCost > 0 ? 1 : 0.5),
        latency: ms !== undefined && maxMs > 0 ? ms / maxMs : 0.5,
        quotaRisk: QUOTA_RISK[mode ?? 'normal'],
      };
      const score = w.quality * factors.quality + w.reliability * factors.reliability + w.capacity * factors.capacity
        - w.cost * factors.cost - w.latency * factors.latency - w.quotaRisk * factors.quotaRisk;
      const reasons = [...p.reasons];
      if (p.residency === 'reload') reasons.push('loaded with too little context: needs a reload (memory + load time)');
      else if (p.residency === 'load') reasons.push(`not loaded: needs cold load${p.estimatedLoadMs ? ` (~${p.estimatedLoadMs}ms)` : ''} (memory + load time)`);
      if (p.evictionRequired) reasons.push('loading requires evicting a resident model on target hardware');
      if (p.reliabilityEvidence?.status === 'unknown') reasons.push('request reliability is unknown; using a neutral prior (not measured task-success evidence)');
      else if (p.reliabilityEvidence?.status === 'insufficient') reasons.push(`request reliability has only ${p.reliabilityEvidence.samples} attributable sample(s); using a prior (not a measured rate)`);
      if (p.latencyEstimate?.status === 'insufficient') reasons.push(`latency has only ${p.latencyEstimate.samples} provider-reported sample(s); it is shown but not used to rank`);
      if (p.costEstimate?.status === 'unknown') reasons.push('expected API/subscription cost is unknown and is not treated as $0');
      return { ...p, reasons, factors, score: Number(score.toFixed(4)) };
    });
  }

  /** Records a routing decision in the audit trail, with the factors behind it. */
  record(taskId: string, workload: WorkloadClass, chosen: RouteAssessment | undefined, all: RouteAssessment[]): void {
    this.opts.budget.ledger.appendEvent('routing', { accountId: chosen?.accountId, taskId }, {
      workload, mode: this.opts.budget.policy.mode, chosen: chosen ? `${chosen.modelId}@${chosen.runtimeId}` : null,
      candidates: all.map((a) => ({ model: a.modelId, runtime: a.runtimeId, account: a.accountId, admissible: a.admissible, score: a.score, factors: a.factors, reliabilityEvidence: a.reliabilityEvidence, costEstimate: a.costEstimate, latencyEstimate: a.latencyEstimate, reasons: a.reasons })),
    });
  }
}
