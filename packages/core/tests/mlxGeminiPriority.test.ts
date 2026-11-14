import { describe, it, expect } from 'vitest';
import {
  AccountRegistry,
  ComputerRegistry,
  DEFAULT_POLICY,
  ModelRegistry,
  PolicyEngine,
  ResourceLedger,
  ResourceRouter,
  RuntimeRegistry,
  Scheduler,
  TokenBudgetManager,
  type ModelCapability,
  type ModelLifecycleState,
  type RuntimeType,
  type Task,
} from '../src/index.js';
import { discoverRuntimes } from '../../workers/src/runtimeDiscovery.js';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-priority-1',
    type: 'coding',
    input: 'Implement a TypeScript parser module and unit tests',
    requirements: { toolCalling: true },
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}

interface PriorityHarnessOptions {
  allowHostedProvidersDefault?: boolean;
  googleHealthy?: boolean;
  mlxHealthy?: boolean;
  mlxLoaded?: boolean;
  lmstudioHealthy?: boolean;
  lmstudioLoaded?: boolean;
  sharedLocalModelId?: boolean;
}

function buildPriorityHarness(opts: PriorityHarnessOptions = {}) {
  const {
    allowHostedProvidersDefault = true,
    googleHealthy = true,
    mlxHealthy = true,
    mlxLoaded = false,
    lmstudioHealthy = true,
    lmstudioLoaded = true,
    sharedLocalModelId = false,
  } = opts;

  const computers = new ComputerRegistry();
  computers.register({
    id: 'macbook-pro',
    name: 'WaelMacPro',
    type: 'workstation',
    local: true,
    os: { platform: 'darwin', architecture: 'arm64', version: '24.0.0' },
    hardware: {
      cpu: 'Apple M4 Max',
      cpuCores: 16,
      memoryGB: 64,
      gpu: { vendor: 'apple', model: 'Apple M4 Max', memoryGB: 64, unifiedMemory: true },
    },
    capabilities: ['localExecution'],
  });
  computers.heartbeat('macbook-pro', {
    load: { cpuPercent: 12, memoryUsedGB: 14, memoryAvailableGB: 50 },
    runtimeHealth: {
      mlx: { status: mlxHealthy ? 'healthy' : 'unhealthy' },
      lmstudio: { status: lmstudioHealthy ? 'healthy' : 'unhealthy' },
    },
  });

  const runtimes = new RuntimeRegistry();
  const baseCaps = {
    chat: true,
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    vision: true,
    embeddings: false,
    reasoning: true,
    modelLoad: true,
    modelUnload: true,
    modelDownload: false,
    statefulChat: false,
    mcp: false,
  };

  runtimes.register({
    id: 'google',
    type: 'google',
    name: 'Google Gemini',
    version: 'v1beta',
    runtimeKind: 'hosted',
    capabilities: { ...baseCaps, modelLoad: false, modelUnload: false },
  });
  runtimes.update('google', { health: googleHealthy ? 'healthy' : 'unavailable' });

  runtimes.register({
    id: 'mlx',
    type: 'mlx',
    name: 'MLX LM Server',
    version: 'mlx_lm',
    url: 'http://127.0.0.1:8080',
    computerId: 'macbook-pro',
    capabilities: baseCaps,
  });
  runtimes.update('mlx', { health: mlxHealthy ? 'healthy' : 'unavailable' });

  runtimes.register({
    id: 'lmstudio',
    type: 'lmstudio',
    name: 'LM Studio',
    version: '0.3',
    url: 'http://127.0.0.1:1234',
    computerId: 'macbook-pro',
    capabilities: baseCaps,
  });
  runtimes.update('lmstudio', { health: lmstudioHealthy ? 'healthy' : 'unavailable' });

  const models = new ModelRegistry();
  const commonCaps: ModelCapability[] = ['generalChat', 'coding', 'toolCalling', 'reasoning'];

  // 1. Hosted Gemini model
  models.register({
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    family: 'other',
    contextMax: 1_048_576,
    capabilities: commonCaps,
    toolCalling: true,
    structuredOutput: true,
    vision: true,
    audio: false,
    embedding: false,
    reasoning: true,
    runtimeCompatibility: ['google'],
    local: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'gemini-2.5-pro::hosted::google',
    modelId: 'gemini-2.5-pro',
    runtimeId: 'google',
    runtimeModelId: 'gemini-2.5-pro',
    loaded: googleHealthy,
    state: googleHealthy ? 'READY' : 'UNAVAILABLE',
    health: googleHealthy ? 'healthy' : 'unavailable',
  });

  // 2. Local MLX model (mlx-community/Qwen3.5-9B-6bit)
  const mlxModelId = 'mlx-community/Qwen3.5-9B-6bit';
  const lmsModelId = sharedLocalModelId ? mlxModelId : 'qwen2.5-coder-7b-instruct';

  models.register({
    id: mlxModelId,
    name: mlxModelId,
    provider: 'mlx',
    family: 'qwen',
    parameters: '9B',
    quantization: '6bit',
    contextMax: 131_072,
    capabilities: commonCaps,
    toolCalling: true,
    structuredOutput: true,
    vision: true,
    audio: false,
    embedding: false,
    reasoning: true,
    runtimeCompatibility: sharedLocalModelId ? (['mlx', 'lmstudio'] as RuntimeType[]) : ['mlx'],
    local: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const mlxState: ModelLifecycleState = !mlxHealthy ? 'UNAVAILABLE' : mlxLoaded ? 'READY' : 'INSTALLED';
  models.upsertInstance({
    id: `${mlxModelId}::macbook-pro::mlx`,
    modelId: mlxModelId,
    computerId: 'macbook-pro',
    runtimeId: 'mlx',
    runtimeModelId: mlxModelId,
    loaded: mlxHealthy && mlxLoaded,
    state: mlxState,
    health: mlxHealthy ? 'healthy' : 'unavailable',
    contextTokens: mlxLoaded ? 32768 : undefined,
  });

  // 3. Local LM Studio model
  if (!sharedLocalModelId) {
    models.register({
      id: lmsModelId,
      name: lmsModelId,
      provider: 'lmstudio',
      family: 'qwen',
      parameters: '7B',
      quantization: 'Q4_K_M',
      contextMax: 32_768,
      capabilities: commonCaps,
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: true,
      runtimeCompatibility: ['lmstudio'],
      local: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  const lmsState: ModelLifecycleState = !lmstudioHealthy ? 'UNAVAILABLE' : lmstudioLoaded ? 'READY' : 'INSTALLED';
  models.upsertInstance({
    id: `${lmsModelId}::macbook-pro::lmstudio`,
    modelId: lmsModelId,
    computerId: 'macbook-pro',
    runtimeId: 'lmstudio',
    runtimeModelId: lmsModelId,
    loaded: lmstudioHealthy && lmstudioLoaded,
    state: lmsState,
    health: lmstudioHealthy ? 'healthy' : 'unavailable',
    contextTokens: lmstudioLoaded ? 32768 : undefined,
  });

  const ledger = new ResourceLedger(':memory:');
  const accounts = new AccountRegistry();
  accounts.addImplicit({
    localRuntimes: ['mlx', 'ollama', 'lmstudio'],
    hostedRuntimes: ['google'],
    agents: [],
    hostedAuthorized: allowHostedProvidersDefault,
  });
  const budget = new TokenBudgetManager(ledger, accounts, { ...DEFAULT_POLICY });
  const resolveAccount = (runtimeId: string, modelId: string) =>
    accounts.candidates({ runtimeId, modelId })[0]?.id;
  const router = new ResourceRouter({ budget, resolveAccount });

  const policy = new PolicyEngine({
    projectRoot: '/tmp',
    allowHostedProvidersDefault,
  });

  const scheduler = new Scheduler({
    computers,
    runtimes,
    models,
    policy,
    resources: { router },
  });

  return { scheduler, ledger };
}

describe('Runtime Priority: Gemini (google) -> mlx_lm.server (mlx) -> LM Studio (lmstudio)', () => {
  it('1. selects Google Gemini ahead of mlx_lm.server and LM Studio when hosted providers are authorized', () => {
    const { scheduler, ledger } = buildPriorityHarness({
      allowHostedProvidersDefault: true,
      googleHealthy: true,
      mlxHealthy: true,
      mlxLoaded: true,
      lmstudioHealthy: true,
      lmstudioLoaded: true,
    });
    try {
      const decision = scheduler.plan({ task: makeTask() });
      expect(decision.runtimeId).toBe('google');
      expect(decision.modelId).toBe('gemini-2.5-pro');
    } finally {
      ledger.close();
    }
  });

  it('2. selects cold mlx_lm.server ahead of already-warm LM Studio when Gemini is unauthorized or offline', () => {
    const { scheduler, ledger } = buildPriorityHarness({
      allowHostedProvidersDefault: false,
      googleHealthy: false,
      mlxHealthy: true,
      mlxLoaded: false, // cold MLX!
      lmstudioHealthy: true,
      lmstudioLoaded: true, // warm LM Studio!
    });
    try {
      const decision = scheduler.plan({ task: makeTask() });
      expect(decision.runtimeId).toBe('mlx');
      expect(decision.modelId).toBe('mlx-community/Qwen3.5-9B-6bit');
    } finally {
      ledger.close();
    }
  });

  it('3. enforces localOnly privacy gate (blocks Gemini) and routes to mlx_lm.server before LM Studio', () => {
    const { scheduler, ledger } = buildPriorityHarness({
      allowHostedProvidersDefault: true,
      googleHealthy: true,
      mlxHealthy: true,
      mlxLoaded: false,
      lmstudioHealthy: true,
      lmstudioLoaded: true,
    });
    try {
      const decision = scheduler.plan({
        task: makeTask({ policy: { localOnly: true, allowHostedProviders: true } }),
      });
      expect(decision.runtimeId).toBe('mlx');
      expect(decision.modelId).toBe('mlx-community/Qwen3.5-9B-6bit');
    } finally {
      ledger.close();
    }
  });

  it('4. falls back cleanly to LM Studio when both Gemini and mlx_lm.server are unavailable', () => {
    const { scheduler, ledger } = buildPriorityHarness({
      allowHostedProvidersDefault: true,
      googleHealthy: false,
      mlxHealthy: false,
      lmstudioHealthy: true,
      lmstudioLoaded: true,
    });
    try {
      const decision = scheduler.plan({ task: makeTask() });
      expect(decision.runtimeId).toBe('lmstudio');
      expect(decision.modelId).toBe('qwen2.5-coder-7b-instruct');
    } finally {
      ledger.close();
    }
  });

  it('5. places onto mlx_lm.server ahead of LM Studio when the exact same HF model ID exists on both runtimes', () => {
    const { scheduler, ledger } = buildPriorityHarness({
      allowHostedProvidersDefault: false,
      googleHealthy: false,
      mlxHealthy: true,
      mlxLoaded: false,
      lmstudioHealthy: true,
      lmstudioLoaded: true,
      sharedLocalModelId: true,
    });
    try {
      const decision = scheduler.plan({ task: makeTask() });
      expect(decision.modelId).toBe('mlx-community/Qwen3.5-9B-6bit');
      expect(decision.runtimeId).toBe('mlx');
    } finally {
      ledger.close();
    }
  });

  it('6. discoverRuntimes preserves caller adapter priority order [mlx, ollama, lmstudio]', async () => {
    const stubAdapter = (id: string, type: RuntimeAdapter['type']): RuntimeAdapter => ({
      id,
      type,
      discover: async () => ({ id, name: id, version: '1.0' }),
      healthCheck: async () => ({ status: 'healthy' }),
      listModels: async () => [],
      getCapabilities: async () => ({
        chat: true,
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        embeddings: false,
        reasoning: false,
        modelLoad: false,
        modelUnload: false,
        modelDownload: false,
        statefulChat: false,
        mcp: false,
      }),
      estimateResources: async () => ({}),
      generate: async function* () {},
      cancel: async () => {},
    });

    const discovered = await discoverRuntimes([
      stubAdapter('mlx', 'mlx'),
      stubAdapter('ollama', 'ollama'),
      stubAdapter('lmstudio', 'lmstudio'),
    ]);
    expect(discovered.map((d) => d.id)).toEqual(['mlx', 'ollama', 'lmstudio']);
  });
});
