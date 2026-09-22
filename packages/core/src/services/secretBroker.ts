import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { sanitizeUntrustedOutput } from '@wazir/shared';

export interface SecretBroker {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  redact(text: string): string;
}

/** Shared credential boundary. The model and ordinary configuration never receive values.
 * env:NAME references are resolved without copying the whole process environment.
 * Local entries use authenticated encryption with a private, per-install key.
 */
export class LocalSecretBroker implements SecretBroker {
  private known = new Set<string>();
  constructor(private readonly directory: string) {}
  private file(ref: string): string {
    if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(ref)) throw new Error('Invalid secret reference');
    return path.join(this.directory, `${ref}.enc`);
  }
  private async key(): Promise<Buffer> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, '.key');
    try { await fs.writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const key = await fs.readFile(file);
    if (key.length !== 32) throw new Error('Invalid secret broker key');
    return key;
  }
  async get(ref: string): Promise<string | undefined> {
    let value: string | undefined;
    if (ref.startsWith('env:')) {
      const name = ref.slice(4);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid environment reference');
      value = process.env[name];
    } else {
      const file = this.file(ref);
      let data: Buffer;
      try { data = await fs.readFile(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
      const decipher = createDecipheriv('aes-256-gcm', await this.key(), data.subarray(0, 12));
      decipher.setAAD(Buffer.from(ref));
      decipher.setAuthTag(data.subarray(12, 28));
      value = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    }
    if (value) this.known.add(value);
    return value;
  }
  async set(ref: string, value: string): Promise<void> {
    const file = this.file(ref);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.key(), iv);
    cipher.setAAD(Buffer.from(ref));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    await fs.writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
    this.known.add(value);
  }
  async delete(ref: string): Promise<void> {
    await fs.unlink(this.file(ref)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  redact(text: string): string {
    for (const secret of [...this.known].sort((a, b) => b.length - a.length)) {
      text = text.split(secret).join('[REDACTED]');
    }
    return sanitizeUntrustedOutput(text);
  }
}
