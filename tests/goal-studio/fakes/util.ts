import { createHash } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import { GoalStudioFailure } from '../../../packages/goals/src/contracts.js';

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * JsonFileStore revives ISO-8601 strings into Date objects on reload. The
 * contract uses ISO strings everywhere, so stored values are normalized back.
 */
export function datesToIso<T>(value: T): T {
  if (value instanceof Date) return value.toISOString() as unknown as T;
  if (Array.isArray(value)) return value.map((v) => datesToIso(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = datesToIso(v);
    return out as T;
  }
  return value;
}

export async function getIso<T>(store: KeyValueStore, key: string): Promise<T | undefined> {
  const v = await store.get<T>(key);
  return v === undefined ? undefined : datesToIso(v);
}

export async function listIso<T>(store: KeyValueStore, prefix: string): Promise<Array<{ key: string; value: T }>> {
  const entries = await store.list(prefix);
  return entries
    .map((e) => ({ key: e.key, value: datesToIso(e.value) as T }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** In-process keyed mutex shared by every fake instance over the same store. */
class KeyedMutex {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

const mutexes = new WeakMap<object, KeyedMutex>();
export function mutexFor(store: object): KeyedMutex {
  let m = mutexes.get(store);
  if (!m) {
    m = new KeyedMutex();
    mutexes.set(store, m);
  }
  return m;
}

export function fail(code: ConstructorParameters<typeof GoalStudioFailure>[0], message: string, details?: Record<string, unknown>, retryable = false): never {
  throw new GoalStudioFailure(code, message, { retryable, details });
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}
