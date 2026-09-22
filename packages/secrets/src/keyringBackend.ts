import type { SecretBackend } from './backend.js';

const SERVICE = 'wazir';
// Entry API has no "list all keys for this service" operation, so a small
// non-secret index (just key *names*, never values) is kept under a
// reserved account name to make list() possible.
const INDEX_ACCOUNT = '__wazir_secret_index__';

interface KeyringEntry {
  setPassword(password: string): void;
  getPassword(): string;
  deletePassword(): boolean;
}

interface KeyringModule {
  Entry: new (service: string, account: string, options?: { linux?: { store?: string } }) => KeyringEntry;
}

/**
 * Wraps the OS keychain (macOS Keychain / Windows Credential Manager / Linux
 * Secret Service via `@napi-rs/keyring`). Construction is async because it
 * self-tests the backend (write/read/delete a canary value) before it is
 * trusted — `createSecretBroker()` falls back to the encrypted-file backend
 * the moment this throws, so a half-working keychain never gets used silently.
 *
 * Linux is pinned to the Secret Service store explicitly. The library's own
 * default silently falls back to a session-scoped `keyutils` keyring when no
 * Secret Service is running, which is not guaranteed to survive logout/reboot
 * on a headless server — an honest failure (falling through to the encrypted
 * file backend) is preferred over that silent, weaker default.
 */
export class KeyringBackend implements SecretBackend {
  readonly name = 'os-keychain' as const;
  private constructor(private readonly keyring: KeyringModule) {}

  static async create(): Promise<KeyringBackend> {
    // Dynamic import: @napi-rs/keyring is an optionalDependency (native addon,
    // not guaranteed to have a prebuilt binary on every platform/CI target).
    const keyring = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
    const backend = new KeyringBackend(keyring);
    await backend.selfTest();
    return backend;
  }

  private entry(account: string): KeyringEntry {
    return new this.keyring.Entry(SERVICE, account, { linux: { store: 'secret-service' } });
  }

  private async selfTest(): Promise<void> {
    const canaryAccount = '__wazir_keyring_selftest__';
    const canaryValue = `probe-${Date.now()}`;
    const entry = this.entry(canaryAccount);
    entry.setPassword(canaryValue);
    const readBack = entry.getPassword();
    entry.deletePassword();
    if (readBack !== canaryValue) {
      throw new Error('OS keychain self-test failed: value read back did not match value written');
    }
  }

  private async readIndex(): Promise<Set<string>> {
    try {
      const raw = this.entry(INDEX_ACCOUNT).getPassword();
      const parsed = JSON.parse(raw) as unknown;
      return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
    } catch {
      return new Set();
    }
  }

  private async writeIndex(keys: Set<string>): Promise<void> {
    this.entry(INDEX_ACCOUNT).setPassword(JSON.stringify(Array.from(keys)));
  }

  async get(key: string): Promise<string | undefined> {
    try {
      return this.entry(key).getPassword();
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    this.entry(key).setPassword(value);
    const index = await this.readIndex();
    index.add(key);
    await this.writeIndex(index);
  }

  async delete(key: string): Promise<boolean> {
    let deleted = false;
    try {
      deleted = this.entry(key).deletePassword();
    } catch {
      deleted = false;
    }
    const index = await this.readIndex();
    if (index.delete(key)) {
      await this.writeIndex(index);
    }
    return deleted;
  }

  async list(): Promise<string[]> {
    return Array.from(await this.readIndex()).sort();
  }
}
