import { describe, it, expect, afterEach } from 'vitest';
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
  ModelLifecycleService,
  ModelRegistry,
  PolicyEngine,
  ResourceLedger,
  ResourceRouter,
  RuntimeRegistry,
  Scheduler,
  TokenBudgetManager,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { runSubagent, type SubagentRunContext } from '../src/run.js';
import type { RookEngine } from '../src/engine.js';

/**
 * Real end-to-end coverage for dispatch_subagent's fleet-aware placement path:
 * when the dispatch declares `requirements`/`requiredCapabilities`, the subtask is
 * placed by the real Scheduler (capability match + hardware placement) instead of
 * blindly inheriting the parent's model/computer — see run.ts's runSubagent(). This
 * builds a two-computer fleet (a local "fake" model with no vision support, and a
 * second "remote-1" computer whose model does support vision) so a vision requirement
 * genuinely has only one place it can be satisfied.
 */
async function buildFleetEngine(projectRoot: string): Promise<RookEngine> {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();

  const baseHardware = { cpu: 'test-cpu', cpuCores: 4, memoryGB: 16 };

  computers.register({
    id: 'local',
    name: 'local-computer',
    type: 'workstation',
    local: true,
    os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
    hardware: baseHardware,
    capabilities: ['localExecution'],
  });
  computers.register({
    id: 'remote-1',
    name: 'remote-fleet-computer',
    type: 'workstation',
    local: false,
    os: { platform: 'linux', architecture: 'x64', version: '1.0' },
    hardware: baseHardware,
    capabilities: ['localExecution'],
  });

  const runtimeCapabilities = {
    chat: true, streaming: true, toolCalling: false, structuredOutput: false,
    vision: false, embeddings: false, reasoning: false, modelLoad: false,
    modelUnload: false, modelDownload: false, statefulChat: false, mcp: false,
  };

  runtimes.register({ id: 'fake', type: 'other', name: 'fake-runtime', version: '1.0', computerId: 'local', capabilities: runtimeCapabilities });
  runtimes.update('fake', { health: 'healthy' });
  runtimes.register({ id: 'fake-remote', type: 'other', name: 'fake-remote-runtime', version: '1.0', computerId: 'remote-1', capabilities: runtimeCapabilities });
  runtimes.update('fake-remote', { health: 'healthy' });

  models.register({
    id: 'fake-model', name: 'fake-model', provider: 'fake', family: 'other', contextMax: 32_768,
    capabilities: ['generalChat', 'coding'], toolCalling: false, structuredOutput: false,
    vision: false, audio: false, embedding: false, reasoning: false, runtimeCompatibility: 'any',
    local: true, createdAt: new Date(), updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'fake-model::local::fake', modelId: 'fake-model', computerId: 'local', runtimeId: 'fake',
    runtimeModelId: 'fake-model', loaded: true, state: 'READY', health: 'healthy', contextTokens: 32_768,
  });

  models.register({
    id: 'vision-model', name: 'vision-model', provider: 'fake', family: 'other', contextMax: 32_768,
    capabilities: ['generalChat', 'coding'], toolCalling: false, structuredOutput: false,
    vision: true, audio: false, embedding: false, reasoning: false, runtimeCompatibility: 'any',
    local: true, createdAt: new Date(), updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'vision-model::remote-1::fake-remote', modelId: 'vision-model', computerId: 'remote-1', runtimeId: 'fake-remote',
    runtimeModelId: 'vision-model', loaded: true, state: 'READY', health: 'healthy', contextTokens: 32_768,
  });

  agents.register(createCodingAgent(), 'native');

  const policy = new PolicyEngine({ projectRoot, networkAllowed: false });
  const scheduler = new Scheduler({ computers, runtimes, models, agents, policy });

  const fakeAdapter: RuntimeAdapter = {
    id: 'fake',
    type: 'other',
    async inspectModel(modelId) { return { modelId, loaded: true, effectiveContext: 32768 }; },
    async probeModel() { return true; },
    async discover() { return { id: 'fake', name: 'fake', version: '1.0' }; },
    async healthCheck() { return { status: 'healthy' }; },
    async listModels() { return [{ id: 'fake-model', name: 'fake-model' }]; },
    async getCapabilities() { return runtimeCapabilities; },
    async *generate() {
      const reply = '{"action":"done","summary":"subagent finished"}';
      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply, usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };

  const executions = new ExecutionEngine();
  const fakeWorker = {
    id: 'worker-local',
    computerId: 'local',
    adapterForModel: (modelId: string) => (modelId === 'fake-model' ? fakeAdapter : undefined),
  } as unknown as Worker;

  return {
    config: { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] },
    projectRoot,
    configDir: path.join(projectRoot, '.wazir'),
    lifecycle: new ModelLifecycleService({ models, runtimes, computers, executions, adapters: new Map([['fake', fakeAdapter]]) }),
    computers,
    runtimes,
    models,
    agents,
    tools,
    policy,
    scheduler,
    compiler,
    executions,
    adapters: new Map([['fake', fakeAdapter]]),
    discovered: [],
    worker: fakeWorker,
  } as unknown as RookEngine;
}

