import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import {
  OperationReconciliationGuard,
  classifyToolOutcome,
  computeOperationKey,
  computeSemanticOperationKey,
  reconcileBeforeCrossHarnessResume,
  verifyLeaseFencing,
} from '../src/services/executionRecovery.js';
import { RecoveryManager } from '../src/services/recoveryManager.js';
import type { ExecutionRecord, ToolCallRecord } from '../src/types/index.js';

async function createTestExecution(options?: { workerId?: string; computerId?: string }) {
  let durableSnapshot!: ExecutionRecord;
  const executions = new ExecutionEngine({
    persist: (record) => {
      durableSnapshot = structuredClone(record);
    },
  });

  const record = await executions.create({
    task: {
      id: 'task-portable-recovery',
      type: 'coding',
      input: 'implement feature safely',
      requirements: {},
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    },
    computerId: options?.computerId ?? 'worker-node-1',
    runtimeId: 'native-runtime',
    modelId: 'claude-3-7-sonnet',
    workerId: options?.workerId ?? 'worker-1',
  });

  const executionId = record.execution.id;
  await executions.setStatus(executionId, 'running');

  const restartEngine = async () => {
    const recovered = new ExecutionEngine({
      load: () => [durableSnapshot],
      persist: (r) => {
        durableSnapshot = structuredClone(r);
      },
    });
    await recovered.ready;
    return recovered;
  };

  return { executions, executionId, restartEngine };
}

