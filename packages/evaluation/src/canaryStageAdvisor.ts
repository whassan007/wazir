import type {
  CanaryRecord,
  CanaryExecutionOutcome,
  CanaryEvidenceProfile,
  CanaryStageRecommendation,
  CanaryStageDecision,
  MetricEvidence,
  EnvironmentCoverage,
  EvidenceConfidence,
  CanaryStage,
} from '@wazir/core';

export interface CanaryStageAdvisorOptions {
  /** Maximum tolerable token variance before holding advancement (default: 0.75 relative variance) */
  maxTokenRelativeVariance?: number;
  /** Maximum tolerable latency variance before holding advancement (default: 0.75 relative variance) */
  maxDurationRelativeVariance?: number;
  /** Minimum diverse task categories required when canary has broad filter (default: 2) */
  minDiverseTaskCategories?: number;
}

export class CanaryStageAdvisor {
  private readonly options: Required<CanaryStageAdvisorOptions>;

  constructor(options: CanaryStageAdvisorOptions = {}) {
    this.options = {
      maxTokenRelativeVariance: options.maxTokenRelativeVariance ?? 0.75,
      maxDurationRelativeVariance: options.maxDurationRelativeVariance ?? 0.75,
      minDiverseTaskCategories: options.minDiverseTaskCategories ?? 2,
    };
  }

