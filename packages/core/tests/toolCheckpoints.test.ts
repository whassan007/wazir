import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { hashToolArguments } from '../src/services/toolValidation.js';
import type { ExecutionRecord, ToolCallRecord } from '../src/types/index.js';

async function setup() {
  let durable!: ExecutionRecord;
  const engine = new ExecutionEngine({ persist: r => { durable = structuredClone(r); } });
  const record = await engine.create({ task: { id: 'task', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() }, computerId: 'computer', runtimeId: 'runtime', modelId: 'model' });
  return { engine, id: record.execution.id, durable: () => durable };
}
const result = (id: string, tool: string, ok = true): ToolCallRecord => ({ id, tool, input: {}, ok, policyEffect: 'allow', policyRule: 'test', durationMs: 1, at: new Date() });

describe('call-identified dispatch checkpoints', () => {
  it('a prior denial cannot conceal an unknown dispatched write', async () => {
    const { engine, id, durable } = await setup();
    await engine.recordToolCall(id, { ...result('denied', 'git', false), policyEffect: 'deny' });
    await engine.recordToolStart(id, 'git', { command: 'commit' }, { callId: 'dispatch', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
    expect(engine.findUnknownOutcomeToolCall(id)).toMatchObject({ callId: 'dispatch', tool: 'git' });
    const recovered = new ExecutionEngine({ load: () => [durable()] });
    await recovered.ready;
    expect(recovered.toolCheckpoints(id)).toMatchObject([{ callId: 'dispatch', state: 'OUTCOME_UNKNOWN', sideEffectClass: 'NON_IDEMPOTENT_WRITE' }]);
    await expect(recovered.recordToolStart(id, 'git', { command: 'commit' }, { callId: 'new-id' })).rejects.toThrow('reconciled');
    await expect(recovered.setStatus(id, 'completed')).rejects.toThrow('reconciliation');
  });

  it('pairs parallel read calls by ID when results arrive out of order', async () => {
    const { engine, id } = await setup();
    await engine.recordToolStart(id, 'read', { path: 'a' }, { callId: 'a', sideEffectClass: 'READ_ONLY' });
    await engine.recordToolStart(id, 'read', { path: 'b' }, { callId: 'b', sideEffectClass: 'READ_ONLY' });
    await engine.recordToolCall(id, result('b', 'read'));
    expect(engine.findUnknownOutcomeToolCall(id)?.callId).toBe('a');
    await engine.recordToolCall(id, result('a', 'read'));
    expect(engine.findUnknownOutcomeToolCall(id)).toBeUndefined();
  });

  it('does not replay a previously dispatched call ID', async () => {
    const { engine, id } = await setup();
    await engine.recordToolStart(id, 'git', {}, { callId: 'call' });
    await engine.recordToolCall(id, result('call', 'git'));
    await expect(engine.recordToolStart(id, 'git', {}, { callId: 'call' })).rejects.toThrow('TOOL_ALREADY_DISPATCHED');
  });

  it('retains unknown outcomes after a timeout result and permits read-only reconciliation', async () => {
    const { engine, id } = await setup();
    await engine.recordToolStart(id, 'git', {}, { callId: 'write' });
    await engine.recordToolCall(id, { ...result('write', 'git', false), failureClass: 'TOOL_OUTCOME_UNKNOWN' });
    await engine.recordToolStart(id, 'read', {}, { callId: 'inspect', sideEffectClass: 'READ_ONLY' });
    await engine.recordToolCall(id, result('inspect', 'read'));
    expect(engine.toolCheckpoints(id).map(c => c.state)).toEqual(['OUTCOME_UNKNOWN', 'COMPLETED']);
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow('reconciliation');
  });

  it('hashes normalized arguments without depending on property order', () => {
    expect(hashToolArguments({ a: 1, b: { x: 2, y: 3 } })).toBe(hashToolArguments({ b: { y: 3, x: 2 }, a: 1 }));
    expect(hashToolArguments({ a: 1 })).not.toBe(hashToolArguments({ a: 2 }));
  });
});
