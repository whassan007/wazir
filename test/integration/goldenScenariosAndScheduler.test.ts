import { describe, it, expect } from 'vitest';
import {
  Scheduler,
  ComputerRegistry,
  RuntimeRegistry,
  ModelRegistry,
  AgentRegistry,
  ContextCompiler,
  ExecutionEngine,
  JobOrchestrator,
  type Task,
  type ContextPart,
} from '@wazir/core';
import { ExternalAgentAdapter } from '@wazir/agents';
import { explainCommand } from '../../apps/cli/src/commands.js';
import type { RookEngine } from '../../apps/cli/src/engine.js';

describe('Sections 7 & 19: Scheduler Invariants, Explainability & Golden Scenarios', () => {
  function setupTestEnvironment() {
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();
    const agents = new AgentRegistry();
    const compiler = new ContextCompiler();

    // 1. Local computer (32 GB RAM)
    computers.register({
      id: 'local-workstation',
      name: 'Local Workstation',
      type: 'workstation',
      local: true,
      os: { platform: 'linux', architecture: 'x64', version: '6.0' },
      hardware: { cpu: 'Ryzen 9', cpuCores: 16, memoryGB: 32 },
      capabilities: ['localExecution', 'gpu'],
    });

    // 2. Weak remote computer (4 GB RAM)
    computers.register({
      id: 'weak-worker',
      name: 'Weak Remote Worker',
      type: 'remote-worker',
      local: false,
      os: { platform: 'linux', architecture: 'x64', version: '6.0' },
      hardware: { cpu: 'Atom', cpuCores: 2, memoryGB: 4 },
      capabilities: [],
    });

    // Runtimes
    runtimes.register({
      id: 'rt-local',
      type: 'ollama',
      name: 'Local Ollama',
      version: '1.0',
      computerId: 'local-workstation',
      capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false, embeddings: false, reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false },
    });
    runtimes.register({
      id: 'rt-weak',
      type: 'ollama',
      name: 'Weak Ollama',
      version: '1.0',
      computerId: 'weak-worker',
      capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false, embeddings: false, reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false },
    });

    // Models
    models.register({
      id: 'qwen2.5-coder:7b',
      name: 'Qwen 2.5 Coder 7B',
      provider: 'ollama',
      family: 'qwen',
      contextMax: 32768,
      capabilities: ['coding', 'generalChat'],
      toolCalling: true,
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
      id: 'qwen-local',
      modelId: 'qwen2.5-coder:7b',
      computerId: 'local-workstation',
      runtimeId: 'rt-local',
      runtimeModelId: 'qwen2.5-coder:7b',
      loaded: true,
      health: 'healthy',
      contextTokens: 32768,
    });
    models.upsertInstance({
      id: 'qwen-weak',
      modelId: 'qwen2.5-coder:7b',
      computerId: 'weak-worker',
      runtimeId: 'rt-weak',
      runtimeModelId: 'qwen2.5-coder:7b',
      loaded: true,
      health: 'healthy',
      contextTokens: 32768,
    });

    // Agents
    agents.register(
      {
        descriptor: {
          name: 'coder',
          version: '1.0',
          description: 'Primary coding agent',
          capabilities: ['coding'],
          requiredTools: [],
          modelRequirements: { capabilities: ['coding'] },
          permissions: [],
          taskTypes: ['coding'],
          strategy: 'test',
        },
        async *run() {
          yield { kind: 'done', content: 'done' };
        },
      },
      'native',
    );

    agents.register(
      new ExternalAgentAdapter({
        name: 'opencode',
        version: 'external',
        description: 'OpenCode external CLI',
        command: 'opencode',
        args: ['run'],
        taskTypes: [], // isolated from automatic routing
        capabilities: ['coding'],
      }),
      'external',
    );

    const scheduler = new Scheduler({ computers, runtimes, models, agents });
    return { computers, runtimes, models, agents, scheduler, compiler };
  }

  describe('Section 7: Scheduler Invariants', () => {
    it('under-resourced computer is never selected for high-requirement tasks', () => {
      const { scheduler } = setupTestEnvironment();

      const taskRequiringHighMemory: Task = {
        id: 'task-heavy-ram',
        type: 'coding',
        title: 'High RAM Task',
        input: 'Compile huge project',
        requirements: {
          capabilities: ['coding'],
          reasoning: 'low',
          vision: false,
          toolCalling: false,
          minimumContext: 1024,
          minimumMemoryGB: 16, // Weak worker has only 4GB!
          minimumGPUMemoryGB: 0,
          localOnly: false,
        },
        execution: { executionMode: 'automatic' },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const decision = scheduler.plan({ task: taskRequiringHighMemory });
      expect(decision.computerId).toBe('local-workstation');
      expect(decision.computerId).not.toBe('weak-worker');
    });

    it('determinism: same registries + same task + same policy yields identical decision across 20 repeated runs', () => {
      const { scheduler } = setupTestEnvironment();

      const task: Task = {
        id: 'task-deterministic',
        type: 'coding',
        title: 'Deterministic scheduling test',
        input: 'Run test',
        requirements: {
          capabilities: ['coding'],
          reasoning: 'low',
          vision: false,
          toolCalling: false,
          minimumContext: 4096,
          minimumMemoryGB: 8,
          minimumGPUMemoryGB: 0,
          localOnly: false,
        },
        execution: { executionMode: 'automatic' },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const baseline = scheduler.plan({ task });

      for (let i = 0; i < 20; i++) {
        const next = scheduler.plan({ task });
        expect(next.computerId).toBe(baseline.computerId);
        expect(next.modelId).toBe(baseline.modelId);
        expect(next.runtimeId).toBe(baseline.runtimeId);
        expect(next.agentId).toBe(baseline.agentId);
      }
    });

    it('context-budget rejection: task requiring more context than model supports rejects before execution', () => {
      const { scheduler, compiler } = setupTestEnvironment();

      // 1. Context budget rejection at Scheduler level
      const oversizedTask: Task = {
        id: 'task-giant-context',
        type: 'coding',
        title: 'Oversized Task',
        input: 'Read entire codebase',
        requirements: {
          capabilities: ['coding'],
          reasoning: 'low',
          vision: false,
          toolCalling: false,
          minimumContext: 128_000, // Model max is 32,768!
          minimumMemoryGB: 4,
          minimumGPUMemoryGB: 0,
          localOnly: false,
        },
        execution: { executionMode: 'automatic' },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Scheduler must throw SchedulingError before dispatch
      expect(() => scheduler.plan({ task: oversizedTask })).toThrow(/No model satisfies the task requirements/);

      // 2. Context budget rejection at ContextCompiler level
      const giantPart: ContextPart = {
        kind: 'task',
        priority: 'critical',
        content: 'x'.repeat(200_000), // ~50,000 tokens
        label: 'Huge input',
      };
      const compilation = compiler.compile([giantPart], { tokens: 32768, source: 'model' }, 4096);
      expect(compilation.fits).toBe(false);
      expect(compilation.reasons.some((r) => r.includes('over budget'))).toBe(true);
    });

    it('explainability: scheduling decision is reconstructable with selected computer/model/agent and concrete reasons', async () => {
      const env = setupTestEnvironment();
      const executions = new ExecutionEngine();
      const orchestrator = new JobOrchestrator({
        scheduler: env.scheduler,
        executionEngine: executions,
        computers: env.computers,
        runtimes: env.runtimes,
        models: env.models,
        agents: env.agents,
        taskExecutor: async () => ({ success: true, result: 'done' }),
      });

      const job = await orchestrator.createJob({
        title: 'Explainable Job',
        tasks: [{ task: { id: 't-explain', type: 'coding', input: 'Explain this task' } }],
      });

      await orchestrator.runJob(job.id);

      const mockEngine: any = {
        computers: env.computers,
        runtimes: env.runtimes,
        models: env.models,
        agents: env.agents,
        executions,
        orchestrator,
        store: {} as any,
      };

      // Call explainCommand against the job
      const explainResult = await explainCommand(mockEngine as RookEngine, `@job:${job.id}`, false);

      expect(explainResult.code).toBe(0);
      expect(explainResult.output).toContain('JOB:');
      expect(explainResult.output).toContain('qwen2.5-coder:7b');
      expect(explainResult.output).toContain('local-workstation');
      expect(explainResult.output).toContain('coder');

      // JSON format explanation
      const jsonExplain = await explainCommand(mockEngine as RookEngine, `@job:${job.id}`, true);
      expect(jsonExplain.code).toBe(0);
      const parsed = JSON.parse(jsonExplain.output);
      expect(parsed.jobId).toBe(job.id);
      expect(parsed.tasks[0].executions[0].scheduling.modelId).toBe('qwen2.5-coder:7b');
      expect(parsed.tasks[0].executions[0].scheduling.computerId).toBe('local-workstation');
      expect(parsed.tasks[0].executions[0].scheduling.agentId).toBe('coder');
      expect(parsed.tasks[0].executions[0].scheduling.reasons.length).toBeGreaterThan(0);
    });
  });

  describe('Section 19: Golden Scenarios', () => {
    it('Golden Scenario: coding_task_local_only', () => {
      const { scheduler } = setupTestEnvironment();

      const task: Task = {
        id: 'scenario-local-code',
        type: 'coding',
        title: 'Local Only Coding Task',
        input: 'Implement local feature',
        requirements: {
          capabilities: ['coding'],
          reasoning: 'low',
          vision: false,
          toolCalling: false,
          minimumContext: 2048,
          minimumMemoryGB: 4,
          minimumGPUMemoryGB: 0,
          localOnly: true, // Must be scheduled ONLY on local computer!
        },
        execution: { executionMode: 'automatic' },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const decision = scheduler.plan({ task });

      // Baseline assertions
      expect(decision.agentId).toBe('coder');
      expect(decision.computerId).toBe('local-workstation');
      expect(decision.modelId).toBe('qwen2.5-coder:7b');
      expect(decision.reasons.some((r) => r.includes('local computer'))).toBe(true);
    });

    it('Golden Scenario: opencode_never_auto_routed', () => {
      const { scheduler } = setupTestEnvironment();

      // Unpinned coding task that opencode could theoretically execute
      const task: Task = {
        id: 'scenario-opencode-isolation',
        type: 'coding',
        title: 'Unpinned Coding Task with Multiple Available Agents',
        input: 'Refactor module',
        requirements: {
          capabilities: ['coding'],
          reasoning: 'low',
          vision: false,
          toolCalling: false,
          minimumContext: 2048,
          minimumMemoryGB: 4,
          minimumGPUMemoryGB: 0,
          localOnly: false,
        },
        execution: { executionMode: 'automatic' },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const decision = scheduler.plan({ task });

      // Baseline assertion: NEVER routes to opencode automatically
      expect(decision.agentId).toBe('coder');
      expect(decision.agentId).not.toBe('opencode');
    });
  });
});
