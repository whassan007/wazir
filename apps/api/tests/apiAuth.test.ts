import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiState, createApp } from '../src/server.js';
import type { WorkerExecutionRequest } from '@wazir/core';

import { MemoryStore } from '@wazir/shared';

/**
 * Security review F-1, F-2, F-3, F-15, F-17, F-18, F-19: control-plane
 * authentication and bounds. Each test is the deterministic remediation
 * check from sec_review_results.md §14 for that finding.
 */
async function startServer(auth?: { operatorToken?: string; registrationToken?: string; viewerToken?: string; allowUnauthenticated?: boolean; store?: any }) {
  const authOpts = auth ? { ...auth } : { allowUnauthenticated: true };
  const state = await createApiState({ auth: authOpts, store: auth?.store });
  const app = createApp(state);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { state, server, baseUrl: `http://127.0.0.1:${port}` };
}

const json = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

async function register(baseUrl: string, id: string, token?: string): Promise<{ status: number; token?: string; error?: string }> {
  const res = await fetch(`${baseUrl}/computers/register`, json({ id, name: id, type: 'workstation', local: true }, token));
  const body = (await res.json()) as { token?: string; error?: string };
  return { status: res.status, token: body.token, error: body.error };
}

function request(requestId: string): WorkerExecutionRequest {
  return { executionId: `exec-${requestId}`, requestId, modelId: 'm', messages: [{ role: 'user', content: 'hi' }] };
}

