import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, EncryptedFileBackend } from '@wazir/secrets';
import { GoogleAdapter } from '../src/index.js';

async function makeBroker(): Promise<SecretBroker> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-google-timeout-'));
  return new SecretBroker(new EncryptedFileBackend(dir));
}

describe('GoogleAdapter — OAuth callback timeout', () => {
  it('#8 an OAuth callback that never arrives times out cleanly rather than hanging forever', async () => {
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker, { clientId: 'test-client-id' });

    const started = Date.now();
    const result = await adapter.loginWithOAuth!({
      onAuthorizationUrl: () => undefined, // never actually visited — simulates an abandoned browser flow
      timeoutMs: 300,
    });
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
    // Bounded, not "eventually" — proves it didn't fall through to some other
    // much longer default timeout or hang indefinitely.
    expect(elapsedMs).toBeLessThan(2000);
    expect(await broker.getCredential('google')).toBeUndefined();
  });
});
