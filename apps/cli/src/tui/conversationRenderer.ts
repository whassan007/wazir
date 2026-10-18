import { stringDisplayWidth } from './unicode.js';
import { detectTerminalCapabilities } from './terminalCapabilities.js';
import { OutputWriter } from './outputWriter.js';
import { TranscriptStore } from './transcriptStore.js';

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
}

/** Inline renderer: transcript is append-only; only this small live region is repainted. */
export class ConversationRenderer {
  private liveRows: string[] = [];
  private liveCursorRow = 0;
  private started = false;
  private plainRendered = false;
  private lastFrameKey = '';
  private lastPlainStatus = '';
  private liveCursorCol = 0;
  private readonly tty: boolean;
  private readonly writer: OutputWriter;
  readonly transcript = new TranscriptStore();

  constructor(private readonly output: NodeJS.WritableStream, private readonly size: () => { columns: number; rows: number }, options: { isTTY?: boolean; noColor?: boolean } = {}) {
    this.writer = new OutputWriter(output);
    this.tty = options.isTTY ?? detectTerminalCapabilities(output).isTTY;
  }

  start(identity: string, model?: string): void {
    if (this.started) return;
    this.started = true;
    const { columns } = this.size();
    const right = fit(model ? `${identity} · ${model}` : identity, Math.max(1, columns - 10));
    const gap = Math.max(1, columns - 2 - stringDisplayWidth('WAZIR') - stringDisplayWidth(right));
    const subtitle = fit(' Autonomous coding assistant · Ready · Enter to send · Esc to cancel · /help · /exit', Math.max(1, columns - 1));
    this.writeDurable(` WAZIR${' '.repeat(gap)}${right}\n${subtitle}\n\n`);
    this.liveRows = [];
  }

  append(text: string): void {
    this.clearLive();
    const clean = text.replace(/\r/g, '');
    this.transcript.append(clean);
    this.writeDurable(`${clean.endsWith('\n') ? clean : `${clean}\n`}\n`);
  }

  render(frame: ConversationFrame): void {
    if (!this.started) this.start(frame.identity, frame.model);
    const { columns, rows } = this.size();
    const width = Math.max(10, columns - 1);
    const active = frame.active > 1
      ? `● ${frame.active} agents working${frame.waitingApproval ? ` · ${frame.waitingApproval} waiting for approval` : ''}`
      : frame.active === 1
        ? `● Working${frame.elapsedSeconds === undefined ? '' : ` (${formatElapsed(frame.elapsedSeconds)}) · Esc to interrupt`}${frame.activity ? ` · ${frame.activity}` : ''}`
        : frame.waitingApproval ? `? ${frame.waitingApproval} approval${frame.waitingApproval === 1 ? '' : 's'} required · /fleet to review` : '';
    const idleStatus = 'Ready. Type a task or /fanout <t1; t2; ...> to begin.';
    const statusText = frame.status && frame.status !== idleStatus ? `• ${frame.status}` : '';
    const promptLines = wrapWithCursor(frame.prompt || '', frame.cursor, Math.max(1, width - 2));
    const fixed = (active ? 1 : 0) + (frame.approval ? 1 : 0) + (frame.copyMode ? 1 : 0) + (statusText ? 1 : 0);
    const maxRows = this.tty ? Math.max(1, Math.min(9, rows - 1)) : 9;
    const promptCapacity = Math.max(1, maxRows - fixed);
    const promptStart = Math.max(0, Math.min(promptLines.cursorRow - promptCapacity + 1, promptLines.lines.length - promptCapacity));
    const promptEnd = Math.min(promptLines.lines.length, promptStart + promptCapacity);
    const visiblePrompt = promptLines.lines.slice(promptStart, promptEnd);
    let next = [
      ...(active ? [fit(active, width)] : []),
      ...(frame.approval ? [fit(`? ${frame.approval}`, width)] : []),
      ...(frame.copyMode ? [fit(frame.copyMode, width)] : []),
      ...(statusText ? [fit(statusText, width)] : []),
      ...visiblePrompt.map((line, i) => `${promptStart + i === 0 ? '> ' : '  '}${line}`),
    ];
    const nextCursorRow = fixed + Math.max(0, promptLines.cursorRow - promptStart);
    if (!this.tty) {
      // Redirected output is plain text and contains no transient control sequences.
      if (!this.plainRendered) {
        const clean = next.filter((line) => Boolean(line) && (!statusText || line !== fit(statusText, width))).join('\n');
        if (clean) this.writeDurable(`${clean}\n`);
        this.plainRendered = true;
      }
      if (frame.status && frame.status !== this.lastPlainStatus && frame.status !== idleStatus) {
        this.writeDurable(`${frame.status}\n`);
        this.lastPlainStatus = frame.status;
      }
      return;
    }
    const frameKey = `${next.join('\n')}\0${nextCursorRow}`;
    if (frameKey === this.lastFrameKey) return;
    this.lastFrameKey = frameKey;
    this.rewriteLive(next, nextCursorRow);
  }

