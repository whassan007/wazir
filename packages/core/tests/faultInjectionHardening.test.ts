import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { faultInjector, JsonFileStore, ExecutionFailure } from '@wazir/shared';
import { ExecutionEngine, StaleWorkerLeaseError } from '../src/services/executionEngine.js';
import { CheckpointService } from '../src/services/checkpointService.js';
import { persistExecutionRecord } from '../src/services/executionPersistence.js';
import {
  OperationReconciliationGuard,
  reconstructExecutionState,
  planRecovery,
  extractToolCheckpoints,
  reconcileLocalOutcomes,
} from '../src/services/executionRecovery.js';
import type { ExecutionRecord, ToolCallRecord, Task } from '../src/types/index.js';

/**
 * Workstream 18 — Fault Injection & Resilience Hardening.
 *
 * Every scenario runs against a real JsonFileStore on disk and a fresh
 * ExecutionEngine / CheckpointService per "process", so a restart reads only
 * what was durably committed before the injected fault.
 *
 * 1. Persistence & checkpoint faults (DURING_CHECKPOINT, DURING_STORE_WRITE,
 *    DURING_EVENT_PERSIST, torn/corrupted files)
 * 2. Worker crash & dead owner process recovery
 * 3. Stale worker lease loss & fencing
 * 4. Interrupted tool calls & unknown outcome reconciliation
 */

const DEAD_PID = 2_147_483_000;

function makeTask(id: string): Task {
  return { id, type: 'coding', input: 'fault injection', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() };
}

const worktreeStub: any = {
  isGitRepo: async () => false,
  getCurrentBranch: async () => undefined,
};

