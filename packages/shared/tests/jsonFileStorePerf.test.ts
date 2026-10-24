import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JsonFileStore } from '../src/store.js';
import { faultInjector } from '../src/faultInjection.js';

const roots: string[] = [];
async function file() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'store-perf-'));
  roots.push(root);
  return path.join(root, 'data.json');
}
afterEach(async () => {
  vi.restoreAllMocks();
  faultInjector.clear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('JsonFileStore batching and cache', () => {
  it('commits a concurrent burst with fewer writes and substantially less I/O latency', async () => {
    const batchedFile = await file();
    const serialFile = await file();
    const rename = fs.rename.bind(fs);
    // Model a small, fixed filesystem latency to keep the speed comparison
    // meaningful and stable even on fast tmpfs or heavily loaded CI machines.
    const writes = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return rename(from, to);
    });
    async function burst(target: string, coalesceWrites: boolean) {
      const store = new JsonFileStore(target, { coalesceWrites, pretty: false });
      const start = performance.now();
      await Promise.all(Array.from({ length: 50 }, (_, i) => store.put(`key-${i}`, { i }).then(async () => {
        // Each resolved caller can read its committed value directly from disk.
        expect(JSON.parse(await fs.readFile(target, 'utf8'))[`key-${i}`]).toEqual({ i });
      })));
      return performance.now() - start;
    }
    const batchedMs = await burst(batchedFile, true);
    const batchedWrites = writes.mock.calls.length;
    const serialMs = await burst(serialFile, false);
    expect(batchedWrites).toBeLessThan(5);
    expect(writes.mock.calls.length - batchedWrites).toBe(50);
    expect(batchedMs).toBeLessThan(serialMs / 2);
    expect(Object.keys(JSON.parse(await fs.readFile(batchedFile, 'utf8')))).toHaveLength(50);
  });

  it('batches mutations queued behind an in-flight write and waits for rename', async () => {
    const target = await file();
    const store = new JsonFileStore(target);
    const rename = fs.rename.bind(fs);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const writes = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      entered();
      await blocked;
      return rename(from, to);
    });
    let resolved = false;
    const first = store.put('first', 1).then(() => { resolved = true; });
    await writing;
    const pending = Array.from({ length: 50 }, (_, i) => store.put(`next-${i}`, i));
    expect(resolved).toBe(false);
    release();
    await Promise.all([first, ...pending]);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(Object.keys(JSON.parse(await fs.readFile(target, 'utf8')))).toHaveLength(51);
  });

  it('skips unchanged reads and detects a separate process rewrite before reads and updates', async () => {
    const target = await file();
    const store = new JsonFileStore(target);
    await store.put('counter', 0);
    const read = vi.spyOn(fs, 'readFile');
    await store.get('counter');
    await store.list('');
    expect(read.mock.calls.filter(([name]) => name === target)).toHaveLength(0);
    async function external(value: number) {
      await promisify(execFile)(process.execPath, ['-e',
        `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({counter: ${value}, external: true}))`, target]);
    }
    await external(10);
    expect(await store.get('counter')).toBe(10);
    await external(100);
    expect(await store.update<number>('counter', (n) => n! + 1)).toBe(101);
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ counter: 101, external: true });
  });

  it('isolates a callback that mutates its argument and then throws', async () => {
    const target = await file();
    const store = new JsonFileStore(target);
    await store.put('counter', { n: 0 });
    const results = await Promise.allSettled([
      store.update<{ n: number }>('counter', (value) => { value!.n = 99; throw new Error('bad callback'); }),
      store.update<{ n: number }>('counter', (value) => ({ n: value!.n + 1 })),
      store.put('sibling', true),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(await new JsonFileStore(target).get('counter')).toEqual({ n: 1 });
    expect(await store.get('sibling')).toBe(true);
  });

  it('isolates a post-fsync injected failure and continues committing siblings', async () => {
    const target = await file();
    const store = new JsonFileStore(target);
    faultInjector.register({ point: 'DURING_STORE_WRITE', action: { type: 'throw', error: 'injected' } });
    const results = await Promise.allSettled([store.put('failed', true), store.put('sibling', true)]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ sibling: true });
  });

  it('preserves queue ordering across update, delete and clear', async () => {
    const target = await file();
    const store = new JsonFileStore(target, { coalesceWindowMs: 1 });
    await Promise.all([store.put('a', 1), store.clear(), store.put('b', 2), store.delete('b'), store.put('c', 3)]);
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ c: 3 });
  });
});
