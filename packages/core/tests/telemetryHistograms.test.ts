import { describe, it, expect } from 'vitest';
import {
  computeLatencyPercentiles,
  LatencyHistogram,
  PhaseLatencyTracker,
  TelemetryCollector,
} from '../src/services/telemetryService.js';

describe('Latency Histograms & Performance Observability (Agent 16)', () => {
  describe('computeLatencyPercentiles', () => {
    it('returns zeros when given an empty array or non-finite values', () => {
      expect(computeLatencyPercentiles([])).toEqual({
        count: 0,
        minMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        meanMs: 0,
        sumMs: 0,
      });

      expect(computeLatencyPercentiles([-10, NaN, Infinity, -Infinity])).toEqual({
        count: 0,
        minMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        meanMs: 0,
        sumMs: 0,
      });
    });

    it('accurately computes percentiles for a single-element array', () => {
      const stats = computeLatencyPercentiles([42.5]);
      expect(stats).toEqual({
        count: 1,
        minMs: 42.5,
        p50Ms: 42.5,
        p95Ms: 42.5,
        p99Ms: 42.5,
        maxMs: 42.5,
        meanMs: 42.5,
        sumMs: 42.5,
      });
    });

    it('accurately computes p50, p95, p99, min, max, mean, and sum for known distributions', () => {
      // 1 to 100 inclusive
      const samples = Array.from({ length: 100 }, (_, i) => i + 1);
      // Shuffle order to verify sorting
      const shuffled = [...samples].reverse();
      const stats = computeLatencyPercentiles(shuffled);

      expect(stats.count).toBe(100);
      expect(stats.minMs).toBe(1);
      expect(stats.maxMs).toBe(100);
      expect(stats.sumMs).toBe(5050);
      expect(stats.meanMs).toBe(50.5);
      expect(stats.p50Ms).toBeCloseTo(50.5, 2);
      expect(stats.p95Ms).toBeCloseTo(95.05, 2);
      expect(stats.p99Ms).toBeCloseTo(99.01, 2);
    });
  });

  describe('LatencyHistogram & PhaseLatencyTracker', () => {
    it('records phase timings and computes per-phase and all-phase stats', () => {
      const tracker = new PhaseLatencyTracker();
      tracker.recordPhase('cli_startup', 120);
      tracker.recordPhase('cli_startup', 140);
      tracker.recordPhase('cli_startup', 160);
      tracker.recordPhase('context_compile', 45, { executionId: 'exec-1', tokensUsed: 2048 });

      const startupStats = tracker.getPhaseStats('cli_startup');
      expect(startupStats.count).toBe(3);
      expect(startupStats.minMs).toBe(120);
      expect(startupStats.p50Ms).toBe(140);
      expect(startupStats.maxMs).toBe(160);
      expect(startupStats.meanMs).toBe(140);

      const unknownStats = tracker.getPhaseStats('non_existent_phase');
      expect(unknownStats.count).toBe(0);

      const allStats = tracker.getAllPhaseStats();
      expect(Object.keys(allStats)).toEqual(['cli_startup', 'context_compile']);
      expect(allStats.context_compile.p50Ms).toBe(45);
      expect(tracker.getPhaseMetadata('context_compile')).toEqual([
        { executionId: 'exec-1', tokensUsed: 2048 },
      ]);
    });

    it('supports startPhase timer helper and records elapsed duration idempotently', async () => {
      const tracker = new PhaseLatencyTracker();
      const stop = tracker.startPhase('engine_init', { executionId: 'exec-timer' });
      await new Promise((resolve) => setTimeout(resolve, 15));
      const elapsed1 = stop();
      const elapsed2 = stop(); // Idempotent second call

      expect(elapsed1).toBeGreaterThanOrEqual(5);
      expect(elapsed2).toBe(elapsed1);

      const stats = tracker.getPhaseStats('engine_init');
      expect(stats.count).toBe(1);
      expect(stats.p50Ms).toBe(elapsed1);
    });

    it('enforces bounded ring-buffer sample retention per phase', () => {
      const maxSamples = 10;
      const tracker = new PhaseLatencyTracker(maxSamples);

      // Insert 25 samples: 1..25. Only last 10 (16..25) should remain.
      for (let i = 1; i <= 25; i++) {
        tracker.recordPhase('tool_dispatch', i * 10, { executionId: `exec-${i}` });
      }

      const stats = tracker.getPhaseStats('tool_dispatch');
      expect(stats.count).toBe(10);
      expect(stats.minMs).toBe(160);
      expect(stats.maxMs).toBe(250);
      expect(stats.meanMs).toBe(205);

      const meta = tracker.getPhaseMetadata('tool_dispatch');
      expect(meta).toHaveLength(10);
      expect(meta[0].executionId).toBe('exec-16');
      expect(meta[9].executionId).toBe('exec-25');
    });

    it('LatencyHistogram evicts oldest samples in ring buffer when capacity is exceeded', () => {
      const hist = new LatencyHistogram(4);
      hist.record(10);
      hist.record(20);
      hist.record(30);
      hist.record(40);
      hist.record(50);
      hist.record(60);

      expect(hist.count).toBe(4);
      expect(hist.getSamples()).toEqual([30, 40, 50, 60]);
      expect(hist.getPercentiles().minMs).toBe(30);
      expect(hist.getPercentiles().maxMs).toBe(60);
    });
  });

  describe('TelemetryCollector Performance Report', () => {
    it('aggregates phase latencies, routing p50/p95/p99 latencies, retries, cache hits, and per-model breakdowns', () => {
      const collector = new TelemetryCollector();

      collector.recordPhaseLatency('cli_startup', 85);
      collector.recordPhaseLatency('cli_startup', 95);
      collector.recordPhaseLatency('routing', 12);
      collector.recordPhaseLatency('verification', 340);

      const stopTimer = collector.startPhaseTimer('checkpoint', { executionId: 'exec-1' });
      const checkpointMs = stopTimer();
      expect(checkpointMs).toBeGreaterThanOrEqual(0);

      collector.recordRoutingTelemetry({
        executionId: 'exec-1',
        taskId: 'task-1',
        modelId: 'claude-3-5-sonnet',
        runtimeId: 'anthropic',
        provider: 'anthropic',
        estimatedCostUSD: 0.015,
        actualCostUSD: 0.018,
        costStatus: 'ACTUAL',
        firstTokenLatencyMs: 210,
        endToEndLatencyMs: 1450,
        verificationDurationMs: 300,
        coldStartOverheadMs: 50,
        retryOverheadMs: 0,
        retryCount: 0,
        verifiedSuccess: true,
        cacheReuse: {
          cacheReadTokens: 800,
          cacheWriteTokens: 200,
          inputTokens: 1000,
          hitRate: 0.8,
        },
      });

      collector.recordRoutingTelemetry({
        executionId: 'exec-2',
        taskId: 'task-2',
        modelId: 'claude-3-5-sonnet',
        runtimeId: 'anthropic',
        provider: 'anthropic',
        estimatedCostUSD: 0.02,
        actualCostUSD: 0.022,
        costStatus: 'ACTUAL',
        firstTokenLatencyMs: 390,
        endToEndLatencyMs: 2150,
        verificationDurationMs: 500,
        coldStartOverheadMs: 0,
        retryOverheadMs: 420,
        retryCount: 2,
        verifiedSuccess: false,
        cacheReuse: {
          cacheReadTokens: 400,
          cacheWriteTokens: 100,
          inputTokens: 1000,
          hitRate: 0.4,
        },
      });

      collector.recordRoutingTelemetry({
        executionId: 'exec-3',
        taskId: 'task-3',
        modelId: 'gpt-4o',
        runtimeId: 'openai',
        provider: 'openai',
        estimatedCostUSD: 0.01,
        actualCostUSD: 0.01,
        costStatus: 'ACTUAL',
        firstTokenLatencyMs: 150,
        endToEndLatencyMs: 900,
        verificationDurationMs: 200,
        coldStartOverheadMs: 20,
        retryOverheadMs: 110,
        retryCount: 1,
        verifiedSuccess: true,
        cacheReuse: 'UNOBSERVED',
      });

      const report = collector.getPerformanceReport();

      // Phases
      expect(report.phases.cli_startup.count).toBe(2);
      expect(report.phases.cli_startup.p50Ms).toBe(90);
      expect(report.phases.routing.p50Ms).toBe(12);
      expect(report.phases.checkpoint.count).toBe(1);

      // Routing Latencies
      expect(report.routingLatency.firstToken.count).toBe(3);
      expect(report.routingLatency.firstToken.minMs).toBe(150);
      expect(report.routingLatency.firstToken.p50Ms).toBe(210);
      expect(report.routingLatency.firstToken.maxMs).toBe(390);

      expect(report.routingLatency.endToEnd.count).toBe(3);
      expect(report.routingLatency.endToEnd.minMs).toBe(900);
      expect(report.routingLatency.endToEnd.p50Ms).toBe(1450);
      expect(report.routingLatency.endToEnd.maxMs).toBe(2150);

      // Per-Model Breakdown
      const claude = report.byModel['claude-3-5-sonnet'];
      expect(claude).toBeDefined();
      expect(claude.calls).toBe(2);
      expect(claude.verifiedSuccessCount).toBe(1);
      expect(claude.retryCount).toBe(2);
      expect(claude.totalCostUSD).toBeCloseTo(0.04, 5);
      expect(claude.endToEndLatency.p50Ms).toBe(1800);
      expect(claude.firstTokenLatency.p50Ms).toBe(300);

      const gpt4o = report.byModel['gpt-4o'];
      expect(gpt4o).toBeDefined();
      expect(gpt4o.calls).toBe(1);
      expect(gpt4o.verifiedSuccessCount).toBe(1);
      expect(gpt4o.retryCount).toBe(1);
      expect(gpt4o.totalCostUSD).toBeCloseTo(0.01, 5);
      expect(gpt4o.endToEndLatency.p50Ms).toBe(900);

      // Totals
      expect(report.totals.decisions).toBe(3);
      expect(report.totals.totalRetries).toBe(3);
      expect(report.totals.totalActualCostUSD).toBeCloseTo(0.05, 5);
      expect(report.totals.totalEstimatedCostUSD).toBeCloseTo(0.045, 5);
      expect(report.totals.cacheHitRate).toBeCloseTo(0.6, 4);

      // Alias method check
      expect(collector.getPerformanceBreakdown()).toEqual(report);
    });
  });
});
