import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import type { ExecutionEvent, ExecutionRecord, ExecutionStatus } from '../src/types/execution.js';
import {
  compactExecutionEvents,
  DEFAULT_HISTORY_RETENTION_POLICY,
  enforceRetention,
  HistoryRetentionService,
  sweepStore,
} from '../src/services/historyRetentionService.js';

function createMockExecutionRecord(overrides: {
  id: string;
  status?: ExecutionStatus | 'created';
  createdAtMs?: number;
  completedAtMs?: number;
  events?: ExecutionEvent[];
  unknownToolOutcome?: boolean;
  verificationPassed?: boolean;
}): ExecutionRecord {
  const createdAt = new Date(overrides.createdAtMs ?? 1_700_000_000_000);
  const completedAt =
    overrides.completedAtMs !== undefined ? new Date(overrides.completedAtMs) : undefined;
  const status = (overrides.status ?? 'completed') as ExecutionStatus;

  const events: ExecutionEvent[] =
    overrides.events ??
    [
      {
        id: `${overrides.id}-ev-1`,
        executionId: overrides.id,
        type: 'execution.created',
        eventType: 'execution.created',
        sequence: 1,
        timestamp: createdAt,
      },
      {
        id: `${overrides.id}-ev-2`,
        executionId: overrides.id,
        type: 'execution.completed',
        eventType: 'execution.completed',
        sequence: 2,
        timestamp: completedAt ?? createdAt,
      },
    ];

  return {
    storageRevision: 1,
    execution: {
      id: overrides.id,
      jobId: `job-${overrides.id}`,
      taskId: `task-${overrides.id}`,
      runtimeId: 'local-runtime',
      modelId: 'qwen/qwen3.8-27b',
      status,
      createdAt,
      startedAt: createdAt,
      completedAt,
    },
    task: {
      id: `task-${overrides.id}`,
      title: `Task ${overrides.id}`,
      description: 'Test execution record',
      type: 'code',
      priority: 'medium',
      createdAt,
    },
    policyDecisions: [
      {
        id: `pol-${overrides.id}`,
        executionId: overrides.id,
        action: 'read',
        decision: 'allow',
        reason: 'default allow',
        timestamp: createdAt,
      },
    ],
    toolCalls: overrides.unknownToolOutcome
      ? [
          {
            id: `tc-${overrides.id}`,
            tool: 'bash',
            input: { command: 'npm test' },
            ok: false,
            error: 'TOOL_OUTCOME_UNKNOWN: process disconnected',
            failureClass: 'TOOL_OUTCOME_UNKNOWN' as any,
            policyEffect: 'allow',
            policyRule: 'default',
            durationMs: 100,
            at: createdAt,
          },
        ]
      : [],
    filesChanged: ['packages/core/src/index.ts'],
    checks:
      overrides.verificationPassed !== false
        ? [
            {
              name: 'test',
              command: 'vitest run',
              ok: true,
              output: '1 passed',
              durationMs: 250,
            },
          ]
        : [],
    errors: status === 'failed' ? ['Execution failed'] : [],
    evaluation:
      overrides.verificationPassed !== false
        ? {
            success: true,
            reasons: ['All checks passed'],
            filesChanged: ['packages/core/src/index.ts'],
            checks: [],
            evaluatedAt: completedAt ?? createdAt,
          }
        : undefined,
    evidence: [
      {
        id: `evid-${overrides.id}`,
        type: 'test_pass' as any,
        summary: 'Unit tests passed',
        capturedAt: completedAt ?? createdAt,
      } as any,
    ],
    events,
  };
}

