import type { BenchmarkSuiteResult, ComparativeBenchmarkResult, BenchmarkTask } from './benchmark.js';
import type { ExecutionRecord } from './execution.js';

// ======================================================================
// 1. IMPROVEMENT OBJECTIVES & MEASURABLE METRICS
// ======================================================================

export type ImprovementObjective =
  | 'REDUCE_MALFORMED_ACTIONS'
  | 'REDUCE_MODEL_CALLS'
  | 'REDUCE_INPUT_TOKENS'
  | 'REDUCE_CONTEXT_PEAK'
  | 'REDUCE_TOOL_FAILURES'
  | 'REDUCE_REPAIR_CYCLES'
  | 'REDUCE_WALL_TIME'
  | 'REDUCE_MODEL_LOAD_TIME'
  | 'IMPROVE_TASK_SUCCESS'
  | 'IMPROVE_VERIFICATION_SUCCESS'
  | 'IMPROVE_CODE_RETRIEVAL'
  | 'IMPROVE_ROUTING'
  | 'IMPROVE_TOOL_SELECTION'
  | 'IMPROVE_CONTEXT_SELECTION'
  | 'IMPROVE_RECOVERY_SUCCESS'
  | 'IMPROVE_SUBAGENT_EFFECTIVENESS'
  | 'REDUCE_COMPUTE_USAGE'
  | 'REDUCE_MONETARY_COST';

export type MeasurableMetricName =
  | 'task_success'
  | 'verification_success'
  | 'model_calls'
  | 'input_tokens'
  | 'output_tokens'
  | 'total_tokens'
  | 'peak_context_tokens'
  | 'tool_failures'
  | 'tool_failure_rate'
  | 'malformed_actions'
  | 'repair_cycles'
  | 'wall_time'
  | 'model_latency'
  | 'monetary_cost'
  | 'model_load_time'
  | 'recovery_success'
  | 'context_selection_relevance';

export interface ObjectiveMetricMapping {
  primaryMetric: MeasurableMetricName;
  direction: 'decrease' | 'increase';
  description: string;
}

export const OBJECTIVE_METRIC_MAP: Record<ImprovementObjective, ObjectiveMetricMapping> = {
  REDUCE_MALFORMED_ACTIONS: {
    primaryMetric: 'malformed_actions',
    direction: 'decrease',
    description: 'Reduce frequency of protocol or syntax violations in tool action envelopes',
  },
  REDUCE_MODEL_CALLS: {
    primaryMetric: 'model_calls',
    direction: 'decrease',
    description: 'Reduce total count of generative model calls per task',
  },
  REDUCE_INPUT_TOKENS: {
    primaryMetric: 'input_tokens',
    direction: 'decrease',
    description: 'Reduce input token consumption through better prompt and context management',
  },
  REDUCE_CONTEXT_PEAK: {
    primaryMetric: 'peak_context_tokens',
    direction: 'decrease',
    description: 'Bound peak context window usage and prevent prompt bloat',
  },
  REDUCE_TOOL_FAILURES: {
    primaryMetric: 'tool_failures',
    direction: 'decrease',
    description: 'Reduce tool execution failures and invalid invocations',
  },
  REDUCE_REPAIR_CYCLES: {
    primaryMetric: 'repair_cycles',
    direction: 'decrease',
    description: 'Reduce compile-repair and test-repair loop iterations',
  },
  REDUCE_WALL_TIME: {
    primaryMetric: 'wall_time',
    direction: 'decrease',
    description: 'Reduce overall end-to-end execution latency in milliseconds',
  },
  REDUCE_MODEL_LOAD_TIME: {
    primaryMetric: 'model_load_time',
    direction: 'decrease',
    description: 'Reduce model instance load and admission latency',
  },
  IMPROVE_TASK_SUCCESS: {
    primaryMetric: 'task_success',
    direction: 'increase',
    description: 'Increase percentage of tasks meeting all completion criteria',
  },
  IMPROVE_VERIFICATION_SUCCESS: {
    primaryMetric: 'verification_success',
    direction: 'increase',
    description: 'Increase percentage of candidates passing physical verification gates',
  },
  IMPROVE_CODE_RETRIEVAL: {
    primaryMetric: 'context_selection_relevance',
    direction: 'increase',
    description: 'Increase relevance and precision of retrieved code symbols and definitions',
  },
  IMPROVE_ROUTING: {
    primaryMetric: 'task_success',
    direction: 'increase',
    description: 'Optimize task-to-model routing matching capability constraints',
  },
  IMPROVE_TOOL_SELECTION: {
    primaryMetric: 'tool_failures',
    direction: 'decrease',
    description: 'Optimize phase-specific tool surfaces to prevent malformed or irrelevant tool calls',
  },
  IMPROVE_CONTEXT_SELECTION: {
    primaryMetric: 'peak_context_tokens',
    direction: 'decrease',
    description: 'Optimize context weighting and compaction thresholds',
  },
  IMPROVE_RECOVERY_SUCCESS: {
    primaryMetric: 'recovery_success',
    direction: 'increase',
    description: 'Increase successful recovery rate after worker or model failures',
  },
  IMPROVE_SUBAGENT_EFFECTIVENESS: {
    primaryMetric: 'task_success',
    direction: 'increase',
    description: 'Improve subagent delegation, branch isolation, and integration success',
  },
  REDUCE_COMPUTE_USAGE: {
    primaryMetric: 'total_tokens',
    direction: 'decrease',
    description: 'Reduce aggregate compute tokens and execution resources',
  },
  REDUCE_MONETARY_COST: {
    primaryMetric: 'monetary_cost',
    direction: 'decrease',
    description: 'Reduce estimated monetary cost in USD across all task phases',
  },
};

