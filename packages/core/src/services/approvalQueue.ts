import { randomUUID } from 'node:crypto';
import type { PolicyActionRequest, PolicyDecision } from '../types/policy.js';
import { appendAuditEvent } from '@wazir/shared';
import type { KeyValueStore } from '@wazir/shared';

/**
 * Binds an approval to exactly one decision point. An approval granted for one
 * scope can never satisfy a request for another (different run, target, attempt
 * or action), which is what keeps a single "yes" from being replayed elsewhere.
 */
export interface ApprovalScope {
  /** Namespace of the requester, e.g. 'goal-studio'. */
  kind: string;
  runId: string;
  targetId: string;
  attempt: number;
  action: string;
}

/** Deterministic, collision-free key for a scope. */
export function approvalScopeKey(scope: ApprovalScope): string {
  return [scope.kind, scope.runId, scope.targetId, String(scope.attempt), scope.action].map(encodeURIComponent).join(':');
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PendingApprovalRequest {
  id: string;
  jobId?: string;
  taskId?: string;
  executionId?: string;
  agentId?: string;
  tool: string;
  input: Record<string, unknown>;
  rule: string;
  reasons: string[];
  createdAt: Date;
  /** Absolute expiry; set when the request has a TTL. */
  expiresAt?: Date;
  /** Present for scoped requests (see `requestScoped`). */
  scope?: ApprovalScope;
  scopeKey?: string;
  status: 'pending' | 'approved' | 'denied';
  resolve: (approved: boolean, resolvedBy?: string) => void;
}

/** Durable, serializable record of an approval (pending or resolved). */
export interface ApprovalRecord {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  rule: string;
  reasons: string[];
  jobId?: string;
  taskId?: string;
  executionId?: string;
  agentId?: string;
  scope?: ApprovalScope;
  scopeKey?: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface ApprovalQueueOptions {
  /**
   * Deny immediately when nobody is subscribed to the queue (no TUI, no
   * approver loop). Without this a headless `wa run` would block forever on
   * its first 'ask' decision. Scoped requests are exempt: their approvers are
   * out-of-band surfaces (HTTP, mobile) and they always carry a TTL instead.
   */
  autoDenyNonInteractive?: boolean;
  /** Pending requests nobody answers within this window are denied. */
  defaultTimeoutMs?: number;
  /**
   * Honour `WAZIR_AUTO_APPROVE=1`. Off by default: an environment variable
   * must not be able to silently promote every 'ask' to 'allow' (F-9); the
   * host has to opt in explicitly (e.g. `wa run --yes` for a trusted batch).
   * Never applies to scoped requests, which by definition need a human.
   */
  allowEnvAutoApprove?: boolean;
  /**
   * Optional durable store. Every request and resolution is written under
   * `approvals/queue/<id>`. On `init()`, anything still pending from a previous
   * process is marked expired (fail closed: no resolver is waiting any more),
   * and resolved scoped decisions are reloaded so a replayed request with the
   * same scope gets the recorded answer instead of a fresh prompt.
   */
  store?: KeyValueStore;
  /** Default TTL for scoped requests. Defaults to 30 minutes. */
  scopedTimeoutMs?: number;
  /** How many resolved records to retain in memory for history/replay. */
  historyLimit?: number;
  now?: () => number;
}

export type ApprovalResolutionResult =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_RESOLVED' | 'EXPIRED' | 'SCOPE_MISMATCH'; message: string; record?: ApprovalRecord };

const STORE_PREFIX = 'approvals/queue/';
const DEFAULT_SCOPED_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_HISTORY_LIMIT = 500;

let warnedIgnoredAutoApprove = false;

/**
 * Non-blocking policy approval queue for fleet-scale execution.
 *
 * When an agent encounters an 'ask' policy decision, it enqueues a request here.
 * The calling agent's promise remains pending while all other N-1 agents continue
 * executing uninterrupted. The TUI or CLI can display and resolve pending approvals
 * interactively.
 */
export class ApprovalQueue {
  private readonly pending = new Map<string, PendingApprovalRequest>();
  private readonly pendingByScope = new Map<string, { id: string; promise: Promise<boolean> }>();
  private readonly history = new Map<string, ApprovalRecord>();
  private readonly decidedScopes = new Map<string, ApprovalRecord>();
  private readonly listeners = new Set<(requests: PendingApprovalRequest[]) => void>();
  private readonly now: () => number;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: ApprovalQueueOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Loads durable state. Safe to call once at startup; a no-op without a store. */
  async init(): Promise<void> {
    const store = this.options.store;
    if (!store) return;
    const entries = await store.list(STORE_PREFIX);
    const nowIso = new Date(this.now()).toISOString();
    const loaded = entries
      .map((entry) => entry.value as ApprovalRecord | undefined)
      .filter((record): record is ApprovalRecord => Boolean(record?.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const record of loaded) {
      if (this.pending.has(record.id)) continue;
      if (record.status === 'pending') {
        record.status = 'expired';
        record.resolvedAt = nowIso;
        record.resolvedBy = 'restart';
        await store.put(`${STORE_PREFIX}${record.id}`, record).catch(() => undefined);
      }
      this.remember(record);
    }
  }

  enqueue(
    request: PolicyActionRequest,
    decision: PolicyDecision,
    metadata: { jobId?: string; taskId?: string; agentId?: string; ttlMs?: number } = {},
  ): Promise<boolean> {
    if (process.env.WAZIR_AUTO_DENY === '1') {
      return Promise.resolve(false);
    }
    if (process.env.WAZIR_AUTO_APPROVE === '1') {
      if (this.options.allowEnvAutoApprove) {
        return Promise.resolve(true);
      }
      if (!warnedIgnoredAutoApprove) {
        warnedIgnoredAutoApprove = true;
        console.error('[wazir] WAZIR_AUTO_APPROVE=1 is set but auto-approval is not enabled for this session; approvals still require a human');
      }
    }
    if (this.options.autoDenyNonInteractive && this.listeners.size === 0) {
      return Promise.resolve(false);
    }
    return this.createPending(request, decision, { ...metadata, ttlMs: metadata.ttlMs ?? this.options.defaultTimeoutMs });
  }

  /**
   * Requests a human decision bound to `scope`. Idempotent per scope: while a
   * request for the same scope is pending the same promise is returned, and once
   * it has been decided the recorded decision is returned without asking again
   * (expired/denied → false). A different scope never shares a decision.
   * Environment auto-approval never applies here.
   */
  requestScoped(
    scope: ApprovalScope,
    details: { tool?: string; input?: Record<string, unknown>; rule?: string; reasons?: string[]; agentId?: string; ttlMs?: number } = {},
  ): Promise<boolean> {
    validateScope(scope);
    const scopeKey = approvalScopeKey(scope);
    const inflight = this.pendingByScope.get(scopeKey);
    if (inflight) return inflight.promise;
    const decided = this.decidedScopes.get(scopeKey);
    if (decided) return Promise.resolve(decided.status === 'approved');
    if (process.env.WAZIR_AUTO_DENY === '1') {
      return Promise.resolve(false);
    }
    const request: PolicyActionRequest = {
      tool: details.tool ?? `${scope.kind}.${scope.action}`,
      input: { ...(details.input ?? {}), runId: scope.runId, targetId: scope.targetId, attempt: scope.attempt, action: scope.action },
      executionId: scope.runId,
    };
    const decision: PolicyDecision = {
      decision: 'ask',
      rule: details.rule ?? `${scope.kind}-approval`,
      reasons: details.reasons ?? [`${scope.action} requires explicit human approval`],
    };
    const ttlMs = details.ttlMs ?? this.options.scopedTimeoutMs ?? DEFAULT_SCOPED_TIMEOUT_MS;
    let id = '';
    const promise = this.createPending(request, decision, {
      taskId: `${scope.runId}:${scope.targetId}`,
      agentId: details.agentId,
      ttlMs,
      scope,
      scopeKey,
      onId: (assigned) => { id = assigned; },
    });
    if (this.pending.has(id)) this.pendingByScope.set(scopeKey, { id, promise });
    return promise;
  }

  private createPending(
    request: PolicyActionRequest,
    decision: PolicyDecision,
    metadata: {
      jobId?: string; taskId?: string; agentId?: string; ttlMs?: number;
      scope?: ApprovalScope; scopeKey?: string; onId?: (id: string) => void;
    },
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const id = `appr-${randomUUID()}`;
      metadata.onId?.(id);
      let timer: NodeJS.Timeout | undefined;
      const createdMs = this.now();
      const ttlMs = metadata.ttlMs;
      const item: PendingApprovalRequest = {
        id,
        jobId: metadata.jobId,
        taskId: metadata.taskId ?? request.executionId,
        executionId: request.executionId,
        agentId: metadata.agentId,
        tool: request.tool,
        input: request.input,
        rule: decision.rule,
        reasons: decision.reasons,
        createdAt: new Date(createdMs),
        expiresAt: ttlMs !== undefined && ttlMs > 0 ? new Date(createdMs + ttlMs) : undefined,
        scope: metadata.scope,
        scopeKey: metadata.scopeKey,
        status: 'pending',
        resolve: (approved: boolean, resolvedBy?: string) => {
          if (item.status !== 'pending') return;
          if (timer) clearTimeout(timer);
          item.status = approved ? 'approved' : 'denied';
          this.pending.delete(id);
          if (item.scopeKey) this.pendingByScope.delete(item.scopeKey);
          const who = resolvedBy ?? (approved ? 'approver' : 'approver_denied');
          const record = toRecord(item, resolvedBy === 'timeout' ? 'expired' : item.status, new Date(this.now()).toISOString(), who);
          this.remember(record);
          this.persist(record);
          this.notify();
          void appendAuditEvent({
            type: 'approval_resolution',
            tool: item.tool,
            decision: approved ? 'allow' : 'deny',
            rule: item.rule,
            reasons: item.reasons,
            executionId: item.executionId,
            taskId: item.taskId,
            agentId: item.agentId,
            resolvedBy: who,
            details: { input: item.input, approvalId: item.id, scope: item.scopeKey },
          }).catch(() => {});
          resolve(approved);
        },
      };

      if (ttlMs !== undefined && ttlMs > 0) {
        timer = setTimeout(() => item.resolve(false, 'timeout'), ttlMs);
        timer.unref?.();
      }

      this.pending.set(id, item);
      this.persist(toRecord(item, 'pending'));
      this.notify();
    });
  }

  /** True when something (a TUI, an approver loop) can answer requests. */
  get hasSubscribers(): boolean {
    return this.listeners.size > 0;
  }

  approve(id: string, resolvedBy?: string): boolean {
    return this.resolve(id, true, resolvedBy).ok;
  }

  deny(id: string, resolvedBy?: string): boolean {
    return this.resolve(id, false, resolvedBy).ok;
  }

  /**
   * Resolves one request, attributing it to `resolvedBy`. When `expectedScope`
   * is given (any subset of fields), it must match the request's bound scope;
   * a request without a scope never satisfies a scoped resolution.
   */
  resolve(id: string, approved: boolean, resolvedBy?: string, expectedScope?: Partial<ApprovalScope>): ApprovalResolutionResult {
    const item = this.pending.get(id);
    if (!item) {
      const past = this.history.get(id);
      if (past) {
        return past.status === 'expired'
          ? { ok: false, code: 'EXPIRED', message: `approval '${id}' expired`, record: past }
          : { ok: false, code: 'ALREADY_RESOLVED', message: `approval '${id}' was already ${past.status} and cannot be replayed`, record: past };
      }
      return { ok: false, code: 'NOT_FOUND', message: `approval '${id}' not found` };
    }
    if (item.expiresAt && item.expiresAt.getTime() <= this.now()) {
      item.resolve(false, 'timeout');
      return { ok: false, code: 'EXPIRED', message: `approval '${id}' expired`, record: this.history.get(id) };
    }
    if (expectedScope && !scopeMatches(item.scope, expectedScope)) {
      return { ok: false, code: 'SCOPE_MISMATCH', message: `approval '${id}' is bound to a different scope`, record: toRecord(item, 'pending') };
    }
    item.resolve(approved, resolvedBy);
    return { ok: true, record: this.history.get(id) ?? toRecord(item, approved ? 'approved' : 'denied') };
  }

  approveAll(): number {
    const items = Array.from(this.pending.values());
    for (const item of items) {
      item.resolve(true);
    }
    return items.length;
  }

  denyAll(): number {
    const items = Array.from(this.pending.values());
    for (const item of items) {
      item.resolve(false);
    }
    return items.length;
  }

  get(id: string): PendingApprovalRequest | undefined {
    return this.pending.get(id);
  }

  /** Pending or historical record for `id`, serializable. */
  record(id: string): ApprovalRecord | undefined {
    const item = this.pending.get(id);
    return item ? toRecord(item, 'pending') : this.history.get(id);
  }

  /** Pending request bound to `scope`, if any. */
  findByScope(scope: ApprovalScope): PendingApprovalRequest | undefined {
    const entry = this.pendingByScope.get(approvalScopeKey(scope));
    return entry ? this.pending.get(entry.id) : undefined;
  }

  list(): PendingApprovalRequest[] {
    return Array.from(this.pending.values());
  }

  /** Pending plus retained resolved records, newest first. */
  records(filter: { kind?: string; runId?: string; status?: ApprovalStatus } = {}): ApprovalRecord[] {
    const all = [
      ...Array.from(this.pending.values()).map((item) => toRecord(item, 'pending')),
      ...Array.from(this.history.values()),
    ];
    return all
      .filter((r) => (filter.kind === undefined || r.scope?.kind === filter.kind)
        && (filter.runId === undefined || r.scope?.runId === filter.runId)
        && (filter.status === undefined || r.status === filter.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get count(): number {
    return this.pending.size;
  }

  subscribe(listener: (requests: PendingApprovalRequest[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => this.listeners.delete(listener);
  }

  private remember(record: ApprovalRecord): void {
    this.history.delete(record.id);
    this.history.set(record.id, record);
    if (record.scopeKey && record.status !== 'pending') this.decidedScopes.set(record.scopeKey, record);
    const limit = this.options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    while (this.history.size > limit) {
      const oldest = this.history.keys().next().value as string;
      const dropped = this.history.get(oldest);
      this.history.delete(oldest);
      if (dropped?.scopeKey && this.decidedScopes.get(dropped.scopeKey)?.id === dropped.id) {
        this.decidedScopes.delete(dropped.scopeKey);
      }
    }
  }

  private persist(record: ApprovalRecord): void {
    const store = this.options.store;
    if (!store) return;
    // Serialized so a request's 'pending' write can never land after its resolution.
    this.persistChain = this.persistChain
      .then(() => store.put(`${STORE_PREFIX}${record.id}`, record))
      .catch(() => undefined);
  }

  /** Resolves once every queued durable write has been attempted. */
  flush(): Promise<void> {
    return this.persistChain;
  }

  private notify(): void {
    const current = this.list();
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch {
        // ignore subscriber errors
      }
    }
  }
}

function validateScope(scope: ApprovalScope): void {
  const fields: Array<'kind' | 'runId' | 'targetId' | 'action'> = ['kind', 'runId', 'targetId', 'action'];
  for (const field of fields) {
    if (typeof scope?.[field] !== 'string' || scope[field].length === 0) {
      throw new Error(`approval scope requires a non-empty ${field}`);
    }
  }
  if (!Number.isInteger(scope.attempt) || scope.attempt < 0) {
    throw new Error('approval scope requires a non-negative integer attempt');
  }
}

function scopeMatches(actual: ApprovalScope | undefined, expected: Partial<ApprovalScope>): boolean {
  if (!actual) return false;
  for (const key of Object.keys(expected) as Array<keyof ApprovalScope>) {
    const value = expected[key];
    if (value === undefined) continue;
    if (actual[key] !== value) return false;
  }
  return true;
}

function toRecord(item: PendingApprovalRequest, status: ApprovalStatus, resolvedAt?: string, resolvedBy?: string): ApprovalRecord {
  return {
    id: item.id,
    tool: item.tool,
    input: item.input,
    rule: item.rule,
    reasons: item.reasons,
    jobId: item.jobId,
    taskId: item.taskId,
    executionId: item.executionId,
    agentId: item.agentId,
    scope: item.scope,
    scopeKey: item.scopeKey,
    status,
    createdAt: item.createdAt.toISOString(),
    expiresAt: item.expiresAt?.toISOString(),
    resolvedAt,
    resolvedBy,
  };
}

export function createApprovalQueue(options: ApprovalQueueOptions = {}): ApprovalQueue {
  return new ApprovalQueue(options);
}
