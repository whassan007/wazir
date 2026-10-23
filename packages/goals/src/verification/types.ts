import type {
  ArtifactRef,
  EvidenceRecord,
  GoalEventLog,
  GoalRunLedger,
  GoalStudioDeps,
  GoalStudioEvent,
  GoalTarget,
  TargetAttempt,
  VerificationService,
  VerificationVerdict,
} from '../contracts.js';

/**
 * Validation methods this workstream writes. Anything else found in the store
 * (e.g. 'self-report') is kept for history but never satisfies a criterion.
 */
export type VerificationMethod =
  | 'checksum'
  | 'existence'
  | 'schema'
  | 'content-check'
  | 'command'
  | 'test-suite'
  | 'adversarial-review'
  | 'external-record'
  | 'human-signoff'
  | 'coverage';

/** Methods that count toward a criterion PASS when produced by an independent validator. */
export const DETERMINISTIC_METHODS: readonly string[] = ['existence', 'schema', 'content-check', 'command', 'test-suite'];
export const HUMAN_METHODS: readonly string[] = ['human-signoff', 'external-record'];
export const SELF_REPORT_METHODS: readonly string[] = ['self-report', 'self_report', 'model-claim', 'executor-claim'];

/** Minimal JSON-schema subset. Unsupported keywords make the check UNKNOWN, never PASS. */
export interface JsonSchemaLite {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  required?: string[];
  properties?: Record<string, JsonSchemaLite>;
  items?: JsonSchemaLite;
  enum?: unknown[];
  const?: unknown;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  [keyword: string]: unknown;
}

export type DeclaredCheckKind = 'command' | 'exists' | 'non-empty' | 'json-schema' | 'contains';

/**
 * A deterministic check declared by the graph author or an operator-supplied
 * planner, never by the executing model.
 */
export interface DeclaredCheck {
  /** Stable within the target. */
  id: string;
  kind: DeclaredCheckKind;
  /**
   * The acceptance criterion this check evidences: exact criterion text, or
   * `#N` (1-based index into target.acceptance). Omitted = precondition only
   * (a FAIL still forces repair, a PASS satisfies no criterion).
   */
  criterion?: string;
  /** kind 'command': shell command run inside the workspace sandbox. */
  command?: string;
  /** Classify a command as a test suite in evidence (`validationMethod: 'test-suite'`). */
  testSuite?: boolean;
  /** kinds exists/non-empty/json-schema/contains: workspace-relative path. */
  artifact?: string;
  schema?: JsonSchemaLite;
  /** kind 'contains': literal substring required in the artifact. */
  pattern?: string;
  /** Bounded; clamped to [1s, 600s]. Default 120s. */
  timeoutMs?: number;
}

/** A GoalTarget that may carry declared checks (graph import may pass them through). */
export type VerifiableTarget = GoalTarget & { checks?: DeclaredCheck[] };

export interface CheckRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** Isolation used, e.g. 'bwrap' | 'sandbox-exec' | 'none'. */
  sandbox: string;
  /** Set when the command could not be started at all (e.g. sandbox required but unavailable). */
  error?: string;
}

/** Runs one declared command, bounded and sandboxed. Injectable for tests. */
export interface CheckRunner {
  run(input: { command: string; cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<CheckRunResult>;
}

export interface AdversarialFinding {
  /** Criterion text or `#N`; omitted = objection against the target as a whole. */
  criterion?: string;
  verdict: VerificationVerdict;
  objection?: string;
  reproduction?: string;
  limitations?: string[];
}

export interface AdversarialReviewInput {
  run: GoalRunLedger;
  target: GoalTarget;
  attempt: TargetAttempt;
  workspaceRoot: string;
  workspaceRevision: string;
  artifacts: ArtifactRef[];
  executorIdentity: string;
  /** Deterministic evidence already recorded in this verify() call. */
  evidence: EvidenceRecord[];
}

/**
 * The CHALLENGE hook (independent_red_team). Its identity must differ from the
 * executor's; otherwise every finding is recorded UNKNOWN.
 */
export interface AdversarialReviewer {
  readonly identity: string;
  review(input: AdversarialReviewInput): Promise<{ validatorIdentity?: string; findings: AdversarialFinding[] }>;
}

/** Current bytes of a target's artifacts. `workspaceRevision` is a content digest. */
export interface WorkspaceState {
  workspaceRevision: string;
  artifacts: ArtifactRef[];
  /** Artifacts that are missing, empty, unreadable or outside the workspace, with the reason. */
  problems: Array<{ uri: string; reason: string }>;
}

export interface GateOptions {
  /**
   * Whether a PASS from the adversarial reviewer (a model) may satisfy a
   * criterion. Default false: review can only raise objections (FAIL) or
   * leave UNKNOWN; PASS must come from a deterministic check or a human.
   */
  acceptReviewerPass?: boolean;
}

/** gate() input, optionally with a fresh workspace snapshot to bind evidence against. */
export interface GateInput {
  run: GoalRunLedger;
  target: GoalTarget;
  attempt: TargetAttempt;
  evidence: EvidenceRecord[];
  /** When supplied, evidence must match these exact digests (detects tampering after verify). */
  current?: WorkspaceState;
  /** When supplied, also treated as an executor identity for independence checks. */
  executorIdentity?: string;
}

export interface SignoffInput {
  runId: string;
  targetId: string;
  /** Defaults to the attempt of the latest verified workspace revision for the target. */
  attemptId?: string;
  /** Authenticated principal id; recorded as `user:<principal>`. Never taken from a request body. */
  principal: string;
  method?: 'human-signoff' | 'external-record';
  verdict: 'PASS' | 'FAIL';
  /** Criteria (text or `#N`) the signer attests to. Empty = approval of the target only. */
  criteria?: string[];
  note?: string;
  /** external-record: issuer / URL / record id of the attributable primary record. */
  source?: string;
  /** Optional optimistic check: must equal the latest verified revision. */
  workspaceRevision?: string;
}

export interface GoalVerificationService extends VerificationService {
  gate(input: GateInput): ReturnType<VerificationService['gate']>;
  /** Digests the target's artifacts as they are on disk now. */
  snapshot(target: GoalTarget, workspaceRoot?: string): Promise<WorkspaceState>;
  /** Loads stored evidence, re-snapshots the workspace and gates against the current bytes. */
  gateCurrent(input: { run: GoalRunLedger; target: GoalTarget; attempt: TargetAttempt; workspaceRoot?: string; executorIdentity?: string }): Promise<ReturnType<VerificationService['gate']>>;
  /** Records operator-attributed human-signoff / external-record evidence. */
  recordSignoff(input: SignoffInput): Promise<EvidenceRecord[]>;
}

export interface VerificationServiceDeps extends GoalStudioDeps {
  checks?: CheckRunner;
  reviewer?: AdversarialReviewer;
  /** Extra declared checks per target (operator-supplied; merged with target.checks). */
  plan?: (input: { run: GoalRunLedger; target: GoalTarget; attempt: TargetAttempt }) => DeclaredCheck[] | Promise<DeclaredCheck[]>;
  /** Identity recorded for deterministic checks. Default 'verifier:wazir-deterministic'. */
  validatorIdentity?: string;
  events?: Pick<GoalEventLog, 'append'>;
  audit?: (event: GoalStudioEvent) => Promise<void>;
  gateOptions?: GateOptions;
  /** Bounds for artifact digesting. */
  limits?: { maxFiles?: number; maxBytes?: number };
}
