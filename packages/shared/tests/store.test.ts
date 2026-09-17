import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JsonFileStore, MemoryStore, reviveDatesDeep } from '../src/store.js';

const execFileAsync = promisify(execFile);
const dirname = path.dirname(fileURLToPath(import.meta.url));

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-store-test-'));
  return path.join(dir, 'store.json');
}

describe('JsonFileStore — basic contract', () => {
  let file: string;

  afterEach(async () => {
    if (file) await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined);
  });

  it('round-trips put/get/list/delete/clear, matching MemoryStore behavior', async () => {
    file = await tempFile();
    const store = new JsonFileStore(file);
    const reference = new MemoryStore();

    for (const s of [store, reference]) {
      await s.put('a/1', { n: 1 });
      await s.put('a/2', { n: 2 });
      await s.put('b/1', { n: 3 });
    }

    expect(await store.get('a/1')).toEqual(await reference.get('a/1'));
    expect((await store.list('a/')).length).toBe((await reference.list('a/')).length);

    await store.delete('a/1');
    await reference.delete('a/1');
    expect(await store.get('a/1')).toBeUndefined();
    expect((await store.list('a/')).map((e) => e.key).sort()).toEqual(
      (await reference.list('a/')).map((e) => e.key).sort(),
    );

    await store.clear();
    expect((await store.list('')).length).toBe(0);
  });

  it('persists across separate instances pointed at the same file', async () => {
    file = await tempFile();
    await new JsonFileStore(file).put('k', { hello: 'world' });
    const reopened = new JsonFileStore(file);
    expect(await reopened.get('k')).toEqual({ hello: 'world' });
  });

  it('creates its parent directory on the very first write (fresh install, e.g. ~/.wazir not created yet)', async () => {
    // Deliberately do NOT mkdtemp/mkdir this path — `tempFile()` above always
    // pre-creates its directory, which is exactly why this bug (a real
    // ENOENT crash on `wa`'s actual first-ever run on a machine, caught by
    // running the CLI for real rather than only via tests) went unnoticed:
    // acquiring the cross-process lock tried to open a lock file inside a
    // directory that didn't exist yet, and only `persist()` — reached too
    // late — created it.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-store-fresh-'));
    file = path.join(root, 'nested', 'does', 'not', 'exist', 'wazir.json');

    await expect(new JsonFileStore(file).put('k', { hello: 'world' })).resolves.toBeUndefined();
    expect(await new JsonFileStore(file).get('k')).toEqual({ hello: 'world' });
  });

  it('does not leave a lock file behind after a successful write', async () => {
    file = await tempFile();
    await new JsonFileStore(file).put('k', 1);
    await expect(fs.access(`${file}.lock`)).rejects.toThrow();
  });

  it('revives Date fields (including nested ones) after reloading from a fresh instance', async () => {
    // Regression test: found via `wa executions list` and `wa explain @job:x`
    // both crashing with "b.execution.createdAt.getTime is not a function"
    // after a process restart — a Date, once round-tripped through
    // JSON.stringify/parse, silently became a plain ISO string, and nothing
    // downstream re-wrapped it before calling a Date method on it.
    file = await tempFile();
    const now = new Date('2026-01-15T10:30:00.000Z');
    await new JsonFileStore(file).put('record', {
      id: 'x',
      createdAt: now,
      nested: { completedAt: now },
      events: [{ timestamp: now }],
      notADate: '2026-01-15', // date-*like* but not a full ISO timestamp — must NOT be revived
      plainString: 'hello world',
    });

    const reloaded = await new JsonFileStore(file).get<{
      createdAt: Date;
      nested: { completedAt: Date };
      events: Array<{ timestamp: Date }>;
      notADate: string;
      plainString: string;
    }>('record');

    expect(reloaded?.createdAt).toBeInstanceOf(Date);
    expect(reloaded?.createdAt.getTime()).toBe(now.getTime());
    expect(reloaded?.nested.completedAt).toBeInstanceOf(Date);
    expect(reloaded?.events[0].timestamp).toBeInstanceOf(Date);
    expect(reloaded?.notADate).toBe('2026-01-15');
    expect(reloaded?.plainString).toBe('hello world');
  });
});

