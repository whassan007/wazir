import type { Task, TaskStatus } from './task.js';

export type { Task, TaskStatus };
import type { PolicyDecision } from './policy.js';
import type { ExecutionRecord } from './execution.js';

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
  computerId: string;
  assignedAt: Date;
  policy: PolicyDecision[];
}
