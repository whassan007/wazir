import {
  AgentRegistry,
  ComputerRegistry,
  ModelRegistry,
  RuntimeRegistry,
  Scheduler,
  FORMAL_TOOL_CAPABILITY_PREFIX,
  KNOWN_FORMAL_TOOL_CAPABILITIES,
  normalizeToolCapability,
  extractRequiredToolCapabilities,
  isDgxClassComputer,
  parseMaxAlloyScope,
  isHeavyVerificationTask,
  isSolverOrVerificationTask,
  checkComputerToolFeasibility,
  type ScheduleInput,
  type SchedulerDeps,
  type FormalToolCapability,
  type ToolHostScheduleResult,
} from '@wazir/core';
import type { SchedulerDecision, Task } from '@wazir/core';

export {
  AgentRegistry,
  ComputerRegistry,
  ModelRegistry,
  RuntimeRegistry,
  Scheduler,
  FORMAL_TOOL_CAPABILITY_PREFIX,
  KNOWN_FORMAL_TOOL_CAPABILITIES,
  normalizeToolCapability,
  extractRequiredToolCapabilities,
  isDgxClassComputer,
  parseMaxAlloyScope,
  isHeavyVerificationTask,
  isSolverOrVerificationTask,
  checkComputerToolFeasibility,
};
export type {
  ScheduleInput,
  SchedulerDeps,
  FormalToolCapability,
  ToolHostScheduleResult,
};

/**
 * @wazir/scheduler — thin facade over the core two-phase scheduler.
 *
 * Phase 1: MODEL ROUTING  — "which model is appropriate for this task?"
 * Phase 2: COMPUTER SCHEDULING — "where should that model run?"
 *
 * Decisions are deterministic and explainable; see SchedulerDecision.reasons.
 */
export interface SchedulerFacade {
  plan(input: ScheduleInput): SchedulerDecision;
  scheduleToolHost(
    task: Task,
    options?: { throwOnUnschedulable?: boolean; alloyScopeThreshold?: number },
  ): ToolHostScheduleResult;
}

export function createScheduler(deps: SchedulerDeps): SchedulerFacade {
  return new Scheduler(deps);
}

export function scheduleToolHost(
  scheduler: Scheduler | SchedulerFacade,
  task: Task,
  options?: { throwOnUnschedulable?: boolean; alloyScopeThreshold?: number },
): ToolHostScheduleResult {
  return scheduler.scheduleToolHost(task, options);
}

export function describeDecision(decision: SchedulerDecision): string {
  const lines: string[] = [];
  if (decision.agentId) lines.push(`Agent:    ${decision.agentId}`);
  lines.push(`Model:    ${decision.modelId || '(bypassed — formal tool execution)'}`);
  lines.push(`Runtime:  ${decision.runtimeId}`);
  lines.push(`Computer: ${decision.computerId ?? `(hosted via ${decision.runtimeId})`}`);
  lines.push('Because:');
  for (const reason of decision.reasons) {
    lines.push(`  - ${reason}`);
  }
  return lines.join('\n');
}
