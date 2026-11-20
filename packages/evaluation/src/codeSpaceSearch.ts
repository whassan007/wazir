import path from 'node:path';

export interface FalsifiableEditContract {
  editId: string;
  targetFiles: string[];
  failureEvidence: Array<{ taskId: string; tracePath: string; stepIndex: number }>;
  rootCause: string;
  targetedFix: string;
  predictedTaskFlips: string[];
}

export interface EditContractVerification {
  editId: string;
  validContract: boolean;
  violations: string[];
  actualFlips: string[];
  predictionPrecision: number;
  accepted: boolean;
}

export interface DraftSelfEditVerification {
  traceMinimizationPassed: boolean;
  failureReplayPassed: boolean;
  singleStepPerturbationPassed: boolean;
}

/**
 * Validates that a proposed code-space harness edit stays within `allowedWritePaths`
 * (SuperagenticAI/metaharness safety gate) and declares all 4 falsifiable AHE fields.
 */
export function validateFalsifiableEditContract(
  contract: FalsifiableEditContract,
  allowedWritePaths: string[],
  projectRoot: string,
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  if (contract.failureEvidence.length === 0) violations.push('missing_failure_evidence');
  if (!contract.rootCause.trim()) violations.push('missing_root_cause');
  if (!contract.targetedFix.trim()) violations.push('missing_targeted_fix');
  if (contract.predictedTaskFlips.length === 0) violations.push('missing_predicted_task_flips');
  if (contract.targetFiles.length === 0) violations.push('missing_target_files');

  const resolvedAllowed = allowedWritePaths.map((p) => path.resolve(projectRoot, p));
  for (const file of contract.targetFiles) {
    const resolved = path.resolve(projectRoot, file);
    const inBounds = resolvedAllowed.some((allowed) => resolved === allowed || resolved.startsWith(allowed + path.sep));
    if (!inBounds) {
      violations.push(`path_outside_allowed_write_paths:${file}`);
    }
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Verifies a falsifiable edit contract against observed next-round task flips.
 */
export function verifyEditContractOutcome(
  contract: FalsifiableEditContract,
  beforeResults: Record<string, boolean>,
  afterResults: Record<string, boolean>,
  allowedWritePaths: string[],
  projectRoot: string,
): EditContractVerification {
  const precheck = validateFalsifiableEditContract(contract, allowedWritePaths, projectRoot);
  const actualFlips: string[] = [];
  for (const [taskId, afterPassed] of Object.entries(afterResults)) {
    if (afterPassed && beforeResults[taskId] === false) {
      actualFlips.push(taskId);
    }
  }

  const predictedSet = new Set(contract.predictedTaskFlips);
  const hits = actualFlips.filter((id) => predictedSet.has(id)).length;
  const predictionPrecision = contract.predictedTaskFlips.length > 0 ? hits / contract.predictedTaskFlips.length : 0;

  return {
    editId: contract.editId,
    validContract: precheck.valid,
    violations: precheck.violations,
    actualFlips,
    predictionPrecision,
    accepted: precheck.valid && actualFlips.length > 0,
  };
}

/**
 * VERSE-style execution-based draft verification gate for bilevel
 * optimizer self-evolution: unverified optimizer self-edits are rejected.
 */
export function verifyBilevelSelfEdit(draft: DraftSelfEditVerification): { accepted: boolean; reason?: string } {
  if (!draft.traceMinimizationPassed) return { accepted: false, reason: 'trace_minimization_failed' };
  if (!draft.failureReplayPassed) return { accepted: false, reason: 'failure_replay_failed' };
  if (!draft.singleStepPerturbationPassed) return { accepted: false, reason: 'single_step_perturbation_failed' };
  return { accepted: true };
}
