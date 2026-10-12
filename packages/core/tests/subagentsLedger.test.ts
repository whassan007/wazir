import { describe, it, expect, vi } from 'vitest';
import { SubagentsLedger } from '../src/subagents/ledger.js';
import type { SubagentTask } from '../src/subagents/types.js';

describe('SubagentsLedger (Adapted from Qwen-Live-Harness)', () => {
  it('tracks subagent lifecycle states and generates valid snapshots', () => {
    const ledger = new SubagentsLedger();

    ledger.upsert({
      id: 'sub-1',
      kind: 'canary',
      title: 'Evaluate G61 Fleet Balancing',
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      request: 'Run 10 canary tasks across fleet',
    });

    let snapshot = ledger.snapshot();
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0].id).toBe('sub-1');
    expect(snapshot.tasks[0].status).toBe('queued');

    // Transition to running
    ledger.upsert({
      id: 'sub-1',
      kind: 'canary',
      title: 'Evaluate G61 Fleet Balancing',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      request: 'Run 10 canary tasks across fleet',
      activity: 'Executing benchmark test suite',
    });

    snapshot = ledger.snapshot();
    expect(snapshot.counts.running).toBe(1);
    expect(snapshot.counts.completed).toBe(0);
    expect(ledger.get('sub-1')?.activity).toBe('Executing benchmark test suite');

    // Transition to completed
    ledger.upsert({
      id: 'sub-1',
      kind: 'canary',
      title: 'Evaluate G61 Fleet Balancing',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      request: 'Run 10 canary tasks across fleet',
      output: 'All 10 canary tasks passed with zero stragglers',
    });

    snapshot = ledger.snapshot();
    expect(snapshot.counts.running).toBe(0);
    expect(snapshot.counts.completed).toBe(1);
  });

  it('bounds terminal history and retains counts upon eviction', () => {
    const ledger = new SubagentsLedger();

    // Create and complete 35 tasks (exceeding MAX_TERMINAL_DETAILS of 32)
    for (let i = 1; i <= 35; i++) {
      ledger.upsert({
        id: `task-${i}`,
        kind: 'repair',
        title: `Repair attempt ${i}`,
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        request: `Fix error ${i}`,
      });

      ledger.upsert({
        id: `task-${i}`,
        kind: 'repair',
        title: `Repair attempt ${i}`,
        status: 'completed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        request: `Fix error ${i}`,
      });
    }

    const snapshot = ledger.snapshot();
    expect(snapshot.counts.completed).toBe(35);
    // Active detail map should be capped at 32
    expect(snapshot.tasks.length).toBeLessThanOrEqual(32);
    // Oldest tasks should be evicted from details but counted in archived
    expect(ledger.get('task-1')).toBeUndefined();
    expect(ledger.get('task-35')).toBeDefined();
  });

  it('filters tasks by category', () => {
    const ledger = new SubagentsLedger();

    ledger.upsert({
      id: 'run-1',
      kind: 'search',
      title: 'Search branch',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      request: 'MCTS search',
    });

    ledger.upsert({
      id: 'wait-1',
      kind: 'harness',
      title: 'Ask permission',
      status: 'waiting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      request: 'Apply git commit',
      permissions: [
        {
          requestHandle: 'h1',
          title: 'Allow git commit',
          choices: [{ decision: 'allow' }],
        },
      ],
    });

    expect(ledger.list('running')).toHaveLength(1);
    expect(ledger.list('running')[0].id).toBe('run-1');

    expect(ledger.list('needsAttention')).toHaveLength(1);
    expect(ledger.list('needsAttention')[0].id).toBe('wait-1');
  });

  it('notifies subscribers upon change with debounce', async () => {
    const onChange = vi.fn();
    const ledger = new SubagentsLedger(onChange);

    ledger.upsert({
      id: 'sub-notify',
      kind: 'visual',
      title: 'Visual check',
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      request: 'Snapshot test',
    });

    // Wait for debounced notification
    await new Promise((res) => setTimeout(res, 50));
    expect(onChange).toHaveBeenCalled();
    ledger.close();
  });
});
