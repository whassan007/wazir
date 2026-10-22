import { describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { MemoryStore } from '@wazir/shared';
import {
  InvalidStatusTransitionError,
  assertJobTransition,
  canTransitionJob,
} from '../src/services/statusTransitions.js';
import { JobManager } from '../src/services/jobManager.js';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import {
  findUnknownOutcomeToolCall,
  reconcileLocalOutcomes,
} from '../src/services/executionRecovery.js';

describe('Phase 3: Durable Recovery and Distributed Correctness (ISS-012, ISS-013)', () => {
  describe('ISS-012: Job terminal state transition enforcement', () => {
    it('rejects terminal-to-different-state transitions in canTransitionJob and assertJobTransition', () => {
      expect(canTransitionJob('completed', 'failed')).toBe(false);
      expect(canTransitionJob('completed', 'cancelled')).toBe(false);
      expect(canTransitionJob('completed', 'running')).toBe(false);
      expect(canTransitionJob('completed', 'pending')).toBe(false);
      expect(canTransitionJob('failed', 'completed')).toBe(false);
      expect(canTransitionJob('failed', 'cancelled')).toBe(false);
      expect(canTransitionJob('failed', 'running')).toBe(false);
      expect(canTransitionJob('cancelled', 'completed')).toBe(false);
      expect(canTransitionJob('cancelled', 'running')).toBe(false);

      expect(() => assertJobTransition('job-1', 'completed', 'failed')).toThrow(InvalidStatusTransitionError);
      expect(() => assertJobTransition('job-1', 'failed', 'completed')).toThrow(InvalidStatusTransitionError);
      expect(() => assertJobTransition('job-1', 'cancelled', 'completed')).toThrow(InvalidStatusTransitionError);
      expect(() => assertJobTransition('job-1', 'completed', 'running')).toThrow(InvalidStatusTransitionError);

      // Idempotent same-state transitions remain allowed
      expect(canTransitionJob('completed', 'completed')).toBe(true);
      expect(canTransitionJob('failed', 'failed')).toBe(true);
      expect(canTransitionJob('cancelled', 'cancelled')).toBe(true);
      // Timeout-induced cancel -> failed finalizer reconciliation remains allowed
      expect(canTransitionJob('cancelled', 'failed')).toBe(true);
    });

    it('prevents JobManager.setJobStatus from flipping a completed job to failed or failed to completed', async () => {
      const manager = new JobManager();
      const job = manager.create({
        title: 'Terminal job guard',
        tasks: [{ task: { id: 't1', input: 'work' } }],
      });
      await manager.setJobStatus(job.id, 'running');
      await manager.setJobStatus(job.id, 'completed');

      await expect(manager.setJobStatus(job.id, 'failed')).rejects.toBeInstanceOf(InvalidStatusTransitionError);
      await expect(manager.setJobStatus(job.id, 'cancelled')).rejects.toBeInstanceOf(InvalidStatusTransitionError);
      expect(manager.get(job.id)?.status).toBe('completed');
    });
  });

  describe('ISS-013: JobManager startup reconciliation with backing store', () => {
    it('reconciles stale running jobs on startup when backed by a KeyValueStore', async () => {
      const store = new MemoryStore();
      const writer = new JobManager({ store });
      await writer.ready;

      const orphanedJob = writer.create({
        title: 'Crashed Running Job',
        tasks: [{ task: { id: 'stuck-task', input: 'compile project' } }],
      });
      await writer.save(orphanedJob.id);
      await writer.setJobStatus(orphanedJob.id, 'running');
      await writer.updateTaskStatus(orphanedJob.id, 'stuck-task', 'running');
      await writer.updateAgentState(orphanedJob.id, 'stuck-task', 'running');

      const unfinalizedJob = writer.create({
        title: 'Tasks Finished But Job Left Running',
        tasks: [{ task: { id: 'done-task', input: 'lint project' } }],
      });
      await writer.save(unfinalizedJob.id);
      await writer.setJobStatus(unfinalizedJob.id, 'running');
      await writer.updateTaskStatus(unfinalizedJob.id, 'done-task', 'running');
      await writer.completeTask(unfinalizedJob.id, 'done-task', 'ok');

      // Simulate process restart with a fresh JobManager reading from the same store
      const recovered = new JobManager({ store });
      await recovered.ready;

      const healedOrphan = recovered.get(orphanedJob.id);
      expect(healedOrphan?.status).toBe('failed');
      expect(healedOrphan?.completedAt).toBeDefined();
      expect(healedOrphan?.tasks[0].status).toBe('failed');
      expect(healedOrphan?.graph.nodes[0].state).toBe('failed');
      expect(healedOrphan?.graph.nodes[0].error).toContain('Orphaned');

      // Persisted store entry should also reflect the reconciled status
      const storedOrphan = await store.get<typeof orphanedJob>(`job/${orphanedJob.id}`);
      expect(storedOrphan?.status).toBe('failed');

      const healedCompleted = recovered.get(unfinalizedJob.id);
      expect(healedCompleted?.status).toBe('completed');
      expect(healedCompleted?.completedAt).toBeDefined();
    });
  });

  describe('ISS-013: JobManager.acquire() unknown-outcome mutating tool protection', () => {
    it('refuses to blindly replay an expired running task when its execution has an unknown-outcome mutating tool call', async () => {
      const store = new MemoryStore();
      let nowMs = 1_000_000;
      const executions = new ExecutionEngine({
        persist: async (record) => {
          await store.put(`execution/${record.execution.id}`, structuredClone(record));
        },
      });
      await executions.ready;

      const manager1 = new JobManager({ store, executions, leaseMs: 1_000, now: () => nowMs });
      await manager1.ready;

      const job = manager1.create({
        title: 'Mutating Lease Job',
        maxRetries: 3,
        tasks: [{ task: { id: 'mutating-task', input: 'write config' } }],
      });
      await manager1.save(job.id);
      await manager1.acquire(job.id);
      await manager1.setJobStatus(job.id, 'running');
      await manager1.updateTaskStatus(job.id, 'mutating-task', 'running');
      await manager1.updateAgentState(job.id, 'mutating-task', 'running');

      const execRecord = await executions.create({
        task: job.tasks[0],
        jobId: job.id,
        computerId: 'local',
        runtimeId: 'fake-runtime',
        modelId: 'fake-model',
      });
      await executions.setStatus(execRecord.execution.id, 'running');
      await executions.recordToolStart(
        execRecord.execution.id,
        'write',
        { path: 'config.json', content: '{}' },
        { callId: 'call-mut-1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' },
      );

      expect(findUnknownOutcomeToolCall(execRecord, { mutatingOnly: true })).toMatchObject({
        tool: 'write',
        callId: 'call-mut-1',
        sideEffectClass: 'NON_IDEMPOTENT_WRITE',
      });

      // Advance clock past lease expiration and reclaim with a new JobManager
      nowMs += 5_000;
      const manager2 = new JobManager({ store, executions, leaseMs: 1_000, now: () => nowMs });
      await manager2.ready;
      await manager2.acquire(job.id);

      const reclaimed = manager2.get(job.id)!;
      const node = reclaimed.graph.nodes.find((n) => n.taskId === 'mutating-task')!;
      const task = reclaimed.tasks.find((t) => t.id === 'mutating-task')!;

      expect(node.state).toBe('failed');
      expect(node.error).toContain('UNKNOWN_MUTATION_OUTCOME');
      expect(task.status).toBe('failed');
      expect(reclaimed.status).toBe('failed');

      const updatedExec = await executions.get(execRecord.execution.id);
      expect(updatedExec?.execution.status).toBe('failed');
      expect(updatedExec?.errors.some((e) => e.includes('UNKNOWN_MUTATION_OUTCOME'))).toBe(true);
    });

    it('allows normal retry on lease expiration when only a read-only tool call was in flight', async () => {
      const store = new MemoryStore();
      let nowMs = 2_000_000;
      const executions = new ExecutionEngine({
        persist: async (record) => {
          await store.put(`execution/${record.execution.id}`, structuredClone(record));
        },
      });
      await executions.ready;

      const manager1 = new JobManager({ store, executions, leaseMs: 1_000, now: () => nowMs });
      await manager1.ready;

      const job = manager1.create({
        title: 'Read-only Lease Job',
        maxRetries: 2,
        tasks: [{ task: { id: 'readonly-task', input: 'inspect files' } }],
      });
      await manager1.save(job.id);
      await manager1.acquire(job.id);
      await manager1.setJobStatus(job.id, 'running');
      await manager1.updateTaskStatus(job.id, 'readonly-task', 'running');
      await manager1.updateAgentState(job.id, 'readonly-task', 'running');

      const execRecord = await executions.create({
        task: job.tasks[0],
        jobId: job.id,
        computerId: 'local',
        runtimeId: 'fake-runtime',
        modelId: 'fake-model',
      });
      await executions.setStatus(execRecord.execution.id, 'running');
      await executions.recordToolStart(
        execRecord.execution.id,
        'read_file',
        { path: 'README.md' },
        { callId: 'call-ro-1', sideEffectClass: 'READ_ONLY' },
      );

      nowMs += 5_000;
      const manager2 = new JobManager({ store, executions, leaseMs: 1_000, now: () => nowMs });
      await manager2.ready;
      await manager2.acquire(job.id);

      const reclaimed = manager2.get(job.id)!;
      const node = reclaimed.graph.nodes.find((n) => n.taskId === 'readonly-task')!;
      const task = reclaimed.tasks.find((t) => t.id === 'readonly-task')!;

      expect(node.state).toBe('idle');
      expect(node.retryCount).toBe(1);
      expect(task.status).toBe('pending');
      expect(reclaimed.status).toBe('running');
    });
  });

  describe('ISS-013: reconcileLocalOutcomes standalone execution recovery without open tool calls', () => {
    it('reconciles standalone running, scheduled, and waiting executions whose owner PID is dead even when no tool call was in-flight', async () => {
      const deadPid = 999_999;
      const engine = new ExecutionEngine({
        isProcessAlive: (pid) => pid !== deadPid,
      });
      await engine.ready;

      const makeStandalone = async (idSuffix: string, status: 'running' | 'scheduled' | 'waiting') => {
        const rec = await engine.create({
          task: {
            id: `task-${idSuffix}`,
            type: 'coding',
            input: 'standalone work',
            requirements: {},
            priority: 'normal',
            status: 'pending',
            createdAt: new Date(),
          },
          computerId: 'local',
          runtimeId: 'ollama',
          modelId: 'qwen',
        });
        await engine.setStatus(rec.execution.id, status);
        // Stamp with a dead owner PID and no open tool call checkpoints
        engine.require(rec.execution.id).execution.owner = { pid: deadPid, host: hostname() };
        return rec.execution.id;
      };

      const runningId = await makeStandalone('run', 'running');
      const scheduledId = await makeStandalone('sched', 'scheduled');
      const waitingId = await makeStandalone('wait', 'waiting');

      const outcomes = await reconcileLocalOutcomes(engine, undefined, {
        isProcessAlive: (pid) => pid !== deadPid,
      });

      expect(outcomes).toEqual(
        expect.arrayContaining([
          { executionId: runningId, callId: 'execution', outcome: 'ORPHANED' },
          { executionId: scheduledId, callId: 'execution', outcome: 'ORPHANED' },
          { executionId: waitingId, callId: 'execution', outcome: 'ORPHANED' },
        ]),
      );

      for (const id of [runningId, scheduledId, waitingId]) {
        const updated = await engine.get(id);
        expect(updated?.execution.status).toBe('failed');
        expect(updated?.execution.completedAt).toBeDefined();
        expect(updated?.errors.some((e) => e.includes('OWNER_PROCESS_EXITED'))).toBe(true);
      }
    });
  });
});
