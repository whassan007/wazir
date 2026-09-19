export type AnomalySeverity = 'low' | 'medium' | 'high' | 'critical';

export interface TelemetryMetricSnapshot {
  timestamp: string;
  durationMs: number;
  cpuPercent: number;
  memoryBytes: number;
  errorCount: number;
  exitCode: number;
}

export interface MetricBaseline {
  metricName: string;
  mean: number;
  stdDev: number;
  sampleCount: number;
  p95: number;
}

export interface AnomalyEvent {
  metricName: string;
  severity: AnomalySeverity;
  observedValue: number;
  baselineMean: number;
  sigmaDeviation: number;
  clusterSignature?: string;
  rawSample: string;
}

export interface VerificationResult {
  passed: boolean;
  score: number; // 0.0 - 1.0
  anomalies: AnomalyEvent[];
  rollbackTriggered: boolean;
  rollbackReason?: string;
  telemetry: TelemetryMetricSnapshot;
  verifiedAt: Date;
}
