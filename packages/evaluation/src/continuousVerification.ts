import type {
  AnomalySeverity,
  TelemetryMetricSnapshot,
  MetricBaseline,
  AnomalyEvent,
  VerificationResult,
} from './types/verification.js';

/**
 * Sensitivity levels for anomaly detection.
 * - high: 1-sigma threshold (flags any deviation > 1 std dev)
 * - medium: 2-sigma threshold (standard latency/memory regressions)
 * - low: 3-sigma threshold (catastrophic performance drops)
 */
export type SensitivityLevel = 'high' | 'medium' | 'low';

const SIGMA_THRESHOLDS: Record<SensitivityLevel, number> = {
  high: 1.0,
  medium: 2.0,
  low: 3.0,
};

/**
 * Normalizes log lines by removing timestamps, UUIDs, memory addresses, and line numbers.
 * Extracts the underlying error signature for clustering.
 */
export function normalizeLogLine(line: string): string {
  // Remove timestamps (ISO format or common patterns)
  let normalized = line
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<TIMESTAMP>')
    .replace(/\[\d{4}-\d{2}-\d{2}[\s\d:.-]+\]/g, '<TIMESTAMP>')
    .replace(/\(\d{4}-\d{2}-\d{2}[\s\d:.-]+\)/g, '<TIMESTAMP>');

  // Remove UUIDs
  normalized = normalized.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<UUID>');

  // Remove memory addresses
  normalized = normalized.replace(/0x[0-9a-fA-F]+/g, '<ADDR>');

  // Remove file line numbers (e.g., "file.ts:123", ":12:")
  normalized = normalized.replace(/:\d+:\d+/g, ':<LINE>:<COL>');
  normalized = normalized.replace(/:\d+$/g, ':<LINE>');

  // Remove process/thread IDs
  normalized = normalized.replace(/pid=\d+/gi, 'pid=<PID>');
  normalized = normalized.replace(/tid=\d+/gi, 'tid=<TID>');

  // Normalize whitespace for consistent clustering
  return normalized.trim().replace(/\s+/g, ' ');
}

/**
 * Clusters log lines by their normalized signatures.
 */
export function clusterLogLines(lines: string[]): Map<string, string[]> {
  const clusters = new Map<string, string[]>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const signature = normalizeLogLine(line);
    const existing = clusters.get(signature) || [];
    clusters.set(signature, [...existing, line]);
  }
  return clusters;
}

/**
 * Calculates the z-score (sigma deviation) for a value given a baseline.
 */
export function calculateSigmaDeviation(value: number, mean: number, stdDev: number): number {
  if (stdDev === 0) return value > mean ? Infinity : -Infinity;
  return (value - mean) / stdDev;
}

/**
 * Determines anomaly severity based on sigma deviation and metric type.
 */
export function determineSeverity(sigma: number, isLatencyMetric: boolean = true): AnomalySeverity {
  const absSigma = Math.abs(sigma);
  
  if (absSigma >= 3.0) return 'critical';
  if (absSigma >= 2.0) return 'high';
  if (absSigma >= 1.5) return 'medium';
  return 'low';
}

/**
 * Compares observed metrics against baseline and returns any anomalies.
 */
export function verifyMetrics(
  snapshot: TelemetryMetricSnapshot,
  baselines: Map<string, MetricBaseline>,
  sensitivity: SensitivityLevel = 'medium',
): AnomalyEvent[] {
  const anomalies: AnomalyEvent[] = [];
  const thresholdSigma = SIGMA_THRESHOLDS[sensitivity];

  // Check duration (latency)
  const durationBaseline = baselines.get('durationMs');
  if (durationBaseline) {
    const sigma = calculateSigmaDeviation(snapshot.durationMs, durationBaseline.mean, durationBaseline.stdDev);
    if (Math.abs(sigma) > thresholdSigma) {
      anomalies.push({
        metricName: 'durationMs',
        severity: determineSeverity(sigma, true),
        observedValue: snapshot.durationMs,
        baselineMean: durationBaseline.mean,
        sigmaDeviation: sigma,
        rawSample: `duration=${snapshot.durationMs}ms`,
      });
    }
  }

  // Check CPU usage
  const cpuBaseline = baselines.get('cpuPercent');
  if (cpuBaseline) {
    const sigma = calculateSigmaDeviation(snapshot.cpuPercent, cpuBaseline.mean, cpuBaseline.stdDev);
    if (Math.abs(sigma) > thresholdSigma) {
      anomalies.push({
        metricName: 'cpuPercent',
        severity: determineSeverity(sigma, false),
        observedValue: snapshot.cpuPercent,
        baselineMean: cpuBaseline.mean,
        sigmaDeviation: sigma,
        rawSample: `cpu=${snapshot.cpuPercent}%`,
      });
    }
  }

  // Check memory usage
  const memoryBaseline = baselines.get('memoryBytes');
  if (memoryBaseline) {
    const sigma = calculateSigmaDeviation(snapshot.memoryBytes, memoryBaseline.mean, memoryBaseline.stdDev);
    if (Math.abs(sigma) > thresholdSigma) {
      anomalies.push({
        metricName: 'memoryBytes',
        severity: determineSeverity(sigma, false),
        observedValue: snapshot.memoryBytes,
        baselineMean: memoryBaseline.mean,
        sigmaDeviation: sigma,
        rawSample: `memory=${snapshot.memoryBytes}bytes`,
      });
    }
  }

  // Check error count (any errors are anomalies)
  const errorBaseline = baselines.get('errorCount');
  if (errorBaseline && snapshot.errorCount > 0) {
    const sigma = calculateSigmaDeviation(snapshot.errorCount, errorBaseline.mean, errorBaseline.stdDev);
    if (snapshot.errorCount > thresholdSigma) {
      anomalies.push({
        metricName: 'errorCount',
        severity: snapshot.errorCount > 1 ? 'high' : 'low',
        observedValue: snapshot.errorCount,
        baselineMean: errorBaseline.mean,
        sigmaDeviation: sigma,
        rawSample: `errors=${snapshot.errorCount}`,
      });
    }
  }

  return anomalies;
}

