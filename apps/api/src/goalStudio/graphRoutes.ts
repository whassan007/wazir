import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
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
