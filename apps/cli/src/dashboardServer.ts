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

  const server = http.createServer(async (req, res) => {
    // CORS headers for local developer tooling
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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

    // 1. Dashboard UI
    if (pathname === '/' || pathname === '/index.html') {
      const html = getDashboardHtml();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(html);
      return;
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
      const execId = decodeURIComponent(pathname.slice('/api/v1/executions/'.length));
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
