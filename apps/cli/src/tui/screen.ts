import readline from 'node:readline';
import { FrameDiffer } from './differ.js';
import { TerminalFrame } from './frame.js';

export interface TerminalSize {
  columns: number;
  rows: number;
}

const CURSOR_STEADY_BLOCK = '\x1b[2 q';
const CURSOR_DEFAULT = '\x1b[0 q';

export class TerminalScreen {
  private inAltScreen = false;
  private rawModeActive = false;
  private keypressBound = false;
  private lastBuffer = '';
  private lastCursorCol?: number;
  public resizeListeners: Array<(size: TerminalSize) => void> = [];
  private previousFrame?: TerminalFrame;
  private forceFullRedraw = true;

  constructor(
    private readonly inStream: NodeJS.ReadableStream = process.stdin,
    private readonly outStream: NodeJS.WritableStream = process.stdout,
  ) {}

  getInputStream(): NodeJS.ReadableStream {
    return this.inStream;
  }

  getOutputStream(): NodeJS.WritableStream {
    return this.outStream;
  }

  getSize(): TerminalSize {
    const stdout = this.outStream as { columns?: number; rows?: number };
    return {
      columns: stdout.columns && stdout.columns > 20 ? stdout.columns : 100,
      rows: stdout.rows && stdout.rows > 10 ? stdout.rows : 30,
    };
  }

  enter(): void {
    if (typeof (this.inStream as any).setRawMode === 'function') {
      try {
        (this.inStream as any).setRawMode(true);
        this.rawModeActive = true;
        if (typeof (this.inStream as any).resume === 'function') {
          (this.inStream as any).resume();
        }
      } catch {
        // Ignore in headless/pipe mode
      }
    }

    if (!this.keypressBound) {
      try {
        readline.emitKeypressEvents(this.inStream);
        this.keypressBound = true;
      } catch {
        // Ignore in mock streams without readline support
      }
    }

    if ((this.outStream as any).isTTY) {
      this.outStream.write(`\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2J\x1b[?25l${CURSOR_STEADY_BLOCK}`);
      this.inAltScreen = true;
      this.forceFullRedraw = true;
    }

    if (process.stdout.on) {
      process.stdout.on('resize', this.onResize);
    }
  }

  leave(): void {
    if (process.stdout.off) {
      process.stdout.off('resize', this.onResize);
    }

    if (this.rawModeActive && typeof (this.inStream as any).setRawMode === 'function') {
      try {
        (this.inStream as any).setRawMode(false);
        this.inStream.pause();
      } catch {
        // Ignore
      }
      this.rawModeActive = false;
    }

    if (this.inAltScreen) {
      this.outStream.write(`${CURSOR_DEFAULT}\x1b[?2004l\x1b[?25h\x1b[?1049l`);
      this.inAltScreen = false;
    }
  }

  isTTY(): boolean {
    return Boolean((this.outStream as any).isTTY);
  }

  isAltScreenActive(): boolean {
    return this.inAltScreen;
  }

  isRawMode(): boolean {
    return this.rawModeActive;
  }

  /**
   * Double-buffered render using virtual TerminalFrame and FrameDiffer.
   * Eliminates ghost text, partial redraw artifacts, and trailing characters.
   */
  render(buffer: string, cursorCol?: number): void {
    const bufferChanged = buffer !== this.lastBuffer;
    if (!bufferChanged && cursorCol === this.lastCursorCol) return;

    if (this.inAltScreen) {
      const size = this.getSize();
      const lines = buffer.split('\n');
      const frame = TerminalFrame.create(size.columns, size.rows);

      for (let y = 0; y < Math.min(lines.length, size.rows); y++) {
        frame.writeAnsiLine(0, y, lines[y]);
      }

      if (cursorCol !== undefined) {
        frame.cursor = {
          row: Math.min(lines.length - 1, size.rows - 1),
          col: Math.max(0, cursorCol - 1),
          visible: true,
        };
      } else {
        const lastLine = lines[lines.length - 1] ?? '';
        const strippedLast = lastLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        frame.cursor = {
          row: Math.min(lines.length - 1, size.rows - 1),
          col: Math.max(0, strippedLast.length),
          visible: true,
        };
      }

      const diffResult = FrameDiffer.diff(this.previousFrame, frame, this.forceFullRedraw);
      if (diffResult.patch.length > 0) {
        this.outStream.write(diffResult.patch);
      }
      this.previousFrame = frame;
      this.forceFullRedraw = false;
    } else if (bufferChanged) {
      // Non-TTY fallback
      this.outStream.write(buffer + '\n');
    }

    this.lastBuffer = buffer;
    this.lastCursorCol = cursorCol;
  }

  repaint(): void {
    if (this.inAltScreen) {
      this.outStream.write(`\x1b[2J\x1b[H${CURSOR_STEADY_BLOCK}`);
    }
    const last = this.lastBuffer;
    const lastCol = this.lastCursorCol;
    this.clearLastBuffer();
    if (last) {
      this.render(last, lastCol);
    }
  }

  getLastBuffer(): string {
    return this.lastBuffer;
  }

  getFrame(): TerminalFrame | undefined {
    return this.previousFrame;
  }

  clearLastBuffer(): void {
    this.lastBuffer = '';
    this.previousFrame = undefined;
    this.forceFullRedraw = true;
  }

  onResize = (): void => {
    this.clearLastBuffer();
    const size = this.getSize();
    for (const listener of this.resizeListeners) {
      listener(size);
    }
  };

  onTerminalResize(listener: (size: TerminalSize) => void): () => void {
    this.resizeListeners.push(listener);
    return () => {
      this.resizeListeners = this.resizeListeners.filter((l) => l !== listener);
    };
  }
}
