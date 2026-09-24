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
  summary: string;
}

export interface ComparativeBenchmarkResult {
  taskId: string;
  category: BenchmarkTaskCategory;
  baseline: BenchmarkRunResult;
  candidate: BenchmarkRunResult;
  comparison: ComparativeEvaluation;
}

