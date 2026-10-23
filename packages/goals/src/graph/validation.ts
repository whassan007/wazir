import { GoalStudioFailure } from '../contracts.js';
import type {
  GoalGraphDefinition,
  GoalTarget,
  GraphValidationIssue,
  GraphValidationResult,
  ResourceLimits,
  TargetId,
} from '../contracts.js';

/** Target ids appear in store keys, URLs and idempotency keys (`:`-separated), so keep them simple. */
export const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Execution-graph node ids / executor keys. */
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_TARGETS = 2000;
export const MAX_EXECUTION_NODES = 500;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Validates a graph definition. Pure and total: never throws, and is safe on
 * untrusted JSON (e.g. an HTTP body), reporting type errors as SCHEMA issues.
 */
export function validateGoalGraph(definition: unknown): GraphValidationResult {
  const issues: GraphValidationIssue[] = [];
  const add = (issue: GraphValidationIssue) => issues.push(issue);

  if (!isObject(definition)) {
    add({ code: 'SCHEMA', message: 'definition must be an object', path: '' });
    return { valid: false, issues };
  }
  const def = definition as Partial<GoalGraphDefinition> & Record<string, unknown>;
  if (!nonEmptyString(def.schemaVersion)) add({ code: 'SCHEMA', message: 'schemaVersion must be a non-empty string', path: 'schemaVersion' });
  if (!nonEmptyString(def.name)) add({ code: 'SCHEMA', message: 'name must be a non-empty string', path: 'name' });
  if (def.purpose !== undefined && typeof def.purpose !== 'string') add({ code: 'SCHEMA', message: 'purpose must be a string', path: 'purpose' });

  validateConstitution(def.constitution, add);

  // Execution graph first: executor checks need its node set.
  const nodeIds = validateExecutionGraph(def.executionGraph, add);

  if (!Array.isArray(def.targets)) {
    add({ code: 'SCHEMA', message: 'targets must be an array', path: 'targets' });
    return { valid: false, issues };
  }
  if (def.targets.length === 0) add({ code: 'SCHEMA', message: 'targets must contain at least one target', path: 'targets' });
  if (def.targets.length > MAX_TARGETS) add({ code: 'SCHEMA', message: `targets exceeds ${MAX_TARGETS}`, path: 'targets' });

  const seen = new Map<string, number>();
  const wellFormed: GoalTarget[] = [];
  def.targets.forEach((raw, i) => {
    const path = `targets[${i}]`;
    if (!isObject(raw)) {
      add({ code: 'SCHEMA', message: 'target must be an object', path });
      return;
    }
    const t = raw as Partial<GoalTarget>;
    let ok = true;
    const schema = (field: string, message: string) => {
      ok = false;
      add({ code: 'SCHEMA', message, path: `${path}.${field}`, targetIds: typeof t.id === 'string' ? [t.id] : undefined });
    };
    if (typeof t.id !== 'string' || !TARGET_ID_PATTERN.test(t.id)) schema('id', `target id must match ${TARGET_ID_PATTERN}`);
    if (!nonEmptyString(t.stage)) schema('stage', 'stage must be a non-empty string');
    if (!nonEmptyString(t.title)) schema('title', 'title must be a non-empty string');
    if (!isStringArray(t.dependsOn)) schema('dependsOn', 'dependsOn must be an array of target ids');
    else if (new Set(t.dependsOn).size !== t.dependsOn.length) schema('dependsOn', 'dependsOn contains duplicate entries');
    if (typeof t.priority !== 'number' || !Number.isFinite(t.priority)) schema('priority', 'priority must be a finite number');
    if (!nonEmptyString(t.executor)) schema('executor', 'executor must be a non-empty string');
    if (!isStringArray(t.artifacts)) schema('artifacts', 'artifacts must be an array of strings');
    if (!isStringArray(t.acceptance) || t.acceptance.length === 0 || t.acceptance.some((a) => a.trim() === '')) {
      schema('acceptance', 'acceptance must be a non-empty array of non-empty criteria (a target without criteria can never be verified)');
    }
    if (t.externalDependency !== undefined && typeof t.externalDependency !== 'boolean') schema('externalDependency', 'externalDependency must be a boolean');
    if (t.requiresApproval !== undefined && typeof t.requiresApproval !== 'boolean') schema('requiresApproval', 'requiresApproval must be a boolean');

    if (typeof t.id === 'string') {
      if (seen.has(t.id)) {
        ok = false;
        add({ code: 'DUPLICATE_TARGET', message: `duplicate target id "${t.id}" (also at targets[${seen.get(t.id)}])`, path: `${path}.id`, targetIds: [t.id] });
      } else {
        seen.set(t.id, i);
      }
    }
    if (nonEmptyString(t.executor) && nodeIds && !nodeIds.has(t.executor)) {
      add({ code: 'UNKNOWN_EXECUTOR', message: `target "${t.id}" executor "${t.executor}" is not an execution-graph node`, path: `${path}.executor`, targetIds: typeof t.id === 'string' ? [t.id] : undefined });
    }
    if (ok) wellFormed.push(t as GoalTarget);
  });

  // Dependency references.
  const ids = new Set(seen.keys());
  for (const t of wellFormed) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) {
        add({ code: 'SELF_DEPENDENCY', message: `target "${t.id}" depends on itself`, path: `targets[${seen.get(t.id)}].dependsOn`, targetIds: [t.id] });
      } else if (!ids.has(dep)) {
        add({ code: 'UNKNOWN_DEPENDENCY', message: `target "${t.id}" depends on unknown target "${dep}"`, path: `targets[${seen.get(t.id)}].dependsOn`, targetIds: [t.id, dep] });
      }
    }
  }

  for (const cycle of findCycles(wellFormed)) {
    add({ code: 'CYCLE', message: `dependency cycle: ${cycle.join(' -> ')}`, path: 'targets', targetIds: cycle });
  }

  return { valid: issues.length === 0, issues };
}

