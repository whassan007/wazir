// LS-22 live adapter: real control-plane API, real worker processes, real model generation.
// This is a distributed-protocol qualification (lease expiry, ownership reconciliation, API
// restart, credential persistence), not a coding session: there is no repository fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** A long-lived child in its own process group, logged to `log`; `kill()` is SIGKILL of the group. */
async function background(args, env, log) {
  const handle = await fs.open(log, 'a');
  const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', handle.fd, handle.fd], detached: true });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    pid: child.pid,
    exited,
    async kill() {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      const result = await exited;
      await handle.close().catch(() => undefined);
      return result;
    },
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(what, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

export async function runWorkerLoss(scenario, options, result, artifact) {
  const home = path.join(artifact, 'api-home');
  await fs.mkdir(home, { recursive: true });
  const operator = randomBytes(24).toString('hex');
  const registration = randomBytes(24).toString('hex');
  const workerToken = randomBytes(32).toString('hex');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const apiEnv = { ...process.env, PORT: String(port), WAZIR_HOST: '127.0.0.1', WAZIR_HOME: home,
    WAZIR_API_TOKEN: operator, WAZIR_REGISTRATION_TOKEN: registration };
  delete apiEnv.WAZIR_DATABASE_URL; delete apiEnv.WAZIR_IN_MEMORY; delete apiEnv.WAZIR_ALLOW_UNAUTHENTICATED;
  const workerEnv = name => ({ ...process.env, WAZIR_HOME: path.join(artifact, `${name}-home`),
    WAZIR_REGISTRATION_TOKEN: registration, WAZIR_WORKER_TOKEN: workerToken });
  const auth = { Authorization: `Bearer ${operator}` };
  const timeline = [];
  const mark = (event, data = {}) => timeline.push({ event, at: Date.now(), ...data });
  const children = [];
  const startApi = async label => {
    const api = await background([path.join(repoRoot, 'apps/api/dist/main.js')], apiEnv, path.join(artifact, `${label}.log`));
    children.push(api);
    await until(`${label} health`, async () => (await fetch(`${base}/health`)).ok, 60_000);
    mark(`${label}.ready`, { pid: api.pid });
    return api;
  };
  const startWorker = async label => {
    await fs.mkdir(workerEnv(label).WAZIR_HOME, { recursive: true });
    const worker = await background([path.join(repoRoot, 'apps/worker/dist/index.js'), '--server', base, '--computer', 'live-worker', '--name', label],
      workerEnv(label), path.join(artifact, `${label}.log`));
    children.push(worker);
    mark(`${label}.started`, { pid: worker.pid });
    return worker;
  };
  const status = async id => (await fetch(`${base}/api/v1/tasks/${id}/status`, { headers: auth })).json();
  const requestId = `ls22-${Date.now()}`;

  try {
    let api = await startApi('api-1');
    const workerA = await startWorker('worker-a');
    await until('worker-a registration', async () => {
      const { computers } = await (await fetch(`${base}/api/v1/computers`, { headers: auth })).json();
      return computers.some(c => c.id === 'live-worker' && c.status === 'online');
    }, 120_000);
    await sleep(2000); // the task stream connects right after registration

    const dispatch = await fetch(`${base}/api/v1/tasks/dispatch`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ computerId: 'live-worker', request: {
        requestId, executionId: `exec-${requestId}`, modelId: options.model, maxTokens: 400,
        messages: [{ role: 'user', content: 'Write a numbered list of 40 distinct prime numbers, one per line, then the word DONE.' }],
      } }),
    });
    mark('dispatched', { status: dispatch.status });
    if (dispatch.status !== 202) throw new Error(`dispatch refused: HTTP ${dispatch.status} ${await dispatch.text()}`);

    // The real worker claims and starts a real generation; kill it while it holds the lease.
    await until('lease_acquired by worker-a', async () => (await status(requestId)).events?.some(e => e.type === 'lease_acquired'), 120_000);
    await sleep(1500);
    const killedA = await workerA.kill();
    const atKill = await status(requestId);
    mark('worker-a.killed', { signal: killedA.signal, outcomeAtKill: Boolean(atKill.outcome) });

    // Control-plane restart while the dead worker's lease is still outstanding.
    await api.kill();
    mark('api-1.killed');
    api = await startApi('api-2');

    const workerB = await startWorker('worker-b');
    const final = await until('committed outcome', async () => { const s = await status(requestId); return s.outcome ? s : undefined; }, 10 * 60_000);
    mark('outcome', { ok: final.outcome.ok });
    await sleep(2000);
    const settled = await status(requestId);
    const leases = settled.events.filter(e => e.type === 'lease_acquired').map(e => e.data?.attempt);
    const workerBLog = await fs.readFile(path.join(artifact, 'worker-b.log'), 'utf8').catch(() => '');

    result.metrics.worker_failures = 1;
    result.metrics.recoveries = leases.length > 1 ? 1 : 0;
    result.worker_loss = {
      fault: 'SIGKILL of the worker process group holding the lease, then SIGKILL + restart of the API',
      outcome_at_kill: Boolean(atKill.outcome), lease_attempts: leases, outcome_ok: final.outcome.ok,
      output_chars: String(final.outcome.output ?? '').length, single_outcome: JSON.stringify(final.outcome) === JSON.stringify(settled.outcome),
      worker_b_registered_with_persisted_token: !/error/i.test(workerBLog.split('\n').slice(0, 5).join('\n')),
      timeline,
    };
    result.faults = result.faults.map(f => ({ ...f, fired: true, evidence: { killed: killedA, at: timeline.find(t => t.event === 'worker-a.killed')?.at } }));
    if (atKill.outcome) result.reasons.push('Generation finished before the worker was killed; fault did not interrupt work');
    if (!(leases.length >= 2 && leases.at(-1) > leases[0])) result.reasons.push(`No re-acquired lease after expiry (attempts: ${JSON.stringify(leases)})`);
    if (!final.outcome.ok) result.reasons.push(`Recovered execution failed: ${final.outcome.error ?? 'unknown'}`);
    if (!/DONE|\b2\b/.test(String(final.outcome.output ?? ''))) result.reasons.push('Outcome does not look like a real model generation');
    if (!result.worker_loss.single_outcome) result.reasons.push('Terminal outcome changed after commit');
    await workerB.kill();
    await api.kill();
    result.metrics.acceptance_success = result.reasons.length === 0;
    result.metrics.task_success = final.outcome.ok;
    result.status = result.reasons.length ? 'FAIL' : 'PASS';
  } finally {
    await Promise.all(children.map(c => c.kill().catch(() => undefined)));
    await fs.writeFile(path.join(artifact, 'timeline.json'), JSON.stringify(timeline, null, 2));
  }
}
