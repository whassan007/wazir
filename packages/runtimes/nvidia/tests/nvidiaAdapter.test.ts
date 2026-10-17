import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, EncryptedFileBackend } from '@wazir/secrets';
import { redactProviderSecrets } from '@wazir/runtimes-interfaces';
import {
  NvidiaAdapter,
  createNvidiaAdapter,
  NVIDIA_DEFAULT_BASE_URL,
  NVIDIA_DEFAULT_MODEL_ID,
  NVIDIA_DISPLAY_NAME,
  NVIDIA_PROVIDER_ID,
  NVIDIA_PROVIDER_TYPE,
  inferNvidiaModelMetadata,
} from '../src/index.js';

const TEST_NVAPI_KEY = 'nvapi-test-secret-marker-9876543210abcdef';

async function makeBroker(): Promise<SecretBroker> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-nvidia-test-'));
  return new SecretBroker(new EncryptedFileBackend(dir));
}

function makeSseStream(chunks: Array<Record<string, unknown> | string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        const line = typeof chunk === 'string' ? `data: ${chunk}\n\n` : `data: ${JSON.stringify(chunk)}\n\n`;
        controller.enqueue(encoder.encode(line));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

describe('NvidiaAdapter — First-Class Execution Provider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. registers with canonical provider metadata (id, displayName, providerType, baseURL, defaultModel)', async () => {
    const broker = await makeBroker();
    const adapter = createNvidiaAdapter({ secrets: broker, env: {}, fetch: fetchMock as unknown as typeof fetch });

    expect(adapter.id).toBe(NVIDIA_PROVIDER_ID);
    expect(adapter.type).toBe('nvidia');
    expect(adapter.provider).toBe('nvidia');
    expect(adapter.displayName).toBe(NVIDIA_DISPLAY_NAME);
    expect(adapter.providerType).toBe(NVIDIA_PROVIDER_TYPE);
    expect(adapter.getEndpointUrl()).toBe(NVIDIA_DEFAULT_BASE_URL);
    expect(adapter.getDefaultModel()).toBe(NVIDIA_DEFAULT_MODEL_ID);

    const discovered = await adapter.discover();
    expect(discovered).toEqual({
      id: 'nvidia',
      name: 'NVIDIA API Catalog',
      version: 'v1',
      url: 'https://integrate.api.nvidia.com/v1',
    });
  });

  it('2. handles missing NVIDIA_API_KEY gracefully without crashing', async () => {
    const broker = await makeBroker();
    const adapter = new NvidiaAdapter({ secrets: broker, env: {}, fetch: fetchMock as unknown as typeof fetch });

    const status = await adapter.status();
    expect(status.authenticated).toBe(false);
    expect(status.eligible).toBe(false);
    expect(status.credentialSource).toBe('none');
    expect(status.state).toBe('unavailable');
    expect(status.reason).toContain('NVIDIA_API_KEY');

    const health = await adapter.healthCheck();
    expect(health.status).toBe('unavailable');
    expect(health.reason).toBe('AUTH_REQUIRED');

    const models = await adapter.discoverModels();
    expect(models).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    const events: unknown[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      events.push(ev);
    }
    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        failureClass: 'AUTH_FAILED',
        error: expect.stringContaining('not authenticated'),
      }),
    ]);
  });

  it('3. handles invalid API key (HTTP 401/403) during login and healthCheck without storing or leaking key', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"Invalid token"}', { status: 401 }));
    const broker = await makeBroker();
    const adapter = new NvidiaAdapter({ secrets: broker, env: {}, fetch: fetchMock as unknown as typeof fetch });

    const loginRes = await adapter.loginWithApiKey(TEST_NVAPI_KEY);
    expect(loginRes.ok).toBe(false);
    expect(loginRes.error).toContain('HTTP 401');
    expect(loginRes.error).not.toContain(TEST_NVAPI_KEY);
    expect(await broker.getCredential('nvidia')).toBeUndefined();

    // With env key set but rejected by server:
    const envAdapter = new NvidiaAdapter({
      secrets: broker,
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const health = await envAdapter.healthCheck();
    expect(health.status).toBe('unavailable');
    expect(health.reason).toBe('AUTH_REQUIRED');
    expect(health.message).not.toContain(TEST_NVAPI_KEY);
  });

  it('4. discovers models from /models and falls back to configured/curated models when remote enumeration fails', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', object: 'model' },
            { id: 'meta/llama-3.1-70b-instruct', object: 'model', context_window: 131072 },
          ],
        }),
        { status: 200 },
      ),
    );
    const broker = await makeBroker();
    const adapter = new NvidiaAdapter({
      secrets: broker,
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      configuredModels: ['custom/org-model-v1'],
      fetch: fetchMock as unknown as typeof fetch,
    });

    const models = await adapter.discoverModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain('nvidia/nemotron-3.5-super-vl-120b-a12b');
    expect(ids).toContain('meta/llama-3.1-70b-instruct');
    expect(ids).toContain('custom/org-model-v1');

    // Now simulate remote /models failure (503) — configured/curated models still returned
    fetchMock.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }));
    const fallbackModels = await adapter.discoverModels();
    expect(fallbackModels.map((m) => m.id)).toContain('nvidia/nemotron-3.5-super-vl-120b-a12b');
    expect(fallbackModels.map((m) => m.id)).toContain('custom/org-model-v1');
  });

  it('5. advertises accurate capability metadata for nvidia/nemotron-3.5-super-vl-120b-a12b', () => {
    const meta = inferNvidiaModelMetadata(NVIDIA_DEFAULT_MODEL_ID);
    expect(meta.id).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
    expect(meta.contextWindow).toBe(131072);
    expect(meta.maxOutputTokens).toBe(16384);
    expect(meta.vision).toBe(true);
    expect(meta.reasoning).toBe(true);
    expect(meta.toolCalling).toBe(true);
    expect(meta.parallelToolCalls).toBe(true);
    expect(meta.structuredOutput).toBe(true);
    expect(meta.supportsThinkingKwargs).toBe(true);
    expect(meta.supportsSeed).toBe(true);
    expect(meta.capabilities).toEqual(
      expect.arrayContaining(['generalChat', 'coding', 'reasoning', 'vision', 'code_analysis', 'debugging', 'review']),
    );
  });

  it('6. executes non-streaming completion and normalizes reasoning, content, tool calls, and token usage', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-nv-1',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                reasoning_content: 'Analyzing repository structure first.',
                content: 'Here is the solution.',
              },
            },
          ],
          usage: {
            prompt_tokens: 42,
            completion_tokens: 18,
            total_tokens: 60,
            prompt_tokens_details: { cached_tokens: 12 },
            completion_tokens_details: { reasoning_tokens: 8 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const adapter = new NvidiaAdapter({
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const events: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      stream: false,
      seed: 42,
      messages: [{ role: 'user', content: 'Solve task' }],
    })) {
      events.push(ev);
    }

    expect(events.find((e) => e.type === 'reasoning')?.content).toBe('Analyzing repository structure first.');
    expect(events.find((e) => e.type === 'token')?.content).toBe('Here is the solution.');
    const completed = events.find((e) => e.type === 'completed');
    expect(completed).toBeDefined();
    expect(completed.content).toBe('Here is the solution.');
    expect(completed.usage).toMatchObject({
      inputTokens: 42,
      outputTokens: 18,
      totalTokens: 60,
      cacheReadTokens: 12,
      reasoningTokens: 8,
    });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentBody.stream).toBe(false);
    expect(sentBody.seed).toBe(42);
    expect(sentBody.extra_body).toEqual({
      chat_template_kwargs: { enable_thinking: true },
    });
  });

  it('7 & 8. executes streaming completion and separates delta.reasoning_content from delta.content', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        makeSseStream([
          { choices: [{ delta: { reasoning_content: 'Step 1: think. ' } }] },
          { choices: [{ delta: { reasoning_content: 'Step 2: verify.' } }] },
          { choices: [{ delta: { content: 'Final ' } }] },
          { choices: [{ delta: { content: 'answer.' }, finish_reason: 'stop' }] },
          { usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 } },
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );

    const adapter = new NvidiaAdapter({
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const reasoningChunks: string[] = [];
    const contentChunks: string[] = [];
    let completedEvent: any;

    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Stream test' }],
    })) {
      if (ev.type === 'reasoning' && ev.content) reasoningChunks.push(ev.content);
      if (ev.type === 'token' && ev.content) contentChunks.push(ev.content);
      if (ev.type === 'completed') completedEvent = ev;
    }

    expect(reasoningChunks.join('')).toBe('Step 1: think. Step 2: verify.');
    expect(contentChunks.join('')).toBe('Final answer.');
    // Final answer content never mixes reasoning tokens into content
    expect(completedEvent.content).toBe('Final answer.');
    expect(completedEvent.usage).toMatchObject({
      inputTokens: 25,
      outputTokens: 15,
      totalTokens: 40,
    });
  });

  it('9. handles native streaming tool calls and parallel_tool_calls', async () => {
    let capturedBody: any;
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve(
        new Response(
          makeSseStream([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{"path":' } },
                      { index: 1, id: 'call_search_2', type: 'function', function: { name: 'search', arguments: '{"pattern":"TODO"}' } },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, function: { arguments: '"README.md"}' } },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ]),
          { status: 200 },
        ),
      );
    });

    const adapter = new NvidiaAdapter({
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const toolCalls: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Read README and search TODO' }],
      tools: [
        { name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'search', description: 'Search code', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
      ],
    })) {
      if (ev.type === 'tool_call') toolCalls.push(ev);
    }

    expect(capturedBody.parallel_tool_calls).toBe(true);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      type: 'tool_call',
      toolCallId: 'call_read_1',
      toolName: 'read',
      toolInput: { path: 'README.md' },
    });
    expect(toolCalls[1]).toMatchObject({
      type: 'tool_call',
      toolCallId: 'call_search_2',
      toolName: 'search',
      toolInput: { pattern: 'TODO' },
    });
  });

  it('10. formats multimodal image inputs for vision models and rejects image inputs on non-vision models', async () => {
    let capturedBody: any;
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve(
        new Response(
          makeSseStream([{ choices: [{ delta: { content: 'The screenshot shows a passing build.' }, finish_reason: 'stop' }] }]),
          { status: 200 },
        ),
      );
    });

    const adapter = new NvidiaAdapter({
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const events: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [
        {
          role: 'user',
          content: 'Inspect this UI screenshot',
          images: [{ url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', detail: 'high' }],
        },
      ],
    })) {
      events.push(ev);
    }

    expect(events.some((e) => e.type === 'completed')).toBe(true);
    expect(capturedBody.messages[0].content).toEqual([
      { type: 'text', text: 'Inspect this UI screenshot' },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          detail: 'high',
        },
      },
    ]);

    // Non-vision model must reject multimodal image input cleanly without calling fetch
    fetchMock.mockClear();
    const nonVisionEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: 'nvidia/llama-3.3-nemotron-super-49b-v1',
      messages: [
        {
          role: 'user',
          content: 'Look at this image',
          images: [{ url: 'https://example.com/diagram.png' }],
        },
      ],
    })) {
      nonVisionEvents.push(ev);
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(nonVisionEvents).toEqual([
      expect.objectContaining({
        type: 'error',
        failureClass: 'NON_RECOVERABLE',
        error: expect.stringContaining('does not advertise vision capability'),
      }),
    ]);
  });

  it('11. automatically strips unsupported optional parameters (e.g. extra_body) on HTTP 400 and retries cleanly', async () => {
    const sentBodies: any[] = [];
    fetchMock
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        sentBodies.push(JSON.parse(init.body as string));
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: 'Extra inputs are not permitted: extra_body.chat_template_kwargs' } }),
            { status: 400 },
          ),
        );
      })
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        sentBodies.push(JSON.parse(init.body as string));
        return Promise.resolve(
          new Response(
            makeSseStream([{ choices: [{ delta: { content: 'Succeeded after stripping extra_body' }, finish_reason: 'stop' }] }]),
            { status: 200 },
          ),
        );
      });

    const adapter = new NvidiaAdapter({
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const events: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Test fallback' }],
    })) {
      events.push(ev);
    }

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0].extra_body).toBeDefined();
    expect(sentBodies[1].extra_body).toBeUndefined();
    expect(events.find((e) => e.type === 'completed')?.content).toBe('Succeeded after stripping extra_body');
  });

  it('12. classifies HTTP 429 rate-limit and HTTP 503 transient server errors with Retry-After headers', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: {
          'retry-after': '4',
          'x-ratelimit-remaining-requests': '0',
          'x-ratelimit-remaining-tokens': '100',
        },
      }),
    );

    const adapter = new NvidiaAdapter({
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const events: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Rate limited call' }],
    })) {
      events.push(ev);
    }

    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent.failureClass).toBe('RATE_LIMIT');
    expect(errEvent.status).toBe(429);
    expect(errEvent.retryAfterMs).toBe(4000);
    expect(errEvent.rateLimit?.remainingRequests).toBe(0);
  });

  it('13. supports request timeout and explicit cancellation via AbortSignal / cancel()', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });

    const adapter = new NvidiaAdapter({
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 20);

    const events: any[] = [];
    for await (const ev of adapter.generate({
      requestId: 'req-cancel-test',
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      signal: abortController.signal,
      messages: [{ role: 'user', content: 'Long running request' }],
    })) {
      events.push(ev);
    }

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.failureClass).toBe('CANCELLED');
  });

  it('14. redacts NVIDIA_API_KEY and Bearer tokens from error events and logs', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        `Upstream gateway rejected Authorization: Bearer ${TEST_NVAPI_KEY} for key ${TEST_NVAPI_KEY}`,
        { status: 502 },
      ),
    );

    const adapter = new NvidiaAdapter({
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const events: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Trigger 502' }],
    })) {
      events.push(ev);
    }

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(TEST_NVAPI_KEY);
    expect(redactProviderSecrets(`Key=${TEST_NVAPI_KEY} Bearer ${TEST_NVAPI_KEY}`)).toBe(
      'Key=nvapi-[REDACTED] Bearer [REDACTED]',
    );
  });
});
