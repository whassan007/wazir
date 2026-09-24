import type {
  ExecutionOwner,
  AcceptanceContract,
  CheckRunRecord,
  ContextDecision,
  EvaluationResult,
  EvidenceType,
  Execution,
  ExecutionEvent,
  ExecutionEventType,
  ExecutionEventIdentity,
  SequencedExecutionEvent,
  ExecutionRecord,
  ExecutionStatus,
  FileMutationHistoryEntry,
  PolicyDecision,
  SchedulerDecision,
  Task,
  TokenUsage,
  ToolCallRecord,
  ToolCallCheckpoint,
  VerificationEvidence,
  WorkspaceState,
  SteeringParams,
  SteeringResult,
} from '../types/index.js';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hostname } from 'node:os';
import { sanitizeUntrustedOutput, appendAuditEvent, computeContentHash } from '@wazir/shared';
import type { ProvenanceManager, CreateArtifactParams } from './provenanceManager.js';
import { executionValuesEqual } from './executionPersistence.js';
import { ExecutionFailure, isProviderRetryable } from '@wazir/shared';
import type { GenerationEvent } from '@wazir/runtimes-interfaces';
import { hashToolArguments } from './toolValidation.js';
import { planRecovery, reconstructExecutionState } from './executionRecovery.js';
import type { ReconstructedExecutionState, RecoveryBudgetLimits, RecoveryPlan, ToolOutcomeInspection } from './executionRecovery.js';
import type { ToolSideEffectClass } from '../types/tool.js';
import type { FileMutationResult } from '../types/tool.js';

export interface ExecutionEngineOptions {
  /** Persists a record after every mutation. */
  persist?: (record: ExecutionRecord) => void | Promise<void>;
  /** Seeds the engine from durable storage at startup. */
  load?: () => ExecutionRecord[] | Promise<ExecutionRecord[]>;
  idPrefix?: string;
  provenanceManager?: ProvenanceManager;
  /** Project root used as the artifact workspace; defaults to process.cwd(). */
  workspace?: string;
  /** Identity stamped on every execution this engine writes; defaults to this process. */
  owner?: ExecutionOwner;
  /** Liveness check for a same-host owner pid; defaults to signal 0. */
  isProcessAlive?: (pid: number) => boolean;
}

function signalZeroAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by another user
  }
}

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Durable execution tracking. Every execution produces a complete record:
 * task, agent, model, runtime, computer, context, policy decisions,
 * scheduling decision, tool calls, files changed, checks, errors,
 * latency, token usage, final result and evaluation.
 */
export class ExecutionEngine {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly histories = new Map<string, SequencedExecutionEvent[]>();
  private readonly pausedExecutions = new Set<string>();
  private readonly steeringQueues = new Map<string, SteeringParams[]>();
  private readonly cancelledToolCalls = new Map<string, Set<string>>();
  private persistenceTail: Promise<void> = Promise.resolve();
  private persistenceFailure?: Error;
  private readonly persist?: (record: ExecutionRecord) => void | Promise<void>;
  private readonly idPrefix: string;
  private readonly provenanceManager?: ProvenanceManager;
  private readonly workspace: string;
  private readonly owner: ExecutionOwner;
  private readonly isProcessAlive: (pid: number) => boolean;
  readonly ready: Promise<void>;

  constructor(options: ExecutionEngineOptions = {}) {
    this.persist = options.persist;
    this.idPrefix = options.idPrefix ?? 'exec';
    this.provenanceManager = options.provenanceManager;
    this.workspace = options.workspace ?? process.cwd();
    this.owner = options.owner ?? { pid: process.pid, host: hostname() };
    this.isProcessAlive = options.isProcessAlive ?? signalZeroAlive;
    this.ready = Promise.resolve().then(() => options.load?.()).then(async (loaded) => {
      if (!loaded) return;
      for (const record of loaded) {
        const copy = structuredClone(record);
        const events = copy.events.map((event, index) => {
          if (event.sequence !== undefined && event.sequence !== index + 1) {
            throw new Error(`Invalid event sequence for execution '${copy.execution.id}'`);
          }
          if (event.executionId !== copy.execution.id ||
              (event.eventId !== undefined && event.eventId !== event.id) ||
              (event.eventType !== undefined && event.eventType !== event.type)) {
            throw new Error(`Invalid event identity for execution '${copy.execution.id}'`);
          }
          return {
            ...event,
            eventId: event.id,
            eventType: event.type,
            sequence: index + 1,
            jobId: event.jobId ?? copy.execution.jobId ?? null,
            timestamp: new Date(event.timestamp),
          } satisfies SequencedExecutionEvent;
        });
        if (new Set(events.map(e => e.eventId)).size !== events.length) {
          throw new Error(`Duplicate event identity for execution '${copy.execution.id}'`);
        }
        copy.events = structuredClone(events);
        this.histories.set(copy.execution.id, events);
        this.records.set(copy.execution.id, copy);
      }
      // Detect orphaned tool.start events without a matching completed event — but never
      // in an execution another live process is still running: its "unfinished" call is
      // in flight, and marking it would also fork the record's storage revision.
      for (const record of this.records.values()) {
        if (this.ownedByAnotherLiveProcess(record)) continue;
        for (const call of this.toolCheckpoints(record.execution.id).filter(call => call.state === 'STARTED')) {
          const data = { tool: call.toolName, input: call.input, startedAt: call.startedAt, callId: call.callId, sideEffectClass: call.sideEffectClass, failureClass: 'TOOL_OUTCOME_UNKNOWN' };
          this.pushEvent(record, 'tool.unknownOutcome', data, { callId: call.callId, stepId: call.stepId });
          this.pushEvent(record, 'tool.call.outcome_unknown', data, { callId: call.callId, stepId: call.stepId });
        }
        // Persist legacy envelope migration and recovered unknown outcomes before ready.
        const loadedRecord = loaded.find(item => item.execution.id === record.execution.id)!;
        if (!isDeepStrictEqual(loadedRecord.events, record.events)) await this.flush(record);
      }
    }).catch(error => {
      this.persistenceFailure = error instanceof Error ? error : new Error(String(error));
      throw this.persistenceFailure;
    });
  }

