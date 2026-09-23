import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStore } from '../src/store.js';

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-store-durability-'));
  return path.join(dir, 'store.json');
}

describe('JsonFileStore durability — fsync(tmp) -> rename -> fsync(dir)', () => {
  let file: string;

  afterEach(async () => {
    if (file) await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined);
  });

  it('calls sync() on the temp file handle before renaming it into place', async () => {
    file = await tempFile();
    const store = new JsonFileStore(file);

    const realOpen = fs.open.bind(fs);
    const syncCalls: string[] = [];
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const realSync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        syncCalls.push(String(args[0]));
        return realSync();
      });
      return handle;
    });

    await store.put('key', 'value');

    expect(syncCalls.length).toBeGreaterThan(0);
    // The synced path is the temp file (ends in .tmp), not the final file directly —
    // sync happens before the atomic rename, not after.
    expect(syncCalls.some((p) => p.endsWith('.tmp'))).toBe(true);
    openSpy.mockRestore();
  });

  it.skipIf(process.platform === 'win32')('fsyncs the containing directory after the rename (skipped on win32, which has no directory fd to sync)', async () => {
    file = await tempFile();
    const store = new JsonFileStore(file);
    const dir = path.dirname(file);

    const realOpen = fs.open.bind(fs);
    let dirSynced = false;
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === dir && args[1] === 'r') {
        const realSync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          dirSynced = true;
          return realSync();
        });
      }
      return handle;
    });

    await store.put('key', 'value');

    expect(dirSynced).toBe(true);
    openSpy.mockRestore();
  });

  it('data survives and round-trips correctly through the fsync path (not just "sync was called")', async () => {
    file = await tempFile();
    const store = new JsonFileStore(file);
    await store.put('a', { nested: [1, 2, 3] });
    await store.put('b', 'plain-string');

    const reloaded = new JsonFileStore(file);
    expect(await reloaded.get('a')).toEqual({ nested: [1, 2, 3] });
    expect(await reloaded.get('b')).toBe('plain-string');
  });
});
