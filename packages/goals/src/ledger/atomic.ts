import type { KeyValueStore } from '@wazir/shared';

/**
 * Storage helpers shared by the goal ledger and event log.
 *
 * `atomicUpdate` is the only read-modify-write primitive the ledger uses. With a
 * store that implements `KeyValueStore.update` (MemoryStore, JsonFileStore,
 * PostgresStore) it is atomic across every process sharing that store: the
 * JsonFileStore holds its cross-process file lock and re-reads the file, Postgres
 * holds a per-key advisory lock in one transaction. A `mutate` that throws aborts
 * the write on all three, which is what makes compare-and-set possible.
 *
 * For a store without `update`, a per-key in-process mutex serialises callers that
 * share this module. That is NOT safe across processes; such a store must not be
 * shared by two writers (documented in the agent-01 report).
 */

const localLocks = new WeakMap<KeyValueStore, Map<string, Promise<unknown>>>();

export async function atomicUpdate<T>(store: KeyValueStore, key: string, mutate: (current: T | undefined) => T): Promise<T> {
  if (typeof store.update === 'function') {
    return store.update<T>(key, (current) => mutate(current === undefined ? undefined : plain(current)));
  }
  let locks = localLocks.get(store);
  if (!locks) {
    locks = new Map();
    localLocks.set(store, locks);
  }
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const current = await store.get<T>(key);
    const next = mutate(current === undefined ? undefined : plain(current));
    await store.put(key, next);
    return next;
  });
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

/**
 * Canonical JSON form of a stored value: what every backend round-trips to.
 * JsonFileStore and PostgresStore revive ISO-8601 strings into `Date` objects on
 * read; the Goal Studio contract types those fields as ISO strings, so every value
 * read back is normalised here (Dates serialise to their ISO string). It also
 * guarantees callers never hold a reference into a store's in-memory cache.
 */
export function plain<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function nowIso(clock: () => Date): string {
  return clock().toISOString();
}