  async create(params: {
    task: Task;
    jobId?: string;
    parentExecutionId?: string;
    agentId?: string;
    computerId: string;
    runtimeId: string;
    modelId: string;
    workerId?: string;
    workspaceRoot?: string;
    scheduling?: SchedulerDecision;
    context?: ContextDecision;
  }): Promise<ExecutionRecord> {
    await this.ready;
    if (this.persistenceFailure) throw this.persistenceFailure;
    const now = new Date();
    const execution: Execution = {
      id: nextId(this.idPrefix),
      jobId: params.jobId,
      taskId: params.task.id,
      parentExecutionId: params.parentExecutionId,
      agentId: params.agentId,
      computerId: params.computerId,
      runtimeId: params.runtimeId,
      modelId: params.modelId,
      workerId: params.workerId,
      ...(params.workspaceRoot ? { workspaceRoot: params.workspaceRoot } : {}),
      status: 'queued',
      createdAt: now,
    };

    const workspaceState: WorkspaceState = {
      workspaceId: execution.id,
      revision: 0,
      updatedAt: now,
    };

    const record: ExecutionRecord = {
      execution,
      task: params.task,
      scheduling: params.scheduling,
      context: params.context,
      policyDecisions: [],
      toolCalls: [],
      filesChanged: [],
      checks: [],
      errors: [],
      workspaceState,
      evidence: [],
      acceptanceContract: params.task.acceptanceContract,
      mutationHistory: [],
      events: [],
    };

    this.records.set(execution.id, record);
    this.histories.set(execution.id, []);
    this.pushEvent(record, 'execution.created', {
      agentId: params.agentId,
      computerId: params.computerId,
      runtimeId: params.runtimeId,
      modelId: params.modelId,
    });
    await this.flush(record);
    return record;
  }

  async setScheduled(executionId: string, scheduling: SchedulerDecision): Promise<void> {
    const record = this.require(executionId);
    record.scheduling = scheduling;
    this.pushEvent(record, 'execution.scheduled', scheduling);
    await this.flush(record);
  }

  async setStatus(executionId: string, status: ExecutionStatus, options?: { targetRevision?: number }): Promise<void> {
    const record = this.require(executionId);
    if (status === 'completed' && this.toolCheckpoints(executionId).some(call => call.state === 'STARTED' || call.state === 'OUTCOME_UNKNOWN')) {
      this.pushEvent(record, 'completion.rejected', { reason: 'TOOL_OUTCOME_UNKNOWN' });
      await this.flush(record);
      throw new ExecutionFailure('TOOL_OUTCOME_UNKNOWN', 'Completion requires reconciliation of all dispatched tool calls');
    }
    if (status === 'completed' && options?.targetRevision !== undefined) {
      const currentRev = record.workspaceState?.revision ?? 0;
      if (options.targetRevision !== currentRev) {
        this.pushEvent(record, 'completion.rejected', {
          targetRevision: options.targetRevision,
          attemptedRevision: options.targetRevision,
          currentRevision: currentRev,
          reason: 'STALE_WORKSPACE_REVISION',
        });
        await this.flush(record);
        const err = new Error(`STALE_WORKSPACE_REVISION: target revision ${options.targetRevision} does not match current workspace revision ${currentRev}`);
        (err as any).code = 'STALE_WORKSPACE_REVISION';
        throw err;
      }
    }

    if (status === 'completed') {
      const revision = record.workspaceState?.revision ?? 0;
      const required = record.acceptanceContract?.requiredEvidence ?? [];
      const missing = required.filter(type => {
        const latest = new Map<string, VerificationEvidence>();
        for (const evidence of record.evidence ?? []) {
          if (evidence.type === type && evidence.revision === revision) latest.set(evidence.command ?? '', evidence);
        }
        return latest.size === 0 || [...latest.values()].some(evidence => evidence.exitCode !== 0);
      });
      const evaluationInvalid = record.evaluation && (!record.evaluation.success || record.evaluation.workspaceRevision !== revision);
      const evaluationMissing = record.filesChanged.length > 0 && required.length === 0 && !record.evaluation;
      if (missing.length > 0 || evaluationInvalid || evaluationMissing) {
        this.pushEvent(record, 'completion.rejected', { reason: 'VERIFICATION_REQUIRED', workspaceRevision: revision, missing, evaluationInvalid: Boolean(evaluationInvalid), evaluationMissing });
        await this.flush(record);
        throw new ExecutionFailure('ARTIFACT_CONTRACT_FAILED', `Completion requires current verification for workspace revision ${revision}`);
      }
    }

    if (record.execution.status === status && ['completed', 'failed', 'cancelled'].includes(status)) {
      await this.flush(record);
      return;
    }

    record.execution.status = status;
    const now = new Date();
    if (status === 'running' && !record.execution.startedAt) {
      record.execution.startedAt = now;
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      record.execution.completedAt = now;
    }

    const eventType: ExecutionEventType =
      status === 'running'
        ? 'execution.assigned'
        : status === 'completed'
          ? 'execution.completed'
          : status === 'failed'
            ? 'execution.failed'
            : status === 'cancelled'
              ? 'execution.cancelled'
              : 'execution.scheduled';

    this.pushEvent(record, eventType, { status });
    await this.flush(record);
  }

