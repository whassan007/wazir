/**
 * Test-side conversion of the goal-graph YAML (snake_case, as authored in
 * packages/goals/fixtures/nobel_goal_graph.yaml) into the contract's
 * GoalGraphDefinition, plus reference validation and digest helpers.
 * Used by the reference fakes and by the contract suites to build inputs
 * without depending on workstream 02's importer.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  GoalGraphDefinition,
  GoalGraphRevisionRecord,
  GoalTarget,
  GraphValidationIssue,
  GraphValidationResult,
  ResourceLimits,
} from '../../../packages/goals/src/contracts.js';
import { parseYamlLite } from './yamlLite.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');
export const FIXTURE_PATH = path.join(REPO_ROOT, 'packages/goals/fixtures/nobel_goal_graph.yaml');

export function readFixtureYaml(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

/** Facts about the real fixture the suites assert against. */
export const FIXTURE_FACTS = {
  targetCount: 10,
  roots: ['Y1.1'],
  externalDependency: ['Y1.4', 'Y2.3', 'Y3.3'],
  requiresApproval: ['Y2.3', 'Y3.2', 'Y3.3'],
  hostedSpendUsd: 0,
} as const;

type Raw = Record<string, any>;

function asStringArray(v: unknown): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new Error(`expected a list, got ${typeof v}`);
  return v.map((x) => String(x));
}

export function definitionFromRaw(raw: Raw): GoalGraphDefinition {
  if (!raw || typeof raw !== 'object') throw new Error('graph document must be a mapping');
  // Already in contract (camelCase) shape?
  if (raw.constitution?.resourceLimits && Array.isArray(raw.targets) && raw.executionGraph) return raw as GoalGraphDefinition;
  const c: Raw = raw.constitution ?? {};
  const rl: Raw = c.resource_limits ?? {};
  const limits: ResourceLimits = {
    maxTasksPerRun: Number(rl.max_tasks_per_run),
    maxRepairsPerTask: Number(rl.max_repairs_per_task),
    maxSameActionNoProgress: Number(rl.max_same_action_no_progress),
    maxRunMinutes: Number(rl.max_run_minutes),
    hostedSpendUsd: Number(rl.hosted_spend_usd),
    localModelFirst: Boolean(rl.local_model_first),
    maxConcurrentWritersPerWorktree: Number(rl.max_concurrent_writers_per_worktree),
    ...(rl.max_concurrent_targets != null ? { maxConcurrentTargets: Number(rl.max_concurrent_targets) } : {}),
  };
  const targets: GoalTarget[] = (raw.targets ?? []).map((t: Raw) => ({
    id: String(t.id),
    stage: String(t.stage ?? ''),
    title: String(t.title ?? ''),
    dependsOn: asStringArray(t.depends_on),
    priority: Number(t.priority ?? 0),
    executor: String(t.executor ?? ''),
    artifacts: asStringArray(t.artifacts),
    acceptance: asStringArray(t.acceptance),
    ...(t.external_dependency ? { externalDependency: true } : {}),
    ...(t.requires_approval ? { requiresApproval: true } : {}),
  }));
  const edges: Raw = raw.graph?.edges ?? {};
  const prompts: Raw = raw.prompts ?? {};
  return {
    schemaVersion: String(raw.schema_version ?? ''),
    name: String(raw.name ?? ''),
    ...(raw.purpose ? { purpose: String(raw.purpose) } : {}),
    constitution: {
      objectiveOwner: 'human',
      invariants: asStringArray(c.invariants),
      resourceLimits: limits,
      allowedUnattended: asStringArray(c.allowed_unattended),
      needsApproval: asStringArray(c.needs_approval),
    },
    targets,
    executionGraph: {
      entry: String(raw.graph?.entry ?? ''),
      nodes: Object.entries(edges).map(([id, next]) => ({ id, next: asStringArray(next), ...(prompts[id] ? { promptId: id } : {}) })),
    },
  };
}

export function parseGraphYaml(yaml: string): GoalGraphDefinition {
  return definitionFromRaw(parseYamlLite(yaml) as Raw);
}

