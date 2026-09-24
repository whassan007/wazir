import { execFile } from 'node:child_process';
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
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

// A real set/get/delete round-trip against the same store the backend uses.
const PROBE_SCRIPT = `
const { Entry } = require('@napi-rs/keyring');
const entry = new Entry('wazir', '__wazir_keyring_probe__', { linux: { store: 'secret-service' } });
entry.setPassword('probe');
if (entry.getPassword() !== 'probe') process.exit(2);
entry.deletePassword();
`;

/**
 * Proves the OS keychain answers before the process trusts it in-process.
 *
 * The keyring calls are synchronous native calls. When the store can't answer
 * without user interaction — e.g. a locked GNOME keyring over SSH, where the unlock
 * prompt has no display — they block the calling thread forever, and no in-process
 * timeout can interrupt that. (Observed: every `wa` command hung at startup on such a
 * machine.) So the round-trip runs first in a child process that is killed on
 * timeout; a hang or failure rejects, and the broker falls back to the
 * encrypted-file backend.
 */
export function probeKeyringInSubprocess(
  timeoutMs = Number(process.env.WAZIR_KEYRING_PROBE_TIMEOUT_MS) || DEFAULT_PROBE_TIMEOUT_MS,
  script = PROBE_SCRIPT,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // cwd = this package, so the child resolves @napi-rs/keyring the same way we do.
    execFile(process.execPath, ['-e', script], { cwd: __dirname, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true }, (error) => {
      if (!error) return resolve();
      const timedOut = (error as { killed?: boolean }).killed === true;
      reject(new Error(timedOut
        ? `OS keychain did not respond within ${timeoutMs}ms (e.g. a locked keyring that cannot prompt over SSH); not using it`
        : `OS keychain probe failed: ${error.message}`));
    });
  });
}

// One probe per process; concurrent callers share it, a failure is retried by the next caller.
let sharedProbe: Promise<void> | undefined;
function probeOnce(probe: () => Promise<void>): Promise<void> {
  sharedProbe ??= probe().catch((error) => {
    sharedProbe = undefined;
    throw error;
  });
  return sharedProbe;
}

export class KeyringBackend implements SecretBackend {
  readonly name = 'os-keychain' as const;
  private constructor(private readonly keyring: KeyringModule) {}

  static async create(options: { probe?: () => Promise<void> } = {}): Promise<KeyringBackend> {
    // Before any in-process native call: a keychain that can't answer would block forever.
    if (options.probe) await options.probe();
    else await probeOnce(() => probeKeyringInSubprocess());
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
