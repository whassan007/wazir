import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { injectFault, type KeyValueStore } from '@wazir/shared';
import {
  GOAL_STORE_KEYS,
  GoalStudioFailure,
  type GoalGraphRevisionRecord,
  type GoalLedgerStore,
  type GoalRunId,
  type GoalRunLedger,
  type GoalRunStatus,
  type GoalStudioDeps,
  type GoalStudioError,
  type GraphId,
  type IdempotencyKey,
  type RunLease,
  type TargetAttempt,
  type TargetId,
  type TargetLedgerEntry,
  type TargetTransition,
} from '../contracts.js';
import { atomicUpdate, plain } from './atomic.js';

/**
 * Durable goal-run ledger (Goal Studio workstream 01).
 *
 * Storage layout (all under the `GOAL_STORE_KEYS` prefixes owned by this workstream):
 *
 *   goals/runs/<runId>               RunEnvelope — the ledger, the authoritative run
 *                                    lease, and the transitions of the latest commit.
 *   goals/transitions/<runId>/<seq>  one committed TargetTransition per key.
 *   goals/attempts/<runId>/<id>      TargetAttempt.
 *   goals/idem/<key>                 IdempotencyRecord for `once`.
 *
 * Why the lease lives inside the run envelope: fencing is only sound if "is this
 * epoch still current?" and "write the ledger" are one atomic step. With the lease
 * in a separate key, a holder could pass the lease check, lose the lease to a
 * takeover, and still land its CAS before the new holder's first commit. Keeping
 * both in one key means `KeyValueStore.update` checks the epoch and writes the
 * ledger under the same lock / transaction.
 *
 * Why transitions are first written inside the envelope: the KeyValueStore has no
 * multi-key transaction. A commit atomically writes the ledger together with its
 * transitions (`lastBatch`); the per-seq transition keys are then materialised
 * idempotently (same seq, same content). A crash between the two leaves the batch
 * in the envelope, where `transitions()` still reads it and the next commit
 * materialises it before replacing it. So transitions are never lost and never
 * visible without their ledger write.
 */

export const LEDGER_ENVELOPE_VERSION = 1;

interface StoredLease {
  holderId: string;
  epoch: number;
  expiresAt: string;
  acquiredAt: string;
  released: boolean;
}

interface TransitionBatch {
  /** ledgerRevision produced by the commit that wrote this batch. */
  revision: number;
  firstSeq: number;
  transitions: TargetTransition[];
}

interface RunEnvelope {
  v: number;
  ledger: GoalRunLedger;
  lease?: StoredLease;
  /** Highest epoch ever issued for this run; epochs never repeat, even after release. */
  maxEpoch: number;
  /** Number of transitions ever committed (seq of the last one). */
  transitionSeq: number;
  lastBatch?: TransitionBatch;
}

interface StoredTransition {
  seq: number;
  revision: number;
  transition: TargetTransition;
}

export interface EffectOwner {
  instanceId: string;
  pid: number;
  host: string;
}

/** Durable record behind `once(key, effect)`. */
export interface IdempotencyRecord {
  v: number;
  key: IdempotencyKey;
  /**
   * in_flight: the effect was started and has no recorded outcome. After a crash this
   *            is exactly the "may or may not have happened" case: never re-run blindly.
   * done:      the effect completed; `resultJson` is replayed to every later caller.
   * failed:    the effect threw a non-retryable error; the error is replayed.
   * released:  the key is free again (a retryable failure, or reconciled as not applied).
   */
  state: 'in_flight' | 'done' | 'failed' | 'released';
  owner: EffectOwner;
  startedAt: string;
  finishedAt?: string;
  /** JSON of the recorded result; absent when the effect returned `undefined`. */
  resultJson?: string;
  error?: GoalStudioError;
  /** How many times the effect body has been started for this key. */
  runs: number;
  reconciliation?: { outcome: 'applied' | 'not_applied'; actor: string; at: string };
}

export interface PendingEffect {
  key: IdempotencyKey;
  owner: EffectOwner;
  startedAt: string;
  /** false: owner process is gone (crash); 'unknown': owner is on another host. */
  ownerAlive: boolean | 'unknown';
}

