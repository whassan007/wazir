/**
 * Goal Studio integration contract (v1).
 *
 * Coordinator-owned. Every workstream implements against these types; none may
 * edit this file. A workstream that needs a contract change records the proposal
 * in its agent report under "Integration notes" and keeps working against a
 * local extension type until the coordinator revises the contract.
 *
 * Human-readable rationale: reports/goal-studio-12-agents/INTEGRATION-CONTRACTS.md
 */
import type { KeyValueStore } from '@wazir/shared';

export const GOAL_STUDIO_CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Identifiers. All ids are opaque strings; callers never parse them.
// ---------------------------------------------------------------------------

export type ProjectId = string;
export type GraphId = string;
/** Monotonic per graph, starting at 1. A revision is immutable once written. */
export type GraphRevision = number;
/** Stable target id from the source graph (e.g. "Y1.2"). Unique within a graph. */
export type TargetId = string;
/** One controller run over one pinned graph revision. */
export type GoalRunId = string;
/** One attempt at one target within a run. */
export type TargetAttemptId = string;
/** Existing Wazir execution id (packages/core ExecutionEngine). */
export type ExecutionId = string;
export type EvidenceId = string;
export type PromptId = string;
/** Monotonic per prompt, starting at 1. Immutable once written. */
export type PromptVersion = number;

/**
 * Idempotency key for any side-effecting step. Deterministic, never random:
 * `${runId}:${targetId}:${attemptNumber}:${phase}`. Replaying a step with the
 * same key must return the recorded result and perform no new side effect.
 */
export type IdempotencyKey = string;

export function idempotencyKey(runId: GoalRunId, targetId: TargetId, attempt: number, phase: GoalPhase): IdempotencyKey {
  return `${runId}:${targetId}:${attempt}:${phase}`;
}

// ---------------------------------------------------------------------------
// Graph model (Workstream 02 owns persistence/import; everyone reads it).
// ---------------------------------------------------------------------------

export interface GoalProject {
  id: ProjectId;
  name: string;
  createdAt: string; // ISO-8601 everywhere in this contract
}

export interface ResourceLimits {
  maxTasksPerRun: number;
  maxRepairsPerTask: number;
  maxSameActionNoProgress: number;
  maxRunMinutes: number;
  /** Hosted (paid) spend ceiling for a run. 0 means no paid inference at all. */
  hostedSpendUsd: number;
  localModelFirst: boolean;
  maxConcurrentWritersPerWorktree: number;
  /** Concurrent independent targets a run may execute. Default 1. */
  maxConcurrentTargets?: number;
}

export interface GoalConstitution {
  objectiveOwner: 'human';
  invariants: string[];
  resourceLimits: ResourceLimits;
  allowedUnattended: string[];
  needsApproval: string[];
}

export interface GoalTarget {
  id: TargetId;
  stage: string;
  title: string;
  dependsOn: TargetId[];
  /** Higher runs first among equally critical eligible targets. */
  priority: number;
  /** Specialist executor key; resolves to a PromptDefinition by `executorKey`. */
  executor: string;
  artifacts: string[];
  acceptance: string[];
  /** Completion needs an attributable external record; never self-certified. */
  externalDependency?: boolean;
  /** Completion (or execution) needs explicit human approval. */
  requiresApproval?: boolean;
}

/** A node in the reusable execution (prompt) graph, distinct from targets. */
export interface PromptGraphNode {
  id: string;
  next: string[];
  promptId?: PromptId;
}

export interface GoalGraphDefinition {
  schemaVersion: string;
  name: string;
  purpose?: string;
  constitution: GoalConstitution;
  targets: GoalTarget[];
  /** Execution graph is kept separate from the target graph. */
  executionGraph: { entry: string; nodes: PromptGraphNode[] };
}

export interface GoalGraphRevisionRecord {
  graphId: GraphId;
  projectId: ProjectId;
  revision: GraphRevision;
  definition: GoalGraphDefinition;
  /** sha256 hex of the canonical JSON of `definition`. */
  digest: string;
  createdAt: string;
  createdBy: string;
  parentRevision?: GraphRevision;
}

export type GraphValidationIssueCode =
  | 'SCHEMA'
  | 'DUPLICATE_TARGET'
  | 'UNKNOWN_DEPENDENCY'
  | 'CYCLE'
  | 'SELF_DEPENDENCY'
  | 'UNKNOWN_EXECUTOR'
  | 'INVALID_LIMIT';

export interface GraphValidationIssue {
  code: GraphValidationIssueCode;
  message: string;
  path?: string;
  targetIds?: TargetId[];
}

