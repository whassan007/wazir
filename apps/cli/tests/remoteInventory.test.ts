import { describe, it, expect, afterEach } from 'vitest';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ComputerRegistry, RuntimeRegistry, ModelRegistry } from '@wazir/core';
import { syncRemoteInventory } from '../src/remoteInventory.js';

/**
 * A minimal stand-in for `apps/api`'s inventory endpoints, serving canned
 * fixtures at the exact routes/response shapes `syncRemoteInventory` expects
 * (`{computers}`, `{runtimes}`, `{models}`, `{instances}`). Deliberately not
 * the real `apps/api` server — this is a contract test against the wire
 * shape, kept independent of apps/cli reaching into another app's internals.
 */
function startFakeApi(routes: Record<string, unknown>): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    const body = routes[req.url ?? ''];
    if (body === undefined) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('syncRemoteInventory', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
  });

  it("pulls remote computers/runtimes/models/instances into local registries, skipping the caller's own id", async () => {
    const started = await startFakeApi({
      '/api/v1/computers': {
        computers: [
          {
            id: 'dgx-1',
            name: 'DGX Primary',
            type: 'workstation',
            local: true, // true from the *remote* API's own point of view
            os: { platform: 'linux', arch: 'x64', release: '6.0' },
            hardware: { cpu: 'x86_64', cores: 64, ramGB: 512 },
          },
        ],
      },
      '/api/v1/runtimes': {
        runtimes: [
          {
            id: 'ollama',
            type: 'ollama',
            name: 'Ollama',
            version: '0.1.0',
            computerId: 'dgx-1',
            capabilities: {
              chat: true,
              streaming: true,
              toolCalling: true,
              structuredOutput: false,
              vision: false,
              embeddings: false,
              reasoning: false,
              modelLoad: false,
              modelUnload: false,
              modelDownload: false,
              statefulChat: false,
              mcp: false,
            },
          },
        ],
      },
      '/api/v1/models': {
        models: [
          {
            id: 'qwen3-coder',
            name: 'qwen3-coder',
            provider: 'ollama',
            family: 'qwen',
            contextMax: 131072,
            capabilities: ['generalChat', 'coding'],
            toolCalling: true,
            structuredOutput: false,
            vision: false,
            audio: false,
            embedding: false,
            reasoning: false,
            runtimeCompatibility: ['ollama'],
            local: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      '/api/v1/model-instances': {
        instances: [
          {
            id: 'qwen3-coder::dgx-1::ollama',
            modelId: 'qwen3-coder',
            computerId: 'dgx-1',
            runtimeId: 'ollama',
            runtimeModelId: 'qwen3-coder',
            loaded: true,
            health: 'healthy',
            contextTokens: 131072,
          },
        ],
      },
    });
    server = started.server;

    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();

    const result = await syncRemoteInventory(started.baseUrl, 'my-laptop', { computers, runtimes, models });

    expect(result.errors).toEqual([]);
    expect(result.computers).toBe(1);
    expect(result.runtimes).toBe(1);
    expect(result.models).toBe(1);
    expect(result.instances).toBe(1);

    const synced = computers.get('dgx-1');
    expect(synced).toBeDefined();
    expect(synced?.local).toBe(false); // never trust a remote's own "local" flag

    expect(runtimes.get('ollama')?.computerId).toBe('dgx-1');
    expect(models.get('qwen3-coder')).toBeDefined();
    expect(models.instancesOf('qwen3-coder').some((i) => i.computerId === 'dgx-1')).toBe(true);
  });

  it("never lets a remote snapshot of the caller's own id overwrite the live local entry", async () => {
    const started = await startFakeApi({
      '/api/v1/computers': {
        // The remote API's own local computer defaults to id 'local' (the
        // same default this CLI's own worker would use) unless
        // WAZIR_COMPUTER_ID is set — exactly the collision this must guard.
        computers: [
          {
            id: 'local',
            name: 'the remote machine, calling itself "local"',
            type: 'workstation',
            local: true,
            os: { platform: 'linux', arch: 'x64', release: '6.0' },
            hardware: { cpu: 'x86_64', cores: 8, ramGB: 32 },
          },
        ],
      },
      '/api/v1/runtimes': { runtimes: [] },
      '/api/v1/models': { models: [] },
      '/api/v1/model-instances': { instances: [] },
    });
    server = started.server;

    const computers = new ComputerRegistry();
    computers.register({
      id: 'local',
      name: 'my actual laptop',
      type: 'laptop',
      local: true,
      os: { platform: 'darwin', arch: 'arm64', release: '23.0' },
      hardware: { cpu: 'Apple M3', cores: 12, ramGB: 36 },
    });
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();

    const result = await syncRemoteInventory(started.baseUrl, 'local', { computers, runtimes, models });

    expect(result.computers).toBe(0); // skipped, not merged
    const own = computers.get('local');
    expect(own?.name).toBe('my actual laptop');
    expect(own?.local).toBe(true);
  });

  it('collects fetch failures as warnings instead of throwing when the API is unreachable', async () => {
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();

    // Port 1 is a reserved/privileged port nothing will be listening on.
    const result = await syncRemoteInventory('http://127.0.0.1:1', 'local', { computers, runtimes, models });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.computers).toBe(0);
    expect(result.runtimes).toBe(0);
    expect(result.models).toBe(0);
  });
});
