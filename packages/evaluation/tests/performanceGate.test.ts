import { describe, expect, it } from 'vitest';
import {
  PerformanceRegressionGate,
  evaluatePerformanceGate,
  summarizeSamples,
  welchTTest,
  mannWhitneyUTest,
  computePercentile,
} from '../src/performanceGate.js';

describe('PerformanceRegressionGate & evaluatePerformanceGate', () => {
  describe('Passing candidates (improvements or within noise floor)', () => {
    it('passes when p50 and p95 latencies improve and correctness is 100%', () => {
      const verdict = evaluatePerformanceGate(
        {
          latency: { p50Ms: 50, p95Ms: 80, p99Ms: 95, meanMs: 55, samples: 10 },
          memory: { heapDeltaMB: 40, rssMB: 120, samples: 10 },
          throughput: { opsPerSec: 500, samples: 10 },
          correctness: { passRate: 1.0, totalChecks: 20, failedChecks: 0 },
        },
        {
          latency: { p50Ms: 42, p95Ms: 68, p99Ms: 82, meanMs: 46, samples: 10 },
          memory: { heapDeltaMB: 38, rssMB: 118, samples: 10 },
          throughput: { opsPerSec: 560, samples: 10 },
          correctness: { passRate: 1.0, totalChecks: 20, failedChecks: 0 },
        },
      );

      expect(verdict.passed).toBe(true);
      expect(verdict.status).toBe('PASS');
      expect(verdict.BlockingFailures).toHaveLength(0);
      expect(verdict.checks.every((c) => c.status === 'PASS')).toBe(true);
      expect(verdict.summary).toContain('PASS');
    });

    it('passes when latency percentage increase exceeds 10% but absolute delta stays within noise floor (2.0ms)', () => {
      const verdict = evaluatePerformanceGate(
        {
          latency: { p50Ms: 5.0, p95Ms: 8.0, samples: 8 },
          memory: { heapDeltaMB: 10.0, samples: 8 },
          correctness: { passRate: 1.0 },
        },
        {
          // +25% on p50 (+1.25ms <= 2.0ms noise floor) and +18.75% on p95 (+1.5ms <= 2.0ms noise floor)
          latency: { p50Ms: 6.25, p95Ms: 9.5, samples: 8 },
          // +30% on memory (+3.0MB <= 5.0MB noise floor)
          memory: { heapDeltaMB: 13.0, samples: 8 },
          correctness: { passRate: 1.0 },
        },
      );

      expect(verdict.passed).toBe(true);
      expect(verdict.status).toBe('PASS');
      expect(verdict.BlockingFailures).toHaveLength(0);
      const p50Check = verdict.checks.find((c) => c.metric === 'latency_p50_ms');
      expect(p50Check?.status).toBe('PASS');
      expect(p50Check?.reason).toContain('WITHIN_NOISE_FLOOR');
      const memCheck = verdict.checks.find((c) => c.metric === 'memory_heap_delta_mb');
      expect(memCheck?.status).toBe('PASS');
      expect(memCheck?.reason).toContain('WITHIN_NOISE_FLOOR');
    });

    it('distinguishes a noisy single-sample p95 outlier spike from a systematic regression using raw sample arrays', () => {
      // 20 baseline samples tightly around 30ms
      const baselineSamples = Array(20).fill(30);
      // 19 candidate samples slightly faster (29ms), plus 1 single outlier spike (45ms)
      const candidateSamples = [...Array(19).fill(29), 45];

      const verdict = evaluatePerformanceGate(
        { latency: baselineSamples, correctness: true },
        { latency: candidateSamples, correctness: true },
      );

      expect(verdict.passed).toBe(true);
      expect(verdict.status).toBe('PASS');
      expect(verdict.BlockingFailures).toHaveLength(0);
    });
  });

  describe('Failing candidates on latency regression', () => {
    it('fails when p50 or p95 latency regresses by more than 10% beyond the 2.0ms noise floor', () => {
      const verdict = evaluatePerformanceGate(
        {
          latency: { p50Ms: 40, p95Ms: 70, samples: 10 },
          correctness: { passRate: 1.0 },
        },
        {
          // p50 +20% (+8ms), p95 +25% (+17.5ms)
          latency: { p50Ms: 48, p95Ms: 87.5, samples: 10 },
          correctness: { passRate: 1.0 },
        },
      );

      expect(verdict.passed).toBe(false);
      expect(verdict.status).toBe('FAIL');
      expect(verdict.BlockingFailures.length).toBeGreaterThanOrEqual(2);
      expect(verdict.BlockingFailures.join(' ')).toContain('LATENCY_REGRESSION');

      const p50Check = verdict.checks.find((c) => c.metric === 'latency_p50_ms');
      expect(p50Check?.status).toBe('FAIL');
      expect(p50Check?.deltaPercent).toBeCloseTo(20, 2);
      expect(p50Check?.thresholdPercent).toBeCloseTo(10, 2);

      const p95Check = verdict.checks.find((c) => c.metric === 'latency_p95_ms');
      expect(p95Check?.status).toBe('FAIL');
      expect(p95Check?.deltaPercent).toBeCloseTo(25, 2);
    });

    it('fails on systematic latency regression across raw sample arrays with Welch t-test and Mann-Whitney U', () => {
      const baselineSamples = [20, 21, 19, 20, 22, 20, 21, 19, 20, 21];
      const candidateSamples = [28, 29, 27, 30, 28, 29, 28, 27, 30, 29];

      const verdict = evaluatePerformanceGate(
        { latency: baselineSamples },
        { latency: candidateSamples },
      );

      expect(verdict.passed).toBe(false);
      expect(verdict.status).toBe('FAIL');
      expect(verdict.BlockingFailures.some((f) => f.includes('LATENCY_REGRESSION'))).toBe(true);
      expect(verdict.BlockingFailures.some((f) => f.includes('Welch'))).toBe(true);
    });
  });

  describe('Failing candidates on memory growth regression', () => {
    it('fails when heap delta or RSS grows by more than 15% beyond the 5.0MB noise floor', () => {
      const gate = new PerformanceRegressionGate();
      const verdict = gate.evaluate(
        {
          memory: { heapDeltaMB: 50, rssMB: 200, samples: 6 },
          correctness: { passRate: 1.0 },
        },
        {
          // heapDelta +24% (+12MB > 5MB floor), rss +20% (+40MB > 5MB floor)
          memory: { heapDeltaMB: 62, rssMB: 240, samples: 6 },
          correctness: { passRate: 1.0 },
        },
      );

      expect(verdict.passed).toBe(false);
      expect(verdict.status).toBe('FAIL');
      expect(verdict.BlockingFailures.length).toBe(2);
      expect(verdict.BlockingFailures.join(' ')).toContain('MEMORY_REGRESSION');

      const heapCheck = verdict.checks.find((c) => c.metric === 'memory_heap_delta_mb');
      expect(heapCheck?.status).toBe('FAIL');
      expect(heapCheck?.deltaPercent).toBeCloseTo(24, 2);
      expect(heapCheck?.thresholdPercent).toBeCloseTo(15, 2);
    });
  });

  describe('Failing candidates on correctness regression (strict dominance)', () => {
    it('immediately fails with CORRECTNESS_REGRESSION on any pass-rate drop even if latency improved by 50%', () => {
      const verdict = evaluatePerformanceGate(
        {
          latency: [100, 102, 98, 101, 99, 100],
          memory: { heapDeltaMB: 80, samples: 6 },
          correctness: { passRate: 1.0, totalChecks: 50, failedChecks: 0 },
        },
        {
          // 50% latency improvement and lower memory!
          latency: [50, 51, 49, 50, 48, 52],
          memory: { heapDeltaMB: 60, samples: 6 },
          // 1 check failed out of 50 -> passRate 0.98
          correctness: { passRate: 0.98, totalChecks: 50, failedChecks: 1 },
        },
      );

      expect(verdict.passed).toBe(false);
      expect(verdict.status).toBe('FAIL');
      expect(verdict.BlockingFailures.some((f) => f.includes('CORRECTNESS_REGRESSION'))).toBe(true);

      const corrCheck = verdict.checks.find((c) => c.category === 'correctness');
      expect(corrCheck?.status).toBe('FAIL');
      expect(corrCheck?.reason).toContain('CORRECTNESS_REGRESSION');

      // Latency checks themselves passed, proving correctness dominated the overall verdict
      const latencyChecks = verdict.checks.filter((c) => c.category === 'latency');
      expect(latencyChecks.every((c) => c.status === 'PASS')).toBe(true);
    });

    it('fails when failedChecks > 0 even if passRate was not explicitly provided', () => {
      const verdict = evaluatePerformanceGate(
        {
          latency: { p50Ms: 30, p95Ms: 40, samples: 5 },
          correctness: { totalChecks: 10, failedChecks: 0 },
        },
        {
          latency: { p50Ms: 15, p95Ms: 20, samples: 5 },
          correctness: { totalChecks: 10, failedChecks: 2 },
        },
      );

      expect(verdict.passed).toBe(false);
      expect(verdict.status).toBe('FAIL');
      expect(verdict.BlockingFailures[0]).toContain('CORRECTNESS_REGRESSION');
    });
  });

  describe('INCONCLUSIVE verdict when sample counts are below minSamples', () => {
    it('marks checks and overall verdict INCONCLUSIVE when sample count < minSamples (default 5)', () => {
      const verdict = evaluatePerformanceGate(
        {
          latency: { p50Ms: 50, p95Ms: 70, samples: 3 },
          memory: { heapDeltaMB: 30, samples: 3 },
        },
        {
          latency: { p50Ms: 40, p95Ms: 60, samples: 3 },
          memory: { heapDeltaMB: 25, samples: 3 },
        },
      );

      expect(verdict.passed).toBe(false);
      expect(verdict.status).toBe('INCONCLUSIVE');
      expect(verdict.BlockingFailures).toHaveLength(0);
      expect(verdict.checks.every((c) => c.status === 'INCONCLUSIVE')).toBe(true);
      expect(verdict.summary).toContain('INCONCLUSIVE');
    });

    it('marks raw sample arrays with fewer than minSamples as INCONCLUSIVE', () => {
      const verdict = evaluatePerformanceGate(
        { latency: [20, 22, 21] },
        { latency: [18, 19, 17] },
      );

      expect(verdict.passed).toBe(false);
      expect(verdict.status).toBe('INCONCLUSIVE');
      expect(verdict.checks.some((c) => c.reason.includes('INSUFFICIENT_SAMPLES'))).toBe(true);
    });
  });

  describe('Throughput & Statistical Helpers', () => {
    it('fails when throughput drops by more than maxThroughputRegressionRatio', () => {
      const verdict = evaluatePerformanceGate(
        { throughput: { opsPerSec: 1000, samples: 6 } },
        { throughput: { opsPerSec: 820, samples: 6 } },
      );

      expect(verdict.passed).toBe(false);
      expect(verdict.status).toBe('FAIL');
      expect(verdict.BlockingFailures[0]).toContain('THROUGHPUT_REGRESSION');
    });

    it('computes accurate percentiles, Welch t-test, and Mann-Whitney U statistics', () => {
      const stats = summarizeSamples([10, 20, 30, 40, 50]);
      expect(stats.count).toBe(5);
      expect(stats.mean).toBe(30);
      expect(stats.p50).toBe(30);
      expect(computePercentile([10, 20, 30, 40, 50], 0.95)).toBeCloseTo(48, 5);

      const welch = welchTTest([10, 11, 9, 10, 10], [20, 21, 19, 20, 20]);
      expect(welch.significantRegression).toBe(true);
      expect(welch.pValueOneSided).toBeLessThan(0.001);

      const mw = mannWhitneyUTest([10, 11, 9, 10, 10], [20, 21, 19, 20, 20]);
      expect(mw.significantRegression).toBe(true);
      expect(mw.medianShift).toBe(10);
    });
  });
});
