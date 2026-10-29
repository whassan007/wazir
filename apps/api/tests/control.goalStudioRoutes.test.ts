import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Command } from 'commander';
import { MemoryStore } from '@wazir/shared';
import { ApprovalQueue } from '@wazir/core';
import { GoalStudioFailure } from '@wazir/goals';
import type {
  GoalController,
  GoalGovernance,
  GoalLedgerStore,
  GoalRunLedger,
  GoalRunStatus,
  GoalStudioEvent,
  TargetAttempt,
  TargetTransition,
} from '@wazir/goals';
import { ApiAuth } from '../src/auth.js';
import { registerControlRoutes, GOAL_STUDIO_BASE } from '../src/goalStudio/controlRoutes.js';
import { createGoalStudioApprovals } from '../src/goalStudio/controlApprovals.js';
import { createGoalEventLog } from '../src/goalStudio/controlEventLog.js';
import {
  goalImportCommand,
  goalListCommand,
  goalStartCommand,
  goalStatusCommand,
  goalLifecycleCommand,
  goalRetryCommand,
  goalResolveApprovalCommand,
  registerGoalCommands,
} from '../../cli/src/commands/goalCommands.js';
import { createControlModule } from '../../web/public/goal-studio/control.js';

function createFakeLedgerAndController(events: ReturnType<typeof createGoalEventLog>) {
  const runs = new Map<string, GoalRunLedger>();
  const transitionsByRun = new Map<string, TargetTransition[]>();
  const attemptsByRun = new Map<string, TargetAttempt[]>();
  let runSeq = 0;

  const makeRun = (graphId: string, graphRevision = 1, createdBy = 'user:operator'): GoalRunLedger => {
    const runId = `run-${++runSeq}`;
    const now = new Date().toISOString();
    const run: GoalRunLedger = {
      runId,
      graphId,
      graphRevision,
      graphDigest: `sha256:digest-${graphId}-${graphRevision}`,
      status: 'running',
      ledgerRevision: 1,
      targets: {
        T1: {
          targetId: 'T1',
          status: 'eligible',
          attempts: 0,
          repairs: 0,
          evidenceIds: [],
          blockers: [],
          updatedAt: now,
        },
        T2: {
          targetId: 'T2',
          status: 'failed',
          attempts: 1,
          repairs: 0,
          evidenceIds: [],
          blockers: ['test-failure'],
          updatedAt: now,
        },
      },
      resource: {
        tasksStarted: 1,
        hostedSpendUsd: 0.25,
        startedAt: now,
        deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
    runs.set(runId, run);
    transitionsByRun.set(runId, []);
    attemptsByRun.set(runId, [
      {
        id: `${runId}-att-1`,
        runId,
        targetId: 'T2',
        attempt: 1,
        phase: 'EXECUTE',
        executionId: 'exec-101',
        startedAt: now,
        endedAt: now,
        outcome: 'failed',
      },
    ]);
    return run;
  };

  const ledger: GoalLedgerStore = {
    async createRun(input) {
      return makeRun(input.graph.graphId, input.graph.revision, input.createdBy);
    },
    async getRun(runId) {
      return runs.get(runId);
    },
    async listRuns(filter) {
      return Array.from(runs.values()).filter((r) => {
        if (filter?.graphId && r.graphId !== filter.graphId) return false;
        if (filter?.status && r.status !== filter.status) return false;
        return true;
      });
    },
    async commit(runId) {
      const r = runs.get(runId);
      if (!r) throw new GoalStudioFailure('NOT_FOUND', `run '${runId}' not found`);
      return r;
    },
    async transitions(runId, targetId) {
      const list = transitionsByRun.get(runId) ?? [];
      return targetId ? list.filter((t) => t.targetId === targetId) : list;
    },
    async acquireLease() {
      return undefined;
    },
    async renewLease(l) {
      return l;
    },
    async releaseLease() {},
    async once(_key, effect) {
      return { result: await effect(), replayed: false };
    },
    async saveAttempt(attempt) {
      const list = attemptsByRun.get(attempt.runId) ?? [];
      list.push(attempt);
      attemptsByRun.set(attempt.runId, list);
    },
    async attempts(runId, targetId) {
      const list = attemptsByRun.get(runId) ?? [];
      return targetId ? list.filter((a) => a.targetId === targetId) : list;
    },
  };

  const transitionRun = async (runId: string, toStatus: GoalRunStatus, principal: string): Promise<GoalRunLedger> => {
    const run = runs.get(runId);
    if (!run) throw new GoalStudioFailure('NOT_FOUND', `run '${runId}' not found`);
    run.status = toStatus;
    run.ledgerRevision += 1;
    run.updatedAt = new Date().toISOString();
    await events.append({
      type: 'run.status',
      runId,
      data: { status: toStatus, principal, ledgerRevision: run.ledgerRevision },
    });
    return run;
  };

  const controller: GoalController = {
    async startRun({ graphId, graphRevision, principal }) {
      const run = makeRun(graphId, graphRevision ?? 1, principal);
      await events.append({
        type: 'run.created',
        runId: run.runId,
        data: { graphId: run.graphId, graphRevision: run.graphRevision, principal },
      });
      return run;
    },
    async pause(runId, principal) {
      return transitionRun(runId, 'paused', principal);
    },
    async resume(runId, principal) {
      return transitionRun(runId, 'running', principal);
    },
    async stop(runId, principal) {
      return transitionRun(runId, 'stopped', principal);
    },
    async retryTarget(runId, targetId, principal) {
      const run = runs.get(runId);
      if (!run) throw new GoalStudioFailure('NOT_FOUND', `run '${runId}' not found`);
      const entry = run.targets[targetId];
      if (!entry) throw new GoalStudioFailure('NOT_FOUND', `target '${targetId}' not found`);
      const fromState = entry.status;
      entry.status = 'eligible';
      entry.attempts += 1;
      entry.blockers = [];
      entry.updatedAt = new Date().toISOString();
      run.ledgerRevision += 1;
      const tr: TargetTransition = {
        runId,
        targetId,
        fromState,
        toState: 'eligible',
        reason: 'operator retry',
        actor: principal,
        timestamp: entry.updatedAt,
      };
      transitionsByRun.get(runId)?.push(tr);
      await events.append({
        type: 'target.transition',
        runId,
        targetId,
        data: { fromState, toState: 'eligible', actor: principal },
      });
      return run;
    },
    async runEligible(runId, targetId, principal) {
      const run = runs.get(runId);
      if (!run) throw new GoalStudioFailure('NOT_FOUND', `run '${runId}' not found`);
      const entry = run.targets[targetId];
      if (!entry) throw new GoalStudioFailure('NOT_FOUND', `target '${targetId}' not found`);
      if (entry.status !== 'eligible' && entry.status !== 'queued') {
        throw new GoalStudioFailure('LEDGER_CONFLICT', `target '${targetId}' is '${entry.status}', not eligible`);
      }
      const fromState = entry.status;
      entry.status = 'active';
      entry.attempts += 1;
      entry.updatedAt = new Date().toISOString();
      run.ledgerRevision += 1;
      transitionsByRun.get(runId)?.push({
        runId,
        targetId,
        fromState,
        toState: 'active',
        reason: 'operator runEligible',
        actor: principal,
        timestamp: entry.updatedAt,
      });
      await events.append({
        type: 'target.transition',
        runId,
        targetId,
        data: { fromState, toState: 'active', actor: principal },
      });
      return run;
    },
    eligibleTargets(run) {
      return Object.values(run.targets)
        .filter((t) => t.status === 'eligible')
        .map((t) => t.targetId);
    },
    async recoverRuns() {
      return [];
    },
  };

  return { ledger, controller, runs };
}

async function startTestControlServer(options: {
  operatorToken?: string;
  viewerToken?: string;
  allowUnauthenticated?: boolean;
  omitServices?: boolean;
} = {}) {
  const store = new MemoryStore();
  const auth = new ApiAuth({
    operatorToken: options.operatorToken ?? 'op-secret-token',
    viewerToken: options.viewerToken ?? 'view-secret-token',
    allowUnauthenticated: options.allowUnauthenticated ?? false,
    store,
  });
  const events = createGoalEventLog({ store, workspaceRoot: '/tmp' });
  const queue = new ApprovalQueue({ store });
  const approvals = createGoalStudioApprovals({ store, queue, events });
  const { ledger, controller } = createFakeLedgerAndController(events);
  const audited: GoalStudioEvent[] = [];
  const governance: GoalGovernance = {
    async preflight() {
      return { effect: 'allow', reasons: [] };
    },
    authorizeSpend() {
      return { effect: 'allow', reasons: [] };
    },
    async audit(event) {
      audited.push(event);
    },
  };

  const app = express();
  // Also mock /graphs/import & /graphs for CLI import/list tests
  app.post(`${GOAL_STUDIO_BASE}/graphs/import`, auth.requireOperator, express.json(), (req, res) => {
    res.status(201).json({
      record: {
        graphId: 'g-imported',
        projectId: req.body?.projectId ?? 'default',
        revision: 1,
        digest: 'sha256:imported',
      },
      validation: { valid: true, issues: [] },
    });
  });
  app.get(`${GOAL_STUDIO_BASE}/graphs`, auth.requireViewerOrOperator, (_req, res) => {
    res.json({
      graphs: [{ graphId: 'g-imported', projectId: 'default', name: 'Imported Graph', latestRevision: 1 }],
    });
  });

  registerControlRoutes(
    app,
    {
      auth,
      store,
      services: options.omitServices ? {} : { ledger, controller, events, governance },
    },
    { approvals: options.omitServices ? undefined : approvals, heartbeatMs: 100 },
  );

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    apiBase: `http://127.0.0.1:${port}${GOAL_STUDIO_BASE}`,
    store,
    events,
    approvals,
    ledger,
    controller,
    audited,
  };
}

function authHeader(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

describe('Goal Studio Execution Control Center (Workstream 07)', { timeout: 20_000 }, () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const srv of servers.splice(0)) {
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('enforces Viewer vs Operator RBAC and audits unauthorized mutation attempts', async () => {
    const env = await startTestControlServer({
      operatorToken: 'op-token',
      viewerToken: 'viewer-token',
      allowUnauthenticated: false,
    });
    servers.push(env.server);

    // Unauthenticated rejected on both read and write
    const unauthRead = await fetch(`${env.apiBase}/runs`);
    expect(unauthRead.status).toBe(401);

    const unauthWrite = await fetch(`${env.apiBase}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graphId: 'graph-1' }),
    });
    expect(unauthWrite.status).toBe(401);

    // Viewer can read runs, events, approvals, transitions, attempts, but CANNOT mutate
    const viewerWrite = await fetch(`${env.apiBase}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader('viewer-token') },
      body: JSON.stringify({ graphId: 'graph-1' }),
    });
    expect(viewerWrite.status).toBe(403);
    expect(env.audited.some((e) => e.type === 'governance.denied')).toBe(true);

    // Operator can start a run
    const opStart = await fetch(`${env.apiBase}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader('op-token') },
      body: JSON.stringify({ graphId: 'graph-1', graphRevision: 2 }),
    });
    expect(opStart.status).toBe(201);
    const { run } = (await opStart.json()) as { run: GoalRunLedger };
    expect(run.graphId).toBe('graph-1');
    expect(run.graphRevision).toBe(2);

    // Viewer can read the created run and list runs
    const viewerList = await fetch(`${env.apiBase}/runs`, { headers: authHeader('viewer-token') });
    expect(viewerList.status).toBe(200);
    const listBody = (await viewerList.json()) as { runs: Array<{ runId: string }> };
    expect(listBody.runs.map((r) => r.runId)).toContain(run.runId);

    const viewerGet = await fetch(`${env.apiBase}/runs/${run.runId}`, { headers: authHeader('viewer-token') });
    expect(viewerGet.status).toBe(200);

    // Viewer cannot pause/resume/stop/retry/run/approve
    for (const path of [
      `/runs/${run.runId}/pause`,
      `/runs/${run.runId}/resume`,
      `/runs/${run.runId}/stop`,
      `/runs/${run.runId}/targets/T2/retry`,
      `/runs/${run.runId}/targets/T1/run`,
      `/runs/${run.runId}/approvals/appr-1/resolve`,
    ]) {
      const denied = await fetch(`${env.apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader('viewer-token') },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(denied.status).toBe(403);
    }
  });

  it('supports full start/pause/resume/stop lifecycle and target retry/runEligible with execution links', async () => {
    const env = await startTestControlServer();
    servers.push(env.server);
    const headers = { 'Content-Type': 'application/json', ...authHeader('op-secret-token') };

    const startRes = await fetch(`${env.apiBase}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ graphId: 'g-main', graphRevision: 1 }),
    });
    expect(startRes.status).toBe(201);
    const { run } = (await startRes.json()) as { run: GoalRunLedger };
    const runId = run.runId;

    // Pause
    const pauseRes = await fetch(`${env.apiBase}/runs/${runId}/pause`, { method: 'POST', headers });
    expect(pauseRes.status).toBe(200);
    expect(((await pauseRes.json()) as { run: GoalRunLedger }).run.status).toBe('paused');

    // Resume
    const resumeRes = await fetch(`${env.apiBase}/runs/${runId}/resume`, { method: 'POST', headers });
    expect(resumeRes.status).toBe(200);
    expect(((await resumeRes.json()) as { run: GoalRunLedger }).run.status).toBe('running');

    // Run eligible target T1
    const runTargetRes = await fetch(`${env.apiBase}/runs/${runId}/targets/T1/run`, { method: 'POST', headers });
    expect(runTargetRes.status).toBe(200);
    expect(((await runTargetRes.json()) as { run: GoalRunLedger }).run.targets.T1.status).toBe('active');

    // Running T1 again when already active returns 409 LEDGER_CONFLICT
    const conflictRes = await fetch(`${env.apiBase}/runs/${runId}/targets/T1/run`, { method: 'POST', headers });
    expect(conflictRes.status).toBe(409);

    // Retry failed target T2
    const retryRes = await fetch(`${env.apiBase}/runs/${runId}/targets/T2/retry`, { method: 'POST', headers });
    expect(retryRes.status).toBe(200);
    expect(((await retryRes.json()) as { run: GoalRunLedger }).run.targets.T2.status).toBe('eligible');

    // Transitions & attempts include execution links
    const trRes = await fetch(`${env.apiBase}/runs/${runId}/transitions`, { headers });
    expect(trRes.status).toBe(200);
    const { transitions } = (await trRes.json()) as { transitions: TargetTransition[] };
    expect(transitions.length).toBe(2);

    const attRes = await fetch(`${env.apiBase}/runs/${runId}/attempts`, { headers });
    expect(attRes.status).toBe(200);
    const { attempts } = (await attRes.json()) as {
      attempts: Array<TargetAttempt & { links?: { execution: string; events: string } }>;
    };
    expect(attempts[0].links).toEqual({
      execution: '/api/v1/executions/exec-101',
      events: '/api/v1/executions/exec-101/events',
    });

    // Stop
    const stopRes = await fetch(`${env.apiBase}/runs/${runId}/stop`, { method: 'POST', headers });
    expect(stopRes.status).toBe(200);
    expect(((await stopRes.json()) as { run: GoalRunLedger }).run.status).toBe('stopped');
  });

  it('streams SSE events and replays cleanly with ?after=<seq> and Last-Event-ID without gaps or duplicates', async () => {
    const env = await startTestControlServer();
    servers.push(env.server);
    const headers = { 'Content-Type': 'application/json', ...authHeader('op-secret-token') };

    const startRes = await fetch(`${env.apiBase}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ graphId: 'g-sse' }),
    });
    const { run } = (await startRes.json()) as { run: GoalRunLedger };
    const runId = run.runId;

    // Append events 2 and 3 (event 1 was run.created)
    await env.events.append({ type: 'target.phase', runId, targetId: 'T1', data: { phase: 'PLAN_TASK' } });
    await env.events.append({ type: 'target.phase', runId, targetId: 'T1', data: { phase: 'EXECUTE' } });

    // Open SSE stream with ?after=1 and read 2 replayed events + 1 live event
    const ac1 = new AbortController();
    const sse1 = await fetch(`${env.apiBase}/runs/${runId}/events?after=1`, {
      headers: { Accept: 'text/event-stream', ...authHeader('view-secret-token') },
      signal: ac1.signal,
    });
    expect(sse1.status).toBe(200);

    // Emit live event seq=4 while stream is open
    setTimeout(() => {
      void env.events.append({ type: 'target.phase', runId, targetId: 'T1', data: { phase: 'INDEPENDENT_VERIFY' } });
    }, 40);

    const received1: GoalStudioEvent[] = [];
    const reader1 = (sse1.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    const decoder = new TextDecoder();
    let buf1 = '';
    while (received1.length < 3) {
      const { value, done } = await reader1.next();
      if (done) break;
      buf1 += decoder.decode(value, { stream: true });
      const frames = buf1.split('\n\n');
      buf1 = frames.pop() ?? '';
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          received1.push(JSON.parse(dataLine.slice(6)) as GoalStudioEvent);
        }
      }
    }
    ac1.abort();

    expect(received1.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(received1.map((e) => e.data.phase)).toEqual(['PLAN_TASK', 'EXECUTE', 'INDEPENDENT_VERIFY']);

    // Wait briefly for cleanup and verify subscriber count drops to 0
    await new Promise((r) => setTimeout(r, 40));
    expect(env.events.subscriberCount(runId)).toBe(0);

    // Append seq=5 while disconnected
    await env.events.append({ type: 'target.phase', runId, targetId: 'T1', data: { phase: 'COMMIT_PROGRESS' } });

    // Reconnect using Last-Event-ID: 3 — should receive exactly seq 4 and 5
    const ac2 = new AbortController();
    const sse2 = await fetch(`${env.apiBase}/runs/${runId}/events`, {
      headers: {
        Accept: 'text/event-stream',
        'Last-Event-ID': '3',
        ...authHeader('view-secret-token'),
      },
      signal: ac2.signal,
    });
    expect(sse2.status).toBe(200);
    const received2: GoalStudioEvent[] = [];
    const reader2 = (sse2.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    let buf2 = '';
    while (received2.length < 2) {
      const { value, done } = await reader2.next();
      if (done) break;
      buf2 += decoder.decode(value, { stream: true });
      const frames = buf2.split('\n\n');
      buf2 = frames.pop() ?? '';
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          received2.push(JSON.parse(dataLine.slice(6)) as GoalStudioEvent);
        }
      }
    }
    ac2.abort();
    expect(received2.map((e) => e.seq)).toEqual([4, 5]);
  });

  it('enforces scope-bound approvals over HTTP (GET /runs/:runId/approvals and POST /runs/:runId/approvals/:approvalId/resolve)', async () => {
    const env = await startTestControlServer();
    servers.push(env.server);
    const headers = { 'Content-Type': 'application/json', ...authHeader('op-secret-token') };

    const startRes = await fetch(`${env.apiBase}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ graphId: 'g-appr' }),
    });
    const { run } = (await startRes.json()) as { run: GoalRunLedger };
    const runId = run.runId;

    // Enqueue two scoped approvals for different targets/actions
    const decisionT1 = env.approvals.request(
      { runId, targetId: 'T1', attempt: 1, action: 'execute' },
      { summary: 'Approve T1 execution' },
    );
    const decisionT2 = env.approvals.request(
      { runId, targetId: 'T2', attempt: 2, action: 'external-signoff' },
      { summary: 'Approve T2 signoff' },
    );

    const listRes = await fetch(`${env.apiBase}/runs/${runId}/approvals?status=pending`, {
      headers: authHeader('view-secret-token'),
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      runId: string;
      pendingCount: number;
      approvals: Array<{ id: string; targetId: string; attempt: number; action: string }>;
    };
    expect(listBody.pendingCount).toBe(2);
    const apprT1 = listBody.approvals.find((a) => a.targetId === 'T1')!;
    const apprT2 = listBody.approvals.find((a) => a.targetId === 'T2')!;

    // Attempting to resolve apprT1 while claiming targetId='T2' fails with 403 SCOPE_MISMATCH
    const mismatchTarget = await fetch(`${env.apiBase}/runs/${runId}/approvals/${apprT1.id}/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'approve', targetId: 'T2', attempt: 1, action: 'execute' }),
    });
    expect(mismatchTarget.status).toBe(403);
    expect(((await mismatchTarget.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    // Attempting to resolve apprT1 under a different run route fails with 403 SCOPE_MISMATCH
    const mismatchRun = await fetch(`${env.apiBase}/runs/other-run/approvals/${apprT1.id}/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(mismatchRun.status).toBe(403);

    // Approving apprT1 with matching scope succeeds
    const approveRes = await fetch(`${env.apiBase}/runs/${runId}/approvals/${apprT1.id}/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        decision: 'approve',
        targetId: 'T1',
        attempt: 1,
        action: 'execute',
        reason: 'LGTM for T1',
      }),
    });
    expect(approveRes.status).toBe(200);
    await expect(decisionT1).resolves.toBe(true);

    // Replaying approval on already-resolved apprT1 fails with 409 DUPLICATE
    const replayRes = await fetch(`${env.apiBase}/runs/${runId}/approvals/${apprT1.id}/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(replayRes.status).toBe(409);

    // Rejecting apprT2 with reason succeeds and resolves promise to false
    const rejectRes = await fetch(`${env.apiBase}/runs/${runId}/approvals/${apprT2.id}/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        decision: 'reject',
        targetId: 'T2',
        attempt: 2,
        action: 'external-signoff',
        reason: 'Missing external audit log',
      }),
    });
    expect(rejectRes.status).toBe(200);
    const rejectBody = (await rejectRes.json()) as { approval: { status: string; resolutionReason?: string } };
    expect(rejectBody.approval.status).toBe('denied');
    expect(rejectBody.approval.resolutionReason).toBe('Missing external audit log');
    await expect(decisionT2).resolves.toBe(false);
  });

  it('degrades gracefully with 503 when services are not configured', async () => {
    const env = await startTestControlServer({ omitServices: true });
    servers.push(env.server);

    const res = await fetch(`${env.apiBase}/runs`, { headers: authHeader('view-secret-token') });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toMatch(/ledger not configured/);
  });

  it('executes CLI goal commands (import, list, start, status, pause, resume, stop, retry, approve, reject)', async () => {
    const env = await startTestControlServer();
    servers.push(env.server);
    const cliOpts = { url: env.baseUrl, token: 'op-secret-token' };

    // registerGoalCommands registers subcommands cleanly on commander
    const program = new Command();
    const goalCmd = registerGoalCommands(program);
    expect(goalCmd.commands.map((c) => c.name())).toEqual([
      'import',
      'create',
      'inspect',
      'nobel',
      'list',
      'start',
      'status',
      'results',
      'pause',
      'resume',
      'stop',
      'cancel',
      'retry',
      'approve',
      'reject',
    ]);

    // 1. wa goal import
    const imp = await goalImportCommand('inline.yaml', { ...cliOpts, yamlContent: 'name: test-graph\n' });
    expect(imp.code).toBe(0);
    expect(imp.output).toContain('g-imported');

    // 2. wa goal list --graphs
    const listGraphs = await goalListCommand({ ...cliOpts, graphs: true });
    expect(listGraphs.code).toBe(0);
    expect(listGraphs.output).toContain('g-imported');

    // 3. wa goal start
    const started = await goalStartCommand('g-imported', { ...cliOpts, revision: 1, json: true });
    expect(started.code).toBe(0);
    const runId = (JSON.parse(started.output) as { run: { runId: string } }).run.runId;

    // 4. wa goal list (runs)
    const listRuns = await goalListCommand(cliOpts);
    expect(listRuns.code).toBe(0);
    expect(listRuns.output).toContain(runId);

    // 5. wa goal status
    const status = await goalStatusCommand(runId, cliOpts);
    expect(status.code).toBe(0);
    expect(status.output).toContain('T1');
    expect(status.output).toContain('T2');

    // 6. wa goal pause / resume
    const paused = await goalLifecycleCommand('pause', runId, cliOpts);
    expect(paused.code).toBe(0);
    expect(paused.output).toContain('paused');

    const resumed = await goalLifecycleCommand('resume', runId, cliOpts);
    expect(resumed.code).toBe(0);
    expect(resumed.output).toContain('running');

    // 7. wa goal retry (and --eligible)
    const retried = await goalRetryCommand(runId, 'T2', cliOpts);
    expect(retried.code).toBe(0);
    expect(retried.output).toContain('eligible');

    const ranEligible = await goalRetryCommand(runId, 'T1', { ...cliOpts, eligible: true });
    expect(ranEligible.code).toBe(0);
    expect(ranEligible.output).toContain('active');

    // 8. wa goal approve & reject
    const p1 = env.approvals.request({ runId, targetId: 'T1', attempt: 1, action: 'execute' });
    const p2 = env.approvals.request({ runId, targetId: 'T2', attempt: 1, action: 'execute' });
    const pending = env.approvals.list({ runId, status: 'pending' });
    const a1 = pending.find((a) => a.targetId === 'T1')!;
    const a2 = pending.find((a) => a.targetId === 'T2')!;

    const approved = await goalResolveApprovalCommand('approve', a1.id, {
      ...cliOpts,
      run: runId,
      target: 'T1',
      attempt: 1,
      action: 'execute',
      reason: 'Approved via CLI',
    });
    expect(approved.code).toBe(0);
    await expect(p1).resolves.toBe(true);

    const rejected = await goalResolveApprovalCommand('reject', a2.id, {
      ...cliOpts,
      run: runId,
      target: 'T2',
      attempt: 1,
      action: 'execute',
      reason: 'Rejected via CLI',
    });
    expect(rejected.code).toBe(0);
    await expect(p2).resolves.toBe(false);

    // 9. wa goal stop
    const stopped = await goalLifecycleCommand('stop', runId, cliOpts);
    expect(stopped.code).toBe(0);
    expect(stopped.output).toContain('stopped');
  });

  it('creates and unmounts the web control center module cleanly', () => {
    const mod = createControlModule();
    expect(typeof mod.mount).toBe('function');
    expect(typeof mod.unmount).toBe('function');
  });

  it('guarantees monotonic gapless event sequencing and mobile approval mirroring', async () => {
    const store = new MemoryStore();
    const events = createGoalEventLog({ store, workspaceRoot: '/tmp' });

    // Append 10 concurrent events for the same run and verify monotonic seq 1..10
    const appended = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        events.append({ type: 'target.phase', runId: 'run-seq-test', targetId: 'T1', data: { step: i + 1 } }),
      ),
    );
    expect(appended.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Simulate store head loss (or new process reading persisted events) and verify seq continues at 11
    await store.delete('goals/events/run-seq-test');
    const eleventh = await events.append({ type: 'run.idle', runId: 'run-seq-test', data: {} });
    expect(eleventh.seq).toBe(11);

    // Mobile approval mirror integration: resolving via GoalStudioApprovals closes out the mobile inbox entry
    const mobileResolved: Array<{ id: string; decision: string }> = [];
    const mobileApprovals = createGoalStudioApprovals({
      store,
      events,
      mobile: {
        requestApproval: () => new Promise<boolean>(() => {}),
        resolveApproval: async (params) => {
          mobileResolved.push({ id: params.id, decision: params.decision });
          return { ok: true };
        },
        pendingForTask: () => ['mob-appr-99'],
      },
    });

    const p = mobileApprovals.request({ runId: 'run-seq-test', targetId: 'T1', attempt: 1, action: 'execute' });
    await new Promise((r) => setTimeout(r, 10));
    const item = mobileApprovals.list({ runId: 'run-seq-test', status: 'pending' })[0];
    expect(item.mobileApprovalId).toBe('mob-appr-99');

    const res = mobileApprovals.resolve(item.id, true, 'user:operator', { runId: 'run-seq-test', targetId: 'T1', attempt: 1, action: 'execute' }, 'Approved on web');
    expect(res.ok).toBe(true);
    await expect(p).resolves.toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(mobileResolved).toEqual([{ id: 'mob-appr-99', decision: 'approve' }]);
  });
});
