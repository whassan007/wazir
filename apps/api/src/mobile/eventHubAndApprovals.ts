import { randomBytes, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PolicyActionRequest, PolicyDecision } from '@wazir/core';
import { appendAuditEvent, type KeyValueStore } from '@wazir/shared';
import {
  classifyApprovalRisk,
  computeArgumentsHash,
  DEFAULT_APPROVAL_TTL_MS,
  MAX_MOBILE_EVENTS,
  redactSensitiveArguments,
  type MobileApprovalRecord,
  type MobileStreamEvent,
} from './typesAndCompatibility.js';

/**
 * Sequenced event hub for authenticated mobile SSE subscribers.
 */
export class MobileEventHub {
  private sequence = 0;
  private readonly events: MobileStreamEvent[] = [];
  private readonly clients = new Set<{
    res: Response;
    taskId?: string;
    keepAlive: NodeJS.Timeout;
  }>();
  private readonly listeners = new Set<(event: MobileStreamEvent) => void>();

  constructor(private readonly store: KeyValueStore, private readonly now: () => number = Date.now) {}

  onEvent(listener: (event: MobileStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async init(): Promise<void> {
    const saved = await this.store.get<{ sequence: number; events: MobileStreamEvent[] }>('mobile/events/ring');
    if (saved && Array.isArray(saved.events)) {
      this.sequence = typeof saved.sequence === 'number' ? saved.sequence : saved.events.length;
      this.events.push(...saved.events.slice(-MAX_MOBILE_EVENTS));
    }
  }

  get subscriberCount(): number {
    return this.clients.size;
  }

  get latestCursor(): number {
    return this.sequence;
  }

  listRecent(limit = 50, taskId?: string): MobileStreamEvent[] {
    const seen = new Set<string>();
    const filtered = this.events.filter((e) => {
      if (taskId && e.taskId !== taskId && e.executionId !== taskId) return false;
      if (seen.has(e.eventId)) return false;
      seen.add(e.eventId);
      return true;
    });
    return filtered.slice(-limit).reverse();
  }

  eventsSince(cursor: number, taskId?: string): MobileStreamEvent[] {
    const seen = new Set<string>();
    return this.events.filter((e) => {
      if (e.sequence <= cursor) return false;
      if (taskId && e.taskId !== taskId && e.executionId !== taskId) return false;
      if (seen.has(e.eventId)) return false;
      seen.add(e.eventId);
      return true;
    });
  }

  async publish(
    event: Omit<MobileStreamEvent, 'sequence' | 'eventId' | 'timestamp'> & { eventId?: string },
  ): Promise<MobileStreamEvent> {
    if (event.eventId) {
      const existing = this.events.find((e) => e.eventId === event.eventId);
      if (existing) {
        return existing;
      }
    }
    this.sequence += 1;
    const full: MobileStreamEvent = {
      sequence: this.sequence,
      eventId: event.eventId ?? `mev-${this.sequence}-${randomBytes(4).toString('hex')}`,
      timestamp: new Date(this.now()).toISOString(),
      ...event,
    };
    this.events.push(full);
    if (this.events.length > MAX_MOBILE_EVENTS) {
      this.events.splice(0, this.events.length - MAX_MOBILE_EVENTS);
    }
    await this.store.put('mobile/events/ring', {
      sequence: this.sequence,
      events: this.events.slice(-250),
    }).catch(() => undefined);

    const frame = `id: ${full.sequence}\nevent: ${full.type}\ndata: ${JSON.stringify(full)}\n\n`;
    for (const client of this.clients) {
      if (client.taskId && full.taskId !== client.taskId && full.executionId !== client.taskId) {
        continue;
      }
      try {
        client.res.write(frame);
      } catch {
        // Broken pipe cleaned up on close
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // Non-fatal listener error
      }
    }
    return full;
  }

  subscribeSse(req: Request, res: Response): void {
    const cursorHeader = req.headers['last-event-id'];
    const cursorQuery = req.query.cursor;
    const rawCursor = typeof cursorQuery === 'string'
      ? Number(cursorQuery)
      : typeof cursorHeader === 'string'
        ? Number(cursorHeader)
        : NaN;
    const cursor = Number.isFinite(rawCursor) && rawCursor >= 0 ? rawCursor : undefined;
    const taskId = typeof req.query.taskId === 'string' && req.query.taskId.trim() ? req.query.taskId.trim() : undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Send initial stream ready comment + current cursor
    res.write(`: connected cursor=${this.sequence}\n\n`);

    if (cursor !== undefined) {
      for (const missed of this.eventsSince(cursor, taskId)) {
        res.write(`id: ${missed.sequence}\nevent: ${missed.type}\ndata: ${JSON.stringify(missed)}\n\n`);
      }
    }

    const keepAlive = setInterval(() => {
      try {
        res.write(`: heartbeat ${new Date(this.now()).toISOString()} cursor=${this.sequence}\n\n`);
      } catch {
        clearInterval(keepAlive);
      }
    }, 5_000);
    keepAlive.unref?.();

    const client = { res, taskId, keepAlive };
    this.clients.add(client);

    req.on('close', () => {
      clearInterval(keepAlive);
      this.clients.delete(client);
    });
  }
}

/**
 * Durable Human Approval Service integrated with PolicyEngine.
 */
export class MobileApprovalService {
  private readonly records = new Map<string, MobileApprovalRecord>();
  private readonly resolvers = new Map<string, {
    resolve: (approved: boolean) => void;
    timer: NodeJS.Timeout;
  }>();
  public enableDurableQueue = false;

  constructor(
    private readonly store: KeyValueStore,
    private readonly eventHub: MobileEventHub,
    private readonly now: () => number = Date.now,
    private readonly defaultTtlMs = DEFAULT_APPROVAL_TTL_MS,
  ) {}

  async init(): Promise<void> {
    const entries = await this.store.list('mobile/approvals/');
    const nowMs = this.now();
    for (const entry of entries) {
      const record = entry.value as MobileApprovalRecord;
      if (!record?.id) continue;
      // Any approval left pending across a process restart has no in-memory resolver
      // waiting on it anymore; fail closed by marking it expired.
      if (record.status === 'pending') {
        record.status = 'expired';
        record.resolvedAt = new Date(nowMs).toISOString();
        record.resolutionNote = 'Expired across controller restart (fail closed)';
        await this.store.put(`mobile/approvals/${record.id}`, record);
      }
      this.records.set(record.id, record);
    }
  }

  private sweepExpired(): void {
    const nowMs = this.now();
    for (const record of this.records.values()) {
      if (record.status === 'pending' && record.expiresAt <= nowMs) {
        this.expireRecord(record.id);
      }
    }
  }

  private expireRecord(id: string): void {
    const record = this.records.get(id);
    if (!record || record.status !== 'pending') return;
    record.status = 'expired';
    record.resolvedAt = new Date(this.now()).toISOString();
    record.resolutionNote = 'Approval expired before operator decision';
    const pending = this.resolvers.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.resolvers.delete(id);
      pending.resolve(false);
    }
    void this.store.put(`mobile/approvals/${id}`, record).catch(() => undefined);
    void this.eventHub.publish({
      type: 'approval.expired',
      approvalId: id,
      taskId: record.taskId,
      executionId: record.executionId,
      status: 'expired',
      summary: `Approval expired for ${record.operation}`,
      payload: { approval: record },
    });
  }

  list(status?: 'pending' | 'approved' | 'rejected' | 'expired'): MobileApprovalRecord[] {
    this.sweepExpired();
    const all = [...this.records.values()].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    return status ? all.filter((r) => r.status === status) : all;
  }

  get(id: string): MobileApprovalRecord | undefined {
    this.sweepExpired();
    return this.records.get(id);
  }

  get pendingCount(): number {
    this.sweepExpired();
    let count = 0;
    for (const r of this.records.values()) {
      if (r.status === 'pending') count++;
    }
    return count;
  }

  pendingForTask(taskId: string): string[] {
    this.sweepExpired();
    return [...this.records.values()]
      .filter((r) => r.status === 'pending' && (r.taskId === taskId || r.executionId === taskId))
      .map((r) => r.id);
  }

  /**
   * Enqueues a policy `ask` request into the durable approval inbox and waits for
   * an explicit scoped resolution before `expiresAt`.
   */
  async requestApproval(
    request: PolicyActionRequest,
    decision: PolicyDecision,
    context?: { taskId?: string; taskTitle?: string; agentId?: string; ttlMs?: number },
  ): Promise<boolean> {
    const id = `appr-${randomUUID()}`;
    const nowMs = this.now();
    const createdAt = new Date(nowMs).toISOString();
    const ttlMs = context?.ttlMs ?? this.defaultTtlMs;
    const expiresAt = nowMs + ttlMs;
    const taskId = context?.taskId ?? request.executionId;
    const redactedArguments = redactSensitiveArguments(request.input) as Record<string, unknown>;
    const argumentsHash = computeArgumentsHash({
      tool: request.tool,
      input: request.input,
      taskId,
      executionId: request.executionId,
    });
    const classification = classifyApprovalRisk(request.tool, request.input, decision.rule);

    const record: MobileApprovalRecord = {
      id,
      taskId,
      taskTitle: context?.taskTitle,
      executionId: request.executionId,
      agentId: context?.agentId ?? 'coding-agent',
      tool: request.tool,
      operation: classification.operation,
      redactedArguments,
      argumentsHash,
      relevantResources: classification.relevantResources,
      riskClassification: classification.riskClassification,
      requiresBiometric: classification.requiresBiometric,
      rule: decision.rule,
      reasons: decision.reasons,
      expectedSideEffects: classification.expectedSideEffects,
      createdAt,
      expiresAt,
      status: 'pending',
    };

    this.records.set(id, record);
    await this.store.put(`mobile/approvals/${id}`, record);

    await this.eventHub.publish({
      type: 'approval.requested',
      approvalId: id,
      taskId,
      executionId: request.executionId,
      agentId: record.agentId,
      status: 'pending',
      summary: `Approval required: ${record.operation}`,
      payload: { approval: record },
    });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.expireRecord(id);
      }, ttlMs);
      timer.unref?.();
      this.resolvers.set(id, { resolve, timer });
    });
  }

  /**
   * Resolves a pending approval request with strict scope, expiration, replay, and biometric checks.
   */
  async resolveApproval(params: {
    id: string;
    decision: 'approve' | 'reject';
    argumentsHash?: string;
    taskId?: string;
    biometricVerified?: boolean;
    resolvedBy: string;
    note?: string;
  }): Promise<
    | { ok: true; approval: MobileApprovalRecord }
    | { ok: false; status: number; code: string; error: string }
  > {
    this.sweepExpired();
    const record = this.records.get(params.id);
    if (!record) {
      return { ok: false, status: 404, code: 'APPROVAL_NOT_FOUND', error: `Approval '${params.id}' not found` };
    }
    if (record.status === 'expired' || record.expiresAt <= this.now()) {
      this.expireRecord(record.id);
      return { ok: false, status: 409, code: 'APPROVAL_EXPIRED', error: `Approval '${params.id}' has expired` };
    }
    if (record.status !== 'pending') {
      return {
        ok: false,
        status: 409,
        code: 'APPROVAL_ALREADY_RESOLVED',
        error: `Approval '${params.id}' was already ${record.status} and cannot be replayed`,
      };
    }
    if (params.argumentsHash !== undefined && params.argumentsHash !== record.argumentsHash) {
      return {
        ok: false,
        status: 409,
        code: 'APPROVAL_SCOPE_MISMATCH',
        error: 'Approval argumentsHash does not match the pending operation',
      };
    }
    if (params.taskId !== undefined && record.taskId && params.taskId !== record.taskId) {
      return {
        ok: false,
        status: 409,
        code: 'APPROVAL_TASK_MISMATCH',
        error: 'Approval taskId does not match the pending operation',
      };
    }
    if (params.decision === 'approve' && record.requiresBiometric && params.biometricVerified !== true) {
      return {
        ok: false,
        status: 403,
        code: 'BIOMETRIC_REQUIRED',
        error: `Approval '${params.id}' is classified as ${record.riskClassification} risk and requires biometric or device-credential confirmation`,
      };
    }

    const approved = params.decision === 'approve';
    record.status = approved ? 'approved' : 'rejected';
    record.resolvedAt = new Date(this.now()).toISOString();
    record.resolvedBy = params.resolvedBy;
    record.resolutionNote = params.note;

    const pending = this.resolvers.get(record.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.resolvers.delete(record.id);
      pending.resolve(approved);
    }

    await this.store.put(`mobile/approvals/${record.id}`, record);
    await appendAuditEvent({
      type: 'approval_resolution',
      tool: record.tool,
      decision: approved ? 'allow' : 'deny',
      rule: record.rule,
      reasons: record.reasons,
      executionId: record.executionId,
      taskId: record.taskId,
      agentId: record.agentId,
      resolvedBy: params.resolvedBy,
      details: {
        approvalId: record.id,
        argumentsHash: record.argumentsHash,
        biometricVerified: Boolean(params.biometricVerified),
      },
    }).catch(() => undefined);

    await this.eventHub.publish({
      type: 'approval.resolved',
      approvalId: record.id,
      taskId: record.taskId,
      executionId: record.executionId,
      agentId: record.agentId,
      status: record.status,
      summary: `Approval ${record.status} for ${record.operation} by ${params.resolvedBy}`,
      payload: { approval: record },
    });

    return { ok: true, approval: record };
  }
}
