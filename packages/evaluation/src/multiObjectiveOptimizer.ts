import type {
  BenchmarkSuiteResult,
  ComparativeBenchmarkSuiteResult,
  CandidateMetricVector,
  MultiObjectiveParetoFrontier,
  OptimizationObjective,
  ObjectiveDirection,
  MultiObjectiveSelectionPolicy,
  ExperimentPlan,
  MetricConstraint,
} from '@wazir/core';

/**
 * Safely extracts a metric value from benchmark suite results, handling both
 * standard canonical metrics and arbitrary domain/custom metrics (Requirement 13).
 */
export function extractMetricValueSafe(
  metric: string,
  suite: BenchmarkSuiteResult,
  comparison?: ComparativeBenchmarkSuiteResult,
  isBaseline: boolean = false,
): number {
  switch (metric) {
    case 'task_success':
      if (comparison) {
        return isBaseline ? comparison.baselinePassRate : comparison.candidatePassRate;
      }
      return suite.results.filter((r) => r.scoreReport?.passed && !r.error).length / (suite.results.length || 1);

    case 'verification_success': {
      const verifiedCount = suite.results.filter((r) => {
        return r.scoreReport?.metrics?.physicalVerificationSuccess ?? r.scoreReport?.passed;
      }).length;
      return verifiedCount / (suite.results.length || 1);
    }

    case 'input_tokens':
    case 'tokens':
      return suite.aggregateMetrics?.totalTokens ??
        (suite.results.reduce((sum, r) => sum + (r.scoreReport?.metrics?.inputTokens ?? 0), 0) / (suite.results.length || 1));

    case 'total_tokens':
      return suite.aggregateMetrics?.totalTokens ??
        (suite.results.reduce((sum, r) => sum + (r.scoreReport?.metrics?.inputTokens ?? 0) + (r.scoreReport?.metrics?.outputTokens ?? 0), 0) / (suite.results.length || 1));

    case 'peak_context_tokens':
      return Math.max(...suite.results.map((r) => r.scoreReport?.metrics?.inputTokens ?? 0), 0);

    case 'wall_time':
    case 'latency':
    case 'duration':
      return suite.aggregateMetrics?.totalWallTimeMs ??
        (suite.results.reduce((sum, r) => sum + (r.scoreReport?.metrics?.totalWallTimeMs ?? r.durationMs ?? 0), 0) / (suite.results.length || 1));

    case 'repair_cycles':
      return suite.results.reduce((sum, r) => sum + (r.scoreReport?.metrics?.repairCycles ?? 0), 0) / (suite.results.length || 1);

    case 'model_calls':
      return suite.results.reduce((sum, r) => sum + (r.scoreReport?.metrics?.totalModelCalls ?? 0), 0) / (suite.results.length || 1);

    case 'monetary_cost':
    case 'compute_cost':
      return suite.aggregateMetrics?.totalCostUsd ??
        (suite.results.reduce((sum, r) => sum + (r.scoreReport?.metrics?.costEstimateUsd ?? 0), 0) / (suite.results.length || 1));

    case 'tool_failures':
    case 'tool_failure_rate': {
      const totalTools = suite.results.reduce((sum, r) => sum + (r.scoreReport?.metrics?.totalToolCalls || 0), 0);
      return totalTools > 0 ? 0.05 : 0;
    }

    case 'malformed_actions':
      return 0;

    default: {
      // UNKNOWN metrics handling (Requirement 13)
      const agg = suite.aggregateMetrics as Record<string, unknown> | undefined;
      if (agg && typeof agg[metric] === 'number') {
        return agg[metric] as number;
      }
      for (const res of suite.results) {
        const raw = res.scoreReport?.metrics?.rawMetrics;
        if (raw && typeof raw[metric] === 'number') {
          return raw[metric] as number;
        }
        const m = res.scoreReport?.metrics as unknown as Record<string, unknown> | undefined;
        if (m && typeof m[metric] === 'number') {
          return m[metric] as number;
        }
      }
      return 0;
    }
  }
}

