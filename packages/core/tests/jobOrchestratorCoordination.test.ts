import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRegistry,
  ComputerRegistry,
  CoordinationFabric,
  ExecutionEngine,
  JobManager,
  JobOrchestrator,
  MessageRouter,
  ModelRegistry,
  ResourceReservationManager,
  RuntimeRegistry,
  Scheduler,
} from '../src/services/index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'wazir-orch-coord-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('JobOrchestrator coordination fabric integration', () => {
  it('acquires fenced resource leases, passes coordination client, and publishes lifecycle events', async () => {
    const fabricDir = makeTempDir();
    const fabric = new CoordinationFabric({ fabricDir });
    const messageRouter = new MessageRouter({ fabric });
    const resourceReservations = new ResourceReservationManager({ stateDir: fabricDir });

    const computers = new ComputerRegistry();
    computers.register({
      id: 'local',
      name: 'Local',
      type: 'workstation',
      local: true,
      os: { platform: 'darwin', architecture: 'arm64', version: '15.0' },
      hardware: { cpu: 'Apple M5 Pro', cpuCores: 8, memoryGB: 16 },
      capabilities: ['localExecution'],
      status: 'online',
    });
    const runtimes = new RuntimeRegistry();
    runtimes.register({
      id: 'ollama',
      type: 'ollama',
      name: 'ollama',
      version: '1.0',
      computerId: 'local',
      capabilities: {
        chat: true,
        streaming: true,
        toolCalling: true,
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
    const models = new ModelRegistry();
    models.register({
      id: 'qwen3:8b',
      name: 'qwen3:8b',
      provider: 'ollama',
      family: 'qwen',
      contextMax: 32_768,
      capabilities: ['generalChat', 'coding'],
      toolCalling: true,
      structuredOutput: false,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: false,
      runtimeCompatibility: 'any',
      local: true,
      availableOn: ['local'],
      status: 'available',
    });
    models.upsertInstance({
      id: 'qwen3:8b::local::ollama',
      modelId: 'qwen3:8b',
      computerId: 'local',
      runtimeId: 'ollama',
      runtimeModelId: 'qwen3:8b',
      loaded: true,
      health: 'healthy',
      contextTokens: 32_768,
    });
    const agents = new AgentRegistry();
    agents.register({
      descriptor: {
        name: 'wazir-coding',
        version: '1.0',
        capabilities: ['coding'],
        requiredTools: [],
        modelRequirements: { capabilities: ['coding'] },
        permissions: [],
        taskTypes: ['coding', 'chat'],
        strategy: 'native',
        description: 'test coding agent',
        source: 'native',
      },
      execute: async () => ({ success: true }),
    } as never);

    const scheduler = new Scheduler({ computers, runtimes, models, agents });
    const executionEngine = new ExecutionEngine();
    await executionEngine.ready;
    const jobManager = new JobManager();
    await jobManager.ready;

    const orchestrator = new JobOrchestrator({
      scheduler,
      executionEngine,
      jobManager,
      coordinationFabric: fabric,
      messageRouter,
      resourceReservations,
      taskExecutor: async (task, ctx) => {
        expect(ctx.coordination).toBeDefined();
        expect(ctx.fencingToken).toBeGreaterThan(0);
        await ctx.coordination!.publishProgress({ step: task.id });
        return { success: true, result: { ok: true } };
      },
    });

    const job = await orchestrator.createJob({
      title: 'Coord test',
      tasks: [
        {
          task: {
            id: 't1',
            title: 'Task 1',
            input: 'do work',
            type: 'coding',
            exclusiveResources: ['shared-lock'],
          },
        },
      ],
    });

    const finished = await orchestrator.runJob(job.id);
    expect(finished.graph.nodes[0]?.error).toBeUndefined();
    expect(finished.status).toBe('completed');

    // JobOrchestrator publishes coordination events fire-and-forget (publishCoordinationEvent
    // never awaits the fabric so fabric failures cannot crash a job). runJob() can therefore
    // resolve before the trailing 'resource.released' / 'job.completed' envelopes are durably
    // written. Poll the fabric until the terminal event is visible instead of racing it.
    let types: string[] = [];
    await vi.waitFor(
      async () => {
        const events = await fabric.replayEvents({ workflowId: job.id });
        types = events.map((e) => e.type);
        expect(types).toContain('resource.released');
        expect(types).toContain('job.completed');
      },
      { timeout: 5000, interval: 25 },
    );
    expect(types).toContain('job.started');
    expect(types).toContain('resource.acquired');
    expect(types).toContain('task.started');
    expect(types).toContain('task.progress');
    expect(types).toContain('task.completed');
    expect(types).toContain('resource.released');
    expect(types).toContain('job.completed');

    await fabric.close();
  });
});
