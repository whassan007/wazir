import readline from 'node:readline';
import type {
  ModelRecord,
  ResourceAssessment,
  PromptBreakdown,
} from '@wazir/core';
import type { RookEngine } from '../engine.js';
import type { TerminalScreen } from './screen.js';
import type { CanaryTimelineEntry, CanaryTimelineFilter } from './canaryTimeline.js';

export type { CanaryTimelineEntry, CanaryTimelineFilter };

export const JOB_SPINNER_FRAMES = ['◴', '◷', '◶', '◵'] as const;
export const RUNTIME_SPINNER_FRAMES = ['·', '•', '●', '•'] as const;
export const RUNTIME_SPINNER_TICKS_PER_FRAME = 4; // 4 * 250ms redraw tick = 1 frame/sec
export const DEFAULT_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export function getCategorySpinnerFrame(category: NavCategory | undefined, tick: number): string {
  if (category === 'JOBS' || category === 'EXECUTIONS') {
    return JOB_SPINNER_FRAMES[Math.abs(Math.floor(tick)) % JOB_SPINNER_FRAMES.length];
  }
  if (category === 'RUNTIMES') {
    const slowTick = Math.floor(Math.abs(Math.floor(tick)) / RUNTIME_SPINNER_TICKS_PER_FRAME);
    return RUNTIME_SPINNER_FRAMES[slowTick % RUNTIME_SPINNER_FRAMES.length];
  }
  return DEFAULT_SPINNER_FRAMES[Math.abs(Math.floor(tick)) % DEFAULT_SPINNER_FRAMES.length];
}

export function shortJobId(id: string): string {
  const stripped = id.replace(/^job-/, '');
  return stripped.length > 8 ? `..${stripped.slice(-8)}` : stripped;
}

export interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  text: string;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
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

export interface CanaryModalState {
  type: 'advance' | 'rollback' | 'throttle';
  canaryId: string;
  candidateId: string;
  currentAllocation: number;
  nextStage?: string;
  availableTiers: number[];
  selectedTierIndex: number;
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
export function isCtrlEnter(keyStr: string, keyObj: readline.Key): boolean {
  if (keyObj.ctrl && (keyObj.name === 'return' || keyObj.name === 'enter' || keyStr === '\r' || keyStr === '\n')) {
    return true;
  }
  if (keyStr === '\x1b\r' || keyStr === '\x1b\n') return true;
  if (keyStr === '\x1b[13;5~' || keyStr === '\x1b[27;5;13~') return true;
  return false;
}

export function hasInternalLineBreak(text: string): boolean {
  const withoutTrailingTerminator = text.replace(/(\r\n|\r|\n)$/, '');
  return withoutTrailingTerminator.includes('\n') || withoutTrailingTerminator.includes('\r');
}

export function resolveKeyObject(keyStr: string, keyObj?: readline.Key): readline.Key {
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

export function previousGraphemeBoundary(text: string, cursor: number): number {
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

export function nextGraphemeBoundary(text: string, cursor: number): number {
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

export function stripAnsiStr(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

export function wrapAnsiText(text: string, maxWidth: number, maxLines: number): string[] {
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
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length >= maxWidth ? `${last.slice(0, maxWidth - 1)}.` : `${last}.`;
  }
  return lines;
}

export function truncateAnsiStr(str: string, maxLen: number): string {
  const plain = stripAnsiStr(str);
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

export function padRightAnsi(str: string, targetWidth: number): string {
  const visible = stripAnsiStr(str).length;
  if (visible > targetWidth) {
    return truncateAnsiStr(str, targetWidth);
  }
  return str + ' '.repeat(Math.max(0, targetWidth - visible));
}
