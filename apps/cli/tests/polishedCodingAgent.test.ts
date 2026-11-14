import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import xtermPkg from '@xterm/headless';
const { Terminal } = xtermPkg;
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
  WorkloadDistributor,
  createTaskPlanner,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { MemoryStore } from '@wazir/shared';
import type { RookEngine } from '../src/engine.js';
import { createBootstrapEngine } from '../src/engine.js';
import { TuiTestHarness } from '../src/tui/inputHarness.js';
import {
  createConversationSession,
  saveConversationSession,
  listConversationSessions,
  reconcileSessionJobs,
} from '../src/tui/sessionStore.js';
import { sanitizeAssistantText, styleInlineMarkdown } from '../src/tui/markdownRenderer.js';
import { createConversationTheme, renderConversationHeader } from '../src/tui/theme.js';
import { truncateToDisplayWidth } from '../src/tui/unicode.js';
import { parseWorkloadDistribution } from '@wazir/core';
import { resolvePromptFileMentions } from '../src/tui/completionEngine.js';

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wazir-polished-agent-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@wazir.dev'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Wazir Test'], { cwd: dir });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'router.ts'), 'export function route(x: string) {\n  return x.trim();\n}\n');
  writeFileSync(path.join(dir, 'README.md'), '# Sample Repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function buildMockEngine(projectRoot: string, opts: { withModel?: boolean; delayMs?: number } = {}): Promise<{ engine: RookEngine; store: MemoryStore }> {
  const withModel = opts.withModel ?? true;
  const store = new MemoryStore();
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();
  const executions = new ExecutionEngine(store);
  const approvalQueue = new ApprovalQueue();
  const worktrees = new WorktreeManager();

  computers.register({
    id: 'local',
    name: 'm5-pro-local',
    type: 'workstation',
    local: true,
    os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
    hardware: { cpu: 'Apple M5 Pro', cpuCores: 14, memoryGB: 48 },
    capabilities: ['localExecution'],
  });

  if (withModel) {
    const mockAdapter: RuntimeAdapter = {
      id: 'ollama',
      type: 'local',
      discoverModels: async () => ['qwen3-coder:30b', 'llama3.3:70b'],
      healthCheck: async () => true,
      generate: async ({ prompt }) => {
        if (opts.delayMs) {
          await new Promise((r) => setTimeout(r, opts.delayMs));
        }
        return {
          output: `<think>internal chain of thought that must stay hidden</think>\nI inspected the repository and prepared the requested update.\n\n\`\`\`ts\nexport const ready = true;\n\`\`\`\nEcho: ${prompt.slice(-80).replace(/\s+/g, ' ')}`,
          tokensUsed: 120,
          promptTokens: 80,
          completionTokens: 40,
        };
      },
      stream: async function* () {
        yield { content: 'stream chunk', done: true };
      },
    };
    runtimes.register(mockAdapter);
    models.register({
      id: 'ollama:qwen3-coder:30b',
      name: 'qwen3-coder:30b',
      provider: 'ollama',
      runtimeId: 'ollama',
      computerId: 'local',
      capabilities: ['coding', 'reasoning', 'toolUse'],
      local: true,
      contextWindow: 65536,
    });
    models.register({
      id: 'ollama:llama3.3:70b',
      name: 'llama3.3:70b',
      provider: 'ollama',
      runtimeId: 'ollama',
      computerId: 'local',
      capabilities: ['coding', 'reasoning'],
      local: true,
      contextWindow: 65536,
    });
  }

  const policyEngine = new PolicyEngine([
    { id: 'allow-all', name: 'Allow All', scope: 'global', allowedTools: ['*'], deniedTools: [] },
  ]);
  agents.register(createCodingAgent({ runtimes, tools, policyEngine }));

  const scheduler = new Scheduler({ computers, models, runtimes });
  const jobs = new JobManager(store);
  const planner = createTaskPlanner({ runtimes, models });
  const localWorker: Worker = {
    computerId: 'local',
    capabilities: ['coding', 'reasoning', 'toolUse', 'localExecution'],
    maxConcurrent: 2,
    activeCount: 0,
    execute: async (task, model, context) => {
      const agent = agents.get('coding')!;
      return agent.execute(task, context, model);
    },
  };
  const orchestrator = new JobOrchestrator({
    jobs,
    planner,
    scheduler,
    compiler,
    workers: new Map([['local', localWorker]]),
    tools,
    models,
    executions,
    approvalQueue,
    policyEngine,
  });

  const engine: RookEngine = {
    projectRoot,
    config: { ollamaUrl: 'http://127.0.0.1:11434', defaultRoutingMode: 'local-preferred' } as any,
    store,
    computers,
    runtimes,
    models,
    agents,
    tools,
    compiler,
    scheduler,
    executions,
    jobs,
    planner,
    orchestrator,
    policyEngine,
    approvalQueue,
    worktrees,
    secretBroker: { backendName: 'encrypted-file' } as any,
  };
  return { engine, store };
}

