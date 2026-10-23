// Owned by the Goal Studio controller workstream. See reports/goal-studio-12-agents/INTEGRATION-CONTRACTS.md.
export {
  createGoalController,
  attemptIdFor,
  humanActor,
  type ApprovalKind,
  type ApprovalResolution,
  type ContinuousGoalController,
  type GoalControllerDeps,
} from './controller.js';
export {
  createTargetTaskExecutor,
  buildTargetTask,
  renderTargetPrompt,
  type TargetExecutorRunInput,
  type TargetExecutorRunOutput,
  type TargetTaskExecutorDeps,
} from './executor.js';
export {
  computeCriticality,
  compareTargets,
  dependenciesCompleted,
  eligibleTargets,
  computeEligibleTargets,
  newlyUnlockedTargets,
  isTerminalTargetStatus,
  canTransitionTarget,
  assertTargetTransition,
  TARGET_TRANSITIONS,
  HUMAN_TARGET_TRANSITIONS,
  type TargetCriticality,
} from './eligibility.js';
