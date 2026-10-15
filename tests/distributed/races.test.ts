import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ClusterHarness } from './harness/clusterHarness.js';

// Races use request barriers and persisted lease deadlines; polling waits for evidence.
describe.skipIf(process.env.WAZIR_DISTRIBUTED !== '1')('bounded protocol races through production HTTP server', () => {
  let h: ClusterHarness;
  let release: () => void = () => {};
  afterEach(async () => { release(); await h?.cleanup(); });

  it('repeats competing claims and renewal/completion races with one authoritative outcome', async () => {
    h = await ClusterHarness.create();
    const computerId = 'race-worker', token = 'race-worker-authenticated-token';
    await h.startWorker({ computerId, token });
    await h.killWorker(computerId);
    for (let round = 0; round < 3; round++) {
      const requestId = `race-${Date.now()}-${round}`;
      expect((await h.dispatchTask(computerId, { requestId, executionId: `exec-${requestId}` })).status).toBe(202);
      const contenders = await Promise.all(Array.from({ length: 8 }, () => h.claim(computerId, requestId, token)));
      expect(contenders.filter(c => c.status === 200)).toHaveLength(1);
      expect(contenders.filter(c => c.status === 409)).toHaveLength(7);
      const lease = contenders.find(c => c.status === 200)!.body;
      const outcome = { ok: true, output: `winner-${round}` };
      const [renew, first, second] = await Promise.all([
        h.renew(computerId, requestId, lease.token, token),
        h.reportResult(computerId, requestId, outcome, lease.token, token),
        h.reportResult(computerId, requestId, { ok: false, output: 'competitor' }, lease.token, token),
      ]);
      expect([200, 409]).toContain(renew.status);
      expect([first, second].filter(r => r.body.duplicate === true)).toHaveLength(1);
      const final = (await h.getTaskStatus(requestId)).body.outcome;
      expect(['winner-' + round, 'competitor']).toContain(final.output);
      expect((await h.claim(computerId, requestId, token)).status).toBe(409);
      expect((await h.reportResult(computerId, requestId, outcome, lease.token, 'invalid-token')).status).toBe(401);
      h.evidence.push({ event: 'race_round', round, requestId, winningClaims: 1, duplicateCommitments: 0, final });
    }
  });

  it('repeats expired-renewal versus replacement-claim races after persisted deadline barriers', async () => {
    h = await ClusterHarness.create();
    const computerId = 'expiry-race-worker', token = 'expiry-race-authenticated-token';
    await h.startWorker({ computerId, token });
    await h.killWorker(computerId);
    const attempts: Array<{ requestId: string; original: any }> = [];
    // Acquire all three leases before waiting: one bounded real lease interval.
    for (let round = 0; round < 3; round++) {
      const requestId = `expiry-race-${Date.now()}-${round}`;
      expect((await h.dispatchTask(computerId, { requestId, executionId: `exec-${requestId}` })).status).toBe(202);
      const original = await h.claim(computerId, requestId, token);
      expect(original.status).toBe(200);
      attempts.push({ requestId, original: original.body });
    }
    await Promise.all(attempts.map(a => h.waitForExpiry(a.requestId)));
    for (const { requestId, original } of attempts) {
      const [renew, ...claims] = await Promise.all([
        h.renew(computerId, requestId, original.token, token),
        ...Array.from({ length: 8 }, () => h.claim(computerId, requestId, token)),
      ]);
      expect(renew).toMatchObject({ status: 409, body: { error: 'LEASE_LOST' } });
      const winners = claims.filter(c => c.status === 200);
      expect(winners).toHaveLength(1);
      expect(claims.filter(c => c.status === 409)).toHaveLength(7);
      expect(winners[0].body.attempt).toBe(2);
      expect(winners[0].body.token).not.toBe(original.token);
      const committed = await h.reportResult(computerId, requestId, { ok: true, output: 'replacement survived expiry race' }, winners[0].body.token, token);
      expect(committed.status).toBe(200);
      h.evidence.push({ event: 'expiry_race', requestId, originalAttempt: original.attempt,
        originalExpiresAt: original.expiresAt, replacementAttempt: winners[0].body.attempt,
        replacementExpiresAt: winners[0].body.expiresAt, staleRenewalResponse: renew, winningClaims: 1 });
    }
  });

  it('renews a long-running real execution before allowing the provider response', async () => {
    h = await ClusterHarness.create();
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.simulated.setChatHandler(async () => { await gate; return 'long task completed'; });
    const computerId = 'long-worker', token = 'long-worker-authenticated-token';
    await h.startWorker({ computerId, token });
    const requestId = `long-${Date.now()}`;
    await h.dispatchTask(computerId, { requestId, executionId: `exec-${requestId}` });
    await h.pollUntil(() => h.simulated.getRecordedRequests().length === 1, 5000, 30, 'provider request');
    const original = await h.store!.get<any>(`dispatch/${requestId}`);
    const heartbeatBefore = (await h.getComputers()).find(c => c.id === computerId).lastHeartbeat;
    await h.pollUntil(async () => {
      const record = await h.store!.get<any>(`dispatch/${requestId}`);
      return record.events.some((e: any) => e.type === 'lease_renewed');
    }, 15_000, 50, 'real worker renewal');
    const renewed = await h.store!.get<any>(`dispatch/${requestId}`);
    expect(renewed.lease.expiresAt).toBeGreaterThan(original.lease.expiresAt);
    expect(renewed.attempt).toBe(1);
    await h.pollUntil(async () => (await h.getComputers()).find(c => c.id === computerId).lastHeartbeat !== heartbeatBefore, 15_000, 50, 'worker heartbeat received');
    h.evidence.push({ event: 'heartbeat_and_renewal', computerId, requestId, heartbeatBefore, heartbeatAfter: (await h.getComputers()).find(c => c.id === computerId).lastHeartbeat, originalExpiresAt: original.lease.expiresAt, renewedExpiresAt: renewed.lease.expiresAt });
    await h.pollUntil(() => Date.now() >= original.lease.expiresAt, 35_000, 50, 'execution beyond original lease deadline');
    const stillRunning = await h.store!.get<any>(`dispatch/${requestId}`);
    expect(stillRunning.outcome).toBeUndefined();
    expect(stillRunning.attempt).toBe(1);
    expect(stillRunning.lease.expiresAt).toBeGreaterThan(Date.now());
    h.evidence.push({ event: 'long_task_beyond_original_deadline', requestId, originalExpiresAt: original.lease.expiresAt, currentExpiresAt: stillRunning.lease.expiresAt, observedAt: Date.now(), attempt: stillRunning.attempt });
    release();
    await h.pollUntil(async () => Boolean((await h.getTaskStatus(requestId)).body.outcome), 5000, 50, 'long result');
    expect(h.simulated.getRecordedRequests()).toHaveLength(1);
  });

  it('replays an in-flight result after controller dies between commit and acknowledgment', async () => {
    h = await ClusterHarness.create();
    const computerId = 'submit-worker', token = 'submit-worker-authenticated-token';
    await h.startWorker({ computerId, token });
    await h.killWorker(computerId);
    const requestId = `submit-${Date.now()}`;
    await h.dispatchTask(computerId, { requestId, executionId: `exec-${requestId}` });
    const claim = await h.claim(computerId, requestId, token);
    const outcome = { ok: true, output: 'durable before restart' };
    const route = `/computers/${computerId}/executions/${requestId}/result`;
    let committed!: () => void;
    const committedSignal = new Promise<void>(resolve => { committed = resolve; });
    const responseGate = new Promise<void>(resolve => { release = resolve; });
    // Transport fault only: the real authenticated API performs the actual commit.
    const proxy = http.createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const upstream = await fetch(h.api.url + route, { method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: Buffer.concat(chunks).toString() });
        expect(upstream.status).toBe(200);
        await upstream.text();
        committed();
        await responseGate;
        res.destroy(); // acknowledgment lost; caller must inspect or replay
      } catch { res.destroy(); }
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const port = (proxy.address() as AddressInfo).port;
    const pending = fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...outcome, leaseToken: claim.body.token }),
      signal: AbortSignal.timeout(15_000),
    }).then(() => 'acknowledged', () => 'acknowledgment lost');
    try {
      await committedSignal;
      const oldPid = h.api.pid;
      await h.restartApi();
      expect(() => process.kill(oldPid, 0)).toThrow();
      release();
      expect(await pending).toBe('acknowledgment lost');
      expect((await h.getTaskStatus(requestId)).body.outcome.output).toBe(outcome.output);
      const replay = await h.reportResult(computerId, requestId, { ok: false, output: 'overwrite' }, claim.body.token, token);
      expect(replay).toMatchObject({ status: 200, body: { duplicate: true } });
      expect((await h.getTaskStatus(requestId)).body.outcome.output).toBe(outcome.output);
      h.evidence.push({ event: 'result_ack_lost', requestId, oldPid, restartedPid: h.api.pid, replay, authoritativeOutcome: outcome });
    } finally {
      release(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });
});
