# @wazir/database

Two things live here, deliberately not the same thing:

1. **`schema.sql`** — a fully-normalized reference relational schema (computers, tasks, executions, models, ...). Nothing in this repo writes to it. It documents the schema a future ORM-backed persistence layer would map domain types onto, if that's ever built.
2. **`PostgresStore`** — what's actually wired up and usable today. Implements the same `KeyValueStore` interface as `@wazir/shared`'s `JsonFileStore`/`MemoryStore`, backed by one table (`wazir_kv_store`, `kv-schema.sql`). This is a pragmatic choice: it matches how the app already persists data (namespaced JSON blobs — `execution/<id>`, `job/<id>`, `block/<id>`), so pointing `WAZIR_DATABASE_URL` at Postgres just works with zero other code changes, rather than requiring a full ORM mapping onto `schema.sql`'s normalized tables.

## Usage

```ts
import { createPool, runKvMigration, PostgresStore, checkHealth } from '@wazir/database';

const pool = createPool({ connectionString: process.env.WAZIR_DATABASE_URL });
await runKvMigration(pool);        // idempotent — CREATE TABLE IF NOT EXISTS
const store: KeyValueStore = new PostgresStore(pool);
```

`apps/cli/src/engine.ts`'s `createStore()` does exactly this when `WAZIR_DATABASE_URL` is set.

## Date handling

Postgres's JSONB round-trips through the `pg` driver's own internal `JSON.parse`, which has no reviver hook — without `PostgresStore` re-walking every read with `reviveDatesDeep` (from `@wazir/shared`), every `Date` field anywhere in the app would silently become a plain string the moment it round-tripped through Postgres. `JsonFileStore` has the equivalent fix via a `JSON.parse` reviver. Both are covered by tests that actually round-trip a `Date` through the real backend, not just assert the function exists.
