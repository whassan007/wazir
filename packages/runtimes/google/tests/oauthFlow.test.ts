import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, EncryptedFileBackend } from '@wazir/secrets';
import { GoogleAdapter } from '../src/index.js';

async function makeBroker(): Promise<SecretBroker> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-google-oauth-'));
  return new SecretBroker(new EncryptedFileBackend(dir));
}

// The loopback callback listener is real (a genuine node:http server bound to
// 127.0.0.1, per LoopbackCallbackServer) — only the outbound call to Google's
// token endpoint is mocked, so this exercises the actual PKCE/state/redirect
// wiring end-to-end, matching the confirmed test design (a real local server
// standing in for Google's authorization endpoint).
describe('GoogleAdapter — OAuth 2.0 PKCE flow', () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: 'ya29-fake-access-token', refresh_token: '1//fake-refresh-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/cloud-platform' }),
            { status: 200 },
          ),
        );
      }
      return realFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('#6 completes successfully: authorization URL generated, callback received, token exchanged, credential stored', async () => {
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker, { clientId: 'test-client-id', clientSecret: 'test-client-secret' });

    let authorizationUrl: string | undefined;
    const loginPromise = adapter.loginWithOAuth!({
      onAuthorizationUrl: (url) => {
        authorizationUrl = url;
      },
      timeoutMs: 5000,
    });

    // Simulate the browser following the authorization URL and Google
    // redirecting back with a code + the exact state Wazir generated.
    await vi.waitFor(() => expect(authorizationUrl).toBeDefined(), { timeout: 2000 });
    const parsed = new URL(authorizationUrl!);
    expect(parsed.origin).toBe('https://accounts.google.com');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    const state = parsed.searchParams.get('state')!;
    expect(state).toBeTruthy();

    // The redirect_uri Google would redirect to is derived from the loopback
    // server's actual port — read it back out of the authorization URL itself.
    const redirectUri = new URL(parsed.searchParams.get('redirect_uri')!);
    await realFetch(`${redirectUri.toString()}?code=fake-auth-code&state=${encodeURIComponent(state)}`);

    const result = await loginPromise;

    expect(result.ok).toBe(true);
    expect(result.status.method).toBe('oauth-pkce');
    expect(result.status.eligible).toBe(true);
    const stored = await broker.getCredential('google');
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!).credential.accessToken).toBe('ya29-fake-access-token');
  });

  it('#7 rejects a callback whose state does not match — no credential is stored', async () => {
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker, { clientId: 'test-client-id' });

    let authorizationUrl: string | undefined;
    const loginPromise = adapter.loginWithOAuth!({
      onAuthorizationUrl: (url) => {
        authorizationUrl = url;
      },
      timeoutMs: 5000,
    });

    await vi.waitFor(() => expect(authorizationUrl).toBeDefined(), { timeout: 2000 });
    const parsed = new URL(authorizationUrl!);
    const redirectUri = new URL(parsed.searchParams.get('redirect_uri')!);

    // A forged/mismatched state — the classic CSRF-style attack this check defends against.
    await realFetch(`${redirectUri.toString()}?code=attacker-code&state=wrong-state-value`);

    const result = await loginPromise;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('state mismatch');
    expect(await broker.getCredential('google')).toBeUndefined();
  });

  it('loginWithOAuth fails clearly (no hang) when no client id is configured', async () => {
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker, {});

    const result = await adapter.loginWithOAuth!({ onAuthorizationUrl: () => undefined, timeoutMs: 1000 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('client id');
  });
});
