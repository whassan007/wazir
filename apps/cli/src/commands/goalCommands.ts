import { promises as fs } from 'node:fs';
import { Command } from 'commander';
import { color } from '../colors.js';
import { table } from './formatters.js';

export interface GoalCliConfig {
  controllerUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface GoalCommandResult {
  code: number;
  output: string;
  data?: unknown;
}

const GOAL_STUDIO_BASE = '/api/v1/goal-studio';

export function resolveGoalCliConfig(opts: { url?: string; token?: string; fetchImpl?: typeof fetch } = {}): GoalCliConfig {
  const controllerUrl = (
    opts.url ??
    process.env.WAZIR_CONTROLLER_URL ??
    process.env.WAZIR_API_URL ??
    `http://${process.env.WAZIR_HOST ?? '127.0.0.1'}:${process.env.PORT ?? '4800'}`
  ).replace(/\/+$/, '');
  const token = opts.token ?? process.env.WAZIR_API_TOKEN ?? process.env.WAZIR_API_VIEWER_TOKEN;
  return { controllerUrl, token, fetchImpl: opts.fetchImpl ?? fetch };
}

async function goalApiRequest<T>(
  config: GoalCliConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; ok: boolean; data: T }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const fetchFn = config.fetchImpl ?? fetch;
  const response = await fetchFn(`${config.controllerUrl}${GOAL_STUDIO_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, ok: response.ok, data: parsed as T };
}

function formatError(res: { status: number; data: unknown }, json?: boolean): GoalCommandResult {
  const errObj = (res.data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
  const code = errObj?.code ?? `HTTP_${res.status}`;
  const message = errObj?.message ?? `Request failed with status ${res.status}`;
  if (json) {
    return { code: 1, output: JSON.stringify({ ok: false, status: res.status, error: { code, message, details: errObj?.details } }, null, 2), data: res.data };
  }
  return { code: 1, output: color.red(`[${code}] ${message}`), data: res.data };
}

export async function goalImportCommand(
  filePath: string,
  options: { project?: string; json?: boolean; url?: string; token?: string; fetchImpl?: typeof fetch; yamlContent?: string } = {},
): Promise<GoalCommandResult> {
  const config = resolveGoalCliConfig(options);
  const projectId = options.project ?? 'default';
  const yaml = options.yamlContent ?? await fs.readFile(filePath, 'utf-8');
  const res = await goalApiRequest<{
    record?: { graphId: string; projectId: string; revision: number; digest: string };
    graph?: { graphId: string; projectId: string; revision: number; digest: string };
    validation?: { valid: boolean; issues: Array<{ code: string; message: string }> };
  }>(config, 'POST', '/graphs/import', { projectId, yaml });

  if (!res.ok) return formatError(res, options.json);
  const record = res.data.record ?? res.data.graph;
  if (options.json) {
    return { code: 0, output: JSON.stringify(res.data, null, 2), data: res.data };
  }
  return {
    code: 0,
    output: [
      color.bold('Goal Graph Imported'),
      `  graphId:   ${record?.graphId ?? 'unknown'}`,
      `  project:   ${record?.projectId ?? projectId}`,
      `  revision:  ${record?.revision ?? 1}`,
      `  digest:    ${record?.digest ?? '-'}`,
    ].join('\n'),
    data: res.data,
  };
}

export async function goalListCommand(
  options: { graph?: string; status?: string; graphs?: boolean; project?: string; json?: boolean; url?: string; token?: string; fetchImpl?: typeof fetch } = {},
): Promise<GoalCommandResult> {
  const config = resolveGoalCliConfig(options);
  if (options.graphs) {
    const query = options.project ? `?projectId=${encodeURIComponent(options.project)}` : '';
    const res = await goalApiRequest<{ graphs?: Array<{ graphId: string; projectId: string; name: string; latestRevision: number }> }>(
      config,
      'GET',
      `/graphs${query}`,
    );
    if (!res.ok) return formatError(res, options.json);
    const graphs = res.data.graphs ?? [];
    if (options.json) return { code: 0, output: JSON.stringify({ graphs }, null, 2), data: res.data };
    if (graphs.length === 0) return { code: 0, output: 'No goal graphs found.', data: res.data };
    return {
      code: 0,
      output: table(
        ['GRAPH ID', 'PROJECT', 'NAME', 'LATEST REV'],
        graphs.map((g) => [g.graphId, g.projectId, g.name, String(g.latestRevision)]),
      ),
      data: res.data,
    };
  }

  const params = new URLSearchParams();
  if (options.graph) params.set('graphId', options.graph);
  if (options.status) params.set('status', options.status);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await goalApiRequest<{
    runs?: Array<{
      runId: string;
      graphId: string;
      graphRevision: number;
      status: string;
      ledgerRevision: number;
      createdAt: string;
      targetCounts?: Record<string, number>;
    }>;
  }>(config, 'GET', `/runs${qs}`);

  if (!res.ok) return formatError(res, options.json);
  const runs = res.data.runs ?? [];
  if (options.json) return { code: 0, output: JSON.stringify({ runs }, null, 2), data: res.data };
  if (runs.length === 0) return { code: 0, output: 'No goal runs found.', data: res.data };
  return {
    code: 0,
    output: table(
      ['RUN ID', 'GRAPH', 'REV', 'STATUS', 'LEDGER', 'TARGETS', 'CREATED'],
      runs.map((r) => [
        r.runId,
        r.graphId,
        String(r.graphRevision),
        r.status,
        String(r.ledgerRevision),
        Object.entries(r.targetCounts ?? {}).map(([k, v]) => `${k}:${v}`).join(',') || '-',
        r.createdAt,
      ]),
    ),
    data: res.data,
  };
}

export async function goalStartCommand(
  graphId: string,
  options: { revision?: number; json?: boolean; url?: string; token?: string; fetchImpl?: typeof fetch } = {},
): Promise<GoalCommandResult> {
  const config = resolveGoalCliConfig(options);
  const body: { graphId: string; graphRevision?: number } = { graphId };
  if (options.revision !== undefined) body.graphRevision = Number(options.revision);
  const res = await goalApiRequest<{ run: { runId: string; graphId: string; graphRevision: number; status: string; ledgerRevision: number } }>(
    config,
    'POST',
    '/runs',
    body,
  );
  if (!res.ok) return formatError(res, options.json);
  const run = res.data.run;
  if (options.json) return { code: 0, output: JSON.stringify(res.data, null, 2), data: res.data };
  return {
    code: 0,
    output: [
      color.bold(`Goal Run Started: ${run.runId}`),
      `  graph:     ${run.graphId}@${run.graphRevision}`,
      `  status:    ${run.status}`,
      `  revision:  ${run.ledgerRevision}`,
    ].join('\n'),
    data: res.data,
  };
}

export async function goalStatusCommand(
  runId: string,
  options: { json?: boolean; url?: string; token?: string; fetchImpl?: typeof fetch } = {},
): Promise<GoalCommandResult> {
  const config = resolveGoalCliConfig(options);
  const res = await goalApiRequest<{
    run: {
      runId: string;
      graphId: string;
      graphRevision: number;
      status: string;
      ledgerRevision: number;
      resource?: { tasksStarted: number; hostedSpendUsd: number };
      targets?: Record<string, { targetId: string; status: string; attempts: number; repairs: number; evidenceIds: string[]; blockers: string[] }>;
    };
  }>(config, 'GET', `/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) return formatError(res, options.json);
  const run = res.data.run;
  if (options.json) return { code: 0, output: JSON.stringify(res.data, null, 2), data: res.data };
  const targets = Object.values(run.targets ?? {});
  const lines = [
    color.bold(`Goal Run ${run.runId}`),
    `  graph:     ${run.graphId}@${run.graphRevision}`,
    `  status:    ${run.status}`,
    `  ledger:    rev ${run.ledgerRevision}`,
    `  tasks:     ${run.resource?.tasksStarted ?? 0}`,
    `  spend:     $${Number(run.resource?.hostedSpendUsd ?? 0).toFixed(2)}`,
    '',
    targets.length === 0
      ? '  No targets.'
      : table(
          ['TARGET', 'STATUS', 'ATTEMPTS', 'REPAIRS', 'EVIDENCE', 'BLOCKERS'],
          targets.map((t) => [
            t.targetId,
            t.status,
            String(t.attempts),
            String(t.repairs),
            String((t.evidenceIds ?? []).length),
            (t.blockers ?? []).join(';') || '-',
          ]),
        ),
  ];
  return { code: 0, output: lines.join('\n'), data: res.data };
}

