import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RefinementMap,
  SpecManifest,
  Verdict,
} from '../contracts';
import { EvidenceLedger, LedgerInput } from '../ledger';
import {
  DEFAULT_NON_CLAIMS,
  generateAssuranceRecord,
  ledgerEntryToPortableEvidence,
  parseAssuranceRecord,
  PortableEvidence,
  serializeAssuranceRecord,
  serializeAssuranceRecordToJson,
  serializeAssuranceRecordToYaml,
  validateAgainstEvidenceSchema,
} from '../record';
import { VerdictPromotionError } from '../verdict';

const SCHEMA_PATH = resolve(__dirname, '../../../../skills/formal/evidence.schema.json');

const APPROVED_SPEC: SpecManifest = {
  id: 'RED_SIGNAL_COMPLIANCE',
  version: '2.1',
  status: 'approved',
  source: {
    normative_ref: 'UN-R157-6.1',
    jurisdiction: 'EU',
    interpretation_date: '2026-01-15',
  },
  assumptions: ['signal_state_available', 'braking_limits_valid'],
  guarantee: 'vehicle does not cross stop line while stop obligation active',
  artifacts: [
    { tool: 'alloy', file: 'red_signal.als', commands: ['check_no_cross'], scope: 'for 5 but 8 steps' },
    { tool: 'z3', file: 'stopping_envelope.py' },
    { tool: 'dafny', file: 'stop_command.dfy' },
  ],
  monitors: [{ tool: 'verifai', file: 'red_signal_monitor.py' }],
  reviewers: ['wael'],
  content_hash: 'sha256:' + 'a'.repeat(64),
};

const REFINEMENT_MAP: RefinementMap = {
  component: 'intersection_behavior_planner',
  mappings: [
    {
      property: 'RED_SIGNAL_COMPLIANCE',
      verified_artifact: 'specs/red_signal/stop_command.dfy',
      production: 'compiled_from_dafny',
      production_path: 'src/planner/stop_command.ts',
    },
  ],
};

function makeLedgerEntryInput(overrides: Partial<LedgerInput> = {}): LedgerInput {
  return {
    propertyId: 'RED_SIGNAL_COMPLIANCE',
    specVersion: '2.1',
    specHash: APPROVED_SPEC.content_hash,
    sourceCommit: 'commit-final',
    workspaceRev: 'rev-2',
    tool: 'z3',
    toolVersion: '4.13.0',
    inputHash: 'b'.repeat(64),
    scope: 'unbounded',
    assumptions: ['signal_state_available', 'braking_limits_valid'],
    verdict: Verdict.PROVED,
    elapsedMs: 18,
    artifactHashes: { 'stopping_envelope.py': 'c'.repeat(64) },
    fencingToken: 1,
    ...overrides,
  };
}

