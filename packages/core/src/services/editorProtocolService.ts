import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { KeyValueStore } from '@wazir/shared';
import type {
  AgentProtocolTask,
  AgentProtocolStep,
  AgentProtocolStepOutcome,
  AgentProtocolArtifact,
  ControlledToolExecutor,
  ControlledToolResult,
  CreateTaskRequestBody,
  ExecuteStepRequestBody,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDescriptor,
  McpResourceDescriptor,
  McpPromptDescriptor,
  ProtocolPrincipal,
  ProtocolRequestContext,
  ProtocolScope,
  StepReconciliation,
  StepVerificationReport,
  StepVerifier,
  WorkspaceMutationEpoch,
} from '../types/editorProtocol.js';

/** Read-only view of the tool catalogue; execution goes through `executeTool` only. */
export interface ToolRegistry {
  descriptors(): any[];
}

export interface EditorProtocolServiceOptions {
  store: KeyValueStore;
  tools?: ToolRegistry;
  /** The policy-enforced execution boundary. Absent, every tool call fails closed. */
  executeTool?: ControlledToolExecutor;
  /** Runs independent checks for `verify`. Absent, verification is UNAVAILABLE, never PASS. */
  verify?: StepVerifier;
  /** Tools exposed over MCP / Agent Protocol; `tools/list` advertises only these. */
  toolSurface?: readonly string[];
  projectRoot?: string;
  /** How long a step's lease survives without a heartbeat before another process may recover it. */
  stepLeaseMs?: number;
  /** How long a step request waits for another in-flight step of the same task before TASK_BUSY. */
  admissionWaitMs?: number;
  /**
   * Content fingerprint of the workspace. When provided, verification is bound to
   * it and reported STALE after any change, including ones made outside the protocol.
   */
  workspaceRevision?: () => Promise<string>;
}

/** JSON-RPC methods a read-only (viewer) principal may call. Everything else needs `execute`. */
export const MCP_READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
]);

/** Scope a JSON-RPC method requires. Unknown methods get the most privileged scope. */
export function mcpMethodScope(method: string): ProtocolScope {
  return MCP_READ_ONLY_METHODS.has(method) ? 'read' : 'execute';
}

export function hasScope(principal: ProtocolPrincipal | undefined, scope: ProtocolScope): principal is ProtocolPrincipal {
  return principal !== undefined && principal.scopes.includes(scope);
}

/** JSON-RPC error code for an authenticated caller lacking the method's scope. */
export const JSONRPC_FORBIDDEN = -32001;

const VERIFICATION_STATUS_KEY = 'editor_protocol/verification/latest';
const WORKSPACE_EPOCH_KEY = 'editor_protocol/workspace/epoch';
const CHECK_NAMES = new Set(['test', 'lint', 'typecheck', 'build']);
const DEFAULT_STEP_LEASE_MS = 120_000;
const DEFAULT_ADMISSION_WAIT_MS = 30_000;
const ADMISSION_POLL_MS = 50;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export type ProtocolErrorCode =
  | 'TASK_NOT_FOUND' | 'TASK_TERMINAL' | 'STEP_INVALID' | 'FORBIDDEN'
  /** Another step of the task is in flight (possibly in another API process). */
  | 'TASK_BUSY'
  /** A dispatched tool's outcome is unknown; the task accepts no steps until reconciled. */
  | 'RECONCILIATION_REQUIRED'
  /** This process lost ownership of the step (its lease expired and was recovered elsewhere). */
  | 'STATE_CONFLICT'
  /** A durable write failed; the message states whether a tool was dispatched. */
  | 'PERSISTENCE_FAILED'
  /** The store cannot perform atomic read-modify-write updates. */
  | 'UNSUPPORTED_STORE';

export class ProtocolError extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}

function outcomeFromFailure(result: ControlledToolResult): AgentProtocolStepOutcome {
  switch (result.failureClass) {
    case 'POLICY_DENIED': return 'POLICY_DENIED';
    case 'CANCELLED': return 'CANCELLED';
    case 'TOOL_TIMEOUT': return 'TIMED_OUT';
    case 'TOOL_OUTCOME_UNKNOWN': return 'OUTCOME_UNKNOWN';
    default: return 'TOOL_FAILED';
  }
}

/** Accepts `verify: true` (run `test`), a check-name array, or `{ checks: [...] }`. */
function requestedChecks(verify: unknown): string[] | undefined {
  if (verify === undefined || verify === false || verify === null) return undefined;
  if (verify === true) return ['test'];
  const list = Array.isArray(verify) ? verify : (verify as { checks?: unknown })?.checks;
  if (!Array.isArray(list) || list.length === 0 || !list.every((c) => typeof c === 'string' && CHECK_NAMES.has(c))) {
    throw new ProtocolError('STEP_INVALID', `verify must be true or a non-empty list of ${[...CHECK_NAMES].join('|')}`);
  }
  return [...new Set(list as string[])];
}

function parseToolCall(raw: unknown): { name: string; input: Record<string, unknown> } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const call = raw as { name?: unknown; input?: unknown };
  if (typeof call !== 'object' || typeof call.name !== 'string' || !call.name) {
    throw new ProtocolError('STEP_INVALID', 'additional_input.tool must be { name: string, input?: object }');
  }
  const input = call.input ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolError('STEP_INVALID', 'additional_input.tool.input must be an object');
  }
  return { name: call.name, input: input as Record<string, unknown> };
}

