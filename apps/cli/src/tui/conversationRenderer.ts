import { stringDisplayWidth, stripAnsi, truncateToDisplayWidth } from './unicode.js';
import { detectTerminalCapabilities } from './terminalCapabilities.js';
import { OutputWriter } from './outputWriter.js';
import { TranscriptStore } from './transcriptStore.js';
import {
  createConversationTheme,
  renderConversationHeader,
  formatTwoColumnRow,
  type ConversationTheme,
  type ThemeColorMode,
} from './theme.js';
import { layoutPromptWithCursor } from './composerController.js';

export interface ConversationFrame {
  identity: string;
  model?: string;
  prompt: string;
  cursor: number;
  active: number;
  waitingApproval: number;
  activity: string;
  elapsedSeconds?: number;
  approval?: string;
  status?: string;
  copyMode?: string;
  /** Optional enriched metadata for the 2-line Wazir header & bounded composer */
  workspaceName?: string;
  gitBranch?: string;
  permissionSummary?: string;
  placeholder?: string;
  /** Optional completion, model selector, palette, or approval preview lines above/below composer */
  trayLines?: string[];
  footerHints?: string;
  queuedCount?: number;
  approvalFocused?: boolean;
  spinnerFrame?: string;
  modalLines?: string[];
}

export interface ConversationRendererOptions {
  isTTY?: boolean;
  noColor?: boolean;
  ascii?: boolean;
  colorMode?: ThemeColorMode;
}

const IDLE_STATUS_DEFAULT = 'Ready. Type a task or /fanout <t1; t2; ...> to begin.';

/**
 * Append-only inline terminal conversation renderer:
 * - Transcript history flows naturally into native terminal scrollback (never enters alt-screen or mouse mode).
 * - Only the compact live composer + active status tray at the bottom is repainted in place.
 * - Tracks both `(liveCursorRow, liveCursorCol)` and per-row display widths so horizontal cursor movement,
 *   multiline wrapping, CJK/emoji graphemes, and narrow/wide terminal resizes stay exact.
 */
export class ConversationRenderer {
  private liveRows: string[] = [];
  private liveRowWidths: number[] = [];
  private liveCursorRow = 0;
  private liveCursorCol = 0;
  private lastRenderedColumns = 80;
  private started = false;
  private plainRendered = false;
  private lastFrameKey = '';
  private lastPlainStatus = '';
  private lastNonTtyModalKey = '';
  private lastAppendedText = '';
  private currentModalLines: string[] = [];
  private readonly tty: boolean;
  private readonly writer: OutputWriter;
  private theme: ConversationTheme;
  readonly transcript = new TranscriptStore();

  private activeIdentity = '';
  private activeModel?: string;
  private workspaceName = '';
  private gitBranch?: string;
  private permissionSummary = 'ask · sandbox';

  constructor(
    private readonly output: NodeJS.WritableStream,
    private readonly size: () => { columns: number; rows: number },
    options: ConversationRendererOptions = {},
  ) {
    this.writer = new OutputWriter(output);
    const caps = detectTerminalCapabilities(output);
    this.tty = options.isTTY ?? caps.isTTY;
    this.theme = createConversationTheme({
      capabilities: caps,
      noColor: !this.tty || Boolean(options.noColor),
      ascii: options.ascii,
      colorMode: !this.tty ? 'monochrome' : options.colorMode,
    });
  }

  getTheme(): ConversationTheme {
    return this.theme;
  }

  setThemeOptions(options: ConversationRendererOptions): void {
    const caps = detectTerminalCapabilities(this.output);
    this.theme = createConversationTheme({
      capabilities: caps,
      noColor: !this.tty || Boolean(options.noColor),
      ascii: options.ascii,
      colorMode: !this.tty ? 'monochrome' : options.colorMode,
    });
    this.lastFrameKey = '';
  }

