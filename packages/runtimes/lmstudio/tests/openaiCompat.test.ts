import { describe, it, expect, vi, afterEach } from 'vitest';
import { LMStudioAdapter } from '../src/index.js';

const sse = (...chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });

async function drain(adapter: LMStudioAdapter, req: any) {
  const events: any[] = [];
  for await (const e of adapter.generate(req)) events.push(e);
  return events;
}

describe('LMStudioAdapter against authenticated OpenAI-compatible endpoints', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the API key as a Bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await drain(new LMStudioAdapter('http://proxy/v1', { apiKey: 'sk-test' }), { modelId: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-test');
  });

  it('sends tool results with the native protocol when call ids are known', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await drain(new LMStudioAdapter('http://proxy/v1'), {
      modelId: 'm',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { key: 'zorbia' } }] },
        { role: 'tool', content: '42', toolCallId: 'call_1' },
      ],
    });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).messages;
    expect(sent[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"key":"zorbia"}' } }] });
    expect(sent[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '42' });
  });

  it('keeps legacy tool results without call ids readable as user text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse({ choices: [{ delta: { content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await drain(new LMStudioAdapter('http://proxy/v1'), { modelId: 'm', messages: [{ role: 'tool', content: 'out' }] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0]).toEqual({ role: 'user', content: '[tool result: out]' });
  });

  it('reports the provider finish reason, e.g. content_filter', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })));
    const events = await drain(new LMStudioAdapter('http://proxy/v1'), { modelId: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(events.find((e) => e.type === 'completed')?.finishReason).toBe('content_filter');
  });

  it('marks an aborted stream as cancelled rather than a normal completion', async () => {
    // Like a real fetch body: aborting the request errors the stream mid-read.
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'par' } }] })}\n\n`));
          init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    }));
    const adapter = new LMStudioAdapter('http://proxy/v1');
    const events: any[] = [];
    for await (const e of adapter.generate({ modelId: 'm', messages: [{ role: 'user', content: 'x' }], requestId: 'r1' } as any)) {
      events.push(e);
      if (e.type === 'token') await adapter.cancel('r1');
    }
    expect(events.some((e) => e.type === 'completed')).toBe(false);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ failureClass: 'CANCELLED', error: 'GENERATION_CANCELLED' });
    expect(events.filter((e) => e.type === 'token').map((e) => e.content).join('')).toBe('par');
  });

  it('streams reasoning separately and never mixes it into the answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse(
      { choices: [{ delta: { reasoning_content: 'User wants an integer. Answer 8888888.' } }] },
      { choices: [{ delta: { content: '8888888' }, finish_reason: 'stop' }] },
    )));
    const events = await drain(new LMStudioAdapter('http://proxy/v1'), { modelId: 'm', messages: [{ role: 'user', content: 'x' }] });
    const answer = events.filter((e) => e.type === 'token').map((e) => e.content).join('');
    expect(answer).toBe('8888888');
    expect(events.find((e) => e.type === 'completed')?.content).toBe('8888888');
    expect(events.filter((e) => e.type === 'reasoning').map((e) => e.content).join('')).toContain('Answer 8888888.');
  });

  it('supports OpenAI-compatible lifecycle fallback when /api/v1/models returns 404', async () => {
    process.env.WAZIR_LMS_DISABLE = '1';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/models') || url.endsWith('/api/v1/models/load') || url.endsWith('/api/v1/models/unload')) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.endsWith('/v1/models')) {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'mlx-community/Qwen3.5-9B-6bit', object: 'model', owned_by: 'mlx_lm' },
              { id: 'mlx-community/Qwen2.5-Coder-7B-4bit', object: 'model', owned_by: 'mlx_lm' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/v1/chat/completions') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not Found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LMStudioAdapter('http://127.0.0.1:8080/v1');
    const estimate = await adapter.estimateModelLoad('mlx-community/Qwen3.5-9B-6bit', 16384);
    expect(estimate.source).toBe('HEURISTIC');
    expect(estimate.totalMemoryBytes).toBeGreaterThan(5 * 1024 ** 3);

    await adapter.loadModel('mlx-community/Qwen3.5-9B-6bit', { contextTokens: 16384 });
    const inspected = await adapter.inspectModel('mlx-community/Qwen3.5-9B-6bit');
    expect(inspected).toMatchObject({
      modelId: 'mlx-community/Qwen3.5-9B-6bit',
      loaded: true,
      effectiveContext: 16384,
    });
    expect(await adapter.getLoadedModels()).toEqual(['mlx-community/Qwen3.5-9B-6bit']);
    expect(await adapter.probeModel('mlx-community/Qwen3.5-9B-6bit', 16384)).toBe(true);

    await adapter.unloadModel('mlx-community/Qwen3.5-9B-6bit');
    expect((await adapter.inspectModel('mlx-community/Qwen3.5-9B-6bit')).loaded).toBe(false);
    delete process.env.WAZIR_LMS_DISABLE;
  });
});
