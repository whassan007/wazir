/**
 * Continuous goal controller (Goal Studio workstream 03).
 *
 * Drives a pinned goal-graph revision through the lifecycle in
 * INTEGRATION-CONTRACTS.md §4, delegating every phase to the injected services.
 * The controller — never model output — decides each transition:
 *
 *  - every ledger mutation goes through `ledger.commit` under the run lease;
 *  - every side effect (EXECUTE, INDEPENDENT_VERIFY, DIAGNOSE, COMMIT_PROGRESS)
 *    goes through `ledger.once(idempotencyKey(...))`, so recovery after a crash
 *    replays recorded results instead of repeating them;
 *  - only `completed` unlocks dependents, and only after an acceptance gate
 *    decision that the controller re-checks deterministically.
 */
import {
  GoalStudioFailure,
  idempotencyKey,
  type AcceptanceGateDecision,
  type EvidenceRecord,
  type GoalController,
  type GoalGraphDefinition,
  type GoalGraphRevisionRecord,
  type GoalPhase,
  type GoalRunId,
  type GoalRunLedger,
  type GoalRunStatus,
  type GoalStudioDeps,
  type GoalStudioError,
  type GoalStudioEventType,
  type GoalStudioServices,
  type GoalTarget,
  type ModelRouteDecision,
  type PromptDefinition,
  type RecoveryDecision,
  type ResourceLimits,
  type RunLease,
  type TargetAttempt,
  type TargetId,
  type TargetLedgerEntry,
  type TargetStatus,
  type TargetTransition,
  type GraphId,
  type GraphRevision,
} from '../contracts.js';
import { assertTargetTransition, compareTargets, computeCriticality, eligibleTargets, newlyUnlockedTargets } from './eligibility.js';

export type GoalControllerDeps = GoalStudioDeps & {
  services: Omit<GoalStudioServices, 'controller'>;
  /** Stable identity of this controller process (lease holder). */
  holderId: string;
  /** Run lease TTL; renewed every ttl/3 while the run is driven. Default 60s. */
  leaseTtlMs?: number;
};

export type ApprovalKind = 'execute' | 'complete';

export interface ApprovalResolution {
  granted: boolean;
  principal: string;
  reason?: string;
}

/** Controller surface beyond the contract; see agent-03 report for proposals. */
export interface ContinuousGoalController extends GoalController {
  /** Human resolution of a pending approval scoped to (run, target, attempt, kind). */
  resolveApproval(runId: GoalRunId, targetId: TargetId, resolution: ApprovalResolution): Promise<GoalRunLedger>;
  /** Resolves once this process stops driving the run (idle, paused, stopped, completed). */
  settled(runId: GoalRunId): Promise<GoalRunLedger | undefined>;
  /** Targets this process currently has in flight for the run. */
  activeTargets(runId: GoalRunId): TargetId[];
  /** Stop driving every run. `releaseLeases: false` simulates a crash (tests). */
  shutdown(options?: { releaseLeases?: boolean }): Promise<void>;
}

const DEFAULT_LEASE_TTL_MS = 60_000;
const COMMIT_RETRIES = 8;
const CONTROLLER_ACTOR = 'controller';

const RUN_TRANSITIONS: Readonly<Record<GoalRunStatus, readonly GoalRunStatus[]>> = {
  created: ['running', 'paused', 'stopping', 'stopped', 'failed'],
  running: ['pausing', 'paused', 'stopping', 'stopped', 'idle', 'completed', 'failed'],
  pausing: ['paused', 'running', 'stopping', 'stopped', 'failed'],
  paused: ['running', 'stopping', 'stopped', 'failed'],
  stopping: ['stopped', 'failed'],
  idle: ['running', 'paused', 'stopping', 'stopped', 'completed', 'failed'],
  stopped: [],
  completed: [],
  failed: [],
};

const TERMINAL_RUN: readonly GoalRunStatus[] = ['stopped', 'completed', 'failed'];
/** Target statuses that represent an attempt in flight (resumable after a crash). */
const IN_FLIGHT: readonly TargetStatus[] = ['active', 'verifying', 'verified'];

type AbortReason = 'stop' | 'shutdown' | 'lease-lost' | 'deadline';

interface Driver {
  runId: GoalRunId;
  lease: RunLease;
  active: Map<TargetId, AbortController>;
  preferred: TargetId[];
  holds: number;
  wakePending: boolean;
  wakeFn?: () => void;
  commitChain: Promise<unknown>;
  disposed: boolean;
  lost: boolean;
  renewTimer?: ReturnType<typeof setInterval>;
  loop?: Promise<void>;
  graph?: GoalGraphDefinition;
}

interface CommitPlan {
  transitions: TargetTransition[];
  mutate: (ledger: GoalRunLedger) => void;
  after?: (ledger: GoalRunLedger) => void;
}

class AttemptAborted extends Error {
  constructor(readonly reason: AbortReason) {
    super(`attempt aborted: ${reason}`);
  }
}

