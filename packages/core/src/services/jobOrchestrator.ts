import { randomUUID } from 'node:crypto';
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
  TaskResourceLocks,
  TokenUsage,
  ExecutionCheckpoint,
  CheckpointCreateOptions,
  ForkExecutionResult,
  RollbackResult,
} from '../types/index.js';
import type { CoordinationEventType, ResourceLease } from '../types/coordination.js';
import { tokensPerSecond } from '@wazir/shared';
import { JobManager, type JobTaskInput } from './jobManager.js';
import type { Scheduler, ScheduleInput } from './scheduler.js';
import type { ExecutionEngine } from './executionEngine.js';
import type { PolicyEngine } from './policyEngine.js';
import type { AgentRegistry } from './agentRegistry.js';
import type { ModelRegistry } from './modelRegistry.js';
import type { RuntimeRegistry } from './runtimeRegistry.js';
import type { ComputerRegistry } from './computerRegistry.js';
import type { CheckpointService } from './checkpointService.js';
import type { CoordinationFabric } from './coordinationFabric.js';
import type { MessageRouter } from './messageRouter.js';
import {
  ResourceConflictError,
  ResourceLeaseExpiredError,
  StaleFencingTokenError,
  type ReservationRequest,
  type ResourceReservationManager,
} from './resourceReservationManager.js';

export interface JobOrchestratorOptions {
  scheduler: Scheduler;
  executionEngine: ExecutionEngine;
  checkpointService?: CheckpointService;
  policy?: PolicyEngine;
  agents?: AgentRegistry;
  models?: ModelRegistry;
  runtimes?: RuntimeRegistry;
  computers?: ComputerRegistry;
  /** Shared job store. If omitted, a new in-process JobManager is created and held for the orchestrator's lifetime. */
  jobManager?: JobManager;
  taskExecutor?: JobTaskExecutor;
  coordinationFabric?: CoordinationFabric;
  messageRouter?: MessageRouter;
  resourceReservations?: ResourceReservationManager;
  workerId?: string;
}

export interface OrchestratorTaskAssignment {
  jobId: string;
  taskId: string;
  executionId: string;
  agentId: string;
  modelId: string;
  runtimeId: string;
  /** Absent for an assignment routed to a hosted provider (no Computer). */
  computerId?: string;
  scheduleInput: ScheduleInput;
}

interface ActiveJobHandle {
  abort: AbortController;
  activeTasks: Map<string, AbortController>;
  activeExecutions: Map<string, string>;
  /** Tasks whose task:cancelled has already been emitted (by cancelJob/cancelTask), so the
   *  post-executor abort branch doesn't announce the same cancellation a second time. */
  cancelledTaskIds: Set<string>;
  /** Tasks aborted because their worker stopped heartbeating (reportExecutionOrphaned), not
   *  because anyone asked to cancel them — these go through retry, not the cancelled path. */
  orphanedTaskIds: Set<string>;
  /** Re-enters the pump loop on demand — pump() is otherwise only re-triggered reactively
   *  by a task finishing, so an external pauseJob()/resumeJob() (which change job.status
   *  without any task completing) need this to make the change take effect immediately
   *  rather than waiting for whatever task happens to finish next (or never, once paused
   *  with nothing in flight). */
  wakePump?: () => void;
  jobCancelledEmitted?: boolean;
  resolve: (job: Job) => void;
  reject: (err: Error) => void;
}

export class JobOrchestrator {
  private readonly scheduler: Scheduler;
  private readonly executionEngine: ExecutionEngine;
  private readonly jobManager: JobManager;
  private readonly taskExecutor?: JobTaskExecutor;
  private checkpointService?: CheckpointService;
  private readonly coordinationFabric?: CoordinationFabric;
  private readonly messageRouter?: MessageRouter;
  private readonly resourceReservations?: ResourceReservationManager;
  private readonly workerId: string;

  private readonly listeners = new Map<string, Set<(event: JobOrchestratorEvent) => void>>();
  private readonly steeringQueues = new Map<string, string[]>();
  private readonly activeJobs = new Map<string, ActiveJobHandle>();

  constructor(options: JobOrchestratorOptions) {
    this.scheduler = options.scheduler;
    this.executionEngine = options.executionEngine;
    this.checkpointService = options.checkpointService;
    this.jobManager = options.jobManager ?? new JobManager();
    this.taskExecutor = options.taskExecutor;
    this.coordinationFabric = options.coordinationFabric;
    this.messageRouter = options.messageRouter;
    this.resourceReservations = options.resourceReservations;
    this.workerId = options.workerId ?? `orchestrator-${randomUUID()}`;
  }

  setCheckpointService(checkpointService: CheckpointService): void {
    this.checkpointService = checkpointService;
  }

  getCheckpointService(): CheckpointService | undefined {
    return this.checkpointService;
  }

  getJobManager(): JobManager {
    return this.jobManager;
  }

  getCoordinationFabric(): CoordinationFabric | undefined {
    return this.coordinationFabric;
  }

  getMessageRouter(): MessageRouter | undefined {
    return this.messageRouter;
  }

