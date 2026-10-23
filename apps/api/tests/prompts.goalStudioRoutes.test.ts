import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MemoryStore } from '@wazir/shared';
import { createPromptStore, type PromptRunner, type GoalStudioEvent } from '@wazir/goals';
import { ApiAuth } from '../src/auth.js';
import { registerPromptRoutes } from '../src/goalStudio/promptRoutes.js';
import { createApiState, createApp } from '../src/server.js';

const OP = 'op-token-123456789';
const VIEW = 'viewer-token-123456789';
const BASE = '/api/v1/goal-studio/prompts';

const DRAFT = {
  executorKey: 'select_target',
  role: 'portfolio_scheduler',
  template: 'From {{target_ledger}} pick a target.',
  inputSchema: { type: 'object', required: ['target_ledger'], properties: { target_ledger: { type: 'object' } } },
  outputSchema: { type: 'object', required: ['target_id'], properties: { target_id: { type: 'string' } } },
  requiredCapabilities: ['reasoning'],
};

const runner: PromptRunner = async ({ rendered }) => ({ output: rendered.includes('Y1') ? '{"target_id":"Y1"}' : '{"target_id":7}', modelId: 'fake' });

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function start(options: { runner?: PromptRunner; withPrompts?: boolean } = {}) {
  const store = new MemoryStore();
  const audited: GoalStudioEvent[] = [];
  const prompts = options.withPrompts === false ? undefined : createPromptStore({ store, workspaceRoot: '/tmp', runner: options.runner, runnerId: 'fake' });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const auth = new ApiAuth({ operatorToken: OP, viewerToken: VIEW, store });
  const governance = { audit: async (event: GoalStudioEvent) => { audited.push(event); } } as never;
  registerPromptRoutes(app, { auth, store, services: { prompts, governance } });
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token?: string, payload?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { call, audited, prompts };
}

