export interface AnchorEvaluationResult {
  anchorAccuracyBefore: number;
  anchorAccuracyAfter: number;
  historicalLoss: number;
  epsilonAnchor: number;
  accepted: boolean;
  reason: string;
}

export interface ReflectionEntry {
  id: string;
  taskPattern: string;
  guidance: string;
  confidence: number;
  revisionCount: number;
  superseded?: boolean;
}

/**
 * Harness Continual Learning (HCL) anchor-loss gate:
 * prevents harness-induced forgetting when adding new tools, skills, or subagents
 * by enforcing `anchorAccuracyBefore - anchorAccuracyAfter <= epsilonAnchor`.
 */
export function evaluateAnchorRetentionGate(params: {
  anchorAccuracyBefore: number;
  anchorAccuracyAfter: number;
  epsilonAnchor?: number;
}): AnchorEvaluationResult {
  const epsilonAnchor = params.epsilonAnchor ?? 0.02;
  const historicalLoss = Math.max(0, params.anchorAccuracyBefore - params.anchorAccuracyAfter);
  const accepted = historicalLoss <= epsilonAnchor;
  return {
    anchorAccuracyBefore: params.anchorAccuracyBefore,
    anchorAccuracyAfter: params.anchorAccuracyAfter,
    historicalLoss,
    epsilonAnchor,
    accepted,
    reason: accepted
      ? `Anchor retention passed: loss ${historicalLoss.toFixed(4)} <= budget ${epsilonAnchor}.`
      : `Rejected due to harness-induced forgetting: anchor loss ${historicalLoss.toFixed(4)} > budget ${epsilonAnchor}.`,
  };
}

/**
 * ReHarness-style online, replay-free backward revision of stale or
 * overgeneralized textual reflections under distribution shift.
 */
export class OnlineReflectionReviser {
  private readonly reflections = new Map<string, ReflectionEntry>();

  addReflection(entry: Omit<ReflectionEntry, 'revisionCount'>): ReflectionEntry {
    const full: ReflectionEntry = { ...entry, revisionCount: 0 };
    this.reflections.set(full.id, full);
    return full;
  }

  /**
   * Propagates a failed trajectory's feedback backward to revise or narrow
   * an existing reflection whose guidance led to a regression.
   */
  reviseFromFailure(reflectionId: string, revisedGuidance: string, penalty = 0.15): ReflectionEntry | undefined {
    const existing = this.reflections.get(reflectionId);
    if (!existing) return undefined;
    existing.guidance = revisedGuidance;
    existing.confidence = Math.max(0, Number((existing.confidence - penalty).toFixed(3)));
    existing.revisionCount += 1;
    if (existing.confidence <= 0.1) {
      existing.superseded = true;
    }
    return existing;
  }

  getActiveReflections(): ReflectionEntry[] {
    return [...this.reflections.values()].filter((r) => !r.superseded);
  }
}
