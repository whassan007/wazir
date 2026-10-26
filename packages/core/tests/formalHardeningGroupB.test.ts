import { afterEach, describe, expect, it } from 'vitest';
import { faultInjector, MemoryStore } from '@wazir/shared';
import { ExecutionEngine, StaleWorkerLeaseError } from '../src/services/executionEngine.js';
import { persistExecutionRecord } from '../src/services/executionPersistence.js';
import { InvalidStatusTransitionError } from '../src/services/statusTransitions.js';
import type { ExecutionRecord, Task } from '../src/types/index.js';

const task: Task = {
  id: 'group-b-task', type: 'coding', input: 'Lease regression',
  requirements: { capabilities: [] }, priority: 'normal', status: 'pending', createdAt: new Date(),
};

function setup() {
  const store = new MemoryStore();
  const engine = new ExecutionEngine({
    persist: record => persistExecutionRecord(store, `execution/${record.execution.id}`, record),
  });
  return { store, engine };
}

async function createRunning(engine: ExecutionEngine) {
  const record = await engine.create({ task, computerId: 'computer', runtimeId: 'runtime', modelId: 'model' });
  await engine.setStatus(record.execution.id, 'running');
  return record.execution.id;
}

afterEach(() => faultInjector.clear());

describe('Group B lease fencing', () => {
  it('rejects an older or missing epoch even with the next storage revision', async () => {
    const { store, engine } = setup();
    const id = await createRunning(engine);
    const t0 = new Date();
    await engine.acquireLease(id, 'worker-a', { ttlMs: 1000, now: t0 });
    const old = structuredClone((await store.get<ExecutionRecord>(`execution/${id}`))!);
    await engine.acquireLease(id, 'worker-b', { ttlMs: 10_000, now: new Date(t0.getTime() + 2000) });
    const current = (await store.get<ExecutionRecord>(`execution/${id}`))!;

    for (const incomingEpoch of [old.execution.leaseEpoch, undefined]) {
      const stale = structuredClone(old);
      stale.execution.leaseEpoch = incomingEpoch;
      stale.storageRevision = (current.storageRevision ?? 0) + 1;
      await expect(persistExecutionRecord(store, `execution/${id}`, stale)).rejects.toThrow('STALE_WORKER_LEASE');
    }
    expect((await store.get<ExecutionRecord>(`execution/${id}`))?.execution.workerId).toBe('worker-b');
  });

  it('fences a delayed tool start after lease takeover', async () => {
    const { store, engine } = setup();
    const id = await createRunning(engine);
    const t0 = new Date();
    const leaseA = await engine.acquireLease(id, 'worker-a', { ttlMs: 1000, now: t0 });
    let entered!: () => void;
    const atFault = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    faultInjector.register({
      point: 'BEFORE_TOOL_EXECUTION',
      action: { type: 'custom', handler: async () => { entered(); await gate; } },
    });
    const delayed = engine.recordToolStart(id, 'read', {}, {
      workerId: leaseA.workerId, leaseEpoch: leaseA.epoch, leaseToken: leaseA.token, now: t0,
    });
    await atFault;
    await engine.acquireLease(id, 'worker-b', { ttlMs: 10_000, now: new Date(t0.getTime() + 2000) });
    resume();
    await expect(delayed).rejects.toThrow(StaleWorkerLeaseError);
    expect((await store.get<ExecutionRecord>(`execution/${id}`))?.events.filter(e => e.type === 'tool.started')).toHaveLength(0);
  });

  it('keeps the current lease on stale release attempts', async () => {
    const { engine } = setup();
    const id = await createRunning(engine);
    const t0 = new Date();
    const old = await engine.acquireLease(id, 'worker-a', { ttlMs: 1000, now: t0 });
    const current = await engine.acquireLease(id, 'worker-b', { ttlMs: 10_000, now: new Date(t0.getTime() + 2000) });
    await expect(engine.releaseLease(id, old.workerId, { leaseToken: old.token, now: new Date(t0.getTime() + 2000) })).rejects.toThrow(StaleWorkerLeaseError);
    await expect(engine.releaseLease(id, current.workerId, old.token, new Date(t0.getTime() + 2000))).rejects.toThrow(StaleWorkerLeaseError);
    expect(engine.getLease(id)?.released).toBe(false);
  });

  it('fences cancellation and preserves terminal status monotonicity', async () => {
    const { engine } = setup();
    const id = await createRunning(engine);
    const lease = await engine.acquireLease(id, 'worker-b', { ttlMs: 10_000 });
    await expect(engine.cancelExecution(id, { expectedWorkerId: 'worker-a' })).rejects.toThrow(StaleWorkerLeaseError);
    await expect(engine.cancelExecution(id, { expectedWorkerId: lease.workerId, leaseToken: 'stale' })).rejects.toThrow(StaleWorkerLeaseError);
    expect((await engine.get(id))?.execution.status).toBe('running');
    await engine.cancelExecution(id, { expectedWorkerId: lease.workerId, leaseToken: lease.token, expectedEpoch: lease.epoch });
    expect((await engine.get(id))?.execution.status).toBe('cancelled');
    await expect(engine.setStatus(id, 'running')).rejects.toThrow(InvalidStatusTransitionError);
  });
});
