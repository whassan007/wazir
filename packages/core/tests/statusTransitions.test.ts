import { describe, it, expect } from 'vitest';
import { JobManager } from '../src/services/jobManager.js';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import {
  InvalidStatusTransitionError,
  canTransitionExecution,
  canTransitionJob,
  canTransitionNode,
  canTransitionTask,
} from '../src/services/statusTransitions.js';

describe('status transition policy', () => {
  it('never resurrects completed or cancelled tasks', () => {
    for (const from of ['completed', 'cancelled'] as const) {
      for (const to of [
        'pending',
        'queued',
        'scheduled',
        'ready',
        'running',
        'waiting_for_approval',
        'verifying',
        'paused',
        'blocked',
        'planning',
      ] as const) {
        expect(canTransitionTask(from, to)).toBe(false);
      }
    }
  });

  it('allows retrying a failed task via pending/queued/scheduled/ready but not jumping straight to running', () => {
    expect(canTransitionTask('failed', 'pending')).toBe(true);
    expect(canTransitionTask('failed', 'queued')).toBe(true);
    expect(canTransitionTask('failed', 'scheduled')).toBe(true);
    expect(canTransitionTask('failed', 'ready')).toBe(true);
    expect(canTransitionTask('failed', 'running')).toBe(false);
    expect(canTransitionTask('failed', 'completed')).toBe(false);
  });

  it('allows same-state writes and non-terminal progress including approval/verification/pause states', () => {
    expect(canTransitionTask('completed', 'completed')).toBe(true);
    expect(canTransitionTask('pending', 'queued')).toBe(true);
    expect(canTransitionTask('queued', 'ready')).toBe(true);
    expect(canTransitionTask('ready', 'running')).toBe(true);
    expect(canTransitionTask('running', 'waiting_for_approval')).toBe(true);
    expect(canTransitionTask('waiting_for_approval', 'verifying')).toBe(true);
    expect(canTransitionTask('verifying', 'completed')).toBe(true);
    expect(canTransitionTask('running', 'paused')).toBe(true);
    expect(canTransitionTask('paused', 'running')).toBe(true);
  });

  it('keeps terminal jobs terminal while allowing terminal reconciliation', () => {
    expect(canTransitionJob('completed', 'running')).toBe(false);
    expect(canTransitionJob('cancelled', 'pending')).toBe(false);
    expect(canTransitionJob('cancelled', 'failed')).toBe(true);
    expect(canTransitionJob('paused', 'running')).toBe(true);
  });

  it('enforces node and execution terminal boundaries while allowing explicit retry targets', () => {
    expect(canTransitionNode('completed', 'running')).toBe(false);
    expect(canTransitionNode('cancelled', 'idle')).toBe(false);
    expect(canTransitionNode('failed', 'idle')).toBe(true);
    expect(canTransitionNode('failed', 'running')).toBe(false);

    expect(canTransitionExecution('completed', 'running')).toBe(false);
    expect(canTransitionExecution('cancelled', 'running')).toBe(false);
    expect(canTransitionExecution('failed', 'queued')).toBe(true);
    expect(canTransitionExecution('failed', 'running')).toBe(false);
  });
});

describe('JobManager and ExecutionEngine enforce the policy', () => {
  it('rejects a stale write that would revive a cancelled task via updateTaskStatus, completeTask, or failTask', async () => {
    const manager = new JobManager();
    const job = manager.create({ title: 't', tasks: [{ task: { id: 'a', input: 'a' } }] });
    await manager.updateTaskStatus(job.id, 'a', 'running');
    await manager.updateTaskStatus(job.id, 'a', 'cancelled');
    await expect(manager.updateTaskStatus(job.id, 'a', 'running')).rejects.toBeInstanceOf(InvalidStatusTransitionError);
    await expect(manager.completeTask(job.id, 'a', 'late output')).rejects.toBeInstanceOf(InvalidStatusTransitionError);
    await expect(manager.failTask(job.id, 'a', 'late error', 99)).rejects.toBeInstanceOf(InvalidStatusTransitionError);
    expect(manager.get(job.id)?.tasks[0].status).toBe('cancelled');
  });

  it('rejects overwriting a completed task or node with failed or running', async () => {
    const manager = new JobManager();
    const job = manager.create({ title: 't', tasks: [{ task: { id: 'a', input: 'a' } }] });
    await manager.updateTaskStatus(job.id, 'a', 'running');
    await manager.completeTask(job.id, 'a', 'done');
    await expect(manager.failTask(job.id, 'a', 'late crash', 99)).rejects.toBeInstanceOf(InvalidStatusTransitionError);
    await expect(manager.updateAgentState(job.id, 'a', 'running')).rejects.toBeInstanceOf(InvalidStatusTransitionError);
    expect(manager.get(job.id)?.tasks[0].status).toBe('completed');
  });

  it('rejects reopening a completed job', async () => {
    const manager = new JobManager();
    const job = manager.create({ title: 't', tasks: [{ task: { id: 'a', input: 'a' } }] });
    await manager.setJobStatus(job.id, 'completed');
    await expect(manager.setJobStatus(job.id, 'running')).rejects.toThrow(/Invalid job status transition/);
  });

  it('rejects reviving a completed or cancelled execution in ExecutionEngine.setStatus', async () => {
    const engine = new ExecutionEngine();
    await engine.ready;
    const rec = await engine.create({
      task: {
        id: 't-exec-guard',
        type: 'chat',
        input: 'hello',
        requirements: { capabilities: [] },
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      agentId: 'coding-agent',
      computerId: 'local',
      runtimeId: 'ollama',
      modelId: 'm1',
    });
    await engine.setStatus(rec.execution.id, 'running');
    await engine.setStatus(rec.execution.id, 'cancelled');
    await expect(engine.setStatus(rec.execution.id, 'running')).rejects.toBeInstanceOf(InvalidStatusTransitionError);
    await expect(engine.setStatus(rec.execution.id, 'completed')).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });
});

