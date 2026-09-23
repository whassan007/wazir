import { describe, it, expect, vi } from 'vitest';
import { retryConnect, RetryableHttpError, isRetryableHttpStatus, jitteredDelay } from '../src/retry.js';

describe('isRetryableHttpStatus', () => {
  it('retries 429 and 5xx, not 4xx or 2xx/3xx', () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(599)).toBe(true);
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
    expect(isRetryableHttpStatus(200)).toBe(false);
    expect(isRetryableHttpStatus(301)).toBe(false);
  });
});

describe('jitteredDelay', () => {
  it('grows exponentially and stays within [half, full] of the exponential value, capped at maxDelayMs', () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = jitteredDelay(attempt, 100, 1000);
      const exp = Math.min(1000, 100 * 2 ** (attempt - 1));
      expect(delay).toBeGreaterThanOrEqual(Math.floor(exp / 2));
      expect(delay).toBeLessThanOrEqual(exp);
    }
  });

  it('never exceeds maxDelayMs even for a large attempt number', () => {
    const delay = jitteredDelay(20, 250, 8000);
    expect(delay).toBeLessThanOrEqual(8000);
  });
});

describe('retryConnect', () => {
  it('returns the result immediately on first success without sleeping', async () => {
    const attempt = vi.fn().mockResolvedValue('ok');
    const result = await retryConnect(attempt, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries a RetryableHttpError(503) and eventually succeeds', async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new RetryableHttpError(503);
      return 'recovered';
    });
    const onRetry = vi.fn();
    const result = await retryConnect(attempt, { baseDelayMs: 1, maxDelayMs: 5, onRetry });
    expect(result).toBe('recovered');
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toBe(1); // first retry is attempt 1
  });

  it('does not retry a non-retryable HTTP error (e.g. 400)', async () => {
    const attempt = vi.fn(async () => {
      throw new RetryableHttpError(400);
    });
    // 400 isn't classified retryable by the default classifier — but
    // RetryableHttpError's own constructor doesn't gate that, isRetryable does.
    await expect(retryConnect(attempt, { baseDelayMs: 1 })).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts and throws the last error', async () => {
    const attempt = vi.fn(async () => {
      throw new RetryableHttpError(500);
    });
    await expect(retryConnect(attempt, { baseDelayMs: 1, maxAttempts: 3 })).rejects.toThrow(/500/);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('treats a network TypeError as retryable by default', async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new TypeError('fetch failed');
      return 'ok';
    });
    const result = await retryConnect(attempt, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('honors a custom isRetryable classifier', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('custom-marker');
    });
    await expect(
      retryConnect(attempt, { baseDelayMs: 1, isRetryable: () => false }),
    ).rejects.toThrow('custom-marker');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
