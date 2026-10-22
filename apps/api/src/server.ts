import express, { type Response } from 'express';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  AgentRegistry,
  ComputerRegistry,
  ModelRegistry,
  ModelLifecycleService,
  ModelLifecycleError,
  RuntimeRegistry,
  EditorProtocolService,
  ProtocolError,
  JSONRPC_FORBIDDEN,
  type ProtocolPrincipal,
  type ProtocolRequestContext,
  type PolicyActionRequest,
  type PolicyDecision,
  type ModelRecord,
  type ModelCapability,
  type RuntimeType,
  type WorkerExecutionRequest,
  type WorkerExecutionEvent,
  type WorkerEventType,
} from '@wazir/core';
import { currentLoad, discoverHardware, discoverRuntimes, type DiscoveredRuntime } from '@wazir/workers';
import { createOllamaAdapter } from '@wazir/runtimes-ollama';
import { createLMStudioAdapter } from '@wazir/runtimes-lmstudio';
import { createNvidiaAdapter } from '@wazir/runtimes-nvidia';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import { generateId, sanitizeUntrustedOutput, MemoryStore, type KeyValueStore } from '@wazir/shared';
import { ApiAuth, bearerToken, type ApiAuthOptions } from './auth.js';
import { createControlledExecution } from './toolExecution.js';
import { MobileServices, registerMobileRoutes } from './mobile.js';
import { wazirVersion } from './version.js';

// Bounds on in-memory state so an unauthenticated peer (or a runaway client)
// cannot grow the control plane without limit (security review F-19).
const MAX_QUEUED_PER_COMPUTER = 100;
const MAX_EXECUTION_RECORDS = 5_000;
const MAX_EVENTS_PER_CHANNEL = 10_000;
const MAX_OUTPUT_CHARS = 1_000_000;

interface ExecutionOutcome {
  ok: boolean;
  output: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

/**
 * Per-computer task dispatch: an SSE stream the worker holds open, plus a
 * queue for requests submitted while no worker is connected. This is the
 * bridge that lets the control plane push tasks to a remote worker — the
 * worker previously had no way to receive dispatched work at all.
 */
interface DurableDispatch {
  computerId: string;
  request: WorkerExecutionRequest;
  events: WorkerExecutionEvent[];
  outcome?: ExecutionOutcome;
  /** Epoch ms at which the outcome was committed; drives completed-record retention. */
  completedAt?: number;
  attempt: number;
  recovery?: 'orphaned';
  lease?: { token: string; expiresAt: number };
}

/**
 * Secondary index of dispatches that still need a worker. `dispatch/<id>` stays
 * the authoritative (and audit) record; `dispatch-pending/<id>` exists only
 * while that record has no outcome, so the redelivery path, which runs every
 * five seconds per connected worker, no longer re-reads every historical
 * dispatch ever made.
 */
const PENDING_PREFIX = 'dispatch-pending/';
/** An index entry whose record never appeared (crash mid-dispatch) is dropped after this. */
const ORPHAN_PENDING_INDEX_MS = 60_000;

export interface TaskDispatcherOptions {
  /**
   * Delete completed dispatch records older than this at startup. Undefined or
   * 0 keeps them forever (the default, preserving the audit trail). Defaults to
   * `WAZIR_DISPATCH_RETENTION_DAYS` when set.
   */
  completedRetentionMs?: number;
}

function retentionFromEnv(): number | undefined {
  const days = Number(process.env.WAZIR_DISPATCH_RETENTION_DAYS);
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : undefined;
}

export class TaskDispatcher {
  private readonly streams = new Map<string, Response>();
  /** Non-terminal dispatches only; terminal records are read from the store on demand. */
  private readonly records = new Map<string, DurableDispatch>();
  private readonly completedRetentionMs?: number;
  readonly ready: Promise<void>;

  constructor(private readonly store: KeyValueStore = new MemoryStore(),
    private readonly now: () => number = Date.now, readonly leaseMs = 30_000,
    options: TaskDispatcherOptions = {}) {
    if (!store.update) throw new Error('ATOMIC_STORE_REQUIRED');
    if (!Number.isFinite(leaseMs) || leaseMs < 100) throw new Error('INVALID_LEASE_DURATION');
    this.completedRetentionMs = options.completedRetentionMs ?? retentionFromEnv();
    this.ready = this.reconcileIndex().then(() => this.refresh());
  }

  private key(id: string): string { return `dispatch/${id}`; }
  private pendingKey(id: string): string { return `${PENDING_PREFIX}${id}`; }

  /**
   * One full scan at startup: index pending records written before the index
   * existed (or by a process that crashed between the two writes), and apply
   * completed-record retention. This is the only path that lists `dispatch/`.
   */
  private async reconcileIndex(): Promise<void> {
    const indexed = new Set((await this.store.list(PENDING_PREFIX)).map(e => e.key.slice(PENDING_PREFIX.length)));
    const cutoff = this.completedRetentionMs ? this.now() - this.completedRetentionMs : undefined;
    for (const entry of await this.store.list('dispatch/')) {
      const record = entry.value as DurableDispatch;
      const id = record.request.requestId;
      if (!record.outcome) {
        if (!indexed.has(id)) await this.store.put(this.pendingKey(id), { computerId: record.computerId, at: this.now() });
      } else if (cutoff !== undefined && record.completedAt !== undefined && record.completedAt < cutoff) {
        await this.store.delete(this.key(id));
      }
    }
  }

