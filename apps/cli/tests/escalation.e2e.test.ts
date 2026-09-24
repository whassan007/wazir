import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry, ComputerRegistry, ContextCompiler, ExecutionEngine, ModelRegistry,
  ModelLifecycleService, PolicyEngine, RuntimeRegistry, Scheduler,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { executeTask } from '../src/run.js';
import type { RookEngine } from '../src/engine.js';

/**
 * Phase 14 end to end: a real engine (Scheduler, policy, tools, execution engine,
 * lifecycle service) where only model adapters are fake. The scheduled model fails its
 * protocol budget; the Scheduler picks a model on a DIFFERENT runtime, and generation
 * must really move there — optionally loading that model first — then complete.
 */
const CAPS = { chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false };

function adapter(id: string, replies: string[], calls: { generate: number; loads: string[] }, loadFails = false): RuntimeAdapter {
  let loaded = false;
  return {
    id, type: 'other',
    async discover() { return { id, name: id, version: '1' }; },
    async healthCheck() { return { status: 'healthy' }; },
    async listModels() { return []; },
    async getCapabilities() { return CAPS; },
    async probeModel() { return true; },
    // What admission control needs to estimate a load (see modelLifecycleAdmission tests).
    async estimateModelLoad() { return { totalMemoryBytes: 4 * 1024 ** 3, source: 'RUNTIME', confidence: 'high' }; },
    async loadModel(modelId: string) {
      calls.loads.push(modelId);
      if (loadFails) throw new Error('runtime failed to load model: out of device memory');
      loaded = true;
    },
    async inspectModel(modelId: string) { return { modelId, loaded: loaded || id === 'rt-a', effectiveContext: 32768 }; },
    async *generate() {
      const reply = replies[Math.min(calls.generate, replies.length - 1)];
      calls.generate += 1;
      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply, usage: { inputTokens: 5, outputTokens: 5 } };
    },
  } as RuntimeAdapter;
}

async function buildEngine(projectRoot: string, strongLoaded: boolean, strongLoadFails = false) {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const executions = new ExecutionEngine();
  computers.register({
    id: 'local', name: 'test', type: 'workstation', local: true,
    os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
    hardware: { cpu: 'cpu', cpuCores: 8, memoryGB: 64, gpu: { vendor: 'nvidia', model: 'gpu', memoryGB: 64, unifiedMemory: true } },
    capabilities: ['localExecution'],
  });
  computers.heartbeat('local', { load: { cpuPercent: 0, memoryUsedGB: 8, memoryAvailableGB: 56 } });
  for (const rt of ['rt-a', 'rt-b']) {
    runtimes.register({ id: rt, type: 'other', name: rt, version: '1', computerId: 'local', capabilities: CAPS });
    runtimes.update(rt, { health: 'healthy' });
  }
  for (const [id, rt, loaded] of [['a-weak', 'rt-a', true], ['b-strong', 'rt-b', strongLoaded]] as const) {
    models.register({
      id, name: id, provider: 'fake', family: 'other', contextMax: 32768, capabilities: ['generalChat', 'coding'],
      toolCalling: false, structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false,
      runtimeCompatibility: 'any', local: true, createdAt: new Date(), updatedAt: new Date(),
    });
    models.upsertInstance({
      id: `${id}::local::${rt}`, modelId: id, computerId: 'local', runtimeId: rt, runtimeModelId: id,
      loaded, state: loaded ? 'READY' : 'INSTALLED', health: 'healthy', contextTokens: 32768,
    });
  }
  agents.register(createCodingAgent(), 'native');
  const weak = { generate: 0, loads: [] as string[] };
  const strong = { generate: 0, loads: [] as string[] };
  const adapters = new Map<string, RuntimeAdapter>([
    ['rt-a', adapter('rt-a', ['{"action":"plan","content":"write it"}', 'I am still thinking about it in prose.'], weak)],
    ['rt-b', adapter('rt-b', ['{"action":"tool","tool":"write","input":{"path":"hello.txt","content":"from the strong model"}}', '{"action":"done","summary":"wrote hello.txt"}'], strong, strongLoadFails)],
  ]);
  const engine = {
    config: { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] },
    projectRoot,
    configDir: path.join(projectRoot, '.wazir'),
    lifecycle: new ModelLifecycleService({ models, runtimes, computers, executions, adapters }),
    computers, runtimes, models, agents,
    tools: new ToolRegistry(defaultTools),
    policy: new PolicyEngine({ projectRoot, networkAllowed: false }),
    scheduler: new Scheduler({ computers, runtimes, models, agents }),
    compiler: new ContextCompiler(),
    executions,
    adapters,
    discovered: [],
    worker: { id: 'worker-local', computerId: 'local', adapterForModel: () => undefined } as unknown as Worker,
  } as unknown as RookEngine;
  return { engine, weak, strong };
}

