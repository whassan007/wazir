import {
  AgentRegistry,
  ComputerRegistry,
  ModelRegistry,
  RuntimeRegistry,
  Scheduler,
  type ScheduleInput,
  type SchedulerDeps,
} from '@rook/core';
import type { SchedulerDecision, Task } from '@rook/core';

export { AgentRegistry, ComputerRegistry, ModelRegistry, RuntimeRegistry, Scheduler };
export type { ScheduleInput, SchedulerDeps };

/**
 * @rook/scheduler — thin facade over the core two-phase scheduler.
 *
 * Phase 1: MODEL ROUTING  — "which model is appropriate for this task?"
 * Phase 2: COMPUTER SCHEDULING — "where should that model run?"
 *
 * Decisions are deterministic and explainable; see SchedulerDecision.reasons.
 */
export interface SchedulerFacade {
  plan(input: ScheduleInput): SchedulerDecision;
}

export function createScheduler(deps: SchedulerDeps): SchedulerFacade {
  return new Scheduler(deps);
}

export function describeDecision(decision: SchedulerDecision): string {
  const lines: string[] = [];
  if (decision.agentId) lines.push(`Agent:    ${decision.agentId}`);
  lines.push(`Model:    ${decision.modelId}`);
  lines.push(`Runtime:  ${decision.runtimeId}`);
  lines.push(`Computer: ${decision.computerId}`);
  lines.push('Because:');
  for (const reason of decision.reasons) {
    lines.push(`  - ${reason}`);
  }
  return lines.join('\n');
}
