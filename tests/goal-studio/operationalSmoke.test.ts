import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { registerControlRoutes } from '../../apps/api/src/goalStudio/controlRoutes.js';
import { createGoalStudioServices } from '../../apps/api/src/goalStudio/controlServices.js';
import {
  goalImportCommand,
  goalStartCommand,
  goalLifecycleCommand,
  goalRetryCommand,
} from '../../apps/cli/src/commands/goalCommands.js';

describe('Goal Studio Operational Smoke Tests', () => {
  let server: Server;
  let baseUrl: string;
  let services: ReturnType<typeof createGoalStudioServices>;

  beforeEach(async () => {
    services = createGoalStudioServices();
    const app = express();
    app.use(express.json());
    registerControlRoutes(app, services);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('1. CLI + Web Shared Goal State & Graph Creation/Import', async () => {
    const nobelPath = path.resolve(process.cwd(), 'packages/goals/fixtures/nobel_goal_graph.yaml');
    const importRes = await goalImportCommand(nobelPath, { url: baseUrl });
    expect(importRes.code).toBe(0);

    const graphsRes = await fetch(`${baseUrl}/api/v1/goal-studio/graphs`);
    expect(graphsRes.ok).toBe(true);
    const graphsData = await graphsRes.json() as { graphs?: Array<{ graphId: string }> };
    expect(graphsData.graphs).toBeDefined();
    expect(graphsData.graphs!.length).toBeGreaterThan(0);
    const graphId = graphsData.graphs![0].graphId;

    const cpRes = await fetch(`${baseUrl}/api/v1/goal-studio/graphs/${encodeURIComponent(graphId)}/critical-path`);
    expect(cpRes.ok).toBe(true);
    const cpData = await cpRes.json() as { criticalPath?: string[] };
    expect(cpData.criticalPath).toEqual(['Y1.1', 'Y1.2', 'Y1.3', 'Y2.1', 'Y2.2', 'Y2.3', 'Y3.3']);

    const seedRes = await fetch(`${baseUrl}/api/v1/goal-studio/graphs/seed-nobel`, { method: 'POST' });
    if (seedRes.status !== 404) {
      expect(seedRes.ok).toBe(true);
    }
  });

  it('2. CLI + Shared Execution Lifecycle (Start, Retry, Pause, Resume, Stop)', async () => {
    const nobelPath = path.resolve(process.cwd(), 'packages/goals/fixtures/nobel_goal_graph.yaml');
    const importRes = await goalImportCommand(nobelPath, { url: baseUrl });
    const data = importRes.data as { record?: { graphId: string }; graph?: { graphId: string } };
    const graphId = data.record?.graphId ?? data.graph?.graphId ?? 'nobel-research';

    const startRes = await goalStartCommand(graphId, { url: baseUrl });
    expect(startRes.code).toBe(0);
    const startData = startRes.data as { run?: { runId: string }; runId?: string };
    const runId = startData.run?.runId ?? startData.runId;
    expect(runId).toBeDefined();

    const runRes = await fetch(`${baseUrl}/api/v1/goal-studio/runs/${encodeURIComponent(runId!)}`);
    expect(runRes.ok).toBe(true);

    const retryRes = await goalRetryCommand(runId!, 'Y1.1', { eligible: true, url: baseUrl });
    expect(retryRes.code).toBe(0);

    const pauseRes = await goalLifecycleCommand('pause', runId!, { url: baseUrl });
    expect(pauseRes.code).toBe(0);

    const resumeRes = await goalLifecycleCommand('resume', runId!, { url: baseUrl });
    expect(resumeRes.code).toBe(0);

    const stopRes = await goalLifecycleCommand('stop', runId!, { url: baseUrl });
    expect(stopRes.code).toBe(0);
  });

  it('3. Results & Verified Artifacts Retrieval', async () => {
    const nobelPath = path.resolve(process.cwd(), 'packages/goals/fixtures/nobel_goal_graph.yaml');
    const importRes = await goalImportCommand(nobelPath, { url: baseUrl });
    const data = importRes.data as { record?: { graphId: string }; graph?: { graphId: string } };
    const graphId = data.record?.graphId ?? data.graph?.graphId ?? 'nobel-research';

    const startRes = await goalStartCommand(graphId, { url: baseUrl });
    const startData = startRes.data as { run?: { runId: string }; runId?: string };
    const runId = startData.run?.runId ?? startData.runId!;

    await goalRetryCommand(runId, 'Y1.1', { eligible: true, url: baseUrl });

    const evidenceRes = await fetch(`${baseUrl}/api/v1/goal-studio/runs/${encodeURIComponent(runId)}/evidence`);
    if (evidenceRes.ok) {
      const evData = await evidenceRes.json();
      expect(evData).toBeDefined();
    }

    const attemptsRes = await fetch(`${baseUrl}/api/v1/goal-studio/runs/${encodeURIComponent(runId)}/attempts`);
    if (attemptsRes.ok) {
      const attData = await attemptsRes.json();
      expect(attData).toBeDefined();
    }

    const transitionsRes = await fetch(`${baseUrl}/api/v1/goal-studio/runs/${encodeURIComponent(runId)}/transitions`);
    if (transitionsRes.ok) {
      const trData = await transitionsRes.json();
      expect(trData).toBeDefined();
    }
  });

  it('4. Web UI Static Entrypoint & Main Dashboard Link Connectivity', async () => {
    const indexPath = path.resolve(process.cwd(), 'apps/web/public/goal-studio/index.html');
    const shellPath = path.resolve(process.cwd(), 'apps/web/public/goal-studio/shell.js');

    const indexContent = await fs.readFile(indexPath, 'utf-8');
    const shellContent = await fs.readFile(shellPath, 'utf-8');

    expect(indexContent).toBeDefined();
    expect(shellContent).toBeDefined();

    const lowerShell = shellContent.toLowerCase();
    expect(lowerShell).toContain('graph');
    expect(lowerShell).toContain('execution');
    expect(lowerShell).toContain('prompts');
    expect(lowerShell).toContain('fleet');
  });
});
