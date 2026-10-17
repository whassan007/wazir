import type { JobStatus } from '../types/job.js';
import type { TaskStatus } from '../types/task.js';

/**
 * Canonical job/task status transition policy.
 *
 * The rule that matters for correctness when several controllers (local
 * orchestrator, remote workers, mobile/desktop clients) write the same mission
 * is: terminal work is never silently resurrected. A late write from a stale
 * worker must not flip a cancelled task back to `running`, or a completed job
 * back to `pending`.
 *
 * Deliberately permissive elsewhere so existing recovery flows keep working:
 *  - same-state writes are always allowed (idempotent re-flushes);
 *  - a failed task may be retried (`pending` / `scheduled`);
 *  - a terminal job may be re-labelled with another terminal status, because
 *    finalizers reconcile cancel-vs-timeout-vs-failure races after the fact.
 */
export class InvalidStatusTransitionError extends Error {
  readonly code = 'INVALID_STATUS_TRANSITION';
  constructor(readonly kind: 'job' | 'task', readonly from: string, readonly to: string, readonly id: string) {
    super(`Invalid ${kind} status transition for '${id}': ${from} -> ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

const TERMINAL_JOB: ReadonlySet<JobStatus> = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_TASK: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);
const TASK_RETRY_TARGETS: ReadonlySet<TaskStatus> = new Set(['pending', 'scheduled']);

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB.has(status);
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK.has(status);
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return true;
  if (TERMINAL_JOB.has(from)) return TERMINAL_JOB.has(to);
  return true;
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  if (from === 'failed') return TASK_RETRY_TARGETS.has(to);
  if (TERMINAL_TASK.has(from)) return false;
  return true;
}

export function assertJobTransition(id: string, from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) throw new InvalidStatusTransitionError('job', from, to, id);
}

export function assertTaskTransition(id: string, from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new InvalidStatusTransitionError('task', from, to, id);
}
