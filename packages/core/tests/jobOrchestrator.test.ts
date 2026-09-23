import { describe, it, expect, vi } from 'vitest';
import {
  AgentRegistry,
  ComputerRegistry,
  ExecutionEngine,
  Job,
  JobManager,
  JobOrchestrator,
  JobTaskExecutor,
  ModelRegistry,
  RuntimeRegistry,
  Scheduler,
  Task,
} from '../src/index.js';

function setupTestOrchestrator(
  taskExecutor?: JobTaskExecutor,
  jobManager?: JobManager,
): {
  orchestrator: JobOrchestrator;
  computers: ComputerRegistry;
  runtimes: RuntimeRegistry;
  models: ModelRegistry;
  agents: AgentRegistry;
  executions: ExecutionEngine;
  scheduler: Scheduler;
} {
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
    jobManager,
  });

  return { orchestrator, computers, runtimes, models, agents, executions, scheduler };
}

describe('JobOrchestrator — fleet-scale graph walk & concurrent execution', () => {
  it('strictly respects concurrencyLimit across N independent tasks', async () => {
    let currentConcurrency = 0;
    let maxObservedConcurrency = 0;
    const completedTasks: string[] = [];

    const executor: JobTaskExecutor = async (task) => {
      currentConcurrency++;
      if (currentConcurrency > maxObservedConcurrency) {
        maxObservedConcurrency = currentConcurrency;
      }
      // Hold task running for a short time to force overlap
      await new Promise((r) => setTimeout(r, 40));
      currentConcurrency--;
      completedTasks.push(task.id);
      return {
        success: true,
        result: `done-${task.id}`,
        usage: { input: 10, output: 20, total: 30 },
      };
    };

    const { orchestrator } = setupTestOrchestrator(executor);

    // Create 6 independent tasks
    const job = await orchestrator.createJob({
      title: 'Concurrency Limit Test',
      concurrencyLimit: 2,
      tasks: [
        { task: { id: 'task-1', input: 'Task 1' } },
        { task: { id: 'task-2', input: 'Task 2' } },
        { task: { id: 'task-3', input: 'Task 3' } },
        { task: { id: 'task-4', input: 'Task 4' } },
        { task: { id: 'task-5', input: 'Task 5' } },
        { task: { id: 'task-6', input: 'Task 6' } },
      ],
    });

    const finishedJob = await orchestrator.runJob(job.id);

    expect(finishedJob.status).toBe('completed');
    expect(completedTasks).toHaveLength(6);
    expect(maxObservedConcurrency).toBe(2);
    expect(finishedJob.graph.nodes.every((n) => n.state === 'completed')).toBe(true);
  });

  it('enforces dependency ordering in DAG (diamond graph)', async () => {
    interface ExecutionRecordInterval {
      taskId: string;
      start: number;
      end: number;
    }
    const intervals: ExecutionRecordInterval[] = [];

    const executor: JobTaskExecutor = async (task) => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 30));
      const end = Date.now();
      intervals.push({ taskId: task.id, start, end });
      return { success: true, result: `result-${task.id}` };
    };

    const { orchestrator } = setupTestOrchestrator(executor);

    // Diamond DAG:
    //      root
    //     /    \
    //   left  right
    //     \    /
    //      sink
    const job = await orchestrator.createJob({
      title: 'Diamond DAG Test',
      concurrencyLimit: 4,
      tasks: [
        { task: { id: 'root', input: 'Root step' } },
        { task: { id: 'left', input: 'Left branch' }, dependencies: ['root'] },
        { task: { id: 'right', input: 'Right branch' }, dependencies: ['root'] },
        { task: { id: 'sink', input: 'Sink aggregator' }, dependencies: ['left', 'right'] },
      ],
    });

    const finished = await orchestrator.runJob(job.id);
    expect(finished.status).toBe('completed');

    const get = (id: string) => intervals.find((i) => i.taskId === id)!;
    const root = get('root');
    const left = get('left');
    const right = get('right');
    const sink = get('sink');

    // Root must finish before left or right start
    expect(root.end).toBeLessThanOrEqual(left.start + 5);
    expect(root.end).toBeLessThanOrEqual(right.start + 5);

    // Left and right can run concurrently (their intervals should overlap or be very close)
    expect(left.start).toBeLessThan(right.end);
    expect(right.start).toBeLessThan(left.end);

    // Sink must only start after both left and right finish
    expect(left.end).toBeLessThanOrEqual(sink.start + 5);
    expect(right.end).toBeLessThanOrEqual(sink.start + 5);
  });

  it('marks dependent tasks failed when an upstream dependency fails', async () => {
    const executed: string[] = [];

    const executor: JobTaskExecutor = async (task) => {
      executed.push(task.id);
      if (task.id === 'task-fail') {
        return { success: false, error: 'simulated root failure' };
      }
      return { success: true, result: 'ok' };
    };

    const { orchestrator } = setupTestOrchestrator(executor);

    const job = await orchestrator.createJob({
      title: 'Failure Cascade Test',
      maxRetries: 0,
      tasks: [
        { task: { id: 'task-fail', input: 'Will fail' } },
        { task: { id: 'task-dep', input: 'Depends on failed task' }, dependencies: ['task-fail'] },
        { task: { id: 'task-indep', input: 'Independent task' } },
      ],
    });

    const finished = await orchestrator.runJob(job.id);

    expect(finished.status).toBe('failed');
    expect(executed).toContain('task-fail');
    expect(executed).toContain('task-indep');
    expect(executed).not.toContain('task-dep');

    const depNode = finished.graph.nodes.find((n) => n.id === 'task-dep');
    expect(depNode?.state).toBe('failed');
    expect(depNode?.error).toBe('Dependency failed');
  });

  it('retries failing tasks up to maxRetries before failing', async () => {
    let attempts = 0;

    const executor: JobTaskExecutor = async () => {
      attempts++;
      if (attempts < 3) {
        return { success: false, error: `transient error attempt ${attempts}` };
      }
      return { success: true, result: 'recovered on 3rd attempt' };
    };

    const { orchestrator } = setupTestOrchestrator(executor);

    const job = await orchestrator.createJob({
      title: 'Retry Test',
      maxRetries: 3,
      tasks: [{ task: { id: 'retry-task', input: 'Task with retries' } }],
    });

    const finished = await orchestrator.runJob(job.id);

    expect(finished.status).toBe('completed');
    expect(attempts).toBe(3);
    const node = finished.graph.nodes[0];
    expect(node.state).toBe('completed');
    expect(node.result).toBe('recovered on 3rd attempt');
  });

  it('never retries a task whose outcome sets errorKind "policy", even when the error text gives no hint', async () => {
    // The structured errorKind must be what actually decides this — not a string-sniff of
    // "policy"/"denied" in the text — so the message here deliberately says neither.
    let attempts = 0;
    const executor: JobTaskExecutor = async () => {
      attempts++;
      return { success: false, error: 'not allowed here', errorKind: 'policy' };
    };

    const { orchestrator } = setupTestOrchestrator(executor);
    const job = await orchestrator.createJob({
      title: 'Policy Denial Test',
      maxRetries: 3,
      tasks: [{ task: { id: 'denied-task', input: 'this will be denied' } }],
    });

    const finished = await orchestrator.runJob(job.id);

    expect(finished.status).toBe('failed');
    expect(attempts).toBe(1); // no retry at all
    const node = finished.graph.nodes[0];
    expect(node.state).toBe('failed');
    expect(node.error).toBe('not allowed here');
  });

  it('supports single-task cancellation without terminating sibling tasks', async () => {
    const started: string[] = [];
    const completed: string[] = [];
    const cancelled: string[] = [];

    const executor: JobTaskExecutor = async (task, ctx) => {
      started.push(task.id);
      if (task.id === 'task-to-cancel') {
        return new Promise<JobTaskOutcome>((resolve) => {
          ctx.signal?.addEventListener('abort', () => {
            cancelled.push(task.id);
            resolve({ success: false, error: 'cancelled' });
          });
        });
      }
      await new Promise((r) => setTimeout(r, 60));
      completed.push(task.id);
      return { success: true, result: 'ok' };
    };

    const { orchestrator } = setupTestOrchestrator(executor);

    const job = await orchestrator.createJob({
      title: 'Selective Cancellation Test',
      concurrencyLimit: 2,
      tasks: [
        { task: { id: 'task-to-cancel', input: 'Slow task to cancel' } },
        { task: { id: 'task-sibling', input: 'Sibling should finish' } },
      ],
    });

    // Start job in background
    const runPromise = orchestrator.runJob(job.id);

    // Wait until both tasks are started
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toContain('task-to-cancel');
    expect(started).toContain('task-sibling');

    // Cancel only task-to-cancel
    await orchestrator.cancelTask(job.id, 'task-to-cancel');

    await runPromise;

    expect(cancelled).toContain('task-to-cancel');
    expect(completed).toContain('task-sibling');
  });

  it('automatically stops a task that runs past its timeout, marking it failed with a clear reason', async () => {
    // A task that hangs (a model stuck looping, waiting on something that never arrives)
    // used to run forever with no way to notice besides a human happening to look at the
    // duration. This is the actual, automatic kill switch.
    let sawAbort = false;
    const executor: JobTaskExecutor = async (task, ctx) => {
      return new Promise<JobTaskOutcome>((resolve) => {
        ctx.signal?.addEventListener('abort', () => {
          sawAbort = true;
          resolve({ success: false, error: 'aborted' });
        });
      });
    };

    const { orchestrator } = setupTestOrchestrator(executor);
    const job = await orchestrator.createJob({
      title: 'Timeout Test',
      tasks: [{ task: { id: 'hangs-forever', input: 'this never finishes on its own' } }],
    });

    const finished = await orchestrator.runJob(job.id, { timeoutSeconds: 1 });

    expect(sawAbort).toBe(true);
    expect(finished.status).toBe('failed');
    const node = finished.graph.nodes.find((n) => n.taskId === 'hangs-forever');
    expect(node?.state).toBe('failed');
    expect(node?.error).toContain('exceeded the 1s timeout');
  });

  it('never times out a job when no timeoutSeconds is given anywhere — no hidden default', async () => {
    // Regression: runJob() used to fall back to a built-in 300s default whenever
    // neither the run options nor the job itself set a timeout, silently killing
    // long-running local-model jobs nobody asked to bound. Advance well past that
    // old default and confirm nothing auto-cancels the still-running task.
    vi.useFakeTimers();
    try {
      let resolveTask: (() => void) | undefined;
      const executor: JobTaskExecutor = async (_task, ctx) => {
        return new Promise((resolve) => {
          ctx.signal?.addEventListener('abort', () => resolve({ success: false, error: 'aborted' }));
          resolveTask = () => resolve({ success: true, result: 'finished eventually' });
        });
      };

      const { orchestrator } = setupTestOrchestrator(executor);
      const job = await orchestrator.createJob({
        title: 'No Timeout Job',
        tasks: [{ task: { id: 'slow-task', input: 'takes a long time' } }],
      });

      const runPromise = orchestrator.runJob(job.id, {});
      await vi.advanceTimersByTimeAsync(400_000); // well past the old 300s default

      expect(orchestrator.getJob(job.id)?.status).toBe('running');

      resolveTask?.();
      const finished = await runPromise;
      expect(finished.status).toBe('completed');
      const node = finished.graph.nodes.find((n) => n.taskId === 'slow-task');
      expect(node?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not touch a job that finishes comfortably within its timeout', async () => {
    const executor: JobTaskExecutor = async () => ({ success: true, result: 'done quickly' });
    const { orchestrator } = setupTestOrchestrator(executor);
    const job = await orchestrator.createJob({
      title: 'Fast Job',
      tasks: [{ task: { id: 'quick-task', input: 'finishes immediately' } }],
    });

    const finished = await orchestrator.runJob(job.id, { timeoutSeconds: 60 });

    expect(finished.status).toBe('completed');
    const node = finished.graph.nodes.find((n) => n.taskId === 'quick-task');
    expect(node?.error).toBeUndefined();
  });

  it('supports mid-run steering injection into a running task', async () => {
    let capturedSteering: string | undefined;

    const executor: JobTaskExecutor = async (task, ctx) => {
      // Wait for steering instruction to arrive
      for (let i = 0; i < 20; i++) {
        const instruction = ctx.getSteeringInstruction?.();
        if (instruction) {
          capturedSteering = instruction;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return { success: true, result: `steered: ${capturedSteering}` };
    };

    const { orchestrator } = setupTestOrchestrator(executor);

    const job = await orchestrator.createJob({
      title: 'Steering Test',
      tasks: [{ task: { id: 'steer-task', input: 'Steer me' } }],
    });

    const runPromise = orchestrator.runJob(job.id);

    // Send steering after 25ms
    await new Promise((r) => setTimeout(r, 25));
    orchestrator.steerTask(job.id, 'steer-task', 'focus on security audit');

    const finished = await runPromise;
    expect(finished.status).toBe('completed');
    expect(capturedSteering).toBe('focus on security audit');
  });

  it('calculates aggregate fleet rollup (tokens, duration, computers, models)', async () => {
    const executor: JobTaskExecutor = async (task) => {
      return {
        success: true,
        result: 'ok',
        filesChanged: [`src/${task.id}.ts`],
        usage: { input: 100, output: 50, total: 150 },
      };
    };

    const { orchestrator, executions } = setupTestOrchestrator(executor);

    const job = await orchestrator.createJob({
      title: 'Rollup Test',
      concurrencyLimit: 2,
      tasks: [
        { task: { id: 't-1', input: 'Task 1' } },
        { task: { id: 't-2', input: 'Task 2' } },
      ],
    });

    // Wire executionEngine records when task executes
    orchestrator.subscribe(job.id, (ev) => {
      if (ev.type === 'task:completed' && ev.taskId) {
        executions.listByTask(ev.taskId).then((recs) => {
          for (const r of recs) {
            if (ev.usage) executions.recordUsage(r.execution.id, ev.usage);
            if (ev.filesChanged) executions.recordFilesChanged(r.execution.id, ev.filesChanged);
          }
        });
      }
    });

    await orchestrator.runJob(job.id);

    // Give microtasks time to flush records
    await new Promise((r) => setTimeout(r, 20));

    const rollup = await orchestrator.getJobRollup(job.id);
    expect(rollup.jobId).toBe(job.id);
    expect(rollup.taskCount).toBe(2);
    expect(rollup.completedTasks).toBe(2);
    expect(rollup.tokens.total).toBe(300);
    expect(rollup.tokens.input).toBe(200);
    expect(rollup.tokens.output).toBe(100);
    expect(rollup.filesChanged).toContain('src/t-1.ts');
    expect(rollup.filesChanged).toContain('src/t-2.ts');
    expect(rollup.computersUsed).toContain('local');
    expect(rollup.modelsUsed).toContain('fake-model');
  });

  it('persists the job-level terminal status, not just task status, so it survives a process restart', async () => {
    // Simulates a real KV store: runJob() must not just mutate job.status in memory —
    // it has to flush that change through JobManager, or the last thing ever written
    // to disk stays 'running' from job start, and every job looks stuck running
    // forever once reloaded in a fresh process (JobManager's constructor rehydrates
    // from `load()` exactly like a new `wa chat` invocation would).
    const backingStore = new Map<string, Job>();
    const jobManager = new JobManager({
      persist: (job) => {
        backingStore.set(job.id, structuredClone(job));
      },
    });

    const executor: JobTaskExecutor = async () => ({ success: true, result: 'the answer' });
    const { orchestrator } = setupTestOrchestrator(executor, jobManager);

    const job = await orchestrator.createJob({
      title: 'Persistence Test',
      tasks: [{ task: { id: 'only-task', input: 'do the thing' } }],
    });

    const finished = await orchestrator.runJob(job.id);
    expect(finished.status).toBe('completed');

    // What actually got flushed to the backing store, independent of the in-memory job
    const persisted = backingStore.get(job.id);
    expect(persisted?.status).toBe('completed');
    expect(persisted?.completedAt).toBeDefined();

    // Simulate a fresh process: a brand new JobManager reloading from the same store
    const reloadedManager = new JobManager({ load: () => Array.from(backingStore.values()) });
    await reloadedManager.ready;
    expect(reloadedManager.get(job.id)?.status).toBe('completed');
  });

  it('self-heals job records already stuck at running from before the persistence fix', async () => {
    // Reproduces exactly what pre-fix data looks like: task-level completion always
    // persisted correctly (completeTask flushes immediately), but the job's own status
    // field was never flushed on the terminal transition, so it's stuck at 'running'
    // forever in the store even though the only task finished long ago. New code can't
    // un-write already-persisted bad data — this has to be healed on load instead.
    const backingStore = new Map<string, Job>();
    const staleWriteManager = new JobManager({
      persist: (job) => backingStore.set(job.id, structuredClone(job)),
    });

    const job = staleWriteManager.create({
      title: 'Pre-fix Job',
      tasks: [{ task: { id: 'only-task', input: 'which models are installed' } }],
    });
    // completeTask correctly marks the task AND graph node completed and flushes — this
    // part of the old code always worked. job.status is left at its initial 'running'
    // (set by createJob's caller in the old runJob(), never corrected afterward), which
    // is exactly the stale shape sitting in real job stores today.
    job.status = 'running';
    await staleWriteManager.completeTask(job.id, 'only-task', 'gemma-4-12b, llama-3-8b');
    expect(backingStore.get(job.id)?.status).toBe('running');

    const flushedCorrections: Job[] = [];
    const healedManager = new JobManager({
      load: () => Array.from(backingStore.values()),
      persist: (j) => flushedCorrections.push(structuredClone(j)),
    });
    await healedManager.ready;

    const healed = healedManager.get(job.id);
    expect(healed?.status).toBe('completed');
    expect(healed?.completedAt).toBeDefined();
    // The correction itself must be flushed too, or it's healed only until the next reload
    expect(flushedCorrections.some((j) => j.id === job.id && j.status === 'completed')).toBe(true);
  });

  it('marks a genuinely orphaned running task as failed on load, instead of stuck running forever', async () => {
    // Different from the previous test: there, the task had actually finished and only
    // the job-level status flush was missing. Here the task itself never finished either
    // — simulating a process that started the task (task + job both flip to 'running')
    // and then died (crash, closed terminal) before it ever reached a terminal status.
    // Nothing in a freshly-constructed JobManager could still be running it, so this must
    // be treated as failed, not left indistinguishable from something still in progress.
    const backingStore = new Map<string, Job>();
    const staleWriteManager = new JobManager({
      persist: (job) => backingStore.set(job.id, structuredClone(job)),
    });

    const job = staleWriteManager.create({
      title: 'Orphaned Job',
      tasks: [{ task: { id: 'stuck-task', input: 'write a c++ program' } }],
    });
    await staleWriteManager.updateTaskStatus(job.id, 'stuck-task', 'running');
    job.status = 'running';
    await staleWriteManager.updateTaskStatus(job.id, 'stuck-task', 'running'); // re-flush with job.status now set
    expect(backingStore.get(job.id)?.status).toBe('running');
    expect(backingStore.get(job.id)?.tasks[0].status).toBe('running');

    const healedManager = new JobManager({ load: () => Array.from(backingStore.values()) });
    await healedManager.ready;

    const healed = healedManager.get(job.id);
    expect(healed?.status).toBe('failed');
    expect(healed?.completedAt).toBeDefined();
    expect(healed?.tasks[0].status).toBe('failed');
    const node = healed?.graph.nodes.find((n) => n.taskId === 'stuck-task');
    expect(node?.state).toBe('failed');
    expect(node?.error).toContain('Orphaned');
  });

  it('leaves a merely pending (never started) job alone on load — that is not an orphan', async () => {
    const backingStore = new Map<string, Job>();
    const manager = new JobManager({
      persist: (job) => backingStore.set(job.id, structuredClone(job)),
    });
    const job = manager.create({
      title: 'Queued Job',
      tasks: [{ task: { id: 'not-started', input: 'do something later' } }],
    });
    expect(job.status).toBe('pending');

    const reloadedManager = new JobManager({ load: () => Array.from(backingStore.values()) });
    await reloadedManager.ready;

    const reloaded = reloadedManager.get(job.id);
    expect(reloaded?.status).toBe('pending');
    expect(reloaded?.tasks[0].status).toBe('pending');
  });

  it('deleteJob removes a finished job from memory and the store, and refuses one still running', async () => {
    const backingStore = new Map<string, Job>();
    const removedIds: string[] = [];
    const jobManager = new JobManager({
      persist: (j) => backingStore.set(j.id, structuredClone(j)),
      remove: (id) => {
        removedIds.push(id);
        backingStore.delete(id);
      },
    });

    let releaseTask: (() => void) | undefined;
    const executor: JobTaskExecutor = async () => {
      await new Promise<void>((resolve) => {
        releaseTask = resolve;
      });
      return { success: true, result: 'ok' };
    };
    const { orchestrator } = setupTestOrchestrator(executor, jobManager);

    const job = await orchestrator.createJob({
      title: 'Deletable Job',
      tasks: [{ task: { id: 'only-task', input: 'do the thing' } }],
    });

    const runPromise = orchestrator.runJob(job.id);
    await new Promise((r) => setTimeout(r, 20)); // let it reach 'running'

    await expect(orchestrator.deleteJob(job.id)).rejects.toThrow(/still running/);
    expect(backingStore.has(job.id)).toBe(true);

    releaseTask?.();
    const finished = await runPromise;
    expect(finished.status).toBe('completed');

    const deleted = await orchestrator.deleteJob(job.id);
    expect(deleted).toBe(true);
    expect(orchestrator.getJob(job.id)).toBeUndefined();
    expect(backingStore.has(job.id)).toBe(false);
    expect(removedIds).toContain(job.id);
  });
});

describe('supervisor gates', () => {
  it('passes persisted dependency evidence to a supervisor and blocks rejected downstream work', async () => {
    const executed: string[] = [];
    const { orchestrator } = setupTestOrchestrator(async (task, context) => {
      executed.push(task.id);
      if (task.id === 'review') {
        expect(context.previousOutcomes?.get('work')?.result).toEqual({ artifact: 'patch' });
        return { success: true, supervisorDecision: { decision: 'reject', reason: 'Missing required test' } };
      }
      return { success: true, result: { artifact: 'patch' } };
    });
    const job = await orchestrator.createJob({ title: 'review gate', maxRetries: 0, tasks: [
      { task: { id: 'work', input: 'implement', type: 'coding' } },
      { task: { id: 'review', input: 'review', type: 'coding' }, type: 'supervisor', dependencies: ['work'] },
      { task: { id: 'publish', input: 'publish', type: 'coding' }, dependencies: ['review'] },
    ] });
    const result = await orchestrator.runJob(job.id);
    expect(result.status).toBe('failed');
    expect(executed).toEqual(['work', 'review']);
    expect(result.graph.nodes.find(n => n.id === 'review')?.error).toContain('SUPERVISOR_REJECTED');
  });

  it('requires a structured supervisor decision and never treats a successful call as approval', async () => {
    const { orchestrator } = setupTestOrchestrator(async () => ({ success: true, result: 'looks good' }));
    const job = await orchestrator.createJob({ title: 'review gate', maxRetries: 0, tasks: [
      { task: { id: 'review', input: 'review', type: 'coding' }, type: 'supervisor' },
    ] });
    const result = await orchestrator.runJob(job.id);
    expect(result.status).toBe('failed');
    expect(result.graph.nodes[0].error).toBe('SUPERVISOR_DECISION_REQUIRED');
  });

  it('runs a persisted graph and releases ownership after completion', async () => {
    const { MemoryStore } = await import('@wazir/shared');
    const store = new MemoryStore();
    const manager = new JobManager({ store });
    await manager.ready;
    const { orchestrator } = setupTestOrchestrator(async () => ({ success: true }), manager);
    const job = await orchestrator.createJob({ title: 'durable run', tasks: [
      { task: { id: 'one', input: 'work', type: 'coding' } },
    ] });
    expect((await orchestrator.runJob(job.id)).status).toBe('completed');
    const restarted = new JobManager({ store });
    await restarted.ready;
    expect(restarted.get(job.id)?.status).toBe('completed');
    expect(restarted.get(job.id)?.ownership?.expiresAt).toBe(0);
  });
});
