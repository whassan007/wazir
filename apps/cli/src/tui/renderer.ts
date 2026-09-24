/**
 * TerminalRenderer: Double-buffered, frame-diffing terminal renderer.
 * Enforces the single-writer invariant: all interactive visual writes to the terminal
 * flow through this component.
 */

import type { TerminalAdapter } from './adapter.js';
import { FrameDiffer } from './differ.js';
import { TerminalFrame } from './frame.js';
import { RendererMetrics, type RendererMetricsSnapshot } from './metrics.js';

export interface RendererOptions {
  adapter: TerminalAdapter;
}

export class TerminalRenderer {
  private readonly adapter: TerminalAdapter;
  private readonly metrics = new RendererMetrics();
  private previousFrame?: TerminalFrame;
  private forceFullRedraw = true;

  constructor(options: RendererOptions) {
    this.adapter = options.adapter;
  }

  getAdapter(): TerminalAdapter {
    return this.adapter;
  }

  getMetrics(): RendererMetricsSnapshot {
    return this.metrics.getSnapshot();
  }

  resetMetrics(): void {
    this.metrics.reset();
  }

  getPreviousFrame(): TerminalFrame | undefined {
    return this.previousFrame;
  }

  /**
   * Forces the next render to perform a full screen redraw from scratch.
   * Use after terminal resize, alternate screen entry, or visual state recovery.
   */
  invalidate(): void {
    this.previousFrame = undefined;
    this.forceFullRedraw = true;
  }

  /**
   * Allocates a fresh blank frame matching the current terminal viewport dimensions.
   */
  createBlankFrame(): TerminalFrame {
    return TerminalFrame.create(this.adapter.width(), this.adapter.height());
  }

  /**
   * Renders a complete Virtual Terminal Frame to the terminal screen.
   * Compares with previousFrame, generates minimal ANSI patch, and flushes atomically.
   */
  renderFrame(frame: TerminalFrame): void {
    this.metrics.recordFrameRequest();

    // If non-TTY, fallback to clean text output without alternate screen ANSI
    if (!this.adapter.isTTY()) {
      const text = frame.toPlainText();
      const prevText = this.previousFrame ? this.previousFrame.toPlainText() : undefined;
      if (text !== prevText) {
        this.adapter.write(text + '\n');
        this.previousFrame = frame.clone();
      }
      return;
    }

    const start = Date.now();
    const diffResult = FrameDiffer.diff(this.previousFrame, frame, this.forceFullRedraw);
    const durationMs = Date.now() - start;

    if (diffResult.patch.length > 0) {
      this.adapter.write(diffResult.patch);
    }

    this.metrics.recordRender({
      isFullRedraw: diffResult.isFullRedraw,
      cellsChanged: diffResult.cellsChanged,
      bytesWritten: Buffer.byteLength(diffResult.patch, 'utf8'),
      durationMs,
    });

    this.previousFrame = frame.clone();
    this.forceFullRedraw = false;
  }

  /**
   * Repaints the entire display by clearing screen and re-rendering previous frame.
   */
  repaint(): void {
    if (this.adapter.isTTY()) {
      this.adapter.write('\x1b[2J\x1b[H\x1b[2 q');
    }
    const last = this.previousFrame;
    this.invalidate();
    if (last) {
      this.renderFrame(last);
    }
  }
}
