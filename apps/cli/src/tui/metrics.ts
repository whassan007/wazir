/**
 * Performance metrics for terminal rendering.
 * Tracks frame rates, diffing efficiency, and rendering latency.
 */

export interface RendererMetricsSnapshot {
  framesRequested: number;
  framesRendered: number;
  framesCoalesced: number;
  fullRedraws: number;
  diffRedraws: number;
  cellsChanged: number;
  bytesWritten: number;
  averageRenderMs: number;
  maxRenderMs: number;
  lastRenderMs: number;
}

export class RendererMetrics {
  private framesRequested = 0;
  private framesRendered = 0;
  private framesCoalesced = 0;
  private fullRedraws = 0;
  private diffRedraws = 0;
  private cellsChanged = 0;
  private bytesWritten = 0;
  private totalRenderDurationMs = 0;
  private maxRenderMs = 0;
  private lastRenderMs = 0;

  recordFrameRequest(): void {
    this.framesRequested++;
  }

  recordFrameCoalesced(): void {
    this.framesCoalesced++;
  }

  recordRender(params: {
    isFullRedraw: boolean;
    cellsChanged: number;
    bytesWritten: number;
    durationMs: number;
  }): void {
    this.framesRendered++;
    if (params.isFullRedraw) {
      this.fullRedraws++;
    } else {
      this.diffRedraws++;
    }
    this.cellsChanged += params.cellsChanged;
    this.bytesWritten += params.bytesWritten;
    this.totalRenderDurationMs += params.durationMs;
    this.lastRenderMs = params.durationMs;
    if (params.durationMs > this.maxRenderMs) {
      this.maxRenderMs = params.durationMs;
    }
  }

  getSnapshot(): RendererMetricsSnapshot {
    const avg =
      this.framesRendered > 0 ? this.totalRenderDurationMs / this.framesRendered : 0;
    return {
      framesRequested: this.framesRequested,
      framesRendered: this.framesRendered,
      framesCoalesced: this.framesCoalesced,
      fullRedraws: this.fullRedraws,
      diffRedraws: this.diffRedraws,
      cellsChanged: this.cellsChanged,
      bytesWritten: this.bytesWritten,
      averageRenderMs: Number(avg.toFixed(2)),
      maxRenderMs: Number(this.maxRenderMs.toFixed(2)),
      lastRenderMs: Number(this.lastRenderMs.toFixed(2)),
    };
  }

  reset(): void {
    this.framesRequested = 0;
    this.framesRendered = 0;
    this.framesCoalesced = 0;
    this.fullRedraws = 0;
    this.diffRedraws = 0;
    this.cellsChanged = 0;
    this.bytesWritten = 0;
    this.totalRenderDurationMs = 0;
    this.maxRenderMs = 0;
    this.lastRenderMs = 0;
  }
}
