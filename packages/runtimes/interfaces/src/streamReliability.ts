import type { GenerationEvent } from './index.js';

export type StreamStallCode = 'FIRST_TOKEN_STALL_TIMEOUT' | 'INTER_TOKEN_STALL_TIMEOUT';
export class StreamStallError extends Error {
  constructor(readonly code: StreamStallCode) { super(code); this.name = 'StreamStallError'; }
}
export interface StreamReliabilityOptions {
  firstTokenTimeoutMs?: number;
  interTokenStallTimeoutMs?: number;
  maxStreamRetries?: number;
  retryBackoffMs?: number;
  maxRetryBackoffMs?: number;
  allowRetryAfterPartialTokens?: boolean;
  signal?: AbortSignal;
}
const duration = (value: number | undefined, fallback: number): number => {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0 || result > 2_147_483_647) throw new RangeError('Invalid stream timeout');
  return result;
};

/** Owns the attempt's timer; progress restarts the deadline even before content arrives. */
export class StreamStallWatchdog {
  private timer?: ReturnType<typeof setTimeout>;
  private hasToken = false;
  readonly failure: Promise<never>;
  private reject!: (error: unknown) => void;
  private readonly first: number;
  private readonly inter: number;
  constructor(readonly controller = new AbortController(), options: StreamReliabilityOptions = {}) {
    this.first = duration(options.firstTokenTimeoutMs, 15_000);
    this.inter = duration(options.interTokenStallTimeoutMs, 10_000);
    this.failure = new Promise((_, reject) => { this.reject = reject; });
    // A watchdog can be used independently before a consumer begins racing it.
    void this.failure.catch(() => {});
    this.arm();
  }
  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const error = new StreamStallError(this.hasToken ? 'INTER_TOKEN_STALL_TIMEOUT' : 'FIRST_TOKEN_STALL_TIMEOUT');
      this.reject(error);
      this.controller.abort(error);
    }, this.hasToken ? this.inter : this.first);
  }
  observe(event: GenerationEvent): void {
    if (event.type === 'token') this.hasToken = true;
    if (['token', 'reasoning', 'tool_call', 'attempt_started'].includes(event.type)) this.arm();
  }
  dispose(): void { clearTimeout(this.timer); }
}

export type GenerationStreamFactory = (attempt: number, signal: AbortSignal) => AsyncIterable<GenerationEvent>;

/** Retries require a factory. Tool calls always prohibit replay; partial text requires opt-in. */
export async function* withStreamReliability(
  source: AsyncIterable<GenerationEvent> | GenerationStreamFactory,
  options: StreamReliabilityOptions = {},
): AsyncGenerator<GenerationEvent> {
  const retries = options.maxStreamRetries ?? 2;
  if (!Number.isSafeInteger(retries) || retries < 0) throw new RangeError('Invalid maxStreamRetries');
  const base = duration(options.retryBackoffMs, 100);
  const cap = duration(options.maxRetryBackoffMs, 2_000);
  let partial = false;
  let tool = false;
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    const watchdog = new StreamStallWatchdog(controller, options);
    const cancel = () => controller.abort(options.signal?.reason);
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? new Error('Stream cancelled')), { once: true });
    });
    void cancelled.catch(() => {});
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let iterator: AsyncIterator<GenerationEvent> | undefined;
    let failure: unknown;
    let failed = false;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      iterator = (typeof source === 'function' ? source(attempt, controller.signal) : source)[Symbol.asyncIterator]();
      while (true) {
        const result = await Promise.race([iterator.next(), watchdog.failure, cancelled]);
        if (result.done) return;
        const event = result.value;
        watchdog.observe(event);
        if (event.type === 'token' && event.content) partial = true;
        if (event.type === 'tool_call') tool = true;
        yield event;
        if (event.type === 'completed' || event.type === 'error') return;
      }
    } catch (error) { failure = error; failed = true; }
    finally {
      watchdog.dispose();
      options.signal?.removeEventListener('abort', cancel);
      controller.abort();
      // An uncooperative producer may never resolve its pending next/return. Do not block recovery.
      try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* best effort */ }
    }
    if (failed) {
      if (options.signal?.aborted || typeof source !== 'function' || attempt > retries || tool || (partial && !options.allowRetryAfterPartialTokens)) throw failure;
      const delay = Math.min(cap, base * 2 ** Math.min(attempt - 1, 30));
      yield { type: 'retry', retryAttempt: attempt + 1, retryDelayMs: delay, error: failure instanceof Error ? failure.message : String(failure) };
      if (delay) await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(options.signal?.reason ?? new Error('Stream cancelled')); };
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, delay);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) { options.signal.removeEventListener('abort', abort); abort(); }
      });
    }
  }
}

