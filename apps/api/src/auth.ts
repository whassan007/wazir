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
export interface ApiAuthOptions {
  operatorToken?: string;
  registrationToken?: string;
}

export class ApiAuth {
  readonly operatorToken?: string;
  readonly registrationToken?: string;
  private readonly computerTokens = new Map<string, string>();

  constructor(options: ApiAuthOptions = {}) {
    this.operatorToken = options.operatorToken || undefined;
    this.registrationToken = options.registrationToken || undefined;
  }

  get operatorTokenRequired(): boolean {
    return this.operatorToken !== undefined;
  }

  /** Mints (or adopts a worker-supplied) token for `computerId`, replacing any previous one. */
  issueComputerToken(computerId: string, preferred?: string): string {
    const token = preferred && preferred.length >= 16 ? preferred : randomBytes(32).toString('hex');
    this.computerTokens.set(computerId, token);
    return token;
  }

  hasComputerToken(computerId: string): boolean {
    return this.computerTokens.has(computerId);
  }

  revokeComputerToken(computerId: string): void {
    this.computerTokens.delete(computerId);
  }

  isComputerToken(computerId: string, presented: string | undefined): boolean {
    const expected = this.computerTokens.get(computerId);
    return expected !== undefined && presented !== undefined && safeEqual(expected, presented);
  }

  isRegistrationToken(presented: string | undefined): boolean {
    return this.registrationToken !== undefined && presented !== undefined && safeEqual(this.registrationToken, presented);
  }

  isOperatorToken(presented: string | undefined): boolean {
    return this.operatorToken !== undefined && presented !== undefined && safeEqual(this.operatorToken, presented);
  }

  /** Express middleware: operator token on control routes (no-op when none is configured). */
  requireOperator = (req: Request, res: Response, next: NextFunction): void => {
    if (!this.operatorTokenRequired) {
      next();
      return;
    }
    if (!this.isOperatorToken(bearerToken(req))) {
      res.status(401).json({ error: 'operator token required (Authorization: Bearer <WAZIR_API_TOKEN>)' });
      return;
    }
    next();
  };

  /** Express middleware: the caller must hold the token issued to `req.params.id`. */
  requireComputer = (req: Request, res: Response, next: NextFunction): void => {
    const computerId = String(req.params.id);
    if (!this.hasComputerToken(computerId)) {
      res.status(404).json({ error: `computer '${computerId}' unknown — register first` });
      return;
    }
    if (!this.isComputerToken(computerId, bearerToken(req))) {
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