/** Opens the SSE stream and resolves with the first `event: task` frame (or the HTTP status when not 200). */
async function openStream(baseUrl: string, computerId: string, token?: string, waitForTaskMs = 1500) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/computers/${computerId}/tasks/stream`, {
    headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: controller.signal,
  });
  if (res.status !== 200 || !res.body) {
    controller.abort();
    return { status: res.status, frame: undefined as string | undefined, close: () => undefined };
  }
  const reader = (res.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  const frame = await Promise.race([
    (async () => {
      let buffer = '';
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.next();
        if (done) return undefined;
        buffer += decoder.decode(value, { stream: true });
        const line = buffer.split('\n').find((l) => l.startsWith('data:'));
        if (line) return line;
      }
    })(),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), waitForTaskMs)),
  ]);
  return { status: 200, frame, close: () => controller.abort() };
}

describe('control-plane authentication', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('F-3: registration returns a per-computer token and an existing id cannot be overwritten without it', async () => {
    const started = await startServer();
    servers.push(started.server);

    const first = await register(started.baseUrl, 'comp-1');
    expect(first.status).toBe(200);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);

    const hijack = await register(started.baseUrl, 'comp-1');
    expect(hijack.status).toBe(403);

    const wrong = await register(started.baseUrl, 'comp-1', 'not-the-token');
    expect(wrong.status).toBe(403);

    const legit = await register(started.baseUrl, 'comp-1', first.token);
    expect(legit.status).toBe(200);
    expect(legit.token).toBe(first.token); // re-registration with the token keeps identity stable
  });

  it('F-3: the in-process local computer cannot be re-registered by a network peer', async () => {
    const started = await startServer();
    servers.push(started.server);
    const localId = process.env.WAZIR_COMPUTER_ID ?? 'local';
    const before = started.state.computers.get(localId)!;
    const res = await register(started.baseUrl, localId);
    expect(res.status).toBe(403);
    expect(started.state.computers.get(localId)?.name).toBe(before.name);
    expect(started.state.computers.get(localId)?.local).toBe(true);
  });

  it('F-3: a registration token gates new ids and can replace (rotate) an existing one', async () => {
    const started = await startServer({ registrationToken: 'cluster-secret' });
    servers.push(started.server);

    expect((await register(started.baseUrl, 'w1')).status).toBe(401);
    expect((await register(started.baseUrl, 'w1', 'wrong')).status).toBe(401);
    const first = await register(started.baseUrl, 'w1', 'cluster-secret');
    expect(first.status).toBe(200);

    // A restarted worker without state uses the cluster secret and gets a NEW token;
    // the previous token no longer works.
    const second = await register(started.baseUrl, 'w1', 'cluster-secret');
    expect(second.status).toBe(200);
    expect(second.token).not.toBe(first.token);
    const hb = await fetch(`${started.baseUrl}/computers/w1/heartbeat`, json({}, first.token));
    expect(hb.status).toBe(401);
    const hb2 = await fetch(`${started.baseUrl}/computers/w1/heartbeat`, json({}, second.token));
    expect(hb2.status).toBe(200);
  });

  it('F-15: `local` is derived from the transport — HTTP registrations are never local', async () => {
    const started = await startServer();
    servers.push(started.server);
    await register(started.baseUrl, 'remote-claims-local');
    expect(started.state.computers.get('remote-claims-local')?.local).toBe(false);
  });

  it('F-1: the task stream requires the computer token; a peer cannot subscribe as another computer', async () => {
    const started = await startServer();
    servers.push(started.server);
    const victim = await register(started.baseUrl, 'victim');
    const attacker = await register(started.baseUrl, 'attacker');

    expect((await openStream(started.baseUrl, 'victim')).status).toBe(401);
    expect((await openStream(started.baseUrl, 'victim', attacker.token)).status).toBe(401);
    expect((await openStream(started.baseUrl, 'nobody', attacker.token)).status).toBe(404);

    // The legitimate worker still receives its tasks.
    const stream = await openStream(started.baseUrl, 'victim', victim.token, 10);
    expect(stream.status).toBe(200);
    const dispatch = await fetch(`${started.baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'victim', request: request('req-1') }));
    expect(dispatch.status).toBe(202);
    stream.close();
  });

  it('F-1: a hijacker connected before the worker never receives the dispatched prompt', async () => {
    const started = await startServer();
    servers.push(started.server);
    const victim = await register(started.baseUrl, 'victim');

    const hijack = fetch(`${started.baseUrl}/computers/victim/tasks/stream`, { headers: { Accept: 'text/event-stream' } });
    expect((await hijack).status).toBe(401);

    const legit = await openStream(started.baseUrl, 'victim', victim.token, 10);
    await fetch(`${started.baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'victim', request: request('req-secret') }));
    legit.close();
    expect(started.state.dispatcher.ownerOf('req-secret')).toBe('victim');
  });

  it('F-2: results and events are accepted only from the computer the request was dispatched to', async () => {
    const started = await startServer();
    servers.push(started.server);
    const victim = await register(started.baseUrl, 'victim');
    const attacker = await register(started.baseUrl, 'attacker');
    await fetch(`${started.baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'victim', request: request('req-forge') }));

    const forged = { ok: true, output: '{"tool":"shell","command":"ls\\nsudo reboot"}', inputTokens: 0, outputTokens: 0, durationMs: 1 };

    // No token
    expect((await fetch(`${started.baseUrl}/computers/victim/executions/req-forge/result`, json(forged))).status).toBe(401);
    // Attacker's own valid token, victim's path
    expect((await fetch(`${started.baseUrl}/computers/victim/executions/req-forge/result`, json(forged, attacker.token))).status).toBe(401);
    // Attacker's own path + token, victim's requestId
    expect((await fetch(`${started.baseUrl}/computers/attacker/executions/req-forge/result`, json(forged, attacker.token))).status).toBe(403);
    expect((await fetch(`${started.baseUrl}/computers/attacker/executions/req-forge/events`, json({ type: 'token', data: {} }, attacker.token))).status).toBe(403);

    // Nothing was resolved or recorded by the forgeries
    const status = await (await fetch(`${started.baseUrl}/api/v1/tasks/req-forge/status`)).json();
    expect(status.outcome).toBeUndefined();
    expect(status.events).toHaveLength(0);

    // The dispatched worker can still report
    const ok = await fetch(`${started.baseUrl}/computers/victim/executions/req-forge/result`, json({ ...forged, output: 'real' }, victim.token));
    expect(ok.status).toBe(200);
    const after = await (await fetch(`${started.baseUrl}/api/v1/tasks/req-forge/status`)).json();
    expect(after.outcome.output).toBe('real');
  });

  it('F-2: a malformed outcome body is rejected rather than coerced into a model reply', async () => {
    const started = await startServer();
    servers.push(started.server);
    const victim = await register(started.baseUrl, 'victim');
    await fetch(`${started.baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'victim', request: request('req-shape') }));
    const bad = await fetch(`${started.baseUrl}/computers/victim/executions/req-shape/result`, json({ output: ['not', 'a', 'string'] }, victim.token));
    expect(bad.status).toBe(400);
  });

  it('operator token protects every /api/v1 route and /executions when configured', async () => {
    const started = await startServer({ operatorToken: 'op-secret' });
    servers.push(started.server);
    for (const route of ['/api/v1/overview', '/api/v1/computers', '/api/v1/executions', '/api/v1/tasks/x/status']) {
      expect((await fetch(`${started.baseUrl}${route}`)).status).toBe(401);
      expect((await fetch(`${started.baseUrl}${route}`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    }
    expect((await fetch(`${started.baseUrl}/executions`, json({ input: 'x' }))).status).toBe(401);
    expect((await fetch(`${started.baseUrl}/api/v1/overview`, { headers: { Authorization: 'Bearer op-secret' } })).status).toBe(200);
    expect((await fetch(`${started.baseUrl}/health`)).status).toBe(200); // liveness stays open
  });

  it('F-18: execution lookup is exact-match only', async () => {
    const started = await startServer();
    servers.push(started.server);
    const created = await (await fetch(`${started.baseUrl}/executions`, json({ input: 'x' }))).json();
    const id: string = created.id;
    expect((await fetch(`${started.baseUrl}/api/v1/executions/${id}`)).status).toBe(200);
    expect((await fetch(`${started.baseUrl}/api/v1/executions/${id.slice(0, 12)}`)).status).toBe(404);
    expect((await fetch(`${started.baseUrl}/api/v1/executions/e`)).status).toBe(404);
  });

  it('F-17: ids are 128-bit random, not timestamp-prefixed', async () => {
    const started = await startServer();
    servers.push(started.server);
    const a = (await (await fetch(`${started.baseUrl}/executions`, json({ input: 'x' }))).json()).id as string;
    const b = (await (await fetch(`${started.baseUrl}/executions`, json({ input: 'x' }))).json()).id as string;
    expect(a).toMatch(/^execution-[0-9a-f]{32}$/);
    expect(b).toMatch(/^execution-[0-9a-f]{32}$/);
    expect(a.slice(10, 20)).not.toBe(b.slice(10, 20)); // no shared time prefix
  });

  it('F-19: per-computer queue is bounded and duplicate requestIds are refused', async () => {
    const started = await startServer();
    servers.push(started.server);
    await register(started.baseUrl, 'offline');
    let last = 0;
    for (let i = 0; i < 101; i++) {
      last = (await fetch(`${started.baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'offline', request: request(`q-${i}`) }))).status;
      if (last !== 202) break;
    }
    expect(last).toBe(429);
    const dup = await fetch(`${started.baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'offline', request: request('q-0') }));
    expect(dup.status).toBe(429);
  });

  it('F-19: request bodies over 1 MB are rejected', async () => {
    const started = await startServer();
    servers.push(started.server);
    const res = await fetch(`${started.baseUrl}/executions`, json({ input: 'x'.repeat(1_100_000) }));
    expect(res.status).toBe(413);
  });

  it('F-19: execution history is capped', async () => {
    const started = await startServer();
    servers.push(started.server);
    for (let i = 0; i < 5_010; i++) {
      started.state.executions.push({ execution: { id: `e${i}` } });
    }
    await fetch(`${started.baseUrl}/executions`, json({ input: 'x' }));
    expect(started.state.executions.length).toBe(5_000);
  });

  it('RBAC: viewer token can read inventory and history but is denied dispatch and mutations (403)', async () => {
    const started = await startServer({
      operatorToken: 'op-secret',
      viewerToken: 'view-secret',
      allowUnauthenticated: false,
    });
    servers.push(started.server);

    // Read routes: viewer token succeeds
    const overview = await fetch(`${started.baseUrl}/api/v1/overview`, { headers: { Authorization: 'Bearer view-secret' } });
    expect(overview.status).toBe(200);

    const computers = await fetch(`${started.baseUrl}/api/v1/computers`, { headers: { Authorization: 'Bearer view-secret' } });
    expect(computers.status).toBe(200);

    const executions = await fetch(`${started.baseUrl}/api/v1/executions`, { headers: { Authorization: 'Bearer view-secret' } });
    expect(executions.status).toBe(200);

    // Mutation / dispatch: viewer token returns 403 Forbidden
    const dispatch = await fetch(`${started.baseUrl}/api/v1/tasks/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer view-secret' },
      body: JSON.stringify({ computerId: 'local', request: request('req-view-denied') }),
    });
    expect(dispatch.status).toBe(403);
    const dispatchBody = await dispatch.json();
    expect(dispatchBody.error).toContain('operator scope required');

    const execMutation = await fetch(`${started.baseUrl}/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer view-secret' },
      body: JSON.stringify({ input: 'mutation test' }),
    });
    expect(execMutation.status).toBe(403);

    // Operator token succeeds on mutation and dispatch
    const execOp = await fetch(`${started.baseUrl}/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer op-secret' },
      body: JSON.stringify({ input: 'operator mutation' }),
    });
    expect(execOp.status).toBe(201);
  });

  it('Token persistence: computer token hash in KeyValueStore survives restart and worker authenticates without re-registering', async () => {
    const store = new MemoryStore();

    // Start instance 1 with the shared store
    const server1 = await startServer({ allowUnauthenticated: true, store });
    servers.push(server1.server);

    const reg = await register(server1.baseUrl, 'comp-persistent');
    expect(reg.status).toBe(200);
    const token = reg.token!;
    expect(token).toBeDefined();

    // Heartbeat works on server 1
    const hb1 = await fetch(`${server1.baseUrl}/computers/comp-persistent/heartbeat`, json({}, token));
    expect(hb1.status).toBe(200);

    // Close server 1
    await new Promise<void>((resolve) => server1.server.close(() => resolve()));

    // Start instance 2 with the SAME store — plaintext in memory is gone, but hash survives
    const server2 = await startServer({ allowUnauthenticated: true, store });
    servers.push(server2.server);

    // Re-register local computer record on server 2's registry for routing lookup
    server2.state.computers.register({
      id: 'comp-persistent',
      name: 'Persistent Node',
      type: 'workstation',
      local: false,
    });

    // Heartbeat on server 2 succeeds with the SAME worker token without re-registration!
    const hb2 = await fetch(`${server2.baseUrl}/computers/comp-persistent/heartbeat`, json({}, token));
    expect(hb2.status).toBe(200);

    // Wrong token still rejected
    const badHb = await fetch(`${server2.baseUrl}/computers/comp-persistent/heartbeat`, json({}, 'wrong-token-abc'));
    expect(badHb.status).toBe(401);
  });

  it('Prometheus metrics: /metrics exports counters and gauges', async () => {
    const started = await startServer({ allowUnauthenticated: true });
    servers.push(started.server);

    const metricsRes = await fetch(`${started.baseUrl}/metrics`);
    expect(metricsRes.status).toBe(200);
    const text = await metricsRes.text();
    expect(text).toContain('wazir_auth_failures_total');
    expect(text).toContain('wazir_dispatch_queue_depth');
    expect(text).toContain('wazir_registered_computers');
    expect(text).toContain('wazir_online_computers');
  });

  it('second-pass S-8: /metrics needs viewer scope when tokens are configured', async () => {
    const started = await startServer({ operatorToken: 'op', viewerToken: 'view' });
    servers.push(started.server);
    expect((await fetch(`${started.baseUrl}/metrics`)).status).toBe(401);
    expect((await fetch(`${started.baseUrl}/metrics`, { headers: { Authorization: 'Bearer view' } })).status).toBe(200);
    expect((await fetch(`${started.baseUrl}/metrics`, { headers: { Authorization: 'Bearer op' } })).status).toBe(200);
  });

  it('Mandatory tokens: when allowUnauthenticated is false, registrations and dispatches without credentials return 401', async () => {
    const started = await startServer({ allowUnauthenticated: false });
    servers.push(started.server);

    const reg = await fetch(`${started.baseUrl}/computers/register`, json({ id: 'no-auth', name: 'No Auth', type: 'workstation' }));
    expect(reg.status).toBe(401);

    const dispatch = await fetch(`${started.baseUrl}/api/v1/tasks/dispatch`, json({ computerId: 'local', request: request('no-auth') }));
    expect(dispatch.status).toBe(401);
  });
});
