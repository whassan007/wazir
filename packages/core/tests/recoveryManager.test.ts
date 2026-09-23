import { describe, it, expect } from 'vitest';
import {
  AgentRegistry,
  ComputerRegistry,
  ExecutionEngine,
  JobManager,
  JobOrchestrator,
  JobTaskExecutor,
  ModelRegistry,
  RecoveryManager,
  RuntimeRegistry,
  Scheduler,
} from '../src/index.js';

function setup(taskExecutor?: JobTaskExecutor) {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const executions = new ExecutionEngine();
  const jobManager = new JobManager();

  computers.register({
    id: 'dead-worker',
    name: 'dead-worker',
    type: 'workstation',
    local: true,
    os: { platform: 'linux', architecture: 'x64', version: '6.0' },
    hardware: { cpu: 'test-cpu', cpuCores: 8, memoryGB: 32 },
    capabilities: ['localExecution'],
  });

  runtimes.register({
    id: 'fake-runtime',
    type: 'other',
    name: 'fake-runtime',
    version: '1.0',
    computerId: 'dead-worker',
    capabilities: {
      chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false,
      embeddings: false, reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false,
      statefulChat: false, mcp: false,
    },
  });

  models.register({
    id: 'fake-model', name: 'fake-model', provider: 'fake-runtime', family: 'other',
    contextMax: 32_768, capabilities: ['generalChat', 'coding'], toolCalling: true,
    structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false,
    runtimeCompatibility: 'any', local: true, createdAt: new Date(), updatedAt: new Date(),
  });

  models.upsertInstance({
    id: 'fake-model::dead-worker::fake-runtime', modelId: 'fake-model', computerId: 'dead-worker',
    runtimeId: 'fake-runtime', runtimeModelId: 'fake-model', loaded: true, health: 'healthy',
    contextTokens: 32_768,
  });

  // A second, healthy computer so an orphaned task has somewhere real to retry onto —
  // without this the scheduler has nowhere to place the retry and the test would
  // conflate "orphan detection didn't work" with "there was nowhere to reschedule".
  computers.register({
    id: 'backup-worker', name: 'backup-worker', type: 'workstation', local: true,
    os: { platform: 'linux', architecture: 'x64', version: '6.0' },
    hardware: { cpu: 'test-cpu', cpuCores: 8, memoryGB: 32 }, capabilities: ['localExecution'],
  });
  runtimes.register({
    id: 'fake-runtime-2', type: 'other', name: 'fake-runtime-2', version: '1.0', computerId: 'backup-worker',
    capabilities: {
      chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false,
      embeddings: false, reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false,
      statefulChat: false, mcp: false,
    },
  });
  models.upsertInstance({
    id: 'fake-model::backup-worker::fake-runtime-2', modelId: 'fake-model', computerId: 'backup-worker',
    runtimeId: 'fake-runtime-2', runtimeModelId: 'fake-model', loaded: true, health: 'healthy',
    contextTokens: 32_768,
  });

  agents.register(
    {
      descriptor: {
        name: 'test-agent', version: '1.0', description: 'Test agent', capabilities: ['coding'],
        requiredTools: [], modelRequirements: { capabilities: ['coding'] }, permissions: [],
        taskTypes: ['coding', 'chat'], strategy: 'test',
      },
      async *run() { yield { kind: 'done', content: 'done' }; },
    },
    'native',
  );

  const scheduler = new Scheduler({ computers, runtimes, models, agents });
  const orchestrator = new JobOrchestrator({
    scheduler, executionEngine: executions, computers, runtimes, models, agents, taskExecutor, jobManager,
  });

  const recovery = new RecoveryManager({ computers, executions, jobManager, orchestrator, offlineMs: 1000, staleMs: 500 });

  return { computers, executions, jobManager, orchestrator, recovery };
}

describe('RecoveryManager', () => {
  it('orphans and does NOT retry an execution whose computer never registered a heartbeat, once past offlineMs', async () => {
    const { computers, executions, recovery } = setup();

    const record = await executions.create({
      task: { id: 't1', title: 'x', input: 'x' } as any,
      computerId: 'dead-worker',
      runtimeId: 'fake-runtime',
      modelId: 'fake-model',
    });
    await executions.setStatus(record.execution.id, 'running');

    // Backdate the computer's heartbeat far enough in the past to be "offline".
    const c = computers.get('dead-worker')!;
    (c as any).lastHeartbeat = new Date(Date.now() - 5000);

    const result = await recovery.sweep();

    expect(result.offlineComputers).toContain('dead-worker');
    expect(result.orphanedExecutions).toContain(record.execution.id);

    const updated = await executions.get(record.execution.id);
    expect(updated?.execution.status).toBe('failed');
    expect(updated?.errors.some((e) => e.includes('ORPHANED_WORKER_UNREACHABLE'))).toBe(true);
  });

  it('retries an orphaned task live through the orchestrator instead of just marking it failed', async () => {
    let attempt = 0;
    const executor: JobTaskExecutor = async (task, ctx) => {
      attempt += 1;
      if (attempt === 1) {
        // Simulate the task hanging until its worker's abort signal fires (what
        // reportExecutionOrphaned triggers), rather than resolving on its own.
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve());
        });
        throw new Error('aborted');
      }
      return { success: true, result: 'recovered' };
    };

    const { computers, executions, jobManager, orchestrator, recovery } = setup(executor);

    const job = await orchestrator.createJob({
      title: 'Recovery test',
      maxRetries: 2,
      tasks: [{ task: { id: 'recover-me', input: 'do work' } }],
    });

    const runPromise = orchestrator.runJob(job.id);

    // Wait for the task to actually start (its execution row exists and is running).
    let record: Awaited<ReturnType<typeof executions.list>>[number] | undefined;
    for (let i = 0; i < 50; i++) {
      const all = await executions.list();
      record = all.find((r) => r.execution.taskId === 'recover-me');
      if (record && record.execution.status !== 'queued') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(record).toBeTruthy();
    await executions.setStatus(record!.execution.id, 'running');

    const c = computers.get('local') ?? computers.get('dead-worker');
    void c;
    // The task was scheduled onto whichever computer the scheduler picked —
    // find it from the execution record itself rather than assuming an id.
    const computerId = record!.execution.computerId!;
    const comp = computers.get(computerId)!;
    (comp as any).lastHeartbeat = new Date(Date.now() - 5000);

    const sweepResult = await recovery.sweep();
    expect(sweepResult.retriedLive).toContain('recover-me');

    const finishedJob = await runPromise;
    expect(finishedJob.status).toBe('completed');
    expect(attempt).toBe(2);

    const task = jobManager.get(job.id)!.tasks.find((t) => t.id === 'recover-me')!;
    expect(task.status).toBe('completed');
  }, 10_000);
});