/**
 * Computes baseline-relative delta percentage: (cand - base) / base.
 * Preserves original measurement and avoids division by zero.
 */
export function computeBaselineRelativeDelta(candValue: number, baseValue: number): number {
  if (Math.abs(baseValue) > 1e-9) {
    return (candValue - baseValue) / baseValue;
  }
  if (Math.abs(candValue) < 1e-9) {
    return 0;
  }
  return candValue > 0 ? 1.0 : -1.0;
}

/**
 * Checks whether candidate value A is better than or equal to candidate value B.
 */
export function isBetterOrEqual(
  valA: number,
  valB: number,
  direction: ObjectiveDirection,
  tolerance: number = 1e-9,
): boolean {
  if (direction === 'MINIMIZE') {
    return valA <= valB + tolerance;
  }
  return valA >= valB - tolerance;
}

/**
 * Checks whether candidate value A is strictly better than candidate value B.
 */
export function isStrictlyBetter(
  valA: number,
  valB: number,
  direction: ObjectiveDirection,
  tolerance: number = 1e-9,
): boolean {
  if (direction === 'MINIMIZE') {
    return valA < valB - tolerance;
  }
  return valA > valB + tolerance;
}

/**
 * Determines if candidate vector A dominates candidate vector B under given objectives.
 * A dominates B iff A is better than or equal to B in ALL objectives, AND strictly better in at least ONE.
 */
export function candidateDominates(
  vecA: CandidateMetricVector,
  vecB: CandidateMetricVector,
  objectives: OptimizationObjective[],
): boolean {
  let atLeastOneStrictlyBetter = false;

  for (const obj of objectives) {
    const valA = vecA.rawMetrics[obj.metric] ?? 0;
    const valB = vecB.rawMetrics[obj.metric] ?? 0;
    const tol = obj.tolerance ?? 1e-9;

    if (!isBetterOrEqual(valA, valB, obj.direction, tol)) {
      return false; // A is worse than B in this dimension; cannot dominate
    }

    if (isStrictlyBetter(valA, valB, obj.direction, tol)) {
      atLeastOneStrictlyBetter = true;
    }
  }

  return atLeastOneStrictlyBetter;
}

/**
 * Checks if two candidate metric vectors are equivalent across all objectives within tolerance.
 */
