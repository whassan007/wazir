import type {
  ExperimentPlan,
  RegressionGuardResult,
  CategoryRegressionSummary,
  MetricConstraint,
  ComparativeBenchmarkSuiteResult,
  BenchmarkSuiteResult,
  MetricSummaryStatistics,
  PairedMetricEvidence,
} from '@wazir/core';
import { pairBenchmarkSamples, evaluatePairedMetric } from './pairedEvidence.js';
import { extractMetricValueSafe } from './multiObjectiveOptimizer.js';

export interface RegressionGuardOptions {
  /** Global tolerance allowed for protected metrics (e.g. 0.02 = 2% drop permitted on non-critical metrics) */
  defaultTolerance?: number;
  /** Enforce strict zero-regression on task success / pass rate (default true) */
  strictPassRateProtection?: boolean;
  /** Minimum independent, non-tied pairs per task (default 5; cannot be below 5) */
  minSampleCount?: number;
}

export class RegressionGuard {
  private readonly defaultTolerance: number;
  private readonly strictPassRateProtection: boolean;
  private readonly minSampleCount: number;

  constructor(options: RegressionGuardOptions = {}) {
    this.defaultTolerance = options.defaultTolerance ?? 0.0;
    this.strictPassRateProtection = options.strictPassRateProtection ?? true;
    const minimum = options.minSampleCount ?? 5;
    if (!Number.isSafeInteger(minimum) || minimum < 5) throw new Error('minSampleCount must be an integer of at least 5');
    if (!Number.isFinite(this.defaultTolerance) || this.defaultTolerance < 0 || this.defaultTolerance >= 1) {
      throw new Error('defaultTolerance must be finite and between 0 (inclusive) and 1 (exclusive)');
    }
    this.minSampleCount = minimum;
  }

