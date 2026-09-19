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
import { MemoryStore } from '@wazir/shared';
import type { RookEngine } from '../src/engine.js';
import { TuiTestHarness } from '../src/tui/inputHarness.js';
import { TerminalScreen } from '../src/tui/screen.js';

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
    store: new MemoryStore() as any,
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
    expect(initialBuf).toContain('WAZIR - CONTROL - WORKER');
    expect(initialBuf).toContain('[View: FLEET]');
    expect(initialBuf).toContain('AVAILABLE');
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

  it('renders persistent 2-pane layout when columns >= 100 and collapses when < 100', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // 1. Initial 120 cols >= 100: 2-pane split with separator '│'
    const splitBuf = harness.getScreenBuffer();
    expect(splitBuf).toContain('|');
    expect(splitBuf).toContain('JOBS');
    expect(splitBuf).toContain('EXECUTIONS');
    expect(splitBuf).toContain('AGENTS');
    expect(splitBuf).toContain('COMPUTERS');
    expect(splitBuf).toContain('RUNTIMES');
    expect(splitBuf).toContain('Routing:');

    // 2. Responsive collapse: resize below 100 columns
    harness.outStream.columns = 80;
    harness.screen.onResize();

    const collapsedBuf = harness.getScreenBuffer();
    expect(collapsedBuf).not.toContain('|');
    expect(collapsedBuf).toContain('Routing:');

    // 3. Restore columns >= 100
    harness.outStream.columns = 120;
    harness.screen.onResize();
    expect(harness.getScreenBuffer()).toContain('|');

    harness.stop();
  });

  it('supports generalized Up/Down navigation across categories with status glyphs and cursor', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // Initially cursor > points to wazir-coding in AGENTS
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('> o wazir-coding');
    expect(buf).toContain('Routing: Agent [wazir-coding]');

    // Navigate Down to COMPUTERS (test-computer)
    harness.sendKey('\u001b[B');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('> + test-computer');
    expect(buf).toContain('Routing: Computer [local]');

    // Navigate Down to RUNTIMES (fake-runtime)
    harness.sendKey('\u001b[B');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('> + fake-runtime');
    expect(buf).toContain('Routing: Runtime [fake]');

    // Navigate Up back to COMPUTERS
    harness.sendKey('\u001b[A');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('> + test-computer');

    harness.stop();
  });

  it('renders history strip wired to blocks and expands block details modal', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // Launch a task prompt which records a block
    harness.sendLine('verify system health');
    await new Promise((r) => setTimeout(r, 60));

    // History strip should show the recorded block
    const buf = harness.getScreenBuffer();
    expect(buf).toContain('History:');
    expect(buf).toContain('[#1 ');

    // Open block modal via /block 1
    harness.sendLine('/block 1');
    await new Promise((r) => setTimeout(r, 20));

    const modalBuf = harness.getScreenBuffer();
    expect(modalBuf).toContain('BLOCK DETAILS #1');
    expect(modalBuf).toContain('verify system health');

    // Dismiss with Escape key
    harness.sendKey('\x1b');
    const closedBuf = harness.getScreenBuffer();
    expect(closedBuf).not.toContain('BLOCK DETAILS #1');

    harness.stop();
  });

  it('triggers @ reference fuzzy picker and completes candidate on Tab', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // Type @ to trigger popup
    harness.sendKeys('@');
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('References (@)');
    expect(buf).toContain('@agent:wazir-coding');

    // Type filter query 'comp'
    harness.sendKeys('comp');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('@computer:local');

    // Press Tab to autocomplete into prompt
    harness.sendKey('\t');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('wa> @computer:local ');

    // Submit command and verify reference resolution
    harness.sendKey('\r');
    await new Promise((r) => setTimeout(r, 40));

    const resolved = harness.tui.getLastResolvedReferences();
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[0].kind).toBe('computer');
    expect((resolved[0] as any).id).toBe('local');

    harness.stop();
  });

  it('displays overlaid policy approval modal with [A], [D], [V], [I] actions', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });

    await harness.start();

    // Enqueue approval request
    let resolvedStatus: boolean | undefined;
    const authPromise = engine.approvalQueue.enqueue(
      { tool: 'shell', input: { command: 'rm -rf /tmp/test' }, executionId: 'exec-sec' },
      { decision: 'ask', rule: 'dangerous-rm', reasons: ['deletes directory recursively'] },
      { taskId: 'task-sec' },
    ).then((res) => {
      resolvedStatus = res;
      return res;
    });

    await new Promise((r) => setTimeout(r, 20));

    // Overlaid modal is visible with action buttons
    const modalBuf = harness.getScreenBuffer();
    expect(modalBuf).toContain('POLICY APPROVAL QUEUE');
    expect(modalBuf).toContain('[A] Approve');
    expect(modalBuf).toContain('[D] Deny');
    expect(modalBuf).toContain('[V] Details');
    expect(modalBuf).toContain('[I] Inspect');

    // Press 'V' to toggle detail view
    harness.sendKey('v');
    expect(harness.tui.getStatusMessage()).toContain('Showing expanded approval details');

    // Press 'I' to inspect and snooze
    harness.sendKey('i');
    expect(harness.tui.getStatusMessage()).toContain('Inspected and snoozed');

    // Press 'A' to approve
    harness.sendKey('a');
    await authPromise;

    expect(resolvedStatus).toBe(true);
    expect(harness.tui.getPendingApprovals()).toHaveLength(0);

    harness.stop();
  });

  it('supports Tier 2 navigation keybindings: Shift-Tab reverse traversal, Ctrl+L repaint, Ctrl+R refresh, and ? help toggle', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // 1. Initial view is 'fleet'
    expect(harness.tui.getCurrentView()).toBe('fleet');

    // 2. Shift-Tab (\x1b[Z) reverse traversal: fleet -> worktrees -> approval -> tail -> fleet
    harness.sendKey('\x1b[Z');
    expect(harness.tui.getCurrentView()).toBe('worktrees');

    harness.sendKey('\x1b[Z');
    expect(harness.tui.getCurrentView()).toBe('approval');

    harness.sendKey('\x1b[Z');
    expect(harness.tui.getCurrentView()).toBe('tail');

    harness.sendKey('\x1b[Z');
    expect(harness.tui.getCurrentView()).toBe('fleet');

    // 3. '?' toggles help screen when input buffer is empty
    harness.sendKey('?');
    expect(harness.tui.getCurrentView()).toBe('help');
    expect(harness.getScreenBuffer()).toContain('WAZIR FLEET TUI SHORTCUTS');

    harness.sendKey('?');
    expect(harness.tui.getCurrentView()).toBe('fleet');

    // 4. Ctrl+R (\x12) forces state refresh
    harness.sendKey('\x12');
    expect(harness.tui.getStatusMessage()).toContain('Refreshed fleet state');

    // 5. Ctrl+L (\x0c) triggers screen repaint
    const initialBuf = harness.getScreenBuffer();
    harness.sendKey('\x0c');
    expect(harness.getScreenBuffer()).toBe(initialBuf);

    harness.stop();
  });

  it('supports Ctrl+P quick actions palette modal navigation, filtering, and selection', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // 1. Press Ctrl+P (\x10) to open palette
    harness.sendKey('\x10');
    expect(harness.tui.isQuickActionsOpen()).toBe(true);
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('QUICK ACTIONS (Ctrl+P)');
    expect(buf).toContain('Fanout Concurrent Tasks');
    expect(buf).toContain('> ');

    // 2. Down arrow navigates items
    harness.sendKey('\u001b[B');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('QUICK ACTIONS (Ctrl+P)');

    // 3. Esc dismisses modal
    harness.sendKey('\x1b');
    expect(harness.tui.isQuickActionsOpen()).toBe(false);
    expect(harness.getScreenBuffer()).not.toContain('QUICK ACTIONS (Ctrl+P)');

    // 4. Reopen with Ctrl+P and execute direct numeric shortcut '6' (/doctor)
    harness.sendKey('\x10');
    expect(harness.tui.isQuickActionsOpen()).toBe(true);
    harness.sendKey('6');
    expect(harness.tui.isQuickActionsOpen()).toBe(false);
    expect(harness.tui.getStatusMessage()).toContain('System diagnostics healthy');

    harness.stop();
  });

  it('renders scrollable event-stream activity pane with typed lifecycle states (PLAN, ROUTE, TOOL, TEST, COMPLETE, ERROR)', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    await harness.start();

    // Launch a task prompt
    harness.sendLine('verify service integration');
    await new Promise((r) => setTimeout(r, 60));

    const job = harness.tui.getCurrentJob()!;
    const jobId = job.id;
    const taskId = harness.tui.getAgents()[0].taskId;

    // Emit typed lifecycle events
    (engine.orchestrator as any).emit(jobId, {
      type: 'task:progress',
      taskId,
      jobId,
      event: { tool: 'shell_exec' },
      timestamp: new Date(),
    });
    (engine.orchestrator as any).emit(jobId, {
      type: 'task:progress',
      taskId,
      jobId,
      event: { phase: 'test', content: 'Running test verification suite' },
      timestamp: new Date(),
    });
    (engine.orchestrator as any).emit(jobId, {
      type: 'task:completed',
      taskId,
      jobId,
      filesChanged: ['test.ts'],
      timestamp: new Date(),
    });

    // Activity pane shows badges
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('PLAN');
    expect(buf).toContain('ROUTE');
    expect(buf).toContain('TOOL');
    expect(buf).toContain('TEST');
    expect(buf).toContain('COMPLETE');

    // Add multiple events to test PageUp/PageDown scrolling
    for (let i = 0; i < 20; i++) {
      (engine.orchestrator as any).emit(jobId, {
        type: 'task:progress',
        taskId,
        jobId,
        event: { content: `Event stream log item ${i}` },
        timestamp: new Date(),
      });
    }

    // Scroll up with PageUp (\x1b[5~)
    harness.sendKey('\x1b[5~');
    expect(harness.tui.getEventScrollOffset()).toBe(5);
    buf = harness.getScreenBuffer();
    expect(buf).toContain('SCROLLED +5 lines');

    // Scroll down with PageDown (\x1b[6~)
    harness.sendKey('\x1b[6~');
    expect(harness.tui.getEventScrollOffset()).toBe(0);

    harness.stop();
  });

  it('renders structured error card with phase, reason, required, available, and suggested resolution steps', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    await harness.start();

    // Set a structured error
    harness.tui.setStructuredError({
      phase: 'model_inference',
      reason: 'VRAM capacity exceeded during generation',
      required: '16GB VRAM available',
      available: '8GB VRAM allocated',
      suggestedSteps: [
        '1. Inspect active processes in activity pane',
        '2. Run "wa doctor" to verify runtime health',
        '3. Select a smaller model quantization profile',
      ],
      taskId: 'task-err-1',
      timestamp: new Date(),
    });

    let buf = harness.getScreenBuffer();
    expect(buf).toContain('EXECUTION FAILURE');
    expect(buf).toContain('Phase:');
    expect(buf).toContain('model_inference');
    expect(buf).toContain('Reason:');
    expect(buf).toContain('VRAM capacity exceeded');
    expect(buf).toContain('Required:');
    expect(buf).toContain('Available:');
    expect(buf).toContain('Suggested Resolution Steps:');
    expect(buf).toContain('Select a smaller model quantization profile');
    expect(buf).toContain('[Esc] Dismiss');
    expect(buf).toContain('[R] Retry Task');

    // Test retry action [R]
    harness.sendKey('r');
    expect(harness.tui.getCurrentError()).toBeUndefined();
    expect(harness.tui.getStatusMessage()).toContain('Retrying task task-err-1');

    // Re-set error and test dismiss [Esc]
    harness.tui.setStructuredError({
      phase: 'tool_execution',
      reason: 'Command not permitted by policy',
      required: 'Policy allow rule',
      available: 'Strict policy denial',
      suggestedSteps: ['Update policy in wazir.json'],
      taskId: 'task-err-2',
      timestamp: new Date(),
    });

    expect(harness.tui.getCurrentError()).toBeDefined();
    harness.sendKey('\x1b');
    expect(harness.tui.getCurrentError()).toBeUndefined();

    harness.stop();
  });

  it('wires up real-time token budget context indicator in status bar', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    const buf = harness.getScreenBuffer();
    // Context indicator format: Context <used>K/<max>K ~
    expect(buf).toMatch(/Context \d+(\.\d+)?K\/\d+K ~/);

    const metrics = harness.tui.getContextMetrics();
    expect(metrics.used).toBeGreaterThan(0);
    expect(metrics.max).toBeGreaterThanOrEqual(metrics.used);

    harness.stop();
  });

  it('provides non-TTY and stream fallback in TerminalScreen', async () => {
    const chunks: string[] = [];
    const mockOut = {
      isTTY: false,
      columns: 80,
      rows: 24,
      write: (data: string) => {
        chunks.push(data);
        return true;
      },
    } as any;
    const mockIn = {
      isTTY: false,
      resume: () => {},
      pause: () => {},
    } as any;

    const screen = new TerminalScreen(mockIn, mockOut);
    expect(screen.isTTY()).toBe(false);

    screen.enter();
    expect(screen.isAltScreenActive()).toBe(false);

    screen.render('plain streaming line');
    expect(chunks).toContain('plain streaming line\n');

    screen.leave();
    expect(screen.isAltScreenActive()).toBe(false);
  });

  it('intercepts Tab key without leaking control characters or literal \\t into the input buffer', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // Type some text into the prompt
    harness.sendKeys('status check');
    expect(harness.getScreenBuffer()).toContain('wa> status check');

    // Press Tab via structured key object
    harness.tui.handleKey('\t', { name: 'tab', ctrl: false, meta: false, shift: false, sequence: '\t' });

    // Verify view transitioned to 'tail'
    expect(harness.tui.getCurrentView()).toBe('tail');

    // Verify input buffer did NOT have '\t' appended or corrupted
    expect(harness.getScreenBuffer()).toContain('wa> status check');
    expect(harness.getScreenBuffer()).not.toContain('wa> status check\t');

    // Press Shift-Tab to reverse traverse back to 'fleet'
    harness.tui.handleKey('\x1b[Z', { name: 'tab', ctrl: false, meta: false, shift: true, sequence: '\x1b[Z' });
    expect(harness.tui.getCurrentView()).toBe('fleet');
    expect(harness.getScreenBuffer()).toContain('wa> status check');
    expect(harness.getScreenBuffer()).not.toContain('\x1b[Z');

    harness.stop();
  });

  it('correctly handles backspace and delete key events, slicing buffer and re-rendering prompt immediately', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // Type 'hello world'
    harness.sendKeys('hello world');
    expect(harness.getScreenBuffer()).toContain('wa> hello world');

    // Send backspace as structured key object
    harness.tui.handleKey('\x7f', { name: 'backspace', ctrl: false, meta: false, shift: false, sequence: '\x7f' });
    expect(harness.getScreenBuffer()).toContain('wa> hello worl');
    expect(harness.getScreenBuffer()).not.toContain('wa> hello world');

    // Send delete as structured key object
    harness.tui.handleKey('\x1b[3~', { name: 'delete', ctrl: false, meta: false, shift: false, sequence: '\x1b[3~' });
    expect(harness.getScreenBuffer()).toContain('wa> hello wor');

    // Send backspace down to empty buffer
    for (let i = 0; i < 20; i++) {
      harness.tui.handleKey('\x7f', { name: 'backspace', ctrl: false, meta: false, shift: false, sequence: '\x7f' });
    }
    expect(harness.getScreenBuffer()).toContain('wa> ');

    harness.stop();
  });

  it('verifies raw mode and keypress binding on TerminalScreen', async () => {
    const mockIn = {
      isTTY: true,
      rawMode: false,
      setRawMode: function (val: boolean) {
        this.rawMode = val;
        return this;
      },
      resume: () => {},
      pause: () => {},
      on: () => {},
    } as any;
    const mockOut = {
      isTTY: true,
      columns: 100,
      rows: 30,
      write: () => true,
    } as any;

    const screen = new TerminalScreen(mockIn, mockOut);
    screen.enter();

    expect(screen.isRawMode()).toBe(true);
    expect(mockIn.rawMode).toBe(true);

    screen.leave();
    expect(screen.isRawMode()).toBe(false);
    expect(mockIn.rawMode).toBe(false);
  });

  it('isolates Tab key events in global keypress listener and toggles target focus with early return', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // Initial state: focus is 'nav', view is 'fleet'
    expect(harness.tui.getCurrentView()).toBe('fleet');
    expect(harness.tui.getFocusedPane()).toBe('nav');

    // Type text into prompt to ensure it is not corrupted or appended to
    harness.sendKeys('active query');
    expect(harness.getScreenBuffer()).toContain('wa> active query');

    let prevented = false;
    let stopped = false;
    const tabKeyEvent = {
      name: 'tab',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\t',
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    };

    // Emit keypress event on inStream directly (global keypress listener)
    harness.inStream.emit('keypress', '\t', tabKeyEvent);

    // Verify Tab event was consumed and preventDefault/stopPropagation invoked
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);

    // Target focus toggled to 'main' and view transitioned to 'tail'
    expect(harness.tui.getCurrentView()).toBe('tail');
    expect(harness.tui.getFocusedPane()).toBe('main');

    // Verify input buffer was completely untouched (no '\t' or corruption)
    expect(harness.getScreenBuffer()).toContain('wa> active query');
    expect(harness.getScreenBuffer()).not.toContain('wa> active query\t');

    harness.stop();
  });

  it('prevents stream echo: navigation keys and unparsed ANSI codes never bind into input buffer or log streams', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // Initial buffer empty
    expect(harness.getScreenBuffer()).toContain('wa> ');

    // Send array of navigation keys and unparsed ANSI escape fragments
    const testKeys = ['\t', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[Z', '[A', '[B', '[Z', '[3~', '\x1b[5~'];
    for (const k of testKeys) {
      harness.sendKey(k);
    }

    const buf = harness.getScreenBuffer();
    // Prompt line must still be empty 'wa> ' (none of these keys or sequences leaked into inputBuffer)
    const promptLine = buf.split('\n').find((l) => l.includes('wa> '));
    expect(promptLine?.trim()).toBe('wa>');

    // Send valid printable characters
    harness.sendKeys('run test');
    expect(harness.getScreenBuffer()).toContain('wa> run test');

    // Send more navigation keys in the middle
    harness.sendKey('\u001b[A'); // Up arrow
    harness.sendKey('\u001b[B'); // Down arrow
    harness.sendKey('\x1b[Z');   // Shift-Tab
    harness.sendKey('\t');       // Tab

    // Verify input buffer still strictly contains 'run test' without sequence echo
    const promptLineAfter = harness.getScreenBuffer().split('\n').find((l) => l.includes('wa> '));
    expect(promptLineAfter?.trim()).toBe('wa> run test');

    harness.stop();
  });

  it('clean view transition: Tab triggers clean redraw without leaking job ID fragments or residual buffer characters into active log pane', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // Launch a multi-task job to produce realistic job and task IDs (e.g., job-mu7ybxyu-1, task-1)
    harness.sendLine('/fanout build frontend; run tests');

    // Wait for job to register
    await new Promise((r) => setTimeout(r, 80));

    const job = harness.tui.getCurrentJob();
    expect(job).toBeDefined();

    // Verify initial fleet view contains clean rendering
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('WAZIR');
    expect(buf).toContain('task-1');

    // Switch view via Tab to 'tail'
    harness.sendKey('\t');
    expect(harness.tui.getCurrentView()).toBe('tail');
    expect(harness.tui.getFocusedPane()).toBe('main');

    // The main pane is now the active event stream activity pane
    buf = harness.getScreenBuffer();
    expect(buf).toContain('Tail: task-1');
    expect(buf).toContain('PLAN');

    // Ensure no broken ANSI fragments or residual chopped strings exist
    expect(buf).not.toContain('\x1b[3\n');
    expect(buf).not.toContain('\x1b[\n');

    // Cycle through all views (tail -> approval -> worktrees -> fleet -> tail)
    harness.sendKey('\t'); // approval
    expect(harness.tui.getCurrentView()).toBe('approval');

    harness.sendKey('\t'); // worktrees
    expect(harness.tui.getCurrentView()).toBe('worktrees');

    harness.sendKey('\t'); // fleet
    expect(harness.tui.getCurrentView()).toBe('fleet');
    expect(harness.tui.getFocusedPane()).toBe('nav');

    harness.sendKey('\t'); // back to tail
    expect(harness.tui.getCurrentView()).toBe('tail');
    expect(harness.tui.getFocusedPane()).toBe('main');

    // Verify screen buffer after view transitions is clean
    const tailBuf = harness.getScreenBuffer();
    expect(tailBuf).toContain('Tail: task-1');
    expect(tailBuf).toContain('wa> ');

    harness.stop();
  });

  it('clears screen on view switch to prevent text ghosting, renders independent view templates, and updates view title without clipping', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });

    await harness.start();

    // 1. Initial state: [View: FLEET] indicator in header
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('[View: FLEET]');
    expect(buf).not.toContain('[View: FLEET]EES');
    expect(buf).not.toContain('[View: FLEET]TREES');

    // 2. Tab to TAIL view: header updates cleanly
    harness.sendKey('\t');
    expect(harness.tui.getCurrentView()).toBe('tail');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('[View: TAIL]');
    // Verify no residual text from FLEET view leaks through
    expect(buf).not.toContain('[View: FLEET]');

    // 3. Tab to APPROVAL view: independent template renders
    harness.sendKey('\t');
    expect(harness.tui.getCurrentView()).toBe('approval');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('[View: APPROVAL]');
    expect(buf).toContain('POLICY APPROVAL QUEUE');
    // When no approvals pending, shows clean empty state
    expect(buf).toContain('No pending approval requests');
    // Verify no table column headers from fleet/execution view bleed through
    expect(buf).not.toContain('Routing:');

    // 4. Tab to WORKTREES view: independent template
    harness.sendKey('\t');
    expect(harness.tui.getCurrentView()).toBe('worktrees');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('[View: WORKTREES]');
    expect(buf).toContain('GIT WORKTREE ISOLATION');
    // No clipping from shorter previous view names
    expect(buf).not.toContain('[View: APPROVAL]');

    // 5. Tab back to FLEET: full cycle clean
    harness.sendKey('\t');
    expect(harness.tui.getCurrentView()).toBe('fleet');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('[View: FLEET]');
    expect(buf).not.toContain('[View: WORKTREES]');

    // 6. Verify Escape also cleanly transitions
    harness.sendKey('\t'); // go to tail
    expect(harness.tui.getCurrentView()).toBe('tail');
    harness.sendKey('\x1b'); // escape back to fleet
    expect(harness.tui.getCurrentView()).toBe('fleet');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('[View: FLEET]');
    expect(buf).not.toContain('[View: TAIL]');

    harness.stop();
  });

  it('renders approval view with dedicated layout template that does not collide with execution table columns', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });

    await harness.start();

    // Navigate to approval view
    harness.sendKey('\t'); // tail
    harness.sendKey('\t'); // approval
    expect(harness.tui.getCurrentView()).toBe('approval');

    // With no pending approvals: clean empty state
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('POLICY APPROVAL QUEUE');
    expect(buf).toContain('No pending approval requests');

    // Enqueue an approval to test populated state
    const authPromise = engine.approvalQueue.enqueue(
      { tool: 'write_file', input: { path: '/tmp/test.txt' }, executionId: 'exec-ui' },
      { decision: 'ask', rule: 'write-guard', reasons: ['writes to filesystem'] },
      { taskId: 'task-ui' },
    );

    await new Promise((r) => setTimeout(r, 20));

    // Approval view should show populated entries
    buf = harness.getScreenBuffer();
    expect(buf).toContain('POLICY APPROVAL QUEUE');
    expect(buf).toContain('write_file');
    expect(buf).toContain('write-guard');

    // Approve to clean up
    harness.sendKey('a');
    await authPromise;

    harness.stop();
  });
});
