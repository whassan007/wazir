import type { Express, Request, Response } from 'express';
import {
  GOAL_STUDIO_HTTP_STATUS,
  GoalStudioFailure,
  isFleetModelRouter,
  type FleetModelRegistrationInput,
  type FleetModelRouter,
  type GoalStudioErrorCode,
  type RouteRequest,
} from '@wazir/goals';
import type { GoalStudioRouteContext } from './context.js';

const BASE = '/api/v1/goal-studio';

function sendError(res: Response, code: GoalStudioErrorCode, message: string, details?: Record<string, unknown>): void {
  const status = GOAL_STUDIO_HTTP_STATUS[code] ?? 500;
  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}

function handleRouteError(res: Response, err: unknown): void {
  if (err instanceof GoalStudioFailure) {
    sendError(res, err.code, err.message, err.details);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendError(res, 'INTERNAL', message);
}

function requireFleetRouter(ctx: GoalStudioRouteContext, res: Response): FleetModelRouter | undefined {
  const router = ctx.services.router;
  if (!router) {
    res.status(503).json({
      error: {
        code: 'INTERNAL',
        message: 'router not configured',
      },
    });
    return undefined;
  }
  if (!isFleetModelRouter(router)) {
    res.status(503).json({
      error: {
        code: 'INTERNAL',
        message: 'fleet router surface not available on configured router',
      },
    });
    return undefined;
  }
  return router;
}

async function emitAudit(
  ctx: GoalStudioRouteContext,
  req: Request,
  type: 'route.decided' | 'governance.denied',
  data: Record<string, unknown>,
): Promise<void> {
  const governance = ctx.services.governance;
  if (!governance) return;
  const principal = ctx.auth.principalFor(req)?.id ?? 'operator';
  try {
    await governance.audit({
      type,
      timestamp: new Date().toISOString(),
      data: { principal, ...data },
    } as any);
  } catch {
    // Audit logging must not break fleet control-plane responses when event log is unwired.
  }
}

function parseRouteRequest(body: unknown): RouteRequest {
  if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body))) {
    throw new GoalStudioFailure('VALIDATION', 'request body must be a JSON object');
  }
  const raw = (body ?? {}) as Record<string, unknown>;
  if (raw.requiredCapabilities !== undefined && !Array.isArray(raw.requiredCapabilities)) {
    throw new GoalStudioFailure('VALIDATION', 'requiredCapabilities must be an array of strings');
  }
  const requiredCapabilities = Array.isArray(raw.requiredCapabilities)
    ? raw.requiredCapabilities.map((c) => {
        if (typeof c !== 'string') {
          throw new GoalStudioFailure('VALIDATION', 'requiredCapabilities entries must be strings');
        }
        return c;
      })
    : [];

  let remainingHostedBudgetUsd = 0;
  if (raw.remainingHostedBudgetUsd !== undefined) {
    const budget = Number(raw.remainingHostedBudgetUsd);
    if (!Number.isFinite(budget) || budget < 0) {
      throw new GoalStudioFailure('VALIDATION', 'remainingHostedBudgetUsd must be a non-negative number');
    }
    remainingHostedBudgetUsd = budget;
  }

  const localFirst = raw.localFirst === undefined ? true : Boolean(raw.localFirst);

  if (raw.excludeModelIds !== undefined && !Array.isArray(raw.excludeModelIds)) {
    throw new GoalStudioFailure('VALIDATION', 'excludeModelIds must be an array of strings');
  }
  const excludeModelIds = Array.isArray(raw.excludeModelIds)
    ? raw.excludeModelIds.map((id) => {
        if (typeof id !== 'string') {
          throw new GoalStudioFailure('VALIDATION', 'excludeModelIds entries must be strings');
        }
        return id;
      })
    : [];

  return {
    requiredCapabilities,
    remainingHostedBudgetUsd,
    localFirst,
    excludeModelIds,
  };
}

