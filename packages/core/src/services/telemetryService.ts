import { randomUUID } from 'node:crypto';
import {
  type UsageRecord,
  type PhysicalComputeUsage,
  type MonetaryCost,
  type ModelPricingTier,
  type AggregatedUsageReport,
  type CostStatus,
  type PromptCacheTelemetry,
  type CacheMetricStatus,
  type CacheMetricValue,
  aggregatePromptCacheTelemetry,
  toPromptCacheTelemetry,
} from '../types/telemetry.js';

export type RoutingExclusionCategory =
  | 'policy'
  | 'resource'
  | 'context'
  | 'capability'
  | 'circuit_breaker'
  | 'availability'
  | 'other';

export interface RoutingCandidateAlternative {
  harnessId?: string;
  modelId: string;
  runtimeId: string;
  computerId?: string;
  workerId?: string;
  accountId?: string;
  eligible: boolean;
  score?: number;
  predictedSuccessProbability?: number;
  estimatedCostUSD?: number;
  reasons: string[];
}

export interface RoutingEligibilityExclusion {
  harnessId?: string;
  modelId: string;
  runtimeId: string;
  exclusionReasons: string[];
  categories?: RoutingExclusionCategory[];
}

export interface RoutingCalibrationEvidence {
  sampleCount: number;
  confidence: number;
  uncertainty?: number;
  isStale: boolean;
  staleReason?: string;
}

export type RoutingCacheReuseTelemetry =
  | 'UNOBSERVED'
  | {
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      hitRate: number | null;
    };

export interface RoutingTelemetryRecord {
  id: string;
  executionId: string;
  taskId: string;
  jobId?: string;
  routingPolicyVersion: string;
  harnessId: string | null;
  modelId: string;
  runtimeId: string;
  computerId: string | null;
  workerId: string | null;
  accountId: string | null;
  candidateAlternatives: RoutingCandidateAlternative[];
  eligibilityExclusions: RoutingEligibilityExclusion[];
  predictedSuccessProbability: number | null;
  calibrationEvidence: RoutingCalibrationEvidence | null;
  estimatedCostUSD: number | null;
  actualCostUSD: number | null;
  costStatus: CostStatus;
  firstTokenLatencyMs: number | null;
  endToEndLatencyMs: number | null;
  verificationDurationMs: number | null;
  cacheReuse: RoutingCacheReuseTelemetry;
  coldStartOverheadMs: number | null;
  retryOverheadMs: number | null;
  retryCount: number;
  verifiedSuccess?: boolean;
  timestamp: Date;
}

export interface RoutingTelemetryInput {
  executionId: string;
  taskId: string;
  jobId?: string;
  routingPolicyVersion?: string | null;
  harnessId?: string | null;
  modelId: string;
  runtimeId: string;
  computerId?: string | null;
  workerId?: string | null;
  accountId?: string | null;
  provider?: string;
  isLocal?: boolean;
  candidateAlternatives?: RoutingCandidateAlternative[];
  eligibilityExclusions?: RoutingEligibilityExclusion[];
  predictedSuccessProbability?: number | null;
  calibrationEvidence?: {
    sampleCount: number;
    confidence: number;
    uncertainty?: number;
    isStale?: boolean;
    staleReason?: string;
  } | null;
  estimatedCostUSD?: number | null;
  actualCostUSD?: number | null;
  costStatus?: CostStatus;
  firstTokenLatencyMs?: number | null;
  endToEndLatencyMs?: number | null;
  verificationDurationMs?: number | null;
  cacheReuse?:
    | 'UNOBSERVED'
    | {
        cacheReadTokens?: number | null;
        cacheWriteTokens?: number | null;
        inputTokens?: number | null;
        hitRate?: number | null;
      }
    | null;
  coldStartOverheadMs?: number | null;
  retryOverheadMs?: number | null;
  retryCount?: number;
  verifiedSuccess?: boolean;
  timestamp?: Date;
}

export interface RoutingTelemetryFilter {
  executionId?: string;
  taskId?: string;
  jobId?: string;
  harnessId?: string;
  modelId?: string;
  runtimeId?: string;
  routingPolicyVersion?: string;
  costStatus?: CostStatus;
}

