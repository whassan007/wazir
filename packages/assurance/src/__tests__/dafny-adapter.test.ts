import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DafnyAdapter, resolveDafnyBinary, scanDafnyTrustedBase } from '../adapters/dafny';
import { Obligation, Verdict } from '../contracts';

const adapter = new DafnyAdapter();
let directory: string;
const obligation = (artifactPath: string): Obligation => ({ id: 'dafny-test', propertyId: 'stop', specVersion: '1', specHash: 'test', tool: 'dafny', artifactPath, assumptions: [], guarantee: 'assertions hold', timeoutMs: 30000 });
async function verifySource(source: string) {
  const path = join(directory, `fixture-${Math.random().toString(16).slice(2)}.dfy`);
  await writeFile(path, source);
  return adapter.verify(obligation(path), 'test-revision');
}
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'dafny-adapter-')); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe('Dafny binary resolution', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('prefers DAFNY_PATH over the tools directory', () => {
    vi.stubEnv('DAFNY_PATH', '/custom/bin/dafny');
    vi.stubEnv('WAZIR_TOOLS_DIR', '/custom/tools');
    expect(resolveDafnyBinary()).toBe('/custom/bin/dafny');
  });
  it('uses WAZIR_TOOLS_DIR when configured', () => {
    vi.stubEnv('DAFNY_PATH', '');
    vi.stubEnv('WAZIR_TOOLS_DIR', join(directory, 'custom-tools'));
    expect(resolveDafnyBinary()).toBe(join(directory, 'custom-tools', 'dafny', 'dafny'));
  });
  it('walks ancestors of either starting directory to find the repository tools', async () => {
    vi.stubEnv('DAFNY_PATH', '');
    vi.stubEnv('WAZIR_TOOLS_DIR', '');
    const root = join(directory, 'repo');
    const binary = join(root, 'tools', 'dafny', 'dafny');
    await mkdir(join(root, 'tools', 'dafny'), { recursive: true });
    await writeFile(binary, '');
    expect(resolveDafnyBinary([join(root, 'packages', 'assurance', 'src')])).toBe(binary);
    expect(resolveDafnyBinary([directory, join(root, 'nested')])).toBe(binary);
  });
  it('falls back to dafny on PATH without a repository installation', () => {
    vi.stubEnv('DAFNY_PATH', '');
    vi.stubEnv('WAZIR_TOOLS_DIR', '');
    expect(resolveDafnyBinary([directory])).toBe('dafny');
  });
});

describe('DafnyAdapter with real pinned Dafny', () => {
  it('proves stop_command with no trusted base', async () => {
    const result = await adapter.verify(obligation(resolve('skills/formal/dafny/examples/stop_command.dfy')), 'test-revision');
    expect(result.verdict, JSON.stringify(result)).toBe(Verdict.PROVED);
    expect(result.vacuityProbe?.passed).toBe(true);
    expect(result.trustedBaseGaps).toEqual([]);
    expect(result.toolVersion).toContain('4.11');
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
  }, 60000);
  it('records a failing assertion and its location', async () => {
    const result = await verifySource('method Fail() { assert false; }');
    expect(result.verdict).toBe(Verdict.COUNTEREXAMPLE);
    expect(JSON.stringify(result.witness)).toContain('assertion');
    expect(JSON.stringify(result.witness)).toContain('.dfy(');
  }, 60000);
  it.each([
    'method Trusted() { assume true; assert true; }',
    'lemma {:axiom} Trusted() ensures true',
    'method {:verify false} Trusted() { assert false; }',
  ])('blocks trusted source: %s', async source => {
    const result = await verifySource(source);
    expect(result.verdict, JSON.stringify(result)).toBe(Verdict.SPECIFICATION_REVIEW_REQUIRED);
    expect(result.trustedBaseGaps?.length).toBeGreaterThan(0);
  }, 60000);
  it.each([
    'method Vacuous() requires false { assert false; }',
    'method Vacuous(x: int) requires x > 0 requires x < 0 { assert x == 12; }',
  ])('detects vacuity: %s', async source => {
    const result = await verifySource(source);
    expect(result.verdict, JSON.stringify(result)).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(result.vacuityProbe?.passed).toBe(false);
  }, 60000);
  it('maps resolution errors to ERROR', async () => {
    expect((await verifySource('method Broken() { assert missingName; }')).verdict).toBe(Verdict.ERROR);
  }, 60000);
  it('maps missing tools to NOT_RUN', async () => {
    expect((await new DafnyAdapter('/nonexistent/dafny').verify(obligation('missing.dfy'), 'rev')).verdict).toBe(Verdict.NOT_RUN);
  });
  it('maps process timeout to UNKNOWN', async () => {
    const result = await adapter.verify(obligation(resolve('skills/formal/dafny/examples/stop_command.dfy')), 'rev', { timeoutMs: 1 });
    expect(result.verdict).toBe(Verdict.UNKNOWN);
  }, 60000);
});

describe('trusted-base scanner', () => {
  it('ignores comments and strings and reports every occurrence with lines', () => {
    const gaps = scanDafnyTrustedBase('// assume false\nmethod M() { print "assume"; assume true; assume true; }');
    expect(gaps).toHaveLength(2);
    expect(gaps.every(gap => gap.includes('line 2:'))).toBe(true);
  });
  it('finds bodyless declarations and trusted attributes', () => {
    const gaps = scanDafnyTrustedBase('method M()\nlemma L()\nfunction F(): int\nmethod {:extern} E()\nopaque function O(): int { 1 }');
    expect(gaps.filter(gap => gap.includes('bodyless'))).toHaveLength(4);
    expect(gaps.some(gap => gap.includes('extern'))).toBe(true);
    expect(gaps.some(gap => gap.includes('opaque'))).toBe(true);
  });
  it('permits declarations in traits and abstract modules only', () => {
    expect(scanDafnyTrustedBase('trait T { method M() }\nabstract module A { function F(): int }')).toEqual([]);
    expect(scanDafnyTrustedBase('trait T { method M() }\nmethod Outside()')).toHaveLength(1);
  });
});
