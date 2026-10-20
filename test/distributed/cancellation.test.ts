import { afterEach, describe, expect, it } from 'vitest';
import { ClusterHarness } from './harness/clusterHarness.js';

describe.skipIf(process.env.WAZIR_DISTRIBUTED !== '1')('distributed cancellation', () => {
  let h: ClusterHarness;
  let release = () => {};
  afterEach(async () => { release(); await h?.cleanup(); });
  it('authorizes cancellation, aborts provider work, persists cancellation, and fences late results', async () => {
    h = await ClusterHarness.create();
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.simulated.setChatHandler(async () => { await gate; return 'late'; });
    await h.startWorker({ computerId: 'cancel-worker', token: 'worker-token-cancel-test' });
    const id = 'cancel-running';
    await h.dispatchTask('cancel-worker', { requestId: id, executionId: 'exec-cancel', replayPolicy: 'never' });
    await h.pollUntil(() => h.simulated.getRecordedRequests().length === 1, 5000, 20, 'provider request');
    const original = await h.store!.get<any>(`dispatch/${id}`);
    const cancel = (token: string) => fetch(`${h.api.url}/api/v1/tasks/${id}/cancel`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
    expect([401, 403]).toContain((await cancel('worker-token-cancel-test')).status);
    expect((await cancel(h.apiToken)).status).toBe(200);
    await h.pollUntil(() => h.simulated.getAbortedRequests() === 1, 5000, 20, 'worker aborting provider request');
    expect((await h.getTaskStatus(id)).body.outcome.error).toBe('CANCELLED');
    expect((await h.reportResult('cancel-worker', id, { ok: true, output: 'late' }, original.lease.token, 'worker-token-cancel-test')).status).toBe(409);
    release();
    await h.restartApi();
    expect((await h.getTaskStatus(id)).body.outcome.error).toBe('CANCELLED');
    expect((await cancel(h.apiToken)).status).toBe(200);
    expect(h.simulated.getRecordedRequests()).toHaveLength(1);
    h.evidence.push({ event: 'cancelled_provider_aborted', requestId: id, durableOutcome: 'CANCELLED', requests: 1 });
  });

  it('serializes concurrent completion and cancellation and never overwrites the winner', async () => {
    h = await ClusterHarness.create();
    await h.startWorker({ computerId: 'race-worker', token: 'worker-token-race-test' });
    await h.killWorker('race-worker');
    const id = 'cancel-complete-race';
    await h.dispatchTask('race-worker', { requestId: id, executionId: 'exec-race' });
    const lease = await h.claim('race-worker', id, 'worker-token-race-test');
    const [cancelled, completed] = await Promise.all([
      fetch(`${h.api.url}/api/v1/tasks/${id}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${h.apiToken}` } }),
      h.reportResult('race-worker', id, { ok: true, output: 'winner' }, lease.body.token, 'worker-token-race-test'),
    ]);
    expect(cancelled.status).toBe(200);
    expect([200, 409]).toContain(completed.status);
    const outcome = (await h.getTaskStatus(id)).body.outcome;
    expect(outcome.ok ? outcome.output : outcome.error).toBe(outcome.ok ? 'winner' : 'CANCELLED');
    await h.restartApi();
    expect((await h.getTaskStatus(id)).body.outcome).toEqual(outcome);
  });
});
