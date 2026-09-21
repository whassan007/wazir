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
    async cancel() {
      // Overridden per-test (like `generate`) when a test needs to observe cancellation.
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

/**
 * Overrides the engine's default fake model with one that actually performs a `write`
 * before declaring done. CodingAgent's VERIFY phase now fails outright when zero files
 * were changed ("Agent declared completion but produced no code modifications") — the
 * engine's default plan-then-done-only script no longer reaches 'completed' on its own,
 * which is fine for tests that don't care about final job status but breaks any test
 * that needs a genuinely successful job. Cycles plan -> write -> done every 3 calls, so
 * it also self-heals under concurrent fanout (each task's own turns may interleave with
 * others', but plan/tool actions are handled gracefully regardless of position).
 */
function useSuccessfulFakeModel(engine: RookEngine): void {
  const adapter = engine.worker.adapterForModel('fake-model')!;
  let call = 0;
  adapter.generate = async function* () {
    call += 1;
    const step = call % 3;
    const reply =
      step === 1
        ? '{"action":"plan","content":"inspecting codebase and implementing task"}'
        : step === 2
          ? '{"action":"tool","tool":"write","input":{"path":"output.txt","content":"result"}}'
          : '{"action":"done","summary":"all checks passed and task verified"}';
    yield { type: 'token' as const, content: reply };
    yield { type: 'completed' as const, content: reply, usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 } };
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
    useSuccessfulFakeModel(engine);
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
    // Task ids are job-scoped (task-<jobId>-<n>), not the fixed "task-1", "task-2", ... a
    // single job used to always assign — see the job-scoped-task-id fix in
    // launchJobFromPrompt for why that was actually a real cross-job data-leak bug.
    expect(tailBuf).toContain(`Tail: ${agents[0].taskId}`);

    // Escape returns to fleet dashboard
    harness.sendKey('\x1b');
    expect(harness.tui.getCurrentView()).toBe('fleet');

    // Wait for tasks to complete
    await new Promise((r) => setTimeout(r, 100));

    const job = harness.tui.getCurrentJob();
    expect(job).toBeDefined();

    // Completed tasks carry the model's token usage (input/output/total) forwarded from
    // the task:completed event — the Tail view should show it, not just status/duration.
    const completedAgent = harness.tui.getAgents().find((a) => a.status === 'completed');
    expect(completedAgent?.usage?.total).toBeGreaterThan(0);

    harness.sendKey('\r');
    expect(harness.tui.getCurrentView()).toBe('tail');
    const usageBuf = harness.getScreenBuffer();
    expect(usageBuf).toMatch(/Tokens: In \d+ \/ Out \d+ \(\d+ total\)/);
    expect(usageBuf).toMatch(/Speed: [\d.]+ tok\/s/);
    harness.sendKey('\x1b');

    // Navigate up to the JOBS entry (it's first in the flat nav list) and confirm the
    // rollup line — previously stuck showing whatever job last ran, not the selected one
    // — now shows this job's own input/output token breakdown.
    for (let i = 0; i < 5; i++) harness.sendKey('\u001b[A');
    await new Promise((r) => setTimeout(r, 30));
    const jobBuf = harness.getScreenBuffer();
    expect(jobBuf).toMatch(/Rollup: Tokens: In \d+ \/ Out \d+ \(\d+ total\)/);

    // Pressing Enter on a JOBS nav item used to fall through to "expand the most
    // recently run history block" (since a finished job has no live agent card left
    // for the EXECUTIONS/agents check above it), popping open something completely
    // unrelated (e.g. a `doctor` command block) instead of the job you actually
    // selected. It should now open a full, untruncated output modal for that job.
    harness.sendKey('\r');
    expect(harness.tui.getCurrentView()).toBe('fleet');
    const modalBuf = harness.getScreenBuffer();
    expect(modalBuf).toContain('JOB OUTPUT');
    expect(modalBuf).not.toContain('BLOCK DETAILS');

    harness.sendKey('\x1b');
    expect(harness.getScreenBuffer()).not.toContain('JOB OUTPUT');

    harness.stop();
  });

  it('deletes a completed job from the JOBS list via the Delete key', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    await harness.start();

    harness.sendLine('solo job');
    await new Promise((r) => setTimeout(r, 100));
    const job = harness.tui.getCurrentJob();
    expect(job).toBeDefined();

    // Navigate up to the JOBS entry (first in the flat nav list)
    for (let i = 0; i < 5; i++) harness.sendKey('\u001b[A');
    const before = harness.tui.getFlatNavItems();
    expect(before.some((i) => i.category === 'JOBS' && i.id === job!.id)).toBe(true);

    harness.sendKey('\x1b[3~'); // forward-Delete
    await new Promise((r) => setTimeout(r, 10)); // deleteJob() is async

    const after = harness.tui.getFlatNavItems();
    expect(after.some((i) => i.category === 'JOBS' && i.id === job!.id)).toBe(false);
    expect(harness.tui.getStatusMessage()).toContain(`Deleted job ${job!.id}`);
    expect(engine.orchestrator.getJob(job!.id)).toBeUndefined();

    harness.stop();
  });

  it('gives feedback instead of silently no-oping when x/Delete is pressed on a non-JOBS item', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    await harness.start();

    harness.sendLine('solo job');
    await new Promise((r) => setTimeout(r, 100));
    const job = harness.tui.getCurrentJob();
    expect(job).toBeDefined();

    // Selection starts on the EXECUTIONS item (task-1) right after a job launches —
    // exactly the item easy to mistake for "the job" itself, one row below it in the nav.
    const flat = harness.tui.getFlatNavItems();
    expect(flat.some((i) => i.category === 'EXECUTIONS')).toBe(true);

    harness.sendKey('x');
    expect(harness.tui.getStatusMessage()).toContain('only deletes items in the JOBS section');
    expect(harness.tui.getStatusMessage()).toContain('EXECUTIONS');
    // Nothing was actually deleted
    expect(engine.orchestrator.getJob(job!.id)).toBeDefined();

    harness.stop();
  });

  it('cancels a selected job via the c key and /cancel, even one not launched this session', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    await harness.start();

    // Created directly (never run) — pending, not launched via this TUI session, exactly
    // like a job reloaded from a past session's store. /cancel used to only ever act on
    // `this.currentJob`, so this job had no way to be stopped from the TUI at all.
    const orphanJob = await engine.orchestrator.createJob({
      title: 'orphaned job',
      tasks: [{ task: { id: 'orphan-task', input: 'never actually run' } }],
    });
    expect(orphanJob.status).toBe('pending');
    expect(harness.tui.getCurrentJob()).toBeUndefined();

    // Fresh engine, no job launched through the TUI itself — this orphan job (created
    // directly, as a reloaded-from-store job would appear) is the only nav item, so it's
    // already the default selection (navSelectionIndex starts at 0) without navigating.
    const flat = harness.tui.getFlatNavItems();
    expect(flat[0]).toMatchObject({ category: 'JOBS', id: orphanJob.id });

    harness.sendKey('c');
    await new Promise((r) => setTimeout(r, 10)); // cancelJob() is async
    expect(engine.orchestrator.getJob(orphanJob.id)?.status).toBe('cancelled');
    expect(harness.tui.getStatusMessage()).toContain(`Cancelled job ${orphanJob.id}`);

    // Now deletable, since it's no longer active
    harness.sendKey('x');
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.orchestrator.getJob(orphanJob.id)).toBeUndefined();

    harness.stop();
  });

  it('pressing c on an already-finished job reports an error instead of crashing the process', async () => {
    // cancelJob() throws for a job already in a terminal status. The 'c' keybinding
    // called it fire-and-forget with no .catch() — an unhandled promise rejection, which
    // is a real Node process crash by default, not just a TUI-level error. This test's
    // entire purpose is to prove that no longer happens; if the fix regresses, this test
    // process itself would crash rather than fail an assertion.
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    useSuccessfulFakeModel(engine);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    await harness.start();

    harness.sendLine('quick job');
    await new Promise((r) => setTimeout(r, 100));
    const job = harness.tui.getCurrentJob();
    expect(job?.status).toBe('completed');

    for (let i = 0; i < 5; i++) harness.sendKey('\u001b[A'); // up to the JOBS entry
    expect(harness.tui.getFlatNavItems()[harness.tui.getFlatNavItems().findIndex((it) => it.id === job!.id)]).toBeDefined();

    harness.sendKey('c');
    await new Promise((r) => setTimeout(r, 10));

    expect(harness.tui.getStatusMessage()).toContain('Could not cancel job');
    expect(engine.orchestrator.getJob(job!.id)?.status).toBe('completed'); // unchanged

    harness.stop();
  });

  it('does not leak tokens between jobs that would otherwise share the same default task id', async () => {
    // Every single-task job used to get the task id "task-1" regardless of which job it
    // was, and ExecutionEngine.listByTask(taskId) filters by task id alone with no job
    // scoping — so getJobRollup() for one job silently summed in execution records from
    // every other job that happened to reuse the same task id, which was effectively all
    // of them. Task ids are now job-scoped (task-<jobId>-<n>) via JobManager's own
    // auto-id assignment instead of the TUI hardcoding "task-<n>".
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    useSuccessfulFakeModel(engine);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    await harness.start();

    harness.sendLine('first job');
    await new Promise((r) => setTimeout(r, 100));
    const jobA = harness.tui.getCurrentJob();
    expect(jobA?.status).toBe('completed');

    harness.sendLine('second job');
    await new Promise((r) => setTimeout(r, 100));
    const jobB = harness.tui.getCurrentJob();
    expect(jobB?.status).toBe('completed');

    expect(jobA!.tasks[0].id).not.toBe(jobB!.tasks[0].id);

    const rollupA = await engine.orchestrator.getJobRollup(jobA!.id);
    const rollupB = await engine.orchestrator.getJobRollup(jobB!.id);
    // Each task makes three model turns (plan, write, then done), and the fake adapter
    // reports a fixed 25-token usage per turn, so 75 is each job's own legitimate total.
    // If task ids collided, each job's rollup would pull in the OTHER job's execution
    // too and double to 150 instead.
    expect(rollupA.tokens.total).toBe(75);
    expect(rollupB.tokens.total).toBe(75);

    harness.stop();
  });

  it('shows the model output live while a turn streams, then folds it into the log as a MODEL line', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    // First turn streams half a plan and then waits until released, so the TUI can be
    // observed mid-generation. Later turns finish immediately.
    let release: (() => void) | undefined;
    let call = 0;
    const adapter = engine.worker.adapterForModel('fake-model')!;
    adapter.generate = async function* () {
      call += 1;
      if (call === 1) {
        yield { type: 'token' as const, content: '{"action":"plan","content":"first inspect the repo, then ' };
        await new Promise<void>((r) => { release = r; });
        const rest = 'write the module"}';
        yield { type: 'token' as const, content: rest };
        yield { type: 'completed' as const, content: '', usage: { inputTokens: 42, outputTokens: 9, totalTokens: 51 } };
        return;
      }
      if (call === 2) {
        // VERIFY now fails outright when zero files changed, so a real write has to
        // happen somewhere before 'done' for this job to actually reach 'completed'.
        const write = '{"action":"tool","tool":"write","input":{"path":"module.txt","content":"x"}}';
        yield { type: 'token' as const, content: write };
        yield { type: 'completed' as const, content: write, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
        return;
      }
      const done = '{"action":"done","summary":"module written"}';
      yield { type: 'token' as const, content: done };
      yield { type: 'completed' as const, content: done, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } };
    };

    await harness.start();
    harness.sendLine('build the module');
    // Wait for the first token to arrive (scheduling + first model call are async).
    for (let i = 0; i < 40 && !harness.tui.getAgents().some((a) => a.status === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 60));

    // Open the Tail view for the running task and look at the live block.
    harness.sendKey('\r');
    expect(harness.tui.getCurrentView()).toBe('tail');
    const live = harness.getScreenBuffer();
    expect(live).toContain('MODEL is generating');
    expect(live).toContain('first inspect the repo, then');
    // Not yet a log line: the turn hasn't finished.
    expect(live).not.toMatch(/MODEL\s+plan:/);

    release!();
    for (let i = 0; i < 60 && harness.tui.getCurrentJob()?.status !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const after = harness.getScreenBuffer();
    expect(after).not.toContain('MODEL is generating');
    // Folded into the history as one readable line, in causal order before the parsed
    // "Plan:" event that resulted from it.
    expect(after).toMatch(/MODEL\s+Plan: first inspect the repo, then write the module/);
    expect(after.indexOf('MODEL')).toBeLessThan(after.indexOf('Plan: first inspect'));
    // Context gauge reflects the last turn's actual prompt size, not a cumulative total.
    expect(harness.tui.getContextMetrics().used).toBe(7);

    harness.stop();
  });

  it('shows a failed tool call with a plain-language reason, not the raw policy rule id', async () => {
    // Real transcript: a policy denial showed up in the log only as
    // "Tool call executed: shell" (the error was silently dropped), and the
    // raw "policy deny (shell-unknown-ask): empty shell command" string only
    // ever reached the user via the model quoting it back in its own prose
    // several turns later. The log line itself should say what happened.
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    let call = 0;
    const adapter = engine.worker.adapterForModel('fake-model')!;
    adapter.generate = async function* () {
      call += 1;
      const reply =
        call === 1
          ? '{"action":"tool","tool":"shell","input":{"command":""}}'
          : '{"action":"done","summary":"done"}';
      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    };

    await harness.start();
    harness.sendLine('run a command');
    for (let i = 0; i < 60 && harness.tui.getCurrentJob()?.status !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    harness.sendKey('\r');

    const screen = harness.getScreenBuffer();
    expect(screen).toContain('shell failed');
    expect(screen).toContain('Blocked: empty shell command');
    expect(screen).not.toContain('shell-unknown-ask');
    expect(screen).not.toContain('Tool call executed');

    harness.stop();
  });

  it('reports a timed-out job as stopped by the timeout, not "cancelled by operator"', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false, timeoutSeconds: 1 });

    // A model turn that outlives the job timeout. Cancellation is cooperative (checked
    // between turns), so the turn is released after the timeout fires and the agent must
    // then stop without running the action it produced.
    let release: (() => void) | undefined;
    let call = 0;
    const adapter = engine.worker.adapterForModel('fake-model')!;
    adapter.generate = async function* () {
      call += 1;
      if (call === 1) {
        await new Promise<void>((r) => { release = r; });
      }
      const reply = '{"action":"tool","tool":"write","input":{"path":"late.txt","content":"should never be written"}}';
      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    await harness.start();
    harness.sendLine('slow task');
    await new Promise((r) => setTimeout(r, 1200)); // past the 1s timeout
    release!();
    // Everything after release is async (agent unwinds, evaluation, rollup) and slows
    // down under parallel test load — wait for the outcome rather than a fixed sleep.
    for (let i = 0; i < 60 && !/exceeded the 1s timeout/.test(harness.tui.getStatusMessage()); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const job = harness.tui.getCurrentJob();
    expect(job?.status).toBe('failed');
    expect(harness.tui.getStatusMessage()).toContain('exceeded the 1s timeout');
    expect(harness.tui.getStatusMessage()).not.toContain('cancelled');

    harness.sendKey('\r');
    const tail = harness.getScreenBuffer();
    expect(tail).toContain('Task stopped automatically: exceeded the 1s timeout');
    expect(tail).not.toContain('cancelled by operator');
    // The action the model produced after the cancel landed must not have run.
    await expect(fs.access(path.join(projectRoot, 'late.txt'))).rejects.toThrow();

    harness.stop();
  });

  it('cancels an in-flight model turn as soon as the job timeout fires, not just at the turn\'s own longer timeout', async () => {
    // Real transcript: a job reported "exceeded the 300s timeout" but actually
    // ran 338.8s — cancelJob()/timeout only set the abort signal, which the
    // agent loop checks cooperatively between turns and does nothing for a
    // turn already streaming. It had to run until it hit its own (much
    // longer, 90s default) per-turn timeout before anything actually stopped it.
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false, timeoutSeconds: 1 });

    const adapter = engine.worker.adapterForModel('fake-model')!;
    let cancelCalls = 0;
    let release: (() => void) | undefined;
    adapter.cancel = async () => {
      cancelCalls += 1;
      release?.();
    };
    adapter.generate = async function* () {
      yield { type: 'token' as const, content: 'still reasoning, no action yet' };
      await new Promise<void>((r) => {
        release = r;
      });
      yield { type: 'completed' as const, content: 'cut off', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    await harness.start();
    harness.sendLine('slow task');

    // The job's own 1s timeout, not the turn's ~90s default, must be what
    // triggers this — a short poll window that a real per-turn timeout could
    // never reach in time.
    for (let i = 0; i < 60 && cancelCalls === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(cancelCalls).toBeGreaterThan(0);

    for (let i = 0; i < 60 && harness.tui.getCurrentJob()?.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(harness.tui.getCurrentJob()?.status).toBe('failed');

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

    // Delete key (\x1b[3~) with the cursor at the end of the line (nothing after it to
    // remove) is now correctly a no-op — before the input line had a real cursor
    // position, forward-delete and backspace were indistinguishable and both always
    // chopped the last character regardless of where "the cursor" conceptually was.
    harness.sendKey('\x1b[3~');
    expect(harness.getScreenBuffer()).toContain('wa> hello wo');

    // Move left once so the cursor sits right before the trailing 'o', then
    // forward-delete removes that 'o' *at* the cursor (cursor position/index is
    // unchanged by a forward-delete — it now points at the new, shorter end).
    harness.sendKey('\u001b[D');
    harness.sendKey('\x1b[3~');
    expect(harness.getScreenBuffer()).toContain('wa> hello w');
    expect(harness.getScreenBuffer()).not.toContain('wa> hello wo');

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
    useSuccessfulFakeModel(engine);
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

  it('shows a line diff for a pending edit approval instead of a raw JSON args blob', async () => {
    // Approving an edit used to mean approving `Args: {"path":...,"oldString":"...","newString":"..."}`
    // as one long escaped JSON string — unreadable for anything beyond a one-line change.
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });

    await harness.start();

    const authPromise = engine.approvalQueue.enqueue(
      {
        tool: 'edit',
        input: {
          path: 'src/greet.ts',
          oldString: 'function greet() {\n  return "hi";\n}',
          newString: 'function greet(name: string) {\n  return `hi ${name}`;\n}',
        },
        executionId: 'exec-diff',
      },
      { decision: 'ask', rule: 'protected-path-ask', reasons: ['touches a protected path'] },
      { taskId: 'task-diff' },
    );

    await new Promise((r) => setTimeout(r, 20));

    const buf = harness.getScreenBuffer();
    expect(buf).toContain('File: src/greet.ts');
    expect(buf).toContain('- function greet() {');
    expect(buf).toContain('+ function greet(name: string) {');
    expect(buf).not.toContain('oldString');
    expect(buf).not.toContain('newString');

    harness.sendKey('a');
    await authPromise;
    harness.stop();
  });

  it('shows a labeled content preview (not a diff) for a pending write approval', async () => {
    // No reliable on-disk path resolution from the TUI (worktrees put tasks in
    // different directories) — a write must never claim to diff against a file
    // it can't be sure it's reading, so it gets a clearly-labeled preview instead.
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });

    await harness.start();

    const authPromise = engine.approvalQueue.enqueue(
      { tool: 'write', input: { path: 'src/new-file.ts', content: 'export const x = 1;\nexport const y = 2;' }, executionId: 'exec-write' },
      { decision: 'ask', rule: 'protected-path-ask', reasons: ['touches a protected path'] },
      { taskId: 'task-write' },
    );

    await new Promise((r) => setTimeout(r, 20));

    const buf = harness.getScreenBuffer();
    expect(buf).toContain('File: src/new-file.ts');
    expect(buf).toContain('New content (2 line(s)):');
    expect(buf).toContain('+ export const x = 1;');

    harness.sendKey('a');
    await authPromise;
    harness.stop();
  });

  it('supports Ctrl+A / Ctrl+D to approve or deny all queued policy requests at once', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });

    await harness.start();

    const results: boolean[] = [];
    const enqueue = (command: string, taskId: string) =>
      engine.approvalQueue
        .enqueue(
          { tool: 'shell', input: { command }, executionId: `exec-${taskId}` },
          { decision: 'ask', rule: 'shell-unknown-ask', reasons: ['not on the safe command list'] },
          { taskId },
        )
        .then((res) => {
          results.push(res);
          return res;
        });

    const p1 = enqueue('clang++ hello.cpp -o hello', 'task-a');
    const p2 = enqueue('ls -F', 'task-b');
    const p3 = enqueue('rm -rf build', 'task-c');

    await new Promise((r) => setTimeout(r, 20));
    expect(harness.tui.getPendingApprovals()).toHaveLength(3);

    // Multi-request modal offers batch actions
    const buf = harness.getScreenBuffer();
    expect(buf).toContain('[^A] All');
    expect(buf).toContain('[^D] None');

    // Ctrl+A approves every queued request in one keypress
    harness.sendKey('\u0001');
    await Promise.all([p1, p2, p3]);

    expect(results).toEqual([true, true, true]);
    expect(harness.tui.getPendingApprovals()).toHaveLength(0);
    expect(harness.tui.getStatusMessage()).toContain('Approved all 3 pending policy requests');

    // Ctrl+D denies every queued request in one keypress
    const denyResults: boolean[] = [];
    const d1 = engine.approvalQueue
      .enqueue(
        { tool: 'shell', input: { command: 'sudo reboot' }, executionId: 'exec-d1' },
        { decision: 'ask', rule: 'shell-unknown-ask', reasons: ['not on the safe command list'] },
        { taskId: 'task-d1' },
      )
      .then((res) => {
        denyResults.push(res);
        return res;
      });
    const d2 = engine.approvalQueue
      .enqueue(
        { tool: 'shell', input: { command: 'curl evil.example' }, executionId: 'exec-d2' },
        { decision: 'ask', rule: 'shell-unknown-ask', reasons: ['not on the safe command list'] },
        { taskId: 'task-d2' },
      )
      .then((res) => {
        denyResults.push(res);
        return res;
      });

    await new Promise((r) => setTimeout(r, 20));
    expect(harness.tui.getPendingApprovals()).toHaveLength(2);

    harness.sendKey('\u0004');
    await Promise.all([d1, d2]);

    expect(denyResults).toEqual([false, false]);
    expect(harness.tui.getPendingApprovals()).toHaveLength(0);
    expect(harness.tui.getStatusMessage()).toContain('Denied all 2 pending policy requests');

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
    useSuccessfulFakeModel(engine);
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

    // Idle: no model turn has completed, so nothing is measured. This used to fake 8.4K
    // (and otherwise summed cumulative job tokens + log-text estimates, which produced
    // "106.6K/32K" for a 32K model) — only a real measurement is shown now.
    expect(harness.tui.getContextMetrics()).toEqual({ used: 0, max: 32_768 });

    harness.sendLine('measure context');
    await new Promise((r) => setTimeout(r, 100));

    // After a run: the prompt size of the last model turn (the fake adapter reports
    // inputTokens: 10 on every turn), i.e. actual context-window occupancy — not the
    // job's cumulative total (which would be 20 here across the two turns).
    const metrics = harness.tui.getContextMetrics();
    expect(metrics.used).toBe(10);
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
    const written: string[] = [];
    const mockOut = {
      isTTY: true,
      columns: 100,
      rows: 30,
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    } as any;

    const screen = new TerminalScreen(mockIn, mockOut);
    screen.enter();

    expect(screen.isRawMode()).toBe(true);
    expect(mockIn.rawMode).toBe(true);
    // Explicit steady-box cursor (DECSCUSR) — nothing set a cursor shape before
    // this, so the hardware cursor just inherited whatever style/blink state
    // was left over from before `wa` started, which read as invisible on some
    // terminals.
    expect(written.join('')).toContain('\x1b[2 q');

    screen.leave();
    expect(screen.isRawMode()).toBe(false);
    expect(mockIn.rawMode).toBe(false);
    // Cursor style reset to the terminal's own default on exit — `wa` must not
    // leave the user's terminal permanently forced into a block cursor.
    expect(written.join('')).toContain('\x1b[0 q');
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

    // Launch a multi-task job to produce realistic job and task IDs (e.g.,
    // job-mu7ybxyu-1, task-job-mu7ybxyu-1-0 — job-scoped, not the fixed "task-1")
    harness.sendLine('/fanout build frontend; run tests');

    // Wait for job to register
    await new Promise((r) => setTimeout(r, 80));

    const job = harness.tui.getCurrentJob();
    expect(job).toBeDefined();
    const firstTaskId = job!.tasks[0].id;

    // Verify initial fleet view contains clean rendering
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('WAZIR');
    expect(buf).toContain(firstTaskId);

    // Switch view via Tab to 'tail'
    harness.sendKey('\t');
    expect(harness.tui.getCurrentView()).toBe('tail');
    expect(harness.tui.getFocusedPane()).toBe('main');

    // The main pane is now the active event stream activity pane
    buf = harness.getScreenBuffer();
    expect(buf).toContain(`Tail: ${firstTaskId}`);
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
    expect(tailBuf).toContain(`Tail: ${firstTaskId}`);
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

