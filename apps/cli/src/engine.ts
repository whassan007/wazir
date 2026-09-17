import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AgentRegistry,
  ApprovalQueue,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  Job,
  JobManager,
  JobOrchestrator,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  WorktreeManager,
} from '@wazir/core';
import type {
  ComputerRegistration,
  ModelCapability,
  ModelRecord,
  RuntimeType,
} from '@wazir/core';
import type { DiscoveredModel } from '@wazir/runtimes-interfaces';
import {
  MemoryStore,
  JsonFileStore,
  type KeyValueStore,
} from '@wazir/shared';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent, ExternalAgentAdapter } from '@wazir/agents';
import { createOllamaAdapter } from '@wazir/runtimes-ollama';
import { createLMStudioAdapter } from '@wazir/runtimes-lmstudio';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import { Worker, type DiscoveredRuntime } from '@wazir/workers';
import { configDir, loadConfig, type WazirConfig } from './config.js';
import { syncRemoteInventory } from './remoteInventory.js';
import path from 'node:path';

export interface EngineOptions {
  projectRoot?: string;
  quiet?: boolean;
}

export interface RookEngine {
  config: WazirConfig;
  projectRoot: string;
  configDir: string;
  computers: ComputerRegistry;
  runtimes: RuntimeRegistry;
  models: ModelRegistry;
  agents: AgentRegistry;
  tools: ToolRegistry;
  policy: PolicyEngine;
  scheduler: Scheduler;
  compiler: ContextCompiler;
  executions: ExecutionEngine & { store?: KeyValueStore };
  approvalQueue: ApprovalQueue;
  orchestrator: JobOrchestrator & { store?: KeyValueStore };
  worktrees: WorktreeManager;
  adapters: Map<string, RuntimeAdapter>;
  discovered: DiscoveredRuntime[];
  worker: Worker;
  store: KeyValueStore;
}

function guessFamily(id: string, provider: string): ModelRecord['family'] {
  const lower = id.toLowerCase();
  if (lower.includes('qwen')) return 'qwen';
  if (lower.includes('gpt')) return 'gpt';
  if (lower.includes('gemma')) return 'gemma';
  if (lower.includes('nemotron')) return 'nemotron';
  if (lower.includes('llama')) return 'llama';
  if (lower.includes('mistral') || lower.includes('mixtral')) return 'mistral';
  if (lower.includes('granite')) return 'granite';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('phi')) return 'phi';
  return provider === 'ollama' ? 'qwen' : 'other';
}

const DEFAULT_CONTEXT = 32_768;
const execFileAsync = promisify(execFile);

