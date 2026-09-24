import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeKeyringInSubprocess } from '../src/keyringBackend.js';
import { createSecretBroker } from '../src/secretBroker.js';

/**
 * Regression for the CLI startup hang: a keychain that can't answer (locked GNOME
 * keyring over SSH) blocked every `wa` command forever, because the self-test's
 * native call never returns. The probe now runs in a killable subprocess.
 */
describe('probeKeyringInSubprocess', () => {
  it('rejects, instead of hanging, when the keychain never answers', async () => {
    const started = Date.now();
    await expect(probeKeyringInSubprocess(500, 'setInterval(() => {}, 1000)')).rejects.toThrow('did not respond within 500ms');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('rejects when the probe fails', async () => {
    await expect(probeKeyringInSubprocess(5_000, 'process.exit(2)')).rejects.toThrow('OS keychain probe failed');
  });

  it('resolves when the probe completes', async () => {
    await expect(probeKeyringInSubprocess(5_000, 'process.exit(0)')).resolves.toBeUndefined();
  });
});

describe('createSecretBroker', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'wazir-secrets-')); });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

  it('falls back to the encrypted-file backend when the keychain probe times out', async () => {
    vi.stubEnv('WAZIR_SECRETS_BACKEND', ''); // exercise real selection, not the suite-wide override
    const broker = await createSecretBroker({ secretsDir: dir, keyringProbe: () => probeKeyringInSubprocess(300, 'setInterval(() => {}, 1000)') });
    expect(broker.backendName).toBe('encrypted-file');
    await broker.putCredential('k', 'v');
    expect(await broker.getCredential('k')).toBe('v');
  });
});
