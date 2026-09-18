import { describe, it, expect } from 'vitest';
import {
  AgentRegistry,
  ComputerRegistry,
  ExecutionEngine,
  JobOrchestrator,
  JobTaskExecutor,
  JobTaskOutcome,
  ModelRegistry,
  RuntimeRegistry,
  Scheduler,
} from '../src/index.js';

function setupOrchestrator(taskExecutor?: JobTaskExecutor) {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const executions = new ExecutionEngine();

  computers.register({
    id: 'local',
    name: 'test-computer',
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

  models.register({
    id: 'fake-model',
    name: 'fake-model',
    provider: 'fake-runtime',
    family: 'other',
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
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  models.upsertInstance({
    id: 'fake-model::local::fake-runtime',
    modelId: 'fake-model',
    computerId: 'local',
    runtimeId: 'fake-runtime',
    runtimeModelId: 'fake-model',
    loaded: true,
    health: 'healthy',
    contextTokens: 32_768,
  });

  agents.register(
    {
      descriptor: {
        name: 'test-agent',
        version: '1.0',
        description: 'Test agent',
        capabilities: ['coding'],
        requiredTools: [],
        modelRequirements: { capabilities: ['coding'] },
        permissions: [],
        taskTypes: ['coding', 'chat'],
        strategy: 'test',
      },
      async *run() {
        yield { kind: 'done', content: 'done' };
      },
    },
    'native',
  );

  const scheduler = new Scheduler({ computers, runtimes, models, agents });
  const orchestrator = new JobOrchestrator({
    scheduler,
    executionEngine: executions,
    computers,
    runtimes,
    models,
    agents,
    taskExecutor,
  });

  return { orchestrator, computers, runtimes, models, agents, executions, scheduler };
}

describe('Section 5: Job / Orchestration Testing (the JobGraph-equivalent)', () => {
  describe('Lifecycle / status transitions', () => {
    it('rejects invalid transitions: completed -> running', async () => {
      const { orchestrator } = setupOrchestrator(async () => ({ success: true, result: 'done' }));
      const job = await orchestrator.createJob({
        title: 'Completed transition test',
        tasks: [{ task: { id: 't1', input: 'step 1' } }],
      });

      const finished = await orchestrator.runJob(job.id);
      expect(finished.status).toBe('completed');

      // Attempting to run a completed job must fail loudly
      await expect(orchestrator.runJob(job.id)).rejects.toThrow(/Cannot run job in status 'completed'/);
    });

    it('rejects invalid transitions: failed -> running', async () => {
      const { orchestrator } = setupOrchestrator(async () => ({ success: false, error: 'unrecoverable' }));
      const job = await orchestrator.createJob({
        title: 'Failed transition test',
        maxRetries: 0,
        tasks: [{ task: { id: 't1', input: 'step 1' } }],
      });

      const finished = await orchestrator.runJob(job.id);
      expect(finished.status).toBe('failed');

      // Attempting to run a failed job must fail loudly
      await expect(orchestrator.runJob(job.id)).rejects.toThrow(/Cannot run job in status 'failed'/);
    });

    it('rejects invalid transitions: cancelled -> running', async () => {
      const { orchestrator } = setupOrchestrator(async () => ({ success: true }));
      const job = await orchestrator.createJob({
        title: 'Cancelled transition test',
        tasks: [{ task: { id: 't1', input: 'step 1' } }],
      });

      await orchestrator.cancelJob(job.id);
      expect(orchestrator.getJob(job.id)?.status).toBe('cancelled');

      // Attempting to run a cancelled job must fail loudly
      await expect(orchestrator.runJob(job.id)).rejects.toThrow(/Cannot run job in status 'cancelled'/);
    });
  });

  describe('Fan-out / fan-in', () => {
    it('provides independent contexts to concurrent tasks with no cross-leak', async () => {
      const observedTaskIds: string[] = [];
      const executor: JobTaskExecutor = async (task, ctx) => {
        observedTaskIds.push(ctx.taskId);
        expect(ctx.taskId).toBe(task.id);
        expect(ctx.node.id).toBe(task.id);
        await new Promise((r) => setTimeout(r, 20));
        return { success: true, result: `done-${task.id}` };
      };

      const { orchestrator } = setupOrchestrator(executor);
      const job = await orchestrator.createJob({
        title: 'Independent Context Test',
        concurrencyLimit: 3,
        tasks: [
          { task: { id: 'branch-a', input: 'A' } },
          { task: { id: 'branch-b', input: 'B' } },
          { task: { id: 'branch-c', input: 'C' } },
        ],
      });

      const finished = await orchestrator.runJob(job.id);
      expect(finished.status).toBe('completed');
      expect(observedTaskIds).toHaveLength(3);
      expect(new Set(observedTaskIds).size).toBe(3);
    });

    it('prevents fan-in aggregator from starting if an upstream branch fails', async () => {
      let aggregatorStarted = false;
      const executor: JobTaskExecutor = async (task) => {
        if (task.id === 'branch-fail') {
          return { success: false, error: 'simulated branch error' };
        }
        if (task.id === 'aggregator') {
          aggregatorStarted = true;
          return { success: true, result: 'aggregator done' };
        }
        return { success: true, result: 'ok' };
      };

      const { orchestrator } = setupOrchestrator(executor);
      const job = await orchestrator.createJob({
        title: 'Fan-in Branch Failure Test',
        maxRetries: 0,
        tasks: [
          { task: { id: 'branch-ok', input: 'OK' } },
          { task: { id: 'branch-fail', input: 'Fail' } },
          { task: { id: 'aggregator', input: 'Combine' }, dependencies: ['branch-ok', 'branch-fail'] },
        ],
      });

      const finished = await orchestrator.runJob(job.id);
      expect(finished.status).toBe('failed');
      expect(aggregatorStarted).toBe(false);

      const aggNode = finished.graph.nodes.find((n) => n.id === 'aggregator');
      expect(aggNode?.state).toBe('failed');
      expect(aggNode?.error).toBe('Dependency failed');
    });
  });

  describe('Steering (steerTask / steerJob)', () => {
    it('drops steering instructions queued for a task that has already completed', async () => {
      const { orchestrator } = setupOrchestrator(async () => ({ success: true, result: 'fast done' }));

      const job = await orchestrator.createJob({
        title: 'Finished Task Steering Drop Test',
        tasks: [{ task: { id: 'fast-task', input: 'Fast' } }],
      });

      await orchestrator.runJob(job.id);
      expect(orchestrator.getJob(job.id)?.status).toBe('completed');

      // Steer the task after it has completed
      orchestrator.steerTask(job.id, 'fast-task', 'late steering instruction');

      // A new job reusing the same taskId 'fast-task' must not receive the stale steering instruction
      let receivedInstruction: string | undefined = 'initial';
      const secondOrchestrator = setupOrchestrator(async (_task, ctx) => {
        receivedInstruction = ctx.getSteeringInstruction?.();
        return { success: true, result: 'ok' };
      }).orchestrator;

      const job2 = await secondOrchestrator.createJob({
        title: 'Second Job',
        tasks: [{ task: { id: 'fast-task', input: 'Reused id' } }],
      });

      await secondOrchestrator.runJob(job2.id);
      expect(receivedInstruction).toBeUndefined();
    });

    it('steerJob with zero running tasks does not error', async () => {
      const { orchestrator } = setupOrchestrator(async () => ({ success: true }));
      const job = await orchestrator.createJob({
        title: 'Zero running steer job',
        tasks: [{ task: { id: 't1', input: 'T' } }],
      });

      // steerJob before job runs
      expect(() => orchestrator.steerJob(job.id, 'instruction')).not.toThrow();
    });
  });

  describe('Cancellation', () => {
    it('cancelTask transitions task and agent state to cancelled with "Cancelled by user"', async () => {
      const events: string[] = [];
      const executor: JobTaskExecutor = async (task, ctx) => {
        if (task.id === 'cancelling-task') {
          return new Promise((resolve) => {
            ctx.signal?.addEventListener('abort', () => {
              resolve({ success: false, error: 'cancelled' });
            });
          });
        }
        return { success: true, result: 'ok' };
      };

      const { orchestrator } = setupOrchestrator(executor);
      const job = await orchestrator.createJob({
        title: 'Single Task Cancel Event Test',
        tasks: [
          { task: { id: 'cancelling-task', input: 'Cancel me' } },
          { task: { id: 'other-task', input: 'Other' } },
        ],
      });

      orchestrator.subscribe(job.id, (e) => {
        if (e.type === 'task:cancelled') {
          events.push(e.taskId!);
        }
      });

      const runPromise = orchestrator.runJob(job.id);
      await new Promise((r) => setTimeout(r, 20));

      await orchestrator.cancelTask(job.id, 'cancelling-task');
      await runPromise;

      const finishedJob = orchestrator.getJob(job.id)!;
      const cancelledTask = finishedJob.tasks.find((t) => t.id === 'cancelling-task');
      const cancelledNode = finishedJob.graph.nodes.find((n) => n.id === 'cancelling-task');

      expect(cancelledTask?.status).toBe('cancelled');
      expect(cancelledNode?.state).toBe('cancelled');
      expect(cancelledNode?.error).toBe('Cancelled by user');
      expect(events).toContain('cancelling-task');
    });

    it('once cancelled, a job must never later transition to completed (race condition test)', async () => {
      let taskResolver: ((val: JobTaskOutcome) => void) | undefined;
      const executor: JobTaskExecutor = async (task) => {
        return new Promise((resolve) => {
          taskResolver = resolve;
        });
      };

      const { orchestrator } = setupOrchestrator(executor);
      const job = await orchestrator.createJob({
        title: 'Race Condition Cancel Test',
        tasks: [{ task: { id: 't-race', input: 'Race step' } }],
      });

      const runPromise = orchestrator.runJob(job.id);
      await new Promise((r) => setTimeout(r, 20));

      // Cancel the job while the task is mid-execution
      await orchestrator.cancelJob(job.id);

      // Now the task completes *after* the job cancellation was invoked
      taskResolver?.({ success: true, result: 'late completion' });

      const finishedJob = await runPromise;
      expect(finishedJob.status).toBe('cancelled');
      expect(finishedJob.status).not.toBe('completed');
    });
  });

  describe('Retries and Non-Retryable Failures', () => {
    it('policy denial never triggers a retry attempt', async () => {
      let callCount = 0;
      const executor: JobTaskExecutor = async () => {
        callCount++;
        return {
          success: false,
          error: 'Policy denied: command not allowed by policy',
          reasons: ['Policy denial on shell execute'],
        };
      };

      const { orchestrator } = setupOrchestrator(executor);
      const job = await orchestrator.createJob({
        title: 'Policy Denial Retry Gate Test',
        maxRetries: 3, // Allowed retries for transient errors
        tasks: [{ task: { id: 'policy-task', input: 'Denied action' } }],
      });

      const finished = await orchestrator.runJob(job.id);
      expect(finished.status).toBe('failed');
      // Must NOT retry policy denials! Call count must be exactly 1.
      expect(callCount).toBe(1);
    });

    it('stops after reaching maxRetries without infinite loop', async () => {
      let callCount = 0;
      const executor: JobTaskExecutor = async () => {
        callCount++;
        return { success: false, error: 'transient connection failure' };
      };

      const { orchestrator } = setupOrchestrator(executor);
      const job = await orchestrator.createJob({
        title: 'Max Retries Test',
        maxRetries: 2,
        tasks: [{ task: { id: 'retry-task', input: 'Retry me' } }],
      });

      const finished = await orchestrator.runJob(job.id);
      expect(finished.status).toBe('failed');
      // 1 initial attempt + 2 retries = 3 attempts total
      expect(callCount).toBe(3);
    });
  });

  describe('Graph Validation: Cycles, Nonexistent Dependencies, Duplicate IDs', () => {
    it('rejects duplicate task IDs', async () => {
      const { orchestrator } = setupOrchestrator();
      await expect(
        orchestrator.createJob({
          title: 'Duplicate Task IDs',
          tasks: [
            { task: { id: 'dup-id', input: 'First' } },
            { task: { id: 'dup-id', input: 'Second' } },
          ],
        }),
      ).rejects.toThrow(/Duplicate task id 'dup-id'/);
    });

    it('rejects references to nonexistent dependencies', async () => {
      const { orchestrator } = setupOrchestrator();
      await expect(
        orchestrator.createJob({
          title: 'Nonexistent Dependency',
          tasks: [
            { task: { id: 'task-1', input: 'Step 1' }, dependencies: ['ghost-dependency'] },
          ],
        }),
      ).rejects.toThrow(/references nonexistent dependency 'ghost-dependency'/);
    });

    it('rejects cyclical dependencies in task graph', async () => {
      const { orchestrator } = setupOrchestrator();
      await expect(
        orchestrator.createJob({
          title: 'Cyclic Graph',
          tasks: [
            { task: { id: 'node-a', input: 'A' }, dependencies: ['node-b'] },
            { task: { id: 'node-b', input: 'B' }, dependencies: ['node-a'] },
          ],
        }),
      ).rejects.toThrow(/Cycle detected in task dependencies/);
    });
  });
});
