import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import {
  AccountRegistry,
  ExecutionEngine,
  JobManager,
  PolicyEngine,
  ResourceLedger,
  ResourceRouter,
  Scheduler,
  TaskCapabilityClassifier,
  TokenBudgetManager,
  validateResourceConfig,
  persistExecutionRecord,
  ProvenanceManager,
  type AccountStatus,
  type ControlledToolExecutor,
  type ExecutionRecord,
  type PolicyActionRequest,
  type PolicyDecision,
  type Priority,
  type ProtocolPrincipal,
  type ProtocolScope,
  type StepVerifier,
  type Task,
  type TaskStatus,
} from '@wazir/core';
import { appendAuditEvent, sanitizeUntrustedOutput, type KeyValueStore } from '@wazir/shared';
import type { ApiState } from './server.js';
import { MultiSurfaceService, registerMultiSurfaceRoutes } from './multiSurface.js';

export const MOBILE_API_VERSION = '1.0.0';
export const MIN_SUPPORTED_MOBILE_VERSION = '1.0.0';
export const CONTROLLER_VERSION = '0.1.63';

const MAX_MOBILE_EVENTS = 1_000;
const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PAIRING_ATTEMPTS = 3;
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000; // 5 minutes
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type MobileEventType =
  | 'task.created'
  | 'task.started'
  | 'task.phase_changed'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.blocked'
  | 'task.resumed'
  | 'model.selected'
  | 'model.loaded'
  | 'model.unloaded'
  | 'tool.started'
  | 'tool.executed'
  | 'tool.failed'
  | 'verification.started'
  | 'verification.passed'
  | 'verification.failed'
  | 'worker.connected'
  | 'worker.disconnected'
  | 'worker.heartbeat'
  | 'approval.requested'
  | 'approval.resolved'
  | 'approval.expired'
  | 'resource.warning'
  | 'resource.emergency_stop'
  | 'resource.resumed';

export interface MobileStreamEvent {
  sequence: number;
  eventId: string;
  timestamp: string;
  type: string;
  taskId?: string;
  executionId?: string;
  computerId?: string;
  approvalId?: string;
  agentId?: string;
  modelId?: string;
  status?: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface PairingSessionRecord {
  sessionId: string;
  secretHash: string;
  createdAt: string;
  expiresAt: number;
  status: 'waiting_for_device' | 'pending_operator_approval' | 'approved' | 'rejected' | 'claimed' | 'expired';
  attempts: number;
  scopes: ProtocolScope[];
  controllerUrl?: string;
  tlsCertFingerprint?: string;
  confirmationCode?: string;
  deviceRequest?: {
    deviceId: string;
    deviceName: string;
    deviceModel?: string;
    osVersion?: string;
    publicKeyFingerprint?: string;
    requestedAt: string;
  };
  issuedCredential?: {
    deviceId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: ProtocolScope[];
  };
}

export type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface MobileApprovalRecord {
  id: string;
  taskId?: string;
  taskTitle?: string;
  executionId?: string;
  agentId?: string;
  tool: string;
  operation: string;
  redactedArguments: Record<string, unknown>;
  argumentsHash: string;
  relevantResources: string[];
  riskClassification: ApprovalRiskLevel;
  requiresBiometric: boolean;
  rule: string;
  reasons: string[];
  expectedSideEffects: string;
  createdAt: string;
  expiresAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
}

export interface MobileTaskSummary {
  taskId: string;
  executionId?: string;
  jobId?: string;
  title: string;
  input: string;
  agentId: string;
  modelId: string;
  runtimeId: string;
  computerId: string;
  priority: Priority;
  state: 'running' | 'queued' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  phase: 'Planning' | 'Agent Execution' | 'Tool Calls' | 'Verification' | 'Completion' | 'Queued' | 'Blocked';
  currentOperation?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastActivityAt: string;
  elapsedMs: number;
  verificationStatus: 'PASS' | 'FAIL' | 'ERROR' | 'UNAVAILABLE' | 'PENDING';
  pendingApprovalIds: string[];
  supportedActions: Array<'cancel' | 'retry' | 'resume' | 'inspect' | 'logs'>;
}

export interface MobileTaskDetail extends MobileTaskSummary {
  repository?: string;
  policy?: Record<string, unknown>;
  resourceBudget?: {
    maxTokens?: number;
    maxCostUsd?: number;
    maxExecutionTimeSeconds?: number;
  };
  timeline: Array<{
    id: string;
    phase: string;
    title: string;
    status: string;
    timestamp: string;
    durationMs?: number;
    detail?: string;
  }>;
  reasoningSummaries: string[];
  toolCalls: Array<{
    callId: string;
    tool: string;
    status: 'running' | 'succeeded' | 'failed' | 'denied';
    input: Record<string, unknown>;
    output?: string;
    error?: string;
    durationMs: number;
    timestamp: string;
  }>;
  filesChanged: string[];
  verificationReport?: {
    status: string;
    checks: Array<{
      name: string;
      status: string;
      durationMs: number;
      output?: string;
      error?: string;
    }>;
    reasons: string[];
    workspaceRevision?: string;
    completedAt?: string;
  };
  errors: string[];
  resourceConsumption: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
    source: 'provider-reported' | 'estimated' | 'conservative';
  };
  finalOutput?: string;
  logs: Array<{
    sequence: number;
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    phase: string;
    message: string;
  }>;
}

const SECRET_KEY_PATTERN = /(password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key|credential|cookie)/i;
const BEARER_VALUE_PATTERN = /(Bearer\s+[A-Za-z0-9._~+/=-]+|mob_(?:at|rt)_[A-Fa-f0-9]+|sk-[A-Za-z0-9_-]{12,})/g;

export function redactSensitiveArguments(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    return sanitizeUntrustedOutput(input.replace(BEARER_VALUE_PATTERN, '[REDACTED]'));
  }
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveArguments(item));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSensitiveArguments(v);
    }
  }
  return out;
}

