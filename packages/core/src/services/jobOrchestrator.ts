import type {
  AgentPhase,
  Job,
  JobNode,
  JobOrchestratorEvent,
  JobRollup,
  JobRunOptions,
  JobTaskExecutionContext,
  JobTaskExecutor,
  JobTaskOutcome,
  Task,
  TokenUsage,
} from '../types/index.js';
import { tokensPerSecond } from '@wazir/shared';
import { JobManager, type JobTaskInput } from './jobManager.js';
import type { Scheduler, ScheduleInput } from './scheduler.js';
import type { ExecutionEngine } from './executionEngine.js';
import type { PolicyEngine } from './policyEngine.js';
import type { AgentRegistry } from './agentRegistry.js';
import type { ModelRegistry } from './modelRegistry.js';
import type { RuntimeRegistry } from './runtimeRegistry.js';
import type { ComputerRegistry } from './computerRegistry.js';

export interface JobOrchestratorOptions {
  scheduler: Scheduler;
  executionEngine: ExecutionEngine;
  policy?: PolicyEngine;
  agents?: AgentRegistry;
  models?: ModelRegistry;
  runtimes?: RuntimeRegistry;
  computers?: ComputerRegistry;
  /** Shared job store. If omitted, a new in-process JobManager is created and held for the orchestrator's lifetime. */
  jobManager?: JobManager;
  taskExecutor?: JobTaskExecutor;
}

export interface OrchestratorTaskAssignment {
  jobId: string;
  taskId: string;
  agentId: string;
  modelId: string;
  runtimeId: string;
  computerId: string;
  scheduleInput: ScheduleInput;
}

interface ActiveJobHandle {
  abort: AbortController;
  activeTasks: Map<string, AbortController>;
  /** Tasks whose task:cancelled has already been emitted (by cancelJob/cancelTask), so the
   *  post-executor abort branch doesn't announce the same cancellation a second time. */
  cancelledTaskIds: Set<string>;
  resolve: (job: Job) => void;
  reject: (err: Error) => void;
}

export class JobOrchestrator {
  private readonly scheduler: Scheduler;
  private readonly executionEngine: ExecutionEngine;
  private readonly jobManager: JobManager;
  private readonly taskExecutor?: JobTaskExecutor;

  private readonly listeners = new Map<string, Set<(event: JobOrchestratorEvent) => void>>();
  private readonly steeringQueues = new Map<string, string[]>();
  private readonly activeJobs = new Map<string, ActiveJobHandle>();

  constructor(options: JobOrchestratorOptions) {
    this.scheduler = options.scheduler;
    this.executionEngine = options.executionEngine;
    this.jobManager = options.jobManager ?? new JobManager();
    this.taskExecutor = options.taskExecutor;
  }

  getJobManager(): JobManager {
    return this.jobManager;
  }

  async createJob(params: {
    title: string;
    description?: string;
    tasks: JobTaskInput[];
    priority?: Job['priority'];
    concurrencyLimit?: number;
    maxRetries?: number;
    timeoutSeconds?: number;
  }): Promise<Job> {
    return this.jobManager.create(params);
  }

  getJob(id: string): Job | undefined {
    return this.jobManager.get(id);
  }

  listJobs(): Job[] {
    return this.jobManager.list();
  }