describe('AssuranceRecord generation (§2.7)', () => {
  it('generates a complete AssuranceRecord matching §2.7 with all formal levels and PASS gate', () => {
    const ledger = new EvidenceLedger();
    // Prior commit had a counterexample during repair loop
    ledger.append(
      makeLedgerEntryInput({
        sourceCommit: 'commit-buggy',
        workspaceRev: 'rev-1',
        tool: 'z3',
        verdict: Verdict.COUNTEREXAMPLE,
        witness: { v: 15, dist: 10 },
      }),
    );
    // Final commit passes all levels (fencingToken: 2 for rev-2)
    ledger.append(
      makeLedgerEntryInput({
        fencingToken: 2,
        tool: 'alloy',
        toolVersion: '6.2.0',
        scope: 'for 5 but 8 steps',
        verdict: Verdict.BOUNDED_PASS,
      }),
    );
    ledger.append(
      makeLedgerEntryInput({
        fencingToken: 2,
        tool: 'z3',
        toolVersion: '4.13.0',
        scope: 'unbounded',
        verdict: Verdict.PROVED,
      }),
    );
    ledger.append(
      makeLedgerEntryInput({
        fencingToken: 2,
        tool: 'dafny',
        toolVersion: '4.7.0',
        scope: 'unbounded',
        verdict: Verdict.PROVED,
      }),
    );
    ledger.append(
      makeLedgerEntryInput({
        fencingToken: 2,
        tool: 'verifai',
        toolVersion: '2.1.0',
        scope: '200 samples',
        verdict: Verdict.NOT_FALSIFIED,
        seeds: [101, 102, 103],
      }),
    );

    const record = generateAssuranceRecord({
      component: 'intersection_behavior_planner',
      version: '1.2.0',
      sourceCommit: 'commit-final',
      ledgerEntries: ledger.entries,
      specs: [APPROVED_SPEC],
      refinement: REFINEMENT_MAP,
      regressionObligations: 1,
      runtimeMonitors: { RED_SIGNAL_COMPLIANCE: 'ENABLED' },
    });

    expect(record.component).toBe('intersection_behavior_planner');
    expect(record.version).toBe('1.2.0');
    expect(record.source_commit).toBe('commit-final');
    expect(record.counterexamples_found).toBe(1);
    expect(record.regression_obligations).toBe(1);
    expect(record.release_gate).toEqual({ status: 'PASS' });

    const prop = record.properties.RED_SIGNAL_COMPLIANCE;
    expect(prop).toBeDefined();
    expect(prop.spec_version).toBe(`2.1 (${APPROVED_SPEC.content_hash})`);
    expect(prop.specification_consistency).toBe(Verdict.BOUNDED_PASS);
    expect(prop.decision_envelope).toBe(Verdict.PROVED);
    expect(prop.implementation_contract).toBe(Verdict.PROVED);
    expect(prop.simulation_falsification).toBe(Verdict.NOT_FALSIFIED);
    expect(prop.runtime_monitor).toBe('ENABLED');
    // Weakest link across BOUNDED_PASS, PROVED, PROVED, NOT_FALSIFIED is NOT_FALSIFIED
    expect(prop.overall).toBe(Verdict.NOT_FALSIFIED);

    expect(record.assumptions).toContain('signal_state_available');
    expect(record.assumptions).toContain('braking_limits_valid');
    expect(record.trusted_base).toEqual(expect.arrayContaining(['z3_solver', 'alloy_analyzer', 'dafny_verifier']));
    expect(record.coverage_limits.some((c) => c.includes('for 5 but 8 steps'))).toBe(true);
  });

  it('always includes explicit non_claims and not_claimed defaults plus custom non-claims', () => {
    const ledger = new EvidenceLedger();
    ledger.append(makeLedgerEntryInput({ tool: 'z3', verdict: Verdict.PROVED }));

    const record = generateAssuranceRecord({
      component: 'intersection_behavior_planner',
      sourceCommit: 'commit-final',
      ledgerEntries: ledger.entries,
      specs: [{ ...APPROVED_SPEC, artifacts: [{ tool: 'z3', file: 'stopping_envelope.py' }], monitors: [] }],
      nonClaims: ['sensor_fusion_latency'],
      notClaimed: ['tire_friction_estimation'],
    });

    for (const def of DEFAULT_NON_CLAIMS) {
      expect(record.non_claims).toContain(def);
      expect(record.not_claimed).toContain(def);
    }
    expect(record.non_claims).toContain('sensor_fusion_latency');
    expect(record.non_claims).toContain('tire_friction_estimation');
    expect(record.not_claimed).toEqual(record.non_claims);
  });

  it('caps implementation_contract at NOT_VERIFIED and fails release gate when refinement is contract_tests or none', () => {
    const ledger = new EvidenceLedger();
    ledger.append(makeLedgerEntryInput({ tool: 'dafny', verdict: Verdict.PROVED }));

    const record = generateAssuranceRecord({
      component: 'intersection_behavior_planner',
      sourceCommit: 'commit-final',
      ledgerEntries: ledger.entries,
      specs: [{ ...APPROVED_SPEC, artifacts: [{ tool: 'dafny', file: 'stop_command.dfy' }], monitors: [] }],
      refinement: {
        component: 'intersection_behavior_planner',
        mappings: [
          {
            property: 'RED_SIGNAL_COMPLIANCE',
            verified_artifact: 'specs/red_signal/stop_command.dfy',
            production: 'contract_tests',
          },
        ],
      },
    });

    expect(record.properties.RED_SIGNAL_COMPLIANCE.implementation_contract).toBe(Verdict.NOT_VERIFIED);
    expect(record.release_gate.status).toBe('FAIL');
    expect(record.release_gate.reason).toContain(Verdict.NOT_VERIFIED);
  });

  it('downgrades Dafny PROVED to BOUNDED_PASS when trustedBaseGaps are present in metadata', () => {
    const ledger = new EvidenceLedger();
    ledger.append(
      makeLedgerEntryInput({
        tool: 'dafny',
        verdict: Verdict.PROVED,
        metadata: { trustedBaseGaps: ['{:axiom} brake_lemma'] },
      }),
    );

    const record = generateAssuranceRecord({
      component: 'intersection_behavior_planner',
      sourceCommit: 'commit-final',
      ledgerEntries: ledger.entries,
      specs: [{ ...APPROVED_SPEC, artifacts: [{ tool: 'dafny', file: 'stop_command.dfy' }], monitors: [] }],
      refinement: REFINEMENT_MAP,
    });

    expect(record.properties.RED_SIGNAL_COMPLIANCE.implementation_contract).toBe(Verdict.BOUNDED_PASS);
    expect(record.trusted_base).toContain('RED_SIGNAL_COMPLIANCE:dafny:{:axiom} brake_lemma');
  });

  it('never promotes NOT_FALSIFIED to PROVED or BOUNDED_PASS in record generation or release gate', () => {
    const ledger = new EvidenceLedger();
    ledger.append(
      makeLedgerEntryInput({
        tool: 'verifai',
        verdict: Verdict.NOT_FALSIFIED,
      }),
    );

    // Only NOT_FALSIFIED evidence -> release gate must FAIL
    const recordOnlySim = generateAssuranceRecord({
      component: 'intersection_behavior_planner',
      sourceCommit: 'commit-final',
      ledgerEntries: ledger.entries,
      specs: [{ ...APPROVED_SPEC, artifacts: [], monitors: [{ tool: 'verifai', file: 'red_signal_monitor.py' }] }],
    });

    expect(recordOnlySim.properties.RED_SIGNAL_COMPLIANCE.simulation_falsification).toBe(Verdict.NOT_FALSIFIED);
    expect(recordOnlySim.release_gate.status).toBe('FAIL');
    expect(recordOnlySim.release_gate.reason).toMatch(/NOT_FALSIFIED/);

    // Attempting to override NOT_FALSIFIED to PROVED or BOUNDED_PASS throws VerdictPromotionError
    expect(() =>
      generateAssuranceRecord({
        component: 'intersection_behavior_planner',
        sourceCommit: 'commit-final',
        ledgerEntries: ledger.entries,
        specs: [{ ...APPROVED_SPEC, artifacts: [], monitors: [{ tool: 'verifai', file: 'red_signal_monitor.py' }] }],
        levelOverrides: {
          RED_SIGNAL_COMPLIANCE: { simulation_falsification: Verdict.PROVED },
        },
      }),
    ).toThrow(VerdictPromotionError);

    expect(() =>
      generateAssuranceRecord({
        component: 'intersection_behavior_planner',
        sourceCommit: 'commit-final',
        ledgerEntries: ledger.entries,
        specs: [{ ...APPROVED_SPEC, artifacts: [], monitors: [{ tool: 'verifai', file: 'red_signal_monitor.py' }] }],
        levelOverrides: {
          RED_SIGNAL_COMPLIANCE: { simulation_falsification: Verdict.BOUNDED_PASS },
        },
      }),
    ).toThrow(VerdictPromotionError);

    // Even if a corrupted ledger entry for a simulation tool claims PROVED, generateAssuranceRecord throws VerdictPromotionError
    const badEntry = {
      ...ledger.entries[0],
      tool: 'scenic' as const,
      verdict: Verdict.PROVED,
    };
    expect(() =>
      generateAssuranceRecord({
        component: 'intersection_behavior_planner',
        sourceCommit: 'commit-final',
        ledgerEntries: [badEntry],
      }),
    ).toThrow(VerdictPromotionError);
  });

  it('fails the release gate when a spec is draft/unapproved or an artifact obligation was NOT_RUN', () => {
    const ledger = new EvidenceLedger();
    // Only Z3 ran; Alloy and Dafny from APPROVED_SPEC did not run -> NOT_RUN
    ledger.append(makeLedgerEntryInput({ tool: 'z3', verdict: Verdict.PROVED }));

    const partialRecord = generateAssuranceRecord({
      component: 'intersection_behavior_planner',
      sourceCommit: 'commit-final',
      ledgerEntries: ledger.entries,
      specs: [APPROVED_SPEC],
    });

    expect(partialRecord.properties.RED_SIGNAL_COMPLIANCE.specification_consistency).toBe(Verdict.NOT_RUN);
    expect(partialRecord.properties.RED_SIGNAL_COMPLIANCE.implementation_contract).toBe(Verdict.NOT_RUN);
    expect(partialRecord.release_gate.status).toBe('FAIL');
    expect(partialRecord.release_gate.reason).toContain(Verdict.NOT_RUN);

    // Draft spec fails gate even when Z3 is the only artifact and PROVED
    const draftSpec: SpecManifest = {
      ...APPROVED_SPEC,
      status: 'draft',
      reviewers: [],
      artifacts: [{ tool: 'z3', file: 'stopping_envelope.py' }],
      monitors: [],
    };
    const draftRecord = generateAssuranceRecord({
      component: 'intersection_behavior_planner',
      sourceCommit: 'commit-final',
      ledgerEntries: ledger.entries,
      specs: [draftSpec],
    });
    expect(draftRecord.release_gate.status).toBe('FAIL');
    expect(draftRecord.release_gate.reason).toBe('spec not approved');
  });
});

