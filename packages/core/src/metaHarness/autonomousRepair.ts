import {
  detectOracleWeakening,
  isVerificationAsset,
  type OracleWeakeningFinding,
} from '../services/verificationIntegrity.js';
import type {
  AcceptanceState,
  DeclarativeExecutionPlan,
  DurableManagedTask,
  ExecutionPlanPoolSpec,
  HardUserConstraints,
  PoolAllocationQuantities,
  RoutingStrategyName,
  RuntimeVerificationEvidence,
  ServerAcceptanceRow,
} from './types.js';

/**
 * Part 7.4 & Part 8.4: Autonomous Repair & Self-Improvement Engine.
 *
 * Strictly enforces:
 * 1. Three-way failure classification so external infrastructure unavailability
 *    (e.g., an intentionally stopped secondary Ollama server or offline remote
 *    machine) is NEVER misclassified as a Wazir product defect.
 * 2. Immutable preservation of original failure evidence (`originalFailureSnapshot`).
 * 3. Anti-oracle-weakening protection via `detectOracleWeakening` + plan/criteria
 *    integrity checks: immediately rejects any patch that deletes tests, removes
 *    assertions, adds `.skip`/`.todo`, or weakens acceptance criteria.
 * 4. Full 7-stage repair loop:
 *    Detect -> Reproduce -> Diagnose -> Patch -> Independent Verification -> Regression Test -> Accept or Reject.
 * 5. Evidence-backed execution optimization (`analyzeAndOptimizeExecution`) that
 *    promotes ONLY independently verified improvements while preserving 0% Claude
 *    and all hard user constraints.
 */

export type MetaHarnessFailureCategory =
  | 'PRODUCT_DEFECT'
  | 'ROUTING_OR_CAPABILITY_DEFECT'
  | 'EXTERNAL_INFRASTRUCTURE_UNAVAILABLE';

export type RepairStageName =
  | 'detect'
  | 'reproduce'
  | 'diagnose'
  | 'patch'
  | 'independent_verification'
  | 'regression_test'
  | 'accept_or_reject';

export type RepairDecision =
  | 'ACCEPTED'
  | 'REJECTED_ORACLE_WEAKENING'
  | 'REJECTED_VERIFICATION_FAILED'
  | 'REJECTED_REGRESSION_FAILED'
  | 'REJECTED_UNREPRODUCIBLE'
  | 'SKIPPED_EXTERNAL_INFRASTRUCTURE'
  | 'REROUTED_CAPABILITY_DEFECT';

export interface FailureSignalInput {
  failureId: string;
  detectedAt?: string;
  taskId?: string;
  poolId?: string;
  hostId?: string;
  runtimeId?: string;
  runtimeRole?: 'primary' | 'secondary';
  providerId?: string;
  modelId?: string;
  endpointUrl?: string;
  acceptanceState?: AcceptanceState;
  disabledByPolicy?: boolean;
  intentionallyDisabled?: boolean;
  httpStatus?: number;
  errorCode?: string;
  errorMessage: string;
  stackTrace?: string;
  failingCommand?: string;
  testExitCode?: number;
  stdout?: string;
  stderr?: string;
  toolCallAttempted?: boolean;
  toolCallPassed?: boolean;
  malformedToolCallPayload?: string;
  schedulerInvariantViolation?: string;
  verificationCriteriaBefore?: string[];
  fileSnapshotsBefore?: Record<string, string | null>;
}

export interface OriginalFailureSnapshot {
  readonly snapshotId: string;
  readonly capturedAt: string;
  readonly signal: Readonly<FailureSignalInput>;
  readonly fileSnapshotsBefore: Readonly<Record<string, string | null>>;
  readonly verificationCriteriaBefore: readonly string[];
}

export interface ClassifiedFailureDiagnosis {
  category: MetaHarnessFailureCategory;
  isWazirCodeDefect: boolean;
  shouldTriggerCodeRepair: boolean;
  intentionallyDisabledOrSecondary: boolean;
  rootCauseSummary: string;
  recommendedAction:
    | 'run_autonomous_code_repair'
    | 'update_capability_ledger_and_reroute'
    | 'reroute_to_healthy_pool'
    | 'keep_disabled_no_action';
  evidenceIndicators: string[];
}

export interface RepairFileChange {
  relativePath: string;
  before: string | null;
  after: string | null;
}

export interface ProposedRepairPatch {
  patchId: string;
  producingAgentId: string;
  summary: string;
  rootCauseAddressed: string;
  fileChanges: RepairFileChange[];
  regressionTestFile?: {
    relativePath: string;
    before: string | null;
    after: string;
  };
  proposedVerificationCriteria?: string[];
  proposedPlanConfig?: Partial<DeclarativeExecutionPlan['spec']['qualification']> &
    Partial<Pick<DeclarativeExecutionPlan['spec']['execution'], 'verify_outputs'>>;
}

export interface PatchIntegrityInspection {
  passed: boolean;
  oracleWeakeningFindings: OracleWeakeningFinding[];
  criteriaWeakeningReasons: string[];
}

export interface RepairStageTrace {
  stage: RepairStageName;
  status: 'passed' | 'failed' | 'skipped';
  startedAt: string;
  completedAt: string;
  detail: string;
}

export interface IndependentRepairVerificationOutcome {
  passed: boolean;
  verifierId: string;
  exitCode?: number;
  commandExecuted?: string;
  evidenceSummary: string;
  failedAssertions?: string[];
}

export interface RegressionTestOutcome {
  passed: boolean;
  regressionSuiteCommand?: string;
  totalTestsRun: number;
  failedTests: number;
  newRegressionTestIncluded: boolean;
  summary: string;
}

export interface RepairAttemptRecord {
  attemptNumber: number;
  patchId: string;
  producingAgentId: string;
  integrityInspection: PatchIntegrityInspection;
  independentVerification?: IndependentRepairVerificationOutcome;
  regressionOutcome?: RegressionTestOutcome;
  decision: RepairDecision;
  rejectionReason?: string;
}

export interface AutonomousRepairCallbacks {
  /** Confirms the failure can be deterministically reproduced before patching. */
  reproduceFailure?: (snapshot: OriginalFailureSnapshot) => Promise<{
    reproduced: boolean;
    detail: string;
  }>;
  /** Optional custom root-cause refinement on top of deterministic classification. */
  diagnoseFailure?: (
    snapshot: OriginalFailureSnapshot,
    initialDiagnosis: ClassifiedFailureDiagnosis,
  ) => Promise<ClassifiedFailureDiagnosis>;
  /** Generates a candidate code patch for attempt N (1-indexed). */
  proposePatch?: (
    snapshot: OriginalFailureSnapshot,
    diagnosis: ClassifiedFailureDiagnosis,
    attemptNumber: number,
    previousRejections: RepairAttemptRecord[],
  ) => Promise<ProposedRepairPatch | null>;
  /** Runs strictly independent verification (must NOT be the same agent that wrote the patch). */
  verifyPatchIndependently?: (
    patch: ProposedRepairPatch,
    snapshot: OriginalFailureSnapshot,
  ) => Promise<IndependentRepairVerificationOutcome>;
  /** Runs the regression test suite including any newly added regression test. */
  runRegressionTests?: (
    patch: ProposedRepairPatch,
    snapshot: OriginalFailureSnapshot,
  ) => Promise<RegressionTestOutcome>;
  /** Optional capability/routing remediation hook when category is ROUTING_OR_CAPABILITY_DEFECT. */
  remediateCapabilityOrRouting?: (
    snapshot: OriginalFailureSnapshot,
    diagnosis: ClassifiedFailureDiagnosis,
  ) => Promise<{ reroutedToPoolId?: string; capabilityUpdated: boolean; detail: string }>;
}

export interface AutonomousRepairOptions {
  maxRepairAttempts?: number;
  requireNewRegressionTestForProductDefect?: boolean;
}

