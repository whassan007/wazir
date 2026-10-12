import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// Loaded at runtime: some bundlers and test runners cannot resolve the newer `node:sqlite`
// specifier statically. getBuiltinModule (Node >= 22.3) works everywhere Wazir runs.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
import type { AccountHealth, LimitUnit, UsageMeasurement, WorkloadClass } from './types.js';

/** One row of attributable usage. Exactly one per request id (idempotent reconciliation). */
export interface UsageRow {
  requestId: string;
  accountId: string;
  modelId: string;
  taskId?: string;
  agent?: string;
  workload?: WorkloadClass;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  requests: number;
  costUsd: number;
  source: UsageMeasurement['source'];
  at: number;
  durationMs?: number;
  local: boolean;
}

export interface ReservationRow {
  id: string;
  requestId: string;
  accountId: string;
  modelId: string;
  taskId?: string;
  workload: WorkloadClass;
  estInputTokens: number;
  estOutputTokens: number;
  estRequests: number;
  estCostUsd: number;
  status: 'active' | 'settled' | 'released' | 'expired';
  createdAt: number;
  leaseExpiresAt: number;
  local: boolean;
}

export type LedgerEventKind =
  | 'admitted' | 'deferred' | 'blocked' | 'settled' | 'released' | 'expired' | 'duplicate_settle'
  | 'rate_limited' | 'auth_failed' | 'quota_exhausted' | 'provider_error' | 'ambiguous'
  | 'emergency_stop' | 'emergency_resume' | 'health_changed' | 'routing';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 10000;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, model_id TEXT NOT NULL,
  task_id TEXT, workload TEXT NOT NULL, est_input INTEGER NOT NULL, est_output INTEGER NOT NULL,
  est_requests INTEGER NOT NULL, est_cost REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','settled','released','expired')),
  created_at INTEGER NOT NULL, lease_expires_at INTEGER NOT NULL, settled_at INTEGER, local INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reservations_active ON reservations (account_id, status, lease_expires_at);
CREATE TABLE IF NOT EXISTS usage (
  request_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, model_id TEXT NOT NULL, task_id TEXT, agent TEXT,
  workload TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL, requests INTEGER NOT NULL, cost_usd REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('provider-reported','estimated','conservative')),
  at INTEGER NOT NULL, duration_ms INTEGER, local INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS usage_account_at ON usage (account_id, at);
