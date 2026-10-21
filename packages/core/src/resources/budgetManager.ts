import { randomUUID } from 'node:crypto';
import type { FailureClass } from '@wazir/shared';
import { AccountRegistry, DEFAULT_CRITICAL_ONLY, DEFAULT_RESERVE_FOR, costUsd, isPaid, pricingFor } from './accounts.js';
import type { ResourceLedger } from './ledger.js';
import { windowBounds } from './windows.js';
import {
  DEFAULT_THRESHOLDS,
  type AccountConfig,
  type AccountStatus,
  type ResourceAdmissionDecision,
  type ResourceAdmissionRequest,
  type BudgetMode,
  type LimitSpec,
  type LimitStatus,
  type LimitUnit,
  type ResourcePolicy,
  type UsageMeasurement,
} from './types.js';

const MODE_RANK: Record<BudgetMode, number> = { normal: 0, unknown: 1, advisory: 2, conserve: 3, critical: 4, exhausted: 5 };
const worse = (a: BudgetMode, b: BudgetMode) => (MODE_RANK[b] > MODE_RANK[a] ? b : a);

export interface FailureReport {
  failureClass?: FailureClass;
  status?: number;
  retryAfterMs?: number;
  /** True when the provider may have processed the request (stream cut, timeout mid-response). */
  ambiguous: boolean;
  /** Usage observed before the failure, if any. */
  partial?: UsageMeasurement;
  message?: string;
}

/**
 * Centralised token and request budget enforcement. `admit()` reserves estimated usage in
 * one write-locked transaction (check + reserve are atomic across agents and processes);
 * `reconcile()` replaces the reservation with actual usage exactly once; `fail()` records
 * provider failures and releases or conservatively charges the reservation.
 *
 * Internal dispatch budgets are enforced here. They are not a guarantee about provider-side
 * billing, which Wazir cannot observe in real time.
 */
export class TokenBudgetManager {
  constructor(
    readonly ledger: ResourceLedger,
    readonly accounts: AccountRegistry,
    readonly policy: ResourcePolicy,
  ) {}

  // ---- emergency stop -------------------------------------------------------------------------
  /** Stops new dispatches to non-local accounts. Local inference and running requests continue. */
  emergencyStop(reason: string): void {
    this.ledger.setMeta('emergency_stop', JSON.stringify({ at: this.ledger.now(), reason }));
    this.ledger.appendEvent('emergency_stop', {}, { reason });
  }

  resume(): void {
    this.ledger.setMeta('emergency_stop', undefined);
    this.ledger.appendEvent('emergency_resume', {}, {});
  }

  stopped(): { at: number; reason: string } | undefined {
    const v = this.ledger.getMeta('emergency_stop');
    return v ? JSON.parse(v) : undefined;
  }

