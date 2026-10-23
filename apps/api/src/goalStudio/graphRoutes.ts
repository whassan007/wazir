import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GOAL_STUDIO_HTTP_STATUS,
  GoalStudioFailure,
  criticalPath,
  diffRevisions,
  parseGoalGraphYaml,
  topologicalOrder,
  validateGoalGraph,
  type GoalGraphStore,
  type GoalStudioErrorCode,
} from '@wazir/goals';
import type { GoalStudioRouteContext } from './context.js';

// Owned by Goal Studio workstream 02. Mount routes under /api/v1/goal-studio/.
const BASE = '/api/v1/goal-studio/graphs';

type Handler = (req: Request, res: Response, graphs: GoalGraphStore) => Promise<void>;

export function registerGraphRoutes(app: Express, ctx: GoalStudioRouteContext): void {
  const read = ctx.auth.requireViewerOrOperator;
  const write = ctx.auth.requireOperator;

  const handle = (fn: Handler): RequestHandler => (req: Request, res: Response, _next: NextFunction) => {
    const graphs = ctx.services.graphs;
    if (!graphs) {
      res.status(503).json({ error: { code: 'INTERNAL', message: 'graphs service not configured' } });
      return;
    }
    fn(req, res, graphs).catch((err) => sendError(res, err));
  };

  /** Principal for audit fields; derived from the matched credential only, never from the body. */
  const actorOf = (req: Request): string => `user:${ctx.auth.principalFor(req)?.id ?? 'operator'}`;

  // Create a new goal graph revision directly from JSON specification.
  app.post(`${BASE}/create`, write, handle(async (req, res, graphs) => {
    const body = bodyOf(req);
    if (typeof body.name !== 'string' || !body.name.trim()) throw new GoalStudioFailure('VALIDATION', 'name is required');
    if (typeof body.objective !== 'string' || !body.objective.trim()) throw new GoalStudioFailure('VALIDATION', 'objective is required');

    const projectId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : 'default';
    const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'goal';
    const graphId = typeof body.graphId === 'string' && body.graphId.trim() ? body.graphId.trim() : `graph-${slug}`;

    const rawTargets = Array.isArray(body.targets) && body.targets.length > 0 ? (body.targets as Array<Record<string, unknown>>) : undefined;
    const effectiveTargets = rawTargets ? rawTargets.map((t, idx) => ({
      id: typeof t.id === 'string' && t.id ? t.id : `T${idx + 1}`,
      stage: typeof t.stage === 'string' && t.stage ? t.stage : 'execution',
      title: typeof t.title === 'string' && t.title ? t.title : (body.name as string),
      dependsOn: Array.isArray(t.dependsOn) ? (t.dependsOn as string[]) : [],
      priority: typeof t.priority === 'number' && Number.isFinite(t.priority) ? t.priority : 100,
      executor: typeof t.executor === 'string' && t.executor ? t.executor : 'fleet_harness',
      artifacts: Array.isArray(t.artifacts) && t.artifacts.length > 0 ? (t.artifacts as string[]) : ['goal-output.md'],
      acceptance: Array.isArray(t.acceptance) && t.acceptance.length > 0 ? (t.acceptance as string[]) : ['Goal output artifact is produced and non-empty.'],
      ...(t.requiresApproval !== undefined ? { requiresApproval: Boolean(t.requiresApproval) } : {}),
      ...(t.externalDependency !== undefined ? { externalDependency: Boolean(t.externalDependency) } : {}),
    })) : [
      {
        id: 'T1',
        stage: 'execution',
        title: body.name as string,
        dependsOn: [] as string[],
        priority: 100,
        executor: 'fleet_harness',
        artifacts: ['goal-output.md'],
        acceptance: ['Goal output artifact is produced and non-empty.'],
      }
    ];

    const executors = new Set<string>(['fleet_harness', ...effectiveTargets.map(t => t.executor)]);
    const definition = {
      schemaVersion: '1.0',
      name: body.name as string,
      purpose: body.objective as string,
      constitution: {
        objectiveOwner: 'human',
        invariants: ['no_unverified_completion', 'no_fabrication'],
        needsApproval: ['external_submission', 'protected_branch_merge'],
        allowedUnattended: [
          'local read-only research and analysis of authorized sources',
          'drafting documents, code and formal models in isolated workspaces',
          'running read-only analysis and tests in a configured sandbox',
          'writing evidence manifests and updating the target ledger',
        ],
        resourceLimits: {
          maxTasksPerRun: 12,
          maxRunMinutes: 90,
          maxRepairsPerTask: 3,
          maxSameActionNoProgress: 2,
          hostedSpendUsd: 0,
          localModelFirst: true,
          maxConcurrentTargets: 1,
          maxConcurrentWritersPerWorktree: 1,
        },
      },
      targets: effectiveTargets,
      executionGraph: {
        entry: Array.from(executors)[0] || 'fleet_harness',
        nodes: Array.from(executors).map(id => ({ id, next: [] })),
      },
    };

    const validation = graphs.validate(definition as never);
    if (!validation.valid) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'goal graph validation failed', details: { issues: validation.issues } }, validation });
      return;
    }

    let record: unknown;
    try {
      record = await (graphs as unknown as { createRevision: (id: string, def: unknown, actor: string) => Promise<unknown> }).createRevision(graphId, definition, actorOf(req));
    } catch {
      const yaml = buildGoalGraphYaml(body.name as string, body.objective as string, effectiveTargets);
      const out = await graphs.importYaml(projectId, yaml, actorOf(req));
      record = out.record;
    }

    res.status(201).json({ record, validation });
  }));

  // Seed standard Nobel governance goal graph fixture into the given project.
  app.post(`${BASE}/seed-nobel`, write, handle(async (req, res, graphs) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : 'nobel-example';
    const candidatePaths = [
      path.resolve(process.cwd(), 'packages/goals/fixtures/nobel_goal_graph.yaml'),
      path.resolve(process.cwd(), '../../packages/goals/fixtures/nobel_goal_graph.yaml'),
      path.resolve(__dirname, '../../../../packages/goals/fixtures/nobel_goal_graph.yaml'),
      path.resolve(__dirname, '../../../packages/goals/fixtures/nobel_goal_graph.yaml'),
    ];
    let yaml: string | undefined;
    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) {
          yaml = await fs.promises.readFile(p, 'utf8');
          break;
        }
      } catch {
        // continue search
      }
    }
    if (!yaml) {
      throw new GoalStudioFailure('NOT_FOUND', 'nobel_goal_graph.yaml fixture not found');
    }
    const result = (await graphs.importYaml(projectId, yaml, actorOf(req))) as Awaited<ReturnType<GoalGraphStore['importYaml']>> & { created?: boolean };
    if (!result.record) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'goal graph validation failed', details: { issues: result.validation.issues } }, validation: result.validation });
      return;
    }
    const created = result.created !== false;
    res.status(created ? 201 : 200).json({ record: result.record, validation: result.validation, created });
  }));

  // Import a YAML goal graph. Creates revision 1, a new revision when the
  // definition changed, or returns the latest revision unchanged (200).
  app.post(`${BASE}/import`, write, handle(async (req, res, graphs) => {
    const body = bodyOf(req);
    if (typeof body.projectId !== 'string' || typeof body.yaml !== 'string') throw new GoalStudioFailure('VALIDATION', 'body must be {projectId: string, yaml: string}');
    const result = (await graphs.importYaml(body.projectId, body.yaml, actorOf(req))) as Awaited<ReturnType<GoalGraphStore['importYaml']>> & { created?: boolean };
    if (!result.record) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'goal graph validation failed', details: { issues: result.validation.issues } }, validation: result.validation });
      return;
    }
    const created = result.created !== false;
    res.status(created ? 201 : 200).json({ record: result.record, validation: result.validation, created });
  }));

  // Dry-run validation of YAML or a definition; persists nothing.
  app.post(`${BASE}/validate`, write, handle(async (req, res) => {
    const body = bodyOf(req);
    if (typeof body.yaml === 'string') {
      const parsed = parseGoalGraphYaml(body.yaml);
      res.json({ validation: parsed.validation, definition: parsed.definition });
      return;
    }
    if (body.definition !== undefined) {
      res.json({ validation: validateGoalGraph(body.definition) });
      return;
    }
    throw new GoalStudioFailure('VALIDATION', 'body must contain yaml or definition');
  }));

  app.get(BASE, read, handle(async (req, res, graphs) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    res.json({ graphs: await graphs.listGraphs(projectId) });
  }));

  app.get(`${BASE}/:graphId`, read, handle(async (req, res, graphs) => {
    const record = await graphs.getRevision(param(req, "graphId"));
    if (!record) throw new GoalStudioFailure('NOT_FOUND', `graph ${param(req, "graphId")} not found`);
    res.json({ record });
  }));

  app.get(`${BASE}/:graphId/revisions`, read, handle(async (req, res, graphs) => {
    const revisions = await graphs.listRevisions(param(req, "graphId"));
    if (revisions.length === 0) throw new GoalStudioFailure('NOT_FOUND', `graph ${param(req, "graphId")} not found`);
    res.json({ revisions });
  }));

  app.get(`${BASE}/:graphId/revisions/:rev`, read, handle(async (req, res, graphs) => {
    const rev = revisionParam(param(req, "rev"), 'rev');
    const record = await graphs.getRevision(param(req, "graphId"), rev);
    if (!record) throw new GoalStudioFailure('NOT_FOUND', `graph ${param(req, "graphId")} revision ${rev} not found`);
    res.json({ record });
  }));

  app.post(`${BASE}/:graphId/revisions`, write, handle(async (req, res, graphs) => {
    const body = bodyOf(req);
    if (body.definition === undefined) throw new GoalStudioFailure('VALIDATION', 'body must be {definition, parentRevision}');
    const parentRevision = typeof body.parentRevision === 'number' ? body.parentRevision : Number.NaN;
    if (!Number.isSafeInteger(parentRevision) || parentRevision < 1) throw new GoalStudioFailure('VALIDATION', 'parentRevision must be a positive integer');
    const validation = graphs.validate(body.definition as never);
    if (!validation.valid) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'goal graph validation failed', details: { issues: validation.issues } }, validation });
      return;
    }
    const record = await graphs.createRevision(param(req, "graphId"), body.definition as never, actorOf(req), parentRevision);
    res.status(201).json({ record });
  }));

  app.get(`${BASE}/:graphId/critical-path`, read, handle(async (req, res, graphs) => {
    const rev = req.query.revision === undefined ? undefined : revisionParam(req.query.revision, 'revision');
    const record = await graphs.getRevision(param(req, "graphId"), rev);
    if (!record) throw new GoalStudioFailure('NOT_FOUND', `graph ${param(req, "graphId")}${rev ? ` revision ${rev}` : ''} not found`);
    const cp = criticalPath(record.definition);
    res.json({ graphId: record.graphId, revision: record.revision, digest: record.digest, path: cp.path, weight: cp.weight, order: topologicalOrder(record.definition) });
  }));

  app.get(`${BASE}/:graphId/diff`, read, handle(async (req, res, graphs) => {
    const from = revisionParam(req.query.from, 'from');
    const to = revisionParam(req.query.to, 'to');
    const [a, b] = await Promise.all([graphs.getRevision(param(req, "graphId"), from), graphs.getRevision(param(req, "graphId"), to)]);
    if (!a || !b) throw new GoalStudioFailure('NOT_FOUND', `graph ${param(req, "graphId")} revision ${!a ? from : to} not found`);
    res.json({ diff: diffRevisions(a, b) });
  }));
}

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body as unknown;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new GoalStudioFailure('VALIDATION', 'JSON object body required');
  return body as Record<string, unknown>;
}