  async recordPolicy(executionId: string, decision: PolicyDecision): Promise<void> {
    const record = this.require(executionId);
    record.policyDecisions.push(decision);
    this.pushEvent(record, 'policy.decision', decision);
    void appendAuditEvent({
      type: 'policy_decision',
      tool: decision.tool,
      decision: decision.decision,
      rule: decision.rule,
      reasons: decision.reasons,
      command: decision.command,
      executionId,
      taskId: record.task.id,
      agentId: record.execution.agentId,
    }).catch(() => {});
    await this.flush(record);
  }

  async recordToolCall(executionId: string, call: ToolCallRecord): Promise<void> {
    const record = this.require(executionId);
    const checkpoints = this.toolCheckpoints(executionId);
    const checkpoint = checkpoints.find(c => c.callId === (call.callId ?? call.id)) ??
      checkpoints.find(c => c.legacyCorrelation && c.state === 'STARTED' && c.toolName === call.tool && call.policyEffect !== 'deny' && call.policyEffect !== 'ask');
    const callId = checkpoint?.callId ?? call.callId ?? call.id;
    const prior = record.toolCalls.find(c => c.id === call.id);
    if (prior) {
      if (!executionValuesEqual(prior, { ...call, output: call.output === undefined ? undefined : sanitizeUntrustedOutput(call.output), error: call.error === undefined ? undefined : sanitizeUntrustedOutput(call.error) })) throw new Error(`Conflicting tool result '${callId}'`);
      await this.flush(record);
      return;
    }
    // Tool output is persisted for the life of the record and may be shipped
    // to a control plane; scrub terminal escapes and credential-shaped
    // material before it lands anywhere durable (F-13, F-23).
    record.toolCalls.push({
      ...call,
      output: call.output === undefined ? undefined : sanitizeUntrustedOutput(call.output),
      error: call.error === undefined ? undefined : sanitizeUntrustedOutput(call.error),
    });
    this.pushEvent(record, 'tool.completed', {
      callId,
      tool: call.tool,
      ok: call.ok,
      failureClass: call.failureClass,
      policyEffect: call.policyEffect,
      durationMs: call.durationMs,
    }, { callId, stepId: checkpoint?.stepId });
    this.pushEvent(record, call.failureClass === 'TOOL_OUTCOME_UNKNOWN' ? 'tool.call.outcome_unknown' : call.ok ? 'tool.call.completed' : 'tool.call.failed', {
      callId, tool: call.tool, ok: call.ok, failureClass: call.failureClass, durationMs: call.durationMs,
    }, { callId, stepId: checkpoint?.stepId });
    await this.flush(record);
  }

  async recordToolStart(executionId: string, tool: string, input: unknown, options: {
    callId?: string; stepId?: string; sideEffectClass?: ToolSideEffectClass; argumentsHash?: string;
  } = {}): Promise<string> {
    const record = this.require(executionId);
    const callId = options.callId ?? `call-${randomUUID()}`;
    if (this.toolCheckpoints(executionId).some(call => call.callId === callId)) {
      throw new Error(`TOOL_ALREADY_DISPATCHED: '${callId}' must be reconciled or its recorded result reused`);
    }
    if (options.sideEffectClass !== 'READ_ONLY' && this.toolCheckpoints(executionId).some(call =>
      call.sideEffectClass !== 'READ_ONLY' && (call.state === 'STARTED' || call.state === 'OUTCOME_UNKNOWN'))) {
      throw new ExecutionFailure('TOOL_OUTCOME_UNKNOWN', 'A prior write must be reconciled before dispatching another write');
    }
    const checkpoint: ToolCallCheckpoint = {
      executionId, stepId: options.stepId ?? callId, callId, toolName: tool, input,
      argumentsHash: options.argumentsHash ?? hashToolArguments(input), startedAt: new Date(),
      state: 'STARTED', sideEffectClass: options.sideEffectClass ?? 'NON_IDEMPOTENT_WRITE',
      workspaceRevision: record.workspaceState?.revision ?? 0,
      legacyCorrelation: options.callId === undefined,
    };
    this.pushEvent(record, 'tool.started', { ...checkpoint, tool }, { callId, stepId: checkpoint.stepId });
    this.pushEvent(record, 'tool.call.started', checkpoint, { callId, stepId: checkpoint.stepId });
    await this.flush(record);
    return callId;
  }

  /**
   * Durable step checkpoints: recordToolStart() (intent) and recordToolCall()
   * (result) are written as separate events around every tool call, so a
   * process crash between them leaves a 'tool.started' with no matching
   * 'tool.completed' in the persisted event log. This finds that gap — a
   * mutating tool (a git commit, a file write, a remote dispatch) whose
   * actual outcome is unknown, not just "the task didn't finish". Callers
   * (RecoveryManager, JobManager on load) use this to flag the execution for
   * review instead of blindly re-running the tool call as part of an
   * ordinary retry, which could double-apply a side effect that actually
   * already landed.
   *
   * Current calls are paired by callId. Legacy calls are paired by tool and
   * ordered dispatch, excluding denials (which never dispatched a tool).
   */
  findUnknownOutcomeToolCall(executionId: string): { tool: string; input: unknown; startedAt: Date; callId: string; sideEffectClass: ToolSideEffectClass } | undefined {
    const call = this.toolCheckpoints(executionId).find(c => c.state === 'STARTED' || c.state === 'OUTCOME_UNKNOWN');
    return call ? { tool: call.toolName, input: call.input, startedAt: call.startedAt, callId: call.callId, sideEffectClass: call.sideEffectClass } : undefined;
  }

