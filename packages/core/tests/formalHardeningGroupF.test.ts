import { describe, it, expect } from 'vitest';
import {
  ComputerRegistry,
  ModelRegistry,
  RuntimeRegistry,
  PolicyEngine,
  Scheduler,
  SchedulingError,
  HarnessDispatchService,
  HARNESS_CONTRACT_SCHEMA_VERSION,
  type HarnessDescriptor,
  type HarnessRunner,
  type ModelRecord,
  type Task,
  type UnifiedExecutionRequest,
  type UnifiedExecutionResult,
} from '../src/index.js';
import { ModelRouter } from '../../models/src/index.js';

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-fh-groupf-1',
    type: 'coding',
    input: 'Run model fallback resilience verification',
    requirements: {},
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}

function registerModel(
  registry: ModelRegistry,
  id: string,
  overrides: Partial<ModelRecord> = {},
  computerId = 'comp-local',
): void {
  const isLocal = overrides.local ?? true;
  registry.register({
    id,
    name: id,
    provider: overrides.provider ?? (isLocal ? 'ollama' : 'anthropic'),
    family: 'other',
    contextMax: overrides.contextMax ?? 32_000,
    capabilities: overrides.capabilities ?? ['coding', 'generalChat'],
    toolCalling: overrides.toolCalling ?? true,
    structuredOutput: overrides.structuredOutput ?? true,
    vision: overrides.vision ?? false,
    audio: false,
    embedding: false,
    reasoning: overrides.reasoning ?? false,
    runtimeCompatibility: overrides.runtimeCompatibility ?? (isLocal ? ['ollama'] : ['anthropic']),
    local: isLocal,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  const runtimeId = overrides.runtimeCompatibility?.[0] ?? (isLocal ? 'ollama' : 'anthropic');
  registry.upsertInstance({
    id: `${id}::inst`,
    modelId: id,
    computerId: isLocal ? computerId : undefined,
    runtimeId,
    runtimeModelId: id,
    loaded: true,
    state: 'READY',
    health: 'healthy',
  });
}

function createBaseExecutionRequest(overrides: Partial<UnifiedExecutionRequest> = {}): UnifiedExecutionRequest {
  return {
    schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
    executionId: 'exec-fh-groupf-1',
    taskId: 'task-fh-groupf-1',
    objective: 'Execute resilient provider fallback test',
    taskType: 'coding',
    workspace: {
      root: '/tmp/wazir-fh-workspace',
      revision: 1,
    },
    constraints: {
      maxDurationMs: 10_000,
      maxTokens: 8000,
      maxToolCalls: 20,
      maxCostUSD: 2.0,
      allowFallback: true,
    },
    verification: {
      requiredChecks: [],
      protectedPaths: [],
      mutationRequired: false,
    },
    policyContext: {},
    ...overrides,
  };
}

function createMockHarness(
  descriptorOverrides: Partial<HarnessDescriptor> & { harnessId: string },
  executeImpl: (req: UnifiedExecutionRequest) => Promise<UnifiedExecutionResult>,
): HarnessRunner {
  const descriptor: HarnessDescriptor = {
    name: descriptorOverrides.name ?? descriptorOverrides.harnessId,
    version: '1.0.0',
    kind: 'native',
    capabilities: ['coding', 'step-execution', 'cancellation', 'checkpoint-resume'],
    supportedTaskTypes: ['coding', 'debugging', 'review', 'research'],
    supportedProtocols: ['native'],
    allowsModelSelection: true,
    ...descriptorOverrides,
  };

  return {
    descriptor,
    execute: executeImpl,
  };
}

describe('Formal Hardening Group F — Provider Failure Scenarios, Fallback & Policy Invariants', () => {
  // =========================================================================
  // SUB-SUITE 1: HarnessDispatchService Provider Failure & Budget Preservation
  // =========================================================================
  describe('Provider Failure & Fallback Execution in HarnessDispatchService', () => {
    it('1. falls back on primary provider infrastructure failure (HTTP 429/timeout), preserving executionId, taskId, and consumed budget', async () => {
      let attemptCount = 0;
      const executedModels: string[] = [];
      let secondAttemptRequest: UnifiedExecutionRequest | undefined;

      const harness = createMockHarness(
        { harnessId: 'primary-native', kind: 'native', allowsModelSelection: true },
        async (req) => {
          attemptCount += 1;
          const currentModel = req.modelPreference ?? 'unknown';
          executedModels.push(currentModel);

          if (attemptCount === 1) {
            // First attempt: Primary provider returns HTTP 429 Rate Limit (infrastructure error)
            return {
              schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
              executionId: req.executionId,
              taskId: req.taskId,
              harnessId: 'primary-native',
              harnessKind: 'native',
              modelId: currentModel,
              runtimeId: req.runtimePreference ?? 'ollama',
              status: 'failed',
              errorKind: 'infrastructure',
              failureClassification: 'RATE_LIMIT_EXCEEDED',
              errors: ['HTTP 429: Provider quota exceeded on primary endpoint'],
              usage: {
                inputTokens: 500,
                outputTokens: 100,
                totalTokens: 600,
                costUSD: 0.2,
                costStatus: 'ACTUAL',
                durationMs: 400,
                modelCalls: 1,
              },
            };
          }

          // Second attempt: Fallback succeeds
          secondAttemptRequest = req;
          return {
            schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
            executionId: req.executionId,
            taskId: req.taskId,
            harnessId: 'primary-native',
            harnessKind: 'native',
            modelId: currentModel,
            runtimeId: req.runtimePreference ?? 'ollama',
            status: 'completed',
            workspaceRevision: '1',
            filesChanged: ['src/patch.ts'],
            artifacts: [{ path: 'src/patch.ts', kind: 'file' }],
            usage: {
              inputTokens: 400,
              outputTokens: 200,
              totalTokens: 600,
              costUSD: 0.15,
              costStatus: 'ACTUAL',
              durationMs: 350,
              modelCalls: 1,
            },
          };
        },
      );

      const computers = new ComputerRegistry();
      computers.register({
        id: 'comp-local',
        name: 'Local Dev Rig',
        status: 'online',
        roles: ['worker'],
        runtimes: ['ollama'],
        local: true,
        hardware: { cpu: { architecture: 'arm64', logicalCores: 8 }, memory: { totalBytes: 32 * 1024 ** 3 } },
      });
      const runtimes = new RuntimeRegistry();
      runtimes.register({
        id: 'ollama',
        name: 'Ollama Runtime',
        type: 'ollama',
        version: '0.1.0',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      runtimes.update('ollama', { health: 'healthy' });

      const models = new ModelRegistry();
      registerModel(models, 'primary-coder-14b', { provider: 'ollama', local: true, contextMax: 32_000 }, 'comp-local');
      registerModel(models, 'backup-coder-7b', { provider: 'ollama', local: true, contextMax: 32_000 }, 'comp-local');

      const policy = new PolicyEngine({ projectRoot: '/tmp/wazir-fh-workspace' });
      const scheduler = new Scheduler({ computers, runtimes, models, policy });

      const dispatchService = new HarnessDispatchService({
        harnesses: [harness],
        scheduler,
        policyEngine: policy,
        verifyExecution: async () => ({ verified: true, evidenceIds: ['ev-test-1'] }),
      });

      const request = createBaseExecutionRequest({
        modelPreference: 'primary-coder-14b',
        constraints: {
          maxTokens: 5000,
          maxToolCalls: 10,
          maxCostUSD: 1.0,
          maxDurationMs: 5000,
          allowFallback: true,
        },
      });

      const result = await dispatchService.dispatch(request);

      expect(result.status).toBe('completed');
      expect(result.verified).toBe(true);
      expect(attemptCount).toBe(2);
      expect(executedModels[0]).toBe('primary-coder-14b');
      expect(executedModels[1]).toBe('backup-coder-7b');
      expect(result.modelId).toBe('backup-coder-7b');
      expect(result.executionId).toBe('exec-fh-groupf-1');
      expect(result.taskId).toBe('task-fh-groupf-1');

      // Verify decremented remaining budget in resumeContext
      expect(secondAttemptRequest).toBeDefined();
      expect(secondAttemptRequest!.executionId).toBe('exec-fh-groupf-1');
      expect(secondAttemptRequest!.constraints.maxTokens).toBe(4400); // 5000 - 600
      expect(secondAttemptRequest!.constraints.maxCostUSD).toBe(0.8); // 1.0 - 0.2
      expect(secondAttemptRequest!.resumeContext?.attempt).toBe(2);

      // Verify aggregated usage across attempts
      expect(result.usage.totalTokens).toBe(1200); // 600 + 600
      expect(result.usage.costUSD).toBe(0.35); // 0.2 + 0.15
      expect(result.usage.modelCalls).toBe(2);
    });

    it('2. fails closed immediately without fallback when allowFallback is false', async () => {
      let attemptCount = 0;

      const harness = createMockHarness(
        { harnessId: 'primary-native', kind: 'native' },
        async (req) => {
          attemptCount += 1;
          return {
            schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
            executionId: req.executionId,
            taskId: req.taskId,
            harnessId: 'primary-native',
            harnessKind: 'native',
            modelId: 'primary-coder-14b',
            runtimeId: 'ollama',
            status: 'failed',
            errorKind: 'infrastructure',
            failureClassification: 'HTTP_500_INTERNAL',
            errors: ['HTTP 500: Primary provider internal error'],
            usage: { totalTokens: 100, costUSD: 0.05, durationMs: 150 },
          };
        },
      );

      const dispatchService = new HarnessDispatchService({
        harnesses: [harness],
      });

      const request = createBaseExecutionRequest({
        constraints: {
          allowFallback: false,
        },
      });

      const result = await dispatchService.dispatch(request);

      expect(result.status).toBe('failed');
      expect(result.verified).toBe(false);
      expect(attemptCount).toBe(1);
      expect(result.errors?.[0]).toMatch(/HTTP 500/);
    });

    it('3. fails closed when all eligible fallback models exhaust and fail', async () => {
      let attemptCount = 0;

      const harness = createMockHarness(
        { harnessId: 'primary-native', kind: 'native', allowsModelSelection: true },
        async (req) => {
          attemptCount += 1;
          return {
            schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
            executionId: req.executionId,
            taskId: req.taskId,
            harnessId: 'primary-native',
            harnessKind: 'native',
            modelId: req.modelPreference ?? 'model-exhaust',
            runtimeId: 'ollama',
            status: 'failed',
            errorKind: 'infrastructure',
            failureClassification: 'PROVIDER_OUTAGE',
            errors: [`Outage on attempt ${attemptCount}`],
            usage: { totalTokens: 50, costUSD: 0.01, durationMs: 80 },
          };
        },
      );

      const computers = new ComputerRegistry();
      computers.register({
        id: 'comp-local', name: 'Dev', status: 'online', roles: ['worker'], runtimes: ['ollama'], local: true,
        hardware: { cpu: { architecture: 'arm64', logicalCores: 8 }, memory: { totalBytes: 32 * 1024 ** 3 } },
      });
      const runtimes = new RuntimeRegistry();
      runtimes.register({
        id: 'ollama', name: 'Ollama', type: 'ollama', version: '0.1.0',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      runtimes.update('ollama', { health: 'healthy' });

      const models = new ModelRegistry();
      registerModel(models, 'model-alpha', { provider: 'ollama', local: true }, 'comp-local');
      registerModel(models, 'model-beta', { provider: 'ollama', local: true }, 'comp-local');

      const policy = new PolicyEngine({ projectRoot: '/tmp/wazir-fh-workspace' });
      const scheduler = new Scheduler({ computers, runtimes, models, policy });

      const dispatchService = new HarnessDispatchService({
        harnesses: [harness],
        scheduler,
        policyEngine: policy,
      });

      const request = createBaseExecutionRequest({
        modelPreference: 'model-alpha',
        constraints: {
          maxAttempts: 4,
          allowFallback: true,
        },
      });

      const result = await dispatchService.dispatch(request);

      expect(result.status).toBe('failed');
      expect(result.verified).toBe(false);
      // Both model-alpha and model-beta were attempted, then no more models existed
      expect(attemptCount).toBe(2);
    });

    it('4. blocks automatic fallback when unconfirmed mutating tool side effects (TOOL_OUTCOME_UNKNOWN) occurred', async () => {
      let attempts = 0;

      const harness = createMockHarness(
        { harnessId: 'primary-native', kind: 'native', allowsModelSelection: true },
        async (req) => {
          attempts += 1;
          return {
            schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
            executionId: req.executionId,
            taskId: req.taskId,
            harnessId: 'primary-native',
            harnessKind: 'native',
            modelId: 'primary-model',
            runtimeId: 'ollama',
            status: 'interrupted',
            errorKind: 'infrastructure',
            toolCalls: [
              {
                id: 'tc-mut-1',
                tool: 'write_file',
                failureClass: 'TOOL_OUTCOME_UNKNOWN',
                at: new Date(),
              },
            ],
            usage: { totalTokens: 100, costUSD: 0, durationMs: 100 },
          };
        },
      );

      const dispatchService = new HarnessDispatchService({
        harnesses: [harness],
      });

      const request = createBaseExecutionRequest({
        constraints: { allowFallback: true },
      });

      const result = await dispatchService.dispatch(request);

      expect(result.status).toBe('failed');
      expect(result.failureClassification).toBe('UNCONFIRMED_SIDE_EFFECT_BLOCKS_FALLBACK');
      expect(attempts).toBe(1); // Blocked before attempting fallback
      expect(result.errors?.[0]).toMatch(/unconfirmed side effect \(TOOL_OUTCOME_UNKNOWN\), blocking fallback/);
    });
  });

  // =========================================================================
  // SUB-SUITE 2: Privacy Boundaries & Local-Only Invariant Preservation
  // =========================================================================
  describe('Local-Only & Data-Classification Privacy Preservation on Fallback', () => {
    function setupFleetWithLocalAndHosted(options: { allowHostedProvidersDefault?: boolean } = {}) {
      const computers = new ComputerRegistry();
      computers.register({
        id: 'comp-local',
        name: 'Local Workstation',
        status: 'online',
        roles: ['worker'],
        runtimes: ['ollama'],
        local: true,
        hardware: { cpu: { architecture: 'arm64', logicalCores: 8 }, memory: { totalBytes: 32 * 1024 ** 3 } },
      });

      const runtimes = new RuntimeRegistry();
      runtimes.register({
        id: 'ollama',
        name: 'Ollama Local',
        type: 'ollama',
        version: '0.1.0',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      runtimes.update('ollama', { health: 'healthy' });

      runtimes.register({
        id: 'anthropic',
        name: 'Anthropic Cloud',
        type: 'anthropic',
        version: 'v1',
        runtimeKind: 'hosted',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: true, embeddings: false, reasoning: true, modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false },
      });
      runtimes.update('anthropic', { health: 'healthy' });

      const models = new ModelRegistry();
      // Primary local model (healthy)
      registerModel(models, 'local-primary-coder', {
        provider: 'ollama',
        runtimeCompatibility: ['ollama'],
        local: true,
        contextMax: 32_000,
        capabilities: ['coding'],
      }, 'comp-local');
      // Fallback local model (healthy)
      registerModel(models, 'local-fallback-coder', {
        provider: 'ollama',
        runtimeCompatibility: ['ollama'],
        local: true,
        contextMax: 32_000,
        capabilities: ['coding'],
      }, 'comp-local');
      // High-capability hosted cloud model
      registerModel(models, 'hosted-claude-3-opus', {
        provider: 'anthropic',
        runtimeCompatibility: ['anthropic'],
        local: false,
        contextMax: 200_000,
        capabilities: ['coding', 'reasoning'],
      });

      const policy = new PolicyEngine({ projectRoot: '/tmp/wazir-fh-workspace', ...options });
      const scheduler = new Scheduler({ computers, runtimes, models, policy });

      return { computers, runtimes, models, policy, scheduler };
    }

    it('5. strictly prevents localOnly tasks from falling back to hosted model upon primary local failure', () => {
      const { scheduler } = setupFleetWithLocalAndHosted({ allowHostedProvidersDefault: true });

      const task = createMockTask({
        policy: { localOnly: true },
        execution: { allowFallback: true },
      });

      // Primary local model excluded as if failed
      const decision = scheduler.plan({
        task,
        excludeModelIds: ['local-primary-coder'],
      });

      // Fallback MUST be the local fallback coder, NEVER the hosted model!
      expect(decision.modelId).toBe('local-fallback-coder');
      expect(decision.runtimeId).toBe('ollama');
      expect(decision.computerId).toBe('comp-local');
    });

    it('6. sensitive dataClassification forbids hosted fallback even when engine allows hosted providers', () => {
      const { scheduler } = setupFleetWithLocalAndHosted({ allowHostedProvidersDefault: true });

      const task = createMockTask({
        policy: { dataClassification: 'sensitive' },
        execution: { allowFallback: true },
      });

      const decision = scheduler.plan({
        task,
        excludeModelIds: ['local-primary-coder'],
      });

      expect(decision.modelId).toBe('local-fallback-coder');
      expect(decision.runtimeId).toBe('ollama');
    });

    it('7. restricted dataClassification overrides task allowHostedProviders: true on fallback', () => {
      const { scheduler } = setupFleetWithLocalAndHosted({ allowHostedProvidersDefault: true });

      const task = createMockTask({
        policy: { dataClassification: 'restricted', allowHostedProviders: true },
        execution: { allowFallback: true },
      });

      const decision = scheduler.plan({
        task,
        excludeModelIds: ['local-primary-coder'],
      });

      expect(decision.modelId).toBe('local-fallback-coder');
      expect(decision.runtimeId).toBe('ollama');
    });

    it('8. fails closed when all local models fail and remaining fallback models are remote/hosted', () => {
      const { scheduler } = setupFleetWithLocalAndHosted({ allowHostedProvidersDefault: true });

      const task = createMockTask({
        policy: { localOnly: true },
        execution: { allowFallback: true },
      });

      // Both local models excluded / failed
      expect(() =>
        scheduler.plan({
          task,
          excludeModelIds: ['local-primary-coder', 'local-fallback-coder'],
        }),
      ).toThrow(SchedulingError);
    });
  });

  // =========================================================================
  // SUB-SUITE 3: Capability & Context Window Filtering on Fallback
  // =========================================================================
  describe('Capability & Context Window Filtering on Fallback', () => {
    function setupFleetWithVaryingCapabilities() {
      const computers = new ComputerRegistry();
      computers.register({
        id: 'comp-1', name: 'Rig', status: 'online', roles: ['worker'], runtimes: ['ollama'], local: true,
        hardware: { cpu: { architecture: 'arm64', logicalCores: 8 }, memory: { totalBytes: 64 * 1024 ** 3 } },
      });
      const runtimes = new RuntimeRegistry();
      runtimes.register({
        id: 'ollama', name: 'Ollama', type: 'ollama', version: '0.1.0',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: true, embeddings: false, reasoning: true, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      runtimes.update('ollama', { health: 'healthy' });

      const models = new ModelRegistry();
      // Primary model: has toolCalling, 64k context
      registerModel(models, 'model-primary', {
        contextMax: 64_000,
        toolCalling: true,
        vision: false,
        reasoning: false,
        capabilities: ['coding'],
      }, 'comp-1');
      // Fallback candidate 1: lacks toolCalling!
      registerModel(models, 'model-no-tools', {
        contextMax: 64_000,
        toolCalling: false,
        vision: false,
        reasoning: false,
        capabilities: ['coding'],
      }, 'comp-1');
      // Fallback candidate 2: has toolCalling, but contextMax is only 8k!
      registerModel(models, 'model-small-context', {
        contextMax: 8_192,
        toolCalling: true,
        vision: false,
        reasoning: false,
        capabilities: ['coding'],
      }, 'comp-1');
      // Fallback candidate 3: has toolCalling, 64k context, satisfies all constraints
      registerModel(models, 'model-capable-fallback', {
        contextMax: 64_000,
        toolCalling: true,
        vision: false,
        reasoning: false,
        capabilities: ['coding'],
      }, 'comp-1');

      const policy = new PolicyEngine({ projectRoot: '/tmp/wazir-fh-workspace' });
      const scheduler = new Scheduler({ computers, runtimes, models, policy });

      return { scheduler, models };
    }

    it('9. rejects fallback candidates that lack required capabilities (toolCalling)', () => {
      const { scheduler } = setupFleetWithVaryingCapabilities();

      const task = createMockTask({
        requirements: { toolCalling: true },
        execution: { allowFallback: true },
      });

      const decision = scheduler.plan({
        task,
        excludeModelIds: ['model-primary'],
      });

      // 'model-no-tools' must be rejected even though it has 64k context!
      expect(decision.modelId).not.toBe('model-no-tools');
      expect(['model-small-context', 'model-capable-fallback']).toContain(decision.modelId);
    });

    it('10. rejects fallback candidates whose context window is smaller than required minimumContext', () => {
      const { scheduler } = setupFleetWithVaryingCapabilities();

      const task = createMockTask({
        requirements: { minimumContext: 32_000 },
        execution: { allowFallback: true },
      });

      const decision = scheduler.plan({
        task,
        excludeModelIds: ['model-primary'],
      });

      // 'model-small-context' (8k) MUST be rejected!
      expect(decision.modelId).not.toBe('model-small-context');
      expect(['model-no-tools', 'model-capable-fallback']).toContain(decision.modelId);
    });

    it('11. selects fallback candidate that satisfies multi-capability and context window conjunction', () => {
      const { scheduler } = setupFleetWithVaryingCapabilities();

      const task = createMockTask({
        requirements: {
          toolCalling: true,
          minimumContext: 32_000,
          capabilities: ['coding'],
        },
        execution: { allowFallback: true },
      });

      const decision = scheduler.plan({
        task,
        excludeModelIds: ['model-primary'],
      });

      // Only 'model-capable-fallback' satisfies both toolCalling: true AND context >= 32k!
      expect(decision.modelId).toBe('model-capable-fallback');
    });

    it('12. fails closed if no fallback candidates satisfy the conjunction of required constraints', () => {
      const { scheduler } = setupFleetWithVaryingCapabilities();

      const task = createMockTask({
        requirements: {
          toolCalling: true,
          minimumContext: 32_000,
          vision: true, // No model has vision
        },
        execution: { allowFallback: true },
      });

      expect(() =>
        scheduler.plan({
          task,
          excludeModelIds: ['model-primary'],
        }),
      ).toThrow(SchedulingError);
    });
  });

  // =========================================================================
  // SUB-SUITE 4: Approved-Provider Enforcement & Strict Authorization
  // =========================================================================
  describe('Approved-Provider Enforcement & Authorization Bounds on Fallback', () => {
    function setupMultiProviderFleet(options: { engineRoutingMode?: 'provider_only' | 'auto'; defaultProvider?: string } = {}) {
      const computers = new ComputerRegistry();
      computers.register({
        id: 'comp-dgx', name: 'NVIDIA DGX Station', status: 'online', roles: ['worker'], runtimes: ['nvidia'], local: true,
        hardware: { cpu: { architecture: 'x86_64', logicalCores: 64 }, memory: { totalBytes: 256 * 1024 ** 3 } },
      });
      computers.register({
        id: 'comp-mac', name: 'Apple Studio', status: 'online', roles: ['worker'], runtimes: ['ollama'], local: true,
        hardware: { cpu: { architecture: 'arm64', logicalCores: 24 }, memory: { totalBytes: 128 * 1024 ** 3 } },
      });

      const runtimes = new RuntimeRegistry();
      runtimes.register({
        id: 'nvidia', name: 'NVIDIA vLLM', type: 'nvidia', version: '0.6.0',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: true, embeddings: false, reasoning: true, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      runtimes.register({
        id: 'ollama', name: 'Ollama', type: 'ollama', version: '0.1.0',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      runtimes.update('nvidia', { health: 'healthy' });
      runtimes.update('ollama', { health: 'healthy' });

      const models = new ModelRegistry();
      // NVIDIA models
      registerModel(models, 'nvidia/nemotron-primary', {
        provider: 'nvidia', runtimeCompatibility: ['nvidia'], local: true, capabilities: ['coding'],
      }, 'comp-dgx');
      registerModel(models, 'nvidia/nemotron-fallback', {
        provider: 'nvidia', runtimeCompatibility: ['nvidia'], local: true, capabilities: ['coding'],
      }, 'comp-dgx');
      // Other provider models
      registerModel(models, 'ollama/qwen2.5-coder', {
        provider: 'ollama', runtimeCompatibility: ['ollama'], local: true, capabilities: ['coding'],
      }, 'comp-mac');

      const policy = new PolicyEngine({ projectRoot: '/tmp/wazir-fh-workspace' });
      const scheduler = new Scheduler({
        computers,
        runtimes,
        models,
        policy,
        routing: options.engineRoutingMode === 'provider_only'
          ? { mode: 'provider_only', provider: options.defaultProvider ?? 'nvidia', allowFallback: true }
          : undefined,
      });

      return { scheduler, models };
    }

    it('13. strictly confines fallback to approved provider when routingMode is PROVIDER_ONLY (nvidia)', () => {
      const { scheduler } = setupMultiProviderFleet({ engineRoutingMode: 'provider_only', defaultProvider: 'nvidia' });

      const task = createMockTask({
        execution: {
          routingMode: 'PROVIDER_ONLY',
          routingProvider: 'nvidia',
          allowFallback: true,
        },
      });

      const decision = scheduler.plan({
        task,
        excludeModelIds: ['nvidia/nemotron-primary'],
      });

      // Must select nvidia fallback model, NOT ollama/qwen2.5-coder!
      expect(decision.modelId).toBe('nvidia/nemotron-fallback');
      expect(decision.runtimeId).toBe('nvidia');
    });

    it('14. fails closed under provider_only routing when all approved provider models fail', () => {
      const { scheduler } = setupMultiProviderFleet({ engineRoutingMode: 'provider_only', defaultProvider: 'nvidia' });

      const task = createMockTask({
        execution: {
          routingMode: 'PROVIDER_ONLY',
          routingProvider: 'nvidia',
          allowFallback: true,
        },
      });

      // Both nvidia models failed
      expect(() =>
        scheduler.plan({
          task,
          excludeModelIds: ['nvidia/nemotron-primary', 'nvidia/nemotron-fallback'],
        }),
      ).toThrow(SchedulingError);
    });

    it('15. strictly enforces task policy.allowedModels authorization allowlist on fallback', () => {
      const { scheduler } = setupMultiProviderFleet({ engineRoutingMode: 'auto' });

      const task = createMockTask({
        policy: {
          allowedModels: ['nvidia/nemotron-primary', 'ollama/qwen2.5-coder'],
        },
        execution: {
          routingMode: 'AUTO',
          allowFallback: true,
        },
      });

      // Primary fails
      const decision = scheduler.plan({
        task,
        excludeModelIds: ['nvidia/nemotron-primary'],
      });

      // Even though 'nvidia/nemotron-fallback' is registered and healthy, it is NOT in allowedModels!
      expect(decision.modelId).toBe('ollama/qwen2.5-coder');
    });

    it('16. strictly enforces task policy.allowedProviders authorization on fallback', () => {
      const { scheduler } = setupMultiProviderFleet({ engineRoutingMode: 'auto' });

      const task = createMockTask({
        policy: {
          // Explicit allowedProviders
          allowedProviders: ['nvidia'],
          allowHostedProviders: true,
        } as any,
        execution: {
          routingMode: 'AUTO',
          allowFallback: true,
        },
      });

      const decision = scheduler.plan({
        task,
        excludeModelIds: ['nvidia/nemotron-primary'],
      });

      expect(decision.modelId).toBe('nvidia/nemotron-fallback');
    });

    it('17. explicit user model pin (targetModelId) refuses silent fallback and fails closed', () => {
      const { scheduler } = setupMultiProviderFleet({ engineRoutingMode: 'provider_only', defaultProvider: 'nvidia' });

      const task = createMockTask({
        execution: {
          targetModelId: 'nvidia/nemotron-primary',
          allowFallback: false,
        },
      });

      // Pinned model fails / excluded
      expect(() =>
        scheduler.plan({
          task,
          excludeModelIds: ['nvidia/nemotron-primary'],
        }),
      ).toThrow(/Requested model 'nvidia\/nemotron-primary' is not eligible.*No silent fallback will be performed/);
    });
  });

  // =========================================================================
  // SUB-SUITE 5: @wazir/models ModelRouter Formal Verification
  // =========================================================================
  describe('@wazir/models ModelRouter Unit & Invariant Verification', () => {
    const mockModelList: ModelRecord[] = [
      {
        id: 'local-qwen-coder-14b',
        name: 'Qwen Coder 14B',
        provider: 'ollama',
        family: 'qwen',
        contextMax: 32_768,
        capabilities: ['coding', 'generalChat'],
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: true,
        runtimeCompatibility: ['ollama'],
        local: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'local-deepseek-coder-7b',
        name: 'DeepSeek Coder 7B',
        provider: 'ollama',
        family: 'deepseek',
        contextMax: 16_384,
        capabilities: ['coding'],
        toolCalling: false, // lacks tool calling
        structuredOutput: true,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        runtimeCompatibility: ['ollama'],
        local: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'remote-claude-3-sonnet',
        name: 'Claude 3.5 Sonnet',
        provider: 'anthropic',
        family: 'claude',
        contextMax: 200_000,
        capabilities: ['coding', 'generalChat'],
        toolCalling: true,
        structuredOutput: true,
        vision: true,
        audio: false,
        embedding: false,
        reasoning: true,
        runtimeCompatibility: ['anthropic'],
        local: false, // remote/hosted
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'nvidia-nemotron-70b',
        name: 'Nemotron 70B',
        provider: 'nvidia',
        family: 'nemotron',
        contextMax: 65_536,
        capabilities: ['coding', 'generalChat'],
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: true,
        runtimeCompatibility: ['nvidia'],
        local: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    it('18. ModelRouter.routeFallback excludes failed model IDs and selects next best match', () => {
      const router = new ModelRouter(mockModelList);

      const primary = router.route({
        capabilities: ['coding'],
        toolCalling: true,
      });
      expect(primary).not.toBeNull();

      // Primary fails: routeFallback excludes primary
      const fallback = router.routeFallback(
        { capabilities: ['coding'], toolCalling: true },
        primary!.modelId,
      );

      expect(fallback).not.toBeNull();
      expect(fallback!.modelId).not.toBe(primary!.modelId);
    });

    it('19. ModelRouter strictly enforces localOnly and isSensitive constraints against remote models', () => {
      const router = new ModelRouter(mockModelList);

      // Even though remote-claude-3-sonnet has highest score / context, localOnly excludes it
      const decisionLocalOnly = router.route({
        capabilities: ['coding'],
        toolCalling: true,
        localOnly: true,
      });
      expect(decisionLocalOnly).not.toBeNull();
      expect(decisionLocalOnly!.modelId).not.toBe('remote-claude-3-sonnet');

      const decisionSensitive = router.route({
        capabilities: ['coding'],
        toolCalling: true,
        isSensitive: true,
      });
      expect(decisionSensitive).not.toBeNull();
      expect(decisionSensitive!.modelId).not.toBe('remote-claude-3-sonnet');
    });

    it('20. ModelRouter enforces allowedModels and allowedProviders authorization bounds on fallback', () => {
      const router = new ModelRouter(mockModelList);

      const decision = router.routeFallback(
        {
          capabilities: ['coding'],
          allowedModels: ['local-qwen-coder-14b', 'nvidia-nemotron-70b'],
          provider: 'nvidia',
        },
        'local-qwen-coder-14b', // Primary failed
      );

      expect(decision).not.toBeNull();
      expect(decision!.modelId).toBe('nvidia-nemotron-70b');
    });

    it('21. ModelRouter enforces minimumContext requirement on fallback and returns null when no models fit', () => {
      const router = new ModelRouter(mockModelList);

      // Require 50k context, local-only
      const decision = router.route({
        capabilities: ['coding'],
        minimumContext: 50_000,
        localOnly: true,
      });

      // Only nvidia-nemotron-70b has 65k context locally
      expect(decision).not.toBeNull();
      expect(decision!.modelId).toBe('nvidia-nemotron-70b');

      // If nvidia-nemotron-70b fails, no other local model has >= 50k context!
      const fallback = router.routeFallback(
        { capabilities: ['coding'], minimumContext: 50_000, localOnly: true },
        'nvidia-nemotron-70b',
      );

      expect(fallback).toBeNull();
    });
  });
});
