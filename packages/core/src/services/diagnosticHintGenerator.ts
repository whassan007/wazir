import type { FailureClass } from '@wazir/shared';
import { FailureIntelligence } from '../types/failureIntelligence.js';

const CATEGORY_HINTS: Partial<Record<FailureClass, string>> = {
  TOOL_TIMEOUT: 'Execution timed out; check resource availability or complexity of the tool execution.',
  TIMEOUT: 'Operation timed out; confirm the dependency is responsive before retrying.',
  TRANSPORT: 'Transport failure; confirm network reachability of the runtime before retrying.',
  RATE_LIMIT: 'Rate limited; wait for the provider window instead of retrying immediately.',
  SERVER: 'Upstream server error; retry with backoff and record the provider response.',
  POLICY_DENIED: 'Action denied by policy; verify permissions and security constraints for this operation.',
  APPROVAL_REQUIRED: 'Action requires explicit human approval; do not attempt an alternative route around the gate.',
  MODEL_ADMISSION_DENIED: 'Model admission denied; the route is not authorized for this task.',
  AUTH_FAILED: 'Authentication failed; retrying cannot succeed until credentials are fixed by an operator.',
  QUOTA_EXHAUSTED: 'Quota exhausted; only the quota reset or an operator can unblock this.',
  BUILD_FAILED: 'Build failed; read the first compiler error and fix it before anything downstream.',
  TYPECHECK_FAILED: 'Type check failed; inspect the reported type errors at their source locations.',
  LINT_FAILED: 'Lint failed; apply the reported rule fixes without changing behaviour.',
  TEST_FAILED: 'Tests failed; reproduce the failing test in isolation and read its assertion diff.',
  ARTIFACT_CONTRACT_FAILED: 'Artifact contract failed; compare produced artifacts with the required names and schema.',
  STALE_EDIT: 'Edit was based on stale file content; reread the file before the next mutation.',
  WORKSPACE_CONFLICT: 'Workspace conflict; another writer touched the same files. Reconcile before retrying.',
  MODEL_CONTEXT_OVERFLOW: 'Context overflow; reduce the prompt or split the task into smaller steps.',
  MODEL_PROTOCOL: 'Model output violated the protocol; tighten the output schema and validate it.',
  RESOURCE_EXHAUSTED: 'Resource exhausted; free resources or route to a different worker.',
};

export class DiagnosticHintGenerator {
  /**
   * Generates actionable diagnostic hints based on the failure intelligence history.
   * Hints describe evidence collection needs rather than prescribing specific code fixes.
   * Output is deterministic and free of duplicates.
   */
  static generateHints(intelligence: FailureIntelligence): string[] {
    const { current, history } = intelligence;
    const hints: string[] = [];
    const previous = history[history.length - 1];

    // 1. Handle Repeated Failures (Stale Edits / Infinite Loops)
    if (intelligence.progressStatus === 'SAME_FAILURE') {
      hints.push(`Same failure pattern detected (${current.repeatedSignature}). Verify if the last mutation actually applied or was ignored.`);
      const prevRev = previous?.workspaceRevision;
      const currRev = current.workspaceRevision;
      if (typeof currRev === 'number' && typeof prevRev === 'number' && currRev > prevRev) {
        hints.push('Mutation occurred but error persists; check for side-effects that might be reverting changes.');
      } else if (typeof currRev === 'number' && typeof prevRev === 'number') {
        hints.push('No workspace mutation detected; reread current file state before another attempt.');
      } else {
        hints.push('Workspace revision unknown; reread current file state and confirm the last mutation landed.');
      }
    }

    // 2. Handle Partial Progress (Moving in the right direction)
    if (intelligence.progressStatus === 'PARTIAL_PROGRESS') {
      hints.push(`Progress detected: failure moved to ${current.category} at revision ${current.workspaceRevision ?? 'unknown'}. Continue with current strategy.`);
    }

    // 3. Handle Regressions or different failures
    if (intelligence.progressStatus === 'REGRESSION') {
      hints.push('Regression detected: The workspace state has reverted or the error category has worsened. Investigate recent mutations.');
    } else if (intelligence.progressStatus === 'DIFFERENT_FAILURE') {
      hints.push('Failure pattern changed; evaluate if this is progress toward a fix or a new regression.');
    }

    // 4. Category specific hints (tool, runtime, policy, pipeline stage)
    const categoryHint = CATEGORY_HINTS[current.category];
    if (categoryHint) hints.push(categoryHint);

    for (const hint of current.diagnosticHints ?? []) {
      if (typeof hint === 'string' && hint.trim()) hints.push(hint.trim());
    }

    return [...new Set(hints)];
  }
}
