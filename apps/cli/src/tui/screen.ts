import readline from 'node:readline';

export interface TerminalSize {
  columns: number;
  rows: number;
}

// DECSCUSR cursor-style codes. Nothing in this file ever set one before, so the
// hardware cursor just kept whatever shape/blink state was left over from
// whatever ran in the terminal immediately before `wa` — on some terminals
// that's a thin bar, or blinking in a way that reads as invisible against a
// dark background. Setting it explicitly makes the cursor a real, chunky box
// regardless of what came before.
const CURSOR_STEADY_BLOCK = '\x1b[2 q';
const CURSOR_DEFAULT = '\x1b[0 q';

export class TerminalScreen {
  private inAltScreen = false;
  private rawModeActive = false;
  private keypressBound = false;
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
    // 3. Raw Mode & Keypress Binding Check:
    // Verify that stdin is correctly running in raw mode so structured key objects are passed
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

    // Bind readline keypress event emitter so structured key objects are emitted
    if (!this.keypressBound) {
      try {
        readline.emitKeypressEvents(this.inStream);
        this.keypressBound = true;
      } catch {
        // Ignore in mock streams without readline support
      }
    }

    if ((this.outStream as any).isTTY) {
      // Enter alternate screen buffer, clear screen, ensure cursor visible as a steady box
      this.outStream.write(`\x1b[?1049h\x1b[H\x1b[2J\x1b[?25h${CURSOR_STEADY_BLOCK}`);
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
      // Restore the terminal's own default cursor style (don't leave it stuck
      // as a forced block after `wa` exits), show cursor, leave alt screen
      this.outStream.write(`${CURSOR_DEFAULT}\x1b[?25h\x1b[?1049l`);
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

  render(buffer: string): void {
    if (buffer === this.lastBuffer) return;
    this.lastBuffer = buffer;

    if (this.inAltScreen) {
      // Move cursor to top-left and write lines with \x1b[K (erase to line end) so leftover
      // characters from a previous, longer frame never linger. This used to be paired with
      // a full \x1b[2J on every frame as a defensive belt-and-suspenders measure, but that
      // blanked and repainted the whole screen on every single redraw (every keystroke,
      // every 250ms spinner tick, every streamed token) which is a visible flicker on real
      // terminals. It's unnecessary now that every line is clamped to the exact terminal
      // width before reaching here (see FleetTui.draw()) — a fully space-padded row already
      // overwrites any stale trailing glyphs on its own, so per-line \x1b[K is enough.
      const lines = buffer.split('\n');
      const cleared = lines.map((l) => l + '\x1b[K').join('\r\n') + '\x1b[K\x1b[J';
      this.outStream.write('\x1b[H' + cleared);

      // Explicitly position the hardware cursor at the active prompt line
      const lastLine = lines[lines.length - 1] ?? '';
      const strippedLast = lastLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      const cursorCol = strippedLast.length + 1;
      const cursorRow = lines.length;
      this.outStream.write(`\x1b[${cursorRow};${cursorCol}H`);
    } else {
      // Non-TTY & unattached fallback (§23): write clean text
      this.outStream.write(buffer + '\n');
    }
  }

  /**
   * Clears the terminal display and forces full repaint (Ctrl+L).
   */
  repaint(): void {
    if (this.inAltScreen) {
      this.outStream.write(`\x1b[2J\x1b[H${CURSOR_STEADY_BLOCK}`);
    }
    const last = this.lastBuffer;
    this.lastBuffer = '';
    if (last) {
      this.render(last);
    }
  }

  getLastBuffer(): string {
    return this.lastBuffer;
  }

  /**
   * Invalidates the diff cache so the next render() writes all lines.
   * Use on view transitions to prevent stale content from the previous view.
   */
  clearLastBuffer(): void {
    this.lastBuffer = '';
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
