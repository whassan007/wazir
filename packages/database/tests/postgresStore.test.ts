import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createPool, checkHealth, runKvMigration, PostgresStore } from '../src/index.js';

/**
 * Integration test against a real Postgres instance. Skipped by default —
 * set WAZIR_TEST_DATABASE_URL to a scratch database to run it (e.g. a local
 * `docker run --rm -e POSTGRES_PASSWORD=wazir -p 5432:5432 postgres:16-alpine`
 * and `WAZIR_TEST_DATABASE_URL=postgres://postgres:wazir@localhost:5432/postgres`).
 * This is deliberately not mocked: a fake pg client would only prove the
 * SQL strings compile, not that they're valid Postgres syntax or that the
 * KeyValueStore contract actually round-trips through a real database.
 */
const connectionString = process.env.WAZIR_TEST_DATABASE_URL;

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
});

describe('createPool', () => {
  it('throws a clear error when given neither a connectionString nor a host', () => {
    expect(() => createPool({})).toThrow(/WAZIR_DATABASE_URL/);
  });
});
