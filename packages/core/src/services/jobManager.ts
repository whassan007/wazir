import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import type {
  Job,
  JobGraph,
  JobMessage,
  JobArtifact,
  TaskGraphEdge,
  AgentState,
  Task,
  TaskStatus,
  TaskType,
  TaskRequirements,
  Priority,
  JobNode,
  ExecutionPreferences,
  WorkspaceMode,
} from '../types/index.js';

export interface JobManagerOptions {
  store?: KeyValueStore;
  leaseMs?: number;
  now?: () => number;
  persist?: (job: Job) => void | Promise<void>;
  load?: () => Job[] | Promise<Job[]>;
  remove?: (jobId: string) => void | Promise<void>;
}

let jobCounter = 0;

function nextJobId(): string {
  jobCounter += 1;
  return `job-${randomUUID()}`;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly ownerId = randomUUID();
  private readonly creations = new Map<string, Promise<void>>();
  private readonly claims = new Map<string, number>();
  private readonly store?: KeyValueStore;
  readonly leaseMs: number;
  private readonly now: () => number;

  private readonly persist?: (job: Job) => void | Promise<void>;
  private readonly remove?: (jobId: string) => void | Promise<void>;
  readonly ready: Promise<void>;

  constructor(options: JobManagerOptions = {}) {
    this.store = options.store;
    if (this.store && !this.store.update) throw new Error('ATOMIC_STORE_REQUIRED');
    this.leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs < 100) throw new Error('INVALID_LEASE_DURATION');
    this.now = options.now ?? Date.now;
    this.persist = options.persist;
    this.remove = options.remove;
    this.ready = Promise.resolve(this.store ? this.store.list('job/').then(entries => entries.map(e => e.value as Job)) : options.load?.() ?? []).then(async (loaded) => {
      for (const job of loaded) {
        if (this.jobs.has(job.id)) continue;
        this.jobs.set(job.id, job);
        if (!this.store) await this.reconcileStaleStatus(job);
      }
    });
  }

  async acquire(jobId: string): Promise<void> {
    await this.ready;
    if (!this.store) return;
    const job = await this.store.update!<Job>(`job/${jobId}`, current => {
      if (!current) throw new Error('JOB_NOT_FOUND');
      if (['completed', 'failed', 'cancelled'].includes(current.status)) throw new Error('JOB_TERMINAL');
      if (current.ownership && current.ownership.expiresAt > this.now()) throw new Error('JOB_LEASE_BUSY');
      const next = structuredClone(current);
      next.ownership = { ownerId: this.ownerId, epoch: (current.ownership?.epoch ?? 0) + 1, expiresAt: this.now() + this.leaseMs };
      for (const node of next.graph.nodes) {
        if (node.state === 'running' || node.state === 'assigned') {
          node.attempts = [...(node.attempts ?? []), { state: 'failed', error: 'OWNER_LEASE_EXPIRED', executedAt: node.executedAt, completedAt: new Date(this.now()) }];
          node.retryCount = (node.retryCount ?? 0) + 1;
          node.state = node.retryCount <= (next.maxRetries ?? 3) ? 'idle' : 'failed';
          node.error = node.state === 'failed' ? 'RETRY_LIMIT_EXCEEDED' : undefined;
          const task = next.tasks.find(t => t.id === (node.taskId ?? node.id));
          if (task) task.status = node.state === 'idle' ? 'pending' : 'failed';
        }
      }
      return next;
    });
    this.claims.set(jobId, job.ownership!.epoch);
    this.jobs.set(jobId, job);
  }

  async renew(jobId: string): Promise<void> {
    if (!this.store) return;
    const updated = await this.store.update!<Job>(`job/${jobId}`, current => {
      this.assertOwnership(current);
      return { ...current!, ownership: { ...current!.ownership!, expiresAt: this.now() + this.leaseMs } };
    });
    const local = this.jobs.get(jobId);
    if (local) local.control = updated.control;
  }

  async release(jobId: string): Promise<void> {
    if (!this.store || !this.claims.has(jobId)) return;
    try {
      await this.store.update!<Job>(`job/${jobId}`, current => {
        this.assertOwnership(current);
        return { ...current!, ownership: { ...current!.ownership!, expiresAt: 0 } };
      });
    } finally { this.claims.delete(jobId); }
  }

  private assertOwnership(current: Job | undefined): void {
    if (!current?.ownership || current.ownership.ownerId !== this.ownerId ||
        current.ownership.epoch !== this.claims.get(current.id) || current.ownership.expiresAt <= this.now()) {
      throw new Error('JOB_LEASE_LOST');
    }
  }

  async save(jobId: string): Promise<void> {
    await this.creations.get(jobId);
    await this.flush(this.require(jobId));
  }

  /** Removes a job from memory and the backing store. Refuses a job that's still active. */
  async delete(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'running' || job.status === 'ready' || job.status === 'planning') {
      throw new Error(`Cannot delete job '${jobId}' while it is still active (status '${job.status}')`);
    }
    this.jobs.delete(jobId);
    if (this.store) await this.store.delete(`job/${jobId}`);
    else if (this.remove) await this.remove(jobId);
    return true;
  }

  /**
   * Self-heals job records that can't reflect reality anymore now that they're being
   * loaded fresh: nothing in a brand-new JobManager has called runJob() on anything yet,
   * so any job still in a non-terminal status is stale one way or another. Two distinct
   * cases, both inferred from the tasks' own (correctly persisted) statuses:
   *
   * 1. Every task already reached a terminal status, but the job's own status wasn't
   *    updated to match — the old bug where runJob() mutated job.status in memory
   *    without ever flushing the terminal transition (see setJobStatus). The fix to
   *    runJob() only stops *new* writes from being wrong; anything already on disk needs
   *    correcting here. Job status is inferred from the tasks and corrected to match.
   *
   * 2. A task is still genuinely non-terminal (status 'running') — the process actually
   *    driving it (model turns, tool calls, ...) no longer exists, most commonly because
   *    the terminal was closed or the process crashed mid-task. Left alone this is
   *    indistinguishable from something still genuinely in progress (same status, and
   *    duration climbs forever since completedAt is never set) — marked failed instead,
   *    as "orphaned". A job/task that's merely 'pending' (queued, never started) is left
   *    alone — that's a legitimate resumable state, not an orphan.
   */
  private async reconcileStaleStatus(job: Job): Promise<void> {
    const nonTerminal = job.status === 'pending' || job.status === 'planning' || job.status === 'ready' || job.status === 'running' || job.status === 'paused';
    if (!nonTerminal || job.tasks.length === 0) return;

    const allTerminal = job.tasks.every(
      (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
    );

    if (allTerminal) {
      const anyFailed = job.tasks.some((t) => t.status === 'failed');
      const anyCancelled = job.tasks.some((t) => t.status === 'cancelled');
      job.status = anyFailed ? 'failed' : anyCancelled ? 'cancelled' : 'completed';
      if (!job.completedAt) {
        // The job-level completedAt was never recorded (that's the bug being healed),
        // but each graph node already got a real completedAt when it actually finished
        // (see updateNodeState) — use the latest of those instead of a rough guess.
        const latest = job.graph.nodes.reduce<Date | undefined>((acc, n) => {
          return n.completedAt && (!acc || n.completedAt > acc) ? n.completedAt : acc;
        }, undefined);
        job.completedAt = latest ?? job.createdAt;
      }
      await this.flush(job);
      return;
    }

    // Some task is still non-terminal. Only 'running' means orphaned — 'pending'/
    // 'ready'/etc with an unstarted task is just a legitimately queued job.
    if (job.status !== 'running') return;

    for (const task of job.tasks) {
      if (task.status === 'running') {
        task.status = 'failed';
        const node = job.graph.nodes.find((n) => n.taskId === task.id || n.id === task.id);
        if (node && node.state !== 'completed' && node.state !== 'failed' && node.state !== 'cancelled') {
          node.state = 'failed';
          node.error = node.error ?? 'Orphaned: the process running this task ended before it finished';
          node.completedAt = node.completedAt ?? new Date();
        }
      }
    }
    for (const node of job.graph.nodes) {
      if (node.state === 'running') {
        node.state = 'failed';
        node.error = node.error ?? 'Orphaned: the process running this task ended before it finished';
        node.completedAt = node.completedAt ?? new Date();
      }
    }
    job.status = 'failed';
    if (!job.completedAt) job.completedAt = new Date();
    await this.flush(job);
  }

  create(params: {
    title: string;
    description?: string;
    tasks: JobTaskInput[];
    priority?: Job['priority'];
    concurrencyLimit?: number;
    maxRetries?: number;
    timeoutSeconds?: number;
  }): Job {
    const now = new Date();
    const jobId = nextJobId();

    const seenIds = new Set<string>();
    for (let i = 0; i < params.tasks.length; i++) {
      const explicitId = params.tasks[i].task.id;
      if (explicitId) {
        if (seenIds.has(explicitId)) {
          throw new Error(`Duplicate task id '${explicitId}' in job`);
        }
        seenIds.add(explicitId);
      } else {
        params.tasks[i].task.id = `task-${jobId}-${i}`;
      }
    }

    const graph = this.buildGraph(params.tasks);
    const tasks: Task[] = params.tasks.map((t, i) => ({
      id: t.task.id ?? `task-${jobId}-${i}`,
      type: (t.task.type as TaskType) ?? 'chat',
      title: t.task.title,
      input: t.task.input,
      requirements: {
        agentCapabilities: t.task.requirements?.agentCapabilities,
        capabilities: t.task.requirements?.capabilities ?? [],
        reasoning: t.task.requirements?.reasoning ?? ('low' as const),
        vision: t.task.requirements?.vision ?? false,
        toolCalling: t.task.requirements?.toolCalling ?? false,
        minimumContext: t.task.requirements?.minimumContext ?? 1024,
        minimumMemoryGB: t.task.requirements?.minimumMemoryGB ?? 4,
        minimumGPUMemoryGB: t.task.requirements?.minimumGPUMemoryGB ?? 0,
        localOnly: t.task.requirements?.localOnly ?? false,
      },
      capabilities: t.task.capabilities,
      expectedEvidence: t.task.expectedEvidence,
      expectedArtifacts: t.task.expectedArtifacts ?? t.task.requirements?.expectedArtifacts,
      mutationRequired: t.task.mutationRequired ?? t.task.requirements?.mutationRequired,
      workspaceMode: t.task.workspaceMode,
      contextFrom: t.task.contextFrom,
      policy: t.task.policy,
      execution: {
        targetComputerId: t.task.execution?.targetComputerId,
        targetRuntimeId: t.task.execution?.targetRuntimeId,
        targetModelId: t.task.execution?.targetModelId,
        targetAgentId: t.task.execution?.targetAgentId,
        executionMode: t.task.execution?.executionMode ?? ('automatic' as const),
      },
      priority: (t.task.priority ?? 'normal') as Priority,
      status: 'pending' as TaskStatus,
      createdAt: now,
      updatedAt: now,
    }));

    const job: Job = {
      id: jobId,
      title: params.title,
      description: params.description,
      status: 'pending',
      tasks,
      graph,
      messages: [],
      artifacts: [],
      sessions: [],
      rootTaskId: graph.nodes[0]?.id ?? tasks[0]?.id ?? jobId,
      priority: params.priority ?? 'normal',
      concurrencyLimit: params.concurrencyLimit,
      maxRetries: params.maxRetries ?? 3,
      timeoutSeconds: params.timeoutSeconds,
      createdAt: now,
    };

    this.jobs.set(jobId, job);
    if (!this.store) {
      const creation = this.flush(job);
      this.creations.set(jobId, creation);
      // The durable create path (save) awaits and propagates this error.
      void creation.catch(() => undefined);
    }
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.require(jobId);
    if (this.store && !this.claims.has(jobId)) {
      const updated = await this.store.update!<Job>(`job/${jobId}`, current => {
        if (!current) throw new Error('JOB_NOT_FOUND');
        if (['completed', 'failed', 'cancelled'].includes(current.status)) throw new Error(`Cannot cancel job in terminal status '${current.status}'`);
        if (current.ownership && current.ownership.expiresAt > this.now()) {
          return { ...current, control: { cancelRequestedAt: this.now() } };
        }
        return { ...current, status: 'cancelled', completedAt: new Date(this.now()),
          revision: (current.revision ?? 0) + 1,
          tasks: current.tasks.map(t => ['completed', 'failed'].includes(t.status) ? t : { ...t, status: 'cancelled' }),
          graph: { ...current.graph, nodes: current.graph.nodes.map(n => ['completed', 'failed'].includes(n.state) ? n : { ...n, state: 'cancelled' }) } };
      });
      this.jobs.set(jobId, updated); return;
    }
    if (job.status === 'completed' || job.status === 'failed') {
      throw new Error(`Cannot cancel job in terminal status '${job.status}'`);
    }
    job.status = 'cancelled';
    for (const task of job.tasks) {
      if (task.status === 'pending' || task.status === 'running') {
        task.status = 'cancelled';
      }
    }
    await this.flush(job);
  }

  /**
   * Pauses a job: no new tasks are dispatched (by JobOrchestrator.runJob()'s
   * live pump loop, if this job is actively running in this process, or by
   * a future runJob()/recoverJobs() call otherwise) until resume(). Unlike
   * cancel(), nothing already running or completed is touched — an
   * in-flight task keeps going to its own natural conclusion; pause only
   * stops the *next* one from starting.
   */
  async pause(jobId: string): Promise<void> {
    const job = this.require(jobId);
    if (this.store && !this.claims.has(jobId)) {
      const updated = await this.store.update!<Job>(`job/${jobId}`, current => {
        if (!current) throw new Error('JOB_NOT_FOUND');
        if (!['pending', 'planning', 'ready', 'running'].includes(current.status)) {
          throw new Error(`Cannot pause job in status '${current.status}'`);
        }
        return { ...current, status: 'paused', revision: (current.revision ?? 0) + 1 };
      });
      this.jobs.set(jobId, updated);
      return;
    }
    if (!['pending', 'planning', 'ready', 'running'].includes(job.status)) {
      throw new Error(`Cannot pause job in status '${job.status}'`);
    }
    job.status = 'paused';
    await this.flush(job);
  }

  async resume(jobId: string): Promise<void> {
    const job = this.require(jobId);
    if (job.status !== 'paused') {
      throw new Error(`Cannot resume job in status '${job.status}'`);
    }
    job.status = 'ready';
    for (const task of job.tasks) {
      if (task.status === 'blocked' && this.dependenciesSatisfied(job, task.id)) {
        task.status = 'pending';
      }
    }
    await this.flush(job);
  }

  async completeTask(jobId: string, taskId: string, result?: unknown): Promise<void> {
    const job = this.require(jobId);
    const task = job.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found in job '${jobId}'`);
    }
    task.status = 'completed';
    this.updateNodeState(job, taskId, 'completed', result);
    await this.flush(job);
  }

  async failTask(
    jobId: string,
    taskId: string,
    error: string,
    retryCount?: number,
  ): Promise<void> {
    const job = this.require(jobId);
    const task = job.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found in job '${jobId}'`);
    }
    const maxRetries = job.maxRetries ?? 3;
    if ((retryCount ?? 0) < maxRetries) {
      task.status = 'pending';
    } else {
      task.status = 'failed';
      this.updateNodeState(job, taskId, 'failed', undefined, error);
    }
    await this.flush(job);
  }

  async addMessage(jobId: string, message: JobMessage): Promise<void> {
    const job = this.require(jobId);
    job.messages.push(message);
    await this.flush(job);
  }

  async addArtifact(jobId: string, artifact: JobArtifact): Promise<void> {
    const job = this.require(jobId);
    job.artifacts.push(artifact);
    await this.flush(job);
  }

  getGraph(jobId: string): JobGraph | undefined {
    const job = this.jobs.get(jobId);
    return job?.graph;
  }

  /**
   * Persists a job-level status transition (running/completed/failed/cancelled).
   * Task-level updates (completeTask, updateTaskStatus, ...) already flush the job,
   * but nothing previously persisted the job's *own* status field — the orchestrator
   * was mutating `job.status` directly on the in-memory object without going through
   * the manager, so the last thing ever written to disk was 'running' from job start.
   * Reloading in a new process then showed every past job as still running forever,
   * even ones that completed cleanly before the process exited.
   */
  async setJobStatus(
    jobId: string,
    status: Job['status'],
    extra?: { startedAt?: Date; completedAt?: Date },
  ): Promise<void> {
    const job = this.require(jobId);
    job.status = status;
    if (extra?.startedAt) job.startedAt = extra.startedAt;
    if (extra?.completedAt) job.completedAt = extra.completedAt;
    await this.flush(job);
  }

  async updateTaskStatus(
    jobId: string,
    taskId: string,
    status: Task['status'],
  ): Promise<void> {
    const job = this.require(jobId);
    const task = job.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found in job '${jobId}'`);
    }
    task.status = status;
    await this.flush(job);
  }

  async updateAgentState(
    jobId: string,
    nodeId: string,
    state: AgentState,
    result?: unknown,
    error?: string,
  ): Promise<void> {
    const job = this.require(jobId);
    this.updateNodeState(job, nodeId, state, result, error);
    await this.flush(job);
  }

  async addTasksToJob(
    jobId: string,
    newTasks: JobTaskInput[],
    rewireOptions?: {
      replacesTaskId?: string;
    },
  ): Promise<Task[]> {
    const job = this.require(jobId);
    const now = new Date();
    const createdTasks: Task[] = [];

    for (let i = 0; i < newTasks.length; i++) {
      const input = newTasks[i];
      const taskId = input.task.id ?? `task-${jobId}-dyn-${Date.now().toString(36)}-${i}`;
      input.task.id = taskId;

      const task: Task = {
        id: taskId,
        type: (input.task.type as TaskType) ?? 'coding',
        title: input.task.title,
        input: input.task.input ?? '',
        requirements: {
          capabilities: input.task.requirements?.capabilities ?? [],
          reasoning: input.task.requirements?.reasoning ?? ('low' as const),
          vision: input.task.requirements?.vision ?? false,
          toolCalling: input.task.requirements?.toolCalling ?? false,
          minimumContext: input.task.requirements?.minimumContext ?? 1024,
          minimumMemoryGB: input.task.requirements?.minimumMemoryGB ?? 4,
          minimumGPUMemoryGB: input.task.requirements?.minimumGPUMemoryGB ?? 0,
          localOnly: input.task.requirements?.localOnly ?? false,
        },
        capabilities: input.task.capabilities,
        expectedEvidence: input.task.expectedEvidence,
        expectedArtifacts: input.task.expectedArtifacts ?? input.task.requirements?.expectedArtifacts,
        mutationRequired: input.task.mutationRequired ?? input.task.requirements?.mutationRequired,
        workspaceMode: input.task.workspaceMode,
        contextFrom: input.task.contextFrom,
        policy: input.task.policy,
        execution: {
          targetComputerId: input.task.execution?.targetComputerId,
          targetRuntimeId: input.task.execution?.targetRuntimeId,
          targetModelId: input.task.execution?.targetModelId,
          targetAgentId: input.task.execution?.targetAgentId,
          executionMode: input.task.execution?.executionMode ?? ('automatic' as const),
        },
        priority: (input.task.priority ?? 'normal') as Priority,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };

      job.tasks.push(task);
      createdTasks.push(task);

      const node: JobNode = {
        id: taskId,
        type: input.type ?? 'task',
        taskId,
        agentId: input.agentId,
        state: 'idle',
        dependencies: input.dependencies ?? [],
        children: [],
      };

      job.graph.nodes.push(node);

      for (const dep of input.dependencies ?? []) {
        job.graph.edges.push({ from: dep, to: taskId });
        const parentNode = job.graph.nodes.find((n) => n.id === dep || n.taskId === dep);
        if (parentNode && !parentNode.children.includes(taskId)) {
          parentNode.children.push(taskId);
        }
      }
    }

    if (rewireOptions?.replacesTaskId && createdTasks.length > 0) {
      const oldId = rewireOptions.replacesTaskId;
      const newIds = new Set(createdTasks.map((t) => t.id));
      const oldNode = job.graph.nodes.find((n) => n.id === oldId || n.taskId === oldId);
      const firstNewNode = job.graph.nodes.find((n) => n.id === createdTasks[0].id);

      if (firstNewNode) {
        firstNewNode.dependencies = firstNewNode.dependencies
          .filter((d) => d !== oldId)
          .concat(oldNode ? oldNode.dependencies : []);
        job.graph.edges = job.graph.edges.filter((e) => !(e.from === oldId && e.to === firstNewNode.id));
        for (const dep of oldNode?.dependencies ?? []) {
          if (!job.graph.edges.some((e) => e.from === dep && e.to === firstNewNode.id)) {
            job.graph.edges.push({ from: dep, to: firstNewNode.id });
          }
        }
      }

      const finalNewId = createdTasks[createdTasks.length - 1].id;

      for (const edge of job.graph.edges) {
        if (edge.from === oldId && !newIds.has(edge.to)) {
          edge.from = finalNewId;
        }
      }
      for (const node of job.graph.nodes) {
        if (!newIds.has(node.id) && !newIds.has(node.taskId ?? '')) {
          const depIdx = node.dependencies.indexOf(oldId);
          if (depIdx !== -1) {
            node.dependencies[depIdx] = finalNewId;
          }
        }
      }
    }

    await this.flush(job);
    return createdTasks;
  }

  private buildGraph(tasks: JobTaskInput[]): JobGraph {
    const nodes: JobNode[] = [];
    const edges: TaskGraphEdge[] = [];

    const knownIds = new Set(tasks.map((t, i) => t.task.id ?? `task-${i}`));
    for (const taskInput of tasks) {
      const currentId = taskInput.task.id;
      for (const dep of taskInput.dependencies ?? []) {
        if (!knownIds.has(dep)) {
          throw new Error(`Task '${currentId}' references nonexistent dependency '${dep}'`);
        }
      }
    }

    // Cycle detection via DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const checkCycle = (nodeId: string, trace: string[]) => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      const currentInput = tasks.find((t) => (t.task.id ?? '') === nodeId);
      for (const dep of currentInput?.dependencies ?? []) {
        if (!visited.has(dep)) {
          checkCycle(dep, [...trace, dep]);
        } else if (recursionStack.has(dep)) {
          throw new Error(`Cycle detected in task dependencies: ${[...trace, dep].join(' -> ')}`);
        }
      }
      recursionStack.delete(nodeId);
    };

    for (const taskInput of tasks) {
      const id = taskInput.task.id!;
      if (!visited.has(id)) {
        checkCycle(id, [id]);
      }
    }

    for (let i = 0; i < tasks.length; i++) {
      const taskInput = tasks[i];
      const nodeId = taskInput.task.id ?? `task-${i}`;

      const node: JobNode = {
        id: nodeId,
        type: taskInput.type ?? 'task',
        taskId: taskInput.task.id,
        agentId: taskInput.agentId,
        state: 'idle',
        dependencies: taskInput.dependencies ?? [],
        children: [],
      };

      nodes.push(node);

      for (const dep of taskInput.dependencies ?? []) {
        edges.push({ from: dep, to: nodeId });
        const parentNode = nodes.find((n) => n.id === dep);
        if (parentNode && !parentNode.children.includes(nodeId)) {
          parentNode.children.push(nodeId);
        }
      }
    }

    return { nodes, edges };
  }

  dependenciesSatisfied(job: Job, taskId: string): boolean {
    const node = job.graph.nodes.find((n) => n.taskId === taskId || n.id === taskId);
    if (!node) return true;

    for (const dep of node.dependencies) {
      const depNode = job.graph.nodes.find((n) => n.id === dep || n.taskId === dep);
      if (depNode && depNode.state !== 'completed') {
        return false;
      }
    }

    return true;
  }

  hasFailedDependency(job: Job, taskId: string): boolean {
    const node = job.graph.nodes.find((n) => n.taskId === taskId || n.id === taskId);
    if (!node) return false;

    for (const dep of node.dependencies) {
      const depNode = job.graph.nodes.find((n) => n.id === dep || n.taskId === dep);
      const depTask = job.tasks.find((t) => t.id === dep);
      if (
        (depNode && (depNode.state === 'failed' || depNode.state === 'cancelled')) ||
        (depTask && (depTask.status === 'failed' || depTask.status === 'cancelled'))
      ) {
        return true;
      }
    }

    return false;
  }

  private updateNodeState(
    job: Job,
    nodeId: string,
    state: AgentState,
    result?: unknown,
    error?: string,
  ): void {
    const node = job.graph.nodes.find((n) => n.id === nodeId || n.taskId === nodeId);
    if (node) {
      node.state = state;
      if (result !== undefined) node.result = result;
      if (error !== undefined) node.error = error;
      if (state === 'running' && !node.executedAt) node.executedAt = new Date();
      if (state === 'completed' || state === 'failed') node.completedAt = new Date();
    }
  }

  private require(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job '${jobId}' not found`);
    }
    return job;
  }

  private async flush(job: Job): Promise<void> {
    if (this.store) {
      await this.store.update!<Job>(`job/${job.id}`, current => {
        if (current) {
          if (this.claims.has(job.id)) this.assertOwnership(current);
          else if (current.ownership && current.ownership.expiresAt > this.now()) throw new Error('JOB_LEASE_BUSY');
          if (current.revision !== job.revision) throw new Error('JOB_REVISION_CONFLICT');
        }
        job.revision = (current?.revision ?? 0) + 1;
        return structuredClone({ ...job, control: current?.control ?? job.control, ownership: current?.ownership ?? job.ownership });
      });
    } else if (this.persist) {
      await this.persist(job);
    }
  }
}

export interface JobTaskInput {
  task: {
    id?: string;
    type?: string;
    title?: string;
    input: string;
    requirements?: Partial<TaskRequirements>;
    capabilities?: string[];
    expectedEvidence?: string[];
    expectedArtifacts?: string[];
    mutationRequired?: boolean;
    workspaceMode?: WorkspaceMode;
    contextFrom?: string[];
    policy?: Task['policy'];
    priority?: 'low' | 'normal' | 'high' | 'critical';
    /** Pins this task to a specific model/computer/runtime/agent instead of letting
     *  the scheduler auto-route it — e.g. wa run --model, or /model in wa chat. */
    execution?: Partial<ExecutionPreferences>;
  };
  agentId?: string;
  dependencies?: string[];
  type?: JobNode['type'];
}

export function createJobManager(options: JobManagerOptions = {}): JobManager {
  return new JobManager(options);
}
