import { describe, it, expect, afterEach } from 'vitest';
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
  SchedulingError,
  WorktreeManager,
  createTaskPlanner,
} from '@wazir/core';
import type { ModelRecord } from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { MemoryStore } from '@wazir/shared';
import type { RookEngine } from '../src/engine.js';
import { FleetTui } from '../src/tui/fleetTui.js';
import { TuiTestHarness } from '../src/tui/inputHarness.js';
import { listModels, listLoadedModels } from '../src/commands.js';

interface TestFleetOptions {
  availableMemoryGB?: number;
  totalMemoryGB?: number;
  registerSmallModel?: boolean;
  smallModelLoaded?: boolean;
  registerHostedModel?: boolean;
  allowHostedProviders?: boolean;
  routingMode?: 'auto' | 'local_only' | 'provider_only' | 'hybrid';
  routingProvider?: string;
}

async function createTestFleet(projectRoot: string, opts: TestFleetOptions = {}) {
  const availableMemoryGB = opts.availableMemoryGB ?? 0.1;
  const totalMemoryGB = opts.totalMemoryGB ?? 16;

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
    os: { platform: 'darwin', architecture: 'arm64', version: '24.0.0' },
    hardware: {
      cpu: 'Apple M3',
      cpuCores: 8,
      memoryGB: totalMemoryGB,
      gpu: {
        vendor: 'apple',
        model: 'Apple M3',
        memoryGB: totalMemoryGB,
        unifiedMemory: true,
      },
    },
    capabilities: ['localExecution', 'gpuAcceleration'],
  });
  computers.heartbeat('local', {
    load: {
      cpuPercent: 5,
      memoryUsedGB: Math.max(0, totalMemoryGB - availableMemoryGB),
      memoryAvailableGB: availableMemoryGB,
    },
  });

  runtimes.register({
    id: 'lmstudio',
    type: 'lmstudio',
    name: 'LM Studio',
    version: '0.3.0',
    computerId: 'local',
    capabilities: {
      chat: true,
      streaming: true,
      toolCalling: true,
      structuredOutput: false,
      vision: false,
      embeddings: false,
      reasoning: true,
      modelLoad: true,
      modelUnload: true,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    },
  });
  runtimes.update('lmstudio', { health: 'healthy' });

  const loadedSet = new Set<string>();
  const loadCalls: string[] = [];
  const generateCalls: Array<{ model: string; prompt: string }> = [];

  if (opts.smallModelLoaded) {
    loadedSet.add('qwen/qwen2.5-coder-1.5b');
  }

  // Register large 27B model requiring 22GB
  const largeModel: ModelRecord = {
    id: 'qwen/qwen3.8-27b',
    name: 'Qwen 3.8 27B',
    provider: 'lmstudio',
    family: 'qwen',
    parameters: '27B',
    quantization: 'Q4_K_M',
    contextMax: 32768,
    capabilities: ['code_generation', 'planning_decomposition', 'debugging_repair', 'verification_review'],
    toolCalling: true,
    vision: false,
    reasoning: true,
    embedding: false,
    local: true,
    memory: { minSystemGB: 22, minGpuGB: 18 },
  };
  models.register(largeModel);
  models.upsertInstance({
    id: 'local:lmstudio:qwen/qwen3.8-27b',
    modelId: 'qwen/qwen3.8-27b',
    runtimeId: 'lmstudio',
    computerId: 'local',
    runtimeModelId: 'qwen/qwen3.8-27b',
    loaded: false,
    state: 'INSTALLED',
    health: 'healthy',
  });

  if (opts.registerSmallModel) {
    const smallModel: ModelRecord = {
      id: 'qwen/qwen2.5-coder-1.5b',
      name: 'Qwen 2.5 Coder 1.5B',
      provider: 'lmstudio',
      family: 'qwen',
      parameters: '1.5B',
      quantization: 'Q4_K_M',
      contextMax: 32768,
      capabilities: ['code_generation', 'planning_decomposition', 'debugging_repair', 'verification_review'],
      toolCalling: true,
      structuredOutput: false,
      vision: false,
      audio: false,
      reasoning: false,
      embedding: false,
      local: true,
      runtimeCompatibility: 'any',
      memory: { minSystemGB: 2, minGpuGB: 2 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    models.register(smallModel);
    models.upsertInstance({
      id: 'local:lmstudio:qwen/qwen2.5-coder-1.5b',
      modelId: 'qwen/qwen2.5-coder-1.5b',
      runtimeId: 'lmstudio',
      computerId: 'local',
      runtimeModelId: 'qwen/qwen2.5-coder-1.5b',
      loaded: Boolean(opts.smallModelLoaded),
      state: opts.smallModelLoaded ? 'READY' : 'INSTALLED',
      health: 'healthy',
    });
  }

  if (opts.registerHostedModel) {
    runtimes.register({
      id: 'nvidia',
      type: 'nvidia',
      name: 'NVIDIA API Catalog',
      version: 'v1',
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
    runtimes.update('nvidia', { health: 'healthy' });

    const hostedModel: ModelRecord = {
      id: 'nvidia/nemotron-mini-4b-instruct',
      name: 'NVIDIA Nemotron Mini 4B',
      provider: 'nvidia',
      family: 'nemotron',
      parameters: '4B',
      contextMax: 32768,
      capabilities: ['code_generation', 'planning_decomposition', 'debugging_repair', 'verification_review'],
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      audio: false,
      reasoning: true,
      embedding: false,
      local: false,
      runtimeCompatibility: ['nvidia'],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    models.register(hostedModel);
    models.upsertInstance({
      id: 'hosted:nvidia:nvidia/nemotron-mini-4b-instruct',
      modelId: 'nvidia/nemotron-mini-4b-instruct',
      runtimeId: 'nvidia',
      runtimeModelId: 'nvidia/nemotron-mini-4b-instruct',
      loaded: true,
      state: 'READY',
      health: 'healthy',
    });
  }

  const fakeAdapter: RuntimeAdapter = {
    id: 'lmstudio',
    type: 'lmstudio',
    async discover() {
      return { id: 'lmstudio', name: 'LM Studio', version: '0.3.0' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async cancel() {},
    async listModels() {
      return models
        .list()
        .filter((m) => m.provider === 'lmstudio')
        .map((m) => ({ id: m.id, name: m.name, toolCalling: m.toolCalling, reasoning: m.reasoning }));
    },
    async getLoadedModels() {
      return Array.from(loadedSet);
    },
    async loadModel(modelId: string) {
      loadCalls.push(modelId);
      loadedSet.add(modelId);
    },
    async unloadModel(modelId: string) {
      loadedSet.delete(modelId);
    },
    async generate(req) {
      generateCalls.push({ model: req.model, prompt: req.prompt });
      return {
        model: req.model,
        content: JSON.stringify({ action: 'done', summary: `Completed with ${req.model}` }),
        finishReason: 'stop',
        usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 },
      };
    },
    async *stream(req) {
      generateCalls.push({ model: req.model, prompt: req.prompt });
      yield { type: 'done', content: JSON.stringify({ action: 'done', summary: `Completed with ${req.model}` }) };
    },
  };

  const adapters = new Map<string, RuntimeAdapter>([
    ['lmstudio', fakeAdapter],
    [' nvidia'.trim(), fakeAdapter],
  ]);

  const policy = new PolicyEngine({
    projectRoot,
    networkAllowed: true,
    allowHostedProviders: opts.allowHostedProviders ?? true,
    approvalHandler: (req) => approvalQueue.request(req),
  });

  const lifecycle = new ModelLifecycleService({
    models,
    runtimes,
    computers,
    agents,
    adapters,
    store,
    policy,
  });

  const scheduler = new Scheduler({
    models,
    runtimes,
    computers,
    agents,
    policy,
    routing: opts.routingMode
      ? {
          mode: opts.routingMode,
          provider: opts.routingProvider,
        }
      : undefined,
  });

  agents.register(
    createCodingAgent({
      tools,
      policy,
      compiler,
      models,
      adapterFor: () => fakeAdapter,
      projectRoot,
      maxSteps: 2,
    }),
    'built-in',
  );

  const jobManager = new JobManager(store);
  const planner = createTaskPlanner({ models, adapters, defaultModelId: 'qwen/qwen2.5-coder-1.5b' });
  const orchestrator = new JobOrchestrator({
    jobManager,
    scheduler,
    models,
    computers,
    agents,
    executions,
    planner,
    lifecycle,
    store,
  });

  const worker: Worker = {
    id: 'worker:local',
    computerId: 'local',
    name: 'worker-local',
    info: {
      id: 'worker:local',
      computerId: 'local',
      name: 'worker-local',
      status: 'idle',
      runtimes: ['lmstudio'],
      models: models.list().map((m) => m.id),
      activeExecutions: 0,
      maxConcurrent: 4,
    },
    start: async () => {},
    stop: async () => {},
    heartbeat: () => ({
      workerId: 'worker:local',
      computerId: 'local',
      status: 'idle',
      activeExecutions: 0,
      load: { cpuPercent: 5, memoryUsedGB: totalMemoryGB - availableMemoryGB, memoryAvailableGB: availableMemoryGB },
      timestamp: new Date(),
    }),
    execute: async () => {
      throw new Error('not used');
    },
  };

  const engine: RookEngine = {
    projectRoot,
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
    store,
    computers,
    runtimes,
    models,
    agents,
    tools,
    policy,
    approvalQueue,
    compiler,
    scheduler,
    executions,
    worker,
    adapters,
    hostedAdapters: new Map(),
    discovered: [],
    worktrees,
    jobManager,
    planner,
    orchestrator,
    lifecycle,
    mcpClient: { listServers: () => [], listTools: () => [] } as any,
    close: async () => {},
  };

  return { engine, loadCalls, generateCalls, loadedSet };
}

describe('WAZIR — Model Routing, Resource Eligibility, and Chat Execution Regression Suite', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('1 & 2 & 9: Launches wa chat (conversation mode) and executes !ls through direct shell path without LLM inference or model loading', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-chat-shell-'));
    await fs.writeFile(path.join(tmpDir, 'hello-wazir.txt'), 'hello\n', 'utf8');

    // Only the 22GB model is registered and available memory is 0.1GB (insufficient for any LLM)
    const { engine, loadCalls, generateCalls } = await createTestFleet(tmpDir, {
      availableMemoryGB: 0.1,
      totalMemoryGB: 32,
      registerSmallModel: false,
    });

    const harness = new TuiTestHarness({
      engine,
      presentationMode: 'conversation',
    });
    const tui = harness.tui;

    await tui.start();
    await tui.submitCommand('!ls');

    expect(loadCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(tui.lastShellOutput).toBeDefined();
    expect(tui.lastShellOutput?.exitCode).toBe(0);
    expect(tui.lastShellOutput?.stdout).toContain('hello-wazir.txt');

    tui.stop();
  });

  it('4 & 5: Rejects 22GB model (qwen/qwen3.8-27b) in preflight when available memory is insufficient, and selects eligible alternative when policy permits', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-chat-preflight-'));
    // Available memory is 4GB on a 32GB machine: insufficient for qwen/qwen3.8-27b (22GB), sufficient for qwen2.5-coder-1.5b (2GB)
    const { engine } = await createTestFleet(tmpDir, {
      availableMemoryGB: 4.0,
      totalMemoryGB: 32,
      registerSmallModel: true,
      smallModelLoaded: false,
    });

    const decision = engine.scheduler.plan({
      task: {
        id: 'task-ls',
        type: 'coding',
        title: 'ls',
        input: 'ls',
        requirements: { capabilities: ['code_generation'], toolCalling: true },
      },
    });

    expect(decision.modelId).toBe('qwen/qwen2.5-coder-1.5b');
    expect(decision.modelId).not.toBe('qwen/qwen3.8-27b');

    // Verify qwen/qwen3.8-27b was rejected in Phase 1 with placement memory reason
    const largeEval = decision.modelDecision.empiricalExplanation?.evaluatedCandidates.find(
      (c) => c.modelId === 'qwen/qwen3.8-27b',
    );
    expect(largeEval?.eligible).toBe(false);
    expect(largeEval?.reasons.join(' ')).toContain('available memory 4GB < required 22GB');
  });

  it('3 & 4 & 8: Plain ls in wa chat with 0.1GB free memory and only 22GB model fails gracefully with actionable recovery and !ls tip, and chat remains usable afterwards', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-chat-recovery-'));
    await fs.writeFile(path.join(tmpDir, 'recovery-check.txt'), 'ok\n', 'utf8');

    const { engine, loadCalls } = await createTestFleet(tmpDir, {
      availableMemoryGB: 0.1,
      totalMemoryGB: 32,
      registerSmallModel: false,
    });

    const harness = new TuiTestHarness({
      engine,
      presentationMode: 'conversation',
    });
    const tui = harness.tui;

    await tui.start();
    await tui.submitCommand('ls');
    // Allow async job runner to settle
    await new Promise((r) => setTimeout(r, 150));

    // Must NOT attempt to load the 22GB model
    expect(loadCalls).toHaveLength(0);
    expect(harness.outStream.getOutput()).toContain(
      "No computer can host model 'qwen/qwen3.8-27b'. local: available memory 0.1GB < required 22GB.",
    );
    expect(harness.outStream.getOutput()).toContain('!ls');

    // Chat remains usable after the failed task: run !ls and /models
    await tui.submitCommand('!ls');
    expect(tui.lastShellOutput?.exitCode).toBe(0);
    expect(tui.lastShellOutput?.stdout).toContain('recovery-check.txt');

    await tui.submitCommand('/models');
    expect(tui.statusMessage).toBeDefined();

    tui.stop();
  });

  it('3 (Cost-aware selection): Avoids cold-loading a 27B/22GB model for a simple task when a smaller or already-loaded model is eligible', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-cost-aware-'));
    // Plenty of memory (64GB) so both 27B (22GB) and 1.5B (2GB) fit while unloaded
    const { engine } = await createTestFleet(tmpDir, {
      availableMemoryGB: 64,
      totalMemoryGB: 64,
      registerSmallModel: true,
      smallModelLoaded: false,
    });

    const decision = engine.scheduler.plan({
      task: {
        id: 'task-trivial',
        type: 'coding',
        title: 'ls',
        input: 'ls',
        requirements: { capabilities: ['code_generation'], toolCalling: true },
      },
    });

    // Should prefer the smaller 2GB model over cold-loading the 22GB model for a non-high-reasoning task
    expect(decision.modelId).toBe('qwen/qwen2.5-coder-1.5b');
    expect(decision.modelDecision.reasons.join(' ')).toContain('cost-aware footprint efficiency');
  });

  it('6 (Strict model selection): Never silently overrides an explicit model pin or provider_only restriction when the pinned model cannot be hosted', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-strict-pin-'));
    // 4GB available on 32GB host: small model (2GB) is eligible and READY, hosted model is READY, but user pins qwen/qwen3.8-27b (22GB)
    const { engine } = await createTestFleet(tmpDir, {
      availableMemoryGB: 4.0,
      totalMemoryGB: 32,
      registerSmallModel: true,
      smallModelLoaded: true,
      registerHostedModel: true,
    });

    expect(() =>
      engine.scheduler.plan({
        task: {
          id: 'task-pinned',
          type: 'coding',
          title: 'pinned task',
          input: 'ls',
          requirements: { capabilities: ['code_generation'], toolCalling: true },
          execution: { targetModelId: 'qwen/qwen3.8-27b' },
        },
      }),
    ).toThrowError(
      new RegExp(
        "No computer can host model 'qwen/qwen3.8-27b'.*available memory 4GB < required 22GB.*No silent fallback will be performed",
      ),
    );

    // Also verify provider_only restriction never silently falls back to local model
    const { engine: providerOnlyEngine } = await createTestFleet(tmpDir, {
      availableMemoryGB: 64,
      totalMemoryGB: 64,
      registerSmallModel: true,
      smallModelLoaded: true,
      registerHostedModel: false,
      routingMode: 'provider_only',
      routingProvider: 'nvidia',
    });

    expect(() =>
      providerOnlyEngine.scheduler.plan({
        task: {
          id: 'task-provider-only',
          type: 'coding',
          title: 'provider task',
          input: 'ls',
          requirements: { capabilities: ['code_generation'] },
        },
      }),
    ).toThrow(SchedulingError);
  });

  it('7 (Model status reporting): Accurately distinguishes registered, available, and locally loaded models (hosted models are never counted as locally loaded)', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-counts-'));
    // Register:
    // 1. qwen/qwen3.8-27b (local, 22GB required, unloaded -> NOT available on 4GB free memory, NOT locally loaded)
    // 2. qwen/qwen2.5-coder-1.5b (local, 2GB required, unloaded -> available on 4GB free memory, NOT locally loaded)
    // 3. nvidia/nemotron-mini-4b-instruct (hosted, READY -> available, NOT locally loaded)
    const { engine } = await createTestFleet(tmpDir, {
      availableMemoryGB: 4.0,
      totalMemoryGB: 32,
      registerSmallModel: true,
      smallModelLoaded: false,
      registerHostedModel: true,
    });

    const readiness = engine.lifecycle.getReadiness();
    expect(readiness.registeredCount).toBe(3);
    expect(readiness.availableCount).toBe(2); // 1.5b local + nemotron hosted
    expect(readiness.localLoadedCount).toBe(0); // Neither local model is loaded in RAM
    expect(readiness.hostedAvailableCount).toBe(1);

    // Verify `wa models loaded` does not report hosted models as loaded in local memory
    const loadedOutput = listLoadedModels(engine);
    expect(loadedOutput).toContain('No models are currently loaded in local memory.');

    // Verify `wa models list` summary includes Registered, Available, and Locally Loaded
    const listOutput = listModels(engine);
    expect(listOutput).toContain('Registered 3');
    expect(listOutput).toContain('Available 2');
    expect(listOutput).toContain('Locally Loaded 0');
    expect(listOutput).toContain('AVAILABLE (HOSTED)');

    // Verify startup status message in FleetTui does not say "X model(s) loaded" when 0 local models are loaded
    const harness = new TuiTestHarness({
      engine,
      presentationMode: 'dashboard',
    });
    const tui = harness.tui;
    await tui.start();
    expect(tui.statusMessage).toContain('3 registered, 2 available, 0 locally loaded');
    expect(tui.statusMessage).not.toMatch(/\b[1-9]\d*\s+model\(s\)\s+loaded\b/i);
    tui.stop();
  });

  it('10 (Approval policies & safety): Preserves command safety restrictions on !<cmd> direct shell execution', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-shell-policy-'));
    const { engine, loadCalls } = await createTestFleet(tmpDir, {
      availableMemoryGB: 0.1,
      totalMemoryGB: 32,
    });

    const harness = new TuiTestHarness({
      engine,
      presentationMode: 'conversation',
    });
    const tui = harness.tui;

    await tui.start();
    // Privileged/destructive command must be denied by PolicyEngine even via !<cmd>
    await tui.submitCommand('!sudo echo blocked');

    expect(loadCalls).toHaveLength(0);
    expect(tui.lastShellOutput?.exitCode).toBe(126);
    expect(tui.lastShellOutput?.stderr).toMatch(/policy deny/i);

    tui.stop();
  });
});