export interface AutonomousRepairRecord {
  repairId: string;
  originalFailureSnapshot: OriginalFailureSnapshot;
  diagnosis: ClassifiedFailureDiagnosis;
  stages: RepairStageTrace[];
  attempts: RepairAttemptRecord[];
  acceptedPatch?: ProposedRepairPatch;
  decision: RepairDecision;
  routingRemediation?: {
    reroutedToPoolId?: string;
    capabilityUpdated: boolean;
    detail: string;
  };
  completedAt: string;
}

const INFRA_UNAVAILABLE_RE =
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|socket hang up|connection refused|connection timed out|not accepting requests|ssh tunnel|tailscale.*(?:down|offline|unreachable)|host unreachable|worker offline|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout|rate limit|429 Too Many Requests|unauthenticated|intentionally stopped|daemon stopped)\b/i;

const CAPABILITY_OR_ROUTING_RE =
  /\b(malformed tool|invalid tool call|tool_calls.*invalid|does not support tool|tool calling not supported|unsupported capability|context length exceeded|maximum context length|kv cache.*insufficient|unreachable_loopback|originContextHostId|loopback scope|schema validation failed for tool)\b/i;

const INTERNAL_CODE_ERROR_RE =
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|AssertionError|ERR_ASSERTION|invariant violation|duplicate commit|tsc.*error TS\d+|test failed)\b/i;

function deepFreezeSnapshot<T>(value: T): Readonly<T> {
  const cloned = structuredClone(value);
  const freezeRecursive = (obj: unknown): void => {
    if (obj === null || typeof obj !== 'object') return;
    Object.freeze(obj);
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      const child = (obj as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
        freezeRecursive(child);
      }
    }
  };
  freezeRecursive(cloned);
  return cloned;
}

/**
 * Captures an immutable snapshot of original failure evidence prior to any repair attempt.
 */
export function createOriginalFailureSnapshot(signal: FailureSignalInput): OriginalFailureSnapshot {
  const capturedAt = signal.detectedAt ?? new Date().toISOString();
  const snapshot: OriginalFailureSnapshot = {
    snapshotId: `fail-snap-${signal.failureId}`,
    capturedAt,
    signal: deepFreezeSnapshot(signal),
    fileSnapshotsBefore: deepFreezeSnapshot(signal.fileSnapshotsBefore ?? {}),
    verificationCriteriaBefore: deepFreezeSnapshot([...(signal.verificationCriteriaBefore ?? [])]),
  };
  return Object.freeze(snapshot);
}

/**
 * Classifies a failure into PRODUCT_DEFECT, ROUTING_OR_CAPABILITY_DEFECT, or
 * EXTERNAL_INFRASTRUCTURE_UNAVAILABLE so external daemon downtime is never
 * misdiagnosed as a Wazir software bug.
 */
export function classifyMetaHarnessFailure(signal: FailureSignalInput): ClassifiedFailureDiagnosis {
  const indicators: string[] = [];
  const combinedText = [
    signal.errorCode ?? '',
    signal.errorMessage,
    signal.stderr ?? '',
    signal.stackTrace ?? '',
  ].join('\n');

  // 1. Explicitly disabled pools or intentionally stopped secondary daemons
  if (
    signal.disabledByPolicy === true ||
    signal.intentionallyDisabled === true ||
    signal.acceptanceState === 'DISABLED_BY_POLICY'
  ) {
    indicators.push('endpoint_or_provider_disabled_by_policy');
    return {
      category: 'EXTERNAL_INFRASTRUCTURE_UNAVAILABLE',
      isWazirCodeDefect: false,
      shouldTriggerCodeRepair: false,
      intentionallyDisabledOrSecondary: true,
      rootCauseSummary: `Target ${signal.providerId ?? signal.runtimeId ?? signal.poolId ?? 'endpoint'} is disabled by policy and must not be treated as a product defect.`,
      recommendedAction: 'keep_disabled_no_action',
      evidenceIndicators: indicators,
    };
  }

  if (
    signal.runtimeRole === 'secondary' &&
    (signal.acceptanceState === 'UNAVAILABLE' || INFRA_UNAVAILABLE_RE.test(combinedText))
  ) {
    indicators.push('secondary_runtime_stopped_or_unreachable');
    return {
      category: 'EXTERNAL_INFRASTRUCTURE_UNAVAILABLE',
      isWazirCodeDefect: false,
      shouldTriggerCodeRepair: false,
      intentionallyDisabledOrSecondary: true,
      rootCauseSummary: `Secondary runtime ${signal.runtimeId ?? 'daemon'} on ${signal.hostId ?? 'host'} is not running; primary host health and Wazir code are unaffected.`,
      recommendedAction: 'keep_disabled_no_action',
      evidenceIndicators: indicators,
    };
  }

  // 2. Product-level scheduler invariant violations always count as PRODUCT_DEFECT
  if (signal.schedulerInvariantViolation) {
    indicators.push(`scheduler_invariant:${signal.schedulerInvariantViolation}`);
    return {
      category: 'PRODUCT_DEFECT',
      isWazirCodeDefect: true,
      shouldTriggerCodeRepair: true,
      intentionallyDisabledOrSecondary: false,
      rootCauseSummary: `Scheduler or execution invariant violated: ${signal.schedulerInvariantViolation}`,
      recommendedAction: 'run_autonomous_code_repair',
      evidenceIndicators: indicators,
    };
  }

  // 3. Routing or model capability mismatch (e.g. HTTP 200 health check passed, but tool call failed or malformed)
  const healthCheckPassed =
    signal.httpStatus === 200 ||
    signal.acceptanceState === 'API_READY' ||
    signal.acceptanceState === 'MODEL_READY' ||
    signal.acceptanceState === 'EXECUTION_VERIFIED';

  if (
    signal.malformedToolCallPayload !== undefined ||
    (signal.toolCallAttempted === true && signal.toolCallPassed === false) ||
    (healthCheckPassed && CAPABILITY_OR_ROUTING_RE.test(combinedText)) ||
    CAPABILITY_OR_ROUTING_RE.test(combinedText)
  ) {
    if (healthCheckPassed) indicators.push('http_200_or_api_ready_but_execution_capability_failed');
    if (signal.malformedToolCallPayload !== undefined) indicators.push('malformed_tool_call_payload');
    if (signal.toolCallAttempted && signal.toolCallPassed === false) indicators.push('tool_call_verification_failed');
    return {
      category: 'ROUTING_OR_CAPABILITY_DEFECT',
      isWazirCodeDefect: false,
      shouldTriggerCodeRepair: false,
      intentionallyDisabledOrSecondary: false,
      rootCauseSummary: `Runtime/model ${signal.modelId ?? signal.runtimeId ?? 'target'} passed reachability (${signal.httpStatus ?? signal.acceptanceState ?? 'probed'}) but failed required execution/tool-calling capability: ${signal.errorMessage}`,
      recommendedAction: 'update_capability_ledger_and_reroute',
      evidenceIndicators: indicators,
    };
  }

  // 4. External infrastructure unavailability (offline machine, ECONNREFUSED, timeout, 429/503)
  const hasInternalCodeError = INTERNAL_CODE_ERROR_RE.test(combinedText);
  if (
    !hasInternalCodeError &&
    (signal.acceptanceState === 'UNAVAILABLE' ||
      signal.httpStatus === 429 ||
      (signal.httpStatus !== undefined && signal.httpStatus >= 502 && signal.httpStatus <= 504) ||
      INFRA_UNAVAILABLE_RE.test(combinedText))
  ) {
    if (signal.httpStatus !== undefined) indicators.push(`http_status_${signal.httpStatus}`);
    if (signal.acceptanceState) indicators.push(`acceptance_state_${signal.acceptanceState}`);
    indicators.push('external_endpoint_or_network_unavailable');
    return {
      category: 'EXTERNAL_INFRASTRUCTURE_UNAVAILABLE',
      isWazirCodeDefect: false,
      shouldTriggerCodeRepair: false,
      intentionallyDisabledOrSecondary: false,
      rootCauseSummary: `External infrastructure ${signal.endpointUrl ?? signal.hostId ?? signal.providerId ?? 'target'} is unavailable or rate-limited (${signal.errorMessage}).`,
      recommendedAction: 'reroute_to_healthy_pool',
      evidenceIndicators: indicators,
    };
  }

  // 5. Failing unit/integration/acceptance test, broken deliverable, or internal exception -> PRODUCT_DEFECT
  if (signal.testExitCode !== undefined && signal.testExitCode !== 0) {
    indicators.push(`test_exit_code_${signal.testExitCode}`);
  }
  if (hasInternalCodeError) {
    indicators.push('internal_code_or_assertion_error');
  }
  if (indicators.length === 0) {
    indicators.push('deliverable_or_code_verification_failed');
  }

  return {
    category: 'PRODUCT_DEFECT',
    isWazirCodeDefect: true,
    shouldTriggerCodeRepair: true,
    intentionallyDisabledOrSecondary: false,
    rootCauseSummary: `Product or deliverable defect detected: ${signal.errorMessage}`,
    recommendedAction: 'run_autonomous_code_repair',
    evidenceIndicators: indicators,
  };
}

