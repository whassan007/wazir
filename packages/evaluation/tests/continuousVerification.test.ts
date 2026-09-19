import { describe, it, expect } from 'vitest';
import {
  verifyExecution,
  verifyMetrics,
  createBaseline,
  clusterLogLines,
  normalizeLogLine,
  calculateSigmaDeviation,
  determineSeverity,
} from '../src/index.js';
import type { TelemetryMetricSnapshot, MetricBaseline, AnomalyEvent } from '../src/types/verification.js';

// Helper to create a telemetry snapshot with specific values
function makeSnapshot(overrides: Partial<TelemetryMetricSnapshot> = {}): TelemetryMetricSnapshot {
  return {
    timestamp: new Date().toISOString(),
    durationMs: 100,
    cpuPercent: 10,
    memoryBytes: 50_000_000,
    errorCount: 0,
    exitCode: 0,
    ...overrides,
  };
}

// Helper to create a baseline with specific values
function makeBaseline(overrides: Partial<MetricBaseline> = {}): MetricBaseline {
  return {
    metricName: 'durationMs',
    mean: 100,
    stdDev: 5,
    sampleCount: 10,
    p95: 110,
    ...overrides,
  };
}

// Helper to create a baseline map
function makeBaselineMap(baselines: Record<string, MetricBaseline> = {}): Map<string, MetricBaseline> {
  const map = new Map<string, MetricBaseline>();
  for (const [name, b] of Object.entries(baselines)) {
    map.set(name, b);
  }
  return map;
}

// Helper to create a set of baseline log signatures
function makeBaselineSignatures(signatures: string[] = []): Set<string> {
  return new Set(signatures);
}

