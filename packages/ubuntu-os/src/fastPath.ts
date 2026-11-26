export interface LatencySample {
  tier: 0 | 1 | 2;
  label: string;
  dispatchOverheadMs: number;
  totalDurationMs: number;
  ttftMs?: number;
}

export interface PercentileSummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export function computePercentiles(values: number[]): PercentileSummary {
  if (values.length === 0) return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const p50Idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.5));
  const p95Idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95));
  return {
    count: sorted.length,
    p50Ms: Number(sorted[p50Idx].toFixed(3)),
    p95Ms: Number(sorted[p95Idx].toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

export class FastPathTelemetry {
  private readonly samples: LatencySample[] = [];

  record(sample: LatencySample): void {
    this.samples.push(sample);
  }

  summarizeTier(tier: 0 | 1 | 2): { dispatch: PercentileSummary; total: PercentileSummary } {
    const filtered = this.samples.filter((s) => s.tier === tier);
    return {
      dispatch: computePercentiles(filtered.map((s) => s.dispatchOverheadMs)),
      total: computePercentiles(filtered.map((s) => s.totalDurationMs)),
    };
  }

  all(): readonly LatencySample[] {
    return this.samples;
  }
}
