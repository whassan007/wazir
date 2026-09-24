import { describe, expect, it } from 'vitest';
import { ExecutionEngine, ModelReliabilityTracker } from '@wazir/core';
import { recordTermination } from '../src/termination.js';

/**
 * A run's typed stop condition is persisted as `termination.completed`; the model
 * circuit breaker is derived from those durable events, so a fresh process (new
 * tracker, same execution history) reaches the same circuit state.
 */
describe('recordTermination', () => {
  async function newExecution(executions: ExecutionEngine) {
    const record = await executions.create({
      task: { id: `task-${Math.random()}`, type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      computerId: 'computer', runtimeId: 'runtime', modelId: 'flaky-model',
    });
    return record.execution.id;
  }

  it('persists the reason as an event and rebuilds the same circuit after a restart', async () => {
    const executions = new ExecutionEngine();
    const reliability = new ModelReliabilityTracker({ minSamples: 3 });
    for (const reason of ['NO_PROGRESS', 'REPEATED_ACTION', 'MODEL_PROTOCOL_BUDGET_EXHAUSTED'] as const) {
      const id = await newExecution(executions);
      await recordTermination({ executions, reliability }, id, reason, 'flaky-model', 'coding');
      const events = await executions.events(id);
      expect(events.filter((e) => e.eventType === 'termination.completed').map((e) => (e.data as { reason: string }).reason)).toEqual([reason]);
    }
    expect(reliability.status('flaky-model', 'coding').state).toBe('OPEN');

    const restarted = new ModelReliabilityTracker({ minSamples: 3 });
    restarted.hydrate(await executions.list());
    expect(restarted.status('flaky-model', 'coding').state).toBe('OPEN');
  });

  it('records non-attributable reasons without affecting the circuit', async () => {
    const executions = new ExecutionEngine();
    const reliability = new ModelReliabilityTracker({ minSamples: 1 });
    const id = await newExecution(executions);
    expect(await recordTermination({ executions, reliability }, id, 'CANCELLED', 'flaky-model', 'coding')).toBeNull();
    expect(reliability.status('flaky-model', 'coding').samples).toBe(0);
    expect((await executions.events(id)).some((e) => e.eventType === 'termination.completed')).toBe(true);
  });
});
