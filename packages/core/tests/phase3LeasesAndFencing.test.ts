import { describe, it, expect } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import {
  ExecutionEngine,
  StaleWorkerLeaseError,
} from '../src/services/executionEngine.js';
import { InvalidStatusTransitionError } from '../src/services/statusTransitions.js';
import { persistExecutionRecord } from '../src/services/executionPersistence.js';
import { recordExecution, type ApiState } from '../../../apps/api/src/server.js';
import type { ExecutionRecord, Task } from '../src/types/index.js';

function makeTask(id = 'task-phase3-1'): Task {
  return {
    id,
    title: 'Phase 3 Leases and Fencing Test Task',
    type: 'coding',
    input: 'Verify leases, fencing, and status transition guards',
    priority: 'normal',
    status: 'queued',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('Phase 3 — ExecutionEngine status transition guards (ISS-012)', () => {
  it('rejects pause() on completed, failed, and cancelled executions without mutating state', async () => {
    const engine = new ExecutionEngine();
    for (const terminalStatus of ['completed', 'failed', 'cancelled'] as const) {
      const rec = await engine.create({
        task: makeTask(`task-pause-${terminalStatus}`),
        computerId: 'c1',
        runtimeId: 'r1',
        modelId: 'm1',
      });
      if (terminalStatus === 'completed') {
        await engine.setStatus(rec.execution.id, 'running');
      }
      await engine.setStatus(rec.execution.id, terminalStatus);
      const eventsBefore = (await engine.get(rec.execution.id))!.events.length;

      await expect(engine.pause(rec.execution.id, 'late pause')).rejects.toThrow(
        InvalidStatusTransitionError,
      );

      const after = (await engine.get(rec.execution.id))!;
      expect(after.execution.status).toBe(terminalStatus);
      expect(after.events.length).toBe(eventsBefore);
      expect(engine.isPaused(rec.execution.id)).toBe(false);
    }
  });

  it('rejects resume() on completed, failed, and cancelled executions without mutating state', async () => {
    const engine = new ExecutionEngine();
    for (const terminalStatus of ['completed', 'failed', 'cancelled'] as const) {
      const rec = await engine.create({
        task: makeTask(`task-resume-${terminalStatus}`),
        computerId: 'c1',
        runtimeId: 'r1',
        modelId: 'm1',
      });
      if (terminalStatus === 'completed') {
        await engine.setStatus(rec.execution.id, 'running');
      }
      await engine.setStatus(rec.execution.id, terminalStatus);
      const eventsBefore = (await engine.get(rec.execution.id))!.events.length;

      await expect(engine.resume(rec.execution.id, 'late resume')).rejects.toThrow(
        InvalidStatusTransitionError,
      );

      const after = (await engine.get(rec.execution.id))!;
      expect(after.execution.status).toBe(terminalStatus);
      expect(after.events.length).toBe(eventsBefore);
    }
  });

  it('rejects orphan() on completed and cancelled executions, and makes orphan() idempotent on failed', async () => {
    const engine = new ExecutionEngine();

    for (const terminalStatus of ['completed', 'cancelled'] as const) {
      const rec = await engine.create({
        task: makeTask(`task-orphan-${terminalStatus}`),
        computerId: 'c1',
        runtimeId: 'r1',
        modelId: 'm1',
      });
      if (terminalStatus === 'completed') {
        await engine.setStatus(rec.execution.id, 'running');
      }
      await engine.setStatus(rec.execution.id, terminalStatus);
      const eventsBefore = (await engine.get(rec.execution.id))!.events.length;

      await expect(engine.orphan(rec.execution.id, 'worker vanished')).rejects.toThrow(
        InvalidStatusTransitionError,
      );

      const after = (await engine.get(rec.execution.id))!;
      expect(after.execution.status).toBe(terminalStatus);
      expect(after.events.length).toBe(eventsBefore);
    }

    const active = await engine.create({
      task: makeTask('task-orphan-active'),
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
    });
    await engine.setStatus(active.execution.id, 'running');
    await engine.orphan(active.execution.id, 'heartbeat timeout');

    const failed = (await engine.get(active.execution.id))!;
    expect(failed.execution.status).toBe('failed');
    expect(failed.errors).toEqual(['ORPHANED_WORKER_UNREACHABLE: heartbeat timeout']);
    const eventsAfterFirst = failed.events.length;

    // Second orphan() on already-failed execution is idempotent
    await engine.orphan(active.execution.id, 'heartbeat timeout duplicate');
    const failedAgain = (await engine.get(active.execution.id))!;
    expect(failedAgain.execution.status).toBe('failed');
    expect(failedAgain.errors).toEqual(['ORPHANED_WORKER_UNREACHABLE: heartbeat timeout']);
    expect(failedAgain.events.length).toBe(eventsAfterFirst);
  });

  it('allows valid pause() -> resume() lifecycle transitions on active executions', async () => {
    const engine = new ExecutionEngine();
    const rec = await engine.create({
      task: makeTask('task-pause-resume-ok'),
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
    });
    await engine.setStatus(rec.execution.id, 'running');
    await engine.pause(rec.execution.id, 'operator pause');
    expect((await engine.get(rec.execution.id))!.execution.status).toBe('paused');
    expect(engine.isPaused(rec.execution.id)).toBe(true);

    await engine.resume(rec.execution.id, 'operator resume');
    expect((await engine.get(rec.execution.id))!.execution.status).toBe('running');
    expect(engine.isPaused(rec.execution.id)).toBe(false);
  });
});

describe('Phase 3 — Worker lease lifecycle and stale worker fencing (ISS-014)', () => {
  it('acquires, renews, expires, takes over at incremented epoch, and fences stale worker without mutating in-memory events', async () => {
    const store = new MemoryStore();
    const engine = new ExecutionEngine({
      persist: (record) => persistExecutionRecord(store, `execution/${record.execution.id}`, record),
    });

    const rec = await engine.create({
      task: makeTask('task-lease-fencing'),
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
    });
    const execId = rec.execution.id;
    await engine.setStatus(execId, 'running');

    const t0 = new Date('2026-05-01T00:00:00.000Z');
    const lease1 = await engine.acquireLease(execId, 'worker-a', { ttlMs: 1000, now: t0 });
    expect(lease1.workerId).toBe('worker-a');
    expect(lease1.epoch).toBe(1);

    // Competing worker cannot steal an unexpired lease
    const tMid = new Date('2026-05-01T00:00:00.500Z');
    await expect(
      engine.acquireLease(execId, 'worker-b', { ttlMs: 1000, now: tMid }),
    ).rejects.toThrow(StaleWorkerLeaseError);

    // Active worker renews its lease
    const renewed1 = await engine.renewLease(execId, 'worker-a', {
      leaseEpoch: 1,
      ttlMs: 1000,
      now: tMid,
    });
    expect(renewed1.epoch).toBe(1);
    expect(renewed1.expiresAt.getTime()).toBe(tMid.getTime() + 1000);

    // Lease expires at tMid + 1000; worker-b takes over at tExpired
    const tExpired = new Date('2026-05-01T00:00:02.000Z');
    const lease2 = await engine.acquireLease(execId, 'worker-b', { ttlMs: 5000, now: tExpired });
    expect(lease2.workerId).toBe('worker-b');
    expect(lease2.epoch).toBe(2);

    // Snapshot durable and in-memory state before stale worker attempts mutations
    const durableBefore = structuredClone(await store.get<ExecutionRecord>(`execution/${execId}`))!;
    const inMemoryBefore = structuredClone(await engine.get(execId))!;
    expect(inMemoryBefore.events.length).toBe(durableBefore.events.length);
    expect(inMemoryBefore.storageRevision).toBe(durableBefore.storageRevision);

    // Stale worker-a (epoch 1) must be fenced out of every mutating operation
    await expect(
      engine.renewLease(execId, 'worker-a', { leaseEpoch: 1, ttlMs: 1000, now: tExpired }),
    ).rejects.toThrow(StaleWorkerLeaseError);

    await expect(
      engine.recordEvent(execId, 'tool.started', { tool: 'bash' }, { workerId: 'worker-a', leaseEpoch: 1, now: tExpired }),
    ).rejects.toThrow(StaleWorkerLeaseError);

    await expect(
      engine.recordToolStart(execId, 'bash', { cmd: 'rm -rf' }, { workerId: 'worker-a', leaseEpoch: 1, now: tExpired }),
    ).rejects.toThrow(StaleWorkerLeaseError);

    await expect(
      engine.setResult(execId, 'stale-worker-output', { workerId: 'worker-a', leaseEpoch: 1, now: tExpired }),
    ).rejects.toThrow(StaleWorkerLeaseError);

    await expect(
      engine.setStatus(execId, 'completed', { workerId: 'worker-a', leaseEpoch: 1, now: tExpired }),
    ).rejects.toThrow(StaleWorkerLeaseError);

    // Verify in-memory record.events and durable store were NOT mutated by rejected stale calls
    const inMemoryAfterStale = (await engine.get(execId))!;
    const durableAfterStale = (await store.get<ExecutionRecord>(`execution/${execId}`))!;
    expect(inMemoryAfterStale.events).toEqual(inMemoryBefore.events);
    expect(inMemoryAfterStale.storageRevision).toBe(inMemoryBefore.storageRevision);
    expect(inMemoryAfterStale.result).toBeUndefined();
    expect(inMemoryAfterStale.execution.status).toBe('running');
    expect(inMemoryAfterStale).toEqual(durableAfterStale);

    // Current lease holder (worker-b, epoch 2) succeeds and finalizes execution
    await engine.setResult(execId, 'authoritative-worker-b-output', {
      workerId: 'worker-b',
      leaseEpoch: 2,
      now: tExpired,
    });
    await engine.setStatus(execId, 'completed', {
      workerId: 'worker-b',
      leaseEpoch: 2,
      now: tExpired,
    });
    await engine.releaseLease(execId, 'worker-b', {
      leaseEpoch: 2,
      now: tExpired,
    });

    const completed = (await engine.get(execId))!;
    expect(completed.execution.status).toBe('completed');
    expect(completed.result).toBe('authoritative-worker-b-output');
    expect(engine.getLease(execId)?.released).toBe(true);
  });

  it('reconstructs lease epoch across ExecutionEngine restart and fences stale epochs', async () => {
    const store = new MemoryStore();
    const engine1 = new ExecutionEngine({
      persist: (record) => persistExecutionRecord(store, `execution/${record.execution.id}`, record),
    });

    const rec = await engine1.create({
      task: makeTask('task-lease-restart'),
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
    });
    const execId = rec.execution.id;
    await engine1.setStatus(execId, 'running');

    const t0 = new Date('2026-05-01T00:00:00.000Z');
    await engine1.acquireLease(execId, 'worker-1', { ttlMs: 1000, now: t0 });
    const t1 = new Date('2026-05-01T00:00:02.000Z');
    await engine1.acquireLease(execId, 'worker-2', { ttlMs: 10_000, now: t1 });

    // Restart engine from durable store
    const engine2 = new ExecutionEngine({
      persist: (record) => persistExecutionRecord(store, `execution/${record.execution.id}`, record),
      load: async () => (await store.list('execution/')).map((e) => e.value as ExecutionRecord),
    });
    await engine2.ready;

    const restoredLease = engine2.getLease(execId);
    expect(restoredLease?.workerId).toBe('worker-2');
    expect(restoredLease?.epoch).toBe(2);

    await expect(
      engine2.setResult(execId, 'stale-from-worker-1', { workerId: 'worker-1', leaseEpoch: 1, now: t1 }),
    ).rejects.toThrow(StaleWorkerLeaseError);

    await engine2.setResult(execId, 'fresh-from-worker-2', { workerId: 'worker-2', leaseEpoch: 2, now: t1 });
    expect((await engine2.get(execId))?.result).toBe('fresh-from-worker-2');
  });
});

describe('Phase 3 — API recordExecution durability, existing record updates, and fencing (ISS-014)', () => {
  it('updates an existing non-terminal execution record instead of dropping updates via current ?? ..., and fences stale epochs and terminal overwrites', async () => {
    const store = new MemoryStore();
    const fakeState = {
      store,
      executions: [] as Array<Record<string, unknown>>,
    } as unknown as ApiState;

    // 1. Seed a queued/running execution record in the shared store
    await recordExecution(fakeState, {
      execution: {
        id: 'exec-api-1',
        taskId: 'task-api-1',
        status: 'running',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        leaseEpoch: 2,
      },
      task: makeTask('task-api-1'),
      computerId: 'comp-1',
      modelId: 'm1',
      runtimeId: 'r1',
      leaseEpoch: 2,
    });

    const initial = await store.get<Record<string, unknown>>('execution/exec-api-1');
    expect((initial?.execution as any)?.status).toBe('running');
    expect(initial?.storageRevision).toBe(1);

    // 2. Stale worker at leaseEpoch 1 attempts to record failure — must be fenced out
    await recordExecution(fakeState, {
      execution: {
        id: 'exec-api-1',
        status: 'failed',
        createdAt: new Date('2026-05-01T00:00:01.000Z'),
        leaseEpoch: 1,
      },
      computerId: 'comp-1',
      error: 'stale worker failure',
      leaseEpoch: 1,
    });

    const afterStale = await store.get<Record<string, unknown>>('execution/exec-api-1');
    expect((afterStale?.execution as any)?.status).toBe('running');
    expect(afterStale?.storageRevision).toBe(1);
    expect(afterStale?.errors).toEqual([]);

    // 3. Authoritative worker at leaseEpoch 2 reports completion — updates existing record in-place
    await recordExecution(fakeState, {
      execution: {
        id: 'exec-api-1',
        status: 'completed',
        createdAt: new Date('2026-05-01T00:00:02.000Z'),
        leaseEpoch: 2,
      },
      computerId: 'comp-1',
      result: 'completed output',
      usage: { input: 10, output: 20 },
      leaseEpoch: 2,
    });

    const afterCompletion = await store.get<Record<string, unknown>>('execution/exec-api-1');
    expect((afterCompletion?.execution as any)?.status).toBe('completed');
    expect(afterCompletion?.result).toBe('completed output');
    expect(afterCompletion?.usage).toEqual({ input: 10, output: 20, total: 30 });
    expect(afterCompletion?.storageRevision).toBe(2);

    // 4. Subsequent terminal regression attempt (e.g. failed after completed) is ignored idempotently
    await recordExecution(fakeState, {
      execution: {
        id: 'exec-api-1',
        status: 'failed',
        createdAt: new Date('2026-05-01T00:00:03.000Z'),
        leaseEpoch: 2,
      },
      computerId: 'comp-1',
      error: 'late error after completion',
      leaseEpoch: 2,
    });

    const afterLate = await store.get<Record<string, unknown>>('execution/exec-api-1');
    expect((afterLate?.execution as any)?.status).toBe('completed');
    expect(afterLate?.result).toBe('completed output');
    expect(afterLate?.storageRevision).toBe(2);

    // 5. ExecutionEngine can cleanly load all records written by recordExecution without crashing
    const engine = new ExecutionEngine({
      load: async () => (await store.list('execution/')).map((e) => e.value as ExecutionRecord),
    });
    await engine.ready;
    const loaded = await engine.get('exec-api-1');
    expect(loaded?.execution.status).toBe('completed');
    expect(loaded?.result).toBe('completed output');
    expect(Array.isArray(loaded?.events)).toBe(true);
    expect(Array.isArray(loaded?.toolCalls)).toBe(true);
    expect(Array.isArray(loaded?.checks)).toBe(true);
    expect(Array.isArray(loaded?.policyDecisions)).toBe(true);
  });
});
