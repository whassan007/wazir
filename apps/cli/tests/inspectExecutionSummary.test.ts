import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '@wazir/core';
import { inspectExecution } from '../src/commands.js';

describe('wa executions inspect — summary projection', () => {
  async function setup() {
    const executions = new ExecutionEngine();
    const { execution } = await executions.create({
      task: { id: 'task', type: 'coding', input: 'fix the sort', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      computerId: 'c', runtimeId: 'r', modelId: 'm',
    });
    await executions.recordEvent(execution.id, 'termination.completed', { reason: 'NO_PROGRESS', modelId: 'm' });
    return { engine: { executions } as never, id: execution.id };
  }

  it('--json stays valid JSON, keeps the record fields and adds summary', async () => {
    const { engine, id } = await setup();
    const parsed = JSON.parse(await inspectExecution(engine, id, true));
    expect(parsed.execution.id).toBe(id);
    expect(parsed.summary).toMatchObject({ executionId: id, terminationReason: 'NO_PROGRESS', models: ['m'] });
  });

  it('text output includes the summary block', async () => {
    const { engine, id } = await setup();
    const text = await inspectExecution(engine, id, false);
    expect(text).toContain('Summary:');
    expect(text).toContain('termination: NO_PROGRESS');
  });
});