export interface StreamDiagnostic {
  code: 'MALFORMED_STREAM_FRAME' | 'STREAM_INTERRUPTED_INCOMPLETE_TOOL_CALL';
  message: string;
  frame?: string;
  toolCallId?: string;
}
export interface SafeStreamParserState {
  decoder: { decode(input?: Uint8Array, options?: { stream?: boolean }): string };
  buffer: string;
  data: string[];
}
export function createSafeStreamParserState(): SafeStreamParserState {
  return { decoder: new TextDecoder(), buffer: '', data: [] };
}
export interface SafeStreamChunkResult { values: unknown[]; diagnostics: StreamDiagnostic[] }
/** Reuse state between chunks and call with final=true at EOF. SSE frames end at blank lines. */
export function parseSafeStreamChunk(
  chunk: string | Uint8Array,
  state: SafeStreamParserState = createSafeStreamParserState(),
  final = false,
): SafeStreamChunkResult {
  const result: SafeStreamChunkResult = { values: [], diagnostics: [] };
  const parse = (frame: string) => {
    if (!frame.trim() || frame.trim() === '[DONE]') return;
    try { result.values.push(JSON.parse(frame)); }
    catch { result.diagnostics.push({ code: 'MALFORMED_STREAM_FRAME', message: 'Invalid JSON stream frame', frame }); }
  };
  const flush = () => { if (state.data.length) parse(state.data.join('\n')); state.data = []; };
  state.buffer += typeof chunk === 'string' ? state.decoder.decode() + chunk : state.decoder.decode(chunk, { stream: !final });
  if (final && typeof chunk === 'string') state.buffer += state.decoder.decode();
  const line = (value: string) => {
    if (!value) { flush(); return; }
    if (value.startsWith(':')) return;
    if (value.startsWith('data:')) { state.data.push(value.slice(5).replace(/^ /, '')); return; }
    if (/^(event|id|retry):/.test(value)) return;
    flush(); parse(value);
  };
  let match: RegExpExecArray | null;
  while ((match = /\r\n|\n|\r/.exec(state.buffer))) {
    if (!final && match[0] === '\r' && match.index === state.buffer.length - 1) break;
    line(state.buffer.slice(0, match.index));
    state.buffer = state.buffer.slice(match.index + match[0].length);
  }
  if (final) { if (state.buffer) line(state.buffer); state.buffer = ''; flush(); }
  return result;
}

export interface StreamingToolCallDelta { toolCallId: string; toolName?: string; argumentsDelta?: string }
export interface StreamingToolCallState { calls: Map<string, { name?: string; arguments: string }> }
export function createStreamingToolCallState(): StreamingToolCallState { return { calls: new Map() }; }
/** Accumulate provider-normalized deltas; only publish parsed calls when the stream ends. */
export function assembleStreamingToolCalls(
  deltas: Iterable<StreamingToolCallDelta>,
  state: StreamingToolCallState = createStreamingToolCallState(),
  final = false,
): { events: GenerationEvent[]; diagnostics: StreamDiagnostic[] } {
  for (const delta of deltas) {
    const call = state.calls.get(delta.toolCallId) ?? { arguments: '' };
    if (delta.toolName !== undefined) call.name = delta.toolName;
    call.arguments += delta.argumentsDelta ?? '';
    state.calls.set(delta.toolCallId, call);
  }
  const events: GenerationEvent[] = [];
  const diagnostics: StreamDiagnostic[] = [];
  if (final) {
    for (const [id, call] of state.calls) {
      try { events.push({ type: 'tool_call', toolCallId: id, toolName: call.name, toolInput: JSON.parse(call.arguments) }); }
      catch { diagnostics.push({ code: 'STREAM_INTERRUPTED_INCOMPLETE_TOOL_CALL', message: 'Tool arguments ended without valid JSON', toolCallId: id, frame: call.arguments }); }
    }
    state.calls.clear();
  }
  return { events, diagnostics };
}
