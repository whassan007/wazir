/**
 * @rook/database — reference PostgreSQL DDL for deployments that want a
 * shared database backend. Local installations use @rook/registry's
 * dependency-free JSON store instead (see packages/registry).
 *
 * The DDL lives in schema.sql (source of truth, unchanged).
 */
export const SCHEMA_FILE = new URL('../schema.sql', import.meta.url).pathname;

export interface SchemaInfo {
  dialect: 'postgresql';
  version: string;
}

export const schemaInfo: SchemaInfo = {
  dialect: 'postgresql',
  version: '0.1.0',
};
