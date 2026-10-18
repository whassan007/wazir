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
});
