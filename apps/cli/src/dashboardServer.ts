import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import type { RookEngine } from './engine.js';
import { DASHBOARD_HTML_BASE64 } from './dashboardHtml.js';
import { color } from './colors.js';
import {
  GOAL_STUDIO_HTTP_STATUS,
  GoalStudioFailure,
  WORKFLOW_STORE_KEYS,
  compileWorkflow,
  createWorkflowRuntimeService,
  criticalPath,
  topologicalOrder,
  type GoalGraphDefinition,
  type GoalRunLedger,
  type GoalRunStatus,
  type GoalStudioErrorCode,
  type WorkflowCompileRequest,
  type WorkflowMode,
  type WorkflowOriginInterface,
  type WorkflowPlanRecord,
  type WorkflowRuntimeService,
} from '@wazir/goals';

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

function parseSimpleSshConfig(rawConfig: string): Array<{
  alias: string;
  hostName: string;
  user?: string;
  port: number;
  localForwardPort: number;
  remoteControllerPort: number;
  suggestedControllerUrl: string;
  sshTunnelCommand: string;
}> {
  const lines = String(rawConfig ?? '').split(/\r?\n/);
  interface RawBlock {
    aliases: string[];
    hostName?: string;
    user?: string;
    port?: number;
    localForwardPort?: number;
    remoteControllerPort?: number;
  }
  const blocks: RawBlock[] = [];
  let current: RawBlock | undefined;
  for (const rawLine of lines) {
    const stripped = rawLine.replace(/#.*$/, '').trim();
    if (!stripped) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=|\s+)\s*(.+)$/.exec(stripped);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const val = match[2].trim().replace(/^["']|["']$/g, '');
    if (key === 'host') {
      const aliases = val
        .split(/\s+/)
        .map((a) => a.trim())
        .filter((a) => a && !/[*?!]/.test(a));
      current = { aliases };
      if (aliases.length > 0) blocks.push(current);
      continue;
    }
    if (!current || current.aliases.length === 0) continue;
    if (key === 'hostname') current.hostName = val;
    else if (key === 'user') current.user = val;
    else if (key === 'port') current.port = Number(val) || 22;
    else if (key === 'localforward') {
      const lfMatch = /^(\d+)\s+[^:\s]+:(\d+)$/.exec(val);
      if (lfMatch) {
        current.localForwardPort = Number(lfMatch[1]);
        current.remoteControllerPort = Number(lfMatch[2]);
      }
    }
  }
  const profiles = [];
  let idx = 0;
  for (const block of blocks) {
    for (const alias of block.aliases) {
      const hostName = block.hostName || alias;
      const port = block.port ?? 22;
      const localForwardPort = block.localForwardPort ?? 14800 + idx;
      const remoteControllerPort = block.remoteControllerPort ?? 4800;
      const targetRef = block.user ? `${block.user}@${alias}` : alias;
      const portArg = port !== 22 ? ` -p ${port}` : '';
      profiles.push({
        alias,
        hostName,
        user: block.user,
        port,
        localForwardPort,
        remoteControllerPort,
        suggestedControllerUrl: `http://127.0.0.1:${localForwardPort}`,
        sshTunnelCommand: `ssh -N -L ${localForwardPort}:127.0.0.1:${remoteControllerPort}${portArg} ${targetRef}`,
      });
      idx += 1;
    }
  }
  return profiles;
}

const WORKFLOW_BASE = '/api/v1/goal-studio/workflows';
const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const WORKFLOW_RUN_STATUSES: readonly GoalRunStatus[] = [
  'created',
  'running',
  'pausing',
  'paused',
  'stopping',
  'stopped',
  'idle',
  'completed',
  'failed',
];
const WORKFLOW_MODES: readonly WorkflowMode[] = ['single', 'loop', 'graph', 'hybrid'];
const WORKFLOW_ORIGINS: readonly WorkflowOriginInterface[] = ['shell', 'cli', 'tui', 'api', 'web', 'desktop'];

function sendJsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendWorkflowError(res: http.ServerResponse, err: unknown): void {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && code in GOAL_STUDIO_HTTP_STATUS && err instanceof Error) {
    const c = code as GoalStudioErrorCode;
    const status = GOAL_STUDIO_HTTP_STATUS[c] ?? 500;
    const message = c === 'INTERNAL' ? 'internal error' : err.message;
    const details = c === 'INTERNAL' ? undefined : (err as { details?: Record<string, unknown> }).details;
    sendJsonResponse(res, status, { error: { code: c, message, ...(details ? { details } : {}) } });
    return;
  }
  sendJsonResponse(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
}

function parseWorkflowOptionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 1) {
    throw new GoalStudioFailure('VALIDATION', `${name} must be a positive number`);
  }
  return Math.floor(num);
}

function parseWorkflowOptionalNonNegNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new GoalStudioFailure('VALIDATION', `${name} must be a non-negative number`);
  }
  return num;
}

function parseWorkflowOptionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new GoalStudioFailure('VALIDATION', `${name} must be an array of strings`);
  }
  return value
    .map((item) => {
      if (typeof item !== 'string') {
        throw new GoalStudioFailure('VALIDATION', `${name} entries must be strings`);
      }
      return item.trim();
    })
    .filter(Boolean);
}

function parseWorkflowModeValue(value: unknown, fieldName: string): WorkflowMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !WORKFLOW_MODES.includes(value as WorkflowMode)) {
    throw new GoalStudioFailure('VALIDATION', `${fieldName} must be one of ${WORKFLOW_MODES.join(', ')}`);
  }
  return value as WorkflowMode;
}

function parseWorkflowCompilePayload(
  body: Record<string, unknown>,
  defaultWorkspaceRoot: string,
  forced?: { requestedMode?: WorkflowCompileRequest['requestedMode']; overrideMode?: WorkflowMode },
): WorkflowCompileRequest {
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw new GoalStudioFailure('VALIDATION', 'prompt is required');
  }
  const rawMode = body.requestedMode ?? body.mode;
  const parsedRequested =
    rawMode === undefined || rawMode === null || rawMode === ''
      ? undefined
      : rawMode === 'auto'
        ? 'auto'
        : parseWorkflowModeValue(rawMode, 'requestedMode');
  const requestedMode = forced?.requestedMode ?? parsedRequested;
  const overrideMode =
    forced && 'overrideMode' in forced ? forced.overrideMode : parseWorkflowModeValue(body.overrideMode, 'overrideMode');

  let originInterface: WorkflowOriginInterface = 'web';
  if (body.originInterface !== undefined && body.originInterface !== null && body.originInterface !== '') {
    if (typeof body.originInterface !== 'string' || !WORKFLOW_ORIGINS.includes(body.originInterface as WorkflowOriginInterface)) {
      throw new GoalStudioFailure('VALIDATION', `originInterface must be one of ${WORKFLOW_ORIGINS.join(', ')}`);
    }
    originInterface = body.originInterface as WorkflowOriginInterface;
  }

  const workspaceRoot =
    typeof body.workspaceRoot === 'string' && body.workspaceRoot.trim()
      ? body.workspaceRoot.trim()
      : defaultWorkspaceRoot;

  return {
    prompt: body.prompt.trim(),
    requestedMode,
    overrideMode,
    originInterface,
    workspaceRoot,
    projectId: typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : undefined,
    graphName: typeof body.graphName === 'string' && body.graphName.trim() ? body.graphName.trim() : undefined,
    actor: 'user:dashboard',
    maxIterations: parseWorkflowOptionalPositiveInt(body.maxIterations, 'maxIterations'),
    maxConcurrency: parseWorkflowOptionalPositiveInt(body.maxConcurrency, 'maxConcurrency'),
    maxDurationMinutes: parseWorkflowOptionalPositiveInt(body.maxDurationMinutes, 'maxDurationMinutes'),
    maxBudgetUsd: parseWorkflowOptionalNonNegNumber(body.maxBudgetUsd, 'maxBudgetUsd'),
    maxRepairsPerTask: parseWorkflowOptionalNonNegNumber(body.maxRepairsPerTask, 'maxRepairsPerTask'),
    maxSameActionNoProgress: parseWorkflowOptionalPositiveInt(body.maxSameActionNoProgress, 'maxSameActionNoProgress'),
    dryRun: body.dryRun === undefined ? undefined : Boolean(body.dryRun),
    approveAll: body.approveAll === undefined ? undefined : Boolean(body.approveAll),
    localModelFirst: body.localModelFirst === undefined ? undefined : Boolean(body.localModelFirst),
    preferredModel:
      typeof body.preferredModel === 'string' && body.preferredModel.trim() ? body.preferredModel.trim() : undefined,
    computer: typeof body.computer === 'string' && body.computer.trim() ? body.computer.trim() : undefined,
    items: parseWorkflowOptionalStringArray(body.items, 'items'),
    completionCondition:
      typeof body.completionCondition === 'string' && body.completionCondition.trim()
        ? body.completionCondition.trim()
        : undefined,
    allowProductionDeploy: body.allowProductionDeploy === undefined ? undefined : Boolean(body.allowProductionDeploy),
    verifyCommands: parseWorkflowOptionalStringArray(body.verifyCommands, 'verifyCommands'),
  };
}

