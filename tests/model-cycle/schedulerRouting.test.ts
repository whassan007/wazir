import { describe, it, expect } from 'vitest';
import {
  Scheduler,
  SchedulingError,
  ModelRegistry,
  ComputerRegistry,
  RuntimeRegistry,
  AgentRegistry,
  type Task,
  type ModelRecord,
  type Computer,
} from '@wazir/core';

function createRegistries() {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();

  agents.register(
    {
      descriptor: {
        name: 'default-coder',
        version: '1.0',
        description: 'Coder agent',
        capabilities: ['coding'],
        requiredTools: [],
        modelRequirements: { capabilities: ['coding'] },
        permissions: [],
        taskTypes: ['coding'],
        strategy: 'test',
      },
      async *run() {
        yield { kind: 'done', content: 'ok' };
      },
    },
    'native',
  );

  return { computers, runtimes, models, agents };
}

describe('Section 4 & 5: Model & Computer Routing (model_cycle.md)', () => {
  describe('Section 4: Model Routing (routeModel / scoreModel)', () => {
    it('Capability rejection: throws SchedulingError naming every rejected model and specific reason', () => {
      const { computers, runtimes, models, agents } = createRegistries();

      computers.register({
        id: 'comp-1',
        name: 'Worker 1',
        local: true,
        health: 'healthy',
        hardware: { cpus: 8, memoryGB: 32 },
      });
      runtimes.register({
        id: 'rt-1',
        type: 'ollama',
        name: 'Ollama',
        computerId: 'comp-1',
        version: '0.3',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      models.register({
        id: 'model-no-vision',
        name: 'No Vision',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['generalChat'],
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
        id: 'model-no-vision::comp-1::rt-1',
        modelId: 'model-no-vision',
        computerId: 'comp-1',
        runtimeId: 'rt-1',
        runtimeModelId: 'model-no-vision',
        loaded: false,
        health: 'healthy',
      });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });
      const task: Task = {
        id: 'task-vision',
        type: 'coding',
        input: 'Analyze UI image',
        requirements: { capabilities: ['generalChat'], vision: true },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      expect(() => scheduler.plan({ task })).toThrow(SchedulingError);
      try {
        scheduler.plan({ task });
      } catch (err: any) {
        expect(err).toBeInstanceOf(SchedulingError);
        expect(err.message).toContain('No model satisfies');
        // Specific rejection reason named
        expect(err.modelReasons.some((r: string) => r.includes('model-no-vision') && r.includes('vision: required but unsupported'))).toBe(true);
      }
    });

    it('Context ceiling rejection: rejects when requiredContextTokens exceeds effectiveContextTokens', () => {
      const { computers, runtimes, models, agents } = createRegistries();

      computers.register({
        id: 'comp-1',
        name: 'Worker 1',
        local: true,
        health: 'healthy',
        hardware: { cpus: 8, memoryGB: 32 },
      });
      runtimes.register({
        id: 'rt-1',
        type: 'ollama',
        name: 'Ollama',
        computerId: 'comp-1',
        version: '0.3',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      models.register({
        id: 'model-8k',
        name: 'Model 8K',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['generalChat'],
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
        id: 'model-8k::comp-1::rt-1',
        modelId: 'model-8k',
        computerId: 'comp-1',
        runtimeId: 'rt-1',
        runtimeModelId: 'model-8k',
        loaded: false,
        health: 'healthy',
      });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });
      const task: Task = {
        id: 'task-large-context',
        type: 'coding',
        input: 'Large repository analysis',
        requirements: { minimumContext: 16384 },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      try {
        scheduler.plan({ task });
        expect.unreachable('Should have thrown SchedulingError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SchedulingError);
        // Literal reason substring from scheduler.ts:184
        expect(err.modelReasons.some((r: string) => r.includes('context 8192 < required 16384'))).toBe(true);
      }
    });

    it('Explicit pin: selects pinned model with strategy explicit; ineligible pin throws with NO silent fallback', () => {
      const { computers, runtimes, models, agents } = createRegistries();

      computers.register({
        id: 'comp-1',
        name: 'Worker 1',
        local: true,
        health: 'healthy',
        hardware: { cpus: 8, memoryGB: 32 },
      });
      runtimes.register({
        id: 'rt-1',
        type: 'ollama',
        name: 'Ollama',
        computerId: 'comp-1',
        version: '0.3',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      models.register({
        id: 'pinned-model',
        name: 'Pinned Model',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['generalChat'],
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
        id: 'pinned-model::comp-1::rt-1',
        modelId: 'pinned-model',
        computerId: 'comp-1',
        runtimeId: 'rt-1',
        runtimeModelId: 'pinned-model',
        loaded: false,
        health: 'healthy',
      });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });

      // 1. Eligible pin
      const validPlan = scheduler.plan({
        task: {
          id: 'task-pin',
          type: 'coding',
          input: 'test',
          requirements: {},
          execution: { targetModelId: 'pinned-model' },
          priority: 'normal',
          status: 'pending',
          createdAt: new Date(),
        },
      });
      expect(validPlan.modelId).toBe('pinned-model');
      expect(validPlan.modelDecision.strategy).toBe('explicit');

      // 2. Ineligible pin: pinned model lacks required capability
      expect(() =>
        scheduler.plan({
          task: {
            id: 'task-ineligible-pin',
            type: 'coding',
            input: 'test',
            requirements: { vision: true },
            execution: { targetModelId: 'pinned-model' },
            priority: 'normal',
            status: 'pending',
            createdAt: new Date(),
          },
        }),
      ).toThrow(SchedulingError);

      // 3. Nonexistent pin: must throw with NO silent fallback
      try {
        scheduler.plan({
          task: {
            id: 'task-missing-pin',
            type: 'coding',
            input: 'test',
            requirements: {},
            execution: { targetModelId: 'does-not-exist' },
            priority: 'normal',
            status: 'pending',
            createdAt: new Date(),
          },
        });
        expect.unreachable('Should have thrown SchedulingError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SchedulingError);
        expect(err.message).toContain("Requested model 'does-not-exist' is not eligible");
        expect(err.message).toContain('No silent fallback will be performed');
      }
    });

    it('Scoring order: 2x context headroom scores higher, ties broken lexicographically', () => {
      const { computers, runtimes, models, agents } = createRegistries();

      computers.register({
        id: 'comp-1',
        name: 'Worker 1',
        local: true,
        health: 'healthy',
        hardware: { cpus: 8, memoryGB: 32 },
      });
      runtimes.register({
        id: 'rt-1',
        type: 'ollama',
        name: 'Ollama',
        computerId: 'comp-1',
        version: '0.3',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });

      // Model A has 8K context (1.33x requirement)
      models.register({
        id: 'model-a',
        name: 'Model A',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['generalChat'],
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
        id: 'model-a::comp-1::rt-1',
        modelId: 'model-a',
        computerId: 'comp-1',
        runtimeId: 'rt-1',
        runtimeModelId: 'model-a',
        loaded: false,
        health: 'healthy',
      });

      // Model B has 32K context (5.3x requirement, >= 2x headroom bonus)
      models.register({
        id: 'model-b',
        name: 'Model B',
        provider: 'ollama',
        contextMax: 32768,
        capabilities: ['generalChat'],
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
        id: 'model-b::comp-1::rt-1',
        modelId: 'model-b',
        computerId: 'comp-1',
        runtimeId: 'rt-1',
        runtimeModelId: 'model-b',
        loaded: false,
        health: 'healthy',
      });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });
      const plan = scheduler.plan({
        task: {
          id: 'task-headroom',
          type: 'coding',
          input: 'test',
          requirements: { minimumContext: 6000 },
          priority: 'normal',
          status: 'pending',
          createdAt: new Date(),
        },
      });

      // Model B wins due to context headroom bonus (+1)
      expect(plan.modelId).toBe('model-b');
      expect(plan.modelDecision.reasons).toContain('context headroom: at least 2x the requirement');
    });

    it('F1 Interaction Test: +2 bonus fires when instance has loaded: true, health: healthy', () => {
      const { computers, runtimes, models, agents } = createRegistries();

      computers.register({
        id: 'comp-1',
        name: 'Worker 1',
        local: true,
        health: 'healthy',
        hardware: { cpus: 8, memoryGB: 32 },
      });
      runtimes.register({
        id: 'rt-1',
        type: 'ollama',
        name: 'Ollama',
        computerId: 'comp-1',
        version: '0.3',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });

      // Model 1 not loaded
      models.register({
        id: 'model-cold',
        name: 'Cold Model',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['generalChat'],
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
        id: 'model-cold::comp-1::rt-1',
        modelId: 'model-cold',
        computerId: 'comp-1',
        runtimeId: 'rt-1',
        runtimeModelId: 'model-cold',
        loaded: false,
        health: 'healthy',
      });

      // Model 2 manually marked loaded: true
      models.register({
        id: 'model-warm',
        name: 'Warm Model',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['generalChat'],
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
        id: 'model-warm::comp-1::rt-1',
        modelId: 'model-warm',
        computerId: 'comp-1',
        runtimeId: 'rt-1',
        runtimeModelId: 'model-warm',
        loaded: true,
        health: 'healthy',
      });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });
      const plan = scheduler.plan({
        task: {
          id: 'task-loaded-bonus',
          type: 'coding',
          input: 'test',
          requirements: {},
          priority: 'normal',
          status: 'pending',
          createdAt: new Date(),
        },
      });

      // Model warm wins scoring (+2 bonus)
      expect(plan.modelId).toBe('model-warm');
      expect(plan.modelDecision.reasons.some((r) => r.includes("already loaded"))).toBe(true);
    });
  });

  describe('Section 5: Computer Routing (scheduleComputer)', () => {
    it('Memory shortfall: under-resourced computer is rejected with exact GB shortfall', () => {
      const { computers, runtimes, models, agents } = createRegistries();

      // Computer has 4GB RAM
      computers.register({
        id: 'tiny-comp',
        name: 'Tiny Worker',
        local: true,
        health: 'healthy',
        hardware: { cpus: 2, memoryGB: 4 },
      });
      runtimes.register({
        id: 'rt-tiny',
        type: 'ollama',
        name: 'Ollama',
        computerId: 'tiny-comp',
        version: '0.3',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });

      // Model requires 16GB RAM
      models.register({
        id: 'heavy-model',
        name: 'Heavy Model',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['generalChat'],
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        memory: { minSystemGB: 16 },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      models.upsertInstance({
        id: 'heavy-model::tiny-comp::rt-tiny',
        modelId: 'heavy-model',
        computerId: 'tiny-comp',
        runtimeId: 'rt-tiny',
        runtimeModelId: 'heavy-model',
        loaded: false,
        health: 'healthy',
      });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });

      try {
        scheduler.plan({
          task: {
            id: 'task-mem-shortfall',
            type: 'coding',
            input: 'test',
            requirements: {},
            priority: 'normal',
            status: 'pending',
            createdAt: new Date(),
          },
        });
        expect.unreachable('Should have thrown SchedulingError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SchedulingError);
        // Literal reason from scheduler.ts:273
        expect(err.computerReasons).toContain('tiny-comp: memory 4GB < required 16GB');
      }
    });

    it('Policy filters: allowedComputers, localOnly, allowedRuntimes exclude non-matching computers completely', () => {
      const { computers, runtimes, models, agents } = createRegistries();

      computers.register({
        id: 'local-box',
        name: 'Local Host',
        local: true,
        health: 'healthy',
        hardware: { cpus: 8, memoryGB: 32 },
      });
      computers.register({
        id: 'remote-box',
        name: 'Remote Worker',
        local: false,
        health: 'healthy',
        hardware: { cpus: 16, memoryGB: 64 },
      });

      runtimes.register({
        id: 'rt-local',
        type: 'ollama',
        name: 'Ollama',
        computerId: 'local-box',
        version: '0.3',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      runtimes.register({
        id: 'rt-remote',
        type: 'lmstudio',
        name: 'LM Studio',
        computerId: 'remote-box',
        version: '0.3',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });

      models.register({
        id: 'shared-model',
        name: 'Shared Model',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['generalChat'],
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
        id: 'shared-model::local-box::rt-local',
        modelId: 'shared-model',
        computerId: 'local-box',
        runtimeId: 'rt-local',
        runtimeModelId: 'shared-model',
        loaded: false,
        health: 'healthy',
      });
      models.upsertInstance({
        id: 'shared-model::remote-box::rt-remote',
        modelId: 'shared-model',
        computerId: 'remote-box',
        runtimeId: 'rt-remote',
        runtimeModelId: 'shared-model',
        loaded: false,
        health: 'healthy',
      });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });

      // 1. localOnly policy
      const localPlan = scheduler.plan({
        task: {
          id: 'task-local',
          type: 'coding',
          input: 'test',
          requirements: {},
          policy: { localOnly: true },
          priority: 'normal',
          status: 'pending',
          createdAt: new Date(),
        },
      });
      expect(localPlan.computerId).toBe('local-box');

      // 2. allowedComputers filter
      const remotePinPlan = scheduler.plan({
        task: {
          id: 'task-pin-comp',
          type: 'coding',
          input: 'test',
          requirements: {},
          policy: { allowedComputers: ['remote-box'] },
          priority: 'normal',
          status: 'pending',
          createdAt: new Date(),
        },
      });
      expect(remotePinPlan.computerId).toBe('remote-box');

      // 3. allowedRuntimes filter
      const runtimePinPlan = scheduler.plan({
        task: {
          id: 'task-pin-rt',
          type: 'coding',
          input: 'test',
          requirements: {},
          policy: { allowedRuntimes: ['rt-remote'] },
          priority: 'normal',
          status: 'pending',
          createdAt: new Date(),
        },
      });
      expect(runtimePinPlan.computerId).toBe('remote-box');
      expect(runtimePinPlan.runtimeId).toBe('rt-remote');
    });

    it('Health gates: unavailable runtime or instance excludes placement with specific failure reason', () => {
      const { computers, runtimes, models, agents } = createRegistries();

      computers.register({
        id: 'comp-down',
        name: 'Down Worker',
        local: true,
        health: 'healthy',
        hardware: { cpus: 8, memoryGB: 32 },
      });
      runtimes.register({
        id: 'rt-down',
        type: 'ollama',
        name: 'Ollama',
        computerId: 'comp-down',
        version: '0.3',
        health: 'unavailable',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      models.register({
        id: 'model-down',
        name: 'Model Down',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['generalChat'],
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
        id: 'model-down::comp-down::rt-down',
        modelId: 'model-down',
        computerId: 'comp-down',
        runtimeId: 'rt-down',
        runtimeModelId: 'model-down',
        loaded: false,
        health: 'healthy',
      });
      runtimes.update('rt-down', { health: 'unavailable' });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });

      try {
        scheduler.plan({
          task: {
            id: 'task-health-gate',
            type: 'coding',
            input: 'test',
            requirements: {},
            priority: 'normal',
            status: 'pending',
            createdAt: new Date(),
          },
        });
        expect.unreachable('Should have thrown SchedulingError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SchedulingError);
        expect(err.computerReasons).toContain("comp-down: runtime 'rt-down' is unavailable");
      }
    });

    it('Determinism property test: 20 consecutive runs yield identical computerId', () => {
      const { computers, runtimes, models, agents } = createRegistries();

      // Register two tied computers
      for (const id of ['comp-alpha', 'comp-beta']) {
        computers.register({
          id,
          name: id,
          local: false,
          health: 'healthy',
          hardware: { cpus: 8, memoryGB: 32 },
          load: { cpuPercent: 10 },
        });
        runtimes.register({
          id: `rt-${id}`,
          type: 'ollama',
          name: 'Ollama',
          computerId: id,
          version: '0.3',
          health: 'healthy',
          capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
        });
        models.upsertInstance({
          id: `det-model::${id}::rt-${id}`,
          modelId: 'det-model',
          computerId: id,
          runtimeId: `rt-${id}`,
          runtimeModelId: 'det-model',
          loaded: false,
          health: 'healthy',
        });
      }

      models.register({
        id: 'det-model',
        name: 'Det Model',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['generalChat'],
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });
      const task: Task = {
        id: 'task-determinism',
        type: 'coding',
        input: 'test',
        requirements: {},
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const results = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const plan = scheduler.plan({ task });
        results.add(plan.computerId);
      }

      expect(results.size).toBe(1);
      // Lexicographic tie-breaker picks comp-alpha
      expect(Array.from(results)[0]).toBe('comp-alpha');
    });

    it('Section 0 / F4 Interaction Gap Test: Scheduler ignores live memoryAvailableGB under concurrent pressure', () => {
      const { computers, runtimes, models, agents } = createRegistries();

      // Computer total RAM is 16GB, but available is only 1GB (severe pressure)
      computers.register({
        id: 'pressured-box',
        name: 'Pressured Box',
        local: true,
        health: 'healthy',
        hardware: { cpus: 8, memoryGB: 16 },
        load: {
          cpuPercent: 5,
          memoryAvailableGB: 1, // Only 1GB free!
        } as any,
      });

      runtimes.register({
        id: 'rt-p',
        type: 'ollama',
        name: 'Ollama',
        computerId: 'pressured-box',
        version: '0.3',
        health: 'healthy',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });

      models.register({
        id: 'model-needs-8gb',
        name: 'Model 8GB',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['generalChat'],
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
        id: 'model-needs-8gb::pressured-box::rt-p',
        modelId: 'model-needs-8gb',
        computerId: 'pressured-box',
        runtimeId: 'rt-p',
        runtimeModelId: 'model-needs-8gb',
        loaded: false,
        health: 'healthy',
      });

      const scheduler = new Scheduler({ computers, runtimes, models, agents });

      // Tracked Gap F4: Scheduler checks computer.hardware.memoryGB (16GB), NOT memoryAvailableGB (1GB)
      // So it places the job successfully even though the host has insufficient available RAM
      const plan = scheduler.plan({
        task: {
          id: 'task-oom-risk',
          type: 'coding',
          input: 'test',
          requirements: {},
          priority: 'normal',
          status: 'pending',
          createdAt: new Date(),
        },
      });

      expect(plan.computerId).toBe('pressured-box');
    });
  });
});
