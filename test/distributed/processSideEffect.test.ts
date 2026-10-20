import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ClusterHarness } from './harness/clusterHarness.js';

// A provider-side mutation is observable independently of controller/worker acknowledgments.
// This is a synthetic external service, not a mocked Worker or TaskDispatcher.
describe.skipIf(process.env.WAZIR_DISTRIBUTED !== '1')('mutation before acknowledgment across SIGKILL', () => {
  let h: ClusterHarness;
  let release: () => void = () => {};
  afterEach(async () => { release(); await h?.cleanup(); });

  it('does not retry an opaque provider request after a mutation followed by HTTP 500', async () => {
    h = await ClusterHarness.create();
    let effects = 0;
    h.simulated.setChatHandler(() => { effects++; throw new Error('response lost after mutation'); });
    await h.startWorker({ computerId: 'http-effect', token: 'http-effect-token' });
    await h.dispatchTask('http-effect', { requestId: 'http-effect', executionId: 'http-effect-exec', replayPolicy: 'never' });
    await h.pollUntil(async () => Boolean((await h.getTaskStatus('http-effect')).body.outcome), 8000, 50, 'failed opaque result');
    expect((await h.getTaskStatus('http-effect')).body.outcome.ok).toBe(false);
    expect(effects).toBe(1);
  });

  it.each([true, false])('blocks opaque replay after mutation with external idempotency=%s', async idempotent => {
    h = await ClusterHarness.create();
    const token = 'synthetic-effect-worker-token';
    const operationId = `op-${Date.now()}`;
    const ledger = path.join(h.tempDir, 'external-effects.jsonl');
    let executions = 0;
    let effects = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.simulated.setChatHandler(async () => {
      executions++;
      if (!idempotent || effects === 0) {
        effects++;
        await fs.appendFile(ledger, JSON.stringify({ operationId, effects }) + '\n');
      }
      // Mutation has committed; withhold response so no acknowledgment can reach Wazir.
      if (executions === 1) await gate;
      return 'mutation acknowledged';
    });
    const worker = await h.startWorker({ computerId: 'effect-worker', token });
    const requestId = `effect-${operationId}`;
    const request = { requestId, executionId: `exec-${requestId}`, replayPolicy: 'never' as const, messages: [{ role: 'user', content: operationId }] };
    expect((await h.dispatchTask('effect-worker', request)).status).toBe(202);
    await h.pollUntil(() => effects === 1, 5000, 20, 'external mutation committed');
    const original = await h.store!.get<any>(`dispatch/${requestId}`);
    expect(original.lease).toBeDefined();
    expect(original.outcome).toBeUndefined();
    await h.killWorker('effect-worker');
    expect(() => process.kill(worker.pid, 0)).toThrow();
    expect((await h.dispatchTask('effect-worker', request)).status).toBe(429);
    await h.waitForExpiry(requestId);
    await h.restartApi();
    const afterRestart = await h.store!.get<any>(`dispatch/${requestId}`);
    // Recovery may run before or after this read; the durable attempt must never replay.
    expect(afterRestart.attempt).toBe(1);
    release();
    await h.startWorker({ computerId: 'effect-worker', token, registrationToken: 'invalid-bootstrap-credential' });
    await h.pollUntil(async () => Boolean((await h.getTaskStatus(requestId)).body.outcome), 8000, 50, 'replacement result');
    const final = await h.store!.get<any>(`dispatch/${requestId}`);
    expect(final.attempt).toBe(1);
    expect(final.outcome).toMatchObject({ ok: false, error: 'UNKNOWN_OUTCOME' });
    expect(executions).toBe(1);
    expect(effects).toBe(1);
    expect((await fs.readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(effects);
    const stale = await h.reportResult('effect-worker', requestId, { ok: true, output: 'old acknowledgment' }, original.lease.token, token);
    expect(stale).toMatchObject({ status: 409, body: { error: 'LEASE_LOST' } });
    h.evidence.push({ event: 'external_effect_replay', requestId, operationId, idempotent,
      duplicateDeliveryRejected: true, executions, effects, resultCommitments: 1,
      automaticPhysicalReconciliation: false, originalAttempt: original.attempt,
      replacementAttempt: final.attempt, finalOutcome: final.outcome,
      limitation: 'External effect is not rolled back; UNKNOWN_OUTCOME requires operator reconciliation and blocks replay.' });
  });
});
