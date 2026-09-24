/**
 * RenderScheduler: coalesces high-frequency state updates and limits frame rate.
 * Prevents redrawing the terminal for every individual token or state mutation.
 */

export interface RenderSchedulerOptions {
  /** Maximum frames per second (default: 30) */
  maxFps?: number;
  /** Render callback called on render tick */
  render: () => void;
}

export class RenderScheduler {
  private readonly minIntervalMs: number;
  private readonly renderFn: () => void;
  private scheduledTimer?: NodeJS.Timeout;
  private isRenderPending = false;
  private lastRenderTime = 0;
  private stopped = false;

  constructor(options: RenderSchedulerOptions) {
    const fps = options.maxFps && options.maxFps > 0 ? options.maxFps : 30;
    this.minIntervalMs = Math.floor(1000 / fps);
    this.renderFn = options.render;
  }

  /**
   * Requests a render. If called multiple times within the frame window,
   * coalesces into a single upcoming frame.
   */
  schedule(): void {
    if (this.stopped) return;

    this.isRenderPending = true;
    if (this.scheduledTimer) return;

    const now = Date.now();
    const elapsed = now - this.lastRenderTime;

    if (elapsed >= this.minIntervalMs) {
      this.executeRender();
    } else {
      const delay = this.minIntervalMs - elapsed;
      this.scheduledTimer = setTimeout(() => {
        this.scheduledTimer = undefined;
        if (this.isRenderPending && !this.stopped) {
          this.executeRender();
        }
      }, delay);
    }
  }

  /**
   * Immediately executes a render, bypassing the rate limiter.
   * Useful for immediate keystroke feedback or view switching.
   */
  scheduleImmediate(): void {
    if (this.stopped) return;
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = undefined;
    }
    this.executeRender();
  }

  private executeRender(): void {
    this.isRenderPending = false;
    this.lastRenderTime = Date.now();
    try {
      this.renderFn();
    } catch {
      // Best-effort error boundary around render
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = undefined;
    }
    this.isRenderPending = false;
  }
}
