import { describe, expect, it } from 'vitest';
import {
  ALL_VERDICTS,
  FORMAL_TOOLS,
  NATIVE_VERDICT_MAPPING,
  RELEASE_BLOCKING_VERDICTS,
  VERDICT_WEAKEST_LINK_ORDER,
  Verdict,
  VerdictPromotionError,
  aggregateVerdictsWeakestLink,
  applyTrustedBaseGaps,
  applyVacuityProbe,
  capImplementationVerdict,
  evaluateReleaseGate,
  mapNativeOutcomeToVerdict,
  preventNotFalsifiedPromotion,
} from '../index';

describe('mapNativeOutcomeToVerdict', () => {
  it('maps Z3 against the negated property (no SAT/UNSAT inversion)', () => {
    expect(mapNativeOutcomeToVerdict({ tool: 'z3', outcome: 'sat' })).toBe(Verdict.COUNTEREXAMPLE);
    expect(mapNativeOutcomeToVerdict({ tool: 'z3', outcome: 'unsat' })).toBe(Verdict.PROVED);
    expect(mapNativeOutcomeToVerdict({ tool: 'z3', outcome: 'unsat', bounded: true })).toBe(Verdict.BOUNDED_PASS);
    expect(mapNativeOutcomeToVerdict({ tool: 'z3', outcome: 'unknown' })).toBe(Verdict.UNKNOWN);
    expect(mapNativeOutcomeToVerdict({ tool: 'z3', outcome: 'timeout' })).toBe(Verdict.UNKNOWN);
    expect(mapNativeOutcomeToVerdict({ tool: 'z3', outcome: 'error' })).toBe(Verdict.ERROR);
    expect(mapNativeOutcomeToVerdict({ tool: 'z3', outcome: 'not_run' })).toBe(Verdict.NOT_RUN);
  });

  it('maps Alloy checks to bounded verdicts only', () => {
    expect(mapNativeOutcomeToVerdict({ tool: 'alloy', outcome: 'counterexample' })).toBe(Verdict.COUNTEREXAMPLE);
    expect(mapNativeOutcomeToVerdict({ tool: 'alloy', outcome: 'no_counterexample' })).toBe(Verdict.BOUNDED_PASS);
    expect(Object.values(NATIVE_VERDICT_MAPPING.alloy)).not.toContain(Verdict.PROVED);
  });

  it('maps Dafny, blocking PROVED on trusted-base gaps', () => {
    expect(mapNativeOutcomeToVerdict({ tool: 'dafny', outcome: 'verified' })).toBe(Verdict.PROVED);
    expect(mapNativeOutcomeToVerdict({ tool: 'dafny', outcome: 'verified', trustedBaseGaps: [] })).toBe(Verdict.PROVED);
    expect(mapNativeOutcomeToVerdict({ tool: 'dafny', outcome: 'verified', trustedBaseGaps: ['assume x'] })).toBe(
      Verdict.BOUNDED_PASS,
    );
    expect(
      mapNativeOutcomeToVerdict({ tool: 'dafny', outcome: 'verified', trustedBaseGaps: ['{:axiom}'], gapPolicy: 'block' }),
    ).toBe(Verdict.NOT_VERIFIED);
    expect(mapNativeOutcomeToVerdict({ tool: 'dafny', outcome: 'assertion_violation' })).toBe(Verdict.COUNTEREXAMPLE);
    expect(mapNativeOutcomeToVerdict({ tool: 'dafny', outcome: 'parse_error' })).toBe(Verdict.ERROR);
  });

  it('never lets simulation tools produce a passing verdict', () => {
    expect(mapNativeOutcomeToVerdict({ tool: 'verifai', outcome: 'violation' })).toBe(Verdict.FALSIFIED);
    expect(mapNativeOutcomeToVerdict({ tool: 'verifai', outcome: 'exhausted' })).toBe(Verdict.NOT_FALSIFIED);
    expect(mapNativeOutcomeToVerdict({ tool: 'verifai', outcome: 'incomplete' })).toBe(Verdict.UNKNOWN);
    expect(mapNativeOutcomeToVerdict({ tool: 'scenic', outcome: 'violation' })).toBe(Verdict.FALSIFIED);
    expect(mapNativeOutcomeToVerdict({ tool: 'scenic', outcome: 'sampled' })).toBe(Verdict.NOT_FALSIFIED);
    for (const tool of ['scenic', 'verifai'] as const) {
      const values: Verdict[] = Object.values(NATIVE_VERDICT_MAPPING[tool]);
      expect(values).not.toContain(Verdict.PROVED);
      expect(values).not.toContain(Verdict.BOUNDED_PASS);
    }
  });

  it('maps GAM: consistency alone is not compliance', () => {
    expect(mapNativeOutcomeToVerdict({ tool: 'gam', consistent: true, satisfied: true })).toBe(Verdict.BOUNDED_PASS);
    expect(mapNativeOutcomeToVerdict({ tool: 'gam', consistent: true, satisfied: false })).toBe(Verdict.COUNTEREXAMPLE);
    expect(mapNativeOutcomeToVerdict({ tool: 'gam', consistent: false, satisfied: true })).toBe(Verdict.COUNTEREXAMPLE);
    expect(mapNativeOutcomeToVerdict({ tool: 'gam', consistent: true })).toBe(Verdict.UNKNOWN);
    expect(mapNativeOutcomeToVerdict({ tool: 'gam' })).toBe(Verdict.NOT_RUN);
    expect(mapNativeOutcomeToVerdict({ tool: 'gam', outcome: 'violation' })).toBe(Verdict.COUNTEREXAMPLE);
  });

  it('fails closed on unrecognised outcomes and tools', () => {
    expect(mapNativeOutcomeToVerdict({ tool: 'z3', outcome: 'bogus' as never })).toBe(Verdict.ERROR);
    expect(mapNativeOutcomeToVerdict({ tool: 'alloy', outcome: 'toString' as never })).toBe(Verdict.ERROR);
    expect(mapNativeOutcomeToVerdict({ tool: 'nope', outcome: 'sat' } as never)).toBe(Verdict.ERROR);
  });

  it('covers every tool and maps every tool absence to NOT_RUN', () => {
    expect(Object.keys(NATIVE_VERDICT_MAPPING).sort()).toEqual([...FORMAL_TOOLS].sort());
    for (const tool of FORMAL_TOOLS) expect(NATIVE_VERDICT_MAPPING[tool].not_run).toBe(Verdict.NOT_RUN);
  });
});

