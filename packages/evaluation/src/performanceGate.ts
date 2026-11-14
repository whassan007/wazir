export type PerformanceMetricCategory = 'latency' | 'memory' | 'throughput' | 'correctness';

export type PerformanceGateStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface LatencySummaryMetrics {
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  meanMs?: number;
  stdDevMs?: number;
  samples?: number | number[];
}

export type LatencyInput = LatencySummaryMetrics | number[];

export interface MemorySummaryMetrics {
  heapDeltaMB?: number;
  rssMB?: number;
  heapUsedMB?: number;
  samples?: number | number[];
  heapDeltaSamplesMB?: number[];
  rssSamplesMB?: number[];
}

export type MemoryInput = MemorySummaryMetrics | number[];

export interface ThroughputSummaryMetrics {
  opsPerSec?: number;
  requestsPerSec?: number;
  tokensPerSec?: number;
  meanOpsPerSec?: number;
  samples?: number | number[];
}

export type ThroughputInput = ThroughputSummaryMetrics | number[];

export interface CorrectnessMetrics {
  passRate?: number;
  passedChecks?: number;
  totalChecks?: number;
  failedChecks?: number;
  allPassed?: boolean;
  samples?: number;
}

export interface PerformanceSnapshot {
  latency?: LatencyInput;
  latencies?: Record<string, LatencyInput>;
  memory?: MemoryInput;
  throughput?: ThroughputInput;
  correctness?: CorrectnessMetrics | number | boolean;
  passRate?: number;
  failedChecks?: number;
  totalChecks?: number;
  samples?: number;
  metrics?: Record<string, LatencyInput | MemoryInput | ThroughputInput | number[]>;
}

export interface PerformanceGateOptions {
  /**
   * Maximum allowed latency regression ratio (default 0.10 = 10%).
   * Fails if p50 or p95 latency regresses by more than this ratio when sample size >= minSamples
   * and absolute delta exceeds minLatencyNoiseFloorMs.
   */
  maxLatencyRegressionRatio?: number;
  /**
   * Minimum absolute latency increase (in ms) before a percentage regression is considered above noise floor (default 2.0 ms).
   */
  minLatencyNoiseFloorMs?: number;
  /**
   * Maximum allowed memory growth ratio (default 0.15 = 15%).
   * Fails if heap delta or RSS grows by more than this ratio above baseline beyond minMemoryNoiseFloorMB.
   */
  maxMemoryGrowthRatio?: number;
  /**
   * Minimum absolute memory growth (in MB) before a percentage growth is considered above noise floor (default 5.0 MB).
   */
  minMemoryNoiseFloorMB?: number;
  /**
   * Maximum allowed throughput drop ratio (default 0.10 = 10%).
   */
  maxThroughputRegressionRatio?: number;
  /**
   * Minimum required correctness pass rate (default 1.0 = 100%).
   * Zero correctness regression allowed: any drop in pass rate or any failed correctness check
   * immediately fails the gate with CORRECTNESS_REGRESSION.
   */
  minPassRate?: number;
  /**
   * Minimum sample count required for conclusive latency/memory/throughput comparisons (default 5).
   * If sample count < minSamples, the metric check is marked INCONCLUSIVE rather than falsely passing.
   */
  minSamples?: number;
  /**
   * Significance level alpha for Welch's t-test / Mann-Whitney U test on raw sample arrays (default 0.05).
   */
  alpha?: number;
}

export interface PerformanceGateCheck {
  metric: string;
  category: PerformanceMetricCategory;
  baselineValue: number;
  candidateValue: number;
  deltaPercent: number;
  thresholdPercent: number;
  status: PerformanceGateStatus;
  reason: string;
}

export interface PerformanceGateVerdict {
  passed: boolean;
  status: PerformanceGateStatus;
  checks: PerformanceGateCheck[];
  BlockingFailures: string[];
  /** Lowercase alias for convenience alongside BlockingFailures */
  blockingFailures: string[];
  warnings: string[];
  summary: string;
}

