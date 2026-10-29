import type { ComputerRegistry } from './computerRegistry.js';
import type { ExecutionEngine } from './executionEngine.js';
import type { JobManager } from './jobManager.js';
import type { JobOrchestrator } from './jobOrchestrator.js';
import {
  OperationReconciliationGuard,
  reconcileBeforeCrossHarnessResume,
  verifyLeaseFencing,
  type CrossHarnessReconciliationResult,
  type LeaseFencingClaim,
  type LeaseFencingResult,
  type LeaseFencingState,
  type OperatorAuthorizedResolution,
  type ToolOutcomeInspection,
} from './executionRecovery.js';
import type { ExecutionRecord, ToolCallCheckpoint } from '../types/execution.js';

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
  /**
   * Physical-state inspection for tool calls with no recorded outcome (e.g. tools'
   * `inspectToolOutcome`). When provided, each such call is inspected and reconciled
   * if — and only if — the evidence proves APPLIED or NOT_APPLIED. Without it, every
   * unknown outcome stays blocked for an operator, as before.
   */
  inspectToolOutcome?: (record: ExecutionRecord, call: ToolCallCheckpoint) => Promise<ToolOutcomeInspection>;
  /** Optional shared operation reconciliation guard for deduplicating side effects across sweeps/resumes. */
  operationGuard?: OperationReconciliationGuard;
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
  /** Unknown outcomes resolved from physical evidence during this sweep. */
  reconciled: Array<{ executionId: string; callId: string; tool: string; outcome: 'APPLIED' | 'NOT_APPLIED'; evidence: string }>;
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
  private readonly operationGuard: OperationReconciliationGuard;

  constructor(private readonly deps: RecoveryManagerOptions) {
    this.operationGuard = deps.operationGuard ?? new OperationReconciliationGuard();
  }

  getOperationGuard(): OperationReconciliationGuard {
    return this.operationGuard;
  }

  /**
   * Acquires or reassigns lease ownership for an execution, incrementing the fencing epoch.
   * Any subsequent reports from previous workers/epochs are rejected by `verifyWorkerReport`.
   */
  async reassignExecutionLease(
    executionId: string,
    newWorkerId: string,
    options?: { harnessId?: string; ttlMs?: number; now?: Date },
  ): Promise<LeaseFencingState> {
    const now = options?.now ?? new Date();
    const ttlMs = options?.ttlMs ?? 30_000;
    // Persist ownership through the engine so restarts and direct engine mutations
    // observe the same fencing epoch. A failed persistence operation must propagate.
    const existing = this.deps.executions.getLease(executionId);
    if (existing && !existing.released && existing.workerId !== newWorkerId) {
      await this.deps.executions.releaseLease(executionId, existing.workerId, {
        epoch: existing.epoch,
        now,
      });
    }
    const acquired = await this.deps.executions.acquireLease(executionId, newWorkerId, { ttlMs, now });
    const fenced: LeaseFencingState = {
      executionId,
      leaseId: acquired.token,
      workerId: acquired.workerId,
      epoch: acquired.epoch,
      harnessId: options?.harnessId,
      released: acquired.released,
      expiresAt: acquired.expiresAt,
    };
    return structuredClone(fenced);
  }

  /**
   * Verifies that a worker reporting completion or events holds the current active lease epoch.
   */
  verifyWorkerReport(executionId: string, claim: LeaseFencingClaim): LeaseFencingResult {
    const tracked = this.deps.executions.getLease(executionId);
    return verifyLeaseFencing(tracked, claim);
  }

  /**
   * Reconciles all unresolved side effects for an execution before cross-harness resume.
   */
  async reconcileForCrossHarnessResume(
    executionId: string,
    options?: {
      inspectToolOutcome?: (record: ExecutionRecord, call: ToolCallCheckpoint) => Promise<ToolOutcomeInspection>;
      operatorAuthorizedResolution?: OperatorAuthorizedResolution | OperatorAuthorizedResolution[];
      advanceRevisionOnApplied?: boolean;
    },
  ): Promise<CrossHarnessReconciliationResult> {
    return reconcileBeforeCrossHarnessResume({
      executions: this.deps.executions,
      executionId,
      inspectToolOutcome: options?.inspectToolOutcome ?? this.deps.inspectToolOutcome,
      operatorAuthorizedResolution: options?.operatorAuthorizedResolution,
      guard: this.operationGuard,
      advanceRevisionOnApplied: options?.advanceRevisionOnApplied,
    });
  }

  async sweep(): Promise<RecoverySweepResult> {
    const { offline } = this.deps.computers.checkHeartbeats({
      staleMs: this.deps.staleMs,
      offlineMs: this.deps.offlineMs,
    });

    const orphanedExecutions: string[] = [];
    const retriedLive: string[] = [];
    const unknownOutcomes: RecoverySweepResult['unknownOutcomes'] = [];
    const reconciled: RecoverySweepResult['reconciled'] = [];

    for (const computerId of offline) {
      const active = await this.deps.executions.listActiveByComputer(computerId);
      for (const record of active) {
        // A live process on this host is still running it; that process heartbeats its
        // own worker, so this registry's view of the computer is not evidence it died.
        if (this.deps.executions.ownedByAnotherLiveProcess(record)) continue;
        const taskId = record.execution.taskId;
        // Durable step checkpoints: a 'tool.started' with no matching
        // 'tool.completed' means the last tool call's actual outcome is
        // unknown — it may have already run (a git commit, a file write, a
        // remote dispatch) before this worker went dark. Flagging it here,
        // before orphan()/reportExecutionOrphaned() below, is what stops
        // that from being silently retried as if nothing happened.
        if (this.deps.inspectToolOutcome) {
          await this.reconcileFromPhysicalState(record, reconciled);
        }
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

    const result: RecoverySweepResult = { offlineComputers: offline, orphanedExecutions, retriedLive, unknownOutcomes, reconciled };
    if (offline.length > 0) this.deps.onSweep?.(result);
    return result;
  }

  private async reconcileFromPhysicalState(record: ExecutionRecord, reconciled: RecoverySweepResult['reconciled']): Promise<void> {
    const executionId = record.execution.id;
    for (const call of this.deps.executions.toolCheckpoints(executionId)) {
      if (call.state !== 'STARTED' && call.state !== 'OUTCOME_UNKNOWN') continue;
      let inspection: ToolOutcomeInspection;
      try {
        inspection = await this.deps.inspectToolOutcome!(record, call);
      } catch {
        continue; // an inspector failure proves nothing; the call stays unresolved
      }
      if (inspection.outcome === 'UNDETERMINED') continue;
      await this.deps.executions.reconcileToolCall(executionId, call.callId, { ...inspection, inspectedBy: 'recovery-manager' });
      if (inspection.outcome === 'APPLIED') {
        this.operationGuard.recordConfirmedMutation({
          executionId,
          callId: call.callId,
          toolName: call.toolName,
          argumentsHash: call.argumentsHash,
          input: call.input,
          workspaceRevision: call.workspaceRevision,
          evidence: inspection.evidence,
        });
      }
      reconciled.push({ executionId, callId: call.callId, tool: call.toolName, outcome: inspection.outcome, evidence: inspection.evidence });
    }
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
