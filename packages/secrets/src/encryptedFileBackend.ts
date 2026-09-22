import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SecretBackend } from './backend.js';

interface EncryptedEntry {
  iv: string;
  authTag: string;
  ciphertext: string;
}

type EncryptedFile = Record<string, EncryptedEntry>;

const ALGO = 'aes-256-gcm';

function encrypt(key: Buffer, plaintext: string): EncryptedEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function decrypt(key: Buffer, entry: EncryptedEntry): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(entry.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(entry.authTag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Fallback secret store used when no OS keychain is available (headless
 * Linux without a Secret Service, sandboxed/CI environments, or the
 * `@napi-rs/keyring` native addon failing to load). AES-256-GCM at rest,
 * directory mode 0700 / file mode 0600 — the same protection level as the
 * existing audit log (`packages/shared/src/audit.ts`).
 *
 * This defends against another local user or a stray backup copy reading
 * the file; it does not defend against a compromise of this process or
 * host, which is a materially weaker guarantee than a real OS keychain.
 * `wa auth login`'s output should say so plainly when this backend is in use.
 */
export class EncryptedFileBackend implements SecretBackend {
  readonly name = 'encrypted-file' as const;
  private readonly filePath: string;
  private readonly keyPath: string;
  private keyPromise?: Promise<Buffer>;

  constructor(secretsDir: string) {
    this.filePath = path.join(secretsDir, 'credentials.enc.json');
    this.keyPath = path.join(secretsDir, 'dek');
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
  }

  private async loadKey(): Promise<Buffer> {
    if (!this.keyPromise) {
      this.keyPromise = (async () => {
        await this.ensureDir();
        try {
          return Buffer.from(await fs.readFile(this.keyPath, 'utf8'), 'base64');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          // Exclusive create ('wx'): two backend instances racing first-ever
          // key creation (e.g. two `wa auth login` invocations for different
          // providers) must never end up with two DIFFERENT keys — that would
          // silently make each instance unable to decrypt the other's entries
          // even though they share one credentials file. The loser of the
          // race falls through to re-reading the winner's key instead of
          // generating its own.
          const key = randomBytes(32);
          try {
            await fs.writeFile(this.keyPath, key.toString('base64'), { flag: 'wx', mode: 0o600 });
            await fs.chmod(this.keyPath, 0o600).catch(() => undefined);
            return key;
          } catch (writeError) {
            if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
            return Buffer.from(await fs.readFile(this.keyPath, 'utf8'), 'base64');
          }
        }
      })();
    }
    return this.keyPromise;
  }

  private async readFile(): Promise<EncryptedFile> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as EncryptedFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  /** Atomic: write to a temp file then rename, so a reader can never observe
   *  a partially-written or corrupted file. Does not by itself protect a
   *  concurrent read-modify-write against another writer — see `withLock`. */
  private async writeFile(data: EncryptedFile): Promise<void> {
    await this.ensureDir();
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.chmod(tmpPath, 0o600).catch(() => undefined);
    await fs.rename(tmpPath, this.filePath);
  }

  /** Advisory cross-process lock (exclusive-create lockfile with retry) around
   *  a read-modify-write cycle. Without this, two `wa auth login` invocations
   *  for different providers racing each other could both read the file before
   *  either writes, and the second write would silently discard the first's
   *  credential — the atomic rename in `writeFile` only guarantees the file is
   *  never corrupted, not that concurrent updates are preserved. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureDir();
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const handle = await fs.open(lockPath, 'wx');
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 20));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }

  async get(key: string): Promise<string | undefined> {
    const data = await this.readFile();
    const entry = data[key];
    if (!entry) return undefined;
    try {
      return decrypt(await this.loadKey(), entry);
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const dek = await this.loadKey();
    await this.withLock(async () => {
      const data = await this.readFile();
      data[key] = encrypt(dek, value);
      await this.writeFile(data);
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.withLock(async () => {
      const data = await this.readFile();
      if (!(key in data)) return false;
      delete data[key];
      await this.writeFile(data);
      return true;
    });
  }

  async list(): Promise<string[]> {
    return Object.keys(await this.readFile()).sort();
  }
}
