import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EncryptedFileBackend } from '../src/encryptedFileBackend.js';

// Test #23: concurrent login attempts cannot overwrite each other's state.
// Two independent SecretBroker/backend instances (as two separate `wa auth
// login` process invocations would be) racing writes to different providers
// against the same secretsDir must not lose either write, and the file must
// stay valid JSON throughout — a naive read-modify-write without the
// advisory lock in EncryptedFileBackend.withLock() would drop one of these.
describe('EncryptedFileBackend — concurrent writers', () => {
  it('two backends racing writes to different providers both land, none lost', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-secrets-race-'));
    const backendA = new EncryptedFileBackend(dir);
    const backendB = new EncryptedFileBackend(dir);

    await Promise.all([
      backendA.set('anthropic', 'anthropic-secret-value'),
      backendB.set('openai', 'openai-secret-value'),
      backendA.set('google', 'google-secret-value-a'),
      backendB.set('google', 'google-secret-value-b'),
    ]);

    // The file must be intact, valid JSON at every point — never partially
    // written or corrupted by two writers racing the same rename target.
    const raw = await fs.readFile(path.join(dir, 'credentials.enc.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();

    expect(await backendA.get('anthropic')).toBe('anthropic-secret-value');
    expect(await backendA.get('openai')).toBe('openai-secret-value');
    // Last-writer-wins on a single key racing is acceptable; it must be one
    // of the two values, not corrupted or lost entirely.
    expect(['google-secret-value-a', 'google-secret-value-b']).toContain(await backendA.get('google'));
  });

  it('many concurrent writes to distinct keys are all preserved', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-secrets-race-many-'));
    const backend = new EncryptedFileBackend(dir);

    const keys = Array.from({ length: 12 }, (_, i) => `provider-${i}`);
    await Promise.all(keys.map((key) => backend.set(key, `secret-for-${key}`)));

    for (const key of keys) {
      expect(await backend.get(key)).toBe(`secret-for-${key}`);
    }
  });
});