CREATE INDEX IF NOT EXISTS usage_task ON usage (task_id);
CREATE TABLE IF NOT EXISTS account_health (
  account_id TEXT PRIMARY KEY, health TEXT NOT NULL, until_at INTEGER, reason TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS observations (
  account_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (account_id, kind));
CREATE TABLE IF NOT EXISTS calibration (
  model_id TEXT PRIMARY KEY, ratio REAL NOT NULL, samples INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
  account_id TEXT, request_id TEXT, task_id TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_kind_at ON events (kind, at);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
`;

const unitColumn = (unit: LimitUnit, prefix: '' | 'est_'): string => {
  const p = prefix === 'est_' ? 'est_' : '';
  switch (unit) {
    case 'tokens': return prefix === 'est_' ? 'est_input + est_output' : 'input_tokens + output_tokens';
    case 'input_tokens': return prefix === 'est_' ? 'est_input' : 'input_tokens';
    case 'output_tokens': return prefix === 'est_' ? 'est_output' : 'output_tokens';
    case 'requests': return `${p}requests`;
    case 'cost_usd': return prefix === 'est_' ? 'est_cost' : 'cost_usd';
  }
};

/**
 * Durable resource accounting on SQLite (WAL). All admission checks run inside
 * `transaction()`, which takes SQLite's write lock up front (BEGIN IMMEDIATE), so concurrent
 * agents and concurrent `wa` processes cannot both pass the same check and double-spend.
 */
export class ResourceLedger {
  readonly db: DatabaseSyncType;

  constructor(readonly file: string, private readonly clock: () => number = Date.now) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  now(): number {
    return this.clock();
  }

  /** Runs `fn` under the database write lock; rolls back if it throws. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- settings -------------------------------------------------------------------------
  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string | undefined): void {
    if (value === undefined) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- sums used by admission (call inside transaction) -----------------------------------
  usedSince(accountId: string, unit: LimitUnit, since: number, until?: number): number {
    const sql = `SELECT COALESCE(SUM(${unitColumn(unit, '')}), 0) AS v FROM usage WHERE account_id = ? AND at >= ?${until !== undefined ? ' AND at < ?' : ''}`;
    const args: (string | number)[] = until !== undefined ? [accountId, since, until] : [accountId, since];
    return Number((this.db.prepare(sql).get(...args) as { v: number }).v);
  }

  /** Units held by live (active, unexpired) reservations. */
  reservedNow(accountId: string, unit: LimitUnit, now = this.now()): number {
    const sql = `SELECT COALESCE(SUM(${unitColumn(unit, 'est_')}), 0) AS v FROM reservations WHERE account_id = ? AND status = 'active' AND lease_expires_at > ?`;
    return Number((this.db.prepare(sql).get(accountId, now) as { v: number }).v);
  }

  inFlight(accountId: string, now = this.now()): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE account_id = ? AND status = 'active' AND lease_expires_at > ?`).get(accountId, now) as { n: number }).n);
  }

  spendSince(since: number): number {
    return Number((this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS v FROM usage WHERE at >= ? AND local = 0`).get(since) as { v: number }).v);
  }

  reservedSpendNow(now = this.now()): number {
    return Number((this.db.prepare(`SELECT COALESCE(SUM(est_cost), 0) AS v FROM reservations WHERE status = 'active' AND lease_expires_at > ? AND local = 0`).get(now) as { v: number }).v);
  }

  taskTokens(taskId: string, now = this.now()): number {
    const used = Number((this.db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS v FROM usage WHERE task_id = ?`).get(taskId) as { v: number }).v);
    const held = Number((this.db.prepare(`SELECT COALESCE(SUM(est_input + est_output), 0) AS v FROM reservations WHERE task_id = ? AND status = 'active' AND lease_expires_at > ?`).get(taskId, now) as { v: number }).v);
    return used + held;
  }

  // ---- reservations -----------------------------------------------------------------------
  insertReservation(r: ReservationRow): void {
    this.db.prepare(`INSERT INTO reservations (id, request_id, account_id, model_id, task_id, workload, est_input, est_output, est_requests, est_cost, status, created_at, lease_expires_at, local)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(
      r.id, r.requestId, r.accountId, r.modelId, r.taskId ?? null, r.workload, r.estInputTokens, r.estOutputTokens,
      r.estRequests, r.estCostUsd, r.createdAt, r.leaseExpiresAt, r.local ? 1 : 0);
  }

  getReservation(requestId: string): ReservationRow | undefined {
    const row = this.db.prepare('SELECT * FROM reservations WHERE request_id = ?').get(requestId) as Record<string, unknown> | undefined;
    return row ? toReservation(row) : undefined;
  }

  /** Extends a live reservation's lease (long streams renew so they are not recovered early). */
  renewLease(requestId: string, until: number): void {
    this.db.prepare(`UPDATE reservations SET lease_expires_at = MAX(lease_expires_at, ?) WHERE request_id = ? AND status = 'active'`).run(until, requestId);
  }

  /**
   * Records usage for a request exactly once. Returns false when usage for this request id
   * already exists (a duplicated callback or retry) — nothing is charged twice.
   */
  settle(row: UsageRow): boolean {
    return this.transaction(() => {
      const exists = this.db.prepare('SELECT 1 FROM usage WHERE request_id = ?').get(row.requestId);
      if (exists) {
        this.appendEvent('duplicate_settle', { accountId: row.accountId, requestId: row.requestId, taskId: row.taskId }, {});
        return false;
      }
      this.db.prepare(`INSERT INTO usage (request_id, account_id, model_id, task_id, agent, workload, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, requests, cost_usd, source, at, duration_ms, local)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.requestId, row.accountId, row.modelId, row.taskId ?? null, row.agent ?? null, row.workload ?? null,
        row.inputTokens, row.outputTokens, row.cachedInputTokens, row.reasoningTokens, row.requests, row.costUsd,
        row.source, row.at, row.durationMs ?? null, row.local ? 1 : 0);
      this.db.prepare(`UPDATE reservations SET status = 'settled', settled_at = ? WHERE request_id = ? AND status IN ('active','expired')`).run(row.at, row.requestId);
      this.appendEvent('settled', { accountId: row.accountId, requestId: row.requestId, taskId: row.taskId }, {
        input: row.inputTokens, output: row.outputTokens, cached: row.cachedInputTokens, cost: row.costUsd, source: row.source,
      });
      return true;
    });
  }

  /** Releases a reservation whose request provably consumed nothing (never sent, or refused). */
  release(requestId: string, reason: string): void {
    this.transaction(() => {
      const r = this.getReservation(requestId);
      if (!r || r.status !== 'active') return;
      this.db.prepare(`UPDATE reservations SET status = 'released', settled_at = ? WHERE request_id = ?`).run(this.now(), requestId);
      this.appendEvent('released', { accountId: r.accountId, requestId, taskId: r.taskId }, { reason });
    });
  }

  /**
   * Recovers reservations whose lease expired (the process holding them died or hung). The
   * provider may have processed the request, so each is charged at its estimate, labelled
   * 'conservative'. Idempotent: an already-settled request is never charged again.
   */
  recoverExpired(now = this.now()): number {
    const rows = (this.db.prepare(`SELECT * FROM reservations WHERE status = 'active' AND lease_expires_at <= ?`).all(now) as Record<string, unknown>[]).map(toReservation);
    let recovered = 0;
    for (const r of rows) {
      this.transaction(() => {
        this.db.prepare(`UPDATE reservations SET status = 'expired' WHERE id = ? AND status = 'active'`).run(r.id);
        this.appendEvent('expired', { accountId: r.accountId, requestId: r.requestId, taskId: r.taskId }, { estInput: r.estInputTokens, estOutput: r.estOutputTokens });
      });
      if (this.settle({
        requestId: r.requestId, accountId: r.accountId, modelId: r.modelId, taskId: r.taskId, workload: r.workload,
        inputTokens: r.estInputTokens, outputTokens: r.estOutputTokens, cachedInputTokens: 0, reasoningTokens: 0,
        requests: r.estRequests, costUsd: r.estCostUsd, source: 'conservative', at: now, local: r.local,
      })) recovered++;
    }
    return recovered;
  }

  // ---- account health ---------------------------------------------------------------------
  getHealth(accountId: string, now = this.now()): { health: AccountHealth; until?: number; reason?: string } {
    const row = this.db.prepare('SELECT health, until_at, reason FROM account_health WHERE account_id = ?').get(accountId) as { health: AccountHealth; until_at: number | null; reason: string | null } | undefined;
    if (!row || row.health === 'ok') return { health: 'ok' };
    // Cooldowns and quota blocks end on their own at `until`; auth blocks need a human.
    if (row.until_at !== null && row.until_at <= now && row.health !== 'auth_blocked') return { health: 'ok' };
    return { health: row.health, until: row.until_at ?? undefined, reason: row.reason ?? undefined };
  }

  setHealth(accountId: string, health: AccountHealth, until: number | undefined, reason: string): void {
    this.db.prepare(`INSERT INTO account_health (account_id, health, until_at, reason, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET health = excluded.health, until_at = excluded.until_at, reason = excluded.reason, updated_at = excluded.updated_at`)
      .run(accountId, health, until ?? null, reason, this.now());
    this.appendEvent('health_changed', { accountId }, { health, until, reason });
  }

  // ---- provider observations --------------------------------------------------------------
  observe(accountId: string, kind: string, value: unknown): void {
    this.db.prepare(`INSERT INTO observations (account_id, kind, at, json) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, kind) DO UPDATE SET at = excluded.at, json = excluded.json`).run(accountId, kind, this.now(), JSON.stringify(value));
  }

  observation<T>(accountId: string, kind: string): { at: number; value: T } | undefined {
    const row = this.db.prepare('SELECT at, json FROM observations WHERE account_id = ? AND kind = ?').get(accountId, kind) as { at: number; json: string } | undefined;
    return row ? { at: row.at, value: JSON.parse(row.json) as T } : undefined;
  }

  // ---- estimate calibration ---------------------------------------------------------------
  /** Learned actual/estimated input-token ratio for a model (1 when unseen). */
  calibration(modelId: string): { ratio: number; samples: number } {
    const row = this.db.prepare('SELECT ratio, samples FROM calibration WHERE model_id = ?').get(modelId) as { ratio: number; samples: number } | undefined;
    return row ?? { ratio: 1, samples: 0 };
  }

  calibrate(modelId: string, estimated: number, actual: number): void {
    if (!(estimated > 0) || !(actual > 0)) return;
    const observed = Math.min(4, Math.max(0.25, actual / estimated));
    const { ratio, samples } = this.calibration(modelId);
    // Exponential moving average; the first samples move fast, later ones settle.
    const alpha = Math.max(0.1, 1 / (samples + 1));
    const next = samples === 0 ? observed : ratio + alpha * (observed - ratio);
    this.db.prepare(`INSERT INTO calibration (model_id, ratio, samples, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(model_id) DO UPDATE SET ratio = excluded.ratio, samples = excluded.samples, updated_at = excluded.updated_at`)
      .run(modelId, next, samples + 1, this.now());
  }

  // ---- audit trail ------------------------------------------------------------------------
  appendEvent(kind: LedgerEventKind, ids: { accountId?: string; requestId?: string; taskId?: string }, data: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events (at, kind, account_id, request_id, task_id, json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.now(), kind, ids.accountId ?? null, ids.requestId ?? null, ids.taskId ?? null, JSON.stringify(data));
  }

  events(filter: { kind?: LedgerEventKind; since?: number; requestId?: string; taskId?: string; limit?: number } = {}): Array<{ at: number; kind: LedgerEventKind; accountId?: string; requestId?: string; taskId?: string; data: Record<string, unknown> }> {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.kind) { where.push('kind = ?'); args.push(filter.kind); }
    if (filter.since !== undefined) { where.push('at >= ?'); args.push(filter.since); }
    if (filter.requestId) { where.push('request_id = ?'); args.push(filter.requestId); }
    if (filter.taskId) { where.push('task_id = ?'); args.push(filter.taskId); }
    const sql = `SELECT * FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    args.push(filter.limit ?? 200);
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
      at: Number(r.at), kind: r.kind as LedgerEventKind, accountId: (r.account_id as string) ?? undefined,
      requestId: (r.request_id as string) ?? undefined, taskId: (r.task_id as string) ?? undefined,
      data: JSON.parse(String(r.json)) as Record<string, unknown>,
    }));
  }

  // ---- reporting ----------------------------------------------------------------------------
  usageRows(filter: { since?: number; accountId?: string; taskId?: string } = {}): UsageRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.since !== undefined) { where.push('at >= ?'); args.push(filter.since); }
    if (filter.accountId) { where.push('account_id = ?'); args.push(filter.accountId); }
    if (filter.taskId) { where.push('task_id = ?'); args.push(filter.taskId); }
    const rows = this.db.prepare(`SELECT * FROM usage${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at`).all(...args) as Record<string, unknown>[];
    return rows.map((r) => ({
      requestId: String(r.request_id), accountId: String(r.account_id), modelId: String(r.model_id),
      taskId: (r.task_id as string) ?? undefined, agent: (r.agent as string) ?? undefined, workload: (r.workload as WorkloadClass) ?? undefined,
      inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), cachedInputTokens: Number(r.cached_input_tokens),
      reasoningTokens: Number(r.reasoning_tokens), requests: Number(r.requests), costUsd: Number(r.cost_usd),
      source: r.source as UsageRow['source'], at: Number(r.at), durationMs: r.duration_ms === null ? undefined : Number(r.duration_ms),
      local: Number(r.local) === 1,
    }));
  }

  activeReservations(now = this.now()): ReservationRow[] {
    return (this.db.prepare(`SELECT * FROM reservations WHERE status = 'active' AND lease_expires_at > ? ORDER BY created_at`).all(now) as Record<string, unknown>[]).map(toReservation);
  }
}

function toReservation(r: Record<string, unknown>): ReservationRow {
  return {
    id: String(r.id), requestId: String(r.request_id), accountId: String(r.account_id), modelId: String(r.model_id),
    taskId: (r.task_id as string) ?? undefined, workload: r.workload as WorkloadClass,
    estInputTokens: Number(r.est_input), estOutputTokens: Number(r.est_output), estRequests: Number(r.est_requests),
    estCostUsd: Number(r.est_cost), status: r.status as ReservationRow['status'], createdAt: Number(r.created_at),
    leaseExpiresAt: Number(r.lease_expires_at), local: Number(r.local) === 1,
  };
}
