import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Scheduler,
  SchedulingError,
  ModelRegistry,
  ComputerRegistry,
  RuntimeRegistry,
  AgentRegistry,
  ExecutionEngine,
  PolicyEngine,
  JobManager,
  JobOrchestrator,
  type Task,
  type ExecutionRecord,
  type Job,
} from '@wazir/core';
import { MemoryStore } from '@wazir/shared';
import { evaluateExecution } from '@wazir/evaluation';

describe('Section 11, 12, 13, 14: Lifecycle, Failures, Explainability & Metrics (model_cycle.md)', () => {
  let tmpDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-cycle-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      tmpDir = undefined;
    }
  });

  function setupFullHarness() {
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();
    const agents = new AgentRegistry();
    const store = new MemoryStore();
    const policy = new PolicyEngine({ projectRoot: tmpDir! });
    const executions = new ExecutionEngine({
      persist: (record) => store.put(`execution/${record.execution.id}`, record),
      load: async () => {
        const entries = await store.list('execution/');
        return entries.map((e) => e.value as ExecutionRecord);
      },
    });

    computers.register({
      id: 'local-machine',
      name: 'Local Machine',
      local: true,
      health: 'healthy',
      hardware: { cpus: 8, memoryGB: 32 },
    });

    runtimes.register({
      id: 'fake-runtime',
      type: 'other',
      name: 'Fake Runtime',
      computerId: 'local-machine',
      version: '1.0.0',
      capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
    });

    models.register({
      id: 'coder-model',
      name: 'Coder Model',
      provider: 'fake-runtime',
      contextMax: 32768,
      capabilities: ['coding'],
      toolCalling: true,
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
      id: 'coder-model::local-machine::fake-runtime',
      modelId: 'coder-model',
      computerId: 'local-machine',
      runtimeId: 'fake-runtime',
      runtimeModelId: 'coder-model',
      loaded: false,
      health: 'healthy',
    });

    agents.register(
      {
        descriptor: {
          name: 'coder-agent',
          version: '1.0',
          description: 'Coder Agent',
          capabilities: ['coding'],
          requiredTools: ['write', 'test'],
          modelRequirements: {},
          permissions: [],
          taskTypes: ['coding'],
          strategy: 'test',
        },
        async *run(req, runtime) {
          yield { kind: 'plan', content: 'Step 1: Implement LRU Cache' };
          yield { kind: 'action', tool: 'write', input: { path: 'src/lru.ts', content: 'export class LRU {}' } };
          yield { kind: 'action', tool: 'test', input: { command: 'npm test' } };
          yield { kind: 'done', content: 'Implementation complete' };
        },
      },
      'native',
    );

    const scheduler = new Scheduler({ computers, runtimes, models, agents });

    const jobManager = new JobManager({
      persist: (job) => store.put(`job/${job.id}`, job),
      load: async () => {
        const entries = await store.list('job/');
        return entries.map((e) => e.value as Job);
      },
    });

    const orchestrator = new JobOrchestrator({
      scheduler,
      executionEngine: executions,
      policy,
      agents,
      models,
      runtimes,
      computers,
      jobManager,
      taskExecutor: async (task, ctx) => {
        return {
          success: true,
          result: 'done',
          usage: { input: 10, output: 20, total: 30 },
        };
      },
    });

    return { computers, runtimes, models, agents, store, policy, executions, scheduler, jobManager, orchestrator };
  }

  // =========================================================================
  // Section 11: End-to-End Task Lifecycle (Flagship Test)
  // =========================================================================
  describe('Section 11: End-to-End Task Lifecycle (Flagship Test)', () => {
    it('executes task through full pipeline and captures all required record fields', async () => {
      const { scheduler, executions } = setupFullHarness();

      const task: Task = {
        id: 'task-flagship-lru',
        type: 'coding',
        title: 'Create TypeScript LRU cache',
        input: 'Create a TypeScript implementation of an LRU cache with unit tests.',
        requirements: { capabilities: ['coding'], minimumContext: 8192 },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      // 1. Plan
      const scheduling = scheduler.plan({ task });
      expect(scheduling.modelId).toBe('coder-model');
      expect(scheduling.computerId).toBe('local-machine');
      expect(scheduling.runtimeId).toBe('fake-runtime');

      // 2. Create ExecutionRecord
      const record = await executions.create({
        task,
        agentId: 'coder-agent',
        computerId: scheduling.computerId,
        runtimeId: scheduling.runtimeId,
        modelId: scheduling.modelId,
        scheduling,
        context: {
          budget: { parts: [], inputTokens: 500, outputReserveTokens: 500, requiredTokens: 1000 },
          available: { tokens: 32768, source: 'model-context-max' },
          fits: true,
          finalParts: [],
          finalInputTokens: 500,
          finalRequiredTokens: 1000,
          compactions: [],
          reasons: ['fits within budget'],
        },
      });

      const execId = record.execution.id;

      // 3. Progress phases and events
      await executions.recordEvent(execId, 'generation.started', { modelId: 'coder-model' });
      await executions.recordToolCall(execId, {
        tool: 'write',
        input: { path: 'src/lru.ts' },
        ok: true,
        durationMs: 15,
        policyEffect: 'allow',
        policyRule: 'filesystem-project-allow',
      });
      await executions.recordCheck(execId, {
        name: 'test',
        ok: true,
        durationMs: 45,
        output: 'PASS src/lru.test.ts',
      });
      await executions.recordCheck(execId, {
        name: 'typecheck',
        ok: true,
        durationMs: 30,
        output: 'Found 0 errors.',
      });

      // 4. Update usage and files changed
      await executions.recordUsage(execId, { input: 450, output: 220, total: 670 });
      await executions.recordFilesChanged(execId, ['src/lru.ts', 'src/lru.test.ts']);

      // 5. Evaluate execution independently
      const currentRecord = (await executions.get(execId))!;
      const evaluation = evaluateExecution(currentRecord, {
        expectedFiles: ['src/lru.ts'],
      });
      expect(evaluation.success).toBe(true);

      await executions.setEvaluation(execId, evaluation);
      await executions.setStatus(execId, 'completed');

      // 6. Assert all Section 11 requirements from persisted record
      const finalRecord = await executions.get(execId);
      expect(finalRecord).toBeDefined();
      expect(finalRecord!.execution.status).toBe('completed');
      expect(finalRecord!.scheduling?.modelId).toBe('coder-model');
      expect(finalRecord!.scheduling?.runtimeId).toBe('fake-runtime');
      expect(finalRecord!.scheduling?.computerId).toBe('local-machine');
      expect(finalRecord!.context?.finalRequiredTokens).toBe(1000);
      expect(finalRecord!.context?.fits).toBe(true);
      expect(finalRecord!.filesChanged).toEqual(['src/lru.ts', 'src/lru.test.ts']);
      expect(finalRecord!.checks).toHaveLength(2);
      expect(finalRecord!.checks[0].ok).toBe(true);
      expect(finalRecord!.checks[1].ok).toBe(true);
      expect(finalRecord!.usage?.total).toBe(670);
      expect(finalRecord!.evaluation?.success).toBe(true);
    });

    it('bounded repair loop: failing checks produce evaluation.success false with failure output recorded', async () => {
      const { scheduler, executions } = setupFullHarness();

      const task: Task = {
        id: 'task-repair-fail',
        type: 'coding',
        title: 'Broken fixture task',
        input: 'Implement feature that has broken tests',
        requirements: { capabilities: ['coding'] },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const scheduling = scheduler.plan({ task });
      const record = await executions.create({
        task,
        agentId: 'coder-agent',
        computerId: scheduling.computerId,
        runtimeId: scheduling.runtimeId,
        modelId: scheduling.modelId,
        scheduling,
      });
      const execId = record.execution.id;

      // Simulate repair cycles reaching the limit with failing test check
      await executions.recordCheck(execId, {
        name: 'test',
        ok: false,
        durationMs: 80,
        output: 'FAIL: SyntaxError in src/lru.ts: Unexpected token',
      });

      const currentRecord = (await executions.get(execId))!;
      const evaluation = evaluateExecution(currentRecord);
      expect(evaluation.success).toBe(false);
      expect(evaluation.reasons.some((r) => r.includes('failed checks: test'))).toBe(true);

      await executions.setEvaluation(execId, evaluation);
      await executions.recordError(execId, evaluation.reasons.join('; '));
      await executions.setStatus(execId, 'failed');

      const finalRecord = await executions.get(execId);
      expect(finalRecord!.execution.status).toBe('failed');
      expect(finalRecord!.evaluation?.success).toBe(false);
      expect(finalRecord!.checks[0].output).toContain('SyntaxError');
    });
  });

  // =========================================================================
  // Section 12: Failure & Recovery Across the Model Cycle
  // =========================================================================
  describe('Section 12: Failure & Recovery Across the Model Cycle', () => {
    it('Runtime stopped before task run throws SchedulingError before any execution record is created', async () => {
      const { scheduler, runtimes, executions } = setupFullHarness();

      // Stop runtime
      runtimes.update('fake-runtime', { health: 'unavailable' });

      const task: Task = {
        id: 'task-pre-dispatch-failure',
        type: 'coding',
        input: 'Run task when runtime is down',
        requirements: { capabilities: ['coding'] },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      expect(() => scheduler.plan({ task })).toThrow(SchedulingError);

      // Verify no execution record was created
      const allExecs = await executions.list();
      expect(allExecs.some((e) => e.task.id === 'task-pre-dispatch-failure')).toBe(false);
    });

    it('Runtime failure mid-generation marks execution failed with recorded error', async () => {
      const { scheduler, executions } = setupFullHarness();

      const task: Task = {
        id: 'task-mid-stream-failure',
        type: 'coding',
        input: 'Task dying mid-stream',
        requirements: { capabilities: ['coding'] },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const plan = scheduler.plan({ task });
      const record = await executions.create({
        task,
        agentId: 'coder-agent',
        computerId: plan.computerId,
        runtimeId: plan.runtimeId,
        modelId: plan.modelId,
        scheduling: plan,
      });
      const execId = record.execution.id;

      // Injected crash
      await executions.recordError(execId, 'socket hang up mid-stream');
      await executions.setStatus(execId, 'failed');

      const failedRecord = await executions.get(execId);
      expect(failedRecord!.execution.status).toBe('failed');
      expect(failedRecord!.errors).toContain('socket hang up mid-stream');
    });

    it('Recovered execution after restart does NOT claim completed for unfinished work', async () => {
      const { scheduler, executions, store } = setupFullHarness();

      const task: Task = {
        id: 'task-crash-recovery',
        type: 'coding',
        input: 'Task running during crash',
        requirements: { capabilities: ['coding'] },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const plan = scheduler.plan({ task });
      const record = await executions.create({
        task,
        agentId: 'coder-agent',
        computerId: plan.computerId,
        runtimeId: plan.runtimeId,
        modelId: plan.modelId,
        scheduling: plan,
      });

      // Restart: reconstruct new ExecutionEngine on the same store
      const restoredExecutions = new ExecutionEngine({
        persist: (r) => store.put(`execution/${r.execution.id}`, r),
        load: async () => {
          const entries = await store.list('execution/');
          return entries.map((e) => e.value as ExecutionRecord);
        },
      });
      await restoredExecutions.ready;

      const restoredRecord = await restoredExecutions.get(record.execution.id);
      expect(restoredRecord).toBeDefined();
      // Must not falsely claim completed!
      expect(restoredRecord!.execution.status).not.toBe('completed');
    });

    it('Instance ID construction structurally prevents duplicate instances across reconnects', () => {
      const { models } = setupFullHarness();

      const modelId = 'coder-model';
      const computerId = 'local-machine';
      const runtimeId = 'fake-runtime';

      // Connect 1
      models.upsertInstance({
        id: `${modelId}::${computerId}::${runtimeId}`,
        modelId,
        computerId,
        runtimeId,
        runtimeModelId: modelId,
        loaded: false,
        health: 'healthy',
      });

      // Connect 2 (flaky reconnect)
      models.upsertInstance({
        id: `${modelId}::${computerId}::${runtimeId}`,
        modelId,
        computerId,
        runtimeId,
        runtimeModelId: modelId,
        loaded: false,
        health: 'healthy',
      });

      const instances = models.instancesOf(modelId);
      expect(instances).toHaveLength(1);
    });
  });

  // =========================================================================
  // Section 13 & 14: Explainability & Metrics Inventory
  // =========================================================================
  describe('Section 13 & 14: Explainability & Metrics Inventory', () => {
    it('Single execution explain names selected model, computer, runtime, and overall reasons', async () => {
      const { scheduler, executions } = setupFullHarness();

      const task: Task = {
        id: 'task-explain-test',
        type: 'coding',
        input: 'Build express router',
        requirements: { capabilities: ['coding'] },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const plan = scheduler.plan({ task });
      const record = await executions.create({
        task,
        agentId: 'coder-agent',
        computerId: plan.computerId,
        runtimeId: plan.runtimeId,
        modelId: plan.modelId,
        scheduling: plan,
      });

      const s = record.scheduling;
      expect(s).toBeDefined();
      expect(s?.modelId).toBe('coder-model');
      expect(s?.computerId).toBe('local-machine');
      expect(s?.runtimeId).toBe('fake-runtime');
      expect(s?.reasons.length).toBeGreaterThan(0);
      expect(s?.modelDecision.reasons.length).toBeGreaterThan(0);
      expect(s?.computerDecision.reasons.length).toBeGreaterThan(0);

      // Documented UX debt: modelDecision/computerDecision records reasons for the winner,
      // while rejected candidate details are retained at scheduling time but not rolled into winner's decision object
      expect(s?.modelDecision.reasons.every((r) => typeof r === 'string')).toBe(true);
    });

    it('Job explain rolls up computersUsed and modelsUsed from actual executions', async () => {
      const { orchestrator } = setupFullHarness();

      const job = await orchestrator.createJob({
        title: 'Model Cycle Job',
        tasks: [
          {
            task: {
              id: 'jtask-1',
              type: 'coding',
              title: 'Task 1',
              input: 'Code part 1',
              requirements: { capabilities: ['coding'] },
              priority: 'normal',
              status: 'pending',
              createdAt: new Date(),
            },
          },
        ],
      });

      await orchestrator.runJob(job.id);

      const rollup = await orchestrator.getJobRollup(job.id);
      expect(rollup).toBeDefined();
      expect(rollup.jobId).toBe(job.id);
      expect(rollup.computersUsed).toContain('local-machine');
      expect(rollup.modelsUsed).toContain('coder-model');
    });

    it('Section 14: Validates captured metrics vs uncaptured proposed metrics', async () => {
      const { scheduler, executions } = setupFullHarness();

      const task: Task = {
        id: 'task-metrics-audit',
        type: 'coding',
        input: 'Audit metrics structure',
        requirements: { capabilities: ['coding'] },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const plan = scheduler.plan({ task });
      const record = await executions.create({
        task,
        agentId: 'coder-agent',
        computerId: plan.computerId,
        runtimeId: plan.runtimeId,
        modelId: plan.modelId,
        scheduling: plan,
      });

      const e = record.execution;

      // 1. Captured metrics (must exist on Execution & ExecutionRecord)
      expect(e.id).toBeDefined();
      expect(e.status).toBeDefined();
      expect(e.agentId).toBe('coder-agent');
      expect(e.modelId).toBe('coder-model');
      expect(e.runtimeId).toBe('fake-runtime');
      expect(e.computerId).toBe('local-machine');
      expect(e.createdAt).toBeDefined();

      expect(record.checks).toBeDefined();
      expect(record.toolCalls).toBeDefined();
      expect(record.filesChanged).toBeDefined();
      expect(record.errors).toBeDefined();

      // 2. Not captured today (Tracked Gap: load_time_ms, queue_time_ms, live RAM/VRAM sampling)
      expect((e as any).modelLoadTimeMs).toBeUndefined();
      expect((e as any).queueTimeMs).toBeUndefined();
      expect((e as any).hardwareMemoryPeakGB).toBeUndefined();
    });
  });
});
