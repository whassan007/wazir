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
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  WorktreeManager,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import type { RookEngine } from '../src/engine.js';
import { TuiTestHarness } from '../src/tui/inputHarness.js';

async function buildFleetTestEngine(projectRoot: string): Promise<RookEngine> {
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
    name: 'test-computer',
    type: 'workstation',
    local: true,
    os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
    hardware: { cpu: 'test-cpu', cpuCores: 8, memoryGB: 32 },
    capabilities: ['localExecution'],
  });

  runtimes.register({
    id: 'fake',
    type: 'other',
    name: 'fake-runtime',
    version: '1.0',
    computerId: 'local',
    capabilities: {
      chat: true,
      streaming: true,
      toolCalling: true,
      structuredOutput: false,
      vision: false,
      embeddings: false,
      reasoning: false,
      modelLoad: false,
      modelUnload: false,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    },
  });

  models.register({
    id: 'fake-model',
    name: 'fake-model',
    provider: 'fake',
    family: 'other',
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

  let callCount = 0;
  const fakeAdapter: RuntimeAdapter = {
    id: 'fake',
    type: 'other',
    async discover() {
      return { id: 'fake', name: 'fake', version: '1.0' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async listModels() {
      return [{ id: 'fake-model', name: 'fake-model' }];
    },
    async getCapabilities() {
      return {
        chat: true,
        streaming: true,
        toolCalling: true,
        structuredOutput: false,
        vision: false,
        embeddings: false,
        reasoning: false,
        modelLoad: false,
        modelUnload: false,
        modelDownload: false,
        statefulChat: false,
        mcp: false,
      };
    },
    async *generate() {
      callCount++;
      const reply =
        callCount % 2 === 1
          ? '{"action":"plan","content":"inspecting codebase and implementing task"}'
          : '{"action":"done","summary":"all checks passed and task verified"}';

      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply, usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 } };
    },
  };

  const fakeWorker = {
    id: 'worker-local',
    computerId: 'local',
    adapterForModel: (modelId: string) => (modelId === 'fake-model' ? fakeAdapter : undefined),
  } as unknown as Worker;

  return {
    config: {
      modelContext: {},
      modelCapabilities: {},
      networkAllowed: false,
      allowCommands: [],
      denyCommands: [],
      allowedMcpServers: [],
    },
    projectRoot,
    configDir: path.join(projectRoot, '.wazir'),
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
    adapters: new Map([['fake', fakeAdapter]]),
    discovered: [],
    worker: fakeWorker,
  };
}

describe('FleetTui — interactive terminal UI harness', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('renders initial dashboard, transitions between views via keyboard shortcuts, and displays help', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // 1. Initial screen render
    const initialBuf = harness.getScreenBuffer();
    expect(initialBuf).toContain('WAZIR FLEET ENGINE');
    expect(initialBuf).toContain('wa> ');
    expect(harness.tui.getCurrentView()).toBe('fleet');

    // 2. Open help pane via /help command
    harness.sendLine('/help');
    expect(harness.tui.getCurrentView()).toBe('help');
    const helpBuf = harness.getScreenBuffer();
    expect(helpBuf).toContain('WAZIR FLEET TUI SHORTCUTS');
    expect(helpBuf).toContain('Tab          Cycle through views');

    // 3. Return to fleet view via Escape key
    harness.sendKey('\x1b');
    expect(harness.tui.getCurrentView()).toBe('fleet');

    // 4. Cycle views via Tab key
    harness.sendKey('\t');
    expect(harness.tui.getCurrentView()).toBe('tail');

    harness.sendKey('\t');
    expect(harness.tui.getCurrentView()).toBe('approval');

    harness.sendKey('\t');
    expect(harness.tui.getCurrentView()).toBe('worktrees');

    harness.sendKey('\t');
    expect(harness.tui.getCurrentView()).toBe('fleet');

    harness.stop();
  });

  it('submits a multi-agent fanout job, displays live agent states, and tails an agent stream', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({
      engine,
      concurrencyLimit: 2,
      useWorktrees: false, // In tmp directory without git, skip worktree creation
    });

    await harness.start();

    // Submit a 3-agent fanout job:
    harness.sendLine('/fanout setup database; build auth endpoints; write e2e tests');

    // Allow orchestrator to pick up tasks and start agents
    await new Promise((r) => setTimeout(r, 60));

    const agents = harness.tui.getAgents();
    expect(agents).toHaveLength(3);
    expect(agents.some((a) => a.title.includes('setup database'))).toBe(true);
    expect(agents.some((a) => a.title.includes('build auth endpoints'))).toBe(true);
    expect(agents.some((a) => a.title.includes('write e2e tests'))).toBe(true);

    const buf = harness.getScreenBuffer();
    expect(buf).toContain('setup database');

    // Press Enter to focus and tail the selected agent stream
    harness.sendKey('\r');
    expect(harness.tui.getCurrentView()).toBe('tail');
    const tailBuf = harness.getScreenBuffer();
    expect(tailBuf).toContain('Tail: task-1');

    // Escape returns to fleet dashboard
    harness.sendKey('\x1b');
    expect(harness.tui.getCurrentView()).toBe('fleet');

    // Wait for tasks to complete
    await new Promise((r) => setTimeout(r, 100));

    const job = harness.tui.getCurrentJob();
    expect(job).toBeDefined();

    harness.stop();
  });

  it('handles in-TUI non-blocking approval queue and mid-run steering', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });

    await harness.start();

    // Enqueue an 'ask' decision manually into the engine's approvalQueue
    let approvalResolved = false;
    const authPromise = engine.approvalQueue.enqueue(
      { tool: 'shell', input: { command: 'git checkout main' }, executionId: 'exec-test' },
      { decision: 'ask', rule: 'git-write-ask', reasons: ['modifies local git branch'] },
      { taskId: 'task-test' },
    ).then((res) => {
      approvalResolved = res;
      return res;
    });

    // Give subscriber time to update view
    await new Promise((r) => setTimeout(r, 20));

    // TUI should automatically surface the approval pane
    expect(harness.tui.getCurrentView()).toBe('approval');
    expect(harness.tui.getPendingApprovals()).toHaveLength(1);
    const approvalBuf = harness.getScreenBuffer();
    expect(approvalBuf).toContain('POLICY APPROVAL QUEUE');
    expect(approvalBuf).toContain('git checkout main');

    // Press 'y' to approve in-TUI
    harness.sendKey('y');
    await authPromise;

    expect(approvalResolved).toBe(true);
    expect(harness.tui.getPendingApprovals()).toHaveLength(0);

    // Test steering command injection
    harness.sendLine('/steer prioritize high-priority security patches');
    await new Promise((r) => setTimeout(r, 30));
    expect(harness.tui.getStatusMessage()).toContain('Injected');

    harness.stop();
  });

  it('correctly handles backspace, delete, Ctrl+W, and Ctrl+U in the input buffer', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // Type text
    harness.sendKeys('hello world');
    expect(harness.getScreenBuffer()).toContain('wa> hello world');

    // Single backspace (\x7f)
    harness.sendKey('\x7f');
    expect(harness.getScreenBuffer()).toContain('wa> hello worl');
    expect(harness.getScreenBuffer()).not.toContain('wa> hello world');

    // Repeated backspaces (\x7f\x7f)
    harness.sendKey('\x7f\x7f');
    expect(harness.getScreenBuffer()).toContain('wa> hello wo');

    // Delete key (\x1b[3~)
    harness.sendKey('\x1b[3~');
    expect(harness.getScreenBuffer()).toContain('wa> hello w');

    // Ctrl+W: delete word backward
    harness.sendKey('\u0017');
    expect(harness.getScreenBuffer()).toContain('wa> hello');

    // Ctrl+U: clear entire line
    harness.sendKey('\u0015');
    expect(harness.getScreenBuffer()).toContain('wa> ');
    expect(harness.getScreenBuffer()).not.toContain('wa> hello');

    harness.stop();
  });
});
