import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  criticalPath,
  dependents,
  diffRevisions,
  extractPromptSeeds,
  findCycles,
  graphDigest,
  mapGoalGraphDocument,
  parseGoalGraphYaml,
  parseYaml,
  rootTargets,
  topologicalOrder,
  validateGoalGraph,
  YamlParseError,
} from '../../src/graph/index.js';
import { GoalStudioFailure } from '../../src/contracts.js';
import { NOBEL_YAML, nobelDefinition, tinyDefinition } from './helpers.js';

describe('YAML parser and importer', () => {
  it('cleanly imports packages/goals/fixtures/nobel_goal_graph.yaml into GoalGraphDefinition', () => {
    const parsed = parseGoalGraphYaml(NOBEL_YAML);
    expect(parsed.validation.valid).toBe(true);
    expect(parsed.validation.issues).toEqual([]);
    expect(parsed.definition).toBeDefined();

    const def = parsed.definition!;
    expect(def.schemaVersion).toBe('1.0');
    expect(def.name).toBe('nobel-governance-continuous-goal-graph');
    expect(def.purpose).toContain('Provable Algorithmic Peace');
    expect(def.constitution.objectiveOwner).toBe('human');
    expect(def.constitution.invariants.length).toBeGreaterThanOrEqual(10);
    expect(def.constitution.resourceLimits).toEqual({
      maxTasksPerRun: 12,
      maxRepairsPerTask: 3,
      maxSameActionNoProgress: 2,
      maxRunMinutes: 90,
      hostedSpendUsd: 0,
      localModelFirst: true,
      maxConcurrentWritersPerWorktree: 1,
    });
    expect(def.constitution.allowedUnattended.length).toBe(4);
    expect(def.constitution.needsApproval.length).toBe(6);

    // 10 targets across 3 stages
    expect(def.targets.map((t) => t.id)).toEqual([
      'Y1.1', 'Y1.2', 'Y1.3', 'Y1.4',
      'Y2.1', 'Y2.2', 'Y2.3',
      'Y3.1', 'Y3.2', 'Y3.3',
    ]);
    const y14 = def.targets.find((t) => t.id === 'Y1.4')!;
    expect(y14.dependsOn).toEqual(['Y1.2', 'Y1.3']);
    expect(y14.externalDependency).toBe(true);
    expect(y14.requiresApproval).toBeUndefined();

    const y23 = def.targets.find((t) => t.id === 'Y2.3')!;
    expect(y23.externalDependency).toBe(true);
    expect(y23.requiresApproval).toBe(true);

    // Execution graph kept separate from targets
    expect(def.executionGraph.entry).toBe('load_ledger');
    expect(def.executionGraph.nodes.length).toBe(21);
    const routeNode = def.executionGraph.nodes.find((n) => n.id === 'route_executor')!;
    expect(routeNode.next).toContain('axiomatize');
    expect(routeNode.next).toContain('formal_verify');

    // Extras and prompt seeds
    expect(parsed.extras?.completionStates).toContain('completed');
    expect(parsed.extras?.completionStates).toContain('awaiting_external');
    expect(parsed.extras?.transitions.length).toBe(15);
    expect(parsed.prompts.length).toBe(21);
    expect(extractPromptSeeds(NOBEL_YAML).length).toBe(21);
  });

  it('supports program, stages, execution_graph, and top-level completion_states variants', () => {
    const doc = {
      schema_version: '1.0',
      program: 'staged-program',
      purpose: 'test stages and execution_graph aliases',
      constitution: {
        objective_owner: 'human',
        invariants: ['inv1'],
        resource_limits: {
          max_tasks_per_run: 4,
          max_repairs_per_task: 1,
          max_same_action_no_progress: 1,
          max_run_minutes: 15,
          hosted_spend_usd: 0,
          local_model_first: true,
          max_concurrent_writers_per_worktree: 1,
          max_concurrent_targets: 2,
        },
        allowed_unattended: ['read'],
        needs_approval: ['deploy'],
      },
      completion_states: ['queued', 'completed', 'blocked'],
      stages: [
        {
          id: 'phase_1',
          targets: [
            {
              id: 'T1',
              title: 'First target',
              depends_on: [],
              priority: 50,
              executor: 'exec_node',
              artifacts: ['out.txt'],
              acceptance: ['file exists'],
            },
          ],
        },
      ],
      execution_graph: {
        entry: 'exec_node',
        nodes: [{ id: 'exec_node', next: [], prompt_id: 'prompt-1' }],
      },
    };
    const res = mapGoalGraphDocument(doc);
    expect(res.validation.valid).toBe(true);
    expect(res.definition?.name).toBe('staged-program');
    expect(res.definition?.targets[0]).toMatchObject({
      id: 'T1',
      stage: 'phase_1',
      executor: 'exec_node',
    });
    expect(res.definition?.constitution.resourceLimits.maxConcurrentTargets).toBe(2);
    expect(res.definition?.executionGraph.nodes[0]).toEqual({ id: 'exec_node', next: [], promptId: 'prompt-1' });
    expect(res.extras?.completionStates).toEqual(['queued', 'completed', 'blocked']);
  });

  it('rejects malformed YAML syntax, tabs, duplicate keys, anchors, and unknown schema keys', () => {
    expect(() => parseYaml('\tkey: value')).toThrow(YamlParseError);
    expect(() => parseYaml('a: 1\na: 2')).toThrow(/duplicate key/);
    expect(() => parseYaml('a: &anchor val')).toThrow(/unsupported YAML feature/);

    const badKey = parseGoalGraphYaml('schema_version: "1.0"\nunknown_top_key: 123\n');
    expect(badKey.validation.valid).toBe(false);
    expect(badKey.validation.issues.some((i) => i.code === 'SCHEMA' && i.message.includes('unknown_top_key'))).toBe(true);
  });
});

