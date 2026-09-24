import type { ExecutionEngine, ExecutionRecord, ToolCallCheckpoint, ToolOutcomeInspection } from '@wazir/core';
import { inspectToolOutcome } from '@wazir/tools';

/**
 * Physical-state inspector for RecoveryManager and startup reconciliation. It only
 * inspects when this process can see the execution's actual files: the execution ran
 * on this computer, and not inside a job task's worktree (whose path the execution
 * record does not carry). Anything else is UNDETERMINED with that reason, so it stays
 * blocked for an operator instead of being judged against the wrong directory.
 */
export function localOutcomeInspector(projectRoot: string, localComputerId: string) {
  return async (record: ExecutionRecord, call: ToolCallCheckpoint): Promise<ToolOutcomeInspection> => {
    if (record.execution.computerId !== localComputerId) {
      return { outcome: 'UNDETERMINED', evidence: `execution ran on '${record.execution.computerId ?? 'a hosted runtime'}', whose files this process cannot inspect` };
    }
    if (record.execution.jobId) {
      return { outcome: 'UNDETERMINED', evidence: 'job task ran in a worktree whose path is not recorded on the execution' };
    }
    return inspectToolOutcome(projectRoot, call);
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