// ======================================================================
// 2. MATURITY LEVELS & DOMAINS
// ======================================================================

export type SelfImprovementLevel =
  | 0 // LEVEL 0 — OBSERVE: Measure only, no changes
  | 1 // LEVEL 1 — RECOMMEND: Generate hypotheses & experiment plans, no mods
  | 2 // LEVEL 2 — EXPERIMENT: Create isolated candidate worktrees & benchmark (DEFAULT)
  | 3 // LEVEL 3 — CANARY: Staged non-critical traffic deployment with regression auto-rollback
  | 4; // LEVEL 4 — GUARDED PROMOTION: Auto-promote only within authorized domains, auto-rollback

export type SelfImprovementDomain =
  | 'routing'
  | 'tool_surfaces'
  | 'context_policy'
  | 'prompts'
  | 'orchestration'
  | 'wazir_source_code';

export interface DomainLevelConfig {
  routing?: SelfImprovementLevel;
  tool_surfaces?: SelfImprovementLevel;
  context_policy?: SelfImprovementLevel;
  prompts?: SelfImprovementLevel;
  orchestration?: SelfImprovementLevel;
  wazir_source_code?: SelfImprovementLevel;
}

export const DEFAULT_DOMAIN_LEVELS: Record<SelfImprovementDomain, SelfImprovementLevel> = {
  routing: 2,
  tool_surfaces: 2,
  context_policy: 2,
  prompts: 2,
  orchestration: 2,
  wazir_source_code: 1, // Conservative default: recommend only for self-code modifications
};

// ======================================================================
// 3. OBSERVATION WINDOW & OPPORTUNITY DETECTION
// ======================================================================

export type OpportunityCategory =
  | 'HIGH_REPAIR_RATE'
  | 'HIGH_PROTOCOL_FAILURE_RATE'
  | 'HIGH_CONTEXT_GROWTH'
  | 'HIGH_TOOL_RETRY_RATE'
  | 'ROUTING_UNDERPERFORMANCE'
  | 'REPEATED_SEARCH_BEHAVIOR'
  | 'REPEATED_BUILD_FAILURE'
  | 'UNNECESSARY_TOOL_EXPOSURE'
  | 'EXCESSIVE_MODEL_CALLS'
  | 'HIGH_RUNTIME_LATENCY'
  | 'MODEL_SPECIALIZATION_OPPORTUNITY';

export interface ObservationWindow {
  executions: ExecutionRecord[];
  benchmarkRuns?: BenchmarkSuiteResult[];
  failures?: ExecutionRecord[];
  timeRangeMs?: number;
}

export interface ImprovementOpportunity {
  id: string;
  category: OpportunityCategory;
  component: string;
  observation: string;
  evidence: number; // Count of executions/episodes supporting observation
  evidenceDetails?: Record<string, unknown>;
  suspectedCause: string;
  metric: MeasurableMetricName;
  baseline: number;
  domain: SelfImprovementDomain;
  detectedAt: Date;
}