  /**
   * Evaluates candidate results against baseline metrics and experiment plan constraints.
   * Enforces WAZIR INVARIANTS:
   * - ZERO REGRESSION on correctness and protected metrics.
   * - Primary metric improvement MUST NOT silently destroy any protected metric.
   * - INCONCLUSIVE if evidence is insufficient or variance too high.
   */
  public evaluate(params: {
    plan: ExperimentPlan;
    baselineSuite: BenchmarkSuiteResult;
    candidateSuite: BenchmarkSuiteResult;
    comparison: ComparativeBenchmarkSuiteResult;
    candidateVerificationPassed?: boolean;
    verificationErrors?: string[];
  }): RegressionGuardResult {
    const {
      plan,
      baselineSuite,
      candidateSuite,
      comparison,
      candidateVerificationPassed,
      verificationErrors = [],
    } = params;

    const regressionsDetected: string[] = [];
    const protectedViolations: string[] = [];
    const inconclusiveReasons: string[] = [];

    if (baselineSuite.results.length === 0 || candidateSuite.results.length === 0) {
      inconclusiveReasons.push(
        `EMPTY_BENCHMARK_SUITE: Baseline (${baselineSuite.results.length}) and candidate (${candidateSuite.results.length}) suites must both contain executed tasks`,
      );
    }

    const requiredMetrics = new Set([
      String(plan.primaryMetric),
      'verification_success',
      ...(plan.objectives ?? []).map((o) => String(o.metric)),
      ...(plan.protectedMetrics ?? []).map(String),
      ...(plan.hardConstraints ?? []).map((c) => String(c.metric)),
      ...(plan.objectives ?? []).flatMap((o) => o.hardConstraint ? [String(o.hardConstraint.metric)] : []),
      ...Object.values(plan.regressionConstraints ?? {}).map((c) => String(c.metric)),
      ...(plan.requiredImprovement ? [String(plan.requiredImprovement.metric)] : []),
      ...(this.strictPassRateProtection ? ['task_success'] : []),
    ]);
    for (const metric of requiredMetrics) {
      for (const [label, suite] of [['baseline', baselineSuite], ['candidate', candidateSuite]] as const) {
        if (!Number.isFinite(this.extractMetricValue(metric, suite, comparison, label === 'baseline'))) {
          inconclusiveReasons.push(`UNAVAILABLE_METRIC: ${label} '${metric}' is missing, invalid, or incomplete`);
        }
      }
    }

    // 1. Correctness Gates Check (never assume verification passed when omitted; require explicit evidence)
    const hasVerifiedCandidateRuns =
      candidateSuite.results.length > 0 &&
      candidateSuite.results.some((r) => r.scoreReport?.metrics?.physicalVerificationSuccess === true) &&
      candidateSuite.results.every((r) => r.scoreReport?.metrics?.physicalVerificationSuccess !== false);
    const missingCandidateVerification =
      candidateSuite.results.length === 0 ||
      candidateSuite.results.some((r) => typeof r.scoreReport?.metrics?.physicalVerificationSuccess !== 'boolean');

    let correctnessGatesPassed =
      candidateVerificationPassed !== false &&
      verificationErrors.length === 0 &&
      hasVerifiedCandidateRuns &&
      !missingCandidateVerification;

    if (candidateVerificationPassed === false || verificationErrors.length > 0) {
      correctnessGatesPassed = false;
      regressionsDetected.push(
        `VERIFICATION_FAILURE: Candidate failed physical verification or test checks (${verificationErrors.join(', ')})`,
      );
    } else if (candidateVerificationPassed === undefined && missingCandidateVerification) {
      correctnessGatesPassed = false;
      inconclusiveReasons.push(
        'MISSING_VERIFICATION_EVIDENCE: Candidate verification status was omitted and run-level physicalVerificationSuccess evidence is incomplete',
      );
    }

    // 1b. Protected Fixture Modification & Benchmark Contamination Checks
    for (const [label, suite] of [['baseline', baselineSuite], ['candidate', candidateSuite]] as const) {
      for (const run of suite.results) {
        const raw = run.scoreReport?.metrics?.rawMetrics;
        const reason = run.scoreReport?.rejectionReason ?? '';
        if (raw?.protectedFixtureModified === true || reason.startsWith('PROTECTED_FIXTURE_MODIFIED')) {
          correctnessGatesPassed = false;
          regressionsDetected.push(
            `PROTECTED_FIXTURE_MODIFIED: ${label} task '${run.taskId}' modified a protected benchmark fixture`,
          );
        }
        if (raw?.benchmarkContaminated === true || reason.startsWith('BENCHMARK_CONTAMINATED')) {
          correctnessGatesPassed = false;
          regressionsDetected.push(
            `BENCHMARK_CONTAMINATED: ${label} task '${run.taskId}' had contaminated benchmark context or environment`,
          );
        }
      }
    }

    if (comparison.regressionDetected) {
      correctnessGatesPassed = false;
      regressionsDetected.push(
        `BROKEN_BENCHMARK_TASKS: Candidate regressed on ${comparison.regressedTasks.length} previously passing task(s): ${comparison.regressedTasks.join(', ')}`,
      );
    }

    // 2. Primary / Multi-Objective Constraints Check
    const isMultiObjective = Boolean(plan.objectives && plan.objectives.length > 0);
    let primaryMet = { satisfied: true, reason: 'multi-objective evaluation' };

    if (!isMultiObjective) {
      if (plan.requiredImprovement) {
        primaryMet = this.evaluateConstraint(
          plan.requiredImprovement,
          baselineSuite,
          candidateSuite,
          comparison,
        );

        if (!primaryMet.satisfied) {
          (primaryMet.reason.startsWith('UNAVAILABLE_METRIC') ? inconclusiveReasons : regressionsDetected).push(
            `PRIMARY_OBJECTIVE_NOT_MET: Primary metric '${plan.primaryMetric}' failed constraint: ${primaryMet.reason}`,
          );
        }
      }
    } else {
      // In multi-objective mode, check hard constraints from plan.hardConstraints
      for (const constraint of plan.hardConstraints ?? []) {
        const check = this.evaluateConstraint(constraint, baselineSuite, candidateSuite, comparison);
        if (!check.satisfied) {
          (check.reason.startsWith('UNAVAILABLE_METRIC') ? inconclusiveReasons : regressionsDetected).push(
            `HARD_CONSTRAINT_VIOLATED: Hard constraint on '${constraint.metric}' failed: ${check.reason}`,
          );
          primaryMet = { satisfied: false, reason: check.reason };
        }
      }

      // Check hard constraints defined on individual objectives
      for (const obj of plan.objectives ?? []) {
        if (obj.hardConstraint) {
          const check = this.evaluateConstraint(obj.hardConstraint, baselineSuite, candidateSuite, comparison);
          if (!check.satisfied) {
            (check.reason.startsWith('UNAVAILABLE_METRIC') ? inconclusiveReasons : regressionsDetected).push(
              `HARD_CONSTRAINT_VIOLATED: Objective '${obj.metric}' hard constraint failed: ${check.reason}`,
            );
            primaryMet = { satisfied: false, reason: check.reason };
          }
        }
      }
    }

    // 3. Protected Metrics Check
    for (const [metricName, constraint] of Object.entries(plan.regressionConstraints ?? {})) {
      const check = this.evaluateConstraint(constraint, baselineSuite, candidateSuite, comparison);
      if (!check.satisfied) {
        (check.reason.startsWith('UNAVAILABLE_METRIC') ? inconclusiveReasons : protectedViolations).push(
          `PROTECTED_METRIC_REGRESSION: Metric '${metricName}' regressed: ${check.reason}`,
        );
      }
    }

    if (plan.protectedMetrics) {
      for (const metricName of plan.protectedMetrics) {
        const metricStr = String(metricName);
        if (plan.regressionConstraints && plan.regressionConstraints[metricStr]) {
          continue; // Already evaluated above
        }
        const baseVal = this.extractMetricValue(metricStr, baselineSuite, comparison, true);
        const candVal = this.extractMetricValue(metricStr, candidateSuite, comparison, false);
        const isCostOrResource = [
          'input_tokens',
          'tokens',
          'total_tokens',
          'peak_context_tokens',
          'wall_time',
          'latency',
          'duration',
          'repair_cycles',
          'model_calls',
          'monetary_cost',
          'compute_cost',
          'tool_failures',
          'tool_failure_rate',
          'malformed_actions',
        ].includes(metricStr);

        if (isCostOrResource) {
          const maxAllowed = baseVal * (1 + this.defaultTolerance);
          if (candVal > maxAllowed + 1e-9) {
            protectedViolations.push(
              `PROTECTED_METRIC_REGRESSION: Protected metric '${metricStr}' increased from ${candVal} above allowed baseline ${maxAllowed}`,
            );
          }
        } else {
          const minAllowed = baseVal * (1 - this.defaultTolerance);
          if (candVal < minAllowed - 1e-9) {
            protectedViolations.push(
              `PROTECTED_METRIC_REGRESSION: Protected metric '${metricStr}' dropped to ${candVal} below allowed baseline ${minAllowed}`,
            );
          }
        }
      }
    }

    // Default protection on pass rate if not explicitly specified
    if (this.strictPassRateProtection && !plan.regressionConstraints?.['task_success']) {
      if (comparison.passRateDelta < -this.defaultTolerance) {
        protectedViolations.push(
          `PASS_RATE_REGRESSION: Overall task pass rate dropped from ${(comparison.baselinePassRate * 100).toFixed(1)}% to ${(comparison.candidatePassRate * 100).toFixed(1)}% (delta: ${(comparison.passRateDelta * 100).toFixed(1)}%)`,
        );
      }
    }

    // 4. Independent repeated pairs, matched by task/repetition and immutable definitions.
    const paired = pairBenchmarkSamples(baselineSuite, candidateSuite);
    inconclusiveReasons.push(...paired.issues);
    const tasks = [...new Set([...baselineSuite.results, ...candidateSuite.results].map((r) => r.taskId))];
    const minimum = Math.max(this.minSampleCount, plan.sampleSize ?? this.minSampleCount);
    const statisticalEvidence: PairedMetricEvidence[] = [];
    const objectives = isMultiObjective ? plan.objectives! : [{
      metric: plan.primaryMetric,
      direction: plan.hypothesis?.expectedMetricEffect?.direction === 'increase' ? 'MAXIMIZE' as const : 'MINIMIZE' as const,
    }];
    // Include every pre-registered objective and allowed candidate in the test family,
    // rather than picking an uncorrected p-value after inspecting the results.
    const candidateLimit = plan.budget?.maxCandidatesPerExperiment ?? 1;
    const adjustedAlpha = 0.05 / (Math.max(1, tasks.length) * objectives.length * candidateLimit);
    if (!Number.isSafeInteger(minimum) || minimum < 5 || !Number.isSafeInteger(candidateLimit) || candidateLimit < 1) {
      inconclusiveReasons.push('INVALID_STATISTICAL_POLICY: Invalid sample or candidate budget');
    }
    let supportedObjective = false;
    for (const objective of objectives) {
      let supportedForEveryTask = tasks.length > 0;
      let anySupportedTask = false;
      for (const taskId of tasks) {
        const pairs = paired.pairs.filter((p) => p.baseline.taskId === taskId);
        if (pairs.length < minimum) {
          inconclusiveReasons.push(`INSUFFICIENT_SAMPLES: '${taskId}' has ${pairs.length} paired repetitions (minimum required: ${minimum})`);
        }
        const evidence = evaluatePairedMetric({
          taskId, metric: String(objective.metric), direction: objective.direction,
          pairs, baselineSuite, candidateSuite, minSampleCount: minimum, adjustedAlpha,
        });
        if (evidence) statisticalEvidence.push(evidence);
        if (evidence?.supported) anySupportedTask = true;
        const unchanged = evidence && evidence.wins === 0 && evidence.losses === 0 && evidence.pairCount >= minimum;
        if (!evidence?.supported && !unchanged) supportedForEveryTask = false;
      }
      const baseValue = this.extractMetricValue(String(objective.metric), baselineSuite, comparison, true);
      const candValue = this.extractMetricValue(String(objective.metric), candidateSuite, comparison, false);
      const aggregateImproved = objective.direction === 'MINIMIZE' ? candValue < baseValue : candValue > baseValue;
      if (supportedForEveryTask && anySupportedTask && aggregateImproved) supportedObjective = true;
    }
    if (!supportedObjective) inconclusiveReasons.push('UNCERTAIN_IMPROVEMENT: No objective has repeated, statistically supported directional improvement across every task');

    // Never let a comparison summary hide a per-pair correctness regression.
    for (const pair of paired.pairs) {
      if (pair.baseline.scoreReport?.passed && (!pair.candidate.scoreReport?.passed || pair.candidate.error)) {
        correctnessGatesPassed = false;
        regressionsDetected.push(`PAIRED_CORRECTNESS_REGRESSION: ${pair.baseline.taskId} repetition ${pair.baseline.repetition ?? 0}`);
      }
      for (const metric of ['taskSuccess', 'physicalVerificationSuccess'] as const) {
        if (pair.baseline.scoreReport?.metrics?.[metric] === true && pair.candidate.scoreReport?.metrics?.[metric] !== true) {
          correctnessGatesPassed = false;
          regressionsDetected.push(`PAIRED_VERIFICATION_REGRESSION: ${pair.baseline.taskId} ${metric}`);
        }
      }
    }

    // 5. Per-category regression breakdown (prevents optimizing easy tasks while regressing a harder category)
    const categories = [
      ...new Set(
        [...baselineSuite.results, ...candidateSuite.results]
          .map((r) => r.category ?? r.scoreReport?.category)
          .filter((c): c is NonNullable<typeof c> => Boolean(c)),
      ),
    ];
    const categoryBreakdown: Record<string, CategoryRegressionSummary> = {};
    for (const category of categories) {
      const baseCatRuns = baselineSuite.results.filter((r) => (r.category ?? r.scoreReport?.category) === category);
      const candCatRuns = candidateSuite.results.filter((r) => (r.category ?? r.scoreReport?.category) === category);
      const catTasks = new Set([...baseCatRuns, ...candCatRuns].map((r) => r.taskId));
      const basePass = baseCatRuns.length > 0
        ? baseCatRuns.filter((r) => r.scoreReport?.passed && !r.error).length / baseCatRuns.length
        : 0;
      const candPass = candCatRuns.length > 0
        ? candCatRuns.filter((r) => r.scoreReport?.passed && !r.error).length / candCatRuns.length
        : 0;
      const delta = Number((candPass - basePass).toFixed(4));
      const regressed = baseCatRuns.length > 0 && candCatRuns.length > 0 && delta < -this.defaultTolerance - 1e-9;
      if (regressed) {
        correctnessGatesPassed = false;
        regressionsDetected.push(
          `CATEGORY_REGRESSION: Category '${category}' pass rate dropped from ${(basePass * 100).toFixed(1)}% to ${(candPass * 100).toFixed(1)}%`,
        );
      }
      categoryBreakdown[String(category)] = {
        taskCount: catTasks.size,
        pairCount: Math.min(baseCatRuns.length, candCatRuns.length),
        baselinePassRate: basePass,
        candidatePassRate: candPass,
        passRateDelta: delta,
        regressed,
      };
    }

    // 6. Model-scoped divergence detection (blocks global promotion when candidate helps one model but harms another)
    const modelOf = (r: BenchmarkSuiteResult['results'][number]): string | undefined => {
      const rawModel = r.scoreReport?.metrics?.rawMetrics?.modelId;
      if (typeof rawModel === 'string' && rawModel.length > 0) return rawModel;
      return r.runnerId;
    };
    const distinctModels = [
      ...new Set(
        [...baselineSuite.results, ...candidateSuite.results]
          .map(modelOf)
          .filter((m): m is string => Boolean(m)),
      ),
    ];
    let scopedModels: { improved: string[]; regressed: string[] } | undefined;
    if (distinctModels.length > 1) {
      const improvedModels: string[] = [];
      const regressedModels: string[] = [];
      const primaryDir = objectives[0]?.direction ?? 'MINIMIZE';
      for (const modelId of distinctModels) {
        const bRuns = baselineSuite.results.filter((r) => modelOf(r) === modelId);
        const cRuns = candidateSuite.results.filter((r) => modelOf(r) === modelId);
        if (bRuns.length === 0 || cRuns.length === 0) continue;
        const bPass = bRuns.filter((r) => r.scoreReport?.passed && !r.error).length / bRuns.length;
        const cPass = cRuns.filter((r) => r.scoreReport?.passed && !r.error).length / cRuns.length;
        const bSubSuite: BenchmarkSuiteResult = { ...baselineSuite, results: bRuns, totalTasks: bRuns.length };
        const cSubSuite: BenchmarkSuiteResult = { ...candidateSuite, results: cRuns, totalTasks: cRuns.length };
        const bMetric = extractMetricValueSafe(String(plan.primaryMetric), bSubSuite, comparison, true);
        const cMetric = extractMetricValueSafe(String(plan.primaryMetric), cSubSuite, comparison, false);
        const metricImproved = Number.isFinite(bMetric) && Number.isFinite(cMetric)
          ? (primaryDir === 'MINIMIZE' ? cMetric < bMetric - 1e-9 : cMetric > bMetric + 1e-9)
          : false;
        const metricRegressed = Number.isFinite(bMetric) && Number.isFinite(cMetric)
          ? (primaryDir === 'MINIMIZE' ? cMetric > bMetric + 1e-9 : cMetric < bMetric - 1e-9)
          : false;
        if (cPass < bPass - 1e-9 || metricRegressed) {
          regressedModels.push(modelId);
        } else if (cPass > bPass + 1e-9 || metricImproved) {
          improvedModels.push(modelId);
        }
      }
      if (improvedModels.length > 0 && regressedModels.length > 0) {
        scopedModels = { improved: improvedModels, regressed: regressedModels };
        regressionsDetected.push(
          `MODEL_SCOPED_REGRESSION: Candidate improved model(s) [${improvedModels.join(', ')}] but regressed model(s) [${regressedModels.join(', ')}]; global promotion rejected (scope to [${improvedModels.join(', ')}])`,
        );
      }
    }

    // Determine overall qualification
    const qualified =
      correctnessGatesPassed &&
      primaryMet.satisfied &&
      protectedViolations.length === 0 &&
      regressionsDetected.length === 0 &&
      inconclusiveReasons.length === 0;

    let summary = '';
    if (qualified) {
      summary = isMultiObjective
        ? `QUALIFIED: Candidate satisfied multi-objective constraints and protected metrics without regressions.`
        : `QUALIFIED: Candidate met primary objective '${plan.primaryMetric}' without regressions across protected metrics.`;
    } else if (inconclusiveReasons.length > 0 && protectedViolations.length === 0 && regressionsDetected.length === 0) {
      summary = `INCONCLUSIVE: Evidence is insufficient to establish verified improvement: ${inconclusiveReasons.join('; ')}`;
    } else {
      const allErrors = [...regressionsDetected, ...protectedViolations];
      summary = `REJECTED: Candidate failed qualification gates: ${allErrors.join('; ')}`;
    }

    return {
      qualified,
      statisticalEvidence,
      primaryObjectiveMet: primaryMet.satisfied,
      correctnessGatesPassed,
      regressionsDetected,
      protectedViolations,
      inconclusiveReasons,
      categoryBreakdown,
      ...(scopedModels ? { scopedModels } : {}),
      summary,
    };
  }

