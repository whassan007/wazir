import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { VerificationEngine } from '../src/services/verificationEngine.js';

// Versioned deterministic fault-injection benchmark; not live model task success.
describe('execution accuracy v1', () => {
  it('does not rebind an in-flight oracle to a newer workspace', async () => {
    const engine = new VerificationEngine();
    let finish!: (result: { exitCode: number }) => void;
    engine.registerOracle({ type: 'TEST', verify: () => new Promise(resolve => { finish = resolve; }) });
    const pending = engine.runOracle('TEST');
    engine.trackPhysicalMutation({ filePath: 'a.ts', beforeContent: 'old', afterContent: 'new' });
    finish({ exitCode: 0 });
    expect((await pending).workspaceRevision).toBe(0);
    expect(engine.verifyCompletion({ requiredOracles: ['TEST'] }).complete).toBe(false);
  });

  it('a later failure supersedes an earlier passing command', () => {
    const engine = new VerificationEngine();
    engine.recordEvidence({ oracle: 'TEST', command: 'test', exitCode: 0 });
    engine.recordEvidence({ oracle: 'TEST', command: 'test', exitCode: 1 });
    expect(engine.verifyCompletion({ requiredOracles: ['TEST'] }).complete).toBe(false);
  });

  it('one passing command does not hide another failing command', () => {
    const engine = new VerificationEngine();
    engine.recordEvidence({ oracle: 'TEST', command: 'unit', exitCode: 0 });
    engine.recordEvidence({ oracle: 'TEST', command: 'integration', exitCode: 1 });
    expect(engine.verifyCompletion({ requiredOracles: ['TEST'] }).complete).toBe(false);
  });

  it('a repaired command can pass at the same revision', () => {
    const engine = new VerificationEngine();
    engine.recordEvidence({ oracle: 'TEST', command: 'test', exitCode: 1 });
    engine.recordEvidence({ oracle: 'TEST', command: 'test', exitCode: 0 });
    expect(engine.verifyCompletion({ requiredOracles: ['TEST'] }).complete).toBe(true);
  });

  it('an explicit semantic failure blocks completion despite exit zero', async () => {
    const engine = new ExecutionEngine();
    const record = await engine.create({ task: { id: 'v1', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date(), acceptanceContract: { requiredEvidence: ['TEST'] } }, computerId: 'local', runtimeId: 'test', modelId: 'test' });
    await engine.recordEvidence(record.execution.id, { type: 'TEST', revision: 0, command: 'test', exitCode: 0, status: 'FAIL' } as never);
    await expect(engine.setStatus(record.execution.id, 'completed')).rejects.toThrow();
  });

  it('caller mutation cannot remove persisted acceptance requirements', async () => {
    const engine = new ExecutionEngine();
    const contract = { requiredEvidence: ['TEST' as const] };
    const record = await engine.create({ task: { id: 'v1', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date(), acceptanceContract: contract }, computerId: 'local', runtimeId: 'test', modelId: 'test' });
    contract.requiredEvidence.length = 0;
    await expect(engine.setStatus(record.execution.id, 'completed')).rejects.toThrow();
  });
});
