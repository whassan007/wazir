import type { AgentState, JobStatus } from '../types/job.js';
import type { TaskStatus } from '../types/task.js';
import type { ExecutionStatus } from '../types/execution.js';

/**
 * Lifecycle transition rules for jobs, tasks, graph nodes and executions.
 *
 * Invariants:
 *   - `completed` and `cancelled` are final: nothing moves out of them. Re-applying the
 *     same status is an idempotent no-op (a duplicate event, not a new transition).
 *   - `failed` is final except for an explicit retry, which must first go back to the
 *     queued state (task `pending`, node `idle`); a failed task never jumps straight to
 *     `running` or `completed`. Executions resume only through an explicit, recorded
 *     resumption (see ExecutionEngine.setStatus).
 *   - Moving between two different terminal statuses (completed → failed,
 *     failed → cancelled, …) is always rejected: that is a late, stale event
 *     overwriting an outcome that was already settled.
 */
export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_STATE_TRANSITION';
  constructor(readonly entity: string, readonly id: string, readonly from: string, readonly to: string) {
    super(`INVALID_STATE_TRANSITION: ${entity} '${id}' cannot move from '${from}' to '${to}'`);
    this.name = 'InvalidTransitionError';
  }
}

const FINAL = new Set(['completed', 'cancelled']);
const EXECUTION_FINAL = new Set(['completed']);

function allowed(from: string, to: string, retryState: string | undefined): boolean {
  if (from === to) return true;
  if (FINAL.has(from)) return false;
  if (from === 'failed') return to === retryState;
  return true;
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return allowed(from, to, 'pending');
}

export function canTransitionNode(from: AgentState, to: AgentState): boolean {
  return allowed(from, to, 'idle');
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  // A finished job is never re-run in place; a new run is a new job.
  return allowed(from, to, undefined);
}

/**
 * Executions differ in one way: a retried task continues its existing execution
 * (planTaskResume), so a failed or cancelled execution may become active again, but only
 * once an explicit resumption was recorded after it ended (`resumeAuthorized`). It still
 * may never jump straight to another terminal status.
 */
export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus, resumeAuthorized: boolean): boolean {
  if (from === to) return true;
  if (EXECUTION_FINAL.has(from)) return false;
  if (from === 'failed' || from === 'cancelled') {
    return resumeAuthorized && !['completed', 'failed', 'cancelled'].includes(to);
  }
  return true;
}

export function assertTaskTransition(id: string, from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new InvalidTransitionError('task', id, from, to);
}

export function assertNodeTransition(id: string, from: AgentState, to: AgentState): void {
  if (!canTransitionNode(from, to)) throw new InvalidTransitionError('node', id, from, to);
}

export function assertJobTransition(id: string, from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) throw new InvalidTransitionError('job', id, from, to);
}
