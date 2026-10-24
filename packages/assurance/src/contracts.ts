/**
 * Shared contracts for the formal assurance layer (docs/formal-assurance/FORMAL_ASSURANCE.md).
 *
 * Every adapter, the spec registry, the refinement layer, the evidence ledger and the
 * release gate speak these types. Keep them additive: downstream packages depend on them.
 */

/** The only verdicts an obligation may produce (FORMAL_ASSURANCE.md §2.1). */
export enum Verdict {
  /** Property holds over the full encoded symbolic domain (Z3 unsat on ¬P, unbounded; Dafny verified, empty trusted base). */
  PROVED = 'PROVED',
  /** No violation within stated scope/bounds (Alloy check, no counterexample in scope; Z3 unsat on bounded encoding). */
  BOUNDED_PASS = 'BOUNDED_PASS',
  /** Concrete violating assignment/instance/trace (Z3 sat on ¬P; Alloy counterexample; Dafny failing assertion). */
  COUNTEREXAMPLE = 'COUNTEREXAMPLE',
  /** Reproducible simulated execution violates the monitor (VerifAI). */
  FALSIFIED = 'FALSIFIED',
  /** Search budget exhausted without violation — not a proof (VerifAI, Scenic runs). */
  NOT_FALSIFIED = 'NOT_FALSIFIED',
  /** Assumptions alone are UNSAT — any "pass" would be vacuous (vacuity probe). */
  INCONSISTENT_ASSUMPTIONS = 'INCONSISTENT_ASSUMPTIONS',
  /** Spec ambiguous or under-reviewed (spec registry). */
  SPECIFICATION_REVIEW_REQUIRED = 'SPECIFICATION_REVIEW_REQUIRED',
  /** Timeout, solver unknown, incomplete campaign. */
  UNKNOWN = 'UNKNOWN',
  /** Parse/type error, crash, bridge failure. */
  ERROR = 'ERROR',
  /** Tool unavailable or not executed. */
  NOT_RUN = 'NOT_RUN',
  /** No refinement link between verified artifact and shipped code (refinement layer). */
  NOT_VERIFIED = 'NOT_VERIFIED',
}

export const ALL_VERDICTS: readonly Verdict[] = Object.values(Verdict) as Verdict[];

export type FormalTool = 'z3' | 'alloy' | 'dafny' | 'scenic' | 'verifai' | 'gam';

export const FORMAL_TOOLS: readonly FormalTool[] = ['z3', 'alloy', 'dafny', 'scenic', 'verifai', 'gam'];

