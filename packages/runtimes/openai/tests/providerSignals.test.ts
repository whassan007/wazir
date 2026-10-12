import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyHttpFailure, parseRetryAfterMs } from '@wazir/shared';
import { readRateLimitHeaders } from '@wazir/runtimes-interfaces';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, EncryptedFileBackend } from '@wazir/secrets';
import { OpenAIAdapter } from '../src/index.js';

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

describe('provider signal parsing', () => {
  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfterMs('20', NOW)).toBe(20_000);
    expect(parseRetryAfterMs(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
    expect(parseRetryAfterMs('soon', NOW)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
  });

  it.each([
    [401, '', 'AUTH_FAILED'], [403, 'forbidden', 'AUTH_FAILED'],
    [429, '{"error":{"code":"insufficient_quota"}}', 'QUOTA_EXHAUSTED'],
    [429, 'Rate limit reached for requests', 'RATE_LIMIT'],
    [400, 'This model\'s maximum context length is 8192 tokens', 'MODEL_CONTEXT_OVERFLOW'],
    [402, '', 'QUOTA_EXHAUSTED'], [404, '', 'MODEL_UNAVAILABLE'], [503, '', 'SERVER'], [418, '', 'NON_RECOVERABLE'],
  ] as const)('HTTP %s %s -> %s', (status, body, cls) => {
    expect(classifyHttpFailure(status, body)).toBe(cls);
  });

  it('reads OpenAI and Anthropic rate-limit headers', () => {
    const openai = readRateLimitHeaders(new Headers({ 'x-ratelimit-remaining-tokens': '1200', 'x-ratelimit-limit-tokens': '40000', 'x-ratelimit-reset-tokens': '6m0s' }), NOW)!;
    expect(openai).toMatchObject({ remainingTokens: 1200, limitTokens: 40000, resetTokensAt: new Date(NOW + 360_000).toISOString() });
    const anthropic = readRateLimitHeaders(new Headers({ 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': '2026-10-12T12:01:00Z' }), NOW)!;
    expect(anthropic).toMatchObject({ remainingRequests: 0, resetRequestsAt: '2026-10-12T12:01:00.000Z' });
    expect(readRateLimitHeaders(new Headers({ 'content-type': 'json' }), NOW)).toBeUndefined();
  });
});

describe('hosted adapter emits structured failures', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('a 429 carries status, class, Retry-After and rate-limit state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-sig-'));
    const broker = new SecretBroker(new EncryptedFileBackend(dir));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"Rate limit reached"}', { status: 200 })));
    const adapter = new OpenAIAdapter(broker);
    await adapter.loginWithApiKey('sk-test-signal-0000000000000000');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"Rate limit reached for requests"}', {
      status: 429, headers: { 'retry-after': '7', 'x-ratelimit-remaining-requests': '0' },
    })));
    const events: any[] = [];
    for await (const e of adapter.generate({ modelId: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'error', status: 429, failureClass: 'RATE_LIMIT', retryAfterMs: 7000, rateLimit: { remainingRequests: 0 } });
    await fs.rm(dir, { recursive: true, force: true });
  });
});
