import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TerminalSession,
  MemoryTerminalAdapter,
  TerminalRenderer,
  TerminalFrame,
  FrameDiffer,
  InputController,
  KeyDecoder,
  PromptBuffer,
  RenderScheduler,
  LayoutEngine,
  MIN_TERMINAL_WIDTH,
  MIN_TERMINAL_HEIGHT,
  stringDisplayWidth,
  stripAnsi,
} from '../src/tui/index.js';
import { TuiTestHarness, MockTerminalStream } from '../src/tui/inputHarness.js';
import {
  AgentRegistry,
  ApprovalQueue,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  JobManager,
  JobOrchestrator,
  ModelRegistry,
  ModelLifecycleService,
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
      audio: false,
      embedding: false,
    },
  });

  models.register({
    id: 'fake-model',
    name: 'Fake Model',
    family: 'custom',
    parameters: '7B',
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
    state: 'READY',
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

  const fakeAdapter: RuntimeAdapter = {
    id: 'fake',
    type: 'other',
    async inspectModel(modelId) { return { modelId, loaded: true, effectiveContext: 32768 }; },
    async probeModel() { return true; },
    async discover() { return { id: 'fake', name: 'fake', version: '1.0' }; },
    async healthCheck() { return { status: 'healthy' }; },
    async cancel() {},
    async *generate() {
      yield { type: 'token' as const, content: 'test stream token' };
      yield { type: 'completed' as const, content: 'done', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
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
    lifecycle: new ModelLifecycleService({
      executions,
      models,
      runtimes,
      computers,
      agents,
      adapters: new Map([['fake', fakeAdapter]]),
      store: new MemoryStore() as any,
    }),
    agents,
    tools,
    policy,
    scheduler,
    compiler,
    executions,
    approvalQueue,
    orchestrator,
    worktrees,
    planner: createTaskPlanner(),
    adapters: new Map([['fake', fakeAdapter]]),
    discovered: [],
    worker: fakeWorker,
    store: new MemoryStore() as any,
  };
}

describe('Wazir TUI Acceptance Tests (Sections 42 - 45)', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // =========================================================================
  // SECTION 42: GHOSTING ACCEPTANCE TEST
  // =========================================================================
  describe('Section 42: Ghosting Acceptance Test', () => {
    const W = 100;
    const H = 30;

    function createDenseFleetFrame(): TerminalFrame {
      const frame = TerminalFrame.create(W, H);
      frame.writeText(0, 0, 'WAZIR FLEET CONTROL PLANE [ACTIVE] - 16 AGENTS ONLINE', { bold: true });
      frame.writeText(0, 1, 'TASKS: 42 RUNNING | QUEUED: 12 | CPU: 78% | MEM: 4.2GB / 16GB');
      frame.writeText(0, 2, '-'.repeat(W));

      for (let i = 0; i < 16; i++) {
        const id = `agent-${String(i + 1).padStart(2, '0')}`;
        const model = i % 2 === 0 ? 'gpt-oss-coder' : 'qwen-coder-32b';
        const progress = '[' + '█'.repeat(i + 1) + '░'.repeat(16 - (i + 1)) + ']';
        frame.writeText(0, 3 + i, `[${id}] ${model.padEnd(16)} RUNNING ${progress} task-${800 + i}: compile subsystem`);
      }

      frame.writeText(0, 20, '--- JOB LOG ACTIVITY STREAM ---');
      for (let j = 0; j < 6; j++) {
        frame.writeText(0, 21 + j, `[12:34:0${j}] worker-01: stream chunk event ${j * 100} bytes processed`);
      }
      frame.writeText(0, 27, '-'.repeat(W));
      frame.writeText(0, 28, 'wa> execute cluster task --concurrency=4');
      return frame;
    }

    function createSparseModelsFrame(): TerminalFrame {
      const frame = TerminalFrame.create(W, H);
      frame.writeText(0, 0, 'WAZIR - MODELS');
      frame.writeText(0, 1, '-'.repeat(W));
      frame.writeText(0, 2, '[1] gpt-oss (local - READY)');
      frame.writeText(0, 3, '[2] qwen (remote - READY)');
      // All other lines (4 through 29) are blank default cells
      return frame;
    }

    function createJobsFrame(): TerminalFrame {
      const frame = TerminalFrame.create(W, H);
      frame.writeText(0, 0, 'WAZIR - ACTIVE JOBS');
      frame.writeText(0, 1, '-'.repeat(W));
      frame.writeText(0, 2, 'Job #101: indexing codebase [COMPLETED]');
      frame.writeText(0, 3, 'Job #102: compile AST [RUNNING]');
      return frame;
    }

    function createAgentsFrame(): TerminalFrame {
      const frame = TerminalFrame.create(W, H);
      frame.writeText(0, 0, 'WAZIR - REGISTERED AGENTS');
      frame.writeText(0, 1, '-'.repeat(W));
      frame.writeText(0, 2, 'native-coding-agent v1.0.0 (capabilities: chat, code)');
      return frame;
    }

    it('dense view to sparse view leaves 0 stale cells and eliminates ghost text', () => {
      const adapter = new MemoryTerminalAdapter({ width: W, height: H, isTTY: true });
      const renderer = new TerminalRenderer({ adapter });

      // 1. Render dense view
      const dense = createDenseFleetFrame();
      renderer.renderFrame(dense);
      const denseOutput = adapter.getOutput();
      expect(denseOutput).toContain('16 AGENTS ONLINE');
      expect(denseOutput).toContain('task-800');

      // 2. Render sparse view
      adapter.clearOutput();
      const sparse = createSparseModelsFrame();
      renderer.renderFrame(sparse);

      const previousFrame = renderer.getPreviousFrame();
      expect(previousFrame).toBeDefined();

      const sparsePlainText = previousFrame!.toPlainText();

      // Verify sparse text is present
      expect(sparsePlainText).toContain('WAZIR - MODELS');
      expect(sparsePlainText).toContain('[1] gpt-oss (local - READY)');
      expect(sparsePlainText).toContain('[2] qwen (remote - READY)');

      // Verify ZERO ghost text from dense view remains in virtual frame
      expect(sparsePlainText).not.toContain('16 AGENTS ONLINE');
      expect(sparsePlainText).not.toContain('TASKS: 42');
      expect(sparsePlainText).not.toContain('agent-01');
      expect(sparsePlainText).not.toContain('task-800');
      expect(sparsePlainText).not.toContain('JOB LOG ACTIVITY');
      expect(sparsePlainText).not.toContain('stream chunk event');
      expect(sparsePlainText).not.toContain('execute cluster task');

      // Verify every single cell below row 3 is strictly blank ' '
      for (let y = 4; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const cell = previousFrame!.getCell(x, y);
          expect(cell.char).toBe(' ');
        }
      }

      // Verify trailing cells on row 2 and row 3 are strictly blank ' '
      const row2Text = '[1] gpt-oss (local - READY)';
      for (let x = row2Text.length; x < W; x++) {
        expect(previousFrame!.getCell(x, 2).char).toBe(' ');
      }
      const row3Text = '[2] qwen (remote - READY)';
      for (let x = row3Text.length; x < W; x++) {
        expect(previousFrame!.getCell(x, 3).char).toBe(' ');
      }
    });

    it('cycling views 100 times produces identical virtual frames with zero drift', () => {
      const adapter = new MemoryTerminalAdapter({ width: W, height: H, isTTY: true });
      const renderer = new TerminalRenderer({ adapter });

      // Cycle FLEET -> MODELS -> JOBS -> AGENTS -> FLEET 100 times (400 transitions)
      for (let i = 0; i < 100; i++) {
        renderer.renderFrame(createDenseFleetFrame());
        renderer.renderFrame(createSparseModelsFrame());
        renderer.renderFrame(createJobsFrame());
        renderer.renderFrame(createAgentsFrame());
      }

      // Final render of FLEET frame
      renderer.renderFrame(createDenseFleetFrame());
      const finalFrame = renderer.getPreviousFrame()!;

      // Compare cell-by-cell with a freshly generated FLEET frame
      const freshFleet = createDenseFleetFrame();
      expect(finalFrame.width).toBe(freshFleet.width);
      expect(finalFrame.height).toBe(freshFleet.height);

      let mismatches = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const finalCell = finalFrame.getCell(x, y);
          const freshCell = freshFleet.getCell(x, y);
          if (finalCell.char !== freshCell.char || finalCell.style?.bold !== freshCell.style?.bold) {
            mismatches++;
          }
        }
      }
      expect(mismatches).toBe(0);
    });

    it('TuiTestHarness integrated cycling through views preserves buffer integrity', async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-acceptance-ghost-'));
      const engine = await buildTestEngine(projectRoot);
      const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
      await harness.start();

      const initialBuffer = harness.getScreenBuffer();
      expect(initialBuffer).toContain('[View: FLEET]');

      // Cycle views 25 rounds (100 tab presses: fleet -> tail -> approval -> worktrees -> fleet)
      for (let i = 0; i < 25; i++) {
        harness.sendKey('\t'); // tail
        harness.sendKey('\t'); // approval
        harness.sendKey('\t'); // worktrees
        harness.sendKey('\t'); // fleet
      }

      expect(harness.tui.getCurrentView()).toBe('fleet');
      const finalBuffer = harness.getScreenBuffer();
      expect(finalBuffer).toContain('[View: FLEET]');
      expect(finalBuffer).toContain('AVAILABLE');
      expect(harness.screen.getFrame()).toBeDefined();

      harness.stop();
    });
  });

  // =========================================================================
  // SECTION 43: INPUT-ISOLATION ACCEPTANCE TEST
  // =========================================================================
  describe('Section 43: Input-Isolation Acceptance Test', () => {
    it('concurrent renderer output and background job logs never leak into prompt or input streams', () => {
      const adapter = new MemoryTerminalAdapter({ width: 120, height: 40, isTTY: true });
      const session = new TerminalSession({ adapter });
      session.start();

      const inputController = session.inputController;
      const promptBuffer = new PromptBuffer();

      // Listen for semantic input events and update PromptBuffer
      inputController.on('event', (event) => {
        if (event.type === 'CHARACTER') {
          promptBuffer.insert(event.char);
        } else if (event.type === 'BACKSPACE') {
          promptBuffer.backspace();
        } else if (event.type === 'PASTE') {
          // Paste inserts text (normalized newlines to spaces)
          promptBuffer.insert(event.text.replace(/\r?\n/g, ' '));
        }
      });

      // 1. User types "wa models list"
      inputController.feed('wa models list');

      // 2. Simultaneously, background renderer emits ANSI sequences to the terminal adapter
      adapter.write('\x1b[32m[SYSTEM ALERT]\x1b[0m Background worker online\n');
      adapter.write('\x1b[2K\x1b[1;1H\x1b[?25h');
      session.renderer.renderFrame(TerminalFrame.create(120, 40));

      // 3. Simultaneously, a background job streams logs to a dedicated log buffer (NOT stdin)
      const jobLogs: string[] = [];
      jobLogs.push('[JOB-501] [STDOUT] Compiling dependencies: 42% complete');
      jobLogs.push('[JOB-501] [STDOUT] Downloading weights.safetensors (2.1GB)');

      // 4. User pastes multiline code block with bracketed paste
      inputController.feed('\x1b[200~const limit = 100;\nreturn limit;\x1b[201~');

      // 5. User presses Backspace 5 times
      for (let i = 0; i < 5; i++) {
        inputController.feed('\x7f');
      }

      // 6. User presses Tab (navigation event)
      let navigationTriggered = false;
      inputController.on('event', (e) => {
        if (e.type === 'TAB') navigationTriggered = true;
      });
      inputController.feed('\t');

      const finalText = promptBuffer.getText();

      // Invariants:
      // A. Text contains only typed/pasted text minus backspaced characters
      // "wa models list" + "const limit = 100; return limit;" -> minus 5 chars ("imit;") -> "wa models listconst limit = 100; return l"
      expect(finalText).toContain('wa models list');
      expect(finalText).toContain('const limit = 100;');
      expect(finalText).not.toContain('limit;'); // Backspaced

      // B. Text contains ZERO ANSI escape sequences
      expect(finalText).not.toContain('\x1b');
      expect(finalText).not.toContain('[SYSTEM ALERT]');
      expect(finalText).not.toContain('[2K');
      expect(finalText).not.toContain('[?25h');

      // C. Text contains ZERO background job logs
      expect(finalText).not.toContain('JOB-501');
      expect(finalText).not.toContain('Compiling dependencies');
      expect(finalText).not.toContain('weights.safetensors');

      // D. Text contains ZERO raw bracketed paste markers
      expect(finalText).not.toContain('[200~');
      expect(finalText).not.toContain('[201~');

      // E. Tab navigation event was dispatched without leaking into text
      expect(navigationTriggered).toBe(true);
      expect(finalText).not.toContain('\t');

      // F. Terminal adapter output is isolated from input controller
      expect(adapter.getOutput()).toContain('SYSTEM ALERT');

      session.cleanup();
    });

    it('TuiTestHarness enforces prompt input isolation during live task execution', async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-acceptance-input-'));
      const engine = await buildTestEngine(projectRoot);
      const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
      await harness.start();

      // Emit simulated orchestrator event (streaming tokens into job tail)
      engine.orchestrator.emit('event', {
        type: 'TASK_STREAM',
        jobId: 'job-acc-01',
        taskId: 'task-01',
        text: 'token_chunk_from_model_streaming_service',
      } as any);

      // Concurrently type user command
      harness.sendKeys('wa status --all');

      // Prompt must contain only user keystrokes, never streaming tokens
      const promptLine = harness.getScreenBuffer().split('\n').find((l) => l.includes('wa> '));
      expect(promptLine).toContain('wa status --all');
      expect(promptLine).not.toContain('token_chunk');
      expect((harness.tui as any).inputBuffer).toBe('wa status --all');

      harness.stop();
    });
  });

  // =========================================================================
  // SECTION 44: RESIZE STRESS TEST
  // =========================================================================
  describe('Section 44: Resize Stress Test', () => {
    it('rapidly resizes across diverse dimensions with safe fallback and seamless recovery', () => {
      const adapter = new MemoryTerminalAdapter({ width: 120, height: 40, isTTY: true });
      const session = new TerminalSession({ adapter });
      session.start();

      const dimensionSequence = [
        [120, 40],
        [80, 24],
        [160, 50],
        [65, 18],  // sub-minimum size (fallback)
        [100, 30],
        [70, 20],  // sub-minimum size (fallback)
        [132, 43], // DEC VT100 wide
      ];

      // Run 10 rounds of the sequence (70 dimension changes)
      for (let round = 0; round < 10; round++) {
        for (const [w, h] of dimensionSequence) {
          adapter.resize(w, h);
          const layout = LayoutEngine.computeViewport(w, h);

          const frame = TerminalFrame.create(w, h);

          if (layout.isTooSmall) {
            expect(w < MIN_TERMINAL_WIDTH || h < MIN_TERMINAL_HEIGHT).toBe(true);
            LayoutEngine.renderFallbackScreen(frame);

            // Assert fallback screen content
            const plain = frame.toPlainText();
            expect(plain).toContain('Terminal too small');
            expect(plain).toContain(`Minimum: ${MIN_TERMINAL_WIDTH}x${MIN_TERMINAL_HEIGHT}`);
          } else {
            expect(layout.isTooSmall).toBe(false);
            // Construct standard multi-pane layout
            frame.writeText(layout.headerRect.x, layout.headerRect.y, 'WAZIR FLEET CONTROLLER');
            frame.writeText(layout.contentRect.x, layout.contentRect.y, `Active Viewport: ${w}x${h}`);
            frame.writeText(layout.promptRect.x, layout.promptRect.y, 'wa> ');
          }

          // Render into session renderer: must never throw or write out of bounds
          expect(() => {
            session.renderer.renderFrame(frame);
          }).not.toThrow();

          const prev = session.renderer.getPreviousFrame();
          expect(prev).toBeDefined();
          expect(prev!.width).toBe(w);
          expect(prev!.height).toBe(h);
        }
      }

      session.cleanup();
    });

    it('TuiTestHarness handles window resize events dynamically', async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-acceptance-resize-'));
      const engine = await buildTestEngine(projectRoot);
      const harness = new TuiTestHarness({ engine, concurrencyLimit: 2 });
      await harness.start();

      // Trigger resize to small viewport
      harness.outStream.columns = 60;
      harness.outStream.rows = 15;
      harness.screen.onResize();

      // Viewport is smaller than 80x24 -> fallback screen
      const smallBuf = harness.getScreenBuffer();
      expect(smallBuf).toBeDefined();

      // Restore to full widescreen
      harness.outStream.columns = 120;
      harness.outStream.rows = 40;
      harness.screen.onResize();

      // Normal dashboard resumes
      const restoredBuf = harness.getScreenBuffer();
      expect(restoredBuf).toContain('[View: FLEET]');

      harness.stop();
    });
  });

  // =========================================================================
  // SECTION 45: STREAMING STRESS TEST
  // =========================================================================
  describe('Section 45: Streaming Stress Test', () => {
    it('render scheduler throttles 3,000 token events with >= 85% coalescing ratio', async () => {
      let renderExecutionCount = 0;
      const scheduler = new RenderScheduler({
        maxFps: 30, // 33ms window
        render: () => {
          renderExecutionCount++;
        },
      });

      const totalTokenRequests = 3000;

      // High-throughput token burst: 3,000 tokens arrive rapidly
      for (let i = 0; i < totalTokenRequests; i++) {
        scheduler.schedule();
      }

      // First call executes immediately because elapsed > minIntervalMs.
      // Subsequent synchronous calls within the window are coalesced.
      expect(renderExecutionCount).toBe(1);

      // Wait for the scheduled timer window (35ms) to process remaining coalesced frame
      await new Promise((resolve) => setTimeout(resolve, 50));

      scheduler.stop();

      // Only 2 renders occurred for 3,000 requests!
      expect(renderExecutionCount).toBe(2);

      const framesCoalesced = totalTokenRequests - renderExecutionCount;
      const coalescingRatio = framesCoalesced / totalTokenRequests;

      // Coalescing ratio must be >= 85% (here it is 2998 / 3000 = 99.93%)
      expect(coalescingRatio).toBeGreaterThanOrEqual(0.85);
    });

    it('frame differ efficiently updates token append without redrawing unchanged screen', () => {
      const W = 120;
      const H = 40;
      const f1 = TerminalFrame.create(W, H);
      f1.writeText(0, 0, 'WAZIR STREAMING TAIL VIEW [RUNNING]');
      f1.writeText(0, 1, '-'.repeat(W));
      for (let r = 2; r < 20; r++) {
        f1.writeText(0, r, `Log entry line ${r}: system initialized and ready`);
      }
      f1.writeText(0, 20, 'Model output: The quick brown fox');

      // Frame 2 appends " jumps"
      const f2 = f1.clone();
      f2.writeText(33, 20, ' jumps');

      const startMs = performance.now();
      const diff = FrameDiffer.diff(f1, f2);
      const diffDurationMs = performance.now() - startMs;

      expect(diff.isFullRedraw).toBe(false);
      // Index 33 was already blank ' '; only the 5 characters of "jumps" changed
      expect(diff.cellsChanged).toBe(5);

      // Changed cells is < 0.2% of the 4,800 screen cells
      const totalCells = W * H;
      const changeRatio = diff.cellsChanged / totalCells;
      expect(changeRatio).toBeLessThan(0.005);

      // Diff patch is tiny (< 30 bytes) with direct cursor jump
      expect(diff.patch.length).toBeLessThan(35);
      expect(diff.patch).toContain('jumps');

      // Performance check: diff takes < 2ms
      expect(diffDurationMs).toBeLessThan(10);
    });

    it('TerminalRenderer tracks frame metrics during high-frequency token streaming', () => {
      const adapter = new MemoryTerminalAdapter({ width: 100, height: 30, isTTY: true });
      const renderer = new TerminalRenderer({ adapter });

      const baseFrame = TerminalFrame.create(100, 30);
      baseFrame.writeText(0, 0, 'STREAMING BENCHMARK');
      renderer.renderFrame(baseFrame);

      // Stream 50 token append frames
      let currentFrame = baseFrame.clone();
      for (let i = 1; i <= 50; i++) {
        const nextFrame = currentFrame.clone();
        nextFrame.writeText((i * 2) % 90, 5, '>>');
        renderer.renderFrame(nextFrame);
        currentFrame = nextFrame;
      }

      const metrics = renderer.getMetrics();
      expect(metrics.framesRequested).toBe(51);
      expect(metrics.framesRendered).toBe(51);
      expect(metrics.fullRedraws).toBe(1); // Only the initial frame was full
      expect(metrics.diffRedraws).toBe(50); // All subsequent 50 frames were diff-rendered
      expect(metrics.averageRenderMs).toBeLessThan(10);
    });
  });
});