  private async refresh(): Promise<void> {
    const live = new Set<string>();
    for (const entry of await this.store.list(PENDING_PREFIX)) {
      const id = entry.key.slice(PENDING_PREFIX.length);
      const record = await this.store.get<DurableDispatch>(this.key(id));
      if (!record) {
        // The index is written before the record, so a missing record is either
        // a dispatch still in flight in another process or a crash leftover.
        const at = (entry.value as { at?: number } | undefined)?.at ?? 0;
        if (this.now() - at > ORPHAN_PENDING_INDEX_MS) await this.store.delete(entry.key);
        continue;
      }
      if (record.outcome) {
        await this.store.delete(entry.key);
        continue;
      }
      live.add(id);
      this.records.set(id, record);
    }
    for (const id of [...this.records.keys()]) {
      if (!live.has(id)) this.records.delete(id);
    }
  }
  isConnected(id: string): boolean { return this.streams.has(id); }
  get activeStreamsCount(): number { return this.streams.size; }
  get totalQueued(): number {
    return [...this.records.values()].filter(r => !r.outcome && (!r.lease || r.lease.expiresAt <= this.now())).length;
  }
  ownerOf(id: string): string | undefined { return this.records.get(id)?.computerId; }
  async owner(id: string): Promise<string | undefined> {
    return (await this.store.get<DurableDispatch>(this.key(id)))?.computerId;
  }
  async subscribe(id: string, res: Response): Promise<void> {
    this.disconnect(id);
    this.streams.set(id, res);
    await this.redeliver(id);
  }
  disconnect(id: string): void { this.streams.get(id)?.end(); this.streams.delete(id); }
  unsubscribe(id: string, res: Response): void {
    if (this.streams.get(id) === res) this.streams.delete(id);
  }
  async redeliver(computerId?: string): Promise<void> {
    await this.reconcile();
    await this.refresh();
    for (const r of this.records.values()) {
      if (computerId !== undefined && r.computerId !== computerId) continue;
      const stream = this.streams.get(r.computerId);
      if (stream && !r.outcome && (!r.lease || r.lease.expiresAt <= this.now())) {
        stream.write(`event: task\ndata: ${JSON.stringify(r.request)}\n\n`);
      }
    }
  }
  async pruneCompleted(retentionMs = this.completedRetentionMs ?? 0): Promise<number> {
    const cutoff = this.now() - retentionMs;
    let pruned = 0;
    for (const entry of await this.store.list('dispatch/')) {
      const record = entry.value as DurableDispatch | undefined;
      if (record?.outcome && record.completedAt !== undefined && record.completedAt <= cutoff) {
        await this.store.delete(entry.key);
        pruned += 1;
      }
    }
    return pruned;
  }
  async dispatch(computerId: string, request: WorkerExecutionRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
    await this.ready;
    await this.refresh();
    if ([...this.records.values()].filter(r => r.computerId === computerId && !r.outcome).length >= MAX_QUEUED_PER_COMPUTER) {
      return { ok: false, reason: 'RESOURCE_BUSY' };
    }
    try {
      // Index first: a crash after this leaves an orphan index entry (cleaned up
      // by refresh), never a pending record that redelivery cannot see.
      await this.store.put(this.pendingKey(request.requestId), { computerId, at: this.now() });
      const record = await this.store.update!<DurableDispatch>(this.key(request.requestId), current => {
        if (current) throw new Error('REQUEST_ALREADY_DISPATCHED');
        return { computerId, request, events: [], attempt: 0 };
      });
      this.records.set(request.requestId, record);
      this.streams.get(computerId)?.write(`event: task\ndata: ${JSON.stringify(request)}\n\n`);
      return { ok: true };
    } catch (error) {
      if (error instanceof Error && error.message === 'REQUEST_ALREADY_DISPATCHED') return { ok: false, reason: error.message };
      throw error;
    }
  }
  async claim(id: string, computerId: string): Promise<{ token: string; expiresAt: number; leaseMs: number; attempt: number }> {
    const record = await this.store.update!<DurableDispatch>(this.key(id), current => {
      if (!current || current.computerId !== computerId) throw new Error('UNKNOWN_DISPATCH');
      if (current.outcome || (current.lease && current.lease.expiresAt > this.now())) throw new Error('RESOURCE_BUSY');
      if (current.attempt > 0 && current.request.replayPolicy !== 'read-only') return this.terminal(current, 'UNKNOWN_OUTCOME');
      return { ...current, recovery: undefined, attempt: current.attempt + 1,
        events: [...current.events.slice(-(MAX_EVENTS_PER_CHANNEL - 1)), { executionId: current.request.executionId, type: 'lease_acquired' as const, at: new Date(this.now()), data: { attempt: current.attempt + 1 } }],
        lease: { token: randomUUID(), expiresAt: this.now() + this.leaseMs } };
    });
    if (record.outcome) {
      this.records.delete(id);
      await this.store.delete(this.pendingKey(id));
      this.notifyCancellation(record);
      throw new Error('RESOURCE_BUSY');
    }
    this.records.set(id, record);
    return { ...record.lease!, attempt: record.attempt, leaseMs: this.leaseMs };
  }
  /** Reconcile expired opaque attempts before any redelivery or claim. */
  async reconcile(offline: ReadonlySet<string> = new Set()): Promise<void> {
    await this.ready;
    for (const entry of await this.store.list(PENDING_PREFIX)) {
      const id = entry.key.slice(PENDING_PREFIX.length);
      const candidate = await this.store.get<DurableDispatch>(this.key(id));
      if (!candidate || (candidate.lease && candidate.lease.expiresAt > this.now())) continue;
      if (!candidate.outcome && !(candidate.attempt > 0 && candidate.request.replayPolicy !== 'read-only') &&
          (!offline.has(candidate.computerId) || candidate.recovery === 'orphaned')) continue;
      const record = await this.store.update!<DurableDispatch>(this.key(id), current => {
        if (!current) throw new Error('UNKNOWN_DISPATCH');
        if (current.outcome || (current.lease && current.lease.expiresAt > this.now())) return current;
        if (current.attempt > 0 && current.request.replayPolicy !== 'read-only') {
          return this.terminal(current, 'UNKNOWN_OUTCOME');
        }
        return offline.has(current.computerId) ? { ...current, recovery: 'orphaned' } : current;
      }).catch(error => {
        if (error instanceof Error && error.message === 'UNKNOWN_DISPATCH') return undefined;
        throw error;
      });
      if (record?.outcome) {
        this.records.delete(id);
        await this.store.delete(this.pendingKey(id));
        this.notifyCancellation(record);
      }
    }
  }
  private terminal(record: DurableDispatch, error: string): DurableDispatch {
    return { ...record, lease: undefined, completedAt: this.now(),
      outcome: { ok: false, output: '', inputTokens: 0, outputTokens: 0, durationMs: 0, error },
      events: [...record.events.slice(-(MAX_EVENTS_PER_CHANNEL - 1)), {
        executionId: record.request.executionId, type: error === 'CANCELLED' ? 'cancelled' : 'failed',
        at: new Date(this.now()), data: { error, attempt: record.attempt },
      }] };
  }
  private notifyCancellation(record: DurableDispatch): void {
    this.streams.get(record.computerId)?.write(`event: cancel\ndata: ${JSON.stringify({ requestId: record.request.requestId })}\n\n`);
  }
  async cancel(id: string): Promise<void> {
    const record = await this.store.update!<DurableDispatch>(this.key(id), current => {
      if (!current) throw new Error('UNKNOWN_DISPATCH');
      return current.outcome ? current : this.terminal(current, 'CANCELLED');
    });
    this.records.delete(id);
    await this.store.delete(this.pendingKey(id));
    if (record.outcome?.error === 'CANCELLED') this.notifyCancellation(record);
  }
  /** Only the operator route can change computer ownership. Never steal a live lease. */
  async reassign(id: string, computerId: string): Promise<void> {
    await this.reconcile();
    const record = await this.store.update!<DurableDispatch>(this.key(id), current => {
      if (!current) throw new Error('UNKNOWN_DISPATCH');
      if (current.outcome) throw new Error('EXECUTION_TERMINAL');
      if (current.lease && current.lease.expiresAt > this.now()) throw new Error('RESOURCE_BUSY');
      if (current.attempt > 0 && current.request.replayPolicy !== 'read-only') throw new Error('UNKNOWN_OUTCOME');
      return { ...current, computerId, lease: undefined, recovery: undefined,
        events: [...current.events.slice(-(MAX_EVENTS_PER_CHANNEL - 1)), {
          executionId: current.request.executionId, type: 'retry', at: new Date(this.now()),
          data: { reason: 'operator_reassignment', from: current.computerId, to: computerId },
        }] };
    });
    this.records.set(id, record);
    await this.redeliver(computerId);
  }
  private validate(current: DurableDispatch | undefined, token: string): DurableDispatch {
    if (!current || !token || current.lease?.token !== token || current.lease.expiresAt <= this.now()) throw new Error('LEASE_LOST');
    return current;
  }
  async renew(id: string, token: string): Promise<void> {
    const record = await this.store.update!<DurableDispatch>(this.key(id), current => {
      const r = this.validate(current, token);
      if (r.outcome) throw new Error('EXECUTION_TERMINAL');
      return { ...r, events: [...r.events.slice(-(MAX_EVENTS_PER_CHANNEL - 1)), { executionId: r.request.executionId, type: 'lease_renewed' as const, at: new Date(this.now()), data: { attempt: r.attempt } }], lease: { token, expiresAt: this.now() + this.leaseMs } };
    });
    this.records.set(id, record);
  }
  async recordEvent(id: string, event: WorkerExecutionEvent, token: string): Promise<boolean> {
    const record = await this.store.update!<DurableDispatch>(this.key(id), current => {
      const r = this.validate(current, token);
      if (r.outcome) throw new Error('EXECUTION_TERMINAL');
      if (event.executionId !== r.request.executionId) throw new Error('EXECUTION_MISMATCH');
      return { ...r, events: [...r.events.slice(-(MAX_EVENTS_PER_CHANNEL - 1)), event] };
    });
    this.records.set(id, record); return true;
  }
  async resolve(id: string, outcome: ExecutionOutcome, token: string): Promise<boolean> {
    await this.commit(id, outcome, token);
    return true;
  }
  /**
   * Commits the terminal outcome at most once. Only the current lease holder may commit; a
   * repeat from that holder (a retried POST) is reported as `duplicate` and changes nothing,
   * so callers record history and metrics only for `committed`.
   */
  async commit(id: string, outcome: ExecutionOutcome, token: string): Promise<'committed' | 'duplicate'> {
    let committed = false;
    await this.store.update!<DurableDispatch>(this.key(id), current => {
      // A durably accepted result remains acknowledged after its lease deadline.
      // Cancel/recovery clear the token; previous attempts still cannot commit.
      if (current?.outcome && token && current.lease?.token === token) return current;
      const r = this.validate(current, token);
      committed = true;
      return { ...r, outcome, completedAt: this.now() };
    });
    this.records.delete(id);
    await this.store.delete(this.pendingKey(id));
    return committed ? 'committed' : 'duplicate';
  }
  async assignments(): Promise<Array<{ id: string; modelId: string; computerId: string; runtimeId?: string }>> {
    await this.refresh();
    return [...this.records.values()].filter(r => !r.outcome).map(r => ({ id: r.request.executionId,
      computerId: r.computerId, modelId: r.request.modelId, runtimeId: r.request.runtimeId }));
  }
  async status(id: string): Promise<{ events: WorkerExecutionEvent[]; outcome?: ExecutionOutcome; recovery?: 'orphaned'; computerId: string } | undefined> {
    const r = await this.store.get<DurableDispatch>(this.key(id));
    return r ? { events: r.events, outcome: r.outcome, recovery: r.recovery, computerId: r.computerId } : undefined;
  }
  async awaitOutcome(id: string, timeoutMs: number): Promise<ExecutionOutcome> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.status(id);
      if (!status) throw new Error('UNKNOWN_DISPATCH');
      if (status.outcome) return status.outcome;
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    throw new Error('timed out waiting for worker result');
  }
}

