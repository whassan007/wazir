import type { FailureClass } from '@wazir/shared';
import { FailureObservation, FailureIntelligence, ProgressStatus } from '../types/failureIntelligence.js';

/**
 * Pipeline stage of a failure category: a lower number fails earlier in the
 * build → typecheck → lint → test → artifact pipeline. Moving to a later stage is
 * progress; moving back to an earlier stage is a regression.
 */
const PIPELINE_STAGE: Partial<Record<FailureClass, number>> = {
  BUILD_FAILED: 1,
  TYPECHECK_FAILED: 2,
  LINT_FAILED: 3,
  CODE_FAILURE: 4,
  TEST_FAILED: 5,
  ARTIFACT_CONTRACT_FAILED: 6,
};

function compareObservations(prev: FailureObservation, curr: FailureObservation): ProgressStatus {
  if (curr.repeatedSignature && curr.repeatedSignature === prev.repeatedSignature) return 'SAME_FAILURE';
  if (FailureIntelligenceService.isRegression(prev, curr)) return 'REGRESSION';
  if (FailureIntelligenceService.isPhysicalProgress(prev, curr)) return 'PARTIAL_PROGRESS';
  return 'DIFFERENT_FAILURE';
}

export class RepeatedFailureDetector {
  /**
   * Analyzes a sequence of failure observations to detect repeated failures
   * and determine the progress of a repair loop. Returns the current
   * observation annotated with its predecessors and progress status.
   */
  static analyze(history: FailureObservation[]): FailureObservation & Pick<FailureIntelligence, 'history' | 'progressStatus'> {
    if (history.length === 0) {
      throw new Error('At least one observation is required for analysis.');
    }
    const intelligence = FailureIntelligenceService.compute(history);
    return { ...intelligence.current, history: intelligence.history, progressStatus: intelligence.progressStatus };
  }
}

/**
 * Computes the FailureIntelligence structure for a sequence of observations
 * (oldest first). Deterministic: depends only on the observations.
 */
export class FailureIntelligenceService {
  static compute(history: FailureObservation[]): FailureIntelligence {
    if (!Array.isArray(history) || history.length === 0) {
      throw new Error('At least one observation is required for analysis.');
    }
    const current = history[history.length - 1];
    if (history.length < 2) {
      return { history: [], current, progressStatus: 'NONE' };
    }
    const previous = history[history.length - 2];
    return { history: history.slice(0, -1), current, progressStatus: compareObservations(previous, current) };
  }

  /** Number of consecutive trailing observations that share the current signature (>= 1). */
  static consecutiveSameSignature(history: FailureObservation[]): number {
    if (history.length === 0) return 0;
    const signature = history[history.length - 1].repeatedSignature;
    if (!signature) return 1;
    let count = 0;
    for (let i = history.length - 1; i >= 0 && history[i].repeatedSignature === signature; i -= 1) count += 1;
    return count;
  }

  /** The workspace moved forward, or the failure moved to a later pipeline stage. */
  static isPhysicalProgress(prev: FailureObservation, curr: FailureObservation): boolean {
    const prevStage = PIPELINE_STAGE[prev.category];
    const currStage = PIPELINE_STAGE[curr.category];
    if (prevStage !== undefined && currStage !== undefined && currStage > prevStage) return true;
    return typeof curr.workspaceRevision === 'number' && typeof prev.workspaceRevision === 'number'
      && curr.workspaceRevision > prev.workspaceRevision;
  }

  /** The workspace revision went backwards, or the failure moved to an earlier pipeline stage. */
  static isRegression(prev: FailureObservation, curr: FailureObservation): boolean {
    if (typeof curr.workspaceRevision === 'number' && typeof prev.workspaceRevision === 'number'
      && curr.workspaceRevision < prev.workspaceRevision) return true;
    const prevStage = PIPELINE_STAGE[prev.category];
    const currStage = PIPELINE_STAGE[curr.category];
    return prevStage !== undefined && currStage !== undefined && currStage < prevStage;
  }
}
