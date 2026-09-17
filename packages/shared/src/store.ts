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

/**
 * A lock older than this is assumed to belong to a process that crashed
 * while holding it (killed worker, `kill -9`, power loss) rather than one
 * doing legitimately slow I/O, and is force-cleared so the store never
 * deadlocks permanently on a dead holder.
 */
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_MAX_WAIT_MS = 10_000;

/**
 * A dependency-free, cross-process advisory lock built on the atomicity of
 * `open(path, 'wx')` (fails with EEXIST if the file already exists — this is
 * the same primitive libraries like `proper-lockfile` use). Needed because
 * `JsonFileStore`'s own `writeChain` only serializes writers *within one
 * process*; the CLI, the API server, and any worker are separate OS
 * processes that can otherwise race a read-modify-write cycle on the same
 * file and silently drop each other's update.
 */
async function withFileLock<T>(lockFile: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lockFile, 'wx');
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const staleSince = await fs.stat(lockFile).then((s) => s.mtimeMs).catch(() => undefined);
      if (staleSince !== undefined && Date.now() - staleSince > LOCK_STALE_AFTER_MS) {
        await fs.unlink(lockFile).catch(() => undefined);
        continue; // retry immediately now that the stale lock is cleared
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lock '${lockFile}' (held for over ${LOCK_MAX_WAIT_MS}ms)`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    await fs.unlink(lockFile).catch(() => undefined);
  }
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
 *
 * Safe for concurrent writers across processes: every mutation reloads the
 * freshest on-disk state while holding a cross-process file lock, mutates
 * it, and persists — so a `put`/`delete`/`clear` from the CLI and one from
 * the API server (or two worker processes) racing the same file cannot
 * silently drop each other's update. Plain reads (`get`/`list`) use the
 * last-loaded snapshot and do not take the lock, so they may observe a
 * slightly stale value if another process just wrote; that's an accepted
 * trade-off for a local-first store — only writes need strict ordering.
 */
export class JsonFileStore implements KeyValueStore {
  private readonly file: string;
  private readonly lockFile: string;
  private data = new Map<string, unknown>();
  private loaded = false;

  constructor(file: string) {
    this.file = file;
    this.lockFile = `${file}.lock`;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.reloadFromDisk();
    this.loaded = true;
  }

  private async reloadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      this.data = new Map(Object.entries(parsed));
    } catch {
      // Missing or corrupt file: start empty on first load. If we'd already
      // loaded successfully before, keep the in-memory copy rather than
      // discarding it over a transient read error mid-mutation.
      if (!this.loaded) this.data = new Map();
    }
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.data), null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }

  private async withLock(mutate: () => void): Promise<void> {
    await withFileLock(this.lockFile, async () => {
      await this.reloadFromDisk();
      mutate();
      await this.persist();
      this.loaded = true;
    });
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.withLock(() => this.data.set(key, value));
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
    await this.withLock(() => this.data.delete(key));
  }

  async clear(): Promise<void> {
    await this.withLock(() => this.data.clear());
  }
}
