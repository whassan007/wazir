import { describe, it, expect } from 'vitest';
import { MemoryStore, JsonFileStore } from '@wazir/shared';
import { JobManager } from '../src/services/jobManager.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('durable graph ownership', () => {
  it('fences old owners and resumes interrupted nodes without rerunning completed predecessors', async () => {
    const store = new MemoryStore();
    let now = 0;
    const a = new JobManager({ store, now: () => now, leaseMs: 1000 });
    await a.ready;
    const job = a.create({ title: 'graph', tasks: [
      { task: { id: 'a', input: 'first' } }, { task: { id: 'b', input: 'second' }, dependencies: ['a'] },
    ] });
    await a.save(job.id);
    await a.acquire(job.id);
    await a.completeTask(job.id, 'a', { artifact: 'persisted' });
    await a.updateAgentState(job.id, 'b', 'running');
    await a.updateTaskStatus(job.id, 'b', 'running');
    const b = new JobManager({ store, now: () => now, leaseMs: 1000 });
    await b.ready;
    await expect(b.acquire(job.id)).rejects.toThrow('JOB_LEASE_BUSY');
    now = 1001;
    await b.acquire(job.id);
    expect(b.get(job.id)?.graph.nodes[0].state).toBe('completed');
    expect(b.get(job.id)?.graph.nodes[0].result).toEqual({ artifact: 'persisted' });
    expect(b.get(job.id)?.graph.nodes[1].state).toBe('idle');
    expect(b.get(job.id)?.graph.nodes[1].retryCount).toBe(1);
    await expect(a.completeTask(job.id, 'b', 'late')).rejects.toThrow('JOB_LEASE_LOST');
    await b.completeTask(job.id, 'b', 'current');
    await b.release(job.id);
  });

  it('persists graph creation before it is accepted and survives file-store restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wazir-graph-'));
    try {
      const file = join(dir, 'store.json');
      const a = new JobManager({ store: new JsonFileStore(file) });
      await a.ready;
      const job = a.create({ title: 'persist', tasks: [{ task: { id: 'one', input: 'work' } }] });
      await a.save(job.id);
      const b = new JobManager({ store: new JsonFileStore(file) });
      await b.ready;
      expect(b.get(job.id)?.tasks[0].id).toBe('one');
      await b.acquire(job.id);
      await b.completeTask(job.id, 'one', 'done');
      await b.release(job.id);
      const c = new JobManager({ store: new JsonFileStore(file) });
      await c.ready;
      expect(c.get(job.id)?.graph.nodes[0].result).toBe('done');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