function summarizeWorkflowTargets(
  definition: GoalGraphDefinition | undefined,
  run: GoalRunLedger | undefined,
): Array<{
  id: string;
  title: string;
  stage: string;
  status: string;
  dependsOn: string[];
  requiresApproval?: boolean;
}> {
  if (!definition?.targets) return [];
  return definition.targets.map((t) => ({
    id: t.id,
    title: t.title,
    stage: t.stage,
    status: run?.targets?.[t.id]?.status ?? 'queued',
    dependsOn: t.dependsOn,
    ...(t.requiresApproval ? { requiresApproval: true } : {}),
  }));
}

function resolvePublicAsset(relPath: string): string | undefined {
  const cleanRel = relPath.replace(/^\/+/, '');
  const roots = [
    path.resolve(process.cwd(), 'apps/web/public'),
    path.resolve(__dirname, '../../web/public'),
    path.resolve(__dirname, '../web/public'),
  ];
  for (const root of roots) {
    const candidate = path.resolve(root, cleanRel);
    const rel = path.relative(root, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return undefined;
}

async function handleWorkflowRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  parsedUrl: URL,
  engine: RookEngine,
  workflow: WorkflowRuntimeService | undefined,
  workspaceRoot: string,
): Promise<boolean> {
  if (pathname !== WORKFLOW_BASE && !pathname.startsWith(`${WORKFLOW_BASE}/`)) {
    return false;
  }
  if (!workflow) {
    sendJsonResponse(res, 503, { error: { code: 'INTERNAL', message: 'workflow service not configured' } });
    return true;
  }

  const subPath = pathname.slice(WORKFLOW_BASE.length);

  try {
    if (subPath === '/compile' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const compileReq = parseWorkflowCompilePayload(body, workspaceRoot);
      if (body.persist === true) {
        const compiled = await workflow.compile(compileReq);
        sendJsonResponse(res, 200, {
          persisted: true,
          mode: compiled.plan.mode,
          graph: compiled.graph,
          definition: compiled.graph.definition,
          validation: compiled.validation,
          plan: compiled.plan,
          explanation: compiled.plan.explanation,
          criticalPath: compiled.plan.criticalPath,
          topologicalOrder: compiled.plan.topologicalOrder,
          loop: compiled.plan.loop,
          nestedLoops: compiled.plan.nestedLoops,
        });
        return true;
      }
      const compiled = compileWorkflow(compileReq);
      sendJsonResponse(res, 200, {
        persisted: false,
        mode: compiled.plan.mode,
        definition: compiled.definition,
        validation: compiled.validation,
        plan: compiled.plan,
        explanation: compiled.plan.explanation,
        criticalPath: compiled.plan.criticalPath,
        topologicalOrder: compiled.plan.topologicalOrder,
        loop: compiled.plan.loop,
        nestedLoops: compiled.plan.nestedLoops,
      });
      return true;
    }

    if ((subPath === '/loop' || subPath === '/graph' || subPath === '/goal') && req.method === 'POST') {
      const body = await readJsonBody(req);
      const forced =
        subPath === '/loop'
          ? { requestedMode: 'loop' as const, overrideMode: undefined }
          : subPath === '/graph'
            ? { requestedMode: 'graph' as const, overrideMode: undefined }
            : { requestedMode: 'auto' as const, overrideMode: parseWorkflowModeValue(body.overrideMode, 'overrideMode') };
      const compileReq = parseWorkflowCompilePayload(body, workspaceRoot, forced);

      if (body.wait === true) {
        const executed = await workflow.executeToCompletion(compileReq);
        const summary = await workflow.getStatus(executed.run.runId);
        const graph = await workflow.graphs.getRevision(executed.run.graphId, executed.run.graphRevision).catch(() => undefined);
        sendJsonResponse(res, 201, {
          run: executed.run,
          plan: executed.plan,
          graph,
          evidence: executed.evidence,
          explanation: executed.plan.explanation,
          criticalPath: executed.plan.criticalPath,
          topologicalOrder: executed.plan.topologicalOrder,
          loop: executed.plan.loop,
          summary,
        });
        return true;
      }

      const started = await workflow.start(compileReq);
      const summary = await workflow.getStatus(started.run.runId);
      sendJsonResponse(res, 201, {
        run: started.run,
        plan: started.plan,
        graph: started.graph,
        explanation: started.plan.explanation,
        criticalPath: started.plan.criticalPath,
        topologicalOrder: started.plan.topologicalOrder,
        loop: started.plan.loop,
        summary,
      });
      return true;
    }

    if (subPath === '/jobs' && req.method === 'GET') {
      const statusRaw = parsedUrl.searchParams.get('status')?.trim() || undefined;
      if (statusRaw !== undefined && !WORKFLOW_RUN_STATUSES.includes(statusRaw as GoalRunStatus)) {
        throw new GoalStudioFailure('VALIDATION', `status must be one of ${WORKFLOW_RUN_STATUSES.join(', ')}`);
      }
      const modeRaw = parsedUrl.searchParams.get('mode')?.trim() || undefined;
      const mode = parseWorkflowModeValue(modeRaw, 'mode');
      const projectId = parsedUrl.searchParams.get('projectId')?.trim() || undefined;

      const jobs = await workflow.listJobs({
        status: statusRaw as GoalRunStatus | undefined,
        mode,
        projectId,
      });

      const enriched = await Promise.all(
        jobs.map(async (job) => {
          const [plan, run, graph] = await Promise.all([
            engine.store.get<WorkflowPlanRecord>(WORKFLOW_STORE_KEYS.run(job.runId)).catch(() => undefined),
            workflow.ledger.getRun(job.runId).catch(() => undefined),
            workflow.graphs.getRevision(job.graphId, job.graphRevision).catch(() => undefined),
          ]);
          const cp =
            plan?.criticalPath ??
            (graph?.definition
              ? (() => {
                  const c = criticalPath(graph.definition);
                  return { targets: c.path, depth: c.path.length };
                })()
              : undefined);
          return {
            ...job,
            ...(cp ? { criticalPath: cp } : {}),
            ...(plan?.loop
              ? {
                  loop: {
                    kind: plan.loop.kind,
                    cursor: job.progress.cursor ?? plan.loop.cursor,
                    total: plan.loop.items.length,
                    maxIterations: plan.loop.maxIterations,
                    maxConcurrency: plan.loop.maxConcurrency,
                    completionPredicate: plan.loop.completionPredicate,
                  },
                }
              : {}),
            ...(plan?.explanation ? { explanation: plan.explanation } : {}),
            targets: summarizeWorkflowTargets(graph?.definition, run),
          };
        }),
      );

      sendJsonResponse(res, 200, { jobs: enriched, count: enriched.length });
      return true;
    }

    const parts = subPath.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
    if (parts.length === 1 && req.method === 'GET') {
      const runId = parts[0]!;
      if (!WORKFLOW_ID_PATTERN.test(runId)) {
        throw new GoalStudioFailure('VALIDATION', 'invalid runId');
      }
      const inspection = await workflow.inspect(runId);
      if (!inspection) {
        throw new GoalStudioFailure('NOT_FOUND', `workflow run '${runId}' not found`);
      }
      const cp =
        inspection.plan?.criticalPath ??
        (() => {
          const resCp = criticalPath(inspection.graph.definition);
          return { targets: resCp.path, depth: resCp.path.length };
        })();
      const topo = inspection.plan?.topologicalOrder ?? topologicalOrder(inspection.graph.definition);
      sendJsonResponse(res, 200, {
        summary: inspection.summary,
        run: inspection.run,
        graph: inspection.graph,
        plan: inspection.plan,
        targets: inspection.targets,
        criticalPath: cp,
        topologicalOrder: topo,
        loop: inspection.plan?.loop,
        nestedLoops: inspection.plan?.nestedLoops,
        explanation: inspection.plan?.explanation,
        evidence: inspection.evidence,
        events: inspection.events,
      });
      return true;
    }

    if (parts.length === 2 && req.method === 'POST') {
      const [runId, action] = parts as [string, string];
      if (!WORKFLOW_ID_PATTERN.test(runId)) {
        throw new GoalStudioFailure('VALIDATION', 'invalid runId');
      }
      const body = await readJsonBody(req);
      const actor = 'user:dashboard';

      if (action === 'pause') {
        const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
        const run = await workflow.pause(runId, actor, reason);
        sendJsonResponse(res, 200, { run, summary: await workflow.getStatus(runId) });
        return true;
      }
      if (action === 'resume') {
        const run = await workflow.resume(runId, actor, { wait: body.wait === true });
        sendJsonResponse(res, 200, { run, summary: await workflow.getStatus(runId) });
        return true;
      }
      if (action === 'stop') {
        const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
        const run = await workflow.stop(runId, actor, reason);
        sendJsonResponse(res, 200, { run, summary: await workflow.getStatus(runId) });
        return true;
      }
      if (action === 'approve') {
        const note =
          typeof body.note === 'string' && body.note.trim()
            ? body.note.trim()
            : typeof body.reason === 'string' && body.reason.trim()
              ? body.reason.trim()
              : undefined;
        let targetId = typeof body.targetId === 'string' && body.targetId.trim() ? body.targetId.trim() : undefined;
        if (!targetId) {
          const existingRun = await workflow.ledger.getRun(runId);
          if (!existingRun) {
            throw new GoalStudioFailure('NOT_FOUND', `workflow run '${runId}' not found`);
          }
          const pendingTarget = Object.values(existingRun.targets).find((t) => t.status === 'needs_approval');
          if (!pendingTarget) {
            throw new GoalStudioFailure('VALIDATION', 'targetId is required');
          }
          targetId = pendingTarget.targetId;
        }
        const run = await workflow.approve(runId, targetId, actor, note);
        sendJsonResponse(res, 200, { run, summary: await workflow.getStatus(runId) });
        return true;
      }
    }

    sendJsonResponse(res, 404, { error: { code: 'NOT_FOUND', message: 'Workflow endpoint not found' } });
    return true;
  } catch (err) {
    sendWorkflowError(res, err);
    return true;
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
  const workflowWorkspaceRoot = engine.projectRoot || process.cwd();
  const workflowService: WorkflowRuntimeService | undefined = engine.store
    ? createWorkflowRuntimeService({
        store: engine.store,
        workspaceRoot: workflowWorkspaceRoot,
      })
    : undefined;

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const expectedOrigin = req.headers.host ? `http://${req.headers.host}` : `http://${host}:${port}`;
    if (origin && origin !== expectedOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cross-origin request refused' }));
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin ?? expectedOrigin);
    res.setHeader('Vary', 'Origin');
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
    if (upstreamApi && (pathname.startsWith('/api/') || pathname === '/health' || pathname === '/ready')) {
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

    if (pathname === '/mission-control' || pathname === '/mission-control.html') {
      const filePath = resolvePublicAsset('mission-control.html');
      if (filePath) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(fs.readFileSync(filePath, 'utf8'));
        return;
      }
    }

    if (pathname === '/goal-studio' || pathname === '/goal-studio/' || pathname.startsWith('/goal-studio/')) {
      const rel = pathname === '/goal-studio' || pathname === '/goal-studio/' ? 'goal-studio/index.html' : pathname.slice(1);
      const filePath = resolvePublicAsset(rel);
      if (filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const mime =
          ext === '.html'
            ? 'text/html; charset=utf-8'
            : ext === '.js'
              ? 'text/javascript; charset=utf-8'
              : ext === '.css'
                ? 'text/css; charset=utf-8'
                : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
        res.end(fs.readFileSync(filePath));
        return;
      }
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

    // 2. Health & Readiness Endpoints
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    if (pathname === '/ready') {
      const runtimes = engine.runtimes.list();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ready',
          timestamp: new Date().toISOString(),
          checks: {
            processLiveness: 'ok',
            apiReadiness: 'ok',
            executionService: 'ok',
            providersAvailable: runtimes.length,
            remoteHost: 'local',
          },
        }),
      );
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

    // 6. API v1 Runtimes & Providers
    if (pathname === '/api/v1/runtimes') {
      const runtimes = engine.runtimes.list().map((r) => {
        const disc = engine.discovered.find((d) => d.id === r.id);
        const hostedModels = engine.models.list().filter((m) => m.provider === r.id);
        return {
          ...r,
          health: disc?.health ?? r.health ?? 'available',
          healthMessage: disc?.healthMessage,
          models: disc?.models ?? hostedModels,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ runtimes }));
      return;
    }

    if (pathname === '/api/v1/providers') {
      const { collectProvidersSummary } = await import('./commands.js');
      const providers = await collectProvidersSummary(engine);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ providers }));
      return;
    }

    if (pathname.startsWith('/api/v1/providers/')) {
      const providerId = decodeURIComponent(pathname.slice('/api/v1/providers/'.length));
      const { collectProvidersSummary } = await import('./commands.js');
      const providers = await collectProvidersSummary(engine);
      const found = providers.find((p) => p.id.toLowerCase() === providerId.toLowerCase());
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Provider '${providerId}' not found` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ provider: found }));
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

    if (pathname === '/api/v1/hosts/ssh-config' && req.method === 'GET') {
      const configPath = parsedUrl.searchParams.get('configPath') || path.join(os.homedir(), '.ssh', 'config');
      let rawText = '';
      if (fs.existsSync(configPath)) {
        try {
          rawText = fs.readFileSync(configPath, 'utf8');
        } catch {
          rawText = '';
        }
      }
      const profiles = parseSimpleSshConfig(rawText);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configPath, profiles }));
      return;
    }

    if (pathname === '/api/v1/hosts/import-ssh' && req.method === 'POST') {
      const body = await readJsonBody(req);
      let rawText = typeof body.configText === 'string' ? body.configText : '';
      const configPath = typeof body.configPath === 'string' ? body.configPath : path.join(os.homedir(), '.ssh', 'config');
      if (!rawText && fs.existsSync(configPath)) {
        try {
          rawText = fs.readFileSync(configPath, 'utf8');
        } catch {
          rawText = '';
        }
      }
      const profiles = parseSimpleSshConfig(rawText);
      const imported: Array<Record<string, unknown>> = [];
      for (const p of profiles) {
        const id = `ssh-${p.alias.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
        const existingIdx = hostList.findIndex((h) => h.id === id);
        const hostEntry = {
          id,
          name: `SSH: ${p.alias} (${p.user ? `${p.user}@` : ''}${p.hostName})`,
          url: p.suggestedControllerUrl,
          local: false,
          selected: false,
          status: 'online',
          addedAt: new Date().toISOString(),
          sshAlias: p.alias,
          sshTunnelCommand: p.sshTunnelCommand,
        };
        if (existingIdx >= 0) {
          hostList[existingIdx] = hostEntry;
        } else {
          hostList.push(hostEntry);
        }
        imported.push(hostEntry);
      }
      res.writeHead(imported.length > 0 ? 201 : 200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          imported,
          profiles,
          hosts: hostList,
          activeHost: hostList.find((h) => h.selected) ?? hostList[0],
        }),
      );
      return;
    }

    if (pathname === '/api/v1/hosts/select' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = String(body.id ?? body.hostId ?? 'local');
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

    // 14. Cloud Push Relay Status & Registration
    if (pathname === '/api/v1/push/status' || pathname === '/api/v1/mobile/push/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ registrations: [], recentWakeups: [] }));
      return;
    }

    if (pathname === '/api/v1/sandbox/preview' || pathname === '/sandbox/preview') {
      const html = parsedUrl.searchParams.get('html') ?? '<div>Sandbox Ready</div>';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;",
      });
      res.end(`<!doctype html><html><body style="margin:0;background:#0d1117;color:#e6edf3;font-family:sans-serif">${html}</body></html>`);
      return;
    }

    if (await handleWorkflowRoute(req, res, pathname, parsedUrl, engine, workflowService, workflowWorkspaceRoot)) {
      return;
    }

    // Not Found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  });

  if (workflowService) {
    server.on('close', () => {
      void workflowService.shutdown({ releaseLeases: true }).catch(() => undefined);
    });
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      resolve(server);
    });
  });
}
