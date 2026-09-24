import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiState, createApp } from '../src/server.js';
import { MemoryStore } from '@wazir/shared';

async function startServer() {
  const store = new MemoryStore();
  const state = await createApiState({
    auth: { allowUnauthenticated: true },
    store,
  });
  const app = createApp(state);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { state, server, baseUrl: `http://127.0.0.1:${port}`, store };
}

describe('Gate 12: Editor / Agent Protocol Integration', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  describe('Agent Protocol (ACP) Endpoints', () => {
    it('creates, inspects, executes steps, and persists tasks', async () => {
      const s = await startServer();
      server = s.server;

      // 1. Create task
      const createRes = await fetch(`${s.baseUrl}/ap/v1/agent/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: 'Fix defect in authentication service',
          additional_input: { priority: 'high' },
        }),
      });
      expect(createRes.status).toBe(201);
      const task = await createRes.json();
      expect(task.task_id).toBeDefined();
      expect(task.input).toBe('Fix defect in authentication service');
      expect(task.status).toBe('created');
      expect(task.steps).toEqual([]);
      expect(task.artifacts).toEqual([]);

      // 2. List tasks
      const listRes = await fetch(`${s.baseUrl}/ap/v1/agent/tasks`);
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.tasks.length).toBe(1);
      expect(listData.tasks[0].task_id).toBe(task.task_id);

      // 3. Get task by ID
      const getRes = await fetch(`${s.baseUrl}/ap/v1/agent/tasks/${task.task_id}`);
      expect(getRes.status).toBe(200);
      const fetchedTask = await getRes.json();
      expect(fetchedTask.task_id).toBe(task.task_id);

      // 4. Execute a step
      const stepRes = await fetch(`${s.baseUrl}/ap/v1/agent/tasks/${task.task_id}/steps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: 'Analyze codebase for defect',
          additional_input: { phase: 'diagnostics' },
        }),
      });
      expect(stepRes.status).toBe(200);
      const step = await stepRes.json();
      expect(step.step_id).toBeDefined();
      expect(step.task_id).toBe(task.task_id);
      expect(step.status).toBe('completed');
      expect(step.is_last).toBe(false);

      // 5. Verify task updated to running with step
      const taskAfterStepRes = await fetch(`${s.baseUrl}/ap/v1/agent/tasks/${task.task_id}`);
      const taskAfterStep = await taskAfterStepRes.json();
      expect(taskAfterStep.status).toBe('running');
      expect(taskAfterStep.steps.length).toBe(1);

      // 6. Execute last step
      const lastStepRes = await fetch(`${s.baseUrl}/ap/v1/agent/tasks/${task.task_id}/steps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: 'Apply verified patch and finalize',
          additional_input: { is_last: true },
        }),
      });
      expect(lastStepRes.status).toBe(200);
      const lastStep = await lastStepRes.json();
      expect(lastStep.is_last).toBe(true);

      // Task should now be completed
      const taskCompletedRes = await fetch(`${s.baseUrl}/ap/v1/agent/tasks/${task.task_id}`);
      const taskCompleted = await taskCompletedRes.json();
      expect(taskCompleted.status).toBe('completed');
      expect(taskCompleted.steps.length).toBe(2);

      // 7. List steps
      const stepsRes = await fetch(`${s.baseUrl}/ap/v1/agent/tasks/${task.task_id}/steps`);
      expect(stepsRes.status).toBe(200);
      const stepsData = await stepsRes.json();
      expect(stepsData.steps.length).toBe(2);

      // 8. Get specific step
      const stepGetRes = await fetch(`${s.baseUrl}/ap/v1/agent/tasks/${task.task_id}/steps/${step.step_id}`);
      expect(stepGetRes.status).toBe(200);
      const fetchedStep = await stepGetRes.json();
      expect(fetchedStep.step_id).toBe(step.step_id);

      // 9. Artifacts
      const artCreateRes = await fetch(`${s.baseUrl}/ap/v1/agent/tasks/${task.task_id}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_name: 'patch.diff',
          relative_path: 'patches/patch.diff',
          content: 'diff --git a/src/auth.ts...',
        }),
      });
      expect(artCreateRes.status).toBe(201);
      const artifact = await artCreateRes.json();
      expect(artifact.artifact_id).toBeDefined();
      expect(artifact.file_name).toBe('patch.diff');

      const artListRes = await fetch(`${s.baseUrl}/ap/v1/agent/tasks/${task.task_id}/artifacts`);
      expect(artListRes.status).toBe(200);
      const artListData = await artListRes.json();
      expect(artListData.artifacts.length).toBe(1);

      const artGetRes = await fetch(`${s.baseUrl}/ap/v1/agent/tasks/${task.task_id}/artifacts/${artifact.artifact_id}`);
      expect(artGetRes.status).toBe(200);
      const artFetched = await artGetRes.json();
      expect(artFetched.content).toBe('diff --git a/src/auth.ts...');
    });

    it('persists session across server restarts', async () => {
      const sharedStore = new MemoryStore();

      // Start initial server instance
      const state1 = await createApiState({ auth: { allowUnauthenticated: true }, store: sharedStore });
      const app1 = createApp(state1);
      const server1 = app1.listen(0);
      await new Promise<void>((r) => server1.once('listening', r));
      const port1 = (server1.address() as AddressInfo).port;

      const createRes = await fetch(`http://127.0.0.1:${port1}/ap/v1/agent/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Persistent task' }),
      });
      const task = await createRes.json();
      await new Promise<void>((r) => server1.close(() => r()));

      // Restart server with same backing store
      const state2 = await createApiState({ auth: { allowUnauthenticated: true }, store: sharedStore });
      const app2 = createApp(state2);
      const server2 = app2.listen(0);
      await new Promise<void>((r) => server2.once('listening', r));
      const port2 = (server2.address() as AddressInfo).port;
      server = server2;

      // Task is still present and recoverable!
      const getRes = await fetch(`http://127.0.0.1:${port2}/ap/v1/agent/tasks/${task.task_id}`);
      expect(getRes.status).toBe(200);
      const recoveredTask = await getRes.json();
      expect(recoveredTask.task_id).toBe(task.task_id);
      expect(recoveredTask.input).toBe('Persistent task');
    });
  });

  describe('Model Context Protocol (MCP) Server Endpoint', () => {
    it('handles initialize, notifications, ping, and metadata', async () => {
      const s = await startServer();
      server = s.server;

      // 1. initialize
      const initRes = await fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        }),
      });
      expect(initRes.status).toBe(200);
      const initData = await initRes.json();
      expect(initData.id).toBe(1);
      expect(initData.result.protocolVersion).toBe('2024-11-05');
      expect(initData.result.serverInfo.name).toBe('wazir-control-plane');
      expect(initData.result.capabilities.tools).toBeDefined();

      // 2. notifications/initialized (notification with no id returns 204)
      const notifRes = await fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      });
      expect(notifRes.status).toBe(204);

      // 3. ping
      const pingRes = await fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'ping-1',
          method: 'ping',
        }),
      });
      expect(pingRes.status).toBe(200);
      const pingData = await pingRes.json();
      expect(pingData.id).toBe('ping-1');
      expect(pingData.result).toEqual({});
    });

    it('lists and executes tools over JSON-RPC', async () => {
      const s = await startServer();
      server = s.server;

      // tools/list
      const listRes = await fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        }),
      });
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(Array.isArray(listData.result.tools)).toBe(true);
      expect(listData.result.tools.length).toBeGreaterThan(0);

      // tools/call (e.g. echo or file tool)
      const callRes = await fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'echo',
            arguments: { message: 'hello from editor' },
          },
        }),
      });
      expect(callRes.status).toBe(200);
      const callData = await callRes.json();
      expect(callData.id).toBe(3);
      expect(callData.result.content).toBeDefined();
    });

    it('lists resources, reads resources, and serves prompts', async () => {
      const s = await startServer();
      server = s.server;

      // resources/list
      const resList = await fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'resources/list',
        }),
      });
      const resListData = await resList.json();
      expect(resListData.result.resources.length).toBeGreaterThan(0);

      // resources/read
      const readRes = await fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'resources/read',
          params: { uri: 'wazir://workspace/status' },
        }),
      });
      const readData = await readRes.json();
      expect(readData.result.contents[0].uri).toBe('wazir://workspace/status');

      // prompts/list
      const promptList = await fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'prompts/list',
        }),
      });
      const promptListData = await promptList.json();
      expect(promptListData.result.prompts.some((p: any) => p.name === 'wazir-code-repair')).toBe(true);

      // prompts/get
      const promptGet = await fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'prompts/get',
          params: { name: 'wazir-code-repair', arguments: { defect_description: 'NPE on startup' } },
        }),
      });
      const promptGetData = await promptGet.json();
      expect(promptGetData.result.messages[0].content.text).toContain('NPE on startup');
    });

    it('returns standard JSON-RPC errors for unknown methods or invalid payloads', async () => {
      const s = await startServer();
      server = s.server;

      const badReq = await fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '1.0', // invalid version
          id: 99,
          method: 'test',
        }),
      });
      const badData = await badReq.json();
      expect(badData.error.code).toBe(-32600);

      const unknownMethod = await fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 100,
          method: 'nonExistentMethod',
        }),
      });
      const unknownData = await unknownMethod.json();
      expect(unknownData.error.code).toBe(-32601);
    });
  });
});
