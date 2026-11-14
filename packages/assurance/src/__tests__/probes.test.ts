import { describe, expect, it } from 'vitest';
import { ALL_VERDICTS, Verdict, VerificationResult } from '../contracts';
import {
  DEFAULT_SCENIC_MAX_REJECTION_RATE,
  checkAlloyVacuityProbe,
  checkDafnyVacuityProbe,
  checkGamVacuityProbe,
  checkScenicVacuityProbe,
  checkVerifaiVacuityProbe,
  checkZ3VacuityProbe,
  enforceVacuityProbeOnResult,
} from '../probes';

describe('checkZ3VacuityProbe', () => {
  it('passes when A and A ∧ precondition are both SAT', () => {
    const probe = checkZ3VacuityProbe({ assumptionsSat: true, preconditionSat: true, details: { query: 'q1' } });
    expect(probe.passed).toBe(true);
    expect(probe.details).toMatchObject({ query: 'q1', assumptionsSat: true, preconditionSat: true });
  });

  it('fails when A alone is UNSAT', () => {
    const probe = checkZ3VacuityProbe({ assumptionsSat: false, preconditionSat: true });
    expect(probe.passed).toBe(false);
    expect(probe.reason).toMatch(/assumptions/);
  });

  it('fails when A ∧ precondition is UNSAT', () => {
    const probe = checkZ3VacuityProbe({ assumptionsSat: true, preconditionSat: false });
    expect(probe.passed).toBe(false);
    expect(probe.reason).toMatch(/precondition/);
  });
});

describe('checkAlloyVacuityProbe', () => {
  it('passes with a SAT run and at least one witness', () => {
    const probe = checkAlloyVacuityProbe({ runSat: true, runWitnessCount: 1, commandLabel: 'run showWitness' });
    expect(probe.passed).toBe(true);
    expect(probe.details).toMatchObject({ commandLabel: 'run showWitness' });
  });

  it('fails when the run is UNSAT', () => {
    const probe = checkAlloyVacuityProbe({ runSat: false, runWitnessCount: 0, commandLabel: 'w' });
    expect(probe.passed).toBe(false);
    expect(probe.reason).toMatch(/'w'.*UNSAT/);
  });

  it.each([0, -1, Number.NaN, 0.5])('fails when witness count is %s', (runWitnessCount) => {
    expect(checkAlloyVacuityProbe({ runSat: true, runWitnessCount }).passed).toBe(false);
  });
});

describe('checkDafnyVacuityProbe', () => {
  const ok = { requiresSatisfiable: true, smokeTested: true, canCallersSatisfy: true };

  it('passes when every check holds', () => {
    expect(checkDafnyVacuityProbe(ok).passed).toBe(true);
  });

  it.each([
    ['requiresSatisfiable', /unsatisfiable/],
    ['smokeTested', /smoke test/],
    ['canCallersSatisfy', /callers/],
  ] as const)('fails when %s is false', (key, reason) => {
    const probe = checkDafnyVacuityProbe({ ...ok, [key]: false });
    expect(probe.passed).toBe(false);
    expect(probe.reason).toMatch(reason);
  });
});

describe('checkScenicVacuityProbe', () => {
  it('passes under the default threshold', () => {
    const probe = checkScenicVacuityProbe({ attempted: 100, generated: 10, rejected: 90 });
    expect(probe.passed).toBe(true);
    expect(probe.details).toMatchObject({ rejectionRate: 0.9, maxRejectionRate: DEFAULT_SCENIC_MAX_REJECTION_RATE });
  });

  it('passes exactly at the threshold', () => {
    expect(checkScenicVacuityProbe({ attempted: 100, generated: 5, rejected: 95 }).passed).toBe(true);
  });

  it('fails above the default threshold', () => {
    const probe = checkScenicVacuityProbe({ attempted: 100, generated: 4, rejected: 96 });
    expect(probe.passed).toBe(false);
    expect(probe.reason).toMatch(/rejection rate/);
  });

  it('honours a custom threshold', () => {
    const input = { attempted: 100, generated: 50, rejected: 50 };
    expect(checkScenicVacuityProbe({ ...input, maxRejectionRate: 0.4 }).passed).toBe(false);
    expect(checkScenicVacuityProbe({ ...input, maxRejectionRate: 0.5 }).passed).toBe(true);
  });

  it('fails when nothing was generated', () => {
    const probe = checkScenicVacuityProbe({ attempted: 10, generated: 0, rejected: 0, maxRejectionRate: 1 });
    expect(probe.passed).toBe(false);
    expect(probe.reason).toMatch(/no scenes generated/);
  });

  it('fails when nothing was attempted', () => {
    expect(checkScenicVacuityProbe({ attempted: 0, generated: 0, rejected: 0 }).passed).toBe(false);
  });

  it.each([
    { attempted: -1, generated: 1, rejected: 0 },
    { attempted: Number.NaN, generated: 1, rejected: 0 },
    { attempted: 10, generated: 8, rejected: 5 },
    { attempted: 10, generated: 5, rejected: 0, maxRejectionRate: 1.5 },
    { attempted: 10, generated: 5, rejected: 0, maxRejectionRate: Number.NaN },
  ])('fails closed on malformed input %o', (input) => {
    expect(checkScenicVacuityProbe(input).passed).toBe(false);
  });
});

