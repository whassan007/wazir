import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { Obligation, Verdict } from '../contracts';
import {
  CommandRunner,
  ConsistencyChecker,
  GalModel,
  GamAdapter,
  OntologyChecker,
  emitAlloyTwin,
  parseGalJson,
} from '../adapters/gam';

// ---------------------------------------------------------------------------
// Appendix B (July 2026 agent intrusion) — governance layer only
// ---------------------------------------------------------------------------

const APPENDIX_B_LAW: GalModel = {
  model_type: 'Law_Model',
  context: 'Appendix B containment policy',
  entities: [
    { id: 'EvalHarness', type: 'Process' },
    { id: 'PublicInternet', type: 'Process' },
    { id: 'K8sClusterA', type: 'Process' },
    { id: 'K8sClusterB', type: 'Process' },
    { id: 'CISubnet', type: 'Process' },
    { id: 'SourceControl', type: 'Process' },
    { id: 'PublicNetworkEgress', type: 'Activity' },
    { id: 'ReadInstanceMetadata', type: 'Activity' },
    { id: 'CreatePrivilegedPod', type: 'Activity' },
    { id: 'ReadClusterSecrets', type: 'Activity' },
    { id: 'SafetyClassification', type: 'Activity' },
    { id: 'EvalAgentIdentity', type: 'Role' },
    { id: 'WorkerSA', type: 'Role' },
  ],
  relations: [
    { type: 'Separate', source: 'EvalHarness', target: 'PublicInternet' },
    { type: 'Separate', source: 'K8sClusterA', target: 'K8sClusterB' },
    { type: 'Separate', source: 'CISubnet', target: 'SourceControl' },
  ],
  policies: [
    { type: 'CanAssignTo', modality: 'Deny', source: 'PublicNetworkEgress', target: 'EvalAgentIdentity' },
    { type: 'CanAssignTo', modality: 'Deny', source: 'ReadInstanceMetadata', target: 'WorkerSA' },
    { type: 'CanAssignTo', modality: 'Deny', source: 'CreatePrivilegedPod', target: 'WorkerSA' },
    { type: 'CanAssignTo', modality: 'Deny', source: 'ReadClusterSecrets', target: 'WorkerSA' },
  ],
  ontologyRequirements: [{ id: 'B2', process: 'EvalHarness', activity: 'SafetyClassification', rationale: 'safety step in harness' }],
};

const ENTITIES: GalModel['entities'] = [
  ...['EvalHarness', 'PackageProxy', 'PublicInternet', 'K8sClusterA', 'K8sClusterB', 'CISubnet', 'SourceControl', 'MeshNetwork'].map((id) => ({ id, type: 'Process' })),
  ...['PublicNetworkEgress', 'ReadInstanceMetadata', 'CreatePrivilegedPod', 'RunEval', 'SafetyClassification'].map((id) => ({ id, type: 'Activity' })),
  ...['EvalAgentIdentity', 'WorkerSA', 'CSIDriverRole', 'NodeRole', 'ConnectorIdentity', 'ClusterAdminA', 'ClusterAdminB', 'CIAutomationTag'].map((id) => ({ id, type: 'Role' })),
  ...['EvalAgent', 'WorkerPod', 'ConnectorSvc', 'CIRunner'].map((id) => ({ id, type: 'User' })),
];

const PRINCIPALS = [
  { type: 'Acts', source: 'EvalAgentIdentity', target: 'EvalAgent' },
  { type: 'Assumes', source: 'EvalAgent', target: 'EvalHarness' },
  { type: 'Acts', source: 'WorkerSA', target: 'WorkerPod' },
  { type: 'Acts', source: 'ConnectorIdentity', target: 'ConnectorSvc' },
  { type: 'Acts', source: 'CIAutomationTag', target: 'CIRunner' },
];

