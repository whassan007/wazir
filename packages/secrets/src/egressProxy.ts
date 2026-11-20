import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { SecretBroker } from './secretBroker.js';

export interface EgressRouteRule {
  /** Unique rule identifier for audit logs. */
  id: string;
  /** Target origin, e.g. "https://api.github.com" or "http://127.0.0.1:4000". */
  targetOrigin: string;
  /** Optional path prefix allowlist (defaults to "/"). */
  pathPrefix?: string;
  /** Secret key in SecretBroker to inject on approved requests. */
  secretKey: string;
  /** HTTP header to inject (default: "authorization"). */
  headerName?: string;
  /** Prefix prepended to secret value (default: "Bearer "). */
  headerValuePrefix?: string;
  /** Allowed HTTP methods (default: all standard methods). */
  allowedMethods?: string[];
  /** Optional session/policy gate checked before forwarding. */
  authorize?: (req: { method: string; targetUrl: string; ruleId: string }) => Promise<boolean> | boolean;
}

export interface EgressAuditEntry {
  timestamp: string;
  ruleId?: string;
  method: string;
  targetUrl: string;
  status: 'allowed' | 'denied' | 'missing_secret' | 'upstream_error';
  statusCode?: number;
  reason?: string;
}

export interface EgressProxyOptions {
  broker: SecretBroker;
  rules: EgressRouteRule[];
  /** Bind host (default: "127.0.0.1"). */
  host?: string;
  /** Bind port (default: 0 for ephemeral port). */
  port?: number;
  /** Optional audit callback. */
  onAudit?: (entry: EgressAuditEntry) => void;
  /** Optional custom HTTP requester for in-memory/sandboxed testing. */
  requestTransport?: typeof http.request;
}

/**
 * Local token-injecting egress & MCP proxy.
 *
 * Keeps raw git/API/MCP credentials out of sandboxed child environments:
 * sandboxed tools call this proxy URL with no secrets in env; the proxy
 * validates the target origin/path against `rules`, pulls the secret from
 * `SecretBroker`, injects the auth header, and forwards the request.
 */
export class TokenInjectingEgressProxy {
  private server: http.Server | undefined;
  private readonly rules: EgressRouteRule[];
  private readonly auditLog: EgressAuditEntry[] = [];

  constructor(private readonly options: EgressProxyOptions) {
    this.rules = options.rules;
  }

  getAuditLog(): readonly EgressAuditEntry[] {
    return this.auditLog;
  }

  private recordAudit(entry: EgressAuditEntry): void {
    this.auditLog.push(entry);
    this.options.onAudit?.(entry);
  }

  private matchRule(targetUrl: URL, method: string): EgressRouteRule | undefined {
    for (const rule of this.rules) {
      const originUrl = new URL(rule.targetOrigin);
      if (targetUrl.origin !== originUrl.origin) continue;
      const prefix = rule.pathPrefix ?? '/';
      if (!targetUrl.pathname.startsWith(prefix)) continue;
      if (rule.allowedMethods && !rule.allowedMethods.includes(method.toUpperCase())) continue;
      return rule;
    }
    return undefined;
  }

  async start(): Promise<{ url: string; port: number }> {
    if (this.server) {
      const addr = this.server.address();
      if (addr && typeof addr === 'object') {
        return { url: `http://${this.options.host ?? '127.0.0.1'}:${addr.port}`, port: addr.port };
      }
    }

    const host = this.options.host ?? '127.0.0.1';
    const port = this.options.port ?? 0;

    this.server = http.createServer((req, res) => {
      void this.dispatchRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });

    const addr = this.server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    return { url: `http://${host}:${boundPort}`, port: boundPort };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  }

  async dispatchRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawTarget = req.headers['x-wazir-target-url'];
    const targetStr = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget ?? req.url ?? '';

    let targetUrl: URL;
    try {
      // Support both explicit x-wazir-target-url header and full-URL proxy path
      targetUrl = new URL(targetStr.startsWith('http://') || targetStr.startsWith('https://')
        ? targetStr
        : `${this.rules[0]?.targetOrigin ?? 'http://127.0.0.1'}${targetStr.startsWith('/') ? targetStr : `/${targetStr}`}`);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_target_url' }));
      return;
    }

    const rule = this.matchRule(targetUrl, method);
    if (!rule) {
      this.recordAudit({
        timestamp: new Date().toISOString(),
        method,
        targetUrl: targetUrl.toString(),
        status: 'denied',
        statusCode: 403,
        reason: 'no_matching_egress_rule',
      });
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'egress_denied', reason: 'no_matching_egress_rule' }));
      return;
    }

    if (rule.authorize) {
      const allowed = await rule.authorize({ method, targetUrl: targetUrl.toString(), ruleId: rule.id });
      if (!allowed) {
        this.recordAudit({
          timestamp: new Date().toISOString(),
          ruleId: rule.id,
          method,
          targetUrl: targetUrl.toString(),
          status: 'denied',
          statusCode: 403,
          reason: 'policy_rejected',
        });
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'egress_denied', reason: 'policy_rejected' }));
        return;
      }
    }

    const secret = await this.options.broker.getCredential(rule.secretKey);
    if (!secret) {
      this.recordAudit({
        timestamp: new Date().toISOString(),
        ruleId: rule.id,
        method,
        targetUrl: targetUrl.toString(),
        status: 'missing_secret',
        statusCode: 502,
        reason: `secret_not_found:${rule.secretKey}`,
      });
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing_secret', secretKey: rule.secretKey }));
      return;
    }

    const forwardHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const lower = k.toLowerCase();
      if (lower === 'host' || lower === 'connection' || lower === 'x-wazir-target-url' || lower === 'authorization') {
        continue;
      }
      forwardHeaders[k] = v;
    }
    const headerName = (rule.headerName ?? 'authorization').toLowerCase();
    const prefix = rule.headerValuePrefix ?? 'Bearer ';
    forwardHeaders[headerName] = `${prefix}${secret}`;

    const requester = this.options.requestTransport ?? (targetUrl.protocol === 'https:' ? https.request : http.request);
    const upstreamReq = requester(
      targetUrl,
      { method, headers: forwardHeaders },
      (upstreamRes) => {
        const statusCode = upstreamRes.statusCode ?? 502;
        this.recordAudit({
          timestamp: new Date().toISOString(),
          ruleId: rule.id,
          method,
          targetUrl: targetUrl.toString(),
          status: 'allowed',
          statusCode,
        });
        res.writeHead(statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on('error', (err) => {
      this.recordAudit({
        timestamp: new Date().toISOString(),
        ruleId: rule.id,
        method,
        targetUrl: targetUrl.toString(),
        status: 'upstream_error',
        statusCode: 502,
        reason: err.message,
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream_error', message: err.message }));
      }
    });

    req.pipe(upstreamReq);
  }
}