  setHeaderContext(context: {
    workspaceName?: string;
    gitBranch?: string;
    permissionSummary?: string;
    model?: string;
  }): void {
    if (context.workspaceName !== undefined) this.workspaceName = context.workspaceName;
    if (context.gitBranch !== undefined) this.gitBranch = context.gitBranch;
    if (context.permissionSummary !== undefined) this.permissionSummary = context.permissionSummary;
    if (context.model !== undefined) this.activeModel = context.model;
  }

  setModel(model: string): void {
    this.activeModel = model;
  }

  start(
    identity: string,
    model?: string,
    headerMeta?: { workspaceName?: string; gitBranch?: string; permissionSummary?: string },
  ): void {
    if (this.started) return;
    this.started = true;
    this.activeIdentity = identity;
    if (model) this.activeModel = model;
    if (headerMeta) this.setHeaderContext(headerMeta);

    const { columns } = this.size();
    const shownModel = this.activeModel ?? model ?? 'auto-routed';
    const workspace = this.workspaceName || identity || 'workspace';
    const headerLines = renderConversationHeader(
      {
        workspaceName: workspace,
        gitBranch: this.gitBranch,
        modelSummary: shownModel,
        permissionSummary: this.permissionSummary,
      },
      Math.max(20, columns - 1),
      this.theme,
    );
    this.writeDurable(`${headerLines.join('\n')}\n\n`);
    this.liveRows = [];
    this.liveRowWidths = [];
  }

  append(text: string): void {
    this.clearLive();
    const clean = text.replace(/\r/g, '');
    this.lastAppendedText = clean.trim();
    this.transcript.append(clean);
    this.writeDurable(`${clean.endsWith('\n') ? clean : `${clean}\n`}\n`);
  }

  clearModal(): void {
    this.lastNonTtyModalKey = '';
    this.currentModalLines = [];
    this.clearLive();
  }

  getActiveModalLines(): string[] {
    return this.currentModalLines;
  }

  getCurrentModalLines(): string[] {
    return this.currentModalLines;
  }

  /**
   * Clears visible screen above the live composer for `/clear` without entering alternate-screen mode.
   */
  clearScreenAndRestart(): void {
    this.clearLive();
    this.transcript.clear();
    this.lastFrameKey = '';
    if (this.tty) {
      this.writeTransient('\x1b[2J\x1b[H');
    }
    this.started = false;
    this.start(this.activeIdentity, this.activeModel);
  }

