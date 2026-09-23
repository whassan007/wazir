import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import type { ExecutionRecord, Task } from '../src/types/index.js';
import { MemoryStore, JsonFileStore } from '@wazir/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistExecutionRecord } from '../src/services/executionPersistence.js';

const task: Task = {
  id: 'task-history', type: 'coding', input: 'Fix a defect',
  requirements: { capabilities: [] }, priority: 'normal', status: 'pending', createdAt: new Date(),
};
const params = { task, jobId: 'job-history', computerId: 'computer', runtimeId: 'runtime', modelId: 'model' };
afterEach(() => vi.useRealTimers());

describe('durable execution history', () => {
  it('records classified provider retry intent idempotently without prompt or error contents', async () => {
    let durable!: ExecutionRecord;
    const engine = new ExecutionEngine({ persist: record => { durable = record; } });
    const record = await engine.create(params);
    const event = { type: 'retry' as const, failureClass: 'RATE_LIMIT' as const, retryAttempt: 2, retryDelayMs: 500, error: 'sensitive provider body' };
    const context = { requestId: 'request', model: 'model', provider: 'provider' };
    await engine.recordProviderEvent(record.execution.id, event, context);
    await engine.recordProviderEvent(record.execution.id, event, context);
    expect(durable.events.filter(e => e.type === 'retry.scheduled')).toHaveLength(1);
    expect(durable.events.at(-1)?.data).toEqual({ attempt: 2, failureClass: 'RATE_LIMIT', provider: 'provider', model: 'model', delay: 500, turn: 'request', step: 'request', reason: 'transient_provider_failure' });
    expect(JSON.stringify(durable.events)).not.toContain('sensitive provider body');
    await engine.recordProviderEvent(record.execution.id, { ...event, type: 'error', retryExhausted: true }, context);
    expect(durable.events.at(-1)?.type).toBe('retry.exhausted');
  });

  it('refuses provider retry requests for policy or unclassified failures', async () => {
    const engine = new ExecutionEngine();
    const record = await engine.create(params);
    const context = { requestId: 'request', model: 'model' };
    await expect(engine.recordProviderEvent(record.execution.id, { type: 'retry', failureClass: 'POLICY_DENIED' }, context)).rejects.toThrow('classified transient failure');
    await expect(engine.recordProviderEvent(record.execution.id, { type: 'retry' }, context)).rejects.toThrow('classified transient failure');
  });
  it('retains history and appends after restarting the disk-backed engine', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wazir-events-'));
    try {
      const file = join(directory, 'store.json');
      const start = () => {
        const store = new JsonFileStore(file);
        return new ExecutionEngine({
          persist: r => persistExecutionRecord(store, `execution/${r.execution.id}`, r),
          load: async () => (await store.list('execution/')).map(e => e.value as ExecutionRecord),
        });
      };
      const first = start();
      const record = await first.create(params);
      const failure = { reason: 'timeout', providerDetails: undefined };
      await first.recordEvent(record.execution.id, 'model.attempt.failed', failure, { eventId: 'attempt-failed' });
      const before = await first.events(record.execution.id);
      const second = start();
      await second.ready;
      expect(JSON.stringify(await second.events(record.execution.id))).toEqual(JSON.stringify(before));
      await second.recordEvent(record.execution.id, 'model.attempt.failed', failure, { eventId: 'attempt-failed' });
      expect(await second.events(record.execution.id)).toHaveLength(2);
      await second.recordEvent(record.execution.id, 'retry.scheduled');
      const third = start();
      await third.ready;
      expect((await third.events(record.execution.id)).map(e => e.sequence)).toEqual([1, 2, 3]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('rejects a competing writer without losing the accepted append', async () => {
    const store = new MemoryStore();
    const key = 'execution/shared';
    const persist = (record: ExecutionRecord) => persistExecutionRecord(store, key, record);
    const first = new ExecutionEngine({ persist });
    const record = await first.create(params);
    const loaded = (await store.get<ExecutionRecord>(key))!;
    const second = new ExecutionEngine({ persist, load: () => [loaded] });
    await second.ready;
    await first.recordEvent(record.execution.id, 'turn.started');
    await expect(second.recordEvent(record.execution.id, 'turn.completed')).rejects.toThrow('EXECUTION_STORAGE_CONFLICT');
    expect((await store.get<ExecutionRecord>(key))!.events.at(-1)?.type).toBe('turn.started');
  });

  it('rejects truncation and rewriting of persisted facts even with the next storage revision', async () => {
    const store = new MemoryStore();
    const engine = new ExecutionEngine({ persist: r => persistExecutionRecord(store, 'execution/test', r) });
    const record = await engine.create(params);
    const next = structuredClone(record);
    next.storageRevision! += 1;
    next.events[0].data = { forged: true };
    await expect(persistExecutionRecord(store, 'execution/test', next)).rejects.toThrow('EXECUTION_HISTORY_CONFLICT');
    next.events = [];
    await expect(persistExecutionRecord(store, 'execution/test', next)).rejects.toThrow('EXECUTION_HISTORY_CONFLICT');
  });
  it('orders by sequence even if the wall clock moves backwards', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const engine = new ExecutionEngine();
    const record = await engine.create(params);
    vi.setSystemTime(1000);
    await engine.recordEvent(record.execution.id, 'turn.started', {}, { turnId: 'turn-1' });
    const events = await engine.events(record.execution.id);
    expect(events.map(e => e.sequence)).toEqual([1, 2]);
    expect(events.map(e => e.eventType)).toEqual(['execution.created', 'turn.started']);
    expect(events[1]).toMatchObject({ jobId: 'job-history', turnId: 'turn-1', modelId: 'model', workspaceRevision: 0 });
    expect(events[0].eventId).toBe(events[0].id);
    expect(events[0].timestamp.getTime()).toBeGreaterThan(events[1].timestamp.getTime());
  });

  it('isolates event payloads, returned history, and persisted snapshots from mutation', async () => {
    const snapshots: ExecutionRecord[] = [];
    const engine = new ExecutionEngine({ persist: record => { snapshots.push(record); } });
    const record = await engine.create(params);
    const data = { attempt: 1 };
    await engine.recordEvent(record.execution.id, 'model.attempt.started', data);
    data.attempt = 9;
    record.events.length = 0;
    const returned = await engine.events(record.execution.id);
    returned[0].type = 'execution.failed';
    await engine.recordEvent(record.execution.id, 'model.response.completed');
    expect(snapshots.map(s => s.events.length)).toEqual([1, 2, 3]);
    expect((await engine.events(record.execution.id))[1].data).toEqual({ attempt: 1 });
    expect((await engine.events(record.execution.id))[0].type).toBe('execution.created');
  });

  it('serializes overlapping asynchronous storage writes', async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writes: number[] = [];
    const engine = new ExecutionEngine({ persist: async record => {
      const size = record.events.length;
      if (size === 2) { entered(); await gate; }
      writes.push(size);
    } });
    const record = await engine.create(params);
    const first = engine.recordEvent(record.execution.id, 'turn.started');
    await enteredPromise;
    const second = engine.recordEvent(record.execution.id, 'turn.completed');
    await Promise.resolve();
    expect(writes).toEqual([1]);
    release();
    await Promise.all([first, second]);
    expect(writes).toEqual([1, 2, 3]);
  });

  it('migrates legacy history and continues its sequence after restart', async () => {
    const original = new ExecutionEngine();
    const record = await original.create(params);
    await original.recordEvent(record.execution.id, 'turn.started');
    const legacy = structuredClone(record);
    for (const event of legacy.events) {
      delete event.eventId; delete event.eventType; delete event.sequence; delete event.jobId;
    }
    const snapshots: ExecutionRecord[] = [];
    const restored = new ExecutionEngine({ load: () => [legacy], persist: r => { snapshots.push(r); } });
    await restored.ready;
    await restored.recordEvent(record.execution.id, 'turn.completed');
    expect((await restored.events(record.execution.id)).map(e => e.sequence)).toEqual([1, 2, 3]);
    expect(snapshots[0].events.map(e => e.id)).toEqual(legacy.events.map(e => e.id));
    expect(legacy.events[0].sequence).toBeUndefined();
  });

  it('deduplicates stable event IDs and rejects conflicting reuse', async () => {
    const engine = new ExecutionEngine();
    const record = await engine.create(params);
    const identity = { eventId: 'provider-attempt-1', attemptId: 'attempt-1' };
    await engine.recordEvent(record.execution.id, 'model.attempt.failed', { reason: 'timeout' }, identity);
    await engine.recordEvent(record.execution.id, 'model.attempt.failed', { reason: 'timeout' }, identity);
    expect(await engine.events(record.execution.id)).toHaveLength(2);
    await expect(engine.recordEvent(record.execution.id, 'model.attempt.failed', { reason: 'other' }, identity)).rejects.toThrow('Conflicting event');
  });

  it('persists recovered unknown outcomes once across repeated restarts', async () => {
    let durable!: ExecutionRecord;
    const persist = (r: ExecutionRecord) => { durable = structuredClone(r); };
    const first = new ExecutionEngine({ persist });
    const record = await first.create(params);
    await first.recordToolStart(record.execution.id, 'git', { command: 'commit' });
    const second = new ExecutionEngine({ load: () => [durable], persist });
    await second.ready;
    const third = new ExecutionEngine({ load: () => [durable], persist });
    await third.ready;
    expect(durable.events.filter(e => e.type === 'tool.unknownOutcome')).toHaveLength(1);
    expect(third.findUnknownOutcomeToolCall(record.execution.id)?.tool).toBe('git');
  });

  it('fails startup on unreadable storage or corrupt sequence', async () => {
    const failed = new ExecutionEngine({ load: () => { throw new Error('storage unavailable'); } });
    await expect(failed.ready).rejects.toThrow('storage unavailable');
    await expect(failed.create(params)).rejects.toThrow('storage unavailable');
    const record = await new ExecutionEngine().create(params);
    record.events[0].sequence = 4;
    const corrupt = new ExecutionEngine({ load: () => [record] });
    await expect(corrupt.ready).rejects.toThrow('Invalid event sequence');
  });

  it('fails closed after a persistence error instead of dispatching further work', async () => {
    let fail = false;
    const engine = new ExecutionEngine({ persist: () => { if (fail) throw new Error('disk full'); } });
    const record = await engine.create(params);
    fail = true;
    await expect(engine.recordToolStart(record.execution.id, 'git', {})).rejects.toThrow('disk full');
    await expect(engine.recordEvent(record.execution.id, 'turn.started')).rejects.toThrow('disk full');
    await expect(engine.create(params)).rejects.toThrow('disk full');
  });

  it('does not append duplicate completion and durably records stale completion rejection', async () => {
    let durable!: ExecutionRecord;
    const engine = new ExecutionEngine({ persist: r => { durable = r; } });
    const record = await engine.create(params);
    await expect(engine.setStatus(record.execution.id, 'completed', { targetRevision: 1 })).rejects.toThrow('STALE_WORKSPACE_REVISION');
    expect(durable.events.at(-1)?.type).toBe('completion.rejected');
    await engine.setStatus(record.execution.id, 'completed', { targetRevision: 0 });
    await engine.setStatus(record.execution.id, 'completed', { targetRevision: 0 });
    expect(durable.events.filter(e => e.type === 'execution.completed')).toHaveLength(1);
    await expect(engine.setStatus(record.execution.id, 'completed', { targetRevision: 1 })).rejects.toThrow('STALE_WORKSPACE_REVISION');
  });
});
