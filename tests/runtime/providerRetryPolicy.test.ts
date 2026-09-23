import { afterEach, describe, expect, it, vi } from 'vitest';
import { LMStudioAdapter } from '../../packages/runtimes/lmstudio/src/index.js';
import { OllamaAdapter } from '../../packages/runtimes/ollama/src/index.js';
import { ExecutionFailure } from '@wazir/shared';
import type { GenerationEvent, RuntimeAdapter } from '@wazir/runtimes-interfaces';

afterEach(() => vi.unstubAllGlobals());
const request = { modelId: 'model', messages: [], requestId: 'request', providerRetryPolicy: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 } };
async function collect(adapter: RuntimeAdapter) {
  const events: GenerationEvent[] = [];
  for await (const event of adapter.generate(request)) events.push(event);
  return events;
}

describe.each([['LM Studio', () => new LMStudioAdapter()], ['Ollama', () => new OllamaAdapter()]] as const)('%s classified connection retries', (_name, create) => {
  it('bounds retries and exposes classification and exhaustion', async () => {
    const fetch = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const events = await collect(create());
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(events.filter(e => e.type === 'retry').map(e => e.failureClass)).toEqual(['SERVER', 'SERVER']);
    expect(events.at(-1)).toMatchObject({ type: 'error', failureClass: 'SERVER', retryExhausted: true });
  });

  it.each([new TypeError('Invalid URL'), new ExecutionFailure('BUILD_FAILED', 'compiler failed'), new ExecutionFailure('POLICY_DENIED', 'denied')])('does not retry %s', async error => {
    const fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('fetch', fetch);
    const events = await collect(create());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].retryExhausted).toBe(false);
  });

  it('allows cancellation between retry intent and the next request', async () => {
    const fetch = vi.fn(async () => new Response('slow down', { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    const adapter = create();
    const iterator = adapter.generate(request)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'retry', failureClass: 'RATE_LIMIT' });
    await adapter.cancel(request.requestId);
    expect((await iterator.next()).value).toMatchObject({ type: 'error', error: 'cancelled' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