function validateConstitution(c: unknown, add: (i: GraphValidationIssue) => void): void {
  if (!isObject(c)) {
    add({ code: 'SCHEMA', message: 'constitution must be an object', path: 'constitution' });
    return;
  }
  if (c.objectiveOwner !== 'human') add({ code: 'SCHEMA', message: 'constitution.objectiveOwner must be "human"', path: 'constitution.objectiveOwner' });
  for (const field of ['invariants', 'allowedUnattended', 'needsApproval'] as const) {
    if (!isStringArray(c[field])) add({ code: 'SCHEMA', message: `constitution.${field} must be an array of strings`, path: `constitution.${field}` });
  }
  validateLimits(c.resourceLimits, add);
}

const INTEGER_LIMITS: Array<{ key: keyof ResourceLimits; min: number; optional?: boolean }> = [
  { key: 'maxTasksPerRun', min: 1 },
  { key: 'maxRepairsPerTask', min: 0 },
  { key: 'maxSameActionNoProgress', min: 1 },
  { key: 'maxRunMinutes', min: 1 },
  { key: 'maxConcurrentWritersPerWorktree', min: 1 },
  { key: 'maxConcurrentTargets', min: 1, optional: true },
];

export function validateLimits(limits: unknown, add: (i: GraphValidationIssue) => void): void {
  const base = 'constitution.resourceLimits';
  if (!isObject(limits)) {
    add({ code: 'SCHEMA', message: `${base} must be an object`, path: base });
    return;
  }
  for (const { key, min, optional } of INTEGER_LIMITS) {
    const v = limits[key];
    if (v === undefined && optional) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) {
      add({ code: 'INVALID_LIMIT', message: `${key} must be an integer >= ${min} (got ${JSON.stringify(v)})`, path: `${base}.${key}` });
    }
  }
  const spend = limits.hostedSpendUsd;
  if (typeof spend !== 'number' || !Number.isFinite(spend) || spend < 0) {
    add({ code: 'INVALID_LIMIT', message: `hostedSpendUsd must be a finite number >= 0 (got ${JSON.stringify(spend)})`, path: `${base}.hostedSpendUsd` });
  }
  if (typeof limits.localModelFirst !== 'boolean') {
    add({ code: 'INVALID_LIMIT', message: 'localModelFirst must be a boolean', path: `${base}.localModelFirst` });
  }
  const known = new Set<string>([...INTEGER_LIMITS.map((l) => l.key as string), 'hostedSpendUsd', 'localModelFirst']);
  for (const key of Object.keys(limits)) {
    if (!known.has(key)) add({ code: 'INVALID_LIMIT', message: `unknown resource limit "${key}"`, path: `${base}.${key}` });
  }
}