describe('preventNotFalsifiedPromotion', () => {
  it('rejects promoting NOT_FALSIFIED to PROVED or BOUNDED_PASS', () => {
    expect(() => preventNotFalsifiedPromotion(Verdict.NOT_FALSIFIED, Verdict.PROVED)).toThrow(VerdictPromotionError);
    expect(() => preventNotFalsifiedPromotion(Verdict.NOT_FALSIFIED, Verdict.BOUNDED_PASS)).toThrow(VerdictPromotionError);
  });

  it('allows other transitions', () => {
    expect(preventNotFalsifiedPromotion(Verdict.NOT_FALSIFIED, Verdict.FALSIFIED)).toBe(Verdict.FALSIFIED);
    expect(preventNotFalsifiedPromotion(Verdict.NOT_FALSIFIED, Verdict.NOT_FALSIFIED)).toBe(Verdict.NOT_FALSIFIED);
    expect(preventNotFalsifiedPromotion(Verdict.BOUNDED_PASS, Verdict.PROVED)).toBe(Verdict.PROVED);
  });
});

describe('applyVacuityProbe', () => {
  it.each([Verdict.PROVED, Verdict.BOUNDED_PASS])('downgrades %s without a passing probe', (verdict) => {
    expect(applyVacuityProbe(verdict)).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(applyVacuityProbe(verdict, { passed: false, reason: 'A unsat' })).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(applyVacuityProbe(verdict, { passed: 'yes' as never })).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(applyVacuityProbe(verdict, { passed: true })).toBe(verdict);
  });

  it('leaves non-passing verdicts unchanged', () => {
    for (const v of ALL_VERDICTS.filter((x) => x !== Verdict.PROVED && x !== Verdict.BOUNDED_PASS)) {
      expect(applyVacuityProbe(v)).toBe(v);
    }
  });
});