export interface RoutingTelemetrySummary {
  totalDecisions: number;
  byHarness: Record<string, number>;
  byModel: Record<string, number>;
  byRuntime: Record<string, number>;
  byPolicyVersion: Record<string, number>;
  exclusionsByCategory: Record<RoutingExclusionCategory, number>;
  totalCandidatesEvaluated: number;
  totalCandidatesExcluded: number;
  cost: {
    totalEstimatedCostUSD: number;
    totalActualCostUSD: number;
    unknownCostCount: number;
    estimatedCostCount: number;
    actualCostCount: number;
    costStatus: CostStatus;
  };
  latency: {
    avgFirstTokenLatencyMs: number | null;
    avgEndToEndLatencyMs: number | null;
    avgVerificationDurationMs: number | null;
    avgColdStartOverheadMs: number | null;
    avgRetryOverheadMs: number | null;
    totalRetries: number;
  };
  calibration: {
    avgPredictedSuccessProbability: number | null;
    observedVerifiedSuccessRate: number | null;
    meanAbsoluteCalibrationError: number | null;
    staleCalibrationCount: number;
  };
  cache: {
    observedCount: number;
    unobservedCount: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    avgHitRate: number | null;
  };
}

/**
 * Categorizes candidate exclusion reasons into deterministic root causes:
 * policy, resource, context, capability, circuit_breaker, availability, or other.
 */
export function classifyExclusionReasons(reasons: readonly string[]): RoutingExclusionCategory[] {
  const categories = new Set<RoutingExclusionCategory>();
  for (const r of reasons) {
    const lower = r.toLowerCase();
    if (
      lower.includes('policy') ||
      lower.includes('hosted') ||
      lower.includes('provider_only') ||
      lower.includes('routingmode') ||
      lower.includes('routing.mode') ||
      lower.includes('allowedmodels') ||
      lower.includes('local_only') ||
      lower.includes('data classification') ||
      lower.includes('sensitive') ||
      lower.includes('restricted')
    ) {
      categories.add('policy');
    } else if (lower.includes('context')) {
      categories.add('context');
    } else if (
      lower.includes('circuit') ||
      lower.includes('open:') ||
      lower.includes('half_open') ||
      lower.includes('failure rate')
    ) {
      categories.add('circuit_breaker');
    } else if (
      lower.includes('capability') ||
      lower.includes('tool calling') ||
      lower.includes('vision') ||
      lower.includes('reasoning') ||
      lower.includes('below policy minimum') ||
      lower.includes('calibrated correctness') ||
      lower.includes('below half of the best candidate')
    ) {
      categories.add('capability');
    } else if (
      lower.includes('resource') ||
      lower.includes('vram') ||
      lower.includes('memory') ||
      lower.includes('gpu') ||
      lower.includes('quota') ||
      lower.includes('budget') ||
      lower.includes('exhausted') ||
      lower.includes('conserve') ||
      lower.includes('account') ||
      lower.includes('latency')
    ) {
      categories.add('resource');
    } else if (
      lower.includes('unavailable') ||
      lower.includes('no running instance') ||
      lower.includes('already tried') ||
      lower.includes('excluded')
    ) {
      categories.add('availability');
    } else {
      categories.add('other');
    }
  }
  return Array.from(categories);
}

const LOCAL_RUNTIMES = new Set(['ollama', 'lmstudio', 'local', 'vllm', 'llamacpp', 'llama.cpp', 'mlx']);

export class TelemetryCollector {
  private records: UsageRecord[] = [];
  private routingRecords: RoutingTelemetryRecord[] = [];
  private pricingTiers: ModelPricingTier[] = [
    {
      provider: 'openai',
      modelPattern: 'gpt-4o',
      inputTokenPricePerMillion: 2.5,
      outputTokenPricePerMillion: 10.0,
      cachedTokenPricePerMillion: 1.25,
    },
    {
      provider: 'anthropic',
      modelPattern: 'claude-3-5-sonnet',
      inputTokenPricePerMillion: 3.0,
      outputTokenPricePerMillion: 15.0,
      cachedTokenPricePerMillion: 0.3,
    },
    {
      provider: 'deepseek',
      modelPattern: 'deepseek-chat',
      inputTokenPricePerMillion: 0.14,
      outputTokenPricePerMillion: 0.28,
      cachedTokenPricePerMillion: 0.014,
    },
  ];

  /**
   * Register or override pricing for a model pattern.
   */
  public registerPricingTier(tier: ModelPricingTier): void {
    this.pricingTiers.unshift(tier);
  }

