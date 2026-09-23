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
  createTaskPlanner,
  type InteractiveSubmission,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { MemoryStore } from '@wazir/shared';
import type { RookEngine } from '../src/engine.js';
import { TuiTestHarness } from '../src/tui/inputHarness.js';
import { isScreenFragment } from '../src/tui/fleetTui.js';
import { listBlocks } from '../src/blocks.js';

async function buildTestEngine(projectRoot: string): Promise<RookEngine> {
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
    state: 'READY', // Fixture represents a model whose readiness probe already passed.
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
    async cancel() {},
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
          ? '{"action":"plan","content":"planning work"}'
          : '{"action":"done","summary":"completed"}';
      yield { type: 'token' as const, content: reply };
      yield {
        type: 'completed' as const,
        content: reply,
        usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
      };
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
    jobManager,
    worktrees,
    planner: createTaskPlanner(),
    adapters: new Map([['fake', fakeAdapter]]),
    discovered: [],
    worker: fakeWorker,
    store: new MemoryStore() as any,
  } as unknown as RookEngine & { jobManager: JobManager };
}

describe('Terminal & Control-Plane Integrity Acceptance Suite (15 Deterministic Tests)', () => {
  let projectRoot: string;
  let harness: TuiTestHarness | undefined;

  afterEach(async () => {
    if (harness) {
      harness.stop();
      harness = undefined;
    }
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // Test 1: Idle Redraw (1000 redraws -> 0 submissions, 0 blocks, 0 jobs)
  it('Test 1: Idle Redraw (1000 redraws -> 0 submissions, 0 blocks, 0 jobs)', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    // Perform 1,000 redraws (simulating high frame-rate idle repaint)
    for (let i = 0; i < 1000; i++) {
      harness.tui.draw();
    }

    expect(harness.tui.getProcessedSubmissionIds().size).toBe(0);
    const blocks = await listBlocks(engine);
    expect(blocks.length).toBe(0);
    expect(engine.jobManager.list().length).toBe(0);
  });

  // Test 2: Model streaming with TUI fragments -> 0 submissions
  it('Test 2: Model streaming with TUI fragments -> 0 submissions', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    // Stream model output fragments containing borders, wa> prompt, and headers into the TUI
    const fragmentStream = [
      'wa> write main.cpp',
      '|----------------------------------------------------|',
      'Status: [NORMAL] Planning task...',
      'JOBS | EXECUTIONS | AGENTS',
      '..dkllp-15 | task-job-1234',
      'Context 12.5K/32K ~',
    ];

    for (const chunk of fragmentStream) {
      // Simulate data listener emitting unbracketed text
      harness.sendKey(chunk);
    }

    expect(harness.tui.getProcessedSubmissionIds().size).toBe(0);
    const blocks = await listBlocks(engine);
    expect(blocks.length).toBe(0);
    expect(engine.jobManager.list().length).toBe(0);
  });

  // Test 3: Event stream -> 0 submissions
  it('Test 3: Event stream -> 0 submissions', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    // Emit 100 orchestrator events
    for (let i = 0; i < 100; i++) {
      (engine.orchestrator as any).emit('test-job', {
        type: 'task:progress',
        jobId: 'test-job',
        taskId: `task-${i}`,
        phase: 'executing',
        event: { kind: 'token', content: `token-${i} ` },
      });
    }

    expect(harness.tui.getProcessedSubmissionIds().size).toBe(0);
    const blocks = await listBlocks(engine);
    expect(blocks.length).toBe(0);
    expect(engine.jobManager.list().length).toBe(0);
  });

  // Test 4: Terminal resize (100 events) -> 0 submissions, 0 jobs
  it('Test 4: Terminal resize (100 events) -> 0 submissions, 0 jobs', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    for (let i = 0; i < 100; i++) {
      harness.outStream.columns = 80 + (i % 40);
      harness.outStream.rows = 24 + (i % 20);
      harness.outStream.emit('resize');
      harness.tui.draw();
    }

    expect(harness.tui.getProcessedSubmissionIds().size).toBe(0);
    const blocks = await listBlocks(engine);
    expect(blocks.length).toBe(0);
    expect(engine.jobManager.list().length).toBe(0);
  });

  // Test 5: Multiline paste -> 0 jobs before submit
  it('Test 5: Multiline paste -> 0 jobs before submit', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    // Send bracketed multiline paste
    harness.sendKey('\x1b[200~echo step1\necho step2\x1b[201~');

    // TUI must be in PASTE review mode
    expect(harness.tui.getMode()).toBe('PASTE');
    expect(harness.tui.getPastedContent()).toContain('echo step1\necho step2');

    // Press Enter - Enter in PASTE mode must NOT submit!
    harness.sendKey('\r');
    expect(harness.tui.getMode()).toBe('PASTE');

    expect(harness.tui.getProcessedSubmissionIds().size).toBe(0);
    const blocks = await listBlocks(engine);
    expect(blocks.length).toBe(0);
    expect(engine.jobManager.list().length).toBe(0);
  });

  // Test 6: Large real TUI screen paste -> 0 jobs created
  it('Test 6: Large real TUI screen paste -> 0 jobs created', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    const realTuiOutputLines = [
      'WAZIR - CONTROL - WORKER: 1 COMPUTERS | Agents: 1 registered | 0 active | 4 slots | Models: 1 registered | 1 ready',
      '----------------------------------------------------------------------------------------------------',
      ' JOBS                     |  Routing: Agent [wazir-coding] - Type [native]',
      '   ..dkllp-15             |  ---------------------------------------------',
      ' EXECUTIONS               |  Tail: task-job-1 (sort) | Status: [COMPLETED]',
      '   > o task-job-1         |  Tokens: In 500 / Out 120 (620 total)',
      ' AGENTS                   |',
      ' COMPUTERS                |',
      ' RUNTIMES                 |',
      ' History: [#1 + doctor]   |',
      '----------------------------------------------------------------------------------------------------',
      '  [NORMAL] Status: Ready.                                        Context 0.0K/32K ~',
      'wa> ',
    ];

    // Attempt to paste lines as discrete return-terminated fragments (mouse copy artifact)
    for (const line of realTuiOutputLines) {
      harness.sendLine(line);
    }

    expect(engine.jobManager.list().length).toBe(0);
    const blocks = await listBlocks(engine);
    expect(blocks.length).toBe(0);
  });

  // Test 7: Single Enter -> 1 SubmitEvent, 1 HistoryBlock, matching submissionId
  it('Test 7: Single Enter -> 1 SubmitEvent, 1 HistoryBlock, matching submissionId', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    // Type a command and press Enter
    harness.sendLine('task compile sort_test');

    // Wait for submission processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(harness.tui.getProcessedSubmissionIds().size).toBe(1);
    const submissionId = Array.from(harness.tui.getProcessedSubmissionIds())[0];

    const blocks = await listBlocks(engine);
    expect(blocks.length).toBe(1);
    expect(blocks[0].command).toBe('task compile sort_test');
    expect(blocks[0].submissionId).toBe(submissionId);
    expect(blocks[0].source).toBe('keyboard-submit');
    expect(blocks[0].sessionId).toBe(harness.tui.getSessionId());
  });

  // Test 8: Duplicate event with same submissionId -> rejected, 1 block
  it('Test 8: Duplicate event with same submissionId -> rejected, 1 block', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    const submission: InteractiveSubmission = {
      submissionId: 'sub-deterministic-dedup-uuid-1',
      sessionId: harness.tui.getSessionId(),
      source: 'keyboard-submit',
      text: 'task dedup test',
      timestamp: new Date(),
    };

    // First submission
    await harness.tui.submitInteractive(submission);
    // Duplicate submission with identical submissionId
    await harness.tui.submitInteractive(submission);

    expect(harness.tui.getProcessedSubmissionIds().size).toBe(1);
    const blocks = await listBlocks(engine);
    expect(blocks.length).toBe(1);
    expect(engine.jobManager.list().length).toBe(1);
  });

  // Test 9: Copy mode -> 0 submissions, 0 jobs
  it('Test 9: Copy mode -> 0 submissions, 0 jobs', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    // Toggle copy mode (Ctrl+Y)
    harness.sendKey('\u0019');
    expect(harness.tui.getMode()).toBe('COPY');

    // Attempt submission in COPY mode
    harness.sendLine('task copy mode test');

    expect(harness.tui.getProcessedSubmissionIds().size).toBe(0);
    const blocks = await listBlocks(engine);
    expect(blocks.length).toBe(0);
    expect(engine.jobManager.list().length).toBe(0);
  });

  // Test 10: Paste then discard -> 0 submissions, 0 jobs
  it('Test 10: Paste then discard -> 0 submissions, 0 jobs', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    // Paste multiline content
    harness.sendKey('\x1b[200~echo discard1\necho discard2\x1b[201~');
    expect(harness.tui.getMode()).toBe('PASTE');

    // Press Escape to discard
    harness.sendKey('\x1b');
    expect(harness.tui.getMode()).toBe('NORMAL');
    expect(harness.tui.getPastedContent()).toBe('');

    expect(harness.tui.getProcessedSubmissionIds().size).toBe(0);
    const blocks = await listBlocks(engine);
    expect(blocks.length).toBe(0);
    expect(engine.jobManager.list().length).toBe(0);
  });

  // Test 11: Paste then submit -> 1 submission, 1 block, 1 job
  it('Test 11: Paste then submit -> 1 submission, 1 block, 1 job', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    // Paste multiline content
    harness.sendKey('\x1b[200~task confirmed paste submission\nsecond line\x1b[201~');
    expect(harness.tui.getMode()).toBe('PASTE');

    // Press Ctrl+Enter to confirm paste submission
    harness.sendKey('\x1b\r');

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(harness.tui.getProcessedSubmissionIds().size).toBe(1);
    const blocks = await listBlocks(engine);
    expect(blocks.length).toBe(1);
    expect(blocks[0].source).toBe('confirmed-paste-submit');
    expect(engine.jobManager.list().length).toBe(1);
  });

  // Test 12: Prompt duplication assertion -> exactly 1 visible prompt
  it('Test 12: Prompt duplication assertion -> exactly 1 visible prompt', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    // Check prompt in NORMAL mode
    const lines1 = harness.getLines();
    const promptLine1 = lines1[lines1.length - 1] ?? '';
    const waCount1 = (promptLine1.match(/wa>/g) || []).length;
    expect(waCount1).toBe(1);

    // Paste text starting with "wa> "
    harness.sendKey('wa> my command');
    const lines2 = harness.getLines();
    const promptLine2 = lines2[lines2.length - 1] ?? '';
    // Must NOT be "wa> wa> my command"
    const waCount2 = (promptLine2.match(/wa>/g) || []).length;
    expect(waCount2).toBe(1);
  });

  // Test 13: History provenance -> block contains source, submissionId, sessionId
  it('Test 13: History provenance -> block contains source, submissionId, sessionId', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    harness.sendLine('task verify provenance tracking');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const blocks = await listBlocks(engine);
    expect(blocks.length).toBe(1);
    const b = blocks[0];
    expect(b.source).toBe('keyboard-submit');
    expect(typeof b.submissionId).toBe('string');
    expect(b.submissionId?.length).toBeGreaterThan(10);
    expect(b.sessionId).toBe(harness.tui.getSessionId());
    expect(b.status).toBeDefined();
    expect(b.jobId).toBeDefined();
  });

  // Test 14: Coding regression test
  it('Test 14: Coding regression test (task execution path preserves plan -> route -> model -> done)', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    harness.sendLine('write sort algorithm in main.cpp');
    await new Promise((resolve) => setTimeout(resolve, 300));

    const jobs = engine.jobManager.list();
    expect(jobs.length).toBe(1);
    const job = jobs[0];
    expect(job.title).toContain('write sort algorithm');
    expect(job.tasks.length).toBeGreaterThan(0);
    expect(harness.tui.getAgents()[0]?.agentId).toBe('wazir-coding');
  });

  // Test 15: Token accounting: current context != cumulative input, cumulative = sum(turn tokens), model call count tracked
  it('Test 15: Token accounting: current context != cumulative input, cumulative = sum(turn tokens), model call count tracked', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integrity-test-'));
    const engine = await buildTestEngine(projectRoot);
    harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
    await harness.start();

    harness.sendLine('task multi-turn token test');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const job = engine.jobManager.list()[0];
    expect(job).toBeDefined();
    const taskId = job.tasks[0].id;

    // Reset card state to cleanly measure simulated turns
    const card = harness.tui.getAgents().find((a) => a.taskId === taskId);
    if (card) {
      card.usage = undefined;
      card.modelCallCount = 0;
    }

    // Simulate Turn 1: prompt size = 4,000, completion = 200
    (engine.orchestrator as any).emit(job.id, {
      type: 'task:progress',
      jobId: job.id,
      taskId,
      event: {
        kind: 'usage',
        usage: { input: 4000, output: 200, total: 4200 },
        breakdown: { system: 1000, tools: 500, task: 500, plan: 1000, history: 500, repository: 500 },
      },
    });

    // Simulate Turn 2: prompt size = 6,500, completion = 350
    (engine.orchestrator as any).emit(job.id, {
      type: 'task:progress',
      jobId: job.id,
      taskId,
      event: {
        kind: 'usage',
        usage: { input: 6500, output: 350, total: 6850 },
        breakdown: { system: 1000, tools: 500, task: 500, plan: 1500, history: 2000, repository: 1000 },
      },
    });

    const metrics = harness.tui.getContextMetrics();

    // 1. Current context reflects the prompt size of the latest turn (6,500), NOT cumulative (10,500)
    expect(metrics.used).toBe(6500);

    // 2. Cumulative input is the sum of turn inputs (4,000 + 6,500 = 10,500)
    expect(metrics.jobIn).toBe(10500);

    // 3. Explicit assertion: current context != cumulative input
    expect(metrics.used).not.toBe(metrics.jobIn);

    // 4. Model call count is accurately tracked (2 turns)
    expect(metrics.calls).toBe(2);

    // 5. Cumulative output is sum of turn outputs (200 + 350 = 550)
    expect(metrics.jobOut).toBe(550);
  });
});
