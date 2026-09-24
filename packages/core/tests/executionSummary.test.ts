import { describe, expect, it } from 'vitest';
import { summarizeExecution } from '../src/services/executionSummary.js';
import { ExecutionEngine, type ExecutionRecord } from '@wazir/core';

const t = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms);

describe('summarizeExecution', () => {
  it('derives the time breakdown and counts from durable facts', () => {
    let seq = 0;
    const ev = (type: string, ms: number, data?: unknown) => ({ id: `e${seq}`, executionId: 'x', type, eventType: type, sequence: ++seq, timestamp: t(ms), data });
    const record = {
      execution: { id: 'x', jobId: 'job-1', taskId: 't', runtimeId: 'lmstudio', computerId: 'local', modelId: 'weak', status: 'completed', createdAt: t(0), startedAt: t(0), completedAt: t(20_000) },
      task: { type: 'coding' },
      policyDecisions: [{ decision: 'allow' }, { decision: 'allow' }, { decision: 'deny' }],
      toolCalls: [{ ok: true, durationMs: 300 }, { ok: false, durationMs: 700 }, { ok: true, durationMs: 2000 }],
      checks: [{ name: 'build', ok: false, durationMs: 1500 }, { name: 'build', ok: true, durationMs: 400 }],
      filesChanged: ['main.cpp'],
      usage: { input: 1200, output: 300 },
      context: { finalInputTokens: 5000 },
      workspaceState: { revision: 3 },
      events: [
        ev('generation.started', 0), ev('retry.scheduled', 100, { delay: 500 }), ev('generation.completed', 3000),
        ev('agent.turn', 3001, { content: 'INVALID_JSON_ACTION: model response did not parse' }),
        ev('generation.started', 4000), ev('generation.completed', 6000),
        ev('agent.turn', 6001, { content: "ACTION_BLOCKED_DUPLICATE: 'shell' repeated 3 times" }),
        ev('agent.phase', 6002, { phase: 'repair' }),
        ev('model.route.changed', 6003, { accepted: false, previousModel: 'weak', newModel: null }),
        ev('model.route.changed', 6004, { accepted: true, previousModel: 'weak', newModel: 'strong' }),
        ev('generation.started', 7000), // never completed
        ev('termination.completed', 19_000, { reason: 'VERIFICATION_PASSED', modelId: 'strong' }),
      ],
    } as unknown as ExecutionRecord;

    const summary = summarizeExecution(record);

    expect(summary).toMatchObject({
      executionId: 'x', jobId: 'job-1', models: ['weak', 'strong'], terminationReason: 'VERIFICATION_PASSED',
      durations: { totalMs: 20_000, modelInferenceMs: 4500, retryBackoffMs: 500, toolMs: 3000, verificationMs: 1900, unattributedMs: 12_000 },
      counts: {
        modelRequests: 3, unfinishedModelRequests: 1, toolCalls: 3, failedToolCalls: 1, duplicateActionsBlocked: 1,
        invalidActions: 1, repairPhases: 1, retries: 1, escalations: 1, checks: 2, failedChecks: 1,
        policy: { allow: 2, deny: 1, ask: 0 },
      },
      tokens: { input: 1200, output: 300, total: 1500 },
      contextTokens: 5000, workspaceRevision: 3, filesChanged: 1,
    });
  });

  it('contains no prompt, tool input or output content', () => {
    const secret = 'sk-SECRET-token-in-tool-output';
    const record = {
      execution: { id: 'x', runtimeId: 'r', modelId: 'm', status: 'running', createdAt: t(0) },
      task: { type: 'coding', input: secret },
      policyDecisions: [], checks: [], filesChanged: [],
      toolCalls: [{ ok: true, durationMs: 1, input: { command: secret }, output: secret }],
      events: [{ id: '1', executionId: 'x', type: 'agent.turn', timestamp: t(1), data: { content: secret } }],
    } as unknown as ExecutionRecord;
    const summary = summarizeExecution(record);
    expect(JSON.stringify(summary)).not.toContain(secret);
    expect(summary.durations.totalMs).toBeNull();
  });

  it('reads the event shapes the real ExecutionEngine writes', async () => {
    const engine = new ExecutionEngine();
    const { execution } = await engine.create({
      task: { id: 'task', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      computerId: 'c', runtimeId: 'r', modelId: 'm',
    });
    const id = execution.id;
    await engine.recordEvent(id, 'generation.started', { modelId: 'm' });
    await engine.recordProviderEvent(id, { type: 'retry', error: 'x', failureClass: 'RATE_LIMIT', retryAttempt: 1, retryDelayMs: 250 }, { requestId: 'req-1', model: 'm' });
    await engine.recordEvent(id, 'generation.completed');
    await engine.recordPolicy(id, { tool: 'read', decision: 'allow', rule: 'r', reasons: [] } as never);
    await engine.recordToolCall(id, { id: 'c1', tool: 'read', input: {}, ok: true, policyEffect: 'allow', policyRule: 'r', durationMs: 12, at: new Date() });
    await engine.recordCheck(id, { name: 'build', command: 'make', ok: true, output: '', durationMs: 40, workspaceRevision: 0 });
    await engine.recordEvent(id, 'termination.completed', { reason: 'VERIFICATION_PASSED', modelId: 'm' });

    const summary = summarizeExecution(engine.require(id));
    expect(summary.counts).toMatchObject({ modelRequests: 1, unfinishedModelRequests: 0, retries: 1, toolCalls: 1, checks: 1, policy: { allow: 1, deny: 0, ask: 0 } });
    expect(summary.durations).toMatchObject({ retryBackoffMs: 250, toolMs: 12, verificationMs: 40 });
    expect(summary.terminationReason).toBe('VERIFICATION_PASSED');
  });
});
