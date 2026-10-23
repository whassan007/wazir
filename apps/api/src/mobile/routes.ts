import os from 'node:os';
import type { Express } from 'express';
import type { ProtocolPrincipal, ProtocolScope } from '@wazir/core';
import type { ApiState } from '../server.js';
import { registerMultiSurfaceRoutes } from '../multiSurface.js';
import type { MobileServices } from '../mobile.js';
import {
  CONTROLLER_VERSION,
  evaluateMobileCompatibility,
  MIN_MOBILE_APP_VERSION,
  MIN_SUPPORTED_MOBILE_VERSION,
  MOBILE_API_VERSION,
  MOBILE_PROTOCOL_VERSION,
} from './typesAndCompatibility.js';

export function registerMobileRoutes(app: Express, state: ApiState, mobile: MobileServices): void {
  const { auth } = state;

  // 1. Public pairing endpoints (rate-limited & single-use secret gated)
  app.post('/api/v1/mobile/pair/request', async (req, res) => {
    const { sessionId, pairingSecret, deviceId, deviceName, deviceModel, osVersion, publicKeyFingerprint } = req.body ?? {};
    if (!sessionId || !pairingSecret || !deviceName) {
      res.status(400).json({ error: 'sessionId, pairingSecret, and deviceName are required', code: 'INVALID_REQUEST' });
      return;
    }
    const result = await mobile.pairing.requestPairing({
      sessionId: String(sessionId),
      pairingSecret: String(pairingSecret),
      deviceId: typeof deviceId === 'string' ? deviceId : undefined,
      deviceName: String(deviceName),
      deviceModel: typeof deviceModel === 'string' ? deviceModel : undefined,
      osVersion: typeof osVersion === 'string' ? osVersion : undefined,
      publicKeyFingerprint: typeof publicKeyFingerprint === 'string' ? publicKeyFingerprint : undefined,
    });
    if ('error' in result) {
      res.status(Number(result.status)).json({ error: result.error, code: result.code });
      return;
    }
    res.status(202).json(result);
  });

  app.post('/api/v1/mobile/pair/complete', async (req, res) => {
    const { sessionId, pairingSecret } = req.body ?? {};
    if (!sessionId || !pairingSecret) {
      res.status(400).json({ error: 'sessionId and pairingSecret are required', code: 'INVALID_REQUEST' });
      return;
    }
    const result = await mobile.pairing.completePairing({
      sessionId: String(sessionId),
      pairingSecret: String(pairingSecret),
    });
    if ('error' in result) {
      res.status(Number(result.status)).json({ error: result.error, code: result.code });
      return;
    }
    res.status(result.status === 'approved' ? 200 : 202).json(result);
  });

  app.post('/api/v1/mobile/auth/rotate', async (req, res) => {
    const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
    if (!refreshToken) {
      res.status(400).json({ error: 'refreshToken is required', code: 'INVALID_REQUEST' });
      return;
    }
    const rotated = await auth.rotateMobileDeviceCredential(refreshToken);
    if (!rotated) {
      auth.recordAuthFailure();
      res.status(401).json({ error: 'Invalid or revoked refresh token', code: 'INVALID_REFRESH_TOKEN' });
      return;
    }
    res.json({
      ok: true,
      deviceId: rotated.deviceId,
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      expiresAt: rotated.expiresAt,
      scopes: rotated.scopes,
    });
  });

  // 2. Operator pairing session management (used by `wa mobile pair` CLI)
  app.post('/api/v1/mobile/pair/sessions', auth.requireOperator, async (req, res) => {
    const scopes = Array.isArray(req.body?.scopes) ? (req.body.scopes as ProtocolScope[]) : undefined;
    const controllerUrl = typeof req.body?.controllerUrl === 'string' ? req.body.controllerUrl : undefined;
    const tlsCertFingerprint = typeof req.body?.tlsCertFingerprint === 'string' ? req.body.tlsCertFingerprint : undefined;
    const session = await mobile.pairing.createSession({ scopes, controllerUrl, tlsCertFingerprint });
    res.status(201).json(session);
  });

  app.get('/api/v1/mobile/pair/sessions/:id', auth.requireOperator, (req, res) => {
    const session = mobile.pairing.getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: 'Pairing session not found', code: 'PAIRING_SESSION_NOT_FOUND' });
      return;
    }
    res.json(session);
  });

  app.post('/api/v1/mobile/pair/sessions/:id/approve', auth.requireOperator, async (req, res) => {
    const result = await mobile.pairing.approveSession({
      sessionId: String(req.params.id),
      confirmationCode: typeof req.body?.confirmationCode === 'string' ? req.body.confirmationCode : undefined,
      scopes: Array.isArray(req.body?.scopes) ? (req.body.scopes as ProtocolScope[]) : undefined,
    });
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.json(result);
  });

  app.post('/api/v1/mobile/pair/sessions/:id/reject', auth.requireOperator, async (req, res) => {
    const ok = await mobile.pairing.rejectSession(String(req.params.id));
    if (!ok) {
      res.status(404).json({ error: 'Pairing session not found', code: 'PAIRING_SESSION_NOT_FOUND' });
      return;
    }
    res.json({ ok: true });
  });

  // 3. Authenticated mobile device management & version handshake
  app.get('/api/v1/mobile/handshake', auth.requireProtocolPrincipal, (req, res) => {
    const headerClientVersion =
      typeof req.headers['x-wazir-mobile-version'] === 'string'
        ? req.headers['x-wazir-mobile-version']
        : typeof req.headers['x-wazir-client-version'] === 'string'
          ? req.headers['x-wazir-client-version']
          : undefined;
    const queryClientVersion = typeof req.query.clientVersion === 'string' ? req.query.clientVersion : undefined;
    const rawClientVersion = headerClientVersion ?? queryClientVersion;

    const headerProtocolVersion =
      typeof req.headers['x-wazir-protocol-version'] === 'string'
        ? req.headers['x-wazir-protocol-version']
        : undefined;
    const queryProtocolVersion =
      typeof req.query.protocolVersion === 'string' ? req.query.protocolVersion : undefined;
    const rawProtocolVersion = headerProtocolVersion ?? queryProtocolVersion;

    const compatibility = evaluateMobileCompatibility({
      clientVersion: rawClientVersion,
      protocolVersion: rawProtocolVersion,
    });

    const principal = res.locals.principal as ProtocolPrincipal;
    const strict =
      req.query.strict === '1' ||
      req.query.strict === 'true' ||
      req.headers['x-wazir-strict-handshake'] === '1';
    const statusCode = !compatibility.compatible && strict ? 426 : 200;

    res.status(statusCode).json({
      compatible: compatibility.compatible,
      ...(compatibility.upgradeRequired ? { upgradeRequired: compatibility.upgradeRequired } : {}),
      ...(compatibility.reason ? { reason: compatibility.reason } : {}),
      ...(compatibility.code ? { code: compatibility.code } : {}),
      apiVersion: MOBILE_API_VERSION,
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      minMobileVersion: MIN_SUPPORTED_MOBILE_VERSION,
      minMobileAppVersion: MIN_MOBILE_APP_VERSION,
      controllerVersion: CONTROLLER_VERSION,
      clientVersion: compatibility.clientVersion,
      ...(compatibility.requestedProtocolVersion
        ? { requestedProtocolVersion: compatibility.requestedProtocolVersion }
        : {}),
      controllerId: process.env.WAZIR_COMPUTER_ID ?? 'local',
      hostname: os.hostname(),
      principal: {
        id: principal.id,
        kind: principal.kind,
        scopes: principal.scopes,
      },
      features: {
        sseEvents: true,
        durableApprovals: true,
        biometricHighRiskApprovals: true,
        modelLifecycle: true,
        resourceLedger: true,
        multiController: true,
      },
    });
  });

  app.post('/api/v1/mobile/auth/unpair', auth.requireProtocolPrincipal, async (_req, res) => {
    const principal = res.locals.principal as ProtocolPrincipal;
    if (principal.id.startsWith('mobile:')) {
      const deviceId = principal.id.slice('mobile:'.length);
      await auth.revokeMobileDevice(deviceId);
      res.json({ ok: true, revokedDeviceId: deviceId });
      return;
    }
    res.json({ ok: true });
  });

  // Operator-only, deliberately not device-reachable: this lists every paired device
  // (names, scopes, last-seen) — a phone must not be able to enumerate other phones
  // paired to the same controller.
  app.get('/api/v1/mobile/devices', auth.requireViewerOrOperator, (_req, res) => {
    res.json({ devices: auth.listMobileDevices() });
  });

  app.delete('/api/v1/mobile/devices/:deviceId', auth.requireOperator, async (req, res) => {
    const revoked = await auth.revokeMobileDevice(String(req.params.deviceId));
    if (!revoked) {
      res.status(404).json({ error: `Device '${req.params.deviceId}' not found`, code: 'DEVICE_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, deviceId: req.params.deviceId });
  });

  // 4. Dashboard & Live Event Stream
  app.get('/api/v1/mobile/dashboard', auth.requireViewerOperatorOrDevice, async (_req, res) => {
    res.json(await mobile.getDashboardSnapshot());
  });

  app.get('/api/v1/mobile/events', auth.requireViewerOperatorOrDevice, (req, res) => {
    mobile.eventHub.subscribeSse(req, res);
  });

  app.get('/api/v1/mobile/events/recent', auth.requireViewerOperatorOrDevice, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : undefined;
    res.json({
      cursor: mobile.eventHub.latestCursor,
      events: mobile.eventHub.listRecent(limit, taskId),
    });
  });

  // 5. Task Management & Submission
  app.get('/api/v1/mobile/tasks', auth.requireViewerOperatorOrDevice, async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const tasks = await mobile.listAllTasks(status);
    res.json({ tasks, timestamp: new Date().toISOString() });
  });

  app.get('/api/v1/mobile/tasks/:id', auth.requireViewerOperatorOrDevice, async (req, res) => {
    const detail = await mobile.getTaskDetail(String(req.params.id));
    if (!detail) {
      res.status(404).json({ error: `Task '${req.params.id}' not found`, code: 'TASK_NOT_FOUND' });
      return;
    }
    res.json({ task: detail });
  });

  app.get('/api/v1/mobile/tasks/:id/logs', auth.requireViewerOperatorOrDevice, async (req, res) => {
    const detail = await mobile.getTaskDetail(String(req.params.id));
    if (!detail) {
      res.status(404).json({ error: `Task '${req.params.id}' not found`, code: 'TASK_NOT_FOUND' });
      return;
    }
    res.json({ taskId: detail.taskId, logs: detail.logs });
  });

  app.post('/api/v1/mobile/tasks', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, async (req, res) => {
    const principal = res.locals.principal as ProtocolPrincipal;
    const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
      ? req.headers['idempotency-key'].trim()
      : typeof req.body?.idempotencyKey === 'string'
        ? req.body.idempotencyKey.trim()
        : undefined;
    const result = await mobile.submitTask(req.body ?? {}, principal, idempotencyKey);
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.status(result.duplicate ? 200 : 201).json({
      taskId: result.task.taskId,
      duplicate: result.duplicate,
      task: result.task,
    });
  });

  app.post('/api/v1/mobile/tasks/:id/cancel', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, async (req, res) => {
    const principal = res.locals.principal as ProtocolPrincipal;
    const result = await mobile.cancelTask(String(req.params.id), principal.id);
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.json({ ok: true, task: result.task });
  });

  app.post('/api/v1/mobile/tasks/:id/retry', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, async (req, res) => {
    const principal = res.locals.principal as ProtocolPrincipal;
    const result = await mobile.retryTask(String(req.params.id), principal);
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.status(201).json({ ok: true, task: result.task });
  });

  app.post('/api/v1/mobile/tasks/:id/resume', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, async (req, res) => {
    const principal = res.locals.principal as ProtocolPrincipal;
    const result = await mobile.resumeTask(String(req.params.id), principal.id);
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.json({ ok: true, task: result.task });
  });

  // 6. Human Approval Center
  app.get('/api/v1/mobile/approvals', auth.requireViewerOperatorOrDevice, (req, res) => {
    const status = typeof req.query.status === 'string'
      ? (req.query.status as 'pending' | 'approved' | 'rejected' | 'expired')
      : undefined;
    res.json({
      approvals: mobile.approvals.list(status),
      pendingCount: mobile.approvals.pendingCount,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/v1/mobile/approvals/:id', auth.requireViewerOperatorOrDevice, (req, res) => {
    const approval = mobile.approvals.get(String(req.params.id));
    if (!approval) {
      res.status(404).json({ error: `Approval '${req.params.id}' not found`, code: 'APPROVAL_NOT_FOUND' });
      return;
    }
    res.json({ approval });
  });

  app.post('/api/v1/mobile/approvals/:id/resolve', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, async (req, res) => {
    const principal = res.locals.principal as ProtocolPrincipal;
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      res.status(400).json({ error: "decision must be 'approve' or 'reject'", code: 'INVALID_DECISION' });
      return;
    }
    const result = await mobile.approvals.resolveApproval({
      id: String(req.params.id),
      decision,
      argumentsHash: typeof req.body?.argumentsHash === 'string' ? req.body.argumentsHash : undefined,
      taskId: typeof req.body?.taskId === 'string' ? req.body.taskId : undefined,
      biometricVerified: req.body?.biometricVerified === true,
      resolvedBy: principal.id,
      note: typeof req.body?.note === 'string' ? req.body.note : undefined,
    });
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.json({ ok: true, approval: result.approval });
  });

  // 7. Compute & Workers Telemetry
  app.get('/api/v1/mobile/computers', auth.requireViewerOperatorOrDevice, async (_req, res) => {
    res.json(await mobile.getComputersAndWorkers());
  });

  app.get('/api/v1/mobile/computers/:id', auth.requireViewerOperatorOrDevice, async (req, res) => {
    const snapshot = await mobile.getComputersAndWorkers();
    const computer = snapshot.computers.find((c) => c.id === req.params.id);
    if (!computer) {
      res.status(404).json({ error: `Computer '${req.params.id}' not found`, code: 'COMPUTER_NOT_FOUND' });
      return;
    }
    res.json({ computer });
  });

  // 8. Resource & Subscription Budgets
  app.get('/api/v1/mobile/resources', auth.requireViewerOperatorOrDevice, (_req, res) => {
    res.json(mobile.getResourceSnapshot());
  });

  // Operator-only, deliberately not device-reachable: a stolen mutate-scoped device
  // credential must not be able to halt every dispatch cluster-wide with no extra
  // confirmation. Unlike approval decisions, this action has no biometric/argument-hash
  // binding to fall back on, so it stays behind the real operator token.
  app.post('/api/v1/mobile/resources/emergency-stop', auth.requireOperator, async (req, res) => {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim()
      : 'Triggered remotely from Wazir Mobile';
    mobile.budget.emergencyStop(reason);
    await mobile.eventHub.publish({
      type: 'resource.emergency_stop',
      status: 'stopped',
      summary: `Emergency stop activated: ${reason}`,
      payload: { reason },
    });
    res.json(mobile.getResourceSnapshot());
  });

  app.post('/api/v1/mobile/resources/resume', auth.requireOperator, async (_req, res) => {
    mobile.budget.resume();
    await mobile.eventHub.publish({
      type: 'resource.resumed',
      status: 'normal',
      summary: 'Cloud dispatch resumed from Wazir Mobile',
      payload: {},
    });
    res.json(mobile.getResourceSnapshot());
  });

  // 9. Unified Multi-Surface Routes (Verifiable Artifacts, Diff Review, Autonomy Posture, Host Switching, Schedules)
  registerMultiSurfaceRoutes(app, state, mobile, mobile.multiSurface);
}
