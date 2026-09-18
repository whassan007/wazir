import type { PolicyActionRequest, PolicyDecision } from '../types/policy.js';
import { appendAuditEvent } from '@wazir/shared';

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
  status: 'pending' | 'approved' | 'denied';
  resolve: (approved: boolean, resolvedBy?: string) => void;
}

export interface ApprovalQueueOptions {
  /**
   * Deny immediately when nobody is subscribed to the queue (no TUI, no
   * approver loop). Without this a headless `wa run` would block forever on
   * its first 'ask' decision.
   */
  autoDenyNonInteractive?: boolean;
  /** Pending requests nobody answers within this window are denied. */
  defaultTimeoutMs?: number;
  /**
   * Honour `WAZIR_AUTO_APPROVE=1`. Off by default: an environment variable
   * must not be able to silently promote every 'ask' to 'allow' (F-9); the
   * host has to opt in explicitly (e.g. `wa run --yes` for a trusted batch).
   */
  allowEnvAutoApprove?: boolean;
}

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
  private readonly listeners = new Set<(requests: PendingApprovalRequest[]) => void>();
  private counter = 0;

  constructor(private readonly options: ApprovalQueueOptions = {}) {}

  enqueue(
    request: PolicyActionRequest,
    decision: PolicyDecision,
    metadata: { jobId?: string; taskId?: string; agentId?: string } = {},
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

    return new Promise<boolean>((resolve) => {
      this.counter++;
      const id = `appr-${Date.now().toString(36)}-${this.counter.toString(36)}`;
      let timer: NodeJS.Timeout | undefined;
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
        createdAt: new Date(),
        status: 'pending',
        resolve: (approved: boolean, resolvedBy?: string) => {
          if (item.status !== 'pending') return;
          if (timer) clearTimeout(timer);
          item.status = approved ? 'approved' : 'denied';
          this.pending.delete(id);
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
            resolvedBy: resolvedBy ?? (approved ? 'approver' : 'approver_denied'),
            details: { input: item.input, approvalId: item.id },
          }).catch(() => {});
          resolve(approved);
        },
      };

      const timeoutMs = this.options.defaultTimeoutMs;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => item.resolve(false, 'timeout'), timeoutMs);
        timer.unref?.();
      }

      this.pending.set(id, item);
      this.notify();
    });
  }

  /** True when something (a TUI, an approver loop) can answer requests. */
  get hasSubscribers(): boolean {
    return this.listeners.size > 0;
  }

  approve(id: string): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    item.resolve(true);
    return true;
  }

  deny(id: string): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    item.resolve(false);
    return true;
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

  list(): PendingApprovalRequest[] {
    return Array.from(this.pending.values());
  }

  get count(): number {
    return this.pending.size;
  }

  subscribe(listener: (requests: PendingApprovalRequest[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => this.listeners.delete(listener);
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

export function createApprovalQueue(options: ApprovalQueueOptions = {}): ApprovalQueue {
  return new ApprovalQueue(options);
}
