import { createHash } from 'node:crypto';
import type {
  AcceptanceContract,
  BenchmarkTask,
  BenchmarkTaskCategory,
  CostStatus,
  EvaluationScoreReport,
  ExecutionRecord,
} from '@wazir/core';
import { EvaluationService, type EvaluationServiceOptions } from './evaluationService.js';
import { BENCHMARK_CATEGORIES } from './benchmarkService.js';
import { binomialUpperTail } from './pairedEvidence.js';

export type RouterBenchmarkDifficulty = 'easy' | 'medium' | 'hard';

export type RouterTaskEvaluationStatus = 'COMPLETED' | 'BLOCKED';

export type ComparativeRouterVerdict =
  | 'IMPROVEMENT'
  | 'NO_SIGNIFICANT_IMPROVEMENT'
  | 'REGRESSION';

export type RouterBenchmarkMetricName =
  | 'verified_success_rate'
  | 'cost_per_verified_success'
  | 'end_to_end_latency_p50'
  | 'end_to_end_latency_p95'
  | 'retry_rate'
  | 'fallback_rate'
  | 'policy_violation_rate';

export const REQUIRED_ROUTER_BENCHMARK_METRICS: readonly RouterBenchmarkMetricName[] = [
  'verified_success_rate',
  'cost_per_verified_success',
  'end_to_end_latency_p50',
  'end_to_end_latency_p95',
  'retry_rate',
  'fallback_rate',
  'policy_violation_rate',
] as const;

export interface RouterBenchmarkHardwareEligibility {
  allowedRuntimeIds?: string[];
  allowedHarnessIds?: string[];
  minAvailableVramGb?: number;
  requiresGpu?: boolean;
  allowLocal?: boolean;
  allowRemotePaid?: boolean;
}

export interface RouterBenchmarkExecutionBudget {
  maxTokens: number;
  maxModelCalls: number;
  maxWallTimeMs: number;
  maxMonetaryCostUSD: number;
  maxRetries?: number;
}

export interface RouterBenchmarkTask extends BenchmarkTask {
  id: string;
  name: string;
  category: BenchmarkTaskCategory;
  description: string;
  prompt: string;
  expectedFiles?: string[];
  expectedEvidence?: string[];
  protectedFiles?: string[];
  mutationRequired?: boolean;
  acceptanceContract?: AcceptanceContract;
  difficulty: RouterBenchmarkDifficulty;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  hardwareEligibility: RouterBenchmarkHardwareEligibility;
  executionBudget: RouterBenchmarkExecutionBudget;
}

export interface RouterCandidateSpec {
  candidateId?: string;
  harnessId: string;
  modelId: string;
  runtimeId: string;
  capabilityScore: number;
  /** Empirically calibrated verified success probability in [0, 1] for this category/difficulty */
  verifiedSuccessRate?: number;
  /** Category-specific verified success rate map if segmented */
  categorySuccessRates?: Partial<Record<BenchmarkTaskCategory, number>>;
  sampleCount?: number;
  uncertainty?: number;
  costPer1kInputUsd: number;
  costPer1kOutputUsd: number;
  expectedVerificationCostUsd?: number;
  expectedRetryCostUsd?: number;
  expectedColdStartCostUsd?: number;
  baseLatencyMs: number;
  coldStartLatencyMs?: number;
  residency?: 'ready' | 'reload' | 'load';
  kvCacheFits?: boolean;
  requiredVramGb?: number;
  isLocal?: boolean;
  available?: boolean;
}

export interface RouterEnvironmentState {
  availableRuntimeIds: string[];
  availableHarnessIds: string[];
  availableVramGb: number;
  hasGpu: boolean;
  allowLocal: boolean;
  allowRemotePaid: boolean;
}

export interface RouterPolicyDecision {
  selectedCandidate?: RouterCandidateSpec;
  fallbackCandidates?: RouterCandidateSpec[];
  blockedReason?: string;
  rationale: string[];
}

export interface RouterTaskExecutionOutcome {
  status: RouterTaskEvaluationStatus;
  blockedReason?: string;
  selectedHarnessId?: string;
  selectedModelId?: string;
  selectedRuntimeId?: string;
  record?: ExecutionRecord;
  retryCount?: number;
  fallbackUsed?: boolean;
  policyViolation?: boolean;
  policyViolationReasons?: string[];
  costUsd?: number;
  costStatus?: CostStatus;
  endToEndLatencyMs?: number;
  rationale?: string[];
}

export interface RouterBenchmarkPolicy {
  id: string;
  name: string;
  version?: string;
  /**
   * Selects a route candidate from the eligible pool under matched environment and budget constraints.
   */
  selectRoute?: (
    task: RouterBenchmarkTask,
    candidates: readonly RouterCandidateSpec[],
    environment: RouterEnvironmentState,
  ) => RouterPolicyDecision;
  /**
   * Optional custom task executor. When omitted, the benchmark uses the provided `taskExecutor`
   * or deterministic outcome evaluator on the selected candidate.
   */
  executeTask?: (
    task: RouterBenchmarkTask,
    context: {
      repetition: number;
      environment: RouterEnvironmentState;
      budget: RouterBenchmarkExecutionBudget;
      candidates: readonly RouterCandidateSpec[];
      decision?: RouterPolicyDecision;
    },
  ) => Promise<RouterTaskExecutionOutcome> | RouterTaskExecutionOutcome;
}

