import { describe, expect, it, vi } from 'vitest';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { JobOrchestrator } from '../src/services/jobOrchestrator.js';
import { HarnessDispatchService, HARNESS_CONTRACT_SCHEMA_VERSION, type HarnessRunner, type UnifiedExecutionRequest } from '../src/services/harnessDispatchService.js';
import { OperationReconciliationGuard, reconcileBeforeCrossHarnessResume } from '../src/services/executionRecovery.js';
import type { Scheduler } from '../src/services/scheduler.js';
import type { ExecutionRecord } from '../src/types/execution.js';

const task = (id: string) => ({ id, type: 'coding' as const, input: 'test', requirements: {}, priority: 'normal' as const, status: 'pending' as const, createdAt: new Date() });

describe('Group D recovery and replay safety', () => {
  it.each(['returned failure', 'thrown failure'])('D-01 blocks retry after %s with an unknown mutation', async (failure) => {
    const engine = new ExecutionEngine();
    const executor = vi.fn(async (current: { id: string }) => {
      const record = (await engine.listByTask(current.id))[0];
      await engine.recordToolStart(record.execution.id, 'charge_customer', { amount: 20 }, { callId: 'charge-1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
      if (failure === 'thrown failure') throw new Error('connection lost');
      return { success: false, error: 'connection lost' };
    });
    const scheduler = { plan: () => ({ agentId: 'agent', modelId: 'model', runtimeId: 'runtime' }) } as unknown as Scheduler;
    const orchestrator = new JobOrchestrator({ scheduler, executionEngine: engine, taskExecutor: executor });
    const job = await orchestrator.createJob({ title: 'charge', maxRetries: 2, tasks: [{ task: { id: 'charge-task', input: 'charge' } }] });
    const finished = await orchestrator.runJob(job.id);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(finished.status).toBe('failed');
    expect(finished.graph.nodes[0]).toMatchObject({ state: 'failed' });
    expect(finished.graph.nodes[0].retryCount ?? 0).toBe(0);
    expect(finished.graph.nodes[0].error).toContain('[TOOL_OUTCOME_UNKNOWN]');
    expect(finished.tasks[0].status).toBe('failed');
  });

  it('D-02 blocks fallback for an unknown tool with no provenance', async () => {
    const primary: HarnessRunner = {
      descriptor: { harnessId: 'primary', name: 'primary', version: '1', kind: 'native', capabilities: ['coding'], supportedTaskTypes: ['coding'], supportedProtocols: ['native'], allowsModelSelection: true },
      execute: async (request) => ({
        schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION, executionId: request.executionId, taskId: request.taskId,
        harnessId: 'primary', modelId: 'm', runtimeId: 'r', status: 'interrupted', errorKind: 'infrastructure',
        workspaceRevision: 0, artifacts: [], verificationEvidenceIds: [], usage: { durationMs: 1 },
        toolCalls: [{ id: 'deploy-1', tool: 'custom_deploy', input: {}, ok: false, failureClass: 'TOOL_OUTCOME_UNKNOWN', policyEffect: 'allow', policyRule: 'test', durationMs: 1, at: new Date() }],
      }),
    };
    const backupExecute = vi.fn(async (request: UnifiedExecutionRequest) => ({
      schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION, executionId: request.executionId, taskId: request.taskId,
      harnessId: 'backup', modelId: 'm', runtimeId: 'r', status: 'completed' as const, workspaceRevision: 0,
      artifacts: [], toolCalls: [], verificationEvidenceIds: [], usage: { durationMs: 1 },
    }));
    const backup: HarnessRunner = { ...primary, descriptor: { ...primary.descriptor, harnessId: 'backup', name: 'backup' }, execute: backupExecute };
    const service = new HarnessDispatchService({ harnesses: [primary, backup] });
    const result = await service.dispatch({
      executionId: 'fallback-exec', taskId: 'fallback-task', objective: 'test', taskType: 'coding',
      harnessPreference: 'primary',
      workspace: { root: '/tmp', revision: 0 }, constraints: { allowFallback: true },
      verification: { requiredChecks: [], protectedPaths: [] }, policyContext: {},
    });
    expect(backupExecute).not.toHaveBeenCalled();
    expect(result.failureClassification).toBe('UNCONFIRMED_SIDE_EFFECT_BLOCKS_FALLBACK');
  });

  it('D-03 retains APPLIED proof after durable reload and D-04 deduplicates across revisions', async () => {
    let snapshot!: ExecutionRecord;
    const engine = new ExecutionEngine({ persist: (record) => { snapshot = structuredClone(record); } });
    const record = await engine.create({ task: task('reconcile-task'), runtimeId: 'runtime', modelId: 'model' });
    const id = record.execution.id;
    const input = { path: 'output.txt', content: 'done' };
    await engine.recordToolStart(id, 'write_file', input, { callId: 'write-1', sideEffectClass: 'IDEMPOTENT_WRITE' });
    const result = await reconcileBeforeCrossHarnessResume({
      executions: engine, executionId: id,
      inspectToolOutcome: async () => ({ outcome: 'APPLIED', evidence: 'output.txt contains done' }),
    });
    expect(result.workspaceRevision).toBeGreaterThan(0);
    expect(result.guard.checkDuplicateOperation({ executionId: id, callId: 'write-2', toolName: 'write_file', input, workspaceRevision: result.workspaceRevision }).duplicate).toBe(true);
    const reloaded = new ExecutionEngine({ load: () => [snapshot] });
    await reloaded.ready;
    const guard = OperationReconciliationGuard.fromExecutionRecord(reloaded.require(id), reloaded.toolCheckpoints(id));
    const duplicate = guard.checkDuplicateOperation({ executionId: id, callId: 'write-2', toolName: 'write_file', input, workspaceRevision: result.workspaceRevision });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.reason).toBe('DUPLICATE_SEMANTIC_OPERATION');
    expect(duplicate.receipt).toMatchObject({ outcome: 'APPLIED', evidence: 'output.txt contains done' });
  });
});
