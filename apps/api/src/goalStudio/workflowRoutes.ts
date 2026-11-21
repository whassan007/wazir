import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import express from 'express';
import {
  GOAL_STUDIO_HTTP_STATUS,
  GoalStudioFailure,
  WORKFLOW_STORE_KEYS,
  compileWorkflow,
  criticalPath,
  topologicalOrder,
  type GoalGraphDefinition,
  type GoalRunLedger,
  type GoalRunStatus,
  type GoalStudioErrorCode,
  type GoalStudioEvent,
  type GoalStudioEventType,
  type GoalStudioServices,
  type WorkflowCompileRequest,
  type WorkflowMode,
  type WorkflowOriginInterface,
  type WorkflowPlanRecord,
  type WorkflowRuntimeService,
} from '@wazir/goals';
import type { GoalStudioRouteContext } from './context.js';

const BASE = '/api/v1/goal-studio/workflows';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const RUN_STATUSES: readonly GoalRunStatus[] = [
  'created',
  'running',
  'pausing',
  'paused',
  'stopping',
  'stopped',
  'idle',
  'completed',
  'failed',
];
const WORKFLOW_MODES: readonly WorkflowMode[] = ['single', 'loop', 'graph', 'hybrid'];
const ORIGIN_INTERFACES: readonly WorkflowOriginInterface[] = ['shell', 'cli', 'tui', 'api', 'web', 'desktop'];

type WorkflowServices = Partial<GoalStudioServices> & {
  workflow?: WorkflowRuntimeService;
  workspaceRoot?: string;
};

function isFailureLike(
  error: unknown,
): error is { code: GoalStudioErrorCode; message: string; details?: Record<string, unknown> } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code in GOAL_STUDIO_HTTP_STATUS
  );
}

function sendError(
  res: Response,
  code: GoalStudioErrorCode,
  message: string,
  details?: Record<string, unknown>,
  statusOverride?: number,
): void {
  const status = statusOverride ?? GOAL_STUDIO_HTTP_STATUS[code] ?? 500;
  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}

function sendFailure(res: Response, error: unknown): void {
  if (res.headersSent) return;
  if (error instanceof GoalStudioFailure || isFailureLike(error)) {
    const message = error.code === 'INTERNAL' ? 'internal error' : error.message;
    const details = error.code === 'INTERNAL' ? undefined : error.details;
    sendError(res, error.code, message, details);
    return;
  }
  console.error('[goal-studio] workflow route failed:', error instanceof Error ? error.message : String(error));
  sendError(res, 'INTERNAL', 'internal error');
}

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body as unknown;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new GoalStudioFailure('VALIDATION', 'JSON object body required');
  }
  return body as Record<string, unknown>;
}

function paramId(req: Request, name: string): string {
  const raw = req.params[name];
  const value = typeof raw === 'string' ? raw : undefined;
  if (!value || !ID_PATTERN.test(value)) {
    throw new GoalStudioFailure('VALIDATION', `invalid ${name}`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 1) {
    throw new GoalStudioFailure('VALIDATION', `${name} must be a positive number`);
  }
  return Math.floor(num);
}

function optionalNonNegativeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new GoalStudioFailure('VALIDATION', `${name} must be a non-negative number`);
  }
  return num;
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new GoalStudioFailure('VALIDATION', `${name} must be an array of strings`);
  }
  return value.map((item) => {
    if (typeof item !== 'string') {
      throw new GoalStudioFailure('VALIDATION', `${name} entries must be strings`);
    }
    return item.trim();
  }).filter(Boolean);
}

function parseWorkflowMode(value: unknown, fieldName: string): WorkflowMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !WORKFLOW_MODES.includes(value as WorkflowMode)) {
    throw new GoalStudioFailure('VALIDATION', `${fieldName} must be one of ${WORKFLOW_MODES.join(', ')}`);
  }
  return value as WorkflowMode;
}

function parseRequestedMode(value: unknown): WorkflowCompileRequest['requestedMode'] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'auto') return 'auto';
  return parseWorkflowMode(value, 'requestedMode');
}