describe('mid-run model escalation with re-placement (e2e)', () => {
  let projectRoot: string;
  afterEach(async () => { if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined); });

  it('moves generation to another runtime and completes there', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-esc-e2e-'));
    const { engine, weak, strong } = await buildEngine(projectRoot, true);

    const outcome = await executeTask(engine, 'write a hello file', { quiet: true });

    expect(outcome.success).toBe(true);
    expect(await fs.readFile(path.join(projectRoot, 'hello.txt'), 'utf8')).toBe('from the strong model');
    expect(weak.generate).toBeGreaterThanOrEqual(4); // plan + 3 unparseable replies
    expect(strong.generate).toBe(2);
    const events = await engine.executions.events(outcome.executionId);
    const change = events.find((e) => e.eventType === 'model.route.changed');
    expect(change?.data).toMatchObject({ previousModel: 'a-weak', newModel: 'b-strong', accepted: true, runtimeId: 'rt-b', computerId: 'local', failureClass: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED' });
    const termination = events.find((e) => e.eventType === 'termination.completed');
    expect(termination?.data).toMatchObject({ reason: 'VERIFICATION_PASSED', modelId: 'b-strong' });
  });

  it('loads an unloaded replacement through the lifecycle service before switching', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-esc-e2e-'));
    const { engine, strong } = await buildEngine(projectRoot, false);

    const outcome = await executeTask(engine, 'write a hello file', { quiet: true });
    const events = await engine.executions.events(outcome.executionId);
    const change = events.find((e) => e.eventType === 'model.route.changed')?.data as { accepted: boolean; routeDecision: string };

    // Either the real lifecycle service admitted and loaded it and the run completed on
    // it, or it refused and the refusal is the recorded reason — never a silent switch.
    if (change.accepted) {
      expect(strong.loads).toEqual(['b-strong']);
      expect(change.routeDecision).toContain('must be loaded');
      expect(outcome.success).toBe(true);
    } else {
      throw new Error(`lifecycle refused the load in this harness: ${change.routeDecision}`);
    }
    expect(strong.generate).toBe(2);
    expect(await fs.readFile(path.join(projectRoot, 'hello.txt'), 'utf8')).toBe('from the strong model');
  });

  it('a load that fails declines the escalation, is recorded, and the run ends on the original reason', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-esc-e2e-'));
    const { engine, strong } = await buildEngine(projectRoot, false, true);

    const outcome = await executeTask(engine, 'write a hello file', { quiet: true });
    const events = await engine.executions.events(outcome.executionId);
    const change = events.find((e) => e.eventType === 'model.route.changed')?.data as { accepted: boolean; routeDecision: string };

    expect(change.accepted).toBe(false);
    expect(change.routeDecision).toContain("could not prepare 'b-strong'");
    expect(strong.generate).toBe(0);
    expect(outcome.success).toBe(false);
    expect(events.find((e) => e.eventType === 'termination.completed')?.data).toMatchObject({ reason: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED', modelId: 'a-weak' });
  });
});
