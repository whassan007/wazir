import { describe, it, expect } from 'vitest';
import {
  AgentRegistry,
  ComputerRegistry,
  ExecutionEngine,
  JobOrchestrator,
  JobTaskExecutor,
  ModelRegistry,
  RuntimeRegistry,
  Scheduler,
} from '../src/index.js';

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

describe('JobOrchestrator pause/resume', () => {
  it('pausing a live job stops the second (independent) task from starting until resumed', async () => {
    const started: string[] = [];
    const gate: Record<string, () => void> = {};
    const executor: JobTaskExecutor = (task) =>
      new Promise((resolve) => {
        started.push(task.id);
        gate[task.id] = () => resolve({ success: true, result: 'ok' });
      });

    const { orchestrator } = setup(executor);
    const job = await orchestrator.createJob({
      title: 'pause test',
      concurrencyLimit: 1,
      tasks: [{ task: { id: 't1', input: 'first' } }, { task: { id: 't2', input: 'second' } }],
    });

    const runPromise = orchestrator.runJob(job.id);

    // Wait for t1 to actually start.
    for (let i = 0; i < 50 && !started.includes('t1'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual(['t1']);

    await orchestrator.pauseJob(job.id);
    gate['t1']();

    // t1 finishes, but t2 must NOT start while paused — give it a real window to (wrongly) start.
    await new Promise((r) => setTimeout(r, 150));
    expect(started).toEqual(['t1']);

    await orchestrator.resumeJob(job.id);
    for (let i = 0; i < 50 && !started.includes('t2'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual(['t1', 't2']);

    gate['t2']();
    const finished = await runPromise;
    expect(finished.status).toBe('completed');
  }, 10_000);

  it('rejects pausing a job already in a terminal status', async () => {
    const executor: JobTaskExecutor = async () => ({ success: true, result: 'ok' });
    const { orchestrator } = setup(executor);
    const job = await orchestrator.createJob({ title: 'x', tasks: [{ task: { id: 't1', input: 'x' } }] });
    await orchestrator.runJob(job.id);
    await expect(orchestrator.pauseJob(job.id)).rejects.toThrow();
  });
});
