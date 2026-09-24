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
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ExecutionOwner {
  pid: number;
  host: string;
}

export interface Execution {
  id: string;
  jobId?: string;
  taskId: string;
  parentExecutionId?: string;
  agentId?: string;
  /** Absent for an execution routed to a hosted provider (no Computer). */
  computerId?: string;
  runtimeId: string;
  modelId: string;
  workerId?: string;
  /**
   * Absolute directory the execution's tools operated in (the project root, or a job
   * task's worktree). Lets recovery inspect the right files for an unknown outcome.
   */
  workspaceRoot?: string;
  /**
   * The process that last wrote this execution. Several `wa` processes share one store;
   * a process starting up must not "recover" an execution another live process is still
   * running (see ExecutionEngine.ownedByAnotherLiveProcess).
   */
  owner?: ExecutionOwner;
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
  callId?: string;
  failureClass?: import('@wazir/shared').FailureClass;
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

export interface ToolCallCheckpoint {
  executionId: string;
  stepId: string;
  callId: string;
  toolName: string;
  argumentsHash: string;
  startedAt: Date;
  finishedAt?: Date;
  state: 'STARTED' | 'COMPLETED' | 'FAILED' | 'OUTCOME_UNKNOWN';
  sideEffectClass: import('./tool.js').ToolSideEffectClass;
  workspaceRevision: number;
  input: unknown;
  legacyCorrelation?: boolean;
}

export interface CheckRunRecord {
  /** Captured before dispatch, not inferred from the revision at result ingestion. */
  workspaceRevision?: number;
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

import type { EvidenceType, VerificationEvidence } from './verification.js';
export type { EvidenceType, VerificationEvidence };

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
  /** Compare-and-swap revision for the existing durable record store. */
  storageRevision?: number;
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
  | 'execution.started'
  | 'execution.resumed'
  | 'execution.paused'
  | 'execution.steered'
  | 'execution.checkpoint.created'
  | 'execution.forked'
  | 'execution.rollback.completed'
  | 'execution.rollback.rejected'
  | 'turn.started' | 'turn.completed'
  | 'step.started' | 'step.completed' | 'step.failed'
  | 'model.requested' | 'model.attempt.started' | 'model.attempt.failed'
  | 'model.response.completed' | 'model.route.changed'
  | 'tool.call.requested' | 'tool.call.validated' | 'tool.call.started'
  | 'tool.call.completed' | 'tool.call.failed' | 'tool.call.outcome_unknown'
  | 'workspace.mutated' | 'workspace.revision.changed'
  | 'verification.completed' | 'verification.invalidated'
  | 'codemode.started' | 'codemode.completed'
  | 'codemode.operation.started' | 'codemode.operation.output'
  | 'codemode.operation.completed' | 'codemode.operation.failed'
  | 'runtime.protocol.selected' | 'tool_surface.compiled'
  | 'action.received' | 'action.validation_failed' | 'runtime.protocol.fallback'
  | 'solution_search.started' | 'solution_search.checkpoint_created'
  | 'solution_search.paused' | 'solution_search.resumed' | 'solution_search.cancelled'
  | 'candidate.created' | 'candidate.started' | 'candidate.steered'
  | 'candidate.cancelled' | 'candidate.completed' | 'candidate.failed'
  | 'candidate.verified' | 'candidate.evaluated' | 'candidate.promoted'
  | 'solution_search.frontier_computed' | 'solution_search.selection_made'
  | 'candidate.promotion_started' | 'candidate.promotion_completed' | 'candidate.promotion_failed'
  | 'solution_search.budget_exhausted' | 'solution_search.completed'
  | 'retry.scheduled' | 'retry.exhausted'
  | 'policy.allowed' | 'policy.denied' | 'policy.approval_required'
  | 'lease.acquired' | 'lease.renewed' | 'lease.released'
  | 'context.compacted' | 'budget.warning' | 'budget.exhausted'
  | 'context.snapshot.created' | 'context.threshold.reached'
  | 'context.compaction.started' | 'context.compaction.completed' | 'context.compaction.failed'
  | 'context.tool_result.offloaded' | 'context.tool_result.pruned' | 'context.deduplicated'
  | 'context.compile.started' | 'context.compile.completed' | 'context.item.included' | 'context.item.omitted'
  | 'context.superseded.removed' | 'context.file.truncated' | 'context.history.compressed'
  | 'context.revision.started' | 'context.revision.completed'
  | 'termination.requested' | 'termination.completed'
  | 'mcp.event'
  | 'web.search.started' | 'web.search.completed' | 'web.search.failed' | 'web.search.retry'
  | 'web.fetch.started' | 'web.fetch.completed' | 'web.fetch.failed' | 'web.fetch.retry'
  | 'web.extract.completed' | 'web.content.truncated' | 'web.evidence' | 'web.context' | 'web.answer' | 'web.request'
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
  | 'tool.unknownOutcome'
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
  | 'COMPLETION_REJECTED'
  | 'meta.opportunity.detected'
  | 'meta.hypothesis.created'
  | 'meta.experiment.started'
  | 'meta.baseline.recorded'
  | 'meta.candidate.created'
  | 'meta.candidate.verified'
  | 'meta.candidate.evaluated'
  | 'meta.candidate.rejected'
  | 'meta.candidate.qualified'
  | 'meta.promotion.started'
  | 'meta.promotion.completed'
  | 'meta.promotion.failed'
  | 'meta.rollback'
  | 'meta.learning.recorded';

export interface ExecutionEvent {
  id: string;
  executionId: string;
  type: ExecutionEventType;
  timestamp: Date;
  data?: unknown;
  /** Optional only for records written before the sequenced event migration. */
  eventId?: string;
  eventType?: ExecutionEventType;
  sequence?: number;
  /** null denotes a standalone execution, not an invented job. */
  jobId?: string | null;
  turnId?: string;
  stepId?: string;
  attemptId?: string;
  callId?: string;
  agentId?: string;
  modelId?: string;
  runtimeId?: string;
  computerId?: string;
  workerId?: string;
  workspaceRevision?: number;
}

/** Envelope emitted by ExecutionEngine; legacy records are normalized on load. */
export interface SequencedExecutionEvent extends ExecutionEvent {
  eventId: string;
  eventType: ExecutionEventType;
  sequence: number;
  jobId: string | null;
}

export interface ExecutionEventIdentity {
  eventId?: string;
  turnId?: string;
  stepId?: string;
  attemptId?: string;
  callId?: string;
}
