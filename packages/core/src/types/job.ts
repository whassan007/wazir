import type { Task, TaskStatus, WorkspaceMode, TaskRequirements } from './task.js';

export type { Task, TaskStatus, WorkspaceMode };
import type { PolicyDecision } from './policy.js';
import type { ExecutionRecord } from './execution.js';
import type { AgentErrorKind } from './agent.js';
import type { PromptBreakdown } from './context.js';

export type JobStatus =
  | 'pending'
  | 'planning'
  | 'ready'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskGraphEdge = {
  from: string;
  to: string;
  condition?: 'success' | 'failure' | 'always';
};

export type AgentState =
  | 'idle'
  | 'assigned'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JobGraph {
  nodes: JobNode[];
  edges: TaskGraphEdge[];
}

export interface JobNode {
  id: string;
  parentId?: string;
  type: 'task' | 'aggregator' | 'evaluator' | 'supervisor';
  taskId?: string;
  agentId?: string;
  requirements?: TaskRequirements;
  state: AgentState;
  dependencies: string[];
  children: string[];
  inputs?: unknown;
  result?: unknown;
  artifacts?: string[];
  evidence?: string[];
  error?: string;
  retryCount?: number;
  attempts?: Array<{
    state: AgentState;
    error?: string;
    executedAt?: Date;
    completedAt?: Date;
    /** Recovery controller decision for this failed attempt (absent on records written before it existed). */
    recovery?: TaskAttemptRecovery;
  }>;
  /** Recovery decision that stopped this node, when it failed terminally. */
  lastRecovery?: TaskAttemptRecovery;
  /** 0 for planned tasks; n for a repair task created by the n-th replan in its lineage. */
  replanGeneration?: number;
  /** Verification report of the attempt that settled this node, when the executor produced one. */
  verification?: TaskVerificationReport;
  executedAt?: Date;
  completedAt?: Date;
  workspaceRevision?: string;
}

export interface JobMessage {
  id: string;
  jobId: string;
  taskId?: string;
  fromAgent?: string;
  toAgent?: string;
  type:
    | 'task_assignment'
    | 'task_update'
    | 'task_result'
    | 'task_failure'
    | 'question'
    | 'request_review'
    | 'review_result'
    | 'blocked'
    | 'handoff'
    | 'cancel'
    | 'dependency_ready';
  payload: unknown;
  artifactReferences?: string[];
  priority: 'low' | 'normal' | 'high' | 'critical';
  timestamp: Date;
}

export interface AgentHandoff {
  sourceNodeId: string;
  targetNodeId: string;
  findings: {
    description: string;
    type: 'claim' | 'observation' | 'artifact' | 'verified_evidence';
    evidenceRefs?: string[]; // references to JobArtifact ids
  }[];
  artifactRefs: string[]; // JobArtifact ids
  evidenceRefs: string[]; // JobArtifact ids that are evidence
  changedFiles: string[]; // file paths
  workspaceRevision: string; // commit hash or checkpoint id
  unresolvedQuestions: string[];
  constraints: string[];
  generatedAt: Date;
}

