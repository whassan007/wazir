import { stringDisplayWidth, truncateToDisplayWidth } from './unicode.js';
import type { TerminalCapabilities } from './terminalCapabilities.js';

export type ThemeColorMode = 'default' | 'dark' | 'light' | 'monochrome';

export interface ThemeGlyphs {
  prompt: string;
  userPrompt: string;
  success: string;
  running: string;
  runningFrames: readonly string[];
  warning: string;
  error: string;
  cancelled: string;
  approval: string;
  bullet: string;
  rule: string;
  codeRule: string;
  selected: string;
  unselected: string;
  ellipsis: string;
  branch: string;
}

const UNICODE_GLYPHS: ThemeGlyphs = {
  prompt: '›',
  userPrompt: '›',
  success: '✓',
  running: '◌',
  runningFrames: ['◌', '◎', '◌', '·'],
  warning: '!',
  error: '✗',
  cancelled: '■',
  approval: '◆',
  bullet: '·',
  rule: '─',
  codeRule: '─',
  selected: '▸',
  unselected: ' ',
  ellipsis: '…',
  branch: '⎇',
};

const ASCII_GLYPHS: ThemeGlyphs = {
  prompt: '>',
  userPrompt: '>',
  success: '+',
  running: '*',
  runningFrames: ['*', 'o', '*', '.'],
  warning: '!',
  error: 'x',
  cancelled: '#',
  approval: '?',
  bullet: '-',
  rule: '-',
  codeRule: '-',
  selected: '>',
  unselected: ' ',
  ellipsis: '...',
  branch: '',
};

export interface ConversationTheme {
  readonly colorMode: ThemeColorMode;
  readonly unicode: boolean;
  readonly glyphs: ThemeGlyphs;
  /** Compact brand wordmark */
  wordmark(text: string): string;
  /** Single subdued accent color for prompts, active selection, and focus */
  accent(text: string): string;
  /** Primary foreground text */
  primary(text: string): string;
  /** Bold emphasis */
  bold(text: string): string;
  /** Italic emphasis (falls back cleanly when unsupported) */
  italic(text: string): string;
  /** Subdued secondary metadata, hints, borders, elapsed timers */
  muted(text: string): string;
  /** Inline code or command highlight */
  code(text: string): string;
  /** Semantic success */
  success(text: string): string;
  /** Semantic warning / pending approval */
  warning(text: string): string;
  /** Semantic failure */
  error(text: string): string;
  /** Diff added line */
  diffAdd(text: string): string;
  /** Diff removed line */
  diffDel(text: string): string;
  /** Diff hunk header */
  diffHunk(text: string): string;
}

