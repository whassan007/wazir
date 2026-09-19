import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  WorktreeManager,
  type Job,
  type JobNode,
  type Task,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { createFleetTaskExecutor } from '../src/fleetRunner.js';
import type { RookEngine } from '../src/engine.js';

/**
 * Regression coverage for the fleetRunner.ts tool-call double-reporting bug: it had its
 * own onProgress() call inside executeTool() *and* forwarded CodingAgent's own 'tool_call'
 * turn for the exact same call, so every tool invocation logged twice in the TUI's Tail
 * view. This exercises createFleetTaskExecutor directly (the actual code path used by
 * `wa chat`), not executeTask.e2e.test.ts's run.ts path, which never had this bug.
 */
async function buildTestEngine(projectRoot: string, reply: string): Promise<RookEngine> {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();
  const executions = new ExecutionEngine();

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
      chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false,
      embeddings: false, reasoning: false, modelLoad: false, modelUnload: false,
      modelDownload: false, statefulChat: false, mcp: false,
    },
  });

  models.register({
    id: 'fake-model', name: 'fake-model', provider: 'fake', family: 'other', contextMax: 32_768,
    capabilities: ['generalChat', 'coding'], toolCalling: false, structuredOutput: false,
    vision: false, audio: false, embedding: false, reasoning: false, runtimeCompatibility: 'any',
    local: true, createdAt: new Date(), updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'fake-model::local::fake', modelId: 'fake-model', computerId: 'local', runtimeId: 'fake',
    runtimeModelId: 'fake-model', loaded: true, health: 'healthy', contextTokens: 32_768,
  });

  agents.register(createCodingAgent(), 'native');

  const policy = new PolicyEngine({ projectRoot, networkAllowed: false });
  const scheduler = new Scheduler({ computers, runtimes, models, agents });

  let callCount = 0;
  const fakeAdapter: RuntimeAdapter = {
    id: 'fake',
    type: 'other',
    async discover() { return { id: 'fake', name: 'fake', version: '1.0' }; },
    async healthCheck() { return { status: 'healthy' }; },
    async listModels() { return [{ id: 'fake-model', name: 'fake-model' }]; },
    async getCapabilities() {
      return {
        chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false,
        embeddings: false, reasoning: false, modelLoad: false, modelUnload: false,
        modelDownload: false, statefulChat: false, mcp: false,
      };
    },
    async *generate() {
      const replies = [reply, '{"action":"done","summary":"done"}'];
      const r = replies[Math.min(callCount, replies.length - 1)];
      callCount += 1;
      yield { type: 'token' as const, content: r };
      yield { type: 'completed' as const, content: r, usage: { inputTokens: 5, outputTokens: 5 } };
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
    computers,
    runtimes,
    models,
    agents,
    tools,
    policy,
    scheduler,
    compiler,
    executions,
    worktrees: new WorktreeManager(),
    adapters: new Map([['fake', fakeAdapter]]),
    discovered: [],
    worker: fakeWorker,
  } as unknown as RookEngine;
}

describe('createFleetTaskExecutor — onProgress reporting', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('reports each tool call to onProgress exactly once, not twice', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-fleetrunner-e2e-'));
    const engine = await buildTestEngine(
      projectRoot,
      '{"action":"tool","tool":"write","input":{"path":"hello.cpp","content":"int main(){}"}}',
    );

    const executor = createFleetTaskExecutor(engine, { useWorktrees: false });

    const task: Task = {
      id: 'task-1',
      type: 'coding',
      title: 'write a file',
      input: 'write a file',
      requirements: {
        capabilities: [], reasoning: 'low', vision: false, toolCalling: false,
        minimumContext: 1024, minimumMemoryGB: 4, minimumGPUMemoryGB: 0, localOnly: false,
      },
      priority: 'normal',
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const node: JobNode = {
      id: task.id, type: 'task', taskId: task.id, state: 'running', dependencies: [], children: [],
    };

    const progressEvents: Array<{ kind?: string; tool?: string }> = [];

    const outcome = await executor(task, {
      jobId: 'job-1',
      taskId: task.id,
      node,
      assignment: {
        jobId: 'job-1',
        taskId: task.id,
        agentId: 'wazir-coding',
        modelId: 'fake-model',
        runtimeId: 'fake',
        computerId: 'local',
        assignedAt: new Date(),
        policy: [],
      },
      onProgress: (ev) => progressEvents.push(ev as { kind?: string; tool?: string }),
    });

    expect(outcome.success).toBe(true);
    expect(outcome.filesChanged).toContain('hello.cpp');

    const writeToolEvents = progressEvents.filter((e) => e.tool === 'write');
    expect(writeToolEvents).toHaveLength(1);
  });
});
