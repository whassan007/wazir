import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerRegistry, ExecutionEngine, JobManager, RecoveryManager } from '@wazir/core';
import { startLocalHeartbeat } from '../src/localHeartbeat.js';

/**
 * Found by the Phase 24 live run (exec-muf4k4ta-1): 20s into a long `test` check the
 * wa run process's own RecoveryManager failed the execution with "worker on computer
 * 'local' stopped heartbeating", because nothing heartbeated the local computer between
 * model placements. A live process must never orphan the execution it is running.
 */
describe('the local worker heartbeats for as long as its process lives', () => {
  afterEach(() => { vi.useRealTimers(); });

  async function setup() {
    const computers = new ComputerRegistry();
    computers.register({
      id: 'local', name: 'local', type: 'workstation', local: true,
      os: { platform: 'linux', architecture: 'x64', version: '6.0' },
      hardware: { cpu: 'test-cpu', cpuCores: 8, memoryGB: 32 },
      capabilities: ['localExecution'],
    });
    computers.heartbeat('local', {});
    const executions = new ExecutionEngine();
    const record = await executions.create({
      task: { id: 'task', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      computerId: 'local', runtimeId: 'runtime', modelId: 'model',
    });
    await executions.setStatus(record.execution.id, 'running');
    await executions.recordToolStart(record.execution.id, 'test', {}, { callId: 'call-test', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
    const recovery = new RecoveryManager({ computers, executions, jobManager: new JobManager() });
    return { computers, executions, recovery, id: record.execution.id };
  }

  it('a five-minute quiet tool call does not orphan the execution', async () => {
    vi.useFakeTimers();
    const { computers, executions, recovery, id } = await setup();
    const stop = startLocalHeartbeat(computers, 'local', () => ({ cpuPercent: 0 }) as never);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const sweep = await recovery.sweep();
    stop();
    expect(sweep.offlineComputers).toEqual([]);
    expect(sweep.orphanedExecutions).toEqual([]);
    expect(executions.require(id).execution.status).toBe('running');
  });

  it('control: without the heartbeat the same quiet period orphans it (the live-run failure)', async () => {
    vi.useFakeTimers();
    const { recovery, id, executions } = await setup();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const sweep = await recovery.sweep();
    expect(sweep.orphanedExecutions).toEqual([id]);
    expect(executions.require(id).execution.status).toBe('failed');
  });

  it('once the process stops heartbeating, the worker goes offline as before', async () => {
    vi.useFakeTimers();
    const { computers, recovery } = await setup();
    const stop = startLocalHeartbeat(computers, 'local', () => undefined as never);
    await vi.advanceTimersByTimeAsync(30_000);
    stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect((await recovery.sweep()).offlineComputers).toEqual(['local']);
  });
});
