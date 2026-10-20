import { describe, it, expect, afterEach } from 'vitest';
import { ClusterHarness } from './harness/clusterHarness.js';

describe.skipIf(process.env.WAZIR_DISTRIBUTED !== '1')('worker crash recovery and authorized failover', () => {
  let h: ClusterHarness;
  let release = () => {};
  afterEach(async () => { release(); await h?.cleanup(); });

  it('marks a killed worker offline, exposes orphaned work, and recovers on another computer', async () => {
    h = await ClusterHarness.create();
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.simulated.setChatHandler(async () => { await gate; return 'recovered'; });
    const a = await h.startWorker({ computerId: 'a', token: 'worker-token-computer-a' });
    await h.startWorker({ computerId: 'b', token: 'worker-token-computer-b' });
    const id = 'crash-reassign';
    expect((await h.dispatchTask('a', { requestId: id, executionId: 'exec-crash', replayPolicy: 'read-only' })).status).toBe(202);
    await h.pollUntil(() => h.simulated.getRecordedRequests().length === 1, 5000, 20, 'provider started');
    const original = await h.store!.get<any>(`dispatch/${id}`);
    await h.killWorker('a');
    expect(() => process.kill(a.pid, 0)).toThrow();
    await h.waitForExpiry(id);
    expect((await h.claim('b', id, 'worker-token-computer-b')).status).toBe(403);
    await h.pollUntil(async () => {
      const computer = (await h.getComputers()).find(c => c.id === 'a');
      return computer.status === 'offline' && (await h.getTaskStatus(id)).body.recovery === 'orphaned';
    }, 40_000, 100, 'automatic offline and orphan reconciliation');
    const url = `${h.api.url}/api/v1/tasks/${id}/reassign`;
    const forbidden = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer worker-token-computer-b', 'Content-Type': 'application/json' }, body: JSON.stringify({ computerId: 'b' }) });
    expect([401, 403]).toContain(forbidden.status);
    release();
    const reassigned = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${h.apiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ computerId: 'b' }) });
    expect(reassigned.status).toBe(200);
    await h.pollUntil(async () => (await h.getTaskStatus(id)).body.outcome?.ok === true, 8000, 50, 'worker B completion');
    const final = await h.store!.get<any>(`dispatch/${id}`);
    expect(final.computerId).toBe('b');
    expect(final.attempt).toBe(2);
    expect(final.lease.token).not.toBe(original.lease.token);
    expect((await h.reportResult('a', id, { ok: true, output: 'late' }, original.lease.token, 'worker-token-computer-a')).status).toBe(403);
    expect((await h.getTaskStatus(id)).body.outcome.output).toBe('recovered');
    h.evidence.push({ event: 'automatic_offline_authorized_failover', requestId: id, originalAttempt: 1, replacementAttempt: 2, finalOutcome: final.outcome });
  });
});
