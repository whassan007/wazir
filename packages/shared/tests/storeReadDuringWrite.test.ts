import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStore } from '../src/store.js';

/**
 * Found by the Phase 24 live run (exec-muf5zijr-1): the run's revision-15 write resolved,
 * yet the file still held revision 14 (written by the same pid), so revision 16 conflicted.
 * A read (get/list) reloaded the file into the same map a locked writer was about to
 * serialize, so the writer persisted the pre-mutation snapshot and still reported success.
 */
describe('a read during a write never discards the write', () => {
  let base: string;
  beforeEach(async () => { base = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-read-write-')); });
  afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

  it('every update that resolved is in the file, despite concurrent list() calls', async () => {
    const file = path.join(base, 'data.json');
    const store = new JsonFileStore(file);
    await store.put('padding', 'x'.repeat(200_000));
    let reading = true;
    const reader = (async () => { while (reading) await store.list('rev'); })();
    try {
      for (let revision = 1; revision <= 40; revision++) {
        await store.update<number>('rev', () => revision);
        const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as { rev: number };
        expect(onDisk.rev).toBe(revision);
      }
    } finally {
      reading = false;
      await reader;
    }
  });
});
