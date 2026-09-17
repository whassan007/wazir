import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';

/**
 * The .sql files are never compiled, so they're never copied into dist/ —
 * they only ever exist at the package root. But __dirname's distance from
 * the package root differs by how this module is loaded: compiled output
 * runs from dist/src/migrate.js (two levels up to the package root), while
 * vitest/ts-node run this file directly from src/migrate.ts (one level up).
 * Try both rather than hardcoding one depth and breaking the other caller.
 */
function resolveSchemaFile(name: string): string {
  const fromCompiledDist = path.join(__dirname, '..', '..', name);
  if (existsSync(fromCompiledDist)) return fromCompiledDist;
  const fromSourceRun = path.join(__dirname, '..', name);
  if (existsSync(fromSourceRun)) return fromSourceRun;
  // Neither exists (e.g. a fresh checkout before `npm run build`) — return
  // the production-shaped path so the resulting ENOENT points somewhere sensible.
  return fromCompiledDist;
}

export const KV_SCHEMA_FILE = resolveSchemaFile('kv-schema.sql');
export const SCHEMA_FILE = resolveSchemaFile('schema.sql');

/**
 * Applies `kv-schema.sql` (the KeyValueStore-backing table `PostgresStore`
 * needs). Idempotent — the DDL uses `CREATE TABLE IF NOT EXISTS` / `CREATE
 * INDEX IF NOT EXISTS`, so running this against an already-migrated database
 * is a safe no-op.
 */
export async function runKvMigration(pool: Pool): Promise<void> {
  const sql = await fs.readFile(KV_SCHEMA_FILE, 'utf8');
  await pool.query(sql);
}
