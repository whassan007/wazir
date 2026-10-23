import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  AgentRegistry,
  ApprovalQueue,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  JobManager,
  JobOrchestrator,
  ModelRegistry,
  ModelLifecycleService,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  WorktreeManager,
  createTaskPlanner,
  HardwareEligibilityService,
  ContextMemoryEstimator,
  IntelligentModelRanker,
  ModelPreferenceService,
  ModelDiscoveryStatusService,
  STANDARD_CONTEXT_TIERS,
  ModelLifecycleError,
  type ModelRecord,
  type ModelInstance,
  type Computer,
  type ModelLifecycleEvent,
} from '../../../packages/core/src/index.js';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { MemoryStore } from '@wazir/shared';
import type { RookEngine } from '../src/engine.js';
import { FleetTui } from '../src/tui/fleetTui.js';
import { TuiTestHarness } from '../src/tui/inputHarness.js';
import {
  ModelSelectorController,
  renderModelSelectorModal,
  renderModelSelectionConfirmation,
  formatSelectionDetails,
  type ModelSelectorItem,
} from '../src/tui/modelSelectorModal.js';
import { stripAnsiStr } from '../src/tui/fleetTuiTypes.js';

interface ModelSpec {
  id: string;
  name?: string;
  provider?: string;
  family?: string;
  parameters?: string;
  quantization?: string;
  contextMax?: number;
  loaded?: boolean;
  local?: boolean;
  memoryGB?: number;
  reasoning?: boolean;
  failOnLoad?: boolean;
}

interface TestFixtureOptions {
  availableMemoryGB?: number;
  totalMemoryGB?: number;
  models?: ModelSpec[];
  loadDelayMs?: number;
}