function fakeLoader() {
  return { start: () => {}, stop: () => {}, setText: () => {}, clear: () => {} } as unknown as import('./../src/spinner.js').StatusLoader;
}

describe('dispatch_subagent — fleet-aware placement', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  async function makeContext(engine: RookEngine, parentExecutionId: string): Promise<SubagentRunContext> {
    return {
      parentExecutionId,
      parentTaskId: 'task-parent',
      projectRoot: engine.projectRoot,
      modelId: 'fake-model',
      runtimeId: 'fake',
      computerId: 'local',
      subagentDepth: 0,
      log: () => {},
      loader: fakeLoader(),
      emitJson: () => {},
      signal: undefined,
    };
  }

  it('without requirements, keeps the parent\'s model/computer — default behavior is unchanged', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-fleet-sub-'));
    const engine = await buildFleetEngine(projectRoot);
    const parent = await engine.executions.create({
      task: { id: 'task-parent', type: 'coding', input: 'parent', priority: 'normal', status: 'running', createdAt: new Date() } as any,
      agentId: 'wazir-coding', computerId: 'local', runtimeId: 'fake', modelId: 'fake-model',
    });

    const result = await runSubagent(engine, { description: 'do a small thing' }, await makeContext(engine, parent.execution.id));

    // The fake adapter never calls a tool, so Wazir's real "no code modifications"
    // verification gate correctly fails it (see executeTask.e2e.test.ts for that gate's
    // own coverage) — irrelevant to this test, which only checks *placement*.
    const childId = result.output.match(/execution ([^\s\]]+)/)?.[1];
    expect(childId).toBeTruthy();
    const child = engine.executions.require(childId!);
    expect(child.execution.modelId).toBe('fake-model');
    expect(child.execution.computerId).toBe('local');
    expect(child.scheduling).toBeUndefined();
  });

  it('with a vision requirement, places the subtask on the fleet machine that actually has vision support', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-fleet-sub-'));
    const engine = await buildFleetEngine(projectRoot);
    const parent = await engine.executions.create({
      task: { id: 'task-parent', type: 'coding', input: 'parent', priority: 'normal', status: 'running', createdAt: new Date() } as any,
      agentId: 'wazir-coding', computerId: 'local', runtimeId: 'fake', modelId: 'fake-model',
    });

    const result = await runSubagent(
      engine,
      { description: 'analyze a screenshot', requirements: { vision: true } },
      await makeContext(engine, parent.execution.id),
    );

    const childId = result.output.match(/execution ([^\s\]]+)/)?.[1];
    expect(childId).toBeTruthy();
    const child = engine.executions.require(childId!);

    // The Scheduler — not the parent's placement — picked the vision-capable model,
    // on the computer that actually hosts it, and recorded why (wa explain reads this).
    expect(child.execution.modelId).toBe('vision-model');
    expect(child.execution.computerId).toBe('remote-1');
    expect(child.scheduling).toBeDefined();
    expect(child.scheduling?.modelId).toBe('vision-model');

    // remote-1 isn't the local worker, and no control-plane API URL is configured in
    // this fixture, so generation correctly refuses instead of silently running locally
    // on the wrong model.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no control-plane API URL is configured');
  });

  it('an impossible requirement fails placement with a clear reason instead of silently falling back', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-fleet-sub-'));
    const engine = await buildFleetEngine(projectRoot);
    const parent = await engine.executions.create({
      task: { id: 'task-parent', type: 'coding', input: 'parent', priority: 'normal', status: 'running', createdAt: new Date() } as any,
      agentId: 'wazir-coding', computerId: 'local', runtimeId: 'fake', modelId: 'fake-model',
    });

    const result = await runSubagent(
      engine,
      { description: 'needs a monster GPU', requirements: { minimumGPUMemoryGB: 512 } },
      await makeContext(engine, parent.execution.id),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Subagent fleet placement failed');
  });

  it('enforces provider-only routing guardrails on both inherited and fleet-placed subagents', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-fleet-sub-'));
    const engine = await buildFleetEngine(projectRoot);
    const parent = await engine.executions.create({
      task: { id: 'task-parent', type: 'coding', input: 'parent', priority: 'normal', status: 'running', createdAt: new Date() } as any,
      agentId: 'wazir-coding', computerId: 'local', runtimeId: 'fake', modelId: 'fake-model',
    });

    const ctx = await makeContext(engine, parent.execution.id);
    ctx.parentExecution = { routingMode: 'NVIDIA', routingProvider: 'nvidia' };

    // 1. Inherited non-NVIDIA model is blocked by Guardrail 3
    const inherited = await runSubagent(engine, { description: 'inherited non-nvidia' }, ctx);
    expect(inherited.ok).toBe(false);
    expect(inherited.error).toMatch(/provider-only routing policy|instead of required provider 'nvidia'/i);

    // 2. Fleet placement requesting vision cannot select non-NVIDIA vision-model when parentExecution enforces NVIDIA
    const fleetPlaced = await runSubagent(
      engine,
      { description: 'analyze screenshot under provider-only', requirements: { vision: true } },
      ctx,
    );
    expect(fleetPlaced.ok).toBe(false);
    expect(fleetPlaced.error).toMatch(/Subagent fleet placement failed.*provider_only \(nvidia\)/i);
  });

  it('enforces hosted provider authorization and quota constraints during subagent fleet placement', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-fleet-sub-'));
    const engine = await buildFleetEngine(projectRoot);

    // Register a hosted NVIDIA vision model and remove vision from the remote local model
    const remoteVision = engine.models.get('vision-model')!;
    engine.models.register({ ...remoteVision, vision: false });

    engine.runtimes.register({
      id: 'nvidia',
      type: 'nvidia',
      name: 'NVIDIA Hosted',
      version: 'v1',
      runtimeKind: 'hosted',
      capabilities: {
        chat: true, streaming: true, toolCalling: true, structuredOutput: true,
        vision: true, embeddings: false, reasoning: true, modelLoad: false,
        modelUnload: false, modelDownload: false, statefulChat: false, mcp: false,
      },
    });
    engine.runtimes.update('nvidia', { health: 'healthy' });
    engine.models.register({
      id: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      name: 'Nemotron VL',
      provider: 'nvidia',
      family: 'nemotron',
      contextMax: 131072,
      capabilities: ['generalChat', 'coding', 'vision'],
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      audio: false,
      embedding: false,
      reasoning: true,
      runtimeCompatibility: ['nvidia'],
      local: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    engine.models.upsertInstance({
      id: 'nvidia/nemotron-3.5-super-vl-120b-a12b::hosted::nvidia',
      modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      runtimeId: 'nvidia',
      runtimeModelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      loaded: true,
      state: 'READY',
      health: 'healthy',
      contextTokens: 131072,
    });

    const parent = await engine.executions.create({
      task: { id: 'task-parent', type: 'coding', input: 'parent', priority: 'normal', status: 'running', createdAt: new Date() } as any,
      agentId: 'wazir-coding', computerId: 'local', runtimeId: 'fake', modelId: 'fake-model',
    });

    // Part A: Hosted provider unauthorized (allowHostedProviders: false) -> rejects hosted vision placement
    const ctxUnauth = await makeContext(engine, parent.execution.id);
    ctxUnauth.parentPolicy = { allowHostedProviders: false };
    const unauthResult = await runSubagent(
      engine,
      { description: 'analyze screenshot without hosted auth', requirements: { vision: true } },
      ctxUnauth,
    );
    expect(unauthResult.ok).toBe(false);
    expect(unauthResult.error).toMatch(/Subagent fleet placement failed.*allowHostedProviders/i);

    // Part B: Hosted provider authorized, but quota is exhausted -> rejects placement due to quota constraint
    const ledger = new ResourceLedger(':memory:');
    const accounts = new AccountRegistry([
      {
        id: 'api:nvidia',
        label: 'NVIDIA API',
        provider: 'nvidia',
        kind: 'api',
        integration: 'api_key',
        runtimeIds: ['nvidia'],
        allowPaid: true,
        limits: [{ window: 'day', unit: 'requests', limit: 1, source: 'configured', thresholds: { advisory: 1.01, conserve: 1.01, critical: 1.01 } }],
      },
    ]);
    const budget = new TokenBudgetManager(ledger, accounts, { ...DEFAULT_POLICY, enforce: true, paidApiFallback: true });
    // Consume the 1 allowed request in the daily quota
    const adm = budget.admit({
      requestId: 'req-exhaust-1',
      accountId: 'api:nvidia',
      modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      workload: 'coding',
      requests: 1,
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
    });
    expect(adm.outcome).toBe('admitted');
    budget.reconcile('req-exhaust-1', { inputTokens: 100, outputTokens: 100, source: 'provider-reported' });

    const router = new ResourceRouter({
      budget,
      resolveAccount: (runtimeId) => (runtimeId === 'nvidia' ? 'api:nvidia' : undefined),
    });
    (engine as any).scheduler = new Scheduler({
      computers: engine.computers,
      runtimes: engine.runtimes,
      models: engine.models,
      agents: engine.agents,
      policy: engine.policy,
      resources: { router },
    });

    const ctxQuota = await makeContext(engine, parent.execution.id);
    ctxQuota.parentPolicy = { allowHostedProviders: true };
    const quotaResult = await runSubagent(
      engine,
      { description: 'analyze screenshot when quota exhausted', requirements: { vision: true } },
      ctxQuota,
    );
    expect(quotaResult.ok).toBe(false);
    expect(quotaResult.error).toMatch(/Subagent fleet placement failed.*resource:.*requests limit 1\/day.*would be exceeded/i);
  });
});
