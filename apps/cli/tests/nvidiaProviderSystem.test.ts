import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AccountRegistry,
  AgentRegistry,
  ComputerRegistry,
  ContextCompiler,
  DEFAULT_POLICY,
  ExecutionEngine,
  JobManager,
  JobOrchestrator,
  ModelLifecycleService,
  ModelRegistry,
  PolicyEngine,
  ResourceLedger,
  ResourceRouter,
  RuntimeRegistry,
  Scheduler,
  SchedulingError,
  TokenBudgetManager,
  WorktreeManager,
  createTaskPlanner,
  governAdapter,
  type ResourcePolicy,
  type Task,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import { createSecretBroker } from '@wazir/secrets';
import {
  NVIDIA_DEFAULT_MODEL_ID,
  NvidiaAdapter,
} from '@wazir/runtimes-nvidia';
import { applyHostedProvider, createHostedProviders, ensureNvidiaModelRegistered } from '../src/hostedProviders.js';
import {
  askCommand,
  listModels,
  listProvidersCommand,
  inspectProviderCommand,
  testProviderCommand,
  runBenchmark,
  runTaskCommand,
  planTaskCommand,
} from '../src/commands.js';
import { planEscalation } from '../src/escalation.js';
import { validateRoutingConfig, buildNvidiaHostedLimits, type WazirConfig } from '../src/config.js';
import { executeTask } from '../src/run.js';
import { createFleetTaskExecutor } from '../src/fleetRunner.js';
import { resourceSnapshot, renderResourceSnapshot } from '../src/resourceDashboard.js';
import type { RookEngine } from '../src/engine.js';

const MOCK_NVAPI_KEY = 'nvapi-system-test-key-00112233445566778899';

