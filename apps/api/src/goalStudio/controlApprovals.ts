import { ApprovalQueue, approvalScopeKey } from '@wazir/core';
import type { ApprovalRecord, ApprovalResolutionResult, ApprovalScope, PolicyActionRequest, PolicyDecision } from '@wazir/core';
import type { GoalEventLog, GoalRunId, GoalStudioDeps, TargetId } from '@wazir/goals';

/** What the controller asks for. Kind is always 'goal-studio'. */
export interface GoalApprovalScope {
  runId: GoalRunId;
  targetId: TargetId;
  attempt: number;
  /** e.g. 'execute', 'complete', 'external-signoff'. */
  action: string;
}

export const GOAL_STUDIO_APPROVAL_KIND = 'goal-studio';

export function toQueueScope(scope: GoalApprovalScope): ApprovalScope {
  return { kind: GOAL_STUDIO_APPROVAL_KIND, ...scope };
}

/**
 * Structural view of the mobile approval inbox (`MobileApprovalService` in
 * apps/api/src/mobile/eventHubAndApprovals.ts). When provided, every goal
 * studio approval is mirrored there so a paired phone can decide it through
 * the existing `/api/v1/mobile/approvals/:id/resolve` path; whichever surface
 * answers first wins and the other is closed out.
 */
export interface MobileApprovalMirror {
  requestApproval(
    request: PolicyActionRequest,
    decision: PolicyDecision,
    context?: { taskId?: string; taskTitle?: string; agentId?: string; ttlMs?: number },
  ): Promise<boolean>;
  resolveApproval(params: { id: string; decision: 'approve' | 'reject'; resolvedBy: string; note?: string; taskId?: string }): Promise<{ ok: boolean }>;
  pendingForTask(taskId: string): string[];
}

export interface GoalApprovalView extends ApprovalRecord {
  runId?: GoalRunId;
  targetId?: TargetId;
  attempt?: number;
  action?: string;
  mobileApprovalId?: string;
  resolutionReason?: string;
}

/**
 * Goal Studio approval broker. The controller awaits `request(scope)`; the
 * HTTP routes (and, via the mirror, mobile) resolve it. Backed by the core
 * `ApprovalQueue`, so approvals are scope-bound, single-use and expiring.
 */
export class GoalStudioApprovals {
  readonly queue: ApprovalQueue;
  private readonly events?: GoalEventLog;
  private readonly mobile?: MobileApprovalMirror;
  private readonly ttlMs?: number;
  private readonly mobileIds = new Map<string, string>();
  private readonly resolutionReasons = new Map<string, string>();

  constructor(options: { queue?: ApprovalQueue; events?: GoalEventLog; mobile?: MobileApprovalMirror; ttlMs?: number } = {}) {
    this.queue = options.queue ?? new ApprovalQueue({ scopedTimeoutMs: options.ttlMs });
    this.events = options.events;
    this.mobile = options.mobile;
    this.ttlMs = options.ttlMs;
  }

  /**
   * Blocks until a human approves (true) or denies/expiry (false). Idempotent
   * per scope: a controller that restarts and asks again for the same
   * (run, target, attempt, action) gets the same pending request or recorded decision.
   */
  request(scope: GoalApprovalScope, details: { summary?: string; reasons?: string[]; input?: Record<string, unknown> } = {}): Promise<boolean> {
    const queueScope = toQueueScope(scope);
    const existing = this.queue.findByScope(queueScope);
    const promise = this.queue.requestScoped(queueScope, {
      tool: `goal-studio.${scope.action}`,
      input: { ...(details.input ?? {}), summary: details.summary },
      rule: 'goal-studio-approval',
      reasons: details.reasons ?? [details.summary ?? `${scope.action} on ${scope.targetId} requires human approval`],
      agentId: 'goal-controller',
      ttlMs: this.ttlMs,
    });
    const created = !existing ? this.queue.findByScope(queueScope) : undefined;
    if (created) {
      void this.events?.append({
        type: 'approval.requested',
        runId: scope.runId,
        targetId: scope.targetId,
        data: { approvalId: created.id, scope: queueScope, scopeKey: created.scopeKey, expiresAt: created.expiresAt?.toISOString(), reasons: created.reasons },
      }).catch(() => undefined);
      this.mirrorToMobile(created.id, queueScope, created.reasons);
      void promise.then((approved) => this.onResolved(created.id, queueScope, approved));
    }
    return promise;
  }