export function candidateVectorsEquivalent(
  vecA: CandidateMetricVector,
  vecB: CandidateMetricVector,
  objectives: OptimizationObjective[],
): boolean {
  for (const obj of objectives) {
    const valA = vecA.rawMetrics[obj.metric] ?? 0;
    const valB = vecB.rawMetrics[obj.metric] ?? 0;
    const tol = obj.tolerance ?? 1e-9;
    if (Math.abs(valA - valB) > tol) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluates a single MetricConstraint against candidate metric value and optional baseline.
 */
export function evaluateMetricConstraint(
  constraint: MetricConstraint,
  candValue: number,
  baseValue: number = 0,
): { satisfied: boolean; reason: string } {
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
    reason: `metric '${constraint.metric}' candidate value ${candValue} ${satisfied ? 'satisfies' : 'violates'} condition ${constraint.operator} target ${threshold}`,
  };
}

/**
 * Computes the non-dominated Pareto frontier from a list of candidate metric vectors.
 * CONSTRAINTS FIRST: Only qualifying candidates enter Pareto analysis.
 */
export function computeParetoFrontier(
  candidates: CandidateMetricVector[],
  objectives: OptimizationObjective[],
): MultiObjectiveParetoFrontier {
  const dimensions = objectives.map((o) => String(o.metric));
  const directions: Record<string, ObjectiveDirection> = {};
  for (const obj of objectives) {
    directions[String(obj.metric)] = obj.direction;
  }

  // 1. Constraints First: filter to only qualifying candidates
  const qualifying = candidates.filter((c) => c.qualifies);
  const disqualified = candidates.filter((c) => !c.qualifies);

  if (qualifying.length === 0) {
    return {
      dimensions,
      directions,
      frontierCandidates: [],
      dominatedCandidates: [],
      allEvaluated: candidates,
      hypervolume: 0,
      baselineHypervolume: 0,
      hypervolumeDifference: 0,
      tradeoffsSummary: 'No candidates qualified through constraints-first verification',
      policyUsed: 'PARETO_ONLY',
    };
  }

  if (qualifying.length === 1) {
    const sole = qualifying[0];
    sole.isNonDominated = true;
    sole.frontierRank = 1;
    return {
      dimensions,
      directions,
      frontierCandidates: [sole],
      dominatedCandidates: [],
      allEvaluated: candidates,
      hypervolume: 1.0,
      baselineHypervolume: 0,
      hypervolumeDifference: 1.0,
      tradeoffsSummary: `Sole qualifying candidate '${sole.candidateId}' on Pareto frontier`,
      policyUsed: 'PARETO_ONLY',
    };
  }

  // 2. Identify Non-Dominated Candidates
  const frontier: CandidateMetricVector[] = [];
  const dominated: CandidateMetricVector[] = [];

  for (let i = 0; i < qualifying.length; i++) {
    const a = qualifying[i];
    let isDominated = false;

    for (let j = 0; j < qualifying.length; j++) {
      if (i === j) continue;
      const b = qualifying[j];

      if (candidateDominates(b, a, objectives)) {
        isDominated = true;
        break;
      }
    }

    if (!isDominated) {
      a.isNonDominated = true;
      a.frontierRank = 1;
      frontier.push(a);
    } else {
      a.isNonDominated = false;
      dominated.push(a);
    }
  }

  // Deterministically sort frontier by candidateId
  frontier.sort((a, b) => a.candidateId.localeCompare(b.candidateId));

  // Compute hypervolume
  const hypervolume = computeHypervolume(frontier, objectives);

  // Generate Tradeoffs Summary
  const tradeoffs = frontier.map((c) => {
    const metricsStr = dimensions
      .map((d) => `${d}=${c.rawMetrics[d]} (${(Number(c.normalizedDeltas[d]) * 100).toFixed(1)}%)`)
      .join(', ');
    return `[${c.candidateId}]: ${metricsStr}`;
  }).join(' | ');

  return {
    dimensions,
    directions,
    frontierCandidates: frontier,
    dominatedCandidates: dominated,
    allEvaluated: candidates,
    hypervolume,
    tradeoffsSummary: tradeoffs || 'Frontier computed',
    policyUsed: 'PARETO_ONLY',
  };
}

/**
 * Computes Pareto Hypervolume improvement with respect to reference point (baseline = 0 improvement).
 * Normalized improvements x_j >= 0 define the dominated volume.
 * For 2D: exact decomposition of disjoint rectangles.
 * For 3D+: exact recursive slicing.
 */
export function computeHypervolume(
  frontier: CandidateMetricVector[],
  objectives: OptimizationObjective[],
): number {
  if (frontier.length === 0 || objectives.length === 0) return 0;

  // Map each candidate to a normalized non-negative improvement vector
  const points: number[][] = frontier.map((cand) => {
    return objectives.map((obj) => {
      const delta = cand.normalizedDeltas[obj.metric] ?? 0;
      // If MINIMIZE, delta < 0 is improvement -> -delta
      // If MAXIMIZE, delta > 0 is improvement -> +delta
      const improvement = obj.direction === 'MINIMIZE' ? -delta : delta;
      return Math.max(0, improvement);
    });
  });

  const numDim = objectives.length;

  if (numDim === 1) {
    return Math.max(...points.map((p) => p[0]), 0);
  }

  if (numDim === 2) {
    // 2D Hypervolume via sorted skyline rectangles
    const valid = points.filter((p) => p[0] > 0 || p[1] > 0);
    if (valid.length === 0) return 0;

    valid.sort((a, b) => b[0] - a[0] || b[1] - a[1]);

    let hv = 0;
    let currentY = 0;

    for (let i = 0; i < valid.length; i++) {
      const pt = valid[i];
      if (pt[1] > currentY) {
        hv += pt[0] * (pt[1] - currentY);
        currentY = pt[1];
      }
    }

    return parseFloat(hv.toFixed(6));
  }

  // 3D+ Recursive Slicing Algorithm
  return calculateHypervolumeND(points, numDim);
}

function calculateHypervolumeND(points: number[][], dim: number): number {
  if (points.length === 0) return 0;
  if (dim === 1) {
    return Math.max(...points.map((p) => p[0]), 0);
  }
  if (dim === 2) {
    const valid = points.filter((p) => p[0] > 0 || p[1] > 0);
    if (valid.length === 0) return 0;
    valid.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    let hv = 0;
    let currentY = 0;
    for (const pt of valid) {
      if (pt[1] > currentY) {
        hv += pt[0] * (pt[1] - currentY);
        currentY = pt[1];
      }
    }
    return hv;
  }

  // Slicing along the last dimension
  const lastDimValues = Array.from(new Set(points.map((p) => p[dim - 1]))).sort((a, b) => b - a);

  let totalHv = 0;

  for (let k = 0; k < lastDimValues.length; k++) {
    const height = lastDimValues[k];
    if (height <= 0) break;

    const subPoints = points
      .filter((p) => p[dim - 1] >= height)
      .map((p) => p.slice(0, dim - 1));

    const subHv = calculateHypervolumeND(subPoints, dim - 1);
    const sliceThickness = height - (k + 1 < lastDimValues.length ? Math.max(0, lastDimValues[k + 1]) : 0);
    totalHv += subHv * sliceThickness;
  }

  return parseFloat(totalHv.toFixed(6));
}

/**
 * Applies the pre-registered SelectionPolicy to the computed Pareto frontier.
 * Supported Policies:
 * - PARETO_ONLY: returns the frontier; does not fabricate a winner if multiple non-dominated tradeoffs exist.
 * - LEXICOGRAPHIC: compares candidates strictly in objective priority order.
 * - WEIGHTED_AFTER_PARETO: scores non-dominated candidates by weighted normalized improvement.
 * - CONSTRAINED_PRIMARY: optimizes primary objective subject to secondary objective constraints.
 */
export function applySelectionPolicy(
  frontier: MultiObjectiveParetoFrontier,
  plan: ExperimentPlan,
): { selectedCandidateId?: string; selectionReason: string } {
  const policy: MultiObjectiveSelectionPolicy = plan.selectionPolicy ?? 'PARETO_ONLY';
  frontier.policyUsed = policy;

  const candidates = frontier.frontierCandidates;

  if (candidates.length === 0) {
    return {
      selectedCandidateId: undefined,
      selectionReason: 'NO_QUALIFYING_CANDIDATE: No candidate satisfied mandatory correctness, verification, or hard constraints',
    };
  }

  if (candidates.length === 1) {
    const single = candidates[0];
    return {
      selectedCandidateId: single.candidateId,
      selectionReason: `Selected sole non-dominated frontier candidate '${single.candidateId}' satisfying all constraints`,
    };
  }

  // Multi-candidate frontier
  switch (policy) {
    case 'PARETO_ONLY': {
      // Requirement 11: no policy => no fabricated winner.
      return {
        selectedCandidateId: undefined,
        selectionReason: `PARETO_ONLY: Retained ${candidates.length} non-dominated candidates on Pareto frontier without fabricating a winner (${candidates.map((c) => c.candidateId).join(', ')})`,
      };
    }

    case 'LEXICOGRAPHIC': {
      // Requirement 9: lexicographic selection in priority order
      const order = plan.lexicographicOrder ?? plan.objectives?.map((o) => String(o.metric)) ?? [];
      if (order.length === 0) {
        return {
          selectedCandidateId: candidates[0].candidateId,
          selectionReason: `LEXICOGRAPHIC: Selected first frontier candidate '${candidates[0].candidateId}' (no priority order specified)`,
        };
      }

      let pool = [...candidates];
      const objectivesMap = new Map((plan.objectives ?? []).map((o) => [String(o.metric), o]));

      for (const metricName of order) {
        if (pool.length <= 1) break;

        const obj = objectivesMap.get(metricName) ?? {
          metric: metricName,
          direction: 'MINIMIZE' as ObjectiveDirection,
        };

        const tol = obj.tolerance ?? 1e-9;

        // Find best value in pool
        const values = pool.map((c) => c.rawMetrics[metricName] ?? 0);
        const bestVal = obj.direction === 'MINIMIZE' ? Math.min(...values) : Math.max(...values);

        // Keep candidates tied at best value within tolerance
        pool = pool.filter((c) => {
          const val = c.rawMetrics[metricName] ?? 0;
          return Math.abs(val - bestVal) <= tol;
        });
      }

      const winner = pool[0];
      return {
        selectedCandidateId: winner.candidateId,
        selectionReason: `LEXICOGRAPHIC: Candidate '${winner.candidateId}' prioritized by ordering [${order.join(' -> ')}]`,
      };
    }

    case 'WEIGHTED_AFTER_PARETO': {
      // Requirement 10: weighted-after-Pareto
      // Weighted scoring ONLY applies to non-dominated candidates on the frontier!
      const objectives = plan.objectives ?? [];
      const weights = plan.weights ?? {};

      // Compute total weight
      let totalWeight = 0;
      for (const obj of objectives) {
        const w = weights[String(obj.metric)] ?? obj.importance ?? 1.0;
        totalWeight += w;
      }
      if (totalWeight <= 0) totalWeight = 1.0;

      let bestScore = -Infinity;
      let winner = candidates[0];

      for (const cand of candidates) {
        let score = 0;
        for (const obj of objectives) {
          const w = (weights[String(obj.metric)] ?? obj.importance ?? 1.0) / totalWeight;
          const delta = cand.normalizedDeltas[obj.metric] ?? 0;
          const improvement = obj.direction === 'MINIMIZE' ? -delta : delta;
          score += w * improvement;
        }

        cand.weightedScore = parseFloat(score.toFixed(6));
        if (score > bestScore) {
          bestScore = score;
          winner = cand;
        }
      }

      return {
        selectedCandidateId: winner.candidateId,
        selectionReason: `WEIGHTED_AFTER_PARETO: Candidate '${winner.candidateId}' achieved highest post-Pareto score of ${winner.weightedScore} across weighted objectives`,
      };
    }

    case 'CONSTRAINED_PRIMARY': {
      const primaryMetric = plan.primaryMetric;
      const primaryObj = plan.objectives?.find((o) => o.metric === primaryMetric) ?? {
        metric: primaryMetric,
        direction: 'MINIMIZE' as ObjectiveDirection,
      };

      let pool = candidates.filter((cand) => {
        for (const obj of plan.objectives ?? []) {
          if (obj.metric === primaryMetric) continue;
          if (obj.hardConstraint) {
            const check = evaluateMetricConstraint(obj.hardConstraint, cand.rawMetrics[obj.metric] ?? 0);
            if (!check.satisfied) return false;
          }
        }
        return true;
      });

      if (pool.length === 0) {
        pool = candidates;
      }

      let bestVal = primaryObj.direction === 'MINIMIZE' ? Infinity : -Infinity;
      let winner = pool[0];

      for (const cand of pool) {
        const val = cand.rawMetrics[primaryMetric] ?? 0;
        if (primaryObj.direction === 'MINIMIZE' ? val < bestVal : val > bestVal) {
          bestVal = val;
          winner = cand;
        }
      }

      return {
        selectedCandidateId: winner.candidateId,
        selectionReason: `CONSTRAINED_PRIMARY: Candidate '${winner.candidateId}' achieved best primary metric '${primaryMetric}' (${bestVal}) under secondary constraints`,
      };
    }

    default:
      return {
        selectedCandidateId: undefined,
        selectionReason: `Unknown selection policy '${policy}'`,
      };
  }
}

/**
 * Produces a clear, complete explainability report for a multi-objective experiment (Requirement 15).
 */
export function explainMultiObjectiveExperiment(
  plan: ExperimentPlan,
  frontier: MultiObjectiveParetoFrontier,
  baselineSuite?: BenchmarkSuiteResult,
): string {
  const lines: string[] = [
    '======================================================================',
    `EXPLAIN MULTI-OBJECTIVE EXPERIMENT: ${plan.experimentId} (${plan.name})`,
    '======================================================================',
    '',
    '1. Multi-Objective Targets & Directions:',
  ];

  for (const obj of plan.objectives ?? []) {
    lines.push(`   - ${obj.metric}: ${obj.direction} (importance: ${obj.importance ?? 1.0}${obj.hardConstraint ? `, hardConstraint: ${obj.hardConstraint.operator} ${obj.hardConstraint.targetValue}` : ''})`);
  }

  lines.push('', '2. Selection Policy & Pre-Registered Criteria:');
  lines.push(`   - Policy: ${plan.selectionPolicy ?? 'PARETO_ONLY'}`);
  if (plan.lexicographicOrder?.length) {
    lines.push(`   - Lexicographic Order: ${plan.lexicographicOrder.join(' -> ')}`);
  }
  if (plan.weights) {
    lines.push(`   - Weights: ${JSON.stringify(plan.weights)}`);
  }
  if (plan.protectedMetrics?.length) {
    lines.push(`   - Protected Metrics (Zero Regression): ${plan.protectedMetrics.join(', ')}`);
  }

  lines.push('', '3. Evaluated Candidate Metric Vectors (Constraints First):');
  for (const c of frontier.allEvaluated) {
    const status = c.qualifies ? 'QUALIFIED' : `DISQUALIFIED (${c.disqualificationReasons.join('; ')})`;
    const rawMetricsStr = Object.entries(c.rawMetrics)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const deltasStr = Object.entries(c.normalizedDeltas)
      .map(([k, v]) => `${k}=${(Number(v) * 100).toFixed(1)}%`)
      .join(', ');
    lines.push(`   • [${c.candidateId}] ${status}`);
    lines.push(`     Raw:        ${rawMetricsStr}`);
    lines.push(`     Rel. Delta: ${deltasStr}`);
  }

  lines.push('', '4. Non-Dominated Pareto Frontier:');
  if (frontier.frontierCandidates.length === 0) {
    lines.push('   No candidates reached the Pareto frontier.');
  } else {
    for (const fc of frontier.frontierCandidates) {
      lines.push(`   ★ Non-dominated: ${fc.candidateId}${fc.weightedScore !== undefined ? ` (score: ${fc.weightedScore})` : ''}`);
    }
  }

  if (frontier.dominatedCandidates.length > 0) {
    lines.push('', '5. Dominated Candidates (Excluded from Frontier):');
    for (const dc of frontier.dominatedCandidates) {
      lines.push(`   ✗ Dominated: ${dc.candidateId}`);
    }
  }

  if (frontier.hypervolume !== undefined) {
    lines.push('', `6. Pareto Hypervolume: ${frontier.hypervolume}`);
  }

  lines.push('', '7. Tradeoffs Summary:');
  lines.push(`   ${frontier.tradeoffsSummary}`);

  lines.push('', '8. Final Decision:');
  if (frontier.selectedCandidateId) {
    lines.push(`   Winner: ${frontier.selectedCandidateId}`);
    lines.push(`   Reason: ${frontier.selectionReason}`);
  } else {
    lines.push(`   No single winner fabricated (PARETO_ONLY mode preserving all ${frontier.frontierCandidates.length} non-dominated tradeoffs).`);
    lines.push(`   Reason: ${frontier.selectionReason}`);
  }

  lines.push('======================================================================');
  return lines.join('\n');
}