export interface ApiState {
  computers: ComputerRegistry;
  runtimes: RuntimeRegistry;
  models: ModelRegistry;
  lifecycle: ModelLifecycleService;
  agents: AgentRegistry;
  tools: ToolRegistry;
  discovered: DiscoveredRuntime[];
  executions: Array<Record<string, unknown>>;
  dispatcher: TaskDispatcher;
  store: KeyValueStore;
  auth: ApiAuth;
  editorProtocol: EditorProtocolService;
  mobile: MobileServices;
}

/** Starts the production recovery sweep; caller must stop it on shutdown. */
export function startDispatchRecovery(state: ApiState): () => void {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      for (const computer of state.computers.list()) {
        if (computer.local) state.computers.heartbeat(computer.id, { load: currentLoad() });
      }
      const { offline } = state.computers.checkHeartbeats();
      await state.dispatcher.reconcile(new Set(offline));
    } catch (error) { console.error('Dispatch recovery failed:', error instanceof Error ? error.message : String(error)); }
    finally { running = false; }
  };
  void sweep();
  const timer = setInterval(() => { void sweep(); }, 1000);
  timer.unref();
  return () => clearInterval(timer);
}

export interface ApiStateOptions {
  workerLeaseMs?: number;
  modelStartup?: Parameters<ModelLifecycleService['applyStartupPolicy']>[0];
  auth?: ApiAuthOptions;
  store?: KeyValueStore;
  /** Workspace protocol tool calls are confined to. Defaults to WAZIR_PROJECT_ROOT, then cwd. */
  projectRoot?: string;
  /** Human approval for policy `ask` decisions on protocol tool calls; absent, `ask` is denied. */
  approveTool?: (request: PolicyActionRequest, decision: PolicyDecision) => Promise<boolean | 'unavailable'>;
  auditPath?: string;
  /** Explicitly enable durable mobile approval queue even before a mobile device pairs. */
  enableMobileApprovals?: boolean;
  /** SQLite path for ResourceLedger (defaults to :memory:). */
  ledgerPath?: string;
}

export async function createApiState(options: ApiStateOptions = {}): Promise<ApiState> {
  const store = options.store ?? new MemoryStore();
  // Worker credentials live in the same store as registrations, so both survive (or are
  // lost) together.
  const auth = new ApiAuth({ ...(options.auth ?? {
    operatorToken: process.env.WAZIR_API_TOKEN,
    viewerToken: process.env.WAZIR_API_VIEWER_TOKEN,
    registrationToken: process.env.WAZIR_REGISTRATION_TOKEN,
  }), store: options.auth?.store ?? store });
  await auth.init();
  const computers = new ComputerRegistry();
  for (const entry of await store.list('computer/registration/')) {
    const registration = entry.value as Parameters<ComputerRegistry['register']>[0];
    computers.register({ ...registration, local: false });
    computers.setOffline(registration.id);
  }
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);

  const nvidiaEnabled = Boolean(process.env.NVIDIA_API_KEY || process.env.WAZIR_NVIDIA_BASE_URL);
  const nvidiaAdapter = createNvidiaAdapter({
    baseURL: process.env.WAZIR_NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
  });
  const adapters = [
    createOllamaAdapter(process.env.WAZIR_OLLAMA_URL ?? 'http://localhost:11434'),
    createLMStudioAdapter(process.env.WAZIR_LMSTUDIO_URL ?? 'http://localhost:1234/v1'),
    ...(nvidiaEnabled ? [nvidiaAdapter] : []),
  ];

  const discovered = await discoverRuntimes(adapters as any);
  const hardware = await discoverHardware();

  const localId = process.env.WAZIR_COMPUTER_ID ?? 'local';
  computers.register({
    id: localId,
    name: os.hostname() ?? 'local',
    type: 'workstation',
    local: true,
    os: hardware.os,
    hardware: hardware.hardware,
    capabilities: ['localExecution'],
  });
  computers.heartbeat(localId, { load: currentLoad() });
  // The in-process computer holds a token nobody else knows, so a network
  // peer cannot re-register `local` and take over its record (F-3).
  await auth.issueComputerToken(localId);

  for (const discoveredRuntime of discovered) {
    const isHosted = discoveredRuntime.id === 'nvidia';
    runtimes.register({
      id: discoveredRuntime.id,
      type: discoveredRuntime.id === 'ollama' ? 'ollama' : discoveredRuntime.id === 'lmstudio' ? 'lmstudio' : discoveredRuntime.id === 'nvidia' ? 'nvidia' : 'other',
      name: discoveredRuntime.info.name,
      version: discoveredRuntime.info.version,
      url: discoveredRuntime.info.url,
      computerId: localId,
      capabilities: discoveredRuntime.capabilities,
    });
    runtimes.update(discoveredRuntime.id, { health: discoveredRuntime.health });

    if (discoveredRuntime.health !== 'unavailable') {
      for (const discoveredModel of discoveredRuntime.models) {
         models.register({
           id: discoveredModel.id,
           name: discoveredModel.name ?? discoveredModel.id,
           provider: discoveredRuntime.id,
           family: discoveredModel.family as ModelRecord['family'] ?? 'other',
           contextMax: discoveredModel.contextWindow ?? 32768,
           capabilities: (discoveredModel.capabilities ?? ['generalChat']) as ModelCapability[],
           toolCalling: discoveredModel.toolCalling ?? false,
           structuredOutput: discoveredModel.structuredOutput ?? false,
           vision: discoveredModel.vision ?? false,
           audio: discoveredModel.audio ?? false,
           embedding: discoveredModel.embedding ?? false,
           reasoning: discoveredModel.reasoning ?? false,
           runtimeCompatibility: [discoveredRuntime.id as RuntimeType],
           local: !isHosted,
           createdAt: new Date(),
           updatedAt: new Date(),
         });
         // Without an instance, the Scheduler can never place this model on
         // this computer — `Scheduler.routeModel` rejects models with zero
         // registered instances regardless of the ModelRecord existing.
         models.upsertInstance({
           id: `${discoveredModel.id}::${localId}::${discoveredRuntime.id}`,
           modelId: discoveredModel.id,
           computerId: localId,
           runtimeId: discoveredRuntime.id,
           runtimeModelId: discoveredModel.id,
           loaded: isHosted,
           health: discoveredRuntime.health === 'healthy' ? 'healthy' : 'degraded',
           state: isHosted ? 'LOADED' : 'INSTALLED',
         });
      }
    }
  }

  agents.register(createCodingAgent(), 'native');

  const dispatcher = new TaskDispatcher(store, Date.now, options.workerLeaseMs);
  await dispatcher.ready;
  const lifecycle = new ModelLifecycleService({
    models, runtimes, computers,
    queuedAssignments: () => dispatcher.assignments(),
    adapters: new Map(discovered.map(runtime => [runtime.id, runtime.adapter])),
    store: options.store,
    refreshResources: async computerId => {
      if (computerId === localId) computers.heartbeat(localId, { load: currentLoad() });
    },
  });
  await lifecycle.discoverAndReconcile();
  await lifecycle.applyStartupPolicy(options.modelStartup);
  lifecycle.startReconciliation();

  const projectRoot = options.projectRoot ?? process.env.WAZIR_PROJECT_ROOT ?? process.cwd();
  let mobileRef: MobileServices | undefined;
  const approveCallback = async (
    request: PolicyActionRequest,
    decision: PolicyDecision,
  ): Promise<boolean | 'unavailable'> => {
    if (options.approveTool) {
      const explicit = await options.approveTool(request, decision);
      if (explicit === true || explicit === false) {
        return explicit;
      }
    }
    if (mobileRef) {
      const posture = mobileRef.multiSurface.getAutonomy().effectivePosture;
      if (posture === 'read-only') {
        return false;
      }
      if (posture === 'auto-sandbox') {
        return true;
      }
      if (mobileRef.shouldUseMobileApprovalQueue()) {
        return mobileRef.approvals.requestApproval(request, decision);
      }
    }
    return 'unavailable';
  };
  const controlled = createControlledExecution({
    tools,
    projectRoot,
    approve: approveCallback,
    auditPath: options.auditPath,
  });
  const editorProtocol = new EditorProtocolService({
    store,
    tools,
    executeTool: controlled.executeTool,
    verify: controlled.verify,
    toolSurface: controlled.toolSurface,
    projectRoot,
  });

  const storedExecEntries = await store.list('execution/');
  const sortedStoredExecs = storedExecEntries
    .map((entry) => {
      const record = entry.value as Record<string, unknown>;
      return { key: entry.key, seq: 0, record: Array.isArray(record?.events) ? record : { events: [], ...record } };
    })
    .sort((a, b) => a.seq - b.seq);
  if (sortedStoredExecs.length > MAX_EXECUTION_RECORDS) {
    const excess = sortedStoredExecs.splice(0, sortedStoredExecs.length - MAX_EXECUTION_RECORDS);
    for (const item of excess) {
      await store.delete(item.key);
    }
  }
  const initialExecutions = sortedStoredExecs.map((item) => item.record);

  const state: ApiState = {
    computers,
    runtimes,
    models,
    lifecycle,
    agents,
    tools,
    discovered,
    executions: initialExecutions,
    dispatcher,
    store,
    auth,
    editorProtocol,
    mobile: undefined as unknown as MobileServices,
  };

  const mobile = new MobileServices(state, {
    projectRoot,
    executeTool: controlled.executeTool,
    verify: controlled.verify,
    policy: controlled.policy,
    ledgerPath: options.ledgerPath,
  });
  if (options.enableMobileApprovals) {
    mobile.approvals.enableDurableQueue = true;
  }
  await mobile.init();
  state.mobile = mobile;
  mobileRef = mobile;

  return state;
}