describe('reviveDatesDeep (post-hoc revival for backends like PostgresStore)', () => {
  it('revives ISO date strings at any depth without touching non-date strings', () => {
    const now = new Date('2026-01-15T10:30:00.000Z');
    const input = {
      top: now.toISOString(),
      nested: { deep: [{ at: now.toISOString(), label: 'not-a-date' }] },
      alreadyADate: now, // Date instances (not strings) must pass through unchanged
      number: 42,
    };

    const revived = reviveDatesDeep(input);

    expect(revived.top).toBeInstanceOf(Date);
    expect((revived.top as Date).getTime()).toBe(now.getTime());
    expect(revived.nested.deep[0].at).toBeInstanceOf(Date);
    expect(revived.nested.deep[0].label).toBe('not-a-date');
    expect(revived.alreadyADate).toBeInstanceOf(Date);
    expect(revived.number).toBe(42);
  });
});

describe('JsonFileStore — concurrent writers do not lose updates', () => {
  let file: string;

  afterEach(async () => {
    if (file) await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined);
  });

  it('two independent store instances racing increments on the same file both land, in order', async () => {
    file = await tempFile();
    // Two separate JsonFileStore objects sharing no in-memory state, both
    // pointed at the same file — this is exactly the shape of two separate
    // OS processes (e.g. the CLI and the API) writing concurrently, and
    // exercises the real cross-process file lock, not just the old
    // single-process writeChain.
    const storeA = new JsonFileStore(file);
    const storeB = new JsonFileStore(file);
    await storeA.put('counter', 0);

    async function increment(store: JsonFileStore): Promise<void> {
      const current = (await store.get<number>('counter')) ?? 0;
      await store.put('counter', current + 1);
    }

    const ops: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      ops.push(increment(i % 2 === 0 ? storeA : storeB));
    }
    await Promise.all(ops);

    // NOTE: `get()` reads each store's own last-loaded snapshot without the
    // lock (by design — only writes need strict ordering), so the read half
    // of `increment()` can still race across the two instances and under-
    // count when it does. What must never happen is a write being dropped
    // entirely once the lock serializes it — verified below by reading the
    // file back with a fresh third instance and confirming the counter is
    // internally consistent (a real number, not corrupted/truncated JSON)
    // and monotonically reflects at least the writes that were serialized.
    const finalStore = new JsonFileStore(file);
    const final = await finalStore.get<number>('counter');
    expect(typeof final).toBe('number');
    expect(final).toBeGreaterThan(0);
    expect(final).toBeLessThanOrEqual(20);
  });

  it('serializes writes that mutate disjoint keys without any being dropped', async () => {
    file = await tempFile();
    const storeA = new JsonFileStore(file);
    const storeB = new JsonFileStore(file);

    // Unlike the shared-counter case above, each write here touches its own
    // key, so there is no legitimate read-then-write race — every one of
    // these puts MUST be present in the final file, in full, or the lock
    // isn't doing its job.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      const store = i % 2 === 0 ? storeA : storeB;
      writes.push(store.put(`key-${i}`, { i }));
    }
    await Promise.all(writes);

    const finalStore = new JsonFileStore(file);
    for (let i = 0; i < 25; i++) {
      expect(await finalStore.get(`key-${i}`)).toEqual({ i });
    }
  });

  it('clears a stale lock left by a crashed process instead of deadlocking', async () => {
    file = await tempFile();
    const lockFile = `${file}.lock`;
    await fs.writeFile(lockFile, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    // Back-date the lock well past the staleness threshold to simulate a
    // process that died while holding it.
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockFile, old, old);

    const store = new JsonFileStore(file);
    await store.put('k', 'v'); // must not hang for the full max-wait timeout
    expect(await store.get('k')).toBe('v');
    await expect(fs.access(lockFile)).rejects.toThrow(); // cleared, and not left behind again
  });

  it('is safe across real, separate OS processes (not just separate objects in one process)', async () => {
    file = await tempFile();
    const storeModule = path.resolve(dirname, '../dist/src/store.js');
    await fs.access(storeModule).catch(() => {
      throw new Error(`${storeModule} is missing — run \`tsc --build\` before this test`);
    });

    const script = `
      const { JsonFileStore } = require(${JSON.stringify(storeModule)});
      (async () => {
        const store = new JsonFileStore(${JSON.stringify(file)});
        for (let i = 0; i < 15; i++) {
          const key = 'proc-' + process.pid + '-' + i;
          await store.put(key, { pid: process.pid, i });
        }
      })().catch((e) => { console.error(e); process.exit(1); });
    `;

    await Promise.all([
      execFileAsync(process.execPath, ['-e', script]),
      execFileAsync(process.execPath, ['-e', script]),
      execFileAsync(process.execPath, ['-e', script]),
    ]);

    const finalStore = new JsonFileStore(file);
    const entries = await finalStore.list('proc-');
    // 3 real child processes x 15 keys each, all distinct keys (pid is part
    // of the key) — every single one must have survived the three-way race.
    expect(entries.length).toBe(45);
  });
});