  /**
   * Constructs a structured CanaryEvidenceProfile from authoritative CanaryRecord
   * and optional raw sample outcomes.
   */
  public buildEvidenceProfile(
    record: CanaryRecord,
    samples?: CanaryExecutionOutcome[],
  ): CanaryEvidenceProfile {
    const canarySamples = (samples ?? record.executionOutcomes ?? []).filter(
      (s) => s.variant === 'canary',
    );
    const baselineSamples = (samples ?? record.executionOutcomes ?? []).filter(
      (s) => s.variant === 'baseline',
    );

    const cMetrics = record.canaryMetrics;
    const bMetrics = record.baselineMetrics;
    const sampleCount = cMetrics.totalExecutions;
    const minimumSamples = record.promotionThresholds?.minStageSamples ?? record.minimumSamples ?? 10;

    // 1. Correctness Evidence (Task Success Rate)
    const correctnessEvidence = this.computeMetricEvidence({
      canaryValue: sampleCount > 0 ? cMetrics.taskSuccessRate : undefined,
      baselineValue: bMetrics.totalExecutions > 0 ? bMetrics.taskSuccessRate : undefined,
      sampleCount,
      toleranceDelta: record.rollbackThresholds?.maxTaskFailureRateDelta ?? 0.05,
      higherIsBetter: true,
      samples: canarySamples.map((s) => (s.taskSuccess ? 1 : 0)),
    });

    // 2. Verification Evidence (Verification Success Rate)
    const verificationEvidence = this.computeMetricEvidence({
      canaryValue: cMetrics.totalVerifications > 0 ? cMetrics.verificationSuccessRate : undefined,
      baselineValue: bMetrics.totalVerifications > 0 ? bMetrics.verificationSuccessRate : undefined,
      sampleCount: cMetrics.totalVerifications,
      toleranceDelta: record.rollbackThresholds?.maxVerificationFailureRateDelta ?? 0.05,
      higherIsBetter: true,
      samples: canarySamples.map((s) => (s.verificationSuccess ? 1 : 0)),
    });

    // 3. Tool Failure Evidence
    const toolFailureEvidence = this.computeMetricEvidence({
      canaryValue: cMetrics.toolInvocations > 0 ? cMetrics.toolFailureRate : undefined,
      baselineValue: bMetrics.toolInvocations > 0 ? bMetrics.toolFailureRate : undefined,
      sampleCount: cMetrics.toolInvocations,
      toleranceDelta: record.rollbackThresholds?.maxToolFailureRateDelta ?? 0.10,
      higherIsBetter: false,
      samples: canarySamples.map((s) => (s.toolCallsCount > 0 ? s.toolFailuresCount / s.toolCallsCount : 0)),
    });

    // 4. Token Evidence
    const avgCanaryTokens = sampleCount > 0 ? cMetrics.totalTokens / sampleCount : undefined;
    const avgBaselineTokens = bMetrics.totalExecutions > 0 ? bMetrics.totalTokens / bMetrics.totalExecutions : undefined;
    const tokenSamples = canarySamples.map((s) => s.tokensUsed).filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
    const tokenEvidence = this.computeMetricEvidence({
      canaryValue: avgCanaryTokens,
      baselineValue: avgBaselineTokens,
      sampleCount,
      toleranceDelta: 0.50, // 50% inflation allowed before failure
      higherIsBetter: false,
      samples: tokenSamples,
    });

    // 5. Duration Evidence
    const avgCanaryDuration = sampleCount > 0 ? cMetrics.wallTimeMs / sampleCount : undefined;
    const avgBaselineDuration = bMetrics.totalExecutions > 0 ? bMetrics.wallTimeMs / bMetrics.totalExecutions : undefined;
    const durationSamples = canarySamples.map((s) => s.wallTimeMs).filter((d): d is number => typeof d === 'number' && Number.isFinite(d));
    const durationEvidence = this.computeMetricEvidence({
      canaryValue: avgCanaryDuration,
      baselineValue: avgBaselineDuration,
      sampleCount,
      toleranceDelta: record.rollbackThresholds?.maxLatencyInflationFactor ? (record.rollbackThresholds.maxLatencyInflationFactor - 1.0) : 0.50,
      higherIsBetter: false,
      samples: durationSamples,
    });

    // 6. Model Call / Tool Invocations Evidence
    const avgCanaryToolCalls = sampleCount > 0 ? cMetrics.toolInvocations / sampleCount : undefined;
    const avgBaselineToolCalls = bMetrics.totalExecutions > 0 ? bMetrics.toolInvocations / bMetrics.totalExecutions : undefined;
    const modelCallEvidence = this.computeMetricEvidence({
      canaryValue: avgCanaryToolCalls,
      baselineValue: avgBaselineToolCalls,
      sampleCount,
      toleranceDelta: 1.0,
      higherIsBetter: false,
      samples: canarySamples.map((s) => s.toolCallsCount),
    });

    // Variances & Stability
    const tokenVariance = tokenEvidence.variance;
    const durationVariance = durationEvidence.variance;
    const correctnessStability = correctnessEvidence.standardDeviation !== undefined
      ? 1.0 - Math.min(1.0, correctnessEvidence.standardDeviation)
      : undefined;

    // Environment Coverage
    const models = Array.from(new Set(canarySamples.map((s) => s.modelId).filter((m): m is string => Boolean(m))));
    const runtimes = Array.from(new Set(canarySamples.map((s) => s.runtimeId).filter((r): r is string => Boolean(r))));
    const workerClasses = Array.from(new Set(canarySamples.map((s) => s.workerClass).filter((w): w is string => Boolean(w))));
    const taskCategories = Array.from(new Set(canarySamples.map((s) => s.taskCategory).filter((t): t is string => Boolean(t))));

    // Determine diversity: diverse if sample count is substantial or spans multiple categories
    const isDiverse = taskCategories.length >= this.options.minDiverseTaskCategories || (taskCategories.length === 0 && sampleCount >= minimumSamples);

    const environmentCoverage: EnvironmentCoverage = {
      models,
      runtimes,
      workerClasses,
      taskCategories,
      isDiverse,
    };

    // Overall Confidence
    let confidence: EvidenceConfidence = 'unknown';
    if (sampleCount === 0 || correctnessEvidence.status === 'UNKNOWN') {
      confidence = 'unknown';
    } else if (sampleCount < minimumSamples) {
      confidence = 'low';
    } else if (isDiverse && (tokenEvidence.confidence === 'high' || tokenEvidence.confidence === 'medium')) {
      confidence = 'high';
    } else {
      confidence = 'medium';
    }

    const lastSampleTime = canarySamples.length > 0 ? record.updatedAt : undefined;
    const durationMs = lastSampleTime ? Math.max(0, lastSampleTime.getTime() - record.startTime.getTime()) : 0;

    return {
      canaryId: record.canaryId,
      candidateId: record.candidateId,
      domain: record.domain,
      stage: record.stage ?? 'CANARY_10',
      status: record.status,
      sampleCount,
      minimumSamples,
      correctnessEvidence,
      verificationEvidence,
      toolFailureEvidence,
      tokenEvidence,
      durationEvidence,
      modelCallEvidence,
      variance: {
        tokenVariance,
        durationVariance,
        correctnessStability,
      },
      confidence,
      observationWindow: {
        startTime: record.startTime,
        lastSampleTime,
        durationMs,
      },
      environmentCoverage,
    };
  }

