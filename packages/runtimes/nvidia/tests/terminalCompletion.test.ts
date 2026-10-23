import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, EncryptedFileBackend } from '@wazir/secrets';
import type { GenerationEvent, StoredCredential } from '@wazir/runtimes-interfaces';
import { NvidiaAdapter, NVIDIA_DEFAULT_MODEL_ID } from '../src/index.js';
import { OpenAIAdapter } from '../../openai/src/index.js';
import { AnthropicAdapter } from '../../anthropic/src/index.js';
import { GoogleAdapter } from '../../google/src/index.js';

function rawSseStream(rawText: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(rawText));
      controller.close();
    },
  });
}

async function createSeededBroker(): Promise<SecretBroker> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-provider-completion-test-'));
  const broker = new SecretBroker(new EncryptedFileBackend(dir));
  const providers: Array<'nvidia' | 'openai' | 'anthropic' | 'google'> = ['nvidia', 'openai', 'anthropic', 'google'];
  for (const provider of providers) {
    const stored: StoredCredential = {
      provider,
      method: 'api-key',
      credential: { kind: 'api-key', apiKey: `test-${provider}-key-1234567890` },
      obtainedAt: new Date().toISOString(),
    };
    await broker.putCredential(provider, JSON.stringify(stored));
  }
  return broker;
}

async function collectEvents(iterable: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const ev of iterable) {
    out.push(ev);
  }
  return out;
}