describe('FleetTui — runtime health visibility and model selection', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('marks an unreachable runtime failed instead of idle/active — previously indistinguishable', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    // Simulate LM Studio's server being down: discovery ran, found nothing reachable.
    engine.discovered.push({
      id: 'fake',
      info: { id: 'fake', name: 'fake-runtime', version: '1.0' },
      capabilities: {} as any,
      health: 'unavailable',
      healthMessage: 'connection refused',
      models: [],
      adapter: {} as any,
    });
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
    await harness.start();

    const items = (harness.tui as any).getFlatNavItems() as Array<{ category: string; id: string; status: string }>;
    const runtimeItem = items.find((i) => i.category === 'RUNTIMES' && i.id === 'fake');
    expect(runtimeItem?.status).toBe('failed');

    harness.stop();
  });

  it('does not mark a healthy runtime as failed just because no agent is currently running on it', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    engine.discovered.push({
      id: 'fake',
      info: { id: 'fake', name: 'fake-runtime', version: '1.0' },
      capabilities: {} as any,
      health: 'healthy',
      models: [],
      adapter: {} as any,
    });
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
    await harness.start();

    const items = (harness.tui as any).getFlatNavItems() as Array<{ category: string; id: string; status: string }>;
    const runtimeItem = items.find((i) => i.category === 'RUNTIMES' && i.id === 'fake');
    expect(runtimeItem?.status).not.toBe('failed');

    harness.stop();
  });

  it('/model pins subsequently submitted tasks to the chosen model instead of auto-routing', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
    await harness.start();

    harness.sendLine('/model fake-model');
    expect(harness.tui.getStatusMessage()).toContain("Pinned model to 'fake-model'");
    expect((harness.tui as any).selectedModelId).toBe('fake-model');

    harness.sendLine('build something');
    await new Promise((r) => setTimeout(r, 30));

    const job = harness.tui.getCurrentJob();
    expect(job?.tasks[0]?.execution?.targetModelId).toBe('fake-model');

    harness.stop();
  });

  it('/model with no id reports the current pin and available models; /model auto clears it', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
    await harness.start();

    harness.sendLine('/model fake-model');
    harness.sendLine('/model');
    expect(harness.tui.getStatusMessage()).toContain('Model: fake-model');
    expect(harness.tui.getStatusMessage()).toContain('fake-model');

    harness.sendLine('/model auto');
    expect((harness.tui as any).selectedModelId).toBeUndefined();
    expect(harness.tui.getStatusMessage()).toContain('Cleared model pin');

    harness.stop();
  });

  it('/model rejects an id that is not registered instead of silently pinning to nothing', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
    await harness.start();

    harness.sendLine('/model nonexistent-model');
    expect((harness.tui as any).selectedModelId).toBeUndefined();
    expect(harness.tui.getStatusMessage()).toContain("No registered model 'nonexistent-model'");

    harness.stop();
  });

  it('/launch lmstudio reports a clear error when the configured lms binary cannot be found', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
    await harness.start();

    // Point at a path guaranteed not to exist so this never touches a real local LM
    // Studio install, regardless of what's on the machine actually running this test.
    const previous = process.env.WAZIR_LMS_BIN;
    process.env.WAZIR_LMS_BIN = '/nonexistent/definitely-missing-lms-binary';
    try {
      harness.sendLine('/launch lmstudio');
      await new Promise((r) => setTimeout(r, 50));
      expect(harness.tui.getStatusMessage()).toContain("'lms' CLI not found on PATH");
    } finally {
      if (previous === undefined) delete process.env.WAZIR_LMS_BIN;
      else process.env.WAZIR_LMS_BIN = previous;
    }

    harness.stop();
  });

  it('/launch rejects an unsupported runtime name without attempting to run anything', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
    await harness.start();

    harness.sendLine('/launch ollama');
    expect(harness.tui.getStatusMessage()).toContain("Don't know how to launch 'ollama'");

    harness.stop();
  });
});