  /**
   * Resolves a dispatched call whose outcome is unknown, from physical evidence.
   * APPLIED confirms the side effect happened (recorded as a completed call);
   * NOT_APPLIED confirms it did not (recorded as failed, so the action may be issued
   * again). UNDETERMINED is refused: an unproven outcome stays unresolved and keeps
   * blocking further writes and completion. The evidence is part of the durable record.
   */
  async reconcileToolCall(executionId: string, callId: string, inspection: ToolOutcomeInspection & { inspectedBy: string }): Promise<void> {
    const record = this.require(executionId);
    const call = this.toolCheckpoints(executionId).find((c) => c.callId === callId);
    if (!call) throw new Error(`unknown tool call '${callId}' for execution '${executionId}'`);
    if (call.state !== 'STARTED' && call.state !== 'OUTCOME_UNKNOWN') {
      throw new Error(`tool call '${callId}' is already ${call.state}; nothing to reconcile`);
    }
    if (inspection.outcome === 'UNDETERMINED') {
      throw new ExecutionFailure('TOOL_OUTCOME_UNKNOWN', `cannot reconcile '${callId}' without proof: ${inspection.evidence}`);
    }
    const ok = inspection.outcome === 'APPLIED';
    const reconciled = { outcome: inspection.outcome, evidence: inspection.evidence, inspectedBy: inspection.inspectedBy };
    this.pushEvent(record, 'tool.completed', { callId, tool: call.toolName, ok, reconciled }, { callId, stepId: call.stepId, eventId: `${callId}:reconciled` });
    this.pushEvent(record, ok ? 'tool.call.completed' : 'tool.call.failed', { callId, tool: call.toolName, ok, reconciled }, { callId, stepId: call.stepId, eventId: `${callId}:reconciled:call` });
    await this.flush(record);
  }

  /** Event-derived state and the recovery decision for one execution (see executionRecovery.ts). */
  reconstruct(executionId: string, limits: RecoveryBudgetLimits = {}, now?: Date): { state: ReconstructedExecutionState; plan: RecoveryPlan } {
    const state = reconstructExecutionState(this.require(executionId), this.toolCheckpoints(executionId), limits, now);
    return { state, plan: planRecovery(state) };
  }

  /** Reconstruct tool dispatch state from durable facts, independent of UI/transcript. */
  toolCheckpoints(executionId: string): ToolCallCheckpoint[] {
    this.require(executionId);
    const calls = new Map<string, ToolCallCheckpoint>();
    for (const event of this.histories.get(executionId) ?? []) {
      const data = event.data as Partial<ToolCallCheckpoint> & { tool?: string; ok?: boolean; policyEffect?: string; failureClass?: string } | undefined;
      if (!data) continue;
      if (event.type === 'tool.started') {
        const callId = event.callId ?? data.callId ?? event.id;
        calls.set(callId, {
          executionId, callId, stepId: event.stepId ?? data.stepId ?? callId,
          toolName: data.toolName ?? data.tool ?? 'unknown', input: data.input,
          argumentsHash: data.argumentsHash ?? hashToolArguments(data.input),
          startedAt: data.startedAt ?? event.timestamp, state: 'STARTED',
          workspaceRevision: data.workspaceRevision ?? event.workspaceRevision ?? 0,
          sideEffectClass: data.sideEffectClass ?? 'NON_IDEMPOTENT_WRITE',
          legacyCorrelation: data.legacyCorrelation ?? !event.callId,
        });
      } else if (event.type === 'tool.completed' || event.type === 'tool.unknownOutcome') {
        const callId = event.callId ?? data.callId;
        const call = callId ? calls.get(callId) : [...calls.values()].find(c => c.state === 'STARTED' && c.toolName === data.tool && data.policyEffect !== 'deny' && data.policyEffect !== 'ask');
        if (!call) continue;
        call.state = event.type === 'tool.unknownOutcome' || data.failureClass === 'TOOL_OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : data.ok ? 'COMPLETED' : 'FAILED';
        if (event.type === 'tool.completed') call.finishedAt = event.timestamp;
      }
    }
    return structuredClone([...calls.values()]);
  }

  async recordCheck(executionId: string, check: CheckRunRecord): Promise<void> {
    const record = this.require(executionId);
    const sanitized = {
      ...check,
      output: check.output !== undefined ? sanitizeUntrustedOutput(check.output) : undefined,
    };
    record.checks.push(sanitized);
    this.pushEvent(record, 'check.completed', sanitized);

    const currentRev = check.workspaceRevision ?? record.workspaceState?.revision ?? 0;
    const evidenceType: EvidenceType | undefined =
      check.name === 'build' ? 'BUILD' :
      check.name === 'test' ? 'TEST' :
      check.name === 'lint' || check.name === 'typecheck' ? 'STATIC_CHECK' : undefined;

    if (evidenceType) {
      if (!record.evidence) record.evidence = [];
      const rawPayload = `${evidenceType}:${check.command}:${check.ok ? 0 : 1}:${currentRev}:${sanitized.output ?? ''}`;
      const ev: VerificationEvidence = {
        id: nextId('evd'),
        type: evidenceType,
        oracle: evidenceType,
        workspaceRevision: currentRev,
        executionId,
        workspaceId: record.workspaceState?.workspaceId ?? executionId,
        revision: currentRev,
        command: check.command,
        exitCode: check.ok ? 0 : 1,
        durationMs: check.durationMs,
        output: sanitized.output,
        status: check.ok ? 'PASS' : 'FAIL',
        evidenceHash: createHash('sha256').update(rawPayload).digest('hex'),
        completedAt: new Date(),
      };
      record.evidence.push(ev);

      if (evidenceType === 'BUILD') {
        this.pushEvent(record, 'build.completed', {
          workspaceRevision: currentRev,
          exitCode: ev.exitCode,
          command: check.command,
          ok: check.ok,
        });
      } else if (evidenceType === 'TEST') {
        this.pushEvent(record, 'test.completed', {
          workspaceRevision: currentRev,
          exitCode: ev.exitCode,
          command: check.command,
          ok: check.ok,
        });
      }
    }

    await this.flush(record);
  }

