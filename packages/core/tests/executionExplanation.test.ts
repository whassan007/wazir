import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { explainExecution } from '../src/services/executionExplanation.js';

/** Phase 22: every "why" is derived from durable execution facts written by the real engine. */
describe('explainExecution', () => {
  it('explains retries, escalations, tool outcomes, completion rejection and termination from events', async () => {
    const engine = new ExecutionEngine();
    const { execution } = await engine.create({
      task: { id: 't', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date(), acceptanceContract: { requiredEvidence: ['BUILD'] } },
      computerId: 'local', runtimeId: 'lmstudio', modelId: 'weak',
    });
    const id = execution.id;
    await engine.setStatus(id, 'running');
    await engine.recordProviderEvent(id, { type: 'retry', error: 'x', failureClass: 'RATE_LIMIT', retryAttempt: 1, retryDelayMs: 500 }, { requestId: 'req-1', model: 'weak', provider: 'lmstudio' });
    await engine.recordEvent(id, 'model.route.changed', { previousModel: 'weak', newModel: null, accepted: false, failureClass: 'NO_PROGRESS', reason: 'stuck', routeDecision: 'task pins model' });
    await engine.recordEvent(id, 'model.route.changed', { previousModel: 'weak', newModel: 'strong', accepted: true, failureClass: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED', reason: 'bad JSON', routeDecision: 'scheduler: coding capability' });
    await engine.recordToolStart(id, 'git', { command: 'commit' }, { callId: 'c1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow();
    await engine.reconcileToolCall(id, 'c1', { outcome: 'APPLIED', evidence: 'commit present in log', inspectedBy: 'operator' });
    await engine.recordPolicy(id, { tool: 'shell', decision: 'deny', rule: 'shell-network-deny', reasons: ['curl is a network command'] } as never);
    await engine.recordEvent(id, 'termination.completed', { reason: 'VERIFICATION_FAILED', modelId: 'strong' });

    const why = explainExecution(engine.require(id));

    expect(why.retries).toMatchObject([{ attempt: 1, failureClass: 'RATE_LIMIT', provider: 'lmstudio', model: 'weak', delayMs: 500, exhausted: false }]);
    expect(why.escalations.map((e) => [e.accepted, e.newModel, e.failureClass])).toEqual([[false, null, 'NO_PROGRESS'], [true, 'strong', 'MODEL_PROTOCOL_BUDGET_EXHAUSTED']]);
    expect(why.completionRejections[0]).toMatchObject({ reason: 'TOOL_OUTCOME_UNKNOWN' });
    expect(why.toolOutcomes.unknown).toEqual([]);
    expect(why.toolOutcomes.reconciled).toMatchObject([{ callId: 'c1', tool: 'git', outcome: 'APPLIED', inspectedBy: 'operator' }]);
    expect(why.policyDenials).toMatchObject([{ tool: 'shell', decision: 'deny', rule: 'shell-network-deny' }]);
    expect(why.termination).toMatchObject({ reason: 'VERIFICATION_FAILED', modelId: 'strong' });
  });

  it('reports a still-unresolved outcome and a stale-evidence completion rejection', async () => {
    const engine = new ExecutionEngine();
    const { execution } = await engine.create({
      task: { id: 't', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date(), acceptanceContract: { requiredEvidence: ['BUILD'] } },
      computerId: 'local', runtimeId: 'r', modelId: 'm',
    });
    const id = execution.id;
    await engine.setStatus(id, 'running');
    await engine.recordCheck(id, { name: 'build', command: 'make', ok: true, output: '', durationMs: 1, workspaceRevision: 0 });
    await engine.recordFileMutations(id, [{ path: 'a.cpp', attempted: true, succeeded: true, existedBefore: true, existsAfter: true, beforeHash: 'a', afterHash: 'b', changed: true }]);
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow();
    await engine.recordToolStart(id, 'shell', { command: 'deploy' }, { callId: 'd1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
    await engine.recordToolCall(id, { id: 'd1', tool: 'shell', input: {}, ok: false, failureClass: 'TOOL_OUTCOME_UNKNOWN', policyEffect: 'allow', policyRule: 'r', durationMs: 1, at: new Date() });

    const why = explainExecution(engine.require(id));

    expect(why.evidenceInvalidations).toMatchObject([{ workspaceRevision: 1 }]);
    expect(why.completionRejections[0].reason).toBe('VERIFICATION_REQUIRED');
    expect(why.completionRejections[0].detail).toContain('revision 1 lacks current evidence');
    expect(why.toolOutcomes.unknown).toEqual([{ callId: 'd1', tool: 'shell' }]);
    expect(why.termination.reason).toBeNull();
  });
});
