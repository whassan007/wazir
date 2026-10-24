import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../src/types/index.js';
import { ExecutionEngine } from '../src/services/executionEngine.js';

function makeTask(id: string): Task {
  const now = new Date();
  return {
    id,
    type: 'coding',
    input: `Task input for ${id}`,
    requirements: {},
    priority: 'normal',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  };
}

describe('Agent 14: ExecutionEngine Memory Allocations & Terminal Cache Optimization', () => {
  it('filters records before sorting in list(filter) with zero structuredClone calls', async () => {
    const engine = new ExecutionEngine();
    for (let i = 0; i < 30; i++) {
      const rec = await engine.create({
        task: makeTask(`task-${i}`),
        jobId: i % 3 === 0 ? 'job-alpha' : 'job-beta',
        agentId: i % 2 === 0 ? 'agent-even' : 'agent-odd',
        computerId: 'comp-1',
        runtimeId: 'rt-1',
        modelId: 'qwen3-coder:30b',
      });
      if (i % 5 === 0) {
        await engine.setStatus(rec.execution.id, 'cancelled');
      }
    }

    const cloneSpy = vi.spyOn(globalThis, 'structuredClone');
    try {
      const filteredByJob = await engine.list({ jobId: 'job-alpha' });
      expect(filteredByJob).toHaveLength(10);
      expect(filteredByJob.every((r) => r.execution.jobId === 'job-alpha')).toBe(true);

      const filteredByStatus = await engine.list({ status: 'cancelled' });
      expect(filteredByStatus).toHaveLength(6);
      expect(filteredByStatus.every((r) => r.execution.status === 'cancelled')).toBe(true);

      const filteredCombined = await engine.list({
        jobId: 'job-alpha',
        agentId: 'agent-even',
        status: 'cancelled',
      });
      expect(filteredCombined.length).toBeGreaterThan(0);
      expect(
        filteredCombined.every(
          (r) =>
            r.execution.jobId === 'job-alpha' &&
            r.execution.agentId === 'agent-even' &&
            r.execution.status === 'cancelled',
        ),
      ).toBe(true);

      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it('provides zero-clone fast paths via getReadOnly() and listSummaries()', async () => {
    const engine = new ExecutionEngine();
    const first = await engine.create({
      task: makeTask('task-summary-1'),
      jobId: 'job-sum',
      agentId: 'agent-1',
      computerId: 'comp-1',
      runtimeId: 'rt-1',
      modelId: 'model-a',
    });
    const second = await engine.create({
      task: makeTask('task-summary-2'),
      jobId: 'job-other',
      agentId: 'agent-2',
      computerId: 'comp-1',
      runtimeId: 'rt-1',
      modelId: 'model-b',
    });
    await engine.setStatus(second.execution.id, 'cancelled');

    const cloneSpy = vi.spyOn(globalThis, 'structuredClone');
    try {
      const ro = engine.getReadOnly(first.execution.id);
      expect(ro).toBeDefined();
      expect(ro?.execution.id).toBe(first.execution.id);
      expect(engine.getReadOnly('non-existent')).toBeUndefined();

      const allSummaries = engine.listSummaries();
      expect(allSummaries).toHaveLength(2);

      const cancelledSummaries = engine.listSummaries({ status: 'cancelled' });
      expect(cancelledSummaries).toHaveLength(1);
      expect(cancelledSummaries[0]).toMatchObject({
        id: second.execution.id,
        jobId: 'job-other',
        taskId: 'task-summary-2',
        status: 'cancelled',
        agentId: 'agent-2',
        modelId: 'model-b',
        errorCount: 0,
        toolCallCount: 0,
      });

      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it('evicts oldest terminal records via pruneTerminalCache() and maxInMemoryTerminalRecords while preserving active records', async () => {
    const engine = new ExecutionEngine();
    const terminalIds: string[] = [];
    const activeIds: string[] = [];

    for (let i = 0; i < 8; i++) {
      const rec = await engine.create({
        task: makeTask(`task-term-${i}`),
        computerId: 'comp-1',
        runtimeId: 'rt-1',
        modelId: 'model-1',
      });
      await engine.setStatus(rec.execution.id, 'cancelled');
      terminalIds.push(rec.execution.id);
    }

    for (let i = 0; i < 3; i++) {
      const rec = await engine.create({
        task: makeTask(`task-active-${i}`),
        computerId: 'comp-1',
        runtimeId: 'rt-1',
        modelId: 'model-1',
      });
      activeIds.push(rec.execution.id);
    }

    const evicted = engine.pruneTerminalCache(3);
    expect(evicted).toBe(5);

    // Oldest 5 terminal records evicted
    for (const oldId of terminalIds.slice(0, 5)) {
      expect(engine.getReadOnly(oldId)).toBeUndefined();
    }
    // Newest 3 terminal records retained
    for (const keptId of terminalIds.slice(5)) {
      expect(engine.getReadOnly(keptId)).toBeDefined();
    }
    // All 3 active records retained
    for (const activeId of activeIds) {
      expect(engine.getReadOnly(activeId)).toBeDefined();
    }

    // Automatic pruning when maxInMemoryTerminalRecords is configured
    const boundedEngine = new ExecutionEngine({ maxInMemoryTerminalRecords: 2 });
    const boundedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const rec = await boundedEngine.create({
        task: makeTask(`task-bounded-${i}`),
        computerId: 'comp-1',
        runtimeId: 'rt-1',
        modelId: 'model-1',
      });
      await boundedEngine.setStatus(rec.execution.id, 'cancelled');
      boundedIds.push(rec.execution.id);
    }
    const stats = boundedEngine.getMemoryStats();
    expect(stats.terminalRecords).toBe(2);
    expect(boundedEngine.getReadOnly(boundedIds[0])).toBeUndefined();
    expect(boundedEngine.getReadOnly(boundedIds[3])).toBeDefined();
    expect(boundedEngine.getReadOnly(boundedIds[4])).toBeDefined();
  });

  it('computes accurate memory statistics via getMemoryStats()', async () => {
    const engine = new ExecutionEngine();
    const r1 = await engine.create({
      task: makeTask('stats-1'),
      computerId: 'comp-1',
      runtimeId: 'rt-1',
      modelId: 'model-1',
    });
    const r2 = await engine.create({
      task: makeTask('stats-2'),
      computerId: 'comp-1',
      runtimeId: 'rt-1',
      modelId: 'model-1',
    });
    await engine.setStatus(r1.execution.id, 'cancelled');

    const stats = engine.getMemoryStats();
    expect(stats.totalRecords).toBe(2);
    expect(stats.activeRecords).toBe(1);
    expect(stats.terminalRecords).toBe(1);
    expect(stats.totalEvents).toBeGreaterThanOrEqual(3); // 2 created + 1 cancelled
    expect(stats.totalToolCalls).toBe(0);
    expect(stats.estimatedPayloadBytes).toBeGreaterThan(1024);
    expect(r2.execution.status).toBe('queued');
  });
});
