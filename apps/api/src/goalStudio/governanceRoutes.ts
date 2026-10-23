import type { Express, Request, Response } from 'express';
import {
  GOAL_STORE_KEYS,
  GOAL_STUDIO_HTTP_STATUS,
  GoalStudioFailure,
  isModelOrAgentPrincipal,
  sanitizeAuditValue,
  type GoalAuditQuery,
  type GoalAuditRecord,
  type GoalConstitution,
  type GoalGovernanceService,
  type GoalRunLedger,
  type GoalStudioErrorCode,
  type GoalTarget,
  type ModelRouteDecision,
} from '@wazir/goals';
import type { GoalStudioRouteContext } from './context.js';

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

function sendNotConfigured(res: Response): void {
  res.status(503).json({
    error: {
      code: 'INTERNAL',
      message: 'governance not configured',
    },
  });
}

async function queryAuditFromStore(
  ctx: GoalStudioRouteContext,
  query: GoalAuditQuery,
): Promise<GoalAuditRecord[]> {
  const gov = ctx.services.governance as GoalGovernanceService | undefined;
  if (gov && typeof gov.queryAudit === 'function') {
    return gov.queryAudit(query);
  }
  const entries = await ctx.store.list('goals/audit/');
  const records = entries
    .map((e) => e.value as GoalAuditRecord | undefined)
    .filter((rec): rec is GoalAuditRecord => Boolean(rec && rec.event))
    .sort((a, b) => (a.seqNumber ?? 0) - (b.seqNumber ?? 0));

  const filtered = records.filter((rec) => {
    if (query.afterSeq !== undefined && (rec.seqNumber ?? 0) <= query.afterSeq) return false;
    if (query.runId && rec.event.runId !== query.runId) return false;
    if (query.targetId && rec.event.targetId !== query.targetId) return false;
    if (query.type && rec.event.type !== query.type) return false;
    if (query.effect && rec.event.data?.effect !== query.effect) return false;
    if (query.principal && rec.event.data?.principal !== query.principal) return false;
    return true;
  });

  if (query.limit !== undefined && query.limit > 0 && filtered.length > query.limit) {
    return filtered.slice(filtered.length - query.limit);
  }
  return filtered.map((rec) => sanitizeAuditValue(rec));
}

async function resolveRunFromBodyOrStore(
  ctx: GoalStudioRouteContext,
  body: Record<string, unknown>,
): Promise<GoalRunLedger | undefined> {
  if (body.run && typeof body.run === 'object') {
    return body.run as GoalRunLedger;
  }
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!runId) return undefined;
  if (ctx.services.ledger) {
    const found = await ctx.services.ledger.getRun(runId);
    if (found) return found;
  }
  return ctx.store.get<GoalRunLedger>(GOAL_STORE_KEYS.run(runId));
}

function resolvePrincipal(req: Request, ctx: GoalStudioRouteContext, bodyPrincipal?: unknown): string {
  if (typeof bodyPrincipal === 'string' && bodyPrincipal.trim()) {
    return bodyPrincipal.trim();
  }
  const headerPrincipal = req.headers['x-wazir-principal'];
  if (typeof headerPrincipal === 'string' && headerPrincipal.trim()) {
    return headerPrincipal.trim();
  }
  const authPrincipal = ctx.auth.principalFor(req);
  if (authPrincipal) {
    return `${authPrincipal.kind}:${authPrincipal.id}`;
  }
  return 'operator:api';
}

