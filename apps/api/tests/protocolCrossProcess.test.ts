/**
 * Cross-process integrity of the Agent Protocol task state. Every test runs two
 * (or more) independent API server processes over one durable JsonFileStore and
 * talks to them over real HTTP; faults are a SIGKILL or a failing store write
 * inside a child process (see fixtures/protocolNode.mjs). An in-process lock
 * cannot make any of these pass: the processes share nothing but the store.
 *
 * Requires a built apps/api (dist), as `npm test` does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OPERATOR = 'operator-token-0123456789';
const VIEWER = 'viewer-token-0123456789';
const NODE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'protocolNode.mjs');
const LEASE_MS = 1_500;

interface Node { child: ChildProcess; base: string; log: string[]; exited: Promise<number | null> }

let dir: string;
let root: string;
let nodes: Node[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wazir-xproc-'));
  root = path.join(dir, 'project');
  mkdirSync(root);
  writeFileSync(path.join(root, 'src.js'), 'exports.add = (a, b) => a + b;\n');
  writeFileSync(path.join(root, 'add.test.js'),
    "const assert = require('node:assert');\nconst { add } = require('./src.js');\nassert.strictEqual(add(2, 3), 5);\nconsole.log('ok');\n");
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts: { test: 'node add.test.js' } }));
});

afterEach(async () => {
  for (const n of nodes) n.child.kill('SIGKILL');
  await Promise.all(nodes.map((n) => n.exited));
  nodes = [];
  rmSync(dir, { recursive: true, force: true });
});

async function startNode(env: Record<string, string> = {}): Promise<Node> {
  const child = spawn(process.execPath, [NODE_SCRIPT], {
    env: {
      ...process.env,
      NODE_STORE: path.join(dir, 'wazir.json'),
      NODE_ROOT: root,
      NODE_AUDIT: path.join(dir, 'audit.jsonl'),
      WAZIR_HOME: path.join(dir, 'home'),
      WAZIR_PROTOCOL_STEP_LEASE_MS: String(LEASE_MS),
      WAZIR_PROTOCOL_ADMISSION_WAIT_MS: '20000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log: string[] = [];
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`node did not start:\n${log.join('')}`)), 30_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      log.push(chunk.toString());
      const match = /LISTENING (\d+)/.exec(log.join(''));
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.stderr!.on('data', (chunk: Buffer) => log.push(chunk.toString()));
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`node exited ${code}:\n${log.join('')}`)); });
  });
  const node = { child, base: `http://127.0.0.1:${port}`, log, exited };
  nodes.push(node);
  return node;
}

async function call(n: Node, method: string, route: string, body?: unknown, token = OPERATOR) {
  const res = await fetch(`${n.base}${route}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, body: json };
}

const newTask = async (n: Node): Promise<string> => (await call(n, 'POST', '/ap/v1/agent/tasks', { input: 'xproc' })).body.task_id;
const step = (n: Node, taskId: string, additional: Record<string, unknown> = {}, input = 'step') =>
  call(n, 'POST', `/ap/v1/agent/tasks/${taskId}/steps`, { input, additional_input: additional });
const getTask = async (n: Node, taskId: string) => (await call(n, 'GET', `/ap/v1/agent/tasks/${taskId}`, undefined, VIEWER)).body;
const rpc = (n: Node, method: string, params: unknown, token = OPERATOR) =>
  call(n, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, token);
const verificationStatus = async (n: Node, token = OPERATOR) =>
  JSON.parse((await rpc(n, 'resources/read', { uri: 'wazir://verification/status' }, token)).body.result.contents[0].text);

/** Every step in a consistent record is settled unless the task holds its lease. */
function expectConsistent(task: any): void {
  const ids = task.steps.map((s: any) => s.step_id);
  expect(new Set(ids).size).toBe(ids.length);
  const running = task.steps.filter((s: any) => s.status === 'running');
  if (task.additional_output?.active_step) expect(running.map((s: any) => s.step_id)).toEqual([task.additional_output.active_step.step_id]);
  else expect(running).toEqual([]);
  if (task.status === 'completed' || task.status === 'failed') {
    const last = task.steps.find((s: any) => s.step_id === task.additional_output.last_step_id);
    expect(last).toBeDefined();
    expect(last.status).toBe(task.status === 'completed' ? 'completed' : 'failed');
  }
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await fn();
  while (!ok(value) && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 100)); value = await fn(); }
  return value;
}

