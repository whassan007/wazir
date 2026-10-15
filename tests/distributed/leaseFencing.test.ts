import { describe, it, expect, afterEach } from 'vitest';
import { ClusterHarness } from './harness/clusterHarness.js';

describe.skipIf(process.env.WAZIR_DISTRIBUTED !== '1')('B4 — Lease-Fencing Integrity & Concurrency Races', () => {
  let harness: ClusterHarness;
  let release: () => void = () => {};

  afterEach(async () => {
    release();
    if (harness) {
      await harness.cleanup();
    }
  });

  it('rejects stale result submissions when a worker loses its lease', async () => {
    const tokenA = 'worker-token-stale-test';
    harness = await ClusterHarness.create();

    // Start API and Worker A
    const api = await harness.startApi();
    const workerA = await harness.startWorker({ computerId: 'comp-stale', token: tokenA });

    // Configure inference delay so task stays in progress
    harness.simulated.setDelay(5000);

    const requestId = `req-stale-${Date.now()}`;
    const executionId = `exec-stale-${Date.now()}`;
    await harness.dispatchTask('comp-stale', { requestId, executionId });

    // Wait until Worker A claims the task
    await harness.pollUntil(
      async () => {
        const s = await harness.getTaskStatus(requestId);
        return s.status === 200 && s.body.events?.some((e: any) => e.type === 'lease_acquired');
      },
      5000,
      100,
      'claim task',
    );

    // Stop Worker A so it stops renewing the lease
    await harness.killWorker('comp-stale', 'SIGKILL');

    // Fetch the durable lease token
    let leaseToken = '';
    let originalExpiresAt = 0;
    if (harness.store) {
      const rec = await harness.store.get<any>(`dispatch/${requestId}`);
      leaseToken = rec?.lease?.token;
      originalExpiresAt = rec?.lease?.expiresAt;
    }
    expect(leaseToken).toBeTruthy();

    // Wait for the actual persisted lease to expire
    await harness.waitForExpiry(requestId);

    // Submit result using the expired lease token
    const staleResult = await harness.reportResult(
      'comp-stale',
      requestId,
      { ok: true, output: 'zombie late result' },
      leaseToken,
      tokenA,
    );

    // Stale submission MUST be rejected
    expect(staleResult.status).toBe(409);
    expect(staleResult.body.error).toBe('LEASE_LOST');

    const replacement = await harness.claim('comp-stale', requestId, tokenA);
    expect(replacement.status).toBe(200);
    expect(replacement.body.attempt).toBe(2);
    expect(replacement.body.token).not.toBe(leaseToken);
    const staleAfterReplacement = await harness.reportResult('comp-stale', requestId,
      { ok: true, output: 'stale against live replacement' }, leaseToken, tokenA);
    expect(staleAfterReplacement).toMatchObject({ status: 409, body: { error: 'LEASE_LOST' } });
    // Inspect authoritative durable state: outcome must remain undefined
    if (harness.store) {
      const rec = await harness.store.get<any>(`dispatch/${requestId}`);
      expect(rec?.outcome).toBeUndefined();
    }
    const valid = await harness.reportResult('comp-stale', requestId, { ok: true, output: 'replacement outcome' }, replacement.body.token, tokenA);
    expect(valid.status).toBe(200);
    const final = (await harness.getTaskStatus(requestId)).body.outcome;
    expect(final.output).toBe('replacement outcome');
    harness.evidence.push({ event: 'LS22_independent_stale_result', requestId, originalAttempt: 1,
      originalExpiresAt, replacementAttempt: replacement.body.attempt, holder: 'comp-stale', replacementExpiresAt: replacement.body.expiresAt,
      staleSubmissionResponse: staleAfterReplacement, finalOutcome: final });
  }, 90_000);

  it('serializes competing claims and ensures only a valid lease holder can commit outcome', async () => {
    const tokenA = 'worker-token-competing';
    harness = await ClusterHarness.create();
    await harness.startApi();

    // Start worker to establish computer registration, then stop it so it does not auto-claim via SSE
    await harness.startWorker({ computerId: 'comp-competing', token: tokenA });
    await harness.killWorker('comp-competing', 'SIGKILL');

    const requestId = `req-competing-${Date.now()}`;
    const executionId = `exec-competing-${Date.now()}`;

    // Dispatch task to queued state (unclaimed)
    const dRes = await harness.dispatchTask('comp-competing', { requestId, executionId });
    expect(dRes.status).toBe(202);

    // Two competing claims contend for the same eligible task simultaneously
    const [claim1, claim2] = await Promise.all([
      harness.claim('comp-competing', requestId, tokenA),
      harness.claim('comp-competing', requestId, tokenA),
    ]);

    const successes = [claim1, claim2].filter((c) => c.status === 200);
    const busies = [claim1, claim2].filter((c) => c.status === 409 && c.body.error === 'RESOURCE_BUSY');

    expect(successes).toHaveLength(1);
    expect(busies).toHaveLength(1);

    const winningClaim = successes[0].body;
    expect(winningClaim.token).toBeDefined();
    expect(winningClaim.attempt).toBe(1);

    // Invalid lease holder cannot commit
    const fakeCommit = await harness.reportResult(
      'comp-competing',
      requestId,
      { ok: true, output: 'bogus result' },
      'invalid-lease-token-12345',
      tokenA,
    );
    expect(fakeCommit.status).toBe(409);
    expect(fakeCommit.body.error).toBe('LEASE_LOST');

    // Valid lease holder commits
    const validCommit = await harness.reportResult(
      'comp-competing',
      requestId,
      { ok: true, output: 'authentic outcome' },
      winningClaim.token,
      tokenA,
    );
    expect(validCommit.status).toBe(200);

    const status = await harness.getTaskStatus(requestId);
    expect(status.body.outcome?.output).toBe('authentic outcome');
  }, 90_000);

  it('prevents stale lease renewals from resurrecting expired or completed leases', async () => {
    const tokenA = 'worker-token-renewal';
    harness = await ClusterHarness.create();
    await harness.startApi();
    await harness.startWorker({ computerId: 'comp-renew', token: tokenA });
    await harness.killWorker('comp-renew', 'SIGKILL');

    const requestId = `req-renew-${Date.now()}`;
    const executionId = `exec-renew-${Date.now()}`;
    await harness.dispatchTask('comp-renew', { requestId, executionId });

    // Claim the task
    const claimRes = await harness.claim('comp-renew', requestId, tokenA);
    expect(claimRes.status).toBe(200);
    const leaseToken = claimRes.body.token;

    // Case 1: Let lease expire, then attempt renewal
    await harness.waitForExpiry(requestId);

    const expiredRenew = await harness.renew('comp-renew', requestId, leaseToken, tokenA);
    expect(expiredRenew.status).toBe(409);
    expect(expiredRenew.body.error).toBe('LEASE_LOST');

    // Case 2: Claim attempt 2, resolve it, then attempt renewal
    const claim2 = await harness.claim('comp-renew', requestId, tokenA);
    expect(claim2.status).toBe(200);
    const leaseToken2 = claim2.body.token;

    const commitRes = await harness.reportResult(
      'comp-renew',
      requestId,
      { ok: true, output: 'completed outcome' },
      leaseToken2,
      tokenA,
    );
    expect(commitRes.status).toBe(200);

    const terminalRenew = await harness.renew('comp-renew', requestId, leaseToken2, tokenA);
    expect(terminalRenew.status).toBe(409);
    expect(terminalRenew.body.error).toBe('EXECUTION_TERMINAL');
  }, 90_000);

  it('controller restart preserves durable task state and workers re-register cleanly', async () => {
    const tokenA = 'worker-token-ctrl-restart';
    harness = await ClusterHarness.create();

    const api1 = await harness.startApi();
    const pid1 = api1.pid;

    await harness.startWorker({ computerId: 'comp-ctrl', token: tokenA });

    const gate = new Promise<void>(resolve => { release = resolve; });
    harness.simulated.setChatHandler(async () => { await gate; return 'simulated model completion'; });
    const requestId = `req-ctrl-${Date.now()}`;
    const executionId = `exec-ctrl-${Date.now()}`;
    const dRes = await harness.dispatchTask('comp-ctrl', { requestId, executionId });
    expect(dRes.status).toBe(202);

    // Verify task is persisted in durable store
    if (harness.store) {
      const persisted = await harness.store.get<any>(`dispatch/${requestId}`);
      expect(persisted).toBeDefined();
      expect(persisted?.computerId).toBe('comp-ctrl');
    }

    await harness.pollUntil(() => harness.simulated.getRecordedRequests().length === 1, 5000, 20, 'execution before controller crash');
    expect((await harness.getTaskStatus(requestId)).body.outcome).toBeUndefined();
    await harness.killWorker('comp-ctrl');
    // Kill API process
    await harness.stopApi('SIGKILL');

    // Restart API process with the same durable store and configuration
    const api2 = await harness.startApi();
    expect(api2.pid).not.toBe(pid1);

    // Inspect task status from restarted API
    const status = await harness.getTaskStatus(requestId);
    expect(status.status).toBe(200);
    expect(status.body.events).toBeDefined();

    // Reconnected/restarted worker re-registers
    release();
    const restartedWorker = await harness.startWorker({ computerId: 'comp-ctrl', token: tokenA });
    expect(restartedWorker.pid).toBeGreaterThan(0);

    // Wait for the reconnected worker to receive redelivery and finish the task
    await harness.pollUntil(
      async () => {
        const s = await harness.getTaskStatus(requestId);
        return s.status === 200 && s.body.outcome?.ok === true;
      },
      40_000,
      100,
      'Task completion after controller restart',
    );

    const finalStatus = await harness.getTaskStatus(requestId);
    expect(finalStatus.body.outcome.ok).toBe(true);
  }, 90_000);

  it('rejects duplicate task delivery through the dispatch interface', async () => {
    const tokenA = 'worker-token-dup';
    harness = await ClusterHarness.create();
    await harness.startApi();
    await harness.startWorker({ computerId: 'comp-dup', token: tokenA });

    const requestId = `req-dup-${Date.now()}`;
    const executionId = `exec-dup-${Date.now()}`;

    // First dispatch
    const first = await harness.dispatchTask('comp-dup', { requestId, executionId });
    expect(first.status).toBe(202);
    expect(first.body.accepted).toBe(true);

    // Duplicate dispatch with exact same requestId
    const second = await harness.dispatchTask('comp-dup', { requestId, executionId });
    expect(second.status).toBe(429);
    expect(second.body.error).toBe('REQUEST_ALREADY_DISPATCHED');
    expect(second.body.requestId).toBe(requestId);

    // Wait for original task to complete
    await harness.pollUntil(
      async () => {
        const s = await harness.getTaskStatus(requestId);
        return s.status === 200 && s.body.outcome !== undefined;
      },
      5000,
      100,
      'Original task completion',
    );

    const finalStatus = await harness.getTaskStatus(requestId);
    expect(finalStatus.body.outcome.ok).toBe(true);
  }, 90_000);
});
