import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiState, createApp, type ApiState } from '../src/server.js';

/**
 * A paired mobile device credential must be structurally narrower than the operator
 * token: it should never satisfy `isOperatorToken`/`isViewerToken` (which gate every
 * `requireOperator`/`requireViewerOrOperator` route in the whole API — model load/unload,
 * worker admin, computer registration, pairing-session administration, emergency
 * controls), and should only reach mobile mutations/reads through the dedicated
 * `requireOperatorOrDevice`/`requireViewerOperatorOrDevice` middlewares.
 */

const OPERATOR = 'operator-token-0123456789';
const VIEWER = 'viewer-token-0123456789';

async function startServer() {
  const state: ApiState = await createApiState({
    auth: { operatorToken: OPERATOR, viewerToken: VIEWER },
  });
  const app = createApp(state);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { state, server, baseUrl: `http://127.0.0.1:${port}` };
}

function authed(token?: string): RequestInit {
  return token ? { headers: { Authorization: `Bearer ${token}` } } : {};
}

function post(body: unknown, token?: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  };
}

describe('mobile device credential auth boundary', { timeout: 20_000 }, () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a device with mutate scope does not satisfy isOperatorToken/isViewerToken globally', async () => {
    const { state, server } = await startServer();
    servers.push(server);

    const issued = await state.auth.issueMobileDeviceCredential({
      deviceId: 'dev-1',
      deviceName: 'Pixel',
    });
    expect(issued.scopes).toEqual(['read', 'mutate']); // no `execute` by default

    expect(state.auth.isOperatorToken(issued.accessToken)).toBe(false);
    expect(state.auth.isViewerToken(issued.accessToken)).toBe(false);

    const principal = state.auth.principalFor({ headers: { authorization: `Bearer ${issued.accessToken}` } } as any);
    expect(principal?.kind).toBe('mobile-device');
    expect(principal?.scopes).toEqual(['read', 'mutate']);
  });

  it('a device token is rejected by true-operator-only routes (model load, device revoke, pairing admin, emergency-stop)', async () => {
    const { baseUrl, server } = await startServer();
    servers.push(server);

    const create = await fetch(`${baseUrl}/api/v1/mobile/pair/sessions`, post({}, OPERATOR));
    expect(create.status).toBe(201);
    const { sessionId, pairingSecret } = await create.json();

    const claim = await fetch(`${baseUrl}/api/v1/mobile/pair/request`, post({ sessionId, pairingSecret, deviceName: 'Pixel' }));
    expect(claim.status).toBe(202);

    const approve = await fetch(`${baseUrl}/api/v1/mobile/pair/sessions/${sessionId}/approve`, post({}, OPERATOR));
    expect(approve.status).toBe(200);
    const { deviceId } = await approve.json();

    const completed = await (await fetch(`${baseUrl}/api/v1/mobile/pair/complete`, post({ sessionId, pairingSecret }))).json();
    expect(completed.status).toBe('approved');
    const deviceToken = completed.accessToken as string;

    // Operator-only: model lifecycle. This route sits behind the blanket `/api/v1`
    // gate (`requireViewerOrOperator`, no device awareness), which rejects it with 401
    // before the route's own `requireOperator` ever runs.
    const load = await fetch(`${baseUrl}/api/v1/models/does-not-exist/load`, { ...post({}, deviceToken) });
    expect(load.status).toBe(401);

    // These three are mobile.ts's own `requireOperator`-gated routes, registered ahead of
    // the blanket gate, so they're reached directly: a device token is a recognized
    // credential that's simply insufficient, so it's 403 (forbidden), not 401
    // (unauthenticated) — same treatment a viewer token already gets from this middleware.

    // Operator-only: device revocation (even though it's a device route, it's intentionally not device-reachable)
    const revoke = await fetch(`${baseUrl}/api/v1/mobile/devices/${deviceId}`, { method: 'DELETE', ...authed(deviceToken) });
    expect(revoke.status).toBe(403);

    // Operator-only: pairing-session administration
    const sessions = await fetch(`${baseUrl}/api/v1/mobile/pair/sessions`, post({}, deviceToken));
    expect(sessions.status).toBe(403);

    // Operator-only: emergency resource controls
    const stop = await fetch(`${baseUrl}/api/v1/mobile/resources/emergency-stop`, post({}, deviceToken));
    expect(stop.status).toBe(403);
  });

  it('a device with mutate scope can reach mobile task/approval mutations; a read-only device cannot', async () => {
    const { baseUrl, server } = await startServer();
    servers.push(server);

    const create = await fetch(`${baseUrl}/api/v1/mobile/pair/sessions`, post({}, OPERATOR));
    const { sessionId, pairingSecret } = await create.json();
    await fetch(`${baseUrl}/api/v1/mobile/pair/request`, post({ sessionId, pairingSecret, deviceName: 'Pixel' }));
    await fetch(`${baseUrl}/api/v1/mobile/pair/sessions/${sessionId}/approve`, post({}, OPERATOR));
    const completed = await (await fetch(`${baseUrl}/api/v1/mobile/pair/complete`, post({ sessionId, pairingSecret }))).json();
    const mutateToken = completed.accessToken as string;

    const createTask = await fetch(`${baseUrl}/api/v1/mobile/tasks`, post({ input: 'do something' }, mutateToken));
    expect(createTask.status).not.toBe(401);

    const dashboard = await fetch(`${baseUrl}/api/v1/mobile/dashboard`, authed(mutateToken));
    expect(dashboard.status).toBe(200);

    // A read-only device (explicitly scoped) can read but not mutate.
    const readCreate = await fetch(`${baseUrl}/api/v1/mobile/pair/sessions`, post({ scopes: ['read'] }, OPERATOR));
    const readSession = await readCreate.json();
    await fetch(`${baseUrl}/api/v1/mobile/pair/request`, post({ sessionId: readSession.sessionId, pairingSecret: readSession.pairingSecret, deviceName: 'ReadOnlyTablet' }));
    await fetch(`${baseUrl}/api/v1/mobile/pair/sessions/${readSession.sessionId}/approve`, post({}, OPERATOR));
    const readCompleted = await (await fetch(`${baseUrl}/api/v1/mobile/pair/complete`, post({ sessionId: readSession.sessionId, pairingSecret: readSession.pairingSecret }))).json();
    const readToken = readCompleted.accessToken as string;

    const readDashboard = await fetch(`${baseUrl}/api/v1/mobile/dashboard`, authed(readToken));
    expect(readDashboard.status).toBe(200);

    // 403, not 401: the device is authenticated, just lacks `mutate` scope.
    const readOnlyCreateTask = await fetch(`${baseUrl}/api/v1/mobile/tasks`, post({ input: 'do something' }, readToken));
    expect(readOnlyCreateTask.status).toBe(403);
  });

  it('a revoked device token stops working on both read and mutate mobile routes', async () => {
    const { state, baseUrl, server } = await startServer();
    servers.push(server);

    const issued = await state.auth.issueMobileDeviceCredential({ deviceId: 'dev-revoke', deviceName: 'Pixel' });
    const before = await fetch(`${baseUrl}/api/v1/mobile/dashboard`, authed(issued.accessToken));
    expect(before.status).toBe(200);

    await state.auth.revokeMobileDevice('dev-revoke');

    const after = await fetch(`${baseUrl}/api/v1/mobile/dashboard`, authed(issued.accessToken));
    expect(after.status).toBe(401);
  });
});
