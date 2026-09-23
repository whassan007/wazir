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
  parentExecutionId?: string;
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
  provenance?: Record<string, unknown>;
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

export interface WorkspaceState {
  workspaceId: string;
  revision: number;
  contentFingerprint?: string;
  updatedAt: Date;
}

export interface FileMutationHistoryEntry {
  path: string;
  revision: number;
  at: Date;
}

export type EvidenceType = 'BUILD' | 'TEST' | 'RUN' | 'STATIC_CHECK';

export interface VerificationEvidence {
  id: string;
  type: EvidenceType;
  executionId?: string;
  workspaceId?: string;
  revision: number;
  command?: string;
  exitCode: number;
  durationMs?: number;
  startedAt?: Date;
  completedAt?: Date;
  output?: string;
  artifactFingerprint?: string;
  metadata?: Record<string, unknown>;
}

export interface AcceptanceContract {
  taskType?: string;
  requiredEvidence: EvidenceType[];
}

export interface EvaluationResult {
  success: boolean;
  reasons: string[];
  filesChanged: string[];
  checks: CheckRunRecord[];
  evaluatedAt: Date;
  workspaceRevision?: number;
  latestSuccessfulBuildRevision?: number | null;
  evidence?: VerificationEvidence[];
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
  workspaceState?: WorkspaceState;
  evidence?: VerificationEvidence[];
  acceptanceContract?: AcceptanceContract;
  mutationHistory?: FileMutationHistoryEntry[];
}

export type ExecutionEventType =
  | 'mcp.event'
  | 'execution.created'
  | 'execution.scheduled'
  | 'execution.assigned'
  | 'context.compiled'
  | 'policy.decision'
  | 'agent.phase'
  | 'agent.turn'
  | 'model.lifecycle'
  | 'WAITING_FOR_MODEL'
  | 'model.loading'
  | 'model.loaded'
  | 'generation.started'
  | 'generation.token'
  | 'tool.started'
  | 'tool.completed'
  | 'files.changed'
  | 'check.completed'
  | 'evaluation.completed'
  | 'generation.completed'
  | 'execution.completed'
  | 'execution.failed'
  | 'execution.cancelled'
  | 'workspace.revision_changed'
  | 'WORKSPACE_REVISION_CHANGED'
  | 'file.changed'
  | 'FILE_CHANGED'
  | 'build.started'
  | 'BUILD_STARTED'
  | 'build.completed'
  | 'BUILD_COMPLETED'
  | 'test.started'
  | 'TEST_STARTED'
  | 'test.completed'
  | 'TEST_COMPLETED'
  | 'verification.started'
  | 'VERIFICATION_STARTED'
  | 'verification.passed'
  | 'VERIFICATION_PASSED'
  | 'verification.failed'
  | 'VERIFICATION_FAILED'
  | 'evidence.stale'
  | 'EVIDENCE_STALE'
  | 'completion.rejected'
  | 'COMPLETION_REJECTED';

export interface ExecutionEvent {
  id: string;
  executionId: string;
  type: ExecutionEventType;
  timestamp: Date;
  data?: unknown;
}