export function computeArgumentsHash(params: {
  tool: string;
  input: Record<string, unknown>;
  taskId?: string;
  executionId?: string;
}): string {
  const canonical = JSON.stringify({
    tool: params.tool,
    input: sortObjectKeys(params.input),
    taskId: params.taskId ?? '',
    executionId: params.executionId ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function sortObjectKeys(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    out[k] = sortObjectKeys(v);
  }
  return out;
}

function safeEqualHex(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function classifyApprovalRisk(tool: string, input: Record<string, unknown>, rule: string): {
  riskClassification: ApprovalRiskLevel;
  requiresBiometric: boolean;
  operation: string;
  relevantResources: string[];
  expectedSideEffects: string;
} {
  const resources: string[] = [];
  if (typeof input.path === 'string') resources.push(input.path);
  if (typeof input.file === 'string') resources.push(input.file);
  if (typeof input.target === 'string') resources.push(input.target);
  const cmd = typeof input.command === 'string' ? input.command : '';

  if (tool === 'shell') {
    const highRiskPattern = /\b(rm|chmod|chown|docker|kubectl|npm|pnpm|yarn|pip|brew|apt|cargo\s+install|cmake\s+--install|curl|wget|ssh)\b/i;
    const criticalPattern = /\b(rm\s+-rf|sudo|dd|mkfs|systemctl|launchctl)\b/i;
    const risk: ApprovalRiskLevel = criticalPattern.test(cmd)
      ? 'critical'
      : highRiskPattern.test(cmd) || rule.includes('protected')
        ? 'high'
        : 'high';
    return {
      riskClassification: risk,
      requiresBiometric: true,
      operation: cmd ? `shell: ${cmd.slice(0, 120)}` : 'Execute shell command',
      relevantResources: resources.length ? resources : ['project workspace'],
      expectedSideEffects: 'Executes a process in the controller project workspace that may modify files or invoke local build/runtime binaries.',
    };
  }

  if (tool === 'write' || tool === 'edit') {
    const isProtected = rule.includes('protected') || resources.some((r) => /(\.git|package\.json|\.env|wazir)/i.test(r));
    const risk: ApprovalRiskLevel = isProtected ? 'high' : 'medium';
    return {
      riskClassification: risk,
      requiresBiometric: risk === 'high',
      operation: `${tool}: ${resources.join(', ') || 'workspace file'}`,
      relevantResources: resources,
      expectedSideEffects: isProtected
        ? 'Modifies a protected project configuration, manifest, or repository control file.'
        : 'Modifies source files inside the controller workspace.',
    };
  }

  if (tool === 'git') {
    const subcommand = typeof input.subcommand === 'string' ? input.subcommand : cmd;
    const isHigh = /\b(reset|rebase|merge|checkout|stash)\b/i.test(String(subcommand));
    const risk: ApprovalRiskLevel = isHigh ? 'high' : 'medium';
    return {
      riskClassification: risk,
      requiresBiometric: risk === 'high',
      operation: `git ${String(subcommand || '').slice(0, 80)}`.trim(),
      relevantResources: resources.length ? resources : ['.git'],
      expectedSideEffects: 'Mutates local Git working tree, staging index, or branch state.',
    };
  }

  return {
    riskClassification: 'medium',
    requiresBiometric: false,
    operation: `${tool}`,
    relevantResources: resources,
    expectedSideEffects: `Executes tool '${tool}' on the Wazir controller.`,
  };
}

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

interface ManagedMobileTask {
  taskId: string;
  executionId: string;
  jobId: string;
  title: string;
  input: string;
  repository: string;
  agentId: string;
  modelId: string;
  runtimeId: string;
  computerId: string;
  priority: Priority;
  state: 'running' | 'queued' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  phase: 'Planning' | 'Agent Execution' | 'Tool Calls' | 'Verification' | 'Completion' | 'Queued' | 'Blocked';
  currentOperation?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastActivityAt: string;
  verificationStatus: 'PASS' | 'FAIL' | 'ERROR' | 'UNAVAILABLE' | 'PENDING';
  policy?: Record<string, unknown>;
  resourceBudget?: {
    maxTokens?: number;
    maxCostUsd?: number;
    maxExecutionTimeSeconds?: number;
  };
  timeline: MobileTaskDetail['timeline'];
  reasoningSummaries: string[];
  toolCalls: MobileTaskDetail['toolCalls'];
  filesChanged: string[];
  verificationReport?: MobileTaskDetail['verificationReport'];
  errors: string[];
  resourceConsumption: MobileTaskDetail['resourceConsumption'];
  finalOutput?: string;
  logs: MobileTaskDetail['logs'];
  plannedOperations?: Array<{
    tool?: { name: string; input: Record<string, unknown> };
    verify?: string[];
  }>;
}

export class MobileServices {
  readonly eventHub: MobileEventHub;
  readonly approvals: MobileApprovalService;
  readonly pairing: MobilePairingService;
  readonly ledger: ResourceLedger;
  readonly accounts: AccountRegistry;
  readonly budget: TokenBudgetManager;
  readonly router: ResourceRouter;
  readonly executionEngine: ExecutionEngine;
  readonly jobManager: JobManager;
  readonly scheduler: Scheduler;
  readonly policyEngine: PolicyEngine;
  readonly multiSurface: MultiSurfaceService;

  private readonly tasks = new Map<string, ManagedMobileTask>();
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private readonly idempotencyRecords = new Map<string, { taskId: string; createdAt: number }>();

  constructor(
    private readonly state: ApiState,
    private readonly options: {
      projectRoot: string;
      executeTool: ControlledToolExecutor;
      verify: StepVerifier;
      policy: PolicyEngine;
      ledgerPath?: string;
      now?: () => number;
    },
  ) {
    const now = options.now ?? Date.now;
    this.eventHub = new MobileEventHub(state.store, now);
    this.approvals = new MobileApprovalService(state.store, this.eventHub, now);
    this.pairing = new MobilePairingService(state, now);
    this.policyEngine = options.policy;

    const ledgerPath = options.ledgerPath ?? ':memory:';
    this.ledger = new ResourceLedger(ledgerPath, now);
    const { policy: resourcePolicy, accounts: configuredAccounts } = validateResourceConfig({});
    this.accounts = new AccountRegistry(configuredAccounts);
    this.accounts.addImplicit({
      localRuntimes: state.runtimes.list().map((r) => r.id),
      hostedRuntimes: [],
      agents: state.agents.list().map((a) => a.descriptor.name),
      hostedAuthorized: false,
    });
    this.budget = new TokenBudgetManager(this.ledger, this.accounts, resourcePolicy);
    const resolveAccount = (runtimeId: string, modelId: string) =>
      this.accounts.candidates({ runtimeId, modelId })[0]?.id;
    this.router = new ResourceRouter({ budget: this.budget, resolveAccount });

    const provenance = new ProvenanceManager(state.store);
    this.executionEngine = new ExecutionEngine({
      provenanceManager: provenance,
      workspace: options.projectRoot,
      persist: (record) => persistExecutionRecord(state.store, `execution/${record.execution.id}`, record),
      load: async () => {
        const entries = await state.store.list('execution/');
        return entries.map((e) => e.value as ExecutionRecord);
      },
    });
    this.jobManager = new JobManager({ store: state.store });
    const classifier = new TaskCapabilityClassifier();
    void classifier;
    this.scheduler = new Scheduler({
      computers: state.computers,
      runtimes: state.runtimes,
      models: state.models,
      policy: this.policyEngine,
      agents: state.agents,
      resources: { router: this.router },
    });
    this.multiSurface = new MultiSurfaceService(state, this, now);
  }

  async init(): Promise<void> {
    await this.eventHub.init();
    await this.approvals.init();
    await this.pairing.init();
    await this.executionEngine.ready;
    await this.jobManager.ready;
    await this.multiSurface.init();

    const savedTasks = await this.state.store.list('mobile/tasks/');
    for (const entry of savedTasks) {
      const task = entry.value as ManagedMobileTask;
      if (task?.taskId) {
        if (task.state === 'running' || task.state === 'blocked') {
          task.state = 'failed';
          task.errors.push('Controller restarted while task was in progress');
          task.completedAt = new Date().toISOString();
          await this.state.store.put(`mobile/tasks/${task.taskId}`, task);
        }
        this.tasks.set(task.taskId, task);
      }
    }

    const savedIdem = await this.state.store.list('mobile/idempotency/');
    for (const entry of savedIdem) {
      const val = entry.value as { taskId: string; createdAt: number };
      const key = entry.key.replace(/^mobile\/idempotency\//, '');
      if (val?.taskId) {
        this.idempotencyRecords.set(key, val);
      }
    }
  }

  shouldUseMobileApprovalQueue(): boolean {
    return (
      this.approvals.enableDurableQueue ||
      this.state.auth.hasActiveMobileDevices ||
      this.eventHub.subscriberCount > 0
    );
  }

  private async saveTask(task: ManagedMobileTask): Promise<void> {
    this.tasks.set(task.taskId, task);
    await this.state.store.put(`mobile/tasks/${task.taskId}`, task);
  }

  private appendLog(
    task: ManagedMobileTask,
    level: 'info' | 'warn' | 'error',
    phase: string,
    message: string,
  ): void {
    const seq = task.logs.length + 1;
    const nowIso = new Date().toISOString();
    task.logs.push({
      sequence: seq,
      timestamp: nowIso,
      level,
      phase,
      message: sanitizeUntrustedOutput(message),
    });
    if (task.logs.length > 500) {
      task.logs.splice(0, task.logs.length - 500);
    }
    task.lastActivityAt = nowIso;
  }

  /**
   * Merges managed mobile tasks, Agent Protocol tasks, and ExecutionEngine records into
   * a unified list of real controller tasks.
   */
  async listAllTasks(filterStatus?: string): Promise<MobileTaskSummary[]> {
    const summaries = new Map<string, MobileTaskSummary>();

    for (const task of this.tasks.values()) {
      summaries.set(task.taskId, this.toSummary(task));
    }

    // Also include Agent Protocol tasks created via /ap/v1/agent/tasks
    const apTasks = await this.state.editorProtocol.listTasks();
    for (const ap of apTasks) {
      if (summaries.has(ap.task_id)) continue;
      const mapped = this.fromAgentProtocolTask(ap);
      summaries.set(ap.task_id, mapped);
    }

    // Also include ExecutionEngine and shared store execution/* records (e.g. CLI runs) plus state.executions
    const rawRecords: Array<Record<string, unknown>> = [...this.state.executions];
    try {
      const engineList = await this.executionEngine.list();
      for (const rec of engineList) {
        rawRecords.push(rec as unknown as Record<string, unknown>);
      }
      const storedEntries = await this.state.store.list('execution/');
      for (const entry of storedEntries) {
        if (entry.value && typeof entry.value === 'object') {
          rawRecords.push(entry.value as Record<string, unknown>);
        }
      }
    } catch {
      // Ignore transient store errors
    }

    for (const raw of rawRecords) {
      const exec = raw.execution as {
        id?: string;
        taskId?: string;
        agentId?: string;
        modelId?: string;
        runtimeId?: string;
        computerId?: string;
        status?: string;
        createdAt?: string | Date;
        startedAt?: string | Date;
        completedAt?: string | Date;
        finishedAt?: string | Date;
        durationMs?: number;
      } | undefined;
      const id = exec?.taskId ?? exec?.id;
      const execId = exec?.id;
      if (!id || summaries.has(id) || (execId && summaries.has(execId))) continue;
      // Also skip if a managed task already references this executionId
      if (execId && [...summaries.values()].some((s) => s.executionId === execId)) continue;
      const rawStart = exec?.startedAt ?? exec?.createdAt ?? (raw.task as { createdAt?: string | Date })?.createdAt;
      const createdAt = rawStart ? new Date(rawStart).toISOString() : new Date().toISOString();
      const rawEnd = exec?.completedAt ?? exec?.finishedAt;
      const completedAt = rawEnd ? new Date(rawEnd).toISOString() : undefined;
      const rawState = String(exec?.status ?? 'completed');
      const state: MobileTaskSummary['state'] =
        rawState === 'running' ? 'running'
        : rawState === 'queued' || rawState === 'pending' ? 'queued'
        : rawState === 'failed' ? 'failed'
        : rawState === 'blocked' ? 'blocked'
        : rawState === 'cancelled' ? 'cancelled'
        : 'completed';
      summaries.set(id, {
        taskId: id,
        executionId: exec?.id,
        title: String((raw.task as { title?: string; input?: string })?.title ?? (raw.task as { input?: string })?.input ?? id).slice(0, 120),
        input: String((raw.task as { input?: string })?.input ?? id),
        agentId: String(raw.agentId ?? exec?.agentId ?? 'coding-agent'),
        modelId: String(raw.modelId ?? exec?.modelId ?? this.defaultModelId()),
        runtimeId: String(raw.runtimeId ?? exec?.runtimeId ?? this.defaultRuntimeId()),
        computerId: String(raw.computerId ?? exec?.computerId ?? (process.env.WAZIR_COMPUTER_ID ?? 'local')),
        priority: 'normal',
        state,
        phase: state === 'completed' ? 'Completion' : state === 'running' ? 'Agent Execution' : 'Queued',
        createdAt,
        startedAt: createdAt,
        completedAt: completedAt ?? (state === 'completed' || state === 'failed' ? createdAt : undefined),
        lastActivityAt: completedAt ?? createdAt,
        elapsedMs: typeof exec?.durationMs === 'number' ? exec.durationMs : 0,
        verificationStatus: 'UNAVAILABLE',
        pendingApprovalIds: this.approvals.pendingForTask(id),
        supportedActions: ['inspect', 'logs'],
      });
    }

    const list = [...summaries.values()].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    if (!filterStatus || filterStatus === 'all') return list;
    return list.filter((t) => t.state === filterStatus.toLowerCase());
  }

  async getTaskDetail(taskId: string): Promise<MobileTaskDetail | undefined> {
    const managed =
      this.tasks.get(taskId) ??
      [...this.tasks.values()].find((t) => t.executionId === taskId);
    if (managed) {
      return {
        ...this.toSummary(managed),
        repository: managed.repository,
        policy: managed.policy,
        resourceBudget: managed.resourceBudget,
        timeline: managed.timeline,
        reasoningSummaries: managed.reasoningSummaries,
        toolCalls: managed.toolCalls,
        filesChanged: managed.filesChanged,
        verificationReport: managed.verificationReport,
        errors: managed.errors,
        resourceConsumption: managed.resourceConsumption,
        finalOutput: managed.finalOutput,
        logs: managed.logs,
      };
    }

    const ap = await this.state.editorProtocol.getTask(taskId);
    if (ap) {
      const summary = this.fromAgentProtocolTask(ap);
      const toolCalls: MobileTaskDetail['toolCalls'] = [];
      const filesChanged = new Set<string>();
      let verificationReport: MobileTaskDetail['verificationReport'];
      const errors: string[] = [];
      const logs: MobileTaskDetail['logs'] = [];
      const timeline: MobileTaskDetail['timeline'] = [];

      ap.steps.forEach((s, idx) => {
        timeline.push({
          id: s.step_id,
          phase: s.additional_output?.verification ? 'Verification' : s.additional_output?.tool ? 'Tool Calls' : 'Agent Execution',
          title: s.name ?? `Step ${idx + 1}`,
          status: s.status,
          timestamp: s.created_at,
          detail: s.output,
        });
        logs.push({
          sequence: idx + 1,
          timestamp: s.completed_at ?? s.created_at,
          level: s.status === 'failed' ? 'error' : 'info',
          phase: 'Step',
          message: s.output ?? s.name ?? s.step_id,
        });
        const toolMeta = s.additional_output?.tool as Record<string, unknown> | undefined;
        if (toolMeta) {
          toolCalls.push({
            callId: String(toolMeta.call_id ?? s.step_id),
            tool: String(toolMeta.name ?? 'tool'),
            status: toolMeta.ok ? 'succeeded' : 'failed',
            input: redactSensitiveArguments(((s.additional_output?.custom as Record<string, unknown>)?.tool as Record<string, unknown>)?.input ?? {}) as Record<string, unknown>,
            output: s.output,
            error: typeof toolMeta.error === 'string' ? toolMeta.error : undefined,
            durationMs: Number(toolMeta.duration_ms ?? 0),
            timestamp: s.created_at,
          });
          if (Array.isArray(toolMeta.file_mutations)) {
            for (const m of toolMeta.file_mutations as Array<{ path?: string }>) {
              if (m?.path) filesChanged.add(m.path);
            }
          }
        }
        const ver = s.additional_output?.verification as MobileTaskDetail['verificationReport'] | undefined;
        if (ver) {
          verificationReport = ver;
        }
        if (s.status === 'failed' && s.output) {
          errors.push(s.output);
        }
      });
      for (const art of ap.artifacts) {
        filesChanged.add(art.relative_path ?? art.file_name);
      }

      return {
        ...summary,
        repository: this.options.projectRoot,
        timeline,
        reasoningSummaries: [`Task executed via Agent Protocol (${ap.steps.length} step(s))`],
        toolCalls,
        filesChanged: [...filesChanged],
        verificationReport,
        errors,
        resourceConsumption: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
          durationMs: summary.elapsedMs,
          source: 'estimated',
        },
        finalOutput: ap.steps.at(-1)?.output,
        logs,
      };
    }

    // Check ExecutionEngine / shared store execution/* records
    try {
      let execRec = (await this.state.store.get<Record<string, unknown>>(`execution/${taskId}`)) ??
        ((await this.executionEngine.get(taskId)) as unknown as Record<string, unknown> | undefined);
      if (!execRec) {
        const storedEntries = await this.state.store.list('execution/');
        for (const entry of storedEntries) {
          const val = entry.value as { execution?: { id?: string; taskId?: string } } | undefined;
          if (val?.execution?.taskId === taskId || val?.execution?.id === taskId) {
            execRec = entry.value as Record<string, unknown>;
            break;
          }
        }
      }
      if (execRec) {
        const exec = (execRec.execution as Record<string, unknown> | undefined) ?? {};
        const taskObj = (execRec.task as Record<string, unknown> | undefined) ?? {};
        const rawStart = exec.startedAt ?? taskObj.createdAt;
        const createdAt = rawStart ? new Date(String(rawStart)).toISOString() : new Date().toISOString();
        const rawEnd = exec.completedAt ?? exec.finishedAt;
        const completedAt = rawEnd ? new Date(String(rawEnd)).toISOString() : undefined;
        const rawState = String(exec.status ?? 'completed');
        const state: MobileTaskSummary['state'] =
          rawState === 'running' ? 'running'
          : rawState === 'queued' || rawState === 'pending' ? 'queued'
          : rawState === 'failed' ? 'failed'
          : rawState === 'blocked' ? 'blocked'
          : rawState === 'cancelled' ? 'cancelled'
          : 'completed';
        const events = Array.isArray(execRec.events) ? (execRec.events as Array<Record<string, unknown>>) : [];
        const logs: MobileTaskDetail['logs'] = events.map((ev, idx) => ({
          sequence: idx + 1,
          timestamp: ev.timestamp ? new Date(String(ev.timestamp)).toISOString() : createdAt,
          level: String(ev.type ?? '').includes('fail') || String(ev.type ?? '').includes('err') ? 'error' : 'info',
          phase: String(ev.type ?? 'Event'),
          message: typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data ?? ev.type ?? ''),
        }));
        const filesChanged = Array.isArray(execRec.fileMutations)
          ? (execRec.fileMutations as Array<{ path?: string }>).map((m) => m.path ?? '').filter(Boolean)
          : Array.isArray(execRec.filesChanged)
            ? (execRec.filesChanged as string[])
            : [];
        return {
          taskId: String(exec.taskId ?? exec.id ?? taskId),
          executionId: String(exec.id ?? taskId),
          title: String(taskObj.title ?? taskObj.input ?? taskId).slice(0, 120),
          input: String(taskObj.input ?? taskId),
          agentId: String(execRec.agentId ?? exec.agentId ?? 'coding-agent'),
          modelId: String(execRec.modelId ?? exec.modelId ?? this.defaultModelId()),
          runtimeId: String(execRec.runtimeId ?? exec.runtimeId ?? this.defaultRuntimeId()),
          computerId: String(execRec.computerId ?? exec.computerId ?? 'local'),
          priority: 'normal',
          state,
          phase: state === 'completed' ? 'Completion' : state === 'running' ? 'Agent Execution' : 'Queued',
          createdAt,
          startedAt: createdAt,
          completedAt,
          lastActivityAt: completedAt ?? createdAt,
          elapsedMs: typeof exec.durationMs === 'number' ? exec.durationMs : 0,
          verificationStatus: 'UNAVAILABLE',
          pendingApprovalIds: this.approvals.pendingForTask(taskId),
          supportedActions: ['inspect', 'logs'],
          repository: this.options.projectRoot,
          timeline: events.map((ev, idx) => ({
            id: String(ev.id ?? `ev-${idx}`),
            phase: String(ev.type ?? 'Execution'),
            title: String(ev.type ?? `Event ${idx + 1}`),
            status: state === 'failed' ? 'failed' : 'completed',
            timestamp: ev.timestamp ? new Date(String(ev.timestamp)).toISOString() : createdAt,
          })),
          reasoningSummaries: [],
          toolCalls: [],
          filesChanged,
          errors: typeof execRec.error === 'string' && execRec.error ? [execRec.error] : [],
          resourceConsumption: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCostUsd: 0,
            durationMs: typeof exec.durationMs === 'number' ? exec.durationMs : 0,
            source: 'estimated',
          },
          finalOutput: typeof execRec.result === 'string' ? execRec.result : undefined,
          logs,
        };
      }
    } catch {
      // Ignore transient store errors
    }

    return undefined;
  }

  private toSummary(task: ManagedMobileTask): MobileTaskSummary {
    const pendingApprovalIds = this.approvals.pendingForTask(task.taskId);
    const effectiveState: MobileTaskSummary['state'] =
      pendingApprovalIds.length > 0 && task.state === 'running' ? 'blocked' : task.state;
    const effectivePhase: MobileTaskSummary['phase'] =
      effectiveState === 'blocked' ? 'Blocked' : task.phase;
    const startMs = task.startedAt ? Date.parse(task.startedAt) : Date.parse(task.createdAt);
    const endMs = task.completedAt ? Date.parse(task.completedAt) : Date.now();
    const elapsedMs = Math.max(0, endMs - startMs);

    const supportedActions: MobileTaskSummary['supportedActions'] = ['inspect', 'logs'];
    if (effectiveState === 'running' || effectiveState === 'queued' || effectiveState === 'blocked') {
      supportedActions.push('cancel');
    }
    if (effectiveState === 'failed' || effectiveState === 'cancelled') {
      supportedActions.push('retry');
    }
    if (effectiveState === 'blocked') {
      supportedActions.push('resume');
    }

    return {
      taskId: task.taskId,
      executionId: task.executionId,
      jobId: task.jobId,
      title: task.title,
      input: task.input,
      agentId: task.agentId,
      modelId: task.modelId,
      runtimeId: task.runtimeId,
      computerId: task.computerId,
      priority: task.priority,
      state: effectiveState,
      phase: effectivePhase,
      currentOperation: task.currentOperation,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      lastActivityAt: task.lastActivityAt,
      elapsedMs,
      verificationStatus: task.verificationStatus,
      pendingApprovalIds,
      supportedActions,
    };
  }

  private fromAgentProtocolTask(ap: Awaited<ReturnType<ApiState['editorProtocol']['listTasks']>>[number]): MobileTaskSummary {
    const pendingApprovalIds = this.approvals.pendingForTask(ap.task_id);
    const state: MobileTaskSummary['state'] =
      pendingApprovalIds.length > 0 && ap.status === 'running'
        ? 'blocked'
        : ap.status === 'running'
          ? 'running'
          : ap.status === 'created'
            ? 'queued'
            : ap.status === 'paused'
              ? 'blocked'
              : ap.status === 'failed'
                ? 'failed'
                : 'completed';
    const lastStep = ap.steps.at(-1);
    const lastActivityAt = lastStep?.completed_at ?? lastStep?.created_at ?? ap.created_at;
    const elapsedMs = Math.max(0, Date.parse(lastActivityAt) - Date.parse(ap.created_at));
    const outcome = ap.additional_output?.outcome;
    const verificationStatus: MobileTaskSummary['verificationStatus'] =
      outcome === 'VERIFIED' ? 'PASS'
      : lastStep?.additional_output?.outcome === 'VERIFICATION_FAILED' ? 'FAIL'
      : ap.status === 'completed' ? 'UNAVAILABLE'
      : 'PENDING';

    return {
      taskId: ap.task_id,
      title: ap.input.slice(0, 100) || ap.task_id,
      input: ap.input,
      agentId: 'agent-protocol',
      modelId: this.defaultModelId(),
      runtimeId: this.defaultRuntimeId(),
      computerId: process.env.WAZIR_COMPUTER_ID ?? 'local',
      priority: 'normal',
      state,
      phase: state === 'completed' ? 'Completion' : state === 'blocked' ? 'Blocked' : state === 'running' ? 'Tool Calls' : 'Queued',
      currentOperation: lastStep?.name,
      createdAt: ap.created_at,
      startedAt: ap.steps[0]?.created_at,
      completedAt: ap.status === 'completed' || ap.status === 'failed' ? lastActivityAt : undefined,
      lastActivityAt,
      elapsedMs,
      verificationStatus,
      pendingApprovalIds,
      supportedActions: ['inspect', 'logs'],
    };
  }

  private defaultModelId(): string {
    return this.state.models.list()[0]?.id ?? 'local-default';
  }

  private defaultRuntimeId(): string {
    return this.state.runtimes.list()[0]?.id ?? 'ollama';
  }

  /**
   * Submits and executes a real controller task with idempotency, policy validation,
   * resource admission, and live event streaming.
   */
  async submitTask(
    body: {
      input?: string;
      title?: string;
      repository?: string;
      modelId?: string;
      agentId?: string;
      computerId?: string;
      priority?: Priority;
      resourceBudget?: {
        maxTokens?: number;
        maxCostUsd?: number;
        maxExecutionTimeSeconds?: number;
      };
      policy?: {
        localOnly?: boolean;
        networkAccess?: boolean;
        toolAccess?: boolean;
        dataClassification?: 'public' | 'internal' | 'sensitive' | 'restricted';
      };
      operations?: Array<{
        tool?: { name: string; input: Record<string, unknown> };
        verify?: string[];
      }>;
    },
    principal: ProtocolPrincipal,
    idempotencyKey?: string,
  ): Promise<
    | { ok: true; duplicate: boolean; task: MobileTaskDetail }
    | { ok: false; status: number; code: string; error: string }
  > {
    const rawInput = typeof body.input === 'string' ? body.input.trim() : '';
    if (!rawInput) {
      return { ok: false, status: 400, code: 'INVALID_TASK_INPUT', error: 'Task input is required and must be a non-empty string' };
    }
    if (rawInput.length > 50_000) {
      return { ok: false, status: 400, code: 'TASK_INPUT_TOO_LARGE', error: 'Task input exceeds maximum length of 50,000 characters' };
    }

    if (idempotencyKey) {
      const existing = this.idempotencyRecords.get(idempotencyKey);
      if (existing && Date.now() - existing.createdAt < IDEMPOTENCY_TTL_MS) {
        const detail = await this.getTaskDetail(existing.taskId);
        if (detail) {
          return { ok: true, duplicate: true, task: detail };
        }
      }
    }

    // Enforce controller-side resource & policy boundaries (phone cannot bypass limits)
    const maxExecutionTimeSeconds = body.resourceBudget?.maxExecutionTimeSeconds ?? 600;
    if (maxExecutionTimeSeconds <= 0 || maxExecutionTimeSeconds > 3_600) {
      return {
        ok: false,
        status: 400,
        code: 'POLICY_MAX_TIME_INVALID',
        error: 'maxExecutionTimeSeconds must be between 1 and 3600 seconds',
      };
    }
    if (body.resourceBudget?.maxTokens !== undefined && (body.resourceBudget.maxTokens <= 0 || body.resourceBudget.maxTokens > 2_000_000)) {
      return {
        ok: false,
        status: 400,
        code: 'POLICY_BUDGET_INVALID',
        error: 'resourceBudget.maxTokens must be between 1 and 2,000,000 tokens (controller limit)',
      };
    }

    // Validate repository containment
    const requestedRepo = body.repository ? path.resolve(this.options.projectRoot, body.repository) : this.options.projectRoot;
    const relRepo = path.relative(this.options.projectRoot, requestedRepo);
    if (relRepo.startsWith('..') || path.isAbsolute(relRepo)) {
      return {
        ok: false,
        status: 403,
        code: 'POLICY_REPOSITORY_OUTSIDE_ROOT',
        error: `Target repository must stay within controller projectRoot (${this.options.projectRoot})`,
      };
    }

    const localComputerId = process.env.WAZIR_COMPUTER_ID ?? 'local';
    const targetComputerId = body.computerId || localComputerId;
    if (!this.state.computers.get(targetComputerId)) {
      return {
        ok: false,
        status: 404,
        code: 'COMPUTER_NOT_FOUND',
        error: `Execution computer '${targetComputerId}' is not registered`,
      };
    }

    const targetAgentId = body.agentId || this.state.agents.list()[0]?.descriptor.name || 'coding-agent';
    const targetModelId = body.modelId || this.defaultModelId();
    const targetRuntimeId = this.defaultRuntimeId();
    const priority: Priority = body.priority && ['low', 'normal', 'high', 'critical'].includes(body.priority)
      ? body.priority
      : 'normal';

    const coreTask: Task = {
      id: `task-${randomUUID()}`,
      type: 'coding',
      title: (body.title?.trim() || rawInput.slice(0, 80)).slice(0, 120),
      input: rawInput,
      priority,
      status: 'pending',
      createdAt: new Date(),
      requirements: {
        capabilities: ['generalChat'],
        reasoning: 'medium',
        vision: false,
        toolCalling: body.policy?.toolAccess !== false,
        minimumContext: 4096,
        minimumMemoryGB: 1,
        minimumGPUMemoryGB: 0,
        localOnly: body.policy?.localOnly ?? true,
      },
      policy: {
        localOnly: body.policy?.localOnly ?? true,
        networkAccess: body.policy?.networkAccess ?? false,
        toolAccess: body.policy?.toolAccess ?? true,
        dataClassification: body.policy?.dataClassification ?? 'internal',
        maxExecutionTimeSeconds,
        projectRoot: requestedRepo,
      },
      execution: {
        targetComputerId,
        targetModelId,
        targetAgentId,
        targetRuntimeId,
      },
    };

    const policyEval = this.policyEngine.evaluateTask(coreTask);
    if (!policyEval.allowed) {
      return {
        ok: false,
        status: 403,
        code: 'TASK_POLICY_DENIED',
        error: `Policy rejected task: ${policyEval.reasons.join('; ')}`,
      };
    }

    // Reserve resource admission in ledger
    const estInputTokens = Math.max(64, Math.ceil(rawInput.length / 4));
    const estOutputTokens = 256;
    const accountId = this.accounts.candidates({ runtimeId: targetRuntimeId, modelId: targetModelId })[0]?.id
      ?? `local:${targetRuntimeId}`;
    if (!this.accounts.get(accountId)) {
      this.accounts.addImplicit({
        localRuntimes: [targetRuntimeId],
        hostedRuntimes: [],
        agents: [targetAgentId],
        hostedAuthorized: false,
      });
    }
    const admission = this.budget.admit({
      requestId: coreTask.id,
      accountId,
      modelId: targetModelId,
      taskId: coreTask.id,
      workload: 'routine',
      estimatedInputTokens: estInputTokens,
      estimatedOutputTokens: estOutputTokens,
    });
    if (admission.outcome === 'blocked') {
      return {
        ok: false,
        status: 429,
        code: 'RESOURCE_BUDGET_BLOCKED',
        error: `Resource budget denied task: ${admission.reasons.join('; ')}`,
      };
    }

    const job = this.jobManager.create({
      title: coreTask.title ?? coreTask.id,
      description: rawInput,
      priority,
      timeoutSeconds: maxExecutionTimeSeconds,
      tasks: [{ task: coreTask }],
    });
    await this.jobManager.save(job.id);

    const execRecord = await this.executionEngine.create({
      task: coreTask,
      jobId: job.id,
      agentId: targetAgentId,
      computerId: targetComputerId,
      runtimeId: targetRuntimeId,
      modelId: targetModelId,
      workspaceRoot: requestedRepo,
    });

    const nowIso = new Date().toISOString();
    const managed: ManagedMobileTask = {
      taskId: coreTask.id,
      executionId: execRecord.execution.id,
      jobId: job.id,
      title: coreTask.title ?? coreTask.id,
      input: rawInput,
      repository: requestedRepo,
      agentId: targetAgentId,
      modelId: targetModelId,
      runtimeId: targetRuntimeId,
      computerId: targetComputerId,
      priority,
      state: 'queued',
      phase: 'Planning',
      currentOperation: 'Validating task and scheduling resources',
      createdAt: nowIso,
      startedAt: nowIso,
      lastActivityAt: nowIso,
      verificationStatus: 'PENDING',
      policy: coreTask.policy as Record<string, unknown>,
      resourceBudget: body.resourceBudget,
      timeline: [
        {
          id: `tl-${randomUUID()}`,
          phase: 'Planning',
          title: 'Task submitted and admitted by PolicyEngine & ResourceLedger',
          status: 'completed',
          timestamp: nowIso,
          detail: `Scheduled on ${targetComputerId} using ${targetAgentId} (${targetModelId})`,
        },
      ],
      reasoningSummaries: [
        `Selected agent '${targetAgentId}' with model '${targetModelId}' on computer '${targetComputerId}'.`,
      ],
      toolCalls: [],
      filesChanged: [],
      errors: [],
      resourceConsumption: {
        inputTokens: estInputTokens,
        outputTokens: 0,
        totalTokens: estInputTokens,
        estimatedCostUsd: 0,
        durationMs: 0,
        source: 'estimated',
      },
      logs: [],
      plannedOperations: body.operations,
    };

    this.appendLog(managed, 'info', 'Planning', `Task '${managed.title}' created (${managed.taskId})`);
    await this.saveTask(managed);

    if (idempotencyKey) {
      const record = { taskId: managed.taskId, createdAt: Date.now() };
      this.idempotencyRecords.set(idempotencyKey, record);
      await this.state.store.put(`mobile/idempotency/${idempotencyKey}`, record);
    }

    await this.eventHub.publish({
      type: 'task.created',
      taskId: managed.taskId,
      executionId: managed.executionId,
      computerId: managed.computerId,
      agentId: managed.agentId,
      modelId: managed.modelId,
      status: 'queued',
      summary: `Task created: ${managed.title}`,
      payload: { taskId: managed.taskId, title: managed.title, state: managed.state, phase: managed.phase },
    });

    // Launch asynchronous execution pipeline
    void this.runManagedTask(managed, principal, accountId, estInputTokens);

    const detail = (await this.getTaskDetail(managed.taskId))!;
    return { ok: true, duplicate: false, task: detail };
  }

  private async runManagedTask(
    task: ManagedMobileTask,
    principal: ProtocolPrincipal,
    accountId: string,
    estInputTokens: number,
  ): Promise<void> {
    const abortController = new AbortController();
    this.activeAbortControllers.set(task.taskId, abortController);
    const startedMs = Date.now();

    try {
      task.state = 'running';
      task.phase = 'Agent Execution';
      task.currentOperation = `Agent ${task.agentId} initializing execution`;
      this.appendLog(task, 'info', 'Agent Execution', `Agent '${task.agentId}' started with model '${task.modelId}'`);
      task.timeline.push({
        id: `tl-${randomUUID()}`,
        phase: 'Agent Execution',
        title: `Agent ${task.agentId} started task`,
        status: 'running',
        timestamp: new Date().toISOString(),
      });
      await this.executionEngine.setStatus(task.executionId, 'running');
      await this.saveTask(task);

      await this.eventHub.publish({
        type: 'task.started',
        taskId: task.taskId,
        executionId: task.executionId,
        computerId: task.computerId,
        agentId: task.agentId,
        modelId: task.modelId,
        status: 'running',
        summary: `Agent ${task.agentId} started task '${task.title}'`,
        payload: { phase: task.phase, modelId: task.modelId, agentId: task.agentId },
      });

      await this.eventHub.publish({
        type: 'model.selected',
        taskId: task.taskId,
        executionId: task.executionId,
        computerId: task.computerId,
        modelId: task.modelId,
        status: 'running',
        summary: `Model selected: ${task.modelId} (${task.runtimeId})`,
        payload: { modelId: task.modelId, runtimeId: task.runtimeId },
      });

      const operations = task.plannedOperations?.length
        ? task.plannedOperations
        : [{ tool: { name: 'read', input: { path: 'package.json' } } }];

      for (const op of operations) {
        if (abortController.signal.aborted) {
          throw new Error('TASK_CANCELLED');
        }

        if (op.tool) {
          task.phase = 'Tool Calls';
          task.currentOperation = `Executing tool: ${op.tool.name}`;
          this.appendLog(task, 'info', 'Tool Calls', `Dispatching tool '${op.tool.name}'`);
          await this.saveTask(task);

          await this.eventHub.publish({
            type: 'tool.started',
            taskId: task.taskId,
            executionId: task.executionId,
            computerId: task.computerId,
            agentId: task.agentId,
            status: 'running',
            summary: `Tool started: ${op.tool.name}`,
            payload: { tool: op.tool.name, input: redactSensitiveArguments(op.tool.input) },
          });

          const toolResult = await this.options.executeTool({
            name: op.tool.name,
            input: op.tool.input,
            principal,
            executionId: task.executionId,
            source: 'agent-protocol',
            taskId: task.taskId,
            signal: abortController.signal,
          });

          if (abortController.signal.aborted || toolResult.failureClass === 'CANCELLED') {
            throw new Error('TASK_CANCELLED');
          }

          const tcRecord: MobileTaskDetail['toolCalls'][number] = {
            callId: toolResult.callId || `call-${randomUUID()}`,
            tool: op.tool.name,
            status: toolResult.ok
              ? 'succeeded'
              : toolResult.failureClass === 'POLICY_DENIED'
                ? 'denied'
                : 'failed',
            input: redactSensitiveArguments(op.tool.input) as Record<string, unknown>,
            output: toolResult.output ? toolResult.output.slice(0, 4_000) : undefined,
            error: toolResult.error,
            durationMs: toolResult.durationMs,
            timestamp: new Date().toISOString(),
          };
          task.toolCalls.push(tcRecord);

          if (Array.isArray(toolResult.fileMutations)) {
            for (const m of toolResult.fileMutations as Array<{ path?: string }>) {
              if (m?.path && !task.filesChanged.includes(m.path)) {
                task.filesChanged.push(m.path);
              }
            }
          }

          task.timeline.push({
            id: tcRecord.callId,
            phase: 'Tool Calls',
            title: `Tool ${op.tool.name} (${tcRecord.status})`,
            status: toolResult.ok ? 'completed' : 'failed',
            timestamp: tcRecord.timestamp,
            durationMs: toolResult.durationMs,
            detail: toolResult.error ?? toolResult.output?.slice(0, 300),
          });

          if (!toolResult.ok) {
            this.appendLog(task, 'error', 'Tool Calls', `Tool '${op.tool.name}' failed: ${toolResult.error ?? toolResult.failureClass}`);
            await this.eventHub.publish({
              type: 'tool.failed',
              taskId: task.taskId,
              executionId: task.executionId,
              computerId: task.computerId,
              status: 'failed',
              summary: `Tool failed: ${op.tool.name} (${toolResult.failureClass ?? 'error'})`,
              payload: { toolCall: tcRecord },
            });
            throw new Error(toolResult.error ?? `Tool '${op.tool.name}' failed`);
          }

          this.appendLog(task, 'info', 'Tool Calls', `Tool '${op.tool.name}' completed in ${toolResult.durationMs}ms`);
          await this.eventHub.publish({
            type: 'tool.executed',
            taskId: task.taskId,
            executionId: task.executionId,
            computerId: task.computerId,
            status: 'running',
            summary: `Tool executed: ${op.tool.name} (${toolResult.durationMs}ms)`,
            payload: { toolCall: tcRecord },
          });
        }

        if (op.verify?.length) {
          task.phase = 'Verification';
          task.currentOperation = `Running verification checks: ${op.verify.join(', ')}`;
          this.appendLog(task, 'info', 'Verification', `Running checks: ${op.verify.join(', ')}`);
          await this.saveTask(task);

          const report = await this.options.verify({
            checks: op.verify,
            principal,
            executionId: task.executionId,
            taskId: task.taskId,
            stepId: `step-verify-${randomUUID()}`,
            signal: abortController.signal,
          });

          task.verificationStatus = report.status;
          task.verificationReport = {
            status: report.status,
            checks: report.checks.map((c) => ({
              name: c.name,
              status: c.status,
              durationMs: c.durationMs,
              output: c.output,
              error: c.error,
            })),
            reasons: report.reasons,
            workspaceRevision: report.workspaceRevision,
            completedAt: report.completedAt,
          };

          task.timeline.push({
            id: `tl-ver-${randomUUID()}`,
            phase: 'Verification',
            title: `Verification ${report.status}`,
            status: report.status === 'PASS' ? 'completed' : 'failed',
            timestamp: report.completedAt,
            detail: report.reasons.join('; ') || `${report.checks.length} check(s) passed`,
          });

          if (report.status !== 'PASS') {
            this.appendLog(task, 'error', 'Verification', `Verification failed: ${report.reasons.join('; ')}`);
            await this.eventHub.publish({
              type: 'verification.failed',
              taskId: task.taskId,
              executionId: task.executionId,
              computerId: task.computerId,
              status: 'failed',
              summary: `Verification failed: ${report.reasons.join('; ')}`,
              payload: { verification: task.verificationReport },
            });
            throw new Error(`Verification failed: ${report.reasons.join('; ')}`);
          }

          this.appendLog(task, 'info', 'Verification', `Verification PASS (${report.checks.length} check(s))`);
          await this.eventHub.publish({
            type: 'verification.passed',
            taskId: task.taskId,
            executionId: task.executionId,
            computerId: task.computerId,
            status: 'running',
            summary: `Verification passed (${report.checks.length} check(s))`,
            payload: { verification: task.verificationReport },
          });
        }
      }

      const durationMs = Math.max(1, Date.now() - startedMs);
      const outputSummary = task.toolCalls.length > 0
        ? `Executed ${task.toolCalls.length} tool call(s) on ${task.computerId}.\nLast output:\n${task.toolCalls.at(-1)?.output ?? '(no output)'}`
        : `Completed task: ${task.title}`;
      const outTokens = Math.max(32, Math.ceil(outputSummary.length / 4));

      task.state = 'completed';
      task.phase = 'Completion';
      task.currentOperation = 'Completed';
      task.completedAt = new Date().toISOString();
      task.finalOutput = outputSummary;
      if (task.verificationStatus === 'PENDING') {
        task.verificationStatus = 'UNAVAILABLE';
      }
      task.resourceConsumption = {
        inputTokens: estInputTokens,
        outputTokens: outTokens,
        totalTokens: estInputTokens + outTokens,
        estimatedCostUsd: 0,
        durationMs,
        source: 'estimated',
      };
      task.timeline.push({
        id: `tl-done-${randomUUID()}`,
        phase: 'Completion',
        title: 'Task completed',
        status: 'completed',
        timestamp: task.completedAt,
        durationMs,
      });
      this.appendLog(task, 'info', 'Completion', `Task completed in ${durationMs}ms`);

      this.ledger.settle({
        requestId: task.taskId,
        accountId,
        modelId: task.modelId,
        taskId: task.taskId,
        agent: task.agentId,
        workload: 'routine',
        inputTokens: estInputTokens,
        outputTokens: outTokens,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        requests: 1,
        costUsd: 0,
        source: 'estimated',
        at: Date.now(),
        durationMs,
        local: true,
      });

      await this.executionEngine.setStatus(task.executionId, 'completed').catch(() => undefined);
      await this.saveTask(task);

      await this.eventHub.publish({
        type: 'task.completed',
        taskId: task.taskId,
        executionId: task.executionId,
        computerId: task.computerId,
        agentId: task.agentId,
        modelId: task.modelId,
        status: 'completed',
        summary: `Task completed: ${task.title}`,
        payload: {
          taskId: task.taskId,
          durationMs,
          verificationStatus: task.verificationStatus,
        },
      });
    } catch (error) {
      const durationMs = Math.max(1, Date.now() - startedMs);
      const isCancelled = abortController.signal.aborted || (error instanceof Error && error.message === 'TASK_CANCELLED');
      const message = error instanceof Error ? error.message : String(error);

      task.state = isCancelled ? 'cancelled' : 'failed';
      task.phase = 'Completion';
      task.currentOperation = isCancelled ? 'Cancelled by operator' : 'Execution failed';
      task.completedAt = new Date().toISOString();
      if (!isCancelled) {
        task.errors.push(message);
      }
      task.resourceConsumption.durationMs = durationMs;
      task.timeline.push({
        id: `tl-err-${randomUUID()}`,
        phase: 'Completion',
        title: isCancelled ? 'Task cancelled' : 'Task failed',
        status: isCancelled ? 'cancelled' : 'failed',
        timestamp: task.completedAt,
        durationMs,
        detail: message,
      });
      this.appendLog(task, isCancelled ? 'warn' : 'error', 'Completion', isCancelled ? 'Task cancelled by user' : `Task failed: ${message}`);

      this.ledger.release(task.taskId, isCancelled ? 'cancelled' : 'failed');
      await this.executionEngine.setStatus(task.executionId, isCancelled ? 'cancelled' : 'failed').catch(() => undefined);
      await this.saveTask(task);

      await this.eventHub.publish({
        type: isCancelled ? 'task.cancelled' : 'task.failed',
        taskId: task.taskId,
        executionId: task.executionId,
        computerId: task.computerId,
        agentId: task.agentId,
        modelId: task.modelId,
        status: task.state,
        summary: isCancelled ? `Task cancelled: ${task.title}` : `Task failed: ${task.title} — ${message}`,
        payload: { taskId: task.taskId, error: message, state: task.state },
      });
    } finally {
      this.activeAbortControllers.delete(task.taskId);
    }
  }

  async cancelTask(taskId: string, resolvedBy: string): Promise<
    | { ok: true; task: MobileTaskDetail }
    | { ok: false; status: number; code: string; error: string }
  > {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { ok: false, status: 404, code: 'TASK_NOT_FOUND', error: `Task '${taskId}' not found` };
    }
    if (task.state === 'cancelled') {
      return { ok: true, task: (await this.getTaskDetail(taskId))! };
    }
    if (task.state === 'completed' || task.state === 'failed') {
      return { ok: false, status: 409, code: 'TASK_ALREADY_TERMINAL', error: `Task '${taskId}' is already ${task.state}` };
    }

    // Also reject any pending approvals for this task so it unblocks immediately
    for (const approvalId of this.approvals.pendingForTask(taskId)) {
      await this.approvals.resolveApproval({
        id: approvalId,
        decision: 'reject',
        resolvedBy,
        note: 'Parent task was cancelled',
      });
    }

    const controller = this.activeAbortControllers.get(taskId);
    task.state = 'cancelled';
    task.phase = 'Completion';
    task.currentOperation = 'Cancelled by operator';
    task.completedAt = new Date().toISOString();
    this.appendLog(task, 'warn', 'Completion', `Cancelled by ${resolvedBy}`);
    await this.saveTask(task);
    if (controller) {
      controller.abort();
    }

    // Brief yield to allow abort handler to flush
    await new Promise((r) => setTimeout(r, 25));
    return { ok: true, task: (await this.getTaskDetail(taskId))! };
  }

  async retryTask(taskId: string, principal: ProtocolPrincipal): Promise<
    | { ok: true; task: MobileTaskDetail }
    | { ok: false; status: number; code: string; error: string }
  > {
    const existing = this.tasks.get(taskId);
    if (!existing) {
      return { ok: false, status: 404, code: 'TASK_NOT_FOUND', error: `Task '${taskId}' not found` };
    }
    if (existing.state !== 'failed' && existing.state !== 'cancelled') {
      return {
        ok: false,
        status: 409,
        code: 'TASK_NOT_RETRYABLE',
        error: `Only failed or cancelled tasks can be retried (current state: '${existing.state}')`,
      };
    }

    const res = await this.submitTask(
      {
        input: existing.input,
        title: `${existing.title} (retry)`,
        repository: existing.repository,
        modelId: existing.modelId,
        agentId: existing.agentId,
        computerId: existing.computerId,
        priority: existing.priority,
        resourceBudget: existing.resourceBudget,
        policy: existing.policy as Record<string, unknown>,
        operations: existing.plannedOperations,
      },
      principal,
    );
    if ('error' in res) return res;
    return { ok: true, task: res.task };
  }

  async resumeTask(taskId: string, resolvedBy: string): Promise<
    | { ok: true; task: MobileTaskDetail }
    | { ok: false; status: number; code: string; error: string }
  > {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { ok: false, status: 404, code: 'TASK_NOT_FOUND', error: `Task '${taskId}' not found` };
    }
    const pendingApprovals = this.approvals.pendingForTask(taskId);
    if (pendingApprovals.length > 0) {
      return {
        ok: false,
        status: 409,
        code: 'TASK_AWAITING_APPROVAL',
        error: `Task '${taskId}' is blocked on pending approval(s): ${pendingApprovals.join(', ')}. Approve or reject them in the Human Approval Center.`,
      };
    }
    if (task.state !== 'blocked') {
      return {
        ok: false,
        status: 409,
        code: 'TASK_NOT_BLOCKED',
        error: `Task '${taskId}' is in state '${task.state}' and cannot be resumed`,
      };
    }
    task.state = 'running';
    task.phase = 'Agent Execution';
    this.appendLog(task, 'info', 'Agent Execution', `Task resumed by ${resolvedBy}`);
    await this.saveTask(task);
    await this.eventHub.publish({
      type: 'task.resumed',
      taskId: task.taskId,
      executionId: task.executionId,
      status: 'running',
      summary: `Task resumed: ${task.title}`,
      payload: { taskId: task.taskId },
    });
    return { ok: true, task: (await this.getTaskDetail(taskId))! };
  }

  async getDashboardSnapshot() {
    const tasks = await this.listAllTasks();
    const runningTasks = tasks.filter((t) => t.state === 'running').length;
    const queuedTasks = tasks.filter((t) => t.state === 'queued').length;
    const completedTasks = tasks.filter((t) => t.state === 'completed').length;
    const failedTasks = tasks.filter((t) => t.state === 'failed').length;
    const blockedTasks = tasks.filter((t) => t.state === 'blocked').length;
    const pendingApprovals = this.approvals.pendingCount;

    const computers = this.state.computers.list();
    const onlineComputers = this.state.computers.listOnline();
    const instances = this.state.lifecycle.list();
    const loadedModels = instances.filter((i) => i.loaded || i.state === 'LOADED').length;
    const installedModels = this.state.models.list().length;
    const resourceSnapshot = this.getResourceSnapshot();

    return {
      controller: {
        id: process.env.WAZIR_COMPUTER_ID ?? 'local',
        hostname: os.hostname(),
        version: CONTROLLER_VERSION,
        apiVersion: MOBILE_API_VERSION,
        timestamp: new Date().toISOString(),
      },
      cards: {
        runningTasks,
        queuedTasks,
        completedTasks,
        failedTasks,
        tasksRequiringApproval: Math.max(blockedTasks, pendingApprovals),
        connectedWorkers: onlineComputers.length,
        totalComputers: computers.length,
        activeModels: loadedModels,
        availableModels: installedModels,
        resourceStatus: {
          mode: resourceSnapshot.overallMode,
          emergencyStop: Boolean(resourceSnapshot.emergencyStop),
          inFlightRequests: resourceSnapshot.totals.activeReservations,
          totalTokensConsumed: resourceSnapshot.totals.totalTokens,
          estimatedCostUsd: resourceSnapshot.totals.totalCostUsd,
        },
      },
      recentActivity: this.eventHub.listRecent(30),
    };
  }

  async getComputersAndWorkers() {
    const computers = this.state.computers.list();
    const tasks = await this.listAllTasks();
    const instances = this.state.lifecycle.list();
    const dispatchedAssignments = await this.state.dispatcher.assignments();

    const enriched = computers.map((comp) => {
      const runningOnComp = tasks.filter(
        (t) => t.computerId === comp.id && (t.state === 'running' || t.state === 'queued' || t.state === 'blocked'),
      );
      const modelInstances = instances.filter((i) => i.computerId === comp.id);
      const activeDispatches = dispatchedAssignments.filter((a) => a.computerId === comp.id);
      const gpu = comp.hardware?.gpu;
      const gpus = gpu ? [gpu] : [];
      const load = comp.load;

      return {
        id: comp.id,
        name: comp.name,
        type: comp.type,
        local: comp.local,
        status: comp.status,
        lastHeartbeat: comp.lastHeartbeat,
        sseConnected: comp.local ? true : this.state.dispatcher.isConnected(comp.id),
        os: comp.os,
        hardware: {
          cpuModel: comp.hardware?.cpu ?? null,
          cpuCores: comp.hardware?.cpuCores ?? null,
          memoryTotalGB: comp.hardware?.memoryGB ?? null,
          unifiedMemory: comp.hardware?.gpu?.unifiedMemory ?? false,
          gpus: gpus.map((g) => ({
            vendor: g.vendor,
            model: g.model,
            vramGB: g.memoryGB ?? null,
            unifiedMemory: g.unifiedMemory ?? false,
            cuda: g.cuda ?? false,
          })),
        },
        telemetry: {
          cpuUtilizationPercent: typeof load?.cpuPercent === 'number' ? load.cpuPercent : null,
          memoryUsedGB: typeof load?.memoryUsedGB === 'number' ? load.memoryUsedGB : null,
          memoryTotalGB: typeof comp.hardware?.memoryGB === 'number' ? comp.hardware.memoryGB : null,
          // Never synthesize GPU utilization percentages when hardware telemetry is unavailable
          gpuUtilizationPercent: typeof load?.gpuUtilizationPercent === 'number'
            ? load.gpuUtilizationPercent
            : null,
          gpuMemoryUsedGB: typeof load?.gpuMemoryUsedGB === 'number' ? load.gpuMemoryUsedGB : null,
          gpuMemoryTotalGB: gpus.length > 0 && gpus.every((g) => typeof g.memoryGB === 'number')
            ? gpus.reduce((sum, g) => sum + (g.memoryGB ?? 0), 0)
            : null,
          telemetryAvailable: Boolean(load),
        },
        workers: [
          {
            id: `worker-${comp.id}`,
            computerId: comp.id,
            name: comp.name,
            status: comp.status,
            sseConnected: comp.local ? true : this.state.dispatcher.isConnected(comp.id),
            runtimes: comp.runtimes ?? [],
            models: comp.models ?? [],
            lastHeartbeat: comp.lastHeartbeat,
          },
        ],
        runningTasks: runningOnComp,
        activeDispatches,
        modelAssignments: modelInstances.map((inst) => ({
          instanceId: inst.id,
          modelId: inst.modelId,
          runtimeId: inst.runtimeId,
          loaded: inst.loaded,
          state: inst.state ?? (inst.loaded ? 'LOADED' : 'INSTALLED'),
          health: inst.health,
          pinned: Boolean(inst.pinned),
          contextTokens: inst.contextTokens,
          estimatedMemoryBytes: inst.residentMemoryBytes,
        })),
      };
    });

    return {
      computers: enriched,
      timestamp: new Date().toISOString(),
    };
  }

  getResourceSnapshot() {
    this.ledger.recoverExpired();
    const nowMs = this.ledger.now();

    const usageRows = this.ledger.db
      .prepare('SELECT * FROM usage ORDER BY at DESC LIMIT 500')
      .all() as Array<Record<string, unknown>>;
    const activeReservations = this.ledger.db
      .prepare(`SELECT * FROM reservations WHERE status = 'active' AND lease_expires_at > ? ORDER BY created_at DESC`)
      .all(nowMs) as Array<Record<string, unknown>>;

    let localTokens = 0;
    let hostedTokens = 0;
    let localRequests = 0;
    let hostedRequests = 0;
    let providerReportedTokens = 0;
    let estimatedTokens = 0;
    let conservativeTokens = 0;
    let providerReportedCostUsd = 0;
    let estimatedCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let totalReasoningTokens = 0;

    for (const r of usageRows) {
      const inp = Number(r.input_tokens ?? 0);
      const out = Number(r.output_tokens ?? 0);
      const cached = Number(r.cached_input_tokens ?? 0);
      const reasoning = Number(r.reasoning_tokens ?? 0);
      const cost = Number(r.cost_usd ?? 0);
      const reqs = Number(r.requests ?? 1);
      const isLocal = Number(r.local ?? 0) === 1;
      const source = String(r.source ?? 'estimated');
      const tok = inp + out;

      totalInputTokens += inp;
      totalOutputTokens += out;
      totalCachedTokens += cached;
      totalReasoningTokens += reasoning;

      if (isLocal) {
        localTokens += tok;
        localRequests += reqs;
      } else {
        hostedTokens += tok;
        hostedRequests += reqs;
      }

      if (source === 'provider-reported') {
        providerReportedTokens += tok;
        providerReportedCostUsd += cost;
      } else if (source === 'conservative') {
        conservativeTokens += tok;
        estimatedCostUsd += cost;
      } else {
        estimatedTokens += tok;
        estimatedCostUsd += cost;
      }
    }

    const accountStatuses: AccountStatus[] = [];
    for (const acc of this.accounts.list()) {
      const st = this.budget.status(acc.id, nowMs);
      if (st) accountStatuses.push(st);
    }

    const warnings: Array<{ severity: 'warning' | 'critical'; accountId?: string; message: string }> = [];
    const emergencyStop = this.budget.stopped();
    if (emergencyStop) {
      warnings.push({
        severity: 'critical',
        message: `Emergency stop active: ${emergencyStop.reason} (only local inference is permitted)`,
      });
    }

    let overallMode = 'normal';
    for (const st of accountStatuses) {
      if (st.health !== 'ok') {
        warnings.push({
          severity: st.health === 'auth_blocked' || st.health === 'quota_blocked' ? 'critical' : 'warning',
          accountId: st.account.id,
          message: `Account '${st.account.id}' is ${st.health}${st.healthReason ? `: ${st.healthReason}` : ''}`,
        });
      }
      if (st.mode === 'advisory' || st.mode === 'conserve' || st.mode === 'critical' || st.mode === 'exhausted') {
        overallMode = st.mode;
        warnings.push({
          severity: st.mode === 'critical' || st.mode === 'exhausted' ? 'critical' : 'warning',
          accountId: st.account.id,
          message: `Account '${st.account.id}' budget is in '${st.mode}' mode`,
        });
      }
    }

    return {
      timestamp: new Date(nowMs).toISOString(),
      overallMode,
      emergencyStop: emergencyStop ?? null,
      policy: {
        enforce: this.budget.policy.enforce,
        paidApiFallback: this.budget.policy.paidApiFallback,
        dailySpendLimitUsd: this.budget.policy.dailySpendUsd,
        monthlySpendLimitUsd: this.budget.policy.monthlySpendUsd,
        maxTaskTokens: this.budget.policy.maxTaskTokens,
      },
      totals: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cachedInputTokens: totalCachedTokens,
        reasoningTokens: totalReasoningTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        totalCostUsd: providerReportedCostUsd + estimatedCostUsd,
        providerReportedCostUsd,
        estimatedCostUsd,
        activeReservations: activeReservations.length,
      },
      localVsHosted: {
        localTokens,
        hostedTokens,
        localRequests,
        hostedRequests,
      },
      usageBySource: {
        providerReportedTokens,
        estimatedTokens,
        conservativeTokens,
      },
      reservations: activeReservations.map((r) => ({
        id: String(r.id),
        requestId: String(r.request_id),
        accountId: String(r.account_id),
        modelId: String(r.model_id),
        taskId: r.task_id ? String(r.task_id) : undefined,
        workload: String(r.workload),
        estimatedInputTokens: Number(r.est_input ?? 0),
        estimatedOutputTokens: Number(r.est_output ?? 0),
        estimatedCostUsd: Number(r.est_cost ?? 0),
        createdAt: new Date(Number(r.created_at)).toISOString(),
        leaseExpiresAt: new Date(Number(r.lease_expires_at)).toISOString(),
        local: Number(r.local) === 1,
      })),
      accounts: accountStatuses.map((s) => ({
        id: s.account.id,
        kind: s.account.kind,
        provider: s.account.provider,
        enabled: s.account.enabled !== false,
        health: s.health,
        healthUntil: s.healthUntil ? new Date(s.healthUntil).toISOString() : undefined,
        healthReason: s.healthReason,
        throttlingMode: s.mode,
        inFlight: s.inFlight,
        limits: s.limits.map((l) => ({
          unit: l.unit,
          window: l.window,
          limit: l.limit,
          source: l.source,
          used: l.used,
          reserved: l.reserved,
          remaining: l.limit !== null ? Math.max(0, l.limit - l.used - l.reserved) : null,
          utilizationPercent: l.utilization !== undefined ? Math.round(l.utilization * 100) : null,
          mode: l.mode,
          windowEnd: l.windowEnd ? new Date(l.windowEnd).toISOString() : undefined,
        })),
      })),
      warnings,
    };
  }
}

