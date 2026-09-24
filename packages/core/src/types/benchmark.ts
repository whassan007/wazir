export interface BenchmarkResult {
  id: string;
  modelId: string;
  runtimeId: string;
  computerId: string;
  prompt: string;
  response: string;
  ttftMs: number;
  totalMs: number;
  tokensPerSecond: number;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
  error?: string;
  testedAt: Date;
}

export type BenchmarkTaskCategory =
  | 'CODE_REPAIR'
  | 'FEATURE_IMPLEMENTATION'
  | 'REPOSITORY_NAVIGATION'
  | 'CODE_INTELLIGENCE'
  | 'TOOL_USE'
  | 'CONTEXT_STRESS'
  | 'RECOVERY';

export interface BenchmarkTask {
  id: string;
  name: string;
  category: BenchmarkTaskCategory;
  description: string;
  prompt: string;
  expectedFiles?: string[];
  expectedEvidence?: string[];
  protectedFiles?: string[];
  mutationRequired?: boolean;
  acceptanceContract?: import('./execution.js').AcceptanceContract;
  workspaceSetup?: (workspaceRoot: string) => Promise<void> | void;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionMetrics {
  taskSuccess: boolean;
  physicalVerificationSuccess: boolean;
  totalModelCalls: number;
  totalToolCalls: number;
  repairCycles: number;
  inputTokens: number;
  outputTokens: number;
  compactedTokens: number;
  totalWallTimeMs: number;
  modelLatencyMs: number;
  toolLatencyMs: number;
  costEstimateUsd: number;
  verificationLatencyMs: number;
  rawMetrics?: Record<string, unknown>;
}

export interface EvaluationScoreReport {
  executionId: string;
  taskId: string;
  category?: BenchmarkTaskCategory;
  metrics: ExecutionMetrics;
  evaluationResult: import('./execution.js').EvaluationResult;
  passed: boolean;
  rejectionReason?: string;
  summary: string;
}

export interface ComparativeEvaluation {
  baseline: {
    id: string;
    name?: string;
    metrics: ExecutionMetrics;
    passed: boolean;
  };
  candidate: {
    id: string;
    name?: string;
    metrics: ExecutionMetrics;
    passed: boolean;
  };
  deltas: {
    taskSuccessDelta: number;
    verificationSuccessDelta: number;
    wallTimeDeltaMs: number;
    modelLatencyDeltaMs: number;
    toolLatencyDeltaMs: number;
    totalModelCallsDelta: number;
    totalToolCallsDelta: number;
    repairCyclesDelta: number;
    inputTokensDelta: number;
    outputTokensDelta: number;
    compactedTokensDelta: number;
    costDeltaUsd: number;
    verificationLatencyDeltaMs: number;
  };
  summary: string;
  regressions: string[];
  improvements: string[];
}

export interface BenchmarkExecutionContext {
  workspaceRoot: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  config?: import('./metaOptimizer.js').OptimizableConfig;
  activeMutations?: string[];
}

export interface BenchmarkRunner {
  id: string;
  name: string;
  run(task: BenchmarkTask, context: BenchmarkExecutionContext): Promise<import('./execution.js').ExecutionRecord>;
}

export interface BenchmarkRunResult {
  taskId: string;
  taskName: string;
  category: BenchmarkTaskCategory;
  runnerId: string;
  scoreReport: EvaluationScoreReport;
  durationMs: number;
  error?: string;
}

export interface BenchmarkSuiteResult {
  category?: BenchmarkTaskCategory;
  runnerId: string;
  totalTasks: number;
  passedTasks: number;
  failedTasks: number;
  results: BenchmarkRunResult[];
  aggregateMetrics: {
    totalWallTimeMs: number;
    totalModelCalls: number;
    totalToolCalls: number;
    totalTokens: number;
    totalCostUsd: number;
    averageRepairCycles: number;
  };
  passRate?: number;
  averageDurationMs?: number;
  totalDurationMs?: number;
  executedAt?: Date;
  summary?: string;
}

export interface ComparativeBenchmarkResult {
  taskId: string;
  category: BenchmarkTaskCategory;
  baseline: BenchmarkRunResult;
  candidate: BenchmarkRunResult;
  comparison: ComparativeEvaluation;
}

export type MetricSourceKind = 'measured' | 'estimated' | 'unavailable';

export interface MetricValue<T = number> {
  value: T;
  kind: MetricSourceKind;
  unit?: string;
  note?: string;
}

export interface EvaluationRecord {
  identity: {
    runId: string;
    gateId?: string;
    testId?: string | number;
    version: string;
    modelId: string;
    runtimeId: string;
    timestamp: Date;
  };
  correctness: {
    passed: boolean;
    acceptanceAssertions: Array<{ name: string; passed: boolean; detail?: string }>;
    verificationResult?: {
      status: 'PASS' | 'FAIL' | 'ERROR';
      workspaceRevision: number;
      satisfiedOracles: string[];
      missingOracles: string[];
    };
  };
  model: {
    totalCalls: MetricValue<number>;
    inputTokens: MetricValue<number>;
    outputTokens: MetricValue<number>;
    cumulativeInputTokens: MetricValue<number>;
  };
  context: {
    peakContextTokens: MetricValue<number>;
    averageContextTokens: MetricValue<number>;
    snapshotCount: MetricValue<number>;
    revisionCount: MetricValue<number>;
    tokensRemovedDeduplication: MetricValue<number>;
    tokensRemovedSuperseded: MetricValue<number>;
    tokensSummarized: MetricValue<number>;
    tokensOffloaded: MetricValue<number>;
    cacheReadTokens: MetricValue<number>;
    cacheWriteTokens: MetricValue<number>;
  };
  tools: {
    totalCalls: MetricValue<number>;
    codeModeCalls: MetricValue<number>;
    failures: MetricValue<number>;
    retries: MetricValue<number>;
  };
  agent: {
    repairCycles: MetricValue<number>;
    malformedActions: MetricValue<number>;
    noProgressEvents: MetricValue<number>;
    subagentCalls: MetricValue<number>;
  };
  workspace: {
    mutations: MetricValue<number>;
    revisionChanges: MetricValue<number>;
    verificationInvalidations: MetricValue<number>;
  };
  performance: {
    wallTimeMs: MetricValue<number>;
    modelTimeMs: MetricValue<number>;
    toolTimeMs: MetricValue<number>;
  };
  resources?: {
    gpuTimeMs?: MetricValue<number>;
    memoryResidencyBytes?: MetricValue<number>;
    monetaryCostUsd?: MetricValue<number>;
  };
  metadata?: Record<string, unknown>;
}

export interface MultiDimensionalComparison {
  baselineId: string;
  candidateId: string;
  dimensions: {
    correctness: {
      baselinePass: boolean;
      candidatePass: boolean;
      status: 'MATCH' | 'IMPROVED' | 'REGRESSED';
    };
    modelCalls: {
      baseline: number;
      candidate: number;
      delta: number;
      percentChange: number;
    };
    inputTokens: {
      baseline: number;
      candidate: number;
      delta: number;
      percentChange: number;
    };
    peakContext: {
      baseline: number;
      candidate: number;
      delta: number;
      percentChange: number;
    };
    tokensSummarized: {
      baseline: number;
      candidate: number;
      delta: number;
    };
    repairCycles: {
      baseline: number;
      candidate: number;
      delta: number;
    };
    wallTimeMs: {
      baseline: number;
      candidate: number;
      delta: number;
      percentChange: number;
    };
    cacheEfficiency?: {
      cacheHitRatioBaseline?: number;
      cacheHitRatioCandidate?: number;
    };
  };
  verdict: 'CANDIDATE_BETTER' | 'BASELINE_BETTER' | 'INCONCLUSIVE' | 'EQUIVALENT' | 'REGRESSION';
  summary: string;
  regressions: string[];
  improvements: string[];
}
