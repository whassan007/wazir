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
  Priority,
  JobNode,
} from '../types/index.js';

export interface JobManagerOptions {
  persist?: (job: Job) => void | Promise<void>;
  load?: () => Job[] | Promise<Job[]>;
  remove?: (jobId: string) => void | Promise<void>;
}

let jobCounter = 0;

function nextJobId(): string {
  jobCounter += 1;
  return `job-${Date.now().toString(36)}-${jobCounter.toString(36)}`;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly persist?: (job: Job) => void | Promise<void>;
  private readonly remove?: (jobId: string) => void | Promise<void>;
  readonly ready: Promise<void>;

  constructor(options: JobManagerOptions = {}) {
    this.persist = options.persist;
    this.remove = options.remove;
    this.ready = Promise.resolve(options.load?.() ?? []).then(async (loaded) => {
      for (const job of loaded) {
        this.jobs.set(job.id, job);
        await this.reconcileStaleStatus(job);
      }
    }).catch(() => {});
  }

  /** Removes a job from memory and the backing store. Refuses a job that's still active. */
  async delete(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'running' || job.status === 'ready' || job.status === 'planning') {
      throw new Error(`Cannot delete job '${jobId}' while it is still active (status '${job.status}')`);
    }
    this.jobs.delete(jobId);
    if (this.remove) await this.remove(jobId);
    return true;
  }

  /**
   * Self-heals job records written before job-level status was persisted correctly
   * (runJob() used to mutate job.status in memory without ever flushing the terminal
   * transition — see setJobStatus). Those records are stuck at 'running'/'pending'
   * forever even though every task actually finished; the fix to runJob() only stops
   * *new* writes from being wrong, so anything already on disk needs correcting once
   * on load, inferred from the tasks' own (correctly persisted) statuses.
   */
  private async reconcileStaleStatus(job: Job): Promise<void> {
    const nonTerminal = job.status === 'pending' || job.status === 'planning' || job.status === 'ready' || job.status === 'running' || job.status === 'paused';
    if (!nonTerminal || job.tasks.length === 0) return;

    const allTerminal = job.tasks.every(
      (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
    );
    if (!allTerminal) return;

    const anyFailed = job.tasks.some((t) => t.status === 'failed');
    const anyCancelled = job.tasks.some((t) => t.status === 'cancelled');
    const corrected: Job['status'] = anyFailed ? 'failed' : anyCancelled ? 'cancelled' : 'completed';

    job.status = corrected;
    if (!job.completedAt) {
      // The job-level completedAt was never recorded (that's the bug being healed), but
      // each graph node already got a real completedAt at the moment it actually finished
      // (see updateNodeState) — use the latest of those instead of a rough guess.
      const latest = job.graph.nodes.reduce<Date | undefined>((acc, n) => {
        return n.completedAt && (!acc || n.completedAt > acc) ? n.completedAt : acc;
      }, undefined);
      job.completedAt = latest ?? job.createdAt;
    }
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
        capabilities: [],
        reasoning: 'low' as const,
        vision: false,
        toolCalling: false,
        minimumContext: 1024,
        minimumMemoryGB: 4,
        minimumGPUMemoryGB: 0,
        localOnly: false,
      },
      policy: undefined,
      execution: {
        targetComputerId: undefined,
        targetRuntimeId: undefined,
        targetModelId: undefined,
        targetAgentId: undefined,
        executionMode: 'automatic' as const,
        maxTurns: undefined,
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
    void this.flush(job);
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
    if (result !== undefined) {
      this.updateNodeState(job, taskId, 'completed', result);
    }
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
    if (this.persist) {
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
    requirements?: Record<string, unknown>;
    priority?: 'low' | 'normal' | 'high' | 'critical';
  };
  agentId?: string;
  dependencies?: string[];
  type?: JobNode['type'];
}

export function createJobManager(options: JobManagerOptions = {}): JobManager {
  return new JobManager(options);
}
