import { describe, expect, it, afterEach } from 'vitest';
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
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { MemoryStore } from '@wazir/shared';
import type { RookEngine } from '../src/engine.js';
import { TuiTestHarness } from '../src/tui/inputHarness.js';
import {
  classifyModelReadiness,
  missionHeader,
  renderMissionControl,
  type MissionSnapshot,
} from '../src/tui/missionControl.js';
import { stripAnsi, stringDisplayWidth } from '../src/tui/unicode.js';

const empty: MissionSnapshot = {
  workspace: '/workspace',
  agents: 0,
  running: 0,
  ready: 0,
  installed: 0,
  computers: 0,
  jobs: [],
  models: [],
  runtimes: [],
  approvals: 0,
  inputTokens: 0,
  outputTokens: 0,
  events: [],
  evidence: [],
};

async function buildMissionTestEngine(projectRoot: string): Promise<RookEngine> {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();
  const executions = new ExecutionEngine();
  const approvalQueue = new ApprovalQueue();
  const worktrees = new WorktreeManager();

  computers.register({
    id: 'local',
    name: 'Mac-Studio-M2',
    type: 'workstation',
    local: true,
    os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
    hardware: { cpu: 'Apple M2 Ultra', cpuCores: 24, memoryGB: 128 },
    capabilities: ['localExecution', 'gpuInference'],
  });

  const baseCaps = {
    chat: true,
    streaming: true,
    toolCalling: true,
    structuredOutput: false,
    vision: false,
    embeddings: false,
    reasoning: true,
    modelLoad: false,
    modelUnload: false,
    modelDownload: false,
    statefulChat: false,
    mcp: false,
  };

  runtimes.register({
    id: 'ollama',
    type: 'ollama',
    name: 'Ollama Local',
    version: '0.5',
    computerId: 'local',
    capabilities: baseCaps,
  });
  runtimes.update('ollama', { health: 'healthy' });

  runtimes.register({
    id: 'nvidia',
    type: 'other',
    name: 'NVIDIA NIM API Catalog',
    version: '1.0',
    computerId: 'local',
    runtimeKind: 'hosted',
    capabilities: baseCaps,
  });
  runtimes.update('nvidia', { health: 'healthy' });

  runtimes.register({
    id: 'openai',
    type: 'other',
    name: 'OpenAI Hosted',
    version: '1.0',
    computerId: 'local',
    runtimeKind: 'hosted',
    capabilities: baseCaps,
  });
  runtimes.update('openai', { health: 'unavailable' });

  runtimes.register({
    id: 'router-provider',
    type: 'other',
    name: 'Provider Router',
    version: '1.0',
    computerId: 'local',
    runtimeKind: 'hosted',
    capabilities: baseCaps,
  });

  // 1. Local GPU loaded model
  models.register({
    id: 'qwen2.5-coder:32b',
    name: 'Qwen 2.5 Coder 32B',
    provider: 'ollama',
    family: 'qwen',
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
    id: 'qwen2.5-coder:32b::local::ollama',
    modelId: 'qwen2.5-coder:32b',
    computerId: 'local',
    runtimeId: 'ollama',
    runtimeModelId: 'qwen2.5-coder:32b',
    loaded: true,
    state: 'READY',
    health: 'healthy',
    contextTokens: 32_768,
  });

  // 2. Local installed but unloaded model
  models.register({
    id: 'deepseek-r1:14b',
    name: 'DeepSeek R1 14B',
    provider: 'ollama',
    family: 'deepseek',
    contextMax: 32_768,
    capabilities: ['generalChat', 'reasoning'],
    toolCalling: false,
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
  models.upsertInstance({
    id: 'deepseek-r1:14b::local::ollama',
    modelId: 'deepseek-r1:14b',
    computerId: 'local',
    runtimeId: 'ollama',
    runtimeModelId: 'deepseek-r1:14b',
    loaded: false,
    state: 'INSTALLED',
    health: 'healthy',
    contextTokens: 32_768,
  });

  // 3. Hosted NVIDIA model available (no local GPU memory residency needed)
  models.register({
    id: 'nvidia/llama-3.3-nemotron-super-49b-v1',
    name: 'Llama 3.3 Nemotron Super 49B',
    provider: 'nvidia',
    family: 'llama',
    contextMax: 131_072,
    capabilities: ['generalChat', 'coding', 'reasoning'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    runtimeCompatibility: 'any',
    local: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'nvidia/llama-3.3-nemotron-super-49b-v1::hosted::nvidia',
    modelId: 'nvidia/llama-3.3-nemotron-super-49b-v1',
    computerId: 'local',
    runtimeId: 'nvidia',
    runtimeModelId: 'nvidia/llama-3.3-nemotron-super-49b-v1',
    loaded: true,
    state: 'READY',
    health: 'healthy',
    contextTokens: 131_072,
  });

  // 4. Hosted provider unavailable
  models.register({
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    provider: 'openai',
    family: 'gpt',
    contextMax: 128_000,
    capabilities: ['generalChat', 'coding'],
    toolCalling: true,
    structuredOutput: true,
    vision: true,
    audio: false,
    embedding: false,
    reasoning: false,
    runtimeCompatibility: 'any',
    local: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'gpt-4.1::hosted::openai',
    modelId: 'gpt-4.1',
    computerId: 'local',
    runtimeId: 'openai',
    runtimeModelId: 'gpt-4.1',
    loaded: false,
    state: 'UNAVAILABLE',
    health: 'unavailable',
    contextTokens: 128_000,
  });

  // 5. Configured provider-only routing
  models.register({
    id: 'router/coding-policy',
    name: 'Coding Router Policy',
    provider: 'router-provider',
    family: 'other',
    contextMax: 65_536,
    capabilities: ['coding'],
    toolCalling: true,
    structuredOutput: false,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: false,
    runtimeCompatibility: 'any',
    local: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'router/coding-policy::hosted::router',
    modelId: 'router/coding-policy',
    computerId: 'local',
    runtimeId: 'router-provider',
    runtimeModelId: 'router/coding-policy',
    loaded: false,
    state: 'CONFIGURED' as any,
    health: 'unknown' as any,
    contextTokens: 65_536,
  });

  // 6. Unknown local runtime state
  models.register({
    id: 'mystery-experimental-7b',
    name: 'Mystery Experimental 7B',
    provider: 'custom-unprobed',
    family: 'other',
    contextMax: 8192,
    capabilities: ['generalChat'],
    toolCalling: false,
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

  const fakeAdapter: RuntimeAdapter = {
    id: 'ollama',
    type: 'ollama',
    async inspectModel(modelId) {
      return { modelId, loaded: true, effectiveContext: 32768 };
    },
    async probeModel() {
      return true;
    },
    async discover() {
      return { id: 'ollama', name: 'Ollama Local', version: '0.5' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async cancel() {},
    async listModels() {
      return [{ id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B' }];
    },
    async getCapabilities() {
      return baseCaps;
    },
    async *generate() {
      const reply = '{"action":"done","summary":"completed"}';
      yield { type: 'token' as const, content: reply };
      yield {
        type: 'completed' as const,
        content: reply,
        usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
      };
    },
  };

  const fakeWorker = {
    id: 'worker-local',
    computerId: 'local',
    adapterForModel: () => fakeAdapter,
    refreshRuntime: async () => undefined,
  } as unknown as Worker;

  return {
    config: {
      modelContext: {},
      modelCapabilities: {},
      networkAllowed: false,
      allowCommands: [],
      denyCommands: [],
      allowedMcpServers: [],
      providers: {
        'router-provider': { enabled: true },
      },
    } as any,
    projectRoot,
    configDir: path.join(projectRoot, '.wazir'),
    computers,
    runtimes,
    models,
    lifecycle: new ModelLifecycleService({
      executions,
      models,
      runtimes,
      computers,
      agents,
      adapters: new Map([['ollama', fakeAdapter]]),
      store: new MemoryStore() as any,
    }),
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
    adapters: new Map([['ollama', fakeAdapter]]),
    discovered: [],
    worker: fakeWorker,
    store: new MemoryStore() as any,
  };
}

describe('Mission Control projection & Phase 4 validation suite', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('keeps operational sections visible in a 64x24 narrow terminal', () => {
    const rows = renderMissionControl(empty, 64, 16);
    const screen = stripAnsi(rows.join('\n'));
    for (const title of ['EXECUTION MONITOR', 'MODELS & PROVIDERS', 'ACTIVITY & TOOL CALLS', 'VERIFICATION EVIDENCE']) {
      expect(screen).toContain(title);
    }
    expect(rows.length).toBeLessThanOrEqual(16);
    for (const row of rows) {
      expect(stringDisplayWidth(row)).toBeLessThanOrEqual(64);
    }
    expect(screen).toContain('No models discovered');
    expect(screen).toContain('Cost: unreported');
    expect(screen).not.toContain('PASS');
    expect(screen).not.toContain('H100');
  });

  it('projects real execution, provider, approval, usage and evidence values in wide layout', () => {
    const rows = renderMissionControl(
      {
        ...empty,
        agents: 2,
        running: 1,
        ready: 1,
        installed: 2,
        jobs: [{ id: 'job-real', title: 'Fix compiler error', status: 'failed' }],
        models: [{ name: 'configured-model', provider: 'configured-provider', ready: true }],
        approvals: 3,
        inputTokens: 123,
        outputTokens: 45,
        events: [{ time: '12:34', kind: 'tool', text: 'npm test exit 1' }],
        evidence: ['TEST failed: exit 1'],
      },
      120,
      42,
    );
    const screen = stripAnsi(rows.join('\n'));
    for (const value of [
      '╱▲╲',
      'MISSION CONTROL',
      'job-real',
      'FAILED',
      'configured-provider',
      '3 approvals',
      '123 in / 45 out',
      'npm test exit 1',
      'TEST failed',
    ]) {
      expect(screen).toContain(value);
    }
  });

  it('classifies all 6 model readiness states accurately (including hosted NVIDIA without local GPU)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-mc-readiness-'));
    tempDirs.push(tmpDir);
    const engine = await buildMissionTestEngine(tmpDir);
    const instances = engine.models.listInstances();

    const localLoaded = classifyModelReadiness(engine.models.get('qwen2.5-coder:32b')!, instances, engine);
    expect(localLoaded.category).toBe('LOCAL_LOADED');
    expect(stripAnsi(localLoaded.badge)).toContain('READY (LOCAL GPU)');
    expect(localLoaded.ready).toBe(true);

    const localUnloaded = classifyModelReadiness(engine.models.get('deepseek-r1:14b')!, instances, engine);
    expect(localUnloaded.category).toBe('LOCAL_INSTALLED_UNLOADED');
    expect(stripAnsi(localUnloaded.badge)).toContain('INSTALLED (UNLOADED)');
    expect(localUnloaded.ready).toBe(false);

    const hostedNvidia = classifyModelReadiness(
      engine.models.get('nvidia/llama-3.3-nemotron-super-49b-v1')!,
      instances,
      engine,
    );
    expect(hostedNvidia.category).toBe('HOSTED_AVAILABLE');
    expect(stripAnsi(hostedNvidia.badge)).toContain('AVAILABLE (HOSTED)');
    expect(hostedNvidia.ready).toBe(true);

    const hostedUnavailable = classifyModelReadiness(engine.models.get('gpt-4.1')!, instances, engine);
    expect(hostedUnavailable.category).toBe('HOSTED_UNAVAILABLE');
    expect(stripAnsi(hostedUnavailable.badge)).toContain('UNAVAILABLE (HOSTED)');
    expect(hostedUnavailable.ready).toBe(false);

    const providerRouting = classifyModelReadiness(engine.models.get('router/coding-policy')!, instances, engine);
    expect(providerRouting.category).toBe('PROVIDER_ROUTING');
    expect(stripAnsi(providerRouting.badge)).toContain('PROVIDER ROUTING');
    expect(providerRouting.ready).toBe(true);

    const unknownModel = classifyModelReadiness(engine.models.get('mystery-experimental-7b')!, instances, engine);
    expect(unknownModel.category).toBe('UNKNOWN');
    expect(stripAnsi(unknownModel.badge)).toContain('UNKNOWN');
    expect(unknownModel.ready).toBe(false);
  });

  it('keeps wa chat in inline Codex-style conversation mode and wa fleet in Mission Control dashboard mode', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-mc-modes-'));
    tempDirs.push(tmpDir);
    const engine = await buildMissionTestEngine(tmpDir);

    const chatHarness = new TuiTestHarness({ engine, presentationMode: 'conversation' });
    await chatHarness.start();
    // Conversation mode does NOT enter alternate screen (\x1b[?1049h)
    expect(chatHarness.outStream.getOutput()).not.toContain('\x1b[?1049h');
    chatHarness.stop();

    const fleetHarness = new TuiTestHarness({ engine, presentationMode: 'dashboard' });
    await fleetHarness.start();
    expect(fleetHarness.outStream.getOutput()).toContain('\x1b[?1049h');
    const fleetScreen = stripAnsi(fleetHarness.getScreenBuffer());
    expect(fleetScreen).toContain('WAZIR - CONTROL - WORKER:');
    expect(fleetScreen).toContain('EXECUTION MONITOR');
    fleetHarness.stop();
  });

  it('supports keyboard navigation, model pinning (/model <id> and /model auto), job inspection, resize, Unicode, and clean shutdown', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-mc-nav-'));
    tempDirs.push(tmpDir);
    const engine = await buildMissionTestEngine(tmpDir);

    const h = new TuiTestHarness({ engine, presentationMode: 'dashboard' });
    h.outStream.columns = 128;
    h.outStream.rows = 38;
    await h.start();

    // 1. Default view shows Mission Control header and routing policy
    let screen = stripAnsi(h.getScreenBuffer());
    expect(screen).toContain('WAZIR - CONTROL - WORKER:');
    expect(screen).toContain('Model: auto');

    // 2. Switch to Models view ('5') and verify all readiness badges render
    h.sendKey('5');
    screen = stripAnsi(h.getScreenBuffer());
    expect(screen).toContain('MODELS & PROVIDERS');
    expect(screen).toContain('READY (LOCAL GPU)');
    expect(screen).toContain('INSTALLED (UNLOADED)');
    expect(screen).toContain('AVAILABLE (HOSTED)');
    expect(screen).toContain('UNAVAILABLE (HOSTED)');

    // 3. Pin a hosted NVIDIA model via /model command and verify header updates
    h.sendKey('1');
    h.sendLine('/model nvidia/llama-3.3-nemotron-super-49b-v1');
    await new Promise((r) => setTimeout(r, 20));
    screen = stripAnsi(h.getScreenBuffer());
    expect(screen).toContain('Model: nvidia/llama-3.3-nemotron-super-49b');
    expect(screen).toContain("Pinned model to 'nvidia/llama-3.3-nemotron-super-49b-v1'");

    // 4. Reset to /model auto
    h.sendLine('/model auto');
    await new Promise((r) => setTimeout(r, 20));
    screen = stripAnsi(h.getScreenBuffer());
    expect(screen).toContain('Model: auto');

    // 5. Switch to Fleet Topology view ('4' or /fleet) and verify multi-node topology + operational overview
    h.sendLine('/fleet');
    await new Promise((r) => setTimeout(r, 20));
    screen = stripAnsi(h.getScreenBuffer());
    expect(screen).toContain('FLEET TOPOLOGY & DISTRIBUTED COMPUTE FABRIC');

    // 6. Resize handling (narrow 70x24 -> wide 150x42)
    h.outStream.columns = 70;
    h.outStream.rows = 24;
    h.outStream.emit('resize');
    const narrowLines = h.getLines();
    expect(narrowLines.length).toBeLessThanOrEqual(24);
    for (const line of narrowLines) {
      expect(stringDisplayWidth(line)).toBeLessThanOrEqual(70);
    }

    h.outStream.columns = 150;
    h.outStream.rows = 42;
    h.outStream.emit('resize');
    const wideLines = h.getLines();
    expect(wideLines.length).toBeLessThanOrEqual(42);

    // 7. Unicode rendering safety in header
    const unicodeHeader = missionHeader(
      '/Users/wael/Code/Wazir-🚀-日本語',
      'fleet',
      100,
      {
        version: '0.2.5',
        selectedModelId: 'nvidia/llama-3.3-nemotron-super-49b-v1',
        activeContext: 'job-101 • Fix Unicode ─── テスト',
        computers: 2,
        agents: 2,
        activeAgents: 1,
        readyModels: 2,
        installedModels: 4,
      },
    );
    for (const line of unicodeHeader) {
      expect(stringDisplayWidth(line)).toBeLessThanOrEqual(100);
    }

    // 8. Clean shutdown restores terminal state
    h.outStream.clearOutput();
    h.stop();
    expect(h.outStream.getOutput()).toContain('\x1b[?1049l');
  });
});


