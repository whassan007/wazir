import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { faultInjector, JsonFileStore, MemoryStore, type KeyValueStore } from '@wazir/shared';
import {
  GOAL_STORE_KEYS,
  GoalStudioFailure,
  idempotencyKey,
  type GoalGraphRevisionRecord,
  type GoalStudioEvent,
  type TargetAttempt,
} from '../../src/contracts.js';
import {
  createEventLog,
  createGoalEventLog,
  createGoalLedgerStore,
  createLedgerStore,
  GLOBAL_EVENT_STREAM,
} from '../../src/ledger/index.js';

function makeSampleGraphRevision(): GoalGraphRevisionRecord {
  return {
    graphId: 'graph-1',
    projectId: 'proj-1',
    revision: 1,
    digest: 'sha256:abc123',
    createdAt: '2026-10-22T00:00:00.000Z',
    createdBy: 'operator:wael',
    definition: {
      schemaVersion: '1.0',
      name: 'Reliability Test Graph',
      constitution: {
        objectiveOwner: 'human',
        invariants: ['never self-certify'],
        resourceLimits: {
          maxTasksPerRun: 20,
          maxRepairsPerTask: 3,
          maxSameActionNoProgress: 2,
          maxRunMinutes: 60,
          hostedSpendUsd: 5,
          localModelFirst: true,
          maxConcurrentWritersPerWorktree: 1,
          maxConcurrentTargets: 2,
        },
        allowedUnattended: ['test'],
        needsApproval: ['deploy'],
      },
      targets: [
        {
          id: 'T1',
          stage: 'build',
          title: 'Root target 1',
          dependsOn: [],
          priority: 100,
          executor: 'coder',
          artifacts: ['dist/a.js'],
          acceptance: ['tests pass'],
        },
        {
          id: 'T2',
          stage: 'build',
          title: 'Root target 2',
          dependsOn: [],
          priority: 80,
          executor: 'coder',
          artifacts: ['dist/b.js'],
          acceptance: ['lint pass'],
        },
        {
          id: 'T3',
          stage: 'verify',
          title: 'Dependent target 3',
          dependsOn: ['T1', 'T2'],
          priority: 50,
          executor: 'verifier',
          artifacts: ['reports/verify.json'],
          acceptance: ['all green'],
        },
      ],
      executionGraph: {
        entry: 'plan',
        nodes: [{ id: 'plan', next: ['execute'] }, { id: 'execute', next: [] }],
      },
    },
  };
}

