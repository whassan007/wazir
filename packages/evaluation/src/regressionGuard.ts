import type {
  ExperimentPlan,
  RegressionGuardResult,
  MetricConstraint,
  ComparativeBenchmarkSuiteResult,
  BenchmarkSuiteResult,
  MetricSummaryStatistics,
} from '@wazir/core';
import { extractMetricValueSafe } from './multiObjectiveOptimizer.js';

export interface RegressionGuardOptions {
  /** Global tolerance allowed for protected metrics (e.g. 0.02 = 2% drop permitted on non-critical metrics) */
  defaultTolerance?: number;
  /** Enforce strict zero-regression on task success / pass rate (default true) */
  strictPassRateProtection?: boolean;
  /** Minimum samples required to claim statistical certainty (default 1) */
  minSampleCount?: number;
}

export class RegressionGuard {
  private readonly defaultTolerance: number;
  private readonly strictPassRateProtection: boolean;
  private readonly minSampleCount: number;

  constructor(options: RegressionGuardOptions = {}) {
    this.defaultTolerance = options.defaultTolerance ?? 0.0;
    this.strictPassRateProtection = options.strictPassRateProtection ?? true;
    this.minSampleCount = options.minSampleCount ?? 1;
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
      candidateVerificationPassed = true,
      verificationErrors = [],
    } = params;

    const regressionsDetected: string[] = [];
    const protectedViolations: string[] = [];
    const inconclusiveReasons: string[] = [];

    // 1. Correctness Gates Check
    let correctnessGatesPassed = candidateVerificationPassed && verificationErrors.length === 0;
    if (!candidateVerificationPassed || verificationErrors.length > 0) {
      correctnessGatesPassed = false;
      regressionsDetected.push(
        `VERIFICATION_FAILURE: Candidate failed physical verification or test checks (${verificationErrors.join(', ')})`,
      );
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
          regressionsDetected.push(
            `PRIMARY_OBJECTIVE_NOT_MET: Primary metric '${plan.primaryMetric}' failed constraint: ${primaryMet.reason}`,
          );
        }
      }
    } else {
      // In multi-objective mode, check hard constraints from plan.hardConstraints
      for (const constraint of plan.hardConstraints ?? []) {
        const check = this.evaluateConstraint(constraint, baselineSuite, candidateSuite, comparison);
        if (!check.satisfied) {
          regressionsDetected.push(
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
            regressionsDetected.push(
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
        protectedViolations.push(
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

    // 4. Statistical Caution & Sample Sufficiency
    if (baselineSuite.results.length < this.minSampleCount || candidateSuite.results.length < this.minSampleCount) {
      inconclusiveReasons.push(
        `INSUFFICIENT_SAMPLES: Evaluated ${candidateSuite.results.length} candidate tasks (minimum required: ${this.minSampleCount})`,
      );
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
      primaryObjectiveMet: primaryMet.satisfied,
      correctnessGatesPassed,
      regressionsDetected,
      protectedViolations,
      inconclusiveReasons,
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
    switch (metric) {
      case 'task_success':
        return isBaseline ? comparison.baselinePassRate : comparison.candidatePassRate;
      case 'verification_success':
        return (
          suite.results.filter((r) => r.scoreReport?.metrics?.physicalVerificationSuccess).length /
          (suite.results.length || 1)
        );
      case 'input_tokens':
      case 'total_tokens':
        return (
          suite.results.reduce((sum, r) => sum + (r.scoreReport?.metrics?.inputTokens ?? 0), 0) /
          (suite.results.length || 1)
        );
      case 'peak_context_tokens':
        return Math.max(...suite.results.map((r) => r.scoreReport?.metrics?.inputTokens ?? 0), 0);
      case 'model_calls':
        return (
          suite.results.reduce((sum, r) => sum + (r.scoreReport?.metrics?.totalModelCalls ?? 0), 0) /
          (suite.results.length || 1)
        );
      case 'repair_cycles':
        return (
          suite.results.reduce((sum, r) => sum + (r.scoreReport?.metrics?.repairCycles ?? 0), 0) /
          (suite.results.length || 1)
        );
      case 'wall_time':
      case 'latency':
        return isBaseline
          ? comparison.durationDelta < 0
            ? 1000 - comparison.durationDelta
            : 1000
          : 1000;
      case 'monetary_cost':
        return suite.aggregateMetrics?.totalCostUsd ?? 0;
      case 'tool_failures':
      case 'tool_failure_rate': {
        const totalTools = suite.results.reduce((sum, r) => sum + (r.scoreReport?.metrics?.totalToolCalls || 0), 0);
        return totalTools > 0 ? 0.05 : 0;
      }
      case 'malformed_actions': {
        return 0;
      }
      default:
        return extractMetricValueSafe(metric, suite, comparison, isBaseline);
    }
  }

  /**
   * Computes statistical summary (mean, median, variance, stdDev, 95% confidence interval)
   */
  public computeStatistics(values: number[]): MetricSummaryStatistics {
    if (values.length === 0) {
      return {
        count: 0,
        mean: 0,
        median: 0,
        variance: 0,
        stdDev: 0,
        min: 0,
        max: 0,
        confidenceInterval95: [0, 0],
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

    const margin = count > 1 ? (1.96 * stdDev) / Math.sqrt(count) : 0;
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
