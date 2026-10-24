/**
 * Verdict model: native-outcome mapping and the hard rules from FORMAL_ASSURANCE.md §1/§2.1.
 *
 *  - NOT_FALSIFIED is never promoted to PROVED / BOUNDED_PASS.
 *  - Every PROVED / BOUNDED_PASS needs a passing vacuity probe from the same run.
 *  - Aggregation is weakest-link, never an average.
 *  - The release gate fails closed.
 */
import {
  FormalTool,
  RefinementProductionMode,
  ReleaseGateResult,
  VacuityProbeResult,
  Verdict,
} from './contracts';

// ---------------------------------------------------------------------------
// Native outcome → Verdict
// ---------------------------------------------------------------------------

/** Native outcomes shared by every tool. */
export type CommonNativeOutcome = 'timeout' | 'error' | 'not_run';

export type Z3NativeOutcome = 'sat' | 'unsat' | 'unknown' | CommonNativeOutcome;
export type AlloyNativeOutcome = 'counterexample' | 'no_counterexample' | 'unknown' | CommonNativeOutcome;
export type DafnyNativeOutcome = 'verified' | 'assertion_violation' | 'parse_error' | 'type_error' | CommonNativeOutcome;
export type ScenicNativeOutcome = 'violation' | 'sampled' | 'sampling_exhausted' | CommonNativeOutcome;
export type VerifaiNativeOutcome = 'violation' | 'exhausted' | 'incomplete' | CommonNativeOutcome;
export type GamNativeOutcome = 'consistent_satisfied' | 'violation' | 'ontology_not_checked' | CommonNativeOutcome;

/**
 * Documented mapping from each tool's native output to a Verdict.
 *
 * Z3 always queries `A ∧ impl ∧ ¬P`, so `sat` means a violation exists. `unsat` maps to PROVED only
 * for an unbounded encoding (`unsat_bounded` → BOUNDED_PASS). Dafny `verified` maps to PROVED only with
 * an empty trusted base (`verified_with_gaps` → BOUNDED_PASS, see {@link DafnyGapPolicy}). Exit codes are
 * never a verdict on their own — adapters must parse tool output into one of these keys.
 */
export const NATIVE_VERDICT_MAPPING = {
  z3: {
    sat: Verdict.COUNTEREXAMPLE,
    unsat: Verdict.PROVED,
    unsat_bounded: Verdict.BOUNDED_PASS,
    unknown: Verdict.UNKNOWN,
    timeout: Verdict.UNKNOWN,
    error: Verdict.ERROR,
    not_run: Verdict.NOT_RUN,
  },
  alloy: {
    counterexample: Verdict.COUNTEREXAMPLE,
    no_counterexample: Verdict.BOUNDED_PASS,
    unknown: Verdict.UNKNOWN,
    timeout: Verdict.UNKNOWN,
    error: Verdict.ERROR,
    not_run: Verdict.NOT_RUN,
  },
  dafny: {
    verified: Verdict.PROVED,
    verified_with_gaps: Verdict.BOUNDED_PASS,
    verified_with_gaps_blocked: Verdict.NOT_VERIFIED,
    assertion_violation: Verdict.COUNTEREXAMPLE,
    parse_error: Verdict.ERROR,
    type_error: Verdict.ERROR,
    timeout: Verdict.UNKNOWN,
    error: Verdict.ERROR,
    not_run: Verdict.NOT_RUN,
  },
  scenic: {
    violation: Verdict.FALSIFIED,
    sampled: Verdict.NOT_FALSIFIED,
    sampling_exhausted: Verdict.UNKNOWN,
    timeout: Verdict.UNKNOWN,
    error: Verdict.ERROR,
    not_run: Verdict.NOT_RUN,
  },
  verifai: {
    violation: Verdict.FALSIFIED,
    exhausted: Verdict.NOT_FALSIFIED,
    incomplete: Verdict.UNKNOWN,
    timeout: Verdict.UNKNOWN,
    error: Verdict.ERROR,
    not_run: Verdict.NOT_RUN,
  },
  gam: {
    consistent_satisfied: Verdict.BOUNDED_PASS,
    violation: Verdict.COUNTEREXAMPLE,
    // `Con` passing alone is not compliance; the ontology check must also run.
    ontology_not_checked: Verdict.UNKNOWN,
    timeout: Verdict.UNKNOWN,
    error: Verdict.ERROR,
    not_run: Verdict.NOT_RUN,
  },
} as const satisfies Record<FormalTool, Record<string, Verdict>>;

/** What to do with a Dafny proof that relies on `assume` / `{:axiom}` / `{:extern}` / trusted declarations. */
export type DafnyGapPolicy = 'downgrade' | 'block';