describe('applyTrustedBaseGaps / capImplementationVerdict', () => {
  it('downgrades PROVED with gaps', () => {
    expect(applyTrustedBaseGaps(Verdict.PROVED, ['{:extern} f'])).toBe(Verdict.BOUNDED_PASS);
    expect(applyTrustedBaseGaps(Verdict.PROVED, [])).toBe(Verdict.PROVED);
    expect(applyTrustedBaseGaps(Verdict.COUNTEREXAMPLE, ['x'])).toBe(Verdict.COUNTEREXAMPLE);
  });

  it('caps implementation claims without a refinement link', () => {
    expect(capImplementationVerdict(Verdict.PROVED, 'compiled_from_dafny')).toBe(Verdict.PROVED);
    expect(capImplementationVerdict(Verdict.PROVED, 'refinement_proof')).toBe(Verdict.PROVED);
    expect(capImplementationVerdict(Verdict.PROVED, 'contract_tests')).toBe(Verdict.NOT_VERIFIED);
    expect(capImplementationVerdict(Verdict.BOUNDED_PASS, 'none')).toBe(Verdict.NOT_VERIFIED);
    expect(capImplementationVerdict(Verdict.COUNTEREXAMPLE, 'none')).toBe(Verdict.COUNTEREXAMPLE);
  });
});

describe('aggregateVerdictsWeakestLink', () => {
  it('orders every verdict exactly once', () => {
    expect([...VERDICT_WEAKEST_LINK_ORDER].sort()).toEqual([...ALL_VERDICTS].sort());
  });

  it('takes the weakest link, never an average', () => {
    expect(aggregateVerdictsWeakestLink([Verdict.PROVED, Verdict.PROVED, Verdict.PROVED, Verdict.UNKNOWN])).toBe(
      Verdict.UNKNOWN,
    );
    expect(aggregateVerdictsWeakestLink([Verdict.PROVED, Verdict.BOUNDED_PASS])).toBe(Verdict.BOUNDED_PASS);
    expect(aggregateVerdictsWeakestLink([Verdict.PROVED, Verdict.NOT_FALSIFIED])).toBe(Verdict.NOT_FALSIFIED);
    expect(aggregateVerdictsWeakestLink([Verdict.ERROR, Verdict.COUNTEREXAMPLE, Verdict.PROVED])).toBe(
      Verdict.COUNTEREXAMPLE,
    );
    expect(aggregateVerdictsWeakestLink([Verdict.PROVED])).toBe(Verdict.PROVED);
  });

  it('every non-pass dominates both passes', () => {
    for (const v of ALL_VERDICTS.filter((x) => x !== Verdict.PROVED && x !== Verdict.BOUNDED_PASS)) {
      expect(aggregateVerdictsWeakestLink([Verdict.PROVED, v, Verdict.BOUNDED_PASS])).toBe(v);
    }
  });

  it('is order-independent', () => {
    const vs = [Verdict.NOT_RUN, Verdict.PROVED, Verdict.SPECIFICATION_REVIEW_REQUIRED, Verdict.NOT_FALSIFIED];
    expect(aggregateVerdictsWeakestLink(vs)).toBe(aggregateVerdictsWeakestLink([...vs].reverse()));
  });

  it('fails closed on empty and unrecognised input', () => {
    expect(aggregateVerdictsWeakestLink([])).toBe(Verdict.NOT_RUN);
    expect(aggregateVerdictsWeakestLink([Verdict.PROVED, 'MAYBE' as Verdict])).toBe(Verdict.ERROR);
  });
});

describe('evaluateReleaseGate', () => {
  it('passes approved specs with formal passes', () => {
    expect(evaluateReleaseGate([Verdict.PROVED, Verdict.BOUNDED_PASS], true)).toEqual({ status: 'PASS' });
    expect(evaluateReleaseGate([Verdict.BOUNDED_PASS, Verdict.NOT_FALSIFIED], true)).toEqual({ status: 'PASS' });
  });

  it('fails when the spec is not approved', () => {
    expect(evaluateReleaseGate([Verdict.PROVED], false).status).toBe('FAIL');
  });

  it.each(RELEASE_BLOCKING_VERDICTS.map((v) => [v]))('fails closed on %s', (v) => {
    const result = evaluateReleaseGate([Verdict.PROVED, v], true);
    expect(result.status).toBe('FAIL');
    expect(result.reason).toContain(v);
  });

  it('fails on NOT_FALSIFIED without formal proof or bounded pass', () => {
    const result = evaluateReleaseGate([Verdict.NOT_FALSIFIED, Verdict.NOT_FALSIFIED], true);
    expect(result.status).toBe('FAIL');
    expect(result.reason).toMatch(/NOT_FALSIFIED/);
  });

  it('fails on empty or unrecognised verdicts', () => {
    expect(evaluateReleaseGate([], true).status).toBe('FAIL');
    expect(evaluateReleaseGate([Verdict.PROVED, 'OK' as Verdict], true).status).toBe('FAIL');
  });
});
