import { promises as fs } from 'node:fs';
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
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { ChatAgent, createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { executeTask } from '../../apps/cli/src/run.js';
import type { RookEngine } from '../../apps/cli/src/engine.js';

/**
 * Real "Task -> Result" end-to-end test, replacing the placeholder that
 * used to live at tests/integration/endToEnd.test.ts (`expect(true).toBe
 * (true)`, with a comment saying full coverage "would require mocking all
 * dependencies"). This builds an actual RookEngine (real PolicyEngine, real
 * Scheduler, real ExecutionEngine, real ToolRegistry running real
 * filesystem/check tools against a scratch project directory) and only
 * fakes the one thing that's genuinely external: the model itself.
 */
export async function buildTestEngine(projectRoot: string, scriptedReplies?: string[], executions = new ExecutionEngine()): Promise<RookEngine> {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();

  computers.register({
    id: 'local',
    name: 'test-computer',
    type: 'workstation',
    local: true,
    os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
    hardware: { cpu: 'test-cpu', cpuCores: 4, memoryGB: 16 },
    capabilities: ['localExecution'],
  });

  runtimes.register({
    id: 'fake',
    type: 'other',
    name: 'fake-runtime',
    version: '1.0',
    computerId: 'local',
    capabilities: {
      chat: true,
      streaming: true,
      toolCalling: false,
      structuredOutput: false,
      vision: false,
      embeddings: false,
      reasoning: false,
      modelLoad: false,
      modelUnload: false,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    },
  });

  runtimes.update('fake', { health: 'healthy' });

  models.register({
    id: 'fake-model',
    name: 'fake-model',
    provider: 'fake',
    family: 'other',
    contextMax: 32_768,
    capabilities: ['generalChat', 'coding'],
    toolCalling: false,
    structuredOutput: false,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: false,
    runtimeCompatibility: 'any',
    local: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'fake-model::local::fake',
    modelId: 'fake-model',
    computerId: 'local',
    runtimeId: 'fake',
    runtimeModelId: 'fake-model',
    loaded: true,
    state: 'READY',
    health: 'healthy',
    contextTokens: 32_768,
  });

  agents.register(createCodingAgent(), 'native');
  agents.register(new ChatAgent(), 'native');

  const policy = new PolicyEngine({ projectRoot, networkAllowed: false });
  const scheduler = new Scheduler({ computers, runtimes, models, agents });

  let callCount = 0;
  const fakeAdapter: RuntimeAdapter = {
    id: 'fake',
    type: 'other',
    async inspectModel(modelId) { return { modelId, loaded: true, effectiveContext: 32768 }; },
    async probeModel() { return true; },
    async discover() {
      return { id: 'fake', name: 'fake', version: '1.0' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async listModels() {
      return [{ id: 'fake-model', name: 'fake-model' }];
    },
    async getCapabilities() {
      return {
        chat: true,
        streaming: true,
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        embeddings: false,
        reasoning: false,
        modelLoad: false,
        modelUnload: false,
        modelDownload: false,
        statefulChat: false,
        mcp: false,
      };
    },
    // The only faked part of the whole pipeline: turn 1 writes a file
    // through the real `write` tool, turn 2 reports done. Everything else
    // (policy authorization, scheduling, the tool call, execution
    // recording, verification) is the genuine production code path.
    async *generate() {
      const replies = scriptedReplies ?? [
        '{"action":"plan","content":"write hello file"}',
        '{"action":"tool","tool":"write","input":{"path":"hello.txt","content":"hi from the fake model"}}',
        '{"action":"done","summary":"wrote hello.txt"}',
      ];
      const reply = replies[Math.min(callCount, replies.length - 1)];
      callCount += 1;
      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply, usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };

  const fakeWorker = {
    id: 'worker-local',
    computerId: 'local',
    adapterForModel: (modelId: string) => (modelId === 'fake-model' ? fakeAdapter : undefined),
  } as unknown as Worker;

  return {
    config: { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] },
    projectRoot,
    configDir: path.join(projectRoot, '.wazir'),
    lifecycle: new ModelLifecycleService({ models, runtimes, computers, executions, adapters: new Map([['fake', fakeAdapter]]) }),
    computers,
    runtimes,
    models,
    agents,
    tools,
    policy,
    scheduler,
    compiler,
    executions,
    adapters: new Map([['fake', fakeAdapter]]),
    discovered: [],
    worker: fakeWorker,
  };
}