describe('HistoryRetentionService (Agent 13)', () => {
  it('exposes the required default retention policy configuration', () => {
    const service = new HistoryRetentionService();
    expect(service.policy).toEqual({
      maxTotalExecutions: 200,
      maxAgeMs: 604_800_000,
      maxEventsPerTerminalExecution: 50,
      preserveNonTerminal: true,
      preserveAuditAndVerificationEvidence: true,
    });
    expect(DEFAULT_HISTORY_RETENTION_POLICY.preserveNonTerminal).toBe(true);
    expect(DEFAULT_HISTORY_RETENTION_POLICY.preserveAuditAndVerificationEvidence).toBe(true);
  });

  it('never prunes or compacts non-terminal executions (created, assigned, running, waiting, paused)', () => {
    const nowMs = 1_700_000_000_000;
    const oldCreatedAt = nowMs - 30 * 24 * 60 * 60 * 1000; // 30 days old

    const statuses: Array<ExecutionStatus | 'created'> = [
      'created',
      'assigned',
      'running',
      'waiting',
      'paused',
    ];

    const records = statuses.map((status, idx) =>
      createMockExecutionRecord({
        id: `non-term-${idx}`,
        status,
        createdAtMs: oldCreatedAt,
      }),
    );

    const sweep = enforceRetention(records, {
      nowMs,
      policy: { maxTotalExecutions: 2, maxAgeMs: 1000 },
    });

    expect(sweep.prunedIds).toEqual([]);
    expect(sweep.archivedSummaries).toEqual([]);
    expect(sweep.kept).toHaveLength(5);
  });

  it('protects executions with active leases even if status is terminal', () => {
    const nowMs = 1_700_000_000_000;
    const oldTime = nowMs - 14 * 24 * 60 * 60 * 1000;

    const leasedRecord = createMockExecutionRecord({
      id: 'exec-leased',
      status: 'completed',
      createdAtMs: oldTime,
      completedAtMs: oldTime + 1000,
    });
    const unleasedRecord = createMockExecutionRecord({
      id: 'exec-unleased',
      status: 'completed',
      createdAtMs: oldTime,
      completedAtMs: oldTime + 1000,
    });

    const result = enforceRetention([leasedRecord, unleasedRecord], {
      nowMs,
      activeLeaseExecutionIds: new Set(['exec-leased']),
      policy: { maxTotalExecutions: 1, maxAgeMs: 10_000 },
    });

    expect(result.kept.map((r) => r.execution.id)).toEqual(['exec-leased']);
    expect(result.prunedIds).toEqual(['exec-unleased']);
  });

  it('protects executions with unresolved TOOL_OUTCOME_UNKNOWN tool calls or events', () => {
    const nowMs = 1_700_000_000_000;
    const oldTime = nowMs - 20 * 24 * 60 * 60 * 1000;

    const unknownToolRecord = createMockExecutionRecord({
      id: 'exec-unknown-tool',
      status: 'failed',
      createdAtMs: oldTime,
      completedAtMs: oldTime + 500,
      unknownToolOutcome: true,
    });

    const unknownEventRecord = createMockExecutionRecord({
      id: 'exec-unknown-event',
      status: 'failed',
      createdAtMs: oldTime,
      completedAtMs: oldTime + 500,
      events: [
        {
          id: 'e1',
          executionId: 'exec-unknown-event',
          type: 'execution.created',
          sequence: 1,
          timestamp: new Date(oldTime),
        },
        {
          id: 'e2',
          executionId: 'exec-unknown-event',
          type: 'tool.call.outcome_unknown',
          sequence: 2,
          timestamp: new Date(oldTime + 200),
        },
      ],
    });

    const result = enforceRetention([unknownToolRecord, unknownEventRecord], {
      nowMs,
      policy: { maxTotalExecutions: 0, maxAgeMs: 1000 },
    });

    expect(result.prunedIds).toEqual([]);
    expect(result.kept).toHaveLength(2);
  });

  it('compacts verbose token/progress events on terminal executions while preserving critical audit/verification/lease/checkpoint events in monotonic order', () => {
    const baseTime = 1_700_000_000_000;
    const events: ExecutionEvent[] = [];
    let seq = 1;

    const pushEvent = (type: ExecutionEvent['type'], data?: unknown) => {
      events.push({
        id: `ev-${seq}`,
        executionId: 'exec-compact',
        type,
        eventType: type,
        sequence: seq,
        timestamp: new Date(baseTime + seq * 10),
        data,
      });
      seq += 1;
    };

    pushEvent('execution.created');
    pushEvent('lease.acquired', { holder: 'worker-1' });
    pushEvent('policy.allowed', { tool: 'read' });
    for (let i = 0; i < 60; i++) {
      pushEvent('generation.token', { token: `chunk-${i}`, stdout: 'x'.repeat(200) });
    }
    pushEvent('execution.checkpoint.created', { checkpointId: 'cp-1' });
    for (let i = 0; i < 30; i++) {
      pushEvent('agent.turn', { content: `intermediate turn ${i}` });
    }
    pushEvent('verification.started');
    pushEvent('verification.passed', { checks: 4 });
    pushEvent('lease.released');
    pushEvent('execution.completed');

    const record = createMockExecutionRecord({
      id: 'exec-compact',
      status: 'completed',
      createdAtMs: baseTime,
      completedAtMs: baseTime + 5000,
      events,
    });

    const compacted = compactExecutionEvents(record, 20);
    expect(compacted.compacted).toBe(true);
    expect(compacted.eventsBefore).toBe(98);
    expect(compacted.eventsAfter).toBe(20);

    const remainingTypes = compacted.record.events.map((e) => e.eventType ?? e.type);
    expect(remainingTypes).toContain('execution.created');
    expect(remainingTypes).toContain('lease.acquired');
    expect(remainingTypes).toContain('policy.allowed');
    expect(remainingTypes).toContain('execution.checkpoint.created');
    expect(remainingTypes).toContain('verification.started');
    expect(remainingTypes).toContain('verification.passed');
    expect(remainingTypes).toContain('lease.released');
    expect(remainingTypes).toContain('execution.completed');

    // Verify monotonic sequence numbers and intact evidence array
    for (let i = 1; i < compacted.record.events.length; i++) {
      expect(compacted.record.events[i]!.sequence!).toBeGreaterThan(
        compacted.record.events[i - 1]!.sequence!,
      );
    }
    expect(compacted.record.evidence).toHaveLength(1);
  });

  it('evicts oldest terminal executions exceeding maxAgeMs or maxTotalExecutions into ArchivedExecutionSummary', () => {
    const nowMs = 1_700_500_000_000;
    const dayMs = 24 * 60 * 60 * 1000;

    // 1 expired (10 days old), 3 recent (1, 2, 3 days old) with maxTotalExecutions = 2
    const expired = createMockExecutionRecord({
      id: 'exec-expired',
      status: 'completed',
      createdAtMs: nowMs - 10 * dayMs,
      completedAtMs: nowMs - 10 * dayMs + 1000,
    });
    const recent3d = createMockExecutionRecord({
      id: 'exec-3d',
      status: 'failed',
      createdAtMs: nowMs - 3 * dayMs,
      completedAtMs: nowMs - 3 * dayMs + 1000,
      verificationPassed: false,
    });
    const recent2d = createMockExecutionRecord({
      id: 'exec-2d',
      status: 'completed',
      createdAtMs: nowMs - 2 * dayMs,
      completedAtMs: nowMs - 2 * dayMs + 1000,
    });
    const recent1d = createMockExecutionRecord({
      id: 'exec-1d',
      status: 'completed',
      createdAtMs: nowMs - 1 * dayMs,
      completedAtMs: nowMs - 1 * dayMs + 1000,
    });

    const sweep = enforceRetention([expired, recent3d, recent2d, recent1d], {
      nowMs,
      policy: {
        maxTotalExecutions: 2,
        maxAgeMs: 7 * dayMs,
        maxEventsPerTerminalExecution: 50,
      },
    });

    expect(sweep.kept.map((r) => r.execution.id)).toEqual(['exec-1d', 'exec-2d']);
    expect(sweep.prunedIds).toEqual(['exec-3d', 'exec-expired']);
    expect(sweep.archivedSummaries).toHaveLength(2);
    expect(sweep.estimatedBytesReclaimed).toBeGreaterThan(0);

    const archivedFailed = sweep.archivedSummaries.find((s) => s.id === 'exec-3d')!;
    expect(archivedFailed).toBeDefined();
    expect(archivedFailed.status).toBe('failed');
    expect(archivedFailed.verificationPassed).toBe(false);
    expect(archivedFailed.errorsCount).toBe(1);
    expect(archivedFailed.digest).toMatch(/^[a-f0-9]{32}$/);
  });

  it('integrates with KeyValueStore via sweepStore: writes archive summaries, deletes pruned keys, and updates compacted records', async () => {
    const store = new MemoryStore();
    const nowMs = 1_700_500_000_000;
    const dayMs = 24 * 60 * 60 * 1000;

    const runningRec = createMockExecutionRecord({
      id: 'running-1',
      status: 'running',
      createdAtMs: nowMs - 20 * dayMs,
    });

    const verboseEvents: ExecutionEvent[] = [
      {
        id: 'ev-start',
        executionId: 'recent-verbose',
        type: 'execution.created',
        eventType: 'execution.created',
        sequence: 1,
        timestamp: new Date(nowMs - 1000),
      },
      ...Array.from({ length: 25 }, (_, i) => ({
        id: `ev-tok-${i}`,
        executionId: 'recent-verbose',
        type: 'generation.token' as const,
        eventType: 'generation.token' as const,
        sequence: i + 2,
        timestamp: new Date(nowMs - 900 + i),
        data: { chunk: 'hello world' },
      })),
      {
        id: 'ev-end',
        executionId: 'recent-verbose',
        type: 'execution.completed',
        eventType: 'execution.completed',
        sequence: 27,
        timestamp: new Date(nowMs - 500),
      },
    ];

    const recentVerbose = createMockExecutionRecord({
      id: 'recent-verbose',
      status: 'completed',
      createdAtMs: nowMs - 1000,
      completedAtMs: nowMs - 500,
      events: verboseEvents,
    });

    const oldTerminal = createMockExecutionRecord({
      id: 'old-terminal',
      status: 'completed',
      createdAtMs: nowMs - 12 * dayMs,
      completedAtMs: nowMs - 12 * dayMs + 5000,
    });

    await store.put('execution/running-1', runningRec);
    await store.put('execution/recent-verbose', recentVerbose);
    await store.put('execution/old-terminal', oldTerminal);

    const sweepResult = await sweepStore(store, {
      nowMs,
      policy: {
        maxTotalExecutions: 5,
        maxAgeMs: 7 * dayMs,
        maxEventsPerTerminalExecution: 10,
      },
    });

    expect(sweepResult.prunedIds).toEqual(['old-terminal']);
    expect(sweepResult.eventsCompactedCount).toBe(17); // 27 -> 10 events

    // Pruned full record is deleted, archive summary is persisted
    expect(await store.get('execution/old-terminal')).toBeUndefined();
    const archived = await store.get<any>('archive/execution/old-terminal');
    expect(archived).toBeDefined();
    expect(archived.id).toBe('old-terminal');
    expect(archived.verificationPassed).toBe(true);

    // Running record is untouched
    const storedRunning = await store.get<ExecutionRecord>('execution/running-1');
    expect(storedRunning?.execution.status).toBe('running');

    // Surviving terminal record is compacted in store
    const storedRecent = await store.get<ExecutionRecord>('execution/recent-verbose');
    expect(storedRecent?.events).toHaveLength(10);
  });

  it('preserves all critical events even when critical events alone exceed maxEventsPerTerminalExecution', () => {
    const baseTime = 1_700_000_000_000;
    const criticalEvents: ExecutionEvent[] = Array.from({ length: 12 }, (_, idx) => ({
      id: `crit-${idx}`,
      executionId: 'exec-all-crit',
      type: idx === 0 ? 'execution.created' : idx === 11 ? 'execution.completed' : 'verification.passed',
      eventType: idx === 0 ? 'execution.created' : idx === 11 ? 'execution.completed' : 'verification.passed',
      sequence: idx + 1,
      timestamp: new Date(baseTime + idx * 10),
    }));

    const record = createMockExecutionRecord({
      id: 'exec-all-crit',
      status: 'completed',
      createdAtMs: baseTime,
      completedAtMs: baseTime + 500,
      events: criticalEvents,
    });

    const res = compactExecutionEvents(record, 5);
    expect(res.eventsAfter).toBe(12);
    expect(res.record.events).toHaveLength(12);
  });
});