  private evaluateConstraint(
    constraint: MetricConstraint,
    baselineSuite: BenchmarkSuiteResult,
    candidateSuite: BenchmarkSuiteResult,
    comparison: ComparativeBenchmarkSuiteResult,
  ): { satisfied: boolean; reason: string } {
    const baseValue = this.extractMetricValue(constraint.metric, baselineSuite, comparison, true);
    const candValue = this.extractMetricValue(constraint.metric, candidateSuite, comparison, false);

    if (!Number.isFinite(candValue) || (constraint.isRelativeFactor && !Number.isFinite(baseValue))) {
      return { satisfied: false, reason: `UNAVAILABLE_METRIC: '${constraint.metric}' cannot be evaluated` };
    }
    let threshold = constraint.targetValue;
    if (constraint.isRelativeFactor) {
      threshold = baseValue * constraint.targetValue;
    }

    let satisfied = false;
    switch (constraint.operator) {
      case '<=':
        satisfied = candValue <= threshold + 1e-9;
        break;
      case '<':
        satisfied = candValue < threshold - 1e-9;
        break;
      case '>=':
        satisfied = candValue >= threshold - 1e-9;
        break;
      case '>':
        satisfied = candValue > threshold + 1e-9;
        break;
      case '==':
        satisfied = Math.abs(candValue - threshold) < 1e-6;
        break;
      default:
        satisfied = false;
    }

    return {
      satisfied,
      reason: `candidate value ${candValue} ${satisfied ? 'satisfies' : 'violates'} condition ${constraint.operator} target ${threshold} (baseline: ${baseValue})`,
    };
  }