export type NativeOutcome =
  | { tool: 'z3'; outcome: Z3NativeOutcome; bounded?: boolean }
  | { tool: 'alloy'; outcome: AlloyNativeOutcome }
  | { tool: 'dafny'; outcome: DafnyNativeOutcome; trustedBaseGaps?: string[]; gapPolicy?: DafnyGapPolicy }
  | { tool: 'scenic'; outcome: ScenicNativeOutcome }
  | { tool: 'verifai'; outcome: VerifaiNativeOutcome }
  | {
      tool: 'gam';
      outcome?: GamNativeOutcome;
      /** ConsistencyChecker result. */
      consistent?: boolean;
      /** OntologyChecker result; undefined means it did not run. */
      satisfied?: boolean;
    };

/**
 * Map a tool's native outcome to a Verdict. Unrecognised outcomes map to ERROR (fail closed).
 * The result is the raw verdict — callers must still apply {@link applyVacuityProbe}.
 */
export function mapNativeOutcomeToVerdict(native: NativeOutcome): Verdict {
  switch (native.tool) {
    case 'z3':
      if (native.outcome === 'unsat' && native.bounded) return NATIVE_VERDICT_MAPPING.z3.unsat_bounded;
      return lookup(NATIVE_VERDICT_MAPPING.z3, native.outcome);
    case 'alloy':
      return lookup(NATIVE_VERDICT_MAPPING.alloy, native.outcome);
    case 'dafny':
      if (native.outcome === 'verified' && (native.trustedBaseGaps?.length ?? 0) > 0) {
        return native.gapPolicy === 'block'
          ? NATIVE_VERDICT_MAPPING.dafny.verified_with_gaps_blocked
          : NATIVE_VERDICT_MAPPING.dafny.verified_with_gaps;
      }
      return lookup(NATIVE_VERDICT_MAPPING.dafny, native.outcome);
    case 'scenic':
      return lookup(NATIVE_VERDICT_MAPPING.scenic, native.outcome);
    case 'verifai':
      return lookup(NATIVE_VERDICT_MAPPING.verifai, native.outcome);
    case 'gam': {
      if (native.outcome !== undefined) return lookup(NATIVE_VERDICT_MAPPING.gam, native.outcome);
      if (native.consistent === false || native.satisfied === false) return NATIVE_VERDICT_MAPPING.gam.violation;
      if (native.consistent === true && native.satisfied === true) return NATIVE_VERDICT_MAPPING.gam.consistent_satisfied;
      if (native.consistent === true) return NATIVE_VERDICT_MAPPING.gam.ontology_not_checked;
      return NATIVE_VERDICT_MAPPING.gam.not_run;
    }
    default:
      return Verdict.ERROR;
  }
}

function lookup(table: Record<string, Verdict>, key: string | undefined): Verdict {
  return key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : Verdict.ERROR;
}

// ---------------------------------------------------------------------------
// Hard rules
// ---------------------------------------------------------------------------

export const PASSING_VERDICTS: readonly Verdict[] = [Verdict.PROVED, Verdict.BOUNDED_PASS];

export function isPassingVerdict(verdict: Verdict): boolean {
  return verdict === Verdict.PROVED || verdict === Verdict.BOUNDED_PASS;
}

export class VerdictPromotionError extends Error {
  constructor(
    readonly from: Verdict,
    readonly to: Verdict,
  ) {
    super(`Illegal verdict promotion: ${from} cannot be promoted to ${to} (falsification search is not a proof)`);
    this.name = 'VerdictPromotionError';
  }
}

/**
 * Guard a verdict transition. Throws {@link VerdictPromotionError} when NOT_FALSIFIED would be promoted to
 * PROVED or BOUNDED_PASS; otherwise returns `targetVerdict`.
 */
export function preventNotFalsifiedPromotion(verdict: Verdict, targetVerdict: Verdict): Verdict {
  if (verdict === Verdict.NOT_FALSIFIED && isPassingVerdict(targetVerdict)) {
    throw new VerdictPromotionError(verdict, targetVerdict);
  }
  return targetVerdict;
}

/**
 * PROVED / BOUNDED_PASS stand only with a passing vacuity probe from the same run. A missing or failed probe
 * downgrades them to INCONSISTENT_ASSUMPTIONS. Other verdicts pass through unchanged.
 */
export function applyVacuityProbe(verdict: Verdict, probe?: VacuityProbeResult): Verdict {
  if (!isPassingVerdict(verdict)) return verdict;
  return probe?.passed === true ? verdict : Verdict.INCONSISTENT_ASSUMPTIONS;
}

