import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type Job,
  type JobOrchestratorEvent,
  type JobRollup,
  type PendingApprovalRequest,
  type Block,
  type BlockStatus,
} from '@wazir/core';
import type { RookEngine } from '../engine.js';
import { refreshRuntime } from '../engine.js';
import { color } from '../colors.js';
import { createFleetTaskExecutor } from '../fleetRunner.js';
import { TerminalScreen, type TerminalSize } from './screen.js';
import { createBlock, listBlocks, getBlock, getActiveContext, clearContext } from '../blocks.js';
import { resolveReference, type ResolvedReference } from '../references.js';
import { tokensPerSecond } from '@wazir/shared';
import { parseAction } from '@wazir/agents';

const execFileAsync = promisify(execFile);

// Per-category spinner frames for the persistent full-screen renderer. Earlier rounds on
// this terminal assumed Braille glyphs were unsafe (they'd caused ghosting twice), but an
// objective cursor-position measurement (glyph-width-test.mjs, using the ANSI Device
// Status Report) proved every candidate set below renders at exactly 1 column here — so
// the ghosting was never a per-glyph width problem, and Braille is back in as the default
// per later request. These were picked from that verified-safe set: square corners for
// job/task activity, dots/growth for runtime activity (slowed to 1 frame/sec — the shared
// 250ms redraw tick made it look frantic at 4 frames/sec), Braille for everything else.
const JOB_SPINNER_FRAMES = ['◴', '◷', '◶', '◵'] as const;
const RUNTIME_SPINNER_FRAMES = ['·', '•', '●', '•'] as const;
const RUNTIME_SPINNER_TICKS_PER_FRAME = 4; // 4 * 250ms redraw tick = 1 frame/sec
const DEFAULT_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

function getCategorySpinnerFrame(category: NavCategory | undefined, tick: number): string {
  if (category === 'JOBS' || category === 'EXECUTIONS') {
    return JOB_SPINNER_FRAMES[Math.abs(Math.floor(tick)) % JOB_SPINNER_FRAMES.length];
  }
  if (category === 'RUNTIMES') {
    const slowTick = Math.floor(Math.abs(Math.floor(tick)) / RUNTIME_SPINNER_TICKS_PER_FRAME);
    return RUNTIME_SPINNER_FRAMES[slowTick % RUNTIME_SPINNER_FRAMES.length];
  }
  return DEFAULT_SPINNER_FRAMES[Math.abs(Math.floor(tick)) % DEFAULT_SPINNER_FRAMES.length];
}

// Job ids are `job-<base36 timestamp>-<counter>` — every one starts with the same
// redundant "job-" prefix (already implied by the JOBS category header) and the
// timestamp chunk isn't human-meaningful anyway, so the nav list shows just the
// last few characters instead of the full id, leaving more room for the title.
function shortJobId(id: string): string {
  const stripped = id.replace(/^job-/, '');
  return stripped.length > 8 ? `..${stripped.slice(-8)}` : stripped;
}

interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  text: string;
}

/**
 * Minimal LCS-based line diff for the approval modal's edit preview. Not a
 * full diff algorithm (no move detection, etc.) — just enough to show which
 * lines of a proposed string replacement actually changed instead of a flat
 * "everything removed, everything added" block, for the common case of a
 * small, mostly-unchanged snippet. `oldString`/`newString` come straight
 * from the model's `edit` tool call, so both are already known synchronously
 * with no file read needed.
 */
function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  // The O(n*m) LCS table would be too large/slow for a pathologically big
  // replacement — fall back to a flat before/after view rather than risk it.
  if (n * m > 200_000) {
    return [...a.map((text): DiffLine => ({ type: 'del', text })), ...b.map((text): DiffLine => ({ type: 'add', text }))];
  }
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: 'del', text: a[i] });
      i++;
    } else {
      result.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: 'del', text: a[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: 'add', text: b[j] });
    j++;
  }
  return result;
}

export type TuiView = 'fleet' | 'tail' | 'approval' | 'worktrees' | 'help';

export type NavCategory = 'JOBS' | 'EXECUTIONS' | 'AGENTS' | 'COMPUTERS' | 'RUNTIMES';

export type FocusPane = 'nav' | 'main' | 'prompt';

export interface StructuredError {
  phase: string;
  reason: string;
  required?: string;
  available?: string;
  suggestedSteps: string[];
  taskId?: string;
  timestamp: Date;
}

export interface NavItem {
  category: NavCategory;
  id: string;
  label: string;
  status: 'running' | 'completed' | 'idle' | 'failed';
  routing?: {
    agentId?: string;
    modelId?: string;
    runtimeId?: string;
    computerId?: string;
  };
}

export interface AgentCardState {
  taskId: string;
  title: string;
  agentId: string;
  computerId: string;
  modelId: string;
  phase: string;
  lastMessage: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'retry';
  startedAt?: Date;
  completedAt?: Date;
  durationMs: number;
  filesChanged: string[];
  usage?: { input: number; output: number; total: number };
  /** Prompt size of the most recent model turn — the real context-window occupancy. */
  lastTurnInputTokens?: number;
}

export interface AgentLogEntry {
  text: string;
  time: string;
  kind: 'plan' | 'route' | 'tool' | 'test' | 'complete' | 'error' | 'info' | 'model' | 'validate';
  /** Raw model response text this entry came from, when available (view with 'r'
   *  on the Tail view). */
  raw?: string;
}

export interface FleetTuiOptions {
  engine: RookEngine;
  screen?: TerminalScreen;
  concurrencyLimit?: number;
  useWorktrees?: boolean;
  autoMerge?: boolean;
  /** Per-job wall-clock limit; the orchestrator's built-in default applies when unset. */
  timeoutSeconds?: number;
}

/**
 * Resolves structured key objects from raw strings or readline key events.
 */
function resolveKeyObject(keyStr: string, keyObj?: readline.Key): readline.Key {
  if (keyObj && keyObj.name) return keyObj;
  if (typeof keyStr !== 'string') {
    return { name: undefined as any, ctrl: false, meta: false, shift: false, sequence: '' };
  }

  if (keyStr === '\t') {
    return { name: 'tab', ctrl: false, meta: false, shift: false, sequence: '\t' };
  }
  if (keyStr === '\x1b[Z') {
    return { name: 'tab', ctrl: false, meta: false, shift: true, sequence: '\x1b[Z' };
  }
  if (keyStr === '\x7f' || keyStr === '\b' || keyStr === '\u0008') {
    return { name: 'backspace', ctrl: false, meta: false, shift: false, sequence: keyStr };
  }
  if (keyStr === '\x1b[3~') {
    return { name: 'delete', ctrl: false, meta: false, shift: false, sequence: keyStr };
  }
  if (keyStr === '\x1b' || keyStr === '\u001b') {
    return { name: 'escape', ctrl: false, meta: false, shift: false, sequence: '\x1b' };
  }
  if (keyStr === '\r' || keyStr === '\n') {
    return { name: 'return', ctrl: false, meta: false, shift: false, sequence: keyStr };
  }
  if (keyStr === '\u001b[A') {
    return { name: 'up', ctrl: false, meta: false, shift: false, sequence: keyStr };
  }
  if (keyStr === '\u001b[B') {
    return { name: 'down', ctrl: false, meta: false, shift: false, sequence: keyStr };
  }
  if (keyStr === '\u001b[C') {
    return { name: 'right', ctrl: false, meta: false, shift: false, sequence: keyStr };
  }
  if (keyStr === '\u001b[D') {
    return { name: 'left', ctrl: false, meta: false, shift: false, sequence: keyStr };
  }
  if (keyStr === '\x10' || keyStr === '\u0010') {
    return { name: 'p', ctrl: true, meta: false, shift: false, sequence: '\x10' };
  }
  if (keyStr === '\x0c' || keyStr === '\u000c') {
    return { name: 'l', ctrl: true, meta: false, shift: false, sequence: '\x0c' };
  }
  if (keyStr === '\x12' || keyStr === '\u0012') {
    return { name: 'r', ctrl: true, meta: false, shift: false, sequence: '\x12' };
  }
  if (keyStr === '\u0003') {
    return { name: 'c', ctrl: true, meta: false, shift: false, sequence: '\u0003' };
  }
  if (keyStr === '\u0015') {
    return { name: 'u', ctrl: true, meta: false, shift: false, sequence: '\u0015' };
  }
  if (keyStr === '\u0017') {
    return { name: 'w', ctrl: true, meta: false, shift: false, sequence: '\u0017' };
  }
  if (keyStr === '\x1b[5~') {
    return { name: 'pageup', ctrl: false, meta: false, shift: false, sequence: keyStr };
  }
  if (keyStr === '\x1b[6~') {
    return { name: 'pagedown', ctrl: false, meta: false, shift: false, sequence: keyStr };
  }

  return {
    name: keyStr.length === 1 ? keyStr : (undefined as any),
    ctrl: false,
    meta: false,
    shift: false,
    sequence: keyStr,
  };
}

export class FleetTui {
  readonly engine: RookEngine;
  readonly screen: TerminalScreen;
  private readonly concurrencyLimit: number;
  private readonly useWorktrees: boolean;
  private readonly autoMerge: boolean;
  private readonly timeoutSeconds?: number;

  private currentView: TuiView = 'fleet';
  private focusedPane: FocusPane = 'nav';
  private highlightedIndex = 0;
  private selectedTaskId?: string;

  // Nav index state
  private navSelectionIndex = 0;
  private selectedCategory: NavCategory = 'EXECUTIONS';
  private selectedNavId?: string;

  // Event stream scroll offset
  private eventScrollOffset = 0;

  // Structured Error Card state
  private currentError?: StructuredError;

  // Quick actions palette state
  private quickActionsOpen = false;
  private quickActionIndex = 0;
  private readonly quickActions = [
    { id: 'fanout', title: 'Fanout Concurrent Tasks', cmd: '/fanout ' },
    { id: 'steer', title: 'Steer Selected Agent', cmd: '/steer ' },
    { id: 'cancel', title: 'Cancel Active Job/Task', cmd: '/cancel' },
    { id: 'block', title: 'Inspect Recent Block', cmd: '/block' },
    { id: 'clear-context', title: 'Clear Active Context', cmd: '/clear-context' },
    { id: 'doctor', title: 'System Health Diagnostics', cmd: '/doctor' },
    { id: 'launch-lmstudio', title: 'Launch LM Studio Server', cmd: '/launch lmstudio' },
    { id: 'help', title: 'Toggle Help & Shortcuts', cmd: '/help' },
    { id: 'repaint', title: 'Force Screen Repaint', cmd: '/repaint' },
  ];

  private readonly agents = new Map<string, AgentCardState>();
  private readonly agentLogs = new Map<string, AgentLogEntry[]>();
  /** Most recent raw model response text per task — press 'r' on the Tail view to inspect it. */
  private readonly lastRawResponse = new Map<string, string>();
  private rawResponseModalOpen = false;
  // The model's raw output for the turn currently being generated, per task. This is
  // the closest thing to "watching the model think" this protocol has: the model is
  // prompted to answer with one JSON action per turn, so the stream is its reasoning
  // for `plan` actions and the literal command/file content for tool actions. Shown
  // live in the Tail view while it streams, then folded into the log as one MODEL line
  // once the turn completes (see flushStreaming).
  private readonly streamingBuffers = new Map<string, string>();
  private pendingApprovals: PendingApprovalRequest[] = [];
  private approvalShowDetails = false;

  // History & Blocks
  private recentBlocks: Block[] = [];
  private expandedBlock?: Block;
  private expandedJobId?: string;
  private currentBlockTracker?: { finish: (status: BlockStatus, patch?: Partial<Block>) => Promise<void> };

  // @ Reference fuzzy picker
  private isPickerActive = false;
  private pickerIndex = 0;
  private pickerCandidates: string[] = [];
  private lastResolvedReferences: ResolvedReference[] = [];

  private currentJob?: Job;
  private currentRollup?: JobRollup;
  // Rollup (tokens, duration, tok/s) per job id, fetched on demand when a JOBS nav item
  // is selected — getJobRollup() is async (it reads execution records per task), so this
  // caches the last-fetched result per job rather than blocking the render loop on it.
  // Without this, the JOBS detail view fell back to `currentRollup`, which only ever
  // reflected whichever job was most recently launched in this session — selecting a
  // different (especially older, reloaded-from-disk) job showed stale or wrong numbers.
  private readonly jobRollups = new Map<string, JobRollup>();
  private isRunning = false;
  private shouldExit = false;

  /** Set via /model <id>; pins every subsequently submitted task to this model instead
   *  of letting the scheduler auto-route it. Undefined means auto-routed (the default). */
  private selectedModelId?: string;

  private inputBuffer = '';
  /** Index into inputBuffer where typed/deleted characters land; 0..inputBuffer.length. */
  private inputCursor = 0;
  /** 1-based terminal column the hardware cursor belongs at, set by renderInputBar()'s
   *  most recent call and consumed by draw() right after. */
  private inputCursorScreenCol = 1;
  private statusMessage = 'Ready. Type a task or /fanout <t1; t2; ...> to begin.';
  private renderTimer?: NodeJS.Timeout;
  private spinnerTick = 0;

  private unsubscribeApprovals?: () => void;
  private unsubscribeJobEvents?: () => void;
  private unsubscribeResize?: () => void;
  private unhandledRejectionHandler?: (reason: unknown) => void;

  constructor(options: FleetTuiOptions) {
    this.engine = options.engine;
    this.screen = options.screen ?? new TerminalScreen();
    this.concurrencyLimit = options.concurrencyLimit ?? 4;
    this.useWorktrees = options.useWorktrees ?? true;
    this.autoMerge = options.autoMerge ?? false;
    this.timeoutSeconds = options.timeoutSeconds;
  }

  getCurrentView(): TuiView {
    if (this.pendingApprovals.length > 0) return 'approval';
    return this.currentView;
  }

  getFocusedPane(): FocusPane {
    return this.focusedPane;
  }

  setFocusedPane(pane: FocusPane): void {
    this.focusedPane = pane;
    this.draw();
  }

  getCurrentError(): StructuredError | undefined {
    return this.currentError;
  }

  setStructuredError(err: StructuredError): void {
    this.currentError = err;
    this.draw();
  }

  clearStructuredError(): void {
    this.currentError = undefined;
    this.draw();
  }

  isQuickActionsOpen(): boolean {
    return this.quickActionsOpen;
  }

  getAgents(): AgentCardState[] {
    return Array.from(this.agents.values());
  }

  getPendingApprovals(): PendingApprovalRequest[] {
    return this.pendingApprovals;
  }

  getStatusMessage(): string {
    return this.statusMessage;
  }

  getLastResolvedReferences(): ResolvedReference[] {
    return this.lastResolvedReferences;
  }

  getCurrentJob(): Job | undefined {
    return this.currentJob;
  }

  getEventScrollOffset(): number {
    return this.eventScrollOffset;
  }

  private exitPromise?: Promise<void>;
  private exitResolver?: () => void;
  private keypressListener?: (ch: string | undefined, key?: readline.Key) => void;
  private inputListener?: (data: Buffer | string) => void;
  private stdinEndListener?: () => void;
  private outErrorHandler?: (err: Error) => void;

