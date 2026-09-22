import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputerRegistry, ModelRegistry, PolicyEngine, RuntimeRegistry } from '@wazir/core';
import { createSecretBroker } from '@wazir/secrets';
import { createHostedProviders } from '../src/hostedProviders.js';
import { authLoginCommand, authLogoutCommand, authStatusCommand } from '../src/auth.js';
import type { RookEngine } from '../src/engine.js';

async function makeEngine(): Promise<RookEngine> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-authlogout-'));
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

describe('authLogoutCommand', () => {
  beforeEach(() => {
    // One model in the listing so a successful login lands on 'healthy', not
    // 'degraded' (an authenticated-but-zero-models response is deliberately
    // treated as degraded — see hostedProviders.ts).
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-20250514' }] }), { status: 200 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('#15 removes only the selected provider credential, leaving other providers connected', async () => {
    const engine = await makeEngine();
    await authLoginCommand(engine, 'anthropic', { apiKey: 'sk-ant-1' });
    await authLoginCommand(engine, 'openai', { apiKey: 'sk-openai-1' });

    const result = await authLogoutCommand(engine, 'anthropic');
    expect(result.code).toBe(0);

    expect(await engine.secretBroker.getCredential('anthropic')).toBeUndefined();
    expect(await engine.secretBroker.getCredential('openai')).toBeDefined();

    const status = JSON.parse((await authStatusCommand(engine, { json: true })).output);
    expect(status.find((r: any) => r.id === 'anthropic').status.authenticated).toBe(false);
    expect(status.find((r: any) => r.id === 'openai').status.authenticated).toBe(true);
  });

  it('updates the runtime registry health to unavailable after logout', async () => {
    const engine = await makeEngine();
    await authLoginCommand(engine, 'anthropic', { apiKey: 'sk-ant-1' });
    expect(engine.runtimes.get('anthropic')?.health).toBe('healthy');

    await authLogoutCommand(engine, 'anthropic');

    expect(engine.runtimes.get('anthropic')?.health).toBe('unavailable');
  });

  it('logging out of a never-authenticated provider is a clean no-op, not an error', async () => {
    const engine = await makeEngine();
    const result = await authLogoutCommand(engine, 'google');
    expect(result.code).toBe(0);
  });
});
