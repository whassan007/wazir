import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateId } from './utils.js';
import { sanitizeUntrustedOutput } from './sanitize.js';

export type ProviderAuthEvent =
  | 'AUTH_LOGIN_STARTED'
  | 'AUTH_LOGIN_SUCCEEDED'
  | 'AUTH_LOGIN_FAILED'
  | 'AUTH_REFRESHED'
  | 'AUTH_EXPIRED'
  | 'AUTH_LOGOUT';

export interface AuditEvent {
  id: string;
  timestamp: string;
  type: 'policy_decision' | 'approval_resolution' | 'tool_call' | 'provider_auth' | 'model_lifecycle';
  tool?: string;
  decision?: 'allow' | 'ask' | 'deny';
  rule?: string;
  reasons?: string[];
  command?: string;
  executionId?: string;
  taskId?: string;
  agentId?: string;
  resolvedBy?: string;
  /** Set only on `type: 'provider_auth'` events — 'anthropic' | 'openai' | 'google'. */
  provider?: string;
  /** Set only on `type: 'provider_auth'` events. */
  authEvent?: ProviderAuthEvent;
  /**
   * Free-form event metadata. For `type: 'provider_auth'` this MUST NEVER
   * contain an API key, access/refresh token, authorization code, PKCE
   * verifier, or any other secret material — only non-secret classification
   * (e.g. `{ method: 'api-key' }`, `{ reason: 'invalid_api_key' }`,
   * `{ expiresAt: '...' }`). Enforced by convention at every `wa auth` call
   * site, not by this function; see apps/cli/tests/authAuditRedaction.test.ts.
   */
  details?: Record<string, unknown>;
}

export interface ReadAuditOptions {
  auditPath?: string;
  limit?: number;
  tool?: string;
  decision?: 'allow' | 'ask' | 'deny';
  type?: AuditEvent['type'];
  provider?: string;
}

function sanitizeDeep<T>(value: T): T {
  if (typeof value === 'string') return sanitizeUntrustedOutput(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
    return out as T;
  }
  return value;
}

export function getDefaultAuditLogPath(): string {
  // Same resolution as the CLI's configDir(): WAZIR_HOME wins, then ~/.wazir.
  const dir = process.env.WAZIR_CONFIG_DIR ?? process.env.WAZIR_HOME ?? path.join(os.homedir(), '.wazir');
  return path.join(dir, 'audit.jsonl');
}

/**
 * Appends an audit event to the append-only JSONL audit log.
 * Enforces file mode 0600 and directory mode 0700 (Step 5 of PROGRESS.md).
 */
export async function appendAuditEvent(
  event: Omit<AuditEvent, 'id' | 'timestamp'> & { id?: string; timestamp?: string },
  options: { auditPath?: string } = {},
): Promise<AuditEvent> {
  const auditPath = options.auditPath ?? getDefaultAuditLogPath();
  const dir = path.dirname(auditPath);

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const record: AuditEvent = {
    id: event.id ?? generateId('audit-'),
    timestamp: event.timestamp ?? new Date().toISOString(),
    type: event.type,
    tool: event.tool,
    decision: event.decision,
    rule: event.rule,
    reasons: event.reasons,
    command: event.command,
    executionId: event.executionId,
    taskId: event.taskId,
    agentId: event.agentId,
    resolvedBy: event.resolvedBy,
    provider: event.provider,
    authEvent: event.authEvent,
    details: event.details,
  };

  // The log is read back by `wa audit` and shipped elsewhere; model-supplied
  // text (reasons, commands, inputs) must not carry terminal escapes or
  // credentials into it. Scrub the values, not the serialized line:
  // JSON.stringify would spell ESC as the six characters `\u001b`.
  const line = `${JSON.stringify(sanitizeDeep(record))}\n`;
  await fs.appendFile(auditPath, line, { mode: 0o600 });
  await fs.chmod(auditPath, 0o600).catch(() => undefined);

  return record;
}

/**
 * Reads and filters audit events from the append-only JSONL audit file.
 * Returns events in reverse-chronological order (newest first).
 */
export async function readAuditEvents(options: ReadAuditOptions = {}): Promise<AuditEvent[]> {
  const auditPath = options.auditPath ?? getDefaultAuditLogPath();

  try {
    const content = await fs.readFile(auditPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const events: AuditEvent[] = [];

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as AuditEvent;
        if (options.type && parsed.type !== options.type) continue;
        if (options.tool && parsed.tool !== options.tool) continue;
        if (options.decision && parsed.decision !== options.decision) continue;
        if (options.provider && parsed.provider !== options.provider) continue;
        events.push(parsed);
        if (options.limit && events.length >= options.limit) break;
      } catch {
        // Skip malformed line
      }
    }

    return events;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
