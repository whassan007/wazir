import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeBackoffWithJitter, ProviderBackpressureGovernor } from '../src/services/providerBackpressure.js';

describe('ProviderBackpressureGovernor', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const create = () => new ProviderBackpressureGovernor({ defaults: {
    maxConcurrent: 1, maxQueueDepth: 2, minCooldownMs: 100, maxRetryBudgetPerMinute: 2,
  } });

  it('caps concurrency and releases exactly once', async () => {
    const governor = create();
    const first = await governor.acquire('a');
    const next = governor.acquire('a');
    expect(governor.getProviderState('a')).toMatchObject({ inFlight: 1, queued: 1 });
    first.release(); first.release({ status: 429 });
    const second = await next;
    expect(governor.getProviderState('a')).toMatchObject({ inFlight: 1, totalAdmitted: 2, totalRateLimited: 0 });
    second.release();
    expect(governor.getProviderState('a').inFlight).toBe(0);
  });

  it('isolates providers and applies provider overrides', async () => {
    const governor = new ProviderBackpressureGovernor({ defaults: { maxConcurrent: 1 }, providers: { b: { maxConcurrent: 2 } } });
    const leases = await Promise.all([governor.acquire('a'), governor.acquire('b'), governor.acquire('b')]);
    expect(governor.getAllStates()).toMatchObject({ a: { inFlight: 1 }, b: { inFlight: 2 } });
    leases.forEach(lease => lease.release());
  });

  it('rejects overflow and frees cancelled queue capacity', async () => {
    const governor = create();
    const first = await governor.acquire('a');
    const controller = new AbortController();
    const cancelled = governor.acquire('a', { signal: controller.signal });
    const cancellation = expect(cancelled).rejects.toThrow('ACQUIRE_ABORTED');
    const next = governor.acquire('a');
    await expect(governor.acquire('a')).rejects.toThrow('QUEUE_FULL');
    controller.abort();
    await cancellation;
    expect(governor.getProviderState('a')).toMatchObject({ queued: 1, totalRejected: 2 });
    first.release(); (await next).release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects already aborted signals without admission', async () => {
    const governor = create();
    const controller = new AbortController(); controller.abort();
    await expect(governor.acquire('a', { signal: controller.signal })).rejects.toThrow('ACQUIRE_ABORTED');
    expect(governor.getProviderState('a').totalAdmitted).toBe(0);
  });

  it('times out queued callers without leaking a slot or timer', async () => {
    const governor = create();
    const first = await governor.acquire('a');
    const pending = governor.acquire('a', { timeoutMs: 50 });
    const rejection = expect(pending).rejects.toThrow('ACQUIRE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(50); await rejection;
    first.release();
    expect(governor.getProviderState('a')).toMatchObject({ queued: 0, inFlight: 0, totalRejected: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors priority and FIFO for equal priorities', async () => {
    const governor = new ProviderBackpressureGovernor({ defaults: { maxConcurrent: 1, maxQueueDepth: 5 } });
    const first = await governor.acquire('a');
    const order: string[] = [];
    const queue = (name: string, priority: number) => governor.acquire('a', { priority }).then(lease => { order.push(name); lease.release(); });
    const pending = [queue('low', 0), queue('high1', 2), queue('high2', 2)];
    first.release(); await Promise.all(pending);
    expect(order).toEqual(['high1', 'high2', 'low']);
  });

  it('enforces 429 Retry-After cooldown on existing and new waiters', async () => {
    const governor = create();
    const first = await governor.acquire('a');
    let admitted = false;
    const pending = governor.acquire('a').then(lease => { admitted = true; return lease; });
    first.release({ status: 429, retryAfterMs: 500 });
    await expect(governor.acquire('a', { timeoutMs: 499 })).rejects.toThrow('ACQUIRE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(499);
    expect(admitted).toBe(false);
    expect(governor.getProviderState('a').cooldownRemainingMs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    (await pending).release();
    expect(governor.getProviderState('a')).toMatchObject({ totalRateLimited: 1, cooldownRemainingMs: 0 });
  });

  it('uses minimum cooldown for bare 429 and retry-after alone', async () => {
    const governor = create();
    (await governor.acquire('a')).release({ status: 429 });
    expect(governor.getProviderState('a').cooldownRemainingMs).toBe(100);
    await vi.advanceTimersByTimeAsync(100);
    (await governor.acquire('a')).release({ retryAfterMs: 300 });
    expect(governor.getProviderState('a').cooldownRemainingMs).toBe(300);
  });

  it('respects exhausted request/token windows and never shortens cooldown', async () => {
    const governor = new ProviderBackpressureGovernor({ defaults: { maxConcurrent: 2, minCooldownMs: 100 } });
    const one = await governor.acquire('a'); const two = await governor.acquire('a');
    one.release({ rateLimitRemainingRequests: 0, resetAtMs: Date.now() + 1000 });
    two.release({ rateLimitRemainingTokens: 0, retryAfterMs: 200 });
    expect(governor.getProviderState('a')).toMatchObject({ cooldownRemainingMs: 1000, totalRateLimited: 2 });
    expect(governor.canRetry('a')).toMatchObject({ allowed: false, reason: 'PROVIDER_COOLDOWN', retryDelayMs: 1000 });
  });

  it('rejects queued deadlines that become impossible after a rate limit', async () => {
    const governor = create(); const lease = await governor.acquire('a');
    const pending = governor.acquire('a', { timeoutMs: 200 });
    const rejection = expect(pending).rejects.toThrow('ACQUIRE_TIMEOUT');
    lease.release({ status: 429, retryAfterMs: 500 }); await rejection;
    expect(governor.getProviderState('a').queued).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opens retry circuit at the budget and recovers at the rolling boundary', async () => {
    const governor = create();
    expect(governor.canRetry('a').allowed).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(governor.canRetry('a').allowed).toBe(true);
    expect(governor.canRetry('a')).toMatchObject({ allowed: false, reason: 'RETRY_STORM_CIRCUIT_OPEN', retryDelayMs: 59_900 });
    expect(governor.getProviderState('a').retriesInWindow).toBe(2);
    await vi.advanceTimersByTimeAsync(59_900);
    expect(governor.canRetry('a').allowed).toBe(true);
    expect(governor.getProviderState('a').retriesInWindow).toBe(2);
  });

  it('blocks simultaneous retries and recovers when the retry lease releases', async () => {
    const governor = new ProviderBackpressureGovernor({ defaults: { maxConcurrent: 4 } });
    expect(governor.canRetry('a').allowed).toBe(true);
    const first = await governor.acquire('a', { isRetry: true });
    expect(governor.canRetry('a').allowed).toBe(true);
    const second = await governor.acquire('a', { isRetry: true });
    expect(governor.canRetry('a')).toMatchObject({ allowed: false, reason: 'RETRY_STORM_CIRCUIT_OPEN' });
    await expect(governor.acquire('a', { isRetry: true })).rejects.toThrow('RETRY_STORM_CIRCUIT_OPEN');
    first.release({ isRetry: true });
    expect(governor.canRetry('a').allowed).toBe(true);
    second.release();
  });

  it('counts externally reported retry outcomes and supports custom rolling windows', async () => {
    const governor = new ProviderBackpressureGovernor({ retryWindowMs: 500, defaults: { maxRetryBudgetPerMinute: 1 } });
    (await governor.acquire('a')).release({ isRetry: true });
    expect(governor.canRetry('a').allowed).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(governor.canRetry('a').allowed).toBe(true);
  });

  it('returns detached snapshots and handles special provider names', () => {
    const governor = create(); const snapshot = governor.getProviderState('__proto__');
    snapshot.totalAdmitted = 99;
    expect(governor.getAllStates()['__proto__']!.totalAdmitted).toBe(0);
  });

  it('computes bounded jitter and respects Retry-After above the cap', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(computeBackoffWithJitter(0, 100, 1000)).toBe(200);
    expect(computeBackoffWithJitter(1, 100, 1000)).toBe(350);
    expect(computeBackoffWithJitter(1000, 100, 1000)).toBeLessThanOrEqual(1000);
    expect(computeBackoffWithJitter(2, 100, 1000, 5000)).toBe(5000);
    expect(() => computeBackoffWithJitter(-1, 100, 1000)).toThrow(RangeError);
  });

  it('validates limits, priorities and timeouts', async () => {
    expect(() => new ProviderBackpressureGovernor({ defaults: { maxConcurrent: 0 } })).toThrow(RangeError);
    expect(() => new ProviderBackpressureGovernor({ retryWindowMs: 0 })).toThrow(RangeError);
    const governor = create();
    await expect(governor.acquire('a', { timeoutMs: NaN })).rejects.toThrow('INVALID_TIMEOUT');
    await expect(governor.acquire('a', { priority: Infinity })).rejects.toThrow('INVALID_PRIORITY');
    (await governor.acquire('a', { timeoutMs: 0 })).release();
  });
});
