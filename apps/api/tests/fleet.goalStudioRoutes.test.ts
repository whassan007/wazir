import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { ComputerRegistry, ModelRegistry, RuntimeRegistry } from '@wazir/core';
import { createModelRouter, type ProbeAdapter, type ProbeGenerationEvent, type ProbeGenerationRequest } from '@wazir/goals';
import { MemoryStore } from '@wazir/shared';
import { ApiAuth } from '../src/auth.js';
import { registerFleetRoutes } from '../src/goalStudio/fleetRoutes.js';
import type { GoalStudioRouteContext } from '../src/goalStudio/context.js';

const RUNTIME_CAPS = {
  chat: true,
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  vision: false,
  embeddings: false,
  reasoning: false,
  modelLoad: true,
  modelUnload: true,
  modelDownload: false,
  statefulChat: false,
  mcp: false,
};

class FakeLocalAdapter implements ProbeAdapter {
  readonly type = 'ollama';
  readonly id = 'ollama';
  readonly requests: ProbeGenerationRequest[] = [];

  async *generate(req: ProbeGenerationRequest): AsyncIterable<ProbeGenerationEvent> {
    this.requests.push(req);
    if (req.tools && req.tools.length > 0) {
      yield { type: 'tool_call', toolName: req.tools[0].name, toolInput: { status: 'ok' } };
      yield { type: 'completed' };
      return;
    }
    yield { type: 'token', content: 'OK' };
    yield { type: 'completed' };
  }
}

interface TestHarness {
  baseUrl: string;
  close: () => Promise<void>;
  adapter: FakeLocalAdapter;
  auditEvents: Array<Record<string, unknown>>;
}

async function startHarness(options: { withRouter?: boolean } = {}): Promise<TestHarness> {
  const store = new MemoryStore();
  const auth = new ApiAuth({
    operatorToken: 'op-secret-token',
    viewerToken: 'view-secret-token',
    allowUnauthenticated: false,
    store,
  });
  await auth.init();

  const models = new ModelRegistry();
  const runtimes = new RuntimeRegistry();
  const computers = new ComputerRegistry();

  computers.register({
    id: 'local',
    name: 'Local Workstation',
    type: 'workstation',
    local: true,
    os: { platform: 'darwin', architecture: 'arm64', version: '24.0.0' },
    hardware: { cpu: 'Apple M3 Max', cpuCores: 16, memoryGB: 64 },
    runtimes: ['ollama'],
  });
  computers.register({
    id: 'dgx-1',
    name: 'DGX Spark Node',
    type: 'remote-worker',
    local: false,
    os: { platform: 'linux', architecture: 'arm64', version: '6.8.0' },
    hardware: { cpu: 'Grace', cpuCores: 20, memoryGB: 128 },
    runtimes: ['ollama-remote'],
  });

  runtimes.register({
    id: 'ollama',
    type: 'ollama',
    name: 'Ollama Local',
    version: '0.5.0',
    computerId: 'local',
    capabilities: RUNTIME_CAPS,
  });
  runtimes.setHealth('ollama', 'healthy');

  runtimes.register({
    id: 'anthropic',
    type: 'anthropic',
    name: 'Anthropic API',
    version: '1.0',
    runtimeKind: 'hosted',
    capabilities: RUNTIME_CAPS,
  });
  runtimes.setHealth('anthropic', 'healthy');

  models.register({
    id: 'qwen2.5-coder:14b',
    name: 'Qwen 2.5 Coder 14B',
    provider: 'ollama',
    family: 'qwen',
    contextMax: 32768,
    capabilities: ['generalChat', 'coding', 'agenticExecution'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: false,
    runtimeCompatibility: ['ollama'],
    local: true,
    createdAt: new Date('2026-10-22T00:00:00Z'),
    updatedAt: new Date('2026-10-22T00:00:00Z'),
  });
  models.upsertInstance({
    id: 'qwen2.5-coder:14b@ollama',
    modelId: 'qwen2.5-coder:14b',
    runtimeId: 'ollama',
    computerId: 'local',
    runtimeModelId: 'qwen2.5-coder:14b',
    loaded: true,
    state: 'READY',
    health: 'healthy',
  });

  models.register({
    id: 'claude-3-7-sonnet',
    name: 'Claude 3.7 Sonnet',
    provider: 'anthropic',
    family: 'other',
    contextMax: 200000,
    capabilities: ['generalChat', 'coding', 'agenticExecution'],
    toolCalling: true,
    structuredOutput: true,
    vision: true,
    audio: false,
    embedding: false,
    reasoning: true,
    runtimeCompatibility: ['anthropic'],
    local: false,
    createdAt: new Date('2026-10-22T00:00:00Z'),
    updatedAt: new Date('2026-10-22T00:00:00Z'),
  });
  models.upsertInstance({
    id: 'claude-3-7-sonnet@anthropic',
    modelId: 'claude-3-7-sonnet',
    runtimeId: 'anthropic',
    runtimeModelId: 'claude-3-7-sonnet',
    loaded: true,
    state: 'READY',
    health: 'healthy',
  });

  const adapter = new FakeLocalAdapter();
  const router =
    options.withRouter === false
      ? undefined
      : createModelRouter({
          store,
          workspaceRoot: '/tmp/goal-studio-test',
          models,
          runtimes,
          computers,
          adapters: { ollama: adapter },
          pricing: (modelId) => (modelId === 'claude-3-7-sonnet' ? { inputPerMTok: 3, outputPerMTok: 15 } : undefined),
        });

  const auditEvents: Array<Record<string, unknown>> = [];
  const ctx: GoalStudioRouteContext = {
    auth,
    store,
    services: {
      ...(router ? { router } : {}),
      governance: {
        preflight: async () => ({ effect: 'allow', reasons: [] }),
        authorizeSpend: () => ({ effect: 'allow', reasons: [] }),
        audit: async (event) => {
          auditEvents.push(event as unknown as Record<string, unknown>);
        },
      },
    },
  };

  const app = express();
  app.use(express.json());
  registerFleetRoutes(app, ctx);

  const server: Server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    adapter,
    auditEvents,
  };
}

