import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  ModelLifecycleService,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  SchedulingError,
  type Task,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import { createSecretBroker } from '@wazir/secrets';
import {
  NVIDIA_DEFAULT_MODEL_ID,
  NvidiaAdapter,
} from '@wazir/runtimes-nvidia';
import { applyHostedProvider, createHostedProviders } from '../src/hostedProviders.js';
import {
  listProviders,
  inspectProvider,
  testProvider,
  runBenchmark,
} from '../src/commands.js';
import { executeTask } from '../src/run.js';
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
  fetchImpl?: typeof fetch;
}): Promise<RookEngine> {
  const secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-nvidia-sys-secrets-'));
  const secretBroker = await createSecretBroker({ secretsDir });

  const config = {
    projectRoot: options.projectRoot,
    allowHostedProviders: options.allowHostedProviders ?? true,
    networkAllowed: false,
    allowCommands: [],
    denyCommands: [],
    allowedMcpServers: [],
    modelContext: {},
    modelCapabilities: {},
    providers: {
      nvidia: {
        enabled: true,
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiKeyEnv: 'NVIDIA_API_KEY',
        defaultModel: NVIDIA_DEFAULT_MODEL_ID,
        maxOutputTokens: 16384,
        discoverModels: true,
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
    hardware: { cpu: 'Apple M3 Max', cpuCores: 16, memoryGB: 64, gpus: [{ name: 'Apple M3 Max GPU', memoryGB: 48 }] },
    capabilities: ['localExecution'],
  });

  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();
  const executions = new ExecutionEngine();

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
      capabilities: ['generalChat', 'coding'],
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

  const nvidiaAdapter = new NvidiaAdapter({
    secrets: secretBroker,
    env: options.apiKey ? { NVIDIA_API_KEY: options.apiKey } : {},
    fetch: options.fetchImpl ?? globalThis.fetch,
  });

  const hostedAdapters = createHostedProviders(config as any, secretBroker);
  hostedAdapters.set('nvidia', nvidiaAdapter);

  for (const [id, adapter] of hostedAdapters) {
    await applyHostedProvider(id, adapter, {
      runtimes,
      models,
      config: config as any,
      localComputerId: 'local',
    });
  }

  agents.register(createCodingAgent(), 'native');

  const policy = new PolicyEngine({
    projectRoot: options.projectRoot,
    networkAllowed: false,
    allowHostedProvidersDefault: options.allowHostedProviders ?? true,
  });
  const scheduler = new Scheduler({ computers, runtimes, models, agents, policy });
  const adapters = new Map<string, any>([['nvidia', nvidiaAdapter]]);
  const lifecycle = new ModelLifecycleService({
    models,
    runtimes,
    computers,
    adapters,
  });

  return {
    config: config as any,
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
    workers: new Map(),
    discovered: [],
    adapters,
    hostedAdapters,
    secretBroker,
    localComputerId: 'local',
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

  it('15. Scheduler selects NVIDIA model under routingMode NVIDIA, HYBRID, and AUTO and records HOSTED_API_INFERENCE placement', async () => {
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

  it('16. Local-only policy and sensitive data classification strictly reject NVIDIA even when routingMode is NVIDIA', async () => {
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
      includeLocalModel: false, // Only NVIDIA models registered
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    // Case A: policy.localOnly = true must reject NVIDIA even with routingMode: 'NVIDIA' and allowHostedProviders: true
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

    // Case B: dataClassification = 'sensitive' must reject NVIDIA
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

    // Case C: routingMode = 'LOCAL_ONLY' must reject NVIDIA even when policy allows hosted providers
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

  it('17. Coding agent executes a multi-step tool task end-to-end using NVIDIA hosted provider', async () => {
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
        // Turn 1: Nemotron streams reasoning + native tool call to write a file
        return Promise.resolve(
          new Response(
            makeSseStream([
              { choices: [{ delta: { reasoning_content: 'Planning to create nvidia-verified.txt in workspace.' } }] },
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
      // Turn 2: Nemotron completes task after receiving tool observation
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
      includeLocalModel: false,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const outcome = await executeTask(engine, {
      input: 'Create nvidia-verified.txt with verification text',
      type: 'coding',
      allowHosted: true,
      routingMode: 'NVIDIA',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.decision.runtimeId).toBe('nvidia');
    expect(outcome.decision.modelId).toBe(NVIDIA_DEFAULT_MODEL_ID);
    expect(outcome.decision.resourceType).toBe('HOSTED_API_INFERENCE');

    const writtenContent = await fs.readFile(path.join(tmpDir, 'nvidia-verified.txt'), 'utf-8');
    expect(writtenContent).toBe('Verified by NVIDIA Nemotron 3.5 Super VL\n');
  });

  it('18. CLI provider management (`wa providers list/inspect/test`) and benchmark recording work with NVIDIA', async () => {
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

    // 1. wa providers list
    const listOut = await listProviders(engine, { json: true });
    expect(listOut.exitCode).toBe(0);
    const providers = JSON.parse(listOut.output);
    const nvidiaEntry = providers.find((p: any) => p.id === 'nvidia');
    expect(nvidiaEntry).toBeDefined();
    expect(nvidiaEntry.displayName).toBe('NVIDIA API Catalog');
    expect(nvidiaEntry.providerType).toBe('HOSTED_INFERENCE');
    expect(nvidiaEntry.authenticated).toBe(true);
    expect(nvidiaEntry.credentialSource).toBe('env');
    expect(listOut.output).not.toContain(MOCK_NVAPI_KEY);

    // 2. wa providers inspect nvidia
    const inspectOut = await inspectProvider(engine, 'nvidia', { json: true });
    expect(inspectOut.exitCode).toBe(0);
    const inspected = JSON.parse(inspectOut.output);
    expect(inspected.id).toBe('nvidia');
    expect(inspected.defaultModel).toBe(NVIDIA_DEFAULT_MODEL_ID);
    expect(inspected.models.some((m: any) => m.id === NVIDIA_DEFAULT_MODEL_ID)).toBe(true);
    expect(inspectOut.output).not.toContain(MOCK_NVAPI_KEY);

    // 3. wa providers test nvidia
    const testOut = await testProvider(engine, 'nvidia', { json: true });
    expect(testOut.exitCode).toBe(0);
    const tested = JSON.parse(testOut.output);
    expect(tested.ok).toBe(true);
    expect(tested.provider).toBe('nvidia');

    // 4. Benchmark recording against NVIDIA model
    const benchOut = await runBenchmark(engine, {
      models: [NVIDIA_DEFAULT_MODEL_ID],
      json: true,
    });
    expect(benchOut.exitCode).toBe(0);
    const benchReport = JSON.parse(benchOut.output);
    expect(benchReport.models).toContain(NVIDIA_DEFAULT_MODEL_ID);
    expect(benchReport.runs.length).toBeGreaterThan(0);
    expect(benchReport.runs.every((r: any) => r.modelId === NVIDIA_DEFAULT_MODEL_ID && r.passed === true)).toBe(true);
  });

  // 19. Opt-in Live Smoke Test when NVIDIA_API_KEY is present in the environment
  describe.runIf(Boolean(process.env.NVIDIA_API_KEY && process.env.WAZIR_LIVE_NVIDIA_SMOKE === '1'))(
    '19. Opt-in Live NVIDIA API Catalog Smoke Test',
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
