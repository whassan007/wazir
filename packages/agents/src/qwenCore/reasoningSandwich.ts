export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type AgentExecutionPhase = 'plan' | 'discovery' | 'implement' | 'verify' | 'repair';

export interface ReasoningSandwichConfig {
  /** Base effort for planning and discovery (default: 'xhigh'). */
  planEffort?: ReasoningEffort;
  /** Effort for code implementation turns (default: 'high'). */
  implementEffort?: ReasoningEffort;
  /** Effort for verification and bug-fixing turns (default: 'xhigh'). */
  verifyEffort?: ReasoningEffort;
  /** Fraction of wall-clock budget remaining below which effort steps down to avoid timeouts (default: 0.2). */
  lowBudgetThresholdFraction?: number;
}

export interface ReasoningScheduleDecision {
  phase: AgentExecutionPhase;
  effort: ReasoningEffort;
  downgradedForBudget: boolean;
  reason: string;
}

const STEP_DOWN: Record<ReasoningEffort, ReasoningEffort> = {
  xhigh: 'high',
  high: 'medium',
  medium: 'low',
  low: 'low',
};

/**
 * Schedules reasoning effort dynamically per execution phase
 * (LangChain "Reasoning Sandwich": xhigh plan -> high build -> xhigh verify),
 * stepping down if wall-clock budget is nearly exhausted to avoid timeouts.
 */
export function selectPhaseReasoningEffort(
  phase: AgentExecutionPhase,
  options: {
    config?: ReasoningSandwichConfig;
    remainingWallClockMs?: number;
    totalWallClockMs?: number;
  } = {},
): ReasoningScheduleDecision {
  const cfg = options.config ?? {};
  let target: ReasoningEffort;

  if (phase === 'plan' || phase === 'discovery') {
    target = cfg.planEffort ?? 'xhigh';
  } else if (phase === 'implement') {
    target = cfg.implementEffort ?? 'high';
  } else {
    target = cfg.verifyEffort ?? 'xhigh';
  }

  const threshold = cfg.lowBudgetThresholdFraction ?? 0.2;
  let downgraded = false;
  if (
    options.remainingWallClockMs !== undefined &&
    options.totalWallClockMs !== undefined &&
    options.totalWallClockMs > 0 &&
    options.remainingWallClockMs / options.totalWallClockMs < threshold
  ) {
    const next = STEP_DOWN[target];
    downgraded = next !== target;
    target = next;
  }

  return {
    phase,
    effort: target,
    downgradedForBudget: downgraded,
    reason: downgraded
      ? `Phase "${phase}" stepped down to "${target}" due to <${Math.round(threshold * 100)}% wall-clock budget remaining.`
      : `Phase "${phase}" scheduled at "${target}" reasoning effort.`,
  };
}
