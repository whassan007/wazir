import { describe, it, expect } from 'vitest';
import { MemoryStore, type KeyValueStore } from '@wazir/shared';
import { TaskDispatcher } from '../src/server.js';

const request = (id: string) => ({ requestId: id, executionId: `exec-${id}`, modelId: 'test', messages: [] });
const outcome = { ok: true, output: 'done', inputTokens: 1, outputTokens: 1, durationMs: 1 };

/** Counts full `dispatch/` scans so the test can assert redelivery no longer does them. */
function countingStore(): { store: KeyValueStore; fullScans: () => number } {
  const inner = new MemoryStore();
  let scans = 0;
  const store: KeyValueStore = {
    update: inner.update!.bind(inner),
    put: inner.put.bind(inner),
    get: inner.get.bind(inner),
    delete: inner.delete.bind(inner),
    clear: inner.clear.bind(inner),
    list: async (prefix: string) => {
      if (prefix === 'dispatch/') scans += 1;
      return inner.list(prefix);
    },
  };
  return { store, fullScans: () => scans };
}

describe('TaskDispatcher pending index (review finding F)', () => {
  it('redelivery reads only pending work, not the full dispatch history', async () => {
    const { store, fullScans } = countingStore();
    const dispatcher = new TaskDispatcher(store, () => 0, 1000);
    await dispatcher.ready;
    for (let i = 0; i < 20; i += 1) {
      await dispatcher.dispatch('w', request(`done-${i}`));
      const lease = await dispatcher.claim(`done-${i}`, 'w');
      await dispatcher.commit(`done-${i}`, outcome, lease.token);
    }
    await dispatcher.dispatch('w', request('live'));
    const scansBefore = fullScans();
    for (let i = 0; i < 10; i += 1) await dispatcher.redeliver();
    expect(fullScans()).toBe(scansBefore);
    expect(dispatcher.totalQueued).toBe(1);
    expect((await dispatcher.assignments()).map(a => a.id)).toEqual(['exec-live']);
    // Completed records stay queryable from the authoritative store.
    expect((await dispatcher.status('done-3'))?.outcome?.output).toBe('done');
    expect((await store.list('dispatch-pending/')).map(e => e.key)).toEqual(['dispatch-pending/live']);
  });

  it('indexes pending records written before the index existed (upgrade path)', async () => {
    const store = new MemoryStore();
    await store.put('dispatch/legacy', { computerId: 'w', request: request('legacy'), events: [], attempt: 0 });
    await store.put('dispatch/legacy-done', { computerId: 'w', request: request('legacy-done'), events: [], attempt: 1, outcome });
    const dispatcher = new TaskDispatcher(store, () => 0, 1000);
    await dispatcher.ready;
    expect(dispatcher.totalQueued).toBe(1);
    expect(dispatcher.ownerOf('legacy')).toBe('w');
  });

  it('applies opt-in retention only to completed records with a known completion time', async () => {
    let now = 0;
    const store = new MemoryStore();
    const first = new TaskDispatcher(store, () => now, 1000);
    await first.dispatch('w', request('old'));
    const lease = await first.claim('old', 'w');
    await first.commit('old', outcome, lease.token);
    await store.put('dispatch/unknown-age', { computerId: 'w', request: request('unknown-age'), events: [], attempt: 1, outcome });
    await first.dispatch('w', request('pending'));

    now = 10 * 24 * 60 * 60 * 1000;
    const second = new TaskDispatcher(store, () => now, 1000, { completedRetentionMs: 24 * 60 * 60 * 1000 });
    await second.ready;
    expect(await store.get('dispatch/old')).toBeUndefined();
    expect(await store.get('dispatch/unknown-age')).toBeDefined();
    expect(await store.get('dispatch/pending')).toBeDefined();
    expect(second.totalQueued).toBe(1);
  });
});