describe('Workstream 18: fault injection hardening', () => {
  let tmpDir: string;
  let workspace: string;
  let execFile: string;
  let checkpointFile: string;

  beforeEach(async () => {
    faultInjector.clear();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-fault-'));
    workspace = path.join(tmpDir, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    execFile = path.join(tmpDir, 'executions.json');
    checkpointFile = path.join(tmpDir, 'checkpoints.json');
  });

  afterEach(async () => {
    faultInjector.clear();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  /** A process-scoped engine on the shared durable execution store. */
  function bootEngine(options: { ownerPid?: number; isProcessAlive?: (pid: number) => boolean } = {}) {
    const store = new JsonFileStore(execFile);
    const engine = new ExecutionEngine({
      load: async () => (await store.list('execution/')).map((e) => e.value as ExecutionRecord),
      persist: (record) => persistExecutionRecord(store, `execution/${record.execution.id}`, record),
      owner: { pid: options.ownerPid ?? process.pid, host: os.hostname() },
      isProcessAlive: options.isProcessAlive ?? (() => true),
      workspace,
    });
    return { engine, store };
  }

  async function readDurable(id: string): Promise<ExecutionRecord | undefined> {
    return new JsonFileStore(execFile).get<ExecutionRecord>(`execution/${id}`);
  }

  async function startExecution(engine: ExecutionEngine, taskId: string) {
    await engine.ready;
    const record = await engine.create({
      task: makeTask(taskId),
      computerId: 'comp-1',
      runtimeId: 'rt-1',
      modelId: 'model-1',
      workspaceRoot: workspace,
    });
    await engine.setStatus(record.execution.id, 'running');
    return record.execution.id;
  }

  // ===========================================================================
  // 1. PERSISTENCE & CHECKPOINT FAULT INJECTION
  // ===========================================================================
  describe('1. persistence & checkpoint faults', () => {
    it('DURING_CHECKPOINT fault aborts cleanly: nothing registered in memory or committed to the store, and a retry commits a valid checkpoint', async () => {
      const { engine } = bootEngine();
      const executionId = await startExecution(engine, 'task-chk-fault');
      await fs.writeFile(path.join(workspace, 'a.ts'), 'export const a = 1;\n');

      const checkpointStore = new JsonFileStore(checkpointFile);
      const service = new CheckpointService({
        store: checkpointStore,
        executionEngine: engine,
        worktreeManager: worktreeStub,
        defaultWorkspaceRoot: workspace,
      });
      await service.ready;

      const seen: Array<Record<string, unknown>> = [];
      faultInjector.register({
        point: 'DURING_CHECKPOINT',
        match: (ctx) => ctx.executionId === executionId,
        action: {
          type: 'custom',
          handler: (ctx) => {
            seen.push({ ...ctx });
            throw new Error('CHECKPOINT_IO_FAILURE: injected');
          },
        },
      });

      await expect(service.checkpoint(executionId, { description: 'doomed' })).rejects.toThrow('CHECKPOINT_IO_FAILURE');
      expect(faultInjector.getTriggeredCount('DURING_CHECKPOINT')).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0].checkpointId).toMatch(/^chk-/);
      expect(seen[0].workspaceRevision).toBe(0);

      // No partial checkpoint anywhere: memory, live store, or a fresh reader of the file.
      expect(service.listCheckpoints(executionId)).toHaveLength(0);
      expect(service.getCheckpoint(seen[0].checkpointId as string)).toBeUndefined();
      expect(await checkpointStore.list('checkpoint/')).toHaveLength(0);
      expect(await new JsonFileStore(checkpointFile).list('checkpoint/')).toHaveLength(0);
      // No checkpoint event leaked into the execution's history either.
      const events = await engine.events(executionId);
      expect(events.some((e) => e.type === 'execution.checkpoint.created')).toBe(false);

      // The fault was one-shot: the retry commits a complete, digest-valid checkpoint.
      const committed = await service.checkpoint(executionId, { description: 'retry' });
      expect(committed.worktreeState.filesSnapshot).toHaveProperty('a.ts');

      const restarted = new CheckpointService({
        store: new JsonFileStore(checkpointFile),
        executionEngine: engine,
        worktreeManager: worktreeStub,
        defaultWorkspaceRoot: workspace,
      });
      await expect(restarted.ready).resolves.toBeUndefined();
      const restored = restarted.listCheckpoints(executionId);
      expect(restored.map((c) => c.id)).toEqual([committed.id]);
      expect(restored[0].description).toBe('retry');
    });

    it('DURING_STORE_WRITE fault on checkpoint persistence keeps the previously committed file intact and leaves no half-registered checkpoint', async () => {
      const { engine } = bootEngine();
      const executionId = await startExecution(engine, 'task-chk-store-fault');
      await fs.writeFile(path.join(workspace, 'b.ts'), 'export const b = 1;\n');

      const service = new CheckpointService({
        store: new JsonFileStore(checkpointFile),
        executionEngine: engine,
        worktreeManager: worktreeStub,
        defaultWorkspaceRoot: workspace,
      });
      const first = await service.checkpoint(executionId, { description: 'first' });
      const bytesBefore = await fs.readFile(checkpointFile, 'utf8');

      await fs.writeFile(path.join(workspace, 'b.ts'), 'export const b = 2;\n');
      faultInjector.register({
        point: 'DURING_STORE_WRITE',
        match: (ctx) => ctx.filePath === checkpointFile,
        action: { type: 'kill_process', exitCode: 137 },
      });

      await expect(service.checkpoint(executionId, { description: 'second' })).rejects.toThrow(
        'CRASH_SIMULATION: Process hard kill (exit 137) at DURING_STORE_WRITE',
      );

      // The temp file was fsynced but never renamed: the committed file is byte-identical.
      expect(await fs.readFile(checkpointFile, 'utf8')).toBe(bytesBefore);
      expect(service.listCheckpoints(executionId).map((c) => c.id)).toEqual([first.id]);

      const restarted = new CheckpointService({
        store: new JsonFileStore(checkpointFile),
        executionEngine: engine,
        worktreeManager: worktreeStub,
        defaultWorkspaceRoot: workspace,
      });
      await restarted.ready;
      const restored = restarted.listCheckpoints(executionId);
      expect(restored.map((c) => c.id)).toEqual([first.id]);
      expect(restored[0].worktreeState.filesSnapshot['b.ts']).toContain('b = 1');
    });

    it('JsonFileStore put/update interrupted at DURING_STORE_WRITE never commits the mutation and releases the lock for the next writer', async () => {
      const store = new JsonFileStore(path.join(tmpDir, 'kv.json'));
      await store.put('counter', { n: 1 });
      await store.put('other', { keep: true });

      faultInjector.register({
        point: 'DURING_STORE_WRITE',
        action: { type: 'throw', error: 'ENOSPC: injected write failure' },
        maxTimes: 2,
      });

      await expect(store.update<{ n: number }>('counter', (cur) => ({ n: (cur?.n ?? 0) + 100 }))).rejects.toThrow('ENOSPC');
      await expect(store.put('counter', { n: 999 })).rejects.toThrow('ENOSPC');
      expect(faultInjector.getTriggeredCount('DURING_STORE_WRITE')).toBe(2);

      // Both the live instance and a fresh reader observe only the committed value.
      expect(await store.get('counter')).toEqual({ n: 1 });
      const reader = new JsonFileStore(path.join(tmpDir, 'kv.json'));
      expect(await reader.get('counter')).toEqual({ n: 1 });
      expect(await reader.get('other')).toEqual({ keep: true });

      // The file lock was released: the next writer proceeds from the committed state.
      const next = await store.update<{ n: number }>('counter', (cur) => ({ n: (cur?.n ?? 0) + 1 }));
      expect(next).toEqual({ n: 2 });
      expect(await reader.get('counter')).toEqual({ n: 2 });
    });

    it('a torn store file or a tampered checkpoint envelope is rejected on restore instead of being silently erased or trusted', async () => {
      const { engine } = bootEngine();
      const executionId = await startExecution(engine, 'task-chk-torn');
      await fs.writeFile(path.join(workspace, 'c.ts'), 'export const c = 1;\n');

      const service = new CheckpointService({
        store: new JsonFileStore(checkpointFile),
        executionEngine: engine,
        worktreeManager: worktreeStub,
        defaultWorkspaceRoot: workspace,
      });
      const checkpoint = await service.checkpoint(executionId);
      const good = await fs.readFile(checkpointFile, 'utf8');

      // Partial write: the file is truncated mid-document.
      await fs.writeFile(checkpointFile, good.slice(0, Math.floor(good.length / 2)));
      const tornReader = new JsonFileStore(checkpointFile);
      await expect(tornReader.list('checkpoint/')).rejects.toThrow();
      const tornService = new CheckpointService({
        store: new JsonFileStore(checkpointFile),
        executionEngine: engine,
        worktreeManager: worktreeStub,
        defaultWorkspaceRoot: workspace,
        lazy: true,
      });
      await expect(tornService.ready).rejects.toThrow();
      // Corruption is surfaced, never "repaired" by overwriting with an empty map.
      expect(await fs.readFile(checkpointFile, 'utf8')).toBe(good.slice(0, Math.floor(good.length / 2)));

      // Tampered payload: valid JSON, but the snapshot no longer matches its digest.
      const doc = JSON.parse(good);
      doc[`checkpoint/${checkpoint.id}`].checkpoint.worktreeState.filesSnapshot['c.ts'] = 'export const c = 666;\n';
      await fs.writeFile(checkpointFile, JSON.stringify(doc));
      const tamperedService = new CheckpointService({
        store: new JsonFileStore(checkpointFile),
        executionEngine: engine,
        worktreeManager: worktreeStub,
        defaultWorkspaceRoot: workspace,
        lazy: true,
      });
      await expect(tamperedService.ready).rejects.toThrow(`CHECKPOINT_DIGEST_MISMATCH: checkpoint/${checkpoint.id}`);

      // Structurally partial envelope (snapshot missing).
      delete doc[`checkpoint/${checkpoint.id}`].checkpoint.worktreeState;
      await fs.writeFile(checkpointFile, JSON.stringify(doc));
      const partialService = new CheckpointService({
        store: new JsonFileStore(checkpointFile),
        executionEngine: engine,
        worktreeManager: worktreeStub,
        defaultWorkspaceRoot: workspace,
        lazy: true,
      });
      await expect(partialService.ready).rejects.toThrow(`INVALID_CHECKPOINT: checkpoint/${checkpoint.id}`);
    });

    it('DURING_EVENT_PERSIST fault latches the engine and the durable record stays at the last committed storage revision', async () => {
      const { engine } = bootEngine();
      const executionId = await startExecution(engine, 'task-event-persist');
      const before = await readDurable(executionId);
      expect(before?.execution.status).toBe('running');

      faultInjector.register({
        point: 'DURING_EVENT_PERSIST',
        match: (ctx) => ctx.executionId === executionId,
        action: { type: 'throw', error: 'EVENT_LOG_UNAVAILABLE' },
      });

      await expect(
        engine.recordToolStart(executionId, 'write_file', { path: 'x.ts' }, { callId: 'call-latched', sideEffectClass: 'NON_IDEMPOTENT_WRITE' }),
      ).rejects.toThrow('EVENT_LOG_UNAVAILABLE');

      // The engine refuses all further writes rather than diverging from durable state.
      expect(engine.persistenceError?.message).toBe('EVENT_LOG_UNAVAILABLE');
      await expect(engine.recordError(executionId, 'later write')).rejects.toThrow('EVENT_LOG_UNAVAILABLE');

      const after = await readDurable(executionId);
      expect(after?.storageRevision).toBe(before?.storageRevision);
      expect(after?.events.length).toBe(before?.events.length);
      expect(after?.events.some((e) => e.type === 'tool.started')).toBe(false);

      // A restarted engine sees a consistent record with no phantom dispatch and can continue.
      const { engine: restarted } = bootEngine();
      await restarted.ready;
      expect(restarted.toolCheckpoints(executionId)).toHaveLength(0);
      await restarted.recordToolStart(executionId, 'write_file', { path: 'x.ts' }, { callId: 'call-after-restart', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
      expect((await readDurable(executionId))?.storageRevision).toBe((before?.storageRevision ?? 0) + 1);
    });
  });

  // ===========================================================================
  // 2. WORKER CRASH & DEAD OWNER PROCESS RECOVERY
  // ===========================================================================
  describe('2. worker crash & dead owner process recovery', () => {
    it.each(['running', 'assigned'] as const)(
      "an execution left '%s' by a dead owner pid is failed with OWNER_PROCESS_EXITED by the next engine on the same store",
      async (status) => {
        const { engine: crashed } = bootEngine({ ownerPid: DEAD_PID });
        await crashed.ready;
        const record = await crashed.create({
          task: makeTask(`task-orphan-${status}`),
          computerId: 'comp-1', runtimeId: 'rt-1', modelId: 'model-1', workspaceRoot: workspace,
        });
        const executionId = record.execution.id;
        await crashed.setStatus(executionId, status);
        expect((await readDurable(executionId))?.execution.owner?.pid).toBe(DEAD_PID);

        const probed: number[] = [];
        const { engine: survivor } = bootEngine({
          isProcessAlive: (pid) => {
            probed.push(pid);
            return false;
          },
        });
        await survivor.ready;

        expect(probed).toContain(DEAD_PID);
        const recovered = await survivor.get(executionId);
        expect(recovered?.execution.status).toBe('failed');
        expect(recovered?.execution.completedAt).toBeInstanceOf(Date);
        expect(recovered?.errors.some((e) => e.startsWith(`INTERRUPTED: owning process ${DEAD_PID} exited while this execution was ${status}`))).toBe(true);

        const failure = recovered?.events.filter((e) => e.type === 'execution.failed') ?? [];
        expect(failure).toHaveLength(1);
        expect(failure[0].data).toMatchObject({ status: 'failed', reason: 'OWNER_PROCESS_EXITED', ownerPid: DEAD_PID, previousStatus: status });

        // The transition and its audit event were durably persisted and claimed by the survivor.
        const durable = await readDurable(executionId);
        expect(durable?.execution.status).toBe('failed');
        expect(durable?.execution.owner?.pid).toBe(process.pid);
        expect(durable?.events.at(-1)?.type).toBe('execution.failed');

        // Deterministic: a further restart does not fail it twice or append more events.
        const { engine: again } = bootEngine({ isProcessAlive: () => false });
        await again.ready;
        const replayed = await again.get(executionId);
        expect(replayed?.events.length).toBe(durable?.events.length);
        expect(replayed?.events.filter((e) => e.type === 'execution.failed')).toHaveLength(1);
        expect(planRecovery(reconstructExecutionState(replayed!, again.toolCheckpoints(executionId))).action).toBe('none');
      },
    );

    it('a live foreign owner is left untouched while a crashed owner mid-write leaves a durable unknown-outcome call for review', async () => {
      const { engine: liveOwner } = bootEngine({ ownerPid: DEAD_PID - 1 });
      const liveId = await startExecution(liveOwner, 'task-live-owner');
      await liveOwner.recordToolStart(liveId, 'write_file', { path: 'live.ts' }, { callId: 'call-live', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });

      const { engine: crashed } = bootEngine({ ownerPid: DEAD_PID });
      const deadId = await startExecution(crashed, 'task-dead-owner');
      await crashed.recordToolStart(deadId, 'write_file', { path: 'dead.ts' }, { callId: 'call-dead', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });

      const { engine: survivor } = bootEngine({ isProcessAlive: (pid) => pid === DEAD_PID - 1 });
      await survivor.ready;

      // Live owner's in-flight work is its own: no status change, no unknown-outcome marking.
      const live = await survivor.get(liveId);
      expect(live?.execution.status).toBe('running');
      expect(survivor.toolCheckpoints(liveId).find((c) => c.callId === 'call-live')?.state).toBe('STARTED');
      expect(live?.events.some((e) => e.type === 'tool.unknownOutcome')).toBe(false);

      // Dead owner's execution is failed and its dispatched write flagged OUTCOME_UNKNOWN.
      const dead = await survivor.get(deadId);
      expect(dead?.execution.status).toBe('failed');
      expect(survivor.toolCheckpoints(deadId).find((c) => c.callId === 'call-dead')?.state).toBe('OUTCOME_UNKNOWN');
      expect(survivor.findUnknownOutcomeToolCall(deadId)).toMatchObject({ callId: 'call-dead', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
      const types = dead!.events.map((e) => e.type);
      expect(types.indexOf('tool.unknownOutcome')).toBeGreaterThan(-1);
      expect(types.indexOf('execution.failed')).toBeGreaterThan(types.indexOf('tool.unknownOutcome'));

      // Even a terminal execution may not report completion with an unresolved write.
      await expect(survivor.setStatus(deadId, 'completed')).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 3. STALE WORKER LEASE LOSS & FENCING
  // ===========================================================================
  describe('3. stale worker lease loss & fencing', () => {
    it('after Worker B takes over an expired lease, every delayed Worker A mutation is rejected with STALE_WORKER_LEASE before touching state', async () => {
      const { engine } = bootEngine();
      const executionId = await startExecution(engine, 'task-lease-steal');
      const t0 = new Date();

      const leaseA = await engine.acquireLease(executionId, 'worker-A', { ttlMs: 1_000, now: t0 });
      expect(leaseA.epoch).toBe(1);

      // While A's lease is live, B cannot steal it.
      await expect(engine.acquireLease(executionId, 'worker-B', { ttlMs: 60_000, now: new Date(t0.getTime() + 500) }))
        .rejects.toBeInstanceOf(StaleWorkerLeaseError);

      // A stalls (GC pause, partition) past expiry; B takes over at epoch 2.
      const leaseB = await engine.acquireLease(executionId, 'worker-B', { ttlMs: 600_000, now: new Date(t0.getTime() + 2_000) });
      expect(leaseB.epoch).toBe(2);
      expect(leaseB.token).not.toBe(leaseA.token);

      const durableBefore = await readDurable(executionId);
      const eventsBefore = (await engine.events(executionId)).length;
      const staleA = { workerId: 'worker-A', leaseEpoch: 1, leaseToken: leaseA.token };

      const toolCall: ToolCallRecord = {
        id: 'call-late-A', callId: 'call-late-A', tool: 'write_file', input: { path: 'late.ts' },
        ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 5, at: new Date(),
      };
      const delayed: Array<[string, () => Promise<unknown>]> = [
        ['recordToolStart', () => engine.recordToolStart(executionId, 'write_file', { path: 'late.ts' }, { callId: 'call-late-A', sideEffectClass: 'NON_IDEMPOTENT_WRITE', ...staleA })],
        ['recordToolCall', () => engine.recordToolCall(executionId, toolCall, staleA)],
        ['recordError', () => engine.recordError(executionId, 'late error from A', staleA)],
        ['setStatus', () => engine.setStatus(executionId, 'failed', staleA)],
        ['renewLease', () => engine.renewLease(executionId, 'worker-A', { leaseEpoch: 1, leaseToken: leaseA.token, ttlMs: 60_000 })],
        ['releaseLease', () => engine.releaseLease(executionId, 'worker-A', { leaseEpoch: 1, leaseToken: leaseA.token })],
      ];

      for (const [name, op] of delayed) {
        const err = await op().then(() => undefined, (e) => e);
        expect(err, name).toBeInstanceOf(StaleWorkerLeaseError);
        expect(err.code, name).toBe('STALE_WORKER_LEASE');
        expect(err.executionId, name).toBe(executionId);
        expect(err.currentWorkerId, name).toBe('worker-B');
        expect(err.currentEpoch, name).toBe(2);
      }

      // Zero side effects from the fenced worker: in memory and on disk.
      expect((await engine.events(executionId)).length).toBe(eventsBefore);
      expect(engine.toolCheckpoints(executionId)).toHaveLength(0);
      const after = await engine.get(executionId);
      expect(after?.execution.status).toBe('running');
      expect(after?.toolCalls).toHaveLength(0);
      expect(after?.errors).toHaveLength(0);
      const durableAfter = await readDurable(executionId);
      expect(durableAfter?.storageRevision).toBe(durableBefore?.storageRevision);

      // Worker B, the rightful holder, proceeds normally.
      const claimB = { workerId: 'worker-B', leaseEpoch: 2, leaseToken: leaseB.token };
      await engine.recordToolStart(executionId, 'write_file', { path: 'b.ts' }, { callId: 'call-B', sideEffectClass: 'NON_IDEMPOTENT_WRITE', ...claimB });
      expect(engine.toolCheckpoints(executionId).map((c) => c.callId)).toEqual(['call-B']);
    });

    it('a forged claim mixing the current epoch with a stale token, or the right worker with a stale epoch, is fenced', async () => {
      const { engine } = bootEngine();
      const executionId = await startExecution(engine, 'task-lease-forged');
      const t0 = new Date();
      const leaseA = await engine.acquireLease(executionId, 'worker-A', { ttlMs: 1_000, now: t0 });
      const leaseB = await engine.acquireLease(executionId, 'worker-B', { ttlMs: 600_000, now: new Date(t0.getTime() + 5_000) });

      const forged = [
        { workerId: 'worker-B', leaseEpoch: 2, leaseToken: leaseA.token },
        { workerId: 'worker-B', leaseEpoch: 1, leaseToken: leaseB.token },
        { workerId: 'worker-A', leaseEpoch: 2, leaseToken: leaseB.token },
        { leaseToken: leaseA.token },
      ];
      for (const claim of forged) {
        const err = await engine
          .recordToolStart(executionId, 'shell', { cmd: 'rm -rf build' }, { sideEffectClass: 'NON_IDEMPOTENT_WRITE', ...claim })
          .then(() => undefined, (e) => e);
        expect(err, JSON.stringify(claim)).toBeInstanceOf(StaleWorkerLeaseError);
        expect(err.code).toBe('STALE_WORKER_LEASE');
      }
      expect(engine.toolCheckpoints(executionId)).toHaveLength(0);
    });

    it('lease fencing survives a controller restart: epochs are rebuilt from durable lease events and Worker A stays fenced', async () => {
      const { engine } = bootEngine();
      const executionId = await startExecution(engine, 'task-lease-restart');
      const t0 = new Date();
      const leaseA = await engine.acquireLease(executionId, 'worker-A', { ttlMs: 1_000, now: t0 });
      const leaseB = await engine.acquireLease(executionId, 'worker-B', { ttlMs: 600_000, now: new Date(t0.getTime() + 2_000) });

      const { engine: restarted } = bootEngine();
      await restarted.ready;
      const rebuilt = restarted.getLease(executionId);
      expect(rebuilt).toMatchObject({ workerId: 'worker-B', epoch: 2, token: leaseB.token, released: false });

      const err = await restarted
        .recordToolCall(executionId, {
          id: 'call-zombie', callId: 'call-zombie', tool: 'git_commit', input: { message: 'zombie' },
          ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 1, at: new Date(),
        }, { workerId: 'worker-A', leaseEpoch: 1, leaseToken: leaseA.token })
        .then(() => undefined, (e) => e);
      expect(err).toBeInstanceOf(StaleWorkerLeaseError);
      expect(err.code).toBe('STALE_WORKER_LEASE');
      expect((await restarted.get(executionId))?.toolCalls).toHaveLength(0);

      // Reconstructed state agrees on the holder.
      const { state } = restarted.reconstruct(executionId);
      expect(state.lease).toMatchObject({ holder: 'worker-B', state: 'acquired' });

      // B releases; afterwards even B's old token is fenced and a new epoch is required.
      await restarted.releaseLease(executionId, 'worker-B', { leaseEpoch: 2, leaseToken: leaseB.token });
      await expect(restarted.setStatus(executionId, 'failed', { workerId: 'worker-B', leaseEpoch: 2, leaseToken: leaseB.token }))
        .rejects.toBeInstanceOf(StaleWorkerLeaseError);
      const leaseC = await restarted.acquireLease(executionId, 'worker-C', { ttlMs: 600_000 });
      expect(leaseC.epoch).toBe(3);
    });
  });

  // ===========================================================================
  // 4. INTERRUPTED TOOL CALLS & UNKNOWN OUTCOME RECONCILIATION
  // ===========================================================================
  describe('4. interrupted tool calls & unknown outcome reconciliation', () => {
    /** Dispatch a write, optionally land its physical effect, then crash before the result persists. */
    async function crashMidWrite(taskId: string, applyOnDisk: boolean) {
      const { engine } = bootEngine();
      const executionId = await startExecution(engine, taskId);
      const input = { path: 'feature.ts', content: 'export const feature = true;\n' };
      const callId = await engine.recordToolStart(executionId, 'write_file', input, { callId: `call-${taskId}`, sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
      if (applyOnDisk) await fs.writeFile(path.join(workspace, input.path), input.content);

      faultInjector.register({
        point: 'AFTER_TOOL_EXECUTION_BEFORE_PERSIST',
        match: (ctx) => ctx.callId === callId,
        action: { type: 'kill_process', exitCode: 137 },
      });
      await expect(engine.recordToolCall(executionId, {
        id: callId, callId, tool: 'write_file', input, ok: true,
        policyEffect: 'allow', policyRule: 'default', durationMs: 3, at: new Date(),
      })).rejects.toThrow('CRASH_SIMULATION');
      faultInjector.clear();
      return { executionId, callId, input };
    }

    async function inspectWrite(input: { path: string; content: string }) {
      const actual = await fs.readFile(path.join(workspace, input.path), 'utf8').catch(() => undefined);
      return actual === input.content
        ? { outcome: 'APPLIED' as const, evidence: `${input.path} contains the expected bytes` }
        : { outcome: 'NOT_APPLIED' as const, evidence: `${input.path} is absent` };
    }

    it('write applied on disk before the crash: recovery demands reconciliation, records APPLIED, and the guard blocks a duplicate mutation', async () => {
      const { executionId, callId, input } = await crashMidWrite('task-write-applied', true);

      const { engine } = bootEngine();
      await engine.ready;
      const checkpoints = engine.toolCheckpoints(executionId);
      expect(checkpoints.find((c) => c.callId === callId)?.state).toBe('OUTCOME_UNKNOWN');

      const state = reconstructExecutionState((await engine.get(executionId))!, checkpoints);
      expect(state.terminal).toBe(false);
      expect(state.unresolvedToolCalls).toEqual([expect.objectContaining({ callId, toolName: 'write_file', sideEffectClass: 'NON_IDEMPOTENT_WRITE', state: 'OUTCOME_UNKNOWN' })]);
      const plan = planRecovery(state);
      expect(plan.action).toBe('reconcile');
      expect(plan.reasons[0]).toContain('must not be replayed blindly');

      // Blind replay and premature completion are both refused.
      await expect(engine.recordToolStart(executionId, 'write_file', input, { sideEffectClass: 'NON_IDEMPOTENT_WRITE' }))
        .rejects.toBeInstanceOf(ExecutionFailure);
      await expect(engine.recordToolStart(executionId, 'write_file', input, { callId, sideEffectClass: 'NON_IDEMPOTENT_WRITE' }))
        .rejects.toThrow('TOOL_ALREADY_DISPATCHED');
      await expect(engine.setStatus(executionId, 'completed')).rejects.toThrow('Completion requires reconciliation');
      await expect(engine.reconcileToolCall(executionId, callId, { outcome: 'UNDETERMINED', evidence: 'disk unreadable', inspectedBy: 'test' }))
        .rejects.toThrow(ExecutionFailure);

      // Physical inspection proves the mutation landed.
      const inspection = await inspectWrite(input);
      expect(inspection.outcome).toBe('APPLIED');
      await engine.reconcileToolCall(executionId, callId, { ...inspection, inspectedBy: 'fault-suite' });

      const record = (await engine.get(executionId))!;
      const reconciled = engine.toolCheckpoints(executionId);
      expect(reconciled.find((c) => c.callId === callId)?.state).toBe('COMPLETED');
      expect(planRecovery(reconstructExecutionState(record, reconciled)).action).toBe('resume');

      // The idempotency guard rebuilt from durable facts refuses to re-issue the write,
      // whether retried under the same callId or a fresh one at the same revision.
      const guard = OperationReconciliationGuard.fromExecutionRecord(record, reconciled);
      const sameCall = guard.checkDuplicateOperation({ executionId, callId, toolName: 'write_file', input, workspaceRevision: 0 });
      expect(sameCall).toMatchObject({ duplicate: true, reason: 'DUPLICATE_CALL_ID' });
      const retry = guard.checkDuplicateOperation({ executionId, callId: 'call-retry', toolName: 'write_file', input, workspaceRevision: 0 });
      expect(retry).toMatchObject({ duplicate: true, reason: 'DUPLICATE_SEMANTIC_OPERATION' });
      expect(retry.receipt?.callId).toBe(callId);

      // Durable: a second restart reads the same reconciled outcome from disk.
      const durable = (await readDurable(executionId))!;
      expect(extractToolCheckpoints(durable).find((c) => c.callId === callId)?.state).toBe('COMPLETED');
      expect(await fs.readFile(path.join(workspace, input.path), 'utf8')).toBe(input.content);
    });

    it('write NOT applied before the crash: reconciliation records NOT_APPLIED and a safe retry is permitted', async () => {
      const { executionId, callId, input } = await crashMidWrite('task-write-not-applied', false);

      const { engine } = bootEngine();
      await engine.ready;
      expect(planRecovery(engine.reconstruct(executionId).state).action).toBe('reconcile');

      const inspection = await inspectWrite(input);
      expect(inspection.outcome).toBe('NOT_APPLIED');
      await engine.reconcileToolCall(executionId, callId, { ...inspection, inspectedBy: 'fault-suite' });

      const checkpoints = engine.toolCheckpoints(executionId);
      expect(checkpoints.find((c) => c.callId === callId)?.state).toBe('FAILED');
      const { plan } = engine.reconstruct(executionId);
      expect(plan.action).toBe('resume');

      const guard = OperationReconciliationGuard.fromExecutionRecord((await engine.get(executionId))!, checkpoints);
      expect(guard.checkDuplicateOperation({ executionId, callId: 'call-retry', toolName: 'write_file', input, workspaceRevision: 0 }).duplicate).toBe(false);

      // Retry is admitted exactly once and actually performs the mutation.
      const retryId = await engine.recordToolStart(executionId, 'write_file', input, { callId: 'call-retry', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
      await fs.writeFile(path.join(workspace, input.path), input.content);
      await engine.recordToolCall(executionId, {
        id: retryId, callId: retryId, tool: 'write_file', input, ok: true,
        policyEffect: 'allow', policyRule: 'default', durationMs: 2, at: new Date(),
      });
      const final = engine.toolCheckpoints(executionId);
      expect(final.map((c) => [c.callId, c.state])).toEqual([[callId, 'FAILED'], ['call-retry', 'COMPLETED']]);
      expect(engine.findUnknownOutcomeToolCall(executionId)).toBeUndefined();
    });

    it('an interrupted read-only call never blocks recovery or writes, unlike an interrupted write', async () => {
      const { engine: crashed } = bootEngine();
      const executionId = await startExecution(crashed, 'task-read-interrupted');
      await crashed.recordToolStart(executionId, 'read_file', { path: 'README.md' }, { callId: 'call-read', sideEffectClass: 'READ_ONLY' });

      const { engine } = bootEngine();
      await engine.ready;
      const checkpoints = engine.toolCheckpoints(executionId);
      expect(checkpoints.find((c) => c.callId === 'call-read')?.state).toBe('OUTCOME_UNKNOWN');

      const state = reconstructExecutionState((await engine.get(executionId))!, checkpoints);
      expect(state.unresolvedToolCalls).toHaveLength(1);
      const plan = planRecovery(state);
      expect(plan.action).toBe('resume');
      expect(plan.reasons.join(' ')).toContain('1 interrupted read-only call(s) have no side effect and may simply be repeated');

      // A write may proceed despite the unresolved read, and the read can be repeated.
      await expect(engine.recordToolStart(executionId, 'write_file', { path: 'ok.ts' }, { callId: 'call-write-ok', sideEffectClass: 'NON_IDEMPOTENT_WRITE' }))
        .resolves.toBe('call-write-ok');
      await expect(engine.recordToolStart(executionId, 'read_file', { path: 'README.md' }, { callId: 'call-read-again', sideEffectClass: 'READ_ONLY' }))
        .resolves.toBe('call-read-again');
    });

    it('startup reconciliation inspects physical state per call: proven outcomes resolve, unprovable ones keep blocking', async () => {
      const { engine: crashed } = bootEngine();
      const appliedId = await startExecution(crashed, 'task-recon-applied');
      const unknownId = await startExecution(crashed, 'task-recon-unknown');
      const appliedInput = { path: 'applied.ts', content: 'applied\n' };
      await crashed.recordToolStart(appliedId, 'write_file', appliedInput, { callId: 'call-applied', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
      await fs.writeFile(path.join(workspace, appliedInput.path), appliedInput.content);
      await crashed.recordToolStart(unknownId, 'deploy', { env: 'prod' }, { callId: 'call-deploy', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });

      const { engine } = bootEngine();
      await engine.ready;
      const results = await reconcileLocalOutcomes(engine, async (_record, call) => {
        if (call.toolName === 'write_file') return inspectWrite(call.input as { path: string; content: string });
        return { outcome: 'UNDETERMINED', evidence: 'remote deploy state unavailable' };
      });

      expect(results).toContainEqual({ executionId: appliedId, callId: 'call-applied', outcome: 'APPLIED' });
      expect(results.some((r) => r.callId === 'call-deploy')).toBe(false);

      expect(engine.reconstruct(appliedId).plan.action).toBe('resume');
      const blocked = engine.reconstruct(unknownId);
      expect(blocked.plan.action).toBe('reconcile');
      expect(blocked.state.unresolvedToolCalls.map((c) => c.callId)).toEqual(['call-deploy']);
      await expect(engine.recordToolStart(unknownId, 'deploy', { env: 'prod' }, { callId: 'call-deploy-2', sideEffectClass: 'NON_IDEMPOTENT_WRITE' }))
        .rejects.toThrow('A prior write must be reconciled');
    });
  });
});