export interface JobArtifact {
  id: string;
  jobId: string;
  taskId?: string;
  name: string;
  path: string;
  type: 'json' | 'markdown' | 'text' | 'diff' | 'binary';
  sizeBytes: number;
  mimeType: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface JobSession {
  sessionId: string;
  jobId: string;
  context: unknown[];
  artifacts: string[];
  messages: string[];
}

export interface Job {
  revision?: number;
  control?: { cancelRequestedAt?: number };
  ownership?: { ownerId: string; epoch: number; expiresAt: number };
  id: string;
  title: string;
  description?: string;
  status: JobStatus;
  tasks: Task[];
  graph: JobGraph;
  messages: JobMessage[];
  artifacts: JobArtifact[];
  sessions: JobSession[];
  rootTaskId: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  concurrencyLimit?: number;
  maxRetries?: number;
  timeoutSeconds?: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  /** Written by the orchestrator when the job settles. */
  verification?: JobVerificationReport;
}

export interface OrchestratorState {
  jobs: Map<string, Job>;
  tasks: Map<string, Task>;
  executions: Map<string, ExecutionRecord>;
  messages: Map<string, JobMessage[]>;
  artifacts: Map<string, JobArtifact[]>;
}

export interface AgentAssignment {
  jobId: string;
  taskId: string;
  agentId: string;
  modelId: string;
  runtimeId: string;
  /** Absent for an assignment routed to a hosted provider (no Computer). */
  computerId?: string;
  assignedAt: Date;
  policy: PolicyDecision[];
}

export interface JobRollup {
  jobId: string;
  taskCount: number;
  completedTasks: number;
  failedTasks: number;
  runningTasks: number;
  queuedTasks: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  durationMs: number;
  estimatedCostUsd: number;
  tokensPerSecond: number;
  computersUsed: string[];
  modelsUsed: string[];
  filesChanged: string[];
}

export interface JobTaskProgressEvent {
  kind: string;
  phase?: string;
  content?: string;
  tool?: string;
  error?: string;
  usage?: { input: number; output: number; total: number };
  breakdown?: PromptBreakdown;
  /** Raw model response text this progress event was produced from, when available. */
  raw?: string;
  metadata?: Record<string, unknown>;
}

export interface JobTaskExecutionContext {
  jobId: string;
  taskId: string;
  node: JobNode;
  assignment: AgentAssignment;
  signal?: AbortSignal;
  onProgress?: (event: JobTaskProgressEvent) => void;
  getSteeringInstruction?: () => string | undefined;
  projectRoot?: string;
  worktreeDir?: string;
  workspaceMode?: WorkspaceMode;
  mutationRequired?: boolean;
  previousOutcomes?: Map<string, JobTaskOutcome>;
}

/** Outcome of checking a task against deterministic evidence, never against model prose. */
export type VerificationVerdict =
  /** Every evaluated criterion passed and at least one criterion had evidence. */
  | 'VERIFIED'
  /** At least one criterion failed. */
  | 'FAILED'
  /** Nothing could be checked (no checks, artifacts or acceptance criteria): success is unproven. */
  | 'INCONCLUSIVE'
  /** Verification could not run (policy, approval, cancellation, unreconciled side effects). */
  | 'BLOCKED';

export interface AcceptanceCriterionResult {
  id: string;
  description: string;
  status: 'passed' | 'failed' | 'unverified';
  evidence: string[];
}

export interface TaskVerificationReport {
  schemaVersion: 1;
  verdict: VerificationVerdict;
  /** What the model said: it ended with a completion turn. A hypothesis, not evidence. */
  modelReportedSuccess: boolean;
  /** Every tool call the controller executed returned ok (undefined when none ran). */
  toolExecutionSuccess?: boolean;
  /** Every test check passed (undefined when no test ran). */
  testSuccess?: boolean;
  /** The deterministic evaluator accepted the execution. */
  evaluationSuccess: boolean;
  criteria: AcceptanceCriterionResult[];
  workspaceRevision?: number;
  executionId?: string;
  reasons: string[];
  generatedAt: string;
}

export interface TaskAttemptRecovery {
  category: string;
  failureClass?: string;
  terminationReason?: string;
  signature: string;
  strategy: string;
  reason: string;
  delayMs: number;
}

/** Machine-readable verification summary persisted on the job when it settles. */
export interface JobVerificationReport {
  schemaVersion: 1;
  jobId: string;
  verdict: VerificationVerdict | 'UNVERIFIED';
  tasks: Array<{
    taskId: string;
    state: AgentState;
    superseded: boolean;
    /** 'UNVERIFIED' when the executor did not produce a report (legacy/custom executors). */
    verdict: VerificationVerdict | 'UNVERIFIED' | 'NOT_RUN';
    attempts: number;
    recoveries: TaskAttemptRecovery[];
    report?: TaskVerificationReport;
  }>;
  generatedAt: string;
}

export interface SupervisorDecision {
  decision: 'approve' | 'reject';
  reason: string;
}

export interface JobTaskOutcome {
  /** Required for a supervisor node; only approve may release dependent work. */
  supervisorDecision?: SupervisorDecision;
  success: boolean;
  result?: unknown;
  error?: string;
  /** Coarse classification of `error`, when the executor can tell — e.g. distinguishing
   *  "the model never produced a parseable action" (protocol) from "a real check failed"
   *  (verification) from "policy said no" (policy). Retry decisions currently still fall
   *  back to sniffing `error`/`reasons` text when this is absent (not every executor sets
   *  it), but a structured kind is preferred wherever one is available. */
  errorKind?: AgentErrorKind;
  reasons?: string[];
  filesChanged?: string[];
  usage?: { input: number; output: number; total: number };
  /** Shared failure taxonomy class, when the executor knows it precisely. */
  failureClass?: import('@wazir/shared').FailureClass;
  /** Why the agent loop stopped, when it ran one. */
  terminationReason?: import('./agent.js').TerminationReason;
  /** Evidence-based verification of this attempt. A FAILED or BLOCKED verdict is never
   *  accepted as success by the orchestrator, whatever `success` says. */
  verification?: TaskVerificationReport;
}

export type JobTaskExecutor = (
  task: Task,
  context: JobTaskExecutionContext
) => Promise<JobTaskOutcome>;

export type JobOrchestratorEventType =
  | 'job:started'
  | 'job:completed'
  | 'job:failed'
  | 'job:cancelled'
  | 'job:paused'
  | 'job:resumed'
  | 'job:checkpoint'
  | 'job:fork'
  | 'job:rollback'
  | 'task:scheduled'
  | 'task:started'
  | 'task:progress'
  | 'task:completed'
  | 'task:failed'
  | 'task:retry'
  /** A failed attempt was classified and a bounded recovery decision taken (event = TaskAttemptRecovery). */
  | 'task:recovery'
  | 'task:replan'
  | 'task:cancelled'
  | 'task:steered'
  | 'task:checkpoint'
  | 'task:fork'
  | 'task:rollback';

export interface JobOrchestratorEvent {
  type: JobOrchestratorEventType;
  jobId: string;
  taskId?: string;
  agentId?: string;
  computerId?: string;
  modelId?: string;
  phase?: string;
  event?: unknown;
  result?: unknown;
  error?: string;
  retryCount?: number;
  maxRetries?: number;
  instruction?: string;
  filesChanged?: string[];
  usage?: { input: number; output: number; total: number };
  breakdown?: PromptBreakdown;
  timestamp?: Date;
}

import type { JobTaskInput } from '../services/jobManager.js';
export type { JobTaskInput };

export type TaskReplanner = (context: {
  job: Job;
  failedTask: Task;
  node: JobNode;
  outcome: JobTaskOutcome;
}) => Promise<{ repairTasks: JobTaskInput[] } | null | undefined>;

export interface JobRunOptions {
  concurrencyLimit?: number;
  taskExecutor?: JobTaskExecutor;
  signal?: AbortSignal;
  onEvent?: (event: JobOrchestratorEvent) => void;
  /** Overrides job.timeoutSeconds for this run; falls back to a built-in default if neither is set. */
  timeoutSeconds?: number;
  replanner?: TaskReplanner;
  /** Overrides the default bounded recovery policy (backoff, no-progress detection). */
  recoveryPolicy?: import('../services/taskRecoveryPolicy.js').TaskRecoveryPolicy;
  /** Replans allowed along one task lineage before failures fall back to bounded retry. Default 2. */
  maxReplanGeneration?: number;
  /** When true, an INCONCLUSIVE verification report fails the task instead of passing it. */
  requireVerifiedCompletion?: boolean;
}

