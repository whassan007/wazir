import type {
  Job,
  Task,
} from '../types/index.js';
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
  policy: PolicyEngine;
  agents: AgentRegistry;
  models: ModelRegistry;
  runtimes: RuntimeRegistry;
  computers: ComputerRegistry;
  /** Shared job store. If omitted, a new in-process JobManager is created and held for the orchestrator's lifetime. */
  jobManager?: JobManager;
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

export class JobOrchestrator {
  private readonly scheduler: Scheduler;
  private readonly executionEngine: ExecutionEngine;
  private readonly jobManager: JobManager;

  constructor(options: JobOrchestratorOptions) {
    this.scheduler = options.scheduler;
    this.executionEngine = options.executionEngine;
    this.jobManager = options.jobManager ?? new JobManager();
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

  async completeTask(jobId: string, taskId: string): Promise<void> {
    await this.jobManager.completeTask(jobId, taskId);
  }

  async failTask(
    jobId: string,
    taskId: string,
    error: string,
    retryCount?: number,
  ): Promise<void> {
    await this.jobManager.failTask(jobId, taskId, error, retryCount);
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.jobManager.cancel(jobId);
  }

  async resumeJob(jobId: string): Promise<void> {
    await this.jobManager.resume(jobId);
  }
}

export function createJobOrchestrator(options: JobOrchestratorOptions): JobOrchestrator {
  return new JobOrchestrator(options);
}