export type EffectResolution = { outcome: 'applied'; result: unknown } | { outcome: 'not_applied' };

/** The contract's GoalLedgerStore plus the reconciliation surface recovery needs. */
export interface DurableGoalLedgerStore extends GoalLedgerStore {
  /** Effects started but never recorded (in_flight), optionally filtered by key prefix (e.g. a runId). */
  pendingEffects(keyPrefix?: string): Promise<PendingEffect[]>;
  effectStatus(key: IdempotencyKey): Promise<IdempotencyRecord | undefined>;
  /**
   * Resolves an in-flight effect from evidence gathered outside the ledger:
   * `applied` records `result` as the outcome (later `once` calls replay it);
   * `not_applied` releases the key so the effect may run again.
   */
  reconcileEffect(key: IdempotencyKey, resolution: EffectResolution, actor: string): Promise<IdempotencyRecord>;
  /** The current lease, if any holder has an unreleased one (expired leases are returned too). */
  currentLease(runId: GoalRunId): Promise<(RunLease & { released: boolean }) | undefined>;
}

export interface GoalLedgerStoreOptions {
  /** Identifies this ledger instance as an effect owner. Defaults to a random id. */
  instanceId?: string;
  /** Liveness of a same-host pid; defaults to `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function toLease(runId: GoalRunId, stored: StoredLease): RunLease {
  return { runId, holderId: stored.holderId, epoch: stored.epoch, expiresAt: stored.expiresAt };
}

function staleLease(runId: GoalRunId, lease: RunLease, message: string, current?: StoredLease, retryable = false): GoalStudioFailure {
  return new GoalStudioFailure('STALE_LEASE', message, {
    retryable,
    details: {
      runId,
      holderId: lease.holderId,
      epoch: lease.epoch,
      currentHolderId: current?.holderId,
      currentEpoch: current?.epoch,
      currentExpiresAt: current?.expiresAt,
      released: current?.released,
    },
  });
}

/** Fencing check: `lease` must be the run's current, unreleased, unexpired lease. */
function assertCurrentLease(envelope: RunEnvelope, lease: RunLease, now: Date): void {
  const runId = envelope.ledger.runId;
  const current = envelope.lease;
  if (!lease || lease.runId !== runId) {
    throw new GoalStudioFailure('STALE_LEASE', `lease is not for run '${runId}'`, { details: { runId, leaseRunId: lease?.runId } });
  }
  if (!current) throw staleLease(runId, lease, `run '${runId}' has no lease; acquire one before committing`);
  if (current.epoch !== lease.epoch || current.holderId !== lease.holderId) {
    throw staleLease(runId, lease, `lease epoch ${lease.epoch} held by '${lease.holderId}' was superseded by epoch ${current.epoch} ('${current.holderId}')`, current);
  }
  if (current.released) throw staleLease(runId, lease, `lease epoch ${lease.epoch} for run '${runId}' was released`, current);
  if (Date.parse(current.expiresAt) <= now.getTime()) {
    // Expired but not yet taken over: the holder may renew and retry.
    throw staleLease(runId, lease, `lease epoch ${lease.epoch} for run '${runId}' expired at ${current.expiresAt}; renew it before committing`, current, true);
  }
}

function ledgerConflict(runId: GoalRunId, expected: number, actual: number): GoalStudioFailure {
  return new GoalStudioFailure('LEDGER_CONFLICT', `run '${runId}' is at ledger revision ${actual}, not ${expected}; reload and retry`, {
    retryable: true,
    details: { runId, expectedRevision: expected, currentRevision: actual },
  });
}

const IMMUTABLE_LEDGER_FIELDS = ['runId', 'graphId', 'graphRevision', 'graphDigest', 'createdBy', 'createdAt'] as const;

/**
 * Validates a commit's transitions against the status change it makes. Every target
 * whose status changed needs a transition chain `before.status -> ... -> after.status`,
 * and no transition may claim a from-state the target was not in.
 */
function validateTransitions(runId: GoalRunId, before: GoalRunLedger, after: GoalRunLedger, transitions: TargetTransition[]): void {
  const cursor = new Map<TargetId, string>();
  for (const [index, t] of transitions.entries()) {
    const where = `transition[${index}] (${t?.targetId}: ${t?.fromState} -> ${t?.toState})`;
    if (!t || t.runId !== runId) throw new GoalStudioFailure('VALIDATION', `${where} is not for run '${runId}'`);
    if (!before.targets[t.targetId] || !after.targets[t.targetId]) throw new GoalStudioFailure('VALIDATION', `${where} names an unknown target`);
    if (typeof t.actor !== 'string' || t.actor.length === 0) throw new GoalStudioFailure('VALIDATION', `${where} has no actor`);
    if (typeof t.reason !== 'string') throw new GoalStudioFailure('VALIDATION', `${where} has no reason`);
    const from = cursor.get(t.targetId) ?? before.targets[t.targetId].status;
    if (t.fromState !== from) {
      throw new GoalStudioFailure('VALIDATION', `${where} starts from '${t.fromState}' but the target is '${from}'`, { details: { targetId: t.targetId } });
    }
    cursor.set(t.targetId, t.toState);
  }
  for (const targetId of new Set([...Object.keys(before.targets), ...Object.keys(after.targets)])) {
    const was = before.targets[targetId]?.status;
    const now = after.targets[targetId]?.status;
    if (was === undefined || now === undefined) {
      throw new GoalStudioFailure('VALIDATION', `commit may not add or remove target '${targetId}'; targets are fixed by the pinned graph revision`);
    }
    const reached = cursor.get(targetId) ?? was;
    if (reached !== now) {
      throw new GoalStudioFailure('VALIDATION', `target '${targetId}' changed ${was} -> ${now} but the commit's transitions end at '${reached}'`, { details: { targetId } });
    }
  }
}

class GoalLedgerStoreImpl implements DurableGoalLedgerStore {
  private readonly store: KeyValueStore;
  private readonly clock: () => Date;
  private readonly owner: EffectOwner;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly hasCustomProcessAlive: boolean;
  /** In-process dedupe: concurrent `once` calls with one key share one effect run. */
  private readonly inflight = new Map<IdempotencyKey, Promise<unknown>>();

