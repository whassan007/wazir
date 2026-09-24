import path from 'node:path';
import os from 'node:os';
import type { SecretBackend } from './backend.js';
import { EncryptedFileBackend } from './encryptedFileBackend.js';

export interface SecretBrokerOptions {
  /** Test/advanced injection point — bypasses backend auto-selection entirely. */
  backend?: SecretBackend;
  /** Defaults to `$WAZIR_CONFIG_DIR`/`$WAZIR_HOME`/`~/.wazir`, matching the CLI's configDir(). */
  secretsDir?: string;
  /** Replaces the OS-keychain liveness probe (tests); see probeKeyringInSubprocess. */
  keyringProbe?: () => Promise<void>;
}

function defaultSecretsDir(): string {
  return process.env.WAZIR_CONFIG_DIR ?? process.env.WAZIR_HOME ?? path.join(os.homedir(), '.wazir');
}

/**
 * Thin, opaque string key/value secret store. Does not know what a
 * "provider" or "credential" is — callers (the hosted runtime adapters)
 * own that shape and JSON-encode/decode it themselves. Keeping this layer
 * generic means it's reusable for any future secret, not just provider
 * credentials, and keeps `@wazir/secrets` free of a dependency on
 * `@wazir/runtimes-interfaces`.
 */
export class SecretBroker {
  constructor(private readonly backend: SecretBackend) {}

  get backendName(): SecretBackend['name'] {
    return this.backend.name;
  }

  async putCredential(key: string, value: string): Promise<void> {
    await this.backend.set(key, value);
  }

  async getCredential(key: string): Promise<string | undefined> {
    return this.backend.get(key);
  }

  async deleteCredential(key: string): Promise<boolean> {
    return this.backend.delete(key);
  }

  /** Keys that currently have a stored credential. Never returns values —
   *  this is what `wa auth status` and `wa auth providers` use to know
   *  *which* providers are configured without ever touching secret material. */
  async listKeys(): Promise<string[]> {
    return this.backend.list();
  }
}

/**
 * Selects a backend: tries the OS keychain first (self-tested — see
 * `KeyringBackend`), falls back to the encrypted-file backend on any
 * failure (missing native module, no Secret Service, sandboxed/headless
 * environment, or an explicit `options.backend` override for tests).
 */
export async function createSecretBroker(options: SecretBrokerOptions = {}): Promise<SecretBroker> {
  if (options.backend) {
    return new SecretBroker(options.backend);
  }

  const secretsDir = options.secretsDir ?? defaultSecretsDir();

  if (process.env.WAZIR_SECRETS_BACKEND !== 'encrypted-file') {
    try {
      const { KeyringBackend } = await import('./keyringBackend.js');
      const backend = await KeyringBackend.create({ probe: options.keyringProbe });
      return new SecretBroker(backend);
    } catch {
      // No usable OS keychain (missing native module, no Secret Service on
      // headless Linux, sandboxed environment, ...) — fall through.
    }
  }

  return new SecretBroker(new EncryptedFileBackend(secretsDir));
}
