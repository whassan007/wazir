import type { ExecutionRecord } from './execution.js';
import type { EvaluationScoreReport } from './benchmark.js';

export interface SolutionStrategy {
  id: string;
  name: string;
  modelId?: string;
  runtimeId?: string;
  promptModifier?: string;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

export interface BranchExecutionCandidate {
  branchId: string;
  strategy: SolutionStrategy;
  executionRecord: ExecutionRecord;
  scoreReport: EvaluationScoreReport;
  worktreePath?: string;
  branchName?: string;
}

export interface BranchSearchResult {
  taskId: string;
  totalBranches: number;
  winningBranch?: BranchExecutionCandidate;
  rankedCandidates: BranchExecutionCandidate[];
  discardedBranchIds: string[];
  selectionReason: string;
}

export interface BranchSearchOptions {
  maxParallelBranches?: number;
  branchTimeoutMs?: number;
  autoCleanupDiscarded?: boolean;
}
