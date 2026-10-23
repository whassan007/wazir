import type {
  GoalConstitution,
  GoalGraphDefinition,
  GoalTarget,
  GraphValidationIssue,
  GraphValidationResult,
  PromptGraphNode,
  ResourceLimits,
} from '../contracts.js';
import { parseYaml, YamlParseError, type YamlValue } from './yaml.js';
import { validateGoalGraph } from './validation.js';

/**
 * Maps the snake_case goal-graph YAML (see fixtures/nobel_goal_graph.yaml)
 * onto the contract's GoalGraphDefinition. The target graph (`targets`) and
 * the execution / prompt graph (`graph.entry` + `graph.edges`) stay separate.
 * Unknown keys are rejected so a typo (`depend_on`) can never silently drop a
 * dependency or a limit.
 */

export interface PromptSeed {
  /** Execution-graph node id / GoalTarget.executor key. */
  executorKey: string;
  role: string;
  template: string;
}

export interface ExecutionTransitionSpec {
  from: string;
  to: string;
  when: string;
}

/** YAML content outside the contract's GoalGraphDefinition, kept for UI and later contract versions. */
export interface GoalGraphImportExtras {
  kind?: string;
  status?: string;
  sources: string[];
  completionStates: string[];
  transitions: ExecutionTransitionSpec[];
  stateContract?: Record<string, unknown>;
  integrationNotes: string[];
}

export interface ParsedGoalGraph {
  definition?: GoalGraphDefinition;
  validation: GraphValidationResult;
  extras?: GoalGraphImportExtras;
  prompts: PromptSeed[];
}

const TOP_LEVEL_KEYS = new Set(['schema_version', 'name', 'kind', 'status', 'sources', 'purpose', 'constitution', 'state_contract', 'targets', 'graph', 'prompts', 'integration_notes']);
const CONSTITUTION_KEYS = new Set(['objective_owner', 'invariants', 'resource_limits', 'allowed_unattended', 'needs_approval', 'completion_states']);
const TARGET_KEYS = new Set(['id', 'stage', 'title', 'depends_on', 'priority', 'executor', 'artifacts', 'acceptance', 'external_dependency', 'requires_approval']);
const GRAPH_KEYS = new Set(['entry', 'edges', 'transitions']);
const LIMIT_KEYS: Record<string, keyof ResourceLimits> = {
  max_tasks_per_run: 'maxTasksPerRun',
  max_repairs_per_task: 'maxRepairsPerTask',
  max_same_action_no_progress: 'maxSameActionNoProgress',
  max_run_minutes: 'maxRunMinutes',
  hosted_spend_usd: 'hostedSpendUsd',
  local_model_first: 'localModelFirst',
  max_concurrent_writers_per_worktree: 'maxConcurrentWritersPerWorktree',
  max_concurrent_targets: 'maxConcurrentTargets',
};

type YamlMap = { [key: string]: YamlValue };
const isMap = (v: unknown): v is YamlMap => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses, maps and validates goal-graph YAML. Never throws on bad input; problems become issues. */
export function parseGoalGraphYaml(yaml: string): ParsedGoalGraph {
  let doc: YamlValue;
  try {
    doc = parseYaml(yaml);
  } catch (err) {
    const message = err instanceof YamlParseError ? err.message : `YAML parse failed: ${(err as Error).message}`;
    return { validation: { valid: false, issues: [{ code: 'SCHEMA', message, path: err instanceof YamlParseError ? `line ${err.line}` : undefined }] }, prompts: [] };
  }
  return mapGoalGraphDocument(doc);
}