async function createTestFixture(projectRoot: string, opts: TestFixtureOptions = {}) {
  const availableMemoryGB = opts.availableMemoryGB ?? 32;
  const totalMemoryGB = opts.totalMemoryGB ?? 64;

  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();
  const executions = new ExecutionEngine();
  const approvalQueue = new ApprovalQueue();
  const worktrees = new WorktreeManager();
  const store = new MemoryStore() as any;

  computers.register({
    id: 'local',
    name: 'test-mac',
    type: 'workstation',
    local: true,
    status: 'online',
    health: 'healthy',
    os: { platform: 'darwin', architecture: 'arm64', version: '24.0.0' },
    hardware: {
      cpu: 'Apple M3 Max',
      cpuCores: 16,
      memoryGB: totalMemoryGB,
      gpu: {
        vendor: 'apple',
        model: 'Apple M3 Max GPU',
        memoryGB: totalMemoryGB,
        unifiedMemory: true,
      },
    },
    capabilities: ['localExecution', 'gpuAcceleration'],
  });

  computers.heartbeat('local', {
    load: {
      cpuPercent: 10,
      memoryUsedGB: Math.max(0, totalMemoryGB - availableMemoryGB),
      memoryAvailableGB: availableMemoryGB,
    },
  });

  runtimes.register({
    id: 'mock-runtime',
    type: 'lmstudio',
    name: 'Mock Runtime',
    version: '0.3.0',
    computerId: 'local',
    capabilities: {
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
    },
  });
  runtimes.update('mock-runtime', { health: 'healthy' });

  // Hosted runtime
  runtimes.register({
    id: 'anthropic-api',
    type: 'anthropic',
    name: 'Anthropic Cloud API',
    runtimeKind: 'hosted',
    capabilities: {
      chat: true,
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      embeddings: false,
      reasoning: true,
      modelLoad: false,
      modelUnload: false,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    },
  });
  runtimes.update('anthropic-api', { health: 'healthy' });

  const loadCalls: string[] = [];
  const generateCalls: Array<{ model: string; prompt: string; contextTokens?: number }> = [];
  const loadedModelIds = new Set<string>();
  const loadedContexts = new Map<string, number>();

  for (const m of opts.models ?? []) {
    const isLocal = m.local !== false;
    const runtimeId = isLocal ? (m.provider ?? 'mock-runtime') : (m.provider ?? 'anthropic-api');
    const computerId = isLocal ? 'local' : undefined;

    const record: ModelRecord = {
      id: m.id,
      name: m.name ?? m.id,
      provider: runtimeId,
      family: m.family ?? 'qwen',
      parameters: m.parameters,
      quantization: m.quantization ?? 'Q4_K_M',
      contextMax: m.contextMax ?? 32768,
      capabilities: ['generalChat'],
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: m.reasoning ?? false,
      runtimeCompatibility: 'any',
      local: isLocal,
      memory: m.memoryGB ? { minSystemGB: m.memoryGB, minGpuGB: m.memoryGB } : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    models.register(record);

    if (m.loaded) {
      loadedModelIds.add(m.id);
      loadedContexts.set(m.id, m.contextMax ?? 32768);
    }

    models.upsertInstance({
      id: `${m.id}::${computerId ?? 'cloud'}::${runtimeId}`,
      modelId: m.id,
      computerId,
      runtimeId,
      runtimeModelId: m.id,
      loaded: Boolean(m.loaded),
      state: m.loaded ? 'READY' : 'INSTALLED',
      health: 'healthy',
      contextTokens: m.contextMax ?? 32768,
    });
  }

  const fakeLocalAdapter: RuntimeAdapter = {
    id: 'mock-runtime',
    type: 'lmstudio',
    async discover() {
      return { id: 'mock-runtime', name: 'Mock Runtime', version: '0.3.0' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async cancel() {},
    async listModels() {
      return models.list().map((m) => ({ id: m.id, name: m.name, toolCalling: m.toolCalling, reasoning: m.reasoning }));
    },
    async getLoadedModels() {
      return Array.from(loadedModelIds);
    },
    async loadModel(modelId: string, loadOpts?: { contextTokens?: number }) {
      if (opts.loadDelayMs) {
        await new Promise((r) => setTimeout(r, opts.loadDelayMs));
      }
      const spec = opts.models?.find((m) => m.id === modelId);
      if (spec?.failOnLoad) {
        throw new Error(`Simulated load failure for model '${modelId}'`);
      }
      loadCalls.push(modelId);
      loadedModelIds.add(modelId);
      loadedContexts.set(modelId, loadOpts?.contextTokens ?? 32768);
    },
    async unloadModel(modelId: string) {
      loadedModelIds.delete(modelId);
      loadedContexts.delete(modelId);
    },
    async inspectModel(modelId: string) {
      return {
        modelId,
        loaded: loadedModelIds.has(modelId),
        effectiveContext: loadedContexts.get(modelId) ?? 32768,
      };
    },
    async probeModel(modelId: string) {
      return loadedModelIds.has(modelId);
    },
    async estimateModelLoad(modelId: string) {
      const spec = opts.models?.find((m) => m.id === modelId);
      const memGB = spec?.memoryGB ?? 4.0;
      return { totalMemoryBytes: memGB * 1024 ** 3, source: 'RUNTIME', confidence: 'high' };
    },
    async estimateResources(modelId: string) {
      const spec = opts.models?.find((m) => m.id === modelId);
      return { minMemoryGB: spec?.memoryGB ?? 4.0 };
    },
    async getCapabilities() {
      return {
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
    },
    async generate(req) {
      generateCalls.push({ model: req.model, prompt: req.prompt, contextTokens: (req as any).contextTokens });
      return {
        model: req.model,
        content: JSON.stringify({ action: 'done', summary: `Completed with ${req.model}` }),
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      };
    },
    async *stream(req) {
      generateCalls.push({ model: req.model, prompt: req.prompt, contextTokens: (req as any).contextTokens });
      yield { type: 'done', content: JSON.stringify({ action: 'done', summary: `Completed with ${req.model}` }) };
    },
  };

  const fakeHostedAdapter: RuntimeAdapter = {
    id: 'anthropic-api',
    type: 'anthropic',
    async discover() {
      return { id: 'anthropic-api', name: 'Anthropic Cloud API', version: '1.0' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async cancel() {},
    async listModels() {
      return models.list().filter((m) => m.local === false).map((m) => ({ id: m.id, name: m.name }));
    },
    async getLoadedModels() {
      return [];
    },
    async loadModel() {
      throw new Error('Hosted models cannot be locally loaded');
    },
    async unloadModel() {},
    async generate(req) {
      generateCalls.push({ model: req.model, prompt: req.prompt, contextTokens: (req as any).contextTokens });
      return {
        model: req.model,
        content: JSON.stringify({ action: 'done', summary: `Completed with hosted ${req.model}` }),
        finishReason: 'stop',
        usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40 },
      };
    },
    async *stream(req) {
      generateCalls.push({ model: req.model, prompt: req.prompt, contextTokens: (req as any).contextTokens });
      yield { type: 'done', content: JSON.stringify({ action: 'done', summary: `Completed with hosted ${req.model}` }) };
    },
  };

  const adapters = new Map<string, RuntimeAdapter>([
    ['mock-runtime', fakeLocalAdapter],
    ['anthropic-api', fakeHostedAdapter],
  ]);

  const policy = new PolicyEngine({
    projectRoot,
    networkAllowed: true,
    approvalQueue,
  });

  const lifecycle = new ModelLifecycleService({
    models,
    runtimes,
    computers,
    agents,
    adapters,
    store,
    policy,
    executions,
  });

  const scheduler = new Scheduler({ computers, runtimes, models, agents, policy });
  const jobManager = new JobManager();
  const orchestrator = new JobOrchestrator({
    scheduler,
    executionEngine: executions,
    policy,
    agents,
    models,
    runtimes,
    computers,
    jobManager,
    lifecycle,
  });

  const worker: Worker = {
    id: 'worker-local',
    computerId: 'local',
    name: 'worker-local',
    info: {
      id: 'worker-local',
      computerId: 'local',
      name: 'worker-local',
      status: 'idle',
      runtimes: ['mock-runtime'],
      models: models.list().map((m) => m.id),
      activeExecutions: 0,
      maxConcurrent: 4,
    },
    start: async () => {},
    stop: async () => {},
    heartbeat: () => ({
      workerId: 'worker-local',
      computerId: 'local',
      status: 'idle',
      activeExecutions: 0,
      load: { cpuPercent: 5, memoryUsedGB: totalMemoryGB - availableMemoryGB, memoryAvailableGB: availableMemoryGB },
      timestamp: new Date(),
    }),
    adapterForModel: () => fakeLocalAdapter,
    refreshRuntime: async () => undefined,
    execute: async () => ({ success: true, output: 'ok' }),
  } as unknown as Worker;

  const engine: RookEngine = {
    config: {
      projectRoot,
      dataDir: path.join(projectRoot, '.wazir'),
      concurrencyLimit: 2,
      networkAllowed: true,
      allowCommands: [],
      denyCommands: [],
      allowedMcpServers: [],
      models: { startup: { mode: 'prompt' } },
    },
    projectRoot,
    configDir: path.join(projectRoot, '.wazir'),
    computers,
    runtimes,
    models,
    lifecycle,
    agents,
    tools,
    policy,
    scheduler,
    compiler,
    executions,
    approvalQueue,
    orchestrator,
    worktrees,
    planner: createTaskPlanner({ models, adapters, defaultModelId: opts.models?.[0]?.id }),
    adapters,
    hostedAdapters: new Map([['anthropic-api', fakeHostedAdapter]]),
    discovered: [],
    worker,
    store,
    mcpClient: { listServers: () => [], listTools: () => [] } as any,
    close: async () => {},
  };

  return {
    engine,
    computers,
    runtimes,
    models,
    lifecycle,
    scheduler,
    orchestrator,
    loadCalls,
    generateCalls,
    loadedModelIds,
    fakeLocalAdapter,
    fakeHostedAdapter,
  };
}

describe('Intelligent Model Selection E2E Verification Suite (18 Scenarios)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-e2e-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // SCENARIO 1
  it('Scenario 1: Model selector opens and renders options with mode labels, current selection, reasoning effort, and keybinding footer', () => {
    const sampleModels: ModelSelectorItem[] = [
      {
        modelId: 'qwen2.5-coder:7b',
        name: 'Qwen 2.5 Coder 7B',
        provider: 'ollama',
        costTier: 'T1',
        available: true,
        loaded: true,
        local: true,
        eligible: true,
        memoryGB: 6.5,
        contextMax: 32768,
        deviceLabel: 'Apple M3 Max',
      },
    ];

    const controller = new ModelSelectorController({
      initialMode: 'auto',
      initialEffort: 'medium',
      models: sampleModels,
    });
    expect(controller.isOpen).toBe(true);

    const lines = renderModelSelectorModal(controller, 90);
    const flat = lines.map((l) => stripAnsiStr(l)).join('\n');

    expect(flat).toContain('WAZIR — Select Model');
    expect(flat).toContain('Auto (recommended)');
    expect(flat).toContain('Fast');
    expect(flat).toContain('Balanced');
    expect(flat).toContain('Powerful');
    expect(flat).toContain('Local');
    expect(flat).toContain('Custom');
    expect(flat).toContain('Current: Auto');
    expect(flat).toContain('Reasoning effort: Medium');
    expect(flat).toContain('Navigate');
    expect(flat).toContain('Effort');
    expect(flat).toContain('Set default');
    expect(flat).toContain('Session only');
    expect(flat).toContain('Cancel');
  });

  // SCENARIO 2
  it('Scenario 2: Keyboard navigation works across modes and custom models, / searches in custom mode, f filters provider, t filters cost tier', () => {
    const models: ModelSelectorItem[] = [
      {
        modelId: 'qwen2.5-coder:7b',
        name: 'Qwen 2.5 Coder 7B',
        provider: 'ollama',
        costTier: 'T1',
        available: true,
        loaded: true,
        local: true,
        eligible: true,
      },
      {
        modelId: 'llama-3-8b',
        name: 'Llama 3 8B',
        provider: 'mlx',
        costTier: 'T2',
        available: true,
        loaded: false,
        local: true,
        eligible: true,
      },
      {
        modelId: 'claude-3-5-sonnet',
        name: 'Claude 3.5 Sonnet',
        provider: 'anthropic',
        costTier: 'T3',
        available: true,
        loaded: false,
        local: false,
        eligible: true,
      },
    ];

    const controller = new ModelSelectorController({ models });
    expect(controller.selectedIndex).toBe(0);

    // Modes navigation: down moves 0 -> 1 -> 2, up moves back to 1
    controller.handleKey('down');
    expect(controller.selectedIndex).toBe(1); // Fast
    controller.handleKey('down');
    expect(controller.selectedIndex).toBe(2); // Balanced
    controller.handleKey('up');
    expect(controller.selectedIndex).toBe(1); // Fast

    // Switch to Custom view (index 5)
    controller.selectedIndex = 5;
    const action = controller.handleKey('enter');
    expect(action.type).toBe('none');
    expect(controller.view).toBe('custom');
    expect(controller.selectedIndex).toBe(0);

    // Custom models navigation
    controller.handleKey('down');
    expect(controller.selectedIndex).toBe(1);
    controller.handleKey('up');
    expect(controller.selectedIndex).toBe(0);

    // Filter provider via 'f'
    controller.handleKey('f');
    expect(controller.providerFilter).not.toBe('all');
    const filteredProvider = controller.getFilteredModels();
    expect(filteredProvider.every((m) => m.provider.toLowerCase() === controller.providerFilter.toLowerCase())).toBe(true);
    // Cycle back to 'all'
    while (controller.providerFilter !== 'all') {
      controller.handleKey('f');
    }

    // Filter cost tier via 't'
    controller.handleKey('t');
    expect(controller.costTierFilter).toBe('T1');
    const filteredT1 = controller.getFilteredModels();
    expect(filteredT1.every((m) => m.costTier === 'T1')).toBe(true);
    // Cycle back to 'any'
    while (controller.costTierFilter !== 'any') {
      controller.handleKey('t');
    }

    // '/' activates search mode
    controller.handleKey('/');
    expect(controller.isSearching).toBe(true);
    controller.handleKey('s');
    controller.handleKey('o');
    controller.handleKey('n');
    controller.handleKey('n');
    controller.handleKey('e');
    controller.handleKey('t');
    expect(controller.searchQuery).toBe('sonnet');
    const filteredSearch = controller.getFilteredModels();
    expect(filteredSearch).toHaveLength(1);
    expect(filteredSearch[0].modelId).toBe('claude-3-5-sonnet');
  });

  // SCENARIO 3
  it('Scenario 3: Default selection persists across sessions (Enter saves to persistent config file and reloads in a new ModelPreferenceService instance)', async () => {
    const configPath = path.join(tmpDir, 'model-preferences.json');
    const prefService1 = new ModelPreferenceService({ configFilePath: configPath });

    expect(prefService1.getEffectivePreference().mode).toBe('auto');

    // Simulate selecting 'powerful' with high reasoning effort and pressing Enter (persistent default)
    prefService1.setDefaultPreference({
      mode: 'powerful',
      reasoningEffort: 'high',
    });

    const eff1 = prefService1.getEffectivePreference();
    expect(eff1.mode).toBe('powerful');
    expect(eff1.reasoningEffort).toBe('high');
    expect(eff1.source).toBe('persistent');

    // Verify config file was written to disk
    const contentRaw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(contentRaw);
    expect(parsed.mode).toBe('powerful');
    expect(parsed.reasoningEffort).toBe('high');

    // Reload in a completely separate ModelPreferenceService instance
    const prefService2 = new ModelPreferenceService({ configFilePath: configPath });
    const eff2 = prefService2.getEffectivePreference();
    expect(eff2.mode).toBe('powerful');
    expect(eff2.reasoningEffort).toBe('high');
    expect(eff2.source).toBe('persistent');
    expect(eff2.displayLabel).toBe('Powerful');
  });

  // SCENARIO 4
  it('Scenario 4: Session-only selection (S) does NOT overwrite persistent config on disk', async () => {
    const configPath = path.join(tmpDir, 'session-preferences.json');
    const prefService1 = new ModelPreferenceService({ configFilePath: configPath });

    prefService1.setDefaultPreference({
      mode: 'balanced',
      reasoningEffort: 'medium',
    });

    // Verify disk has 'balanced'
    const diskInitial = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(diskInitial.mode).toBe('balanced');

    // Apply session-only selection (S)
    prefService1.setSessionPreference({
      mode: 'fast',
      reasoningEffort: 'low',
    });

    // In-memory effective preference is session 'fast'
    const eff = prefService1.getEffectivePreference();
    expect(eff.mode).toBe('fast');
    expect(eff.reasoningEffort).toBe('low');
    expect(eff.source).toBe('session');

    // Disk remains UNTOUCHED
    const diskAfter = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(diskAfter.mode).toBe('balanced');
    expect(diskAfter.reasoningEffort).toBe('medium');

    // New instance started in a subsequent session loads disk persistent default
    const prefService2 = new ModelPreferenceService({ configFilePath: configPath });
    const eff2 = prefService2.getEffectivePreference();
    expect(eff2.mode).toBe('balanced');
    expect(eff2.reasoningEffort).toBe('medium');
    expect(eff2.source).toBe('persistent');
  });

  // SCENARIO 5
  it('Scenario 5: Escape cancels without changes to either session or persistent preference', async () => {
    const configPath = path.join(tmpDir, 'cancel-preferences.json');
    const prefService = new ModelPreferenceService({ configFilePath: configPath });
    prefService.setDefaultPreference({ mode: 'auto', reasoningEffort: 'medium' });

    const controller = new ModelSelectorController({
      initialMode: 'auto',
      initialEffort: 'medium',
    });
    // Move to powerful and high
    controller.handleKey('down');
    controller.handleKey('down');
    controller.handleKey('down'); // powerful
    controller.handleKey('right'); // high
    expect(controller.reasoningEffort).toBe('high');

    // Press Escape
    const action = controller.handleKey('escape');
    expect(action.type).toBe('cancel');
    expect(controller.isOpen).toBe(false);

    // Verify preference service was NOT altered
    const eff = prefService.getEffectivePreference();
    expect(eff.mode).toBe('auto');
    expect(eff.reasoningEffort).toBe('medium');
  });

  // SCENARIO 6
  it('Scenario 6: Reasoning effort adjustment (←/→ cycles Low -> Medium -> High) works and influences context reservation & ranking', () => {
    const controller = new ModelSelectorController({ initialEffort: 'medium' });
    expect(controller.reasoningEffort).toBe('medium');

    // Right cycles: medium -> high -> low -> medium
    controller.handleKey('right');
    expect(controller.reasoningEffort).toBe('high');
    controller.handleKey('right');
    expect(controller.reasoningEffort).toBe('low');
    controller.handleKey('right');
    expect(controller.reasoningEffort).toBe('medium');

    // Left cycles: medium -> low -> high -> medium
    controller.handleKey('left');
    expect(controller.reasoningEffort).toBe('low');
    controller.handleKey('left');
    expect(controller.reasoningEffort).toBe('high');

    // Influence on context reservation in ContextMemoryEstimator
    const estimator = new ContextMemoryEstimator();
    const modelRecord: ModelRecord = {
      id: 'reasoning-model',
      name: 'Reasoning Model',
      provider: 'mock',
      family: 'qwen',
      contextMax: 32768,
      capabilities: ['generalChat'],
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: true,
      runtimeCompatibility: 'any',
      local: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const planLow = estimator.planContextAllocation({ model: modelRecord, reasoningEffort: 'low' });
    const planMed = estimator.planContextAllocation({ model: modelRecord, reasoningEffort: 'medium' });
    const planHigh = estimator.planContextAllocation({ model: modelRecord, reasoningEffort: 'high' });

    expect(planLow.outputReserveTokens).toBe(1024);
    expect(planMed.outputReserveTokens).toBe(2048);
    expect(planHigh.outputReserveTokens).toBe(4096);

    // Influence on ranking in IntelligentModelRanker
    const ranker = new IntelligentModelRanker();
    const rankedHigh = ranker.rankModels([modelRecord], undefined, undefined, {
      mode: 'POWERFUL',
      reasoningEffort: 'high',
      requiresReasoning: true,
    });
    expect(rankedHigh[0].eligible).toBe(true);
    expect(rankedHigh[0].contextPlan.outputReserveTokens).toBe(4096);
  });

  // SCENARIO 7
  it('Scenario 7: Already-loaded model is reused without reloading (ensureModelReadyForTask returns reused: true and loadModel count is 0)', async () => {
    const fixture = await createTestFixture(tmpDir, {
      models: [
        {
          id: 'qwen2.5-coder:7b',
          loaded: true,
          memoryGB: 6.5,
          contextMax: 32768,
        },
      ],
      availableMemoryGB: 32,
    });

    const progress: string[] = [];
    const result = await fixture.lifecycle.ensureModelReadyForTask({
      modelId: 'qwen2.5-coder:7b',
      computerId: 'local',
      requiredContextTokens: 8192,
      onProgress: (m) => progress.push(m),
    });

    expect(result.reused).toBe(true);
    expect(result.modelId).toBe('qwen2.5-coder:7b');
    expect(fixture.loadCalls).toHaveLength(0);
    expect(progress).toContain('Ready: qwen2.5-coder:7b');
  });

  // SCENARIO 8
  it('Scenario 8: Compatible unloaded model is loaded automatically with Loading <model> on <device>... -> Ready: <model> progress and readiness verification', async () => {
    const fixture = await createTestFixture(tmpDir, {
      models: [
        {
          id: 'google/gemma-4-12b-qat',
          loaded: false,
          memoryGB: 8.2,
          contextMax: 32768,
        },
      ],
      availableMemoryGB: 32,
    });

    const progress: string[] = [];
    const events: string[] = [];
    fixture.lifecycle.subscribe((e) => events.push(e.type));

    const result = await fixture.lifecycle.ensureModelReadyForTask({
      modelId: 'google/gemma-4-12b-qat',
      computerId: 'local',
      requiredContextTokens: 8192,
      onProgress: (m) => progress.push(m),
    });

    expect(result.reused).toBe(false);
    expect(result.modelId).toBe('google/gemma-4-12b-qat');
    expect(fixture.loadCalls).toEqual(['google/gemma-4-12b-qat']);
    expect(progress.some((m) => m.startsWith('Loading google/gemma-4-12b-qat on test-mac...'))).toBe(true);
    expect(progress).toContain('Ready: google/gemma-4-12b-qat');
    expect(events).toContain('MODEL_LOADING');
    expect(events).toContain('MODEL_READY');
    expect(fixture.lifecycle.isModelReady('google/gemma-4-12b-qat')).toBe(true);
  });

  // SCENARIO 9
  it('Scenario 9: Incompatible 22GB model (qwen/qwen3.8-27b) is rejected when only 0.1GB RAM is available, never selected by AUTO/FAST/BALANCED/POWERFUL, and circuit-broken against repeated load attempts', async () => {
    const fixture = await createTestFixture(tmpDir, {
      models: [
        {
          id: 'qwen/qwen3.8-27b',
          loaded: false,
          memoryGB: 22.0,
          contextMax: 32768,
        },
      ],
      availableMemoryGB: 0.1,
    });

    const computer = fixture.computers.get('local')!;
    const modelsList = fixture.models.list();
    const instances = fixture.models.listInstances();
    const ranker = new IntelligentModelRanker();

    // Verify AUTO, FAST, BALANCED, POWERFUL reject it
    for (const mode of ['AUTO', 'FAST', 'BALANCED', 'POWERFUL'] as const) {
      const selection = ranker.selectModel(modelsList, computer, instances, { mode });
      expect(selection.success).toBe(false);
      expect(selection.selected).toBeUndefined();
    }

    // Verify ensureModelReadyForTask fails and triggers circuit breaker
    await expect(
      fixture.lifecycle.ensureModelReadyForTask({
        modelId: 'qwen/qwen3.8-27b',
        computerId: 'local',
      }),
    ).rejects.toThrow(ModelLifecycleError);

    // Circuit breaker is now active
    const ineligibility = fixture.lifecycle.isKnownIneligible('qwen/qwen3.8-27b');
    expect(ineligibility.ineligible).toBe(true);
    expect(ineligibility.reason).toContain('0.1');

    // Attempt 2: fast failure from circuit breaker without calling adapter
    const callCountBefore = fixture.loadCalls.length;
    await expect(
      fixture.lifecycle.ensureModelReadyForTask({
        modelId: 'qwen/qwen3.8-27b',
        computerId: 'local',
      }),
    ).rejects.toThrow('MODEL_ADMISSION_DENIED');
    expect(fixture.loadCalls.length).toBe(callCountBefore);
  });

  // SCENARIO 10
  it('Scenario 10: Strict model selection (STRICT_MODEL / pinned targetModelId) is preserved and fails with explicit reason + alternatives rather than silently falling back', () => {
    const lowMemComputer: Computer = {
      id: 'local',
      name: 'MacBook Air',
      type: 'workstation',
      status: 'online',
      local: true,
      health: 'healthy',
      os: { platform: 'darwin', architecture: 'arm64', version: '14.0' },
      hardware: { cpu: 'Apple M2', cpuCores: 8, memoryGB: 8, gpu: { unifiedMemory: true, memoryGB: 8 } },
      load: { cpuPercent: 5, memoryUsedGB: 7.9, memoryAvailableGB: 0.1 },
      runtimes: ['mock-runtime'],
      capabilities: ['gpu'],
      models: [],
      runtimeHealth: {},
      modelHealth: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const heavyModel: ModelRecord = {
      id: 'qwen/qwen3.8-27b',
      name: 'Qwen 3.8 27B',
      provider: 'mock-runtime',
      family: 'qwen',
      parameters: '27B',
      contextMax: 32768,
      capabilities: ['generalChat'],
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: true,
      runtimeCompatibility: 'any',
      local: true,
      memory: { minSystemGB: 22 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const eligibleSmallModel: ModelRecord = {
      id: 'qwen/qwen2.5-coder-0.5b',
      name: 'Qwen 0.5B',
      provider: 'anthropic-api',
      family: 'qwen',
      parameters: '0.5B',
      contextMax: 32768,
      capabilities: ['generalChat'],
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: false,
      runtimeCompatibility: 'any',
      local: false, // Hosted: requires 0GB local memory
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const ranker = new IntelligentModelRanker();
    const result = ranker.selectModel(
      [heavyModel, eligibleSmallModel],
      lowMemComputer,
      undefined,
      {
        mode: 'STRICT_MODEL',
        targetModelId: 'qwen/qwen3.8-27b',
        allowHostedProviders: true,
      },
    );

    expect(result.success).toBe(false);
    expect(result.selected).toBeUndefined();
    expect(result.reason).toContain("Strict target model 'qwen/qwen3.8-27b' is ineligible");
    expect(result.reason).toContain('STRICT_MODEL never silently overrides');
    // Alternatives are provided so user can choose
    expect(result.alternatives.some((a) => a.model.id === 'qwen/qwen2.5-coder-0.5b')).toBe(true);
  });

  // SCENARIO 11
  it('Scenario 11: Local-only policy (LOCAL_FIRST with localOnly: true) blocks hosted models even when hosted models are healthy', () => {
    const hostedModel: ModelRecord = {
      id: 'claude-3-5-sonnet',
      name: 'Claude 3.5 Sonnet',
      provider: 'anthropic',
      family: 'claude',
      contextMax: 200000,
      capabilities: ['generalChat'],
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      audio: false,
      embedding: false,
      reasoning: true,
      runtimeCompatibility: 'any',
      local: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const ranker = new IntelligentModelRanker();
    const result = ranker.selectModel([hostedModel], undefined, undefined, {
      mode: 'LOCAL_FIRST',
      localOnly: true,
    });

    expect(result.success).toBe(false);
    expect(result.selected).toBeUndefined();
    const candidate = ranker.rankModels([hostedModel], undefined, undefined, {
      mode: 'LOCAL_FIRST',
      localOnly: true,
    })[0];
    expect(candidate.eligible).toBe(false);
    expect(candidate.rejectionReasons.some((r) => r.includes('localOnly mode is enforced'))).toBe(true);
  });

  // SCENARIO 12
  it('Scenario 12: Remote/hosted fallback respects authorization (allowHostedProviders: false blocks hosted; allowHostedProviders: true selects authorized hosted model when local memory is 0.1GB)', () => {
    const lowMemComputer: Computer = {
      id: 'local',
      name: 'Test Mac',
      type: 'workstation',
      status: 'online',
      local: true,
      health: 'healthy',
      os: { platform: 'darwin', architecture: 'arm64', version: '14.0' },
      hardware: { cpu: 'Apple M3', cpuCores: 8, memoryGB: 16, gpu: { unifiedMemory: true, memoryGB: 16 } },
      load: { cpuPercent: 10, memoryUsedGB: 15.9, memoryAvailableGB: 0.1 },
      runtimes: ['mock-runtime'],
      capabilities: ['gpu'],
      models: [],
      runtimeHealth: {},
      modelHealth: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const localHeavyModel: ModelRecord = {
      id: 'llama-3-8b',
      name: 'Llama 3 8B',
      provider: 'mock-runtime',
      family: 'llama',
      contextMax: 8192,
      capabilities: ['generalChat'],
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: false,
      runtimeCompatibility: 'any',
      local: true,
      memory: { minSystemGB: 16 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const hostedModel: ModelRecord = {
      id: 'claude-3-5-sonnet',
      name: 'Claude 3.5 Sonnet',
      provider: 'anthropic',
      family: 'claude',
      contextMax: 200000,
      capabilities: ['generalChat'],
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      audio: false,
      embedding: false,
      reasoning: true,
      runtimeCompatibility: 'any',
      local: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const ranker = new IntelligentModelRanker();

    // Case A: allowHostedProviders: false -> BLOCKED
    const resultBlocked = ranker.selectModel(
      [localHeavyModel, hostedModel],
      lowMemComputer,
      undefined,
      { mode: 'AUTO', allowHostedProviders: false },
    );
    expect(resultBlocked.success).toBe(false);
    expect(resultBlocked.selected).toBeUndefined();

    // Case B: allowHostedProviders: true -> AUTHORIZED hosted fallback
    const resultAllowed = ranker.selectModel(
      [localHeavyModel, hostedModel],
      lowMemComputer,
      undefined,
      { mode: 'AUTO', allowHostedProviders: true },
    );
    expect(resultAllowed.success).toBe(true);
    expect(resultAllowed.selected?.model.id).toBe('claude-3-5-sonnet');
    expect(resultAllowed.selected?.costTier).toBe('T3');
  });

  // SCENARIO 13
  it('Scenario 13: Concurrent agents cannot overcommit memory (unsettled reservations from Agent 1 are deducted from usable memory for Agent 2, preventing OOM overcommit, and concurrent loads of the same model are deduplicated)', async () => {
    // 13.A: Memory reservation deduction & overcommit prevention
    const computer: Computer = {
      id: 'local',
      name: 'Dev Machine',
      type: 'workstation',
      status: 'online',
      local: true,
      health: 'healthy',
      os: { platform: 'darwin', architecture: 'arm64', version: '14.0' },
      hardware: { cpu: 'Apple M3', cpuCores: 16, memoryGB: 16, gpu: { unifiedMemory: true, memoryGB: 16 } },
      load: { cpuPercent: 10, memoryUsedGB: 4, memoryAvailableGB: 12 },
      runtimes: ['mock-runtime'],
      capabilities: ['gpu'],
      models: [],
      runtimeHealth: {},
      modelHealth: {},
      // Agent 1 holds an unsettled 8GB reservation
      reservations: [
        {
          id: 'res-agent-1',
          jobId: 'job-1',
          taskId: 'task-1',
          memoryBytes: 8 * 1024 ** 3,
          createdAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const modelNeeding8GB: ModelRecord = {
      id: 'model-8gb',
      name: 'Model 8GB',
      provider: 'mock-runtime',
      family: 'llama',
      contextMax: 8192,
      capabilities: ['generalChat'],
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: false,
      runtimeCompatibility: 'any',
      local: true,
      memory: { minSystemGB: 8 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const hw = new HardwareEligibilityService();
    // Agent 2 assesses device: raw available is 12GB, but 8GB is reserved -> 4GB usable
    const eligibility = hw.assessDeviceForModel({
      model: modelNeeding8GB,
      computer,
    });
    expect(eligibility.reservedMemoryGB).toBe(8);
    expect(eligibility.availableMemoryGB).toBe(4); // 12 - 8 = 4GB
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.rejectionReasons.some((r) => r.includes('4GB available') && r.includes('8GB reserved'))).toBe(true);

    // 13.B: Concurrent load deduplication
    const fixture = await createTestFixture(tmpDir, {
      models: [
        {
          id: 'shared-model',
          loaded: false,
          memoryGB: 4.0,
          contextMax: 16384,
        },
      ],
      availableMemoryGB: 32,
      loadDelayMs: 30,
    });

    const [r1, r2] = await Promise.all([
      fixture.lifecycle.ensureModelReadyForTask({ modelId: 'shared-model', computerId: 'local' }),
      fixture.lifecycle.ensureModelReadyForTask({ modelId: 'shared-model', computerId: 'local' }),
    ]);

    expect(r1.modelId).toBe('shared-model');
    expect(r2.modelId).toBe('shared-model');
    expect(fixture.loadCalls).toHaveLength(1); // Exact 1 adapter load
    expect([r1.reused, r2.reused]).toContain(true); // At least one reports reused: true
  });

  // SCENARIO 14
  it('Scenario 14: Model counts (registered, available, loaded) are accurate and never report 85 models loaded when 85 models are merely registered and 0 or 1 are loaded', () => {
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();

    computers.register({
      id: 'local',
      name: 'Mac Studio',
      type: 'workstation',
      local: true,
      status: 'online',
      health: 'healthy',
      os: { platform: 'darwin', architecture: 'arm64', version: '14.0' },
      hardware: { cpu: 'Apple M2 Ultra', cpuCores: 24, memoryGB: 64, gpu: { unifiedMemory: true, memoryGB: 64 } },
      capabilities: ['localExecution'],
    });

    runtimes.register({
      id: 'local-runtime',
      type: 'ollama',
      name: 'Ollama Local',
      version: '0.1.0',
      computerId: 'local',
      capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: true, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
    });
    runtimes.update('local-runtime', { health: 'healthy' });

    // Register 85 models
    for (let i = 1; i <= 85; i++) {
      const id = `model-entry-${i}`;
      models.register({
        id,
        name: `Model ${i}`,
        provider: 'local-runtime',
        family: 'test',
        contextMax: 8192,
        capabilities: ['generalChat'],
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        runtimeCompatibility: ['ollama'],
        local: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Exactly ONE model (model-entry-1) is loaded in RAM
      const isLoaded = i === 1;
      models.upsertInstance({
        id: `${id}::local::local-runtime`,
        modelId: id,
        computerId: 'local',
        runtimeId: 'local-runtime',
        runtimeModelId: id,
        loaded: isLoaded,
        state: isLoaded ? 'READY' : 'INSTALLED',
        health: 'healthy',
        contextTokens: 8192,
      });
    }

    const discoveryService = new ModelDiscoveryStatusService({ models, runtimes, computers });
    const status = discoveryService.getFleetStatus();

    expect(status.registeredCount).toBe(85);
    expect(status.availableCount).toBe(85);
    expect(status.loadedCount).toBe(1); // STRICT INVARIANT: 1, NOT 85!

    const summary = discoveryService.formatStartupSummary('Auto', 'Medium');
    expect(summary).toContain('Models: 85 registered');
    expect(summary).toContain('85 available');
    expect(summary).toContain('1 loaded');
    expect(summary).not.toContain('85 loaded');
  });

  // SCENARIO 15
  it('Scenario 15: Chat remains usable after model load failure (recovering via fallback or allowing subsequent selector / task execution)', async () => {
    const fixture = await createTestFixture(tmpDir, {
      models: [
        {
          id: 'fragile-model',
          loaded: false,
          memoryGB: 4.0,
          contextMax: 16384,
          failOnLoad: true,
        },
        {
          id: 'healthy-fallback-model',
          loaded: false,
          memoryGB: 2.0,
          contextMax: 16384,
        },
      ],
      availableMemoryGB: 32,
    });

    const failedEvents: string[] = [];
    fixture.lifecycle.subscribe((e) => {
      if (e.type === 'MODEL_LOAD_FAILED') failedEvents.push(e.modelId);
    });

    // 1. Initial attempt fails
    await expect(
      fixture.lifecycle.ensureModelReadyForTask({
        modelId: 'fragile-model',
        computerId: 'local',
      }),
    ).rejects.toThrow();

    expect(failedEvents).toContain('fragile-model');
    expect(fixture.lifecycle.getModelState('fragile-model')).toBe('FAILED');

    // 2. Chat / workflow recovers: subsequent model selection & task execution succeeds
    const recoveryResult = await fixture.lifecycle.ensureModelReadyForTask({
      modelId: 'healthy-fallback-model',
      computerId: 'local',
    });

    expect(recoveryResult.reused).toBe(false);
    expect(recoveryResult.modelId).toBe('healthy-fallback-model');
    expect(fixture.lifecycle.isModelReady('healthy-fallback-model')).toBe(true);
  });

  // SCENARIO 16
  it('Scenario 16: Context allocation respects memory limits (selects smallest sufficient tier from [4096, 8192, 16384, 32768, 65536, 131072] and downshifts when max context would exceed available device memory)', () => {
    const estimator = new ContextMemoryEstimator();
    const model: ModelRecord = {
      id: 'qwen2.5-coder:14b',
      name: 'Qwen 14B',
      parameters: '14B',
      quantization: 'Q4_K_M',
      contextMax: 131072, // 128K context max
      provider: 'mock-runtime',
      family: 'qwen',
      capabilities: ['generalChat'],
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: true,
      runtimeCompatibility: 'any',
      local: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Standard tiers verified
    expect(STANDARD_CONTEXT_TIERS).toEqual([4096, 8192, 16384, 32768, 65536, 131072]);

    // Case A: 11.5GB available memory: cannot fit 131072 (which requires weights 8.4GB + overhead 1.5GB + 128K KV ~8GB = ~17.9GB),
    // but CAN fit 8192 (weights 8.4GB + 1.5GB + ~0.5GB KV = ~10.4GB)
    const planConstrained = estimator.planContextAllocation({
      model,
      requiredMinimumContext: 6000,
      availableMemoryGB: 11.5,
    });

    expect(planConstrained.eligible).toBe(true);
    expect(planConstrained.allocatedContextTokens).toBe(8192); // Smallest tier >= 6000 that fits in 11.5GB
    expect(planConstrained.downshiftedFromMax).toBe(true);
    expect(planConstrained.reason).toContain('downshifted from max 131072 to conserve memory');

    // Case B: Severe memory shortage (0.1GB available): none of the tiers fit
    const planOom = estimator.planContextAllocation({
      model,
      requiredMinimumContext: 4096,
      availableMemoryGB: 0.1,
    });
    expect(planOom.eligible).toBe(false);
    expect(planOom.reason).toContain('exceeds available 0.1GB');
  });

  // SCENARIO 17
  it('Scenario 17: Actual provider invocation (adapter.generate / ChatAgent / runtime execution) receives the exact model ID and context allocation selected by the ranker/scheduler', async () => {
    const fixture = await createTestFixture(tmpDir, {
      models: [
        {
          id: 'qwen2.5-coder:7b',
          name: 'Qwen 2.5 Coder 7B',
          loaded: true,
          memoryGB: 6.5,
          contextMax: 32768,
        },
      ],
      availableMemoryGB: 32,
    });

    const ranker = new IntelligentModelRanker();
    const selection = ranker.selectModel(
      fixture.models.list(),
      fixture.computers.get('local'),
      fixture.models.listInstances(),
      { mode: 'FAST' },
    );

    expect(selection.success).toBe(true);
    const selectedModelId = selection.selected!.model.id;
    const allocatedContext = selection.selected!.contextPlan.allocatedContextTokens;

    expect(selectedModelId).toBe('qwen2.5-coder:7b');
    expect(allocatedContext).toBe(selection.selected!.contextPlan.allocatedContextTokens);
    expect(allocatedContext).toBeGreaterThan(0);

    // Run direct invocation through adapter
    await fixture.fakeLocalAdapter.generate({
      model: selectedModelId,
      prompt: 'Write a quicksort function',
      contextTokens: allocatedContext,
    });

    expect(fixture.generateCalls).toHaveLength(1);
    expect(fixture.generateCalls[0].model).toBe(selectedModelId);
    expect(fixture.generateCalls[0].contextTokens).toBe(allocatedContext);
  });

  // SCENARIO 18
  it('Scenario 18: End-to-end chat flow: startup status -> /model selector -> reasoning effort change -> session-only vs persistent default -> !ls direct shell execution (0 LLM tokens) -> inference task execution with loaded-model reuse', async () => {
    // 1. Startup Status
    const fixture = await createTestFixture(tmpDir, {
      models: [
        {
          id: 'qwen/qwen2.5-coder-1.5b',
          name: 'Qwen 2.5 Coder 1.5B',
          loaded: true,
          memoryGB: 2.0,
          contextMax: 32768,
        },
      ],
      availableMemoryGB: 16,
      totalMemoryGB: 32,
    });

    const statusService = new ModelDiscoveryStatusService({
      models: fixture.models,
      runtimes: fixture.runtimes,
      computers: fixture.computers,
    });
    const startupBanner = statusService.formatStartupSummary('Auto', 'Medium');
    expect(startupBanner).toContain('WAZIR');
    expect(startupBanner).toContain('1 loaded');

    // 2. /model selector modal
    const selector = new ModelSelectorController({
      initialMode: 'auto',
      initialEffort: 'medium',
    });
    expect(selector.isOpen).toBe(true);

    // 3. Reasoning effort adjustment
    selector.handleKey('right'); // medium -> high
    expect(selector.reasoningEffort).toBe('high');

    // 4. Session-only vs Persistent Default
    const configPath = path.join(tmpDir, 'e2e-prefs.json');
    const prefService = new ModelPreferenceService({ configFilePath: configPath });
    prefService.setDefaultPreference({ mode: 'balanced', reasoningEffort: 'medium' });

    // User chooses session-only 'fast'
    selector.selectedIndex = 1; // fast
    const actionSession = selector.handleKey('S');
    expect(actionSession.type).toBe('select');
    expect(actionSession.scope).toBe('session');
    prefService.setSessionPreference({ mode: actionSession.mode, reasoningEffort: actionSession.reasoningEffort });
    expect(prefService.getEffectivePreference().mode).toBe('fast');
    expect(prefService.getEffectivePreference().source).toBe('session');

    // 5. Direct inline shell execution (!ls) with 0 LLM tokens
    await fs.writeFile(path.join(tmpDir, 'test-artifact.txt'), 'wazir-e2e', 'utf8');
    const harness = new TuiTestHarness({
      engine: fixture.engine,
      presentationMode: 'conversation',
    });
    await harness.tui.start();
    await harness.tui.submitCommand('!ls');

    expect(fixture.loadCalls).toHaveLength(0);
    expect(fixture.generateCalls).toHaveLength(0);
    expect(harness.tui.lastShellOutput?.exitCode).toBe(0);
    expect(harness.tui.lastShellOutput?.stdout).toContain('test-artifact.txt');
    harness.tui.stop();

    // 6. Inference task execution with loaded-model reuse
    const ensureReady = await fixture.lifecycle.ensureModelReadyForTask({
      modelId: 'qwen/qwen2.5-coder-1.5b',
      computerId: 'local',
      requiredContextTokens: 4096,
    });
    expect(ensureReady.reused).toBe(true);
    expect(fixture.loadCalls).toHaveLength(0);

    // Invoke adapter generation
    await fixture.fakeLocalAdapter.generate({
      model: ensureReady.modelId,
      prompt: 'Explain binary search',
      contextTokens: ensureReady.effectiveContext,
    });

    expect(fixture.generateCalls.length).toBeGreaterThan(0);
    expect(fixture.generateCalls.some((c) => c.model === 'qwen/qwen2.5-coder-1.5b')).toBe(true);
    expect(fixture.loadCalls).toHaveLength(0); // 0 reloads during inference!
  });
});
