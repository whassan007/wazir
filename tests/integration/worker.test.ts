import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker } from '@wazir/workers';
import { ComputerRegistry, type WorkerExecutionRequest } from '@wazir/core';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import { createApiState, createApp } from '../../apps/api/src/server.js';

function createMockAdapter(id: string, modelName: string): RuntimeAdapter {
  return {
    id,
    type: 'other',
    async discover() {
      return { id, name: id, version: '1.0' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async listModels() {
      return [{ id: modelName, name: modelName }];
    },
    async getCapabilities() {
      return {
        chat: true,
        streaming: true,
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        embeddings: false,
        reasoning: false,
        modelLoad: false,
        modelUnload: false,
        modelDownload: false,
        statefulChat: false,
        mcp: false,
      };
    },
    async *generate() {
      yield { type: 'token' as const, content: `processed by ${id}` };
      yield { type: 'completed' as const, content: `done by ${id}`, usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };
}

async function startServer() {
  const state = await createApiState({ auth: { allowUnauthenticated: true } });
  const app = createApp(state);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { state, server, baseUrl: `http://127.0.0.1:${port}` };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Section 9: Worker & Distributed Dispatch Suite', () => {
  const workersToStop: Worker[] = [];
  const serversToClose: Server[] = [];

  afterEach(async () => {
    while (workersToStop.length > 0) {
      const w = workersToStop.pop();
      await w?.stop();
    }
    while (serversToClose.length > 0) {
      const s = serversToClose.pop();
      await new Promise<void>((resolve) => s?.close(() => resolve()));
    }
  });

  describe('Worker Registration & Control Plane Discovery', () => {
    it('worker starts, discovers hardware/runtimes/models, and registers with control plane', async () => {
      const { state, server, baseUrl } = await startServer();
      serversToClose.push(server);

      const worker = new Worker({
        computerId: 'comp-reg-test',
        name: 'Worker Reg Test',
        serverUrl: baseUrl,
        adapters: [createMockAdapter('test-rt', 'test-model:latest')],
        heartbeatIntervalMs: 60_000,
      });
      workersToStop.push(worker);

      const info = await worker.start();
      expect(info.status).toBe('online');
      expect(info.runtimes).toContain('test-rt');
      expect(info.models).toContain('test-model:latest');

      const registered = state.computers.get('comp-reg-test');
      expect(registered).toBeDefined();
      expect(registered?.name).toBe('Worker Reg Test');
      expect(registered?.runtimes).toContain('test-rt');
      expect(registered?.models).toContain('test-model:latest');
      expect(registered?.status).toBe('online');
    });

    it('worker restart re-registers without duplicating itself in ComputerRegistry', async () => {
      const registry = new ComputerRegistry();

      // First boot
      registry.register({
        id: 'comp-reboot',
        name: 'Node Alpha',
        type: 'workstation',
        local: true,
        runtimes: ['rt-1'],
        models: ['model-1'],
      });

      expect(registry.list()).toHaveLength(1);
      const firstCreatedAt = registry.get('comp-reboot')?.createdAt;

      // Simulate delay then reboot with identical computerId
      await delay(10);
      registry.register({
        id: 'comp-reboot',
        name: 'Node Alpha Renamed',
        type: 'workstation',
        local: true,
        runtimes: ['rt-1', 'rt-2'],
        models: ['model-1', 'model-2'],
      });

      // Must NOT duplicate! Still exactly 1 computer in registry
      const all = registry.list();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('comp-reboot');
      expect(all[0].name).toBe('Node Alpha Renamed');
      expect(all[0].runtimes).toEqual(['rt-1', 'rt-2']);
      expect(all[0].createdAt.getTime()).toBe(firstCreatedAt?.getTime());
    });
  });

  describe('SSE Stream Dispatch & Queuing', () => {
    it('dispatches task to already-connected worker with immediate execution and delivery', async () => {
      const { server, baseUrl } = await startServer();
      serversToClose.push(server);

      const worker = new Worker({
        computerId: 'comp-connected',
        name: 'Connected Worker',
        serverUrl: baseUrl,
        adapters: [createMockAdapter('rt-live', 'model-live')],
        heartbeatIntervalMs: 60_000,
      });
      workersToStop.push(worker);

      await worker.start();
      await delay(100);

      const request: WorkerExecutionRequest = {
        executionId: 'exec-connected',
        requestId: 'req-connected',
        modelId: 'model-live',
        messages: [{ role: 'user', content: 'Ping live' }],
      };

      const response = await fetch(`${baseUrl}/api/v1/tasks/dispatch?wait=5000`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerId: 'comp-connected', request }),
      });

      const body = (await response.json()) as any;
      expect(response.status).toBe(200);
      expect(body.outcome.ok).toBe(true);
      expect(body.outcome.output).toContain('done by rt-live');
    });

    it('queues task dispatched while worker is not connected and delivers immediately upon connect', async () => {
      const { server, baseUrl } = await startServer();
      serversToClose.push(server);

      // Register computer first so dispatch target exists
      const registerRes = await fetch(`${baseUrl}/computers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'comp-queue', name: 'Queued Target', type: 'workstation', local: true }),
      });
      // Registration mints the computer's bearer token; the worker below must
      // present it to re-register as the same identity (F-3).
      const { token: queuedToken } = (await registerRes.json()) as { token: string };

      const request: WorkerExecutionRequest = {
        executionId: 'exec-queue',
        requestId: 'req-queue',
        modelId: 'model-queued',
        messages: [{ role: 'user', content: 'Run queued' }],
      };

      // Dispatch before worker is started
      const dispatchRes = await fetch(`${baseUrl}/api/v1/tasks/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerId: 'comp-queue', request }),
      });
      const dispatchBody = (await dispatchRes.json()) as any;
      expect(dispatchRes.status).toBe(202);
      expect(dispatchBody.connected).toBe(false);

      // Now start the worker; it establishes SSE connection and pulls queued task
      const worker = new Worker({
        computerId: 'comp-queue',
        name: 'Queued Worker',
        serverUrl: baseUrl,
        adapters: [createMockAdapter('rt-q', 'model-queued')],
        heartbeatIntervalMs: 60_000,
        token: queuedToken,
      });
      workersToStop.push(worker);
      await worker.start();

      let status: { outcome?: { ok: boolean; output: string } } = {};
      for (let i = 0; i < 50; i++) {
        const res = await fetch(`${baseUrl}/api/v1/tasks/req-queue/status`);
        status = (await res.json()) as any;
        if (status.outcome) break;
        await delay(100);
      }

      expect(status.outcome?.ok).toBe(true);
      expect(status.outcome?.output).toContain('done by rt-q');
    });

    it('routes tasks cleanly to distinct workers without cross-talk in multi-computer setup', async () => {
      const { server, baseUrl } = await startServer();
      serversToClose.push(server);

      const workerA = new Worker({
        computerId: 'comp-alpha',
        name: 'Worker Alpha',
        serverUrl: baseUrl,
        adapters: [createMockAdapter('rt-alpha', 'model-alpha')],
        heartbeatIntervalMs: 60_000,
      });
      const workerB = new Worker({
        computerId: 'comp-beta',
        name: 'Worker Beta',
        serverUrl: baseUrl,
        adapters: [createMockAdapter('rt-beta', 'model-beta')],
        heartbeatIntervalMs: 60_000,
      });
      workersToStop.push(workerA, workerB);

      await workerA.start();
      await workerB.start();
      await delay(100);

      // Dispatch task specifically to comp-beta
      const reqB: WorkerExecutionRequest = {
        executionId: 'exec-b',
        requestId: 'req-b',
        modelId: 'model-beta',
        messages: [{ role: 'user', content: 'Target Beta' }],
      };

      const resB = await fetch(`${baseUrl}/api/v1/tasks/dispatch?wait=5000`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerId: 'comp-beta', request: reqB }),
      });
      const bodyB = (await resB.json()) as any;
      expect(bodyB.outcome?.output).toContain('done by rt-beta');
      expect(bodyB.outcome?.output).not.toContain('done by rt-alpha');
    });
  });

  describe('Deterministic Stale/Offline Detection Thresholds', () => {
    it('transitions through healthy -> stale (degraded) -> offline (unavailable) deterministically', () => {
      const registry = new ComputerRegistry();
      const comp = registry.register({
        id: 'comp-thresholds',
        name: 'Threshold Node',
        type: 'workstation',
      });

      expect(comp.status).toBe('online');
      expect(comp.health).toBe('healthy');

      // 1. Initial check: heartbeat is fresh
      let sweep = registry.checkHeartbeats({ staleMs: 100, offlineMs: 300 });
      expect(sweep.healthy).toContain('comp-thresholds');
      expect(registry.get('comp-thresholds')?.health).toBe('healthy');

      // 2. Age heartbeat past staleMs (150ms ago)
      comp.lastHeartbeat = new Date(Date.now() - 150);
      sweep = registry.checkHeartbeats({ staleMs: 100, offlineMs: 300 });
      expect(sweep.stale).toContain('comp-thresholds');
      expect(registry.get('comp-thresholds')?.status).toBe('online');
      expect(registry.get('comp-thresholds')?.health).toBe('degraded');

      // 3. Age heartbeat past offlineMs (350ms ago)
      comp.lastHeartbeat = new Date(Date.now() - 350);
      sweep = registry.checkHeartbeats({ staleMs: 100, offlineMs: 300 });
      expect(sweep.offline).toContain('comp-thresholds');
      expect(registry.get('comp-thresholds')?.status).toBe('offline');
      expect(registry.get('comp-thresholds')?.health).toBe('unavailable');

      // 4. Heartbeat received -> recovers to online / healthy
      registry.heartbeat('comp-thresholds');
      sweep = registry.checkHeartbeats({ staleMs: 100, offlineMs: 300 });
      expect(sweep.healthy).toContain('comp-thresholds');
      expect(registry.get('comp-thresholds')?.status).toBe('online');
      expect(registry.get('comp-thresholds')?.health).toBe('healthy');
    });
  });
});
