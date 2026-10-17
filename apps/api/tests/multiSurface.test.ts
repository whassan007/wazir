import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '@wazir/shared';
import { createApiState, createApp, type ApiState } from '../src/server.js';

const OPERATOR_TOKEN = 'op-secret-wazir-multisurface-test-token';
const VIEWER_TOKEN = 'vw-secret-wazir-multisurface-test-token';
const REGISTRATION_TOKEN = 'reg-secret-wazir-multisurface-test-token';

interface TestHarness {
  workspace: string;
  auditPath: string;
  state: ApiState;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<TestHarness> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-multisurface-api-'));
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify(
      {
        name: 'multisurface-test-fixture',
        version: '1.0.0',
        scripts: {
          test: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Multi-Surface Test Fixture\n');
  const auditPath = path.join(workspace, 'audit.jsonl');

  const store = new MemoryStore();
  const state = await createApiState({
    store,
    projectRoot: workspace,
    auditPath,
    enableMobileApprovals: true,
    auth: {
      operatorToken: OPERATOR_TOKEN,
      viewerToken: VIEWER_TOKEN,
      registrationToken: REGISTRATION_TOKEN,
      store,
    },
  });

  const app = createApp(state);
  const server: Server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const port = (server.address() as AddressInfo).port;

  return {
    workspace,
    auditPath,
    state,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      state.mobile.multiSurface.stopScheduleTicker();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}

async function jsonReq<T = Record<string, unknown>>(
  baseUrl: string,
  method: string,
  route: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.headers ?? {}),
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

describe('Phase 1: Multi-Surface Shared Capabilities (Web, Desktop, Mobile)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('manages autonomy posture (read-only, request-review, auto-sandbox) and cellular-strict downgrade', async () => {
    // 1. Default posture is request-review
    const initial = await jsonReq<{ autonomy: Record<string, unknown> }>(
      harness.baseUrl,
      'GET',
      '/api/v1/autonomy',
      { token: VIEWER_TOKEN },
    );
    expect(initial.status).toBe(200);
    expect(initial.body.autonomy.posture).toBe('request-review');
    expect(initial.body.autonomy.mode).toBe('request-review');
    expect(initial.body.autonomy.effectivePosture).toBe('request-review');

    // 2. Switch to auto-sandbox
    const autoRes = await jsonReq<{ ok: boolean; autonomy: Record<string, unknown> }>(
      harness.baseUrl,
      'POST',
      '/api/v1/autonomy',
      { token: OPERATOR_TOKEN, body: { mode: 'auto-sandbox' } },
    );
    expect(autoRes.status).toBe(200);
    expect(autoRes.body.autonomy.posture).toBe('auto-sandbox');
    expect(autoRes.body.autonomy.effectivePosture).toBe('auto-sandbox');

    // 3. Enabling cellular-strict network guard automatically downgrades effectivePosture to request-review
    const cellularRes = await jsonReq<{ ok: boolean; autonomy: Record<string, unknown> }>(
      harness.baseUrl,
      'POST',
      '/api/v1/mobile/autonomy',
      { token: OPERATOR_TOKEN, body: { networkGuard: 'cellular-strict' } },
    );
    expect(cellularRes.status).toBe(200);
    expect(cellularRes.body.autonomy.posture).toBe('auto-sandbox');
    expect(cellularRes.body.autonomy.networkGuard).toBe('cellular-strict');
    expect(cellularRes.body.autonomy.effectivePosture).toBe('request-review');

    // 4. Switch to read-only
    const roRes = await jsonReq<{ ok: boolean; autonomy: Record<string, unknown> }>(
      harness.baseUrl,
      'POST',
      '/api/v1/autonomy',
      { token: OPERATOR_TOKEN, body: { posture: 'read-only', networkGuard: 'normal' } },
    );
    expect(roRes.status).toBe(200);
    expect(roRes.body.autonomy.effectivePosture).toBe('read-only');
  });

  it('generates Verifiable Artifacts (plan, code_diff, test_summary, sandbox_preview) and persists Keep/Skip diff reviews', async () => {
    // Switch to auto-sandbox so file write executes without blocking on manual approval
    await jsonReq(harness.baseUrl, 'POST', '/api/v1/autonomy', {
      token: OPERATOR_TOKEN,
      body: { posture: 'auto-sandbox' },
    });

    // Submit a task that writes a file and runs verification
    const submitRes = await jsonReq<{ ok: boolean; task: { taskId: string; executionId: string } }>(
      harness.baseUrl,
      'POST',
      '/api/v1/mobile/tasks',
      {
        token: OPERATOR_TOKEN,
        body: {
          title: 'Create feature module',
          input: 'Write src/feature.ts with a greet helper',
          operations: [
            {
              tool: {
                name: 'write',
                input: {
                  path: 'src/feature.ts',
                  content: 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
                },
              },
              verify: ['test'],
            },
          ],
        },
      },
    );
    expect(submitRes.status).toBe(201);
    const { taskId, executionId } = submitRes.body.task;

    // Wait for task completion
    let state = 'running';
    for (let i = 0; i < 40; i++) {
      const detail = await jsonReq<{ task: { state: string } }>(
        harness.baseUrl,
        'GET',
        `/api/v1/mobile/tasks/${taskId}`,
        { token: OPERATOR_TOKEN },
      );
      state = detail.body.task.state;
      if (state === 'completed' || state === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(state).toBe('completed');

    // Fetch Verifiable Artifacts via /api/v1/executions/:id/artifacts
    const artRes = await jsonReq<{
      executionId: string;
      artifacts: Array<{
        kind: string;
        status: string;
        plan?: { steps: unknown[] };
        codeDiff?: { files: Array<{ path: string; reviewDecision: string; additions: number }>; summary: Record<string, number> };
        testSummary?: { overallStatus: string; passedCount: number };
        sandboxPreview?: { sandboxCsp: string; htmlDoc: string };
      }>;
    }>(harness.baseUrl, 'GET', `/api/v1/executions/${executionId}/artifacts`, { token: VIEWER_TOKEN });

    expect(artRes.status).toBe(200);
    expect(artRes.body.artifacts).toHaveLength(4);

    const kinds = artRes.body.artifacts.map((a) => a.kind);
    expect(kinds).toEqual(['plan', 'code_diff', 'test_summary', 'sandbox_preview']);

    const diffArtifact = artRes.body.artifacts.find((a) => a.kind === 'code_diff')!;
    expect(diffArtifact.codeDiff!.files.length).toBeGreaterThanOrEqual(1);
    const targetFile = diffArtifact.codeDiff!.files.find((f) => f.path.includes('feature.ts'))!;
    expect(targetFile).toBeDefined();
    expect(targetFile.reviewDecision).toBe('pending');
    expect(targetFile.additions).toBeGreaterThan(0);

    const previewArtifact = artRes.body.artifacts.find((a) => a.kind === 'sandbox_preview')!;
    expect(previewArtifact.sandboxPreview!.sandboxCsp).toContain("default-src 'none'");

    // Review the file as 'keep' via /api/v1/executions/:id/diff-review
    const keepRes = await jsonReq<{
      ok: boolean;
      file: { path: string; reviewDecision: string };
      artifacts: Array<{ kind: string; status: string; codeDiff?: { summary: { keptCount: number; pendingCount: number } } }>;
    }>(harness.baseUrl, 'POST', `/api/v1/executions/${executionId}/diff-review`, {
      token: OPERATOR_TOKEN,
      body: { path: targetFile.path, decision: 'keep', note: 'LGTM' },
    });
    expect(keepRes.status).toBe(200);
    expect(keepRes.body.file.reviewDecision).toBe('keep');
    const updatedDiff = keepRes.body.artifacts.find((a) => a.kind === 'code_diff')!;
    expect(updatedDiff.codeDiff!.summary.keptCount).toBe(1);
    expect(updatedDiff.codeDiff!.summary.pendingCount).toBe(0);
    expect(updatedDiff.status).toBe('verified');

    // Review the file as 'skip' via mobile route /api/v1/mobile/tasks/:id/diff-review
    const skipRes = await jsonReq<{
      ok: boolean;
      file: { path: string; reviewDecision: string };
    }>(harness.baseUrl, 'POST', `/api/v1/mobile/tasks/${taskId}/diff-review`, {
      token: OPERATOR_TOKEN,
      body: { path: targetFile.path, decision: 'skip' },
    });
    expect(skipRes.status).toBe(200);
    expect(skipRes.body.file.reviewDecision).toBe('skip');
  });

  it('manages host instances and Mode B remote host pairing across controllers', async () => {
    const remoteHarness = await startHarness();
    try {
      // 1. List hosts on local controller
      const list1 = await jsonReq<{ hosts: Array<{ id: string; active: boolean }>; activeHostId: string }>(
        harness.baseUrl,
        'GET',
        '/api/v1/hosts',
        { token: VIEWER_TOKEN },
      );
      expect(list1.status).toBe(200);
      expect(list1.body.activeHostId).toBe('local');
      expect(list1.body.hosts.some((h) => h.id === 'local')).toBe(true);

      // 2. Initiate pairing session on remote controller
      const initPair = await jsonReq<{ sessionId: string; pairingSecret: string }>(
        remoteHarness.baseUrl,
        'POST',
        '/api/v1/mobile/pair/sessions',
        { token: OPERATOR_TOKEN, body: { controllerUrl: remoteHarness.baseUrl } },
      );
      expect(initPair.status).toBe(201);

      // 3. Request pairing from local controller (Mode B Desktop/Web remote host pairing)
      const reqPair = await jsonReq<{ status: string; confirmationCode: string }>(
        harness.baseUrl,
        'POST',
        '/api/v1/hosts/pair',
        {
          token: OPERATOR_TOKEN,
          body: {
            action: 'request',
            controllerUrl: remoteHarness.baseUrl,
            sessionId: initPair.body.sessionId,
            pairingSecret: initPair.body.pairingSecret,
            deviceName: 'Wazir Desktop Test',
          },
        },
      );
      expect(reqPair.status).toBe(202);
      expect(reqPair.body.status).toBe('pending_operator_approval');

      // 4. Approve pairing on remote controller
      const approvePair = await jsonReq(
        remoteHarness.baseUrl,
        'POST',
        `/api/v1/mobile/pair/sessions/${initPair.body.sessionId}/approve`,
        { token: OPERATOR_TOKEN, body: { decision: 'approve' } },
      );
      expect(approvePair.status).toBe(200);

      // 5. Complete pairing on local controller and set active
      const compPair = await jsonReq<{ status: string; host: { id: string; url: string }; activeHostId: string }>(
        harness.baseUrl,
        'POST',
        '/api/v1/hosts/pair',
        {
          token: OPERATOR_TOKEN,
          body: {
            action: 'complete',
            controllerUrl: remoteHarness.baseUrl,
            sessionId: initPair.body.sessionId,
            pairingSecret: initPair.body.pairingSecret,
            setActive: true,
          },
        },
      );
      expect(compPair.status).toBe(200);
      expect(compPair.body.status).toBe('approved');
      expect(compPair.body.host.url).toBe(remoteHarness.baseUrl);
      expect(compPair.body.activeHostId).toBe(compPair.body.host.id);

      // 6. Switch back to local host
      const selectLocal = await jsonReq<{ activeHostId: string }>(
        harness.baseUrl,
        'POST',
        '/api/v1/hosts/select',
        { token: OPERATOR_TOKEN, body: { id: 'local' } },
      );
      expect(selectLocal.status).toBe(200);
      expect(selectLocal.body.activeHostId).toBe('local');
    } finally {
      await remoteHarness.close();
    }
  });

  it('creates, updates, triggers, and deletes scheduled tasks using @wazir/scheduler routing', async () => {
    // 1. Create a schedule
    const createRes = await jsonReq<{
      ok: boolean;
      schedule: {
        id: string;
        name: string;
        cadenceMinutes: number;
        schedulerExplanation: string;
        routingPlan: { modelId: string; runtimeId: string; summary: string };
      };
    }>(harness.baseUrl, 'POST', '/api/v1/schedules', {
      token: OPERATOR_TOKEN,
      body: {
        name: 'Hourly Repository Health Audit',
        prompt: 'Inspect package.json and verify build integrity',
        cadenceMinutes: 30,
      },
    });
    expect(createRes.status).toBe(201);
    const sched = createRes.body.schedule;
    expect(sched.id).toMatch(/^sched-/);
    expect(sched.cadenceMinutes).toBe(30);
    expect(sched.schedulerExplanation.length).toBeGreaterThan(0);
    expect(sched.routingPlan.summary).toContain('Agent:');

    // 2. Toggle schedule enabled state
    const patchRes = await jsonReq<{ ok: boolean; schedule: { enabled: boolean } }>(
      harness.baseUrl,
      'PATCH',
      `/api/v1/schedules/${sched.id}`,
      { token: OPERATOR_TOKEN, body: { enabled: false } },
    );
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.schedule.enabled).toBe(false);

    // 3. Trigger immediate execution of scheduled task
    const runRes = await jsonReq<{ ok: boolean; schedule: { runCount: number; lastTaskId: string }; taskId: string }>(
      harness.baseUrl,
      'POST',
      `/api/v1/schedules/${sched.id}/run`,
      { token: OPERATOR_TOKEN },
    );
    expect(runRes.status).toBe(201);
    expect(runRes.body.schedule.runCount).toBe(1);
    expect(runRes.body.taskId).toBeDefined();

    // 4. Delete schedule
    const delRes = await jsonReq<{ ok: boolean }>(
      harness.baseUrl,
      'DELETE',
      `/api/v1/schedules/${sched.id}`,
      { token: OPERATOR_TOKEN },
    );
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);
  });

  it('imports SSH tunnel host profiles from OpenSSH config text into the host switcher', async () => {
    const sampleSshConfig = `
# Production and Staging Wazir Fleet
Host prod-fleet
  HostName 10.24.0.15
  User ubuntu
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
  LocalForward 4120 127.0.0.1:4100

Host staging-gpu
  HostName gpu.staging.internal
  User deploy

Host *
  ServerAliveInterval 60
`;

    const importRes = await jsonReq<{
      ok: boolean;
      imported: Array<{
        id: string;
        name: string;
        url: string;
        sshAlias?: string;
        sshTunnelCommand?: string;
      }>;
      profiles: Array<{
        alias: string;
        hostName: string;
        user?: string;
        port: number;
        localForwardPort: number;
        suggestedControllerUrl: string;
        sshTunnelCommand: string;
      }>;
      hosts: Array<{ id: string }>;
    }>(harness.baseUrl, 'POST', '/api/v1/hosts/import-ssh', {
      token: OPERATOR_TOKEN,
      body: {
        configText: sampleSshConfig,
      },
    });

    expect(importRes.status).toBe(201);
    expect(importRes.body.ok).toBe(true);
    expect(importRes.body.profiles).toHaveLength(2);
    expect(importRes.body.imported).toHaveLength(2);

    const prodProfile = importRes.body.profiles.find((p) => p.alias === 'prod-fleet')!;
    expect(prodProfile.hostName).toBe('10.24.0.15');
    expect(prodProfile.user).toBe('ubuntu');
    expect(prodProfile.port).toBe(2222);
    expect(prodProfile.localForwardPort).toBe(4120);
    expect(prodProfile.suggestedControllerUrl).toBe('http://127.0.0.1:4120');
    expect(prodProfile.sshTunnelCommand).toContain('ssh -N -L 4120:127.0.0.1:4100');

    const prodHost = importRes.body.imported.find((h) => h.id === 'ssh-prod-fleet')!;
    expect(prodHost).toBeDefined();
    expect(prodHost.url).toBe('http://127.0.0.1:4120');
    expect(prodHost.sshAlias).toBe('prod-fleet');
  });

  it('registers Cloud Push Relay devices and dispatches out-of-band wakeups on approval gates and task completion', async () => {
    // 1. Register mobile push relay token
    const regRes = await jsonReq<{
      ok: boolean;
      registration: {
        deviceId: string;
        provider: string;
        pushToken: string;
        enabled: boolean;
        deliveryCount: number;
      };
    }>(harness.baseUrl, 'POST', '/api/v1/mobile/push/register', {
      token: OPERATOR_TOKEN,
      body: {
        deviceId: 'pixel-9-pro',
        deviceName: 'Pixel 9 Pro',
        provider: 'fcm',
        pushToken: 'fcm-token-xyz-987654',
        notifyApprovals: true,
        notifyTaskTerminal: true,
      },
    });
    expect(regRes.status).toBe(201);
    expect(regRes.body.ok).toBe(true);
    expect(regRes.body.registration.deviceId).toBe('pixel-9-pro');
    expect(regRes.body.registration.provider).toBe('fcm');

    // 2. Trigger test wakeup
    const testWakeRes = await jsonReq<{
      ok: boolean;
      wakeups: Array<{ deviceId: string; eventType: string; deepLink: string; status: string }>;
    }>(harness.baseUrl, 'POST', '/api/v1/mobile/push/test', {
      token: OPERATOR_TOKEN,
      body: {
        deviceId: 'pixel-9-pro',
        title: 'Test Wakeup Ping',
      },
    });
    expect(testWakeRes.status).toBe(200);
    expect(testWakeRes.body.wakeups).toHaveLength(1);
    expect(testWakeRes.body.wakeups[0].eventType).toBe('push.test_wakeup');
    expect(testWakeRes.body.wakeups[0].status).toBe('delivered');

    // 3. Emit an approval.requested event on the mobile event hub and verify automatic push wakeup
    await harness.state.mobile.eventHub.publish({
      type: 'approval.requested',
      taskId: 'task-push-99',
      executionId: 'exec-push-99',
      approvalId: 'apr-push-99',
      status: 'pending',
      summary: 'High-risk bash command requires mobile approval',
    });

    const statusRes = await jsonReq<{
      registrations: Array<{ deviceId: string; deliveryCount: number }>;
      recentWakeups: Array<{
        deviceId: string;
        eventType: string;
        deepLink: string;
        approvalId?: string;
        priority: string;
      }>;
    }>(harness.baseUrl, 'GET', '/api/v1/mobile/push/status?deviceId=pixel-9-pro', {
      token: VIEWER_TOKEN,
    });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.registrations).toHaveLength(1);
    expect(statusRes.body.registrations[0].deliveryCount).toBeGreaterThanOrEqual(2);

    const approvalWakeup = statusRes.body.recentWakeups.find((w) => w.eventType === 'approval.requested')!;
    expect(approvalWakeup).toBeDefined();
    expect(approvalWakeup.approvalId).toBe('apr-push-99');
    expect(approvalWakeup.deepLink).toBe('wazir://approvals/apr-push-99');
    expect(approvalWakeup.priority).toBe('high');

    // 4. Unregister push relay
    const unregRes = await jsonReq<{ ok: boolean; deviceId: string }>(
      harness.baseUrl,
      'POST',
      '/api/v1/mobile/push/unregister',
      {
        token: OPERATOR_TOKEN,
        body: { deviceId: 'pixel-9-pro' },
      },
    );
    expect(unregRes.status).toBe(200);
    expect(unregRes.body.ok).toBe(true);
  });
});