describe('validation, cycles, topological ordering, critical path, and diffing', () => {
  it('detects DUPLICATE_TARGET, UNKNOWN_DEPENDENCY, SELF_DEPENDENCY, CYCLE, UNKNOWN_EXECUTOR, INVALID_LIMIT, and SCHEMA', () => {
    const base = tinyDefinition();

    // DUPLICATE_TARGET
    const dup = tinyDefinition({
      targets: [
        base.targets[0],
        { ...base.targets[1], id: 'A' },
      ],
    });
    expect(validateGoalGraph(dup).issues.map((i) => i.code)).toContain('DUPLICATE_TARGET');

    // UNKNOWN_DEPENDENCY
    const missingDep = tinyDefinition({
      targets: [{ ...base.targets[0], dependsOn: ['NON_EXISTENT'] }],
    });
    const missingRes = validateGoalGraph(missingDep);
    expect(missingRes.valid).toBe(false);
    expect(missingRes.issues).toContainEqual(
      expect.objectContaining({ code: 'UNKNOWN_DEPENDENCY', targetIds: ['A', 'NON_EXISTENT'] }),
    );

    // SELF_DEPENDENCY
    const selfDep = tinyDefinition({
      targets: [{ ...base.targets[0], dependsOn: ['A'] }],
    });
    expect(validateGoalGraph(selfDep).issues.map((i) => i.code)).toContain('SELF_DEPENDENCY');

    // CYCLE (A -> B -> C -> A)
    const cyclic = tinyDefinition({
      targets: [
        { ...base.targets[0], id: 'A', dependsOn: ['C'] },
        { ...base.targets[1], id: 'B', dependsOn: ['A'] },
        { ...base.targets[2], id: 'C', dependsOn: ['B'] },
      ],
    });
    const cycleRes = validateGoalGraph(cyclic);
    expect(cycleRes.valid).toBe(false);
    expect(cycleRes.issues.some((i) => i.code === 'CYCLE')).toBe(true);
    expect(findCycles(cyclic.targets)).toEqual([['A', 'C', 'B', 'A']]);

    // UNKNOWN_EXECUTOR
    const badExec = tinyDefinition({
      targets: [{ ...base.targets[0], executor: 'missing_executor' }],
    });
    expect(validateGoalGraph(badExec).issues.map((i) => i.code)).toContain('UNKNOWN_EXECUTOR');

    // INVALID_LIMIT
    const badLimit = tinyDefinition({
      constitution: {
        ...base.constitution,
        resourceLimits: {
          ...base.constitution.resourceLimits,
          maxTasksPerRun: 0,
          hostedSpendUsd: -5,
        },
      },
    });
    const limitCodes = validateGoalGraph(badLimit).issues.filter((i) => i.code === 'INVALID_LIMIT');
    expect(limitCodes.length).toBe(2);
  });

  it('computes deterministic topological order, critical path, roots, and dependents on Nobel fixture', () => {
    const nobel = nobelDefinition();
    const order = topologicalOrder(nobel);
    expect(order[0]).toBe('Y1.1');
    expect(order[order.length - 1]).toBe('Y3.3');
    // Every dependency appears before its dependent
    for (const t of nobel.targets) {
      for (const dep of t.dependsOn) {
        expect(order.indexOf(dep)).toBeLessThan(order.indexOf(t.id));
      }
    }

    const cp = criticalPath(nobel);
    expect(cp.path).toEqual(['Y1.1', 'Y1.2', 'Y1.3', 'Y2.1', 'Y2.2', 'Y2.3', 'Y3.3']);
    expect(cp.weight).toBe(100 + 98 + 94 + 88 + 85 + 80 + 60);

    expect(rootTargets(nobel)).toEqual(['Y1.1']);
    expect(dependents(nobel, 'Y1.1')).toEqual(['Y1.2']);
    expect(dependents(nobel, 'Y1.1', { transitive: true }).length).toBe(9);
    expect(() => dependents(nobel, 'UNKNOWN')).toThrow(GoalStudioFailure);
  });

  it('produces canonical JSON digests independent of key order and diffs revisions accurately', () => {
    const d1 = tinyDefinition();
    const d2 = structuredClone(d1);
    // Reorder keys on target 0
    d2.targets[0] = {
      acceptance: d1.targets[0].acceptance,
      artifacts: d1.targets[0].artifacts,
      executor: d1.targets[0].executor,
      priority: d1.targets[0].priority,
      dependsOn: d1.targets[0].dependsOn,
      title: d1.targets[0].title,
      stage: d1.targets[0].stage,
      id: d1.targets[0].id,
    };
    expect(canonicalJson(d1)).toBe(canonicalJson(d2));
    expect(graphDigest(d1)).toBe(graphDigest(d2));
    expect(diffRevisions(d1, d2).identical).toBe(true);

    const modified = tinyDefinition({
      purpose: 'updated purpose',
      targets: [
        { ...d1.targets[0], priority: 99 },
        d1.targets[1],
        // C removed, E added
        { id: 'E', stage: 's', title: 'E', dependsOn: ['B'], priority: 3, executor: 'work', artifacts: [], acceptance: ['e exists'] },
      ],
    });
    const diff = diffRevisions(d1, modified);
    expect(diff.identical).toBe(false);
    expect(diff.metadata).toEqual([{ path: 'purpose', before: undefined, after: 'updated purpose' }]);
    expect(diff.targets.added).toEqual(['E']);
    expect(diff.targets.removed).toEqual(['C', 'D']);
    expect(diff.targets.changed).toEqual([
      { targetId: 'A', changes: [{ path: 'priority', before: 10, after: 99 }] },
    ]);
  });
});
