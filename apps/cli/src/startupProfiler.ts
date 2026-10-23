/**
 * Startup Profiler & Latency Telemetry (`WAZIR_PROFILE_STARTUP=1`).
 *
 * Lightweight, zero-dependency profiler for CLI startup and engine initialization.
 * Tracks phase marks and spans (`cli.entry`, `cli.commands_registered`, `cli.parse`,
 * `engine.config`, `engine.store`, `engine.discovery`, `engine.ready`) and can emit
 * structured JSON or human-readable reports when `WAZIR_PROFILE_STARTUP` is enabled.
 */

export interface StartupPhaseMark {
  readonly phase: string;
  readonly timestampMs: number;
  readonly elapsedSinceStartMs: number;
  readonly deltaFromPreviousMs: number;
  readonly detail?: string;
}

export interface StartupSpanMeasurement {
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly detail?: string;
}

export interface StartupProfileReport {
  readonly enabled: boolean;
  readonly argv: readonly string[];
  readonly totalElapsedMs: number;
  readonly marks: readonly StartupPhaseMark[];
  readonly spans: readonly StartupSpanMeasurement[];
}

export interface StartupProfilerOptions {
  readonly enabled?: boolean;
  readonly argv?: readonly string[];
  readonly startTimeMs?: number;
  readonly now?: () => number;
  readonly sink?: (line: string) => void;
}

export function isStartupProfilingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WAZIR_PROFILE_STARTUP?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'json' || raw === 'pretty';
}

export class StartupProfiler {
  private readonly enabled: boolean;
  private readonly argv: readonly string[];
  private readonly now: () => number;
  private readonly sink: (line: string) => void;
  private readonly startTimeMs: number;
  private lastMarkTimeMs: number;
  private readonly marks: StartupPhaseMark[] = [];
  private readonly spans: StartupSpanMeasurement[] = [];
  private emitted = false;

  constructor(options: StartupProfilerOptions = {}) {
    this.enabled = options.enabled ?? isStartupProfilingEnabled();
    this.argv = options.argv ?? process.argv.slice(2);
    this.now = options.now ?? (() => performance.now());
    this.sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
    this.startTimeMs = options.startTimeMs ?? this.now();
    this.lastMarkTimeMs = this.startTimeMs;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  mark(phase: string, detail?: string): StartupPhaseMark {
    const timestampMs = this.now();
    const elapsedSinceStartMs = Math.max(0, Number((timestampMs - this.startTimeMs).toFixed(3)));
    const deltaFromPreviousMs = Math.max(0, Number((timestampMs - this.lastMarkTimeMs).toFixed(3)));
    this.lastMarkTimeMs = timestampMs;
    const entry: StartupPhaseMark = {
      phase,
      timestampMs: Number(timestampMs.toFixed(3)),
      elapsedSinceStartMs,
      deltaFromPreviousMs,
      ...(detail !== undefined ? { detail } : {}),
    };
    this.marks.push(entry);
    return entry;
  }

  measureSync<T>(name: string, fn: () => T, detail?: string): T {
    const startMs = this.now();
    try {
      return fn();
    } finally {
      const endMs = this.now();
      this.spans.push({
        name,
        startMs: Number((startMs - this.startTimeMs).toFixed(3)),
        endMs: Number((endMs - this.startTimeMs).toFixed(3)),
        durationMs: Math.max(0, Number((endMs - startMs).toFixed(3))),
        ...(detail !== undefined ? { detail } : {}),
      });
    }
  }

  async measure<T>(name: string, fn: () => Promise<T> | T, detail?: string): Promise<T> {
    const startMs = this.now();
    try {
      return await fn();
    } finally {
      const endMs = this.now();
      this.spans.push({
        name,
        startMs: Number((startMs - this.startTimeMs).toFixed(3)),
        endMs: Number((endMs - this.startTimeMs).toFixed(3)),
        durationMs: Math.max(0, Number((endMs - startMs).toFixed(3))),
        ...(detail !== undefined ? { detail } : {}),
      });
    }
  }

  getReport(): StartupProfileReport {
    const latestMark = this.marks.at(-1)?.elapsedSinceStartMs ?? 0;
    const latestSpan = this.spans.reduce((max, s) => Math.max(max, s.endMs), 0);
    const currentElapsed = Math.max(0, Number((this.now() - this.startTimeMs).toFixed(3)));
    const totalElapsedMs = Math.max(latestMark, latestSpan, currentElapsed);
    return {
      enabled: this.enabled,
      argv: [...this.argv],
      totalElapsedMs,
      marks: [...this.marks],
      spans: [...this.spans],
    };
  }

  formatReport(format: 'human' | 'json' = 'human'): string {
    const report = this.getReport();
    if (format === 'json') {
      return JSON.stringify({ type: 'wazir.startup_profile', ...report });
    }
    const lines: string[] = [
      `[wazir:startup] argv=${JSON.stringify(report.argv)} total=${report.totalElapsedMs.toFixed(2)}ms`,
    ];
    for (const m of report.marks) {
      const suffix = m.detail ? ` (${m.detail})` : '';
      lines.push(
        `  mark ${m.phase.padEnd(26)} +${m.deltaFromPreviousMs.toFixed(2).padStart(7)}ms  [@ ${m.elapsedSinceStartMs.toFixed(2)}ms]${suffix}`,
      );
    }
    for (const s of report.spans) {
      const suffix = s.detail ? ` (${s.detail})` : '';
      lines.push(
        `  span ${s.name.padEnd(26)}  ${s.durationMs.toFixed(2).padStart(7)}ms  [${s.startMs.toFixed(2)}..${s.endMs.toFixed(2)}ms]${suffix}`,
      );
    }
    return lines.join('\n');
  }

  emitIfEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    if (!this.enabled || this.emitted) return false;
    this.emitted = true;
    const mode = env.WAZIR_PROFILE_STARTUP?.trim().toLowerCase();
    const format = mode === 'json' ? 'json' : 'human';
    this.sink(this.formatReport(format));
    return true;
  }

  reset(): void {
    this.marks.length = 0;
    this.spans.length = 0;
    this.lastMarkTimeMs = this.startTimeMs;
    this.emitted = false;
  }
}

export function createStartupProfiler(options: StartupProfilerOptions = {}): StartupProfiler {
  return new StartupProfiler(options);
}

export const globalStartupProfiler = new StartupProfiler();
