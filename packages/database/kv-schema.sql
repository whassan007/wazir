-- ==================== KEY/VALUE STORE (for PostgresStore) ====================
-- This is intentionally NOT the fully-normalized schema in schema.sql.
-- schema.sql documents the reference relational design a future ORM-backed
-- persistence layer would map every domain type onto; nothing in this repo
-- writes to it yet. This table is the minimal, already-wired backend behind
-- @wazir/database's PostgresStore, which implements the exact same
-- KeyValueStore contract as @wazir/shared's JsonFileStore/MemoryStore — so a
-- distributed deployment can point ExecutionEngine, the job/computer/model
-- registries, etc. at Postgres instead of a local JSON file with no other
-- code changes.

CREATE TABLE IF NOT EXISTS wazir_kv_store (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- `list(prefix)` filters with `key LIKE prefix || '%'`; this index keeps
-- that a range scan instead of a sequential scan as the table grows.
CREATE INDEX IF NOT EXISTS idx_wazir_kv_store_key_prefix ON wazir_kv_store (key text_pattern_ops);
