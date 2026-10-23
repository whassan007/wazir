import type { Express, Request, Response } from 'express';
import {
  GOAL_STUDIO_HTTP_STATUS,
  GoalStudioFailure,
  isPromptAdmin,
  renderPrompt,
  type GoalStudioErrorCode,
  type PromptDraft,
  type PromptStudio,
} from '@wazir/goals';
import type { GoalStudioRouteContext } from './context.js';

// Owned by Goal Studio workstream 08 (Prompt Studio). Mounted under /api/v1/goal-studio/prompts.
//
//   GET  /prompts                       list (viewer)
//   GET  /prompts/:id                   head version + metadata (viewer)
//   GET  /prompts/:id/versions          full version history (viewer)
//   GET  /prompts/:id/versions/:v       one immutable version (viewer)
//   GET  /prompts/:id/diff?a=&b=        line diff + schema/capability changes (viewer)
//   GET  /prompts/:id/evaluations       stored evaluation results, ?version= (viewer)
//   POST /prompts/:id/render            render preview with input validation (viewer; no side effects)
//   POST /prompts                       publish a new version, or create (operator)
//   POST /prompts/:id/versions          publish a new version of :id (operator)
//   POST /prompts/:id/rollback          new version copying an older one (operator)
//   POST /prompts/:id/evaluate          run cases with the configured runner (operator; 503 without one)

const BASE = '/api/v1/goal-studio/prompts';
/** The executing model is never a principal; mutations are attributed to the authenticated operator. */
const OPERATOR_ACTOR = 'user:operator';

type Handler = (req: Request, res: Response, prompts: PromptStudio) => Promise<void>;

function sendError(res: Response, code: GoalStudioErrorCode, message: string, details?: Record<string, unknown>): void {
  res.status(GOAL_STUDIO_HTTP_STATUS[code] ?? 500).json({ error: { code, message, details } });
}

function notConfigured(res: Response, what = 'prompts'): void {
  res.status(503).json({ error: { code: 'INTERNAL', message: `${what} not configured` } });
}

function param(req: Request, name: string): string {
  const raw = req.params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !value) throw new GoalStudioFailure('VALIDATION', `missing route parameter '${name}'`);
  return value;
}

function parseVersion(raw: unknown, name: string): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1) throw new GoalStudioFailure('VALIDATION', `${name} must be a positive integer version`);
  return value;
}

function body(req: Request): Record<string, unknown> {
  const value = req.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoalStudioFailure('VALIDATION', 'request body must be a JSON object');
  return value as Record<string, unknown>;
}

function toDraft(input: Record<string, unknown>): PromptDraft {
  let expectedVersion: number | undefined;
  if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
    expectedVersion = Number(input.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new GoalStudioFailure('VALIDATION', 'expectedVersion must be a non-negative integer');
  }
  return {
    id: input.id as string | undefined,
    executorKey: input.executorKey as string,
    role: input.role as string,
    template: input.template as string,
    inputSchema: (input.inputSchema ?? undefined) as Record<string, unknown> | undefined,
    outputSchema: (input.outputSchema ?? undefined) as Record<string, unknown> | undefined,
    requiredCapabilities: input.requiredCapabilities as string[] | undefined,
    note: (input.note ?? undefined) as string | undefined,
    expectedVersion,
  };
}

function isGoalStudioFailure(error: unknown): error is GoalStudioFailure {
  return error instanceof GoalStudioFailure
    || Boolean(error && typeof (error as GoalStudioFailure).code === 'string' && (error as GoalStudioFailure).code in GOAL_STUDIO_HTTP_STATUS && (error as Error).name === 'GoalStudioFailure');
}