  async recordEvidence(
    executionId: string,
    evidence: Omit<VerificationEvidence, 'id'> & { id?: string },
  ): Promise<VerificationEvidence> {
    const record = this.require(executionId);
    if (!record.evidence) {
      record.evidence = [];
    }
    const currentRev = record.workspaceState?.revision ?? 0;
    const boundRev = evidence.workspaceRevision !== undefined ? evidence.workspaceRevision : (evidence.revision !== undefined ? evidence.revision : currentRev);
    const oracleType = evidence.oracle ?? evidence.type;
    const rawPayload = `${oracleType}:${evidence.command ?? ''}:${evidence.exitCode}:${boundRev}:${evidence.output ?? ''}`;
    const fullEvidence: VerificationEvidence = {
      id: evidence.id ?? nextId('evd'),
      type: oracleType,
      oracle: oracleType,
      executionId,
      workspaceId: evidence.workspaceId ?? record.workspaceState?.workspaceId ?? executionId,
      workspaceRevision: boundRev,
      revision: boundRev,
      command: evidence.command,
      exitCode: evidence.exitCode,
      durationMs: evidence.durationMs,
      startedAt: evidence.startedAt,
      completedAt: evidence.completedAt ?? new Date(),
      status: evidence.status ?? (evidence.exitCode === 0 ? 'PASS' : 'FAIL'),
      evidenceHash: evidence.evidenceHash ?? createHash('sha256').update(rawPayload).digest('hex'),
      artifacts: evidence.artifacts,
      output: evidence.output ? sanitizeUntrustedOutput(evidence.output) : undefined,
      artifactFingerprint: evidence.artifactFingerprint,
      reasons: evidence.reasons,
      metadata: evidence.metadata,
    };
    record.evidence.push(fullEvidence);

    if (fullEvidence.type === 'BUILD') {
      this.pushEvent(record, 'build.completed', {
        workspaceRevision: fullEvidence.revision,
        exitCode: fullEvidence.exitCode,
        command: fullEvidence.command,
        ok: fullEvidence.exitCode === 0,
      });
    } else if (fullEvidence.type === 'TEST') {
      this.pushEvent(record, 'test.completed', {
        workspaceRevision: fullEvidence.revision,
        exitCode: fullEvidence.exitCode,
        command: fullEvidence.command,
        ok: fullEvidence.exitCode === 0,
      });
    }

    await this.flush(record);
    return fullEvidence;
  }

  async recordEvent(executionId: string, type: ExecutionEventType, data?: unknown, identity?: ExecutionEventIdentity): Promise<void> {
    const record = this.require(executionId);
    this.pushEvent(record, type, data, identity);
    await this.flush(record);
  }

  /** Persist retry intent before the iterator resumes the provider's backoff loop. */
  async recordProviderEvent(executionId: string, event: GenerationEvent, context: {
    requestId: string; model: string; provider?: string;
  }): Promise<void> {
    if (event.type !== 'retry' && !event.retryExhausted) return;
    if (!event.failureClass || !isProviderRetryable(event.failureClass)) {
      throw new Error('Provider retry requires a classified transient failure');
    }
    const type = event.type === 'retry' ? 'retry.scheduled' : 'retry.exhausted';
    await this.recordEvent(executionId, type, {
      attempt: event.retryAttempt ?? null,
      failureClass: event.failureClass,
      provider: context.provider ?? null,
      model: context.model,
      delay: event.retryDelayMs ?? 0,
      turn: context.requestId,
      step: context.requestId,
      reason: type === 'retry.scheduled' ? 'transient_provider_failure' : 'retry_budget_exhausted',
    }, {
      eventId: `${context.requestId}:${type}:${event.retryAttempt ?? 'final'}`,
      turnId: context.requestId,
      stepId: context.requestId,
      attemptId: `${context.requestId}:attempt:${event.retryAttempt ?? 'final'}`,
    });
  }

  async recordError(executionId: string, error: string): Promise<void> {
    const record = this.require(executionId);
    record.errors.push(error);
    await this.flush(record);
  }

  async recordUsage(executionId: string, usage: TokenUsage): Promise<void> {
    const record = this.require(executionId);
    record.usage = {
      input: (record.usage?.input ?? 0) + usage.input,
      output: (record.usage?.output ?? 0) + usage.output,
      total: (record.usage?.total ?? 0) + (usage.total ?? usage.input + usage.output),
    };
    await this.flush(record);
  }

  async recordFileMutations(executionId: string, mutations: FileMutationResult[], contentFingerprint?: string): Promise<void> {
    const changed = mutations.filter(m => m.changed && m.beforeHash !== m.afterHash && (m.existedBefore || m.existsAfter));
    if (changed.length === 0) return;
    await this.recordFilesChanged(executionId, changed.map(m => m.path), { mutations: changed, contentFingerprint });
  }