// ======================================================================
// 4. HYPOTHESIS & EXPERIMENT DESIGN
// ======================================================================

export interface MetricConstraint {
  metric: MeasurableMetricName | string;
  operator: '<=' | '>=' | '<' | '>' | '==';
  targetValue: number;
  /** When true, targetValue is treated as a relative ratio against baseline (e.g. 0.80 = <= 80% baseline) */
  isRelativeFactor?: boolean;
}

export type ObjectiveDirection = 'MINIMIZE' | 'MAXIMIZE';

export interface OptimizationObjective {
  metric: MeasurableMetricName | string;
  direction: ObjectiveDirection;
  importance?: number;
  hardConstraint?: MetricConstraint;
  tolerance?: number;
}

export type MultiObjectiveSelectionPolicy =
  | 'LEXICOGRAPHIC'
  | 'PARETO_ONLY'
  | 'WEIGHTED_AFTER_PARETO'
  | 'CONSTRAINED_PRIMARY';

export interface ImprovementHypothesis {
  id: string;
  opportunityId?: string;
  targetComponent: string;
  domain: SelfImprovementDomain;
  proposedChange: string;
  expectedMetricEffect: {
    metric: MeasurableMetricName;
    expectedDelta: number;
    direction: 'decrease' | 'increase';
  };
  possibleRegressions: MeasurableMetricName[];
  requiredBenchmark: string[];
  successThreshold: number;
  configMutations?: ConfigMutation[];
  codeModifications?: Array<{ path: string; patch: string }>;
}

export interface ExperimentPlan {
  experimentId: string;
  name: string;
  hypothesis: ImprovementHypothesis;
  baselineCheckpointId?: string;
  primaryMetric: MeasurableMetricName;
  secondaryMetrics: MeasurableMetricName[];
  requiredImprovement: MetricConstraint;
  regressionConstraints: Record<string, MetricConstraint>;
  benchmarkCategories: string[];
  benchmarkTasks: string[];
  sampleSize: number;
  budget: MetaOptimizationBudget;
  createdAt: Date;
  /** Multi-objective configuration */
  objectives?: OptimizationObjective[];
  protectedMetrics?: Array<MeasurableMetricName | string>;
  hardConstraints?: MetricConstraint[];
  selectionPolicy?: MultiObjectiveSelectionPolicy;
  weights?: Record<string, number>;
  lexicographicOrder?: string[];
}

// ======================================================================
// 5. BASELINE & CANDIDATES
// ======================================================================

export interface MetricSummaryStatistics {
  count: number;
  mean: number;
  median: number;
  variance: number;
  stdDev: number;
  min: number;
  max: number;
  confidenceInterval95: [number, number];
}

export interface BaselineRecord {
  id: string;
  commitSha?: string;
  workspaceHash: string;
  config: OptimizableConfig;
  models: string[];
  runtimeVersions: Record<string, string>;
  benchmarkVersion: string;
  toolDefinitionsHash: string;
  policyConfigHash: string;
  contextConfigHash: string;
  machineInfo?: Record<string, unknown>;
  metrics: Record<string, MetricSummaryStatistics>;
  createdAt: Date;
}

export interface CandidateImplementation {
  candidateId: string;
  experimentId: string;
  strategy: 'CONFIGURATION' | 'TOOL_SURFACE' | 'ROUTING' | 'PROMPT' | 'SOURCE_CODE';
  worktreePath?: string;
  branchName?: string;
  filesChanged: string[];
  mutations?: ConfigMutation[];
  mutationIds?: string[];
  codeDiff?: string;
  config: OptimizableConfig;
  status: 'CREATED' | 'VERIFIED' | 'FAILED_VERIFICATION' | 'EVALUATED';
}

export interface CandidateVerificationResult {
  candidateId: string;
  buildPassed: boolean;
  typecheckPassed: boolean;
  unitTestsPassed: boolean;
  integrationTestsPassed: boolean;
  protectedOraclesPassed: boolean;
  acceptanceTestsPassed: boolean;
  allPassed: boolean;
  errors: string[];
  details?: Record<string, unknown>;
}

// ======================================================================
// 6. REGRESSION GUARD & DECISION
// ======================================================================