  // ---- leases ---------------------------------------------------------------------------------
  /**
   * Keeps a reservation's lease alive while its request runs, on a timer rather than on
   * provider events: a delegated agent or a silent local generation can run far longer than
   * `leaseMs`, and an expired lease would be settled conservatively mid-flight and stop
   * counting toward concurrency. Returns the function that stops renewing. If this process
   * dies, renewal stops with it and the lease expires normally.
   */
  holdLease(requestId: string, everyMs = Math.max(1_000, Math.floor(this.policy.leaseMs / 3))): () => void {
    const timer = setInterval(() => {
      try {
        this.ledger.renewLease(requestId, this.ledger.now() + this.policy.leaseMs);
      } catch {
        // Ledger closed or busy: the next tick retries; expiry stays the safe fallback.
      }
    }, everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // ---- status ---------------------------------------------------------------------------------
  private unitsOf(unit: LimitUnit, req: Pick<ResourceAdmissionRequest, 'estimatedInputTokens' | 'estimatedOutputTokens' | 'requests'>, cost: number): number {
    switch (unit) {
      case 'tokens': return req.estimatedInputTokens + req.estimatedOutputTokens;
      case 'input_tokens': return req.estimatedInputTokens;
      case 'output_tokens': return req.estimatedOutputTokens;
      case 'requests': return req.requests ?? 1;
      case 'cost_usd': return cost;
    }
  }

  private effectiveLimits(account: AccountConfig): LimitSpec[] {
    const limits = [...(account.limits ?? [])];
    if (account.rpm) limits.push({ unit: 'requests', window: '1m', limit: account.rpm, source: 'configured' });
    if (account.tpm) limits.push({ unit: 'tokens', window: '1m', limit: account.tpm, source: 'configured' });
    return limits;
  }

  /** All credentials that share one provider-side quota identity. Admission is therefore
   * safe across independent Wazir processes when they point at the same SQLite ledger.
   * Ported from main@2a61e59. */
  private scope(account: AccountConfig): string[] {
    return account.quotaGroup
      ? this.accounts.list().filter((a) => a.enabled !== false && a.quotaGroup === account.quotaGroup).map((a) => a.id)
      : [account.id];
  }

  /** Limit status including a prospective addition (`adding`), evaluated at `now`. */
  private limitStatus(account: AccountConfig, limit: LimitSpec, adding: number, now: number): LimitStatus {
    const scope = this.scope(account);
    const bounds = windowBounds(limit.window, now);
    const used = this.ledger.usedSince(scope, limit.unit, bounds.start, bounds.end);
    const reserved = this.ledger.reservedNow(scope, limit.unit, now);
    // A provider-reported reset (from rate-limit headers) refines the window end.
    if (limit.limit === null) {
      const mode: BudgetMode = account.unknownLimitPolicy === 'allow' ? 'unknown' : account.unknownLimitPolicy === 'deny' ? 'exhausted' : 'conserve';
      return { unit: limit.unit, window: limit.window, limit: null, source: limit.source, used, reserved, windowStart: bounds.start, windowEnd: bounds.end ?? bounds.resetHint, mode };
    }
    const utilization = (used + reserved + adding) / limit.limit;
    const t = { ...DEFAULT_THRESHOLDS, ...(limit.thresholds ?? {}) };
    const mode: BudgetMode = utilization > 1 && limit.hard !== false ? 'exhausted'
      : utilization >= t.critical ? 'critical' : utilization >= t.conserve ? 'conserve' : utilization >= t.advisory ? 'advisory' : 'normal';
    return { unit: limit.unit, window: limit.window, limit: limit.limit, source: limit.source, used, reserved, utilization, windowStart: bounds.start, windowEnd: bounds.end ?? bounds.resetHint, mode };
  }

  status(accountId: string, now = this.ledger.now()): AccountStatus | undefined {
    const account = this.accounts.get(accountId);
    if (!account) return undefined;
    const health = this.ledger.getHealth(accountId, now);
    const limits = this.effectiveLimits(account).map((l) => this.limitStatus(account, l, 0, now));
    // Exhausted only when already over (adding nothing): `> 1` is "past the limit".
    const mode = limits.reduce<BudgetMode>((m, l) => worse(m, l.mode), 'normal');
    return { account, health: health.health, healthUntil: health.until, healthReason: health.reason, mode, limits, inFlight: this.ledger.inFlight(this.scope(account), now) };
  }

  // ---- admission --------------------------------------------------------------------------
  /**
   * Admits (and reserves) or refuses one request. Never sends anything; never substitutes
   * another account — the caller (router) decides alternatives using the reasons returned.
   */
  admit(req: ResourceAdmissionRequest): ResourceAdmissionDecision {
    const account = this.accounts.get(req.accountId);
    const base = { requestId: req.requestId, accountId: req.accountId };
    if (!account) return { ...base, outcome: 'blocked', mode: 'exhausted', reasons: [`unknown account '${req.accountId}'`] };

    this.ledger.recoverExpired();
    const decision = this.ledger.transaction(() => this.evaluate(req, account, true));
    this.ledger.appendEvent(decision.outcome, { accountId: req.accountId, requestId: req.requestId, taskId: req.taskId }, {
      model: req.modelId, workload: req.workload, estInput: req.estimatedInputTokens, estOutput: req.estimatedOutputTokens,
      mode: decision.mode, reasons: decision.reasons, retryAt: decision.retryAt,
    });
    return decision;
  }

  /** Would this request be admitted right now? Reserves nothing and records nothing. */
  preview(req: ResourceAdmissionRequest): ResourceAdmissionDecision {
    const account = this.accounts.get(req.accountId);
    if (!account) return { requestId: req.requestId, accountId: req.accountId, outcome: 'blocked', mode: 'exhausted', reasons: [`unknown account '${req.accountId}'`] };
    return this.evaluate(req, account, false);
  }

  private evaluate(req: ResourceAdmissionRequest, account: AccountConfig, reserve: boolean): ResourceAdmissionDecision {
    const base = { requestId: req.requestId, accountId: req.accountId };
    {
      const now = this.ledger.now();
      const reasons: string[] = [];
      const reserveAndAdmit = (mode: BudgetMode): ResourceAdmissionDecision => {
        if (!reserve) return { ...base, outcome: 'admitted', mode, reasons };
        // Request ids are unique per dispatch (idempotent settlement depends on it). A second
        // admission of the same id is a caller bug or a re-entrant wrapper: refuse it plainly
        // instead of failing on the ledger's unique constraint.
        if (this.ledger.getReservation(req.requestId)) {
          return { ...base, outcome: 'blocked', mode, reasons: [...reasons, `DUPLICATE_REQUEST_ID: request '${req.requestId}' was already admitted`] };
        }
        const reservationId = randomUUID();
        this.ledger.insertReservation({
          id: reservationId, requestId: req.requestId, accountId: account.id, modelId: req.modelId, taskId: req.taskId,
          workload: req.workload, estInputTokens: req.estimatedInputTokens, estOutputTokens: req.estimatedOutputTokens,
          estRequests: req.requests ?? 1, estCostUsd: costUsd(pricingFor(account, req.modelId), req.estimatedInputTokens, req.estimatedOutputTokens),
          status: 'active', createdAt: now, leaseExpiresAt: now + this.policy.leaseMs, local: account.kind === 'local',
        });
        return { ...base, outcome: 'admitted', reservationId, mode, reasons };
      };
      const deny = (outcome: 'blocked' | 'deferred', reason: string, mode: BudgetMode, retryAt?: number): ResourceAdmissionDecision =>
        ({ ...base, outcome, mode, reasons: [...reasons, reason], retryAt });

      if (account.enabled === false) return deny('blocked', `account '${account.id}' is disabled`, 'exhausted');
      if (account.kind !== 'local') {
        const stop = this.stopped();
        if (stop) return deny('blocked', `emergency stop is active (${stop.reason}); only local inference is dispatched`, 'exhausted');
      }
      if (!this.policy.enforce) {
        // Accounting only: reserve and record, but never refuse for budget, quota, health or cost.
        reasons.push('limits not enforced (policy.enforce=false)');
        if (isPaid(account)) reasons.push('paid-account authorization is advisory while policy.enforce=false; provider billing is not prevented');
        return reserveAndAdmit('normal');
      }
      if (isPaid(account) && !(this.policy.paidApiFallback || account.allowPaid)) {
        return deny('blocked', `account '${account.id}' is a paid API and paid fallback is not authorized (policy.paidApiFallback=false)`, 'exhausted');
      }
      if (account.workloads?.length && !account.workloads.includes(req.workload)) {
        return deny('blocked', `account '${account.id}' does not serve '${req.workload}' work`, 'normal');
      }
      if (account.kind !== 'local' && this.policy.localOnlyWorkloads?.includes(req.workload)) {
        return deny('blocked', `'${req.workload}' work is restricted to local inference by policy`, 'normal');
      }
      const ctx = account.contextLimits?.[req.modelId];
      if (ctx && req.estimatedInputTokens + req.estimatedOutputTokens > ctx) {
        return deny('blocked', `request needs ~${req.estimatedInputTokens + req.estimatedOutputTokens} tokens; '${req.modelId}' context is ${ctx}`, 'normal');
      }

      const health = this.ledger.getHealth(account.id, now);
      if (health.health === 'auth_blocked') return deny('blocked', `account '${account.id}' failed authentication (${health.reason}); re-authenticate, then run 'wa resources reset ${account.id}'`, 'exhausted');
      if (health.health === 'quota_blocked') return deny('deferred', `account '${account.id}' quota exhausted (${health.reason})`, 'exhausted', health.until);
      if (health.health === 'cooldown') return deny('deferred', `account '${account.id}' is rate limited (${health.reason})`, 'normal', health.until);

      if (account.maxConcurrent && this.ledger.inFlight(this.scope(account), now) >= account.maxConcurrent) {
        return deny('deferred', `account '${account.id}' has ${account.maxConcurrent} request(s) in flight (concurrency limit)`, 'normal', now + 250);
      }

      const pricing = pricingFor(account, req.modelId);
      const estCost = costUsd(pricing, req.estimatedInputTokens, req.estimatedOutputTokens);
      let mode: BudgetMode = 'normal';
      for (const limit of this.effectiveLimits(account)) {
        const add = this.unitsOf(limit.unit, req, estCost);
        const s = this.limitStatus(account, limit, add, now);
        mode = worse(mode, s.mode);
        if (s.mode === 'exhausted') {
          // An unknown limit does not become known by waiting: refuse, with no retry time.
          if (limit.limit === null) return deny('blocked', `account '${account.id}' has an unknown ${limit.unit}/${limit.window} limit and its policy is 'deny'; configure the limit or change unknownLimitPolicy`, 'exhausted');
          return deny('deferred', `${limit.unit} limit ${limit.limit}/${limit.window} (${limit.source}) would be exceeded: used ${round(s.used)}, reserved ${round(s.reserved)}, request ~${round(add)}`,
            'exhausted', s.windowEnd);
        }
        if (s.utilization !== undefined && s.mode !== 'normal') reasons.push(`${limit.unit}/${limit.window} at ${Math.round(s.utilization * 100)}% (${s.mode})`);
        if (limit.limit === null) reasons.push(`${limit.unit}/${limit.window} limit unknown (${limit.source}); using local accounting`);
      }
      if (mode === 'conserve' && !(account.reserveFor ?? DEFAULT_RESERVE_FOR).includes(req.workload)) {
        return deny('blocked', `account '${account.id}' is in conservation mode, reserved for ${(account.reserveFor ?? DEFAULT_RESERVE_FOR).join('/')} work`, mode);
      }
      if (mode === 'critical' && !(account.criticalOnly ?? DEFAULT_CRITICAL_ONLY).includes(req.workload)) {
        return deny('blocked', `account '${account.id}' is in critical mode, reserved for ${(account.criticalOnly ?? DEFAULT_CRITICAL_ONLY).join('/')} work`, mode);
      }

      if (this.policy.maxTaskTokens > 0 && req.taskId) {
        const taskTotal = this.ledger.taskTokens(req.taskId, now) + req.estimatedInputTokens + req.estimatedOutputTokens;
        if (taskTotal > this.policy.maxTaskTokens) return deny('blocked', `task token budget ${this.policy.maxTaskTokens} would be exceeded (~${taskTotal})`, mode);
      }
      if (isPaid(account) && estCost > 0) {
        const spendCheck = (limitUsd: number, window: 'day' | 'month') => {
          if (!(limitUsd > 0)) return undefined;
          const b = windowBounds(window, now);
          const total = this.ledger.spendSince(b.start) + this.ledger.reservedSpendNow(now) + estCost;
          return total > limitUsd ? deny('deferred', `${window === 'day' ? 'daily' : 'monthly'} paid spend ceiling $${limitUsd} would be exceeded (~$${total.toFixed(4)})`, 'exhausted', b.resetHint) : undefined;
        };
        const over = spendCheck(this.policy.dailySpendUsd, 'day') ?? spendCheck(this.policy.monthlySpendUsd, 'month');
        if (over) return over;
      }

      return reserveAndAdmit(mode);
    }
  }

  // ---- reconciliation ---------------------------------------------------------------------
  /**
   * Replaces the reservation with actual usage. Idempotent per request id: a duplicate call
   * (retried callback) changes nothing and returns false.
   */
  reconcile(requestId: string, usage: UsageMeasurement, extra: { durationMs?: number; agent?: string; rawEstimatedInput?: number } = {}): boolean {
    const r = this.ledger.getReservation(requestId);
    if (!r) return false;
    const account = this.accounts.get(r.accountId);
    const pricing = account ? pricingFor(account, r.modelId) : undefined;
    const costKnown = r.local || pricing !== undefined;
    const costStatus: 'ACTUAL' | 'ESTIMATED' | 'UNKNOWN' = r.local
      ? 'ACTUAL'
      : pricing !== undefined
        ? (usage.source === 'provider-reported' ? 'ACTUAL' : 'ESTIMATED')
        : 'UNKNOWN';
    const cost = account ? costUsd(pricing, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens ?? 0) : 0;
    const settled = this.ledger.settle({
      requestId, accountId: r.accountId, modelId: r.modelId, taskId: r.taskId, agent: extra.agent, workload: r.workload,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0, requests: r.estRequests, costUsd: cost, costKnown, costStatus, source: usage.source,
      at: this.ledger.now(), durationMs: extra.durationMs, local: r.local,
    });
    if (settled && usage.source === 'provider-reported' && extra.rawEstimatedInput) {
      this.ledger.calibrate(r.modelId, extra.rawEstimatedInput, usage.inputTokens);
    }
    return settled;
  }

  /**
   * Records a failed request. Auth failures block the account until a human resets it;
   * quota exhaustion blocks until the reset; rate limits start a cooldown (Retry-After when
   * given). If the provider may have processed the request, it is charged conservatively;
   * otherwise the reservation is released.
   */
  fail(requestId: string, report: FailureReport): void {
    const r = this.ledger.getReservation(requestId);
    if (!r) return;
    const now = this.ledger.now();
    const ids = { accountId: r.accountId, requestId, taskId: r.taskId };
    switch (report.failureClass) {
      case 'AUTH_FAILED':
        this.ledger.setHealth(r.accountId, 'auth_blocked', undefined, `HTTP ${report.status ?? '?'}: ${report.message?.slice(0, 160) ?? 'authentication failed'}`);
        this.ledger.appendEvent('auth_failed', ids, { status: report.status });
        break;
      case 'QUOTA_EXHAUSTED': {
        const account = this.accounts.get(r.accountId);
        const resets = account ? this.effectiveLimits(account).filter((l) => l.limit !== null).map((l) => windowBounds(l.window, now).resetHint) : [];
        const until = report.retryAfterMs !== undefined ? now + report.retryAfterMs : resets.length ? Math.min(...resets) : now + 3_600_000;
        this.ledger.setHealth(r.accountId, 'quota_blocked', until, report.message?.slice(0, 160) ?? 'provider reported quota exhausted');
        this.ledger.appendEvent('quota_exhausted', ids, { until, status: report.status });
        break;
      }
      case 'RATE_LIMIT': {
        const until = now + (report.retryAfterMs ?? 30_000);
        this.ledger.setHealth(r.accountId, 'cooldown', until, report.retryAfterMs !== undefined ? `Retry-After ${Math.round(report.retryAfterMs / 1000)}s` : 'HTTP 429 without Retry-After; 30s default');
        this.ledger.appendEvent('rate_limited', ids, { until, retryAfterMs: report.retryAfterMs });
        break;
      }
      default:
        this.ledger.appendEvent('provider_error', ids, { failureClass: report.failureClass, status: report.status, ambiguous: report.ambiguous });
    }
    if (report.ambiguous) {
      // The provider may have done the work and billed it: charge the larger of what was
      // observed and what was reserved, labelled conservative.
      this.ledger.appendEvent('ambiguous', ids, { failureClass: report.failureClass });
      this.reconcile(requestId, {
        inputTokens: Math.max(report.partial?.inputTokens ?? 0, r.estInputTokens),
        outputTokens: Math.max(report.partial?.outputTokens ?? 0, r.estOutputTokens),
        cachedInputTokens: report.partial?.cachedInputTokens, source: 'conservative',
      });
    } else {
      this.ledger.release(requestId, report.failureClass ?? 'failed before dispatch');
    }
  }

  /** Clears an account's auth/quota/cooldown state (after the operator re-authenticates). */
  resetHealth(accountId: string): void {
    this.ledger.setHealth(accountId, 'ok', undefined, 'reset by operator');
  }
}

const round = (n: number) => (Number.isInteger(n) ? n : Number(n.toFixed(4)));
