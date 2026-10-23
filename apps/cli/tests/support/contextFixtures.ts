import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  ModelRegistry,
  ModelLifecycleService,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  type ModelRecord,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { ChatAgent, createCodingAgent } from '@wazir/agents';
import type { GenerationRequest, RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import type { RookEngine } from '../../src/engine.js';

export type ModelSpec = Partial<ModelRecord> & { contextMax: number };

export const CAPS = {
  chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false,
  embeddings: false, reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false,
  statefulChat: false, mcp: false,
};

/** Real engine wiring (scheduler, executions, policy, tools); only the model adapter is fake. */
export async function buildEngine(
  projectRoot: string,
  spec: ModelSpec,
  /** runtimeType 'ollama' makes the context per-request configurable (num_ctx); other types fix it at load. */
  opts: { usage?: boolean; replies?: string[]; runtimeType?: 'ollama' | 'lmstudio' | 'other' } = {},
) {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const executions = new ExecutionEngine();
  computers.register({
    id: 'local', name: 'test-computer', type: 'workstation', local: true,
    os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
    hardware: { cpu: 'test-cpu', cpuCores: 4, memoryGB: 16 },
    capabilities: ['localExecution'],
  });
  runtimes.register({ id: 'fake', type: opts.runtimeType ?? 'other', name: 'fake-runtime', version: '1.0', computerId: 'local', capabilities: CAPS });
  runtimes.update('fake', { health: 'healthy' });
  models.register({
    id: 'fake-model', name: 'fake-model', provider: 'fake', family: 'other',
    capabilities: ['generalChat', 'coding'], toolCalling: false, structuredOutput: false,
    vision: false, audio: false, embedding: false, reasoning: false, runtimeCompatibility: 'any',
    local: true, createdAt: new Date(), updatedAt: new Date(),
    ...spec,
  });
  models.upsertInstance({
    id: 'fake-model::local::fake', modelId: 'fake-model', computerId: 'local', runtimeId: 'fake',
    runtimeModelId: 'fake-model', loaded: true, state: 'READY', health: 'healthy', contextTokens: spec.contextMax,
  });
  agents.register(createCodingAgent(), 'native');
  agents.register(new ChatAgent(), 'native');

  const requests: GenerationRequest[] = [];
  let n = 0;
  const replies = opts.replies ?? [
    '{"action":"plan","content":"write hello file"}',
    '{"action":"tool","tool":"write","input":{"path":"hello.txt","content":"hi"}}',
    '{"action":"done","summary":"wrote hello.txt"}',
  ];
  const adapter: RuntimeAdapter = {
    id: 'fake', type: 'other',
    async inspectModel(modelId) { return { modelId, loaded: true, effectiveContext: spec.contextMax }; },
    async probeModel() { return true; },
    async discover() { return { id: 'fake', name: 'fake', version: '1.0' }; },
    async healthCheck() { return { status: 'healthy' }; },
    async listModels() { return [{ id: 'fake-model', name: 'fake-model' }]; },
    async getCapabilities() { return CAPS; },
    async *generate(request: GenerationRequest) {
      requests.push(request);
      const reply = replies[Math.min(n, replies.length - 1)];
      n += 1;
      yield { type: 'token' as const, content: reply };
      yield opts.usage === false
        ? { type: 'completed' as const, content: reply }
        : { type: 'completed' as const, content: reply, usage: { inputTokens: 111, outputTokens: 7, reasoningTokens: 3 } };
    },
  } as unknown as RuntimeAdapter;

  const worker = {
    id: 'worker-local', computerId: 'local',
    adapterForModel: (id: string) => (id === 'fake-model' ? adapter : undefined),
  } as unknown as Worker;

  const engine = {
    config: { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] },
    projectRoot,
    configDir: path.join(projectRoot, '.wazir'),
    lifecycle: new ModelLifecycleService({ models, runtimes, computers, executions, adapters: new Map([['fake', adapter]]) }),
    computers, runtimes, models, agents,
    tools: new ToolRegistry(defaultTools),
    policy: new PolicyEngine({ projectRoot, networkAllowed: false }),
    scheduler: new Scheduler({ computers, runtimes, models, agents }),
    compiler: new ContextCompiler(),
    executions,
    adapters: new Map([['fake', adapter]]),
    discovered: [],
    worker,
  } as unknown as RookEngine;
  return { engine, requests };
}

