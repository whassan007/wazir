import readline from 'node:readline';
import { color } from '../colors.js';

/**
 * Standard Unicode braille pattern animation frames (§1).
 * Smooth rotational loading indicator.
 */
export const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export type BrailleFrame = (typeof BRAILLE_FRAMES)[number];

export function getBrailleFrame(tick: number): BrailleFrame {
  return BRAILLE_FRAMES[Math.abs(Math.floor(tick)) % BRAILLE_FRAMES.length];
}

export interface StatusLoaderOptions {
  text?: string;
  stream?: NodeJS.WritableStream;
  interval?: number;
  color?: (text: string) => string;
  isTTY?: boolean;
}

/**
 * Animated braille spinner and status loader with in-place terminal updates (§1, §2, §3).
 */
export class StatusLoader {
  private readonly stream: NodeJS.WritableStream;
  private readonly interval: number;
  private readonly frameColor: (text: string) => string;
  private readonly isTTY: boolean;

  private frameIndex = 0;
  private text = '';
  private timer?: NodeJS.Timeout;
  private spinning = false;

  constructor(options: StatusLoaderOptions = {}) {
    this.stream = options.stream ?? process.stderr;
    this.interval = options.interval ?? 80;
    this.frameColor = options.color ?? color.cyan;
    this.isTTY = options.isTTY ?? Boolean((this.stream as any).isTTY);
    this.text = options.text ?? '';
  }

  isSpinning(): boolean {
    return this.spinning;
  }

  getText(): string {
    return this.text;
  }

  getCurrentFrame(): BrailleFrame {
    return BRAILLE_FRAMES[this.frameIndex % BRAILLE_FRAMES.length];
  }

  getFrameIndex(): number {
    return this.frameIndex;
  }

  /**
   * Starts the spinner animation loop (§1, §2).
   */
  start(text?: string): this {
    if (text !== undefined) {
      this.text = text;
    }
    if (this.spinning) {
      return this;
    }
    this.spinning = true;
    this.frameIndex = 0;

    if (this.isTTY) {
      // Hide cursor during active animation
      try {
        this.stream.write('\x1b[?25l');
      } catch {
        // Ignore
      }

      this.render();
      this.timer = setInterval(() => {
        this.frameIndex = (this.frameIndex + 1) % BRAILLE_FRAMES.length;
        this.render();
      }, this.interval);

      if (typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    } else {
      // Non-TTY stream fallback: output single clean status line once
      if (this.text) {
        this.stream.write(`[-] ${this.text}\n`);
      }
    }

    return this;
  }

  /**
   * Updates the status loader text dynamically in-place (§2).
   */
  setText(text: string): this {
    this.text = text;
    if (this.spinning && this.isTTY) {
      this.render();
    }
    return this;
  }

  /**
   * Advances the spinner by one frame manually (useful for tick loops or tests).
   */
  tick(): BrailleFrame {
    this.frameIndex = (this.frameIndex + 1) % BRAILLE_FRAMES.length;
    if (this.spinning && this.isTTY) {
      this.render();
    }
    return this.getCurrentFrame();
  }

  /**
   * Renders in-place terminal updates using cursor management (§2).
   * Refreshes on the same line without flooding terminal scrollback history.
   */
  private render(): void {
    if (!this.isTTY) return;

    const frame = this.frameColor(BRAILLE_FRAMES[this.frameIndex % BRAILLE_FRAMES.length]);
    const line = `${frame} ${this.text}`;

    // Use readline cursor positioning and line clearing for clean in-place refresh
    if (typeof readline.cursorTo === 'function' && typeof readline.clearLine === 'function') {
      try {
        readline.cursorTo(this.stream, 0);
        readline.clearLine(this.stream, 0);
        this.stream.write(line);
        return;
      } catch {
        // Fall back to ANSI cursor codes below
      }
    }

    // Direct ANSI fallback: carriage return (\r) + erase line (\x1b[2K)
    this.stream.write(`\r\x1b[2K${line}`);
  }

  /**
   * Clears the active line without printing a termination line.
   */
  clear(): this {
    if (this.isTTY) {
      if (typeof readline.cursorTo === 'function' && typeof readline.clearLine === 'function') {
        try {
          readline.cursorTo(this.stream, 0);
          readline.clearLine(this.stream, 0);
        } catch {
          this.stream.write('\r\x1b[2K');
        }
      } else {
        this.stream.write('\r\x1b[2K');
      }
    }
    return this;
  }

  /**
   * Safely stops the animation timer, restores the terminal cursor, and clears the line (§3).
   */
  stop(): this {
    if (!this.spinning) return this;
    this.stopTimer();
    this.clear();
    this.restoreCursor();
    this.spinning = false;
    return this;
  }

  /**
   * Completes the status with a green checkmark ✓ and restores cursor.
   */
  succeed(text?: string): this {
    const finalMsg = text ?? this.text;
    this.stop();
    if (this.isTTY) {
      this.stream.write(`${color.green('✓')} ${finalMsg}\n`);
    } else if (finalMsg) {
      this.stream.write(`[✓] ${finalMsg}\n`);
    }
    return this;
  }

  /**
   * Completes the status with a red cross ✕ and restores cursor.
   */
  fail(text?: string): this {
    const finalMsg = text ?? this.text;
    this.stop();
    if (this.isTTY) {
      this.stream.write(`${color.red('✕')} ${finalMsg}\n`);
    } else if (finalMsg) {
      this.stream.write(`[✕] ${finalMsg}\n`);
    }
    return this;
  }

  /**
   * Completes the status with a yellow warning ! and restores cursor.
   */
  warn(text?: string): this {
    const finalMsg = text ?? this.text;
    this.stop();
    if (this.isTTY) {
      this.stream.write(`${color.yellow('!')} ${finalMsg}\n`);
    } else if (finalMsg) {
      this.stream.write(`[!] ${finalMsg}\n`);
    }
    return this;
  }

  /**
   * Completes the status with an info badge ℹ and restores cursor.
   */
  info(text?: string): this {
    const finalMsg = text ?? this.text;
    this.stop();
    if (this.isTTY) {
      this.stream.write(`${color.blue('ℹ')} ${finalMsg}\n`);
    } else if (finalMsg) {
      this.stream.write(`[i] ${finalMsg}\n`);
    }
    return this;
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private restoreCursor(): void {
    if (this.isTTY) {
      try {
        this.stream.write('\x1b[?25h');
      } catch {
        // Ignore
      }
    }
  }
}

export { StatusLoader as BrailleSpinner };

/**
 * Convenience factory for creating a StatusLoader.
 */
export function createSpinner(text?: string, options?: StatusLoaderOptions): StatusLoader {
  return new StatusLoader({ ...options, text });
}

/**
 * Executes an async action wrapped in a braille spinner with guaranteed stop/cleanup (§3).
 */
export async function withSpinner<T>(
  text: string,
  action: (loader: StatusLoader) => Promise<T>,
  options?: StatusLoaderOptions,
): Promise<T> {
  const loader = new StatusLoader({ ...options, text }).start();
  try {
    const result = await action(loader);
    loader.stop();
    return result;
  } catch (error) {
    loader.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
