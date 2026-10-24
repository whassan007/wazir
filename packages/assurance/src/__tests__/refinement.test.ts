import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RefinementMappingEntry, VerificationResult, Verdict } from '../contracts';
import { evaluateRefinementLink, parseRefinementMap, RefinementEvaluationOptions } from '../refinement';

const workspaceDir = mkdtempSync(join(tmpdir(), 'refinement-'));
writeFileSync(join(workspaceDir, 'production.ts'), 'export const stop = true;');
afterAll(() => rmSync(workspaceDir, { recursive: true, force: true }));
const entry: RefinementMappingEntry = {
  property: 'RED_SIGNAL_COMPLIANCE', verified_artifact: 'stop.dfy',
  production: 'compiled_from_dafny', production_path: 'production.ts',
};
const model: VerificationResult = {
  verdict: Verdict.PROVED, tool: 'dafny', toolVersion: '4.9.1', assumptions: [],
  elapsedMs: 1, inputHash: 'hash', trustedBaseGaps: [], metadata: { workspaceRev: 'abc' },
};
const options: RefinementEvaluationOptions = {
  workspaceDir, sourceCommit: 'abc', workspaceRev: 'abc', compilerVersion: '4.9.1', pinnedCompilerVersion: '4.9.1',
};

describe('parseRefinementMap', () => {
  it('parses the documented YAML schema with comments and quoted scalars', () => {
    expect(parseRefinementMap(`---
component: 'intersection_behavior_planner'
mappings:
  - property: RED_SIGNAL_COMPLIANCE # comment
    verified_artifact: "stop.dfy"
    production: compiled_from_dafny
    production_path: production.ts
`)).toEqual({ component: 'intersection_behavior_planner', mappings: [entry] });
  });
  it('parses JSON, including empty maps', () => {
    expect(parseRefinementMap(JSON.stringify({ component: 'planner', mappings: [entry] })).mappings).toEqual([entry]);
    expect(parseRefinementMap('{"component":"planner","mappings":[]}').mappings).toEqual([]);
  });
  it.each([
    '{}', '{"component":"x","mappings":[{}]}',
    '{"component":"x","mappings":[{"property":"P","verified_artifact":"s","production":"hand_translation"}]}',
    'component: x\ncomponent: y\nmappings:',
    'component: x\nmappings:\n  - property: P\n    production: none',
    'component: x\nmappings:\n  - property: &anchor P',
  ])('rejects malformed or unsupported input: %s', source => {
    expect(() => parseRefinementMap(source)).toThrow();
  });
});

describe('evaluateRefinementLink', () => {
  it('retains proof for pinned Dafny compilation at the same revision', () => {
    expect(evaluateRefinementLink(entry, model, options)).toMatchObject({
      modelVerdict: Verdict.PROVED, implementationVerdict: Verdict.PROVED, capped: false,
    });
  });
  it('accepts a proved refinement link bound to the revision', () => {
    expect(evaluateRefinementLink({ ...entry, production: 'refinement_proof' }, model,
      { ...options, compilerVersion: undefined, refinementProof: model }).implementationVerdict).toBe(Verdict.PROVED);
  });
  it.each(['contract_tests', 'none', 'hand_translation'] as const)('caps %s and records tests', production => {
    const result = evaluateRefinementLink({ ...entry, production } as RefinementMappingEntry, model,
      { ...options, contractTestsRecorded: true });
    expect(result).toMatchObject({ modelVerdict: Verdict.PROVED, implementationVerdict: Verdict.NOT_VERIFIED,
      capped: true, contractTestsRecorded: true });
    expect(result.reason).toBeTruthy();
  });
  it('automatically records contract tests even for model failures', () => {
    expect(evaluateRefinementLink({ ...entry, production: 'contract_tests' },
      { ...model, verdict: Verdict.ERROR })).toMatchObject({ implementationVerdict: Verdict.ERROR, contractTestsRecorded: true });
  });
  it.each([
    { sourceCommit: undefined }, { workspaceRev: 'other' }, { compilerVersion: undefined },
    { pinnedCompilerVersion: undefined }, { compilerVersion: 'different' },
  ])('caps incomplete or mismatched provenance: %j', override => {
    expect(evaluateRefinementLink(entry, model, { ...options, ...override }).implementationVerdict).toBe(Verdict.NOT_VERIFIED);
  });
  it.each([undefined, 'missing.ts', '.'])('caps missing or non-file production paths: %s', production_path => {
    expect(evaluateRefinementLink({ ...entry, production_path }, model, options).capped).toBe(true);
  });
  it.each([undefined, ['assume false']])('requires explicitly empty trusted-base gaps: %j', trustedBaseGaps => {
    expect(evaluateRefinementLink(entry, { ...model, trustedBaseGaps }, options).capped).toBe(true);
  });
  it('rejects stale model evidence and non-Dafny compilation evidence', () => {
    expect(evaluateRefinementLink(entry, { ...model, metadata: { workspaceRev: 'stale' } }, options).capped).toBe(true);
    expect(evaluateRefinementLink(entry, { ...model, tool: 'z3' }, options).capped).toBe(true);
  });
  it.each([undefined, { ...model, verdict: Verdict.UNKNOWN }, { ...model, trustedBaseGaps: ['axiom'] },
    { ...model, metadata: { workspaceRev: 'stale' } }])('rejects absent or invalid refinement proofs', refinementProof => {
    expect(evaluateRefinementLink({ ...entry, production: 'refinement_proof' }, model,
      { ...options, refinementProof }).capped).toBe(true);
  });
  it.each([Verdict.COUNTEREXAMPLE, Verdict.FALSIFIED, Verdict.INCONSISTENT_ASSUMPTIONS,
    Verdict.ERROR, Verdict.UNKNOWN, Verdict.NOT_RUN])('preserves failure %s even without a production link', verdict => {
    expect(evaluateRefinementLink({ ...entry, production: 'none' }, { ...model, verdict })).toMatchObject({
      modelVerdict: verdict, implementationVerdict: verdict, capped: false,
    });
  });
  it.each([Verdict.BOUNDED_PASS, Verdict.NOT_FALSIFIED, Verdict.SPECIFICATION_REVIEW_REQUIRED, Verdict.NOT_VERIFIED])(
    'never upgrades %s to proof', verdict => {
      expect(evaluateRefinementLink(entry, { ...model, verdict }, options).implementationVerdict).toBe(Verdict.NOT_VERIFIED);
    });
});
