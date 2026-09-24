import type { ExecutionRecord, CheckRunRecord } from './execution.js';
import type { EvaluationScoreReport, ExecutionMetrics } from './benchmark.js';
import type { VerificationEvidence, CompletionEvaluation } from './verification.js';
import type { WorktreeMergeResult } from '../services/worktreeManager.js';
import type { SteeringParams, SteeringResult } from './steering.js';

export type SearchStrategyKind =
  | 'same_model_diverse'
  | 'multi_model'
  | 'multi_agent'
  | 'mixed'
  | 'hierarchical_mcts';

export interface CandidateBudget {
  maxTurns?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRepairCycles?: number;
}

export interface SearchBudget {
  maxCandidates?: number;
  maxParallelCandidates?: number;
  maxTotalModelCalls?: number;
  maxTotalTokens?: number;
  maxWallTimeMs?: number;
  maxCandidateRepairCycles?: number;
  maxCandidateTokens?: number;
  maxCandidateTurns?: number;
}

export interface AdaptiveSearchConfig {
  enabled?: boolean;
  initialCandidates?: number;
  maxCandidates?: number;
  pruning?: {
    enabled?: boolean;
    maxRepairCyclesBeforePrune?: number;
    maxTokenBurnBeforePrune?: number;
    hardPruneOnUnrecoverableBuild?: boolean;
    hardPruneOnProtectedOracleFailure?: boolean;
    pruneOnRepeatedDeterministicFailure?: boolean;
  };
  escalation?: {
    enabled?: boolean;
    triggerOnFailureCount?: number;
    candidateModelTiers?: string[];
  };
  diversity?: {
    enabled?: boolean;
    minDiversityScore?: number;
    similarityThreshold?: number;
  };
  budgetReallocation?: {
    enabled?: boolean;
    reallocateUnusedBudget?: boolean;
    bonusBudgetForPromisingCandidates?: boolean;
  };
  stoppingCriteria?: {
    stopOnSufficient?: boolean;
    stopOnAllFailedImpossible?: boolean;
    stopOnBudgetExhausted?: boolean;
    stopWhenCannotMateriallyImprove?: boolean;
  };
}

export interface CandidatePairDiversity {
  candidateA: string;
  candidateB: string;
  similarity: number;
  diversity: number;
  sharedFiles: string[];
}

export interface AdaptiveSearchTelemetry {
  initialCandidatesCount: number;
  spawnedCandidatesCount: number;
  prunedCandidatesCount: number;
  escalatedCandidatesCount: number;
  reallocatedBudgetsCount: number;
  diversityScores: CandidatePairDiversity[];
  meanDiversityScore?: number;
  pruningReasons: Array<{ candidateId: string; hard: boolean; reason: string }>;
  escalationEvents: Array<{ candidateId: string; fromModel?: string; toModel: string; reason: string }>;
  stopConditionTriggered?: string;
  efficiency?: {
    tokenSavingsRatio?: number;
    candidateSavingsRatio?: number;
    wallTimeSavingsRatio?: number;
  };
}

export type CandidateSecondaryCriterion =
  | 'fewer_unresolved_issues'
  | 'smaller_change_surface'
  | 'lower_verification_burden'
  | 'fewer_repair_cycles'
  | 'lower_token_consumption'
  | 'lower_wall_time'
  | 'lower_cost'
  | 'higher_verification_coverage';

export interface SelectionPolicy {
  /**
   * Mandatory gates (all true by default):
   * 1. Must satisfy correctness gates
   * 2. Must satisfy protected verification / oracles
   * 3. Must satisfy task acceptance criteria
   */
  requireCorrectness?: boolean;
  requireProtectedVerification?: boolean;
  requireTaskAcceptance?: boolean;

  /**
   * Configurable secondary criteria in strict lexicographic order.
   */
  secondaryCriteria?: CandidateSecondaryCriterion[];

  /**
   * If candidates on the Pareto frontier cannot be separated deterministically
   * by secondary criteria, return all tied frontier candidates instead of picking arbitrarily.
   */
  allowFrontierTies?: boolean;

  /**
   * Early stopping policy if a candidate satisfies all gates and exceeds this criteria.
   */
  earlyStopOnSufficient?: boolean;
}