  /**
   * Evaluates evidence profile or canary record and returns actionable recommendation.
   * ADVISOR != CONTROLLER: does not mutate state.
   */
  public evaluate(profileOrRecord: CanaryEvidenceProfile | CanaryRecord): CanaryStageRecommendation {
    const profile = 'correctnessEvidence' in profileOrRecord
      ? profileOrRecord
      : this.buildEvidenceProfile(profileOrRecord);

    const reasons: string[] = [];
    const blockingConditions: string[] = [];
    const supportingEvidence: string[] = [];

    const stages: CanaryStage[] = ['CANARY_1', 'CANARY_5', 'CANARY_10', 'CANARY_25', 'CANARY_50', 'READY_TO_PROMOTE'];
    const currentIdx = stages.indexOf(profile.stage);
    const targetStage = currentIdx >= 0 && currentIdx < stages.length - 1 ? stages[currentIdx + 1] : undefined;

    // RULE 1: INACTIVE OR TERMINAL CANARIES
    if (['ROLLED_BACK', 'CANARY_FAILED'].includes(profile.status)) {
      blockingConditions.push(`Canary status is terminal '${profile.status}'`);
      reasons.push(`Canary has already been terminated (${profile.status}).`);
      return {
        canaryId: profile.canaryId,
        candidateId: profile.candidateId,
        currentStage: profile.stage,
        targetStage,
        decision: 'ROLLBACK_RECOMMENDED',
        reasons,
        blockingConditions,
        supportingEvidence,
        confidence: 'high',
        generatedAt: new Date(),
        profile,
      };
    }

    if (profile.status === 'PAUSED') {
      blockingConditions.push('Canary is currently PAUSED');
      reasons.push('Canary must be resumed before stage advancement can be considered.');
      return {
        canaryId: profile.canaryId,
        candidateId: profile.candidateId,
        currentStage: profile.stage,
        targetStage,
        decision: 'HOLD',
        reasons,
        blockingConditions,
        supportingEvidence,
        confidence: profile.confidence,
        generatedAt: new Date(),
        profile,
      };
    }

    if (profile.stage === 'READY_TO_PROMOTE' || currentIdx === stages.length - 1) {
      reasons.push('Canary has reached final expansion stage (READY_TO_PROMOTE).');
      return {
        canaryId: profile.canaryId,
        candidateId: profile.candidateId,
        currentStage: profile.stage,
        targetStage: undefined,
        decision: 'HOLD',
        reasons,
        blockingConditions: ['Canary is already at terminal stage READY_TO_PROMOTE'],
        supportingEvidence,
        confidence: 'high',
        generatedAt: new Date(),
        profile,
      };
    }

    // RULE 2: CORRECTNESS DOMINANCE (Protected Regression -> Immediate Rollback Recommendation)
    // Efficiency gains (tokens/speed) must NEVER compensate for degraded correctness.
    const isVerificationDegraded = profile.verificationEvidence.status === 'FAIL';
    const isTaskCorrectnessDegraded = profile.correctnessEvidence.status === 'FAIL';

    if (isVerificationDegraded || isTaskCorrectnessDegraded) {
      if (isVerificationDegraded) {
        const deltaStr = profile.verificationEvidence.deltaPercent !== undefined
          ? `${profile.verificationEvidence.deltaPercent.toFixed(1)}%`
          : 'below tolerance';
        blockingConditions.push(`Verification success rate regressed (${deltaStr})`);
        reasons.push(`Physical verification checks regressed relative to baseline.`);
      }
      if (isTaskCorrectnessDegraded) {
        const deltaStr = profile.correctnessEvidence.deltaPercent !== undefined
          ? `${profile.correctnessEvidence.deltaPercent.toFixed(1)}%`
          : 'below tolerance';
        blockingConditions.push(`Task success rate regressed (${deltaStr})`);
        reasons.push(`Task success rate degraded relative to baseline.`);
      }

      // Check if efficiency was improved to explicitly highlight correctness dominance
      if (profile.tokenEvidence.deltaPercent && profile.tokenEvidence.deltaPercent < 0) {
        reasons.push(`Efficiency win (${profile.tokenEvidence.deltaPercent.toFixed(1)}% tokens) does NOT compensate for correctness regression.`);
      }

      return {
        canaryId: profile.canaryId,
        candidateId: profile.candidateId,
        currentStage: profile.stage,
        targetStage,
        decision: 'ROLLBACK_RECOMMENDED',
        reasons,
        blockingConditions,
        supportingEvidence,
        confidence: 'high',
        generatedAt: new Date(),
        profile,
      };
    }

    // RULE 3: UNKNOWN DATA HANDLING
    // UNKNOWN != ZERO. Missing critical metrics cannot fabricate stability.
    if (profile.correctnessEvidence.status === 'UNKNOWN' || profile.verificationEvidence.status === 'UNKNOWN') {
      blockingConditions.push('Correctness or verification evidence is UNKNOWN');
      reasons.push('Critical correctness metrics are unobserved or missing from provider telemetry.');
      return {
        canaryId: profile.canaryId,
        candidateId: profile.candidateId,
        currentStage: profile.stage,
        targetStage,
        decision: 'INSUFFICIENT_EVIDENCE',
        reasons,
        blockingConditions,
        supportingEvidence,
        confidence: 'unknown',
        generatedAt: new Date(),
        profile,
      };
    }

    // RULE 4: SAMPLE SUFFICIENCY
    if (profile.sampleCount < profile.minimumSamples) {
      const needed = profile.minimumSamples - profile.sampleCount;
      blockingConditions.push(`Insufficient samples: ${profile.sampleCount}/${profile.minimumSamples} (needs ${needed} more)`);
      reasons.push(`Candidate has not reached the required minimum of ${profile.minimumSamples} stage samples.`);
      return {
        canaryId: profile.canaryId,
        candidateId: profile.candidateId,
        currentStage: profile.stage,
        targetStage,
        decision: 'INSUFFICIENT_EVIDENCE',
        reasons,
        blockingConditions,
        supportingEvidence,
        confidence: 'low',
        generatedAt: new Date(),
        profile,
      };
    }

    // RULE 5: VARIANCE & STABILITY CHECKS
    // Nominal sample count reached, but check whether metrics exhibit excessive variance or flakiness
    const tokenRelVar = (profile.tokenEvidence.value && profile.tokenEvidence.standardDeviation)
      ? profile.tokenEvidence.standardDeviation / profile.tokenEvidence.value
      : 0;

    const durationRelVar = (profile.durationEvidence.value && profile.durationEvidence.standardDeviation)
      ? profile.durationEvidence.standardDeviation / profile.durationEvidence.value
      : 0;

    if (tokenRelVar > this.options.maxTokenRelativeVariance) {
      blockingConditions.push(`High token consumption variance (relative σ: ${tokenRelVar.toFixed(2)} > ${this.options.maxTokenRelativeVariance})`);
      reasons.push(`Token consumption is erratic across observed workloads.`);
    }

    if (durationRelVar > this.options.maxDurationRelativeVariance) {
      blockingConditions.push(`High execution duration variance (relative σ: ${durationRelVar.toFixed(2)} > ${this.options.maxDurationRelativeVariance})`);
      reasons.push(`Execution duration shows unpredictable tail latency.`);
    }

    // RULE 6: ENVIRONMENT & TASK DIVERSITY
    if (!profile.environmentCoverage.isDiverse && profile.environmentCoverage.taskCategories.length === 1 && profile.sampleCount >= 20) {
      blockingConditions.push(`Homogeneous workload coverage: only 1 task category '${profile.environmentCoverage.taskCategories[0]}' observed`);
      reasons.push('Candidate needs broader task diversity before traffic expansion can be verified.');
    }

    if (blockingConditions.length > 0) {
      return {
        canaryId: profile.canaryId,
        candidateId: profile.candidateId,
        currentStage: profile.stage,
        targetStage,
        decision: 'HOLD',
        reasons,
        blockingConditions,
        supportingEvidence,
        confidence: profile.confidence === 'high' ? 'medium' : profile.confidence,
        generatedAt: new Date(),
        profile,
      };
    }

    // RULE 7: HEALTHY CANDIDATE READY TO ADVANCE
    supportingEvidence.push(`Adequate samples: ${profile.sampleCount}/${profile.minimumSamples}`);
    supportingEvidence.push(`Verification pass rate intact (${( (profile.verificationEvidence.value ?? 1.0) * 100 ).toFixed(1)}%)`);
    supportingEvidence.push(`Task correctness dominant (${( (profile.correctnessEvidence.value ?? 1.0) * 100 ).toFixed(1)}%)`);

    if (profile.tokenEvidence.deltaPercent && profile.tokenEvidence.deltaPercent < 0) {
      supportingEvidence.push(`Token efficiency improvement: ${profile.tokenEvidence.deltaPercent.toFixed(1)}%`);
    }

    if (profile.durationEvidence.deltaPercent && profile.durationEvidence.deltaPercent < 0) {
      supportingEvidence.push(`Latency improvement: ${profile.durationEvidence.deltaPercent.toFixed(1)}%`);
    }

    reasons.push(`All protected correctness and physical verification invariants satisfied with stable variance.`);
    reasons.push(`Representative sample threshold achieved for ${profile.stage} stage.`);

    return {
      canaryId: profile.canaryId,
      candidateId: profile.candidateId,
      currentStage: profile.stage,
      targetStage,
      decision: 'READY_TO_ADVANCE',
      reasons,
      blockingConditions: [],
      supportingEvidence,
      confidence: 'high',
      generatedAt: new Date(),
      profile,
    };
  }

