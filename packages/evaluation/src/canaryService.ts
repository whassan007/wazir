import { createHash, randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import type { MemoryService } from '@wazir/memory';
import type {
  CanaryRecord,
  CanaryStatus,
  CanaryRollbackThresholds,
  CanaryPromotionThresholds,
  CanarySampleMetrics,
  CanaryAssignmentResult,
  CanaryExecutionOutcome,
  CanaryRollbackReason,
  OptimizableConfig,
  SelfImprovementDomain,
} from '@wazir/core';

export const DEFAULT_STAGED_EXPANSION_TIERS = [0.01, 0.05, 0.10, 0.25, 0.50];

export const DEFAULT_CANARY_ROLLBACK_THRESHOLDS: CanaryRollbackThresholds = {
  maxTaskFailureRateDelta: 0.05, // Canary task failure rate cannot exceed baseline by > 5%
  maxVerificationFailureRateDelta: 0.05, // Canary verification failure rate cannot exceed baseline by > 5%
  maxToolFailureRateDelta: 0.10, // Canary tool failure rate cannot exceed baseline by > 10%
  maxRepairCycleInflationFactor: 1.50, // Canary cannot require 50% more repair cycles
  maxLatencyInflationFactor: 1.50, // Canary cannot take 50% longer wall time
  zeroToleranceRecoveryFailures: true, // Immediate rollback on any recovery failure
};

export const DEFAULT_CANARY_PROMOTION_THRESHOLDS: CanaryPromotionThresholds = {
  minStageSamples: 10,
  minTotalSamples: 50,
  minTaskSuccessRateRatio: 1.0, // Canary task success rate >= baseline
  minVerificationSuccessRateRatio: 1.0, // Canary verification success rate >= baseline
  maxConfidenceIntervalWidth: 0.20,
};

export const CANARY_ELIGIBLE_DOMAINS: ReadonlySet<SelfImprovementDomain> = new Set<SelfImprovementDomain>([
  'routing',
  'tool_surfaces',
  'context_policy',
  'prompts',
  'orchestration',
]);

export interface RegisterCanaryParams {
  candidateId: string;
  candidateConfig: OptimizableConfig;
  baselineConfig: OptimizableConfig;
  domain: SelfImprovementDomain;
  qualificationStatus: string;
  initialAllocation?: number;
  stagedExpansionTiers?: number[];
  minimumSamples?: number;
  promotionThresholds?: Partial<CanaryPromotionThresholds>;
  rollbackThresholds?: Partial<CanaryRollbackThresholds>;
  eligibleWorkloadFilter?: {
    taskTypes?: string[];
    excludeCritical?: boolean;
    tags?: string[];
  };
}

export interface CanaryServiceOptions {
  store?: KeyValueStore;
  memoryService?: MemoryService;
}

function emptyMetrics(): CanarySampleMetrics {
  return {
    totalExecutions: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    taskSuccessRate: 1.0,
    totalVerifications: 0,
    successfulVerifications: 0,
    verificationSuccessRate: 1.0,
    toolInvocations: 0,
    toolFailures: 0,
    toolFailureRate: 0.0,
    repairCycles: 0,
    totalTokens: 0,
    wallTimeMs: 0,
    monetaryCostUSD: 0,
    recoveryFailures: 0,
  };
}

export class CanaryDeploymentService {
  private readonly store?: KeyValueStore;
  private readonly memoryService?: MemoryService;
  private readonly deployments = new Map<string, CanaryRecord>();
  private readonly executionAssignments = new Map<string, CanaryAssignmentResult>();

  constructor(options: CanaryServiceOptions = {}) {
    this.store = options.store;
    this.memoryService = options.memoryService;
  }

  /**
   * Deterministic hash calculation (0 to 9999, i.e. 0.00% to 99.99%).
   * Uses task ID if available, otherwise execution ID.
   */
  public static computeHashSlot(seed: string): number {
    const hash = createHash('sha256').update(seed).digest('hex');
    const numeric = parseInt(hash.slice(0, 8), 16);
    return numeric % 10000;
  }

  /**
   * Registers a new Level 3 Canary Deployment.
   * Strict eligibility:
   * 1. Only candidates already marked QUALIFIED may enter canary.
   * 2. Domain must be within permitted Level 3 maturity domains (wazir_source_code is forbidden).
   */
  public async registerCanary(params: RegisterCanaryParams): Promise<CanaryRecord> {
    if (params.qualificationStatus !== 'QUALIFIED') {
      throw new Error(
        `CANARY_ELIGIBILITY_ERROR: Candidate '${params.candidateId}' status is '${params.qualificationStatus}'. Only 'QUALIFIED' candidates may enter Level 3 Canary.`,
      );
    }

    if (!CANARY_ELIGIBLE_DOMAINS.has(params.domain)) {
      throw new Error(
        `CANARY_DOMAIN_RESTRICTION: Domain '${params.domain}' is not eligible for Level 3 Canary deployment. Permitted domains: ${Array.from(CANARY_ELIGIBLE_DOMAINS).join(', ')}.`,
      );
    }

    const tiers = params.stagedExpansionTiers ?? [...DEFAULT_STAGED_EXPANSION_TIERS];
    const initialAllocation = params.initialAllocation !== undefined ? params.initialAllocation : tiers[0];

    const canaryId = `canary-${params.domain}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const canaryRecord: CanaryRecord = {
      canaryId,
      candidateId: params.candidateId,
      candidateConfig: structuredClone(params.candidateConfig),
      baselineConfig: structuredClone(params.baselineConfig),
      domain: params.domain,
      status: 'ACTIVE',
      currentAllocation: initialAllocation,
      stagedExpansionTiers: tiers,
      currentTierIndex: Math.max(0, tiers.indexOf(initialAllocation)),
      eligibleWorkloadFilter: params.eligibleWorkloadFilter,
      minimumSamples: params.minimumSamples ?? DEFAULT_CANARY_PROMOTION_THRESHOLDS.minTotalSamples,
      promotionThresholds: {
        ...DEFAULT_CANARY_PROMOTION_THRESHOLDS,
        ...params.promotionThresholds,
      },
      rollbackThresholds: {
        ...DEFAULT_CANARY_ROLLBACK_THRESHOLDS,
        ...params.rollbackThresholds,
      },
      baselineMetrics: emptyMetrics(),
      canaryMetrics: emptyMetrics(),
      inconclusiveReasons: [],
      evidenceIds: [],
      startTime: new Date(),
      updatedAt: new Date(),
    };

    this.deployments.set(canaryId, canaryRecord);
    if (this.store) {
      await this.store.put(`canary/records/${canaryId}`, canaryRecord);
    }

    return canaryRecord;
  }

  public getDeployment(canaryId: string): CanaryRecord | undefined {
    return this.deployments.get(canaryId);
  }

  public getActiveDeploymentForDomain(domain: SelfImprovementDomain): CanaryRecord | undefined {
    for (const record of this.deployments.values()) {
      if (
        record.domain === domain &&
        (record.status === 'ACTIVE' ||
          record.status === 'EVALUATING' ||
          record.status === 'HEALTHY' ||
          record.status === 'STAGED_EXPANSION')
      ) {
        return record;
      }
    }
    return undefined;
  }

  public listDeployments(): CanaryRecord[] {
    return Array.from(this.deployments.values());
  }

  /**
   * Deterministically assigns an execution to baseline or canary.
   * Uses task ID if present so subtasks or retries in the same execution episode receive the same assignment.
   */
  public assignExecution(params: {
    canaryId: string;
    executionId: string;
    taskId?: string;
    isCritical?: boolean;
    taskType?: string;
  }): CanaryAssignmentResult {
    const record = this.deployments.get(params.canaryId);
    if (!record) {
      throw new Error(`Canary deployment '${params.canaryId}' not found.`);
    }

    // Check if execution was already assigned (idempotent / consistent across retries)
    const existing = this.executionAssignments.get(params.executionId);
    if (existing && existing.canaryId === params.canaryId) {
      return existing;
    }

    // If canary is no longer active, route strictly to baseline
    const isActive =
      record.status === 'ACTIVE' ||
      record.status === 'EVALUATING' ||
      record.status === 'HEALTHY' ||
      record.status === 'STAGED_EXPANSION';

    if (!isActive) {
      const fallbackResult: CanaryAssignmentResult = {
        canaryId: params.canaryId,
        assignedVariant: 'baseline',
        effectiveConfig: record.baselineConfig,
        hashSlot: 0,
        allocationFraction: 0,
        reason: `Canary status is '${record.status}'. Traffic routed strictly to baseline.`,
      };
      this.executionAssignments.set(params.executionId, fallbackResult);
      return fallbackResult;
    }

    // Workload filter check: do not assign critical workloads or excluded task types to canary
    if (params.isCritical || (record.eligibleWorkloadFilter?.excludeCritical && params.isCritical)) {
      const baselineResult: CanaryAssignmentResult = {
        canaryId: params.canaryId,
        assignedVariant: 'baseline',
        effectiveConfig: record.baselineConfig,
        hashSlot: 0,
        allocationFraction: record.currentAllocation,
        reason: 'Workload is marked critical; routed strictly to verified baseline.',
      };
      this.executionAssignments.set(params.executionId, baselineResult);
      return baselineResult;
    }

    if (
      record.eligibleWorkloadFilter?.taskTypes &&
      params.taskType &&
      !record.eligibleWorkloadFilter.taskTypes.includes(params.taskType)
    ) {
      const baselineResult: CanaryAssignmentResult = {
        canaryId: params.canaryId,
        assignedVariant: 'baseline',
        effectiveConfig: record.baselineConfig,
        hashSlot: 0,
        allocationFraction: record.currentAllocation,
        reason: `Task type '${params.taskType}' not in eligible filter list.`,
      };
      this.executionAssignments.set(params.executionId, baselineResult);
      return baselineResult;
    }

    // Deterministic hash slot
    const seed = params.taskId ?? params.executionId;
    const slot = CanaryDeploymentService.computeHashSlot(seed);
    const thresholdSlot = Math.floor(record.currentAllocation * 10000);

    const assignedVariant: 'baseline' | 'canary' = slot < thresholdSlot ? 'canary' : 'baseline';
    const effectiveConfig = assignedVariant === 'canary' ? record.candidateConfig : record.baselineConfig;

    const assignment: CanaryAssignmentResult = {
      canaryId: params.canaryId,
      assignedVariant,
      effectiveConfig,
      hashSlot: slot,
      allocationFraction: record.currentAllocation,
      reason: `Slot ${slot} ${assignedVariant === 'canary' ? '<' : '>='} threshold ${thresholdSlot} (allocation: ${(record.currentAllocation * 100).toFixed(1)}%).`,
    };

    this.executionAssignments.set(params.executionId, assignment);
    return assignment;
  }

  /**
   * Records execution outcome and updates comparative online metrics.
   * Checks hard rollback criteria after each canary observation.
   */
  public async recordExecutionOutcome(outcome: CanaryExecutionOutcome): Promise<{
    canaryRecord: CanaryRecord;
    rolledBack: boolean;
    rollbackReason?: CanaryRollbackReason;
  }> {
    const record = this.deployments.get(outcome.canaryId);
    if (!record) {
      throw new Error(`Canary deployment '${outcome.canaryId}' not found.`);
    }

    // Update metrics
    const metrics = outcome.variant === 'canary' ? record.canaryMetrics : record.baselineMetrics;
    metrics.totalExecutions += 1;
    if (outcome.taskSuccess) {
      metrics.successfulExecutions += 1;
    } else {
      metrics.failedExecutions += 1;
    }
    metrics.taskSuccessRate =
      metrics.totalExecutions > 0 ? metrics.successfulExecutions / metrics.totalExecutions : 1.0;

    metrics.totalVerifications += 1;
    if (outcome.verificationSuccess) {
      metrics.successfulVerifications += 1;
    }
    metrics.verificationSuccessRate =
      metrics.totalVerifications > 0 ? metrics.successfulVerifications / metrics.totalVerifications : 1.0;

    metrics.toolInvocations += outcome.toolCallsCount;
    metrics.toolFailures += outcome.toolFailuresCount;
    metrics.toolFailureRate =
      metrics.toolInvocations > 0 ? metrics.toolFailures / metrics.toolInvocations : 0.0;

    metrics.repairCycles += outcome.repairCyclesCount;
    metrics.totalTokens += outcome.tokensUsed;
    metrics.wallTimeMs += outcome.wallTimeMs;
    metrics.monetaryCostUSD += outcome.costUSD ?? 0;
    metrics.recoveryFailures += outcome.recoveryFailuresCount ?? 0;

    record.updatedAt = new Date();

    // Check for hard regressions if canary has at least 1 observation
    const regressionCheck = this.evaluateRegression(record);
    if (regressionCheck.hasRegressed && regressionCheck.reason) {
      await this.triggerRollback(record.canaryId, regressionCheck.reason);
      return {
        canaryRecord: record,
        rolledBack: true,
        rollbackReason: regressionCheck.reason,
      };
    }

    // If still healthy and active, evaluate staged progression
    this.evaluateStagedProgress(record);

    if (this.store) {
      await this.store.put(`canary/records/${record.canaryId}`, record);
    }

    return {
      canaryRecord: record,
      rolledBack: false,
    };
  }

  /**
   * Online Regression Check:
   * Compares task success, verification success, tool failure, repair cycles, latency, and recovery failures.
   * Dominance rule: Correctness/protected metrics dominate efficiency.
   */
  public evaluateRegression(record: CanaryRecord): {
    hasRegressed: boolean;
    reason?: CanaryRollbackReason;
  } {
    const { canaryMetrics: c, baselineMetrics: b, rollbackThresholds: t } = record;

    // Must have at least 1 canary sample to detect regression
    if (c.totalExecutions === 0) {
      return { hasRegressed: false };
    }

    // 1. Zero tolerance for recovery failures
    if (t.zeroToleranceRecoveryFailures && c.recoveryFailures > 0) {
      return {
        hasRegressed: true,
        reason: {
          metric: 'recovery_failures',
          baselineValue: b.recoveryFailures,
          canaryValue: c.recoveryFailures,
          delta: c.recoveryFailures - b.recoveryFailures,
          threshold: 0,
          description: `Zero-tolerance recovery failure detected: Canary recorded ${c.recoveryFailures} recovery failure(s).`,
          timestamp: new Date(),
        },
      };
    }

    // 2. Task Failure Rate Delta (Correctness gate)
    const baselineTaskFailRate = b.totalExecutions > 0 ? b.failedExecutions / b.totalExecutions : 0.0;
    const canaryTaskFailRate = c.failedExecutions / c.totalExecutions;
    const taskFailDelta = canaryTaskFailRate - baselineTaskFailRate;

    if (taskFailDelta > t.maxTaskFailureRateDelta) {
      return {
        hasRegressed: true,
        reason: {
          metric: 'task_failure_rate',
          baselineValue: baselineTaskFailRate,
          canaryValue: canaryTaskFailRate,
          delta: taskFailDelta,
          threshold: t.maxTaskFailureRateDelta,
          description: `Task failure rate regressed by ${(taskFailDelta * 100).toFixed(1)}% (threshold: ${(t.maxTaskFailureRateDelta * 100).toFixed(1)}%).`,
          timestamp: new Date(),
        },
      };
    }

    // 3. Verification Failure Rate Delta (Physical verification gate)
    const baselineVerifFailRate = b.totalVerifications > 0 ? 1.0 - b.verificationSuccessRate : 0.0;
    const canaryVerifFailRate = 1.0 - c.verificationSuccessRate;
    const verifFailDelta = canaryVerifFailRate - baselineVerifFailRate;

    if (verifFailDelta > t.maxVerificationFailureRateDelta) {
      return {
        hasRegressed: true,
        reason: {
          metric: 'verification_failure_rate',
          baselineValue: baselineVerifFailRate,
          canaryValue: canaryVerifFailRate,
          delta: verifFailDelta,
          threshold: t.maxVerificationFailureRateDelta,
          description: `Verification failure rate regressed by ${(verifFailDelta * 100).toFixed(1)}% (threshold: ${(t.maxVerificationFailureRateDelta * 100).toFixed(1)}%).`,
          timestamp: new Date(),
        },
      };
    }

    // 4. Tool Failure Rate Delta
    const baselineToolFailRate = b.toolInvocations > 0 ? b.toolFailures / b.toolInvocations : 0.0;
    const canaryToolFailRate = c.toolInvocations > 0 ? c.toolFailures / c.toolInvocations : 0.0;
    const toolFailDelta = canaryToolFailRate - baselineToolFailRate;

    if (c.toolInvocations >= 5 && toolFailDelta > t.maxToolFailureRateDelta) {
      return {
        hasRegressed: true,
        reason: {
          metric: 'tool_failure_rate',
          baselineValue: baselineToolFailRate,
          canaryValue: canaryToolFailRate,
          delta: toolFailDelta,
          threshold: t.maxToolFailureRateDelta,
          description: `Tool failure rate regressed by ${(toolFailDelta * 100).toFixed(1)}% (threshold: ${(t.maxToolFailureRateDelta * 100).toFixed(1)}%).`,
          timestamp: new Date(),
        },
      };
    }

    // 5. Repair Cycle Inflation
    if (b.totalExecutions >= 3 && c.totalExecutions >= 3) {
      const avgBaselineRepair = b.repairCycles / b.totalExecutions;
      const avgCanaryRepair = c.repairCycles / c.totalExecutions;
      if (avgBaselineRepair > 0 && avgCanaryRepair / avgBaselineRepair > t.maxRepairCycleInflationFactor) {
        return {
          hasRegressed: true,
          reason: {
            metric: 'repair_cycles',
            baselineValue: avgBaselineRepair,
            canaryValue: avgCanaryRepair,
            delta: avgCanaryRepair - avgBaselineRepair,
            threshold: t.maxRepairCycleInflationFactor,
            description: `Average repair cycles inflated to ${(avgCanaryRepair / avgBaselineRepair).toFixed(2)}x baseline.`,
            timestamp: new Date(),
          },
        };
      }
    }

    // 6. Wall Time / Latency Inflation
    if (b.totalExecutions >= 3 && c.totalExecutions >= 3) {
      const avgBaselineTime = b.wallTimeMs / b.totalExecutions;
      const avgCanaryTime = c.wallTimeMs / c.totalExecutions;
      if (avgBaselineTime > 0 && avgCanaryTime / avgBaselineTime > t.maxLatencyInflationFactor) {
        return {
          hasRegressed: true,
          reason: {
            metric: 'wall_time_ms',
            baselineValue: avgBaselineTime,
            canaryValue: avgCanaryTime,
            delta: avgCanaryTime - avgBaselineTime,
            threshold: t.maxLatencyInflationFactor,
            description: `Average execution latency inflated to ${(avgCanaryTime / avgBaselineTime).toFixed(2)}x baseline.`,
            timestamp: new Date(),
          },
        };
      }
    }

    return { hasRegressed: false };
  }

  /**
   * Evaluates progressive expansion and promotion readiness.
   * Never jumps automatically from tiny sample to 100%.
   */
  public evaluateStagedProgress(record: CanaryRecord): void {
    if (record.status !== 'ACTIVE' && record.status !== 'EVALUATING' && record.status !== 'HEALTHY') {
      return;
    }

    const { canaryMetrics: c, baselineMetrics: b, promotionThresholds: p } = record;

    const stageSamples = c.totalExecutions;

    // If minimum total samples reached and verification/task rates meet criteria
    if (c.totalExecutions >= p.minTotalSamples) {
      const taskSuccessRatio = b.taskSuccessRate > 0 ? c.taskSuccessRate / b.taskSuccessRate : 1.0;
      const verifSuccessRatio =
        b.verificationSuccessRate > 0 ? c.verificationSuccessRate / b.verificationSuccessRate : 1.0;

      if (taskSuccessRatio >= p.minTaskSuccessRateRatio && verifSuccessRatio >= p.minVerificationSuccessRateRatio) {
        record.status = 'READY_FOR_PROMOTION';
        return;
      }
    }

    // Check progressive stage expansion
    const requiredStageSamples = p.minStageSamples * (record.currentTierIndex + 1);
    if (stageSamples >= requiredStageSamples && record.currentTierIndex < record.stagedExpansionTiers.length - 1) {
      record.currentTierIndex += 1;
      record.currentAllocation = record.stagedExpansionTiers[record.currentTierIndex];
      record.status = 'STAGED_EXPANSION';
    } else if (stageSamples >= p.minStageSamples) {
      record.status = 'HEALTHY';
    } else {
      record.status = 'EVALUATING';
    }
  }

  /**
   * Concludes canary evaluation when sample size is insufficient or confidence is low.
   * Returns INCONCLUSIVE rather than promoting.
   */
  public concludeEvaluation(canaryId: string): CanaryStatus {
    const record = this.deployments.get(canaryId);
    if (!record) {
      throw new Error(`Canary deployment '${canaryId}' not found.`);
    }

    if (record.status === 'ROLLED_BACK' || record.status === 'READY_FOR_PROMOTION') {
      return record.status;
    }

    // Check if minimum total samples were satisfied
    if (record.canaryMetrics.totalExecutions < record.minimumSamples) {
      record.status = 'INCONCLUSIVE';
      record.inconclusiveReasons.push(
        `INSUFFICIENT_SAMPLES: Canary observed ${record.canaryMetrics.totalExecutions} executions (minimum required: ${record.minimumSamples}). Promotion denied.`,
      );
      record.completedAt = new Date();
      return 'INCONCLUSIVE';
    }

    return record.status;
  }

  /**
   * Triggers immediate automatic rollback:
   * 1. Stops new canary assignments (allocation -> 0).
   * 2. Restores baseline routing.
   * 3. Sets status to ROLLED_BACK.
   * 4. Preserves evidence and records rollback reason.
   * 5. Records failure in MemoryService so learning occurs.
   */
  public async triggerRollback(canaryId: string, reason: CanaryRollbackReason): Promise<CanaryRecord> {
    const record = this.deployments.get(canaryId);
    if (!record) {
      throw new Error(`Canary deployment '${canaryId}' not found.`);
    }

    record.status = 'ROLLED_BACK';
    record.currentAllocation = 0.0;
    record.rollbackReason = reason;
    record.completedAt = new Date();
    record.updatedAt = new Date();

    // Record failure in MemoryService
    if (this.memoryService) {
      try {
        this.memoryService.recordEpisode({
          repositoryScope: 'canary-promotion',
          taskType: `canary-${record.domain}`,
          taskPrompt: `Canary evaluation for candidate ${record.candidateId}`,
          executionId: canaryId,
          attemptOutcome: 'failure',
          failurePattern: `CANARY_REGRESSION_${reason.metric.toUpperCase()}`,
          repairStrategy: 'AUTOMATIC_ROLLBACK_TO_BASELINE',
          filesInvolved: [],
          workspaceRevision: 0,
          metadata: {
            canaryId: record.canaryId,
            candidateId: record.candidateId,
            domain: record.domain,
            reason: reason.description,
            metric: reason.metric,
            baselineValue: reason.baselineValue,
            canaryValue: reason.canaryValue,
            delta: reason.delta,
          },
        });
      } catch {
        // MemoryService failure should not abort rollback
      }
    }

    if (this.store) {
      await this.store.put(`canary/records/${canaryId}`, record);
    }

    return record;
  }
}
