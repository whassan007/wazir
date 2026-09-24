import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '@wazir/core';
import { explainCommand, listExecutionEvents } from '../src/commands.js';

/** Phase 22: `wa explain <execution>` and `wa executions events <id>` project durable facts. */
async function setup() {
  const executions = new ExecutionEngine();
  const { execution } = await executions.create({
    task: { id: 'task', type: 'coding', input: 'fix the sort', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
    computerId: 'local', runtimeId: 'lmstudio', modelId: 'weak',
  });
  const id = execution.id;
  await executions.recordProviderEvent(id, { type: 'retry', error: 'x', failureClass: 'TIMEOUT', retryAttempt: 1, retryDelayMs: 250 }, { requestId: 'req-1', model: 'weak', provider: 'lmstudio' });
  await executions.recordEvent(id, 'model.route.changed', { previousModel: 'weak', newModel: 'strong', accepted: true, failureClass: 'NO_PROGRESS', reason: '6 calls with no new information', routeDecision: "scheduler: coding capability: present; re-placed to 'rt-b' on 'local', ready now" });
  await executions.recordEvent(id, 'termination.completed', { reason: 'VERIFICATION_PASSED', modelId: 'strong' });
  const engine = { executions, blocks: undefined } as never;
  return { engine, id };
}

describe('wa explain <execution>', () => {
  it('text output answers why retry, why model change and why it stopped', async () => {
    const { engine, id } = await setup();
    const { code, output } = await explainCommand(engine, id);
    expect(code).toBe(0);
    expect(output).toContain('Why retries');
    expect(output).toContain('TIMEOUT from lmstudio/weak; backed off 250ms');
    expect(output).toContain('Why the model changed');
    expect(output).toContain('weak -> strong after NO_PROGRESS: 6 calls with no new information');
    expect(output).toContain("re-placed to 'rt-b'");
    expect(output).toContain('Why it stopped');
    expect(output).toContain('VERIFICATION_PASSED on strong');
  });

  it('--json stays valid JSON with the existing fields plus decisions', async () => {
    const { engine, id } = await setup();
    const parsed = JSON.parse((await explainCommand(engine, id, true)).output);
    expect(parsed.id).toBe(id);
    expect(parsed.task.id).toBe('task');
    expect(parsed.decisions.escalations[0]).toMatchObject({ previousModel: 'weak', newModel: 'strong', accepted: true });
    expect(parsed.decisions.termination.reason).toBe('VERIFICATION_PASSED');
  });
});

describe('wa executions events <id>', () => {
  it('lists events in sequence order, filters by type prefix, and --json is valid', async () => {
    const { engine, id } = await setup();
    const text = (await listExecutionEvents(engine, id)).output;
    const types = [...text.matchAll(/Z {2}([a-z._]+)/g)].map((m) => m[1]);
    expect(types).toEqual(expect.arrayContaining(['retry.scheduled', 'model.route.changed', 'termination.completed']));
    expect(types.indexOf('retry.scheduled')).toBeLessThan(types.indexOf('termination.completed'));

    const filtered = JSON.parse((await listExecutionEvents(engine, id, { json: true, type: 'model.' })).output);
    expect(filtered.events.map((e: { eventType: string }) => e.eventType)).toEqual(['model.route.changed']);
    const seqs = JSON.parse((await listExecutionEvents(engine, id, { json: true })).output).events.map((e: { sequence: number }) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => a - b));
  });

  it('reports an unknown execution with a non-zero code', async () => {
    const { engine } = await setup();
    expect((await listExecutionEvents(engine, 'nope-does-not-exist')).code).toBe(1);
  });
});
