import readline from 'node:readline';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export class TerminalScreen {
  private inAltScreen = false;
  private rawModeActive = false;
  private lastBuffer = '';
  private resizeListeners: Array<(size: TerminalSize) => void> = [];

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
    if ((this.inStream as any).isTTY && typeof (this.inStream as any).setRawMode === 'function') {
      try {
        (this.inStream as any).setRawMode(true);
        this.rawModeActive = true;
        this.inStream.resume();
      } catch {
        // Ignore in headless/pipe mode
      }
    }

    if ((this.outStream as any).isTTY) {
      // Enter alternate screen buffer, clear screen, ensure cursor visible
      this.outStream.write('\x1b[?1049h\x1b[H\x1b[2J\x1b[?25h');
      this.inAltScreen = true;
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
      // Show cursor, leave alternate screen buffer
      this.outStream.write('\x1b[?25h\x1b[?1049l');
      this.inAltScreen = false;
    }
  }

  render(buffer: string): void {
    if (buffer === this.lastBuffer) return;
    this.lastBuffer = buffer;

    if (this.inAltScreen) {
      // Move cursor to top-left and write lines with \x1b[K (erase to line end)
      // to ensure erased characters from previous frames do not linger on screen
      const lines = buffer.split('\n');
      const cleared = lines.map((l) => l + '\x1b[K').join('\r\n') + '\x1b[K\x1b[J';
      this.outStream.write('\x1b[H' + cleared);
    }
  }

  getLastBuffer(): string {
    return this.lastBuffer;
  }

  onResize = (): void => {
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