function isFailure(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

function toError(err: unknown, fallback: GoalStudioError['code'] = 'EXECUTION_FAILED'): GoalStudioError {
  if (err instanceof GoalStudioFailure) return err.toJSON();
  if (typeof err === 'object' && err !== null && typeof (err as GoalStudioError).code === 'string' && typeof (err as GoalStudioError).message === 'string') {
    const e = err as GoalStudioError;
    return { code: e.code, message: e.message, retryable: Boolean(e.retryable), details: e.details };
  }
  return { code: fallback, message: err instanceof Error ? err.message : String(err), retryable: false };
}

export function humanActor(principal: string): string {
  const p = principal.trim();
  if (!p) throw new GoalStudioFailure('UNAUTHORIZED', 'A principal is required for control-plane actions');
  return p.startsWith('user:') ? p : `user:${p}`;
}

export function attemptIdFor(runId: GoalRunId, targetId: TargetId, attempt: number): string {
  return `${runId}:${targetId}:${attempt}`;
}

function approvalMarker(state: 'pending' | 'granted' | 'denied', kind: ApprovalKind, attempt: number, scope?: string): string {
  return `approval:${state}:${kind}:${attempt}:${scope ?? ''}`;
}

function parseApprovalMarker(marker: string): { state: string; kind: ApprovalKind; attempt: number; scope: string } | undefined {
  const m = /^approval:(pending|granted|denied):(execute|complete):(\d+):(.*)$/.exec(marker);
  if (!m) return undefined;
  return { state: m[1], kind: m[2] as ApprovalKind, attempt: Number(m[3]), scope: m[4] };
}

function limitsOf(graph: GoalGraphDefinition): ResourceLimits {
  return graph.constitution.resourceLimits;
}

export function createGoalController(deps: GoalControllerDeps): ContinuousGoalController {
  const { services, holderId } = deps;
  const { ledger, graphs, events, governance, router, prompts, executor, verification, recovery } = services;
  const clock = deps.clock ?? (() => new Date());
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const drivers = new Map<GoalRunId, Driver>();
  const settledWaiters = new Map<GoalRunId, Array<() => void>>();
  let shutDown = false;

  const nowIso = () => clock().toISOString();

  // -------------------------------------------------------------------------
  // Events & audit (never allowed to break control flow).
  // -------------------------------------------------------------------------

  async function emit(type: GoalStudioEventType, runId: GoalRunId, data: Record<string, unknown>, ids: { targetId?: TargetId; attemptId?: string; executionId?: string } = {}): Promise<void> {
    try {
      await events.append({ type, runId, ...ids, data });
    } catch {
      // Event log failures must not corrupt ledger progress.
    }
  }

  async function audit(type: GoalStudioEventType, runId: GoalRunId, data: Record<string, unknown>, targetId?: TargetId): Promise<void> {
    try {
      await governance.audit({ seq: 0, type, runId, targetId, timestamp: nowIso(), data });
    } catch {
      // Audit sink failures are reported by governance itself.
    }
  }

  // -------------------------------------------------------------------------
  // Graph loading (pinned revision + digest check).
  // -------------------------------------------------------------------------

  async function loadGraph(run: GoalRunLedger): Promise<GoalGraphDefinition> {
    const record = await graphs.getRevision(run.graphId, run.graphRevision);
    if (!record) throw new GoalStudioFailure('NOT_FOUND', `Graph ${run.graphId} revision ${run.graphRevision} not found`);
    if (record.digest !== run.graphDigest) {
      throw new GoalStudioFailure('INTERNAL', `Pinned graph digest mismatch for ${run.graphId}@${run.graphRevision}`, {
        details: { expected: run.graphDigest, actual: record.digest },
      });
    }
    return record.definition;
  }

  async function requireRun(runId: GoalRunId): Promise<GoalRunLedger> {
    const run = await ledger.getRun(runId);
    if (!run) throw new GoalStudioFailure('NOT_FOUND', `Goal run '${runId}' not found`);
    return run;
  }

  function targetOf(graph: GoalGraphDefinition, targetId: TargetId): GoalTarget {
    const target = graph.targets.find((t) => t.id === targetId);
    if (!target) throw new GoalStudioFailure('NOT_FOUND', `Target '${targetId}' is not in the pinned graph`);
    return target;
  }

  // -------------------------------------------------------------------------
  // Ledger commits: serialized per run, CAS with retry, fenced by the lease.
  // -------------------------------------------------------------------------

  function commit(d: Driver, plan: (fresh: GoalRunLedger) => CommitPlan | undefined): Promise<GoalRunLedger> {
    const next = d.commitChain.then(async () => {
      for (let attempt = 0; ; attempt++) {
        if (d.disposed || d.lost) throw new AttemptAborted(d.lost ? 'lease-lost' : 'shutdown');
        const fresh = await requireRun(d.runId);
        const p = plan(structuredClone(fresh));
        if (!p) return fresh;
        try {
          const committed = await ledger.commit(d.runId, fresh.ledgerRevision, d.lease, p.mutate, p.transitions);
          p.after?.(committed);
          return committed;
        } catch (err) {
          if (isFailure(err, 'STALE_LEASE')) {
            markLost(d);
            throw err;
          }
          if (isFailure(err, 'LEDGER_CONFLICT') && attempt < COMMIT_RETRIES) continue;
          throw err;
        }
      }
    });
    d.commitChain = next.catch(() => undefined);
    return next;
  }

  /** Builds the transition record + entry mutation for one target status change. */
  function change(
    fresh: GoalRunLedger,
    targetId: TargetId,
    to: TargetStatus,
    reason: string,
    actor: string,
    extra: { attemptId?: string; evidenceIds?: string[]; entry?: (e: TargetLedgerEntry) => void } = {},
  ): { transition: TargetTransition; apply: (l: GoalRunLedger) => void } {
    const from = fresh.targets[targetId]?.status ?? 'queued';
    assertTargetTransition(targetId, from, to, actor);
    const timestamp = nowIso();
    return {
      transition: {
        runId: fresh.runId,
        targetId,
        fromState: from,
        toState: to,
        reason,
        actor,
        timestamp,
        ...(extra.attemptId ? { attemptId: extra.attemptId } : {}),
        ...(extra.evidenceIds?.length ? { evidenceIds: extra.evidenceIds } : {}),
      },
      apply: (l) => {
        const entry = (l.targets[targetId] ??= emptyEntry(targetId, timestamp));
        entry.status = to;
        entry.updatedAt = timestamp;
        if (extra.evidenceIds?.length) entry.evidenceIds = [...extra.evidenceIds];
        extra.entry?.(entry);
        l.updatedAt = timestamp;
      },
    };
  }

  function emptyEntry(targetId: TargetId, at: string): TargetLedgerEntry {
    return { targetId, status: 'queued', attempts: 0, repairs: 0, evidenceIds: [], blockers: [], updatedAt: at };
  }

  async function transitionTarget(
    d: Driver,
    targetId: TargetId,
    to: TargetStatus,
    reason: string,
    actor: string,
    extra: { attemptId?: string; evidenceIds?: string[]; entry?: (e: TargetLedgerEntry) => void; run?: (l: GoalRunLedger) => void; onlyFrom?: readonly TargetStatus[] } = {},
  ): Promise<GoalRunLedger> {
    let transition: TargetTransition | undefined;
    const committed = await commit(d, (fresh) => {
      const from = fresh.targets[targetId]?.status ?? 'queued';
      if (from === to) return undefined;
      if (extra.onlyFrom && !extra.onlyFrom.includes(from)) return undefined;
      const c = change(fresh, targetId, to, reason, actor, extra);
      transition = c.transition;
      return { transitions: [c.transition], mutate: (l) => { c.apply(l); extra.run?.(l); } };
    });
    if (transition) await emitTransition(transition);
    return committed;
  }

  async function emitTransition(t: TargetTransition): Promise<void> {
    await emit('target.transition', t.runId, { from: t.fromState, to: t.toState, reason: t.reason, actor: t.actor, evidenceIds: t.evidenceIds ?? [] }, { targetId: t.targetId, attemptId: t.attemptId });
  }

  async function setRunStatus(d: Driver, to: GoalRunStatus, reason: string, actor: string, extra?: (l: GoalRunLedger) => void): Promise<GoalRunLedger> {
    let from: GoalRunStatus | undefined;
    const committed = await commit(d, (fresh) => {
      from = fresh.status;
      if (fresh.status === to && !extra) return undefined;
      if (fresh.status !== to && !RUN_TRANSITIONS[fresh.status].includes(to)) {
        throw new GoalStudioFailure('VALIDATION', `Illegal run transition ${fresh.status} -> ${to}`, { details: { runId: d.runId, from: fresh.status, to } });
      }
      return {
        transitions: [],
        mutate: (l) => {
          l.status = to;
          l.updatedAt = nowIso();
          extra?.(l);
        },
      };
    });
    if (from !== to) await emit('run.status', d.runId, { from, to, reason, actor });
    return committed;
  }

  // -------------------------------------------------------------------------
  // Drivers: one per run this process holds the lease for.
  // -------------------------------------------------------------------------

  function markLost(d: Driver): void {
    if (d.lost) return;
    d.lost = true;
    for (const ac of d.active.values()) ac.abort('lease-lost' satisfies AbortReason);
    wake(d);
  }

  function wake(d: Driver): void {
    d.wakePending = true;
    const fn = d.wakeFn;
    d.wakeFn = undefined;
    fn?.();
  }

  function waitForWake(d: Driver): Promise<void> {
    if (d.wakePending) {
      d.wakePending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      d.wakeFn = () => {
        d.wakePending = false;
        resolve();
      };
    });
  }

  async function ensureDriver(runId: GoalRunId): Promise<Driver> {
    if (shutDown) throw new GoalStudioFailure('CANCELLED', 'Goal controller is shut down');
    const existing = drivers.get(runId);
    if (existing && !existing.disposed && !existing.lost) return existing;
    if (existing) await existing.loop?.catch(() => undefined);
    const again = drivers.get(runId);
    if (again && !again.disposed && !again.lost) return again;
    const lease = await ledger.acquireLease(runId, holderId, leaseTtlMs);
    if (!lease) {
      throw new GoalStudioFailure('STALE_LEASE', `Goal run '${runId}' is driven by another controller`, { retryable: true, details: { runId } });
    }
    const d: Driver = {
      runId,
      lease,
      active: new Map(),
      preferred: [],
      holds: 0,
      wakePending: true,
      commitChain: Promise.resolve(),
      disposed: false,
      lost: false,
    };
    d.renewTimer = setInterval(() => {
      if (d.disposed || d.lost) return;
      ledger.renewLease(d.lease, leaseTtlMs).then(
        (renewed) => { d.lease = renewed; },
        () => markLost(d),
      );
    }, Math.max(10, Math.floor(leaseTtlMs / 3)));
    d.renewTimer.unref?.();
    drivers.set(runId, d);
    d.loop = runLoop(d).finally(async () => {
      if (d.renewTimer) clearInterval(d.renewTimer);
      if (drivers.get(runId) === d) drivers.delete(runId);
      if (!d.lost && !d.disposed) {
        await ledger.releaseLease(d.lease).catch(() => undefined);
      }
      d.disposed = true;
      const waiters = settledWaiters.get(runId) ?? [];
      settledWaiters.delete(runId);
      for (const w of waiters) w();
    });
    return d;
  }

  /** Runs a control-plane action against a driven run, keeping the driver alive. */
  async function withDriver<T>(runId: GoalRunId, fn: (d: Driver) => Promise<T>): Promise<T> {
    const d = await ensureDriver(runId);
    d.holds++;
    try {
      return await fn(d);
    } finally {
      d.holds--;
      wake(d);
    }
  }

  // -------------------------------------------------------------------------
  // Main loop: SELECT_TARGET → … → SELECT_NEXT_TARGET until nothing to do.
  // -------------------------------------------------------------------------

  async function runLoop(d: Driver): Promise<void> {
    try {
      for (;;) {
        await waitForWake(d);
        if (d.disposed || d.lost) return;
        const run = await requireRun(d.runId);
        let graph: GoalGraphDefinition;
        try {
          graph = d.graph ?? (d.graph = await loadGraph(run));
        } catch (err) {
          if (!TERMINAL_RUN.includes(run.status)) {
            await setRunStatus(d, 'failed', toError(err, 'INTERNAL').message, CONTROLLER_ACTOR);
            await emit('error', d.runId, { error: toError(err, 'INTERNAL') });
          }
          return;
        }
        const exit = await step(d, run, graph);
        if (exit && d.holds === 0 && !d.wakePending && d.active.size === 0) return;
      }
    } catch (err) {
      if (err instanceof AttemptAborted || isFailure(err, 'STALE_LEASE')) return;
      await emit('error', d.runId, { error: toError(err, 'INTERNAL'), phase: 'LOAD_LEDGER' });
    }
  }

  /** One scheduling pass. Returns true when the loop may exit (nothing in flight). */
  async function step(d: Driver, run: GoalRunLedger, graph: GoalGraphDefinition): Promise<boolean> {
    const limits = limitsOf(graph);
    switch (run.status) {
      case 'completed':
      case 'stopped':
      case 'failed':
      case 'paused':
        return true;
      case 'pausing':
        if (d.active.size === 0) {
          await setRunStatus(d, 'paused', 'pause requested; no target in flight', CONTROLLER_ACTOR);
          return true;
        }
        return false;
      case 'stopping':
        for (const ac of d.active.values()) ac.abort('stop' satisfies AbortReason);
        if (d.active.size === 0) {
          await setRunStatus(d, 'stopped', 'stop requested', CONTROLLER_ACTOR);
          return true;
        }
        return false;
      case 'created':
        await setRunStatus(d, 'running', 'run started', CONTROLLER_ACTOR);
        wake(d);
        return false;
      case 'idle':
      case 'running':
        break;
    }

    // LOAD_LEDGER: emit phase marker, then UNLOCK_DEPENDENCIES for anything newly unlocked.
    await emit('target.phase', d.runId, { phase: 'LOAD_LEDGER' satisfies GoalPhase, ledgerRevision: run.ledgerRevision, status: run.status });
    run = await unlockDependencies(d, run, graph);

    // Deadline (maxRunMinutes) is enforced deterministically from the ledger.
    const deadline = Date.parse(run.resource.deadlineAt);
    if (Number.isFinite(deadline) && clock().getTime() >= deadline) {
      await emit('run.status', d.runId, { limit: 'maxRunMinutes', deadlineAt: run.resource.deadlineAt });
      if (run.status === 'idle') await setRunStatus(d, 'running', 'deadline handling', CONTROLLER_ACTOR);
      await setRunStatus(d, 'stopping', 'limit: maxRunMinutes deadline reached', CONTROLLER_ACTOR);
      for (const ac of d.active.values()) ac.abort('deadline' satisfies AbortReason);
      wake(d);
      return false;
    }

    // SELECT_TARGET: in-flight resumes first, then repairs, then new eligible work.
    const maxConcurrent = Math.max(1, limits.maxConcurrentTargets ?? 1);
    const criticality = computeCriticality(graph);
    const order = (ids: TargetId[]) => ids
      .map((id) => targetOf(graph, id))
      .sort((a, b) => compareTargets(a, b, criticality))
      .map((t) => t.id);
    const entries = Object.values(run.targets);
    const resumable = order(entries.filter((e) => IN_FLIGHT.includes(e.status) && !d.active.has(e.targetId)).map((e) => e.targetId));
    const repairing = order(entries.filter((e) => e.status === 'repairing' && !d.active.has(e.targetId)).map((e) => e.targetId));
    const eligible = eligibleTargets(run, graph).filter((id) => !d.active.has(id));
    const preferred = d.preferred.filter((id) => eligible.includes(id));
    const fresh = [...preferred, ...eligible.filter((id) => !preferred.includes(id))];

    let budgetBlocked = false;
    let launched = false;
    for (const targetId of resumable) {
      if (d.active.size >= maxConcurrent) break;
      if (run.status === 'idle') run = await setRunStatus(d, 'running', 'resuming in-flight target', CONTROLLER_ACTOR);
      launch(d, targetId, run.targets[targetId].attempts, graph);
      launched = true;
    }
    for (const targetId of [...repairing, ...fresh]) {
      if (d.active.size >= maxConcurrent) break;
      if (run.resource.tasksStarted >= limits.maxTasksPerRun) {
        budgetBlocked = true;
        break;
      }
      if (run.status === 'idle') run = await setRunStatus(d, 'running', 'eligible work available', CONTROLLER_ACTOR);
      const started = await startAttempt(d, targetId, graph);
      if (!started) {
        budgetBlocked = true;
        break;
      }
      run = started.run;
      d.preferred = d.preferred.filter((id) => id !== targetId);
      await emit('target.phase', d.runId, { phase: 'SELECT_TARGET' satisfies GoalPhase, rationale: started.rationale }, { targetId, attemptId: started.attemptId });
      launch(d, targetId, started.attempt, graph);
      launched = true;
    }
    if (launched || d.active.size > 0) return false;

    // Nothing in flight and nothing launched: decide the run outcome.
    const all = Object.values(run.targets);
    const allCompleted = graph.targets.every((t) => run.targets[t.id]?.status === 'completed');
    if (allCompleted) {
      await setRunStatus(d, 'completed', 'all targets completed with independent evidence', CONTROLLER_ACTOR);
      return true;
    }
    const pendingWork = repairing.length + eligibleTargets(run, graph).length;
    if (budgetBlocked && pendingWork > 0) {
      await emit('run.status', d.runId, { limit: 'maxTasksPerRun', tasksStarted: run.resource.tasksStarted, maxTasksPerRun: limits.maxTasksPerRun });
      if (run.status === 'idle') await setRunStatus(d, 'running', 'limit handling', CONTROLLER_ACTOR);
      await setRunStatus(d, 'stopping', 'limit: maxTasksPerRun reached', CONTROLLER_ACTOR);
      await setRunStatus(d, 'stopped', 'limit: maxTasksPerRun reached', CONTROLLER_ACTOR);
      return true;
    }
    if (run.status !== 'idle') {
      await setRunStatus(d, 'idle', 'no eligible target; non-terminal targets remain', CONTROLLER_ACTOR);
      await emit('run.idle', d.runId, idleSummary(all));
    }
    return true;
  }

  function idleSummary(entries: TargetLedgerEntry[]): Record<string, unknown> {
    const by = (s: TargetStatus) => entries.filter((e) => e.status === s).map((e) => e.targetId).sort();
    return {
      completed: by('completed'),
      blocked: by('blocked'),
      needsApproval: by('needs_approval'),
      awaitingExternal: by('awaiting_external'),
      queued: by('queued'),
      blockers: Object.fromEntries(entries.filter((e) => e.blockers.length > 0).map((e) => [e.targetId, e.blockers])),
    };
  }

  async function unlockDependencies(d: Driver, run: GoalRunLedger, graph: GoalGraphDefinition): Promise<GoalRunLedger> {
    if (newlyUnlockedTargets(run, graph).length === 0) return run;
    let transitions: TargetTransition[] = [];
    const committed = await commit(d, (fresh) => {
      const ids = newlyUnlockedTargets(fresh, graph);
      if (ids.length === 0) return undefined;
      const changes = ids.map((id) => change(fresh, id, 'eligible', `dependencies completed: ${targetOf(graph, id).dependsOn.join(', ') || '(none)'}`, CONTROLLER_ACTOR));
      transitions = changes.map((c) => c.transition);
      return { transitions, mutate: (l) => { for (const c of changes) c.apply(l); } };
    });
    for (const t of transitions) {
      await emitTransition(t);
      await emit('target.phase', d.runId, { phase: 'UNLOCK_DEPENDENCIES' satisfies GoalPhase }, { targetId: t.targetId });
    }
    return committed;
  }

  /** Commits the start of an attempt (→ active), enforcing maxTasksPerRun in the same CAS. */
  async function startAttempt(d: Driver, targetId: TargetId, graph: GoalGraphDefinition): Promise<{ run: GoalRunLedger; attempt: number; attemptId: string; rationale: Record<string, unknown> } | undefined> {
    const limits = limitsOf(graph);
    let attemptNo = 0;
    let transition: TargetTransition | undefined;
    let rationale: Record<string, unknown> = {};
    const committed = await commit(d, (fresh) => {
      const entry = fresh.targets[targetId] ?? emptyEntry(targetId, nowIso());
      const reuse = entry.status === 'eligible' && entry.attempts > 0 && entry.blockers.some((b) => {
        const m = parseApprovalMarker(b);
        return m?.state === 'granted' && m.kind === 'execute' && m.attempt === entry.attempts;
      });
      if (!reuse && fresh.resource.tasksStarted >= limits.maxTasksPerRun) return undefined;
      attemptNo = reuse ? entry.attempts : entry.attempts + 1;
      const attemptId = attemptIdFor(fresh.runId, targetId, attemptNo);
      const crit = computeCriticality(graph).get(targetId);
      rationale = { priority: targetOf(graph, targetId).priority, ...crit, resumedAfterApproval: reuse, fromStatus: entry.status };
      const c = change(fresh, targetId, 'active', reuse ? 'approved attempt resumed' : entry.status === 'repairing' ? 'RETEST after repair' : 'selected: highest critical-path impact among eligible', CONTROLLER_ACTOR, {
        attemptId,
        entry: (e) => {
          e.attempts = attemptNo;
          e.lastAttemptId = attemptId;
        },
      });
      transition = c.transition;
      return {
        transitions: [c.transition],
        mutate: (l) => {
          c.apply(l);
          if (!reuse) l.resource.tasksStarted += 1;
        },
      };
    });
    if (!transition) return undefined;
    await emitTransition(transition);
    return { run: committed, attempt: attemptNo, attemptId: attemptIdFor(d.runId, targetId, attemptNo), rationale };
  }

  function launch(d: Driver, targetId: TargetId, attemptNo: number, graph: GoalGraphDefinition): void {
    const ac = new AbortController();
    d.active.set(targetId, ac);
    void runAttempt(d, targetId, attemptNo, graph, ac.signal)
      .catch(async (err) => {
        if (err instanceof AttemptAborted || isFailure(err, 'STALE_LEASE') || d.disposed || d.lost) return;
        // An unexpected controller error is recorded and the target blocked so it
        // cannot spin; unrelated work continues.
        const error = toError(err, 'INTERNAL');
        await emit('error', d.runId, { error }, { targetId });
        await blockTarget(d, targetId, attemptNo, `controller error: ${error.message}`, [], error).catch(() => undefined);
      })
      .finally(() => {
        if (d.active.get(targetId) === ac) d.active.delete(targetId);
        wake(d);
      });
  }

  // -------------------------------------------------------------------------
  // One target attempt.
  // -------------------------------------------------------------------------

  async function phase(d: Driver, attempt: TargetAttempt, p: GoalPhase, data: Record<string, unknown> = {}): Promise<void> {
    attempt.phase = p;
    await ledger.saveAttempt(attempt);
    await emit('target.phase', d.runId, { phase: p, attempt: attempt.attempt, ...data }, { targetId: attempt.targetId, attemptId: attempt.id, executionId: attempt.executionId });
  }

  function checkAbort(d: Driver, signal: AbortSignal): void {
    if (d.disposed) throw new AttemptAborted('shutdown');
    if (d.lost) throw new AttemptAborted('lease-lost');
    if (signal.aborted) throw new AttemptAborted((signal.reason as AbortReason) ?? 'stop');
  }

  async function loadAttempt(runId: GoalRunId, targetId: TargetId, attemptNo: number): Promise<TargetAttempt> {
    const id = attemptIdFor(runId, targetId, attemptNo);
    const existing = (await ledger.attempts(runId, targetId)).find((a) => a.id === id);
    return existing ?? { id, runId, targetId, attempt: attemptNo, phase: 'PLAN_TASK', startedAt: nowIso() };
  }

  function grantedApproval(entry: TargetLedgerEntry, kind: ApprovalKind | 'any', attemptNo?: number): boolean {
    return entry.blockers.some((b) => {
      const m = parseApprovalMarker(b);
      return m?.state === 'granted' && (kind === 'any' || m.kind === kind) && (attemptNo === undefined || m.attempt === attemptNo);
    });
  }

  async function runAttempt(d: Driver, targetId: TargetId, attemptNo: number, graph: GoalGraphDefinition, signal: AbortSignal): Promise<void> {
    const target = targetOf(graph, targetId);
    const limits = limitsOf(graph);
    const attempt = await loadAttempt(d.runId, targetId, attemptNo);
    try {
      let run = await requireRun(d.runId);
      const resumedStatus = run.targets[targetId]?.status;
      await emit('attempt.started', d.runId, { attempt: attemptNo, resumedFrom: resumedStatus, repairHypothesis: attempt.repairHypothesis }, { targetId, attemptId: attempt.id });

      // PLAN_TASK: resolve the specialist prompt (pinned by version on the attempt).
      let prompt: PromptDefinition | undefined;
      if (attempt.promptRef) prompt = await prompts.get(attempt.promptRef.promptId, attempt.promptRef.version);
      prompt ??= await prompts.latest(target.executor);
      if (prompt) attempt.promptRef = { promptId: prompt.id, version: prompt.version };
      await phase(d, attempt, 'PLAN_TASK', { executor: target.executor, prompt: attempt.promptRef ?? null, artifacts: target.artifacts, acceptance: target.acceptance });
      checkAbort(d, signal);

      // PREFLIGHT: deterministic policy/resource gate (governance).
      await phase(d, attempt, 'PREFLIGHT');
      const pre = await governance.preflight({ run, target, principal: run.createdBy });
      checkAbort(d, signal);
      if (pre.effect === 'deny') {
        await emit('governance.denied', d.runId, { phase: 'PREFLIGHT', reasons: pre.reasons }, { targetId, attemptId: attempt.id });
        await audit('governance.denied', d.runId, { phase: 'PREFLIGHT', reasons: pre.reasons, attemptId: attempt.id }, targetId);
        await blockTarget(d, targetId, attemptNo, `preflight denied: ${pre.reasons.join('; ')}`, [], { code: 'POLICY_DENIED', message: pre.reasons.join('; '), retryable: false }, attempt);
        return;
      }
      if (pre.effect === 'ask' && !grantedApproval(run.targets[targetId], 'execute', attemptNo)) {
        await awaitApproval(d, targetId, attempt, 'execute', pre.approvalScope, pre.reasons);
        return;
      }

      // ROUTE_MODEL: local-first, hosted only within the authorized spend.
      await phase(d, attempt, 'ROUTE_MODEL');
      const remaining = Math.max(0, limits.hostedSpendUsd - run.resource.hostedSpendUsd);
      const route = await router.route({
        requiredCapabilities: prompt?.requiredCapabilities ?? [],
        remainingHostedBudgetUsd: remaining,
        localFirst: limits.localModelFirst,
      });
      checkAbort(d, signal);
      if (!route) {
        await failAttempt(d, target, attempt, graph, { error: { code: 'NO_ROUTE', message: 'No verified-ready model satisfies the requirements and budget', retryable: true } });
        return;
      }
      attempt.modelRoute = route;
      await ledger.saveAttempt(attempt);
      await emit('route.decided', d.runId, { ...route }, { targetId, attemptId: attempt.id });
      if (route.hosted) {
        if (route.estimatedCostUsd > remaining) {
          await blockTarget(d, targetId, attemptNo, `hosted spend ${route.estimatedCostUsd} exceeds remaining budget ${remaining}`, [], { code: 'BUDGET_EXCEEDED', message: 'hosted spend exceeds budget', retryable: false }, attempt);
          return;
        }
        const spend = governance.authorizeSpend(run, route.estimatedCostUsd);
        if (spend.effect === 'deny') {
          await emit('governance.denied', d.runId, { phase: 'ROUTE_MODEL', reasons: spend.reasons, spendUsd: route.estimatedCostUsd }, { targetId, attemptId: attempt.id });
          await audit('governance.denied', d.runId, { phase: 'ROUTE_MODEL', reasons: spend.reasons }, targetId);
          await blockTarget(d, targetId, attemptNo, `hosted spend denied: ${spend.reasons.join('; ')}`, [], { code: 'BUDGET_EXCEEDED', message: spend.reasons.join('; '), retryable: false }, attempt);
          return;
        }
        if (spend.effect === 'ask' && !grantedApproval(run.targets[targetId], 'execute', attemptNo)) {
          await awaitApproval(d, targetId, attempt, 'execute', spend.approvalScope, spend.reasons);
          return;
        }
      }

      // EXECUTE: exactly once per (run, target, attempt).
      await phase(d, attempt, 'EXECUTE', { modelId: route.modelId, runtimeId: route.runtimeId, hosted: route.hosted });
      const execKey = idempotencyKey(d.runId, targetId, attemptNo, 'EXECUTE');
      let execResult: { executionId: string; ok: boolean; summary: string; error?: GoalStudioError };
      try {
        const { result, replayed } = await ledger.once(execKey, async () => {
          const r = await executor.execute({
            key: execKey,
            run,
            target,
            attempt: structuredClone(attempt),
            prompt,
            route,
            workspaceRoot: deps.workspaceRoot,
            signal,
            onEvent: (event) => {
              void emit('execution.event', d.runId, { ...event.data, sourceType: event.type }, { targetId, attemptId: attempt.id, executionId: event.executionId });
            },
          });
          return { executionId: r.executionId, ok: r.ok, summary: r.summary, ...(r.error ? { error: toError(r.error) } : {}) };
        });
        execResult = result;
        if (replayed) await emit('target.phase', d.runId, { phase: 'EXECUTE', replayed: true }, { targetId, attemptId: attempt.id, executionId: result.executionId });
      } catch (err) {
        checkAbort(d, signal);
        execResult = { executionId: attempt.executionId ?? '', ok: false, summary: '', error: toError(err) };
      }
      checkAbort(d, signal);
      attempt.executionId = execResult.executionId || attempt.executionId;
      await ledger.saveAttempt(attempt);
      run = await transitionTarget(d, targetId, 'verifying', execResult.ok ? 'execution finished; awaiting independent verification' : 'execution failed', CONTROLLER_ACTOR, {
        attemptId: attempt.id,
        onlyFrom: ['active'],
        entry: (e) => { if (execResult.executionId) e.lastExecutionId = execResult.executionId; },
        run: (l) => { if (route.hosted) l.resource.hostedSpendUsd += route.estimatedCostUsd; },
      });
      if (!execResult.ok) {
        await failAttempt(d, target, attempt, graph, { error: execResult.error ?? { code: 'EXECUTION_FAILED', message: execResult.summary || 'execution failed', retryable: true } });
        return;
      }

      // CHALLENGE + INDEPENDENT_VERIFY: the verification service runs adversarial
      // review and deterministic checks; executor self-reports are never evidence.
      await phase(d, attempt, 'CHALLENGE', { executorIdentity: route.modelId });
      await phase(d, attempt, 'INDEPENDENT_VERIFY');
      const verifyKey = idempotencyKey(d.runId, targetId, attemptNo, 'INDEPENDENT_VERIFY');
      const { result: evidence } = await ledger.once(verifyKey, () => verification.verify({ run, target, attempt: structuredClone(attempt), workspaceRoot: deps.workspaceRoot, executorIdentity: route.modelId }));
      checkAbort(d, signal);
      for (const ev of evidence) {
        await emit('verification.evidence', d.runId, { evidenceId: ev.id, verdict: ev.verdict, criterion: ev.criterion ?? null, validationMethod: ev.validationMethod, validatorIdentity: ev.validatorIdentity }, { targetId, attemptId: attempt.id, executionId: attempt.executionId });
      }

      // ACCEPTANCE_GATE: verification's decision, re-checked deterministically here.
      await phase(d, attempt, 'ACCEPTANCE_GATE');
      const gate = verification.gate({ run, target, attempt: structuredClone(attempt), evidence });
      const enforced = enforceGate(gate, evidence, target, route.modelId, run.targets[targetId]);
      await emit('gate.decided', d.runId, { decision: gate.decision, enforcedDecision: enforced.decision, reasons: [...gate.reasons, ...enforced.reasons], perCriterion: gate.perCriterion }, { targetId, attemptId: attempt.id });
      const evidenceIds = evidence.map((e) => e.id);
      checkAbort(d, signal);

      switch (enforced.decision) {
        case 'completed':
          await commitProgress(d, target, attempt, evidenceIds, CONTROLLER_ACTOR, 'acceptance gate: all criteria PASS with independent evidence');
          return;
        case 'needs_approval':
          await transitionTarget(d, targetId, 'verified', 'independently verified; human sign-off required', 'verifier', { attemptId: attempt.id, evidenceIds, onlyFrom: ['verifying'] });
          await awaitApproval(d, targetId, attempt, 'complete', undefined, enforced.reasons.length ? enforced.reasons : gate.reasons);
          return;
        case 'awaiting_external':
          await transitionTarget(d, targetId, 'awaiting_external', `awaiting attributable external evidence: ${[...gate.reasons, ...enforced.reasons].join('; ')}`, 'verifier', { attemptId: attempt.id, evidenceIds });
          attempt.endedAt = nowIso();
          await phase(d, attempt, 'RECORD_EVIDENCE', { evidenceIds });
          return;
        case 'blocked':
          await blockTarget(d, targetId, attemptNo, `acceptance gate blocked: ${[...gate.reasons, ...enforced.reasons].join('; ')}`, evidenceIds, { code: 'VERIFICATION_FAILED', message: gate.reasons.join('; '), retryable: false }, attempt);
          return;
        case 'repair':
          await failAttempt(d, target, attempt, graph, { gate, error: { code: 'VERIFICATION_FAILED', message: [...gate.reasons, ...enforced.reasons].join('; ') || 'acceptance gate failed', retryable: true } });
          return;
      }
    } catch (err) {
      if (err instanceof AttemptAborted) {
        if (err.reason === 'stop' || err.reason === 'deadline') {
          await stopTarget(d, targetId, attempt, err.reason).catch(() => undefined);
          return;
        }
        throw err;
      }
      throw err;
    }
  }

  /** Deterministic defense-in-depth over the verification gate. */
  function enforceGate(gate: AcceptanceGateDecision, evidence: EvidenceRecord[], target: GoalTarget, executorIdentity: string, entry: TargetLedgerEntry | undefined): { decision: AcceptanceGateDecision['decision']; reasons: string[] } {
    if (gate.decision !== 'completed') return { decision: gate.decision, reasons: [] };
    const reasons: string[] = [];
    const byId = new Map(evidence.map((e) => [e.id, e]));
    if (gate.perCriterion.length < target.acceptance.length) reasons.push(`gate covered ${gate.perCriterion.length} of ${target.acceptance.length} acceptance criteria`);
    for (const c of gate.perCriterion) {
      if (c.verdict !== 'PASS') reasons.push(`criterion not PASS: ${c.criterion}`);
      if (c.evidenceIds.length === 0) reasons.push(`criterion has no evidence: ${c.criterion}`);
      for (const id of c.evidenceIds) {
        const ev = byId.get(id);
        if (!ev) reasons.push(`evidence ${id} not produced by this verification`);
        else if (ev.verdict !== 'PASS') reasons.push(`evidence ${id} verdict ${ev.verdict}`);
        else if (ev.validatorIdentity === ev.executorIdentity || ev.validatorIdentity === executorIdentity) reasons.push(`evidence ${id} is not independent of the executor`);
      }
    }
    if (reasons.length > 0) return { decision: 'repair', reasons };
    if (target.externalDependency && !evidence.some((e) => e.verdict === 'PASS' && (e.validationMethod === 'external-record' || e.validationMethod === 'human-signoff'))) {
      return { decision: 'awaiting_external', reasons: ['external dependency requires an external-record or human-signoff PASS'] };
    }
    if (target.requiresApproval && !(entry && grantedApproval(entry, 'any'))) {
      return { decision: 'needs_approval', reasons: ['target requires explicit human approval before completion'] };
    }
    return { decision: 'completed', reasons: [] };
  }

  /** COMMIT_PROGRESS → UNLOCK_DEPENDENCIES → SELECT_NEXT_TARGET. */
  async function commitProgress(d: Driver, target: GoalTarget, attempt: TargetAttempt, evidenceIds: string[], actor: string, reason: string): Promise<void> {
    await phase(d, attempt, 'COMMIT_PROGRESS', { evidenceIds });
    const key = idempotencyKey(d.runId, target.id, attempt.attempt, 'COMMIT_PROGRESS');
    let transitions: TargetTransition[] = [];
    await ledger.once(key, async () => {
      const committed = await commit(d, (fresh) => {
        const status = fresh.targets[target.id]?.status;
        if (status === 'completed') return undefined;
        const changes = [];
        let interim = fresh;
        if (status === 'verifying') {
          const v = change(fresh, target.id, 'verified', 'independent verification passed', 'verifier', { attemptId: attempt.id, evidenceIds });
          changes.push(v);
          interim = structuredClone(fresh);
          v.apply(interim);
        }
        const c = change(interim, target.id, 'completed', reason, actor, {
          attemptId: attempt.id,
          evidenceIds,
          entry: (e) => { e.blockers = e.blockers.filter((b) => !b.startsWith('approval:pending:')); },
        });
        changes.push(c);
        transitions = changes.map((x) => x.transition);
        return { transitions, mutate: (l) => { for (const x of changes) x.apply(l); } };
      });
      return { ledgerRevision: committed.ledgerRevision };
    });
    for (const t of transitions) await emitTransition(t);
    attempt.outcome = 'succeeded';
    attempt.endedAt = nowIso();
    await ledger.saveAttempt(attempt);
    await emit('attempt.finished', d.runId, { outcome: 'succeeded', evidenceIds }, { targetId: target.id, attemptId: attempt.id, executionId: attempt.executionId });
    // UNLOCK_DEPENDENCIES happens in the loop's next pass, which runs immediately.
    await emit('target.phase', d.runId, { phase: 'SELECT_NEXT_TARGET' satisfies GoalPhase }, { targetId: target.id, attemptId: attempt.id });
  }

  async function awaitApproval(d: Driver, targetId: TargetId, attempt: TargetAttempt, kind: ApprovalKind, scope: string | undefined, reasons: string[]): Promise<void> {
    await phase(d, attempt, 'AWAIT_APPROVAL', { kind, scope: scope ?? null, reasons });
    await transitionTarget(d, targetId, 'needs_approval', `approval required (${kind}): ${reasons.join('; ')}`, 'governance', {
      attemptId: attempt.id,
      entry: (e) => {
        e.blockers = [...e.blockers.filter((b) => !b.startsWith('approval:pending:')), approvalMarker('pending', kind, attempt.attempt, scope)];
      },
    });
    attempt.outcome = 'awaiting_approval';
    await phase(d, attempt, 'PERSIST_STATE', { kind });
    await emit('approval.requested', d.runId, { kind, scope: scope ?? null, attempt: attempt.attempt, reasons }, { targetId, attemptId: attempt.id });
    await audit('approval.requested', d.runId, { kind, scope: scope ?? null, attempt: attempt.attempt, reasons }, targetId);
  }

  async function blockTarget(d: Driver, targetId: TargetId, attemptNo: number, reason: string, evidenceIds: string[], error: GoalStudioError, attempt?: TargetAttempt): Promise<void> {
    const a = attempt ?? (await loadAttempt(d.runId, targetId, attemptNo));
    await phase(d, a, 'BLOCK_TARGET', { reason });
    await transitionTarget(d, targetId, 'blocked', reason, CONTROLLER_ACTOR, {
      attemptId: a.id,
      evidenceIds,
      entry: (e) => { e.blockers = [...e.blockers, `${error.code}: ${reason}`]; },
    });
    a.outcome = 'blocked';
    a.error = error;
    a.endedAt = nowIso();
    await phase(d, a, 'RECORD_EVIDENCE', { evidenceIds, error });
    await emit('attempt.finished', d.runId, { outcome: 'blocked', reason, error }, { targetId, attemptId: a.id, executionId: a.executionId });
  }

  async function stopTarget(d: Driver, targetId: TargetId, attempt: TargetAttempt, reason: AbortReason): Promise<void> {
    await transitionTarget(d, targetId, 'stopped', reason === 'deadline' ? 'limit: maxRunMinutes deadline reached' : 'run stopped by operator', CONTROLLER_ACTOR, { attemptId: attempt.id });
    attempt.outcome = 'cancelled';
    attempt.endedAt = nowIso();
    attempt.error = { code: 'CANCELLED', message: `attempt cancelled (${reason})`, retryable: false };
    await ledger.saveAttempt(attempt);
    await emit('attempt.finished', d.runId, { outcome: 'cancelled', reason }, { targetId, attemptId: attempt.id, executionId: attempt.executionId });
  }

  /** FAIL → DIAGNOSE → REPAIR_HYPOTHESIS → REPLAN → (RETEST via loop) or BLOCK_TARGET. */
  async function failAttempt(d: Driver, target: GoalTarget, attempt: TargetAttempt, graph: GoalGraphDefinition, input: { gate?: AcceptanceGateDecision; error: GoalStudioError }): Promise<void> {
    const limits = limitsOf(graph);
    await transitionTarget(d, target.id, 'failed', input.error.message, input.gate ? 'verifier' : CONTROLLER_ACTOR, { attemptId: attempt.id, onlyFrom: ['active', 'verifying', 'verified'] });
    attempt.outcome = 'failed';
    attempt.error = input.error;
    attempt.endedAt = nowIso();
    await ledger.saveAttempt(attempt);
    await emit('attempt.finished', d.runId, { outcome: 'failed', error: input.error }, { targetId: target.id, attemptId: attempt.id, executionId: attempt.executionId });

    await phase(d, attempt, 'DIAGNOSE');
    const run = await requireRun(d.runId);
    const prior = (await ledger.attempts(d.runId, target.id)).filter((a) => a.attempt < attempt.attempt).sort((a, b) => a.attempt - b.attempt);
    const diagKey = idempotencyKey(d.runId, target.id, attempt.attempt, 'DIAGNOSE');
    let decision: RecoveryDecision;
    try {
      decision = (await ledger.once(diagKey, () => recovery.decide({ run, target, attempt: structuredClone(attempt), priorAttempts: prior, gate: input.gate, error: input.error }))).result;
    } catch (err) {
      const e = toError(err, 'INTERNAL');
      decision = { action: 'block', failureClass: 'unknown', diagnosis: `recovery unavailable: ${e.message}`, failureSignature: 'recovery-error', reasons: [e.message] };
    }
    attempt.error = { ...input.error, details: { ...(input.error.details ?? {}), failureSignature: decision.failureSignature, failureClass: decision.failureClass } };
    await ledger.saveAttempt(attempt);
    await emit('recovery.decided', d.runId, { ...decision }, { targetId: target.id, attemptId: attempt.id });

    const entry = run.targets[target.id];
    const signatures = [...prior, attempt].map((a) => (a.error?.details as { failureSignature?: string } | undefined)?.failureSignature);
    let sameInARow = 0;
    for (let i = signatures.length - 1; i >= 0 && signatures[i] === decision.failureSignature; i--) sameInARow++;

    let blockReason: string | undefined;
    let blockCode: GoalStudioError['code'] = 'RETRY_EXHAUSTED';
    if (decision.action === 'block') {
      blockReason = `recovery decided block (${decision.failureClass}): ${decision.diagnosis}`;
      blockCode = input.error.code === 'POLICY_DENIED' ? 'POLICY_DENIED' : 'RETRY_EXHAUSTED';
    } else if (entry.repairs >= limits.maxRepairsPerTask) {
      blockReason = `repair budget exhausted (${entry.repairs}/${limits.maxRepairsPerTask})`;
    } else if (limits.maxSameActionNoProgress > 0 && sameInARow >= limits.maxSameActionNoProgress) {
      blockReason = `no progress: failure signature '${decision.failureSignature}' repeated ${sameInARow} times`;
      blockCode = 'NO_PROGRESS';
    } else if (decision.action === 'repair') {
      const hypothesis = decision.hypothesis?.trim();
      const priorHypotheses = new Set([...prior, attempt].map((a) => a.repairHypothesis?.trim()).filter(Boolean));
      if (!hypothesis) blockReason = 'repair requested without a hypothesis';
      else if (priorHypotheses.has(hypothesis)) {
        blockReason = `no novel repair hypothesis (repeated: ${hypothesis})`;
        blockCode = 'NO_PROGRESS';
      }
    }
    if (blockReason) {
      await blockTarget(d, target.id, attempt.attempt, blockReason, [], { code: blockCode, message: blockReason, retryable: false }, attempt);
      return;
    }

    const hypothesis = decision.action === 'repair' ? decision.hypothesis!.trim() : `retry after ${decision.failureClass} failure: ${decision.diagnosis}`;
    await phase(d, attempt, 'REPAIR_HYPOTHESIS', { hypothesis, action: decision.action });
    await transitionTarget(d, target.id, 'repairing', `${decision.action}: ${hypothesis}`, 'recovery', {
      attemptId: attempt.id,
      entry: (e) => { e.repairs += 1; },
    });
    // REPLAN: the next attempt is recorded durably with its hypothesis before it runs.
    const next: TargetAttempt = { id: attemptIdFor(d.runId, target.id, attempt.attempt + 1), runId: d.runId, targetId: target.id, attempt: attempt.attempt + 1, phase: 'REPLAN', repairHypothesis: hypothesis, startedAt: nowIso() };
    await ledger.saveAttempt(next);
    await emit('target.phase', d.runId, { phase: 'REPLAN' satisfies GoalPhase, hypothesis, nextAttempt: next.attempt }, { targetId: target.id, attemptId: next.id });
    await emit('target.phase', d.runId, { phase: 'RETEST' satisfies GoalPhase, nextAttempt: next.attempt }, { targetId: target.id, attemptId: next.id });
  }

  // -------------------------------------------------------------------------
  // Public API.
  // -------------------------------------------------------------------------

  async function startRun(input: { graphId: GraphId; graphRevision?: GraphRevision; principal: string }): Promise<GoalRunLedger> {
    const actor = humanActor(input.principal);
    const record: GoalGraphRevisionRecord | undefined = await graphs.getRevision(input.graphId, input.graphRevision);
    if (!record) throw new GoalStudioFailure('NOT_FOUND', `Graph '${input.graphId}'${input.graphRevision ? ` revision ${input.graphRevision}` : ''} not found`);
    const validation = graphs.validate(record.definition);
    if (!validation.valid) throw new GoalStudioFailure('VALIDATION', 'Graph is invalid; refusing to start a run', { details: { issues: validation.issues } });
    const created = await ledger.createRun({ graph: record, createdBy: actor });
    await emit('run.created', created.runId, { graphId: record.graphId, graphRevision: record.revision, graphDigest: record.digest, createdBy: actor });
    await audit('run.created', created.runId, { graphId: record.graphId, graphRevision: record.revision, actor });
    return withDriver(created.runId, async (d) => {
      d.graph = record.definition;
      const limits = limitsOf(record.definition);
      const startedAt = clock();
      await commit(d, (fresh) => ({
        transitions: [],
        mutate: (l) => {
          const at = startedAt.toISOString();
          for (const t of record.definition.targets) l.targets[t.id] ??= emptyEntry(t.id, at);
          if (!l.resource.startedAt || !Number.isFinite(Date.parse(l.resource.startedAt))) l.resource.startedAt = at;
          if (!Number.isFinite(Date.parse(l.resource.deadlineAt))) {
            l.resource.deadlineAt = new Date(Date.parse(l.resource.startedAt) + limits.maxRunMinutes * 60_000).toISOString();
          }
          void fresh;
        },
      }));
      const run = await setRunStatus(d, 'running', 'run started', actor);
      return unlockDependencies(d, run, record.definition);
    });
  }

  async function pause(runId: GoalRunId, principal: string): Promise<GoalRunLedger> {
    const actor = humanActor(principal);
    await audit('run.status', runId, { action: 'pause', actor });
    return withDriver(runId, async (d) => {
      const run = await requireRun(runId);
      if (run.status === 'paused' || run.status === 'pausing') return run;
      return setRunStatus(d, d.active.size > 0 ? 'pausing' : 'paused', `paused by ${actor}`, actor);
    });
  }

  async function resume(runId: GoalRunId, principal: string): Promise<GoalRunLedger> {
    const actor = humanActor(principal);
    await audit('run.status', runId, { action: 'resume', actor });
    return withDriver(runId, async (d) => {
      const run = await requireRun(runId);
      if (TERMINAL_RUN.includes(run.status) || run.status === 'stopping') {
        throw new GoalStudioFailure('VALIDATION', `Cannot resume a run in status '${run.status}'`);
      }
      if (run.status === 'running') return run;
      return setRunStatus(d, 'running', `resumed by ${actor}`, actor);
    });
  }

  async function stop(runId: GoalRunId, principal: string): Promise<GoalRunLedger> {
    const actor = humanActor(principal);
    await audit('run.status', runId, { action: 'stop', actor });
    return withDriver(runId, async (d) => {
      const run = await requireRun(runId);
      if (TERMINAL_RUN.includes(run.status)) return run;
      for (const ac of d.active.values()) ac.abort('stop' satisfies AbortReason);
      if (d.active.size === 0) return setRunStatus(d, 'stopped', `stopped by ${actor}`, actor);
      return setRunStatus(d, 'stopping', `stop requested by ${actor}`, actor);
    });
  }

  async function retryTarget(runId: GoalRunId, targetId: TargetId, principal: string): Promise<GoalRunLedger> {
    const actor = humanActor(principal);
    await audit('target.transition', runId, { action: 'retryTarget', actor }, targetId);
    return withDriver(runId, async (d) => {
      const run = await requireRun(runId);
      const graph = d.graph ?? (d.graph = await loadGraph(run));
      targetOf(graph, targetId);
      if (TERMINAL_RUN.includes(run.status)) throw new GoalStudioFailure('VALIDATION', `Cannot retry a target in a ${run.status} run`);
      const status = run.targets[targetId]?.status;
      if (!status || !['failed', 'blocked', 'awaiting_external', 'stopped'].includes(status)) {
        throw new GoalStudioFailure('VALIDATION', `Target '${targetId}' is ${status ?? 'unknown'}; only failed, blocked, awaiting_external or stopped targets can be retried`);
      }
      await transitionTarget(d, targetId, 'eligible', `retry requested by ${actor}`, actor, {
        entry: (e) => {
          e.repairs = 0;
          e.blockers = e.blockers.filter((b) => b.startsWith('approval:granted:'));
        },
      });
      const after = await requireRun(runId);
      return after.status === 'idle' ? setRunStatus(d, 'running', `retry requested by ${actor}`, actor) : after;
    });
  }

  async function runEligible(runId: GoalRunId, targetId: TargetId, principal: string): Promise<GoalRunLedger> {
    const actor = humanActor(principal);
    await audit('target.phase', runId, { action: 'runEligible', actor }, targetId);
    return withDriver(runId, async (d) => {
      const run = await requireRun(runId);
      const graph = d.graph ?? (d.graph = await loadGraph(run));
      targetOf(graph, targetId);
      if (!['running', 'idle', 'created'].includes(run.status)) {
        throw new GoalStudioFailure('VALIDATION', `Cannot run a target while the run is ${run.status}`);
      }
      if (!eligibleTargets(run, graph).includes(targetId)) {
        throw new GoalStudioFailure('VALIDATION', `Target '${targetId}' is not eligible (status ${run.targets[targetId]?.status ?? 'unknown'}; dependencies must be completed)`);
      }
      d.preferred = [targetId, ...d.preferred.filter((id) => id !== targetId)];
      return run.status === 'running' ? run : setRunStatus(d, 'running', `runEligible(${targetId}) by ${actor}`, actor);
    });
  }

  async function resolveApproval(runId: GoalRunId, targetId: TargetId, resolution: ApprovalResolution): Promise<GoalRunLedger> {
    const actor = humanActor(resolution.principal);
    return withDriver(runId, async (d) => {
      const run = await requireRun(runId);
      const graph = d.graph ?? (d.graph = await loadGraph(run));
      targetOf(graph, targetId);
      const entry = run.targets[targetId];
      const pending = entry?.status === 'needs_approval' ? entry.blockers.map(parseApprovalMarker).find((m) => m?.state === 'pending') : undefined;
      if (!entry || !pending) throw new GoalStudioFailure('VALIDATION', `Target '${targetId}' has no pending approval`);
      if (pending.attempt !== entry.attempts) throw new GoalStudioFailure('VALIDATION', 'Approval is scoped to a different attempt');
      const pendingMarker = approvalMarker('pending', pending.kind, pending.attempt, pending.scope || undefined);
      const resolvedMarker = approvalMarker(resolution.granted ? 'granted' : 'denied', pending.kind, pending.attempt, pending.scope || undefined);
      const swap = (e: TargetLedgerEntry) => { e.blockers = [...e.blockers.filter((b) => b !== pendingMarker), resolvedMarker]; };
      const attemptId = attemptIdFor(runId, targetId, pending.attempt);
      await emit('approval.resolved', runId, { granted: resolution.granted, kind: pending.kind, attempt: pending.attempt, scope: pending.scope || null, actor, reason: resolution.reason ?? null }, { targetId, attemptId });
      await audit('approval.resolved', runId, { granted: resolution.granted, kind: pending.kind, attempt: pending.attempt, actor }, targetId);
      if (!resolution.granted) {
        await transitionTarget(d, targetId, 'blocked', `approval denied by ${actor}${resolution.reason ? `: ${resolution.reason}` : ''}`, actor, { attemptId, entry: (e) => { swap(e); e.blockers.push(`APPROVAL_DENIED: ${actor}`); } });
      } else if (pending.kind === 'execute') {
        await transitionTarget(d, targetId, 'eligible', `execution approved by ${actor}`, actor, { attemptId, entry: swap });
      } else {
        const attempt = await loadAttempt(runId, targetId, pending.attempt);
        await commit(d, () => ({
          transitions: [],
          mutate: (l) => {
            const e = l.targets[targetId];
            if (e) {
              swap(e);
              e.updatedAt = nowIso();
              l.updatedAt = e.updatedAt;
            }
          },
        }));
        await commitProgress(d, targetOf(graph, targetId), attempt, entry.evidenceIds, actor, `completion approved by ${actor}`);
      }
      const after = await requireRun(runId);
      return after.status === 'idle' ? setRunStatus(d, 'running', `approval resolved by ${actor}`, actor) : after;
    });
  }

  async function recoverRuns(): Promise<GoalRunId[]> {
    const recovered: GoalRunId[] = [];
    for (const run of await ledger.listRuns()) {
      if (!['created', 'running', 'pausing', 'stopping', 'idle'].includes(run.status)) continue;
      try {
        const d = await ensureDriver(run.runId);
        await emit('run.status', run.runId, { recovered: true, holderId, ledgerRevision: run.ledgerRevision, status: run.status });
        wake(d);
        recovered.push(run.runId);
      } catch (err) {
        if (!isFailure(err, 'STALE_LEASE')) throw err;
      }
    }
    return recovered;
  }

  async function settled(runId: GoalRunId): Promise<GoalRunLedger | undefined> {
    const d = drivers.get(runId);
    if (d) await new Promise<void>((resolve) => { const list = settledWaiters.get(runId) ?? []; list.push(resolve); settledWaiters.set(runId, list); });
    return ledger.getRun(runId);
  }

  async function shutdown(options: { releaseLeases?: boolean } = {}): Promise<void> {
    shutDown = true;
    const all = [...drivers.values()];
    for (const d of all) {
      if (d.renewTimer) clearInterval(d.renewTimer);
      if (options.releaseLeases !== false) {
        await d.commitChain;
        await ledger.releaseLease(d.lease).catch(() => undefined);
      }
      d.disposed = true;
      for (const ac of d.active.values()) ac.abort('shutdown' satisfies AbortReason);
      wake(d);
    }
    await Promise.all(all.map((d) => d.loop?.catch(() => undefined)));
  }

  return {
    startRun,
    pause,
    resume,
    stop,
    retryTarget,
    runEligible,
    eligibleTargets: (run, graph) => eligibleTargets(run, graph),
    recoverRuns,
    resolveApproval,
    settled,
    activeTargets: (runId) => [...(drivers.get(runId)?.active.keys() ?? [])],
    shutdown,
  };
}
