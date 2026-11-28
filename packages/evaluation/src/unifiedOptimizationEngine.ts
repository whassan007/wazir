export type OptimizationPhase = 'plan' | 'implement' | 'verify' | 'repair' | 'critic' | 'synthesize';

export interface ModelHarnessProfile {
  modelId: string;
  harnessId: string;
  hostId: string;
  qualityScore: number;
  verificationPassRate: number;
  avgLatencyMs: number;
  costPer1kTokensUsd: number;
  availableRamGB: number;
  requiredRamGB: number;
  sampleCount: number;
}

export interface IndependentEvidence {
  criterionId: string;
  verifierId: string;
  authorId?: string;
  passed: boolean;
  score: number;
  summary: string;
}

export interface IndependentVerificationVerdict {
  validationState: 'VALIDATED_PASS' | 'VALIDATED_FAIL' | 'UNVERIFIED';
  weightedScore: number | null;
  reasons: string[];
}

export class SessionStickinessTracker {
  private readonly stickyBySessionAndPhase = new Map<string, string>();

  getStickyModel(sessionId: string, phase: OptimizationPhase): string | undefined {
    return this.stickyBySessionAndPhase.get(`${sessionId}:${phase}`);
  }

  pinModel(sessionId: string, phase: OptimizationPhase, modelId: string): void {
    this.stickyBySessionAndPhase.set(`${sessionId}:${phase}`, modelId);
  }

  clearSession(sessionId: string): void {
    for (const key of this.stickyBySessionAndPhase.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.stickyBySessionAndPhase.delete(key);
      }
    }
  }
}

export class UnifiedOptimizationEngine {
  private readonly stickiness = new SessionStickinessTracker();

  routeAtPhaseBoundary(params: {
    sessionId: string;
    phase: OptimizationPhase;
    profiles: ModelHarnessProfile[];
    maxCostPer1kTokensUsd?: number;
    maxLatencyMs?: number;
  }): ModelHarnessProfile {
    const eligible = params.profiles.filter((p) => {
      if (p.availableRamGB < p.requiredRamGB) return false;
      if (params.maxCostPer1kTokensUsd !== undefined && p.costPer1kTokensUsd > params.maxCostPer1kTokensUsd) return false;
      if (params.maxLatencyMs !== undefined && p.avgLatencyMs > params.maxLatencyMs) return false;
      return true;
    });
    if (eligible.length === 0) {
      throw new Error(`No capacity-safe model/harness profile available for phase '${params.phase}'.`);
    }

    const stickyId = this.stickiness.getStickyModel(params.sessionId, params.phase);
    if (stickyId) {
      const sticky = eligible.find((p) => p.modelId === stickyId);
      if (sticky) return sticky;
    }

    const ranked = [...eligible].sort((a, b) => {
      const scoreA = a.qualityScore * 60 + a.verificationPassRate * 30 - a.avgLatencyMs * 0.001 + (a.modelId.toLowerCase().includes('qwen') ? 5 : 0);
      const scoreB = b.qualityScore * 60 + b.verificationPassRate * 30 - b.avgLatencyMs * 0.001 + (b.modelId.toLowerCase().includes('qwen') ? 5 : 0);
      return scoreB - scoreA || a.modelId.localeCompare(b.modelId);
    });

    const winner = ranked[0]!;
    this.stickiness.pinModel(params.sessionId, params.phase, winner.modelId);
    return winner;
  }

  compareModelsAndHarnesses(profiles: ModelHarnessProfile[]): Array<{
    modelId: string;
    harnessId: string;
    compositeScore: number;
    verificationPassRate: number;
    avgLatencyMs: number;
  }> {
    return [...profiles]
      .map((p) => ({
        modelId: p.modelId,
        harnessId: p.harnessId,
        compositeScore: Number((p.qualityScore * 0.6 + p.verificationPassRate * 0.4).toFixed(4)),
        verificationPassRate: p.verificationPassRate,
        avgLatencyMs: p.avgLatencyMs,
      }))
      .sort((a, b) => b.compositeScore - a.compositeScore);
  }

  evaluateWithIndependentEvidence(params: {
    requiredCriteria: string[];
    evidence: IndependentEvidence[];
    minimumScore?: number;
  }): IndependentVerificationVerdict {
    const minimumScore = params.minimumScore ?? 0.7;
    const reasons: string[] = [];

    // Reject self-attestation: verifierId must differ from authorId when authorId is present.
    const validEvidence = params.evidence.filter((e) => !e.authorId || e.verifierId !== e.authorId);
    if (validEvidence.length < params.evidence.length) {
      reasons.push('Self-reported agent evidence ignored; independent verifier required.');
    }

    const missing = params.requiredCriteria.filter((c) => !validEvidence.some((e) => e.criterionId === c));
    if (missing.length > 0) {
      return {
        validationState: 'UNVERIFIED',
        weightedScore: null,
        reasons: [...reasons, `Missing independent evidence for: ${missing.join(', ')}`],
      };
    }

    const avgScore = validEvidence.reduce((sum, e) => sum + e.score, 0) / Math.max(1, validEvidence.length);
    const allPassed = validEvidence.every((e) => e.passed) && avgScore >= minimumScore;
    return {
      validationState: allPassed ? 'VALIDATED_PASS' : 'VALIDATED_FAIL',
      weightedScore: Number(avgScore.toFixed(4)),
      reasons,
    };
  }

  async runBoundedRepairLoop<T>(params: {
    baseline: T;
    baselineScore: number;
    targetScore: number;
    maxIterations: number;
    step: (iteration: number, currentBest: T) => Promise<{ candidate: T; score: number; verified: boolean }>;
  }): Promise<{
    bestCandidate: T;
    bestScore: number;
    iterationsRun: number;
    terminationReason: 'target_reached' | 'max_iterations' | 'no_progress';
    history: Array<{ iteration: number; score: number; accepted: boolean }>;
  }> {
    let bestCandidate = params.baseline;
    let bestScore = params.baselineScore;
    const history: Array<{ iteration: number; score: number; accepted: boolean }> = [];
    let staleCount = 0;

    for (let i = 1; i <= params.maxIterations; i += 1) {
      const res = await params.step(i, bestCandidate);
      const accepted = res.verified && res.score > bestScore;
      history.push({ iteration: i, score: res.score, accepted });

      if (accepted) {
        bestCandidate = res.candidate;
        bestScore = res.score;
        staleCount = 0;
        if (bestScore >= params.targetScore) {
          return { bestCandidate, bestScore, iterationsRun: i, terminationReason: 'target_reached', history };
        }
      } else {
        staleCount += 1;
        if (staleCount >= 2 && i < params.maxIterations) {
          return { bestCandidate, bestScore, iterationsRun: i, terminationReason: 'no_progress', history };
        }
      }
    }

    return { bestCandidate, bestScore, iterationsRun: params.maxIterations, terminationReason: 'max_iterations', history };
  }
}
