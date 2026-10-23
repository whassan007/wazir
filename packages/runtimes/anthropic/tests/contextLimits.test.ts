import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, EncryptedFileBackend } from '@wazir/secrets';
import { AnthropicAdapter } from '../src/index.js';

const TEST_KEY = 'sk-ant-test-marker-1234567890';

async function makeBroker(): Promise<SecretBroker> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-anthropic-ctx-'));
  return new SecretBroker(new EncryptedFileBackend(dir));
}

/** Serves a fresh /v1/models response on every call (a Response body can be read only once). */
function serveModels(fetchMock: ReturnType<typeof vi.fn>, data: unknown[]): void {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/v1/models')) {
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

async function discover(fetchMock: ReturnType<typeof vi.fn>, data: unknown[]) {
  serveModels(fetchMock, data);
  const adapter = new AnthropicAdapter(await makeBroker());
  await adapter.loginWithApiKey(TEST_KEY);
  return adapter.discoverModels();
}

describe('AnthropicAdapter — context limit provenance', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses max_input_tokens / max_tokens from the Models API as provider-api values', async () => {
    const [model] = await discover(fetchMock, [
      { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', max_input_tokens: 777_000, max_tokens: 99_000 },
    ]);

    expect(model.contextWindow).toBe(777_000);
    expect(model.maxOutputTokens).toBe(99_000);
    expect(model.contextLimitSource).toBe('provider-api');
    expect(model.contextAccounting).toBe('shared');
  });

  it('falls back to documented 1M / 128K for claude-opus-4-8 when the listing lacks the fields', async () => {
    const [model] = await discover(fetchMock, [{ id: 'claude-opus-4-8' }]);

    expect(model.contextWindow).toBe(1_000_000);
    expect(model.maxOutputTokens).toBe(128_000);
    expect(model.contextLimitSource).toBe('provider-documented');
    expect(model.contextAccounting).toBeUndefined();
    expect(model.toolCalling).toBe(true);
    expect(model.reasoning).toBe(true);
  });

  it('does not match claude-opus-4-8 against the generic claude-opus-4 (200K) entry', async () => {
    const [model] = await discover(fetchMock, [{ id: 'claude-opus-4-8-20260101' }]);
    expect(model.contextWindow).not.toBe(200_000);
    expect(model.contextWindow).toBe(1_000_000);
  });

  it('keeps the older generic window for claude-opus-4-1 with no output cap', async () => {
    const [model] = await discover(fetchMock, [{ id: 'claude-opus-4-1' }]);

    expect(model.contextWindow).toBe(200_000);
    expect(model.maxOutputTokens).toBeUndefined();
    expect(model.contextLimitSource).toBe('provider-documented');
  });

  it('documents claude-haiku-4-5 as 200K with no output cap', async () => {
    const [model] = await discover(fetchMock, [{ id: 'claude-haiku-4-5' }]);

    expect(model.contextWindow).toBe(200_000);
    expect(model.maxOutputTokens).toBeUndefined();
    expect(model.contextLimitSource).toBe('provider-documented');
  });

  it('gives an unknown model id no guessed window and tags it default-unknown', async () => {
    const [model] = await discover(fetchMock, [{ id: 'claude-future-model-9000' }]);

    expect(model.contextWindow).toBeUndefined();
    expect(model.maxOutputTokens).toBeUndefined();
    expect(model.contextLimitSource).toBe('default-unknown');
    expect(model.toolCalling).toBe(true);
  });

  it('keeps generate() max_tokens at the request value or 4096 default', async () => {
    serveModels(fetchMock, []);
    const adapter = new AnthropicAdapter(await makeBroker());
    await adapter.loginWithApiKey(TEST_KEY);
    fetchMock.mockImplementation(() => Promise.resolve(new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 })));

    for await (const _ of adapter.generate({ modelId: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] })) {
      // drain
    }
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.max_tokens).toBe(4096);
  });
});