export interface StatisticalSampleSummary {
  count: number;
  mean: number;
  stdDev: number;
  variance: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

export interface WelchTestResult {
  tStatistic: number;
  degreesOfFreedom: number;
  pValueOneSided: number;
  pValueTwoSided: number;
  meanDelta: number;
  ci95Lower: number;
  ci95Upper: number;
  significantRegression: boolean;
}

export interface MannWhitneyResult {
  uStatistic: number;
  zScore: number;
  pValueOneSided: number;
  medianShift: number;
  significantRegression: boolean;
}

const DEFAULT_OPTIONS: Required<PerformanceGateOptions> = {
  maxLatencyRegressionRatio: 0.10,
  minLatencyNoiseFloorMs: 2.0,
  maxMemoryGrowthRatio: 0.15,
  minMemoryNoiseFloorMB: 5.0,
  maxThroughputRegressionRatio: 0.10,
  minPassRate: 1.0,
  minSamples: 5,
  alpha: 0.05,
};

/**
 * Computes interpolated percentile (0..1) on a sorted ascending array.
 */
export function computePercentile(sortedValues: readonly number[], quantile: number): number {
  if (sortedValues.length === 0) return Number.NaN;
  if (sortedValues.length === 1) return sortedValues[0];
  const clamped = Math.max(0, Math.min(1, quantile));
  const index = clamped * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

/**
 * Computes summary statistics from a raw numeric sample array.
 */
export function summarizeSamples(samples: readonly number[]): StatisticalSampleSummary {
  const valid = samples.filter((v) => Number.isFinite(v));
  const count = valid.length;
  if (count === 0) {
    return {
      count: 0,
      mean: Number.NaN,
      stdDev: Number.NaN,
      variance: Number.NaN,
      p50: Number.NaN,
      p95: Number.NaN,
      p99: Number.NaN,
      min: Number.NaN,
      max: Number.NaN,
    };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / count;
  const variance =
    count > 1
      ? sorted.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (count - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  return {
    count,
    mean,
    stdDev,
    variance,
    p50: computePercentile(sorted, 0.50),
    p95: computePercentile(sorted, 0.95),
    p99: computePercentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[count - 1],
  };
}

/**
 * Standard normal cumulative distribution function approximation (Abramowitz & Stegun 26.2.17).
 */
function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * absX);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-absX * absX);
  return 0.5 * (1 + sign * erf);
}

/**
 * Student's t critical value for 95% two-sided confidence (alpha = 0.05) given degrees of freedom.
 */
function tCritical95(df: number): number {
  const table: readonly number[] = [
    12.706, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
  ];
  const rounded = Math.max(1, Math.round(df));
  if (rounded <= 30) return table[rounded];
  return 1.96;
}

/**
 * Approximates upper-tail p-value P(T >= t) for Student's t distribution with df degrees of freedom
 * using the Hill / Wallace normal-transformation approximation accurate for df >= 2.
 */
function studentTUpperTail(t: number, df: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 0 : 1;
  if (df <= 0) return 0.5;
  if (t === 0) return 0.5;
  const absT = Math.abs(t);
  // Wallace (1959) approximation: z = sqrt(df * ln(1 + t^2 / df)) * (1 - 1 / (4 * df))
  const z =
    df >= 1
      ? Math.sqrt(df * Math.log(1 + (absT * absT) / df)) * (1 - 1 / (4 * df))
      : absT;
  const upper = 1 - normalCdf(z);
  return t > 0 ? upper : 1 - upper;
}

/**
 * Performs Welch's two-sample t-test comparing candidate samples against baseline samples.
 * For latency/memory (higher is worse), `significantRegression` checks whether candidate > baseline
 * is statistically significant at level `alpha`.
 */
export function welchTTest(
  baselineSamples: readonly number[],
  candidateSamples: readonly number[],
  alpha = 0.05,
  direction: 'HIGHER_IS_WORSE' | 'LOWER_IS_WORSE' = 'HIGHER_IS_WORSE',
): WelchTestResult {
  const base = summarizeSamples(baselineSamples);
  const cand = summarizeSamples(candidateSamples);
  const meanDelta = cand.mean - base.mean;

  if (base.count < 2 || cand.count < 2) {
    return {
      tStatistic: 0,
      degreesOfFreedom: 0,
      pValueOneSided: 1,
      pValueTwoSided: 1,
      meanDelta,
      ci95Lower: Number.NaN,
      ci95Upper: Number.NaN,
      significantRegression: false,
    };
  }

  const seBase = base.variance / base.count;
  const seCand = cand.variance / cand.count;
  const seTotal = Math.sqrt(seBase + seCand);

  if (seTotal < 1e-12) {
    const regressed =
      direction === 'HIGHER_IS_WORSE' ? meanDelta > 1e-9 : meanDelta < -1e-9;
    return {
      tStatistic: meanDelta === 0 ? 0 : meanDelta > 0 ? Infinity : -Infinity,
      degreesOfFreedom: base.count + cand.count - 2,
      pValueOneSided: regressed ? 0 : 1,
      pValueTwoSided: meanDelta === 0 ? 1 : 0,
      meanDelta,
      ci95Lower: meanDelta,
      ci95Upper: meanDelta,
      significantRegression: regressed,
    };
  }

  const tStatistic = meanDelta / seTotal;
  const dfNumerator = (seBase + seCand) * (seBase + seCand);
  const dfDenominator =
    (seBase * seBase) / Math.max(1, base.count - 1) +
    (seCand * seCand) / Math.max(1, cand.count - 1);
  const degreesOfFreedom =
    dfDenominator > 0 ? dfNumerator / dfDenominator : base.count + cand.count - 2;

  const tCrit = tCritical95(degreesOfFreedom);
  const ci95Lower = meanDelta - tCrit * seTotal;
  const ci95Upper = meanDelta + tCrit * seTotal;

  const directionalT = direction === 'HIGHER_IS_WORSE' ? tStatistic : -tStatistic;
  const pValueOneSided = studentTUpperTail(directionalT, degreesOfFreedom);
  const pValueTwoSided = Math.min(1, 2 * studentTUpperTail(Math.abs(tStatistic), degreesOfFreedom));

  return {
    tStatistic,
    degreesOfFreedom,
    pValueOneSided,
    pValueTwoSided,
    meanDelta,
    ci95Lower,
    ci95Upper,
    significantRegression: pValueOneSided <= alpha && directionalT > 0,
  };
}

/**
 * Performs non-parametric Mann-Whitney U test (Wilcoxon rank-sum) on two sample arrays.
 * Distinguishes systematic percentile/median shifts from single-sample outlier spikes.
 */
export function mannWhitneyUTest(
  baselineSamples: readonly number[],
  candidateSamples: readonly number[],
  alpha = 0.05,
  direction: 'HIGHER_IS_WORSE' | 'LOWER_IS_WORSE' = 'HIGHER_IS_WORSE',
): MannWhitneyResult {
  const n1 = baselineSamples.length;
  const n2 = candidateSamples.length;
  if (n1 === 0 || n2 === 0) {
    return {
      uStatistic: 0,
      zScore: 0,
      pValueOneSided: 1,
      medianShift: Number.NaN,
      significantRegression: false,
    };
  }

  let uCandGreater = 0;
  for (let i = 0; i < n2; i++) {
    const c = candidateSamples[i];
    for (let j = 0; j < n1; j++) {
      const b = baselineSamples[j];
      if (c > b + 1e-12) uCandGreater += 1;
      else if (Math.abs(c - b) <= 1e-12) uCandGreater += 0.5;
    }
  }

  const uStatistic = direction === 'HIGHER_IS_WORSE' ? uCandGreater : n1 * n2 - uCandGreater;
  const meanU = (n1 * n2) / 2;
  const stdU = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  const zScore = stdU > 0 ? (uStatistic - meanU) / stdU : 0;
  const pValueOneSided = 1 - normalCdf(zScore);

  const baseSorted = [...baselineSamples].sort((a, b) => a - b);
  const candSorted = [...candidateSamples].sort((a, b) => a - b);
  const medianShift = computePercentile(candSorted, 0.5) - computePercentile(baseSorted, 0.5);

  return {
    uStatistic,
    zScore,
    pValueOneSided,
    medianShift,
    significantRegression: pValueOneSided <= alpha && zScore > 0,
  };
}

interface NormalizedLatency {
  p50Ms: number;
  p95Ms: number;
  p99Ms?: number;
  meanMs?: number;
  sampleCount: number;
  rawSamples?: number[];
}

function normalizeLatencyInput(
  input: LatencyInput | undefined,
  fallbackSamples?: number,
): NormalizedLatency | undefined {
  if (!input) return undefined;
  if (Array.isArray(input)) {
    const stats = summarizeSamples(input);
    return {
      p50Ms: stats.p50,
      p95Ms: stats.p95,
      p99Ms: stats.p99,
      meanMs: stats.mean,
      sampleCount: stats.count,
      rawSamples: [...input],
    };
  }

  if (Array.isArray(input.samples)) {
    const stats = summarizeSamples(input.samples);
    return {
      p50Ms: input.p50Ms ?? stats.p50,
      p95Ms: input.p95Ms ?? stats.p95,
      p99Ms: input.p99Ms ?? stats.p99,
      meanMs: input.meanMs ?? stats.mean,
      sampleCount: stats.count,
      rawSamples: [...input.samples],
    };
  }

  const sampleCount =
    typeof input.samples === 'number'
      ? input.samples
      : fallbackSamples ?? 0;

  const p50Ms = input.p50Ms ?? input.meanMs ?? Number.NaN;
  const p95Ms = input.p95Ms ?? input.p50Ms ?? input.meanMs ?? Number.NaN;
  return {
    p50Ms,
    p95Ms,
    p99Ms: input.p99Ms,
    meanMs: input.meanMs,
    sampleCount,
  };
}

interface NormalizedMemory {
  heapDeltaMB?: number;
  rssMB?: number;
  sampleCount: number;
  rawHeapSamples?: number[];
  rawRssSamples?: number[];
}

function normalizeMemoryInput(
  input: MemoryInput | undefined,
  fallbackSamples?: number,
): NormalizedMemory | undefined {
  if (!input) return undefined;
  if (Array.isArray(input)) {
    const stats = summarizeSamples(input);
    return {
      heapDeltaMB: stats.p50,
      sampleCount: stats.count,
      rawHeapSamples: [...input],
    };
  }

  const rawHeap = Array.isArray(input.heapDeltaSamplesMB)
    ? input.heapDeltaSamplesMB
    : Array.isArray(input.samples)
      ? input.samples
      : undefined;
  const rawRss = Array.isArray(input.rssSamplesMB) ? input.rssSamplesMB : undefined;

  const heapStats = rawHeap ? summarizeSamples(rawHeap) : undefined;
  const rssStats = rawRss ? summarizeSamples(rawRss) : undefined;

  const sampleCount =
    typeof input.samples === 'number'
      ? input.samples
      : heapStats?.count ?? rssStats?.count ?? fallbackSamples ?? 0;

  const heapDeltaMB = input.heapDeltaMB ?? input.heapUsedMB ?? heapStats?.mean;
  const rssMB = input.rssMB ?? rssStats?.mean;

  return {
    heapDeltaMB,
    rssMB,
    sampleCount,
    rawHeapSamples: rawHeap,
    rawRssSamples: rawRss,
  };
}

interface NormalizedThroughput {
  value: number;
  metricName: string;
  sampleCount: number;
  rawSamples?: number[];
}

function normalizeThroughputInput(
  input: ThroughputInput | undefined,
  fallbackSamples?: number,
): NormalizedThroughput | undefined {
  if (!input) return undefined;
  if (Array.isArray(input)) {
    const stats = summarizeSamples(input);
    return {
      value: stats.mean,
      metricName: 'throughput_ops_per_sec',
      sampleCount: stats.count,
      rawSamples: [...input],
    };
  }

  const rawSamples = Array.isArray(input.samples) ? input.samples : undefined;
  const stats = rawSamples ? summarizeSamples(rawSamples) : undefined;
  const sampleCount =
    typeof input.samples === 'number'
      ? input.samples
      : stats?.count ?? fallbackSamples ?? 0;

  if (input.opsPerSec !== undefined || input.meanOpsPerSec !== undefined) {
    return {
      value: (input.opsPerSec ?? input.meanOpsPerSec)!,
      metricName: 'throughput_ops_per_sec',
      sampleCount,
      rawSamples,
    };
  }
  if (input.requestsPerSec !== undefined) {
    return {
      value: input.requestsPerSec,
      metricName: 'throughput_requests_per_sec',
      sampleCount,
      rawSamples,
    };
  }
  if (input.tokensPerSec !== undefined) {
    return {
      value: input.tokensPerSec,
      metricName: 'throughput_tokens_per_sec',
      sampleCount,
      rawSamples,
    };
  }
  if (stats) {
    return {
      value: stats.mean,
      metricName: 'throughput_ops_per_sec',
      sampleCount,
      rawSamples,
    };
  }
  return undefined;
}

interface NormalizedCorrectness {
  passRate: number;
  failedChecks: number;
  totalChecks?: number;
}

function normalizeCorrectnessInput(snapshot: PerformanceSnapshot): NormalizedCorrectness | undefined {
  const c = snapshot.correctness;
  if (typeof c === 'boolean') {
    return {
      passRate: c ? 1.0 : 0.0,
      failedChecks: c ? 0 : 1,
      totalChecks: 1,
    };
  }
  if (typeof c === 'number') {
    return {
      passRate: c,
      failedChecks: c < 1.0 ? 1 : 0,
    };
  }
  if (c && typeof c === 'object') {
    let passRate = c.passRate;
    const totalChecks = c.totalChecks;
    const passedChecks = c.passedChecks;
    const failedChecks =
      c.failedChecks ??
      (totalChecks !== undefined && passedChecks !== undefined
        ? Math.max(0, totalChecks - passedChecks)
        : c.allPassed === false
          ? 1
          : 0);

    if (passRate === undefined) {
      if (totalChecks !== undefined && totalChecks > 0 && passedChecks !== undefined) {
        passRate = passedChecks / totalChecks;
      } else if (totalChecks !== undefined && totalChecks > 0 && c.failedChecks !== undefined) {
        passRate = (totalChecks - c.failedChecks) / totalChecks;
      } else if (c.allPassed !== undefined) {
        passRate = c.allPassed ? 1.0 : 0.0;
      } else {
        passRate = failedChecks > 0 ? 0.0 : 1.0;
      }
    }
    return {
      passRate,
      failedChecks,
      totalChecks,
    };
  }

  if (
    snapshot.passRate !== undefined ||
    snapshot.failedChecks !== undefined ||
    snapshot.totalChecks !== undefined
  ) {
    const failed = snapshot.failedChecks ?? 0;
    const total = snapshot.totalChecks;
    const passRate =
      snapshot.passRate ??
      (total !== undefined && total > 0 ? (total - failed) / total : failed > 0 ? 0.0 : 1.0);
    return {
      passRate,
      failedChecks: failed,
      totalChecks: total,
    };
  }

  return undefined;
}

/**
 * Evaluates a candidate performance snapshot against a baseline performance snapshot
 * using statistical comparison, percentile shift checks, noise floors, and strict correctness gates.
 */
export function evaluatePerformanceGate(
  baseline: PerformanceSnapshot,
  candidate: PerformanceSnapshot,
  options: PerformanceGateOptions = {},
): PerformanceGateVerdict {
  const gate = new PerformanceRegressionGate(options);
  return gate.evaluate(baseline, candidate);
}

/**
 * Latency, Memory, Throughput, and Correctness Regression Gate.
 */
export class PerformanceRegressionGate {
  public readonly options: Required<PerformanceGateOptions>;

