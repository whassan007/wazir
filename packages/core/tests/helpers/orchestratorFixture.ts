import type { KeyValueStore } from '@wazir/shared';
import {
  AgentRegistry,
  ComputerRegistry,
  ExecutionEngine,
  FailureFeedbackLog,
  JobManager,
  JobOrchestrator,
  ModelRegistry,
  RuntimeRegistry,
  Scheduler,
  TaskRecoveryPolicy,
  type JobTaskExecutor,
} from '../../src/index.js';

/** One in-process "control plane": registries, a JobManager over `store`, and an orchestrator. */
export function setup(taskExecutor: JobTaskExecutor, extra: { store?: KeyValueStore; feedback?: FailureFeedbackLog; backoffBaseMs?: number;
  now?: () => number; leaseMs?: number } = {}) {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  computers.register({
    id: 'local', name: 'test-computer', type: 'workstation', local: true,
    os: { platform: 'linux', architecture: 'x64', version: '6.0' },
    hardware: { cpu: 'test-cpu', cpuCores: 8, memoryGB: 32 },
    capabilities: ['localExecution'],
  });
  runtimes.register({
    id: 'fake-runtime', type: 'other', name: 'fake-runtime', version: '1.0', computerId: 'local',
    capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false, embeddings: false,
      reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false },
  });
  models.register({
    id: 'fake-model', name: 'fake-model', provider: 'fake-runtime', family: 'other', contextMax: 32_768,
    capabilities: ['generalChat', 'coding'], toolCalling: true, structuredOutput: false, vision: false, audio: false,
    embedding: false, reasoning: false, runtimeCompatibility: 'any', local: true, createdAt: new Date(), updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'fake-model::local::fake-runtime', modelId: 'fake-model', computerId: 'local', runtimeId: 'fake-runtime',
    runtimeModelId: 'fake-model', loaded: true, health: 'healthy', contextTokens: 32_768,
  });
  agents.register({
    descriptor: { name: 'test-agent', version: '1.0', description: 'Test agent', capabilities: ['coding'], requiredTools: [],
      modelRequirements: { capabilities: ['coding'] }, permissions: [], taskTypes: ['coding', 'chat'], strategy: 'test' },
    async *run() { yield { kind: 'done', content: 'done' }; },
  }, 'native');
  const scheduler = new Scheduler({ computers, runtimes, models, agents });
  const jobManager = extra.store ? new JobManager({ store: extra.store, now: extra.now, leaseMs: extra.leaseMs }) : undefined;
  const orchestrator = new JobOrchestrator({
    scheduler, executionEngine: new ExecutionEngine(), computers, runtimes, models, agents, taskExecutor,
    ...(jobManager ? { jobManager } : {}),
    feedback: extra.feedback,
    recoveryPolicy: new TaskRecoveryPolicy({ backoffBaseMs: extra.backoffBaseMs ?? 1, backoffMaxMs: 50, random: () => 0.5 }),
  });
  return { orchestrator, jobManager };
}
