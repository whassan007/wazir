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
import { generateId } from '@wazir/shared';

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
class TaskDispatcher {
  private readonly streams = new Map<string, Response>();
  private readonly queues = new Map<string, WorkerExecutionRequest[]>();
  private readonly channels = new Map<string, ExecutionChannel>();

  isConnected(computerId: string): boolean {
    return this.streams.has(computerId);
  }

  subscribe(computerId: string, res: Response): void {
    this.streams.set(computerId, res);
    const queued = this.queues.get(computerId);
    if (queued && queued.length > 0) {
      for (const request of queued) this.writeTask(res, request);
      this.queues.delete(computerId);
    }
  }

  unsubscribe(computerId: string, res: Response): void {
    if (this.streams.get(computerId) === res) {
      this.streams.delete(computerId);
    }
  }

  dispatch(computerId: string, request: WorkerExecutionRequest): void {
    this.channels.set(request.requestId, { computerId, events: [], waiters: [] });
    const stream = this.streams.get(computerId);
    if (stream) {
      this.writeTask(stream, request);
    } else {
      const queue = this.queues.get(computerId) ?? [];
      queue.push(request);
      this.queues.set(computerId, queue);
    }
  }

  recordEvent(requestId: string, event: WorkerExecutionEvent): boolean {
    const channel = this.channels.get(requestId);
    if (!channel) return false;
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
}

export async function createApiState(): Promise<ApiState> {
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
  };
}

export function createApp(state: ApiState) {
  const app = express();
  app.use(express.json());

  const localId = process.env.WAZIR_COMPUTER_ID ?? 'local';

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', name: 'wazir-api', version: '0.1.0' });
  });

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
    const execution = state.executions.find(
      (e) => (e.execution as { id?: string })?.id === req.params.id || (e.execution as { id?: string })?.id?.includes(req.params.id),
    );
    if (!execution) {
      res.status(404).json({ error: `execution '${req.params.id}' not found` });
      return;
    }
    res.json({ execution });
  });

  // Worker protocol (registration + heartbeat)
  app.post('/computers/register', (req, res) => {
    const registration = req.body as Parameters<ComputerRegistry['register']>[0];
    if (!registration?.id) {
      res.status(400).json({ error: 'registration.id is required' });
      return;
    }
    state.computers.register(registration);
    res.json({ ok: true, id: registration.id });
  });

  app.post('/computers/:id/heartbeat', (req, res) => {
    const computer = state.computers.get(req.params.id);
    if (!computer) {
      res.status(404).json({ error: `computer '${req.params.id}' unknown — register first` });
      return;
    }
    state.computers.heartbeat(req.params.id, {
      load: req.body?.load,
      runtimeHealth: req.body?.runtimeHealth,
      modelHealth: req.body?.modelHealth,
    });
    res.json({ ok: true });
  });

  // Worker task-pull loop: a worker holds this SSE connection open and receives
  // dispatched WorkerExecutionRequests as `event: task` frames. This is the
  // channel that lets the control plane push work to a remote worker.
  app.get('/computers/:id/tasks/stream', (req, res) => {
    const computerId = req.params.id;
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

    state.dispatcher.dispatch(computerId, request);

    const waitMs = Number(req.query.wait ?? 0);
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

  // Worker → control plane: stream a lifecycle event for a dispatched request.
  app.post('/computers/:id/executions/:requestId/events', (req, res) => {
    const event: WorkerExecutionEvent = {
      executionId: String(req.body?.executionId ?? ''),
      type: (req.body?.type as WorkerEventType) ?? 'started',
      data: req.body?.data,
      at: new Date(),
    };
    const known = state.dispatcher.recordEvent(req.params.requestId, event);
    if (!known) {
      res.status(404).json({ error: `request '${req.params.requestId}' unknown` });
      return;
    }
    res.json({ ok: true });
  });

  // Worker → control plane: final outcome of a dispatched request.
  app.post('/computers/:id/executions/:requestId/result', (req, res) => {
    const outcome = req.body as ExecutionOutcome;
    const known = state.dispatcher.resolve(req.params.requestId, outcome);
    if (!known) {
      res.status(404).json({ error: `request '${req.params.requestId}' unknown` });
      return;
    }
    state.executions.push({
      execution: { id: req.params.requestId, status: outcome.ok ? 'completed' : 'failed', createdAt: new Date() },
      computerId: req.params.id,
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
      result: req.body?.result,
      usage: req.body?.usage,
    };
    state.executions.push(record);
    res.status(201).json({ id, record });
  });

  return app;
}
