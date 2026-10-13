import type { WindowSpec } from './types.js';

export interface WindowBounds {
  /** Inclusive start (ms epoch). */
  start: number;
  /** Exclusive end for calendar windows; rolling windows have none (they slide). */
  end?: number;
  /** When usage counted now stops counting: calendar end, or for rolling, start + length. */
  resetHint: number;
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** True for the window strings this module understands. */
export function isValidWindow(spec: WindowSpec): boolean {
  return /^\d+(s|m|h|d)$/.test(spec) || spec === 'day' || spec === 'week' || spec === 'month';
}

/** Bounds of the window containing `now`. Calendar windows are UTC. */
export function windowBounds(spec: WindowSpec, now = Date.now()): WindowBounds {
  const rolling = /^(\d+)(s|m|h|d)$/.exec(spec);
  if (rolling) {
    const length = Number(rolling[1]) * UNIT_MS[rolling[2]];
    return { start: now - length, resetHint: now + length };
  }
  const d = new Date(now);
  if (spec === 'day') {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return { start, end: start + UNIT_MS.d, resetHint: start + UNIT_MS.d };
  }
  if (spec === 'week') {
    const day = (d.getUTCDay() + 6) % 7; // Monday = 0
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
    return { start, end: start + 7 * UNIT_MS.d, resetHint: start + 7 * UNIT_MS.d };
  }
  if (spec === 'month') {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    return { start, end, resetHint: end };
  }
  throw new Error(`INVALID_WINDOW: ${spec}`);
}
