import type { ExecutionRecord, ToolCallCheckpoint } from '../types/execution.js';

/**
 * Event-derived execution reconstruction and recovery planning.
 *
 * After a process or worker failure, the execution record's durable facts — not the
 * agent transcript, not the UI — decide what is true and what is safe:
 *   - the last confirmed workspace revision
 *   - the last confirmed tool result
 *   - tool calls dispatched with no confirmed outcome
 *   - the current lease holder, if lease events were recorded
 *   - which verification evidence is current for that revision
 *   - how much of each budget is already consumed
 *
 * A dispatched non-read-only call with no confirmed outcome blocks resumption until it
 * is reconciled from physical evidence (see ExecutionEngine.reconcileToolCall); it is
 * never replayed on the assumption that it didn't happen.
 */

/** Result of inspecting physical state for one unresolved tool call. */
export interface ToolOutcomeInspection {
  /** APPLIED: the side effect is present. NOT_APPLIED: provably absent, safe to redo.
   *  UNDETERMINED: physical state can't prove either — requires an operator. */
  outcome: 'APPLIED' | 'NOT_APPLIED' | 'UNDETERMINED';
  evidence: string;
}

export interface RecoveryBudgetLimits {
  maxModelRequests?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxWallClockMs?: number;
}

export interface ReconstructedExecutionState {
  executionId: string;
  jobId: string | null;
  status: string;
  terminal: boolean;
  workspaceRevision: number;
  lastConfirmedToolResult: { callId: string | null; tool: string; ok: boolean; at: Date } | null;
  unresolvedToolCalls: Array<Pick<ToolCallCheckpoint, 'callId' | 'toolName' | 'sideEffectClass' | 'workspaceRevision' | 'state' | 'startedAt'>>;
  lease: { holder: string | null; state: 'acquired' | 'renewed' | 'released'; at: Date } | null;
  verification: {
    /** Passing check kinds whose evidence was produced at the current revision. */
    currentPassing: string[];
    /** Check kinds whose latest result at the current revision failed. */
    currentFailing: string[];
    /** Checks run against an older revision — stale for completion. */
    staleChecks: number;
  };
  consumed: { modelRequests: number; toolCalls: number; tokens: number; wallClockMs: number | null };
  remaining: { modelRequests: number | null; toolCalls: number | null; tokens: number | null; wallClockMs: number | null };
}