  constructor(options: PerformanceGateOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  public evaluate(
    baseline: PerformanceSnapshot,
    candidate: PerformanceSnapshot,
  ): PerformanceGateVerdict {
    const checks: PerformanceGateCheck[] = [];
    const blockingFailures: string[] = [];
    const warnings: string[] = [];

    // 1. Correctness Evaluation (Strict priority: zero regression allowed)
    const baseCorr = normalizeCorrectnessInput(baseline);
    const candCorr = normalizeCorrectnessInput(candidate);
    if (baseCorr || candCorr) {
      const baseRate = baseCorr?.passRate ?? 1.0;
      const candRate = candCorr?.passRate ?? 1.0;
      const failedChecks = candCorr?.failedChecks ?? 0;
      const requiredRate = Math.max(this.options.minPassRate, baseRate);
      const deltaPercent =
        baseRate > 0 ? ((candRate - baseRate) / baseRate) * 100 : (candRate - baseRate) * 100;
      const thresholdPercent =
        baseRate > 0 ? ((requiredRate - baseRate) / baseRate) * 100 : 0;

      const regressed =
        candRate < requiredRate - 1e-9 ||
        candRate < baseRate - 1e-9 ||
        failedChecks > (baseCorr?.failedChecks ?? 0);

      if (regressed) {
        const reason = `CORRECTNESS_REGRESSION: Candidate pass rate ${(candRate * 100).toFixed(2)}% (failedChecks=${failedChecks}) dropped below required ${(requiredRate * 100).toFixed(2)}% (baseline ${(baseRate * 100).toFixed(2)}%)`;
        checks.push({
          metric: 'correctness_pass_rate',
          category: 'correctness',
          baselineValue: baseRate,
          candidateValue: candRate,
          deltaPercent: Number(deltaPercent.toFixed(4)),
          thresholdPercent: Number(thresholdPercent.toFixed(4)),
          status: 'FAIL',
          reason,
        });
        blockingFailures.push(reason);
      } else {
        checks.push({
          metric: 'correctness_pass_rate',
          category: 'correctness',
          baselineValue: baseRate,
          candidateValue: candRate,
          deltaPercent: Number(deltaPercent.toFixed(4)),
          thresholdPercent: Number(thresholdPercent.toFixed(4)),
          status: 'PASS',
          reason: `Correctness pass rate ${(candRate * 100).toFixed(2)}% meets required ${(requiredRate * 100).toFixed(2)}%`,
        });
      }
    }

    // 2. Latency Evaluation (primary snapshot.latency and named snapshot.latencies)
    const baseLat = normalizeLatencyInput(baseline.latency, baseline.samples);
    const candLat = normalizeLatencyInput(candidate.latency, candidate.samples);
    if (baseLat && candLat) {
      this.evaluateLatencyPair('latency', baseLat, candLat, checks, blockingFailures, warnings);
    }

    if (baseline.latencies || candidate.latencies) {
      const keys = new Set([
        ...Object.keys(baseline.latencies ?? {}),
        ...Object.keys(candidate.latencies ?? {}),
      ]);
      for (const key of keys) {
        const b = normalizeLatencyInput(baseline.latencies?.[key], baseline.samples);
        const c = normalizeLatencyInput(candidate.latencies?.[key], candidate.samples);
        if (b && c) {
          this.evaluateLatencyPair(`latency.${key}`, b, c, checks, blockingFailures, warnings);
        }
      }
    }

    // 3. Memory Evaluation (heapDeltaMB and rssMB)
    const baseMem = normalizeMemoryInput(baseline.memory, baseline.samples);
    const candMem = normalizeMemoryInput(candidate.memory, candidate.samples);
    if (baseMem && candMem) {
      this.evaluateMemoryPair(baseMem, candMem, checks, blockingFailures, warnings);
    }

    // 4. Throughput Evaluation
    const baseTp = normalizeThroughputInput(baseline.throughput, baseline.samples);
    const candTp = normalizeThroughputInput(candidate.throughput, candidate.samples);
    if (baseTp && candTp) {
      this.evaluateThroughputPair(baseTp, candTp, checks, blockingFailures, warnings);
    }

    // 5. Determine overall verdict
    const hasFail = checks.some((c) => c.status === 'FAIL') || blockingFailures.length > 0;
    const hasInconclusive = checks.some((c) => c.status === 'INCONCLUSIVE');

    let status: PerformanceGateStatus;
    let passed: boolean;
    let summary: string;

    if (hasFail) {
      status = 'FAIL';
      passed = false;
      summary = `FAIL: Performance gate blocked by ${blockingFailures.length} failure(s): ${blockingFailures.join('; ')}`;
    } else if (hasInconclusive || checks.length === 0) {
      status = 'INCONCLUSIVE';
      passed = false;
      const incReasons = checks
        .filter((c) => c.status === 'INCONCLUSIVE')
        .map((c) => `${c.metric}: ${c.reason}`);
      summary =
        incReasons.length > 0
          ? `INCONCLUSIVE: Insufficient sample evidence to verify performance: ${incReasons.join('; ')}`
          : 'INCONCLUSIVE: No performance metrics provided for evaluation';
    } else {
      status = 'PASS';
      passed = true;
      summary = `PASS: All ${checks.length} performance gate check(s) passed within statistical thresholds.`;
    }

    return {
      passed,
      status,
      checks,
      BlockingFailures: blockingFailures,
      blockingFailures,
      warnings,
      summary,
    };
  }

  private evaluateLatencyPair(
    prefix: string,
    base: NormalizedLatency,
    cand: NormalizedLatency,
    checks: PerformanceGateCheck[],
    blockingFailures: string[],
    warnings: string[],
  ): void {
    const minSamples = this.options.minSamples;
    const thresholdRatio = this.options.maxLatencyRegressionRatio;
    const thresholdPercent = Number((thresholdRatio * 100).toFixed(4));
    const noiseFloorMs = this.options.minLatencyNoiseFloorMs;

    // Statistical tests when raw samples are available on both sides
    const hasRawSamples =
      Array.isArray(base.rawSamples) &&
      Array.isArray(cand.rawSamples) &&
      base.rawSamples.length >= minSamples &&
      cand.rawSamples.length >= minSamples;

    const welch = hasRawSamples
      ? welchTTest(base.rawSamples!, cand.rawSamples!, this.options.alpha, 'HIGHER_IS_WORSE')
      : undefined;
    const mw = hasRawSamples
      ? mannWhitneyUTest(base.rawSamples!, cand.rawSamples!, this.options.alpha, 'HIGHER_IS_WORSE')
      : undefined;

    const percentiles: Array<{ label: string; baseVal: number; candVal: number }> = [];
    if (Number.isFinite(base.p50Ms) && Number.isFinite(cand.p50Ms)) {
      percentiles.push({ label: `${prefix}_p50_ms`, baseVal: base.p50Ms, candVal: cand.p50Ms });
    }
    if (Number.isFinite(base.p95Ms) && Number.isFinite(cand.p95Ms)) {
      percentiles.push({ label: `${prefix}_p95_ms`, baseVal: base.p95Ms, candVal: cand.p95Ms });
    }

    for (const { label, baseVal, candVal } of percentiles) {
      const absDelta = candVal - baseVal;
      const deltaRatio = baseVal > 0 ? absDelta / baseVal : absDelta > 0 ? Infinity : 0;
      const deltaPercent = Number((deltaRatio * 100).toFixed(4));

      if (base.sampleCount < minSamples || cand.sampleCount < minSamples) {
        const reason = `INSUFFICIENT_SAMPLES: ${label} has baseline=${base.sampleCount}, candidate=${cand.sampleCount} samples (minSamples=${minSamples})`;
        checks.push({
          metric: label,
          category: 'latency',
          baselineValue: baseVal,
          candidateValue: candVal,
          deltaPercent,
          thresholdPercent,
          status: 'INCONCLUSIVE',
          reason,
        });
        warnings.push(reason);
        continue;
      }

      const exceedsThreshold = deltaRatio > thresholdRatio + 1e-9;
      const exceedsNoiseFloor = absDelta > noiseFloorMs + 1e-9;

      if (exceedsThreshold && exceedsNoiseFloor) {
        // When raw samples exist and this is a p95 check where p50 did not regress and
        // neither Welch's t-test nor Mann-Whitney U detects a systematic shift, treat a single-sample
        // tail outlier spike as a non-blocking warning rather than a systematic regression.
        const isP95OnlySpike =
          hasRawSamples &&
          label.endsWith('_p95_ms') &&
          !welch!.significantRegression &&
          !mw!.significantRegression &&
          cand.p50Ms - base.p50Ms <= Math.max(noiseFloorMs, base.p50Ms * thresholdRatio);

        if (isP95OnlySpike) {
          const reason = `NOISY_SPIKE_IGNORED: ${label} increased by ${deltaPercent.toFixed(2)}% (+${absDelta.toFixed(2)}ms), but Mann-Whitney (p=${mw!.pValueOneSided.toFixed(3)}) and Welch t-test (p=${welch!.pValueOneSided.toFixed(3)}) confirm no systematic shift`;
          checks.push({
            metric: label,
            category: 'latency',
            baselineValue: baseVal,
            candidateValue: candVal,
            deltaPercent,
            thresholdPercent,
            status: 'PASS',
            reason,
          });
          warnings.push(reason);
        } else {
          const statSuffix = hasRawSamples
            ? ` [Welch t=${welch!.tStatistic.toFixed(2)}, p=${welch!.pValueOneSided.toFixed(4)}; Mann-Whitney U=${mw!.uStatistic.toFixed(1)}, p=${mw!.pValueOneSided.toFixed(4)}]`
            : '';
          const reason = `LATENCY_REGRESSION: ${label} regressed by ${deltaPercent.toFixed(2)}% (+${absDelta.toFixed(2)}ms from ${baseVal.toFixed(2)}ms to ${candVal.toFixed(2)}ms), exceeding max threshold ${thresholdPercent.toFixed(2)}% and noise floor ${noiseFloorMs.toFixed(2)}ms${statSuffix}`;
          checks.push({
            metric: label,
            category: 'latency',
            baselineValue: baseVal,
            candidateValue: candVal,
            deltaPercent,
            thresholdPercent,
            status: 'FAIL',
            reason,
          });
          blockingFailures.push(reason);
        }
      } else if (exceedsThreshold && !exceedsNoiseFloor) {
        const reason = `WITHIN_NOISE_FLOOR: ${label} delta +${absDelta.toFixed(2)}ms (${deltaPercent.toFixed(2)}%) is within noise floor ${noiseFloorMs.toFixed(2)}ms`;
        checks.push({
          metric: label,
          category: 'latency',
          baselineValue: baseVal,
          candidateValue: candVal,
          deltaPercent,
          thresholdPercent,
          status: 'PASS',
          reason,
        });
      } else {
        const reason = `${label} delta ${deltaPercent >= 0 ? '+' : ''}${deltaPercent.toFixed(2)}% (${candVal.toFixed(2)}ms vs baseline ${baseVal.toFixed(2)}ms) is within ${thresholdPercent.toFixed(2)}% threshold`;
        checks.push({
          metric: label,
          category: 'latency',
          baselineValue: baseVal,
          candidateValue: candVal,
          deltaPercent,
          thresholdPercent,
          status: 'PASS',
          reason,
        });
      }
    }
  }

  private evaluateMemoryPair(
    base: NormalizedMemory,
    cand: NormalizedMemory,
    checks: PerformanceGateCheck[],
    blockingFailures: string[],
    warnings: string[],
  ): void {
    const minSamples = this.options.minSamples;
    const thresholdRatio = this.options.maxMemoryGrowthRatio;
    const thresholdPercent = Number((thresholdRatio * 100).toFixed(4));
    const noiseFloorMB = this.options.minMemoryNoiseFloorMB;

    const metrics: Array<{ label: string; baseVal?: number; candVal?: number }> = [
      { label: 'memory_heap_delta_mb', baseVal: base.heapDeltaMB, candVal: cand.heapDeltaMB },
      { label: 'memory_rss_mb', baseVal: base.rssMB, candVal: cand.rssMB },
    ];

    for (const { label, baseVal, candVal } of metrics) {
      if (baseVal === undefined || candVal === undefined || !Number.isFinite(baseVal) || !Number.isFinite(candVal)) {
        continue;
      }

      const absDelta = candVal - baseVal;
      const deltaRatio = baseVal > 0 ? absDelta / baseVal : absDelta > 0 ? Infinity : 0;
      const deltaPercent = Number((deltaRatio * 100).toFixed(4));

      if (base.sampleCount < minSamples || cand.sampleCount < minSamples) {
        const reason = `INSUFFICIENT_SAMPLES: ${label} has baseline=${base.sampleCount}, candidate=${cand.sampleCount} samples (minSamples=${minSamples})`;
        checks.push({
          metric: label,
          category: 'memory',
          baselineValue: baseVal,
          candidateValue: candVal,
          deltaPercent,
          thresholdPercent,
          status: 'INCONCLUSIVE',
          reason,
        });
        warnings.push(reason);
        continue;
      }

      const exceedsThreshold = deltaRatio > thresholdRatio + 1e-9;
      const exceedsNoiseFloor = absDelta > noiseFloorMB + 1e-9;

      if (exceedsThreshold && exceedsNoiseFloor) {
        const reason = `MEMORY_REGRESSION: ${label} grew by ${deltaPercent.toFixed(2)}% (+${absDelta.toFixed(2)}MB from ${baseVal.toFixed(2)}MB to ${candVal.toFixed(2)}MB), exceeding max growth ${thresholdPercent.toFixed(2)}% and noise floor ${noiseFloorMB.toFixed(2)}MB`;
        checks.push({
          metric: label,
          category: 'memory',
          baselineValue: baseVal,
          candidateValue: candVal,
          deltaPercent,
          thresholdPercent,
          status: 'FAIL',
          reason,
        });
        blockingFailures.push(reason);
      } else if (exceedsThreshold && !exceedsNoiseFloor) {
        const reason = `WITHIN_NOISE_FLOOR: ${label} growth +${absDelta.toFixed(2)}MB (${deltaPercent.toFixed(2)}%) is within noise floor ${noiseFloorMB.toFixed(2)}MB`;
        checks.push({
          metric: label,
          category: 'memory',
          baselineValue: baseVal,
          candidateValue: candVal,
          deltaPercent,
          thresholdPercent,
          status: 'PASS',
          reason,
        });
      } else {
        const reason = `${label} delta ${deltaPercent >= 0 ? '+' : ''}${deltaPercent.toFixed(2)}% (${candVal.toFixed(2)}MB vs baseline ${baseVal.toFixed(2)}MB) is within ${thresholdPercent.toFixed(2)}% threshold`;
        checks.push({
          metric: label,
          category: 'memory',
          baselineValue: baseVal,
          candidateValue: candVal,
          deltaPercent,
          thresholdPercent,
          status: 'PASS',
          reason,
        });
      }
    }
  }

  private evaluateThroughputPair(
    base: NormalizedThroughput,
    cand: NormalizedThroughput,
    checks: PerformanceGateCheck[],
    blockingFailures: string[],
    warnings: string[],
  ): void {
    const minSamples = this.options.minSamples;
    const thresholdRatio = this.options.maxThroughputRegressionRatio;
    const thresholdPercent = Number((-thresholdRatio * 100).toFixed(4));
    const label = cand.metricName || base.metricName || 'throughput_ops_per_sec';

    const absDelta = cand.value - base.value;
    const deltaRatio = base.value > 0 ? absDelta / base.value : 0;
    const deltaPercent = Number((deltaRatio * 100).toFixed(4));

    if (base.sampleCount < minSamples || cand.sampleCount < minSamples) {
      const reason = `INSUFFICIENT_SAMPLES: ${label} has baseline=${base.sampleCount}, candidate=${cand.sampleCount} samples (minSamples=${minSamples})`;
      checks.push({
        metric: label,
        category: 'throughput',
        baselineValue: base.value,
        candidateValue: cand.value,
        deltaPercent,
        thresholdPercent,
        status: 'INCONCLUSIVE',
        reason,
      });
      warnings.push(reason);
      return;
    }

    const dropRatio = base.value > 0 ? (base.value - cand.value) / base.value : 0;
    if (dropRatio > thresholdRatio + 1e-9) {
      const reason = `THROUGHPUT_REGRESSION: ${label} dropped by ${(dropRatio * 100).toFixed(2)}% (from ${base.value.toFixed(2)} to ${cand.value.toFixed(2)}), exceeding max drop ${(thresholdRatio * 100).toFixed(2)}%`;
      checks.push({
        metric: label,
        category: 'throughput',
        baselineValue: base.value,
        candidateValue: cand.value,
        deltaPercent,
        thresholdPercent,
        status: 'FAIL',
        reason,
      });
      blockingFailures.push(reason);
    } else {
      const reason = `${label} delta ${deltaPercent >= 0 ? '+' : ''}${deltaPercent.toFixed(2)}% (${cand.value.toFixed(2)} vs baseline ${base.value.toFixed(2)}) meets throughput threshold`;
      checks.push({
        metric: label,
        category: 'throughput',
        baselineValue: base.value,
        candidateValue: cand.value,
        deltaPercent,
        thresholdPercent,
        status: 'PASS',
        reason,
      });
    }
  }
}
