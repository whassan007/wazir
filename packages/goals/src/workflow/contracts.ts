import type {
  EvidenceRecord,
  GoalGraphDefinition,
  GoalGraphRevisionRecord,
  GoalRunId,
  GoalRunLedger,
  GoalRunStatus,
  GoalStudioEvent,
  GoalTarget,
  GraphId,
  GraphValidationResult,
  TargetId,
} from '../contracts.js';
import type { DeclaredCheck } from '../verification/types.js';

export type WorkflowMode = 'single' | 'loop' | 'graph' | 'hybrid';
export type RequestedWorkflowMode = 'auto' | WorkflowMode;
export type WorkflowOriginInterface = 'shell' | 'cli' | 'tui' | 'api' | 'web' | 'desktop';

export interface WorkflowCompileRequest {
  prompt: string;
  requestedMode?: RequestedWorkflowMode;
  overrideMode?: WorkflowMode;
  originInterface?: WorkflowOriginInterface;
  workspaceRoot: string;
  projectId?: string;
  graphName?: string;
  actor?: string;
  maxIterations?: number;
  maxConcurrency?: number;
  maxDurationMinutes?: number;
  maxBudgetUsd?: number;
  maxRepairsPerTask?: number;
  maxSameActionNoProgress?: number;
  dryRun?: boolean;
  approveAll?: boolean;
  localModelFirst?: boolean;
  preferredModel?: string;
  computer?: string;
  items?: string[];
  completionCondition?: string;
  allowProductionDeploy?: boolean;
  verifyCommands?: string[];
}

export interface LoopItemSpec {
  index: number;
  targetId: TargetId;
  itemId: string;
  label: string;
  path?: string;
  kind: 'city' | 'file' | 'module' | 'service' | 'endpoint' | 'iteration' | 'item';
  metadata?: Record<string, unknown>;
}

export interface LoopPlanSpec {
  kind: 'collection' | 'predicate' | 'bounded_iterations';
  collectionSource?: string;
  completionPredicate: string;
  maxIterations: number;
  maxConcurrency: number;
  cursor: number;
  items: LoopItemSpec[];
}

export interface GoalIntentAnalysis {
  selectedMode: WorkflowMode;
  overridden: boolean;
  confidence: number;
  reasons: string[];
  signals: {
    loopSignals: string[];
    graphSignals: string[];
    iterativeTargetsCount: number;
    dependencyCount: number;
    policyFlags: string[];
  };
  policyAssessment: {
    localModelFirst: boolean;
    requiresApprovalGates: string[];
    hostedSpendUsd: number;
    blockedUnsafeActions: string[];
  };
}

export interface WorkflowTargetCheckMap {
  [targetId: TargetId]: DeclaredCheck[];
}

export interface WorkflowPlanRecord {
  format: 1;
  runId?: GoalRunId;
  graphId: GraphId;
  graphRevision: number;
  projectId: string;
  prompt: string;
  originInterface: WorkflowOriginInterface;
  mode: WorkflowMode;
  requestedMode: RequestedWorkflowMode;
  overridden: boolean;
  explanation: GoalIntentAnalysis;
  dryRun: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  preferredModel?: string;
  preferredComputer?: string;
  localModelFirst: boolean;
  allowProductionDeploy: boolean;
  loop?: LoopPlanSpec;
  nestedLoops?: Array<{ targetId: TargetId; loop: LoopPlanSpec }>;
  targetChecks: WorkflowTargetCheckMap;
  criticalPath: {
    targets: TargetId[];
    depth: number;
  };
  topologicalOrder: TargetId[];
  verifyCommands: string[];
  lastError?: string;
}

export interface WorkflowCompiledBundle {
  definition: GoalGraphDefinition;
  validation: GraphValidationResult;
  plan: Omit<WorkflowPlanRecord, 'graphId' | 'graphRevision' | 'runId' | 'createdAt' | 'updatedAt'>;
}

export interface WorkflowControlSignal {
  runId: GoalRunId;
  action: 'pause' | 'stop' | 'resume';
  actor: string;
  reason?: string;
  requestedAt: string;
  acknowledgedAt?: string;
}

export interface WorkflowJobSummary {
  runId: GoalRunId;
  graphId: GraphId;
  graphRevision: number;
  projectId: string;
  mode: WorkflowMode;
  originInterface: WorkflowOriginInterface;
  status: GoalRunStatus;
  prompt: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  progress: {
    total: number;
    completed: number;
    active: number;
    blocked: number;
    failed: number;
    queued: number;
    needsApproval: number;
    cursor?: number;
  };
}

export interface WorkflowInspection {
  summary: WorkflowJobSummary;
  run: GoalRunLedger;
  graph: GoalGraphRevisionRecord;
  plan?: WorkflowPlanRecord;
  targets: GoalTarget[];
  evidence: EvidenceRecord[];
  events: GoalStudioEvent[];
}

export interface WorkflowTargetExecutionResult {
  ok: boolean;
  summary: string;
  claimedDone?: boolean;
  filesWritten?: string[];
  output?: unknown;
  executorIdentity?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    failureClass?: string;
  };
}

export type WorkflowTargetHandler = (ctx: {
  run: GoalRunLedger;
  target: GoalTarget;
  attempt: number;
  repairHypothesis?: string;
  plan?: WorkflowPlanRecord;
  loopItem?: LoopItemSpec;
  workspaceRoot: string;
  artifactDir: string;
  model?: { modelId: string; runtimeId: string; computerId: string; hosted: boolean };
  signal: AbortSignal;
}) => Promise<WorkflowTargetExecutionResult>;

export const WORKFLOW_STORE_KEYS = {
  run: (runId: GoalRunId) => `goals/workflows/runs/${runId}`,
  runsPrefix: 'goals/workflows/runs/',
  compiled: (graphId: GraphId, revision: number) => `goals/workflows/compiled/${graphId}/${revision}`,
  control: (runId: GoalRunId) => `goals/workflows/control/${runId}`,
} as const;