describe('Agent C3: Side-Effect Reconciliation and Recovery Safety', () => {
  describe('Scenario 1: Worker crashes after command execution (physical state proves APPLIED)', () => {
    it('reconciles the operation as APPLIED, advances workspace revision, and prevents re-execution on resume', async () => {
      const { executions, executionId, restartEngine } = await createTestExecution();

      // Worker dispatches a mutating write tool call, then crashes before recording completion
      const input = { path: 'src/config.ts', content: 'export const PORT = 8080;\n' };
      await executions.recordToolStart(executionId, 'write_file', input, {
        callId: 'call-write-1',
        sideEffectClass: 'IDEMPOTENT_WRITE',
      });

      // Simulate restart after crash: tool call becomes OUTCOME_UNKNOWN
      const recovered = await restartEngine();
      const checkpointsBefore = recovered.toolCheckpoints(executionId);
      expect(checkpointsBefore).toHaveLength(1);
      expect(checkpointsBefore[0].state).toBe('OUTCOME_UNKNOWN');
      expect(classifyToolOutcome(checkpointsBefore[0])).toBe('OUTCOME_UNKNOWN');

      // Reconcile before cross-harness resume: physical inspection confirms the file has the expected content hash
      const result = await reconcileBeforeCrossHarnessResume({
        executions: recovered,
        executionId,
        inspectToolOutcome: async (_rec, call) => ({
          outcome: 'APPLIED',
          evidence: `File ${(call.input as { path: string }).path} matches sha256 digest of intended write`,
        }),
      });

      expect(result.safeToResume).toBe(true);
      expect(result.status).toBe('READY_TO_RESUME');
      expect(result.appliedCallIds).toEqual(['call-write-1']);
      expect(result.blockedCallIds).toEqual([]);
      expect(result.workspaceRevision).toBeGreaterThanOrEqual(1);

      // Verify checkpoint is now COMPLETED
      const checkpointsAfter = recovered.toolCheckpoints(executionId);
      expect(checkpointsAfter[0].state).toBe('COMPLETED');
      expect(classifyToolOutcome(checkpointsAfter[0])).toBe('CONFIRMED_COMPLETED');

      // If the target harness attempts to re-run the same mutation at revision 0, the guard blocks it
      const dupCheck = result.guard.checkDuplicateOperation({
        executionId,
        callId: 'call-write-1',
        toolName: 'write_file',
        input,
        workspaceRevision: 0,
      });
      expect(dupCheck.duplicate).toBe(true);
      expect(dupCheck.receipt?.outcome).toBe('APPLIED');
    });

    it('marks NOT_APPLIED when physical inspection proves command side effect is absent, allowing safe retry', async () => {
      const { executions, executionId, restartEngine } = await createTestExecution();

      await executions.recordToolStart(
        executionId,
        'write_file',
        { path: 'src/newFile.ts', content: 'hello' },
        { callId: 'call-write-absent', sideEffectClass: 'NON_IDEMPOTENT_WRITE' },
      );

      const recovered = await restartEngine();
      const result = await reconcileBeforeCrossHarnessResume({
        executions: recovered,
        executionId,
        inspectToolOutcome: async () => ({
          outcome: 'NOT_APPLIED',
          evidence: 'src/newFile.ts does not exist on disk and git status is clean',
        }),
      });

      expect(result.safeToResume).toBe(true);
      expect(result.status).toBe('READY_TO_RESUME');
      expect(result.retryableCallIds).toEqual(['call-write-absent']);
      expect(result.appliedCallIds).toEqual([]);

      // The operation was NOT applied, so the guard does not block retrying it
      const dupCheck = result.guard.checkDuplicateOperation({
        executionId,
        callId: 'call-write-retry',
        toolName: 'write_file',
        input: { path: 'src/newFile.ts', content: 'hello' },
        workspaceRevision: 0,
      });
      expect(dupCheck.duplicate).toBe(false);
    });
  });

  describe('Scenario 2: Network disconnects after tool dispatch with UNDETERMINED physical state', () => {
    it('blocks automatic retry fail-closed when physical state is UNDETERMINED and no operator authorization is given', async () => {
      const { executions, executionId } = await createTestExecution();

      await executions.recordToolStart(
        executionId,
        'bash',
        { command: 'curl -X POST https://api.example.com/deploy' },
        { callId: 'call-deploy-1', sideEffectClass: 'EXTERNAL_MUTATION' },
      );

      const result = await reconcileBeforeCrossHarnessResume({
        executions,
        executionId,
        inspectToolOutcome: async () => ({
          outcome: 'UNDETERMINED',
          evidence: 'Network disconnected during external POST; no idempotency receipt available',
        }),
      });

      expect(result.safeToResume).toBe(false);
      expect(result.status).toBe('BLOCKED_UNDETERMINED_OUTCOME');
      expect(result.blockedCallIds).toEqual(['call-deploy-1']);
      expect(result.retryableCallIds).toEqual([]);
      expect(result.appliedCallIds).toEqual([]);
      expect(result.reasons[0]).toContain('UNDETERMINED_SIDE_EFFECT');

      // Underlying execution checkpoint remains unresolved and blocks subsequent writes
      expect(executions.toolCheckpoints(executionId)[0].state).toBe('STARTED');
      await expect(
        executions.recordToolStart(executionId, 'write_file', { path: 'a.txt' }, { callId: 'call-next' }),
      ).rejects.toThrow('reconciled');
    });

    it('unblocks when an operator explicitly authorizes assume_applied or allow_retry, and aborts on abort', async () => {
      const { executions, executionId } = await createTestExecution();

      await executions.recordToolStart(
        executionId,
        'bash',
        { command: 'npm run migrate' },
        { callId: 'call-migrate-1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' },
      );

      // Operator authorizes assume_applied
      const resolvedApplied = await reconcileBeforeCrossHarnessResume({
        executions,
        executionId,
        inspectToolOutcome: async () => ({
          outcome: 'UNDETERMINED',
          evidence: 'Migration command stdout lost on disconnect',
        }),
        operatorAuthorizedResolution: {
          callId: 'call-migrate-1',
          decision: 'assume_applied',
          authorizedBy: 'ops-lead@wazir.dev',
          reason: 'Verified migration table row manually',
        },
      });

      expect(resolvedApplied.safeToResume).toBe(true);
      expect(resolvedApplied.status).toBe('READY_TO_RESUME');
      expect(resolvedApplied.appliedCallIds).toEqual(['call-migrate-1']);
      expect(resolvedApplied.resolutions[0].operatorAuthorized).toBe(true);
      expect(executions.toolCheckpoints(executionId)[0].state).toBe('COMPLETED');
    });

    it('handles operator allow_retry and abort decisions deterministically', async () => {
      const { executions, executionId } = await createTestExecution();

      await executions.recordToolStart(
        executionId,
        'bash',
        { command: 'scripts/sync.sh' },
        { callId: 'call-sync-1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' },
      );

      const abortResult = await reconcileBeforeCrossHarnessResume({
        executions,
        executionId,
        inspectToolOutcome: async () => ({ outcome: 'UNDETERMINED', evidence: 'timeout' }),
        operatorAuthorizedResolution: {
          callId: 'call-sync-1',
          decision: 'abort',
          authorizedBy: 'security-oncall',
        },
      });

      expect(abortResult.safeToResume).toBe(false);
      expect(abortResult.status).toBe('ABORTED_BY_OPERATOR');
      expect(abortResult.blockedCallIds).toEqual(['call-sync-1']);

      // Now test allow_retry on that same still-unresolved call
      const retryResult = await reconcileBeforeCrossHarnessResume({
        executions,
        executionId,
        inspectToolOutcome: async () => ({ outcome: 'UNDETERMINED', evidence: 'timeout' }),
        operatorAuthorizedResolution: {
          callId: 'call-sync-1',
          decision: 'allow_retry',
          authorizedBy: 'security-oncall',
          reason: 'Confirmed target staging bucket was rolled back',
        },
      });

      expect(retryResult.safeToResume).toBe(true);
      expect(retryResult.status).toBe('READY_TO_RESUME');
      expect(retryResult.retryableCallIds).toEqual(['call-sync-1']);
      expect(executions.toolCheckpoints(executionId)[0].state).toBe('FAILED');
    });
  });

  describe('Scenario 3: Checkpoint is written during interruption (in-flight tool call reconciled before resume)', () => {
    it('captures partial/in-flight tool calls in checkpoint and reconciles both read-only and mutating calls before resume', async () => {
      const { executions, executionId, restartEngine } = await createTestExecution();

      // Step 1: Completed tool call before interruption
      const completedInput = { path: 'README.md', content: '# Title\n' };
      await executions.recordToolStart(executionId, 'write_file', completedInput, {
        callId: 'call-step-1',
        sideEffectClass: 'IDEMPOTENT_WRITE',
      });
      const completedRecord: ToolCallRecord = {
        id: 'call-step-1',
        callId: 'call-step-1',
        tool: 'write_file',
        input: completedInput,
        output: 'wrote README.md',
        ok: true,
        policyEffect: 'allow',
        policyRule: 'default',
        durationMs: 12,
        at: new Date(),
      };
      await executions.recordToolCall(executionId, completedRecord);
      await executions.recordFilesChanged(executionId, ['README.md']);

      // Step 2: Interrupted read-only call and mutating call captured mid-flight
      await executions.recordToolStart(
        executionId,
        'read_file',
        { path: 'package.json' },
        { callId: 'call-read-inflight', sideEffectClass: 'READ_ONLY' },
      );
      await executions.recordToolStart(
        executionId,
        'patch_file',
        { path: 'src/index.ts', patch: '+export const ready = true;' },
        { callId: 'call-patch-inflight', sideEffectClass: 'NON_IDEMPOTENT_WRITE' },
      );

      // Simulate process interruption during checkpointing
      const recovered = await restartEngine();
      const { state, plan } = recovered.reconstruct(executionId);
      expect(state.unresolvedToolCalls).toHaveLength(2);
      expect(plan.action).toBe('reconcile');

      // Reconcile before cross-harness resume
      const reconciliation = await reconcileBeforeCrossHarnessResume({
        executions: recovered,
        executionId,
        inspectToolOutcome: async (_rec, call) => {
          if (call.callId === 'call-patch-inflight') {
            return {
              outcome: 'APPLIED',
              evidence: 'src/index.ts contains +export const ready = true;',
            };
          }
          return { outcome: 'UNDETERMINED', evidence: 'unexpected call' };
        },
      });

      expect(reconciliation.safeToResume).toBe(true);
      expect(reconciliation.status).toBe('READY_TO_RESUME');
      expect(reconciliation.retryableCallIds).toContain('call-read-inflight');
      expect(reconciliation.appliedCallIds).toContain('call-patch-inflight');

      // After reconciliation, planRecovery allows resuming the execution
      const postReconcile = recovered.reconstruct(executionId);
      expect(postReconcile.plan.action).toBe('resume');
      expect(postReconcile.state.workspaceRevision).toBe(2);
    });
  });

  describe('Scenario 4: Same operation is delivered twice (idempotency guard blocks duplicate mutation)', () => {
    it('computes deterministic operationKey and blocks duplicate delivery by callId or semantic tuple', async () => {
      const { executions, executionId } = await createTestExecution();

      const inputA = { path: 'src/app.ts', content: 'console.log(1);' };
      const inputAEquivalentOrder = { content: 'console.log(1);', path: 'src/app.ts' };

      const key1 = computeOperationKey({
        executionId,
        callId: 'call-100',
        toolName: 'write_file',
        input: inputA,
        workspaceRevision: 3,
      });
      const key2 = computeOperationKey({
        executionId,
        callId: 'call-100',
        toolName: 'write_file',
        input: inputAEquivalentOrder,
        workspaceRevision: 3,
      });
      expect(key1).toBe(key2);

      const sem1 = computeSemanticOperationKey({
        executionId,
        toolName: 'write_file',
        input: inputA,
        workspaceRevision: 3,
      });
      const sem2 = computeSemanticOperationKey({
        executionId,
        toolName: 'write_file',
        input: inputAEquivalentOrder,
        workspaceRevision: 3,
      });
      expect(sem1).toBe(sem2);

      const guard = new OperationReconciliationGuard();

      // First delivery is allowed
      const firstCheck = guard.checkDuplicateOperation({
        executionId,
        callId: 'call-100',
        toolName: 'write_file',
        input: inputA,
        workspaceRevision: 3,
      });
      expect(firstCheck.duplicate).toBe(false);

      // Record confirmed mutation receipt
      const receipt = guard.recordConfirmedMutation({
        executionId,
        callId: 'call-100',
        toolName: 'write_file',
        input: inputA,
        workspaceRevision: 3,
        output: 'File written (15 bytes)',
        evidence: 'sha256 match',
        sourceHarnessId: 'claude-code-acp',
        sourceWorkerId: 'worker-1',
      });

      // Duplicate delivery with exact same callId is blocked
      const duplicateByCallId = guard.checkDuplicateOperation({
        executionId,
        callId: 'call-100',
        toolName: 'write_file',
        input: inputA,
        workspaceRevision: 3,
      });
      expect(duplicateByCallId.duplicate).toBe(true);
      expect(duplicateByCallId.reason).toBe('DUPLICATE_CALL_ID');
      expect(duplicateByCallId.receipt).toEqual(receipt);

      // Duplicate delivery with a NEW callId (e.g. target harness retries the same tool+args at same workspaceRevision) is ALSO blocked
      const duplicateBySemantics = guard.checkDuplicateOperation({
        executionId,
        callId: 'call-200-reissued-by-new-harness',
        toolName: 'write_file',
        input: inputAEquivalentOrder,
        workspaceRevision: 3,
      });
      expect(duplicateBySemantics.duplicate).toBe(true);
      expect(duplicateBySemantics.reason).toBe('DUPLICATE_SEMANTIC_OPERATION');
      expect(duplicateBySemantics.receipt?.output).toBe('File written (15 bytes)');

      // Same tool & args at a NEW workspace revision is a distinct operation and is allowed
      const allowedAtNewRevision = guard.checkDuplicateOperation({
        executionId,
        callId: 'call-300',
        toolName: 'write_file',
        input: inputA,
        workspaceRevision: 4,
      });
      expect(allowedAtNewRevision.duplicate).toBe(false);

      void executions;
    });

    it('hydrates OperationReconciliationGuard from an existing ExecutionRecord so prior confirmed calls are never re-run', async () => {
      const { executions, executionId } = await createTestExecution();
      const input = { command: 'git commit -m "initial"' };

      await executions.recordToolStart(executionId, 'shell', input, {
        callId: 'commit-call-1',
        sideEffectClass: 'NON_IDEMPOTENT_WRITE',
      });
      await executions.recordToolCall(executionId, {
        id: 'commit-call-1',
        callId: 'commit-call-1',
        tool: 'shell',
        input,
        output: '[main abc1234] initial',
        ok: true,
        policyEffect: 'allow',
        policyRule: 'allow-git',
        durationMs: 45,
        at: new Date(),
      });

      const record = (await executions.get(executionId))!;
      const guard = OperationReconciliationGuard.fromExecutionRecord(record);

      const check = guard.checkDuplicateOperation({
        executionId,
        callId: 'commit-call-2-after-handoff',
        toolName: 'shell',
        input,
        workspaceRevision: 0,
      });
      expect(check.duplicate).toBe(true);
      expect(check.reason).toBe('DUPLICATE_SEMANTIC_OPERATION');
      expect(check.receipt?.output).toBe('[main abc1234] initial');
    });
  });

  describe('Scenario 5: Old worker reports completion after reassignment (lease/ownership fencing rejects stale worker)', () => {
    it('increments lease epoch on worker reassignment and rejects late completion or tool reports from the old worker', async () => {
      const { executions, executionId } = await createTestExecution({ workerId: 'worker-old' });

      const manager = new RecoveryManager({
        computers: { checkHeartbeats: () => ({ offline: [], stale: [] }) } as never,
        executions,
        jobManager: { list: () => [] } as never,
      });

      // Initial lease acquired by worker-old (epoch 1)
      const lease1 = await manager.reassignExecutionLease(executionId, 'worker-old', {
        harnessId: 'native-harness',
      });
      expect(lease1.epoch).toBe(1);
      expect(lease1.workerId).toBe('worker-old');

      // Worker-old is lost; execution is reassigned to worker-new on codex-cli (epoch 2)
      const lease2 = await manager.reassignExecutionLease(executionId, 'worker-new', {
        harnessId: 'codex-cli',
      });
      expect(lease2.epoch).toBe(2);
      expect(lease2.workerId).toBe('worker-new');

      // Old worker wakes up from network partition and attempts to report completion with epoch 1
      const staleCheck = manager.verifyWorkerReport(executionId, {
        workerId: 'worker-old',
        epoch: 1,
        leaseId: lease1.leaseId,
      });
      expect(staleCheck.allowed).toBe(false);
      expect(staleCheck.code).toBe('STALE_WORKER_FENCED');
      expect(staleCheck.currentHolder).toEqual({
        leaseId: lease2.leaseId,
        workerId: 'worker-new',
        epoch: 2,
      });

      // ExecutionEngine also enforces lease fencing directly on state mutations
      await expect(
        executions.setStatus(executionId, 'completed', {
          workerId: 'worker-old',
          leaseEpoch: 1,
        }),
      ).rejects.toThrow(/Stale lease epoch|does not hold the lease/);

      // New worker with epoch 2 passes fencing verification
      const validCheck = manager.verifyWorkerReport(executionId, {
        workerId: 'worker-new',
        epoch: 2,
        leaseId: lease2.leaseId,
      });
      expect(validCheck.allowed).toBe(true);
      expect(validCheck.code).toBeUndefined();
    });

    it('rejects expired or released leases with STALE_WORKER_FENCED', () => {
      const past = new Date(Date.now() - 10_000);
      const expiredResult = verifyLeaseFencing(
        {
          executionId: 'exec-1',
          leaseId: 'lease-1',
          workerId: 'worker-1',
          epoch: 3,
          expiresAt: past,
        },
        { workerId: 'worker-1', epoch: 3, now: new Date() },
      );
      expect(expiredResult.allowed).toBe(false);
      expect(expiredResult.code).toBe('STALE_WORKER_FENCED');
      expect(expiredResult.reason).toContain('expired');

      const releasedResult = verifyLeaseFencing(
        {
          executionId: 'exec-1',
          leaseId: 'lease-1',
          workerId: 'worker-1',
          epoch: 3,
          released: true,
        },
        { workerId: 'worker-1', epoch: 3 },
      );
      expect(releasedResult.allowed).toBe(false);
      expect(releasedResult.code).toBe('STALE_WORKER_FENCED');
      expect(releasedResult.reason).toContain('released');
    });

    it('integrates RecoveryManager sweep physical reconciliation with OperationReconciliationGuard', async () => {
      const { executions, executionId } = await createTestExecution({
        computerId: 'dead-computer',
        workerId: 'dead-worker',
      });

      const writeInput = { path: 'src/feature.ts', content: 'export const x = 42;' };
      await executions.recordToolStart(executionId, 'write_file', writeInput, {
        callId: 'call-sweep-1',
        sideEffectClass: 'IDEMPOTENT_WRITE',
      });

      const manager = new RecoveryManager({
        computers: { checkHeartbeats: () => ({ offline: ['dead-computer'], stale: [] }) } as never,
        executions,
        jobManager: { list: () => [] } as never,
        inspectToolOutcome: async () => ({
          outcome: 'APPLIED',
          evidence: 'src/feature.ts verified on shared workspace',
        }),
      });

      const sweepResult = await manager.sweep();
      expect(sweepResult.reconciled).toHaveLength(1);
      expect(sweepResult.reconciled[0].outcome).toBe('APPLIED');

      // RecoveryManager's operationGuard automatically recorded the confirmed mutation receipt
      const dup = manager.getOperationGuard().checkDuplicateOperation({
        executionId,
        callId: 'retry-call-after-sweep',
        toolName: 'write_file',
        input: writeInput,
        workspaceRevision: 0,
      });
      expect(dup.duplicate).toBe(true);
      expect(dup.receipt?.evidence).toBe('src/feature.ts verified on shared workspace');
    });

    it('RecoveryManager.reconcileForCrossHarnessResume delegates to reconcileBeforeCrossHarnessResume and updates guard', async () => {
      const { executions, executionId } = await createTestExecution();
      const input = { path: 'src/delegated.ts', content: 'export const ok = true;' };
      await executions.recordToolStart(executionId, 'write_file', input, {
        callId: 'call-del-1',
        sideEffectClass: 'IDEMPOTENT_WRITE',
      });

      const manager = new RecoveryManager({
        computers: { checkHeartbeats: () => ({ offline: [], stale: [] }) } as never,
        executions,
        jobManager: { list: () => [] } as never,
        inspectToolOutcome: async () => ({
          outcome: 'APPLIED',
          evidence: 'src/delegated.ts verified via RecoveryManager',
        }),
      });

      const res = await manager.reconcileForCrossHarnessResume(executionId);
      expect(res.safeToResume).toBe(true);
      expect(res.appliedCallIds).toEqual(['call-del-1']);
      expect(manager.getOperationGuard().listReceipts(executionId)).toHaveLength(1);
    });

    it('treats inspector exceptions as UNDETERMINED fail-closed rather than crashing or assuming success', async () => {
      const { executions, executionId } = await createTestExecution();
      await executions.recordToolStart(
        executionId,
        'write_file',
        { path: 'src/err.ts', content: 'boom' },
        { callId: 'call-err-1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' },
      );

      const res = await reconcileBeforeCrossHarnessResume({
        executions,
        executionId,
        inspectToolOutcome: async () => {
          throw new Error('EIO: disk read error during physical check');
        },
      });

      expect(res.safeToResume).toBe(false);
      expect(res.status).toBe('BLOCKED_UNDETERMINED_OUTCOME');
      expect(res.blockedCallIds).toEqual(['call-err-1']);
      expect(res.resolutions[0].evidence).toContain('EIO: disk read error');
    });
  });
});
