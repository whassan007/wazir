import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker } from '@wazir/secrets';
import { EncryptedFileBackend } from '@wazir/secrets';
import { AnthropicAdapter } from '../src/index.js';

const TEST_KEY = 'sk-ant-test-marker-1234567890';

async function makeBroker(): Promise<SecretBroker> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-anthropic-'));
  return new SecretBroker(new EncryptedFileBackend(dir));
}

describe('AnthropicAdapter — API key authentication', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('#3 succeeds with a valid API key and stores the credential', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const broker = await makeBroker();
    const adapter = new AnthropicAdapter(broker);

    const result = await adapter.loginWithApiKey(TEST_KEY);

    expect(result.ok).toBe(true);
    expect(result.status.authenticated).toBe(true);
    expect(result.status.method).toBe('api-key');
    expect(await broker.getCredential('anthropic')).toBeDefined();
  });

  it('#4 an invalid API key fails safely and is never stored', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const broker = await makeBroker();
    const adapter = new AnthropicAdapter(broker);

    const result = await adapter.loginWithApiKey('sk-ant-invalid-key');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid API key');
    expect(await broker.getCredential('anthropic')).toBeUndefined();
  });

  it('only supports api-key — never advertises OAuth (Anthropic restricts OAuth to Claude Code/Claude.ai)', async () => {
    const broker = await makeBroker();
    const adapter = new AnthropicAdapter(broker);
    expect(adapter.supportedMethods).toEqual(['api-key']);
    expect(adapter.loginWithOAuth).toBeUndefined();
  });

  it('status() never makes a network call (local-only)', async () => {
    const broker = await makeBroker();
    const adapter = new AnthropicAdapter(broker);
    await broker.putCredential('anthropic', JSON.stringify({ provider: 'anthropic', method: 'api-key', credential: { kind: 'api-key', apiKey: TEST_KEY }, obtainedAt: new Date().toISOString() }));

    fetchMock.mockClear();
    const status = await adapter.status();

    expect(status.authenticated).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('#19 discoverModels() returns capability-normalized models once authenticated', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/models')) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' }] }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const broker = await makeBroker();
    const adapter = new AnthropicAdapter(broker);
    await adapter.loginWithApiKey(TEST_KEY);

    const models = await adapter.discoverModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('claude-sonnet-4-20250514');
    expect(models[0].toolCalling).toBe(true);
    expect(models[0].contextWindow).toBeGreaterThan(0);
  });

  it('#20 discoverModels() does not imply eligibility — an unrecognized model still gets conservative defaults, not a crash', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'claude-future-model-9000' }] }), { status: 200 }));
    const broker = await makeBroker();
    const adapter = new AnthropicAdapter(broker);
    await adapter.loginWithApiKey(TEST_KEY);

    const models = await adapter.discoverModels();
    expect(models[0].id).toBe('claude-future-model-9000');
    expect(models[0].toolCalling).toBe(true); // conservative default, not a throw
  });

  it('#13 the API key never appears in the generate() request body — only in headers', async () => {
    let capturedBody: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    });
    const broker = await makeBroker();
    const adapter = new AnthropicAdapter(broker);
    await adapter.loginWithApiKey(TEST_KEY);
    fetchMock.mockClear();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      capturedHeaders = init.headers as Record<string, string>;
      const stream = new ReadableStream({ start(controller) { controller.close(); } });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });

    const events: unknown[] = [];
    for await (const event of adapter.generate({ modelId: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hello' }] })) {
      events.push(event);
    }

    expect(capturedBody).toBeDefined();
    expect(capturedBody).not.toContain(TEST_KEY);
    expect(capturedHeaders?.['x-api-key']).toBe(TEST_KEY);
  });

  it('generate() without a stored credential errors without ever calling fetch', async () => {
    const broker = await makeBroker();
    const adapter = new AnthropicAdapter(broker);

    const events: unknown[] = [];
    for await (const event of adapter.generate({ modelId: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'error', error: expect.stringContaining('not authenticated') }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logout removes the stored credential', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const broker = await makeBroker();
    const adapter = new AnthropicAdapter(broker);
    await adapter.loginWithApiKey(TEST_KEY);

    await adapter.logout();

    expect(await broker.getCredential('anthropic')).toBeUndefined();
    expect((await adapter.status()).authenticated).toBe(false);
  });
});
