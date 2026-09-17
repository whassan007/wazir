import { describe, it, expect, afterEach } from 'vitest';
import { JsonFileStore, MemoryStore } from '@wazir/shared';
import { createStore } from '../src/engine.js';

/**
 * Verifies `createStore()` actually picks the backend its env vars say it
 * should, in priority order (WAZIR_DATABASE_URL > WAZIR_IN_MEMORY=1 >
 * default JSON file), and — for the Postgres case — that it isn't just
 * returning *a* PostgresStore but one that really persists through Postgres.
 * Skipped for the Postgres case when WAZIR_TEST_DATABASE_URL isn't set.
 */
describe('createStore', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of ['WAZIR_DATABASE_URL', 'WAZIR_IN_MEMORY']) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('defaults to JsonFileStore when no env vars are set', async () => {
    delete process.env.WAZIR_DATABASE_URL;
    delete process.env.WAZIR_IN_MEMORY;
    const store = await createStore();
    expect(store).toBeInstanceOf(JsonFileStore);
  });

  it('uses MemoryStore when WAZIR_IN_MEMORY=1', async () => {
    delete process.env.WAZIR_DATABASE_URL;
    process.env.WAZIR_IN_MEMORY = '1';
    const store = await createStore();
    expect(store).toBeInstanceOf(MemoryStore);
  });

  const connectionString = process.env.WAZIR_TEST_DATABASE_URL;

  describe.skipIf(!connectionString)('with WAZIR_DATABASE_URL set', () => {
    it('picks Postgres over WAZIR_IN_MEMORY=1 (database URL wins) and actually persists there', async () => {
      process.env.WAZIR_DATABASE_URL = connectionString;
      process.env.WAZIR_IN_MEMORY = '1'; // must lose to WAZIR_DATABASE_URL

      const store = await createStore();
      const key = `engine-wiring-test/${Date.now()}`;
      await store.put(key, { proof: 'real postgres round trip' });

      // Read the same key back through an independent PostgresStore built
      // directly from @wazir/database, bypassing createStore() entirely —
      // proving the data really landed in Postgres, not some other store
      // that merely satisfies the same interface.
      const { createPool, PostgresStore } = await import('@wazir/database');
      const pool = createPool({ connectionString });
      try {
        const directStore = new PostgresStore(pool);
        expect(await directStore.get(key)).toEqual({ proof: 'real postgres round trip' });
        await directStore.delete(key);
      } finally {
        await pool.end();
      }
    });
  });
});
