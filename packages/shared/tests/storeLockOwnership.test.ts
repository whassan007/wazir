import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStore } from '../src/store.js';

/**
 * Found while diagnosing the Phase 24 live run (exec-muf5n64z-1), whose execution record
 * lost a write to another writer. A lock held for over 30s was stolen even while its
 * holder was alive — two writers then rewrote the whole file from different snapshots —
 * and a holder's release deleted the lock file even when someone else held it by then.
 */
describe('the store lock is never taken from, or released for, another live holder', () => {
  let base: string;
  let file: string;
  let lock: string;
  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-lock-owner-'));
    file = path.join(base, 'data.json');
    lock = `${file}.lock`;
  });
  afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

  async function oldLockHeldBy(pid: number) {
    await fs.writeFile(lock, `${pid}\n${new Date().toISOString()}\n`);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
  }

  it('waits out, and names, a live holder instead of stealing its old lock', async () => {
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      await oldLockHeldBy(holder.pid!);
      await expect(new JsonFileStore(file).put('k', 1)).rejects.toThrow(`by live process ${holder.pid}`);
      expect(await fs.readFile(lock, 'utf8')).toContain(String(holder.pid)); // still theirs
    } finally {
      holder.kill('SIGKILL');
    }
  }, 20_000);

  it('still clears an old lock whose holder has died', async () => {
    const holder = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => holder.on('exit', resolve));
    await oldLockHeldBy(holder.pid!);
    const store = new JsonFileStore(file);
    await store.put('k', 1);
    expect(await store.get('k')).toBe(1);
  });

  it('release leaves a lock that another holder now owns', async () => {
    const store = new JsonFileStore(file);
    await store.update('k', () => {
      writeFileSync(lock, 'someone-else\n'); // our lock was replaced while we held it
      return 1;
    });
    expect(await fs.readFile(lock, 'utf8')).toBe('someone-else\n');
  });
});
