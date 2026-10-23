import { createHash } from 'node:crypto';
import type { ExecutionRecord, ToolCallCheckpoint } from '../types/execution.js';
import type { ExecutionEngine, ExecutionLease } from './executionEngine.js';
import { hashToolArguments } from './toolValidation.js';

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

function signalZeroAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function extractToolCheckpoints(record: Pick<ExecutionRecord, 'execution' | 'events'>): ToolCallCheckpoint[] {
  const executionId = record.execution.id;
  const calls = new Map<string, ToolCallCheckpoint>();
  for (const event of record.events ?? []) {
    const data = event.data as Partial<ToolCallCheckpoint> & { tool?: string; ok?: boolean; policyEffect?: string; failureClass?: string } | undefined;
    if (!data) continue;
    if (event.type === 'tool.started') {
      const callId = event.callId ?? data.callId ?? event.id;
      calls.set(callId, {
        executionId,
        callId,
        stepId: event.stepId ?? data.stepId ?? callId,
        toolName: data.toolName ?? data.tool ?? 'unknown',
        input: data.input,
        argumentsHash: data.argumentsHash ?? hashToolArguments(data.input),
        startedAt: data.startedAt instanceof Date ? data.startedAt : new Date(data.startedAt ?? event.timestamp),
        state: 'STARTED',
        workspaceRevision: data.workspaceRevision ?? event.workspaceRevision ?? 0,
        sideEffectClass: data.sideEffectClass ?? 'NON_IDEMPOTENT_WRITE',
        legacyCorrelation: data.legacyCorrelation ?? !event.callId,
      });
    } else if (event.type === 'tool.completed' || event.type === 'tool.unknownOutcome') {
      const callId = event.callId ?? data.callId;
      const call = callId
        ? calls.get(callId)
        : [...calls.values()].find(
            (c) => c.state === 'STARTED' && c.toolName === data.tool && data.policyEffect !== 'deny' && data.policyEffect !== 'ask',
          );
      if (!call) continue;
      call.state =
        event.type === 'tool.unknownOutcome' || data.failureClass === 'TOOL_OUTCOME_UNKNOWN'
          ? 'OUTCOME_UNKNOWN'
          : data.ok
            ? 'COMPLETED'
            : 'FAILED';
      if (event.type === 'tool.completed') {
        call.finishedAt = event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp);
      }
    }
  }
  return [...calls.values()];
}

export function findUnknownOutcomeToolCall(
  recordOrCheckpoints: Pick<ExecutionRecord, 'execution' | 'events'> | ToolCallCheckpoint[],
  options?: { mutatingOnly?: boolean },
): { tool: string; input: unknown; startedAt: Date; callId: string; sideEffectClass: ToolCallCheckpoint['sideEffectClass'] } | undefined {
  const checkpoints = Array.isArray(recordOrCheckpoints)
    ? recordOrCheckpoints
    : extractToolCheckpoints(recordOrCheckpoints);
  const mutatingOnly = options?.mutatingOnly ?? false;
  const call = checkpoints.find(
    (c) =>
      (c.state === 'STARTED' || c.state === 'OUTCOME_UNKNOWN') &&
      (!mutatingOnly || c.sideEffectClass !== 'READ_ONLY'),
  );
  return call
    ? {
        tool: call.toolName,
        input: call.input,
        startedAt: call.startedAt,
        callId: call.callId,
        sideEffectClass: call.sideEffectClass,
      }
    : undefined;
}

const ACTIVE_STANDALONE_STATUSES = new Set(['running', 'scheduled', 'waiting', 'assigned']);