  private mirrorToMobile(id: string, scope: ApprovalScope, reasons: string[]): void {
    if (!this.mobile) return;
    const taskId = approvalScopeKey(scope);
    const mobileDecision = this.mobile.requestApproval(
      { tool: `goal-studio.${scope.action}`, input: { runId: scope.runId, targetId: scope.targetId, attempt: scope.attempt, action: scope.action }, executionId: scope.runId },
      { decision: 'ask', rule: 'goal-studio-approval', reasons },
      { taskId, taskTitle: `Goal ${scope.runId} · ${scope.targetId} · ${scope.action}`, agentId: 'goal-controller', ttlMs: this.ttlMs },
    );
    // requestApproval records synchronously before its first await resolves; look it up next tick.
    void Promise.resolve().then(() => {
      const [mobileId] = this.mobile?.pendingForTask(taskId) ?? [];
      if (mobileId) this.mobileIds.set(id, mobileId);
    });
    void mobileDecision.then((approved) => {
      if (this.queue.get(id)) this.queue.resolve(id, approved, approved ? 'mobile' : 'mobile_denied_or_expired', scope);
    }).catch(() => undefined);
  }

  private onResolved(id: string, scope: ApprovalScope, approved: boolean): void {
    const record = this.queue.record(id);
    const reason = this.resolutionReasons.get(id);
    void this.events?.append({
      type: 'approval.resolved',
      runId: scope.runId,
      targetId: scope.targetId,
      data: { approvalId: id, scope, approved, status: record?.status, resolvedBy: record?.resolvedBy, ...(reason ? { reason } : {}) },
    }).catch(() => undefined);
    const mobileId = this.mobileIds.get(id) ?? this.mobile?.pendingForTask(approvalScopeKey(scope))[0];
    this.mobileIds.delete(id);
    if (this.mobile && mobileId && record?.resolvedBy !== 'mobile' && record?.resolvedBy !== 'mobile_denied_or_expired') {
      void this.mobile.resolveApproval({
        id: mobileId,
        decision: approved ? 'approve' : 'reject',
        resolvedBy: record?.resolvedBy ?? 'goal-studio',
        note: reason ?? 'Resolved from Goal Studio',
      }).catch(() => undefined);
    }
  }

  list(filter: { runId?: GoalRunId; status?: ApprovalRecord['status'] } = {}): GoalApprovalView[] {
    return this.queue.records({ kind: GOAL_STUDIO_APPROVAL_KIND, ...filter }).map((record) => {
      const resolutionReason = this.resolutionReasons.get(record.id);
      return {
        ...record,
        runId: record.scope?.runId,
        targetId: record.scope?.targetId,
        attempt: record.scope?.attempt,
        action: record.scope?.action,
        mobileApprovalId: this.mobileIds.get(record.id),
        ...(resolutionReason !== undefined ? { resolutionReason } : {}),
      };
    });
  }

  get(id: string): GoalApprovalView | undefined {
    return this.list().find((record) => record.id === id);
  }

  /** Resolves a goal-studio approval only; other queue entries are invisible here. */
  resolve(id: string, approved: boolean, principal: string, expected: Partial<GoalApprovalScope> = {}, reason?: string): ApprovalResolutionResult {
    const record = this.queue.record(id);
    if (!record || record.scope?.kind !== GOAL_STUDIO_APPROVAL_KIND) {
      return { ok: false, code: 'NOT_FOUND', message: `approval '${id}' not found` };
    }
    if (typeof reason === 'string' && reason.trim().length > 0) {
      this.resolutionReasons.set(id, reason.trim());
    }
    return this.queue.resolve(id, approved, principal, { kind: GOAL_STUDIO_APPROVAL_KIND, ...stripUndefined(expected) });
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Factory per INTEGRATION-CONTRACTS §10. */
export function createGoalStudioApprovals(
  deps: Partial<GoalStudioDeps> & { queue?: ApprovalQueue; events?: GoalEventLog; mobile?: MobileApprovalMirror; ttlMs?: number },
): GoalStudioApprovals {
  const queue = deps.queue ?? new ApprovalQueue({ store: deps.store, scopedTimeoutMs: deps.ttlMs, now: deps.clock ? () => deps.clock!().getTime() : undefined });
  return new GoalStudioApprovals({ queue, events: deps.events, mobile: deps.mobile, ttlMs: deps.ttlMs });
}
