import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveZ3Python, Z3Adapter } from '../adapters/z3';
import { Obligation, Verdict } from '../contracts';

const adapter = new Z3Adapter({ expectedVersion: '5.3.1' });
let dir: string;
let file = 0;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'z3-tests-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
const obligation = (extra: Partial<Obligation> = {}): Obligation => ({
  id: 'test', propertyId: 'P', specVersion: '1', specHash: 'hash', tool: 'z3',
  artifactPath: '', assumptions: ['(>= x 0)'], guarantee: '(>= x 0)',
  metadata: { smtLib: '(declare-const x Int)' }, ...extra,
});
async function python(source: string, extra: Partial<Obligation> = {}) {
  const path = join(dir, `${file++}.py`);
  await writeFile(path, source);
  return adapter.verify(obligation({ artifactPath: path, metadata: {}, ...extra }), 'rev');
}

describe('Z3 Python path resolution', () => {
  it('honors environment overrides while preserving explicit config precedence', () => {
    try {
      vi.stubEnv('WAZIR_TOOLS_DIR', '/home/wael/Code/Wazir/tools');
      vi.stubEnv('WAZIR_Z3_PYTHON', '');
      expect(resolveZ3Python()).toBe('/home/wael/Code/Wazir/tools/z3-venv/bin/python3');
      vi.stubEnv('WAZIR_Z3_PYTHON', '/custom/python3');
      expect(resolveZ3Python()).toBe('/custom/python3');
      expect(resolveZ3Python({ toolsDir: '/explicit/tools' })).toBe('/explicit/tools/z3-venv/bin/python3');
      expect(resolveZ3Python({ pythonPath: '/explicit/python3', toolsDir: '/explicit/tools' })).toBe('/explicit/python3');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('Z3Adapter using real pinned Z3', () => {
  it('reports real tool version', async () => {
    expect(await adapter.checkAvailability()).toMatchObject({ available: true, version: '5.3.1', path: resolveZ3Python() });
  });
  it('PROVED requires two satisfiable vacuity checks and unsat on negated P', async () => {
    const r = await adapter.verify(obligation(), 'rev');
    expect(r.verdict).toBe(Verdict.PROVED);
    expect(r.vacuityProbe).toEqual({ passed: true, details: { assumptions: 'sat', precondition: 'sat' } });
    expect(r).toMatchObject({ toolVersion: '5.3.1', seed: 0 });
    expect(r.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.elapsedMs).toBeGreaterThan(0);
    expect(r.stdout).toContain('unsat');
  });
  it.each([{ bounded: true }, { scope: 'x within 10' }])('BOUNDED_PASS for bounds %j', async (bounds) => {
    expect((await adapter.verify(obligation(bounds), 'rev')).verdict).toBe(Verdict.BOUNDED_PASS);
  });
  it('SAT on negated P MUST be COUNTEREXAMPLE, never PROVED (inversion guard)', async () => {
    const r = await adapter.verify(obligation({ guarantee: '(> x 0)' }), 'rev');
    expect(r.verdict).toBe(Verdict.COUNTEREXAMPLE);
    expect(r.witness).toEqual({ x: '0' });
  });
  it('contradictory A downgrades an otherwise unsat query', async () => {
    const r = await adapter.verify(obligation({ assumptions: ['(> x 0)', '(< x 0)'] }), 'rev');
    expect(r.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(r.vacuityProbe?.passed).toBe(false);
  });
  it('unreachable precondition is inconsistent', async () => {
    const o = obligation(); o.metadata!.precondition = '(< x 0)';
    expect((await adapter.verify(o, 'rev')).verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
  });
  it('implementation is included in the negated property query', async () => {
    const o = obligation({ guarantee: '(= x 2)' }); o.metadata!.implementation = '(= x 2)';
    expect((await adapter.verify(o, 'rev')).verdict).toBe(Verdict.PROVED);
  });
  it('NOT_RUN for a missing python binary', async () => {
    expect((await new Z3Adapter({ pythonPath: '/nonexistent/z3-python' }).verify(obligation(), 'rev')).verdict).toBe(Verdict.NOT_RUN);
  });
  it('UNKNOWN on subprocess timeout', async () => {
    const r = await python('import time\ntime.sleep(10)', { timeoutMs: 100 });
    expect(r.verdict).toBe(Verdict.UNKNOWN);
    expect(r.elapsedMs).toBeLessThan(5000);
  });
  it('UNKNOWN from structured solver output', async () => {
    expect((await python('print(\'STATUS: UNKNOWN\')')).verdict).toBe(Verdict.UNKNOWN);
  });
  it('ERROR on invalid Python', async () => {
    const r = await python('this is invalid Python !');
    expect(r.verdict).toBe(Verdict.ERROR);
    expect(r.stderr).toContain('SyntaxError');
  });
  it('ERROR on invalid SMT syntax', async () => {
    expect((await adapter.verify(obligation({ guarantee: '(no_such_function x)' }), 'rev')).verdict).toBe(Verdict.ERROR);
  });
  it('does not promote unprobed Python pass output', async () => {
    expect((await python('print(\'STATUS: PROVED\')')).verdict).toBe(Verdict.UNKNOWN);
  });
  it('parses multiline JSON, witness, and counterexample exit 2', async () => {
    const r = await python('import json\nprint(json.dumps({"status":"COUNTEREXAMPLE","solver_result":"sat","witness":{"x":0}},indent=2))\nraise SystemExit(2)');
    expect(r.verdict).toBe(Verdict.COUNTEREXAMPLE);
    expect(r.witness).toEqual({ x: 0 });
  });
  it('raw SAT overrides a falsely claimed Python proof', async () => {
    expect((await python('print(\'{"status":"PROVED","solver_result":"sat","vacuityProbe":{"passed":true}}\')')).verdict).toBe(Verdict.COUNTEREXAMPLE);
  });
  it('accepts Python proof with explicit probe evidence', async () => {
    expect((await python('print(\'{"status":"PROVED","solver_result":"unsat","vacuityProbe":{"passed":true}}\')')).verdict).toBe(Verdict.PROVED);
  });
  it.each([
    { command: '--label "two words"' },
    { metadata: { args: ['--label', 'two words'] } },
    { command: '--ignored', metadata: { args: ['--label', 'two words'] } },
  ])('forwards Python CLI arguments from %j', async (extra) => {
    const r = await python('import argparse, json\np = argparse.ArgumentParser()\np.add_argument("--label", required=True)\na = p.parse_args()\nassert a.label == "two words"\nprint(json.dumps({"status":"PROVED","vacuity_probe":{"A":"sat","A_and_precondition":"sat"}}))', extra);
    expect(r.verdict).toBe(Verdict.PROVED);
    expect(r.vacuityProbe?.passed).toBe(true);
  });
  it.each([
    [{ passed: true }, Verdict.PROVED],
    [{ A: 'sat', A_and_precondition: 'sat' }, Verdict.PROVED],
    [{ A: 'sat', A_and_precondition: 'unknown' }, Verdict.UNKNOWN],
    [{ A: 'sat' }, Verdict.UNKNOWN],
    [{ passed: false }, Verdict.UNKNOWN],
  ])('checks snake_case Python probe evidence %j', async (probe, verdict) => {
    const output = JSON.stringify({ status: 'PROVED', solver_result: 'unsat', vacuity_probe: probe });
    const r = await python(`print(${JSON.stringify(output)})`);
    expect(r.verdict).toBe(verdict);
  });
  it('reads SMT2 files and hashes both content and revision', async () => {
    const path = join(dir, 'model.smt2');
    await writeFile(path, '(declare-const x Int)');
    const o = obligation({ artifactPath: path, metadata: {} });
    const a = await adapter.verify(o, 'a');
    const b = await adapter.verify(o, 'b');
    expect(a.verdict).toBe(Verdict.PROVED);
    expect(a.inputHash).not.toBe(b.inputHash);
    await writeFile(path, '(declare-const x Real)');
    expect((await adapter.verify(o, 'a')).inputHash).not.toBe(a.inputHash);
  });
  it('enforces a configured memory budget', async () => {
    const r = await python('data = bytearray(200 * 1024 * 1024)', { memoryLimitMb: 64 });
    expect(r.verdict).toBe(Verdict.ERROR);
  });
  it('never treats a runtime failure or missing file as proof', async () => {
    expect((await python('raise RuntimeError("broken")')).verdict).toBe(Verdict.ERROR);
    expect((await adapter.verify(obligation({ artifactPath: '/missing.smt2', metadata: {} }), 'rev')).verdict).toBe(Verdict.ERROR);
  });
});
