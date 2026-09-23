import type { Pool } from 'pg';
import { reviveDatesDeep, type KeyValueStore, type StoreEntry } from '@wazir/shared';

/**
 * A `KeyValueStore` backed by Postgres instead of a local JSON file — the
 * same contract `JsonFileStore`/`MemoryStore` implement, so anything that
 * currently takes a `KeyValueStore` (the CLI's `ExecutionEngine`, the
 * registries, etc.) can point at Postgres for a shared, multi-machine
 * deployment with no other code changes.
 *
 * Requires `runKvMigration(pool)` (see migrate.ts) to have created
 * `wazir_kv_store` first.
 */
export class PostgresStore implements KeyValueStore {
  constructor(private readonly pool: Pool) {}

  async update<T>(key: string, mutate: (current: T | undefined) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      const result = await client.query('SELECT value FROM wazir_kv_store WHERE key = $1', [key]);
      const value = mutate(result.rows[0] ? reviveDatesDeep(result.rows[0].value) as T : undefined);
      await client.query(`INSERT INTO wazir_kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(value)]);
      await client.query('COMMIT'); return value;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO wazir_kv_store (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)],
    );
  }

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.pool.query<{ value: T }>('SELECT value FROM wazir_kv_store WHERE key = $1', [key]);
    const value = result.rows[0]?.value;
    // `pg` parses JSONB with its own internal JSON.parse (no reviver hook),
    // so Date fields need reviving after the fact — see reviveDatesDeep's doc.
    return value === undefined ? undefined : reviveDatesDeep(value);
  }

  async list(prefix: string): Promise<StoreEntry[]> {
    const result = await this.pool.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM wazir_kv_store WHERE key LIKE $1 ORDER BY key',
      [`${escapeLike(prefix)}%`],
    );
    return result.rows.map((row) => ({ key: row.key, value: reviveDatesDeep(row.value) }));
  }

  async delete(key: string): Promise<void> {
    await this.pool.query('DELETE FROM wazir_kv_store WHERE key = $1', [key]);
  }

  async clear(): Promise<void> {
    await this.pool.query('TRUNCATE wazir_kv_store');
  }
}

/** Escapes `%` and `_` so a prefix containing them is matched literally, not as a LIKE wildcard. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
