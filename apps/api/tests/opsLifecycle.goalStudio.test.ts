import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MemoryStore } from '@wazir/shared';
import { createInitialState, createApp } from '../src/server.js';

describe('Goal Studio Ops Lifecycle & API Wiring', () => {
  let server: Server | undefined;

  afterEach(() => {
    delete process.env.WAZIR_ENABLE_GOAL_STUDIO;
    if (server) {
      server.close();
      server = undefined;
    }
  });

  it('initializes state.goalStudio automatically in default createInitialState', async () => {
    const store = new MemoryStore();
    const state = await createInitialState({
      store,
      auth: { operatorToken: 'op-token', viewerToken: 'view-token' },
      goalStudioAutoStart: false,
      goalStudioAutoAdvance: false,
    });

    expect(state.goalStudio).toBeDefined();
    expect(state.goalStudio?.graphs).toBeDefined();
    expect(state.goalStudio?.controller).toBeDefined();
    expect(state.goalStudio?.ledger).toBeDefined();
    expect(state.goalStudio?.verification).toBeDefined();

    // Disabled explicitly via option
    const disabledState = await createInitialState({
      store: new MemoryStore(),
      enableGoalStudio: false,
    });
    expect(disabledState.goalStudio).toBeUndefined();

    // Disabled via environment variable WAZIR_ENABLE_GOAL_STUDIO = '0'
    process.env.WAZIR_ENABLE_GOAL_STUDIO = '0';
    const envDisabledState = await createInitialState({
      store: new MemoryStore(),
    });
    expect(envDisabledState.goalStudio).toBeUndefined();
  });

  it('handles POST /graphs/create, /seed-nobel, /runs/:runId/cancel, and GET /runs/:runId/results', async () => {
    const store = new MemoryStore();
    const state = await createInitialState({
      store,
      auth: { operatorToken: 'op-token', viewerToken: 'view-token' },
      goalStudioAutoStart: false,
      goalStudioAutoAdvance: false,
    });

    const app = createApp(state);
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/v1/goal-studio`;
    const opHeaders = {
      'content-type': 'application/json',
      authorization: 'Bearer op-token',
    };
    const viewHeaders = {
      authorization: 'Bearer view-token',
    };

    // 1. POST /graphs/create with default target
    const createRes = await fetch(`${base}/graphs/create`, {
      method: 'POST',
      headers: opHeaders,
      body: JSON.stringify({
        name: 'Autonomous Remediation',
        objective: 'Resolve all open operational remediations automatically.',
      }),
    });
    expect(createRes.status).toBe(201);
    const createdJson = await createRes.json();
    expect(createdJson.record).toBeDefined();
    expect(createdJson.validation.valid).toBe(true);
    const graphId = createdJson.record.graphId;
    expect(graphId).toBeDefined();
    expect(createdJson.record.definition.targets).toHaveLength(1);
    expect(createdJson.record.definition.targets[0].id).toBe('T1');
    expect(createdJson.record.definition.targets[0].artifacts).toEqual(['goal-output.md']);

    // POST /graphs/create with custom targets
    const customCreateRes = await fetch(`${base}/graphs/create`, {
      method: 'POST',
      headers: opHeaders,
      body: JSON.stringify({
        projectId: 'custom-proj',
        name: 'Custom Pipeline',
        objective: 'Execute custom multi-stage goal',
        targets: [
          {
            id: 'T-STAGE-1',
            title: 'Stage One',
            stage: 'planning',
            executor: 'fleet_harness',
            artifacts: ['plan.md'],
            acceptance: ['Plan artifact exists'],
            priority: 10,
          },
          {
            id: 'T-STAGE-2',
            title: 'Stage Two',
            stage: 'execution',
            dependsOn: ['T-STAGE-1'],
            executor: 'fleet_harness',
            artifacts: ['result.md'],
            acceptance: ['Result artifact exists'],
            priority: 20,
          },
        ],
      }),
    });
    expect(customCreateRes.status).toBe(201);
    const customJson = await customCreateRes.json();
    expect(customJson.record.definition.targets).toHaveLength(2);
    expect(customJson.record.definition.targets[1].dependsOn).toEqual(['T-STAGE-1']);

    // 2. POST /graphs/seed-nobel
    const seedRes = await fetch(`${base}/graphs/seed-nobel`, {
      method: 'POST',
      headers: opHeaders,
      body: JSON.stringify({ projectId: 'nobel-ops' }),
    });
    expect([200, 201]).toContain(seedRes.status);
    const seedJson = await seedRes.json();
    expect(seedJson.record).toBeDefined();
    expect(seedJson.created).toBe(true);
    expect(seedJson.record.graphId).toContain('nobel-ops--nobel-governance-continuous-goal-graph');

    // Repeat seed should return 200 with created: false
    const reseedRes = await fetch(`${base}/graphs/seed-nobel`, {
      method: 'POST',
      headers: opHeaders,
      body: JSON.stringify({ projectId: 'nobel-ops' }),
    });
    expect(reseedRes.status).toBe(200);
    const reseedJson = await reseedRes.json();
    expect(reseedJson.created).toBe(false);

    // 3. Start a run, then POST /runs/:runId/cancel
    const startRes = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: opHeaders,
      body: JSON.stringify({ graphId }),
    });
    expect(startRes.status).toBe(201);
    const startJson = await startRes.json();
    const runId = startJson.run.runId;
    expect(runId).toBeDefined();

    // Cancel the run
    const cancelRes = await fetch(`${base}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: opHeaders,
    });
    expect(cancelRes.status).toBe(200);
    const cancelJson = await cancelRes.json();
    expect(cancelJson.run).toBeDefined();
    expect(['stopped', 'stopping']).toContain(cancelJson.run.status);

    // 4. GET /runs/:runId/results
    const resultsRes = await fetch(`${base}/runs/${runId}/results`, {
      headers: viewHeaders,
    });
    expect(resultsRes.status).toBe(200);
    const resultsJson = await resultsRes.json();

    expect(resultsJson.run).toBeDefined();
    expect(resultsJson.run.runId).toBe(runId);
    expect(resultsJson.graph).toBeDefined();
    expect(resultsJson.graph.graphId).toBe(graphId);
    expect(Array.isArray(resultsJson.attempts)).toBe(true);
    expect(Array.isArray(resultsJson.transitions)).toBe(true);
    expect(Array.isArray(resultsJson.evidence)).toBe(true);
    expect(Array.isArray(resultsJson.artifacts)).toBe(true);
    // Artifacts must include targets' declared artifacts
    expect(resultsJson.artifacts).toContain('goal-output.md');
    // Targets summary per-target status
    expect(resultsJson.targets).toBeDefined();
    expect(resultsJson.targets['T1']).toBeDefined();
    expect(resultsJson.targets['T1'].artifacts).toEqual(['goal-output.md']);
  });

  it('enforces RBAC on new routes', async () => {
    const store = new MemoryStore();
    const state = await createInitialState({
      store,
      auth: { operatorToken: 'op-token', viewerToken: 'view-token' },
    });
    const app = createApp(state);
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/v1/goal-studio`;

    // Write endpoints require operator scope (viewer token is denied 403)
    const createDenied = await fetch(`${base}/graphs/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer view-token' },
      body: JSON.stringify({ name: 'Denied', objective: 'Denied' }),
    });
    expect(createDenied.status).toBe(403);

    const seedDenied = await fetch(`${base}/graphs/seed-nobel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer view-token' },
      body: JSON.stringify({}),
    });
    expect(seedDenied.status).toBe(403);

    const cancelDenied = await fetch(`${base}/runs/run-fake/cancel`, {
      method: 'POST',
      headers: { authorization: 'Bearer view-token' },
    });
    expect(cancelDenied.status).toBe(403);

    // Unauthenticated is 401
    const unauth = await fetch(`${base}/runs/run-fake/results`);
    expect(unauth.status).toBe(401);
  });
});
