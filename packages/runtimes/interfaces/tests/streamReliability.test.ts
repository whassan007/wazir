import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerationEvent } from '../src/index.js';
import {
  assembleStreamingToolCalls, createSafeStreamParserState, createStreamingToolCallState,
  parseSafeStreamChunk, StreamStallWatchdog, withStreamReliability,
} from '../src/streamReliability.js';

const hang = (): AsyncIterable<GenerationEvent> => ({
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
});
async function collect(source: AsyncIterable<GenerationEvent>) {
  const events: GenerationEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
afterEach(() => vi.useRealTimers());

describe('stream supervision', () => {
  it('aborts a first-token stall with a structured error', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const result = collect(withStreamReliability((_, s) => { signal = s; return hang(); }, { firstTokenTimeoutMs: 20, maxStreamRetries: 0 }));
    const assertion = expect(result).rejects.toMatchObject({ code: 'FIRST_TOKEN_STALL_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('detects inter-token stalls and never replays partial text by default', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const result = collect(withStreamReliability(async function* () {
      attempts++; yield { type: 'token', content: 'hello' }; yield* hang();
    }, { interTokenStallTimeoutMs: 10 }));
    const assertion = expect(result).rejects.toMatchObject({ code: 'INTER_TOKEN_STALL_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(attempts).toBe(1);
  });

  it.each(['reasoning', 'attempt_started', 'tool_call'] as const)('resets the initial timer on %s', async (type) => {
    vi.useFakeTimers();
    const watchdog = new StreamStallWatchdog(undefined, { firstTokenTimeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(15);
    watchdog.observe({ type });
    await vi.advanceTimersByTimeAsync(15);
    expect(watchdog.controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    expect(watchdog.controller.signal.reason.code).toBe('FIRST_TOKEN_STALL_TIMEOUT');
    watchdog.dispose();
  });

  it('retries a disconnect before output and passes physical attempt numbers', async () => {
    const attempts: number[] = [];
    const events = await collect(withStreamReliability(async function* (attempt) {
      attempts.push(attempt);
      if (attempt === 1) throw new Error('Disconnected');
      yield { type: 'token', content: 'ok' };
      yield { type: 'completed' };
    }, { retryBackoffMs: 0 }));
    expect(attempts).toEqual([1, 2]);
    expect(events.map(e => e.type)).toEqual(['retry', 'token', 'completed']);
    expect(events[0].retryAttempt).toBe(2);
  });

  it('bounds retries and caps exponential backoff', async () => {
    vi.useFakeTimers();
    const events: GenerationEvent[] = [];
    let attempts = 0;
    const result = (async () => {
      for await (const e of withStreamReliability(async function* () { attempts++; throw new Error('disconnect'); }, {
        maxStreamRetries: 3, retryBackoffMs: 10, maxRetryBackoffMs: 15,
      })) events.push(e);
    })();
    const assertion = expect(result).rejects.toThrow('disconnect');
    await vi.runAllTimersAsync();
    await assertion;
    expect(attempts).toBe(4);
    expect(events.map(e => e.retryDelayMs)).toEqual([10, 15, 15]);
  });

  it('allows explicitly configured partial text replay', async () => {
    const events = await collect(withStreamReliability(async function* (attempt) {
      yield { type: 'token', content: 'partial' };
      if (attempt === 1) throw new Error('disconnect');
    }, { allowRetryAfterPartialTokens: true, retryBackoffMs: 0 }));
    expect(events.map(e => e.type)).toEqual(['token', 'retry', 'token']);
  });

  it('never retries an emitted tool call even with partial replay enabled', async () => {
    let attempts = 0;
    await expect(collect(withStreamReliability(async function* () {
      attempts++; yield { type: 'tool_call', toolCallId: 'side-effect' }; throw new Error('disconnect');
    }, { allowRetryAfterPartialTokens: true, retryBackoffMs: 0 }))).rejects.toThrow('disconnect');
    expect(attempts).toBe(1);
  });

  it('cancels a pending iterator promptly without retrying', async () => {
    const controller = new AbortController();
    const result = collect(withStreamReliability(() => hang(), { signal: controller.signal }));
    const assertion = expect(result).rejects.toThrow('stop');
    controller.abort(new Error('stop'));
    await assertion;
  });

  it('cleans up timers and aborts when the caller stops consuming', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const stream = withStreamReliability(async function* (_, s) { signal = s; yield { type: 'token', content: 'x' }; });
    await stream.next();
    await stream.return();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('safe stream parsing', () => {
  it('reassembles split UTF-8, SSE lines, multiline data and CRLF boundaries', () => {
    const bytes = new TextEncoder().encode('data: {"text":\r\ndata: "🌍"}\r\n\r\n');
    const state = createSafeStreamParserState();
    const values: unknown[] = [];
    for (const byte of bytes) values.push(...parseSafeStreamChunk(new Uint8Array([byte]), state).values);
    values.push(...parseSafeStreamChunk('', state, true).values);
    expect(values).toEqual([{ text: '🌍' }]);
  });

  it('reports malformed frames, skips comments and DONE, and recovers subsequent JSONL', () => {
    const result = parseSafeStreamChunk(': keep-alive\n\ndata: nope\n\ndata: [DONE]\n\n{"ok":1}\n{"ok":2}', undefined, true);
    expect(result.values).toEqual([{ ok: 1 }, { ok: 2 }]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('MALFORMED_STREAM_FRAME');
  });

  it('preserves a split JSONL record until EOF', () => {
    const state = createSafeStreamParserState();
    expect(parseSafeStreamChunk('{"va', state).values).toEqual([]);
    expect(parseSafeStreamChunk('lue":true}', state, true).values).toEqual([{ value: true }]);
  });

  it('accumulates interleaved fragmented tool arguments and detects truncation', () => {
    const state = createStreamingToolCallState();
    expect(assembleStreamingToolCalls([
      { toolCallId: 'a', toolName: 'search', argumentsDelta: '{"q":' },
      { toolCallId: 'b', argumentsDelta: '{"broken":' },
    ], state).events).toEqual([]);
    const result = assembleStreamingToolCalls([{ toolCallId: 'a', argumentsDelta: '"test"}' }], state, true);
    expect(result.events).toEqual([{ type: 'tool_call', toolCallId: 'a', toolName: 'search', toolInput: { q: 'test' } }]);
    expect(result.diagnostics[0]).toMatchObject({ code: 'STREAM_INTERRUPTED_INCOMPLETE_TOOL_CALL', toolCallId: 'b' });
    expect(state.calls.size).toBe(0);
  });
});
