import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Verdict, SpecManifest } from '../contracts';
import { SpecRegistry, computeSpecHash, verifySpecHash, parseSpecManifest, validateSpecManifest, canGateRelease, checkReleaseEligibility } from '../registry';

const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), 'spec-registry-')); dirs.push(dir); return dir; }
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function draft(): SpecManifest {
  const m: SpecManifest = { id: 'STOP', version: '2.1', status: 'draft', source: { normative_ref: 'Traffic code', jurisdiction: 'configured', interpretation_date: '2026-10-23' }, assumptions: ['signal_available'], guarantee: 'Stop at red', artifacts: [{ tool: 'z3', file: 'stop.py' }], reviewers: [], content_hash: '' };
  m.content_hash = computeSpecHash(m); return m;
}
function registry() { return new SpecRegistry(directory()); }

describe('canonical content hashing', () => {
  it('uses SHA-256 and ignores the content_hash field', () => {
    const m = draft(); expect(m.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(computeSpecHash({ ...m, content_hash: 'ignored' })).toBe(m.content_hash);
  });
  it('is stable across nested object key ordering', () => {
    const m = draft();
    expect(computeSpecHash({ ...m, source: { interpretation_date: m.source.interpretation_date, jurisdiction: m.source.jurisdiction, normative_ref: m.source.normative_ref } })).toBe(m.content_hash);
    expect(computeSpecHash(Object.fromEntries(Object.entries(m).reverse()) as SpecManifest)).toBe(m.content_hash);
  });
  it.each(['guarantee', 'version', 'status', 'reviewers', 'artifacts', 'assumptions', 'source'])('binds %s to the hash', field => {
    const m = draft(); (m as any)[field] = 'changed'; expect(verifySpecHash(m)).toBe(false);
  });
  it('preserves array ordering', () => { const m = draft(); m.assumptions = ['a', 'b']; expect(computeSpecHash(m)).not.toBe(computeSpecHash({ ...m, assumptions: ['b', 'a'] })); });
});

describe('parsing and validation', () => {
  it('round trips JSON', () => expect(parseSpecManifest(JSON.stringify(draft()))).toEqual(draft()));
  it('parses nested YAML, flow collections and block lists', () => {
    const m = draft();
    const yaml = `# manifest\nid: STOP\nversion: 2.1\nstatus: draft\nsource:\n  normative_ref: Traffic code\n  jurisdiction: configured\n  interpretation_date: 2026-10-23\nassumptions: [signal_available]\nguarantee: "Stop at red"\nartifacts:\n  - tool: z3\n    file: stop.py\nreviewers: []\ncontent_hash: ${m.content_hash}\n`;
    expect(parseSpecManifest(yaml)).toEqual(m);
    expect(parseSpecManifest(yaml.replace('  - tool: z3\n    file: stop.py', '  - { tool: z3, file: stop.py }'))).toEqual(m);
  });
  it('rejects hash tampering when loading', () => expect(() => parseSpecManifest(JSON.stringify({ ...draft(), guarantee: 'Go' }))).toThrow('SPECIFICATION_REVIEW_REQUIRED'));
  it.each([
    { id: '' }, { version: 2.1 }, { status: 'published' }, { source: {} }, { assumptions: 'a' }, { guarantee: '' },
    { artifacts: [{ tool: 'unknown', file: 'x' }] }, { artifacts: [{ tool: 'z3', file: '' }] },
    { artifacts: [{ tool: 'z3', file: 'x', commands: 1 }] }, { reviewers: [1] }, { monitors: [{}] }, { content_hash: 'bad' },
  ])('rejects malformed fields %j', changes => expect(() => validateSpecManifest({ ...draft(), ...changes })).toThrow());
  it('rejects approved manifests without reviewers even with a matching hash', () => {
    const m = { ...draft(), status: 'approved' as const }; m.content_hash = computeSpecHash(m);
    expect(() => parseSpecManifest(JSON.stringify(m))).toThrow('SPECIFICATION_REVIEW_REQUIRED');
  });
  it('rejects unsupported YAML and duplicate mapping keys', () => {
    expect(() => parseSpecManifest('id: STOP\nid: OTHER')).toThrow('Duplicate');
    expect(() => parseSpecManifest('guarantee: |\n  text')).toThrow('Unsupported');
    expect(() => parseSpecManifest('id: [bad')).toThrow();
  });
});

describe('versioned directory and isolation', () => {
  it('loads nested JSON and YAML manifests and ignores unrelated files', () => {
    const dir = directory(); mkdirSync(join(dir, 'v2'));
    writeFileSync(join(dir, 'v2', 'stop.json'), JSON.stringify(draft()));
    const second = { ...draft(), id: 'OTHER' }; second.content_hash = computeSpecHash(second);
    // JSON is also valid YAML.
    writeFileSync(join(dir, 'other.yaml'), JSON.stringify(second)); writeFileSync(join(dir, 'note.txt'), 'not a manifest');
    const r = new SpecRegistry(dir); expect(r.listSpecs()).toHaveLength(2); expect(r.getSpec('STOP', '2.1')).toEqual(draft());
  });
  it('supports a missing directory', () => expect(new SpecRegistry(join(directory(), 'missing')).listSpecs()).toEqual([]));
  it('rejects corrupt and duplicate loaded revisions', () => {
    const dir = directory(); writeFileSync(join(dir, 'a.json'), JSON.stringify(draft())); writeFileSync(join(dir, 'b.json'), JSON.stringify(draft()));
    expect(() => new SpecRegistry(dir)).toThrow('Duplicate');
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ ...draft(), guarantee: 'tampered' })); expect(() => new SpecRegistry(dir)).toThrow('hash mismatch');
  });
  it('stores multiple versions without overwriting existing revisions', () => {
    const r = registry(); r.addSpec(draft()); const m = { ...draft(), version: '3' }; m.content_hash = computeSpecHash(m); r.addSpec(m);
    expect(r.getSpec('STOP', '2.1')?.version).toBe('2.1'); expect(r.getSpec('STOP')?.version).toBe('3');
    expect(() => r.addSpec(draft())).toThrow('Duplicate'); expect(r.getSpec('missing')).toBeUndefined();
  });
  it('does not expose stored mutable references', () => {
    const r = registry(); const input = draft(); const output = r.addSpec(input); input.source.jurisdiction = 'changed'; output.assumptions.push('changed');
    r.getSpec('STOP')!.source.jurisdiction = 'changed'; r.listSpecs()[0].reviewers.push('fake'); expect(r.getSpec('STOP')).toEqual(draft());
  });
});

