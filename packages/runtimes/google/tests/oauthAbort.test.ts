import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, EncryptedFileBackend } from '@wazir/secrets';
import { GoogleAdapter } from '../src/index.js';

async function makeBroker(): Promise<SecretBroker> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-google-abort-'));
  return new SecretBroker(new EncryptedFileBackend(dir));
}

describe('GoogleAdapter — Ctrl+C during OAuth login', () => {
  it('#24 aborting mid-flow rejects promptly and tears down the loopback listener (no orphaned server)', async () => {
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker, { clientId: 'test-client-id' });
    const controller = new AbortController();

    let authorizationUrl: string | undefined;
    const loginPromise = adapter.loginWithOAuth!({
      onAuthorizationUrl: (url) => {
        authorizationUrl = url;
      },
      timeoutMs: 30_000, // long — the abort must win, not the timeout
      signal: controller.signal,
    });

    // Wait until the loopback server is actually up (authorization URL
    // generated) before simulating Ctrl+C, then abort — the same sequence a
    // real interactive `wa auth login google --oauth` session hitting Ctrl+C
    // mid-wait would produce.
    await vi.waitFor(() => expect(authorizationUrl).toBeDefined(), { timeout: 2000 });
    const redirectUri = new URL(authorizationUrl!).searchParams.get('redirect_uri')!;
    controller.abort();

    const result = await loginPromise;

    expect(result.ok).toBe(false);
    expect(await broker.getCredential('google')).toBeUndefined();

    // The listener must actually be closed, not just the promise rejected —
    // a lingering server on this port would be the orphaned-listener bug
    // this test exists to catch. A fetch to the now-closed port must fail.
    await expect(fetch(redirectUri, { signal: AbortSignal.timeout(500) })).rejects.toBeDefined();
  });
});
