import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import {
  createGoalGovernance,
  GOAL_STORE_KEYS,
  type GoalRunLedger,
  type GoalTarget,
} from '@wazir/goals';
import { ApiAuth } from '../src/auth.js';
import { registerGovernanceRoutes } from '../src/goalStudio/governanceRoutes.js';

const OPERATOR_TOKEN = 'op-secret-token-123456';
const VIEWER_TOKEN = 'view-secret-token-123456';

function sampleRun(): GoalRunLedger {
  return {
    runId: 'run-http-1',
    graphId: 'graph-1',
    graphRevision: 1,
    graphDigest: 'sha256:abc',
    status: 'running',
    ledgerRevision: 1,
    targets: {
      'Y1.1': {
        targetId: 'Y1.1',
        status: 'eligible',
        attempts: 0,
        repairs: 0,
        evidenceIds: [],
        blockers: [],
        updatedAt: '2026-10-23T00:00:00.000Z',
      },
      'Y2.3': {
        targetId: 'Y2.3',
        status: 'eligible',
        attempts: 0,
        repairs: 0,
        evidenceIds: [],
        blockers: [],
        updatedAt: '2026-10-23T00:00:00.000Z',
      },
    },
    resource: {
      tasksStarted: 0,
      hostedSpendUsd: 0,
      startedAt: '2026-10-23T00:00:00.000Z',
      deadlineAt: '2026-10-23T01:30:00.000Z',
    },
    createdBy: 'operator:alice',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  };
}

function sampleTarget(overrides: Partial<GoalTarget> = {}): GoalTarget {
  return {
    id: 'Y1.1',
    stage: 'foundational_research',
    title: 'Define a bounded formal safety claim',
    dependsOn: [],
    priority: 100,
    executor: 'axiomatize',
    artifacts: ['scope.md'],
    acceptance: ['Explicit assumptions'],
    ...overrides,
  };
}