const SUMMARY_RESULT_MAX_CHARS = 512;
const DEFAULT_EXECUTION_PAGE_SIZE = 100;
const MAX_EXECUTION_PAGE_SIZE = 500;

function extractExecutionId(record: Record<string, unknown> | undefined): string | undefined {
  const id = (record?.execution as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

async function recordExecution(state: ApiState, record: Record<string, unknown>): Promise<void> {
  const id = extractExecutionId(record);
  if (!id) throw new Error('EXECUTION_ID_REQUIRED');
  if (!state.store.update) throw new Error('EXECUTION_PERSISTENCE_UNAVAILABLE');
  await state.store.update<Record<string, unknown>>(`execution/${id}`, current => current ?? { events: [], ...record, storageRevision: 1 });
  state.executions.push(record);
  if (state.executions.length > MAX_EXECUTION_RECORDS) state.executions.splice(0, state.executions.length - MAX_EXECUTION_RECORDS);
}

function normalizeExecutionRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const exRaw = (raw.execution as Record<string, unknown> | undefined) ?? {};
  const agentId = raw.agentId ?? exRaw.agentId;
  const modelId = raw.modelId ?? exRaw.modelId;
  const runtimeId = raw.runtimeId ?? exRaw.runtimeId;
  const computerId = raw.computerId ?? exRaw.computerId;
  const completedAt = exRaw.completedAt ?? exRaw.finishedAt;
  const finishedAt = exRaw.finishedAt ?? exRaw.completedAt;
  const execution: Record<string, unknown> = {
    ...exRaw,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    ...(computerId !== undefined ? { computerId } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  };
  const evidence = raw.evidence ?? (Array.isArray(raw.checks) ? raw.checks : undefined);
  const errors =
    raw.errors ??
    (typeof raw.error === 'string' && raw.error ? [{ message: raw.error }] : undefined);
  const filesChanged =
    raw.filesChanged ??
    (Array.isArray(raw.fileMutations)
      ? (raw.fileMutations as Array<{ path?: unknown }>)
          .map((m) => (typeof m?.path === 'string' ? m.path : ''))
          .filter(Boolean)
      : undefined);
  return {
    ...raw,
    execution,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    ...(computerId !== undefined ? { computerId } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(errors !== undefined ? { errors } : {}),
    ...(filesChanged !== undefined ? { filesChanged } : {}),
  };
}

/**
 * Reads the shared durable execution repository. The in-process engine is only
 * a derived index; the store is authoritative across API/CLI restarts.
 */
async function collectAllExecutions(state: ApiState): Promise<Array<Record<string, unknown>>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of await state.store.list('execution/')) {
    const rec = entry.value as Record<string, unknown> | undefined;
    const id = extractExecutionId(rec);
    if (id && rec) byId.set(id, normalizeExecutionRecord(rec));
  }
  return [...byId.values()].sort((a, b) => {
    const ad = Date.parse(String((a.execution as any)?.createdAt ?? '')) || 0;
    const bd = Date.parse(String((b.execution as any)?.createdAt ?? '')) || 0;
    return bd - ad || String((b.execution as any)?.id).localeCompare(String((a.execution as any)?.id));
  });
}

async function lookupExecution(state: ApiState, id: string): Promise<Record<string, unknown> | undefined> {
  const record = await state.store.get<Record<string, unknown>>(`execution/${id}`);
  return record && extractExecutionId(record) === id ? normalizeExecutionRecord(record) : undefined;
}

function summarizeExecutionRecord(record: Record<string, unknown>): Record<string, unknown> {
  const { events: _events, toolCalls, fileMutations: _fm, checks: _checks, context: _ctx, ...rest } = record;
  const summary: Record<string, unknown> = { ...rest };
  if (Array.isArray(toolCalls)) {
    summary.toolCallCount = toolCalls.length;
  }
  if (typeof summary.result === 'string' && summary.result.length > SUMMARY_RESULT_MAX_CHARS) {
    summary.result = `${summary.result.slice(0, SUMMARY_RESULT_MAX_CHARS)}…`;
    summary.resultTruncated = true;
  }
  return summary;
}

function lifecycleError(res: Response, error: unknown): void {
  if (error instanceof ModelLifecycleError) {
    res.status(error.code === 'MODEL_NOT_INSTALLED' ? 404 : 409)
      .json({ code: error.code, reasons: error.reasons, plan: error.plan });
    return;
  }
  res.status(500).json({ code: 'MODEL_LIFECYCLE_FAILED' });
}

/** Coerces a worker-reported outcome into the shape the CLI feeds back into the agent loop. */
function parseOutcome(body: unknown): ExecutionOutcome | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = body as Record<string, unknown>;
  if (typeof raw.ok !== 'boolean') return undefined;
  const output = typeof raw.output === 'string' ? raw.output : '';
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    ok: raw.ok,
    output: sanitizeUntrustedOutput(output.slice(0, MAX_OUTPUT_CHARS)),
    inputTokens: num(raw.inputTokens),
    outputTokens: num(raw.outputTokens),
    durationMs: num(raw.durationMs),
    error: typeof raw.error === 'string' ? sanitizeUntrustedOutput(raw.error.slice(0, 10_000)) : undefined,
  };
}