/** Returns the node-id set when the execution graph is structurally usable. */
function validateExecutionGraph(g: unknown, add: (i: GraphValidationIssue) => void): Set<string> | undefined {
  const base = 'executionGraph';
  if (!isObject(g)) {
    add({ code: 'SCHEMA', message: `${base} must be an object`, path: base });
    return undefined;
  }
  if (!Array.isArray(g.nodes)) {
    add({ code: 'SCHEMA', message: `${base}.nodes must be an array`, path: `${base}.nodes` });
    return undefined;
  }
  if (g.nodes.length > MAX_EXECUTION_NODES) add({ code: 'SCHEMA', message: `${base}.nodes exceeds ${MAX_EXECUTION_NODES}`, path: `${base}.nodes` });
  const ids = new Set<string>();
  g.nodes.forEach((n, i) => {
    if (!isObject(n) || typeof n.id !== 'string' || !NODE_ID_PATTERN.test(n.id)) {
      add({ code: 'SCHEMA', message: `execution node id must match ${NODE_ID_PATTERN}`, path: `${base}.nodes[${i}]` });
      return;
    }
    if (ids.has(n.id)) add({ code: 'SCHEMA', message: `duplicate execution node "${n.id}"`, path: `${base}.nodes[${i}].id` });
    ids.add(n.id);
    if (!isStringArray(n.next)) add({ code: 'SCHEMA', message: `execution node "${n.id}" next must be an array of node ids`, path: `${base}.nodes[${i}].next` });
    if (n.promptId !== undefined && !nonEmptyString(n.promptId)) add({ code: 'SCHEMA', message: `execution node "${n.id}" promptId must be a non-empty string`, path: `${base}.nodes[${i}].promptId` });
  });
  g.nodes.forEach((n, i) => {
    if (!isObject(n) || !isStringArray(n.next)) return;
    for (const next of n.next) {
      if (!ids.has(next)) add({ code: 'SCHEMA', message: `execution node "${String(n.id)}" points to unknown node "${next}"`, path: `${base}.nodes[${i}].next` });
    }
  });
  if (typeof g.entry !== 'string' || !ids.has(g.entry)) add({ code: 'SCHEMA', message: `${base}.entry must name an execution node`, path: `${base}.entry` });
  return ids;
}

/**
 * All dependency cycles (one representative path per strongly connected
 * component), each as `[a, b, ..., a]`. Self-dependencies are excluded (they
 * are reported as SELF_DEPENDENCY). Unknown dependencies are ignored.
 */