  /**
   * Isolates and consumes Tab / Shift-Tab key events cleanly (§1).
   * Toggles target focus, transitions views, and redraws screen without buffer leakage.
   */
  consumeTabKey(isShift = false): void {
    // If @ fuzzy reference picker is active, Tab completes the selected candidate into prompt
    if (this.isPickerActive && this.pickerCandidates.length > 0) {
      const chosen = this.pickerCandidates[this.pickerIndex];
      this.inputBuffer = this.inputBuffer.replace(/@([a-zA-Z0-9_:./-]*)$/, chosen + ' ');
      this.inputCursor = this.inputBuffer.length;
      this.isPickerActive = false;
      this.pickerCandidates = [];
      this.draw();
      return;
    }

    // Toggle target focus and cycle view (§1, §3)
    const views: TuiView[] = ['fleet', 'tail', 'approval', 'worktrees'];
    const idx = views.indexOf(this.currentView);
    if (isShift) {
      this.currentView = views[(idx - 1 + views.length) % views.length];
    } else {
      this.currentView = views[(idx + 1) % views.length];
    }

    // Toggle target focus cleanly:
    this.focusedPane = this.currentView === 'fleet' ? 'nav' : 'main';

    // In 'tail' view: ensure active execution is selected in nav so the event stream displays immediately
    if (this.currentView === 'tail') {
      const all = this.getFlatNavItems();
      const execItem =
        all.find((it) => it.category === 'EXECUTIONS' && it.id === this.selectedTaskId) ??
        all.find((it) => it.category === 'EXECUTIONS');
      if (execItem) {
        this.selectedCategory = 'EXECUTIONS';
        this.selectedNavId = execItem.id;
        this.selectedTaskId = execItem.id;
        const itemIdx = all.findIndex((it) => it.id === execItem.id && it.category === 'EXECUTIONS');
        if (itemIdx !== -1) {
          this.navSelectionIndex = itemIdx;
        }
      }
    }

    // Clean View Transition (§1, §3):
    // Full screen/container clear before rendering the new view to eliminate
    // text ghosting, overlapping headers, and residual buffer characters.
    this.screen.clearLastBuffer();
    this.draw();
  }

  waitForExit(): Promise<void> {
    if (!this.exitPromise) {
      this.exitPromise = new Promise<void>((resolve) => {
        this.exitResolver = resolve;
      });
    }
    return this.exitPromise;
  }

  /**
   * Starts the TUI render loop and input listeners.
   */
  async start(): Promise<void> {
    this.isRunning = true;

    // Safety net (found the hard way): a fire-and-forget action here (`void this.foo()`,
    // used throughout for keypress handlers so they can stay synchronous) that rejects
    // without its own .catch() is an unhandled promise rejection — Node's default is to
    // crash the entire process for that, taking the whole interactive session down over
    // what should have been a status-bar error message (e.g. pressing 'c' to cancel a job
    // that already finished). Individual call sites are being fixed as found, but this
    // keeps any other one we haven't found yet from killing the app outright.
    this.unhandledRejectionHandler = (reason) => {
      this.statusMessage = `Internal error (recovered): ${reason instanceof Error ? reason.message : String(reason)}`;
      this.draw();
    };
    process.on('unhandledRejection', this.unhandledRejectionHandler);

    // 3. Raw Mode & Keypress Binding Check:
    // Verify that stdin is correctly running in raw mode so structured key objects are passed
    this.screen.enter();

    this.waitForExit();

    // Hook terminal resize event for responsive layout
    this.unsubscribeResize = this.screen.onTerminalResize(() => {
      this.draw();
    });

    // Subscribe to approval queue
    this.unsubscribeApprovals = this.engine.approvalQueue.subscribe((requests) => {
      this.pendingApprovals = requests;
      this.draw();
    });

    // Load initial recent blocks
    void this.refreshRecentBlocks();

    // Listen to structured keypress events via screen input stream
    const inStream = this.screen.getInputStream();
    this.keypressListener = (ch: string | undefined, key?: readline.Key) => {
      // 1. Isolate Tab Key Events (§1):
      // In the global keypress/keydown listener, ensure that when key.name === 'tab' (or key.sequence === '\t'),
      // the event is completely consumed, target focus is toggled, and execution explicitly returns early.
      const isTab =
        key?.name === 'tab' ||
        key?.sequence === '\t' ||
        ch === '\t' ||
        ch === '\x1b[Z' ||
        key?.sequence === '\x1b[Z';

      if (isTab) {
        if (typeof (key as any)?.preventDefault === 'function') {
          (key as any).preventDefault();
        }
        if (typeof (key as any)?.stopPropagation === 'function') {
          (key as any).stopPropagation();
        }
        const isShift = Boolean(key?.shift || ch === '\x1b[Z' || key?.sequence === '\x1b[Z');
        this.consumeTabKey(isShift);
        return;
      }

      this.handleKey(ch ?? key?.sequence ?? '', key);
    };
    inStream.on('keypress', this.keypressListener);

    // Fallback data listener for mock streams or environments that don't emit keypress
    this.inputListener = (data: Buffer | string) => {
      // Avoid duplicate handling if keypress listener is firing
      if ((inStream as any).listenerCount && (inStream as any).listenerCount('keypress') > 0) {
        return;
      }
      const str = typeof data === 'string' ? data : data.toString('utf8');
      if (str === '\t' || str === '\x1b[Z') {
        this.consumeTabKey(str === '\x1b[Z');
        return;
      }
      this.handleKey(str);
    };
    inStream.on('data', this.inputListener);

    // stdin EOF: when input is piped (`printf '/doctor\r' | wa chat`) or the parent
    // process closes the pipe, stdin emits 'end' and no further input can ever arrive.
    // Without this the TUI sat in waitForExit() forever — a piped command hung until
    // killed. Graceful exit here mirrors what Ctrl+C / 'q' / /exit do on a TTY.
    this.stdinEndListener = () => {
      if (this.isRunning) this.stop();
    };
    inStream.once('end', this.stdinEndListener);

    // Output stream (dead) terminal / closed pipe: a failed write surfaces as an
    // asynchronous 'error' event (EIO/EPIPE). With no listener that crashes the
    // process (exit 1) in the middle of the graceful-exit path. The session is
    // ending anyway — the stdin-EOF handler drives the exit — so swallow it.
    this.outErrorHandler = () => {
      /* terminal or pipe reader gone: nothing to recover, exit path handles it */
    };
    this.screen.getOutputStream().on('error', this.outErrorHandler);

    // Refresh display periodically for live duration counters
    this.renderTimer = setInterval(() => {
      this.updateAgentDurations();
      this.draw();
    }, 250);

    this.draw();
  }

  stop(): void {
    // Idempotent: stop() can be triggered more than once (e.g. the user types /exit
    // and stdin also hits EOF in pipe mode, or a stray second caller). Guard on
    // isRunning so double-stops are a no-op instead of re-running unsubscribe/leave.
    if (!this.isRunning) return;
    if (this.renderTimer) clearInterval(this.renderTimer);
    if (this.unsubscribeApprovals) this.unsubscribeApprovals();
    if (this.unsubscribeJobEvents) this.unsubscribeJobEvents();
    if (this.unsubscribeResize) this.unsubscribeResize();
    if (this.unhandledRejectionHandler) {
      process.off('unhandledRejection', this.unhandledRejectionHandler);
      this.unhandledRejectionHandler = undefined;
    }

    if (this.keypressListener) {
      this.screen.getInputStream().off('keypress', this.keypressListener);
      this.keypressListener = undefined;
    }

    if (this.inputListener) {
      this.screen.getInputStream().off('data', this.inputListener);
      this.inputListener = undefined;
    }

    if (this.stdinEndListener) {
      this.screen.getInputStream().off('end', this.stdinEndListener);
      this.stdinEndListener = undefined;
    }

    // NOTE: outErrorHandler is deliberately NOT removed here. screen.leave() below
    // performs an outStream write whose EIO/EPIPE error arrives asynchronously on a
    // later tick — removing the handler first (or even immediately after) leaves that
    // error unhandled and crashes the process (exit 1) on the exact path we're trying
    // to exit gracefully. The handler is a no-op and harmless for the process lifetime.

    this.screen.leave();
    this.isRunning = false;
    this.exitResolver?.();
  }