  render(frame: ConversationFrame): void {
    if (frame.workspaceName !== undefined) this.workspaceName = frame.workspaceName;
    if (frame.gitBranch !== undefined) this.gitBranch = frame.gitBranch;
    if (frame.permissionSummary !== undefined) this.permissionSummary = frame.permissionSummary;
    if (!this.started) this.start(frame.identity, frame.model);
    const { columns, rows } = this.size();
    const width = Math.max(12, columns - 1);
    const compactHeight = rows > 0 && rows <= 14;
    const g = this.theme.glyphs;

    // 1. Live activity / progress row ("◌ Running tests          3s")
    let activeLine = '';
    if (frame.active > 1) {
      const left = `  ${g.running} ${frame.active} agents working${frame.waitingApproval ? ` ${g.bullet} ${frame.waitingApproval} waiting for approval` : ''}`;
      const right = frame.elapsedSeconds !== undefined ? formatElapsed(frame.elapsedSeconds) : '';
      activeLine = formatActivityRow(left, right, width, this.theme);
    } else if (frame.active === 1) {
      const spin = frame.spinnerFrame ?? g.running;
      const label = frame.activity && frame.activity !== 'Working' ? `Working ${g.bullet} ${frame.activity}` : 'Working';
      const left = `  ${spin} ${label}`;
      const right = frame.elapsedSeconds !== undefined ? formatElapsed(frame.elapsedSeconds) : '';
      activeLine = formatActivityRow(left, right, width, this.theme);
    } else if (frame.waitingApproval > 0 && !frame.approval && (!frame.trayLines || frame.trayLines.length === 0)) {
      const msg = `  ${g.approval} ${frame.waitingApproval} approval${frame.waitingApproval === 1 ? '' : 's'} required ${g.bullet} Tab to review`;
      activeLine = this.theme.warning(fitPlain(msg, width));
    }

    const expandDetailLine =
      !compactHeight && frame.active >= 1 && width >= 44
        ? this.theme.muted(fitPlain(`    Expand activity for details (/logs)`, width))
        : '';

    const approvalLine =
      frame.approval && (!frame.trayLines || frame.trayLines.length === 0)
        ? (frame.approvalFocused
          ? this.theme.warning(fitPlain(`  ${g.approval} ${frame.approval}`, width))
          : this.theme.warning(fitPlain(`  ${g.approval} ${frame.approval}`, width)))
        : '';

    const copyLine = frame.copyMode ? this.theme.accent(fitPlain(`  ${frame.copyMode}`, width)) : '';

    this.currentModalLines = frame.modalLines ?? [];
    const modalLinesFormatted = frame.modalLines ? frame.modalLines.map((line) => clampStyledLine(line, width)) : [];

    let statusRaw = frame.status && frame.status !== IDLE_STATUS_DEFAULT ? frame.status : '';
    if (frame.status && frame.status !== IDLE_STATUS_DEFAULT) {
      const trimmedStatus = frame.status.trim();
      const isDuplicate = trimmedStatus === this.lastAppendedText ||
        (this.lastAppendedText.startsWith('Model selection updated') && (trimmedStatus.startsWith('Model selection updated') || trimmedStatus.startsWith('Model selection cancelled')));
      statusRaw = isDuplicate ? '' : frame.status;
    }

    const statusLine = statusRaw ? this.theme.muted(fitPlain(`  ${g.bullet} ${statusRaw}`, width)) : '';

    const trayLines = (frame.trayLines ?? []).map((line) => clampStyledLine(line, width));

    // 2. Bounded composer with exact cursor row & column tracking
    const showChrome = this.tty && !compactHeight && rows >= 16;
    const ruleWidth = Math.min(width, Math.max(12, width - 2));
    const ruleLine = showChrome ? `  ${this.theme.muted(g.rule.repeat(Math.max(8, ruleWidth - 2)))}` : '';

    const prefixIndent = showChrome ? '  ' : '';
    const promptGlyph = `${prefixIndent}${g.prompt} `;
    const contGlyph = `${prefixIndent}  `;
    const prefixCells = stringDisplayWidth(promptGlyph);

    const promptLayout = layoutPromptWithCursor(frame.prompt || '', frame.cursor, width, prefixCells);

    const hintLine = showChrome
      ? `  ${this.theme.muted(
          fitPlain(
            frame.footerHints ??
              (frame.approvalFocused
                ? `y approve ${g.bullet} n deny ${g.bullet} v details ${g.bullet} Tab composer`
                : frame.active > 0
                  ? `/ commands ${g.bullet} @ files ${g.bullet} Enter steer/queue ${g.bullet} Esc interrupt`
                  : `/ commands ${g.bullet} @ files ${g.bullet} Ctrl+J newline ${g.bullet} Ctrl+P actions`),
            Math.max(8, width - 2),
          ),
        )}`
      : '';

    const prePromptRows: string[] = [
      ...(activeLine ? [activeLine] : []),
      ...(expandDetailLine ? [expandDetailLine] : []),
      ...(approvalLine ? [approvalLine] : []),
      ...(copyLine ? [copyLine] : []),
      ...(statusLine ? [statusLine] : []),
      ...modalLinesFormatted,
      ...trayLines,
      ...(ruleLine ? [ruleLine] : []),
    ];

    const postPromptRows: string[] = [
      ...(ruleLine ? [ruleLine] : []),
      ...(hintLine ? [hintLine] : []),
    ];

    const maxLiveRows = this.tty ? Math.max(modalLinesFormatted.length > 0 ? modalLinesFormatted.length + 4 : 2, Math.min(14, rows - 2)) : 12;
    const fixedCount = prePromptRows.length + postPromptRows.length;
    const promptCapacity = Math.max(1, maxLiveRows - fixedCount);

    // If tight vertical space, drop non-essential chrome before starving prompt lines
    if (fixedCount >= maxLiveRows && postPromptRows.length > 0) {
      postPromptRows.length = 0;
    }

    const effectiveCapacity = Math.max(1, maxLiveRows - prePromptRows.length - postPromptRows.length);
    const promptStart = Math.max(
      0,
      Math.min(
        promptLayout.cursorRow - effectiveCapacity + 1,
        promptLayout.contentLines.length - effectiveCapacity,
      ),
    );
    const promptEnd = Math.min(promptLayout.contentLines.length, promptStart + effectiveCapacity);
    const visiblePromptLines = promptLayout.contentLines.slice(promptStart, promptEnd);

    const placeholderText = frame.placeholder ?? 'Describe the next change…';
    const renderedPromptRows =
      frame.prompt.length === 0 && this.tty
        ? [
            `${this.theme.accent(promptGlyph)}${this.theme.muted(
              fitPlain(placeholderText, Math.max(1, width - prefixCells)),
            )}`,
          ]
        : visiblePromptLines.map((line, idx) => {
            const pfx = promptStart + idx === 0 ? this.theme.accent(promptGlyph) : contGlyph;
            return `${pfx}${fitPlain(line, Math.max(1, width - prefixCells))}`;
          });

    const nextRows = [...prePromptRows, ...renderedPromptRows, ...postPromptRows];
    const nextCursorRow = prePromptRows.length + Math.max(0, promptLayout.cursorRow - promptStart);
    const nextCursorCol = Math.max(0, Math.min(Math.max(0, columns - 1), promptLayout.cursorCol));

    if (!this.tty) {
      // Redirected / piped output: plain text only, zero ANSI escape sequences.
      const modalKey = modalLinesFormatted.join('\n');
      if (modalKey && modalKey !== this.lastNonTtyModalKey) {
        this.lastNonTtyModalKey = modalKey;
        this.transcript.append(modalKey);
        this.writeDurable(`${modalKey}\n`);
      } else if (!modalKey && this.lastNonTtyModalKey) {
        this.lastNonTtyModalKey = '';
      }

      if (!this.plainRendered) {
        const plainLines: string[] = [];
        if (activeLine) plainLines.push(stripAnsi(activeLine).trimStart());
        if (approvalLine) plainLines.push(stripAnsi(approvalLine).trimStart());
        if (copyLine) plainLines.push(stripAnsi(copyLine).trimStart());
        if (frame.prompt) {
          plainLines.push(...visiblePromptLines.map((l, i) => `${promptStart + i === 0 ? '> ' : '  '}${l}`));
        }
        if (plainLines.length > 0) {
          this.writeDurable(`${plainLines.join('\n')}\n`);
        }
        this.plainRendered = true;
      }
      if (statusRaw && statusRaw !== this.lastPlainStatus) {
        this.writeDurable(`${statusRaw}\n`);
        this.lastPlainStatus = statusRaw;
      }
      return;
    }

    const frameKey = `${columns}x${rows}\0${nextRows.join('\n')}\0${nextCursorRow}:${nextCursorCol}`;
    if (frameKey === this.lastFrameKey) return;
    this.lastFrameKey = frameKey;
    this.rewriteLive(nextRows, nextCursorRow, nextCursorCol);
  }

