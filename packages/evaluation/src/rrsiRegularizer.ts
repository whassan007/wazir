export interface StratifiedBenchmarkSplits<T extends { id: string }> {
  search: T[];
  selection: T[];
  holdout: T[];
}

export interface RrsiGateParams {
  baselineScore: number;
  candidateScore: number;
  baselineTokens: number;
  candidateTokens: number;
  /** Marginal token-cost penalty gamma (default: 0.05). */
  gamma?: number;
  /** Measurement noise floor tau (default: 0.01). */
  noiseFloorTau?: number;
}

export interface RrsiGateResult {
  accepted: boolean;
  deltaScore: number;
  relativeTokenGrowth: number;
  effectiveGain: number;
  reason: string;
}

export interface LeakageAuditResult {
  clean: boolean;
  findings: Array<{ source: string; pattern: string; match: string }>;
}

const DEFAULT_LEAKAGE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'answer_key_marker', regex: /\b(answer[_\s-]?key|ground[_\s-]?truth|expected[_\s-]?flag|secret[_\s-]?token)\b\s*[:=]/i },
  { name: 'benchmark_task_id_hardcode', regex: /\b(tb2-|swe-bench-|humaneval-)\d+\b.*(?:return|echo|print)/i },
  { name: 'test_oracle_bypass', regex: /\b(skip\s+tests|always\s+return\s+true|force\s+passed\s*=\s*true)\b/i },
];

/**
 * Enforces disjoint 3-way StarHarness splits (proposer-visible search,
 * proposer-hidden selection, untouched holdout) to prevent Goodhart overfitting.
 */
export function createDisjointSplits<T extends { id: string }>(
  tasks: T[],
  ratios: { search: number; selection: number; holdout: number } = { search: 0.5, selection: 0.25, holdout: 0.25 },
): StratifiedBenchmarkSplits<T> {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const t of tasks) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      unique.push(t);
    }
  }
  const totalRatio = ratios.search + ratios.selection + ratios.holdout || 1;
  const nSearch = Math.floor((unique.length * ratios.search) / totalRatio);
  const nSelection = Math.floor((unique.length * ratios.selection) / totalRatio);

  return {
    search: unique.slice(0, nSearch),
    selection: unique.slice(nSearch, nSearch + nSelection),
    holdout: unique.slice(nSearch + nSelection),
  };
}

/**
 * RRSI marginal token-cost & noise-floor selection gate:
 * accepts candidate iff `deltaScore - gamma * relativeTokenGrowth > tau`.
 */
export function evaluateRrsiPromotionGate(params: RrsiGateParams): RrsiGateResult {
  const gamma = params.gamma ?? 0.05;
  const tau = params.noiseFloorTau ?? 0.01;
  const deltaScore = params.candidateScore - params.baselineScore;
  const relativeTokenGrowth =
    params.baselineTokens > 0
      ? (params.candidateTokens - params.baselineTokens) / params.baselineTokens
      : 0;
  const effectiveGain = deltaScore - gamma * Math.max(0, relativeTokenGrowth);
  const accepted = effectiveGain > tau;

  return {
    accepted,
    deltaScore,
    relativeTokenGrowth,
    effectiveGain,
    reason: accepted
      ? `Accepted: effective gain ${effectiveGain.toFixed(4)} > noise floor ${tau}.`
      : `Rejected: effective gain ${effectiveGain.toFixed(4)} <= noise floor ${tau} (deltaScore=${deltaScore.toFixed(4)}, tokenGrowth=${(relativeTokenGrowth * 100).toFixed(1)}%).`,
  };
}

/**
 * Scans instruction/skill artifacts (e.g. `AGENTS.md`, `SKILL.md`) for
 * literal answer-key or test-oracle leakage before evaluation.
 */
export function auditBenchmarkLeakage(artifacts: Array<{ source: string; content: string }>): LeakageAuditResult {
  const findings: LeakageAuditResult['findings'] = [];
  for (const art of artifacts) {
    for (const pat of DEFAULT_LEAKAGE_PATTERNS) {
      const m = art.content.match(pat.regex);
      if (m) {
        findings.push({ source: art.source, pattern: pat.name, match: m[0] });
      }
    }
  }
  return { clean: findings.length === 0, findings };
}
