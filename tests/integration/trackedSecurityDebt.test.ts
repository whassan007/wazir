import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiState, createApp } from '../../apps/api/src/server.js';
import { shellTool, sandboxStatus } from '@wazir/tools';
import os from 'node:os';

async function startApiServer() {
  const state = await createApiState();
  const app = createApp(state);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { state, server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('Section 15: Tracked Security Debt (Explicit Test Coverage of Known Gaps)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  describe('API Authentication / RBAC Debt', () => {
    /**
     * TRACKED DEBT (narrowed): the control plane now has per-computer bearer
     * tokens on the worker protocol and an optional operator token
     * (`WAZIR_API_TOKEN`) / registration token (`WAZIR_REGISTRATION_TOKEN`).
     * What remains open is that both cluster-level tokens are *optional*: a
     * server started with neither still accepts new registrations and
     * dispatches from anyone (the loopback development default). There is
     * also no RBAC — one operator token grants everything.
     *
     * `apps/api/tests/apiAuth.test.ts` covers the enforced paths; this test
     * pins the still-open default. When the tokens become mandatory, flip
     * these expectations to 401.
    it('RESOLVED: with no cluster tokens configured, new registrations and dispatches require credentials (401)', async () => {
      const started = await startApiServer();
      server = started.server;

      const res = await fetch(`${started.baseUrl}/computers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'unauthenticated-node', name: 'Open Node', type: 'workstation' }),
      });
      expect(res.status).toBe(401);

      const dispatch = await fetch(`${started.baseUrl}/api/v1/tasks/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          computerId: 'local',
          request: {
            executionId: 'exec-no-auth',
            requestId: 'req-no-auth',
            modelId: 'any-model',
            messages: [{ role: 'user', content: 'Arbitrary dispatch' }],
          },
        }),
      });
      expect(dispatch.status).toBe(401);
    });

    it('permits unauthenticated registration when WAZIR_ALLOW_UNAUTHENTICATED=1 is set', async () => {
      const state = await createApiState({ auth: { allowUnauthenticated: true } });
      const app = createApp(state);
      const s: Server = app.listen(0);
      server = s;
      await new Promise<void>((resolve) => s.once('listening', resolve));
      const port = (s.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      const res = await fetch(`${baseUrl}/computers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'open-node', name: 'Open Node', type: 'workstation' }),
      });
      expect(res.status).toBe(200);
      expect(state.computers.get('open-node')).toBeDefined();
    });

    it('RESOLVED (F-3): an existing computer record cannot be overwritten without its token', async () => {
      const started = await startApiServer();
      server = started.server;

      await fetch(`${started.baseUrl}/computers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'victim-node', name: 'Victim', type: 'workstation', hardware: { gpus: [] } }),
      });
      const overwrite = await fetch(`${started.baseUrl}/computers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'victim-node', name: 'Attacker', type: 'workstation' }),
      });
      expect(overwrite.status).toBe(403);
      expect(started.state.computers.get('victim-node')?.name).toBe('Victim');
    });
  });

  describe('Container Sandboxing Debt', () => {
    /**
     * TRACKED DEBT: Tools execute directly within the host process and host namespace.
     * There is no container/sandbox boundary (Docker/gVisor/firecracker) isolating tool runs.
     *
     * This test documents that bash tools see the host PID and host environment directly.
     * Reference: PROGRESS.md "Open work: Container Sandboxing".
     */
    it('F-27: tool results always state which OS sandbox (if any) they ran under', async () => {
      // `packages/tools/src/sandbox.ts` wraps tool processes in bwrap /
      // sandbox-exec when the host allows it and reports `none` otherwise
      // (see `packages/tools/tests/sandbox.test.ts` for enforcement checks).
      // What remains tracked debt: `none` is a permitted fallback, so on a
      // host without user namespaces tools still run directly on the host.
      const result = await shellTool.execute(
        { command: 'echo HOST_PID=$$; uname -s' },
        { projectRoot: os.tmpdir(), taskId: 'test-sandboxing', executionId: 'test-sandboxing' } as any,
      );

      expect(result.ok).toBe(true);
      expect(result.output).toContain('HOST_PID=');
      expect(['bwrap', 'sandbox-exec', 'none']).toContain(result.metadata?.sandbox);
      expect(result.metadata?.sandbox).toBe(sandboxStatus().mode);
    });
  });

  describe('Observability: Prometheus Metrics Endpoint (F-28)', () => {
    it('RESOLVED (F-28): /metrics exports Prometheus formatted metrics', async () => {
      const started = await startApiServer();
      server = started.server;

      const res = await fetch(`${started.baseUrl}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const text = await res.text();
      expect(text).toContain('wazir_auth_failures_total');
      expect(text).toContain('wazir_dispatch_queue_depth');
      expect(text).toContain('wazir_registered_computers');
    });
  });
});