  private extractMetricValue(
    metric: string,
    suite: BenchmarkSuiteResult,
    comparison: ComparativeBenchmarkSuiteResult,
    isBaseline: boolean,
  ): number {
    return extractMetricValueSafe(metric, suite, comparison, isBaseline);
  }

  /**
   * Computes statistical summary (mean, median, variance, stdDev, 95% confidence interval)
   */
  public computeStatistics(values: number[]): MetricSummaryStatistics {
    if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
      return {
        count: 0,
        mean: Number.NaN,
        median: Number.NaN,
        variance: Number.NaN,
        stdDev: Number.NaN,
        min: Number.NaN,
        max: Number.NaN,
        confidenceInterval95: [Number.NaN, Number.NaN],
      };
    }

    const count = values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const mean = sum / count;

    const median =
      count % 2 === 0
        ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
        : sorted[Math.floor(count / 2)];

    const variance =
      count > 1
        ? sorted.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (count - 1)
        : 0;
    const stdDev = Math.sqrt(variance);
    const min = sorted[0];
    const max = sorted[count - 1];

    // These descriptive intervals are not used for promotion. Small samples
    // need Student's t, not an asymptotic normal critical value.
    const t95 = [0, 12.707, 4.303, 3.183, 2.777, 2.571, 2.447, 2.365, 2.307, 2.263,
      2.229, 2.201, 2.179, 2.161, 2.145, 2.132, 2.120, 2.110, 2.102, 2.094,
      2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.049, 2.046, 2.043];
    const margin = count > 1 ? (t95[Math.min(count - 1, 30)] * stdDev) / Math.sqrt(count) : Number.NaN;
    const confidenceInterval95: [number, number] = [mean - margin, mean + margin];

    return {
      count,
      mean,
      median,
      variance,
      stdDev,
      min,
      max,
      confidenceInterval95,
    };
  }
}
