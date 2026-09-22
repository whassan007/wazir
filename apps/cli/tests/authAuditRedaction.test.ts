import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputerRegistry, ModelRegistry, PolicyEngine, RuntimeRegistry } from '@wazir/core';
import { createSecretBroker } from '@wazir/secrets';
import { createHostedProviders } from '../src/hostedProviders.js';
import { authLoginCommand, authLogoutCommand } from '../src/auth.js';
import type { RookEngine } from '../src/engine.js';

const TEST_SECRET = 'sk-openai-audit-redaction-marker-abc123';

describe('provider_auth audit events — secret redaction', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let auditDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-audit-'));
    originalConfigDir = process.env.WAZIR_CONFIG_DIR;
    process.env.WAZIR_CONFIG_DIR = auditDir;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalConfigDir === undefined) delete process.env.WAZIR_CONFIG_DIR;
    else process.env.WAZIR_CONFIG_DIR = originalConfigDir;
  });

  async function makeEngine(): Promise<RookEngine> {
    const secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-audit-secrets-'));
    const secretBroker = await createSecretBroker({ secretsDir });
    const config = { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] };
    const hostedAdapters = createHostedProviders(config as any, secretBroker);
    return {
      config,
      runtimes: new RuntimeRegistry(),
      models: new ModelRegistry(),
      computers: new ComputerRegistry(),
      policy: new PolicyEngine({ projectRoot: secretsDir }),
      secretBroker,
      hostedAdapters,
    } as unknown as RookEngine;
  }

  it('#12 a successful login never writes the API key into the audit log', async () => {
    const engine = await makeEngine();

    await authLoginCommand(engine, 'openai', { apiKey: TEST_SECRET });

    const rawAuditFile = await fs.readFile(path.join(auditDir, 'audit.jsonl'), 'utf8');
    expect(rawAuditFile).not.toContain(TEST_SECRET);
    expect(rawAuditFile).toContain('AUTH_LOGIN_STARTED');
    expect(rawAuditFile).toContain('AUTH_LOGIN_SUCCEEDED');
    expect(rawAuditFile).toContain('"provider":"openai"');
  });

  it('a failed login never writes the attempted API key into the audit log', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const engine = await makeEngine();

    await authLoginCommand(engine, 'openai', { apiKey: TEST_SECRET });

    const rawAuditFile = await fs.readFile(path.join(auditDir, 'audit.jsonl'), 'utf8');
    expect(rawAuditFile).not.toContain(TEST_SECRET);
    expect(rawAuditFile).toContain('AUTH_LOGIN_FAILED');
  });

  it('logout never writes secret material into the audit log', async () => {
    const engine = await makeEngine();
    await authLoginCommand(engine, 'openai', { apiKey: TEST_SECRET });

    await authLogoutCommand(engine, 'openai');

    const rawAuditFile = await fs.readFile(path.join(auditDir, 'audit.jsonl'), 'utf8');
    expect(rawAuditFile).not.toContain(TEST_SECRET);
    expect(rawAuditFile).toContain('AUTH_LOGOUT');
  });

  it('audit events are queryable by provider without ever surfacing a secret value', async () => {
    const engine = await makeEngine();
    await authLoginCommand(engine, 'openai', { apiKey: TEST_SECRET });

    const { readAuditEvents } = await import('@wazir/shared');
    const events = await readAuditEvents({ auditPath: path.join(auditDir, 'audit.jsonl'), provider: 'openai' });

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.provider === 'openai')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(TEST_SECRET);
  });
});
