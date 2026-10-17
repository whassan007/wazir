import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, EncryptedFileBackend } from '@wazir/secrets';
import { redactProviderSecrets } from '@wazir/runtimes-interfaces';
import {
  NvidiaAdapter,
  createNvidiaAdapter,
  CURATED_NVIDIA_MODELS,
  NVIDIA_DEFAULT_BASE_URL,
  NVIDIA_DEFAULT_MODEL_ID,
  NVIDIA_DISPLAY_NAME,
  NVIDIA_PROVIDER_ID,
  NVIDIA_PROVIDER_TYPE,
  inferNvidiaModelMetadata,
  validateNvidiaRequestCompatibility,
} from '../src/index.js';

const TEST_NVAPI_KEY = 'nvapi-test-secret-marker-9876543210abcdef';

async function makeBroker(): Promise<SecretBroker> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-nvidia-test-'));
  return new SecretBroker(new EncryptedFileBackend(dir));
}

function makeSseStream(
  chunks: Array<Record<string, unknown> | string>,
  options: { includeDone?: boolean } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const includeDone = options.includeDone ?? true;
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        const line = typeof chunk === 'string' ? `data: ${chunk}\n\n` : `data: ${JSON.stringify(chunk)}\n\n`;
        controller.enqueue(encoder.encode(line));
      }
      if (includeDone) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      }
      controller.close();
    },
  });
}

interface MockHttpServer {
  baseUrl: string;
  requests: Array<{
    method?: string;
    url?: string;
    headers: IncomingMessage['headers'];
    body: string;
    parsedBody?: any;
  }>;
  setHandler: (handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>) => void;
  close: () => Promise<void>;
}