describe('Provider Terminal Completion, Silent EOF, Malformed SSE & Cancellation (ISS-007, ISS-011)', () => {
  let broker: SecretBroker;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    broker = await createSeededBroker();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('NvidiaAdapter', () => {
    it('rejects silent EOF when stream closes without [DONE] or finish_reason', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          rawSseStream('data: {"choices":[{"delta":{"content":"Partial output"}}]}\n\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
      const adapter = new NvidiaAdapter({
        secrets: broker,
        fetch: fetchMock as unknown as typeof fetch,
        maxRetries: 0,
      });

      const events = await collectEvents(
        adapter.generate({
          modelId: NVIDIA_DEFAULT_MODEL_ID,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      );

      expect(events.some((e) => e.type === 'completed')).toBe(false);
      const errorEv = events.find((e) => e.type === 'error');
      expect(errorEv).toBeDefined();
      expect(errorEv?.error).toContain('INCOMPLETE_PROVIDER_STREAM');
    });

    it('rejects malformed JSON in SSE data lines and truncated trailing SSE lines', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            rawSseStream('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {broken_json\n\n'),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            rawSseStream('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ntruncated_trailing_line'),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );

      const adapter = new NvidiaAdapter({
        secrets: broker,
        fetch: fetchMock as unknown as typeof fetch,
        maxRetries: 0,
      });

      const malformedEvents = await collectEvents(
        adapter.generate({
          modelId: NVIDIA_DEFAULT_MODEL_ID,
          messages: [{ role: 'user', content: 'Malformed chunk' }],
        }),
      );
      expect(malformedEvents.some((e) => e.type === 'completed')).toBe(false);
      expect(malformedEvents.find((e) => e.type === 'error')?.error).toContain('MALFORMED_PROVIDER_STREAM');

      const truncatedEvents = await collectEvents(
        adapter.generate({
          modelId: NVIDIA_DEFAULT_MODEL_ID,
          messages: [{ role: 'user', content: 'Truncated line' }],
        }),
      );
      expect(truncatedEvents.some((e) => e.type === 'completed')).toBe(false);
      expect(truncatedEvents.find((e) => e.type === 'error')?.error).toContain('MALFORMED_PROVIDER_STREAM');
    });

    it('completes normally when [DONE] or finish_reason is received and wires request.signal cancellation', async () => {
      const abortController = new AbortController();
      const encoder = new TextEncoder();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            rawSseStream(
              'data: {"choices":[{"delta":{"content":"Hello world"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            ),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        )
        .mockImplementationOnce((_url: string, init: RequestInit) => {
          const stream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Chunk 1"}}]}\n\n'));
              init.signal?.addEventListener('abort', () => {
                try {
                  ctrl.error(new DOMException('Aborted', 'AbortError'));
                } catch {
                  // stream already closed
                }
              });
            },
          });
          return Promise.resolve(new Response(stream, { status: 200 }));
        });

      const adapter = new NvidiaAdapter({
        secrets: broker,
        fetch: fetchMock as unknown as typeof fetch,
        maxRetries: 0,
      });

      const okEvents = await collectEvents(
        adapter.generate({
          modelId: NVIDIA_DEFAULT_MODEL_ID,
          messages: [{ role: 'user', content: 'Valid completion' }],
        }),
      );
      expect(okEvents.find((e) => e.type === 'completed')?.content).toBe('Hello world');

      const cancelEvents: GenerationEvent[] = [];
      for await (const ev of adapter.generate({
        modelId: NVIDIA_DEFAULT_MODEL_ID,
        signal: abortController.signal,
        messages: [{ role: 'user', content: 'Cancel mid-stream' }],
      })) {
        cancelEvents.push(ev);
        if (ev.type === 'token') {
          abortController.abort();
        }
      }
      expect(cancelEvents.some((e) => e.type === 'completed')).toBe(false);
      expect(cancelEvents.find((e) => e.type === 'error')?.failureClass).toBe('CANCELLED');
    });
  });

  describe('OpenAIAdapter', () => {
    it('rejects silent EOF and malformed SSE JSON chunks, and completes on [DONE]', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            rawSseStream('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            rawSseStream('data: {invalid_json\n\n'),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            rawSseStream('data: {"choices":[{"delta":{"content":"Complete"}}]}\n\ndata: [DONE]\n\n'),
            { status: 200 },
          ),
        ) as unknown as typeof fetch;

      const adapter = new OpenAIAdapter(broker);

      const eofEvents = await collectEvents(
        adapter.generate({ modelId: 'gpt-4o', messages: [{ role: 'user', content: 'eof' }] }),
      );
      expect(eofEvents.some((e) => e.type === 'completed')).toBe(false);
      expect(eofEvents.find((e) => e.type === 'error')?.error).toContain('INCOMPLETE_PROVIDER_STREAM');

      const badJsonEvents = await collectEvents(
        adapter.generate({ modelId: 'gpt-4o', messages: [{ role: 'user', content: 'bad json' }] }),
      );
      expect(badJsonEvents.some((e) => e.type === 'completed')).toBe(false);
      expect(badJsonEvents.find((e) => e.type === 'error')?.error).toContain('MALFORMED_PROVIDER_STREAM');

      const validEvents = await collectEvents(
        adapter.generate({ modelId: 'gpt-4o', messages: [{ role: 'user', content: 'ok' }] }),
      );
      expect(validEvents.find((e) => e.type === 'completed')?.content).toBe('Complete');
    });

    it('throws Request cancelled instead of yielding completed when request.signal aborts', async () => {
      const abortController = new AbortController();
      const encoder = new TextEncoder();
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Part 1"}}]}\n\n'));
            init.signal?.addEventListener('abort', () => {
              try {
                ctrl.error(new DOMException('Aborted', 'AbortError'));
              } catch {
                // ignore
              }
            });
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }) as unknown as typeof fetch;

      const adapter = new OpenAIAdapter(broker);
      const seen: GenerationEvent[] = [];

      await expect(async () => {
        for await (const ev of adapter.generate({
          modelId: 'gpt-4o',
          signal: abortController.signal,
          messages: [{ role: 'user', content: 'abort me' }],
        })) {
          seen.push(ev);
          if (ev.type === 'token') abortController.abort();
        }
      }).rejects.toThrow('Request cancelled');

      expect(seen.some((e) => e.type === 'completed')).toBe(false);
    });
  });

  describe('AnthropicAdapter', () => {
    it('rejects silent EOF and malformed SSE JSON chunks, and completes on message_stop', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            rawSseStream(
              'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n',
            ),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(rawSseStream('data: {not_json\n\n'), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            rawSseStream(
              'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Done"}}\n\n' +
                'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n' +
                'data: {"type":"message_stop"}\n\n',
            ),
            { status: 200 },
          ),
        ) as unknown as typeof fetch;

      const adapter = new AnthropicAdapter(broker);

      const eofEvents = await collectEvents(
        adapter.generate({ modelId: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'eof' }] }),
      );
      expect(eofEvents.some((e) => e.type === 'completed')).toBe(false);
      expect(eofEvents.find((e) => e.type === 'error')?.error).toContain('INCOMPLETE_PROVIDER_STREAM');

      const badJsonEvents = await collectEvents(
        adapter.generate({ modelId: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'bad' }] }),
      );
      expect(badJsonEvents.some((e) => e.type === 'completed')).toBe(false);
      expect(badJsonEvents.find((e) => e.type === 'error')?.error).toContain('MALFORMED_PROVIDER_STREAM');

      const validEvents = await collectEvents(
        adapter.generate({ modelId: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'ok' }] }),
      );
      expect(validEvents.find((e) => e.type === 'completed')?.content).toBe('Done');
    });

    it('throws Request cancelled instead of yielding completed when request.signal aborts', async () => {
      const abortController = new AbortController();
      const encoder = new TextEncoder();
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(
              encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Part"}}\n\n'),
            );
            init.signal?.addEventListener('abort', () => {
              try {
                ctrl.error(new DOMException('Aborted', 'AbortError'));
              } catch {
                // ignore
              }
            });
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }) as unknown as typeof fetch;

      const adapter = new AnthropicAdapter(broker);
      const seen: GenerationEvent[] = [];

      await expect(async () => {
        for await (const ev of adapter.generate({
          modelId: 'claude-sonnet-4-20250514',
          signal: abortController.signal,
          messages: [{ role: 'user', content: 'abort' }],
        })) {
          seen.push(ev);
          if (ev.type === 'token') abortController.abort();
        }
      }).rejects.toThrow('Request cancelled');

      expect(seen.some((e) => e.type === 'completed')).toBe(false);
    });
  });

  describe('GoogleAdapter', () => {
    it('rejects silent EOF without finishReason and malformed SSE JSON chunks, and completes on finishReason', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            rawSseStream('data: {"candidates":[{"content":{"parts":[{"text":"Partial"}]}}]}\n\n'),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(rawSseStream('data: {malformed_json\n\n'), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            rawSseStream('data: {"candidates":[{"content":{"parts":[{"text":"Complete"}]},"finishReason":"STOP"}]}\n\n'),
            { status: 200 },
          ),
        ) as unknown as typeof fetch;

      const adapter = new GoogleAdapter(broker);

      const eofEvents = await collectEvents(
        adapter.generate({ modelId: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'eof' }] }),
      );
      expect(eofEvents.some((e) => e.type === 'completed')).toBe(false);
      expect(eofEvents.find((e) => e.type === 'error')?.error).toContain('INCOMPLETE_PROVIDER_STREAM');

      const badJsonEvents = await collectEvents(
        adapter.generate({ modelId: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'bad' }] }),
      );
      expect(badJsonEvents.some((e) => e.type === 'completed')).toBe(false);
      expect(badJsonEvents.find((e) => e.type === 'error')?.error).toContain('MALFORMED_PROVIDER_STREAM');

      const validEvents = await collectEvents(
        adapter.generate({ modelId: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'ok' }] }),
      );
      expect(validEvents.find((e) => e.type === 'completed')?.content).toBe('Complete');
    });

    it('throws Request cancelled instead of yielding completed when request.signal aborts', async () => {
      const abortController = new AbortController();
      const encoder = new TextEncoder();
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(
              encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"Part"}]}}]}\n\n'),
            );
            init.signal?.addEventListener('abort', () => {
              try {
                ctrl.error(new DOMException('Aborted', 'AbortError'));
              } catch {
                // ignore
              }
            });
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }) as unknown as typeof fetch;

      const adapter = new GoogleAdapter(broker);
      const seen: GenerationEvent[] = [];

      await expect(async () => {
        for await (const ev of adapter.generate({
          modelId: 'gemini-2.5-pro',
          signal: abortController.signal,
          messages: [{ role: 'user', content: 'abort' }],
        })) {
          seen.push(ev);
          if (ev.type === 'token') abortController.abort();
        }
      }).rejects.toThrow('Request cancelled');

      expect(seen.some((e) => e.type === 'completed')).toBe(false);
    });
  });
});