export interface GraphValidationResult {
  valid: boolean;
  issues: GraphValidationIssue[];
}

export interface GoalGraphStore {
  importYaml(projectId: ProjectId, yaml: string, actor: string): Promise<{ record?: GoalGraphRevisionRecord; validation: GraphValidationResult }>;
  createRevision(graphId: GraphId, definition: GoalGraphDefinition, actor: string, parentRevision: GraphRevision): Promise<GoalGraphRevisionRecord>;
  getRevision(graphId: GraphId, revision?: GraphRevision): Promise<GoalGraphRevisionRecord | undefined>;
  listRevisions(graphId: GraphId): Promise<Array<Pick<GoalGraphRevisionRecord, 'graphId' | 'revision' | 'digest' | 'createdAt' | 'createdBy'>>>;
  listGraphs(projectId?: ProjectId): Promise<Array<{ graphId: GraphId; projectId: ProjectId; name: string; latestRevision: GraphRevision }>>;
  validate(definition: GoalGraphDefinition): GraphValidationResult;
}

// ---------------------------------------------------------------------------
// States and lifecycle.
// ---------------------------------------------------------------------------

/** Durable per-target status within a run (superset of the YAML completion_states). */
export type TargetStatus =
  | 'queued'
  | 'eligible'
  | 'active'
  | 'verifying'
  | 'verified'
  | 'completed'
  | 'failed'
  | 'repairing'
  | 'needs_approval'
  | 'blocked'
  | 'awaiting_external'
  | 'stopped';

export const TERMINAL_TARGET_STATUSES: readonly TargetStatus[] = ['completed', 'blocked', 'stopped'];

/** Only `completed` unlocks dependents. `verified` alone never does. */
export const UNLOCKING_TARGET_STATUSES: readonly TargetStatus[] = ['completed'];

export type GoalRunStatus = 'created' | 'running' | 'pausing' | 'paused' | 'stopping' | 'stopped' | 'idle' | 'completed' | 'failed';

/** Lifecycle phase of one target attempt, in order. */
export type GoalPhase =
  | 'LOAD_LEDGER'
  | 'SELECT_TARGET'
  | 'PLAN_TASK'
  | 'PREFLIGHT'
  | 'ROUTE_MODEL'
  | 'EXECUTE'
  | 'CHALLENGE'
  | 'INDEPENDENT_VERIFY'
  | 'ACCEPTANCE_GATE'
  | 'COMMIT_PROGRESS'
  | 'UNLOCK_DEPENDENCIES'
  | 'SELECT_NEXT_TARGET'
  // failure path
  | 'DIAGNOSE'
  | 'REPAIR_HYPOTHESIS'
  | 'REPLAN'
  | 'RETEST'
  // terminal side paths
  | 'BLOCK_TARGET'
  | 'RECORD_EVIDENCE'
  | 'AWAIT_APPROVAL'
  | 'PERSIST_STATE';

export interface TargetTransition {
  runId: GoalRunId;
  targetId: TargetId;
  fromState: TargetStatus;
  toState: TargetStatus;
  reason: string;
  /** 'controller' | 'verifier' | 'recovery' | 'governance' | `user:${id}` */
  actor: string;
  timestamp: string;
  attemptId?: TargetAttemptId;
  evidenceIds?: EvidenceId[];
}

// ---------------------------------------------------------------------------
// Durable ledger (Workstream 01 owns implementation; 03/05/07 consume).
// ---------------------------------------------------------------------------

export interface TargetLedgerEntry {
  targetId: TargetId;
  status: TargetStatus;
  attempts: number;
  repairs: number;
  lastAttemptId?: TargetAttemptId;
  lastExecutionId?: ExecutionId;
  /** Evidence that justified the current status (required for verified/completed). */
  evidenceIds: EvidenceId[];
  blockers: string[];
  updatedAt: string;
}

export interface TargetAttempt {
  id: TargetAttemptId;
  runId: GoalRunId;
  targetId: TargetId;
  attempt: number;
  phase: GoalPhase;
  executionId?: ExecutionId;
  modelRoute?: ModelRouteDecision;
  promptRef?: { promptId: PromptId; version: PromptVersion };
  repairHypothesis?: string;
  startedAt: string;
  endedAt?: string;
  outcome?: 'succeeded' | 'failed' | 'cancelled' | 'awaiting_approval' | 'blocked';
  error?: GoalStudioError;
}

