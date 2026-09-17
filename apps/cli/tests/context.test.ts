import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry,
  ComputerRegistry,
  ContextCompiler,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import { JsonFileStore, MemoryStore } from '@wazir/shared';
import type { RookEngine } from '../src/engine.js';
import { planTask } from '../src/run.js';
import {
  createBlock,
  getActiveContext,
  addContextBlock,
  removeContextBlock,
  clearContext,
} from '../src/blocks.js';
import {
  addContext,
  removeContext,
  listContext,
  clearContextCommand,
  buildContextPartsFromActive,
} from '../src/commands.js';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wazir-context-test-'));
}

/**
 * getActiveContext/addContextBlock/etc. only touch `engine.store`, same as
 * blocks.ts's other functions — no need for a full RookEngine.
 */
function fakeEngine(store: JsonFileStore | MemoryStore): RookEngine {
  return { store } as unknown as RookEngine;
}

/**
 * planTask() additionally needs policy/tools/compiler/scheduler/models/agents
 * to be real (it does a genuine policy check + context budget + scheduling
 * decision, "no side effects" per its own doc comment) — but never touches
 * engine.worker/executions/approvalQueue/orchestrator, so those are omitted
 * here rather than faked, matching how little planTask actually needs.
 */
async function buildPlanTaskEngine(projectRoot: string, store: JsonFileStore | MemoryStore): Promise<RookEngine> {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();

  computers.register({
    id: 'local',
    name: 'test-computer',
    type: 'workstation',
    local: true,
    os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
    hardware: { cpu: 'test-cpu', cpuCores: 4, memoryGB: 16 },
    capabilities: ['localExecution'],
  });
  runtimes.register({
    id: 'fake',
    type: 'other',
    name: 'fake-runtime',
    version: '1.0',
    computerId: 'local',
    capabilities: {
      chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false,
      embeddings: false, reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false,
      statefulChat: false, mcp: false,
    },
  });
  models.register({
    id: 'fake-model',
    name: 'fake-model',
    provider: 'fake',
    family: 'other',
    contextMax: 32_768,
    capabilities: ['generalChat', 'coding'],
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
  models.upsertInstance({
    id: 'fake-model::local::fake',
    modelId: 'fake-model',
    computerId: 'local',
    runtimeId: 'fake',
    runtimeModelId: 'fake-model',
    loaded: true,
    health: 'healthy',
    contextTokens: 32_768,
  });
  agents.register(createCodingAgent(), 'native');

  const policy = new PolicyEngine({ projectRoot, networkAllowed: false });
  const scheduler = new Scheduler({ computers, runtimes, models, agents });

  return {
    config: { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] },
    projectRoot,
    computers,
    runtimes,
    models,
    agents,
    tools,
    policy,
    scheduler,
    compiler,
    store,
  } as unknown as RookEngine;
}

describe('active context persistence (getActiveContext/addContextBlock/removeContextBlock/clearContext)', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('round-trips add/remove through a fresh store instance', async () => {
    dir = await tempDir();
    const file = path.join(dir, 'wazir.json');
    const engine = fakeEngine(new JsonFileStore(file));

    expect(await getActiveContext(engine)).toEqual([]);

    await addContextBlock(engine, '1');
    await addContextBlock(engine, '2');

    const reopened = fakeEngine(new JsonFileStore(file));
    expect(await getActiveContext(reopened)).toEqual(['1', '2']);

    await removeContextBlock(fakeEngine(new JsonFileStore(file)), '1');
    expect(await getActiveContext(fakeEngine(new JsonFileStore(file)))).toEqual(['2']);
  });

  it('addContextBlock is idempotent — adding the same id twice does not duplicate it', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));

    await addContextBlock(engine, '5');
    await addContextBlock(engine, '5');

    expect(await getActiveContext(engine)).toEqual(['5']);
  });

  it('clearContext empties the active list', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));

    await addContextBlock(engine, '1');
    await addContextBlock(engine, '2');
    await clearContext(engine);

    expect(await getActiveContext(engine)).toEqual([]);
  });
});

describe('wa context CLI commands', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('addContext refuses a nonexistent block id and does not add a dangling reference', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));

    const result = await addContext(engine, 'does-not-exist');
    expect(result.code).not.toBe(0);
    expect(await getActiveContext(engine)).toEqual([]);
  });

  it('addContext succeeds for a real block, and it shows up in listContext', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));

    const { block, finish } = await createBlock(engine, 'doctor');
    await finish('success', { stdout: 'all checks passed' });

    const added = await addContext(engine, block.id);
    expect(added.code).toBe(0);

    const listed = await listContext(engine);
    expect(listed.output).toContain(block.id);
    expect(listed.output).toContain('doctor');
  });

  it('removeContext reports clearly when the id was never in context', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));
    const result = await removeContext(engine, '999');
    expect(result.code).not.toBe(0);
  });

  it('clearContextCommand empties context added via the CLI layer', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));

    const { block, finish } = await createBlock(engine, 'doctor');
    await finish('success', { stdout: 'ok' });
    await addContext(engine, block.id);

    await clearContextCommand(engine);
    expect(await getActiveContext(engine)).toEqual([]);
  });
});

describe('buildContextPartsFromActive', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('produces one retrieved/optional ContextPart per active block, using its stdout as content', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));

    const { block, finish } = await createBlock(engine, 'doctor');
    await finish('success', { stdout: 'doctor output here' });
    await addContextBlock(engine, block.id);

    const parts = await buildContextPartsFromActive(engine);
    expect(parts.length).toBe(1);
    expect(parts[0].kind).toBe('retrieved');
    expect(parts[0].priority).toBe('optional');
    expect(parts[0].content).toContain('doctor output here');
  });

  it('returns an empty array when context is empty', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));
    expect(await buildContextPartsFromActive(engine)).toEqual([]);
  });
});

describe('active context actually changes a real planTask() context budget', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('a task planned with a Block in active context requires strictly more tokens than the same task with empty context', async () => {
    dir = await tempDir();
    const store = new JsonFileStore(path.join(dir, 'wazir.json'));
    const engine = await buildPlanTaskEngine(dir, store);

    const baseline = await planTask(engine, 'say hello');
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) throw new Error('unreachable');
    const baselineTokens = baseline.plan.context.finalRequiredTokens;

    const { block, finish } = await createBlock(engine, 'doctor');
    // A substantial chunk of prior output, so the token delta is unambiguous.
    await finish('success', { stdout: 'x'.repeat(4000) });
    await addContextBlock(engine, block.id);

    const withContext = await planTask(engine, 'say hello');
    expect(withContext.ok).toBe(true);
    if (!withContext.ok) throw new Error('unreachable');
    const withContextTokens = withContext.plan.context.finalRequiredTokens;

    expect(withContextTokens).toBeGreaterThan(baselineTokens);
  });
});