describe('promotion and release eligibility', () => {
  it('computes missing hashes for new drafts', () => { const r = registry(); const { content_hash, ...m } = draft(); expect(r.addSpec(m).content_hash).toBe(content_hash); });
  it('rejects agent-created reviewed, approved or retired specs', () => {
    for (const status of ['reviewed', 'approved', 'retired'] as const) expect(() => registry().addSpec({ ...draft(), status })).toThrow('SPECIFICATION_REVIEW_REQUIRED');
    expect(() => registry().addSpec({ ...draft(), reviewers: ['fake'] })).toThrow('SPECIFICATION_REVIEW_REQUIRED');
  });
  it('rejects supplied invalid draft hashes', () => expect(() => registry().addSpec({ ...draft(), guarantee: 'changed' })).toThrow('hash mismatch'));
  it('requires explicit approval and rehashes each lifecycle transition', () => {
    const r = registry(); r.addSpec(draft());
    expect(() => r.promoteSpec('STOP', 'approved')).toThrow('SPECIFICATION_REVIEW_REQUIRED');
    expect(() => r.approveSpec('STOP', 'alice', 'token')).toThrow('Only reviewed');
    const reviewed = r.promoteSpec('STOP', 'reviewed'); expect(r.verifySpecHash(reviewed)).toBe(true); expect(reviewed.content_hash).not.toBe(draft().content_hash);
    const approved = r.approveSpec('STOP', 'alice', { actor: 'alice', human: true, token: 'gate-token' });
    expect(approved.reviewers).toEqual(['alice']); expect(canGateRelease(approved)).toBe(true); expect(r.checkReleaseEligibility('STOP')).toEqual({ eligible: true });
    const retired = r.promoteSpec('STOP', 'retired'); expect(verifySpecHash(retired)).toBe(true); expect(canGateRelease(retired)).toBe(false);
    expect(() => r.promoteSpec('STOP', 'reviewed')).toThrow('Invalid');
  });
  it.each([undefined, '', '   ', { actor: 'bot', human: false, token: 'x' }, { actor: 'bob', human: true, token: 'x' }, { actor: 'alice', human: true, token: '' }])('rejects absent or invalid approval proof %j', proof => {
    const r = registry(); r.addSpec(draft()); r.promoteSpec('STOP', 'reviewed');
    expect(() => r.approveSpec('STOP', 'alice', proof as any)).toThrow('SPECIFICATION_REVIEW_REQUIRED'); expect(r.getSpec('STOP')?.status).toBe('reviewed');
  });
  it('accepts an explicit gate token and rejects blank reviewers', () => {
    const r = registry(); r.addSpec(draft()); r.promoteSpec('STOP', 'reviewed');
    expect(() => r.approveSpec('STOP', ' ', 'token')).toThrow('SPECIFICATION_REVIEW_REQUIRED'); expect(r.approveSpec('STOP', 'alice', 'token').status).toBe('approved');
  });
  it.each(['draft', 'reviewed', 'retired'] as const)('fails closed for %s', status => {
    const m = { ...draft(), status }; m.content_hash = computeSpecHash(m);
    expect(canGateRelease(m)).toBe(false); expect(checkReleaseEligibility(m).verdict).toBe(Verdict.SPECIFICATION_REVIEW_REQUIRED);
  });
  it('fails closed for tampered approved content and unknown specs', () => {
    const m = { ...draft(), status: 'approved' as const, reviewers: ['alice'] }; m.content_hash = computeSpecHash(m);
    expect(canGateRelease(m)).toBe(true); m.guarantee = 'changed'; expect(canGateRelease(m)).toBe(false);
    expect(checkReleaseEligibility(m).verdict).toBe(Verdict.SPECIFICATION_REVIEW_REQUIRED); expect(registry().checkReleaseEligibility('missing').eligible).toBe(false);
  });
  it('rejects unknown specs and backward transitions', () => {
    const r = registry(); expect(() => r.promoteSpec('missing', 'reviewed')).toThrow('Unknown'); expect(() => r.approveSpec('missing', 'alice', 'token')).toThrow('Unknown');
    r.addSpec(draft()); r.promoteSpec('STOP', 'reviewed'); expect(() => r.promoteSpec('STOP', 'draft')).toThrow('Invalid');
  });
});
