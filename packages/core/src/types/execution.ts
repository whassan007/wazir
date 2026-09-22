import type { Task } from './task.js';
import type { SchedulerDecision } from './scheduler.js';
import type { ContextDecision } from './context.js';
import type { PolicyDecision, PolicyEffect } from './policy.js';

export type ExecutionStatus =
  | 'queued'
  | 'scheduled'
  | 'assigned'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Execution {
  id: string;
  taskId: string;
  agentId?: string;
  /** Absent for an execution routed to a hosted provider (no Computer). */
  computerId?: string;
  runtimeId: string;
  modelId: string;
  workerId?: string;
  status: ExecutionStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface TokenUsage {
  input: number;
  output: number;
  total?: number;
}

export interface ToolCallRecord {
  id: string;
  tool: string;
  input: unknown;
  output?: string;
  ok: boolean;
  error?: string;
  policyEffect: PolicyEffect;
  policyRule: string;
  durationMs: number;
  at: Date;
  /** OS isolation the tool process ran under (`bwrap`, `sandbox-exec`, `none`); absent for in-process tools. */
  sandbox?: string;
  /** Unique ID assigned to this shell/process invocation for tracing. */
  shellInvocationId?: string;
  /** Effective working directory the tool executed in. */
  cwd?: string;
  /** Effective project root for containment. */
  projectRoot?: string;
  /** Process exit code when applicable. */
  exitCode?: number;
}

export interface CheckRunRecord {
  name: 'test' | 'lint' | 'typecheck' | 'build';
  command: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

export interface EvaluationResult {
  success: boolean;
  reasons: string[];
  filesChanged: string[];
  checks: CheckRunRecord[];
  evaluatedAt: Date;
}

/** Durable execution record — the source of truth for inspect/replay. */
export interface ExecutionRecord {
  execution: Execution;
  task: Task;
  scheduling?: SchedulerDecision;
  context?: ContextDecision;
  policyDecisions: PolicyDecision[];
  toolCalls: ToolCallRecord[];
  filesChanged: string[];
  checks: CheckRunRecord[];
  errors: string[];
  result?: string;
  evaluation?: EvaluationResult;
  usage?: TokenUsage;
  events: ExecutionEvent[];
}

export type ExecutionEventType =
  | 'execution.created'
  | 'execution.scheduled'
  | 'execution.assigned'
  | 'context.compiled'
  | 'policy.decision'
  | 'agent.phase'
  | 'agent.turn'
  | 'model.loading'
  | 'model.loaded'
  | 'generation.started'
  | 'generation.token'
  | 'tool.started'
  | 'tool.completed'
  | 'check.completed'
  | 'evaluation.completed'
  | 'generation.completed'
  | 'execution.completed'
  | 'execution.failed'
  | 'execution.cancelled';

export interface ExecutionEvent {
  id: string;
  executionId: string;
  type: ExecutionEventType;
  timestamp: Date;
  data?: unknown;
}
