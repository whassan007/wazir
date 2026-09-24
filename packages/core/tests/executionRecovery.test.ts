import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { RecoveryManager } from '../src/services/recoveryManager.js';
import type { ExecutionRecord, ToolCallRecord } from '../src/types/index.js';

/**
 * Phase 21: recovery reconstructs execution state from durable events, never replays an
 * unresolved non-idempotent call, reconciles only from physical proof, and resumes the
 * SAME execution when safe.
 */
async function setup() {
  let durable!: ExecutionRecord;
  const engine = new ExecutionEngine({ persist: (r) => { durable = structuredClone(r); } });
  const record = await engine.create({
    task: { id: 'task', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
    computerId: 'computer', runtimeId: 'runtime', modelId: 'model',
  });
  const id = record.execution.id;
  await engine.setStatus(id, 'running');
  const restart = async () => {
    const recovered = new ExecutionEngine({ load: () => [durable], persist: (r) => { durable = structuredClone(r); } });
    await recovered.ready;
    return recovered;
  };
  return { engine, id, restart };
}
const result = (id: string, tool: string, ok = true): ToolCallRecord => ({ id, tool, input: {}, ok, policyEffect: 'allow', policyRule: 'test', durationMs: 1, at: new Date() });
const mutation = (path: string, before: string, after: string) => ({ path, attempted: true, succeeded: true, existedBefore: true, existsAfter: true, beforeHash: before, afterHash: after, changed: before !== after });

describe('execution reconstruction', () => {
  it('reconstructs revision, last confirmed result and revision-fenced evidence from events after a restart', async () => {
    const { engine, id, restart } = await setup();
    await engine.recordFileMutations(id, [mutation('a.cpp', 'h0', 'h1')]);
    await engine.recordCheck(id, { name: 'build', command: 'make', ok: true, output: '', durationMs: 5, workspaceRevision: engine.getWorkspaceRevision(id) });
    await engine.recordFileMutations(id, [mutation('a.cpp', 'h1', 'h2')]);
    await engine.recordCheck(id, { name: 'test', command: 'make test', ok: false, output: '', durationMs: 5, workspaceRevision: engine.getWorkspaceRevision(id) });
    await engine.recordToolStart(id, 'read', { path: 'a.cpp' }, { callId: 'r1', sideEffectClass: 'READ_ONLY' });
    await engine.recordToolCall(id, result('r1', 'read'));

    const recovered = await restart();
    const { state, plan } = recovered.reconstruct(id);

    expect(state.workspaceRevision).toBe(recovered.getWorkspaceRevision(id));
    expect(state.workspaceRevision).toBe(2);
    expect(state.lastConfirmedToolResult).toMatchObject({ callId: 'r1', tool: 'read', ok: true });
    // BUILD ran at revision 1: stale for revision 2. TEST ran at 2 and failed.
    expect(state.verification).toEqual({ currentPassing: [], currentFailing: ['test'], staleChecks: 1 });
    expect(plan.action).toBe('resume');
    expect(plan.reasons.join(' ')).toContain('resume at workspace revision 2');
  });

  it('crash after a non-idempotent dispatch requires reconciliation, never a replay', async () => {
    const { engine, id, restart } = await setup();
    await engine.recordToolStart(id, 'git', { command: 'commit -m fix' }, { callId: 'commit-1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });

    const recovered = await restart();
    const { state, plan } = recovered.reconstruct(id);
    expect(state.unresolvedToolCalls).toMatchObject([{ callId: 'commit-1', toolName: 'git', state: 'OUTCOME_UNKNOWN' }]);
    expect(plan.action).toBe('reconcile');
    expect(plan.reasons[0]).toContain('must not be replayed blindly');
    await expect(recovered.recordToolStart(id, 'git', { command: 'commit -m fix' }, { callId: 'commit-2' })).rejects.toThrow('reconciled');
  });

  it('refuses to reconcile without proof', async () => {
    const { engine, id, restart } = await setup();
    await engine.recordToolStart(id, 'git', {}, { callId: 'c', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
    const recovered = await restart();
    await expect(recovered.reconcileToolCall(id, 'c', { outcome: 'UNDETERMINED', evidence: 'unknown', inspectedBy: 'test' })).rejects.toThrow('without proof');
    expect(recovered.reconstruct(id).plan.action).toBe('reconcile');
  });

  it('APPLIED reconciliation confirms the effect durably and unblocks the SAME execution', async () => {
    const { engine, id, restart } = await setup();
    await engine.recordToolStart(id, 'write', { path: 'a', content: 'x' }, { callId: 'w', sideEffectClass: 'IDEMPOTENT_WRITE' });
    const recovered = await restart();
    await recovered.reconcileToolCall(id, 'w', { outcome: 'APPLIED', evidence: "'a' holds exactly the intended content", inspectedBy: 'test' });

    expect(recovered.toolCheckpoints(id)).toMatchObject([{ callId: 'w', state: 'COMPLETED' }]);
    const { state, plan } = recovered.reconstruct(id);
    expect(state.executionId).toBe(id);
    expect(plan.action).toBe('resume');
    // Survives another restart: the reconciliation is a durable fact, not process memory.
    const again = await restart();
    expect(again.toolCheckpoints(id)).toMatchObject([{ callId: 'w', state: 'COMPLETED' }]);
    expect((await again.events(id)).some((e) => (e.data as { reconciled?: { evidence: string } })?.reconciled?.evidence.includes('intended content'))).toBe(true);
    // Already resolved: a second reconciliation is rejected.
    await expect(again.reconcileToolCall(id, 'w', { outcome: 'NOT_APPLIED', evidence: 'x', inspectedBy: 'test' })).rejects.toThrow('already COMPLETED');
  });

  it('NOT_APPLIED reconciliation allows the action to be issued again', async () => {
    const { engine, id, restart } = await setup();
    await engine.recordToolStart(id, 'write', { path: 'a', content: 'x' }, { callId: 'w1', sideEffectClass: 'IDEMPOTENT_WRITE' });
    const recovered = await restart();
    await recovered.reconcileToolCall(id, 'w1', { outcome: 'NOT_APPLIED', evidence: "'a' does not exist", inspectedBy: 'test' });
    await expect(recovered.recordToolStart(id, 'write', { path: 'a', content: 'x' }, { callId: 'w2', sideEffectClass: 'IDEMPOTENT_WRITE' })).resolves.toBe('w2');
  });

  it('plans termination when a budget is already exhausted, and nothing for a terminal execution', async () => {
    const { engine, id } = await setup();
    await engine.recordToolStart(id, 'read', {}, { callId: 'r', sideEffectClass: 'READ_ONLY' });
    await engine.recordToolCall(id, result('r', 'read'));
    expect(engine.reconstruct(id, { maxToolCalls: 1 }).plan).toMatchObject({ action: 'terminate' });
    expect(engine.reconstruct(id, { maxToolCalls: 5 }).state.remaining.toolCalls).toBe(4);
    await engine.setStatus(id, 'failed');
    expect(engine.reconstruct(id).plan.action).toBe('none');
  });
});

describe('RecoveryManager physical reconciliation', () => {
  async function offlineSetup(outcome: 'APPLIED' | 'NOT_APPLIED' | 'UNDETERMINED') {
    const executions = new ExecutionEngine();
    const { execution } = await executions.create({
      task: { id: 'task-1', type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      computerId: 'worker-1', runtimeId: 'r', modelId: 'm',
    });
    await executions.setStatus(execution.id, 'running');
    await executions.recordToolStart(execution.id, 'write', { path: 'a', content: 'x' }, { callId: 'w', sideEffectClass: 'IDEMPOTENT_WRITE' });
    const inspected: string[] = [];
    const manager = new RecoveryManager({
      computers: { checkHeartbeats: () => ({ offline: ['worker-1'], stale: [] }) } as never,
      executions,
      jobManager: { list: () => [] } as never,
      inspectToolOutcome: async (_record, call) => { inspected.push(call.callId); return { outcome, evidence: `inspected ${call.callId}` }; },
    });
    return { manager, executions, id: execution.id, inspected };
  }

  it('reconciles a proven outcome instead of leaving it blocked', async () => {
    const { manager, executions, id, inspected } = await offlineSetup('APPLIED');
    const result = await manager.sweep();
    expect(inspected).toEqual(['w']);
    expect(result.reconciled).toEqual([{ executionId: id, callId: 'w', tool: 'write', outcome: 'APPLIED', evidence: 'inspected w' }]);
    expect(result.unknownOutcomes).toEqual([]);
    expect(executions.toolCheckpoints(id)[0].state).toBe('COMPLETED');
  });

  it('keeps an undetermined outcome blocked and out of live retry', async () => {
    const { manager, executions, id } = await offlineSetup('UNDETERMINED');
    const result = await manager.sweep();
    expect(result.reconciled).toEqual([]);
    expect(result.unknownOutcomes).toMatchObject([{ executionId: id, tool: 'write' }]);
    expect(result.retriedLive).toEqual([]);
    expect(executions.toolCheckpoints(id)[0].state).toBe('STARTED');
  });
});
