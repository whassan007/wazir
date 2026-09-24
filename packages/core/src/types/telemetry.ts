export type CostStatus = 'ACTUAL' | 'ESTIMATED' | 'UNKNOWN';

export interface PhysicalComputeUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  modelCalls: number;
  wallTimeMs: number;
  modelTimeMs: number;
  gpuTimeMs?: number;
  peakMemoryBytes: number;
  cpuTimeMs?: number;
}

export interface MonetaryCost {
  status: CostStatus;
  currency: 'USD';
  amount?: number;
  breakdown?: {
    inputCostUsd?: number;
    outputCostUsd?: number;
    cachedCostUsd?: number;
  };
}

export interface UsageRecord {
  id: string;
  executionId: string;
  jobId?: string;
  agentId?: string;
  modelId: string;
  runtimeId: string;
  computerId?: string;
  provider: string;
  isLocal: boolean;
  physical: PhysicalComputeUsage;
  monetary: MonetaryCost;
  timestamp: Date;
}

export interface ModelPricingTier {
  provider: string;
  modelPattern: string; // Regex string or exact name
  inputTokenPricePerMillion: number;
  outputTokenPricePerMillion: number;
  cachedTokenPricePerMillion?: number;
}

export interface AggregatedUsageReport {
  totalExecutions: number;
  totalModelCalls: number;
  physical: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalTokens: number;
    totalWallTimeMs: number;
    totalModelTimeMs: number;
    peakMemoryBytes: number;
  };
  monetary: {
    totalActualCostUsd: number;
    totalEstimatedCostUsd: number;
    hasUnknownCost: boolean;
    costStatus: CostStatus;
    byProvider: Record<string, { amountUsd?: number; status: CostStatus }>;
  };
  byModel: Record<
    string,
    {
      calls: number;
      tokens: number;
      wallTimeMs: number;
      peakMemoryBytes: number;
      costStatus: CostStatus;
      costUsd?: number;
    }
  >;
}
