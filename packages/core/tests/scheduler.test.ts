import { describe, it, expect, beforeEach } from 'vitest';
import {
  Scheduler,
  type SchedulerDeps,
} from '../src/services/scheduler.js';
import {
  ComputerRegistry,
  ModelRegistry,
  RuntimeRegistry,
} from '@wazir/core';

describe('Scheduler', () => {
  let deps: SchedulerDeps;
  let scheduler: Scheduler;

  beforeEach(() => {
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();

    // Register a local computer
    computers.register({
      id: 'local-1',
      name: 'Local Machine',
      type: 'workstation' as const,
      local: true,
      os: { platform: 'linux', architecture: 'x64', version: '5.0' },
      hardware: {
        cpu: 'test-cpu',
        cpuCores: 8,
        memoryGB: 32,
      },
      runtimes: ['ollama'],
      models: [],
      capabilities: ['localExecution'],
    });

    // Register runtime
    runtimes.register({
      id: 'ollama',
      type: 'ollama' as const,
      name: 'Ollama',
      version: '0.1',
      computerId: 'local-1',
      health: 'healthy' as const,
      capabilities: {
        chat: true,
        streaming: true,
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        embeddings: false,
        reasoning: false,
        modelLoad: true,
        modelUnload: true,
        modelDownload: false,
        statefulChat: false,
        mcp: false,
      },
      loadedModels: [],
    });

    // Register a model
    models.register({
      id: 'model-1',
      name: 'Test Model',
      provider: 'ollama',
      family: 'qwen' as const,
      contextMax: 32768,
      capabilities: ['generalChat', 'coding'],
      toolCalling: false,
      structuredOutput: false,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: false,
      runtimeCompatibility: ['ollama' as const],
      local: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Register model instance
    models.upsertInstance({
      id: 'model-instance-1',
      modelId: 'model-1',
      computerId: 'local-1',
      runtimeId: 'ollama' as const,
      runtimeModelId: 'test-model:latest',
      loaded: true,
      health: 'healthy' as const,
    });

    deps = { computers, runtimes, models };
    scheduler = new Scheduler(deps);
  });

  it('schedules task to eligible computer', () => {
    const task = {
      id: 'task-1',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const decision = scheduler.plan({ task });

    expect(decision.computerId).toBe('local-1');
    expect(decision.runtimeId).toBe('ollama');
    expect(decision.modelId).toBe('model-1');
  });

  it('rejects task with incompatible capabilities', () => {
    const task = {
      id: 'task-2',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: ['vision'] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    expect(() => scheduler.plan({ task })).toThrow('No model satisfies');
  });


  it('produces explainable reasons', () => {
    const task = {
      id: 'task-4',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const decision = scheduler.plan({ task });

    expect(decision.reasons).toHaveLength(2);
    expect(decision.reasons[0]).toContain('model');
    expect(decision.reasons[1]).toContain('computer');
  });

  // Replaces the old tests/integration/degraded.test.ts, which only checked
  // that the string 'degraded' is a member of an array literal it wrote
  // itself — it never touched the Scheduler at all. This exercises the
  // actual degraded-runtime handling in `scheduleComputer`/`selectInstance`.
  it('still schedules a computer whose runtime is degraded, but scores it below a healthy alternative', () => {
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();

    for (const id of ['healthy-computer', 'degraded-computer']) {
      computers.register({
        id,
        name: id,
        type: 'workstation' as const,
        local: true,
        os: { platform: 'linux', architecture: 'x64', version: '5.0' },
        hardware: { cpu: 'test-cpu', cpuCores: 8, memoryGB: 32 },
      });
      runtimes.register({
        id: `ollama-${id}`,
        type: 'ollama' as const,
        name: 'Ollama',
        version: '0.1',
        computerId: id,
        capabilities: {
          chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false,
          embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false,
          statefulChat: false, mcp: false,
        },
      });
    }
    runtimes.update('ollama-degraded-computer', { health: 'degraded' });
    runtimes.update('ollama-healthy-computer', { health: 'healthy' });

    models.register({
      id: 'shared-model',
      name: 'Shared Model',
      provider: 'ollama',
      family: 'qwen' as const,
      contextMax: 32768,
      capabilities: ['generalChat'],
      toolCalling: false,
      structuredOutput: false,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: false,
      runtimeCompatibility: ['ollama' as const],
      local: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    for (const id of ['healthy-computer', 'degraded-computer']) {
      models.upsertInstance({
        id: `shared-model-instance-${id}`,
        modelId: 'shared-model',
        computerId: id,
        runtimeId: `ollama-${id}`,
        runtimeModelId: 'shared-model:latest',
        loaded: true,
        health: 'healthy',
      });
    }

    const s = new Scheduler({ computers, runtimes, models });
    const task = {
      id: 'task-degraded',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const decision = s.plan({ task });

    // Not rejected — a degraded runtime is a scoring penalty, not a hard fail.
    expect(decision.computerId).toBe('healthy-computer');
    expect(decision.computerDecision.reasons.some((r) => r.includes('is healthy'))).toBe(true);

    // Force the healthy computer out and confirm the degraded one is still
    // schedulable on its own (i.e. it's a real fallback target, not dead).
    computers.setOffline('healthy-computer');
    const fallbackDecision = s.plan({ task });
    expect(fallbackDecision.computerId).toBe('degraded-computer');
  });

  it('selectInstance prefers a healthy loaded instance over a degraded one for the same model', () => {
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();

    for (const id of ['c-healthy', 'c-degraded']) {
      computers.register({
        id,
        name: id,
        type: 'workstation' as const,
        local: true,
        os: { platform: 'linux', architecture: 'x64', version: '5.0' },
        hardware: { cpu: 'test-cpu', cpuCores: 8, memoryGB: 32 },
      });
      runtimes.register({
        id: `rt-${id}`,
        type: 'ollama' as const,
        name: 'Ollama',
        version: '0.1',
        computerId: id,
        capabilities: {
          chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false,
          embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false,
          statefulChat: false, mcp: false,
        },
      });
    }

    models.register({
      id: 'm',
      name: 'm',
      provider: 'ollama',
      family: 'qwen' as const,
      contextMax: 32768,
      capabilities: ['generalChat'],
      toolCalling: false,
      structuredOutput: false,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: false,
      runtimeCompatibility: ['ollama' as const],
      local: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    models.upsertInstance({
      id: 'm-on-degraded',
      modelId: 'm',
      computerId: 'c-degraded',
      runtimeId: 'rt-c-degraded',
      runtimeModelId: 'm:latest',
      loaded: false,
      health: 'degraded',
    });
    models.upsertInstance({
      id: 'm-on-healthy',
      modelId: 'm',
      computerId: 'c-healthy',
      runtimeId: 'rt-c-healthy',
      runtimeModelId: 'm:latest',
      loaded: true,
      health: 'healthy',
    });

    const s = new Scheduler({ computers, runtimes, models });
    const decision = s.plan({
      task: {
        id: 'task-instance-pref',
        type: 'coding' as const,
        input: 'x',
        requirements: { capabilities: [] },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      },
    });

    expect(decision.modelInstanceId).toBe('m-on-healthy');
    expect(decision.computerId).toBe('c-healthy');
  });
});
