import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GoalGraphDefinition, GoalRunLedger, GoalStudioError, GoalTarget, TargetAttempt, TargetStatus } from '../../src/contracts.js';

/**
 * Minimal reader for the targets section of the Nobel fixture (the graph workstream owns
 * the real YAML importer; recovery tests only need ids, dependencies and priorities).
 */
export function loadNobelGraph(): GoalGraphDefinition {
  const yaml = readFileSync(join(__dirname, '../../fixtures/nobel_goal_graph.yaml'), 'utf8');
  const section = yaml.split(/^targets:\s*$/m)[1].split(/^\S/m)[0];
  const targets: GoalTarget[] = [];
  for (const block of section.split(/^  - id: /m).slice(1)) {
    const field = (name: string) => block.match(new RegExp(`^    ${name}: (.*)$`, 'm'))?.[1]?.trim() ?? '';
    const list = (raw: string) => raw.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    const acceptance = [...block.matchAll(/^      - (.*)$/gm)].map((m) => m[1].trim());
    targets.push({
      id: block.split(/\r?\n/)[0].trim(),
      stage: field('stage'),
      title: field('title'),
      dependsOn: list(field('depends_on')),
      priority: Number(field('priority')),
      executor: field('executor'),
      artifacts: list(field('artifacts')),
      acceptance,
      externalDependency: field('external_dependency') === 'true' || undefined,
      requiresApproval: field('requires_approval') === 'true' || undefined,
    });
  }
  const limits = (name: string) => Number(yaml.match(new RegExp(`^    ${name}: (\\d+)`, 'm'))?.[1]);
  return {
    schemaVersion: '1.0',
    name: 'nobel-governance-continuous-goal-graph',
    constitution: {
      objectiveOwner: 'human',
      invariants: [],
      resourceLimits: {
        maxTasksPerRun: limits('max_tasks_per_run'),
        maxRepairsPerTask: limits('max_repairs_per_task'),
        maxSameActionNoProgress: limits('max_same_action_no_progress'),
        maxRunMinutes: limits('max_run_minutes'),
        hostedSpendUsd: 0,
        localModelFirst: true,
        maxConcurrentWritersPerWorktree: 1,
      },
      allowedUnattended: [],
      needsApproval: [],
    },
    targets,
    executionGraph: { entry: 'load_ledger', nodes: [] },
  };
}

export function makeRun(graph: GoalGraphDefinition, statuses: Record<string, TargetStatus> = {}, patch: Partial<GoalRunLedger> = {}): GoalRunLedger {
  const at = '2026-10-22T00:00:00.000Z';
  const targets: GoalRunLedger['targets'] = {};
  for (const t of graph.targets) targets[t.id] = { targetId: t.id, status: statuses[t.id] ?? 'queued', attempts: 0, repairs: 0, evidenceIds: [], blockers: [], updatedAt: at };
  return {
    runId: 'run-1', graphId: 'g-1', graphRevision: 1, graphDigest: 'digest-1', status: 'running', ledgerRevision: 1, targets,
    resource: { tasksStarted: 0, hostedSpendUsd: 0, startedAt: at, deadlineAt: '2026-10-22T01:30:00.000Z' },
    createdBy: 'user:test', createdAt: at, updatedAt: at, ...patch,
  };
}

export function makeAttempt(targetId: string, n: number, patch: Partial<TargetAttempt> = {}): TargetAttempt {
  return {
    id: `att-${targetId}-${n}`, runId: 'run-1', targetId, attempt: n, phase: 'EXECUTE',
    startedAt: `2026-10-22T00:${String(n).padStart(2, '0')}:00.000Z`, outcome: 'failed', ...patch,
  };
}

export const err = (code: GoalStudioError['code'], message: string, retryable = false, details?: Record<string, unknown>): GoalStudioError => ({ code, message, retryable, details });
