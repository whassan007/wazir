/**
 * LiveSessionLab Type Definitions
 *
 * Defines the complete type surface for the production-grade live session
 * evaluation harness. Live sessions run real multi-turn engineering sessions
 * using actual models, repositories, compilers, tools, workers and failures.
 *
 * They complement deterministic unit/integration gates. They do NOT replace them.
 */

export type LiveSessionTier =
  | 'LIVE_SMOKE'
  | 'LIVE_ENGINEERING'
  | 'LIVE_RESILIENCE'
  | 'LIVE_AUTONOMY'
  | 'LIVE_LONG_HORIZON';

export type FaultKind =
  | 'runtime_death'
  | 'worker_death'
  | 'stale_edit'
  | 'tool_failure'
  | 'process_crash'
  | 'large_output'
  | 'mcp_disconnect'
  | 'model_malformed_action';

export interface ScheduledFault {
  /** Human-readable fault identifier */
  id?: string;
  /** Category of fault */
  faultKind: FaultKind;
  /** Inject after this user turn completes (0-based) */
  triggerAfterTurnIndex?: number;
  /** Inject after this many ms from session start */
  triggerAfterMs?: number;
  /** Maximum number of times this fault fires (default: 1) */
  maxTimes?: number;
  /** Seed for deterministic jitter within this fault */
  seed?: number;
  /** Fault-specific parameters passed to the fault handler */
  params?: Record<string, unknown>;
}

export interface UserTurn {
  /** 0-based turn index */
  index: number;
  /** The message injected into Wazir as user input */
  message: string;
  /** Accumulated constraints from previous turns (e.g. "do not modify X") */
  constraints?: string[];
  /** Optional: inject steering from harness after this many ms */
  steerAfterMs?: number;
  /** Optional: metadata for replay/reporting */
  metadata?: Record<string, unknown>;
}

/**
 * HiddenOracle — owned by the harness, never given to the model.
 *
 * The model must not receive:
 *   - hiddenBugLocation
 *   - hiddenExpectedPatch
 *   - protectedHiddenTests (file contents)
 *   - faultSchedule
 */
export interface HiddenOracle {
  /** Unique oracle identifier */
  id: string;
  /**
   * File paths that must exist in the workspace after the session completes.
   * The model never sees these paths in the oracle definition.
   */
  hiddenTestFiles?: string[];
  /**
   * Map of file path -> expected substring.
   * Oracle passes if each file contains its expected substring.
   * Model never sees these expected strings.
   */
  hiddenExpectedPatches?: Record<string, string>;
  /**
   * Shell commands run by the harness (not the model) in the fixture dir.
   * Model never sees these commands or their expected exit codes.
   */
  protectedOracleChecks?: Array<{
    id: string;
    name: string;
    /** Shell command run in workspaceRoot */
    command: string;
    expectedExitCode: number;
    timeoutMs?: number;
  }>;
  /**
   * Stored for reporting only — never given to model.
   * Used to verify the model found the bug independently.
   */
  bugLocation?: string;
  /**
   * Stored for reporting only — never given to model.
   */
  expectedPatch?: string;
  /**
   * Stored for reporting only — never given to model.
   */
  faultScheduleDescription?: string;
}

export interface SessionBudgets {
  /** Maximum number of user turns to execute */
  maxTotalTurns?: number;
  /** Maximum wall clock time for the entire session (ms) */
  maxWallTimeMs?: number;
  /** Maximum model API calls across all turns */
  maxModelCalls?: number;
  /** Maximum total tokens (input + output) across all turns */
  maxTokens?: number;
  /** Maximum repair cycles across all turns */
  maxRepairCycles?: number;
}

export type ControllerInvariantCheck =
  | 'no_protected_file_modified'
  | 'physical_mutation_required'
  | 'build_passes'
  | 'tests_pass'
  | 'provenance_complete'
  | 'no_stale_evidence'
  | 'custom';

export interface ControllerInvariant {
  id: string;
  description: string;
  check: ControllerInvariantCheck;
  /** Only used when check === 'custom' */
  customValidator?: (metrics: LiveSessionMetrics) => boolean;
}

/**
 * LiveSessionSpec — the complete definition of a live session scenario.
 *
 * Architecture:
 *   LiveSessionSpec → FixtureRepository → SessionDriver → Real Wazir
 *   → HiddenOracle → LiveSessionResult → EvaluationService → RegressionHistory
 */
