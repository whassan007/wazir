import { FailureObservation, FailureIntelligence, ProgressStatus } from '../types/failureIntelligence.js';

export class RepeatedFailureDetector {
  /**
   * Analyzes a sequence of failure observations to detect repeated failures 
   * and determine the progress of a repair loop.
   */
  static analyze(history: FailureObservation[]): FailureIntelligence['current'] {
    if (history.length === 0) {
      throw new Error('At least one observation is required for analysis.');
    }

    const current = history[history.length - 1];
    const previous = history[history.length - 2];

    let progressStatus: ProgressStatus = 'NONE';
    let repeatedSignature: string | undefined = current.repeatedSignature;

    if (previous) {
      // 1. Detect if it is the exact same failure pattern
      if (current.repeatedSignature && previous.repeatedSignature === current.repeatedSignature) {
        progressStatus = 'SAME_FAILURE';
      } else if (current.repeatedSignature && previous.repeatedSignature !== current.repeatedSignature) {
        // It's a new signature, but it might be progress if the category changed or error is different
        progressStatus = 'DIFFERENT_FAILURE';
      }

      // 2. Detect Progress (e.g., number of failing tests decreasing)
      // Note: This requires checking specific evidence/context which would ideally be passed in,
      // but for this implementation, we look at the transition between observations.
      if (this.isProgressMade(previous, current)) {
        progressStatus = 'PARTIAL_PROGRESS';
      }

      // 3. Detect Regression
      if (this.isRegression(previous, current)) {
        progressStatus = 'REGRESSION';
      }
    }

    return {
      ...current,
      history: history.slice(0, -1), // The rest is the previous history
      progressStatus: progressStatus as any, // Casting for simplified return in this mock/logic structure
      // We'll restructure to match FailureIntelligence properly in a real implementation
    } as any; 
  }

  private static isProgressMade(prev: FailureObservation, curr: FailureObservation): boolean {
    // In a real system, we would compare workspaceRevision or specific evidence counts.
    // For now, if the failure class changed and it's not a regression, we consider it progress.
    return prev.category !== curr.category && !this.isRegression(prev, curr);
  }

  private static isRegression(prev: FailureObservation, curr: FailureObservation): boolean {
    // If the workspace revision went backwards (shouldn't happen) or 
    // if we detect a specific "regression" signature in hints/metadata.
    return false; 
  }
}

/**
 * Refined implementation to match the requested FailureIntelligence structure exactly.
 */
export class FailureIntelligenceService {
  static compute(history: FailureObservation[]): FailureIntelligence {
    const current = history[history.length - 1];
    
    if (history.length < 2) {
      return {
        history: history.slice(0, -1),
        current,
        progressStatus: 'NONE'
      };
    }

    const previous = history[history.length - 2];
    let progressStatus: ProgressStatus = 'NONE';

    // Logic for determining progress
    if (current.repeatedSignature && current.repeatedSignature === previous.repeatedSignature) {
      progressStatus = 'SAME_FAILURE';
    } else if (this.isPhysicalProgress(previous, current)) {
      progressStatus = 'PARTIAL_PROGRESS';
    } else if (this.isRegression(previous, current)) {
      progressStatus = 'REGRESSION';
    } else {
      // If it's not the same failure and not a regression, it's a different attempt/failure
      progressStatus = 'DIFFERENT_FAILURE';
    }

    return {
      history: history.slice(0, -1),
      current,
      progressStatus
    };
  }

  private static isPhysicalProgress(prev: FailureObservation, curr: FailureObservation): boolean {
    // Heuristic: If the workspace revision has increased and we aren't in a SAME_FAILURE state,
    // it indicates a mutation occurred. We look at diagnosticHints or specific evidence to confirm.
    return curr.workspaceRevision > prev.workspaceRevision;
  }

  private static isRegression(prev: FailureObservation, curr: FailureObservation): boolean {
    // A regression could be defined by a change in category that is known to be worse 
    // (e.g., from TEST_FAILED to BUILD_FAILED) or a workspace reversion.
    return false;
  }
}
