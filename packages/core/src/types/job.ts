import type { Task, TaskStatus, WorkspaceMode } from './task.js';

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
  type: 'task' | 'aggregator' | 'evaluator' | 'supervisor';
  taskId?: string;
  agentId?: string;
  state: AgentState;
  dependencies: string[];
  children: string[];
  result?: unknown;
  error?: string;
  attempts?: Array<{ state: AgentState; error?: string; executedAt?: Date; completedAt?: Date }>;
  executedAt?: Date;
  completedAt?: Date;
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

export interface JobTaskOutcome {
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
  | 'task:scheduled'
  | 'task:started'
  | 'task:progress'
  | 'task:completed'
  | 'task:failed'
  | 'task:retry'
  | 'task:replan'
  | 'task:cancelled'
  | 'task:steered';

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
}

