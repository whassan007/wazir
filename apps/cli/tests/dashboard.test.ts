import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry,
  ApprovalQueue,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  JobManager,
  JobOrchestrator,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  WorktreeManager,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import { MemoryStore } from '@wazir/shared';
import type { RookEngine } from '../src/engine.js';
import { startDashboardServer, getDashboardHtml } from '../src/dashboardServer.js';

async function buildDashboardTestEngine(projectRoot: string): Promise<RookEngine> {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();
  const executions = new ExecutionEngine();
  const approvalQueue = new ApprovalQueue();
  const jobManager = new JobManager();
  const worktrees = new WorktreeManager(projectRoot);

  computers.register({
    id: 'local',
    name: 'test-computer',
    type: 'workstation',
    local: true,
    os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
    hardware: { cpu: 'test-cpu', cpuCores: 4, memoryGB: 16 },
    capabilities: ['localExecution'],
  });

  runtimes.register({
    id: 'ollama',
    type: 'ollama',
    name: 'Ollama Runtime',
    version: '0.3.0',
    computerId: 'local',
    capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false },
  });

  models.register({
    id: 'gemma:2b',
    name: 'Gemma 2B',
    provider: 'ollama',
    family: 'gemma',
    contextMax: 8192,
    capabilities: ['generalChat', 'codeGeneration'],
  });

  agents.register(createCodingAgent());

  const policy = new PolicyEngine({ projectRoot });
  const scheduler = new Scheduler({ computers, runtimes, models });
  const orchestrator = new JobOrchestrator({
    jobManager,
    scheduler,
    policyEngine: policy,
    approvalQueue,
  });

  return {
    config: {
      modelContext: {},
      modelCapabilities: {},
      networkAllowed: false,
      allowCommands: [],
      denyCommands: [],
      allowedMcpServers: [],
    },
    projectRoot,
    configDir: path.join(projectRoot, '.wazir'),
    computers,
    runtimes,
    models,
    agents,
    tools,
    policy,
    scheduler,
    compiler,
    executions,
    approvalQueue,
    orchestrator,
    worktrees,
    adapters: new Map(),
    discovered: [
      {
        id: 'ollama',
        info: { name: 'Ollama Runtime', version: '0.3.0' },
        health: 'available',
        models: [{ id: 'gemma:2b', name: 'Gemma 2B', family: 'gemma' }],
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false },
      },
    ],
    worker: {
      id: 'worker-local',
      computerId: 'local',
    } as any,
    store: new MemoryStore() as any,
  };
}

describe('wa dashboard server', () => {
  let server: Server | undefined;
  let baseUrl: string;
  let tmpDir: string;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('serves dashboard HTML, health check, and all API v1 endpoints', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-dashboard-test-'));
    const engine = await buildDashboardTestEngine(tmpDir);

    server = await startDashboardServer(engine, { port: 0, host: '127.0.0.1' });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 1. Dashboard UI
    const htmlRes = await fetch(`${baseUrl}/`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type')).toContain('text/html');
    const htmlBody = await htmlRes.text();
    expect(htmlBody).toContain('<!doctype html>');
    expect(htmlBody).toContain('Wazir');

    // 2. Health check
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as any;
    expect(health.status).toBe('ok');
    expect(health.timestamp).toBeDefined();

    // 3. Overview
    const overviewRes = await fetch(`${baseUrl}/api/v1/overview`);
    expect(overviewRes.status).toBe(200);
    const overview = (await overviewRes.json()) as any;
    expect(overview.name).toBe('wazir');
    expect(overview.counts.computers).toBe(1);
    expect(overview.counts.runtimes).toBe(1);
    expect(overview.counts.models).toBe(1);
    expect(overview.counts.agents).toBeGreaterThan(0);
    expect(overview.counts.tools).toBeGreaterThan(0);

    // 4. Computers
    const computersRes = await fetch(`${baseUrl}/api/v1/computers`);
    expect(computersRes.status).toBe(200);
    const compData = (await computersRes.json()) as any;
    expect(compData.computers).toHaveLength(1);
    expect(compData.computers[0].id).toBe('local');

    // 5. Workers
    const workersRes = await fetch(`${baseUrl}/api/v1/workers`);
    expect(workersRes.status).toBe(200);
    const workerData = (await workersRes.json()) as any;
    expect(workerData.workers).toHaveLength(1);
    expect(workerData.workers[0].status).toBe('online');

    // 6. Runtimes
    const runtimesRes = await fetch(`${baseUrl}/api/v1/runtimes`);
    expect(runtimesRes.status).toBe(200);
    const runtimesData = (await runtimesRes.json()) as any;
    expect(runtimesData.runtimes).toHaveLength(1);
    expect(runtimesData.runtimes[0].id).toBe('ollama');
    expect(runtimesData.runtimes[0].health).toBe('available');

    // 7. Models
    const modelsRes = await fetch(`${baseUrl}/api/v1/models`);
    expect(modelsRes.status).toBe(200);
    const modelsData = (await modelsRes.json()) as any;
    expect(modelsData.models).toHaveLength(1);
    expect(modelsData.models[0].id).toBe('gemma:2b');

    // 8. Agents
    const agentsRes = await fetch(`${baseUrl}/api/v1/agents`);
    expect(agentsRes.status).toBe(200);
    const agentsData = (await agentsRes.json()) as any;
    expect(agentsData.agents.length).toBeGreaterThan(0);

    // 9. Tools
    const toolsRes = await fetch(`${baseUrl}/api/v1/tools`);
    expect(toolsRes.status).toBe(200);
    const toolsData = (await toolsRes.json()) as any;
    expect(toolsData.tools.length).toBeGreaterThan(0);

    // 10. Executions
    const executionsRes = await fetch(`${baseUrl}/api/v1/executions`);
    expect(executionsRes.status).toBe(200);
    const executionsData = (await executionsRes.json()) as any;
    expect(executionsData.executions).toBeDefined();

    // 10b. Execution events & children
    const testTask = {
      id: 'task-dash-test',
      type: 'coding' as const,
      input: 'Test dash execution',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    const parentRec = await engine.executions.create({
      task: testTask,
      computerId: 'local',
      runtimeId: 'ollama',
      modelId: 'gemma:2b',
    });
    const childRec = await engine.executions.create({
      task: { ...testTask, id: 'task-dash-child', input: 'Child dash execution' },
      parentExecutionId: parentRec.execution.id,
      computerId: 'local',
      runtimeId: 'ollama',
      modelId: 'gemma:2b',
    });

    const eventsRes = await fetch(`${baseUrl}/api/v1/executions/${parentRec.execution.id}/events`);
    expect(eventsRes.status).toBe(200);
    const eventsData = (await eventsRes.json()) as any;
    expect(eventsData.executionId).toBe(parentRec.execution.id);
    expect(eventsData.events.length).toBeGreaterThan(0);

    const childrenRes = await fetch(`${baseUrl}/api/v1/executions/${parentRec.execution.id}/children`);
    expect(childrenRes.status).toBe(200);
    const childrenData = (await childrenRes.json()) as any;
    expect(childrenData.executionId).toBe(parentRec.execution.id);
    expect(childrenData.children).toHaveLength(1);
    expect(childrenData.children[0].execution.id).toBe(childRec.execution.id);

    // 11. CORS preflight OPTIONS request
    const optionsRes = await fetch(`${baseUrl}/api/v1/overview`, { method: 'OPTIONS' });
    expect(optionsRes.status).toBe(204);
    expect(optionsRes.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('provides getDashboardHtml fallback function', () => {
    const html = getDashboardHtml();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Wazir');
  });
});