export interface ResolveThemeOptions {
  capabilities?: Partial<TerminalCapabilities>;
  colorMode?: ThemeColorMode;
  ascii?: boolean;
  noColor?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Detects light vs dark terminal preference from `WAZIR_THEME` or `COLORFGBG`
 * (`fg;bg` where `bg >= 7` in standard 16-color terminals indicates a light background).
 */
export function detectColorMode(opts: ResolveThemeOptions = {}): ThemeColorMode {
  const env = opts.env ?? process.env;
  if (
    opts.noColor ||
    opts.colorMode === 'monochrome' ||
    env.NO_COLOR !== undefined ||
    env.WAZIR_NO_COLOR === '1'
  ) {
    return 'monochrome';
  }
  if (opts.colorMode) return opts.colorMode;
  if (opts.capabilities?.color === false || env.TERM === 'dumb') {
    return 'monochrome';
  }
  const explicit = env.WAZIR_THEME?.trim().toLowerCase();
  if (explicit === 'dark' || explicit === 'light' || explicit === 'monochrome' || explicit === 'default') {
    return explicit;
  }
  const fgbg = env.COLORFGBG;
  if (fgbg) {
    const parts = fgbg.split(';').map((n) => parseInt(n, 10));
    const bg = parts.at(-1);
    if (bg !== undefined && Number.isFinite(bg)) {
      return bg >= 7 && bg !== 8 ? 'light' : 'dark';
    }
  }
  return 'default';
}

export function detectUnicodeSupport(opts: ResolveThemeOptions = {}): boolean {
  const env = opts.env ?? process.env;
  if (opts.ascii || env.WAZIR_ASCII === '1' || env.WAZIR_UNICODE === '0' || env.TERM === 'dumb') {
    return false;
  }
  if (opts.capabilities?.unicode !== undefined) {
    return opts.capabilities.unicode;
  }
  const locale = `${env.LC_ALL ?? ''} ${env.LC_CTYPE ?? ''} ${env.LANG ?? ''}`.toLowerCase();
  if (locale.trim() === 'c' || locale.trim() === 'posix') {
    return false;
  }
  return true;
}

const wrap = (open: string, close: string) => (text: string): string => (text ? `${open}${text}${close}` : '');
const identity = (text: string): string => text;

export function createConversationTheme(opts: ResolveThemeOptions = {}): ConversationTheme {
  const colorMode = detectColorMode(opts);
  const unicode = detectUnicodeSupport(opts);
  const glyphs = unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
  const env = opts.env ?? process.env;
  const supports256 = Boolean(
    env.COLORTERM || (env.TERM && /256color|truecolor|kitty|wezterm|ghostty/i.test(env.TERM)),
  );

  if (colorMode === 'monochrome') {
    return {
      colorMode,
      unicode,
      glyphs,
      wordmark: identity,
      accent: identity,
      primary: identity,
      bold: identity,
      italic: identity,
      muted: identity,
      code: identity,
      success: identity,
      warning: identity,
      error: identity,
      diffAdd: identity,
      diffDel: identity,
      diffHunk: identity,
    };
  }

  if (colorMode === 'light') {
    // Tuned for white/cream terminal backgrounds: deep slate-blue accent, dark forest green,
    // warm dark amber (never pale yellow), crimson red, and legible slate muted text.
    const accentCode = supports256 ? '\x1b[38;5;24m' : '\x1b[34m';
    const mutedCode = supports256 ? '\x1b[38;5;242m' : '\x1b[90m';
    const codeFg = supports256 ? '\x1b[38;5;25m' : '\x1b[34m';
    const okCode = supports256 ? '\x1b[38;5;28m' : '\x1b[32m';
    const warnCode = supports256 ? '\x1b[38;5;130m' : '\x1b[33m';
    const errCode = supports256 ? '\x1b[38;5;160m' : '\x1b[31m';
    return {
      colorMode,
      unicode,
      glyphs,
      wordmark: wrap(`\x1b[1m${accentCode}`, '\x1b[0m'),
      accent: wrap(accentCode, '\x1b[39m'),
      primary: identity,
      bold: wrap('\x1b[1m', '\x1b[22m'),
      italic: wrap('\x1b[3m', '\x1b[23m'),
      muted: wrap(mutedCode, '\x1b[39m'),
      code: wrap(codeFg, '\x1b[39m'),
      success: wrap(okCode, '\x1b[39m'),
      warning: wrap(warnCode, '\x1b[39m'),
      error: wrap(errCode, '\x1b[39m'),
      diffAdd: wrap(okCode, '\x1b[39m'),
      diffDel: wrap(errCode, '\x1b[39m'),
      diffHunk: wrap(accentCode, '\x1b[39m'),
    };
  }

  if (colorMode === 'dark') {
    // Subdued steel-cyan accent + calm slate-gray chrome for dark backgrounds
    const accentCode = supports256 ? '\x1b[38;5;110m' : '\x1b[36m';
    const mutedCode = supports256 ? '\x1b[38;5;245m' : '\x1b[90m';
    const codeFg = supports256 ? '\x1b[38;5;152m' : '\x1b[36m';
    const okCode = supports256 ? '\x1b[38;5;78m' : '\x1b[32m';
    const warnCode = supports256 ? '\x1b[38;5;179m' : '\x1b[33m';
    const errCode = supports256 ? '\x1b[38;5;203m' : '\x1b[31m';
    return {
      colorMode,
      unicode,
      glyphs,
      wordmark: wrap(`\x1b[1m${accentCode}`, '\x1b[0m'),
      accent: wrap(accentCode, '\x1b[39m'),
      primary: identity,
      bold: wrap('\x1b[1m', '\x1b[22m'),
      italic: wrap('\x1b[3m', '\x1b[23m'),
      muted: wrap(mutedCode, '\x1b[39m'),
      code: wrap(codeFg, '\x1b[39m'),
      success: wrap(okCode, '\x1b[39m'),
      warning: wrap(warnCode, '\x1b[39m'),
      error: wrap(errCode, '\x1b[39m'),
      diffAdd: wrap(okCode, '\x1b[39m'),
      diffDel: wrap(errCode, '\x1b[39m'),
      diffHunk: wrap(accentCode, '\x1b[39m'),
    };
  }

  // 'default': respects user's configured ANSI-16 terminal palette
  return {
    colorMode,
    unicode,
    glyphs,
    wordmark: wrap('\x1b[1m\x1b[36m', '\x1b[0m'),
    accent: wrap('\x1b[36m', '\x1b[39m'),
    primary: identity,
    bold: wrap('\x1b[1m', '\x1b[22m'),
    italic: wrap('\x1b[3m', '\x1b[23m'),
    muted: wrap('\x1b[2m', '\x1b[22m'),
    code: wrap('\x1b[36m', '\x1b[39m'),
    success: wrap('\x1b[32m', '\x1b[39m'),
    warning: wrap('\x1b[33m', '\x1b[39m'),
    error: wrap('\x1b[31m', '\x1b[39m'),
    diffAdd: wrap('\x1b[32m', '\x1b[39m'),
    diffDel: wrap('\x1b[31m', '\x1b[39m'),
    diffHunk: wrap('\x1b[36m', '\x1b[39m'),
  };
}

export interface HeaderRenderState {
  workspaceName: string;
  gitBranch?: string;
  modelSummary: string;
  permissionSummary: string;
}

/**
 * Formats a two-column header row (`left` ... `right`) bounded strictly to `columns` cells.
 */
export function formatTwoColumnRow(
  leftPlain: string,
  rightPlain: string,
  columns: number,
  styleLeft: (s: string) => string,
  styleRight: (s: string) => string,
  indent = 2,
  ellipsis = '…',
  bullet = '·',
): string {
  const safeCols = Math.max(20, columns);
  const pad = safeCols >= 56 ? indent : 1;
  const usable = Math.max(10, safeCols - pad * 2);
  const bSlashSep = '  ';

  if (!rightPlain) {
    const clampedLeft = truncateToDisplayWidth(leftPlain, usable, ellipsis);
    return `${' '.repeat(pad)}${styleLeft(clampedLeft)}`;
  }

  const leftW = stringDisplayWidth(leftPlain);
  const rightW = stringDisplayWidth(rightPlain);

  if (leftW + rightW + bSlashSep.length <= usable) {
    const gap = usable - leftW - rightW;
    return `${' '.repeat(pad)}${styleLeft(leftPlain)}${' '.repeat(gap)}${styleRight(rightPlain)}`;
  }

  // Narrow layout: allocate ~55% to left, ~45% to right with minimum 2-space gap
  if (usable < 34) {
    const combined = truncateToDisplayWidth(`${leftPlain} ${bullet} ${rightPlain}`, usable, ellipsis);
    return `${' '.repeat(pad)}${styleLeft(combined)}`;
  }

  const leftBudget = Math.max(10, Math.floor((usable - 2) * 0.55));
  const clampedLeft = truncateToDisplayWidth(leftPlain, leftBudget, ellipsis);
  const usedLeft = stringDisplayWidth(clampedLeft);
  const rightBudget = Math.max(8, usable - usedLeft - 2);
  const clampedRight = truncateToDisplayWidth(rightPlain, rightBudget, ellipsis);
  const gap = Math.max(1, usable - usedLeft - stringDisplayWidth(clampedRight));
  return `${' '.repeat(pad)}${styleLeft(clampedLeft)}${' '.repeat(gap)}${styleRight(clampedRight)}`;
}

/**
 * Renders the calm 2-line Wazir conversation header:
 *   WAZIR                         project · branch
 *   model/provider                permission mode
 */
export function renderConversationHeader(
  state: HeaderRenderState,
  columns: number,
  theme: ConversationTheme,
): string[] {
  const sep = ` ${theme.glyphs.bullet} `;
  const workspaceRight = state.gitBranch
    ? `${state.workspaceName}${sep}${state.gitBranch}`
    : state.workspaceName;

  const row1 = formatTwoColumnRow(
    'WAZIR',
    workspaceRight,
    columns,
    (s) => theme.wordmark(s),
    (s) => theme.muted(s),
    2,
    theme.glyphs.ellipsis,
    theme.glyphs.bullet,
  );

  const row2 = formatTwoColumnRow(
    state.modelSummary,
    state.permissionSummary,
    columns,
    (s) => theme.muted(s),
    (s) => theme.muted(s),
    2,
    theme.glyphs.ellipsis,
    theme.glyphs.bullet,
  );

  return [row1, row2];
}
