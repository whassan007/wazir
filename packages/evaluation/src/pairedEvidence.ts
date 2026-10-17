import type {
  BenchmarkRunResult, BenchmarkSuiteResult, PairedMetricEvidence,
} from '@wazir/core';
import { extractMetricValueSafe } from './multiObjectiveOptimizer.js';

export const benchmarkSampleKey = (run: BenchmarkRunResult): string =>
  JSON.stringify([run.taskId, run.repetition ?? 0]);

export function pairBenchmarkSamples(baseline: BenchmarkSuiteResult, candidate: BenchmarkSuiteResult): {
  pairs: Array<{ baseline: BenchmarkRunResult; candidate: BenchmarkRunResult }>;
  issues: string[];
} {
  const issues: string[] = [];
  const executions = new Set<string>();
  const definitions = new Map<string, string>();
  const index = (suite: BenchmarkSuiteResult, label: string) => {
    const samples = new Map<string, BenchmarkRunResult>();
    for (const run of suite.results) {
      const key = benchmarkSampleKey(run);
      const identity = JSON.stringify([run.evaluationVersion, run.taskDefinitionHash, run.category]);
      if (definitions.has(run.taskId) && definitions.get(run.taskId) !== identity) {
        issues.push(`CHANGED_EVALUATION_DEFINITION: ${run.taskId}`);
      }
      definitions.set(run.taskId, identity);
      if (samples.has(key)) issues.push(`DUPLICATE_SAMPLE: ${label} ${key}`);
      if (run.repetition !== undefined && (!Number.isSafeInteger(run.repetition) || run.repetition < 0)) {
        issues.push(`INVALID_REPETITION: ${label} ${key}`);
      }
      const executionId = run.scoreReport?.executionId;
      if (!executionId || executions.has(executionId)) issues.push(`INVALID_EXECUTION_ID: ${label} ${key}`);
      if (executionId) executions.add(executionId);
      samples.set(key, run);
    }
    return samples;
  };
  const base = index(baseline, 'baseline');
  const cand = index(candidate, 'candidate');
  const pairs: Array<{ baseline: BenchmarkRunResult; candidate: BenchmarkRunResult }> = [];
  for (const key of new Set([...base.keys(), ...cand.keys()])) {
    const b = base.get(key);
    const c = cand.get(key);
    if (!b || !c) {
      issues.push(`UNPAIRED_SAMPLE: ${key}`);
      continue;
    }
    if (!b.evaluationVersion || b.evaluationVersion !== c.evaluationVersion ||
        !b.taskDefinitionHash || b.taskDefinitionHash !== c.taskDefinitionHash || b.category !== c.category) {
      issues.push(`INCOMPARABLE_DEFINITION: ${key}`);
    }
    pairs.push({ baseline: b, candidate: c });
  }
  return { pairs, issues };
}

/** Exact binomial upper tail, using log probabilities to avoid underflow at n=1000. */
export function binomialUpperTail(wins: number, trials: number, probability = 0.5): number {
  if (wins <= 0) return 1;
  if (wins > trials || probability <= 0) return 0;
  if (probability >= 1) return 1;
  let logMass = trials * Math.log1p(-probability);
  let tail = 0;
  for (let k = 0; k <= trials; k++) {
    if (k >= wins) tail += Math.exp(logMass);
    if (k < trials) logMass += Math.log(trials - k) - Math.log(k + 1) + Math.log(probability) - Math.log1p(-probability);
  }
  return Math.min(1, tail);
}

export function exactImprovementLowerBound(wins: number, trials: number, alpha: number): number {
  if (wins === 0 || trials === 0) return 0;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 60; step++) {
    const mid = (low + high) / 2;
    if (binomialUpperTail(wins, trials, mid) < alpha) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Exact one-sided paired sign test, excluding ties (NIST sign-test method).
 * Assumes independently executed pairs. This tests directional consistency,
 * not a confidence interval on the mean cost or correctness non-inferiority. */
export function evaluatePairedMetric(params: {
  taskId: string;
  metric: string;
  direction: 'MINIMIZE' | 'MAXIMIZE';
  pairs: ReturnType<typeof pairBenchmarkSamples>['pairs'];
  baselineSuite: BenchmarkSuiteResult;
  candidateSuite: BenchmarkSuiteResult;
  minSampleCount: number;
  adjustedAlpha: number;
}): PairedMetricEvidence | undefined {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let totalImprovement = 0;
  for (const pair of params.pairs) {
    const single = (suite: BenchmarkSuiteResult, run: BenchmarkRunResult) => extractMetricValueSafe(params.metric, {
      ...suite, results: [run], aggregateMetrics: {} as BenchmarkSuiteResult['aggregateMetrics'],
    });
    const base = single(params.baselineSuite, pair.baseline);
    const cand = single(params.candidateSuite, pair.candidate);
    if (!Number.isFinite(base) || !Number.isFinite(cand)) return undefined;
    const improvement = params.direction === 'MINIMIZE' ? base - cand : cand - base;
    if (!Number.isFinite(improvement)) return undefined;
    totalImprovement += improvement;
    if (improvement > 1e-9) wins++;
    else if (improvement < -1e-9) losses++;
    else ties++;
  }
  const informative = wins + losses;
  const pValue = binomialUpperTail(wins, informative);
  return {
    taskId: params.taskId, metric: params.metric, pairCount: params.pairs.length,
    wins, losses, ties, meanPairedImprovement: totalImprovement / Math.max(1, params.pairs.length), pValue, adjustedAlpha: params.adjustedAlpha,
    improvementProbabilityLowerBound: exactImprovementLowerBound(wins, informative, params.adjustedAlpha),
    supported: informative >= params.minSampleCount && pValue <= params.adjustedAlpha && totalImprovement > 0 && Number.isFinite(totalImprovement),
  };
}