export interface GoalRunLedger {
  runId: GoalRunId;
  graphId: GraphId;
  /** Pinned. Edits to the graph create new revisions and never affect this run. */
  graphRevision: GraphRevision;
  graphDigest: string;
  status: GoalRunStatus;
  /** Monotonic; incremented by every committed ledger write (optimistic concurrency). */
  ledgerRevision: number;
  targets: Record<TargetId, TargetLedgerEntry>;
  resource: { tasksStarted: number; hostedSpendUsd: number; startedAt: string; deadlineAt: string };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunLease {
  runId: GoalRunId;
  holderId: string;
  /** Fencing token: strictly increases on every acquisition. */
  epoch: number;
  expiresAt: string;
}

export interface GoalLedgerStore {
  createRun(input: { graph: GoalGraphRevisionRecord; createdBy: string; runId?: GoalRunId }): Promise<GoalRunLedger>;
  getRun(runId: GoalRunId): Promise<GoalRunLedger | undefined>;
  listRuns(filter?: { graphId?: GraphId; status?: GoalRunStatus }): Promise<GoalRunLedger[]>;
  /**
   * Atomic compare-and-set on `ledgerRevision`, fenced by the lease epoch.
   * Rejects with GoalStudioError code LEDGER_CONFLICT or STALE_LEASE.
   */
  commit(runId: GoalRunId, expectedRevision: number, lease: RunLease, mutate: (ledger: GoalRunLedger) => void, transitions: TargetTransition[]): Promise<GoalRunLedger>;
  transitions(runId: GoalRunId, targetId?: TargetId): Promise<TargetTransition[]>;
  acquireLease(runId: GoalRunId, holderId: string, ttlMs: number): Promise<RunLease | undefined>;
  renewLease(lease: RunLease, ttlMs: number): Promise<RunLease>;
  releaseLease(lease: RunLease): Promise<void>;
  /** Exactly-once guard: runs `effect` only if `key` has no recorded result; otherwise returns it. */
  once<T>(key: IdempotencyKey, effect: () => Promise<T>): Promise<{ result: T; replayed: boolean }>;
  saveAttempt(attempt: TargetAttempt): Promise<void>;
  attempts(runId: GoalRunId, targetId?: TargetId): Promise<TargetAttempt[]>;
}

// ---------------------------------------------------------------------------
// Verification and evidence (Workstream 04).
// ---------------------------------------------------------------------------

export type VerificationVerdict = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_RUN';

export interface ArtifactRef {
  uri: string;
  /** `sha256:<hex>` of the exact bytes verified. */
  digest: string;
  sizeBytes?: number;
}

export interface EvidenceRecord {
  id: EvidenceId;
  runId: GoalRunId;
  targetId: TargetId;
  attemptId: TargetAttemptId;
  graphRevision: GraphRevision;
  /** Workspace git revision or content digest the checks ran against. */
  workspaceRevision: string;
  artifacts: ArtifactRef[];
  /** e.g. 'command', 'test-suite', 'schema', 'checksum', 'adversarial-review', 'external-record', 'human-signoff' */
  validationMethod: string;
  /** Identity of the validator. Must differ from the executor for model-based checks. */
  validatorIdentity: string;
  executorIdentity: string;
  verdict: VerificationVerdict;
  criterion?: string;
  command?: string;
  exitCode?: number;
  outputExcerpt?: string;
  limitations: string[];
  createdAt: string;
}

export interface AcceptanceGateDecision {
  runId: GoalRunId;
  targetId: TargetId;
  attemptId: TargetAttemptId;
  /** completed: all criteria PASS with independent evidence. */
  decision: 'completed' | 'repair' | 'needs_approval' | 'awaiting_external' | 'blocked';
  perCriterion: Array<{ criterion: string; verdict: VerificationVerdict; evidenceIds: EvidenceId[] }>;
  reasons: string[];
  decidedAt: string;
}

export interface VerificationService {
  /** Runs independent checks; never trusts executor self-reports. */
  verify(input: {
    run: GoalRunLedger;
    target: GoalTarget;
    attempt: TargetAttempt;
    workspaceRoot: string;
    executorIdentity: string;
  }): Promise<EvidenceRecord[]>;
  gate(input: { run: GoalRunLedger; target: GoalTarget; attempt: TargetAttempt; evidence: EvidenceRecord[] }): AcceptanceGateDecision;
  evidence(runId: GoalRunId, targetId?: TargetId): Promise<EvidenceRecord[]>;
}

// ---------------------------------------------------------------------------
// Recovery (Workstream 05).
// ---------------------------------------------------------------------------

export type FailureClass = 'transient' | 'deterministic' | 'environment' | 'policy' | 'verification' | 'no_progress' | 'unknown';

export interface RecoveryDecision {
  action: 'retry' | 'repair' | 'block';
  failureClass: FailureClass;
  diagnosis: string;
  /** Required for 'repair'; must differ from all prior hypotheses for this target. */
  hypothesis?: string;
  /** Fingerprint used for no-progress detection. */
  failureSignature: string;
  reasons: string[];
}

export interface RecoveryService {
  decide(input: {
    run: GoalRunLedger;
    target: GoalTarget;
    attempt: TargetAttempt;
    priorAttempts: TargetAttempt[];
    gate?: AcceptanceGateDecision;
    error?: GoalStudioError;
  }): Promise<RecoveryDecision>;
}

// ---------------------------------------------------------------------------
// Prompts (Workstream 08).
// ---------------------------------------------------------------------------

export interface PromptDefinition {
  id: PromptId;
  version: PromptVersion;
  /** Matches GoalTarget.executor or an execution-graph node id. */
  executorKey: string;
  role: string;
  template: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredCapabilities: string[];
  digest: string;
  createdAt: string;
  createdBy: string;
}

export interface PromptStore {
  latest(executorKey: string): Promise<PromptDefinition | undefined>;
  get(promptId: PromptId, version: PromptVersion): Promise<PromptDefinition | undefined>;
}

// ---------------------------------------------------------------------------
// Model routing (Workstream 09).
// ---------------------------------------------------------------------------

export interface ModelRouteDecision {
  modelId: string;
  runtimeId: string;
  computerId?: string;
  hosted: boolean;
  estimatedCostUsd: number;
  reasons: string[];
  rejected: Array<{ modelId: string; reason: string }>;
  decidedAt: string;
}

export interface ModelRouter {
  /** Returns undefined when no verified-ready model satisfies requirements and budget. */
  route(input: { requiredCapabilities: string[]; remainingHostedBudgetUsd: number; localFirst: boolean; excludeModelIds?: string[] }): Promise<ModelRouteDecision | undefined>;
}

// ---------------------------------------------------------------------------
// Governance (Workstream 10).
// ---------------------------------------------------------------------------

export interface GovernanceDecision {
  effect: 'allow' | 'ask' | 'deny';
  reasons: string[];
  /** Approval scope id when effect is 'ask'. */
  approvalScope?: string;
}

export interface GoalGovernance {
  preflight(input: { run: GoalRunLedger; target: GoalTarget; route?: ModelRouteDecision; principal: string }): Promise<GovernanceDecision>;
  /** Hard spending gate; called before any hosted inference. */
  authorizeSpend(run: GoalRunLedger, amountUsd: number): GovernanceDecision;
  audit(event: GoalStudioEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Task execution bridge (Workstream 03 implements against Wazir's real engine).
// ---------------------------------------------------------------------------

export interface TargetTaskExecutor {
  /**
   * Executes one planned target task through Wazir's existing execution path
   * (ExecutionEngine + coding agent / dispatcher). Must be idempotent per key.
   */
  execute(input: {
    key: IdempotencyKey;
    run: GoalRunLedger;
    target: GoalTarget;
    attempt: TargetAttempt;
    prompt?: PromptDefinition;
    route: ModelRouteDecision;
    workspaceRoot: string;
    signal: AbortSignal;
    onEvent: (event: GoalStudioEvent) => void;
  }): Promise<{ executionId: ExecutionId; ok: boolean; summary: string; error?: GoalStudioError }>;
}

// ---------------------------------------------------------------------------
// Controller (Workstream 03).
// ---------------------------------------------------------------------------

export interface GoalController {
  startRun(input: { graphId: GraphId; graphRevision?: GraphRevision; principal: string }): Promise<GoalRunLedger>;
  pause(runId: GoalRunId, principal: string): Promise<GoalRunLedger>;
  resume(runId: GoalRunId, principal: string): Promise<GoalRunLedger>;
  stop(runId: GoalRunId, principal: string): Promise<GoalRunLedger>;
  retryTarget(runId: GoalRunId, targetId: TargetId, principal: string): Promise<GoalRunLedger>;
  runEligible(runId: GoalRunId, targetId: TargetId, principal: string): Promise<GoalRunLedger>;
  /** Pure: eligible targets in deterministic priority order. */
  eligibleTargets(run: GoalRunLedger, graph: GoalGraphDefinition): TargetId[];
  /** Resume all non-terminal runs after process restart. */
  recoverRuns(): Promise<GoalRunId[]>;
}

// ---------------------------------------------------------------------------
// Events (streamed over SSE; persisted for replay after reconnect).
// ---------------------------------------------------------------------------

export type GoalStudioEventType =
  | 'run.created'
  | 'run.status'
  | 'run.idle'
  | 'target.transition'
  | 'target.phase'
  | 'attempt.started'
  | 'attempt.finished'
  | 'route.decided'
  | 'execution.event'
  | 'verification.evidence'
  | 'gate.decided'
  | 'recovery.decided'
  | 'approval.requested'
  | 'approval.resolved'
  | 'governance.denied'
  | 'graph.revision'
  | 'prompt.version'
  | 'error';

export interface GoalStudioEvent {
  /** Monotonic per run; clients resume with `?after=<seq>` / Last-Event-ID. */
  seq: number;
  type: GoalStudioEventType;
  runId?: GoalRunId;
  targetId?: TargetId;
  attemptId?: TargetAttemptId;
  executionId?: ExecutionId;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface GoalEventLog {
  append(event: Omit<GoalStudioEvent, 'seq' | 'timestamp'> & { timestamp?: string }): Promise<GoalStudioEvent>;
  read(runId: GoalRunId, afterSeq?: number, limit?: number): Promise<GoalStudioEvent[]>;
  subscribe(runId: GoalRunId, listener: (event: GoalStudioEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export type GoalStudioErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'LEDGER_CONFLICT'
  | 'STALE_LEASE'
  | 'DUPLICATE'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'BUDGET_EXCEEDED'
  | 'NO_ROUTE'
  | 'EXECUTION_FAILED'
  | 'VERIFICATION_FAILED'
  | 'RETRY_EXHAUSTED'
  | 'NO_PROGRESS'
  | 'CANCELLED'
  | 'INTERNAL';

export interface GoalStudioError {
  code: GoalStudioErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class GoalStudioFailure extends Error implements GoalStudioError {
  readonly code: GoalStudioErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(code: GoalStudioErrorCode, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'GoalStudioFailure';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
  toJSON(): GoalStudioError {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

/** HTTP status for each error code (API routes must use this mapping). */
export const GOAL_STUDIO_HTTP_STATUS: Record<GoalStudioErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  LEDGER_CONFLICT: 409,
  STALE_LEASE: 409,
  DUPLICATE: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  POLICY_DENIED: 403,
  APPROVAL_REQUIRED: 202,
  BUDGET_EXCEEDED: 402,
  NO_ROUTE: 503,
  EXECUTION_FAILED: 500,
  VERIFICATION_FAILED: 422,
  RETRY_EXHAUSTED: 409,
  NO_PROGRESS: 409,
  CANCELLED: 409,
  INTERNAL: 500,
};

// ---------------------------------------------------------------------------
// Persistence key space (KeyValueStore). Each prefix has one owning workstream.
// ---------------------------------------------------------------------------

export const GOAL_STORE_KEYS = {
  graph: (graphId: GraphId) => `goals/graphs/${graphId}`, // 02
  graphRevision: (graphId: GraphId, revision: GraphRevision) => `goals/graphs/${graphId}/rev/${String(revision).padStart(8, '0')}`, // 02
  run: (runId: GoalRunId) => `goals/runs/${runId}`, // 01
  runLease: (runId: GoalRunId) => `goals/leases/${runId}`, // 01
  transition: (runId: GoalRunId, seq: number) => `goals/transitions/${runId}/${String(seq).padStart(10, '0')}`, // 01
  attempt: (runId: GoalRunId, attemptId: TargetAttemptId) => `goals/attempts/${runId}/${attemptId}`, // 01
  idempotency: (key: IdempotencyKey) => `goals/idem/${key}`, // 01
  event: (runId: GoalRunId, seq: number) => `goals/events/${runId}/${String(seq).padStart(10, '0')}`, // 07
  evidence: (runId: GoalRunId, evidenceId: EvidenceId) => `goals/evidence/${runId}/${evidenceId}`, // 04
  prompt: (promptId: PromptId, version: PromptVersion) => `goals/prompts/${promptId}/v/${String(version).padStart(6, '0')}`, // 08
  promptHead: (executorKey: string) => `goals/prompts-head/${executorKey}`, // 08
  audit: (seq: string) => `goals/audit/${seq}`, // 10
} as const;

// ---------------------------------------------------------------------------
// Composition. The coordinator wires concrete implementations in
// apps/api/src/goalStudio/services.ts; every factory takes this shape.
// ---------------------------------------------------------------------------

export interface GoalStudioDeps {
  store: KeyValueStore;
  clock?: () => Date;
  workspaceRoot: string;
}

export interface GoalStudioServices {
  graphs: GoalGraphStore;
  ledger: GoalLedgerStore;
  events: GoalEventLog;
  controller: GoalController;
  verification: VerificationService;
  recovery: RecoveryService;
  prompts: PromptStore;
  router: ModelRouter;
  governance: GoalGovernance;
  executor: TargetTaskExecutor;
}
