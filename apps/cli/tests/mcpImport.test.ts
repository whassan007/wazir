import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importMCPConfig } from '../src/mcp.js';
import { MCPRegistry, PolicyEngine } from '@wazir/core';
import { ToolRegistry } from '@wazir/tools';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function harness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wazir-mcp-import-'));
  roots.push(directory);
  const values = new Map<string, string>();
  const secrets = {
    getCredential: async (key: string) => values.get(key),
    putCredential: async (key: string, value: string) => { values.set(key, value); },
    deleteCredential: async (key: string) => values.delete(key),
  };
  const registry = new MCPRegistry({ directory, tools: new ToolRegistry([]), policy: new PolicyEngine({ projectRoot: directory }), secrets, autoConnect: false });
  await registry.initialize();
  await registry.remove('github'); await registry.remove('nvidia-runai');
  return { directory, registry, values };
}

describe('MCP config import credential migration', () => {
  it('moves literal env and header values to Secret Broker before writing safe config', async () => {
    const h = await harness();
    const pat = 'ghp_ThisIsASecretFixtureValue123';
    const serviceKey = 'runai-client-secret-fixture';
    await importMCPConfig(h.registry, { mcpServers: {
      githubCopy: { command: 'docker', args: ['run', '-i', 'ghcr.io/github/github-mcp-server'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: pat } },
      runai: { type: 'http', url: 'https://runai.example/mcp', headers: { Authorization: `Bearer ${serviceKey}` } },
    } });

    const config = await readFile(path.join(h.directory, 'mcp.json'), 'utf8');
    expect(config).not.toContain(pat);
    expect(config).not.toContain(serviceKey);
    expect(config).toContain('secretRef');
    expect([...h.values.values()]).toContain(pat);
    expect([...h.values.values()]).toContain(`Bearer ${serviceKey}`);
    expect(h.registry.get('githubcopy').definition.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toEqual({ secretRef: 'mcp.githubcopy.env.GITHUB_PERSONAL_ACCESS_TOKEN' });
    expect(h.registry.get('runai').definition.headers?.Authorization).toEqual({ secretRef: 'mcp.runai.headers.Authorization' });
  });

  it('keeps environment references as references and rejects unresolved host prompts', async () => {
    const h = await harness();
    process.env.WAZIR_MCP_IMPORT_FIXTURE = 'runtime-only-secret';
    try {
      await importMCPConfig(h.registry, { servers: { envServer: { command: 'fixture', env: { ACCESS_TOKEN: '${env:WAZIR_MCP_IMPORT_FIXTURE}' } } } });
      expect(h.registry.get('envserver').definition.env?.ACCESS_TOKEN).toEqual({ secretRef: 'env:WAZIR_MCP_IMPORT_FIXTURE' });
      expect((await readFile(path.join(h.directory, 'mcp.json'), 'utf8'))).not.toContain('runtime-only-secret');
      await expect(importMCPConfig(h.registry, { servers: { other: { command: 'fixture', env: { API_KEY: '${input:token}' } } } })).rejects.toThrow(/Unresolved input reference/);
      expect(h.registry.list().some(server => server.definition.id === 'other')).toBe(false);
    } finally { delete process.env.WAZIR_MCP_IMPORT_FIXTURE; }
  });

  it('refuses duplicate IDs before changing the existing profile', async () => {
    const h = await harness();
    await importMCPConfig(h.registry, { mcpServers: { custom: { command: 'fixture' } } });
    await expect(importMCPConfig(h.registry, { mcpServers: { custom: { command: 'attacker' } } })).rejects.toThrow(/Duplicate/);
    expect(h.registry.get('custom').definition.command).toBe('fixture');
  });
});
