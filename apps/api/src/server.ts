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
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import { generateId, sanitizeUntrustedOutput, MemoryStore, type KeyValueStore } from '@wazir/shared';
import { ApiAuth, bearerToken, type ApiAuthOptions } from './auth.js';

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
  attempt: number;
  lease?: { token: string; expiresAt: number };
}

export class TaskDispatcher {
  private readonly streams = new Map<string, Response>();
  private readonly records = new Map<string, DurableDispatch>();
  readonly ready: Promise<void>;

  constructor(private readonly store: KeyValueStore = new MemoryStore(),
    private readonly now: () => number = Date.now, readonly leaseMs = 30_000) {
    if (!store.update) throw new Error('ATOMIC_STORE_REQUIRED');
    if (!Number.isFinite(leaseMs) || leaseMs < 100) throw new Error('INVALID_LEASE_DURATION');
    this.ready = this.refresh();
  }

  private key(id: string): string { return `dispatch/${id}`; }
  private async refresh(): Promise<void> {
    for (const entry of await this.store.list('dispatch/')) {
      const record = entry.value as DurableDispatch;
      this.records.set(record.request.requestId, record);
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
    await this.redeliver();
  }
  disconnect(id: string): void { this.streams.get(id)?.end(); this.streams.delete(id); }
  unsubscribe(id: string, res: Response): void {
    if (this.streams.get(id) === res) this.streams.delete(id);
  }
  async redeliver(): Promise<void> {
    await this.refresh();
    for (const r of this.records.values()) {
      const stream = this.streams.get(r.computerId);
      if (stream && !r.outcome && (!r.lease || r.lease.expiresAt <= this.now())) {
        stream.write(`event: task\ndata: ${JSON.stringify(r.request)}\n\n`);
      }
    }
  }
  async dispatch(computerId: string, request: WorkerExecutionRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
    await this.ready;
    await this.refresh();
    if ([...this.records.values()].filter(r => r.computerId === computerId && !r.outcome).length >= MAX_QUEUED_PER_COMPUTER) {
      return { ok: false, reason: 'RESOURCE_BUSY' };
    }
    try {
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
      return { ...current, attempt: current.attempt + 1,
        events: [...current.events.slice(-(MAX_EVENTS_PER_CHANNEL - 1)), { executionId: current.request.executionId, type: 'lease_acquired' as const, at: new Date(this.now()), data: { attempt: current.attempt + 1 } }],
        lease: { token: randomUUID(), expiresAt: this.now() + this.leaseMs } };
    });
    this.records.set(id, record);
    return { ...record.lease!, attempt: record.attempt, leaseMs: this.leaseMs };
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
    const record = await this.store.update!<DurableDispatch>(this.key(id), current => {
      const r = this.validate(current, token);
      return r.outcome ? r : { ...r, outcome };
    });
    this.records.set(id, record); return true;
  }
  async assignments(): Promise<Array<{ id: string; modelId: string; computerId: string; runtimeId?: string }>> {
    await this.refresh();
    return [...this.records.values()].filter(r => !r.outcome).map(r => ({ id: r.request.executionId,
      computerId: r.computerId, modelId: r.request.modelId, runtimeId: r.request.runtimeId }));
  }
  async status(id: string): Promise<{ events: WorkerExecutionEvent[]; outcome?: ExecutionOutcome } | undefined> {
    const r = await this.store.get<DurableDispatch>(this.key(id));
    return r ? { events: r.events, outcome: r.outcome } : undefined;
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
}

export interface ApiStateOptions {
  workerLeaseMs?: number;
  modelStartup?: Parameters<ModelLifecycleService['applyStartupPolicy']>[0];
  auth?: ApiAuthOptions;
  store?: KeyValueStore;
}

export async function createApiState(options: ApiStateOptions = {}): Promise<ApiState> {
  const auth = new ApiAuth(options.auth ?? {
    operatorToken: process.env.WAZIR_API_TOKEN,
    viewerToken: process.env.WAZIR_API_VIEWER_TOKEN,
    registrationToken: process.env.WAZIR_REGISTRATION_TOKEN,
    store: options.store,
  });
  await auth.init();
  const store = options.store ?? new MemoryStore();
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

  const adapters = [
    createOllamaAdapter(process.env.WAZIR_OLLAMA_URL ?? 'http://localhost:11434'),
    createLMStudioAdapter(process.env.WAZIR_LMSTUDIO_URL ?? 'http://localhost:1234/v1'),
  ];

  const discovered = await discoverRuntimes(adapters);
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
  auth.issueComputerToken(localId);

  for (const discoveredRuntime of discovered) {
    runtimes.register({
      id: discoveredRuntime.id,
      type: discoveredRuntime.id === 'ollama' ? 'ollama' : discoveredRuntime.id === 'lmstudio' ? 'lmstudio' : 'other',
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
           local: true,
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
           loaded: false,
           health: discoveredRuntime.health === 'healthy' ? 'healthy' : 'degraded',
           state: 'INSTALLED',
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

  const editorProtocol = new EditorProtocolService({
    store,
    tools,
  });

  return {
    computers,
    runtimes,
    models,
    lifecycle,
    agents,
    tools,
    discovered,
    executions: [],
    dispatcher,
    store,
    auth,
    editorProtocol,
  };
}

function recordExecution(state: ApiState, record: Record<string, unknown>): void {
  state.executions.push(record);
  if (state.executions.length > MAX_EXECUTION_RECORDS) {
    state.executions.splice(0, state.executions.length - MAX_EXECUTION_RECORDS);
  }
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
      version: '0.1.0',
      auth: {
        operatorToken: auth.operatorTokenRequired,
        viewerToken: auth.viewerTokenRequired,
        registrationToken: auth.registrationToken !== undefined,
      },
    });
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

  // Read-only control routes allow viewer or operator tokens.
  // Mutating endpoints (dispatch, executions) explicitly enforce operator scope.
  app.use('/api/v1', auth.requireViewerOrOperator);
  app.use('/executions', auth.requireOperator);

  app.get('/api/v1/overview', (_req, res) => {
    res.json({
      name: 'wazir',
      version: '0.1.0',
      description:
        'Wazir is a model- and runtime-agnostic meta-harness that schedules AI agents, models, tools, and compute to execute tasks across local and distributed environments.',
      computerId: localId,
      hostname: os.hostname(),
      counts: {
        computers: state.computers.list().length,
        runtimes: state.runtimes.list().length,
        models: state.models.list().length,
        agents: state.agents.list().length,
        tools: state.tools.list().length,
        executions: state.executions.length,
      },
    });
  });

  app.get('/api/v1/computers', (_req, res) => {
    res.json({ computers: state.computers.list() });
  });

  app.get('/api/v1/workers', (_req, res) => {
    const local = state.computers.get(localId);
    res.json({
      workers: local
        ? [
            {
              id: `worker-${localId}`,
              computerId: localId,
              name: local.name,
              status: local.status,
              runtimes: local.runtimes,
              models: local.models,
              lastHeartbeat: local.lastHeartbeat,
            },
          ]
        : [],
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
    try { res.json(await state.lifecycle.load(String(req.params.id), req.body ?? {})); }
    catch (error) { lifecycleError(res, error); }
  });
  app.post('/api/v1/models/:id/unload', auth.requireOperator, async (req, res) => {
    try { await state.lifecycle.unload(String(req.params.id), req.body ?? {}); res.json({ state: 'UNLOADED' }); }
    catch (error) { lifecycleError(res, error); }
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

  app.get('/api/v1/executions', (_req, res) => {
    res.json({ executions: state.executions.slice().reverse() });
  });

  app.get('/api/v1/executions/:id', (req, res) => {
    // Exact match only: a substring match let `GET /executions/a` return an
    // arbitrary record (F-18).
    const execution = state.executions.find((e) => (e.execution as { id?: string })?.id === req.params.id);
    if (!execution) {
      res.status(404).json({ error: `execution '${req.params.id}' not found` });
      return;
    }
    res.json({ execution });
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
    await state.store.put(`computer/registration/${registration.id}`, { ...registration, local: false });
    const computer = state.computers.register({ ...registration, local: false });
    let token: string;
    if (byComputerToken && !preferred) {
      token = presented as string; // re-registration with the current token keeps it
    } else {
      // Fresh registration or replacement: rotate the token so any stream a
      // previous holder still has open stops receiving work.
      state.dispatcher.disconnect(registration.id);
      token = auth.issueComputerToken(registration.id, preferred);
    }
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
    await state.dispatcher.subscribe(computerId, res);

    const keepAlive = setInterval(() => { res.write(': ping\n\n'); void state.dispatcher.redeliver().catch(() => undefined); }, 5_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      state.dispatcher.unsubscribe(computerId, res);
    });
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
    let known: boolean;
    try { known = await state.dispatcher.resolve(requestId, outcome, String(req.body?.leaseToken ?? '')); }
    catch (error) { res.status(409).json({ error: (error as Error).message }); return; }
    if (!known) {
      res.status(404).json({ error: `request '${requestId}' unknown` });
      return;
    }
    recordExecution(state, {
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

  app.post('/executions', (req, res) => {
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
    recordExecution(state, record);
    res.status(201).json({ id, record });
  });

  // Agent Protocol (ACP) Standard Endpoints
  app.use('/ap/v1', auth.requireViewerOrOperator);

  app.post('/ap/v1/agent/tasks', async (req, res) => {
    try {
      const task = await state.editorProtocol.createTask(req.body ?? {});
      res.status(201).json(task);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
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

  app.post('/ap/v1/agent/tasks/:task_id/steps', async (req, res) => {
    try {
      const step = await state.editorProtocol.executeStep(req.params.task_id, req.body);
      res.json(step);
    } catch (err) {
      const msg = (err as Error).message;
      res.status(msg.startsWith('TASK_NOT_FOUND') ? 404 : 400).json({ error: msg });
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

  app.post('/ap/v1/agent/tasks/:task_id/artifacts', async (req, res) => {
    try {
      const artifact = await state.editorProtocol.createArtifact(req.params.task_id, req.body ?? {});
      res.status(201).json(artifact);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
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

  // Model Context Protocol (MCP) Server JSON-RPC 2.0 Endpoint
  app.use('/mcp', auth.requireViewerOrOperator);

  const mcpHandler = async (req: express.Request, res: Response) => {
    const response = await state.editorProtocol.handleJsonRpc(req.body);
    if (response === null) {
      res.status(204).end();
    } else {
      res.json(response);
    }
  };

  app.post('/mcp', mcpHandler);
  app.post('/mcp/v1', mcpHandler);

  return app;
}