// Owned by Goal Studio workstream 09. Mount routes under /api/v1/goal-studio/.
export function registerFleetRoutes(app: Express, ctx: GoalStudioRouteContext): void {
  // GET /api/v1/goal-studio/fleet/models
  app.get(`${BASE}/fleet/models`, ctx.auth.requireViewerOrOperator, async (_req: Request, res: Response) => {
    const router = requireFleetRouter(ctx, res);
    if (!router) return;
    try {
      const snap = await router.fleet();
      res.json({
        generatedAt: snap.generatedAt,
        readinessTtlMs: snap.readinessTtlMs,
        taskClass: snap.taskClass,
        summary: snap.summary,
        models: snap.models,
        runtimes: snap.runtimes,
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // GET /api/v1/goal-studio/fleet/workers
  app.get(`${BASE}/fleet/workers`, ctx.auth.requireViewerOrOperator, async (_req: Request, res: Response) => {
    const router = requireFleetRouter(ctx, res);
    if (!router) return;
    try {
      const snap = await router.fleet();
      res.json({
        generatedAt: snap.generatedAt,
        summary: {
          computers: snap.summary.computers,
          computersOnline: snap.summary.computersOnline,
          runtimes: snap.summary.runtimes,
          runtimesHealthy: snap.summary.runtimesHealthy,
        },
        workers: snap.computers,
        computers: snap.computers,
        runtimes: snap.runtimes,
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // POST /api/v1/goal-studio/fleet/models/probe
  app.post(`${BASE}/fleet/models/probe`, ctx.auth.requireOperator, async (req: Request, res: Response) => {
    const router = requireFleetRouter(ctx, res);
    if (!router) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const force = typeof body.force === 'boolean' ? body.force : false;
      const tools = typeof body.tools === 'boolean' ? body.tools : undefined;
      let sweep: { probed: unknown[]; skipped: unknown[] };

      if (typeof body.modelId === 'string' && body.modelId.trim()) {
        const modelId = body.modelId.trim();
        const instanceId = typeof body.instanceId === 'string' && body.instanceId.trim() ? body.instanceId.trim() : undefined;
        if (instanceId) {
          const record = await router.readiness.probe({ modelId, instanceId }, { force, tools });
          sweep = { probed: [record], skipped: [] };
        } else {
          sweep = await router.probeLocal({ modelIds: [modelId], force, tools });
        }
      } else {
        if (body.modelIds !== undefined && (!Array.isArray(body.modelIds) || body.modelIds.some((id) => typeof id !== 'string'))) {
          throw new GoalStudioFailure('VALIDATION', 'modelIds must be an array of model id strings');
        }
        const modelIds = Array.isArray(body.modelIds) ? (body.modelIds as string[]) : undefined;
        sweep = await router.probeLocal({ modelIds, force, tools });
      }

      await emitAudit(ctx, req, 'route.decided', {
        action: 'fleet.models.probe',
        probedCount: sweep.probed.length,
        skippedCount: sweep.skipped.length,
      });
      res.json(sweep);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // POST /api/v1/goal-studio/fleet/route
  app.post(`${BASE}/fleet/route`, ctx.auth.requireViewerOrOperator, async (req: Request, res: Response) => {
    const router = requireFleetRouter(ctx, res);
    if (!router) return;
    try {
      const request = parseRouteRequest(req.body);
      const explanation = await router.explain(request);
      res.json({
        decision: explanation.decision ?? null,
        explanation,
        candidates: explanation.candidates,
        decidedAt: explanation.decidedAt,
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // POST /api/v1/goal-studio/fleet/models/register
  app.post(`${BASE}/fleet/models/register`, ctx.auth.requireOperator, async (req: Request, res: Response) => {
    const router = requireFleetRouter(ctx, res);
    if (!router) return;
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new GoalStudioFailure('VALIDATION', 'request body must be a JSON object');
      }
      if (typeof router.registerModel !== 'function') {
        throw new GoalStudioFailure('INTERNAL', 'router does not support model registration');
      }
      const input = req.body as FleetModelRegistrationInput;
      const model = await router.registerModel(input);
      await emitAudit(ctx, req, 'route.decided', {
        action: 'fleet.models.register',
        modelId: model.modelId,
        local: model.local,
        hosted: model.hosted,
      });
      res.status(201).json({ model });
    } catch (err) {
      handleRouteError(res, err);
    }
  });
}

