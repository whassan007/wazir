import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiState, createApp, TaskDispatcher } from '../../apps/api/src/server.js';
import { Worker, dispatchRemote } from '@wazir/workers';
import {
  ComputerRegistry,
  ExecutionEngine,
  JobManager,
  JobOrchestrator,
  ModelRegistry,
  RecoveryManager,
  RuntimeRegistry,
  Scheduler,
  reconstructExecutionState,
  planRecovery,
} from '@wazir/core';
import { MemoryStore } from '@wazir/shared';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { WorkerExecutionRequest } from '@wazir/core';

function createMockAdapter(failExecution = false): RuntimeAdapter {
  return {
    id: 'recovery-adapter',
    type: 'ollama',
    async discover() { return { id: 'recovery-adapter', name: 'Recovery Adapter', version: '1.0' }; },
    async healthCheck() { return { status: 'healthy' }; },
    async listModels() { return [{ id: 'test-model', name: 'test-model' }]; },
    async getCapabilities() {
      return {
        chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false,
        embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: true,
        statefulChat: false, mcp: false,
      };
    },
    async *generate() {
      if (failExecution) {
        throw new Error('Agent process failed unexpectedly: SIGSEGV');
      }
      yield { type: 'token' as const, content: 'Recovered task output' };
      yield { type: 'completed' as const, content: 'Recovered task output', usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };
}

async function startController(store = new MemoryStore(), leaseMs = 500) {
  const state = await createApiState({
    store,
    workerLeaseMs: leaseMs,
    auth: { allowUnauthenticated: true },
  });
  const app = createApp(state);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { state, server, baseUrl: `http://127.0.0.1:${port}`, store };
}

describe('Durable Recovery & Fault Tolerance Suite', () => {
  const serversToClose: Server[] = [];
  const workersToStop: Worker[] = [];

  afterEach(async () => {
    for (const w of workersToStop) {
      await w.stop().catch(() => undefined);
    }
    workersToStop.length = 0;
    for (const s of serversToClose) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    serversToClose.length = 0;
  });

  it('1. Controller crash & restart: durable task state survives restart and leases recover', async () => {
    const sharedStore = new MemoryStore();
    let ctrl = await startController(sharedStore, 500);
    serversToClose.push(ctrl.server);

    const worker = new Worker({
      computerId: 'worker-restart-test',
      serverUrl: ctrl.baseUrl,
      adapters: [createMockAdapter()],
    });
    workersToStop.push(worker);
    await worker.start();

    // Dispatch a task
    const req: WorkerExecutionRequest = {
      executionId: 'exec-ctrl-crash',
      requestId: 'req-ctrl-crash',
      modelId: 'test-model',
      messages: [{ role: 'user', content: 'Survive restart' }],
    };

    const dispatchRes = await fetch(`${ctrl.baseUrl}/api/v1/tasks/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ computerId: 'worker-restart-test', request: req }),
    });
    expect(dispatchRes.ok).toBe(true);

    // Simulate controller crash by destroying connections and closing server
    ctrl.server.closeAllConnections?.();
    await new Promise<void>((resolve) => ctrl.server.close(() => resolve()));
    const serverIndex = serversToClose.indexOf(ctrl.server);
    if (serverIndex !== -1) serversToClose.splice(serverIndex, 1);

    // Controller restarts using the same underlying durable store
    const restarted = await startController(sharedStore, 500);
    serversToClose.push(restarted.server);

    // Verify task state was durably persisted and recovered
    const recoveredStatus = await restarted.state.dispatcher.status('req-ctrl-crash');
    expect(recoveredStatus).toBeDefined();
    expect(restarted.state.dispatcher.ownerOf('req-ctrl-crash')).toBe('worker-restart-test');
  }, 15_000);

  it('2. Worker crash: orphan detection past offlineMs marks executions failed', async () => {
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();
    const executions = new ExecutionEngine();
    const jobManager = new JobManager();

    computers.register({
      id: 'crashed-worker-pc',
      name: 'crashed-worker-pc',
      type: 'workstation',
      local: false,
      os: { platform: 'linux', architecture: 'x64', version: '6.0' },
      hardware: { cpu: 'x86_64', cpuCores: 8, memoryGB: 32 },
    });

    const recovery = new RecoveryManager({
      computers,
      executions,
      jobManager,
      staleMs: 200,
      offlineMs: 400,
    });

    const record = await executions.create({
      task: { id: 't-crash-test', input: 'do work' } as any,
      computerId: 'crashed-worker-pc',
      modelId: 'test-model',
    });
    await executions.setStatus(record.execution.id, 'running');

    // Backdate last heartbeat to simulate worker dying
    const comp = computers.get('crashed-worker-pc')!;
    (comp as any).lastHeartbeat = new Date(Date.now() - 1000);

    const sweep = await recovery.sweep();
    expect(sweep.offlineComputers).toContain('crashed-worker-pc');
    expect(sweep.orphanedExecutions).toContain(record.execution.id);

    const updated = await executions.get(record.execution.id);
    expect(updated?.execution.status).toBe('failed');
    expect(updated?.errors.some((e) => e.includes('ORPHANED_WORKER_UNREACHABLE'))).toBe(true);
  });

  it('3. Network disconnection & automatic reconnection: worker reconnects task stream', async () => {
    const { server, baseUrl, state } = await startController();
    serversToClose.push(server);

    const worker = new Worker({
      computerId: 'reconnecting-worker',
      serverUrl: baseUrl,
      adapters: [createMockAdapter()],
    });
    workersToStop.push(worker);
    await worker.start();

    // Wait for worker task stream to connect initially
    for (let i = 0; i < 30; i++) {
      if (state.dispatcher.isConnected('reconnecting-worker')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(state.dispatcher.isConnected('reconnecting-worker')).toBe(true);

    // Simulate abrupt network drop by server disconnecting the SSE stream
    state.dispatcher.disconnect('reconnecting-worker');
    expect(state.dispatcher.isConnected('reconnecting-worker')).toBe(false);

    // Wait for worker retry timer to trigger reconnection (connectTaskStream timeout)
    let reconnected = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (state.dispatcher.isConnected('reconnecting-worker')) {
        reconnected = true;
        break;
      }
    }
    expect(reconnected).toBe(true);
  }, 15_000);

  it('4. Agent process failure: explicit error event and failed outcome reported', async () => {
    const { server, baseUrl } = await startController();
    serversToClose.push(server);

    const failingWorker = new Worker({
      computerId: 'failing-worker',
      serverUrl: baseUrl,
      adapters: [createMockAdapter(true)], // will throw SIGSEGV error
    });
    workersToStop.push(failingWorker);
    await failingWorker.start();

    const request: WorkerExecutionRequest = {
      executionId: 'exec-fail-test',
      requestId: 'req-fail-test',
      modelId: 'test-model',
      messages: [{ role: 'user', content: 'Crash this' }],
    };

    const outcomeGenerator = dispatchRemote(baseUrl, 'failing-worker', request);
    let step = await outcomeGenerator.next();
    while (!step.done) {
      step = await outcomeGenerator.next();
    }
    const outcome = step.value;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('SIGSEGV');
  });

  it('5. Duplicate task delivery & idempotency: rejects duplicate dispatch and concurrent claims', async () => {
    const store = new MemoryStore();
    const dispatcher = new TaskDispatcher(store, Date.now, 30_000);
    await dispatcher.ready;

    const req: WorkerExecutionRequest = {
      executionId: 'exec-idem',
      requestId: 'req-duplicate-test',
      modelId: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
    };

    // First dispatch succeeds
    const firstDispatch = await dispatcher.dispatch('worker-1', req);
    expect(firstDispatch.ok).toBe(true);

    // Duplicate dispatch with same requestId is rejected
    const dupDispatch = await dispatcher.dispatch('worker-1', req);
    expect(dupDispatch.ok).toBe(false);
    expect((dupDispatch as any).reason).toBe('REQUEST_ALREADY_DISPATCHED');

    // First worker claims lease
    const claim1 = await dispatcher.claim('req-duplicate-test', 'worker-1');
    expect(claim1.token).toBeDefined();

    // Concurrent claim while lease is active is rejected with RESOURCE_BUSY
    await expect(dispatcher.claim('req-duplicate-test', 'worker-1')).rejects.toThrow('RESOURCE_BUSY');
  });

  it('6. Interrupted result reporting: lease expiration fences out zombie workers', async () => {
    let mockTime = 1000;
    const store = new MemoryStore();
    const dispatcher = new TaskDispatcher(store, () => mockTime, 1000);
    await dispatcher.ready;

    const req: WorkerExecutionRequest = {
      executionId: 'exec-fence',
      requestId: 'req-fence-test',
      modelId: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
    };

    await dispatcher.dispatch('worker-zombie', req);
    const lease = await dispatcher.claim('req-fence-test', 'worker-zombie');

    // Advance time past lease expiration (1000ms lease duration)
    mockTime += 2000;

    // Zombie worker tries to resolve after lease expired
    await expect(
      dispatcher.resolve(
        'req-fence-test',
        { ok: true, output: 'late result', inputTokens: 1, outputTokens: 1, durationMs: 100 },
        lease.token,
      ),
    ).rejects.toThrow('LEASE_LOST');
  });

  it('7. Unsafe replay prevention: mutating tool call mid-flight blocks auto-retry', async () => {
    const executions = new ExecutionEngine();
    const record = await executions.create({
      task: { id: 't-side-effect', input: 'git commit' } as any,
      computerId: 'local',
      modelId: 'test-model',
    });
    await executions.setStatus(record.execution.id, 'running');

    // Worker started a mutating tool call (side effect) then was interrupted
    await executions.recordToolStart(record.execution.id, 'shell', { command: 'git commit -m "wip"' });

    const updated = (await executions.get(record.execution.id))!;
    const checkpoints = executions.toolCheckpoints(record.execution.id);

    const state = reconstructExecutionState(updated, checkpoints);
    expect(state.unresolvedToolCalls.length).toBeGreaterThan(0);
    expect(state.unresolvedToolCalls[0].toolName).toBe('shell');

    // Recovery planner MUST return 'reconcile' and refuse blind replay
    const plan = planRecovery(state);
    expect(plan.action).toBe('reconcile');
    expect(plan.reasons.some((r) => r.includes('must not be replayed blindly'))).toBe(true);
  });
});
