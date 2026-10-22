import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { injectFault } from './faultInjection.js';

export interface StoreEntry {
  key: string;
  value: unknown;
}

export interface KeyValueStore {
  update?<T>(key: string, mutate: (current: T | undefined) => T): Promise<T>;
  put(key: string, value: unknown): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  list(prefix: string): Promise<StoreEntry[]>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * A lock older than this *and* whose holder is not a live process is assumed to
 * belong to a process that crashed while holding it (killed worker, `kill -9`,
 * power loss) and is force-cleared so the store never deadlocks on a dead
 * holder. A live holder's lock is never stolen, however old: two writers
 * inside the critical section rewrite the whole file from different
 * snapshots, and one of them silently loses its update.
 */
const LOCK_STALE_AFTER_MS = 30_000;

/** Inspects a lock file's holder PID when it belongs to another process. */
async function inspectForeignHolder(lockFile: string): Promise<{ livePid?: number; deadForeignPid?: number }> {
  const content = await fs.readFile(lockFile, 'utf8').catch(() => '');
  if (!content.includes('\n')) return {};
  const pid = Number.parseInt(content.split('\n')[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return {};
  try {
    process.kill(pid, 0);
    return { livePid: pid };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? { livePid: pid } : { deadForeignPid: pid };
  }
}
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
  // Identifies this acquisition, so release never deletes a lock someone else now holds.
  const token = `${process.pid}\n${new Date().toISOString()}\n${randomBytes(8).toString('hex')}\n`;
  let blockedBy: number | undefined;
  for (;;) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(token);
      await handle.close();
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows can report EPERM for open('wx') when another process has
      // already created the lock file. Treat it as contention only when the
      // path exists; a genuine permission failure must still surface.
      const windowsLockContention = code === 'EPERM' && process.platform === 'win32'
        && await fs.stat(lockFile).then(() => true).catch(() => false);
      if (code !== 'EEXIST' && !windowsLockContention) throw error;
      const staleSince = await fs.stat(lockFile).then((s) => s.mtimeMs).catch(() => undefined);
      const old = staleSince !== undefined && Date.now() - staleSince > LOCK_STALE_AFTER_MS;
      const holder = await inspectForeignHolder(lockFile);
      blockedBy = holder.livePid;
      if (holder.deadForeignPid !== undefined || (old && blockedBy === undefined)) {
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
        throw new Error(`timed out waiting for lock '${lockFile}' (held for over ${LOCK_MAX_WAIT_MS}ms` +
          `${blockedBy ? ` by live process ${blockedBy}, which is never stolen from; stop that process if it is hung` : ''})`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    const current = await fs.readFile(lockFile, 'utf8').catch(() => undefined);
    if (current === token) await fs.unlink(lockFile).catch(() => undefined);
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

/**
 * Fsyncs a directory so a prior rename()'s directory-entry update is durable
 * on disk, not just visible to this process. Windows has no directory file
 * descriptors to sync (NTFS's own metadata journal covers this instead), so
 * this is a deliberate no-op there rather than a platform gap.
 */
async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort: some filesystems (overlayfs, certain network mounts)
    // refuse to open a directory for reading, or don't support fsync on
    // one. The rename itself already happened; this is defense in depth,
    // not the only thing standing between a write and data loss.
  }
}

export class MemoryStore implements KeyValueStore {
  private data = new Map<string, unknown>();

  async update<T>(key: string, mutate: (current: T | undefined) => T): Promise<T> {
    const value = mutate(structuredClone(this.data.get(key)) as T | undefined); this.data.set(key, structuredClone(value)); return structuredClone(value);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async list(prefix: string): Promise<StoreEntry[]> {
    return Array.from(this.data.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value: structuredClone(value) }));
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

function isIsoDateString(value: string): boolean {
  return (
    value.length >= 20 &&
    value.length <= 35 &&
    value.charCodeAt(4) === 45 &&
    value.charCodeAt(10) === 84 &&
    ISO_DATE_RE.test(value)
  );
}

function reviveDates(_key: string, value: unknown): unknown {
  return typeof value === 'string' && isIsoDateString(value) ? new Date(value) : value;
}

export function reviveDatesInPlace<T>(value: T): T {
  if (typeof value === 'string') {
    return (isIsoDateString(value) ? new Date(value) : value) as unknown as T;
  }
  if (!value || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item === 'string') {
        if (isIsoDateString(item)) value[i] = new Date(item);
      } else if (item && typeof item === 'object' && !(item instanceof Date)) {
        reviveDatesInPlace(item);
      }
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const k of Object.keys(record)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const v = record[k];
    if (typeof v === 'string') {
      if (isIsoDateString(v)) record[k] = new Date(v);
    } else if (v && typeof v === 'object' && !(v instanceof Date)) {
      reviveDatesInPlace(v);
    }
  }
  return value;
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
    return (isIsoDateString(value) ? new Date(value) : value) as unknown as T;
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

interface FileStatSnapshot {
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  size: bigint;
}

export class JsonFileStore implements KeyValueStore {
  private readonly file: string;
  private readonly lockFile: string;
  private data = new Map<string, unknown>();
  private revivedKeys = new Set<string>();
  private rawJsonByKey = new Map<string, string>();
  private lastStat?: FileStatSnapshot;
  private loaded = false;
  private observedFile = false;

  constructor(file: string) {
    this.file = file;
    this.lockFile = `${file}.lock`;
  }

  private ensureKeyRevived(data: Map<string, unknown>, key: string): unknown {
    if (!data.has(key)) return undefined;
    if (data === this.data && this.revivedKeys.has(key)) {
      return data.get(key);
    }
    const revived = reviveDatesInPlace(data.get(key));
    data.set(key, revived);
    if (data === this.data) {
      this.revivedKeys.add(key);
    }
    return revived;
  }

  private async currentStat(): Promise<FileStatSnapshot | undefined> {
    try {
      const st = await fs.stat(this.file, { bigint: true });
      return { ino: st.ino, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, size: st.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.observedFile) {
        return undefined;
      }
      throw error;
    }
  }

  private statMatches(st: FileStatSnapshot | undefined): boolean {
    return Boolean(
      this.loaded &&
      this.lastStat &&
      st &&
      st.ino === this.lastStat.ino &&
      st.mtimeNs === this.lastStat.mtimeNs &&
      st.ctimeNs === this.lastStat.ctimeNs &&
      st.size === this.lastStat.size,
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.reloadFromDisk();
    this.loaded = true;
  }

  private async reloadFromDisk(): Promise<void> {
    const st = await this.currentStat();
    if (!st) {
      this.data = new Map();
      this.revivedKeys.clear();
      this.rawJsonByKey.clear();
      this.lastStat = undefined;
      this.loaded = true;
      return;
    }
    if (this.statMatches(st)) {
      return;
    }
    this.data = await this.readFromDisk(st);
    this.loaded = true;
  }

  /** A fresh copy of the file. Writers mutate their own copy: a concurrent read that
   *  refreshed a shared map mid-write made the writer persist the pre-mutation snapshot
   *  and still report success. */
  private async readFromDisk(knownStat?: FileStatSnapshot): Promise<Map<string, unknown>> {
    try {
      const st = knownStat ?? (await this.currentStat());
      if (!st) {
        this.revivedKeys.clear();
        this.rawJsonByKey.clear();
        this.lastStat = undefined;
        return new Map();
      }
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Invalid store document '${this.file}': expected an object`);
      }
      this.observedFile = true;
      this.revivedKeys.clear();
      this.rawJsonByKey.clear();
      this.lastStat = st;
      return new Map(Object.entries(parsed));
    } catch (error) {
      // Only an absent first-run store is empty. Corruption, access failures,
      // or loss of a previously observed store must never erase execution facts.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.observedFile) {
        this.revivedKeys.clear();
        this.rawJsonByKey.clear();
        this.lastStat = undefined;
        return new Map();
      }
      this.lastStat = undefined;
      throw error;
    }
  }

  private serializeMap(data: Map<string, unknown>, mutatedKey?: string): string {
    if (mutatedKey === '*') {
      this.rawJsonByKey.clear();
    } else if (mutatedKey !== undefined) {
      this.rawJsonByKey.delete(mutatedKey);
    }
    for (const cachedKey of this.rawJsonByKey.keys()) {
      if (!data.has(cachedKey)) {
        this.rawJsonByKey.delete(cachedKey);
      }
    }
    for (const [k, v] of data) {
      if (!this.rawJsonByKey.has(k)) {
        this.rawJsonByKey.set(k, `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
      }
    }
    if (data.size === 0) return '{}';
    const lines: string[] = [];
    for (const k of data.keys()) {
      const entry = this.rawJsonByKey.get(k);
      if (entry !== undefined) lines.push(entry);
    }
    return `{\n${lines.join(',\n')}\n}`;
  }

  private async persist(data: Map<string, unknown>, mutatedKey?: string): Promise<void> {
    const dir = path.dirname(this.file);
    await ensurePrivateDir(dir);
    // The store holds prompts, tool output and policy decisions for every
    // execution — owner-only from the first byte, not the umask default.
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    // write -> fsync(tmp) -> rename -> fsync(dir): a bare writeFile+rename
    // (the previous implementation) can leave an empty or truncated file on
    // crash/power loss — the OS is free to reorder or delay when tmp's
    // *contents* actually reach disk relative to when writeFile() returns,
    // and separately, the rename's directory-entry update needs its own
    // fsync to be durable (journaling filesystems commit metadata and data
    // on independent schedules). Neither step alone is sufficient.
    const serialized = this.serializeMap(data, mutatedKey);
    const handle = await fs.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await injectFault('DURING_STORE_WRITE', { filePath: this.file, tmp });
    let renameErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rename(tmp, this.file);
        renameErr = undefined;
        break;
      } catch (err) {
        renameErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt < 4 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    if (renameErr) throw renameErr;
    await fs.chmod(this.file, 0o600).catch(() => undefined);
    await fsyncDir(dir);
    this.observedFile = true;
    this.lastStat = await this.currentStat().catch(() => undefined);
  }

  private async withLock(mutate: (data: Map<string, unknown>) => void, mutatedKey?: string): Promise<void> {
    // The lock file lives next to the data file, which may not exist yet on
    // a fresh install (e.g. the first-ever write to ~/.wazir/wazir.json) —
    // `persist()` below creates this directory too, but that's too late:
    // acquiring the lock itself needs it to exist first, or `fs.open(lockFile,
    // 'wx')` fails with ENOENT before `persist()` ever runs.
    await ensurePrivateDir(path.dirname(this.file));
    await withFileLock(this.lockFile, async () => {
      const st = await this.currentStat();
      let data: Map<string, unknown>;
      if (this.statMatches(st)) {
        data = new Map(this.data);
      } else {
        data = await this.readFromDisk(st);
      }
      mutate(data);
      await this.persist(data, mutatedKey);
      this.data = data;
      this.loaded = true;
    });
  }

  async update<T>(key: string, mutate: (current: T | undefined) => T): Promise<T> {
    let value!: T;
    await this.withLock((data) => {
      const current = this.revivedKeys.has(key) ? data.get(key) : reviveDatesInPlace(data.get(key));
      value = mutate(current as T | undefined);
      data.set(key, value);
      this.revivedKeys.add(key);
    }, key);
    return value;
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.withLock((data) => {
      data.set(key, value);
      this.revivedKeys.add(key);
    }, key);
  }

  async get<T>(key: string): Promise<T | undefined> {
    await this.reloadFromDisk();
    return this.ensureKeyRevived(this.data, key) as T | undefined;
  }

  async list(prefix: string): Promise<StoreEntry[]> {
    await this.reloadFromDisk();
    const entries: StoreEntry[] = [];
    for (const key of this.data.keys()) {
      if (key.startsWith(prefix)) {
        entries.push({ key, value: this.ensureKeyRevived(this.data, key) });
      }
    }
    return entries;
  }

  async delete(key: string): Promise<void> {
    await this.withLock((data) => {
      data.delete(key);
      this.revivedKeys.delete(key);
    }, key);
  }

  async clear(): Promise<void> {
    await this.withLock((data) => {
      data.clear();
      this.revivedKeys.clear();
    }, '*');
  }
}
