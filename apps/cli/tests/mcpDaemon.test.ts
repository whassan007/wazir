import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const homes: string[] = [];
afterEach(async () => {
  const cli = path.resolve('apps/cli/dist/index.js');
  for (const home of homes.splice(0)) {
    spawnSync(process.execPath, [cli, 'mcp', 'disconnect', 'daemon-fixture'], { env: { ...process.env, WAZIR_HOME: home }, timeout: 10_000 });
    await rm(home, { recursive: true, force: true });
  }
});

async function installDefinition(definition: Record<string, unknown>): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'wazir-mcp-daemon-test-'));
  homes.push(home);
  await writeFile(path.join(home, 'mcp.json'), JSON.stringify({ servers: [definition] }));
  return home;
}
function cli(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.resolve('apps/cli/dist/index.js'), ...args], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, WAZIR_HOME: home },
  });
}

describe('persistent MCP CLI connections', () => {
  it('keeps a real STDIO session connected across commands and gracefully disconnects it', async () => {
    const home = await installDefinition({
      id: 'daemon-fixture', name: 'Daemon fixture', enabled: true, transport: 'stdio',
      command: process.execPath, args: [path.resolve('packages/core/tests/fixtures/mcp.mjs'), 'stdio'],
      auth: { type: 'none' }, reconnect: { attempts: 0 }, timeout: { connectionMs: 3000 },
    });
    const connected = cli(home, 'mcp', 'connect', 'daemon-fixture');
    expect(connected.status).toBe(0); expect(connected.stdout).toContain('persistent connection active');
    const status = cli(home, 'mcp', 'status');
    expect(status.status).toBe(0); expect(status.stdout).toContain('daemon-fixture'); expect(status.stdout).toContain('CONNECTED'); expect(status.stdout).toContain('5');
    const disconnected = cli(home, 'mcp', 'disconnect', 'daemon-fixture');
    expect(disconnected.status).toBe(0); expect(disconnected.stdout).toContain('DISCONNECTED');
    expect(cli(home, 'mcp', 'status').stdout).not.toContain('CONNECTED');
  });

  it('reports missing credentials without leaving a false connected daemon status', async () => {
    const home = await installDefinition({
      id: 'daemon-fixture', name: 'Daemon fixture', enabled: true, transport: 'http',
      url: 'https://example.invalid/mcp', auth: { type: 'bearer', secretRef: 'missing-token' },
    });
    const connected = cli(home, 'mcp', 'connect', 'daemon-fixture');
    expect(connected.status).not.toBe(0);
    await expect(readFile(path.join(home, 'mcp-daemon-fixture.daemon.json'), 'utf8')).rejects.toThrow();
  });
});