export function registerPromptRoutes(app: Express, ctx: GoalStudioRouteContext): void {
  const wrap = (handler: Handler) => async (req: Request, res: Response): Promise<void> => {
    const prompts = ctx.services.prompts;
    if (!prompts || !isPromptAdmin(prompts)) {
      notConfigured(res);
      return;
    }
    try {
      await handler(req, res, prompts);
    } catch (error) {
      if (isGoalStudioFailure(error)) {
        sendError(res, error.code, error.message, error.details);
        return;
      }
      sendError(res, 'INTERNAL', 'prompt studio request failed');
    }
  };

  const audit = async (data: Record<string, unknown>): Promise<void> => {
    const governance = ctx.services.governance;
    if (!governance) return;
    try {
      await governance.audit({ seq: 0, type: 'prompt.version', timestamp: new Date().toISOString(), data });
    } catch {
      // Audit sink failures must not undo an already-durable version.
    }
  };

  const publish = async (res: Response, prompts: PromptStudio, draft: PromptDraft): Promise<void> => {
    const result = await prompts.publish(draft, OPERATOR_ACTOR);
    if (result.created) await audit({ action: 'publish', promptId: result.prompt.id, version: result.prompt.version, digest: result.prompt.digest, actor: OPERATOR_ACTOR });
    res.status(result.created ? 201 : 200).json(result);
  };

  app.get(BASE, ctx.auth.requireViewerOrOperator, wrap(async (_req, res, prompts) => {
    res.json({ prompts: await prompts.list(), canEvaluate: prompts.canEvaluate });
  }));

  app.get(`${BASE}/:id`, ctx.auth.requireViewerOrOperator, wrap(async (req, res, prompts) => {
    const id = param(req, 'id');
    const head = await prompts.head(id);
    if (!head) throw new GoalStudioFailure('NOT_FOUND', `prompt '${id}' not found`);
    res.json({ prompt: head, latestVersion: head.version, canEvaluate: prompts.canEvaluate });
  }));

  app.get(`${BASE}/:id/versions`, ctx.auth.requireViewerOrOperator, wrap(async (req, res, prompts) => {
    const id = param(req, 'id');
    const versions = await prompts.history(id);
    if (!versions.length) throw new GoalStudioFailure('NOT_FOUND', `prompt '${id}' not found`);
    res.json({ promptId: id, versions });
  }));

  app.get(`${BASE}/:id/versions/:version`, ctx.auth.requireViewerOrOperator, wrap(async (req, res, prompts) => {
    res.json({ prompt: await prompts.resolve({ promptId: param(req, 'id'), version: parseVersion(param(req, 'version'), 'version') }) });
  }));

  app.get(`${BASE}/:id/diff`, ctx.auth.requireViewerOrOperator, wrap(async (req, res, prompts) => {
    const a = req.query.a ?? req.query.from;
    const b = req.query.b ?? req.query.to;
    res.json(await prompts.diff(param(req, 'id'), parseVersion(a, 'a'), parseVersion(b, 'b')));
  }));

  app.get(`${BASE}/:id/evaluations`, ctx.auth.requireViewerOrOperator, wrap(async (req, res, prompts) => {
    const id = param(req, 'id');
    const version = req.query.version === undefined ? undefined : parseVersion(req.query.version, 'version');
    res.json({ promptId: id, evaluations: await prompts.evaluations(id, version) });
  }));

  app.post(`${BASE}/:id/render`, ctx.auth.requireViewerOrOperator, wrap(async (req, res, prompts) => {
    const id = param(req, 'id');
    const input = body(req);
    const def = input.version === undefined
      ? await prompts.head(id)
      : await prompts.resolve({ promptId: id, version: parseVersion(input.version, 'version') });
    if (!def) throw new GoalStudioFailure('NOT_FOUND', `prompt '${id}' not found`);
    const rendered = renderPrompt(def, (input.inputs ?? input.variables ?? {}) as Record<string, unknown>);
    res.json({ promptId: def.id, version: def.version, digest: def.digest, ...rendered });
  }));

  app.post(BASE, ctx.auth.requireOperator, wrap(async (req, res, prompts) => {
    await publish(res, prompts, toDraft(body(req)));
  }));

  app.post(`${BASE}/:id/versions`, ctx.auth.requireOperator, wrap(async (req, res, prompts) => {
    const id = param(req, 'id');
    const input = body(req);
    if (input.id !== undefined && input.id !== id) throw new GoalStudioFailure('VALIDATION', 'body id does not match the path');
    const head = await prompts.head(id);
    if (!head) throw new GoalStudioFailure('NOT_FOUND', `prompt '${id}' not found; POST ${BASE} to create it`);
    await publish(res, prompts, toDraft({ executorKey: head.executorKey, ...input, id }));
  }));

  app.post(`${BASE}/:id/rollback`, ctx.auth.requireOperator, wrap(async (req, res, prompts) => {
    const id = param(req, 'id');
    const input = body(req);
    const note = input.note === undefined || input.note === null ? undefined : String(input.note).slice(0, 2000);
    const rawTarget = input.toVersion ?? input.targetVersion ?? input.version;
    const result = await prompts.rollback(id, parseVersion(rawTarget, 'toVersion'), OPERATOR_ACTOR, note);
    if (result.created) await audit({ action: 'rollback', promptId: result.prompt.id, version: result.prompt.version, rollbackOf: result.prompt.rollbackOf, digest: result.prompt.digest, actor: OPERATOR_ACTOR });
    res.status(result.created ? 201 : 200).json(result);
  }));

  app.post(`${BASE}/:id/evaluate`, ctx.auth.requireOperator, wrap(async (req, res, prompts) => {
    const id = param(req, 'id');
    if (!prompts.canEvaluate) {
      notConfigured(res, 'prompt evaluation runner');
      return;
    }
    const input = body(req);
    const cases = input.cases as Parameters<PromptStudio['evaluate']>[2];
    if (input.compareWith !== undefined && input.compareWith !== null) {
      const a = parseVersion(input.version, 'version');
      const b = parseVersion(input.compareWith, 'compareWith');
      res.json({ comparison: await prompts.compareVersions(id, a, b, cases, OPERATOR_ACTOR) });
      return;
    }
    const version = input.version === undefined || input.version === null ? undefined : parseVersion(input.version, 'version');
    res.json({ evaluation: await prompts.evaluate(id, version, cases, OPERATOR_ACTOR) });
  }));
}
