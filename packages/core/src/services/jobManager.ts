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
}

let jobCounter = 0;

function nextJobId(): string {
  jobCounter += 1;
  return `job-${Date.now().toString(36)}-${jobCounter.toString(36)}`;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly persist?: (job: Job) => void | Promise<void>;

  constructor(options: JobManagerOptions = {}) {
    this.persist = options.persist;
    (async () => {
      const loaded = await Promise.resolve(options.load?.() ?? []);
      for (const job of loaded) {
        this.jobs.set(job.id, job);
      }
    })();
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
      this.updateNodeState(job, taskId, 'failed', error);
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

  private dependenciesSatisfied(job: Job, taskId: string): boolean {
    const node = job.graph.nodes.find((n) => n.taskId === taskId || n.id === taskId);
    if (!node) return true;

    for (const dep of node.dependencies) {
      const depNode = job.graph.nodes.find((n) => n.id === dep);
      if (depNode && depNode.state !== 'completed') {
        return false;
      }
    }

    return true;
  }

  private updateNodeState(
    job: Job,
    nodeId: string,
    state: AgentState,
    result?: unknown,
    error?: string,
  ): void {
    const node = job.graph.nodes.find((n) => n.id === nodeId);
    if (node) {
      node.state = state;
      if (result !== undefined) node.result = result;
      if (error !== undefined) node.error = error;
      if (state === 'completed') node.completedAt = new Date();
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
