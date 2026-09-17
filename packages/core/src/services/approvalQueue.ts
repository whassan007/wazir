import type { PolicyActionRequest, PolicyDecision } from '../types/policy.js';

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
  resolve: (approved: boolean) => void;
}

export interface ApprovalQueueOptions {
  autoDenyNonInteractive?: boolean;
  defaultTimeoutMs?: number;
}

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
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      this.counter++;
      const id = `appr-${Date.now().toString(36)}-${this.counter.toString(36)}`;
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
        resolve: (approved: boolean) => {
          item.status = approved ? 'approved' : 'denied';
          this.pending.delete(id);
          this.notify();
          resolve(approved);
        },
      };

      this.pending.set(id, item);
      this.notify();
    });
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
