import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { GOAL_STUDIO_HTTP_STATUS, GoalStudioFailure } from '@wazir/goals';
import type {
  GoalEventLog,
  GoalRunLedger,
  GoalRunStatus,
  GoalStudioErrorCode,
  GoalStudioEvent,
  GoalStudioEventType,
  GoalStudioServices,
  TargetAttempt,
} from '@wazir/goals';
import type { GoalStudioRouteContext } from './context.js';
import type { GoalStudioApprovals } from './controlApprovals.js';

// Owned by Goal Studio workstream 07 (Execution Control Center).
// Mounted under /api/v1/goal-studio/. These routes are registered before the
// server's blanket `/api/v1` viewer gate, so every route applies auth itself.

export const GOAL_STUDIO_BASE = '/api/v1/goal-studio';

export interface ControlRouteOptions {
  /** Approval broker; falls back to `(ctx.services as any).approvals`. */
  approvals?: GoalStudioApprovals;
  /** SSE heartbeat interval. Default 15s. */
  heartbeatMs?: number;
  /** Events replayed per read page. Default 500. */
  replayPageSize?: number;
}

type ControlServices = Partial<GoalStudioServices> & { approvals?: GoalStudioApprovals };

const RUN_STATUSES: readonly GoalRunStatus[] = ['created', 'running', 'pausing', 'paused', 'stopping', 'stopped', 'idle', 'completed', 'failed'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

interface ErrorBody { error: { code: GoalStudioErrorCode; message: string; details?: Record<string, unknown> } }

function sendError(res: Response, code: GoalStudioErrorCode, message: string, details?: Record<string, unknown>, status?: number): void {
  const body: ErrorBody = { error: { code, message, ...(details ? { details } : {}) } };
  res.status(status ?? GOAL_STUDIO_HTTP_STATUS[code] ?? 500).json(body);
}

function isFailureLike(error: unknown): error is { code: GoalStudioErrorCode; message: string; details?: Record<string, unknown> } {
  return typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
    && (error as { code: string }).code in GOAL_STUDIO_HTTP_STATUS;
}

function sendFailure(res: Response, error: unknown): void {
  if (res.headersSent) return;
  if (error instanceof GoalStudioFailure || isFailureLike(error)) {
    sendError(res, error.code, error.message, error.details);
    return;
  }
  // Never echo internals (stack, paths) for unexpected errors.
  console.error('[goal-studio] control route failed:', error instanceof Error ? error.message : String(error));
  sendError(res, 'INTERNAL', 'internal error');
}

function errorCode(error: unknown): string {
  return isFailureLike(error) ? error.code : 'INTERNAL';
}

function notConfigured(res: Response, name: string): void {
  sendError(res, 'INTERNAL', `${name} not configured`, undefined, 503);
}

function param(req: Request, name: string): string | undefined {
  const raw = req.params[name];
  const value = typeof raw === 'string' ? raw : undefined;
  return value && ID_PATTERN.test(value) ? value : undefined;
}

function queryId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

/** undefined = absent; NaN = malformed. */
function parseCursor(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(Array.isArray(value) ? value[0] : value).trim();
  if (!/^\d{1,15}$/.test(text)) return NaN;
  return Number(text);
}

function withExecutionLinks(attempt: TargetAttempt): TargetAttempt & { links?: { execution: string; events: string } } {
  if (!attempt.executionId) return attempt;
  const id = encodeURIComponent(attempt.executionId);
  return { ...attempt, links: { execution: `/api/v1/executions/${id}`, events: `/api/v1/executions/${id}/events` } };
}

export function runSummary(run: GoalRunLedger) {
  const targetCounts: Record<string, number> = {};
  for (const entry of Object.values(run.targets ?? {})) targetCounts[entry.status] = (targetCounts[entry.status] ?? 0) + 1;
  return {
    runId: run.runId,
    graphId: run.graphId,
    graphRevision: run.graphRevision,
    status: run.status,
    ledgerRevision: run.ledgerRevision,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    targetCounts,
    resource: run.resource,
  };
}

export function registerControlRoutes(app: Express, ctx: GoalStudioRouteContext, options: ControlRouteOptions = {}): void {
  const base = GOAL_STUDIO_BASE;
  const services = (): ControlServices => ctx.services as ControlServices;
  const approvalsOf = (): GoalStudioApprovals | undefined => options.approvals ?? services().approvals;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const pageSize = Math.max(1, options.replayPageSize ?? 500);
  const json = express.json({ limit: '64kb' });

  // The principal comes only from the authenticated credential, never the body.
  const actorFor = (req: Request): string => `user:${ctx.auth.principalFor(req)?.id ?? 'unknown'}`;

  const audit = async (
    req: Request,
    type: GoalStudioEventType,
    data: Record<string, unknown>,
    scope: { runId?: string; targetId?: string } = {},
  ): Promise<void> => {
    const governance = services().governance;
    if (!governance) return;
    const event: GoalStudioEvent = {
      seq: 0, // audit-only envelope; not part of a run's replayable stream
      type,
      runId: scope.runId,
      targetId: scope.targetId,
      timestamp: new Date().toISOString(),
      data: { surface: 'goal-studio-control', method: req.method, path: req.path, ...data },
    };
    await governance.audit(event).catch(() => undefined);
  };

  const requireRead = ctx.auth.requireViewerOrOperator;
  // Operator gate that also audits denied control-plane attempts (§8).
  const requireWrite = (req: Request, res: Response, next: NextFunction): void => {
    if (ctx.auth.isOperatorRequest(req)) {
      next();
      return;
    }
    const principal = ctx.auth.principalFor(req);
    void audit(req, 'governance.denied', {
      reason: 'operator scope required',
      principal: principal ? `user:${principal.id}` : 'anonymous',
    }, { runId: typeof req.params.runId === 'string' ? req.params.runId : undefined });
    ctx.auth.requireOperator(req, res, next);
  };

  // ----- runs ---------------------------------------------------------------

  app.post(`${base}/runs`, requireWrite, json, async (req, res) => {
    const controller = services().controller;
    if (!controller) return notConfigured(res, 'controller');
    const body = (req.body ?? {}) as { graphId?: unknown; graphRevision?: unknown };
    if (typeof body.graphId !== 'string' || !ID_PATTERN.test(body.graphId)) {
      return sendError(res, 'VALIDATION', 'graphId is required');
    }
    if (body.graphRevision !== undefined && body.graphRevision !== null
      && (!Number.isInteger(body.graphRevision) || (body.graphRevision as number) < 1)) {
      return sendError(res, 'VALIDATION', 'graphRevision must be a positive integer');
    }
    const graphRevision = typeof body.graphRevision === 'number' ? body.graphRevision : undefined;
    const principal = actorFor(req);
    try {
      // The controller owns the run lifecycle and is not tied to this request:
      // a browser that disconnects right after this call leaves the run going.
      const run = await controller.startRun({ graphId: body.graphId, graphRevision, principal });
      await audit(req, 'run.created', { action: 'start', principal, graphId: body.graphId, graphRevision: run.graphRevision }, { runId: run.runId });
      res.status(201).json({ run });
    } catch (error) {
      await audit(req, 'error', { action: 'start', principal, code: errorCode(error) });
      sendFailure(res, error);
    }
  });

  app.get(`${base}/runs`, requireRead, async (req, res) => {
    const ledger = services().ledger;
    if (!ledger) return notConfigured(res, 'ledger');
    const graphId = queryId(req.query.graphId);
    if (graphId === null) return sendError(res, 'VALIDATION', 'invalid graphId');
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status !== undefined && !RUN_STATUSES.includes(status as GoalRunStatus)) {
      return sendError(res, 'VALIDATION', `status must be one of ${RUN_STATUSES.join(', ')}`);
    }
    try {
      const runs = await ledger.listRuns({ graphId, status: status as GoalRunStatus | undefined });
      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.json({ runs: runs.map(runSummary) });
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get(`${base}/runs/:runId`, requireRead, async (req, res) => {
    const ledger = services().ledger;
    if (!ledger) return notConfigured(res, 'ledger');
    const runId = param(req, 'runId');
    if (!runId) return sendError(res, 'VALIDATION', 'invalid runId');
    try {
      const run = await ledger.getRun(runId);
      if (!run) return sendError(res, 'NOT_FOUND', `run '${runId}' not found`);
      res.json({ run });
    } catch (error) {
      sendFailure(res, error);
    }
  });

  for (const action of ['pause', 'resume', 'stop'] as const) {
    app.post(`${base}/runs/:runId/${action}`, requireWrite, async (req, res) => {
      const controller = services().controller;
      if (!controller) return notConfigured(res, 'controller');
      const runId = param(req, 'runId');
      if (!runId) return sendError(res, 'VALIDATION', 'invalid runId');
      const principal = actorFor(req);
      try {
        const run = await controller[action](runId, principal);
        await audit(req, 'run.status', { action, principal, status: run.status }, { runId });
        res.json({ run });
      } catch (error) {
        await audit(req, 'error', { action, principal, code: errorCode(error) }, { runId });
        sendFailure(res, error);
      }
    });
  }

  // Cancel is an alias for stop with audited 'cancel' action
  app.post(`${base}/runs/:runId/cancel`, requireWrite, async (req, res) => {
    const controller = services().controller;
    if (!controller) return notConfigured(res, 'controller');
    const runId = param(req, 'runId');
    if (!runId) return sendError(res, 'VALIDATION', 'invalid runId');
    const principal = actorFor(req);
    try {
      const run = await controller.stop(runId, principal);
      await audit(req, 'run.status', { action: 'cancel', principal, status: run.status }, { runId });
      res.json({ run });
    } catch (error) {
      await audit(req, 'error', { action: 'cancel', principal, code: errorCode(error) }, { runId });
      sendFailure(res, error);
    }
  });

  app.get(`${base}/runs/:runId/results`, requireRead, async (req, res) => {
    const ledger = services().ledger;
    if (!ledger) return notConfigured(res, 'ledger');
    const runId = param(req, 'runId');
    if (!runId) return sendError(res, 'VALIDATION', 'invalid runId');
    try {
      const run = await ledger.getRun(runId);
      if (!run) return sendError(res, 'NOT_FOUND', `run '${runId}' not found`);

      const graphs = services().graphs;
      const graph = graphs ? await graphs.getRevision(run.graphId, run.graphRevision) : undefined;
      const attempts = await ledger.attempts(runId);
      const transitions = await ledger.transitions(runId);
      const verification = services().verification;
      const evidence = verification ? await verification.evidence(runId) : [];

      const artifactSet = new Set<string>();
      for (const e of (evidence as unknown as Array<Record<string, unknown>>)) {
        if (Array.isArray(e.artifacts)) {
          for (const a of e.artifacts) {
            if (typeof a === 'string') artifactSet.add(a);
            else if (a && typeof (a as { path?: unknown }).path === 'string') artifactSet.add((a as { path: string }).path);
          }
        }
        if (typeof e.artifact === 'string') artifactSet.add(e.artifact);
        else if (e.artifact && typeof (e.artifact as { path?: unknown }).path === 'string') artifactSet.add((e.artifact as { path: string }).path);
        if (e.data && typeof e.data === 'object') {
          const dataObj = e.data as Record<string, unknown>;
          if (Array.isArray(dataObj.artifacts)) {
            for (const a of dataObj.artifacts) {
              if (typeof a === 'string') artifactSet.add(a);
              else if (a && typeof (a as { path?: unknown }).path === 'string') artifactSet.add((a as { path: string }).path);
            }
          }
        }
      }
      if (graph && graph.definition && Array.isArray(graph.definition.targets)) {
        for (const t of graph.definition.targets) {
          if (Array.isArray(t.artifacts)) {
            for (const a of t.artifacts) {
              if (typeof a === 'string') artifactSet.add(a);
            }
          }
        }
      }
      const artifacts = Array.from(artifactSet);

      const targets: Record<string, { status: string; title?: string; stage?: string; artifacts?: string[] }> = {};
      if (graph && graph.definition && Array.isArray(graph.definition.targets)) {
        for (const t of graph.definition.targets) {
          targets[t.id] = {
            status: run.targets?.[t.id]?.status ?? 'pending',
            title: t.title,
            stage: t.stage,
            artifacts: t.artifacts,
          };
        }
      }
      if (run.targets) {
        for (const [id, t] of Object.entries(run.targets)) {
          if (!targets[id]) {
            targets[id] = { status: (t as { status: string }).status };
          }
        }
      }

      res.json({
        run,
        graph,
        attempts,
        transitions,
        evidence,
        artifacts,
        targets,
        targetSummary: targets,
      });
    } catch (error) {
      sendFailure(res, error);
    }
  });

  for (const [segment, method] of [['retry', 'retryTarget'], ['run', 'runEligible']] as const) {
    app.post(`${base}/runs/:runId/targets/:targetId/${segment}`, requireWrite, async (req, res) => {
      const controller = services().controller;
      if (!controller) return notConfigured(res, 'controller');
      const runId = param(req, 'runId');
      const targetId = param(req, 'targetId');
      if (!runId || !targetId) return sendError(res, 'VALIDATION', 'invalid runId or targetId');
      const principal = actorFor(req);
      try {
        const run = await controller[method](runId, targetId, principal);
        await audit(req, 'target.transition', { action: segment, principal, status: run.targets?.[targetId]?.status }, { runId, targetId });
        res.json({ run });
      } catch (error) {
        await audit(req, 'error', { action: segment, principal, code: errorCode(error) }, { runId, targetId });
        sendFailure(res, error);
      }
    });
  }

  app.get(`${base}/runs/:runId/transitions`, requireRead, async (req, res) => {
    const ledger = services().ledger;
    if (!ledger) return notConfigured(res, 'ledger');
    const runId = param(req, 'runId');
    if (!runId) return sendError(res, 'VALIDATION', 'invalid runId');
    const targetId = queryId(req.query.targetId);
    if (targetId === null) return sendError(res, 'VALIDATION', 'invalid targetId');
    try {
      res.json({ runId, transitions: await ledger.transitions(runId, targetId) });
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get(`${base}/runs/:runId/attempts`, requireRead, async (req, res) => {
    const ledger = services().ledger;
    if (!ledger) return notConfigured(res, 'ledger');
    const runId = param(req, 'runId');
    if (!runId) return sendError(res, 'VALIDATION', 'invalid runId');
    const targetId = queryId(req.query.targetId);
    if (targetId === null) return sendError(res, 'VALIDATION', 'invalid targetId');
    try {
      const attempts = [...await ledger.attempts(runId, targetId)];
      attempts.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      res.json({ runId, attempts: attempts.map(withExecutionLinks) });
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // ----- events: persisted replay, then live, with no gaps or duplicates ----

  app.get(`${base}/runs/:runId/events`, requireRead, async (req, res) => {
    const events = services().events;
    if (!events) return notConfigured(res, 'events');
    const runId = param(req, 'runId');
    if (!runId) return sendError(res, 'VALIDATION', 'invalid runId');
    // Last-Event-ID (sent automatically by EventSource on reconnect) wins over ?after=.
    const fromHeader = parseCursor(req.headers['last-event-id']);
    const fromQuery = parseCursor(req.query.after);
    const after = fromHeader ?? fromQuery ?? 0;
    if (Number.isNaN(after)) return sendError(res, 'VALIDATION', 'after / Last-Event-ID must be a non-negative integer');

    const ledger = services().ledger;
    if (ledger) {
      try {
        if (!(await ledger.getRun(runId))) return sendError(res, 'NOT_FOUND', `run '${runId}' not found`);
      } catch (error) {
        return sendFailure(res, error);
      }
    }

    if (req.query.format === 'json') {
      const limit = parseCursor(req.query.limit);
      const size = limit !== undefined && !Number.isNaN(limit) && limit > 0 ? Math.min(limit, pageSize) : pageSize;
      try {
        const page = await events.read(runId, after, size);
        res.json({ runId, after, events: page, nextAfter: page.length ? page[page.length - 1].seq : after, more: page.length === size });
      } catch (error) {
        sendFailure(res, error);
      }
      return;
    }

    streamRunEvents(req, res, events, runId, after, { heartbeatMs, pageSize });
  });

  // ----- approvals ----------------------------------------------------------

  app.get(`${base}/approvals`, requireRead, (req, res) => {
    const approvals = approvalsOf();
    if (!approvals) return notConfigured(res, 'approvals');
    const runId = queryId(req.query.runId);
    if (runId === null) return sendError(res, 'VALIDATION', 'invalid runId');
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    if (!['pending', 'approved', 'denied', 'expired', 'all'].includes(status)) {
      return sendError(res, 'VALIDATION', 'status must be pending, approved, denied, expired or all');
    }
    const list = approvals.list({ runId, status: status === 'all' ? undefined : status as 'pending' });
    res.json({ approvals: list, pendingCount: approvals.list({ runId, status: 'pending' }).length });
  });

  app.get(`${base}/runs/:runId/approvals`, requireRead, (req, res) => {
    const approvals = approvalsOf();
    if (!approvals) return notConfigured(res, 'approvals');
    const runId = param(req, 'runId');
    if (!runId) return sendError(res, 'VALIDATION', 'invalid runId');
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    if (!['pending', 'approved', 'denied', 'expired', 'all'].includes(status)) {
      return sendError(res, 'VALIDATION', 'status must be pending, approved, denied, expired or all');
    }
    const list = approvals.list({ runId, status: status === 'all' ? undefined : status as 'pending' });
    res.json({ runId, approvals: list, pendingCount: approvals.list({ runId, status: 'pending' }).length });
  });

  const handleResolveApproval = async (req: Request, res: Response, id: string | undefined, decision: 'approve' | 'deny', boundRunId?: string): Promise<void> => {
    const approvals = approvalsOf();
    if (!approvals) return notConfigured(res, 'approvals');
    if (!id) return sendError(res, 'VALIDATION', 'invalid approval id');
    const body = (req.body ?? {}) as {
      runId?: unknown; targetId?: unknown; attempt?: unknown; action?: unknown;
      reason?: unknown; note?: unknown;
    };
    const expected = {
      runId: boundRunId ?? (typeof body.runId === 'string' ? body.runId : undefined),
      targetId: typeof body.targetId === 'string' ? body.targetId : undefined,
      attempt: Number.isInteger(body.attempt) ? body.attempt as number : undefined,
      action: typeof body.action === 'string' ? body.action : undefined,
    };
    if (boundRunId && typeof body.runId === 'string' && body.runId !== boundRunId) {
      return sendError(res, 'FORBIDDEN', 'approval runId does not match route runId', { reason: 'SCOPE_MISMATCH' });
    }
    const reason = typeof body.reason === 'string' ? body.reason : typeof body.note === 'string' ? body.note : undefined;
    const principal = actorFor(req);
    const result = approvals.resolve(id, decision === 'approve', principal, expected, reason);
    if (result.ok === false) {
      await audit(req, 'governance.denied', { action: decision, approvalId: id, principal, reason: result.code }, { runId: result.record?.scope?.runId ?? boundRunId });
      const codeMap = { NOT_FOUND: 'NOT_FOUND', ALREADY_RESOLVED: 'DUPLICATE', EXPIRED: 'CANCELLED', SCOPE_MISMATCH: 'FORBIDDEN' } as const;
      return sendError(res, codeMap[result.code], result.message, { reason: result.code });
    }
    await audit(req, 'approval.resolved', { action: decision, approvalId: id, principal, ...(reason ? { reason } : {}) }, { runId: result.record.scope?.runId, targetId: result.record.scope?.targetId });
    res.json({ approval: approvals.get(id) ?? result.record });
  };

  for (const decision of ['approve', 'deny'] as const) {
    app.post(`${base}/approvals/:id/${decision}`, requireWrite, json, async (req, res) => {
      await handleResolveApproval(req, res, param(req, 'id'), decision);
    });
  }

  app.post(`${base}/runs/:runId/approvals/:approvalId/resolve`, requireWrite, json, async (req, res) => {
    const runId = param(req, 'runId');
    if (!runId) return sendError(res, 'VALIDATION', 'invalid runId');
    const approvalId = param(req, 'approvalId');
    const body = (req.body ?? {}) as { decision?: unknown; approved?: unknown };
    let decision: 'approve' | 'deny' | undefined;
    if (body.decision === 'approve' || body.decision === 'approved' || body.approved === true) {
      decision = 'approve';
    } else if (body.decision === 'deny' || body.decision === 'denied' || body.decision === 'reject' || body.decision === 'rejected' || body.approved === false) {
      decision = 'deny';
    }
    if (!decision) {
      return sendError(res, 'VALIDATION', "decision must be 'approve' or 'deny' (or 'reject')");
    }
    await handleResolveApproval(req, res, approvalId, decision, runId);
  });
}

/**
 * SSE delivery for one run. Frames are emitted strictly in seq order starting
 * after `after`, with no duplicates, and nothing persisted is ever skipped.
 *
 * We subscribe before replaying so nothing appended during replay is lost, and
 * treat a live notification only as a fast path: when it is not the immediate
 * successor of the last delivered seq we read the persisted log (the source of
 * truth) to fill the hole first. All delivery runs on one promise chain, so
 * replay and live frames never interleave. Each frame carries `id: <seq>`, so a
 * reconnecting EventSource resumes via Last-Event-ID automatically.
 */
function streamRunEvents(
  req: Request,
  res: Response,
  events: GoalEventLog,
  runId: string,
  after: number,
  options: { heartbeatMs: number; pageSize: number },
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`retry: 3000\n: goal-studio run=${runId} after=${after}\n\n`);

  let cursor = after;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
  };
  // Registered before any await so a client that disconnects mid-replay never leaks.
  req.on('close', cleanup);
  res.on('close', cleanup);

  const write = (event: GoalStudioEvent): void => {
    if (closed || event.seq <= cursor) return;
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    cursor = event.seq;
  };

  const drain = async (): Promise<void> => {
    while (!closed) {
      const page = await events.read(runId, cursor, options.pageSize);
      for (const event of page) write(event);
      if (page.length < options.pageSize) return;
    }
  };

  const enqueue = (task: () => Promise<void> | void): void => {
    chain = chain.then(task).catch((error: unknown) => {
      if (closed) return;
      res.write(`: replay error ${JSON.stringify(error instanceof Error ? error.message : String(error))}\n\n`);
    });
  };

  unsubscribe = events.subscribe(runId, (event) => {
    enqueue(async () => {
      if (closed || event.seq <= cursor) return;
      if (event.seq !== cursor + 1) await drain();
      write(event);
    });
  });
  if (closed) {
    unsubscribe();
    return;
  }
  enqueue(drain);

  heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(`: heartbeat ${new Date().toISOString()} cursor=${cursor}\n\n`);
    } catch {
      cleanup();
    }
  }, options.heartbeatMs);
  heartbeat.unref?.();
}
