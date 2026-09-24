/**
 * TerminalSession: Sole owner of interactive terminal lifecycle and resources.
 * Coordinates alternate screen, raw mode, cursor visibility, input controller,
 * renderer, resize controller, and idempotent cleanup.
 */

import { NodeTerminalAdapter, type TerminalAdapter } from './adapter.js';
import { InputController } from './inputController.js';
import { TerminalRenderer } from './renderer.js';

export interface TerminalSessionOptions {
  adapter?: TerminalAdapter;
  inStream?: NodeJS.ReadableStream;
  outStream?: NodeJS.WritableStream;
}

export class TerminalSession {
  readonly adapter: TerminalAdapter;
  readonly input: InputController;
  readonly renderer: TerminalRenderer;

  private active = false;
  private cleanedUp = false;
  private unsubscribeResize?: () => void;

  constructor(options: TerminalSessionOptions = {}) {
    if (options.adapter) {
      this.adapter = options.adapter;
      this.input = new InputController(options.inStream ?? process.stdin);
    } else {
      const inStream = options.inStream ?? process.stdin;
      const outStream = options.outStream ?? process.stdout;
      this.adapter = new NodeTerminalAdapter(inStream, outStream);
      this.input = new InputController(inStream);
    }

    this.renderer = new TerminalRenderer({ adapter: this.adapter });
  }

  /**
   * Initializes the interactive terminal session:
   * - enters alternate screen (if TTY)
   * - enables raw mode (if TTY)
   * - attaches input controller
   * - registers resize listener
   */
  start(): void {
    if (this.active || this.cleanedUp) return;
    this.active = true;

    // Only interactive full-screen TUI enters alternate screen and enables raw mode
    if (this.adapter.isTTY()) {
      this.adapter.enterAlternateScreen();
      this.adapter.enableRawMode();
    }

    this.input.attach();

    this.unsubscribeResize = this.adapter.onResize(() => {
      this.renderer.invalidate();
    });
  }

  /**
   * Idempotent cleanup of all terminal states and subscriptions:
   * - detaches input controller
   * - unregisters resize listener
   * - restores default cursor and cursor visibility
   * - disables raw mode
   * - leaves alternate screen buffer
   */
  cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.active = false;

    if (this.unsubscribeResize) {
      this.unsubscribeResize();
      this.unsubscribeResize = undefined;
    }

    this.input.detach();

    if (this.adapter.isTTY()) {
      this.adapter.showCursor();
      this.adapter.disableRawMode();
      this.adapter.leaveAlternateScreen();
    }

    this.adapter.destroy();
  }

  isActive(): boolean {
    return this.active;
  }

  isCleanedUp(): boolean {
    return this.cleanedUp;
  }
}
