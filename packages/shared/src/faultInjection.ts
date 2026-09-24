/**
 * Deterministic Failure Injection Framework for Wazir Chaos & Reliability.
 *
 * Provides reusable, dependency-injected fault hooks across execution, storage,
 * runtime, tool, lease, and verification boundaries without random sleeps or non-deterministic races.
 *
 * Production behavior is completely unaffected when fault injection is inactive.
 */

export const FAULT_POINTS = [
  'BEFORE_TOOL_EXECUTION',
  'AFTER_TOOL_EXECUTION_BEFORE_PERSIST',
  'AFTER_MUTATION_BEFORE_REVISION_RECORD',
  'AFTER_REVISION_BEFORE_VERIFICATION',
  'DURING_MODEL_STREAM',
  'DURING_CODE_MODE',
  'DURING_CHECKPOINT',
  'DURING_ROLLBACK',
  'DURING_FORK',
  'DURING_WORKER_HEARTBEAT',
  'DURING_STORE_WRITE',
  'DURING_EVENT_PERSIST',
  'DURING_COMPLETION',
] as const;

export type FaultPoint = typeof FAULT_POINTS[number];

export interface FaultContext {
  executionId?: string;
  jobId?: string;
  taskId?: string;
  stepId?: string;
  callId?: string;
  toolName?: string;
  workspaceRevision?: number;
  filePath?: string;
  key?: string;
  workerId?: string;
  attempt?: number;
  [key: string]: unknown;
}

export type FaultAction =
  | { type: 'throw'; error: Error | string }
  | { type: 'hang'; timeoutMs?: number }
  | { type: 'kill_process'; exitCode?: number }
  | { type: 'corrupt_data'; transform: (data: unknown) => unknown }
  | { type: 'custom'; handler: (context: FaultContext) => Promise<void> | void };

export interface FaultRule {
  id?: string;
  point: FaultPoint;
  match?: (context: FaultContext) => boolean;
  action: FaultAction;
  /** Number of times this fault can trigger (defaults to 1). Set to Infinity for recurring faults. */
  maxTimes?: number;
  triggeredCount?: number;
}

export interface FaultInjectionInterceptor {
  trigger(point: FaultPoint, context?: FaultContext): Promise<void>;
  register(rule: FaultRule): () => void;
  clear(): void;
  isEnabled(): boolean;
  getTriggeredCount(point?: FaultPoint): number;
}

class FaultInjectionRegistry implements FaultInjectionInterceptor {
  private rules: FaultRule[] = [];
  private triggeredCounts = new Map<FaultPoint, number>();

  isEnabled(): boolean {
    return this.rules.length > 0;
  }

  register(rule: FaultRule): () => void {
    const fullRule: FaultRule = {
      ...rule,
      maxTimes: rule.maxTimes ?? 1,
      triggeredCount: 0,
    };
    this.rules.push(fullRule);
    return () => {
      const idx = this.rules.indexOf(fullRule);
      if (idx !== -1) this.rules.splice(idx, 1);
    };
  }

  clear(): void {
    this.rules = [];
    this.triggeredCounts.clear();
  }

  getTriggeredCount(point?: FaultPoint): number {
    if (!point) {
      let total = 0;
      for (const count of this.triggeredCounts.values()) total += count;
      return total;
    }
    return this.triggeredCounts.get(point) ?? 0;
  }

  async trigger(point: FaultPoint, context: FaultContext = {}): Promise<void> {
    if (this.rules.length === 0) return;

    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      if (rule.point !== point) continue;
      if (rule.match && !rule.match(context)) continue;

      const maxTimes = rule.maxTimes ?? 1;
      const count = rule.triggeredCount ?? 0;
      if (count >= maxTimes) continue;

      rule.triggeredCount = count + 1;
      this.triggeredCounts.set(point, (this.triggeredCounts.get(point) ?? 0) + 1);

      // Execute fault action
      const action = rule.action;
      if (action.type === 'throw') {
        const err = typeof action.error === 'string' ? new Error(action.error) : action.error;
        throw err;
      } else if (action.type === 'custom') {
        await action.handler(context);
      } else if (action.type === 'hang') {
        const ms = action.timeoutMs ?? 60_000;
        await new Promise((resolve) => setTimeout(resolve, ms));
      } else if (action.type === 'kill_process') {
        const code = action.exitCode ?? 1;
        throw new Error(`CRASH_SIMULATION: Process hard kill (exit ${code}) at ${point}`);
      } else if (action.type === 'corrupt_data') {
        // Contextually handled if caller provides a transform target
        if ('data' in context && context.data !== undefined) {
          context.data = action.transform(context.data);
        }
      }
    }
  }
}

/** Global deterministic fault injector instance. Zero cost when no rules registered. */
export const faultInjector: FaultInjectionRegistry = new FaultInjectionRegistry();

/** Convenience helper for boundary checks. */
export async function injectFault(point: FaultPoint, context?: FaultContext): Promise<void> {
  if (faultInjector.isEnabled()) {
    await faultInjector.trigger(point, context);
  }
}
