import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiState, createApp } from '../src/server.js';
import { Worker, dispatchRemote } from '@wazir/workers';
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
      yield { type: 'token' as const, content: 'remote ' };
      yield { type: 'token' as const, content: 'says ' };
      yield { type: 'completed' as const, content: 'remote says hi', usage: { inputTokens: 4, outputTokens: 3 } };
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

describe('dispatchRemote (the scheduling-side client)', () => {
  let worker: Worker | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await worker?.stop();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    worker = undefined;
    server = undefined;
  });

  it('streams progressive events and resolves with the worker-reported outcome', async () => {
    const started = await startServer();
    server = started.server;

    worker = new Worker({
      computerId: 'wrk-remote',
      name: 'remote-worker',
      serverUrl: started.baseUrl,
      adapters: [fakeAdapter()],
      heartbeatIntervalMs: 60_000,
    });
    await worker.start();
    await delay(150); // let the SSE connection establish

    const request: WorkerExecutionRequest = {
      executionId: 'exec-remote',
      requestId: 'req-remote',
      modelId: 'fake-model',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const generator = dispatchRemote(started.baseUrl, 'wrk-remote', request, { pollIntervalMs: 50 });
    const events: Array<{ type: string }> = [];
    let result = await generator.next();
    while (!result.done) {
      events.push(result.value);
      result = await generator.next();
    }

    expect(events.map((e) => e.type)).toEqual(['started', 'token', 'token', 'completed']);
    expect(result.value.ok).toBe(true);
    expect(result.value.output).toBe('remote says hi');
  });

  it('throws if the target computer is not registered', async () => {
    const started = await startServer();
    server = started.server;

    const request: WorkerExecutionRequest = {
      executionId: 'exec-missing',
      requestId: 'req-missing',
      modelId: 'fake-model',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const drain = async () => {
      for await (const event of dispatchRemote(started.baseUrl, 'no-such-computer', request)) {
        void event; // dispatch should reject before yielding anything
      }
    };

    await expect(drain()).rejects.toThrow(/unknown|not registered|dispatch to/i);
  });

  it('accepts lease_acquired in the server event store but does not emit it through the consumer stream', async () => {
    // Regression: lease_acquired is a control-plane event emitted by TaskDispatcher.claim().
    // It must be preserved server-side for observability/lease-recovery but must never
    // appear in the sequence yielded to dispatchRemote callers (public contract).
    const started = await startServer();
    server = started.server;

    worker = new Worker({
      computerId: 'wrk-lease-regression',
      name: 'lease-regression-worker',
      serverUrl: started.baseUrl,
      adapters: [fakeAdapter()],
      heartbeatIntervalMs: 60_000,
    });
    await worker.start();
    await delay(150);

    const request: WorkerExecutionRequest = {
      executionId: 'exec-lease-regression',
      requestId: 'req-lease-regression',
      modelId: 'fake-model',
      messages: [{ role: 'user', content: 'lease regression test' }],
    };

    const generator = dispatchRemote(started.baseUrl, 'wrk-lease-regression', request, { pollIntervalMs: 50 });
    const events: Array<{ type: string }> = [];
    let result = await generator.next();
    while (!result.done) {
      events.push(result.value);
      result = await generator.next();
    }

    const types = events.map((e) => e.type);

    // Public contract: lease_acquired must NOT appear in the consumer stream.
    expect(types).not.toContain('lease_acquired');
    // lease_renewed is also a control-plane event and must not appear.
    expect(types).not.toContain('lease_renewed');
    // The execution-level events must still all arrive.
    expect(types).toContain('started');
    expect(types).toContain('completed');

    // Server-side store: lease_acquired MUST be present (observability / provenance).
    // We reach directly to the status endpoint to verify the raw server state.
    const statusRes = await fetch(
      `${started.baseUrl}/api/v1/tasks/${encodeURIComponent(request.requestId)}/status`,
    );
    expect(statusRes.ok).toBe(true);
    const status = (await statusRes.json()) as { events: Array<{ type: string }> };
    const serverTypes = status.events.map((e) => e.type);
    expect(serverTypes).toContain('lease_acquired');
  });
});