const APPENDIX_B_AS_BUILT: GalModel = {
  model_type: 'Enterprise_Model',
  entities: ENTITIES,
  relations: [
    ...PRINCIPALS,
    { type: 'ComposedOf', source: 'EvalHarness', target: 'PackageProxy' },
    { type: 'ComposedOf', source: 'PackageProxy', target: 'PublicInternet' },
    { type: 'Contains', source: 'PublicInternet', target: 'PublicNetworkEgress' },
    { type: 'Contains', source: 'EvalHarness', target: 'RunEval' },
    { type: 'Includes', source: 'WorkerSA', target: 'CSIDriverRole' },
    { type: 'Includes', source: 'CSIDriverRole', target: 'NodeRole' },
    { type: 'AssignedTo', source: 'NodeRole', target: 'ReadInstanceMetadata' },
    { type: 'AssignedTo', source: 'CSIDriverRole', target: 'CreatePrivilegedPod' },
    { type: 'Includes', source: 'ConnectorIdentity', target: 'ClusterAdminA' },
    { type: 'Includes', source: 'ConnectorIdentity', target: 'ClusterAdminB' },
    { type: 'Reaches', source: 'ClusterAdminA', target: 'K8sClusterA' },
    { type: 'Reaches', source: 'ClusterAdminB', target: 'K8sClusterB' },
    { type: 'Reaches', source: 'CIAutomationTag', target: 'MeshNetwork' },
    { type: 'ComposedOf', source: 'MeshNetwork', target: 'CISubnet' },
    { type: 'ComposedOf', source: 'MeshNetwork', target: 'SourceControl' },
  ],
  policies: [],
};

/** Remediated: PackageProxy→PublicInternet removed, SafetyClassification added, WorkerSA→CSIDriverRole dropped,
 *  ClusterAdminB dropped from the connector, CI tag narrowed to CISubnet. */
function remediated({ withSafetyStep = true } = {}): GalModel {
  return {
    model_type: 'Enterprise_Model',
    entities: ENTITIES,
    relations: [
      ...PRINCIPALS,
      { type: 'ComposedOf', source: 'EvalHarness', target: 'PackageProxy' },
      { type: 'Contains', source: 'PublicInternet', target: 'PublicNetworkEgress' },
      { type: 'Contains', source: 'EvalHarness', target: 'RunEval' },
      ...(withSafetyStep ? [{ type: 'Contains', source: 'EvalHarness', target: 'SafetyClassification' }] : []),
      { type: 'Includes', source: 'CSIDriverRole', target: 'NodeRole' },
      { type: 'AssignedTo', source: 'NodeRole', target: 'ReadInstanceMetadata' },
      { type: 'AssignedTo', source: 'CSIDriverRole', target: 'CreatePrivilegedPod' },
      { type: 'Includes', source: 'ConnectorIdentity', target: 'ClusterAdminA' },
      { type: 'Reaches', source: 'ClusterAdminA', target: 'K8sClusterA' },
      { type: 'Reaches', source: 'ClusterAdminB', target: 'K8sClusterB' },
      { type: 'Reaches', source: 'CIAutomationTag', target: 'CISubnet' },
      { type: 'ComposedOf', source: 'MeshNetwork', target: 'CISubnet' },
      { type: 'ComposedOf', source: 'MeshNetwork', target: 'SourceControl' },
    ],
    policies: [],
  };
}

// Thesis Ch.7 Ex.2: law forbids PrivDiv from AccessPI; enterprise grants FinAdmin; one user acts in both.
const CH7_LAW: GalModel = {
  entities: [{ id: 'AccessPI', type: 'Activity' }, { id: 'PrivDiv', type: 'Role' }],
  policies: [{ type: 'CanAssignTo', modality: 'Deny', source: 'AccessPI', target: 'PrivDiv' }],
};
const CH7_ENT: GalModel = {
  entities: [
    { id: 'FinDiv', type: 'Role' }, { id: 'FinAdmin', type: 'Role' }, { id: 'PrivDiv', type: 'Role' },
    { id: 'AccessPI', type: 'Activity' }, { id: 'Alice', type: 'User' },
  ],
  relations: [
    { type: 'Includes', source: 'FinDiv', target: 'FinAdmin' },
    { type: 'AssignedTo', source: 'FinAdmin', target: 'AccessPI' },
    { type: 'Acts', source: 'PrivDiv', target: 'Alice' },
    { type: 'Acts', source: 'FinAdmin', target: 'Alice' },
  ],
  policies: [],
};

// ---------------------------------------------------------------------------

