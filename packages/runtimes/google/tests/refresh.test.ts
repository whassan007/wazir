import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, EncryptedFileBackend } from '@wazir/secrets';
import { GoogleAdapter } from '../src/index.js';
import type { StoredCredential } from '@wazir/runtimes-interfaces';

async function makeBroker(): Promise<SecretBroker> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-google-refresh-'));
  return new SecretBroker(new EncryptedFileBackend(dir));
}

async function seedOAuthCredential(broker: SecretBroker, expiresAt: string, refreshToken = 'refresh-token-1'): Promise<void> {
  const stored: StoredCredential = {
    provider: 'google',
    method: 'oauth-pkce',
    credential: { kind: 'oauth', accessToken: 'old-access-token', refreshToken, expiresAt, scope: ['https://www.googleapis.com/auth/cloud-platform'] },
    obtainedAt: new Date(Date.now() - 3600_000).toISOString(),
  };
  await broker.putCredential('google', JSON.stringify(stored));
}

describe('GoogleAdapter — OAuth token refresh', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('#9 refresh() exchanges the refresh token for a new access token and updates the stored credential', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new-access-token', refresh_token: 'refresh-token-1', expires_in: 3600 }), { status: 200 }),
    );
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker, { clientId: 'client-id', clientSecret: 'client-secret' });
    await seedOAuthCredential(broker, new Date(Date.now() + 3600_000).toISOString());

    const result = await adapter.refresh();

    expect(result.ok).toBe(true);
    expect(result.status.eligible).toBe(true);
    const stored = JSON.parse((await broker.getCredential('google'))!);
    expect(stored.credential.accessToken).toBe('new-access-token');
  });

  it('#9 preserves the previous refresh token when Google does not return a new one', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: 'rotated-access-token', expires_in: 3600 }), { status: 200 }));
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker, { clientId: 'client-id' });
    await seedOAuthCredential(broker, new Date(Date.now() + 3600_000).toISOString(), 'original-refresh-token');

    await adapter.refresh();

    const stored = JSON.parse((await broker.getCredential('google'))!);
    expect(stored.credential.refreshToken).toBe('original-refresh-token');
  });

  it('#10 an expired OAuth credential reports eligible:false via status() without a network call', async () => {
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker, { clientId: 'client-id' });
    await seedOAuthCredential(broker, new Date(Date.now() - 60_000).toISOString()); // already expired

    fetchMock.mockClear();
    const status = await adapter.status();

    expect(status.authenticated).toBe(true);
    expect(status.eligible).toBe(false);
    expect(status.reason).toContain('expired');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('#10 a non-expired OAuth credential reports eligible:true', async () => {
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker, { clientId: 'client-id' });
    await seedOAuthCredential(broker, new Date(Date.now() + 3600_000).toISOString());

    const status = await adapter.status();

    expect(status.eligible).toBe(true);
  });

  it('generate() silently refreshes an expired token before making the real request', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: 'refreshed-token', refresh_token: 'refresh-token-1', expires_in: 3600 }), { status: 200 }));
      }
      const stream = new ReadableStream({ start(controller) { controller.close(); } });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker, { clientId: 'client-id', clientSecret: 'secret' });
    await seedOAuthCredential(broker, new Date(Date.now() - 60_000).toISOString());

    for await (const _event of adapter.generate({ modelId: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })) {
      // drain
    }

    const stored = JSON.parse((await broker.getCredential('google'))!);
    expect(stored.credential.accessToken).toBe('refreshed-token');
  });

  it('refresh() fails clearly when there is no refreshable credential stored', async () => {
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker, { clientId: 'client-id' });

    const result = await adapter.refresh();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no refreshable');
  });
});
