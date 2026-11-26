#!/usr/bin/env node
/**
 * Two-node lease-fencing demo over NATS Core using the built @wazir/core dist.
 *
 *   node scripts/fabric-two-node-fencing.mjs coordinator --nats nats://HOST:PORT [--run-id ID]
 *   node scripts/fabric-two-node-fencing.mjs worker      --nats nats://HOST:PORT --run-id ID [--worker-id ID]
 *
 * Coordinator (lease authority, owns ResourceReservationManager + the guarded resource):
 *   1. waits for a remote worker's `agent.registered`
 *   2. grants it a short lease on `exclusive:shared-ledger` (fencing token T1) via `resource.acquired`
 *   3. after the lease expires, re-grants the resource to a local worker (token T2 > T1),
 *      which writes successfully through `assertFencedWrite`
 *   4. receives the remote worker's delayed write tagged `fencing_token: T1` and must reject it
 *      with StaleFencingTokenError, replying with `resource.conflict`
 * Worker: registers, receives the grant, "pauses" past its TTL, then attempts the stale write and
 * exits 0 only if the coordinator rejected it.
 *
 * Exit code 0 = fencing held across hosts; non-zero = failure.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDist = path.resolve(here, '../packages/core/dist/src');
const { CoordinationFabric } = await import(pathToFileURL(path.join(coreDist, 'services/coordinationFabric.js')).href);
const { ResourceReservationManager, StaleFencingTokenError } = await import(
  pathToFileURL(path.join(coreDist, 'services/resourceReservationManager.js')).href
);

const args = process.argv.slice(2);
const role = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const natsUrl = opt('nats', process.env.WAZIR_NATS_URL);
const runId = opt('run-id', `fence-${Date.now()}`);
const workflowId = `wf-two-node-${runId}`;
const RESOURCE = 'shared-ledger';
const RESOURCE_KEY = `exclusive:${RESOURCE}`;
const LEASE_TTL_MS = Number(opt('ttl-ms', '1500'));
const TIMEOUT_MS = Number(opt('timeout-ms', '60000'));

const log = (msg) => console.log(`[${role}@${os.hostname()} ${new Date().toISOString()}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!natsUrl || (role !== 'coordinator' && role !== 'worker')) {
  console.error('usage: fabric-two-node-fencing.mjs coordinator|worker --nats nats://host:port [--run-id ID]');
  process.exit(2);
}

const fabricDir = mkdtempSync(path.join(os.tmpdir(), `wazir-two-node-${role}-`));
const fabric = new CoordinationFabric({
  fabricDir,
  natsUrl,
  connectTimeoutMs: 2000,
  maxRetries: 1000,
  retryBaseDelayMs: 100,
  retryMaxDelayMs: 500,
});
const send = async (input) => {
  const env = await fabric.publish({ workflow_id: workflowId, ...input });
  await fabric.flush(3000);
  return env;
};
const nextEvent = (pred, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timeout waiting for ${label}`));
    }, TIMEOUT_MS);
    const unsub = fabric.subscribe({ workflowId }, (ev) => {
      if (!pred(ev)) return;
      clearTimeout(timer);
      unsub();
      resolve(ev);
    });
  });
const shutdown = async (code) => {
  await fabric.close().catch(() => undefined);
  rmSync(fabricDir, { recursive: true, force: true });
  log(`exit ${code}`);
  process.exit(code);
};

log(`natsUrl=${natsUrl} workflow=${workflowId} node=${process.version} arch=${process.arch}`);

if (role === 'coordinator') {
  const leases = new ResourceReservationManager({ defaultTtlMs: LEASE_TTL_MS });
  const ledger = { value: 'initial', writtenBy: null, token: 0 };
  const applyWrite = async (workerId, token, value) => {
    await leases.assertFencedWrite(RESOURCE_KEY, token);
    Object.assign(ledger, { value, writtenBy: workerId, token });
  };

  await send({ type: 'agent.heartbeat', source_agent: 'coordinator', payload: { ready: true } }); // establishes SUB
  log('waiting for remote worker registration');
  const reg = await nextEvent((ev) => ev.type === 'agent.registered' && ev.source_agent !== 'coordinator', 'registration');
  const remoteWorker = reg.source_agent;
  log(`registered ${remoteWorker} (payload=${JSON.stringify(reg.payload)})`);

  const staleLease = await leases.acquire({ workerId: remoteWorker, workflowId, exclusiveResources: [RESOURCE], ttlMs: LEASE_TTL_MS });
  log(`granted ${staleLease.leaseId} to ${remoteWorker} fencingToken=${staleLease.fencingToken} ttl=${LEASE_TTL_MS}ms`);
  const staleWrite = nextEvent((ev) => ev.type === 'task.progress' && ev.source_agent === remoteWorker, 'stale write');
  await send({
    type: 'resource.acquired',
    source_agent: 'coordinator',
    target_agent: remoteWorker,
    fencing_token: staleLease.fencingToken,
    payload: { leaseId: staleLease.leaseId, resource: RESOURCE, ttlMs: LEASE_TTL_MS },
  });

  await sleep(LEASE_TTL_MS + 300);
  const reclaimed = await leases.reclaimExpired();
  log(`reclaimed expired leases: ${reclaimed.map((l) => `${l.leaseId}(${l.workerId},t${l.fencingToken})`).join(', ') || 'none'}`);
  const freshLease = await leases.acquire({ workerId: 'worker-mac-local', workflowId, exclusiveResources: [RESOURCE], ttlMs: 30_000 });
  log(`granted ${freshLease.leaseId} to worker-mac-local fencingToken=${freshLease.fencingToken}`);
  await applyWrite('worker-mac-local', freshLease.fencingToken, 'written-by-current-holder');
  log(`fresh write ACCEPTED: ledger=${JSON.stringify(ledger)}`);
  await send({ type: 'resource.expired', source_agent: 'coordinator', target_agent: remoteWorker, payload: { leaseId: staleLease.leaseId } });

  const ev = await staleWrite;
  const token = ev.fencing_token;
  log(`received write from ${remoteWorker} over NATS with fencing_token=${token} payload=${JSON.stringify(ev.payload)}`);
  let rejected = false;
  let reason = '';
  try {
    await applyWrite(remoteWorker, token, ev.payload.value);
  } catch (err) {
    rejected = err instanceof StaleFencingTokenError;
    reason = `${err?.name}: ${err?.message}`;
  }
  let fenceCheck = 'validateFence passed';
  try {
    await leases.validateFence(staleLease.leaseId, remoteWorker, token);
  } catch (err) {
    fenceCheck = `${err?.name}: ${err?.message}`;
  }
  log(rejected ? `stale write REJECTED: ${reason}` : `stale write NOT rejected (BUG): ledger=${JSON.stringify(ledger)}`);
  log(`validateFence(${staleLease.leaseId}, ${remoteWorker}, ${token}) -> ${fenceCheck}`);
  await send({
    type: rejected ? 'resource.conflict' : 'task.completed',
    source_agent: 'coordinator',
    target_agent: remoteWorker,
    causation_id: ev.event_id,
    payload: { rejected, reason, currentToken: freshLease.fencingToken },
  });
  const ok = rejected && ledger.writtenBy === 'worker-mac-local' && ledger.value === 'written-by-current-holder';
  log(`final ledger=${JSON.stringify(ledger)} RESULT=${ok ? 'PASS' : 'FAIL'}`);
  await sleep(500);
  await shutdown(ok ? 0 : 1);
} else {
  const workerId = opt('worker-id', `worker-${os.hostname()}`);
  const grantP = nextEvent((ev) => ev.type === 'resource.acquired' && ev.target_agent === workerId, 'lease grant');
  let granted = false;
  void grantP.then(() => (granted = true), () => undefined);
  // NATS Core is at-most-once: re-announce until the coordinator answers.
  while (!granted) {
    await send({ type: 'agent.registered', source_agent: workerId, payload: { host: os.hostname(), arch: process.arch } });
    await Promise.race([grantP.catch(() => undefined), sleep(500)]);
  }
  const grant = await grantP;
  const token = grant.fencing_token;
  log(`lease granted: ${grant.payload.leaseId} fencingToken=${token}; simulating a stall past TTL`);
  await sleep(LEASE_TTL_MS + 1500);
  const verdictP = nextEvent(
    (ev) => (ev.type === 'resource.conflict' || ev.type === 'task.completed') && ev.target_agent === workerId,
    'verdict',
  );
  const write = await send({
    type: 'task.progress',
    source_agent: workerId,
    fencing_token: token,
    idempotency_key: `${workflowId}-${workerId}-write-1`,
    payload: { op: 'write', resource: RESOURCE, value: `stale-write-from-${workerId}` },
  });
  log(`sent stale write ${write.event_id} with fencing_token=${token}`);
  const verdict = await verdictP;
  log(`verdict: ${verdict.type} ${JSON.stringify(verdict.payload)}`);
  await shutdown(verdict.type === 'resource.conflict' && verdict.payload.rejected === true ? 0 : 1);
}