  constructor(deps: GoalStudioDeps, options: GoalLedgerStoreOptions = {}) {
    if (!deps?.store) throw new GoalStudioFailure('INTERNAL', 'createGoalLedgerStore requires deps.store');
    this.store = deps.store;
    this.clock = deps.clock ?? (() => new Date());
    this.owner = { instanceId: options.instanceId ?? `ledger-${randomUUID()}`, pid: process.pid, host: hostname() };
    this.hasCustomProcessAlive = typeof options.isProcessAlive === 'function';
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  async createRun(input: { graph: GoalGraphRevisionRecord; createdBy: string; runId?: GoalRunId }): Promise<GoalRunLedger> {
    const { graph, createdBy } = input;
    if (!graph?.definition || !Array.isArray(graph.definition.targets)) {
      throw new GoalStudioFailure('VALIDATION', 'createRun requires a graph revision record with targets');
    }
    if (!createdBy) throw new GoalStudioFailure('VALIDATION', 'createRun requires createdBy');
    const runId = input.runId ?? `run-${randomUUID()}`;
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(runId)) throw new GoalStudioFailure('VALIDATION', `invalid run id '${runId}'`);
    const now = this.clock();
    const at = now.toISOString();
    const targets: Record<TargetId, TargetLedgerEntry> = {};
    for (const target of graph.definition.targets) {
      if (targets[target.id]) throw new GoalStudioFailure('VALIDATION', `duplicate target '${target.id}' in graph ${graph.graphId}@${graph.revision}`);
      const isRoot = !Array.isArray(target.dependsOn) || target.dependsOn.length === 0;
      targets[target.id] = {
        targetId: target.id,
        status: isRoot ? 'eligible' : 'queued',
        attempts: 0,
        repairs: 0,
        evidenceIds: [],
        blockers: [],
        updatedAt: at,
      };
    }
    const maxRunMinutes = graph.definition.constitution?.resourceLimits?.maxRunMinutes ?? 0;
    const ledger: GoalRunLedger = {
      runId,
      graphId: graph.graphId,
      graphRevision: graph.revision,
      graphDigest: graph.digest,
      status: 'created',
      ledgerRevision: 1,
      targets,
      resource: { tasksStarted: 0, hostedSpendUsd: 0, startedAt: at, deadlineAt: new Date(now.getTime() + maxRunMinutes * 60_000).toISOString() },
      createdBy,
      createdAt: at,
      updatedAt: at,
    };
    const envelope = await atomicUpdate<RunEnvelope>(this.store, GOAL_STORE_KEYS.run(runId), (current) => {
      if (current) throw new GoalStudioFailure('DUPLICATE', `run '${runId}' already exists`, { details: { runId } });
      return { v: LEDGER_ENVELOPE_VERSION, ledger, maxEpoch: 0, transitionSeq: 0 };
    });
    return plain(envelope.ledger);
  }

