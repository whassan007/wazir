import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * An ACP agent that launched a command, then Wazir is SIGKILLed. Closing stdin may stop the
 * agent itself, but not commands it started in its process group; the watchdog must.
 */
describe('ACP agent process group', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); dir = undefined; });

  it.skipIf(process.platform === 'win32')('dies with Wazir, including commands the agent started', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-acp-orphan-'));
    const pidFile = path.join(dir, 'pids');
    const agent = path.join(dir, 'agent.sh');
    // Never answers initialize; ignores stdin EOF, like a stuck bridge with a running command.
    await fs.writeFile(agent, `#!/usr/bin/env bash\nsleep 60 &\necho "$$ $!" > '${pidFile}'\nwhile true; do sleep 1; done\n`, { mode: 0o755 });
    const entry = path.join(dir, 'host.ts');
    await fs.writeFile(entry, `import { AcpClientAdapter } from ${JSON.stringify(path.resolve(here, '../src/acp/acpClient.ts'))};\n` +
      `void new AcpClientAdapter({ name: 'stuck', command: ${JSON.stringify(agent)}, initTimeoutMs: 60_000 }).ensureConnection();\n`);
    const host = path.join(dir, 'host.cjs');
    const esbuild = path.resolve(here, '../../../node_modules/.bin/esbuild');
    const built = spawnSync(esbuild, [entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${host}`, '--log-level=error']);
    expect(built.status, String(built.stderr)).toBe(0);

    const wazir = spawn(process.execPath, [host], { stdio: 'ignore' });
    let pids: number[] = [];
    for (let i = 0; i < 100 && pids.length < 2; i++) {
      const raw = await fs.readFile(pidFile, 'utf8').catch(() => '');
      pids = raw.trim() ? raw.trim().split(/\s+/).map(Number) : [];
      if (pids.length < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(pids).toHaveLength(2);
    wazir.kill('SIGKILL');
    for (let i = 0; i < 50 && pids.some(isAlive); i++) await new Promise((r) => setTimeout(r, 100));
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
  }, 20_000);
});
