import type { ExecutionCheckpoint } from './checkpoint.js';
import type {
  SearchNode,
  SearchPhaseLevel,
  SearchNodeRewardEvidence,
  MCTSSearchTree,
  SearchBudget,
  HierarchicalSearchConfig,
} from './solutionSearch.js';
import type { CheckRunRecord } from './execution.js';
import type { VerificationEvidence } from './verification.js';

export type DistributedBranchStatus =
  | 'QUEUED'
  | 'LEASED'
  | 'MATERIALIZING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'RESULT_PENDING'
  | 'COMPLETED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'EXPIRED'
  | 'SUPERSEDED';

export interface BranchModelRequirements {
  modelId?: string;
  runtimeId?: string;
  agentId?: string;
  memoryGB?: number;
  capabilities?: string[];
}

export interface BranchBudgets {
  maxTurns?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxDurationMs?: number;
}

/**
 * Branch Execution Request dispatched to remote physical worker.
 */
export interface DistributedBranchRequest {
  searchId: string;
  nodeId: string;
  parentNodeId?: string;

  treeRevision: number;

  checkpointId: string;
  checkpointDigest: string;
  checkpoint: ExecutionCheckpoint;
  workspaceSnapshot: Record<string, string>;

  phase: SearchPhaseLevel;

  objective: string;
  requirements?: string[] | Record<string, unknown>;
  strategy: string;

  agentRequirements?: Record<string, unknown>;
  modelRequirements?: BranchModelRequirements;
  runtimeRequirements?: Record<string, unknown>;

  toolSurface?: unknown;

  budgetReservation?: BranchBudgets;

  leaseId: string;
  attemptId: string;
}

// Backward-compatibility alias
export type BranchExecutionRequest = DistributedBranchRequest;

/**
 * Result Contract returned by remote worker.
 * Worker MUST NOT return authoritative UCT score, reward, or promotion decisions.
 */
export interface DistributedBranchResult {
  searchId: string;
  nodeId: string;
  parentNodeId?: string;

  sourceTreeRevision: number;

  workerId?: string;
  computerId?: string;

  modelId?: string;
  runtimeId?: string;

  leaseId: string;
  attemptId: string;

  resultingCheckpointId?: string;
  resultingCheckpoint?: ExecutionCheckpoint;
  workspaceDigest: string;
  workspaceHash?: string;

  mutations?: Array<{ path: string; beforeHash?: string; afterHash?: string; changed: boolean }>;
  artifacts?: Array<{ path: string; hash?: string; kind?: string }>;

  buildEvidence?: CheckRunRecord[];
  testEvidence?: CheckRunRecord[];
  acceptanceEvidence?: CheckRunRecord[];
  verificationEvidence?: VerificationEvidence[];

  tokenUsage?: { input: number; output: number; total?: number };
  usage?: { input: number; output: number; total?: number; modelCalls?: number; wallTimeMs?: number };
  modelCalls?: number;
  wallTime?: number;
  wallTimeMs?: number;

  status: 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  error?: string;
}

// Backward-compatibility alias
export type BranchExecutionResult = DistributedBranchResult;

export interface DistributedBranchLease {
  leaseId: string;
  searchId: string;
  nodeId: string;
  attemptId: string;
  workerId?: string;
  status: DistributedBranchStatus;
  expiresAt: number;
  heartbeatAt: number;
  treeRevision: number;
}

export interface DistributedSearchBudget extends SearchBudget {
  maxNodes?: number;
  maxComputeMs?: number;
  maxTokens?: number;
  maxModelCalls?: number;
  maxWallTimeMs?: number;
}

export type DistributedSearchEventType =
  | 'mcts.distributed.search_started'
  | 'mcts.distributed.node_selected'
  | 'mcts.distributed.node_reserved'
  | 'mcts.distributed.node_dispatched'
  | 'mcts.distributed.checkpoint_materialized'
  | 'mcts.distributed.node_started'
  | 'mcts.distributed.node_completed'
  | 'mcts.distributed.node_unknown'
  | 'mcts.distributed.lease_expired'
  | 'mcts.distributed.node_requeued'
  | 'mcts.distributed.result_stale'
  | 'mcts.distributed.transposition'
  | 'mcts.distributed.reward_committed'
  | 'mcts.distributed.backpropagation_committed'
  | 'mcts.distributed.search_completed'
  | 'mcts.distributed.branch_canceled';

export interface DistributedSearchEvent {
  type: DistributedSearchEventType | string;
  searchId: string;
  nodeId?: string;
  parentNodeId?: string;
  workerId?: string;
  attemptId?: string;
  leaseId?: string;
  treeRevision: number;
  checkpointId?: string;
  timestamp: Date;
  data?: Record<string, unknown>;
}

export interface DistributedSearchState {
  searchId: string;
  treeRevision: number;
  tree: MCTSSearchTree;
  leases: Map<string, DistributedBranchLease>;
  acceptedResults: Set<string>;
  acceptedEvidence: Set<string>;
  budget: {
    modelCalls: number;
    tokens: number;
    computeMs: number;
    nodes: number;
  };
  objective: string;
  requirements?: string[] | Record<string, unknown>;
  limits?: DistributedSearchBudget;
}

export interface DistributedSearchCoordinatorOptions {
  mcts: {
    select(tree: MCTSSearchTree, explorationConstant?: number): SearchNode;
    expand(params: { tree: MCTSSearchTree; parentNode: SearchNode; config?: unknown }): Promise<SearchNode[]>;
    backpropagate(params: {
      tree: MCTSSearchTree;
      leafNode: SearchNode;
      rewardEvidence: SearchNodeRewardEvidence;
    }): void;
  };
  checkpointService?: {
    getCheckpoint?(id: string): ExecutionCheckpoint | undefined;
    computeDigest?(checkpoint: ExecutionCheckpoint): string;
  };
  dispatch: (request: DistributedBranchRequest, workerId?: string) => Promise<DistributedBranchResult>;
  workers?: () => Array<{
    id: string;
    computerId?: string;
    capacity?: number;
    modelIds?: string[];
    runtimeIds?: string[];
    capabilities?: string[];
    hardware?: {
      cpu?: string;
      cpuCores?: number;
      memoryGB?: number;
      gpu?: { model: string; count: number; memoryGB: number };
    };
  }>;
  persist?: (state: DistributedSearchState) => Promise<void>;
  load?: (searchId: string) => Promise<DistributedSearchState | undefined>;
  onEvent?: (event: DistributedSearchEvent) => void;
  leaseTtlMs?: number;
  maxConcurrentExpansions?: number;
}
