/**
 * A086 — Mid-Batch Cancellation, Worker Lease Fencing & Crash-Recovery Non-Replay Suite
 *
 * Verifies:
 *  1. Mid-parallel-batch `AbortController` cancellation during `CoreToolScheduler.scheduleBatch`
 *     halts before dispatching queued mutating `edit`/`write`/`shell` calls while preserving
 *     strict 1:1 `assistantToolCalls` <-> `role: 'tool'` (`toolCallId`) pairing.
 *  2. Mid-flight `AbortController` cancellation during a non-idempotent mutating tool call
 *     via `executeTool` (`ToolRegistry`) + `ExecutionEngine` classifies the interrupted mutation
 *     as `TOOL_OUTCOME_UNKNOWN` / `OUTCOME_UNKNOWN`.
 *  3. Crash recovery (`reconstructExecutionState`, `planRecovery`, `reconcileBeforeCrossHarnessResume`,
 *     `OperationReconciliationGuard`, `RecoveryManager`) NEVER silently auto-replays an interrupted
 *     mutating tool call (`action === 'reconcile'`, `canResume === false` until physical inspection),
 *     blocks duplicate replay once reconciled as `APPLIED`, and rejects stale worker lease epochs.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@wazir/core', () => import('../../packages/core/src/index.js'));

import { MemoryStore } from '@wazir/shared';
import {
  ComputerRegistry,
  ExecutionEngine,
  JobManager,
  OperationReconciliationGuard,
  RecoveryManager,
  classifyToolOutcome,
  findUnknownOutcomeToolCall,
  planRecovery,
  reconcileBeforeCrossHarnessResume,
  reconstructExecutionState,
  type AgentRuntime,
  type GroundedResult,
  type Task,
  type Tool,
} from '../../packages/core/src/index.js';
import { CoreToolScheduler } from '../../packages/agents/src/qwenCore/coreToolScheduler.js';
import { ToolRegistry, executeTool } from '../../packages/tools/src/registry.js';

describe('A086 — Mid-Batch Cancellation, Crash Recovery & Lease Fencing Suite', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'wazir-batch-crash-'));
    writeFileSync(join(workspaceDir, 'a.ts'), 'export const a = 1;\n', 'utf8');
    writeFileSync(join(workspaceDir, 'b.ts'), 'export const b = 2;\n', 'utf8');
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('1. Halts queued mutating calls when AbortController cancels mid-parallel-read batch while preserving 1:1 toolCallId transcript pairing', async () => {
    const abortController = new AbortController();
    const scheduler = new CoreToolScheduler();
    const dispatched: string[] = [];

    const runtime: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read', inputSchema: { type: 'object' } },
        { name: 'edit', description: 'edit', inputSchema: { type: 'object' } },
        { name: 'shell', description: 'shell', inputSchema: { type: 'object' } },
      ],
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate() {
        yield { type: 'completed' };
      },
      async executeTool(name, input) {
        dispatched.push(`${name}:${String(input.path ?? input.command ?? '')}`);
        if (name === 'read' && input.path === 'b.ts') {
          // Trigger cancellation mid-flight during parallel read batch
          abortController.abort();
        }
        await new Promise((r) => setTimeout(r, 10));
        return { ok: true, output: `content of ${String(input.path)}`, durationMs: 10 };
      },
    };

    const batch = await scheduler.scheduleBatch({
      calls: [
        { id: 'call_r1', name: 'read', input: { path: 'a.ts' } },
        { id: 'call_r2', name: 'read', input: { path: 'b.ts' } },
        {
          id: 'call_mut_edit',
          name: 'edit',
          input: { path: 'a.ts', oldString: 'const a = 1;', newString: 'const a = 99;' },
        },
        {
          id: 'call_mut_shell',
          name: 'shell',
          input: { command: 'node scripts/migrate.js' },
        },
      ],
      runtime,
      availableToolNames: new Set(['read', 'edit', 'shell']),
      remainingToolBudget: 20,
      webEvidence: new Map<string, GroundedResult>(),
      isCancelled: () => abortController.signal.aborted,
    });

    // Parallel read batch ran, but subsequent exclusive mutating calls were NEVER dispatched!
    expect(dispatched).toEqual(['read:a.ts', 'read:b.ts']);
    expect(batch.executedCount).toBe(2);
    expect(batch.filesMutated).toEqual([]);

    // Strict 1:1 OpenAI/Anthropic/Qwen toolCallId invariant holds even across cancelled tail calls
    expect(batch.assistantToolCalls.map((tc) => tc.id)).toEqual([
      'call_r1',
      'call_r2',
      'call_mut_edit',
      'call_mut_shell',
    ]);
    expect(batch.toolMessages.map((tm) => tm.toolCallId)).toEqual([
      'call_r1',
      'call_r2',
      'call_mut_edit',
      'call_mut_shell',
    ]);

    const editOutcome = batch.outcomes.find((o) => o.callId === 'call_mut_edit')!;
    const shellOutcome = batch.outcomes.find((o) => o.callId === 'call_mut_shell')!;
    expect(editOutcome.executed).toBe(false);
    expect(editOutcome.result.failureClass).toBe('CANCELLED');
    expect(shellOutcome.executed).toBe(false);
    expect(shellOutcome.result.failureClass).toBe('CANCELLED');
  });

  it('2. Classifies mid-flight aborted mutating tool calls as TOOL_OUTCOME_UNKNOWN and blocks blind auto-replay in planRecovery & reconcileBeforeCrossHarnessResume', async () => {
    const abortController = new AbortController();
    let mutatingInvocations = 0;

    // Non-idempotent mutating tool that gets interrupted mid-flight by worker crash / AbortController
    const ledgerAppendTool: Tool = {
      descriptor: {
        name: 'append_migration',
        description: 'Appends a non-idempotent migration entry',
        inputSchema: {
          type: 'object',
          properties: { entry: { type: 'string' } },
          required: ['entry'],
        },
        permissions: ['filesystem_write'],
        riskLevel: 'high',
        environment: 'local',
        sideEffectClass: 'NON_IDEMPOTENT_WRITE',
        concurrencySafety: 'exclusive',
      },
      async execute(_input, ctx) {
        mutatingInvocations += 1;
        return await new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve({ ok: true, output: 'appended', durationMs: 50 });
          }, 5_000);
          ctx.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
            },
            { once: true },
          );
        });
      },
    };

    const toolRegistry = new ToolRegistry([ledgerAppendTool]);
    const executions = new ExecutionEngine({ workspace: workspaceDir });

    const task: Task = {
      id: 'task-crash-mut-1',
      type: 'coding',
      input: 'Apply migration entry',
      requirements: { capabilities: ['coding'] },
      priority: 'normal',
      status: 'running',
      createdAt: new Date(),
    };

    const record = await executions.create({
      task,
      agentId: 'wazir-coding',
      modelId: 'qwen3-coder',
      runtimeId: 'local',
      computerId: 'worker-1',
      workspaceRoot: workspaceDir,
    });
    const executionId = record.execution.id;
    await executions.setStatus(executionId, 'running');

    // Record durable pre-dispatch intent checkpoint in ExecutionEngine (`STARTED`)
    const callId = 'call_mut_inflight_1';
    await executions.recordToolStart(
      executionId,
      'append_migration',
      { entry: 'v2_add_column' },
      {
        callId,
        sideEffectClass: 'NON_IDEMPOTENT_WRITE',
      },
    );

    // Abort 15ms after dispatch while tool is mid-flight
    setTimeout(() => abortController.abort(), 15);
    const interruptedResult = await executeTool(
      toolRegistry,
      'append_migration',
      { entry: 'v2_add_column' },
      {
        projectRoot: workspaceDir,
        executionId,
        signal: abortController.signal,
      },
    );

    expect(mutatingInvocations).toBe(1);
    expect(interruptedResult.ok).toBe(false);
    expect(interruptedResult.failureClass).toBe('TOOL_OUTCOME_UNKNOWN');
    expect(classifyToolOutcome(interruptedResult)).toBe('OUTCOME_UNKNOWN');

    // Inspect durable execution state BEFORE reconciliation (simulating abrupt crash right after dispatch)
    const checkpoints = executions.toolCheckpoints(executionId);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].state).toBe('STARTED');
    expect(classifyToolOutcome(checkpoints[0])).toBe('OUTCOME_UNKNOWN');

    const unknownHit = findUnknownOutcomeToolCall(executions.require(executionId), { mutatingOnly: true });
    expect(unknownHit?.callId).toBe(callId);
    expect(unknownHit?.tool).toBe('append_migration');

    // Completing an execution with an unreconciled mutating call MUST fail closed
    await expect(executions.setStatus(executionId, 'completed')).rejects.toThrow(/reconciliation/i);

    // planRecovery MUST return 'reconcile' — NEVER 'resume' (no silent auto-replay!)
    const reconstructed = reconstructExecutionState(executions.require(executionId), checkpoints);
    const recoveryPlan = planRecovery(reconstructed);
    expect(recoveryPlan.action).toBe('reconcile');
    expect(recoveryPlan.reasons.join(' ')).toContain('must not be replayed blindly');

    // Cross-harness resume without physical proof (`UNDETERMINED`) MUST fail closed (`safeToResume: false`)
    const blockedResume = await reconcileBeforeCrossHarnessResume({
      executions,
      executionId,
      inspectToolOutcome: async () => ({
        outcome: 'UNDETERMINED',
        evidence: 'External ledger state ambiguous without operator check',
      }),
    });
    expect(blockedResume.safeToResume).toBe(false);
    expect(blockedResume.status).toBe('BLOCKED_UNDETERMINED_OUTCOME');
    expect(blockedResume.blockedCallIds).toEqual([callId]);
    expect(blockedResume.retryableCallIds).toEqual([]);

    // Once physical inspection proves the mutation ALREADY landed (`APPLIED`),
    // reconcileBeforeCrossHarnessResume records an idempotency receipt (`retryable: false`)
    // and OperationReconciliationGuard blocks any duplicate re-dispatch!
    const guard = new OperationReconciliationGuard();
    const appliedResume = await reconcileBeforeCrossHarnessResume({
      executions,
      executionId,
      guard,
      inspectToolOutcome: async () => ({
        outcome: 'APPLIED',
        evidence: 'Verified v2_add_column row exists on disk',
      }),
    });
    expect(appliedResume.safeToResume).toBe(true);
    expect(appliedResume.status).toBe('READY_TO_RESUME');
    expect(appliedResume.appliedCallIds).toEqual([callId]);
    expect(appliedResume.retryableCallIds).toEqual([]);

    const dupByCallId = guard.checkDuplicateOperation({
      executionId,
      callId,
      toolName: 'append_migration',
      input: { entry: 'v2_add_column' },
      workspaceRevision: 0,
    });
    expect(dupByCallId.duplicate).toBe(true);
    expect(dupByCallId.reason).toBe('DUPLICATE_CALL_ID');

    const dupBySemantic = guard.checkDuplicateOperation({
      executionId,
      callId: 'retry_new_call_id_99',
      toolName: 'append_migration',
      input: { entry: 'v2_add_column' },
      workspaceRevision: 0,
    });
    expect(dupBySemantic.duplicate).toBe(true);
    expect(dupBySemantic.reason).toBe('DUPLICATE_SEMANTIC_OPERATION');
    expect(mutatingInvocations).toBe(1);
  });

  it('3. Fences stale worker lease epochs on crash reassignment via RecoveryManager', async () => {
    const store = new MemoryStore();
    const executions = new ExecutionEngine({ workspace: workspaceDir });
    const computers = new ComputerRegistry();
    const jobManager = new JobManager({ store, executions });
    const recovery = new RecoveryManager({ computers, executions, jobManager });

    const task: Task = {
      id: 'task-lease-fence-1',
      type: 'coding',
      input: 'Update module',
      requirements: { capabilities: ['coding'] },
      priority: 'normal',
      status: 'running',
      createdAt: new Date(),
    };
    const rec = await executions.create({
      task,
      agentId: 'wazir-coding',
      modelId: 'qwen3-coder',
      runtimeId: 'local',
      computerId: 'worker-alpha',
      workspaceRoot: workspaceDir,
    });
    const execId = rec.execution.id;
    await executions.setStatus(execId, 'running');

    const lease1 = await recovery.reassignExecutionLease(execId, 'worker-alpha', { ttlMs: 30_000 });
    expect(lease1.epoch).toBe(1);

    // Worker alpha crashes / stalls; coordinator reassigns execution lease to worker-beta (epoch 2)
    const lease2 = await recovery.reassignExecutionLease(execId, 'worker-beta', { ttlMs: 30_000 });
    expect(lease2.epoch).toBe(2);

    // Late zombie report from worker-alpha with stale epoch 1 MUST be rejected!
    const zombieReport = recovery.verifyWorkerReport(execId, {
      workerId: 'worker-alpha',
      epoch: lease1.epoch,
      leaseId: lease1.leaseId,
    });
    expect(zombieReport.allowed).toBe(false);
    expect(zombieReport.code).toBe('STALE_WORKER_FENCED');

    // Current holder worker-beta at epoch 2 is accepted
    const validReport = recovery.verifyWorkerReport(execId, {
      workerId: 'worker-beta',
      epoch: lease2.epoch,
      leaseId: lease2.leaseId,
    });
    expect(validReport.allowed).toBe(true);
  });
});