describe('YAML and JSON serialization', () => {
  it('round-trips AssuranceRecord through both YAML and JSON', () => {
    const ledger = new EvidenceLedger();
    ledger.append(makeLedgerEntryInput({ tool: 'alloy', scope: 'for 5 but 8 steps', verdict: Verdict.BOUNDED_PASS }));
    ledger.append(makeLedgerEntryInput({ tool: 'z3', verdict: Verdict.PROVED }));
    ledger.append(makeLedgerEntryInput({ tool: 'dafny', verdict: Verdict.PROVED }));
    ledger.append(makeLedgerEntryInput({ tool: 'verifai', verdict: Verdict.NOT_FALSIFIED, seeds: [7, 8] }));

    const record = generateAssuranceRecord({
      component: 'intersection_behavior_planner',
      version: '1.0.0',
      sourceCommit: 'commit-final',
      ledgerEntries: ledger.entries,
      specs: [APPROVED_SPEC],
      refinement: REFINEMENT_MAP,
      regressionObligations: { RED_SIGNAL_COMPLIANCE: 2 },
    });

    const jsonText = serializeAssuranceRecordToJson(record);
    const parsedFromJson = parseAssuranceRecord(jsonText);
    expect(parsedFromJson).toEqual(record);

    const yamlText = serializeAssuranceRecordToYaml(record);
    expect(yamlText).toContain('component: intersection_behavior_planner');
    expect(yamlText).toContain('RED_SIGNAL_COMPLIANCE:');
    expect(yamlText).toContain('specification_consistency: BOUNDED_PASS');
    expect(yamlText).toContain('decision_envelope: PROVED');
    expect(yamlText).toContain('implementation_contract: PROVED');
    expect(yamlText).toContain('simulation_falsification: NOT_FALSIFIED');
    expect(yamlText).toContain('non_claims:');
    expect(yamlText).toContain('- perception_correctness');
    expect(yamlText).toContain('release_gate:');
    expect(yamlText).toContain('status: PASS');

    const parsedFromYaml = parseAssuranceRecord(yamlText);
    expect(parsedFromYaml).toEqual(record);
    expect(serializeAssuranceRecord(record, 'json')).toBe(jsonText);
    expect(serializeAssuranceRecord(record, 'yaml')).toBe(yamlText);
  });
});

