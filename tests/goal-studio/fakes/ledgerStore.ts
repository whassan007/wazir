/**
 * Reference in-memory GoalLedgerStore (any KeyValueStore). Satisfies
 * describeGoalLedgerStoreContract. Atomicity is an in-process mutex shared by
 * all instances over the same store object; it is not a cross-process lock.
 */
import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import {
  GOAL_STORE_KEYS,
  type GoalGraphRevisionRecord,
  type GoalLedgerStore,
  type GoalRunId,
  type GoalRunLedger,
  type GoalRunStatus,
  type GraphId,
  type IdempotencyKey,
  type RunLease,
  type TargetAttempt,
  type TargetId,
  type TargetTransition,
} from '../../../packages/goals/src/contracts.js';
import { clone, fail, getIso, listIso, mutexFor, systemClock, type Clock } from './util.js';

interface StoredLease extends RunLease {}
interface IdemRecord<T> {
  result: T;
  recordedAt: string;
}

export class MemoryGoalLedgerStore implements GoalLedgerStore {
  private readonly clock: Clock;
  constructor(private readonly store: KeyValueStore, opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  private get mutex() {
    return mutexFor(this.store);
  }
  private now(): string {
    return this.clock().toISOString();
  }

  async createRun(input: { graph: GoalGraphRevisionRecord; createdBy: string; runId?: GoalRunId }): Promise<GoalRunLedger> {
    const runId = input.runId ?? `run-${randomUUID()}`;
    return this.mutex.run(`run:${runId}`, async () => {
      if (await this.store.get(GOAL_STORE_KEYS.run(runId))) fail('DUPLICATE', `run ${runId} already exists`);
      const now = this.now();
      const minutes = input.graph.definition.constitution.resourceLimits.maxRunMinutes;
      const ledger: GoalRunLedger = {
        runId,
        graphId: input.graph.graphId,
        graphRevision: input.graph.revision,
        graphDigest: input.graph.digest,
        status: 'created',
        ledgerRevision: 1,
        targets: Object.fromEntries(
          input.graph.definition.targets.map((t) => [t.id, { targetId: t.id, status: 'queued', attempts: 0, repairs: 0, evidenceIds: [], blockers: [], updatedAt: now }]),
        ),
        resource: { tasksStarted: 0, hostedSpendUsd: 0, startedAt: now, deadlineAt: new Date(Date.parse(now) + minutes * 60_000).toISOString() },
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      };
      await this.store.put(GOAL_STORE_KEYS.run(runId), ledger);
      return clone(ledger);
    });
  }

  async getRun(runId: GoalRunId): Promise<GoalRunLedger | undefined> {
    return getIso<GoalRunLedger>(this.store, GOAL_STORE_KEYS.run(runId));
  }

  async listRuns(filter: { graphId?: GraphId; status?: GoalRunStatus } = {}): Promise<GoalRunLedger[]> {
    const entries = await listIso<GoalRunLedger>(this.store, 'goals/runs/');
    return entries
      .map((e) => e.value)
      .filter((r) => r && typeof r === 'object' && 'ledgerRevision' in r)
      .filter((r) => (filter.graphId ? r.graphId === filter.graphId : true) && (filter.status ? r.status === filter.status : true));
  }

  async commit(
    runId: GoalRunId,
    expectedRevision: number,
    lease: RunLease,
    mutate: (ledger: GoalRunLedger) => void,
    transitions: TargetTransition[],
  ): Promise<GoalRunLedger> {
    return this.mutex.run(`run:${runId}`, async () => {
      const current = await this.getRun(runId);
      if (!current) fail('NOT_FOUND', `run ${runId} not found`);
      const held = await getIso<StoredLease>(this.store, GOAL_STORE_KEYS.runLease(runId));
      if (
        !held ||
        lease.runId !== runId ||
        held.epoch !== lease.epoch ||
        held.holderId !== lease.holderId ||
        Date.parse(held.expiresAt) <= this.clock().getTime()
      ) {
        fail('STALE_LEASE', `lease epoch ${lease.epoch} for ${runId} is not current`, { presentedEpoch: lease.epoch, currentEpoch: held?.epoch });
      }
      if (current.ledgerRevision !== expectedRevision) {
        fail('LEDGER_CONFLICT', `expected revision ${expectedRevision}, found ${current.ledgerRevision}`, { expectedRevision, actualRevision: current.ledgerRevision }, true);
      }
      const next = clone(current);
      mutate(next);
      // Identity and revision are owned by the store, not by the mutator.
      next.runId = current.runId;
      next.graphId = current.graphId;
      next.graphRevision = current.graphRevision;
      next.graphDigest = current.graphDigest;
      next.ledgerRevision = current.ledgerRevision + 1;
      next.updatedAt = this.now();
      const existing = await this.store.list(`goals/transitions/${runId}/`);
      let seq = existing.length;
      for (const t of transitions) {
        seq += 1;
        await this.store.put(GOAL_STORE_KEYS.transition(runId, seq), clone({ ...t, runId }));
      }
      await this.store.put(GOAL_STORE_KEYS.run(runId), next);
      return clone(next);
    });
  }

  async transitions(runId: GoalRunId, targetId?: TargetId): Promise<TargetTransition[]> {
    const entries = await listIso<TargetTransition>(this.store, `goals/transitions/${runId}/`);
    return entries.map((e) => e.value).filter((t) => (targetId ? t.targetId === targetId : true));
  }

  async acquireLease(runId: GoalRunId, holderId: string, ttlMs: number): Promise<RunLease | undefined> {
    return this.mutex.run(`lease:${runId}`, async () => {
      const held = await getIso<StoredLease>(this.store, GOAL_STORE_KEYS.runLease(runId));
      const nowMs = this.clock().getTime();
      if (held && Date.parse(held.expiresAt) > nowMs && held.holderId !== holderId) return undefined;
      const lease: RunLease = { runId, holderId, epoch: (held?.epoch ?? 0) + 1, expiresAt: new Date(nowMs + ttlMs).toISOString() };
      await this.store.put(GOAL_STORE_KEYS.runLease(runId), lease);
      return clone(lease);
    });
  }

  async renewLease(lease: RunLease, ttlMs: number): Promise<RunLease> {
    return this.mutex.run(`lease:${lease.runId}`, async () => {
      const held = await getIso<StoredLease>(this.store, GOAL_STORE_KEYS.runLease(lease.runId));
      const nowMs = this.clock().getTime();
      if (!held || held.epoch !== lease.epoch || held.holderId !== lease.holderId || Date.parse(held.expiresAt) <= nowMs) {
        fail('STALE_LEASE', `cannot renew lease epoch ${lease.epoch}`);
      }
      const renewed: RunLease = { ...held, expiresAt: new Date(nowMs + ttlMs).toISOString() };
      await this.store.put(GOAL_STORE_KEYS.runLease(lease.runId), renewed);
      return clone(renewed);
    });
  }

  async releaseLease(lease: RunLease): Promise<void> {
    await this.mutex.run(`lease:${lease.runId}`, async () => {
      const held = await getIso<StoredLease>(this.store, GOAL_STORE_KEYS.runLease(lease.runId));
      if (!held || held.epoch !== lease.epoch || held.holderId !== lease.holderId) return;
      // Keep the epoch so the next acquisition is strictly greater.
      await this.store.put(GOAL_STORE_KEYS.runLease(lease.runId), { ...held, expiresAt: new Date(0).toISOString() });
    });
  }

  async once<T>(key: IdempotencyKey, effect: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
    return this.mutex.run(`idem:${key}`, async () => {
      const recorded = await getIso<IdemRecord<T>>(this.store, GOAL_STORE_KEYS.idempotency(key));
      if (recorded) return { result: recorded.result, replayed: true };
      const result = await effect();
      await this.store.put(GOAL_STORE_KEYS.idempotency(key), { result, recordedAt: this.now() });
      return { result: clone(result), replayed: false };
    });
  }

  async saveAttempt(attempt: TargetAttempt): Promise<void> {
    await this.store.put(GOAL_STORE_KEYS.attempt(attempt.runId, attempt.id), clone(attempt));
  }

  async attempts(runId: GoalRunId, targetId?: TargetId): Promise<TargetAttempt[]> {
    const entries = await listIso<TargetAttempt>(this.store, `goals/attempts/${runId}/`);
    return entries
      .map((e) => e.value)
      .filter((a) => (targetId ? a.targetId === targetId : true))
      .sort((a, b) => (a.targetId === b.targetId ? a.attempt - b.attempt : a.startedAt < b.startedAt ? -1 : 1));
  }
}
