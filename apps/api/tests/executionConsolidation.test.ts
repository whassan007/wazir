import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { ExecutionEngine, persistExecutionRecord } from '@wazir/core';
import { JsonFileStore, MemoryStore, type KeyValueStore } from '@wazir/shared';
import { createApiState, createApp, type ApiState } from '../src/server.js';

const ROOT_PKG_VERSION = (JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'),
) as { version: string }).version;

describe('API consolidation & review findings (B, C, D, E, G, I)', { timeout: 30_000 }, () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function start(store: KeyValueStore = new MemoryStore()): Promise<{
    state: ApiState;
    server: Server;
    baseUrl: string;
  }> {
    const state = await createApiState({
      store,
      auth: { allowUnauthenticated: true, store },
    });
    const app = createApp(state);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    return { state, server, baseUrl: `http://127.0.0.1:${port}` };
  }

  async function stop(server: Server): Promise<void> {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const idx = servers.indexOf(server);
    if (idx >= 0) servers.splice(idx, 1);
  }

  it('Finding B: execution history persists across API restarts via KeyValueStore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wazir-exec-durable-'));
    try {
      const storePath = join(dir, 'wazir.json');
      const first = await start(new JsonFileStore(storePath));
      const postRes = await fetch(`${first.baseUrl}/executions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: 'task-persist-1',
          task: { type: 'code', input: 'persist across restart' },
          agentId: 'coder',
          modelId: 'qwen2.5-coder:7b',
          computerId: 'local',
          result: 'persisted output',
        }),
      });
      expect(postRes.status).toBe(201);
      const { id } = (await postRes.json()) as { id: string };
      await stop(first.server);

      const second = await start(new JsonFileStore(storePath));
      const listRes = await fetch(`${second.baseUrl}/api/v1/executions`);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        executions: Array<{ execution: { id: string }; result?: string }>;
      };
      expect(listBody.executions.some((e) => e.execution.id === id && e.result === 'persisted output')).toBe(true);

      const detailRes = await fetch(`${second.baseUrl}/api/v1/executions/${id}`);
      expect(detailRes.status).toBe(200);
      const detailBody = (await detailRes.json()) as { execution: { execution: { id: string }; result: string } };
      expect(detailBody.execution.execution.id).toBe(id);
      expect(detailBody.execution.result).toBe('persisted output');
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('Findings C & D: CLI ExecutionEngine records, events, and child subagent executions are visible through the API', async () => {
    const store = new MemoryStore();
    const { baseUrl } = await start(store);

    // Simulate a separate CLI process writing execution records into the shared store
    // AFTER the API server is already running.
    const cliEngine = new ExecutionEngine({
      persist: (record) => persistExecutionRecord(store, `execution/${record.execution.id}`, record),
      load: async () => (await store.list('execution/')).map((e) => e.value as never),
    });
    await cliEngine.ready;

    const parent = await cliEngine.create({
      task: {
        id: 'cli-task-parent',
        type: 'coding',
        input: 'coordinate refactor',
        requirements: { capabilities: [] },
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      agentId: 'architect',
      modelId: 'qwen2.5-coder:32b',
      runtimeId: 'ollama',
      computerId: 'local',
    });
    await cliEngine.setStatus(parent.execution.id, 'running');
    await cliEngine.setResult(parent.execution.id, 'refactor plan complete');
    await cliEngine.setStatus(parent.execution.id, 'completed');

    const child = await cliEngine.create({
      task: {
        id: 'cli-task-child',
        type: 'coding',
        input: 'verify refactored module',
        requirements: { capabilities: [] },
        priority: 'normal',
        status: 'completed',
        createdAt: new Date(),
      },
      parentExecutionId: parent.execution.id,
      agentId: 'verifier',
      modelId: 'qwen2.5-coder:7b',
      runtimeId: 'ollama',
      computerId: 'local',
    });
    await cliEngine.setStatus(child.execution.id, 'completed');

    // 1. Both CLI executions appear in /api/v1/executions and /api/v1/overview
    const listRes = await fetch(`${baseUrl}/api/v1/executions`);
    const listBody = (await listRes.json()) as {
      executions: Array<{ execution: { id: string } }>;
      total: number;
    };
    const ids = listBody.executions.map((e) => e.execution.id);
    expect(ids).toContain(parent.execution.id);
    expect(ids).toContain(child.execution.id);

    const overviewRes = await fetch(`${baseUrl}/api/v1/overview`);
    const overview = (await overviewRes.json()) as { counts: { executions: number } };
    expect(overview.counts.executions).toBeGreaterThanOrEqual(2);

    // 2. /api/v1/executions/:id/events returns the recorded lifecycle events
    const eventsRes = await fetch(`${baseUrl}/api/v1/executions/${parent.execution.id}/events`);
    expect(eventsRes.status).toBe(200);
    const eventsBody = (await eventsRes.json()) as {
      executionId: string;
      events: Array<{ type: string }>;
    };
    expect(eventsBody.executionId).toBe(parent.execution.id);
    expect(eventsBody.events.length).toBeGreaterThan(0);

    // 3. /api/v1/executions/:id/children returns the nested subagent execution
    const childrenRes = await fetch(`${baseUrl}/api/v1/executions/${parent.execution.id}/children`);
    expect(childrenRes.status).toBe(200);
    const childrenBody = (await childrenRes.json()) as {
      executionId: string;
      children: Array<{ execution: { id: string; parentExecutionId?: string } }>;
    };
    expect(childrenBody.executionId).toBe(parent.execution.id);
    expect(childrenBody.children.map((c) => c.execution.id)).toEqual([child.execution.id]);
  });

  it('Finding G: /api/v1/executions supports pagination, filtering, and lightweight summary mode', async () => {
    const { baseUrl } = await start();
    const largeOutput = 'A'.repeat(2_000);

    for (let i = 0; i < 5; i += 1) {
      await fetch(`${baseUrl}/executions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: `t-${i}`,
          task: { type: i % 2 === 0 ? 'code' : 'review', input: `prompt-${i}` },
          agentId: i % 2 === 0 ? 'coder' : 'reviewer',
          modelId: 'm1',
          computerId: 'local',
          result: largeOutput,
        }),
      });
    }

    const pageRes = await fetch(`${baseUrl}/api/v1/executions?summary=1&limit=2&offset=1`);
    expect(pageRes.status).toBe(200);
    const page = (await pageRes.json()) as {
      executions: Array<{ execution: { id: string }; result: string; resultTruncated?: boolean }>;
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    };
    expect(page.total).toBe(5);
    expect(page.offset).toBe(1);
    expect(page.limit).toBe(2);
    expect(page.hasMore).toBe(true);
    expect(page.executions).toHaveLength(2);
    expect(page.executions[0].resultTruncated).toBe(true);
    expect(page.executions[0].result.length).toBeLessThan(600);

    // Full record via /:id still has the untruncated output
    const fullRes = await fetch(`${baseUrl}/api/v1/executions/${page.executions[0].execution.id}`);
    const fullBody = (await fullRes.json()) as { execution: { result: string } };
    expect(fullBody.execution.result.length).toBe(2_000);

    // Agent filter
    const filteredRes = await fetch(`${baseUrl}/api/v1/executions?agentId=reviewer`);
    const filteredBody = (await filteredRes.json()) as { total: number };
    expect(filteredBody.total).toBe(2);
  });

  it('Findings E, I.1, I.2: /ready checks dependencies, version matches root package.json, and /api/v1/workers lists remote computers', async () => {
    const { baseUrl } = await start();

    const health = (await (await fetch(`${baseUrl}/health`)).json()) as { version: string };
    const readyRes = await fetch(`${baseUrl}/ready`);
    const ready = (await readyRes.json()) as {
      status: string;
      version: string;
      checks: Record<string, { ok: boolean }>;
    };
    expect(readyRes.status).toBe(200);
    expect(ready.status).toBe('ready');
    expect(ready.checks.store.ok).toBe(true);
    expect(ready.checks.dispatcher.ok).toBe(true);
    expect(ready.checks.controlServices.ok).toBe(true);
    expect(health.version).toBe(ROOT_PKG_VERSION);
    expect(ready.version).toBe(ROOT_PKG_VERSION);

    // Register a remote worker computer and verify /api/v1/workers includes both local and remote
    const regRes = await fetch(`${baseUrl}/computers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'dgx-spark', name: 'DGX Spark', type: 'workstation' }),
    });
    expect(regRes.status).toBe(200);

    const workersRes = await fetch(`${baseUrl}/api/v1/workers`);
    const workersBody = (await workersRes.json()) as {
      workers: Array<{ computerId: string; local: boolean }>;
    };
    const computerIds = workersBody.workers.map((w) => w.computerId);
    expect(computerIds).toContain('local');
    expect(computerIds).toContain('dgx-spark');
  });

  it('Priority P0/P1: cross-process CLI execution persists through API restart with identical identifiers, events, artifacts, and normalized fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wazir-cross-proc-exec-'));
    try {
      const storePath = join(dir, 'shared-store.json');
      const api1 = await start(new JsonFileStore(storePath));

      // Separate CLI process ExecutionEngine writing to the same JsonFileStore on disk
      const cliStore = new JsonFileStore(storePath);
      const cliEngine = new ExecutionEngine({
        persist: (record) => persistExecutionRecord(cliStore, `execution/${record.execution.id}`, record),
        load: async () => (await cliStore.list('execution/')).map((e) => e.value as never),
      });
      await cliEngine.ready;

      const created = await cliEngine.create({
        task: {
          id: 'task-cross-proc-1',
          type: 'coding',
          input: 'Verify cross-process execution state',
          requirements: { capabilities: [] },
          priority: 'normal',
          status: 'running',
          createdAt: new Date(),
        },
        agentId: 'coding-agent',
        modelId: 'qwen2.5-coder:14b',
        runtimeId: 'ollama',
        computerId: 'local',
      });
      const execId = created.execution.id;

      await cliEngine.setStatus(execId, 'running');
      await cliEngine.recordCheck(execId, {
        name: 'vitest-suite',
        type: 'test',
        command: 'npx vitest run',
        passed: true,
        output: '12 passed',
        durationMs: 420,
      });
      await cliEngine.setResult(execId, 'Cross-process execution verified');
      await cliEngine.setStatus(execId, 'completed');

      // Retrieve through API #1 (while running concurrently with CLI store updates)
      const detail1 = await (await fetch(`${api1.baseUrl}/api/v1/executions/${execId}`)).json() as {
        execution: Record<string, unknown> & { execution: Record<string, unknown> };
      };
      expect(detail1.execution.execution.id).toBe(execId);
      expect(detail1.execution.execution.status).toBe('completed');
      expect(detail1.execution.agentId).toBe('coding-agent');
      expect(detail1.execution.modelId).toBe('qwen2.5-coder:14b');
      expect(detail1.execution.execution.finishedAt).toBeDefined();
      expect(Array.isArray(detail1.execution.evidence)).toBe(true);

      const events1 = await (await fetch(`${api1.baseUrl}/api/v1/executions/${execId}/events`)).json() as {
        executionId: string;
        events: Array<{ id: string; type: string; sequence: number }>;
      };
      expect(events1.executionId).toBe(execId);
      expect(events1.events.some((e) => e.type === 'execution.completed')).toBe(true);

      const artifacts1 = await (await fetch(`${api1.baseUrl}/api/v1/executions/${execId}/artifacts`)).json() as {
        targetId: string;
        artifacts: Array<{ kind: string }>;
      };
      expect(artifacts1.targetId).toBe(execId);
      expect(artifacts1.artifacts.length).toBeGreaterThan(0);

      // Mobile task list also surfaces the CLI execution
      const mobileTasks1 = await (await fetch(`${api1.baseUrl}/api/v1/mobile/tasks`)).json() as {
        tasks: Array<{ taskId: string; executionId?: string; state: string }>;
      };
      expect(mobileTasks1.tasks.some((t) => t.executionId === execId && t.state === 'completed')).toBe(true);

      // Restart the API and verify identical identifiers, events, artifacts, and terminal state
      await stop(api1.server);
      const api2 = await start(new JsonFileStore(storePath));

      const detail2 = await (await fetch(`${api2.baseUrl}/api/v1/executions/${execId}`)).json() as {
        execution: Record<string, unknown> & { execution: Record<string, unknown> };
      };
      expect(detail2.execution.execution.id).toBe(execId);
      expect(detail2.execution.execution.status).toBe('completed');
      expect(detail2.execution.result).toBe('Cross-process execution verified');

      const events2 = await (await fetch(`${api2.baseUrl}/api/v1/executions/${execId}/events`)).json() as {
        executionId: string;
        events: Array<{ id: string; type: string; sequence: number }>;
      };
      expect(events2.events.map((e) => e.id)).toEqual(events1.events.map((e) => e.id));
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

