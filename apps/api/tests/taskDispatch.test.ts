import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiState, createApp } from '../src/server.js';
import { Worker } from '@wazir/workers';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { WorkerExecutionRequest } from '@wazir/core';

function fakeAdapter(): RuntimeAdapter {
  return {
    id: 'fake',
    type: 'other',
    async discover() {
      return { id: 'fake', name: 'fake', version: '1.0' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async listModels() {
      return [{ id: 'fake-model', name: 'fake-model' }];
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
      yield { type: 'token' as const, content: 'hello ' };
      yield { type: 'completed' as const, content: 'hello world', usage: { inputTokens: 3, outputTokens: 2 } };
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

describe('worker task dispatch loop', () => {
  let worker: Worker | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await worker?.stop();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    worker = undefined;
    server = undefined;
  });

  it('delivers a task over an already-connected SSE stream and returns the outcome', async () => {
    const started = await startServer();
    server = started.server;

    worker = new Worker({
      computerId: 'wrk-live',
      name: 'live-worker',
      serverUrl: started.baseUrl,
      adapters: [fakeAdapter()],
      heartbeatIntervalMs: 60_000,
    });
    await worker.start();
    await delay(150); // let the SSE connection establish before dispatching

    const request: WorkerExecutionRequest = {
      executionId: 'exec-live',
      requestId: 'req-live',
      modelId: 'fake-model',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const response = await fetch(`${started.baseUrl}/api/v1/tasks/dispatch?wait=5000`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ computerId: 'wrk-live', request }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.outcome.ok).toBe(true);
    expect(body.outcome.output).toContain('hello world');
    expect(started.state.executions.some((e) => (e.execution as { id?: string })?.id === 'req-live')).toBe(true);
  });

  it('queues a task dispatched before the worker connects, then delivers it on connect', async () => {
    const started = await startServer();
    server = started.server;

    worker = new Worker({
      computerId: 'wrk-queued',
      name: 'queued-worker',
      serverUrl: started.baseUrl,
      adapters: [fakeAdapter()],
      heartbeatIntervalMs: 60_000,
    });

    // Register the computer first (normally done by worker.start()) so the
    // dispatch target exists, but dispatch BEFORE the worker opens its stream.
    // The registration mints the computer's bearer token; hand it to the
    // worker so its own start() re-registers as the same identity.
    const registerRes = await fetch(`${started.baseUrl}/computers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'wrk-queued', name: 'queued-worker', type: 'workstation', local: true }),
    });
    const { token } = (await registerRes.json()) as { token: string };
    worker = new Worker({
      computerId: 'wrk-queued',
      name: 'queued-worker',
      serverUrl: started.baseUrl,
      adapters: [fakeAdapter()],
      heartbeatIntervalMs: 60_000,
      token,
    });

    const request: WorkerExecutionRequest = {
      executionId: 'exec-queued',
      requestId: 'req-queued',
      modelId: 'fake-model',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const dispatchRes = await fetch(`${started.baseUrl}/api/v1/tasks/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ computerId: 'wrk-queued', request }),
    });
    const dispatchBody = await dispatchRes.json();
    expect(dispatchRes.status).toBe(202);
    expect(dispatchBody.connected).toBe(false); // no worker connected yet: this proves the queuing path, not live delivery

    await worker.start(); // registers again (idempotent) and connects the task stream

    let status: { outcome?: { ok: boolean; output: string } } = {};
    for (let i = 0; i < 50; i++) {
      const statusRes = await fetch(`${started.baseUrl}/api/v1/tasks/req-queued/status`);
      status = await statusRes.json();
      if (status.outcome) break;
      await delay(100);
    }

    expect(status.outcome?.ok).toBe(true);
    expect(status.outcome?.output).toContain('hello world');
  });
});