/** Trusted-base gaps (Dafny `assume`, `{:axiom}`, `{:extern}`, ...) block PROVED: downgrade to BOUNDED_PASS. */
export function applyTrustedBaseGaps(verdict: Verdict, gaps?: readonly string[]): Verdict {
  return verdict === Verdict.PROVED && (gaps?.length ?? 0) > 0 ? Verdict.BOUNDED_PASS : verdict;
}

/**
 * Implementation-level claim cap (§2.6). Only code compiled from the verified Dafny source or linked by a
 * refinement proof may inherit a passing verdict; contract tests / hand translations cap at NOT_VERIFIED.
 */
export function capImplementationVerdict(verdict: Verdict, production: RefinementProductionMode): Verdict {
  if (!isPassingVerdict(verdict)) return verdict;
  return production === 'compiled_from_dafny' || production === 'refinement_proof' ? verdict : Verdict.NOT_VERIFIED;
}

// ---------------------------------------------------------------------------
// Weakest-link aggregation
// ---------------------------------------------------------------------------

/**
 * Total order from weakest (most severe) to strongest. Any failure, error or unverified state dominates
 * every pass; NOT_FALSIFIED dominates both passes because it is not a proof.
 */
export const VERDICT_WEAKEST_LINK_ORDER: readonly Verdict[] = [
  Verdict.COUNTEREXAMPLE,
  Verdict.FALSIFIED,
  Verdict.INCONSISTENT_ASSUMPTIONS,
  Verdict.ERROR,
  Verdict.SPECIFICATION_REVIEW_REQUIRED,
  Verdict.UNKNOWN,
  Verdict.NOT_RUN,
  Verdict.NOT_VERIFIED,
  Verdict.NOT_FALSIFIED,
  Verdict.BOUNDED_PASS,
  Verdict.PROVED,
];

/** 0 = weakest. Unrecognised values rank weakest of all (fail closed). */
export function verdictStrength(verdict: Verdict): number {
  const rank = VERDICT_WEAKEST_LINK_ORDER.indexOf(verdict);
  return rank === -1 ? -1 : rank;
}

/** The weaker of two verdicts. */
export function weakerVerdict(a: Verdict, b: Verdict): Verdict {
  return verdictStrength(b) < verdictStrength(a) ? b : a;
}

/**
 * Aggregate by weakest link — never averages. An empty set aggregates to NOT_RUN (nothing was checked);
 * an unrecognised verdict aggregates to ERROR.
 */
export function aggregateVerdictsWeakestLink(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return Verdict.NOT_RUN;
  const weakest = verdicts.reduce(weakerVerdict);
  return verdictStrength(weakest) === -1 ? Verdict.ERROR : weakest;
}

// ---------------------------------------------------------------------------
// Release gate
// ---------------------------------------------------------------------------

/** Verdicts that fail the release gate outright. */
export const RELEASE_BLOCKING_VERDICTS: readonly Verdict[] = [
  Verdict.COUNTEREXAMPLE,
  Verdict.FALSIFIED,
  Verdict.INCONSISTENT_ASSUMPTIONS,
  Verdict.ERROR,
  Verdict.SPECIFICATION_REVIEW_REQUIRED,
  Verdict.UNKNOWN,
  Verdict.NOT_RUN,
  Verdict.NOT_VERIFIED,
];

/**
 * Fail-closed release gate. PASS only when the spec is approved, no verdict is blocking, every verdict is
 * recognised, and at least one formal PROVED / BOUNDED_PASS is present (NOT_FALSIFIED alone is not enough).
 */
export function evaluateReleaseGate(verdicts: readonly Verdict[], specApproved: boolean): ReleaseGateResult {
  if (!specApproved) return { status: 'FAIL', reason: 'spec not approved' };
  if (verdicts.length === 0) return { status: 'FAIL', reason: 'no verdicts: obligations NOT_RUN' };

  const unrecognised = verdicts.filter((v) => verdictStrength(v) === -1);
  if (unrecognised.length > 0) {
    return { status: 'FAIL', reason: `unrecognised verdict(s): ${unique(unrecognised.map(String)).join(', ')}` };
  }

  const blocking = RELEASE_BLOCKING_VERDICTS.filter((v) => verdicts.includes(v));
  if (blocking.length > 0) return { status: 'FAIL', reason: `blocking verdict(s): ${blocking.join(', ')}` };

  if (!verdicts.some(isPassingVerdict)) {
    return { status: 'FAIL', reason: 'only NOT_FALSIFIED: no formal PROVED or BOUNDED_PASS evidence' };
  }
  return { status: 'PASS' };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
