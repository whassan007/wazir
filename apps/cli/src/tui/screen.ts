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
  private lastCursorCol?: number;
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
      // Enter alternate screen buffer, enable bracketed paste mode (\x1b[?2004h), clear screen, ensure cursor visible as a steady box
      this.outStream.write(`\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2J\x1b[?25h${CURSOR_STEADY_BLOCK}`);
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
      // as a forced block after `wa` exits), show cursor, disable bracketed paste mode (\x1b[?2004l), leave alt screen
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
   * @param cursorCol 1-based column the hardware cursor belongs at on the last line
   *   (e.g. wherever the input prompt's text cursor is). Callers that know this should
   *   always pass it: every line reaching here is padded to the full terminal width
   *   (see FleetTui.draw()), so the fallback below — measuring the last line's own
   *   length — always lands on the last *column*, not wherever the cursor actually is.
   *   That's the "cursor doesn't visibly track typed/deleted/arrow-moved text" bug: the
   *   hardware cursor was permanently pinned to the terminal's bottom-right corner.
   */
  render(buffer: string, cursorCol?: number): void {
    const bufferChanged = buffer !== this.lastBuffer;
    // Moving the text cursor with no other edit (e.g. a bare Left/Right arrow) never
    // changes the rendered buffer text itself, only where the cursor belongs on it — so
    // dedupe on both, not just the buffer, or the cursor visibly stops moving the moment
    // the frame text stops changing.
    if (!bufferChanged && cursorCol === this.lastCursorCol) return;

    if (this.inAltScreen) {
      if (bufferChanged) {
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
      }

      // Explicitly position the hardware cursor at the active prompt line.
      const lines = buffer.split('\n');
      const lastLine = lines[lines.length - 1] ?? '';
      const strippedLast = lastLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      const col = cursorCol ?? strippedLast.length + 1;
      const row = lines.length;
      this.outStream.write(`\x1b[${row};${col}H`);
    } else if (bufferChanged) {
      // Non-TTY & unattached fallback (§23): write clean text
      this.outStream.write(buffer + '\n');
    }

    this.lastBuffer = buffer;
    this.lastCursorCol = cursorCol;
  }

  /**
   * Clears the terminal display and forces full repaint (Ctrl+L).
   */
  repaint(): void {
    if (this.inAltScreen) {
      this.outStream.write(`\x1b[2J\x1b[H${CURSOR_STEADY_BLOCK}`);
    }
    const last = this.lastBuffer;
    const lastCol = this.lastCursorCol;
    this.lastBuffer = '';
    this.lastCursorCol = undefined;
    if (last) {
      this.render(last, lastCol);
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