describe('two API processes, one store', () => {
  it('concurrent step creation loses no steps', async () => {
    const [a, b] = await Promise.all([startNode(), startNode()]);
    const taskId = await newTask(a);
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => step(i % 2 ? b : a, taskId, {}, `s${i}`)));
    expect(results.map((r) => r.status)).toEqual(Array(16).fill(200));
    for (const n of [a, b]) {
      const task = await getTask(n, taskId);
      expect(task.steps.map((s: any) => s.step_id).sort()).toEqual(results.map((r) => r.body.step_id).sort());
      expectConsistent(task);
    }
    // Every created step is individually addressable from either process.
    for (const r of results) expect((await call(b, 'GET', `/ap/v1/agent/tasks/${taskId}/steps/${r.body.step_id}`, undefined, VIEWER)).status).toBe(200);
  }, 120_000);

  it('concurrent artifact creation loses no artifacts', async () => {
    const [a, b] = await Promise.all([startNode(), startNode()]);
    const taskId = await newTask(a);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      call(i % 2 ? b : a, 'POST', `/ap/v1/agent/tasks/${taskId}/artifacts`, { file_name: `f${i}.txt`, content: String(i) })));
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    const task = await getTask(a, taskId);
    expect(task.artifacts.map((x: any) => x.artifact_id).sort()).toEqual(results.map((r) => r.body.artifact_id).sort());
  }, 120_000);

  it('a long-running step does not overwrite artifacts added meanwhile by another process (stale write)', async () => {
    const [a, b] = await Promise.all([startNode(), startNode()]);
    const taskId = await newTask(a);
    const running = step(a, taskId, { tool: { name: 'shell', input: { command: 'sleep 1' } } });
    await until(() => getTask(b, taskId), (t) => t.status === 'running');
    const added = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      call(b, 'POST', `/ap/v1/agent/tasks/${taskId}/artifacts`, { file_name: `late${i}.txt` })));
    expect(added.map((r) => r.status)).toEqual(Array(5).fill(201));
    const done = await running;
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    const task = await getTask(a, taskId);
    expect(task.artifacts).toHaveLength(5);
    expect(task.steps.find((s: any) => s.step_id === done.body.step_id).status).toBe('completed');
    expectConsistent(task);
  }, 120_000);

  it('simultaneous completion yields exactly one authoritative terminal outcome', async () => {
    const [a, b] = await Promise.all([startNode(), startNode()]);
    for (let round = 0; round < 5; round++) {
      const taskId = await newTask(a);
      const [ra, rb] = await Promise.all([step(a, taskId, { is_last: true }, 'a'), step(b, taskId, { is_last: true }, 'b')]);
      const winners = [ra, rb].filter((r) => r.status === 200);
      expect(winners).toHaveLength(1);
      const loser = [ra, rb].find((r) => r.status !== 200)!;
      expect(loser.status).toBe(409);
      expect(loser.body.code).toBe('TASK_TERMINAL');
      const task = await getTask(b, taskId);
      expect(task.status).toBe('completed');
      expect(task.additional_output.last_step_id).toBe(winners[0].body.step_id);
      expect(task.steps.filter((s: any) => s.is_last)).toHaveLength(1);
      expectConsistent(task);
    }
  }, 120_000);

  it('a failing step racing a successful completion never produces contradictory terminal state', async () => {
    const [a, b] = await Promise.all([startNode(), startNode()]);
    for (let round = 0; round < 5; round++) {
      const taskId = await newTask(a);
      const [fail, ok] = await Promise.all([
        step(a, taskId, { tool: { name: 'read', input: { path: 'missing.txt' } } }, 'fail'),
        step(b, taskId, { is_last: true }, 'ok'),
      ]);
      const task = await getTask(a, taskId);
      expectConsistent(task);
      expect(['completed', 'failed']).toContain(task.status);
      const accepted = [fail, ok].filter((r) => r.status === 200);
      expect(accepted).toHaveLength(1);
      expect([fail, ok].find((r) => r.status !== 200)!.body.code).toBe('TASK_TERMINAL');
      expect(task.additional_output.last_step_id).toBe(accepted[0].body.step_id);
      // Monotonic: re-reading later shows the same terminal outcome.
      await new Promise((r) => setTimeout(r, 200));
      expect((await getTask(b, taskId)).status).toBe(task.status);
    }
  }, 120_000);

  it('a duplicate request (same idempotency key) to two processes executes the tool once', async () => {
    const [a, b] = await Promise.all([startNode(), startNode()]);
    const taskId = await newTask(a);
    const body = { idempotency_key: 'req-1', tool: { name: 'shell', input: { command: 'echo x >> dup.txt' } } };
    const [ra, rb] = await Promise.all([step(a, taskId, body), step(b, taskId, body)]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.body.step_id).toBe(rb.body.step_id);
    expect(readFileSync(path.join(root, 'dup.txt'), 'utf8').trim().split('\n')).toEqual(['x']);
    expect((await getTask(a, taskId)).steps).toHaveLength(1);
  }, 120_000);
});