function makeSseStream(chunks: Array<Record<string, unknown> | string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        const line = typeof chunk === 'string' ? `data: ${chunk}\n\n` : `data: ${JSON.stringify(chunk)}\n\n`;
        controller.enqueue(encoder.encode(line));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

async function createNvidiaTestEngine(options: {
  projectRoot: string;
  apiKey?: string;
  allowHostedProviders?: boolean;
  includeLocalModel?: boolean;
  includeAnthropicModel?: boolean;
  includeExternalAgent?: boolean;
  routing?: WazirConfig['routing'];
  nvidiaLimits?: NonNullable<NonNullable<WazirConfig['providers']>['nvidia']>['limits'];
  nvidiaPricing?: NonNullable<NonNullable<WazirConfig['providers']>['nvidia']>['pricing'];
  enforceBudget?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<RookEngine> {
  const secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-nvidia-sys-secrets-'));
  const secretBroker = await createSecretBroker({ secretsDir });

  const routing = options.routing ? validateRoutingConfig(options.routing, 'test') : undefined;
  const hostedAuthorizedDefault =
    options.allowHostedProviders ??
    (routing?.mode === 'provider_only' && routing.provider === 'nvidia');

  const config: WazirConfig = {
    routing,
    networkAllowed: false,
    allowCommands: [],
    denyCommands: [],
    allowedMcpServers: [],
    modelContext: {},
    modelCapabilities: {},
    providers: {
      allowHostedProviders: hostedAuthorizedDefault,
      nvidia: {
        enabled: true,
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiKeyEnv: 'NVIDIA_API_KEY',
        defaultModel: routing?.defaultModel ?? NVIDIA_DEFAULT_MODEL_ID,
        maxOutputTokens: 16384,
        discoverModels: true,
        limits: options.nvidiaLimits,
        pricing: options.nvidiaPricing,
      },
    },
  };

  const computers = new ComputerRegistry();
  computers.register({
    id: 'local',
    name: 'workstation-local',
    type: 'workstation',
    local: true,
    os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
    hardware: { cpuModel: 'Apple M3 Max', cpuCores: 16, memoryGB: 64, gpu: { vendor: 'apple', model: 'Apple M3 Max GPU', vramGB: 48 } },
    capabilities: ['localExecution'],
  });

  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();
  const executions = new ExecutionEngine({ workspace: options.projectRoot });

  if (options.includeLocalModel ?? true) {
    runtimes.register({
      id: 'ollama',
      type: 'ollama',
      name: 'Ollama',
      version: '0.5.0',
      computerId: 'local',
      runtimeKind: 'local',
      capabilities: {
        chat: true,
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        embeddings: false,
        reasoning: false,
        modelLoad: true,
        modelUnload: true,
        modelDownload: true,
        statefulChat: false,
        mcp: false,
      },
    });
    runtimes.update('ollama', { health: 'healthy' });

    models.register({
      id: 'qwen2.5-coder:7b',
      name: 'Qwen 2.5 Coder 7B',
      provider: 'ollama',
      family: 'qwen',
      contextMax: 32768,
      capabilities: ['generalChat', 'coding', 'debugging', 'review'],
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
    models.upsertInstallation({
      id: 'qwen2.5-coder:7b::local::ollama',
      modelId: 'qwen2.5-coder:7b',
      computerId: 'local',
      runtimeId: 'ollama',
      runtimeModelId: 'qwen2.5-coder:7b',
      installed: true,
    });
    models.upsertInstance({
      id: 'qwen2.5-coder:7b::local::ollama',
      modelId: 'qwen2.5-coder:7b',
      computerId: 'local',
      runtimeId: 'ollama',
      runtimeModelId: 'qwen2.5-coder:7b',
      loaded: true,
      state: 'READY',
      health: 'healthy',
      contextTokens: 32768,
    });
  }

  if (options.includeAnthropicModel) {
    runtimes.register({
      id: 'anthropic',
      type: 'anthropic',
      name: 'Anthropic',
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
    runtimes.update('anthropic', { health: 'healthy' });
    models.register({
      id: 'claude-sonnet-4-5',
      name: 'Claude Sonnet 4.5',
      provider: 'anthropic',
      family: 'other',
      contextMax: 200000,
      capabilities: ['generalChat', 'coding', 'reasoning', 'vision'],
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      audio: false,
      embedding: false,
      reasoning: true,
      runtimeCompatibility: ['anthropic'],
      local: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    models.upsertInstallation({
      id: 'claude-sonnet-4-5::hosted::anthropic',
      modelId: 'claude-sonnet-4-5',
      runtimeId: 'anthropic',
      runtimeModelId: 'claude-sonnet-4-5',
      installed: true,
    });
    models.upsertInstance({
      id: 'claude-sonnet-4-5::hosted::anthropic',
      modelId: 'claude-sonnet-4-5',
      runtimeId: 'anthropic',
      runtimeModelId: 'claude-sonnet-4-5',
      loaded: true,
      state: 'READY',
      health: 'healthy',
      contextTokens: 200000,
    });
  }

  const nvidiaAdapter = new NvidiaAdapter({
    secrets: secretBroker,
    env: options.apiKey ? { NVIDIA_API_KEY: options.apiKey } : {},
    defaultModel: config.providers?.nvidia?.defaultModel,
    fetch: options.fetchImpl ?? globalThis.fetch,
  });

  const hostedAdapters = createHostedProviders(config, secretBroker);
  hostedAdapters.set('nvidia', nvidiaAdapter);

  for (const [id, adapter] of hostedAdapters) {
    if (options.includeAnthropicModel && id === 'anthropic') continue;
    await applyHostedProvider(id, adapter, {
      runtimes,
      models,
      config,
    });
  }

  agents.register(createCodingAgent(), 'native');
  if (options.includeExternalAgent) {
    agents.register(
      {
        descriptor: {
          name: 'claude-code',
          version: '1.0.0',
          description: 'External Claude Code CLI agent',
          strategy: 'external',
          capabilities: ['coding', 'generalChat'],
          taskTypes: [],
        },
        execute: async () => ({ success: true, output: 'external output', turns: 1 }),
      } as any,
      'external',
    );
  }

  const ledgerPath = ':memory:';
  const ledger = new ResourceLedger(ledgerPath);
  const accounts = new AccountRegistry();
  const nvidiaLimits = buildNvidiaHostedLimits(config.providers?.nvidia);
  accounts.addImplicit({
    localRuntimes: (options.includeLocalModel ?? true) ? ['ollama'] : [],
    hostedRuntimes: ['nvidia', 'anthropic', 'openai', 'google'],
    agents: options.includeExternalAgent ? ['claude-code'] : [],
    hostedAuthorized: hostedAuthorizedDefault,
    hostedConcurrency: {
      nvidia: (!Array.isArray(config.providers?.nvidia?.limits) ? config.providers?.nvidia?.limits?.maxConcurrentRequests : undefined) ?? 2,
    },
    hostedLimits: nvidiaLimits ? { nvidia: nvidiaLimits } : undefined,
    hostedPricing: config.providers?.nvidia?.pricing ? { nvidia: config.providers.nvidia.pricing } : undefined,
  });

  const resourcePolicy: ResourcePolicy = {
    ...DEFAULT_POLICY,
    mode: 'balanced',
    enforce: options.enforceBudget ?? Boolean(nvidiaLimits && nvidiaLimits.length > 0),
    paidApiFallback: true,
  };
  const budget = new TokenBudgetManager(ledger, accounts, resourcePolicy);
  const resolveAccount = (runtimeId: string, modelId: string) => accounts.candidates({ runtimeId, modelId })[0]?.id;
  const resolveAgentAccount = (agent: string) => accounts.candidates({ agent })[0]?.id;
  const router = new ResourceRouter({ budget, resolveAccount });

  const governedNvidiaAdapter = governAdapter(nvidiaAdapter, { budget, resolveAccount });

  const policy = new PolicyEngine({
    projectRoot: options.projectRoot,
    networkAllowed: false,
    allowHostedProvidersDefault: hostedAuthorizedDefault,
  });
  const scheduler = new Scheduler({
    computers,
    runtimes,
    models,
    agents,
    policy,
    resources: { router },
    routing: config.routing,
  });
  const adapters = new Map<string, any>([['nvidia', governedNvidiaAdapter]]);
  const lifecycle = new ModelLifecycleService({
    models,
    runtimes,
    computers,
    agents,
    adapters,
    policy,
    executions,
  });
  const jobManager = new JobManager();
  await jobManager.ready;
  const worktrees = new WorktreeManager();
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
  const planner = createTaskPlanner();

  return {
    config,
    projectRoot: options.projectRoot,
    configDir: options.projectRoot,
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
    orchestrator,
    worktrees,
    planner,
    resources: {
      accounts,
      ledger,
      budget,
      router,
      policy: resourcePolicy,
      configPath: path.join(options.projectRoot, 'resources.json'),
      ledgerPath,
      configuredIds: new Set<string>(),
      resolveAccount,
      resolveAgentAccount,
    },
    worker: {
      id: 'worker-local',
      computerId: 'local',
      name: 'local',
      info: { status: 'online', runtimes: [], models: [] },
      adapterForModel: (modelId: string) => {
        const m = models.get(modelId);
        return m ? adapters.get(m.provider) : undefined;
      },
    },
    discovered: [],
    adapters,
    hostedAdapters,
    secretBroker,
  } as unknown as RookEngine;
}

describe('NVIDIA System-Wide Execution Provider Integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-nvidia-sys-proj-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('15. registers hosted NVIDIA installations so `wa models list` and ModelLifecycleService discover them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: NVIDIA_DEFAULT_MODEL_ID, object: 'model' }],
        }),
        { status: 200 },
      ),
    );

    const engine = await createNvidiaTestEngine({
      projectRoot: tmpDir,
      apiKey: MOCK_NVAPI_KEY,
      allowHostedProviders: true,
      includeLocalModel: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const modelsOut = listModels(engine, { json: true });
    const parsed = JSON.parse(modelsOut);
    const nvModel = parsed.find((m: any) => m.id === NVIDIA_DEFAULT_MODEL_ID);
    expect(nvModel).toBeDefined();
    expect(nvModel.provider).toBe('nvidia');
    expect(nvModel.instances?.some((i: any) => i.state === 'READY')).toBe(true);

    // Dynamic custom NVIDIA model registration works on-the-fly
    const registered = ensureNvidiaModelRegistered(
      engine.models,
      engine.runtimes,
      engine.config,
      'nvidia/custom-nemotron-90b-instruct',
    );
    expect(registered).toBe(true);
    expect(engine.models.get('nvidia/custom-nemotron-90b-instruct')?.provider).toBe('nvidia');
    expect(
      engine.models.listInstallations().filter((i) => i.modelId === 'nvidia/custom-nemotron-90b-instruct'),
    ).toHaveLength(1);
  });

  it('16. Scheduler selects NVIDIA model under routingMode NVIDIA, HYBRID, and AUTO and records HOSTED_API_INFERENCE placement', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: NVIDIA_DEFAULT_MODEL_ID, object: 'model' }],
        }),
        { status: 200 },
      ),
    );

    const engine = await createNvidiaTestEngine({
      projectRoot: tmpDir,
      apiKey: MOCK_NVAPI_KEY,
      allowHostedProviders: true,
      includeLocalModel: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    // 1. Explicit NVIDIA routingMode selects NVIDIA model even when local model exists
    const nvidiaTask: Task = {
      id: 'task-nvidia-mode',
      type: 'coding',
      input: 'Refactor module with complex multimodal reasoning',
      requirements: { capabilities: ['coding'] },
      execution: { routingMode: 'NVIDIA' },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    const decisionNvidia = engine.scheduler.plan({ task: nvidiaTask });
    expect(decisionNvidia.runtimeId).toBe('nvidia');
    expect(decisionNvidia.modelId).toBe(NVIDIA_DEFAULT_MODEL_ID);
    expect(decisionNvidia.computerId).toBeUndefined();
    expect(decisionNvidia.resourceType).toBe('HOSTED_API_INFERENCE');
    expect(decisionNvidia.computerDecision.placementKind).toBe('hosted');
    expect(decisionNvidia.computerDecision.resourceType).toBe('HOSTED_API_INFERENCE');

    // 2. Vision + reasoning task under AUTO selects NVIDIA Nemotron VL because local model lacks vision/reasoning
    const visionTask: Task = {
      id: 'task-vision-auto',
      type: 'coding',
      input: 'Analyze architecture diagram and fix bug',
      requirements: { capabilities: ['coding'], vision: true, reasoning: 'high' },
      execution: { routingMode: 'AUTO' },
      priority: 'high',
      status: 'pending',
      createdAt: new Date(),
    };
    const decisionVision = engine.scheduler.plan({ task: visionTask });
    expect(decisionVision.runtimeId).toBe('nvidia');
    expect(decisionVision.modelId).toBe(NVIDIA_DEFAULT_MODEL_ID);
    expect(decisionVision.resourceType).toBe('HOSTED_API_INFERENCE');

    // 3. Routine local task under AUTO prefers local GPU inference
    const localRoutineTask: Task = {
      id: 'task-local-auto',
      type: 'coding',
      input: 'Simple edit',
      requirements: { capabilities: ['coding'] },
      execution: { routingMode: 'AUTO' },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    const decisionLocal = engine.scheduler.plan({ task: localRoutineTask });
    expect(decisionLocal.runtimeId).toBe('ollama');
    expect(decisionLocal.computerId).toBe('local');
    expect(decisionLocal.resourceType).toBe('LOCAL_GPU_INFERENCE');
  });

  it('17. Local-only policy and sensitive data classification strictly reject NVIDIA even when routingMode is NVIDIA', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: NVIDIA_DEFAULT_MODEL_ID, object: 'model' }],
        }),
        { status: 200 },
      ),
    );

    const engine = await createNvidiaTestEngine({
      projectRoot: tmpDir,
      apiKey: MOCK_NVAPI_KEY,
      allowHostedProviders: true,
      includeLocalModel: false,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const localOnlyTask: Task = {
      id: 'task-local-only',
      type: 'coding',
      input: 'Secret local task',
      requirements: {},
      policy: { localOnly: true, allowHostedProviders: true },
      execution: { routingMode: 'NVIDIA' },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    expect(() => engine.scheduler.plan({ task: localOnlyTask })).toThrow(SchedulingError);

    const sensitiveTask: Task = {
      id: 'task-sensitive',
      type: 'coding',
      input: 'Process customer credentials',
      requirements: {},
      policy: { dataClassification: 'sensitive', allowHostedProviders: true },
      execution: { routingMode: 'NVIDIA' },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    expect(() => engine.scheduler.plan({ task: sensitiveTask })).toThrow(SchedulingError);

    const routingModeLocalTask: Task = {
      id: 'task-routing-mode-local',
      type: 'coding',
      input: 'Run locally only',
      requirements: {},
      policy: { allowHostedProviders: true },
      execution: { routingMode: 'LOCAL_ONLY' },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    expect(() => engine.scheduler.plan({ task: routingModeLocalTask })).toThrow(SchedulingError);
  });

  it('18. Enforces NVIDIA-only (`routing.mode = "provider_only"`) across ask, task plan, task run, child subagents, replanning, escalation, and blocks non-NVIDIA / external agent bypass', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/models')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                { id: NVIDIA_DEFAULT_MODEL_ID, object: 'model' },
                { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', object: 'model' },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      callCount += 1;
      return Promise.resolve(
        new Response(
          makeSseStream([
            { choices: [{ delta: { reasoning_content: `Turn ${callCount} reasoning.` } }] },
            {
              choices: [
                {
                  delta: { content: '{"action":"done","summary":"Completed strictly via NVIDIA provider_only mode"}' },
                  finish_reason: 'stop',
                },
              ],
            },
            { usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });

    const engine = await createNvidiaTestEngine({
      projectRoot: tmpDir,
      apiKey: MOCK_NVAPI_KEY,
      includeLocalModel: true,
      includeAnthropicModel: true,
      includeExternalAgent: true,
      routing: {
        mode: 'provider_only',
        provider: 'nvidia',
        defaultModel: NVIDIA_DEFAULT_MODEL_ID,
        allowFallback: true,
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    // 1. Validate routing config contract
    expect(engine.config.routing).toEqual({
      mode: 'provider_only',
      provider: 'nvidia',
      defaultModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      allowFallback: true,
    });

    // 2. `wa ask` honors NVIDIA-only policy even when local Ollama and Anthropic are healthy
    let capturedStdout = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      capturedStdout += String(chunk);
      return true;
    });
    const askRes = await askCommand(engine, 'Explain NVIDIA routing', {});
    stdoutSpy.mockRestore();
    expect(askRes.code).toBe(0);
    expect(capturedStdout).toContain('Completed strictly via NVIDIA provider_only mode');

    // `wa ask` with a non-NVIDIA model pinned must fail closed
    const askNonNvidia = await askCommand(engine, 'Try local model', { model: 'qwen2.5-coder:7b' });
    expect(askNonNvidia.code).not.toBe(0);
    expect(askNonNvidia.output).toMatch(/provider-only|violates/i);

    // 3. `wa task plan` honors NVIDIA-only policy and selects defaultModel
    const planRes = await planTaskCommand(engine, 'Implement feature X', { json: true });
    expect(planRes.code, planRes.output).toBe(0);
    const planJson = JSON.parse(planRes.output);
    expect(planJson.scheduling.runtimeId).toBe('nvidia');
    expect(planJson.scheduling.modelId).toBe(NVIDIA_DEFAULT_MODEL_ID);

    // 4. Explicit pinning of non-NVIDIA model (Ollama or Anthropic) is rejected by Scheduler
    const pinnedOllamaTask: Task = {
      id: 'task-pinned-ollama',
      type: 'coding',
      input: 'Bypass attempt to ollama',
      requirements: {},
      execution: { targetModelId: 'qwen2.5-coder:7b' },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    expect(() => engine.scheduler.plan({ task: pinnedOllamaTask })).toThrow(/provider_only/);

    const pinnedAnthropicTask: Task = {
      id: 'task-pinned-anthropic',
      type: 'coding',
      input: 'Bypass attempt to anthropic',
      requirements: {},
      execution: { targetModelId: 'claude-sonnet-4-5' },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    expect(() => engine.scheduler.plan({ task: pinnedAnthropicTask })).toThrow(/provider_only/);

    // 5. External delegated agent (`source === 'external'`) is rejected under NVIDIA-only mode
    const externalAgentTask: Task = {
      id: 'task-external-agent',
      type: 'coding',
      input: 'Bypass attempt via external CLI agent',
      requirements: {},
      execution: { targetAgentId: 'claude-code' },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    expect(() => engine.scheduler.plan({ task: externalAgentTask })).toThrow(/External delegated agent.*provider_only/);

    const runExtRes = await runTaskCommand(engine, 'Run external agent', { agent: 'claude-code', force: true });
    expect(runExtRes.code).not.toBe(0);
    expect(runExtRes.output).toMatch(/provider-only|external/i);

    // 6. Escalation (`planEscalation`) stays within NVIDIA models and never switches to Anthropic or Ollama
    const baseTask: Task = {
      id: 'task-escalate',
      type: 'coding',
      input: 'Complex task needing escalation',
      requirements: { capabilities: ['coding'] },
      priority: 'high',
      status: 'pending',
      createdAt: new Date(),
    };
    const escalated = planEscalation(engine.scheduler, {
      task: baseTask,
      placement: { runtimeId: 'nvidia' },
      request: {
        currentModelId: NVIDIA_DEFAULT_MODEL_ID,
        triedModelIds: [NVIDIA_DEFAULT_MODEL_ID],
        failureClass: 'PROTOCOL_FAILURE',
        reason: 'retry escalation',
      },
    });
    expect(escalated.scheduling).toBeDefined();
    expect(escalated.scheduling?.runtimeId).toBe('nvidia');
    expect(escalated.scheduling?.modelId).toBe('nvidia/llama-3.1-nemotron-ultra-253b-v1');

    // 7. JobManager child tasks and FleetTaskExecutor (`wa chat` / `wa fleet` shared engine) preserve NVIDIA-only policy
    const job = await engine.orchestrator.createJob({
      title: 'Build and verify feature across parent and child tasks',
      tasks: [
        {
          task: {
            title: 'Parent implementation task',
            input: 'Write implementation',
            type: 'coding',
            mutationRequired: false,
          },
        },
      ],
    });
    const parentTask = job.tasks[0];
    const [childTask] = await engine.orchestrator.getJobManager().addTasksToJob(job.id, [
      {
        task: {
          title: 'Child verification task',
          input: 'Verify implementation',
          type: 'coding',
        },
        dependencies: [parentTask.id],
      },
    ]);

    const fleetExecutor = createFleetTaskExecutor(engine, { useWorktrees: false });
    const parentDecision = engine.scheduler.plan({ task: parentTask });
    expect(parentDecision.runtimeId).toBe('nvidia');
    expect(parentDecision.modelId).toBe(NVIDIA_DEFAULT_MODEL_ID);

    const parentOutcome = await fleetExecutor(parentTask, {
      job,
      node: job.graph.nodes[0],
      attempt: 1,
      signal: new AbortController().signal,
      jobId: job.id,
      taskId: parentTask.id,
      assignment: {
        agentId: parentDecision.agentId ?? 'wazir-coding',
        modelId: parentDecision.modelId,
        runtimeId: parentDecision.runtimeId,
        computerId: parentDecision.computerId,
      },
      worktreeDir: tmpDir,
    } as any);
    expect(parentOutcome.success).toBe(true);

    const childDecision = engine.scheduler.plan({ task: childTask });
    expect(childDecision.runtimeId).toBe('nvidia');
    expect(childDecision.modelId).toBe(NVIDIA_DEFAULT_MODEL_ID);
  });

  it('19. Fails closed with a clear reason when NVIDIA-only mode is enabled but no NVIDIA model is eligible', async () => {
    const engine = await createNvidiaTestEngine({
      projectRoot: tmpDir,
      apiKey: undefined, // Unauthenticated NVIDIA provider!
      includeLocalModel: true, // Healthy local model exists, but allowFallback is false
      routing: {
        mode: 'provider_only',
        provider: 'nvidia',
        defaultModel: NVIDIA_DEFAULT_MODEL_ID,
        allowFallback: false,
      },
    });

    const askRes = await askCommand(engine, 'Should fail closed', {});
    expect(askRes.code).not.toBe(0);
    expect(askRes.output).toMatch(/provider-only|no healthy|nvidia/i);

    const runRes = await runTaskCommand(engine, 'Should fail closed', {});
    expect(runRes.code).not.toBe(0);
    expect(runRes.output).toMatch(/provider_only|No model satisfies|nvidia/i);
  });

  it('20. Coding agent executes a multi-step tool task using NVIDIA hosted provider', async () => {
    let callTurn = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/models')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: [{ id: NVIDIA_DEFAULT_MODEL_ID, object: 'model' }] }),
            { status: 200 },
          ),
        );
      }
      callTurn += 1;
      if (callTurn === 1) {
        return Promise.resolve(
          new Response(
            makeSseStream([
              { choices: [{ delta: { reasoning_content: 'Establishing plan first.' } }] },
              {
                choices: [
                  {
                    delta: {
                      content: '{"action":"plan","content":"Create nvidia-verified.txt in workspace"}',
                    },
                    finish_reason: 'stop',
                  },
                ],
              },
              { usage: { prompt_tokens: 90, completion_tokens: 25, total_tokens: 115 } },
            ]),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      }
      if (callTurn === 2) {
        return Promise.resolve(
          new Response(
            makeSseStream([
              { choices: [{ delta: { reasoning_content: 'Now writing nvidia-verified.txt in implement phase.' } }] },
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_nv_write_1',
                          type: 'function',
                          function: {
                            name: 'write',
                            arguments: JSON.stringify({
                              path: 'nvidia-verified.txt',
                              content: 'Verified by NVIDIA Nemotron 3.5 Super VL\n',
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              },
              { usage: { prompt_tokens: 110, completion_tokens: 45, total_tokens: 155 } },
            ]),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          makeSseStream([
            { choices: [{ delta: { reasoning_content: 'File write succeeded. Summarizing result.' } }] },
            {
              choices: [
                {
                  delta: { content: '{"action":"done","summary":"Created nvidia-verified.txt via NVIDIA API Catalog"}' },
                  finish_reason: 'stop',
                },
              ],
            },
            { usage: { prompt_tokens: 160, completion_tokens: 30, total_tokens: 190 } },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });

    const engine = await createNvidiaTestEngine({
      projectRoot: tmpDir,
      apiKey: MOCK_NVAPI_KEY,
      allowHostedProviders: true,
      includeLocalModel: true,
      routing: {
        mode: 'provider_only',
        provider: 'nvidia',
        defaultModel: NVIDIA_DEFAULT_MODEL_ID,
        allowFallback: false,
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const outcome = await executeTask(engine, 'Create nvidia-verified.txt with verification text', {
      type: 'coding',
      quiet: true,
    });

    expect(outcome.success, [...outcome.reasons, ...outcome.errors].join('; ')).toBe(true);
    const execRec = await engine.executions.get(outcome.executionId);
    expect(execRec?.scheduling?.runtimeId).toBe('nvidia');
    expect(execRec?.scheduling?.modelId).toBe(NVIDIA_DEFAULT_MODEL_ID);
    expect(execRec?.scheduling?.resourceType).toBe('HOSTED_API_INFERENCE');

    const writtenContent = await fs.readFile(path.join(tmpDir, 'nvidia-verified.txt'), 'utf-8');
    expect(writtenContent).toBe('Verified by NVIDIA Nemotron 3.5 Super VL\n');
  });

  it('21. Resource accounting records token usage, requests, retries, latency, explicit unknown-cost vs configured pricing, and enforces quota exhaustion', async () => {
    let callTurn = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/models')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: [{ id: NVIDIA_DEFAULT_MODEL_ID, object: 'model' }] }),
            { status: 200 },
          ),
        );
      }
      callTurn += 1;
      if (callTurn === 1) {
        // Trigger 1 bounded retry on HTTP 503 (transient server error) first
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Temporary server overload' }), {
            status: 503,
            headers: { 'retry-after': '0' },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          makeSseStream([
            { choices: [{ delta: { content: 'Accounting test complete' }, finish_reason: 'stop' }] },
            { usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });

    // Part A: Unpriced NVIDIA configuration -> costKnown: false, costStatus: 'UNKNOWN'
    const unpricedEngine = await createNvidiaTestEngine({
      projectRoot: tmpDir,
      apiKey: MOCK_NVAPI_KEY,
      includeLocalModel: false,
      routing: {
        mode: 'provider_only',
        provider: 'nvidia',
        defaultModel: NVIDIA_DEFAULT_MODEL_ID,
        allowFallback: false,
      },
      nvidiaLimits: [{ window: 'day', unit: 'requests', limit: 2, thresholds: { advisory: 1.01, conserve: 1.01, critical: 1.01 }, source: 'configured' }],
      enforceBudget: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const firstRun = await askCommand(unpricedEngine, 'First request within quota', {});
    stdoutSpy.mockRestore();
    expect(firstRun.code, firstRun.output).toBe(0);

    const rows = unpricedEngine.resources.ledger.usageRows();
    expect(rows.length).toBe(1);
    expect(rows[0].accountId).toBe('api:nvidia');
    expect(rows[0].modelId).toBe(NVIDIA_DEFAULT_MODEL_ID);
    expect(rows[0].inputTokens).toBe(120);
    expect(rows[0].outputTokens).toBe(40);
    expect(rows[0].source).toBe('provider-reported');
    expect(rows[0].costKnown).toBe(false);
    expect(rows[0].costStatus).toBe('UNKNOWN');
    expect(rows[0].costUsd).toBe(0);

    // Retry event recorded in ResourceLedger
    const retryEvents = unpricedEngine.resources.ledger.events({ kind: 'provider_error' });
    expect(retryEvents.some((e) => e.accountId === 'api:nvidia' && e.data.retry === true)).toBe(true);

    // Snapshot explicitly reports unknown cost rather than faking a known $0.0000 bill
    const snap = await resourceSnapshot(unpricedEngine);
    const nvAccount = snap.accounts.find((a) => a.id === 'api:nvidia');
    expect(nvAccount?.usage24h.costKnown).toBe(false);
    expect(nvAccount?.usage24h.costStatus).toBe('UNKNOWN');
    expect(snap.economics.apiCostKnown).toBe(false);
    const rendered = renderResourceSnapshot(snap);
    expect(rendered).toContain('unknown (no pricing configured)');

    // Second request uses the remaining request in the 2-request daily limit
    const stdoutSpy2 = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const secondRun = await askCommand(unpricedEngine, 'Second request hitting limit', {});
    stdoutSpy2.mockRestore();
    expect(secondRun.code, secondRun.output).toBe(0);

    // Third request exceeds the 2-request daily limit and fails closed with quota exhaustion
    const thirdRun = await askCommand(unpricedEngine, 'Third request exceeding quota', {});
    expect(thirdRun.code).not.toBe(0);
    expect(thirdRun.output).toMatch(/exhausted|blocked|RESOURCE_ADMISSION/i);

    const thirdTaskRun = await executeTask(unpricedEngine, 'Third task run exceeding quota', {
      type: 'coding',
      quiet: true,
    });
    expect(thirdTaskRun.success).toBe(false);
    expect(thirdTaskRun.reasons.join(' ')).toMatch(/exhausted|blocked|No model satisfies|resource/i);

    // Part B: Configured pricing -> costKnown: true, accurate USD calculation
    const pricedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-nvidia-priced-'));
    try {
      const pricedEngine = await createNvidiaTestEngine({
        projectRoot: pricedDir,
        apiKey: MOCK_NVAPI_KEY,
        includeLocalModel: false,
        routing: {
          mode: 'provider_only',
          provider: 'nvidia',
          defaultModel: NVIDIA_DEFAULT_MODEL_ID,
          allowFallback: false,
        },
        nvidiaPricing: {
          inputPerMTok: 1.0,
          outputPerMTok: 2.0,
        },
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const pricedRes = await askCommand(pricedEngine, 'Calculate priced request', {});
      stdoutSpy.mockRestore();
      expect(pricedRes.code).toBe(0);

      const pricedRows = pricedEngine.resources.ledger.usageRows();
      expect(pricedRows).toHaveLength(1);
      expect(pricedRows[0].costKnown).toBe(true);
      expect(pricedRows[0].costStatus).toBe('ACTUAL');
      // 120 input tokens @ $1/MTok + 40 output tokens @ $2/MTok = 0.00012 + 0.00008 = 0.0002 USD
      expect(pricedRows[0].costUsd).toBeCloseTo(0.0002, 6);
    } finally {
      await fs.rm(pricedDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('22. CLI provider management (`wa providers list/inspect/test`) and benchmark recording work with NVIDIA', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/models')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: [{ id: NVIDIA_DEFAULT_MODEL_ID, object: 'model' }] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          makeSseStream([
            { choices: [{ delta: { reasoning_content: 'Checking palindrome logic.' } }] },
            { choices: [{ delta: { content: 'function isPalindrome(s) { return s === s.split("").reverse().join(""); }' }, finish_reason: 'stop' }] },
            { usage: { prompt_tokens: 35, completion_tokens: 25, total_tokens: 60 } },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });

    const engine = await createNvidiaTestEngine({
      projectRoot: tmpDir,
      apiKey: MOCK_NVAPI_KEY,
      allowHostedProviders: true,
      includeLocalModel: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const listOut = await listProvidersCommand(engine, { json: true });
    expect(listOut.code).toBe(0);
    const { providers } = JSON.parse(listOut.output);
    const nvidiaEntry = providers.find((p: any) => p.id === 'nvidia');
    expect(nvidiaEntry).toBeDefined();
    expect(nvidiaEntry.name).toBe('NVIDIA API Catalog');
    expect(nvidiaEntry.providerType).toBe('HOSTED_INFERENCE');
    expect(nvidiaEntry.authenticated).toBe(true);
    expect(nvidiaEntry.credentialSource).toBe('env');
    expect(listOut.output).not.toContain(MOCK_NVAPI_KEY);

    const inspectOut = await inspectProviderCommand(engine, 'nvidia', { json: true });
    expect(inspectOut.code).toBe(0);
    const inspected = JSON.parse(inspectOut.output);
    expect(inspected.id).toBe('nvidia');
    expect(inspected.defaultModel).toBe(NVIDIA_DEFAULT_MODEL_ID);
    expect(inspected.models).toContain(NVIDIA_DEFAULT_MODEL_ID);
    expect(inspectOut.output).not.toContain(MOCK_NVAPI_KEY);

    const testOut = await testProviderCommand(engine, 'nvidia', { json: true });
    expect(testOut.code).toBe(0);
    const tested = JSON.parse(testOut.output);
    expect(tested.ok).toBe(true);
    expect(tested.provider).toBe('nvidia');

    const benchOut = await runBenchmark(engine, NVIDIA_DEFAULT_MODEL_ID, 'Write a palindrome helper');
    expect(benchOut).toContain(`Benchmark: ${NVIDIA_DEFAULT_MODEL_ID}`);
    expect(benchOut).toContain('isPalindrome');
    expect(benchOut).toContain('input:       35 tokens');
    expect(benchOut).toContain('output:      25 tokens');
  });

  it('24. Distinguishes DGX-hosted local GPU execution from NVIDIA hosted API execution and prevents unauthorized fallback when local model is unavailable', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/models')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: [{ id: NVIDIA_DEFAULT_MODEL_ID, object: 'model' }] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          makeSseStream([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });

    // Part A: Policy does NOT allow hosted providers (`allowHostedProviders: false`), local model is unavailable.
    // Scheduler and `askCommand` must NEVER silently fall back to NVIDIA hosted inference.
    const defaultPolicyEngine = await createNvidiaTestEngine({
      projectRoot: tmpDir,
      apiKey: MOCK_NVAPI_KEY,
      allowHostedProviders: false,
      includeLocalModel: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    // Mark the local computer offline so the local model cannot be scheduled
    defaultPolicyEngine.computers.setOffline('local');

    expect(() =>
      defaultPolicyEngine.scheduler.plan({
        task: {
          id: 'task-no-unauthorized-fallback',
          title: 'Local unavailable test',
          description: 'Must not fall back to hosted NVIDIA when policy forbids hosted inference',
          type: 'coding',
          status: 'pending',
          priority: 'normal',
          requirements: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    ).toThrow(/allowHostedProviders|No model|No computer/i);

    const askRefused = await askCommand(
      defaultPolicyEngine,
      'Try NVIDIA without allowHosted',
      { model: NVIDIA_DEFAULT_MODEL_ID },
    );
    expect(askRefused.code).not.toBe(0);
    expect(askRefused.output).toMatch(/refused|allow-hosted|allowHostedProviders/i);

    // Part B: Explainable placement decisions distinguish DGX-hosted local execution (`LOCAL_GPU_INFERENCE` with `computerId: 'dgx-spark-01'`)
    // from NVIDIA hosted execution (`HOSTED_API_INFERENCE` with `computerId: undefined` and `runtimeId: 'nvidia'`).
    const dualEngine = await createNvidiaTestEngine({
      projectRoot: tmpDir,
      apiKey: MOCK_NVAPI_KEY,
      allowHostedProviders: true,
      includeLocalModel: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    dualEngine.computers.register({
      id: 'dgx-spark-01',
      name: 'NVIDIA DGX Spark Local Node',
      type: 'workstation',
      local: true,
      os: { platform: 'linux', architecture: 'arm64', version: '6.8' },
      hardware: {
        cpu: 'Grace Blackwell GB10',
        cpuCores: 20,
        memoryGB: 128,
        gpu: {
          vendor: 'nvidia',
          model: 'NVIDIA GB10 Grace Blackwell',
          memoryGB: 128,
          cuda: true,
          unifiedMemory: true,
        },
      },
      capabilities: ['localExecution', 'gpuInference'],
    });
    dualEngine.models.upsertInstance({
      id: 'qwen2.5-coder:7b::dgx-spark-01::ollama',
      modelId: 'qwen2.5-coder:7b',
      computerId: 'dgx-spark-01',
      runtimeId: 'ollama',
      runtimeModelId: 'qwen2.5-coder:7b',
      loaded: true,
      state: 'READY',
      health: 'healthy',
      contextTokens: 32768,
    });

    const dgxDecision = dualEngine.scheduler.plan({
      task: {
        id: 'task-dgx-local',
        title: 'Run on DGX local GPU',
        description: 'Execute on local DGX CUDA node',
        type: 'coding',
        status: 'pending',
        priority: 'normal',
        requirements: { requiresCuda: true },
        execution: { targetModelId: 'qwen2.5-coder:7b', targetComputerId: 'dgx-spark-01' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    expect(dgxDecision.computerDecision.placementKind).toBe('local');
    expect(dgxDecision.resourceType).toBe('LOCAL_GPU_INFERENCE');
    expect(dgxDecision.computerId).toBe('dgx-spark-01');
    expect(dgxDecision.runtimeId).toBe('ollama');

    const nvidiaHostedDecision = dualEngine.scheduler.plan({
      task: {
        id: 'task-nvidia-hosted',
        title: 'Run on NVIDIA Hosted API Catalog',
        description: 'Execute on hosted NVIDIA NIM endpoint',
        type: 'coding',
        status: 'pending',
        priority: 'normal',
        requirements: {},
        execution: { routingMode: 'NVIDIA' },
        policy: { allowHostedProviders: true },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    expect(nvidiaHostedDecision.computerDecision.placementKind).toBe('hosted');
    expect(nvidiaHostedDecision.resourceType).toBe('HOSTED_API_INFERENCE');
    expect(nvidiaHostedDecision.computerId).toBeUndefined();
    expect(nvidiaHostedDecision.runtimeId).toBe('nvidia');
    expect(nvidiaHostedDecision.modelId).toBe(NVIDIA_DEFAULT_MODEL_ID);
    expect(nvidiaHostedDecision.reasons.join(' ')).toContain("hosted provider 'nvidia' authenticated and eligible");
  });

  // 23. Opt-in Live Smoke Test when NVIDIA_API_KEY is present in the environment
  describe.runIf(Boolean(process.env.NVIDIA_API_KEY && process.env.WAZIR_LIVE_NVIDIA_SMOKE === '1'))(
    '23. Opt-in Live NVIDIA API Catalog Smoke Test',
    () => {
      it('connects to https://integrate.api.nvidia.com/v1 and runs a live prompt on nvidia/nemotron-3.5-super-vl-120b-a12b', async () => {
        const adapter = new NvidiaAdapter({
          env: process.env,
        });
        const health = await adapter.healthCheck();
        expect(['healthy', 'degraded']).toContain(health.status);

        const events: any[] = [];
        for await (const ev of adapter.generate({
          modelId: NVIDIA_DEFAULT_MODEL_ID,
          maxTokens: 64,
          messages: [{ role: 'user', content: 'Reply with the single word READY.' }],
        })) {
          events.push(ev);
        }
        expect(events.some((e) => e.type === 'completed')).toBe(true);
      }, 30_000);
    },
  );
});

