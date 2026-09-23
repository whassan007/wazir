import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyFailure, ExecutionFailure, type FailureClass } from '../src/failure.js';
import { providerRetryDecision, retryConnect, RetryableHttpError } from '../src/retry.js';

afterEach(() => vi.useRealTimers());

describe('failure-aware provider retry policy', () => {
  it.each<FailureClass>([
    'BUILD_FAILED', 'TEST_FAILED', 'LINT_FAILED', 'TYPECHECK_FAILED', 'CODE_FAILURE',
    'POLICY_DENIED', 'APPROVAL_REQUIRED', 'TOOL_EXECUTION_FAILED', 'TOOL_OUTCOME_UNKNOWN',
    'MODEL_PROTOCOL', 'RESOURCE_EXHAUSTED', 'NON_RECOVERABLE', 'CANCELLED',
  ])('never provider-retries %s, even with a permissive custom predicate', async failureClass => {
    const attempt = vi.fn(async () => { throw new ExecutionFailure(failureClass, 'failure'); });
    await expect(retryConnect(attempt, { isRetryable: () => true, baseDelayMs: 0 })).rejects.toThrow('failure');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('uses bounded exponential backoff and records its classification before retry', async () => {
    vi.useFakeTimers();
    const error = new RetryableHttpError(503);
    const attempt = vi.fn().mockRejectedValue(error);
    const onRetry = vi.fn();
    const result = retryConnect(attempt, {
      policy: { maxRetries: 2, initialDelayMs: 100, maxDelayMs: 150, jitter: 0 }, onRetry,
    });
    const assertion = expect(result).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await assertion;
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls.map(call => call[1])).toEqual([100, 150]);
    expect(onRetry.mock.calls.map(call => call[3].failureClass)).toEqual(['SERVER', 'SERVER']);
  });

  it('classifies rate limits and transport errors without retrying unrelated TypeErrors', () => {
    expect(classifyFailure(new RetryableHttpError(429))).toBe('RATE_LIMIT');
    expect(classifyFailure(new TypeError('fetch failed'))).toBe('TRANSPORT');
    expect(classifyFailure(new TypeError('Invalid URL'))).toBe('NON_RECOVERABLE');
    expect(classifyFailure(new Error('socket', { cause: { code: 'ECONNRESET' } }))).toBe('TRANSPORT');
    expect(classifyFailure(new DOMException('cancelled', 'AbortError'))).toBe('CANCELLED');
  });

  it.each([Infinity, NaN, -1, 1.5])('rejects invalid retry budget %s before executing', async maxRetries => {
    const attempt = vi.fn();
    await expect(retryConnect(attempt, { policy: { maxRetries } })).rejects.toThrow('Invalid retry policy');
    expect(attempt).not.toHaveBeenCalled();
  });

  it('bounds jitter at the configured delay cap', () => {
    const policy = { maxRetries: 5, initialDelayMs: 500, maxDelayMs: 1000, jitter: 0.1 };
    expect(providerRetryDecision('SERVER', 1, policy, () => 0).delayMs).toBe(450);
    expect(providerRetryDecision('SERVER', 1, policy, () => 1).delayMs).toBe(550);
    expect(providerRetryDecision('SERVER', 5, policy, () => 1).delayMs).toBe(1000);
    expect(providerRetryDecision('SERVER', 6, policy).reason).toBe('retry_budget_exhausted');
  });

  it('cancels during backoff without a second provider call', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const attempt = vi.fn().mockRejectedValue(new RetryableHttpError(503));
    const result = retryConnect(attempt, { signal: controller.signal, baseDelayMs: 1000 });
    const assertion = expect(result).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('cancelled'));
    await assertion;
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