describe('process termination and persistence faults', () => {
  it('API killed before the dispatch intent is durable: step ABANDONED, tool never ran, task continues', async () => {
    const a = await startNode();
    const b = await startNode({ NODE_CRASH: 'after-intent' });
    const taskId = await newTask(a);
    const crashed = await step(b, taskId, { tool: { name: 'write', input: { path: 'never.txt', content: 'x' } } }).catch((e) => e);
    expect(crashed).toBeInstanceOf(Error);
    expect(await b.exited).toBeNull();
    const next = await step(a, taskId, { is_last: true });
    expect(next.status).toBe(200);
    const task = await getTask(a, taskId);
    const abandoned = task.steps.find((s: any) => s.step_id !== next.body.step_id);
    expect(abandoned.additional_output.outcome).toBe('ABANDONED');
    expect(existsSync(path.join(root, 'never.txt'))).toBe(false);
    expect(task.status).toBe('completed');
    expectConsistent(task);
  }, 120_000);

  it('API killed after a filesystem mutation but before its outcome is recorded: OUTCOME_UNKNOWN, no blind retry', async () => {
    const a = await startNode({ WAZIR_PROTOCOL_ADMISSION_WAIT_MS: '300' });
    const b = await startNode({ NODE_CRASH: 'after-dispatch' });
    const taskId = await newTask(a);
    const crashed = await step(b, taskId, { tool: { name: 'shell', input: { command: 'echo once >> mutated.txt' } } }).catch((e) => e);
    expect(crashed).toBeInstanceOf(Error);
    expect(b.log.join('')).toContain('CRASH after-dispatch');
    expect(readFileSync(path.join(root, 'mutated.txt'), 'utf8')).toBe('once\n');

    // While the lease is live the task is busy; once it expires it needs reconciliation.
    const blocked = await until(() => step(a, taskId, { is_last: true }), (r) => r.body?.code === 'RECONCILIATION_REQUIRED');
    expect(blocked.status).toBe(409);
    let task = await getTask(a, taskId);
    expect(task.status).toBe('paused');
    expect(task.additional_output.outcome).toBe('OUTCOME_UNKNOWN');
    const unknown = task.steps[0];
    expect(unknown.additional_output.outcome).toBe('OUTCOME_UNKNOWN');
    expect(task.additional_output.reconciliation_required.step_id).toBe(unknown.step_id);
    expect(readFileSync(path.join(root, 'mutated.txt'), 'utf8')).toBe('once\n');

    // Reconciliation needs evidence, resumes (never completes) the task.
    expect((await call(a, 'POST', `/ap/v1/agent/tasks/${taskId}/steps/${unknown.step_id}/reconcile`, { resolution: 'succeeded' })).status).toBe(400);
    expect((await call(a, 'POST', `/ap/v1/agent/tasks/${taskId}/steps/${unknown.step_id}/reconcile`, { resolution: 'succeeded', evidence: 'x' }, VIEWER)).status).toBe(403);
    const reconciled = await call(a, 'POST', `/ap/v1/agent/tasks/${taskId}/steps/${unknown.step_id}/reconcile`,
      { resolution: 'succeeded', evidence: 'mutated.txt contains one line' });
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.status).toBe('running');
    const done = await step(a, taskId, { is_last: true });
    expect(done.status).toBe(200);
    task = await getTask(a, taskId);
    expect(task.status).toBe('completed');
    expect(task.additional_output.outcome).toBe('UNVERIFIED');
    expectConsistent(task);
  }, 120_000);

  it('tool succeeded but outcome persistence failed: caller told it WAS dispatched; state becomes OUTCOME_UNKNOWN', async () => {
    const a = await startNode({ WAZIR_PROTOCOL_ADMISSION_WAIT_MS: '300' });
    const b = await startNode({ NODE_FAIL_WRITE: 'after-dispatch' });
    const taskId = await newTask(a);
    const res = await step(b, taskId, { tool: { name: 'write', input: { path: 'out.txt', content: 'done' } }, is_last: true });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PERSISTENCE_FAILED');
    expect(res.body.error).toContain('WAS dispatched');
    expect(readFileSync(path.join(root, 'out.txt'), 'utf8')).toBe('done');
    const task = await until(async () => { await step(a, taskId); return getTask(a, taskId); }, (t) => t.status === 'paused');
    expect(task.additional_output.outcome).toBe('OUTCOME_UNKNOWN');
    expect(task.status).not.toBe('completed');
    expectConsistent(task);
  }, 120_000);

  it('verification evidence and task completion commit together or not at all', async () => {
    const a = await startNode({ WAZIR_PROTOCOL_ADMISSION_WAIT_MS: '300' });
    const b = await startNode({ NODE_FAIL_WRITE: 'before-verify-record' });
    const taskId = await newTask(a);
    const res = await step(b, taskId, { verify: true, is_last: true });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PERSISTENCE_FAILED');
    let task = await getTask(a, taskId);
    expect(task.status).not.toBe('completed');
    expect(task.steps[0].additional_output.verification).toBeUndefined();
    expect((await verificationStatus(a)).verified).toBe(false);
    // After the dead owner's lease expires, the step is ABANDONED and the task can continue.
    const next = await until(() => step(a, taskId, { verify: true, is_last: true }), (r) => r.status === 200);
    expect(next.body.additional_output.outcome).toBe('VERIFIED');
    task = await getTask(a, taskId);
    expect(task.steps[0].additional_output.outcome).toBe('ABANDONED');
    expect(task.additional_output.outcome).toBe('VERIFIED');
    expectConsistent(task);
  }, 120_000);
});

