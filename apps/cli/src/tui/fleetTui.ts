import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withScopedRejectionHandler } from '../crashHandler.js';
import {
  type Job,
  type JobOrchestratorEvent,
  type JobRollup,
  type PendingApprovalRequest,
  type Block,
  type BlockStatus,
  type JobTaskInput,
  type Task,
  type ModelRecord,
  type ModelReadiness,
  type ResourceAssessment,
  type ModelLifecycleEvent,
  type InteractiveSubmission,
  type SubmissionSource,
  type PromptBreakdown,
  ModelLifecycleService,
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
import {
  renderImprovementView,
  renderSearchView,
  renderContextView,
  renderFleetView,
  renderModelIntelligenceView,
  renderEvidenceModal,
  type ImprovementExperimentItem,
  type ImprovementViewData,
  type SearchCandidateItem,
  type SearchViewData,
  type ContextSampleItem,
  type ContextViewData,
  type FleetWorkerItem,
  type FleetViewData,
  type ModelProfileItem,
  type ModelIntelligenceViewData,
  type EvidenceModalData,
} from './observabilityViews.js';

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

export type TuiView = 'fleet' | 'tail' | 'approval' | 'worktrees' | 'search' | 'help' | 'improvement' | 'context' | 'models';

export type NavCategory = 'MCP' | 'JOBS' | 'EXECUTIONS' | 'AGENTS' | 'COMPUTERS' | 'RUNTIMES';

export type SidebarMode = 'full' | 'focused' | 'hidden';

export type FocusPane = 'nav' | 'main' | 'prompt';

export type TuiMode = 'NORMAL' | 'COMPOSER' | 'COPY' | 'PASTE' | 'PALETTE' | 'APPROVAL';

export interface StructuredError {
  phase: string;
  reason: string;
  required?: string;
  available?: string;
  suggestedSteps: string[];
  taskId?: string;
  timestamp: Date;
}

export interface StartupSelectorState {
  mode: 'select' | 'loading' | 'failure' | 'recovery_no_models' | 'recovery_runtime';
  allInstalledModels: ModelRecord[];
  eligibleModels: ModelRecord[];
  recommendedModelIds: Set<string>;
  selectedModelIds: Set<string>;
  selectedIndex: number;
  resourceAssessments: Map<string, ResourceAssessment>;
  loadStatuses: Map<string, 'PENDING' | 'LOADING' | 'READY' | 'FAILED'>;
  loadErrors: Map<string, string>;
  inspectedModelId?: string;
  statusBanner?: string;
}

export interface TaskTimeModelRequiredState {
  pendingPrompt: string;
  requiredCapabilities: string[];
  eligibleModels: ModelRecord[];
  selectedIndex: number;
  loading: boolean;
  statusText?: string;
}

export interface NavItem {
  category: NavCategory;
  id: string;
  label: string;
  status: 'running' | 'completed' | 'idle' | 'failed' | 'auth_required';
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
  stage?: string;
  attempt?: number;
  maxAttempts?: number;
  lastMessage: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'retry';
  errorKind?: 'model' | 'tool' | 'environment' | 'policy' | 'infrastructure' | string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs: number;
  filesChanged: string[];
  usage?: { input: number; output: number; total: number };
  /** Prompt size of the most recent model turn — the real context-window occupancy. */
  lastTurnInputTokens?: number;
  modelCallCount?: number;
  promptBreakdown?: PromptBreakdown;
}

export interface AgentLogEntry {
  text: string;
  time: string;
  kind: 'plan' | 'route' | 'tool' | 'test' | 'complete' | 'error' | 'info' | 'model' | 'validate' | 'recover' | 'policy' | 'infra';
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
  enablePlanner?: boolean;
}

/**
 * Detects if a text string looks like terminal output, box borders, or dashboard fragments.
 * Used to reject accidental mouse selections, copies, or terminal echoes from launching bogus jobs.
 */
export function isScreenFragment(text: string): boolean {
  // Strip ANSI escape sequences
  const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
  if (!clean) return true;

  // 1. Box-drawing characters, borders, separators, punctuation-only strings
  if (/^[|\-—+=\s·•─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬><#*~`\.\\/]+$/.test(clean)) {
    return true;
  }

  // 2. Exact or normalized UI section / table headers
  const exactHeaders = new Set([
    'JOBS',
    'EXECUTIONS',
    'AGENTS',
    'COMPUTERS',
    'RUNTIMES',
    'MCP',
    'MODELS',
    'WORKERS',
    'POLICY APPROVAL QUEUE',
    'QUICK ACTIONS',
    'KEYBOARD SHORTCUTS & NAVIGATION',
    'HISTORY',
    'STATUS',
    'ROUTING',
  ]);
  if (exactHeaders.has(clean.toUpperCase())) {
    return true;
  }

  // 3. UI prefix markers and line patterns
  const prefixPatterns = [
    /^wa>\s*/,
    /^Status:\s*/i,
    /^History:\s*/i,
    /^Tail:\s*/i,
    /^WAZIR\s*-\s*CONTROL/i,
    /^Routing:\s*/i,
    /^Route assigned/i,
    /^Context\s+\d+(\.\d+)?K\/\d+K/i,
    /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◴◷◶◵·•●✓✕✗]\s+/,
    /^\[#\d+\s+[\+\*x\-]?[^\]]*\]/,
    /^>+\s*[◷◴◵◶·•●]\s+task-job/i,
    /^task-job-[a-z0-9]+/i,
    /^\.\.[a-z0-9]{5,}-\d+/i, // e.g. ..dkllp-15
    /^\[View:\s+[A-Z]+\]/i,
    /^Press\s+Ctrl\+[A-Z]\s+to/i,
    /^\[A\]\s+Approve\s+\[D\]\s+Deny/i,
  ];
  for (const pattern of prefixPatterns) {
    if (pattern.test(clean)) {
      return true;
    }
  }

  // 4. Border-wrapped lines like "| ... |" or "+---...---+"
  if (/^([|│║]).*\1$/.test(clean) && clean.length > 2) {
    const inner = clean.slice(1, -1).trim();
    if (
      /^[|\-—+=\s·•─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]+$/.test(inner) ||
      prefixPatterns.some((p) => p.test(inner)) ||
      exactHeaders.has(inner.toUpperCase())
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether a key event represents Ctrl+Enter across common terminal emulators.
 */
function isCtrlEnter(keyStr: string, keyObj: readline.Key): boolean {
  if (keyObj.ctrl && (keyObj.name === 'return' || keyObj.name === 'enter' || keyStr === '\r' || keyStr === '\n')) {
    return true;
  }
  if (keyStr === '\x1b\r' || keyStr === '\x1b\n') return true;
  if (keyStr === '\x1b[13;5~' || keyStr === '\x1b[27;5;13~') return true;
  return false;
}

/**
 * True only for a chunk with a genuine internal line break — multiple real
 * lines, not just a single command chunk terminated by one trailing \r/\n.
 *
 * Node's readline keypress decoder doesn't always deliver input one
 * character at a time: under some conditions (observed live, following a
 * burst of bracketed-paste keypresses) it can hand back a short, unbracketed
 * multi-character chunk like "/exit\r" as a single event. Treating any
 * trailing \r/\n as "this must be a paste" swallows that legitimate command
 * into PASTE review mode instead of executing it. Stripping exactly one
 * trailing terminator before checking distinguishes "one line, submitted in
 * one chunk" from "actually multiple lines" (a real paste).
 */
function hasInternalLineBreak(text: string): boolean {
  const withoutTrailingTerminator = text.replace(/(\r\n|\r|\n)$/, '');
  return withoutTrailingTerminator.includes('\n') || withoutTrailingTerminator.includes('\r');
}

/**
 * Resolves structured key objects from raw strings or readline key events.
 */
function resolveKeyObject(keyStr: string, keyObj?: readline.Key): readline.Key {
  if (keyObj && keyObj.name) return keyObj;
  if (typeof keyStr !== 'string') {
    return { name: undefined as any, ctrl: false, meta: false, shift: false, sequence: '' };
  }

  if (keyStr === '\x1b[200~' || (keyObj as any)?.name === 'paste-start') {
    return { name: 'paste-start' as any, ctrl: false, meta: false, shift: false, sequence: '\x1b[200~' };
  }
  if (keyStr === '\x1b[201~' || (keyObj as any)?.name === 'paste-end') {
    return { name: 'paste-end' as any, ctrl: false, meta: false, shift: false, sequence: '\x1b[201~' };
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
  if (keyStr === '\x1b\r' || keyStr === '\x1b\n') {
    return { name: 'return', ctrl: true, meta: false, shift: false, sequence: keyStr };
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
  private readonly enablePlanner: boolean;

  private currentView: TuiView = 'fleet';
  private focusedPane: FocusPane = 'nav';
  private highlightedIndex = 0;
  private selectedTaskId?: string;

  // Nav index state
  private navSelectionIndex = 0;
  private selectedCategory: NavCategory = 'EXECUTIONS';
  private selectedNavId?: string;

  // Sidebar mode (§ focused execution mode / manual hide-restore). 'full' shows every
  // section; 'focused' shows only JOBS/EXECUTIONS (+ the active agent, + any section
  // with a failure needing attention); 'hidden' removes the left pane entirely. Recomputed
  // automatically from execution state each draw() UNLESS the user has manually chosen a
  // mode (sidebarManuallyOverridden) — incoming MODEL/TOOL/PLAN/etc events must never
  // silently reopen or collapse a pane the user explicitly set.
  private sidebarMode: SidebarMode = 'full';
  private sidebarManuallyOverridden = false;

  // Event stream scroll offset
  private eventScrollOffset = 0;

  // Structured Error Card state
  private currentError?: StructuredError;
  /**
   * Task IDs whose failure error-card the user has explicitly dismissed (Esc).
   * Used to prevent the card from re-opening each time a retried task fires
   * another task:failed event for the same task ID. Cleared when a new job starts.
   */
  private readonly dismissedErrorTaskIds = new Set<string>();

  // Observability & Intelligence Views State
  private selectedExperimentIndex = 0;
  private selectedSearchCandidateIndex = 0;
  private selectedContextSampleIndex = 0;
  private selectedWorkerIndex = 0;
  private selectedModelProfileIndex = 0;

  // Ring buffers for bounded telemetry
  private contextSamples: ContextSampleItem[] = [];
  private static readonly MAX_CONTEXT_SAMPLES = 100;
  private static readonly MAX_EVENT_HISTORY = 100;

  // Evidence Modal state
  private evidenceModalOpen = false;
  private evidenceModalData?: EvidenceModalData;
  private evidenceScrollOffset = 0;

  // Subscriptions
  private unsubscribeSolutionSearch?: () => void;
  private unsubscribeOptimizer?: () => void;

  // Model Readiness & Startup Selector state
  private startupSelector?: StartupSelectorState;
  private taskTimeModelRequired?: TaskTimeModelRequiredState;
  private unsubscribeModelLifecycle?: () => void;

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

  private tuiMode: TuiMode = 'NORMAL';
  private isPasting = false;
  private pasteBuffer = '';
  private pastedContent = '';

  // Accidental-Paste & Burst Submission Circuit Breaker
  private submissionTimestamps: number[] = [];
  private burstCooldownUntil = 0;

  // Authoritative Interactive Submission Deduplication & Session Tracking
  private readonly processedSubmissionIds = new Set<string>();
  private readonly sessionId: string;

  private unsubscribeApprovals?: () => void;
  private unsubscribeJobEvents?: () => void;
  private unsubscribeResize?: () => void;
  private restoreFatalRejectionHandler?: () => void;

  constructor(options: FleetTuiOptions) {
    this.engine = options.engine;
    this.sessionId = process.env.WAZIR_SESSION_ID || `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (!this.engine.lifecycle && this.engine.models) {
      this.engine.lifecycle = new ModelLifecycleService({
        models: this.engine.models,
        runtimes: this.engine.runtimes,
        computers: this.engine.computers,
        agents: this.engine.agents,
        adapters: this.engine.adapters ?? new Map(),
        store: this.engine.store,
      });
    }
    this.screen = options.screen ?? new TerminalScreen();
    this.concurrencyLimit = options.concurrencyLimit ?? 4;
    this.useWorktrees = options.useWorktrees ?? true;
    this.autoMerge = options.autoMerge ?? false;
    this.timeoutSeconds = options.timeoutSeconds;
    this.enablePlanner = options.enablePlanner ?? false;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getProcessedSubmissionIds(): Set<string> {
    return this.processedSubmissionIds;
  }

  async submitInteractive(submission: InteractiveSubmission): Promise<void> {
    return this.submitCommand(submission);
  }

  getCurrentView(): TuiView {
    if (this.pendingApprovals.length > 0) return 'approval';
    return this.currentView;
  }

  /**
   * Current sidebar mode ('full' | 'focused' | 'hidden'). Reflects the most recent
   * draw() — auto-recomputed from execution state each draw unless the user manually
   * overrode it (Ctrl+T hide/restore, Ctrl+G full/focused toggle).
   */
  getSidebarMode(): SidebarMode {
    return this.sidebarMode;
  }

  getMode(): TuiMode {
    if (this.pendingApprovals.length > 0) return 'APPROVAL';
    if (this.quickActionsOpen) return 'PALETTE';
    return this.tuiMode;
  }

  setMode(mode: TuiMode): void {
    this.tuiMode = mode;
    this.draw();
  }

  getPastedContent(): string {
    return this.pastedContent;
  }

  private handlePastedText(text: string): void {
    const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    if (!clean) return;

    const hasNewlines = clean.includes('\n') || clean.includes('\r');
    const isLarge = clean.length >= 200;

    if (hasNewlines || isLarge) {
      this.tuiMode = 'PASTE';
      this.pastedContent = clean;
      const lines = clean.split(/\r?\n/);
      this.statusMessage = `Pasted ${clean.length.toLocaleString()} characters / ${lines.length} lines. Press Ctrl+Enter to submit, Esc to discard, E to edit.`;
      this.draw();
    } else {
      const sanitized = clean.replace(/^(wa(\s*\[[A-Z]+\])?>\s*)+/, '');
      this.inputBuffer =
        this.inputBuffer.slice(0, this.inputCursor) + sanitized + this.inputBuffer.slice(this.inputCursor);
      this.inputCursor += sanitized.length;
      this.focusedPane = 'prompt';
      this.statusMessage = 'Pasted text inserted.';
      this.checkReferencePicker();
      this.draw();
    }
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
    //
    // This temporarily replaces the process-wide *fatal* rejection handler
    // (crashHandler.ts's installGlobalCrashHandlers(), installed at CLI
    // startup) rather than adding a second listener alongside it — Node
    // calls every registered `unhandledRejection` listener, so leaving both
    // installed would make the fatal one treat every one of these recovered
    // keypress errors as a crash too. stop() restores the fatal default.
    this.restoreFatalRejectionHandler = withScopedRejectionHandler((reason) => {
      this.statusMessage = `Internal error (recovered): ${reason instanceof Error ? reason.message : String(reason)}`;
      this.draw();
    });

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

    // Subscribe to model lifecycle events
    if (this.engine.lifecycle) {
      this.unsubscribeModelLifecycle = this.engine.lifecycle.subscribe((event) => {
        this.handleModelLifecycleEvent(event);
      });

      // Check startup model readiness according to config mode
      await this.handleStartupModelReadiness();
    }

    // Subscribe to solution search and optimizer event streams
    if (this.engine.solutionSearch && typeof this.engine.solutionSearch.onEvent === 'function') {
      this.unsubscribeSolutionSearch = this.engine.solutionSearch.onEvent((_event) => {
        this.draw();
      });
    }

    if (this.engine.optimizer && typeof this.engine.optimizer.onEvent === 'function') {
      this.unsubscribeOptimizer = this.engine.optimizer.onEvent((_event) => {
        this.draw();
      });
    }

    this.draw();
  }

  /**
   * Bounded context telemetry recorder (caps at MAX_CONTEXT_SAMPLES).
   */
  recordContextSample(sample: ContextSampleItem): void {
    this.contextSamples.push(sample);
    if (this.contextSamples.length > FleetTui.MAX_CONTEXT_SAMPLES) {
      this.contextSamples.shift();
    }
    this.selectedContextSampleIndex = this.contextSamples.length - 1;
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
    if (this.unsubscribeModelLifecycle) this.unsubscribeModelLifecycle();
    if (this.unsubscribeSolutionSearch) this.unsubscribeSolutionSearch();
    if (this.unsubscribeOptimizer) this.unsubscribeOptimizer();
    if (this.restoreFatalRejectionHandler) {
      this.restoreFatalRejectionHandler();
      this.restoreFatalRejectionHandler = undefined;
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

    // 0. Bracketed paste handling
    if (keyName === 'paste-start' || keyStr === '\x1b[200~' || keyStr.startsWith('\x1b[200~')) {
      if (keyStr.includes('\x1b[201~')) {
        // Complete bracketed paste in a single event
        const startIdx = keyStr.indexOf('\x1b[200~');
        const endIdx = keyStr.indexOf('\x1b[201~');
        const content = keyStr.slice(startIdx + 6, endIdx);
        this.isPasting = false;
        this.pasteBuffer = '';
        this.handlePastedText(content);
        return;
      }
      this.isPasting = true;
      this.pasteBuffer = keyStr.startsWith('\x1b[200~') ? keyStr.slice(6) : '';
      return;
    }

    if (this.isPasting) {
      if (keyName === 'paste-end' || keyStr === '\x1b[201~' || keyStr.includes('\x1b[201~')) {
        this.isPasting = false;
        if (keyStr.includes('\x1b[201~')) {
          this.pasteBuffer += keyStr.slice(0, keyStr.indexOf('\x1b[201~'));
        }
        const pasted = this.pasteBuffer;
        this.pasteBuffer = '';
        this.handlePastedText(pasted);
        return;
      }
      this.pasteBuffer += keyStr;
      return;
    }

    // Check if an unbracketed multiline string chunk arrived (e.g. from stream or mock).
    // A single command chunk ending in one \r/\n (e.g. "/exit\r" delivered as one
    // event) is NOT a paste — only route through PASTE review for a chunk that's
    // either genuinely multi-line or long enough to match the bracketed-paste
    // size threshold (see handlePastedText's isLarge check).
    if (!keyStr.startsWith('\x1b') && keyStr.length > 1 && (hasInternalLineBreak(keyStr) || keyStr.length >= 200)) {
      this.handlePastedText(keyStr);
      return;
    }

    // 1. Ctrl+C: exit
    if ((keyObj.ctrl && (keyName === 'c' || keyName === 'C')) || keyStr === '\u0003') {
      this.stop();
      process.exit(0);
    }

    // Model Startup Selector key routing
    if (this.startupSelector) {
      if (keyObj.ctrl && (keyName === 'p' || keyName === 'P' || keyStr === '\x10')) {
        this.startupSelector = undefined;
        this.quickActionsOpen = true;
        this.quickActionIndex = 0;
        this.draw();
        return;
      }
      if (keyStr.startsWith('/') || (keyStr === '/' && this.inputBuffer === '')) {
        this.startupSelector = undefined;
        this.focusedPane = 'prompt';
        this.inputBuffer = keyStr;
        this.inputCursor = keyStr.length;
        this.draw();
        return;
      }
      if (this.inputBuffer === '' && (keyStr === 'q' || keyStr === 'Q')) {
        this.stop();
        process.exit(0);
      }
      void this.handleStartupSelectorKey(keyStr, keyObj);
      return;
    }

    // Task-Time Model Required modal key routing
    if (this.taskTimeModelRequired) {
      void this.handleTaskTimeModalKey(keyStr, keyObj);
      return;
    }

    // PASTE review mode handling
    if (this.tuiMode === 'PASTE') {
      if (key === '\u001b' || key === '\x1b' || keyName === 'escape') {
        this.pastedContent = '';
        this.tuiMode = 'NORMAL';
        // Same class of bug as the Enter-submit path above (see its own
        // comment): nothing reset focus off whatever pane it was on before
        // the paste (often 'nav', the default on the fleet view) after
        // discarding, so subsequent typed letters that collide with a
        // nav-focused shortcut (e.g. 'x', 'c') got swallowed by nav actions
        // instead of reaching the prompt — reported as "I could no longer
        // type" after discarding/submitting a large paste.
        this.focusedPane = 'prompt';
        this.statusMessage = 'Pasted content discarded.';
        this.draw();
        return;
      }
      if (keyStr === 'e' || keyStr === 'E') {
        this.tuiMode = 'COMPOSER';
        this.inputBuffer = this.pastedContent;
        this.inputCursor = this.inputBuffer.length;
        this.pastedContent = '';
        this.focusedPane = 'prompt';
        this.statusMessage = 'Composer active. Press Ctrl+Enter to submit, Esc to cancel.';
        this.draw();
        return;
      }
      if (isCtrlEnter(keyStr, keyObj)) {
        const toSubmit = this.pastedContent;
        this.pastedContent = '';
        this.tuiMode = 'NORMAL';
        // Matches the keyboard-submit Enter path above/below: focus moves to
        // 'nav' after a submission (so nav shortcuts work immediately on the
        // new job without an extra keypress first), not left on whatever
        // pane was focused before the paste — which is the same
        // stuck-focus bug the Esc-discard branch above just got fixed for.
        this.focusedPane = 'nav';
        this.statusMessage = 'Submitting pasted task...';
        const submission: InteractiveSubmission = {
          submissionId: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          sessionId: this.sessionId,
          source: 'confirmed-paste-submit',
          text: toSubmit,
          timestamp: new Date(),
        };
        void this.submitCommand(submission);
        return;
      }
      if (keyName === 'return' || keyName === 'enter' || keyStr === '\r' || keyStr === '\n') {
        this.statusMessage = 'Press Ctrl+Enter to submit pasted content, Esc to discard, or E to edit.';
        this.draw();
        return;
      }
      // Any other keys in PASTE mode are ignored
      return;
    }

    // COMPOSER mode handling
    if (this.tuiMode === 'COMPOSER') {
      if (key === '\u001b' || key === '\x1b' || keyName === 'escape') {
        this.inputBuffer = '';
        this.inputCursor = 0;
        this.tuiMode = 'NORMAL';
        this.statusMessage = 'Composer cancelled.';
        this.draw();
        return;
      }
      if (isCtrlEnter(keyStr, keyObj)) {
        const command = this.inputBuffer.trim();
        this.inputBuffer = '';
        this.inputCursor = 0;
        this.tuiMode = 'NORMAL';
        const submission: InteractiveSubmission = {
          submissionId: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          sessionId: this.sessionId,
          source: 'keyboard-submit',
          text: command,
          timestamp: new Date(),
        };
        void this.submitCommand(submission);
        return;
      }
      if (keyName === 'return' || keyName === 'enter' || keyStr === '\r' || keyStr === '\n') {
        // In composer mode, Enter inserts a newline
        this.inputBuffer =
          this.inputBuffer.slice(0, this.inputCursor) + '\n' + this.inputBuffer.slice(this.inputCursor);
        this.inputCursor += 1;
        this.draw();
        return;
      }
      // Fall through to standard text editing keys below
    }

    // Ctrl+Y: Toggle COPY mode
    if ((keyObj.ctrl && (keyName === 'y' || keyName === 'Y')) || keyStr === '\u0019') {
      this.tuiMode = this.tuiMode === 'COPY' ? 'NORMAL' : 'COPY';
      this.statusMessage =
        this.tuiMode === 'COPY'
          ? 'Entered copy mode. Terminal selection active. Submissions locked. Press Esc to exit.'
          : 'Exited copy mode.';
      this.draw();
      return;
    }

    // Ctrl+G: manually toggle FULL <-> FOCUSED sidebar (does not affect selection/scroll).
    // (Ctrl+B is already bound to "expand latest block from history" — see below —
    // so the sidebar hide/restore toggle uses Ctrl+T instead.)
    if ((keyObj.ctrl && (keyName === 'g' || keyName === 'G')) || keyStr === '\u0007') {
      this.sidebarManuallyOverridden = true;
      this.sidebarMode = this.sidebarMode === 'full' ? 'focused' : 'full';
      this.statusMessage = `Sidebar: ${this.sidebarMode.toUpperCase()}`;
      this.draw();
      return;
    }

    // Ctrl+T: hide/restore the entire left pane. Hiding is a manual override that
    // survives incoming events; restoring hands back to automatic mode selection
    // (FOCUSED for one active task, FULL otherwise) rather than a hardcoded mode.
    // Selection, scroll position, and the active task/execution are untouched.
    if ((keyObj.ctrl && (keyName === 't' || keyName === 'T')) || keyStr === '\u0014') {
      if (this.sidebarMode === 'hidden') {
        this.sidebarManuallyOverridden = false;
        this.sidebarMode = this.computeAutoSidebarMode();
        this.statusMessage = `Sidebar restored: ${this.sidebarMode.toUpperCase()}`;
      } else {
        this.sidebarManuallyOverridden = true;
        this.sidebarMode = 'hidden';
        this.statusMessage = 'Sidebar hidden — Ctrl+T to restore';
      }
      this.draw();
      return;
    }

    // COPY mode handling
    if (this.tuiMode === 'COPY') {
      if (key === '\u001b' || key === '\x1b' || keyName === 'escape') {
        this.tuiMode = 'NORMAL';
        this.statusMessage = 'Exited copy mode.';
        this.draw();
        return;
      }
      if (keyName === 'return' || keyName === 'enter' || keyStr === '\r' || keyStr === '\n') {
        this.statusMessage = 'Copy mode active. Press Esc to exit before submitting.';
        this.draw();
        return;
      }
      // Ignore other keys in COPY mode
      return;
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
        if (this.currentError.taskId) {
          this.dismissedErrorTaskIds.add(this.currentError.taskId);
        }
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
        if (retryTask) this.dismissedErrorTaskIds.add(retryTask);
        this.currentError = undefined;
        if (retryTask) {
          this.statusMessage = `Retrying task ${retryTask}...`;
        }
        this.draw();
        return;
      }
      if (keyStr === 'd' || keyStr === 'D') {
        if (this.currentError.taskId) this.dismissedErrorTaskIds.add(this.currentError.taskId);
        this.currentError = undefined;
        void this.submitCommand('/doctor');
        return;
      }
      // Error card is a modal overlay — consume keys that would otherwise
      // accidentally trigger destructive nav shortcuts (e.g. 'x' deletes a job,
      // 'c' cancels a job, 'a'/'d' approve/deny approval modals beneath).
      // Navigation keys (Tab, Enter, arrow keys, Esc) intentionally pass through:
      // Tab and Enter let the user inspect the tail log / switch views while the
      // card is visible, and Esc is handled in the Escape block above this one.
      const isNavigationKey =
        keyName === 'tab' ||
        keyName === 'return' ||
        keyName === 'enter' ||
        keyName === 'up' ||
        keyName === 'down' ||
        keyName === 'left' ||
        keyName === 'right' ||
        keyName === 'escape' ||
        keyStr === '\t' ||
        keyStr === '\r' ||
        keyStr === '\n' ||
        keyStr === '\x1b[Z' || // shift-tab
        keyStr.startsWith('\x1b[');
      if (!isNavigationKey) return;
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
      // Approval modal is a blocking overlay — consume all other keys so they don't
      // accidentally trigger nav shortcuts or other actions underneath the modal.
      return;
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
        const submission: InteractiveSubmission = {
          submissionId: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          sessionId: this.sessionId,
          source: 'keyboard-submit',
          text: command,
          timestamp: new Date(),
        };
        void this.submitCommand(submission);
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
   * Submits a user command or task prompt with strict deduplication and provenance tracking.
   */
  async submitCommand(cmdOrSubmission: string | InteractiveSubmission): Promise<void> {
    const submission: InteractiveSubmission =
      typeof cmdOrSubmission === 'string'
        ? {
            submissionId: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            sessionId: this.sessionId,
            source: 'keyboard-submit',
            text: cmdOrSubmission,
            timestamp: new Date(),
          }
        : cmdOrSubmission;

    // Structural deduplication by submissionId: reject duplicate events
    if (this.processedSubmissionIds.has(submission.submissionId)) {
      return;
    }
    this.processedSubmissionIds.add(submission.submissionId);

    const trimmed = submission.text.trim();
    if (!trimmed) return;

    if (trimmed === '/exit' || trimmed === '/quit' || trimmed === 'q') {
      this.stop();
      return;
    }

    if (this.tuiMode === 'COPY' || this.tuiMode === 'PASTE') {
      this.statusMessage = `Job submission is disabled in ${this.tuiMode} mode.`;
      this.draw();
      return;
    }

    if (trimmed === '/copy') {
      this.tuiMode = 'COPY';
      this.statusMessage = 'Entered copy mode. Terminal selection active. Submissions locked. Press Esc to exit.';
      this.draw();
      return;
    }

    // Accidental-Paste & Burst Submission Circuit Breakers:
    // A. UI Fragment Guard: reject terminal output fragments, headers, borders
    if (isScreenFragment(trimmed)) {
      this.statusMessage = `Rejected UI fragment submission ("${trimmed.slice(0, 30)}..."). 0 jobs created.`;
      this.draw();
      return;
    }

    // B. Burst Rate Guard: detect multiple rapid submissions from input stream
    const now = Date.now();
    if (now < this.burstCooldownUntil) {
      this.statusMessage = 'SUBMISSION BURST DETECTED: multiple rapid submissions refused. No jobs started.';
      this.draw();
      return;
    }

    this.submissionTimestamps = this.submissionTimestamps.filter((t) => now - t <= 1000);
    this.submissionTimestamps.push(now);
    const count500ms = this.submissionTimestamps.filter((t) => now - t <= 500).length;
    const count1000ms = this.submissionTimestamps.length;

    if (count500ms > 3 || count1000ms > 3) {
      this.burstCooldownUntil = now + 1500;
      this.statusMessage = 'SUBMISSION BURST DETECTED: multiple rapid submissions detected from input stream. No jobs started.';
      this.draw();
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

    if (trimmed === '/models' || trimmed === '/model-manager') {
      this.openModelStartupSelector();
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

    if (trimmed.startsWith('/compact')) {
      try {
        const parts = trimmed.split(/\s+/);
        const targetExecId = parts[1] ?? this.selectedTaskId ?? this.currentJob?.tasks[0]?.id;
        if (!targetExecId) {
          this.statusMessage = 'No active task/execution to compact. Usage: /compact [executionId]';
        } else {
          const compactor = this.engine.compaction;
          if (!compactor) {
            this.statusMessage = 'Context compaction service is not initialized';
          } else {
            const res = await compactor.compact({
              executionId: targetExecId,
              trigger: 'USER',
              reason: 'Manual compaction via /compact',
              force: true,
            });
            if (res.status === 'compacted' && res.metrics) {
              const m = res.metrics;
              const reduction = m.beforeTokens > 0 ? ((m.tokensSaved / m.beforeTokens) * 100).toFixed(1) : '0';
              this.statusMessage = `Context compacted: ${m.beforeTokens} -> ${m.afterTokens} tokens (saved ${m.tokensSaved}, -${reduction}%). Offloads: ${m.offloadedArtifacts}`;
            } else if (res.status === 'skipped') {
              this.statusMessage = `Context compaction skipped: ${res.metrics?.reason ?? 'insufficient tokens to reclaim'}`;
            } else {
              this.statusMessage = `Context compaction failed: ${res.error ?? 'unknown error'}`;
            }
          }
        }
      } catch (err) {
        this.statusMessage = `Compaction error: ${err instanceof Error ? err.message : String(err)}`;
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
        this.currentBlockTracker = await createBlock(this.engine, trimmed, [], {
          submissionId: submission.submissionId,
          source: submission.source,
          sessionId: submission.sessionId,
        });
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
    // Installed models are activated on the existing execution after scheduling.
    const readiness = this.engine.lifecycle.getReadiness();
    if (readiness.installedCount === 0 && readiness.readyCount === 0) {
      this.statusMessage = 'No models installed. Discover models in LM Studio or Ollama.';
      this.openModelRecoveryModal();
      return;
    }

    this.statusMessage = 'Planning & scheduling job...';
    this.draw();

    const analysis = this.engine.planner?.analyze(prompt) ?? {
      mutationRequired: true,
      workspaceMode: 'clean' as const,
      expectedArtifacts: [],
      capabilities: [],
    };

    let taskDescriptions: string[] = [];
    let jobTasks: JobTaskInput[];

    if (this.enablePlanner && !prompt.startsWith('/fanout ') && !prompt.startsWith('/parallel ') && !prompt.startsWith('/p ')) {
      this.statusMessage = 'Planning task execution DAG...';
      this.draw();
      const plan = await this.engine.planner.plan(prompt);
      jobTasks = this.engine.planner.planToJobTaskInputs(plan, {
        execution: {
          targetAgentId: 'wazir-step',
          targetModelId: this.selectedModelId,
        },
        mutationRequired: analysis.mutationRequired,
        workspaceMode: analysis.workspaceMode,
      });
    } else if (prompt.startsWith('/fanout ')) {
      const raw = prompt.slice(8).trim();
      taskDescriptions = raw.split(';').map((s) => s.trim()).filter(Boolean);
      jobTasks = taskDescriptions.map((desc) => ({
        task: {
          type: 'coding',
          title: desc.slice(0, 50),
          input: desc,
          mutationRequired: analysis.mutationRequired,
          workspaceMode: analysis.workspaceMode,
          expectedArtifacts: analysis.expectedArtifacts,
          capabilities: analysis.capabilities,
          execution: this.selectedModelId ? { targetModelId: this.selectedModelId } : undefined,
        },
      }));
    } else if (prompt.includes('\n- ') || prompt.includes('\n* ')) {
      taskDescriptions = prompt.split(/\n[-*]\s+/).map((s) => s.trim()).filter(Boolean);
      jobTasks = taskDescriptions.map((desc) => ({
        task: {
          type: 'coding',
          title: desc.slice(0, 50),
          input: desc,
          mutationRequired: analysis.mutationRequired,
          workspaceMode: analysis.workspaceMode,
          expectedArtifacts: analysis.expectedArtifacts,
          capabilities: analysis.capabilities,
          execution: this.selectedModelId ? { targetModelId: this.selectedModelId } : undefined,
        },
      }));
    } else {
      taskDescriptions = [prompt];
      jobTasks = taskDescriptions.map((desc) => ({
        task: {
          type: 'coding',
          title: desc.slice(0, 50),
          input: desc,
          mutationRequired: analysis.mutationRequired,
          workspaceMode: analysis.workspaceMode,
          expectedArtifacts: analysis.expectedArtifacts,
          capabilities: analysis.capabilities,
          execution: this.selectedModelId ? { targetModelId: this.selectedModelId } : undefined,
        },
      }));
    }

    try {
      const job = await this.engine.orchestrator.createJob({
        title: prompt.slice(0, 60),
        concurrencyLimit: this.concurrencyLimit,
        tasks: jobTasks,
      });

      this.currentJob = job;
      this.agents.clear();
      this.agentLogs.clear();
      // A new job means a fresh execution context — reset dismissed-error tracking so
      // errors from this job always surface (they're new failures, not repeats of
      // something the user already acknowledged from a previous session).
      this.dismissedErrorTaskIds.clear();
      this.currentError = undefined;

      for (const t of job.tasks) {
        const card: AgentCardState = {
          taskId: t.id,
          title: t.title ?? t.input.slice(0, 40),
          agentId: t.execution?.targetAgentId ?? (this.enablePlanner ? 'wazir-step' : 'wazir-coding'),
          computerId: 'evaluating...',
          modelId: 'evaluating...',
          stage: 'EXECUTION',
          phase: 'queued',
          attempt: 1,
          maxAttempts: (job.maxRetries ?? 3) + 1,
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

          const finalJob = (await this.engine.orchestrator.getJob(job.id)) ?? job;
          this.currentJob = finalJob;
          this.currentRollup = await this.engine.orchestrator.getJobRollup(job.id);
          this.jobRollups.set(job.id, this.currentRollup);
          // A timeout is reported as 'failed' with the reason on the task node; say so
          // here rather than a bare "failed!" that hides why.
          const timeoutNode = finalJob.graph.nodes.find((n) => /timeout/i.test(n.error ?? ''));
          const outcome = timeoutNode ? `failed (${timeoutNode.error})` : `${finalJob.status}!`;
          this.statusMessage = `Job ${job.id} ${outcome} Tokens: In ${this.currentRollup.tokens.input}/Out ${this.currentRollup.tokens.output}, Dur: ${(this.currentRollup.durationMs / 1000).toFixed(1)}s`;

          if (this.currentBlockTracker) {
            await this.currentBlockTracker.finish(finalJob.status === 'completed' ? 'success' : 'failed', {
              exitCode: finalJob.status === 'completed' ? 0 : 1,
              jobId: job.id,
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
        agent.stage = agent.stage ?? 'EXECUTION';
        agent.attempt = agent.attempt ?? 1;
        agent.maxAttempts = agent.maxAttempts ?? 4;
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
          breakdown?: PromptBreakdown;
          raw?: string;
          metadata?: Record<string, unknown>;
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
          if (p.usage) {
            agent.lastTurnInputTokens = p.usage.input;
            agent.modelCallCount = (agent.modelCallCount ?? 0) + 1;
            if (!agent.usage) {
              agent.usage = { input: p.usage.input, output: p.usage.output, total: p.usage.total };
            } else {
              agent.usage.input += p.usage.input;
              agent.usage.output += p.usage.output;
              agent.usage.total += p.usage.total;
            }
          }
          if (p.breakdown) {
            agent.promptBreakdown = p.breakdown;
          }
          this.agentLogs.set(taskId, logs);
          this.draw();
          return;
        }

        if (p.phase) agent.phase = p.phase;
        if (p.content) agent.lastMessage = p.content.slice(0, 60);
        if (p.tool) agent.lastMessage = `Tool: ${p.tool}`;
        if (p.error) agent.lastMessage = `Error: ${this.humanizeError(p.error).slice(0, 60)}`;

        let eventKind: 'plan' | 'route' | 'tool' | 'test' | 'complete' | 'error' | 'info' | 'validate' | 'recover' | 'policy' | 'infra' = 'info';
        let eventText = p.content ?? (p.tool ? `tool: ${p.tool}` : `phase: ${p.phase}`);

        if (p.error?.includes('PREFLIGHT_FAILED') || p.content?.includes('PREFLIGHT_FAILED')) {
          eventKind = 'infra';
          eventText = p.error || p.content || 'Preflight failure';
          agent.errorKind = 'infrastructure';
        } else {
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
              const web = p.metadata?.webEvidence as import('@wazir/core').GroundedResult | undefined;
              if ((p.tool === 'web_search' || p.tool === 'web_fetch') && web) {
                const summary = web.kind === 'web_search' ? `${web.results.length} results` : `${web.bytesDownloaded} bytes → ${web.content.length} chars; ${web.citation.citationId}`;
                eventText = `${p.tool} ✓ ${web.provider} · ${web.origin} · ${summary} · ${p.metadata?.webDurationMs ?? 0} ms`;
              }
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
        const isInfra = Boolean(
          agent.errorKind === 'infrastructure' ||
          ev.error?.includes('PREFLIGHT_FAILED') ||
          ev.error?.includes('WORKSPACE_') ||
          ev.error?.includes('TEMP_DIRECTORY_') ||
          ev.error?.includes('SHELL_UNAVAILABLE') ||
          ev.error?.includes('COMPILER_PROBE_FAILED')
        );
        if (isInfra) {
          agent.errorKind = 'infrastructure';
        }
        const failureReason = ev.error ? this.humanizeError(ev.error) : 'Task failed';
        agent.lastMessage = failureReason;

        logs.push({
          time: timeStr,
          text: isInfra ? `Infrastructure preflight failed: ${failureReason}` : `Task failed: ${failureReason}`,
          kind: isInfra ? 'infra' : 'error',
        });

        // Structured Error Component (§29).
        // Only open the card if the user has not already dismissed it for this
        // specific task — otherwise pressing Esc between retry cycles is futile
        // because every subsequent task:failed event immediately reopens the card.
        if (!this.dismissedErrorTaskIds.has(taskId)) {
          this.currentError = isInfra
            ? {
                phase: 'preflight',
                reason: ev.error ? this.humanizeError(ev.error) : 'Preflight infrastructure check failed',
                required: 'Writable workspace, accessible tmpdir, available shell, and working compiler',
                available: 'Host environment check failed before model invocation',
                suggestedSteps: [
                  '1. Check workspace permissions, isolated directory paths, and disk space',
                  '2. Run "wa doctor" to verify runtime, compiler, and sandbox status',
                  '3. Check Seatbelt profile or set WAZIR_PROBE_COMPILER=0 if compiler probe is not required',
                ],
                taskId: agent.taskId,
                timestamp: now,
              }
            : {
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
        }
      } else if (ev.type === 'task:retry') {
        // A retry means the failure was not terminal — clear any error card that was
        // shown for the failed attempt so the UI doesn't stay in an alarmed state while
        // the agent is already recovering.
        if (this.currentError?.taskId === taskId) {
          this.currentError = undefined;
        }
        agent.status = 'retry';
        agent.stage = 'REPAIR';
        agent.phase = 'plan';
        agent.attempt = (ev.retryCount ?? 1) + 1;
        agent.maxAttempts = (ev.maxRetries ?? 3) + 1;
        agent.lastMessage = `Repair ${ev.retryCount}/${ev.maxRetries}`;

        logs.push({
          time: timeStr,
          text: `Repair initiated (${ev.retryCount}/${ev.maxRetries})`,
          kind: 'recover',
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
  /**
   * Automatic sidebar mode from current execution state: FULL for idle/fleet-management
   * or multiple concurrent tasks (still need the overview), FOCUSED for exactly one
   * active task (the common "run a task, watch it" case this pane was crowding out).
   * Never returns 'hidden' — that's only ever a manual user choice (see handleKey).
   */
  private computeAutoSidebarMode(): 'full' | 'focused' {
    const runningCount = this.getAgents().filter((a) => a.status === 'running').length;
    return runningCount === 1 ? 'focused' : 'full';
  }

  /**
   * Sections that must stay visible even in focused mode because they have something
   * requiring user attention (disconnected computer, failed runtime, MCP auth needed,
   * unavailable agent) — focused mode hides infrastructure by default, but never hides
   * a real problem.
   */
  private getAlertCategories(): Set<NavCategory> {
    const alert = new Set<NavCategory>();
    for (const it of this.getFlatNavItems()) {
      if (
        (it.category === 'COMPUTERS' || it.category === 'RUNTIMES' || it.category === 'MCP' || it.category === 'AGENTS') &&
        (it.status === 'failed' || it.status === 'auth_required')
      ) {
        alert.add(it.category);
      }
    }
    return alert;
  }

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

    for (const server of this.engine.mcp?.list() ?? []) {
      items.push({
        category: 'MCP',
        id: server.definition.id,
        label: `${server.definition.name} ${server.state === 'CONNECTED' ? server.tools.length + ' tools' : server.state.toLowerCase()}`,
        status:
          server.state === 'CONNECTED'
            ? 'completed'
            : server.state === 'CONNECTING'
              ? 'running'
              : server.state === 'AUTH_REQUIRED'
                ? 'auth_required'
                : server.state === 'FAILED'
                  ? 'failed'
                  : 'idle',
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
  getContextMetrics(): { used: number; max: number; jobIn: number; jobOut: number; calls: number } {
    const agents = Array.from(this.agents.values());
    const byRecency = (a: AgentCardState, b: AgentCardState) =>
      (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0);
    const source =
      agents.filter((a) => a.status === 'running' && a.lastTurnInputTokens !== undefined).sort(byRecency)[0] ??
      agents.filter((a) => a.lastTurnInputTokens !== undefined).sort(byRecency)[0];
    const used = source?.lastTurnInputTokens ?? 0;

    let jobIn = 0;
    let jobOut = 0;
    let calls = 0;

    const all = this.getFlatNavItems();
    const current = all[this.navSelectionIndex];
    const jobId = current?.category === 'JOBS' ? current.id : this.currentJob?.id;
    if (jobId) {
      const rollup = this.jobRollups.get(jobId) ?? (this.currentJob?.id === jobId ? this.currentRollup : undefined);
      if (rollup) {
        jobIn = rollup.tokens.input;
        jobOut = rollup.tokens.output;
      }
    }

    let agentIn = 0;
    let agentOut = 0;
    for (const a of agents) {
      calls += a.modelCallCount ?? (a.usage ? 1 : 0);
      if (a.usage) {
        agentIn += a.usage.input;
        agentOut += a.usage.output;
      }
    }

    if (agentIn > 0) {
      jobIn = agentIn;
      jobOut = agentOut;
    }

    const models = this.engine.models.list();
    const max = models[0]?.contextMax ?? 32768;
    const result = { used, max };
    Object.defineProperties(result, {
      jobIn: { value: jobIn, enumerable: false },
      jobOut: { value: jobOut, enumerable: false },
      calls: { value: calls, enumerable: false },
    });
    return result as { used: number; max: number; jobIn: number; jobOut: number; calls: number };
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

    // Auto-recompute the sidebar mode from execution state UNLESS the user manually
    // chose one (Ctrl+B / Ctrl+Shift+B) — a manual choice must survive incoming
    // MODEL/TOOL/PLAN/ROUTE/ERROR/VERIFY events, not flicker back open/closed with them.
    if (!this.sidebarManuallyOverridden) {
      this.sidebarMode = this.computeAutoSidebarMode();
    }
    // Only worth computing in focused/hidden mode — full mode shows every section
    // regardless, and this scan is skippable overhead on every single draw() otherwise
    // (draw() fires on every keypress and event-stream tick).
    const alertCategories = this.sidebarMode === 'full' ? new Set<NavCategory>() : this.getAlertCategories();
    const isSplit = size.columns >= 100 && this.sidebarMode !== 'hidden';
    if (isSplit) {
      const leftWidth = Math.max(26, Math.min(36, Math.floor(size.columns * 0.28)));
      const mainWidth = size.columns - leftWidth - 1;

      const leftLines = this.renderLeftNav(leftWidth, contentHeight, this.sidebarMode, alertCategories);
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
    if (this.startupSelector) {
      const modalLines = this.renderStartupSelectorModal(size.columns);
      const startY = Math.max(2, 2 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.taskTimeModelRequired) {
      const modalLines = this.renderTaskTimeModelRequiredModal(size.columns);
      const startY = Math.max(2, 2 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.pendingApprovals.length > 0) {
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
    const readiness = this.engine.lifecycle.getReadiness();
    const readyColored = readiness.readyCount > 0 ? color.green(`${readiness.readyCount} READY`) : color.yellow(`0 READY`);
    const modelTagColored = `${readyColored} / ${readiness.installedCount} MODELS`;
    const modelTagPlain = `${readiness.readyCount} READY / ${readiness.installedCount} MODELS`;

    const activeCount = Array.from(this.agents.values()).filter((a) => a.status === 'running').length;
    const workerStatus = activeCount >= this.concurrencyLimit ? 'BUSY' : 'AVAILABLE';

    // §3: View Title Indicator - fully overwritten on state changes using fixed-width padding
    // to prevent concatenation artifacts (e.g., [View: FLEET]EES clipping bug)
    const viewName = this.currentView.toUpperCase();
    const viewTag = `[View: ${viewName}]`;
    // Pad to fixed 20 chars so switching between FLEET/TAIL/APPROVAL/WORKTREES/HELP never leaves residual chars
    const viewTagPadded = viewTag.padEnd(20);

    // Semantic Colors (§25): cyan = identity / active context, green = ok/success, yellow = waiting
    const titlePart = `${color.bold(color.cyan('WAZIR'))} ${color.gray('-')} ${color.bold('CONTROL')} ${color.gray('-')} ${color.bold('WORKER:')} ${compCount} COMPUTERS ${agentCount} AGENTS ${modelTagColored}`;
    const viewPart = color.bold(color.cyan(viewTagPadded));
    const agentPart = `Agents ${activeCount}/${this.concurrencyLimit} ${color.gray('-')} ${workerStatus === 'AVAILABLE' ? color.green('AVAILABLE') : color.yellow('BUSY')}`;

    const pendingCount = this.pendingApprovals.length;
    const alert = pendingCount > 0 ? color.bold(color.yellow(` [! ${pendingCount} APPROVALS]`)) : '';

    const titlePlain = `WAZIR - CONTROL - WORKER: ${compCount} COMPUTERS ${agentCount} AGENTS ${modelTagPlain}`;
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
  private renderLeftNav(
    width: number,
    maxRows: number,
    mode: SidebarMode = 'full',
    alertCategories: Set<NavCategory> = new Set(),
  ): string[] {
    const lines: string[] = [];
    const allCategories: NavCategory[] = ['JOBS', 'EXECUTIONS', 'AGENTS', 'COMPUTERS', 'RUNTIMES', 'MCP'];
    // Focused mode: only task-relevant sections, plus any section with an unresolved
    // problem (never hide something that needs the user's attention) — see § Focused
    // Execution Mode / § Preserve Important Alerts.
    const categories =
      mode === 'full'
        ? allCategories
        : allCategories.filter(
            (cat) => cat === 'JOBS' || cat === 'EXECUTIONS' || cat === 'AGENTS' || alertCategories.has(cat),
          );
    const flatItems = this.getFlatNavItems();
    const currentSelected = flatItems[this.navSelectionIndex];
    const activeAgentIds = new Set(this.getAgents().filter((a) => a.status === 'running').map((a) => a.agentId));

    for (const cat of categories) {
      if (lines.length >= maxRows) break;
      const isCatNavFocused = this.focusedPane === 'nav';
      lines.push(this.padRightTo(` ${color.bold(color.cyan(cat))}`, width));

      let catItems = flatItems.filter((it) => it.category === cat);
      if (mode !== 'full') {
        if (cat === 'JOBS' || cat === 'EXECUTIONS') {
          // Only the active job/execution — inactive/previous ones just add noise
          // while a single task is running (§ Distinguish Active From Inactive State).
          const running = catItems.filter((it) => it.status === 'running');
          catItems = running.length > 0 ? running : catItems;
        } else if (cat === 'AGENTS') {
          const active = catItems.filter((it) => activeAgentIds.has(it.id));
          catItems = active.length > 0 ? active : catItems.filter((it) => it.status === 'running');
        } else {
          // COMPUTERS/RUNTIMES/MCP are only present here because of an alert — show
          // just the item(s) actually in trouble, not the whole inventory.
          catItems = catItems.filter((it) => it.status === 'failed' || it.status === 'auth_required');
        }
      }
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
          else if (item.status === 'failed' || item.status === 'auth_required') glyph = color.red('x');

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
    if (this.currentView === 'search') {
      return this.renderSearchPane(width, maxRows);
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
    } else if (selected.category === 'MCP') {
      const server = this.engine.mcp?.get(selected.id);
      const stateStr =
        server?.state === 'AUTH_REQUIRED'
          ? color.red('AUTH_REQUIRED')
          : server?.state === 'CONNECTED'
            ? color.green('CONNECTED')
            : (server?.state ?? 'unavailable');
      routingLine = `  MCP ${selected.id}: ${stateStr} (${server?.definition.transport ?? '-'})`;
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
              ? (card.errorKind === 'infrastructure' ? color.bold(color.red('[INFRA FAILED]')) : color.red('[FAILED]'))
              : card.status === 'running'
                ? color.cyan(`[RUNNING ${getCategorySpinnerFrame('EXECUTIONS', this.spinnerTick)}]`)
                : color.yellow(`[${card.status.toUpperCase()}]`);

        lines.push(
          this.padRightTo(
            `  Tail: ${color.bold(card.taskId)} (${card.title}) | Stage: ${color.magenta(card.stage ?? 'EXECUTION')} | Phase: ${color.cyan(card.phase)} | Attempt: ${card.attempt ?? 1}/${card.maxAttempts ?? 1} | Status: ${statusBadge} | Dur: ${durStr}`,
            width,
          ),
        );
        if (card.usage && !this.currentError) {
          const tps = tokensPerSecond(card.usage.output, card.durationMs).toFixed(1);
          const pb = card.promptBreakdown;
          const pbStr = pb
            ? ` | Prompt: sys ${pb.system} | tools ${pb.tools} | task ${pb.task} | plan ${pb.plan} | hist ${pb.history} | repo ${pb.repository}`
            : '';
          lines.push(
            this.padRightTo(
              color.gray(
                `  Tokens: In ${card.usage.input} / Out ${card.usage.output} (${card.usage.total} total) | Speed: ${tps} tok/s${pbStr}`,
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
            } else if (k === 'recover' || k === 'repair') {
              badge = color.magenta('RECOVER ');
              contentText = color.magenta(truncatedText);
            } else if (k === 'policy') {
              badge = color.red('POLICY  ');
              contentText = color.red(truncatedText);
            } else if (k === 'infra' || k === 'host') {
              badge = color.bold(color.red('INFRA   '));
              contentText = color.red(truncatedText);
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
    } else if (selected.category === 'MCP') {
      const server = this.engine.mcp?.get(selected.id);
      if (server) {
        for (const text of [
          `MCP: ${server.definition.name}`,
          `Status: ${server.state === 'AUTH_REQUIRED' ? color.red('AUTH_REQUIRED') : server.state}`,
          `Tools: ${server.tools.length}  Resources: ${server.resources.length}  Prompts: ${server.prompts.length}`,
          `Details: wa mcp inspect ${selected.id}`,
          `Tool palette: wa mcp tools ${selected.id}`,
        ]) lines.push(this.padRightTo('  ' + text, width));
        if (server.state === 'AUTH_REQUIRED') {
          lines.push(this.padRightTo(`  ${color.yellow(`Action: run 'wa mcp auth ${selected.id}' to configure credentials`)}`, width));
        }
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
    const { used, max, jobIn, jobOut, calls } = this.getContextMetrics();
    const usedK = (used / 1024).toFixed(1);
    const maxK = Math.round(max / 1024);
    const inK = (jobIn / 1024).toFixed(1);
    const outK = (jobOut / 1024).toFixed(1);

    // Semantic colors (§25): cyan = identity / active context
    // Only shown once a model is pinned via /model — otherwise this bar stays as it
    // was, since "auto-routed" is the common case and not worth a permanent label.
    const modelPlain = this.selectedModelId ? `Model ${this.selectedModelId} ~ ` : '';
    const modelIndicator = this.selectedModelId ? `${color.magenta(modelPlain.trimEnd())} ` : '';

    const showJobTokens = calls > 0 || jobIn > 0;
    const jobPlain = showJobTokens ? `Job ${inK}K in / ${outK}K out, Calls: ${calls} ~ ` : '';
    const jobIndicator = showJobTokens ? color.gray(jobPlain) : '';

    const contextPlain = `Context ${usedK}K/${maxK}K ~`;
    const contextIndicator = color.cyan(contextPlain);

    // Subtle sidebar-toggle hint (§ Show Toggle State Clearly) — a short tag, not
    // another persistent large UI element. Alert categories still hidden from the
    // pane surface here as a small warning glyph so a real problem stays visible
    // even while the sidebar itself is hidden/focused.
    const alertCats = this.sidebarMode !== 'full' ? Array.from(this.getAlertCategories()) : [];
    const alertPlain = alertCats.length > 0 ? `${alertCats.map((c) => `!${c}`).join(' ')} ~ ` : '';
    const alertIndicator = alertCats.length > 0 ? color.yellow(alertPlain) : '';
    const sidebarPlain = this.sidebarMode === 'hidden' ? 'Sidebar hidden (Ctrl+T) ~ ' : 'Ctrl+T Sidebar ~ ';
    const sidebarIndicator = color.gray(sidebarPlain);

    const anyRunning =
      Array.from(this.agents.values()).some((a) => a.status === 'running') ||
      this.statusMessage.includes('Planning') ||
      this.statusMessage.includes('Retrying') ||
      this.statusMessage.includes('Executing');
    const spinnerPrefix = anyRunning ? `${color.cyan(getCategorySpinnerFrame('JOBS', this.spinnerTick))} ` : '';

    const mode = this.getMode();
    let modeBadge = color.gray(`[${mode}]`);
    if (mode === 'PASTE') modeBadge = color.bold(color.yellow(`[${mode}]`));
    else if (mode === 'COMPOSER') modeBadge = color.bold(color.magenta(`[${mode}]`));
    else if (mode === 'COPY') modeBadge = color.bold(color.cyan(`[${mode}]`));
    else if (mode === 'APPROVAL') modeBadge = color.bold(color.red(`[${mode}]`));
    else if (mode === 'PALETTE') modeBadge = color.bold(color.blue(`[${mode}]`));

    const rightPlain = `${modelPlain}${jobPlain}${alertPlain}${sidebarPlain}${contextPlain} `;
    const maxStatusLen = Math.max(10, cols - rightPlain.length - 16);
    let msg = this.statusMessage;
    if (msg.length > maxStatusLen) {
      msg = msg.slice(0, maxStatusLen - 3) + '...';
    }

    const statusText = `  ${modeBadge} ${color.gray('Status:')} ${spinnerPrefix}${msg}`;
    const statusPlain = this.stripAnsi(statusText);

    const spaces = Math.max(2, cols - statusPlain.length - rightPlain.length);
    return `${statusText}${' '.repeat(spaces)}${modelIndicator}${jobIndicator}${alertIndicator}${sidebarIndicator}${contextIndicator} `;
  }

  private renderInputBar(cols: number): string {
    const mode = this.getMode();
    if (mode === 'PASTE') {
      const charCount = this.pastedContent.length;
      const lineCount = this.pastedContent.split(/\r?\n/).length;
      const promptPrefix = color.cyan('wa> ');
      const label = color.yellow(`[Pasted ${charCount.toLocaleString()} characters / ${lineCount} lines]`);
      const hints = color.gray(' (Ctrl+Enter submit • Esc discard • E edit)');
      const full = `${promptPrefix}${label}${hints}`;
      this.inputCursorScreenCol = 4 + this.stripAnsi(label).length + 1;
      return full;
    }

    if (mode === 'COPY') {
      const promptPrefix = color.cyan('wa [COPY]> ');
      const hint = color.gray('(Terminal selection active - press Esc to return)');
      this.inputCursorScreenCol = 12;
      return `${promptPrefix}${hint}`;
    }

    const promptPrefix = mode === 'COMPOSER' ? color.magenta('wa [COMPOSER]> ') : color.cyan('wa> ');
    const prefixLen = mode === 'COMPOSER' ? 15 : 4;
    const available = Math.max(0, cols - prefixLen);

    // Strip any leading prompt prefix in the inputBuffer to prevent duplicate prompts (e.g. "wa> wa> ...")
    const sanitizedInput = this.inputBuffer.replace(/^(wa(\s*\[[A-Z]+\])?>\s*)+/, '');
    const displayBuffer = mode === 'COMPOSER' ? sanitizedInput.replace(/\r?\n/g, ' ↵ ') : sanitizedInput;
    const start = this.inputCursor > available ? this.inputCursor - available : 0;
    const visibleInput = displayBuffer.slice(start, start + available);
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

  openModelStartupSelector(): void {
    const readiness = this.engine.lifecycle.getReadiness();
    const eligible = this.engine.lifecycle.getEligibleModels();
    const allInstalled = this.engine.models.listInstalled();
    const recommended = this.engine.lifecycle.getRecommendedModels();
    const recommendedIds = new Set(recommended.map((r) => r.model.id));

    // Pre-check recommended models
    const selectedIds = new Set<string>();
    for (const r of recommended) {
      selectedIds.add(r.model.id);
    }
    if (selectedIds.size === 0 && eligible.length > 0) {
      selectedIds.add(eligible[0].id);
    }

    const assessments = new Map<string, ResourceAssessment>();
    for (const m of allInstalled) {
      assessments.set(m.id, this.engine.lifecycle.assessModelSync(m.id));
    }

    this.startupSelector = {
      mode: 'select',
      allInstalledModels: allInstalled,
      eligibleModels: eligible,
      recommendedModelIds: recommendedIds,
      selectedModelIds: selectedIds,
      selectedIndex: 0,
      resourceAssessments: assessments,
      loadStatuses: new Map(),
      loadErrors: new Map(),
    };
    this.draw();
  }

  openModelRecoveryModal(): void {
    this.startupSelector = {
      mode: 'recovery_no_models',
      allInstalledModels: [],
      eligibleModels: [],
      recommendedModelIds: new Set(),
      selectedModelIds: new Set(),
      selectedIndex: 0,
      resourceAssessments: new Map(),
      loadStatuses: new Map(),
      loadErrors: new Map(),
    };
    this.draw();
  }

  openRuntimeRecoveryModal(): void {
    this.startupSelector = {
      mode: 'recovery_runtime',
      allInstalledModels: [],
      eligibleModels: [],
      recommendedModelIds: new Set(),
      selectedModelIds: new Set(),
      selectedIndex: 0,
      resourceAssessments: new Map(),
      loadStatuses: new Map(),
      loadErrors: new Map(),
    };
    this.draw();
  }

  private async handleStartupModelReadiness(): Promise<void> {
    const mode = this.engine.config.models?.startup?.mode ?? 'prompt';
    if (mode === 'none') {
      return;
    }
    if (mode !== 'prompt') return; // Noninteractive startup policy was applied by createEngine.

    // Default: 'prompt'
    const readiness = this.engine.lifecycle.getReadiness();
    if (readiness.readyCount > 0) {
      if (readiness.unloadedEligibleModels.length > 0) {
        this.statusMessage = `Ready: ${readiness.readyCount} model(s) loaded. Press [M] to manage models.`;
      }
      return;
    }

    if (readiness.installedCount > 0) {
      this.openModelStartupSelector();
      return;
    }

    const runtimeEntries = Object.entries(readiness.runtimeHealth);
    const allUnavailable =
      runtimeEntries.length > 0 &&
      runtimeEntries.every(([, h]: [string, any]) => h.status === 'unavailable' || h.status === 'unhealthy');
    if (allUnavailable) {
      this.openRuntimeRecoveryModal();
    } else {
      this.openModelRecoveryModal();
    }
  }

  private handleModelLifecycleEvent(event: ModelLifecycleEvent): void {
    if (['MODEL_DRAINING', 'MODEL_ADMISSION_DENIED', 'MODEL_CONTEXT_DOWNSHIFTED', 'WAITING_FOR_MODEL'].includes(event.type)) {
      this.statusMessage = `${event.type}: ${event.modelId}${event.reason ? ' — ' + event.reason : ''}`;
      this.draw();
    }
    if (this.startupSelector) {
      if (event.type === 'MODEL_LOADING') {
        this.startupSelector.loadStatuses.set(event.modelId, 'LOADING');
      } else if (event.type === 'MODEL_READY') {
        this.startupSelector.loadStatuses.set(event.modelId, 'READY');
      } else if (event.type === 'MODEL_LOAD_FAILED' || event.type === 'MODEL_ADMISSION_DENIED') {
        this.startupSelector.loadStatuses.set(event.modelId, 'FAILED');
        const err = event.error ?? event.reason ?? (event.data?.error as string | undefined);
        if (err) {
          this.startupSelector.loadErrors.set(event.modelId, err);
        }
      }
      this.draw();
    }
  }

  private async executeModelLoads(modelIds: string[]): Promise<void> {
    if (!this.startupSelector) return;
    this.startupSelector.mode = 'loading';
    for (const id of modelIds) {
      this.startupSelector.loadStatuses.set(id, 'LOADING');
    }
    this.draw();

    const failedIds: string[] = [];
    for (const id of modelIds) {
      const ok = await this.engine.lifecycle.loadModel(id, { initiator: 'startup' });
      if (!ok) {
        failedIds.push(id);
        if (this.startupSelector) {
          this.startupSelector.loadStatuses.set(id, 'FAILED');
        }
      } else if (this.startupSelector) {
        this.startupSelector.loadStatuses.set(id, 'READY');
      }
      this.draw();
    }

    if (failedIds.length > 0) {
      if (this.startupSelector) {
        this.startupSelector.mode = 'failure';
        this.draw();
      }
    } else {
      const loadedCount = modelIds.length;
      this.startupSelector = undefined;
      this.statusMessage = `Ready: ${loadedCount} model(s) loaded successfully.`;
      this.draw();

      if (this.taskTimeModelRequired) {
        const prompt = this.taskTimeModelRequired.pendingPrompt;
        this.taskTimeModelRequired = undefined;
        await this.launchJobFromPrompt(prompt);
      }
    }
  }

  private async handleStartupSelectorKey(keyStr: string, keyObj?: readline.Key): Promise<void> {
    if (!this.startupSelector) return;
    const keyName = keyObj?.name;

    if (this.startupSelector.mode === 'select') {
      const models = this.startupSelector.allInstalledModels;
      if (this.startupSelector.inspectedModelId) {
        if (keyName === 'escape' || keyStr === '\x1b' || keyStr === 'i' || keyStr === 'I') {
          this.startupSelector.inspectedModelId = undefined;
          this.draw();
        }
        return;
      }

      if (keyName === 'up' || keyStr === '\u001b[A') {
        this.startupSelector.selectedIndex = Math.max(0, this.startupSelector.selectedIndex - 1);
        this.draw();
        return;
      }
      if (keyName === 'down' || keyStr === '\u001b[B') {
        this.startupSelector.selectedIndex = Math.min(Math.max(0, models.length - 1), this.startupSelector.selectedIndex + 1);
        this.draw();
        return;
      }
      if (keyStr === ' ') {
        const m = models[this.startupSelector.selectedIndex];
        if (m) {
          const isEligible = this.startupSelector.eligibleModels.some((e) => e.id === m.id);
          if (isEligible) {
            if (this.startupSelector.selectedModelIds.has(m.id)) {
              this.startupSelector.selectedModelIds.delete(m.id);
            } else {
              this.startupSelector.selectedModelIds.add(m.id);
            }
            this.draw();
          }
        }
        return;
      }
      if (keyName === 'return' || keyName === 'enter' || keyStr === '\r' || keyStr === '\n') {
        const toLoad = Array.from(this.startupSelector.selectedModelIds);
        if (toLoad.length === 0) {
          const m = models[this.startupSelector.selectedIndex];
          if (m && this.startupSelector.eligibleModels.some((e) => e.id === m.id)) {
            toLoad.push(m.id);
          }
        }
        if (toLoad.length > 0) {
          await this.executeModelLoads(toLoad);
        } else {
          this.startupSelector.statusBanner = 'No models selected. Press Space to select or [A] to load recommended.';
          this.draw();
        }
        return;
      }
      if (keyStr === 'a' || keyStr === 'A') {
        const recommended = this.engine.lifecycle.getRecommendedModels();
        const recIds = recommended.map((r) => r.model.id);
        if (recIds.length > 0) {
          await this.executeModelLoads(recIds);
        } else {
          const eligible = this.startupSelector.eligibleModels;
          if (eligible.length > 0) {
            await this.executeModelLoads([eligible[0].id]);
          }
        }
        return;
      }
      if (keyStr === 'l' || keyStr === 'L') {
        const eligible = this.startupSelector.eligibleModels.map((m) => m.id);
        if (eligible.length > 0) {
          await this.executeModelLoads(eligible);
        }
        return;
      }
      if (keyStr === 'r' || keyStr === 'R') {
        this.startupSelector.statusBanner = 'Refreshing discovery...';
        this.draw();
        await this.engine.lifecycle.discoverAndReconcile();
        this.openModelStartupSelector();
        return;
      }
      if (keyStr === 'i' || keyStr === 'I') {
        const m = models[this.startupSelector.selectedIndex];
        if (m) {
          this.startupSelector.inspectedModelId = m.id;
          this.draw();
        }
        return;
      }
      if (keyStr === 's' || keyStr === 'S' || keyName === 'escape' || keyStr === '\x1b') {
        this.startupSelector = undefined;
        this.statusMessage = 'Skipped model loading. 0 models ready.';
        this.draw();
        return;
      }
    } else if (this.startupSelector.mode === 'failure') {
      if (keyStr === 'r' || keyStr === 'R') {
        const failedIds = Array.from(this.startupSelector.loadStatuses.entries())
          .filter(([, status]) => status === 'FAILED')
          .map(([id]) => id);
        if (failedIds.length > 0) {
          await this.executeModelLoads(failedIds);
        }
        return;
      }
      if (keyStr === 'c' || keyStr === 'C') {
        this.startupSelector = undefined;
        const readiness = this.engine.lifecycle.getReadiness();
        this.statusMessage = `Continuing with ${readiness.readyCount} ready model(s).`;
        this.draw();
        if (this.taskTimeModelRequired && readiness.readyCount > 0) {
          const prompt = this.taskTimeModelRequired.pendingPrompt;
          this.taskTimeModelRequired = undefined;
          await this.launchJobFromPrompt(prompt);
        }
        return;
      }
      if (keyStr === 'b' || keyStr === 'B' || keyName === 'escape' || keyStr === '\x1b') {
        this.startupSelector.mode = 'select';
        this.draw();
        return;
      }
    } else if (this.startupSelector.mode === 'recovery_no_models') {
      if (keyStr === 'q' || keyStr === 'Q') {
        this.stop();
        process.exit(0);
      }
      if (keyStr === 'r' || keyStr === 'R') {
        await this.engine.lifecycle.discoverAndReconcile();
        await this.handleStartupModelReadiness();
        return;
      }
      if (keyStr === 's' || keyStr === 'S' || keyStr === 'c' || keyStr === 'C' || keyName === 'escape' || keyStr === '\x1b') {
        this.startupSelector = undefined;
        this.statusMessage = 'No models loaded. Control plane offline.';
        this.draw();
        return;
      }
      if (keyStr === 'd' || keyStr === 'D') {
        this.startupSelector = undefined;
        void this.submitCommand('/doctor');
        return;
      }
    } else if (this.startupSelector.mode === 'recovery_runtime') {
      if (keyStr === 'q' || keyStr === 'Q') {
        this.stop();
        process.exit(0);
      }
      if (keyStr === 'l' || keyStr === 'L') {
        this.startupSelector = undefined;
        void this.submitCommand('/launch lmstudio');
        return;
      }
      if (keyStr === 'r' || keyStr === 'R') {
        await this.engine.lifecycle.discoverAndReconcile();
        await this.handleStartupModelReadiness();
        return;
      }
      if (keyStr === 's' || keyStr === 'S' || keyStr === 'c' || keyStr === 'C' || keyName === 'escape' || keyStr === '\x1b') {
        this.startupSelector = undefined;
        this.statusMessage = 'Offline mode.';
        this.draw();
        return;
      }
    }
  }

  private async handleTaskTimeModalKey(keyStr: string, keyObj?: readline.Key): Promise<void> {
    if (!this.taskTimeModelRequired) return;
    const keyName = keyObj?.name;
    const modal = this.taskTimeModelRequired;

    if (modal.loading) {
      return;
    }

    if (keyName === 'up' || keyStr === '\u001b[A') {
      modal.selectedIndex = Math.max(0, modal.selectedIndex - 1);
      this.draw();
      return;
    }
    if (keyName === 'down' || keyStr === '\u001b[B') {
      modal.selectedIndex = Math.min(Math.max(0, modal.eligibleModels.length - 1), modal.selectedIndex + 1);
      this.draw();
      return;
    }
    if (keyStr === 'l' || keyStr === 'L' || keyName === 'return' || keyName === 'enter' || keyStr === '\r' || keyStr === '\n') {
      const m = modal.eligibleModels[modal.selectedIndex];
      if (m) {
        modal.loading = true;
        modal.statusText = `Loading ${m.id}...`;
        this.draw();
        const ok = await this.engine.lifecycle.loadModel(m.id, { initiator: 'task_safety_net' });
        if (ok) {
          const prompt = modal.pendingPrompt;
          this.taskTimeModelRequired = undefined;
          this.statusMessage = `Model '${m.id}' ready. Resuming task...`;
          await this.launchJobFromPrompt(prompt);
        } else {
          modal.loading = false;
          modal.statusText = `Failed to load ${m.id}. Try another model or press [M].`;
          this.draw();
        }
      }
      return;
    }
    if (keyStr === 'a' || keyStr === 'A') {
      const rec = this.engine.lifecycle.getRecommendedModels();
      const targetModel = rec[0]?.model ?? modal.eligibleModels[0];
      if (targetModel) {
        modal.loading = true;
        modal.statusText = `Loading recommended model ${targetModel.id}...`;
        this.draw();
        const ok = await this.engine.lifecycle.loadModel(targetModel.id, { initiator: 'task_safety_net' });
        if (ok) {
          const prompt = modal.pendingPrompt;
          this.taskTimeModelRequired = undefined;
          this.statusMessage = `Model '${targetModel.id}' ready. Resuming task...`;
          await this.launchJobFromPrompt(prompt);
        } else {
          modal.loading = false;
          modal.statusText = `Failed to load ${targetModel.id}. Try another model or press [M].`;
          this.draw();
        }
      }
      return;
    }
    if (keyStr === 'm' || keyStr === 'M') {
      this.openModelStartupSelector();
      return;
    }
    if (keyStr === 'd' || keyStr === 'D') {
      this.taskTimeModelRequired = undefined;
      void this.submitCommand('/doctor');
      return;
    }
    if (keyName === 'escape' || keyStr === '\x1b' || keyStr === 'c' || keyStr === 'C') {
      this.taskTimeModelRequired = undefined;
      this.statusMessage = 'Task cancelled. No models loaded.';
      this.draw();
      return;
    }
  }

  private renderStartupSelectorModal(cols: number): string[] {
    if (!this.startupSelector) return [];
    const selector = this.startupSelector;
    const modalWidth = Math.min(cols - 4, 88);

    if (selector.inspectedModelId) {
      const m = selector.allInstalledModels.find((it) => it.id === selector.inspectedModelId);
      if (!m) {
        selector.inspectedModelId = undefined;
        return this.renderStartupSelectorModal(cols);
      }
      const title = ` MODEL INSPECTION: ${m.id} `;
      const assessment = selector.resourceAssessments.get(m.id);
      const isReady = this.engine.lifecycle.isModelReady(m.id);
      const body: string[] = [
        `${color.bold('ID:')}            ${m.id}`,
        `${color.bold('Name:')}          ${m.name}`,
        `${color.bold('Provider:')}      ${m.provider}`,
        `${color.bold('Family:')}        ${m.family}`,
        `${color.bold('Architecture:')}  ${m.architecture ?? '—'}`,
        `${color.bold('Parameters:')}    ${m.parameters ?? '—'}`,
        `${color.bold('Quantization:')}  ${m.quantization ?? '—'}`,
        `${color.bold('Context Max:')}   ${m.contextMax.toLocaleString()} tokens`,
        `${color.bold('Capabilities:')}  ${m.capabilities.join(', ')}`,
        `${color.bold('Tool Calling:')}  ${m.toolCalling ? color.green('yes') : color.gray('no')}`,
        `${color.bold('Reasoning:')}     ${m.reasoning ? color.green('yes') : color.gray('no')}`,
        `${color.bold('Vision:')}        ${m.vision ? color.green('yes') : color.gray('no')}`,
        `${color.bold('State:')}         ${isReady ? color.green('READY') : color.yellow(this.engine.lifecycle.getModelState(m.id))}`,
        '',
        color.bold('Resource Assessment:'),
        `  Estimated Memory: ${assessment?.estimatedMemoryGB.toFixed(1) ?? '—'} GB [${assessment?.classification ?? 'UNKNOWN'}]`,
        `  Status:           ${assessment?.message ?? '—'}`,
      ];
      const actions = `${color.bold('[Esc]')} Back to Model Selection`;
      return this.buildModalBox(title, body, actions, modalWidth, 'cyan');
    }

    if (selector.mode === 'select') {
      const title = ' WAZIR - MODEL READINESS & STARTUP ';
      const readiness = this.engine.lifecycle.getReadiness();
      const healthyRuntimes = this.engine.runtimes.list().map((r) => r.name || r.id);
      const localComp = this.engine.computers.list().find((c) => c.local)?.name || 'local';

      const body: string[] = [
        `Runtime: ${color.bold(healthyRuntimes.join(', ') || 'none')}    Computer: ${color.bold(localComp)}`,
        `Status: ${color.green(`${readiness.readyCount} READY`)} / ${color.bold(`${readiness.installedCount} INSTALLED`)}`,
      ];
      if (selector.statusBanner) {
        body.push(color.yellow(`* ${selector.statusBanner}`));
      }
      body.push(color.gray('-'.repeat(modalWidth - 8)));
      body.push(color.bold(`Installed Models (${readiness.readyCount} loaded / ${readiness.installedCount} installed):`));
      body.push('');

      const models = selector.allInstalledModels;
      for (let i = 0; i < models.length; i++) {
        const m = models[i];
        const isSel = selector.selectedModelIds.has(m.id);
        const isEligible = selector.eligibleModels.some((e) => e.id === m.id);
        const isRec = selector.recommendedModelIds.has(m.id);
        const isHighlighted = i === selector.selectedIndex;
        const assessment = selector.resourceAssessments.get(m.id);
        const isReady = this.engine.lifecycle.isModelReady(m.id);

        const checkMark = isReady
          ? color.green('[✓]')
          : isSel
            ? color.cyan('[x]')
            : '[ ]';
        const cursor = isHighlighted ? color.blue('> ') : '  ';
        const namePart = isHighlighted ? color.blue(color.bold(m.id)) : color.bold(m.id);

        let badge = '';
        if (isReady) {
          badge = ` ${color.green('(ALREADY LOADED)')}`;
        } else if (isRec) {
          badge = ` ${color.cyan('[RECOMMENDED]')}`;
        } else if (!isEligible) {
          badge = ` ${color.gray('(non-generative)')}`;
        }

        body.push(`${cursor}${checkMark} ${i + 1}. ${namePart}${badge}`);

        const arch = m.architecture ? `Architecture: ${m.architecture}  ` : '';
        const params = m.parameters ? `Params: ${m.parameters}  ` : '';
        const ctx = `Context: ${Math.round(m.contextMax / 1024)}K`;
        body.push(`       ${color.gray(`${arch}${params}${ctx}`)}`);

        if (assessment) {
          let classTag = color.gray(`[${assessment.classification}]`);
          if (assessment.classification === 'SAFE') classTag = color.green('[SAFE]');
          else if (assessment.classification === 'WARNING') classTag = color.yellow('[WARNING]');
          else if (assessment.classification === 'INSUFFICIENT') classTag = color.red('[INSUFFICIENT]');
          body.push(`       ${color.gray(`Memory: ~${assessment.estimatedMemoryGB.toFixed(1)} GB`)} ${classTag}`);
        }

        if (isRec) {
          const recPurpose = m.toolCalling ? 'coding / tool execution' : 'planning / reasoning';
          body.push(`       ${color.cyan(`RECOMMENDED for ${recPurpose}`)}`);
        }
        body.push('');
      }

      const actions = `${color.bold('[Enter]')} Load Selected   ${color.bold('[A]')} Recommended   ${color.bold('[L]')} All   ${color.bold('[R]')} Refresh   ${color.bold('[I]')} Inspect   ${color.bold('[S]')} Skip`;
      return this.buildModalBox(title, body, actions, modalWidth, 'cyan');
    }

    if (selector.mode === 'loading') {
      const title = ' WAZIR - LOADING MODELS ';
      const body: string[] = [
        color.bold('Loading selected models into runtime memory:'),
        '',
      ];
      for (const id of selector.selectedModelIds) {
        const st = selector.loadStatuses.get(id) ?? 'LOADING';
        if (st === 'READY') {
          body.push(`  ${color.green('✓')} ${color.bold(id)} .......... ${color.green('READY')}`);
        } else if (st === 'FAILED') {
          const err = selector.loadErrors.get(id) ?? 'load failed';
          body.push(`  ${color.red('✕')} ${color.bold(id)} .......... ${color.red('FAILED')} (${err})`);
        } else {
          const frame = getCategorySpinnerFrame('JOBS', this.spinnerTick);
          body.push(`  ${color.cyan(frame)} ${color.bold(id)} ... ${color.yellow('LOADING')}`);
        }
      }
      body.push('');
      body.push(color.gray('Please wait while weights are placed into memory...'));
      const actions = color.gray('Loading in progress...');
      return this.buildModalBox(title, body, actions, modalWidth, 'yellow');
    }

    if (selector.mode === 'failure') {
      const title = ' WAZIR - MODEL LOAD FAILURE ';
      const body: string[] = [
        color.bold(color.red('One or more models failed to load:')),
        '',
      ];
      for (const [id, st] of selector.loadStatuses.entries()) {
        if (st === 'READY') {
          body.push(`  ${color.green('✓')} ${id} ... READY`);
        } else if (st === 'FAILED') {
          const err = selector.loadErrors.get(id) ?? 'failed';
          body.push(`  ${color.red('✕')} ${id} ... ${color.red('FAILED')} (${err})`);
        }
      }
      body.push('');
      body.push(color.gray('Choose how to proceed:'));
      const actions = `${color.bold('[R]')} Retry failed   ${color.bold('[C]')} Continue with available   ${color.bold('[B]')} Back to selection`;
      return this.buildModalBox(title, body, actions, modalWidth, 'red');
    }

    if (selector.mode === 'recovery_no_models') {
      const title = ' WAZIR - MODEL SETUP & RECOVERY ';
      const body: string[] = [
        color.bold(color.yellow('0 models discovered across all runtimes.')),
        '',
        'No models are currently installed in Ollama or LM Studio.',
        '',
        color.bold('Next steps:'),
        '  1. In LM Studio: Download a model (e.g. google/gemma-4-12b-qat or qwen/qwen3.8-27b).',
        '  2. In Ollama: Run \'ollama pull qwen2.5-coder\' in terminal.',
        '  3. Ensure the runtime server is running.',
      ];
      const actions = `${color.bold('[R]')} Refresh Discovery   ${color.bold('[S]')} Skip to Fleet   ${color.bold('[D]')} Run wa doctor`;
      return this.buildModalBox(title, body, actions, modalWidth, 'yellow');
    }

    if (selector.mode === 'recovery_runtime') {
      const title = ' WAZIR - RUNTIME RECOVERY ';
      const body: string[] = [
        color.bold(color.red('All local model runtimes are currently unavailable.')),
        '',
        '  - LM Studio: http://localhost:1234 (OFFLINE / UNREACHABLE)',
        '  - Ollama:    http://localhost:11434 (OFFLINE / UNREACHABLE)',
        '',
        color.bold('Recovery options:'),
        '  - Press [L] to start LM Studio server automatically via CLI',
        '  - Ensure LM Studio or Ollama is started in your environment',
      ];
      const actions = `${color.bold('[L]')} Launch LM Studio   ${color.bold('[R]')} Refresh Detection   ${color.bold('[S]')} Skip to Fleet`;
      return this.buildModalBox(title, body, actions, modalWidth, 'red');
    }

    return [];
  }

  private renderTaskTimeModelRequiredModal(cols: number): string[] {
    if (!this.taskTimeModelRequired) return [];
    const modal = this.taskTimeModelRequired;
    const modalWidth = Math.min(cols - 4, 82);
    const title = ' TASK-TIME MODEL REQUIRED ';

    const body: string[] = [
      color.bold(color.yellow('No ready models are available to execute this task.')),
      `${color.bold('Task:')} "${modal.pendingPrompt.slice(0, 50)}"`,
      `${color.bold('Required capability:')} ${modal.requiredCapabilities.join(', ')}`,
      '',
      color.bold('Eligible installed models:'),
    ];

    const recommended = this.engine.lifecycle.getRecommendedModels();
    const recIds = new Set(recommended.map((r) => r.model.id));

    for (let i = 0; i < modal.eligibleModels.length; i++) {
      const m = modal.eligibleModels[i];
      const isSel = i === modal.selectedIndex;
      const cursor = isSel ? color.blue('> ') : '  ';
      const namePart = isSel ? color.blue(color.bold(m.id)) : color.bold(m.id);
      const isRec = recIds.has(m.id);
      const recBadge = isRec ? color.cyan(' [RECOMMENDED]') : '';
      body.push(`${cursor}${i + 1}. ${namePart} (${m.provider})${recBadge}`);
    }

    if (modal.statusText) {
      body.push('');
      body.push(color.yellow(`Status: ${modal.statusText}`));
    }

    const actions = `${color.bold('[L]')} Load Model   ${color.bold('[A]')} Load Recommended   ${color.bold('[M]')} Manage Models   ${color.bold('[Esc]')} Cancel`;
    return this.buildModalBox(title, body, actions, modalWidth, 'yellow');
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
   * Dedicated Solution Search Projection Pane (§22)
   * Displays solution search trajectories, candidate states, qualification, and selection.
   */
  private renderSearchPane(cols: number, maxRows: number): string[] {
    const lines: string[] = [];
    const searches = this.engine.solutionSearch.listSearches();
    const activeSearch = searches[searches.length - 1];

    if (!activeSearch) {
      lines.push(color.bold(color.cyan('  SOLUTION SEARCH: No active searches')));
      lines.push(color.gray('  Run a search with: wa search run "<objective>" --candidates 3'));
      while (lines.length < maxRows) lines.push('');
      return lines;
    }

    lines.push(color.bold(color.cyan(`  SEARCH: ${activeSearch.searchId} (${activeSearch.status})`)));
    lines.push(color.gray(`  Candidates ${activeSearch.candidates.length}/${activeSearch.totalCandidates} | Strategy: ${activeSearch.strategy}`));
    lines.push('');

    for (const c of activeSearch.candidates) {
      const model = c.descriptor.modelId ?? 'default';
      const statusColor = c.status === 'completed' ? color.green : c.status === 'running' ? color.yellow : color.red;
      const qTag = c.evaluation?.qualifies ? color.green('QUALIFIED') : c.evaluation ? color.red('DISQUALIFIED') : color.gray('PENDING');
      lines.push(`  ${c.candidateId.padEnd(10)} ${model.padEnd(14)} ${statusColor(c.status.toUpperCase().padEnd(12))} [${qTag}]`);
      if (c.evaluation?.disqualificationReasons?.length) {
        lines.push(`    ${color.gray(c.evaluation.disqualificationReasons.join(', ').slice(0, cols - 6))}`);
      }
    }

    lines.push('');
    lines.push(`  Qualified: ${color.green(String(activeSearch.qualifyingCandidates.length))}  Failed: ${color.red(String(activeSearch.disqualifiedCandidates.length))}  Running: ${activeSearch.status === 'running' ? 1 : 0}`);
    lines.push(`  Selection: ${activeSearch.selectedCandidate ? color.bold(color.green(activeSearch.selectedCandidate.candidateId)) : color.yellow('pending')}`);
    if (activeSearch.selectionReason) {
      lines.push(`  Decision: ${color.gray(activeSearch.selectionReason.slice(0, cols - 14))}`);
    }

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
      '    /compact [id]   Compact model context for active or specified task',
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