// Owned by Goal Studio workstream 10. Mount routes under /api/v1/goal-studio/.
export function registerGovernanceRoutes(app: Express, ctx: GoalStudioRouteContext): void {
  const { auth } = ctx;

  // Read-only audit log inspection
  app.get('/api/v1/goal-studio/governance/audit', auth.requireViewerOrOperator, async (req, res) => {
    if (!ctx.services.governance) {
      sendNotConfigured(res);
      return;
    }
    try {
      const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
      const limit =
        rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(1000, Math.floor(rawLimit))
          : undefined;
      const rawAfter = req.query.afterSeq !== undefined ? Number(req.query.afterSeq) : undefined;
      const afterSeq =
        rawAfter !== undefined && Number.isFinite(rawAfter) && rawAfter >= 0
          ? Math.floor(rawAfter)
          : undefined;

      const query: GoalAuditQuery = {
        runId: typeof req.query.runId === 'string' && req.query.runId.trim() ? req.query.runId.trim() : undefined,
        targetId:
          typeof req.query.targetId === 'string' && req.query.targetId.trim()
            ? req.query.targetId.trim()
            : undefined,
        type: typeof req.query.type === 'string' && req.query.type.trim() ? req.query.type.trim() : undefined,
        effect:
          req.query.effect === 'allow' || req.query.effect === 'ask' || req.query.effect === 'deny'
            ? req.query.effect
            : undefined,
        principal:
          typeof req.query.principal === 'string' && req.query.principal.trim()
            ? req.query.principal.trim()
            : undefined,
        afterSeq,
        limit,
      };

      const records = await queryAuditFromStore(ctx, query);
      const gov = ctx.services.governance as GoalGovernanceService;
      const integrity =
        typeof gov.verifyAuditChain === 'function'
          ? await gov.verifyAuditChain()
          : { valid: true, count: records.length };

      res.json({
        audit: records,
        total: records.length,
        integrity,
      });
    } catch (error) {
      if (error instanceof GoalStudioFailure) {
        sendError(res, error.code, error.message, error.details);
        return;
      }
      sendError(res, 'INTERNAL', error instanceof Error ? error.message : String(error));
    }
  });

  // Read-only policy & constitution inspection
  app.get('/api/v1/goal-studio/governance/policy', auth.requireViewerOrOperator, async (req, res) => {
    if (!ctx.services.governance) {
      sendNotConfigured(res);
      return;
    }
    try {
      const gov = ctx.services.governance as GoalGovernanceService;
      const runId = typeof req.query.runId === 'string' && req.query.runId.trim() ? req.query.runId.trim() : undefined;
      let run: GoalRunLedger | undefined;
      if (runId) {
        run = ctx.services.ledger
          ? await ctx.services.ledger.getRun(runId)
          : await ctx.store.get<GoalRunLedger>(GOAL_STORE_KEYS.run(runId));
        if (!run) {
          sendError(res, 'NOT_FOUND', `run '${runId}' not found`);
          return;
        }
      }
      if (typeof gov.getPolicySummary === 'function') {
        const summary = await gov.getPolicySummary({ run });
        res.json(summary);
        return;
      }
      res.json({
        modelPrincipalsForbidden: true,
      });
    } catch (error) {
      if (error instanceof GoalStudioFailure) {
        sendError(res, error.code, error.message, error.details);
        return;
      }
      sendError(res, 'INTERNAL', error instanceof Error ? error.message : String(error));
    }
  });

  // Operator-gated preflight authorization check
  app.post('/api/v1/goal-studio/governance/preflight', auth.requireOperator, async (req, res) => {
    if (!ctx.services.governance) {
      sendNotConfigured(res);
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const run = await resolveRunFromBodyOrStore(ctx, body);
      if (!run || typeof run.runId !== 'string') {
        sendError(res, 'VALIDATION', 'preflight requires a valid `run` object or existing `runId`');
        return;
      }

      let target = body.target as GoalTarget | undefined;
      if (!target && typeof body.targetId === 'string') {
        const targetId = body.targetId.trim();
        if (ctx.services.graphs) {
          const rev = await ctx.services.graphs.getRevision(run.graphId, run.graphRevision);
          target = rev?.definition.targets.find((t) => t.id === targetId);
        }
        if (!target) {
          const storedRev = await ctx.store.get<{ definition?: { targets?: GoalTarget[] } }>(
            GOAL_STORE_KEYS.graphRevision(run.graphId, run.graphRevision),
          );
          target = storedRev?.definition?.targets?.find((t) => t.id === targetId);
        }
      }

      if (!target || typeof target.id !== 'string') {
        sendError(res, 'VALIDATION', 'preflight requires a valid `target` object or resolvable `targetId`');
        return;
      }

      const principal = resolvePrincipal(req, ctx, body.principal);
      const route =
        body.route && typeof body.route === 'object' ? (body.route as ModelRouteDecision) : undefined;
      const constitution =
        body.constitution && typeof body.constitution === 'object'
          ? (body.constitution as GoalConstitution)
          : undefined;
      const action = typeof body.action === 'string' ? body.action : undefined;
      const attempt = typeof body.attempt === 'number' ? body.attempt : undefined;
      const context =
        body.context && typeof body.context === 'object'
          ? (body.context as Record<string, unknown>)
          : undefined;

      const gov = ctx.services.governance as GoalGovernanceService;
      const decision = await gov.preflight({
        run,
        target,
        route,
        principal,
        constitution,
        action,
        attempt,
        context,
      });

      res.json({ decision });
    } catch (error) {
      if (error instanceof GoalStudioFailure) {
        sendError(res, error.code, error.message, error.details);
        return;
      }
      sendError(res, 'INTERNAL', error instanceof Error ? error.message : String(error));
    }
  });

  // Operator-gated hosted spend check
  app.post('/api/v1/goal-studio/governance/spend-check', auth.requireOperator, async (req, res) => {
    if (!ctx.services.governance) {
      sendNotConfigured(res);
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const principal = resolvePrincipal(req, ctx, body.principal);
      if (isModelOrAgentPrincipal(principal)) {
        const reasons = [
          `MODEL_PRINCIPAL_FORBIDDEN: principal '${principal}' is a model/agent/executor identity and cannot authorize spend`,
        ];
        await ctx.services.governance.audit({
          seq: 0,
          type: 'governance.denied',
          runId: typeof body.runId === 'string' ? body.runId : (body.run as GoalRunLedger | undefined)?.runId,
          timestamp: new Date().toISOString(),
          data: {
            effect: 'deny',
            principal,
            action: 'authorizeSpend',
            reasons,
          },
        });
        res.status(GOAL_STUDIO_HTTP_STATUS.POLICY_DENIED).json({
          decision: { effect: 'deny', reasons },
          error: {
            code: 'POLICY_DENIED',
            message: reasons[0],
          },
        });
        return;
      }

      const run = await resolveRunFromBodyOrStore(ctx, body);
      if (!run || typeof run.runId !== 'string') {
        sendError(res, 'VALIDATION', 'spend-check requires a valid `run` object or existing `runId`');
        return;
      }

      const amountUsd = Number(body.amountUsd);
      if (body.amountUsd === undefined || body.amountUsd === null || typeof body.amountUsd === 'boolean') {
        sendError(res, 'VALIDATION', 'spend-check requires a numeric `amountUsd`');
        return;
      }

      const constitution =
        body.constitution && typeof body.constitution === 'object'
          ? (body.constitution as GoalConstitution)
          : undefined;
      const gov = ctx.services.governance as GoalGovernanceService;
      const decision = gov.authorizeSpend(run, amountUsd, constitution);

      if (decision.effect === 'deny') {
        await ctx.services.governance.audit({
          seq: 0,
          type: 'governance.denied',
          runId: run.runId,
          timestamp: new Date().toISOString(),
          data: {
            effect: 'deny',
            principal,
            action: 'authorizeSpend',
            amountUsd,
            reasons: decision.reasons,
          },
        });
      }

      res.json({ decision });
    } catch (error) {
      if (error instanceof GoalStudioFailure) {
        sendError(res, error.code, error.message, error.details);
        return;
      }
      sendError(res, 'INTERNAL', error instanceof Error ? error.message : String(error));
    }
  });
}
