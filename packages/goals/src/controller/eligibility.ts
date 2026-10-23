/**
 * Pure, deterministic scheduling helpers for the continuous goal controller.
 *
 * Nothing here performs I/O or consults model output. Given the same ledger and
 * graph, every function returns the same answer, which is what lets the
 * controller (not a model) decide what runs next.
 */
import {
  GoalStudioFailure,
  TERMINAL_TARGET_STATUSES,
  UNLOCKING_TARGET_STATUSES,
  type GoalGraphDefinition,
  type GoalRunLedger,
  type GoalTarget,
  type TargetId,
  type TargetStatus,
} from '../contracts.js';

/** Critical-path metrics for one target in the dependency DAG. */
export interface TargetCriticality {
  targetId: TargetId;
  /** Number of distinct targets that transitively depend on this one. */
  transitiveDependents: number;
  /** Length (in targets, excluding self) of the longest dependent chain downstream. */
  longestDownstreamChain: number;
}

/**
 * Computes critical-path impact for every target. Cycles are a graph validation
 * error (workstream 02); if one slips through, the traversal still terminates and
 * the cycle members simply do not count themselves.
 */
export function computeCriticality(graph: Pick<GoalGraphDefinition, 'targets'>): Map<TargetId, TargetCriticality> {
  const dependents = new Map<TargetId, TargetId[]>();
  for (const t of graph.targets) dependents.set(t.id, []);
  for (const t of graph.targets) {
    for (const dep of t.dependsOn) dependents.get(dep)?.push(t.id);
  }
  for (const list of dependents.values()) list.sort();

  const chainMemo = new Map<TargetId, number>();
  const chain = (id: TargetId, stack: Set<TargetId>): number => {
    const memo = chainMemo.get(id);
    if (memo !== undefined) return memo;
    if (stack.has(id)) return 0;
    stack.add(id);
    let best = 0;
    for (const d of dependents.get(id) ?? []) best = Math.max(best, 1 + chain(d, stack));
    stack.delete(id);
    chainMemo.set(id, best);
    return best;
  };

  const result = new Map<TargetId, TargetCriticality>();
  for (const t of graph.targets) {
    const seen = new Set<TargetId>();
    const queue = [...(dependents.get(t.id) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next) || next === t.id) continue;
      seen.add(next);
      queue.push(...(dependents.get(next) ?? []));
    }
    result.set(t.id, { targetId: t.id, transitiveDependents: seen.size, longestDownstreamChain: chain(t.id, new Set()) });
  }
  return result;
}

/** Deterministic comparator: critical-path impact, then priority, then id. */
export function compareTargets(a: GoalTarget, b: GoalTarget, criticality: Map<TargetId, TargetCriticality>): number {
  const ca = criticality.get(a.id);
  const cb = criticality.get(b.id);
  const dependents = (cb?.transitiveDependents ?? 0) - (ca?.transitiveDependents ?? 0);
  if (dependents !== 0) return dependents;
  const chainDiff = (cb?.longestDownstreamChain ?? 0) - (ca?.longestDownstreamChain ?? 0);
  if (chainDiff !== 0) return chainDiff;
  const priority = (b.priority ?? 0) - (a.priority ?? 0);
  if (priority !== 0) return priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function isTerminalTargetStatus(status: TargetStatus): boolean {
  return TERMINAL_TARGET_STATUSES.includes(status);
}

/** True only when every dependency is `completed` (never merely `verified`). */
export function dependenciesCompleted(run: GoalRunLedger, target: GoalTarget): boolean {
  return target.dependsOn.every((dep) => {
    const entry = run.targets[dep];
    return entry !== undefined && UNLOCKING_TARGET_STATUSES.includes(entry.status);
  });
}

/** Statuses from which a target may be newly selected for an attempt. */
const SELECTABLE: readonly TargetStatus[] = ['queued', 'eligible'];

/**
 * Pure: targets that may start a new attempt now, in deterministic priority order.
 * A target is eligible when it is `queued`/`eligible` (not terminal, not in
 * flight, not waiting) and all of its dependencies are `completed`.
 */
export function eligibleTargets(run: GoalRunLedger, graph: Pick<GoalGraphDefinition, 'targets'>): TargetId[] {
  const criticality = computeCriticality(graph);
  return graph.targets
    .filter((t) => {
      const status = run.targets[t.id]?.status ?? 'queued';
      return SELECTABLE.includes(status) && dependenciesCompleted(run, t);
    })
    .sort((a, b) => compareTargets(a, b, criticality))
    .map((t) => t.id);
}

/** Alias for `eligibleTargets` matching integration contract helper naming. */
export const computeEligibleTargets = eligibleTargets;

/** Queued targets whose dependencies just became `completed` (UNLOCK_DEPENDENCIES). */
export function newlyUnlockedTargets(run: GoalRunLedger, graph: Pick<GoalGraphDefinition, 'targets'>): TargetId[] {
  return eligibleTargets(run, graph).filter((id) => (run.targets[id]?.status ?? 'queued') === 'queued');
}

/**
 * Target state machine. The controller refuses any transition not listed here.
 * Human-only edges (`user:*` actor) are listed separately.
 */
export const TARGET_TRANSITIONS: Readonly<Record<TargetStatus, readonly TargetStatus[]>> = {
  queued: ['eligible', 'blocked', 'stopped'],
  eligible: ['active', 'queued', 'needs_approval', 'blocked', 'stopped'],
  active: ['verifying', 'failed', 'needs_approval', 'blocked', 'stopped'],
  verifying: ['verified', 'failed', 'awaiting_external', 'blocked', 'stopped'],
  verified: ['completed', 'needs_approval', 'awaiting_external', 'failed', 'blocked', 'stopped'],
  failed: ['repairing', 'blocked', 'stopped'],
  repairing: ['active', 'blocked', 'stopped'],
  needs_approval: ['eligible', 'completed', 'blocked', 'stopped'],
  awaiting_external: ['blocked', 'stopped'],
  blocked: [],
  completed: [],
  stopped: [],
};

/** Edges only a human principal (`user:*`) may take, e.g. retryTarget. */
export const HUMAN_TARGET_TRANSITIONS: Readonly<Partial<Record<TargetStatus, readonly TargetStatus[]>>> = {
  failed: ['eligible'],
  blocked: ['eligible'],
  awaiting_external: ['eligible'],
  stopped: ['eligible'],
  needs_approval: ['eligible', 'completed', 'blocked'],
};

export function canTransitionTarget(from: TargetStatus, to: TargetStatus, actor: string): boolean {
  if (TARGET_TRANSITIONS[from].includes(to)) {
    // Approval resolutions out of needs_approval into completed are human-only.
    if (from === 'needs_approval' && to === 'completed') return actor.startsWith('user:');
    return true;
  }
  return actor.startsWith('user:') && (HUMAN_TARGET_TRANSITIONS[from]?.includes(to) ?? false);
}

export function assertTargetTransition(targetId: TargetId, from: TargetStatus, to: TargetStatus, actor: string): void {
  if (!canTransitionTarget(from, to, actor)) {
    throw new GoalStudioFailure('VALIDATION', `Illegal target transition for '${targetId}': ${from} -> ${to} (actor ${actor})`, {
      details: { targetId, from, to, actor },
    });
  }
}
