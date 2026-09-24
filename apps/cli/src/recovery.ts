import { summarizeExecution } from '@wazir/core';
import type { AgentResumeContext, ExecutionEngine, ExecutionRecord, ToolCallCheckpoint, ToolOutcomeInspection } from '@wazir/core';
import { existsSync } from 'node:fs';
import { inspectToolOutcome } from '@wazir/tools';

/**
 * Physical-state inspector for RecoveryManager and startup reconciliation. It only
 * inspects when this process can see the execution's actual files: the execution ran
 * on this computer, in the workspace root recorded on it (the project root, or a job
 * task's worktree). An execution with no recorded root is only inspected when it is a
 * standalone run, which always uses the project root; a job task without one ran in a
 * worktree this process can't locate. Anything else is UNDETERMINED with that reason,
 * so it stays blocked for an operator instead of being judged against the wrong tree.
 */
export function localOutcomeInspector(projectRoot: string, localComputerId: string) {
  return async (record: ExecutionRecord, call: ToolCallCheckpoint): Promise<ToolOutcomeInspection> => {
    if (record.execution.computerId !== localComputerId) {
      return { outcome: 'UNDETERMINED', evidence: `execution ran on '${record.execution.computerId ?? 'a hosted runtime'}', whose files this process cannot inspect` };
    }
    const root = record.execution.workspaceRoot ?? (record.execution.jobId ? undefined : projectRoot);
    if (!root) {
      return { outcome: 'UNDETERMINED', evidence: 'job task ran in a worktree whose path is not recorded on the execution' };
    }
    if (!existsSync(root)) {
      return { outcome: 'UNDETERMINED', evidence: `recorded workspace '${root}' no longer exists` };
    }
    return inspectToolOutcome(root, call);
  };
}

/**
 * Process-restart recovery for local standalone executions: ExecutionEngine marks a
 * dispatched call with no recorded result as OUTCOME_UNKNOWN on load; this resolves
 * the ones physical state can prove. Returns what it reconciled.
 */
export async function reconcileLocalOutcomes(
  executions: ExecutionEngine,
  inspect: (record: ExecutionRecord, call: ToolCallCheckpoint) => Promise<ToolOutcomeInspection>,
): Promise<Array<{ executionId: string; callId: string; outcome: string }>> {
  const done: Array<{ executionId: string; callId: string; outcome: string }> = [];
  for (const record of await executions.list()) {
    // Another live `wa` process's in-flight calls are its own to resolve.
    if (executions.ownedByAnotherLiveProcess(record)) continue;
    for (const call of executions.toolCheckpoints(record.execution.id)) {
      if (call.state !== 'STARTED' && call.state !== 'OUTCOME_UNKNOWN') continue;
      const inspection = await inspect(record, call).catch((): ToolOutcomeInspection => ({ outcome: 'UNDETERMINED', evidence: 'inspection failed' }));
      if (inspection.outcome === 'UNDETERMINED') continue;
      await executions.reconcileToolCall(record.execution.id, call.callId, { ...inspection, inspectedBy: 'startup-recovery' });
      done.push({ executionId: record.execution.id, callId: call.callId, outcome: inspection.outcome });
    }
  }
  return done;
}

export type TaskResumePlan =
  | { action: 'resume'; reasons: string[]; resume: AgentResumeContext }
  | { action: 'refuse'; reasons: string[] };

/**
 * Before a retried task runs again on its existing execution, decide — from durable
 * facts only — whether that execution can safely continue:
 *   1. resolve any dispatched-but-unconfirmed tool calls that physical state proves;
 *   2. reconstruct the execution from its events and plan recovery;
 *   3. resume with the inherited state, or refuse with the reason.
 * A still-unresolved non-read-only call refuses: the side effect may already have
 * happened, so re-running the agent could repeat it. The refusal is recorded on the
 * execution; the resumption is recorded as `execution.resumed`.
 */
export async function planTaskResume(
  executions: ExecutionEngine,
  executionId: string,
  inspect: (record: ExecutionRecord, call: ToolCallCheckpoint) => Promise<ToolOutcomeInspection>,
): Promise<TaskResumePlan> {
  const reconciled: string[] = [];
  const record = executions.require(executionId);
  for (const call of executions.toolCheckpoints(executionId)) {
    if (call.state !== 'STARTED' && call.state !== 'OUTCOME_UNKNOWN') continue;
    const inspection = await inspect(record, call).catch((): ToolOutcomeInspection => ({ outcome: 'UNDETERMINED', evidence: 'inspection failed' }));
    if (inspection.outcome === 'UNDETERMINED') continue;
    await executions.reconcileToolCall(executionId, call.callId, { ...inspection, inspectedBy: 'task-resume' });
    reconciled.push(`'${call.toolName}' ${inspection.outcome}: ${inspection.evidence}`);
  }

  const { state, plan } = executions.reconstruct(executionId);
  // A retry re-runs a task whose previous attempt ended (failed/cancelled/orphaned);
  // that terminal status is what's being recovered, so only unresolved side effects
  // and budgets decide — not the status itself. A completed execution is never resumed.
  if (state.status === 'completed') return { action: 'refuse', reasons: ['execution already completed'] };
  // Checked directly: planRecovery reports 'none' for a terminal status before it looks
  // at unresolved calls, and a retried execution is usually already 'failed'.
  const blocking = state.unresolvedToolCalls.filter((c) => c.sideEffectClass !== 'READ_ONLY');
  if (blocking.length > 0 || plan.action === 'terminate') {
    const reasons = blocking.length > 0
      ? blocking.map((c) => `'${c.toolName}' (call ${c.callId}) was dispatched with no confirmed outcome; physical state cannot prove whether it happened, so the task is not re-run — reconcile it first`)
      : plan.reasons;
    await executions.recordError(executionId, `RESUME_REFUSED: ${reasons.join(' | ')}`);
    return { action: 'refuse', reasons };
  }
  const planReasons = plan.action === 'none'
    ? [`previous attempt ended ${state.status}; resuming the same execution at workspace revision ${state.workspaceRevision}`]
    : plan.reasons;

  const summary = summarizeExecution(executions.require(executionId));
  const resumedBefore = (await executions.events(executionId)).filter((e) => (e.eventType ?? e.type) === 'execution.resumed').length;
  const current = executions.require(executionId);
  const resume: AgentResumeContext = {
    executionId,
    attempt: resumedBefore + 2,
    workspaceRevision: state.workspaceRevision,
    filesChanged: [...current.filesChanged],
    consumed: { toolCalls: summary.agentRunStats?.toolCalls ?? current.toolCalls.length, tokens: summary.agentRunStats?.tokensUsed ?? summary.tokens?.total ?? 0 },
    verification: { passing: state.verification.currentPassing, failing: state.verification.currentFailing, stale: state.verification.staleChecks },
    previousTermination: summary.terminationReason,
    lastError: current.errors.at(-1) ?? null,
    reconciled,
  };
  const reasons = [...planReasons, ...reconciled.map((r) => `reconciled ${r}`)];
  // errorsBefore: earlier attempts' errors stay as history but don't decide this attempt
  // (see evaluation's currentAttemptErrors).
  await executions.recordEvent(executionId, 'execution.resumed', {
    attempt: resume.attempt, workspaceRevision: resume.workspaceRevision, consumed: resume.consumed,
    errorsBefore: current.errors.length, reasons,
  });
  return { action: 'resume', reasons, resume };
}
