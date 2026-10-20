import { describe, it, expect } from 'vitest';
import {
  Scheduler,
  SchedulingError,
  ModelRegistry,
  ComputerRegistry,
  RuntimeRegistry,
  AgentRegistry,
  ExecutionEngine,
  PolicyEngine,
  type Task,
} from '@wazir/core';
import { MemoryStore } from '@wazir/shared';

describe('Section 9 & 10: Multi-Agent Switching & Cross-Computer Placement (model_cycle.md)', () => {
  function setupHarness() {
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();
    const agents = new AgentRegistry();
    const store = new MemoryStore();
    const policy = new PolicyEngine({ projectRoot: '/tmp' });
    const executions = new ExecutionEngine({ store, policy });

    // Register agents: 'coder' and 'reviewer'
    agents.register(
      {
        descriptor: {
          name: 'coder',
          version: '1.0',
          description: 'Coder agent',
          capabilities: ['coding'],
          requiredTools: [],
          modelRequirements: {},
          permissions: [],
          taskTypes: ['coding'],
          strategy: 'test',
        },
        async *run() {
          yield { kind: 'done', content: 'coder finished' };
        },
      },
      'native',
    );

    agents.register(
      {
        descriptor: {
          name: 'reviewer',
          version: '1.0',
          description: 'Reviewer agent',
          capabilities: ['review'],
          requiredTools: [],
          modelRequirements: {},
          permissions: [],
          taskTypes: ['review'],
          strategy: 'test',
        },
        async *run() {
          yield { kind: 'done', content: 'reviewer finished' };
        },
      },
      'native',
    );

    // Register local computer
    computers.register({
      id: 'local-mac',
      name: 'Local Host',
      local: true,
      health: 'healthy',
      hardware: { cpus: 8, memoryGB: 32 },
    });

    // Register runtime
    runtimes.register({
      id: 'rt-ollama',
      type: 'ollama',
      name: 'Ollama',
      computerId: 'local-mac',
      version: '0.3',
      capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
    });

    return { computers, runtimes, models, agents, store, executions };
  }

  describe('Section 9: Model Switching Across Agents', () => {
    it('runs multi-agent sequential tasks with explicit model pins and independent explainability', async () => {
      const { computers, runtimes, models, agents, executions } = setupHarness();

      // Register Model A (e.g. specialized coder)
      models.register({
        id: 'model-qwen-coder',
        name: 'Qwen Coder',
        provider: 'ollama',
        contextMax: 16384,
        capabilities: ['coding'],
        toolCalling: true,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      models.upsertInstance({
        id: 'model-qwen-coder::local-mac::rt-ollama',
        modelId: 'model-qwen-coder',
        computerId: 'local-mac',
        runtimeId: 'rt-ollama',
        runtimeModelId: 'model-qwen-coder',
        loaded: false,
        health: 'healthy',
      });

      // Register Model B (e.g. specialized reviewer)
      models.register({
        id: 'model-deepseek-reviewer',
        name: 'DeepSeek Reviewer',
        provider: 'ollama',
        contextMax: 16384,
        capabilities: ['review'],
        toolCalling: true,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      models.upsertInstance({
        id: 'model-deepseek-reviewer::local-mac::rt-ollama',
        modelId: 'model-deepseek-reviewer',
        computerId: 'local-mac',
        runtimeId: 'rt-ollama',
        runtimeModelId: 'model-deepseek-reviewer',
        loaded: false,
        health: 'healthy',
      });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });

      // Task 1: coder pinned to Model A
      const task1: Task = {
        id: 'task-1-code',
        type: 'coding',
        input: 'Write binary search',
        requirements: { capabilities: ['coding'] },
        execution: { targetModelId: 'model-qwen-coder', targetAgentId: 'coder' },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };
      const plan1 = scheduler.plan({ task: task1 });
      expect(plan1.agentId).toBe('coder');
      expect(plan1.modelId).toBe('model-qwen-coder');
      expect(plan1.modelDecision.strategy).toBe('explicit');

      const rec1 = await executions.create({
        task: task1,
        agentId: 'coder',
        computerId: plan1.computerId,
        runtimeId: plan1.runtimeId,
        modelId: plan1.modelId,
        scheduling: plan1,
      });

      // Task 2: reviewer pinned to Model B
      const task2: Task = {
        id: 'task-2-review',
        type: 'review',
        input: 'Review binary search code',
        requirements: { capabilities: ['review'] },
        execution: { targetModelId: 'model-deepseek-reviewer', targetAgentId: 'reviewer' },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };
      const plan2 = scheduler.plan({ task: task2 });
      expect(plan2.agentId).toBe('reviewer');
      expect(plan2.modelId).toBe('model-deepseek-reviewer');
      expect(plan2.modelDecision.strategy).toBe('explicit');

      const rec2 = await executions.create({
        task: task2,
        agentId: 'reviewer',
        computerId: plan2.computerId,
        runtimeId: plan2.runtimeId,
        modelId: plan2.modelId,
        scheduling: plan2,
      });

      // Inspect persisted execution records
      expect(rec1.execution.modelId).toBe('model-qwen-coder');
      expect(rec2.execution.modelId).toBe('model-deepseek-reviewer');
      expect(rec1.execution.agentId).toBe('coder');
      expect(rec2.execution.agentId).toBe('reviewer');
    });

    it('throws SchedulingError when pinning a model not registered on any computer without dangling executions', async () => {
      const { computers, runtimes, models, agents } = setupHarness();

      // Register a base model so registry is non-empty
      models.register({
        id: 'base-model',
        name: 'Base Model',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['coding'],
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      models.upsertInstance({
        id: 'base-model::local-mac::rt-ollama',
        modelId: 'base-model',
        computerId: 'local-mac',
        runtimeId: 'rt-ollama',
        runtimeModelId: 'base-model',
        loaded: false,
        health: 'healthy',
      });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });

      const task: Task = {
        id: 'task-invalid-model-pin',
        type: 'coding',
        input: 'Pin unknown model',
        requirements: {},
        execution: { targetModelId: 'ghost-model', targetAgentId: 'coder' },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      expect(() => scheduler.plan({ task })).toThrow(SchedulingError);
      try {
        scheduler.plan({ task });
      } catch (err: any) {
        expect(err).toBeInstanceOf(SchedulingError);
        expect(err.message).toContain("model 'ghost-model' is not registered");
        expect(err.message).toContain('No silent fallback will be performed');
      }
    });
  });

  describe('Section 10: Concurrent & Cross-Computer Placement', () => {
    it('Single Machine: schedules back-to-back different models without concurrent residency awareness (F1/F4 gap)', () => {
      const { computers, runtimes, models, agents } = setupHarness();

      // Register two models that both fit minSystemGB individually (8GB each)
      for (const id of ['model-x', 'model-y']) {
        models.register({
          id,
          name: id,
          provider: 'ollama',
          contextMax: 8192,
          capabilities: ['coding'],
          toolCalling: false,
          structuredOutput: false,
          vision: false,
          audio: false,
          embedding: false,
          reasoning: false,
          memory: { minSystemGB: 8 },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        models.upsertInstance({
          id: `${id}::local-mac::rt-ollama`,
          modelId: id,
          computerId: 'local-mac',
          runtimeId: 'rt-ollama',
          runtimeModelId: id,
          loaded: false,
          health: 'healthy',
        });
      }

      const scheduler = new Scheduler({ computers, runtimes, models, agents });

      // Task X and Task Y both land on local-mac without Wazir tracking concurrent model residency
      const planX = scheduler.plan({
        task: {
          id: 'task-x',
          type: 'coding',
          input: 'Run model X',
          requirements: {},
          execution: { targetModelId: 'model-x' },
          priority: 'normal',
          status: 'pending',
          createdAt: new Date(),
        },
      });
      const planY = scheduler.plan({
        task: {
          id: 'task-y',
          type: 'coding',
          input: 'Run model Y',
          requirements: {},
          execution: { targetModelId: 'model-y' },
          priority: 'normal',
          status: 'pending',
          createdAt: new Date(),
        },
      });

      expect(planX.computerId).toBe('local-mac');
      expect(planY.computerId).toBe('local-mac');
      // Both instances are loaded: false (F1) and scheduled purely on static memory limits (F4)
      expect(planX.computerDecision.reasons).toContain("model will be loaded via 'rt-ollama'");
      expect(planY.computerDecision.reasons).toContain("model will be loaded via 'rt-ollama'");
    });

    it('Cross-Computer: routes to remote computer B when model is only registered there', () => {
      const { computers, runtimes, models, agents } = setupHarness();

      // Register Remote Computer B
      computers.register({
        id: 'remote-server-b',
        name: 'Remote GPU Server',
        local: false,
        health: 'healthy',
        hardware: { cpus: 32, memoryGB: 128 },
      });
      runtimes.register({
        id: 'rt-remote-ollama',
        type: 'ollama',
        name: 'Ollama Remote',
        computerId: 'remote-server-b',
        version: '0.3',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });

      // Exclusive remote model
      models.register({
        id: 'remote-exclusive-70b',
        name: '70B Remote Model',
        provider: 'ollama',
        contextMax: 32768,
        capabilities: ['coding'],
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      models.upsertInstance({
        id: 'remote-exclusive-70b::remote-server-b::rt-remote-ollama',
        modelId: 'remote-exclusive-70b',
        computerId: 'remote-server-b',
        runtimeId: 'rt-remote-ollama',
        runtimeModelId: 'remote-exclusive-70b',
        loaded: false,
        health: 'healthy',
      });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });

      const plan = scheduler.plan({
        task: {
          id: 'task-remote',
          type: 'coding',
          input: 'Do 70B task',
          requirements: {},
          execution: { targetModelId: 'remote-exclusive-70b' },
          priority: 'normal',
          status: 'pending',
          createdAt: new Date(),
        },
      });

      // Placed on remote computer B
      expect(plan.computerId).toBe('remote-server-b');
      expect(plan.runtimeId).toBe('rt-remote-ollama');
    });

    it('throws SchedulingError with clear failure when remote model instance is deregistered', () => {
      const { computers, runtimes, models, agents } = setupHarness();

      models.register({
        id: 'orphaned-model',
        name: 'Orphaned',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['coding'],
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      // Do NOT register any instance on any computer!

      const scheduler = new Scheduler({ computers, runtimes, models, agents });

      try {
        scheduler.plan({
          task: {
            id: 'task-orphan',
            type: 'coding',
            input: 'Run orphaned model',
            requirements: {},
            execution: { targetModelId: 'orphaned-model' },
            priority: 'normal',
            status: 'pending',
            createdAt: new Date(),
          },
        });
        expect.unreachable('Should have thrown SchedulingError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SchedulingError);
        expect(err.message).toContain("no running instance on any computer");
        expect(err.message).toContain("No silent fallback will be performed");
      }
    });
  });
});
