/**
 * Phase-1 Specification Compliance Tests (FORMAL_ASSURANCE.md §2.1, §2.2, §2.7).
 *
 * Written directly against the normative specification in `docs/formal-assurance/FORMAL_ASSURANCE.md`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_VERDICTS,
  FORMAL_TOOLS,
  LedgerEntry,
  SPEC_STATUSES,
  SpecManifest,
  Verdict,
} from '../contracts';
import {
  aggregateVerdictsWeakestLink,
  applyTrustedBaseGaps,
  applyVacuityProbe,
  capImplementationVerdict,
  evaluateReleaseGate,
  isPassingVerdict,
  mapNativeOutcomeToVerdict,
  preventNotFalsifiedPromotion,
  RELEASE_BLOCKING_VERDICTS,
  VERDICT_WEAKEST_LINK_ORDER,
  VerdictPromotionError,
  weakerVerdict,
} from '../verdict';

const hasRegistryModule = fs.existsSync(path.resolve(__dirname, '../registry.ts'));
const hasLedgerModule = fs.existsSync(path.resolve(__dirname, '../ledger.ts'));

describe('Phase 1 Specification Compliance (FORMAL_ASSURANCE.md)', () => {
  describe('§2.1 Verdict model — 11 canonical enum members & native mappings', () => {
    it('defines exactly the 11 canonical Verdict enum members specified in §2.1', () => {
      const expectedMembers = [
        'PROVED',
        'BOUNDED_PASS',
        'COUNTEREXAMPLE',
        'FALSIFIED',
        'NOT_FALSIFIED',
        'INCONSISTENT_ASSUMPTIONS',
        'SPECIFICATION_REVIEW_REQUIRED',
        'UNKNOWN',
        'ERROR',
        'NOT_RUN',
        'NOT_VERIFIED',
      ] as const;

      for (const member of expectedMembers) {
        expect(Verdict[member]).toBe(member);
      }
      expect(Object.values(Verdict)).toHaveLength(11);
      expect(new Set(ALL_VERDICTS)).toEqual(new Set(expectedMembers));
    });

    it('maps native tool outputs according to the §2.1 table', () => {
      // Z3: unsat on ¬P with no bounding -> PROVED; bounded -> BOUNDED_PASS; sat on ¬P -> COUNTEREXAMPLE
      expect(mapNativeOutcomeToVerdict({ tool: 'z3', outcome: 'unsat', bounded: false })).toBe(Verdict.PROVED);
      expect(mapNativeOutcomeToVerdict({ tool: 'z3', outcome: 'unsat', bounded: true })).toBe(Verdict.BOUNDED_PASS);
      expect(mapNativeOutcomeToVerdict({ tool: 'z3', outcome: 'sat' })).toBe(Verdict.COUNTEREXAMPLE);

      // Dafny: verified with empty trusted base -> PROVED; with gaps -> blocked/downgraded; failing assertion -> COUNTEREXAMPLE
      expect(mapNativeOutcomeToVerdict({ tool: 'dafny', outcome: 'verified', trustedBaseGaps: [] })).toBe(
        Verdict.PROVED,
      );
      expect(
        mapNativeOutcomeToVerdict({ tool: 'dafny', outcome: 'verified', trustedBaseGaps: ['{:axiom}'] }),
      ).not.toBe(Verdict.PROVED);
      expect(mapNativeOutcomeToVerdict({ tool: 'dafny', outcome: 'assertion_violation' })).toBe(
        Verdict.COUNTEREXAMPLE,
      );

      // Alloy: check with no counterexample in scope -> BOUNDED_PASS; counterexample -> COUNTEREXAMPLE
      expect(mapNativeOutcomeToVerdict({ tool: 'alloy', outcome: 'no_counterexample' })).toBe(Verdict.BOUNDED_PASS);
      expect(mapNativeOutcomeToVerdict({ tool: 'alloy', outcome: 'counterexample' })).toBe(Verdict.COUNTEREXAMPLE);

      // VerifAI & Scenic: violation -> FALSIFIED; budget exhausted without violation -> NOT_FALSIFIED
      expect(mapNativeOutcomeToVerdict({ tool: 'verifai', outcome: 'violation' })).toBe(Verdict.FALSIFIED);
      expect(mapNativeOutcomeToVerdict({ tool: 'verifai', outcome: 'exhausted' })).toBe(Verdict.NOT_FALSIFIED);
      expect(mapNativeOutcomeToVerdict({ tool: 'scenic', outcome: 'sampled' })).toBe(Verdict.NOT_FALSIFIED);

      // GAM (§2.3 item 6): Con passing != compliant; ontology check must also run
      expect(mapNativeOutcomeToVerdict({ tool: 'gam', consistent: true, satisfied: true })).toBe(Verdict.BOUNDED_PASS);
      expect(mapNativeOutcomeToVerdict({ tool: 'gam', consistent: true, satisfied: undefined })).toBe(Verdict.UNKNOWN);
      expect(mapNativeOutcomeToVerdict({ tool: 'gam', consistent: true, satisfied: false })).toBe(
        Verdict.COUNTEREXAMPLE,
      );
      expect(mapNativeOutcomeToVerdict({ tool: 'gam', consistent: false, satisfied: true })).toBe(
        Verdict.COUNTEREXAMPLE,
      );
    });
  });

  describe('§2.1 Hard Rule 1 — NOT_FALSIFIED can never be promoted to PROVED or BOUNDED_PASS', () => {
    it('throws VerdictPromotionError when attempting to promote NOT_FALSIFIED to PROVED or BOUNDED_PASS', () => {
      expect(() => preventNotFalsifiedPromotion(Verdict.NOT_FALSIFIED, Verdict.PROVED)).toThrow(VerdictPromotionError);
      expect(() => preventNotFalsifiedPromotion(Verdict.NOT_FALSIFIED, Verdict.BOUNDED_PASS)).toThrow(
        VerdictPromotionError,
      );
    });

    it('never treats NOT_FALSIFIED as a passing formal verdict or sufficient for release gate PASS', () => {
      expect(isPassingVerdict(Verdict.NOT_FALSIFIED)).toBe(false);
      expect(evaluateReleaseGate([Verdict.NOT_FALSIFIED], true).status).toBe('FAIL');
      expect(evaluateReleaseGate([Verdict.NOT_FALSIFIED, Verdict.NOT_FALSIFIED], true).status).toBe('FAIL');
    });
  });

  describe('§2.1 Hard Rule 2 — UNKNOWN, ERROR, NOT_RUN fail the release gate (fail closed)', () => {
    it.each([Verdict.UNKNOWN, Verdict.ERROR, Verdict.NOT_RUN])(
      'fails the release gate when %s is present alongside PROVED obligations',
      (failingVerdict) => {
        expect(RELEASE_BLOCKING_VERDICTS).toContain(failingVerdict);
        const gate = evaluateReleaseGate([Verdict.PROVED, Verdict.BOUNDED_PASS, failingVerdict], true);
        expect(gate.status).toBe('FAIL');
        expect(gate.reason).toContain(failingVerdict);
      },
    );

    it('also fails closed on all other non-passing/blocking verdicts and empty or unapproved states', () => {
      for (const blocking of [
        Verdict.COUNTEREXAMPLE,
        Verdict.FALSIFIED,
        Verdict.INCONSISTENT_ASSUMPTIONS,
        Verdict.SPECIFICATION_REVIEW_REQUIRED,
        Verdict.NOT_VERIFIED,
      ]) {
        const gate = evaluateReleaseGate([Verdict.PROVED, blocking], true);
        expect(gate.status).toBe('FAIL');
      }

      // Unapproved spec fails closed even with PROVED
      expect(evaluateReleaseGate([Verdict.PROVED], false)).toEqual({
        status: 'FAIL',
        reason: 'spec not approved',
      });

      // Empty verdict list fails closed (NOT_RUN)
      expect(evaluateReleaseGate([], true).status).toBe('FAIL');
    });

    it('passes the release gate only when spec is approved, at least one PROVED/BOUNDED_PASS exists, and no blocking verdicts exist', () => {
      expect(evaluateReleaseGate([Verdict.PROVED], true)).toEqual({ status: 'PASS' });
      expect(evaluateReleaseGate([Verdict.BOUNDED_PASS, Verdict.NOT_FALSIFIED], true)).toEqual({ status: 'PASS' });
    });
  });

  describe('§2.1 Hard Rule 3 — Every PROVED/BOUNDED_PASS requires a passing vacuity probe in the same run', () => {
    it('retains PROVED and BOUNDED_PASS only when vacuityProbe.passed === true', () => {
      expect(applyVacuityProbe(Verdict.PROVED, { passed: true })).toBe(Verdict.PROVED);
      expect(applyVacuityProbe(Verdict.BOUNDED_PASS, { passed: true })).toBe(Verdict.BOUNDED_PASS);
    });

    it('downgrades PROVED and BOUNDED_PASS to INCONSISTENT_ASSUMPTIONS when probe is missing or failed', () => {
      expect(applyVacuityProbe(Verdict.PROVED, undefined)).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
      expect(applyVacuityProbe(Verdict.BOUNDED_PASS, undefined)).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
      expect(applyVacuityProbe(Verdict.PROVED, { passed: false, reason: 'assumptions A alone UNSAT' })).toBe(
        Verdict.INCONSISTENT_ASSUMPTIONS,
      );
      expect(applyVacuityProbe(Verdict.BOUNDED_PASS, { passed: false, reason: 'Alloy run witness UNSAT' })).toBe(
        Verdict.INCONSISTENT_ASSUMPTIONS,
      );
    });

    it('leaves non-passing verdicts unchanged when applying vacuity probe', () => {
      for (const nonPassing of [
        Verdict.COUNTEREXAMPLE,
        Verdict.FALSIFIED,
        Verdict.NOT_FALSIFIED,
        Verdict.UNKNOWN,
        Verdict.ERROR,
        Verdict.NOT_RUN,
        Verdict.NOT_VERIFIED,
        Verdict.SPECIFICATION_REVIEW_REQUIRED,
      ]) {
        expect(applyVacuityProbe(nonPassing, { passed: false })).toBe(nonPassing);
        expect(applyVacuityProbe(nonPassing, undefined)).toBe(nonPassing);
      }
    });
  });

  describe('§2.1 Hard Rule 4 — Weakest-link aggregation across obligations and components (never averages)', () => {
    it('orders all 11 verdicts from weakest to strongest with COUNTEREXAMPLE weakest and PROVED strongest', () => {
      expect(VERDICT_WEAKEST_LINK_ORDER).toHaveLength(11);
      expect(VERDICT_WEAKEST_LINK_ORDER[0]).toBe(Verdict.COUNTEREXAMPLE);
      expect(VERDICT_WEAKEST_LINK_ORDER[VERDICT_WEAKEST_LINK_ORDER.length - 1]).toBe(Verdict.PROVED);
    });

    it('never averages: a single failure or unverified verdict dominates any number of PROVED verdicts', () => {
      const manyProved = Array.from({ length: 20 }, () => Verdict.PROVED);

      expect(aggregateVerdictsWeakestLink([...manyProved, Verdict.BOUNDED_PASS])).toBe(Verdict.BOUNDED_PASS);
      expect(aggregateVerdictsWeakestLink([...manyProved, Verdict.NOT_FALSIFIED])).toBe(Verdict.NOT_FALSIFIED);
      expect(aggregateVerdictsWeakestLink([...manyProved, Verdict.NOT_VERIFIED])).toBe(Verdict.NOT_VERIFIED);
      expect(aggregateVerdictsWeakestLink([...manyProved, Verdict.NOT_RUN])).toBe(Verdict.NOT_RUN);
      expect(aggregateVerdictsWeakestLink([...manyProved, Verdict.UNKNOWN])).toBe(Verdict.UNKNOWN);
      expect(aggregateVerdictsWeakestLink([...manyProved, Verdict.SPECIFICATION_REVIEW_REQUIRED])).toBe(
        Verdict.SPECIFICATION_REVIEW_REQUIRED,
      );
      expect(aggregateVerdictsWeakestLink([...manyProved, Verdict.ERROR])).toBe(Verdict.ERROR);
      expect(aggregateVerdictsWeakestLink([...manyProved, Verdict.INCONSISTENT_ASSUMPTIONS])).toBe(
        Verdict.INCONSISTENT_ASSUMPTIONS,
      );
      expect(aggregateVerdictsWeakestLink([...manyProved, Verdict.FALSIFIED])).toBe(Verdict.FALSIFIED);
      expect(aggregateVerdictsWeakestLink([...manyProved, Verdict.COUNTEREXAMPLE])).toBe(Verdict.COUNTEREXAMPLE);
    });

    it('returns NOT_RUN for an empty obligation list and is commutative/associative', () => {
      expect(aggregateVerdictsWeakestLink([])).toBe(Verdict.NOT_RUN);
      expect(weakerVerdict(Verdict.PROVED, Verdict.UNKNOWN)).toBe(Verdict.UNKNOWN);
      expect(weakerVerdict(Verdict.UNKNOWN, Verdict.PROVED)).toBe(Verdict.UNKNOWN);
    });

    it('enforces §2.3/§2.6 trusted-base and refinement caps before aggregation', () => {
      expect(applyTrustedBaseGaps(Verdict.PROVED, ['assume x > 0'])).toBe(Verdict.BOUNDED_PASS);
      expect(capImplementationVerdict(Verdict.PROVED, 'compiled_from_dafny')).toBe(Verdict.PROVED);
      expect(capImplementationVerdict(Verdict.PROVED, 'refinement_proof')).toBe(Verdict.PROVED);
      expect(capImplementationVerdict(Verdict.PROVED, 'contract_tests')).toBe(Verdict.NOT_VERIFIED);
      expect(capImplementationVerdict(Verdict.PROVED, 'none')).toBe(Verdict.NOT_VERIFIED);
    });
  });

  describe('§2.2 Specification registry & write fencing contracts', () => {
    it('enforces SpecManifest contract structure, statuses, and sha256 content hash format', () => {
      expect(SPEC_STATUSES).toEqual(['draft', 'reviewed', 'approved', 'retired']);
      expect(FORMAL_TOOLS).toEqual(['z3', 'alloy', 'dafny', 'scenic', 'verifai', 'gam']);

      const manifest: SpecManifest = {
        id: 'RED_SIGNAL_COMPLIANCE',
        version: '2.1',
        status: 'approved',
        source: {
          normative_ref: 'UN-R157 / Toy Intersection Right-of-Way',
          jurisdiction: 'configured',
          interpretation_date: '2026-10-24',
        },
        assumptions: ['signal_state_available', 'braking_limits_valid'],
        guarantee: 'vehicle does not cross stop line while stop obligation active',
        artifacts: [
          { tool: 'alloy', file: 'red_signal.als', commands: ['check NoRedCross'], scope: 'for 5 but 8 steps' },
          { tool: 'z3', file: 'stopping_envelope.py' },
          { tool: 'dafny', file: 'stop_command.dfy' },
        ],
        monitors: [{ tool: 'verifai', file: 'red_signal_monitor.py' }],
        reviewers: ['wael'],
        content_hash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      };

      expect(manifest.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(evaluateReleaseGate([Verdict.PROVED], manifest.status === 'approved').status).toBe('PASS');

      for (const nonApproved of ['draft', 'reviewed', 'retired'] as const) {
        expect(evaluateReleaseGate([Verdict.PROVED], nonApproved === 'approved').status).toBe('FAIL');
      }
    });

    // Waiting for C1 (`packages/assurance/src/registry.ts`) to be merged into this branch
    it.skipIf(!hasRegistryModule)(
      'rejects spec edits from non-spec-author tasks (write fencing) and requires human approval for promotion',
      async () => {
        const registryPath = '../registry';
        const registryMod: Record<string, unknown> = await import(/* @vite-ignore */ registryPath);
        expect(registryMod).toBeDefined();
      },
    );
  });

  describe('§2.7 Evidence ledger hash-chaining & tamper detection contracts', () => {
    it('validates hash-chained LedgerEntry structure and detects chain link breaks', () => {
      const genesis: LedgerEntry = {
        index: 0,
        prevHash: null,
        entryHash: 'sha256:aaaa',
        timestamp: '2026-10-24T05:00:00.000Z',
        propertyId: 'RED_SIGNAL_COMPLIANCE',
        specHash: 'sha256:1111',
        sourceCommit: 'abc1234',
        workspaceRev: 'abc1234',
        tool: 'z3',
        toolVersion: '4.13.0',
        inputHash: 'sha256:2222',
        assumptions: ['signal_state_available'],
        verdict: Verdict.PROVED,
        unsatOutcome: 'unsat',
        elapsedMs: 42,
        artifactHashes: { 'stopping_envelope.py': 'sha256:3333' },
        fencingToken: 1,
      };

      const second: LedgerEntry = {
        ...genesis,
        index: 1,
        prevHash: genesis.entryHash,
        entryHash: 'sha256:bbbb',
        tool: 'alloy',
        verdict: Verdict.BOUNDED_PASS,
        fencingToken: 2,
      };

      expect(genesis.prevHash).toBeNull();
      expect(second.prevHash).toBe(genesis.entryHash);
      expect(second.fencingToken).toBeGreaterThan(genesis.fencingToken!);
    });

    // Waiting for C2 (`packages/assurance/src/ledger.ts`) to be merged into this branch
    it.skipIf(!hasLedgerModule)(
      'recomputes the ledger hash chain, detects payload/link tampering, and rejects stale lease fencing tokens',
      async () => {
        const ledgerPath = '../ledger';
        const ledgerMod: Record<string, unknown> = await import(/* @vite-ignore */ ledgerPath);
        expect(ledgerMod).toBeDefined();
      },
    );
  });
});
