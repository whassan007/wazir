import type { ExecutionRecord } from '@rook/core';
import { MemoryStore, type KeyValueStore } from '@rook/shared';

const PREFIX = 'executions/';

export class ExecutionRepository {
  constructor(private readonly store: KeyValueStore) {}

  async save(record: ExecutionRecord): Promise<void> {
    await this.store.put(`${PREFIX}${record.execution.id}`, record);
  }

  async get(id: string): Promise<ExecutionRecord | undefined> {
    return this.store.get<ExecutionRecord>(`${PREFIX}${id}`);
  }

  async list(): Promise<ExecutionRecord[]> {
    const entries = await this.store.list(PREFIX);
    return entries
      .map((e) => e.value as ExecutionRecord)
      .sort((a, b) => b.execution.createdAt.getTime() - a.execution.createdAt.getTime());
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(`${PREFIX}${id}`);
  }

  async clear(): Promise<void> {
    const entries = await this.store.list(PREFIX);
    for (const entry of entries) {
      await this.store.delete(entry.key);
    }
  }
}

/** Thin persistence facade (kept for API compatibility with the original package). */
export class Database {
  readonly store: KeyValueStore;
  readonly executions: ExecutionRepository;

  constructor(store: KeyValueStore = new MemoryStore()) {
    this.store = store;
    this.executions = new ExecutionRepository(store);
  }
}
