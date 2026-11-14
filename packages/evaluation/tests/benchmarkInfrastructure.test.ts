import { describe, it, expect } from 'vitest';
import {
  ConcurrencyBenchmarkRunner,
  DEFAULT_CONCURRENCY_LEVELS,
  compareBenchmarkReports,
  computeLatencyDistribution,
  computePercentile,
  type BenchmarkSuiteRunReport,
  type ConcurrencyLevelBenchmarkResult,
} from '../src/concurrencyBenchmarkRunner.js';

describe('Workstream 17: Benchmark Infrastructure (Concurrency 1/4/8/20)', () => {
  it('executes deterministic workloads across concurrency levels 1, 4, 8, 20 with strictly bounded worker pool concurrency', async () => {
    const activeByLevel = new Map<number, number>();
    const maxObservedByCallback = new Map<number, number>();

    const runner = new ConcurrencyBenchmarkRunner({
      suiteId: 'deterministic-bounded-pool-suite',
      concurrencyLevels: [1, 4, 8, 20],
      tasksPerLevel: (concurrency) => concurrency * 3,
      maxRetriesPerTask: 1,
    });

    const report = await runner.runDeterministicSuite(async (ctx) => {
      const currentActive = (activeByLevel.get(ctx.concurrency) ?? 0) + 1;
      activeByLevel.set(ctx.concurrency, currentActive);
      const prevMax = maxObservedByCallback.get(ctx.concurrency) ?? 0;
      if (currentActive > prevMax) {
        maxObservedByCallback.set(ctx.concurrency, currentActive);
      }

      // Verify context activeInFlight never exceeds configured concurrency
      expect(ctx.activeInFlight).toBeLessThanOrEqual(ctx.concurrency);
      expect(ctx.mode).toBe('deterministic');

      await new Promise((resolve) => setTimeout(resolve, 4));

      activeByLevel.set(ctx.concurrency, (activeByLevel.get(ctx.concurrency) ?? 1) - 1);

      return {
        ok: true,
        tokens: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        overhead: {
          taskSchedulingMs: 0.12,
          contextCompilationMs: 0.25,
          toolDispatchMs: 0.18,
          persistenceWriteMs: 0.31,
          checkpointCreateMs: 0.09,
          checkpointLookupMs: 0.04,
        },
      };
    });

    expect(report.mode).toBe('deterministic');
    expect(report.concurrencyLevels).toEqual([...DEFAULT_CONCURRENCY_LEVELS]);
    expect(report.levels).toHaveLength(4);
    expect(report.providerMetadata).toBeUndefined();

    for (const level of report.levels) {
      const expectedTasks = level.concurrency * 3;
      expect(level.mode).toBe('deterministic');
      expect(level.totalTasks).toBe(expectedTasks);
      expect(level.completedTasks).toBe(expectedTasks);
      expect(level.failedTasks).toBe(0);
      expect(level.maxObservedInFlight).toBeLessThanOrEqual(level.concurrency);
      expect(level.maxObservedInFlight).toBeGreaterThanOrEqual(1);
      expect(maxObservedByCallback.get(level.concurrency)).toBeLessThanOrEqual(level.concurrency);

      // Verify token aggregation
      expect(level.tokens.inputTokens).toBe(expectedTasks * 100);
      expect(level.tokens.outputTokens).toBe(expectedTasks * 50);
      expect(level.tokens.totalTokens).toBe(expectedTasks * 150);

      // Verify latency distribution ordering
      expect(level.latency.minMs).toBeGreaterThan(0);
      expect(level.latency.p50Ms).toBeGreaterThanOrEqual(level.latency.minMs);
      expect(level.latency.p95Ms).toBeGreaterThanOrEqual(level.latency.p50Ms);
      expect(level.latency.p99Ms).toBeGreaterThanOrEqual(level.latency.p95Ms);
      expect(level.latency.maxMs).toBeGreaterThanOrEqual(level.latency.p99Ms);

      // Verify memory metrics structure
      expect(level.memory.rssBeforeMB).toBeGreaterThan(0);
      expect(level.memory.rssAfterMB).toBeGreaterThan(0);
      expect(level.memory.heapUsedBeforeMB).toBeGreaterThan(0);
      expect(level.memory.heapUsedAfterMB).toBeGreaterThan(0);
      expect(level.memory.heapDeltaMB).toBeCloseTo(
        level.memory.heapUsedAfterMB - level.memory.heapUsedBeforeMB,
        3,
      );

      // Verify throughput calculation
      expect(level.throughputTasksPerSec).toBeGreaterThan(0);
      expect(level.overheadBreakdownMs).toBeDefined();
      expect(level.overheadBreakdownMs?.taskSchedulingMeanMs).toBeCloseTo(0.12, 3);
    }

    // Verify subsystem microbenchmarks were captured
    expect(report.subsystems.cliStartupColdMs).toBeGreaterThanOrEqual(0);
    expect(report.subsystems.cliStartupWarmP50Ms).toBeGreaterThanOrEqual(0);
    expect(report.subsystems.engineInitP50Ms).toBeGreaterThanOrEqual(0);
    expect(report.subsystems.storeWriteP50Ms).toBeGreaterThanOrEqual(0);
    expect(report.subsystems.checkpointLookupP50Ms).toBeGreaterThanOrEqual(0);
    expect(report.subsystems.toolDispatchP50Ms).toBeGreaterThanOrEqual(0);
  });

  it('accurately computes p50, p95, p99, min, max, and mean latency distributions', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100 ms
    const dist = computeLatencyDistribution(samples);

    expect(dist.minMs).toBe(1);
    expect(dist.maxMs).toBe(100);
    expect(dist.meanMs).toBe(50.5);
    expect(dist.p50Ms).toBeCloseTo(50.5, 2);
    expect(dist.p95Ms).toBeCloseTo(95.05, 2);
    expect(dist.p99Ms).toBeCloseTo(99.01, 2);
    expect(computePercentile([], 50)).toBe(0);
    expect(computePercentile([42], 99)).toBe(42);
  });

  it('tracks retries and task failures accurately in deterministic and live modes without mixing modes', async () => {
    const runner = new ConcurrencyBenchmarkRunner({
      suiteId: 'live-suite-test',
      concurrencyLevels: [1, 4, 8, 20],
      tasksPerLevel: 8,
      maxRetriesPerTask: 1,
    });

    const liveReport = await runner.runLiveSuite({
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      endpoint: 'https://api.anthropic.com/v1/messages',
      executeTask: async (ctx) => {
        expect(ctx.mode).toBe('live');
        expect(ctx.activeInFlight).toBeLessThanOrEqual(ctx.concurrency);
        // Task 0 fails first attempt and succeeds on retry
        if (ctx.taskIndex === 0 && ctx.attempt === 0) {
          throw new Error('Transient rate limit');
        }
        // Task 1 fails all attempts
        if (ctx.taskIndex === 1) {
          return {
            ok: false,
            durationMs: 12,
            ttftMs: 5,
            inputTokens: 80,
            outputTokens: 0,
          };
        }
        return {
          ok: true,
          durationMs: 20 + (ctx.taskIndex % 5),
          ttftMs: 6 + (ctx.taskIndex % 3),
          inputTokens: 200,
          outputTokens: 100,
        };
      },
    });

    expect(liveReport.mode).toBe('live');
    expect(liveReport.providerMetadata).toEqual({
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      endpoint: 'https://api.anthropic.com/v1/messages',
    });

    for (const level of liveReport.levels) {
      expect(level.mode).toBe('live');
      expect(level.totalTasks).toBe(8);
      expect(level.completedTasks).toBe(7);
      expect(level.failedTasks).toBe(1);
      // Task 0 retried once (1) + Task 1 retried once (1) = 2 retries per level
      expect(level.retries).toBe(2);
      expect(level.liveMetrics).toBeDefined();
      expect(level.liveMetrics?.provider).toBe('anthropic');
      expect(level.liveMetrics?.model).toBe('claude-3-7-sonnet');
      expect(level.liveMetrics?.ttftP50Ms).toBeGreaterThan(0);
      expect(level.liveMetrics?.tokensPerSec).toBeGreaterThan(0);
    }
  });

  it('calculates before/after percentage speedups and detects regressions via compareBenchmarkReports', () => {
    const makeLevel = (
      concurrency: number,
      p50Ms: number,
      p95Ms: number,
      p99Ms: number,
      throughputTasksPerSec: number,
      heapDeltaMB: number,
    ): ConcurrencyLevelBenchmarkResult => ({
      mode: 'deterministic',
      concurrency,
      totalTasks: 40,
      completedTasks: 40,
      failedTasks: 0,
      wallClockDurationMs: 1000,
      throughputTasksPerSec,
      latency: {
        minMs: p50Ms * 0.5,
        p50Ms,
        p95Ms,
        p99Ms,
        maxMs: p99Ms * 1.1,
        meanMs: p50Ms * 1.05,
      },
      memory: {
        rssBeforeMB: 100,
        rssAfterMB: 110,
        heapUsedBeforeMB: 50,
        heapUsedAfterMB: 50 + heapDeltaMB,
        heapDeltaMB,
      },
      tokens: { inputTokens: 4000, outputTokens: 2000, totalTokens: 6000 },
      retries: 0,
      maxObservedInFlight: concurrency,
    });

    const baseline: BenchmarkSuiteRunReport = {
      suiteId: 'baseline-v1',
      mode: 'deterministic',
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuCount: 8,
        totalMemoryMB: 16384,
        timestamp: new Date().toISOString(),
      },
      concurrencyLevels: [1, 4, 8, 20],
      levels: [
        makeLevel(1, 20, 30, 40, 50, 4.0),
        makeLevel(4, 25, 40, 55, 160, 8.0),
        makeLevel(8, 35, 60, 80, 240, 12.0),
        makeLevel(20, 60, 110, 150, 320, 24.0),
      ],
      subsystems: {
        cliStartupColdMs: 120,
        cliStartupWarmP50Ms: 15,
        engineInitP50Ms: 10,
        storeWriteP50Ms: 4,
        checkpointLookupP50Ms: 2,
        toolDispatchP50Ms: 3,
      },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalWallClockMs: 4000,
    };

    const optimizedCandidate: BenchmarkSuiteRunReport = {
      ...baseline,
      suiteId: 'candidate-optimized-v2',
      levels: [
        makeLevel(1, 10, 15, 20, 100, 2.0), // -50% latency, +100% throughput, -50% heap
        makeLevel(4, 15, 24, 33, 240, 5.0),
        makeLevel(8, 21, 36, 48, 360, 7.5),
        makeLevel(20, 30, 55, 75, 500, 12.0),
      ],
      subsystems: {
        cliStartupColdMs: 72, // -40%
        cliStartupWarmP50Ms: 9, // -40%
        engineInitP50Ms: 5, // -50%
        storeWriteP50Ms: 2, // -50%
        checkpointLookupP50Ms: 0.5, // -75%
        toolDispatchP50Ms: 1.5, // -50%
      },
    };

    const speedupSummary = compareBenchmarkReports(baseline, optimizedCandidate);
    expect(speedupSummary.hasRegressions).toBe(false);
    expect(speedupSummary.regressionDetails).toHaveLength(0);
    expect(speedupSummary.concurrencyComparisons).toHaveLength(4);

    const c1 = speedupSummary.concurrencyComparisons.find((c) => c.concurrency === 1)!;
    expect(c1.p50Ms.percentageDelta).toBe(-50);
    expect(c1.p50Ms.improved).toBe(true);
    expect(c1.throughputTasksPerSec.percentageDelta).toBe(100);
    expect(c1.throughputTasksPerSec.improved).toBe(true);
    expect(c1.heapDeltaMB.percentageDelta).toBe(-50);
    expect(c1.heapDeltaMB.improved).toBe(true);

    expect(speedupSummary.subsystemComparisons.cliStartupColdMs.percentageDelta).toBe(-40);
    expect(speedupSummary.subsystemComparisons.checkpointLookupP50Ms.percentageDelta).toBe(-75);

    // Now test regression detection when candidate is slower at concurrency=20 and storeWriteP50Ms regresses
    const regressedCandidate: BenchmarkSuiteRunReport = {
      ...optimizedCandidate,
      suiteId: 'candidate-regressed-v3',
      levels: [
        makeLevel(1, 10, 15, 20, 100, 2.0),
        makeLevel(4, 15, 24, 33, 240, 5.0),
        makeLevel(8, 21, 36, 48, 360, 7.5),
        makeLevel(20, 90, 165, 210, 200, 36.0), // +50% p50, -37.5% throughput, +50% heap
      ],
      subsystems: {
        ...optimizedCandidate.subsystems,
        storeWriteP50Ms: 6, // +50% regression vs baseline 4ms
      },
    };

    const regressionSummary = compareBenchmarkReports(baseline, regressedCandidate);
    expect(regressionSummary.hasRegressions).toBe(true);
    expect(regressionSummary.regressionDetails.some((d) => d.includes('concurrency=20: p50Ms regressed'))).toBe(true);
    expect(
      regressionSummary.regressionDetails.some((d) => d.includes('concurrency=20: throughputTasksPerSec regressed')),
    ).toBe(true);
    expect(regressionSummary.regressionDetails.some((d) => d.includes('subsystem.storeWriteP50Ms: regressed'))).toBe(
      true,
    );

    // Ensure comparing deterministic with live throws an error
    const liveCandidate: BenchmarkSuiteRunReport = {
      ...optimizedCandidate,
      mode: 'live',
    };
    expect(() => compareBenchmarkReports(baseline, liveCandidate)).toThrow(
      /Cannot compare mixed benchmark modes/,
    );
  });
});