export function loadFixtureDefinition(): GoalGraphDefinition {
  return parseGraphYaml(readFixtureYaml());
}

/** Canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function definitionDigest(def: GoalGraphDefinition): string {
  return createHash('sha256').update(canonicalJson(def)).digest('hex');
}

export function referenceValidate(def: GoalGraphDefinition): GraphValidationResult {
  const issues: GraphValidationIssue[] = [];
  if (!def || typeof def !== 'object' || !Array.isArray(def.targets) || !def.constitution?.resourceLimits) {
    return { valid: false, issues: [{ code: 'SCHEMA', message: 'definition must have constitution.resourceLimits and targets[]' }] };
  }
  const ids = new Set<string>();
  def.targets.forEach((t, i) => {
    if (!t.id || typeof t.id !== 'string') issues.push({ code: 'SCHEMA', message: 'target id required', path: `targets[${i}].id` });
    if (ids.has(t.id)) issues.push({ code: 'DUPLICATE_TARGET', message: `duplicate target ${t.id}`, targetIds: [t.id] });
    ids.add(t.id);
  });
  for (const t of def.targets) {
    for (const d of t.dependsOn ?? []) {
      if (d === t.id) issues.push({ code: 'SELF_DEPENDENCY', message: `${t.id} depends on itself`, targetIds: [t.id] });
      else if (!ids.has(d)) issues.push({ code: 'UNKNOWN_DEPENDENCY', message: `${t.id} depends on unknown ${d}`, targetIds: [t.id, d] });
    }
  }
  const rl = def.constitution.resourceLimits;
  for (const [k, v] of Object.entries(rl)) {
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) issues.push({ code: 'INVALID_LIMIT', message: `${k} must be a finite non-negative number`, path: `constitution.resourceLimits.${k}` });
  }
  // Cycle detection (ignoring self/unknown edges already reported).
  const byId = new Map(def.targets.map((t) => [t.id, t] as const));
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    color.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (d === id || !byId.has(d)) continue;
      const c = color.get(d) ?? 0;
      if (c === 1) {
        const cycle = stack.slice(stack.indexOf(d));
        issues.push({ code: 'CYCLE', message: `dependency cycle: ${[...cycle, d].join(' -> ')}`, targetIds: cycle });
      } else if (c === 0) visit(d);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const t of def.targets) if ((color.get(t.id) ?? 0) === 0) visit(t.id);
  return { valid: issues.length === 0, issues };
}

/** Builds a revision record directly (no graph store) for suites that only need input data. */
export function fixtureRevisionRecord(overrides: Partial<GoalGraphRevisionRecord> = {}): GoalGraphRevisionRecord {
  const definition = loadFixtureDefinition();
  return {
    graphId: 'graph-fixture',
    projectId: 'project-fixture',
    revision: 1,
    definition,
    digest: definitionDigest(definition),
    createdAt: new Date(0).toISOString(),
    createdBy: 'user:test',
    ...overrides,
  };
}

/** Deterministic synthetic layered DAG for scale tests/benchmarks. */
export function syntheticDefinition(targetCount: number, fanIn = 3, seed = 42): GoalGraphDefinition {
  const base = loadFixtureDefinition();
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const targets: GoalTarget[] = [];
  for (let i = 0; i < targetCount; i++) {
    const deps = new Set<string>();
    if (i > 0) {
      const n = Math.min(i, Math.floor(rand() * (fanIn + 1)));
      for (let k = 0; k < n; k++) deps.add(`T${Math.floor(rand() * i)}`);
    }
    targets.push({
      id: `T${i}`,
      stage: `stage-${Math.floor(i / 100)}`,
      title: `Synthetic target ${i}`,
      dependsOn: [...deps],
      priority: Math.floor(rand() * 100),
      executor: base.targets[i % base.targets.length]!.executor,
      artifacts: [`t${i}.md`],
      acceptance: [`artifact t${i}.md exists`],
    });
  }
  return { ...base, name: `synthetic-${targetCount}`, targets };
}