  stop(): void {
    if (!this.tty || !this.liveRows.length) return;
    this.clearLive();
    this.writeTransient('\r\n');
    this.liveRows = [];
  }

  private rewriteLive(next: string[], cursorRow: number): void {
    const oldRows = this.liveRows.length;
    const { columns } = this.size();
    const oldPhysicalRows = oldRows;
    // Each row was terminated explicitly, so terminal resize can wrap only the
    // row containing the cursor. Earlier live rows remain hard line breaks.
    const rowsAboveCursor = this.liveCursorRow + Math.floor(this.liveCursorCol / columns);
    if (oldRows && rowsAboveCursor) this.writeTransient(`\x1b[${rowsAboveCursor}A`);
    if (oldRows) this.writeTransient('\r');
    const count = Math.max(oldPhysicalRows, next.length);
    const rendered = Array.from({ length: count }, (_, i) => next[i] ?? '');
    for (let i = 0; i < count; i++) {
      this.writeTransient(`\r\x1b[2K${rendered[i] ?? ''}`);
      if (i + 1 < count) this.writeTransient('\n');
    }
    const last = Math.max(0, next.length - 1);
    const clampedCursorRow = Math.max(0, Math.min(last, cursorRow));
    const up = last - clampedCursorRow;
    if (up) this.writeTransient(`\x1b[${up}A`);
    this.writeTransient('\r');
    const cursorLine = next[Math.max(0, Math.min(last, cursorRow))] ?? '';
    const col = Math.min(columns - 1, stringDisplayWidth(cursorLine));
    if (col) this.writeTransient(`\x1b[${col}C`);
    this.liveRows = next;
    this.liveCursorRow = clampedCursorRow;
    this.liveCursorCol = col;
  }

  private clearLive(): void {
    if (!this.tty || !this.liveRows.length) return;
    const { columns } = this.size();
    const count = this.liveRows.length;
    const rowsAboveCursor = this.liveCursorRow + Math.floor(this.liveCursorCol / columns);
    if (rowsAboveCursor) this.writeTransient(`\x1b[${rowsAboveCursor}A`);
    this.writeTransient('\r');
    for (let i = 0; i < count; i++) {
      this.writeTransient('\x1b[2K');
      if (i + 1 < count) this.writeTransient('\n');
    }
    this.writeTransient('\r');
    this.liveRows = [];
    this.liveCursorRow = 0;
    this.liveCursorCol = 0;
  }

  private writeDurable(text: string): void { this.writer.writeDurable(text); }
  private writeTransient(text: string): void { this.writer.writeTransient(text); }
}

function formatElapsed(seconds: number): string {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function fit(text: string, width: number): string {
  let out = ''; let used = 0;
  for (const char of text) {
    const cells = stringDisplayWidth(char);
    if (used + cells > width) break;
    out += char; used += cells;
  }
  return out;
}

function wrapWithCursor(text: string, cursor: number, width: number): { lines: string[]; cursorRow: number } {
  const chars = Array.from(text);
  const cursorChars = Array.from(text.slice(0, cursor)).length;
  const lines: string[] = [''];
  let cells = 0;
  let cursorRow = 0;
  for (let i = 0; i <= chars.length; i++) {
    if (i === cursorChars) cursorRow = lines.length - 1;
    if (i === chars.length) break;
    const char = chars[i];
    if (char === '\n' || cells + Math.max(1, stringDisplayWidth(char)) > width) {
      lines.push(''); cells = 0;
      if (char === '\n') continue;
    }
    lines[lines.length - 1] += char;
    cells += stringDisplayWidth(char);
  }
  return { lines, cursorRow };
}