export async function reconcileLocalOutcomes(
  executions: ExecutionEngine,
  inspect?: (record: ExecutionRecord, call: ToolCallCheckpoint) => Promise<ToolOutcomeInspection>,
  options?: { isProcessAlive?: (pid: number) => boolean; currentPid?: number },
): Promise<Array<{ executionId: string; callId: string; outcome: string }>> {
  const done: Array<{ executionId: string; callId: string; outcome: string }> = [];
  const engineInternal = executions as unknown as {
    owner?: { pid: number; host: string };
    isProcessAlive?: (pid: number) => boolean;
  };
  const isAlive = options?.isProcessAlive ?? engineInternal.isProcessAlive ?? signalZeroAlive;
  const currentPid = options?.currentPid ?? engineInternal.owner?.pid ?? process.pid;

  for (const record of await executions.list()) {
    if (executions.ownedByAnotherLiveProcess(record)) continue;
    const executionId = record.execution.id;
    const checkpoints = executions.toolCheckpoints(executionId);

    if (inspect) {
      for (const call of checkpoints) {
        if (call.state !== 'STARTED' && call.state !== 'OUTCOME_UNKNOWN') continue;
        const inspection = await inspect(record, call).catch(
          (): ToolOutcomeInspection => ({ outcome: 'UNDETERMINED', evidence: 'inspection failed' }),
        );
        if (inspection.outcome === 'UNDETERMINED') continue;
        await executions.reconcileToolCall(executionId, call.callId, {
          ...inspection,
          inspectedBy: 'startup-recovery',
        });
        done.push({ executionId, callId: call.callId, outcome: inspection.outcome });
      }
    }

    const owner = record.execution.owner;
    const ownerDeadOrMissing =
      !owner ||
      !isAlive(owner.pid) ||
      (owner.pid !== currentPid && !executions.ownedByAnotherLiveProcess(record));

    if (!record.execution.jobId && ACTIVE_STANDALONE_STATUSES.has(record.execution.status) && ownerDeadOrMissing) {
      const previousStatus = record.execution.status;
      const reason = owner
        ? `OWNER_PROCESS_EXITED: owning process ${owner.pid} exited while standalone execution was ${previousStatus}`
        : `OWNER_PROCESS_MISSING: standalone execution was left in '${previousStatus}' without a live owner`;
      await executions.orphan(executionId, reason);
      done.push({ executionId, callId: 'execution', outcome: 'ORPHANED' });
    } else if (
      !record.execution.jobId &&
      checkpoints.length === 0 &&
      record.execution.status === 'failed' &&
      record.events.some(
        (e) =>
          (e.eventType ?? e.type) === 'execution.failed' &&
          (e.data as { reason?: string } | undefined)?.reason === 'OWNER_PROCESS_EXITED',
      )
    ) {
      done.push({ executionId, callId: 'execution', outcome: 'ORPHANED' });
    }
  }

  return done;
}

// ============================================================================
// Portable Cross-Harness Operation Identity, Lease Fencing & Reconciliation
// ============================================================================

export type ClassifiedToolOutcome =
  | 'CONFIRMED_COMPLETED'
  | 'CONFIRMED_FAILED'
  | 'OUTCOME_UNKNOWN';

export interface OperationIdentityInput {
  executionId: string;
  callId?: string;
  toolName: string;
  argumentsHash?: string;
  input?: unknown;
  workspaceRevision: number | string;
}

export interface ConfirmedOperationReceipt {
  operationKey: string;
  semanticKey: string;
  executionId: string;
  callId: string;
  toolName: string;
  argumentsHash: string;
  workspaceRevision: number;
  outcome: 'APPLIED';
  output?: string;
  evidence: string;
  confirmedAt: string;
  sourceHarnessId?: string;
  sourceWorkerId?: string;
}

export interface DuplicateOperationCheckResult {
  duplicate: boolean;
  reason?: 'DUPLICATE_CALL_ID' | 'DUPLICATE_SEMANTIC_OPERATION';
  operationKey: string;
  semanticKey: string;
  receipt?: ConfirmedOperationReceipt;
}

/**
 * Computes the deterministic SHA-256 operation identity key:
 * `sha256(executionId + callId + toolName + argumentsHash + workspaceRevision)`
 */
