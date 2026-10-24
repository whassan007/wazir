import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Verdict } from '../contracts';
import { canonicalSerialize, EvidenceLedger, GENESIS_HASH, LedgerIntegrityError, StaleLeaseFenceError, verifyLedger } from '../ledger';
import type { LedgerInput } from '../ledger';

const input = (changes: Partial<LedgerInput> = {}): LedgerInput => ({
  propertyId: 'STOP', specVersion: '1.0', specHash: 'spec-hash', sourceCommit: 'commit-a',
  workspaceRev: 'rev-a', tool: 'z3', toolVersion: '4.13', inputHash: 'input-hash',
  scope: 'unbounded', assumptions: ['speed >= 0'], verdict: Verdict.PROVED,
  witness: { trace: [1, 2] }, elapsedMs: 12, seed: 42, artifactHashes: { model: 'artifact-hash' },
  fencingToken: 1, ...changes,
});
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const filePath = () => {
  const directory = mkdtempSync(join(tmpdir(), 'assurance-ledger-'));
  directories.push(directory);
  return join(directory, 'evidence.json');
};

describe('EvidenceLedger', () => {
  it('appends a valid chain and returns detached entries', () => {
    const ledger = new EvidenceLedger();
    const original = input();
    const first = ledger.append(original);
    original.assumptions.push('mutated');
    first.artifactHashes.model = 'mutated';
    const second = ledger.append(input({ propertyId: 'SECOND' }));
    expect(first.index).toBe(0);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.entryHash);
    expect(second.index).toBe(1);
    expect(ledger.entries[0].assumptions).toEqual(['speed >= 0']);
    expect(ledger.entries[0].artifactHashes.model).toBe('artifact-hash');
    expect(ledger.verifyLedger()).toBe(true);
    expect(verifyLedger([])).toBe(true);
  });
  it.each(['verdict', 'witness', 'specHash', 'prevHash'] as const)('detects tampered %s', field => {
    const ledger = new EvidenceLedger();
    ledger.append(input());
    const entries = ledger.entries;
    Object.assign(entries[0], { [field]: field === 'witness' ? { trace: [99] } : 'tampered' });
    expect(() => verifyLedger(entries)).toThrow(LedgerIntegrityError);
  });
  it('detects reordering, interior deletion, invalid hash and checkpoint truncation', () => {
    const ledger = new EvidenceLedger();
    for (let index = 0; index < 3; index++) ledger.append(input({ propertyId: String(index) }));
    const entries = ledger.entries;
    expect(() => verifyLedger([entries[1], entries[0], entries[2]])).toThrow(LedgerIntegrityError);
    expect(() => verifyLedger([entries[0], entries[2]])).toThrow(LedgerIntegrityError);
    expect(() => verifyLedger([{ ...entries[0], entryHash: GENESIS_HASH }])).toThrow(LedgerIntegrityError);
    expect(() => verifyLedger(entries.slice(0, -1), ledger.checkpoint)).toThrow(LedgerIntegrityError);
    expect(() => verifyLedger([], ledger.checkpoint)).toThrow(LedgerIntegrityError);
  });
  it('rejects stale tokens and superseded revisions even before replacement evidence exists', () => {
    const ledger = new EvidenceLedger();
    ledger.append(input());
    ledger.setLeaseFence(2, 'rev-b');
    for (const changes of [{ fencingToken: 1 }, { fencingToken: 2 }, { fencingToken: -1 }, { fencingToken: NaN }, { leaseToken: 3 }]) {
      expect(() => ledger.append(input(changes))).toThrow(StaleLeaseFenceError);
    }
    ledger.append(input({ fencingToken: 2, workspaceRev: 'rev-b' }));
    expect(() => ledger.setLeaseFence(1, 'rev-a')).toThrow(StaleLeaseFenceError);
    expect(() => ledger.setLeaseFence(2, 'rev-a')).toThrow(StaleLeaseFenceError);
    expect(ledger.entries).toHaveLength(2);
  });
  it('consults an authoritative validator and fails closed', () => {
    let currentRevision = 'rev-a';
    const ledger = new EvidenceLedger({ leaseFenceValidator: entry => entry.workspaceRev === currentRevision });
    ledger.append(input());
    currentRevision = 'rev-b';
    expect(() => ledger.append(input({ fencingToken: 99 }))).toThrow(StaleLeaseFenceError);
    ledger.append(input({ workspaceRev: 'rev-b', fencingToken: 2 }));
    expect(ledger.entries).toHaveLength(2);
  });
  it('filters by commit and invalidates old evidence without deleting history', () => {
    const ledger = new EvidenceLedger();
    ledger.append(input());
    ledger.append(input({ sourceCommit: 'commit-b' }));
    expect(ledger.getEvidenceForCommit('commit-a')).toHaveLength(1);
    expect(ledger.getEvidenceForCommit('commit-b')).toHaveLength(1);
    ledger.invalidatePriorEvidence('commit-c');
    expect(ledger.getEvidenceForCommit('commit-a')).toEqual([]);
    expect(ledger.getEvidenceForCommit('commit-c')).toEqual([]);
    expect(() => ledger.append(input())).toThrow(StaleLeaseFenceError);
    ledger.append(input({ sourceCommit: 'commit-c' }));
    expect(ledger.getEvidenceForCommit('commit-c')).toHaveLength(1);
    expect(ledger.entries).toHaveLength(3);
    expect(ledger.verifyLedger()).toBe(true);
  });
  it('persists the chain and fences across independent file-backed instances', () => {
    const path = filePath();
    const first = new EvidenceLedger({ filePath: path });
    const second = new EvidenceLedger({ filePath: path });
    first.append(input());
    second.setLeaseFence(2, 'rev-b');
    expect(() => first.append(input())).toThrow(StaleLeaseFenceError);
    second.invalidatePriorEvidence('commit-b');
    first.append(input({ fencingToken: 2, workspaceRev: 'rev-b', sourceCommit: 'commit-b' }));
    const reopened = new EvidenceLedger({ filePath: path });
    expect(reopened.entries).toHaveLength(2);
    expect(reopened.getEvidenceForCommit('commit-a')).toEqual([]);
    expect(reopened.verifyLedger()).toBe(true);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    stored.entries[0].verdict = Verdict.ERROR;
    writeFileSync(path, JSON.stringify(stored));
    expect(() => reopened.append(input())).toThrow(LedgerIntegrityError);
    expect(() => new EvidenceLedger({ filePath: path })).toThrow(LedgerIntegrityError);
  });
  it('rejects a competing writer lock without changing evidence', () => {
    const path = filePath();
    const ledger = new EvidenceLedger({ filePath: path });
    ledger.append(input());
    writeFileSync(path + '.lock', 'held');
    expect(() => ledger.append(input())).toThrow();
    expect(ledger.entries).toHaveLength(1);
  });
  it('canonicalizes nested keys and rejects non-JSON evidence', () => {
    expect(canonicalSerialize({ b: { d: 1, c: 2 }, a: 3 })).toBe(canonicalSerialize({ a: 3, b: { c: 2, d: 1 } }));
    const ledger = new EvidenceLedger();
    expect(() => ledger.append(input({ witness: { number: Infinity } }))).toThrow(TypeError);
    expect(() => ledger.append(input({ witness: new Date() }))).toThrow(TypeError);
    expect(ledger.entries).toEqual([]);
  });
});