const tmp = mkdtempSync(path.join(tmpdir(), 'gam-adapter-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeCase(name: string, content: unknown): string {
  const file = path.join(tmp, `${name}.json`);
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function obligation(artifactPath: string, extra: Partial<Obligation> = {}): Obligation {
  return {
    id: 'obl-gam',
    propertyId: 'GOV-B',
    specVersion: '1.0',
    specHash: 'sha256:spec',
    tool: 'gam',
    artifactPath,
    assumptions: ['Φ_L: Appendix B containment policy'],
    guarantee: 'Con(Φ_L ∪ Φ_E) ∧ ontology satisfied',
    ...extra,
  };
}

const adapter = new GamAdapter({ cliPath: undefined });
const verifyCase = (name: string, content: unknown) => adapter.verify(obligation(writeCase(name, content)), 'rev-1');

describe('ConsistencyChecker / OntologyChecker', () => {
  it('finds the Ch.7 Ex.2 cross-model ACTIVITY_CONFLICT only via closure', () => {
    const r = new ConsistencyChecker().check(CH7_LAW, CH7_ENT);
    expect(r.consistent).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ type: 'ACTIVITY_CONFLICT', user: 'Alice', activity: 'AccessPI', role: 'PrivDiv' });
    expect(r.violations[0].grantedVia).toEqual(['Acts FinAdmin→Alice', 'AssignedTo FinAdmin→AccessPI']);
  });

  it('reproduces Appendix B as-built findings B1, B1b, B3–B6 and the B2 ontology gap', () => {
    const con = new ConsistencyChecker().check(APPENDIX_B_LAW, APPENDIX_B_AS_BUILT);
    const summary = con.violations.map((v) => `${v.type}:${v.user}:${v.activity ?? `${v.process1}|${v.process2}`}`).sort();
    expect(summary).toEqual([
      'ACTIVITY_CONFLICT:EvalAgent:PublicNetworkEgress', // B1
      'ACTIVITY_CONFLICT:WorkerPod:CreatePrivilegedPod', // B4
      'ACTIVITY_CONFLICT:WorkerPod:ReadInstanceMetadata', // B3
      'SEPARATION_VIOLATION:CIRunner:CISubnet|SourceControl', // B6
      'SEPARATION_VIOLATION:ConnectorSvc:K8sClusterA|K8sClusterB', // B5
      'SEPARATION_VIOLATION:EvalAgent:EvalHarness|PublicInternet', // B1b
    ]);
    const b1 = con.violations.find((v) => v.activity === 'PublicNetworkEgress')!;
    expect(b1.grantedVia).toEqual([
      'Assumes EvalAgent→EvalHarness',
      'ComposedOf EvalHarness→PackageProxy',
      'ComposedOf PackageProxy→PublicInternet',
      'Contains PublicInternet→PublicNetworkEgress',
    ]);
    expect(b1.prohibitedVia).toEqual(['Acts EvalAgentIdentity→EvalAgent', 'CanAssignTo(Deny) PublicNetworkEgress→EvalAgentIdentity [law]']);

    const onto = new OntologyChecker().check(APPENDIX_B_LAW, APPENDIX_B_AS_BUILT);
    expect(onto.satisfied).toBe(false);
    expect(onto.violations).toEqual([expect.objectContaining({ type: 'ONTOLOGY_GAP', requirementId: 'B2' })]);
  });

  it('remediated Φ_E clears all seven checks', () => {
    expect(new ConsistencyChecker().check(APPENDIX_B_LAW, remediated()).consistent).toBe(true);
    expect(new OntologyChecker().check(APPENDIX_B_LAW, remediated()).satisfied).toBe(true);
  });

  it('checks scenario precedence over Next⁺', () => {
    const law: GalModel = {
      scenarioRequirements: [
        { id: 'S1', kind: 'precedence', from: 'Collect', to: 'Notify' },
        { id: 'S2', kind: 'forbidden-precedence', from: 'Disclose', to: 'Consent' },
      ],
    };
    const ent: GalModel = {
      relations: [
        { type: 'Next', source: 'Collect', target: 'Store' },
        { type: 'Next', source: 'Store', target: 'Notify' },
        { type: 'Next', source: 'Disclose', target: 'Consent' },
      ],
    };
    const r = new OntologyChecker().check(law, ent);
    expect(r.violations.map((v) => v.requirementId)).toEqual(['S2']);
    expect(r.violations[0].path).toEqual(['Next Disclose→Consent']);
  });
});

