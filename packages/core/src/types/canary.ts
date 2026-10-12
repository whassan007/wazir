import type { OptimizableConfig, SelfImprovementDomain } from './metaOptimizer.js';

// ======================================================================
// WAZIR MATURITY LEVEL 3 CANARY PROMOTION TYPES
// ======================================================================

export type CanaryStage =
  | 'QUALIFIED'
  | 'SHADOW'
  | 'CANARY_1'
  | 'CANARY_5'
  | 'CANARY_10'
  | 'CANARY_25'
  | 'CANARY_50'
  | 'READY_TO_PROMOTE';

export type CanaryStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'EVALUATING'
  | 'HEALTHY'
  | 'STAGED_EXPANSION'
  | 'READY_FOR_PROMOTION'
  | 'ROLLING_BACK'
  | 'ROLLED_BACK'
  | 'CANARY_FAILED'
  | 'PAUSED'
  | 'INCONCLUSIVE';

export interface CanaryRollbackThresholds {
  /** Maximum tolerable task failure rate delta (+0.05 = canary failure rate cannot exceed baseline by >5%) */
  maxTaskFailureRateDelta: number;
  /** Maximum tolerable verification failure rate delta */
  maxVerificationFailureRateDelta: number;
  /** Maximum tolerable tool failure rate delta */
  maxToolFailureRateDelta: number;
  /** Maximum allowable repair cycle inflation factor (e.g. 1.5 = +50% repair cycles) */
  maxRepairCycleInflationFactor: number;
  /** Maximum allowable latency/wall-time inflation factor (e.g. 1.5 = +50% wall time) */
  maxLatencyInflationFactor: number;
  /** Strict zero-tolerance for recovery failure (immediate rollback if count > 0) */
  zeroToleranceRecoveryFailures?: boolean;
}

export interface CanaryPromotionThresholds {
  /** Minimum samples required at each expansion stage before expanding */
  minStageSamples: number;
  /** Total minimum samples required across all stages before candidate can be READY_FOR_PROMOTION */
  minTotalSamples: number;
  /** Required task success rate ratio against baseline (e.g. >= 1.0) */
  minTaskSuccessRateRatio: number;
  /** Required verification success rate ratio against baseline (e.g. >= 1.0) */
  minVerificationSuccessRateRatio: number;
  /** Max acceptable confidence interval uncertainty range */
  maxConfidenceIntervalWidth?: number;
}

export interface CanaryRollbackReason {
  metric: string;
  baselineValue: number;
  canaryValue: number;
  delta: number;
  threshold: number;
  description: string;
  timestamp: Date;
}

export interface CanarySampleMetrics {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  taskSuccessRate: number;

  totalVerifications: number;
  successfulVerifications: number;
  verificationSuccessRate: number;

  toolInvocations: number;
  toolFailures: number;
  toolFailureRate: number;

  repairCycles: number;
  totalTokens: number;
  wallTimeMs: number;
  monetaryCostUSD: number;
  recoveryFailures: number;
}

export interface CanaryRecord {
  canaryId: string;
  candidateId: string;
  candidateConfig: OptimizableConfig;
  baselineConfig: OptimizableConfig;
  domain: SelfImprovementDomain;
  status: CanaryStatus;

  /** Current traffic fraction: 0.0 to 1.0 (e.g. 0.10 = 10%) */
  currentAllocation: number;
  pausedAllocation?: number;
  /** Sequence of staged expansion tiers, e.g. [0.01, 0.05, 0.10, 0.25, 0.50] */
  stagedExpansionTiers: number[];
  currentTierIndex: number;

  eligibleWorkloadFilter?: {
    taskTypes?: string[];
    excludeCritical?: boolean;
    tags?: string[];
  };

  minimumSamples: number;
  promotionThresholds: CanaryPromotionThresholds;
  rollbackThresholds: CanaryRollbackThresholds;

  baselineMetrics: CanarySampleMetrics;
  canaryMetrics: CanarySampleMetrics;

  stage?: CanaryStage;
  rollbackReason?: CanaryRollbackReason;
  inconclusiveReasons: string[];
  evidenceIds: string[];
  executionOutcomes?: CanaryExecutionOutcome[];