describe('GoalLedgerStore & GoalEventLog', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    faultInjector.clear();
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeJsonStore(): Promise<{ store: JsonFileStore; file: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-goal-ledger-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'store.json');
    return { store: new JsonFileStore(file), file };
  }

  it('exports createLedgerStore and createEventLog aliases matching createGoalLedgerStore / createGoalEventLog', () => {
    const store = new MemoryStore();
    const l1 = createLedgerStore({ store, workspaceRoot: '/tmp' });
    const l2 = createGoalLedgerStore({ store, workspaceRoot: '/tmp' });
    const e1 = createEventLog({ store, workspaceRoot: '/tmp' }, { pollIntervalMs: 0 });
    const e2 = createGoalEventLog({ store, workspaceRoot: '/tmp' }, { pollIntervalMs: 0 });
    expect(typeof l1.createRun).toBe('function');
    expect(typeof l2.createRun).toBe('function');
    expect(typeof e1.append).toBe('function');
    expect(typeof e2.append).toBe('function');
    e1.close();
    e2.close();
  });

  it('creates a run with root targets initialized as eligible and dependent targets as queued', async () => {
    const store = new MemoryStore();
    let nowMs = Date.parse('2026-10-22T12:00:00.000Z');
    const ledgerStore = createLedgerStore({
      store,
      workspaceRoot: '/tmp',
      clock: () => new Date(nowMs),
    });

    const graph = makeSampleGraphRevision();
    const run = await ledgerStore.createRun({
      graph,
      createdBy: 'user:alice',
      runId: 'run-init-1',
    });

    expect(run.runId).toBe('run-init-1');
    expect(run.graphId).toBe('graph-1');
    expect(run.graphRevision).toBe(1);
    expect(run.graphDigest).toBe('sha256:abc123');
    expect(run.status).toBe('created');
    expect(run.ledgerRevision).toBe(1);
    expect(run.targets.T1.status).toBe('eligible');
    expect(run.targets.T2.status).toBe('eligible');
    expect(run.targets.T3.status).toBe('queued');
    expect(run.resource.startedAt).toBe('2026-10-22T12:00:00.000Z');
    expect(run.resource.deadlineAt).toBe('2026-10-22T13:00:00.000Z');

    // Duplicate runId should reject with DUPLICATE
    await expect(
      ledgerStore.createRun({ graph, createdBy: 'user:alice', runId: 'run-init-1' }),
    ).rejects.toMatchObject({
      name: 'GoalStudioFailure',
      code: 'DUPLICATE',
    });

    const loaded = await ledgerStore.getRun('run-init-1');
    expect(loaded).toEqual(run);

    const listed = await ledgerStore.listRuns({ graphId: 'graph-1', status: 'created' });
    expect(listed).toHaveLength(1);
    expect(listed[0].runId).toBe('run-init-1');
  });

  it('enforces optimistic concurrency on commit (LEDGER_CONFLICT on revision mismatch) and records transitions atomically', async () => {
    const store = new MemoryStore();
    let nowMs = Date.parse('2026-10-22T12:00:00.000Z');
    const ledgerStore = createLedgerStore({
      store,
      workspaceRoot: '/tmp',
      clock: () => new Date(nowMs),
    });

    const graph = makeSampleGraphRevision();
    const run = await ledgerStore.createRun({ graph, createdBy: 'user:alice', runId: 'run-cas-1' });
    const lease = await ledgerStore.acquireLease('run-cas-1', 'worker-a', 30_000);
    expect(lease).toBeDefined();
    expect(lease!.epoch).toBe(1);

    nowMs += 1_000;
    const updated = await ledgerStore.commit(
      'run-cas-1',
      run.ledgerRevision,
      lease!,
      (draft) => {
        draft.status = 'running';
        draft.targets.T1.status = 'active';
        draft.targets.T1.attempts = 1;
        draft.resource.tasksStarted = 1;
      },
      [
        {
          runId: 'run-cas-1',
          targetId: 'T1',
          fromState: 'eligible',
          toState: 'active',
          reason: 'dispatched T1',
          actor: 'controller',
          timestamp: new Date(nowMs).toISOString(),
        },
      ],
    );

    expect(updated.ledgerRevision).toBe(2);
    expect(updated.status).toBe('running');
    expect(updated.targets.T1.status).toBe('active');

    // Committing again with stale expectedRevision (1 instead of 2) throws LEDGER_CONFLICT
    await expect(
      ledgerStore.commit(
        'run-cas-1',
        1,
        lease!,
        (draft) => {
          draft.targets.T2.status = 'active';
        },
        [
          {
            runId: 'run-cas-1',
            targetId: 'T2',
            fromState: 'eligible',
            toState: 'active',
            reason: 'stale revision attempt',
            actor: 'controller',
            timestamp: new Date(nowMs).toISOString(),
          },
        ],
      ),
    ).rejects.toMatchObject({
      name: 'GoalStudioFailure',
      code: 'LEDGER_CONFLICT',
      retryable: true,
    });

    // Verify transition history
    const t1Transitions = await ledgerStore.transitions('run-cas-1', 'T1');
    expect(t1Transitions).toHaveLength(1);
    expect(t1Transitions[0]).toMatchObject({
      runId: 'run-cas-1',
      targetId: 'T1',
      fromState: 'eligible',
      toState: 'active',
      actor: 'controller',
    });

    // Rejects invalid transition chain when target status changes without matching transition
    await expect(
      ledgerStore.commit(
        'run-cas-1',
        2,
        lease!,
        (draft) => {
          draft.targets.T1.status = 'completed';
        },
        [],
      ),
    ).rejects.toMatchObject({
      name: 'GoalStudioFailure',
      code: 'VALIDATION',
    });
  });

  it('enforces worker lease fencing (STALE_LEASE when older epoch holder attempts to commit or renew after takeover)', async () => {
    const store = new MemoryStore();
    let nowMs = Date.parse('2026-10-22T12:00:00.000Z');
    const ledgerStore = createLedgerStore({
      store,
      workspaceRoot: '/tmp',
      clock: () => new Date(nowMs),
    });

    const graph = makeSampleGraphRevision();
    const run = await ledgerStore.createRun({ graph, createdBy: 'user:alice', runId: 'run-fence-1' });

    // Worker A acquires epoch 1
    const leaseA = await ledgerStore.acquireLease('run-fence-1', 'worker-a', 10_000);
    expect(leaseA).toBeDefined();
    expect(leaseA!.epoch).toBe(1);

    // Worker B cannot acquire while Worker A's lease is live
    const blockedB = await ledgerStore.acquireLease('run-fence-1', 'worker-b', 10_000);
    expect(blockedB).toBeUndefined();

    // Advance clock past Worker A's lease TTL
    nowMs += 15_000;

    // Worker A attempting to commit with expired lease gets STALE_LEASE (retryable before takeover)
    await expect(
      ledgerStore.commit('run-fence-1', run.ledgerRevision, leaseA!, (d) => {
        d.status = 'running';
      }, []),
    ).rejects.toMatchObject({
      name: 'GoalStudioFailure',
      code: 'STALE_LEASE',
      retryable: true,
    });

    // Worker B now takes over and receives strictly higher epoch 2
    const leaseB = await ledgerStore.acquireLease('run-fence-1', 'worker-b', 10_000);
    expect(leaseB).toBeDefined();
    expect(leaseB!.epoch).toBe(2);
    expect(leaseB!.holderId).toBe('worker-b');

    // Worker A (stale epoch 1) attempts to renew or commit -> fenced off with STALE_LEASE (non-retryable)
    await expect(ledgerStore.renewLease(leaseA!, 10_000)).rejects.toMatchObject({
      name: 'GoalStudioFailure',
      code: 'STALE_LEASE',
      retryable: false,
    });

    await expect(
      ledgerStore.commit(
        'run-fence-1',
        run.ledgerRevision,
        leaseA!,
        (d) => {
          d.status = 'running';
        },
        [],
      ),
    ).rejects.toMatchObject({
      name: 'GoalStudioFailure',
      code: 'STALE_LEASE',
      retryable: false,
    });

    // Releasing stale leaseA is a safe no-op and does NOT release Worker B's active lease
    await ledgerStore.releaseLease(leaseA!);

    // Worker B can renew and commit cleanly
    nowMs += 5_000;
    const renewedB = await ledgerStore.renewLease(leaseB!, 10_000);
    expect(renewedB.epoch).toBe(2);

    const committedByB = await ledgerStore.commit(
      'run-fence-1',
      run.ledgerRevision,
      renewedB,
      (d) => {
        d.status = 'running';
      },
      [],
    );
    expect(committedByB.ledgerRevision).toBe(2);
    expect(committedByB.status).toBe('running');

    // Releasing Worker B's lease prevents further commits under epoch 2
    await ledgerStore.releaseLease(renewedB);
    await expect(
      ledgerStore.commit('run-fence-1', 2, renewedB, (d) => {
        d.status = 'paused';
      }, []),
    ).rejects.toMatchObject({
      name: 'GoalStudioFailure',
      code: 'STALE_LEASE',
    });
  });

  it.each([
    ['MemoryStore', async () => ({ store: new MemoryStore() as KeyValueStore, reopen: async (s: KeyValueStore) => s })],
    [
      'JsonFileStore',
      async () => {
        const { store, file } = await makeJsonStore();
        return { store: store as KeyValueStore, reopen: async () => new JsonFileStore(file) as KeyValueStore };
      },
    ],
  ])(
    'guarantees once(key, effect) idempotency and crash reconciliation across restarts (%s)',
    async (_label, factory) => {
      const { store, reopen } = await factory();
      const nowMs = Date.parse('2026-10-22T12:00:00.000Z');
      const ledger1 = createLedgerStore(
        { store, workspaceRoot: '/tmp', clock: () => new Date(nowMs) },
        { instanceId: 'inst-1', isProcessAlive: () => false },
      );

      const key = idempotencyKey('run-1', 'T1', 1, 'EXECUTE');
      let sideEffects = 0;

      const first = await ledger1.once(key, async () => {
        sideEffects += 1;
        return { executionId: 'exec-101', ok: true };
      });
      expect(first).toEqual({
        result: { executionId: 'exec-101', ok: true },
        replayed: false,
      });
      expect(sideEffects).toBe(1);

      // Verify stored under GOAL_STORE_KEYS.idempotency(key)
      const rawRecord = await store.get(GOAL_STORE_KEYS.idempotency(key));
      expect(rawRecord).toBeDefined();

      // Re-invoking on same instance replays without executing effect
      const second = await ledger1.once(key, async () => {
        sideEffects += 1;
        return { executionId: 'exec-999', ok: false };
      });
      expect(second).toEqual({
        result: { executionId: 'exec-101', ok: true },
        replayed: true,
      });
      expect(sideEffects).toBe(1);

      // Simulate restart with a fresh store instance (re-reads disk for JsonFileStore)
      const storeAfterRestart = await reopen(store);
      const ledger2 = createLedgerStore(
        { store: storeAfterRestart, workspaceRoot: '/tmp', clock: () => new Date(nowMs + 5_000) },
        { instanceId: 'inst-2', isProcessAlive: () => false },
      );

      const third = await ledger2.once(key, async () => {
        sideEffects += 1;
        return { executionId: 'exec-should-not-run', ok: false };
      });
      expect(third).toEqual({
        result: { executionId: 'exec-101', ok: true },
        replayed: true,
      });
      expect(sideEffects).toBe(1);

      // Simulate a crash AFTER effect ran but BEFORE outcome was recorded
      const crashKey = idempotencyKey('run-1', 'T2', 1, 'EXECUTE');
      let crashEffectRuns = 0;
      faultInjector.register({
        point: 'AFTER_EFFECT_BEFORE_RECORD',
        match: (ctx) => ctx.key === crashKey,
        action: { type: 'kill_process', exitCode: 9 },
      });

      await expect(
        ledger1.once(crashKey, async () => {
          crashEffectRuns += 1;
          return { executionId: 'exec-crashed', ok: true };
        }),
      ).rejects.toThrow(/CRASH_SIMULATION/);
      expect(crashEffectRuns).toBe(1);

      // After restart, a blind replay of an in-flight crashed effect is blocked until reconciled
      const pending = await ledger2.pendingEffects('run-1:');
      expect(pending).toHaveLength(1);
      expect(pending[0].key).toBe(crashKey);
      expect(pending[0].ownerAlive).toBe(false);

      await expect(
        ledger2.once(crashKey, async () => {
          crashEffectRuns += 1;
          return { executionId: 'exec-duplicate', ok: true };
        }),
      ).rejects.toMatchObject({
        name: 'GoalStudioFailure',
        code: 'DUPLICATE',
        retryable: false,
      });
      expect(crashEffectRuns).toBe(1);

      // Reconcile as applied -> subsequent once() replays reconciled result without re-running effect
      await ledger2.reconcileEffect(
        crashKey,
        { outcome: 'applied', result: { executionId: 'exec-crashed', ok: true } },
        'recovery',
      );
      const afterReconcile = await ledger2.once(crashKey, async () => {
        crashEffectRuns += 1;
        return { executionId: 'exec-never', ok: false };
      });
      expect(afterReconcile).toEqual({
        result: { executionId: 'exec-crashed', ok: true },
        replayed: true,
      });
      expect(crashEffectRuns).toBe(1);
    },
  );

  it('persists and queries target attempts deterministically and protects finished attempts from mutation', async () => {
    const store = new MemoryStore();
    const ledgerStore = createLedgerStore({ store, workspaceRoot: '/tmp' });

    const attempt1: TargetAttempt = {
      id: 'att-1',
      runId: 'run-att',
      targetId: 'T1',
      attempt: 1,
      phase: 'EXECUTE',
      executionId: 'exec-1',
      startedAt: '2026-10-22T12:00:00.000Z',
    };
    await ledgerStore.saveAttempt(attempt1);

    // Update phase and finish attempt1
    const finished1: TargetAttempt = {
      ...attempt1,
      phase: 'COMMIT_PROGRESS',
      endedAt: '2026-10-22T12:01:00.000Z',
      outcome: 'succeeded',
    };
    await ledgerStore.saveAttempt(finished1);

    // Idempotent re-save of identical finished attempt succeeds
    await ledgerStore.saveAttempt(finished1);

    // Attempting to rewrite outcome of finished attempt throws LEDGER_CONFLICT
    await expect(
      ledgerStore.saveAttempt({ ...finished1, outcome: 'failed' }),
    ).rejects.toMatchObject({
      name: 'GoalStudioFailure',
      code: 'LEDGER_CONFLICT',
    });

    const list = await ledgerStore.attempts('run-att', 'T1');
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(finished1);
  });

  it('allocates monotonic per-run event sequence numbers, supports read(runId, afterSeq) and live subscribe', async () => {
    const { store, file } = await makeJsonStore();
    const log1 = createEventLog({ store, workspaceRoot: '/tmp' }, { pollIntervalMs: 0 });

    const receivedLive: GoalStudioEvent[] = [];
    const unsubscribe = log1.subscribe('run-ev-1', (ev) => {
      receivedLive.push(ev);
    });

    const e1 = await log1.append({
      type: 'run.created',
      runId: 'run-ev-1',
      data: { graphId: 'graph-1' },
    });
    const e2 = await log1.append({
      type: 'target.transition',
      runId: 'run-ev-1',
      targetId: 'T1',
      data: { from: 'eligible', to: 'active' },
    });
    const e3 = await log1.append({
      type: 'target.phase',
      runId: 'run-ev-1',
      targetId: 'T1',
      attemptId: 'att-1',
      data: { phase: 'EXECUTE' },
    });
    // Event on global stream (no runId) gets its own independent sequence starting at 1
    const globalEv = await log1.append({
      type: 'graph.revision',
      data: { graphId: 'graph-1', revision: 1 },
    });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
    expect(globalEv.seq).toBe(1);

    const allEvents = await log1.read('run-ev-1');
    expect(allEvents.map((e) => e.seq)).toEqual([1, 2, 3]);

    const after1 = await log1.read('run-ev-1', 1);
    expect(after1.map((e) => e.seq)).toEqual([2, 3]);

    const limited = await log1.read('run-ev-1', 0, 2);
    expect(limited.map((e) => e.seq)).toEqual([1, 2]);

    const globalRead = await log1.read(GLOBAL_EVENT_STREAM, 0);
    expect(globalRead).toHaveLength(1);
    expect(globalRead[0].type).toBe('graph.revision');

    // Wait briefly for async drain to deliver live subscribed events
    await new Promise((r) => setTimeout(r, 25));
    expect(receivedLive.map((e) => e.seq)).toEqual([1, 2, 3]);
    unsubscribe();
    log1.close();

    // Simulate process restart with new JsonFileStore and verify subscribeFrom(afterSeq) and monotonic continuation
    const store2 = new JsonFileStore(file);
    const log2 = createEventLog({ store: store2, workspaceRoot: '/tmp' }, { pollIntervalMs: 0 });
    const replayedAndLive: GoalStudioEvent[] = [];
    const unsub2 = log2.subscribeFrom('run-ev-1', 2, (ev) => {
      replayedAndLive.push(ev);
    });

    const e4 = await log2.append({
      type: 'run.status',
      runId: 'run-ev-1',
      data: { status: 'completed' },
    });
    expect(e4.seq).toBe(4);

    await new Promise((r) => setTimeout(r, 25));
    expect(replayedAndLive.map((e) => e.seq)).toEqual([3, 4]);
    unsub2.call(undefined);
    log2.close();
  });

  it('recovers unmaterialised transition batches and event heads after mid-commit crashes', async () => {
    const store = new MemoryStore();
    const ledger = createLedgerStore({ store, workspaceRoot: '/tmp' });
    const eventLog = createEventLog({ store, workspaceRoot: '/tmp' }, { pollIntervalMs: 0 });

    const graph = makeSampleGraphRevision();
    const run = await ledger.createRun({ graph, createdBy: 'user:alice', runId: 'run-crash-batch' });
    const lease = await ledger.acquireLease('run-crash-batch', 'worker-a', 30_000);

    // Crash immediately after envelope commit before per-seq transition keys are materialised
    faultInjector.register({
      point: 'AFTER_LEDGER_COMMIT',
      action: { type: 'kill_process', exitCode: 9 },
    });

    await expect(
      ledger.commit(
        'run-crash-batch',
        run.ledgerRevision,
        lease!,
        (d) => {
          d.status = 'running';
          d.targets.T1.status = 'active';
        },
        [
          {
            runId: 'run-crash-batch',
            targetId: 'T1',
            fromState: 'eligible',
            toState: 'active',
            reason: 'crash mid-materialise',
            actor: 'controller',
            timestamp: '2026-10-22T12:00:01.000Z',
          },
        ],
      ),
    ).rejects.toThrow(/CRASH_SIMULATION/);

    // Even before the next commit, transitions() reads the unmaterialised batch from the envelope
    const transitionsAfterCrash = await ledger.transitions('run-crash-batch');
    expect(transitionsAfterCrash).toHaveLength(1);
    expect(transitionsAfterCrash[0].toState).toBe('active');

    // Crash during event persistence after head update
    faultInjector.register({
      point: 'DURING_EVENT_PERSIST',
      action: { type: 'kill_process', exitCode: 9 },
    });

    await expect(
      eventLog.append({
        type: 'run.status',
        runId: 'run-crash-batch',
        data: { status: 'running' },
      }),
    ).rejects.toThrow(/CRASH_SIMULATION/);

    // Event is still readable without gaps from head.recent
    const eventsAfterCrash = await eventLog.read('run-crash-batch', 0);
    expect(eventsAfterCrash).toHaveLength(1);
    expect(eventsAfterCrash[0].seq).toBe(1);
    eventLog.close();
  });
});
