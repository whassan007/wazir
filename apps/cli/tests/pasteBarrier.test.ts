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
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { MemoryStore } from '@wazir/shared';
import type { RookEngine } from '../src/engine.js';
import { TuiTestHarness } from '../src/tui/inputHarness.js';
import { isScreenFragment } from '../src/tui/fleetTui.js';

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
    jobManager,
    worktrees,
    planner: createTaskPlanner(),
    adapters: new Map([['fake', fakeAdapter]]),
    discovered: [],
    worker: fakeWorker,
    store: new MemoryStore() as any,
  } as unknown as RookEngine & { jobManager: JobManager };
}

describe('Paste Barrier & Accidental Submission Circuit Breaker', () => {
  let projectRoot: string;
  let harness: TuiTestHarness | undefined;

  afterEach(async () => {
    if (harness) {
      harness.stop();
      harness = undefined;
    }
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('isScreenFragment', () => {
    it('detects pure border and box-drawing character lines', () => {
      expect(isScreenFragment('|')).toBe(true);
      expect(isScreenFragment('----------------.')).toBe(true);
      expect(isScreenFragment('------------------------------------------------')).toBe(true);
      expect(isScreenFragment('+---+')).toBe(true);
      expect(isScreenFragment('│')).toBe(true);
      expect(isScreenFragment('┌────┐')).toBe(true);
      expect(isScreenFragment('=====')).toBe(true);
      expect(isScreenFragment('·')).toBe(true);
      expect(isScreenFragment('•')).toBe(true);
      expect(isScreenFragment('   |   ')).toBe(true);
    });

    it('detects UI section and navigation headers', () => {
      expect(isScreenFragment('JOBS')).toBe(true);
      expect(isScreenFragment('EXECUTIONS')).toBe(true);
      expect(isScreenFragment('AGENTS')).toBe(true);
      expect(isScreenFragment('COMPUTERS')).toBe(true);
      expect(isScreenFragment('RUNTIMES')).toBe(true);
      expect(isScreenFragment('MODELS')).toBe(true);
      expect(isScreenFragment('WORKERS')).toBe(true);
      expect(isScreenFragment('POLICY APPROVAL QUEUE')).toBe(true);
      expect(isScreenFragment('QUICK ACTIONS')).toBe(true);
    });

    it('detects rendered screen prefixes and status patterns', () => {
      expect(isScreenFragment('WAZIR - CONTROL - WORKER: 3 COMPUTERS 7 AGENTS')).toBe(true);
      expect(isScreenFragment('Status: ◷ Job ...')).toBe(true);
      expect(isScreenFragment('History: [#59 + cmd]')).toBe(true);
      expect(isScreenFragment('Tail: task-job-mubdkllp-15-0 (|)')).toBe(true);
      expect(isScreenFragment('⠧ wazir-coding ...')).toBe(true);
      expect(isScreenFragment('..dkllp-15 |')).toBe(true);
      expect(isScreenFragment('wa> ')).toBe(true);
      expect(isScreenFragment('Context 0.0K/32K ~')).toBe(true);
      expect(isScreenFragment('> ◷ task-job-123')).toBe(true);
    });

    it('detects border-wrapped lines containing UI fragments', () => {
      expect(isScreenFragment('| ..dkllp-15 |')).toBe(true);
      expect(isScreenFragment('│ JOBS │')).toBe(true);
      expect(isScreenFragment('| -------------- |')).toBe(true);
    });

    it('allows legitimate user prompts and commands', () => {
      expect(isScreenFragment('build a C++ program that can sort an array')).toBe(false);
      expect(isScreenFragment('implement PRs 1,2,3')).toBe(false);
      expect(isScreenFragment('commit and cut the release')).toBe(false);
      expect(isScreenFragment('find files matching | in grep')).toBe(false);
      expect(isScreenFragment('/fanout task 1; task 2')).toBe(false);
      expect(isScreenFragment('/doctor')).toBe(false);
      expect(isScreenFragment('/model fake-model')).toBe(false);
    });
  });

  describe('Bracketed paste & Paste barrier', () => {
    it('inserts single-line paste into input buffer without auto-submitting', async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-paste-test-'));
      const engine = await buildFleetTestEngine(projectRoot);
      harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
      await harness.start();

      // Bracketed paste of single-line text
      harness.sendKey('\x1b[200~hello world\x1b[201~');

      // Verify text is in input buffer
      expect(harness.getScreenBuffer()).toContain('wa> hello world');

      // Verify mode remains NORMAL and NO job was launched
      expect(harness.tui.getMode()).toBe('NORMAL');
      expect(harness.tui.getCurrentJob()).toBeUndefined();
    });

    it('enters PASTE review mode on multiline paste and creates exactly 0 jobs until explicit Ctrl+Enter', async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-paste-test-'));
      const engine = await buildFleetTestEngine(projectRoot);
      harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
      await harness.start();

      const multilineText = 'first line\nsecond line\nthird line';

      // Bracketed paste sequence
      harness.sendKey('\x1b[200~');
      harness.sendKeys(multilineText);
      harness.sendKey('\x1b[201~');

      // Verify mode transitioned to PASTE
      expect(harness.tui.getMode()).toBe('PASTE');

      // Verify prompt shows [Pasted X characters / Y lines]
      const screen = harness.getScreenBuffer();
      expect(screen).toContain('[Pasted 33 characters / 3 lines]');
      expect(screen).toContain('[PASTE]');

      // Verify NO job has been started
      expect(harness.tui.getCurrentJob()).toBeUndefined();
      expect(engine.jobManager.list().length).toBe(0);

      // Bare Enter in PASTE mode must NOT submit jobs
      harness.sendKey('\r');
      expect(harness.tui.getMode()).toBe('PASTE');
      expect(engine.jobManager.list().length).toBe(0);

      // Explicit Ctrl+Enter submits as exactly ONE job
      harness.sendKey('\x1b\r'); // Ctrl+Enter sequence
      expect(harness.tui.getMode()).toBe('NORMAL');
      await new Promise((r) => setTimeout(r, 50));
      expect(engine.jobManager.list().length).toBe(1);
    });

    it('Esc in PASTE mode discards the pasted content', async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-paste-test-'));
      const engine = await buildFleetTestEngine(projectRoot);
      harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
      await harness.start();

      harness.sendKey('\x1b[200~line 1\nline 2\x1b[201~');
      expect(harness.tui.getMode()).toBe('PASTE');

      // Esc discards
      harness.sendKey('\x1b');
      expect(harness.tui.getMode()).toBe('NORMAL');
      expect(harness.tui.getPastedContent()).toBe('');
      expect(engine.jobManager.list().length).toBe(0);
      expect(harness.getScreenBuffer()).toContain('Pasted content discarded');
    });

    it('E in PASTE mode enters COMPOSER mode for multiline editing', async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-paste-test-'));
      const engine = await buildFleetTestEngine(projectRoot);
      harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
      await harness.start();

      harness.sendKey('\x1b[200~step 1\nstep 2\x1b[201~');
      expect(harness.tui.getMode()).toBe('PASTE');

      // Press 'e' to edit in composer
      harness.sendKey('e');
      expect(harness.tui.getMode()).toBe('COMPOSER');
      expect(harness.getScreenBuffer()).toContain('[COMPOSER]');

      // In composer, typing adds characters and Enter adds newlines
      harness.sendKey('\n');
      harness.sendKeys('step 3');

      // Bare Enter does not submit in composer
      expect(engine.jobManager.list().length).toBe(0);

      // Ctrl+Enter submits from composer
      harness.sendKey('\x1b\r');
      expect(harness.tui.getMode()).toBe('NORMAL');
      await new Promise((r) => setTimeout(r, 50));
      expect(engine.jobManager.list().length).toBe(1);
    });
  });

  describe('Accidental-Paste & Screen Fragment Rejection', () => {
    it('pasting the entire rendered Fleet screen creates exactly 0 jobs', async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-paste-test-'));
      const engine = await buildFleetTestEngine(projectRoot);
      harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
      await harness.start();

      // Literal rendered Fleet screen text containing borders, headers, and status lines
      const renderedScreenLines = [
        'WAZIR - CONTROL - WORKER: 1 COMPUTERS 1 AGENTS 1 MODELS [View: FLEET]                          Agents 0/2 - AVAILABLE',
        '------------------------------------------------------------------------------------------------------------------------',
        ' JOBS                            |  Routing: Agent [wazir-coding] - Type [native] - Caps [coding,agenticExecution]',
        '   (none)                        |  ----------------------------------------------------------------------------------',
        ' EXECUTIONS                      |  Agent: wazir-coding',
        '   (none)                        |  Description: Native Wazir coding agent',
        ' AGENTS                          |  Task Types: coding, debugging, code_analysis',
        ' > o wazir-coding                |',
        ' COMPUTERS                       |',
        '   + test-computer               |',
        ' RUNTIMES                        |',
        '   + fake-runtime                |',
        '                                 |',
        ' History: [No recorded blocks yet]',
        '------------------------------------------------------------------------------------------------------------------------',
        '   Status: Ready. Type a task or /fanout <t1; t2; ...> to begin.                            Context 0.0K/32K ~',
        'wa>',
      ];

      // Simulate rapid sequential submission (what happens on mouse copy-paste without bracketed paste)
      for (const line of renderedScreenLines) {
        harness.sendLine(line);
      }

      // CRITICAL ASSERTION: exactly 0 jobs must be created!
      expect(engine.jobManager.list().length).toBe(0);
      expect(harness.tui.getCurrentJob()).toBeUndefined();
    });

    it('rejects terminal fragments copied by mouse selection', async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-paste-test-'));
      const engine = await buildFleetTestEngine(projectRoot);
      harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
      await harness.start();

      // Submit individual fragments that occurred in the user bug report
      harness.sendLine('|');
      expect(engine.jobManager.list().length).toBe(0);

      harness.sendLine('----------------.');
      expect(engine.jobManager.list().length).toBe(0);

      harness.sendLine('JOBS');
      expect(engine.jobManager.list().length).toBe(0);

      harness.sendLine('EXECUTIONS');
      expect(engine.jobManager.list().length).toBe(0);

      harness.sendLine('Status: ◷ Job ...');
      expect(engine.jobManager.list().length).toBe(0);

      harness.sendLine('History: [#59 + cmd]');
      expect(engine.jobManager.list().length).toBe(0);

      harness.sendLine('Tail: task-job-mubdkllp-15-0 (|)');
      expect(engine.jobManager.list().length).toBe(0);

      expect(engine.jobManager.list().length).toBe(0);
    });

    it('burst rate guard trips on rapid non-fragment submissions', async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-paste-test-'));
      const engine = await buildFleetTestEngine(projectRoot);
      harness = new TuiTestHarness({ engine, concurrencyLimit: 4 });
      await harness.start();

      // Send 6 submissions in rapid succession
      for (let i = 1; i <= 6; i++) {
        void harness.tui.submitCommand(`task description ${i}`);
      }

      // After burst trips, subsequent submissions are refused
      expect(harness.tui.getStatusMessage()).toContain('SUBMISSION BURST DETECTED');
    });
  });

  describe('Explicit TUI Modes (COPY, PASTE, COMPOSER, NORMAL)', () => {
    it('Ctrl+Y toggles COPY mode and locks command submissions', async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-paste-test-'));
      const engine = await buildFleetTestEngine(projectRoot);
      harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
      await harness.start();

      expect(harness.tui.getMode()).toBe('NORMAL');

      // Ctrl+Y enters COPY mode
      harness.sendKey('\x19');
      expect(harness.tui.getMode()).toBe('COPY');
      expect(harness.getScreenBuffer()).toContain('[COPY]');

      // In COPY mode, Enter does NOT submit
      harness.sendKey('\r');
      expect(engine.jobManager.list().length).toBe(0);

      // Direct submission is also locked in COPY mode
      await harness.tui.submitCommand('do something');
      expect(engine.jobManager.list().length).toBe(0);
      expect(harness.tui.getStatusMessage()).toContain('disabled in COPY mode');

      // Esc exits COPY mode
      harness.sendKey('\x1b');
      expect(harness.tui.getMode()).toBe('NORMAL');
    });
  });
});