  startTime: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface CanaryAssignmentResult {
  canaryId: string;
  assignedVariant: 'baseline' | 'canary' | 'shadow';
  effectiveConfig: OptimizableConfig;
  hashSlot: number;
  allocationFraction: number;
  reason: string;
}

export interface CanaryExecutionOutcome {
  canaryId: string;
  executionId: string;
  taskId?: string;
  variant: 'baseline' | 'canary' | 'shadow';
  taskSuccess: boolean;
  verificationSuccess: boolean;
  toolCallsCount: number;
  toolFailuresCount: number;
  repairCyclesCount: number;
  tokensUsed: number;
  wallTimeMs: number;
  costUSD?: number;
  recoveryFailuresCount?: number;
  modelId?: string;
  runtimeId?: string;
  workerClass?: string;
  taskCategory?: string;
}

export interface ShadowModeResult {
  canaryId: string;
  candidateId: string;
  taskId: string;
  executionId: string;
  productionOutcome: {
    success: boolean;
    verificationSuccess: boolean;
    tokensUsed: number;
    wallTimeMs: number;
  };
  shadowOutcome: {
    success: boolean;
    verificationSuccess: boolean;
    tokensUsed: number;
    wallTimeMs: number;
    candidateOutput?: unknown;
  };
  metricsDelta: {
    tokensDelta: number;
    wallTimeDeltaMs: number;
    verificationAgreed: boolean;
  };
  retained: boolean;
  timestamp: Date;
}

export type CanaryEventType =
  | 'canary.started'
  | 'canary.stage.entered'
  | 'canary.sample.recorded'
  | 'canary.regression.detected'
  | 'canary.rollback.triggered'
  | 'canary.stage.completed'
  | 'canary.ready_to_promote'
  | 'canary.operator.action'
  | 'shadow.started'
  | 'shadow.sample.recorded'
  | 'shadow.completed';

export interface CanaryEvent {
  id: string;
  type: CanaryEventType;
  canaryId: string;
  candidateId: string;
  domain: SelfImprovementDomain;
  stage?: CanaryStage;
  allocation?: number;
  data?: Record<string, unknown>;
  timestamp: Date;
}

export type CanaryEventListener = (event: CanaryEvent) => void;

// ======================================================================
// CANARY STAGE ADVISOR TYPES (Evidence-Aware Precondition Layer)
// ======================================================================

export type CanaryStageDecision =
  | 'READY_TO_ADVANCE'
  | 'HOLD'
  | 'ROLLBACK_RECOMMENDED'
  | 'INSUFFICIENT_EVIDENCE';

export type EvidenceConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface MetricEvidence {
  value?: number;
  baselineValue?: number;
  delta?: number;
  deltaPercent?: number;
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  sampleCount: number;
  variance?: number;
  standardDeviation?: number;
  confidence: EvidenceConfidence;
}

export interface EnvironmentCoverage {
  models: string[];
  runtimes: string[];
  workerClasses: string[];
  taskCategories: string[];
  isDiverse: boolean;
}

export interface CanaryEvidenceProfile {
  canaryId: string;
  candidateId: string;
  domain: SelfImprovementDomain;
  stage: CanaryStage;
  status: CanaryStatus;

  sampleCount: number;
  minimumSamples: number;

  correctnessEvidence: MetricEvidence;
  verificationEvidence: MetricEvidence;
  toolFailureEvidence: MetricEvidence;

  tokenEvidence: MetricEvidence;
  durationEvidence: MetricEvidence;
  modelCallEvidence: MetricEvidence;

  variance: {
    tokenVariance?: number;
    durationVariance?: number;
    correctnessStability?: number;
  };
  confidence: EvidenceConfidence;
  observationWindow: {
    startTime: Date;
    lastSampleTime?: Date;
    durationMs: number;
  };

  environmentCoverage: EnvironmentCoverage;
}

export interface CanaryStageRecommendation {
  canaryId: string;
  candidateId: string;
  currentStage: CanaryStage;
  targetStage?: CanaryStage;

  decision: CanaryStageDecision;
  reasons: string[];
  blockingConditions: string[];
  supportingEvidence: string[];

  confidence: EvidenceConfidence;
  generatedAt: Date;
  profile: CanaryEvidenceProfile;
}