export function createApp(state: ApiState) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const localId = process.env.WAZIR_COMPUTER_ID ?? 'local';
  const { auth } = state;

  const metrics = {
    tasksDispatched: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
  };

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      name: 'wazir-api',
      version: wazirVersion(),
      auth: {
        operatorToken: auth.operatorTokenRequired,
        viewerToken: auth.viewerTokenRequired,
        registrationToken: auth.registrationToken !== undefined,
      },
    });
  });

  // Liveness (/health) only proves the process answers. Readiness proves the
  // control plane can actually serve: the store round-trips, the durable
  // dispatcher finished loading, and the mobile/control services initialized.
  // Load balancers, the Desktop shell, and startup scripts should gate on this.
  app.get('/ready', async (_req, res) => {
    const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([
      p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
    const checks: Record<string, { ok: boolean; error?: string }> = {};
    const run = async (name: string, fn: () => Promise<unknown>) => {
      try { await withTimeout(fn(), 2000); checks[name] = { ok: true }; }
      catch (error) { checks[name] = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    };
    await Promise.all([
      run('store', async () => {
        const probe = `readiness/probe`;
        const value = Date.now();
        await state.store.put(probe, value);
        if ((await state.store.get<number>(probe)) !== value) throw new Error('store read-back mismatch');
      }),
      run('dispatcher', () => state.dispatcher.ready),
      run('controlServices', async () => {
        if (!state.mobile) throw new Error('not initialized');
        await state.mobile.executionEngine.ready;
      }),
    ]);
    const ready = Object.values(checks).every((c) => c.ok);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', version: wazirVersion(), checks });
  });

  // Metrics reveal topology and auth-failure counts: viewer scope, like the
  // rest of the read-only surface (Prometheus: `authorization: credentials`).
  app.get('/metrics', auth.requireViewerOrOperator, (_req, res) => {
    const onlineComputers = state.computers.listOnline().length;
    const totalComputers = state.computers.list().length;
    const queueDepth = state.dispatcher.totalQueued;
    const activeStreams = state.dispatcher.activeStreamsCount;

    const lines = [
      '# HELP wazir_auth_failures_total Total number of authentication failures (401/403).',
      '# TYPE wazir_auth_failures_total counter',
      `wazir_auth_failures_total ${auth.authFailures}`,
      '',
      '# HELP wazir_dispatched_tasks_total Total number of tasks dispatched.',
      '# TYPE wazir_dispatched_tasks_total counter',
      `wazir_dispatched_tasks_total ${metrics.tasksDispatched}`,
      '',
      '# HELP wazir_completed_tasks_total Total number of completed tasks.',
      '# TYPE wazir_completed_tasks_total counter',
      `wazir_completed_tasks_total ${metrics.tasksCompleted}`,
      '',
      '# HELP wazir_failed_tasks_total Total number of failed tasks.',
      '# TYPE wazir_failed_tasks_total counter',
      `wazir_failed_tasks_total ${metrics.tasksFailed}`,
      '',
      '# HELP wazir_dispatch_queue_depth Current number of tasks waiting in computer queues.',
      '# TYPE wazir_dispatch_queue_depth gauge',
      `wazir_dispatch_queue_depth ${queueDepth}`,
      '',
      '# HELP wazir_registered_computers Total number of registered computers.',
      '# TYPE wazir_registered_computers gauge',
      `wazir_registered_computers ${totalComputers}`,
      '',
      '# HELP wazir_online_computers Number of online computers.',
      '# TYPE wazir_online_computers gauge',
      `wazir_online_computers ${onlineComputers}`,
      '',
      '# HELP wazir_active_sse_streams Number of active SSE task streams from workers.',
      '# TYPE wazir_active_sse_streams gauge',
      `wazir_active_sse_streams ${activeStreams}`,
      '',
    ];

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n'));
  });

  // Mobile companion routes (public pairing endpoints + authenticated mobile endpoints)
  registerMobileRoutes(app, state, state.mobile);

  // Read-only control routes allow viewer or operator tokens. Mutating endpoints
  // explicitly enforce operator scope. A paired mobile device is deliberately NOT
  // granted blanket access to this whole surface (computers, workers, runtimes, models,
  // agents, tools, executions, task dispatch) — only the specific `/api/v1/mobile/*`
  // routes it needs, gated individually by `requireOperatorOrDevice`/
  // `requireViewerOperatorOrDevice` in mobile.ts.
  app.use('/api/v1', auth.requireViewerOrOperator);
  app.use('/executions', auth.requireOperator);

  app.get('/api/v1/overview', async (_req, res) => {
    const allExecutions = await collectAllExecutions(state);
    res.json({
      name: 'wazir',
      version: wazirVersion(),
      description:
        'Wazir is a model- and runtime-agnostic meta-harness that schedules AI agents, models, tools, and compute to execute tasks across local and distributed environments.',
      computerId: localId,
      hostname: os.hostname(),
      counts: {
        computers: state.computers.list().length,
        workers: state.computers.list().length,
        runtimes: state.runtimes.list().length,
        models: state.models.list().length,
        agents: state.agents.list().length,
        tools: state.tools.list().length,
        executions: allExecutions.length,
      },
    });
  });

  app.get('/api/v1/computers', (_req, res) => {
    res.json({ computers: state.computers.list() });
  });

  app.get('/api/v1/workers', (_req, res) => {
    // Every registered computer is a worker: the in-process local host plus
    // each remote that registered over the worker protocol. Listing only the
    // local host made the distributed fleet invisible to the dashboard.
    const computers = [...state.computers.list()].sort((a, b) =>
      a.id === localId ? -1 : b.id === localId ? 1 : a.id.localeCompare(b.id));
    res.json({
      workers: computers.map((c) => ({
        id: `worker-${c.id}`,
        computerId: c.id,
        name: c.name,
        status: c.status,
        local: c.id === localId,
        connected: c.id === localId || state.dispatcher.isConnected(c.id),
        runtimes: c.runtimes,
        models: c.models,
        lastHeartbeat: c.lastHeartbeat,
      })),
    });
  });

  app.get('/api/v1/runtimes', (_req, res) => {
    const runtimes = state.runtimes.list().map((r) => {
      const discovered = state.discovered.find((d) => d.id === r.id);
      return {
        ...r,
        health: discovered?.health ?? 'unavailable',
        healthMessage: discovered?.healthMessage,
        models: discovered?.models ?? [],
      };
    });
    res.json({ runtimes });
  });

  app.get('/api/v1/providers', (_req, res) => {
    const providers = state.runtimes.list().map((r) => {
      const discovered = state.discovered.find((d) => d.id === r.id);
      const isHosted = r.type === 'nvidia' || r.type === 'openai' || r.type === 'anthropic' || r.type === 'google';
      return {
        id: r.id,
        displayName: r.name,
        providerType: isHosted ? 'HOSTED_INFERENCE' : 'LOCAL_INFERENCE',
        runtimeKind: isHosted ? 'hosted' : 'local',
        endpoint: r.url,
        health: discovered?.health ?? r.health ?? 'unavailable',
        healthMessage: discovered?.healthMessage,
        modelCount: (discovered?.models ?? []).length,
        models: (discovered?.models ?? []).map((m) => m.id),
      };
    });
    if (!providers.some((p) => p.id === 'nvidia')) {
      providers.push({
        id: 'nvidia',
        displayName: 'NVIDIA API Catalog',
        providerType: 'HOSTED_INFERENCE',
        runtimeKind: 'hosted',
        endpoint: process.env.WAZIR_NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
        health: process.env.NVIDIA_API_KEY ? 'healthy' : 'unavailable',
        healthMessage: process.env.NVIDIA_API_KEY ? 'NVIDIA_API_KEY configured' : 'Missing NVIDIA_API_KEY',
        modelCount: 0,
        models: [],
      });
    }
    res.json({ providers });
  });

  app.get('/api/v1/providers/:id', (req, res) => {
    const id = String(req.params.id);
    const runtime = state.runtimes.list().find((r) => r.id === id);
    if (!runtime && id !== 'nvidia') {
      res.status(404).json({ error: `provider '${id}' not found` });
      return;
    }
    const discovered = state.discovered.find((d) => d.id === id);
    const isHosted = id === 'nvidia' || runtime?.type === 'openai' || runtime?.type === 'anthropic' || runtime?.type === 'google';
    res.json({
      id,
      displayName: runtime?.name ?? (id === 'nvidia' ? 'NVIDIA API Catalog' : id),
      providerType: isHosted ? 'HOSTED_INFERENCE' : 'LOCAL_INFERENCE',
      runtimeKind: isHosted ? 'hosted' : 'local',
      endpoint: runtime?.url ?? (id === 'nvidia' ? (process.env.WAZIR_NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1') : undefined),
      health: discovered?.health ?? runtime?.health ?? 'unavailable',
      healthMessage: discovered?.healthMessage ?? (id === 'nvidia' && !process.env.NVIDIA_API_KEY ? 'Missing NVIDIA_API_KEY' : undefined),
      models: discovered?.models ?? [],
    });
  });

  app.get('/api/v1/models', (_req, res) => {
    res.json({ models: state.models.list(), installations: state.models.listInstallations(),
      instances: state.lifecycle.list(), readiness: state.lifecycle.getReadiness(),
      resources: state.computers.list().map(computer => state.computers.resourceSnapshot(computer.id)) });
  });

  // Which computer/runtime combinations can actually serve which model — a
  // remote scheduler needs this (not just the model catalog) to place a task.
  app.get('/api/v1/model-instances', (_req, res) => {
    res.json({ instances: state.lifecycle.list() });
  });

  app.get('/api/v1/models/:id/inspect', (req, res) => {
    res.json(state.lifecycle.inspect(String(req.params.id)));
  });
  app.post('/api/v1/models/reconcile', auth.requireOperator, async (_req, res) => {
    res.json(await state.lifecycle.reconcile());
  });
  app.post('/api/v1/models/:id/estimate', auth.requireOperator, async (req, res) => {
    try { res.json(await state.lifecycle.estimate(String(req.params.id), req.body ?? {})); }
    catch (error) { lifecycleError(res, error); }
  });
  app.post('/api/v1/models/:id/load', auth.requireOperator, async (req, res) => {
    try {
      const modelId = String(req.params.id);
      const loaded = await state.lifecycle.load(modelId, req.body ?? {});
      void state.mobile.eventHub.publish({
        type: 'model.loaded',
        modelId,
        computerId: req.body?.computerId ?? localId,
        status: 'LOADED',
        summary: `Model loaded: ${modelId}`,
        payload: { modelId, instance: loaded },
      });
      res.json(loaded);
    } catch (error) { lifecycleError(res, error); }
  });
  app.post('/api/v1/models/:id/unload', auth.requireOperator, async (req, res) => {
    try {
      const modelId = String(req.params.id);
      await state.lifecycle.unload(modelId, req.body ?? {});
      void state.mobile.eventHub.publish({
        type: 'model.unloaded',
        modelId,
        computerId: req.body?.computerId ?? localId,
        status: 'UNLOADED',
        summary: `Model unloaded: ${modelId}`,
        payload: { modelId },
      });
      res.json({ state: 'UNLOADED' });
    } catch (error) { lifecycleError(res, error); }
  });
  for (const operation of ['pin', 'unpin'] as const) {
    app.post(`/api/v1/models/:id/${operation}`, auth.requireOperator, async (req, res) => {
      try { await state.lifecycle[operation](String(req.params.id), req.body ?? {}); res.json({ ok: true }); }
      catch (error) { lifecycleError(res, error); }
    });
  }

  app.get('/api/v1/agents/capabilities', (_req, res) => {
    res.json({ capabilities: state.agents.catalog() });
  });

  app.get('/api/v1/agents', (_req, res) => {
    res.json({ agents: state.agents.list().map((a) => ({ ...a.descriptor, source: a.source })) });
  });

  app.get('/api/v1/tools', (_req, res) => {
    res.json({ tools: state.tools.descriptors() });
  });

  app.get('/api/v1/executions', async (req, res) => {
    let all: Array<Record<string, unknown>>;
    try { all = await collectAllExecutions(state); }
    catch (error) {
      res.status(503).json({ code: 'EXECUTION_HISTORY_UNAVAILABLE', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : '';
    const computerFilter = typeof req.query.computerId === 'string' ? req.query.computerId.trim() : '';
    const agentFilter = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
    const modelFilter = typeof req.query.modelId === 'string' ? req.query.modelId.trim() : '';
    const runtimeFilter = typeof req.query.runtimeId === 'string' ? req.query.runtimeId.trim() : '';
    const parentFilter = typeof req.query.parentExecutionId === 'string' ? req.query.parentExecutionId.trim() : '';
    const textQuery = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const summaryMode = req.query.summary === '1' || req.query.summary === 'true' || req.query.fields === 'summary';

    const filtered = all.filter((e) => {
      const ex = (e.execution as Record<string, unknown> | undefined) ?? {};
      const task = (e.task as Record<string, unknown> | undefined) ?? {};
      if (statusFilter && statusFilter !== 'all') {
        const st = String(ex.status ?? '').toLowerCase();
        const allowed = statusFilter.split(',').map((s) => s.trim()).filter(Boolean);
        const matchStatus = allowed.some((target) => {
          if (target === 'completed') return st === 'completed' || st === 'ok';
          if (target === 'failed') return st === 'failed' || st === 'error';
          if (target === 'running') return ['running', 'active', 'queued', 'assigned', 'waiting'].includes(st);
          return st === target;
        });
        if (!matchStatus) return false;
      }
      if (computerFilter && String(e.computerId ?? '') !== computerFilter) return false;
      if (agentFilter && String(e.agentId ?? '') !== agentFilter) return false;
      if (modelFilter && String(e.modelId ?? '') !== modelFilter) return false;
      if (runtimeFilter && String(e.runtimeId ?? '') !== runtimeFilter) return false;
      if (parentFilter && String(ex.parentExecutionId ?? '') !== parentFilter) return false;
      if (textQuery) {
        const haystack = [
          ex.id,
          task.type,
          task.input,
          e.agentId,
          e.modelId,
          e.runtimeId,
          e.result,
        ]
          .map((v) => String(v ?? '').toLowerCase())
          .join(' ');
        if (!haystack.includes(textQuery)) return false;
      }
      return true;
    });

    const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : DEFAULT_EXECUTION_PAGE_SIZE;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MAX_EXECUTION_PAGE_SIZE, Math.floor(rawLimit)) : DEFAULT_EXECUTION_PAGE_SIZE;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const rawOffset = Number(req.query.offset ?? 0);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const start = cursor
      ? Math.max(0, filtered.findIndex((e) => String((e.execution as any)?.id) === cursor) + 1)
      : offset;
    const sliced = filtered.slice(start, start + limit);
    const executions = summaryMode ? sliced.map(summarizeExecutionRecord) : sliced;
    res.json({
      executions,
      total: filtered.length,
      offset: start,
      limit,
      hasMore: start + executions.length < filtered.length,
      nextCursor: start + executions.length < filtered.length ? String((sliced[sliced.length - 1].execution as any).id) : undefined,
    });
  });

  app.get('/api/v1/executions/:id', async (req, res) => {
    // Exact match only: a substring match let `GET /executions/a` return an
    // arbitrary record (F-18).
    const id = String(req.params.id);
    const execution = await lookupExecution(state, id);
    if (!execution) {
      res.status(404).json({ error: `execution '${id}' not found` });
      return;
    }
    res.json({ execution });
  });

  app.get('/api/v1/executions/:id/events', async (req, res) => {
    const id = String(req.params.id);
    const record = await lookupExecution(state, id);
    const dispatchStatus = await state.dispatcher.status(id);
    if (!record && !dispatchStatus) {
      res.status(404).json({ error: `execution '${id}' not found` });
      return;
    }
    const storedEvents = Array.isArray(record?.events) ? (record.events as unknown[]) : undefined;
    const events = storedEvents && storedEvents.length > 0
      ? storedEvents
      : dispatchStatus?.events ?? storedEvents ?? [];
    res.json({ executionId: id, events });
  });

  app.get('/api/v1/executions/:id/children', async (req, res) => {
    const id = String(req.params.id);
    const parent = await lookupExecution(state, id);
    if (!parent) {
      res.status(404).json({ error: `execution '${id}' not found` });
      return;
    }
    const all = await collectAllExecutions(state);
    const children = all.filter((r) => {
      const ex = r.execution as { parentExecutionId?: unknown } | undefined;
      return ex?.parentExecutionId === id;
    });
    res.json({ executionId: id, children });
  });

  // Worker protocol (registration + heartbeat).
  //
  // Registration returns the per-computer bearer token every later
  // `/computers/:id/*` call must carry. A new id needs the cluster
  // registration token when one is configured; replacing an existing
  // registration needs either that computer's current token or the
  // registration token (a worker restarting without persisted state). An
  // unauthenticated peer can therefore never overwrite a live worker's
  // record or take over its task stream (F-1, F-3).
  app.post('/computers/register', async (req, res) => {
    const registration = req.body as Parameters<ComputerRegistry['register']>[0] & { token?: unknown };
    if (!registration?.id || typeof registration.id !== 'string') {
      res.status(400).json({ error: 'registration.id is required' });
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(registration.id)) {
      res.status(400).json({ error: 'registration.id must be 1-128 characters of [A-Za-z0-9._-]' });
      return;
    }
    const presented = bearerToken(req);
    const exists = state.computers.get(registration.id) !== undefined || auth.hasComputerToken(registration.id);
    const byComputerToken = exists && auth.isComputerToken(registration.id, presented);
    const byRegistrationToken = auth.isRegistrationToken(presented);
    if (exists && !byComputerToken && !byRegistrationToken) {
      auth.recordAuthFailure();
      res.status(403).json({ error: `computer '${registration.id}' is already registered; present its token or the registration token to replace it` });
      return;
    }
    if (!exists && !byRegistrationToken && (auth.registrationToken !== undefined || !auth.isAllowedUnauthenticated)) {
      auth.recordAuthFailure();
      res.status(401).json({ error: 'registration token required (Authorization: Bearer <WAZIR_REGISTRATION_TOKEN>)' });
      return;
    }

    const preferred = typeof registration.token === 'string' ? registration.token : undefined;
    delete (registration as { token?: unknown }).token;
    // Anything registering over HTTP is by definition not this process;
    // `local` is derived from the transport, never trusted from the payload
    // (F-15) — otherwise a `localOnly` task could be routed off-machine.
    try {
      await state.store.put(`computer/registration/${registration.id}`, { ...registration, local: false });
    } catch (error) {
      res.status(503).json({ error: `registration could not be persisted: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const computer = state.computers.register({ ...registration, local: false });
    let token: string;
    if (byComputerToken && !preferred) {
      token = presented as string; // re-registration with the current token keeps it
    } else {
      // Fresh registration or replacement: rotate the token so any stream a
      // previous holder still has open stops receiving work.
      // The token is durably stored before it is returned: a 200 here means the worker
      // can authenticate after an API restart. On a storage failure nothing changes.
      try {
        token = await auth.issueComputerToken(registration.id, preferred);
      } catch (error) {
        res.status(503).json({ error: `credential could not be persisted: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      state.dispatcher.disconnect(registration.id);
    }
    void state.mobile.eventHub.publish({
      type: 'worker.connected',
      computerId: computer.id,
      status: 'online',
      summary: `Worker connected: ${computer.name} (${computer.id})`,
      payload: { computerId: computer.id, name: computer.name },
    });
    res.json({ ok: true, id: computer.id, token });
  });

  app.post('/computers/:id/heartbeat', auth.requireComputer, (req, res) => {
    const computerId = String(req.params.id);
    const computer = state.computers.get(computerId);
    if (!computer) {
      res.status(404).json({ error: `computer '${computerId}' unknown — register first` });
      return;
    }
    state.computers.heartbeat(computerId, {
      load: req.body?.load,
      runtimeHealth: req.body?.runtimeHealth,
      modelHealth: req.body?.modelHealth,
    });
    res.json({ ok: true });
  });

  // Worker task-pull loop: a worker holds this SSE connection open and receives
  // dispatched WorkerExecutionRequests as `event: task` frames. This is the
  // channel that lets the control plane push work to a remote worker.
  app.get('/computers/:id/tasks/stream', auth.requireComputer, async (req, res) => {
    const computerId = String(req.params.id);
    if (!state.computers.get(computerId)) {
      res.status(404).json({ error: `computer '${computerId}' unknown — register first` });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    // Cleanup is registered before the first await: a worker that disconnects while
    // subscribe() is still redelivering would otherwise never fire this listener,
    // leaking the stream registration and the keep-alive timer.
    let keepAlive: NodeJS.Timeout | undefined;
    req.on('close', () => {
      clearInterval(keepAlive);
      state.dispatcher.unsubscribe(computerId, res);
      void state.mobile.eventHub.publish({
        type: 'worker.disconnected',
        computerId,
        status: 'offline',
        summary: `Worker stream disconnected: ${computerId}`,
        payload: { computerId },
      });
    });
    try {
      await state.dispatcher.subscribe(computerId, res);
    } catch {
      // Headers are already sent; end the stream so the worker reconnects.
      state.dispatcher.unsubscribe(computerId, res);
      res.end();
      return;
    }
    if (req.destroyed) {
      state.dispatcher.unsubscribe(computerId, res);
      return;
    }
    keepAlive = setInterval(() => { res.write(': ping\n\n'); void state.dispatcher.redeliver(computerId).catch(() => undefined); }, 5_000);
  });

  // Dispatch an authorized execution request to a specific computer's worker.
  // Pass ?wait=<ms> to block until the worker reports a result (or time out).
  app.post('/api/v1/tasks/dispatch', auth.requireOperator, async (req, res) => {
    const { computerId, request } = req.body as { computerId?: string; request?: WorkerExecutionRequest };
    if (!computerId || !state.computers.get(computerId)) {
      res.status(404).json({ error: `computer '${computerId ?? ''}' unknown — register first` });
      return;
    }
    if (!request?.requestId || !request.executionId || !request.modelId || !Array.isArray(request.messages)) {
      res.status(400).json({ error: 'request.requestId, executionId, modelId and messages are required' });
      return;
    }

    if (request.replayPolicy !== undefined && !['never', 'read-only'].includes(request.replayPolicy)) {
      res.status(400).json({ error: 'INVALID_REPLAY_POLICY' }); return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(request.requestId)) {
      res.status(400).json({ error: 'request.requestId must be 1-256 characters of [A-Za-z0-9._-]' });
      return;
    }
    if (state.models.instancesOf(request.modelId).some(i => i.computerId === computerId &&
        (!request.runtimeId || i.runtimeId === request.runtimeId) && ['DRAINING', 'UNLOADING'].includes(i.state ?? ''))) {
      res.status(409).json({ error: 'MODEL_DRAINING' }); return;
    }
    const dispatched = await state.dispatcher.dispatch(computerId, request);
    if (dispatched.ok === false) {
      res.status(429).json({ error: dispatched.reason, requestId: request.requestId });
      return;
    }
    metrics.tasksDispatched++;

    const waitMs = Math.min(Math.max(Number(req.query.wait ?? 0) || 0, 0), 10 * 60_000);
    if (!waitMs) {
      res.status(202).json({ accepted: true, requestId: request.requestId, connected: state.dispatcher.isConnected(computerId) });
      return;
    }
    try {
      const outcome = await state.dispatcher.awaitOutcome(request.requestId, waitMs);
      res.json({ requestId: request.requestId, outcome });
    } catch (error) {
      res.status(504).json({ error: error instanceof Error ? error.message : String(error), requestId: request.requestId });
    }
  });

  app.post('/api/v1/tasks/:requestId/cancel', auth.requireOperator, async (req, res) => {
    try {
      await state.dispatcher.cancel(String(req.params.requestId));
      res.json(await state.dispatcher.status(String(req.params.requestId)));
    } catch (error) { res.status((error as Error).message === 'UNKNOWN_DISPATCH' ? 404 : 500).json({ error: (error as Error).message }); }
  });
  app.post('/api/v1/tasks/:requestId/reassign', auth.requireOperator, async (req, res) => {
    const computerId = req.body?.computerId;
    if (typeof computerId !== 'string' || state.computers.get(computerId)?.status !== 'online') {
      res.status(409).json({ error: 'TARGET_NOT_ONLINE' }); return;
    }
    try {
      await state.dispatcher.reassign(String(req.params.requestId), computerId);
      res.json(await state.dispatcher.status(String(req.params.requestId)));
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });

  app.get('/api/v1/tasks/:requestId/status', async (req, res) => {
    const status = await state.dispatcher.status(req.params.requestId);
    if (!status) {
      res.status(404).json({ error: `request '${req.params.requestId}' unknown` });
      return;
    }
    res.json(status);
  });

  // Only the computer a request was dispatched to may report on it. The
  // result is fed straight back into the operator's agent loop as the model
  // reply, so a forged outcome from any other peer is code execution (F-2).
  const requireChannelOwner = async (req: express.Request, res: Response): Promise<boolean> => {
    const requestId = String(req.params.requestId);
    const computerId = String(req.params.id);
    const owner = await state.dispatcher.owner(requestId);
    if (owner === undefined) {
      res.status(404).json({ error: `request '${requestId}' unknown` });
      return false;
    }
    if (owner !== computerId) {
      auth.recordAuthFailure();
      res.status(403).json({ error: `request '${requestId}' was not dispatched to computer '${computerId}'` });
      return false;
    }
    return true;
  };

  for (const operation of ['claim', 'renew'] as const) {
    app.post(`/computers/:id/executions/:requestId/${operation}`, auth.requireComputer, async (req, res) => {
      if (!await requireChannelOwner(req, res)) return;
      try {
        if (operation === 'claim') res.json(await state.dispatcher.claim(String(req.params.requestId), String(req.params.id)));
        else { await state.dispatcher.renew(String(req.params.requestId), String(req.body?.leaseToken ?? '')); res.json({ ok: true }); }
      } catch (error) { res.status(409).json({ error: (error as Error).message }); }
    });
  }

  // Worker → control plane: stream a lifecycle event for a dispatched request.
  app.post('/computers/:id/executions/:requestId/events', auth.requireComputer, async (req, res) => {
    if (!await requireChannelOwner(req, res)) return;
    const event: WorkerExecutionEvent = {
      executionId: String(req.body?.executionId ?? ''),
      type: (req.body?.type as WorkerEventType) ?? 'started',
      data: req.body?.data,
      at: new Date(),
    };
    try { await state.dispatcher.recordEvent(String(req.params.requestId), event, String(req.body?.leaseToken ?? '')); }
    catch (error) { res.status(409).json({ error: (error as Error).message }); return; }
    res.json({ ok: true });
  });

  // Worker → control plane: final outcome of a dispatched request.
  app.post('/computers/:id/executions/:requestId/result', auth.requireComputer, async (req, res) => {
    if (!await requireChannelOwner(req, res)) return;
    const outcome = parseOutcome(req.body);
    if (!outcome) {
      res.status(400).json({ error: 'outcome must include boolean `ok` and string `output`' });
      return;
    }
    const requestId = String(req.params.requestId);
    let committed: 'committed' | 'duplicate';
    try { committed = await state.dispatcher.commit(requestId, outcome, String(req.body?.leaseToken ?? '')); }
    catch (error) { res.status(409).json({ error: (error as Error).message }); return; }
    if (committed === 'duplicate') {
      // A retried result POST: the first outcome stands and is not recorded twice.
      res.json({ ok: true, duplicate: true });
      return;
    }
    await recordExecution(state, {
      execution: { id: requestId, status: outcome.ok ? 'completed' : 'failed', createdAt: new Date() },
      computerId: String(req.params.id),
      result: outcome.output,
      error: outcome.error,
      usage: { input: outcome.inputTokens, output: outcome.outputTokens },
    });
    if (outcome.ok) {
      metrics.tasksCompleted++;
    } else {
      metrics.tasksFailed++;
    }
    res.json({ ok: true });
  });

  app.post('/executions', async (req, res) => {
    const id = generateId('execution-');
    const record = {
      execution: { id, taskId: String(req.body?.taskId ?? id), status: 'recorded', createdAt: new Date() },
      task: req.body?.task ?? { input: String(req.body?.input ?? '') },
      agentId: req.body?.agentId,
      modelId: req.body?.modelId,
      computerId: req.body?.computerId,
      runtimeId: req.body?.runtimeId,
      result: typeof req.body?.result === 'string' ? sanitizeUntrustedOutput(req.body.result.slice(0, MAX_OUTPUT_CHARS)) : req.body?.result,
      usage: req.body?.usage,
    };
    await recordExecution(state, record);
    res.status(201).json({ id, record });
  });

  // Agent Protocol (ACP) Standard Endpoints.
  // Authorization matrix: GETs need viewer or operator; every POST (task,
  // step, artifact) needs operator. The service re-checks the principal's
  // scope, so a route added without the middleware still fails closed.
  app.use('/ap/v1', auth.requireProtocolPrincipal);
  const protocolContext = (req: express.Request, res: Response): ProtocolRequestContext => {
    const controller = new AbortController();
    // A client that disconnects mid-execution cancels the dispatched tool.
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    return { principal: res.locals.principal as ProtocolPrincipal | undefined, signal: controller.signal };
  };
  const protocolError = (res: Response, err: unknown): void => {
    const code = err instanceof ProtocolError ? err.code : undefined;
    const status = code === 'TASK_NOT_FOUND' ? 404 : code === 'TASK_TERMINAL' ? 409 : code === 'FORBIDDEN' ? 403 : code === 'STEP_INVALID' ? 400 : 500;
    res.status(status).json({ error: status === 500 ? 'internal error' : (err as Error).message, code });
  };

  app.post('/ap/v1/agent/tasks', auth.requireOperator, async (req, res) => {
    try {
      const task = await state.editorProtocol.createTask(req.body ?? {}, protocolContext(req, res));
      res.status(201).json(task);
    } catch (err) {
      protocolError(res, err);
    }
  });

  app.get('/ap/v1/agent/tasks', async (_req, res) => {
    const tasks = await state.editorProtocol.listTasks();
    res.json({ tasks, pagination: { total: tasks.length, pages: 1, current: 1, page_size: tasks.length } });
  });

  app.get('/ap/v1/agent/tasks/:task_id', async (req, res) => {
    const task = await state.editorProtocol.getTask(req.params.task_id);
    if (!task) {
      res.status(404).json({ error: `Task not found: ${req.params.task_id}` });
      return;
    }
    res.json(task);
  });

  app.post('/ap/v1/agent/tasks/:task_id/steps', auth.requireOperator, async (req, res) => {
    try {
      const step = await state.editorProtocol.executeStep(String(req.params.task_id), req.body, protocolContext(req, res));
      res.json(step);
    } catch (err) {
      protocolError(res, err);
    }
  });

  app.get('/ap/v1/agent/tasks/:task_id/steps', async (req, res) => {
    try {
      const steps = await state.editorProtocol.listSteps(req.params.task_id);
      res.json({ steps, pagination: { total: steps.length, pages: 1, current: 1, page_size: steps.length } });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.get('/ap/v1/agent/tasks/:task_id/steps/:step_id', async (req, res) => {
    const step = await state.editorProtocol.getStep(req.params.task_id, req.params.step_id);
    if (!step) {
      res.status(404).json({ error: `Step not found: ${req.params.step_id}` });
      return;
    }
    res.json(step);
  });

  app.get('/ap/v1/agent/tasks/:task_id/artifacts', async (req, res) => {
    try {
      const artifacts = await state.editorProtocol.listArtifacts(req.params.task_id);
      res.json({ artifacts });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post('/ap/v1/agent/tasks/:task_id/artifacts', auth.requireOperator, async (req, res) => {
    try {
      const artifact = await state.editorProtocol.createArtifact(String(req.params.task_id), req.body ?? {}, protocolContext(req, res));
      res.status(201).json(artifact);
    } catch (err) {
      protocolError(res, err);
    }
  });

  app.get('/ap/v1/agent/tasks/:task_id/artifacts/:artifact_id', async (req, res) => {
    const artifact = await state.editorProtocol.getArtifact(req.params.task_id, req.params.artifact_id);
    if (!artifact) {
      res.status(404).json({ error: `Artifact not found: ${req.params.artifact_id}` });
      return;
    }
    res.json(artifact);
  });

  // Model Context Protocol (MCP) Server JSON-RPC 2.0 Endpoint. Any valid
  // credential may connect; each JSON-RPC method is then classified on its
  // own (read-only metadata vs. tool execution) against the principal.
  app.use('/mcp', auth.requireProtocolPrincipal);

  const mcpHandler = async (req: express.Request, res: Response) => {
    const response = await state.editorProtocol.handleJsonRpc(req.body, protocolContext(req, res));
    if (response === null) {
      res.status(204).end();
    } else if (response.error?.code === JSONRPC_FORBIDDEN) {
      res.status(403).json(response);
    } else {
      res.json(response);
    }
  };

  app.post('/mcp', mcpHandler);
  app.post('/mcp/v1', mcpHandler);

  // Malformed JSON bodies: JSON-RPC parse error on MCP, plain 400 elsewhere —
  // never Express's default HTML page.
  app.use((err: unknown, req: express.Request, res: Response, next: express.NextFunction) => {
    if ((err as { type?: string })?.type !== 'entity.parse.failed') { next(err); return; }
    if (req.path.startsWith('/mcp')) {
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    res.status(400).json({ error: 'malformed JSON body' });
  });

  return app;
}
