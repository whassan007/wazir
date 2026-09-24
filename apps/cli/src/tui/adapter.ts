/**
 * TerminalAdapter: Interface isolating terminal IO for production and testing.
 * NodeTerminalAdapter wraps Node's process.stdin / process.stdout.
 * MemoryTerminalAdapter allows deterministic in-memory testing of frames, escape codes, and lifecycle.
 */

import { EventEmitter } from 'node:events';

export interface TerminalAdapter {
  width(): number;
  height(): number;
  isTTY(): boolean;

  write(data: string): void;

  enterAlternateScreen(): void;
  leaveAlternateScreen(): void;

  enableRawMode(): void;
  disableRawMode(): void;

  hideCursor(): void;
  showCursor(): void;

  onResize(listener: (cols: number, rows: number) => void): () => void;
  destroy(): void;
}

export class NodeTerminalAdapter implements TerminalAdapter {
  private resizeListeners: Array<(cols: number, rows: number) => void> = [];
  private onNodeResize = (): void => {
    const cols = this.width();
    const rows = this.height();
    for (const listener of this.resizeListeners) {
      listener(cols, rows);
    }
  };

  constructor(
    private readonly inStream: NodeJS.ReadableStream = process.stdin,
    private readonly outStream: NodeJS.WritableStream = process.stdout,
  ) {
    if (process.stdout.on) {
      process.stdout.on('resize', this.onNodeResize);
    }
  }

  width(): number {
    const stdout = this.outStream as { columns?: number };
    return stdout.columns && stdout.columns > 20 ? stdout.columns : 100;
  }

  height(): number {
    const stdout = this.outStream as { rows?: number };
    return stdout.rows && stdout.rows > 10 ? stdout.rows : 30;
  }

  isTTY(): boolean {
    return Boolean((this.outStream as any).isTTY);
  }

  write(data: string): void {
    this.outStream.write(data);
  }

  enterAlternateScreen(): void {
    if (this.isTTY()) {
      // Enter alternate screen, bracketed paste mode, clear screen, steady block cursor
      this.write('\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2J\x1b[?25l\x1b[2 q');
    }
  }

  leaveAlternateScreen(): void {
    if (this.isTTY()) {
      // Default cursor, disable bracketed paste, show cursor, leave alternate screen
      this.write('\x1b[0 q\x1b[?2004l\x1b[?25h\x1b[?1049l');
    }
  }

  enableRawMode(): void {
    if (typeof (this.inStream as any).setRawMode === 'function') {
      try {
        (this.inStream as any).setRawMode(true);
        if (typeof (this.inStream as any).resume === 'function') {
          (this.inStream as any).resume();
        }
      } catch {
        // Ignored in piped or headless environment
      }
    }
  }

  disableRawMode(): void {
    if (typeof (this.inStream as any).setRawMode === 'function') {
      try {
        (this.inStream as any).setRawMode(false);
        if (typeof (this.inStream as any).pause === 'function') {
          (this.inStream as any).pause();
        }
      } catch {
        // Ignored
      }
    }
  }

  hideCursor(): void {
    this.write('\x1b[?25l');
  }

  showCursor(): void {
    this.write('\x1b[?25h');
  }

  onResize(listener: (cols: number, rows: number) => void): () => void {
    this.resizeListeners.push(listener);
    return () => {
      this.resizeListeners = this.resizeListeners.filter((l) => l !== listener);
    };
  }

  destroy(): void {
    if (process.stdout.off) {
      process.stdout.off('resize', this.onNodeResize);
    }
    this.resizeListeners = [];
  }
}

export class MemoryTerminalAdapter extends EventEmitter implements TerminalAdapter {
  private cols: number;
  private rowsCount: number;
  private tty: boolean;
  private inAltScreen = false;
  private rawModeActive = false;
  private cursorVisible = true;
  private outputBuffer = '';
  private resizeListeners: Array<(cols: number, rows: number) => void> = [];

  constructor(options: { width?: number; height?: number; isTTY?: boolean } = {}) {
    super();
    this.cols = options.width ?? 120;
    this.rowsCount = options.height ?? 40;
    this.tty = options.isTTY ?? true;
  }

  width(): number {
    return this.cols;
  }

  height(): number {
    return this.rowsCount;
  }

  isTTY(): boolean {
    return this.tty;
  }

  setTTY(val: boolean): void {
    this.tty = val;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rowsCount = rows;
    for (const listener of this.resizeListeners) {
      listener(cols, rows);
    }
  }

  write(data: string): void {
    this.outputBuffer += data;
  }

  getOutput(): string {
    return this.outputBuffer;
  }

  clearOutput(): void {
    this.outputBuffer = '';
  }

  enterAlternateScreen(): void {
    if (this.tty) {
      this.inAltScreen = true;
      this.write('\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2J\x1b[?25l\x1b[2 q');
    }
  }

  leaveAlternateScreen(): void {
    if (this.tty && this.inAltScreen) {
      this.inAltScreen = false;
      this.write('\x1b[0 q\x1b[?2004l\x1b[?25h\x1b[?1049l');
    }
  }

  enableRawMode(): void {
    this.rawModeActive = true;
  }

  disableRawMode(): void {
    this.rawModeActive = false;
  }

  hideCursor(): void {
    this.cursorVisible = false;
    this.write('\x1b[?25l');
  }

  showCursor(): void {
    this.cursorVisible = true;
    this.write('\x1b[?25h');
  }

  isAltScreenActive(): boolean {
    return this.inAltScreen;
  }

  isRawMode(): boolean {
    return this.rawModeActive;
  }

  isCursorVisible(): boolean {
    return this.cursorVisible;
  }

  onResize(listener: (cols: number, rows: number) => void): () => void {
    this.resizeListeners.push(listener);
    return () => {
      this.resizeListeners = this.resizeListeners.filter((l) => l !== listener);
    };
  }

  destroy(): void {
    this.resizeListeners = [];
    this.removeAllListeners();
  }
}