  /**
   * Produces an explainable, controller-grounded non-prose explanation.
   */
  public explainRecommendation(recommendation: CanaryStageRecommendation): string[] {
    const lines: string[] = [];
    lines.push(`DECISION: ${recommendation.decision}`);
    lines.push(`CANARY:   ${recommendation.canaryId} (${recommendation.candidateId})`);
    lines.push(`STAGE:    ${recommendation.currentStage} -> ${recommendation.targetStage ?? 'NONE'}`);
    lines.push(`CONF:     ${recommendation.confidence.toUpperCase()}`);
    lines.push('────────────────────────────────────────');

    if (recommendation.blockingConditions.length > 0) {
      lines.push('BLOCKING CONDITIONS:');
      for (const b of recommendation.blockingConditions) {
        lines.push(`  × ${b}`);
      }
    }

    if (recommendation.supportingEvidence.length > 0) {
      lines.push('SUPPORTING EVIDENCE:');
      for (const s of recommendation.supportingEvidence) {
        lines.push(`  ✓ ${s}`);
      }
    }

    if (recommendation.reasons.length > 0) {
      lines.push('RATIONALE:');
      for (const r of recommendation.reasons) {
        lines.push(`  • ${r}`);
      }
    }

    return lines;
  }

  private computeMetricEvidence(params: {
    canaryValue?: number;
    baselineValue?: number;
    sampleCount: number;
    toleranceDelta: number;
    higherIsBetter: boolean;
    samples: number[];
  }): MetricEvidence {
    const { canaryValue, baselineValue, sampleCount, toleranceDelta, higherIsBetter, samples } = params;

    if (canaryValue === undefined || sampleCount === 0) {
      return {
        status: 'UNKNOWN',
        sampleCount: 0,
        confidence: 'unknown',
      };
    }

    let delta: number | undefined;
    let deltaPercent: number | undefined;

    if (baselineValue !== undefined) {
      delta = canaryValue - baselineValue;
      if (baselineValue !== 0) {
        deltaPercent = (delta / baselineValue) * 100;
      }
    }

    // Determine status
    let status: 'PASS' | 'FAIL' | 'UNKNOWN' = 'PASS';
    if (baselineValue !== undefined) {
      if (higherIsBetter) {
        // e.g. success rate: canary cannot drop by more than toleranceDelta below baseline
        if (canaryValue < baselineValue - toleranceDelta) {
          status = 'FAIL';
        }
      } else {
        // e.g. failure rate or tokens: canary cannot exceed baseline by more than toleranceDelta
        if (canaryValue > baselineValue * (1.0 + toleranceDelta)) {
          status = 'FAIL';
        }
      }
    }

    // Variance & Standard Deviation
    let variance: number | undefined;
    let standardDeviation: number | undefined;

    if (samples.length > 1) {
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      variance = samples.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / (samples.length - 1);
      standardDeviation = Math.sqrt(variance);
    }

    const confidence: EvidenceConfidence = sampleCount >= 20 ? 'high' : sampleCount >= 5 ? 'medium' : 'low';

    return {
      value: canaryValue,
      baselineValue,
      delta,
      deltaPercent,
      status,
      sampleCount,
      variance,
      standardDeviation,
      confidence,
    };
  }
}