function parseIdempotencyKey(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !raw || raw.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ProtocolError('STEP_INVALID', `additional_input.idempotency_key must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  return raw;
}

const HOST = os.hostname();

/**
 * True when the lease's owner is provably gone: a process on this host whose pid
 * no longer exists. Owners on other hosts (or legacy owner ids) are only
 * recovered by lease expiry, since their liveness cannot be observed here.
 */
function ownerIsDead(owner: string): boolean {
  const match = /^(.*):(\d+):[^:]+$/.exec(owner);
  if (!match || match[1] !== HOST) return false;
  const pid = Number(match[2]);
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** A lease another process may take over: expired, or held by a dead local process. */
const leaseRecoverable = (lease: { expires_at_ms: number; owner: string; lease_id: string }, now: number): boolean =>
  lease.expires_at_ms <= now || ownerIsDead(lease.owner);

const isTerminal = (task: AgentProtocolTask): boolean => task.status === 'completed' || task.status === 'failed';

/** JsonFileStore revives ISO strings as Dates; compare instants whatever the stored shape. */
const instant = (value: unknown): number => (value instanceof Date ? value.getTime() : Date.parse(String(value)));

/** Verification evidence a principal without `execute` may see: statuses, never check output. */
function redactReport(report: StepVerificationReport): Record<string, unknown> {
  return {
    status: report.status, executionId: report.executionId, taskId: report.taskId, stepId: report.stepId,
    workspaceRevision: report.workspaceRevision, workspaceEpoch: report.workspaceEpoch, workspaceFingerprint: report.workspaceFingerprint, requestedChecks: report.requestedChecks,
    startedAt: report.startedAt, completedAt: report.completedAt,
    checks: report.checks.map((c) => ({ name: c.name, status: c.status, durationMs: c.durationMs, startedAt: c.startedAt, completedAt: c.completedAt })),
    redacted: true,
  };
}

interface StepPlan {
  toolCall?: { name: string; input: Record<string, unknown> };
  checks?: string[];
  isLast: boolean;
  executionId: string;
  input?: string;
}

/** Applies a mutation to the step this process owns; throws if ownership was lost. */
type StepCommit = (mutate: (task: AgentProtocolTask, step: AgentProtocolStep) => void) => Promise<AgentProtocolTask>;

export class EditorProtocolService {
  private readonly store: KeyValueStore;
  private readonly tools?: ToolRegistry;
  private readonly executeTool?: ControlledToolExecutor;
  private readonly verifier?: StepVerifier;
  private readonly toolSurface?: readonly string[];
  private readonly projectRoot: string;
  private readonly stepLeaseMs: number;
  private readonly admissionWaitMs: number;
  private readonly instanceId = `${HOST}:${process.pid}:${randomUUID()}`;
  private readonly workspaceRevision?: () => Promise<string>;
  /**
   * Queues this process's own requests per task so they wait in order instead
   * of polling the store. It is an optimisation only: cross-process exclusion
   * comes from the step lease in the task record, taken by an atomic update.
   */
  private readonly taskLocks = new Map<string, Promise<unknown>>();

  constructor(options: EditorProtocolServiceOptions) {
    this.store = options.store;
    this.tools = options.tools;
    this.executeTool = options.executeTool;
    this.verifier = options.verify;
    this.toolSurface = options.toolSurface;
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.stepLeaseMs = options.stepLeaseMs ?? (Number(process.env.WAZIR_PROTOCOL_STEP_LEASE_MS) || DEFAULT_STEP_LEASE_MS);
    this.workspaceRevision = options.workspaceRevision;
    this.admissionWaitMs = options.admissionWaitMs ?? (Number(process.env.WAZIR_PROTOCOL_ADMISSION_WAIT_MS) || DEFAULT_ADMISSION_WAIT_MS);
  }

  private async withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.taskLocks.set(taskId, tail);
    try {
      return await run;
    } finally {
      if (this.taskLocks.get(taskId) === tail) this.taskLocks.delete(taskId);
    }
  }

  /** The store's atomic read-modify-write; a backend without one cannot host protocol tasks. */
  private atomicUpdate<T>(key: string, mutate: (current: T | undefined) => T): Promise<T> {
    if (typeof this.store.update !== 'function') {
      throw new ProtocolError('UNSUPPORTED_STORE', 'the configured store has no atomic update; protocol task mutations are refused rather than risk lost writes');
    }
    return this.store.update<T>(key, mutate);
  }

  /**
   * One atomic transition of the authoritative task record. `mutate` must be a
   * pure function of the record it is given: stores may invoke it under their
   * own lock against the freshest copy, and a throw aborts the write.
   */
  private async mutateTask<R>(taskId: string, mutate: (task: AgentProtocolTask) => R): Promise<{ task: AgentProtocolTask; result: R }> {
    let result!: R;
    const task = await this.atomicUpdate<AgentProtocolTask>(this.taskKey(taskId), (current) => {
      if (!current) throw new ProtocolError('TASK_NOT_FOUND', taskId);
      const next = structuredClone(current);
      result = mutate(next);
      next.additional_output = { ...next.additional_output, revision: (current.additional_output?.revision ?? 0) + 1 };
      return next;
    });
    return { task, result };
  }

  private isReadOnlyTool(name: string): boolean {
    const descriptor = this.tools?.descriptors().find((d) => d?.name === name);
    return descriptor?.sideEffectClass === 'READ_ONLY';
  }

  /** Records, before dispatch, that the workspace may change; any earlier verification is then stale. */
  private async bumpWorkspaceEpoch(tool: string, executionId: string): Promise<void> {
    if (this.isReadOnlyTool(tool)) return;
    await this.atomicUpdate<WorkspaceMutationEpoch>(WORKSPACE_EPOCH_KEY, (current) =>
      ({ seq: (current?.seq ?? 0) + 1, at: new Date().toISOString(), executionId, tool }));
  }

  private async workspaceEpoch(): Promise<number> {
    return (await this.store.get<WorkspaceMutationEpoch>(WORKSPACE_EPOCH_KEY))?.seq ?? 0;
  }

  /** Dispatches through the injected boundary only; fails closed without it or without authority. */
  private async runTool(
    name: string,
    input: Record<string, unknown>,
    meta: { principal?: ProtocolPrincipal; executionId: string; source: 'mcp' | 'agent-protocol'; taskId?: string; stepId?: string; signal?: AbortSignal },
  ): Promise<ControlledToolResult> {
    const denied = (error: string, failureClass = 'POLICY_DENIED'): ControlledToolResult =>
      ({ ok: false, output: '', error, failureClass, durationMs: 0, callId: '', dispatched: false });
    if (!this.executeTool) return denied('controlled tool execution is not configured; refusing to dispatch', 'EXECUTION_UNAVAILABLE');
    if (!hasScope(meta.principal, 'execute')) return denied('caller is not authorized to execute tools');
    // The epoch moves only once policy has admitted the call, immediately before dispatch.
    let epochRecorded = false;
    const beforeDispatch = async (): Promise<void> => {
      await this.bumpWorkspaceEpoch(name, meta.executionId);
      epochRecorded = true;
    };
    let result: ControlledToolResult;
    try {
      result = await this.executeTool({ name, input, principal: meta.principal, executionId: meta.executionId,
        source: meta.source, taskId: meta.taskId, stepId: meta.stepId, signal: meta.signal, beforeDispatch });
    } catch (error) {
      // The boundary threw instead of reporting: whether the tool ran is not known.
      result = { ok: false, output: '', error: error instanceof Error ? error.message : String(error),
        failureClass: 'TOOL_OUTCOME_UNKNOWN', durationMs: 0, callId: '' };
    }
    // An executor that ignores `beforeDispatch` may still have dispatched: move the epoch late rather than never.
    if (!epochRecorded && result.dispatched !== false) await this.bumpWorkspaceEpoch(name, meta.executionId).catch(() => undefined);
    return result;
  }

  // =========================================================================
  // Agent Protocol (ACP) Implementation
  // =========================================================================

  private taskKey(taskId: string): string {
    return `editor_protocol/tasks/${taskId}`;
  }

  private stepKey(taskId: string, stepId: string): string {
    return `editor_protocol/steps/${taskId}/${stepId}`;
  }

  private artifactKey(taskId: string, artifactId: string): string {
    return `editor_protocol/artifacts/${taskId}/${artifactId}`;
  }

  async createTask(body: CreateTaskRequestBody, ctx: ProtocolRequestContext = {}): Promise<AgentProtocolTask> {
    if (!hasScope(ctx.principal, 'mutate')) throw new ProtocolError('FORBIDDEN', 'operator scope required to create tasks');
    if (body?.input !== undefined && typeof body.input !== 'string') throw new ProtocolError('STEP_INVALID', 'input must be a string');
    const taskId = `ap-task-${randomUUID()}`;
    const now = new Date().toISOString();

    const task: AgentProtocolTask = {
      task_id: taskId,
      input: body.input,
      additional_input: body.additional_input,
      artifacts: [],
      steps: [],
      created_at: now,
      status: 'created',
      additional_output: { revision: 1 },
    };

    // A fresh random key: no other writer can hold it yet.
    await this.store.put(this.taskKey(taskId), task);
    return task;
  }

  async getTask(taskId: string): Promise<AgentProtocolTask | undefined> {
    return this.store.get<AgentProtocolTask>(this.taskKey(taskId));
  }

  async listTasks(): Promise<AgentProtocolTask[]> {
    const entries = await this.store.list('editor_protocol/tasks/');
    const tasks = entries.map((e) => e.value as AgentProtocolTask);
    tasks.sort((a, b) => instant(b.created_at) - instant(a.created_at));
    return tasks;
  }

  async executeStep(taskId: string, body?: ExecuteStepRequestBody, ctx: ProtocolRequestContext = {}): Promise<AgentProtocolStep> {
    if (!hasScope(ctx.principal, 'mutate')) throw new ProtocolError('FORBIDDEN', 'operator scope required to execute steps');
    return this.withTaskLock(taskId, () => this.executeStepLocked(taskId, body, ctx));
  }

  /**
   * Resolves an expired lease left by a process that stopped mid-step. A step
   * that never reached dispatch is ABANDONED (nothing ran, the task continues);
   * one that was dispatching becomes OUTCOME_UNKNOWN and pauses the task, since
   * its side effect may or may not have happened and must not be retried blindly.
   */
  private recoverExpiredLease(task: AgentProtocolTask, now: number): void {
    const control = task.additional_output ?? {};
    const lease = control.active_step;
    if (!lease || !leaseRecoverable(lease, now)) return;
    const at = new Date(now).toISOString();
    const step = task.steps.find((s) => s.step_id === lease.step_id);
    task.additional_output = { ...control, active_step: undefined };
    if (!step || step.status !== 'running') return;
    const out = step.additional_output ?? (step.additional_output = {});
    step.status = 'failed';
    step.completed_at = at;
    if (out.phase === 'dispatching') {
      out.outcome = 'OUTCOME_UNKNOWN';
      out.reconciliation_required = true;
      step.output = `API process ${lease.owner} stopped after dispatching ${String((out.intent as { tool?: unknown } | undefined)?.tool ?? 'a tool')} without recording its outcome; reconciliation required`;
      task.status = 'paused';
      task.additional_output = { ...task.additional_output, outcome: 'OUTCOME_UNKNOWN', last_step_id: step.step_id,
        reconciliation_required: { step_id: step.step_id, reason: 'owner stopped after dispatch; tool outcome unrecorded', detected_at: at } };
    } else {
      out.outcome = 'ABANDONED';
      step.output = `API process ${lease.owner} stopped before ${out.phase === 'verifying' ? 'recording verification' : 'dispatching'}; nothing was recorded as executed`;
      task.status = 'running';
      task.additional_output = { ...task.additional_output, outcome: 'IN_PROGRESS', last_step_id: step.step_id };
    }
  }

  /** Atomically admits a step: one in flight per task, never after a terminal or unreconciled state. */
  private async admitStep(
    taskId: string, step: AgentProtocolStep, leaseId: string, idempotencyKey: string | undefined,
  ): Promise<{ step: AgentProtocolStep; duplicate: boolean }> {
    const deadline = Date.now() + this.admissionWaitMs;
    for (;;) {
      // Cheap read first, so waiting on a busy task does not rewrite the store on every poll.
      const seen = await this.getTask(taskId);
      if (!seen) throw new ProtocolError('TASK_NOT_FOUND', taskId);
      const seenLease = seen.additional_output?.active_step;
      const looksFree = !seenLease || leaseRecoverable(seenLease, Date.now()) || isTerminal(seen)
        || Boolean(idempotencyKey && seen.additional_output?.idempotency?.[idempotencyKey]);
      if (looksFree) {
        const { result } = await this.mutateTask(taskId, (task) => {
          const now = Date.now();
          this.recoverExpiredLease(task, now);
          const control = task.additional_output ?? {};
          const existing = idempotencyKey ? control.idempotency?.[idempotencyKey] : undefined;
          if (existing) {
            const prior = task.steps.find((s) => s.step_id === existing);
            if (prior) return { kind: 'duplicate' as const, step: prior };
          }
          if (isTerminal(task)) return { kind: 'terminal' as const, status: task.status };
          if (control.reconciliation_required) return { kind: 'reconcile' as const, stepId: control.reconciliation_required.step_id };
          if (control.active_step) return { kind: 'busy' as const };
          const admittedStep = { ...step, name: step.name ?? `step-${task.steps.length + 1}` };
          task.steps.push(admittedStep);
          task.status = 'running';
          task.additional_output = {
            ...control,
            outcome: 'IN_PROGRESS',
            active_step: { step_id: step.step_id, lease_id: leaseId, owner: this.instanceId, expires_at_ms: now + this.stepLeaseMs },
            idempotency: idempotencyKey ? { ...control.idempotency, [idempotencyKey]: step.step_id } : control.idempotency,
          };
          return { kind: 'admitted' as const, step: admittedStep };
        });
        if (result.kind === 'admitted') return { step: result.step, duplicate: false };
        if (result.kind === 'duplicate') return { step: result.step, duplicate: true };
        if (result.kind === 'terminal') throw new ProtocolError('TASK_TERMINAL', `${taskId} is already ${result.status}`);
        if (result.kind === 'reconcile') throw new ProtocolError('RECONCILIATION_REQUIRED', `${taskId} step ${result.stepId} has an unknown tool outcome; reconcile it before submitting steps`);
      } else if (seen.additional_output?.reconciliation_required) {
        throw new ProtocolError('RECONCILIATION_REQUIRED', `${taskId} step ${seen.additional_output.reconciliation_required.step_id} has an unknown tool outcome`);
      }
      if (Date.now() >= deadline) throw new ProtocolError('TASK_BUSY', `${taskId} has another step in flight; retry later`);
      await new Promise((resolve) => setTimeout(resolve, ADMISSION_POLL_MS));
    }
  }

  private async executeStepLocked(taskId: string, body: ExecuteStepRequestBody | undefined, ctx: ProtocolRequestContext): Promise<AgentProtocolStep> {
    const additional = (body?.additional_input ?? {}) as Record<string, unknown>;
    const toolCall = parseToolCall(additional.tool);
    const checks = requestedChecks(additional.verify);
    const idempotencyKey = parseIdempotencyKey(additional.idempotency_key);
    const isLast = additional.is_last === true;

    const stepId = `ap-step-${randomUUID()}`;
    const executionId = `ap-exec-${randomUUID()}`;
    const leaseId = `lease-${randomUUID()}`;
    const now = new Date().toISOString();
    const draft: AgentProtocolStep = {
      task_id: taskId,
      step_id: stepId,
      name: body?.input,
      status: 'running',
      output: '',
      additional_output: { execution_id: executionId, accepted_at: now, executed: false, phase: 'admitted',
        principal: ctx.principal?.id, custom: body?.additional_input },
      is_last: isLast,
      artifacts: [],
      created_at: now,
    };

    // Accepted + running is durable, and the lease held, before anything is dispatched.
    const admitted = await this.admitStep(taskId, draft, leaseId, idempotencyKey);
    if (admitted.duplicate) return admitted.step;

    const commit: StepCommit = async (mutate) => {
      const { task } = await this.mutateTask(taskId, (task) => {
        const lease = task.additional_output?.active_step;
        if (isTerminal(task) && task.additional_output?.last_step_id !== stepId) {
          throw new ProtocolError('TASK_TERMINAL', `${taskId} became ${task.status} during execution`);
        }
        if (!lease || lease.lease_id !== leaseId) {
          throw new ProtocolError('STATE_CONFLICT', `${taskId} step ${stepId} lease was lost; its state is owned by recovery now`);
        }
        const step = task.steps.find((s) => s.step_id === stepId);
        if (!step) throw new ProtocolError('STATE_CONFLICT', `${taskId} step ${stepId} is missing from the task record`);
        mutate(task, step);
        if (task.additional_output?.active_step) {
          task.additional_output.active_step = { ...task.additional_output.active_step, expires_at_ms: Date.now() + this.stepLeaseMs };
        }
      });
      return task;
    };

    // Renew the lease while the step runs; a lost lease surfaces at the next commit.
    const heartbeat = setInterval(() => {
      void commit(() => undefined).catch(() => undefined);
    }, Math.max(250, Math.floor(this.stepLeaseMs / 3)));
    heartbeat.unref?.();

    try {
      return await this.runStep(taskId, stepId, commit, { toolCall, checks, isLast, executionId, input: body?.input }, ctx);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      // Never leave an accepted step running: an unexpected fault before dispatch is a failure.
      const message = error instanceof Error ? error.message : String(error);
      const task = await commit((task, step) => {
        step.status = 'failed';
        step.output = `Step failed: ${message}`;
        step.additional_output = { ...step.additional_output, outcome: 'TOOL_FAILED', phase: 'done' };
        step.completed_at = new Date().toISOString();
        task.status = 'failed';
        task.additional_output = { ...task.additional_output, outcome: 'FAILED', last_step_id: stepId, failed_step_id: stepId, active_step: undefined };
      }).catch((persistError) => { throw this.persistenceFailure(persistError, `step fault (${message}) could not be recorded`); });
      return task.steps.find((s) => s.step_id === stepId)!;
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** A failed durable write, reported with what is known about side effects. */
  private persistenceFailure(error: unknown, detail: string): ProtocolError {
    if (error instanceof ProtocolError) return error;
    return new ProtocolError('PERSISTENCE_FAILED', `${detail}: ${error instanceof Error ? error.message : String(error)}`);
  }

  private async runStep(
    taskId: string,
    stepId: string,
    commit: StepCommit,
    plan: StepPlan,
    ctx: ProtocolRequestContext,
  ): Promise<AgentProtocolStep> {
    const { toolCall, checks, isLast, executionId } = plan;
    let outcome: AgentProtocolStepOutcome = 'RECORDED';
    let failed = false;
    const output: string[] = [];
    const fields: Record<string, unknown> = {};

    if (toolCall) {
      // Durable intent: if this cannot be written, nothing is dispatched.
      await commit((_task, step) => {
        step.additional_output = { ...step.additional_output, phase: 'dispatching', intent: { tool: toolCall.name, at: new Date().toISOString() } };
      }).catch((error) => { throw this.persistenceFailure(error, `intent for ${toolCall.name} could not be recorded; the tool was NOT dispatched`); });

      const result = await this.runTool(toolCall.name, toolCall.input, {
        principal: ctx.principal, executionId, source: 'agent-protocol', taskId, stepId, signal: ctx.signal,
      });
      fields.executed = result.dispatched ?? (result.callId !== '' && result.policy?.decision === 'allow');
      fields.tool = {
        name: toolCall.name,
        ok: result.ok,
        call_id: result.callId || undefined,
        failure_class: result.failureClass,
        error: result.error,
        duration_ms: result.durationMs,
        policy: result.policy,
        workspace_before_hash: result.workspaceBeforeHash,
        workspace_after_hash: result.workspaceAfterHash,
        file_mutations: result.fileMutations,
      };
      if (result.audit) {
        fields.audit_recorded = result.audit.recorded;
        if (!result.audit.recorded) fields.audit_error = result.audit.error;
      }
      if (result.ok) {
        outcome = 'TOOL_SUCCEEDED';
        output.push(result.output || `Tool ${toolCall.name} executed`);
      } else {
        failed = true;
        outcome = result.failureClass === 'EXECUTION_UNAVAILABLE' ? 'EXECUTION_UNAVAILABLE' : outcomeFromFailure(result);
        output.push(`Tool ${toolCall.name} failed (${result.failureClass ?? 'error'}): ${result.error ?? 'no error detail'}`);
      }

      if (checks && !failed) {
        // The tool's success is durable before verification starts.
        await commit((_task, step) => {
          step.additional_output = { ...step.additional_output, ...fields, outcome, phase: 'verifying' };
          step.output = output.join('\n');
        }).catch((error) => {
          throw this.persistenceFailure(error, `tool ${toolCall.name} WAS dispatched (ok=${result.ok}) but its outcome could not be recorded; ` +
            'the step stays pending and becomes OUTCOME_UNKNOWN for reconciliation; do not retry blindly');
        });
      }
    }

    let report: StepVerificationReport | undefined;
    if (checks && !failed) {
      if (!toolCall) {
        await commit((_task, step) => { step.additional_output = { ...step.additional_output, phase: 'verifying' }; })
          .catch((error) => { throw this.persistenceFailure(error, 'verification could not be started'); });
      }
      report = await this.runVerification(checks, ctx, executionId, taskId, stepId);
      fields.verification = report;
      if (report.status === 'PASS') {
        outcome = 'VERIFIED';
      } else {
        failed = true;
        outcome = report.status === 'UNAVAILABLE' ? 'VERIFICATION_UNAVAILABLE' : 'VERIFICATION_FAILED';
      }
      output.push(`Verification ${report.status} (${report.checks.length} executed check(s))${report.reasons.length ? `: ${report.reasons.join('; ')}` : ''}`);
    }

    if (!toolCall && !checks) output.push(`Recorded step for task ${taskId}: ${plan.input ?? 'step'} (no execution requested)`);

    // Step outcome, verification evidence and task status are one atomic write.
    const unknown = outcome === 'OUTCOME_UNKNOWN';
    const task = await commit((task, step) => {
      step.status = failed ? 'failed' : 'completed';
      step.output = output.join('\n');
      step.additional_output = { ...step.additional_output, ...fields, outcome, phase: 'done', ...(unknown ? { reconciliation_required: true } : {}) };
      step.completed_at = new Date().toISOString();
      const control = { ...task.additional_output, active_step: undefined, last_step_id: stepId };
      if (unknown) {
        task.status = 'paused';
        task.additional_output = { ...control, outcome: 'OUTCOME_UNKNOWN',
          reconciliation_required: { step_id: stepId, reason: `tool outcome unknown (${String((fields.tool as { failure_class?: unknown })?.failure_class ?? 'unknown')})`, detected_at: step.completed_at } };
      } else if (failed) {
        task.status = 'failed';
        task.additional_output = { ...control, outcome: 'FAILED', failed_step_id: stepId };
      } else if (isLast) {
        task.status = 'completed';
        task.additional_output = { ...control, outcome: outcome === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED' };
      } else {
        task.status = 'running';
        task.additional_output = { ...control, outcome: 'IN_PROGRESS' };
      }
    }).catch(async (error) => {
      if (error instanceof ProtocolError && (error.code === 'TASK_TERMINAL' || error.code === 'STATE_CONFLICT')) {
        await this.recordLateOutcome(taskId, stepId, outcome, fields);
        throw error;
      }
      throw this.persistenceFailure(error, toolCall
        ? `tool ${toolCall.name} WAS dispatched but the step outcome could not be recorded; the step becomes OUTCOME_UNKNOWN for reconciliation; do not retry blindly`
        : 'the step outcome could not be recorded; no tool was dispatched');
    });

    if (report) await this.recordLatestVerification(report);
    return task.steps.find((s) => s.step_id === stepId)!;
  }

  /**
   * After losing ownership, keeps what this process observed on the step for the
   * reconciler without changing any status (best effort; recovery owns the state).
   */
  private async recordLateOutcome(taskId: string, stepId: string, outcome: AgentProtocolStepOutcome, fields: Record<string, unknown>): Promise<void> {
    await this.mutateTask(taskId, (task) => {
      const step = task.steps.find((s) => s.step_id === stepId);
      if (step) step.additional_output = { ...step.additional_output, late_outcome: { outcome, ...fields, observed_at: new Date().toISOString(), by: this.instanceId } };
    }).catch(() => undefined);
  }

  /** Global pointer to the newest verification; only ever moves forward in time. */
  private async recordLatestVerification(report: StepVerificationReport): Promise<void> {
    await this.atomicUpdate<StepVerificationReport>(VERIFICATION_STATUS_KEY, (current) =>
      current && instant(current.completedAt) > instant(report.completedAt) ? current : report,
    ).catch(() => {
      // The authoritative evidence is already committed on the step; a missed
      // pointer only leaves the global status on an older (and epoch-checked) report.
    });
  }

  private async runVerification(
    checks: string[], ctx: ProtocolRequestContext, executionId: string, taskId: string, stepId: string,
  ): Promise<StepVerificationReport> {
    const startedAt = new Date().toISOString();
    const epochBefore = await this.workspaceEpoch();
    const provenance = { workspaceEpoch: epochBefore, requestedChecks: checks, principal: ctx.principal?.id };
    const base = { executionId, taskId, stepId, checks: [], startedAt, ...provenance };
    if (!this.verifier) {
      return { ...base, status: 'UNAVAILABLE', completedAt: new Date().toISOString(), reasons: ['no verification engine is configured'] };
    }
    if (!hasScope(ctx.principal, 'execute')) {
      return { ...base, status: 'UNAVAILABLE', completedAt: new Date().toISOString(), reasons: ['caller is not authorized to execute verification checks'] };
    }
    try {
      const raw = await this.verifier({ checks, principal: ctx.principal, executionId, taskId, stepId, signal: ctx.signal });
      const report: StepVerificationReport = { ...raw, ...provenance };
      if (report.status !== 'PASS') return report;
      // PASS only with executed, all-passing checks bound to this execution, covering
      // every requested check, against a workspace that did not change meanwhile.
      const problems: string[] = [];
      if (report.executionId !== executionId || report.taskId !== taskId || report.stepId !== stepId) problems.push('report is not bound to this execution');
      if (report.checks.length === 0 || !report.checks.every((c) => c.status === 'PASS')) problems.push('not every executed check passed');
      const executed = new Set(report.checks.filter((c) => c.status === 'PASS').map((c) => c.name));
      const missing = checks.filter((c) => !executed.has(c));
      if (missing.length) problems.push(`requested check(s) not executed: ${missing.join(', ')}`);
      if ((await this.workspaceEpoch()) !== epochBefore) problems.push('the workspace was mutated while verification ran');
      if (this.workspaceRevision) {
        try {
          report.workspaceFingerprint = await this.workspaceRevision();
        } catch (error) {
          problems.push(`workspace fingerprint unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return problems.length
        ? { ...report, status: 'ERROR', reasons: [...report.reasons, ...problems.map((p) => `PASS rejected: ${p}`)] }
        : report;
    } catch (error) {
      return { ...base, status: 'ERROR', completedAt: new Date().toISOString(), reasons: [`verification threw: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  /**
   * Operator resolution of an OUTCOME_UNKNOWN step after inspecting the
   * workspace. It never completes the task: `succeeded`/`not_executed` resume
   * it, `failed` fails it, and any completion still needs a new step.
   */
  async reconcileStep(
    taskId: string, stepId: string, body: { resolution?: unknown; evidence?: unknown }, ctx: ProtocolRequestContext = {},
  ): Promise<AgentProtocolTask> {
    if (!hasScope(ctx.principal, 'mutate')) throw new ProtocolError('FORBIDDEN', 'operator scope required to reconcile steps');
    const resolution = body?.resolution as StepReconciliation;
    if (resolution !== 'succeeded' && resolution !== 'failed' && resolution !== 'not_executed') {
      throw new ProtocolError('STEP_INVALID', 'resolution must be succeeded | failed | not_executed');
    }
    if (typeof body.evidence !== 'string' || !body.evidence.trim()) {
      throw new ProtocolError('STEP_INVALID', 'evidence (what was inspected) is required to reconcile an unknown outcome');
    }
    const evidence = body.evidence.slice(0, 4_000);
    return this.withTaskLock(taskId, async () => (await this.mutateTask(taskId, (task) => {
      this.recoverExpiredLease(task, Date.now());
      const pending = task.additional_output?.reconciliation_required;
      if (!pending || pending.step_id !== stepId) throw new ProtocolError('STEP_INVALID', `${taskId} step ${stepId} is not awaiting reconciliation`);
      const step = task.steps.find((s) => s.step_id === stepId);
      if (!step) throw new ProtocolError('STEP_INVALID', `${taskId} step ${stepId} does not exist`);
      const at = new Date().toISOString();
      step.additional_output = { ...step.additional_output, reconciliation_required: false,
        reconciliation: { resolution, evidence, by: ctx.principal?.id, at } };
      if (resolution === 'succeeded') {
        step.status = 'completed';
        step.additional_output.outcome = 'TOOL_SUCCEEDED';
      } else {
        step.status = 'failed';
        step.additional_output.outcome = resolution === 'failed' ? 'TOOL_FAILED' : 'ABANDONED';
      }
      const control = { ...task.additional_output, reconciliation_required: undefined, last_step_id: stepId };
      if (resolution === 'failed') {
        task.status = 'failed';
        task.additional_output = { ...control, outcome: 'FAILED', failed_step_id: stepId };
      } else {
        task.status = 'running';
        task.additional_output = { ...control, outcome: 'IN_PROGRESS' };
      }
    })).task);
  }

  /**
   * The view of a step a principal may see. Without `execute`, tool output, tool
   * inputs, errors and check output are withheld; outcomes and statuses remain.
   */
  viewStep(step: AgentProtocolStep, principal: ProtocolPrincipal | undefined): AgentProtocolStep {
    if (hasScope(principal, 'execute')) return step;
    const out = step.additional_output;
    if (!out) return step;
    const view: AgentProtocolStep = { ...step, additional_output: { ...out } };
    const v = view.additional_output!;
    const executedSomething = out.tool !== undefined || out.verification !== undefined || out.intent !== undefined;
    if (executedSomething) view.output = `[output withheld: requires execute scope] outcome=${String(out.outcome ?? 'pending')}`;
    delete v.custom;
    if (out.tool && typeof out.tool === 'object') {
      const { error: _error, ...tool } = out.tool as Record<string, unknown>;
      v.tool = tool;
    }
    if (out.verification) v.verification = redactReport(out.verification as StepVerificationReport);
    if (out.late_outcome && typeof out.late_outcome === 'object') v.late_outcome = { outcome: (out.late_outcome as { outcome?: unknown }).outcome };
    if (out.audit_error !== undefined) v.audit_error = '[withheld]';
    return view;
  }

  viewTask(task: AgentProtocolTask, principal: ProtocolPrincipal | undefined): AgentProtocolTask {
    if (hasScope(principal, 'execute')) return task;
    return { ...task, steps: task.steps.map((s) => this.viewStep(s, principal)) };
  }

  async listSteps(taskId: string): Promise<AgentProtocolStep[]> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new ProtocolError('TASK_NOT_FOUND', taskId);
    }
    return task.steps;
  }

  /** Steps live in the task record; per-step keys are only read for records written before that. */
  async getStep(taskId: string, stepId: string): Promise<AgentProtocolStep | undefined> {
    const task = await this.getTask(taskId);
    return task?.steps.find((s) => s.step_id === stepId) ?? this.store.get<AgentProtocolStep>(this.stepKey(taskId, stepId));
  }

  async listArtifacts(taskId: string): Promise<AgentProtocolArtifact[]> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new ProtocolError('TASK_NOT_FOUND', taskId);
    }
    return task.artifacts;
  }

  async createArtifact(
    taskId: string,
    artifactData: Partial<AgentProtocolArtifact> & { file_name: string },
    ctx: ProtocolRequestContext = {},
  ): Promise<AgentProtocolArtifact> {
    if (!hasScope(ctx.principal, 'mutate')) throw new ProtocolError('FORBIDDEN', 'operator scope required to create artifacts');
    if (typeof artifactData?.file_name !== 'string' || !artifactData.file_name) throw new ProtocolError('STEP_INVALID', 'file_name is required');
    const now = new Date().toISOString();
    const artifact: AgentProtocolArtifact = {
      artifact_id: `ap-art-${randomUUID()}`,
      agent_task_id: taskId,
      file_name: artifactData.file_name,
      relative_path: artifactData.relative_path,
      content: artifactData.content,
      created_at: now,
      modified_at: now,
    };
    // Appended inside the atomic update, so a concurrent step commit cannot drop it.
    await this.mutateTask(taskId, (task) => { task.artifacts.push(artifact); });
    return artifact;
  }

  async getArtifact(taskId: string, artifactId: string): Promise<AgentProtocolArtifact | undefined> {
    const task = await this.getTask(taskId);
    return task?.artifacts.find((a) => a.artifact_id === artifactId) ?? this.store.get<AgentProtocolArtifact>(this.artifactKey(taskId, artifactId));
  }

  // =========================================================================
  // Model Context Protocol (MCP) Server Implementation
  // =========================================================================

  /**
   * Latest recorded verification evidence. `verified: true` needs executed,
   * passing checks, an available engine, and no workspace mutation since the
   * checks ran; check output is shown only to principals holding `execute`.
   */
  async verificationStatus(ctx: ProtocolRequestContext = {}): Promise<Record<string, unknown>> {
    const engineAvailable = Boolean(this.verifier);
    const latest = await this.store.get<StepVerificationReport>(VERIFICATION_STATUS_KEY);
    if (!latest) {
      return { verified: false, status: engineAvailable ? 'UNKNOWN' : 'UNAVAILABLE', engineAvailable, reasons: ['no verification has been executed'] };
    }
    const epoch = await this.workspaceEpoch();
    const passed = latest.status === 'PASS' && latest.checks.length > 0 && latest.checks.every((c) => c.status === 'PASS');
    const reasons: string[] = [];
    if (!engineAvailable) reasons.push('no verification engine is configured; a recorded PASS is not current evidence');
    let stale = false;
    if (typeof latest.workspaceEpoch !== 'number') {
      stale = true;
      if (passed) reasons.push('recorded PASS is not bound to a workspace revision');
    } else if (latest.workspaceEpoch !== epoch) {
      stale = true;
      if (passed) reasons.push(`workspace mutated since verification (epoch ${latest.workspaceEpoch} -> ${epoch}); re-verify`);
    }
    // The content fingerprint also catches changes made outside the protocol (CLI agents, editors, git).
    if (!stale && passed && this.workspaceRevision) {
      const current = await this.workspaceRevision().catch(() => undefined);
      if (!latest.workspaceFingerprint || current === undefined || current !== latest.workspaceFingerprint) {
        stale = true;
        reasons.push(!latest.workspaceFingerprint ? 'recorded PASS has no workspace content fingerprint'
          : current === undefined ? 'current workspace fingerprint unavailable' : 'workspace content changed since verification; re-verify');
      }
    }
    const verified = passed && !stale && engineAvailable;
    const status = verified ? 'PASS' : !engineAvailable ? 'UNAVAILABLE' : passed ? 'STALE' : latest.status === 'PASS' ? 'ERROR' : latest.status;
    const evidence = hasScope(ctx.principal, 'execute') ? latest : redactReport(latest);
    return { verified, status, engineAvailable, workspaceEpoch: epoch, ...(reasons.length ? { reasons } : {}), evidence };
  }

  async handleJsonRpc(request: JsonRpcRequest, ctx: ProtocolRequestContext = {}): Promise<JsonRpcResponse | null> {
    if (Array.isArray(request)) {
      // Batches are unsupported, but a batch carrying a method the caller may not call
      // is reported as forbidden rather than merely malformed.
      const denied = (request as unknown[]).find((r) => !hasScope(ctx.principal, mcpMethodScope(String((r as { method?: unknown } | null)?.method ?? ''))));
      if (denied !== undefined) {
        return { jsonrpc: '2.0', id: null, error: { code: JSONRPC_FORBIDDEN, message: 'Forbidden: batch contains a method that requires execute scope' } };
      }
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: batch requests are not supported' } };
    }
    if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      const rawId = (request as { id?: unknown } | undefined)?.id;
      return {
        jsonrpc: '2.0',
        id: typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null,
        error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
      };
    }

    const id = request.id ?? null;

    // Each method is classified on its own; unknown methods need the highest scope
    // and are only reported as "not found" to a caller who holds it.
    const scope = mcpMethodScope(request.method);
    if (!hasScope(ctx.principal, scope)) {
      return { jsonrpc: '2.0', id, error: { code: JSONRPC_FORBIDDEN, message: `Forbidden: '${request.method}' requires ${scope} scope` } };
    }

    try {
      switch (request.method) {
        case 'initialize': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: true, listChanged: true },
                prompts: { listChanged: true },
              },
              serverInfo: {
                name: 'wazir-control-plane',
                version: '0.1.0',
              },
            },
          };
        }

        case 'notifications/initialized': {
          // Client acknowledgement; return null if no id was provided (notification)
          if (request.id === undefined) return null;
          return { jsonrpc: '2.0', id, result: {} };
        }

        case 'ping': {
          return { jsonrpc: '2.0', id, result: {} };
        }

        case 'tools/list': {
          const surface = this.toolSurface;
          const descriptors = (this.tools ? this.tools.descriptors() : []).filter((d) => !surface || surface.includes(d.name));
          const mcpTools: McpToolDescriptor[] = descriptors.map((d) => ({
            name: d.name,
            description: d.description,
            inputSchema: (d as any).parameters ?? (d as any).schema ?? { type: 'object', properties: {} },
          }));

          return {
            jsonrpc: '2.0',
            id,
            result: { tools: mcpTools },
          };
        }

        case 'tools/call': {
          const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
          if (!params?.name) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid params: tool name is required' },
            };
          }

          const args = params.arguments ?? {};
          if (typeof args !== 'object' || Array.isArray(args)) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: arguments must be an object' } };
          }
          const toolResult = await this.runTool(params.name, args, {
            principal: ctx.principal, executionId: `mcp-${randomUUID()}`, source: 'mcp', signal: ctx.signal,
          });
          const text = toolResult.ok
            ? toolResult.output || 'OK'
            : `${toolResult.failureClass ?? 'FAILED'}: ${toolResult.error ?? 'tool failed'}`;
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text }],
              isError: !toolResult.ok,
              _meta: { callId: toolResult.callId || undefined, failureClass: toolResult.failureClass, policy: toolResult.policy,
                dispatched: toolResult.dispatched, auditRecorded: toolResult.audit?.recorded, auditError: toolResult.audit?.error },
            },
          };
        }

        case 'resources/list': {
          const resources: McpResourceDescriptor[] = [
            {
              uri: 'wazir://workspace/status',
              name: 'Workspace Status',
              description: 'Current workspace status and path',
              mimeType: 'application/json',
            },
            {
              uri: 'wazir://verification/status',
              name: 'Verification Status',
              description: 'Status of verification oracles and suite',
              mimeType: 'application/json',
            },
          ];

          return {
            jsonrpc: '2.0',
            id,
            result: { resources },
          };
        }

        case 'resources/read': {
          const params = request.params as { uri?: string } | undefined;
          if (!params?.uri) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid params: uri is required' },
            };
          }

          let content = '{}';
          if (params.uri === 'wazir://workspace/status') {
            content = JSON.stringify({ projectRoot: this.projectRoot, status: 'ready' });
          } else if (params.uri === 'wazir://verification/status') {
            content = JSON.stringify(await this.verificationStatus(ctx));
          }

          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri: params.uri,
                  mimeType: 'application/json',
                  text: content,
                },
              ],
            },
          };
        }

        case 'prompts/list': {
          const prompts: McpPromptDescriptor[] = [
            {
              name: 'wazir-code-repair',
              description: 'Instructs Wazir to diagnose defect and formulate deterministic verified repair.',
              arguments: [
                { name: 'defect_description', description: 'Description of the bug or defect', required: true },
              ],
            },
            {
              name: 'wazir-feature-implementation',
              description: 'Instructs Wazir to implement a new feature with tests and full verification.',
              arguments: [
                { name: 'feature_spec', description: 'Specification of the feature', required: true },
              ],
            },
          ];

          return {
            jsonrpc: '2.0',
            id,
            result: { prompts },
          };
        }

        case 'prompts/get': {
          const params = request.params as { name?: string; arguments?: Record<string, string> } | undefined;
          if (!params?.name) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid params: prompt name is required' },
            };
          }

          const description = `Wazir Prompt: ${params.name}`;
          const promptText = `Execute task with Wazir Control Plane: ${params.arguments?.defect_description ?? params.arguments?.feature_spec ?? params.name}`;

          return {
            jsonrpc: '2.0',
            id,
            result: {
              description,
              messages: [
                {
                  role: 'user',
                  content: {
                    type: 'text',
                    text: promptText,
                  },
                },
              ],
            },
          };
        }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${request.method}` },
          };
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      };
    }
  }
}