  getResourceReservations(): ResourceReservationManager | undefined {
    return this.resourceReservations;
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
    const job = this.jobManager.create(params);
    await this.jobManager.save(job.id);
    return job;
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

  private publishCoordinationEvent(event: {
    type: CoordinationEventType;
    workflowId: string;
    taskId?: string;
    agentId?: string;
    workerId?: string;
    fencingToken?: number;
    payload?: Record<string, unknown>;
  }): void {
    if (!this.coordinationFabric) return;
    try {
      void Promise.resolve(
        this.coordinationFabric.publish({
          type: event.type,
          workflowId: event.workflowId,
          taskId: event.taskId,
          sourceAgent: event.agentId ?? event.workerId ?? this.workerId,
          fencingToken: event.fencingToken,
          payload: event.payload ?? {},
        }),
      ).catch(() => undefined);
    } catch {
      // Never let coordination fabric failures crash the orchestrator
    }
  }

  private extractTaskResourceLocks(node: JobNode, task: Task): TaskResourceLocks | undefined {
    const rawTask = task as unknown as {
      resourceLocks?: TaskResourceLocks;
      workspacePaths?: Array<{ path: string; mode: 'read' | 'write' }>;
      exclusiveResources?: string[];
      metadata?: Record<string, unknown>;
    };
    const meta = {
      ...(rawTask.metadata ?? {}),
      ...(node.metadata ?? {}),
    } as Record<string, unknown>;
    const metaLocks = (meta.resourceLocks as TaskResourceLocks | undefined) ?? undefined;
    const base = node.resourceLocks ?? rawTask.resourceLocks ?? metaLocks;

    const workspacePaths =
      base?.workspacePaths ??
      rawTask.workspacePaths ??
      (Array.isArray(meta.workspacePaths)
        ? (meta.workspacePaths as Array<{ path: string; mode: 'read' | 'write' }>)
        : undefined);
    const exclusiveResources =
      base?.exclusiveResources ??
      rawTask.exclusiveResources ??
      (Array.isArray(meta.exclusiveResources) ? (meta.exclusiveResources as string[]) : undefined);
    const gitRepos =
      base?.gitRepos ??
      (Array.isArray(meta.gitRepos)
        ? (meta.gitRepos as Array<{ repoPath: string; mode?: 'read' | 'write' }>)
        : typeof meta.repoPath === 'string'
          ? [{ repoPath: meta.repoPath, mode: (meta.repoMode as 'read' | 'write' | undefined) ?? 'write' }]
          : undefined);
    const worktrees =
      base?.worktrees ??
      (Array.isArray(meta.worktrees)
        ? (meta.worktrees as Array<{ worktreePath: string; mode?: 'read' | 'write' }>)
        : typeof meta.worktreePath === 'string'
          ? [{ worktreePath: meta.worktreePath, mode: (meta.worktreeMode as 'read' | 'write' | undefined) ?? 'write' }]
          : typeof meta.worktreeDir === 'string'
            ? [{ worktreePath: meta.worktreeDir, mode: (meta.worktreeMode as 'read' | 'write' | undefined) ?? 'write' }]
            : undefined);
    const gpuSlots =
      base?.gpuSlots ??
      (Array.isArray(meta.gpuSlots)
        ? (meta.gpuSlots as Array<{ computerId: string; gpuId?: string; gpuMemoryGB?: number }>)
        : undefined);
    const modelSlots =
      base?.modelSlots ??
      (Array.isArray(meta.modelSlots)
        ? (meta.modelSlots as Array<{ runtimeId: string; modelId: string; maxConcurrentSlots?: number }>)
        : undefined);
    const computeBudgets =
      base?.computeBudgets ??
      (Array.isArray(meta.computeBudgets)
        ? (meta.computeBudgets as Array<{ computerId: string; cpuCores?: number; memoryGB?: number }>)
        : undefined);
    const cpuCores = base?.cpuCores ?? (typeof meta.cpuCores === 'number' ? meta.cpuCores : undefined);
    const memoryGB = base?.memoryGB ?? (typeof meta.memoryGB === 'number' ? meta.memoryGB : undefined);
    const gpuMemoryGB = base?.gpuMemoryGB ?? (typeof meta.gpuMemoryGB === 'number' ? meta.gpuMemoryGB : undefined);

    if (
      !workspacePaths?.length &&
      !exclusiveResources?.length &&
      !gitRepos?.length &&
      !worktrees?.length &&
      !gpuSlots?.length &&
      !modelSlots?.length &&
      !computeBudgets?.length &&
      cpuCores === undefined &&
      memoryGB === undefined &&
      gpuMemoryGB === undefined
    ) {
      return undefined;
    }

    return {
      ...(workspacePaths?.length ? { workspacePaths } : {}),
      ...(exclusiveResources?.length ? { exclusiveResources } : {}),
      ...(gitRepos?.length ? { gitRepos } : {}),
      ...(worktrees?.length ? { worktrees } : {}),
      ...(gpuSlots?.length ? { gpuSlots } : {}),
      ...(modelSlots?.length ? { modelSlots } : {}),
      ...(computeBudgets?.length ? { computeBudgets } : {}),
      ...(cpuCores !== undefined ? { cpuCores } : {}),
      ...(memoryGB !== undefined ? { memoryGB } : {}),
      ...(gpuMemoryGB !== undefined ? { gpuMemoryGB } : {}),
    };
  }

  private locksRequireComputerId(locks: TaskResourceLocks): boolean {
    const needsComputeComputer =
      (locks.cpuCores !== undefined || locks.memoryGB !== undefined) && !locks.computeBudgets?.length;
    const needsGpuComputer = locks.gpuMemoryGB !== undefined && !locks.gpuSlots?.length;
    return needsComputeComputer || needsGpuComputer;
  }

  private buildReservationRequest(
    jobId: string,
    taskId: string,
    locks: TaskResourceLocks,
    computerId?: string,
  ): ReservationRequest | undefined {
    const gpuSlots =
      locks.gpuSlots ??
      (locks.gpuMemoryGB !== undefined && computerId
        ? [{ computerId, gpuMemoryGB: locks.gpuMemoryGB }]
        : undefined);
    const computeBudgets =
      locks.computeBudgets ??
      ((locks.cpuCores !== undefined || locks.memoryGB !== undefined) && computerId
        ? [{ computerId, cpuCores: locks.cpuCores, memoryGB: locks.memoryGB }]
        : undefined);

    if (
      !locks.workspacePaths?.length &&
      !locks.exclusiveResources?.length &&
      !locks.gitRepos?.length &&
      !locks.worktrees?.length &&
      !gpuSlots?.length &&
      !locks.modelSlots?.length &&
      !computeBudgets?.length
    ) {
      return undefined;
    }

    return {
      workerId: this.workerId,
      workflowId: jobId,
      taskId,
      ...(locks.workspacePaths?.length ? { workspacePaths: locks.workspacePaths } : {}),
      ...(locks.exclusiveResources?.length ? { exclusiveResources: locks.exclusiveResources } : {}),
      ...(locks.gitRepos?.length ? { gitRepos: locks.gitRepos } : {}),
      ...(locks.worktrees?.length ? { worktrees: locks.worktrees } : {}),
      ...(gpuSlots?.length ? { gpuSlots } : {}),
      ...(locks.modelSlots?.length ? { modelSlots: locks.modelSlots } : {}),
      ...(computeBudgets?.length ? { computeBudgets } : {}),
    };
  }

  private async unknownMutationError(taskId: string): Promise<string | undefined> {
    for (const record of await this.executionEngine.listByTask(taskId)) {
      const call = this.executionEngine.findUnknownOutcomeToolCall(record.execution.id);
      if (call && call.sideEffectClass !== 'READ_ONLY') {
        return `[TOOL_OUTCOME_UNKNOWN] Tool call '${call.tool}' (${call.callId}) has an unresolved side effect`;
      }
    }
    return undefined;
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
    this.publishCoordinationEvent({
      type: 'task.steered',
      workflowId: jobId,
      taskId,
      workerId: this.workerId,
      payload: { jobId, taskId, instruction },
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

    // computerId is deliberately not required here: a hosted-provider
    // placement (Anthropic/OpenAI/Google) has no Computer by design. Treating
    // its absence as "placement unavailable" would silently loop this task
    // forever as "waiting for free resources" (see the dispatch loop below)
    // instead of ever executing it.
    if (!decision.agentId || !decision.modelId || !decision.runtimeId) {
      return null;
    }

    const record = await this.executionEngine.create({
      task,
      jobId,
      agentId: decision.agentId,
      computerId: decision.computerId,
      runtimeId: decision.runtimeId,
      modelId: decision.modelId,
      scheduling: decision,
    });

    return {
      jobId,
      taskId,
      executionId: record.execution.id,
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

  async retryTask(jobId: string, taskId: string): Promise<void> {
    const job = this.jobManager.get(jobId);
    if (!job) throw new Error(`Job '${jobId}' not found`);
    if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') {
      throw new Error(`Cannot retry task in terminal job status '${job.status}'`);
    }
    await this.jobManager.retryTask(jobId, taskId);
    this.activeJobs.get(jobId)?.wakePump?.();
  }

  async cancelTask(jobId: string, taskId: string): Promise<void> {
    const job = this.jobManager.get(jobId);
    // A task that already finished keeps its outcome; cancelJob() applies the same rule.
    const status = job?.tasks.find((t) => t.id === taskId)?.status;
    if (status === 'completed' || status === 'failed') return;
    const handle = this.activeJobs.get(jobId);
    if (handle) {
      const taskAbort = handle.activeTasks.get(taskId);
      if (taskAbort) {
        taskAbort.abort();
        handle.activeTasks.delete(taskId);
        const executionId = handle.activeExecutions.get(taskId);
        if (executionId) await this.cancelExecution(executionId);
      }
      if (handle.cancelledTaskIds.has(taskId)) return;
      handle.cancelledTaskIds.add(taskId);
    } else if (status === 'cancelled') {
      return;
    }
    if (job) {
      if (status !== 'cancelled') {
        await this.jobManager.updateTaskStatus(jobId, taskId, 'cancelled');
      }
      await this.jobManager.updateAgentState(jobId, taskId, 'cancelled', undefined, 'Cancelled by user');
    }
    this.emit(jobId, { type: 'task:cancelled', jobId, taskId });
    this.publishCoordinationEvent({
      type: 'task.cancelled',
      workflowId: jobId,
      taskId,
      workerId: this.workerId,
      payload: { jobId, taskId, reason: 'Cancelled by user' },
    });
    if (job) {
      await this.propagateDownstreamCancellation(
        job,
        taskId,
        `Cancelled due to cancelled dependency '${taskId}'`,
        handle,
      );
    }
    handle?.wakePump?.();
  }

  private async propagateDownstreamCancellation(
    job: Job,
    rootTaskId: string,
    reason: string,
    handle?: ActiveJobHandle,
  ): Promise<void> {
    const queue = [rootTaskId];
    const visited = new Set<string>([rootTaskId]);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      for (const depNode of job.graph.nodes) {
        if (!depNode.dependencies.includes(currentId)) continue;
        const depTaskId = depNode.taskId ?? depNode.id;
        const edge = job.graph.edges.find(
          (e) =>
            e.from === currentId &&
            (e.to === depNode.id || e.to === depTaskId || (depNode.taskId !== undefined && e.to === depNode.taskId)),
        );
        if ((edge?.condition ?? 'success') === 'always') continue;
        if (visited.has(depTaskId)) continue;
        visited.add(depTaskId);

        const depTask = job.tasks.find((t) => t.id === depTaskId);
        if (
          depNode.state === 'completed' ||
          depNode.state === 'failed' ||
          depNode.state === 'cancelled' ||
          depTask?.status === 'completed' ||
          depTask?.status === 'failed'
        ) {
          continue;
        }

        if (handle) {
          const taskAbort = handle.activeTasks.get(depTaskId);
          if (taskAbort) {
            taskAbort.abort();
            handle.activeTasks.delete(depTaskId);
            const executionId = handle.activeExecutions.get(depTaskId);
            if (executionId) await this.cancelExecution(executionId);
          }
          handle.cancelledTaskIds.add(depTaskId);
        }

        if (depTask && depTask.status !== 'cancelled') {
          await this.jobManager.updateTaskStatus(job.id, depTaskId, 'cancelled');
        }
        await this.jobManager.updateAgentState(job.id, depNode.id, 'cancelled', undefined, reason);
        this.emit(job.id, { type: 'task:cancelled', jobId: job.id, taskId: depTaskId, error: reason });
        this.publishCoordinationEvent({
          type: 'task.cancelled',
          workflowId: job.id,
          taskId: depTaskId,
          workerId: this.workerId,
          payload: { jobId: job.id, taskId: depTaskId, reason, propagatedFrom: rootTaskId },
        });
        queue.push(depTaskId);
      }
    }
  }

  /**
   * Called by a RecoveryManager (or any external caller) when the worker running a task
   * has stopped heartbeating. Unlike cancelTask(), this does not mean the task should stop
   * — it means the process actually running it is gone, so the task should retry (subject
   * to the job's normal maxRetries) rather than be reported as user-cancelled. Only meaningful
   * for a job this process is actively running (`runJob()` in flight) — a job whose owning
   * process has itself died needs process-restart recovery (JobManager.reconcileStaleStatus),
   * not this.
   */
  reportExecutionOrphaned(jobId: string, taskId: string, reason: string): boolean {
    const handle = this.activeJobs.get(jobId);
    const taskAbort = handle?.activeTasks.get(taskId);
    if (!handle || !taskAbort) return false;
    handle.orphanedTaskIds.add(taskId);
    this.emit(jobId, { type: 'task:progress', jobId, taskId, phase: 'verify' as AgentPhase, event: { orphaned: true, reason } });
    taskAbort.abort();
    return true;
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
        const executionId = handle.activeExecutions.get(taskId);
        if (executionId) await this.cancelExecution(executionId);
        handle.cancelledTaskIds.add(taskId);
        this.emit(jobId, { type: 'task:cancelled', jobId, taskId, error: reason });
        this.publishCoordinationEvent({
          type: 'task.cancelled',
          workflowId: jobId,
          taskId,
          workerId: this.workerId,
          payload: { jobId, taskId, reason },
        });
      }
      handle.activeTasks.clear();
    }
    const job = this.jobManager.get(jobId);
    if (job) {
      for (const node of job.graph.nodes) {
        const tId = node.taskId ?? node.id;
        if (
          node.state !== 'completed' &&
          node.state !== 'failed' &&
          node.state !== 'cancelled' &&
          !handle?.cancelledTaskIds.has(tId)
        ) {
          handle?.cancelledTaskIds.add(tId);
          this.emit(jobId, { type: 'task:cancelled', jobId, taskId: tId, error: reason });
          this.publishCoordinationEvent({
            type: 'task.cancelled',
            workflowId: jobId,
            taskId: tId,
            workerId: this.workerId,
            payload: { jobId, taskId: tId, reason },
          });
        }
      }
    }
    await this.jobManager.cancel(jobId);
    this.emit(jobId, { type: 'job:cancelled', jobId, error: reason });
    if (handle) {
      handle.jobCancelledEmitted = true;
    }
    this.publishCoordinationEvent({
      type: 'job.cancelled',
      workflowId: jobId,
      workerId: this.workerId,
      payload: { jobId, status: 'cancelled', reason },
    });
    handle?.wakePump?.();
  }

  private async cancelExecution(executionId: string): Promise<void> {
    const record = await this.executionEngine.get(executionId);
    if (record && !['completed', 'failed', 'cancelled'].includes(record.execution.status)) {
      await this.executionEngine.setStatus(executionId, 'cancelled');
    }
  }

  /**
   * Stops new task dispatch for a job without touching anything already
   * running or completed — distinct from cancelJob(), which aborts
   * in-flight work. If this job is actively being pumped in this process,
   * the change takes effect on the very next pump cycle (woken immediately
   * here, not just whenever some other task happens to finish next).
   */
  async pauseJob(jobId: string): Promise<void> {
    await this.jobManager.pause(jobId);
    this.activeJobs.get(jobId)?.wakePump?.();
    this.emit(jobId, { type: 'job:paused', jobId });
    this.publishCoordinationEvent({
      type: 'job.paused',
      workflowId: jobId,
      workerId: this.workerId,
      payload: { jobId, status: 'paused' },
    });
  }

  async resumeJob(jobId: string): Promise<void> {
    await this.jobManager.resume(jobId);
    this.activeJobs.get(jobId)?.wakePump?.();
    this.emit(jobId, { type: 'job:resumed', jobId });
    this.publishCoordinationEvent({
      type: 'job.resumed',
      workflowId: jobId,
      workerId: this.workerId,
      payload: { jobId, status: 'running' },
    });
  }

  /** Wake pump loops for jobs waiting on deferred resource admission. */
  nudge(jobId?: string): void {
    if (jobId) {
      this.activeJobs.get(jobId)?.wakePump?.();
      return;
    }
    for (const handle of this.activeJobs.values()) {
      handle.wakePump?.();
    }
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
  /** Recover eligible persisted graphs using the caller's normal policy-gated executor. */
  async recoverJobs(options: JobRunOptions = {}): Promise<Array<{ jobId: string; status: string }>> {
    await this.jobManager.ready;
    const results: Array<{ jobId: string; status: string }> = [];
    for (const job of this.jobManager.list()) {
      if (!['pending', 'ready', 'running'].includes(job.status) || this.activeJobs.has(job.id)) continue;
      try { results.push({ jobId: job.id, status: (await this.runJob(job.id, options)).status }); }
      catch (error) {
        results.push({ jobId: job.id, status: error instanceof Error ? error.message : 'RECOVERY_FAILED' });
      }
    }
    return results;
  }

  async runJob(jobId: string, options: JobRunOptions = {}): Promise<Job> {
    if (this.activeJobs.has(jobId)) throw new Error('JOB_ALREADY_RUNNING');
    await this.jobManager.acquire(jobId);
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) abort.abort();
    let leaseError: Error | undefined;
    const timer = setInterval(() => {
      void this.jobManager.renew(jobId).then(async () => {
        if (this.jobManager.get(jobId)?.control?.cancelRequestedAt !== undefined) await this.cancelJob(jobId, 'requested by another control-plane process');
      }).catch(error => {
        leaseError = error instanceof Error ? error : new Error(String(error));
        abort.abort();
        for (const controller of this.activeJobs.get(jobId)?.activeTasks.values() ?? []) controller.abort();
      });
    }, Math.floor(this.jobManager.leaseMs / 3));
    timer.unref?.();
    let runError: unknown;
    try {
      const job = await this.runOwnedJob(jobId, { ...options, signal: abort.signal });
      if (leaseError) throw leaseError;
      return job;
    } catch (err) {
      runError = err;
      throw err;
    } finally {
      clearInterval(timer);
      options.signal?.removeEventListener('abort', onAbort);
      this.activeJobs.delete(jobId);
      try {
        await this.jobManager.release(jobId);
      } catch (releaseErr) {
        if (!runError) throw releaseErr;
      }
    }
  }

  private async runOwnedJob(jobId: string, options: JobRunOptions): Promise<Job> {
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
      options.signal.addEventListener('abort', () => jobAbortController.abort(), { once: true });
      if (options.signal.aborted) jobAbortController.abort();
    }

    const activeTasks = new Map<string, AbortController>();
    const retryCounts = new Map<string, number>(job.graph.nodes.map(n => [n.taskId ?? n.id, n.retryCount ?? 0]));
    const replanDepths = new Map<string, number>();
    const supersededTaskIds = new Set<string>();

    this.emit(jobId, { type: 'job:started', jobId });
    this.publishCoordinationEvent({
      type: 'job.started',
      workflowId: jobId,
      workerId: this.workerId,
      payload: { jobId, status: 'running', concurrencyLimit },
    });

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
        activeExecutions: new Map(),
        cancelledTaskIds: new Set(),
        orphanedTaskIds: new Set(),
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
      let admissionRetryTimer: ReturnType<typeof setTimeout> | undefined;

      const finishJob = async (finalStatus: 'completed' | 'failed' | 'cancelled') => {
        if (isFinished) return;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (admissionRetryTimer) {
          clearTimeout(admissionRetryTimer);
          admissionRetryTimer = undefined;
        }
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
              node.error = reason;
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
          this.publishCoordinationEvent({
            type: 'job.completed',
            workflowId: jobId,
            workerId: this.workerId,
            payload: { jobId, status: 'completed' },
          });
        } else if (timedOut) {
          this.emit(jobId, { type: 'job:failed', jobId, error: `Timed out after ${timeoutSeconds}s` });
          this.publishCoordinationEvent({
            type: 'job.failed',
            workflowId: jobId,
            workerId: this.workerId,
            payload: { jobId, status: 'failed', error: `Timed out after ${timeoutSeconds}s` },
          });
        } else if (finalStatus === 'cancelled') {
          this.emit(jobId, { type: 'job:cancelled', jobId });
          if (!handle.jobCancelledEmitted) {
            this.publishCoordinationEvent({
              type: 'job.cancelled',
              workflowId: jobId,
              workerId: this.workerId,
              payload: { jobId, status: 'cancelled' },
            });
          }
        } else {
          this.emit(jobId, { type: 'job:failed', jobId, error: 'One or more tasks failed' });
          this.publishCoordinationEvent({
            type: 'job.failed',
            workflowId: jobId,
            workerId: this.workerId,
            payload: { jobId, status: 'failed', error: 'One or more tasks failed' },
          });
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

        // 3. Dispatch ready nodes up to concurrency limit — skipped while paused. Nothing
        // already running is touched (pause is not cancel); readyNodes staying non-empty
        // here also keeps step 4's deadlock detector from misreading "paused with idle
        // work waiting" as "stuck with nowhere to go".
        const paused = job.status === 'paused';
        while (!paused && activeTasks.size < concurrencyLimit && readyNodes.length > 0 && !isFinished) {
          const node = readyNodes.shift()!;
          const taskId = node.taskId ?? node.id;
          const task = job.tasks.find((t) => t.id === taskId);
          if (!task) continue;

          const taskAbort = new AbortController();
          activeTasks.set(taskId, taskAbort);

          const locks = this.extractTaskResourceLocks(node, task);
          let resourceLease: ResourceLease | undefined;
          if (this.resourceReservations && locks && !this.locksRequireComputerId(locks)) {
            const preReq = this.buildReservationRequest(job.id, taskId, locks);
            if (preReq) {
              try {
                resourceLease = await this.resourceReservations.acquire(preReq);
              } catch (err) {
                if (err instanceof ResourceConflictError) {
                  activeTasks.delete(taskId);
                  readyNodes.unshift(node);
                  break;
                }
                throw err;
              }
            }
          }

          let assignment: OrchestratorTaskAssignment | null = null;
          try {
            assignment = await this.assignTask(job.id, taskId);
          } catch (err) {
            if (resourceLease && this.resourceReservations) {
              await this.resourceReservations.release(resourceLease.leaseId, this.workerId, resourceLease.fencingToken).catch(() => undefined);
            }
            activeTasks.delete(taskId);
            const errMessage = err instanceof Error ? err.message : String(err);
            node.state = 'failed';
            node.error = errMessage;
            // TODO(hosted-auth-followup): when `err` is a SchedulingError caused
            // specifically by a missing hosted-provider credential (not by
            // capability/policy mismatch), this task-time failure is where a
            // future WAITING_FOR_AUTH pause-and-resume would hook in instead of
            // failing the task outright — deferred out of this pass along with
            // the rest of that feature (see docs/test-plans or the hosted-auth
            // feature's PR description for the full deferral rationale). Today
            // the task simply fails with the SchedulingError's message, which
            // already names the provider and points at `wa auth login <provider>`.
            await this.jobManager.updateAgentState(job.id, node.id, 'failed', undefined, errMessage);
            await this.jobManager.updateTaskStatus(job.id, taskId, 'failed');
            this.emit(jobId, { type: 'task:failed', jobId, taskId, error: errMessage });
            continue;
          }

          if (!assignment) {
            // Placement unavailable right now; wait for free resources
            if (resourceLease && this.resourceReservations) {
              await this.resourceReservations.release(resourceLease.leaseId, this.workerId, resourceLease.fencingToken).catch(() => undefined);
            }
            activeTasks.delete(taskId);
            readyNodes.unshift(node);
            break;
          }

          if (this.resourceReservations && locks && !resourceLease) {
            const postReq = this.buildReservationRequest(job.id, taskId, locks, assignment.computerId);
            if (postReq) {
              try {
                resourceLease = await this.resourceReservations.acquire(postReq);
              } catch (err) {
                if (err instanceof ResourceConflictError) {
                  await this.cancelExecution(assignment.executionId);
                  activeTasks.delete(taskId);
                  readyNodes.unshift(node);
                  break;
                }
                throw err;
              }
            }
          }

          if (resourceLease) {
            this.publishCoordinationEvent({
              type: 'resource.acquired',
              workflowId: job.id,
              taskId,
              agentId: assignment.agentId,
              workerId: this.workerId,
              fencingToken: resourceLease.fencingToken,
              payload: {
                leaseId: resourceLease.leaseId,
                resourceKeys: resourceLease.resourceKeys,
                fencingToken: resourceLease.fencingToken,
              },
            });
          }

          handle.activeExecutions.set(taskId, assignment.executionId);
          if (taskAbort.signal.aborted) {
            if (resourceLease && this.resourceReservations) {
              await this.resourceReservations.release(resourceLease.leaseId, this.workerId, resourceLease.fencingToken).catch(() => undefined);
            }
            await this.cancelExecution(assignment.executionId);
            handle.activeExecutions.delete(taskId);
            activeTasks.delete(taskId);
            continue;
          }

          node.state = 'running';
          node.executedAt = new Date();
          await this.jobManager.updateAgentState(job.id, node.id, 'running');
          await this.jobManager.updateTaskStatus(job.id, taskId, 'running');
          await this.executionEngine.setStatus(assignment.executionId, 'running');

          this.emit(jobId, {
            type: 'task:started',
            jobId,
            taskId,
            agentId: assignment.agentId,
            computerId: assignment.computerId,
            modelId: assignment.modelId,
          });
          this.publishCoordinationEvent({
            type: 'task.started',
            workflowId: job.id,
            taskId,
            agentId: assignment.agentId,
            workerId: this.workerId,
            fencingToken: resourceLease?.fencingToken,
            payload: {
              jobId,
              taskId,
              agentId: assignment.agentId,
              computerId: assignment.computerId,
              modelId: assignment.modelId,
            },
          });

          const leaseRenewTimer =
            resourceLease && this.resourceReservations
              ? setInterval(() => {
                  void this.resourceReservations!
                    .renew(resourceLease!.leaseId, this.workerId)
                    .catch(() => undefined);
                }, Math.max(25, Math.floor((resourceLease.expiresAt - resourceLease.acquiredAt) / 3)))
              : undefined;
          leaseRenewTimer?.unref?.();

          if (this.messageRouter) {
            this.messageRouter.authorizeAgentWorkflow(assignment.agentId, job.id);
          }
          const coordinationClient = this.messageRouter?.createAgentClient({
            workflowId: job.id,
            taskId,
            agentId: assignment.agentId,
            fencingToken: resourceLease?.fencingToken,
          });

          // Run task execution asynchronously
          void (async () => {
            try {
              const executionContext: JobTaskExecutionContext = {
                jobId,
                taskId,
                node: structuredClone(node),
                assignment: {
                  jobId,
                  taskId,
                  agentId: assignment.agentId,
                  modelId: assignment.modelId,
                  runtimeId: assignment.runtimeId,
                  computerId: assignment.computerId,
                  assignedAt: new Date(),
                  policy: structuredClone(task.policy ? Object.values(task.policy).flat() : []),
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
                  this.publishCoordinationEvent({
                    type: 'task.progress',
                    workflowId: job.id,
                    taskId,
                    agentId: assignment.agentId,
                    workerId: this.workerId,
                    fencingToken: resourceLease?.fencingToken,
                    payload: { jobId, taskId, phase: ev.phase, event: ev },
                  });
                },
                previousOutcomes: new Map(job.graph.nodes.filter(n => node.dependencies.includes(n.id) || (task.contextFrom && task.contextFrom.includes(n.taskId ?? n.id)))
                  .map(n => [n.taskId ?? n.id, { success: n.state === 'completed', result: structuredClone(n.result), error: n.error }])),
                workspaceMode: task.workspaceMode,
                mutationRequired: task.mutationRequired,
                ...(coordinationClient ? { coordination: coordinationClient } : {}),
                ...(resourceLease ? { fencingToken: resourceLease.fencingToken, resourceLease } : {}),
                workerId: this.workerId,
                getSteeringInstruction: () => {
                  const queue = this.steeringQueues.get(taskId);
                  return queue && queue.length > 0 ? queue.shift() : undefined;
                },
              };

              let outcome: JobTaskOutcome = await executor(structuredClone(task), executionContext);
              if (node.type === 'supervisor') {
                const decision = outcome.supervisorDecision;
                if (!decision || !['approve', 'reject'].includes(decision.decision) || !decision.reason?.trim()) {
                  outcome = { success: false, error: 'SUPERVISOR_DECISION_REQUIRED', errorKind: 'protocol' };
                } else {
                  outcome = { ...outcome, success: outcome.success && decision.decision === 'approve',
                    result: { decision, result: outcome.result },
                    error: decision.decision === 'reject' ? `SUPERVISOR_REJECTED: ${decision.reason}` : outcome.error,
                    errorKind: decision.decision === 'reject' ? 'verification' : outcome.errorKind };
                }
              }

              if (handle.orphanedTaskIds.has(taskId)) {
                handle.orphanedTaskIds.delete(taskId);
                const reason = 'Orphaned: the worker running this task stopped responding';
                const retries = retryCounts.get(taskId) ?? 0;
                const maxRetries = task.maxRetries ?? job.maxRetries ?? 3;
                const unknownError = await this.unknownMutationError(taskId);
                if (unknownError) {
                  node.state = 'failed';
                  node.error = unknownError;
                  await this.failTask(job.id, taskId, unknownError, Infinity);
                  this.emit(jobId, { type: 'task:failed', jobId, taskId, error: unknownError });
                } else if (retries < maxRetries) {
                  retryCounts.set(taskId, retries + 1);
                  node.retryCount = retries + 1;
                  if (!node.attempts) node.attempts = [];
                  node.attempts.push({ state: 'failed', error: reason, executedAt: node.executedAt, completedAt: new Date() });
                  node.executedAt = undefined;
                  node.completedAt = undefined;
                  node.error = undefined;
                  node.result = undefined;
                  node.state = 'idle';
                  await this.jobManager.updateAgentState(job.id, node.id, 'idle');
                  await this.jobManager.updateTaskStatus(job.id, taskId, 'pending');
                  this.emit(jobId, { type: 'task:retry', jobId, taskId, retryCount: retries + 1, maxRetries });
                } else {
                  node.state = 'failed';
                  node.error = reason;
                  await this.failTask(job.id, taskId, reason, Infinity);
                  this.emit(jobId, { type: 'task:failed', jobId, taskId, error: reason });
                }
              } else if (taskAbort.signal.aborted) {
                await this.cancelExecution(assignment.executionId);
                await this.jobManager.updateTaskStatus(job.id, taskId, 'cancelled');
                const existingNodeError = job.graph.nodes.find((n) => n.id === node.id)?.error ?? node.error ?? 'Cancelled by user';
                await this.jobManager.updateAgentState(job.id, node.id, 'cancelled', undefined, existingNodeError);
                // cancelJob()/cancelTask() already emitted this task's cancellation (with
                // the reason, when there was one) at the moment it happened; emitting
                // again here when the executor finally returns produced a second,
                // reason-less "cancelled by operator" line for every cancel/timeout.
                if (!handle.cancelledTaskIds.has(taskId)) {
                  this.emit(jobId, { type: 'task:cancelled', jobId, taskId });
                }
              } else if (outcome.success) {
                if (resourceLease && this.resourceReservations) {
                  try {
                    await this.resourceReservations.validateFence(
                      resourceLease.leaseId,
                      this.workerId,
                      resourceLease.fencingToken,
                    );
                  } catch (fenceErr) {
                    if (fenceErr instanceof ResourceLeaseExpiredError || fenceErr instanceof StaleFencingTokenError) {
                      outcome = { success: false, error: fenceErr.message, errorKind: 'protocol' };
                    } else {
                      throw fenceErr;
                    }
                  }
                }
              }
              if (!handle.orphanedTaskIds.has(taskId) && !taskAbort.signal.aborted && outcome.success) {
                await this.completeTask(job.id, taskId, outcome.result);
                this.emit(jobId, {
                  type: 'task:completed',
                  jobId,
                  taskId,
                  result: outcome.result,
                  filesChanged: outcome.filesChanged,
                  usage: outcome.usage,
                });
                this.publishCoordinationEvent({
                  type: 'task.completed',
                  workflowId: job.id,
                  taskId,
                  agentId: assignment.agentId,
                  workerId: this.workerId,
                  fencingToken: resourceLease?.fencingToken,
                  payload: { jobId, taskId, filesChanged: outcome.filesChanged },
                });
                for (const depNode of job.graph.nodes) {
                  if (depNode.state === 'idle' && depNode.dependencies.includes(taskId)) {
                    const depTaskId = depNode.taskId ?? depNode.id;
                    if (this.jobManager.dependenciesSatisfied(job, depTaskId)) {
                      this.publishCoordinationEvent({
                        type: 'task.dependency_ready',
                        workflowId: job.id,
                        taskId: depTaskId,
                        workerId: this.workerId,
                        payload: { jobId, taskId: depTaskId, satisfiedBy: taskId },
                      });
                    }
                  }
                }
              } else if (!handle.orphanedTaskIds.has(taskId) && !taskAbort.signal.aborted) {
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

                const currentReplanDepth = replanDepths.get(taskId) ?? 0;
                const maxReplanDepth = job.maxRetries ?? task.maxRetries ?? 3;
                if (options.replanner && !isPolicyDenial && currentReplanDepth < maxReplanDepth) {
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

                      const inheritedRepairTasks = replanResult.repairTasks.map((rt) => ({
                        ...rt,
                        task: {
                          ...rt.task,
                          policy: rt.task.policy ?? task.policy,
                          execution: {
                            ...task.execution,
                            ...rt.task.execution,
                          },
                        },
                      }));
                      const added = await this.jobManager.addTasksToJob(job.id, inheritedRepairTasks, {
                        replacesTaskId: taskId,
                      });
                      for (const addedTask of added) {
                        replanDepths.set(addedTask.id, currentReplanDepth + 1);
                      }

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
                const maxRetries = isPolicyDenial ? 0 : (task.maxRetries ?? job.maxRetries ?? 3);
                const unknownError = await this.unknownMutationError(taskId);
                if (unknownError) {
                  node.state = 'failed';
                  node.error = unknownError;
                  await this.failTask(job.id, taskId, unknownError, Infinity);
                  this.emit(jobId, { type: 'task:failed', jobId, taskId, error: unknownError });
                } else if (retries < maxRetries) {
                  retryCounts.set(taskId, retries + 1);
                  node.retryCount = retries + 1;
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
              if (handle.orphanedTaskIds.has(taskId)) {
                handle.orphanedTaskIds.delete(taskId);
                const reason = 'Orphaned: the worker running this task stopped responding';
                const retries = retryCounts.get(taskId) ?? 0;
                const maxRetries = task.maxRetries ?? job.maxRetries ?? 3;
                const unknownError = await this.unknownMutationError(taskId);
                if (unknownError) {
                  node.state = 'failed';
                  node.error = unknownError;
                  await this.failTask(job.id, taskId, unknownError, Infinity);
                  this.emit(jobId, { type: 'task:failed', jobId, taskId, error: unknownError });
                } else if (retries < maxRetries) {
                  retryCounts.set(taskId, retries + 1);
                  node.retryCount = retries + 1;
                  if (!node.attempts) node.attempts = [];
                  node.attempts.push({ state: 'failed', error: reason, executedAt: node.executedAt, completedAt: new Date() });
                  node.executedAt = undefined;
                  node.completedAt = undefined;
                  node.error = undefined;
                  node.result = undefined;
                  node.state = 'idle';
                  await this.jobManager.updateAgentState(job.id, node.id, 'idle');
                  await this.jobManager.updateTaskStatus(job.id, taskId, 'pending');
                  this.emit(jobId, { type: 'task:retry', jobId, taskId, retryCount: retries + 1, maxRetries });
                } else {
                  node.state = 'failed';
                  node.error = reason;
                  await this.failTask(job.id, taskId, reason, Infinity);
                  this.emit(jobId, { type: 'task:failed', jobId, taskId, error: reason });
                }
              } else if (taskAbort.signal.aborted) {
                await this.cancelExecution(assignment.executionId);
                await this.jobManager.updateTaskStatus(job.id, taskId, 'cancelled');
                await this.jobManager.updateAgentState(job.id, node.id, 'cancelled');
                this.emit(jobId, { type: 'task:cancelled', jobId, taskId });
              } else {
                const isPolicyDenial = errMessage.toLowerCase().includes('policy') || errMessage.toLowerCase().includes('denied');
                const retries = retryCounts.get(taskId) ?? 0;
                const maxRetries = isPolicyDenial ? 0 : (task.maxRetries ?? job.maxRetries ?? 3);
                const unknownError = await this.unknownMutationError(taskId);
                if (unknownError) {
                  node.state = 'failed';
                  node.error = unknownError;
                  await this.failTask(job.id, taskId, unknownError, Infinity);
                  this.emit(jobId, { type: 'task:failed', jobId, taskId, error: unknownError });
                } else if (retries < maxRetries) {
                  retryCounts.set(taskId, retries + 1);
                  node.retryCount = retries + 1;
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
              if (leaseRenewTimer) clearInterval(leaseRenewTimer);
              if (resourceLease && this.resourceReservations) {
                await this.resourceReservations
                  .release(resourceLease.leaseId, this.workerId, resourceLease.fencingToken)
                  .catch(() => undefined);
                this.publishCoordinationEvent({
                  type: 'resource.released',
                  workflowId: job.id,
                  taskId,
                  agentId: assignment.agentId,
                  workerId: this.workerId,
                  fencingToken: resourceLease.fencingToken,
                  payload: { leaseId: resourceLease.leaseId },
                });
              }
              handle.activeExecutions.delete(taskId);
              activeTasks.delete(taskId);
              this.steeringQueues.delete(taskId);
              void pump().catch(reject);
            }
          })().catch(reject);
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
            const anyCancelled = job.graph.nodes.some(
              (n) => n.state === 'cancelled' && !supersededTaskIds.has(n.taskId ?? n.id),
            );
            await finishJob(anyFailed ? 'failed' : anyCancelled ? 'cancelled' : 'completed');
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
          } else if (!paused && readyNodes.length > 0 && !admissionRetryTimer) {
            // Ready nodes were deferred due to temporary resource admission saturation;
            // schedule a bounded re-pump so the job resumes as soon as capacity frees up.
            admissionRetryTimer = setTimeout(() => {
              admissionRetryTimer = undefined;
              handle.wakePump?.();
            }, 100);
            admissionRetryTimer.unref?.();
          }
        }
      };

      handle.wakePump = () => void pump().catch(reject);
      void pump().catch(reject);
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

  /**
   * Checkpoints a task execution within a job, or the most recent execution of a job.
   */
  async checkpoint(
    jobId: string,
    options: { taskId?: string; description?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<ExecutionCheckpoint> {
    if (!this.checkpointService) {
      throw new Error('CheckpointService is not configured on this JobOrchestrator');
    }

    let targetExecutionId: string | undefined;
    if (options.taskId) {
      const records = await this.executionEngine.listByTask(options.taskId);
      if (records.length > 0) {
        targetExecutionId = records[records.length - 1].execution.id;
      }
    } else {
      const job = this.jobManager.get(jobId);
      if (!job) throw new Error(`Job '${jobId}' not found`);
      for (const t of job.tasks) {
        const records = await this.executionEngine.listByTask(t.id);
        if (records.length > 0) {
          targetExecutionId = records[records.length - 1].execution.id;
          break;
        }
      }
    }

    if (!targetExecutionId) {
      throw new Error(`No active or completed execution found for job '${jobId}'`);
    }

    const checkpoint = await this.checkpointService.checkpoint(targetExecutionId, {
      description: options.description,
      metadata: options.metadata,
      planState: {
        jobId,
        status: this.jobManager.get(jobId)?.status,
      },
    });

    this.emit(jobId, {
      type: 'job:checkpoint',
      jobId,
      taskId: options.taskId,
      event: { checkpointId: checkpoint.id, workspaceRevision: checkpoint.workspaceRevision },
    });

    return checkpoint;
  }

  /**
   * Creates an isolated branch of execution from a checkpoint.
   */
  async fork(
    checkpointId: string,
    options: { forkedExecutionId?: string } = {},
  ): Promise<ForkExecutionResult> {
    if (!this.checkpointService) {
      throw new Error('CheckpointService is not configured on this JobOrchestrator');
    }

    const forkResult = await this.checkpointService.fork(checkpointId, options.forkedExecutionId);

    const checkpoint = this.checkpointService.getCheckpoint(checkpointId);
    const parentJobId = checkpoint?.planState?.jobId;
    if (parentJobId) {
      this.emit(parentJobId, {
        type: 'job:fork',
        jobId: parentJobId,
        event: forkResult,
      });
    }

    return forkResult;
  }

  /**
   * Rolls back an execution within a job to a previous checkpoint.
   */
  async rollback(
    jobId: string,
    checkpointId: string,
    options: { executionId?: string } = {},
  ): Promise<RollbackResult> {
    if (!this.checkpointService) {
      throw new Error('CheckpointService is not configured on this JobOrchestrator');
    }

    let targetExecutionId = options.executionId;
    if (!targetExecutionId) {
      const checkpoint = this.checkpointService.getCheckpoint(checkpointId);
      if (checkpoint) {
        targetExecutionId = checkpoint.executionId;
      }
    }

    if (!targetExecutionId) {
      throw new Error(`Could not determine executionId to rollback for checkpoint '${checkpointId}'`);
    }

    const rollbackResult = await this.checkpointService.rollback(targetExecutionId, checkpointId);

    this.emit(jobId, {
      type: 'job:rollback',
      jobId,
      event: rollbackResult,
    });

    return rollbackResult;
  }
}

export function createJobOrchestrator(options: JobOrchestratorOptions): JobOrchestrator {
  return new JobOrchestrator(options);
}