function revisionParam(value: unknown, name: string): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,8}$/.test(value)) throw new GoalStudioFailure('VALIDATION', `${name} must be a positive integer`);
  return Number(value);
}

function sendError(res: Response, err: unknown): void {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && code in GOAL_STUDIO_HTTP_STATUS && err instanceof Error) {
    const c = code as GoalStudioErrorCode;
    // INTERNAL errors keep a generic message so store internals never leak.
    const message = c === 'INTERNAL' ? 'internal error' : err.message;
    const details = c === 'INTERNAL' ? undefined : (err as { details?: Record<string, unknown> }).details;
    res.status(GOAL_STUDIO_HTTP_STATUS[c]).json({ error: { code: c, message, details } });
    return;
  }
  res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
}

function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(v) ? v.join('/') : String(v ?? '');
}

function buildGoalGraphYaml(name: string, objective: string, targets: Array<{
  id?: string;
  stage?: string;
  title: string;
  dependsOn?: string[];
  priority?: number;
  executor?: string;
  artifacts?: string[];
  acceptance?: string[];
  requiresApproval?: boolean;
  externalDependency?: boolean;
}>): string {
  const lines: string[] = [
    'schema_version: "1.0"',
    `name: ${JSON.stringify(name)}`,
    `purpose: ${JSON.stringify(objective)}`,
    'constitution:',
    '  objective_owner: human',
    '  invariants:',
    '    - no_unverified_completion',
    '    - no_fabrication',
    '  needs_approval:',
    '    - external_submission',
    '    - protected_branch_merge',
    '  allowed_unattended:',
    '    - local_read_only',
    '    - drafting',
    '  resource_limits:',
    '    max_tasks_per_run: 12',
    '    max_repairs_per_task: 3',
    '    max_same_action_no_progress: 2',
    '    max_run_minutes: 90',
    '    hosted_spend_usd: 0',
    '    local_model_first: true',
    '    max_concurrent_targets: 1',
    '    max_concurrent_writers_per_worktree: 1',
    'targets:',
  ];

  const effectiveTargets = targets && targets.length > 0 ? targets : [
    {
      id: 'T1',
      stage: 'execution',
      title: name,
      dependsOn: [],
      priority: 100,
      executor: 'fleet_harness',
      artifacts: ['goal-output.md'],
      acceptance: ['Goal output artifact is produced and non-empty.'],
    }
  ];

  for (const t of effectiveTargets) {
    lines.push(`  - id: ${JSON.stringify(t.id || 'T1')}`);
    lines.push(`    stage: ${JSON.stringify(t.stage || 'execution')}`);
    lines.push(`    title: ${JSON.stringify(t.title || name)}`);
    lines.push('    depends_on:');
    for (const d of t.dependsOn || []) {
      lines.push(`      - ${JSON.stringify(d)}`);
    }
    if (!t.dependsOn || t.dependsOn.length === 0) {
      lines.push('      []');
    }
    lines.push(`    priority: ${t.priority ?? 100}`);
    lines.push(`    executor: ${JSON.stringify(t.executor || 'fleet_harness')}`);
    lines.push('    artifacts:');
    for (const a of t.artifacts || ['goal-output.md']) {
      lines.push(`      - ${JSON.stringify(a)}`);
    }
    lines.push('    acceptance:');
    for (const a of t.acceptance || ['Goal output artifact is produced and non-empty.']) {
      lines.push(`      - ${JSON.stringify(a)}`);
    }
    if (t.requiresApproval !== undefined) {
      lines.push(`    requires_approval: ${Boolean(t.requiresApproval)}`);
    }
    if (t.externalDependency !== undefined) {
      lines.push(`    external_dependency: ${Boolean(t.externalDependency)}`);
    }
  }

  const executors = new Set<string>(['fleet_harness', ...effectiveTargets.map(t => t.executor || 'fleet_harness')]);
  lines.push('execution_graph:');
  lines.push(`  entry: ${JSON.stringify(Array.from(executors)[0])}`);
  lines.push('  nodes:');
  for (const ex of executors) {
    lines.push(`    - id: ${JSON.stringify(ex)}`);
    lines.push('      next: []');
  }

  return lines.join('\n');
}

