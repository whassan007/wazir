import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExternalAgentAdapter } from '../src/externalAgent.js';

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('ExternalAgentAdapter lifecycle', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); dir = undefined; });

  /** A harness that records its own and its child's pid, then hangs. */
  async function hangingAgent(): Promise<{ command: string; pidFile: string }> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-ext-life-'));
    const pidFile = path.join(dir, 'pids');
    const command = path.join(dir, 'hang.sh');
    await fs.writeFile(command, `#!/usr/bin/env bash\nsleep 60 &\necho "$$ $!" > '${pidFile}'\nwait\n`, { mode: 0o755 });
    return { command, pidFile };
  }

  async function readPids(pidFile: string): Promise<number[]> {
    for (let i = 0; i < 100; i++) {
      const raw = await fs.readFile(pidFile, 'utf8').catch(() => '');
      if (raw.trim()) return raw.trim().split(/\s+/).map(Number);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('agent never started');
  }

  it.skipIf(process.platform === 'win32')('cancellation kills the running harness and its children promptly', async () => {
    const { command, pidFile } = await hangingAgent();
    let cancelled = false;
    const adapter = new ExternalAgentAdapter({ name: 'hang', version: '1', description: '', command, taskTypes: [], capabilities: [] });
    const turns: any[] = [];
    const started = Date.now();
    const run = (async () => {
      for await (const t of adapter.run({ taskDescription: 'x', projectRoot: dir!, isCancelled: () => cancelled } as any, {} as any)) turns.push(t);
    })();
    const pids = await readPids(pidFile);
    cancelled = true;
    await run;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(turns.at(-1)).toMatchObject({ kind: 'error', error: 'cancelled' });
    await new Promise((r) => setTimeout(r, 100));
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('a timeout is reported as a timeout, not "exited with code null"', async () => {
    const { command } = await hangingAgent();
    const adapter = new ExternalAgentAdapter({ name: 'hang', version: '1', description: '', command, taskTypes: [], capabilities: [], timeoutMs: 300 });
    const run = async () => { for await (const _ of adapter.run({ taskDescription: 'x', projectRoot: dir! } as any, {} as any)) { /* drain */ } };
    await expect(run()).rejects.toThrow(/timed out after 300ms/);
  });
});
