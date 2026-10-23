import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GoalGraphDefinition } from '../../src/contracts.js';
import { parseGoalGraphYaml } from '../../src/graph/index.js';

export const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures');
export const NOBEL_YAML = readFileSync(path.join(FIXTURE_DIR, 'nobel_goal_graph.yaml'), 'utf8');

export function nobelDefinition(): GoalGraphDefinition {
  const parsed = parseGoalGraphYaml(NOBEL_YAML);
  if (!parsed.definition) throw new Error(`fixture invalid: ${JSON.stringify(parsed.validation.issues)}`);
  return parsed.definition;
}

/** Small valid graph for focused tests. */
export function tinyDefinition(overrides: Partial<GoalGraphDefinition> = {}): GoalGraphDefinition {
  return {
    schemaVersion: '1.0',
    name: 'tiny',
    constitution: {
      objectiveOwner: 'human',
      invariants: ['no self-certification'],
      resourceLimits: {
        maxTasksPerRun: 5,
        maxRepairsPerTask: 2,
        maxSameActionNoProgress: 2,
        maxRunMinutes: 30,
        hostedSpendUsd: 0,
        localModelFirst: true,
        maxConcurrentWritersPerWorktree: 1,
      },
      allowedUnattended: ['read'],
      needsApproval: ['publish'],
    },
    targets: [
      { id: 'A', stage: 's', title: 'A', dependsOn: [], priority: 10, executor: 'work', artifacts: ['a.md'], acceptance: ['a exists'] },
      { id: 'B', stage: 's', title: 'B', dependsOn: ['A'], priority: 5, executor: 'work', artifacts: [], acceptance: ['b exists'] },
      { id: 'C', stage: 's', title: 'C', dependsOn: ['A'], priority: 7, executor: 'work', artifacts: [], acceptance: ['c exists'] },
      { id: 'D', stage: 's', title: 'D', dependsOn: ['B', 'C'], priority: 1, executor: 'work', artifacts: [], acceptance: ['d exists'] },
    ],
    executionGraph: { entry: 'start', nodes: [{ id: 'start', next: ['work'] }, { id: 'work', next: [] }] },
    ...overrides,
  };
}
