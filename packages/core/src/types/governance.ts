export interface GovernanceLimits {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxTokensPerTurn?: number;
  maxToolCalls?: number;
  maxWallClockMs?: number;
  maxCostUsd?: number;
  maxConcurrency?: number;
  reservedCpuCores?: number;
  reservedGpuMemoryGB?: number;
}

export interface BudgetConsumption {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  wallClockMs: number;
  costUsd: number;
  activeConcurrency: number;
}

export interface AdmissionDecision {
  admitted: boolean;
  reason?: string;
  limits: GovernanceLimits;
  recommendedModelId?: string;
  degradationAction?: 'none' | 'downgrade_model' | 'compact_context' | 'limit_turns';
}

export interface GovernanceCheckResult {
  ok: boolean;
  exhausted: boolean;
  hardTerminate: boolean;
  warnings: string[];
  degradationRecommended?: 'compact_context' | 'downgrade_model' | 'halt';
  consumption: BudgetConsumption;
  limits: GovernanceLimits;
}

export interface BudgetAuditEntry {
  executionId: string;
  timestamp: Date;
  delta: {
    inputTokens?: number;
    outputTokens?: number;
    toolCalls?: number;
    costUsd?: number;
  };
  cumulative: BudgetConsumption;
  event: 'turn' | 'tool_call' | 'warning' | 'exhausted' | 'terminated';
}