export interface LiveSessionSpec {
  /** Unique scenario identifier, e.g. 'LS01' */
  id: string;
  /** Human-readable scenario name */
  name: string;
  /** Tier classification */
  tier: LiveSessionTier;
  /** Scenario description */
  description: string;
  /** Name of the fixture to use (must be registered in FixtureRegistry) */
  fixtureName: string;
  /** Optional initial state for the fixture (passed to fixture setup) */
  initialState?: Record<string, unknown>;
  /** Ordered list of user turns to inject */
  userTurns: UserTurn[];
  /**
   * Fault schedule — owned by the harness.
   * Model never receives this.
   */
  faultSchedule?: ScheduledFault[];
  /**
   * Hidden oracle — owned by the harness.
   * Model never receives any of this.
   */
  hiddenOracle: HiddenOracle;
  /** Files the model must not modify */
  protectedFiles?: string[];
  /** Evidence types required for the session to pass */
  requiredVerification?: Array<'BUILD' | 'TEST' | 'RUN' | 'STATIC_CHECK'>;
  /** Resource and time budgets */
  budgets?: SessionBudgets;
  /** Behavioral invariants that must hold after the session */
  expectedControllerInvariants?: ControllerInvariant[];
  /** Arbitrary metadata for reporting */
  metadata?: Record<string, unknown>;
}

export interface LiveSessionMetrics {
  taskSuccess: boolean;
  acceptanceSuccess: boolean;
  buildSuccess: boolean;
  testSuccess: boolean;
  verificationSuccess: boolean;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  contextPeakTokens: number;
  contextRevisions: number;
  toolCalls: number;
  toolFailures: number;
  malformedActions: number;
  workspaceRevisions: number;
  physicalMutations: number;
  staleEvidenceAttempts: number;
  repairCycles: number;
  subagents: number;
  candidateBranches: number;
  wallTimeMs: number;
  workerFailures: number;
  recoveries: number;
  /** null = not yet evaluated */
  finalClaimMatchesPhysical: boolean | null;
  protectedOracleResult: 'PASS' | 'FAIL' | 'SKIPPED';
  /** 0.0–1.0 completeness of provenance chain */
  provenanceCompleteness: number;
  faultsInjected: number;
  faultRecoveries: number;
}

export interface TurnRecord {
  index: number;
  message: string;
  startedAt: Date;
  completedAt: Date | null;
  faultsInjectedDuringTurn: FaultKind[];
  metricsSnapshot: Partial<LiveSessionMetrics>;
  rawError?: string;
}

export interface OracleResult {
  oracleId: string;
  checkId?: string;
  passed: boolean;
  detail: string;
  hiddenTestFileFound?: boolean;
  patchFound?: boolean;
  exitCode?: number;
}

export interface LiveSessionResult {
  /** Unique run identifier (UUID) */
  runId: string;
  specId: string;
  specName: string;
  tier: LiveSessionTier;
  fixtureName: string;
  startedAt: Date;
  completedAt: Date;
  metrics: LiveSessionMetrics;
  turnRecords: TurnRecord[];
  oracleResults: OracleResult[];
  invariantResults: Array<{
    invariantId: string;
    passed: boolean;
    detail: string;
  }>;
  overallPassed: boolean;
  failureReasons: string[];
  replay: SessionReplayRecord;
  rawError?: string;
}

/**
 * SessionReplayRecord — stores all deterministic controller inputs needed
 * to replay the session. Model output itself may remain stochastic.
 */
export interface SessionReplayRecord {
  specId: string;
  /** Git hash or content hash of the fixture state at session start */
  fixtureRevision: string;
  /** Seed used for deterministic fault scheduling */
  faultSeed: number;
  wazirVersion: string;
  modelIds: string[];
  runtimeIds: string[];
  /** Hardware identifier (e.g. hostname + CPU model) */
  hardwareId: string;
  /** Snapshot of Wazir configuration relevant to this session */
  configSnapshot: Record<string, unknown>;
  /** Verbatim user turns — deterministic inputs */
  userTurns: UserTurn[];
  recordedAt: Date;
}

export interface LiveSessionRunSummary {
  runId: string;
  specId: string;
  trial: number;
  passed: boolean;
  wallTimeMs: number;
  failureReasons: string[];
}

/**
 * LiveSessionLabResult — aggregated result across multiple trials.
 * Supports flakiness analysis without hiding failures.
 */
export interface LiveSessionLabResult {
  specId: string;
  specName: string;
  tier: LiveSessionTier;
  trials: number;
  passed: number;
  failed: number;
  passRate: number;
  medianWallTimeMs: number;
  p95WallTimeMs: number;
  variance: number;
  /** Reason string -> count of trials where this reason appeared */
  failureClassification: Record<string, number>;
  runSummaries: LiveSessionRunSummary[];
  startedAt: Date;
  completedAt: Date;
}

export interface LiveRunComparisonDimension {
  metric: string;
  runA: number | boolean | null;
  runB: number | boolean | null;
  delta?: number;
  status: 'IMPROVED' | 'REGRESSED' | 'EQUIVALENT' | 'UNKNOWN';
}

export interface LiveRunComparison {
  runIdA: string;
  runIdB: string;
  dimensions: LiveRunComparisonDimension[];
  verdict: 'A_BETTER' | 'B_BETTER' | 'EQUIVALENT' | 'INCONCLUSIVE';
  summary: string;
}

export interface LiveSessionHistoryEntry {
  runId: string;
  specId: string;
  wazirVersion: string;
  modelId: string;
  runtimeId: string;
  hardware: string;
  configHash: string;
  passRate: number;
  medianWallTimeMs: number;
  recordedAt: Date;
}
