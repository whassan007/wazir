import type { ExecutionRecord, CheckRunRecord } from './execution.js';
import type { EvaluationScoreReport, ExecutionMetrics } from './benchmark.js';
import type { VerificationEvidence, CompletionEvaluation } from './verification.js';
import type { WorktreeMergeResult } from '../services/worktreeManager.js';
import type { SteeringParams, SteeringResult } from './steering.js';

export type SearchStrategyKind =
  | 'same_model_diverse'
  | 'multi_model'
  | 'multi_agent'
  | 'mixed';

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
  | 'cancelled';

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
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
}

export interface ParetoFrontier {
  candidates: CandidateResult[];
  dimensions: string[];
  tradeoffsSummary: string;
}

export interface CandidatePromotionResult {
  searchId: string;
  candidateId: string;
  success: boolean;
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
  | 'candidate.verified'
  | 'candidate.evaluated'
  | 'solution_search.frontier_computed'
  | 'solution_search.selection_made'
  | 'candidate.promotion_started'
  | 'candidate.promotion_completed'
  | 'candidate.promotion_failed'
  | 'solution_search.budget_exhausted'
  | 'solution_search.completed';

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
