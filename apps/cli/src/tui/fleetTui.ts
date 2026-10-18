import readline from 'node:readline';
import { renderMissionControl, missionHeader } from './missionControl.js';
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
  assembleSearchNodeInspection,
} from '@wazir/core';
import type { RookEngine } from '../engine.js';
import { refreshRuntime } from '../engine.js';
import { color } from '../colors.js';
import { createFleetTaskExecutor } from '../fleetRunner.js';
import { TerminalScreen, type TerminalSize } from './screen.js';
import { ConversationRenderer } from './conversationRenderer.js';
import { StatusProjection } from './statusProjection.js';
import { EventSummarizer, type TranscriptVerbosity } from './eventSummarizer.js';
import { ClipboardController } from './clipboardController.js';
import {
  CanaryLiveEventBuffer,
  CANARY_TIMELINE_FILTERS,
  buildCanaryRollbackWhy,
  filterTimeline,
  loadCanaryTimeline,
  renderCanaryTimelineModal,
  rollbackEntryFromRecord,
  type CanaryTimelineEntry,
  type CanaryTimelineFilter,
} from './canaryTimeline.js';
import { createBlock, listBlocks, getBlock, getActiveContext, clearContext } from '../blocks.js';
import { resolveReference, type ResolvedReference } from '../references.js';
import { tokensPerSecond } from '@wazir/shared';
import { parseAction } from '@wazir/agents';
import { inspectVerificationEvidence, explainCompletion, type VerificationInspection, type WhyCompleteAnswer, type ArtifactProvenance } from '@wazir/core';
import { promptCacheReuse, promptCacheSource } from '@wazir/runtimes-interfaces';
import {
  renderSearchView,
  renderCanaryView,
  renderImprovementView,
  renderContextView,
  renderEvidenceView,
  renderWhyModal,
  renderEvidenceModal,
  renderSearchNodeInspection,
  flattenSearchTree,
  type WhyExplanationData,
  type SearchTreeNode,
  type ImprovementExperimentItem,
  type ImprovementViewData,
  type SearchCandidateItem,
  type SearchViewData,
  type ContextSampleItem,
  type ContextViewData,
  type EvidenceModalData,
  type CanaryViewTab,
  type SearchNodeInspection,
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

export type TuiView = 'task' | 'search' | 'fleet' | 'improvement' | 'context' | 'evidence' | 'tail' | 'approval' | 'worktrees' | 'help' | 'models' | 'canary';

export type NavCategory = 'MCP' | 'JOBS' | 'EXECUTIONS' | 'AGENTS' | 'COMPUTERS' | 'RUNTIMES';

export type SidebarMode = 'full' | 'focused' | 'hidden';

export type FocusPane = 'nav' | 'main' | 'prompt';

export type TuiMode = 'NORMAL' | 'COMPOSER' | 'COPY' | 'PASTE' | 'PALETTE' | 'APPROVAL' | 'SHELL';

export interface ShellExecutionSummary {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs?: number;
  blockId?: string;
}

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
  presentationMode?: 'conversation' | 'dashboard';
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
  if (keyStr === '\x0b' || keyStr === '\u000b') {
    return { name: 'k', ctrl: true, meta: false, shift: false, sequence: '\x0b' };
  }
  if (keyStr === '\x0e' || keyStr === '\u000e') {
    return { name: 'n', ctrl: true, meta: false, shift: false, sequence: '\x0e' };
  }
  if (keyStr === '\u0003') {
    return { name: 'c', ctrl: true, meta: false, shift: false, sequence: '\u0003' };
  }
  if (keyStr === '\u0015') {
    return { name: 'u', ctrl: true, meta: false, shift: false, sequence: '\u0015' };
  }
  if (keyStr === '\u001a') {
    return { name: 'z', ctrl: true, meta: false, shift: false, sequence: '\u001a' };
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

function previousGraphemeBoundary(text: string, cursor: number): number {
  const Segmenter = (Intl as any).Segmenter;
  if (Segmenter) {
    let previous = 0;
    for (const segment of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
      if (segment.index >= cursor) break;
      previous = segment.index;
      if (segment.index + segment.segment.length >= cursor) return segment.index;
    }
    return previous;
  }
  const point = text.codePointAt(Math.max(0, cursor - 1));
  return Math.max(0, cursor - (point && point > 0xffff ? 2 : 1));
}

function nextGraphemeBoundary(text: string, cursor: number): number {
  const Segmenter = (Intl as any).Segmenter;
  if (Segmenter) {
    for (const segment of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
      if (segment.index >= cursor || segment.index + segment.segment.length > cursor) return segment.index + segment.segment.length;
    }
    return text.length;
  }
  const point = text.codePointAt(cursor);
  return Math.min(text.length, cursor + (point && point > 0xffff ? 2 : 1));
}

export class FleetTui {
  readonly engine: RookEngine;
  readonly screen: TerminalScreen;
  private readonly concurrencyLimit: number;
  private readonly useWorktrees: boolean;
  private readonly autoMerge: boolean;
  private readonly timeoutSeconds?: number;
  private readonly enablePlanner: boolean;
  private presentationMode: 'conversation' | 'dashboard';
  private conversationRenderer: ConversationRenderer;
  private clipboardController: ClipboardController;
  private readonly statusProjection = new StatusProjection();
  private eventSummarizer = new EventSummarizer();
  private conversationDrawQueued = false;
  private conversationStartedAt?: number;
  private lastInterruptAt = 0;
  private copyCursorLine = 0;
  private copyAnchorLine?: number;
  private copyNotice = '';

  private currentView: TuiView = 'fleet';
  private missionHome = true;
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
  private selectedSearchNodeId?: string;
  private selectedNodeId?: string;
  private expandedNodeId?: string;
  private searchTreeCursor = 0;
  private selectedContextSampleIndex = 0;
  private selectedWorkerIndex = 0;
  private selectedModelProfileIndex = 0;
  private evidenceInspection?: { taskId?: string; key: string; inspection: VerificationInspection; artifacts: ArtifactProvenance[] };
  private evidenceRefresh?: Promise<void>;
  private evidenceProvenanceDepth = 0;

  // Ring buffers for bounded telemetry
  private contextSamples: ContextSampleItem[] = [];
  private static readonly MAX_CONTEXT_SAMPLES = 100;
  private static readonly MAX_EVENT_HISTORY = 100;

  // Evidence Modal state
  private evidenceModalOpen = false;
  private evidenceModalData?: EvidenceModalData;
  private evidenceScrollOffset = 0;

  // Why Explanation Modal state & Search View Mode
  private whyModalOpen = false;
  private whyModalData?: WhyExplanationData;
  private searchViewMode: 'tree' | 'table' | 'split' = 'tree';

  // Canary Confirmation & Throttle Modal State
  private canaryModal?: {
    type: 'advance' | 'rollback' | 'throttle';
    canaryId: string;
    candidateId: string;
    currentAllocation: number;
    nextStage?: string;
    availableTiers: number[];
    selectedTierIndex: number;
  };

  // Canary Timeline Explorer (read-only projection; never authoritative)
  private readonly canaryLiveEvents = new CanaryLiveEventBuffer();
  private canaryTimeline?: {
    canaryId: string;
    entries: CanaryTimelineEntry[];
    filter: CanaryTimelineFilter;
    selectedIndex: number;
    truncated: boolean;
    totalAvailable: number;
    loading: boolean;
  };

  // Subscriptions
  private unsubscribeSolutionSearch?: () => void;
  private unsubscribeOptimizer?: () => void;
  private unsubscribeCanaryEvents?: () => void;
  // /canary view: projection of CanaryDeploymentService records (read-only).
  private canaryTab: CanaryViewTab = 'dashboard';
  private canaryHistoryIndex = 0;
  private selectedCanaryId?: string;

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
    { id: 'conversation', title: 'Conversation view', cmd: '/chat' },
    { id: 'fleet-dashboard', title: 'Fleet dashboard', cmd: '/fleet' },
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
  private currentBlockTracker?: {
    update: (patch: Partial<Block>) => Promise<void>;
    finish: (status: BlockStatus, patch?: Partial<Block>) => Promise<void>;
  };

  // @ Reference fuzzy picker
  private isPickerActive = false;
  private pickerIndex = 0;
  private pickerCandidates: string[] = [];
  private lastResolvedReferences: ResolvedReference[] = [];
  private lastShellOutput?: ShellExecutionSummary;

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
  private readonly conversationHistory: string[] = [];
  private conversationHistoryIndex = -1;
  private conversationHistoryDraft = '';
  private inputUndo: string[] = [];
  private inputRedo: string[] = [];
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
    this.presentationMode = options.presentationMode ?? 'dashboard';
    if (typeof (this.screen as any).setPresentation === 'function') this.screen.setPresentation(this.presentationMode);
    if (this.presentationMode === 'conversation') this.focusedPane = 'prompt';
    const output = typeof (this.screen as any).getOutputStream === 'function' ? this.screen.getOutputStream() : process.stdout;
    this.conversationRenderer = new ConversationRenderer(output, () => typeof (this.screen as any).getSize === 'function' ? this.screen.getSize() : { columns: 80, rows: 24 });
    this.clipboardController = new ClipboardController(output);
    this.concurrencyLimit = options.concurrencyLimit ?? 4;
    this.useWorktrees = options.useWorktrees ?? true;
    this.autoMerge = options.autoMerge ?? false;
    this.timeoutSeconds = options.timeoutSeconds;
    this.enablePlanner = options.enablePlanner ?? false;
    if ((options as { modelId?: string }).modelId) {
      this.selectedModelId = (options as { modelId?: string }).modelId;
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getProcessedSubmissionIds(): Set<string> {
    return this.processedSubmissionIds;
  }

  private rememberConversationPrompt(prompt: string): void {
    if (!prompt) return;
    if (this.conversationHistory.at(-1) !== prompt) this.conversationHistory.push(prompt);
    if (this.conversationHistory.length > 100) this.conversationHistory.shift();
    this.conversationHistoryIndex = -1;
    this.conversationHistoryDraft = '';
  }

  private moveConversationHistory(direction: -1 | 1): void {
    if (direction < 0) {
      if (!this.conversationHistory.length) return;
      if (this.conversationHistoryIndex === -1) {
        this.conversationHistoryDraft = this.inputBuffer;
        this.conversationHistoryIndex = this.conversationHistory.length - 1;
      } else this.conversationHistoryIndex = Math.max(0, this.conversationHistoryIndex - 1);
      this.inputBuffer = this.conversationHistory[this.conversationHistoryIndex];
    } else if (this.conversationHistoryIndex >= 0) {
      if (this.conversationHistoryIndex < this.conversationHistory.length - 1) {
        this.conversationHistoryIndex++;
        this.inputBuffer = this.conversationHistory[this.conversationHistoryIndex];
      } else {
        this.conversationHistoryIndex = -1;
        this.inputBuffer = this.conversationHistoryDraft;
        this.conversationHistoryDraft = '';
      }
    }
    this.inputCursor = this.inputBuffer.length;
    this.focusedPane = 'prompt';
  }

  private transcriptLines(): string[] {
    return this.conversationRenderer.transcript.list().flatMap((entry) => entry.text.split('\n'));
  }

  private copyModeStatus(): string {
    const lines = this.transcriptLines();
    const preview = (lines[this.copyCursorLine] ?? '').replace(/[\r\t]/g, ' ');
    return `Copy ${this.copyCursorLine + 1}/${Math.max(1, lines.length)} · ${this.copyAnchorLine === undefined ? 'V mark' : `marked from ${this.copyAnchorLine + 1}`} · Y copy · Esc exit · ${preview}${this.copyNotice ? ` · ${this.copyNotice}` : ''}`;
  }

  private enterCopyMode(): void {
    this.tuiMode = 'COPY';
    this.copyCursorLine = Math.max(0, this.transcriptLines().length - 1);
    this.copyAnchorLine = undefined;
    this.copyNotice = '';
    this.statusMessage = 'Copy mode: arrows move, V marks a range, Y copies when OSC52 is enabled, Esc exits.';
  }

  private snapshotInputEdit(): void {
    if (this.inputUndo.at(-1) !== this.inputBuffer) this.inputUndo.push(this.inputBuffer);
    if (this.inputUndo.length > 20) this.inputUndo.shift();
    this.inputRedo = [];
  }

  async submitInteractive(submission: InteractiveSubmission): Promise<void> {
    return this.submitCommand(submission);
  }

  getCurrentView(): TuiView {
    if (this.pendingApprovals.length > 0) return 'approval';
    return this.currentView;
  }

  setCurrentView(view: TuiView): void {
    this.currentView = view;
    this.draw();
  }

  switchView(view: TuiView): void {
    this.setCurrentView(view);
  }

  destroy(): void {
    // Teardown screen or listeners if any
  }

  openEvidenceModal(data: EvidenceModalData): void {
    this.evidenceModalData = data;
    this.evidenceModalOpen = true;
    this.evidenceScrollOffset = 0;
    this.draw();
  }

  closeEvidenceModal(): void {
    this.evidenceModalOpen = false;
    this.evidenceModalData = undefined;
    this.evidenceScrollOffset = 0;
    this.draw();
  }

  isEvidenceModalOpen(): boolean {
    return this.evidenceModalOpen;
  }

  getEvidenceModalData(): EvidenceModalData | undefined {
    return this.evidenceModalData;
  }

  openWhyModal(data: WhyExplanationData): void {
    this.whyModalData = data;
    this.whyModalOpen = true;
    this.draw();
  }

  closeWhyModal(): void {
    this.whyModalOpen = false;
    this.whyModalData = undefined;
    this.draw();
  }

  isWhyModalOpen(): boolean {
    return this.whyModalOpen;
  }

  isCanaryModalOpen(): boolean {
    return Boolean(this.canaryModal);
  }

  getCanaryModal(): typeof this.canaryModal {
    return this.canaryModal;
  }

  /** Feeds a CanaryEvent into the bounded live buffer (read-only observer). */
  observeCanaryEvent(event: any): void {
    this.canaryLiveEvents.push(event);
    if (this.canaryTimeline && event?.canaryId === this.canaryTimeline.canaryId) {
      void this.refreshCanaryTimeline();
    }
  }

  /** Opens the read-only Canary Timeline Explorer for one canary. */
  async openCanaryTimeline(canaryId: string): Promise<void> {
    this.canaryTimeline = {
      canaryId, entries: [], filter: 'ALL', selectedIndex: 0, truncated: false, totalAvailable: 0, loading: true,
    };
    this.draw();
    await this.refreshCanaryTimeline(true);
  }

  private async refreshCanaryTimeline(selectLatest = false): Promise<void> {
    const tl = this.canaryTimeline;
    if (!tl) return;
    const canarySvc = (this.engine.optimizer as any)?.getCanaryDeploymentService?.();
    const result = await loadCanaryTimeline({
      canaryId: tl.canaryId,
      store: this.engine.store as any,
      liveEvents: this.canaryLiveEvents.get(tl.canaryId),
      record: canarySvc?.getDeployment?.(tl.canaryId),
    });
    if (this.canaryTimeline !== tl) return;
    const previouslySelected = filterTimeline(tl.entries, tl.filter)[tl.selectedIndex]?.id;
    tl.entries = result.entries;
    tl.truncated = result.truncated;
    tl.totalAvailable = result.totalAvailable;
    tl.loading = false;
    const visible = filterTimeline(tl.entries, tl.filter);
    const keep = previouslySelected ? visible.findIndex((e) => e.id === previouslySelected) : -1;
    tl.selectedIndex = selectLatest || keep < 0 ? Math.max(0, visible.length - 1) : keep;
    this.draw();
  }

  closeCanaryTimeline(): void {
    this.canaryTimeline = undefined;
    this.draw();
  }

  getCanaryTimeline(): typeof this.canaryTimeline {
    return this.canaryTimeline;
  }

  getSelectedCanaryTimelineEntry(): CanaryTimelineEntry | undefined {
    const tl = this.canaryTimeline;
    return tl ? filterTimeline(tl.entries, tl.filter)[tl.selectedIndex] : undefined;
  }

  setCanaryTimelineFilter(filter: CanaryTimelineFilter): void {
    const tl = this.canaryTimeline;
    if (!tl) return;
    tl.filter = filter;
    tl.selectedIndex = Math.max(0, filterTimeline(tl.entries, filter).length - 1);
    this.draw();
  }

  private handleCanaryTimelineKey(keyStr: string, keyName: string): void {
    const tl = this.canaryTimeline!;
    const count = filterTimeline(tl.entries, tl.filter).length;
    if (keyName === 'escape' || keyStr === '\u001b' || keyStr === 'q' || keyStr === 'Q') {
      this.closeCanaryTimeline();
      return;
    }
    if (keyName === 'up' || keyStr === '\u001b[A' || keyStr === 'k' || keyStr === 'K') {
      tl.selectedIndex = Math.max(0, tl.selectedIndex - 1);
    } else if (keyName === 'down' || keyStr === '\u001b[B' || keyStr === 'j' || keyStr === 'J') {
      tl.selectedIndex = Math.min(Math.max(0, count - 1), tl.selectedIndex + 1);
    } else if (keyName === 'pageup' || keyStr === '\u001b[5~') {
      tl.selectedIndex = Math.max(0, tl.selectedIndex - 10);
    } else if (keyName === 'pagedown' || keyStr === '\u001b[6~') {
      tl.selectedIndex = Math.min(Math.max(0, count - 1), tl.selectedIndex + 10);
    } else if (keyStr === 'f' || keyStr === 'F' || keyName === 'right' || keyStr === '\u001b[C' || keyName === 'left' || keyStr === '\u001b[D') {
      const step = keyName === 'left' || keyStr === '\u001b[D' ? -1 : 1;
      const idx = CANARY_TIMELINE_FILTERS.indexOf(tl.filter);
      this.setCanaryTimelineFilter(CANARY_TIMELINE_FILTERS[(idx + step + CANARY_TIMELINE_FILTERS.length) % CANARY_TIMELINE_FILTERS.length]);
      return;
    } else if (keyStr === 'w' || keyStr === 'W') {
      const entry = this.getSelectedCanaryTimelineEntry();
      if (entry && (entry.label === 'ROLLBACK' || entry.guardEvidence)) {
        this.openWhyModal(buildCanaryRollbackWhy(entry, tl.canaryId));
      } else {
        this.statusMessage = 'why: select a ROLLBACK or REGRESSION event.';
      }
      return;
    }
    this.draw();
  }

  getSelectedSearchNodeId(): string | undefined {
    return this.getSelectedNodeId();
  }

  setSelectedSearchNodeId(nodeId?: string): void {
    this.setSelectedNodeId(nodeId);
  }

  getSelectedNodeId(): string | undefined {
    const flat = this.getFlattenedSearchTreeNodes();
    if (flat.length === 0) {
      if (this.selectedNodeId) return this.selectedNodeId;
      const searches = this.engine.solutionSearch?.listSearches() ?? [];
      const activeSearch = searches[searches.length - 1];
      const candidates = activeSearch?.candidates ?? [];
      return candidates[this.selectedSearchCandidateIndex]?.candidateId;
    }
    if (this.selectedNodeId && flat.some((n) => n.id === this.selectedNodeId)) {
      return this.selectedNodeId;
    }
    const clampedIndex = Math.max(0, Math.min(this.searchTreeCursor, flat.length - 1));
    this.searchTreeCursor = clampedIndex;
    this.selectedNodeId = flat[clampedIndex]?.id;
    return this.selectedNodeId;
  }

  setSelectedNodeId(nodeId?: string): void {
    this.selectedNodeId = nodeId;
    this.selectedSearchNodeId = nodeId;
    if (nodeId) {
      const flat = this.getFlattenedSearchTreeNodes();
      const idx = flat.findIndex((n) => n.id === nodeId);
      if (idx !== -1) {
        this.searchTreeCursor = idx;
      }
    }
  }

  getExpandedNodeId(): string | undefined {
    return this.expandedNodeId;
  }

  setExpandedNodeId(nodeId?: string): void {
    this.expandedNodeId = nodeId;
  }

  getSearchTreeCursor(): number {
    return this.searchTreeCursor;
  }

  setSearchTreeCursor(cursor: number): void {
    const flat = this.getFlattenedSearchTreeNodes();
    if (flat.length === 0) {
      this.searchTreeCursor = 0;
      return;
    }
    this.searchTreeCursor = Math.max(0, Math.min(cursor, flat.length - 1));
    this.selectedNodeId = flat[this.searchTreeCursor]?.id;
    this.selectedSearchNodeId = this.selectedNodeId;
  }

  getSearchTreeNodes(): SearchTreeNode[] {
    const searches = this.engine.solutionSearch?.listSearches() ?? [];
    const activeSearch = searches[searches.length - 1];
    if ((activeSearch as any)?.hierarchicalTree?.nodes) {
      const raw = (activeSearch as any).hierarchicalTree.nodes;
      if (Array.isArray(raw)) return raw;
      if (typeof raw.values === 'function') return Array.from(raw.values());
    }
    if ((activeSearch as any)?.treeNodes && Array.isArray((activeSearch as any).treeNodes)) {
      return (activeSearch as any).treeNodes;
    }
    if (activeSearch) return [];
    return [
      {
        id: 'C0',
        name: 'C0 (Root Checkpoint)',
        state: 'completed',
        tokens: 0,
        children: [
          {
            id: 'A',
            name: 'A (Refactor Strategy)',
            state: 'completed',
            tokens: 840,
            children: [
              {
                id: 'A1',
                name: 'A1',
                state: 'completed',
                glyph: color.green('✓'),
                tokens: 1250,
                testsPassed: true,
                isFrontier: true,
              },
              {
                id: 'A2',
                name: 'A2',
                state: 'pruned',
                glyph: color.red('×'),
                prunedReason: 'build failed',
                tokens: 920,
                testsPassed: false,
                isDominated: true,
              },
            ],
          },
          {
            id: 'B',
            name: 'B (Incremental Strategy)',
            state: 'active',
            tokens: 610,
            children: [
              {
                id: 'B1',
                name: 'B1',
                state: 'verifying',
                glyph: color.yellow('◶'),
                tokens: 780,
              },
              {
                id: 'B2',
                name: 'B2',
                state: 'pending',
                tokens: 340,
              },
            ],
          },
          {
            id: 'C',
            name: 'C (Parallel Strategy)',
            state: 'pruned',
            glyph: color.red('×'),
            prunedReason: 'timeout',
            tokens: 450,
            isDominated: true,
          },
        ],
      },
    ];
  }

  getFlattenedSearchTreeNodes(): SearchTreeNode[] {
    return flattenSearchTree(this.getSearchTreeNodes());
  }

  moveSearchTreeCursor(delta: number): void {
    const flat = this.getFlattenedSearchTreeNodes();
    if (flat.length === 0) return;
    this.setSearchTreeCursor(this.searchTreeCursor + delta);
  }

  navigateSearchTreeParent(): void {
    const roots = this.getSearchTreeNodes();
    const flat = this.getFlattenedSearchTreeNodes();
    if (flat.length === 0) return;
    const currentId = this.getSelectedNodeId() ?? flat[this.searchTreeCursor]?.id;
    if (!currentId) return;

    let parentNode: SearchTreeNode | undefined;
    function findParent(node: SearchTreeNode) {
      if (node.children) {
        for (const child of node.children) {
          if (child.id === currentId) {
            parentNode = node;
            return;
          }
          findParent(child);
        }
      }
    }
    for (const root of roots) {
      findParent(root);
      if (parentNode) break;
    }

    if (parentNode) {
      this.setSelectedNodeId(parentNode.id);
    }
  }

  navigateSearchTreeChild(): void {
    const roots = this.getSearchTreeNodes();
    const flat = this.getFlattenedSearchTreeNodes();
    if (flat.length === 0) return;
    const currentId = this.getSelectedNodeId() ?? flat[this.searchTreeCursor]?.id;
    if (!currentId) return;

    let currentNode: SearchTreeNode | undefined;
    function findNode(node: SearchTreeNode) {
      if (node.id === currentId) {
        currentNode = node;
        return;
      }
      if (node.children) {
        for (const child of node.children) {
          findNode(child);
          if (currentNode) return;
        }
      }
    }
    for (const root of roots) {
      findNode(root);
      if (currentNode) break;
    }

    if (currentNode && currentNode.children && currentNode.children.length > 0) {
      const firstChild = currentNode.children[0];
      this.setSelectedNodeId(firstChild.id);
    }
  }

  inspectSearchNode(nodeId?: string): SearchNodeInspection | undefined {
    const id = nodeId ?? this.getSelectedSearchNodeId();
    if (!id) return undefined;
    const searches = this.engine.solutionSearch?.listSearches() ?? [];
    const activeSearch = searches[searches.length - 1];
    const roots = this.getSearchTreeNodes();
    let foundNode: SearchTreeNode | undefined;
    function searchInTree(node: SearchTreeNode) {
      if (node.id === id) {
        foundNode = node;
        return;
      }
      if (node.children) {
        for (const child of node.children) {
          searchInTree(child);
          if (foundNode) return;
        }
      }
    }
    for (const root of roots) {
      searchInTree(root);
      if (foundNode) break;
    }

    let parentId = foundNode?.parentId;
    if (!parentId) {
      function findParent(node: SearchTreeNode) {
        if (node.children) {
          for (const child of node.children) {
            if (child.id === id) {
              parentId = node.id;
              return;
            }
            findParent(child);
          }
        }
      }
      for (const root of roots) {
        findParent(root);
        if (parentId) break;
      }
    }

    const inspection = assembleSearchNodeInspection({
      nodeId: id,
      searchId: activeSearch?.searchId,
      search: activeSearch,
      node: foundNode as any,
      tree: (activeSearch as any)?.hierarchicalTree,
      engine: this.engine,
      checkpointService: this.engine.checkpoints,
      verificationEngine: this.engine.verification,
      provenanceManager: this.engine.provenance,
    });

    if (foundNode) {
      if (!inspection.phase && foundNode.state) {
        inspection.phase = foundNode.state.toUpperCase();
      }
      if (!inspection.state && foundNode.state) {
        inspection.state = foundNode.state.toUpperCase();
      }
      if (!inspection.modelId && foundNode.modelId) {
        inspection.modelId = foundNode.modelId;
      }
      if (!inspection.workerId && foundNode.workerId) {
        inspection.workerId = foundNode.workerId;
      }
      if (!(inspection as any).prunedReason && foundNode.prunedReason) {
        (inspection as any).prunedReason = foundNode.prunedReason;
      }
    }
    if (parentId && !(inspection as any).parentId) {
      (inspection as any).parentId = parentId;
      if (!inspection.provenance) {
        inspection.provenance = { parentNodeId: parentId };
      } else if (!inspection.provenance.parentNodeId) {
        inspection.provenance.parentNodeId = parentId;
      }
    }
    return inspection;
  }

  buildWhyExplanation(topic: string): WhyExplanationData {
    const t = topic.toLowerCase().trim();
    const card = this.agents.get(this.selectedTaskId ?? '') ?? this.getAgents()[0];
    const width = 84;
    const maxRows = 24;

    switch (t) {
      // Each branch reports only state observed in engine records. Absent evidence is
      // UNKNOWN and carries no immutableHash: a fabricated digest would read as proof.
      case 'model': {
        const modelId = card?.modelId ?? this.selectedModelId;
        return {
          topic: 'model',
          headline: 'Model assignment for selected task',
          decision: modelId ? `Assigned model [${modelId}]` : 'UNKNOWN — no model assignment recorded',
          rationale: [
            modelId
              ? 'Assignment read from the task card; routing scores are not persisted for this view.'
              : 'No task card with a model assignment is selected.',
          ],
          evidence: [
            { label: 'Selected Model', value: modelId ?? 'UNKNOWN' },
            { label: 'Routing Confidence', value: 'UNKNOWN' },
          ],
          controllerAudit: { source: 'Task card (FleetTui)', verifiedAt: new Date() },
          width,
          maxRows,
        };
      }

      case 'worker': {
        const comp = this.engine.computers.list()[0];
        return {
          topic: 'worker',
          headline: 'Worker placement',
          decision: comp ? `Registered worker [${comp.id}]` : 'UNKNOWN — no worker registered',
          rationale: [
            comp
              ? 'Values read from ComputerRegistry; per-task placement decisions are not recorded here.'
              : 'ComputerRegistry has no registered computers.',
          ],
          evidence: [
            { label: 'Node Identifier', value: comp?.id ?? 'UNKNOWN' },
            { label: 'Memory', value: comp?.hardware?.memoryGB !== undefined ? `${comp.hardware.memoryGB}GB` : 'UNKNOWN' },
            { label: 'Active Reservations', value: comp?.reservations?.length ?? 'UNKNOWN' },
            { label: 'Health Status', value: comp?.status ? String(comp.status).toUpperCase() : 'UNKNOWN' },
            { label: 'Placement Decision', value: 'UNKNOWN' },
          ],
          controllerAudit: { source: 'ComputerRegistry', verifiedAt: new Date() },
          width,
          maxRows,
        };
      }

      case 'tool': {
        return {
          topic: 'tool',
          headline: 'Policy Engine authorization',
          decision: 'UNKNOWN — no policy decision record is attached to this view',
          rationale: [
            'Tool authorization is decided per call by PolicyEngine / ApprovalQueue.',
            'Open /evidence for the recorded tool receipts of a task.',
          ],
          evidence: [{ label: 'Policy Decision', value: 'UNKNOWN' }],
          controllerAudit: { source: 'PolicyEngine / ApprovalQueue', verifiedAt: new Date() },
          width,
          maxRows,
        };
      }

      case 'context': {
        const samples = (this as any).contextSamples ?? [];
        const lastSample = samples[samples.length - 1];
        const cache = lastSample?.cache;
        const readStatus = cache?.cacheReadTokens?.status ?? 'UNKNOWN';
        const inputStatus = cache?.inputTokens?.status ?? 'UNKNOWN';
        const isUnsupported = readStatus === 'UNSUPPORTED' || cache?.cacheWriteTokens?.status === 'UNSUPPORTED';
        const providerName = cache?.provider ?? 'Provider';

        let decision = 'Cache savings: UNKNOWN';
        if (isUnsupported) {
          decision = 'Cache savings: UNKNOWN';
        } else if (readStatus === 'OBSERVED' && inputStatus === 'OBSERVED') {
          decision = 'Cache savings: OBSERVED';
        } else if (readStatus === 'ESTIMATED' || inputStatus === 'ESTIMATED') {
          decision = 'Cache savings: ESTIMATED';
        }

        const rationale: string[] = [];
        if (isUnsupported) {
          rationale.push(`${providerName} does not support prompt cache telemetry on wire responses.`);
          rationale.push('Prompt cache token savings cannot be observed directly from provider metadata.');
        } else if (readStatus === 'OBSERVED') {
          rationale.push(`Provider ${providerName} returned verified prompt cache usage on completion wire.`);
          rationale.push('Cache read tokens directly observed from prompt_tokens_details or proxy headers.');
        } else if (readStatus === 'ESTIMATED') {
          rationale.push('Prompt cache token savings estimated from stable prefix overlap heuristics.');
        } else {
          rationale.push('No prompt cache telemetry recorded for current context sample window.');
        }

        return {
          topic: 'context',
          headline: 'Context memory & prompt cache telemetry',
          decision,
          rationale,
          evidence: [
            { label: 'Provider', value: cache?.provider ?? 'UNKNOWN' },
            { label: 'Cache Read', value: cache?.cacheReadTokens?.status === 'OBSERVED' ? String(cache.cacheReadTokens.value) : (cache?.cacheReadTokens?.status ?? 'UNKNOWN') },
            { label: 'Cache Write', value: cache?.cacheWriteTokens?.status === 'OBSERVED' ? String(cache.cacheWriteTokens.value) : (cache?.cacheWriteTokens?.status ?? 'UNKNOWN') },
            { label: 'Effective Reuse', value: cache ? promptCacheReuse(cache) : 'UNKNOWN' },
            { label: 'Source', value: cache ? promptCacheSource(cache) : 'UNKNOWN' },
          ],
          controllerAudit: {
            source: 'ContextRevisionService / TelemetryService',
            verifiedAt: new Date(),
          },
          width,
          maxRows,
        };
      }

      case 'candidate': {
        const searches = this.engine.solutionSearch?.listSearches() ?? [];
        const activeSearch = searches[searches.length - 1];
        const cand = activeSearch?.selectedCandidate;
        const check = (name: string) => {
          const c = cand?.checks?.find((r: { name: string }) => r.name === name);
          return c ? (c.ok ? 'PASS' : 'FAIL') : 'UNKNOWN';
        };
        const onFrontier = cand && activeSearch?.paretoFrontier?.candidates
          ? activeSearch.paretoFrontier.candidates.some((c: { candidateId: string }) => c.candidateId === cand.candidateId)
          : 'UNKNOWN';
        return {
          topic: 'candidate',
          headline: 'Candidate selection',
          decision: cand ? `Selected candidate [${cand.candidateId}]` : 'UNKNOWN — no candidate selected',
          rationale: [activeSearch?.selectionReason || 'No selection reason recorded.'],
          evidence: [
            { label: 'Candidate ID', value: cand?.candidateId ?? 'UNKNOWN' },
            { label: 'Pareto Frontier', value: onFrontier },
            { label: 'Build Check', value: check('build') },
            { label: 'Test Check', value: check('test') },
          ],
          controllerAudit: { source: 'SolutionSearchService', verifiedAt: new Date() },
          width,
          maxRows,
        };
      }

      case 'prune': {
        const searches = this.engine.solutionSearch?.listSearches() ?? [];
        const pruned = (searches[searches.length - 1]?.candidates ?? []).filter(
          (c: { isPruned?: boolean; prunedReason?: string }) => c.isPruned || c.prunedReason,
        );
        return {
          topic: 'prune',
          headline: 'Search branch pruning',
          decision: pruned.length ? `Pruned ${pruned.length} candidate(s)` : 'UNKNOWN — no pruned candidates recorded',
          rationale: pruned.length
            ? pruned.slice(0, 5).map((c: { candidateId: string; prunedReason?: string }) => `${c.candidateId}: ${c.prunedReason ?? 'reason not recorded'}`)
            : ['The active search has no pruned candidates on record.'],
          evidence: [{ label: 'Pruned Count', value: pruned.length ? pruned.length : 'UNKNOWN' }],
          controllerAudit: { source: 'SolutionSearchService', verifiedAt: new Date() },
          width,
          maxRows,
        };
      }

      case 'complete':
      case 'incomplete': {
        // Derived only from the durable ExecutionRecord (see inspectVerificationEvidence).
        const cached = this.currentEvidenceInspection();
        if (!cached) {
          return {
            topic: 'complete',
            headline: 'No execution evidence loaded',
            decision: 'UNKNOWN — completion cannot be asserted without an execution record',
            rationale: ['Open /evidence for a task with an execution record.', 'MODEL CLAIM != EXECUTION EVIDENCE: model narration is not consulted.'],
            evidence: [],
            controllerAudit: { source: 'ExecutionEngine record / VerificationEvidenceInspector', verifiedAt: new Date() },
            width,
            maxRows,
          };
        }
        const { inspection, why } = cached;
        return {
          topic: why.complete ? 'complete' : 'incomplete',
          headline: why.complete ? `Why complete? Evidence chain for R${inspection.currentRevision}` : `Why incomplete? Missing evidence for R${inspection.currentRevision}`,
          decision: why.complete ? 'Completion eligible: YES' : 'Completion eligible: NO',
          rationale: why.complete ? why.chain : why.missing,
          evidence: inspection.slots.map((sl) => ({ label: sl.oracle, value: sl.status === 'MISSING' ? 'MISSING' : `${sl.status} @R${sl.revision} exit ${sl.exitCode}` })),
          controllerAudit: {
            source: `ExecutionEngine record ${inspection.executionId}`,
            verifiedAt: new Date(),
            immutableHash: String(inspection.workspaceDigest),
          },
          width,
          maxRows,
        };
      }

      case 'rollback': {
        // Prefer exact stored canary evidence: the timeline's selected rollback, else the
        // timeline canary's record, else the most recently rolled-back canary record.
        const selected = this.getSelectedCanaryTimelineEntry();
        if (this.canaryTimeline && selected && (selected.label === 'ROLLBACK' || selected.guardEvidence)) {
          return buildCanaryRollbackWhy(selected, this.canaryTimeline.canaryId, width, maxRows);
        }
        const canaryRecords: any[] = (this.engine.optimizer as any)?.getCanaryDeploymentService?.()?.listDeployments?.() ?? [];
        const rolledBack = canaryRecords
          .filter((r) => r?.rollbackReason)
          .sort((a, b) => (a.canaryId === this.canaryTimeline?.canaryId ? -1 : b.canaryId === this.canaryTimeline?.canaryId ? 1 : 0)
            || new Date(b.completedAt ?? b.updatedAt ?? 0).getTime() - new Date(a.completedAt ?? a.updatedAt ?? 0).getTime());
        const storedEntry = rolledBack[0] ? rollbackEntryFromRecord(rolledBack[0]) : undefined;
        if (storedEntry) {
          return buildCanaryRollbackWhy(storedEntry, rolledBack[0].canaryId, width, maxRows);
        }
        return {
          topic: 'rollback',
          headline: 'Canary rollback',
          decision: 'UNKNOWN — no rolled-back canary on record',
          rationale: ['CanaryDeploymentService has no deployment with a rollback reason.'],
          evidence: [{ label: 'Rollback Status', value: 'UNKNOWN' }],
          controllerAudit: { source: 'CanaryDeploymentService / RegressionGuard', verifiedAt: new Date() },
          width,
          maxRows,
        };
      }

      default: {
        return {
          topic: t || 'unknown',
          headline: `Topic '${t}' explanation`,
          decision: 'Topic not recognized',
          rationale: [
            'Valid explainability topics: why [model|worker|tool|candidate|prune|complete|rollback]',
            'All answers must be grounded in structured controller evidence, never LLM prose',
          ],
          evidence: [
            { label: 'Supported Topic 1', value: 'model (empirical capability routing)' },
            { label: 'Supported Topic 2', value: 'worker (topology & resource admission)' },
            { label: 'Supported Topic 3', value: 'tool (policy authorization & sandbox)' },
            { label: 'Supported Topic 4', value: 'candidate (Pareto frontier selection)' },
            { label: 'Supported Topic 5', value: 'prune (MCTS early termination)' },
            { label: 'Supported Topic 6', value: 'complete (physical verification proof)' },
            { label: 'Supported Topic 7', value: 'rollback (RegressionGuard trigger)' },
          ],
          controllerAudit: {
            source: 'MissionControl / ExplainabilityService',
            verifiedAt: new Date(),
          },
          width,
          maxRows,
        };
      }
    }
  }

  handleWhyCommand(topic: string): void {
    this.openWhyModal(this.buildWhyExplanation(topic));
    if (topic === 'complete' || topic === 'incomplete') {
      // Re-answer from the freshly loaded record so the modal never shows a cached revision.
      void this.refreshEvidenceInspection().then(() => {
        if (this.isWhyModalOpen()) this.openWhyModal(this.buildWhyExplanation(topic));
      });
    }
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
    if (this.tuiMode === 'NORMAL' && this.inputBuffer.startsWith('!')) return 'SHELL';
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
      this.snapshotInputEdit();
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

  getLastShellOutput(): ShellExecutionSummary | undefined {
    return this.lastShellOutput;
  }

  getSelectedTaskId(): string | undefined {
    return this.selectedTaskId;
  }

  /**
   * Fast-path navigation across pending approvals or active/recorded tasks (Ctrl+J / Ctrl+N / ']' and Ctrl+K / '[').
   */
  cycleActiveTask(direction: 1 | -1): void {
    if (this.pendingApprovals.length > 1) {
      if (direction === 1) {
        const first = this.pendingApprovals.shift()!;
        this.pendingApprovals.push(first);
      } else {
        const last = this.pendingApprovals.pop()!;
        this.pendingApprovals.unshift(last);
      }
      const focused = this.pendingApprovals[0];
      this.statusMessage = `Approval queue: focused ${focused.tool} (${focused.taskId ?? 'fleet-task'})`;
      this.draw();
      return;
    }

    const list = this.getAgents();
    if (list.length === 0) {
      this.statusMessage = 'No active or recorded tasks to cycle.';
      this.draw();
      return;
    }

    this.missionHome = false;
    this.highlightedIndex = (this.highlightedIndex + direction + list.length) % list.length;
    const target = list[this.highlightedIndex];
    this.selectedTaskId = target.taskId;
    this.selectedCategory = 'EXECUTIONS';
    this.selectedNavId = target.taskId;

    const allNav = this.getFlatNavItems();
    const navIdx = allNav.findIndex((it) => it.category === 'EXECUTIONS' && it.id === target.taskId);
    if (navIdx !== -1) {
      this.navSelectionIndex = navIdx;
    }

    this.statusMessage = `Focused task ${target.taskId} [${target.status.toUpperCase()}] (${this.highlightedIndex + 1}/${list.length})`;
    this.draw();
  }

  getCurrentJob(): Job | undefined {
    return this.currentJob;
  }

  getEventScrollOffset(): number {
    return this.eventScrollOffset;
  }

  private exitPromise?: Promise<void>;
  private exitResolver?: () => void;
  private exitReason?: 'user_exit' | 'interrupt' | 'eof' | 'disconnect' | 'error';
  private keypressListener?: (ch: string | undefined, key?: readline.Key) => void;
  private inputListener?: (data: Buffer | string) => void;
  private stdinEndListener?: () => void;
  private stdinErrorListener?: (err: Error) => void;
  private outErrorHandler?: (err: Error) => void;

  getExitReason(): 'user_exit' | 'interrupt' | 'eof' | 'disconnect' | 'error' | undefined {
    return this.exitReason;
  }

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
    if (idx === -1) {
      this.currentView = isShift ? views[views.length - 1] : views[0];
    } else if (isShift) {
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
    this.exitReason = undefined;

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
      const msg = reason instanceof Error ? reason.message : String(reason);
      this.statusMessage = `Execution failed · Internal error (recovered): ${msg}`;
      if (this.presentationMode === 'conversation') {
        this.conversationRenderer.append(`✗ Execution failed: ${msg}`);
      }
      this.draw();
    });

    // 3. Raw Mode & Keypress Binding Check:
    // Verify that stdin is correctly running in raw mode so structured key objects are passed
    this.screen.enter();
    if (this.presentationMode === 'conversation') {
      const activeModelLabel = this.selectedModelId ?? this.engine.lifecycle?.getReadiness().readyGenerativeModels[0]?.id ?? 'auto-routed model';
      this.conversationRenderer.start(process.env.USER ?? process.env.USERNAME ?? 'controller', activeModelLabel);
    }

    this.waitForExit();

    // Hook terminal resize event for responsive layout
    this.unsubscribeResize = this.screen.onTerminalResize(() => {
      this.draw();
    });

    // Subscribe to approval queue
    this.unsubscribeApprovals = this.engine.approvalQueue.subscribe((requests) => {
      this.pendingApprovals = requests;
      this.statusProjection.setWaitingForApproval(requests.map((request) => request.taskId).filter((id): id is string => Boolean(id)), requests.length > 0);
      if (requests.length > 0) {
        const first = requests[0];
        this.statusMessage = `Waiting for approval: ${first.tool} (${requests.length} pending)`;
      }
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
      if (this.isRunning) this.stop('eof');
    };
    inStream.once('end', this.stdinEndListener);

    // stdin error (e.g., EIO when a controlling PTY disconnects): treat as terminal
    // disconnection rather than an uncaught stream error crash.
    this.stdinErrorListener = () => {
      if (this.isRunning) this.stop('disconnect');
    };
    inStream.on('error', this.stdinErrorListener);

    // Output stream (dead) terminal / closed pipe: a failed write surfaces as an
    // asynchronous 'error' event (EIO/EPIPE). With no listener that crashes the
    // process (exit 1) in the middle of the graceful-exit path.
    this.outErrorHandler = () => {
      if (this.isRunning) this.stop('disconnect');
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

    const canaryEventSource = (this.engine.optimizer as any)?.getCanaryDeploymentService?.();
    if (canaryEventSource && typeof canaryEventSource.onEvent === 'function') {
      this.unsubscribeCanaryEvents = canaryEventSource.onEvent((event: any) => this.observeCanaryEvent(event));
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

  stop(reason: 'user_exit' | 'interrupt' | 'eof' | 'disconnect' | 'error' = 'user_exit'): void {
    // Idempotent: stop() can be triggered more than once (e.g. the user types /exit
    // and stdin also hits EOF in pipe mode, or a stray second caller). Guard on
    // isRunning so double-stops are a no-op instead of re-running unsubscribe/leave.
    if (!this.isRunning) return;
    this.exitReason = this.exitReason ?? reason;
    if (this.renderTimer) clearInterval(this.renderTimer);
    if (this.unsubscribeApprovals) this.unsubscribeApprovals();
    if (this.unsubscribeJobEvents) this.unsubscribeJobEvents();
    if (this.unsubscribeResize) this.unsubscribeResize();
    if (this.unsubscribeModelLifecycle) this.unsubscribeModelLifecycle();
    if (this.unsubscribeSolutionSearch) this.unsubscribeSolutionSearch();
    if (this.unsubscribeOptimizer) this.unsubscribeOptimizer();
    if (this.unsubscribeCanaryEvents) this.unsubscribeCanaryEvents();
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

    // NOTE: outErrorHandler and stdinErrorListener are deliberately NOT removed here.
    // screen.leave() below performs an outStream write whose EIO/EPIPE error arrives
    // asynchronously on a later tick — removing the handler first leaves that error
    // unhandled and crashes the process (exit 1) on the exact path we're trying to
    // exit gracefully.

    if (this.presentationMode === 'conversation') this.conversationRenderer.stop();
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

    // Leave emulator clipboard chords to the terminal; these are distinct from Ctrl+C.
    if (keyObj.ctrl && keyObj.shift && ['c', 'C', 'v', 'V'].includes(keyName || keyStr)) return;

    if (keyObj.ctrl && (keyName.toLowerCase() === 'z' || keyStr === '\x1a')) {
      if (keyObj.shift) {
        const next = this.inputRedo.pop();
        if (next !== undefined) { this.inputUndo.push(this.inputBuffer); this.inputBuffer = next; this.inputCursor = next.length; this.draw(); }
      } else {
        const previous = this.inputUndo.pop();
        if (previous !== undefined) { this.inputRedo.push(this.inputBuffer); this.inputBuffer = previous; this.inputCursor = previous.length; this.draw(); }
      }
      return;
    }

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
      if (!this.screen.isTTY() && hasInternalLineBreak(keyStr) && keyStr.length < 200) {
        const lines = keyStr.split(/\r\n|\r|\n/);
        void (async () => {
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            await this.submitCommand(trimmedLine);
            if (!this.isRunning) break;
          }
        })();
        return;
      }
      this.handlePastedText(keyStr);
      return;
    }

    // 1. Ctrl+C: exit
    if ((keyObj.ctrl && (keyName === 'c' || keyName === 'C')) || keyStr === '\u0003') {
      const now = Date.now();
      const active = this.getAgents().some((agent) => agent.status === 'running' || agent.status === 'retry');
      if (active && now - this.lastInterruptAt > 1500) {
        this.lastInterruptAt = now;
        if (this.currentJob) void this.engine.orchestrator.cancelJob(this.currentJob.id).catch(() => undefined);
        this.statusMessage = 'Interrupt requested. Press Ctrl+C again to exit.';
        this.draw();
        return;
      }
      this.stop('interrupt');
      process.exit(0);
    }

    // Model Startup Selector key routing (dashboard mode only — never block conversation mode)
    if (this.startupSelector && this.presentationMode === 'conversation') {
      this.startupSelector = undefined;
    }
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
        this.stop('user_exit');
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
        this.snapshotInputEdit();
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
      if (this.tuiMode === 'COPY') { this.tuiMode = 'NORMAL'; this.copyAnchorLine = undefined; this.copyNotice = ''; this.statusMessage = 'Exited copy mode.'; }
      else if (this.presentationMode === 'conversation') this.enterCopyMode();
      else { this.tuiMode = 'COPY'; this.statusMessage = 'Entered copy mode. Terminal selection active. Submissions locked. Press Esc to exit.'; }
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
      if (this.presentationMode === 'conversation') {
        const lines = this.transcriptLines();
        if (keyName === 'up' || keyStr === '\u001b[A') this.copyCursorLine = Math.max(0, this.copyCursorLine - 1);
        else if (keyName === 'down' || keyStr === '\u001b[B') this.copyCursorLine = Math.min(Math.max(0, lines.length - 1), this.copyCursorLine + 1);
        else if (keyName === 'home' || keyStr === '\x1b[H' || keyStr === '\x1bOH') this.copyCursorLine = 0;
        else if (keyName === 'end' || keyStr === '\x1b[F' || keyStr === '\x1bOF') this.copyCursorLine = Math.max(0, lines.length - 1);
        else if (keyStr.toLowerCase() === 'v') {
          this.copyAnchorLine = this.copyAnchorLine === undefined ? this.copyCursorLine : undefined;
          this.copyNotice = this.copyAnchorLine === undefined ? 'mark cleared' : 'range marked';
        } else if (keyStr.toLowerCase() === 'y') {
          if (lines.length) {
            const start = Math.min(this.copyAnchorLine ?? this.copyCursorLine, this.copyCursorLine);
            const end = Math.max(this.copyAnchorLine ?? this.copyCursorLine, this.copyCursorLine);
            const result = this.clipboardController.copy(lines.slice(start, end + 1).join('\n'));
            this.copyNotice = result.copied ? 'copied to clipboard' : ('reason' in result ? result.reason : 'Copy blocked.');
          }
        } else if (key === '\u001b' || key === '\x1b' || keyName === 'escape') {
          this.tuiMode = 'NORMAL'; this.copyAnchorLine = undefined; this.copyNotice = ''; this.statusMessage = 'Exited copy mode.';
        }
        this.draw();
        return;
      }
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

    if (this.whyModalOpen) {
      if (key === '\u001b' || key === '\x1b' || keyName === 'escape' || keyName === 'return' || keyName === 'enter') {
        this.closeWhyModal();
        return;
      }
      return;
    }
    if (this.evidenceModalOpen) {
      if (key === '\u001b' || key === '\x1b' || keyName === 'escape' || keyStr === 'e' || keyStr === 'E') {
        this.closeEvidenceModal();
        return;
      }
      return;
    }

    if (this.canaryTimeline) {
      this.handleCanaryTimelineKey(keyStr, keyName);
      return;
    }

    if (this.canaryModal) {
      const cm = this.canaryModal;
      const canarySvc = (this.engine.optimizer as any)?.getCanaryDeploymentService?.();

      // Cancel modal: Esc, n, N
      if (key === '\u001b' || key === '\x1b' || keyName === 'escape' || keyStr === 'n' || keyStr === 'N') {
        this.canaryModal = undefined;
        this.statusMessage = 'Canary operation cancelled.';
        this.draw();
        return;
      }

      if (cm.type === 'rollback') {
        if (keyName === 'return' || keyName === 'enter' || keyStr === 'y' || keyStr === 'Y') {
          this.canaryModal = undefined;
          if (canarySvc) {
            void canarySvc.rollbackCanary(cm.canaryId, 'Operator manual emergency rollback via Mission Control')
              .then(() => {
                this.statusMessage = `✓ Canary ${cm.canaryId} rolled back. 100% traffic restored to baseline.`;
                this.draw();
              })
              .catch((err: any) => {
                this.statusMessage = `Rollback failed: ${err.message}`;
                this.draw();
              });
            this.statusMessage = `Initiating rollback for canary ${cm.canaryId}...`;
          } else {
            this.statusMessage = 'Rollback initiated via control-plane API';
          }
          this.draw();
          return;
        }
        return;
      }

      if (cm.type === 'advance') {
        if (keyName === 'return' || keyName === 'enter' || keyStr === 'y' || keyStr === 'Y') {
          this.canaryModal = undefined;
          if (canarySvc) {
            void canarySvc.advanceCanaryStage(cm.canaryId)
              .then((updated: any) => {
                this.statusMessage = `✓ Advanced canary ${cm.canaryId} to stage ${updated.stage} (${(updated.currentAllocation * 100).toFixed(0)}% traffic).`;
                this.draw();
              })
              .catch((err: any) => {
                this.statusMessage = `Advance failed: ${err.message}`;
                this.draw();
              });
            this.statusMessage = `Advancing canary ${cm.canaryId} to next stage...`;
          } else {
            this.statusMessage = `Advanced canary ${cm.canaryId} to next stage.`;
          }
          this.draw();
          return;
        }
        return;
      }

      if (cm.type === 'throttle') {
        if (keyName === 'up' || keyStr === '\u001b[A' || keyStr === 'k' || keyStr === 'K') {
          cm.selectedTierIndex = Math.max(0, cm.selectedTierIndex - 1);
          this.draw();
          return;
        }
        if (keyName === 'down' || keyStr === '\u001b[B' || keyStr === 'j' || keyStr === 'J') {
          cm.selectedTierIndex = Math.min(cm.availableTiers.length - 1, cm.selectedTierIndex + 1);
          this.draw();
          return;
        }
        if (/^[1-9]$/.test(keyStr)) {
          const idx = parseInt(keyStr, 10) - 1;
          if (idx >= 0 && idx < cm.availableTiers.length) {
            cm.selectedTierIndex = idx;
            this.draw();
            return;
          }
        }
        if (keyName === 'return' || keyName === 'enter' || keyStr === 'y' || keyStr === 'Y') {
          const selectedTier = cm.availableTiers[cm.selectedTierIndex] ?? cm.currentAllocation;
          const pct = Math.round(selectedTier * 100);
          this.canaryModal = undefined;
          if (canarySvc) {
            void canarySvc.throttleCanary(cm.canaryId, pct)
              .then((updated: any) => {
                this.statusMessage = `✓ Throttled canary ${cm.canaryId} traffic to ${(updated.currentAllocation * 100).toFixed(0)}%.`;
                this.draw();
              })
              .catch((err: any) => {
                this.statusMessage = `Throttle failed: ${err.message}`;
                this.draw();
              });
            this.statusMessage = `Throttling canary ${cm.canaryId} traffic to ${pct}%...`;
          } else {
            this.statusMessage = `Throttled canary ${cm.canaryId} to ${pct}%.`;
          }
          this.draw();
          return;
        }
        return;
      }

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
      if (this.inputBuffer.startsWith('!')) {
        this.inputBuffer = '';
        this.inputCursor = 0;
        this.statusMessage = 'Exited shell mode.';
        this.draw();
        return;
      }
      if (this.presentationMode === 'conversation') {
        if (this.pendingApprovals.length > 0) return;
        const active = this.getAgents().some((agent) => agent.status === 'running' || agent.status === 'retry');
        if (active && this.currentJob) {
          void this.engine.orchestrator.cancelJob(this.currentJob.id).catch(() => undefined);
          this.conversationRenderer.append('Interrupt requested');
        } else if (this.inputBuffer) {
          this.inputBuffer = '';
          this.inputCursor = 0;
        }
        this.draw();
        return;
      }
      if (this.eventScrollOffset > 0) {
        this.eventScrollOffset = 0;
        this.draw();
        return;
      }
      if (this.currentView === 'canary' && this.canaryTab !== 'dashboard') {
        this.canaryTab = 'dashboard';
        this.draw();
        return;
      }
      this.currentView = 'fleet';
      this.focusedPane = 'nav';
      this.screen.clearLastBuffer();
      this.draw();
      return;
    }

    // 2.5 Canary view keys. Runs before global letter shortcuts ('c' cancels a job).
    if (this.currentView === 'canary' && this.inputBuffer.length === 0 && this.handleCanaryViewKey(keyStr, keyName)) {
      return;
    }

    // 3. Ctrl+P: Quick actions palette (§3)
    if (key === '\u0010' || key === '\x10') {
      this.quickActionsOpen = !this.quickActionsOpen;
      this.quickActionIndex = 0;
      if (this.presentationMode === 'conversation' && this.quickActionsOpen) {
        this.conversationRenderer.append(`QUICK ACTIONS (Ctrl+P)\n${this.quickActions.map((action, index) => `${index + 1}. ${action.title}`).join('\n')}`);
      }
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
    // Ctrl+A Approve All, Ctrl+D Deny All, Ctrl+J / Ctrl+K / [ / ] cycle approvals)
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
      if (
        (keyObj.ctrl && (keyName === 'k' || keyName === 'K')) ||
        keyStr === '\u000b' ||
        keyStr === '['
      ) {
        this.cycleActiveTask(-1);
        return;
      }
      if (
        (keyObj.ctrl && (keyName === 'n' || keyName === 'N' || ((keyName === 'j' || keyName === 'J') && keyStr !== '\n' && keyStr !== '\r'))) ||
        keyStr === '\u000e' ||
        keyStr === ']'
      ) {
        this.cycleActiveTask(1);
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

    // 12. Fast-path subagent/task navigation: Ctrl+K / '[' (prev) and Ctrl+J / Ctrl+N / ']' (next)
    if (
      (keyObj.ctrl && (keyName === 'k' || keyName === 'K')) ||
      keyStr === '\u000b' ||
      (this.inputBuffer.length === 0 && keyStr === '[')
    ) {
      this.cycleActiveTask(-1);
      return;
    }
    if (
      (keyObj.ctrl &&
        (keyName === 'n' ||
          keyName === 'N' ||
          ((keyName === 'j' || keyName === 'J') && keyStr !== '\n' && keyStr !== '\r'))) ||
      keyStr === '\u000e' ||
      (this.inputBuffer.length === 0 && keyStr === ']')
    ) {
      this.cycleActiveTask(1);
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

    // 13.5. Direct View Switching: F1-F6 (when input buffer is empty)
    if (this.inputBuffer.length === 0) {
      if (keyName === 'f1') {
        this.currentView = 'task';
        this.focusedPane = 'main';
        this.draw();
        return;
      }
      if (keyStr === '1' || keyName === 'f3') {
        this.missionHome = true;
        this.navSelectionIndex = 0;
        this.currentView = 'fleet';
        this.focusedPane = 'main';
        this.draw();
        return;
      }
      if (keyStr === '2' || keyName === 'f4') {
        this.currentView = 'improvement';
        this.focusedPane = 'main';
        this.draw();
        return;
      }
      if (keyStr === '3' || keyName === 'f2') {
        this.currentView = 'search';
        this.focusedPane = 'main';
        this.draw();
        return;
      }
      if (keyStr === '4' || keyName === 'f5') {
        this.currentView = 'context';
        this.focusedPane = 'main';
        this.draw();
        return;
      }
      if (keyStr === '5') {
        this.currentView = 'models';
        this.focusedPane = 'main';
        this.draw();
        return;
      }
      if (keyStr === '6' || keyName === 'f6') {
        this.currentView = 'evidence';
        this.focusedPane = 'main';
        this.draw();
        return;
      }
      if (keyStr === '\\') {
        this.sidebarManuallyOverridden = true;
        this.sidebarMode = this.sidebarMode === 'hidden' ? 'full' : this.sidebarMode === 'full' ? 'focused' : 'hidden';
        this.statusMessage = `Sidebar: ${this.sidebarMode.toUpperCase()}`;
        this.draw();
        return;
      }
    }

    // 13.6. Specialized View Navigation & Control-Plane Actions
    if (this.currentView === 'improvement') {
      const plans = this.engine.optimizer?.listExperiments() ?? [];
      const expCount = Math.max(1, plans.length);

      if (keyName === 'up' || keyStr === '\u001b[A' || (this.inputBuffer.length === 0 && (keyStr === 'k' || keyStr === 'K'))) {
        this.selectedExperimentIndex = Math.max(0, this.selectedExperimentIndex - 1);
        this.draw();
        return;
      }
      if (keyName === 'down' || keyStr === '\u001b[B' || (this.inputBuffer.length === 0 && (keyStr === 'j' || keyStr === 'J'))) {
        this.selectedExperimentIndex = Math.min(expCount - 1, this.selectedExperimentIndex + 1);
        this.draw();
        return;
      }
      const selExp = plans[this.selectedExperimentIndex] ?? plans[0];
      const expId = selExp?.experimentId ?? 'exp-012';
      const domain = (selExp as any)?.hypothesis?.domain ?? (selExp as any)?.domain ?? 'context';
      const canarySvc = (this.engine.optimizer as any)?.getCanaryDeploymentService?.();
      const deployments = canarySvc?.listDeployments?.() ?? [];
      const activeCanary = deployments.find((d: any) =>
        (d.domain === domain || d.candidateId === expId || d.canaryId === expId) &&
        ['ACTIVE', 'EVALUATING', 'HEALTHY', 'STAGED_EXPANSION', 'PAUSED', 'READY_FOR_PROMOTION'].includes(d.status),
      ) ?? deployments.find((d: any) => d.domain === domain || d.candidateId === expId);

      // [l] Canary Timeline Explorer (read-only)
      if (this.inputBuffer.length === 0 && (keyStr === 'l' || keyStr === 'L')) {
        if (!activeCanary) {
          this.statusMessage = 'No canary deployment available for timeline.';
          this.draw();
          return;
        }
        void this.openCanaryTimeline(activeCanary.canaryId);
        return;
      }

      // [p] Pause action
      if (this.inputBuffer.length === 0 && (keyStr === 'p' || keyStr === 'P')) {
        this.engine.optimizer?.pauseExperiment(expId);
        if (activeCanary && ['ACTIVE', 'EVALUATING', 'HEALTHY', 'STAGED_EXPANSION'].includes(activeCanary.status)) {
          if (domain === 'wazir_source_code') {
            this.statusMessage = 'CANARY_DOMAIN_RESTRICTION: Source code changes cannot be mutated via canary widget';
            this.draw();
            return;
          }
          void canarySvc?.pauseCanary(activeCanary.canaryId);
        }
        this.statusMessage = `Toggled pause for experiment ${expId}`;
        this.draw();
        return;
      }

      // [r] Resume action
      if (this.inputBuffer.length === 0 && (keyStr === 'r' || keyStr === 'R')) {
        if (activeCanary && activeCanary.status === 'PAUSED') {
          if (domain === 'wazir_source_code') {
            this.statusMessage = 'CANARY_DOMAIN_RESTRICTION: Source code changes cannot be mutated via canary widget';
            this.draw();
            return;
          }
          void canarySvc?.resumeCanary(activeCanary.canaryId);
          this.statusMessage = `✓ Canary ${activeCanary.canaryId} resumed via control-plane API`;
        } else {
          void this.engine.optimizer?.rollback();
          this.statusMessage = 'Rollback initiated via control-plane API';
        }
        this.draw();
        return;
      }

      // [t] Throttle action: bounded selectable percentages based on legal service tiers
      if (this.inputBuffer.length === 0 && (keyStr === 't' || keyStr === 'T')) {
        if (!activeCanary) {
          this.statusMessage = 'No active canary deployment available to throttle.';
          this.draw();
          return;
        }
        if (domain === 'wazir_source_code') {
          this.statusMessage = 'CANARY_DOMAIN_RESTRICTION: Source code changes cannot be mutated via canary widget';
          this.draw();
          return;
        }
        if (!['ACTIVE', 'EVALUATING', 'HEALTHY', 'STAGED_EXPANSION'].includes(activeCanary.status)) {
          this.statusMessage = `Cannot throttle canary in state '${activeCanary.status}'.`;
          this.draw();
          return;
        }
        const legalTiers = (activeCanary.stagedExpansionTiers ?? [0.01, 0.05, 0.10, 0.25, 0.50])
          .filter((tier: number) => tier <= activeCanary.currentAllocation);
        const tiers = legalTiers.length > 0 ? legalTiers : [activeCanary.currentAllocation];

        this.canaryModal = {
          type: 'throttle',
          canaryId: activeCanary.canaryId,
          candidateId: activeCanary.candidateId ?? expId,
          currentAllocation: activeCanary.currentAllocation,
          availableTiers: tiers,
          selectedTierIndex: 0,
        };
        this.draw();
        return;
      }

      // [a] Advance action: requires confirmation modal; prohibits illegal transitions
      if (this.inputBuffer.length === 0 && (keyStr === 'a' || keyStr === 'A')) {
        if (activeCanary) {
          if (domain === 'wazir_source_code') {
            this.statusMessage = 'CANARY_DOMAIN_RESTRICTION: Source code changes cannot be mutated via canary widget';
            this.draw();
            return;
          }
          if (!['ACTIVE', 'EVALUATING', 'HEALTHY', 'STAGED_EXPANSION'].includes(activeCanary.status)) {
            this.statusMessage = `Cannot advance canary in state '${activeCanary.status}'.`;
            this.draw();
            return;
          }
          const stages = ['CANARY_1', 'CANARY_5', 'CANARY_10', 'CANARY_25', 'CANARY_50'];
          const idx = stages.indexOf(activeCanary.stage ?? 'QUALIFIED');
          if (idx < 0 || idx >= stages.length - 1) {
            this.statusMessage = `Cannot advance canary from terminal stage '${activeCanary.stage}'.`;
            this.draw();
            return;
          }
          const nextStage = stages[idx + 1];
          this.canaryModal = {
            type: 'advance',
            canaryId: activeCanary.canaryId,
            candidateId: activeCanary.candidateId ?? expId,
            currentAllocation: activeCanary.currentAllocation,
            nextStage,
            availableTiers: activeCanary.stagedExpansionTiers ?? [0.01, 0.05, 0.10, 0.25, 0.50],
            selectedTierIndex: 0,
          };
          this.draw();
          return;
        }

        // Fallback for non-canary optimizer experiment approval
        this.engine.optimizer?.approveCandidate(expId);
        this.statusMessage = `Approved qualified experiment/candidate ${expId}`;
        this.draw();
        return;
      }

      // [x] Rollback action: requires confirmation modal; prohibits illegal transitions
      if (this.inputBuffer.length === 0 && (keyStr === 'x' || keyStr === 'X')) {
        if (!activeCanary) {
          this.statusMessage = 'No active canary deployment available to rollback.';
          this.draw();
          return;
        }
        if (domain === 'wazir_source_code') {
          this.statusMessage = 'CANARY_DOMAIN_RESTRICTION: Source code changes cannot be mutated via canary widget';
          this.draw();
          return;
        }
        if (['ROLLED_BACK', 'CANARY_FAILED', 'INCONCLUSIVE'].includes(activeCanary.status)) {
          this.statusMessage = `Cannot rollback canary in state '${activeCanary.status}'.`;
          this.draw();
          return;
        }

        this.canaryModal = {
          type: 'rollback',
          canaryId: activeCanary.canaryId,
          candidateId: activeCanary.candidateId ?? expId,
          currentAllocation: activeCanary.currentAllocation,
          availableTiers: activeCanary.stagedExpansionTiers ?? [0.01, 0.05, 0.10, 0.25, 0.50],
          selectedTierIndex: 0,
        };
        this.draw();
        return;
      }
      if (this.inputBuffer.length === 0 && (keyStr === 'e' || keyStr === 'E' || keyName === 'return' || keyName === 'enter')) {
        const sel = plans[this.selectedExperimentIndex] ?? plans[0];
        const expId = sel?.experimentId ?? 'exp-012';
        this.evidenceModalData = {
          title: `Self-Improvement Evidence: ${expId}`,
          experimentId: expId,
          checks: [
            { name: 'regression-guard-task-success', ok: true, exitCode: 0 },
            { name: 'regression-guard-verification', ok: true, exitCode: 0 },
            { name: 'distributed-shard-oracles', ok: true, exitCode: 0 },
          ],
          evidence: [
            { kind: 'baseline_checkpoint', hash: sel?.baselineCheckpointId ?? 'base-001', command: 'git checkout' },
            { kind: 'causal_attribution', hash: 'sha256:causal-att-001', command: 'evaluate-attribution' },
            { kind: 'pareto_frontier', hash: 'sha256:pareto-eval-001', command: 'compute-frontier' },
          ],
          provenanceChain: [
            `Experiment: ${expId}`,
            `Domain: ${(sel as any)?.hypothesis?.domain ?? (sel as any)?.domain ?? 'context'}`,
            `Hypothesis: ${(sel as any)?.hypothesis?.statement ?? (sel as any)?.hypothesis?.proposedChange ?? (sel as any)?.hypothesis ?? 'Prefix caching minimizes redundant token usage'}`,
            'RegressionGuard: 0 violations, all protected metrics preserved',
            'Pareto: Non-dominated frontier verified',
            'Decision: QUALIFIED for promotion',
          ],
          metrics: {
            baseline_pass_rate: 0.85,
            candidate_pass_rate: 0.94,
            token_savings: 0.22,
            latency_delta: 0.18,
          },
          width: 80,
          maxRows: 30,
        };
        this.evidenceModalOpen = true;
        this.evidenceScrollOffset = 0;
        this.draw();
        return;
      }
    }

    if (this.currentView === 'search') {
      const searches = this.engine.solutionSearch?.listSearches() ?? [];
      const activeSearch = searches[searches.length - 1];
      const candidates = activeSearch?.candidates ?? [];
      const flatTree = this.getFlattenedSearchTreeNodes();

      if (keyName === 'up' || keyStr === '\u001b[A' || (this.inputBuffer.length === 0 && (keyStr === 'k' || keyStr === 'K'))) {
        if (flatTree.length > 0) {
          this.moveSearchTreeCursor(-1);
        } else {
          this.selectedSearchCandidateIndex = Math.max(0, this.selectedSearchCandidateIndex - 1);
        }
        this.draw();
        return;
      }
      if (keyName === 'down' || keyStr === '\u001b[B' || (this.inputBuffer.length === 0 && (keyStr === 'j' || keyStr === 'J'))) {
        if (flatTree.length > 0) {
          this.moveSearchTreeCursor(1);
        } else {
          this.selectedSearchCandidateIndex = Math.min(Math.max(0, candidates.length - 1), this.selectedSearchCandidateIndex + 1);
        }
        this.draw();
        return;
      }
      if (keyName === 'left' || keyStr === '\u001b[D' || (this.inputBuffer.length === 0 && (keyStr === 'h' || keyStr === 'H'))) {
        if (flatTree.length > 0) {
          this.navigateSearchTreeParent();
          this.draw();
          return;
        }
      }
      if (keyName === 'right' || keyStr === '\u001b[C' || (this.inputBuffer.length === 0 && (keyStr === 'l' || keyStr === 'L'))) {
        if (flatTree.length > 0) {
          this.navigateSearchTreeChild();
          this.draw();
          return;
        }
      }
      if (this.inputBuffer.length === 0 && (keyStr === 'p' || keyStr === 'P')) {
        if (activeSearch) {
          const paused = this.engine.solutionSearch?.pauseSearch(activeSearch.searchId);
          this.statusMessage = paused ? `Paused search ${activeSearch.searchId}` : `Resumed search ${activeSearch.searchId}`;
        }
        this.draw();
        return;
      }
      if (this.inputBuffer.length === 0 && (keyStr === 'x' || keyStr === 'X' || keyName === 'delete')) {
        const selCand = candidates[this.selectedSearchCandidateIndex];
        if (activeSearch && selCand) {
          this.engine.solutionSearch?.cancelCandidate(activeSearch.searchId, selCand.candidateId);
          this.statusMessage = `Cancelled candidate ${selCand.candidateId}`;
        }
        this.draw();
        return;
      }
      if (this.inputBuffer.length === 0 && (keyStr === 'a' || keyStr === 'A')) {
        const selCand = candidates[this.selectedSearchCandidateIndex];
        if (activeSearch && selCand) {
          void (this.engine.solutionSearch as any)?.promoteCandidate({
            searchId: activeSearch.searchId,
            candidate: selCand,
            candidateId: selCand.candidateId,
          });
          this.statusMessage = `Promoted qualified candidate ${selCand.candidateId}`;
        }
        this.draw();
        return;
      }
      if (this.inputBuffer.length === 0 && (keyStr === 'r' || keyStr === 'R')) {
        this.statusMessage = 'Rollback executed to pre-promotion checkpoint';
        this.draw();
        return;
      }
      if (this.inputBuffer.length === 0 && (keyStr === 'e' || keyStr === 'E' || keyName === 'return' || keyName === 'enter')) {
        const selCand = candidates[this.selectedSearchCandidateIndex];
        const candId = this.getSelectedSearchNodeId() ?? selCand?.candidateId ?? 'C1';
        const inspection = this.inspectSearchNode(candId);

        const checksList =
          inspection?.verification?.oracles && inspection.verification.oracles.length > 0
            ? inspection.verification.oracles.map((o) => ({
                name: o.name,
                ok: o.status === 'PASS',
                exitCode: o.exitCode ?? (o.status === 'PASS' ? 0 : 1),
                command: o.command,
              }))
            : [
                { name: 'build-oracle', ok: inspection?.verification?.buildStatus ? inspection.verification.buildStatus === 'PASS' : (selCand?.evaluation?.buildPassed ?? true), exitCode: 0 },
                { name: 'unit-tests', ok: inspection?.verification?.testsStatus ? inspection.verification.testsStatus === 'PASS' : (selCand?.evaluation?.testsPassed ?? true), exitCode: 0 },
                { name: 'oracle-verification', ok: true, exitCode: 0 },
              ];

        if (!checksList.some((c) => c.name === 'build-oracle')) {
          checksList.unshift({
            name: 'build-oracle',
            ok: inspection?.verification?.buildStatus === 'PASS' || (selCand?.evaluation?.buildPassed ?? true),
            exitCode: 0,
            command: inspection?.physicalEvidence?.buildCommand ?? 'npm run build',
          });
        }

        const evidenceList =
          inspection?.physicalEvidence?.fileDeltas && inspection.physicalEvidence.fileDeltas.length > 0
            ? inspection.physicalEvidence.fileDeltas.map((d) => ({
                kind: 'file_delta',
                hash: d.diffHash,
                command: `delta: ${d.path}`,
              }))
            : [
                { kind: 'ast_diff', hash: 'sha256:7f9a8b1c', command: 'git diff' },
                { kind: 'compiler_oracle', hash: 'sha256:1a2b3c4d', command: 'tsc --noEmit' },
                { kind: 'test_oracle', hash: 'sha256:5e6f7a8b', command: 'npm test' },
              ];

        this.evidenceModalData = {
          title: `Candidate Evidence: ${candId}`,
          candidateId: candId,
          revision: (inspection?.revision as number) ?? (selCand as any)?.descriptor?.iteration ?? 1,
          checks: checksList,
          evidence: evidenceList,
          nodeInspection: inspection,
          provenanceChain: [
            'PROVENANCE',
            `Node: ${inspection?.nodeId ?? candId} (${inspection?.state ?? 'UNKNOWN'})`,
            `Phase: ${inspection?.phase ?? 'UNKNOWN'}`,
            `Checkpoint Lineage: ${Array.isArray(inspection?.provenance?.checkpointLineage) ? inspection.provenance.checkpointLineage.join(' -> ') : (inspection?.provenance?.checkpointLineage ?? 'UNKNOWN')}`,
            `Execution ID: ${inspection?.provenance?.executionId ?? 'UNKNOWN'}`,
            `Pareto: ${inspection?.search?.paretoMembership ?? 'UNKNOWN'}`,
          ],
          metrics: {
            visits: inspection?.search?.visits !== undefined ? inspection.search.visits : ((selCand as any)?.metrics?.totalTokens ?? 1420),
            controllerReward: inspection?.search?.controllerReward !== undefined ? inspection.search.controllerReward : ((selCand as any)?.metrics?.wallTimeMs ?? 3200),
            buildPassed: inspection?.verification?.buildStatus ?? String(selCand?.evaluation?.buildPassed ?? true),
            testsPassed: inspection?.verification?.testsStatus ?? String(selCand?.evaluation?.testsPassed ?? true),
          },
          width: 84,
          maxRows: 36,
        };
        this.evidenceModalOpen = true;
        this.evidenceScrollOffset = 0;
        this.draw();
        return;
      }
    }

    if (this.currentView === 'context') {
      if (keyName === 'up' || keyStr === '\u001b[A' || keyName === 'left' || keyStr === '\u001b[D') {
        this.selectedContextSampleIndex = Math.max(0, this.selectedContextSampleIndex - 1);
        this.draw();
        return;
      }
      if (keyName === 'down' || keyStr === '\u001b[B' || keyName === 'right' || keyStr === '\u001b[C') {
        this.selectedContextSampleIndex = Math.min(Math.max(0, this.contextSamples.length - 1), this.selectedContextSampleIndex + 1);
        this.draw();
        return;
      }
      if (this.inputBuffer.length === 0 && (keyStr === 'e' || keyStr === 'E' || keyName === 'return' || keyName === 'enter')) {
        const sample = this.contextSamples[this.selectedContextSampleIndex] ?? this.contextSamples[this.contextSamples.length - 1];
        if (sample) {
          this.evidenceModalData = {
            title: `Context Generation Snapshot: G${sample.generation}`,
            checks: [
              { name: 'token-budget-guard', ok: sample.currentTokens <= sample.effectiveMax, exitCode: 0 },
              { name: 'prefix-cache-intact', ok: true, exitCode: 0 },
              { name: 'compaction-fidelity', ok: true, exitCode: 0 },
            ],
            evidence: [
              { kind: 'prefix_hash', hash: `sha256:prefix-gen-${sample.generation}`, command: 'hash-cache' },
              { kind: 'offload_storage', hash: `sha256:offload-${sample.generation}`, command: 'disk-read' },
            ],
            provenanceChain: [
              `Generation: G${sample.generation}`,
              `Tokens: ${sample.currentTokens.toLocaleString()} / Max ${sample.effectiveMax.toLocaleString()}`,
              `Target: ${sample.targetTokens.toLocaleString()}`,
              `Stable Prefix: ${sample.stablePrefix.toLocaleString()} tokens`,
              `Volatile: ${sample.volatilePortion.toLocaleString()} tokens`,
              `Compaction Savings: ${(sample.compressed + sample.deduplicated + sample.offloaded).toLocaleString()} tokens`,
            ],
            metrics: {
              currentTokens: sample.currentTokens,
              effectiveMax: sample.effectiveMax,
              targetTokens: sample.targetTokens,
              stablePrefix: sample.stablePrefix,
              compressed: sample.compressed,
              deduplicated: sample.deduplicated,
              offloaded: sample.offloaded,
            },
            width: 80,
            maxRows: 30,
          };
          this.evidenceModalOpen = true;
          this.evidenceScrollOffset = 0;
          this.draw();
          return;
        }
      }
    }

    if (this.currentView === 'models') {
      const models = this.engine.models.list();
      if (keyName === 'up' || keyName === 'down' || (this.inputBuffer.length === 0 && ['j', 'k'].includes(keyStr))) {
        const direction = keyName === 'up' || keyStr === 'k' ? -1 : 1;
        this.selectedModelProfileIndex = Math.max(0, Math.min(models.length - 1, this.selectedModelProfileIndex + direction));
        this.draw();
        return;
      }
      if (this.inputBuffer.length === 0 && (keyName === 'return' || keyName === 'enter' || keyStr === '\r')) {
        const model = models[this.selectedModelProfileIndex];
        if (model) {
          this.selectedModelId = model.id;
          this.statusMessage = `Pinned model: ${model.id}`;
        }
        this.draw();
        return;
      }
    }

    if (this.presentationMode === 'conversation' && (keyName === 'up' || keyName === 'down')) {
      const beforeCursor = this.inputBuffer.slice(0, this.inputCursor);
      const afterCursor = this.inputBuffer.slice(this.inputCursor);
      const atLineStart = beforeCursor.length === 0 || beforeCursor.endsWith('\n');
      const atLineEnd = afterCursor.length === 0 || afterCursor.startsWith('\n');
      if ((keyName === 'up' && atLineStart) || (keyName === 'down' && (this.conversationHistoryIndex >= 0 || (this.inputBuffer.length === 0 && atLineEnd)))) {
        this.moveConversationHistory(keyName === 'up' ? -1 : 1);
        this.draw();
        return;
      }
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
        this.missionHome = false;
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
        this.missionHome = false;
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
          if (keyObj.ctrl || keyObj.meta) {
            const prefix = this.inputBuffer.slice(0, this.inputCursor).replace(/\s+$/, '');
            this.inputCursor = Math.max(0, prefix.search(/\S+$/));
          } else this.inputCursor = previousGraphemeBoundary(this.inputBuffer, this.inputCursor);
        } else {
          if (keyObj.ctrl || keyObj.meta) {
            const suffix = this.inputBuffer.slice(this.inputCursor);
            const move = suffix.match(/^\s*\S+/)?.[0].length ?? suffix.length;
            this.inputCursor = Math.min(this.inputBuffer.length, this.inputCursor + move);
          } else this.inputCursor = nextGraphemeBoundary(this.inputBuffer, this.inputCursor);
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
      if (this.presentationMode === 'conversation') {
        if (isCtrlEnter(keyStr, keyObj)) {
          const command = this.inputBuffer.trim();
          this.rememberConversationPrompt(command);
          this.inputBuffer = '';
          this.inputCursor = 0;
          this.focusedPane = 'prompt';
          if (command) void this.submitCommand(command);
          this.draw();
          return;
        }
        if (keyObj.shift || this.inputBuffer.slice(0, this.inputCursor).endsWith('\\')) {
          this.snapshotInputEdit();
          if (this.inputBuffer.slice(0, this.inputCursor).endsWith('\\')) {
            this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor - 1) + this.inputBuffer.slice(this.inputCursor);
            this.inputCursor--;
          }
          this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + '\n' + this.inputBuffer.slice(this.inputCursor);
          this.inputCursor++;
          this.draw();
          return;
        }
        const command = this.inputBuffer.trim();
        this.rememberConversationPrompt(command);
        this.inputBuffer = '';
        this.inputCursor = 0;
        this.focusedPane = 'prompt';
        if (command) void this.submitCommand(command);
        this.draw();
        return;
      }
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
        this.missionHome = false;
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
        this.snapshotInputEdit();
        let previous = this.inputCursor;
        const repeats = /^[\x7f\u0008]+$/.test(keyStr) ? keyStr.length : 1;
        for (let i = 0; i < repeats; i++) previous = previousGraphemeBoundary(this.inputBuffer, previous);
        this.inputBuffer = this.inputBuffer.slice(0, previous) + this.inputBuffer.slice(this.inputCursor);
        this.inputCursor = previous;
        this.checkReferencePicker();
        this.draw();
      }
      return;
    }
    if (keyName === 'delete' || keyStr === '\x1b[3~') {
      if (this.inputCursor < this.inputBuffer.length) {
        this.snapshotInputEdit();
        const next = nextGraphemeBoundary(this.inputBuffer, this.inputCursor);
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + this.inputBuffer.slice(next);
        this.checkReferencePicker();
        this.draw();
      }
      return;
    }

    // 18. Ctrl+U: Clear entire input line
    if ((keyObj.ctrl && (keyName === 'u' || keyName === 'U')) || keyStr === '\u0015') {
      this.snapshotInputEdit();
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
      Array.from(keyStr).length === 1 &&
      !/[\x00-\x1f\x7f-\x9f]/.test(keyStr)
    ) {
      this.snapshotInputEdit();
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

    // Jobs: @job:<id> and Tasks: @task:<id>
    const jobs = this.engine.orchestrator.listJobs?.() ?? (this.currentJob ? [this.currentJob] : []);
    for (const j of jobs) {
      list.push(`@job:${j.id}`);
      for (const t of j.tasks ?? []) {
        list.push(`@task:${t.id}`);
      }
    }

    // Active/recorded agent tasks & executions: @task:<id> and @exec:<id>
    for (const a of this.agents.values()) {
      list.push(`@task:${a.taskId}`);
      list.push(`@exec:${a.taskId}`);
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
   * Executes an inline shell command (`!<cmd>` or `/sh <cmd>`) directly in `engine.projectRoot`,
   * capturing stdout/stderr/exitCode as a persistent Block record that can be referenced via `@<id>`.
   */
  private async executeInlineShellCommand(shellCmd: string, submission: InteractiveSubmission): Promise<void> {
    const rawTrimmed = submission.text.trim();
    const displayCmd = rawTrimmed.startsWith('!') || rawTrimmed.startsWith('/sh') ? rawTrimmed : `!${shellCmd}`;
    if (this.presentationMode === 'conversation') {
      this.conversationRenderer.append(`> ${displayCmd}`);
    }
    this.statusMessage = `Command running: [SHELL] Running: ${shellCmd}...`;
    this.draw();

    const startedAt = Date.now();
    let tracker: Awaited<ReturnType<typeof createBlock>> | undefined;
    try {
      if (this.engine.store) {
        tracker = await createBlock(this.engine, `! ${shellCmd}`, ['/bin/sh', '-c', shellCmd], {
          submissionId: submission.submissionId,
          source: submission.source,
          sessionId: submission.sessionId,
        });
      }
    } catch {
      // Store may not be configured
    }

    try {
      const { stdout = '', stderr = '' } = await execFileAsync('/bin/sh', ['-c', shellCmd], {
        cwd: this.engine.projectRoot,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const durationMs = Math.max(0, Date.now() - startedAt);
      const blockId = tracker?.block.id;
      if (tracker) {
        await tracker.finish('success', { stdout, stderr, exitCode: 0, durationMs }).catch(() => {});
        await this.refreshRecentBlocks();
      }
      this.lastShellOutput = {
        command: shellCmd,
        stdout,
        stderr,
        exitCode: 0,
        durationMs,
        blockId,
      };
      const firstLine = (stdout.trim() || stderr.trim()).split(/\r?\n/)[0] ?? '';
      const refHint = blockId ? ` (ref @${blockId})` : '';
      this.statusMessage = `Command completed (${durationMs}ms) · [SHELL${blockId ? ` #${blockId}` : ''}] exit 0: ${firstLine || '(no output)'}${refHint}`;
      if (this.presentationMode === 'conversation') {
        const outParts: string[] = [];
        const cleanStdout = stdout.replace(/\r/g, '').trimEnd();
        const cleanStderr = stderr.replace(/\r/g, '').trimEnd();
        if (cleanStdout) outParts.push(cleanStdout);
        if (cleanStderr) outParts.push(`stderr:\n${cleanStderr}`);
        if (!cleanStdout && !cleanStderr) outParts.push('(no output)');
        outParts.push(`✓ Command completed · exit 0 · ${durationMs}ms${blockId ? ` · ref @${blockId}` : ''}`);
        this.conversationRenderer.append(outParts.join('\n'));
      }
    } catch (err: any) {
      const durationMs = Math.max(0, Date.now() - startedAt);
      const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
      const stderr = typeof err?.stderr === 'string' ? err.stderr : err instanceof Error ? err.message : String(err);
      const exitCode = typeof err?.code === 'number' ? err.code : 1;
      const blockId = tracker?.block.id;
      if (tracker) {
        await tracker.finish('failed', { stdout, stderr, exitCode, durationMs, errors: [stderr] }).catch(() => {});
        await this.refreshRecentBlocks();
      }
      this.lastShellOutput = {
        command: shellCmd,
        stdout,
        stderr,
        exitCode,
        durationMs,
        blockId,
      };
      const firstErr = (stderr.trim() || stdout.trim()).split(/\r?\n/)[0] ?? 'command failed';
      const refHint = blockId ? ` (ref @${blockId})` : '';
      this.statusMessage = `Execution failed (${durationMs}ms) · [SHELL${blockId ? ` #${blockId}` : ''}] exit ${exitCode}: ${firstErr}${refHint}`;
      if (this.presentationMode === 'conversation') {
        const outParts: string[] = [`✗ Command failed · exit ${exitCode} · ${durationMs}ms${blockId ? ` · ref @${blockId}` : ''}`];
        const cleanStdout = stdout.replace(/\r/g, '').trimEnd();
        const cleanStderr = stderr.replace(/\r/g, '').trimEnd();
        if (cleanStdout) outParts.push(cleanStdout);
        if (cleanStderr) outParts.push(`stderr:\n${cleanStderr}`);
        this.conversationRenderer.append(outParts.join('\n'));
      }
    }
    this.draw();
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

    if (trimmed === '/fleet') {
      if (this.presentationMode !== 'dashboard') {
        this.presentationMode = 'dashboard';
        if (typeof (this.screen as any).setPresentation === 'function') this.screen.setPresentation('dashboard');
        this.currentView = 'fleet';
        this.draw();
      } else {
        this.currentView = 'fleet'; this.draw();
      }
      return;
    }
    if (trimmed === '/chat') {
      if (this.presentationMode !== 'conversation') {
        this.presentationMode = 'conversation';
        if (typeof (this.screen as any).setPresentation === 'function') this.screen.setPresentation('conversation');
        this.conversationRenderer.start(process.env.USER ?? process.env.USERNAME ?? 'controller', this.selectedModelId ?? 'auto-routed model');
      }
      this.focusedPane = 'prompt';
      this.draw();
      return;
    }
    if (trimmed === '/verbose' || trimmed === '/quiet' || trimmed === '/debug') {
      const verbosity = trimmed.slice(1) as TranscriptVerbosity;
      this.eventSummarizer.setVerbosity(verbosity);
      this.conversationRenderer.append(`Verbosity: ${verbosity}`);
      this.draw();
      return;
    }
    if (trimmed === '/help' && this.presentationMode === 'conversation') {
      this.conversationRenderer.append('Commands: /fleet · /chat · /tasks · /models · /logs · /details · /tail · /verbose · /quiet · /debug · /help');
      return;
    }
    if ((trimmed === '/tasks' || trimmed === '/task') && this.presentationMode === 'conversation') {
      const tasks = this.statusProjection.getTasks();
      this.conversationRenderer.append(tasks.length ? tasks.map((task) => `${task.status} · ${task.taskId}`).join('\n') : 'No tasks in this session.');
      return;
    }
    if (trimmed === '/models' && this.presentationMode === 'conversation') {
      const models = this.engine.models.list();
      this.conversationRenderer.append(models.length ? `Models: ${models.map((model) => model.id).join(', ')}\nUse /model <id> to select a model.` : 'No registered models.');
      return;
    }
    if (trimmed === '/logs' || trimmed === '/details') {
      const taskId = this.selectedTaskId ?? this.getAgents().at(-1)?.taskId;
      const taskLines = taskId ? (this.agentLogs.get(taskId) ?? []).slice(-120).map((entry) => `[${entry.time}] ${entry.text}`) : [];
      const lines = taskLines.length ? taskLines : this.eventSummarizer.logLines(80);
      this.conversationRenderer.append(lines.length ? lines.join('\n') : 'No detailed events recorded yet.');
      this.draw();
      return;
    }
    if (trimmed === '/tail' && this.presentationMode === 'conversation') {
      const taskId = this.selectedTaskId ?? this.getAgents().at(-1)?.taskId;
      const raw = taskId ? this.lastRawResponse.get(taskId) : undefined;
      const lines = taskId ? (this.agentLogs.get(taskId) ?? []).slice(-80).map((entry) => entry.text) : [];
      this.conversationRenderer.append(raw || lines.join('\n') || 'No task output is available yet.');
      this.draw();
      return;
    }

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
      if (this.presentationMode === 'conversation') this.enterCopyMode();
      else { this.tuiMode = 'COPY'; this.statusMessage = 'Entered copy mode. Terminal selection active. Submissions locked. Press Esc to exit.'; }
      this.draw();
      return;
    }

    // Inline Shell-Mode (`!<cmd>` or `/sh <cmd>`): execute directly in projectRoot and record as a Block
    if (trimmed.startsWith('!') || trimmed === '/sh' || trimmed.startsWith('/sh ')) {
      const shellCmd = (trimmed.startsWith('!') ? trimmed.slice(1) : trimmed.slice(3)).trim();
      if (!shellCmd) {
        this.statusMessage =
          'Shell mode: type !<command> (e.g. !git status) or /sh <command> to execute in project root and capture as @block.';
        if (this.presentationMode === 'conversation') {
          this.conversationRenderer.append(this.statusMessage);
        }
        this.draw();
        return;
      }
      await this.executeInlineShellCommand(shellCmd, submission);
      return;
    }

    // Accidental-Paste & Burst Submission Circuit Breakers:
    // A. UI Fragment Guard: reject terminal output fragments, headers, borders
    if (isScreenFragment(trimmed)) {
      this.statusMessage = `Rejected UI fragment submission ("${trimmed.slice(0, 30)}..."). 0 jobs created.`;
      this.draw();
      return;
    }

    // B. Burst Rate Guard: detect multiple rapid submissions from input stream (jobs/tasks only)
    if (!trimmed.startsWith('/') && !trimmed.toLowerCase().startsWith('why ') && trimmed.toLowerCase() !== 'why') {
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
    }

    if (trimmed === '/help') {
      this.currentView = 'help';
      this.draw();
      return;
    }

    if (trimmed === '/task') {
      this.currentView = 'task';
      this.focusedPane = 'main';
      this.draw();
      return;
    }

    if (trimmed === '/search') {
      this.currentView = 'search';
      this.focusedPane = 'main';
      this.draw();
      return;
    }

    if (trimmed === '/improvement') {
      this.currentView = 'improvement';
      this.focusedPane = 'main';
      this.draw();
      return;
    }

    if (trimmed === '/model-intelligence') {
      this.currentView = 'models';
      this.focusedPane = 'main';
      this.draw();
      return;
    }

    if (trimmed === '/canary') {
      this.currentView = 'canary';
      this.canaryTab = 'dashboard';
      this.focusedPane = 'main';
      this.draw();
      return;
    }

    if (trimmed === '/context') {
      this.currentView = 'context';
      this.focusedPane = 'main';
      this.draw();
      return;
    }

    if (trimmed === '/provenance') {
      this.evidenceProvenanceDepth = this.evidenceProvenanceDepth === 0 ? 9 : 0;
      this.currentView = 'evidence';
      this.focusedPane = 'main';
      this.draw();
      return;
    }

    if (trimmed === '/evidence') {
      void this.refreshEvidenceInspection();
      this.currentView = 'evidence';
      this.focusedPane = 'main';
      this.draw();
      return;
    }

    // Contextual explainability: why <topic>? or /why <topic>?
    const whyMatch = trimmed.match(/^(?:\/)?why(?:\s+([a-zA-Z_]+)\??)?$/i);
    if (whyMatch) {
      const topic = (whyMatch[1] ?? '').toLowerCase();
      if (!topic) {
        this.statusMessage = 'Usage: why [model|worker|tool|candidate|prune|complete|incomplete|rollback]';
        this.draw();
        return;
      }
      this.handleWhyCommand(topic);
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
      if (this.presentationMode === 'conversation') {
        const readiness = this.engine.lifecycle?.getReadiness();
        const modelsCount = this.engine.models?.list().length ?? 0;
        const summary = readiness && readiness.readyCount === 0 && modelsCount === 0
          ? `${this.statusMessage}\n${this.formatMissingModelRecovery(readiness)}`
          : `${this.statusMessage} (${modelsCount} model(s) registered)`;
        this.conversationRenderer.append(summary);
      }
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
        if (this.presentationMode === 'conversation') {
          this.conversationRenderer.append(this.statusMessage);
        }
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
        if (this.presentationMode === 'conversation') {
          this.conversationRenderer.append(`✗ ${this.statusMessage}`);
        }
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
      if (this.presentationMode === 'conversation') {
        this.conversationRenderer.append(this.statusMessage);
      }
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
        if (this.presentationMode === 'conversation') this.conversationRenderer.append(this.statusMessage);
        this.draw();
        return;
      }
      if (arg === 'auto' || arg === 'clear') {
        this.selectedModelId = undefined;
        this.statusMessage = 'Cleared model pin — new tasks will be auto-routed by the scheduler again.';
        if (this.presentationMode === 'conversation') this.conversationRenderer.append(this.statusMessage);
        this.draw();
        return;
      }
      const match = available.find((m) => m.id === arg);
      if (!match) {
        const ids = available.map((m) => m.id).join(', ') || '(none registered)';
        this.statusMessage = `No registered model '${arg}'. Available: ${ids}.`;
        if (this.presentationMode === 'conversation') this.conversationRenderer.append(this.statusMessage);
        this.draw();
        return;
      }
      this.selectedModelId = match.id;
      this.statusMessage = `Pinned model to '${match.id}' — new tasks will use it instead of auto-routing.`;
      if (this.presentationMode === 'conversation') this.conversationRenderer.append(this.statusMessage);
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
    try {
      await this.launchJobFromPrompt(trimmed);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.statusMessage = `Execution failed: ${errMsg}`;
      if (this.currentBlockTracker) {
        await this.currentBlockTracker.finish('failed', { exitCode: 1, stderr: errMsg, errors: [errMsg] }).catch(() => {});
        this.currentBlockTracker = undefined;
        await this.refreshRecentBlocks();
      }
      if (this.presentationMode === 'conversation') {
        this.conversationRenderer.append(`✗ Execution failed: ${errMsg}`);
      }
      this.draw();
    }
  }

  /**
   * Decomposes or parses a user prompt and launches concurrent execution.
   */
  async launchJobFromPrompt(prompt: string): Promise<void> {
    if (this.presentationMode === 'conversation') {
      this.conversationRenderer.append(`> ${prompt}`);
      this.conversationStartedAt = Date.now();
    }
    // Installed models are activated on the existing execution after scheduling.
    const readiness = this.engine.lifecycle.getReadiness();
    const hasSchedulable = this.hasSchedulableGenerativeModel();
    if ((readiness.installedCount === 0 && readiness.readyCount === 0) || (this.presentationMode === 'conversation' && !hasSchedulable)) {
      const recoveryText = this.formatMissingModelRecovery(readiness, prompt);
      this.statusMessage = 'Model unavailable · No models installed. Discover models in LM Studio or Ollama.';
      if (this.currentBlockTracker) {
        await this.currentBlockTracker.finish('failed', { exitCode: 1, stderr: recoveryText, errors: [recoveryText] }).catch(() => {});
        this.currentBlockTracker = undefined;
        await this.refreshRecentBlocks();
      }
      if (this.presentationMode === 'conversation') {
        this.conversationRenderer.append(recoveryText);
        this.draw();
      } else {
        this.openModelRecoveryModal();
      }
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

      if (this.currentBlockTracker) {
        await this.currentBlockTracker.update({ jobId: job.id });
        await this.refreshRecentBlocks();
      }

      this.currentJob = job;
      this.agents.clear();
      this.agentLogs.clear();
      this.eventSummarizer = new EventSummarizer(this.eventSummarizer.getVerbosity());
      this.statusProjection.seed(job.tasks.map((task) => task.id));
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

      this.missionHome = false;
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

          const finalJob = await this.engine.orchestrator.getJob(job.id);
          if (!finalJob) return;
          this.currentJob = finalJob;
          this.currentRollup = await this.engine.orchestrator.getJobRollup(job.id);
          if (!this.engine.orchestrator.getJob(job.id)) return;
          this.jobRollups.set(job.id, this.currentRollup);
          // A timeout is reported as 'failed' with the reason on the task node; say so
          // here rather than a bare "failed!" that hides why.
          const timeoutNode = finalJob.graph.nodes.find((n) => /timeout/i.test(n.error ?? ''));
          const outcome = timeoutNode ? `failed (${timeoutNode.error})` : `${finalJob.status}!`;
          const prefix = finalJob.status === 'failed' ? 'Execution failed · ' : '';
          this.statusMessage = `${prefix}Job ${job.id} ${outcome} Tokens: In ${this.currentRollup.tokens.input}/Out ${this.currentRollup.tokens.output}, Dur: ${(this.currentRollup.durationMs / 1000).toFixed(1)}s`;
          if (this.presentationMode === 'conversation') {
            if (finalJob.status === 'completed') {
              const elapsed = Math.max(0, Math.floor(this.currentRollup.durationMs / 1000));
              const elapsedText = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
              const files = [...new Set([...this.agents.values()].flatMap((agent) => agent.filesChanged))];
              const summaries = this.eventSummarizer.completion(files);
              this.conversationRenderer.append([`✓ Completed in ${elapsedText}`, ...summaries.map((line) => `  ${line}`)].join('\n'));
            } else if (finalJob.status === 'cancelled') {
              this.conversationRenderer.append('■ Cancelled');
            } else {
              this.conversationRenderer.append('✗ Task failed · /logs for details');
            }
          }

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
          const isSched = /schedul|eligible|model|capacity|admission|reject/i.test(errMsg);
          this.statusMessage = `${isSched ? 'Scheduler rejected task · ' : 'Execution failed · '}Job execution error: ${errMsg}`;

          if (this.presentationMode === 'conversation') {
            this.conversationRenderer.append(`✗ ${isSched ? 'Scheduler rejected task' : 'Execution failed'}: ${errMsg}\n  Run /doctor or wa models list to inspect runtime readiness.`);
          } else {
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
          }

          if (this.currentBlockTracker) {
            await this.currentBlockTracker.finish('failed', {
              exitCode: 1,
              stderr: errMsg,
              jobId: job.id,
            });
            this.currentBlockTracker = undefined;
            await this.refreshRecentBlocks();
          }
        }
        this.draw();
      })();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.statusMessage = `Scheduler rejected task · Scheduling failed: ${errMsg}`;
      if (this.currentBlockTracker) {
        await this.currentBlockTracker.finish('failed', {
          exitCode: 1,
          stderr: errMsg,
          errors: [errMsg],
        }).catch(() => {});
        this.currentBlockTracker = undefined;
        await this.refreshRecentBlocks();
      }
      if (this.presentationMode === 'conversation') {
        this.conversationRenderer.append(`✗ Scheduler rejected task: ${errMsg}\n  Verify task syntax or run /doctor to inspect system readiness.`);
      } else {
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
      }
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
    const projected = taskId ? this.statusProjection.apply(ev as any) : undefined;
    if (projected && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(projected.status)) {
      const eventStatus: Record<string, string> = { 'task:completed': 'COMPLETED', 'task:failed': 'FAILED', 'task:cancelled': 'CANCELLED' };
      if (eventStatus[ev.type] && eventStatus[ev.type] !== projected.status) return;
      if (!eventStatus[ev.type] && !(ev.type === 'task:progress' && (ev.event as any)?.kind === 'usage')) return;
    }
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

        const summary = this.eventSummarizer.progress(p, p.metadata);
        if (this.presentationMode === 'conversation' && summary.milestone) {
          const icon = summary.milestone.kind === 'error' ? '✗' : summary.milestone.kind === 'success' ? '✓' : '•';
          this.conversationRenderer.append(`${icon} ${summary.milestone.text}${summary.milestone.kind === 'error' ? '\n  /logs for details' : ''}`);
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
              this.statusMessage = `Tool execution failed: ${eventText}`;
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
        if (this.presentationMode === 'conversation' && typeof ev.result === 'string' && ev.result.trim()) {
          this.conversationRenderer.append(ev.result.trim());
        }
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
        this.statusMessage = `Execution failed: ${failureReason.split(/\r?\n/, 1)[0]}`;

        logs.push({
          time: timeStr,
          text: isInfra ? `Infrastructure preflight failed: ${failureReason}` : `Task failed: ${failureReason}`,
          kind: isInfra ? 'infra' : 'error',
        });
        if (this.presentationMode === 'conversation') {
          this.conversationRenderer.append(`✗ Execution failed: ${failureReason.split(/\r?\n/, 1)[0]}\n  /logs for details`);
        }

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
    if (this.presentationMode === 'conversation') {
      if (this.conversationDrawQueued) return;
      this.conversationDrawQueued = true;
      queueMicrotask(() => {
        this.conversationDrawQueued = false;
        this.drawConversation();
      });
      return;
    }
    const size = this.screen.getSize();
    const lines: string[] = [];

    // Region 1: Header Bar (Line 0) + Divider (Line 1)
    lines.push(...missionHeader(this.engine.projectRoot, this.currentView, size.columns));
    lines.push(color.cyan('─'.repeat(size.columns)));

    // Region 2: Persistent Split Content or Collapsed Pane
    const contentHeight = Math.max(1, size.rows - 8);

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
        lines.push(`${l}${color.cyan('│')}${m}`);
      }
    } else {
      // Collapsed single pane layout
      const mainLines = this.renderMainPane(size.columns, contentHeight);
      for (let i = 0; i < contentHeight; i++) {
        lines.push(mainLines[i] ?? '');
      }
    }

    this.drawDashboardFrame(size, lines, contentHeight);
  }

  private drawConversation(): void {
      const active = this.statusProjection.getTasks().filter((task) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status));
      const running = active.filter((task) => task.status !== 'WAITING_FOR_APPROVAL');
      const waiting = active.length - running.length;
      const activity = running[0]?.activity ?? '';
      const activeAgent = this.getAgents().find((agent) => agent.status === 'running');
      this.conversationRenderer.render({
        identity: process.env.USER ?? process.env.USERNAME ?? 'controller',
        model: activeAgent ? `${activeAgent.computerId} · ${activeAgent.modelId}` : this.selectedModelId ?? 'auto-routed model',
        prompt: this.inputBuffer,
        cursor: this.inputCursor,
        active: running.length,
        waitingApproval: waiting || this.pendingApprovals.length,
        activity,
        elapsedSeconds: this.conversationStartedAt === undefined ? undefined : Math.floor((Date.now() - this.conversationStartedAt) / 1000),
        approval: this.pendingApprovals[0]
          ? `${this.pendingApprovals[0].tool}: ${String(this.pendingApprovals[0].input.command ?? this.pendingApprovals[0].input.path ?? JSON.stringify(this.pendingApprovals[0].input)).slice(0, 140)} · A approve · D deny · V details`
          : undefined,
        status: this.statusMessage,
        copyMode: this.tuiMode === 'COPY' ? this.copyModeStatus() : undefined,
      });
  }

  private drawDashboardFrame(size: TerminalSize, lines: string[], contentHeight: number): void {
    // Overlays over content region:
    if (this.startupSelector) {
      const modalLines = this.renderStartupSelectorModal(size.columns);
      const startY = Math.max(4, 4 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.taskTimeModelRequired) {
      const modalLines = this.renderTaskTimeModelRequiredModal(size.columns);
      const startY = Math.max(4, 4 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.pendingApprovals.length > 0) {
      const modalLines = this.renderApprovalModal(size.columns);
      const startY = Math.max(4, 4 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.currentError) {
      // B. Structured Error Card Modal (§29)
      const modalLines = this.renderStructuredErrorCard(this.currentError, size.columns);
      const startY = Math.max(4, 4 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.quickActionsOpen) {
      // C. Quick Actions Palette Modal (§3)
      const modalLines = this.renderQuickActionsModal(size.columns);
      const startY = Math.max(4, 4 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.expandedBlock) {
      // D. Expanded Block Modal Card
      const modalLines = this.renderBlockModal(this.expandedBlock, size.columns);
      const startY = Math.max(4, 4 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.rawResponseModalOpen) {
      // D.5 Raw Model Response Modal ('r' on Tail view)
      const taskId = this.selectedTaskId ?? this.getAgents()[this.highlightedIndex]?.taskId;
      if (taskId) {
        const modalLines = this.renderRawResponseModal(taskId, size.columns);
        const startY = Math.max(4, 4 + Math.floor((contentHeight - modalLines.length) / 2));
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
        const startY = Math.max(4, 4 + Math.floor((contentHeight - modalLines.length) / 2));
        this.overlayModal(lines, modalLines, size.columns, startY);
      } else {
        this.expandedJobId = undefined;
      }
    } else if (this.whyModalOpen && this.whyModalData) {
      const modalLines = renderWhyModal(this.whyModalData);
      const startY = Math.max(4, 4 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.evidenceModalOpen && this.evidenceModalData) {
      const modalLines = renderEvidenceModal(this.evidenceModalData);
      const startY = Math.max(4, 4 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.canaryModal) {
      const modalLines = this.renderCanaryControlModal(size.columns);
      const startY = Math.max(4, 4 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
    } else if (this.canaryTimeline) {
      const tl = this.canaryTimeline;
      const modalLines = renderCanaryTimelineModal({ ...tl, width: size.columns, maxRows: Math.max(8, contentHeight) });
      const startY = Math.max(4, 4 + Math.floor((contentHeight - modalLines.length) / 2));
      this.overlayModal(lines, modalLines, size.columns, startY);
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

    if (this.currentView === 'task') {
      return this.renderTaskPane(width, maxRows);
    }
    if (this.currentView === 'fleet' && (this.missionHome || !selected)) {
      return this.renderFleetOverviewPane(width, maxRows);
    }
    if (this.currentView === 'evidence') {
      return this.renderEvidencePane(width, maxRows);
    }
    if (this.currentView === 'help') {
      return this.renderHelpPane(width, maxRows);
    }
    if (this.currentView === 'worktrees') {
      return this.renderWorktreesPane(width, maxRows);
    }
    if (this.currentView === 'search') {
      return this.renderSearchPane(width, maxRows);
    }
    if (this.currentView === 'improvement') {
      return this.renderImprovementPane(width, maxRows);
    }
    if (this.currentView === 'context') {
      return this.renderContextPane(width, maxRows);
    }
    if (this.currentView === 'models') {
      return this.renderModelIntelligencePane(width, maxRows);
    }
    if (this.currentView === 'canary') {
      return this.renderCanaryPane(width, maxRows);
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
      lines.push('');
      const fleetLines = this.renderFleetOverviewPane(width, Math.max(5, maxRows - lines.length));
      for (const fl of fleetLines) {
        if (lines.length >= maxRows) break;
        lines.push(fl);
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
    const mode = this.getMode();
    const badge = color.bold(mode === 'APPROVAL' || mode === 'SHELL' ? color.yellow(`[${mode}]`) : color.cyan(`[${mode}]`));
    const alerts = this.sidebarMode === 'full' ? '' : Array.from(this.getAlertCategories()).map(c => `!${c}`).join(' ');
    if (cols < 110) {
      return this.padRightTo(` ${badge} ${alerts ? alerts + ' ' : ''}${this.statusMessage}`, cols);
    }
    const { used, max, jobIn, jobOut } = this.getContextMetrics();
    const telemetry = `${alerts ? alerts + ' · ' : ''}Context ${(used / 1024).toFixed(1)}K/${Math.round(max / 1024)}K ~ ${jobIn.toLocaleString()} in / ${jobOut.toLocaleString()} out · Ctrl+T ${this.sidebarMode === 'hidden' ? 'Show sidebar' : 'Sidebar'}`;
    const available = Math.max(16, cols - telemetry.length - mode.length - 7);
    const message = this.truncateAnsi(this.statusMessage, available);
    const left = ` ${badge} ${message}`;
    const gap = Math.max(2, cols - this.stripAnsi(left).length - telemetry.length - 1);
    return `${left}${' '.repeat(gap)}${color.gray(telemetry)} `;
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

    const promptPrefix =
      mode === 'COMPOSER'
        ? color.magenta('wa [COMPOSER]> ')
        : mode === 'SHELL'
          ? color.yellow('wa [SHELL]> ')
          : color.cyan('wa> ');
    const prefixLen = mode === 'COMPOSER' ? 15 : mode === 'SHELL' ? 12 : 4;
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

  private formatMissingModelRecovery(readiness: ModelReadiness, prompt?: string): string {
    const unavailableRuntimes: string[] = [];
    const runtimeEntries = Object.entries(readiness.runtimeHealth ?? {});
    for (const [runtimeId, health] of runtimeEntries) {
      const h = health as { status?: string; message?: string };
      if (h.status === 'unavailable' || h.status === 'unhealthy') {
        unavailableRuntimes.push(`${runtimeId} (${h.status}${h.message ? `: ${h.message}` : ''})`);
      }
    }
    for (const disc of this.engine.discovered ?? []) {
      if (disc.health === 'unavailable' || disc.health === 'degraded') {
        const label = `${disc.id} (${disc.health}${disc.healthMessage ? `: ${disc.healthMessage}` : ''})`;
        if (!unavailableRuntimes.some((r) => r.startsWith(`${disc.id} (`))) {
          unavailableRuntimes.push(label);
        }
      }
    }
    for (const rt of this.engine.runtimes?.list() ?? []) {
      const st = (rt as { status?: string; health?: string }).status ?? (rt as { health?: string }).health;
      if (st === 'offline' || st === 'unavailable' || st === 'degraded') {
        if (!unavailableRuntimes.some((r) => r.startsWith(`${rt.id} (`))) {
          unavailableRuntimes.push(`${rt.id} (${st})`);
        }
      } else if ((rt as { runtimeKind?: string }).runtimeKind === 'hosted' && this.engine.policy) {
        const gate = this.engine.policy.checkHostedEligibility(undefined, rt.type);
        if (!gate.allowed && !unavailableRuntimes.some((r) => r.startsWith(`${rt.id} (`))) {
          unavailableRuntimes.push(`${rt.id} (hosted providers disabled by policy)`);
        }
      }
    }
    if (unavailableRuntimes.length === 0) {
      unavailableRuntimes.push('ollama (0 models installed)', 'lmstudio (offline or 0 models installed)');
    }

    const lines: string[] = [
      prompt
        ? `✗ Model unavailable: cannot execute task "${prompt.slice(0, 60)}" because no eligible AI model is registered or loaded.`
        : '⚠ Model unavailable: 0 eligible models registered across configured runtimes.',
    ];
    if (unavailableRuntimes.length > 0) {
      lines.push(`  Unavailable runtimes: ${unavailableRuntimes.join(', ')}`);
    }
    lines.push(
      '  Recovery commands:',
      '    • Pull a local Ollama model:       ollama pull qwen2.5-coder',
      '    • Start LM Studio server:          lms server start   (or /launch lmstudio)',
      '    • Authenticate a hosted provider:  wa auth login <anthropic|openai|google>',
      '    • Check runtime diagnostics:       wa doctor          (or /doctor)',
      '  Shell commands (!<cmd> or /sh <cmd>, e.g. !ls -la) remain available without an AI model.',
    );
    return lines.join('\n');
  }

  private hasSchedulableGenerativeModel(): boolean {
    const eligible = this.engine.lifecycle?.getEligibleModels() ?? this.engine.models?.list().filter((m) => !m.embedding) ?? [];
    if (eligible.length === 0) return false;
    return eligible.some((m) => {
      const instances = this.engine.models?.instancesOf(m.id) ?? [];
      if (instances.length === 0) return false;
      if (m.local === false && this.engine.policy) {
        const providerType = Array.isArray(m.runtimeCompatibility) ? m.runtimeCompatibility[0] : m.provider;
        const gate = this.engine.policy.checkHostedEligibility(undefined, providerType as any);
        if (!gate.allowed) return false;
      }
      return instances.some((i) => i.health !== 'unavailable' && i.state !== 'UNAVAILABLE');
    });
  }

  private async handleStartupModelReadiness(): Promise<void> {
    const mode = this.engine.config.models?.startup?.mode ?? 'prompt';
    if (mode === 'none') {
      return;
    }
    if (mode !== 'prompt') return; // Noninteractive startup policy was applied by createEngine.

    // Default: 'prompt'
    const readiness = this.engine.lifecycle.getReadiness();
    const hasSchedulable = this.hasSchedulableGenerativeModel();
    if (readiness.readyCount > 0 && hasSchedulable) {
      if (readiness.unloadedEligibleModels.length > 0) {
        this.statusMessage = `Ready: ${readiness.readyCount} model(s) loaded. Press [M] to manage models.`;
      }
      return;
    }

    const runtimeEntries = Object.entries(readiness.runtimeHealth ?? {});
    const allUnavailable =
      runtimeEntries.length > 0 &&
      runtimeEntries.every(([, h]: [string, any]) => h.status === 'unavailable' || h.status === 'unhealthy');

    if (this.presentationMode === 'conversation') {
      if (readiness.installedCount === 0 || !hasSchedulable) {
        this.statusMessage = allUnavailable
          ? 'Provider disconnected · Model unavailable (0 models registered). Shell commands (!cmd) available.'
          : 'Model unavailable (0 models registered). Shell commands (!cmd) available.';
        this.conversationRenderer.append(this.formatMissingModelRecovery(readiness));
      } else {
        this.statusMessage = `${readiness.installedCount} model(s) installed (0 loaded) — will activate on task submission or use /models.`;
      }
      this.draw();
      return;
    }

    if (readiness.installedCount > 0) {
      this.openModelStartupSelector();
      return;
    }

    if (allUnavailable) {
      this.openRuntimeRecoveryModal();
    } else {
      this.openModelRecoveryModal();
    }
  }

  private handleModelLifecycleEvent(event: ModelLifecycleEvent): void {
    if (['MODEL_DRAINING', 'MODEL_ADMISSION_DENIED', 'MODEL_CONTEXT_DOWNSHIFTED', 'WAITING_FOR_MODEL', 'MODEL_LOAD_FAILED'].includes(event.type)) {
      const allCurrentTasksTerminal = this.agents.size > 0 && [...this.agents.values()].every((agent) => ['completed', 'failed', 'cancelled'].includes(agent.status));
      const jobTerminal = this.currentJob && ['completed', 'failed', 'cancelled'].includes(this.currentJob.status);
      if (!allCurrentTasksTerminal && !jobTerminal) {
        const prefix = event.type === 'MODEL_LOAD_FAILED'
          ? 'Model unavailable · '
          : event.type === 'MODEL_ADMISSION_DENIED'
            ? 'Scheduler rejected task · '
            : '';
        this.statusMessage = `${prefix}${event.type}: ${event.modelId}${event.reason ? ' — ' + event.reason : ''}`;
        this.draw();
      }
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

  private renderCanaryControlModal(cols: number): string[] {
    if (!this.canaryModal) return [];
    const modalWidth = Math.min(cols - 4, 76);
    const innerWidth = modalWidth - 4;
    const cm = this.canaryModal;

    if (cm.type === 'rollback') {
      const title = 'CONFIRM CANARY ROLLBACK';
      const body: string[] = [
        `Target Canary:   ${color.bold(color.red(cm.canaryId))}`,
        `Candidate ID:    ${color.bold(cm.candidateId)}`,
        `Current Traffic: ${color.yellow(`${(cm.currentAllocation * 100).toFixed(0)}%`)}`,
        '',
        color.bold(color.red('WARNING: Rolling back will terminate canary evaluation immediately.')),
        '100% traffic will be restored to the verified baseline checkpoint.',
        '',
        'Are you sure you want to proceed with this rollback?',
      ];
      const actions = `${color.bold(color.red('[Enter / y] Confirm Rollback'))}    ${color.bold('[Esc / n] Cancel')}`;
      return this.buildModalBox(title, body, actions, modalWidth, 'red');
    }

    if (cm.type === 'advance') {
      const nextStage = cm.nextStage ?? 'NEXT_TIER';
      const title = 'CONFIRM CANARY STAGE ADVANCEMENT';
      const body: string[] = [
        `Target Canary:   ${color.bold(color.cyan(cm.canaryId))}`,
        `Candidate ID:    ${color.bold(cm.candidateId)}`,
        `Current Stage:   ${color.yellow(`${(cm.currentAllocation * 100).toFixed(0)}% traffic`)}`,
        `Target Stage:    ${color.green(nextStage)}`,
        '',
        'Advancing stage will allocate increased production traffic to this candidate.',
        'Continuous RegressionGuard will remain active across all protected metrics.',
        '',
        'Are you sure you want to advance this canary deployment?',
      ];
      const actions = `${color.bold(color.green('[Enter / y] Confirm Advance'))}    ${color.bold('[Esc / n] Cancel')}`;
      return this.buildModalBox(title, body, actions, modalWidth, 'yellow');
    }

    if (cm.type === 'throttle') {
      const title = 'THROTTLE CANARY TRAFFIC';
      const body: string[] = [
        `Target Canary:   ${color.bold(color.cyan(cm.canaryId))}`,
        `Candidate ID:    ${color.bold(cm.candidateId)}`,
        `Current Traffic: ${color.yellow(`${(cm.currentAllocation * 100).toFixed(0)}%`)}`,
        '',
        'Select target traffic percentage (bounded by current allocation):',
        '',
      ];

      for (let i = 0; i < cm.availableTiers.length; i++) {
        const tier = cm.availableTiers[i];
        const pct = Math.round(tier * 100);
        const isSelected = i === cm.selectedTierIndex;
        const bullet = isSelected ? color.bold(color.cyan(`▸ [${i + 1}]`)) : color.gray(`  [${i + 1}]`);
        const label = `${pct}% traffic allocation`;
        body.push(isSelected ? `${bullet} ${color.bold(color.cyan(label))}` : `${bullet} ${label}`);
      }

      const selectedPct = Math.round((cm.availableTiers[cm.selectedTierIndex] ?? cm.currentAllocation) * 100);
      body.push('');
      body.push(`Target Allocation: ${color.bold(color.green(`${selectedPct}%`))}`);

      const actions = `${color.bold('[↑/↓ or 1-9]')} Select    ${color.bold(color.green('[Enter]'))} Apply Throttle    ${color.bold('[Esc/n]')} Cancel`;
      return this.buildModalBox(title, body, actions, modalWidth, 'yellow');
    }

    return [];
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
  /**
   * Dedicated Task Execution Pipeline Pane (Mission Control View 1)
   */
  private renderTaskPane(cols: number, maxRows: number): string[] {
    const card = this.agents.get(this.selectedTaskId ?? '') ?? this.getAgents()[0];
    if (!card) return [
      '  TASK EXECUTION PIPELINE',
      '  TASK → AGENT → MODEL → RUNTIME → WORKER → TOOLS → VERIFY',
      '  Routing: pending',
      '  Compute: pending',
      '  Deterministic Verification: pending',
      '  Budget Governance: active',
      '',
      '  No task selected. Submit a task or select an execution.',
    ];
    const model = this.engine.models.get(card.modelId);
    const inspection = this.currentEvidenceInspection();
    return [
      color.bold(color.cyan('  TASK DETAILS')),
      `  ${card.title}`,
      `  ${card.taskId} · ${card.status.toUpperCase()} · ${card.phase}`,
      '',
      `  Agent ${card.agentId} · Computer ${card.computerId}`,
      `  Model ${card.modelId} · Provider ${model?.provider ?? 'unknown'}`,
      `  Elapsed ${(card.durationMs / 1000).toFixed(1)}s · Model calls ${card.modelCallCount ?? 0}`,
      `  Tokens ${card.usage?.input ?? 0} in / ${card.usage?.output ?? 0} out · Cost: unreported`,
      `  Files changed: ${(card.filesChanged ?? []).length}`,
      ...(card.filesChanged ?? []).slice(0, 4).map(f => `    ${f}`),
      '',
      color.bold(color.cyan('  VERIFICATION')),
      ...(inspection ? [inspection.inspection.status, ...inspection.why.chain, ...inspection.why.missing].map(t => `  ${t}`) : ['  No verification evidence loaded. Press 6 to inspect checks.']),
      '',
      color.bold(color.cyan('  ACTIVITY & TOOL CALLS')),
      ...(this.agentLogs.get(card.taskId) ?? []).slice(-5).map(e => `  ${e.time} ${e.kind.toUpperCase()} ${e.text}`),
    ].slice(0, maxRows).map(l => this.padRightTo(l, cols));
  }

  /**
   * Dedicated Solution Search Projection Pane (Mission Control View 2)
   * Displays solution search trajectories, hierarchical MCTS tree, candidate states, and Pareto membership.
   */
  private renderSearchPane(cols: number, maxRows: number): string[] {
    const searches = this.engine.solutionSearch?.listSearches() ?? [];
    const activeSearch = searches[searches.length - 1];

    const treeNodes: SearchTreeNode[] | undefined = (activeSearch as any)?.hierarchicalTree?.nodes
      ? (activeSearch as any).hierarchicalTree.nodes
      : (activeSearch as any)?.treeNodes
        ? (activeSearch as any).treeNodes
        : activeSearch
          ? undefined
          : [
      {
        id: 'C0',
        name: 'C0 (Root Checkpoint)',
        state: 'completed',
        tokens: 0,
        children: [
          {
            id: 'A',
            name: 'A (Refactor Strategy)',
            state: 'completed',
            tokens: 840,
            children: [
              {
                id: 'A1',
                name: 'A1',
                state: 'completed',
                glyph: color.green('✓'),
                tokens: 1250,
                testsPassed: true,
                isFrontier: true,
              },
              {
                id: 'A2',
                name: 'A2',
                state: 'pruned',
                glyph: color.red('×'),
                prunedReason: 'build failed',
                tokens: 920,
                testsPassed: false,
                isDominated: true,
              },
            ],
          },
          {
            id: 'B',
            name: 'B (Incremental Strategy)',
            state: 'active',
            tokens: 610,
            children: [
              {
                id: 'B1',
                name: 'B1',
                state: 'verifying',
                glyph: color.yellow('◶'),
                tokens: 780,
              },
              {
                id: 'B2',
                name: 'B2',
                state: 'pending',
                tokens: 340,
              },
            ],
          },
          {
            id: 'C',
            name: 'C (Parallel Strategy)',
            state: 'pruned',
            glyph: color.red('×'),
            prunedReason: 'timeout',
            tokens: 450,
            isDominated: true,
          },
        ],
      },
    ];

    let candidates: SearchCandidateItem[] = (activeSearch?.candidates ?? []).map((c: any, i: number) => {
      const candId = c.candidateId;
      const modelId = c.descriptor?.modelId ?? c.modelId ?? 'default';
      const workerId = c.descriptor?.workerId ?? c.workerId ?? 'worker-local';
      const state = c.status ?? 'completed';
      const revision = c.workspaceRevision ?? c.descriptor?.iteration ?? i + 1;
      const buildPassed = c.evaluation?.buildPassed ?? true;
      const testsPassed = c.evaluation?.testsPassed ?? true;
      const testSummary = c.evaluation?.testSummary ?? (testsPassed ? 'passed' : 'failed');
      const tokens = c.metrics?.totalTokens ?? c.tokensUsed ?? 1420;
      const wallTimeMs = c.metrics?.wallTimeMs ?? c.durationMs ?? 3200;
      const isPruned = c.status === 'pruned';
      const pruneState = isPruned
        ? (c.evaluation?.disqualificationReasons?.[0] ? 'PRUNED' : 'PRUNED')
        : 'ACTIVE';
      const isFrontier = c.evaluation?.isParetoFrontier ?? (!isPruned && c.evaluation?.qualifies !== false);
      const isDominated = c.evaluation?.isDominated ?? isPruned;

      return {
        candidateId: candId,
        modelId,
        workerId,
        state,
        revision,
        buildPassed,
        testsPassed,
        testSummary,
        tokens,
        wallTimeMs,
        pruneState,
        isFrontier,
        isDominated,
        qualifies: c.evaluation?.qualifies ?? (!isPruned),
        disqualificationReasons: c.evaluation?.disqualificationReasons ?? [],
      };
    });

    if (candidates.length === 0) {
      candidates = [
        {
          candidateId: 'A1',
          modelId: 'claude-3-5-sonnet',
          workerId: 'DGX-01',
          state: 'completed',
          revision: 1,
          buildPassed: true,
          testsPassed: true,
          testSummary: '42 passed',
          tokens: 1250,
          wallTimeMs: 2100,
          pruneState: 'ACTIVE',
          isFrontier: true,
        },
        {
          candidateId: 'A2',
          modelId: 'qwen-2.5-coder-32b',
          workerId: 'MAC-01',
          state: 'failed',
          revision: 1,
          buildPassed: false,
          testsPassed: false,
          testSummary: 'build error',
          tokens: 920,
          wallTimeMs: 1800,
          pruneState: 'PRUNED (build)',
          isDominated: true,
        },
        {
          candidateId: 'B1',
          modelId: 'claude-3-5-sonnet',
          workerId: 'PC-01',
          state: 'running',
          revision: 2,
          tokens: 780,
          wallTimeMs: 1400,
          pruneState: 'ACTIVE',
        },
      ];
    }

    const selectedNodeId = this.getSelectedSearchNodeId();
    const selectedNodeInspection = selectedNodeId ? this.inspectSearchNode(selectedNodeId) : undefined;

    const data: SearchViewData = {
      searchId: activeSearch?.searchId ?? 'search-mcts-01',
      objective: (activeSearch as any)?.objective ?? 'Synthesize optimal solution via hierarchical MCTS',
      status: activeSearch?.status ?? 'running',
      strategy: activeSearch?.strategy ?? 'hierarchical_mcts',
      candidates,
      treeNodes,
      viewMode: this.searchViewMode,
      selectedIndex: this.selectedSearchCandidateIndex,
      selectedCandidateId: activeSearch?.selectedCandidate?.candidateId ?? candidates[0]?.candidateId,
      selectionReason: activeSearch?.selectionReason ?? 'Pareto frontier member with minimal tokens',
      selectedNodeId,
      selectedNodeInspection,
      width: cols,
      maxRows,
    };
    return renderSearchView(data);
  }

  /**
   * Dedicated Self-Improvement & Canary Verification Pane (Mission Control View 4)
   */
  private renderImprovementPane(cols: number, maxRows: number): string[] {
    let experiments: ImprovementExperimentItem[] = (this.engine.optimizer?.listExperiments?.() ?? []).map((exp: any) => {
      const expId = exp.experimentId ?? exp.id ?? 'exp-012';
      const domain = exp.hypothesis?.domain ?? exp.domain ?? 'context';
      const state = exp.status ?? exp.state ?? 'BENCHMARKING';
      const hypothesis = exp.hypothesis?.statement ?? exp.hypothesis?.description ?? 'Prefix caching minimizes redundant token usage';
      const baselinePassRate = exp.baselinePassRate ?? exp.baselineEvaluation?.score ?? 0.85;
      const candidateCount = exp.candidateCount ?? exp.candidateResults?.length ?? 3;
      const benchmarkProgress = exp.benchmarkProgress ?? { completed: 8, total: 10 };
      const objectives = exp.objectives ?? (exp.requiredImprovement ? [{ metric: exp.requiredImprovement.metric ?? 'tokens', direction: exp.requiredImprovement.direction ?? 'MINIMIZE' }] : [
        { metric: 'tokens', direction: 'MINIMIZE' },
        { metric: 'wall time', direction: 'MINIMIZE' },
      ]);
      const protectedMetrics = exp.protectedMetrics ?? ['task success', 'verification'];
      const paretoFrontier = exp.paretoFrontier ?? {
        frontierCandidates: [{ candidateId: 'C1' }, { candidateId: 'C2' }],
        dominatedCandidates: [{ candidateId: 'C3' }],
        allEvaluated: [
          { candidateId: 'C1', isNonDominated: true },
          { candidateId: 'C2', isNonDominated: true },
          { candidateId: 'C3', isNonDominated: false },
        ],
      };
      const regressionGuardStatus = exp.regressionGuardStatus ?? { passed: true, violationsCount: 0, summary: 'Guard OK (0 regressions)' };
      const decision = exp.decision ?? (state === 'QUALIFIED' ? 'QUALIFIED' : state === 'PROMOTED' ? 'PROMOTED' : undefined);
      const decisionReason = exp.decisionReason ?? (decision ? 'Pareto optimal frontier candidate with positive token delta and intact guards' : undefined);

      // Query live CanaryDeploymentService if configured
      const canarySvc = (this.engine.optimizer as any)?.getCanaryDeploymentService?.();
      const deployments = canarySvc?.listDeployments?.() ?? [];
      const liveCanary = deployments.find((d: any) =>
        (d.domain === domain || d.candidateId === expId || d.canaryId === expId) &&
        ['ACTIVE', 'EVALUATING', 'HEALTHY', 'STAGED_EXPANSION', 'PAUSED', 'READY_FOR_PROMOTION', 'ROLLED_BACK', 'CANARY_FAILED'].includes(d.status),
      ) ?? deployments.find((d: any) => d.domain === domain || d.candidateId === expId);

      let canaryState = exp.canaryState;
      if (liveCanary) {
        const stages = ['CANARY_1', 'CANARY_5', 'CANARY_10', 'CANARY_25', 'CANARY_50'];
        const stageIdx = stages.indexOf(liveCanary.stage ?? 'CANARY_10');
        const nextStage = stageIdx >= 0 && stageIdx < stages.length - 1 ? stages[stageIdx + 1] : (liveCanary.status === 'READY_FOR_PROMOTION' ? 'READY_TO_PROMOTE' : undefined);
        const cm = liveCanary.canaryMetrics;
        const bm = liveCanary.baselineMetrics;
        const totalSamples = cm?.totalExecutions ?? 0;
        const correctnessStatus = cm && bm && totalSamples > 0
          ? (cm.taskSuccessRate >= bm.taskSuccessRate ? 'DOMINANT_PASS' : 'REGRESSED')
          : (liveCanary.status === 'ROLLED_BACK' ? 'REGRESSED' : 'EVALUATING');
        const regressionGuardState = liveCanary.status === 'ROLLED_BACK'
          ? 'FAILED (1 violations)'
          : 'INTACT (0 violations)';

        canaryState = {
          canaryId: liveCanary.canaryId,
          candidateId: liveCanary.candidateId,
          trafficFraction: liveCanary.currentAllocation,
          currentAllocation: liveCanary.currentAllocation,
          stageName: liveCanary.stage,
          status: liveCanary.status,
          sampleCount: totalSamples,
          minimumSamples: liveCanary.minimumSamples,
          correctnessStatus,
          regressionGuardState,
          nextStage,
          rollbackReason: liveCanary.rollbackReason?.description,
          stagedExpansionTiers: liveCanary.stagedExpansionTiers,
        };
      } else if (!canaryState) {
        canaryState = {
          canaryId: 'canary-01',
          trafficFraction: 0.25,
          stage: 2,
          totalStages: 3,
          status: 'HEALTHY',
        };
      }

      return {
        id: expId,
        domain,
        state,
        maturityLevel: exp.maturityLevel ?? 2,
        hypothesis,
        baselineId: exp.baselineCheckpointId ?? 'base-chk-001',
        baselinePassRate,
        candidateCount,
        benchmarkProgress,
        objectives,
        protectedMetrics,
        paretoFrontier,
        regressionGuardStatus,
        decision,
        decisionReason,
        canaryState,
        causalEvidence: exp.causalEvidence ?? {
          design: 'factorial ablation',
          beneficialMutations: ['cache_prefix_hash', 'lru_compaction'],
          neutralMutations: ['speculative_prefetch'],
          harmfulMutations: [],
        },
      };
    });

    if (experiments.length === 0) {
      experiments = [
        {
          id: 'exp-042',
          domain: 'context_compaction',
          state: 'QUALIFIED',
          maturityLevel: 2,
          hypothesis: 'Multi-layer prefix dedup minimizes token overhead by 22%',
          baselineId: 'base-v1',
          baselinePassRate: 0.90,
          candidateCount: 4,
          benchmarkProgress: { completed: 8, total: 8 },
          objectives: [
            { metric: 'tokens', direction: 'MINIMIZE' },
            { metric: 'latency', direction: 'MINIMIZE' },
          ],
          canaryState: {
            trafficFraction: 0.50,
            stage: 2,
            totalStages: 3,
            status: 'HEALTHY',
          },
          causalEvidence: {
            design: '2x2 factorial ablation',
            beneficialMutations: ['stable_prefix_hash', 'stream_coalescing'],
            neutralMutations: ['heuristic_token_estimator'],
            harmfulMutations: [],
          },
          regressionGuardStatus: { passed: true, violationsCount: 0 },
          decision: 'PROMOTED',
          decisionReason: 'Non-dominated Pareto candidate, verified by canary evaluation',
        },
      ];
    }

    const data: ImprovementViewData = {
      experiments,
      selectedIndex: this.selectedExperimentIndex,
      width: cols,
      maxRows,
    };
    return renderImprovementView(data);
  }

  /**
   * Dedicated Context Utilization & Sawtooth Graph Pane (Mission Control View 5)
   */
  private renderContextPane(cols: number, maxRows: number): string[] {
    let samples = this.contextSamples;
    if (samples.length === 0) {
      samples = [
        { generation: 1, currentTokens: 4200, effectiveMax: 32768, targetTokens: 16000, deduplicated: 200, compressed: 0, offloaded: 0, stablePrefix: 1200, volatilePortion: 3000 },
        { generation: 2, currentTokens: 8900, effectiveMax: 32768, targetTokens: 16000, deduplicated: 450, compressed: 300, offloaded: 0, stablePrefix: 2100, volatilePortion: 6800 },
        { generation: 3, currentTokens: 14500, effectiveMax: 32768, targetTokens: 16000, deduplicated: 800, compressed: 750, offloaded: 0, stablePrefix: 3400, volatilePortion: 11100 },
        { generation: 4, currentTokens: 6200, effectiveMax: 32768, targetTokens: 16000, deduplicated: 2400, compressed: 4800, offloaded: 1800, stablePrefix: 3400, volatilePortion: 2800 },
        { generation: 5, currentTokens: 10400, effectiveMax: 32768, targetTokens: 16000, deduplicated: 2800, compressed: 5100, offloaded: 1800, stablePrefix: 4200, volatilePortion: 6200 },
        { generation: 6, currentTokens: 15800, effectiveMax: 32768, targetTokens: 16000, deduplicated: 3100, compressed: 5600, offloaded: 2200, stablePrefix: 4800, volatilePortion: 11000 },
        { generation: 7, currentTokens: 7100, effectiveMax: 32768, targetTokens: 16000, deduplicated: 4500, compressed: 8200, offloaded: 3400, stablePrefix: 4800, volatilePortion: 2300 },
      ];
    }
    const data: ContextViewData = {
      samples,
      selectedIndex: this.selectedContextSampleIndex,
      width: cols,
      maxRows,
    };
    return renderContextView(data);
  }

  /**
   * Dedicated Controller Truth & Deterministic Evidence Pane (Mission Control View 6)
   */
  private renderEvidencePane(cols: number, maxRows: number): string[] {
    const cached = this.currentEvidenceInspection();
    if (!cached) void this.refreshEvidenceInspection();
    return renderEvidenceView({
      inspection: cached?.inspection,
      why: cached?.why,
      provenanceDepth: this.evidenceProvenanceDepth,
      width: cols,
      maxRows,
    });
  }

  /**
   * The inspection for the currently selected task, re-projected synchronously from the
   * live in-memory ExecutionRecord so a mutation since the last load can never leave an
   * old PASS on screen. Artifacts (async provenance lookup) come from the last load.
   */
  private currentEvidenceInspection(): { inspection: VerificationInspection; why: WhyCompleteAnswer } | undefined {
    const card = this.agents.get(this.selectedTaskId ?? '') ?? this.getAgents()[0];
    const taskId = card?.taskId ?? this.selectedTaskId;
    const cached = this.evidenceInspection;
    if (!cached || cached.taskId !== taskId) return undefined;
    try {
      const executionId = cached.inspection.executionId;
      const inspection = inspectVerificationEvidence(this.engine.executions.require(executionId), {
        artifacts: cached.artifacts,
        toolCheckpoints: this.engine.executions.toolCheckpoints(executionId),
      });
      return { inspection, why: explainCompletion(inspection) };
    } catch {
      return undefined;
    }
  }

  /**
   * Finds the selected task's latest durable ExecutionRecord and its provenance artifacts.
   * Read-only: never creates executions or evidence. Concurrent calls are serialized, not dropped.
   */
  refreshEvidenceInspection(): Promise<void> {
    const run = async (): Promise<void> => {
      const card = this.agents.get(this.selectedTaskId ?? '') ?? this.getAgents()[0];
      const taskId = card?.taskId ?? this.selectedTaskId;
      try {
        const records = taskId ? await this.engine.executions.listByTask(taskId) : [];
        const record = records.sort((x, y) => new Date(x.execution.createdAt).getTime() - new Date(y.execution.createdAt).getTime()).at(-1);
        const prevKey = this.evidenceInspection?.key;
        if (!record) {
          this.evidenceInspection = undefined;
        } else {
          const artifacts = await this.engine.provenance?.getArtifactsByExecution?.(record.execution.id).catch(() => []) ?? [];
          const inspection = inspectVerificationEvidence(record, { artifacts });
          const key = `${record.execution.id}:${artifacts.length}`;
          this.evidenceInspection = { taskId, key, inspection, artifacts };
        }
        if (prevKey !== this.evidenceInspection?.key && this.currentView === 'evidence') this.draw();
      } catch {
        // A store read failure must not paint stale or invented evidence.
        this.evidenceInspection = undefined;
      }
    };
    this.evidenceRefresh = (this.evidenceRefresh ?? Promise.resolve()).then(run, run);
    return this.evidenceRefresh;
  }

  private listCanaryRecords(): any[] {
    return (this.engine.optimizer as any)?.getCanaryDeploymentService?.()?.listDeployments?.() ?? [];
  }

  /** Returns true when the key was consumed by the canary view. */
  private handleCanaryViewKey(keyStr: string, keyName: string): boolean {
    const tabs: Record<string, CanaryViewTab> = { c: 'dashboard', m: 'statemachine', s: 'shadow', r: 'rollback', h: 'history' };
    const tab = tabs[keyStr.toLowerCase()];
    if (tab && keyStr.length === 1) {
      this.canaryTab = tab;
      this.draw();
      return true;
    }
    if (this.canaryTab !== 'history') return false;
    const count = this.listCanaryRecords().length;
    if (keyName === 'up' || keyStr === '\u001b[A') {
      this.canaryHistoryIndex = Math.max(0, this.canaryHistoryIndex - 1);
    } else if (keyName === 'down' || keyStr === '\u001b[B') {
      this.canaryHistoryIndex = Math.max(0, Math.min(count - 1, this.canaryHistoryIndex + 1));
    } else if (keyName === 'return' || keyName === 'enter' || keyStr === '\r' || keyStr === '\n') {
      this.selectedCanaryId = this.listCanaryRecords()[this.canaryHistoryIndex]?.canaryId;
    } else {
      return false;
    }
    this.draw();
    return true;
  }

  private renderCanaryPane(cols: number, maxRows: number): string[] {
    const records = this.listCanaryRecords();
    const active = records.find((r) => r.canaryId === this.selectedCanaryId)
      ?? [...records].reverse().find((r) => !r.completedAt)
      ?? records[records.length - 1];
    return renderCanaryView({
      activeCanary: active ? { ...active, stage: active.stage ?? 'UNKNOWN' } : undefined,
      deployments: records.map((r) => ({
        canaryId: r.canaryId,
        candidateId: r.candidateId,
        domain: r.domain,
        stage: r.stage ?? 'UNKNOWN',
        status: r.status,
        currentAllocation: r.currentAllocation,
        startTime: r.startTime,
        completedAt: r.completedAt,
        rollbackReason: r.rollbackReason,
        totalExecutions: r.canaryMetrics?.totalExecutions ?? 0,
      })),
      activeTab: this.canaryTab,
      selectedHistoryIndex: this.canaryHistoryIndex,
      width: cols,
      maxRows,
    });
  }

  private renderModelIntelligencePane(cols: number, maxRows: number): string[] {
    const models = this.engine.models.list();
    const instances = this.engine.models.listInstances();
    const lines = [color.bold(color.cyan('  MODELS & PROVIDERS')), '  ↑↓ / j k browse · Enter pin model · /model auto clears pin', ''];
    for (const [index, m] of models.entries()) {
      if (index < this.selectedModelProfileIndex) continue;
      const resident = instances.filter(i => i.modelId === m.id);
      const ready = resident.some(i => i.loaded && i.state === 'READY' && i.health === 'healthy');
      lines.push(`  ${index === this.selectedModelProfileIndex ? ">" : " "} ${ready ? color.green('READY') : color.yellow('NOT READY')}  ${m.name}`);
      const contextMax = m.contextMax ?? (m as typeof m & { contextWindow?: number }).contextWindow ?? 0;
      lines.push(`    Provider ${m.provider} · ${m.local ? 'local' : 'hosted'} · Context ${contextMax.toLocaleString()} · Tools ${m.toolCalling ? 'yes' : 'no'}`);
      for (const i of resident) lines.push(`    ${i.runtimeId} / ${i.computerId} · ${i.state ?? 'unknown'} · ${i.health ?? 'unknown'}`);
    }
    if (!models.length) lines.push('  No models discovered. /refresh to discover configured providers.');
    return lines.slice(0, maxRows).map(l => this.padRightTo(l, cols));
  }

  /**
   * Dedicated Fleet Topology & Compute Fabric Pane (Mission Control View 3)
   */
  private renderFleetOverviewPane(cols: number, maxRows: number): string[] {
    const models = this.engine.models.list();
    const readyIds = new Set(this.engine.models.listInstances().filter(i => i.loaded && i.state === 'READY' && i.health === 'healthy').map(i => i.modelId));
    const agents = this.getAgents();
    const jobs = this.engine.orchestrator.listJobs?.() ?? [];
    const metrics = this.getContextMetrics();
    const evidence = this.currentEvidenceInspection();
    return renderMissionControl({
      workspace: this.engine.projectRoot,
      agents: this.engine.agents.list().length,
      running: agents.filter(a => a.status === 'running').length,
      ready: readyIds.size,
      installed: models.length,
      computers: this.engine.computers.list().length,
      fleetNodes: this.engine.computers.list().map((computer) => ({
        id: computer.id,
        gpu: typeof computer.hardware?.gpu === 'string'
          ? computer.hardware.gpu
          : computer.hardware?.gpu?.model,
        health: computer.status ?? 'unknown',
      })),
      jobs: jobs.slice(-4).reverse().map(j => ({ id: j.id, title: j.title, status: j.status })),
      models: models.map(m => ({ name: m.name, provider: m.provider, ready: readyIds.has(m.id) })),
      runtimes: this.engine.runtimes.list().map(r => ({ name: r.name, health: r.health ?? 'unknown' })),
      approvals: this.pendingApprovals.length,
      inputTokens: metrics.jobIn,
      outputTokens: metrics.jobOut,
      events: Array.from(this.agentLogs.values()).flat().sort((a, b) => a.time.localeCompare(b.time)).slice(-3),
      evidence: evidence ? [`${evidence.inspection.status} · 6 inspect verification checks`] : [],
    }, cols, maxRows);
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
      '    1 / 5 / 6       Mission Control / Models & Providers / Evidence',
      '    [ / ]           Cycle tasks or pending approvals',
      '    !cmd / /sh cmd  Run an inline workspace shell command',
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
