import express, { type Response } from 'express';
import os from 'node:os';
import {
  AgentRegistry,
  ComputerRegistry,
  ModelRegistry,
  RuntimeRegistry,
  type ModelRecord,
  type ModelCapability,
  type RuntimeType,
  type WorkerExecutionRequest,
  type WorkerExecutionEvent,
  type WorkerEventType,
} from '@wazir/core';
import { discoverHardware, discoverRuntimes, type DiscoveredRuntime } from '@wazir/workers';
import { createOllamaAdapter } from '@wazir/runtimes-ollama';
import { createLMStudioAdapter } from '@wazir/runtimes-lmstudio';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import { generateId, sanitizeUntrustedOutput } from '@wazir/shared';
import { ApiAuth, bearerToken, type ApiAuthOptions } from './auth.js';

// Bounds on in-memory state so an unauthenticated peer (or a runaway client)
// cannot grow the control plane without limit (security review F-19).
const MAX_QUEUED_PER_COMPUTER = 100;
const MAX_CHANNELS = 5_000;
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

/** Tracks one dispatched execution request from submission to worker-reported outcome. */
interface ExecutionChannel {
  computerId: string;
  events: WorkerExecutionEvent[];
  outcome?: ExecutionOutcome;
  waiters: Array<(outcome: ExecutionOutcome) => void>;
}

/**
 * Per-computer task dispatch: an SSE stream the worker holds open, plus a
 * queue for requests submitted while no worker is connected. This is the
 * bridge that lets the control plane push tasks to a remote worker — the
 * worker previously had no way to receive dispatched work at all.
 */
export class TaskDispatcher {
  private readonly streams = new Map<string, Response>();
  private readonly queues = new Map<string, WorkerExecutionRequest[]>();
  private readonly channels = new Map<string, ExecutionChannel>();

  isConnected(computerId: string): boolean {
    return this.streams.has(computerId);
  }

  /**
   * Attaches the (already authenticated) worker's response as the live
   * stream for `computerId`. A previous stream for the same computer is
   * closed: the caller proved it holds the computer's token, so it is the
   * legitimate worker reconnecting, and the old socket is stale.
   */
  subscribe(computerId: string, res: Response): void {
    const previous = this.streams.get(computerId);
    if (previous && previous !== res) {
      previous.end();
    }
    this.streams.set(computerId, res);
    const queued = this.queues.get(computerId);
    if (queued && queued.length > 0) {
      for (const request of queued) this.writeTask(res, request);
      this.queues.delete(computerId);
    }
  }

  /** Ends the live stream of a computer whose token was rotated; queued work stays for the new holder. */
  disconnect(computerId: string): void {
    const stream = this.streams.get(computerId);
    if (stream) {
      stream.end();
      this.streams.delete(computerId);
    }
  }

  ownerOf(requestId: string): string | undefined {
    return this.channels.get(requestId)?.computerId;
  }

  unsubscribe(computerId: string, res: Response): void {
    if (this.streams.get(computerId) === res) {
      this.streams.delete(computerId);
    }
  }

  /** Returns false when the target computer's queue or the channel table is full. */
  dispatch(computerId: string, request: WorkerExecutionRequest): { ok: true } | { ok: false; reason: string } {
    if (this.channels.has(request.requestId)) {
      return { ok: false, reason: `request '${request.requestId}' was already dispatched` };
    }
    const stream = this.streams.get(computerId);
    const queue = this.queues.get(computerId) ?? [];
    if (!stream && queue.length >= MAX_QUEUED_PER_COMPUTER) {
      return { ok: false, reason: `computer '${computerId}' has ${queue.length} queued requests and no connected worker` };
    }
    if (this.channels.size >= MAX_CHANNELS && !this.evictResolvedChannel()) {
      return { ok: false, reason: `control plane is tracking ${this.channels.size} unresolved requests` };
    }
    this.channels.set(request.requestId, { computerId, events: [], waiters: [] });
    if (stream) {
      this.writeTask(stream, request);
    } else {
      queue.push(request);
      this.queues.set(computerId, queue);
    }
    return { ok: true };
  }

  private evictResolvedChannel(): boolean {
    for (const [requestId, channel] of this.channels) {
      if (channel.outcome) {
        this.channels.delete(requestId);
        return true;
      }
    }
    return false;
  }

  recordEvent(requestId: string, event: WorkerExecutionEvent): boolean {
    const channel = this.channels.get(requestId);
    if (!channel) return false;
    if (channel.events.length >= MAX_EVENTS_PER_CHANNEL) channel.events.shift();
    channel.events.push(event);
    return true;
  }

  resolve(requestId: string, outcome: ExecutionOutcome): boolean {
    const channel = this.channels.get(requestId);
    if (!channel) return false;
    channel.outcome = outcome;
    for (const waiter of channel.waiters.splice(0)) waiter(outcome);
    return true;
  }

  status(requestId: string): { events: WorkerExecutionEvent[]; outcome?: ExecutionOutcome } | undefined {
    const channel = this.channels.get(requestId);
    if (!channel) return undefined;
    return { events: channel.events, outcome: channel.outcome };
  }