async function flushToXterm(harness: TuiTestHarness, xterm: InstanceType<typeof Terminal>, waitMs = 15): Promise<string> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, waitMs));
  const rawOutput = harness.outStream.getOutput();
  harness.outStream.clearOutput();
  if (!rawOutput) return '';
  // Mirror standard POSIX ONLCR translation performed by a real kernel PTY line discipline
  const ptyTranslated = rawOutput.replace(/\r?\n/g, '\r\n');
  await new Promise<void>((resolve) => xterm.write(ptyTranslated, resolve));
  return rawOutput;
}

function readXtermText(xterm: InstanceType<typeof Terminal>): string {
  const buf = xterm.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)?.translateToString(true) ?? '';
    lines.push(line);
  }
  return lines.join('\n').trimEnd();
}

describe('Polished Terminal Coding Agent (wa / wazir) — End-to-End Acceptance Suite', () => {
  it('1. fixes horizontal cursor movement defect in real @xterm/headless (Left, Right, Home, End, mid-line insert/delete)', async () => {
    const workspace = makeTempWorkspace();
    const { engine } = await buildMockEngine(workspace);
    const xterm = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
    const harness = new TuiTestHarness({
      engine,
      presentationMode: 'conversation',
      colorMode: 'monochrome',
    });
    harness.inStream.columns = 100;
    harness.inStream.rows = 30;
    harness.outStream.columns = 100;
    harness.outStream.rows = 30;

    await harness.start();
    await flushToXterm(harness, xterm);

    // Bounded composer prefix is "  › " (4 columns: 2-space margin + glyph + space)
    const prefixCols = 4;
    expect(xterm.buffer.active.cursorX).toBe(prefixCols);

    harness.sendKeys('hello world');
    await flushToXterm(harness, xterm);
    expect(xterm.buffer.active.cursorX).toBe(prefixCols + 'hello world'.length);

    // Move left 5 characters ("world"): cursorX MUST update even though prompt text did not change!
    for (let i = 0; i < 5; i++) {
      harness.sendKey('\x1b[D');
    }
    const leftMoveOutput = await flushToXterm(harness, xterm);
    expect(leftMoveOutput.length).toBeGreaterThan(0);
    expect(xterm.buffer.active.cursorX).toBe(prefixCols + 'hello '.length);

    // Mid-line insertion at cursor
    harness.sendKeys('brave ');
    await flushToXterm(harness, xterm);
    expect(xterm.buffer.active.cursorX).toBe(prefixCols + 'hello brave '.length);
    expect(readXtermText(xterm)).toContain('hello brave world');

    // Home jumps to start of line (col 4), End jumps to end of line
    harness.sendKey('\x1b[H');
    await flushToXterm(harness, xterm);
    expect(xterm.buffer.active.cursorX).toBe(prefixCols);

    harness.sendKey('\x1b[F');
    await flushToXterm(harness, xterm);
    expect(xterm.buffer.active.cursorX).toBe(prefixCols + 'hello brave world'.length);

    harness.stop();
    xterm.dispose();
  });

  it('2. handles Unicode combining accents, CJK wide glyphs, ZWJ emoji, multiline shortcuts, paste, and draft-preserving history', async () => {
    const workspace = makeTempWorkspace();
    const { engine } = await buildMockEngine(workspace);
    const xterm = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const harness = new TuiTestHarness({
      engine,
      presentationMode: 'conversation',
      colorMode: 'monochrome',
    });

    await harness.start();
    await flushToXterm(harness, xterm);

    const prefixCols = 4;
    // CJK (2 cols each = 4 cols) + space (1) + ZWJ emoji 👩‍💻 (2 cols) + combining accent e\u0301 (1 col) = 8 display columns
    harness.tui.handleKey('你好 👩‍💻e\u0301');
    await flushToXterm(harness, xterm);
    expect(xterm.buffer.active.cursorX).toBe(prefixCols + 4 + 1 + 2 + 1);

    // Single Backspace deletes entire grapheme cluster 'e\u0301', next Backspace deletes entire ZWJ emoji '👩‍💻'
    harness.sendKey('\x7f');
    await flushToXterm(harness, xterm);
    expect(xterm.buffer.active.cursorX).toBe(prefixCols + 4 + 1 + 2);

    harness.sendKey('\x7f');
    await flushToXterm(harness, xterm);
    expect(xterm.buffer.active.cursorX).toBe(prefixCols + 4 + 1);

    // Clear line via Ctrl+U and test multiline newline chords: Ctrl+J, trailing \ + Enter, and Kitty Shift+Enter
    harness.sendKey('\x15');
    harness.sendKeys('first line');
    harness.tui.handleKey('\n', { sequence: '\n', name: 'enter', ctrl: false, meta: false, shift: false }); // Ctrl+J
    harness.sendKeys('second line\\');
    harness.sendKey('\r'); // trailing backslash + Enter fallback -> newline!
    harness.sendKeys('third line');
    harness.sendKey('\x1b[13;2u'); // Kitty Shift+Enter -> newline!
    harness.sendKeys('fourth line');
    await flushToXterm(harness, xterm);

    const screenText = readXtermText(xterm);
    expect(screenText).toContain('fourth line');

    // Bracketed paste of multi-line snippet enters paste barrier (never submits prematurely), and 'e' edits in composer
    harness.sendKey('\x15');
    harness.tui.handleKey('\x1b[200~const a = 1;\nconst b = 2;\nconst c = 3;\x1b[201~');
    await flushToXterm(harness, xterm);
    expect(readXtermText(xterm)).toContain('Pasted 38 chars / 3 lines');
    harness.sendKey('e');
    await flushToXterm(harness, xterm);
    expect(readXtermText(xterm)).toContain('const c = 3;');

    harness.stop();
    xterm.dispose();
  });

  it('3. supports / slash completion, @ file mentions, searchable /model selector, Ctrl+P palette, and all slash commands', async () => {
    const workspace = makeTempWorkspace();
    const { engine } = await buildMockEngine(workspace);
    const xterm = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    const harness = new TuiTestHarness({
      engine,
      presentationMode: 'conversation',
      colorMode: 'monochrome',
    });

    await harness.start();
    await flushToXterm(harness, xterm);

    // 1. Slash completion: '/pe' + Tab -> '/permissions'
    harness.sendKeys('/pe');
    await flushToXterm(harness, xterm);
    expect(readXtermText(xterm)).toContain('/permissions');
    harness.sendKey('\t');
    await flushToXterm(harness, xterm);
    expect(readXtermText(xterm)).toContain('/permissions');

    // Submit '/permissions read-only'
    harness.sendKeys('read-only');
    harness.sendKey('\r');
    await flushToXterm(harness, xterm, 30);
    expect(readXtermText(xterm)).toContain('read-only');

    // 2. @ file mention resolution from workspace
    const resolved = resolvePromptFileMentions('Please inspect @src/router.ts', workspace);
    expect(resolved.map((r) => r.relativePath)).toContain('src/router.ts');
    expect(resolved[0]?.content).toContain('export function route');

    // 3. /help, /status (shows workload split & capabilities), /diff (real git diff)
    writeFileSync(path.join(workspace, 'src', 'router.ts'), 'export function route(x: string) {\n  return x.trim().toLowerCase();\n}\n');
    harness.sendLine('/help');
    await flushToXterm(harness, xterm, 30);
    harness.sendLine('/status');
    await flushToXterm(harness, xterm, 30);
    harness.sendLine('/diff');
    await flushToXterm(harness, xterm, 40);
    const combinedTranscript = readXtermText(xterm);
    expect(combinedTranscript).toContain('/permissions');
    expect(combinedTranscript).toContain('local 70%');
    expect(combinedTranscript).toContain('toLowerCase');

    // 4. Searchable /model selector
    harness.sendLine('/model');
    await flushToXterm(harness, xterm, 30);
    expect(readXtermText(xterm)).toContain('llama3.3:70b');
    harness.sendKeys('llama');
    await flushToXterm(harness, xterm, 20);
    harness.sendKey('\r');
    await flushToXterm(harness, xterm, 30);
    expect(readXtermText(xterm)).toContain('llama3.3:70b');

    // 5. Ctrl+P command palette opens and closes cleanly on Esc
    harness.sendKey('\x10'); // Ctrl+P
    await flushToXterm(harness, xterm, 25);
    expect(readXtermText(xterm)).toContain('QUICK ACTIONS (Ctrl+P)');
    harness.sendKey('\x1b'); // Esc closes palette
    await flushToXterm(harness, xterm, 25);

    // 6. /fleet switches to fleet dashboard view and /chat returns to conversation
    harness.sendLine('/fleet');
    await flushToXterm(harness, xterm, 25);
    expect((harness.tui as any).presentationMode).toBe('dashboard');
    harness.sendLine('/chat');
    await flushToXterm(harness, xterm, 25);
    expect((harness.tui as any).presentationMode).toBe('conversation');

    // 7. /clear resets transcript cleanly
    harness.sendLine('/clear');
    await flushToXterm(harness, xterm, 25);

    harness.stop();
    xterm.dispose();
  });

  it('4. enforces explicit approval focus safety so ordinary typing NEVER approves an action, and shows command preview', async () => {
    const workspace = makeTempWorkspace();
    const { engine } = await buildMockEngine(workspace);
    const xterm = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    const harness = new TuiTestHarness({
      engine,
      presentationMode: 'conversation',
      colorMode: 'monochrome',
    });

    await harness.start();
    await flushToXterm(harness, xterm);

    // Enqueue a real approval item in ApprovalQueue
    const pendingPromise = engine.approvalQueue.enqueue(
      {
        executionId: 'exec-safety-1',
        tool: 'bash_exec',
        input: { command: 'rm -rf ./build && npm run build' },
      } as any,
      {
        allowed: false,
        action: 'ask',
        rule: 'mutating-shell',
        reasons: ['Mutating shell command requires confirmation'],
      } as any,
      { taskId: 'task-safety-1' },
    );

    await flushToXterm(harness, xterm, 30);
    expect(readXtermText(xterm)).toContain('rm -rf ./build && npm run build');

    // Ordinary typing containing 'y', 'a', '1', 'd', 'n' MUST go into the composer draft and NEVER resolve the approval!
    harness.sendKeys('yes allow 1 deny no');
    await flushToXterm(harness, xterm, 30);
    let settled = false;
    pendingPromise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(engine.approvalQueue.list().length).toBe(1);

    // Clear composer draft, then explicitly focus approval via Tab and press 'y' to approve
    harness.sendKey('\x15');
    harness.sendKey('\t'); // Tab focuses approval card when composer is empty
    harness.sendKey('y');
    const approved = await pendingPromise;
    expect(approved).toBe(true);
    expect(engine.approvalQueue.list().length).toBe(0);

    harness.stop();
    xterm.dispose();
  });

  it('5. preserves scrollback (no alt-screen in conversation mode), strips <think> & raw tool JSON, and renders across sizes/themes', async () => {
    const cleaned = sanitizeAssistantText(
      '<think>secret scratchpad</think>\n{"action":"read_file","path":"src/index.ts"}\nHere is the **clean** summary:\n```ts\nconst ok = true;\n```',
    );
    expect(cleaned).not.toContain('secret scratchpad');
    expect(cleaned).not.toContain('"action":"read_file"');
    expect(cleaned).toContain('clean');
    expect(cleaned).toContain('const ok = true;');

    const workspace = makeTempWorkspace();
    const { engine } = await buildMockEngine(workspace, { withModel: false });

    for (const mode of ['default', 'dark', 'light', 'monochrome'] as const) {
      for (const ascii of [false, true]) {
        const theme = createConversationTheme({ colorMode: mode, ascii });
        const header = renderConversationHeader(
          {
            workspaceName: 'Wazir',
            gitBranch: 'main',
            modelSummary: 'none configured',
            permissionSummary: 'ask',
          },
          ascii ? 52 : 120,
          theme,
        );
        expect(header.join('\n')).toContain('WAZIR');
      }
    }

    const harness = new TuiTestHarness({
      engine,
      presentationMode: 'conversation',
      colorMode: 'monochrome',
      ascii: true,
    });
    await harness.start();
    await new Promise((r) => setTimeout(r, 20));
    const rawStartup = harness.outStream.getOutput();
    // Conversation mode must NEVER enter alternate screen (\x1b[?1049h) so native terminal scrollback works
    expect(rawStartup).not.toContain('\x1b[?1049h');
    // Missing-provider setup guidance shown concisely
    expect(rawStartup).toContain('Quick setup');

    // Resize across 80x24, 120x40, 160x50, and narrow 52x24 while preserving draft
    harness.sendKeys('unsent draft across resizes');
    for (const [cols, rows] of [[80, 24], [120, 40], [160, 50], [52, 24]] as const) {
      harness.outStream.columns = cols;
      harness.outStream.rows = rows;
      harness.outStream.emit('resize');
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(harness.outStream.getOutput()).toContain('unsent draft');
    harness.stop();
  });

  it('6. persists sessions, distinguishes completed/failed/interrupted/still-owned jobs without replaying side effects, and distributes 70/15/5', async () => {
    const workspace = makeTempWorkspace();
    const { engine, store } = await buildMockEngine(workspace);

    // Record live execution for 'task-live' owned by a foreign active worker so reconcileSessionJobs marks it 'still-owned'
    await store.put('execution/exec-live-foreign', {
      execution: {
        id: 'exec-live-foreign',
        taskId: 'task-live',
        workerId: 'remote-worker-99',
        status: 'running',
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      events: [],
      filesChanged: ['src/router.ts'],
    });

    const session = createConversationSession({
      id: 'conv-test-continuity',
      projectRoot: workspace,
      selectedModelId: 'ollama:qwen3-coder:30b',
      permissionMode: 'ask',
      routingMode: 'local-preferred',
    });
    session.turns.push({
      id: 'turn-1',
      role: 'user',
      content: 'Update router.ts',
      timestamp: new Date().toISOString(),
    });
    session.jobs = [
      {
        jobId: 'job-done',
        prompt: 'Done job',
        taskIds: ['task-done'],
        executionIds: [],
        recordedStatus: 'completed',
        updatedAt: new Date().toISOString(),
      },
      {
        jobId: 'job-fail',
        prompt: 'Failed job',
        taskIds: ['task-fail'],
        executionIds: [],
        recordedStatus: 'failed',
        updatedAt: new Date().toISOString(),
      },
      {
        jobId: 'job-interrupted',
        prompt: 'Crashed job',
        taskIds: ['task-crashed'],
        executionIds: [],
        recordedStatus: 'running',
        updatedAt: new Date().toISOString(),
      },
      {
        jobId: 'job-live',
        prompt: 'Still owned job',
        taskIds: ['task-live'],
        executionIds: ['exec-live-foreign'],
        recordedStatus: 'running',
        ownerWorkerId: 'remote-worker-99',
        updatedAt: new Date().toISOString(),
      },
    ];
    await saveConversationSession(store, session);

    const listed = await listConversationSessions(store, { projectRoot: workspace });
    expect(listed[0]?.id).toBe('conv-test-continuity');

    const inspections = await reconcileSessionJobs(engine, listed[0]!);
    const byId = Object.fromEntries(inspections.map((i) => [i.jobId, i.state]));
    expect(byId['job-done']).toBe('completed');
    expect(byId['job-fail']).toBe('failed');
    expect(byId['job-interrupted']).toBe('interrupted');
    expect(byId['job-live']).toBe('still-owned');

    // Verify 70% local / 15% antigravity / 5% codex (+ 10% auto overflow) deterministic schedule over 20 tasks
    const distributor = new WorkloadDistributor();
    const counts: Record<string, number> = { local: 0, antigravity: 0, codex: 0, auto: 0 };
    const targets = distributor.allocateBatch(20, {
      hasLocalHardware: true,
      hardwareComputerIds: ['local'],
      externalAgents: ['antigravity', 'codex'],
    });
    for (const target of targets) {
      counts[target.pool] = (counts[target.pool] ?? 0) + 1;
    }
    expect(counts.local).toBe(14);       // 70% of 20
    expect(counts.antigravity).toBe(3);  // 15% of 20
    expect(counts.codex).toBe(1);        // 5% of 20
    expect(counts.auto).toBe(2);         // 10% overflow
  });

  it('7. renders bootstrap shell before slow provider discovery and attaches live engine asynchronously', async () => {
    const workspace = makeTempWorkspace();
    const xterm = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
    const t0 = performance.now();
    const bootstrap = createBootstrapEngine(workspace);
    const harness = new TuiTestHarness({
      engine: bootstrap,
      presentationMode: 'conversation',
      colorMode: 'monochrome',
    });
    await harness.start();
    await flushToXterm(harness, xterm);
    const bootstrapMs = performance.now() - t0;
    expect(bootstrapMs).toBeLessThan(200);
    expect(readXtermText(xterm)).toContain('WAZIR');

    // User can type immediately while provider discovery is still running
    harness.sendKeys('draft while connecting');
    const { engine: liveEngine } = await buildMockEngine(workspace);
    await harness.tui.attachLiveEngine(liveEngine, { selectedModel: 'ollama:qwen3-coder:30b', projectRoot: workspace });
    await flushToXterm(harness, xterm, 25);

    const screenText = readXtermText(xterm);
    expect(screenText).toContain('draft while connecting');
    expect(screenText).toContain('qwen3-coder:30b');
    harness.stop();
    xterm.dispose();
  });

  it('8. validates CLI options, disambiguates subcommands vs prompts, and handles non-TTY/EOF deterministically', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const bundlePath = path.join(repoRoot, 'bin', 'wa.js');
    const tempHome = mkdtempSync(path.join(os.tmpdir(), 'wazir-cli-home-'));
    tempDirs.push(tempHome);
    const env = { ...process.env, WAZIR_HOME: tempHome, NO_COLOR: '1' };

    // 1. Invalid --routing-mode exits with code 2
    const badRouting = spawnSync(process.execPath, [bundlePath, '--routing-mode', 'invalid-mode'], {
      env,
      encoding: 'utf8',
      input: '',
    });
    expect(badRouting.status).toBe(2);
    expect(badRouting.stderr).toContain('Invalid --routing-mode');

    // 2. Unknown option exits with non-zero
    const unknownOpt = spawnSync(process.execPath, [bundlePath, '--totally-unknown-flag'], {
      env,
      encoding: 'utf8',
      input: '',
    });
    expect(unknownOpt.status).not.toBe(0);

    // 3. Empty piped stdin on bare `wa` exits cleanly with code 0 without hanging
    const emptyPipe = spawnSync(process.execPath, [bundlePath], {
      env,
      encoding: 'utf8',
      input: '',
      timeout: 10_000,
    });
    expect(emptyPipe.status).toBe(0);

    // 4. `wa resume --list --json` returns valid JSON deterministically
    const resumeList = spawnSync(process.execPath, [bundlePath, 'resume', '--list', '--json'], {
      env,
      encoding: 'utf8',
      input: '',
      timeout: 10_000,
    });
    expect(resumeList.status).toBe(0);
    expect(() => JSON.parse(resumeList.stdout)).not.toThrow();
  });

  it('9. enforces NO_COLOR truncation purity, inline-code Markdown safety, streaming <think> stripping, read-only shell guard, and SWRR edge invariants', async () => {
    // 1. Monochrome truncation emits zero ANSI resets and never splits ZWJ emoji graphemes
    const truncatedPlain = truncateToDisplayWidth(' plain narrow header 👩‍💻👩‍💻👩‍💻 end', 26, '...');
    expect(truncatedPlain).not.toContain('\x1b[');
    expect(truncatedPlain.endsWith('...')).toBe(true);

    // 2. Inline code spans preserve literal **bold** markers without mutation
    const darkTheme = createConversationTheme({ colorMode: 'dark' });
    const inlineRendered = styleInlineMarkdown('Check `a**b**c` and **real bold**', darkTheme);
    expect(inlineRendered).toContain('a**b**c');
    expect(inlineRendered).not.toContain('a\x1b[1mb\x1b[22mc');

    // 3. Duplicate pool coalescing & LOCAL_ONLY agent-pin safety in WorkloadDistributor
    const coalesced = parseWorkloadDistribution('local:40,local:30,antigravity:15,codex:5');
    expect(coalesced.shares.find((s) => s.pool === 'local')?.weight).toBe(70);
    const dist = new WorkloadDistributor(coalesced);
    const localPinnedPick = dist.next({
      hasLocalHardware: true,
      externalAgents: ['antigravity', 'codex'],
      routingMode: 'LOCAL_ONLY',
      pinnedAgentId: 'antigravity',
    });
    expect(localPinnedPick.targetAgentId).toBeUndefined();
    expect(localPinnedPick.pool).toBe('local');

    // 4. Streaming <think> preceded by prose is stripped, Ctrl+T does not leak sidebar status, and read-only blocks !cmd
    const workspace = makeTempWorkspace();
    const { engine } = await buildMockEngine(workspace);
    const xterm = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
    const harness = new TuiTestHarness({
      engine,
      presentationMode: 'conversation',
      permissionMode: 'read-only',
    });
    await harness.start();
    await flushToXterm(harness, xterm);

    harness.tui.conversation.updateStreamingToken('Inspecting files now.\n<think>secret chain of thought');
    expect(harness.tui.conversation.streamingPreview).toBe('Inspecting files now.');

    // Ctrl+T must not trigger dashboard sidebar messages in conversation mode
    harness.sendKey('\x14');
    await flushToXterm(harness, xterm);
    expect(readXtermText(xterm)).not.toContain('Sidebar hidden');

    // Inline `!ls` must be blocked in read-only mode
    harness.sendLine('!echo should_not_run');
    await flushToXterm(harness, xterm, 30);
    expect(readXtermText(xterm)).toContain("Shell execution is disabled while permission mode is 'read-only'");

    harness.stop();
    xterm.dispose();
  });
});