describe('Goal Studio prompt routes', () => {
  it('returns 503 when the prompt service is not configured', async () => {
    const { call } = await start({ withPrompts: false });
    const res = await call('GET', BASE, VIEW);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'prompts not configured' } });
    expect((await call('POST', BASE, OP, DRAFT)).status).toBe(503);
  });

  it('is mounted by the real API server and degrades to 503 there until wired', async () => {
    const state = await createApiState({ auth: { allowUnauthenticated: true } });
    const server = createApp(state).listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${BASE}`);
    expect(res.status).toBe(503);
  });

  it('enforces viewer for reads and operator for mutations', async () => {
    const { call } = await start();
    expect((await call('GET', BASE)).status).toBe(401);
    expect((await call('GET', BASE, VIEW)).status).toBe(200);
    expect((await call('POST', BASE, VIEW, DRAFT)).status).toBe(403);
    expect((await call('POST', BASE, undefined, DRAFT)).status).toBe(401);
    expect((await call('POST', `${BASE}/select_target/rollback`, VIEW, { toVersion: 1 })).status).toBe(403);
    expect((await call('POST', `${BASE}/select_target/evaluate`, VIEW, { cases: [] })).status).toBe(403);
  });

  it('publishes, lists, reads versions, diffs and rolls back without rewriting history', async () => {
    const { call, audited } = await start();
    const created = await call('POST', BASE, OP, DRAFT);
    expect(created.status).toBe(201);
    expect(created.body.prompt).toMatchObject({ id: 'select_target', version: 1, createdBy: 'user:operator' });
    expect((await call('POST', BASE, OP, DRAFT)).status).toBe(200); // identical → no-op
    const v2 = await call('POST', `${BASE}/select_target/versions`, OP, { ...DRAFT, executorKey: undefined, template: 'Choose from {{target_ledger}}.', expectedVersion: 1 });
    expect(v2.status).toBe(201);
    expect(v2.body.prompt.version).toBe(2);
    expect((await call('POST', `${BASE}/select_target/versions`, OP, { ...DRAFT, template: 'x {{target_ledger}}', expectedVersion: 1 })).body.error.code).toBe('LEDGER_CONFLICT');

    const list = await call('GET', BASE, VIEW);
    expect(list.body.prompts).toHaveLength(1);
    expect(list.body.prompts[0]).toMatchObject({ promptId: 'select_target', latestVersion: 2 });
    expect((await call('GET', `${BASE}/select_target`, VIEW)).body.prompt.version).toBe(2);
    expect((await call('GET', `${BASE}/select_target/versions`, VIEW)).body.versions.map((v: any) => v.version)).toEqual([1, 2]);
    const v1 = (await call('GET', `${BASE}/select_target/versions/1`, VIEW)).body.prompt;
    expect(v1.template).toBe(DRAFT.template);

    const diff = await call('GET', `${BASE}/select_target/diff?a=1&b=2`, VIEW);
    expect(diff.status).toBe(200);
    expect(diff.body.template).toMatchObject({ added: 1, removed: 1 });

    const rolled = await call('POST', `${BASE}/select_target/rollback`, OP, { toVersion: 1, note: 'revert' });
    expect(rolled.status).toBe(201);
    expect(rolled.body.prompt).toMatchObject({ version: 3, rollbackOf: 1, digest: v1.digest, note: 'revert' });
    expect((await call('GET', `${BASE}/select_target/versions/1`, VIEW)).body.prompt).toEqual(v1);
    expect((await call('GET', `${BASE}/select_target/versions/2`, VIEW)).body.prompt.template).toBe('Choose from {{target_ledger}}.');
    expect(audited.map((e) => e.data.action)).toEqual(['publish', 'publish', 'rollback']);
  });

  it('maps errors to contract status codes', async () => {
    const { call } = await start();
    expect((await call('GET', `${BASE}/missing`, VIEW)).status).toBe(404);
    expect((await call('GET', `${BASE}/missing/versions`, VIEW)).status).toBe(404);
    expect((await call('GET', `${BASE}/missing/versions/1`, VIEW)).body.error.code).toBe('NOT_FOUND');
    expect((await call('GET', `${BASE}/missing/versions/abc`, VIEW)).status).toBe(400);
    expect((await call('GET', `${BASE}/missing/diff?a=1`, VIEW)).status).toBe(400);
    expect((await call('POST', BASE, OP, { ...DRAFT, executorKey: '../x' })).status).toBe(400);
    expect((await call('POST', BASE, OP, { ...DRAFT, inputSchema: { type: 'bogus' } })).body.error.code).toBe('VALIDATION');
    expect((await call('POST', `${BASE}/missing/versions`, OP, DRAFT)).status).toBe(404);
    expect((await call('POST', `${BASE}/missing/rollback`, OP, { toVersion: 1 })).status).toBe(404);
    expect((await call('POST', BASE, OP, { ...DRAFT, expectedVersion: 'x' })).status).toBe(400);
  });

  it('renders a preview with input validation', async () => {
    const { call } = await start();
    await call('POST', BASE, OP, DRAFT);
    const ok = await call('POST', `${BASE}/select_target/render`, VIEW, { inputs: { target_ledger: { Y1: 'eligible' } } });
    expect(ok.status).toBe(200);
    expect(ok.body.text).toContain('"Y1": "eligible"');
    const bad = await call('POST', `${BASE}/select_target/render`, VIEW, { inputs: {} });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION');
  });

  it('evaluate is 503 without a runner', async () => {
    const { call } = await start();
    await call('POST', BASE, OP, DRAFT);
    const res = await call('POST', `${BASE}/select_target/evaluate`, OP, { cases: [{ id: 'a', inputs: { target_ledger: {} } }] });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toBe('prompt evaluation runner not configured');
  });

  it('evaluates and compares versions with a configured runner and stores results', async () => {
    const { call } = await start({ runner });
    await call('POST', BASE, OP, DRAFT);
    await call('POST', BASE, OP, { ...DRAFT, template: 'Ignore {{target_ledger}} entirely.' });
    const cases = [{ id: 'eligible', inputs: { target_ledger: { Y1: 'eligible' } }, expect: { subset: { target_id: 'Y1' } } }];
    const evaluation = await call('POST', `${BASE}/select_target/evaluate`, OP, { version: 1, cases });
    expect(evaluation.status).toBe(200);
    expect(evaluation.body.evaluation.summary).toMatchObject({ total: 1, passed: 1 });
    const comparison = await call('POST', `${BASE}/select_target/evaluate`, OP, { version: 1, compareWith: 2, cases: [{ id: 'eligible', inputs: { target_ledger: {} } }] });
    expect(comparison.status).toBe(200);
    expect(comparison.body.comparison.perCase[0]).toMatchObject({ caseId: 'eligible', a: false, b: false });
    expect((await call('POST', `${BASE}/select_target/evaluate`, OP, { cases: [] })).status).toBe(400);
    const stored = await call('GET', `${BASE}/select_target/evaluations`, VIEW);
    expect(stored.body.evaluations).toHaveLength(3);
    expect((await call('GET', `${BASE}/select_target/evaluations?version=2`, VIEW)).body.evaluations).toHaveLength(1);
  });

  it('registers the prompts web module with WazirGoalStudio', async () => {
    let registeredName = '';
    let registeredMod: any;
    (globalThis as any).window = {
      WazirGoalStudio: {
        register(name: string, mod: unknown) {
          registeredName = name;
          registeredMod = mod;
        },
      },
    };
    const mod = await import('../../web/public/goal-studio/prompts.js');
    mod.registerPromptsStudio((globalThis as any).window);
    expect(registeredName).toBe('prompts');
    expect(typeof registeredMod.mount).toBe('function');
    expect(typeof registeredMod.unmount).toBe('function');
    delete (globalThis as any).window;
  });
});
