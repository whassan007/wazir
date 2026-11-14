/**
 * Vacuity probes (FORMAL_ASSURANCE.md §2.1).
 *
 * Every PROVED / BOUNDED_PASS requires a passing vacuity probe from the same run:
 *  - Z3     — `A` alone and `A ∧ precondition` are SAT.
 *  - Alloy  — a nonempty `run` witness for the same facts is SAT.
 *  - Dafny  — callers can satisfy the `requires`.
 *  - Scenic — rejection rate below a configured threshold.
 *  - VerifAI — the monitor was actually evaluated on generated samples.
 *  - GAM    — the rule set is nonempty and grounded in the ontology.
 * A failed or missing probe downgrades the verdict to INCONSISTENT_ASSUMPTIONS.
 *
 * Every probe fails closed: malformed counters (NaN, negative, inconsistent) never pass.
 */
import { VacuityProbeResult, VerificationResult } from './contracts';
import { applyVacuityProbe } from './verdict';

/** Default Scenic rejection-rate ceiling; above it the scenario's `require`s are close to unsatisfiable. */
export const DEFAULT_SCENIC_MAX_REJECTION_RATE = 0.95;

function pass(details: Record<string, unknown>): VacuityProbeResult {
  return { passed: true, details };
}

function fail(reason: string, details: Record<string, unknown>): VacuityProbeResult {
  return { passed: false, reason, details };
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/** Z3: both `A` alone and `A ∧ precondition` must be SAT. */
export function checkZ3VacuityProbe(input: {
  assumptionsSat: boolean;
  preconditionSat: boolean;
  details?: Record<string, unknown>;
}): VacuityProbeResult {
  const details = { ...input.details, assumptionsSat: input.assumptionsSat, preconditionSat: input.preconditionSat };
  if (input.assumptionsSat !== true) return fail('Z3: assumptions A alone are UNSAT', details);
  if (input.preconditionSat !== true) return fail('Z3: A ∧ precondition is UNSAT', details);
  return pass(details);
}

/** Alloy: the `run` command over the same facts must be SAT with at least one witness instance. */
export function checkAlloyVacuityProbe(input: {
  runWitnessCount: number;
  runSat: boolean;
  commandLabel?: string;
}): VacuityProbeResult {
  const details: Record<string, unknown> = { runSat: input.runSat, runWitnessCount: input.runWitnessCount };
  if (input.commandLabel !== undefined) details.commandLabel = input.commandLabel;
  const label = input.commandLabel ? ` '${input.commandLabel}'` : '';
  if (input.runSat !== true) return fail(`Alloy: run${label} is UNSAT — facts admit no instance`, details);
  if (!isCount(input.runWitnessCount) || input.runWitnessCount < 1) {
    return fail(`Alloy: run${label} produced no witness instance`, details);
  }
  return pass(details);
}

/** Dafny: the `requires` clauses must be satisfiable, smoke-tested, and satisfiable by actual callers. */
export function checkDafnyVacuityProbe(input: {
  requiresSatisfiable: boolean;
  smokeTested: boolean;
  canCallersSatisfy: boolean;
}): VacuityProbeResult {
  const details = { ...input };
  if (input.requiresSatisfiable !== true) return fail('Dafny: requires clauses are unsatisfiable', details);
  if (input.smokeTested !== true) return fail('Dafny: vacuity smoke test was not run', details);
  if (input.canCallersSatisfy !== true) return fail('Dafny: callers cannot satisfy the requires clauses', details);
  return pass(details);
}

/** Scenic: at least one scene was generated and `rejected / attempted <= maxRejectionRate`. */
export function checkScenicVacuityProbe(input: {
  attempted: number;
  generated: number;
  rejected: number;
  maxRejectionRate?: number;
}): VacuityProbeResult {
  const maxRejectionRate = input.maxRejectionRate ?? DEFAULT_SCENIC_MAX_REJECTION_RATE;
  const details: Record<string, unknown> = {
    attempted: input.attempted,
    generated: input.generated,
    rejected: input.rejected,
    maxRejectionRate,
  };
  if (!isCount(input.attempted) || !isCount(input.generated) || !isCount(input.rejected)) {
    return fail('Scenic: sampling counters must be non-negative integers', details);
  }
  if (typeof maxRejectionRate !== 'number' || !(maxRejectionRate >= 0 && maxRejectionRate <= 1)) {
    return fail('Scenic: maxRejectionRate must be within [0, 1]', details);
  }
  if (input.attempted === 0) return fail('Scenic: no samples attempted', details);
  if (input.generated + input.rejected > input.attempted) {
    return fail('Scenic: generated + rejected exceeds attempted', details);
  }
  if (input.generated === 0) return fail('Scenic: no scenes generated — requirements unsatisfiable', details);
  const rejectionRate = input.rejected / input.attempted;
  details.rejectionRate = rejectionRate;
  if (rejectionRate > maxRejectionRate) {
    return fail(`Scenic: rejection rate ${rejectionRate} exceeds threshold ${maxRejectionRate}`, details);
  }
  return pass(details);
}

/**
 * VerifAI: the falsification campaign must have evaluated the monitor on at least one sample. VerifAI never
 * yields PROVED / BOUNDED_PASS, so this probe only documents that NOT_FALSIFIED was not vacuous.
 */
export function checkVerifaiVacuityProbe(input: { samplesEvaluated: number; monitorEvaluated: boolean }): VacuityProbeResult {
  const details = { ...input };
  if (input.monitorEvaluated !== true) return fail('VerifAI: monitor was never evaluated', details);
  if (!isCount(input.samplesEvaluated) || input.samplesEvaluated < 1) {
    return fail('VerifAI: no samples evaluated', details);
  }
  return pass(details);
}

/** GAM: the rule set must be nonempty and grounded in the ontology (`Con` over zero rules is vacuous). */
export function checkGamVacuityProbe(input: { rulesCount: number; ontologyGrounded: boolean }): VacuityProbeResult {
  const details = { ...input };
  if (!isCount(input.rulesCount) || input.rulesCount < 1) return fail('GAM: no rules to check', details);
  if (input.ontologyGrounded !== true) return fail('GAM: rules are not grounded in the ontology', details);
  return pass(details);
}

/**
 * Attach the probe to an adapter result and enforce §2.1: PROVED / BOUNDED_PASS without a passing probe
 * become INCONSISTENT_ASSUMPTIONS. When `probe` is omitted the result's own `vacuityProbe` is used.
 * Returns a new object; the input is not mutated.
 */
export function enforceVacuityProbeOnResult(result: VerificationResult, probe?: VacuityProbeResult): VerificationResult {
  const effective = probe ?? result.vacuityProbe;
  const verdict = applyVacuityProbe(result.verdict, effective);
  const enforced: VerificationResult = { ...result, verdict };
  if (effective !== undefined) enforced.vacuityProbe = effective;
  if (verdict !== result.verdict) {
    enforced.metadata = {
      ...result.metadata,
      vacuityDowngrade: {
        from: result.verdict,
        reason: effective === undefined ? 'vacuity probe missing' : (effective.reason ?? 'vacuity probe failed'),
      },
    };
  }
  return enforced;
}