export interface CandidateDescriptor {
  id: string;
  name: string;
  strategyKind: SearchStrategyKind;
  modelId?: string;
  runtimeId?: string;
  agentId?: string;
  promptModifier?: string;
  reasoningStrategy?: string;
  solutionConstraints?: string[];
  implementationApproach?: string;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

// ======================================================================
// HIERARCHICAL MONTE CARLO TREE SEARCH (MCTS) TYPES
// ======================================================================

export type SearchPhaseLevel =
  | 'architecture'
  | 'design'
  | 'implementation'
  | 'repair'
  | 'optimization';

export interface SearchNodeRewardEvidence {
  correctness: boolean;
  verificationPassed: boolean;
  acceptanceProgress: number; // 0.0 - 1.0 fraction of verification criteria satisfied
  resourceUsage: {
    tokens: number;
    modelCalls: number;
    wallTimeMs: number;
    repairCycles: number;
    costUsd?: number;
  };
  protectedViolations: string[];
  scalarReward: number; // Derived strictly from controller evidence, never model confidence!
  rawMetrics: Record<string, number>;
}

export interface SearchNode {
  id: string;
  parentId?: string;
  depth: number;
  level: SearchPhaseLevel;
  checkpointId: string;
  strategy: string;
  mutations: string[];
  workspaceRevision: number;
  stateHash: string; // Used for transposition detection
  visits: number;
  value: number; // Accumulated value/reward
  meanValue: number;
  rewardEvidence?: SearchNodeRewardEvidence;
  verification?: {
    passed: boolean;
    checksPassed: boolean;
    buildPassed: boolean;
    errors: string[];
    evidenceIds: string[];
  };
  children: string[]; // Child node IDs
  terminal: boolean;
  pruned?: boolean;
  pruneReason?: string;
  worktreePath?: string;
  branchName?: string;
  executionRecord?: ExecutionRecord;
  evaluation?: CandidateEvaluation;
  isTransposition?: boolean;
  transpositionTargetId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  completedAt?: Date;
}

export interface MCTSSearchTree {
  rootId: string;
  nodes: Map<string, SearchNode>;
  transpositionTable: Map<string, string>; // stateHash -> nodeId
  bestNodeId?: string;
  maxDepthReached: number;
  totalNodesCreated: number;
  paretoFrontierNodeIds: string[];
}

export interface HierarchicalSearchConfig {
  enabled?: boolean;
  maxDepth?: number;
  maxNodes?: number;
  branchingFactor?: number;
  explorationConstant?: number; // c in UCT, default sqrt(2) ~ 1.414
  phases?: SearchPhaseLevel[];
  progressiveVerification?: boolean;
  transpositionDetection?: boolean;
  diversityThreshold?: number; // Minimum diversity required for child expansion
  pruneThreshold?: number; // Minimum reward below which node is pruned
  parallelWorkers?: number;
  requeueOnWorkerFailure?: boolean;
  scalarizationPolicy?: 'balanced' | 'correctness_priority' | 'efficiency_priority' | 'pareto_only';
}

export interface HierarchicalSearchTelemetry {
  treeDepth: number;
  totalNodes: number;
  nodesPerLevel: Record<SearchPhaseLevel, number>;
  rolloutsCount: number;
  transpositionsDetected: number;
  prunedNodesCount: number;
  workerFailuresRecovered: number;
  meanNodeReward: number;
  maxNodeReward: number;
  paretoFrontierSize: number;
  bestStrategyPath: string[];
  selectionLatencyMs: number;
  expansionCount: number;
  backpropagationCount: number;
}

export interface SolutionSearchRequest {
  searchId?: string;
  executionId: string;
  objective: string;
  requirements?: string[] | Record<string, unknown>;
  candidates: number;
  strategy: SearchStrategyKind;
  maxParallelCandidates?: number;
  candidateBudget?: CandidateBudget;
  searchBudget?: SearchBudget;
  selectionPolicy?: SelectionPolicy;
  customCandidates?: CandidateDescriptor[];
  projectRoot?: string;
  autoPromote?: boolean;
  adaptive?: AdaptiveSearchConfig;
  hierarchical?: HierarchicalSearchConfig;
}

export interface CandidateEngineeringProperties {
  filesChanged: string[];
  diffSize: number;
  diffSummary?: string;
  affectedArtifactCount: number;
  verificationScope: string[];
  complexityDelta?: number;
}

export interface CandidateExecutionProperties {
  modelCalls: number;
  toolCalls: number;
  repairCycles: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  wallTimeMs: number;
}

export interface CandidateResourceProperties {
  gpuTimeMs?: number;
  monetaryCostUsd?: number;
}

export interface CandidateEvaluation {
  candidateId: string;
  qualifies: boolean;
  disqualificationReasons: string[];
  correctness: boolean;
  acceptanceTestPassed: boolean;
  buildPassed: boolean;
  testsPassed: boolean;
  verificationPassed: boolean;
  protectedOraclePassed: boolean;
  engineering: CandidateEngineeringProperties;
  execution: CandidateExecutionProperties;
  resources: CandidateResourceProperties;
  scoreReport: EvaluationScoreReport;
}

export type CandidateStatus =
  | 'pending'
  | 'running'
  | 'verifying'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'pruned'
  | 'escalated';

export interface CandidateResult {
  candidateId: string;
  descriptor: CandidateDescriptor;
  status: CandidateStatus;
  worktreePath: string;
  branchName: string;
  workspaceRevision: number;
  executionRecord?: ExecutionRecord;
  evaluation?: CandidateEvaluation;
  evidence: VerificationEvidence[];
  checks: CheckRunRecord[];
  failureReason?: string;
  failureTail?: string;
  error?: string;
  prunedReason?: string;
  isPruned?: boolean;
  isEscalated?: boolean;
  escalationHistory?: Array<{ fromModel?: string; toModel: string; at: Date; reason: string }>;
  reallocatedBudget?: { tokens?: number; turns?: number };
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
}

export interface ParetoFrontier {
  candidates?: CandidateResult[];
  dimensions: string[];
  tradeoffsSummary?: string;
  directions?: Record<string, string>;
  frontierCandidates?: CandidateResult[] | any[];
  dominatedCandidates?: CandidateResult[] | any[];
  allEvaluated?: CandidateResult[] | any[];
}

export interface CandidatePromotionResult {
  searchId: string;
  candidateId: string;
  success: boolean;
  promoted?: boolean;
  promotedRevision: number;
  prePromotionRevision: number;
  mergeResult?: WorktreeMergeResult;
  conflict?: {
    reason: string;
    conflictingFiles: string[];
    parentChangedSinceCheckpoint: boolean;
  };
  reverification: CompletionEvaluation;
  reverificationEvidence: VerificationEvidence[];
  reverificationPassed: boolean;
  promotedAt: Date;
  provenance: {
    checkpointId: string;
    candidateExecutionId: string;
    parentExecutionId: string;
    branch: string;
    diffHash?: string;
  };
}

export type SolutionSearchStatus =
  | 'initializing'
  | 'running'
  | 'paused'
  | 'evaluating'
  | 'selecting'
  | 'promoting'
  | 'completed'
  | 'completed_no_qualifying'
  | 'budget_exhausted'
  | 'cancelled'
  | 'failed';

export interface SolutionSearchResult {
  searchId: string;
  parentExecutionId: string;
  checkpointId: string;
  status: SolutionSearchStatus;
  strategy: SearchStrategyKind;
  totalCandidates: number;
  candidates: CandidateResult[];
  qualifyingCandidates: CandidateResult[];
  disqualifiedCandidates: Array<{ candidateId: string; reasons: string[] }>;
  selectedCandidate?: CandidateResult;
  paretoFrontier: ParetoFrontier;
  selectionReason: string;
  promotionResult?: CandidatePromotionResult;
  budgetExhaustedReason?: string;
  totalModelCalls: number;
  totalTokens: number;
  wallTimeMs: number;
  startedAt: Date;
  completedAt?: Date;
  adaptiveTelemetry?: AdaptiveSearchTelemetry;
  hierarchicalTree?: MCTSSearchTree;
  hierarchicalTelemetry?: HierarchicalSearchTelemetry;
}

export type SolutionSearchEventType =
  | 'solution_search.started'
  | 'solution_search.checkpoint_created'
  | 'solution_search.paused'
  | 'solution_search.resumed'
  | 'solution_search.cancelled'
  | 'candidate.created'
  | 'candidate.started'
  | 'candidate.steered'
  | 'candidate.cancelled'
  | 'candidate.completed'
  | 'candidate.failed'
  | 'candidate.pruned'
  | 'candidate.escalated'
  | 'candidate.spawned'
  | 'budget.reallocated'
  | 'diversity.measured'
  | 'solution_search.stopped'
  | 'candidate.verified'
  | 'candidate.evaluated'
  | 'solution_search.frontier_computed'
  | 'solution_search.selection_made'
  | 'candidate.promotion_started'
  | 'candidate.promotion_completed'
  | 'candidate.promotion_failed'
  | 'solution_search.budget_exhausted'
  | 'solution_search.completed'
  | 'mcts.node_selected'
  | 'mcts.node_expanded'
  | 'mcts.simulation_started'
  | 'mcts.simulation_completed'
  | 'mcts.backpropagated'
  | 'mcts.transposition_detected'
  | 'mcts.node_pruned'
  | 'mcts.worker_failed'
  | 'mcts.worker_recovered'
  | 'mcts.checkpoint_forked';

export interface SolutionSearchEvent {
  type: SolutionSearchEventType;
  searchId: string;
  candidateId?: string;
  executionId: string;
  checkpointId?: string;
  workspaceRoot?: string;
  worktree?: string;
  model?: string;
  agent?: string;
  timestamp: Date;
  data?: Record<string, unknown>;
}