function parseOriginInterface(value: unknown): WorkflowOriginInterface {
  if (value === undefined || value === null || value === '') return 'api';
  if (typeof value !== 'string' || !ORIGIN_INTERFACES.includes(value as WorkflowOriginInterface)) {
    throw new GoalStudioFailure('VALIDATION', `originInterface must be one of ${ORIGIN_INTERFACES.join(', ')}`);
  }
  return value as WorkflowOriginInterface;
}

function parseCompileRequest(
  body: Record<string, unknown>,
  defaultWorkspaceRoot: string,
  actor: string,
  forced?: { requestedMode?: WorkflowCompileRequest['requestedMode']; overrideMode?: WorkflowMode },
): WorkflowCompileRequest {
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw new GoalStudioFailure('VALIDATION', 'prompt is required');
  }

  const requestedMode = forced?.requestedMode ?? parseRequestedMode(body.requestedMode ?? body.mode);
  const overrideMode =
    forced && 'overrideMode' in forced ? forced.overrideMode : parseWorkflowMode(body.overrideMode, 'overrideMode');
  const originInterface = parseOriginInterface(body.originInterface);
  const workspaceRoot =
    typeof body.workspaceRoot === 'string' && body.workspaceRoot.trim()
      ? body.workspaceRoot.trim()
      : defaultWorkspaceRoot;

  return {
    prompt: body.prompt.trim(),
    requestedMode,
    overrideMode,
    originInterface,
    workspaceRoot,
    projectId: typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : undefined,
    graphName: typeof body.graphName === 'string' && body.graphName.trim() ? body.graphName.trim() : undefined,
    actor,
    maxIterations: optionalPositiveInt(body.maxIterations, 'maxIterations'),
    maxConcurrency: optionalPositiveInt(body.maxConcurrency, 'maxConcurrency'),
    maxDurationMinutes: optionalPositiveInt(body.maxDurationMinutes, 'maxDurationMinutes'),
    maxBudgetUsd: optionalNonNegativeNumber(body.maxBudgetUsd, 'maxBudgetUsd'),
    maxRepairsPerTask: optionalNonNegativeNumber(body.maxRepairsPerTask, 'maxRepairsPerTask'),
    maxSameActionNoProgress: optionalPositiveInt(body.maxSameActionNoProgress, 'maxSameActionNoProgress'),
    dryRun: body.dryRun === undefined ? undefined : Boolean(body.dryRun),
    approveAll: body.approveAll === undefined ? undefined : Boolean(body.approveAll),
    localModelFirst: body.localModelFirst === undefined ? undefined : Boolean(body.localModelFirst),
    preferredModel:
      typeof body.preferredModel === 'string' && body.preferredModel.trim() ? body.preferredModel.trim() : undefined,
    computer: typeof body.computer === 'string' && body.computer.trim() ? body.computer.trim() : undefined,
    items: optionalStringArray(body.items, 'items'),
    completionCondition:
      typeof body.completionCondition === 'string' && body.completionCondition.trim()
        ? body.completionCondition.trim()
        : undefined,
    allowProductionDeploy: body.allowProductionDeploy === undefined ? undefined : Boolean(body.allowProductionDeploy),
    verifyCommands: optionalStringArray(body.verifyCommands, 'verifyCommands'),
  };
}

function summarizeTargets(
  definition: GoalGraphDefinition | undefined,
  run: GoalRunLedger | undefined,
): Array<{
  id: string;
  title: string;
  stage: string;
  status: string;
  dependsOn: string[];
  requiresApproval?: boolean;
}> {
  if (!definition?.targets) return [];
  return definition.targets.map((t) => ({
    id: t.id,
    title: t.title,
    stage: t.stage,
    status: run?.targets?.[t.id]?.status ?? 'queued',
    dependsOn: t.dependsOn,
    ...(t.requiresApproval ? { requiresApproval: true } : {}),
  }));
}