export interface RecoveryPlan {
  action: 'none' | 'resume' | 'reconcile' | 'terminate';
  reasons: string[];
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const eventType = (e: ExecutionRecord['events'][number]): string => e.eventType ?? e.type;

export function reconstructExecutionState(
  record: ExecutionRecord,
  checkpoints: ToolCallCheckpoint[],
  limits: RecoveryBudgetLimits = {},
  now: Date = new Date(),
): ReconstructedExecutionState {
  const events = [...record.events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  let workspaceRevision = 0;
  let lastConfirmedToolResult: ReconstructedExecutionState['lastConfirmedToolResult'] = null;
  let lease: ReconstructedExecutionState['lease'] = null;
  let modelRequests = 0;

  for (const event of events) {
    const type = eventType(event);
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (type === 'workspace.revision.changed' && typeof data.workspaceRevision === 'number') {
      workspaceRevision = Math.max(workspaceRevision, data.workspaceRevision);
    } else if (type === 'tool.call.completed' || type === 'tool.call.failed') {
      lastConfirmedToolResult = {
        callId: typeof data.callId === 'string' ? data.callId : event.callId ?? null,
        tool: typeof data.tool === 'string' ? data.tool : 'unknown',
        ok: type === 'tool.call.completed',
        at: new Date(event.timestamp),
      };
    } else if (type === 'lease.acquired' || type === 'lease.renewed' || type === 'lease.released') {
      lease = {
        holder: typeof data.workerId === 'string' ? data.workerId : event.workerId ?? null,
        state: type.slice('lease.'.length) as 'acquired' | 'renewed' | 'released',
        at: new Date(event.timestamp),
      };
    } else if (type === 'generation.started') {
      modelRequests += 1;
    }
  }
  // The record's own revision is written by the same mutation path; prefer the larger
  // so a legacy record without revision events still reconstructs correctly.
  workspaceRevision = Math.max(workspaceRevision, record.workspaceState?.revision ?? 0);

  const latestAtRevision = new Map<string, boolean>();
  let staleChecks = 0;
  for (const check of record.checks) {
    if ((check.workspaceRevision ?? -1) === workspaceRevision) latestAtRevision.set(check.name, check.ok);
    else staleChecks += 1;
  }

  const unresolvedToolCalls = checkpoints
    .filter((c) => c.state === 'STARTED' || c.state === 'OUTCOME_UNKNOWN')
    .map(({ callId, toolName, sideEffectClass, workspaceRevision: rev, state, startedAt }) => ({ callId, toolName, sideEffectClass, workspaceRevision: rev, state, startedAt }));

  const start = record.execution.startedAt ?? record.execution.createdAt;
  const end = record.execution.completedAt ?? now;
  const wallClockMs = start ? Math.max(0, new Date(end).getTime() - new Date(start).getTime()) : null;
  const tokens = record.usage ? record.usage.total ?? record.usage.input + record.usage.output : 0;
  const toolCalls = record.toolCalls.length;
  const left = (limit: number | undefined, used: number | null) => (limit === undefined || used === null ? null : Math.max(0, limit - used));

  return {
    executionId: record.execution.id,
    jobId: record.execution.jobId ?? null,
    status: record.execution.status,
    terminal: TERMINAL.has(record.execution.status),
    workspaceRevision,
    lastConfirmedToolResult,
    unresolvedToolCalls,
    lease,
    verification: {
      currentPassing: [...latestAtRevision].filter(([, ok]) => ok).map(([name]) => name).sort(),
      currentFailing: [...latestAtRevision].filter(([, ok]) => !ok).map(([name]) => name).sort(),
      staleChecks,
    },
    consumed: { modelRequests, toolCalls, tokens, wallClockMs },
    remaining: {
      modelRequests: left(limits.maxModelRequests, modelRequests),
      toolCalls: left(limits.maxToolCalls, toolCalls),
      tokens: left(limits.maxTokens, tokens),
      wallClockMs: left(limits.maxWallClockMs, wallClockMs),
    },
  };
}

/**
 * What recovery may do with this execution. Resuming means continuing the SAME
 * execution (same id, workspace revision, evidence and consumed budgets) — never a
 * replacement that forgets what already happened.
 */
export function planRecovery(state: ReconstructedExecutionState): RecoveryPlan {
  if (state.terminal) return { action: 'none', reasons: [`execution is already ${state.status}`] };

  const blocking = state.unresolvedToolCalls.filter((c) => c.sideEffectClass !== 'READ_ONLY');
  if (blocking.length > 0) {
    return {
      action: 'reconcile',
      reasons: blocking.map((c) =>
        `'${c.toolName}' (${c.sideEffectClass}, call ${c.callId}) was dispatched at revision ${c.workspaceRevision} with no confirmed outcome; ` +
        'inspect physical state before anything else runs — it must not be replayed blindly',
      ),
    };
  }

  const exhausted = Object.entries(state.remaining).filter(([, value]) => value === 0).map(([name]) => name);
  if (exhausted.length > 0) {
    return { action: 'terminate', reasons: [`budget exhausted before recovery: ${exhausted.join(', ')}`] };
  }

  const reasons = [`resume at workspace revision ${state.workspaceRevision}`];
  if (state.verification.currentPassing.length > 0) reasons.push(`current evidence: ${state.verification.currentPassing.join(', ')} passing at this revision`);
  if (state.verification.staleChecks > 0) reasons.push(`${state.verification.staleChecks} check(s) are for older revisions and must be re-run`);
  const readOnlyInterrupted = state.unresolvedToolCalls.length - blocking.length;
  if (readOnlyInterrupted > 0) reasons.push(`${readOnlyInterrupted} interrupted read-only call(s) have no side effect and may simply be repeated`);
  return { action: 'resume', reasons };
}
