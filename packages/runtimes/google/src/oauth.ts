import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { OAuthCallbackServer } from '@wazir/runtimes-interfaces';

export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language.retriever',
];

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

export function buildAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline', // required to receive a refresh_token
    prompt: 'consent',
  });
  return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface ExchangedToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scope: string[];
}

export async function exchangeCodeForToken(options: {
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<ExchangedToken> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    code: options.code,
    code_verifier: options.codeVerifier,
    redirect_uri: options.redirectUri,
    grant_type: 'authorization_code',
  });
  if (options.clientSecret) body.set('client_secret', options.clientSecret);

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await response.json()) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? `token exchange failed: HTTP ${response.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    scope: (data.scope ?? GOOGLE_OAUTH_SCOPES.join(' ')).split(' ').filter(Boolean),
  };
}

export async function refreshAccessToken(options: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): Promise<ExchangedToken> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    refresh_token: options.refreshToken,
    grant_type: 'refresh_token',
  });
  if (options.clientSecret) body.set('client_secret', options.clientSecret);

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await response.json()) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? `token refresh failed: HTTP ${response.status}`);
  }
  return {
    accessToken: data.access_token,
    // Google does not always return a new refresh_token on refresh — the
    // caller must keep the previous one when this is absent.
    refreshToken: data.refresh_token ?? options.refreshToken,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    scope: (data.scope ?? GOOGLE_OAUTH_SCOPES.join(' ')).split(' ').filter(Boolean),
  };
}

/**
 * Real loopback HTTP listener standing in for the OAuth redirect target.
 * Binds to 127.0.0.1 on an ephemeral port (`listen(0)`) so it never
 * collides with anything else on the machine and is not reachable from
 * outside localhost. `waitForCallback` validates `state` against what was
 * generated for this login attempt before ever trusting the returned `code`.
 */
export class LoopbackCallbackServer implements OAuthCallbackServer {
  private server?: http.Server;
  port = 0;

  async start(): Promise<void> {
    this.server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
  }

  async waitForCallback(expectedState: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: string; state: string }> {
    if (!this.server) throw new Error('LoopbackCallbackServer.start() must be called before waitForCallback()');
    const server = this.server;

    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        server.removeAllListeners('request');
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new Error('cancelled'));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`OAuth callback timed out after ${timeoutMs}ms — no browser response received`));
      }, timeoutMs);

      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        cleanup();

        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');

        if (error) {
          res.writeHead(400, { 'content-type': 'text/html' }).end('<html><body>Authorization denied. You can close this window.</body></html>');
          reject(new Error(`provider denied authorization: ${error}`));
          return;
        }
        if (!code || !state) {
          res.writeHead(400, { 'content-type': 'text/html' }).end('<html><body>Malformed callback. You can close this window.</body></html>');
          reject(new Error('OAuth callback missing code or state'));
          return;
        }
        if (state !== expectedState) {
          res.writeHead(400, { 'content-type': 'text/html' }).end('<html><body>State mismatch — request rejected. You can close this window.</body></html>');
          reject(new Error('OAuth state mismatch — possible CSRF, request rejected'));
          return;
        }

        res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>Authenticated. You can close this window and return to the terminal.</body></html>');
        resolve({ code, state });
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }
}

export async function createLoopbackCallbackServer(): Promise<LoopbackCallbackServer> {
  const server = new LoopbackCallbackServer();
  await server.start();
  return server;
}