  /**
   * Dispatches input keys across navigation, modals, and input buffer.
   */
  handleKey(key: string, rawKeyObj?: readline.Key): void {
    const keyObj = resolveKeyObject(key, rawKeyObj);
    const keyName = keyObj.name ?? '';
    const keyStr = keyObj.sequence ?? key;

    // 1. Ctrl+C: exit
    if ((keyObj.ctrl && (keyName === 'c' || keyName === 'C')) || keyStr === '\u0003') {
      this.stop();
      process.exit(0);
    }

    // 2. Isolate Tab Key Events (§1):
    // In the global keypress/keydown handler, ensure when key.name === 'tab' (or key.sequence === '\t'),
    // the event is completely consumed, target focus is toggled, and execution explicitly returns early.
    if (keyName === 'tab' || keyStr === '\t' || keyStr === '\x1b[Z') {
      const isShift = Boolean(keyObj.shift || keyStr === '\x1b[Z');
      this.consumeTabKey(isShift);
      return;
    }

    // 2. Escape: dismiss active overlay modals, reset scroll, or return to fleet
    if (key === '\u001b' || key === '\x1b') {
      if (this.quickActionsOpen) {
        this.quickActionsOpen = false;
        this.draw();
        return;
      }
      if (this.rawResponseModalOpen) {
        this.rawResponseModalOpen = false;
        this.draw();
        return;
      }
      if (this.currentError) {
        this.currentError = undefined;
        this.draw();
        return;
      }
      if (this.expandedBlock) {
        this.expandedBlock = undefined;
        this.draw();
        return;
      }
      if (this.expandedJobId) {
        this.expandedJobId = undefined;
        this.draw();
        return;
      }
      if (this.isPickerActive) {
        this.isPickerActive = false;
        this.pickerCandidates = [];
        this.draw();
        return;
      }
      if (this.eventScrollOffset > 0) {
        this.eventScrollOffset = 0;
        this.draw();
        return;
      }
      this.currentView = 'fleet';
      this.focusedPane = 'nav';
      this.screen.clearLastBuffer();
      this.draw();
      return;
    }

    // 3. Ctrl+P: Quick actions palette (§3)
    if (key === '\u0010' || key === '\x10') {
      this.quickActionsOpen = !this.quickActionsOpen;
      this.quickActionIndex = 0;
      this.draw();
      return;
    }

    // 4. Ctrl+L: Screen repaint (§3)
    if (key === '\u000c' || key === '\x0c') {
      this.screen.repaint();
      this.draw();
      return;
    }

    // 5. Ctrl+R: Force state refresh (§3)
    if (key === '\u0012' || key === '\x12') {
      void this.refreshRecentBlocks();
      this.updateAgentDurations();
      this.statusMessage = 'Refreshed fleet state';
      this.draw();
      return;
    }

    // 6. Ctrl+B: Expand latest block from history
    if (key === '\u0002') {
      if (this.recentBlocks.length > 0) {
        void this.expandBlock(this.recentBlocks[0].id);
      }
      return;
    }

    // 7. Quick actions modal key handling
    if (this.quickActionsOpen) {
      if (key === '\u001b[A') {
        this.quickActionIndex = Math.max(0, this.quickActionIndex - 1);
        this.draw();
        return;
      }
      if (key === '\u001b[B') {
        this.quickActionIndex = Math.min(this.quickActions.length - 1, this.quickActionIndex + 1);
        this.draw();
        return;
      }
      if (key === '\r' || key === '\n') {
        const chosen = this.quickActions[this.quickActionIndex];
        this.quickActionsOpen = false;
        if (chosen.cmd === '/repaint') {
          this.screen.repaint();
          this.draw();
          return;
        }
        if (chosen.cmd === '/help') {
          this.currentView = this.currentView === 'help' ? 'fleet' : 'help';
          this.draw();
          return;
        }
        if (chosen.cmd.endsWith(' ')) {
          this.inputBuffer = chosen.cmd;
          this.inputCursor = this.inputBuffer.length;
          this.focusedPane = 'prompt';
          this.draw();
          return;
        }
        void this.submitCommand(chosen.cmd);
        return;
      }
      if (/^[1-9]$/.test(key)) {
        const idx = parseInt(key, 10) - 1;
        if (idx >= 0 && idx < this.quickActions.length) {
          this.quickActionIndex = idx;
          const chosen = this.quickActions[idx];
          this.quickActionsOpen = false;
          if (chosen.cmd === '/repaint') {
            this.screen.repaint();
            this.draw();
            return;
          }
          if (chosen.cmd === '/help') {
            this.currentView = this.currentView === 'help' ? 'fleet' : 'help';
            this.draw();
            return;
          }
          if (chosen.cmd.endsWith(' ')) {
            this.inputBuffer = chosen.cmd;
            this.inputCursor = this.inputBuffer.length;
            this.focusedPane = 'prompt';
            this.draw();
            return;
          }
          void this.submitCommand(chosen.cmd);
          return;
        }
      }
    }

    // 8. Structured Error Card Actions
    if (this.currentError) {
      if (keyStr === 'r' || keyStr === 'R') {
        const retryTask = this.currentError.taskId;
        this.currentError = undefined;
        if (retryTask) {
          this.statusMessage = `Retrying task ${retryTask}...`;
        }
        this.draw();
        return;
      }
      if (keyStr === 'd' || keyStr === 'D') {
        this.currentError = undefined;
        void this.submitCommand('/doctor');
        return;
      }
    }

    // 9. Overlaid Approval Modal Actions ([A] Approve, [D] Deny, [V] View details, [I] Inspect,
    // Ctrl+A Approve All, Ctrl+D Deny All)
    if (this.pendingApprovals.length > 0) {
      const first = this.pendingApprovals[0];
      if (key === '\u0001') {
        const count = this.engine.approvalQueue.approveAll();
        this.statusMessage = `Approved all ${count} pending policy request${count === 1 ? '' : 's'}`;
        this.draw();
        return;
      }
      if (key === '\u0004') {
        const count = this.engine.approvalQueue.denyAll();
        this.statusMessage = `Denied all ${count} pending policy request${count === 1 ? '' : 's'}`;
        this.draw();
        return;
      }
      if (key === 'a' || key === 'A' || key === 'y' || key === 'Y') {
        this.engine.approvalQueue.approve(first.id);
        this.statusMessage = `Approved policy request for ${first.tool}`;
        this.draw();
        return;
      }
      if (key === 'd' || key === 'D' || key === 'n' || key === 'N') {
        this.engine.approvalQueue.deny(first.id);
        this.statusMessage = `Denied policy request for ${first.tool}`;
        this.draw();
        return;
      }
      if (key === 'v' || key === 'V') {
        this.approvalShowDetails = !this.approvalShowDetails;
        this.statusMessage = this.approvalShowDetails
          ? 'Showing expanded approval details'
          : 'Showing standard approval view';
        this.draw();
        return;
      }
      if (key === 'i' || key === 'I') {
        this.pendingApprovals.push(this.pendingApprovals.shift()!);
        this.statusMessage = `Inspected and snoozed policy request for ${first.tool}`;
        this.draw();
        return;
      }
    }

    // 10. Picker navigation when @ fuzzy picker is active
    if (this.isPickerActive && this.pickerCandidates.length > 0) {
      if (keyName === 'up' || keyStr === '\u001b[A') {
        this.pickerIndex = Math.max(0, this.pickerIndex - 1);
        this.draw();
        return;
      }
      if (keyName === 'down' || keyStr === '\u001b[B') {
        this.pickerIndex = Math.min(this.pickerCandidates.length - 1, this.pickerIndex + 1);
        this.draw();
        return;
      }
      if (
        keyName === 'tab' ||
        keyName === 'return' ||
        keyName === 'enter' ||
        keyStr === '\t' ||
        keyStr === '\r' ||
        keyStr === '\n'
      ) {
        const chosen = this.pickerCandidates[this.pickerIndex];
        this.inputBuffer = this.inputBuffer.replace(/@([a-zA-Z0-9_:./-]*)$/, chosen + ' ');
        this.inputCursor = this.inputBuffer.length;
        this.isPickerActive = false;
        this.pickerCandidates = [];
        this.draw();
        return;
      }
    }

    // 11. '?' for Help (§3) when input buffer is empty
    if ((keyName === '?' || keyStr === '?') && this.inputBuffer.length === 0) {
      this.currentView = this.currentView === 'help' ? 'fleet' : 'help';
      this.draw();
      return;
    }

    // 13. Event-Stream Activity Scrolling: PageUp (\x1b[5~) / PageDown (\x1b[6~)
    if (keyName === 'pageup' || keyStr === '\x1b[5~') {
      this.eventScrollOffset += 5;
      this.draw();
      return;
    }
    if (keyName === 'pagedown' || keyStr === '\x1b[6~') {
      this.eventScrollOffset = Math.max(0, this.eventScrollOffset - 5);
      this.draw();
      return;
    }

    // 14. Arrow keys: Generalized Navigation or Event Scrolling
    if (keyName === 'up' || keyStr === '\u001b[A') {
      // Up
      if (this.focusedPane === 'main' && this.inputBuffer.length === 0) {
        this.eventScrollOffset += 1;
        this.draw();
        return;
      }
      const all = this.getFlatNavItems();
      if (all.length > 0) {
        this.navSelectionIndex = Math.max(0, this.navSelectionIndex - 1);
        this.updateNavSelection(all[this.navSelectionIndex]);
        // Enter's command-submit path never resets focus back off 'prompt' — without this,
        // arrowing down to a job after typing+submitting a task leaves focusedPane stuck at
        // 'prompt', so the 'x' delete shortcut (which requires nav focus) silently no-ops
        // and 'x' gets typed into the (already-submitted, invisible) prompt buffer instead.
        this.focusedPane = 'nav';
      }
      this.draw();
      return;
    }
    if (keyName === 'down' || keyStr === '\u001b[B') {
      // Down
      if (this.focusedPane === 'main' && this.inputBuffer.length === 0 && this.eventScrollOffset > 0) {
        this.eventScrollOffset = Math.max(0, this.eventScrollOffset - 1);
        this.draw();
        return;
      }
      const all = this.getFlatNavItems();
      if (all.length > 0) {
        this.navSelectionIndex = Math.min(all.length - 1, this.navSelectionIndex + 1);
        this.updateNavSelection(all[this.navSelectionIndex]);
        this.focusedPane = 'nav';
      }
      this.draw();
      return;
    }

    // 15. Left/Right: move the text cursor within a non-empty prompt (mirrors Up/Down's
    // own inputBuffer.length === 0 gating just above); only navigate highlighted items
    // once the prompt is empty and there's no text cursor to move.
    if (keyName === 'left' || keyStr === '\u001b[D' || keyName === 'right' || keyStr === '\u001b[C') {
      if (this.inputBuffer.length > 0) {
        if (keyName === 'left' || keyStr === '\u001b[D') {
          this.inputCursor = Math.max(0, this.inputCursor - 1);
        } else {
          this.inputCursor = Math.min(this.inputBuffer.length, this.inputCursor + 1);
        }
        this.draw();
        return;
      }
      const list = this.getAgents();
      if (list.length > 0) {
        if (keyName === 'left' || keyStr === '\u001b[D') {
          this.highlightedIndex = Math.max(0, this.highlightedIndex - 1);
        } else {
          this.highlightedIndex = Math.min(list.length - 1, this.highlightedIndex + 1);
        }
        this.selectedTaskId = list[this.highlightedIndex]?.taskId;
      }
      this.draw();
      return;
    }

    // 15.5. Home/End: jump the text cursor to the start/end of the prompt.
    if (keyName === 'home' || keyStr === '\x1b[H' || keyStr === '\x1bOH') {
      this.inputCursor = 0;
      this.draw();
      return;
    }
    if (keyName === 'end' || keyStr === '\x1b[F' || keyStr === '\x1bOF') {
      this.inputCursor = this.inputBuffer.length;
      this.draw();
      return;
    }

    // 16. Enter key: submit command or inspect item (§3)
    if (keyName === 'return' || keyName === 'enter' || keyStr === '\r' || keyStr === '\n') {
      if (this.inputBuffer.trim().length > 0) {
        const command = this.inputBuffer.trim();
        this.inputBuffer = '';
        this.inputCursor = 0;
        this.isPickerActive = false;
        this.pickerCandidates = [];
        // Nothing previously reset focus off 'prompt' after submitting, so any key that
        // requires nav focus (e.g. the 'x' job-delete shortcut) silently no-op'd — or, for
        // a printable key like 'x', got typed right back into the now-empty prompt buffer
        // — until the user happened to press an arrow key first.
        this.focusedPane = 'nav';
        void this.submitCommand(command);
      } else {
        // Enter to inspect currently selected item or block
        const all = this.getFlatNavItems();
        const current = all[this.navSelectionIndex];
        if (current?.category === 'JOBS') {
          // Opens the full, untruncated output modal — the main pane's inline preview
          // (see updateNavSelection) only wraps to 6 lines per task so a long result
          // doesn't crowd out the rest of the dashboard. This used to fall through to
          // the `else if` below and pop up an unrelated, most-recently-run history block
          // (e.g. a `doctor` command) instead, since a finished job has no live agent
          // card left in `this.agents`.
          this.expandedJobId = current.id;
          void this.refreshJobRollup(current.id);
        } else if (current?.category === 'EXECUTIONS' || this.getAgents().length > 0) {
          this.selectedTaskId =
            current?.category === 'EXECUTIONS' ? current.id : (this.selectedTaskId ?? this.getAgents()[0]?.taskId);
          this.currentView = 'tail';
          this.focusedPane = 'main';
        } else if (this.recentBlocks.length > 0 && !this.expandedBlock) {
          void this.expandBlock(this.recentBlocks[0].id);
        }
      }
      this.draw();
      return;
    }

    // 16.5. Delete key (or 'x' while nav is focused) on a selected JOBS nav item removes
    // that job's record. Forward-Delete only fires when the prompt is empty, so it can
    // never collide with editing text. 'x' additionally requires the nav pane itself to
    // be focused (not just an empty prompt) since it's a letter someone could otherwise
    // legitimately want to type — most Mac keyboards only send Backspace for the plain
    // "Delete" key; true forward-delete needs Fn+Delete, which is easy to miss, so this
    // gives an alternate that doesn't depend on that.
    if (
      !this.expandedJobId &&
      !this.expandedBlock &&
      (((keyName === 'delete' || keyStr === '\x1b[3~') && this.inputBuffer.length === 0) ||
        ((keyStr === 'x' || keyStr === 'X') && this.focusedPane === 'nav'))
    ) {
      const all = this.getFlatNavItems();
      const current = all[this.navSelectionIndex];
      if (current?.category === 'JOBS') {
        void this.deleteSelectedJob(current.id);
        return;
      }
      // Previously silent no-op when the highlighted item wasn't a JOBS entry — from the
      // outside that's indistinguishable from the key not registering at all. EXECUTIONS
      // items sit directly below JOBS in the nav and look similar, so it's an easy item
      // to be on by mistake; say so instead of doing nothing.
      this.statusMessage = current
        ? `'${keyStr === 'x' || keyStr === 'X' ? 'x' : 'Delete'}' only deletes items in the JOBS section (currently on ${current.category})`
        : `Select a job in the JOBS section first`;
      this.draw();
      return;
    }

    // 16.6. 'c' while nav is focused on a JOBS item cancels that job directly — the only
    // prior way to stop a running job was the /cancel command, and it only ever worked
    // against `this.currentJob` (the one launched this session), so cancelling an older
    // job picked from the nav (e.g. one reloaded from a past, possibly crashed session)
    // silently did nothing. This also unblocks deletion, which refuses an active job.
    if (
      !this.expandedJobId &&
      !this.expandedBlock &&
      (keyStr === 'c' || keyStr === 'C') &&
      this.focusedPane === 'nav'
    ) {
      const all = this.getFlatNavItems();
      const current = all[this.navSelectionIndex];
      if (current?.category === 'JOBS') {
        // Cancelling a job already in a terminal status (completed/failed) throws — with
        // no .catch() that was an unhandled promise rejection, which crashes the whole
        // Node process by default (not just the TUI), taking the app down on what should
        // be a harmless no-op if you press 'c' on a job that already finished.
        void this.engine.orchestrator
          .cancelJob(current.id)
          .then(() => {
            this.statusMessage = `Cancelled job ${current.id}`;
          })
          .catch((err) => {
            this.statusMessage = `Could not cancel job: ${err instanceof Error ? err.message : String(err)}`;
          })
          .finally(() => this.draw());
        return;
      }
    }

    // 16.7. 'r' on the Tail view opens the selected task's most recent raw model
    // response — the exact text the model produced, before parsing. Previously
    // reconstructable only by hand from `wa executions inspect --json`.
    if (
      (keyStr === 'r' || keyStr === 'R') &&
      this.currentView === 'tail' &&
      this.inputBuffer.length === 0 &&
      !this.expandedJobId &&
      !this.expandedBlock
    ) {
      const taskId = this.selectedTaskId ?? this.getAgents()[this.highlightedIndex]?.taskId;
      if (taskId && this.lastRawResponse.has(taskId)) {
        this.rawResponseModalOpen = true;
        this.draw();
      } else {
        this.statusMessage = 'No raw model response recorded yet for this task.';
        this.draw();
      }
      return;
    }

    // 17. Backspace / Delete Handling (§2):
    // Backspace removes the character(s) immediately before the cursor and moves the
    // cursor back; forward-delete (the 'delete' key/\x1b[3~) removes the character at
    // the cursor and leaves it in place. These used to be identical (both always chopped
    // off the end of the buffer) because there was no interior cursor to distinguish
    // "before" from "at" — now that Left/Right actually move one, they diverge.
    if (
      keyName === 'backspace' ||
      keyStr === '\u0008' ||
      keyStr === '\x7f' ||
      /^[\x7f\u0008]+$/.test(keyStr)
    ) {
      if (this.inputCursor > 0) {
        const count = Math.min(this.inputCursor, /^[\x7f\u0008]+$/.test(keyStr) ? keyStr.length : 1);
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor - count) + this.inputBuffer.slice(this.inputCursor);
        this.inputCursor -= count;
        this.checkReferencePicker();
        this.draw();
      }
      return;
    }
    if (keyName === 'delete' || keyStr === '\x1b[3~') {
      if (this.inputCursor < this.inputBuffer.length) {
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + this.inputBuffer.slice(this.inputCursor + 1);
        this.checkReferencePicker();
        this.draw();
      }
      return;
    }

    // 18. Ctrl+U: Clear entire input line
    if ((keyObj.ctrl && (keyName === 'u' || keyName === 'U')) || keyStr === '\u0015') {
      this.inputBuffer = '';
      this.inputCursor = 0;
      this.isPickerActive = false;
      this.pickerCandidates = [];
      this.draw();
      return;
    }

    // 19. Ctrl+W: Delete word backward from the cursor, leaving anything after it intact.
    if ((keyObj.ctrl && (keyName === 'w' || keyName === 'W')) || keyStr === '\u0017') {
      const before = this.inputBuffer.slice(0, this.inputCursor);
      const after = this.inputBuffer.slice(this.inputCursor);
      const trimmed = before.replace(/\s*\S*\s*$/, '');
      this.inputBuffer = trimmed + after;
      this.inputCursor = trimmed.length;
      this.checkReferencePicker();
      this.draw();
      return;
    }