  /** Resolves once the outcome arrives, or rejects on timeout. */
  awaitOutcome(requestId: string, timeoutMs: number): Promise<ExecutionOutcome> {
    const channel = this.channels.get(requestId);
    if (!channel) return Promise.reject(new Error(`unknown request '${requestId}'`));
    if (channel.outcome) return Promise.resolve(channel.outcome);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for worker result')), timeoutMs);
      channel.waiters.push((outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  private writeTask(res: Response, request: WorkerExecutionRequest): void {
    res.write(`event: task\ndata: ${JSON.stringify(request)}\n\n`);
  }
}

export interface ApiState {
  computers: ComputerRegistry;
  runtimes: RuntimeRegistry;
  models: ModelRegistry;
  agents: AgentRegistry;
  tools: ToolRegistry;
  discovered: DiscoveredRuntime[];
  executions: Array<Record<string, unknown>>;
  dispatcher: TaskDispatcher;
  auth: ApiAuth;
}

export interface ApiStateOptions {
  auth?: ApiAuthOptions;
}

export async function createApiState(options: ApiStateOptions = {}): Promise<ApiState> {
  const auth = new ApiAuth(options.auth ?? {
    operatorToken: process.env.WAZIR_API_TOKEN,
    registrationToken: process.env.WAZIR_REGISTRATION_TOKEN,
  });
  const computers = new ComputerRegistry();
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
           contextTokens: discoveredModel.contextWindow ?? 32768,
         });
      }
    }
  }

  agents.register(createCodingAgent(), 'native');

  return {
    computers,
    runtimes,
    models,
    agents,
    tools,
    discovered,
    executions: [],
    dispatcher: new TaskDispatcher(),
    auth,
  };
}

function recordExecution(state: ApiState, record: Record<string, unknown>): void {
  state.executions.push(record);
  if (state.executions.length > MAX_EXECUTION_RECORDS) {
    state.executions.splice(0, state.executions.length - MAX_EXECUTION_RECORDS);
  }
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

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', name: 'wazir-api', version: '0.1.0', auth: { operatorToken: auth.operatorTokenRequired, registrationToken: auth.registrationToken !== undefined } });
  });

  // Everything that reads inventory/history or dispatches work is operator
  // territory. `/computers/*` (the worker protocol) authenticates per computer.
  app.use('/api/v1', auth.requireOperator);
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
    res.json({ models: state.models.list() });
  });

  // Which computer/runtime combinations can actually serve which model — a
  // remote scheduler needs this (not just the model catalog) to place a task.
  app.get('/api/v1/model-instances', (_req, res) => {
    res.json({ instances: state.models.listInstances() });
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
  app.post('/computers/register', (req, res) => {
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
      res.status(403).json({ error: `computer '${registration.id}' is already registered; present its token or the registration token to replace it` });
      return;
    }
    if (!exists && auth.registrationToken !== undefined && !byRegistrationToken) {
      res.status(401).json({ error: 'registration token required (Authorization: Bearer <WAZIR_REGISTRATION_TOKEN>)' });
      return;
    }

    const preferred = typeof registration.token === 'string' ? registration.token : undefined;
    delete (registration as { token?: unknown }).token;
    // Anything registering over HTTP is by definition not this process;
    // `local` is derived from the transport, never trusted from the payload
    // (F-15) — otherwise a `localOnly` task could be routed off-machine.
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
  app.get('/computers/:id/tasks/stream', auth.requireComputer, (req, res) => {
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
    state.dispatcher.subscribe(computerId, res);

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      state.dispatcher.unsubscribe(computerId, res);
    });
  });

  // Dispatch an authorized execution request to a specific computer's worker.
  // Pass ?wait=<ms> to block until the worker reports a result (or time out).
  app.post('/api/v1/tasks/dispatch', async (req, res) => {
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
    const dispatched = state.dispatcher.dispatch(computerId, request);
    if (dispatched.ok === false) {
      res.status(429).json({ error: dispatched.reason, requestId: request.requestId });
      return;
    }

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

  app.get('/api/v1/tasks/:requestId/status', (req, res) => {
    const status = state.dispatcher.status(req.params.requestId);
    if (!status) {
      res.status(404).json({ error: `request '${req.params.requestId}' unknown` });
      return;
    }
    res.json(status);
  });

  // Only the computer a request was dispatched to may report on it. The
  // result is fed straight back into the operator's agent loop as the model
  // reply, so a forged outcome from any other peer is code execution (F-2).
  const requireChannelOwner = (req: express.Request, res: Response): boolean => {
    const requestId = String(req.params.requestId);
    const computerId = String(req.params.id);
    const owner = state.dispatcher.ownerOf(requestId);
    if (owner === undefined) {
      res.status(404).json({ error: `request '${requestId}' unknown` });
      return false;
    }
    if (owner !== computerId) {
      res.status(403).json({ error: `request '${requestId}' was not dispatched to computer '${computerId}'` });
      return false;
    }
    return true;
  };

  // Worker → control plane: stream a lifecycle event for a dispatched request.
  app.post('/computers/:id/executions/:requestId/events', auth.requireComputer, (req, res) => {
    if (!requireChannelOwner(req, res)) return;
    const event: WorkerExecutionEvent = {
      executionId: String(req.body?.executionId ?? ''),
      type: (req.body?.type as WorkerEventType) ?? 'started',
      data: req.body?.data,
      at: new Date(),
    };
    state.dispatcher.recordEvent(String(req.params.requestId), event);
    res.json({ ok: true });
  });

  // Worker → control plane: final outcome of a dispatched request.
  app.post('/computers/:id/executions/:requestId/result', auth.requireComputer, (req, res) => {
    if (!requireChannelOwner(req, res)) return;
    const outcome = parseOutcome(req.body);
    if (!outcome) {
      res.status(400).json({ error: 'outcome must include boolean `ok` and string `output`' });
      return;
    }
    const requestId = String(req.params.requestId);
    const known = state.dispatcher.resolve(requestId, outcome);
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

  return app;
}
