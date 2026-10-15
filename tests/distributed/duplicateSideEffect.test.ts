import { describe, it, expect, afterEach } from 'vitest';
import { ClusterHarness } from './harness/clusterHarness.js';
import { ExecutionEngine } from '@wazir/core';
import { ComputerRegistry } from '@wazir/core';
import { RecoveryManager } from '@wazir/core';
import { JobManager } from '@wazir/core';
import { MemoryStore } from '@wazir/shared';
import type { ToolCallCheckpoint, ExecutionRecord } from '@wazir/core';

/**
 * B5 — Duplicate Side-Effect Protection & Unknown Outcome Reconciliation
 *
 * Demonstrates that lease fencing of task results does NOT inherently prevent
 * external side effects from executing twice. When a failure occurs after an external
 * mutation has executed but before its result is acknowledged, Wazir must:
 * 1. Correctly recognize an UNKNOWN_OUTCOME.
 * 2. Block automatic blind retry of non-idempotent operations.
 * 3. Safely reconcile using durable operation identifiers and physical evidence.
 * 4. Commit exactly one authoritative outcome without duplicate external mutations.
 */
describe.skipIf(process.env.WAZIR_DISTRIBUTED !== '1')('B5 — Duplicate Side-Effect Protection & Reconciliation', () => {
  let harness: ClusterHarness;

  // External mutating resource with durable operation tracing
  class ExternalResource {
    counter = 0;
    readonly appliedOps = new Set<string>();

    executeMutatingOp(operationId: string): { counter: number; alreadyApplied: boolean } {
      if (this.appliedOps.has(operationId)) {
        return { counter: this.counter, alreadyApplied: true };
      }
      this.appliedOps.add(operationId);
      this.counter += 1;
      return { counter: this.counter, alreadyApplied: false };
    }

    inspect(operationId: string): 'APPLIED' | 'NOT_APPLIED' {
      return this.appliedOps.has(operationId) ? 'APPLIED' : 'NOT_APPLIED';
    }
  }

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it('blocks automatic blind replay when failure occurs after side effect executes (UNKNOWN_OUTCOME)', async () => {
    const resource = new ExternalResource();
    const operationId = `op-mutation-${Date.now()}`;

    const store = new MemoryStore();
    const computers = new ComputerRegistry();
    const executions = new ExecutionEngine({ persist: record => store.put(`execution/${record.execution.id}`, record) });
    const jobManager = new JobManager({ store });

    // Register a remote worker computer
    computers.register({
      id: 'worker-side-effect',
      name: 'Side Effect Worker',
      type: 'workstation',
      local: false,
      os: { platform: 'linux', architecture: 'x64', version: 'test' },
      hardware: { cpu: 'test', cpuCores: 1, memoryGB: 1 },
    });

    // Start an execution on this computer
    const record = await executions.create({
      task: { id: 'task-side-effect-1', title: 'Side effect task', prompt: 'test' } as any,
      computerId: 'worker-side-effect',
      runtimeId: 'ollama',
      modelId: 'test-model',
    });
    await executions.setStatus(record.execution.id, 'running');

    const executionId = record.execution.id;

    // Checkpoint 1: Tool starts executing mutating operation
    await executions.recordToolStart(executionId, 'external_counter_increment', { operationId }, {
      callId: operationId,
      sideEffectClass: 'NON_IDEMPOTENT_WRITE',
    });

    // Side effect executes on external system (e.g. database write, external API)
    const result = resource.executeMutatingOp(operationId);
    expect(result.counter).toBe(1);
    expect(result.alreadyApplied).toBe(false);

    // CRASH INJECTION: Worker process dies before reporting tool completion!
    // Computer stops heartbeating and goes offline.
    const comp = computers.get('worker-side-effect')!;
    (comp as any).lastHeartbeat = new Date(Date.now() - 5000);

    const recoveryManager = new RecoveryManager({
      computers,
      executions,
      jobManager,
      staleMs: 100,
      offlineMs: 200,
    });

    // Recovery sweep runs
    const sweep = await recoveryManager.sweep();

    // Verification:
    // 1. RecoveryManager recognized the computer went offline
    expect(sweep.offlineComputers).toContain('worker-side-effect');

    // 2. RecoveryManager detected unknown outcome mid-tool-call
    expect(sweep.unknownOutcomes).toHaveLength(1);
    expect(sweep.unknownOutcomes[0].tool).toBe('external_counter_increment');
    expect(sweep.unknownOutcomes[0].executionId).toBe(executionId);

    // 3. Execution was marked orphaned with explicit UNKNOWN_OUTCOME reason
    const active = await executions.get(executionId);
    expect(active?.execution.status).toBe('failed');
    expect(active?.errors?.some((e) => e.includes('UNKNOWN_OUTCOME'))).toBe(true);

    // 4. UNSAFE BLIND REPLAY WAS PREVENTED: retriedLive is empty!
    expect(sweep.retriedLive).not.toContain('task-side-effect-1');
    expect(sweep.retriedLive).toHaveLength(0);

    // 5. External mutation was executed EXACTLY ONCE (not re-executed)
    expect(resource.counter).toBe(1);
  });

  it('safely reconciles unknown outcome using durable operation identifier and physical evidence', async () => {
    const resource = new ExternalResource();
    const operationId = `op-reconcile-${Date.now()}`;

    const store = new MemoryStore();
    const computers = new ComputerRegistry();
    const executions = new ExecutionEngine({ persist: record => store.put(`execution/${record.execution.id}`, record) });
    const jobManager = new JobManager({ store });

    computers.register({
      id: 'worker-reconcile',
      name: 'Reconcile Worker',
      type: 'workstation',
      local: false,
      os: { platform: 'linux', architecture: 'x64', version: 'test' },
      hardware: { cpu: 'test', cpuCores: 1, memoryGB: 1 },
    });

    const record = await executions.create({
      task: { id: 'task-reconcile-1', title: 'Reconcile task', prompt: 'test' } as any,
      computerId: 'worker-reconcile',
      runtimeId: 'ollama',
      modelId: 'test-model',
    });
    await executions.setStatus(record.execution.id, 'running');

    const executionId = record.execution.id;

    // Tool starts mutating operation
    await executions.recordToolStart(executionId, 'external_counter_increment', { operationId }, {
      callId: operationId,
      sideEffectClass: 'NON_IDEMPOTENT_WRITE',
    });

    // Mutation executes on external resource
    resource.executeMutatingOp(operationId);
    expect(resource.counter).toBe(1);

    // Crash before completion: Worker stops heartbeating.
    const comp = computers.get('worker-reconcile')!;
    (comp as any).lastHeartbeat = new Date(Date.now() - 5000);

    // Configure RecoveryManager WITH physical state inspector
    const recoveryManager = new RecoveryManager({
      computers,
      executions,
      jobManager,
      staleMs: 100,
      offlineMs: 200,
      inspectToolOutcome: async (_rec, call) => {
        const physicalOutcome = resource.inspect(call.callId);
        return {
          outcome: physicalOutcome,
          evidence: `External resource recorded operationId ${call.callId}`,
          canReplaySafely: false,
        };
      },
    });

    const sweep = await recoveryManager.sweep();

    // Reconciled from physical evidence!
    expect(sweep.reconciled).toHaveLength(1);
    expect(sweep.reconciled[0].callId).toBe(operationId);
    expect(sweep.reconciled[0].outcome).toBe('APPLIED');
    expect(sweep.reconciled[0].evidence).toContain('External resource recorded operationId');

    // Tool call checkpoint state is now COMPLETED (reconciled as applied)
    const checkpoints = executions.toolCheckpoints(executionId);
    const reconciledCall = checkpoints.find((c) => c.callId === operationId);
    expect(reconciledCall?.state).toBe('COMPLETED');

    // External counter was NEVER duplicated
    expect(resource.counter).toBe(1);
  });

});
