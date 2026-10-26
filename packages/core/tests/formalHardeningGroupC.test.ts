import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { JobManager } from '../src/services/jobManager.js';
import { JobOrchestrator } from '../src/services/jobOrchestrator.js';
import type { Scheduler } from '../src/services/scheduler.js';
import type { JobTaskExecutor } from '../src/types/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(executor: JobTaskExecutor) {
  const manager = new JobManager();
  const executions = new ExecutionEngine();
  const scheduler = {
    plan: () => ({ agentId: 'agent', modelId: 'model', runtimeId: 'runtime', computerId: 'computer' }),
  } as unknown as Scheduler;
  const orchestrator = new JobOrchestrator({ scheduler, executionEngine: executions, jobManager: manager, taskExecutor: executor });
  return { manager, executions, orchestrator };
}

describe('Group C lifecycle integrity', () => {
  it('finishes a mixed completed and cancelled job as cancelled', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const { orchestrator } = fixture(async (task) => {
      if (task.id === 'cancel') {
        started.resolve();
        await release.promise;
      }
      return { success: true, result: 'done' };
    });
    const job = await orchestrator.createJob({ title: 'mixed', concurrencyLimit: 2, tasks: [
      { task: { id: 'complete', input: 'a' } }, { task: { id: 'cancel', input: 'b' } },
    ] });
    const events: string[] = [];
    orchestrator.subscribe(job.id, (event) => events.push(event.type));
    const running = orchestrator.runJob(job.id);
    await started.promise;
    await orchestrator.cancelTask(job.id, 'cancel');
    release.resolve();
    const finished = await running;
    expect(finished.tasks.find((task) => task.id === 'complete')?.status).toBe('completed');
    expect(finished.tasks.find((task) => task.id === 'cancel')?.status).toBe('cancelled');
    expect(finished.status).toBe('cancelled');
    expect(events).toContain('job:cancelled');
    expect(events).not.toContain('job:completed');
  });

  for (const cancellation of ['task', 'job'] as const) {
    it(`${cancellation} cancellation finalizes its running execution`, async () => {
      const started = deferred<void>();
      const release = deferred<void>();
      const { orchestrator, executions } = fixture(async () => {
        started.resolve();
        await release.promise;
        return { success: true };
      });
      const job = await orchestrator.createJob({ title: cancellation, tasks: [{ task: { id: `task-${cancellation}`, input: 'work' } }] });
      const running = orchestrator.runJob(job.id);
      await started.promise;
      const records = await executions.listByTask(`task-${cancellation}`);
      expect(records).toHaveLength(1);
      expect(records[0].execution.status).toBe('running');
      if (cancellation === 'task') await orchestrator.cancelTask(job.id, `task-${cancellation}`);
      else await orchestrator.cancelJob(job.id);
      expect((await executions.get(records[0].execution.id))?.execution.status).toBe('cancelled');
      release.resolve();
      await running;
      expect((await executions.get(records[0].execution.id))?.execution.status).toBe('cancelled');
    });
  }

  for (const status of ['cancelled', 'completed'] as const) {
    it(`rejects retry through both APIs when the job is ${status}`, async () => {
      const { manager, orchestrator, executions } = fixture(async () => ({ success: true }));
      const job = await orchestrator.createJob({ title: status, tasks: [{ task: { id: `retry-${status}`, input: 'work' } }] });
      await manager.updateTaskStatus(job.id, `retry-${status}`, 'failed');
      await manager.updateAgentState(job.id, `retry-${status}`, 'failed');
      await manager.setJobStatus(job.id, status);
      await expect(manager.retryTask(job.id, `retry-${status}`)).rejects.toThrow(/terminal job/);
      await expect(orchestrator.retryTask(job.id, `retry-${status}`)).rejects.toThrow(/terminal job/);
      expect(job.tasks[0].status).toBe('failed');
      expect(job.graph.nodes[0].state).toBe('failed');
      expect(await executions.listByTask(`retry-${status}`)).toHaveLength(0);
    });
  }

  it('rejects terminal task and execution resurrection', async () => {
    const { manager, executions } = fixture(async () => ({ success: true }));
    const job = manager.create({ title: 'terminal', tasks: [{ task: { id: 'terminal-task', input: 'work' } }] });
    await manager.updateTaskStatus(job.id, 'terminal-task', 'cancelled');
    await expect(manager.updateTaskStatus(job.id, 'terminal-task', 'running')).rejects.toThrow(/Invalid task status transition/);
    expect(job.tasks[0].status).toBe('cancelled');

    const record = await executions.create({ task: job.tasks[0], computerId: 'computer', runtimeId: 'runtime', modelId: 'model' });
    await executions.setStatus(record.execution.id, 'cancelled');
    await expect(executions.setStatus(record.execution.id, 'running')).rejects.toThrow(/Invalid execution status transition/);
    expect((await executions.get(record.execution.id))?.execution.status).toBe('cancelled');
  });
});