describe('Goal Studio Governance HTTP Routes (/api/v1/goal-studio/governance/*)', () => {
  let store: MemoryStore;
  let auth: ApiAuth;
  let server: ReturnType<express.Express['listen']> | undefined;
  let baseUrl: string;

  async function startApp(withGovernance = true): Promise<void> {
    const app = express();
    app.use(express.json());
    const governance = withGovernance
      ? createGoalGovernance({
          store,
          workspaceRoot: '/tmp/wazir-gov-routes',
          clock: () => new Date('2026-10-23T00:05:00.000Z'),
        })
      : undefined;

    registerGovernanceRoutes(app, {
      auth,
      store,
      services: governance ? { governance } : {},
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  beforeEach(async () => {
    store = new MemoryStore();
    auth = new ApiAuth({
      operatorToken: OPERATOR_TOKEN,
      viewerToken: VIEWER_TOKEN,
      allowUnauthenticated: false,
      store,
    });
    await auth.init();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('returns 503 when governance service is not configured yet', async () => {
    await startApp(false);
    const res = await fetch(`${baseUrl}/api/v1/goal-studio/governance/policy`, {
      headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toMatch(/governance not configured/);
  });

  it('rejects unauthenticated requests with 401 and viewer-role mutation attempts with 403', async () => {
    await startApp(true);

    // Unauthenticated GET -> 401
    const unauthGet = await fetch(`${baseUrl}/api/v1/goal-studio/governance/audit`);
    expect(unauthGet.status).toBe(401);

    // Unauthenticated POST preflight -> 401
    const unauthPost = await fetch(`${baseUrl}/api/v1/goal-studio/governance/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run: sampleRun(), target: sampleTarget() }),
    });
    expect(unauthPost.status).toBe(401);

    // Viewer token allowed on read-only GET /governance/audit and GET /governance/policy
    const viewerAudit = await fetch(`${baseUrl}/api/v1/goal-studio/governance/audit`, {
      headers: { Authorization: `Bearer ${VIEWER_TOKEN}` },
    });
    expect(viewerAudit.status).toBe(200);

    const viewerPolicy = await fetch(`${baseUrl}/api/v1/goal-studio/governance/policy`, {
      headers: { Authorization: `Bearer ${VIEWER_TOKEN}` },
    });
    expect(viewerPolicy.status).toBe(200);

    // Viewer token rejected with 403 on POST /governance/preflight and POST /governance/spend-check
    const viewerPreflight = await fetch(`${baseUrl}/api/v1/goal-studio/governance/preflight`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${VIEWER_TOKEN}`,
      },
      body: JSON.stringify({ run: sampleRun(), target: sampleTarget() }),
    });
    expect(viewerPreflight.status).toBe(403);

    const viewerSpend = await fetch(`${baseUrl}/api/v1/goal-studio/governance/spend-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${VIEWER_TOKEN}`,
      },
      body: JSON.stringify({ run: sampleRun(), amountUsd: 0 }),
    });
    expect(viewerSpend.status).toBe(403);
  });

  it('evaluates preflight, spend-check, policy, and audit routes with operator token', async () => {
    await startApp(true);
    const run = sampleRun();
    await store.put(GOAL_STORE_KEYS.run(run.runId), run);

    // 1. GET /governance/policy
    const policyRes = await fetch(`${baseUrl}/api/v1/goal-studio/governance/policy?runId=${run.runId}`, {
      headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(policyRes.status).toBe(200);
    const policyBody = (await policyRes.json()) as {
      modelPrincipalsForbidden: boolean;
      resourceLimits: { hostedSpendUsd: number };
      invariants: string[];
    };
    expect(policyBody.modelPrincipalsForbidden).toBe(true);
    expect(policyBody.resourceLimits.hostedSpendUsd).toBe(0);
    expect(policyBody.invariants).toContain('no_wet_lab_or_hazardous_protocols');

    // 2. POST /governance/spend-check ($0 allowed, $0.0001 denied)
    const spendZeroRes = await fetch(`${baseUrl}/api/v1/goal-studio/governance/spend-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPERATOR_TOKEN}`,
      },
      body: JSON.stringify({ runId: run.runId, amountUsd: 0 }),
    });
    expect(spendZeroRes.status).toBe(200);
    expect(((await spendZeroRes.json()) as any).decision.effect).toBe('allow');

    const spendPaidRes = await fetch(`${baseUrl}/api/v1/goal-studio/governance/spend-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPERATOR_TOKEN}`,
      },
      body: JSON.stringify({ runId: run.runId, amountUsd: 0.0001 }),
    });
    expect(spendPaidRes.status).toBe(200);
    const spendPaidBody = (await spendPaidRes.json()) as { decision: { effect: string; reasons: string[] } };
    expect(spendPaidBody.decision.effect).toBe('deny');
    expect(spendPaidBody.decision.reasons.join(' ')).toMatch(/BUDGET_DENIED/);

    // 3. POST /governance/spend-check with model principal -> 403 POLICY_DENIED
    const modelSpendRes = await fetch(`${baseUrl}/api/v1/goal-studio/governance/spend-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPERATOR_TOKEN}`,
      },
      body: JSON.stringify({
        runId: run.runId,
        amountUsd: 0,
        principal: 'model:gpt-4o',
      }),
    });
    expect(modelSpendRes.status).toBe(403);
    const modelSpendBody = (await modelSpendRes.json()) as {
      decision: { effect: string };
      error: { code: string };
    };
    expect(modelSpendBody.decision.effect).toBe('deny');
    expect(modelSpendBody.error.code).toBe('POLICY_DENIED');

    // 4. POST /governance/preflight for requiresApproval target -> effect: 'ask'
    const askPreflightRes = await fetch(`${baseUrl}/api/v1/goal-studio/governance/preflight`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPERATOR_TOKEN}`,
      },
      body: JSON.stringify({
        runId: run.runId,
        target: sampleTarget({ id: 'Y2.3', requiresApproval: true, executor: 'standards_strategy' }),
        principal: 'operator:alice',
      }),
    });
    expect(askPreflightRes.status).toBe(200);
    const askPreflightBody = (await askPreflightRes.json()) as {
      decision: { effect: string; approvalScope?: string };
    };
    expect(askPreflightBody.decision.effect).toBe('ask');
    expect(askPreflightBody.decision.approvalScope).toBe('run-http-1:Y2.3:1:execute:standards_strategy');

    // 5. GET /governance/audit returns persisted audit trail with valid hash chain
    const auditRes = await fetch(`${baseUrl}/api/v1/goal-studio/governance/audit?runId=${run.runId}`, {
      headers: { Authorization: `Bearer ${VIEWER_TOKEN}` },
    });
    expect(auditRes.status).toBe(200);
    const auditBody = (await auditRes.json()) as {
      audit: Array<{ seq: string; event: { type: string } }>;
      total: number;
      integrity: { valid: boolean; count: number };
    };
    expect(auditBody.total).toBeGreaterThanOrEqual(3);
    expect(auditBody.integrity.valid).toBe(true);
  });
});