async function detectOpenCode(): Promise<boolean> {
  try {
    await execFileAsync('opencode', ['--version'], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

export async function createEngine(options: EngineOptions = {}): Promise<RookEngine> {
  const config = loadConfig();
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  // ---- registries -----------------------------------------------------
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();

  // ---- persistence ----------------------------------------------------
  // WAZIR_DATABASE_URL > WAZIR_IN_MEMORY=1 > the default local JSON file
  // store — first backend that's configured wins.
  const store: KeyValueStore = await createStore();
  const engineConfigDir = configDir();

  const executions = new ExecutionEngine({
    persist: (record) => store.put(`execution/${record.execution.id}`, record),
    load: async () => {
      const entries = await store.list('execution/');
      return entries.map((e) => e.value as never);
    },
  }) as any;
  executions.store = store; // Attach store for Block persistence

  // ---- local computer + runtimes + models ------------------------------
  const adapterList: RuntimeAdapter[] = [
    createOllamaAdapter(config.ollamaUrl ?? 'http://localhost:11434'),
    createLMStudioAdapter(config.lmstudioUrl ?? 'http://localhost:1234/v1'),
  ];

  // await executions.ready;

  // The worker owns discovery on this machine; the engine reads its results.
  const worker = new Worker({
    computerId: process.env.WAZIR_COMPUTER_ID ?? 'local',
    name: process.env.WAZIR_COMPUTER_NAME ?? os.hostname() ?? 'local',
    adapters: adapterList,
  });
  await worker.start();
  const discovered = worker.discovered;
  const adapterById = new Map(discovered.map((d) => [d.id, d.adapter]));
  const hardware = worker.hardwareReport!;

  const localComputer: ComputerRegistration = {
    id: process.env.WAZIR_COMPUTER_ID ?? 'local',
    name: process.env.WAZIR_COMPUTER_NAME ?? os.hostname() ?? 'local',
    type: 'workstation',
    local: true,
    os: hardware.os,
    hardware: hardware.hardware,
    capabilities: ['localExecution'],
  };
  computers.register(localComputer);

  for (const discoveredRuntime of discovered) {
    const runtimeType: RuntimeType =
      discoveredRuntime.id === 'ollama'
        ? 'ollama'
        : discoveredRuntime.id === 'lmstudio'
          ? 'lmstudio'
          : 'other';

    const existing = runtimes.get(discoveredRuntime.id);
    runtimes.register({
      id: existing?.id ?? discoveredRuntime.id,
      type: runtimeType,
      name: discoveredRuntime.info.name,
      version: discoveredRuntime.info.version,
      url: discoveredRuntime.info.url,
      computerId: localComputer.id,
      capabilities: {
        chat: discoveredRuntime.capabilities.chat,
        streaming: discoveredRuntime.capabilities.streaming,
        toolCalling: discoveredRuntime.capabilities.toolCalling,
        structuredOutput: discoveredRuntime.capabilities.structuredOutput,
        vision: discoveredRuntime.capabilities.vision,
        embeddings: discoveredRuntime.capabilities.embeddings,
        reasoning: discoveredRuntime.capabilities.reasoning,
        modelLoad: discoveredRuntime.capabilities.modelLoad,
        modelUnload: discoveredRuntime.capabilities.modelUnload,
        modelDownload: discoveredRuntime.capabilities.modelDownload,
        statefulChat: discoveredRuntime.capabilities.statefulChat,
        mcp: discoveredRuntime.capabilities.mcp,
      },
    });

    if (discoveredRuntime.health !== 'unavailable') {
      computers.heartbeat(localComputer.id, {
        runtimeHealth: { [discoveredRuntime.id]: { status: discoveredRuntime.health === "healthy" ? "healthy" : "unhealthy" } },
      });

      for (const discoveredModel of discoveredRuntime.models) {
        registerModel(
          models,
          discoveredRuntime,
          discoveredModel,
          localComputer.id,
          config,
        );
      }
    }
  }

  // ---- remote inventory (optional distributed mode) ---------------------
  // Without this, the Scheduler can only ever see the computer this CLI
  // invocation is running on. When a control-plane API is configured, pull
  // its known computers/runtimes/models/instances in so a task can be placed
  // on — and later dispatched to — a remote machine.
  if (config.apiUrl) {
    const sync = await syncRemoteInventory(config.apiUrl, localComputer.id, { computers, runtimes, models });
    if (sync.errors.length > 0 && !options.quiet) {
      console.error(`[wazir] remote inventory sync from ${config.apiUrl} had errors:`);
      for (const error of sync.errors) console.error(`  - ${error}`);
    }
  }

  // ---- agents -----------------------------------------------------------
  agents.register(createCodingAgent(), 'native');

  // OpenCode is an optional external execution provider: Wazir still owns
  // scheduling, policy, and history — OpenCode only supplies the reasoning
  // loop for a task that explicitly asks for it (`wa task run --agent
  // opencode` / `wa ask --agent opencode`). `taskTypes: []` means it is
  // never auto-selected by `AgentRegistry.resolveForTask`, so installing the
  // `opencode` binary can't silently change where an un-pinned task lands.
  // Only registered when the binary is actually reachable, mirroring how
  // Ollama/LM Studio runtimes are auto-discovered rather than assumed.
  if (await detectOpenCode()) {
    agents.register(
      new ExternalAgentAdapter({
        name: 'opencode',
        version: 'external',
        description: 'OpenCode terminal coding agent, invoked as an external process',
        command: 'opencode',
        args: ['run'],
        taskTypes: [],
        capabilities: ['coding'],
      }),
      'external',
    );
  }

  // ---- approval queue & policy -------------------------------------------
  const approvalQueue = new ApprovalQueue();
  const policy = new PolicyEngine({
    projectRoot,
    networkAllowed: config.networkAllowed,
    allowCommands: config.allowCommands,
    denyCommands: config.denyCommands,
    allowedMcpServers: config.allowedMcpServers,
    approvalQueue,
    approveCallback: async (request, decision) => {
      const { createApprover } = await import('./approve.js');
      return createApprover(request, decision);
    },
  });

  // ---- scheduler ----------------------------------------------------------
  const scheduler = new Scheduler({
    computers,
    runtimes,
    models,
    agents,
  });

  // ---- jobs & orchestration -----------------------------------------------
  const jobManager = new JobManager({
    persist: (job) => store.put(`job/${job.id}`, job),
    load: async () => {
      const entries = await store.list('job/');
      return entries.map((e) => e.value as Job);
    },
  });

  const orchestrator = new JobOrchestrator({
    scheduler,
    executionEngine: executions,
    policy,
    agents,
    models,
    runtimes,
    computers,
    jobManager,
  }) as any;
  orchestrator.store = store; // Attach store for Block persistence

  const worktrees = new WorktreeManager();

  return {
    config,
    projectRoot,
    configDir: engineConfigDir,
    computers,
    runtimes,
    models,
    agents,
    tools,
    policy,
    scheduler,
    compiler,
    executions,
    approvalQueue,
    orchestrator,
    worktrees,
    adapters: adapterById,
    discovered,
    worker,
    store,
  };
}

function registerModel(
  models: ModelRegistry,
  runtime: { id: string; health: string; models: DiscoveredModel[] },
  discovered: DiscoveredModel,
  computerId: string,
  config: WazirConfig,
): void {
  const provider = runtime.id;
  const capabilities: ModelCapability[] = dedupe([
    'generalChat',
    ...(discovered.capabilities ?? []),
    ...(config.modelCapabilities[discovered.id] ?? []),
  ] as ModelCapability[]);

  if (discovered.toolCalling) capabilities.push('toolCalling');
  if (discovered.reasoning) capabilities.push('reasoning');
  if (discovered.vision) capabilities.push('vision');
  if (discovered.embedding) capabilities.push('embedding');
  if (discovered.structuredOutput) capabilities.push('structuredOutput');

  const configured = config.modelContext[discovered.id];
  const contextMax = discovered.contextWindow ?? configured ?? DEFAULT_CONTEXT;

  const record: ModelRecord = {
    id: discovered.id,
    name: discovered.name ?? discovered.id,
    provider,
    family: guessFamily(discovered.id, provider),
    architecture: discovered.architecture,
    parameters: discovered.parameters,
    contextMax,
    configuredContext: configured,
    capabilities,
    toolCalling: discovered.toolCalling ?? false,
    structuredOutput: discovered.structuredOutput ?? false,
    vision: discovered.vision ?? false,
    audio: discovered.audio ?? false,
    embedding: discovered.embedding ?? false,
    reasoning: discovered.reasoning ?? false,
    quantization: discovered.quantization,
    memory: {
      minSystemGB: 8,
      minGpuGB: undefined,
    },
    runtimeCompatibility: provider === 'ollama' ? ['ollama'] : provider === 'lmstudio' ? ['lmstudio'] : 'any',
    local: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  models.register(record);

  models.upsertInstance({
    id: `${discovered.id}::${computerId}::${provider}`,
    modelId: discovered.id,
    computerId,
    runtimeId: provider,
    runtimeModelId: discovered.id,
    loaded: false,
    health: runtime.health === 'healthy' ? 'healthy' : 'degraded',
    contextTokens: contextMax,
  });
}

export async function createStore(): Promise<KeyValueStore> {
  if (process.env.WAZIR_DATABASE_URL) {
    const { createPool, runKvMigration, PostgresStore } = await import('@wazir/database');
    const pool = createPool({ connectionString: process.env.WAZIR_DATABASE_URL });
    await runKvMigration(pool);
    return new PostgresStore(pool);
  }
  if (process.env.WAZIR_IN_MEMORY === '1') {
    return new MemoryStore();
  }
  return new JsonFileStore(path.join(configDir(), 'wazir.json'));
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
