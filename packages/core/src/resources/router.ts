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
  /** Expected total USD cost per verified successful task (accounts for retry probability). */
  effectiveCostPerSuccessUsd?: number;
  score?: number;
  local?: boolean;
}

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

  assess(input: { task: Pick<Task, 'id'>; workload: WorkloadClass; estimatedInputTokens: number; candidates: RouteCandidate[] }): RouteAssessment[] {
    const { budget } = this.opts;
    const w = this.weights();
    const estOutput = estimateOutputTokens({}, input.workload);
    const maxCapability = Math.max(1, ...input.candidates.map((c) => c.capabilityScore));
    const minCorrectness = budget.policy.minVerifiedSuccessRate;
    const maxLatencyMs = budget.policy.maxLatencyMs;

    const prelim = input.candidates.map((c): RouteAssessment & { estCost: number; ms?: number; mode?: BudgetMode } => {
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
      if ((input.workload === 'complex' || input.workload === 'critical-review') && quality < 0.5) {
        return { ...c, accountId, admissible: false, local: account.kind === 'local', estCost: 0,
          reasons: [`capability ${c.capabilityScore} is below half of the best candidate (${maxCapability}) for ${input.workload} work; not substituted`] };
      }
      const singleCallCost = costUsd(pricingFor(account, c.modelId), input.estimatedInputTokens, estOutput);
      const rel = this.reliability(accountId, c.modelId);
      const successProb = Math.max(0.05, Math.min(1, c.verifiedSuccessRate !== undefined ? c.verifiedSuccessRate * rel : rel));
      // A quality floor is a hard eligibility constraint, not merely a scoring bonus.
      // This prevents a cheap but empirically unreliable model from winning budget-first
      // routing. With no explicit calibration, the conservative prior is used and remains
      // visible in the routing explanation.
      if (minCorrectness !== undefined && successProb < minCorrectness) {
        return {
          ...c, accountId, local: account.kind === 'local', admissible: false, estCost: 0,
          effectiveCostPerSuccessUsd: Number((singleCallCost / successProb).toFixed(6)),
          reasons: [`estimated verified success ${(successProb * 100).toFixed(0)}% is below policy minimum ${(minCorrectness * 100).toFixed(0)}% (empirical reliability)`],
        };
      }
      const effectiveCostPerSuccess = singleCallCost / successProb;
      const tokenMs = this.msPerToken(c.modelId);
      const loadPenaltyMs = c.residency && c.residency !== 'ready' ? (c.estimatedLoadMs ?? 4_000) : 0;
      const totalLatencyMs = tokenMs !== undefined ? tokenMs * estOutput + loadPenaltyMs : (loadPenaltyMs > 0 ? loadPenaltyMs : undefined);
      if (maxLatencyMs !== undefined && totalLatencyMs !== undefined && totalLatencyMs > maxLatencyMs) {
        return {
          ...c, accountId, admissible: false, local: account.kind === 'local', estCost: effectiveCostPerSuccess,
          effectiveCostPerSuccessUsd: Number(effectiveCostPerSuccess.toFixed(6)),
          reasons: [`estimated latency ${Math.round(totalLatencyMs)}ms exceeds maxLatencyMs ${maxLatencyMs}ms`],
        };
      }
      return {
        ...c, accountId, local: account.kind === 'local', admissible: preview.outcome === 'admitted',
        reasons: preview.outcome === 'admitted' ? preview.reasons : [`${preview.outcome}: ${preview.reasons.join('; ')}`],
        estCost: effectiveCostPerSuccess,
        effectiveCostPerSuccessUsd: Number(effectiveCostPerSuccess.toFixed(6)),
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
          ? Math.max(0, Math.min(1, p.verifiedSuccessRate * this.reliability(p.accountId!, p.modelId)))
          : this.reliability(p.accountId!, p.modelId),
        capacity: Math.max(0, Math.min(1, capacity)),
        cost: maxCost > 0 ? estCost / maxCost : 0,
        latency: ms !== undefined && maxMs > 0 ? ms / maxMs : 0.5,
        quotaRisk: QUOTA_RISK[mode ?? 'normal'],
      };
      const residencyBonus = p.residency === 'ready' ? 1.5 : 0;
      const score = w.quality * factors.quality + w.reliability * factors.reliability + w.capacity * factors.capacity
        - w.cost * factors.cost - w.latency * factors.latency - w.quotaRisk * factors.quotaRisk + residencyBonus;
      const reasons = [...p.reasons];
      if (p.residency === 'ready') reasons.push('resident model in memory: ready now (zero reload latency)');
      else if (p.residency === 'reload') reasons.push('loaded with too little context: needs a reload (memory + load time)');
      else if (p.residency === 'load') reasons.push(`not loaded: needs cold load${p.estimatedLoadMs ? ` (~${p.estimatedLoadMs}ms)` : ''} (memory + load time)`);
      if (p.evictionRequired) reasons.push('loading requires evicting a resident model on target hardware');
      return { ...p, reasons, factors, score: Number(score.toFixed(4)) };
    });
  }

  /** Records a routing decision in the audit trail, with the factors behind it. */
  record(taskId: string, workload: WorkloadClass, chosen: RouteAssessment | undefined, all: RouteAssessment[]): void {
    this.opts.budget.ledger.appendEvent('routing', { accountId: chosen?.accountId, taskId }, {
      workload, mode: this.opts.budget.policy.mode, chosen: chosen ? `${chosen.modelId}@${chosen.runtimeId}` : null,
      candidates: all.map((a) => ({ model: a.modelId, runtime: a.runtimeId, account: a.accountId, admissible: a.admissible, score: a.score, factors: a.factors, reasons: a.reasons })),
    });
  }
}
