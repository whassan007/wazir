import type { Express, Request, Response } from 'express';
import {
  GOAL_STUDIO_HTTP_STATUS,
  GoalStudioFailure,
  type GoalRunLedger,
  type GoalTarget,
  type TargetAttempt,
  type GoalVerificationService,
  type SignoffInput,
} from '@wazir/goals';
import type { GoalStudioRouteContext } from './context.js';

const BASE = '/api/v1/goal-studio';

function sendError(res: Response, err: unknown): void {
  if (err instanceof GoalStudioFailure) {
    const status = GOAL_STUDIO_HTTP_STATUS[err.code] ?? 500;
    res.status(status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: { code: 'INTERNAL', message } });
}

function sendNotConfigured(res: Response, serviceName: string): void {
  res.status(503).json({
    error: {
      code: 'INTERNAL',
      message: `${serviceName} not configured`,
    },
  });
}

async function resolveVerifyContext(
  ctx: GoalStudioRouteContext,
  runId: string,
  targetId: string,
  body: Record<string, unknown>,
): Promise<{
  run: GoalRunLedger;
  target: GoalTarget;
  attempt: TargetAttempt;
  workspaceRoot: string;
  executorIdentity: string;
}> {
  let run = body.run as GoalRunLedger | undefined;
  if (!run && ctx.services.ledger) {
    run = await ctx.services.ledger.getRun(runId);
  }
  if (!run) {
    throw new GoalStudioFailure('NOT_FOUND', `run '${runId}' not found`);
  }

  let target = body.target as GoalTarget | undefined;
  if (!target && ctx.services.graphs) {
    const rev = await ctx.services.graphs.getRevision(run.graphId, run.graphRevision);
    target = rev?.definition.targets.find((t) => t.id === targetId);
  }
  if (!target) {
    throw new GoalStudioFailure('NOT_FOUND', `target '${targetId}' not found in run '${runId}'`);
  }

  let attempt = body.attempt as TargetAttempt | undefined;
  const requestedAttemptId = typeof body.attemptId === 'string' && body.attemptId.trim() ? body.attemptId.trim() : undefined;
  if (!attempt && ctx.services.ledger) {
    const attempts = await ctx.services.ledger.attempts(runId, targetId);
    if (requestedAttemptId) {
      attempt = attempts.find((a) => a.id === requestedAttemptId);
    } else {
      const lastId = run.targets?.[targetId]?.lastAttemptId;
      attempt = (lastId ? attempts.find((a) => a.id === lastId) : undefined) ?? attempts[attempts.length - 1];
    }
  }
  if (!attempt) {
    throw new GoalStudioFailure('NOT_FOUND', `attempt not found for target '${targetId}' in run '${runId}'`);
  }

  const workspaceRoot = typeof body.workspaceRoot === 'string' && body.workspaceRoot.trim() ? body.workspaceRoot.trim() : process.cwd();
  const executorIdentity =
    typeof body.executorIdentity === 'string' && body.executorIdentity.trim()
      ? body.executorIdentity.trim()
      : attempt.modelRoute?.modelId
        ? `executor:${attempt.modelRoute.modelId}`
        : `executor:${target.executor}`;

  return { run, target, attempt, workspaceRoot, executorIdentity };
}