/**
 * Verifies execution results against baselines and log signatures.
 */
export function verifyExecution(
  snapshot: TelemetryMetricSnapshot,
  baselines: Map<string, MetricBaseline>,
  observedLogs: string[],
  baselineLogSignatures: Set<string>,
  sensitivity: SensitivityLevel = 'medium',
): VerificationResult {
  const anomalies = verifyMetrics(snapshot, baselines, sensitivity);

  // Cluster observed logs and check for novel error signatures
  const logClusters = clusterLogLines(observedLogs);
  let hasNovelErrors = false;
  let novelErrorSignatures: string[] = [];

  for (const [signature, samples] of logClusters) {
    if (!baselineLogSignatures.has(signature)) {
      // Check if this is an error signature
      const sample = samples[0];
      if (
        sample.toLowerCase().includes('error') ||
        sample.toLowerCase().includes('fail') ||
        sample.toLowerCase().includes('exception') ||
        sample.toLowerCase().includes('panic') ||
        snapshot.exitCode !== 0
      ) {
        hasNovelErrors = true;
        novelErrorSignatures.push(signature);
        anomalies.push({
          metricName: 'log_signature',
          severity: 'high',
          observedValue: 1,
          baselineMean: 0,
          sigmaDeviation: Infinity,
          clusterSignature: signature,
          rawSample: samples[0].slice(0, 100),
        });
      }
    }
  }

  // Calculate verification score (0.0 - 1.0)
  let score = 1.0;
  if (anomalies.length > 0) {
    // Deduct points based on severity
    const severityWeights: Record<AnomalySeverity, number> = {
      low: 0.05,
      medium: 0.1,
      high: 0.25,
      critical: 0.5,
    };
    for (const anomaly of anomalies) {
      score -= severityWeights[anomaly.severity];
    }
    score = Math.max(0, score);
  }

  // Check if rollback should be triggered
  const rollbackTriggered = hasNovelErrors || anomalies.some(a => a.severity === 'critical');

  return {
    passed: !rollbackTriggered && score >= 0.8,
    score,
    anomalies,
    rollbackTriggered,
    rollbackReason: hasNovelErrors
      ? `novel error signatures detected: ${novelErrorSignatures.join(', ')}`
      : anomalies.length > 0
        ? `${anomalies.length} anomaly(s) exceeded threshold`
        : undefined,
    telemetry: snapshot,
    verifiedAt: new Date(),
  };
}

/**
 * Creates a baseline from historical metrics.
 */
export function createBaseline(metrics: number[]): MetricBaseline {
  if (metrics.length === 0) {
    return {
      metricName: 'unknown',
      mean: 0,
      stdDev: 0,
      sampleCount: 0,
      p95: 0,
    };
  }

  const sorted = [...metrics].sort((a, b) => a - b);
  const sum = metrics.reduce((acc, val) => acc + val, 0);
  const mean = sum / metrics.length;
  const variance = metrics.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / metrics.length;
  const stdDev = Math.sqrt(variance);

  // Calculate p95 (95th percentile)
  const p95Index = Math.floor(metrics.length * 0.95);
  const p95 = sorted[Math.min(p95Index, sorted.length - 1)];

  return {
    metricName: 'metric',
    mean,
    stdDev,
    sampleCount: metrics.length,
    p95,
  };
}
