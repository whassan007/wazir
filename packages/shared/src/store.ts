import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface StoreEntry {
  key: string;
  value: unknown;
}

export interface KeyValueStore {
  put(key: string, value: unknown): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  list(prefix: string): Promise<StoreEntry[]>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStore implements KeyValueStore {
  private data = new Map<string, unknown>();

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async list(prefix: string): Promise<StoreEntry[]> {
    return Array.from(this.data.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }
}

/**
 * Durable JSON file store. Atomic writes (tmp + rename), no external
 * dependencies. Sufficient for local execution history and registries.
 */
export class JsonFileStore implements KeyValueStore {
  private readonly file: string;
  private data = new Map<string, unknown>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        this.data.set(key, value);
      }
    } catch {
      // missing or corrupt file starts empty
    }
    this.loaded = true;
  }

  private scheduleWrite(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const dir = path.dirname(this.file);
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.data), null, 2), 'utf8');
      await fs.rename(tmp, this.file);
    });
    return this.writeChain;
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.ensureLoaded();
    this.data.set(key, value);
    await this.scheduleWrite();
  }

  async get<T>(key: string): Promise<T | undefined> {
    await this.ensureLoaded();
    return this.data.get(key) as T | undefined;
  }

  async list(prefix: string): Promise<StoreEntry[]> {
    await this.ensureLoaded();
    return Array.from(this.data.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }

  async delete(key: string): Promise<void> {
    await this.ensureLoaded();
    this.data.delete(key);
    await this.scheduleWrite();
  }

  async clear(): Promise<void> {
    await this.ensureLoaded();
    this.data.clear();
    await this.scheduleWrite();
  }
}