  stop(): void {
    if (!this.tty || !this.liveRows.length) return;
    this.clearLive();
    this.writeTransient('\r\n');
    this.liveRows = [];
    this.liveRowWidths = [];
  }

  private computeReflowedMetrics(columns: number): { rowsAboveCursor: number; oldPhysicalRows: number } {
    const safeCols = Math.max(1, columns);
    if (this.liveRows.length === 0) {
      return { rowsAboveCursor: 0, oldPhysicalRows: 0 };
    }
    if (safeCols >= this.lastRenderedColumns) {
      return {
        rowsAboveCursor: this.liveCursorRow,
        oldPhysicalRows: this.liveRows.length,
      };
    }
    let rowsAbove = 0;
    for (let i = 0; i < this.liveCursorRow && i < this.liveRowWidths.length; i++) {
      const w = this.liveRowWidths[i] ?? 0;
      rowsAbove += Math.max(1, Math.ceil(Math.max(1, w) / safeCols));
    }
    rowsAbove += Math.floor(this.liveCursorCol / safeCols);

    let totalOld = 0;
    for (const w of this.liveRowWidths) {
      totalOld += Math.max(1, Math.ceil(Math.max(1, w) / safeCols));
    }
    return { rowsAboveCursor: rowsAbove, oldPhysicalRows: Math.max(totalOld, this.liveRows.length) };
  }

