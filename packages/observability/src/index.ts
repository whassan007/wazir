export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
  at: Date;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  readonly records: LogRecord[];
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured console logger with in-memory ring buffer (bounded). */
export function createLogger(scope: string, minLevel: LogLevel = 'info', maxRecords = 1000): Logger {
  const records: LogRecord[] = [];

  function emit(level: LogLevel, message: string, data?: unknown): void {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const record: LogRecord = { level, scope, message, data, at: new Date() };
    records.push(record);
    if (records.length > maxRecords) records.shift();
    const line = JSON.stringify({ at: record.at.toISOString(), ...record });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    records,
  };
}

export class Metrics {
  private counters = new Map<string, number>();
  private timers = new Map<string, { totalMs: number; count: number }>();

  inc(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  time(name: string, ms: number): void {
    const entry = this.timers.get(name) ?? { totalMs: 0, count: 0 };
    entry.totalMs += ms;
    entry.count += 1;
    this.timers.set(name, entry);
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, value] of this.counters) out[name] = value;
    for (const [name, entry] of this.timers) {
      out[`${name}.avgMs`] = entry.count > 0 ? Math.round(entry.totalMs / entry.count) : 0;
      out[`${name}.count`] = entry.count;
    }
    return out;
  }
}

export function createMetrics(): Metrics {
  return new Metrics();
}