export interface RegressionGuardResult {
  qualified: boolean;
  primaryObjectiveMet: boolean;
  correctnessGatesPassed: boolean;
  regressionsDetected: string[];
  protectedViolations: string[];
  inconclusiveReasons: string[];
  summary: string;
}

export type MetaOptimizationDecision =
  | 'QUALIFIED'
  | 'REJECTED'
  | 'INCONCLUSIVE'
  | 'CANARY_ACTIVE'
  | 'CANARY_HEALTHY'
  | 'CANARY_FAILED'
  | 'CANARY_ROLLED_BACK'
  | 'CANARY_INCONCLUSIVE'
  | 'READY_FOR_PROMOTION'
  | 'PROMOTED'
  | 'ACCEPTED'; // Backward compatibility with Gate 13

// ======================================================================
// 7. BUDGETS & STOPPING CONDITIONS
// ======================================================================

export interface MetaOptimizationBudget {
  maxExperiments: number;
  maxCandidatesPerExperiment: number;
  maxModelCalls: number;
  maxTokens: number;
  maxWallTimeMs: number;
  maxGPUTimeMs?: number;
  maxMonetaryCostUSD?: number;
}

export const DEFAULT_META_OPTIMIZATION_BUDGET: MetaOptimizationBudget = {
  maxExperiments: 10,
  maxCandidatesPerExperiment: 3,
  maxModelCalls: 100,
  maxTokens: 500_000,
  maxWallTimeMs: 1_800_000, // 30 minutes
  maxMonetaryCostUSD: 10.0,
};

export interface MetaOptimizerBudgetConsumption {
  experimentsCount: number;
  candidatesCount: number;
  modelCallsCount: number;
  tokensCount: number;
  wallTimeMs: number;
  costUSD: number;
}

// ======================================================================
// 8. MEMORY SERVICE INTEGRATION (LEARNING FROM FAILURE)
// ======================================================================

export interface ImprovementAttempt {
  id: string;
  objective: ImprovementObjective;
  hypothesis: ImprovementHypothesis;
  filesChanged: string[];
  benchmark: string;
  baselineMetrics: Record<string, number>;
  candidateMetrics: Record<string, number>;
  result:
    | 'PROMOTED'
    | 'QUALIFIED'
    | 'REJECTED'
    | 'INCONCLUSIVE'
    | 'FAILED_IMPLEMENTATION'
    | 'FAILED_VERIFICATION'
    | 'REGRESSION'
    | 'CANARY_FAILED'
    | 'CANARY_ROLLED_BACK';
  regressionReasons: string[];
  evidence: Record<string, unknown>;
  recordedAt: Date;
}

// ======================================================================
// 9. PROVENANCE EVENTS
// ======================================================================

export type MetaOptimizerEventType =
  | 'meta.opportunity.detected'
  | 'meta.hypothesis.created'
  | 'meta.hypothesis.rejected'
  | 'meta.experiment.started'
  | 'meta.baseline.recorded'
  | 'meta.candidate.created'
  | 'meta.candidate.verified'
  | 'meta.candidate.evaluated'
  | 'meta.candidate.rejected'
  | 'meta.candidate.qualified'
  | 'meta.promotion.started'
  | 'meta.promotion.completed'
  | 'meta.promotion.failed'
  | 'meta.rollback'
  | 'meta.learning.recorded'
  | 'meta.canary.registered'
  | 'meta.canary.assigned'
  | 'meta.canary.staged_expansion'
  | 'meta.canary.healthy'
  | 'meta.canary.rollback'
  | 'meta.canary.inconclusive'
  | 'meta.distributed.placement'
  | 'meta.distributed.shard_completed'
  | 'meta.distributed.worker_failed'
  | 'meta.distributed.workload_requeued'
  | 'meta.distributed.aggregation_completed';

export interface MetaOptimizerEvent {
  id: string;
  type: MetaOptimizerEventType;
  timestamp: Date;
  experimentId?: string;
  candidateId?: string;
  data: Record<string, unknown>;
}

// ======================================================================
// 10. CONFIGURATION & BACKWARD COMPATIBILITY
// ======================================================================

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
    phaseToolSurfaces?: Record<string, string[]>;
  };
  routingRules?: Record<string, { preferredModel?: string; fallbackModel?: string }>;
}

