import { createHash, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import type { ProtocolScope } from '@wazir/core';
import type { ApiState } from '../server.js';
import {
  CONTROLLER_VERSION,
  MAX_PAIRING_ATTEMPTS,
  MOBILE_API_VERSION,
  PAIRING_TTL_MS,
  safeEqualHex,
  type PairingSessionRecord,
} from './typesAndCompatibility.js';

/**
 * Single-use QR/code pairing workflow protected from replay, brute force, and interception.
 */
export class MobilePairingService {
  private readonly sessions = new Map<string, PairingSessionRecord>();

  constructor(
    private readonly state: ApiState,
    private readonly now: () => number = Date.now,
  ) {}

  async init(): Promise<void> {
    const entries = await this.state.store.list('mobile/pairing/');
    for (const entry of entries) {
      const rec = entry.value as PairingSessionRecord;
      if (rec?.sessionId) {
        this.sessions.set(rec.sessionId, rec);
      }
    }
  }

  private sweepExpired(): void {
    const nowMs = this.now();
    for (const s of this.sessions.values()) {
      if ((s.status === 'waiting_for_device' || s.status === 'pending_operator_approval') && s.expiresAt <= nowMs) {
        s.status = 'expired';
        void this.state.store.put(`mobile/pairing/${s.sessionId}`, s).catch(() => undefined);
      }
    }
  }

  async createSession(params: {
    scopes?: ProtocolScope[];
    controllerUrl?: string;
    tlsCertFingerprint?: string;
    ttlMs?: number;
  } = {}): Promise<{
    sessionId: string;
    pairingSecret: string;
    expiresAt: number;
    scopes: ProtocolScope[];
    qrUri: string;
    controllerName: string;
  }> {
    this.sweepExpired();
    const sessionId = `pair-${randomUUID()}`;
    const pairingSecret = randomBytes(24).toString('base64url');
    const secretHash = createHash('sha256').update(pairingSecret).digest('hex');
    const nowMs = this.now();
    const expiresAt = nowMs + (params.ttlMs ?? PAIRING_TTL_MS);
    // No `execute` by default: a paired phone submits/cancels tasks and decides approvals
    // through these mobile routes, never raw tool execution over /ap/v1 or /mcp. An
    // operator can still widen this explicitly via `params.scopes` on create or approve.
    const scopes: ProtocolScope[] = params.scopes?.length ? [...params.scopes] : ['read', 'mutate'];
    const controllerName = os.hostname() || 'wazir-controller';

    const record: PairingSessionRecord = {
      sessionId,
      secretHash,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt,
      status: 'waiting_for_device',
      attempts: 0,
      scopes,
      controllerUrl: params.controllerUrl,
      tlsCertFingerprint: params.tlsCertFingerprint,
    };

    this.sessions.set(sessionId, record);
    await this.state.store.put(`mobile/pairing/${sessionId}`, record);

    const query = new URLSearchParams({
      sessionId,
      secret: pairingSecret,
      name: controllerName,
      v: MOBILE_API_VERSION,
    });
    if (params.controllerUrl) query.set('url', params.controllerUrl);
    if (params.tlsCertFingerprint) query.set('fp', params.tlsCertFingerprint);

    return {
      sessionId,
      pairingSecret,
      expiresAt,
      scopes,
      qrUri: `wazir://pair?${query.toString()}`,
      controllerName,
    };
  }

  getSession(sessionId: string): Omit<PairingSessionRecord, 'secretHash' | 'issuedCredential'> | undefined {
    this.sweepExpired();
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const { secretHash: _sh, issuedCredential: _ic, ...rest } = s;
    return rest;
  }

  async requestPairing(params: {
    sessionId: string;
    pairingSecret: string;
    deviceId?: string;
    deviceName: string;
    deviceModel?: string;
    osVersion?: string;
    publicKeyFingerprint?: string;
  }): Promise<
    | { ok: true; sessionId: string; status: 'pending_operator_approval'; confirmationCode: string; controllerName: string; expiresAt: number }
    | { ok: false; status: number; code: string; error: string }
  > {
    this.sweepExpired();
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      this.state.auth.recordAuthFailure();
      return { ok: false, status: 404, code: 'PAIRING_SESSION_NOT_FOUND', error: 'Pairing session not found' };
    }
    if (session.status === 'expired' || session.expiresAt <= this.now()) {
      session.status = 'expired';
      await this.state.store.put(`mobile/pairing/${session.sessionId}`, session);
      return { ok: false, status: 410, code: 'PAIRING_SESSION_EXPIRED', error: 'Pairing session has expired' };
    }
    if (session.attempts >= MAX_PAIRING_ATTEMPTS) {
      session.status = 'expired';
      await this.state.store.put(`mobile/pairing/${session.sessionId}`, session);
      this.state.auth.recordAuthFailure();
      return { ok: false, status: 429, code: 'PAIRING_BRUTE_FORCE_LOCKED', error: 'Pairing session invalidated due to too many failed attempts' };
    }
    if (session.status !== 'waiting_for_device') {
      return { ok: false, status: 409, code: 'PAIRING_SESSION_ALREADY_USED', error: `Pairing session is already in state '${session.status}'` };
    }

    const presentedHash = createHash('sha256').update(String(params.pairingSecret ?? '')).digest('hex');
    if (!safeEqualHex(session.secretHash, presentedHash)) {
      session.attempts += 1;
      if (session.attempts >= MAX_PAIRING_ATTEMPTS) {
        session.status = 'expired';
      }
      await this.state.store.put(`mobile/pairing/${session.sessionId}`, session);
      this.state.auth.recordAuthFailure();
      return { ok: false, status: 401, code: 'INVALID_PAIRING_SECRET', error: 'Invalid pairing secret' };
    }

    const num = randomBytes(3).readUIntBE(0, 3) % 1_000_000;
    const digits = String(num).padStart(6, '0');
    const confirmationCode = `${digits.slice(0, 3)}-${digits.slice(3, 6)}`;
    const deviceId = params.deviceId && /^[A-Za-z0-9._-]{4,64}$/.test(params.deviceId)
      ? params.deviceId
      : `dev-${randomUUID()}`;

    session.status = 'pending_operator_approval';
    session.confirmationCode = confirmationCode;
    session.deviceRequest = {
      deviceId,
      deviceName: params.deviceName.trim().slice(0, 80) || 'Android Device',
      deviceModel: params.deviceModel?.slice(0, 80),
      osVersion: params.osVersion?.slice(0, 40),
      publicKeyFingerprint: params.publicKeyFingerprint?.slice(0, 128),
      requestedAt: new Date(this.now()).toISOString(),
    };

    await this.state.store.put(`mobile/pairing/${session.sessionId}`, session);

    return {
      ok: true,
      sessionId: session.sessionId,
      status: 'pending_operator_approval',
      confirmationCode,
      controllerName: os.hostname() || 'wazir-controller',
      expiresAt: session.expiresAt,
    };
  }

  async approveSession(params: {
    sessionId: string;
    confirmationCode?: string;
    scopes?: ProtocolScope[];
  }): Promise<
    | { ok: true; deviceId: string; scopes: ProtocolScope[] }
    | { ok: false; status: number; code: string; error: string }
  > {
    this.sweepExpired();
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return { ok: false, status: 404, code: 'PAIRING_SESSION_NOT_FOUND', error: 'Pairing session not found' };
    }
    if (session.status !== 'pending_operator_approval' || !session.deviceRequest) {
      return {
        ok: false,
        status: 409,
        code: 'PAIRING_NOT_PENDING_APPROVAL',
        error: `Pairing session cannot be approved in state '${session.status}'`,
      };
    }
    if (params.confirmationCode !== undefined) {
      const normalizedExpected = (session.confirmationCode ?? '').replace(/[^0-9]/g, '');
      const normalizedActual = params.confirmationCode.replace(/[^0-9]/g, '');
      if (!normalizedExpected || !safeEqualHex(normalizedExpected, normalizedActual)) {
        session.attempts += 1;
        if (session.attempts >= MAX_PAIRING_ATTEMPTS) session.status = 'expired';
        await this.state.store.put(`mobile/pairing/${session.sessionId}`, session);
        return { ok: false, status: 403, code: 'CONFIRMATION_CODE_MISMATCH', error: 'Confirmation code does not match' };
      }
    }

    const scopes = params.scopes?.length ? params.scopes : session.scopes;
    const issued = await this.state.auth.issueMobileDeviceCredential({
      deviceId: session.deviceRequest.deviceId,
      deviceName: session.deviceRequest.deviceName,
      deviceModel: session.deviceRequest.deviceModel,
      osVersion: session.deviceRequest.osVersion,
      publicKeyFingerprint: session.deviceRequest.publicKeyFingerprint,
      scopes,
    });

    session.status = 'approved';
    session.scopes = scopes;
    session.issuedCredential = {
      deviceId: issued.deviceId,
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt: issued.expiresAt,
      scopes: issued.scopes,
    };
    await this.state.store.put(`mobile/pairing/${session.sessionId}`, session);

    return { ok: true, deviceId: issued.deviceId, scopes: issued.scopes };
  }

  async rejectSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.status = 'rejected';
    delete session.issuedCredential;
    await this.state.store.put(`mobile/pairing/${session.sessionId}`, session);
    return true;
  }

  async completePairing(params: {
    sessionId: string;
    pairingSecret: string;
  }): Promise<
    | {
        ok: true;
        status: 'pending_operator_approval';
        confirmationCode?: string;
        expiresAt: number;
      }
    | {
        ok: true;
        status: 'approved';
        deviceId: string;
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        scopes: ProtocolScope[];
        controller: {
          id: string;
          name: string;
          version: string;
          apiVersion: string;
        };
      }
    | { ok: false; status: number; code: string; error: string }
  > {
    this.sweepExpired();
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      this.state.auth.recordAuthFailure();
      return { ok: false, status: 404, code: 'PAIRING_SESSION_NOT_FOUND', error: 'Pairing session not found' };
    }
    const presentedHash = createHash('sha256').update(String(params.pairingSecret ?? '')).digest('hex');
    if (!safeEqualHex(session.secretHash, presentedHash)) {
      session.attempts += 1;
      if (session.attempts >= MAX_PAIRING_ATTEMPTS) session.status = 'expired';
      await this.state.store.put(`mobile/pairing/${session.sessionId}`, session);
      this.state.auth.recordAuthFailure();
      return { ok: false, status: 401, code: 'INVALID_PAIRING_SECRET', error: 'Invalid pairing secret' };
    }
    if (session.status === 'claimed') {
      this.state.auth.recordAuthFailure();
      return { ok: false, status: 409, code: 'PAIRING_SESSION_ALREADY_CLAIMED', error: 'Pairing credential has already been claimed (replay rejected)' };
    }
    if (session.status === 'rejected') {
      return { ok: false, status: 403, code: 'PAIRING_REJECTED', error: 'Pairing request was rejected by the operator' };
    }
    if (session.status === 'expired' || session.expiresAt <= this.now()) {
      return { ok: false, status: 410, code: 'PAIRING_SESSION_EXPIRED', error: 'Pairing session has expired' };
    }
    if (session.status === 'pending_operator_approval') {
      return {
        ok: true,
        status: 'pending_operator_approval',
        confirmationCode: session.confirmationCode,
        expiresAt: session.expiresAt,
      };
    }
    if (session.status === 'approved' && session.issuedCredential) {
      const credential = session.issuedCredential;
      // Single-use: wipe plaintext tokens from the pairing record and mark claimed immediately
      session.status = 'claimed';
      delete session.issuedCredential;
      await this.state.store.put(`mobile/pairing/${session.sessionId}`, session);

      const localId = process.env.WAZIR_COMPUTER_ID ?? 'local';
      return {
        ok: true,
        status: 'approved',
        deviceId: credential.deviceId,
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAt: credential.expiresAt,
        scopes: credential.scopes,
        controller: {
          id: localId,
          name: os.hostname() || localId,
          version: CONTROLLER_VERSION,
          apiVersion: MOBILE_API_VERSION,
        },
      };
    }
    return { ok: false, status: 409, code: 'PAIRING_INVALID_STATE', error: `Unexpected pairing state '${session.status}'` };
  }
}
