export interface MemoryEntry<T> {
  value: T;
  expiresAt?: number;
}

export * from './memoryService.js';

/** In-memory key-value store with optional TTL. Deterministic eviction by expiry. */
export class InMemoryStore<T = unknown> {
  private data = new Map<string, MemoryEntry<T>>();

  set(key: string, value: T, ttlMs?: number): void {
    this.data.set(key, {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined,
    });
  }

  get(key: string): T | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.data.delete(key);
  }

  keys(): string[] {
    return Array.from(this.data.keys()).sort();
  }

  size(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }
}
