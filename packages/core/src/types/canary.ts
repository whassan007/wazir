import type { OptimizableConfig, SelfImprovementDomain } from './metaOptimizer.js';

// ======================================================================
// WAZIR MATURITY LEVEL 3 CANARY PROMOTION TYPES
// ======================================================================

export type CanaryStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'EVALUATING'
  | 'HEALTHY'
  | 'STAGED_EXPANSION'
  | 'READY_FOR_PROMOTION'
  | 'ROLLING_BACK'
  | 'ROLLED_BACK'
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

  rollbackReason?: CanaryRollbackReason;
  inconclusiveReasons: string[];
  evidenceIds: string[];

  startTime: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface CanaryAssignmentResult {
  canaryId: string;
  assignedVariant: 'baseline' | 'canary';
  effectiveConfig: OptimizableConfig;
  hashSlot: number;
  allocationFraction: number;
  reason: string;
}

export interface CanaryExecutionOutcome {
  canaryId: string;
  executionId: string;
  taskId?: string;
  variant: 'baseline' | 'canary';
  taskSuccess: boolean;
  verificationSuccess: boolean;
  toolCallsCount: number;
  toolFailuresCount: number;
  repairCyclesCount: number;
  tokensUsed: number;
  wallTimeMs: number;
  costUSD?: number;
  recoveryFailuresCount?: number;
}
