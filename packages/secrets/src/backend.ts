/**
 * A `SecretBackend` is a plain string key/value store scoped to a single
 * logical "service" (Wazir). It never interprets the value — credential
 * shapes (API key vs OAuth token, provider id, etc.) are the caller's
 * concern; this layer only guarantees the value is stored durably and
 * cannot be read back except through this API.
 */
export interface SecretBackend {
  readonly name: 'os-keychain' | 'encrypted-file';
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Keys currently stored. Never returns values. */
  list(): Promise<string[]>;
}
