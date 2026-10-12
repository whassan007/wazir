import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { explainCompletion, inspectVerificationEvidence, UNKNOWN } from '../src/services/verificationEvidenceInspector.js';
import type { FileMutationResult } from '../src/types/tool.js';

/** Every case is driven through the real ExecutionEngine; the inspector only reads its record. */
async function setup(requiredEvidence: Array<'BUILD' | 'TEST' | 'ACCEPTANCE'> = ['BUILD', 'TEST', 'ACCEPTANCE']) {
  const engine = new ExecutionEngine();
  const { execution } = await engine.create({
    task: { id: 't-1', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date(), acceptanceContract: { requiredEvidence } },
    computerId: 'local', runtimeId: 'lmstudio', modelId: 'qwen',
  });
  await engine.setStatus(execution.id, 'running');
  return { engine, id: execution.id };
}

const mutation = (path: string, before: string, after: string, extra: Partial<FileMutationResult> = {}): FileMutationResult => ({
  path, attempted: true, succeeded: true, existedBefore: true, existsAfter: true, beforeHash: before, afterHash: after, changed: before !== after, ...extra,
});

async function passAll(engine: ExecutionEngine, id: string) {
  await engine.recordEvidence(id, { type: 'BUILD', revision: engine.getWorkspaceRevision(id), command: 'npm run build', exitCode: 0 } as never);
  await engine.recordEvidence(id, { type: 'TEST', revision: engine.getWorkspaceRevision(id), command: 'npm test', exitCode: 0, metadata: { passed: 42, failed: 0 } } as never);
  await engine.recordEvidence(id, { type: 'ACCEPTANCE', revision: engine.getWorkspaceRevision(id), exitCode: 0, metadata: { criteria: ['a', 'b', 'c', 'd', 'e', 'f'] }, reasons: [] } as never);
}

