import { describe, expect, it } from 'vitest';
import {
  FairSchedulerQueue,
  SchedulerQueueFullError,
  classifySchedulerPriority,
  resolveSchedulerPriority,
  type FairSchedulerQueueOptions,
} from '../src/services/schedulerFairness.js';

function makeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function makeQueue(options: FairSchedulerQueueOptions = {}) {
  const clock = makeClock();
  const queue = new FairSchedulerQueue<string>({ now: clock.now, ...options });
  return { queue, clock };
}

function drain<T>(queue: FairSchedulerQueue<T>, complete = true): string[] {
  const ids: string[] = [];
  for (let task = queue.dequeue(); task; task = queue.dequeue()) {
    ids.push(task.id);
    if (complete) queue.complete(task.id);
  }
  return ids;
}

describe('FairSchedulerQueue — bounded admission', () => {
  it('uses documented defaults of 500 global and 50 per job', () => {
    const { queue } = makeQueue();
    for (let i = 0; i < 50; i++) queue.enqueue({ jobId: 'job-a', payload: `a${i}` });
    const result = queue.tryEnqueue({ jobId: 'job-a', payload: 'overflow' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TENANT_QUOTA_EXCEEDED');
      expect(result.error.limit).toBe(50);
    }

    for (let j = 1; j < 10; j++) {
      for (let i = 0; i < 50; i++) queue.enqueue({ jobId: `job-${j}`, payload: 'x' });
    }
    expect(queue.size).toBe(500);
    expect(() => queue.enqueue({ jobId: 'fresh', payload: 'x' })).toThrow(SchedulerQueueFullError);
  });

  it('rejects with QUEUE_CAPACITY_EXCEEDED when the global bound is reached', () => {
    const { queue } = makeQueue({ maxQueueSize: 3 });
    queue.enqueue({ jobId: 'a', payload: '1' });
    queue.enqueue({ jobId: 'b', payload: '2' });
    queue.enqueue({ jobId: 'c', payload: '3' });

    let caught: unknown;
    try {
      queue.enqueue({ jobId: 'd', payload: '4' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchedulerQueueFullError);
    const error = caught as SchedulerQueueFullError;
    expect(error.code).toBe('QUEUE_CAPACITY_EXCEEDED');
    expect(error.scope).toBe('queue');
    expect(error.limit).toBe(3);
    expect(queue.size).toBe(3);

    // Dispatching frees capacity: backpressure is about queued, not in-flight, work.
    queue.dequeue();
    expect(() => queue.enqueue({ jobId: 'd', payload: '4' })).not.toThrow();
  });

  it('enforces per-job and per-tenant quotas independently', () => {
    const { queue } = makeQueue({ maxPerJobQueueSize: 2, maxPerTenantQueueSize: 3 });
    queue.enqueue({ jobId: 'job-1', tenantId: 't1', payload: 'a' });
    queue.enqueue({ jobId: 'job-1', tenantId: 't1', payload: 'b' });

    const jobRejection = queue.checkAdmission('job-1', 't1');
    expect(jobRejection?.code).toBe('TENANT_QUOTA_EXCEEDED');
    expect(jobRejection?.scope).toBe('job');
    expect(jobRejection?.key).toBe('job-1');

    queue.enqueue({ jobId: 'job-2', tenantId: 't1', payload: 'c' });
    const tenantResult = queue.tryEnqueue({ jobId: 'job-3', tenantId: 't1', payload: 'd' });
    expect(tenantResult.ok).toBe(false);
    if (!tenantResult.ok) {
      expect(tenantResult.error.scope).toBe('tenant');
      expect(tenantResult.error.key).toBe('t1');
    }

    // Other tenants are unaffected by t1 being at quota.
    expect(queue.tryEnqueue({ jobId: 'job-4', tenantId: 't2', payload: 'e' }).ok).toBe(true);
    // The job quota still applies when the task names a different tenant.
    const jobFull = queue.tryEnqueue({ jobId: 'job-1', tenantId: 't9', payload: 'f' });
    expect(jobFull.ok).toBe(false);
    const metrics = queue.getMetrics();
    expect(metrics.totalRejected).toBe(2);
    expect(metrics.rejectedByCode.TENANT_QUOTA_EXCEEDED).toBe(2);
  });

  it('frees quota when a queued task is removed and rejects duplicate ids', () => {
    const { queue } = makeQueue({ maxPerJobQueueSize: 1 });
    queue.enqueue({ id: 't1', jobId: 'j', payload: 'a' });
    expect(queue.tryEnqueue({ jobId: 'j', payload: 'b' }).ok).toBe(false);
    expect(queue.remove('t1')).toBe(true);
    expect(queue.remove('t1')).toBe(false);
    queue.enqueue({ id: 't2', jobId: 'j', payload: 'b' });
    expect(() => queue.enqueue({ id: 't2', jobId: 'other', payload: 'c' })).toThrow(/already queued/);
  });
});

describe('FairSchedulerQueue — priority ordering and aging', () => {
  it('dispatches by base priority, FIFO within a priority', () => {
    const { queue } = makeQueue();
    queue.enqueue({ id: 'low', jobId: 'j', priority: 'low', payload: '' });
    queue.enqueue({ id: 'normal-1', jobId: 'j', payload: '' });
    queue.enqueue({ id: 'critical', jobId: 'j', priority: 'critical', payload: '' });
    queue.enqueue({ id: 'high', jobId: 'j', priority: 'high', payload: '' });
    queue.enqueue({ id: 'normal-2', jobId: 'j', priority: 'normal', payload: '' });
    queue.enqueue({ id: 'numeric-90', jobId: 'j', priority: 90, payload: '' });

    expect(drain(queue)).toEqual(['critical', 'numeric-90', 'high', 'normal-1', 'normal-2', 'low']);
  });

  it('ages effective priority with wait time', () => {
    const { queue, clock } = makeQueue({ agingRatePerSec: 2 });
    queue.enqueue({ id: 't', jobId: 'j', priority: 'low', payload: '' });
    expect(queue.getEffectivePriority('t')).toBe(25);
    clock.advance(10_000);
    expect(queue.getEffectivePriority('t')).toBe(45);
    const dispatch = queue.dequeue()!;
    expect(dispatch.waitMs).toBe(10_000);
    expect(dispatch.effectivePriority).toBe(45);
    expect(queue.getEffectivePriority('t')).toBeUndefined();
  });

  it('prevents starvation of a low-priority task under a continuous critical stream', () => {
    // agingRatePerSec 1 → a low task (25) overtakes fresh critical work (100) after 75s.
    const { queue, clock } = makeQueue({ agingRatePerSec: 1, fairnessPenaltyPerSlot: 0 });
    queue.enqueue({ id: 'background', jobId: 'job', priority: 'low', payload: '' });

    let dispatchedBackgroundAtSec: number | undefined;
    for (let sec = 0; sec < 300; sec++) {
      queue.enqueue({ id: `crit-${sec}`, jobId: 'job', priority: 'critical', payload: '' });
      const next = queue.dequeue()!;
      queue.complete(next.id);
      if (next.id === 'background') {
        dispatchedBackgroundAtSec = sec;
        expect(next.agedPromotion).toBe(true);
        break;
      }
      clock.advance(1_000);
    }

    expect(dispatchedBackgroundAtSec).toBeDefined();
    expect(dispatchedBackgroundAtSec!).toBeGreaterThanOrEqual(75);
    expect(dispatchedBackgroundAtSec!).toBeLessThanOrEqual(76);
    expect(queue.getMetrics().agedPromotions).toBeGreaterThanOrEqual(1);
  });

  it('without aging the same stream would starve the low task (control)', () => {
    const { queue, clock } = makeQueue({ agingRatePerSec: 0, fairnessPenaltyPerSlot: 0 });
    queue.enqueue({ id: 'background', jobId: 'job', priority: 'low', payload: '' });
    for (let sec = 0; sec < 300; sec++) {
      queue.enqueue({ id: `crit-${sec}`, jobId: 'job', priority: 'critical', payload: '' });
      const next = queue.dequeue()!;
      expect(next.id).not.toBe('background');
      queue.complete(next.id);
      clock.advance(1_000);
    }
    expect(queue.getMetrics().agedPromotions).toBe(0);
  });
});

describe('FairSchedulerQueue — multi-job fairness', () => {
  it('interleaves jobs instead of letting one large job monopolise slots', () => {
    const { queue } = makeQueue();
    for (let i = 0; i < 10; i++) queue.enqueue({ id: `a${i}`, jobId: 'big', payload: '' });
    queue.enqueue({ id: 'b0', jobId: 'small-1', payload: '' });
    queue.enqueue({ id: 'b1', jobId: 'small-1', payload: '' });
    queue.enqueue({ id: 'c0', jobId: 'small-2', payload: '' });

    // Four worker slots, none completing yet.
    const firstWave = [queue.dequeue()!, queue.dequeue()!, queue.dequeue()!, queue.dequeue()!];
    const jobs = firstWave.map((task) => task.jobId);
    expect(new Set(jobs)).toEqual(new Set(['big', 'small-1', 'small-2']));
    expect(jobs.filter((job) => job === 'big').length).toBeLessThanOrEqual(2);
    expect(queue.getMetrics().inFlightByJob).toEqual({
      big: jobs.filter((j) => j === 'big').length,
      'small-1': jobs.filter((j) => j === 'small-1').length,
      'small-2': 1,
    });
  });

  it('rotates evenly across jobs with equal priority over a long run', () => {
    const { queue, clock } = makeQueue();
    for (let i = 0; i < 30; i++) {
      queue.enqueue({ jobId: 'a', payload: '' });
      queue.enqueue({ jobId: 'b', payload: '' });
      queue.enqueue({ jobId: 'c', payload: '' });
    }
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const inFlight: string[] = [];
    // Three workers, each task takes 100ms.
    for (let step = 0; step < 30; step++) {
      while (inFlight.length < 3) {
        const task = queue.dequeue();
        if (!task) break;
        counts[task.jobId]++;
        inFlight.push(task.id);
      }
      clock.advance(100);
      queue.complete(inFlight.shift()!);
    }
    const values = Object.values(counts);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });

  it('skips a job at maxInFlightPerJob while others are runnable, but uses idle capacity otherwise', () => {
    const { queue } = makeQueue({ maxInFlightPerJob: 1, fairnessPenaltyPerSlot: 0 });
    queue.enqueue({ id: 'a0', jobId: 'a', priority: 'critical', payload: '' });
    queue.enqueue({ id: 'a1', jobId: 'a', priority: 'critical', payload: '' });
    queue.enqueue({ id: 'b0', jobId: 'b', priority: 'low', payload: '' });

    expect(queue.dequeue()!.id).toBe('a0');
    expect(queue.dequeue()!.id).toBe('b0'); // 'a' is capped, 'b' is runnable
    expect(queue.dequeue()!.id).toBe('a1'); // nothing else runnable: work-conserving
  });

  it('honours job weight when splitting load', () => {
    const { queue } = makeQueue();
    for (let i = 0; i < 10; i++) {
      queue.enqueue({ jobId: 'heavy', jobWeight: 3, payload: '' });
      queue.enqueue({ jobId: 'light', jobWeight: 1, payload: '' });
    }
    const dispatched = Array.from({ length: 8 }, () => queue.dequeue()!.jobId);
    const heavy = dispatched.filter((j) => j === 'heavy').length;
    expect(heavy).toBeGreaterThan(dispatched.length - heavy);
  });

  it('decays recent-dispatch load after the window elapses', () => {
    const { queue, clock } = makeQueue({ recentDispatchWindowMs: 1_000, recentDispatchWeight: 1 });
    queue.enqueue({ id: 'a0', jobId: 'a', payload: '' });
    queue.complete(queue.dequeue()!.id);
    // 'a' was just served; 'b' (enqueued later) wins despite equal priority.
    queue.enqueue({ id: 'a1', jobId: 'a', payload: '' });
    queue.enqueue({ id: 'b0', jobId: 'b', payload: '' });
    expect(queue.dequeue()!.id).toBe('b0');
    queue.complete('b0');

    queue.enqueue({ id: 'b1', jobId: 'b', payload: '' });
    clock.advance(1_500);
    // Both windows expired; older a1 wins on aging.
    expect(queue.dequeue()!.id).toBe('a1');
  });
});

describe('FairSchedulerQueue — metrics', () => {
  it('reports depth, per-priority counts, wait times and lifetime counters', () => {
    const { queue, clock } = makeQueue({ maxQueueSize: 4 });
    expect(queue.getMetrics()).toMatchObject({ depth: 0, oldestWaitMs: 0, totalAdmitted: 0 });

    queue.enqueue({ id: 'c', jobId: 'j1', priority: 'critical', payload: '' });
    clock.advance(500);
    queue.enqueue({ id: 'h', jobId: 'j1', priority: 'high', payload: '' });
    queue.enqueue({ id: 'n', jobId: 'j2', payload: '' });
    queue.enqueue({ id: 'l', jobId: 'j2', priority: 10, payload: '' });
    queue.tryEnqueue({ jobId: 'j3', payload: '' });
    clock.advance(250);

    let metrics = queue.getMetrics();
    expect(metrics.depth).toBe(4);
    expect(metrics.byPriority).toEqual({ critical: 1, high: 1, normal: 1, low: 1 });
    expect(metrics.oldestWaitMs).toBe(750);
    expect(metrics.totalAdmitted).toBe(4);
    expect(metrics.totalRejected).toBe(1);
    expect(metrics.rejectedByCode.QUEUE_CAPACITY_EXCEEDED).toBe(1);
    expect(metrics.queuedByJob).toEqual({ j1: 2, j2: 2 });

    const first = queue.dequeue()!;
    expect(first.id).toBe('c');
    metrics = queue.getMetrics();
    expect(metrics.depth).toBe(3);
    expect(metrics.inFlight).toBe(1);
    expect(metrics.totalDispatched).toBe(1);
    expect(metrics.oldestWaitMs).toBe(250);

    expect(queue.complete(first.id)).toBe(true);
    expect(queue.complete(first.id)).toBe(false);
    drain(queue);
    metrics = queue.getMetrics();
    expect(metrics).toMatchObject({
      depth: 0,
      inFlight: 0,
      totalDispatched: 4,
      totalCompleted: 4,
      oldestWaitMs: 0,
      queuedByJob: {},
      inFlightByJob: {},
    });
  });

  it('resolves and classifies priorities, rejecting invalid input', () => {
    expect(resolveSchedulerPriority(undefined)).toBe(50);
    expect(resolveSchedulerPriority('critical')).toBe(100);
    expect(resolveSchedulerPriority(42)).toBe(42);
    expect(() => resolveSchedulerPriority(Number.NaN)).toThrow(RangeError);
    expect(classifySchedulerPriority(150)).toBe('critical');
    expect(classifySchedulerPriority(80)).toBe('high');
    expect(classifySchedulerPriority(50)).toBe('normal');
    expect(classifySchedulerPriority(-5)).toBe('low');
    expect(() => new FairSchedulerQueue({ maxQueueSize: 0 })).toThrow(RangeError);
  });
});
