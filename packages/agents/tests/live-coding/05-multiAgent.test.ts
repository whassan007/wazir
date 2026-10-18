import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  ModelLifecycleService,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { createCodingAgent } from '../../src/codingAgent.js';
import { executeTask } from '../../../../apps/cli/src/run.js';
import type { RookEngine } from '../../../../apps/cli/src/engine.js';

describe('LIVE-CODE-05: Multi-Agent Coding Delegation (Release Gate G5)', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('spawns a bounded child execution linked by parentExecutionId, prevents recursive dispatch, and merges file mutations', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-live05-multiagent-'));

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

    const policy = new PolicyEngine({ projectRoot, networkAllowed: false });
    const scheduler = new Scheduler({ computers, runtimes, models, agents });

    // Sequence of model replies across parent and child:
    // 1. Parent plans
    // 2. Parent dispatches subagent to create sub.txt
    // 3. Child plans
    // 4. Child writes sub.txt
    // 5. Child completes
    // 6. Parent completes
    const replies = [
      '{"action":"plan","content":"Delegate creation of sub.txt to a subagent."}',
      '{"action":"tool","tool":"dispatch_subagent","input":{"description":"Create sub.txt containing delegated-ok","expectedArtifacts":["sub.txt"]}}',
      '{"action":"plan","content":"Write sub.txt in child execution."}',
      '{"action":"tool","tool":"write","input":{"path":"sub.txt","content":"delegated-ok"}}',
      '{"action":"done","summary":"Created sub.txt in child subagent"}',
      '{"action":"done","summary":"Subagent created sub.txt and parent verified it"}',
    ];
    let callIdx = 0;

    const fakeAdapter: RuntimeAdapter = {
      id: 'fake',
      type: 'other',
      async inspectModel(modelId) {
        return { modelId, loaded: true, effectiveContext: 32_768 };
      },
      async probeModel() {
        return true;
      },
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
      async *generate() {
        const reply = replies[Math.min(callIdx++, replies.length - 1)];
        yield { type: 'token' as const, content: reply };
        yield { type: 'completed' as const, content: reply, usage: { inputTokens: 10, outputTokens: 10 } };
      },
    };

    const fakeWorker = {
      id: 'worker-local',
      computerId: 'local',
      adapterForModel: (modelId: string) => (modelId === 'fake-model' ? fakeAdapter : undefined),
    } as unknown as Worker;

    const engine: RookEngine = {
      config: {
        modelContext: {},
        modelCapabilities: {},
        networkAllowed: false,
        allowCommands: [],
        denyCommands: [],
        allowedMcpServers: [],
      },
      projectRoot,
      configDir: path.join(projectRoot, '.wazir'),
      lifecycle: new ModelLifecycleService({
        models,
        runtimes,
        computers,
        executions,
        adapters: new Map([['fake', fakeAdapter]]),
      }),
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
    } as unknown as RookEngine;

    const emittedEvents: Array<Record<string, unknown>> = [];
    const origWrite = process.stdout.write;
    process.stdout.write = function (str: unknown) {
      if (typeof str === 'string') {
        for (const line of str.split('\n')) {
          if (line.trim().startsWith('{')) {
            emittedEvents.push(JSON.parse(line));
          }
        }
      }
      return true;
    } as typeof process.stdout.write;

    try {
      const outcome = await executeTask(engine, 'Delegate creation of sub.txt to a subagent', {
        json: true,
        quiet: true,
      });

      expect(outcome.success).toBe(true);
      expect(outcome.errors).toEqual([]);
      expect(outcome.filesChanged).toContain('sub.txt');
      expect(await fs.readFile(path.join(projectRoot, 'sub.txt'), 'utf8')).toBe('delegated-ok');

      const subStart = emittedEvents.find((e) => e.type === 'subagent.start');
      const subComplete = emittedEvents.find((e) => e.type === 'subagent.complete');
      expect(subStart).toBeDefined();
      expect(subComplete).toBeDefined();
      expect(subStart?.parentExecutionId).toBe(outcome.executionId);
      expect(subStart?.executionId).not.toBe(outcome.executionId);

      const childRecord = await executions.get(String(subStart?.executionId));
      expect(childRecord).toBeDefined();
      expect(childRecord?.execution.parentExecutionId).toBe(outcome.executionId);
      expect(childRecord?.filesChanged).toContain('sub.txt');
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