export function registerWorkflowRoutes(app: Express, ctx: GoalStudioRouteContext): void {
  const json = express.json({ limit: '128kb' });
  const servicesOf = (): WorkflowServices => ctx.services as WorkflowServices;
  const actorOf = (req: Request): string => `user:${ctx.auth.principalFor(req)?.id ?? 'operator'}`;

  const audit = async (
    req: Request,
    type: GoalStudioEventType,
    data: Record<string, unknown>,
    scope: { runId?: string; targetId?: string } = {},
  ): Promise<void> => {
    const governance = servicesOf().governance;
    if (!governance) return;
    const event: GoalStudioEvent = {
      seq: 0,
      type,
      runId: scope.runId,
      targetId: scope.targetId,
      timestamp: new Date().toISOString(),
      data: { surface: 'goal-studio-workflow', method: req.method, path: req.path, ...data },
    };
    await governance.audit(event).catch(() => undefined);
  };

  const requireRead = ctx.auth.requireViewerOrOperator;
  const requireWrite = (req: Request, res: Response, next: NextFunction): void => {
    if (ctx.auth.isOperatorRequest(req)) {
      next();
      return;
    }
    const principal = ctx.auth.principalFor(req);
    void audit(
      req,
      'governance.denied',
      {
        reason: 'operator scope required',
        principal: principal ? `user:${principal.id}` : 'anonymous',
      },
      { runId: typeof req.params.runId === 'string' ? req.params.runId : undefined },
    );
    ctx.auth.requireOperator(req, res, next);
  };

  const handle = (fn: (req: Request, res: Response, workflow: WorkflowRuntimeService) => Promise<void>): RequestHandler =>
    (req: Request, res: Response, _next: NextFunction) => {
      const workflow = servicesOf().workflow;
      if (!workflow) {
        sendError(res, 'INTERNAL', 'workflow service not configured', undefined, 503);
        return;
      }
      fn(req, res, workflow).catch((err) => sendFailure(res, err));
    };

  const defaultWorkspaceRoot = (): string => servicesOf().workspaceRoot || process.cwd();

  const launchWorkflow = async (
    req: Request,
    res: Response,
    workflow: WorkflowRuntimeService,
    forced: { requestedMode: WorkflowCompileRequest['requestedMode']; overrideMode?: WorkflowMode },
  ): Promise<void> => {
    const body = bodyOf(req);
    const actor = actorOf(req);
    const compileReq = parseCompileRequest(body, defaultWorkspaceRoot(), actor, forced);

    if (body.wait === true) {
      const executed = await workflow.executeToCompletion(compileReq);
      const summary = await workflow.getStatus(executed.run.runId);
      const graph = await workflow.graphs.getRevision(executed.run.graphId, executed.run.graphRevision).catch(() => undefined);
      await audit(
        req,
        'run.created',
        { action: 'launch', mode: executed.plan.mode, requestedMode: compileReq.requestedMode, actor, wait: true },
        { runId: executed.run.runId },
      );
      res.status(201).json({
        run: executed.run,
        plan: executed.plan,
        graph,
        evidence: executed.evidence,
        explanation: executed.plan.explanation,
        criticalPath: executed.plan.criticalPath,
        topologicalOrder: executed.plan.topologicalOrder,
        loop: executed.plan.loop,
        summary,
      });
      return;
    }

    const started = await workflow.start(compileReq);
    const summary = await workflow.getStatus(started.run.runId);
    await audit(
      req,
      'run.created',
      {
        action: 'launch',
        mode: started.plan.mode,
        requestedMode: compileReq.requestedMode,
        dryRun: started.plan.dryRun,
        actor,
      },
      { runId: started.run.runId },
    );
    res.status(201).json({
      run: started.run,
      plan: started.plan,
      graph: started.graph,
      explanation: started.plan.explanation,
      criticalPath: started.plan.criticalPath,
      topologicalOrder: started.plan.topologicalOrder,
      loop: started.plan.loop,
      summary,
    });
  };

  // POST /api/v1/goal-studio/workflows/compile
  app.post(
    `${BASE}/compile`,
    requireWrite,
    json,
    handle(async (req, res, workflow) => {
      const body = bodyOf(req);
      const actor = actorOf(req);
      const compileReq = parseCompileRequest(body, defaultWorkspaceRoot(), actor);

      if (body.persist === true) {
        const compiled = await workflow.compile(compileReq);
        res.json({
          persisted: true,
          mode: compiled.plan.mode,
          graph: compiled.graph,
          definition: compiled.graph.definition,
          validation: compiled.validation,
          plan: compiled.plan,
          explanation: compiled.plan.explanation,
          criticalPath: compiled.plan.criticalPath,
          topologicalOrder: compiled.plan.topologicalOrder,
          loop: compiled.plan.loop,
          nestedLoops: compiled.plan.nestedLoops,
        });
        return;
      }

      const compiled = compileWorkflow(compileReq);
      res.json({
        persisted: false,
        mode: compiled.plan.mode,
        definition: compiled.definition,
        validation: compiled.validation,
        plan: compiled.plan,
        explanation: compiled.plan.explanation,
        criticalPath: compiled.plan.criticalPath,
        topologicalOrder: compiled.plan.topologicalOrder,
        loop: compiled.plan.loop,
        nestedLoops: compiled.plan.nestedLoops,
      });
    }),
  );

  // POST /api/v1/goal-studio/workflows/loop
  app.post(
    `${BASE}/loop`,
    requireWrite,
    json,
    handle(async (req, res, workflow) => {
      await launchWorkflow(req, res, workflow, { requestedMode: 'loop', overrideMode: undefined });
    }),
  );

  // POST /api/v1/goal-studio/workflows/graph
  app.post(
    `${BASE}/graph`,
    requireWrite,
    json,
    handle(async (req, res, workflow) => {
      await launchWorkflow(req, res, workflow, { requestedMode: 'graph', overrideMode: undefined });
    }),
  );

  // POST /api/v1/goal-studio/workflows/goal
  app.post(
    `${BASE}/goal`,
    requireWrite,
    json,
    handle(async (req, res, workflow) => {
      const body = bodyOf(req);
      const overrideMode = parseWorkflowMode(body.overrideMode, 'overrideMode');
      await launchWorkflow(req, res, workflow, { requestedMode: 'auto', overrideMode });
    }),
  );

  // GET /api/v1/goal-studio/workflows/jobs (registered before /:runId)
  app.get(
    `${BASE}/jobs`,
    requireRead,
    handle(async (req, res, workflow) => {
      const status = typeof req.query.status === 'string' && req.query.status.trim() ? req.query.status.trim() : undefined;
      if (status !== undefined && !RUN_STATUSES.includes(status as GoalRunStatus)) {
        throw new GoalStudioFailure('VALIDATION', `status must be one of ${RUN_STATUSES.join(', ')}`);
      }
      const mode = parseWorkflowMode(req.query.mode, 'mode');
      const projectId =
        typeof req.query.projectId === 'string' && req.query.projectId.trim() ? req.query.projectId.trim() : undefined;

      const jobs = await workflow.listJobs({
        status: status as GoalRunStatus | undefined,
        mode,
        projectId,
      });

      const enriched = await Promise.all(
        jobs.map(async (job) => {
          const [plan, run, graph] = await Promise.all([
            ctx.store.get<WorkflowPlanRecord>(WORKFLOW_STORE_KEYS.run(job.runId)).catch(() => undefined),
            workflow.ledger.getRun(job.runId).catch(() => undefined),
            workflow.graphs.getRevision(job.graphId, job.graphRevision).catch(() => undefined),
          ]);
          const cp = plan?.criticalPath ?? (graph?.definition ? (() => {
            const c = criticalPath(graph.definition);
            return { targets: c.path, depth: c.path.length };
          })() : undefined);
          return {
            ...job,
            ...(cp ? { criticalPath: cp } : {}),
            ...(plan?.loop
              ? {
                  loop: {
                    kind: plan.loop.kind,
                    cursor: job.progress.cursor ?? plan.loop.cursor,
                    total: plan.loop.items.length,
                    maxIterations: plan.loop.maxIterations,
                    maxConcurrency: plan.loop.maxConcurrency,
                    completionPredicate: plan.loop.completionPredicate,
                  },
                }
              : {}),
            ...(plan?.explanation ? { explanation: plan.explanation } : {}),
            targets: summarizeTargets(graph?.definition, run),
          };
        }),
      );

      res.json({ jobs: enriched, count: enriched.length });
    }),
  );

  // GET /api/v1/goal-studio/workflows/:runId
  app.get(
    `${BASE}/:runId`,
    requireRead,
    handle(async (req, res, workflow) => {
      const runId = paramId(req, 'runId');
      const inspection = await workflow.inspect(runId);
      if (!inspection) {
        throw new GoalStudioFailure('NOT_FOUND', `workflow run '${runId}' not found`);
      }
      const cp =
        inspection.plan?.criticalPath ??
        (() => {
          const resCp = criticalPath(inspection.graph.definition);
          return { targets: resCp.path, depth: resCp.path.length };
        })();
      const topo = inspection.plan?.topologicalOrder ?? topologicalOrder(inspection.graph.definition);

      res.json({
        summary: inspection.summary,
        run: inspection.run,
        graph: inspection.graph,
        plan: inspection.plan,
        targets: inspection.targets,
        criticalPath: cp,
        topologicalOrder: topo,
        loop: inspection.plan?.loop,
        nestedLoops: inspection.plan?.nestedLoops,
        explanation: inspection.plan?.explanation,
        evidence: inspection.evidence,
        events: inspection.events,
      });
    }),
  );

  // POST /api/v1/goal-studio/workflows/:runId/pause
  app.post(
    `${BASE}/:runId/pause`,
    requireWrite,
    json,
    handle(async (req, res, workflow) => {
      const runId = paramId(req, 'runId');
      const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<
        string,
        unknown
      >;
      const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
      const actor = actorOf(req);
      const run = await workflow.pause(runId, actor, reason);
      await audit(req, 'run.status', { action: 'pause', actor, status: run.status, reason }, { runId });
      res.json({ run, summary: await workflow.getStatus(runId) });
    }),
  );

  // POST /api/v1/goal-studio/workflows/:runId/resume
  app.post(
    `${BASE}/:runId/resume`,
    requireWrite,
    json,
    handle(async (req, res, workflow) => {
      const runId = paramId(req, 'runId');
      const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<
        string,
        unknown
      >;
      const actor = actorOf(req);
      const run = await workflow.resume(runId, actor, { wait: body.wait === true });
      await audit(req, 'run.status', { action: 'resume', actor, status: run.status }, { runId });
      res.json({ run, summary: await workflow.getStatus(runId) });
    }),
  );

  // POST /api/v1/goal-studio/workflows/:runId/stop
  app.post(
    `${BASE}/:runId/stop`,
    requireWrite,
    json,
    handle(async (req, res, workflow) => {
      const runId = paramId(req, 'runId');
      const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<
        string,
        unknown
      >;
      const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
      const actor = actorOf(req);
      const run = await workflow.stop(runId, actor, reason);
      await audit(req, 'run.status', { action: 'stop', actor, status: run.status, reason }, { runId });
      res.json({ run, summary: await workflow.getStatus(runId) });
    }),
  );

  // POST /api/v1/goal-studio/workflows/:runId/approve
  app.post(
    `${BASE}/:runId/approve`,
    requireWrite,
    json,
    handle(async (req, res, workflow) => {
      const runId = paramId(req, 'runId');
      const body = bodyOf(req);
      const actor = actorOf(req);
      const note =
        typeof body.note === 'string' && body.note.trim()
          ? body.note.trim()
          : typeof body.reason === 'string' && body.reason.trim()
            ? body.reason.trim()
            : undefined;

      let targetId = typeof body.targetId === 'string' && body.targetId.trim() ? body.targetId.trim() : undefined;
      if (!targetId) {
        const existingRun = await workflow.ledger.getRun(runId);
        if (!existingRun) {
          throw new GoalStudioFailure('NOT_FOUND', `workflow run '${runId}' not found`);
        }
        const pendingTarget = Object.values(existingRun.targets).find((t) => t.status === 'needs_approval');
        if (!pendingTarget) {
          throw new GoalStudioFailure('VALIDATION', 'targetId is required');
        }
        targetId = pendingTarget.targetId;
      }

      const run = await workflow.approve(runId, targetId, actor, note);
      await audit(req, 'approval.resolved', { action: 'approve', actor, targetId, note }, { runId, targetId });
      res.json({ run, summary: await workflow.getStatus(runId) });
    }),
  );
}
