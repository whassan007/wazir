import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '../src/services/executionEngine.js';

/**
 * Regressions #16/#17 in isolation: evidence of one kind bound to revision R never
 * satisfies revision R+1, even when the OTHER required evidence is current.
 */
async function setup() {
  const engine = new ExecutionEngine();
  const { execution } = await engine.create({
    task: { id: 't', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date(), acceptanceContract: { requiredEvidence: ['BUILD', 'TEST'] } },
    computerId: 'c', runtimeId: 'r', modelId: 'm',
  });
  const id = execution.id;
  await engine.setStatus(id, 'running');
  const check = (name: 'build' | 'test') => engine.recordCheck(id, { name, command: name, ok: true, output: '', durationMs: 1, workspaceRevision: engine.getWorkspaceRevision(id) });
  const mutate = () => engine.recordFileMutations(id, [{ path: 'a.cpp', attempted: true, succeeded: true, existedBefore: true, existsAfter: true, beforeHash: `h${engine.getWorkspaceRevision(id)}`, afterHash: `h${engine.getWorkspaceRevision(id) + 1}`, changed: true }]);
  return { engine, id, check, mutate };
}

describe('revision-fenced evidence per kind', () => {
  it('#16 BUILD(R) does not satisfy BUILD(R+1), even with TEST(R+1) passing', async () => {
    const { engine, id, check, mutate } = await setup();
    await check('build');
    await mutate();
    await check('test');
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow('current verification');
    await check('build');
    await expect(engine.setStatus(id, 'completed')).resolves.toBeUndefined();
  });

  it('#17 TEST(R) does not satisfy TEST(R+1), even with BUILD(R+1) passing', async () => {
    const { engine, id, check, mutate } = await setup();
    await check('test');
    await mutate();
    await check('build');
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow('current verification');
    await check('test');
    await expect(engine.setStatus(id, 'completed')).resolves.toBeUndefined();
  });
});
