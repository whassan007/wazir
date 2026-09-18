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
 */
export interface ApiAuthOptions {
  operatorToken?: string;
  viewerToken?: string;
  registrationToken?: string;
  allowUnauthenticated?: boolean;
  store?: KeyValueStore;
}

export class ApiAuth {
  readonly operatorToken?: string;
  readonly viewerToken?: string;
  readonly registrationToken?: string;
  readonly allowUnauthenticated: boolean;
  private readonly store?: KeyValueStore;
  private readonly computerTokens = new Map<string, string>();
  private readonly computerTokenHashes = new Map<string, string>();
  private authFailureCount = 0;

  constructor(options: ApiAuthOptions = {}) {
    this.operatorToken = options.operatorToken || undefined;
    this.viewerToken = options.viewerToken || undefined;
    this.registrationToken = options.registrationToken || undefined;
    this.allowUnauthenticated = options.allowUnauthenticated ?? (process.env.WAZIR_ALLOW_UNAUTHENTICATED === '1');
    this.store = options.store;
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
   * Initializes stored computer token hashes from KeyValueStore so registered
   * workers survive API restarts without re-registration.
   */
  async init(): Promise<void> {
    if (!this.store) return;
    try {
      const entries = await this.store.list('auth:computer:');
      for (const entry of entries) {
        const val = entry.value as { hash?: string; computerId?: string };
        const id = val?.computerId ?? entry.key.replace(/^auth:computer:/, '');
        if (val?.hash) {
          this.computerTokenHashes.set(id, val.hash);
        }
      }
    } catch {
      // Store listing is best-effort on startup
    }
  }

  /** Mints (or adopts a worker-supplied) token for `computerId`, replacing any previous one. */
  issueComputerToken(computerId: string, preferred?: string): string {
    const token = preferred && preferred.length >= 16 ? preferred : randomBytes(32).toString('hex');
    this.computerTokens.set(computerId, token);
    const hash = createHash('sha256').update(token).digest('hex');
    this.computerTokenHashes.set(computerId, hash);
    if (this.store) {
      void this.store.put(`auth:computer:${computerId}`, {
        computerId,
        hash,
        updatedAt: new Date().toISOString(),
      });
    }
    return token;
  }

  hasComputerToken(computerId: string): boolean {
    return this.computerTokens.has(computerId) || this.computerTokenHashes.has(computerId);
  }

  revokeComputerToken(computerId: string): void {
    this.computerTokens.delete(computerId);
    this.computerTokenHashes.delete(computerId);
    if (this.store) {
      void this.store.delete(`auth:computer:${computerId}`);
    }
  }

  isComputerToken(computerId: string, presented: string | undefined): boolean {
    if (!presented) return false;
    const expected = this.computerTokens.get(computerId);
    if (expected !== undefined && safeEqual(expected, presented)) {
      return true;
    }
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

  isOperatorToken(presented: string | undefined): boolean {
    return this.operatorToken !== undefined && presented !== undefined && safeEqual(this.operatorToken, presented);
  }

  isViewerToken(presented: string | undefined): boolean {
    return this.viewerToken !== undefined && presented !== undefined && safeEqual(this.viewerToken, presented);
  }

  /** Express middleware: operator token required for mutations and dispatch. */
  requireOperator = (req: Request, res: Response, next: NextFunction): void => {
    if (this.isAllowedUnauthenticated && !this.operatorToken) {
      next();
      return;
    }
    const presented = bearerToken(req);
    if (this.isOperatorToken(presented)) {
      next();
      return;
    }
    this.recordAuthFailure();
    if (this.isViewerToken(presented)) {
      res.status(403).json({ error: 'operator scope required (viewer token is read-only)' });
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