async function startMockNvidiaServer(): Promise<MockHttpServer> {
  const requests: MockHttpServer['requests'] = [];
  let currentHandler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void> = (
    _req,
    res,
  ) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  };

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString('utf8');
    let parsedBody: any;
    try {
      parsedBody = body ? JSON.parse(body) : undefined;
    } catch {
      parsedBody = undefined;
    }
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
      parsedBody,
    });
    await currentHandler(req, res, body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setHandler(handler) {
      currentHandler = handler;
    },
    close() {
      return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

describe('NvidiaAdapter — First-Class Execution Provider & Runtime Hardening', () => {
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

  it('2. handles missing NVIDIA_API_KEY and corrupted SecretBroker credentials gracefully without crashing', async () => {
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

    // Corrupted stored credential falls back to env when present, or reports unavailable when env is absent
    await broker.putCredential('nvidia', '{not-json');
    const corruptedStatus = await adapter.status();
    expect(corruptedStatus.authenticated).toBe(false);
    expect(corruptedStatus.reason).toContain('corrupted');

    const fallbackEnvAdapter = new NvidiaAdapter({
      secrets: broker,
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const fallbackStatus = await fallbackEnvAdapter.status();
    expect(fallbackStatus.authenticated).toBe(true);
    expect(fallbackStatus.credentialSource).toBe('env');
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

    // Unknown custom model without remote or explicit metadata does NOT falsely claim confirmed contextWindow or toolCalling
    const customDiscovered = models.find((m) => m.id === 'custom/org-model-v1');
    expect(customDiscovered?.toolCalling).toBe(false);
    expect(customDiscovered?.vision).toBe(false);
    expect(customDiscovered?.contextWindow).toBeUndefined();

    // Now simulate remote /models failure (503) — configured/curated models still returned
    fetchMock.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }));
    const fallbackModels = await adapter.discoverModels();
    expect(fallbackModels.map((m) => m.id)).toContain('nvidia/nemotron-3.5-super-vl-120b-a12b');
    expect(fallbackModels.map((m) => m.id)).toContain('custom/org-model-v1');
  });

  it('5. establishes capability integrity across curated, remote-metadata, unknown, and explicitly overridden models', () => {
    // 1. Primary curated model: Nemotron 3.5 Super VL 120B A12B
    const nemotronMeta = inferNvidiaModelMetadata(NVIDIA_DEFAULT_MODEL_ID);
    expect(nemotronMeta.id).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
    expect(nemotronMeta.contextWindow).toBe(131072);
    expect(nemotronMeta.maxOutputTokens).toBe(16384);
    expect(nemotronMeta.vision).toBe(true);
    expect(nemotronMeta.reasoning).toBe(true);
    expect(nemotronMeta.toolCalling).toBe(true);
    expect(nemotronMeta.parallelToolCalls).toBe(true);
    expect(nemotronMeta.structuredOutput).toBe(true);
    expect(nemotronMeta.supportsThinkingKwargs).toBe(true);
    expect(nemotronMeta.supportsSeed).toBe(true);
    expect(nemotronMeta.provenance.source).toBe('curated');
    expect(nemotronMeta.provenance.confidence).toBe('confirmed');

    // 2. Curated reasoning-only model without native tool calling (DeepSeek R1)
    const r1Meta = inferNvidiaModelMetadata('deepseek-ai/deepseek-r1');
    expect(r1Meta.reasoning).toBe(true);
    expect(r1Meta.toolCalling).toBe(false);
    expect(r1Meta.structuredOutput).toBe(false);
    expect(r1Meta.vision).toBe(false);
    expect(r1Meta.provenance.toolCallingStatus).toBe('unsupported');

    // 3. Curated vision model without tool calling (Llama 3.2 90B Vision)
    const llamaVisionMeta = inferNvidiaModelMetadata('meta/llama-3.2-90b-vision-instruct');
    expect(llamaVisionMeta.vision).toBe(true);
    expect(llamaVisionMeta.toolCalling).toBe(false);
    expect(llamaVisionMeta.maxOutputTokens).toBe(4096);

    // 4. Unknown third-party model on NVIDIA endpoint: capabilities marked unknown, never fabricated as true
    const unknownMeta = inferNvidiaModelMetadata('acme/experimental-7b');
    expect(unknownMeta.provenance.source).toBe('unknown-model');
    expect(unknownMeta.provenance.confidence).toBe('unknown');
    expect(unknownMeta.provenance.toolCallingStatus).toBe('unknown');
    expect(unknownMeta.provenance.structuredOutputStatus).toBe('unknown');
    expect(unknownMeta.provenance.visionStatus).toBe('unsupported');
    expect(unknownMeta.toolCalling).toBe(false);
    expect(unknownMeta.structuredOutput).toBe(false);
    expect(unknownMeta.vision).toBe(false);
    expect(unknownMeta.supportsThinkingKwargs).toBe(false);

    // 5. Remote metadata record with explicit capability fields upgrades provenance to remote-metadata
    const remoteMeta = inferNvidiaModelMetadata('acme/verified-coder-32b', {
      context_length: 65536,
      max_output_tokens: 8192,
      tool_calling: true,
      structured_output: true,
      vision: false,
    });
    expect(remoteMeta.provenance.source).toBe('remote-metadata');
    expect(remoteMeta.contextWindow).toBe(65536);
    expect(remoteMeta.maxOutputTokens).toBe(8192);
    expect(remoteMeta.toolCalling).toBe(true);
    expect(remoteMeta.structuredOutput).toBe(true);

    // 6. Explicit configuration override upgrades unknown model
    const overriddenMeta = inferNvidiaModelMetadata('acme/experimental-7b', undefined, {
      toolCalling: true,
      structuredOutput: true,
      contextWindow: 32768,
      maxOutputTokens: 4096,
    });
    expect(overriddenMeta.provenance.source).toBe('explicit-override');
    expect(overriddenMeta.toolCalling).toBe(true);
    expect(overriddenMeta.structuredOutput).toBe(true);
  });

  it('6. refuses to silently drop critical request requirements (tools, structured output, vision, embedding) on incompatible models', async () => {
    const adapter = new NvidiaAdapter({
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      fetch: fetchMock as unknown as typeof fetch,
    });

    // 6a. Tool calling requested on model with unconfirmed/unsupported toolCalling (e.g. deepseek-ai/deepseek-r1 or unknown model)
    const r1ToolEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: 'deepseek-ai/deepseek-r1',
      messages: [{ role: 'user', content: 'Run a tool' }],
      tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
    })) {
      r1ToolEvents.push(ev);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r1ToolEvents).toEqual([
      expect.objectContaining({
        type: 'error',
        failureClass: 'NON_RECOVERABLE',
        error: expect.stringContaining('refusing to silently drop 1 required tool definition(s)'),
      }),
    ]);

    // 6b. Tool calling requested on unknown model with unconfirmed tool support
    const unknownToolEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: 'unknown-org/mystery-model-v1',
      messages: [{ role: 'user', content: 'Use tool' }],
      tools: [{ name: 'shell', description: 'Run command', parameters: { type: 'object' } }],
    })) {
      unknownToolEvents.push(ev);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unknownToolEvents).toEqual([
      expect.objectContaining({
        type: 'error',
        failureClass: 'NON_RECOVERABLE',
        error: expect.stringContaining('unconfirmed tool-calling support'),
      }),
    ]);

    // 6c. Structured output (json_schema) requested on model without structuredOutput support
    const r1SchemaEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: 'deepseek-ai/deepseek-r1',
      messages: [{ role: 'user', content: 'Return JSON' }],
      responseFormat: { type: 'json_schema', json_schema: { name: 'plan', schema: { type: 'object' } } },
    })) {
      r1SchemaEvents.push(ev);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r1SchemaEvents).toEqual([
      expect.objectContaining({
        type: 'error',
        failureClass: 'NON_RECOVERABLE',
        error: expect.stringContaining("refusing to silently strip responseFormat 'json_schema'"),
      }),
    ]);

    // 6d. Embedding model invoked via generate()
    const embedEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: 'nvidia/nv-embedqa-e5-v5',
      messages: [{ role: 'user', content: 'Embed this' }],
    })) {
      embedEvents.push(ev);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(embedEvents).toEqual([
      expect.objectContaining({
        type: 'error',
        failureClass: 'NON_RECOVERABLE',
        error: expect.stringContaining('is an embedding model and cannot execute chat completions'),
      }),
    ]);
  });

  it('7. executes non-streaming completion and normalizes reasoning, content, tool calls, and token usage', async () => {
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

  it('8. executes streaming completion, separates delta.reasoning_content from delta.content, and leaves missing usage undefined', async () => {
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
    expect(completedEvent.content).toBe('Final answer.');
    expect(completedEvent.usage).toMatchObject({
      inputTokens: 25,
      outputTokens: 15,
      totalTokens: 40,
    });

    // When the provider does NOT report a usage chunk, completedEvent.usage must be undefined (not a fabricated {0, 0})
    fetchMock.mockResolvedValueOnce(
      new Response(
        makeSseStream([
          { choices: [{ delta: { content: 'No usage reported' }, finish_reason: 'stop' }] },
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    let noUsageCompleted: any;
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Stream without usage' }],
    })) {
      if (ev.type === 'completed') noUsageCompleted = ev;
    }
    expect(noUsageCompleted).toBeDefined();
    expect(noUsageCompleted.usage).toBeUndefined();
  });

  it('9. handles native streaming tool calls, multiple parallel tool calls, and unindexed tool-call chunks', async () => {
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

  it('10. formats multimodal image inputs (preserving message order and base64 normalization) and rejects image inputs on non-vision models', async () => {
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
      systemPrompt: 'You are a multimodal code reviewer.',
      messages: [
        {
          role: 'user',
          content: 'Inspect this UI screenshot and architecture diagram',
          images: [
            { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', detail: 'high' },
            { url: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mediaType: 'image/jpeg', detail: 'low' },
          ],
        },
        {
          role: 'assistant',
          content: 'I see the screenshot.',
        },
        {
          role: 'user',
          content: 'Now summarize the layout.',
        },
      ],
    })) {
      events.push(ev);
    }

    expect(events.some((e) => e.type === 'completed')).toBe(true);
    expect(capturedBody.messages).toHaveLength(4);
    expect(capturedBody.messages[0]).toEqual({ role: 'system', content: 'You are a multimodal code reviewer.' });
    expect(capturedBody.messages[1].content).toEqual([
      { type: 'text', text: 'Inspect this UI screenshot and architecture diagram' },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          detail: 'high',
        },
      },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          detail: 'low',
        },
      },
    ]);
    expect(capturedBody.messages[2]).toEqual({ role: 'assistant', content: 'I see the screenshot.' });
    expect(capturedBody.messages[3]).toEqual({ role: 'user', content: 'Now summarize the layout.' });

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

  it('11. strips unsupported optional parameters on HTTP 400/422, but never strips rejected required tools or response_format', async () => {
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

    // If an endpoint rejects `tools` with 400, adapter must fail closed with NON_RECOVERABLE rather than stripping tools
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'function calling is not supported by this model deployment' } }), {
        status: 400,
      }),
    );
    const criticalEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Use tool' }],
      tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
    })) {
      criticalEvents.push(ev);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(criticalEvents.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      failureClass: 'NON_RECOVERABLE',
      error: expect.stringContaining("rejected required capability 'tools'"),
    });
  });

  it('12. performs bounded connect-phase retries on HTTP 429 and 503 with Retry-After, and classifies quota exhaustion vs rate limits', async () => {
    // 12a. Transient 429 followed by 200 succeeds after emitting a retry event
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
          status: 429,
          headers: {
            'retry-after': '0',
            'x-ratelimit-remaining-requests': '0',
            'x-ratelimit-remaining-tokens': '100',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          makeSseStream([{ choices: [{ delta: { content: 'Recovered after 429' }, finish_reason: 'stop' }] }]),
          { status: 200 },
        ),
      );

    const adapter = new NvidiaAdapter({
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      maxRetries: 2,
      retryPolicy: { initialDelayMs: 1, maxDelayMs: 10, jitter: 0 },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const events: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Rate limited call' }],
    })) {
      events.push(ev);
    }

    const retryEvent = events.find((e) => e.type === 'retry');
    expect(retryEvent).toBeDefined();
    expect(retryEvent.failureClass).toBe('RATE_LIMIT');
    expect(retryEvent.status).toBe(429);
    expect(retryEvent.rateLimit?.remainingRequests).toBe(0);
    expect(events.find((e) => e.type === 'completed')?.content).toBe('Recovered after 429');

    // 12b. Persistent 429 exhausts retry budget and emits final RATE_LIMIT error with retryExhausted: true
    fetchMock.mockReset();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'Too many requests' }), {
          status: 429,
          headers: { 'retry-after': '0', 'x-ratelimit-remaining-requests': '0' },
        }),
      ),
    );
    const exhaustedEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      providerRetryPolicy: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5, jitter: 0 },
      messages: [{ role: 'user', content: 'Persistent 429' }],
    })) {
      exhaustedEvents.push(ev);
    }
    const errEvent = exhaustedEvents.find((e) => e.type === 'error');
    expect(errEvent).toMatchObject({
      type: 'error',
      status: 429,
      failureClass: 'RATE_LIMIT',
      retryExhausted: true,
    });

    // 12c. Quota exhaustion (HTTP 402 or 429 with insufficient_quota) is classified as QUOTA_EXHAUSTED and NOT retried
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'You have exceeded your current quota / credit balance is too low' } }), {
        status: 429,
      }),
    );
    const quotaEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Quota exhausted call' }],
    })) {
      quotaEvents.push(ev);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(quotaEvents.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      failureClass: 'QUOTA_EXHAUSTED',
      retryExhausted: false,
    });
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

    // Per-request timeout when endpoint hangs
    fetchMock.mockReset();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new DOMException('Timed out', 'TimeoutError'));
        });
      });
    });
    const timeoutAdapter = new NvidiaAdapter({
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      requestTimeoutMs: 25,
      maxRetries: 0,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const timeoutEvents: any[] = [];
    for await (const ev of timeoutAdapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Hang request' }],
    })) {
      timeoutEvents.push(ev);
    }
    expect(timeoutEvents.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      failureClass: 'TIMEOUT',
    });
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
      maxRetries: 0,
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

  it('15. detects incomplete/truncated streams, malformed SSE JSON, mid-stream error payloads, and truncated tool-call arguments', async () => {
    const adapter = new NvidiaAdapter({
      env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
      maxRetries: 0,
      fetch: fetchMock as unknown as typeof fetch,
    });

    // 15a. Stream closes cleanly (EOF) without [DONE] or finish_reason -> must emit TRANSPORT error, never completed
    fetchMock.mockResolvedValueOnce(
      new Response(
        makeSseStream(
          [
            { choices: [{ delta: { content: 'Partial output before sudden EOF...' } }] },
          ],
          { includeDone: false },
        ),
        { status: 200 },
      ),
    );
    const truncatedEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Stream truncation test' }],
    })) {
      truncatedEvents.push(ev);
    }
    expect(truncatedEvents.some((e) => e.type === 'completed')).toBe(false);
    expect(truncatedEvents.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      failureClass: 'TRANSPORT',
      error: expect.stringContaining('INCOMPLETE_PROVIDER_STREAM'),
    });

    // 15b. Malformed JSON in SSE data frame -> must emit MODEL_PROTOCOL error, never completed
    fetchMock.mockResolvedValueOnce(
      new Response(
        makeSseStream([
          { choices: [{ delta: { content: 'Valid start' } }] },
          '{corrupted-json-chunk',
        ]),
        { status: 200 },
      ),
    );
    const malformedEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Malformed SSE test' }],
    })) {
      malformedEvents.push(ev);
    }
    expect(malformedEvents.some((e) => e.type === 'completed')).toBe(false);
    expect(malformedEvents.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      failureClass: 'MODEL_PROTOCOL',
      error: expect.stringContaining('INVALID_PROVIDER_STREAM'),
    });

    // 15c. Mid-stream provider error object -> must emit error event and never replay or complete
    fetchMock.mockResolvedValueOnce(
      new Response(
        makeSseStream([
          { choices: [{ delta: { content: 'Starting generation' } }] },
          { error: { message: 'Engine worker OOM mid-stream', status: 503 } },
        ]),
        { status: 200 },
      ),
    );
    const midStreamErrEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Mid-stream error test' }],
    })) {
      midStreamErrEvents.push(ev);
    }
    expect(midStreamErrEvents.some((e) => e.type === 'completed')).toBe(false);
    expect(midStreamErrEvents.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      failureClass: 'SERVER',
      error: expect.stringContaining('Engine worker OOM mid-stream'),
    });

    // 15d. Truncated/invalid JSON in streamed tool call arguments -> must emit MODEL_PROTOCOL error, never dispatch broken tool_call
    fetchMock.mockResolvedValueOnce(
      new Response(
        makeSseStream([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_bad_1', type: 'function', function: { name: 'write', arguments: '{"path":"src/index.ts","content":' } },
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
    const badToolEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Write file' }],
      tools: [{ name: 'write', description: 'Write file', parameters: { type: 'object' } }],
    })) {
      badToolEvents.push(ev);
    }
    expect(badToolEvents.some((e) => e.type === 'tool_call')).toBe(false);
    expect(badToolEvents.some((e) => e.type === 'completed')).toBe(false);
    expect(badToolEvents.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      failureClass: 'MODEL_PROTOCOL',
      error: expect.stringContaining('INVALID_TOOL_CALL_ARGUMENTS'),
    });

    // 15e. Empty stream ([DONE] with no tokens, reasoning, or tool calls) -> must emit EMPTY_RESPONSE error
    fetchMock.mockResolvedValueOnce(new Response(makeSseStream([]), { status: 200 }));
    const emptyEvents: any[] = [];
    for await (const ev of adapter.generate({
      modelId: NVIDIA_DEFAULT_MODEL_ID,
      messages: [{ role: 'user', content: 'Empty stream test' }],
    })) {
      emptyEvents.push(ev);
    }
    expect(emptyEvents.some((e) => e.type === 'completed')).toBe(false);
    expect(emptyEvents.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      failureClass: 'EMPTY_RESPONSE',
    });
  });

  it('16. validates structured output JSON and caps model-specific max_tokens across real local mock HTTP/SSE server', async () => {
    const server = await startMockNvidiaServer();
    try {
      const adapter = new NvidiaAdapter({
        baseURL: server.baseUrl,
        env: { NVIDIA_API_KEY: TEST_NVAPI_KEY },
        maxRetries: 1,
        retryPolicy: { initialDelayMs: 5, maxDelayMs: 20, jitter: 0 },
      });

      // 16a. Structured output with valid JSON schema & model-specific maxOutputTokens cap (meta/llama-3.3-70b-instruct caps at 8192)
      server.setHandler((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'x-ratelimit-limit-requests': '60',
          'x-ratelimit-remaining-requests': '58',
          'x-ratelimit-limit-tokens': '100000',
          'x-ratelimit-remaining-tokens': '98500',
        });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"steps":["inspect","test"],' } }] })}\r\n\r\n`);
        res.write(`: keep-alive ping\r\n\r\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '"verified":true}' }, finish_reason: 'stop' }] })}\r\n\r\n`);
        res.write(
          `data: ${JSON.stringify({
            usage: {
              prompt_tokens: 120,
              completion_tokens: 16,
              total_tokens: 136,
              prompt_tokens_details: { cached_tokens: 64 },
              completion_tokens_details: { reasoning_tokens: 4 },
            },
          })}\r\n\r\n`,
        );
        res.write('data: [DONE]\r\n\r\n');
        res.end();
      });

      const validSchemaEvents: any[] = [];
      for await (const ev of adapter.generate({
        modelId: 'meta/llama-3.3-70b-instruct',
        maxTokens: 32000, // exceeds Llama 3.3 70B's 8192 maxOutputTokens
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'verification_plan',
            schema: {
              type: 'object',
              properties: { steps: { type: 'array' }, verified: { type: 'boolean' } },
              required: ['steps', 'verified'],
            },
          },
        },
        messages: [{ role: 'user', content: 'Generate plan JSON' }],
      })) {
        validSchemaEvents.push(ev);
      }

      expect(server.requests[0].parsedBody.max_tokens).toBe(8192);
      expect(server.requests[0].parsedBody.extra_body).toBeUndefined(); // Llama 3.3 70B does not use Nemotron thinking kwargs
      expect(server.requests[0].parsedBody.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'verification_plan',
          schema: {
            type: 'object',
            properties: { steps: { type: 'array' }, verified: { type: 'boolean' } },
            required: ['steps', 'verified'],
          },
        },
      });

      const completed = validSchemaEvents.find((e) => e.type === 'completed');
      expect(completed).toBeDefined();
      expect(JSON.parse(completed.content)).toEqual({ steps: ['inspect', 'test'], verified: true });
      expect(completed.usage).toMatchObject({
        inputTokens: 120,
        outputTokens: 16,
        totalTokens: 136,
        cacheReadTokens: 64,
        reasoningTokens: 4,
      });
      expect(completed.rateLimit).toMatchObject({
        source: 'provider-headers',
        limitRequests: 60,
        remainingRequests: 58,
        limitTokens: 100000,
        remainingTokens: 98500,
      });

      // 16b. Invalid non-JSON returned when responseFormat is json_object -> fails with MODEL_PROTOCOL
      server.setHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Not valid JSON at all' }, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

      const invalidJsonEvents: any[] = [];
      for await (const ev of adapter.generate({
        modelId: NVIDIA_DEFAULT_MODEL_ID,
        responseFormat: { type: 'json_object' },
        messages: [{ role: 'user', content: 'Return JSON object' }],
      })) {
        invalidJsonEvents.push(ev);
      }
      expect(invalidJsonEvents.some((e) => e.type === 'completed')).toBe(false);
      expect(invalidJsonEvents.find((e) => e.type === 'error')).toMatchObject({
        type: 'error',
        failureClass: 'MODEL_PROTOCOL',
        error: expect.stringContaining('INVALID_STRUCTURED_OUTPUT'),
      });

      // 16c. Mid-stream TCP socket drop (res.destroy() after partial token) -> must NOT retry and must NOT emit completed
      let socketDropCalls = 0;
      server.setHandler((_req, res) => {
        socketDropCalls++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial token before socket reset' } }] })}\n\n`);
        setTimeout(() => res.destroy(), 10);
      });

      const dropEvents: any[] = [];
      for await (const ev of adapter.generate({
        modelId: NVIDIA_DEFAULT_MODEL_ID,
        messages: [{ role: 'user', content: 'Test mid-stream socket drop' }],
      })) {
        dropEvents.push(ev);
      }
      expect(socketDropCalls).toBe(1); // Never automatically replays a request that already started streaming
      expect(dropEvents.some((e) => e.type === 'completed')).toBe(false);
      expect(dropEvents.find((e) => e.type === 'error')).toMatchObject({
        type: 'error',
        failureClass: 'TRANSPORT',
      });
    } finally {
      await server.close();
    }
  });
});