describe('checkVerifaiVacuityProbe', () => {
  it('passes when the monitor was evaluated on samples', () => {
    expect(checkVerifaiVacuityProbe({ samplesEvaluated: 3, monitorEvaluated: true }).passed).toBe(true);
  });

  it('fails when the monitor never ran or no samples were evaluated', () => {
    expect(checkVerifaiVacuityProbe({ samplesEvaluated: 3, monitorEvaluated: false }).passed).toBe(false);
    expect(checkVerifaiVacuityProbe({ samplesEvaluated: 0, monitorEvaluated: true }).passed).toBe(false);
  });
});

describe('checkGamVacuityProbe', () => {
  it('passes with grounded, nonempty rules', () => {
    expect(checkGamVacuityProbe({ rulesCount: 4, ontologyGrounded: true }).passed).toBe(true);
  });

  it('fails with zero rules', () => {
    const probe = checkGamVacuityProbe({ rulesCount: 0, ontologyGrounded: true });
    expect(probe.passed).toBe(false);
    expect(probe.reason).toMatch(/no rules/);
  });

  it('fails when not ontology-grounded', () => {
    const probe = checkGamVacuityProbe({ rulesCount: 4, ontologyGrounded: false });
    expect(probe.passed).toBe(false);
    expect(probe.reason).toMatch(/ontology/);
  });
});

describe('enforceVacuityProbeOnResult', () => {
  const base = (verdict: Verdict, extra: Partial<VerificationResult> = {}): VerificationResult => ({
    verdict,
    tool: 'z3',
    toolVersion: '4.13.0',
    assumptions: ['A1'],
    elapsedMs: 5,
    inputHash: 'sha256:abc',
    ...extra,
  });
  const passing = checkZ3VacuityProbe({ assumptionsSat: true, preconditionSat: true });
  const failing = checkZ3VacuityProbe({ assumptionsSat: false, preconditionSat: false });

  it.each([Verdict.PROVED, Verdict.BOUNDED_PASS])('keeps %s with a passing probe and attaches it', (verdict) => {
    const out = enforceVacuityProbeOnResult(base(verdict), passing);
    expect(out.verdict).toBe(verdict);
    expect(out.vacuityProbe).toBe(passing);
    expect(out.metadata?.vacuityDowngrade).toBeUndefined();
  });

  it.each([Verdict.PROVED, Verdict.BOUNDED_PASS])('downgrades %s with a failed probe', (verdict) => {
    const out = enforceVacuityProbeOnResult(base(verdict, { metadata: { keep: 1 } }), failing);
    expect(out.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(out.vacuityProbe).toBe(failing);
    expect(out.metadata).toMatchObject({ keep: 1, vacuityDowngrade: { from: verdict, reason: failing.reason } });
  });

  it.each([Verdict.PROVED, Verdict.BOUNDED_PASS])('downgrades %s with a missing probe', (verdict) => {
    const out = enforceVacuityProbeOnResult(base(verdict));
    expect(out.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(out.metadata).toMatchObject({ vacuityDowngrade: { from: verdict, reason: 'vacuity probe missing' } });
  });

  it("falls back to the result's own vacuityProbe when none is passed", () => {
    expect(enforceVacuityProbeOnResult(base(Verdict.PROVED, { vacuityProbe: passing })).verdict).toBe(Verdict.PROVED);
    expect(enforceVacuityProbeOnResult(base(Verdict.PROVED, { vacuityProbe: failing })).verdict).toBe(
      Verdict.INCONSISTENT_ASSUMPTIONS,
    );
  });

  it('an explicit probe overrides the attached one', () => {
    const out = enforceVacuityProbeOnResult(base(Verdict.PROVED, { vacuityProbe: passing }), failing);
    expect(out.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(out.vacuityProbe).toBe(failing);
  });

  it('leaves every non-passing verdict unchanged, even without a probe', () => {
    for (const verdict of ALL_VERDICTS.filter((v) => v !== Verdict.PROVED && v !== Verdict.BOUNDED_PASS)) {
      expect(enforceVacuityProbeOnResult(base(verdict)).verdict).toBe(verdict);
      expect(enforceVacuityProbeOnResult(base(verdict), failing).verdict).toBe(verdict);
    }
  });

  it('does not mutate the input result', () => {
    const input = base(Verdict.PROVED);
    const snapshot = structuredClone(input);
    enforceVacuityProbeOnResult(input, failing);
    expect(input).toEqual(snapshot);
  });

  it('works with probes from every tool', () => {
    const probes = [
      checkAlloyVacuityProbe({ runSat: true, runWitnessCount: 2 }),
      checkDafnyVacuityProbe({ requiresSatisfiable: true, smokeTested: true, canCallersSatisfy: true }),
      checkScenicVacuityProbe({ attempted: 10, generated: 5, rejected: 5 }),
      checkGamVacuityProbe({ rulesCount: 1, ontologyGrounded: true }),
    ];
    for (const probe of probes) {
      expect(enforceVacuityProbeOnResult(base(Verdict.BOUNDED_PASS), probe).verdict).toBe(Verdict.BOUNDED_PASS);
    }
  });
});
