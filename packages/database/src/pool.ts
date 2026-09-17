import { Pool, type PoolConfig } from 'pg';

export interface PostgresConnectionOptions extends PoolConfig {
  connectionString?: string;
}

/** Creates a pg connection pool. Callers own its lifecycle — call `pool.end()` on shutdown. */
export function createPool(options: PostgresConnectionOptions): Pool {
  if (!options.connectionString && !options.host) {
    throw new Error('createPool requires a connectionString (or host) — set WAZIR_DATABASE_URL');
  }
  return new Pool(options);
}

export interface PostgresHealth {
  ok: boolean;
  version?: string;
  error?: string;
}

/** Verifies the pool can actually reach and query the database. */
export async function checkHealth(pool: Pool): Promise<PostgresHealth> {
  try {
    const result = await pool.query('SELECT version()');
    return { ok: true, version: result.rows[0]?.version };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
