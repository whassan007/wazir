import type { BenchmarkSuiteResult, ComparativeBenchmarkResult } from './benchmark.js';

export interface OptimizableConfig {
  id: string;
  version: number;
  prompts?: {
    systemPromptPrefix?: string;
    repairGuidance?: string;
    verificationInstruction?: string;
  };
  contextWeights?: {
    definitionRelevance?: number;
    callersRelevance?: number;
    testsRelevance?: number;
    recencyRelevance?: number;
    errorSignalRelevance?: number;
  };
  governanceLimits?: {
    maxTokens?: number;
    maxCostUSD?: number;
    maxToolCalls?: number;
    maxRepairCycles?: number;
  };
  toolPolicies?: {
    codeModeThreshold?: number;
    batchExecutionAllowed?: boolean;
    autoVerifyAfterMutation?: boolean;
  };
}

export type MutationType =
  | 'PROMPT_TWEAK'
  | 'WEIGHT_ADJUSTMENT'
  | 'POLICY_MODIFICATION'
  | 'GOVERNANCE_TUNING';

export interface ConfigMutation {
  type: MutationType;
  path: string;
  oldValue: unknown;
  newValue: unknown;
  rationale: string;
}

export type MetaOptimizationDecision = 'ACCEPTED' | 'REJECTED';

export interface MetaOptimizationCandidate {
  candidateId: string;
  mutations: ConfigMutation[];
  config: OptimizableConfig;
}

export interface ComparativeBenchmarkSuiteResult {
  baselineRunnerId: string;
  candidateRunnerId: string;
  baselineTasks: number;
  candidateTasks: number;
  baselinePassRate: number;
  candidatePassRate: number;
  passRateDelta: number;
  tokenUsageDelta: number;
  costDelta: number;
  durationDelta: number;
  regressedTasks: string[];
  improvedTasks: string[];
  regressionDetected: boolean;
  improvementDetected: boolean;
  preferredCandidate: 'candidate' | 'baseline' | 'tie';
  summary: string;
}

export interface MetaOptimizationRunResult {
  runId: string;
  baselineConfig: OptimizableConfig;
  candidateConfig: OptimizableConfig;
  mutations: ConfigMutation[];
  baselineBenchmark: BenchmarkSuiteResult;
  candidateBenchmark: BenchmarkSuiteResult;
  comparison: ComparativeBenchmarkSuiteResult;
  decision: MetaOptimizationDecision;
  reasons: string[];
  evaluatedAt: Date;
}