describe('GamAdapter verdicts', () => {
  it('COUNTEREXAMPLE when Con fails, with witness paths', async () => {
    const r = await verifyCase('ch7', { law: CH7_LAW, enterprise: CH7_ENT });
    expect(r.verdict).toBe(Verdict.COUNTEREXAMPLE);
    expect(r.tool).toBe('gam');
    expect((r.witness as any).consistencyViolations[0]).toMatchObject({ type: 'ACTIVITY_CONFLICT', user: 'Alice' });
    expect(r.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('Appendix B as-built → COUNTEREXAMPLE (6 Con violations + B2 ontology gap)', async () => {
    const r = await verifyCase('b-asbuilt', { law: APPENDIX_B_LAW, enterprise: APPENDIX_B_AS_BUILT });
    expect(r.verdict).toBe(Verdict.COUNTEREXAMPLE);
    const w = r.witness as any;
    expect(w.consistencyViolations).toHaveLength(6);
    expect(w.ontologyViolations.map((v: any) => v.requirementId)).toEqual(['B2']);
  });

  it('Con passing ≠ compliant: remediated-but-no-safety-step → COUNTEREXAMPLE from the ontology check alone', async () => {
    const r = await verifyCase('b-no-safety', { law: APPENDIX_B_LAW, enterprise: remediated({ withSafetyStep: false }) });
    expect(r.metadata?.consistent).toBe(true);
    expect(r.metadata?.satisfied).toBe(false);
    expect(r.verdict).toBe(Verdict.COUNTEREXAMPLE);
    expect((r.witness as any).consistencyViolations).toEqual([]);
    expect((r.witness as any).ontologyViolations[0]).toMatchObject({ type: 'ONTOLOGY_GAP', requirementId: 'B2' });
  });

  it('Appendix B remediated → BOUNDED_PASS with a passing vacuity probe', async () => {
    const r = await verifyCase('b-remediated', { law: APPENDIX_B_LAW, enterprise: remediated() });
    expect(r.verdict).toBe(Verdict.BOUNDED_PASS);
    expect(r.vacuityProbe?.passed).toBe(true);
    expect(r.witness).toBeUndefined();
    expect(r.metadata?.alloyTwin).toContain('pred Con');
  });

  it('INCONSISTENT_ASSUMPTIONS when Φ_L is empty', async () => {
    const r = await verifyCase('empty-law', { law: { entities: [] }, enterprise: CH7_ENT });
    expect(r.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(r.vacuityProbe?.passed).toBe(false);
  });

  it('INCONSISTENT_ASSUMPTIONS when Φ_L both permits and prohibits via closure', async () => {
    const law: GalModel = {
      relations: [{ type: 'Includes', source: 'Senior', target: 'Junior' }],
      policies: [
        { type: 'CanAssignTo', modality: 'Allow', source: 'Act', target: 'Junior' },
        { type: 'CanAssignTo', modality: 'Deny', source: 'Act', target: 'Senior' },
      ],
    };
    const r = await verifyCase('contradictory-law', { law, enterprise: CH7_ENT });
    expect(r.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(r.metadata?.reason).toMatch(/permits and prohibits/);
  });

  it('INCONSISTENT_ASSUMPTIONS when no user is analysed (Con would hold vacuously)', async () => {
    const ent: GalModel = { relations: [{ type: 'Assumes', source: 'Ghost', target: 'EvalHarness' }] };
    const r = await verifyCase('no-users', { law: CH7_LAW, enterprise: ent });
    expect(r.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(r.vacuityProbe?.reason).toMatch(/vacuously/);
  });

  it('ERROR on malformed JSON, missing Φ_E, or a policy without polarity', async () => {
    expect((await verifyCase('bad-json', '{ not json')).verdict).toBe(Verdict.ERROR);
    expect((await verifyCase('no-ent', { law: CH7_LAW })).verdict).toBe(Verdict.ERROR);
    const noPolarity = { law: { policies: [{ type: 'CanAssignTo', source: 'A', target: 'R' }] }, enterprise: CH7_ENT };
    expect((await verifyCase('no-polarity', noPolarity)).verdict).toBe(Verdict.ERROR);
    expect(() => parseGalJson('[]')).toThrow(/must be an object/);
  });

  it('NOT_RUN when the artifact is missing or the required CLI is absent', async () => {
    expect((await adapter.verify(obligation(path.join(tmp, 'missing.json')), 'rev-1')).verdict).toBe(Verdict.NOT_RUN);
    expect((await adapter.verify(obligation(''), 'rev-1')).verdict).toBe(Verdict.NOT_RUN);

    const file = writeCase('b-cli', { law: APPENDIX_B_LAW, enterprise: remediated() });
    const strict = new GamAdapter({ cliPath: undefined, requireCli: true });
    expect((await strict.checkAvailability()).available).toBe(false);
    expect((await strict.verify(obligation(file), 'rev-1')).verdict).toBe(Verdict.NOT_RUN);

    const enoent: CommandRunner = async () => ({ exitCode: null, stdout: '', stderr: '', spawnError: 'ENOENT' });
    const missingCli = new GamAdapter({ cliPath: '/nope/gam', requireCli: true, runCommand: enoent });
    expect((await missingCli.verify(obligation(file), 'rev-1')).verdict).toBe(Verdict.NOT_RUN);
    // Not required → falls back to the built-in engine.
    const fallback = new GamAdapter({ cliPath: '/nope/gam', runCommand: enoent });
    const r = await fallback.verify(obligation(file), 'rev-1');
    expect(r.verdict).toBe(Verdict.BOUNDED_PASS);
    expect(r.metadata?.engine).toBe('builtin');
  });
});

describe('GamAdapter external CLI', () => {
  const file = writeCase('cli-case', { law: APPENDIX_B_LAW, enterprise: remediated() });
  const cli = (stdout: string): CommandRunner => async (_cmd, args) =>
    args[0] === '--version' ? { exitCode: 0, stdout: 'gam 2.0.0\n', stderr: '' } : { exitCode: 0, stdout, stderr: '' };

  it('reports CLI version and maps consistent && satisfied → BOUNDED_PASS', async () => {
    const a = new GamAdapter({ cliPath: '/opt/gam', runCommand: cli(JSON.stringify({ consistency: { consistent: true, violations: [] }, ontology: { satisfied: true, violations: [] } })) });
    expect(await a.checkAvailability()).toEqual({ available: true, version: 'gam 2.0.0', path: '/opt/gam' });
    const r = await a.verify(obligation(file), 'rev-1');
    expect(r.verdict).toBe(Verdict.BOUNDED_PASS);
    expect(r.metadata?.engine).toBe('cli');
  });

  it('CLI violation → COUNTEREXAMPLE; Con-only output → UNKNOWN; non-JSON → ERROR', async () => {
    const viol = JSON.stringify({ consistent: true, satisfied: false, ontologyViolations: [{ type: 'ONTOLOGY_GAP', requirementId: 'B2' }] });
    const r1 = await new GamAdapter({ cliPath: '/opt/gam', runCommand: cli(viol) }).verify(obligation(file), 'rev-1');
    expect(r1.verdict).toBe(Verdict.COUNTEREXAMPLE);
    expect((r1.witness as any).ontologyViolations[0].requirementId).toBe('B2');

    const conOnly = await new GamAdapter({ cliPath: '/opt/gam', runCommand: cli('{"consistent":true}') }).verify(obligation(file), 'rev-1');
    expect(conOnly.verdict).toBe(Verdict.UNKNOWN);

    const garbage = await new GamAdapter({ cliPath: '/opt/gam', runCommand: cli('Segmentation fault') }).verify(obligation(file), 'rev-1');
    expect(garbage.verdict).toBe(Verdict.ERROR);
  });
});

describe('emitAlloyTwin', () => {
  it('emits a self-contained .als twin with sorts, facts, Con and requirement checks', () => {
    const als = emitAlloyTwin({ law: APPENDIX_B_LAW, enterprise: APPENDIX_B_AS_BUILT, moduleName: 'appendixB_asbuilt' });
    expect(als.startsWith('module appendixB_asbuilt\n')).toBe(true);
    expect(als).toContain('abstract sig Process {}');
    expect(als).toMatch(/one sig .*P_EvalHarness.* extends Process \{\}/);
    expect(als).toMatch(/one sig .*U_EvalAgent.* extends User \{\}/);
    expect(als).toContain('P_EvalHarness->P_PackageProxy');
    expect(als).toContain('P_PackageProxy->P_PublicInternet');
    // CanAssignTo (Activity→Role) is flipped into RA⁻ (Role→Activity).
    expect(als).toContain('R_EvalAgentIdentity->A_PublicNetworkEgress');
    // Acts (Role→User) is flipped into RU⁺ (User→Role).
    expect(als).toContain('U_EvalAgent->R_EvalAgentIdentity');
    expect(als).toContain('Phi.RUm = none->none');
    expect(als).toContain('pred Con {');
    expect(als).toMatch(/check Consistent for \d+/);
    expect(als).toContain('assert Ontology_B2 { A_SafetyClassification in P_EvalHarness.*(Phi.PP).(Phi.PA) }');
  });

  it('remediated twin drops the PackageProxy→PublicInternet edge and is deterministic', () => {
    const input = { law: APPENDIX_B_LAW, enterprise: remediated() };
    const als = emitAlloyTwin(input, { moduleName: 'appendixB_remediated', scope: 30 });
    expect(als).not.toContain('P_PackageProxy->P_PublicInternet');
    expect(als).toContain('check Consistent for 30');
    expect(emitAlloyTwin(JSON.stringify(input), { moduleName: 'appendixB_remediated', scope: 30 })).toBe(als);
  });
});
