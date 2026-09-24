import { isDeepStrictEqual } from 'node:util';
import type { KeyValueStore } from '@wazir/shared';
import type { ExecutionRecord } from '../types/execution.js';

// Compare storage values, not JS-only details lost by the JSON/Postgres adapters
// (undefined properties and Date prototypes). Object key order is immaterial.
function persistedValue(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function executionValuesEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(persistedValue(left), persistedValue(right));
}

/** Extend the existing atomic store; never allow a stale writer to replace history. */
export async function persistExecutionRecord(
  store: KeyValueStore,
  key: string,
  record: ExecutionRecord,
): Promise<void> {
  if (!store.update) throw new Error('Execution persistence requires atomic store.update');
  await store.update<ExecutionRecord>(key, current => {
    if ((record.storageRevision ?? 0) !== (current?.storageRevision ?? 0) + 1) {
      // Keep the prefix (callers match on it); the rest makes a conflict explainable.
      const owner = current?.execution.owner;
      throw new Error(`EXECUTION_STORAGE_CONFLICT: ${record.execution.id} (writing revision ${record.storageRevision ?? 0}` +
        ` over stored revision ${current?.storageRevision ?? 0}${owner ? ` last written by pid ${owner.pid} on ${owner.host}` : ''})`);
    }
    if (current) {
      if (current.execution.id !== record.execution.id || current.events.length > record.events.length) {
        throw new Error(`EXECUTION_HISTORY_CONFLICT: ${record.execution.id}`);
      }
      for (let index = 0; index < current.events.length; index++) {
        const previous = current.events[index];
        const next = record.events[index];
        // Legacy envelopes may gain fields. Every previously stored fact must survive.
        for (const key of Object.keys(previous) as Array<keyof typeof previous>) {
          if (!executionValuesEqual(previous[key], next[key])) {
            throw new Error(`EXECUTION_HISTORY_CONFLICT: ${record.execution.id} event ${index + 1}`);
          }
        }
      }
    }
    return structuredClone(record);
  });
}
