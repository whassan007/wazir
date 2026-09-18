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
      const handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const staleSince = await fs.stat(lockFile).then((s) => s.mtimeMs).catch(() => undefined);
      if (staleSince !== undefined && Date.now() - staleSince > LOCK_STALE_AFTER_MS) {
        // Steal the stale lock with an atomic rename rather than unlink: if
        // two waiters both observe the same stale lock, only one rename can
        // succeed, so only one of them proceeds to re-acquire — a bare
        // `unlink` let both clear it and both win `open('wx')` back to back.
        const stolen = `${lockFile}.stale.${process.pid}.${Date.now()}`;
        const won = await fs.rename(lockFile, stolen).then(() => true).catch(() => false);
        if (won) {
          await fs.unlink(stolen).catch(() => undefined);
          continue; // retry immediately now that the stale lock is cleared
        }
        // Another process stole it first; fall through and wait our turn.
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

/**
 * Creates `dir` owner-only (0700). An existing directory is only tightened
 * when it is Wazir's own home (`~/.wazir` / legacy `~/.rook`): callers may
 * point a store at a shared location such as a temp dir, and chmod-ing that
 * would be a surprising side effect.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const base = path.basename(dir);
  if (base !== '.wazir' && base !== '.rook') return;
  const stat = await fs.stat(dir).catch(() => undefined);
  if (stat && (stat.mode & 0o077) !== 0) {
    await fs.chmod(dir, 0o700).catch(() => undefined);
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
/**
 * Matches what `Date.prototype.toJSON`/`JSON.stringify` produce for a Date —
 * used to revive Dates on the way back in, since JSON itself has no Date
 * type. Without this, every `Date` field in anything stored here (Block,
 * ExecutionRecord, Job, ...) silently becomes a plain string the moment a
 * process restarts and reloads from disk — code that calls `.getTime()` or
 * similar on it without re-wrapping in `new Date(...)` first then crashes,
 * only in the "reloaded from a previous run" case, never in the same
 * process that wrote it. Found via `wa executions list` and `wa explain
 * @job:x` both crashing on `b.execution.createdAt.getTime is not a
 * function` after a restart.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function reviveDates(_key: string, value: unknown): unknown {
  return typeof value === 'string' && ISO_DATE_RE.test(value) ? new Date(value) : value;
}

/**
 * Same date revival as `reviveDates` above, but as a post-hoc recursive walk
 * instead of a `JSON.parse` reviver hook — for backends like `PostgresStore`
 * whose JSONB values arrive already parsed by the driver (`pg` calls
 * `JSON.parse` internally with no reviver option), so there's no hook to
 * intercept during parsing itself.
 */
export function reviveDatesDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return (ISO_DATE_RE.test(value) ? new Date(value) : value) as unknown as T;
  }
  if (value instanceof Date) {
    // Already a real Date (e.g. a value that never left this process) — a
    // Date's data lives internally, not as enumerable own properties, so
    // falling through to the generic object branch below would destructure
    // it into `{}`.
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => reviveDatesDeep(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // `out['__proto__'] = ...` would re-parent `out` instead of adding a
      // field; keys that reach into the prototype chain are dropped.
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = reviveDatesDeep(v);
    }
    return out as T;
  }
  return value;
}

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
      const parsed = JSON.parse(raw, reviveDates) as Record<string, unknown>;
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
    await ensurePrivateDir(dir);
    // The store holds prompts, tool output and policy decisions for every
    // execution — owner-only from the first byte, not the umask default.
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.data), null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600).catch(() => undefined);
  }

  private async withLock(mutate: () => void): Promise<void> {
    // The lock file lives next to the data file, which may not exist yet on
    // a fresh install (e.g. the first-ever write to ~/.wazir/wazir.json) —
    // `persist()` below creates this directory too, but that's too late:
    // acquiring the lock itself needs it to exist first, or `fs.open(lockFile,
    // 'wx')` fails with ENOENT before `persist()` ever runs.
    await ensurePrivateDir(path.dirname(this.file));
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
