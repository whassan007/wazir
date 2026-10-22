import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '@wazir/shared';
import { createApiState, createApp, type ApiState } from '../src/server.js';
import { renderTerminalQrCode, runMobilePairCommand } from '../../cli/src/mobile.js';

const OPERATOR_TOKEN = 'op-secret-wazir-mobile-test-token';
const VIEWER_TOKEN = 'vw-secret-wazir-mobile-test-token';
const REGISTRATION_TOKEN = 'reg-secret-wazir-mobile-test-token';

interface TestHarness {
  workspace: string;
  auditPath: string;
  state: ApiState;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<TestHarness> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-mobile-api-'));
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify(
      {
        name: 'mobile-test-fixture',
        version: '1.0.0',
        scripts: {
          test: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Mobile Test Fixture\n');
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
      // ModelLifecycleService.startReconciliation() returns a disposer but createApiState
      // doesn't capture it; there's no stopReconciliation() method to call. The interval it
      // starts is unref()'d (modelLifecycleService.ts), so it never keeps the process alive.
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
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

describe('Wazir Mobile API & CLI Companion Integration', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  describe('1. Secure Device Pairing & Credential Lifecycle', () => {
    it('completes end-to-end single-use pairing without exposing operator token and rejects replay', async () => {
      // 1. Operator creates pairing session
      const sessionRes = await jsonReq<{
        sessionId: string;
        pairingSecret: string;
        qrUri: string;
        expiresAt: number;
        scopes: string[];
      }>(h.baseUrl, 'POST', '/api/v1/mobile/pair/sessions', {
        token: OPERATOR_TOKEN,
        body: {
          scopes: ['read', 'mutate', 'execute'],
          controllerUrl: h.baseUrl,
        },
      });
      expect(sessionRes.status).toBe(201);
      expect(sessionRes.body.qrUri).toContain('wazir://pair?');
      // Security requirement: Permanent operator token must NEVER be embedded in the QR URI
      expect(sessionRes.body.qrUri).not.toContain(OPERATOR_TOKEN);

      // 2. Android device submits pairing request
      const reqRes = await jsonReq<{
        ok: boolean;
        status: string;
        confirmationCode: string;
      }>(h.baseUrl, 'POST', '/api/v1/mobile/pair/request', {
        body: {
          sessionId: sessionRes.body.sessionId,
          pairingSecret: sessionRes.body.pairingSecret,
          deviceId: 'pixel-9-pro',
          deviceName: 'Wael Pixel 9 Pro',
          deviceModel: 'Pixel 9 Pro',
          osVersion: 'Android 15',
          publicKeyFingerprint: 'SHA256:11:22:33:44:55:66',
        },
      });
      expect(reqRes.status).toBe(202);
      expect(reqRes.body.status).toBe('pending_operator_approval');
      expect(reqRes.body.confirmationCode).toMatch(/^\d{3}-\d{3}$/);

      // Polling /complete before operator approval yields 202 pending
      const pendingComplete = await jsonReq<{ status: string }>(h.baseUrl, 'POST', '/api/v1/mobile/pair/complete', {
        body: {
          sessionId: sessionRes.body.sessionId,
          pairingSecret: sessionRes.body.pairingSecret,
        },
      });
      expect(pendingComplete.status).toBe(202);
      expect(pendingComplete.body.status).toBe('pending_operator_approval');

      // 3. Operator approves with matching confirmation code
      const approveRes = await jsonReq<{ ok: boolean; deviceId: string }>(
        h.baseUrl,
        'POST',
        `/api/v1/mobile/pair/sessions/${sessionRes.body.sessionId}/approve`,
        {
          token: OPERATOR_TOKEN,
          body: { confirmationCode: reqRes.body.confirmationCode },
        },
      );
      expect(approveRes.status).toBe(200);
      expect(approveRes.body.deviceId).toBe('pixel-9-pro');

      // 4. Android device claims its scoped credential
      const completeRes = await jsonReq<{
        ok: boolean;
        status: string;
        deviceId: string;
        accessToken: string;
        refreshToken: string;
        scopes: string[];
      }>(h.baseUrl, 'POST', '/api/v1/mobile/pair/complete', {
        body: {
          sessionId: sessionRes.body.sessionId,
          pairingSecret: sessionRes.body.pairingSecret,
        },
      });
      expect(completeRes.status).toBe(200);
      expect(completeRes.body.status).toBe('approved');
      expect(completeRes.body.accessToken).toMatch(/^mob_at_/);
      expect(completeRes.body.refreshToken).toMatch(/^mob_rt_/);

      // 5. Replay attempt on /complete is rejected with 409
      const replayRes = await jsonReq<{ code: string }>(h.baseUrl, 'POST', '/api/v1/mobile/pair/complete', {
        body: {
          sessionId: sessionRes.body.sessionId,
          pairingSecret: sessionRes.body.pairingSecret,
        },
      });
      expect(replayRes.status).toBe(409);
      expect(replayRes.body.code).toBe('PAIRING_SESSION_ALREADY_CLAIMED');

      // 6. Device credential works against /api/v1/mobile/handshake
      const handshake = await jsonReq<{
        compatible: boolean;
        principal: { id: string; scopes: string[] };
      }>(h.baseUrl, 'GET', '/api/v1/mobile/handshake', {
        token: completeRes.body.accessToken,
      });
      expect(handshake.status).toBe(200);
      expect(handshake.body.compatible).toBe(true);
      expect(handshake.body.principal.id).toBe('mobile:pixel-9-pro');

      // 7. Rotate mobile token using refresh token; old access token becomes invalid immediately
      const oldAccess = completeRes.body.accessToken;
      const rotated = await jsonReq<{
        ok: boolean;
        accessToken: string;
        refreshToken: string;
      }>(h.baseUrl, 'POST', '/api/v1/mobile/auth/rotate', {
        body: { refreshToken: completeRes.body.refreshToken },
      });
      expect(rotated.status).toBe(200);
      expect(rotated.body.accessToken).not.toBe(oldAccess);

      const oldTokenCheck = await jsonReq(h.baseUrl, 'GET', '/api/v1/mobile/handshake', {
        token: oldAccess,
      });
      expect(oldTokenCheck.status).toBe(401);

      const newTokenCheck = await jsonReq(h.baseUrl, 'GET', '/api/v1/mobile/handshake', {
        token: rotated.body.accessToken,
      });
      expect(newTokenCheck.status).toBe(200);

      // 8. Revoke device and verify immediate denial
      const revokeRes = await jsonReq(h.baseUrl, 'DELETE', '/api/v1/mobile/devices/pixel-9-pro', {
        token: OPERATOR_TOKEN,
      });
      expect(revokeRes.status).toBe(200);

      const afterRevoke = await jsonReq(h.baseUrl, 'GET', '/api/v1/mobile/dashboard', {
        token: rotated.body.accessToken,
      });
      expect(afterRevoke.status).toBe(401);
    });

    it('locks out a pairing session after 3 brute-force secret failures', async () => {
      const sessionRes = await jsonReq<{ sessionId: string; pairingSecret: string }>(
        h.baseUrl,
        'POST',
        '/api/v1/mobile/pair/sessions',
        { token: OPERATOR_TOKEN, body: {} },
      );

      for (let i = 0; i < 3; i++) {
        const bad = await jsonReq(h.baseUrl, 'POST', '/api/v1/mobile/pair/request', {
          body: {
            sessionId: sessionRes.body.sessionId,
            pairingSecret: `wrong-secret-${i}`,
            deviceName: 'Attacker Phone',
          },
        });
        expect(bad.status).toBe(401);
      }

      // Even with the real secret on attempt 4, the session is now locked/expired
      const locked = await jsonReq<{ code: string }>(h.baseUrl, 'POST', '/api/v1/mobile/pair/request', {
        body: {
          sessionId: sessionRes.body.sessionId,
          pairingSecret: sessionRes.body.pairingSecret,
          deviceName: 'Legit Phone',
        },
      });
      expect([410, 429]).toContain(locked.status);
    });

    it('supports `wa mobile pair` CLI helper and renders a terminal QR code', async () => {
      const qr = renderTerminalQrCode('wazir://pair?sessionId=pair-123&secret=abc');
      expect(qr.split('\n').length).toBeGreaterThan(10);

      const exitCode = await runMobilePairCommand({
        url: h.baseUrl,
        token: OPERATOR_TOKEN,
        wait: false,
        json: true,
      });
      expect(exitCode).toBe(0);
    });
  });

  describe('2. Role-Based Access Control (Viewer vs Operator Mobile Devices)', () => {
    it('allows viewer-scoped mobile devices to read state but denies all mutating or privileged actions', async () => {
      const viewerCred = await h.state.auth.issueMobileDeviceCredential({
        deviceId: 'viewer-tablet',
        deviceName: 'Read-Only Tablet',
        scopes: ['read'],
      });

      // Viewer CAN read dashboard, tasks, models, computers, resources, approvals
      const dash = await jsonReq(h.baseUrl, 'GET', '/api/v1/mobile/dashboard', { token: viewerCred.accessToken });
      expect(dash.status).toBe(200);
      const tasks = await jsonReq(h.baseUrl, 'GET', '/api/v1/mobile/tasks', { token: viewerCred.accessToken });
      expect(tasks.status).toBe(200);
      const comps = await jsonReq(h.baseUrl, 'GET', '/api/v1/mobile/computers', { token: viewerCred.accessToken });
      expect(comps.status).toBe(200);
      const resSnap = await jsonReq(h.baseUrl, 'GET', '/api/v1/mobile/resources', { token: viewerCred.accessToken });
      expect(resSnap.status).toBe(200);

      // Viewer CANNOT submit tasks, emergency-stop resources, or load models
      const submit = await jsonReq(h.baseUrl, 'POST', '/api/v1/mobile/tasks', {
        token: viewerCred.accessToken,
        body: { input: 'Attempt unauthorized task' },
      });
      expect(submit.status).toBe(403);

      const stop = await jsonReq(h.baseUrl, 'POST', '/api/v1/mobile/resources/emergency-stop', {
        token: viewerCred.accessToken,
        body: { reason: 'Viewer trying to stop' },
      });
      expect(stop.status).toBe(403);
    });
  });

  describe('3. Task Submission, Idempotency, Live SSE Events, and Verification', () => {
    it('submits a task with Idempotency-Key, deduplicates retries, executes tools + verification, and streams ordered SSE events', async () => {
      const mobileCred = await h.state.auth.issueMobileDeviceCredential({
        deviceId: 'op-phone',
        deviceName: 'Operator Phone',
        scopes: ['read', 'mutate', 'execute'],
      });

      const idemKey = 'idem-mobile-task-001';
      const firstSubmit = await jsonReq<{
        taskId: string;
        duplicate: boolean;
        task: { state: string; title: string };
      }>(h.baseUrl, 'POST', '/api/v1/mobile/tasks', {
        token: mobileCred.accessToken,
        headers: { 'Idempotency-Key': idemKey },
        body: {
          title: 'Inspect README and run tests',
          input: 'Read README.md and run verification test suite',
          priority: 'high',
          operations: [
            {
              tool: { name: 'read', input: { path: 'README.md' } },
              verify: ['test'],
            },
          ],
        },
      });
      expect(firstSubmit.status).toBe(201);
      expect(firstSubmit.body.duplicate).toBe(false);
      const taskId = firstSubmit.body.taskId;

      // Second POST with same Idempotency-Key returns 200 duplicate without creating a second task
      const dupSubmit = await jsonReq<{ taskId: string; duplicate: boolean }>(
        h.baseUrl,
        'POST',
        '/api/v1/mobile/tasks',
        {
          token: mobileCred.accessToken,
          headers: { 'Idempotency-Key': idemKey },
          body: {
            title: 'Inspect README and run tests',
            input: 'Read README.md and run verification test suite',
          },
        },
      );
      expect(dupSubmit.status).toBe(200);
      expect(dupSubmit.body.duplicate).toBe(true);
      expect(dupSubmit.body.taskId).toBe(taskId);

      // Wait for task completion
      let detail: Record<string, unknown> | undefined;
      for (let i = 0; i < 40; i++) {
        const res = await jsonReq<{ task: Record<string, unknown> }>(
          h.baseUrl,
          'GET',
          `/api/v1/mobile/tasks/${taskId}`,
          { token: mobileCred.accessToken },
        );
        if (res.body.task?.state === 'completed' || res.body.task?.state === 'failed') {
          detail = res.body.task;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(detail).toBeDefined();
      expect(detail?.state).toBe('completed');
      expect(detail?.verificationStatus).toBe('PASS');
      expect((detail?.toolCalls as unknown[])?.length).toBe(1);
      expect((detail?.logs as unknown[])?.length).toBeGreaterThan(0);

      // Verify SSE replay from cursor=0 returns ordered events for this task
      const recentEvents = await jsonReq<{
        cursor: number;
        events: Array<{ sequence: number; type: string; taskId?: string }>;
      }>(h.baseUrl, 'GET', `/api/v1/mobile/events/recent?taskId=${taskId}`, {
        token: mobileCred.accessToken,
      });
      expect(recentEvents.status).toBe(200);
      expect(recentEvents.body.cursor).toBeGreaterThan(0);
      const types = recentEvents.body.events.map((e) => e.type);
      expect(types).toContain('task.created');
      expect(types).toContain('tool.executed');
      expect(types).toContain('verification.passed');
      expect(types).toContain('task.completed');
    });
  });

  describe('4. Human Approval Center & Biometric Gate Enforcement', () => {
    it('queues policy `ask` operations, redacts secrets, enforces biometric confirmation for high-risk shell tools, binds argumentsHash, and blocks replay', async () => {
      const mobileCred = await h.state.auth.issueMobileDeviceCredential({
        deviceId: 'approver-phone',
        deviceName: 'Approver Phone',
        scopes: ['read', 'mutate', 'execute'],
      });

      // Submit a task that invokes a shell command requiring policy approval (`npm --version`)
      const submitRes = await jsonReq<{ taskId: string }>(h.baseUrl, 'POST', '/api/v1/mobile/tasks', {
        token: mobileCred.accessToken,
        body: {
          title: 'Run npm version check',
          input: 'Check npm version via shell tool',
          operations: [
            {
              tool: {
                name: 'shell',
                input: {
                  command: 'npm --version',
                  apiKeySecret: 'sk-super-secret-value-1234567890',
                },
              },
            },
          ],
        },
      });
      expect(submitRes.status).toBe(201);
      const taskId = submitRes.body.taskId;

      // Poll until the pending approval appears
      let pendingApproval:
        | {
            id: string;
            tool: string;
            riskClassification: string;
            requiresBiometric: boolean;
            argumentsHash: string;
            redactedArguments: Record<string, unknown>;
          }
        | undefined;
      for (let i = 0; i < 30; i++) {
        const listRes = await jsonReq<{
          approvals: Array<{
            id: string;
            tool: string;
            status: string;
            riskClassification: string;
            requiresBiometric: boolean;
            argumentsHash: string;
            redactedArguments: Record<string, unknown>;
          }>;
        }>(h.baseUrl, 'GET', '/api/v1/mobile/approvals?status=pending', {
          token: mobileCred.accessToken,
        });
        if (listRes.body.approvals?.length) {
          pendingApproval = listRes.body.approvals[0];
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(pendingApproval).toBeDefined();
      expect(pendingApproval!.tool).toBe('shell');
      expect(pendingApproval!.requiresBiometric).toBe(true);
      // Secret argument must be redacted in mobile payload
      expect(pendingApproval!.redactedArguments.apiKeySecret).toBe('[REDACTED]');

      // 1. Attempting to approve high-risk shell operation WITHOUT biometricVerified fails with 403 BIOMETRIC_REQUIRED
      const noBioRes = await jsonReq<{ code: string }>(
        h.baseUrl,
        'POST',
        `/api/v1/mobile/approvals/${pendingApproval!.id}/resolve`,
        {
          token: mobileCred.accessToken,
          body: {
            decision: 'approve',
            argumentsHash: pendingApproval!.argumentsHash,
            biometricVerified: false,
          },
        },
      );
      expect(noBioRes.status).toBe(403);
      expect(noBioRes.body.code).toBe('BIOMETRIC_REQUIRED');

      // 2. Attempting to approve with a mismatched argumentsHash fails with 409 APPROVAL_SCOPE_MISMATCH
      const badHashRes = await jsonReq<{ code: string }>(
        h.baseUrl,
        'POST',
        `/api/v1/mobile/approvals/${pendingApproval!.id}/resolve`,
        {
          token: mobileCred.accessToken,
          body: {
            decision: 'approve',
            argumentsHash: '0000000000000000000000000000000000000000000000000000000000000000',
            biometricVerified: true,
          },
        },
      );
      expect(badHashRes.status).toBe(409);
      expect(badHashRes.body.code).toBe('APPROVAL_SCOPE_MISMATCH');

      // 3. Approving with matching argumentsHash AND biometricVerified=true succeeds
      const approveRes = await jsonReq<{ ok: boolean; approval: { status: string } }>(
        h.baseUrl,
        'POST',
        `/api/v1/mobile/approvals/${pendingApproval!.id}/resolve`,
        {
          token: mobileCred.accessToken,
          body: {
            decision: 'approve',
            argumentsHash: pendingApproval!.argumentsHash,
            biometricVerified: true,
            note: 'Approved via Android BiometricPrompt',
          },
        },
      );
      expect(approveRes.status).toBe(200);
      expect(approveRes.body.approval.status).toBe('approved');

      // 4. Replaying the same approval resolution is rejected with 409 APPROVAL_ALREADY_RESOLVED
      const replayApproval = await jsonReq<{ code: string }>(
        h.baseUrl,
        'POST',
        `/api/v1/mobile/approvals/${pendingApproval!.id}/resolve`,
        {
          token: mobileCred.accessToken,
          body: {
            decision: 'approve',
            argumentsHash: pendingApproval!.argumentsHash,
            biometricVerified: true,
          },
        },
      );
      expect(replayApproval.status).toBe(409);
      expect(replayApproval.body.code).toBe('APPROVAL_ALREADY_RESOLVED');

      // 5. Wait for the unblocked task to finish executing
      let finalTaskState = 'running';
      for (let i = 0; i < 40; i++) {
        const tr = await jsonReq<{ task: { state: string } }>(
          h.baseUrl,
          'GET',
          `/api/v1/mobile/tasks/${taskId}`,
          { token: mobileCred.accessToken },
        );
        if (tr.body.task.state === 'completed' || tr.body.task.state === 'failed') {
          finalTaskState = tr.body.task.state;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(finalTaskState).toBe('completed');
    });
  });

  describe('5. Compute Telemetry & Resource Ledger Emergency Stop', () => {
    it('returns truthful hardware telemetry (null GPU % when unmeasured) and supports emergency stop / resume', async () => {
      const comps = await jsonReq<{
        computers: Array<{
          id: string;
          telemetry: {
            cpuUtilizationPercent: number | null;
            gpuUtilizationPercent: number | null;
          };
        }>;
      }>(h.baseUrl, 'GET', '/api/v1/mobile/computers', { token: OPERATOR_TOKEN });
      expect(comps.status).toBe(200);
      expect(comps.body.computers.length).toBeGreaterThanOrEqual(1);
      // Verify GPU utilization is null when not reported by hardware rather than fabricated
      const localComp = comps.body.computers.find((c) => c.id === 'local');
      expect(localComp).toBeDefined();
      // Null when the host reports no GPU load; a real percentage when it does (hosts with an
      // NVIDIA GPU report one). Either way it must never be a fabricated value.
      const gpuUtil = localComp!.telemetry.gpuUtilizationPercent;
      expect(gpuUtil === null || (gpuUtil >= 0 && gpuUtil <= 100)).toBe(true);

      // Trigger emergency stop on ResourceLedger
      const stopRes = await jsonReq<{
        emergencyStop: { reason: string } | null;
        warnings: Array<{ severity: string; message: string }>;
      }>(h.baseUrl, 'POST', '/api/v1/mobile/resources/emergency-stop', {
        token: OPERATOR_TOKEN,
        body: { reason: 'Budget threshold test' },
      });
      expect(stopRes.status).toBe(200);
      expect(stopRes.body.emergencyStop?.reason).toBe('Budget threshold test');

      // Resume cloud dispatch
      const resumeRes = await jsonReq<{ emergencyStop: null }>(
        h.baseUrl,
        'POST',
        '/api/v1/mobile/resources/resume',
        { token: OPERATOR_TOKEN },
      );
      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.emergencyStop).toBeNull();
    });
  });

  describe('6. Multi-Surface Idempotent Cancellation & Immutable Event Deduplication', () => {
    it('deduplicates replayed events by immutable eventId and handles concurrent cancellation idempotently', async () => {
      // 1. Verify MobileEventHub deduplicates identical eventId
      const hub = h.state.mobile.eventHub;
      const ev1 = await hub.publish({
        eventId: 'mev-dedup-test-1',
        type: 'task.state',
        taskId: 'task-dedup',
        summary: 'Task state update',
        payload: { state: 'running' },
      });
      const ev2 = await hub.publish({
        eventId: 'mev-dedup-test-1',
        type: 'task.state',
        taskId: 'task-dedup',
        summary: 'Duplicate task state update',
        payload: { state: 'running' },
      });
      expect(ev2.sequence).toBe(ev1.sequence);
      const recentForTask = hub.listRecent(20, 'task-dedup');
      expect(recentForTask.filter((e) => e.eventId === 'mev-dedup-test-1')).toHaveLength(1);

      // 2. Verify concurrent cancellation from desktop/operator and mobile is idempotent (200 OK on both)
      const created = await jsonReq<{ taskId: string; task: { taskId: string; state: string } }>(
        h.baseUrl,
        'POST',
        '/api/v1/mobile/tasks',
        {
          token: OPERATOR_TOKEN,
          body: {
            title: 'Task for concurrent cancellation',
            input: 'Run shell check that pauses on approval',
            operations: [
              {
                tool: {
                  name: 'shell',
                  input: { command: 'npm --version' },
                },
              },
            ],
          },
        },
      );
      expect(created.status).toBe(201);
      const cancelTaskId = created.body.taskId;

      const cancel1 = await jsonReq<{ task: { state: string } }>(
        h.baseUrl,
        'POST',
        `/api/v1/mobile/tasks/${cancelTaskId}/cancel`,
        { token: OPERATOR_TOKEN },
      );
      expect(cancel1.status).toBe(200);
      expect(cancel1.body.task.state).toBe('cancelled');

      // Second cancellation from another surface succeeds idempotently instead of 409
      const cancel2 = await jsonReq<{ task: { state: string } }>(
        h.baseUrl,
        'POST',
        `/api/v1/mobile/tasks/${cancelTaskId}/cancel`,
        { token: OPERATOR_TOKEN },
      );
      expect(cancel2.status).toBe(200);
      expect(cancel2.body.task.state).toBe('cancelled');
    });
  });
});