describe('verification provenance across processes', () => {
  it('a PASS is stale after a mutation from another process, and viewers see no check output', async () => {
    const [a, b] = await Promise.all([startNode(), startNode()]);
    const t1 = await newTask(a);
    const verified = await step(a, t1, { verify: true, is_last: true });
    expect(verified.body.additional_output.outcome).toBe('VERIFIED');
    expect(verified.body.additional_output.verification.principal).toBe('operator');
    expect(verified.body.additional_output.verification.requestedChecks).toEqual(['test']);

    let status = await verificationStatus(b);
    expect(status).toMatchObject({ verified: true, status: 'PASS' });
    expect(status.evidence.checks[0].output).toContain('ok');
    const viewer = await verificationStatus(b, VIEWER);
    expect(viewer.verified).toBe(true);
    expect(viewer.evidence.redacted).toBe(true);
    expect(viewer.evidence.checks[0].output).toBeUndefined();

    // A mutation through the other process invalidates the earlier PASS.
    const write = await rpc(b, 'tools/call', { name: 'write', arguments: { path: 'src.js', content: 'exports.add = (a, b) => a - b;\n' } });
    expect(write.body.result.isError).toBe(false);
    status = await verificationStatus(a);
    expect(status.verified).toBe(false);
    expect(status.status).toBe('STALE');

    // Fresh verification against the new revision reports the real (failing) result.
    const t2 = await newTask(b);
    const reverified = await step(b, t2, { verify: true, is_last: true });
    expect(reverified.body.additional_output.outcome).toBe('VERIFICATION_FAILED');
    expect((await verificationStatus(a)).verified).toBe(false);
  }, 120_000);
});
