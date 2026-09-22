import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, createSecretBroker } from '../src/secretBroker.js';
import { EncryptedFileBackend } from '../src/encryptedFileBackend.js';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wazir-secrets-'));
}

describe('SecretBroker', () => {
  it('stores, reads, and deletes a credential by key', async () => {
    const broker = new SecretBroker(new EncryptedFileBackend(await tempDir()));
    expect(await broker.getCredential('anthropic')).toBeUndefined();

    await broker.putCredential('anthropic', 'secret-value-1');
    expect(await broker.getCredential('anthropic')).toBe('secret-value-1');

    expect(await broker.deleteCredential('anthropic')).toBe(true);
    expect(await broker.getCredential('anthropic')).toBeUndefined();
  });

  it('logout/delete removes only the selected provider credential, never another', async () => {
    const broker = new SecretBroker(new EncryptedFileBackend(await tempDir()));
    await broker.putCredential('anthropic', 'anthropic-secret');
    await broker.putCredential('openai', 'openai-secret');

    await broker.deleteCredential('anthropic');

    expect(await broker.getCredential('anthropic')).toBeUndefined();
    expect(await broker.getCredential('openai')).toBe('openai-secret');
  });

  it('listKeys() reveals which providers are configured, never the secret values', async () => {
    const broker = new SecretBroker(new EncryptedFileBackend(await tempDir()));
    await broker.putCredential('anthropic', 'super-secret-key-value');
    await broker.putCredential('google', 'another-secret-value');

    const keys = await broker.listKeys();
    expect(keys.sort()).toEqual(['anthropic', 'google']);
    expect(JSON.stringify(keys)).not.toContain('super-secret-key-value');
    expect(JSON.stringify(keys)).not.toContain('another-secret-value');
  });

  it('deleting an unknown key returns false without throwing', async () => {
    const broker = new SecretBroker(new EncryptedFileBackend(await tempDir()));
    expect(await broker.deleteCredential('openai')).toBe(false);
  });

  it('createSecretBroker() falls back to the encrypted-file backend when the OS keychain is unavailable', async () => {
    // No real OS keychain exists in this CI/sandboxed environment (no Secret
    // Service, no @napi-rs/keyring prebuilt binary guaranteed) — this exercises
    // the actual fallback path createSecretBroker() takes on such hosts.
    const dir = await tempDir();
    const broker = await createSecretBroker({ secretsDir: dir });
    expect(broker.backendName).toBe('encrypted-file');

    await broker.putCredential('openai', 'sk-test-1234');
    expect(await broker.getCredential('openai')).toBe('sk-test-1234');
  });
});

describe('EncryptedFileBackend', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });

  it('persists across separate instances pointed at the same directory (durability)', async () => {
    const first = new EncryptedFileBackend(dir);
    await first.set('anthropic', 'persisted-value');

    const second = new EncryptedFileBackend(dir);
    expect(await second.get('anthropic')).toBe('persisted-value');
  });

  it('never writes the plaintext secret value anywhere on disk', async () => {
    const backend = new EncryptedFileBackend(dir);
    await backend.set('anthropic', 'sk-ant-super-secret-marker');

    const files = await fs.readdir(dir);
    for (const file of files) {
      const stat = await fs.stat(path.join(dir, file));
      if (!stat.isFile()) continue;
      const content = await fs.readFile(path.join(dir, file), 'utf8').catch(() => '');
      expect(content).not.toContain('sk-ant-super-secret-marker');
    }
  });

  it('sets directory mode 0700 and file mode 0600', async () => {
    const backend = new EncryptedFileBackend(dir);
    await backend.set('anthropic', 'value');

    const dirStat = await fs.stat(dir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const filePath = path.join(dir, 'credentials.enc.json');
    const fileStat = await fs.stat(filePath);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it('a corrupted/hand-edited file does not throw — get() returns undefined for the unreadable entry', async () => {
    const backend = new EncryptedFileBackend(dir);
    await backend.set('anthropic', 'value');
    // Corrupt the ciphertext directly, simulating hand-editing or bit rot.
    const filePath = path.join(dir, 'credentials.enc.json');
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    raw.anthropic.ciphertext = Buffer.from('not the real ciphertext').toString('base64');
    await fs.writeFile(filePath, JSON.stringify(raw));

    await expect(backend.get('anthropic')).resolves.toBeUndefined();
  });
});
