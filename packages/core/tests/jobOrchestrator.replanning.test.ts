import { describe, expect, it } from 'vitest';
import {
  AgentRegistry,
  ComputerRegistry,
  ExecutionEngine,
  JobManager,
  JobOrchestrator,
  ModelRegistry,
  RuntimeRegistry,
  Scheduler,
  type JobOrchestratorEvent,
  type JobTaskExecutor,
  type JobTaskOutcome,
  type Task,
} from '../src/index.js';

function setupTestOrchestrator(taskExecutor?: JobTaskExecutor): {
  orchestrator: JobOrchestrator;
  jobManager: JobManager;
} {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const executions = new ExecutionEngine();
  const jobManager = new JobManager();

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

  return { orchestrator, jobManager };
}

describe('JobOrchestrator — Dynamic Replanning on Failure', () => {
  it('spliced repair task allows dependent tasks to complete after initial step failure', async () => {
    const executedTaskIds: string[] = [];
    const taskExecutor: JobTaskExecutor = async (task: Task): Promise<JobTaskOutcome> => {
      executedTaskIds.push(task.id);

      if (task.id === 'step-build') {
        return {
          success: false,
          error: 'compiler syntax error in main.cpp: missing semicolon',
        };
      }

      return {
        success: true,
        result: `Task ${task.id} succeeded`,
      };
    };

    const { orchestrator } = setupTestOrchestrator(taskExecutor);

    const initialTasks = [
      {
        task: { id: 'step-build', type: 'coding', title: 'Build Project', input: 'build' },
        dependencies: [],
      },
      {
        task: { id: 'step-verify', type: 'coding', title: 'Verify Project', input: 'verify' },
        dependencies: ['step-build'],
      },
    ];

    const job = await orchestrator.createJob({
      title: 'Dynamic Replan Test',
      tasks: initialTasks as any,
    });

    const events: JobOrchestratorEvent[] = [];

    const replanner = async ({ failedTask }: { failedTask: Task }) => {
      if (failedTask.id === 'step-build') {
        return {
          repairTasks: [
            {
              task: {
                id: 'repair-step-build',
                type: 'coding',
                title: 'Repair Build by Fixing Syntax',
                input: 'fix syntax in main.cpp',
              },
              dependencies: ['step-build'],
            },
          ],
        };
      }
      return null;
    };

    const resultJob = await orchestrator.runJob(job.id, {
      taskExecutor,
      replanner,
      onEvent: (ev) => events.push(ev),
    });

    // Verify replan event was emitted
    const replanEv = events.find((e) => e.type === 'task:replan');
    expect(replanEv).toBeDefined();
    expect(replanEv?.taskId).toBe('step-build');

    // Verify execution sequence: step-build -> repair-step-build -> step-verify
    expect(executedTaskIds).toEqual(['step-build', 'repair-step-build', 'step-verify']);

    // The job as a whole completes successfully because the repair plan rescued it
    expect(resultJob.status).toBe('completed');
  });

  it('fails the job and never runs dependent tasks when the replanner declines to repair', async () => {
    const executedTaskIds: string[] = [];
    const taskExecutor: JobTaskExecutor = async (task: Task): Promise<JobTaskOutcome> => {
      executedTaskIds.push(task.id);

      if (task.id === 'step-build') {
        return {
          success: false,
          error: 'compiler syntax error in main.cpp: missing semicolon',
        };
      }

      return {
        success: true,
        result: `Task ${task.id} succeeded`,
      };
    };

    const { orchestrator } = setupTestOrchestrator(taskExecutor);

    const initialTasks = [
      {
        task: { id: 'step-build', type: 'coding', title: 'Build Project', input: 'build' },
        dependencies: [],
      },
      {
        task: { id: 'step-verify', type: 'coding', title: 'Verify Project', input: 'verify' },
        dependencies: ['step-build'],
      },
    ];

    const job = await orchestrator.createJob({
      title: 'Declined Replan Test',
      tasks: initialTasks as any,
    });

    // Replanner explicitly declines to repair (returns null).
    const replanner = async () => null;

    const resultJob = await orchestrator.runJob(job.id, {
      taskExecutor,
      replanner,
      onEvent: () => {},
    });

    // step-build may be retried (default maxRetries), but the dependent task
    // must never run off the back of an unrepaired failure.
    expect(executedTaskIds.every((id) => id === 'step-build')).toBe(true);
    expect(executedTaskIds).not.toContain('step-verify');
    expect(resultJob.status).toBe('failed');
  });
});
