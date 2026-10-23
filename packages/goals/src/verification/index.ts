// Owned by the Goal Studio verification workstream. See reports/goal-studio-12-agents/INTEGRATION-CONTRACTS.md.
export { createVerificationService, DEFAULT_VALIDATOR_IDENTITY } from './service.js';
export { evaluateGate, resolveCriterion, referenceState, isSelfReport, isFresh } from './gate.js';
export {
  DEFAULT_DIGEST_LIMITS,
  ArtifactPathError,
  normalizeArtifactPath,
  resolveInside,
  digestArtifact,
  workspaceRevisionOf,
  snapshotArtifacts,
} from './digest.js';
export {
  DEFAULT_CHECK_TIMEOUT_MS,
  MAX_CHECK_TIMEOUT_MS,
  MIN_CHECK_TIMEOUT_MS,
  clampTimeout,
  createSandboxedCheckRunner,
  excerpt,
  validateSchema,
  runDeclaredCheck,
  type CheckOutcome,
} from './checks.js';
export {
  DETERMINISTIC_METHODS,
  HUMAN_METHODS,
  SELF_REPORT_METHODS,
  type VerificationMethod,
  type JsonSchemaLite,
  type DeclaredCheckKind,
  type DeclaredCheck,
  type VerifiableTarget,
  type CheckRunResult,
  type CheckRunner,
  type AdversarialFinding,
  type AdversarialReviewInput,
  type AdversarialReviewer,
  type WorkspaceState,
  type GateOptions,
  type GateInput,
  type SignoffInput,
  type GoalVerificationService,
  type VerificationServiceDeps,
} from './types.js';