  subscribe(jobId: string, listener: (event: JobOrchestratorEvent) => void): () => void {
    let set = this.listeners.get(jobId);
    if (!set) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(jobId);
      if (current) {
        current.delete(listener);
        if (current.size === 0) {
          this.listeners.delete(jobId);
        }
      }
    };
  }

  private emit(jobId: string, event: JobOrchestratorEvent): void {
    event.timestamp = event.timestamp ?? new Date();
    const set = this.listeners.get(jobId);
    if (set) {
      for (const listener of set) {
        try {
          listener(event);
        } catch {
          // Ignore subscriber errors
        }
      }
    }
  }

  steerTask(jobId: string, taskId: string, instruction: string): void {
    const job = this.jobManager.get(jobId);
    const task = job?.tasks.find((t) => t.id === taskId);
    if (task && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')) {
      return;
    }
    let queue = this.steeringQueues.get(taskId);
    if (!queue) {
      queue = [];
      this.steeringQueues.set(taskId, queue);
    }
    queue.push(instruction);
    this.emit(jobId, {
      type: 'task:steered',
      jobId,
      taskId,
      instruction,
    });
  }

  steerJob(jobId: string, instruction: string): void {
    const job = this.jobManager.get(jobId);
    if (!job) return;
    const handle = this.activeJobs.get(jobId);
    if (handle) {
      for (const taskId of handle.activeTasks.keys()) {
        this.steerTask(jobId, taskId, instruction);
      }
    }
  }

  async assignTask(jobId: string, taskId: string): Promise<OrchestratorTaskAssignment | null> {
    const job = this.jobManager.get(jobId);

    if (!job) {
      throw new Error(`Job '${jobId}' not found`);
    }

    const task = job.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found in job '${jobId}'`);
    }

    const scheduleInput: ScheduleInput = {
      task,
      requiredContextTokens: undefined,
    };

    const decision = this.scheduler.plan(scheduleInput);

    if (!decision.agentId || !decision.modelId || !decision.runtimeId || !decision.computerId) {
      return null;
    }

    await this.executionEngine.create({
      task,
      agentId: decision.agentId,
      computerId: decision.computerId,
      runtimeId: decision.runtimeId,
      modelId: decision.modelId,
      scheduling: decision,
    });

    return {
      jobId,
      taskId,
      agentId: decision.agentId,
      modelId: decision.modelId,
      runtimeId: decision.runtimeId,
      computerId: decision.computerId,
      scheduleInput,
    };
  }

  async executeTask(assignment: OrchestratorTaskAssignment): Promise<void> {
    const record = await this.executionEngine.create({
      task: { id: assignment.taskId } as Task,
      agentId: assignment.agentId,
      computerId: assignment.computerId,
      runtimeId: assignment.runtimeId,
      modelId: assignment.modelId,
    });

    await this.executionEngine.setStatus(record.execution.id, 'scheduled');
  }

  async completeTask(jobId: string, taskId: string, result?: unknown): Promise<void> {
    await this.jobManager.completeTask(jobId, taskId, result);
  }

  async failTask(
    jobId: string,
    taskId: string,
    error: string,
    retryCount?: number,
  ): Promise<void> {
    await this.jobManager.failTask(jobId, taskId, error, retryCount);
  }

  async cancelTask(jobId: string, taskId: string): Promise<void> {
    const handle = this.activeJobs.get(jobId);
    if (handle) {
      const taskAbort = handle.activeTasks.get(taskId);
      if (taskAbort) {
        taskAbort.abort();
        handle.activeTasks.delete(taskId);
      }
      handle.cancelledTaskIds.add(taskId);
    }
    const job = this.jobManager.get(jobId);
    if (job) {
      await this.jobManager.updateTaskStatus(jobId, taskId, 'cancelled');
      await this.jobManager.updateAgentState(jobId, taskId, 'cancelled', undefined, 'Cancelled by user');
    }
    this.emit(jobId, { type: 'task:cancelled', jobId, taskId });
  }

  /**
   * @param reason Set when the system (not a person) is doing the cancelling — e.g. the
   *   job timeout — so subscribers can say "stopped: exceeded the 300s timeout" instead
   *   of the misleading "cancelled by operator".
   */
  async cancelJob(jobId: string, reason?: string): Promise<void> {
    const handle = this.activeJobs.get(jobId);
    if (handle) {
      handle.abort.abort();
      for (const [taskId, taskAbort] of handle.activeTasks.entries()) {
        taskAbort.abort();
        handle.cancelledTaskIds.add(taskId);
        this.emit(jobId, { type: 'task:cancelled', jobId, taskId, error: reason });
      }
      handle.activeTasks.clear();
    }
    await this.jobManager.cancel(jobId);
    this.emit(jobId, { type: 'job:cancelled', jobId, error: reason });
  }

  async resumeJob(jobId: string): Promise<void> {
    await this.jobManager.resume(jobId);
    this.emit(jobId, { type: 'job:resumed', jobId });
  }

  /** Permanently removes a job's record. Throws if it's still running/ready/planning. */
  async deleteJob(jobId: string): Promise<boolean> {
    if (this.activeJobs.has(jobId)) {
      throw new Error(`Cannot delete job '${jobId}' while it is still running — cancel it first`);
    }
    const deleted = await this.jobManager.delete(jobId);
    this.listeners.delete(jobId);
    return deleted;
  }

  /**
   * Runs the full Job DAG, respecting concurrency limits, dependency edges,
   * hardware capacity, and retry bounds.
   */
  async runJob(jobId: string, options: JobRunOptions = {}): Promise<Job> {
    const job = this.jobManager.get(jobId);
    if (!job) {
      throw new Error(`Job '${jobId}' not found`);
    }

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`Cannot run job in status '${job.status}'`);
    }

    const executor = options.taskExecutor ?? this.taskExecutor;
    if (!executor) {
      throw new Error(`No task executor provided to JobOrchestrator for job '${jobId}'`);
    }

    if (options.onEvent) {
      this.subscribe(jobId, options.onEvent);
    }

    const concurrencyLimit = Math.max(1, options.concurrencyLimit ?? job.concurrencyLimit ?? 4);
    await this.jobManager.setJobStatus(job.id, 'running', { startedAt: job.startedAt ?? new Date() });

    const jobAbortController = new AbortController();
    if (options.signal) {
      options.signal.addEventListener('abort', () => jobAbortController.abort());
    }

    const activeTasks = new Map<string, AbortController>();
    const retryCounts = new Map<string, number>();
    const supersededTaskIds = new Set<string>();

    this.emit(jobId, { type: 'job:started', jobId });

    // No default: a job runs indefinitely unless a caller (job definition or
    // this run's options) explicitly sets timeoutSeconds. Local models can
    // legitimately take many minutes per turn — an unrequested time limit
    // was cancelling otherwise-progressing jobs mid-repair.
    const timeoutSeconds = options.timeoutSeconds ?? job.timeoutSeconds;
    let timedOut = false;

    return new Promise<Job>((resolve, reject) => {
      const handle: ActiveJobHandle = {
        abort: jobAbortController,
        activeTasks,
        cancelledTaskIds: new Set(),
        resolve,
        reject,
      };
      this.activeJobs.set(jobId, handle);

      // Reuses cancelJob() rather than aborting jobAbortController directly, so a timeout
      // gets exactly the same cleanup a manual cancel already gets — every active task's
      // own AbortController is aborted too, not just the top-level job one.
      const timeoutTimer =
        timeoutSeconds !== undefined
          ? setTimeout(() => {
              timedOut = true;
              void this.cancelJob(jobId, `exceeded the ${timeoutSeconds}s timeout`);
            }, Math.max(1, timeoutSeconds) * 1000)
          : undefined;
      timeoutTimer?.unref?.();

      let isFinished = false;

      const finishJob = async (finalStatus: 'completed' | 'failed' | 'cancelled') => {
        if (isFinished) return;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (timedOut) {
          finalStatus = 'failed';
          // The per-task abort handler above (see taskAbort.signal.aborted) already marks
          // an in-flight task/node 'cancelled' as a mechanical side effect of reusing
          // cancelJob() to actually stop it — that's not a genuine user cancellation, so
          // it's overridden here too (unlike the ordinary non-timeout path below, which
          // leaves a real cancellation as 'cancelled').
          const reason = `Task exceeded the ${timeoutSeconds}s timeout and was automatically stopped`;
          for (const node of job.graph.nodes) {
            if (node.state !== 'completed' && node.state !== 'failed') {
              node.state = 'failed';
              node.error = node.error ?? reason;
              node.completedAt = node.completedAt ?? new Date();
            }
          }
          for (const task of job.tasks) {
            if (task.status !== 'completed' && task.status !== 'failed') {
              task.status = 'failed';
            }
          }
        } else if (job.status === 'cancelled' || jobAbortController.signal.aborted) {
          finalStatus = 'cancelled';
        }
        isFinished = true;
        const completedAt = new Date();
        await this.jobManager.setJobStatus(job.id, finalStatus, { completedAt });
        this.activeJobs.delete(jobId);

        if (finalStatus === 'completed') {
          this.emit(jobId, { type: 'job:completed', jobId });
        } else if (timedOut) {
          this.emit(jobId, { type: 'job:failed', jobId, error: `Timed out after ${timeoutSeconds}s` });
        } else if (finalStatus === 'cancelled') {
          this.emit(jobId, { type: 'job:cancelled', jobId });
        } else {
          this.emit(jobId, { type: 'job:failed', jobId, error: 'One or more tasks failed' });
        }

        resolve(job);
      };

      let isPumping = false;
      let scheduledPump = false;

      const pump = async () => {
        if (isFinished) return;
        if (isPumping) {
          scheduledPump = true;
          return;
        }
        isPumping = true;
        try {
          while (!isFinished) {
            scheduledPump = false;
            await doPump();
            if (!scheduledPump) break;
          }
        } finally {
          isPumping = false;
        }
      };

      const doPump = async () => {
        if (isFinished) return;

        if (jobAbortController.signal.aborted || job.status === 'cancelled') {
          await finishJob('cancelled');
          return;
        }

        // 1. Check for failed dependencies and fail blocked nodes (cascade until fixed point)
        let changed = true;
        while (changed) {
          changed = false;
          for (const node of job.graph.nodes) {
            if (node.state === 'idle') {
              const taskId = node.taskId ?? node.id;
              if (this.jobManager.hasFailedDependency(job, taskId)) {
                node.state = 'failed';
                node.error = 'Dependency failed';
                await this.jobManager.updateAgentState(job.id, node.id, 'failed', undefined, 'Dependency failed');
                await this.jobManager.updateTaskStatus(job.id, taskId, 'failed');
                this.emit(jobId, { type: 'task:failed', jobId, taskId, error: 'Dependency failed' });
                changed = true;
              }
            }
          }
        }

        // 2. Find ready nodes (idle with all dependencies completed)
        const readyNodes = job.graph.nodes.filter((node) => {
          if (node.state !== 'idle') return false;
          return this.jobManager.dependenciesSatisfied(job, node.taskId ?? node.id);
        });

        // 3. Dispatch ready nodes up to concurrency limit
        while (activeTasks.size < concurrencyLimit && readyNodes.length > 0 && !isFinished) {
          const node = readyNodes.shift()!;
          const taskId = node.taskId ?? node.id;
          const task = job.tasks.find((t) => t.id === taskId);
          if (!task) continue;

          const taskAbort = new AbortController();
          activeTasks.set(taskId, taskAbort);

          let assignment: OrchestratorTaskAssignment | null = null;
          try {
            assignment = await this.assignTask(job.id, taskId);
          } catch (err) {
            activeTasks.delete(taskId);
            const errMessage = err instanceof Error ? err.message : String(err);
            node.state = 'failed';
            node.error = errMessage;
            await this.jobManager.updateAgentState(job.id, node.id, 'failed', undefined, errMessage);
            await this.jobManager.updateTaskStatus(job.id, taskId, 'failed');
            this.emit(jobId, { type: 'task:failed', jobId, taskId, error: errMessage });
            continue;
          }

          if (!assignment) {
            // Placement unavailable right now; wait for free resources
            activeTasks.delete(taskId);
            readyNodes.unshift(node);
            break;
          }

          node.state = 'running';
          node.executedAt = new Date();
          await this.jobManager.updateAgentState(job.id, node.id, 'running');
          await this.jobManager.updateTaskStatus(job.id, taskId, 'running');

          this.emit(jobId, {
            type: 'task:started',
            jobId,
            taskId,
            agentId: assignment.agentId,
            computerId: assignment.computerId,
            modelId: assignment.modelId,
          });

          // Run task execution asynchronously
          void (async () => {
            try {
              const executionContext: JobTaskExecutionContext = {
                jobId,
                taskId,
                node,
                assignment: {
                  jobId,
                  taskId,
                  agentId: assignment.agentId,
                  modelId: assignment.modelId,
                  runtimeId: assignment.runtimeId,
                  computerId: assignment.computerId,
                  assignedAt: new Date(),
                  policy: [],
                },
                signal: taskAbort.signal,
                onProgress: (ev) => {
                  this.emit(jobId, {
                    type: 'task:progress',
                    jobId,
                    taskId,
                    phase: ev.phase,
                    event: ev,
                  });
                },
                getSteeringInstruction: () => {
                  const queue = this.steeringQueues.get(taskId);
                  return queue && queue.length > 0 ? queue.shift() : undefined;
                },
              };

              const outcome: JobTaskOutcome = await executor(task, executionContext);

              if (taskAbort.signal.aborted) {
                await this.jobManager.updateTaskStatus(job.id, taskId, 'cancelled');
                await this.jobManager.updateAgentState(job.id, node.id, 'cancelled');
                // cancelJob()/cancelTask() already emitted this task's cancellation (with
                // the reason, when there was one) at the moment it happened; emitting
                // again here when the executor finally returns produced a second,
                // reason-less "cancelled by operator" line for every cancel/timeout.
                if (!handle.cancelledTaskIds.has(taskId)) {
                  this.emit(jobId, { type: 'task:cancelled', jobId, taskId });
                }
              } else if (outcome.success) {
                await this.completeTask(job.id, taskId, outcome.result);
                this.emit(jobId, {
                  type: 'task:completed',
                  jobId,
                  taskId,
                  result: outcome.result,
                  filesChanged: outcome.filesChanged,
                  usage: outcome.usage,
                });
              } else {
                // Prefer the executor's own structured classification when it set one —
                // falls back to sniffing the free-text error/reasons for executors (or
                // thrown-exception paths) that don't.
                const isPolicyDenial = outcome.errorKind
                  ? outcome.errorKind === 'policy'
                  : Boolean(
                      outcome.error?.toLowerCase().includes('policy') ||
                      outcome.error?.toLowerCase().includes('denied') ||
                      outcome.reasons?.some((r) => r.toLowerCase().includes('policy') || r.toLowerCase().includes('deny')),
                    );

                if (options.replanner && !isPolicyDenial) {
                  try {
                    const replanResult = await options.replanner({
                      job,
                      failedTask: task,
                      node,
                      outcome,
                    });
                    if (replanResult?.repairTasks && replanResult.repairTasks.length > 0) {
                      node.state = 'failed';
                      node.error = `Superseded by repair plan: ${outcome.error ?? 'Task failed'}`;
                      await this.jobManager.updateAgentState(job.id, node.id, 'failed', undefined, node.error);
                      await this.jobManager.updateTaskStatus(job.id, taskId, 'failed');
                      supersededTaskIds.add(taskId);

                      const added = await this.jobManager.addTasksToJob(job.id, replanResult.repairTasks, {
                        replacesTaskId: taskId,
                      });

                      this.emit(jobId, {
                        type: 'task:replan',
                        jobId,
                        taskId,
                        error: outcome.error,
                        event: { repairTaskIds: added.map((t) => t.id) },
                      });
                      return;
                    }
                  } catch {
                    // Fall back to standard retry on replanner failure
                  }
                }

                const retries = retryCounts.get(taskId) ?? 0;
                const maxRetries = isPolicyDenial ? 0 : (job.maxRetries ?? 3);
                if (retries < maxRetries) {
                  retryCounts.set(taskId, retries + 1);
                  if (!node.attempts) node.attempts = [];
                  node.attempts.push({
                    state: 'failed',
                    error: outcome.error,
                    executedAt: node.executedAt,
                    completedAt: new Date()
                  });
                  node.executedAt = undefined;
                  node.completedAt = undefined;
                  node.error = undefined;
                  node.result = undefined;
                  node.state = 'idle';
                  await this.jobManager.updateAgentState(job.id, node.id, 'idle');
                  await this.jobManager.updateTaskStatus(job.id, taskId, 'pending');
                  this.emit(jobId, {
                    type: 'task:retry',
                    jobId,
                    taskId,
                    retryCount: retries + 1,
                    maxRetries,
                  });
                } else {
                  node.state = 'failed';
                  node.error = outcome.error ?? 'Task failed';
                  await this.failTask(job.id, taskId, outcome.error ?? 'Task failed', Infinity);
                  this.emit(jobId, {
                    type: 'task:failed',
                    jobId,
                    taskId,
                    error: outcome.error ?? 'Task failed',
                  });
                }
              }
            } catch (err) {
              const errMessage = err instanceof Error ? err.message : String(err);
              if (taskAbort.signal.aborted) {
                await this.jobManager.updateTaskStatus(job.id, taskId, 'cancelled');
                await this.jobManager.updateAgentState(job.id, node.id, 'cancelled');
                this.emit(jobId, { type: 'task:cancelled', jobId, taskId });
              } else {
                const isPolicyDenial = errMessage.toLowerCase().includes('policy') || errMessage.toLowerCase().includes('denied');
                const retries = retryCounts.get(taskId) ?? 0;
                const maxRetries = isPolicyDenial ? 0 : (job.maxRetries ?? 3);
                if (retries < maxRetries) {
                  retryCounts.set(taskId, retries + 1);
                  if (!node.attempts) node.attempts = [];
                  node.attempts.push({
                    state: 'failed',
                    error: errMessage,
                    executedAt: node.executedAt,
                    completedAt: new Date()
                  });
                  node.executedAt = undefined;
                  node.completedAt = undefined;
                  node.error = undefined;
                  node.result = undefined;
                  node.state = 'idle';
                  await this.jobManager.updateAgentState(job.id, node.id, 'idle');
                  await this.jobManager.updateTaskStatus(job.id, taskId, 'pending');
                  this.emit(jobId, {
                    type: 'task:retry',
                    jobId,
                    taskId,
                    retryCount: retries + 1,
                    maxRetries,
                  });
                } else {
                  node.state = 'failed';
                  node.error = errMessage;
                  await this.failTask(job.id, taskId, errMessage, Infinity);
                  this.emit(jobId, {
                    type: 'task:failed',
                    jobId,
                    taskId,
                    error: errMessage,
                  });
                }
              }
            } finally {
              activeTasks.delete(taskId);
              this.steeringQueues.delete(taskId);
              void pump();
            }
          })();
        }

        // 4. Check termination: no active tasks running
        const anyRunning = job.graph.nodes.some((n) => n.state === 'running');
        if (activeTasks.size === 0 && !anyRunning && !isFinished) {
          const allFinished = job.graph.nodes.every(
            (n) => n.state === 'completed' || n.state === 'failed' || n.state === 'cancelled',
          );
          if (allFinished) {
            const anyFailed = job.graph.nodes.some(
              (n) => n.state === 'failed' && !supersededTaskIds.has(n.taskId ?? n.id),
            );
            await finishJob(anyFailed ? 'failed' : 'completed');
            return;
          }

          // Deadlock / unresolvable dependency detection
          const remainingIdle = job.graph.nodes.filter((n) => n.state === 'idle');
          if (remainingIdle.length > 0 && readyNodes.length === 0) {
            for (const deadNode of remainingIdle) {
              const hasFailedDep = this.jobManager.hasFailedDependency(job, deadNode.taskId ?? deadNode.id);
              deadNode.state = 'failed';
              deadNode.error = hasFailedDep ? 'Dependency failed' : 'Unresolvable dependencies / deadlock';
              await this.jobManager.updateAgentState(job.id, deadNode.id, 'failed', undefined, deadNode.error);
              await this.jobManager.updateTaskStatus(job.id, deadNode.taskId ?? deadNode.id, 'failed');
              this.emit(jobId, {
                type: 'task:failed',
                jobId,
                taskId: deadNode.taskId ?? deadNode.id,
                error: deadNode.error,
              });
            }
            await finishJob('failed');
          }
        }
      };

      void pump();
    });
  }

  async getJobRollup(jobId: string): Promise<JobRollup> {
    const job = this.jobManager.get(jobId);
    if (!job) {
      throw new Error(`Job '${jobId}' not found`);
    }

    const totalUsage: { input: number; output: number; total: number } = { input: 0, output: 0, total: 0 };
    const computersUsed = new Set<string>();
    const modelsUsed = new Set<string>();
    const filesChanged = new Set<string>();

    let completedTasks = 0;
    let failedTasks = 0;
    let runningTasks = 0;
    let queuedTasks = 0;

    for (const task of job.tasks) {
      const records = await this.executionEngine.listByTask(task.id);
      for (const r of records) {
        if (r.usage) {
          totalUsage.input += r.usage.input;
          totalUsage.output += r.usage.output;
          totalUsage.total += r.usage.total ?? r.usage.input + r.usage.output;
        }
        if (r.execution.computerId) computersUsed.add(r.execution.computerId);
        if (r.execution.modelId) modelsUsed.add(r.execution.modelId);
        for (const f of r.filesChanged ?? []) {
          filesChanged.add(f);
        }
      }

      if (task.status === 'completed') completedTasks++;
      else if (task.status === 'failed') failedTasks++;
      else if (task.status === 'running') runningTasks++;
      else queuedTasks++;
    }

    const started = job.startedAt?.getTime() ?? job.createdAt.getTime();
    const completed = job.completedAt?.getTime() ?? Date.now();
    const durationMs = Math.max(0, completed - started);

    // Rough cost estimate: $0.002 / 1k tokens for cloud/API fallback, 0 for local
    const estimatedCostUsd = (totalUsage.total / 1000) * 0.002;
    const jobTokensPerSecond = tokensPerSecond(totalUsage.output, durationMs);

    return {
      jobId,
      taskCount: job.tasks.length,
      completedTasks,
      failedTasks,
      runningTasks,
      queuedTasks,
      tokens: totalUsage,
      durationMs,
      estimatedCostUsd,
      tokensPerSecond: jobTokensPerSecond,
      computersUsed: Array.from(computersUsed),
      modelsUsed: Array.from(modelsUsed),
      filesChanged: Array.from(filesChanged),
    };
  }
}

export function createJobOrchestrator(options: JobOrchestratorOptions): JobOrchestrator {
  return new JobOrchestrator(options);
}