// Owned by Goal Studio workstream 04. Mount routes under /api/v1/goal-studio/.
export function registerVerificationRoutes(app: Express, ctx: GoalStudioRouteContext): void {
  // GET /api/v1/goal-studio/runs/:runId/evidence
  app.get(`${BASE}/runs/:runId/evidence`, ctx.auth.requireViewerOrOperator, async (req: Request, res: Response) => {
    const verification = ctx.services.verification;
    if (!verification) {
      sendNotConfigured(res, 'verification');
      return;
    }
    try {
      const runId = String(req.params.runId);
      const targetId = typeof req.query.targetId === 'string' && req.query.targetId.trim() ? req.query.targetId.trim() : undefined;
      const evidence = await verification.evidence(runId, targetId);
      res.json({ runId, evidence });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/v1/goal-studio/runs/:runId/targets/:targetId/evidence
  app.get(`${BASE}/runs/:runId/targets/:targetId/evidence`, ctx.auth.requireViewerOrOperator, async (req: Request, res: Response) => {
    const verification = ctx.services.verification;
    if (!verification) {
      sendNotConfigured(res, 'verification');
      return;
    }
    try {
      const runId = String(req.params.runId);
      const targetId = String(req.params.targetId);
      const evidence = await verification.evidence(runId, targetId);
      res.json({ runId, targetId, evidence });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/v1/goal-studio/runs/:runId/targets/:targetId/verify
  app.post(`${BASE}/runs/:runId/targets/:targetId/verify`, ctx.auth.requireOperator, async (req: Request, res: Response) => {
    const verification = ctx.services.verification;
    if (!verification) {
      sendNotConfigured(res, 'verification');
      return;
    }
    try {
      const runId = String(req.params.runId);
      const targetId = String(req.params.targetId);
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const resolved = await resolveVerifyContext(ctx, runId, targetId, body);
      const newEvidence = await verification.verify(resolved);
      const allEvidence = await verification.evidence(runId, targetId);
      const gate = verification.gate({
        run: resolved.run,
        target: resolved.target,
        attempt: resolved.attempt,
        evidence: allEvidence,
      });
      if (ctx.services.events) {
        await ctx.services.events
          .append({
            type: 'gate.decided',
            runId,
            targetId,
            attemptId: resolved.attempt.id,
            data: { decision: gate.decision, reasons: gate.reasons, perCriterion: gate.perCriterion },
          })
          .catch(() => undefined);
      }
      if (ctx.services.governance) {
        const principal = ctx.auth.principalFor(req)?.id ?? 'operator';
        await ctx.services.governance
          .audit({
            seq: 0,
            type: 'gate.decided',
            runId,
            targetId,
            attemptId: resolved.attempt.id,
            timestamp: gate.decidedAt,
            data: { action: 'verify', principal, decision: gate.decision, evidenceCount: newEvidence.length },
          })
          .catch(() => undefined);
      }
      res.json({ evidence: newEvidence, gate });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/v1/goal-studio/runs/:runId/targets/:targetId/external-evidence
  app.post(`${BASE}/runs/:runId/targets/:targetId/external-evidence`, ctx.auth.requireOperator, async (req: Request, res: Response) => {
    const verification = ctx.services.verification as GoalVerificationService | undefined;
    if (!verification) {
      sendNotConfigured(res, 'verification');
      return;
    }
    if (typeof verification.recordSignoff !== 'function') {
      sendNotConfigured(res, 'verification.recordSignoff');
      return;
    }
    try {
      const principal = ctx.auth.principalFor(req);
      if (!principal) {
        throw new GoalStudioFailure('UNAUTHORIZED', 'operator authentication required');
      }
      const runId = String(req.params.runId);
      const targetId = String(req.params.targetId);
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const method = body.method === 'human-signoff' || body.method === 'external-record' ? body.method : 'external-record';
      const verdict = body.verdict === 'PASS' || body.verdict === 'FAIL' ? body.verdict : ('PASS' as SignoffInput['verdict']);
      const signoffInput: SignoffInput = {
        runId,
        targetId,
        attemptId: typeof body.attemptId === 'string' && body.attemptId.trim() ? body.attemptId.trim() : undefined,
        principal: principal.id,
        method,
        verdict,
        criteria: Array.isArray(body.criteria) ? (body.criteria as string[]) : undefined,
        note: typeof body.note === 'string' ? body.note : undefined,
        source: typeof body.source === 'string' ? body.source : undefined,
        workspaceRevision: typeof body.workspaceRevision === 'string' ? body.workspaceRevision : undefined,
      };
      const records = await verification.recordSignoff(signoffInput);
      if (ctx.services.governance) {
        await ctx.services.governance
          .audit({
            seq: 0,
            type: 'verification.evidence',
            runId,
            targetId,
            attemptId: records[0]?.attemptId,
            timestamp: records[0]?.createdAt ?? new Date().toISOString(),
            data: {
              action: 'external-evidence',
              principal: `user:${principal.id}`,
              method,
              verdict,
              evidenceIds: records.map((r) => r.id),
            },
          })
          .catch(() => undefined);
      }
      res.status(201).json({ evidence: records });
    } catch (err) {
      sendError(res, err);
    }
  });
}
