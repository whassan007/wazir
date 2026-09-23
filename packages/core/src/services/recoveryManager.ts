import type { ComputerRegistry } from './computerRegistry.js';
import type { ExecutionEngine } from './executionEngine.js';
import type { JobManager } from './jobManager.js';
import type { JobOrchestrator } from './jobOrchestrator.js';

export interface RecoveryManagerOptions {
  computers: ComputerRegistry;
  executions: ExecutionEngine;
  jobManager: JobManager;
  /** Optional: when set, an orphaned task belonging to a job this process is actively
   *  running (runJob() in flight) is retried live instead of only marked failed on disk. */
  orchestrator?: JobOrchestrator;
  /** A computer with no heartbeat for this long is considered stale (degraded, not offline). */
  staleMs?: number;
  /** A computer with no heartbeat for this long is considered offline — its in-flight
   *  executions are orphaned and, where possible, retried. */
  offlineMs?: number;
  onSweep?: (result: RecoverySweepResult) => void;
}

export interface RecoverySweepResult {
  offlineComputers: string[];
  orphanedExecutions: string[];
  retriedLive: string[];
  /** Executions orphaned with a mutating tool call whose outcome is unknown (an intent
   *  record with no matching result — see ExecutionEngine.findUnknownOutcomeToolCall).
   *  These are deliberately excluded from retriedLive: automatically re-running a git
   *  commit or file write that may have already landed risks double-applying it. */
  unknownOutcomes: Array<{ executionId: string; taskId: string; tool: string }>;
}

/**
 * Closes the gap between "a worker stopped heartbeating" and "anything actually notices":
 * ComputerRegistry.checkHeartbeats() already computes stale/offline computers but nothing
 * ever called it, so a dead worker's in-flight executions sat forever as 'running' with no
 * path back to retry. This periodically sweeps heartbeats, and for every computer that just
 * went offline, orphans its non-terminal executions (ExecutionEngine.orphan) and — for any
 * task belonging to a job this process is actively driving — reports it to the JobOrchestrator
 * so it retries through the normal maxRetries path instead of being stuck.
 *
 * What this deliberately does not attempt: reassigning an orphaned task to a *different*
 * computer mid-execution, or resuming a job whose own owning process (not just its worker)
 * has died — that's process-restart recovery, already handled by
 * JobManager.reconcileStaleStatus() at load time.
 */
export class RecoveryManager {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: RecoveryManagerOptions) {}

  async sweep(): Promise<RecoverySweepResult> {
    const { offline } = this.deps.computers.checkHeartbeats({
      staleMs: this.deps.staleMs,
      offlineMs: this.deps.offlineMs,
    });

    const orphanedExecutions: string[] = [];
    const retriedLive: string[] = [];
    const unknownOutcomes: RecoverySweepResult['unknownOutcomes'] = [];

    for (const computerId of offline) {
      const active = await this.deps.executions.listActiveByComputer(computerId);
      for (const record of active) {
        const taskId = record.execution.taskId;
        // Durable step checkpoints: a 'tool.started' with no matching
        // 'tool.completed' means the last tool call's actual outcome is
        // unknown — it may have already run (a git commit, a file write, a
        // remote dispatch) before this worker went dark. Flagging it here,
        // before orphan()/reportExecutionOrphaned() below, is what stops
        // that from being silently retried as if nothing happened.
        const unknown = this.deps.executions.findUnknownOutcomeToolCall(record.execution.id);
        const reason = unknown
          ? `UNKNOWN_OUTCOME: worker on computer '${computerId}' stopped heartbeating mid-'${unknown.tool}' — its outcome is unrecorded and must not be assumed safe to retry`
          : `Worker on computer '${computerId}' stopped heartbeating`;

        await this.deps.executions.orphan(record.execution.id, reason);
        orphanedExecutions.push(record.execution.id);

        if (unknown) {
          unknownOutcomes.push({ executionId: record.execution.id, taskId, tool: unknown.tool });
          continue; // deliberately not reported to the orchestrator — see the field doc above
        }

        if (this.deps.orchestrator) {
          const jobId = this.findOwningJobId(taskId);
          if (jobId && this.deps.orchestrator.reportExecutionOrphaned(jobId, taskId, reason)) {
            retriedLive.push(taskId);
          }
        }
      }
    }

    const result: RecoverySweepResult = { offlineComputers: offline, orphanedExecutions, retriedLive, unknownOutcomes };
    if (offline.length > 0) this.deps.onSweep?.(result);
    return result;
  }

  private findOwningJobId(taskId: string): string | undefined {
    for (const job of this.deps.jobManager.list()) {
      if (job.tasks.some((t) => t.id === taskId)) return job.id;
    }
    return undefined;
  }

  start(intervalMs = 15_000): () => void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export function createRecoveryManager(options: RecoveryManagerOptions): RecoveryManager {
  return new RecoveryManager(options);
}