    // 20. Control & Navigation Key Leak Guard (§2):
    // Prevent any non-printable, control, or navigation keys (Tab, Arrows, PageUp/Down)
    // from ever reaching text buffer or log streams.
    if (
      keyObj.ctrl ||
      keyObj.meta ||
      keyName === 'tab' ||
      keyName === 'backspace' ||
      keyName === 'delete' ||
      keyName === 'escape' ||
      keyName === 'return' ||
      keyName === 'enter' ||
      keyName === 'up' ||
      keyName === 'down' ||
      keyName === 'left' ||
      keyName === 'right' ||
      keyName === 'pageup' ||
      keyName === 'pagedown' ||
      keyStr === '\t' ||
      keyStr === '\x1b[Z' ||
      keyStr.startsWith('\x1b') ||
      keyStr.startsWith('\u001b') ||
      /^[\[O][A-Za-z0-9~]/.test(keyStr) ||
      /^\[[0-9;]*[a-zA-Z~]/.test(keyStr)
    ) {
      return;
    }

    // 21. Printable characters (§2):
    // Must be a single valid printable character (never an unparsed multi-byte sequence)
    if (
      keyStr.length === 1 &&
      !/[\x00-\x1f\x7f-\x9f]/.test(keyStr)
    ) {
      this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + keyStr + this.inputBuffer.slice(this.inputCursor);
      this.inputCursor += keyStr.length;
      this.focusedPane = 'prompt';
      this.checkReferencePicker();
      this.draw();
    }
  }

  private updateNavSelection(item: NavItem): void {
    this.selectedCategory = item.category;
    this.selectedNavId = item.id;
    this.eventScrollOffset = 0;
    if (item.category === 'EXECUTIONS') {
      this.selectedTaskId = item.id;
      const list = this.getAgents();
      const idx = list.findIndex((a) => a.taskId === item.id);
      if (idx !== -1) this.highlightedIndex = idx;
    } else if (item.category === 'JOBS') {
      void this.refreshJobRollup(item.id);
    }
  }

  private async refreshJobRollup(jobId: string): Promise<void> {
    try {
      const rollup = await this.engine.orchestrator.getJobRollup(jobId);
      this.jobRollups.set(jobId, rollup);
      this.draw();
    } catch {
      // Job may have been created without a store-backed rollup path (e.g. tests) — leave
      // whatever was cached (or nothing) rather than showing an error for a cosmetic field.
    }
  }

  private async deleteSelectedJob(jobId: string): Promise<void> {
    try {
      const deleted = await this.engine.orchestrator.deleteJob(jobId);
      if (deleted) {
        this.jobRollups.delete(jobId);
        if (this.currentJob?.id === jobId) this.currentJob = undefined;
        const all = this.getFlatNavItems();
        this.navSelectionIndex = Math.min(this.navSelectionIndex, Math.max(0, all.length - 1));
        const next = all[this.navSelectionIndex];
        if (next) this.updateNavSelection(next);
        this.statusMessage = `Deleted job ${jobId}`;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.statusMessage = /still active|still running/i.test(reason)
        ? `${reason} — press 'c' to cancel it first, then delete`
        : `Could not delete job: ${reason}`;
    }
    this.draw();
  }

  private checkReferencePicker(): void {
    const match = this.inputBuffer.match(/@([a-zA-Z0-9_:./-]*)$/);
    if (match) {
      const query = match[0].toLowerCase();
      const all = this.collectReferenceCandidates();
      this.pickerCandidates = all.filter((c) => c.toLowerCase().includes(query));
      this.isPickerActive = this.pickerCandidates.length > 0;
      this.pickerIndex = 0;
    } else {
      this.isPickerActive = false;
      this.pickerCandidates = [];
    }
  }

  private collectReferenceCandidates(): string[] {
    const list: string[] = [];

    // Blocks: @1, @2
    for (const b of this.recentBlocks) {
      list.push(`@${b.id}`);
    }

    // Jobs: @job:<id>
    const jobs = this.engine.orchestrator.listJobs?.() ?? (this.currentJob ? [this.currentJob] : []);
    for (const j of jobs) {
      list.push(`@job:${j.id}`);
    }

    // Agents: @agent:<id>
    for (const a of this.engine.agents.list()) {
      const name = a.descriptor?.name ?? 'agent';
      list.push(`@agent:${name}`);
    }

    // Models: @model:<id>
    for (const m of this.engine.models.list()) {
      list.push(`@model:${m.id}`);
    }

    // Computers: @computer:<id>
    for (const c of this.engine.computers.list()) {
      list.push(`@computer:${c.id}`);
    }

    // Files: @file:<path>
    list.push('@file:package.json');
    list.push('@file:README.md');

    return Array.from(new Set(list));
  }

  private async refreshRecentBlocks(): Promise<void> {
    try {
      this.recentBlocks = await listBlocks(this.engine);
    } catch {
      this.recentBlocks = [];
    }
  }

  private async expandBlock(blockId: string): Promise<void> {
    try {
      const block = await getBlock(this.engine, blockId);
      if (block) {
        this.expandedBlock = block;
        this.draw();
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Submits a user command or task prompt.
   */
  async submitCommand(cmd: string): Promise<void> {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    if (trimmed === '/exit' || trimmed === '/quit' || trimmed === 'q') {
      this.stop();
      return;
    }

    if (trimmed === '/help') {
      this.currentView = 'help';
      this.draw();
      return;
    }

    if (trimmed === '/fleet') {
      this.currentView = 'fleet';
      this.focusedPane = 'nav';
      this.draw();
      return;
    }

    if (trimmed === '/tail') {
      this.currentView = 'tail';
      this.focusedPane = 'main';
      this.draw();
      return;
    }

    if (trimmed === '/worktrees') {
      this.currentView = 'worktrees';
      this.draw();
      return;
    }

    if (trimmed === '/repaint') {
      this.screen.repaint();
      this.draw();
      return;
    }

    if (trimmed === '/clear-context') {
      await clearContext(this.engine).catch(() => {});
      this.statusMessage = 'Cleared all active context blocks';
      this.draw();
      return;
    }

    if (trimmed === '/doctor') {
      this.statusMessage = 'System diagnostics healthy: control plane, workers, and runtimes online';
      this.draw();
      return;
    }

    if (trimmed.startsWith('/launch')) {
      const parts = trimmed.split(/\s+/);
      const target = (parts[1] ?? 'lmstudio').toLowerCase();
      if (target !== 'lmstudio') {
        this.statusMessage =
          `Don't know how to launch '${target}' — only 'lmstudio' is supported (LM Studio ships an ` +
          `'lms' CLI for this; Ollama is normally already running as a background service).`;
        this.draw();
        return;
      }
      this.statusMessage = 'Launching LM Studio server (lms server start)...';
      this.draw();
      try {
        await execFileAsync(process.env.WAZIR_LMS_BIN ?? 'lms', ['server', 'start'], { timeout: 15_000 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.statusMessage = /ENOENT/.test(message)
          ? `'lms' CLI not found on PATH — install LM Studio (lmstudio.ai) or add its CLI to PATH`
          : `Failed to start LM Studio server: ${message.split('\n')[0]}`;
        this.draw();
        return;
      }
      // The server needs a moment to bind its port after `lms server start` returns —
      // poll briefly instead of reporting a false "still unreachable" on the first try.
      let result = await refreshRuntime(this.engine, 'lmstudio');
      for (let attempt = 0; !result.ok && attempt < 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        result = await refreshRuntime(this.engine, 'lmstudio');
      }
      this.statusMessage = result.ok
        ? `LM Studio started — ${result.message}`
        : `LM Studio server started, but still not reachable: ${result.message}`;
      this.draw();
      return;
    }

    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      const arg = trimmed.slice(6).trim();
      const available = this.engine.models.list();
      if (!arg) {
        const current = this.selectedModelId ?? 'auto (scheduler picks)';
        const ids = available.map((m) => m.id).join(', ') || '(none registered)';
        this.statusMessage = `Model: ${current}. Available: ${ids}. Use /model <id> to pin, /model auto to clear.`;
        this.draw();
        return;
      }
      if (arg === 'auto' || arg === 'clear') {
        this.selectedModelId = undefined;
        this.statusMessage = 'Cleared model pin — new tasks will be auto-routed by the scheduler again.';
        this.draw();
        return;
      }
      const match = available.find((m) => m.id === arg);
      if (!match) {
        const ids = available.map((m) => m.id).join(', ') || '(none registered)';
        this.statusMessage = `No registered model '${arg}'. Available: ${ids}.`;
        this.draw();
        return;
      }
      this.selectedModelId = match.id;
      this.statusMessage = `Pinned model to '${match.id}' — new tasks will use it instead of auto-routing.`;
      this.draw();
      return;
    }

    if (trimmed.startsWith('/block')) {
      const parts = trimmed.split(/\s+/);
      const targetId = parts[1] ?? this.recentBlocks[0]?.id;
      if (targetId) {
        await this.expandBlock(targetId);
      }
      return;
    }

    if (trimmed.startsWith('/cancel')) {
      // cancelJob()/cancelTask() throw for an invalid state transition (e.g. the job is
      // already completed/failed) — submitCommand() is always invoked fire-and-forget
      // (`void this.submitCommand(...)`), so an uncaught throw here is an unhandled
      // promise rejection, which crashes the whole Node process by default, not just the
      // TUI. Everything below is wrapped so a bad /cancel is a status message, not a crash.
      try {
        const parts = trimmed.split(/\s+/);
        const arg = parts[1];

        // A job id (e.g. one picked from the nav, possibly from a past session — /cancel
        // previously only ever worked against `this.currentJob`, the job launched in
        // *this* session, so cancelling an older/reloaded job did nothing at all).
        const argJob = arg ? this.engine.orchestrator.getJob(arg) : undefined;
        if (argJob) {
          await this.engine.orchestrator.cancelJob(argJob.id);
          this.statusMessage = `Cancelled job ${argJob.id}`;
        } else if (arg && this.currentJob) {
          await this.engine.orchestrator.cancelTask(this.currentJob.id, arg);
          this.statusMessage = `Cancelled task ${arg}`;
        } else {
          // No argument: cancel whatever's highlighted in the nav if it's a job.
          const all = this.getFlatNavItems();
          const selected = all[this.navSelectionIndex];
          if (selected?.category === 'JOBS') {
            await this.engine.orchestrator.cancelJob(selected.id);
            this.statusMessage = `Cancelled job ${selected.id}`;
          } else if (this.currentJob && this.selectedTaskId) {
            await this.engine.orchestrator.cancelTask(this.currentJob.id, this.selectedTaskId);
            this.statusMessage = `Cancelled task ${this.selectedTaskId}`;
          } else if (this.currentJob) {
            await this.engine.orchestrator.cancelJob(this.currentJob.id);
            this.statusMessage = `Cancelled job ${this.currentJob.id}`;
          } else {
            this.statusMessage = `No job selected to cancel`;
          }
        }
      } catch (err) {
        this.statusMessage = `Could not cancel: ${err instanceof Error ? err.message : String(err)}`;
      }
      this.draw();
      return;
    }

    if (trimmed.startsWith('/steer ')) {
      const instruction = trimmed.slice(7).trim();
      const targetTaskId = this.selectedTaskId ?? this.getAgents()[this.highlightedIndex]?.taskId;
      if (this.currentJob && targetTaskId) {
        this.engine.orchestrator.steerTask(this.currentJob.id, targetTaskId, instruction);
        this.statusMessage = `Injected steering into ${targetTaskId}: "${instruction}"`;
      } else if (this.currentJob) {
        this.engine.orchestrator.steerJob(this.currentJob.id, instruction);
        this.statusMessage = `Injected fleet-wide steering: "${instruction}"`;
      } else {
        this.statusMessage = `Injected steering: "${instruction}"`;
      }
      this.draw();
      return;
    }

    // Resolve @ references via references.ts
    const refMatches = trimmed.match(/@[a-zA-Z0-9_:./-]+/g);
    if (refMatches && refMatches.length > 0) {
      const resolved = await Promise.all(
        refMatches.map((r) => resolveReference(this.engine, r).catch(() => ({ kind: 'unresolved' as const, raw: r }))),
      );
      this.lastResolvedReferences = resolved;
      const summary = resolved
        .map((r) => `${r.kind}:${'id' in r ? r.id : 'path' in r ? r.path : 'raw' in r ? r.raw : ''}`)
        .join(', ');
      this.statusMessage = `Resolved references: ${summary}`;
    }

    // Track command execution block
    try {
      if (this.engine.store) {
        this.currentBlockTracker = await createBlock(this.engine, trimmed);
        await this.refreshRecentBlocks();
      }
    } catch {
      // Store may not be configured
    }

    // Submit a new task or fan-out job
    await this.launchJobFromPrompt(trimmed);
  }

  /**
   * Decomposes or parses a user prompt and launches concurrent execution.
   */
  async launchJobFromPrompt(prompt: string): Promise<void> {
    this.statusMessage = 'Planning & scheduling job...';
    this.draw();

    let taskDescriptions: string[] = [];

    if (prompt.startsWith('/fanout ')) {
      const raw = prompt.slice(8).trim();
      taskDescriptions = raw.split(';').map((s) => s.trim()).filter(Boolean);
    } else if (prompt.includes('\n- ') || prompt.includes('\n* ')) {
      taskDescriptions = prompt.split(/\n[-*]\s+/).map((s) => s.trim()).filter(Boolean);
    } else {
      taskDescriptions = [prompt];
    }

    // Build tasks with dependency edges. Deliberately no explicit `id` here — every job
    // used to get task ids `task-1`, `task-2`, ... regardless of which job it was, and
    // ExecutionEngine.listByTask(taskId) filters by task id ALONE with no job scoping, so
    // getJobRollup() for one job was silently pulling in tokens/filesChanged from every
    // OTHER job that happened to reuse the same task id (which is nearly all of them,
    // since any single-task job got "task-1"). JobManager.create() auto-assigns a
    // globally unique `task-<jobId>-<i>` id when none is given — exactly what's needed.
    const jobTasks = taskDescriptions.map((desc) => ({
      task: {
        type: 'coding',
        title: desc.slice(0, 50),
        input: desc,
        execution: this.selectedModelId ? { targetModelId: this.selectedModelId } : undefined,
      },
    }));

    try {
      const job = await this.engine.orchestrator.createJob({
        title: prompt.slice(0, 60),
        concurrencyLimit: this.concurrencyLimit,
        tasks: jobTasks,
      });

      this.currentJob = job;
      this.agents.clear();
      this.agentLogs.clear();

      for (const t of job.tasks) {
        const card: AgentCardState = {
          taskId: t.id,
          title: t.title ?? t.input.slice(0, 40),
          agentId: 'wazir-coding',
          computerId: 'evaluating...',
          modelId: 'evaluating...',
          phase: 'queued',
          lastMessage: 'Waiting for scheduler slot',
          status: 'idle',
          durationMs: 0,
          filesChanged: [],
        };
        this.agents.set(t.id, card);
        this.agentLogs.set(t.id, []);
      }

      this.highlightedIndex = 0;
      this.selectedTaskId = job.tasks[0]?.id;
      this.selectedNavId = job.tasks[0]?.id;
      this.selectedCategory = 'EXECUTIONS';
      const all = this.getFlatNavItems();
      const firstExecIdx = all.findIndex((it) => it.category === 'EXECUTIONS');
      if (firstExecIdx !== -1) {
        this.navSelectionIndex = firstExecIdx;
      }

      // Subscribe to live orchestrator events
      if (this.unsubscribeJobEvents) this.unsubscribeJobEvents();
      this.unsubscribeJobEvents = this.engine.orchestrator.subscribe(job.id, this.onJobEvent);

      // Create executor and launch job
      const executor = createFleetTaskExecutor(this.engine, {
        useWorktrees: this.useWorktrees,
        autoMerge: this.autoMerge,
      });

      this.statusMessage = `Job ${job.id} running up to ${this.concurrencyLimit} agents concurrently...`;
      this.draw();

      // Run asynchronously
      void (async () => {
        try {
          await this.engine.orchestrator.runJob(job.id, {
            concurrencyLimit: this.concurrencyLimit,
            taskExecutor: executor,
            timeoutSeconds: this.timeoutSeconds,
          });

          this.currentRollup = await this.engine.orchestrator.getJobRollup(job.id);
          this.jobRollups.set(job.id, this.currentRollup);
          // A timeout is reported as 'failed' with the reason on the task node; say so
          // here rather than a bare "failed!" that hides why.
          const timeoutNode = job.graph.nodes.find((n) => /timeout/i.test(n.error ?? ''));
          const outcome = timeoutNode ? `failed (${timeoutNode.error})` : `${job.status}!`;
          this.statusMessage = `Job ${job.id} ${outcome} Tokens: In ${this.currentRollup.tokens.input}/Out ${this.currentRollup.tokens.output}, Dur: ${(this.currentRollup.durationMs / 1000).toFixed(1)}s`;

          if (this.currentBlockTracker) {
            await this.currentBlockTracker.finish(job.status === 'completed' ? 'success' : 'failed', {
              exitCode: job.status === 'completed' ? 0 : 1,
            });
            this.currentBlockTracker = undefined;
            await this.refreshRecentBlocks();
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.statusMessage = `Job execution error: ${errMsg}`;

          // Structured error component (§29)
          this.currentError = {
            phase: 'scheduling',
            reason: errMsg,
            required: `Allocatable compute on workstation with loaded model`,
            available: `Models: ${this.engine.models.list().length}, Concurrency: ${this.concurrencyLimit}`,
            suggestedSteps: [
              '1. Verify model instances are loaded: wa models list',
              '2. Run system health diagnostics: wa doctor',
              '3. Check memory & context limits in wazir.json',
            ],
            timestamp: new Date(),
          };

          if (this.currentBlockTracker) {
            await this.currentBlockTracker.finish('failed', {
              exitCode: 1,
              stderr: errMsg,
            });
            this.currentBlockTracker = undefined;
            await this.refreshRecentBlocks();
          }
        }
        this.draw();
      })();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.statusMessage = `Scheduling failed: ${errMsg}`;
      this.currentError = {
        phase: 'scheduling',
        reason: errMsg,
        required: 'Valid task definition and available agent',
        available: 'Scheduler queue rejection',
        suggestedSteps: [
          '1. Verify task syntax and prompt format',
          '2. Check active context budget with wa context list',
        ],
        timestamp: new Date(),
      };
      this.draw();
    }
  }

  /** Folds a task's in-progress streamed model text into its log as one MODEL entry. */
  private flushStreaming(taskId: string, logs: AgentLogEntry[], timeStr: string): void {
    const raw = this.streamingBuffers.get(taskId);
    this.streamingBuffers.delete(taskId);
    if (!raw || !raw.trim()) return;
    logs.push({ time: timeStr, text: this.summarizeModelOutput(raw), kind: 'model' });
    if (logs.length > 500) logs.shift();
  }

  /**
   * One-line, human-readable form of a raw model turn. The model answers with one JSON
   * action per turn; the interesting part of that JSON differs by action, so this pulls
   * out the part a person actually wants to see (the plan text, the shell command, the
   * file being written) rather than logging the raw envelope verbatim. Falls back to the
   * raw text when it isn't parseable — a model going off-protocol is itself worth seeing.
   */
  private summarizeModelOutput(raw: string): string {
    const flat = raw.replace(/\s+/g, ' ').trim();
    const action = parseAction(raw);
    if (!action) return flat;
    const obj = action as unknown as Record<string, unknown>;
    // `{"action":"tool","tool":"shell","input":{...}}` and the shorthand
    // `{"action":"shell","command":"..."}` both occur; read args from whichever is present.
    const input = (obj.input && typeof obj.input === 'object' ? obj.input : obj) as Record<string, unknown>;
    const tool = action.tool ?? (action.action === 'tool' ? undefined : action.action);
    switch (action.action) {
      case 'plan':
        return `Plan: ${action.content ?? ''}`;
      case 'done':
      case 'answer':
        return `${action.action === 'done' ? 'Done' : 'Answer'}: ${action.summary ?? action.content ?? ''}`;
    }
    // Narrated, present-tense phrasing for the common tools — reads like what
    // a person would say they're doing, not a raw {tool, args} dump.
    switch (tool) {
      case 'shell':
        return `Running: ${String(input.command ?? '')}`;
      case 'write':
        return `Writing ${String(input.path ?? '')} (${typeof input.content === 'string' ? input.content.length : 0} chars)`;
      case 'edit':
        return `Editing ${String(input.path ?? '')}`;
      case 'read':
        return `Reading ${String(input.path ?? '')}`;
      case 'glob':
        return `Looking for files matching ${String(input.pattern ?? '')}`;
      case 'search':
        return `Searching code for ${String(input.pattern ?? '')}`;
      case 'git':
        return `Running: git ${Array.isArray(input.args) ? input.args.join(' ') : ''}`.trim();
      case 'test':
      case 'lint':
      case 'typecheck':
      case 'build':
        return `Running ${tool}`;
    }
    if (tool) {
      const args = obj.input && typeof obj.input === 'object'
        ? obj.input
        : Object.fromEntries(Object.entries(obj).filter(([k]) => k !== 'action' && k !== 'tool'));
      return `Using ${tool}: ${JSON.stringify(args)}`;
    }
    return flat;
  }

  /**
   * Translates internal error strings (policy rule ids, circuit-breaker
   * wording, raw parser messages) into something a person reads without
   * needing to know how the policy engine or agent loop works. Anything
   * that doesn't match a known shape is returned unchanged rather than
   * hidden — never silently swallow information the user might need.
   */
  private humanizeError(raw: string): string {
    const policyMatch = raw.match(/^policy (deny|ask) \(([^)]+)\): (.+)$/);
    if (policyMatch) {
      const [, decision, , reasons] = policyMatch;
      return decision === 'deny' ? `Blocked: ${reasons}` : `Needs your approval: ${reasons}`;
    }
    const breakerMatch = raw.match(/^circuit breaker: model called (\S+) with identical input (\d+) times in a row without making progress$/);
    if (breakerMatch) {
      const [, tool, count] = breakerMatch;
      return `Stopped — called ${tool} the same way ${count} times in a row with no progress`;
    }
    const parseMatch = raw.match(/^shell command could not be parsed: (.+)$/);
    if (parseMatch) return `Couldn't understand that shell command: ${parseMatch[1]}`;
    if (raw === 'model repeatedly failed to produce valid JSON actions') {
      return 'The model kept responding in a way I could not act on';
    }
    return raw;
  }

  private onJobEvent = (ev: JobOrchestratorEvent): void => {
    const taskId = ev.taskId;
    const now = new Date();
    const timeStr = now.toISOString().slice(11, 19);

    if (taskId && this.agents.has(taskId)) {
      const agent = this.agents.get(taskId)!;
      const logs = this.agentLogs.get(taskId) ?? [];

      if (ev.type === 'task:started') {
        agent.status = 'running';
        agent.startedAt = agent.startedAt ?? now;
        if (ev.computerId) agent.computerId = ev.computerId;
        if (ev.modelId) agent.modelId = ev.modelId;
        if (ev.agentId) agent.agentId = ev.agentId;
        agent.phase = 'plan';
        agent.lastMessage = 'Agent started';

        // Typed event logging (§11)
        logs.push({
          time: timeStr,
          text: `Agent ${agent.agentId} started execution`,
          kind: 'plan',
        });
        logs.push({
          time: timeStr,
          text: `Route assigned: model [${agent.modelId}] on computer [${agent.computerId}]`,
          kind: 'route',
        });
      } else if (ev.type === 'task:progress') {
        const p = ev.event as {
          kind?: string;
          phase?: string;
          content?: string;
          tool?: string;
          error?: string;
          usage?: { input: number; output: number; total: number };
          raw?: string;
        };

        // Raw model output, one token at a time. Accumulated into a per-task buffer that
        // the Tail view renders live (the "thinking" pane), then folded into the log as
        // a single MODEL line when the turn ends. Not drawn per token on purpose — a fast
        // local model can emit dozens a second; the 250ms render tick picks it up.
        if (p.kind === 'token') {
          const prev = this.streamingBuffers.get(taskId) ?? '';
          const next = prev + (p.content ?? '');
          this.streamingBuffers.set(taskId, next.length > 12_000 ? next.slice(-12_000) : next);
          return;
        }

        // The model turn just finished (its usage is known): fold the streamed text into
        // the log before the resulting tool/phase event lands, so the log reads in causal
        // order — what the model said, then what happened because of it.
        this.flushStreaming(taskId, logs, timeStr);

        if (p.kind === 'usage') {
          if (p.usage) agent.lastTurnInputTokens = p.usage.input;
          this.agentLogs.set(taskId, logs);
          this.draw();
          return;
        }

        if (p.phase) agent.phase = p.phase;
        if (p.content) agent.lastMessage = p.content.slice(0, 60);
        if (p.tool) agent.lastMessage = `Tool: ${p.tool}`;
        if (p.error) agent.lastMessage = `Error: ${this.humanizeError(p.error).slice(0, 60)}`;

        let eventKind: 'plan' | 'route' | 'tool' | 'test' | 'complete' | 'error' | 'info' | 'validate' = 'info';
        let eventText = p.content ?? (p.tool ? `tool: ${p.tool}` : `phase: ${p.phase}`);

        // Protocol/validation corrections (a locally-rejected malformed tool call, a
        // repeated-action circuit-breaker trip, an unparseable response) — these used to
        // be entirely invisible: silently patched into the model's next prompt with no
        // trace in the log at all. Checked ahead of the generic `p.tool` handling below
        // since these DO carry a `tool` name (which action was rejected), and would
        // otherwise be mislabeled as an ordinary tool result.
        const VALIDATION_PREFIXES = ['ACTION_VALIDATION_FAILED:', 'ACTION_BLOCKED_DUPLICATE:', 'INVALID_JSON_ACTION:'];
        const validationPrefix = VALIDATION_PREFIXES.find((prefix) => p.content?.startsWith(prefix));
        if (validationPrefix) {
          eventKind = 'validate';
          eventText = p.content!.slice(validationPrefix.length).trim() || validationPrefix.replace(/:$/, '');
        } else if (p.tool) {
          // A tool_call turn's outcome (ok/error) rides in the same progress event —
          // it used to be silently dropped here, so a failed tool call showed only
          // "Tool call executed: shell" with no indication anything went wrong, and
          // the real reason surfaced (if at all) only via the model quoting the raw
          // internal string back in its own reasoning several turns later.
          if (p.error) {
            eventKind = 'error';
            eventText = `${p.tool} failed — ${this.humanizeError(p.error)}`;
          } else {
            eventKind = 'tool';
            eventText = `${p.tool} succeeded`;
          }
        } else if (p.phase === 'test' || p.phase === 'verify') {
          eventKind = 'test';
          eventText = `Verification checks running (${p.phase})`;
        } else if (p.phase === 'plan') {
          eventKind = 'plan';
        } else if (p.error) {
          eventKind = 'error';
          eventText = this.humanizeError(p.error);
        }

        logs.push({
          time: timeStr,
          text: eventText,
          kind: eventKind,
          raw: p.raw,
        });
        if (p.raw) this.lastRawResponse.set(taskId, p.raw);
        if (logs.length > 500) logs.shift();
      } else if (ev.type === 'task:completed') {
        this.flushStreaming(taskId, logs, timeStr);
        agent.status = 'completed';
        agent.completedAt = now;
        agent.phase = 'complete';
        agent.lastMessage = 'Task completed';
        if (ev.filesChanged) agent.filesChanged = ev.filesChanged;
        if (ev.usage) agent.usage = ev.usage;

        logs.push({
          time: timeStr,
          text: `Task completed successfully (${agent.filesChanged.length} files updated)`,
          kind: 'complete',
        });
      } else if (ev.type === 'task:failed') {
        this.flushStreaming(taskId, logs, timeStr);
        agent.status = 'failed';
        agent.completedAt = now;
        agent.phase = 'failed';
        const failureReason = ev.error ? this.humanizeError(ev.error) : 'Task failed';
        agent.lastMessage = failureReason;

        logs.push({
          time: timeStr,
          text: `Task failed: ${failureReason}`,
          kind: 'error',
        });

        // Structured Error Component (§29)
        this.currentError = {
          phase: agent.phase || 'execution',
          reason: ev.error ? this.humanizeError(ev.error) : 'Task execution encountered error',
          required: 'Clean tool execution and passing tests',
          available: 'Uncaught failure or policy denial',
          suggestedSteps: [
            '1. Inspect event stream logs in main activity pane',
            '2. Run "wa doctor" to verify runtime health',
            '3. Retry task or provide steering via /steer <instruction>',
          ],
          taskId: agent.taskId,
          timestamp: now,
        };
      } else if (ev.type === 'task:retry') {
        agent.status = 'retry';
        agent.phase = 'repair';
        agent.lastMessage = `Retry ${ev.retryCount}/${ev.maxRetries}`;

        logs.push({
          time: timeStr,
          text: `Repair turn initiated (retry ${ev.retryCount}/${ev.maxRetries})`,
          kind: 'test',
        });
      } else if (ev.type === 'task:cancelled') {
        this.flushStreaming(taskId, logs, timeStr);
        agent.status = 'cancelled';
        agent.phase = 'cancelled';
        // ev.error is set when the system did the cancelling (the job timeout) — without
        // distinguishing it, a timed-out task read as "cancelled by operator", which
        // blames a person for something they didn't do and hides the real cause.
        agent.lastMessage = ev.error ? `Stopped: ${ev.error}` : 'Cancelled';

        logs.push({
          time: timeStr,
          text: ev.error ? `Task stopped automatically: ${ev.error}` : 'Task was cancelled by operator',
          kind: ev.error ? 'error' : 'info',
        });
      } else if (ev.type === 'task:steered') {
        agent.lastMessage = `Steered: ${ev.instruction?.slice(0, 40)}`;
        logs.push({
          time: timeStr,
          text: `Injected instruction: ${ev.instruction}`,
          kind: 'plan',
        });
      }
      this.agentLogs.set(taskId, logs);
    }

    this.draw();
  };

  private updateAgentDurations(): void {
    this.spinnerTick++;
    const now = Date.now();
    for (const agent of this.agents.values()) {
      if (agent.status === 'running' && agent.startedAt) {
        agent.durationMs = Math.max(0, now - agent.startedAt.getTime());
      } else if (agent.startedAt && agent.completedAt) {
        agent.durationMs = Math.max(0, agent.completedAt.getTime() - agent.startedAt.getTime());
      }
    }
  }

  // ==========================================
  // Navigation Index Items Generator
  // ==========================================
  getFlatNavItems(): NavItem[] {
    const items: NavItem[] = [];

    // 1. JOBS
    const jobs = this.engine.orchestrator.listJobs?.() ?? (this.currentJob ? [this.currentJob] : []);
    for (const j of jobs) {
      items.push({
        category: 'JOBS',
        id: j.id,
        label: `${shortJobId(j.id)} ${j.title.slice(0, 22)}`,
        status:
          j.status === 'running'
            ? 'running'
            : j.status === 'completed'
              ? 'completed'
              : j.status === 'failed'
                ? 'failed'
                : 'idle',
      });
    }

    // 2. EXECUTIONS (Active tasks)
    const agentCards = this.getAgents();
    for (const a of agentCards) {
      items.push({
        category: 'EXECUTIONS',
        id: a.taskId,
        label: `${a.taskId} (${a.title.slice(0, 14)})`,
        status:
          a.status === 'running'
            ? 'running'
            : a.status === 'completed'
              ? 'completed'
              : a.status === 'failed'
                ? 'failed'
                : 'idle',
        routing: {
          agentId: a.agentId,
          modelId: a.modelId,
          runtimeId: 'local',
          computerId: a.computerId,
        },
      });
    }

    // 3. AGENTS
    const agentList = this.engine.agents.list();
    for (const ag of agentList) {
      const agentId = ag.descriptor?.name ?? 'unknown-agent';
      const isRunning = agentCards.some((a) => a.agentId === agentId && a.status === 'running');
      items.push({
        category: 'AGENTS',
        id: agentId,
        label: agentId,
        status: isRunning ? 'running' : 'idle',
        routing: {
          agentId,
        },
      });
    }

    // 4. COMPUTERS
    const compList = this.engine.computers.list();
    for (const comp of compList) {
      const isRunning = agentCards.some((a) => a.computerId === comp.id && a.status === 'running');
      items.push({
        category: 'COMPUTERS',
        id: comp.id,
        label: comp.name || comp.id,
        status: isRunning ? 'running' : 'completed',
        routing: {
          computerId: comp.id,
        },
      });
    }

    // 5. RUNTIMES
    const runtimes = this.engine.runtimes.list();
    for (const rt of runtimes) {
      const isRunning = agentCards.some((a) => a.computerId === rt.computerId && a.status === 'running');
      // A runtime that failed discovery (LM Studio's server not started, Ollama not
      // running, ...) was previously indistinguishable from an idle-but-fine one — both
      // just showed the same decorative activity dot. Surface its real health instead.
      const health = this.engine.discovered.find((d) => d.id === rt.id)?.health;
      items.push({
        category: 'RUNTIMES',
        id: rt.id,
        label: rt.name || rt.id,
        status: health === 'unavailable' ? 'failed' : isRunning ? 'running' : 'completed',
        routing: {
          runtimeId: rt.id,
          computerId: rt.computerId,
        },
      });
    }

    return items;
  }

  // ==========================================
  // Context Indicator Metrics (§20)
  // ==========================================
  /**
   * Context-window occupancy: the prompt size of the most recent model turn, taken from
   * the running (else most recently started) agent. This used to sum the job's
   * cumulative tokens plus rough estimates of every log line and block on screen, and
   * fake 8.4K when idle — which is how it displayed "106.6K/32K" for a 32K model. Only a
   * measured number is shown now; 0 means no model turn has completed yet.
   */
  getContextMetrics(): { used: number; max: number } {
    const agents = Array.from(this.agents.values());
    const byRecency = (a: AgentCardState, b: AgentCardState) =>
      (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0);
    const source =
      agents.filter((a) => a.status === 'running' && a.lastTurnInputTokens !== undefined).sort(byRecency)[0] ??
      agents.filter((a) => a.lastTurnInputTokens !== undefined).sort(byRecency)[0];
    const used = source?.lastTurnInputTokens ?? 0;

    const models = this.engine.models.list();
    const max = models[0]?.contextMax ?? 32768;
    return { used, max };
  }

  // ==========================================
  // Layout & Frame Rendering
  // ==========================================
  /**
   * Renders the persistent 5-region frame to the terminal screen buffer.
   */
  draw(): void {
    const size = this.screen.getSize();
    const lines: string[] = [];

    // Region 1: Header Bar (Line 0) + Divider (Line 1)
    lines.push(this.renderHeader(size.columns));
    lines.push(color.gray('-'.repeat(size.columns)));

    // Region 2: Persistent Split Content or Collapsed Pane
    const contentHeight = Math.max(5, size.rows - 6);

    const isSplit = size.columns >= 100;
    if (isSplit) {
      const leftWidth = Math.max(26, Math.min(36, Math.floor(size.columns * 0.28)));
      const mainWidth = size.columns - leftWidth - 1;

      const leftLines = this.renderLeftNav(leftWidth, contentHeight);
      const mainLines = this.renderMainPane(mainWidth, contentHeight);

      for (let i = 0; i < contentHeight; i++) {
        const l = leftLines[i] ?? ' '.repeat(leftWidth);
        const m = mainLines[i] ?? ' '.repeat(mainWidth);
        lines.push(`${l}${color.gray('|')}${m}`);
      }
    } else {
      // Collapsed single pane layout
      const mainLines = this.renderMainPane(size.columns, contentHeight);
      for (let i = 0; i < contentHeight; i++) {
        lines.push(mainLines[i] ?? '');
      }
    }

    // Overlays over content region:
    // A. Policy Approval Modal Card
    if (this.pendingApprovals.length > 0) {
      const modalLines = this.renderApprovalModal(size.columns);
      const startY = Math.max(2, 2 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.currentError) {
      // B. Structured Error Card Modal (§29)
      const modalLines = this.renderStructuredErrorCard(this.currentError, size.columns);
      const startY = Math.max(2, 2 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.quickActionsOpen) {
      // C. Quick Actions Palette Modal (§3)
      const modalLines = this.renderQuickActionsModal(size.columns);
      const startY = Math.max(2, 2 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.expandedBlock) {
      // D. Expanded Block Modal Card
      const modalLines = this.renderBlockModal(this.expandedBlock, size.columns);
      const startY = Math.max(2, 2 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.rawResponseModalOpen) {
      // D.5 Raw Model Response Modal ('r' on Tail view)
      const taskId = this.selectedTaskId ?? this.getAgents()[this.highlightedIndex]?.taskId;
      if (taskId) {
        const modalLines = this.renderRawResponseModal(taskId, size.columns);
        const startY = Math.max(2, 2 + Math.floor((contentHeight - modalLines.length) / 2));
        this.overlayModal(lines, modalLines, size.columns, startY);
      } else {
        this.rawResponseModalOpen = false;
      }
    } else if (this.expandedJobId) {
      // E. Full Job Output Modal — the compact JOBS detail view only shows a 6-line
      // wrapped preview of each task's result; this shows the whole thing.
      const job = this.engine.orchestrator.getJob(this.expandedJobId);
      if (job) {
        const modalLines = this.renderJobOutputModal(job, this.jobRollups.get(job.id), size.columns);
        const startY = Math.max(2, 2 + Math.floor((contentHeight - modalLines.length) / 2));
        this.overlayModal(lines, modalLines, size.columns, startY);
      } else {
        this.expandedJobId = undefined;
      }
    }

    // Region 3: History Strip (Line size.rows - 4)
    lines.push(this.renderHistoryStrip(size.columns));

    // Region 4: Status Bar Divider & Line (Lines size.rows - 3 & size.rows - 2)
    lines.push(color.gray('-'.repeat(size.columns)));
    lines.push(this.renderStatusBar(size.columns));

    // Region 5: Command Input Bar (Line size.rows - 1)
    lines.push(this.renderInputBar(size.columns));

    // Floating Reference Picker Popup: overlaid right above prompt line
    if (this.isPickerActive && this.pickerCandidates.length > 0) {
      const pickerLines = this.buildPickerPopup(this.pickerCandidates, this.pickerIndex, Math.min(size.columns, 45));
      const startY = Math.max(2, lines.length - 1 - pickerLines.length);
      for (let i = 0; i < pickerLines.length; i++) {
        const y = startY + i;
        if (y >= 0 && y < lines.length) {
          const pLine = pickerLines[i];
          const pLen = this.stripAnsi(pLine).length;
          const leftPad = 4;
          const rightPad = Math.max(0, size.columns - leftPad - pLen);
          lines[y] = ' '.repeat(leftPad) + pLine + ' '.repeat(rightPad);
        }
      }
    }

    // Final width clamp (§1, §2): every region above assembles its own lines and some
    // (input bar, status bar, worktrees/approval/help panes) don't pad/truncate themselves.
    // A line even one character wider than the terminal causes it to soft-wrap, which
    // desyncs every following \r\n from the absolute \x1b[H cursor reset used in render()
    // and can scroll the alt-screen buffer - producing exactly the ghosting/overlay and
    // "backspace does nothing" symptoms once the input line (or status bar) gets long.
    // Clamping every line here, once, guarantees no row can ever exceed the terminal width.
    const clampedLines = lines.map((line) => this.padRightTo(line, size.columns));

    const frame = clampedLines.slice(0, size.rows).join('\n');
    this.screen.render(frame, this.inputCursorScreenCol);
  }

  /**
   * Region 1: Header Reconfiguration
   * Format: WAZIR - CONTROL - WORKER: 3 COMPUTERS 7 AGENTS 14 MODELS    Agents 2/4 - AVAILABLE
   */
  private renderHeader(cols: number): string {
    const compCount = this.engine.computers.list().length;
    const agentCount = this.engine.agents.list().length;
    const modelCount = this.engine.models.list().length;

    const activeCount = Array.from(this.agents.values()).filter((a) => a.status === 'running').length;
    const workerStatus = activeCount >= this.concurrencyLimit ? 'BUSY' : 'AVAILABLE';

    // §3: View Title Indicator - fully overwritten on state changes using fixed-width padding
    // to prevent concatenation artifacts (e.g., [View: FLEET]EES clipping bug)
    const viewName = this.currentView.toUpperCase();
    const viewTag = `[View: ${viewName}]`;
    // Pad to fixed 20 chars so switching between FLEET/TAIL/APPROVAL/WORKTREES/HELP never leaves residual chars
    const viewTagPadded = viewTag.padEnd(20);

    // Semantic Colors (§25): cyan = identity / active context, green = ok/success, yellow = waiting
    const titlePart = `${color.bold(color.cyan('WAZIR'))} ${color.gray('-')} ${color.bold('CONTROL')} ${color.gray('-')} ${color.bold('WORKER:')} ${compCount} COMPUTERS ${agentCount} AGENTS ${modelCount} MODELS`;
    const viewPart = color.bold(color.cyan(viewTagPadded));
    const agentPart = `Agents ${activeCount}/${this.concurrencyLimit} ${color.gray('-')} ${workerStatus === 'AVAILABLE' ? color.green('AVAILABLE') : color.yellow('BUSY')}`;

    const pendingCount = this.pendingApprovals.length;
    const alert = pendingCount > 0 ? color.bold(color.yellow(` [! ${pendingCount} APPROVALS]`)) : '';

    const titlePlain = `WAZIR - CONTROL - WORKER: ${compCount} COMPUTERS ${agentCount} AGENTS ${modelCount} MODELS`;
    const viewPlain = viewTagPadded;
    const agentPlain = `Agents ${activeCount}/${this.concurrencyLimit} - ${workerStatus}${pendingCount > 0 ? ` [! ${pendingCount} APPROVALS]` : ''}`;

    const spaces = Math.max(1, cols - titlePlain.length - viewPlain.length - agentPlain.length - 4);
    const headerLine = ` ${titlePart} ${viewPart}${' '.repeat(spaces)}${agentPart}${alert}`;
    return this.padRightTo(headerLine, cols);
  }

  /**
   * Region 2: Left Nav Pane - Categorized Section Index
   * Semantic Colors (§25): blue = selected/highlighted, cyan = running, green = completed, yellow = pending
   */
  private renderLeftNav(width: number, maxRows: number): string[] {
    const lines: string[] = [];
    const categories: NavCategory[] = ['JOBS', 'EXECUTIONS', 'AGENTS', 'COMPUTERS', 'RUNTIMES'];
    const flatItems = this.getFlatNavItems();
    const currentSelected = flatItems[this.navSelectionIndex];

    for (const cat of categories) {
      if (lines.length >= maxRows) break;
      const isCatNavFocused = this.focusedPane === 'nav';
      lines.push(this.padRightTo(` ${color.bold(color.cyan(cat))}`, width));

      const catItems = flatItems.filter((it) => it.category === cat);
      if (catItems.length === 0) {
        if (lines.length < maxRows) {
          lines.push(this.padRightTo(color.gray('   (none)'), width));
        }
      } else {
        for (const item of catItems) {
          if (lines.length >= maxRows) break;
          const isSelected =
            currentSelected && currentSelected.category === item.category && currentSelected.id === item.id;

          // Semantic Colors (§25): blue = selected / highlighted
          const cursor = isSelected ? color.blue('> ') : '  ';

          let glyph = color.yellow('o');
          if (item.status === 'running') glyph = color.cyan(getCategorySpinnerFrame(item.category, this.spinnerTick));
          else if (item.status === 'completed') glyph = color.green('+');
          else if (item.status === 'failed') glyph = color.red('x');

          const maxLabelLen = Math.max(6, width - 8);
          const labelStr = item.label || item.id || 'item';
          const label = labelStr.length > maxLabelLen ? labelStr.slice(0, maxLabelLen - 1) + '.' : labelStr;
          const text = `${cursor}${glyph} ${isSelected ? color.blue(color.bold(label)) : label}`;
          lines.push(this.padRightTo(` ${text}`, width));
        }
      }
    }

    while (lines.length < maxRows) {
      lines.push(this.padRightTo('', width));
    }

    return lines;
  }

  /**
   * Region 2: Main Pane - Routing Info & Event-Stream Activity Pane (§11)
   * Tracks chronological lines for PLAN, ROUTE, TOOL, TEST, and COMPLETE states.
   */
  private renderMainPane(width: number, maxRows: number): string[] {
    const lines: string[] = [];
    const flatItems = this.getFlatNavItems();
    let selected = flatItems[this.navSelectionIndex];

    // Handle view overrides (help, worktrees)
    if (this.currentView === 'help') {
      return this.renderHelpPane(width, maxRows);
    }
    if (this.currentView === 'worktrees') {
      return this.renderWorktreesPane(width, maxRows);
    }
    if (this.currentView === 'approval') {
      return this.renderApprovalPane(width, maxRows);
    }

    // In 'tail' view: ensure we render the execution event-stream activity pane (§11)
    if (this.currentView === 'tail') {
      const execItem =
        flatItems.find((it) => it.category === 'EXECUTIONS' && it.id === this.selectedTaskId) ??
        flatItems.find((it) => it.category === 'EXECUTIONS');
      if (execItem) {
        selected = execItem;
      }
    }

    if (!selected) {
      lines.push(this.padRightTo('  No items registered in index.', width));
      while (lines.length < maxRows) lines.push(this.padRightTo('', width));
      return lines;
    }

    // 1. Routing Info Header
    let routingLine = '';
    if (selected.category === 'EXECUTIONS') {
      const card = this.agents.get(selected.id);
      const agentId = card?.agentId ?? selected.routing?.agentId ?? 'wazir-coding';
      const modelId = card?.modelId ?? selected.routing?.modelId ?? 'evaluating...';
      const runtimeId = selected.routing?.runtimeId ?? 'fake';
      const computerId = card?.computerId ?? selected.routing?.computerId ?? 'local';
      routingLine = `  ${color.bold('Routing:')} Agent [${color.cyan(agentId)}] ${color.gray('-')} Model [${color.cyan(modelId)}] ${color.gray('-')} Runtime [${color.cyan(runtimeId)}] ${color.gray('-')} Computer [${color.cyan(computerId)}]`;
    } else if (selected.category === 'JOBS') {
      const job = this.engine.orchestrator.getJob(selected.id) ?? this.currentJob;
      routingLine = `  ${color.bold('Routing:')} Job [${color.cyan(selected.id)}] ${color.gray('-')} Priority [${color.cyan(job?.priority ?? 'normal')}] ${color.gray('-')} Limit [${color.cyan(String(job?.concurrencyLimit ?? this.concurrencyLimit))}]`;
    } else if (selected.category === 'AGENTS') {
      const agent = this.engine.agents.get(selected.id);
      routingLine = `  ${color.bold('Routing:')} Agent [${color.cyan(selected.id)}] ${color.gray('-')} Type [${color.cyan('native')}] ${color.gray('-')} Caps [${color.cyan(agent?.descriptor?.capabilities?.join(',') ?? 'generalChat,coding')}]`;
    } else if (selected.category === 'COMPUTERS') {
      const comp = this.engine.computers.get(selected.id);
      routingLine = `  ${color.bold('Routing:')} Computer [${color.cyan(selected.id)}] ${color.gray('-')} OS [${color.cyan(comp?.os?.platform ?? 'linux')}] ${color.gray('-')} Cores [${color.cyan(String(comp?.hardware?.cpuCores ?? 8))}]`;
    } else if (selected.category === 'RUNTIMES') {
      const runtime = this.engine.runtimes.get(selected.id);
      routingLine = `  ${color.bold('Routing:')} Runtime [${color.cyan(selected.id)}] ${color.gray('-')} Type [${color.cyan(runtime?.type ?? 'other')}] ${color.gray('-')} Computer [${color.cyan(runtime?.computerId ?? 'local')}]`;
    }

    lines.push(this.padRightTo(routingLine, width));
    lines.push(this.padRightTo(color.gray('  ' + '-'.repeat(Math.max(10, width - 4))), width));

    // 2. Details & Scrollable Event Stream (§11)
    if (selected.category === 'EXECUTIONS') {
      const card = this.agents.get(selected.id);
      if (card) {
        const durStr = card.durationMs > 0 ? `${(card.durationMs / 1000).toFixed(1)}s` : '0.0s';
        const statusBadge =
          card.status === 'completed'
            ? color.green('[COMPLETED]')
            : card.status === 'failed'
              ? color.red('[FAILED]')
              : card.status === 'running'
                ? color.cyan(`[RUNNING ${getCategorySpinnerFrame('EXECUTIONS', this.spinnerTick)}]`)
                : color.yellow(`[${card.status.toUpperCase()}]`);

        lines.push(
          this.padRightTo(
            `  Tail: ${color.bold(card.taskId)} (${card.title}) | Phase: ${color.cyan(card.phase)} | Status: ${statusBadge} | Dur: ${durStr}`,
            width,
          ),
        );
        if (card.usage) {
          const tps = tokensPerSecond(card.usage.output, card.durationMs).toFixed(1);
          lines.push(
            this.padRightTo(
              color.gray(
                `  Tokens: In ${card.usage.input} / Out ${card.usage.output} (${card.usage.total} total) | Speed: ${tps} tok/s`,
              ),
              width,
            ),
          );
        }
        lines.push(this.padRightTo(color.gray('  ' + '-'.repeat(Math.max(10, width - 4))), width));

        // Display scroll indicator if scrolled up
        if (this.eventScrollOffset > 0) {
          lines.push(
            this.padRightTo(
              color.yellow(`  [^ SCROLLED +${this.eventScrollOffset} lines - PageDown or Esc to return to tail]`),
              width,
            ),
          );
        }

        const logs = this.agentLogs.get(card.taskId) ?? [];
        // While a model turn is streaming, reserve the bottom few rows for it — this is
        // the live "what is the model thinking right now" view; the log above it is the
        // history of completed turns.
        const streaming = this.streamingBuffers.get(card.taskId) ?? '';
        const showLive = card.status === 'running' && streaming.trim().length > 0;
        const liveRows = showLive ? Math.min(7, Math.max(3, Math.floor((maxRows - lines.length) / 3))) : 0;
        const remainingRows = Math.max(1, maxRows - lines.length - liveRows);

        // Apply eventScrollOffset
        const maxScroll = Math.max(0, logs.length - remainingRows);
        const scrollOffset = Math.min(this.eventScrollOffset, maxScroll);
        const startIdx = Math.max(0, logs.length - remainingRows - scrollOffset);
        const endIdx = logs.length - scrollOffset;
        const visibleLogs = logs.slice(startIdx, endIdx);

        if (visibleLogs.length === 0) {
          lines.push(this.padRightTo(color.gray(`  Waiting for event activity from ${card.taskId}...`), width));
        } else {
          for (const log of visibleLogs) {
            const timePrefix = color.gray(`[${log.time}]`);
            let badge = color.gray('INFO    ');

            // Sanitize log text: strip unprintable control characters and truncate before coloring
            const cleanText = log.text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
            const maxTextLen = Math.max(10, width - 28);
            const truncatedText =
              cleanText.length > maxTextLen ? cleanText.slice(0, maxTextLen - 1) + '.' : cleanText;

            let contentText = truncatedText;

            // Semantic typed states (§11): PLAN, ROUTE, TOOL, TEST, COMPLETE, ERROR
            const k = (log.kind || '').toLowerCase();
            if (k === 'plan') {
              badge = color.cyan('PLAN    ');
              contentText = color.cyan(truncatedText);
            } else if (k === 'route') {
              badge = color.blue('ROUTE   ');
              contentText = color.blue(truncatedText);
            } else if (k === 'tool') {
              badge = color.yellow('TOOL    ');
              contentText = color.yellow(truncatedText);
            } else if (k === 'test') {
              badge = color.cyan('TEST    ');
              contentText = truncatedText;
            } else if (k === 'complete' || k === 'done') {
              badge = color.green('COMPLETE');
              contentText = color.green(truncatedText);
            } else if (k === 'error' || k === 'fail') {
              badge = color.red('ERROR   ');
              contentText = color.red(truncatedText);
            } else if (k === 'model') {
              badge = color.magenta('MODEL   ');
              contentText = color.magenta(truncatedText);
            } else if (k === 'validate') {
              badge = color.bold(color.yellow('VALIDATE'));
              contentText = color.yellow(truncatedText);
            }

            lines.push(this.padRightTo(`  ${timePrefix} ${badge} ${contentText}`, width));
          }
        }

        if (showLive) {
          const spinner = getCategorySpinnerFrame('EXECUTIONS', this.spinnerTick);
          lines.push(
            this.padRightTo(
              color.magenta(`  ${spinner} MODEL is generating (${streaming.length} chars so far)`),
              width,
            ),
          );
          // Show the most recent text, not the beginning: wrap the tail of the buffer and
          // keep the last rows so it reads like a terminal scrolling as the model types.
          const innerWidth = Math.max(10, width - 6);
          const bodyRows = liveRows - 1;
          const tail = streaming.slice(-(innerWidth * bodyRows * 2)).replace(/\s+/g, ' ');
          const wrapped = this.wrapText(tail, innerWidth, 10_000).slice(-bodyRows);
          for (const wline of wrapped) {
            lines.push(this.padRightTo(color.magenta(`    ${wline}`), width));
          }
        }
      } else {
        lines.push(this.padRightTo(color.gray('  Execution details not available.'), width));
      }
    } else if (selected.category === 'JOBS') {
      const job = this.engine.orchestrator.getJob(selected.id) ?? this.currentJob;
      if (job) {
        lines.push(this.padRightTo(`  Title: ${color.bold(job.title)} | Status: ${job.status}`, width));
        lines.push(this.padRightTo(`  Tasks (${job.tasks.length}):`, width));
        // The agent's actual output lives on the graph node (set via completeTask/failTask),
        // not on the Task itself — this view previously only showed status/title and never
        // surfaced what the job actually produced, even though the data was already there.
        for (const t of job.tasks) {
          if (lines.length >= maxRows - 1) break;
          lines.push(this.padRightTo(`    [${t.status}] ${t.id} - ${t.title || t.input.slice(0, 30)}`, width));
          if (lines.length >= maxRows - 1) break;
          const node = job.graph.nodes.find((n) => n.taskId === t.id || n.id === t.id);
          const rawOutput = node?.error ?? (node?.result !== undefined
            ? typeof node.result === 'string' ? node.result : JSON.stringify(node.result)
            : undefined);
          if (rawOutput) {
            const flat = rawOutput.replace(/\s+/g, ' ').trim();
            const remainingRows = Math.max(1, maxRows - lines.length - 1);
            const wrapped = this.wrapText(flat, Math.max(10, width - 10), Math.min(6, remainingRows));
            const paint = node?.error ? color.red : color.gray;
            wrapped.forEach((wline, i) => {
              if (lines.length >= maxRows - 1) return;
              const prefix = i === 0 ? '      -> ' : '         ';
              lines.push(this.padRightTo(paint(`${prefix}${wline}`), width));
            });
          }
        }
        const rollup = this.jobRollups.get(job.id);
        if (rollup) {
          const tps = rollup.tokensPerSecond > 0 ? rollup.tokensPerSecond.toFixed(1) : '0.0';
          lines.push(
            this.padRightTo(
              color.gray(
                `  Rollup: Tokens: In ${rollup.tokens.input} / Out ${rollup.tokens.output} (${rollup.tokens.total} total) | Duration: ${(rollup.durationMs / 1000).toFixed(1)}s | Speed: ${tps} tok/s`,
              ),
              width,
            ),
          );
          if (rollup.filesChanged.length > 0 && lines.length < maxRows) {
            lines.push(
              this.padRightTo(color.gray(`  Files changed: ${rollup.filesChanged.join(', ')}`), width),
            );
          }
        } else {
          void this.refreshJobRollup(job.id);
        }
      }
    } else if (selected.category === 'AGENTS') {
      const agent = this.engine.agents.get(selected.id);
      lines.push(this.padRightTo(`  Agent: ${color.bold(selected.id)}`, width));
      if (agent?.descriptor?.description) {
        lines.push(this.padRightTo(`  Description: ${agent.descriptor.description}`, width));
      }
      if (agent?.descriptor?.taskTypes) {
        lines.push(this.padRightTo(`  Task Types: ${agent.descriptor.taskTypes.join(', ')}`, width));
      }
    } else if (selected.category === 'COMPUTERS') {
      const comp = this.engine.computers.get(selected.id);
      if (comp) {
        lines.push(this.padRightTo(`  Host: ${color.bold(comp.name || comp.id)} (${comp.type})`, width));
        lines.push(this.padRightTo(`  OS: ${comp.os.platform} ${comp.os.architecture} (${comp.os.version})`, width));
        lines.push(
          this.padRightTo(
            `  Hardware: ${comp.hardware.cpu} | ${comp.hardware.cpuCores} cores | ${comp.hardware.memoryGB} GB RAM`,
            width,
          ),
        );
        lines.push(this.padRightTo(`  Capabilities: ${comp.capabilities.join(', ')}`, width));
      }
    } else if (selected.category === 'RUNTIMES') {
      const runtime = this.engine.runtimes.get(selected.id);
      const discovered = this.engine.discovered.find((d) => d.id === selected.id);
      if (runtime) {
        lines.push(this.padRightTo(`  Runtime: ${color.bold(runtime.name || runtime.id)} v${runtime.version}`, width));
        lines.push(this.padRightTo(`  Computer: ${runtime.computerId}`, width));
        if (discovered?.health === 'unavailable') {
          lines.push(this.padRightTo(`  Status: ${color.red('UNAVAILABLE')} — ${discovered.healthMessage ?? 'unreachable'}`, width));
          if (selected.id === 'lmstudio') {
            lines.push(this.padRightTo(`  ${color.gray("Run /launch lmstudio to start LM Studio's server from here.")}`, width));
          }
        } else if (discovered) {
          lines.push(this.padRightTo(`  Status: ${color.green(discovered.health.toUpperCase())}`, width));
        }
        const caps = Object.entries(runtime.capabilities)
          .filter(([, v]) => v)
          .map(([k]) => k);
        lines.push(this.padRightTo(`  Features: ${caps.join(', ')}`, width));
      }
    }

    while (lines.length < maxRows) {
      lines.push(this.padRightTo('', width));
    }

    return lines;
  }

  /**
   * Region 3: History Strip
   * Wired to listBlocks() and getBlock()
   */
  private renderHistoryStrip(cols: number): string {
    if (this.recentBlocks.length === 0) {
      return color.gray(' History: [No recorded blocks yet]');
    }

    const chips: string[] = [];
    for (const b of this.recentBlocks.slice(0, 5)) {
      let glyph = color.yellow('o');
      if (b.status === 'success') glyph = color.green('+');
      else if (b.status === 'running') glyph = color.cyan('*');
      else if (b.status === 'failed') glyph = color.red('x');

      chips.push(`[#${b.id} ${glyph} ${b.command.slice(0, 16)}]`);
    }

    const full = ` History: ${chips.join(' ')}`;
    return this.stripAnsi(full).length > cols ? full.slice(0, cols) : full;
  }

  /**
   * Region 4: Status Bar & Real-Time Context Token Budget Indicator (§20)
   */
  private renderStatusBar(cols: number): string {
    const { used, max } = this.getContextMetrics();
    const usedK = (used / 1024).toFixed(1);
    const maxK = Math.round(max / 1024);

    // Semantic colors (§25): cyan = identity / active context
    // Only shown once a model is pinned via /model — otherwise this bar stays as it
    // was, since "auto-routed" is the common case and not worth a permanent label.
    const modelPlain = this.selectedModelId ? `Model ${this.selectedModelId} ~ ` : '';
    const modelIndicator = this.selectedModelId ? `${color.magenta(modelPlain.trimEnd())} ` : '';
    const contextIndicator = color.cyan(`Context ${usedK}K/${maxK}K ~`);
    const contextPlain = `Context ${usedK}K/${maxK}K ~`;

    const anyRunning =
      Array.from(this.agents.values()).some((a) => a.status === 'running') ||
      this.statusMessage.includes('Planning') ||
      this.statusMessage.includes('Retrying') ||
      this.statusMessage.includes('Executing');
    const spinnerPrefix = anyRunning ? `${color.cyan(getCategorySpinnerFrame('JOBS', this.spinnerTick))} ` : '';

    const statusText = `  ${color.gray('Status:')} ${spinnerPrefix}${this.statusMessage}`;
    const statusPlain = this.stripAnsi(statusText);

    const spaces = Math.max(2, cols - statusPlain.length - modelPlain.length - contextPlain.length - 2);
    return `${statusText}${' '.repeat(spaces)}${modelIndicator}${contextIndicator} `;
  }

  private renderInputBar(cols: number): string {
    const promptPrefix = color.cyan('wa> ');
    const prefixLen = 4; // visible width of 'wa> '
    const available = Math.max(0, cols - prefixLen);

    // Scroll to keep the cursor in view instead of always pinning the window to the
    // buffer's tail - an overlong line here soft-wraps in the real terminal, which
    // desyncs the absolute-cursor redraw and looks like ghosting, and (before the
    // cursor could move at all) made it look like backspace stopped working once typed
    // text got long. Now that Left/Right can walk the cursor back into a long line,
    // pinning to the tail would also hide the cursor's real position off-window.
    const start = this.inputCursor > available ? this.inputCursor - available : 0;
    const visibleInput = this.inputBuffer.slice(start, start + available);
    this.inputCursorScreenCol = prefixLen + (this.inputCursor - start) + 1;

    return `${promptPrefix}${visibleInput}`;
  }

  // ==========================================
  // Modals & Overlays
  // ==========================================
  /**
   * Overlaid Policy Approval Modal Card
   */
  private renderApprovalModal(cols: number): string[] {
    const first = this.pendingApprovals[0];
    const modalWidth = Math.min(cols - 4, 76);
    const count = this.pendingApprovals.length;
    const title = `POLICY APPROVAL QUEUE [1/${count}]`;

    const body: string[] = [
      `Task: ${color.cyan(first.taskId ?? 'fleet-task')}   Tool: ${color.yellow(first.tool)}`,
      `Rule: ${color.cyan(first.rule)}`,
    ];
    for (const reason of first.reasons.slice(0, 2)) {
      body.push(`Why:  ${color.gray(reason)}`);
    }

    if (first.tool === 'edit' || first.tool === 'write') {
      body.push('');
      body.push(...this.renderDiffPreview(first, modalWidth - 4));
    } else {
      const inputStr = JSON.stringify(first.input);
      if (this.approvalShowDetails) {
        body.push(`Args: ${color.gray(inputStr)}`);
        if (first.executionId) body.push(`Exec: ${color.gray(first.executionId)}`);
      } else {
        body.push(`Args: ${color.gray(inputStr.slice(0, modalWidth - 14))}`);
      }
    }

    const actions =
      count > 1
        ? `${color.bold('[A]')} Approve  ${color.bold('[D]')} Deny  ${color.bold('[V]')} Details  ${color.bold('[I]')} Skip  ${color.bold('[^A]')} All  ${color.bold('[^D]')} None`
        : `${color.bold('[A]')} Approve  ${color.bold('[D]')} Deny  ${color.bold('[V]')} Details  ${color.bold('[I]')} Inspect`;
    return this.buildModalBox(title, body, actions, modalWidth, 'yellow');
  }

  /**
   * Renders what a pending `edit`/`write` approval will actually do to the
   * file, instead of the raw `{"path":...,"content":"..."}` JSON blob that
   * used to be the only thing shown here — approving an edit meant approving
   * a wall of escaped text you couldn't realistically read.
   *
   * `edit` gets a real line diff: `oldString`/`newString` are already both
   * known from the tool call itself, no file read needed. `write` cannot be
   * diffed safely from here — this TUI has no reliable way to resolve which
   * on-disk file a task's `path` refers to (worktrees put different tasks in
   * different directories), and reading the wrong file would be actively
   * misleading for an approve/deny decision — so it's shown as a clearly
   * labeled content preview instead of a diff.
   */
  private renderDiffPreview(req: PendingApprovalRequest, innerWidth: number): string[] {
    const path = typeof req.input.path === 'string' ? req.input.path : '(unknown path)';
    const maxLines = this.approvalShowDetails ? 40 : 8;
    const lines: string[] = [`File: ${color.cyan(path)}`];

    if (req.tool === 'edit') {
      const oldStr = typeof req.input.oldString === 'string' ? req.input.oldString : '';
      const newStr = typeof req.input.newString === 'string' ? req.input.newString : '';
      const diff = diffLines(oldStr, newStr);
      const shown = diff.slice(0, maxLines);
      for (const d of shown) {
        const text = this.truncateAnsi(d.text, Math.max(1, innerWidth - 2));
        if (d.type === 'add') lines.push(color.green(`+ ${text}`));
        else if (d.type === 'del') lines.push(color.red(`- ${text}`));
        else lines.push(color.gray(`  ${text}`));
      }
      if (diff.length > shown.length) {
        lines.push(color.gray(`  ... ${diff.length - shown.length} more line(s) — press [V] for details`));
      }
    } else {
      const content = typeof req.input.content === 'string' ? req.input.content : '';
      const contentLines = content.split('\n');
      const shown = contentLines.slice(0, maxLines);
      lines.push(color.gray(`New content (${contentLines.length} line(s)):`));
      for (const l of shown) lines.push(color.green(`+ ${this.truncateAnsi(l, Math.max(1, innerWidth - 2))}`));
      if (contentLines.length > shown.length) {
        lines.push(color.gray(`  ... ${contentLines.length - shown.length} more line(s) — press [V] for details`));
      }
    }
    return lines;
  }

  /**
   * Overlaid Structured Error Card Modal (§29)
   * Explicitly renders fields for phase, reason, required, available, and suggested resolution steps.
   */
  private renderStructuredErrorCard(err: StructuredError, cols: number): string[] {
    const modalWidth = Math.min(cols - 4, 76);
    const title = ' EXECUTION FAILURE ';

    const body: string[] = [
      `${color.bold('Phase:')}      ${color.red(err.phase)}`,
      `${color.bold('Reason:')}     ${color.red(err.reason)}`,
    ];
    if (err.required) {
      body.push(`${color.bold('Required:')}   ${color.gray(err.required)}`);
    }
    if (err.available) {
      body.push(`${color.bold('Available:')}  ${color.gray(err.available)}`);
    }
    if (err.suggestedSteps && err.suggestedSteps.length > 0) {
      body.push('');
      body.push(color.bold('Suggested Resolution Steps:'));
      for (const step of err.suggestedSteps) {
        body.push(`  ${color.cyan(step)}`);
      }
    }

    const actions = `${color.bold('[Esc]')} Dismiss   ${color.bold('[R]')} Retry Task   ${color.bold('[D]')} Run wa doctor`;
    return this.buildModalBox(title, body, actions, modalWidth, 'red');
  }

  /**
   * Overlaid Quick Actions Palette Modal (Ctrl+P) (§3)
   */
  private renderQuickActionsModal(cols: number): string[] {
    const modalWidth = Math.min(cols - 4, 72);
    const title = ' QUICK ACTIONS (Ctrl+P) ';

    const body: string[] = [];
    for (let i = 0; i < this.quickActions.length; i++) {
      const a = this.quickActions[i];
      const isSel = i === this.quickActionIndex;
      const cursor = isSel ? color.blue('> ') : '  ';
      const label = `${cursor}${i + 1}. ${a.title} ${color.gray(`(${a.cmd})`)}`;
      body.push(isSel ? color.blue(color.bold(label)) : label);
    }

    const actions = `${color.bold('[Enter]')} Select   ${color.bold('[Esc]')} Dismiss   ${color.bold('[1-9]')} Direct Execute`;
    return this.buildModalBox(title, body, actions, modalWidth, 'cyan');
  }

  /**
   * Overlaid Block Details Modal Card
   */
  private renderBlockModal(block: Block, cols: number): string[] {
    const modalWidth = Math.min(cols - 4, 76);
    const title = `BLOCK DETAILS #${block.id} [${block.status.toUpperCase()}]`;

    const body: string[] = [
      `Command:  ${color.bold(block.command)}`,
      `Duration: ${block.durationMs ?? 0}ms   Exit: ${block.exitCode ?? 0}`,
    ];

    if (block.stdout) {
      body.push(`Stdout:   ${color.gray(block.stdout.slice(0, 100))}`);
    }
    if (block.stderr) {
      body.push(`Stderr:   ${color.red(block.stderr.slice(0, 100))}`);
    }
    if (block.filesChanged && block.filesChanged.length > 0) {
      body.push(`Files:    ${color.cyan(block.filesChanged.join(', '))}`);
    }

    const actions = `${color.bold('[Esc]')} Close`;
    return this.buildModalBox(title, body, actions, modalWidth, 'yellow');
  }

  /**
   * The exact raw text the model produced for its most recent turn on the tailed task,
   * before any parsing — 'r' on the Tail view. Previously the only way to see this was
   * reconstructing it by hand from `wa executions inspect --json`'s recorded events; this
   * is exactly the trace that diagnosed today's argument-wrapping and brace-parsing bugs.
   */
  private renderRawResponseModal(taskId: string, cols: number): string[] {
    const modalWidth = Math.min(cols - 4, 100);
    const innerWidth = modalWidth - 4;
    const raw = this.lastRawResponse.get(taskId) ?? '(none recorded)';
    const title = `RAW MODEL RESPONSE — ${taskId}`;
    const body = this.wrapText(raw, innerWidth, 30);
    const actions = `${color.bold('[Esc]')} Close`;
    return this.buildModalBox(title, body, actions, modalWidth, 'cyan');
  }

  /**
   * Full, untruncated job output modal (Enter on a JOBS nav item). The compact JOBS
   * detail view only shows a 6-line wrapped preview per task so the fleet dashboard
   * doesn't get crowded out by one long result — this shows everything.
   */
  private renderJobOutputModal(job: Job, rollup: JobRollup | undefined, cols: number): string[] {
    const modalWidth = Math.min(cols - 4, 100);
    const innerWidth = modalWidth - 4;
    const title = `JOB OUTPUT: ${job.title.slice(0, 50)} [${job.status.toUpperCase()}]`;

    const body: string[] = [];
    for (const t of job.tasks) {
      body.push(`${color.bold(`[${t.status}]`)} ${t.id}${t.title ? ` - ${t.title}` : ''}`);
      const node = job.graph.nodes.find((n) => n.taskId === t.id || n.id === t.id);
      const raw = node?.error ?? (node?.result !== undefined
        ? typeof node.result === 'string' ? node.result : JSON.stringify(node.result)
        : undefined);
      if (raw) {
        const flat = raw.replace(/\s+/g, ' ').trim();
        const wrapped = this.wrapText(flat, innerWidth, 20);
        const paint = node?.error ? color.red : color.gray;
        for (const line of wrapped) body.push(paint(line));
      } else {
        body.push(color.gray('(no output captured for this task)'));
      }
      body.push('');
    }

    if (rollup) {
      const tps = rollup.tokensPerSecond > 0 ? rollup.tokensPerSecond.toFixed(1) : '0.0';
      body.push(
        color.gray(
          `Tokens: In ${rollup.tokens.input} / Out ${rollup.tokens.output} (${rollup.tokens.total} total) | Duration: ${(rollup.durationMs / 1000).toFixed(1)}s | Speed: ${tps} tok/s`,
        ),
      );
      if (rollup.filesChanged.length > 0) {
        body.push(color.gray(`Files changed: ${rollup.filesChanged.join(', ')}`));
      }
    } else {
      void this.refreshJobRollup(job.id);
    }

    const actions = `${color.bold('[Esc]')} Close`;
    return this.buildModalBox(title, body, actions, modalWidth, job.status === 'failed' ? 'red' : 'cyan');
  }

  private buildModalBox(
    title: string,
    bodyLines: string[],
    actionsLine: string,
    width: number,
    colorScheme: 'yellow' | 'red' | 'cyan' | 'blue' = 'yellow',
  ): string[] {
    const innerWidth = width - 4;
    const result: string[] = [];

    const borderPaint =
      colorScheme === 'red'
        ? color.red
        : colorScheme === 'cyan'
          ? color.cyan
          : colorScheme === 'blue'
            ? color.blue
            : color.yellow;

    // Top border
    const titleStr = ` ${title} `;
    const topDashes = Math.max(0, innerWidth - titleStr.length);
    result.push(color.bold(borderPaint(`+--${titleStr}${'-'.repeat(topDashes)}+`)));

    // Body lines (clamped to innerWidth so a long value can never push the right border
    // past the box, which would otherwise re-introduce the same wrap/misalignment class
    // of bug fixed elsewhere in draw())
    for (const rawLine of bodyLines) {
      const clamped = this.stripAnsi(rawLine).length > innerWidth ? this.truncateAnsi(rawLine, innerWidth) : rawLine;
      const plain = this.stripAnsi(clamped);
      const pad = Math.max(0, innerWidth - plain.length);
      result.push(`${color.bold(borderPaint('|'))}  ${clamped}${' '.repeat(pad)}${color.bold(borderPaint('|'))}`);
    }

    // Separator
    result.push(color.bold(borderPaint(`+--${'-'.repeat(innerWidth)}--+`)));

    // Actions line
    const clampedActions =
      this.stripAnsi(actionsLine).length > innerWidth ? this.truncateAnsi(actionsLine, innerWidth) : actionsLine;
    const actionPlain = this.stripAnsi(clampedActions);
    const actPad = Math.max(0, innerWidth - actionPlain.length);
    result.push(`${color.bold(borderPaint('|'))}  ${clampedActions}${' '.repeat(actPad)}${color.bold(borderPaint('|'))}`);

    // Bottom border
    result.push(color.bold(borderPaint(`+--${'-'.repeat(innerWidth)}--+`)));

    return result;
  }

  private buildPickerPopup(candidates: string[], selectedIdx: number, width: number): string[] {
    const innerWidth = width - 4;
    const result: string[] = [];
    const title = ' References (@) ';
    const topDashes = Math.max(0, innerWidth - title.length);
    result.push(color.cyan(`+--${title}${'-'.repeat(topDashes)}+`));

    const visibleCandidates = candidates.slice(0, 6);
    for (let i = 0; i < visibleCandidates.length; i++) {
      const c = visibleCandidates[i];
      const isSel = i === selectedIdx;
      const prefix = isSel ? color.blue('> ') : '  ';
      const maxTextLen = innerWidth - 4;
      const truncated = c.length > maxTextLen ? c.slice(0, maxTextLen - 1) + '.' : c;
      const plain = `${prefix}${truncated}`;
      const plainLen = this.stripAnsi(plain).length;
      const pad = Math.max(0, innerWidth - plainLen);
      result.push(`${color.cyan('|')}  ${prefix}${isSel ? color.blue(color.bold(truncated)) : truncated}${' '.repeat(pad - 2)}${color.cyan('|')}`);
    }

    result.push(color.cyan(`+--${'-'.repeat(innerWidth)}--+`));
    return result;
  }

  private overlayModal(lines: string[], modalLines: string[], cols: number, startY: number): void {
    const modalWidth = Math.max(...modalLines.map((l) => this.stripAnsi(l).length));
    const leftPad = Math.max(0, Math.floor((cols - modalWidth) / 2));

    for (let i = 0; i < modalLines.length; i++) {
      const y = startY + i;
      if (y < 0 || y >= lines.length) continue;
      const m = modalLines[i];
      const mLen = this.stripAnsi(m).length;
      const rightPad = Math.max(0, cols - leftPad - mLen);
      lines[y] = ' '.repeat(leftPad) + m + ' '.repeat(rightPad);
    }
  }

  private renderWorktreesPane(cols: number, maxRows: number): string[] {
    const lines: string[] = [];
    lines.push(color.bold(color.cyan('  GIT WORKTREE ISOLATION & MERGE-BACK')));
    lines.push(color.gray('  Each agent runs in an isolated git branch without colliding writes:'));
    lines.push('');

    const list = this.getAgents();
    if (list.length === 0) {
      lines.push(color.gray('  No active worktrees.'));
    } else {
      for (const a of list) {
        const branch = this.currentJob ? `wazir/${this.currentJob.id}/${a.taskId}` : `wazir/${a.taskId}`;
        lines.push(`  ${color.cyan(a.taskId.padEnd(12))} Branch: ${color.bold(branch)}  Status: ${a.status}`);
        if (a.filesChanged.length > 0) {
          lines.push(`    Files: ${color.gray(a.filesChanged.join(', '))}`);
        }
      }
    }

    lines.push('');
    lines.push(color.gray('  Merge-back story: Changes are verified on isolated branches before merge into target.'));
    while (lines.length < maxRows) lines.push('');
    return lines;
  }

  /**
   * Independent View Layout Template: APPROVAL (§2)
   * Dedicated layout so approval view never collides with table columns from other views.
   */
  private renderApprovalPane(cols: number, maxRows: number): string[] {
    const lines: string[] = [];
    lines.push(color.bold(color.yellow('  POLICY APPROVAL QUEUE')));
    lines.push(color.gray('  Review and act on pending tool approval requests:'));
    lines.push('');

    if (this.pendingApprovals.length === 0) {
      lines.push(color.green('  + No pending approval requests.'));
      lines.push('');
      lines.push(color.gray('  All tool invocations are passing current policy rules.'));
    } else {
      for (let i = 0; i < this.pendingApprovals.length && lines.length < maxRows - 2; i++) {
        const req = this.pendingApprovals[i];
        const idx = `[${i + 1}/${this.pendingApprovals.length}]`;
        lines.push(`  ${color.yellow(idx)} Tool: ${color.bold(req.tool)} | Rule: ${color.cyan(req.rule)}`);
        if (req.taskId) {
          lines.push(`    Task: ${color.gray(req.taskId)}`);
        }
        for (const reason of req.reasons.slice(0, 2)) {
          lines.push(`    ${color.gray(reason)}`);
        }
        lines.push('');
      }
    }

    lines.push(color.gray('  Actions: [A] Approve  [D] Deny  [Y] Yes  [N] No  [V] Details'));
    while (lines.length < maxRows) lines.push('');
    return lines;
  }

  private renderHelpPane(cols: number, maxRows: number): string[] {
    const lines: string[] = [
      color.bold('  WAZIR FLEET TUI SHORTCUTS & COMMANDS'),
      '',
      '  Navigation:',
      '    Tab          Cycle through views (Shift-Tab for reverse traversal)',
      '    Up / Down       Navigate categories and items across entire left index',
      '    Enter           Drill down into highlighted agent stream (Tail view)',
      '    c               Cancel the selected running job (JOBS list)',
      '    Delete / x      Delete the selected job (JOBS list; not while it is running)',
      '    Esc             Dismiss modal dialogs / return to fleet dashboard',
      '    ?               Toggle this help screen (when prompt empty)',
      '    Ctrl+R          Force state refresh across blocks and agents',
      '    Ctrl+L          Force immediate screen repaint',
      '    Ctrl+P          Open Quick Actions palette',
      '',
      '  Event-Stream Activity Pane:',
      '    PageUp / PgDn   Scroll chronological activity logs',
      '    Up / Down       Scroll activity lines when main pane focused',
      '',
      '  Telemetry & Approvals:',
      '    Context ~       Real-time token budget display in status bar',
      '    [A] / [D]       Approve / Deny pending policy ask (overlaid modal card)',
      '    [V] / [I]       View full details / Inspect & snooze policy ask',
      '    [R]             Retry failed task when error card is open',
      '    [R] (Tail view) View the selected task\'s raw model response',
      '',
      '  Commands & Quick Actions:',
      '    /fanout <t1;t2> Decompose and run concurrent subtasks',
      '    /steer <msg>    Inject mid-run follow-up instruction to agent',
      '    /cancel <id>    Cancel one agent or all agents',
      '    /doctor         Execute system diagnostics',
      '    /launch lmstudio  Start LM Studio\'s server when its runtime shows unavailable',
      '    /model [id]     Show or set the model new tasks are pinned to',
      '    /clear-context  Clear active context blocks',
      '    /exit or q      Exit TUI and restore terminal',
    ];
    while (lines.length < maxRows) lines.push('');
    return lines;
  }

  private stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  }

  /**
   * Greedily wraps plain text (no ANSI — callers colorize each returned line themselves)
   * to maxWidth, splitting on whitespace, up to maxLines. Used for task output previews
   * that were previously cut to a single truncated line — a several-sentence result was
   * unreadable as "...The projec" with no way to see the rest.
   */
  private wrapText(text: string, maxWidth: number, maxLines: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = '';
    let wordIndex = 0;
    while (wordIndex < words.length && lines.length < maxLines) {
      const word = words[wordIndex];
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxWidth && current) {
        lines.push(current);
        current = '';
      } else {
        current = candidate;
        wordIndex++;
      }
    }
    if (wordIndex >= words.length) {
      if (current) lines.push(current);
    } else if (lines.length > 0) {
      // Ran out of lines with words still left over — mark the truncation.
      const last = lines[lines.length - 1];
      lines[lines.length - 1] = last.length >= maxWidth ? `${last.slice(0, maxWidth - 1)}.` : `${last}.`;
    }
    return lines;
  }

  private truncateAnsi(str: string, maxLen: number): string {
    const plain = this.stripAnsi(str);
    if (plain.length <= maxLen) return str;

    let visibleCount = 0;
    let result = '';
    let inEscape = false;

    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (char === '\x1b') {
        inEscape = true;
        result += char;
      } else if (inEscape) {
        result += char;
        if (/[a-zA-Z~]/.test(char)) {
          inEscape = false;
        }
      } else {
        if (visibleCount < maxLen - 1) {
          result += char;
          visibleCount++;
        } else {
          result += '.\x1b[0m';
          break;
        }
      }
    }
    return result.endsWith('\x1b[0m') ? result : result + '\x1b[0m';
  }

  private padRightTo(str: string, targetWidth: number): string {
    const visible = this.stripAnsi(str).length;
    if (visible > targetWidth) {
      return this.truncateAnsi(str, targetWidth);
    }
    return str + ' '.repeat(Math.max(0, targetWidth - visible));
  }
}
