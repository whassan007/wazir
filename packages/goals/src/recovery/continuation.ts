import type { GoalGraphDefinition, GoalRunLedger, GoalTarget, TargetId, TargetStatus } from '../contracts.js';

/** Statuses that will never unlock dependents in this run. */
const DEAD_END_STATUSES: ReadonlySet<TargetStatus> = new Set(['blocked', 'stopped']);
/** Statuses a target can be selected from once its dependencies are completed. */
const SELECTABLE_STATUSES: ReadonlySet<TargetStatus> = new Set(['queued', 'eligible']);
const IN_FLIGHT_STATUSES: ReadonlySet<TargetStatus> = new Set(['active', 'verifying', 'verified', 'repairing', 'failed']);

export interface UnreachableTarget {
  targetId: TargetId;
  /** Blocked/stopped targets that make this one unreachable (sorted). */
  blockedBy: TargetId[];
  /** Blocker text to add to the ledger entry. Status stays as is (queued), never failed. */
  reason: string;
}

export interface BlockedTargetContinuation {
  /** Blocked or stopped targets (including the newly blocked one). */
  deadEnds: TargetId[];
  /** Targets selectable now: dependencies completed, not unreachable. Priority desc, then id. */
  eligible: TargetId[];
  /** Non-terminal targets that can still complete in this run (including eligible and in-flight). */
  reachable: TargetId[];
  /** Non-terminal targets whose dependency chain contains a dead end. */
  unreachable: UnreachableTarget[];
  /** Nothing eligible and nothing in flight. */
  idle: boolean;
}

function statusOf(run: GoalRunLedger, id: TargetId, override: Map<TargetId, TargetStatus>): TargetStatus {
  return override.get(id) ?? run.targets?.[id]?.status ?? 'queued';
}

/**
 * Pure: given a run and its pinned graph, computes what may continue when targets are
 * blocked. A blocked target only affects its transitive dependents (which stay queued
 * with a blocker reason); every unrelated target keeps its eligibility.
 *
 * `newlyBlocked` lets the caller plan before committing the block to the ledger.
 */
export function planBlockedTargetContinuation(run: GoalRunLedger, graph: GoalGraphDefinition, newlyBlocked: TargetId | TargetId[] = []): BlockedTargetContinuation {
  const override = new Map<TargetId, TargetStatus>();
  for (const id of Array.isArray(newlyBlocked) ? newlyBlocked : [newlyBlocked]) override.set(id, 'blocked');
  const byId = new Map<TargetId, GoalTarget>(graph.targets.map((t) => [t.id, t]));
  const status = (id: TargetId) => statusOf(run, id, override);

  // deadEndAncestors(id): dead-end targets reachable through dependsOn (memoized DFS, cycle safe).
  const memo = new Map<TargetId, Set<TargetId>>();
  const visiting = new Set<TargetId>();
  const deadEndAncestors = (id: TargetId): Set<TargetId> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const out = new Set<TargetId>();
    if (visiting.has(id)) return out;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) { out.add(dep); continue; } // unknown dependency can never complete
      if (status(dep) === 'completed') continue;
      if (DEAD_END_STATUSES.has(status(dep))) out.add(dep);
      for (const a of deadEndAncestors(dep)) out.add(a);
    }
    visiting.delete(id);
    memo.set(id, out);
    return out;
  };

  const deadEnds: TargetId[] = [];
  const eligible: GoalTarget[] = [];
  const reachable: TargetId[] = [];
  const unreachable: UnreachableTarget[] = [];
  let inFlight = 0;
  for (const target of graph.targets) {
    const s = status(target.id);
    if (DEAD_END_STATUSES.has(s)) { deadEnds.push(target.id); continue; }
    if (s === 'completed') continue;
    const blockers = [...deadEndAncestors(target.id)].sort();
    if (blockers.length > 0) {
      unreachable.push({ targetId: target.id, blockedBy: blockers, reason: `unreachable: dependency ${blockers.join(', ')} blocked or stopped` });
      continue;
    }
    reachable.push(target.id);
    if (IN_FLIGHT_STATUSES.has(s)) inFlight += 1;
    if (SELECTABLE_STATUSES.has(s) && target.dependsOn.every((dep) => status(dep) === 'completed')) eligible.push(target);
  }
  eligible.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  return { deadEnds: deadEnds.sort(), eligible: eligible.map((t) => t.id), reachable: reachable.sort(), unreachable, idle: eligible.length === 0 && inFlight === 0 };
}

/**
 * Ledger mutator for use inside `GoalLedgerStore.commit`: records the unreachable
 * reason on each dependent's blockers without changing its status. Idempotent.
 */
export function applyBlockedContinuation(ledger: GoalRunLedger, plan: BlockedTargetContinuation, now: string): void {
  for (const item of plan.unreachable) {
    const entry = ledger.targets[item.targetId];
    if (!entry) continue;
    const next = [...entry.blockers.filter((b) => !b.startsWith('unreachable: ')), item.reason];
    if (next.length === entry.blockers.length && next.every((b, i) => b === entry.blockers[i])) continue;
    entry.blockers = next;
    entry.updatedAt = now;
  }
}