  /**
   * Calculates monetary cost given model, provider, tokens, and locality.
   * CRITICAL INVARIANT:
   * 1. Local models (Ollama/LM Studio/local) have an API monetary cost of strictly $0.00 (ACTUAL).
   * 2. Unpriced remote models have status 'UNKNOWN' and amount undefined. Never coerced to $0.00.
   */
  public calculateCost(params: {
    provider: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    isLocal?: boolean;
  }): MonetaryCost {
    const isLocal =
      params.isLocal ??
      (params.provider.toLowerCase() === 'ollama' ||
        params.provider.toLowerCase() === 'lmstudio');

    if (isLocal) {
      return {
        status: 'ACTUAL',
        currency: 'USD',
        amount: 0.0,
        breakdown: {
          inputCostUsd: 0.0,
          outputCostUsd: 0.0,
          cachedCostUsd: 0.0,
        },
      };
    }

    const cachedTokens = params.cachedTokens ?? 0;
    const tier = this.pricingTiers.find(
      (t) =>
        t.provider.toLowerCase() === params.provider.toLowerCase() &&
        (t.modelPattern === params.modelId ||
          params.modelId.toLowerCase().includes(t.modelPattern.toLowerCase())),
    );

    if (!tier) {
      // Unpriced remote model: cost is UNKNOWN, NOT $0.00!
      return {
        status: 'UNKNOWN',
        currency: 'USD',
        amount: undefined,
      };
    }

    const inputCostUsd = (params.inputTokens / 1_000_000) * tier.inputTokenPricePerMillion;
    const outputCostUsd = (params.outputTokens / 1_000_000) * tier.outputTokenPricePerMillion;
    const cachedCostUsd =
      tier.cachedTokenPricePerMillion !== undefined
        ? (cachedTokens / 1_000_000) * tier.cachedTokenPricePerMillion
        : 0;
    const totalAmount = inputCostUsd + outputCostUsd + cachedCostUsd;

    return {
      status: 'ACTUAL',
      currency: 'USD',
      amount: Number(totalAmount.toFixed(6)),
      breakdown: {
        inputCostUsd: Number(inputCostUsd.toFixed(6)),
        outputCostUsd: Number(outputCostUsd.toFixed(6)),
        cachedCostUsd: Number(cachedCostUsd.toFixed(6)),
      },
    };
  }

  /**
   * Records a model call execution with both physical resource consumption and monetary cost.
   */
  public recordModelCall(params: {
    executionId: string;
    jobId?: string;
    agentId?: string;
    modelId: string;
    runtimeId: string;
    computerId?: string;
    provider: string;
    isLocal?: boolean;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    wallTimeMs: number;
    modelTimeMs?: number;
    peakMemoryBytes?: number;
    gpuTimeMs?: number;
    costOverride?: MonetaryCost;
    promptCacheMetrics?: import('../types/telemetry.js').PromptCacheMetrics;
    promptCache?: PromptCacheTelemetry;
  }): UsageRecord {
    const isLocal =
      params.isLocal ??
      (params.provider.toLowerCase() === 'ollama' ||
        params.provider.toLowerCase() === 'lmstudio');

    const promptCache: PromptCacheTelemetry | undefined =
      params.promptCache ??
      (params.promptCacheMetrics
        ? toPromptCacheTelemetry({
            runtimeId: params.runtimeId,
            modelId: params.modelId,
            executionId: params.executionId,
            metrics: params.promptCacheMetrics,
          })
        : undefined);

    const cachedTokens =
      params.cachedTokens ??
      promptCache?.cacheReadTokens?.value ??
      params.promptCacheMetrics?.cacheReadTokens?.value ??
      0;
    const totalTokens = params.inputTokens + params.outputTokens + cachedTokens;

    const physical: PhysicalComputeUsage = {
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cachedTokens,
      totalTokens,
      modelCalls: 1,
      wallTimeMs: params.wallTimeMs,
      modelTimeMs: params.modelTimeMs ?? params.wallTimeMs,
      gpuTimeMs: params.gpuTimeMs,
      peakMemoryBytes: params.peakMemoryBytes ?? (isLocal ? 1024 * 1024 * 1024 : 0), // Local model loads in memory
      cacheReadTokens: promptCache?.cacheReadTokens?.value ?? params.promptCacheMetrics?.cacheReadTokens?.value,
      cacheWriteTokens: promptCache?.cacheWriteTokens?.value ?? params.promptCacheMetrics?.cacheWriteTokens?.value,
      promptCacheMetrics: params.promptCacheMetrics,
    };

    let monetary =
      params.costOverride ??
      this.calculateCost({
        provider: params.provider,
        modelId: params.modelId,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        cachedTokens,
        isLocal,
      });

    // Invariant check: UNKNOWN cost MUST have amount undefined
    if (monetary.status === 'UNKNOWN' && monetary.amount !== undefined) {
      monetary = { ...monetary, amount: undefined };
    }

    const record: UsageRecord = {
      id: `usage-${randomUUID()}`,
      executionId: params.executionId,
      jobId: params.jobId,
      agentId: params.agentId,
      modelId: params.modelId,
      runtimeId: params.runtimeId,
      computerId: params.computerId,
      provider: params.provider,
      isLocal,
      physical,
      monetary,
      promptCacheMetrics: params.promptCacheMetrics,
      promptCache,
      timestamp: new Date(),
    };

    this.records.push(record);
    return record;
  }

