import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Control-plane authentication.
 *
 * Two independent credentials (security review F-1/F-2/F-3):
 *
 * - **Operator token** (`WAZIR_API_TOKEN`): protects every `/api/v1/*` route
 *   and `/executions` — the routes that dispatch work, read results and
 *   record history. Optional for a loopback-only development instance; the
 *   server refuses to bind a non-loopback address without it unless
 *   `WAZIR_ALLOW_UNAUTHENTICATED=1` is set explicitly.
 *
 * - **Per-computer token**: issued to a worker when it registers and
 *   required on every `/computers/:id/*` call afterwards, so only the
 *   process that registered `id` can receive its task stream, heartbeat for
 *   it, or post results into its execution channels. A cluster-wide
 *   **registration token** (`WAZIR_REGISTRATION_TOKEN`) gates who may
 *   register a new id or replace an existing registration.
 */
import type { KeyValueStore } from '@wazir/shared';
import type { ProtocolPrincipal, ProtocolScope } from '@wazir/core';

export interface MobileDeviceRecord {
  deviceId: string;
  deviceName: string;
  deviceModel?: string;
  osVersion?: string;
  publicKeyFingerprint?: string;
  tokenHash: string;
  refreshTokenHash: string;
  scopes: ProtocolScope[];
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  lastSeenAt?: string;
  revoked?: boolean;
  revokedAt?: string;
}

export interface IssuedMobileCredential {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: ProtocolScope[];
  device: Omit<MobileDeviceRecord, 'tokenHash' | 'refreshTokenHash'>;
}

const DEFAULT_MOBILE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Control-plane authentication and RBAC.
 *
 * Credentials:
 * - **Operator token** (`WAZIR_API_TOKEN`): full access to dispatch, execute, and inspect.
 *   Mandatory by default unless `WAZIR_ALLOW_UNAUTHENTICATED=1`.
 * - **Viewer token** (`WAZIR_API_VIEWER_TOKEN`): read-only access to inspect inventory,
 *   history, runtimes, and status. Denied on dispatch and execution mutations.
 * - **Registration token** (`WAZIR_REGISTRATION_TOKEN`): authorizes registering new compute nodes.
 * - **Per-computer tokens**: issued to workers upon registration. SHA-256 hashes are persisted
 *   in `KeyValueStore` so workers survive API restarts without re-registering.
 * - **Per-device mobile tokens**: issued via operator-approved pairing sessions, scoped per
 *   device (defaults to `read`+`mutate`; `execute` is never granted by default), expirable,
 *   rotatable, and revocable. Structurally narrower than the operator token: `isOperatorToken`/
 *   `isViewerToken` never match a device credential, so a device can only reach routes gated
 *   by the dedicated `requireOperatorOrDevice`/`requireViewerOperatorOrDevice` middlewares.
 */
export interface ApiAuthOptions {
  operatorToken?: string;
  viewerToken?: string;
  registrationToken?: string;
  allowUnauthenticated?: boolean;
  store?: KeyValueStore;
  now?: () => number;
}

export class ApiAuth {
  readonly operatorToken?: string;
  readonly viewerToken?: string;
  readonly registrationToken?: string;
  readonly allowUnauthenticated: boolean;
  private readonly store?: KeyValueStore;
  private readonly now: () => number;
  private readonly computerTokenHashes = new Map<string, string>();
  private readonly mobileDevices = new Map<string, MobileDeviceRecord>();
  private authFailureCount = 0;

