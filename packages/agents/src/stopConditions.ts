import type { TerminationReason } from '@wazir/core';

/**
 * Controller-owned stop conditions for the agent loop, evaluated in one place.
 *
 * The loop calls `firstStop` at fixed checkpoints; each condition declares where it
 * applies, the typed termination reason it produces, and whether the controller may
 * first try a model escalation instead of stopping (only failures that another model
 * could plausibly fix — never an exhausted budget). The model has no input into any
 * of this: every value is counted by the harness.
 *
 * Conditions that are inherently tied to one action's handling — protocol-budget
 * exhaustion, repeated blocked actions, repair-cycle exhaustion — stay at their call
 * sites, which already produce the same typed reasons; the turn budget remains the
 * loop bound because exhausting it still runs verification rather than aborting.
 */

export type StopCheckpoint = 'before_turn' | 'after_model_turn' | 'before_tool' | 'after_tool';

export interface RunSnapshot {
  elapsedMs: number;
  turns: number;
  toolCalls: number;
  tokensUsed: number;
  noProgressStreak: number;
}

export interface StopLimits {
  maxWallClockMs: number;
  maxToolCalls: number;
  maxTokens: number;
  maxNoProgressIterations: number;
}

export interface StopCondition {
  reason: TerminationReason;
  checkpoint: StopCheckpoint;
  /** May the controller try a different model before stopping? */
  escalatable: boolean;
  /** Returns a human-readable explanation when the condition holds, else null. */
  check(snapshot: RunSnapshot, limits: StopLimits): string | null;
}

export interface StopDecision {
  reason: TerminationReason;
  message: string;
  escalatable: boolean;
}

export const DEFAULT_STOP_CONDITIONS: readonly StopCondition[] = [
  {
    reason: 'MAX_WALL_CLOCK',
    checkpoint: 'before_turn',
    escalatable: false,
    check: (s, l) => (s.elapsedMs >= l.maxWallClockMs ? `run exceeded its wall-clock budget (${l.maxWallClockMs}ms)` : null),
  },
  {
    reason: 'MAX_TOKENS',
    checkpoint: 'after_model_turn',
    escalatable: false,
    check: (s, l) => (s.tokensUsed > l.maxTokens ? `run exceeded its token budget (${l.maxTokens} tokens, used ${s.tokensUsed})` : null),
  },
  {
    reason: 'MAX_TOOL_CALLS',
    checkpoint: 'before_tool',
    escalatable: false,
    check: (s, l) => (s.toolCalls >= l.maxToolCalls ? `run exceeded its tool-call budget (${l.maxToolCalls} calls)` : null),
  },
  {
    reason: 'NO_PROGRESS',
    checkpoint: 'after_tool',
    escalatable: true,
    check: (s, l) => (s.noProgressStreak >= l.maxNoProgressIterations
      ? `NO_PROGRESS: ${s.noProgressStreak} consecutive tool calls produced no file change and no new information`
      : null),
  },
];

/** The first condition that holds at this checkpoint, in declaration order. */
export function firstStop(
  conditions: readonly StopCondition[],
  checkpoint: StopCheckpoint,
  snapshot: RunSnapshot,
  limits: StopLimits,
): StopDecision | null {
  for (const condition of conditions) {
    if (condition.checkpoint !== checkpoint) continue;
    const message = condition.check(snapshot, limits);
    if (message !== null) return { reason: condition.reason, message, escalatable: condition.escalatable };
  }
  return null;
}