  async recordFilesChanged(executionId: string, files: string[], evidence?: { mutations: FileMutationResult[]; contentFingerprint?: string }): Promise<void> {
    if (!files || files.length === 0) return;
    const record = this.require(executionId);
    if (!record.workspaceState) {
      record.workspaceState = {
        workspaceId: executionId,
        revision: 0,
        updatedAt: new Date(),
      };
    }
    if (!record.mutationHistory) {
      record.mutationHistory = [];
    }

    record.workspaceState.revision += 1;
    record.workspaceState.updatedAt = new Date();
    if (evidence?.contentFingerprint) record.workspaceState.contentFingerprint = evidence.contentFingerprint;
    const currentRev = record.workspaceState.revision;

    if (evidence) this.pushEvent(record, 'workspace.mutated', { workspaceRevision: currentRev, mutations: evidence.mutations });

    for (const file of files) {
      if (!record.filesChanged.includes(file)) {
        record.filesChanged.push(file);
      }
      record.mutationHistory.push({
        path: file,
        revision: currentRev,
        at: new Date(),
      });
      this.pushEvent(record, 'file.changed', { file, workspaceRevision: currentRev });
    }

    this.pushEvent(record, 'workspace.revision_changed', {
      workspaceRevision: currentRev,
      files,
    });
    this.pushEvent(record, 'workspace.revision.changed', { workspaceRevision: currentRev, files });

    if (record.evidence && record.evidence.some((e) => e.revision < currentRev)) {
      this.pushEvent(record, 'verification.invalidated', { workspaceRevision: currentRev });
      this.pushEvent(record, 'evidence.stale', {
        workspaceRevision: currentRev,
        staleEvidenceCount: record.evidence.filter((e) => e.revision < currentRev).length,
      });
    }

    for (const file of files) {
      // Register artifact provenance if provenance manager is available
      if (this.provenanceManager && !file.startsWith('node_modules') && !file.startsWith('.git')) {
        try {
          const content = await this.readFile(file);
          const hash = await computeContentHash(content);
          const size = Buffer.byteLength(content, 'utf8');
          
          const artifactParams: CreateArtifactParams = {
            type: file.endsWith('.ts') || file.endsWith('.js') ? 'generated_code' : 'source',
            name: file.split('/').pop() ?? file,
            location: file,
            contentHash: hash,
            sizeBytes: size,
            workspace: this.workspace,
            executionId: executionId,
            agentId: record.execution.agentId || '',
            modelId: record.execution.modelId,
            runtimeId: record.execution.runtimeId,
            computerId: record.execution.computerId,
            workerId: record.execution.workerId,
            toolsUsed: record.toolCalls.map(t => t.tool),
            mcpServersUsed: [],
            connectorsUsed: [],
            policyDecisions: record.policyDecisions.map(d => d.rule),
            inputArtifactIds: [],
            parentArtifactIds: [],
            evaluations: record.checks.map(c => c.name),
            reviewers: [],
            gitMetadata: {
              repository: this.getGitRepo(file),
              branch: await this.getGitBranch(file),
              commit: await this.getGitCommit(file),
              dirty: false,
              changedFiles: [file],
              diffHash: ''
            }
          };
          
          await this.provenanceManager.registerArtifact(artifactParams);
        } catch {
          // Ignore provenance registration errors
        }
      }
    }
    await this.flush(record);
  }

  getFilesChangedSince(executionId: string, revision: number): string[] {
    const record = this.require(executionId);
    if (!record.mutationHistory) return [];
    const changed = new Set<string>();
    for (const entry of record.mutationHistory) {
      if (entry.revision > revision) {
        changed.add(entry.path);
      }
    }
    return Array.from(changed);
  }

  getWorkspaceRevision(executionId: string): number {
    return this.require(executionId).workspaceState?.revision ?? 0;
  }

  async setResult(executionId: string, result: string): Promise<void> {
    const record = this.require(executionId);
    record.result = sanitizeUntrustedOutput(result);
    const sources = new Map<string, import('../types/web.js').Citation>();
    for (const event of record.events) if (event.type === 'web.evidence') {
      const evidence = event.data as import('../types/web.js').GroundedResult;
      const citations = evidence.kind === 'web_document' ? [evidence.citation] : evidence.results.map(r => r.citation);
      for (const citation of citations) sources.set(citation.citationId, citation);
    }
    if (sources.size) {
      const referenced = [...new Set(result.match(/web-[a-f0-9]{20}/g) ?? [])];
      this.pushEvent(record, 'web.answer', {
        citedSourceIds: [...sources.values()].filter(c => result.includes(c.citationId) || result.includes(c.url) || result.includes(c.finalUrl)).map(c => c.citationId),
        unissuedSourceIds: referenced.filter(id => !sources.has(id)),
        claimVerification: 'references_only_not_semantic_entailment',
      });
    }
    
    // Register execution summary as an artifact
    if (this.provenanceManager) {
      try {
        const content = JSON.stringify({
          result,
          task: record.task,
          executionId,
          status: record.execution.status
        });
        const hash = await computeContentHash(Buffer.from(content, 'utf8'));
        
        const artifactParams: CreateArtifactParams = {
          type: 'report',
          name: `execution-summary-${record.execution.id}`,
          location: `.wazir/artifacts/${record.execution.id}.json`,
          contentHash: hash,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          workspace: this.workspace,
          executionId: executionId,
          agentId: record.execution.agentId || '',
          modelId: record.execution.modelId,
          runtimeId: record.execution.runtimeId,
          computerId: record.execution.computerId,
          workerId: record.execution.workerId,
          toolsUsed: record.toolCalls.map(t => t.tool),
          mcpServersUsed: [],
          connectorsUsed: [],
          policyDecisions: record.policyDecisions.map(d => d.rule),
          inputArtifactIds: [],
          parentArtifactIds: [],
          evaluations: record.checks.map(c => c.name),
          reviewers: []
        };
        
        await this.provenanceManager.registerArtifact(artifactParams);
      } catch {
        // Ignore provenance registration errors
      }
    }
    
    await this.flush(record);
  }

  async setEvaluation(executionId: string, evaluation: EvaluationResult): Promise<void> {
    const record = this.require(executionId);
    record.evaluation = evaluation;
    this.pushEvent(record, 'evaluation.completed', evaluation);
    
    // Register test results as artifacts
    if (this.provenanceManager) {
      try {
        for (const check of record.checks) {
          {
            const content = JSON.stringify({
              ...check,
              executionId,
              taskId: record.task.id
            });
            const hash = await computeContentHash(Buffer.from(content, 'utf8'));
            
            const artifactParams: CreateArtifactParams = {
              type: 'test_result',
              name: `test-${check.name.replace(/\s+/g, '-')}`,
              location: check.command,
              contentHash: hash,
              sizeBytes: Buffer.byteLength(content, 'utf8'),
              workspace: this.workspace,
              executionId: executionId,
              agentId: record.execution.agentId || '',
              modelId: record.execution.modelId,
              runtimeId: record.execution.runtimeId,
              computerId: record.execution.computerId,
              workerId: record.execution.workerId,
              toolsUsed: [check.name],
              mcpServersUsed: [],
              connectorsUsed: [],
              policyDecisions: [],
              inputArtifactIds: [],
              parentArtifactIds: [],
              evaluations: [],
              reviewers: []
            };
            
            await this.provenanceManager.registerArtifact(artifactParams);
          }
        }
      } catch {
        // Ignore provenance registration errors
      }
    }
    
    await this.flush(record);
  }

