import { describe, it, expect, afterEach } from 'vitest';
import { ClusterHarness } from './harness/clusterHarness.js';

describe.skipIf(process.env.WAZIR_DISTRIBUTED !== '1')('B6 — Worker Graceful Disconnect, Reconnect & Authentication Integrity', () => {
  let harness: ClusterHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it('handles graceful disconnect, reconnects cleanly without duplicate identity, and resumes work', async () => {
    const tokenA = 'worker-token-reconnect-test';
    harness = await ClusterHarness.create();
    await harness.startApi();

    // 1. Initial worker start
    const worker1 = await harness.startWorker({ computerId: 'comp-recon', token: tokenA });
    expect(worker1.pid).toBeGreaterThan(0);

    // 2. Dispatch task 1
    const req1 = `req-recon-1-${Date.now()}`;
    const exec1 = `exec-recon-1-${Date.now()}`;
    await harness.dispatchTask('comp-recon', { requestId: req1, executionId: exec1 });

    // Wait for task 1 completion
    await harness.pollUntil(
      async () => {
        const s = await harness.getTaskStatus(req1);
        return s.status === 200 && s.body.outcome?.ok === true;
      },
      5000,
      100,
      'task 1 completion',
    );

    // 3. Verify registry has single computer entry
    let computers = await harness.getComputers();
    let compEntries = computers.filter((c: any) => c.id === 'comp-recon');
    expect(compEntries).toHaveLength(1);
    expect(compEntries[0].status).toBe('online');

    // 4. Graceful disconnect (SIGTERM)
    const exitCode = await harness.killWorker('comp-recon', 'SIGTERM');
    expect(exitCode).toBe(0);

    // 5. Reconnect worker with same computer identity and token
    const worker2 = await harness.startWorker({ computerId: 'comp-recon', token: tokenA });
    expect(worker2.pid).toBeGreaterThan(0);
    expect(worker2.pid).not.toBe(worker1.pid);

    // 6. Identity is not duplicated
    computers = await harness.getComputers();
    compEntries = computers.filter((c: any) => c.id === 'comp-recon');
    expect(compEntries).toHaveLength(1);
    expect(compEntries[0].status).toBe('online');

    // 7. Completed task 1 is not replayed
    const task1Final = await harness.getTaskStatus(req1);
    const leaseEvents = task1Final.body.events?.filter((e: any) => e.type === 'lease_acquired');
    expect(leaseEvents).toHaveLength(1); // exactly 1 attempt, no replay

    // 8. Resumes receiving eligible work: dispatch task 2
    const req2 = `req-recon-2-${Date.now()}`;
    const exec2 = `exec-recon-2-${Date.now()}`;
    await harness.dispatchTask('comp-recon', { requestId: req2, executionId: exec2 });

    await harness.pollUntil(
      async () => {
        const s = await harness.getTaskStatus(req2);
        return s.status === 200 && s.body.outcome?.ok === true;
      },
      5000,
      100,
      'task 2 completion after reconnect',
    );

    const task2Status = await harness.getTaskStatus(req2);
    expect(task2Status.body.outcome.ok).toBe(true);
  });

  it('rejects unauthorized registration replacements and enforces token semantics', async () => {
    const tokenA = 'worker-token-auth-valid';
    harness = await ClusterHarness.create();
    const api = await harness.startApi();

    // Register initial computer with tokenA
    const survivingWorker = await harness.startWorker({ computerId: 'comp-auth', token: tokenA });

    // Attempt to hijack registration with wrong token (unauthorized replacement)
    const hijackRes = await fetch(`${api.url}/computers/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid-hacker-token',
      },
      body: JSON.stringify({
        id: 'comp-auth',
        name: 'Hijacker',
        type: 'workstation',
      }),
    });

    expect(hijackRes.status).toBe(403);
    const body = await hijackRes.json() as { error?: string };
    expect(body.error).toContain('already registered');

    // Attempt to access task stream with invalid bearer token
    const streamRes = await fetch(`${api.url}/computers/comp-auth/tasks/stream`, {
      headers: {
        Accept: 'text/event-stream',
        Authorization: 'Bearer wrong-bearer-token',
      },
    });
    expect([401, 403]).toContain(streamRes.status);
    await harness.restartApi();
    const requestId = `surviving-reconnect-${Date.now()}`;
    expect((await harness.dispatchTask('comp-auth', { requestId, executionId: `exec-${requestId}` })).status).toBe(202);
    await harness.pollUntil(async () => (await harness.getTaskStatus(requestId)).body.outcome?.ok === true, 8000, 50, 'surviving worker SSE reconnect after controller restart');
    expect(() => process.kill(survivingWorker.pid, 0)).not.toThrow();
    harness.evidence.push({ event: 'surviving_worker_reconnected', requestId, workerPid: survivingWorker.pid, controllerPid: harness.api.pid, finalOutcome: (await harness.getTaskStatus(requestId)).body.outcome });
    harness.evidence.push({ event: 'credential_rejection', computerId: 'comp-auth', unauthorizedReplacementStatus: hijackRes.status, invalidStreamTokenStatus: streamRes.status });
  });

  it('ensures sensitive tokens are redacted from all diagnostic logs', async () => {
    const tokenSecret = 'super-secret-worker-token-xyz';
    harness = await ClusterHarness.create();
    await harness.startApi();
    const worker = await harness.startWorker({ computerId: 'comp-redact', token: tokenSecret });

    const allWorkerLogs = worker.logs.join('\n');
    const allApiLogs = harness.api.logs.join('\n');

    expect(allWorkerLogs).not.toContain(tokenSecret);
    expect(allApiLogs).not.toContain(tokenSecret);
    expect(allWorkerLogs).not.toContain(harness.registrationToken);
    expect(allApiLogs).not.toContain(harness.registrationToken);
  });
});
