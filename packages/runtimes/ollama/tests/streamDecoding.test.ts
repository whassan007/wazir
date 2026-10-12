import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaAdapter } from '../src/index.js';

/** Streams `bytes` as two chunks split at `splitAt`, which may land inside a UTF-8 sequence. */
function splitStream(bytes: Uint8Array, splitAt: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, splitAt));
      controller.enqueue(bytes.slice(splitAt));
      controller.close();
    },
  });
}

describe('OllamaAdapter stream decoding', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reassembles multi-byte UTF-8 characters split across chunk boundaries', async () => {
    const text = 'مرحبا 👋';
    const body = new TextEncoder().encode(
      `${JSON.stringify({ message: { content: text } })}\n${JSON.stringify({ done: true, prompt_eval_count: 1, eval_count: 1 })}\n`,
    );
    // Split inside the 4-byte emoji.
    const emojiStart = body.indexOf(0xf0);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(splitStream(body, emojiStart + 2), { status: 200 })));

    let tokens = '';
    for await (const event of new OllamaAdapter().generate({ modelId: 'm', messages: [{ role: 'user', content: 'hi' }] } as any)) {
      if (event.type === 'token') tokens += event.content ?? '';
      if (event.type === 'error') throw new Error(event.error);
    }
    expect(tokens).toBe(text);
    expect(tokens).not.toContain('�');
  });
});

describe('OllamaAdapter early consumer exit', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('aborts the underlying request when the consumer stops iterating mid-stream', async () => {
    let signal: AbortSignal | undefined;
    const line = new TextEncoder().encode(`${JSON.stringify({ message: { content: 'tok' } })}\n`);
    // Never closes: models a provider that keeps generating.
    const body = new ReadableStream<Uint8Array>({ pull: (c) => new Promise((r) => setTimeout(() => { c.enqueue(line); r(); }, 1)) });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(body, { status: 200 });
    }));

    for await (const event of new OllamaAdapter().generate({ modelId: 'm', messages: [{ role: 'user', content: 'hi' }] } as any)) {
      if (event.type === 'token') break;
    }
    expect(signal?.aborted).toBe(true);
  });
});
