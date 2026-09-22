import type { DiscoveredModel } from './index.js';

export type ProviderId = 'anthropic' | 'openai' | 'google';
export type AuthMethod = 'api-key' | 'oauth-pkce';

export interface ApiKeyCredential {
  kind: 'api-key';
  apiKey: string;
}

export interface OAuthCredential {
  kind: 'oauth';
  accessToken: string;
  refreshToken?: string;
  /** ISO 8601. */
  expiresAt: string;
  scope: string[];
}

export type ProviderCredential = ApiKeyCredential | OAuthCredential;

/** The JSON shape persisted through the Secret Broker (as a single JSON string per provider). */
export interface StoredCredential {
  provider: ProviderId;
  method: AuthMethod;
  credential: ProviderCredential;
  /** ISO 8601. */
  obtainedAt: string;
}

/** Type guard used when reading a credential back out of the Secret Broker,
 *  so a corrupted or hand-edited entry produces a clean "run `wa auth login`
 *  again" instead of an unhandled exception deep in a generate() call. */
export function isStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.provider !== 'string' || typeof v.method !== 'string' || typeof v.obtainedAt !== 'string') return false;
  const c = v.credential as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return false;
  if (c.kind === 'api-key') return typeof c.apiKey === 'string';
  if (c.kind === 'oauth') return typeof c.accessToken === 'string' && typeof c.expiresAt === 'string' && Array.isArray(c.scope);
  return false;
}

/**
 * No field on this type can carry raw secret material — that is deliberate.
 * It is what makes "`wa auth status` reveals no secrets" true by
 * construction rather than by code-review vigilance at every call site.
 */
export interface AuthStatus {
  provider: ProviderId;
  authenticated: boolean;
  method?: AuthMethod;
  /** ISO 8601, when `method` is `oauth-pkce`. */
  expiresAt?: string;
  /** `authenticated` AND not expired. Computed locally — see `ProviderAuthAdapter.status`. */
  eligible: boolean;
  reason?: string;
}

export interface AuthLoginResult {
  ok: boolean;
  status: AuthStatus;
  error?: string;
}

export interface OAuthCallbackServer {
  readonly port: number;
  waitForCallback(expectedState: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: string; state: string }>;
  close(): Promise<void>;
}

export interface OAuthLoginOptions {
  onAuthorizationUrl: (url: string) => void;
  /** Default 120_000ms. */
  timeoutMs?: number;
  /** Test injection point — replaces the real loopback HTTP listener. Returns
   *  an already-listening server (starting an HTTP listener is inherently async). */
  createCallbackServer?: () => Promise<OAuthCallbackServer>;
  /** Ctrl+C during the flow aborts cleanly instead of leaving the loopback listener open. */
  signal?: AbortSignal;
}

/**
 * Authentication surface for a hosted provider. A concrete adapter
 * (`AnthropicAdapter`, `OpenAIAdapter`, `GoogleAdapter`) implements this
 * *alongside* `RuntimeAdapter` — one object per provider, not two glued
 * together — so its own notion of "am I authenticated" never has to be
 * kept in sync with a separate object's.
 *
 * `loginWithApiKey`/`loginWithOAuth`/`refresh` are optional: a provider
 * that only supports API keys (Anthropic, OpenAI) simply omits the OAuth
 * methods, and `supportedMethods` is what UI code reads to decide which
 * options to offer — never a hardcoded assumption.
 */
export interface ProviderAuthAdapter {
  readonly provider: ProviderId;
  readonly supportedMethods: AuthMethod[];

  loginWithApiKey?(apiKey: string): Promise<AuthLoginResult>;
  loginWithOAuth?(options: OAuthLoginOptions): Promise<AuthLoginResult>;
  refresh?(): Promise<AuthLoginResult>;

  /** Local-only — reads the stored credential and checks expiry. Never makes
   *  a network call (that's `RuntimeAdapter.healthCheck()`'s job). This
   *  matters because `status()` runs on every `wa` invocation's startup path;
   *  a network call there would add real latency to commands that never
   *  touch a model. */
  status(): Promise<AuthStatus>;
  logout(): Promise<void>;
  /** Same result as `RuntimeAdapter.listModels()` — declared here too since
   *  a caller holding only the `ProviderAuthAdapter` half of the object
   *  (e.g. `wa auth login`, which has no reason to import `RuntimeAdapter`)
   *  still needs it to register models right after a successful login. */
  discoverModels(): Promise<DiscoveredModel[]>;
}