export type MutationType =
  | 'PROMPT_TWEAK'
  | 'WEIGHT_ADJUSTMENT'
  | 'POLICY_MODIFICATION'
  | 'GOVERNANCE_TUNING'
  | 'ROUTING_ADJUSTMENT'
  | 'TOOL_SURFACE_MODIFICATION';

export interface ConfigMutation {
  type: MutationType;
  path: string;
  oldValue: unknown;
  newValue: unknown;
  rationale: string;
}

export interface MetaOptimizationCandidate {
  candidateId: string;
  mutations: ConfigMutation[];
  mutationIds?: string[];
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
  isDistributed?: boolean;
  workerPlacements?: WorkerPlacementReport[];
  stratifiedMetrics?: Record<string, StratifiedWorkerMetrics>;
  environmentIdentities?: Record<string, EnvironmentIdentity>;
}

export interface CandidateMetricVector {
  candidateId: string;
  rawMetrics: Record<string, number>;
  normalizedDeltas: Record<string, number>;
  qualifies: boolean;
  disqualificationReasons: string[];
  isNonDominated?: boolean;
  frontierRank?: number;
  weightedScore?: number;
}

export interface MultiObjectiveParetoFrontier {
  dimensions: string[];
  directions: Record<string, ObjectiveDirection>;
  frontierCandidates: CandidateMetricVector[];
  dominatedCandidates: CandidateMetricVector[];
  allEvaluated: CandidateMetricVector[];
  hypervolume?: number;
  baselineHypervolume?: number;
  hypervolumeDifference?: number;
  tradeoffsSummary: string;
  selectedCandidateId?: string;
  selectionReason?: string;
  policyUsed: MultiObjectiveSelectionPolicy;
}

export interface MetaOptimizationRunResult {
  runId: string;
  experimentId?: string;
  baselineConfig: OptimizableConfig;
  candidateConfig: OptimizableConfig;
  mutations: ConfigMutation[];
  baselineBenchmark: BenchmarkSuiteResult;
  candidateBenchmark: BenchmarkSuiteResult;
  comparison: ComparativeBenchmarkSuiteResult;
  decision: MetaOptimizationDecision;
  reasons: string[];
  regressionGuard?: RegressionGuardResult;
  paretoFrontier?: MultiObjectiveParetoFrontier;
  metricVectors?: Record<string, CandidateMetricVector> | CandidateMetricVector[];
  selectedCandidateId?: string;
  selectedReason?: string;
  workerPlacements?: WorkerPlacementReport[];
  stratifiedMetrics?: Record<string, StratifiedWorkerMetrics>;
  environmentIdentities?: Record<string, EnvironmentIdentity>;
  causalAttribution?: CausalAttributionReport;
  evaluatedAt: Date;
}

// ======================================================================
// 11. DISTRIBUTED BENCHMARK FABRIC & ENVIRONMENT IDENTITY
// ======================================================================

export interface EnvironmentIdentity {
  workerId: string;
  workerName?: string;
  cpu: {
    model?: string;
    cores?: number;
    architecture?: string;
  };
  gpu?: {
    model?: string;
    count?: number;
    memoryGB?: number;
    unifiedMemory?: boolean;
  };
  ram: {
    totalGB?: number;
    availableGB?: number;
  };
  runtime: {
    type: string;
    version?: string;
  };
  model: {
    id: string;
    version?: string;
    family?: string;
    quantization?: string;
  };
  os: {
    platform: string;
    release?: string;
    architecture?: string;
  };
  architecture: string;
  benchmarkVersion: string;
  wazirVersion: string;
  configuration: {
    configId: string;
    version: number;
  };
  contextSettings: {
    maxTokens?: number;
    contextWindow?: number;
  };
}

export interface BenchmarkShard {
  shardId: string;
  workerId: string;
  tasks: BenchmarkTask[];
  environment: EnvironmentIdentity;
}

export interface DistributedObservation {
  experimentId: string;
  candidateId: string;
  benchmarkId: string;
  taskId: string;
  workerId: string;
  modelId: string;
  runtimeId: string;
  attemptId: string;
  environment: EnvironmentIdentity;
  metrics: {
    portable: {
      taskSuccess: boolean;
      firstPassBuild?: boolean;
      firstPassTest?: boolean;
      physicalVerificationSuccess: boolean;
      inputTokens: number;
      outputTokens: number;
      compactedTokens?: number;
      repairCycles: number;
    };
    hardwareSensitive: {
      durationMs: number;
      modelLatencyMs?: number;
      toolLatencyMs?: number;
      gpuUtilizationPct?: number;
    };
  };
  status: 'COMPLETED' | 'UNKNOWN' | 'FAILED';
  error?: string;
  timestamp: Date;
}