/** Maps an already-parsed YAML/JSON document (snake_case schema) into a validated definition. */
export function mapGoalGraphDocument(doc: unknown): ParsedGoalGraph {
  const issues: GraphValidationIssue[] = [];
  const schema = (message: string, path: string) => issues.push({ code: 'SCHEMA', message, path });
  if (!isMap(doc)) {
    schema('goal graph document must be a mapping', '');
    return { validation: { valid: false, issues }, prompts: [] };
  }
  unknownKeys(doc, TOP_LEVEL_KEYS, '', schema);

  // -- constitution --------------------------------------------------------
  const c = doc.constitution;
  let constitution: GoalConstitution | undefined;
  let completionStates: string[] = [];
  if (!isMap(c)) {
    schema('constitution must be a mapping', 'constitution');
  } else {
    unknownKeys(c, CONSTITUTION_KEYS, 'constitution', schema);
    const limitsRaw = c.resource_limits;
    const resourceLimits: Record<string, unknown> = {};
    if (!isMap(limitsRaw)) {
      schema('constitution.resource_limits must be a mapping', 'constitution.resource_limits');
    } else {
      for (const [key, value] of Object.entries(limitsRaw)) {
        const mapped = LIMIT_KEYS[key];
        if (!mapped) issues.push({ code: 'INVALID_LIMIT', message: `unknown resource limit "${key}"`, path: `constitution.resource_limits.${key}` });
        else resourceLimits[mapped] = value;
      }
    }
    constitution = {
      objectiveOwner: c.objective_owner as 'human',
      invariants: (c.invariants ?? []) as string[],
      resourceLimits: resourceLimits as unknown as ResourceLimits,
      allowedUnattended: (c.allowed_unattended ?? []) as string[],
      needsApproval: (c.needs_approval ?? []) as string[],
    };
    completionStates = stringList(c.completion_states, 'constitution.completion_states', schema);
  }

  // -- targets (the goal graph) ---------------------------------------------
  const targets: GoalTarget[] = [];
  if (!Array.isArray(doc.targets)) {
    schema('targets must be a sequence', 'targets');
  } else {
    doc.targets.forEach((raw, i) => {
      const path = `targets[${i}]`;
      if (!isMap(raw)) {
        schema('target must be a mapping', path);
        return;
      }
      unknownKeys(raw, TARGET_KEYS, path, schema);
      const target: GoalTarget = {
        id: raw.id as string,
        stage: raw.stage as string,
        title: raw.title as string,
        dependsOn: (raw.depends_on ?? []) as string[],
        priority: raw.priority as number,
        executor: raw.executor as string,
        artifacts: (raw.artifacts ?? []) as string[],
        acceptance: raw.acceptance as string[],
      };
      if (raw.external_dependency !== undefined && raw.external_dependency !== null) target.externalDependency = raw.external_dependency as boolean;
      if (raw.requires_approval !== undefined && raw.requires_approval !== null) target.requiresApproval = raw.requires_approval as boolean;
      targets.push(target);
    });
  }

  // -- execution (prompt) graph ---------------------------------------------
  const g = doc.graph;
  let executionGraph: GoalGraphDefinition['executionGraph'] | undefined;
  const transitions: ExecutionTransitionSpec[] = [];
  if (!isMap(g)) {
    schema('graph must be a mapping with entry and edges', 'graph');
  } else {
    unknownKeys(g, GRAPH_KEYS, 'graph', schema);
    const nodes: PromptGraphNode[] = [];
    if (!isMap(g.edges)) {
      schema('graph.edges must be a mapping of node -> [next nodes]', 'graph.edges');
    } else {
      for (const [id, next] of Object.entries(g.edges)) {
        nodes.push({ id, next: next === null ? [] : (next as string[]) });
      }
    }
    executionGraph = { entry: g.entry as string, nodes };
    if (g.transitions !== undefined && g.transitions !== null) {
      if (!Array.isArray(g.transitions)) {
        schema('graph.transitions must be a sequence', 'graph.transitions');
      } else {
        const edgeSet = new Set(nodes.flatMap((n) => (Array.isArray(n.next) ? n.next.map((to) => `${n.id}->${to}`) : [])));
        g.transitions.forEach((t, i) => {
          const path = `graph.transitions[${i}]`;
          if (!isMap(t) || typeof t.from !== 'string' || typeof t.to !== 'string' || typeof t.when !== 'string') {
            schema('transition must have string from, to and when', path);
            return;
          }
          unknownKeys(t, new Set(['from', 'to', 'when']), path, schema);
          if (!edgeSet.has(`${t.from}->${t.to}`)) schema(`transition ${t.from} -> ${t.to} is not an edge of graph.edges`, path);
          transitions.push({ from: t.from, to: t.to, when: t.when });
        });
      }
    }
  }

  // -- prompts ----------------------------------------------------------------
  const prompts = mapPrompts(doc.prompts, schema);
  if (executionGraph) {
    const nodeIds = new Set(executionGraph.nodes.map((n) => n.id));
    for (const p of prompts) if (!nodeIds.has(p.executorKey)) schema(`prompt "${p.executorKey}" does not correspond to an execution-graph node`, `prompts.${p.executorKey}`);
  }

  const extras: GoalGraphImportExtras = {
    kind: typeof doc.kind === 'string' ? doc.kind : undefined,
    status: typeof doc.status === 'string' ? doc.status : undefined,
    sources: stringList(doc.sources, 'sources', schema),
    completionStates,
    transitions,
    stateContract: isMap(doc.state_contract) ? (doc.state_contract as Record<string, unknown>) : undefined,
    integrationNotes: stringList(doc.integration_notes, 'integration_notes', schema),
  };

  const schemaVersion = typeof doc.schema_version === 'number' ? String(doc.schema_version) : (doc.schema_version as string);
  const definition: GoalGraphDefinition = {
    schemaVersion,
    name: doc.name as string,
    constitution: constitution as GoalConstitution,
    targets,
    executionGraph: executionGraph as GoalGraphDefinition['executionGraph'],
  };
  if (typeof doc.purpose === 'string') definition.purpose = doc.purpose;
  else if (doc.purpose !== undefined && doc.purpose !== null) schema('purpose must be a string', 'purpose');

  const structural = validateGoalGraph(definition);
  const all = [...issues, ...structural.issues];
  const validation = { valid: all.length === 0, issues: all };
  return { definition: validation.valid ? definition : undefined, validation, extras, prompts };
}