  private async readFile(filepath: string): Promise<Buffer> {
    try {
      const { promises: fs } = await import('node:fs');
      return await fs.readFile(filepath);
    } catch {
      return Buffer.from('');
    }
  }

  private getGitRepo(filepath: string): string | undefined {
    // Simplified - in production, this would parse .git/config
    return process.env.GIT_REPO;
  }

  private async getGitBranch(filepath: string): Promise<string | undefined> {
    try {
      const { exec } = await import('node:child_process');
      return 'main'; // simplified
    } catch {
      return undefined;
    }
  }

  private async getGitCommit(filepath: string):Promise<string | undefined> {
    try {
      const { exec } = await import('node:child_process');
      return 'HEAD'; // simplified
    } catch {
      return undefined;
    }
  }

  async get(executionId: string): Promise<ExecutionRecord | undefined> {
    await this.ready;
    return this.records.get(executionId);
  }

  require(executionId: string): ExecutionRecord {
    if (this.persistenceFailure) throw this.persistenceFailure;
    const record = this.records.get(executionId);
    if (!record) {
      throw new Error(`Execution '${executionId}' not found`);
    }
    return record;
  }

  async list(): Promise<ExecutionRecord[]> {
    await this.ready;
    return Array.from(this.records.values()).sort((a, b) =>
      b.execution.createdAt.getTime() - a.execution.createdAt.getTime(),
    );
  }

  async listByTask(taskId: string): Promise<ExecutionRecord[]> {
    const records = await this.list();
    return records.filter((r) => r.execution.taskId === taskId);
  }

  private static readonly NON_TERMINAL: ExecutionStatus[] = ['queued', 'scheduled', 'assigned', 'running', 'waiting'];

  /** Non-terminal executions currently assigned to a computer — the set a dead worker leaves stranded. */
  async listActiveByComputer(computerId: string): Promise<ExecutionRecord[]> {
    const records = await this.list();
    return records.filter(
      (r) => r.execution.computerId === computerId && ExecutionEngine.NON_TERMINAL.includes(r.execution.status),
    );
  }

  /**
   * Marks a non-terminal execution as failed because the worker that owned it stopped
   * heartbeating, distinct from an ordinary task failure so callers (and the UI) can tell
   * "the work errored" apart from "the machine running it disappeared".
   */
  async orphan(executionId: string, reason: string): Promise<void> {
    const record = this.require(executionId);
    if (!ExecutionEngine.NON_TERMINAL.includes(record.execution.status)) return;
    record.execution.status = 'failed';
    record.execution.completedAt = new Date();
    record.errors = [...(record.errors ?? []), `ORPHANED_WORKER_UNREACHABLE: ${reason}`];
    this.pushEvent(record, 'execution.failed', { status: 'failed', reason, kind: 'ORPHANED_WORKER_UNREACHABLE' });
    await this.flush(record);
  }

  async listChildren(executionId: string): Promise<ExecutionRecord[]> {
    const records = await this.list();
    return records.filter((r) => r.execution.parentExecutionId === executionId);
  }

  async events(executionId: string): Promise<SequencedExecutionEvent[]> {
    await this.ready;
    const record = await this.get(executionId);
    if (!record) {
      throw new Error(`Execution '${executionId}' not found`);
    }
    return structuredClone(this.histories.get(executionId) ?? []);
  }

  /** Replays the recorded event stream in order. */
  async *replay(executionId: string): AsyncIterable<ExecutionEvent> {
    const events = await this.events(executionId);
    for (const event of events) {
      yield event;
    }
  }

  private pushEvent(record: ExecutionRecord, type: ExecutionEventType, data?: unknown, identity: ExecutionEventIdentity = {}): void {
    const history = this.histories.get(record.execution.id)!;
    const existing = identity.eventId && history.find(event => event.eventId === identity.eventId);
    if (existing) {
      if (existing.type !== type || !executionValuesEqual(existing.data, data) ||
          ['turnId', 'stepId', 'attemptId', 'callId'].some(key =>
            existing[key as keyof ExecutionEventIdentity] !== identity[key as keyof ExecutionEventIdentity])) {
        throw new Error(`Conflicting event insertion '${identity.eventId}'`);
      }
      return;
    }
    const id = identity.eventId ?? `evt-${randomUUID()}`;
    history.push(structuredClone({
      ...identity,
      id,
      eventId: id,
      executionId: record.execution.id,
      jobId: record.execution.jobId ?? null,
      sequence: history.length + 1,
      type,
      eventType: type,
      timestamp: new Date(),
      agentId: record.execution.agentId,
      modelId: record.execution.modelId,
      runtimeId: record.execution.runtimeId,
      computerId: record.execution.computerId,
      workerId: record.execution.workerId,
      workspaceRevision: record.workspaceState?.revision ?? 0,
      data,
    }));
    record.events = structuredClone(history);
  }

  /**
   * True when a different process on this host last wrote the execution and is still
   * alive. Such an execution is that process's to finish or recover; a remote or
   * unstamped (legacy) owner can't be checked here and returns false.
   */
  /** The latched failure after a write was rejected (e.g. EXECUTION_STORAGE_CONFLICT);
   *  once set, every later write rethrows it, so callers must stop writing. */
  get persistenceError(): Error | undefined {
    return this.persistenceFailure;
  }

