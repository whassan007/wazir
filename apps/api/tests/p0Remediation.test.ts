import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { JsonFileStore, MemoryStore, type KeyValueStore, type StoreEntry } from '@wazir/shared';
import type { WorkerExecutionRequest } from '@wazir/core';
import { createApiState, createApp, TaskDispatcher, type ApiState } from '../src/server.js';
import { ApiAuth } from '../src/auth.js';
import { Worker } from '@wazir/workers';

/**
 * P0/P1 remediation: endpoint authorization matrix, durable worker credentials and
 * at-most-once commitment of dispatched outcomes.
 */

const OP = 'op-secret-token';
const VIEW = 'view-secret-token';
const REG = 'reg-secret-token';

type Scope = 'public' | 'viewer' | 'operator' | 'registration' | 'computer' | 'mcp';

/**
 * The complete authorization matrix. Every route the app registers must appear here (the
 * completeness test fails otherwise), so a new endpoint cannot ship without a decision.
 */
const MATRIX: Record<string, Scope> = {
  'GET /health': 'public',
  'GET /metrics': 'viewer',
  'GET /api/v1/overview': 'viewer',
  'GET /api/v1/computers': 'viewer',
  'GET /api/v1/workers': 'viewer',
  'GET /api/v1/runtimes': 'viewer',
  'GET /api/v1/models': 'viewer',
  'GET /api/v1/model-instances': 'viewer',
  'GET /api/v1/models/:id/inspect': 'viewer',
  'POST /api/v1/models/reconcile': 'operator',
  'POST /api/v1/models/:id/estimate': 'operator',
  'POST /api/v1/models/:id/load': 'operator',
  'POST /api/v1/models/:id/unload': 'operator',
  'POST /api/v1/models/:id/drain': 'operator',
  'POST /api/v1/models/:id/restore': 'operator',
  'POST /api/v1/models/:id/pin': 'operator',
  'POST /api/v1/models/:id/unpin': 'operator',
  'POST /api/v1/models/:id/warm': 'operator',
  'POST /api/v1/models/:id/cool': 'operator',
  'GET /api/v1/agents/capabilities': 'viewer',
  'GET /api/v1/agents': 'viewer',
  'GET /api/v1/tools': 'viewer',
  'GET /api/v1/executions': 'viewer',
  'GET /api/v1/executions/:id': 'viewer',
  'POST /computers/register': 'registration',
  'POST /computers/:id/heartbeat': 'computer',
  'GET /computers/:id/tasks/stream': 'computer',
  'POST /api/v1/tasks/dispatch': 'operator',
  'GET /api/v1/tasks/:requestId/status': 'viewer',
  'POST /computers/:id/executions/:requestId/claim': 'computer',
  'POST /computers/:id/executions/:requestId/renew': 'computer',
  'POST /computers/:id/executions/:requestId/events': 'computer',
  'POST /computers/:id/executions/:requestId/result': 'computer',
  'POST /executions': 'operator',
  'POST /ap/v1/agent/tasks': 'operator',
  'GET /ap/v1/agent/tasks': 'viewer',
  'GET /ap/v1/agent/tasks/:task_id': 'viewer',
  'POST /ap/v1/agent/tasks/:task_id/steps': 'operator',
  'POST /ap/v1/agent/tasks/:task_id/steps/:step_id/reconcile': 'operator',
  'GET /ap/v1/agent/tasks/:task_id/steps': 'viewer',
  'GET /ap/v1/agent/tasks/:task_id/steps/:step_id': 'viewer',
  'GET /ap/v1/agent/tasks/:task_id/artifacts': 'viewer',
  'POST /ap/v1/agent/tasks/:task_id/artifacts': 'operator',
  'GET /ap/v1/agent/tasks/:task_id/artifacts/:artifact_id': 'viewer',
  'POST /mcp': 'mcp',
  'POST /mcp/v1': 'mcp',
};

