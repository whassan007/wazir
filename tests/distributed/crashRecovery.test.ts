import { describe, it, expect, afterEach } from 'vitest';
import { ClusterHarness } from './harness/clusterHarness.js';

describe.skipIf(process.env.WAZIR_DISTRIBUTED !== '1')('B3 — Multi-Process Worker Crash & Recovery (SIGKILL)', () => {
  let harness: ClusterHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it('detects SIGKILL crash mid-execution, fences stale lease, prevents late result, and recovers upon worker restart', async () => {
    const tokenA = 'worker-token-comp-a';
    const tokenB = 'worker-token-comp-b';

    // 1. Initialize cluster with disposable durable store & simulated inference
    harness = await ClusterHarness.create();

    // Configure simulated inference with 5000ms delay so execution remains in-flight
    harness.simulated.setDelay(5000);

    // 2. Start API child process
    const api = await harness.startApi();
    expect(api.pid).toBeGreaterThan(0);
    expect(api.port).toBeGreaterThan(0);

    // 3. Start real Worker A and Worker B child processes
    const workerA = await harness.startWorker({
      computerId: 'comp-a',
      name: 'Worker Alpha',
      token: tokenA,
    });
    const workerB = await harness.startWorker({
      computerId: 'comp-b',
      name: 'Worker Beta',
      token: tokenB,
    });

    expect(workerA.pid).toBeGreaterThan(0);
    expect(workerB.pid).toBeGreaterThan(0);
    expect(workerA.pid).not.toBe(workerB.pid);

    // 4. Confirm both registrations in API control plane
    const computers = await harness.getComputers();
    const registeredA = computers.find((c: any) => c.id === 'comp-a');
    const registeredB = computers.find((c: any) => c.id === 'comp-b');
    expect(registeredA).toBeDefined();
    expect(registeredA?.status).toBe('online');
    expect(registeredB).toBeDefined();
    expect(registeredB?.status).toBe('online');

    // 5. Dispatch task to Worker A
    const requestId = `req-crash-${Date.now()}`;
    const executionId = `exec-crash-${Date.now()}`;
    const dispatchRes = await harness.dispatchTask('comp-a', { requestId, executionId });
    expect(dispatchRes.status).toBe(202);
    expect(dispatchRes.body.accepted).toBe(true);

    // 6. Confirm Worker A claimed the task and execution started
    await harness.pollUntil(
      async () => {
        const status = await harness.getTaskStatus(requestId);
        if (status.status !== 200 || !status.body.events) return false;
        return status.body.events.some((e: any) => e.type === 'lease_acquired');
      },
      5000,
      100,
      'Worker A claiming task',
    );

    const initialStatus = await harness.getTaskStatus(requestId);
    const leaseAcquiredEvent = initialStatus.body.events.find((e: any) => e.type === 'lease_acquired');
    expect(leaseAcquiredEvent).toBeDefined();
    expect(leaseAcquiredEvent.data?.attempt).toBe(1);

    // Get the lease token from authoritative durable store
    let durableRecord: any;
    if (harness.store) {
      durableRecord = await harness.store.get(`dispatch/${requestId}`);
    } else {
      // In-memory or file store fallback
      throw new Error('Durable store is required for crash evidence');
    }

    await harness.pollUntil(() => harness.simulated.getRecordedRequests().length > 0, 5000, 20, 'worker A entering provider execution');
    expect(durableRecord?.lease?.token).toBeTruthy();
    const tClaimed = Date.now();
    const deadWorkerPid = workerA.pid;

    // 7. Terminate Worker A with SIGKILL while execution is actively in flight
    const exitCode = await harness.killWorker('comp-a', 'SIGKILL');
    const tKilled = Date.now();

    expect(() => process.kill(deadWorkerPid, 0)).toThrow();
    // Wait for the persisted lease deadline rather than a fixed delay.
    await harness.waitForExpiry(requestId);
    const tExpired = Date.now();

    // 9. Inspect authoritative durable state
    if (harness.store) {
      const recordAfterCrash = await harness.store.get<any>(`dispatch/${requestId}`);
      expect(recordAfterCrash).toBeDefined();
      expect(recordAfterCrash?.request.requestId).toBe(requestId);
      expect(recordAfterCrash?.outcome).toBeUndefined(); // Did not silently disappear or falsely complete
      expect(recordAfterCrash?.lease?.expiresAt).toBeLessThanOrEqual(tExpired); // Lease is expired
    }

    // 10. Attempt stale result submission with Worker A's expired lease token (zombie attempt)
    if (durableRecord?.lease?.token) {
      const staleRes = await harness.reportResult(
        'comp-a',
        requestId,
        { ok: true, output: 'late zombie completion' },
        durableRecord.lease.token,
        tokenA,
      );
      // Authoritative fence: expired lease MUST be rejected
      expect(staleRes.status).toBe(409);
      expect(staleRes.body.error).toBe('LEASE_LOST');
    }

    // 11. Cross-computer reassignment probe:
    // Can Worker B (surviving worker) claim Worker A's expired task?
    const bClaim = await harness.claim('comp-b', requestId, tokenB);
    // TaskDispatcher verifies current.computerId === computerId.
    // Because Wazir binds dispatch to target computer, B is rejected with 403 or 409
    expect([403, 409]).toContain(bClaim.status);

    // Characterize the production gap at its actual 60s offline threshold.
    await harness.pollUntil(async () => {
      const computer = (await harness.getComputers()).find(c => c.id === 'comp-a');
      return Date.now() - new Date(computer.lastHeartbeat).getTime() >= 60_000;
    }, 40_000, 50, 'production offline heartbeat threshold');
    const missingWorker = (await harness.getComputers()).find(c => c.id === 'comp-a');
    const abandoned = await harness.store!.get<any>(`dispatch/${requestId}`);
    expect(abandoned.outcome).toBeUndefined();
    harness.evidence.push({ event: 'missing_worker_gap', requestId, computerStatus: missingWorker.status,
      lastHeartbeat: missingWorker.lastHeartbeat, observedAt: Date.now(), attempt: abandoned.attempt,
      expiresAt: abandoned.lease.expiresAt, terminalOutcomePresent: false,
      limitation: 'No API RecoveryManager sweep or cross-computer reassignment; abandoned dispatch remains durable and pending.' });

    // 12. Recovery: Start a fresh Worker A on 'comp-a'.
    // Remove inference delay so recovery completes quickly
    harness.simulated.setDelay(0);

    const restartedWorkerA = await harness.startWorker({
      computerId: 'comp-a',
      name: 'Worker Alpha Resurrected',
      token: tokenA,
    });
    expect(restartedWorkerA.pid).toBeGreaterThan(0);
    expect(restartedWorkerA.pid).not.toBe(deadWorkerPid);

    // Redelivery: The API redelivers the expired, uncompleted task to comp-a upon reconnect
    // Wait for the restarted Worker A to claim attempt 2 and complete the task
    await harness.pollUntil(
      async () => {
        const status = await harness.getTaskStatus(requestId);
        return status.status === 200 && status.body.outcome !== undefined;
      },
      8000,
      100,
      'Recovery and completion by restarted Worker A',
    );

    const finalStatus = await harness.getTaskStatus(requestId);
    const tRecovered = Date.now();

    expect(finalStatus.body.outcome.ok).toBe(true);
    expect(finalStatus.body.outcome.output).toContain('simulated model completion');

    const leaseEvents = finalStatus.body.events.filter((e: any) => e.type === 'lease_acquired');
    expect(leaseEvents.length).toBeGreaterThanOrEqual(2);
    expect(leaseEvents[leaseEvents.length - 1].data?.attempt).toBe(2);

    const replaced = await harness.store!.get<any>(`dispatch/${requestId}`);
    expect(replaced.lease.token).not.toBe(durableRecord.lease.token);
    const late = await harness.reportResult('comp-a', requestId, { ok: true, output: 'stale after replacement' }, durableRecord.lease.token, tokenA);
    expect(late).toMatchObject({ status: 409, body: { error: 'LEASE_LOST' } });
    expect((await harness.getTaskStatus(requestId)).body.outcome).toEqual(finalStatus.body.outcome);
    harness.evidence.push({ event: 'fencing', requestId, originalAttempt: durableRecord.attempt, replacementAttempt: replaced.attempt, holder: replaced.computerId, originalExpiresAt: durableRecord.lease.expiresAt, replacementExpiresAt: replaced.lease.expiresAt, staleResponse: late, finalOutcome: finalStatus.body.outcome });
    // Structured diagnostic evidence
    console.log(`[EVIDENCE] B3 SIGKILL Recovery:
      Dead Worker PID: ${deadWorkerPid}
      Restarted Worker PID: ${restartedWorkerA.pid}
      tClaimed: ${tClaimed}
      tKilled: ${tKilled} (delta: ${tKilled - tClaimed}ms)
      tExpired: ${tExpired} (delta: ${tExpired - tKilled}ms)
      tRecovered: ${tRecovered} (delta: ${tRecovered - tExpired}ms)
      Final Outcome: ${JSON.stringify(finalStatus.body.outcome)}
    `);
  });
});