export function registerMobileRoutes(app: Express, state: ApiState, mobile: MobileServices): void {
  const { auth } = state;

  // 1. Public pairing endpoints (rate-limited & single-use secret gated)
  app.post('/api/v1/mobile/pair/request', async (req, res) => {
    const { sessionId, pairingSecret, deviceId, deviceName, deviceModel, osVersion, publicKeyFingerprint } = req.body ?? {};
    if (!sessionId || !pairingSecret || !deviceName) {
      res.status(400).json({ error: 'sessionId, pairingSecret, and deviceName are required', code: 'INVALID_REQUEST' });
      return;
    }
    const result = await mobile.pairing.requestPairing({
      sessionId: String(sessionId),
      pairingSecret: String(pairingSecret),
      deviceId: typeof deviceId === 'string' ? deviceId : undefined,
      deviceName: String(deviceName),
      deviceModel: typeof deviceModel === 'string' ? deviceModel : undefined,
      osVersion: typeof osVersion === 'string' ? osVersion : undefined,
      publicKeyFingerprint: typeof publicKeyFingerprint === 'string' ? publicKeyFingerprint : undefined,
    });
    if ('error' in result) {
      res.status(Number(result.status)).json({ error: result.error, code: result.code });
      return;
    }
    res.status(202).json(result);
  });

  app.post('/api/v1/mobile/pair/complete', async (req, res) => {
    const { sessionId, pairingSecret } = req.body ?? {};
    if (!sessionId || !pairingSecret) {
      res.status(400).json({ error: 'sessionId and pairingSecret are required', code: 'INVALID_REQUEST' });
      return;
    }
    const result = await mobile.pairing.completePairing({
      sessionId: String(sessionId),
      pairingSecret: String(pairingSecret),
    });
    if ('error' in result) {
      res.status(Number(result.status)).json({ error: result.error, code: result.code });
      return;
    }
    res.status(result.status === 'approved' ? 200 : 202).json(result);
  });

  app.post('/api/v1/mobile/auth/rotate', async (req, res) => {
    const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
    if (!refreshToken) {
      res.status(400).json({ error: 'refreshToken is required', code: 'INVALID_REQUEST' });
      return;
    }
    const rotated = await auth.rotateMobileDeviceCredential(refreshToken);
    if (!rotated) {
      auth.recordAuthFailure();
      res.status(401).json({ error: 'Invalid or revoked refresh token', code: 'INVALID_REFRESH_TOKEN' });
      return;
    }
    res.json({
      ok: true,
      deviceId: rotated.deviceId,
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      expiresAt: rotated.expiresAt,
      scopes: rotated.scopes,
    });
  });

  // 2. Operator pairing session management (used by `wa mobile pair` CLI)
  app.post('/api/v1/mobile/pair/sessions', auth.requireOperator, async (req, res) => {
    const scopes = Array.isArray(req.body?.scopes) ? (req.body.scopes as ProtocolScope[]) : undefined;
    const controllerUrl = typeof req.body?.controllerUrl === 'string' ? req.body.controllerUrl : undefined;
    const tlsCertFingerprint = typeof req.body?.tlsCertFingerprint === 'string' ? req.body.tlsCertFingerprint : undefined;
    const session = await mobile.pairing.createSession({ scopes, controllerUrl, tlsCertFingerprint });
    res.status(201).json(session);
  });

  app.get('/api/v1/mobile/pair/sessions/:id', auth.requireOperator, (req, res) => {
    const session = mobile.pairing.getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: 'Pairing session not found', code: 'PAIRING_SESSION_NOT_FOUND' });
      return;
    }
    res.json(session);
  });

  app.post('/api/v1/mobile/pair/sessions/:id/approve', auth.requireOperator, async (req, res) => {
    const result = await mobile.pairing.approveSession({
      sessionId: String(req.params.id),
      confirmationCode: typeof req.body?.confirmationCode === 'string' ? req.body.confirmationCode : undefined,
      scopes: Array.isArray(req.body?.scopes) ? (req.body.scopes as ProtocolScope[]) : undefined,
    });
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.json(result);
  });

  app.post('/api/v1/mobile/pair/sessions/:id/reject', auth.requireOperator, async (req, res) => {
    const ok = await mobile.pairing.rejectSession(String(req.params.id));
    if (!ok) {
      res.status(404).json({ error: 'Pairing session not found', code: 'PAIRING_SESSION_NOT_FOUND' });
      return;
    }
    res.json({ ok: true });
  });

  // 3. Authenticated mobile device management & version handshake
  app.get('/api/v1/mobile/handshake', auth.requireProtocolPrincipal, (req, res) => {
    const clientVersion = String(req.headers['x-wazir-mobile-version'] ?? req.query.clientVersion ?? MOBILE_API_VERSION);
    const principal = res.locals.principal as ProtocolPrincipal;
    res.json({
      compatible: true,
      apiVersion: MOBILE_API_VERSION,
      minMobileVersion: MIN_SUPPORTED_MOBILE_VERSION,
      controllerVersion: CONTROLLER_VERSION,
      clientVersion,
      controllerId: process.env.WAZIR_COMPUTER_ID ?? 'local',
      hostname: os.hostname(),
      principal: {
        id: principal.id,
        kind: principal.kind,
        scopes: principal.scopes,
      },
      features: {
        sseEvents: true,
        durableApprovals: true,
        biometricHighRiskApprovals: true,
        modelLifecycle: true,
        resourceLedger: true,
        multiController: true,
      },
    });
  });

  app.post('/api/v1/mobile/auth/unpair', auth.requireProtocolPrincipal, async (_req, res) => {
    const principal = res.locals.principal as ProtocolPrincipal;
    if (principal.id.startsWith('mobile:')) {
      const deviceId = principal.id.slice('mobile:'.length);
      await auth.revokeMobileDevice(deviceId);
      res.json({ ok: true, revokedDeviceId: deviceId });
      return;
    }
    res.json({ ok: true });
  });

  // Operator-only, deliberately not device-reachable: this lists every paired device
  // (names, scopes, last-seen) — a phone must not be able to enumerate other phones
  // paired to the same controller.
  app.get('/api/v1/mobile/devices', auth.requireViewerOrOperator, (_req, res) => {
    res.json({ devices: auth.listMobileDevices() });
  });

  app.delete('/api/v1/mobile/devices/:deviceId', auth.requireOperator, async (req, res) => {
    const revoked = await auth.revokeMobileDevice(String(req.params.deviceId));
    if (!revoked) {
      res.status(404).json({ error: `Device '${req.params.deviceId}' not found`, code: 'DEVICE_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, deviceId: req.params.deviceId });
  });

  // 4. Dashboard & Live Event Stream
  app.get('/api/v1/mobile/dashboard', auth.requireViewerOperatorOrDevice, async (_req, res) => {
    res.json(await mobile.getDashboardSnapshot());
  });

  app.get('/api/v1/mobile/events', auth.requireViewerOperatorOrDevice, (req, res) => {
    mobile.eventHub.subscribeSse(req, res);
  });

  app.get('/api/v1/mobile/events/recent', auth.requireViewerOperatorOrDevice, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : undefined;
    res.json({
      cursor: mobile.eventHub.latestCursor,
      events: mobile.eventHub.listRecent(limit, taskId),
    });
  });

  // 5. Task Management & Submission
  app.get('/api/v1/mobile/tasks', auth.requireViewerOperatorOrDevice, async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const tasks = await mobile.listAllTasks(status);
    res.json({ tasks, timestamp: new Date().toISOString() });
  });

  app.get('/api/v1/mobile/tasks/:id', auth.requireViewerOperatorOrDevice, async (req, res) => {
    const detail = await mobile.getTaskDetail(String(req.params.id));
    if (!detail) {
      res.status(404).json({ error: `Task '${req.params.id}' not found`, code: 'TASK_NOT_FOUND' });
      return;
    }
    res.json({ task: detail });
  });

  app.get('/api/v1/mobile/tasks/:id/logs', auth.requireViewerOperatorOrDevice, async (req, res) => {
    const detail = await mobile.getTaskDetail(String(req.params.id));
    if (!detail) {
      res.status(404).json({ error: `Task '${req.params.id}' not found`, code: 'TASK_NOT_FOUND' });
      return;
    }
    res.json({ taskId: detail.taskId, logs: detail.logs });
  });

  app.post('/api/v1/mobile/tasks', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, async (req, res) => {
    const principal = res.locals.principal as ProtocolPrincipal;
    const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
      ? req.headers['idempotency-key'].trim()
      : typeof req.body?.idempotencyKey === 'string'
        ? req.body.idempotencyKey.trim()
        : undefined;
    const result = await mobile.submitTask(req.body ?? {}, principal, idempotencyKey);
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.status(result.duplicate ? 200 : 201).json({
      taskId: result.task.taskId,
      duplicate: result.duplicate,
      task: result.task,
    });
  });

  app.post('/api/v1/mobile/tasks/:id/cancel', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, async (req, res) => {
    const principal = res.locals.principal as ProtocolPrincipal;
    const result = await mobile.cancelTask(String(req.params.id), principal.id);
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.json({ ok: true, task: result.task });
  });

  app.post('/api/v1/mobile/tasks/:id/retry', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, async (req, res) => {
    const principal = res.locals.principal as ProtocolPrincipal;
    const result = await mobile.retryTask(String(req.params.id), principal);
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.status(201).json({ ok: true, task: result.task });
  });

  app.post('/api/v1/mobile/tasks/:id/resume', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, async (req, res) => {
    const principal = res.locals.principal as ProtocolPrincipal;
    const result = await mobile.resumeTask(String(req.params.id), principal.id);
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.json({ ok: true, task: result.task });
  });

  // 6. Human Approval Center
  app.get('/api/v1/mobile/approvals', auth.requireViewerOperatorOrDevice, (req, res) => {
    const status = typeof req.query.status === 'string'
      ? (req.query.status as 'pending' | 'approved' | 'rejected' | 'expired')
      : undefined;
    res.json({
      approvals: mobile.approvals.list(status),
      pendingCount: mobile.approvals.pendingCount,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/v1/mobile/approvals/:id', auth.requireViewerOperatorOrDevice, (req, res) => {
    const approval = mobile.approvals.get(String(req.params.id));
    if (!approval) {
      res.status(404).json({ error: `Approval '${req.params.id}' not found`, code: 'APPROVAL_NOT_FOUND' });
      return;
    }
    res.json({ approval });
  });

  app.post('/api/v1/mobile/approvals/:id/resolve', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, async (req, res) => {
    const principal = res.locals.principal as ProtocolPrincipal;
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      res.status(400).json({ error: "decision must be 'approve' or 'reject'", code: 'INVALID_DECISION' });
      return;
    }
    const result = await mobile.approvals.resolveApproval({
      id: String(req.params.id),
      decision,
      argumentsHash: typeof req.body?.argumentsHash === 'string' ? req.body.argumentsHash : undefined,
      taskId: typeof req.body?.taskId === 'string' ? req.body.taskId : undefined,
      biometricVerified: req.body?.biometricVerified === true,
      resolvedBy: principal.id,
      note: typeof req.body?.note === 'string' ? req.body.note : undefined,
    });
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.json({ ok: true, approval: result.approval });
  });

  // 7. Compute & Workers Telemetry
  app.get('/api/v1/mobile/computers', auth.requireViewerOperatorOrDevice, async (_req, res) => {
    res.json(await mobile.getComputersAndWorkers());
  });

  app.get('/api/v1/mobile/computers/:id', auth.requireViewerOperatorOrDevice, async (req, res) => {
    const snapshot = await mobile.getComputersAndWorkers();
    const computer = snapshot.computers.find((c) => c.id === req.params.id);
    if (!computer) {
      res.status(404).json({ error: `Computer '${req.params.id}' not found`, code: 'COMPUTER_NOT_FOUND' });
      return;
    }
    res.json({ computer });
  });

  // 8. Resource & Subscription Budgets
  app.get('/api/v1/mobile/resources', auth.requireViewerOperatorOrDevice, (_req, res) => {
    res.json(mobile.getResourceSnapshot());
  });

  // Operator-only, deliberately not device-reachable: a stolen mutate-scoped device
  // credential must not be able to halt every dispatch cluster-wide with no extra
  // confirmation. Unlike approval decisions, this action has no biometric/argument-hash
  // binding to fall back on, so it stays behind the real operator token.
  app.post('/api/v1/mobile/resources/emergency-stop', auth.requireOperator, async (req, res) => {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim()
      : 'Triggered remotely from Wazir Mobile';
    mobile.budget.emergencyStop(reason);
    await mobile.eventHub.publish({
      type: 'resource.emergency_stop',
      status: 'stopped',
      summary: `Emergency stop activated: ${reason}`,
      payload: { reason },
    });
    res.json(mobile.getResourceSnapshot());
  });

  app.post('/api/v1/mobile/resources/resume', auth.requireOperator, async (_req, res) => {
    mobile.budget.resume();
    await mobile.eventHub.publish({
      type: 'resource.resumed',
      status: 'normal',
      summary: 'Cloud dispatch resumed from Wazir Mobile',
      payload: {},
    });
    res.json(mobile.getResourceSnapshot());
  });

  // 9. Unified Multi-Surface Routes (Verifiable Artifacts, Diff Review, Autonomy Posture, Host Switching, Schedules)
  registerMultiSurfaceRoutes(app, state, mobile, mobile.multiSurface);
}
