import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionEngine, PolicyEngine, type ToolResult } from '@wazir/core';
import { executeTool, ToolRegistry } from '../src/registry.js';

describe('physical mutation and revision-fenced controller completion', () => {
  let root: string;
  let engine: ExecutionEngine;
  let registry: ToolRegistry;
  let policy: PolicyEngine;
  let id: string;
  let call = 0;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wazir-physical-'));
    engine = new ExecutionEngine();
    registry = new ToolRegistry();
    policy = new PolicyEngine({ projectRoot: root, allowCommands: ['node', 'printf'] });
    const record = await engine.create({ task: { id: 'task', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date(), acceptanceContract: { requiredEvidence: ['BUILD', 'TEST'] } }, computerId: 'computer', runtimeId: 'runtime', modelId: 'model' });
    id = record.execution.id;
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function run(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const decision = await policy.authorize({ tool: name, input, projectRoot: root, executionId: id });
    expect(decision.decision).toBe('allow');
    const callId = `call-${++call}`;
    const result = await executeTool(registry, name, input, { projectRoot: root, executionId: id, callId, verifyWorkspace: true, checkpoint: async () => {
      await engine.recordToolStart(id, name, input, { callId, sideEffectClass: registry.get(name)!.descriptor.sideEffectClass });
    } });
    await engine.recordToolCall(id, { id: callId, tool: name, input, ok: result.ok, output: result.output, error: result.error, failureClass: result.failureClass, policyEffect: decision.decision, policyRule: decision.rule, durationMs: result.durationMs, at: new Date() });
    await engine.recordFileMutations(id, result.fileMutations ?? []);
    return result;
  }

  async function check(name: 'build' | 'test', command: string) {
    const revision = engine.getWorkspaceRevision(id);
    const result = await run('shell', { command });
    await engine.recordCheck(id, { name, command, ok: result.ok, output: result.output, durationMs: result.durationMs, workspaceRevision: revision });
    return result;
  }

  it('failed and no-op edits do not change revision; a real edit changes it once', async () => {
    await writeFile(join(root, 'main.js'), 'const value = 1;\n');
    expect((await run('edit', { path: 'main.js', oldString: 'absent', newString: 'x' })).ok).toBe(false);
    expect(engine.getWorkspaceRevision(id)).toBe(0);
    await run('write', { path: 'main.js', content: 'const value = 1;\n' });
    expect(engine.getWorkspaceRevision(id)).toBe(0);
    await run('edit', { path: 'main.js', oldString: '1', newString: '2' });
    expect(engine.getWorkspaceRevision(id)).toBe(1);
    const mutations = (await engine.events(id)).filter(event => event.type === 'workspace.mutated');
    expect(mutations).toHaveLength(1);
    const proof = (mutations[0].data as { mutations: Array<{ beforeHash: string; afterHash: string }> }).mutations[0];
    expect(proof.beforeHash).not.toBe(proof.afterHash);
  });

  it('observes shell edits instead of relying on filesystem-tool narration', async () => {
    await writeFile(join(root, 'main.js'), 'original');
    const result = await run('shell', { command: 'printf changed > main.js' });
    expect(result.ok).toBe(true);
    expect(result.fileMutations).toMatchObject([{ path: 'main.js', changed: true }]);
    expect(engine.getWorkspaceRevision(id)).toBe(1);
  });

  it('ignores a tool claim of mutation when bytes remain unchanged', async () => {
    await writeFile(join(root, 'main.js'), 'original');
    const descriptor = registry.get('write')!.descriptor;
    registry.register({ descriptor, async execute() { return { ok: true, output: 'I changed the file', durationMs: 0, fileMutations: [{ path: 'main.js', attempted: true, succeeded: true, existedBefore: true, existsAfter: true, beforeHash: 'fake-before', afterHash: 'fake-after', changed: true }] }; } });
    const result = await run('write', { path: 'main.js', content: 'claimed' });
    expect(result.fileMutations).toEqual([]);
    expect(engine.getWorkspaceRevision(id)).toBe(0);
  });

  it('requires real build and test evidence again after a physical edit', async () => {
    await writeFile(join(root, 'main.js'), 'if (1 + 1 !== 2) throw new Error("bad");\n');
    expect((await check('build', 'node --check main.js')).ok).toBe(true);
    expect((await check('test', 'node main.js')).ok).toBe(true);
    await engine.setStatus(id, 'completed', { targetRevision: 0 });
    await run('write', { path: 'main.js', content: 'throw new Error("regression");\n' });
    await expect(engine.setStatus(id, 'completed', { targetRevision: 1 })).rejects.toThrow('current verification');
    expect((await check('build', 'node --check main.js')).ok).toBe(true);
    expect((await check('test', 'node main.js')).ok).toBe(false);
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow('current verification');
    await run('write', { path: 'main.js', content: 'if (1 + 1 !== 2) throw new Error("bad");\n' });
    await check('build', 'node --check main.js');
    await check('test', 'node main.js');
    await engine.setStatus(id, 'completed', { targetRevision: 2 });
    expect(engine.require(id).evidence?.filter(e => e.revision === 2).map(e => e.exitCode)).toEqual([0, 0]);
  });

  it('a model claim creates no evidence and cannot satisfy the acceptance contract', async () => {
    await engine.setResult(id, 'Tests passed; implementation complete.');
    expect(engine.require(id).evidence).toEqual([]);
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow('current verification');
  });

  it('binds late check results to the dispatch revision', async () => {
    const revision = engine.getWorkspaceRevision(id);
    await run('write', { path: 'main.js', content: 'changed' });
    await engine.recordCheck(id, { name: 'build', command: 'build', ok: true, output: '', durationMs: 1, workspaceRevision: revision });
    expect(engine.require(id).evidence?.at(-1)?.revision).toBe(0);
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow('current verification');
  });
});
