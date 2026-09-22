import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputerRegistry, ModelRegistry, PolicyEngine, RuntimeRegistry } from '@wazir/core';
import { createSecretBroker } from '@wazir/secrets';
import { createHostedProviders } from '../src/hostedProviders.js';
import { authLoginCommand } from '../src/auth.js';
import type { RookEngine } from '../src/engine.js';

const TEST_SECRET = 'sk-ant-super-secret-test-marker-zzz999';

async function makeEngine(): Promise<RookEngine> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-authlogin-'));
  const secretBroker = await createSecretBroker({ secretsDir: dir });
  const config = { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] };
  const hostedAdapters = createHostedProviders(config as any, secretBroker);
  return {
    config,
    runtimes: new RuntimeRegistry(),
    models: new ModelRegistry(),
    computers: new ComputerRegistry(),
    policy: new PolicyEngine({ projectRoot: dir }),
    secretBroker,
    hostedAdapters,
  } as unknown as RookEngine;
}

describe('authLoginCommand', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('#11 the API key never appears in console output or the returned result', async () => {
    const engine = await makeEngine();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await authLoginCommand(engine, 'anthropic', { apiKey: TEST_SECRET });

    const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join('\n');
    expect(allLoggedText).not.toContain(TEST_SECRET);
    expect(result.output).not.toContain(TEST_SECRET);
    // The masked confirmation is allowed to show the last 4 characters only.
    expect(result.output).toContain(TEST_SECRET.slice(-4));

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('#25 a non-interactive invocation with no --api-key and no env var fails immediately instead of hanging', async () => {
    const engine = await makeEngine();
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const result = await Promise.race([
        authLoginCommand(engine, 'anthropic', {}),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('authLoginCommand hung past 2s')), 2000)),
      ]);
      expect(result.code).not.toBe(0);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  it('succeeds with a valid key supplied via --api-key and stores the credential', async () => {
    const engine = await makeEngine();

    const result = await authLoginCommand(engine, 'anthropic', { apiKey: TEST_SECRET });

    expect(result.code).toBe(0);
    expect(await engine.secretBroker.getCredential('anthropic')).toBeDefined();
  });

  it('resolves the key from the provider environment variable when --api-key is omitted', async () => {
    const engine = await makeEngine();
    process.env.OPENAI_API_KEY = 'sk-openai-env-marker';

    try {
      const result = await authLoginCommand(engine, 'openai', {});
      expect(result.code).toBe(0);
      expect(await engine.secretBroker.getCredential('openai')).toBeDefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('rejects an unknown provider name cleanly', async () => {
    const engine = await makeEngine();
    const result = await authLoginCommand(engine, 'not-a-real-provider', { apiKey: 'x' });
    expect(result.code).toBe(1);
    expect(result.output).toContain('unknown provider');
  });

  it('refuses to build a browser-OAuth option for Anthropic — API key is the only supported method', async () => {
    const engine = await makeEngine();
    const result = await authLoginCommand(engine, 'anthropic', { oauth: true });
    expect(result.code).toBe(1);
    expect(result.output.toLowerCase()).toMatch(/does not support oauth|only api key/);
  });
});
