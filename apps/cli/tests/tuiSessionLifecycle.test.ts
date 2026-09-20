import { describe, it, expect, vi, afterEach } from 'vitest';
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

/**
 * Terminal-session lifecycle coverage for the fleet TUI: the exit paths
 * (/exit, /quit, bare q, Ctrl+C), full resource cleanup on stop(), and
 * pane-level rendering that the main fleetTui suite only touches at the
 * view-transition level. These close the "does the TUI ever leak a
 * listener, a timer, or a broken terminal state?" gap — the failure modes
 * that only show up when the session actually ends.
 */

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

describe('FleetTui — session lifecycle & terminal hygiene', () => {
  let projectRoot: string;
  let harness: TuiTestHarness | undefined;

  const cleanup = () => {
    if (harness) {
      harness.stop();
      harness = undefined;
    }
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    cleanup();
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
      projectRoot = '';
    }
  });

  it('exits the session on /exit, restores the terminal, and detaches all input listeners', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-lifecycle-'));
    const engine = await buildFleetTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    await harness.start();

    // While running: the TUI binds one 'keypress' handler and one 'data' fallback.
    // ('data' count is 2 total because screen.enter() also parks readline's
    // emitKeypressEvents parser on the stream.)
    expect(harness.inStream.listenerCount('keypress')).toBe(1);
    expect(harness.inStream.listenerCount('data')).toBe(2);

    const exitPromise = harness.tui.waitForExit();
    harness.sendLine('/exit');
    await expect(exitPromise).resolves.toBeUndefined();

    // Terminal restored: cursor shown + alternate screen left (the exact leave() sequence).
    expect(harness.outStream.getOutput()).toContain('\x1b[?25h\x1b[?1049l');

    // TUI's own input listeners are gone — a leftover 'data' handler is exactly how
    // typed characters end up leaking into the shell after the TUI exits.
    expect(harness.inStream.listenerCount('keypress')).toBe(0);
    expect(harness.inStream.listenerCount('data')).toBe(1); // only readline's parser remains
    expect((harness.screen as any).resizeListeners.length).toBe(0);
  });

  it('exits the session on /quit and resolves waitForExit exactly once', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-lifecycle-'));
    const engine = await buildFleetTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });
    await harness.start();

    let resolved = 0;
    const p = harness.tui.waitForExit().then(() => {
      resolved++;
    });
    const p2 = harness.tui.waitForExit().then(() => {
      resolved++;
    });

    harness.sendLine('/quit');
    await Promise.all([p, p2]);

    expect(resolved).toBe(2);
    expect((harness.tui as any).isRunning).toBe(false);
  });

  it('exits the session on a bare q at the prompt', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-lifecycle-'));
    const engine = await buildFleetTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });
    await harness.start();

    // 'q' alone is not special (it is a legitimate character for prompts);
    // it only exits once submitted on its own as a command line.
    harness.sendKeys('q');
    expect((harness.tui as any).isRunning).toBe(true);

    harness.sendKey('\r');
    await new Promise((r) => setTimeout(r, 10));
    expect((harness.tui as any).isRunning).toBe(false);
  });

  it('terminates cleanly on Ctrl+C with exit code 0 and full cleanup', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-lifecycle-'));
    const engine = await buildFleetTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      return code as never;
    }) as unknown as typeof process.exit);

    await harness.start();
    harness.sendKey('\u0003'); // Ctrl+C

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    // ...and the session was fully torn down before exit was requested.
    expect(harness.inStream.listenerCount('keypress')).toBe(0);
    expect(harness.inStream.listenerCount('data')).toBe(1); // only readline's parser remains
    expect(harness.outStream.getOutput()).toContain('\x1b[?1049l');
  });

  it('stop() clears the render timer, resize and event subscriptions, and the rejection guard', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-lifecycle-'));
    const engine = await buildFleetTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const baseRejections = process.listenerCount('unhandledRejection');

    await harness.start();
    expect(process.listenerCount('unhandledRejection')).toBe(baseRejections + 1);
    expect((harness.screen as any).resizeListeners.length).toBe(1);

    harness.stop();

    expect(clearSpy).toHaveBeenCalled(); // 250ms render loop cleared
    expect(process.listenerCount('unhandledRejection')).toBe(baseRejections);
    expect((harness.screen as any).resizeListeners.length).toBe(0);
    expect(harness.inStream.listenerCount('keypress')).toBe(0);
    expect(harness.inStream.listenerCount('data')).toBe(1); // only readline's parser remains
  });

  it('renders the worktrees view with per-agent isolated branch names', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-lifecycle-'));
    const engine = await buildFleetTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });
    await harness.start();

    harness.sendLine('implement the login flow');
    await new Promise((r) => setTimeout(r, 80));
    const job = harness.tui.getCurrentJob();
    const agents = harness.tui.getAgents();
    expect(job).toBeDefined();
    expect(agents.length).toBeGreaterThan(0);

    // fleet -> tail -> approval -> worktrees
    harness.sendKey('\t');
    harness.sendKey('\t');
    harness.sendKey('\t');
    expect(harness.tui.getCurrentView()).toBe('worktrees');

    const buf = harness.getScreenBuffer();
    expect(buf).toContain('GIT WORKTREE ISOLATION');
    expect(buf).toContain(agents[0].taskId);
    expect(buf).toContain(`wazir/${job!.id}/${agents[0].taskId}`);
  });

  it('cancels a pending job by explicit id via /cancel <job-id>', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-lifecycle-'));
    const engine = await buildFleetTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });
    await harness.start();

    // A pending job created outside this TUI session (e.g. reloaded from the
    // store) — /cancel with an explicit id must reach it without any nav selection.
    const orphanJob = await engine.orchestrator.createJob({
      title: 'orphaned job',
      tasks: [{ task: { id: 'orphan-task', input: 'never actually run' } }],
    });
    expect(orphanJob.status).toBe('pending');

    harness.sendLine(`/cancel ${orphanJob.id}`);
    await new Promise((r) => setTimeout(r, 10));

    expect(engine.orchestrator.getJob(orphanJob.id)?.status).toBe('cancelled');
    expect(harness.tui.getStatusMessage()).toContain(`Cancelled job ${orphanJob.id}`);
  });
});