function routes(app: Express): string[] {
  const stack = (app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })._router.stack;
  return stack.filter((l) => l.route).flatMap((l) =>
    Object.keys(l.route!.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`));
}

const concrete = (path: string) => path.replace(/:[a-z_A-Z]+/g, 'x1');

const json = (body: unknown, token?: string, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
});

function request(requestId: string): WorkerExecutionRequest {
  return { executionId: `exec-${requestId}`, requestId, modelId: 'm', messages: [{ role: 'user', content: 'hi' }] };
}

/** A store whose writes can be made to fail, to simulate a disk/database outage. */
class FlakyStore implements KeyValueStore {
  failWrites = false;
  constructor(private readonly inner: KeyValueStore = new MemoryStore()) {}
  async update<T>(key: string, mutate: (current: T | undefined) => T): Promise<T> {
    if (this.failWrites) throw new Error('EIO: simulated storage failure');
    return this.inner.update!(key, mutate);
  }
  async put(key: string, value: unknown): Promise<void> {
    if (this.failWrites) throw new Error('EIO: simulated storage failure');
    return this.inner.put(key, value);
  }
  get<T>(key: string): Promise<T | undefined> { return this.inner.get<T>(key); }
  list(prefix: string): Promise<StoreEntry[]> { return this.inner.list(prefix); }
  async delete(key: string): Promise<void> {
    if (this.failWrites) throw new Error('EIO: simulated storage failure');
    return this.inner.delete(key);
  }
  clear(): Promise<void> { return this.inner.clear(); }
}

describe('P0/P1 remediation', { timeout: 30_000 }, () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function start(store?: KeyValueStore, tokens = true): Promise<{ state: ApiState; app: Express; baseUrl: string; server: Server }> {
    const state = await createApiState({
      store,
      auth: tokens
        ? { operatorToken: OP, viewerToken: VIEW, registrationToken: REG, allowUnauthenticated: false, store }
        : { allowUnauthenticated: true, store },
    });
    const app = createApp(state);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    servers.push(server);
    return { state, app, server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  async function stop(server: Server): Promise<void> {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
  }

  describe('authorization matrix', () => {
    it('classifies every registered route', async () => {
      const { app } = await start();
      const unclassified = routes(app).filter((r) => !(r in MATRIX));
      expect(unclassified).toEqual([]);
    });

    it('denies anonymous and viewer callers on every operator route; operator passes the gate', async () => {
      const { app, baseUrl } = await start();
      const failures: string[] = [];
      for (const route of routes(app).filter((r) => MATRIX[r] === 'operator')) {
        const [method, path] = route.split(' ');
        const url = baseUrl + concrete(path);
        const anon = (await fetch(url, json({}, undefined, method))).status;
        const viewer = (await fetch(url, json({}, VIEW, method))).status;
        const operator = (await fetch(url, json({}, OP, method))).status;
        if (anon !== 401) failures.push(`${route}: anonymous got ${anon}`);
        if (viewer !== 403) failures.push(`${route}: viewer got ${viewer}`);
        if (operator === 401 || operator === 403) failures.push(`${route}: operator got ${operator}`);
      }
      expect(failures).toEqual([]);
    });

    it('lets a viewer use every read-only route and refuses anonymous callers', async () => {
      const { app, baseUrl } = await start();
      const failures: string[] = [];
      for (const route of routes(app).filter((r) => MATRIX[r] === 'viewer')) {
        const [method, path] = route.split(' ');
        const url = baseUrl + concrete(path);
        const anon = (await fetch(url, json({}, undefined, method))).status;
        const viewer = (await fetch(url, json({}, VIEW, method))).status;
        if (anon !== 401) failures.push(`${route}: anonymous got ${anon}`);
        if (viewer === 401 || viewer === 403) failures.push(`${route}: viewer got ${viewer}`);
      }
      expect(failures).toEqual([]);
    });

    it('a viewer cannot create Agent Protocol tasks, execute steps or write artifacts', async () => {
      const { state, baseUrl } = await start();
      const tasksBefore = (await state.editorProtocol.listTasks()).length;
      expect((await fetch(`${baseUrl}/ap/v1/agent/tasks`, json({ input: 'rm -rf /' }, VIEW))).status).toBe(403);
      expect((await state.editorProtocol.listTasks()).length).toBe(tasksBefore);

      const created = await fetch(`${baseUrl}/ap/v1/agent/tasks`, json({ input: 'hello' }, OP));
      expect(created.status).toBe(201);
      const task = (await created.json()) as { task_id: string };
      expect((await fetch(`${baseUrl}/ap/v1/agent/tasks/${task.task_id}/steps`, json({ input: 'x' }, VIEW))).status).toBe(403);
      expect((await fetch(`${baseUrl}/ap/v1/agent/tasks/${task.task_id}/artifacts`, json({ file_name: 'a.txt', content: 'x' }, VIEW))).status).toBe(403);
      expect((await state.editorProtocol.listSteps(task.task_id)).length).toBe(0);
      expect((await state.editorProtocol.listArtifacts(task.task_id)).length).toBe(0);

      // Viewer reads still work.
      expect((await fetch(`${baseUrl}/ap/v1/agent/tasks/${task.task_id}`, json({}, VIEW, 'GET'))).status).toBe(200);
      expect((await fetch(`${baseUrl}/ap/v1/agent/tasks`, json({}, VIEW, 'GET'))).status).toBe(200);
    });

    it('MCP: a viewer may list and read but not call tools, even inside a batch', async () => {
      const { baseUrl } = await start();
      const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: 1, method, params });
      for (const method of ['initialize', 'ping', 'tools/list', 'resources/list', 'prompts/list']) {
        const res = await fetch(`${baseUrl}/mcp`, json(rpc(method), VIEW));
        expect(res.status, method).toBe(200);
      }
      const call = rpc('tools/call', { name: 'shell', arguments: { command: 'touch /tmp/wazir-viewer-pwned' } });
      for (const path of ['/mcp', '/mcp/v1']) {
        const res = await fetch(baseUrl + path, json(call, VIEW));
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32001);
        expect((await fetch(baseUrl + path, json([rpc('ping'), call], VIEW))).status).toBe(403);
        expect((await fetch(baseUrl + path, json(rpc('some/unknown-mutation'), VIEW))).status).toBe(403);
        expect((await fetch(baseUrl + path, json(call))).status).toBe(401);
      }
      const operator = await fetch(`${baseUrl}/mcp`, json(rpc('tools/call', { name: 'nonexistent-tool', arguments: {} }), OP));
      expect(operator.status).toBe(200);
    });
  });

  describe('worker credential persistence', () => {
    it('a successful registration survives an API restart (file store)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wazir-cred-'));
      try {
        const file = join(dir, 'store.json');
        const first = await start(new JsonFileStore(file));
        const reg = await fetch(`${first.baseUrl}/computers/register`, json({ id: 'w1', name: 'w1', type: 'workstation' }, REG));
        expect(reg.status).toBe(200);
        const { token } = (await reg.json()) as { token: string };
        await stop(first.server);

        const second = await start(new JsonFileStore(file));
        expect((await fetch(`${second.baseUrl}/computers/w1/heartbeat`, json({}, token))).status).toBe(200);
        expect((await fetch(`${second.baseUrl}/computers/w1/heartbeat`, json({}, 'x'.repeat(64)))).status).toBe(401);
      } finally { await rm(dir, { recursive: true, force: true }); }
    });

    it('a storage failure fails registration and rotation; the previous credential stays valid', async () => {
      const store = new FlakyStore();
      const { baseUrl } = await start(store);
      const reg = await fetch(`${baseUrl}/computers/register`, json({ id: 'w2', name: 'w2', type: 'workstation' }, REG));
      const { token } = (await reg.json()) as { token: string };

      store.failWrites = true;
      const fresh = await fetch(`${baseUrl}/computers/register`, json({ id: 'w3', name: 'w3', type: 'workstation' }, REG));
      expect(fresh.status).toBe(503);
      const rotate = await fetch(`${baseUrl}/computers/register`, json({ id: 'w2', name: 'w2', type: 'workstation', token: 'n'.repeat(32) }, token));
      expect(rotate.status).toBe(503);
      store.failWrites = false;

      expect((await fetch(`${baseUrl}/computers/w3/heartbeat`, json({}, 'anything-at-all-123'))).status).toBe(404);
      expect((await fetch(`${baseUrl}/computers/w2/heartbeat`, json({}, token))).status).toBe(200);
      expect((await fetch(`${baseUrl}/computers/w2/heartbeat`, json({}, 'n'.repeat(32)))).status).toBe(401);
    });

    it('issueComputerToken resolves only after the hash is stored', async () => {
      const store = new FlakyStore();
      const auth = new ApiAuth({ store, allowUnauthenticated: true });
      const token = await auth.issueComputerToken('c1');
      expect(((await store.get<{ hash: string }>('auth:computer:c1'))?.hash)).toMatch(/^[0-9a-f]{64}$/);
      store.failWrites = true;
      await expect(auth.issueComputerToken('c1', 'r'.repeat(32))).rejects.toThrow('EIO');
      expect(auth.isComputerToken('c1', token)).toBe(true);
      expect(auth.isComputerToken('c1', 'r'.repeat(32))).toBe(false);
    });

    it('a revoked credential cannot be reused, before or after a restart; a failed revoke still fails closed', async () => {
      const store = new FlakyStore();
      const a = new ApiAuth({ store, allowUnauthenticated: true });
      const t1 = await a.issueComputerToken('c1');
      const t2 = await a.issueComputerToken('c2');
      await a.revokeComputerToken('c1');
      expect(a.isComputerToken('c1', t1)).toBe(false);
      const restarted = new ApiAuth({ store, allowUnauthenticated: true });
      await restarted.init();
      expect(restarted.isComputerToken('c1', t1)).toBe(false);
      expect(restarted.hasComputerToken('c1')).toBe(false);
      expect(restarted.isComputerToken('c2', t2)).toBe(true);

      store.failWrites = true;
      await expect(restarted.revokeComputerToken('c2')).rejects.toThrow('EIO');
      expect(restarted.isComputerToken('c2', t2)).toBe(false);
    });

    it('startup fails rather than silently dropping stored credentials when the store cannot be read', async () => {
      const broken: KeyValueStore = { ...new MemoryStore(), list: async () => { throw new Error('EIO: unreadable'); } } as KeyValueStore;
      await expect(new ApiAuth({ store: broken }).init()).rejects.toThrow('EIO');
    });
    it('a worker with a pre-shared token registers via the registration token, then re-registers with its own token after an API restart', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wazir-preshared-'));
      const preshared = 'p'.repeat(64);
      const workers: Worker[] = [];
      const adapter = { id: 'none', type: 'other', discover: async () => ({ id: 'none', name: 'none', version: '0' }),
        healthCheck: async () => ({ status: 'unavailable' }), listModels: async () => [], getCapabilities: async () => ({}),
        async *generate() { /* unused */ } } as never;
      try {
        const file = join(dir, 'store.json');
        const first = await start(new JsonFileStore(file));
        const a = new Worker({ computerId: 'pre', name: 'pre', serverUrl: first.baseUrl, registrationToken: REG, token: preshared, adapters: [adapter], heartbeatIntervalMs: 60_000 });
        workers.push(a);
        await a.start();
        expect((await fetch(`${first.baseUrl}/computers/pre/heartbeat`, json({}, preshared))).status).toBe(200);
        await a.stop();
        await stop(first.server);

        const second = await start(new JsonFileStore(file));
        // No registration token this time: the persisted credential alone must suffice.
        const b = new Worker({ computerId: 'pre', name: 'pre', serverUrl: second.baseUrl, token: preshared, adapters: [adapter], heartbeatIntervalMs: 60_000 });
        workers.push(b);
        await b.start();
        expect((await fetch(`${second.baseUrl}/computers/pre/heartbeat`, json({}, preshared))).status).toBe(200);
      } finally {
        for (const w of workers) await w.stop().catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('distributed execution', () => {
    async function claimOver(baseUrl: string, id: string, requestId: string, token: string) {
      const res = await fetch(`${baseUrl}/computers/${id}/executions/${requestId}/claim`, json({}, token));
      return { status: res.status, body: (await res.json()) as { token?: string; attempt?: number; error?: string } };
    }

    it('simultaneous claims: exactly one wins', async () => {
      const { baseUrl } = await start(undefined, false);
      const { token } = (await (await fetch(`${baseUrl}/computers/register`, json({ id: 'w', name: 'w', type: 'workstation' }))).json()) as { token: string };
      await fetch(`${baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'w', request: request('race') }));
      const claims = await Promise.all(Array.from({ length: 8 }, () => claimOver(baseUrl, 'w', 'race', token)));
      expect(claims.filter((c) => c.status === 200)).toHaveLength(1);
      expect(claims.filter((c) => c.status === 409).every((c) => c.body.error === 'RESOURCE_BUSY')).toBe(true);
    });

    it('a duplicate result POST is acknowledged but recorded once; a late result after lease expiry is refused', async () => {
      const store = new MemoryStore();
      const state = await createApiState({ store, workerLeaseMs: 300, auth: { allowUnauthenticated: true } });
      const app = createApp(state);
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      servers.push(server);
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { token } = (await (await fetch(`${baseUrl}/computers/register`, json({ id: 'w', name: 'w', type: 'workstation' }))).json()) as { token: string };

      await fetch(`${baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'w', request: request('dup') }));
      const lease = (await claimOver(baseUrl, 'w', 'dup', token)).body.token!;
      const outcome = { ok: true, output: 'first', inputTokens: 1, outputTokens: 1, durationMs: 1, leaseToken: lease };
      const historyBefore = state.executions.length;
      const r1 = await fetch(`${baseUrl}/computers/w/executions/dup/result`, json(outcome, token));
      const r2 = await fetch(`${baseUrl}/computers/w/executions/dup/result`, json({ ...outcome, output: 'second' }, token));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(((await r2.json()) as { duplicate?: boolean }).duplicate).toBe(true);
      expect(state.executions.length - historyBefore).toBe(1);
      expect((await state.dispatcher.status('dup'))?.outcome?.output).toBe('first');

      // Worker A claims, stalls past its lease; worker A' (restarted) re-claims and finishes.
      await fetch(`${baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'w', request: request('late') }));
      const stale = (await claimOver(baseUrl, 'w', 'late', token)).body.token!;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const fresh = await claimOver(baseUrl, 'w', 'late', token);
      expect(fresh.status).toBe(200);
      expect(fresh.body.attempt).toBe(2);
      const late = await fetch(`${baseUrl}/computers/w/executions/late/result`,
        json({ ok: true, output: 'stale', inputTokens: 0, outputTokens: 0, durationMs: 1, leaseToken: stale }, token));
      expect(late.status).toBe(409);
      expect(((await late.json()) as { error: string }).error).toBe('LEASE_LOST');
      const win = await fetch(`${baseUrl}/computers/w/executions/late/result`,
        json({ ok: true, output: 'fresh', inputTokens: 0, outputTokens: 0, durationMs: 1, leaseToken: fresh.body.token }, token));
      expect(win.status).toBe(200);
      expect((await state.dispatcher.status('late'))?.outcome?.output).toBe('fresh');
      // A terminal outcome cannot be re-claimed.
      expect((await claimOver(baseUrl, 'w', 'late', token)).status).toBe(409);
    });

    it('duplicate dispatch of the same requestId is refused', async () => {
      const { baseUrl, state } = await start(undefined, false);
      await fetch(`${baseUrl}/computers/register`, json({ id: 'w', name: 'w', type: 'workstation' }));
      expect((await fetch(`${baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'w', request: request('once') }))).status).toBe(202);
      const dup = await fetch(`${baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'w', request: request('once') }));
      expect(dup.status).toBe(429);
      expect(((await dup.json()) as { error: string }).error).toBe('REQUEST_ALREADY_DISPATCHED');
      expect((await state.dispatcher.assignments()).filter((a) => a.id === 'exec-once')).toHaveLength(1);
    });

    it('API restart: a pending dispatch, its lease and the worker credential survive; the outcome commits once', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wazir-api-restart-'));
      try {
        const file = join(dir, 'store.json');
        const first = await start(new JsonFileStore(file), false);
        const { token } = (await (await fetch(`${first.baseUrl}/computers/register`, json({ id: 'w', name: 'w', type: 'workstation' }))).json()) as { token: string };
        await fetch(`${first.baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'w', request: request('survive') }));
        const lease = (await claimOver(first.baseUrl, 'w', 'survive', token)).body.token!;
        await stop(first.server);

        const second = await start(new JsonFileStore(file), false);
        // The lease taken before the restart is still held: nobody else can claim.
        expect((await claimOver(second.baseUrl, 'w', 'survive', token)).status).toBe(409);
        const res = await fetch(`${second.baseUrl}/computers/w/executions/survive/result`,
          json({ ok: true, output: 'done', inputTokens: 1, outputTokens: 1, durationMs: 1, leaseToken: lease }, token));
        expect(res.status).toBe(200);
        const status = (await (await fetch(`${second.baseUrl}/api/v1/tasks/survive/status`)).json()) as { outcome: { output: string } };
        expect(status.outcome.output).toBe('done');
        await stop(second.server);

        const third = new TaskDispatcher(new JsonFileStore(file));
        await third.ready;
        expect(third.totalQueued).toBe(0);
      } finally { await rm(dir, { recursive: true, force: true }); }
    });

    it('a worker restart without its lease token waits for expiry, then re-acquires as a new attempt', async () => {
      let now = 0;
      const dispatcher = new TaskDispatcher(new MemoryStore(), () => now, 1000);
      await dispatcher.dispatch('w', request('wr'));
      const before = await dispatcher.claim('wr', 'w');
      // The worker crashes and restarts: it lost `before.token`.
      await expect(dispatcher.claim('wr', 'w')).rejects.toThrow('RESOURCE_BUSY');
      now = 1001;
      expect(dispatcher.totalQueued).toBe(1);
      const after = await dispatcher.claim('wr', 'w');
      expect(after.attempt).toBe(2);
      expect(await dispatcher.commit('wr', { ok: true, output: 'x', inputTokens: 0, outputTokens: 0, durationMs: 0 }, after.token)).toBe('committed');
      await expect(dispatcher.commit('wr', { ok: true, output: 'y', inputTokens: 0, outputTokens: 0, durationMs: 0 }, before.token)).rejects.toThrow('LEASE_LOST');
    });
  });
});
