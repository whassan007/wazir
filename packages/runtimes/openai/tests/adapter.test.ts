import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, EncryptedFileBackend } from '@wazir/secrets';
import { OpenAIAdapter } from '../src/index.js';

const TEST_KEY = 'sk-openai-test-marker-1234567890';

async function makeBroker(): Promise<SecretBroker> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-openai-'));
  return new SecretBroker(new EncryptedFileBackend(dir));
}

describe('OpenAIAdapter — API key authentication', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('#1 succeeds with a valid API key and stores the credential', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const broker = await makeBroker();
    const adapter = new OpenAIAdapter(broker);

    const result = await adapter.loginWithApiKey(TEST_KEY);

    expect(result.ok).toBe(true);
    expect(result.status.method).toBe('api-key');
    expect(await broker.getCredential('openai')).toBeDefined();
  });

  it('#2 an invalid API key fails without storing it', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const broker = await makeBroker();
    const adapter = new OpenAIAdapter(broker);

    const result = await adapter.loginWithApiKey('sk-invalid');

    expect(result.ok).toBe(false);
    expect(await broker.getCredential('openai')).toBeUndefined();
  });

  it('only supports api-key — OpenAI has no documented OAuth-to-API-key exchange for third parties', async () => {
    const broker = await makeBroker();
    const adapter = new OpenAIAdapter(broker);
    expect(adapter.supportedMethods).toEqual(['api-key']);
    expect(adapter.loginWithOAuth).toBeUndefined();
  });

  it('#19 discoverModels() filters out non-chat models and normalizes capabilities', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'whisper-1' }, { id: 'text-embedding-3-small' }] }),
        { status: 200 },
      ),
    );
    const broker = await makeBroker();
    const adapter = new OpenAIAdapter(broker);
    await adapter.loginWithApiKey(TEST_KEY);

    const models = await adapter.discoverModels();
    const ids = models.map((m) => m.id);

    expect(ids).toContain('gpt-4o-mini');
    expect(ids).toContain('text-embedding-3-small');
    expect(ids).not.toContain('whisper-1'); // not a chat/generation model
    expect(models.find((m) => m.id === 'text-embedding-3-small')?.embedding).toBe(true);
  });

  it('#13 the API key never appears in the generate() request body — only in the Authorization header', async () => {
    const broker = await makeBroker();
    const adapter = new OpenAIAdapter(broker);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await adapter.loginWithApiKey(TEST_KEY);

    let capturedBody: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      capturedHeaders = init.headers as Record<string, string>;
      const stream = new ReadableStream({ start(controller) { controller.close(); } });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });

    for await (const _event of adapter.generate({ modelId: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] })) {
      // drain
    }

    expect(capturedBody).not.toContain(TEST_KEY);
    expect(capturedHeaders?.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it('generate() without a stored credential errors without ever calling fetch', async () => {
    const broker = await makeBroker();
    const adapter = new OpenAIAdapter(broker);

    const events: unknown[] = [];
    for await (const event of adapter.generate({ modelId: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'error', error: expect.stringContaining('not authenticated') }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logout removes the stored credential', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const broker = await makeBroker();
    const adapter = new OpenAIAdapter(broker);
    await adapter.loginWithApiKey(TEST_KEY);

    await adapter.logout();

    expect(await broker.getCredential('openai')).toBeUndefined();
  });
});
