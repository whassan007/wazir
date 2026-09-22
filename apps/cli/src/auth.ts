import { exec } from 'node:child_process';
import readline from 'node:readline';
import { appendAuditEvent } from '@wazir/shared';
import type { AuthMethod, ProviderId } from '@wazir/runtimes-interfaces';
import { color } from './colors.js';
import type { RookEngine } from './engine.js';
import { applyHostedProvider } from './hostedProviders.js';
import { promptSecret } from './secretPrompt.js';

const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai', 'google'];
const DISPLAY_NAME: Record<ProviderId, string> = { anthropic: 'Anthropic / Claude', openai: 'OpenAI', google: 'Google / Gemini' };
// In priority order — the first one set wins, matching the interactive-prompt fallback order.
const API_KEY_ENV_VARS: Record<ProviderId, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as string[]).includes(value);
}

function maskKey(key: string): string {
  return key.length <= 4 ? '****' : `****${key.slice(-4)}`;
}

async function auditAuthEvent(
  provider: ProviderId,
  authEvent: 'AUTH_LOGIN_STARTED' | 'AUTH_LOGIN_SUCCEEDED' | 'AUTH_LOGIN_FAILED' | 'AUTH_REFRESHED' | 'AUTH_EXPIRED' | 'AUTH_LOGOUT',
  // Non-secret metadata ONLY — see AuditEvent.details's docstring in @wazir/shared.
  details?: Record<string, unknown>,
): Promise<void> {
  await appendAuditEvent({ type: 'provider_auth', provider, authEvent, details }).catch(() => undefined);
}

/** Best-effort cross-platform browser opener. Never throws — if it fails
 *  (headless server, no `xdg-open`/`open`/`start`), the caller already
 *  printed the authorization URL for the operator to open by hand. */
function tryOpenBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${opener} "${url}"`, () => undefined);
}

async function promptChoice(question: string, options: Array<{ id: string; label: string }>): Promise<string | undefined> {
  if (process.stdin.isTTY !== true) return undefined;
  console.log('');
  console.log(color.bold(question));
  options.forEach((opt, i) => console.log(`  [${i + 1}] ${opt.label}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question('> ', resolve));
    const index = parseInt(answer.trim(), 10) - 1;
    return options[index]?.id;
  } finally {
    rl.close();
  }
}

// Flat shape (not a discriminated union) — this repo builds with
// strictNullChecks off, under which `if (!resolved.ok) return resolved.output`
// does not narrow a `{ok:true}|{ok:false;output:string}` union the way it
// would under strict mode. Optional fields on one object sidestep that.
async function resolveProvider(providerArg: string | undefined): Promise<{ ok: boolean; provider?: ProviderId; output?: string }> {
  if (providerArg) {
    const normalized = providerArg.toLowerCase();
    if (!isProviderId(normalized)) {
      return { ok: false, output: color.red(`unknown provider '${providerArg}'. Valid providers: ${PROVIDER_IDS.join(', ')}`) };
    }
    return { ok: true, provider: normalized };
  }

  const choice = await promptChoice(
    'CONNECT AI PROVIDER — select provider',
    PROVIDER_IDS.map((id) => ({ id, label: DISPLAY_NAME[id] })),
  );
  if (choice && isProviderId(choice)) return { ok: true, provider: choice };
  return { ok: false, output: color.red('no provider selected. Usage: wa auth login <anthropic|openai|google>') };
}

export interface AuthLoginOptions {
  apiKey?: string;
  oauth?: boolean;
  json?: boolean;
}