  constructor(options: ApiAuthOptions = {}) {
    this.operatorToken = options.operatorToken || undefined;
    this.viewerToken = options.viewerToken || undefined;
    this.registrationToken = options.registrationToken || undefined;
    this.allowUnauthenticated = options.allowUnauthenticated ?? (process.env.WAZIR_ALLOW_UNAUTHENTICATED === '1');
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  get authFailures(): number {
    return this.authFailureCount;
  }

  recordAuthFailure(): void {
    this.authFailureCount++;
  }

  get isAllowedUnauthenticated(): boolean {
    return this.allowUnauthenticated;
  }

  get operatorTokenRequired(): boolean {
    return !this.allowUnauthenticated || this.operatorToken !== undefined;
  }

  get viewerTokenRequired(): boolean {
    return !this.allowUnauthenticated || this.viewerToken !== undefined;
  }

  /**
   * Loads stored computer token hashes and paired mobile device credentials so registered
   * workers and paired phones survive API restarts.
   */
  async init(): Promise<void> {
    if (!this.store) return;
    const entries = await this.store.list('auth:computer:');
    for (const entry of entries) {
      const val = entry.value as { hash?: string; computerId?: string };
      const id = val?.computerId ?? entry.key.replace(/^auth:computer:/, '');
      if (val?.hash) {
        this.computerTokenHashes.set(id, val.hash);
      }
    }
    const mobileEntries = await this.store.list('auth:mobile:device:');
    for (const entry of mobileEntries) {
      const record = entry.value as MobileDeviceRecord | undefined;
      if (record?.deviceId && record.tokenHash) {
        this.mobileDevices.set(record.deviceId, record);
      }
    }
  }

  /**
   * Mints a new scoped mobile device credential and stores only SHA-256 token hashes.
   */
  async issueMobileDeviceCredential(params: {
    deviceId: string;
    deviceName: string;
    deviceModel?: string;
    osVersion?: string;
    publicKeyFingerprint?: string;
    scopes?: ProtocolScope[];
    ttlMs?: number;
  }): Promise<IssuedMobileCredential> {
    const accessToken = `mob_at_${randomBytes(32).toString('hex')}`;
    const refreshToken = `mob_rt_${randomBytes(32).toString('hex')}`;
    const tokenHash = createHash('sha256').update(accessToken).digest('hex');
    const refreshTokenHash = createHash('sha256').update(refreshToken).digest('hex');
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = nowMs + (params.ttlMs ?? DEFAULT_MOBILE_TOKEN_TTL_MS);
    // A paired phone defaults to read+mutate (submit/cancel tasks, decide approvals) and
    // never `execute` — raw tool execution over /ap/v1 or /mcp stays operator-only. An
    // operator may still widen this explicitly via `params.scopes` if they choose to.
    const scopes: ProtocolScope[] = params.scopes?.length ? [...params.scopes] : ['read', 'mutate'];

    const record: MobileDeviceRecord = {
      deviceId: params.deviceId,
      deviceName: params.deviceName,
      deviceModel: params.deviceModel,
      osVersion: params.osVersion,
      publicKeyFingerprint: params.publicKeyFingerprint,
      tokenHash,
      refreshTokenHash,
      scopes,
      createdAt: this.mobileDevices.get(params.deviceId)?.createdAt ?? nowIso,
      updatedAt: nowIso,
      expiresAt,
      lastSeenAt: nowIso,
      revoked: false,
    };

    if (this.store) {
      await this.store.put(`auth:mobile:device:${params.deviceId}`, record);
    }
    this.mobileDevices.set(params.deviceId, record);

    const { tokenHash: _th, refreshTokenHash: _rth, ...sanitized } = record;
    return {
      deviceId: params.deviceId,
      accessToken,
      refreshToken,
      expiresAt,
      scopes,
      device: sanitized,
    };
  }

  /**
   * Rotates a mobile device's access and refresh tokens using its current refreshToken.
   */
  async rotateMobileDeviceCredential(refreshToken: string, ttlMs = DEFAULT_MOBILE_TOKEN_TTL_MS): Promise<IssuedMobileCredential | undefined> {
    if (!refreshToken) return undefined;
    const presentedRefreshHash = createHash('sha256').update(refreshToken).digest('hex');
    let matched: MobileDeviceRecord | undefined;
    for (const record of this.mobileDevices.values()) {
      if (!record.revoked && safeEqual(record.refreshTokenHash, presentedRefreshHash)) {
        matched = record;
      }
    }
    if (!matched) return undefined;

    const accessToken = `mob_at_${randomBytes(32).toString('hex')}`;
    const nextRefreshToken = `mob_rt_${randomBytes(32).toString('hex')}`;
    const tokenHash = createHash('sha256').update(accessToken).digest('hex');
    const refreshTokenHash = createHash('sha256').update(nextRefreshToken).digest('hex');
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = nowMs + ttlMs;

    const updated: MobileDeviceRecord = {
      ...matched,
      tokenHash,
      refreshTokenHash,
      updatedAt: nowIso,
      lastSeenAt: nowIso,
      expiresAt,
    };

    if (this.store) {
      await this.store.put(`auth:mobile:device:${matched.deviceId}`, updated);
    }
    this.mobileDevices.set(matched.deviceId, updated);
    const { tokenHash: _th, refreshTokenHash: _rth, ...sanitized } = updated;
    return {
      deviceId: updated.deviceId,
      accessToken,
      refreshToken: nextRefreshToken,
      expiresAt,
      scopes: updated.scopes,
      device: sanitized,
    };
  }

  async revokeMobileDevice(deviceId: string): Promise<boolean> {
    const existing = this.mobileDevices.get(deviceId);
    if (!existing) return false;
    const nowIso = new Date(this.now()).toISOString();
    const revokedRecord: MobileDeviceRecord = {
      ...existing,
      revoked: true,
      revokedAt: nowIso,
      updatedAt: nowIso,
    };
    this.mobileDevices.set(deviceId, revokedRecord);
    if (this.store) {
      await this.store.put(`auth:mobile:device:${deviceId}`, revokedRecord);
    }
    return true;
  }

  listMobileDevices(): Array<Omit<MobileDeviceRecord, 'tokenHash' | 'refreshTokenHash'>> {
    return [...this.mobileDevices.values()].map(({ tokenHash: _th, refreshTokenHash: _rth, ...rest }) => rest);
  }

  get hasActiveMobileDevices(): boolean {
    const nowMs = this.now();
    for (const dev of this.mobileDevices.values()) {
      if (!dev.revoked && dev.expiresAt > nowMs) return true;
    }
    return false;
  }

  matchMobileDevice(presented: string | undefined): MobileDeviceRecord | undefined {
    if (!presented) return undefined;
    const presentedHash = createHash('sha256').update(presented).digest('hex');
    const nowMs = this.now();
    let matched: MobileDeviceRecord | undefined;
    for (const record of this.mobileDevices.values()) {
      if (!record.revoked && record.expiresAt > nowMs && safeEqual(record.tokenHash, presentedHash)) {
        matched = record;
      }
    }
    if (matched) {
      matched.lastSeenAt = new Date(nowMs).toISOString();
    }
    return matched;
  }

  /**
   * Mints (or adopts a worker-supplied) token for `computerId`, replacing any previous one.
   * Resolves only after the hash is durably stored; if the write fails it rejects and the
   * previous credential stays in force, so a returned token always survives a restart.
   */
  async issueComputerToken(computerId: string, preferred?: string): Promise<string> {
    const token = preferred && preferred.length >= 16 ? preferred : randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    if (this.store) {
      await this.store.put(`auth:computer:${computerId}`, {
        computerId,
        hash,
        updatedAt: new Date().toISOString(),
      });
    }
    this.computerTokenHashes.set(computerId, hash);
    return token;
  }

  hasComputerToken(computerId: string): boolean {
    return this.computerTokenHashes.has(computerId);
  }

  /**
   * Revokes `computerId`'s credential. It stops working in this process immediately (fail
   * closed); the returned promise rejects if the durable delete failed, in which case the
   * credential would come back after a restart and the revocation must be retried.
   */
  async revokeComputerToken(computerId: string): Promise<void> {
    this.computerTokenHashes.delete(computerId);
    if (this.store) {
      await this.store.delete(`auth:computer:${computerId}`);
    }
  }

  isComputerToken(computerId: string, presented: string | undefined): boolean {
    if (!presented) return false;
    const expectedHash = this.computerTokenHashes.get(computerId);
    if (expectedHash !== undefined) {
      const presentedHash = createHash('sha256').update(presented).digest('hex');
      return safeEqual(expectedHash, presentedHash);
    }
    return false;
  }

  isRegistrationToken(presented: string | undefined): boolean {
    return this.registrationToken !== undefined && presented !== undefined && safeEqual(this.registrationToken, presented);
  }

  // Deliberately NOT mobile-device-aware: this is the single operator check every
  // `requireOperator`-gated route in the whole API relies on (model load/unload, worker
  // admin, computer registration, task dispatch, pairing-session admin...). A paired
  // phone must never satisfy it, however wide its scopes — that's what keeps "a device is
  // narrower than an operator" true everywhere instead of being a per-route judgment call.
  // Mobile-aware routes opt in explicitly via `requireOperatorOrDevice`/
  // `requireViewerOperatorOrDevice` below.
  isOperatorToken(presented: string | undefined): boolean {
    return this.operatorToken !== undefined && presented !== undefined && safeEqual(this.operatorToken, presented);
  }

  isViewerToken(presented: string | undefined): boolean {
    return this.viewerToken !== undefined && presented !== undefined && safeEqual(this.viewerToken, presented);
  }

  /** Whether `req` carries operator scope (the same rule `requireOperator` applies). */
  isOperatorRequest(req: Request): boolean {
    if (this.isAllowedUnauthenticated && !this.operatorToken) return true;
    return this.isOperatorToken(bearerToken(req));
  }

  /** Express middleware: operator token required for mutations and dispatch. */
  requireOperator = (req: Request, res: Response, next: NextFunction): void => {
    const presented = bearerToken(req);
    if (this.isOperatorRequest(req)) {
      next();
      return;
    }
    this.recordAuthFailure();
    // 403, not 401, for any *recognized* but insufficient credential (viewer token, or a
    // paired mobile device — this route never grants a device access, it only owes it an
    // honest status code: "I know who you are, you're just not allowed" vs "I don't know
    // who you are").
    if (this.isViewerToken(presented) || this.matchMobileDevice(presented)) {
      res.status(403).json({ error: 'operator scope required (viewer and mobile-device credentials cannot reach this route)' });
      return;
    }
    res.status(401).json({ error: 'operator token required (Authorization: Bearer <WAZIR_API_TOKEN>)' });
  };

  /** Express middleware: viewer or operator token on read-only control routes. */
  requireViewerOrOperator = (req: Request, res: Response, next: NextFunction): void => {
    if (this.isAllowedUnauthenticated && !this.operatorToken && !this.viewerToken) {
      next();
      return;
    }
    const presented = bearerToken(req);
    if (this.isOperatorToken(presented) || this.isViewerToken(presented)) {
      next();
      return;
    }
    this.recordAuthFailure();
    res.status(401).json({ error: 'viewer or operator token required (Authorization: Bearer <WAZIR_API_TOKEN> or <WAZIR_API_VIEWER_TOKEN>)' });
  };

  /**
   * Express middleware: operator token OR a paired mobile device with `mutate` scope.
   * Use only on the specific mobile-facing mutations a device is meant to perform
   * (submit/cancel a task, decide a pending approval) — never as a blanket gate, and
   * never on pairing-session administration, device revocation, or emergency controls,
   * which stay `requireOperator`-only.
   */
  requireOperatorOrDevice = (req: Request, res: Response, next: NextFunction): void => {
    const presented = bearerToken(req);
    if (this.isOperatorRequest(req)) {
      next();
      return;
    }
    const mobile = this.matchMobileDevice(presented);
    if (mobile && mobile.scopes.includes('mutate')) {
      next();
      return;
    }
    this.recordAuthFailure();
    if (this.isViewerToken(presented) || (mobile && !mobile.scopes.includes('mutate'))) {
      res.status(403).json({ error: 'operator or mutate-scoped mobile device required (read-only credential cannot mutate)' });
      return;
    }
    res.status(401).json({ error: 'operator token or an authorized mobile device required' });
  };

  /**
   * Express middleware: viewer, operator, or any paired (non-revoked, unexpired) mobile
   * device, for read-only mobile routes.
   */
  requireViewerOperatorOrDevice = (req: Request, res: Response, next: NextFunction): void => {
    if (this.isAllowedUnauthenticated && !this.operatorToken && !this.viewerToken) {
      next();
      return;
    }
    const presented = bearerToken(req);
    if (this.isOperatorToken(presented) || this.isViewerToken(presented) || this.matchMobileDevice(presented)) {
      next();
      return;
    }
    this.recordAuthFailure();
    res.status(401).json({ error: 'viewer, operator, or an authorized mobile device required' });
  };

  /**
   * The authenticated control-plane principal for `req`, or undefined. Scopes come
   * only from which credential matched — never from the request body.
   * Unauthenticated local development (no tokens configured, explicitly allowed)
   * keeps its existing operator-equivalent boundary.
   */
  principalFor(req: Request): ProtocolPrincipal | undefined {
    const presented = bearerToken(req);
    if (this.operatorToken !== undefined && presented !== undefined && safeEqual(this.operatorToken, presented)) {
      return { kind: 'operator', id: 'operator', scopes: ['read', 'mutate', 'execute'] };
    }
    if (this.viewerToken !== undefined && presented !== undefined && safeEqual(this.viewerToken, presented)) {
      return { kind: 'viewer', id: 'viewer', scopes: ['read'] };
    }
    const mobile = this.matchMobileDevice(presented);
    if (mobile) {
      // Honest kind, not a masquerade as 'operator'/'viewer' — `hasScope()` (the only
      // thing that gates /ap/v1 and /mcp tool execution) reads `scopes`, not `kind`, so
      // this doesn't change what a device can do; it keeps audit logs and any future
      // kind-based logic from mistaking a phone for the real operator.
      return {
        kind: 'mobile-device',
        id: `mobile:${mobile.deviceId}`,
        scopes: mobile.scopes,
      };
    }
    if (this.isAllowedUnauthenticated && !this.operatorToken && !this.viewerToken) {
      return { kind: 'local-dev', id: 'local-dev', scopes: ['read', 'mutate', 'execute'] };
    }
    return undefined;
  }

  /**
   * Express middleware for protocol surfaces: authenticates and attaches
   * `res.locals.principal`. Per-operation scope checks (route-level
   * `requireOperator`, JSON-RPC method classification) happen downstream
   * against the attached principal.
   */
  requireProtocolPrincipal = (req: Request, res: Response, next: NextFunction): void => {
    const principal = this.principalFor(req);
    if (!principal) {
      this.recordAuthFailure();
      res.status(401).json({ error: 'viewer or operator token required (Authorization: Bearer <WAZIR_API_TOKEN> or <WAZIR_API_VIEWER_TOKEN>)' });
      return;
    }
    res.locals.principal = principal;
    next();
  };

  /** Express middleware: the caller must hold the token issued to `req.params.id`. */
  requireComputer = (req: Request, res: Response, next: NextFunction): void => {
    const computerId = String(req.params.id);
    if (!this.hasComputerToken(computerId)) {
      this.recordAuthFailure();
      res.status(404).json({ error: `computer '${computerId}' unknown — register first` });
      return;
    }
    if (!this.isComputerToken(computerId, bearerToken(req))) {
      this.recordAuthFailure();
      res.status(401).json({ error: `not authorised for computer '${computerId}'` });
      return;
    }
    next();
  };
}

export function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

function safeEqual(a: string, b: string): boolean {
  // Hash both sides so lengths match and the comparison is constant time
  // regardless of how much of the presented token is correct.
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1';
}