describe('Gate 11: Continuous Verification & Anomaly Rollback Engine', () => {
  describe('verifyMetrics - Metric Verification', () => {
    it('should not flag anomalies when metrics are within baseline (medium sensitivity)', () => {
      const snapshot = makeSnapshot({ durationMs: 105, cpuPercent: 12, memoryBytes: 52_000_000 });
      const baselines = makeBaselineMap({
        durationMs: makeBaseline({ mean: 100, stdDev: 5 }),
        cpuPercent: makeBaseline({ metricName: 'cpuPercent', mean: 10, stdDev: 2 }),
        memoryBytes: makeBaseline({ metricName: 'memoryBytes', mean: 50_000_000, stdDev: 5_000_000 }),
      });

      const anomalies = verifyMetrics(snapshot, baselines, 'medium');

      expect(anomalies.length).toBe(0);
    });

    it('should flag duration anomaly when deviation exceeds 2-sigma threshold', () => {
      const snapshot = makeSnapshot({ durationMs: 135 }); // 7 sigma deviation (mean=100, stdDev=5)
      const baselines = makeBaselineMap({
        durationMs: makeBaseline({ mean: 100, stdDev: 5 }),
      });

      const anomalies = verifyMetrics(snapshot, baselines, 'medium'); // 2-sigma threshold

      expect(anomalies.length).toBe(1);
      expect(anomalies[0].metricName).toBe('durationMs');
      expect(anomalies[0].observedValue).toBe(135);
      expect(anomalies[0].sigmaDeviation).toBeGreaterThan(2);
      expect(anomalies[0].severity).toBe('high'); // 7 sigma should be high or critical
    });

    it('should flag memory anomaly with high sensitivity (1-sigma threshold)', () => {
      const snapshot = makeSnapshot({ memoryBytes: 65_000_000 }); // 3 sigma deviation (mean=50M, stdDev=5M)
      const baselines = makeBaselineMap({
        memoryBytes: makeBaseline({ metricName: 'memoryBytes', mean: 50_000_000, stdDev: 5_000_000 }),
      });

      const anomalies = verifyMetrics(snapshot, baselines, 'high'); // 1-sigma threshold

      expect(anomalies.length).toBe(1);
      expect(anomalies[0].metricName).toBe('memoryBytes');
      expect(anomalies[0].severity).toBe('high'); // > 1 sigma should be flagged at high sensitivity
    });

    it('should not flag memory anomaly with low sensitivity (3-sigma threshold)', () => {
      const snapshot = makeSnapshot({ memoryBytes: 65_000_000 }); // 3 sigma deviation
      const baselines = makeBaselineMap({
        memoryBytes: makeBaseline({ metricName: 'memoryBytes', mean: 50_000_000, stdDev: 5_000_000 }),
      });

      const anomalies = verifyMetrics(snapshot, baselines, 'low'); // 3-sigma threshold

      expect(anomalies.length).toBe(0); // Exactly at 3 sigma should not trigger (needs to exceed)
    });

    it('should flag CPU anomaly when deviation exceeds threshold', () => {
      const snapshot = makeSnapshot({ cpuPercent: 45 }); // 8.75 sigma deviation (mean=10, stdDev=4)
      const baselines = makeBaselineMap({
        cpuPercent: makeBaseline({ metricName: 'cpuPercent', mean: 10, stdDev: 4 }),
      });

      const anomalies = verifyMetrics(snapshot, baselines, 'medium'); // 2-sigma threshold

      expect(anomalies.length).toBe(1);
      expect(anomalies[0].metricName).toBe('cpuPercent');
    });

    it('should flag errorCount anomaly when errors are present', () => {
      const snapshot = makeSnapshot({ errorCount: 5 });
      const baselines = makeBaselineMap({
        errorCount: makeBaseline({ metricName: 'errorCount', mean: 0, stdDev: 0.5 }),
      });

      const anomalies = verifyMetrics(snapshot, baselines, 'medium');

      expect(anomalies.length).toBe(1);
      expect(anomalies[0].metricName).toBe('errorCount');
      expect(anomalies[0].observedValue).toBe(5);
    });

    it('should not flag errorCount when baseline has zero stdDev and observed is 0', () => {
      const snapshot = makeSnapshot({ errorCount: 0 });
      const baselines = makeBaselineMap({
        errorCount: makeBaseline({ metricName: 'errorCount', mean: 0, stdDev: 0 }),
      });

      const anomalies = verifyMetrics(snapshot, baselines, 'medium');

      expect(anomalies.length).toBe(0);
    });

    it('should handle zero standard deviation correctly (infinite sigma)', () => {
      const snapshot = makeSnapshot({ durationMs: 200 }); // Different from mean of 100, but stdDev is 0
      const baselines = makeBaselineMap({
        durationMs: makeBaseline({ mean: 100, stdDev: 0 }),
      });

      const anomalies = verifyMetrics(snapshot, baselines, 'medium');

      expect(anomalies.length).toBe(1);
      expect(anomalies[0].sigmaDeviation).toBe(Infinity);
    });

    it('should calculate sigma deviation correctly', () => {
      expect(calculateSigmaDeviation(110, 100, 5)).toBe(2); // exactly 2 sigma
      expect(calculateSigmaDeviation(95, 100, 5)).toBe(-1); // exactly -1 sigma
      expect(calculateSigmaDeviation(100, 100, 5)).toBe(0); // exactly at mean
    });
  });

  describe('Gate 11.5: Novel Error Signatures', () => {
    it('should fail verification when novel error signatures are detected in logs (even with exit code 0)', () => {
      const snapshot = makeSnapshot({ exitCode: 0, errorCount: 0 });
      const baselines = makeBaselineMap();

      // Observed logs contain a new error signature not in baseline
      const observedLogs = [
        '2024-01-01T10:00:00Z Error: Connection timeout after 30s',
        '2024-01-01T10:00:01Z at src/database.ts:45:12',
      ];

      // Empty baseline signatures (no previous errors recorded)
      const baselineSignatures = makeBaselineSignatures();

      const result = verifyExecution(snapshot, baselines, observedLogs, baselineSignatures, 'medium');

      expect(result.passed).toBe(false);
      expect(result.rollbackTriggered).toBe(true);
      expect(result.anomalies.some(a => a.metricName === 'log_signature')).toBe(true);
      expect(result.rollbackReason).toContain('novel error signatures');
    });

    it('should pass verification when logs match baseline signatures', () => {
      const snapshot = makeSnapshot({ exitCode: 0, errorCount: 0 });
      const baselines = makeBaselineMap();

      // Observed logs with a known signature
      const observedLogs = [
        '2024-01-01T10:00:00Z INFO: Processing request',
        '2024-01-01T10:00:01Z DEBUG: Completed in 50ms',
      ];

      // Baseline includes the normalized signatures of these logs
      const baselineSignatures = makeBaselineSignatures([
        normalizeLogLine(observedLogs[0]),
        normalizeLogLine(observedLogs[1]),
      ]);

      const result = verifyExecution(snapshot, baselines, observedLogs, baselineSignatures, 'medium');

      expect(result.passed).toBe(true);
      expect(result.rollbackTriggered).toBe(false);
    });

    it('should detect error signatures even when normalized differently', () => {
      const snapshot = makeSnapshot({ exitCode: 0 });
      const baselines = makeBaselineMap();

      // Logs with timestamps and line numbers that should normalize to the same signature
      const observedLogs = [
        '2024-01-01T10:00:00Z Error: Connection failed at src/client.ts:123:45',
      ];

      // Baseline has a similar error but with different timestamp/line numbers
      const baselineSignatures = makeBaselineSignatures([
        normalizeLogLine('2023-12-31T23:59:59Z Error: Connection failed at src/client.ts:999:88'),
      ]);

      // After normalization, these should be the same signature
      const result = verifyExecution(snapshot, baselines, observedLogs, baselineSignatures, 'medium');

      // Since the normalized signature exists in baseline, this should pass
      expect(result.passed).toBe(true);
    });

    it('should flag error signatures that contain error keywords', () => {
      const snapshot = makeSnapshot({ exitCode: 0 });
      const baselines = makeBaselineMap();

      const observedLogs = [
        '2024-01-01T10:00:00Z Exception in thread "main" java.lang.NullPointerException',
      ];

      const baselineSignatures = makeBaselineSignatures(); // Empty baseline

      const result = verifyExecution(snapshot, baselines, observedLogs, baselineSignatures, 'medium');

      expect(result.passed).toBe(false);
      expect(result.rollbackTriggered).toBe(true);
    });
  });

  describe('Gate 11.5: Rollback Triggering', () => {
    it('should trigger rollback when critical anomaly is detected', () => {
      const snapshot = makeSnapshot({ durationMs: 5000 }); // Large deviation
      const baselines = makeBaselineMap({
        durationMs: makeBaseline({ mean: 100, stdDev: 5 }),
      });

      const result = verifyExecution(snapshot, baselines, [], makeBaselineSignatures(), 'medium');

      // With such a large deviation (98 sigma), severity should be critical
      expect(result.rollbackTriggered).toBe(true);
    });

    it('should not trigger rollback for minor anomalies', () => {
      const snapshot = makeSnapshot({ durationMs: 105 }); // Small deviation within tolerance
      const baselines = makeBaselineMap({
        durationMs: makeBaseline({ mean: 100, stdDev: 10 }),
      });

      const result = verifyExecution(snapshot, baselines, [], makeBaselineSignatures(), 'low'); // Tolerant mode

      expect(result.rollbackTriggered).toBe(false);
    });

    it('should calculate verification score based on anomaly severity', () => {
      const snapshot = makeSnapshot({ durationMs: 135 }); // High deviation
      const baselines = makeBaselineMap({
        durationMs: makeBaseline({ mean: 100, stdDev: 5 }),
      });

      const result = verifyExecution(snapshot, baselines, [], makeBaselineSignatures(), 'medium');

      expect(result.score).toBeLessThan(1);
      expect(result.passed).toBe(false); // Score should be below 0.8 threshold
    });
  });

  describe('Gate 11.5: Baseline Recording', () => {
    it('should create baseline from single metric value', () => {
      const metrics = [100, 105, 98, 102, 101];
      const baseline = createBaseline(metrics);

      expect(baseline.metricName).toBe('metric');
      expect(baseline.sampleCount).toBe(5);
      expect(baseline.mean).toBeCloseTo(101.2);
      expect(baseline.stdDev).toBeGreaterThan(0);
      expect(baseline.p95).toBeGreaterThanOrEqual(Math.max(...metrics));
    });

    it('should handle empty metrics array', () => {
      const baseline = createBaseline([]);

      expect(baseline.metricName).toBe('unknown');
      expect(baseline.sampleCount).toBe(0);
      expect(baseline.mean).toBe(0);
      expect(baseline.stdDev).toBe(0);
    });

    it('should handle single metric value (stdDev = 0)', () => {
      const baseline = createBaseline([100]);

      expect(baseline.mean).toBe(100);
      expect(baseline.stdDev).toBe(0);
      expect(baseline.p95).toBe(100);
    });
  });

  describe('Gate 11.5: Log Normalization and Clustering', () => {
    it('should normalize timestamps in log lines', () => {
      const line = '2024-01-01T10:30:45.123Z Error occurred';
      const normalized = normalizeLogLine(line);

      expect(normalized).toContain('<TIMESTAMP>');
      expect(normalized).not.toContain('2024-01-01');
    });

    it('should normalize UUIDs in log lines', () => {
      const line = 'Request id=550e8400-e29b-41d4-a716-446655440000 processed';
      const normalized = normalizeLogLine(line);

      expect(normalized).toContain('<UUID>');
      expect(normalized).not.toContain('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should normalize memory addresses', () => {
      const line = 'Segmentation fault at 0x7f8e