export async function authLoginCommand(engine: RookEngine, providerArg: string | undefined, options: AuthLoginOptions = {}): Promise<{ code: number; output: string }> {
  const resolved = await resolveProvider(providerArg);
  if (!resolved.ok) return { code: 1, output: resolved.output };
  const provider = resolved.provider;
  const adapter = engine.hostedAdapters.get(provider);
  if (!adapter) return { code: 1, output: color.red(`provider '${provider}' is not available`) };

  const wantsOAuth = options.oauth === true;
  if (wantsOAuth && !adapter.supportedMethods.includes('oauth-pkce')) {
    const reason = adapter.supportedMethods.includes('api-key')
      ? `${DISPLAY_NAME[provider]} does not support OAuth for this integration${provider === 'google' ? ' (no oauthClientId configured — see `wa auth providers`)' : ' (only API key is officially supported for third-party access)'}`
      : `${DISPLAY_NAME[provider]} has no supported authentication method configured`;
    return { code: 1, output: color.red(reason) };
  }

  await auditAuthEvent(provider, 'AUTH_LOGIN_STARTED', { method: wantsOAuth ? 'oauth-pkce' : 'api-key' });

  if (wantsOAuth) {
    let cancelled = false;
    const controller = new AbortController();
    const onSigint = (): void => {
      cancelled = true;
      controller.abort();
    };
    process.once('SIGINT', onSigint);

    console.log('');
    console.log('Opening browser...');
    console.log('');
    console.log(`Authenticate with ${DISPLAY_NAME[provider]}.`);
    console.log('');

    const result = await adapter.loginWithOAuth!({
      signal: controller.signal,
      onAuthorizationUrl: (url) => {
        tryOpenBrowser(url);
        console.log('If your browser did not open automatically, open this URL:');
        console.log(`  ${url}`);
        console.log('');
        console.log('Waiting for authorization...');
      },
    });
    process.off('SIGINT', onSigint);

    if (!result.ok) {
      await auditAuthEvent(provider, 'AUTH_LOGIN_FAILED', { reason: cancelled ? 'cancelled_by_user' : result.error });
      return { code: 1, output: color.red(`authentication failed: ${cancelled ? 'cancelled' : result.error}`) };
    }

    await auditAuthEvent(provider, 'AUTH_LOGIN_SUCCEEDED', { method: 'oauth-pkce', expiresAt: result.status.expiresAt });
    await applyHostedProvider(provider, adapter, { runtimes: engine.runtimes, models: engine.models, config: engine.config });
    const modelCount = engine.models.list().filter((m) => m.provider === provider).length;
    const lines = [
      '',
      color.green('✓ Authentication successful'),
      color.green('✓ Credential stored securely'),
      color.green(`✓ ${DISPLAY_NAME[provider]} provider connected`),
      color.green(`✓ ${modelCount} eligible model(s) discovered`),
    ];
    return { code: 0, output: lines.join('\n') };
  }

  // ---- API key path ----
  let apiKey = options.apiKey;
  let source: 'flag' | 'env' | 'prompt' = 'flag';
  if (!apiKey) {
    const envVar = API_KEY_ENV_VARS[provider].find((name) => process.env[name]);
    if (envVar) {
      apiKey = process.env[envVar];
      source = 'env';
    }
  }
  if (!apiKey) {
    source = 'prompt';
    try {
      apiKey = await promptSecret(`${DISPLAY_NAME[provider]} API key:\n> `);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await auditAuthEvent(provider, 'AUTH_LOGIN_FAILED', { reason: 'no_interactive_input' });
      return { code: 1, output: color.red(reason) };
    }
  }
  if (!apiKey) {
    await auditAuthEvent(provider, 'AUTH_LOGIN_FAILED', { reason: 'empty_api_key' });
    return { code: 1, output: color.red('no API key provided') };
  }

  console.log('');
  console.log('Validating credential...');

  const result = await adapter.loginWithApiKey!(apiKey);
  if (!result.ok) {
    await auditAuthEvent(provider, 'AUTH_LOGIN_FAILED', { reason: result.error, source });
    return { code: 1, output: color.red(`authentication failed: ${result.error}`) };
  }

  await auditAuthEvent(provider, 'AUTH_LOGIN_SUCCEEDED', { method: 'api-key', source });
  await applyHostedProvider(provider, adapter, { runtimes: engine.runtimes, models: engine.models, config: engine.config });
  const modelCount = engine.models.list().filter((m) => m.provider === provider).length;

  const lines = [
    color.green(`✓ ${DISPLAY_NAME[provider]} authenticated (api-key, ${maskKey(apiKey)})`),
    color.green('✓ API reachable'),
    color.green(`✓ ${modelCount} eligible model(s) discovered`),
  ];
  return { code: 0, output: lines.join('\n') };
}

