import { describe, it, expect } from 'vitest';
import { JobManager } from '../src/services/jobManager.js';
import {
  InvalidStatusTransitionError,
  canTransitionJob,
  canTransitionTask,
} from '../src/services/statusTransitions.js';

describe('status transition policy', () => {
  it('never resurrects completed or cancelled tasks', () => {
    for (const from of ['completed', 'cancelled'] as const) {
      for (const to of ['pending', 'scheduled', 'running', 'blocked', 'planning'] as const) {
        expect(canTransitionTask(from, to)).toBe(false);
      }
    }
  });

  it('allows retrying a failed task but not jumping it straight to running', () => {
    expect(canTransitionTask('failed', 'pending')).toBe(true);
    expect(canTransitionTask('failed', 'scheduled')).toBe(true);
    expect(canTransitionTask('failed', 'running')).toBe(false);
  });

  it('allows same-state writes and non-terminal progress', () => {
    expect(canTransitionTask('completed', 'completed')).toBe(true);
    expect(canTransitionTask('pending', 'completed')).toBe(true);
    expect(canTransitionTask('running', 'pending')).toBe(true);
  });

  it('keeps terminal jobs terminal while allowing terminal reconciliation', () => {
    expect(canTransitionJob('completed', 'running')).toBe(false);
    expect(canTransitionJob('cancelled', 'pending')).toBe(false);
    expect(canTransitionJob('cancelled', 'failed')).toBe(true);
    expect(canTransitionJob('paused', 'running')).toBe(true);
  });
});

describe('JobManager enforces the policy', () => {
  it('rejects a stale write that would revive a cancelled task', async () => {
    const manager = new JobManager();
    const job = manager.create({ title: 't', tasks: [{ task: { id: 'a', input: 'a' } }] });
    await manager.updateTaskStatus(job.id, 'a', 'running');
    await manager.updateTaskStatus(job.id, 'a', 'cancelled');
    await expect(manager.updateTaskStatus(job.id, 'a', 'running')).rejects.toBeInstanceOf(InvalidStatusTransitionError);
    expect(manager.get(job.id)?.tasks[0].status).toBe('cancelled');
  });

  it('rejects reopening a completed job', async () => {
    const manager = new JobManager();
    const job = manager.create({ title: 't', tasks: [{ task: { id: 'a', input: 'a' } }] });
    await manager.setJobStatus(job.id, 'completed');
    await expect(manager.setJobStatus(job.id, 'running')).rejects.toThrow(/Invalid job status transition/);
  });
});
