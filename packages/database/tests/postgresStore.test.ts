import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createPool, checkHealth, runKvMigration, PostgresStore } from '../src/index.js';

const execFileAsync = promisify(execFile);

/**
 * Integration test against a real Postgres instance. Skipped by default —
 * set WAZIR_TEST_DATABASE_URL to a scratch database to run it (e.g. a local
 * `docker run --rm -e POSTGRES_PASSWORD=wazir -e POSTGRES_DB=wazir_pg_test
 * -p 5432:5432 postgres:16-alpine` and
 * `WAZIR_TEST_DATABASE_URL=postgres://postgres:wazir@localhost:5432/wazir_pg_test`).
 * This is deliberately not mocked: a fake pg client would only prove the
 * SQL strings compile, not that they're valid Postgres syntax or that the
 * KeyValueStore contract actually round-trips through a real database.
 */
const connectionString = process.env.WAZIR_TEST_DATABASE_URL;
if (connectionString && !/^wazir_.*_test$/.test(new URL(connectionString).pathname.slice(1))) {
  throw new Error('Destructive integration tests require a dedicated wazir_*_test database');
}

if (process.env.WAZIR_REQUIRE_DATABASE === '1' && !connectionString) {
  throw new Error('WAZIR_REQUIRE_DATABASE=1 was specified, but WAZIR_TEST_DATABASE_URL is not set!');
}

