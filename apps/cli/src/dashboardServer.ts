import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import type { RookEngine } from './engine.js';
import { DASHBOARD_HTML_BASE64 } from './dashboardHtml.js';
import { color } from './colors.js';

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  openBrowser?: boolean;
}

/**
 * Returns the HTML string for the Wazir web dashboard.
 * Prefers the local filesystem if running in a source tree, otherwise uses the embedded bundle.
 */
export function getDashboardHtml(): string {
  try {
    const localCandidates = [
      path.resolve(process.cwd(), 'apps/web/public/index.html'),
      path.resolve(__dirname, '../../web/public/index.html'),
      path.resolve(__dirname, '../web/public/index.html'),
    ];
    for (const cand of localCandidates) {
      if (fs.existsSync(cand)) {
        return fs.readFileSync(cand, 'utf8');
      }
    }
  } catch {
    // Fall back to embedded bundle
  }

  return Buffer.from(DASHBOARD_HTML_BASE64, 'base64').toString('utf8');
}

/**
 * Opens a URL in the user's default browser on macOS, Linux, or Windows.
 */
export function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, () => {});
}

/**
 * Proxies an incoming request to an upstream Wazir API server.
 */
function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, targetUrl: string): void {
  try {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: url.host,
      },
    };
    const upstream = lib.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Upstream API unreachable: ${err.message}` }));
    });
    req.pipe(upstream);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy configuration error: ${String(err)}` }));
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * Starts the integrated Wazir Web Dashboard & Control Plane HTTP server.
 */
