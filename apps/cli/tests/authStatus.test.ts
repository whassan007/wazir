import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputerRegistry, ModelRegistry, PolicyEngine, RuntimeRegistry } from '@wazir/core';
import { createSecretBroker } from '@wazir/secrets';
import { createHostedProviders } from '../src/hostedProviders.js';
import { authLoginCommand, authStatusCommand } from '../src/auth.js';
import type { RookEngine } from '../src/engine.js';

const TEST_SECRET = 'sk-ant-status-marker-do-not-leak-777';

async function makeEngine(): Promise<RookEngine> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-authstatus-'));
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

describe('authStatusCommand', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows all three providers as not connected before any login', async () => {
    const engine = await makeEngine();

    const result = await authStatusCommand(engine, { json: true });
    const rows = JSON.parse(result.output);

    expect(rows).toHaveLength(3);
    expect(rows.every((r: any) => r.status.authenticated === false)).toBe(true);
  });

  it('#14 wa auth status reveals no secrets, in both text and JSON output', async () => {
    const engine = await makeEngine();
    await authLoginCommand(engine, 'anthropic', { apiKey: TEST_SECRET });

    const textResult = await authStatusCommand(engine, {});
    const jsonResult = await authStatusCommand(engine, { json: true });

    expect(textResult.output).not.toContain(TEST_SECRET);
    expect(jsonResult.output).not.toContain(TEST_SECRET);
    // Doesn't even leak the masked last-4 hint — status is a pure read of
    // AuthStatus, which structurally has no field capable of carrying any
    // part of the credential (see ProviderAuthAdapter.status()'s docstring).
    expect(jsonResult.output).not.toContain(TEST_SECRET.slice(-4));
  });

  it('reflects connected state after a successful login', async () => {
    const engine = await makeEngine();
    await authLoginCommand(engine, 'anthropic', { apiKey: TEST_SECRET });

    const result = await authStatusCommand(engine, { json: true });
    const rows = JSON.parse(result.output);
    const anthropicRow = rows.find((r: any) => r.id === 'anthropic');

    expect(anthropicRow.status.authenticated).toBe(true);
    expect(anthropicRow.status.method).toBe('api-key');
  });
});
