import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '@wazir/shared';
import { ExecutionEngine, persistExecutionRecord, type ExecutionRecord } from '../src/index.js';

/**
 * Found by the Phase 24 live run (exec-muf5bd29-1): a second `wa` process started while
 * a run was mid-`read`. At load it marked that in-flight call TOOL_OUTCOME_UNKNOWN and
 * wrote the record, so the live run's next write hit EXECUTION_STORAGE_CONFLICT and the
 * process crashed. Two engines on one JSON store reproduce it exactly.
 */
describe('a starting process never recovers an execution another live process is running', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'wazir-owner-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const engine = (pid: number, alive: (pid: number) => boolean) => {
    const store = new JsonFileStore(join(dir, 'wazir.json'));
    return new ExecutionEngine({
      owner: { pid, host: 'host-a' },
      isProcessAlive: alive,
      persist: (r) => persistExecutionRecord(store, `execution/${r.execution.id}`, r),
      load: async () => (await store.list('execution/')).map((e) => e.value as ExecutionRecord),
    });
  };

  async function liveRunMidRead(live: ExecutionEngine) {
    await live.ready;
    const record = await live.create({
      task: { id: 't', type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      computerId: 'local', runtimeId: 'r', modelId: 'm',
    });
    await live.setStatus(record.execution.id, 'running');
    await live.recordToolStart(record.execution.id, 'read', { path: 'x' }, { callId: 'c1', sideEffectClass: 'READ_ONLY' });
    return record.execution.id;
  }
  const completeRead = (live: ExecutionEngine, id: string) =>
    live.recordToolCall(id, { id: 'c1', tool: 'read', input: { path: 'x' }, ok: true, output: '', durationMs: 1, at: new Date() });

  it('leaves a live owner\'s in-flight call alone, so the live run keeps writing', async () => {
    const live = engine(1001, () => true);
    const id = await liveRunMidRead(live);
    expect(live.require(id).execution.owner).toEqual({ pid: 1001, host: 'host-a' });

    const starting = engine(1002, (pid) => pid === 1001);
    await starting.ready;
    const types = (await starting.events(id)).map((e) => e.eventType);
    expect(types).not.toContain('tool.call.outcome_unknown');
    expect(starting.ownedByAnotherLiveProcess(starting.require(id))).toBe(true);

    await expect(completeRead(live, id)).resolves.toBeUndefined();
  });

  it('still recovers the execution of an owner that has died, and takes it over', async () => {
    const dead = engine(1001, () => true);
    const id = await liveRunMidRead(dead);

    const starting = engine(1002, () => false);
    await starting.ready;
    expect((await starting.events(id)).map((e) => e.eventType)).toContain('tool.call.outcome_unknown');
    expect(starting.require(id).execution.owner).toEqual({ pid: 1002, host: 'host-a' });
  });

  it('an unstamped (legacy) or other-host owner keeps the previous recovery behavior', async () => {
    const starting = engine(1002, () => true);
    await starting.ready;
    const record = { execution: { owner: undefined } } as unknown as ExecutionRecord;
    expect(starting.ownedByAnotherLiveProcess(record)).toBe(false);
    record.execution.owner = { pid: 1001, host: 'host-b' };
    expect(starting.ownedByAnotherLiveProcess(record)).toBe(false);
  });

  it('an execution left running by a dead owner is marked failed as interrupted, not left running forever', async () => {
    const dead = engine(1001, () => true);
    await dead.ready;
    const record = await dead.create({
      task: { id: 't2', type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      computerId: 'local', runtimeId: 'external', modelId: 'external:codex',
    });
    await dead.setStatus(record.execution.id, 'running'); // a delegated agent: no tool checkpoints at all

    const live = engine(1002, (pid) => pid === 1001 ? false : true);
    await live.ready;
    const r = live.require(record.execution.id);
    expect(r.execution.status).toBe('failed');
    expect(r.errors.at(-1)).toMatch(/^INTERRUPTED: owning process 1001 exited while this execution was running/);
    expect((await live.events(record.execution.id)).map((e) => e.eventType)).toContain('execution.failed');

    // Durable: a third process sees it failed and does not re-mark it.
    const third = engine(1003, () => false);
    await third.ready;
    expect(third.require(record.execution.id).errors.filter((e) => e.startsWith('INTERRUPTED'))).toHaveLength(1);
  });

  it('a live owner\'s running execution is not touched', async () => {
    const live = engine(1001, () => true);
    const id = await liveRunMidRead(live);
    const starting = engine(1002, () => true);
    await starting.ready;
    expect(starting.require(id).execution.status).toBe('running');
  });
});