  public recordUsage(record: UsageRecord): UsageRecord {
    // Invariant check
    if (record.monetary.status === 'UNKNOWN' && record.monetary.amount !== undefined) {
      record = {
        ...record,
        monetary: {
          ...record.monetary,
          amount: undefined,
        },
      };
    }
    this.records.push(record);
    return record;
  }

  public getRecords(filter?: { executionId?: string; jobId?: string }): UsageRecord[] {
    return this.records.filter((r) => {
      if (filter?.executionId && r.executionId !== filter.executionId) return false;
      if (filter?.jobId && r.jobId !== filter.jobId) return false;
      return true;
    });
  }

  /**
   * Records a complete routing telemetry decision and outcome for an execution.
   * Enforces the monetary cost invariant: UNKNOWN remote costs never fabricate $0.00.
   */
  public recordRoutingTelemetry(params: RoutingTelemetryInput): RoutingTelemetryRecord {
    const executionUsage = this.getRecords({ executionId: params.executionId });
    const isLocal =
      params.isLocal ??
      (LOCAL_RUNTIMES.has(params.runtimeId.toLowerCase()) ||
        (params.provider !== undefined && LOCAL_RUNTIMES.has(params.provider.toLowerCase())));

    const candidateAlternatives: RoutingCandidateAlternative[] = (params.candidateAlternatives ?? []).map((c) => ({
      ...c,
      reasons: [...c.reasons],
    }));

    const rawExclusions =
      params.eligibilityExclusions ??
      candidateAlternatives
        .filter((c) => !c.eligible)
        .map((c) => ({
          ...(c.harnessId ? { harnessId: c.harnessId } : {}),
          modelId: c.modelId,
          runtimeId: c.runtimeId,
          exclusionReasons: [...c.reasons],
          categories: undefined as RoutingExclusionCategory[] | undefined,
        }));

    const eligibilityExclusions: RoutingEligibilityExclusion[] = rawExclusions.map((e) => ({
      ...(e.harnessId ? { harnessId: e.harnessId } : {}),
      modelId: e.modelId,
      runtimeId: e.runtimeId,
      exclusionReasons: [...e.exclusionReasons],
      categories: e.categories && e.categories.length > 0 ? [...e.categories] : classifyExclusionReasons(e.exclusionReasons),
    }));

    let calibrationEvidence: RoutingCalibrationEvidence | null = null;
    if (params.calibrationEvidence) {
      const ce = params.calibrationEvidence;
      const clampedConf = Math.max(0, Math.min(1, ce.confidence));
      calibrationEvidence = {
        sampleCount: ce.sampleCount,
        confidence: clampedConf,
        uncertainty: ce.uncertainty ?? Number((1 - clampedConf).toFixed(4)),
        isStale: Boolean(ce.isStale),
        ...(ce.staleReason ? { staleReason: ce.staleReason } : {}),
      };
    }

    const estimatedCostUSD =
      typeof params.estimatedCostUSD === 'number' && Number.isFinite(params.estimatedCostUSD)
        ? Number(params.estimatedCostUSD.toFixed(6))
        : null;

    let costStatus: CostStatus;
    let actualCostUSD: number | null = null;

    if (params.costStatus === 'UNKNOWN') {
      // Strict invariant: UNKNOWN cost must never have a fabricated $0 actual cost
      costStatus = 'UNKNOWN';
      actualCostUSD = null;
    } else if (params.costStatus === 'ESTIMATED') {
      costStatus = 'ESTIMATED';
      actualCostUSD =
        typeof params.actualCostUSD === 'number' && Number.isFinite(params.actualCostUSD)
          ? Number(params.actualCostUSD.toFixed(6))
          : null;
    } else if (params.costStatus === 'ACTUAL') {
      costStatus = 'ACTUAL';
      if (typeof params.actualCostUSD === 'number' && Number.isFinite(params.actualCostUSD)) {
        actualCostUSD = Number(params.actualCostUSD.toFixed(6));
      } else if (isLocal) {
        actualCostUSD = 0;
      } else {
        // Cannot claim ACTUAL without a known amount on non-local inference
        costStatus = estimatedCostUSD !== null ? 'ESTIMATED' : 'UNKNOWN';
        actualCostUSD = null;
      }
    } else if (typeof params.actualCostUSD === 'number' && Number.isFinite(params.actualCostUSD)) {
      costStatus = 'ACTUAL';
      actualCostUSD = Number(params.actualCostUSD.toFixed(6));
    } else if (executionUsage.length > 0) {
      const agg = this.aggregate(executionUsage);
      costStatus = agg.monetary.costStatus;
      if (costStatus === 'ACTUAL') {
        actualCostUSD = agg.monetary.totalActualCostUsd;
      } else {
        actualCostUSD = null;
      }
    } else if (isLocal) {
      costStatus = 'ACTUAL';
      actualCostUSD = 0;
    } else if (estimatedCostUSD !== null) {
      costStatus = 'ESTIMATED';
      actualCostUSD = null;
    } else {
      costStatus = 'UNKNOWN';
      actualCostUSD = null;
    }

    let cacheReuse: RoutingCacheReuseTelemetry = 'UNOBSERVED';
    if (params.cacheReuse && params.cacheReuse !== 'UNOBSERVED') {
      const read =
        typeof params.cacheReuse.cacheReadTokens === 'number' && Number.isFinite(params.cacheReuse.cacheReadTokens)
          ? params.cacheReuse.cacheReadTokens
          : null;
      const write =
        typeof params.cacheReuse.cacheWriteTokens === 'number' && Number.isFinite(params.cacheReuse.cacheWriteTokens)
          ? params.cacheReuse.cacheWriteTokens
          : null;
      const explicitHitRate =
        typeof params.cacheReuse.hitRate === 'number' && Number.isFinite(params.cacheReuse.hitRate)
          ? Math.max(0, Math.min(1, Number(params.cacheReuse.hitRate.toFixed(4))))
          : null;
      const totalInput =
        typeof params.cacheReuse.inputTokens === 'number' && params.cacheReuse.inputTokens > 0
          ? params.cacheReuse.inputTokens
          : executionUsage.reduce((acc, u) => acc + u.physical.inputTokens, 0);
      const computedHitRate =
        explicitHitRate !== null
          ? explicitHitRate
          : read !== null && totalInput > 0
            ? Math.max(0, Math.min(1, Number((read / totalInput).toFixed(4))))
            : null;

      if (read !== null || write !== null || computedHitRate !== null) {
        cacheReuse = {
          cacheReadTokens: read,
          cacheWriteTokens: write,
          hitRate: computedHitRate,
        };
      }
    } else if (params.cacheReuse === undefined && executionUsage.length > 0) {
      const agg = this.aggregate(executionUsage);
      const pc = agg.promptCache;
      if (pc && (pc.source === 'OBSERVED' || pc.source === 'ESTIMATED')) {
        const read = typeof pc.cacheReadTokens.value === 'number' ? pc.cacheReadTokens.value : null;
        const write = typeof pc.cacheWriteTokens.value === 'number' ? pc.cacheWriteTokens.value : null;
        const input = typeof pc.inputTokens.value === 'number' ? pc.inputTokens.value : agg.physical.totalInputTokens;
        const hitRate =
          read !== null && input > 0 ? Math.max(0, Math.min(1, Number((read / input).toFixed(4)))) : null;
        if (read !== null || write !== null || hitRate !== null) {
          cacheReuse = {
            cacheReadTokens: read,
            cacheWriteTokens: write,
            hitRate,
          };
        }
      }
    }

    const record: RoutingTelemetryRecord = {
      id: `route-telemetry-${randomUUID()}`,
      executionId: params.executionId,
      taskId: params.taskId,
      jobId: params.jobId,
      routingPolicyVersion: params.routingPolicyVersion ?? '1.0.0',
      harnessId: params.harnessId ?? null,
      modelId: params.modelId,
      runtimeId: params.runtimeId,
      computerId: params.computerId ?? null,
      workerId: params.workerId ?? null,
      accountId: params.accountId ?? null,
      candidateAlternatives,
      eligibilityExclusions,
      predictedSuccessProbability:
        typeof params.predictedSuccessProbability === 'number' && Number.isFinite(params.predictedSuccessProbability)
          ? params.predictedSuccessProbability
          : null,
      calibrationEvidence,
      estimatedCostUSD,
      actualCostUSD,
      costStatus,
      firstTokenLatencyMs:
        typeof params.firstTokenLatencyMs === 'number' && Number.isFinite(params.firstTokenLatencyMs)
          ? params.firstTokenLatencyMs
          : null,
      endToEndLatencyMs:
        typeof params.endToEndLatencyMs === 'number' && Number.isFinite(params.endToEndLatencyMs)
          ? params.endToEndLatencyMs
          : null,
      verificationDurationMs:
        typeof params.verificationDurationMs === 'number' && Number.isFinite(params.verificationDurationMs)
          ? params.verificationDurationMs
          : null,
      cacheReuse,
      coldStartOverheadMs:
        typeof params.coldStartOverheadMs === 'number' && Number.isFinite(params.coldStartOverheadMs)
          ? params.coldStartOverheadMs
          : null,
      retryOverheadMs:
        typeof params.retryOverheadMs === 'number' && Number.isFinite(params.retryOverheadMs)
          ? params.retryOverheadMs
          : null,
      retryCount: typeof params.retryCount === 'number' && params.retryCount >= 0 ? params.retryCount : 0,
      ...(params.verifiedSuccess !== undefined ? { verifiedSuccess: params.verifiedSuccess } : {}),
      timestamp: params.timestamp ?? new Date(),
    };

    this.routingRecords.push(record);
    return record;
  }

