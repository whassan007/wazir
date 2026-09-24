import { describe, expect, it } from 'vitest';
import { ExecutionEngine, type ExecutionRecord } from '@wazir/core';
import { projectExecutionCard } from '../src/tui/executionProjection.js';

/**
 * Regression #34: TUI state can be reconstructed from execution events. The card for
 * an execution is derived from the durable record, so a process restart reproduces it
 * exactly — the live TUI's in-memory state is never the source of truth.
 */
describe('projectExecutionCard', () => {
  it('rebuilds the same card, with controller facts, after a restart from durable storage', async () => {
    let durable!: ExecutionRecord;
    const engine = new ExecutionEngine({ persist: (r) => { durable = structuredClone(r); } });
    const { execution } = await engine.create({
      task: { id: 'task-1', type: 'coding', input: 'fix the sort', title: 'Fix sort', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      jobId: 'job-1', agentId: 'wazir-coding', computerId: 'local', runtimeId: 'lmstudio', modelId: 'weak',
    });
    const id = execution.id;
    await engine.setStatus(id, 'running');
    await engine.recordEvent(id, 'agent.phase', { phase: 'implement' });
    await engine.recordEvent(id, 'generation.started', { modelId: 'weak' });
    await engine.recordProviderEvent(id, { type: 'retry', error: 'x', failureClass: 'TIMEOUT', retryAttempt: 1, retryDelayMs: 100 }, { requestId: 'r1', model: 'weak' });
    await engine.recordEvent(id, 'generation.completed');
    await engine.recordEvent(id, 'agent.phase', { phase: 'repair' });
    await engine.recordEvent(id, 'model.route.changed', { previousModel: 'weak', newModel: 'strong', accepted: true, failureClass: 'NO_PROGRESS' });
    await engine.recordFileMutations(id, [{ path: 'sort.cpp', attempted: true, succeeded: true, existedBefore: true, existsAfter: true, beforeHash: 'a', afterHash: 'b', changed: true }]);
    await engine.recordCheck(id, { name: 'build', command: 'make', ok: true, output: '', durationMs: 1, workspaceRevision: 0 });
    await engine.recordCheck(id, { name: 'test', command: 'make test', ok: false, output: '', durationMs: 1, workspaceRevision: 1 });
    await engine.recordEvent(id, 'agent.turn', { kind: 'error', error: 'verification failed:\ntest: FAIL sort' });
    await engine.recordEvent(id, 'termination.completed', { reason: 'VERIFICATION_FAILED', modelId: 'strong', runStats: { turns: 9, toolCalls: 6, tokensUsed: 900, longestNoProgressStreak: 4, duplicateActionsBlocked: 0, modelEscalations: 1 } });
    await engine.setStatus(id, 'failed');

    const live = projectExecutionCard(engine.require(id));

    const restarted = new ExecutionEngine({ load: () => [durable] });
    await restarted.ready;
    const rebuilt = projectExecutionCard(restarted.require(id));

    expect(rebuilt).toEqual(live);
    expect(rebuilt).toMatchObject({
      executionId: id, jobId: 'job-1', taskId: 'task-1', title: 'Fix sort', agentId: 'wazir-coding',
      computerId: 'local', runtimeId: 'lmstudio', modelId: 'strong', phase: 'repair', status: 'failed',
      lastMessage: 'verification failed:', filesChanged: ['sort.cpp'], modelCallCount: 1,
      workspaceRevision: 1, retries: 1, repairPhases: 1, escalations: 1, longestNoProgressStreak: 4,
      verification: { passing: [], failing: ['test'], stale: 1 }, terminationReason: 'VERIFICATION_FAILED',
    });
  });
});
