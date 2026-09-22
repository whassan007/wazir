import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, EncryptedFileBackend } from '@wazir/secrets';
import { GoogleAdapter } from '../src/index.js';

const TEST_KEY = 'AIzaTestMarker1234567890';

async function makeBroker(): Promise<SecretBroker> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-google-'));
  return new SecretBroker(new EncryptedFileBackend(dir));
}

describe('GoogleAdapter — API key authentication', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('#5 succeeds with a valid API credential and stores it', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker);

    const result = await adapter.loginWithApiKey(TEST_KEY);

    expect(result.ok).toBe(true);
    expect(result.status.method).toBe('api-key');
    expect(await broker.getCredential('google')).toBeDefined();
  });

  it('an invalid API key fails without storing it', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'API key invalid' } }), { status: 400 }));
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker);

    const result = await adapter.loginWithApiKey('bad-key');

    expect(result.ok).toBe(false);
    expect(await broker.getCredential('google')).toBeUndefined();
  });

  it('supportedMethods is api-key only when no OAuth client id is configured', () => {
    const adapter = new GoogleAdapter({} as SecretBroker, {});
    expect(adapter.supportedMethods).toEqual(['api-key']);
  });

  it('supportedMethods includes oauth-pkce once a client id is configured', () => {
    const adapter = new GoogleAdapter({} as SecretBroker, { clientId: 'test-client-id' });
    expect(adapter.supportedMethods).toEqual(['api-key', 'oauth-pkce']);
  });

  it('#19 discoverModels() uses the richer Gemini model listing (context limits included)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', inputTokenLimit: 1_000_000, supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
          ],
        }),
        { status: 200 },
      ),
    );
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker);
    await adapter.loginWithApiKey(TEST_KEY);

    const models = await adapter.discoverModels();

    expect(models).toHaveLength(1); // embedding model filtered out (no generateContent support)
    expect(models[0].id).toBe('gemini-2.0-flash');
    expect(models[0].contextWindow).toBe(1_000_000);
  });

  it('#13 the API key is passed as a query parameter, never in the request body', async () => {
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }));
    await adapter.loginWithApiKey(TEST_KEY);

    let capturedBody: string | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      const stream = new ReadableStream({ start(controller) { controller.close(); } });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });

    for await (const _event of adapter.generate({ modelId: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hello' }] })) {
      // drain
    }

    expect(capturedBody).toBeDefined();
    expect(capturedBody).not.toContain(TEST_KEY);
  });

  it('logout removes the stored credential', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));
    const broker = await makeBroker();
    const adapter = new GoogleAdapter(broker);
    await adapter.loginWithApiKey(TEST_KEY);

    await adapter.logout();

    expect(await broker.getCredential('google')).toBeUndefined();
  });
});