  async getRun(runId: GoalRunId): Promise<GoalRunLedger | undefined> {
    const envelope = await this.readEnvelope(runId);
    return envelope ? envelope.ledger : undefined;
  }

  async listRuns(filter: { graphId?: GraphId; status?: GoalRunStatus } = {}): Promise<GoalRunLedger[]> {
    const entries = await this.store.list('goals/runs/');
    return entries
      .map(({ value }) => plain(value as RunEnvelope)?.ledger)
      .filter((ledger): ledger is GoalRunLedger => Boolean(ledger?.runId))
      .filter((ledger) => (filter.graphId === undefined || ledger.graphId === filter.graphId) && (filter.status === undefined || ledger.status === filter.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
  }

  async commit(
    runId: GoalRunId,
    expectedRevision: number,
    lease: RunLease,
    mutate: (ledger: GoalRunLedger) => void,
    transitions: TargetTransition[],
  ): Promise<GoalRunLedger> {
    if (!Number.isSafeInteger(expectedRevision)) throw new GoalStudioFailure('VALIDATION', 'expectedRevision must be an integer');
    if (!Array.isArray(transitions)) throw new GoalStudioFailure('VALIDATION', 'transitions must be an array');
    const before = await this.requireEnvelope(runId);
    // Cheap rejection before any write, so a stale holder costs nothing.
    assertCurrentLease(before, lease, this.clock());
    if (before.ledger.ledgerRevision !== expectedRevision) throw ledgerConflict(runId, expectedRevision, before.ledger.ledgerRevision);
    // The previous commit's batch may not be materialised yet (crash after its CAS).
    await this.materialise(runId, before.lastBatch);

    let committed!: RunEnvelope;
    await atomicUpdate<RunEnvelope>(this.store, GOAL_STORE_KEYS.run(runId), (current) => {
      if (!current) throw new GoalStudioFailure('NOT_FOUND', `run '${runId}' not found`);
      const now = this.clock();
      // Both checks again, under the store's lock: this is the actual fence.
      assertCurrentLease(current, lease, now);
      if (current.ledger.ledgerRevision !== expectedRevision) throw ledgerConflict(runId, expectedRevision, current.ledger.ledgerRevision);
      const draft = plain(current.ledger);
      mutate(draft);
      for (const field of IMMUTABLE_LEDGER_FIELDS) {
        if (draft[field] !== current.ledger[field]) throw new GoalStudioFailure('VALIDATION', `commit may not change ledger.${field}`);
      }
      if (!draft.targets || typeof draft.targets !== 'object') throw new GoalStudioFailure('VALIDATION', 'commit removed ledger.targets');
      validateTransitions(runId, current.ledger, draft, transitions);
      const at = now.toISOString();
      const stamped = transitions.map((t) => plain({ ...t, timestamp: t.timestamp || at }));
      draft.ledgerRevision = expectedRevision + 1;
      draft.updatedAt = at;
      committed = {
        ...current,
        ledger: plain(draft),
        transitionSeq: current.transitionSeq + stamped.length,
        lastBatch: { revision: draft.ledgerRevision, firstSeq: current.transitionSeq + 1, transitions: stamped },
      };
      return committed;
    });
    await injectFault('AFTER_LEDGER_COMMIT', { runId, key: GOAL_STORE_KEYS.run(runId), revision: committed.ledger.ledgerRevision });
    // Best effort: an unmaterialised batch stays readable from the envelope.
    await this.materialise(runId, committed.lastBatch).catch(() => undefined);
    return plain(committed.ledger);
  }

  async transitions(runId: GoalRunId, targetId?: TargetId): Promise<TargetTransition[]> {
    const bySeq = new Map<number, TargetTransition>();
    const prefix = `goals/transitions/${runId}/`;
    for (const { value } of await this.store.list(prefix)) {
      const stored = plain(value as StoredTransition);
      if (stored && Number.isSafeInteger(stored.seq)) bySeq.set(stored.seq, stored.transition);
    }
    const envelope = await this.readEnvelope(runId);
    const batch = envelope?.lastBatch;
    if (batch) batch.transitions.forEach((t, i) => bySeq.set(batch.firstSeq + i, t));
    // Never expose transitions past the committed sequence (defensive: cannot happen
    // through this API, but a hand-edited store must not fabricate history).
    const limit = envelope?.transitionSeq ?? 0;
    return [...bySeq.entries()]
      .filter(([seq]) => seq <= limit)
      .sort(([a], [b]) => a - b)
      .map(([, t]) => t)
      .filter((t) => targetId === undefined || t.targetId === targetId);
  }

  // -------------------------------------------------------------------------
  // Leases
  // -------------------------------------------------------------------------

  async acquireLease(runId: GoalRunId, holderId: string, ttlMs: number): Promise<RunLease | undefined> {
    if (!holderId) throw new GoalStudioFailure('VALIDATION', 'acquireLease requires a holderId');
    if (!(ttlMs > 0) || !Number.isFinite(ttlMs)) throw new GoalStudioFailure('VALIDATION', 'acquireLease requires a positive ttlMs');
    let acquired: StoredLease | undefined;
    const key = GOAL_STORE_KEYS.run(runId);
    await this.requireEnvelope(runId);
    await atomicUpdate<RunEnvelope>(this.store, key, (current) => {
      if (!current) throw new GoalStudioFailure('NOT_FOUND', `run '${runId}' not found`);
      const now = this.clock();
      const held = current.lease;
      if (held && !held.released && Date.parse(held.expiresAt) > now.getTime() && held.holderId !== holderId) {
        acquired = undefined;
        return current; // unchanged: someone else holds a live lease
      }
      // Every acquisition, including a re-acquire by the same holder id (e.g. a
      // restarted process), gets a new epoch so older incarnations are fenced off.
      const epoch = Math.max(current.maxEpoch, held?.epoch ?? 0) + 1;
      acquired = { holderId, epoch, acquiredAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString(), released: false };
      return { ...current, lease: acquired, maxEpoch: epoch };
    });
    return acquired ? toLease(runId, acquired) : undefined;
  }

  async renewLease(lease: RunLease, ttlMs: number): Promise<RunLease> {
    if (!(ttlMs > 0) || !Number.isFinite(ttlMs)) throw new GoalStudioFailure('VALIDATION', 'renewLease requires a positive ttlMs');
    let renewed!: StoredLease;
    await this.requireEnvelope(lease.runId);
    await atomicUpdate<RunEnvelope>(this.store, GOAL_STORE_KEYS.run(lease.runId), (current) => {
      if (!current) throw new GoalStudioFailure('NOT_FOUND', `run '${lease.runId}' not found`);
      const held = current.lease;
      if (!held || held.epoch !== lease.epoch || held.holderId !== lease.holderId) {
        throw staleLease(lease.runId, lease, `cannot renew lease epoch ${lease.epoch}: superseded by epoch ${held?.epoch ?? 'none'}`, held);
      }
      if (held.released) throw staleLease(lease.runId, lease, `cannot renew released lease epoch ${lease.epoch}`, held);
      // An expired lease nobody has taken over is still the current epoch: renewing it
      // is safe, because any takeover would have bumped the epoch first.
      const now = this.clock();
      renewed = { ...held, expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
      return { ...current, lease: renewed };
    });
    return toLease(lease.runId, renewed);
  }

  /**
   * Releases `lease` if it is still current. Releasing a superseded or already
   * released lease is a no-op: it can never release a newer holder's lease, and it
   * is typically called from `finally` blocks where throwing would mask the cause.
   */
  async releaseLease(lease: RunLease): Promise<void> {
    const envelope = await this.readEnvelope(lease.runId);
    if (!envelope?.lease || envelope.lease.epoch !== lease.epoch || envelope.lease.released) return;
    await atomicUpdate<RunEnvelope>(this.store, GOAL_STORE_KEYS.run(lease.runId), (current) => {
      if (!current?.lease || current.lease.epoch !== lease.epoch || current.lease.holderId !== lease.holderId || current.lease.released) {
        return current as RunEnvelope;
      }
      return { ...current, lease: { ...current.lease, released: true, expiresAt: this.clock().toISOString() } };
    });
  }

  async currentLease(runId: GoalRunId): Promise<(RunLease & { released: boolean }) | undefined> {
    const envelope = await this.readEnvelope(runId);
    return envelope?.lease ? { ...toLease(runId, envelope.lease), released: envelope.lease.released } : undefined;
  }

  // -------------------------------------------------------------------------
  // Exactly-once effects
  // -------------------------------------------------------------------------

  async once<T>(key: IdempotencyKey, effect: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
    if (typeof key !== 'string' || key.length === 0) throw new GoalStudioFailure('VALIDATION', 'once requires an idempotency key');
    const local = this.inflight.get(key);
    if (local) {
      const result = (await local) as T;
      return { result, replayed: true };
    }
    const existing = await this.effectStatus(key);
    if (existing && existing.state !== 'released') return this.replay<T>(existing);

    const storeKey = GOAL_STORE_KEYS.idempotency(key);
    let claimed = false;
    let seen: IdempotencyRecord | undefined;
    const run = (async () => {
      await atomicUpdate<IdempotencyRecord>(this.store, storeKey, (current) => {
        if (current && current.state !== 'released') {
          seen = current;
          return current; // someone else claimed or finished it first
        }
        claimed = true;
        return {
          v: 1,
          key,
          state: 'in_flight',
          owner: this.owner,
          startedAt: this.clock().toISOString(),
          runs: (current?.runs ?? 0) + 1,
        };
      });
      if (!claimed) return this.replay<T>(seen!).then((r) => r.result);
      // The in-flight marker is durable from here on. A crash anywhere below leaves
      // it in place, so a restarted process sees "started, outcome unknown".
      await injectFault('BEFORE_IDEMPOTENT_EFFECT', { key });
      let value: T;
      try {
        value = await effect();
      } catch (error) {
        await this.recordFailure(key, error);
        throw error;
      }
      // Replays return the JSON form; give the first caller the identical value.
      const normalised = value === undefined ? undefined : (plain(value) as T);
      await injectFault('AFTER_EFFECT_BEFORE_RECORD', { key });
      await atomicUpdate<IdempotencyRecord>(this.store, storeKey, (current) => {
        if (!current || current.state !== 'in_flight' || current.owner.instanceId !== this.owner.instanceId) {
          throw new GoalStudioFailure('DUPLICATE', `effect '${key}' was reconciled by someone else while it ran; its result was not recorded`, {
            details: { key, state: current?.state, reconciliation: current?.reconciliation },
          });
        }
        return {
          ...current,
          state: 'done',
          finishedAt: this.clock().toISOString(),
          ...(normalised === undefined ? {} : { resultJson: JSON.stringify(normalised) }),
        };
      });
      return normalised as T;
    })();
    this.inflight.set(key, run);
    try {
      const result = await run;
      return { result, replayed: !claimed };
    } finally {
      this.inflight.delete(key);
    }
  }

  async effectStatus(key: IdempotencyKey): Promise<IdempotencyRecord | undefined> {
    return plain(await this.store.get<IdempotencyRecord>(GOAL_STORE_KEYS.idempotency(key)));
  }

  async pendingEffects(keyPrefix = ''): Promise<PendingEffect[]> {
    const entries = await this.store.list(GOAL_STORE_KEYS.idempotency(keyPrefix));
    return entries
      .map(({ value }) => plain(value as IdempotencyRecord))
      .filter((r) => r?.state === 'in_flight' && !this.inflight.has(r.key))
      .map((r) => ({ key: r.key, owner: r.owner, startedAt: r.startedAt, ownerAlive: this.ownerAlive(r.owner) }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async reconcileEffect(key: IdempotencyKey, resolution: EffectResolution, actor: string): Promise<IdempotencyRecord> {
    if (!actor) throw new GoalStudioFailure('VALIDATION', 'reconcileEffect requires an actor');
    if (this.inflight.has(key)) throw new GoalStudioFailure('DUPLICATE', `effect '${key}' is running in this process; it cannot be reconciled`, { retryable: true });
    const status = await this.effectStatus(key);
    if (status?.state === 'in_flight' && this.ownerAlive(status.owner) === true) {
      throw new GoalStudioFailure('DUPLICATE', `effect '${key}' is still owned by live process ${status.owner.pid}`, { retryable: true, details: { key, owner: status.owner } });
    }
    return atomicUpdate<IdempotencyRecord>(this.store, GOAL_STORE_KEYS.idempotency(key), (current) => {
      if (!current) throw new GoalStudioFailure('NOT_FOUND', `no effect recorded for '${key}'`);
      if (current.state !== 'in_flight') {
        throw new GoalStudioFailure('VALIDATION', `effect '${key}' is ${current.state}; only an in-flight effect can be reconciled`, { details: { key, state: current.state } });
      }
      const reconciliation = { outcome: resolution.outcome, actor, at: this.clock().toISOString() };
      if (resolution.outcome === 'applied') {
        return {
          ...current,
          state: 'done',
          finishedAt: reconciliation.at,
          reconciliation,
          ...(resolution.result === undefined ? {} : { resultJson: JSON.stringify(plain(resolution.result)) }),
        };
      }
      return { ...current, state: 'released', finishedAt: reconciliation.at, reconciliation };
    });
  }

  private async replay<T>(record: IdempotencyRecord): Promise<{ result: T; replayed: boolean }> {
    if (record.state === 'done') {
      return { result: (record.resultJson === undefined ? undefined : JSON.parse(record.resultJson)) as T, replayed: true };
    }
    if (record.state === 'failed') {
      const error = record.error ?? { code: 'INTERNAL', message: 'effect failed', retryable: false };
      throw new GoalStudioFailure(error.code, error.message, { retryable: false, details: { ...error.details, key: record.key, replayed: true } });
    }
    const ownerAlive = this.ownerAlive(record.owner);
    throw new GoalStudioFailure(
      'DUPLICATE',
      ownerAlive === false
        ? `effect '${record.key}' was started by process ${record.owner.pid} on ${record.owner.host}, which is gone, and has no recorded outcome; ` +
          'reconcile it (reconcileEffect) from evidence before anything re-runs it'
        : `effect '${record.key}' is in flight in ${record.owner.host}:${record.owner.pid} with no recorded outcome yet`,
      {
        // Retrying only helps while the owner might still finish and record it.
        retryable: ownerAlive !== false,
        details: { key: record.key, state: 'in_flight', needsReconciliation: true, ownerAlive, owner: record.owner, startedAt: record.startedAt },
      },
    );
  }

  private async recordFailure(key: IdempotencyKey, error: unknown): Promise<void> {
    // A retryable GoalStudioFailure is the effect's own statement that nothing was
    // applied, so the key is released and the step may run again. Anything else may
    // have partially applied: the failure is recorded and replayed, never re-run.
    const retryable = error instanceof GoalStudioFailure && error.retryable;
    const recorded: GoalStudioError = error instanceof GoalStudioFailure
      ? error.toJSON()
      : { code: 'EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false };
    await atomicUpdate<IdempotencyRecord>(this.store, GOAL_STORE_KEYS.idempotency(key), (current) => {
      if (!current || current.state !== 'in_flight' || current.owner.instanceId !== this.owner.instanceId) return current as IdempotencyRecord;
      return { ...current, state: retryable ? 'released' : 'failed', finishedAt: this.clock().toISOString(), error: plain(recorded) };
    });
  }

  private ownerAlive(owner: EffectOwner): boolean | 'unknown' {
    // Our own instance, but not in `inflight`: this instance started it and failed to
    // record the outcome (e.g. the result write itself failed). Nothing will finish it.
    if (owner.instanceId === this.owner.instanceId) return false;
    if (owner.host !== this.owner.host) return 'unknown';
    if (!this.hasCustomProcessAlive && owner.pid === process.pid) return true; // another ledger instance in this process
    return this.isProcessAlive(owner.pid);
  }

  // -------------------------------------------------------------------------
  // Attempts
  // -------------------------------------------------------------------------

  async saveAttempt(attempt: TargetAttempt): Promise<void> {
    if (!attempt?.id || !attempt.runId || !attempt.targetId) throw new GoalStudioFailure('VALIDATION', 'attempt requires id, runId and targetId');
    if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1) throw new GoalStudioFailure('VALIDATION', 'attempt.attempt must be a positive integer');
    const next = plain(attempt);
    await atomicUpdate<TargetAttempt>(this.store, GOAL_STORE_KEYS.attempt(attempt.runId, attempt.id), (current) => {
      if (!current) return next;
      for (const field of ['runId', 'targetId', 'attempt', 'startedAt'] as const) {
        if (current[field] !== next[field]) throw new GoalStudioFailure('VALIDATION', `attempt '${attempt.id}' may not change ${field}`);
      }
      // A finished attempt is history: it may be re-saved identically, never rewritten.
      if (current.outcome !== undefined && (next.outcome !== current.outcome || next.endedAt !== current.endedAt)) {
        throw new GoalStudioFailure('LEDGER_CONFLICT', `attempt '${attempt.id}' already finished as '${current.outcome}'`, {
          details: { attemptId: attempt.id, outcome: current.outcome },
        });
      }
      return next;
    });
  }

  async attempts(runId: GoalRunId, targetId?: TargetId): Promise<TargetAttempt[]> {
    const entries = await this.store.list(`goals/attempts/${runId}/`);
    return entries
      .map(({ value }) => plain(value as TargetAttempt))
      .filter((a) => a && (targetId === undefined || a.targetId === targetId))
      .sort((a, b) => a.targetId.localeCompare(b.targetId) || a.attempt - b.attempt || a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async readEnvelope(runId: GoalRunId): Promise<RunEnvelope | undefined> {
    const envelope = plain(await this.store.get<RunEnvelope>(GOAL_STORE_KEYS.run(runId)));
    if (envelope !== undefined && envelope.v !== LEDGER_ENVELOPE_VERSION) {
      throw new GoalStudioFailure('INTERNAL', `run '${runId}' has unsupported ledger envelope version ${envelope.v}`);
    }
    return envelope;
  }

  private async requireEnvelope(runId: GoalRunId): Promise<RunEnvelope> {
    const envelope = await this.readEnvelope(runId);
    if (!envelope) throw new GoalStudioFailure('NOT_FOUND', `run '${runId}' not found`, { details: { runId } });
    return envelope;
  }

  /** Writes a committed batch to its per-seq keys. Idempotent: same seq, same content. */
  private async materialise(runId: GoalRunId, batch: TransitionBatch | undefined): Promise<void> {
    if (!batch) return;
    for (const [i, transition] of batch.transitions.entries()) {
      const seq = batch.firstSeq + i;
      const key = GOAL_STORE_KEYS.transition(runId, seq);
      if (await this.store.get(key)) continue;
      const stored: StoredTransition = { seq, revision: batch.revision, transition };
      await this.store.put(key, stored);
    }
  }
}

export function createGoalLedgerStore(deps: GoalStudioDeps, options: GoalLedgerStoreOptions = {}): DurableGoalLedgerStore {
  return new GoalLedgerStoreImpl(deps, options);
}

export function createLedgerStore(deps: GoalStudioDeps, options: GoalLedgerStoreOptions = {}): DurableGoalLedgerStore {
  return createGoalLedgerStore(deps, options);
}