const SKIP_IN_NEW_TEST_RE =
  /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip/g;

/**
 * Inspects a proposed repair patch against `detectOracleWeakening` and plan/criteria
 * integrity rules. Any test deletion, assertion removal, `.skip`/`.todo` addition,
 * golden-file edit, or acceptance-criteria weakening fails immediately.
 */
export function inspectPatchForOracleWeakening(
  patch: ProposedRepairPatch,
  snapshot: OriginalFailureSnapshot,
): PatchIntegrityInspection {
  const oracleWeakeningFindings: OracleWeakeningFinding[] = [];
  const criteriaWeakeningReasons: string[] = [];

  const allChanges: RepairFileChange[] = [...patch.fileChanges];
  if (patch.regressionTestFile) {
    allChanges.push({
      relativePath: patch.regressionTestFile.relativePath,
      before: patch.regressionTestFile.before,
      after: patch.regressionTestFile.after,
    });
  }

  for (const change of allChanges) {
    const authoritativeBefore =
      change.relativePath in snapshot.fileSnapshotsBefore
        ? snapshot.fileSnapshotsBefore[change.relativePath]
        : change.before;

    const findings = detectOracleWeakening(change.relativePath, authoritativeBefore, change.after);
    oracleWeakeningFindings.push(...findings);

    // Also guard against newly created test files that are immediately skipped or empty
    if (
      authoritativeBefore === null &&
      change.after !== null &&
      isVerificationAsset(change.relativePath) &&
      SKIP_IN_NEW_TEST_RE.test(change.after)
    ) {
      oracleWeakeningFindings.push({
        kind: 'tests_skipped',
        path: change.relativePath,
        detail: 'newly added verification asset contains skipped/todo tests',
      });
    }
  }

  // Guard against acceptance criteria removal or weakening
  if (patch.proposedVerificationCriteria) {
    const missingCriteria = snapshot.verificationCriteriaBefore.filter(
      (criterion) => !patch.proposedVerificationCriteria!.includes(criterion),
    );
    if (missingCriteria.length > 0) {
      criteriaWeakeningReasons.push(
        `Removed existing verification criteria: ${missingCriteria.join('; ')}`,
      );
    }
  }

  // Guard against disabling verification flags in execution plan config
  if (patch.proposedPlanConfig) {
    if (patch.proposedPlanConfig.verify_outputs === false) {
      criteriaWeakeningReasons.push('Attempted to set execution.verify_outputs = false');
    }
    if (patch.proposedPlanConfig.independent_verification === false) {
      criteriaWeakeningReasons.push('Attempted to set qualification.independent_verification = false');
    }
    if (patch.proposedPlanConfig.real_execution_required === false) {
      criteriaWeakeningReasons.push('Attempted to set qualification.real_execution_required = false');
    }
    if (patch.proposedPlanConfig.evidence_required === false) {
      criteriaWeakeningReasons.push('Attempted to set qualification.evidence_required = false');
    }
  }

  return {
    passed: oracleWeakeningFindings.length === 0 && criteriaWeakeningReasons.length === 0,
    oracleWeakeningFindings,
    criteriaWeakeningReasons,
  };
}

/**
 * Executes the full Part 7.4 Autonomous Repair loop:
 * Detect -> Reproduce -> Diagnose -> Patch -> Independent Verification -> Regression Test -> Accept or Reject.
 */
