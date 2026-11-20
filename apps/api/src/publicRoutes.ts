import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { resolveWazirHome } from '@wazir/observability';

export function getSanitizedDemoFleet() {
  return {
    demo: true,
    sanitized: true,
    notice: 'Public Demonstration Mode — synthetic sample fleet data. Real worker inventories require operator authentication.',
    generatedAt: new Date().toISOString(),
    machines: [
      {
        id: 'demo-mac-node',
        name: 'Sample Apple Silicon Workstation',
        os: 'darwin',
        arch: 'arm64',
        status: 'online',
        capabilities: ['mlx', 'shell', 'macos-packaging'],
        models: ['qwen3.5-9b-local', 'qwen3-30b-a3b'],
        cpuPercent: 28,
        memoryPercent: 54,
        gpuPercent: 41,
        activeJobs: 1,
      },
      {
        id: 'demo-linux-gpu',
        name: 'Sample Linux GPU Compute Node',
        os: 'linux',
        arch: 'arm64',
        status: 'online',
        capabilities: ['cuda', 'ollama', 'docker', 'linux-packaging'],
        models: ['qwen3-coder:30b', 'qwen3.6:35b-a3b', 'gemma4:26b'],
        cpuPercent: 34,
        memoryPercent: 46,
        gpuPercent: 62,
        activeJobs: 2,
      },
      {
        id: 'demo-mobile-companion',
        name: 'Sample GrapheneOS Companion',
        os: 'android',
        arch: 'arm64',
        status: 'online',
        capabilities: ['approvals', 'monitoring', 'termux-cli'],
        models: [],
        cpuPercent: 8,
        memoryPercent: 31,
        gpuPercent: null,
        activeJobs: 0,
      },
    ],
    executionGraph: {
      jobId: 'demo-job-001',
      request: 'Run test suite and verify build integrity across Linux GPU node',
      state: 'Completed and verified',
      stages: [
        { id: 'req', label: 'User Request', state: 'Completed and verified', machine: 'demo-mac-node', model: 'deterministic' },
        { id: 'plan', label: 'Planner', state: 'Completed and verified', machine: 'demo-mac-node', model: 'qwen3.5-9b-local' },
        { id: 'route', label: 'Model Router', state: 'Completed and verified', machine: 'demo-mac-node', model: 'policy-router-v1' },
        { id: 'worker', label: 'Worker', state: 'Completed and verified', machine: 'demo-linux-gpu', model: 'qwen3-coder:30b' },
        { id: 'tool', label: 'Tool Execution', state: 'Completed and verified', machine: 'demo-linux-gpu', model: 'sandbox-pty' },
        { id: 'verify', label: 'Verification', state: 'Completed and verified', machine: 'demo-linux-gpu', model: 'evidence-gate' },
        { id: 'result', label: 'Result', state: 'Completed and verified', machine: 'demo-mac-node', model: 'verified-report' },
      ],
    },
  };
}

export function registerPublicRoutes(app: Express, wazirHome?: string): void {
  const home = resolveWazirHome(wazirHome);
  const inquiriesPath = path.join(home, 'commercial-license-inquiries.jsonl');

  app.get('/api/v1/public/demo-fleet', (_req: Request, res: Response) => {
    res.json(getSanitizedDemoFleet());
  });

  app.post('/api/v1/public/commercial-license', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    const organization = typeof body?.organization === 'string' ? body.organization.trim().slice(0, 120) : '';
    const email = typeof body?.email === 'string' ? body.email.trim().slice(0, 120) : '';
    const scope = typeof body?.scope === 'string' ? body.scope.trim().slice(0, 500) : '';

    if (!organization || !email || !email.includes('@') || !scope) {
      res.status(400).json({ error: 'organization, valid email, and scope are required' });
      return;
    }

    const inquiry = {
      id: crypto.randomUUID(),
      organization,
      email,
      scope,
      status: 'pending_review',
      licenseGranted: false,
      submittedAt: new Date().toISOString(),
    };

    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.appendFileSync(inquiriesPath, `${JSON.stringify(inquiry)}\n`, { mode: 0o600 });

    res.status(202).json({
      received: true,
      inquiryId: inquiry.id,
      status: 'pending_review',
      licenseGranted: false,
      message: 'Commercial authorization request recorded for rights-holder review. Submission does not grant a license.',
    });
  });
}
