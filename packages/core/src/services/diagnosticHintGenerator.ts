import { FailureObservation, FailureIntelligence } from '../types/failureIntelligence.js';

export class DiagnosticHintGenerator {
  /**
   * Generates actionable diagnostic hints based on the failure intelligence history.
   * Hints describe evidence collection needs rather than prescribing specific code fixes.
   */
  static generateHints(intelligence: FailureIntelligence): string[] {
    const { current, history } = intelligence;
    const hints: string[] = [];

    // 1. Handle Repeated Failures (Stale Edits / Infinite Loops)
    if (intelligence.progressStatus === 'SAME_FAILURE') {
      hints.push(`Same failure pattern detected (${current.repeatedSignature}). Verify if the last mutation actually applied or was ignored.`);
      
      if (current.workspaceRevision > (history[history.length - 1]?.workspaceRevision ?? 0)) {
        hints.push("Mutation occurred but error persists; check for side-effects that might be reverting changes.");
      } else {
        hints.push("No workspace mutation detected; reread current file state before another attempt.");
      }
    }

    // 2. Handle Partial Progress (Moving in the right direction)
    if (intelligence.progressStatus === 'PARTIAL_PROGRESS') {
      hints.push(`Progress detected: Workspace moved to revision ${current.workspaceRevision}. Continue with current strategy.`);
    }

    // 3. Handle Regressions or different failures
    if (intelligence.progressStatus === 'REGRESSION') {
      hints.push("Regression detected: The workspace state has reverted or the error category has worsened. Investigate recent mutations.");
    } else if (intelligence.progressStatus === 'DIFFERENT_FAILURE') {
      hints.push("Failure pattern changed; evaluate if this is progress toward a fix or a new regression.");
    }

    // 4. Tool/Runtime specific hints
    if (current.category === 'TOOL_TIMEOUT') {
      hints.push("Execution timed out; check resource availability or complexity of the tool execution.");
    }

    // 5. Policy failures
    if (current.category === 'POLICY_DENIED') {
      hints.push("Action denied by policy; verify permissions and security constraints for this operation.");
    }

    return hints;
  }
}
