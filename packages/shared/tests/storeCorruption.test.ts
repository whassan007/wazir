import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonFileStore } from '../src/store.js';

describe('execution store corruption must fail closed', () => {
  it.each(['{truncated', 'null', '[]'])('does not overwrite invalid store contents: %s', async raw => {
    const directory = await mkdtemp(join(tmpdir(), 'wazir-corrupt-store-'));
    try {
      const file = join(directory, 'store.json');
      await writeFile(file, raw);
      const store = new JsonFileStore(file);
      await expect(store.list('execution/')).rejects.toThrow();
      await expect(store.put('execution/new', {})).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(raw);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('does not resurrect a stale cached store after the observed file disappears', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wazir-missing-store-'));
    try {
      const file = join(directory, 'store.json');
      const store = new JsonFileStore(file);
      await store.put('execution/original', {});
      await unlink(file);
      await expect(store.put('execution/new', {})).rejects.toThrow();
      await expect(readFile(file)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
