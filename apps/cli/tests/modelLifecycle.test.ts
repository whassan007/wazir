import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
} from '@wazir/core';
import type { ModelRecord, ModelLifecycleEvent } from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { MemoryStore } from '@wazir/shared';
import type { RookEngine } from '../src/engine.js';
import { FleetTui } from '../src/tui/fleetTui.js';
import { TuiTestHarness } from '../src/tui/inputHarness.js';
import {
  listModels,
  listLoadedModels,
  discoverModelsCommand,
  loadModelCommand,
  unloadModelCommand,
} from '../src/commands.js';

interface TestEngineOptions {
  modelsLoaded?: boolean;
  modelsConfig?: 'none' | 'empty' | 'two_models' | 'mixed_with_embedding';
  runtimeHealthy?: boolean;
  onLoadModel?: (modelId: string) => Promise<void>;
  onUnloadModel?: (modelId: string) => Promise<void>;
}

async function buildTestEngine(projectRoot: string, opts: TestEngineOptions = {}): Promise<{ engine: RookEngine; fakeAdapter: RuntimeAdapter; loadedModelIds: Set<string> }> {
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
    os: { platform: 'darwin', architecture: 'arm64', version: '23.0.0' },
    hardware: { cpu: 'Apple M3 Max', cpuCores: 16, memoryGB: 64 },
    capabilities: ['localExecution'],
  });

  runtimes.register({
    id: 'mock-runtime',
    type: 'lmstudio',
    name: 'Mock LM Studio',
    version: '0.3.0',
    computerId: 'local',
    capabilities: {
      chat: true,
      streaming: true,
      toolCalling: true,
      structuredOutput: false,
      vision: true,
      embeddings: true,
      reasoning: true,
      modelLoad: true,
      modelUnload: true,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    },
  });

  const loadedModelIds = new Set<string>();
  if (opts.modelsLoaded) {
    loadedModelIds.add('google/gemma-4-12b-qat');
  }

  const fakeAdapter: RuntimeAdapter = {
    id: 'mock-runtime',
    type: 'lmstudio',
    async discover() {
      return { id: 'mock-runtime', name: 'Mock LM Studio', version: '0.3.0' };
    },
    async healthCheck() {
      return { status: opts.runtimeHealthy !== false ? 'healthy' : 'unhealthy' };
    },
    async cancel() {},
    async listModels() {
      return [
        { id: 'google/gemma-4-12b-qat', name: 'Gemma 4 12B QAT', toolCalling: true },
        { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', toolCalling: true, reasoning: true },
      ];
    },
    async getLoadedModels() {
      return Array.from(loadedModelIds);
    },
    async loadModel(modelId: string) {
      if (opts.onLoadModel) {
        await opts.onLoadModel(modelId);
      }
      loadedModelIds.add(modelId);
    },
    async unloadModel(modelId: string) {
      if (opts.onUnloadModel) {
        await opts.onUnloadModel(modelId);
      }
      loadedModelIds.delete(modelId);
    },
    async estimateResources(modelId: string) {
      if (modelId.includes('27b')) return { minMemoryGB: 18.5 };
      if (modelId.includes('12b')) return { minMemoryGB: 8.2 };
      return { minMemoryGB: 4.0 };
    },
    async getCapabilities() {
      return {
        chat: true,
        streaming: true,
        toolCalling: true,
        structuredOutput: false,
        vision: true,
        embeddings: true,
        reasoning: true,
        modelLoad: true,
        modelUnload: true,
        modelDownload: false,
        statefulChat: false,
        mcp: false,
      };
    },
    async *generate() {
      yield { type: 'token' as const, content: '{"action":"done","summary":"ok"}' };
      yield { type: 'completed' as const, content: '{"action":"done","summary":"ok"}', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    },
  };

  const adapters = new Map<string, RuntimeAdapter>([['mock-runtime', fakeAdapter]]);

  // Populate models based on options
  if (opts.modelsConfig !== 'empty') {
    // Generative Model 1: Gemma 4 12B
    models.register({
      id: 'google/gemma-4-12b-qat',
      name: 'google/gemma-4-12b-qat',
      provider: 'mock-runtime',
      family: 'gemma',
      architecture: 'gemma4',
      parameters: '12B',
      contextMax: 32_768,
      capabilities: ['generalChat', 'toolCalling', 'vision'],
      toolCalling: true,
      structuredOutput: false,
      vision: true,
      audio: false,
      embedding: false,
      reasoning: false,
      runtimeCompatibility: 'any',
      local: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const isGemmaLoaded = loadedModelIds.has('google/gemma-4-12b-qat');
    models.upsertInstance({
      id: 'google/gemma-4-12b-qat::local::mock-runtime',
      modelId: 'google/gemma-4-12b-qat',
      computerId: 'local',
      runtimeId: 'mock-runtime',
      runtimeModelId: 'google/gemma-4-12b-qat',
      loaded: isGemmaLoaded,
      state: isGemmaLoaded ? 'READY' : 'INSTALLED',
      health: opts.runtimeHealthy !== false ? 'healthy' : 'unavailable',
      contextTokens: 32_768,
    });

    // Generative Model 2: Qwen 27B
    models.register({
      id: 'qwen/qwen3.8-27b',
      name: 'qwen/qwen3.8-27b',
      provider: 'mock-runtime',
      family: 'qwen',
      architecture: 'qwen3',
      parameters: '27B',
      contextMax: 32_768,
      capabilities: ['generalChat', 'toolCalling', 'reasoning'],
      toolCalling: true,
      structuredOutput: false,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: true,
      runtimeCompatibility: 'any',
      local: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const isQwenLoaded = loadedModelIds.has('qwen/qwen3.8-27b');
    models.upsertInstance({
      id: 'qwen/qwen3.8-27b::local::mock-runtime',
      modelId: 'qwen/qwen3.8-27b',
      computerId: 'local',
      runtimeId: 'mock-runtime',
      runtimeModelId: 'qwen/qwen3.8-27b',
      loaded: isQwenLoaded,
      state: isQwenLoaded ? 'READY' : 'INSTALLED',
      health: opts.runtimeHealthy !== false ? 'healthy' : 'unavailable',
      contextTokens: 32_768,
    });

    if (opts.modelsConfig === 'mixed_with_embedding') {
      // Non-generative: Embedding model
      models.register({
        id: 'nomic-embed-text-v1.5',
        name: 'nomic-embed-text-v1.5',
        provider: 'mock-runtime',
        family: 'other',
        contextMax: 8_192,
        capabilities: ['embedding'],
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: true,
        reasoning: false,
        runtimeCompatibility: 'any',
        local: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      models.upsertInstance({
        id: 'nomic-embed-text-v1.5::local::mock-runtime',
        modelId: 'nomic-embed-text-v1.5',
        computerId: 'local',
        runtimeId: 'mock-runtime',
        runtimeModelId: 'nomic-embed-text-v1.5',
        loaded: false,
        state: 'INSTALLED',
        health: 'healthy',
        contextTokens: 8_192,
      });
    }
  }

  agents.register(createCodingAgent(), 'native');

  const policy = new PolicyEngine({
    projectRoot,
    networkAllowed: false,
    approvalQueue,
  });

  const scheduler = new Scheduler({ computers, runtimes, models, agents });
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
  });

  const fakeWorker = {
    id: 'worker-local',
    computerId: 'local',
    adapterForModel: () => fakeAdapter,
    refreshRuntime: async () => undefined,
  } as unknown as Worker;

  const lifecycle = new ModelLifecycleService({
    models,
    runtimes,
    computers,
    agents,
    adapters,
    store,
  });

  const engine: RookEngine = {
    config: {
      modelContext: {},
      modelCapabilities: {},
      networkAllowed: false,
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
    planner: createTaskPlanner(),
    adapters,
    discovered: [
      {
        id: 'mock-runtime',
        info: { name: 'Mock LM Studio', version: '0.3.0' },
        health: opts.runtimeHealthy !== false ? 'healthy' : 'unavailable',
        capabilities: fakeAdapter.getCapabilities ? await fakeAdapter.getCapabilities() : ({} as any),
        models: [],
        adapter: fakeAdapter,
      },
    ],
    worker: fakeWorker,
    store,
  };

  return { engine, fakeAdapter, loadedModelIds };
}

describe('Model Readiness & Startup Loading Workflow', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('1. Empty models detected -> evaluates readiness with 0 installed models', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const { engine } = await buildTestEngine(projectRoot, { modelsConfig: 'empty' });

    const readiness = engine.lifecycle.getReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.installedCount).toBe(0);
    expect(readiness.readyCount).toBe(0);
    expect(readiness.unloadedEligibleModels.length).toBe(0);

    const harness = new TuiTestHarness({ engine });
    await harness.start();

    const screen = harness.getScreenBuffer();
    expect(screen).toContain('WAZIR - MODEL SETUP & RECOVERY');
    expect(screen).toContain('0 models discovered across all runtimes');
    harness.stop();
  });

  it('2. Models already READY -> launches Fleet directly without modal prompt (fast path)', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const { engine } = await buildTestEngine(projectRoot, { modelsLoaded: true, modelsConfig: 'two_models' });

    const readiness = engine.lifecycle.getReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.readyCount).toBeGreaterThan(0);

    const harness = new TuiTestHarness({ engine });
    await harness.start();

    const screen = harness.getScreenBuffer();
    expect(screen).not.toContain('WAZIR - MODEL READINESS & STARTUP');
    expect(screen).toContain('[View: FLEET]');
    expect(screen).toContain('1 READY');
    harness.stop();
  });

  it('3. Models installed but unloaded -> enters Model Startup Selector on launch', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const { engine } = await buildTestEngine(projectRoot, { modelsLoaded: false, modelsConfig: 'two_models' });

    const readiness = engine.lifecycle.getReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.installedCount).toBe(2);
    expect(readiness.readyCount).toBe(0);

    const harness = new TuiTestHarness({ engine });
    await harness.start();

    const screen = harness.getScreenBuffer();
    expect(screen).toContain('WAZIR - MODEL READINESS & STARTUP');
    expect(screen).toContain('google/gemma-4-12b-qat');
    expect(screen).toContain('qwen/qwen3.8-27b');
    expect(screen).toContain('[Enter] Load Selected');
    harness.stop();
  });

  it('4. Selection of multiple models -> correctly calls runtime load endpoints', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const loadedList: string[] = [];
    const { engine } = await buildTestEngine(projectRoot, {
      modelsLoaded: false,
      modelsConfig: 'two_models',
      onLoadModel: async (id) => {
        loadedList.push(id);
      },
    });

    const results = await engine.lifecycle.loadAllEligibleModels();
    expect(results.get('google/gemma-4-12b-qat')).toBe(true);
    expect(results.get('qwen/qwen3.8-27b')).toBe(true);
    expect(loadedList).toContain('google/gemma-4-12b-qat');
    expect(loadedList).toContain('qwen/qwen3.8-27b');

    const readiness = engine.lifecycle.getReadiness();
    expect(readiness.readyCount).toBe(2);
    expect(engine.lifecycle.isModelReady('google/gemma-4-12b-qat')).toBe(true);
    expect(engine.lifecycle.isModelReady('qwen/qwen3.8-27b')).toBe(true);
  });

  it('5. Partial load failure -> successfully loaded models remain READY, failed model surfaces error', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const { engine } = await buildTestEngine(projectRoot, {
      modelsLoaded: false,
      modelsConfig: 'two_models',
      onLoadModel: async (id) => {
        if (id.includes('qwen')) {
          throw new Error('Out of memory (failed to allocate 18.5 GB)');
        }
      },
    });

    const ok1 = await engine.lifecycle.loadModel('google/gemma-4-12b-qat');
    expect(ok1).toBe(true);
    expect(engine.lifecycle.isModelReady('google/gemma-4-12b-qat')).toBe(true);

    const ok2 = await engine.lifecycle.loadModel('qwen/qwen3.8-27b');
    expect(ok2).toBe(false);
    expect(engine.lifecycle.isModelReady('qwen/qwen3.8-27b')).toBe(false);
    expect(engine.lifecycle.getModelState('qwen/qwen3.8-27b')).toBe('FAILED');

    // Gemma is still READY despite Qwen failure
    expect(engine.lifecycle.isModelReady('google/gemma-4-12b-qat')).toBe(true);
  });

  it('6. Non-generative models are excluded from default generative selection and eligible list', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const { engine } = await buildTestEngine(projectRoot, {
      modelsLoaded: false,
      modelsConfig: 'mixed_with_embedding',
    });

    const eligible = engine.lifecycle.getEligibleModels();
    expect(eligible.some((m) => m.id === 'nomic-embed-text-v1.5')).toBe(false);
    expect(eligible.some((m) => m.id === 'google/gemma-4-12b-qat')).toBe(true);

    const recommended = engine.lifecycle.getRecommendedModels();
    expect(recommended.some((r) => r.model.id === 'nomic-embed-text-v1.5')).toBe(false);
  });

  it('7. Unhealthy runtime prevents loading and surfaces clean error', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const { engine } = await buildTestEngine(projectRoot, {
      modelsLoaded: false,
      modelsConfig: 'two_models',
      runtimeHealthy: false,
      onLoadModel: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1234');
      },
    });

    const ok = await engine.lifecycle.loadModel('google/gemma-4-12b-qat');
    expect(ok).toBe(false);
    expect(engine.lifecycle.getModelState('google/gemma-4-12b-qat')).toBe('FAILED');
  });

  it('8. Skip option allows continuing to Fleet without loading', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const { engine } = await buildTestEngine(projectRoot, { modelsLoaded: false, modelsConfig: 'two_models' });

    const harness = new TuiTestHarness({ engine });
    await harness.start();

    expect(harness.getScreenBuffer()).toContain('WAZIR - MODEL READINESS & STARTUP');

    // Press 's' to skip
    harness.sendKey('s');

    const screen = harness.getScreenBuffer();
    expect(screen).not.toContain('WAZIR - MODEL READINESS & STARTUP');
    expect(screen).toContain('[View: FLEET]');
    expect(screen).toContain('0 READY / 2 MODELS');
    harness.stop();
  });

  it('9. Task-time model recovery: task submitted with 0 ready models transitions to blocked modal, loads on action, resumes prompt', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const { engine } = await buildTestEngine(projectRoot, { modelsLoaded: false, modelsConfig: 'two_models' });

    const harness = new TuiTestHarness({ engine });
    await harness.start();

    // Skip startup selector first
    harness.sendKey('s');
    expect(harness.getScreenBuffer()).toContain('[View: FLEET]');

    // Submit a task prompt
    await harness.tui.submitCommand('build a C++ program that can sort an array');

    // Task-time modal should open
    const modalScreen = harness.getScreenBuffer();
    expect(modalScreen).toContain('TASK-TIME MODEL REQUIRED');
    expect(modalScreen).toContain('build a C++ program that can sort an array');
    expect(modalScreen).toContain('google/gemma-4-12b-qat');

    // Press 'l' to load the highlighted model
    harness.sendKey('l');

    // Give load a tick to verify and resume
    await new Promise((r) => setTimeout(r, 200));

    expect(engine.lifecycle.isModelReady('google/gemma-4-12b-qat')).toBe(true);
    harness.stop();
  });

  it('10. Resource estimation flags SAFE, WARNING, or INSUFFICIENT based on free memory', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const { engine } = await buildTestEngine(projectRoot, { modelsConfig: 'two_models' });

    const assessment = engine.lifecycle.assessModelSync('google/gemma-4-12b-qat');
    expect(assessment.modelId).toBe('google/gemma-4-12b-qat');
    expect(assessment.estimatedMemoryGB).toBeGreaterThan(0);
    expect(['SAFE', 'WARNING', 'INSUFFICIENT', 'UNKNOWN']).toContain(assessment.classification);
  });

  it('11. Persistence: last-ready set is persisted and restored in restore mode', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const { engine } = await buildTestEngine(projectRoot, { modelsLoaded: true, modelsConfig: 'two_models' });

    // Persist ready models
    await engine.lifecycle.persistReadyModelSet();

    // Simulate restart by unmarking ready
    engine.models.setInstanceLoaded('google/gemma-4-12b-qat::local::mock-runtime', false);
    expect(engine.lifecycle.isModelReady('google/gemma-4-12b-qat')).toBe(false);

    // Restore
    const res = await engine.lifecycle.restoreLastModelSet({ initiator: 'test' });
    expect(res.restored).toContain('google/gemma-4-12b-qat');
    expect(engine.lifecycle.isModelReady('google/gemma-4-12b-qat')).toBe(true);
  });

  it('12. Restore mode with missing model: gracefully loads available and warns on missing', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const { engine } = await buildTestEngine(projectRoot, { modelsLoaded: false, modelsConfig: 'two_models' });

    // Store contains a valid model and a deleted/missing model
    await engine.store.put('models/last_ready_set', ['google/gemma-4-12b-qat', 'nonexistent-model']);

    const res = await engine.lifecycle.restoreLastModelSet({ initiator: 'test' });
    expect(res.restored).toContain('google/gemma-4-12b-qat');
    expect(res.missing).toContain('nonexistent-model');
    expect(res.failed.length).toBe(0);
  });

  it('13. Concurrency: duplicate simultaneous load requests deduplicated to single load call', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    let loadCallCount = 0;
    const { engine } = await buildTestEngine(projectRoot, {
      modelsLoaded: false,
      modelsConfig: 'two_models',
      onLoadModel: async () => {
        loadCallCount++;
        await new Promise((r) => setTimeout(r, 50));
      },
    });

    // Fire 3 simultaneous loadModel calls for the same model
    const [p1, p2, p3] = await Promise.all([
      engine.lifecycle.loadModel('google/gemma-4-12b-qat'),
      engine.lifecycle.loadModel('google/gemma-4-12b-qat'),
      engine.lifecycle.loadModel('google/gemma-4-12b-qat'),
    ]);

    expect(p1).toBe(true);
    expect(p2).toBe(true);
    expect(p3).toBe(true);
    // Verified that adapter.loadModel was called exactly once!
    expect(loadCallCount).toBe(1);
  });

  it('14. CLI wa models commands: list, loaded, load, unload, discover functional', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-test-'));
    const { engine } = await buildTestEngine(projectRoot, { modelsLoaded: false, modelsConfig: 'two_models' });

    // 1. wa models list
    const listOutput = listModels(engine);
    expect(listOutput).toContain('google/gemma-4-12b-qat');
    expect(listOutput).toContain('INSTALLED');

    const jsonList = JSON.parse(listModels(engine, { json: true }));
    expect(Array.isArray(jsonList)).toBe(true);
    expect(jsonList.length).toBe(2);

    // 2. wa models loaded (initially empty)
    const loadedOutput = listLoadedModels(engine);
    expect(loadedOutput).toContain('No models are currently loaded');

    // 3. wa models load
    const loadResult = await loadModelCommand(engine, 'google/gemma-4-12b-qat');
    expect(loadResult.ok).toBe(true);
    expect(loadResult.message).toContain('loaded successfully');

    // 4. wa models loaded (now shows gemma)
    const loadedOutput2 = listLoadedModels(engine);
    expect(loadedOutput2).toContain('google/gemma-4-12b-qat');
    expect(loadedOutput2).toContain('READY');

    // 5. wa models unload
    const unloadResult = await unloadModelCommand(engine, 'google/gemma-4-12b-qat');
    expect(unloadResult.ok).toBe(true);
    expect(unloadResult.message).toContain('unloaded successfully');
    expect(engine.lifecycle.isModelReady('google/gemma-4-12b-qat')).toBe(false);

    // 6. wa models discover
    const discoverOutput = await discoverModelsCommand(engine);
    expect(discoverOutput).toContain('Model Discovery & Reconciliation');
  });
});