describe('validateAgainstEvidenceSchema (skills/formal/evidence.schema.json & AssuranceRecord)', () => {
  it('validates a valid PortableEvidence converted from a LedgerEntry against evidence.schema.json', () => {
    const ledger = new EvidenceLedger();
    const entry = ledger.append(makeLedgerEntryInput({ tool: 'z3', verdict: Verdict.PROVED, seed: 42 }));
    const portable = ledgerEntryToPortableEvidence(entry, {
      spec: APPROVED_SPEC,
      command: 'python3 stopping_envelope.py',
    });

    const res = validateAgainstEvidenceSchema(portable, SCHEMA_PATH);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.target).toBe('evidence');
  });

  it('rejects invalid PortableEvidence missing required fields, bad sha256, unknown additionalProperties, or promoted simulation verdicts', () => {
    const badEvidence: Partial<PortableEvidence> & Record<string, unknown> = {
      evidence_id: '',
      skill: 'verifai',
      requirement_id: 'REQ-1',
      property_id: 'RED_SIGNAL_COMPLIANCE',
      specification_revision: '2.1',
      workspace_id: 'ws-1',
      workspace_revision: 1,
      source_commit: 'abc',
      tool_version: '2.1',
      status: Verdict.PROVED, // illegal for verifai!
      scope: '100 samples',
      assumptions: ['a1'],
      command: 'verifai run',
      artifacts: [{ path: 'out.json', sha256: 'not-a-sha256' }],
      extra_field: 'not-allowed',
    };

    const res = validateAgainstEvidenceSchema(badEvidence, SCHEMA_PATH);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('evidence_id'))).toBe(true);
    expect(res.errors.some((e) => e.includes('sha256'))).toBe(true);
    expect(res.errors.some((e) => e.includes('extra_field'))).toBe(true);
    expect(res.errors.some((e) => e.includes('NOT_FALSIFIED cannot be promoted'))).toBe(true);
  });

  it('validates a well-formed AssuranceRecord and rejects missing non_claims or illegal NOT_FALSIFIED promotion', () => {
    const ledger = new EvidenceLedger();
    ledger.append(makeLedgerEntryInput({ tool: 'z3', verdict: Verdict.PROVED }));

    const record = generateAssuranceRecord({
      component: 'intersection_behavior_planner',
      version: '1.0.0',
      sourceCommit: 'commit-final',
      ledgerEntries: ledger.entries,
      specs: [{ ...APPROVED_SPEC, artifacts: [{ tool: 'z3', file: 'stopping_envelope.py' }], monitors: [] }],
    });

    const validRes = validateAgainstEvidenceSchema(record, SCHEMA_PATH);
    expect(validRes.valid).toBe(true);
    expect(validRes.errors).toEqual([]);
    expect(validRes.target).toBe('record');

    // Missing default non_claims fails validation
    const missingNonClaims = {
      ...record,
      non_claims: ['perception_correctness'],
      not_claimed: ['perception_correctness'],
    };
    const invalidNonClaimsRes = validateAgainstEvidenceSchema(missingNonClaims, SCHEMA_PATH);
    expect(invalidNonClaimsRes.valid).toBe(false);
    expect(invalidNonClaimsRes.errors.some((e) => e.includes('physical_dynamics_fidelity'))).toBe(true);

    // Tampered simulation_falsification promoted to PROVED fails validation
    const tamperedSim = {
      ...record,
      properties: {
        RED_SIGNAL_COMPLIANCE: {
          ...record.properties.RED_SIGNAL_COMPLIANCE,
          simulation_falsification: Verdict.PROVED,
        },
      },
    };
    const tamperedRes = validateAgainstEvidenceSchema(tamperedSim, SCHEMA_PATH);
    expect(tamperedRes.valid).toBe(false);
    expect(tamperedRes.errors.some((e) => e.includes('simulation_falsification'))).toBe(true);

    // Release gate PASS with only NOT_FALSIFIED fails validation
    const tamperedGate = {
      ...record,
      properties: {
        RED_SIGNAL_COMPLIANCE: {
          spec_version: '2.1',
          simulation_falsification: Verdict.NOT_FALSIFIED,
          overall: Verdict.NOT_FALSIFIED,
        },
      },
      release_gate: { status: 'PASS' as const },
    };
    const tamperedGateRes = validateAgainstEvidenceSchema(tamperedGate, SCHEMA_PATH);
    expect(tamperedGateRes.valid).toBe(false);
    expect(tamperedGateRes.errors.some((e) => e.includes('release_gate'))).toBe(true);
  });
});