let activeHarness: TestHarness | undefined;
afterEach(async () => {
  if (activeHarness) {
    await activeHarness.close();
    activeHarness = undefined;
  }
});

describe('Goal Studio Fleet HTTP routes', () => {
  it('returns 503 when router service is not configured yet', async () => {
    activeHarness = await startHarness({ withRouter: false });
    const res = await fetch(`${activeHarness.baseUrl}/api/v1/goal-studio/fleet/models`, {
      headers: { Authorization: 'Bearer view-secret-token' },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toMatch(/router not configured/);
  });

  it('enforces RBAC: viewer can read models/workers/route, but only operator can probe or register', async () => {
    activeHarness = await startHarness();

    // Unauthenticated -> 401
    const unauth = await fetch(`${activeHarness.baseUrl}/api/v1/goal-studio/fleet/models`);
    expect(unauth.status).toBe(401);

    // Viewer can read models and workers
    const modelsRes = await fetch(`${activeHarness.baseUrl}/api/v1/goal-studio/fleet/models`, {
      headers: { Authorization: 'Bearer view-secret-token' },
    });
    expect(modelsRes.status).toBe(200);
    const modelsBody = (await modelsRes.json()) as { models: Array<{ modelId: string }> };
    expect(modelsBody.models.map((m) => m.modelId)).toEqual(['claude-3-7-sonnet', 'qwen2.5-coder:14b']);

    const workersRes = await fetch(`${activeHarness.baseUrl}/api/v1/goal-studio/fleet/workers`, {
      headers: { Authorization: 'Bearer view-secret-token' },
    });
    expect(workersRes.status).toBe(200);
    const workersBody = (await workersRes.json()) as { workers: Array<{ id: string }> };
    expect(workersBody.workers.map((w) => w.id)).toEqual(['dgx-1', 'local']);

    // Viewer cannot probe or register -> 403
    const viewerProbe = await fetch(`${activeHarness.baseUrl}/api/v1/goal-studio/fleet/models/probe`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer view-secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(viewerProbe.status).toBe(403);

    const viewerReg = await fetch(`${activeHarness.baseUrl}/api/v1/goal-studio/fleet/models/register`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer view-secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: 'test-model' }),
    });
    expect(viewerReg.status).toBe(403);
  });

  it('probes local models via POST /fleet/models/probe, skips hosted models, and routes via POST /fleet/route', async () => {
    activeHarness = await startHarness();
    const opHeaders = {
      Authorization: 'Bearer op-secret-token',
      'Content-Type': 'application/json',
    };

    // Before probing, route simulator returns null decision with rejection reason
    const preRouteRes = await fetch(`${activeHarness.baseUrl}/api/v1/goal-studio/fleet/route`, {
      method: 'POST',
      headers: opHeaders,
      body: JSON.stringify({
        requiredCapabilities: ['coding', 'toolCalling'],
        remainingHostedBudgetUsd: 0,
        localFirst: true,
      }),
    });
    expect(preRouteRes.status).toBe(200);
    const preRoute = (await preRouteRes.json()) as { decision: null; candidates: Array<{ modelId: string; rejection?: string }> };
    expect(preRoute.decision).toBeNull();
    expect(preRoute.candidates.find((c) => c.modelId === 'qwen2.5-coder:14b')?.rejection).toMatch(/never probed/);

    // Probe local fleet
    const probeRes = await fetch(`${activeHarness.baseUrl}/api/v1/goal-studio/fleet/models/probe`, {
      method: 'POST',
      headers: opHeaders,
      body: JSON.stringify({ force: true, tools: true }),
    });
    expect(probeRes.status).toBe(200);
    const sweep = (await probeRes.json()) as { probed: Array<{ modelId: string; ready: boolean; toolUse: string }>; skipped: Array<{ modelId: string }> };
    expect(sweep.probed).toHaveLength(1);
    expect(sweep.probed[0]).toMatchObject({
      modelId: 'qwen2.5-coder:14b',
      ready: true,
      toolUse: 'verified',
    });
    expect(sweep.skipped.map((s) => s.modelId)).toEqual(['claude-3-7-sonnet']);

    // Route now selects verified-ready local Qwen model with $0 cost
    const routeRes = await fetch(`${activeHarness.baseUrl}/api/v1/goal-studio/fleet/route`, {
      method: 'POST',
      headers: opHeaders,
      body: JSON.stringify({
        requiredCapabilities: ['coding', 'toolCalling'],
        remainingHostedBudgetUsd: 0,
        localFirst: true,
      }),
    });
    expect(routeRes.status).toBe(200);
    const routed = (await routeRes.json()) as {
      decision: { modelId: string; hosted: boolean; estimatedCostUsd: number; rejected: Array<{ modelId: string; reason: string }> };
    };
    expect(routed.decision.modelId).toBe('qwen2.5-coder:14b');
    expect(routed.decision.hosted).toBe(false);
    expect(routed.decision.estimatedCostUsd).toBe(0);
    expect(routed.decision.rejected.find((r) => r.modelId === 'claude-3-7-sonnet')).toBeDefined();
  });

  it('registers a new model via POST /fleet/models/register and validates bad payloads', async () => {
    activeHarness = await startHarness();
    const opHeaders = {
      Authorization: 'Bearer op-secret-token',
      'Content-Type': 'application/json',
    };

    const badRes = await fetch(`${activeHarness.baseUrl}/api/v1/goal-studio/fleet/models/register`, {
      method: 'POST',
      headers: opHeaders,
      body: JSON.stringify({ id: '' }),
    });
    expect(badRes.status).toBe(400);

    const regRes = await fetch(`${activeHarness.baseUrl}/api/v1/goal-studio/fleet/models/register`, {
      method: 'POST',
      headers: opHeaders,
      body: JSON.stringify({
        id: 'qwen2.5-coder:32b',
        name: 'Qwen 2.5 Coder 32B',
        provider: 'ollama',
        local: true,
        contextMax: 65536,
        toolCalling: true,
        capabilities: ['coding', 'agenticExecution'],
        instance: { runtimeId: 'ollama', computerId: 'local', loaded: true, state: 'READY' },
        readiness: { ready: true, latencyMs: 35, toolUse: 'verified' },
      }),
    });
    expect(regRes.status).toBe(201);
    const registered = (await regRes.json()) as { model: { modelId: string; readiness: { ready: boolean } } };
    expect(registered.model.modelId).toBe('qwen2.5-coder:32b');
    expect(registered.model.readiness.ready).toBe(true);
    expect(activeHarness.auditEvents.some((e) => (e.data as any)?.action === 'fleet.models.register')).toBe(true);
  });

  it('registers fleet.js into window.WazirGoalStudio and mounts/unmounts cleanly', async () => {
    const registered: Record<string, { mount: (el: any, ctx: any) => void; unmount?: () => void }> = {};
    (globalThis as any).window = {
      WazirGoalStudio: {
        register(name: string, mod: { mount: (el: any, ctx: any) => void; unmount?: () => void }) {
          registered[name] = mod;
        },
      },
      setInterval: () => 1,
      clearInterval: () => {},
    };
    try {
      const mod = await import('../../web/public/goal-studio/fleet.js');
      expect(registered.fleet).toBeDefined();
      expect(typeof registered.fleet.mount).toBe('function');
      expect(typeof registered.fleet.unmount).toBe('function');
      expect(typeof mod.createFleetModule).toBe('function');

      const fakeEl = {
        innerHTML: '',
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      const instance = mod.createFleetModule();
      instance.mount(fakeEl, {
        api: async (path: string) =>
          new Response(
            JSON.stringify(
              path.includes('/fleet/workers')
                ? { workers: [{ id: 'local', name: 'Local', status: 'online', health: 'healthy', local: true, runtimes: ['ollama'] }] }
                : {
                    summary: { models: 1, verifiedReady: 1, hosted: 0, computers: 1, computersOnline: 1, runtimes: 1, runtimesHealthy: 1 },
                    models: [
                      {
                        modelId: 'qwen2.5-coder:14b',
                        provider: 'ollama',
                        state: 'READY',
                        hosted: false,
                        local: true,
                        capabilities: { declared: ['coding'], toolCalling: true, contextTokens: 32768 },
                        readiness: { ready: true, fresh: true, reason: 'generated 2 chars in 12ms', latencyMs: 12, toolUse: 'verified' },
                        reliability: { state: 'CLOSED', samples: 1, failures: 0, failureRate: 0, reason: 'ok' },
                        accounting: { routes: 1, successes: 1, failures: 0, actualCostUsd: 0 },
                      },
                    ],
                    runtimes: [],
                  },
            ),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(fakeEl.innerHTML).toContain('qwen2.5-coder:14b');
      expect(fakeEl.innerHTML).toContain('VERIFIED READY');
      expect(fakeEl.innerHTML).toContain('LOCAL ($0)');
      instance.unmount();
      expect(fakeEl.innerHTML).toBe('');
    } finally {
      delete (globalThis as any).window;
    }
  });
});
