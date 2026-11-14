import { describe, expect, it, vi } from 'vitest';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import {
  ComputerRegistry,
  ExecutionEngine,
  HARNESS_CONTRACT_SCHEMA_VERSION,
  HarnessDispatchService,
  JobManager,
  JobOrchestrator,
  ModelLifecycleService,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  type HarnessRunner,
  type Scheduler,
  type UnifiedExecutionRequest,
} from '../src/index.js';

const G = 1024 ** 3;

describe('Formal Hardening Group G — Resource Scheduling, VRAM Eviction & Budget Enforcement', () => {
  it('G-01 (FORMAL-A19-RES-01): planEviction accounts for discrete GPU VRAM shortfall even when host RAM is abundant', async () => {
    const computers = new ComputerRegistry();
    computers.register({
      id: 'dgx-node',
      name: 'dgx-node',
      type: 'server',
      local: false,
      os: { platform: 'linux', architecture: 'x64', version: '1' },
      hardware: {
        cpu: 'amd-epyc',
        cpuCores: 32,
        memoryGB: 128,
        gpu: { vendor: 'nvidia', model: 'A100', memoryGB: 32, unifiedMemory: false },
      },
    });
    computers.heartbeat('dgx-node', {
      load: {
        cpuPercent: 10,
        memoryUsedGB: 38,
        memoryAvailableGB: 90,
        gpuMemoryAvailableGB: 4,
        gpuMemoryUsedGB: 28,
      },
    });

    const models = new ModelRegistry();
    const runtimes = new RuntimeRegistry();
    const executions = new ExecutionEngine();

    const caps = {
      chat: true,
      streaming: true,
      toolCalling: true,
      structuredOutput: false,
      vision: false,
      embeddings: false,
      reasoning: false,
      modelLoad: true,
      modelUnload: true,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    };
    runtimes.register({
      id: 'r-dgx',
      type: 'ollama',
      name: 'ollama',
      version: '1',
      computerId: 'dgx-node',
      capabilities: caps,
    });
    runtimes.update('r-dgx', { health: 'healthy' });

    const loaded = new Map<string, number>();
    const adapter = {
      id: 'r-dgx',
      type: 'ollama',
      discover: async () => ({ id: 'r-dgx', name: 'r-dgx', version: '1' }),
      healthCheck: async () => ({ status: 'healthy' }),
      getCapabilities: async () => caps,
      listModels: async () => models.list().map((m) => ({ id: m.id, contextWindow: m.contextMax })),
      estimateModelLoad: vi.fn(async (id: string) => {
        const rec = models.get(id);
        const vram = (rec?.memory?.minGpuGB ?? 10) * G;
        const ram = (rec?.memory?.minSystemGB ?? 2) * G;
        return {
          weightBytes: vram,
          totalMemoryBytes: ram + vram,
          vramBytes: vram,
          source: 'RUNTIME' as const,
          confidence: 'high' as const,
        };
      }),
      loadModel: vi.fn(async (id: string, opts: { contextTokens: number }) => {
        loaded.set(id, opts.contextTokens);
      }),
      unloadModel: vi.fn(async (id: string) => {
        loaded.delete(id);
      }),
      inspectModel: vi.fn(async (id: string) => ({
        modelId: id,
        loaded: loaded.has(id),
        effectiveContext: loaded.get(id),
        memoryBytes: (models.get(id)?.memory?.minSystemGB ?? 2) * G,
      })),
      probeModel: vi.fn(async () => true),
      async *generate() {
        yield { type: 'completed', content: 'ok' };
      },
    } as unknown as RuntimeAdapter;

    const add = (id: string, minSystemGB = 2, minGpuGB = 10, residentVramGB?: number) => {
      models.register({
        id,
        name: id,
        provider: 'r-dgx',
        family: 'other',
        contextMax: 32768,
        memory: { minSystemGB, minGpuGB },
        capabilities: ['generalChat'],
        toolCalling: true,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        runtimeCompatibility: ['ollama'],
        local: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      models.upsertInstallation({
        id,
        modelId: id,
        computerId: 'dgx-node',
        runtimeId: 'r-dgx',
        runtimeModelId: id,
        installed: true,
        observedAt: new Date(),
        profile: {
          modelId: id,
          runtimeId: 'r-dgx',
          weightBytes: minGpuGB * G,
          maximumContext: 32768,
          quantization: 'fp16',
          metadata: {},
        },
      });
      models.upsertInstance({
        id,
        installationId: id,
        modelId: id,
        computerId: 'dgx-node',
        runtimeId: 'r-dgx',
        runtimeModelId: id,
        loaded: residentVramGB !== undefined,
        state: residentVramGB !== undefined ? 'READY' : 'INSTALLED',
        health: 'healthy',
        residentMemoryBytes: residentVramGB ? residentVramGB * G : undefined,
      });
      if (residentVramGB !== undefined) {
        loaded.set(id, 8192);
      }
    };

    add('victim-small', 1, 2, 2);
    add('victim-large', 2, 20, 20);
    add('model-new', 2, 20);

    const service = new ModelLifecycleService({
      models,
      computers,
      runtimes,
      executions,
      adapters: new Map([['r-dgx', adapter]]),
      policy: new PolicyEngine({ projectRoot: '/tmp' }),
    });

    const plan = await service.estimate('model-new', { evict: true });

    // VRAM shortfall is 20GB - 4GB = 16GB. Victim-small (2GB) is insufficient;
    // planEviction must select victim-large (20GB >= 16GB shortfall).
    expect(plan.admissionDecision.status).toBe('ADMITTED');
    expect(plan.modelsToEvict.map((m) => m.instanceId)).toContain('victim-large');
    expect(plan.modelsToEvict.map((m) => m.instanceId)).not.toContain('victim-small');
  });

  it('G-02 (FORMAL-A20-BDG-01 & BDG-03): HarnessDispatchService enforces maxCostUSD and aborts fallback when budget is exhausted', async () => {
    const primary: HarnessRunner = {
      descriptor: {
        harnessId: 'h-primary',
        name: 'Primary',
        version: '1',
        kind: 'native',
        capabilities: ['coding'],
        supportedTaskTypes: ['coding'],
        supportedProtocols: ['native'],
        allowsModelSelection: true,
      },
      execute: vi.fn(async (request: UnifiedExecutionRequest) => ({
        schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: request.executionId,
        taskId: request.taskId,
        harnessId: 'h-primary',
        modelId: 'm1',
        runtimeId: 'r1',
        status: 'failed' as const,
        errorKind: 'provider' as const,
        terminationReason: 'PROVIDER_ERROR' as const,
        workspaceRevision: 0,
        artifacts: [],
        toolCalls: [],
        verificationEvidenceIds: [],
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          costUSD: 5.0,
          costStatus: 'ACTUAL' as const,
          durationMs: 10,
        },
      })),
    };

    const backupExecute = vi.fn(async (request: UnifiedExecutionRequest) => ({
      schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
      executionId: request.executionId,
      taskId: request.taskId,
      harnessId: 'h-backup',
      modelId: 'm2',
      runtimeId: 'r2',
      status: 'completed' as const,
      workspaceRevision: 0,
      artifacts: [],
      toolCalls: [],
      verificationEvidenceIds: [],
      usage: {
        inputTokens: 500,
        outputTokens: 200,
        totalTokens: 700,
        costUSD: 3.0,
        costStatus: 'ACTUAL' as const,
        durationMs: 10,
      },
    }));

    const backup: HarnessRunner = {
      ...primary,
      descriptor: { ...primary.descriptor, harnessId: 'h-backup', name: 'Backup' },
      execute: backupExecute,
    };

    const service = new HarnessDispatchService({ harnesses: [primary, backup] });
    const result = await service.dispatch({
      executionId: 'exec-budget-1',
      taskId: 'task-budget-1',
      objective: 'Test budget enforcement across fallback',
      taskType: 'coding',
      harnessPreference: 'h-primary',
      workspace: { root: '/tmp', revision: 0 },
      constraints: { maxCostUSD: 5.0, allowFallback: true },
      verification: { requiredChecks: [], protectedPaths: [] },
      policyContext: {},
    });

    // Primary spent $5.00 out of $5.00 budget; backup must NOT be invoked!
    expect(primary.execute).toHaveBeenCalledTimes(1);
    expect(backupExecute).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
  });

  it('G-03 (FORMAL-A20-BDG-02): JobOrchestrator bounds recursive task replanning by maxRetries', async () => {
    const manager = new JobManager();
    const executions = new ExecutionEngine();
    const scheduler = {
      plan: () => ({ agentId: 'agent', modelId: 'model', runtimeId: 'runtime', computerId: 'computer' }),
    } as unknown as Scheduler;

    let replanCalls = 0;
    let taskExecutions = 0;

    const orchestrator = new JobOrchestrator({
      scheduler,
      executionEngine: executions,
      jobManager: manager,
      taskExecutor: async () => {
        taskExecutions += 1;
        return {
          success: false,
          error: `Simulated failure #${taskExecutions}`,
        };
      },
    });

    const job = await orchestrator.createJob({
      title: 'Bounded Replan Job',
      maxRetries: 2,
      tasks: [
        {
          task: {
            id: 'initial-task',
            input: 'Fails and triggers replan',
          },
          maxRetries: 0,
        },
      ],
    });

    const finished = await orchestrator.runJob(job.id, {
      replanner: async ({ failedTask }) => {
        replanCalls += 1;
        return {
          repairTasks: [
            {
              task: {
                id: `repair-${replanCalls}`,
                input: `Repairing ${failedTask.id}`,
              },
              maxRetries: 0,
            },
          ],
        };
      },
    });

    expect(finished.status).toBe('failed');
    expect(replanCalls).toBe(2);
  });
});