export async function goalLifecycleCommand(
  action: 'pause' | 'resume' | 'stop',
  runId: string,
  options: { json?: boolean; url?: string; token?: string; fetchImpl?: typeof fetch } = {},
): Promise<GoalCommandResult> {
  const config = resolveGoalCliConfig(options);
  const res = await goalApiRequest<{ run: { runId: string; status: string; ledgerRevision: number } }>(
    config,
    'POST',
    `/runs/${encodeURIComponent(runId)}/${action}`,
  );
  if (!res.ok) return formatError(res, options.json);
  if (options.json) return { code: 0, output: JSON.stringify(res.data, null, 2), data: res.data };
  return {
    code: 0,
    output: `Run ${res.data.run.runId} -> ${res.data.run.status} (ledger rev ${res.data.run.ledgerRevision})`,
    data: res.data,
  };
}

export async function goalRetryCommand(
  runId: string,
  targetId: string,
  options: { eligible?: boolean; json?: boolean; url?: string; token?: string; fetchImpl?: typeof fetch } = {},
): Promise<GoalCommandResult> {
  const config = resolveGoalCliConfig(options);
  const segment = options.eligible ? 'run' : 'retry';
  const res = await goalApiRequest<{ run: { runId: string; status: string; targets?: Record<string, { status: string }> } }>(
    config,
    'POST',
    `/runs/${encodeURIComponent(runId)}/targets/${encodeURIComponent(targetId)}/${segment}`,
  );
  if (!res.ok) return formatError(res, options.json);
  if (options.json) return { code: 0, output: JSON.stringify(res.data, null, 2), data: res.data };
  const targetStatus = res.data.run.targets?.[targetId]?.status ?? 'updated';
  return {
    code: 0,
    output: `Target ${targetId} in run ${runId} -> ${targetStatus}`,
    data: res.data,
  };
}

