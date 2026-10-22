import { describe, it, expect } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import { TaskDispatcher } from '../src/server.js';

const request = { requestId: 'r', executionId: 'e', modelId: 'm', messages: [] };
const outcome = { ok: true, output: 'done', inputTokens: 0, outputTokens: 0, durationMs: 0 };

describe('dispatch recovery safety', () => {
  it('blocks opaque replay after expiry, including after restart and direct claim', async () => {
    const store = new MemoryStore();
    let now = 0;
    const a = new TaskDispatcher(store, () => now, 100);
    await a.dispatch('a', request);
    const old = await a.claim('r', 'a');
    now = 101;
    const b = new TaskDispatcher(store, () => now, 100);
    await expect(b.claim('r', 'a')).rejects.toThrow('RESOURCE_BUSY');
    expect((await b.status('r'))?.outcome?.error).toBe('UNKNOWN_OUTCOME');
    await expect(b.reassign('r', 'b')).rejects.toThrow('EXECUTION_TERMINAL');
    await expect(a.commit('r', outcome, old.token)).rejects.toThrow('LEASE_LOST');
    expect(await store.list('dispatch-pending/')).toHaveLength(0);
  });
  it('marks safe abandoned work orphaned, reassigns it, and fences old holders', async () => {
    const store = new MemoryStore();
    let now = 0;
    const d = new TaskDispatcher(store, () => now, 100);
    await d.dispatch('a', { ...request, replayPolicy: 'read-only' });
    const old = await d.claim('r', 'a');
    await expect(d.reassign('r', 'b')).rejects.toThrow('RESOURCE_BUSY');
    now = 101;
    await d.reconcile(new Set(['a']));
    expect((await d.status('r'))?.recovery).toBe('orphaned');
    await d.reassign('r', 'b');
    await expect(d.claim('r', 'a')).rejects.toThrow('UNKNOWN_DISPATCH');
    await expect(d.renew('r', old.token)).rejects.toThrow('LEASE_LOST');
    const next = await d.claim('r', 'b');
    expect(next.attempt).toBe(2);
    await d.commit('r', outcome, next.token);
    expect((await d.status('r'))?.outcome).toEqual(outcome);
  });
  it('permits reassignment of unclaimed opaque work without permitting replay', async () => {
    const d = new TaskDispatcher();
    await d.dispatch('a', request);
    await d.reassign('r', 'b');
    expect(await d.owner('r')).toBe('b');
    expect((await d.claim('r', 'b')).attempt).toBe(1);
  });
  it('acknowledges a committed result after lease expiry without changing it', async () => {
    const store = new MemoryStore();
    let now = 0;
    const d = new TaskDispatcher(store, () => now, 100);
    await d.dispatch('a', request);
    const lease = await d.claim('r', 'a');
    await d.commit('r', outcome, lease.token);
    now = 1000;
    const restarted = new TaskDispatcher(store, () => now, 100);
    await expect(restarted.commit('r', { ...outcome, output: 'overwrite' }, lease.token)).resolves.toBe('duplicate');
    await expect(restarted.commit('r', outcome, 'foreign')).rejects.toThrow('LEASE_LOST');
    expect((await restarted.status('r'))?.outcome).toEqual(outcome);
  });
  it.each(['cancel', 'complete'] as const)('preserves the first terminal result when %s wins', async first => {
    const store = new MemoryStore();
    const a = new TaskDispatcher(store);
    const b = new TaskDispatcher(store);
    await a.dispatch('a', request);
    const lease = await a.claim('r', 'a');
    if (first === 'cancel') {
      await Promise.all([a.cancel('r'), b.commit('r', outcome, lease.token).catch(e => expect(e.message).toBe('LEASE_LOST'))]);
      expect((await a.status('r'))?.outcome?.error).toBe('CANCELLED');
      await expect(b.renew('r', lease.token)).rejects.toThrow('LEASE_LOST');
    } else {
      await Promise.all([b.commit('r', outcome, lease.token), a.cancel('r')]);
      expect((await a.status('r'))?.outcome).toEqual(outcome);
    }
    const restarted = new TaskDispatcher(store);
    await restarted.ready;
    expect(restarted.totalQueued).toBe(0);
    await restarted.cancel('r');
    expect((await restarted.status('r'))?.outcome).toEqual((await a.status('r'))?.outcome);
  });
});