/**
 * The `prompts:` section (executor key -> role/template) in file order, for
 * seeding Prompt Studio. Accepts the YAML text or an already-parsed document.
 * Throws YamlParseError on unparseable YAML and Error on a malformed section.
 */
export function extractPromptSeeds(yamlOrDoc: string | unknown): PromptSeed[] {
  const doc = typeof yamlOrDoc === 'string' ? parseYaml(yamlOrDoc) : yamlOrDoc;
  if (!isMap(doc)) throw new Error('goal graph document must be a mapping');
  const problems: string[] = [];
  const seeds = mapPrompts(doc.prompts, (message, path) => problems.push(`${path}: ${message}`));
  if (problems.length) throw new Error(`invalid prompts section: ${problems.join('; ')}`);
  return seeds;
}

function mapPrompts(raw: unknown, schema: (message: string, path: string) => void): PromptSeed[] {
  if (raw === undefined || raw === null) return [];
  if (!isMap(raw)) {
    schema('prompts must be a mapping of executor key -> {role, template}', 'prompts');
    return [];
  }
  const out: PromptSeed[] = [];
  for (const [executorKey, value] of Object.entries(raw)) {
    const path = `prompts.${executorKey}`;
    if (!isMap(value) || typeof value.role !== 'string' || value.role.trim() === '' || typeof value.template !== 'string' || value.template.trim() === '') {
      schema('prompt must have non-empty string role and template', path);
      continue;
    }
    unknownKeys(value, new Set(['role', 'template']), path, schema);
    out.push({ executorKey, role: value.role, template: value.template });
  }
  return out;
}

function unknownKeys(map: YamlMap, allowed: Set<string>, base: string, schema: (message: string, path: string) => void): void {
  for (const key of Object.keys(map)) {
    if (!allowed.has(key)) schema(`unknown key "${key}"`, base ? `${base}.${key}` : key);
  }
}

function stringList(v: unknown, path: string, schema: (message: string, path: string) => void): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
    schema(`${path} must be a sequence of strings`, path);
    return [];
  }
  return v as string[];
}
