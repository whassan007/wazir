import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AgentRegistry,
  ComputerRegistry,
  ExecutionEngine,
  JobOrchestrator,
  JobTaskExecutor,
  ModelRegistry,
  RuntimeRegistry,
  Scheduler,
} from '@wazir/core';
import { ShutdownController } from '../src/shutdownController.js';

function setup(taskExecutor: JobTaskExecutor) {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const executions = new ExecutionEngine();

  computers.register({
    id: 'local', name: 'local', type: 'workstation', local: true,
    os: { platform: 'linux', architecture: 'x64', version: '6.0' },
    hardware: { cpu: 'test-cpu', cpuCores: 8, memoryGB: 32 }, capabilities: ['localExecution'],
  });
  runtimes.register({
    id: 'fake-runtime', type: 'other', name: 'fake-runtime', version: '1.0', computerId: 'local',
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
    id: 'fake-model::local::fake-runtime', modelId: 'fake-model', computerId: 'local',
    runtimeId: 'fake-runtime', runtimeModelId: 'fake-model', loaded: true, health: 'healthy',
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
  const orchestrator = new JobOrchestrator({ scheduler, executionEngine: executions, computers, runtimes, models, agents, taskExecutor });
  return { orchestrator };
}

/**
 * Directive failure-matrix item: "SIGTERM / SIGINT signals dispatched mid-job".
 * Proves the two pieces this session built (ShutdownController, item 2.4;
 * JobOrchestrator.cancelJob, pre-existing) actually compose correctly end to
 * end — a real signal arriving while a job is running stops the in-flight
 * task's work (not just marks the job record cancelled after the fact) and
 * the process exits with the correct signal-specific code, bounded by the
 * graceful timeout rather than waiting for the task to finish on its own.
 */
describe('ShutdownController + JobOrchestrator — SIGTERM/SIGINT mid-job', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    exitSpy?.mockRestore();
  });

  it('a mid-job SIGTERM aborts the running task and exits 0 once the job actually stops', async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);

    let taskAborted = false;
    const executor: JobTaskExecutor = (task, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          taskAborted = true;
          resolve({ success: false, error: 'aborted by shutdown' });
        });
      });

    const { orchestrator } = setup(executor);
    const job = await orchestrator.createJob({ title: 'mid-job SIGTERM', tasks: [{ task: { id: 't1', input: 'long task' } }] });
    const runPromise = orchestrator.runJob(job.id);

    // Wait for the task to actually be running before the signal arrives —
    // a signal that races ahead of dispatch would trivially "work" without
    // proving anything about stopping *in-flight* work.
    for (let i = 0; i < 50; i++) {
      const current = orchestrator.getJob(job.id);
      if (current?.graph.nodes.some((n) => n.state === 'running')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(orchestrator.getJob(job.id)?.graph.nodes.some((n) => n.state === 'running')).toBe(true);

    const controller = new ShutdownController({ gracefulTimeoutMs: 3000 });
    controller.register('active-job', () => orchestrator.cancelJob(job.id, 'SIGTERM received mid-job'));

    await controller.shutdown('SIGTERM');

    expect(taskAborted).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);

    const finished = await runPromise;
    expect(finished.status).toBe('cancelled');
  }, 10_000);

  it('a mid-job SIGINT exits 130, distinct from the SIGTERM case', async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);

    const executor: JobTaskExecutor = (task, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve({ success: false, error: 'aborted' }));
      });

    const { orchestrator } = setup(executor);
    const job = await orchestrator.createJob({ title: 'mid-job SIGINT', tasks: [{ task: { id: 't1', input: 'long task' } }] });
    void orchestrator.runJob(job.id);

    for (let i = 0; i < 50; i++) {
      const current = orchestrator.getJob(job.id);
      if (current?.graph.nodes.some((n) => n.state === 'running')) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const controller = new ShutdownController({ gracefulTimeoutMs: 3000 });
    controller.register('active-job', () => orchestrator.cancelJob(job.id, 'SIGINT received mid-job'));
    await controller.shutdown('SIGINT');

    expect(exitSpy).toHaveBeenCalledWith(130);
  }, 10_000);

  it('bounds the shutdown even if cancelJob() itself never resolves — still exits, does not hang forever', async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);

    const executor: JobTaskExecutor = () => new Promise(() => {}); // never resolves, ignores abort — the worst case
    const { orchestrator } = setup(executor);
    const job = await orchestrator.createJob({ title: 'hung task', tasks: [{ task: { id: 't1', input: 'x' } }] });
    void orchestrator.runJob(job.id);

    for (let i = 0; i < 50; i++) {
      const current = orchestrator.getJob(job.id);
      if (current?.graph.nodes.some((n) => n.state === 'running')) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const controller = new ShutdownController({ gracefulTimeoutMs: 150 });
    controller.register('active-job', () => orchestrator.cancelJob(job.id, 'SIGTERM'));

    const start = Date.now();
    await controller.shutdown('SIGTERM');
    const elapsed = Date.now() - start;

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(elapsed).toBeLessThan(1000);
  }, 10_000);
});