export interface WorkerPlacementReport {
  workerId: string;
  workerName: string;
  shardId: string;
  taskCount: number;
  tasks: string[];
  modelsUsed: string[];
  hardware: {
    cpu?: string;
    gpu?: string;
    ramGB?: number;
    os?: string;
  };
  portableMetrics: {
    passRate: number;
    avgInputTokens: number;
    avgOutputTokens: number;
  };
  hardwareMetrics: {
    avgDurationMs: number;
    speedupVsBaseline?: number;
  };
  status: 'HEALTHY' | 'FAILED' | 'RECOVERED';
}

export interface StratifiedWorkerMetrics {
  workerId: string;
  workerName?: string;
  environment: EnvironmentIdentity;
  taskCount: number;
  portable: {
    baselinePassRate: number;
    candidatePassRate: number;
    passRateDelta: number;
    baselineTokens: number;
    candidateTokens: number;
    tokenDelta: number;
  };
  hardwareSensitive: {
    baselineDurationMs: number;
    candidateDurationMs: number;
    durationDeltaMs: number;
    speedupFactor: number;
  };
}

// ======================================================================
// 12. CAUSAL EXPERIMENT DISCIPLINE & ABLATION ATTRIBUTION
// ======================================================================

export interface Mutation {
  id: string;
  domain: SelfImprovementDomain;
  target: string;
  before: unknown;
  after: unknown;
  rationale: string;
}

export type CausalAttributionVerdict =
  | 'SUPPORTED_CONTRIBUTOR'
  | 'NO_MEASURABLE_EFFECT'
  | 'NEGATIVE_CONTRIBUTOR'
  | 'INTERACTION_DETECTED'
  | 'INSUFFICIENT_EVIDENCE';

export interface MutationAttribution {
  mutationId: string;
  target: string;
  domain: SelfImprovementDomain;
  verdict: CausalAttributionVerdict;
  isolatedDelta: number;
  marginalDelta: number;
  confidence: number;
  sampleCount: number;
  interactionPartners?: string[];
  details: string;
}

export interface InteractionEffect {
  mutationIds: string[];
  individualEffects: Record<string, number>;
  jointEffect: number;
  interactionMagnitude: number;
  verdict: 'INTERACTION_DETECTED' | 'NO_INTERACTION' | 'INSUFFICIENT_EVIDENCE';
  description: string;
}

export type AblationExperimentDesign =
  | 'ONE_FACTOR_AT_A_TIME'
  | 'LEAVE_ONE_OUT'
  | 'FRACTIONAL_FACTORIAL'
  | 'FULL_FACTORIAL';

export interface AblationConfiguration {
  configId: string;
  mutationIds: string[];
  label: string;
  config: OptimizableConfig;
}

export interface AblationPlan {
  experimentId: string;
  candidateId: string;
  allMutations: Mutation[];
  design: AblationExperimentDesign;
  configurations: AblationConfiguration[];
  createdAt: Date;
}

export interface AblationRunResult {
  subCandidateId: string;
  activeMutationIds: string[];
  metricValue: number;
  deltaVsBaseline: number;
  sampleCount: number;
  passRate: number;
}

export interface CausalAttributionReport {
  experimentId: string;
  candidateId: string;
  primaryMetric: MeasurableMetricName;
  direction: 'decrease' | 'increase';
  baselineValue: number;
  candidateValue: number;
  candidateDelta: number;
  design: AblationExperimentDesign;
  ablationRuns: AblationRunResult[];
  attributions: Record<string, MutationAttribution>;
  interactions: InteractionEffect[];
  summary: string;
  analyzedAt: Date;
}

export interface MutationMemoryRecord {
  mutationId: string;
  target: string;
  domain: SelfImprovementDomain;
  lastObservedVerdict: CausalAttributionVerdict;
  averageEffect: number;
  totalEvaluations: number;
  interactionPartners: string[];
  history: Array<{
    experimentId: string;
    verdict: CausalAttributionVerdict;
    delta: number;
    timestamp: Date;
  }>;
}