describe('inspectVerificationEvidence', () => {
  it('fully verified revision: every slot PASS at current revision, why complete returns the chain', async () => {
    const { engine, id } = await setup();
    await engine.recordFileMutations(id, [mutation('src/a.ts', 'aaa', 'bbb')], 'digest-1');
    await passAll(engine, id);
    // Model narration claiming otherwise is ignored.
    await engine.setResult(id, 'All tests FAILED, nothing works');

    const i = inspectVerificationEvidence(engine.require(id));
    expect(i.currentRevision).toBe(1);
    expect(i.workspaceDigest).toBe('digest-1');
    expect(i.slots.map((s) => [s.oracle, s.status, s.revision])).toEqual([['BUILD', 'PASS', 1], ['TEST', 'PASS', 1], ['ACCEPTANCE', 'PASS', 1]]);
    expect(i.slots[1]).toMatchObject({ passed: 42, failed: 0 });
    expect(i.slots[2].criteria).toEqual({ satisfied: 6, total: 6 });
    expect(i.completion.eligible).toBe(true);
    const why = explainCompletion(i);
    expect(why.complete).toBe(true);
    expect(why.chain.join('\n')).toMatch(/BUILD .*npm run build.*exit 0 at R1/);
    // The inspector agrees with the real completion gate.
    await expect(engine.setStatus(id, 'completed')).resolves.toBeUndefined();
  });

  it('build failure: FAIL and why incomplete names it', async () => {
    const { engine, id } = await setup(['BUILD']);
    await engine.recordEvidence(id, { type: 'BUILD', revision: 0, command: 'tsc', exitCode: 2 } as never);
    const i = inspectVerificationEvidence(engine.require(id));
    expect(i.slots[0]).toMatchObject({ status: 'FAIL', exitCode: 2 });
    expect(explainCompletion(i).missing).toEqual(['BUILD: FAIL at R0 (exit 2)']);
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow();
  });

  it('a PASS status with a nonzero exit is never shown as PASS', async () => {
    const { engine, id } = await setup(['BUILD']);
    await engine.recordEvidence(id, { type: 'BUILD', revision: 0, command: 'tsc', exitCode: 1, status: 'PASS' } as never);
    expect(inspectVerificationEvidence(engine.require(id)).slots[0].status).toBe('FAIL');
  });

  it('test failure', async () => {
    const { engine, id } = await setup(['TEST']);
    await engine.recordEvidence(id, { type: 'TEST', revision: 0, command: 'npm test', exitCode: 1, metadata: { passed: 40, failed: 2 } } as never);
    const i = inspectVerificationEvidence(engine.require(id));
    const test = i.slots.find((s) => s.oracle === 'TEST')!;
    expect(test).toMatchObject({ status: 'FAIL', passed: 40, failed: 2 });
    expect(i.completion.eligible).toBe(false);
  });

  it('acceptance failure counts satisfied criteria from controller reasons', async () => {
    const { engine, id } = await setup(['ACCEPTANCE']);
    await engine.recordEvidence(id, { type: 'ACCEPTANCE', revision: 0, exitCode: 1, metadata: { criteria: ['a', 'b', 'c'] }, reasons: ["Acceptance failed: File 'x' does not exist", 'ok', 'ok'] } as never);
    const acc = inspectVerificationEvidence(engine.require(id)).slots.find((s) => s.oracle === 'ACCEPTANCE')!;
    expect(acc.status).toBe('FAIL');
    expect(acc.criteria).toEqual({ satisfied: 2, total: 3 });
  });

  it('stale test evidence: STALE, not PASS, and not valid for completion', async () => {
    const { engine, id } = await setup(['TEST']);
    await engine.recordFileMutations(id, [mutation('src/a.ts', 'a', 'b')]);
    await engine.recordEvidence(id, { type: 'TEST', revision: 1, command: 'npm test', exitCode: 0 } as never);
    await engine.recordFileMutations(id, [mutation('src/a.ts', 'b', 'c')]);

    const i = inspectVerificationEvidence(engine.require(id));
    const test = i.slots.find((s) => s.oracle === 'TEST')!;
    expect(i.currentRevision).toBe(2);
    expect(test).toMatchObject({ status: 'STALE', recordedStatus: 'PASS', revision: 1 });
    expect(explainCompletion(i).missing).toEqual(['TEST: STALE — evidence is for R1, current revision is R2']);
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow();
  });

  it('post-verification mutation is flagged and invalidates completion', async () => {
    const { engine, id } = await setup();
    await engine.recordFileMutations(id, [mutation('src/a.ts', 'a', 'b')]);
    await passAll(engine, id);
    await engine.recordFileMutations(id, [mutation('src/b.ts', 'x', 'y')]);
    const i = inspectVerificationEvidence(engine.require(id));
    expect(i.mutations.map((m) => [m.file, m.revision, m.afterVerification])).toEqual([['src/a.ts', 1, false], ['src/b.ts', 2, true]]);
    expect(i.slots.every((s) => s.status === 'STALE')).toBe(true);
    expect(i.completion.eligible).toBe(false);
  });

  it('missing evidence', async () => {
    const { engine, id } = await setup(['BUILD', 'TEST']);
    const i = inspectVerificationEvidence(engine.require(id));
    expect(i.slots.find((s) => s.oracle === 'BUILD')).toMatchObject({ status: 'MISSING', command: UNKNOWN, exitCode: UNKNOWN, revision: UNKNOWN });
    expect(explainCompletion(i).missing).toEqual(['BUILD: no evidence recorded for R0', 'TEST: no evidence recorded for R0']);
  });

  it('failed and no-op edits never appear as physical changes nor advance the revision', async () => {
    const { engine, id } = await setup();
    await engine.recordFileMutations(id, [
      mutation('src/failed.ts', 'a', 'a', { succeeded: false, changed: false }),
      mutation('src/noop.ts', 'h', 'h'),
    ]);
    const i = inspectVerificationEvidence(engine.require(id));
    expect(i.currentRevision).toBe(0);
    expect(i.mutations).toEqual([]);
  });

  it('a logged mutation event with a failed write is filtered defensively', async () => {
    const { engine, id } = await setup();
    await engine.recordEvent(id, 'workspace.mutated', { workspaceRevision: 1, mutations: [mutation('src/x.ts', 'a', 'b', { succeeded: false })] });
    expect(inspectVerificationEvidence(engine.require(id)).mutations).toEqual([]);
  });

  it('UNKNOWN fields: no digest, no test counts, no hashes, no provenance values are invented', async () => {
    const { engine, id } = await setup(['TEST']);
    await engine.recordFilesChanged(id, ['src/raw.ts']);
    await engine.recordEvidence(id, { type: 'TEST', revision: 1, command: 'npm test', exitCode: 0 } as never);
    const i = inspectVerificationEvidence(engine.require(id));
    expect(i.workspaceDigest).toBe(UNKNOWN);
    expect(i.slots.find((s) => s.oracle === 'TEST')).toMatchObject({ passed: UNKNOWN, failed: UNKNOWN });
    expect(i.mutations).toEqual([{ file: 'src/raw.ts', beforeHash: UNKNOWN, afterHash: UNKNOWN, revision: 1, afterVerification: false }]);
    const byKind = Object.fromEntries(i.provenance.map((p) => [p.kind, p.values]));
    expect(byKind.Job).toEqual([UNKNOWN]);
    expect(byKind.Artifact).toEqual([UNKNOWN]);
    expect(byKind.Model).toEqual(['qwen']);
    expect(byKind.Verification[0]).toMatch(/TEST@R1$/);
  });

  it('provenance drill-down is bounded', async () => {
    const { engine, id } = await setup(['BUILD']);
    for (let n = 0; n < 12; n++) await engine.recordEvidence(id, { type: 'BUILD', revision: 0, command: `b${n}`, exitCode: 0 } as never);
    const v = inspectVerificationEvidence(engine.require(id), { provenanceLimit: 5 }).provenance.find((p) => p.kind === 'Verification')!;
    expect(v.values).toHaveLength(6);
    expect(v.values[5]).toBe('(+7 more)');
  });

  it('unreconciled tool calls block eligibility, matching the engine gate', async () => {
    const { engine, id } = await setup(['BUILD']);
    await engine.recordEvidence(id, { type: 'BUILD', revision: 0, command: 'b', exitCode: 0 } as never);
    await engine.recordToolStart(id, 'write_file', { path: 'x' }, { callId: 'c1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
    const i = inspectVerificationEvidence(engine.require(id), { toolCheckpoints: engine.toolCheckpoints(id) });
    expect(i.unresolvedToolCalls).toBe(1);
    expect(i.completion.eligible).toBe(false);
    expect(explainCompletion(i).missing.at(-1)).toMatch(/TOOL_OUTCOME_UNKNOWN/);
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow();
  });
});