/** Outcome of checking that the assumptions A are satisfiable on their own (no vacuous pass). */
export interface VacuityProbeResult {
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

/** One verification obligation: a single property encoding to be run by one tool. */
export interface Obligation {
  id: string;
  propertyId: string;
  specVersion: string;
  specHash: string;
  tool: FormalTool;
  artifactPath: string;
  command?: string;
  scope?: string;
  assumptions: string[];
  guarantee: string;
  timeoutMs?: number;
  memoryLimitMb?: number;
  seed?: number;
  /** True when the encoding is bounded (e.g. bounded Z3 unrolling); unsat then maps to BOUNDED_PASS, never PROVED. */
  bounded?: boolean;
  metadata?: Record<string, unknown>;
}

/** Adapter output (§2.3 `Result`). */
export interface VerificationResult {
  verdict: Verdict;
  witness?: unknown;
  tool: FormalTool;
  toolVersion: string;
  scope?: string;
  assumptions: string[];
  elapsedMs: number;
  stdoutRef?: string;
  stderrRef?: string;
  stdout?: string;
  stderr?: string;
  inputHash: string;
  vacuityProbe?: VacuityProbeResult;
  /** Dafny `assume` / `{:axiom}` / `{:extern}` / opaque / trusted declarations — these block PROVED. */
  trustedBaseGaps?: string[];
  seed?: number;
  /** Scenic/VerifAI sampling counters. */
  attempted?: number;
  generated?: number;
  rejected?: number;
  metadata?: Record<string, unknown>;
}

export type Result = VerificationResult;

export interface ToolAvailability {
  available: boolean;
  version: string;
  path?: string;
}

export interface VerifyOptions {
  workspaceDir?: string;
  timeoutMs?: number;
}

/** Common solver adapter interface (§2.3). */
export interface SolverAdapter {
  readonly tool: FormalTool;
  checkAvailability(): Promise<ToolAvailability>;
  verify(obligation: Obligation, workspaceRev: string, options?: VerifyOptions): Promise<VerificationResult>;
}

export type Adapter = SolverAdapter;

// ---------------------------------------------------------------------------
// Spec registry (§2.2)
// ---------------------------------------------------------------------------

export type SpecStatus = 'draft' | 'reviewed' | 'approved' | 'retired';

export const SPEC_STATUSES: readonly SpecStatus[] = ['draft', 'reviewed', 'approved', 'retired'];

export interface SpecSource {
  normative_ref: string;
  jurisdiction: string;
  interpretation_date: string;
}

export interface SpecArtifact {
  tool: FormalTool;
  file: string;
  commands?: string[];
  scope?: string;
}

export interface SpecMonitor {
  tool: FormalTool;
  file: string;
}

export interface SpecManifest {
  id: string;
  version: string;
  status: SpecStatus;
  source: SpecSource;
  /** A */
  assumptions: string[];
  /** P */
  guarantee: string;
  artifacts: SpecArtifact[];
  monitors?: SpecMonitor[];
  /** Humans who approved this revision. */
  reviewers: string[];
  /** `sha256:<hex>`; evidence binds to this hash. */
  content_hash: string;
}

// ---------------------------------------------------------------------------
// Refinement / implementation mapping (§2.6)
// ---------------------------------------------------------------------------

export type RefinementProductionMode = 'compiled_from_dafny' | 'refinement_proof' | 'contract_tests' | 'none';

export interface RefinementMappingEntry {
  property: string;
  verified_artifact: string;
  production: RefinementProductionMode;
  production_path?: string;
}

export interface RefinementMap {
  component: string;
  mappings: RefinementMappingEntry[];
}

// ---------------------------------------------------------------------------
// Evidence ledger and assurance records (§2.7)
// ---------------------------------------------------------------------------

/** One append-only, hash-chained ledger entry. */
export interface LedgerEntry {
  /** Zero-based position in the chain. */
  index: number;
  /** Hash of the previous entry, or null/genesis marker for the first entry. */
  prevHash: string | null;
  /** Hash over this entry's content including prevHash. */
  entryHash: string;
  timestamp: string;
  propertyId: string;
  specHash: string;
  sourceCommit: string;
  workspaceRev: string;
  tool: FormalTool;
  toolVersion: string;
  inputHash: string;
  scope?: string;
  bounds?: string;
  steps?: number;
  assumptions: string[];
  verdict: Verdict;
  witness?: unknown;
  /** Unsat outcome / proof summary when no witness exists. */
  unsatOutcome?: string;
  elapsedMs: number;
  seeds?: number[];
  artifactHashes: Record<string, string>;
  obligationId?: string;
  /** Lease fencing token so a stale worker can't append for a superseded revision. */
  fencingToken?: number;
  metadata?: Record<string, unknown>;
}

export type RuntimeMonitorStatus = 'ENABLED' | 'NOT_DEPLOYED';

export interface PropertyAssuranceSummary {
  /** e.g. `2.1 (sha256:...)` */
  spec_version: string;
  spec_hash?: string;
  specification_consistency?: Verdict;
  decision_envelope?: Verdict;
  implementation_contract?: Verdict;
  simulation_falsification?: Verdict;
  runtime_monitor?: RuntimeMonitorStatus;
  /** Weakest-link aggregate across all levels for this property. */
  overall?: Verdict;
  notes?: string[];
}

export type ReleaseGateStatus = 'PASS' | 'FAIL';

export interface ReleaseGateResult {
  status: ReleaseGateStatus;
  reason?: string;
}

export interface AssuranceRecord {
  component: string;
  version: string;
  source_commit: string;
  properties: Record<string, PropertyAssuranceSummary>;
  assumptions: string[];
  trusted_base: string[];
  coverage_limits: string[];
  counterexamples_found: number;
  regression_obligations: number;
  release_gate: ReleaseGateResult;
}