export function findCycles(targets: Array<Pick<GoalTarget, 'id' | 'dependsOn'>>): TargetId[][] {
  const ids = new Set(targets.map((t) => t.id));
  const deps = new Map<string, string[]>();
  for (const t of targets) deps.set(t.id, (t.dependsOn ?? []).filter((d) => d !== t.id && ids.has(d)));

  // Tarjan's SCC (iterative to avoid stack overflow on long chains).
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  const order = [...ids].sort();
  for (const root of order) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; i: number }> = [{ node: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const edges = deps.get(frame.node)!;
      if (frame.i < edges.length) {
        const next = edges[frame.i++];
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter++);
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, i: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp: string[] = [];
        let n: string;
        do {
          n = stack.pop()!;
          onStack.delete(n);
          comp.push(n);
        } while (n !== frame.node);
        if (comp.length > 1) components.push(comp);
      }
    }
  }

  // Extract one concrete cycle path inside each component (BFS back to the start).
  return components
    .map((comp) => {
      const members = new Set(comp);
      const start = [...comp].sort()[0];
      const prev = new Map<string, string>();
      const queue = [start];
      const visited = new Set([start]);
      while (queue.length) {
        const cur = queue.shift()!;
        for (const d of deps.get(cur)!) {
          if (!members.has(d)) continue;
          if (d === start) {
            const path = [start];
            let p: string | undefined = cur;
            const back: string[] = [];
            while (p !== undefined && p !== start) {
              back.push(p);
              p = prev.get(p);
            }
            path.push(...back.reverse(), start);
            return path;
          }
          if (!visited.has(d)) {
            visited.add(d);
            prev.set(d, cur);
            queue.push(d);
          }
        }
      }
      return [...comp, comp[0]];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function assertValid(definition: GoalGraphDefinition): void {
  const result = validateGoalGraph(definition);
  if (!result.valid) {
    throw new GoalStudioFailure('VALIDATION', `invalid goal graph: ${result.issues[0].message}`, { details: { issues: result.issues } });
  }
}

const byPriorityThenId = (a: GoalTarget, b: GoalTarget) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Deterministic topological order (dependencies first). Among targets that
 * are simultaneously ready, higher priority first, then id. Throws
 * GoalStudioFailure VALIDATION for an invalid graph (cycle, unknown dependency...).
 */
export function topologicalOrder(definition: GoalGraphDefinition): TargetId[] {
  assertValid(definition);
  return topoTargets(definition.targets).map((t) => t.id);
}

function topoTargets(targets: GoalTarget[]): GoalTarget[] {
  const remaining = new Map(targets.map((t) => [t.id, new Set(t.dependsOn)]));
  const byId = new Map(targets.map((t) => [t.id, t]));
  const out: GoalTarget[] = [];
  let ready = targets.filter((t) => t.dependsOn.length === 0).sort(byPriorityThenId);
  while (ready.length) {
    const next = ready.shift()!;
    out.push(next);
    remaining.delete(next.id);
    for (const [id, deps] of remaining) {
      if (deps.delete(next.id) && deps.size === 0) ready.push(byId.get(id)!);
    }
    ready.sort(byPriorityThenId);
  }
  return out;
}

export interface CriticalPathResult {
  /** Dependency chain from a root to a leaf, dependencies first. */
  path: TargetId[];
  /** Sum of target priorities along the chain. */
  weight: number;
}

/**
 * Longest priority-weighted dependency chain (sum of `priority` along a path
 * from a root to a leaf). Ties break toward the lexicographically smaller
 * path so the result is deterministic.
 */
export function criticalPath(definition: GoalGraphDefinition): CriticalPathResult {
  assertValid(definition);
  const order = topoTargets(definition.targets);
  const best = new Map<string, { weight: number; path: string[] }>();
  for (const t of order) {
    let pred: { weight: number; path: string[] } | undefined;
    for (const dep of [...t.dependsOn].sort()) {
      const candidate = best.get(dep)!;
      if (!pred || candidate.weight > pred.weight || (candidate.weight === pred.weight && comparePaths(candidate.path, pred.path) < 0)) pred = candidate;
    }
    best.set(t.id, { weight: (pred?.weight ?? 0) + t.priority, path: [...(pred?.path ?? []), t.id] });
  }
  let result: { weight: number; path: string[] } | undefined;
  for (const t of order) {
    const c = best.get(t.id)!;
    if (!result || c.weight > result.weight || (c.weight === result.weight && comparePaths(c.path, result.path) < 0)) result = c;
  }
  return { path: result?.path ?? [], weight: result?.weight ?? 0 };
}

function comparePaths(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Targets that depend on `targetId`: direct dependents by default, or every
 * transitive dependent with `{ transitive: true }`. Sorted by priority then id.
 * Throws NOT_FOUND for an unknown target.
 */
export function dependents(definition: GoalGraphDefinition, targetId: TargetId, options: { transitive?: boolean } = {}): TargetId[] {
  if (!definition.targets.some((t) => t.id === targetId)) throw new GoalStudioFailure('NOT_FOUND', `unknown target "${targetId}"`);
  const found = new Set<string>();
  const frontier = [targetId];
  while (frontier.length) {
    const cur = frontier.pop()!;
    for (const t of definition.targets) {
      if (t.dependsOn.includes(cur) && !found.has(t.id) && t.id !== targetId) {
        found.add(t.id);
        if (options.transitive) frontier.push(t.id);
      }
    }
  }
  return definition.targets.filter((t) => found.has(t.id)).sort(byPriorityThenId).map((t) => t.id);
}

/** Targets with no dependencies, by priority then id. */
export function rootTargets(definition: GoalGraphDefinition): TargetId[] {
  return definition.targets.filter((t) => t.dependsOn.length === 0).sort(byPriorityThenId).map((t) => t.id);
}