export async function goalResolveApprovalCommand(
  decision: 'approve' | 'reject',
  approvalId: string,
  options: {
    run?: string;
    target?: string;
    attempt?: number;
    action?: string;
    reason?: string;
    json?: boolean;
    url?: string;
    token?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<GoalCommandResult> {
  const config = resolveGoalCliConfig(options);
  const body: Record<string, unknown> = {
    decision: decision === 'approve' ? 'approve' : 'deny',
  };
  if (options.run) body.runId = options.run;
  if (options.target) body.targetId = options.target;
  if (options.attempt !== undefined && Number.isInteger(Number(options.attempt))) body.attempt = Number(options.attempt);
  if (options.action) body.action = options.action;
  if (options.reason) body.reason = options.reason;

  const path = options.run
    ? `/runs/${encodeURIComponent(options.run)}/approvals/${encodeURIComponent(approvalId)}/resolve`
    : `/approvals/${encodeURIComponent(approvalId)}/${decision === 'approve' ? 'approve' : 'deny'}`;

  const res = await goalApiRequest<{ approval: { id: string; status: string; resolvedBy?: string; resolutionReason?: string } }>(
    config,
    'POST',
    path,
    body,
  );
  if (!res.ok) return formatError(res, options.json);
  if (options.json) return { code: 0, output: JSON.stringify(res.data, null, 2), data: res.data };
  const appr = res.data.approval;
  return {
    code: 0,
    output: `Approval ${appr.id} -> ${appr.status}${appr.resolutionReason ? ` (${appr.resolutionReason})` : ''}`,
    data: res.data,
  };
}

export function registerGoalCommands(program: Command): Command {
  const goal = program
    .command('goal')
    .description('Goal Studio execution control center commands');

  goal
    .command('import <file>')
    .description('Import a Goal Studio YAML graph definition')
    .option('-p, --project <projectId>', 'Project ID', 'default')
    .option('--url <url>', 'Controller base URL')
    .option('--token <token>', 'Operator API token')
    .option('-j, --json', 'Output JSON')
    .action(async (file: string, opts) => {
      const res = await goalImportCommand(file, opts);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  goal
    .command('list')
    .description('List Goal Studio runs (or graphs with --graphs)')
    .option('-g, --graph <graphId>', 'Filter runs by graph ID')
    .option('-s, --status <status>', 'Filter runs by status')
    .option('--graphs', 'List goal graphs instead of runs')
    .option('-p, --project <projectId>', 'Filter graphs by project ID')
    .option('--url <url>', 'Controller base URL')
    .option('--token <token>', 'API token')
    .option('-j, --json', 'Output JSON')
    .action(async (opts) => {
      const res = await goalListCommand(opts);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  goal
    .command('start <graphId>')
    .description('Start a new controller run for a goal graph')
    .option('-r, --revision <revision>', 'Pin specific graph revision', (v) => parseInt(v, 10))
    .option('--url <url>', 'Controller base URL')
    .option('--token <token>', 'Operator API token')
    .option('-j, --json', 'Output JSON')
    .action(async (graphId: string, opts) => {
      const res = await goalStartCommand(graphId, opts);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  goal
    .command('status <runId>')
    .description('Inspect durable run ledger and per-target statuses')
    .option('--url <url>', 'Controller base URL')
    .option('--token <token>', 'API token')
    .option('-j, --json', 'Output JSON')
    .action(async (runId: string, opts) => {
      const res = await goalStatusCommand(runId, opts);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  for (const action of ['pause', 'resume', 'stop'] as const) {
    goal
      .command(`${action} <runId>`)
      .description(`${action[0].toUpperCase() + action.slice(1)} a Goal Studio run`)
      .option('--url <url>', 'Controller base URL')
      .option('--token <token>', 'Operator API token')
      .option('-j, --json', 'Output JSON')
      .action(async (runId: string, opts) => {
        const res = await goalLifecycleCommand(action, runId, opts);
        console.log(res.output);
        if (res.code !== 0) process.exitCode = res.code;
      });
  }

  goal
    .command('retry <runId> <targetId>')
    .description('Retry a failed/blocked target (or pass --eligible to run an eligible target)')
    .option('--eligible', 'Run an eligible target instead of retrying a failed target')
    .option('--url <url>', 'Controller base URL')
    .option('--token <token>', 'Operator API token')
    .option('-j, --json', 'Output JSON')
    .action(async (runId: string, targetId: string, opts) => {
      const res = await goalRetryCommand(runId, targetId, opts);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  goal
    .command('approve <approvalId>')
    .description('Approve a pending scope-bound Goal Studio approval request')
    .option('-r, --run <runId>', 'Expected run ID scope')
    .option('-t, --target <targetId>', 'Expected target ID scope')
    .option('-a, --attempt <attempt>', 'Expected attempt number scope', (v) => parseInt(v, 10))
    .option('--action <action>', 'Expected action scope')
    .option('-m, --reason <reason>', 'Approval note/reason')
    .option('--url <url>', 'Controller base URL')
    .option('--token <token>', 'Operator API token')
    .option('-j, --json', 'Output JSON')
    .action(async (approvalId: string, opts) => {
      const res = await goalResolveApprovalCommand('approve', approvalId, opts);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  goal
    .command('reject <approvalId>')
    .description('Reject/deny a pending scope-bound Goal Studio approval request')
    .option('-r, --run <runId>', 'Expected run ID scope')
    .option('-t, --target <targetId>', 'Expected target ID scope')
    .option('-a, --attempt <attempt>', 'Expected attempt number scope', (v) => parseInt(v, 10))
    .option('--action <action>', 'Expected action scope')
    .option('-m, --reason <reason>', 'Rejection reason')
    .option('--url <url>', 'Controller base URL')
    .option('--token <token>', 'Operator API token')
    .option('-j, --json', 'Output JSON')
    .action(async (approvalId: string, opts) => {
      const res = await goalResolveApprovalCommand('reject', approvalId, opts);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  return goal;
}