describe.skipIf(!connectionString)('PostgresStore (real Postgres)', () => {
  let pool: Pool;
  let store: PostgresStore;

  beforeAll(async () => {
    pool = createPool({ connectionString });
    const health = await checkHealth(pool);
    if (!health.ok) {
      throw new Error(`could not reach test database: ${health.error}`);
    }
    await runKvMigration(pool);
    await pool.query('TRUNCATE wazir_kv_store');
    store = new PostgresStore(pool);
  });

  afterAll(async () => {
    await pool?.query('TRUNCATE wazir_kv_store').catch(() => undefined);
    await pool?.end();
  });

  it('reports a healthy connection with a real Postgres version string', async () => {
    const health = await checkHealth(pool);
    expect(health.ok).toBe(true);
    expect(health.version).toMatch(/PostgreSQL/i);
  });

  it('running the migration twice is a safe no-op', async () => {
    await expect(runKvMigration(pool)).resolves.not.toThrow();
  });

  it('round-trips arbitrary JSON values through put/get', async () => {
    const value = { nested: { array: [1, 2, 3] }, note: 'hello from Postgres', n: 42, ok: true };
    await store.put('exec/abc', value);
    expect(await store.get('exec/abc')).toEqual(value);
  });

  it('revives Date fields (including nested ones) after a real round trip through Postgres JSONB', async () => {
    // `pg` parses JSONB with its own internal JSON.parse and no reviver hook
    // — without PostgresStore's reviveDatesDeep post-processing, this comes
    // back as plain ISO strings, same class of bug as JsonFileStore's.
    const now = new Date('2026-01-15T10:30:00.000Z');
    await store.put('exec/with-dates', { createdAt: now, nested: { at: now }, events: [{ timestamp: now }] });

    const reloaded = await store.get<{ createdAt: Date; nested: { at: Date }; events: Array<{ timestamp: Date }> }>(
      'exec/with-dates',
    );

    expect(reloaded?.createdAt).toBeInstanceOf(Date);
    expect(reloaded?.createdAt.getTime()).toBe(now.getTime());
    expect(reloaded?.nested.at).toBeInstanceOf(Date);
    expect(reloaded?.events[0].timestamp).toBeInstanceOf(Date);
  });

  it('overwrites an existing key on a second put (upsert, not duplicate rows)', async () => {
    await store.put('exec/dup', { v: 1 });
    await store.put('exec/dup', { v: 2 });
    expect(await store.get('exec/dup')).toEqual({ v: 2 });
    const rows = await store.list('exec/dup');
    expect(rows.length).toBe(1);
  });

  it('lists by prefix and excludes non-matching keys', async () => {
    await store.put('job/1', { id: 1 });
    await store.put('job/2', { id: 2 });
    await store.put('other/1', { id: 'nope' });

    const jobs = await store.list('job/');
    expect(jobs.map((e) => e.key).sort()).toEqual(['job/1', 'job/2']);
    expect(jobs.every((e) => (e.value as { id: unknown }).id !== 'nope')).toBe(true);
  });

  it('treats % and _ in a prefix literally, not as SQL LIKE wildcards', async () => {
    await store.put('weird%key/1', { tag: 'percent' });
    await store.put('weird_key/1', { tag: 'underscore-literal' });
    await store.put('weirdXkey/1', { tag: 'should-not-match-underscore-wildcard' });

    const percentMatches = await store.list('weird%key/');
    expect(percentMatches.map((e) => e.key)).toEqual(['weird%key/1']);

    const underscoreMatches = await store.list('weird_key/');
    expect(underscoreMatches.map((e) => e.key)).toEqual(['weird_key/1']);
  });

  it('deletes a single key without affecting others', async () => {
    await store.put('to-delete', { v: 1 });
    await store.put('to-keep', { v: 2 });
    await store.delete('to-delete');
    expect(await store.get('to-delete')).toBeUndefined();
    expect(await store.get('to-keep')).toEqual({ v: 2 });
  });

  it('clear() empties the whole table', async () => {
    await store.put('a', 1);
    await store.put('b', 2);
    await store.clear();
    expect(await store.list('')).toEqual([]);
  });

  it('serializes concurrent upserts to the same key without error (real network round-trips)', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.put('race', { i })));
    const final = await store.get<{ i: number }>('race');
    expect(final).toBeDefined();
    expect(typeof final?.i).toBe('number');
  });

  it('atomic compare-and-update creates non-existent keys and safely performs conditional mutations', async () => {
    const key = `test/cas/${Date.now()}`;
    const init = await store.update<{ version: number; data: string }>(key, (cur) => {
      expect(cur).toBeUndefined();
      return { version: 1, data: 'init' };
    });
    expect(init).toEqual({ version: 1, data: 'init' });

    const updated = await store.update<{ version: number; data: string }>(key, (cur) => {
      expect(cur?.version).toBe(1);
      return { version: 2, data: 'updated' };
    });
    expect(updated).toEqual({ version: 2, data: 'updated' });

    await expect(
      store.update<{ version: number; data: string }>(key, (cur) => {
        if (cur?.version !== 1) throw new Error('VERSION_CONFLICT');
        return { version: 3, data: 'stale' };
      })
    ).rejects.toThrow('VERSION_CONFLICT');

    const current = await store.get<{ version: number; data: string }>(key);
    expect(current).toEqual({ version: 2, data: 'updated' });
  });

  it('rolls back transaction and preserves prior state on mutation error', async () => {
    const key = `test/rollback/${Date.now()}`;
    await store.put(key, { counter: 100 });

    await expect(
      store.update<{ counter: number }>(key, () => {
        throw new Error('ROLLBACK_INTENTIONAL');
      })
    ).rejects.toThrow('ROLLBACK_INTENTIONAL');

    const afterRollback = await store.get<{ counter: number }>(key);
    expect(afterRollback?.counter).toBe(100);

    const next = await store.update<{ counter: number }>(key, (cur) => ({
      counter: (cur?.counter ?? 0) + 1,
    }));
    expect(next.counter).toBe(101);
  });

  it('serializes genuine concurrent atomic updates on the same key without lost updates', async () => {
    const key = `test/concurrent-updates/${Date.now()}`;
    await store.put(key, { counter: 0 });

    const concurrency = 25;
    const tasks = Array.from({ length: concurrency }, () =>
      store.update<{ counter: number }>(key, (cur) => ({
        counter: (cur?.counter ?? 0) + 1,
      }))
    );

    const results = await Promise.all(tasks);
    expect(results).toHaveLength(concurrency);

    const final = await store.get<{ counter: number }>(key);
    expect(final?.counter).toBe(concurrency);
  });

  it('concurrent atomic updates across independent connection pools serialize correctly', async () => {
    const key = `test/multi-pool/${Date.now()}`;
    await store.put(key, { counter: 0 });

    const pool2 = createPool({ connectionString });
    const pool3 = createPool({ connectionString });
    const store2 = new PostgresStore(pool2);
    const store3 = new PostgresStore(pool3);

    try {
      const stores = [store, store2, store3];
      const updatesPerStore = 10;
      const allUpdates = stores.flatMap((s) =>
        Array.from({ length: updatesPerStore }, () =>
          s.update<{ counter: number }>(key, (cur) => ({
            counter: (cur?.counter ?? 0) + 1,
          }))
        )
      );

      await Promise.all(allUpdates);

      const final = await store.get<{ counter: number }>(key);
      expect(final?.counter).toBe(stores.length * updatesPerStore);
    } finally {
      await pool2.end();
      await pool3.end();
    }
  });

  it('persists data across independent terminated child processes', async () => {
    const key = `test/proc-persist/${Date.now()}`;
    const nowIso = new Date().toISOString();
    const testPayload = { author: 'worker-proc', writtenAt: nowIso };

    const packageDist = path.resolve(__dirname, '../dist/src/index.js');
    const childScript = `
      const { createPool, PostgresStore } = require(${JSON.stringify(packageDist)});
      (async () => {
        const p = createPool({ connectionString: process.env.WAZIR_TEST_DATABASE_URL });
        const s = new PostgresStore(p);
        await s.put(${JSON.stringify(key)}, ${JSON.stringify(testPayload)});
        await p.end();
        process.stdout.write('PERSISTED');
      })().catch(err => { console.error(err); process.exit(1); });
    `;

    const { stdout } = await execFileAsync(process.execPath, ['-e', childScript]);
    expect(stdout).toBe('PERSISTED');

    const freshPool = createPool({ connectionString });
    try {
      const freshStore = new PostgresStore(freshPool);
      const retrieved = await freshStore.get<{ author: string; writtenAt: Date }>(key);
      expect(retrieved?.author).toBe('worker-proc');
      expect(retrieved?.writtenAt).toBeInstanceOf(Date);
      expect(retrieved?.writtenAt.toISOString()).toBe(nowIso);
    } finally {
      await freshPool.end();
    }
  });

  it('concurrent atomic updates across independent child processes serialize correctly', async () => {
    const key = `test/proc-concurrent/${Date.now()}`;
    await store.put(key, { counter: 0 });

    const packageDist = path.resolve(__dirname, '../dist/src/index.js');
    const childScript = `
      const { createPool, PostgresStore } = require(${JSON.stringify(packageDist)});
      (async () => {
        const p = createPool({ connectionString: process.env.WAZIR_TEST_DATABASE_URL });
        const s = new PostgresStore(p);
        for (let i = 0; i < 5; i++) {
          await s.update(${JSON.stringify(key)}, cur => ({ counter: (cur?.counter ?? 0) + 1 }));
        }
        await p.end();
        process.stdout.write('OK');
      })().catch(err => { console.error(err); process.exit(1); });
    `;

    const processes = 4;
    const runs = Array.from({ length: processes }, () =>
      execFileAsync(process.execPath, ['-e', childScript])
    );

    const outcomes = await Promise.all(runs);
    for (const out of outcomes) {
      expect(out.stdout).toBe('OK');
    }

    const final = await store.get<{ counter: number }>(key);
    expect(final?.counter).toBe(processes * 5);
  });

  it('prefix listing handles backslashes and boundary prefixes correctly', async () => {
    await store.put('pref/a', { val: 'a' });
    await store.put('pref/ab', { val: 'ab' });
    await store.put('pref/b', { val: 'b' });
    await store.put('pref_not/c', { val: 'c' });
    await store.put('escape\\test/1', { val: 'slash' });
    await store.put('escapeXtest/1', { val: 'noslash' });

    const prefList = await store.list('pref/');
    expect(prefList.map((e) => e.key).sort()).toEqual(['pref/a', 'pref/ab', 'pref/b']);

    const slashList = await store.list('escape\\test/');
    expect(slashList.map((e) => e.key)).toEqual(['escape\\test/1']);
  });

  it('deleting a non-existent key is a safe no-op and preserves other keys', async () => {
    await store.put('preserve/key', { ok: true });
    await expect(store.delete('non-existent-key-12345')).resolves.not.toThrow();
    expect(await store.get('preserve/key')).toEqual({ ok: true });
  });

  it('checkHealth reports failure when given unreachable connection options', async () => {
    const deadPool = createPool({ connectionString: 'postgres://postgres:badpass@127.0.0.1:54329/fake_db', connectionTimeoutMillis: 1000 });
    try {
      const health = await checkHealth(deadPool);
      expect(health.ok).toBe(false);
      expect(health.error).toBeDefined();
    } finally {
      await deadPool.end().catch(() => undefined);
    }
  });
});

describe('createPool', () => {
  it('throws a clear error when given neither a connectionString nor a host', () => {
    expect(() => createPool({})).toThrow(/WAZIR_DATABASE_URL/);
  });
});