export function computeOperationKey(params: OperationIdentityInput): string {
  const argsHash = params.argumentsHash ?? hashToolArguments(params.input);
  const callId = params.callId ?? '';
  const payload = `${params.executionId}:${callId}:${params.toolName}:${argsHash}:${String(params.workspaceRevision)}`;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Computes the semantic operation identity key across callIds at a given workspace revision:
 * `sha256(executionId + toolName + argumentsHash + workspaceRevision)`
 */
export function computeSemanticOperationKey(params: Omit<OperationIdentityInput, 'callId'>): string {
  const argsHash = params.argumentsHash ?? hashToolArguments(params.input);
  const payload = `${params.executionId}:${params.toolName}:${argsHash}:${String(params.workspaceRevision)}`;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Classifies a tool checkpoint or event record into CONFIRMED_COMPLETED,
 * CONFIRMED_FAILED, or OUTCOME_UNKNOWN.
 */
export function classifyToolOutcome(
  checkpoint: Pick<ToolCallCheckpoint, 'state'> | { state?: string; ok?: boolean; failureClass?: string },
): ClassifiedToolOutcome {
  if ('state' in checkpoint && checkpoint.state) {
    if (checkpoint.state === 'COMPLETED') return 'CONFIRMED_COMPLETED';
    if (checkpoint.state === 'FAILED') return 'CONFIRMED_FAILED';
    return 'OUTCOME_UNKNOWN';
  }
  const raw = checkpoint as { ok?: boolean; failureClass?: string };
  if (raw.failureClass === 'TOOL_OUTCOME_UNKNOWN') return 'OUTCOME_UNKNOWN';
  if (raw.ok === true) return 'CONFIRMED_COMPLETED';
  if (raw.ok === false) return 'CONFIRMED_FAILED';
  return 'OUTCOME_UNKNOWN';
}

/**
 * Durable Operation Identity & Idempotency Ledger (`OperationReconciliationGuard`).
 *
 * Prevents duplicate delivery of mutating operations across retries and cross-harness
 * handoffs. If a tool call with the same `callId` or `(toolName, argumentsHash, workspaceRevision)`
 * was already confirmed or reconciled as `APPLIED`, blocks re-execution and returns the
 * cached/reconciled receipt instead of repeating the filesystem mutation or command.
 */
export class OperationReconciliationGuard {
  private readonly byOperationKey = new Map<string, ConfirmedOperationReceipt>();
  private readonly byCallId = new Map<string, ConfirmedOperationReceipt>();
  private readonly bySemanticKey = new Map<string, ConfirmedOperationReceipt>();

  constructor(initialReceipts: ConfirmedOperationReceipt[] = []) {
    for (const receipt of initialReceipts) {
      this.storeReceipt(receipt);
    }
  }

  /**
   * Hydrates the guard from an existing `ExecutionRecord` and its checkpoints so
   * already-completed or reconciled APPLIED calls cannot be re-executed after restart/handoff.
   */
  static fromExecutionRecord(
    record: ExecutionRecord,
    checkpoints?: ToolCallCheckpoint[],
  ): OperationReconciliationGuard {
    const guard = new OperationReconciliationGuard();
    const resolvedCheckpoints = checkpoints ?? extractToolCheckpoints(record);
    for (const cp of resolvedCheckpoints) {
      if (cp.state === 'COMPLETED') {
        const matchingCall = record.toolCalls.find(
          (tc) => (tc.callId ?? tc.id) === cp.callId && tc.ok,
        );
        guard.recordConfirmedMutation({
          executionId: cp.executionId,
          callId: cp.callId,
          toolName: cp.toolName,
          argumentsHash: cp.argumentsHash,
          input: cp.input,
          workspaceRevision: cp.workspaceRevision,
          output: matchingCall?.output,
          evidence: 'Confirmed completed in execution record',
          confirmedAt: (cp.finishedAt ?? new Date()).toISOString(),
        });
      }
    }
    return guard;
  }

  private storeReceipt(receipt: ConfirmedOperationReceipt): void {
    this.byOperationKey.set(receipt.operationKey, receipt);
    this.byCallId.set(`${receipt.executionId}:${receipt.callId}`, receipt);
    this.bySemanticKey.set(receipt.semanticKey, receipt);
  }

  recordConfirmedMutation(params: {
    executionId: string;
    callId: string;
    toolName: string;
    argumentsHash?: string;
    input?: unknown;
    workspaceRevision: number;
    output?: string;
    evidence?: string;
    confirmedAt?: string;
    sourceHarnessId?: string;
    sourceWorkerId?: string;
  }): ConfirmedOperationReceipt {
    const argumentsHash = params.argumentsHash ?? hashToolArguments(params.input);
    const operationKey = computeOperationKey({
      executionId: params.executionId,
      callId: params.callId,
      toolName: params.toolName,
      argumentsHash,
      workspaceRevision: params.workspaceRevision,
    });
    const semanticKey = computeSemanticOperationKey({
      executionId: params.executionId,
      toolName: params.toolName,
      argumentsHash,
      workspaceRevision: params.workspaceRevision,
    });

    const receipt: ConfirmedOperationReceipt = {
      operationKey,
      semanticKey,
      executionId: params.executionId,
      callId: params.callId,
      toolName: params.toolName,
      argumentsHash,
      workspaceRevision: params.workspaceRevision,
      outcome: 'APPLIED',
      output: params.output,
      evidence: params.evidence ?? 'Confirmed mutation receipt',
      confirmedAt: params.confirmedAt ?? new Date().toISOString(),
      sourceHarnessId: params.sourceHarnessId,
      sourceWorkerId: params.sourceWorkerId,
    };

    this.storeReceipt(receipt);
    return structuredClone(receipt);
  }

  checkDuplicateOperation(params: {
    executionId: string;
    callId: string;
    toolName: string;
    argumentsHash?: string;
    input?: unknown;
    workspaceRevision: number;
  }): DuplicateOperationCheckResult {
    const argumentsHash = params.argumentsHash ?? hashToolArguments(params.input);
    const operationKey = computeOperationKey({
      executionId: params.executionId,
      callId: params.callId,
      toolName: params.toolName,
      argumentsHash,
      workspaceRevision: params.workspaceRevision,
    });
    const semanticKey = computeSemanticOperationKey({
      executionId: params.executionId,
      toolName: params.toolName,
      argumentsHash,
      workspaceRevision: params.workspaceRevision,
    });

    const byOp = this.byOperationKey.get(operationKey) ?? this.byCallId.get(`${params.executionId}:${params.callId}`);
    if (byOp) {
      return {
        duplicate: true,
        reason: 'DUPLICATE_CALL_ID',
        operationKey,
        semanticKey,
        receipt: structuredClone(byOp),
      };
    }

    const bySemantic = this.bySemanticKey.get(semanticKey);
    if (bySemantic) {
      return {
        duplicate: true,
        reason: 'DUPLICATE_SEMANTIC_OPERATION',
        operationKey,
        semanticKey,
        receipt: structuredClone(bySemantic),
      };
    }

    return {
      duplicate: false,
      operationKey,
      semanticKey,
    };
  }

  listReceipts(executionId?: string): ConfirmedOperationReceipt[] {
    const all = Array.from(this.byOperationKey.values());
    const filtered = executionId ? all.filter((r) => r.executionId === executionId) : all;
    return structuredClone(filtered);
  }
}

// ============================================================================
// Lease & Ownership Fencing (`verifyLeaseFencing`)
// ============================================================================

export interface LeaseFencingState {
  executionId: string;
  leaseId: string;
  workerId: string;
  epoch: number;
  harnessId?: string;
  released?: boolean;
  expiresAt?: Date | string;
}

export interface LeaseFencingClaim {
  workerId: string;
  epoch?: number;
  leaseEpoch?: number;
  leaseId?: string;
  leaseToken?: string;
  now?: Date;
}

export interface LeaseFencingResult {
  allowed: boolean;
  code?: 'STALE_WORKER_FENCED';
  reason?: string;
  currentHolder?: {
    leaseId: string;
    workerId: string;
    epoch: number;
  };
}

/**
 * Verifies lease epoch and ownership fencing for an execution report/mutation.
 * Rejects any late completion or event report from a superseded or expired worker
 * with `code: 'STALE_WORKER_FENCED'`.
 */
export function verifyLeaseFencing(
  activeLease: LeaseFencingState | ExecutionLease | undefined | null,
  claim: LeaseFencingClaim,
): LeaseFencingResult {
  if (!activeLease) {
    return {
      allowed: false,
      code: 'STALE_WORKER_FENCED',
      reason: 'No active lease exists for execution',
    };
  }

  const activeLeaseId = 'leaseId' in activeLease ? activeLease.leaseId : activeLease.token;
  const currentHolder = {
    leaseId: activeLeaseId,
    workerId: activeLease.workerId,
    epoch: activeLease.epoch,
  };

  if (activeLease.released) {
    return {
      allowed: false,
      code: 'STALE_WORKER_FENCED',
      reason: `Lease '${activeLeaseId}' (epoch ${activeLease.epoch}) has already been released`,
      currentHolder,
    };
  }

  const claimedEpoch = claim.epoch ?? claim.leaseEpoch;
  if (claimedEpoch !== undefined && claimedEpoch !== activeLease.epoch) {
    return {
      allowed: false,
      code: 'STALE_WORKER_FENCED',
      reason: `Fenced stale worker '${claim.workerId}' at epoch ${claimedEpoch}; current epoch is ${activeLease.epoch} held by '${activeLease.workerId}'`,
      currentHolder,
    };
  }

  if (claim.workerId !== activeLease.workerId) {
    return {
      allowed: false,
      code: 'STALE_WORKER_FENCED',
      reason: `Fenced worker '${claim.workerId}'; lease is currently held by '${activeLease.workerId}' at epoch ${activeLease.epoch}`,
      currentHolder,
    };
  }

  const claimedToken = claim.leaseId ?? claim.leaseToken;
  if (claimedToken !== undefined && claimedToken !== activeLeaseId) {
    return {
      allowed: false,
      code: 'STALE_WORKER_FENCED',
      reason: `Fenced stale lease token '${claimedToken}'; active lease is '${activeLeaseId}' at epoch ${activeLease.epoch}`,
      currentHolder,
    };
  }

  if (activeLease.expiresAt) {
    const now = claim.now ?? new Date();
    const expiresMs = activeLease.expiresAt instanceof Date
      ? activeLease.expiresAt.getTime()
      : new Date(activeLease.expiresAt).getTime();
    if (expiresMs <= now.getTime()) {
      return {
        allowed: false,
        code: 'STALE_WORKER_FENCED',
        reason: `Lease '${activeLeaseId}' held by '${activeLease.workerId}' (epoch ${activeLease.epoch}) expired`,
        currentHolder,
      };
    }
  }

  return {
    allowed: true,
    currentHolder,
  };
}

// ============================================================================
// Side-Effect Reconciliation Before Cross-Harness Resume
// ============================================================================

export interface OperatorAuthorizedResolution {
  callId: string;
  decision: 'assume_applied' | 'allow_retry' | 'abort';
  authorizedBy: string;
  reason?: string;
}

export interface ReconcileBeforeCrossHarnessResumeOptions {
  executions: ExecutionEngine;
  executionId: string;
  inspectToolOutcome?: (record: ExecutionRecord, call: ToolCallCheckpoint) => Promise<ToolOutcomeInspection>;
  operatorAuthorizedResolution?: OperatorAuthorizedResolution | OperatorAuthorizedResolution[];
  guard?: OperationReconciliationGuard;
  advanceRevisionOnApplied?: boolean;
}

export interface ReconciledCallResolution {
  callId: string;
  toolName: string;
  outcome: 'APPLIED' | 'NOT_APPLIED' | 'UNDETERMINED' | 'ABORTED';
  retryable: boolean;
  evidence: string;
  operatorAuthorized?: boolean;
  operationKey: string;
}

export interface CrossHarnessReconciliationResult {
  executionId: string;
  safeToResume: boolean;
  status: 'READY_TO_RESUME' | 'BLOCKED_UNDETERMINED_OUTCOME' | 'ABORTED_BY_OPERATOR';
  workspaceRevision: number;
  resolutions: ReconciledCallResolution[];
  blockedCallIds: string[];
  retryableCallIds: string[];
  appliedCallIds: string[];
  reasons: string[];
  guard: OperationReconciliationGuard;
}

/**
 * Inspects physical workspace state (target file hash/content, git revision, command receipt)
 * for any `STARTED` or `OUTCOME_UNKNOWN` tool call before allowing cross-harness resume:
 * - If `APPLIED`: marks tool call completed without re-running it, records receipt in the
 *   idempotency guard, and advances workspace revision if needed.
 * - If `NOT_APPLIED`: marks tool call safely retryable.
 * - If `UNDETERMINED`: NEVER converts unknown outcome into false success! Blocks automatic
 *   retry fail-closed until explicit operator authorization (`operatorAuthorizedResolution`).
 */
export async function reconcileBeforeCrossHarnessResume(
  options: ReconcileBeforeCrossHarnessResumeOptions,
): Promise<CrossHarnessReconciliationResult> {
  const { executions, executionId, inspectToolOutcome } = options;
  const record = executions.require(executionId);
  const checkpoints = executions.toolCheckpoints(executionId);
  const guard = options.guard ?? OperationReconciliationGuard.fromExecutionRecord(record, checkpoints);

  const authList = Array.isArray(options.operatorAuthorizedResolution)
    ? options.operatorAuthorizedResolution
    : options.operatorAuthorizedResolution
      ? [options.operatorAuthorizedResolution]
      : [];
  const authByCallId = new Map<string, OperatorAuthorizedResolution>(
    authList.map((a) => [a.callId, a]),
  );

  const resolutions: ReconciledCallResolution[] = [];
  const blockedCallIds: string[] = [];
  const retryableCallIds: string[] = [];
  const appliedCallIds: string[] = [];
  const reasons: string[] = [];
  let abortedByOperator = false;

  for (const call of checkpoints) {
    if (call.state !== 'STARTED' && call.state !== 'OUTCOME_UNKNOWN') continue;

    const operationKey = computeOperationKey({
      executionId,
      callId: call.callId,
      toolName: call.toolName,
      argumentsHash: call.argumentsHash,
      workspaceRevision: call.workspaceRevision,
    });

    // Read-only calls have no external side effects and are always safe to retry.
    if (call.sideEffectClass === 'READ_ONLY') {
      await executions.reconcileToolCall(executionId, call.callId, {
        outcome: 'NOT_APPLIED',
        evidence: 'READ_ONLY tool call has no side effects; safe to retry',
        inspectedBy: 'cross-harness-reconciler',
      });
      resolutions.push({
        callId: call.callId,
        toolName: call.toolName,
        outcome: 'NOT_APPLIED',
        retryable: true,
        evidence: 'READ_ONLY tool call has no side effects; safe to retry',
        operationKey,
      });
      retryableCallIds.push(call.callId);
      continue;
    }

    let inspection: ToolOutcomeInspection = {
      outcome: 'UNDETERMINED',
      evidence: 'No physical outcome inspector provided',
    };

    if (inspectToolOutcome) {
      try {
        inspection = await inspectToolOutcome(record, call);
      } catch (err) {
        inspection = {
          outcome: 'UNDETERMINED',
          evidence: `Physical inspection failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (inspection.outcome === 'APPLIED') {
      await executions.reconcileToolCall(executionId, call.callId, {
        outcome: 'APPLIED',
        evidence: inspection.evidence,
        inspectedBy: 'cross-harness-reconciler',
      });
      guard.recordConfirmedMutation({
        executionId,
        callId: call.callId,
        toolName: call.toolName,
        argumentsHash: call.argumentsHash,
        input: call.input,
        workspaceRevision: call.workspaceRevision,
        evidence: inspection.evidence,
      });
      if (options.advanceRevisionOnApplied !== false) {
        const currentRev = executions.getWorkspaceRevision(executionId);
        if (currentRev <= call.workspaceRevision) {
          const targetPath = typeof (call.input as Record<string, unknown> | undefined)?.path === 'string'
            ? String((call.input as Record<string, unknown>).path)
            : `reconciled:${call.toolName}:${call.callId}`;
          await executions.recordFilesChanged(executionId, [targetPath]);
        }
      }
      resolutions.push({
        callId: call.callId,
        toolName: call.toolName,
        outcome: 'APPLIED',
        retryable: false,
        evidence: inspection.evidence,
        operationKey,
      });
      appliedCallIds.push(call.callId);
      reasons.push(`Tool call '${call.callId}' (${call.toolName}) reconciled as APPLIED from physical state`);
      continue;
    }

    if (inspection.outcome === 'NOT_APPLIED') {
      await executions.reconcileToolCall(executionId, call.callId, {
        outcome: 'NOT_APPLIED',
        evidence: inspection.evidence,
        inspectedBy: 'cross-harness-reconciler',
      });
      resolutions.push({
        callId: call.callId,
        toolName: call.toolName,
        outcome: 'NOT_APPLIED',
        retryable: true,
        evidence: inspection.evidence,
        operationKey,
      });
      retryableCallIds.push(call.callId);
      reasons.push(`Tool call '${call.callId}' (${call.toolName}) reconciled as NOT_APPLIED; safe to retry`);
      continue;
    }

    // Outcome is UNDETERMINED: check if operator explicitly authorized a resolution
    const operatorAuth = authByCallId.get(call.callId);
    if (!operatorAuth) {
      resolutions.push({
        callId: call.callId,
        toolName: call.toolName,
        outcome: 'UNDETERMINED',
        retryable: false,
        evidence: inspection.evidence,
        operationKey,
      });
      blockedCallIds.push(call.callId);
      reasons.push(
        `UNDETERMINED_SIDE_EFFECT: Tool call '${call.callId}' (${call.toolName}) has undetermined physical state (${inspection.evidence}); automatic retry blocked fail-closed until operator authorization`,
      );
      continue;
    }

    const authEvidence = `Operator '${operatorAuth.authorizedBy}' authorized '${operatorAuth.decision}'${operatorAuth.reason ? `: ${operatorAuth.reason}` : ''} (prior physical check: ${inspection.evidence})`;

    if (operatorAuth.decision === 'abort') {
      abortedByOperator = true;
      blockedCallIds.push(call.callId);
      resolutions.push({
        callId: call.callId,
        toolName: call.toolName,
        outcome: 'ABORTED',
        retryable: false,
        evidence: authEvidence,
        operatorAuthorized: true,
        operationKey,
      });
      reasons.push(`Execution aborted by operator '${operatorAuth.authorizedBy}' for unresolved call '${call.callId}'`);
      continue;
    }

    if (operatorAuth.decision === 'assume_applied') {
      await executions.reconcileToolCall(executionId, call.callId, {
        outcome: 'APPLIED',
        evidence: authEvidence,
        inspectedBy: `operator:${operatorAuth.authorizedBy}`,
      });
      guard.recordConfirmedMutation({
        executionId,
        callId: call.callId,
        toolName: call.toolName,
        argumentsHash: call.argumentsHash,
        input: call.input,
        workspaceRevision: call.workspaceRevision,
        evidence: authEvidence,
      });
      if (options.advanceRevisionOnApplied !== false) {
        const currentRev = executions.getWorkspaceRevision(executionId);
        if (currentRev <= call.workspaceRevision) {
          const targetPath = typeof (call.input as Record<string, unknown> | undefined)?.path === 'string'
            ? String((call.input as Record<string, unknown>).path)
            : `reconciled:${call.toolName}:${call.callId}`;
          await executions.recordFilesChanged(executionId, [targetPath]);
        }
      }
      resolutions.push({
        callId: call.callId,
        toolName: call.toolName,
        outcome: 'APPLIED',
        retryable: false,
        evidence: authEvidence,
        operatorAuthorized: true,
        operationKey,
      });
      appliedCallIds.push(call.callId);
      reasons.push(`Tool call '${call.callId}' marked APPLIED via operator authorization by '${operatorAuth.authorizedBy}'`);
      continue;
    }

    if (operatorAuth.decision === 'allow_retry') {
      await executions.reconcileToolCall(executionId, call.callId, {
        outcome: 'NOT_APPLIED',
        evidence: authEvidence,
        inspectedBy: `operator:${operatorAuth.authorizedBy}`,
      });
      resolutions.push({
        callId: call.callId,
        toolName: call.toolName,
        outcome: 'NOT_APPLIED',
        retryable: true,
        evidence: authEvidence,
        operatorAuthorized: true,
        operationKey,
      });
      retryableCallIds.push(call.callId);
      reasons.push(`Tool call '${call.callId}' authorized for retry by operator '${operatorAuth.authorizedBy}'`);
    }
  }

  const safeToResume = !abortedByOperator && blockedCallIds.length === 0;
  const status: CrossHarnessReconciliationResult['status'] = abortedByOperator
    ? 'ABORTED_BY_OPERATOR'
    : blockedCallIds.length > 0
      ? 'BLOCKED_UNDETERMINED_OUTCOME'
      : 'READY_TO_RESUME';

  return {
    executionId,
    safeToResume,
    status,
    workspaceRevision: executions.getWorkspaceRevision(executionId),
    resolutions,
    blockedCallIds,
    retryableCallIds,
    appliedCallIds,
    reasons,
    guard,
  };
}

