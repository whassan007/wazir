import { randomUUID } from 'node:crypto';
import type {
  UsageRecord,
  PhysicalComputeUsage,
  MonetaryCost,
  ModelPricingTier,
  AggregatedUsageReport,
  CostStatus,
} from '../types/telemetry.js';

export class TelemetryCollector {
  private records: UsageRecord[] = [];
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
  }): UsageRecord {
    const isLocal =
      params.isLocal ??
      (params.provider.toLowerCase() === 'ollama' ||
        params.provider.toLowerCase() === 'lmstudio');

    const cachedTokens = params.cachedTokens ?? 0;
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
  }
}
