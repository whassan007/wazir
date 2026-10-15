// Dispatcher (apps/api/src/server.ts) behaviour found from the worker side. D1 (bounded
// redelivery) was applied from integration-patches/workstream1-dispatcher.patch. D2 (late
// commit after lease expiry) was deliberately NOT applied: the distributed qualification
// suite (tests/distributed/leaseFencing, crashRecovery) requires wall-clock fencing of a
// result whose lease expired, which is the safer invariant; D2 only saved a re-run.
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@wazir/shared';
// @ts-expect-error -- built JS; the dispatcher is exported for tests
import { TaskDispatcher } from '../../apps/api/dist/server.js';

const request = (id: string) => ({ requestId: id, executionId: `exec-${id}`, modelId: 'm', messages: [] });
const result = (output: string) => ({ ok: true, output, inputTokens: 0, outputTokens: 0, durationMs: 0 });

describe('TaskDispatcher integration (Workstream 1)', () => {
  it('already correct: a duplicate result POST from the lease holder is acknowledged, not recorded twice', async () => {
    const d = new TaskDispatcher(new MemoryStore());
    await d.dispatch('w', request('dup'));
    const lease = await d.claim('dup', 'w');
    expect(await d.commit('dup', result('a'), lease.token)).toBe('committed');
    expect(await d.commit('dup', result('b'), lease.token)).toBe('duplicate');
    expect((await d.status('dup')).outcome.output).toBe('a');
  });

  // D1. No replay bound: every lease expiry makes the request claimable again, forever.
  // A worker that crashes deterministically on a request (OOM on a huge prompt, a
  // provider that hangs) is re-dispatched without limit after each disconnection.
  it('D1: redelivery stops after a bounded number of attempts and records a terminal failure', async () => {
    let now = 0;
    const d = new TaskDispatcher(new MemoryStore(), () => now, 100);
    await d.dispatch('w', request('loop'));
    let claims = 0;
    for (let i = 0; i < 20; i++) {
      try { await d.claim('loop', 'w'); claims++; } catch { break; }
      now += 1_000; // the lease lapses without a result (worker died)
    }
    expect(claims).toBeLessThanOrEqual(5);
    const status = await d.status('loop');
    expect(status.outcome).toMatchObject({ ok: false, error: expect.stringContaining('DELIVERY_ATTEMPTS_EXHAUSTED') });
  });

  // D2. A finished result is discarded when it arrives just after the lease expired, even
  // though no other worker has claimed the request since. The request is then redelivered
  // and the whole model generation runs again. Fencing should be by token (a newer claim),
  // not by wall-clock alone.
  it('D2 (rejected by design): an expired lease cannot commit, even with no newer claim', async () => {
    let now = 0;
    const d = new TaskDispatcher(new MemoryStore(), () => now, 100);
    await d.dispatch('w', request('late'));
    const lease = await d.claim('late', 'w');
    now = 150;
    await expect(d.commit('late', result('finished'), lease.token)).rejects.toThrow('LEASE_LOST');
  });

  it('already correct: once a newer attempt has claimed, the old token is fenced', async () => {
    let now = 0;
    const d = new TaskDispatcher(new MemoryStore(), () => now, 100);
    await d.dispatch('w', request('fenced'));
    const old = await d.claim('fenced', 'w');
    now = 150;
    const fresh = await d.claim('fenced', 'w');
    await expect(d.commit('fenced', result('stale'), old.token)).rejects.toThrow('LEASE_LOST');
    expect(await d.commit('fenced', result('current'), fresh.token)).toBe('committed');
  });
});