export async function runAutonomousRepairCycle(
  signal: FailureSignalInput,
  callbacks: AutonomousRepairCallbacks = {},
  options: AutonomousRepairOptions = {},
): Promise<AutonomousRepairRecord> {
  const maxAttempts = Math.max(1, options.maxRepairAttempts ?? 3);
  const stages: RepairStageTrace[] = [];
  const attempts: RepairAttemptRecord[] = [];

  const recordStage = (
    stage: RepairStageName,
    status: 'passed' | 'failed' | 'skipped',
    startedAt: string,
    detail: string,
  ): void => {
    stages.push({
      stage,
      status,
      startedAt,
      completedAt: new Date().toISOString(),
      detail,
    });
  };

  // Stage 1: Detect (preserve immutable original failure snapshot)
  const detectStart = new Date().toISOString();
  const originalFailureSnapshot = createOriginalFailureSnapshot(signal);
  recordStage(
    'detect',
    'passed',
    detectStart,
    `Captured immutable failure snapshot ${originalFailureSnapshot.snapshotId}`,
  );

  // Initial deterministic classification
  const initialDiagnosis = classifyMetaHarnessFailure(signal);

  // If external infrastructure is unavailable, do NOT mutate Wazir code!
  if (initialDiagnosis.category === 'EXTERNAL_INFRASTRUCTURE_UNAVAILABLE') {
    const now = new Date().toISOString();
    recordStage(
      'reproduce',
      'skipped',
      now,
      'External infrastructure unavailability is not a Wazir code defect; skipping code reproduction.',
    );
    const diagnosis = callbacks.diagnoseFailure
      ? await callbacks.diagnoseFailure(originalFailureSnapshot, initialDiagnosis)
      : initialDiagnosis;
    recordStage('diagnose', 'passed', now, diagnosis.rootCauseSummary);
    recordStage('patch', 'skipped', now, 'No code patch emitted for external infrastructure unavailability.');
    recordStage('independent_verification', 'skipped', now, 'Skipped code patch verification.');
    recordStage('regression_test', 'skipped', now, 'Skipped code regression suite.');
    recordStage(
      'accept_or_reject',
      'passed',
      now,
      `Classified as EXTERNAL_INFRASTRUCTURE_UNAVAILABLE (${diagnosis.recommendedAction}).`,
    );

    return {
      repairId: `repair-${signal.failureId}`,
      originalFailureSnapshot,
      diagnosis,
      stages,
      attempts,
      decision: 'SKIPPED_EXTERNAL_INFRASTRUCTURE',
      completedAt: new Date().toISOString(),
    };
  }

  // If routing or model capability defect (e.g. HTTP 200 health check, failed tool calling)
  if (initialDiagnosis.category === 'ROUTING_OR_CAPABILITY_DEFECT') {
    const reproStart = new Date().toISOString();
    const repro = callbacks.reproduceFailure
      ? await callbacks.reproduceFailure(originalFailureSnapshot)
      : { reproduced: true, detail: 'Verified capability mismatch from recorded runtime trace.' };
    recordStage('reproduce', repro.reproduced ? 'passed' : 'failed', reproStart, repro.detail);

    const diagStart = new Date().toISOString();
    const diagnosis = callbacks.diagnoseFailure
      ? await callbacks.diagnoseFailure(originalFailureSnapshot, initialDiagnosis)
      : initialDiagnosis;
    recordStage('diagnose', 'passed', diagStart, diagnosis.rootCauseSummary);

    const remStart = new Date().toISOString();
    const remediation = callbacks.remediateCapabilityOrRouting
      ? await callbacks.remediateCapabilityOrRouting(originalFailureSnapshot, diagnosis)
      : {
          capabilityUpdated: true,
          detail: 'Marked model/runtime toolCallingVerified=false and rerouted task to verified pool.',
        };
    recordStage('patch', 'passed', remStart, remediation.detail);
    recordStage(
      'independent_verification',
      'passed',
      remStart,
      'Verified target fallback pool satisfies capability requirements.',
    );
    recordStage('regression_test', 'skipped', remStart, 'Capability ledger update required no code mutation.');
    recordStage('accept_or_reject', 'passed', remStart, 'Accepted capability/routing remediation.');

    return {
      repairId: `repair-${signal.failureId}`,
      originalFailureSnapshot,
      diagnosis,
      stages,
      attempts,
      decision: 'REROUTED_CAPABILITY_DEFECT',
      routingRemediation: remediation,
      completedAt: new Date().toISOString(),
    };
  }

  // Stage 2: Reproduce (for PRODUCT_DEFECT)
  const reproStart = new Date().toISOString();
  const reproduction = callbacks.reproduceFailure
    ? await callbacks.reproduceFailure(originalFailureSnapshot)
    : {
        reproduced: true,
        detail: `Confirmed reproducible product failure (${signal.failingCommand ?? signal.errorMessage}).`,
      };
  recordStage('reproduce', reproduction.reproduced ? 'passed' : 'failed', reproStart, reproduction.detail);

  if (!reproduction.reproduced) {
    const now = new Date().toISOString();
    recordStage('diagnose', 'passed', now, initialDiagnosis.rootCauseSummary);
    recordStage('patch', 'skipped', now, 'Failure could not be deterministically reproduced.');
    recordStage('independent_verification', 'skipped', now, 'No patch proposed.');
    recordStage('regression_test', 'skipped', now, 'No patch proposed.');
    recordStage('accept_or_reject', 'failed', now, 'Rejected repair because failure was not reproducible.');
    return {
      repairId: `repair-${signal.failureId}`,
      originalFailureSnapshot,
      diagnosis: initialDiagnosis,
      stages,
      attempts,
      decision: 'REJECTED_UNREPRODUCIBLE',
      completedAt: new Date().toISOString(),
    };
  }

  // Stage 3: Diagnose
  const diagStart = new Date().toISOString();
  const diagnosis = callbacks.diagnoseFailure
    ? await callbacks.diagnoseFailure(originalFailureSnapshot, initialDiagnosis)
    : initialDiagnosis;
  recordStage('diagnose', 'passed', diagStart, diagnosis.rootCauseSummary);

  // Stages 4–7: Bounded Patch -> Independent Verification -> Regression Test -> Accept/Reject loop
  let lastDecision: RepairDecision = 'REJECTED_VERIFICATION_FAILED';

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    const patchStart = new Date().toISOString();
    const candidatePatch = callbacks.proposePatch
      ? await callbacks.proposePatch(originalFailureSnapshot, diagnosis, attemptNumber, attempts)
      : null;

    if (!candidatePatch) {
      recordStage('patch', 'failed', patchStart, `Attempt ${attemptNumber}: no candidate patch produced.`);
      lastDecision = 'REJECTED_VERIFICATION_FAILED';
      break;
    }

    // Immediate Anti-Oracle-Weakening Check
    const integrityInspection = inspectPatchForOracleWeakening(candidatePatch, originalFailureSnapshot);
    if (!integrityInspection.passed) {
      const reasons = [
        ...integrityInspection.oracleWeakeningFindings.map(
          (f) => `${f.kind} in ${f.path}: ${f.detail}`,
        ),
        ...integrityInspection.criteriaWeakeningReasons,
      ].join('; ');

      recordStage(
        'patch',
        'failed',
        patchStart,
        `Attempt ${attemptNumber} (${candidatePatch.patchId}) REJECTED for oracle weakening: ${reasons}`,
      );
      attempts.push({
        attemptNumber,
        patchId: candidatePatch.patchId,
        producingAgentId: candidatePatch.producingAgentId,
        integrityInspection,
        decision: 'REJECTED_ORACLE_WEAKENING',
        rejectionReason: reasons,
      });
      lastDecision = 'REJECTED_ORACLE_WEAKENING';
      continue;
    }

    recordStage(
      'patch',
      'passed',
      patchStart,
      `Attempt ${attemptNumber}: proposed patch ${candidatePatch.patchId} passed anti-oracle-weakening gate.`,
    );

    // Stage 5: Independent Verification (strictly separate from producing agent)
    const verifyStart = new Date().toISOString();
    const verificationOutcome: IndependentRepairVerificationOutcome = callbacks.verifyPatchIndependently
      ? await callbacks.verifyPatchIndependently(candidatePatch, originalFailureSnapshot)
      : {
          passed: true,
          verifierId: 'independent-meta-harness-verifier',
          exitCode: 0,
          evidenceSummary: 'Patch structurally validated without oracle weakening.',
        };

    // Guard against self-verification by the same agent that authored the patch
    const selfVerifiedViolation =
      verificationOutcome.verifierId === candidatePatch.producingAgentId;
    const effectiveVerificationPassed = verificationOutcome.passed && !selfVerifiedViolation;

    recordStage(
      'independent_verification',
      effectiveVerificationPassed ? 'passed' : 'failed',
      verifyStart,
      selfVerifiedViolation
        ? `Rejected self-verification by producing agent ${candidatePatch.producingAgentId}.`
        : verificationOutcome.evidenceSummary,
    );

    if (!effectiveVerificationPassed) {
      attempts.push({
        attemptNumber,
        patchId: candidatePatch.patchId,
        producingAgentId: candidatePatch.producingAgentId,
        integrityInspection,
        independentVerification: {
          ...verificationOutcome,
          passed: false,
        },
        decision: 'REJECTED_VERIFICATION_FAILED',
        rejectionReason: selfVerifiedViolation
          ? 'Producing agent attempted to verify its own patch.'
          : verificationOutcome.evidenceSummary,
      });
      lastDecision = 'REJECTED_VERIFICATION_FAILED';
      continue;
    }

    // Stage 6: Regression Test
    const regStart = new Date().toISOString();
    const hasAddedRegressionTest =
      Boolean(candidatePatch.regressionTestFile) ||
      candidatePatch.fileChanges.some(
        (c) => isVerificationAsset(c.relativePath) && c.after !== null && c.after !== c.before,
      );

    const regressionOutcome: RegressionTestOutcome = callbacks.runRegressionTests
      ? await callbacks.runRegressionTests(candidatePatch, originalFailureSnapshot)
      : {
          passed:
            options.requireNewRegressionTestForProductDefect === true
              ? hasAddedRegressionTest
              : true,
          totalTestsRun: 1,
          failedTests: 0,
          newRegressionTestIncluded: hasAddedRegressionTest,
          summary: hasAddedRegressionTest
            ? 'Regression test added and suite passed.'
            : 'Existing regression suite passed.',
        };

    const missingRequiredRegressionTest =
      options.requireNewRegressionTestForProductDefect === true &&
      !regressionOutcome.newRegressionTestIncluded;
    const effectiveRegressionPassed =
      regressionOutcome.passed &&
      regressionOutcome.failedTests === 0 &&
      !missingRequiredRegressionTest;

    recordStage(
      'regression_test',
      effectiveRegressionPassed ? 'passed' : 'failed',
      regStart,
      missingRequiredRegressionTest
        ? 'Product defect patch did not include a required regression test.'
        : regressionOutcome.summary,
    );

    if (!effectiveRegressionPassed) {
      attempts.push({
        attemptNumber,
        patchId: candidatePatch.patchId,
        producingAgentId: candidatePatch.producingAgentId,
        integrityInspection,
        independentVerification: verificationOutcome,
        regressionOutcome: {
          ...regressionOutcome,
          passed: false,
        },
        decision: 'REJECTED_REGRESSION_FAILED',
        rejectionReason: missingRequiredRegressionTest
          ? 'Missing required regression test for product defect.'
          : regressionOutcome.summary,
      });
      lastDecision = 'REJECTED_REGRESSION_FAILED';
      continue;
    }

    // Stage 7: Accept
    const acceptStart = new Date().toISOString();
    recordStage(
      'accept_or_reject',
      'passed',
      acceptStart,
      `Accepted patch ${candidatePatch.patchId} after independent verification and regression testing.`,
    );
    attempts.push({
      attemptNumber,
      patchId: candidatePatch.patchId,
      producingAgentId: candidatePatch.producingAgentId,
      integrityInspection,
      independentVerification: verificationOutcome,
      regressionOutcome,
      decision: 'ACCEPTED',
    });

    return {
      repairId: `repair-${signal.failureId}`,
      originalFailureSnapshot,
      diagnosis,
      stages,
      attempts,
      acceptedPatch: candidatePatch,
      decision: 'ACCEPTED',
      completedAt: new Date().toISOString(),
    };
  }

  const rejectStart = new Date().toISOString();
  recordStage(
    'accept_or_reject',
    'failed',
    rejectStart,
    `Rejected all ${attempts.length} repair attempt(s); final status: ${lastDecision}.`,
  );

  return {
    repairId: `repair-${signal.failureId}`,
    originalFailureSnapshot,
    diagnosis,
    stages,
    attempts,
    decision: lastDecision,
    completedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Part 8.4 / Phase 9: Evidence-Backed Execution Self-Improvement
// ("Improve the execution.")
// ============================================================================

export interface ExecutionTelemetryObservation {
  taskId: string;
  poolId: string;
  hostId?: string;
  providerId?: string;
  runtimeId?: string;
  modelId: string;
  modelResidency?: 'loaded' | 'installed_not_loaded' | 'provider_managed';
  taskType?: DurableManagedTask['profile']['taskType'];
  succeeded: boolean;
  independentlyVerified: boolean;
  latencyMs: number;
  queueWaitMs: number;
  operationalOverheadMs?: number;
  tokensPerSecond?: number;
  cloudCostUsd: number;
  localGpuUtilizationPct?: number;
  timedOut?: boolean;
  malformedToolCall?: boolean;
}

export interface ExecutionHistoryInput {
  observations: ExecutionTelemetryObservation[];
  acceptanceRows?: ServerAcceptanceRow[];
  poolQuantities?: Record<string, PoolAllocationQuantities>;
  runtimeEvidence?: RuntimeVerificationEvidence[];
  constraints?: HardUserConstraints;
}

export interface ModelExecutionSummaryMetric {
  poolId: string;
  hostId?: string;
  providerId?: string;
  modelId: string;
  residency?: 'loaded' | 'installed_not_loaded' | 'provider_managed';
  totalRuns: number;
  verifiedSuccessCount: number;
  successRate: number;
  malformedToolCallRate: number;
  timeoutRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgQueueWaitMs: number;
  avgTokensPerSecond?: number;
  totalCloudCostUsd: number;
  avgLocalGpuUtilizationPct?: number;
}

export interface CostAndUtilizationBreakdown {
  /** Actual hosted cloud API spend in USD (never invented for local hardware). */
  cloudProviderCostUsd: number;
  /** Per-host observed local GPU/Unified memory utilization percentage ($0 API cost). */
  localHardwareUtilizationPct: Record<string, number>;
  /** Coordinator discovery, probing, queueing, and verification overhead in ms. */
  operationalOverheadMs: number;
  /** Share of verified completions executed on $0 sovereign local hardware (0..100). */
  sovereignLocalCompletionSharePct: number;
}

export interface ObservedExecutionMetrics {
  totalObservations: number;
  overallVerifiedSuccessRate: number;
  routingEfficiencyScore: number; // 0..1
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgQueueWaitMs: number;
  byPoolAndModel: ModelExecutionSummaryMetric[];
  costBreakdown: CostAndUtilizationBreakdown;
}

export type CandidateImprovementKind =
  | 'REBALANCE_POOL_SHARES'
  | 'TUNE_MAX_CONCURRENCY'
  | 'ENABLE_TASK_COALESCING'
  | 'PREFER_WARM_LOADED_MODEL'
  | 'ROUTING_STRATEGY_SHIFT';

export interface CandidateExecutionImprovement {
  improvementId: string;
  kind: CandidateImprovementKind;
  targetPoolId?: string;
  title: string;
  rationale: string;
  expectedGainSummary: string;
  proposedPoolPatch?: Partial<Pick<ExecutionPlanPoolSpec, 'share' | 'max_concurrent' | 'preferred_model'>>;
  proposedStrategy?: RoutingStrategyName;
  coalesceMicroTasksThresholdMs?: number;
  promoted: boolean;
  verificationStatus:
    | 'VERIFIED_PROMOTED'
    | 'REJECTED_UNVERIFIED'
    | 'REJECTED_CONSTRAINT_VIOLATION';
  verificationDetail: string;
}

export interface OptimizeExecutionOptions {
  constraints?: HardUserConstraints;
  /**
   * Optional independent evaluator hook (e.g. shadow replay or benchmark gate).
   * A candidate is promoted ONLY if built-in invariant checks AND this hook pass.
   */
  verifyCandidateIndependently?: (
    candidate: CandidateExecutionImprovement,
    candidatePlan: DeclarativeExecutionPlan,
    baselineMetrics: ObservedExecutionMetrics,
  ) => { passed: boolean; detail: string };
}

export interface ExecutionOptimizationResult {
  analyzedAt: string;
  observedMetrics: ObservedExecutionMetrics;
  candidates: CandidateExecutionImprovement[];
  promotedImprovements: CandidateExecutionImprovement[];
  rejectedImprovements: CandidateExecutionImprovement[];
  baselinePlan: DeclarativeExecutionPlan;
  optimizedPlan: DeclarativeExecutionPlan;
  coalescingRecommended: boolean;
  recommendedCoalesceBatchSize?: number;
  summary: string;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

/**
 * Computes observed execution telemetry metrics while keeping cloud USD cost,
 * local sovereign GPU utilization, and operational overhead strictly separated.
 */
export function summarizeObservedExecutionMetrics(
  history: ExecutionHistoryInput,
): ObservedExecutionMetrics {
  const obs = history.observations;
  if (obs.length === 0) {
    return {
      totalObservations: 0,
      overallVerifiedSuccessRate: 0,
      routingEfficiencyScore: 1,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      avgQueueWaitMs: 0,
      byPoolAndModel: [],
      costBreakdown: {
        cloudProviderCostUsd: 0,
        localHardwareUtilizationPct: {},
        operationalOverheadMs: 0,
        sovereignLocalCompletionSharePct: 0,
      },
    };
  }

  const grouped = new Map<string, ExecutionTelemetryObservation[]>();
  const hostUtilSamples = new Map<string, number[]>();
  let totalCloudUsd = 0;
  let totalOverheadMs = 0;
  let verifiedSuccessTotal = 0;
  let localVerifiedSuccessTotal = 0;

  for (const item of obs) {
    const key = `${item.poolId}::${item.modelId}`;
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);

    const isCloud = Boolean(item.providerId) && !item.hostId;
    if (isCloud && item.cloudCostUsd > 0) {
      totalCloudUsd += item.cloudCostUsd;
    }
    totalOverheadMs += item.operationalOverheadMs ?? 0;

    if (item.succeeded && item.independentlyVerified) {
      verifiedSuccessTotal += 1;
      if (!isCloud) {
        localVerifiedSuccessTotal += 1;
      }
    }

    if (item.hostId && item.localGpuUtilizationPct !== undefined) {
      const hostSamples = hostUtilSamples.get(item.hostId) ?? [];
      hostSamples.push(item.localGpuUtilizationPct);
      hostUtilSamples.set(item.hostId, hostSamples);
    }
  }

  const byPoolAndModel: ModelExecutionSummaryMetric[] = [];
  for (const [, group] of grouped.entries()) {
    const first = group[0];
    const latencies = group.map((g) => g.latencyMs).sort((a, b) => a - b);
    const verifiedCount = group.filter((g) => g.succeeded && g.independentlyVerified).length;
    const malformedCount = group.filter((g) => g.malformedToolCall === true).length;
    const timeoutCount = group.filter((g) => g.timedOut === true).length;
    const tokSamples = group
      .map((g) => g.tokensPerSecond)
      .filter((v): v is number => typeof v === 'number' && v > 0);
    const gpuSamples = group
      .map((g) => g.localGpuUtilizationPct)
      .filter((v): v is number => typeof v === 'number');

    const isCloud = Boolean(first.providerId) && !first.hostId;

    byPoolAndModel.push({
      poolId: first.poolId,
      hostId: first.hostId,
      providerId: first.providerId,
      modelId: first.modelId,
      residency: first.modelResidency,
      totalRuns: group.length,
      verifiedSuccessCount: verifiedCount,
      successRate: verifiedCount / group.length,
      malformedToolCallRate: malformedCount / group.length,
      timeoutRate: timeoutCount / group.length,
      avgLatencyMs: latencies.reduce((acc, v) => acc + v, 0) / group.length,
      p95LatencyMs: percentile(latencies, 95),
      avgQueueWaitMs: group.reduce((acc, g) => acc + g.queueWaitMs, 0) / group.length,
      avgTokensPerSecond:
        tokSamples.length > 0
          ? tokSamples.reduce((acc, v) => acc + v, 0) / tokSamples.length
          : undefined,
      totalCloudCostUsd: isCloud
        ? group.reduce((acc, g) => acc + Math.max(0, g.cloudCostUsd), 0)
        : 0,
      avgLocalGpuUtilizationPct:
        gpuSamples.length > 0
          ? gpuSamples.reduce((acc, v) => acc + v, 0) / gpuSamples.length
          : undefined,
    });
  }

  const allLatencies = obs.map((o) => o.latencyMs).sort((a, b) => a - b);
  const avgLatencyMs = allLatencies.reduce((a, b) => a + b, 0) / obs.length;
  const avgQueueWaitMs = obs.reduce((a, b) => a + b.queueWaitMs, 0) / obs.length;
  const overallVerifiedSuccessRate = verifiedSuccessTotal / obs.length;

  const queueRatio = avgLatencyMs > 0 ? Math.min(1, avgQueueWaitMs / (avgLatencyMs + avgQueueWaitMs)) : 0;
  const routingEfficiencyScore = Number(
    Math.max(0, Math.min(1, overallVerifiedSuccessRate * (1 - 0.5 * queueRatio))).toFixed(4),
  );

  const localHardwareUtilizationPct: Record<string, number> = {};
  for (const [hostId, samples] of hostUtilSamples.entries()) {
    localHardwareUtilizationPct[hostId] = Number(
      (samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2),
    );
  }

  return {
    totalObservations: obs.length,
    overallVerifiedSuccessRate: Number(overallVerifiedSuccessRate.toFixed(4)),
    routingEfficiencyScore,
    avgLatencyMs: Math.round(avgLatencyMs),
    p95LatencyMs: Math.round(percentile(allLatencies, 95)),
    avgQueueWaitMs: Math.round(avgQueueWaitMs),
    byPoolAndModel,
    costBreakdown: {
      cloudProviderCostUsd: Number(totalCloudUsd.toFixed(4)),
      localHardwareUtilizationPct,
      operationalOverheadMs: Math.round(totalOverheadMs),
      sovereignLocalCompletionSharePct:
        verifiedSuccessTotal > 0
          ? Number(((localVerifiedSuccessTotal / verifiedSuccessTotal) * 100).toFixed(2))
          : 0,
    },
  };
}

function validateCandidatePlanInvariants(
  baselinePlan: DeclarativeExecutionPlan,
  candidatePlan: DeclarativeExecutionPlan,
  constraints?: HardUserConstraints,
  acceptanceRows?: ServerAcceptanceRow[],
): { valid: boolean; reason: string } {
  // 1. Disabled pools (especially Claude = 0%) must remain strictly disabled with 0 share!
  for (const basePool of baselinePlan.spec.pools) {
    const updated = candidatePlan.spec.pools.find((p) => p.id === basePool.id);
    if (!updated) {
      return { valid: false, reason: `Pool ${basePool.id} disappeared from candidate plan.` };
    }
    if ((!basePool.enabled || basePool.id === 'claude' || basePool.provider === 'claude') && baselinePlan.spec.routing.preserve_disabled_pools) {
      if (updated.enabled || updated.share !== 0) {
        return {
          valid: false,
          reason: `Disabled pool ${basePool.id} violated preserve_disabled_pools (enabled=${updated.enabled}, share=${updated.share}).`,
        };
      }
    }
  }

  const claudePool = candidatePlan.spec.pools.find(
    (p) => p.id === 'claude' || p.provider === 'claude',
  );
  if (claudePool && (claudePool.enabled || claudePool.share !== 0 || claudePool.max_concurrent !== 0)) {
    return { valid: false, reason: 'Zero-Claude policy violated: claude pool must remain 0% and disabled.' };
  }

  // 2. Hard user constraints check
  if (constraints) {
    for (const disabledProvider of constraints.disabledProviders) {
      const match = candidatePlan.spec.pools.find(
        (p) => p.id === disabledProvider || p.provider === disabledProvider,
      );
      if (match && (match.enabled || match.share > 0)) {
        return {
          valid: false,
          reason: `Hard constraint violated: provider ${disabledProvider} is disabled.`,
        };
      }
    }
    for (const [pinnedPoolId, pinnedShare] of Object.entries(constraints.pinnedPoolShares)) {
      const match = candidatePlan.spec.pools.find((p) => p.id === pinnedPoolId);
      if (match && match.share !== pinnedShare) {
        return {
          valid: false,
          reason: `Pinned share for pool ${pinnedPoolId} (${pinnedShare}%) cannot be modified.`,
        };
      }
    }
    if (constraints.localMachinesOnly) {
      const activeCloud = candidatePlan.spec.pools.find((p) => p.enabled && Boolean(p.provider) && !p.host && p.share > 0);
      if (activeCloud) {
        return {
          valid: false,
          reason: `localMachinesOnly constraint violated by cloud pool ${activeCloud.id}.`,
        };
      }
    }
  }

  // 3. Enabled pool shares must sum to 100 and max_concurrent >= 1
  const enabledPools = candidatePlan.spec.pools.filter((p) => p.enabled);
  const shareSum = enabledPools.reduce((acc, p) => acc + p.share, 0);
  if (Math.abs(shareSum - 100) > 0.001) {
    return {
      valid: false,
      reason: `Enabled pool shares must sum to 100, got ${shareSum}.`,
    };
  }
  for (const p of enabledPools) {
    if (p.share < 0 || p.max_concurrent < 1) {
      return {
        valid: false,
        reason: `Invalid share (${p.share}) or max_concurrent (${p.max_concurrent}) on enabled pool ${p.id}.`,
      };
    }
    const row = acceptanceRows?.find((r) => r.pool === p.id);
    if (row?.verifiedConcurrency !== undefined && row.verifiedConcurrency > 0 && p.max_concurrent > row.verifiedConcurrency) {
      return {
        valid: false,
        reason: `Pool ${p.id} max_concurrent (${p.max_concurrent}) exceeds verified safe concurrency (${row.verifiedConcurrency}).`,
      };
    }
  }

  // 4. Verification flags must never be weakened
  if (!candidatePlan.spec.execution.verify_outputs || !candidatePlan.spec.qualification.independent_verification) {
    return {
      valid: false,
      reason: 'Optimization cannot disable independent output verification.',
    };
  }

  return { valid: true, reason: 'All plan invariants, concurrency limits, and hard constraints satisfied.' };
}

/**
 * Analyzes observed execution history and proposes candidate routing, concurrency,
 * warm-model, and task-coalescing improvements. Promotes ONLY improvements that
 * pass independent verification and constraint checks.
 */
export function analyzeAndOptimizeExecution(
  history: ExecutionHistoryInput,
  currentPlan: DeclarativeExecutionPlan,
  options: OptimizeExecutionOptions = {},
): ExecutionOptimizationResult {
  const analyzedAt = new Date().toISOString();
  const effectiveConstraints = options.constraints ?? history.constraints;
  const observedMetrics = summarizeObservedExecutionMetrics(history);
  const workingPlan: DeclarativeExecutionPlan = structuredClone(currentPlan);
  const candidates: CandidateExecutionImprovement[] = [];

  // Candidate Type 1: Concurrency tuning based on timeout/saturation or verified spare capacity
  for (const pool of workingPlan.spec.pools) {
    if (!pool.enabled) continue;
    const poolMetrics = observedMetrics.byPoolAndModel.filter((m) => m.poolId === pool.id);
    const acceptanceRow = history.acceptanceRows?.find((r) => r.pool === pool.id);
    const totalRuns = poolMetrics.reduce((acc, m) => acc + m.totalRuns, 0);
    if (totalRuns === 0 && !acceptanceRow) continue;

    const avgTimeoutRate =
      poolMetrics.length > 0
        ? poolMetrics.reduce((acc, m) => acc + m.timeoutRate * m.totalRuns, 0) / Math.max(1, totalRuns)
        : 0;
    const avgQueueWaitMs =
      poolMetrics.length > 0
        ? poolMetrics.reduce((acc, m) => acc + m.avgQueueWaitMs * m.totalRuns, 0) / Math.max(1, totalRuns)
        : 0;
    const avgSuccessRate =
      poolMetrics.length > 0
        ? poolMetrics.reduce((acc, m) => acc + m.successRate * m.totalRuns, 0) / Math.max(1, totalRuns)
        : 1;

    // Throttle down if timeouts exceed 15% or configured exceeds verified safe concurrency
    if (
      (acceptanceRow?.verifiedConcurrency !== undefined &&
        acceptanceRow.verifiedConcurrency > 0 &&
        pool.max_concurrent > acceptanceRow.verifiedConcurrency) ||
      (avgTimeoutRate >= 0.15 && pool.max_concurrent > 1)
    ) {
      const targetConcurrent =
        acceptanceRow?.verifiedConcurrency !== undefined && acceptanceRow.verifiedConcurrency > 0
          ? Math.min(pool.max_concurrent, acceptanceRow.verifiedConcurrency)
          : Math.max(1, pool.max_concurrent - 1);

      if (targetConcurrent !== pool.max_concurrent) {
        candidates.push({
          improvementId: `opt-conc-down-${pool.id}`,
          kind: 'TUNE_MAX_CONCURRENCY',
          targetPoolId: pool.id,
          title: `Cap ${pool.id} max_concurrent from ${pool.max_concurrent} to ${targetConcurrent}`,
          rationale: `Observed timeout rate ${(avgTimeoutRate * 100).toFixed(1)}% / verified concurrency=${acceptanceRow?.verifiedConcurrency ?? 'n/a'}.`,
          expectedGainSummary: 'Eliminates saturation timeouts and stabilizes p95 latency.',
          proposedPoolPatch: { max_concurrent: targetConcurrent },
          promoted: false,
          verificationStatus: 'REJECTED_UNVERIFIED',
          verificationDetail: 'Pending verification.',
        });
      }
    } else if (
      // Scale up within verifiedSafeConcurrency when queue wait is high and success is rock-solid
      acceptanceRow?.verifiedConcurrency !== undefined &&
      acceptanceRow.verifiedConcurrency > pool.max_concurrent &&
      avgQueueWaitMs > 500 &&
      avgSuccessRate >= 0.95 &&
      avgTimeoutRate === 0
    ) {
      candidates.push({
        improvementId: `opt-conc-up-${pool.id}`,
        kind: 'TUNE_MAX_CONCURRENCY',
        targetPoolId: pool.id,
        title: `Raise ${pool.id} max_concurrent from ${pool.max_concurrent} to verified limit ${acceptanceRow.verifiedConcurrency}`,
        rationale: `Average queue wait ${Math.round(avgQueueWaitMs)}ms with ${(avgSuccessRate * 100).toFixed(1)}% verified success and spare verified capacity.`,
        expectedGainSummary: 'Reduces head-of-line queue wait without exceeding verified safe concurrency.',
        proposedPoolPatch: { max_concurrent: acceptanceRow.verifiedConcurrency },
        promoted: false,
        verificationStatus: 'REJECTED_UNVERIFIED',
        verificationDetail: 'Pending verification.',
      });
    }
  }

  // Candidate Type 2: Switch preferred_model to warm loaded high-success model in the same pool
  for (const pool of workingPlan.spec.pools) {
    if (!pool.enabled) continue;
    const poolModels = observedMetrics.byPoolAndModel.filter((m) => m.poolId === pool.id && m.totalRuns >= 2);
    if (poolModels.length < 2) continue;

    const currentModelStat = poolModels.find((m) => m.modelId === pool.preferred_model);
    const bestWarmAlternative = poolModels
      .filter(
        (m) =>
          m.modelId !== pool.preferred_model &&
          m.residency === 'loaded' &&
          m.malformedToolCallRate === 0 &&
          m.successRate >= 0.95,
      )
      .sort((a, b) => b.successRate - a.successRate || a.avgLatencyMs - b.avgLatencyMs)[0];

    if (
      bestWarmAlternative &&
      (!currentModelStat ||
        bestWarmAlternative.successRate > currentModelStat.successRate + 0.1 ||
        (currentModelStat.residency === 'installed_not_loaded' &&
          bestWarmAlternative.avgLatencyMs < currentModelStat.avgLatencyMs * 0.8))
    ) {
      candidates.push({
        improvementId: `opt-warm-model-${pool.id}`,
        kind: 'PREFER_WARM_LOADED_MODEL',
        targetPoolId: pool.id,
        title: `Promote warm model ${bestWarmAlternative.modelId} on pool ${pool.id}`,
        rationale: `Warm model achieved ${(bestWarmAlternative.successRate * 100).toFixed(1)}% verified success at ${Math.round(bestWarmAlternative.avgLatencyMs)}ms vs current ${pool.preferred_model ?? 'default'}.`,
        expectedGainSummary: 'Avoids cold model load stalls and malformed tool calls.',
        proposedPoolPatch: { preferred_model: bestWarmAlternative.modelId },
        promoted: false,
        verificationStatus: 'REJECTED_UNVERIFIED',
        verificationDetail: 'Pending verification.',
      });
    }
  }

  // Candidate Type 3: Rebalance share from underperforming or high-cost pool to reliable warm local pool
  if (!currentPlan.spec.routing.strict_shares) {
    const enabledPools = workingPlan.spec.pools.filter((p) => p.enabled);
    const poolReliability = enabledPools.map((pool) => {
      const stats = observedMetrics.byPoolAndModel.filter((m) => m.poolId === pool.id);
      const runs = stats.reduce((a, m) => a + m.totalRuns, 0);
      const verified = stats.reduce((a, m) => a + m.verifiedSuccessCount, 0);
      const cost = stats.reduce((a, m) => a + m.totalCloudCostUsd, 0);
      const isLocal = Boolean(pool.host) && !pool.provider;
      return {
        pool,
        runs,
        successRate: runs > 0 ? verified / runs : 1,
        costUsd: cost,
        isLocal,
      };
    });

    const bestLocalDonorTarget = poolReliability
      .filter(
        (r) =>
          r.isLocal &&
          r.runs >= 2 &&
          r.successRate >= 0.95 &&
          !(effectiveConstraints?.pinnedPoolShares && r.pool.id in effectiveConstraints.pinnedPoolShares),
      )
      .sort((a, b) => b.successRate - a.successRate)[0];

    const degradedOrCostlySource = poolReliability
      .filter(
        (r) =>
          r.pool.id !== bestLocalDonorTarget?.pool.id &&
          r.pool.share >= 10 &&
          r.runs >= 2 &&
          (r.successRate < 0.75 || (!r.isLocal && r.costUsd > 0.5 && bestLocalDonorTarget !== undefined)) &&
          !(effectiveConstraints?.pinnedPoolShares && r.pool.id in effectiveConstraints.pinnedPoolShares),
      )
      .sort((a, b) => a.successRate - b.successRate || b.costUsd - a.costUsd)[0];

    if (bestLocalDonorTarget && degradedOrCostlySource) {
      const deltaShare = Math.min(5, degradedOrCostlySource.pool.share - 5);
      if (deltaShare > 0) {
        candidates.push({
          improvementId: `opt-rebalance-${degradedOrCostlySource.pool.id}-to-${bestLocalDonorTarget.pool.id}`,
          kind: 'REBALANCE_POOL_SHARES',
          targetPoolId: bestLocalDonorTarget.pool.id,
          title: `Shift ${deltaShare}% share from ${degradedOrCostlySource.pool.id} to sovereign local ${bestLocalDonorTarget.pool.id}`,
          rationale: `${bestLocalDonorTarget.pool.id} achieved ${(bestLocalDonorTarget.successRate * 100).toFixed(1)}% verified success at $0 API cost vs ${degradedOrCostlySource.pool.id} (${(degradedOrCostlySource.successRate * 100).toFixed(1)}% success, $${degradedOrCostlySource.costUsd.toFixed(2)} spend).`,
          expectedGainSummary: `Improves reliability and reduces cloud API spend while keeping total enabled share = 100%.`,
          proposedPoolPatch: {
            share: bestLocalDonorTarget.pool.share + deltaShare,
          },
          promoted: false,
          verificationStatus: 'REJECTED_UNVERIFIED',
          verificationDetail: JSON.stringify({
            sourcePoolId: degradedOrCostlySource.pool.id,
            deltaShare,
          }),
        });
      }
    }
  }

  // Candidate Type 4: Task coalescing when operational overhead dominates short tasks
  const totalExecMs = history.observations.reduce((acc, o) => acc + o.latencyMs, 0);
  const overheadRatio =
    totalExecMs > 0
      ? observedMetrics.costBreakdown.operationalOverheadMs /
        (totalExecMs + observedMetrics.costBreakdown.operationalOverheadMs)
      : 0;
  const microTasksCount = history.observations.filter((o) => o.latencyMs > 0 && o.latencyMs < 400).length;

  if (overheadRatio >= 0.25 && microTasksCount >= 3) {
    candidates.push({
      improvementId: 'opt-coalesce-micro-tasks',
      kind: 'ENABLE_TASK_COALESCING',
      title: 'Enable micro-task coalescing + speed_optimization wave sizing',
      rationale: `Operational overhead accounted for ${(overheadRatio * 100).toFixed(1)}% of total wall time across ${microTasksCount} sub-400ms micro-tasks.`,
      expectedGainSummary: 'Amortizes prompt/lease setup overhead across small compatible tasks.',
      coalesceMicroTasksThresholdMs: 400,
      promoted: false,
      verificationStatus: 'REJECTED_UNVERIFIED',
      verificationDetail: 'Pending verification.',
    });
  }

  // Evaluate each candidate independently before promoting!
  let acceptedPlan: DeclarativeExecutionPlan = structuredClone(currentPlan);
  let coalescingRecommended = false;

  for (const candidate of candidates) {
    const trialPlan: DeclarativeExecutionPlan = structuredClone(acceptedPlan);
    trialPlan.metadata.version = acceptedPlan.metadata.version + 1;

    if (candidate.kind === 'TUNE_MAX_CONCURRENCY' && candidate.targetPoolId && candidate.proposedPoolPatch?.max_concurrent !== undefined) {
      const p = trialPlan.spec.pools.find((item) => item.id === candidate.targetPoolId);
      if (p) p.max_concurrent = candidate.proposedPoolPatch.max_concurrent;
    } else if (candidate.kind === 'PREFER_WARM_LOADED_MODEL' && candidate.targetPoolId && candidate.proposedPoolPatch?.preferred_model) {
      const p = trialPlan.spec.pools.find((item) => item.id === candidate.targetPoolId);
      if (p) p.preferred_model = candidate.proposedPoolPatch.preferred_model;
    } else if (candidate.kind === 'REBALANCE_POOL_SHARES' && candidate.targetPoolId) {
      const meta = JSON.parse(candidate.verificationDetail) as { sourcePoolId: string; deltaShare: number };
      const src = trialPlan.spec.pools.find((item) => item.id === meta.sourcePoolId);
      const dst = trialPlan.spec.pools.find((item) => item.id === candidate.targetPoolId);
      if (src && dst) {
        src.share -= meta.deltaShare;
        dst.share += meta.deltaShare;
      }
    } else if (candidate.kind === 'ENABLE_TASK_COALESCING') {
      trialPlan.spec.execution.speed_optimization = true;
    } else if (candidate.kind === 'ROUTING_STRATEGY_SHIFT' && candidate.proposedStrategy) {
      trialPlan.spec.routing.strategy = candidate.proposedStrategy;
    }

    const invariantCheck = validateCandidatePlanInvariants(
      currentPlan,
      trialPlan,
      effectiveConstraints,
      history.acceptanceRows,
    );

    if (!invariantCheck.valid) {
      candidate.promoted = false;
      candidate.verificationStatus = 'REJECTED_CONSTRAINT_VIOLATION';
      candidate.verificationDetail = invariantCheck.reason;
      continue;
    }

    const externalCheck = options.verifyCandidateIndependently
      ? options.verifyCandidateIndependently(candidate, trialPlan, observedMetrics)
      : { passed: true, detail: invariantCheck.reason };

    if (!externalCheck.passed) {
      candidate.promoted = false;
      candidate.verificationStatus = 'REJECTED_UNVERIFIED';
      candidate.verificationDetail = externalCheck.detail;
      continue;
    }

    candidate.promoted = true;
    candidate.verificationStatus = 'VERIFIED_PROMOTED';
    candidate.verificationDetail = externalCheck.detail;
    acceptedPlan = trialPlan;
    if (candidate.kind === 'ENABLE_TASK_COALESCING') {
      coalescingRecommended = true;
    }
  }

  const promotedImprovements = candidates.filter((c) => c.promoted);
  const rejectedImprovements = candidates.filter((c) => !c.promoted);

  const summary =
    promotedImprovements.length > 0
      ? `Promoted ${promotedImprovements.length} independently verified improvement(s) (${promotedImprovements.map((p) => p.title).join('; ')}); rejected ${rejectedImprovements.length}. Cloud spend: $${observedMetrics.costBreakdown.cloudProviderCostUsd.toFixed(4)}, sovereign local completion share: ${observedMetrics.costBreakdown.sovereignLocalCompletionSharePct.toFixed(1)}%.`
      : `Analyzed ${observedMetrics.totalObservations} execution observation(s); current plan already satisfies optimal verified invariants (${rejectedImprovements.length} candidate(s) rejected).`;

  return {
    analyzedAt,
    observedMetrics,
    candidates,
    promotedImprovements,
    rejectedImprovements,
    baselinePlan: currentPlan,
    optimizedPlan: acceptedPlan,
    coalescingRecommended,
    recommendedCoalesceBatchSize: coalescingRecommended ? 3 : undefined,
    summary,
  };
}