  public getRoutingTelemetry(filter?: RoutingTelemetryFilter): RoutingTelemetryRecord[] {
    if (!filter) return [...this.routingRecords];
    return this.routingRecords.filter((r) => {
      if (filter.executionId && r.executionId !== filter.executionId) return false;
      if (filter.taskId && r.taskId !== filter.taskId) return false;
      if (filter.jobId && r.jobId !== filter.jobId) return false;
      if (filter.harnessId && r.harnessId !== filter.harnessId) return false;
      if (filter.modelId && r.modelId !== filter.modelId) return false;
      if (filter.runtimeId && r.runtimeId !== filter.runtimeId) return false;
      if (filter.routingPolicyVersion && r.routingPolicyVersion !== filter.routingPolicyVersion) return false;
      if (filter.costStatus && r.costStatus !== filter.costStatus) return false;
      return true;
    });
  }

  public summarizeRoutingTelemetry(
    recordsOrFilter?: RoutingTelemetryRecord[] | RoutingTelemetryFilter,
  ): RoutingTelemetrySummary {
    const records = Array.isArray(recordsOrFilter)
      ? recordsOrFilter
      : this.getRoutingTelemetry(recordsOrFilter);

    const byHarness: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const byRuntime: Record<string, number> = {};
    const byPolicyVersion: Record<string, number> = {};
    const exclusionsByCategory: Record<RoutingExclusionCategory, number> = {
      policy: 0,
      resource: 0,
      context: 0,
      capability: 0,
      circuit_breaker: 0,
      availability: 0,
      other: 0,
    };

    let totalCandidatesEvaluated = 0;
    let totalCandidatesExcluded = 0;

    let totalEstimatedCostUSD = 0;
    let totalActualCostUSD = 0;
    let unknownCostCount = 0;
    let estimatedCostCount = 0;
    let actualCostCount = 0;

    const firstTokenSamples: number[] = [];
    const e2eSamples: number[] = [];
    const verificationSamples: number[] = [];
    const coldStartSamples: number[] = [];
    const retryOverheadSamples: number[] = [];
    let totalRetries = 0;

    const predictedProbs: number[] = [];
    const verifiedOutcomes: number[] = [];
    const calibrationErrors: number[] = [];
    let staleCalibrationCount = 0;

    let observedCacheCount = 0;
    let unobservedCacheCount = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    const hitRateSamples: number[] = [];

    for (const r of records) {
      const harnessKey = r.harnessId ?? 'unassigned';
      byHarness[harnessKey] = (byHarness[harnessKey] ?? 0) + 1;
      byModel[r.modelId] = (byModel[r.modelId] ?? 0) + 1;
      byRuntime[r.runtimeId] = (byRuntime[r.runtimeId] ?? 0) + 1;
      byPolicyVersion[r.routingPolicyVersion] = (byPolicyVersion[r.routingPolicyVersion] ?? 0) + 1;

      totalCandidatesEvaluated += r.candidateAlternatives.length;
      totalCandidatesExcluded += r.eligibilityExclusions.length;

      for (const ex of r.eligibilityExclusions) {
        const cats = ex.categories && ex.categories.length > 0
          ? ex.categories
          : classifyExclusionReasons(ex.exclusionReasons);
        for (const cat of cats) {
          exclusionsByCategory[cat] = (exclusionsByCategory[cat] ?? 0) + 1;
        }
      }

      if (r.estimatedCostUSD !== null) {
        totalEstimatedCostUSD += r.estimatedCostUSD;
      }
      if (r.costStatus === 'UNKNOWN') {
        unknownCostCount += 1;
      } else if (r.costStatus === 'ESTIMATED') {
        estimatedCostCount += 1;
      } else if (r.costStatus === 'ACTUAL') {
        actualCostCount += 1;
        if (r.actualCostUSD !== null) {
          totalActualCostUSD += r.actualCostUSD;
        }
      }

      if (r.firstTokenLatencyMs !== null) firstTokenSamples.push(r.firstTokenLatencyMs);
      if (r.endToEndLatencyMs !== null) e2eSamples.push(r.endToEndLatencyMs);
      if (r.verificationDurationMs !== null) verificationSamples.push(r.verificationDurationMs);
      if (r.coldStartOverheadMs !== null) coldStartSamples.push(r.coldStartOverheadMs);
      if (r.retryOverheadMs !== null) retryOverheadSamples.push(r.retryOverheadMs);
      totalRetries += r.retryCount;

      if (r.predictedSuccessProbability !== null) {
        predictedProbs.push(r.predictedSuccessProbability);
        if (r.verifiedSuccess !== undefined) {
          const observed = r.verifiedSuccess ? 1 : 0;
          calibrationErrors.push(Math.abs(r.predictedSuccessProbability - observed));
        }
      }
      if (r.verifiedSuccess !== undefined) {
        verifiedOutcomes.push(r.verifiedSuccess ? 1 : 0);
      }
      if (r.calibrationEvidence?.isStale) {
        staleCalibrationCount += 1;
      }

      if (r.cacheReuse === 'UNOBSERVED') {
        unobservedCacheCount += 1;
      } else {
        observedCacheCount += 1;
        if (r.cacheReuse.cacheReadTokens !== null) totalCacheReadTokens += r.cacheReuse.cacheReadTokens;
        if (r.cacheReuse.cacheWriteTokens !== null) totalCacheWriteTokens += r.cacheReuse.cacheWriteTokens;
        if (r.cacheReuse.hitRate !== null) hitRateSamples.push(r.cacheReuse.hitRate);
      }
    }

    const avg = (arr: number[]): number | null =>
      arr.length === 0 ? null : Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(4));

