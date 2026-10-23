import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '@wazir/shared';
import { createApiState, createApp, type ApiState } from '../src/server.js';
import { ApiAuth } from '../src/auth.js';
import {
  CONTROLLER_VERSION,
  MIN_MOBILE_APP_VERSION,
  MOBILE_PROTOCOL_VERSION,
  evaluateMobileCompatibility,
} from '../src/mobile.js';
import { wazirVersion } from '../src/version.js';
import { detectDefaultAdvertiseHttpsUrl } from '../../cli/src/mobile.js';

const OPERATOR_TOKEN = 'op-secret-phase4-mobile-test-token';
const VIEWER_TOKEN = 'vw-secret-phase4-mobile-test-token';

interface TestHarness {
  workspace: string;
  state: ApiState;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<TestHarness> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-phase4-mobile-'));
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'phase4-mobile-fixture', version: '1.0.0' }, null, 2),
  );
  const store = new MemoryStore();
  const state = await createApiState({
    store,
    projectRoot: workspace,
    auditPath: path.join(workspace, 'audit.jsonl'),
    enableMobileApprovals: true,
    auth: {
      operatorToken: OPERATOR_TOKEN,
      viewerToken: VIEWER_TOKEN,
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
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

describe('Phase 4 (ISS-016): Mobile Version Reporting, Protocol Negotiation, and Credential Rotation', () => {
  describe('1. Dynamic Controller Version Resolution', () => {
    it('resolves CONTROLLER_VERSION dynamically from root package.json and never drifts to 0.1.63', () => {
      const rootPkgPath = path.resolve(__dirname, '../../../package.json');
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8')) as { version: string };

      expect(CONTROLLER_VERSION).toBe(rootPkg.version);
      expect(CONTROLLER_VERSION).toBe(wazirVersion());
      expect(CONTROLLER_VERSION).not.toBe('0.1.63');
      expect(MIN_MOBILE_APP_VERSION).toBe('0.1.0');
      expect(MOBILE_PROTOCOL_VERSION).toBe('1.0.0');
    });
  });

  describe('2. evaluateMobileCompatibility Unit Verification', () => {
    it('accepts compatible client versions (0.2.12, 0.1.0) and default omission', () => {
      const def = evaluateMobileCompatibility();
      expect(def.compatible).toBe(true);
      expect(def.controllerVersion).toBe(CONTROLLER_VERSION);
      expect(def.minMobileAppVersion).toBe(MIN_MOBILE_APP_VERSION);
      expect(def.protocolVersion).toBe(MOBILE_PROTOCOL_VERSION);

      const exact = evaluateMobileCompatibility({ clientVersion: '0.2.12', protocolVersion: '1.0.0' });
      expect(exact.compatible).toBe(true);
      expect(exact.upgradeRequired).toBeUndefined();

      const minSupported = evaluateMobileCompatibility({ clientVersion: '0.1.0', protocolVersion: 1 });
      expect(minSupported.compatible).toBe(true);
      expect(minSupported.upgradeRequired).toBeUndefined();
    });

    it('rejects too-old client version (0.0.1) with upgradeRequired=client', () => {
      const res = evaluateMobileCompatibility({ clientVersion: '0.0.1' });
      expect(res.compatible).toBe(false);
      expect(res.upgradeRequired).toBe('client');
      expect(res.code).toBe('CLIENT_UPGRADE_REQUIRED');
      expect(res.reason).toContain('0.0.1');
    });

    it('rejects future/incompatible client versions (99.0.0, 0.99.0) with upgradeRequired=controller', () => {
      const majorFuture = evaluateMobileCompatibility({ clientVersion: '99.0.0' });
      expect(majorFuture.compatible).toBe(false);
      expect(majorFuture.upgradeRequired).toBe('controller');
      expect(majorFuture.code).toBe('CONTROLLER_UPGRADE_REQUIRED');
      expect(majorFuture.reason).toContain('99.0.0');

      const minorFuture = evaluateMobileCompatibility({ clientVersion: '0.99.0' });
      expect(minorFuture.compatible).toBe(false);
      expect(minorFuture.upgradeRequired).toBe('controller');
      expect(minorFuture.code).toBe('CONTROLLER_UPGRADE_REQUIRED');
      expect(minorFuture.reason).toContain('0.99.0');
    });

    it('rejects malformed semver strings and incompatible protocol versions (999)', () => {
      const badSemver = evaluateMobileCompatibility({ clientVersion: 'not-a-semver' });
      expect(badSemver.compatible).toBe(false);
      expect(badSemver.upgradeRequired).toBe('client');
      expect(badSemver.code).toBe('INVALID_CLIENT_VERSION');

      const badProto = evaluateMobileCompatibility({ clientVersion: '0.2.12', protocolVersion: 999 });
      expect(badProto.compatible).toBe(false);
      expect(badProto.code).toBe('INCOMPATIBLE_PROTOCOL_VERSION');
      expect(badProto.reason).toContain('999');
    });
  });

  describe('3. GET /api/v1/mobile/handshake Endpoint Negotiation', () => {
    let h: TestHarness;

    beforeEach(async () => {
      h = await startHarness();
    });

    afterEach(async () => {
      await h.close();
    });

    it('negotiates compatible and incompatible client/protocol versions over HTTP', async () => {
      // 1. Default handshake (no clientVersion/protocolVersion headers)
      const defaultRes = await jsonReq<{
        compatible: boolean;
        controllerVersion: string;
        protocolVersion: string;
        minMobileAppVersion: string;
      }>(h.baseUrl, 'GET', '/api/v1/mobile/handshake', { token: OPERATOR_TOKEN });
      expect(defaultRes.status).toBe(200);
      expect(defaultRes.body.compatible).toBe(true);
      expect(defaultRes.body.controllerVersion).toBe(CONTROLLER_VERSION);
      expect(defaultRes.body.protocolVersion).toBe(MOBILE_PROTOCOL_VERSION);
      expect(defaultRes.body.minMobileAppVersion).toBe(MIN_MOBILE_APP_VERSION);

      // 2. Compatible client versions (0.2.12 and 0.1.0)
      for (const ver of ['0.2.12', '0.1.0']) {
        const compatRes = await jsonReq<{ compatible: boolean; clientVersion: string }>(
          h.baseUrl,
          'GET',
          '/api/v1/mobile/handshake',
          {
            token: OPERATOR_TOKEN,
            headers: { 'X-Wazir-Mobile-Version': ver },
          },
        );
        expect(compatRes.status).toBe(200);
        expect(compatRes.body.compatible).toBe(true);
        expect(compatRes.body.clientVersion).toBe(ver);
      }

      // 3. Too-old client version (0.0.1) -> compatible: false, upgradeRequired: 'client'
      const oldRes = await jsonReq<{
        compatible: boolean;
        upgradeRequired: string;
        reason: string;
      }>(h.baseUrl, 'GET', '/api/v1/mobile/handshake?clientVersion=0.0.1', {
        token: OPERATOR_TOKEN,
      });
      expect(oldRes.body.compatible).toBe(false);
      expect(oldRes.body.upgradeRequired).toBe('client');
      expect(oldRes.body.reason).toContain('0.0.1');

      // 4. Future client versions (99.0.0 and 0.99.0) -> compatible: false, upgradeRequired: 'controller'
      for (const futureVer of ['99.0.0', '0.99.0']) {
        const futureRes = await jsonReq<{
          compatible: boolean;
          upgradeRequired: string;
          reason: string;
        }>(h.baseUrl, 'GET', '/api/v1/mobile/handshake', {
          token: OPERATOR_TOKEN,
          headers: { 'X-Wazir-Client-Version': futureVer },
        });
        expect(futureRes.body.compatible).toBe(false);
        expect(futureRes.body.upgradeRequired).toBe('controller');
        expect(futureRes.body.reason).toContain(futureVer);
      }

      // 5. Incompatible protocol version (999) -> compatible: false
      const protoRes = await jsonReq<{
        compatible: boolean;
        reason: string;
      }>(h.baseUrl, 'GET', '/api/v1/mobile/handshake', {
        token: OPERATOR_TOKEN,
        headers: {
          'X-Wazir-Mobile-Version': '0.2.12',
          'X-Wazir-Protocol-Version': '999',
        },
      });
      expect(protoRes.body.compatible).toBe(false);
      expect(protoRes.body.reason).toContain('999');

      // 6. Strict mode returns HTTP 426 Upgrade Required
      const strictRes = await jsonReq<{ compatible: boolean; upgradeRequired: string }>(
        h.baseUrl,
        'GET',
        '/api/v1/mobile/handshake?clientVersion=0.0.1&strict=1',
        { token: OPERATOR_TOKEN },
      );
      expect(strictRes.status).toBe(426);
      expect(strictRes.body.compatible).toBe(false);
      expect(strictRes.body.upgradeRequired).toBe('client');
    });
  });

  describe('4. Expired Credential Check in rotateMobileDeviceCredential', () => {
    it('rejects rotation when mobile credential is expired (expiresAt <= nowMs)', async () => {
      let currentNow = 1_700_000_000_000;
      const store = new MemoryStore();
      const auth = new ApiAuth({
        operatorToken: OPERATOR_TOKEN,
        store,
        now: () => currentNow,
      });

      const issued = await auth.issueMobileDeviceCredential({
        deviceId: 'expiring-phone',
        deviceName: 'Expiring Phone',
        ttlMs: 1_000,
      });
      expect(issued.expiresAt).toBe(currentNow + 1_000);

      // Advance clock to exact expiration boundary (expiresAt <= nowMs)
      currentNow += 1_000;
      const rotatedAtBoundary = await auth.rotateMobileDeviceCredential(issued.refreshToken);
      expect(rotatedAtBoundary).toBeUndefined();

      // Advance clock past expiration
      currentNow += 5_000;
      const rotatedAfterExpiry = await auth.rotateMobileDeviceCredential(issued.refreshToken);
      expect(rotatedAfterExpiry).toBeUndefined();
    });

    it('returns HTTP 401 on POST /api/v1/mobile/auth/rotate when credential has expired', async () => {
      const h = await startHarness();
      try {
        const issued = await h.state.auth.issueMobileDeviceCredential({
          deviceId: 'expired-http-phone',
          deviceName: 'Expired HTTP Phone',
          ttlMs: -100, // already expired relative to now
        });

        const res = await jsonReq<{ code: string; error: string }>(
          h.baseUrl,
          'POST',
          '/api/v1/mobile/auth/rotate',
          { body: { refreshToken: issued.refreshToken } },
        );
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
      } finally {
        await h.close();
      }
    });
  });

  describe('5. Scheme Preservation in detectDefaultAdvertiseHttpsUrl', () => {
    it('preserves http:// scheme for plain HTTP local/LAN URLs and https:// for TLS URLs', () => {
      const prevAdv = process.env.WAZIR_ADVERTISE_URL;
      const prevCert = process.env.WAZIR_TLS_CERT;
      const prevKey = process.env.WAZIR_TLS_KEY;
      try {
        delete process.env.WAZIR_ADVERTISE_URL;
        delete process.env.WAZIR_TLS_CERT;
        delete process.env.WAZIR_TLS_KEY;

        const httpLoopback = detectDefaultAdvertiseHttpsUrl('http://127.0.0.1:4800');
        expect(httpLoopback.startsWith('http://')).toBe(true);
        expect(httpLoopback.startsWith('https://')).toBe(false);

        const httpLan = detectDefaultAdvertiseHttpsUrl('http://192.168.1.50:4800/');
        expect(httpLan).toBe('http://192.168.1.50:4800');

        const httpsLoopback = detectDefaultAdvertiseHttpsUrl('https://127.0.0.1:4800');
        expect(httpsLoopback.startsWith('https://')).toBe(true);

        const explicit = detectDefaultAdvertiseHttpsUrl('http://127.0.0.1:4800', 'http://10.0.0.15:4800/');
        expect(explicit).toBe('http://10.0.0.15:4800');
      } finally {
        if (prevAdv !== undefined) process.env.WAZIR_ADVERTISE_URL = prevAdv;
        else delete process.env.WAZIR_ADVERTISE_URL;
        if (prevCert !== undefined) process.env.WAZIR_TLS_CERT = prevCert;
        else delete process.env.WAZIR_TLS_CERT;
        if (prevKey !== undefined) process.env.WAZIR_TLS_KEY = prevKey;
        else delete process.env.WAZIR_TLS_KEY;
      }
    });
  });
});
