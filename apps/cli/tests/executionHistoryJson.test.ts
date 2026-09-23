import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '@wazir/core';
import { inspectExecution } from '../src/commands.js';
import type { RookEngine } from '../src/engine.js';

describe('execution inspection JSON', () => {
  it('preserves a valid JSON envelope with sequence and routing identity', async () => {
    const executions = new ExecutionEngine();
    const record = await executions.create({
      task: { id: 'task', type: 'coding', input: 'Fix a defect', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      jobId: 'job', modelId: 'model', runtimeId: 'runtime', computerId: 'computer',
    });
    await executions.recordEvent(record.execution.id, 'retry.scheduled', { attempt: 1 }, { stepId: 'step' });
    const output = await inspectExecution({ executions } as RookEngine, record.execution.id, true);
    const parsed = JSON.parse(output);
    expect(parsed.events.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2]);
    expect(parsed.events[1]).toMatchObject({ eventType: 'retry.scheduled', jobId: 'job', stepId: 'step', workspaceRevision: 0 });
    expect(parsed.events[1].eventId).toBe(parsed.events[1].id);
  });
});