describe('FleetTui — protocol/validation visibility and raw response viewer', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('tags a locally-rejected malformed tool call as VALIDATE, not a silent no-op', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    let call = 0;
    const adapter = engine.worker.adapterForModel('fake-model')!;
    adapter.generate = async function* () {
      call += 1;
      const reply =
        call === 1
          ? '{"action":"plan","content":"write it"}'
          : call === 2
            ? '{"action":"tool","tool":"write","input":{}}' // malformed: no path/content
            : call === 3
              ? '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"int main(){}"}}'
              : '{"action":"done","summary":"done"}';
      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    await harness.start();
    harness.sendLine('build something');
    for (let i = 0; i < 60 && harness.tui.getCurrentJob()?.status !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const taskId = harness.tui.getAgents()[0]?.taskId;
    const logs = (harness.tui as any).agentLogs.get(taskId) as Array<{ kind: string; text: string }>;
    const validateEntry = logs.find((l) => l.kind === 'validate');
    expect(validateEntry).toBeDefined();
    expect(validateEntry!.text).toContain("'write' missing path, content");

    // Also visible on screen with its distinct badge, not folded into a generic line.
    harness.sendKey('\r'); // enter Tail view
    const buf = harness.getScreenBuffer();
    expect(buf).toContain('VALIDATE');

    harness.stop();
  });

  it("'r' on the Tail view shows the task's raw model response", async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tui-test-'));
    const engine = await buildFleetTestEngine(projectRoot);
    const harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });

    // Must actually succeed (write a file, so VERIFY passes) — a failed/retrying task
    // pops the structured error card, whose own 'r' binding (retry) would otherwise
    // shadow the Tail view's raw-response 'r' binding tested here.
    let call = 0;
    const adapter = engine.worker.adapterForModel('fake-model')!;
    adapter.generate = async function* () {
      call += 1;
      const reply =
        call === 1
          ? '{"action":"plan","content":"write it"}'
          : call === 2
            ? '{"action":"tool","tool":"write","input":{"path":"a-very-distinctive-marker.cpp","content":"int main(){}"}}'
            : '{"action":"done","summary":"done"}';
      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    await harness.start();
    harness.sendLine('build something');
    for (let i = 0; i < 60 && harness.tui.getCurrentJob()?.status !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(harness.tui.getCurrentJob()?.status).toBe('completed');

    harness.sendKey('\r'); // enter Tail view, selects the (only) execution
    expect(harness.tui.getCurrentView()).toBe('tail');

    harness.sendKey('r');
    const buf = harness.getScreenBuffer();
    expect(buf).toContain('RAW MODEL RESPONSE');
    // 'done' never yields with `raw` attached, so the write tool_call's raw response
    // (the last turn that did) is what should still be showing.
    expect(buf).toContain('a-very-distinctive-marker.cpp');

    harness.sendKey('\x1b');
    expect(harness.getScreenBuffer()).not.toContain('RAW MODEL RESPONSE');

    harness.stop();
  });
});