export interface MetricStatisticalSummary {
  sampleCount: number;
  mean: number;
  variance: number;
  stdDev: number;
  standardError: number;
  confidenceInterval95: [number, number];
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export interface RouterTaskEvaluationResult {
  taskId: string;
  taskName: string;
  category: BenchmarkTaskCategory;
  difficulty: RouterBenchmarkDifficulty;
  repetition: number;
  policyId: string;
  taskDefinitionHash: string;
  status: RouterTaskEvaluationStatus;
  blockedReason?: string;
  selectedHarnessId?: string;
  selectedModelId?: string;
  selectedRuntimeId?: string;
  verified: boolean;
  apparentCompletion: boolean;
  costUsd: number;
  costStatus: CostStatus;
  endToEndLatencyMs: number;
  retryCount: number;
  retried: boolean;
  fallbackUsed: boolean;
  policyViolation: boolean;
  policyViolationReasons: string[];
  scoreReport?: EvaluationScoreReport;
  rationale: string[];
}

export interface CategoryDifficultyBreakdown {
  totalTasks: number;
  completedTasks: number;
  blockedTasks: number;
  verifiedSuccessCount: number;
  verifiedSuccessRate: number;
  meanCostUsd: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
}

export interface RouterPolicyBenchmarkSummary {
  policyId: string;
  policyName: string;
  totalSamples: number;
  completedCount: number;
  blockedCount: number;
  verifiedSuccessCount: number;
  verified_success_rate: number;
  cost_per_verified_success: number;
  end_to_end_latency_p50: number;
  end_to_end_latency_p95: number;
  retry_rate: number;
  fallback_rate: number;
  policy_violation_rate: number;
  totalCostUsd: number;
  statistics: {
    verified_success_rate: MetricStatisticalSummary;
    cost_per_verified_success: MetricStatisticalSummary;
    end_to_end_latency: MetricStatisticalSummary;
    retry_rate: MetricStatisticalSummary;
    fallback_rate: MetricStatisticalSummary;
    policy_violation_rate: MetricStatisticalSummary;
  };
  byCategory: Partial<Record<BenchmarkTaskCategory, CategoryDifficultyBreakdown>>;
  byDifficulty: Partial<Record<RouterBenchmarkDifficulty, CategoryDifficultyBreakdown>>;
  completedEvaluations: RouterTaskEvaluationResult[];
  blockedEvaluations: RouterTaskEvaluationResult[];
  allEvaluations: RouterTaskEvaluationResult[];
}

export interface MetricComparisonDetail {
  metric: RouterBenchmarkMetricName;
  baseline: number;
  candidate: number;
  delta: number;
  percentChange: number;
  baselineCI95: [number, number];
  candidateCI95: [number, number];
  confidenceIntervalsOverlap: boolean;
  pairedWins: number;
  pairedLosses: number;
  pairedTies: number;
  pValue: number;
  significant: boolean;
}

export interface MatchedConditionsManifest {
  enforced: boolean;
  taskCount: number;
  repetitions: number;
  taskSuiteHash: string;
  environmentHash: string;
  budgetHash: string;
}

export interface ComparativeRouterBenchmarkResult {
  benchmarkId: string;
  executedAt: string;
  matchedConditions: MatchedConditionsManifest;
  baseline: RouterPolicyBenchmarkSummary;
  candidate: RouterPolicyBenchmarkSummary;
  deltas: {
    verified_success_rate: number;
    cost_per_verified_success: number;
    end_to_end_latency_p50: number;
    end_to_end_latency_p95: number;
    retry_rate: number;
    fallback_rate: number;
    policy_violation_rate: number;
  };
  metricComparisons: Record<RouterBenchmarkMetricName, MetricComparisonDetail>;
  verdict: ComparativeRouterVerdict;
  improvements: string[];
  regressions: string[];
  inconclusiveReasons: string[];
  honestAssessment: string[];
  summary: string;
}

export interface ComparativeRouterBenchmarkOptions {
  benchmarkId?: string;
  tasks?: readonly RouterBenchmarkTask[];
  candidates?: readonly RouterCandidateSpec[];
  environment?: Partial<RouterEnvironmentState>;
  /** Optional override to test matched-condition enforcement */
  candidateEnvironmentOverride?: Partial<RouterEnvironmentState>;
  /** Optional override to test matched-condition enforcement */
  candidateTasksOverride?: readonly RouterBenchmarkTask[];
  /** Optional override to test matched-condition enforcement */
  candidateBudgetOverride?: Partial<RouterBenchmarkExecutionBudget>;
  repetitions?: number;
  evaluationOptions?: EvaluationServiceOptions;
  taskExecutor?: (params: {
    task: RouterBenchmarkTask;
    policy: RouterBenchmarkPolicy;
    decision: RouterPolicyDecision;
    repetition: number;
    environment: RouterEnvironmentState;
    budget: RouterBenchmarkExecutionBudget;
  }) => Promise<RouterTaskExecutionOutcome> | RouterTaskExecutionOutcome;
  /** Minimum significance level alpha for paired tests (default 0.05) */
  alpha?: number;
}

const DEFAULT_ENVIRONMENT: RouterEnvironmentState = {
  availableRuntimeIds: ['local-ollama', 'local-vllm', 'cloud-openai', 'cloud-anthropic'],
  availableHarnessIds: ['native', 'acp-codex', 'acp-claude'],
  availableVramGb: 24,
  hasGpu: true,
  allowLocal: true,
  allowRemotePaid: true,
};

const DEFAULT_BUDGET: RouterBenchmarkExecutionBudget = {
  maxTokens: 32_000,
  maxModelCalls: 8,
  maxWallTimeMs: 60_000,
  maxMonetaryCostUSD: 0.5,
  maxRetries: 2,
};

function makeTask(params: {
  id: string;
  name: string;
  category: BenchmarkTaskCategory;
  difficulty: RouterBenchmarkDifficulty;
  description: string;
  prompt: string;
  expectedFiles: string[];
  requiredEvidence?: AcceptanceContract['requiredEvidence'];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  hardwareEligibility?: Partial<RouterBenchmarkHardwareEligibility>;
  executionBudget?: Partial<RouterBenchmarkExecutionBudget>;
}): RouterBenchmarkTask {
  return {
    id: params.id,
    name: params.name,
    category: params.category,
    difficulty: params.difficulty,
    description: params.description,
    prompt: params.prompt,
    expectedFiles: params.expectedFiles,
    mutationRequired: true,
    acceptanceContract: {
      taskType: params.category,
      requiredEvidence: params.requiredEvidence ?? ['TEST'],
    },
    estimatedInputTokens: params.estimatedInputTokens,
    estimatedOutputTokens: params.estimatedOutputTokens,
    hardwareEligibility: {
      allowLocal: true,
      allowRemotePaid: true,
      ...params.hardwareEligibility,
    },
    executionBudget: {
      ...DEFAULT_BUDGET,
      ...params.executionBudget,
    },
  };
}

/**
 * 21 independently specified canonical router benchmark tasks spanning all 7 categories
 * (`CODE_REPAIR`, `FEATURE_IMPLEMENTATION`, `REPOSITORY_NAVIGATION`, `CODE_INTELLIGENCE`,
 * `TOOL_USE`, `CONTEXT_STRESS`, `RECOVERY`) and all 3 difficulty levels (`easy`, `medium`, `hard`).
 */
export const CANONICAL_ROUTER_BENCHMARK_TASKS: readonly RouterBenchmarkTask[] = [
  // 1-3: CODE_REPAIR
  makeTask({
    id: 'router-repair-01-null-guard',
    name: 'Repair Null Guard in Division Helper',
    category: 'CODE_REPAIR',
    difficulty: 'easy',
    description: 'Fix divideByZero edge case in arithmetic utility.',
    prompt: 'Update src/math.ts so divide(a, 0) returns null and passes unit tests.',
    expectedFiles: ['src/math.ts'],
    requiredEvidence: ['TEST'],
    estimatedInputTokens: 1200,
    estimatedOutputTokens: 350,
  }),
  makeTask({
    id: 'router-repair-02-async-race',
    name: 'Repair Async Queue Race Condition',
    category: 'CODE_REPAIR',
    difficulty: 'medium',
    description: 'Eliminate concurrent dequeue race condition in worker queue.',
    prompt: 'Fix the race condition in src/queue.ts when multiple consumers await pop().',
    expectedFiles: ['src/queue.ts'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 3400,
    estimatedOutputTokens: 800,
  }),
  makeTask({
    id: 'router-repair-03-distributed-lock-deadlock',
    name: 'Repair Distributed Lock Renewal Deadlock',
    category: 'CODE_REPAIR',
    difficulty: 'hard',
    description: 'Resolve re-entrant lock lease expiration deadlock across heartbeats.',
    prompt: 'Fix lease renewal deadlock in src/lockManager.ts while preserving fencing tokens.',
    expectedFiles: ['src/lockManager.ts'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 6800,
    estimatedOutputTokens: 1600,
  }),

  // 4-6: FEATURE_IMPLEMENTATION
  makeTask({
    id: 'router-feature-04-slug-generator',
    name: 'Implement URL Slug Normalizer',
    category: 'FEATURE_IMPLEMENTATION',
    difficulty: 'easy',
    description: 'Implement deterministic ASCII slugify helper with diacritic stripping.',
    prompt: 'Implement slugify(input) in src/slug.ts and verify with tests.',
    expectedFiles: ['src/slug.ts'],
    requiredEvidence: ['TEST'],
    estimatedInputTokens: 1500,
    estimatedOutputTokens: 400,
  }),
  makeTask({
    id: 'router-feature-05-ttl-lru-cache',
    name: 'Implement TTL-Aware LRU Cache',
    category: 'FEATURE_IMPLEMENTATION',
    difficulty: 'medium',
    description: 'Implement bounded LRU cache supporting per-entry TTL expiration.',
    prompt: 'Implement TtlLruCache in src/lru.ts with get, set, delete, and lazy eviction.',
    expectedFiles: ['src/lru.ts'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 4000,
    estimatedOutputTokens: 950,
  }),
  makeTask({
    id: 'router-feature-06-dag-toposort-scheduler',
    name: 'Implement Incremental DAG Scheduler',
    category: 'FEATURE_IMPLEMENTATION',
    difficulty: 'hard',
    description: 'Implement cycle-safe topological task scheduler with priority tie-breaking.',
    prompt: 'Implement DagScheduler in src/dagScheduler.ts with cycle detection and parallel wave output.',
    expectedFiles: ['src/dagScheduler.ts'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 7500,
    estimatedOutputTokens: 1900,
  }),

  // 7-9: REPOSITORY_NAVIGATION
  makeTask({
    id: 'router-nav-07-locate-deprecated-api',
    name: 'Locate Deprecated Logger Callers',
    category: 'REPOSITORY_NAVIGATION',
    difficulty: 'easy',
    description: 'Find all files invoking deprecated Logger.legacyWarn method.',
    prompt: 'Catalog every call site of Logger.legacyWarn into reports/deprecated-calls.json.',
    expectedFiles: ['reports/deprecated-calls.json'],
    requiredEvidence: ['TEST'],
    estimatedInputTokens: 2000,
    estimatedOutputTokens: 300,
  }),
  makeTask({
    id: 'router-nav-08-trace-config-propagation',
    name: 'Trace Runtime Config Override Chain',
    category: 'REPOSITORY_NAVIGATION',
    difficulty: 'medium',
    description: 'Trace how CLI flags override environment variables and default config schemas.',
    prompt: 'Write the precedence chain and file locations to reports/config-lineage.json.',
    expectedFiles: ['reports/config-lineage.json'],
    requiredEvidence: ['TEST'],
    estimatedInputTokens: 4500,
    estimatedOutputTokens: 700,
  }),
  makeTask({
    id: 'router-nav-09-cross-package-boundary-audit',
    name: 'Cross-Package Boundary Violation Audit',
    category: 'REPOSITORY_NAVIGATION',
    difficulty: 'hard',
    description: 'Identify all transitive imports that bypass public barrel exports across packages.',
    prompt: 'Generate reports/boundary-violations.json listing every deep relative cross-package import.',
    expectedFiles: ['reports/boundary-violations.json'],
    requiredEvidence: ['TEST'],
    estimatedInputTokens: 8200,
    estimatedOutputTokens: 1200,
  }),

  // 10-12: CODE_INTELLIGENCE
  makeTask({
    id: 'router-intel-10-unused-exports',
    name: 'Identify Unused Module Exports',
    category: 'CODE_INTELLIGENCE',
    difficulty: 'easy',
    description: 'Analyze symbol graph to list exported symbols with zero internal references.',
    prompt: 'Write unused exported symbol names to analysis/unused-exports.json.',
    expectedFiles: ['analysis/unused-exports.json'],
    requiredEvidence: ['TEST'],
    estimatedInputTokens: 2200,
    estimatedOutputTokens: 450,
  }),
  makeTask({
    id: 'router-intel-11-circular-dependency-cutset',
    name: 'Compute Minimum Circular Dependency Cutset',
    category: 'CODE_INTELLIGENCE',
    difficulty: 'medium',
    description: 'Find strongly connected components in module graph and propose minimal edge removals.',
    prompt: 'Output cycle components and minimal cutset to analysis/cycles.json.',
    expectedFiles: ['analysis/cycles.json'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 5000,
    estimatedOutputTokens: 900,
  }),
  makeTask({
    id: 'router-intel-12-change-impact-blast-radius',
    name: 'Compute Polymorphic Interface Blast Radius',
    category: 'CODE_INTELLIGENCE',
    difficulty: 'hard',
    description: 'Determine all concrete implementations and downstream tests affected by an interface change.',
    prompt: 'Produce analysis/impact-graph.json for modifying HarnessAdapter.execute signature.',
    expectedFiles: ['analysis/impact-graph.json'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 8800,
    estimatedOutputTokens: 1500,
  }),

  // 13-15: TOOL_USE
  makeTask({
    id: 'router-tool-13-json-schema-migration',
    name: 'Batch JSON Config Schema Normalization',
    category: 'TOOL_USE',
    difficulty: 'easy',
    description: 'Normalize 8 environment JSON files to include schemaVersion: 2.',
    prompt: 'Update config/env.summary.json with normalized SHA-256 digests of all environment files.',
    expectedFiles: ['config/env.summary.json'],
    requiredEvidence: ['TEST'],
    estimatedInputTokens: 1800,
    estimatedOutputTokens: 500,
  }),
  makeTask({
    id: 'router-tool-14-multi-file-ast-codemod',
    name: 'Execute Deterministic Multi-File Codemod',
    category: 'TOOL_USE',
    difficulty: 'medium',
    description: 'Use structured file and search tools to replace legacy assert calls across modules.',
    prompt: 'Migrate assertions in src/validators.ts and record tool audit in artifacts/codemod.json.',
    expectedFiles: ['src/validators.ts', 'artifacts/codemod.json'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 4200,
    estimatedOutputTokens: 850,
  }),
  makeTask({
    id: 'router-tool-15-sandboxed-pipeline-verification',
    name: 'Orchestrate Multi-Step Verification Pipeline',
    category: 'TOOL_USE',
    difficulty: 'hard',
    description: 'Run build, typecheck, and fixture validation tools while respecting protected file policy.',
    prompt: 'Execute pipeline verification and write verified manifest to artifacts/pipeline-manifest.json.',
    expectedFiles: ['artifacts/pipeline-manifest.json'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 7600,
    estimatedOutputTokens: 1400,
  }),

  // 16-18: CONTEXT_STRESS
  makeTask({
    id: 'router-stress-16-log-deduplication',
    name: 'Summarize High-Volume Build Log Diagnostics',
    category: 'CONTEXT_STRESS',
    difficulty: 'easy',
    description: 'Extract unique compiler errors from repetitive 50k-token build output.',
    prompt: 'Write deduplicated compiler error signatures to reports/error-digest.json.',
    expectedFiles: ['reports/error-digest.json'],
    requiredEvidence: ['TEST'],
    estimatedInputTokens: 12000,
    estimatedOutputTokens: 600,
  }),
  makeTask({
    id: 'router-stress-17-multi-module-refactor-compaction',
    name: 'Multi-Module Refactor Under Context Compaction',
    category: 'CONTEXT_STRESS',
    difficulty: 'medium',
    description: 'Refactor shared telemetry payload across 15 modules without losing invariant constraints.',
    prompt: 'Update src/telemetryIndex.ts to consolidate payload types within token budget.',
    expectedFiles: ['src/telemetryIndex.ts'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 18000,
    estimatedOutputTokens: 1100,
  }),
  makeTask({
    id: 'router-stress-18-deep-history-state-reconciliation',
    name: 'Reconcile State Across 100+ Historical Events',
    category: 'CONTEXT_STRESS',
    difficulty: 'hard',
    description: 'Maintain exact state invariants across a long execution trace with superseded snapshots.',
    prompt: 'Reconcile final state ledger in src/reconciledLedger.ts and pass all invariant checks.',
    expectedFiles: ['src/reconciledLedger.ts'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 26000,
    estimatedOutputTokens: 1800,
  }),

  // 19-21: RECOVERY
  makeTask({
    id: 'router-recovery-19-syntax-rollback',
    name: 'Recover From Broken Syntax Edit',
    category: 'RECOVERY',
    difficulty: 'easy',
    description: 'Detect syntax error introduced in prior turn and restore clean compilation.',
    prompt: 'Fix the malformed syntax in src/parser.ts so build and tests pass.',
    expectedFiles: ['src/parser.ts'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 1600,
    estimatedOutputTokens: 450,
  }),
  makeTask({
    id: 'router-recovery-20-stale-verification-repair',
    name: 'Recover From Stale Verification After Mutation',
    category: 'RECOVERY',
    difficulty: 'medium',
    description: 'Re-run verification after post-check file mutation and repair failing assertion.',
    prompt: 'Fix regression in src/checkpoint.ts and ensure fresh verification at latest workspace revision.',
    expectedFiles: ['src/checkpoint.ts'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 4400,
    estimatedOutputTokens: 900,
  }),
  makeTask({
    id: 'router-recovery-21-cross-harness-interrupted-handoff',
    name: 'Resume Interrupted Execution After Side-Effect Reconciliation',
    category: 'RECOVERY',
    difficulty: 'hard',
    description: 'Reconcile uncertain tool side effect from interrupted harness and complete verification.',
    prompt: 'Reconcile partial write in src/handoffState.ts and complete verified build and test checks.',
    expectedFiles: ['src/handoffState.ts'],
    requiredEvidence: ['BUILD', 'TEST'],
    estimatedInputTokens: 7800,
    estimatedOutputTokens: 1650,
  }),
] as const;

export const DEFAULT_ROUTER_CANDIDATE_POOL: readonly RouterCandidateSpec[] = [
  {
    candidateId: 'local-small-uncalibrated',
    harnessId: 'native',
    modelId: 'qwen2.5-coder-7b',
    runtimeId: 'local-ollama',
    capabilityScore: 0.72,
    verifiedSuccessRate: 0.48,
    sampleCount: 40,
    uncertainty: 0.08,
    costPer1kInputUsd: 0,
    costPer1kOutputUsd: 0,
    expectedVerificationCostUsd: 0.0005,
    expectedRetryCostUsd: 0.002,
    expectedColdStartCostUsd: 0,
    baseLatencyMs: 620,
    coldStartLatencyMs: 1200,
    residency: 'ready',
    kvCacheFits: true,
    requiredVramGb: 8,
    isLocal: true,
    available: true,
  },
  {
    candidateId: 'cloud-static-heavy',
    harnessId: 'acp-claude',
    modelId: 'claude-3-7-sonnet',
    runtimeId: 'cloud-anthropic',
    capabilityScore: 0.96,
    verifiedSuccessRate: 0.86,
    sampleCount: 65,
    uncertainty: 0.04,
    costPer1kInputUsd: 0.003,
    costPer1kOutputUsd: 0.015,
    expectedVerificationCostUsd: 0.001,
    expectedRetryCostUsd: 0.004,
    expectedColdStartCostUsd: 0,
    baseLatencyMs: 1850,
    coldStartLatencyMs: 0,
    residency: 'ready',
    kvCacheFits: true,
    requiredVramGb: 0,
    isLocal: false,
    available: true,
  },
  {
    candidateId: 'outcome-calibrated-mid',
    harnessId: 'native',
    modelId: 'gpt-4.1-mini-calibrated',
    runtimeId: 'cloud-openai',
    capabilityScore: 0.89,
    verifiedSuccessRate: 0.91,
    sampleCount: 80,
    uncertainty: 0.03,
    costPer1kInputUsd: 0.0008,
    costPer1kOutputUsd: 0.0032,
    expectedVerificationCostUsd: 0.0005,
    expectedRetryCostUsd: 0.001,
    expectedColdStartCostUsd: 0,
    baseLatencyMs: 920,
    coldStartLatencyMs: 0,
    residency: 'ready',
    kvCacheFits: true,
    requiredVramGb: 0,
    isLocal: false,
    available: true,
  },
  {
    candidateId: 'local-32b-verified',
    harnessId: 'native',
    modelId: 'qwen2.5-coder-32b',
    runtimeId: 'local-vllm',
    capabilityScore: 0.88,
    verifiedSuccessRate: 0.88,
    sampleCount: 55,
    uncertainty: 0.04,
    costPer1kInputUsd: 0,
    costPer1kOutputUsd: 0,
    expectedVerificationCostUsd: 0.0004,
    expectedRetryCostUsd: 0.0008,
    expectedColdStartCostUsd: 0.0002,
    baseLatencyMs: 840,
    coldStartLatencyMs: 300,
    residency: 'ready',
    kvCacheFits: true,
    requiredVramGb: 20,
    isLocal: true,
    available: true,
  },
] as const;

export function filterEligibleCandidates(
  task: RouterBenchmarkTask,
  candidates: readonly RouterCandidateSpec[],
  environment: RouterEnvironmentState,
): { eligible: RouterCandidateSpec[]; reasons: string[] } {
  const reasons: string[] = [];
  const eligibility = task.hardwareEligibility;

  if (eligibility.requiresGpu && !environment.hasGpu) {
    return {
      eligible: [],
      reasons: ['HARDWARE_UNAVAILABLE: Task requires GPU but environment has no GPU'],
    };
  }

  if (
    eligibility.minAvailableVramGb !== undefined &&
    environment.availableVramGb < eligibility.minAvailableVramGb
  ) {
    return {
      eligible: [],
      reasons: [
        `HARDWARE_UNAVAILABLE: Task requires ${eligibility.minAvailableVramGb}GB VRAM but only ${environment.availableVramGb}GB is available`,
      ],
    };
  }

  const eligible: RouterCandidateSpec[] = [];
  for (const cand of candidates) {
    if (cand.available === false) {
      reasons.push(`Candidate ${cand.modelId}@${cand.runtimeId} is marked unavailable`);
      continue;
    }
    if (!environment.availableRuntimeIds.includes(cand.runtimeId)) {
      reasons.push(`Runtime ${cand.runtimeId} is not available in environment`);
      continue;
    }
    if (!environment.availableHarnessIds.includes(cand.harnessId)) {
      reasons.push(`Harness ${cand.harnessId} is not available in environment`);
      continue;
    }
    if (
      eligibility.allowedRuntimeIds &&
      eligibility.allowedRuntimeIds.length > 0 &&
      !eligibility.allowedRuntimeIds.includes(cand.runtimeId)
    ) {
      reasons.push(`Runtime ${cand.runtimeId} excluded by task hardwareEligibility`);
      continue;
    }
    if (
      eligibility.allowedHarnessIds &&
      eligibility.allowedHarnessIds.length > 0 &&
      !eligibility.allowedHarnessIds.includes(cand.harnessId)
    ) {
      reasons.push(`Harness ${cand.harnessId} excluded by task hardwareEligibility`);
      continue;
    }
    if (cand.kvCacheFits === false) {
      reasons.push(`Candidate ${cand.modelId} KV cache does not fit on target hardware`);
      continue;
    }
    if (cand.requiredVramGb !== undefined && cand.requiredVramGb > environment.availableVramGb) {
      reasons.push(
        `Candidate ${cand.modelId} requires ${cand.requiredVramGb}GB VRAM (> ${environment.availableVramGb}GB)`,
      );
      continue;
    }
    if (cand.isLocal && (environment.allowLocal === false || eligibility.allowLocal === false)) {
      reasons.push(`Local candidate ${cand.modelId} disallowed by policy`);
      continue;
    }
    if (!cand.isLocal && (environment.allowRemotePaid === false || eligibility.allowRemotePaid === false)) {
      reasons.push(`Remote candidate ${cand.modelId} disallowed by policy`);
      continue;
    }
    eligible.push(cand);
  }

  return { eligible, reasons };
}

/**
 * Baseline router policy: static / capability-only / uncalibrated default routing.
 * Selects purely by static capabilityScore (or cheapest uncalibrated local candidate on easy tasks)
 * without consulting empirical verifiedSuccessRate or retry/verification cost telemetry.
 */
export function createBaselineStaticRouterPolicy(
  id = 'baseline-static-router',
  name = 'Baseline Static Capability Router',
): RouterBenchmarkPolicy {
  return {
    id,
    name,
    version: '1.0.0',
    selectRoute(task, candidates, environment): RouterPolicyDecision {
      const { eligible, reasons } = filterEligibleCandidates(task, candidates, environment);
      if (eligible.length === 0) {
        return {
          blockedReason: reasons[0] ?? 'NO_ELIGIBLE_CANDIDATES: No available runtime/hardware candidate',
          rationale: reasons,
        };
      }

      // Uncalibrated static routing: picks local-small on easy/medium if present, else highest static capabilityScore
      const sorted = [...eligible].sort((a, b) => {
        if (task.difficulty !== 'hard' && a.isLocal !== b.isLocal) {
          return a.isLocal ? -1 : 1;
        }
        return b.capabilityScore - a.capabilityScore;
      });

      const primary = sorted[0];
      const fallbacks = sorted.slice(1);
      return {
        selectedCandidate: primary,
        fallbackCandidates: fallbacks,
        rationale: [
          `Static policy selected ${primary.modelId}@${primary.runtimeId} (capabilityScore=${primary.capabilityScore.toFixed(2)}, uncalibrated)`,
        ],
      };
    },
  };
}

/**
 * Candidate outcome-qualified router policy: ranks eligible candidates by empirical
 * verified success probability, expected total cost per verified completion (including
 * verification, retry, and cold-start overhead), and latency penalties.
 */
export function createOutcomeQualifiedRouterPolicy(
  id = 'candidate-outcome-qualified-router',
  name = 'Candidate Outcome-Qualified Router',
  options?: { minVerifiedSuccessProb?: number },
): RouterBenchmarkPolicy {
  const minVerifiedFloor = options?.minVerifiedSuccessProb ?? 0.75;

  return {
    id,
    name,
    version: '1.0.0',
    selectRoute(task, candidates, environment): RouterPolicyDecision {
      const { eligible, reasons } = filterEligibleCandidates(task, candidates, environment);
      if (eligible.length === 0) {
        return {
          blockedReason: reasons[0] ?? 'NO_ELIGIBLE_CANDIDATES: No available runtime/hardware candidate',
          rationale: reasons,
        };
      }

      const difficultyMinFloor =
        task.difficulty === 'hard'
          ? Math.max(minVerifiedFloor, 0.85)
          : task.difficulty === 'medium'
            ? Math.max(minVerifiedFloor, 0.78)
            : minVerifiedFloor;

      const scoreCandidate = (cand: RouterCandidateSpec) => {
        const catRate = cand.categorySuccessRates?.[task.category];
        const rawSuccessProb = catRate ?? cand.verifiedSuccessRate ?? cand.capabilityScore * 0.8;
        // Penalize high uncertainty (conservative lower bound)
        const uncertaintyPenalty = (cand.uncertainty ?? 0.05) * 0.5;
        const predictedVerifiedProb = Math.max(0.05, Math.min(1, rawSuccessProb - uncertaintyPenalty));

        const callCostUsd =
          (task.estimatedInputTokens / 1000) * cand.costPer1kInputUsd +
          (task.estimatedOutputTokens / 1000) * cand.costPer1kOutputUsd;
        const overheadUsd =
          (cand.expectedVerificationCostUsd ?? 0) +
          (cand.expectedRetryCostUsd ?? 0) * (1 - predictedVerifiedProb) +
          (cand.residency && cand.residency !== 'ready' ? (cand.expectedColdStartCostUsd ?? 0) : 0);
        const expectedCostPerVerifiedSuccess = (callCostUsd + overheadUsd) / predictedVerifiedProb;

        const expectedLatencyMs =
          cand.baseLatencyMs +
          (cand.residency && cand.residency !== 'ready' ? (cand.coldStartLatencyMs ?? 1500) : 0);

        const meetsFloor = predictedVerifiedProb >= difficultyMinFloor;
        // Utility balances high verified success probability, low effective cost, and low latency
        const utility =
          predictedVerifiedProb * 2.5 -
          expectedCostPerVerifiedSuccess * 8.0 -
          (expectedLatencyMs / 10_000) * 0.4 +
          (meetsFloor ? 1.0 : -1.5);

        return {
          cand,
          predictedVerifiedProb,
          expectedCostPerVerifiedSuccess,
          expectedLatencyMs,
          meetsFloor,
          utility,
        };
      };

      const scored = eligible.map(scoreCandidate).sort((a, b) => b.utility - a.utility);
      const best = scored[0];

      return {
        selectedCandidate: best.cand,
        fallbackCandidates: scored.slice(1).map((s) => s.cand),
        rationale: [
          `Outcome-qualified policy selected ${best.cand.modelId}@${best.cand.runtimeId} ` +
            `(predictedVerifiedProb=${best.predictedVerifiedProb.toFixed(2)}, ` +
            `expectedCostPerSuccess=$${best.expectedCostPerVerifiedSuccess.toFixed(4)}, ` +
            `expectedLatency=${Math.round(best.expectedLatencyMs)}ms)`,
        ],
      };
    },
  };
}

function computeStableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function computePercentile(sortedValues: readonly number[], percentile: number): number {
  if (sortedValues.length === 0) return Number.NaN;
  if (sortedValues.length === 1) return sortedValues[0];
  const clamped = Math.max(0, Math.min(100, percentile));
  const index = (clamped / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

const STUDENT_T_95: readonly number[] = [
  0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
  2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093,
  2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];

function getStudentT95(df: number): number {
  if (df <= 0) return Number.NaN;
  if (df < STUDENT_T_95.length) return STUDENT_T_95[df];
  return 1.96;
}

/**
 * Computes sample count, mean, variance, standard deviation, standard error,
 * 95% confidence interval (Wilson interval for proportions when isProportion=true,
 * Student-t interval otherwise), p50, p95, min, and max.
 */
export function computeMetricStatistics(
  values: readonly number[],
  options?: { isProportion?: boolean },
): MetricStatisticalSummary {
  const finite = values.filter((v) => Number.isFinite(v));
  const sampleCount = finite.length;
  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      mean: Number.NaN,
      variance: Number.NaN,
      stdDev: Number.NaN,
      standardError: Number.NaN,
      confidenceInterval95: [Number.NaN, Number.NaN],
      p50: Number.NaN,
      p95: Number.NaN,
      min: Number.NaN,
      max: Number.NaN,
    };
  }

  const sorted = [...finite].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sampleCount;
  const variance =
    sampleCount > 1
      ? sorted.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (sampleCount - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const standardError = sampleCount > 0 ? stdDev / Math.sqrt(sampleCount) : Number.NaN;

  let confidenceInterval95: [number, number];
  if (options?.isProportion && mean >= 0 && mean <= 1) {
    // Wilson score 95% interval for binomial proportions, clamped to [0, 1]
    const z = 1.95996;
    const z2 = z * z;
    const denom = 1 + z2 / sampleCount;
    const center = (mean + z2 / (2 * sampleCount)) / denom;
    const halfWidth =
      (z * Math.sqrt((mean * (1 - mean)) / sampleCount + z2 / (4 * sampleCount * sampleCount))) /
      denom;
    confidenceInterval95 = [
      Math.max(0, Number((center - halfWidth).toFixed(6))),
      Math.min(1, Number((center + halfWidth).toFixed(6))),
    ];
  } else if (sampleCount > 1) {
    const tCrit = getStudentT95(sampleCount - 1);
    const margin = tCrit * standardError;
    confidenceInterval95 = [
      Number((mean - margin).toFixed(6)),
      Number((mean + margin).toFixed(6)),
    ];
  } else {
    confidenceInterval95 = [mean, mean];
  }

  return {
    sampleCount,
    mean: Number(mean.toFixed(6)),
    variance: Number(variance.toFixed(6)),
    stdDev: Number(stdDev.toFixed(6)),
    standardError: Number(standardError.toFixed(6)),
    confidenceInterval95,
    p50: Number(computePercentile(sorted, 50).toFixed(6)),
    p95: Number(computePercentile(sorted, 95).toFixed(6)),
    min: Number(sorted[0].toFixed(6)),
    max: Number(sorted[sampleCount - 1].toFixed(6)),
  };
}

export function intervalsOverlap(a: [number, number], b: [number, number]): boolean {
  if (!Number.isFinite(a[0]) || !Number.isFinite(a[1]) || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) {
    return true;
  }
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Deterministic default task execution simulator used when a test or caller does not
 * inject a custom `taskExecutor` or `policy.executeTask`. Produces a full `ExecutionRecord`
 * that is then authoritatively scored by `EvaluationService.evaluate()`.
 */
function defaultDeterministicTaskExecutor(params: {
  task: RouterBenchmarkTask;
  policy: RouterBenchmarkPolicy;
  decision: RouterPolicyDecision;
  repetition: number;
  environment: RouterEnvironmentState;
  budget: RouterBenchmarkExecutionBudget;
}): RouterTaskExecutionOutcome {
  const { task, policy, decision, repetition, budget } = params;
  if (decision.blockedReason || !decision.selectedCandidate) {
    return {
      status: 'BLOCKED',
      blockedReason: decision.blockedReason ?? 'NO_CANDIDATE_SELECTED',
      rationale: decision.rationale,
    };
  }

  const cand = decision.selectedCandidate;
  const seedHash = createHash('sha256')
    .update(`${task.id}:${cand.modelId}:${cand.runtimeId}:${repetition}`)
    .digest();
  const unitDraw = seedHash.readUInt16BE(0) / 65535;

  const baseSuccessProb =
    cand.categorySuccessRates?.[task.category] ??
    cand.verifiedSuccessRate ??
    cand.capabilityScore * 0.75;
  const difficultyPenalty =
    task.difficulty === 'hard' ? 0.12 : task.difficulty === 'medium' ? 0.04 : 0;
  const effectiveProb = Math.max(0.05, Math.min(0.99, baseSuccessProb - difficultyPenalty));

  let firstAttemptSuccess = unitDraw <= effectiveProb;
  let retryCount = 0;
  let fallbackUsed = false;
  let activeCandidate = cand;

  if (!firstAttemptSuccess && (budget.maxRetries ?? 1) > 0) {
    retryCount = 1;
    const retryDraw = seedHash.readUInt16BE(2) / 65535;
    if (decision.fallbackCandidates && decision.fallbackCandidates.length > 0 && effectiveProb < 0.65) {
      fallbackUsed = true;
      activeCandidate = decision.fallbackCandidates[0];
    }
    const retryProb = Math.max(
      0.1,
      Math.min(0.98, (activeCandidate.verifiedSuccessRate ?? activeCandidate.capabilityScore) - difficultyPenalty * 0.5),
    );
    firstAttemptSuccess = retryDraw <= retryProb;
  }

  const multiplier = 1 + retryCount * 0.65;
  const inputTokens = Math.round(task.estimatedInputTokens * multiplier);
  const outputTokens = Math.round(task.estimatedOutputTokens * multiplier);
  const callCostUsd =
    (inputTokens / 1000) * activeCandidate.costPer1kInputUsd +
    (outputTokens / 1000) * activeCandidate.costPer1kOutputUsd;
  const totalCostUsd = Number(
    (
      callCostUsd +
      (activeCandidate.expectedVerificationCostUsd ?? 0) +
      (retryCount > 0 ? (activeCandidate.expectedRetryCostUsd ?? 0) : 0)
    ).toFixed(6),
  );

  const latencyJitter = (seedHash.readUInt8(4) / 255) * 140;
  const coldStartMs =
    activeCandidate.residency && activeCandidate.residency !== 'ready'
      ? (activeCandidate.coldStartLatencyMs ?? 800)
      : 0;
  const endToEndLatencyMs = Math.round(
    activeCandidate.baseLatencyMs * multiplier + coldStartMs + latencyJitter,
  );

  const policyViolationReasons: string[] = [];
  if (totalCostUsd > budget.maxMonetaryCostUSD) {
    policyViolationReasons.push(
      `BUDGET_COST_EXCEEDED: $${totalCostUsd.toFixed(4)} > $${budget.maxMonetaryCostUSD.toFixed(4)}`,
    );
  }
  if (inputTokens + outputTokens > budget.maxTokens) {
    policyViolationReasons.push(
      `BUDGET_TOKENS_EXCEEDED: ${inputTokens + outputTokens} > ${budget.maxTokens}`,
    );
  }
  if (endToEndLatencyMs > budget.maxWallTimeMs) {
    policyViolationReasons.push(
      `BUDGET_WALL_TIME_EXCEEDED: ${endToEndLatencyMs}ms > ${budget.maxWallTimeMs}ms`,
    );
  }

  const requiredEvidence = task.acceptanceContract?.requiredEvidence ?? ['TEST'];
  const checks = requiredEvidence.map((evType) => ({
    name: evType === 'BUILD' ? 'build' : evType === 'TEST' ? 'test' : 'lint',
    command: `wazir verify ${evType.toLowerCase()}`,
    ok: firstAttemptSuccess && policyViolationReasons.length === 0,
    durationMs: 45,
    output: firstAttemptSuccess ? `${evType} passed` : `${evType} failed assertion`,
  }));

  const evidence = requiredEvidence.map((evType, idx) => ({
    id: `ev-${task.id}-${policy.id}-${repetition}-${idx}`,
    type: evType,
    revision: 1,
    command: `wazir verify ${evType.toLowerCase()}`,
    exitCode: firstAttemptSuccess && policyViolationReasons.length === 0 ? 0 : 1,
    durationMs: 45,
    output: firstAttemptSuccess ? `${evType} passed` : `${evType} failed assertion`,
  }));

  const now = new Date();
  const startedAt = new Date(now.getTime() - endToEndLatencyMs);

  const record: ExecutionRecord = {
    execution: {
      id: `exec-${policy.id}-${task.id}-rep${repetition}`,
      taskId: task.id,
      runtimeId: activeCandidate.runtimeId,
      modelId: activeCandidate.modelId,
      status: 'completed', // Even on failure, model may claim completed; EvaluationService enforces physical verification
      startedAt,
      createdAt: startedAt,
      completedAt: now,
    },
    task: {
      id: task.id,
      type: 'benchmark',
      title: task.name,
      input: task.prompt,
      requirements: {},
      priority: 'normal',
      status: firstAttemptSuccess ? 'completed' : 'failed',
      createdAt: startedAt,
      acceptanceContract: task.acceptanceContract,
    },
    workspaceState: {
      root: `/tmp/wazir-router-bench/${task.id}`,
      revision: 1,
      dirty: true,
      filesChanged: task.expectedFiles ?? [],
    },
    acceptanceContract: task.acceptanceContract,
    policyDecisions: policyViolationReasons.map((reason) => ({
      action: 'route.execution',
      allowed: false,
      reason,
      at: now,
    })),
    toolCalls: [
      {
        tool: 'edit_file',
        input: { files: task.expectedFiles ?? [] },
        output: 'applied',
        ok: true,
        durationMs: 30,
        at: startedAt,
      },
    ],
    filesChanged: task.expectedFiles ? [...task.expectedFiles] : ['src/index.ts'],
    checks,
    evidence,
    errors: firstAttemptSuccess && policyViolationReasons.length === 0 ? [] : ['Verification check failed'],
    events: retryCount > 0 ? [{ type: 'retry.scheduled', timestamp: now, data: { retryCount } }] : [],
    totalModelCalls: 1 + retryCount,
    usage: {
      input: inputTokens,
      output: outputTokens,
    },
  };

  return {
    status: 'COMPLETED',
    selectedHarnessId: activeCandidate.harnessId,
    selectedModelId: activeCandidate.modelId,
    selectedRuntimeId: activeCandidate.runtimeId,
    record,
    retryCount,
    fallbackUsed,
    policyViolation: policyViolationReasons.length > 0,
    policyViolationReasons,
    costUsd: totalCostUsd,
    costStatus: activeCandidate.isLocal ? 'ACTUAL' : 'ESTIMATED',
    endToEndLatencyMs,
    rationale: decision.rationale,
  };
}

export class ComparativeRouterBenchmark {
  constructor(
    private readonly evaluationService: EvaluationService = new EvaluationService(),
  ) {}

  /**
   * Returns a defensive copy of the canonical router benchmark task suite (>= 20 tasks).
   */
  public getCanonicalTasks(): RouterBenchmarkTask[] {
    return CANONICAL_ROUTER_BENCHMARK_TASKS.map((t) => structuredClone(t));
  }

  /**
   * Validates that the task suite spans all required categories and difficulty levels
   * and has at least 20 independently specified tasks.
   */
  public validateTaskSuite(tasks: readonly RouterBenchmarkTask[]): {
    valid: boolean;
    issues: string[];
  } {
    const issues: string[] = [];
    if (tasks.length < 20) {
      issues.push(
        `INSUFFICIENT_TASK_COUNT: Expected at least 20 tasks, received ${tasks.length}`,
      );
    }

    const ids = new Set<string>();
    const categoriesSeen = new Set<BenchmarkTaskCategory>();
    const difficultiesSeen = new Set<RouterBenchmarkDifficulty>();

    for (const task of tasks) {
      if (ids.has(task.id)) {
        issues.push(`DUPLICATE_TASK_ID: '${task.id}' appears multiple times`);
      }
      ids.add(task.id);
      categoriesSeen.add(task.category);
      difficultiesSeen.add(task.difficulty);
    }

    for (const category of BENCHMARK_CATEGORIES) {
      if (!categoriesSeen.has(category)) {
        issues.push(`MISSING_CATEGORY: Task suite is missing category '${category}'`);
      }
    }

    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      if (!difficultiesSeen.has(difficulty)) {
        issues.push(`MISSING_DIFFICULTY: Task suite is missing difficulty '${difficulty}'`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * Runs a matched comparative benchmark between a baseline router policy and a candidate
   * outcome-qualified router policy across the task suite.
   */
  public async runComparativeBenchmark(
    baselinePolicy: RouterBenchmarkPolicy = createBaselineStaticRouterPolicy(),
    candidatePolicy: RouterBenchmarkPolicy = createOutcomeQualifiedRouterPolicy(),
    options: ComparativeRouterBenchmarkOptions = {},
  ): Promise<ComparativeRouterBenchmarkResult> {
    const tasks = options.tasks ?? CANONICAL_ROUTER_BENCHMARK_TASKS;
    if (tasks.length === 0) {
      throw new Error('EMPTY_ROUTER_BENCHMARK_SUITE: Task list cannot be empty');
    }

    const uniqueIds = new Set(tasks.map((t) => t.id));
    if (uniqueIds.size !== tasks.length) {
      throw new Error('DUPLICATE_ROUTER_BENCHMARK_TASK_ID: All task IDs in suite must be unique');
    }

    const repetitions = options.repetitions ?? 1;
    if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) {
      throw new Error('INVALID_REPETITIONS: repetitions must be an integer between 1 and 100');
    }

    const baselineEnvironment: RouterEnvironmentState = {
      ...DEFAULT_ENVIRONMENT,
      ...options.environment,
    };
    const candidateEnvironment: RouterEnvironmentState = {
      ...baselineEnvironment,
      ...options.candidateEnvironmentOverride,
    };

    const candidateTasks = options.candidateTasksOverride ?? tasks;

    // Enforce matched conditions across baseline and candidate runs
    const baselineTaskSuiteHash = computeStableHash(tasks);
    const candidateTaskSuiteHash = computeStableHash(candidateTasks);
    if (baselineTaskSuiteHash !== candidateTaskSuiteHash) {
      throw new Error(
        'MATCHED_CONDITIONS_VIOLATION: Baseline and candidate task definitions must be identical',
      );
    }

    const baselineEnvHash = computeStableHash(baselineEnvironment);
    const candidateEnvHash = computeStableHash(candidateEnvironment);
    if (baselineEnvHash !== candidateEnvHash) {
      throw new Error(
        'MATCHED_CONDITIONS_VIOLATION: Baseline and candidate hardware eligibility / environment state must be identical',
      );
    }

    const baselineBudgets = tasks.map((t) => t.executionBudget);
    const candidateBudgets = candidateTasks.map((t) => ({
      ...t.executionBudget,
      ...options.candidateBudgetOverride,
    }));
    const baselineBudgetHash = computeStableHash(baselineBudgets);
    const candidateBudgetHash = computeStableHash(candidateBudgets);
    if (baselineBudgetHash !== candidateBudgetHash) {
      throw new Error(
        'MATCHED_CONDITIONS_VIOLATION: Baseline and candidate execution budgets must be identical',
      );
    }

    const candidatesPool = options.candidates ?? DEFAULT_ROUTER_CANDIDATE_POOL;

    const baselineSummary = await this.evaluatePolicySuite({
      policy: baselinePolicy,
      tasks,
      candidates: candidatesPool,
      environment: baselineEnvironment,
      repetitions,
      evaluationOptions: options.evaluationOptions,
      taskExecutor: options.taskExecutor,
    });

    const candidateSummary = await this.evaluatePolicySuite({
      policy: candidatePolicy,
      tasks,
      candidates: candidatesPool,
      environment: candidateEnvironment,
      repetitions,
      evaluationOptions: options.evaluationOptions,
      taskExecutor: options.taskExecutor,
    });

    const deltas = {
      verified_success_rate: Number(
        (candidateSummary.verified_success_rate - baselineSummary.verified_success_rate).toFixed(6),
      ),
      cost_per_verified_success: Number(
        (
          candidateSummary.cost_per_verified_success - baselineSummary.cost_per_verified_success
        ).toFixed(6),
      ),
      end_to_end_latency_p50: Number(
        (candidateSummary.end_to_end_latency_p50 - baselineSummary.end_to_end_latency_p50).toFixed(6),
      ),
      end_to_end_latency_p95: Number(
        (candidateSummary.end_to_end_latency_p95 - baselineSummary.end_to_end_latency_p95).toFixed(6),
      ),
      retry_rate: Number((candidateSummary.retry_rate - baselineSummary.retry_rate).toFixed(6)),
      fallback_rate: Number(
        (candidateSummary.fallback_rate - baselineSummary.fallback_rate).toFixed(6),
      ),
      policy_violation_rate: Number(
        (candidateSummary.policy_violation_rate - baselineSummary.policy_violation_rate).toFixed(6),
      ),
    };

    const alpha = options.alpha ?? 0.05;
    const metricComparisons = this.buildMetricComparisons(
      baselineSummary,
      candidateSummary,
      deltas,
      alpha,
    );

    const { verdict, improvements, regressions, inconclusiveReasons, honestAssessment } =
      this.determineHonestVerdict(
        baselineSummary,
        candidateSummary,
        deltas,
        metricComparisons,
        alpha,
      );

    const matchedConditions: MatchedConditionsManifest = {
      enforced: true,
      taskCount: tasks.length,
      repetitions,
      taskSuiteHash: baselineTaskSuiteHash,
      environmentHash: baselineEnvHash,
      budgetHash: baselineBudgetHash,
    };

    const benchmarkId = options.benchmarkId ?? `router-bench-${Date.now()}`;
    const summary = this.formatSummaryText(
      benchmarkId,
      baselineSummary,
      candidateSummary,
      deltas,
      verdict,
      honestAssessment,
    );

    return {
      benchmarkId,
      executedAt: new Date().toISOString(),
      matchedConditions,
      baseline: baselineSummary,
      candidate: candidateSummary,
      deltas,
      metricComparisons,
      verdict,
      improvements,
      regressions,
      inconclusiveReasons,
      honestAssessment,
      summary,
    };
  }

  public toMarkdownReport(result: ComparativeRouterBenchmarkResult): string {
    return toMarkdownReport(result);
  }

  public toJsonReport(result: ComparativeRouterBenchmarkResult): string {
    return toJsonReport(result);
  }

  private async evaluatePolicySuite(params: {
    policy: RouterBenchmarkPolicy;
    tasks: readonly RouterBenchmarkTask[];
    candidates: readonly RouterCandidateSpec[];
    environment: RouterEnvironmentState;
    repetitions: number;
    evaluationOptions?: EvaluationServiceOptions;
    taskExecutor?: ComparativeRouterBenchmarkOptions['taskExecutor'];
  }): Promise<RouterPolicyBenchmarkSummary> {
    const { policy, tasks, candidates, environment, repetitions, evaluationOptions, taskExecutor } =
      params;

    const allEvaluations: RouterTaskEvaluationResult[] = [];

    for (let repetition = 0; repetition < repetitions; repetition++) {
      for (const rawTask of tasks) {
        const task = structuredClone(rawTask);
        const taskDefinitionHash = computeStableHash(task);
        const budget = structuredClone(task.executionBudget);
        const envSnapshot = structuredClone(environment);

        const decision: RouterPolicyDecision = policy.selectRoute
          ? policy.selectRoute(task, candidates, envSnapshot)
          : {
              selectedCandidate: candidates[0],
              rationale: ['Default first candidate'],
            };

        let outcome: RouterTaskExecutionOutcome;
        if (decision.blockedReason) {
          outcome = {
            status: 'BLOCKED',
            blockedReason: decision.blockedReason,
            rationale: decision.rationale,
          };
        } else if (policy.executeTask) {
          outcome = await policy.executeTask(task, {
            repetition,
            environment: envSnapshot,
            budget,
            candidates,
            decision,
          });
        } else if (taskExecutor) {
          outcome = await taskExecutor({
            task,
            policy,
            decision,
            repetition,
            environment: envSnapshot,
            budget,
          });
        } else {
          outcome = defaultDeterministicTaskExecutor({
            task,
            policy,
            decision,
            repetition,
            environment: envSnapshot,
            budget,
          });
        }

        if (outcome.status === 'BLOCKED' || !outcome.record) {
          allEvaluations.push({
            taskId: task.id,
            taskName: task.name,
            category: task.category,
            difficulty: task.difficulty,
            repetition,
            policyId: policy.id,
            taskDefinitionHash,
            status: 'BLOCKED',
            blockedReason:
              outcome.blockedReason ?? decision.blockedReason ?? 'RUNTIME_OR_HARDWARE_BLOCKED',
            selectedHarnessId: outcome.selectedHarnessId ?? decision.selectedCandidate?.harnessId,
            selectedModelId: outcome.selectedModelId ?? decision.selectedCandidate?.modelId,
            selectedRuntimeId: outcome.selectedRuntimeId ?? decision.selectedCandidate?.runtimeId,
            verified: false,
            apparentCompletion: false,
            costUsd: 0,
            costStatus: 'ACTUAL',
            endToEndLatencyMs: 0,
            retryCount: 0,
            retried: false,
            fallbackUsed: false,
            policyViolation: false,
            policyViolationReasons: [],
            rationale: outcome.rationale ?? decision.rationale ?? [],
          });
          continue;
        }

        // Score completed execution via EvaluationService (enforces physical verification invariant)
        const scoreReport = this.evaluationService.evaluate(outcome.record, {
          ...evaluationOptions,
          expectedFiles: task.expectedFiles,
          expectedEvidence: task.expectedEvidence,
          protectedFiles: task.protectedFiles,
          mutationRequired: task.mutationRequired ?? true,
          acceptanceContract: task.acceptanceContract,
          category: task.category,
          taskId: task.id,
          requirePhysicalVerification: true,
        });

        const apparentCompletion = outcome.record.execution?.status === 'completed';
        const verified =
          scoreReport.passed &&
          scoreReport.metrics.taskSuccess &&
          scoreReport.metrics.physicalVerificationSuccess;

        const retryCount = outcome.retryCount ?? scoreReport.metrics.repairCycles ?? 0;
        const retried = retryCount > 0;
        const fallbackUsed = Boolean(outcome.fallbackUsed);

        const deniedDecisions = (outcome.record.policyDecisions ?? [])
          .filter((d) => !d.allowed)
          .map((d) => d.reason ?? 'Policy denied action');
        const protectedModified = Boolean(
          scoreReport.metrics.rawMetrics?.protectedFixtureModified ||
            scoreReport.rejectionReason?.startsWith('PROTECTED_FIXTURE_MODIFIED'),
        );
        const policyViolationReasons = [
          ...(outcome.policyViolationReasons ?? []),
          ...deniedDecisions,
          ...(protectedModified ? ['PROTECTED_FIXTURE_MODIFIED'] : []),
        ];
        const policyViolation =
          Boolean(outcome.policyViolation) || policyViolationReasons.length > 0;

        const costUsd =
          typeof outcome.costUsd === 'number' && Number.isFinite(outcome.costUsd)
            ? outcome.costUsd
            : scoreReport.metrics.costEstimateUsd;
        const endToEndLatencyMs =
          typeof outcome.endToEndLatencyMs === 'number' && outcome.endToEndLatencyMs > 0
            ? outcome.endToEndLatencyMs
            : scoreReport.metrics.totalWallTimeMs;

        allEvaluations.push({
          taskId: task.id,
          taskName: task.name,
          category: task.category,
          difficulty: task.difficulty,
          repetition,
          policyId: policy.id,
          taskDefinitionHash,
          status: 'COMPLETED',
          selectedHarnessId:
            outcome.selectedHarnessId ?? decision.selectedCandidate?.harnessId ?? 'native',
          selectedModelId:
            outcome.selectedModelId ??
            outcome.record.execution.modelId ??
            decision.selectedCandidate?.modelId,
          selectedRuntimeId:
            outcome.selectedRuntimeId ??
            outcome.record.execution.runtimeId ??
            decision.selectedCandidate?.runtimeId,
          verified,
          apparentCompletion,
          costUsd,
          costStatus: outcome.costStatus ?? 'ESTIMATED',
          endToEndLatencyMs,
          retryCount,
          retried,
          fallbackUsed,
          policyViolation,
          policyViolationReasons,
          scoreReport,
          rationale: outcome.rationale ?? decision.rationale ?? [],
        });
      }
    }

    const completedEvaluations = allEvaluations.filter((e) => e.status === 'COMPLETED');
    const blockedEvaluations = allEvaluations.filter((e) => e.status === 'BLOCKED');

    const completedCount = completedEvaluations.length;
    const blockedCount = blockedEvaluations.length;
    const verifiedEvaluations = completedEvaluations.filter((e) => e.verified);
    const verifiedSuccessCount = verifiedEvaluations.length;

    const successSamples = completedEvaluations.map((e) => (e.verified ? 1 : 0));
    const retrySamples = completedEvaluations.map((e) => (e.retried ? 1 : 0));
    const fallbackSamples = completedEvaluations.map((e) => (e.fallbackUsed ? 1 : 0));
    const violationSamples = completedEvaluations.map((e) => (e.policyViolation ? 1 : 0));
    const latencySamples = completedEvaluations.map((e) => e.endToEndLatencyMs);
    const verifiedCostSamples = verifiedEvaluations.map((e) => e.costUsd);

    const totalCostUsd = Number(
      completedEvaluations.reduce((sum, e) => sum + e.costUsd, 0).toFixed(6),
    );

    const successStats = computeMetricStatistics(successSamples, { isProportion: true });
    const retryStats = computeMetricStatistics(retrySamples, { isProportion: true });
    const fallbackStats = computeMetricStatistics(fallbackSamples, { isProportion: true });
    const violationStats = computeMetricStatistics(violationSamples, { isProportion: true });
    const latencyStats = computeMetricStatistics(latencySamples);
    const costPerVerifiedStats = computeMetricStatistics(verifiedCostSamples);

    const verified_success_rate = completedCount > 0 ? successStats.mean : Number.NaN;
    // Total USD spent across completed runs divided by verified completions (or NaN if 0 verified completions)
    const cost_per_verified_success =
      verifiedSuccessCount > 0
        ? Number((totalCostUsd / verifiedSuccessCount).toFixed(6))
        : Number.NaN;
    const end_to_end_latency_p50 = latencyStats.p50;
    const end_to_end_latency_p95 = latencyStats.p95;
    const retry_rate = completedCount > 0 ? retryStats.mean : Number.NaN;
    const fallback_rate = completedCount > 0 ? fallbackStats.mean : Number.NaN;
    const policy_violation_rate = completedCount > 0 ? violationStats.mean : Number.NaN;

    const byCategory: Partial<Record<BenchmarkTaskCategory, CategoryDifficultyBreakdown>> = {};
    for (const category of BENCHMARK_CATEGORIES) {
      const catAll = allEvaluations.filter((e) => e.category === category);
      if (catAll.length === 0) continue;
      byCategory[category] = this.computeSliceBreakdown(catAll);
    }

    const byDifficulty: Partial<Record<RouterBenchmarkDifficulty, CategoryDifficultyBreakdown>> = {};
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const diffAll = allEvaluations.filter((e) => e.difficulty === difficulty);
      if (diffAll.length === 0) continue;
      byDifficulty[difficulty] = this.computeSliceBreakdown(diffAll);
    }

    return {
      policyId: policy.id,
      policyName: policy.name,
      totalSamples: allEvaluations.length,
      completedCount,
      blockedCount,
      verifiedSuccessCount,
      verified_success_rate,
      cost_per_verified_success,
      end_to_end_latency_p50,
      end_to_end_latency_p95,
      retry_rate,
      fallback_rate,
      policy_violation_rate,
      totalCostUsd,
      statistics: {
        verified_success_rate: successStats,
        cost_per_verified_success: costPerVerifiedStats,
        end_to_end_latency: latencyStats,
        retry_rate: retryStats,
        fallback_rate: fallbackStats,
        policy_violation_rate: violationStats,
      },
      byCategory,
      byDifficulty,
      completedEvaluations,
      blockedEvaluations,
      allEvaluations,
    };
  }

  private computeSliceBreakdown(
    slice: readonly RouterTaskEvaluationResult[],
  ): CategoryDifficultyBreakdown {
    const completed = slice.filter((e) => e.status === 'COMPLETED');
    const blocked = slice.filter((e) => e.status === 'BLOCKED');
    const verifiedCount = completed.filter((e) => e.verified).length;
    const latencies = completed.map((e) => e.endToEndLatencyMs).sort((a, b) => a - b);
    const meanCost =
      completed.length > 0
        ? Number((completed.reduce((s, e) => s + e.costUsd, 0) / completed.length).toFixed(6))
        : Number.NaN;

    return {
      totalTasks: slice.length,
      completedTasks: completed.length,
      blockedTasks: blocked.length,
      verifiedSuccessCount: verifiedCount,
      verifiedSuccessRate:
        completed.length > 0 ? Number((verifiedCount / completed.length).toFixed(6)) : Number.NaN,
      meanCostUsd: meanCost,
      latencyP50Ms: Number(computePercentile(latencies, 50).toFixed(2)),
      latencyP95Ms: Number(computePercentile(latencies, 95).toFixed(2)),
    };
  }

  private buildMetricComparisons(
    baseline: RouterPolicyBenchmarkSummary,
    candidate: RouterPolicyBenchmarkSummary,
    deltas: ComparativeRouterBenchmarkResult['deltas'],
    alpha: number,
  ): Record<RouterBenchmarkMetricName, MetricComparisonDetail> {
    const pairMap = new Map<
      string,
      { base?: RouterTaskEvaluationResult; cand?: RouterTaskEvaluationResult }
    >();
    for (const b of baseline.completedEvaluations) {
      const key = `${b.taskId}::${b.repetition}`;
      pairMap.set(key, { base: b });
    }
    for (const c of candidate.completedEvaluations) {
      const key = `${c.taskId}::${c.repetition}`;
      const existing = pairMap.get(key) ?? {};
      existing.cand = c;
      pairMap.set(key, existing);
    }

    const pairedList = [...pairMap.values()].filter(
      (p): p is { base: RouterTaskEvaluationResult; cand: RouterTaskEvaluationResult } =>
        Boolean(p.base && p.cand),
    );

    const computePairSignStats = (
      extractor: (e: RouterTaskEvaluationResult) => number,
      direction: 'MAXIMIZE' | 'MINIMIZE',
    ) => {
      let wins = 0;
      let losses = 0;
      let ties = 0;
      for (const pair of pairedList) {
        const bVal = extractor(pair.base);
        const cVal = extractor(pair.cand);
        if (!Number.isFinite(bVal) || !Number.isFinite(cVal)) continue;
        const diff = direction === 'MAXIMIZE' ? cVal - bVal : bVal - cVal;
        if (diff > 1e-9) wins++;
        else if (diff < -1e-9) losses++;
        else ties++;
      }
      const informative = wins + losses;
      const pValue = informative > 0 ? binomialUpperTail(wins, informative, 0.5) : 1;
      return { wins, losses, ties, pValue };
    };

    const makeDetail = (
      metric: RouterBenchmarkMetricName,
      baseVal: number,
      candVal: number,
      delta: number,
      baseCI: [number, number],
      candCI: [number, number],
      signStats: { wins: number; losses: number; ties: number; pValue: number },
      direction: 'MAXIMIZE' | 'MINIMIZE',
    ): MetricComparisonDetail => {
      const overlap = intervalsOverlap(baseCI, candCI);
      const pct =
        Number.isFinite(baseVal) && Math.abs(baseVal) > 1e-9
          ? Number(((delta / Math.abs(baseVal)) * 100).toFixed(4))
          : 0;
      const improvedDirection = direction === 'MAXIMIZE' ? delta > 0 : delta < 0;
      const significant = improvedDirection && (!overlap || signStats.pValue <= alpha);

      return {
        metric,
        baseline: baseVal,
        candidate: candVal,
        delta,
        percentChange: pct,
        baselineCI95: baseCI,
        candidateCI95: candCI,
        confidenceIntervalsOverlap: overlap,
        pairedWins: signStats.wins,
        pairedLosses: signStats.losses,
        pairedTies: signStats.ties,
        pValue: Number(signStats.pValue.toFixed(6)),
        significant,
      };
    };

    const successSigns = computePairSignStats((e) => (e.verified ? 1 : 0), 'MAXIMIZE');
    const costSigns = computePairSignStats(
      (e) => (e.verified ? e.costUsd : Number.NaN),
      'MINIMIZE',
    );
    const latencySigns = computePairSignStats((e) => e.endToEndLatencyMs, 'MINIMIZE');
    const retrySigns = computePairSignStats((e) => (e.retried ? 1 : 0), 'MINIMIZE');
    const fallbackSigns = computePairSignStats((e) => (e.fallbackUsed ? 1 : 0), 'MINIMIZE');
    const violationSigns = computePairSignStats((e) => (e.policyViolation ? 1 : 0), 'MINIMIZE');

    return {
      verified_success_rate: makeDetail(
        'verified_success_rate',
        baseline.verified_success_rate,
        candidate.verified_success_rate,
        deltas.verified_success_rate,
        baseline.statistics.verified_success_rate.confidenceInterval95,
        candidate.statistics.verified_success_rate.confidenceInterval95,
        successSigns,
        'MAXIMIZE',
      ),
      cost_per_verified_success: makeDetail(
        'cost_per_verified_success',
        baseline.cost_per_verified_success,
        candidate.cost_per_verified_success,
        deltas.cost_per_verified_success,
        baseline.statistics.cost_per_verified_success.confidenceInterval95,
        candidate.statistics.cost_per_verified_success.confidenceInterval95,
        costSigns,
        'MINIMIZE',
      ),
      end_to_end_latency_p50: makeDetail(
        'end_to_end_latency_p50',
        baseline.end_to_end_latency_p50,
        candidate.end_to_end_latency_p50,
        deltas.end_to_end_latency_p50,
        baseline.statistics.end_to_end_latency.confidenceInterval95,
        candidate.statistics.end_to_end_latency.confidenceInterval95,
        latencySigns,
        'MINIMIZE',
      ),
      end_to_end_latency_p95: makeDetail(
        'end_to_end_latency_p95',
        baseline.end_to_end_latency_p95,
        candidate.end_to_end_latency_p95,
        deltas.end_to_end_latency_p95,
        baseline.statistics.end_to_end_latency.confidenceInterval95,
        candidate.statistics.end_to_end_latency.confidenceInterval95,
        latencySigns,
        'MINIMIZE',
      ),
      retry_rate: makeDetail(
        'retry_rate',
        baseline.retry_rate,
        candidate.retry_rate,
        deltas.retry_rate,
        baseline.statistics.retry_rate.confidenceInterval95,
        candidate.statistics.retry_rate.confidenceInterval95,
        retrySigns,
        'MINIMIZE',
      ),
      fallback_rate: makeDetail(
        'fallback_rate',
        baseline.fallback_rate,
        candidate.fallback_rate,
        deltas.fallback_rate,
        baseline.statistics.fallback_rate.confidenceInterval95,
        candidate.statistics.fallback_rate.confidenceInterval95,
        fallbackSigns,
        'MINIMIZE',
      ),
      policy_violation_rate: makeDetail(
        'policy_violation_rate',
        baseline.policy_violation_rate,
        candidate.policy_violation_rate,
        deltas.policy_violation_rate,
        baseline.statistics.policy_violation_rate.confidenceInterval95,
        candidate.statistics.policy_violation_rate.confidenceInterval95,
        violationSigns,
        'MINIMIZE',
      ),
    };
  }

  private determineHonestVerdict(
    baseline: RouterPolicyBenchmarkSummary,
    candidate: RouterPolicyBenchmarkSummary,
    deltas: ComparativeRouterBenchmarkResult['deltas'],
    comparisons: Record<RouterBenchmarkMetricName, MetricComparisonDetail>,
    alpha: number,
  ): {
    verdict: ComparativeRouterVerdict;
    improvements: string[];
    regressions: string[];
    inconclusiveReasons: string[];
    honestAssessment: string[];
  } {
    const improvements: string[] = [];
    const regressions: string[] = [];
    const inconclusiveReasons: string[] = [];
    const honestAssessment: string[] = [];

    if (baseline.completedCount === 0 || candidate.completedCount === 0) {
      inconclusiveReasons.push(
        `NO_COMPLETED_EVALUATIONS: Baseline completed=${baseline.completedCount}, Candidate completed=${candidate.completedCount}`,
      );
      honestAssessment.push(
        'Inconclusive benchmark: one or both router policies had zero completed evaluations (all tasks were blocked).',
      );
      return {
        verdict: 'NO_SIGNIFICANT_IMPROVEMENT',
        improvements,
        regressions,
        inconclusiveReasons,
        honestAssessment,
      };
    }

    if (baseline.blockedCount > 0 || candidate.blockedCount > 0) {
      honestAssessment.push(
        `Blocked tasks recorded separately from completed runs: baseline blocked=${baseline.blockedCount}, candidate blocked=${candidate.blockedCount}.`,
      );
    }

    // Check regressions
    if (deltas.policy_violation_rate > 1e-9) {
      regressions.push(
        `Candidate increased policy_violation_rate by +${(deltas.policy_violation_rate * 100).toFixed(2)}% (${(candidate.policy_violation_rate * 100).toFixed(2)}% vs ${(baseline.policy_violation_rate * 100).toFixed(2)}%).`,
      );
    }

    if (deltas.verified_success_rate < -1e-9) {
      regressions.push(
        `Candidate regressed on verified_success_rate by ${(deltas.verified_success_rate * 100).toFixed(2)}% (${(candidate.verified_success_rate * 100).toFixed(2)}% vs ${(baseline.verified_success_rate * 100).toFixed(2)}%).`,
      );
    }

    if (
      Number.isFinite(deltas.cost_per_verified_success) &&
      deltas.cost_per_verified_success > 0.005 &&
      deltas.verified_success_rate <= 0
    ) {
      regressions.push(
        `Candidate increased cost_per_verified_success by +$${deltas.cost_per_verified_success.toFixed(4)} without improving verified_success_rate.`,
      );
    }

    if (
      deltas.end_to_end_latency_p95 > 500 &&
      deltas.verified_success_rate <= 0 &&
      (!Number.isFinite(deltas.cost_per_verified_success) || deltas.cost_per_verified_success >= 0)
    ) {
      regressions.push(
        `Candidate increased end_to_end_latency_p95 by +${Math.round(deltas.end_to_end_latency_p95)}ms without improving verified success or cost.`,
      );
    }

    // Check improvements
    const successComp = comparisons.verified_success_rate;
    const costComp = comparisons.cost_per_verified_success;
    const latencyComp = comparisons.end_to_end_latency_p50;

    if (deltas.verified_success_rate > 1e-9) {
      if (successComp.significant) {
        improvements.push(
          `Statistically significant improvement in verified_success_rate: +${(deltas.verified_success_rate * 100).toFixed(2)}% (p=${successComp.pValue.toFixed(4)} <= ${alpha}).`,
        );
      } else {
        inconclusiveReasons.push(
          `OVERLAPPING_CONFIDENCE_INTERVALS: verified_success_rate improved by +${(deltas.verified_success_rate * 100).toFixed(2)}%, but 95% confidence intervals overlap ([${baseline.statistics.verified_success_rate.confidenceInterval95.join(', ')}] vs [${candidate.statistics.verified_success_rate.confidenceInterval95.join(', ')}]) and paired sign test p=${successComp.pValue.toFixed(4)} > ${alpha}.`,
        );
      }
    }

    if (
      Number.isFinite(deltas.cost_per_verified_success) &&
      deltas.cost_per_verified_success < -1e-6 &&
      deltas.verified_success_rate >= 0
    ) {
      if (costComp.significant) {
        improvements.push(
          `Statistically significant reduction in cost_per_verified_success: -$${Math.abs(deltas.cost_per_verified_success).toFixed(4)} (p=${costComp.pValue.toFixed(4)}).`,
        );
      } else {
        inconclusiveReasons.push(
          `OVERLAPPING_COST_INTERVALS: cost_per_verified_success decreased by -$${Math.abs(deltas.cost_per_verified_success).toFixed(4)}, but uncertainty bounds overlap and p=${costComp.pValue.toFixed(4)} > ${alpha}.`,
        );
      }
    }

    if (deltas.end_to_end_latency_p50 < -1e-6 && deltas.verified_success_rate >= 0) {
      if (latencyComp.significant) {
        improvements.push(
          `Statistically significant reduction in end_to_end_latency_p50: ${Math.round(deltas.end_to_end_latency_p50)}ms (p=${latencyComp.pValue.toFixed(4)}).`,
        );
      }
    }

    if (deltas.retry_rate < -1e-6) {
      improvements.push(
        `Reduced retry_rate by ${(Math.abs(deltas.retry_rate) * 100).toFixed(2)}%.`,
      );
    }

    let verdict: ComparativeRouterVerdict;
    if (regressions.length > 0) {
      verdict = 'REGRESSION';
      honestAssessment.push(
        `Verdict is REGRESSION: Candidate exhibited ${regressions.length} regression(s): ${regressions.join(' ')}`,
      );
    } else if (
      improvements.length > 0 &&
      (successComp.significant || costComp.significant || latencyComp.significant)
    ) {
      verdict = 'IMPROVEMENT';
      honestAssessment.push(
        `Verdict is IMPROVEMENT: Candidate achieved verified improvement without regressions: ${improvements.join(' ')}`,
      );
    } else {
      verdict = 'NO_SIGNIFICANT_IMPROVEMENT';
      if (inconclusiveReasons.length === 0) {
        inconclusiveReasons.push(
          'NO_EFFECT_DETECTED: Candidate did not produce a statistically significant improvement in verified_success_rate, cost_per_verified_success, or latency.',
        );
      }
      honestAssessment.push(
        `Verdict is NO_SIGNIFICANT_IMPROVEMENT: ${inconclusiveReasons.join(' ')}`,
      );
    }

    return {
      verdict,
      improvements,
      regressions,
      inconclusiveReasons,
      honestAssessment,
    };
  }

  private formatSummaryText(
    benchmarkId: string,
    baseline: RouterPolicyBenchmarkSummary,
    candidate: RouterPolicyBenchmarkSummary,
    deltas: ComparativeRouterBenchmarkResult['deltas'],
    verdict: ComparativeRouterVerdict,
    honestAssessment: string[],
  ): string {
    const fmtPct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'N/A');
    const fmtUsd = (v: number) => (Number.isFinite(v) ? `$${v.toFixed(4)}` : 'N/A');
    const fmtMs = (v: number) => (Number.isFinite(v) ? `${Math.round(v)}ms` : 'N/A');

    return [
      `=== Comparative Router Benchmark (${benchmarkId}) ===`,
      `Baseline: ${baseline.policyName} (${baseline.policyId}) [completed=${baseline.completedCount}, blocked=${baseline.blockedCount}]`,
      `Candidate: ${candidate.policyName} (${candidate.policyId}) [completed=${candidate.completedCount}, blocked=${candidate.blockedCount}]`,
      `Verdict: ${verdict}`,
      `verified_success_rate: ${fmtPct(baseline.verified_success_rate)} -> ${fmtPct(candidate.verified_success_rate)} (delta: ${fmtPct(deltas.verified_success_rate)})`,
      `cost_per_verified_success: ${fmtUsd(baseline.cost_per_verified_success)} -> ${fmtUsd(candidate.cost_per_verified_success)} (delta: ${fmtUsd(deltas.cost_per_verified_success)})`,
      `end_to_end_latency_p50: ${fmtMs(baseline.end_to_end_latency_p50)} -> ${fmtMs(candidate.end_to_end_latency_p50)}`,
      `end_to_end_latency_p95: ${fmtMs(baseline.end_to_end_latency_p95)} -> ${fmtMs(candidate.end_to_end_latency_p95)}`,
      `retry_rate: ${fmtPct(baseline.retry_rate)} -> ${fmtPct(candidate.retry_rate)}`,
      `fallback_rate: ${fmtPct(baseline.fallback_rate)} -> ${fmtPct(candidate.fallback_rate)}`,
      `policy_violation_rate: ${fmtPct(baseline.policy_violation_rate)} -> ${fmtPct(candidate.policy_violation_rate)}`,
      ...honestAssessment,
    ].join('\n');
  }
}

export function toMarkdownReport(result: ComparativeRouterBenchmarkResult): string {
  const fmtNum = (v: number, digits = 4) => (Number.isFinite(v) ? v.toFixed(digits) : 'N/A');
  const fmtCI = (ci: [number, number]) =>
    Number.isFinite(ci[0]) && Number.isFinite(ci[1])
      ? `[${ci[0].toFixed(4)}, ${ci[1].toFixed(4)}]`
      : '[N/A, N/A]';

  const lines: string[] = [
    `# Comparative Router Benchmark Report: \`${result.benchmarkId}\``,
    '',
    `- **Executed At:** ${result.executedAt}`,
    `- **Verdict:** **${result.verdict}**`,
    `- **Baseline Policy:** \`${result.baseline.policyId}\` (${result.baseline.policyName})`,
    `- **Candidate Policy:** \`${result.candidate.policyId}\` (${result.candidate.policyName})`,
    `- **Matched Conditions Enforced:** \`${result.matchedConditions.enforced}\` (tasks=${result.matchedConditions.taskCount}, repetitions=${result.matchedConditions.repetitions}, suiteHash=\`${result.matchedConditions.taskSuiteHash.slice(0, 12)}\`)`,
    '',
    '## Execution Status Breakdown',
    '',
    '| Policy | Total Samples | Completed (`COMPLETED`) | Blocked (`BLOCKED`) | Verified Successes |',
    '|---|---:|---:|---:|---:|',
    `| Baseline (\`${result.baseline.policyId}\`) | ${result.baseline.totalSamples} | ${result.baseline.completedCount} | ${result.baseline.blockedCount} | ${result.baseline.verifiedSuccessCount} |`,
    `| Candidate (\`${result.candidate.policyId}\`) | ${result.candidate.totalSamples} | ${result.candidate.completedCount} | ${result.candidate.blockedCount} | ${result.candidate.verifiedSuccessCount} |`,
    '',
    '## Primary Router Metrics & Uncertainty (95% CI)',
    '',
    '| Metric | Baseline | Baseline 95% CI | Candidate | Candidate 95% CI | Delta | Overlap | p-value |',
    '|---|---:|---|---:|---|---:|---|---:|',
  ];

  for (const metricName of REQUIRED_ROUTER_BENCHMARK_METRICS) {
    const comp = result.metricComparisons[metricName];
    lines.push(
      `| \`${metricName}\` | ${fmtNum(comp.baseline)} | ${fmtCI(comp.baselineCI95)} | ${fmtNum(comp.candidate)} | ${fmtCI(comp.candidateCI95)} | ${comp.delta >= 0 ? `+${fmtNum(comp.delta)}` : fmtNum(comp.delta)} | ${comp.confidenceIntervalsOverlap ? 'Yes' : 'No'} | ${fmtNum(comp.pValue)} |`,
    );
  }

  lines.push(
    '',
    '## Honest Assessment & Qualification Notes',
    '',
    ...result.honestAssessment.map((note) => `- ${note}`),
  );

  if (result.regressions.length > 0) {
    lines.push('', '### Regressions Detected', ...result.regressions.map((r) => `- ${r}`));
  }

  if (result.improvements.length > 0) {
    lines.push('', '### Verified Improvements', ...result.improvements.map((i) => `- ${i}`));
  }

  if (result.inconclusiveReasons.length > 0) {
    lines.push(
      '',
      '### Inconclusive / Non-Significant Findings',
      ...result.inconclusiveReasons.map((r) => `- ${r}`),
    );
  }

  if (
    result.baseline.blockedEvaluations.length > 0 ||
    result.candidate.blockedEvaluations.length > 0
  ) {
    lines.push('', '## Blocked Task Evaluations', '');
    for (const blocked of [
      ...result.baseline.blockedEvaluations,
      ...result.candidate.blockedEvaluations,
    ]) {
      lines.push(
        `- Policy \`${blocked.policyId}\` | Task \`${blocked.taskId}\` (rep ${blocked.repetition}): **BLOCKED** — ${blocked.blockedReason}`,
      );
    }
  }

  return lines.join('\n');
}

export function toJsonReport(result: ComparativeRouterBenchmarkResult): string {
  return JSON.stringify(result, (_key, value) => {
    if (typeof value === 'number' && Number.isNaN(value)) {
      return null;
    }
    return value;
  }, 2);
}
