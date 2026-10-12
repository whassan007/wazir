import type { 
  CanaryRecord, 
  CanaryStage, 
  SelfImprovementDomain,
  CanaryExecutionOutcome 
} from '@wazir/core';

export interface CanaryComparisonResult {
  candidateId: string;
  baselineId: string;
  domain: SelfImprovementDomain;
  stage: CanaryStage;
  sampleWindow: {
    start: Date;
    end: Date;
  };
  correctness: ComparisonMetrics;
  efficiency: ComparisonMetrics;
  telemetry: TelemetryComparison;
  environment: EnvironmentEquivalence;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  isDirectlyComparable: boolean;
  comparisonReason?: string;
}

export interface ComparisonMetrics {
  metricName: string;
  baselineValue: number;
  canaryValue: number;
  delta: number;
  deltaPercent: number;
  provenance: 'OBSERVED' | 'ESTIMATED' | 'UNKNOWN';
}

export interface TelemetryComparison {
  tokens: ComparisonMetrics;
  modelCalls: ComparisonMetrics;
  durationMs: ComparisonMetrics;
  cacheReadRate: ComparisonMetrics;
}

export interface EnvironmentEquivalence {
  isEquivalent: boolean;
  mismatchedAttributes: string[]; // e.g., ["model", "runtime"]
}