    const overallCostStatus: CostStatus =
      unknownCostCount > 0 ? 'UNKNOWN' : estimatedCostCount > 0 ? 'ESTIMATED' : 'ACTUAL';

    return {
      totalDecisions: records.length,
      byHarness,
      byModel,
      byRuntime,
      byPolicyVersion,
      exclusionsByCategory,
      totalCandidatesEvaluated,
      totalCandidatesExcluded,
      cost: {
        totalEstimatedCostUSD: Number(totalEstimatedCostUSD.toFixed(6)),
        totalActualCostUSD: Number(totalActualCostUSD.toFixed(6)),
        unknownCostCount,
        estimatedCostCount,
        actualCostCount,
        costStatus: overallCostStatus,
      },
      latency: {
        avgFirstTokenLatencyMs: avg(firstTokenSamples),
        avgEndToEndLatencyMs: avg(e2eSamples),
        avgVerificationDurationMs: avg(verificationSamples),
        avgColdStartOverheadMs: avg(coldStartSamples),
        avgRetryOverheadMs: avg(retryOverheadSamples),
        totalRetries,
      },
      calibration: {
        avgPredictedSuccessProbability: avg(predictedProbs),
        observedVerifiedSuccessRate: avg(verifiedOutcomes),
        meanAbsoluteCalibrationError: avg(calibrationErrors),
        staleCalibrationCount,
      },
      cache: {
        observedCount: observedCacheCount,
        unobservedCount: unobservedCacheCount,
        totalCacheReadTokens,
        totalCacheWriteTokens,
        avgHitRate: avg(hitRateSamples),
      },
    };
  }

  /**
   * Aggregates usage across records, strictly separating physical compute from monetary billing.
   */
  public aggregate(records: UsageRecord[]): AggregatedUsageReport {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let totalTokens = 0;
    let totalWallTimeMs = 0;
    let totalModelTimeMs = 0;
    let peakMemoryBytes = 0;

    let totalActualCostUsd = 0;
    let totalEstimatedCostUsd = 0;
    let hasUnknownCost = false;

    const byProvider: Record<string, { amountUsd?: number; status: CostStatus }> = {};
    const byModel: Record<
      string,
      {
        calls: number;
        tokens: number;
        wallTimeMs: number;
        peakMemoryBytes: number;
        costStatus: CostStatus;
        costUsd?: number;
      }
    > = {};

    for (const r of records) {
      totalInputTokens += r.physical.inputTokens;
      totalOutputTokens += r.physical.outputTokens;
      totalCachedTokens += r.physical.cachedTokens;
      totalTokens += r.physical.totalTokens;
      totalWallTimeMs += r.physical.wallTimeMs;
      totalModelTimeMs += r.physical.modelTimeMs;
      if (r.physical.peakMemoryBytes > peakMemoryBytes) {
        peakMemoryBytes = r.physical.peakMemoryBytes;
      }

      // Monetary processing
      if (r.monetary.status === 'UNKNOWN') {
        hasUnknownCost = true;
      } else if (r.monetary.status === 'ACTUAL' && r.monetary.amount !== undefined) {
        totalActualCostUsd += r.monetary.amount;
      } else if (r.monetary.status === 'ESTIMATED' && r.monetary.amount !== undefined) {
        totalEstimatedCostUsd += r.monetary.amount;
      }

      // Provider breakdown
      if (!byProvider[r.provider]) {
        byProvider[r.provider] = {
          amountUsd: r.monetary.status === 'UNKNOWN' ? undefined : 0,
          status: r.monetary.status,
        };
      }
      if (r.monetary.status === 'UNKNOWN') {
        byProvider[r.provider].status = 'UNKNOWN';
        byProvider[r.provider].amountUsd = undefined;
      } else if (
        byProvider[r.provider].status !== 'UNKNOWN' &&
        r.monetary.amount !== undefined
      ) {
        byProvider[r.provider].amountUsd =
          (byProvider[r.provider].amountUsd ?? 0) + r.monetary.amount;
      }

      // Model breakdown
      if (!byModel[r.modelId]) {
        byModel[r.modelId] = {
          calls: 0,
          tokens: 0,
          wallTimeMs: 0,
          peakMemoryBytes: 0,
          costStatus: r.monetary.status,
          costUsd: r.monetary.status === 'UNKNOWN' ? undefined : 0,
        };
      }
      const modelEntry = byModel[r.modelId];
      modelEntry.calls += r.physical.modelCalls;
      modelEntry.tokens += r.physical.totalTokens;
      modelEntry.wallTimeMs += r.physical.wallTimeMs;
      if (r.physical.peakMemoryBytes > modelEntry.peakMemoryBytes) {
        modelEntry.peakMemoryBytes = r.physical.peakMemoryBytes;
      }
      if (r.monetary.status === 'UNKNOWN') {
        modelEntry.costStatus = 'UNKNOWN';
        modelEntry.costUsd = undefined;
      } else if (modelEntry.costStatus !== 'UNKNOWN' && r.monetary.amount !== undefined) {
        modelEntry.costUsd = (modelEntry.costUsd ?? 0) + r.monetary.amount;
      }
    }

    const overallCostStatus: CostStatus = hasUnknownCost
      ? 'UNKNOWN'
      : totalEstimatedCostUsd > 0
        ? 'ESTIMATED'
        : 'ACTUAL';

    const promptCacheRecords: PromptCacheTelemetry[] = [];
    for (const r of records) {
      if (r.promptCache) {
        promptCacheRecords.push(r.promptCache);
      } else if (r.promptCacheMetrics) {
        promptCacheRecords.push(
          toPromptCacheTelemetry({
            runtimeId: r.runtimeId,
            modelId: r.modelId,
            executionId: r.executionId,
            metrics: r.promptCacheMetrics,
          }),
        );
      }
    }
    const aggregatedPromptCache = aggregatePromptCacheTelemetry(promptCacheRecords);

    return {
      totalExecutions: new Set(records.map((r) => r.executionId)).size,
      totalModelCalls: records.reduce((acc, r) => acc + r.physical.modelCalls, 0),
      physical: {
        totalInputTokens,
        totalOutputTokens,
        totalCachedTokens,
        totalTokens,
        totalWallTimeMs,
        totalModelTimeMs,
        peakMemoryBytes,
      },
      monetary: {
        totalActualCostUsd: Number(totalActualCostUsd.toFixed(6)),
        totalEstimatedCostUsd: Number(totalEstimatedCostUsd.toFixed(6)),
        hasUnknownCost,
        costStatus: overallCostStatus,
        byProvider,
      },
      promptCache: aggregatedPromptCache,
      byModel,
    };
  }

  public aggregateJobUsage(jobId: string): AggregatedUsageReport {
    return this.aggregate(this.getRecords({ jobId }));
  }

  public aggregateAll(): AggregatedUsageReport {
    return this.aggregate(this.records);
  }

  public clear(): void {
    this.records = [];
    this.routingRecords = [];
  }
}