  private rewriteLive(next: string[], cursorRow: number, cursorCol: number): void {
    const { columns } = this.size();
    const safeCols = Math.max(1, columns);
    const { rowsAboveCursor, oldPhysicalRows } = this.computeReflowedMetrics(safeCols);

    if (this.liveRows.length > 0 && rowsAboveCursor > 0) {
      this.writeTransient(`\x1b[${rowsAboveCursor}A`);
    }
    if (this.liveRows.length > 0) {
      this.writeTransient('\r');
    }

    const count = Math.max(oldPhysicalRows, next.length);
    for (let i = 0; i < count; i++) {
      const line = next[i] ?? '';
      this.writeTransient(`\r\x1b[2K${line}`);
      if (i + 1 < count) this.writeTransient('\n');
    }

    const lastIdx = Math.max(0, count - 1);
    const clampedCursorRow = Math.max(0, Math.min(Math.max(0, next.length - 1), cursorRow));
    const up = lastIdx - clampedCursorRow;
    if (up > 0) {
      this.writeTransient(`\x1b[${up}A`);
    }
    this.writeTransient('\r');
    const col = Math.max(0, Math.min(safeCols - 1, cursorCol));
    if (col > 0) {
      this.writeTransient(`\x1b[${col}C`);
    }

    this.liveRows = next;
    this.liveRowWidths = next.map((line) => stringDisplayWidth(stripAnsi(line)));
    this.liveCursorRow = clampedCursorRow;
    this.liveCursorCol = col;
    this.lastRenderedColumns = safeCols;
  }

  private clearLive(): void {
    if (!this.tty || !this.liveRows.length) return;
    const { columns } = this.size();
    const safeCols = Math.max(1, columns);
    const { rowsAboveCursor, oldPhysicalRows } = this.computeReflowedMetrics(safeCols);

    if (rowsAboveCursor > 0) {
      this.writeTransient(`\x1b[${rowsAboveCursor}A`);
    }
    this.writeTransient('\r');
    for (let i = 0; i < oldPhysicalRows; i++) {
      this.writeTransient('\x1b[2K');
      if (i + 1 < oldPhysicalRows) this.writeTransient('\n');
    }
    if (oldPhysicalRows > 1) {
      this.writeTransient(`\x1b[${oldPhysicalRows - 1}A`);
    }
    this.writeTransient('\r');
    this.liveRows = [];
    this.liveRowWidths = [];
    this.liveCursorRow = 0;
    this.liveCursorCol = 0;
    this.lastFrameKey = '';
  }

  private writeDurable(text: string): void {
    this.writer.writeDurable(text);
  }

  private writeTransient(text: string): void {
    this.writer.writeTransient(text);
  }
}

function formatElapsed(seconds: number): string {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function formatActivityRow(
  leftPlain: string,
  rightPlain: string,
  width: number,
  theme: ConversationTheme,
): string {
  return formatTwoColumnRow(
    leftPlain,
    rightPlain,
    width,
    (s) => theme.accent(s),
    (s) => theme.muted(s),
    0,
  );
}

function fitPlain(text: string, width: number): string {
  if (width <= 0) return '';
  return truncateToDisplayWidth(text, width, '');
}

function clampStyledLine(line: string, width: number): string {
  const plain = stripAnsi(line);
  if (stringDisplayWidth(plain) <= width) return line;
  return truncateToDisplayWidth(plain, width, '…');
}
