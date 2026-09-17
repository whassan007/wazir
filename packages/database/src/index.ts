/**
 * @wazir/database — PostgreSQL backend for deployments that want a shared
 * database instead of the local JSON file store (see @wazir/shared's
 * JsonFileStore). Two things live here:
 *
 * 1. `schema.sql` — the reference fully-normalized relational DDL (computers,
 *    tasks, executions, ...). Nothing in this repo writes to it yet; it
 *    documents the schema a future ORM-backed persistence layer would map
 *    domain types onto.
 * 2. `PostgresStore` — a `KeyValueStore` implementation (same contract as
 *    `JsonFileStore`/`MemoryStore`) backed by a minimal `wazir_kv_store`
 *    table (`kv-schema.sql`), wired with real connection/query code. This is
 *    what's actually usable today: point `WAZIR_DATABASE_URL` at Postgres
 *    and anything that takes a `KeyValueStore` works unchanged.
 */
export { SCHEMA_FILE, KV_SCHEMA_FILE, runKvMigration } from './migrate.js';
export { createPool, checkHealth, type PostgresConnectionOptions, type PostgresHealth } from './pool.js';
export { PostgresStore } from './postgresStore.js';

export interface SchemaInfo {
  dialect: 'postgresql';
  version: string;
}

export const schemaInfo: SchemaInfo = {
  dialect: 'postgresql',
  version: '0.1.0',
};