export interface AuthStatusOptions {
  json?: boolean;
}

export async function authStatusCommand(engine: RookEngine, options: AuthStatusOptions = {}): Promise<{ code: number; output: string }> {
  const rows = await Promise.all(
    PROVIDER_IDS.map(async (id) => {
      const adapter = engine.hostedAdapters.get(id);
      const status = adapter ? await adapter.status() : { provider: id, authenticated: false, eligible: false };
      const models = engine.models.list().filter((m) => m.provider === id).length;
      return { id, status, models };
    }),
  );

  if (options.json) {
    // AuthStatus has no field capable of carrying secret material — see its
    // docstring. Passing it straight through to JSON is what makes "wa auth
    // status reveals no secrets" true by construction, not by extra filtering.
    return { code: 0, output: JSON.stringify(rows, null, 2) };
  }

  const lines: string[] = [];
  lines.push(`${'PROVIDER'.padEnd(14)} ${'AUTH'.padEnd(24)} ${'MODELS'}`);
  lines.push('-'.repeat(48));
  for (const row of rows) {
    const plainAuth = row.status.authenticated
      ? row.status.eligible
        ? `✓ connected (${row.status.method})`
        : `⚠ expired (${row.status.method})`
      : 'not connected';
    const colorize = row.status.authenticated ? (row.status.eligible ? color.green : color.yellow) : color.gray;
    // Pad the plain (uncolored) text first so the ANSI escape bytes never
    // throw off column alignment, then colorize the already-padded string.
    lines.push(`${DISPLAY_NAME[row.id].padEnd(14)} ${colorize(plainAuth.padEnd(24))} ${row.models}`);
  }
  return { code: 0, output: lines.join('\n') };
}

export interface AuthLogoutOptions {
  json?: boolean;
}

export async function authLogoutCommand(engine: RookEngine, providerArg: string, options: AuthLogoutOptions = {}): Promise<{ code: number; output: string }> {
  const resolved = await resolveProvider(providerArg);
  if (!resolved.ok) return { code: 1, output: resolved.output };
  const provider = resolved.provider;
  const adapter = engine.hostedAdapters.get(provider);
  if (!adapter) return { code: 1, output: color.red(`provider '${provider}' is not available`) };

  await adapter.logout();
  await auditAuthEvent(provider, 'AUTH_LOGOUT');
  // Refresh in place: mark the runtime unavailable and drop its model
  // instances' eligibility, the same registry update a real re-run of `wa`
  // would produce on next launch.
  await applyHostedProvider(provider, adapter, { runtimes: engine.runtimes, models: engine.models, config: engine.config });

  const output = color.green(`✓ ${DISPLAY_NAME[provider]} logged out`);
  return { code: 0, output: options.json ? JSON.stringify({ provider, loggedOut: true }) : output };
}

export interface AuthProvidersOptions {
  json?: boolean;
}

export async function authProvidersCommand(engine: RookEngine, options: AuthProvidersOptions = {}): Promise<{ code: number; output: string }> {
  const rows = PROVIDER_IDS.map((id) => {
    const adapter = engine.hostedAdapters.get(id);
    const methods: AuthMethod[] = adapter?.supportedMethods ?? [];
    return { id, name: DISPLAY_NAME[id], methods, envVars: API_KEY_ENV_VARS[id] };
  });

  if (options.json) {
    return { code: 0, output: JSON.stringify(rows, null, 2) };
  }

  const lines: string[] = [];
  for (const row of rows) {
    lines.push(color.bold(row.name));
    lines.push(`  methods:   ${row.methods.join(', ') || '(none configured)'}`);
    lines.push(`  API key:   ${row.envVars.join(' or ')}`);
    if (row.id === 'google' && !row.methods.includes('oauth-pkce')) {
      lines.push(color.gray('  OAuth:     not configured — set providers.google.oauthClientId or WAZIR_GOOGLE_OAUTH_CLIENT_ID'));
      lines.push(color.gray('             (register a Desktop-app OAuth client at https://console.cloud.google.com — Wazir does not ship a shared client)'));
    }
    lines.push('');
  }
  return { code: 0, output: lines.join('\n').trimEnd() };
}