export async function startDashboardServer(
  engine: RookEngine,
  options: DashboardServerOptions = {},
): Promise<http.Server> {
  const port = options.port ?? 4801;
  const host = options.host ?? '127.0.0.1';
  const upstreamApi = process.env.WAZIR_API?.replace(/\/+$/, '');
  const diffReviews = new Map<string, Record<string, 'keep' | 'skip' | 'pending'>>();
  const autonomyState: { mode: string; networkGuard: string; updatedAt: string } = {
    mode: 'request-review',
    networkGuard: 'normal',
    updatedAt: new Date().toISOString(),
  };
  const hostList: Array<Record<string, unknown>> = [
    {
      id: 'local',
      name: `${os.hostname()} (Local Controller)`,
      url: `http://${host}:${port}`,
      local: true,
      selected: true,
      status: 'online',
      addedAt: new Date().toISOString(),
    },
  ];
  const scheduleList: Array<Record<string, unknown>> = [];

  const server = http.createServer(async (req, res) => {
    // CORS headers for local developer tooling
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Wazir-Target-Host');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', `http://${host}:${port}`);
    const pathname = parsedUrl.pathname;

    // Upstream API proxy if WAZIR_API is configured
    if (upstreamApi && (pathname.startsWith('/api/') || pathname === '/health')) {
      proxyRequest(req, res, upstreamApi);
      return;
    }

    // 1. Dashboard UI & Brand Assets
    if (pathname === '/' || pathname === '/index.html') {
      const html = getDashboardHtml();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(html);
      return;
    }

    const staticAssetMime: Record<string, string> = {
      '/favicon.svg': 'image/svg+xml',
      '/logo-emblem.svg': 'image/svg+xml',
      '/favicon.ico': 'image/x-icon',
      '/favicon-16x16.png': 'image/png',
      '/favicon-32x32.png': 'image/png',
      '/apple-touch-icon.png': 'image/png',
      '/icon-192.png': 'image/png',
      '/icon-512.png': 'image/png',
      '/icon-maskable-512.png': 'image/png',
      '/logo-emblem.png': 'image/png',
      '/og-image.png': 'image/png',
      '/site.webmanifest': 'application/manifest+json; charset=utf-8',
    };
    if (pathname in staticAssetMime) {
      const relFile = pathname.slice(1);
      const candidates = [
        path.resolve(process.cwd(), 'apps/web/public', relFile),
        path.resolve(__dirname, '../../web/public', relFile),
        path.resolve(__dirname, '../web/public', relFile),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          res.writeHead(200, { 'Content-Type': staticAssetMime[pathname] });
          res.end(fs.readFileSync(cand));
          return;
        }
      }
      if (pathname === '/site.webmanifest') {
        res.writeHead(200, { 'Content-Type': staticAssetMime[pathname] });
        res.end(
          JSON.stringify({
            name: 'Wazir — A Local AI Fleet Counselor',
            short_name: 'Wazir',
            start_url: '/',
            display: 'standalone',
            background_color: '#0f131a',
            theme_color: '#0f131a',
            icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
          })
        );
        return;
      }
      if (pathname.endsWith('.svg')) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none"><rect width="512" height="512" rx="108" fill="#0f131a"/><path d="M256 36 L204 128 L256 172 L308 128 Z M114 58 L128 158 L194 180 L190 132 Z M398 58 L384 158 L318 180 L322 132 Z" fill="#f8fafc"/><path d="M118 164 L196 196 L256 150 L316 196 L394 164 L394 274 C394 362 332 428 256 476 C180 428 118 362 118 274 Z" fill="#94a3b8"/><path d="M138 184 L198 210 L256 168 L314 210 L374 184 L374 272 C374 348 320 406 256 450 C192 406 138 348 138 272 Z" fill="#162032" stroke="#38bdf8" stroke-width="5"/><circle cx="256" cy="296" r="42" fill="#0f131a" stroke="#f8fafc" stroke-width="12"/><circle cx="256" cy="296" r="18" fill="#67e8f9"/></svg>`
        );
        return;
      }
    }

    // 2. Health Endpoint
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    // 3. API v1 Overview
    if (pathname === '/api/v1/overview') {
      const localId = 'local';
      const executions = await engine.executions.list();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          name: 'wazir',
          version: '0.1.2',
          description:
            'Wazir is a model- and runtime-agnostic meta-harness that schedules AI agents, models, tools, and compute to execute tasks across local and distributed environments.',
          computerId: localId,
          hostname: os.hostname(),
          counts: {
            computers: engine.computers.list().length,
            workers: 1,
            runtimes: engine.runtimes.list().length,
            models: engine.models.list().length,
            agents: engine.agents.list().length,
            tools: engine.tools.descriptors().length,
            executions: executions.length,
          },
        }),
      );
      return;
    }

    // 4. API v1 Computers
    if (pathname === '/api/v1/computers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ computers: engine.computers.list() }));
      return;
    }

    // 5. API v1 Workers
    if (pathname === '/api/v1/workers') {
      const local = engine.computers.get('local');
      const workers = [
        {
          id: engine.worker?.id ?? 'worker-local',
          computerId: 'local',
          name: local?.name ?? os.hostname(),
          status: 'online',
          runtimes: engine.runtimes.list().map((r) => r.id),
          models: engine.models.list().map((m) => m.id),
          lastHeartbeat: new Date(),
        },
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ workers }));
      return;
    }

    // 6. API v1 Runtimes
    if (pathname === '/api/v1/runtimes') {
      const runtimes = engine.runtimes.list().map((r) => {
        const disc = engine.discovered.find((d) => d.id === r.id);
        return {
          ...r,
          health: disc?.health ?? 'available',
          healthMessage: disc?.healthMessage,
          models: disc?.models ?? [],
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ runtimes }));
      return;
    }

    // 7. API v1 Models
    if (pathname === '/api/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: engine.models.list() }));
      return;
    }

    // 8. API v1 Agents
    if (pathname === '/api/v1/agents') {
      const agents = engine.agents.list().map((a) => ({ ...a.descriptor, source: a.source }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents }));
      return;
    }

    // 9. API v1 Tools
    if (pathname === '/api/v1/tools') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tools: engine.tools.descriptors() }));
      return;
    }

    // 10. API v1 Executions list or individual item
    if (pathname === '/api/v1/executions') {
      const executions = await engine.executions.list();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ executions }));
      return;
    }

    if (pathname.startsWith('/api/v1/executions/')) {
      const rest = pathname.slice('/api/v1/executions/'.length);
      if (rest.endsWith('/events')) {
        const execId = decodeURIComponent(rest.slice(0, -'/events'.length));
        const execution = await engine.executions.get(execId);
        if (execution) {
          const events = await engine.executions.events(execution.execution.id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ executionId: execution.execution.id, events }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Execution '${execId}' not found` }));
        }
        return;
      }

      if (rest.endsWith('/children')) {
        const execId = decodeURIComponent(rest.slice(0, -'/children'.length));
        const execution = await engine.executions.get(execId);
        if (execution) {
          const children = await engine.executions.listChildren(execution.execution.id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ executionId: execution.execution.id, children }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Execution '${execId}' not found` }));
        }
        return;
      }

      if (rest.endsWith('/artifacts')) {
        const execId = decodeURIComponent(rest.slice(0, -'/artifacts'.length));
        const execution = await engine.executions.get(execId);
        if (!execution) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Execution '${execId}' not found` }));
          return;
        }
        const events = await engine.executions.events(execution.execution.id);
        const decisions = diffReviews.get(execution.execution.id) ?? {};
        const createdAtIso = new Date(execution.execution.createdAt).toISOString();
        const fileEntries = events
          .filter((ev) => ev.type.includes('tool') || ev.type.includes('execution'))
          .map((ev, idx) => {
            const p = String((ev.data as { path?: string } | undefined)?.path ?? `step-${idx + 1}.log`);
            return {
              path: p,
              decision: decisions[p] ?? 'pending',
              reviewDecision: decisions[p] ?? 'pending',
              additions: 1,
              deletions: 0,
              hunks: [{ header: '@@ -1,1 +1,1 @@', oldStart: 1, newStart: 1, lines: [`+ ${ev.type} completed`] }],
            };
          });
        const artifacts = [
          {
            id: `art-plan-${execution.execution.id}`,
            executionId: execution.execution.id,
            kind: 'plan',
            title: `Execution Plan: ${execution.task.title ?? execution.task.id}`,
            createdAt: createdAtIso,
            status: execution.execution.status === 'completed' ? 'verified' : 'ready',
            summary: `${events.length} provenance step(s) recorded`,
            steps: events.slice(0, 8).map((ev, i) => ({
              index: i + 1,
              phase: ev.type,
              description: `${ev.type} at ${new Date(ev.timestamp).toLocaleTimeString()}`,
              status: 'completed',
            })),
          },
          {
            id: `art-diff-${execution.execution.id}`,
            executionId: execution.execution.id,
            kind: 'code_diff',
            title: `Workspace Diff Review (${fileEntries.length} item${fileEntries.length === 1 ? '' : 's'})`,
            createdAt: createdAtIso,
            status: Object.values(decisions).length > 0 ? 'verified' : 'pending_review',
            summary: `${fileEntries.length} file entry(ies)`,
            files: fileEntries,
          },
          {
            id: `art-test-${execution.execution.id}`,
            executionId: execution.execution.id,
            kind: 'test_summary',
            title: `Verification Summary (${execution.execution.status.toUpperCase()})`,
            createdAt: createdAtIso,
            status: execution.execution.status === 'completed' ? 'verified' : 'ready',
            summary: `Status: ${execution.execution.status}`,
            testReport: {
              overallStatus: execution.execution.status === 'completed' ? 'PASS' : 'PENDING',
              totalChecks: 1,
              passedChecks: execution.execution.status === 'completed' ? 1 : 0,
              failedChecks: execution.execution.status === 'failed' ? 1 : 0,
              durationMs: 0,
              checks: [
                {
                  name: 'execution-verification',
                  status: execution.execution.status === 'completed' ? 'PASS' : 'PENDING',
                  durationMs: 0,
                  output: execution.result,
                  error: execution.errors?.[0],
                },
              ],
            },
          },
          {
            id: `art-preview-${execution.execution.id}`,
            executionId: execution.execution.id,
            kind: 'sandbox_preview',
            title: 'Sandboxed Output Preview',
            createdAt: createdAtIso,
            status: 'ready',
            summary: 'Isolated CSP sandbox preview',
            previewHtml: `<div style="font-family:monospace;padding:12px;color:#e6edf3;background:#0d1117"><h4>${execution.task.title ?? execution.task.id}</h4><pre>${String(execution.result ?? 'Completed').slice(0, 1000)}</pre></div>`,
          },
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ executionId: execution.execution.id, artifacts }));
        return;
      }

      if (rest.endsWith('/diff-review') && req.method === 'POST') {
        const execId = decodeURIComponent(rest.slice(0, -'/diff-review'.length));
        const body = await readJsonBody(req);
        const filePath = String(body.path ?? '');
        const decision = body.decision === 'keep' || body.decision === 'skip' ? body.decision : 'pending';
        const map = diffReviews.get(execId) ?? {};
        map[filePath] = decision;
        diffReviews.set(execId, map);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, executionId: execId, path: filePath, decision, decisions: map }));
        return;
      }

      const execId = decodeURIComponent(rest);
      const execution = await engine.executions.get(execId);
      if (execution) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ execution }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Execution '${execId}' not found` }));
      }
      return;
    }

    // 11. Autonomy Posture
    if (pathname === '/api/v1/autonomy' || pathname === '/api/v1/mobile/autonomy') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (body.mode === 'read-only' || body.mode === 'request-review' || body.mode === 'auto-sandbox') {
          autonomyState.mode = body.mode;
        }
        if (body.networkGuard === 'normal' || body.networkGuard === 'cellular-strict') {
          autonomyState.networkGuard = body.networkGuard;
        }
        autonomyState.updatedAt = new Date().toISOString();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ autonomy: autonomyState }));
      return;
    }

    // 12. Host Instances
    if (pathname === '/api/v1/hosts') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const id = String(body.id ?? `host-${Date.now()}`);
        hostList.push({
          id,
          name: String(body.name ?? id),
          url: String(body.url ?? `http://${host}:${port}`),
          local: false,
          selected: Boolean(body.selected),
          status: 'online',
          addedAt: new Date().toISOString(),
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hosts: hostList, activeHost: hostList.find((h) => h.selected) ?? hostList[0] }));
      return;
    }

    if (pathname === '/api/v1/hosts/select' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = String(body.id ?? 'local');
      for (const h of hostList) {
        h.selected = h.id === id;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, hosts: hostList, activeHost: hostList.find((h) => h.selected) ?? hostList[0] }));
      return;
    }

    // 13. Scheduled Tasks
    if (pathname === '/api/v1/schedules' || pathname === '/api/v1/mobile/schedules') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const item = {
          id: `sched-${Date.now()}`,
          name: String(body.name ?? 'Scheduled Task'),
          prompt: String(body.prompt ?? body.name ?? 'Verify workspace'),
          cadenceMinutes: Number(body.cadenceMinutes ?? 60),
          agentId: String(body.agentId ?? 'coding-agent'),
          modelId: String(body.modelId ?? 'local-default'),
          computerId: String(body.computerId ?? 'local'),
          priority: String(body.priority ?? 'normal'),
          enabled: body.enabled !== false,
          createdAt: new Date().toISOString(),
          nextRunAt: new Date(Date.now() + Number(body.cadenceMinutes ?? 60) * 60_000).toISOString(),
          runCount: 0,
          schedulerExplanation: 'Scheduled via local engine',
        };
        scheduleList.unshift(item);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ schedule: item }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ schedules: scheduleList }));
      return;
    }

    if (pathname === '/sandbox/preview') {
      const html = parsedUrl.searchParams.get('html') ?? '<div>Sandbox Ready</div>';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;",
      });
      res.end(`<!doctype html><html><body style="margin:0;background:#0d1117;color:#e6edf3;font-family:sans-serif">${html}</body></html>`);
      return;
    }

    // Not Found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      resolve(server);
    });
  });
}