  /**
   * Pauses execution mid-flight.
   */
  async pause(executionId: string, reason?: string): Promise<void> {
    const record = this.require(executionId);
    this.pausedExecutions.add(executionId);
    record.execution.status = 'paused';
    this.pushEvent(record, 'execution.paused', {
      executionId,
      reason: reason ?? 'Paused by operator',
      pausedAt: new Date(),
    });
    await this.flush(record);
  }

  /**
   * Steers execution by injecting guidance, modifying constraints, cancelling
   * scheduled tool calls, changing model routing mid-flight, or forcing re-verification.
   */
  async steer(
    executionId: string,
    instruction: string | SteeringParams,
  ): Promise<SteeringResult> {
    const record = this.require(executionId);
    const params: SteeringParams = typeof instruction === 'string'
      ? { guidance: instruction, who: 'user' }
      : instruction;

    const who = params.who ?? 'user';
    const effectiveAt = new Date();

    // 1. Injected guidance
    if (params.guidance) {
      let queue = this.steeringQueues.get(executionId);
      if (!queue) {
        queue = [];
        this.steeringQueues.set(executionId, queue);
      }
      queue.push(params);
    }

    // 2. Modifying constraints
    if (params.injectedConstraints) {
      const c = params.injectedConstraints;
      if (c.maxTurns !== undefined) {
        record.task.maxTurns = c.maxTurns;
      }
      if (c.maxExecutionTimeSeconds !== undefined) {
        if (!record.task.policy) record.task.policy = {};
        record.task.policy.maxExecutionTimeSeconds = c.maxExecutionTimeSeconds;
      }
      if (c.protectedFiles && c.protectedFiles.length > 0) {
        if (!record.task.expectedEvidence) record.task.expectedEvidence = [];
        for (const pf of c.protectedFiles) {
          record.task.expectedEvidence.push(`protected:${pf}`);
        }
      }
    }

    // 3. Canceling scheduled tool calls
    if (params.cancelScheduledToolCalls) {
      let cancelled = this.cancelledToolCalls.get(executionId);
      if (!cancelled) {
        cancelled = new Set<string>();
        this.cancelledToolCalls.set(executionId, cancelled);
      }
      cancelled.add('*');
    }

    // 4. Changing model routing mid-flight
    let modelRoutingChanged: { modelId: string; runtimeId?: string } | undefined;
    if (params.changeModelRouting) {
      const fromModel = record.execution.modelId;
      const toModel = params.changeModelRouting.modelId;
      const fromRuntime = record.execution.runtimeId;
      const toRuntime = params.changeModelRouting.runtimeId ?? fromRuntime;

      record.execution.modelId = toModel;
      record.execution.runtimeId = toRuntime;
      modelRoutingChanged = { modelId: toModel, runtimeId: toRuntime };

      this.pushEvent(record, 'model.route.changed', {
        executionId,
        fromModel,
        toModel,
        fromRuntime,
        toRuntime,
        reason: 'Steered mid-flight',
      });
    }

    // 5. Forcing re-verification
    if (params.forceReverification) {
      this.pushEvent(record, 'verification.invalidated', {
        executionId,
        workspaceRevision: record.workspaceState?.revision ?? 0,
        reason: 'Re-verification forced by steering',
      });
      if (record.evidence) {
        record.evidence = [];
      }
    }

    const whatChanged = {
      guidance: params.guidance,
      constraintsModified: params.injectedConstraints,
      toolCallsCancelled: params.cancelScheduledToolCalls,
      modelRoutingChanged,
      forcedReverification: params.forceReverification,
    };

    // Emit execution.steered event for provenance audit
    this.pushEvent(record, 'execution.steered', {
      executionId,
      who,
      whatChanged,
      effectiveAt,
    });

    await this.flush(record);

    return {
      executionId,
      who,
      whatChanged,
      effectiveAt,
      success: true,
    };
  }

  /**
   * Resumes a paused execution.
   */
  async resume(executionId: string, reason?: string): Promise<void> {
    const record = this.require(executionId);
    this.pausedExecutions.delete(executionId);
    record.execution.status = 'running';
    this.pushEvent(record, 'execution.resumed', {
      executionId,
      reason: reason ?? 'Resumed by operator',
      resumedAt: new Date(),
    });
    await this.flush(record);
  }

  isPaused(executionId: string): boolean {
    return this.pausedExecutions.has(executionId);
  }

  getSteering(executionId: string): SteeringParams | undefined {
    const queue = this.steeringQueues.get(executionId);
    return queue && queue.length > 0 ? queue.shift() : undefined;
  }

  isToolCancelled(executionId: string, callId?: string): boolean {
    const cancelled = this.cancelledToolCalls.get(executionId);
    if (!cancelled) return false;
    if (cancelled.has('*')) return true;
    return callId ? cancelled.has(callId) : false;
  }

  ownedByAnotherLiveProcess(record: ExecutionRecord): boolean {
    const owner = record.execution.owner;
    if (!owner || owner.host !== this.owner.host || owner.pid === this.owner.pid) return false;
    return this.isProcessAlive(owner.pid);
  }

  private async flush(record: ExecutionRecord): Promise<void> {
    if (this.persistenceFailure) throw this.persistenceFailure;
    // Every write claims the execution for this process (e.g. a retry resuming it).
    record.execution.owner = { ...this.owner };
    if (this.persist) {
      record.storageRevision = (record.storageRevision ?? 0) + 1;
      const snapshot = structuredClone({ ...record, events: this.histories.get(record.execution.id) });
      const pending = this.persistenceTail.then(async () => {
        if (this.persistenceFailure) throw this.persistenceFailure;
        await this.persist!(snapshot);
      });
      this.persistenceTail = pending.catch(error => {
        this.persistenceFailure = error instanceof Error ? error : new Error(String(error));
      });
      await pending;
    }
  }
}

export function createExecutionEngine(options: ExecutionEngineOptions = {}): ExecutionEngine {
  return new ExecutionEngine(options);
}
