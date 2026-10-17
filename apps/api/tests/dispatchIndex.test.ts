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

  it('targets redelivery per worker, handles disconnect/reconnect, lease expiry, duplicate requests, retried completions, and 1,000+ historical records in O(pending)', async () => {
    let now = 1_000;
    const { store, fullScans } = countingStore();
    const dispatcher = new TaskDispatcher(store, () => now, 5_000, { completedRetentionMs: 60_000 });
    await dispatcher.ready;

    // Seed 1,000 historical completed records directly in the store
    for (let i = 0; i < 1_000; i += 1) {
      const id = `hist-${i}`;
      await store.put(`dispatch/${id}`, {
        computerId: i % 2 === 0 ? 'w1' : 'w2',
        request: request(id),
        events: [],
        attempt: 1,
        outcome,
        completedAt: 500,
      });
    }

    const w1Frames: string[] = [];
    const w2Frames: string[] = [];
    const mockRes = (frames: string[]) =>
      ({
        write: (chunk: string) => {
          frames.push(chunk);
          return true;
        },
        end: () => undefined,
      }) as unknown as Parameters<TaskDispatcher['subscribe']>[1];

    await dispatcher.subscribe('w1', mockRes(w1Frames));
    await dispatcher.subscribe('w2', mockRes(w2Frames));

    const scansBefore = fullScans();
    const t0 = performance.now();

    // Concurrent dispatches to w1 and w2
    const [d1, d2, dup1] = await Promise.all([
      dispatcher.dispatch('w1', request('task-w1')),
      dispatcher.dispatch('w2', request('task-w2')),
      dispatcher.dispatch('w1', request('task-w1')),
    ]);
    expect([d1.ok, d2.ok]).toContain(true);
    expect([d1, dup1]).toContainEqual({ ok: false, reason: 'REQUEST_ALREADY_DISPATCHED' });

    // Targeted redelivery for w1 must only write to w1Frames, never w2Frames
    w1Frames.length = 0;
    w2Frames.length = 0;
    await dispatcher.redeliver('w1');
    expect(w1Frames).toHaveLength(1);
    expect(w2Frames).toHaveLength(0);

    // Claim task-w1 -> while lease is active, redeliver('w1') emits nothing
    const lease1 = await dispatcher.claim('task-w1', 'w1');
    w1Frames.length = 0;
    await dispatcher.redeliver('w1');
    expect(w1Frames).toHaveLength(0);

    // Advance past lease expiry -> redeliver('w1') redelivers task-w1
    now += 6_000;
    await dispatcher.redeliver('w1');
    expect(w1Frames).toHaveLength(1);

    // Re-claim after lease expiry and commit with idempotent retry
    const lease2 = await dispatcher.claim('task-w1', 'w1');
    expect(lease2.attempt).toBe(2);
    expect(await dispatcher.commit('task-w1', outcome, lease2.token)).toBe('committed');
    expect(await dispatcher.commit('task-w1', outcome, lease2.token)).toBe('duplicate');

    const elapsedMs = performance.now() - t0;
    expect(fullScans()).toBe(scansBefore);
    expect(elapsedMs).toBeLessThan(200);

    // Prune the 1,000 expired historical records (completedAt = 500 <= 65,000 - 60,000)
    now = 65_000;
    const pruned = await dispatcher.pruneCompleted();
    expect(pruned).toBe(1_000);
    // Recently completed task-w1 (completedAt = 7,000 > 5,000) and pending task-w2 remain intact
    expect(await store.get('dispatch/task-w1')).toBeDefined();
    expect(await store.get('dispatch/task-w2')).toBeDefined();
  });
});

