import { promises as fs } from 'node:fs';
import path from 'node:path';
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
  action: 'pause' | 'resume' | 'stop' | 'cancel',
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

export async function goalCancelCommand(
  runId: string,
  options: { json?: boolean; url?: string; token?: string; fetchImpl?: typeof fetch } = {},
): Promise<GoalCommandResult> {
  return goalLifecycleCommand('cancel', runId, options);
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

export async function goalCreateCommand(
  name: string,
  options: {
    objective?: string;
    project?: string;
    target?: string[];
    json?: boolean;
    url?: string;
    token?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<GoalCommandResult> {
  const config = resolveGoalCliConfig(options);
  const projectId = options.project ?? 'default';
  const objective = options.objective ?? name;
  const rawTargets = options.target;
  const targetArray = Array.isArray(rawTargets)
    ? rawTargets
    : typeof rawTargets === 'string'
      ? [rawTargets]
      : undefined;
  const targets = targetArray && targetArray.length > 0
    ? targetArray.map((t, i) => ({ id: `T${i + 1}`, title: t }))
    : undefined;

  const body: {
    projectId: string;
    name: string;
    objective: string;
    targets?: Array<{ id: string; title: string }>;
  } = {
    projectId,
    name,
    objective,
    ...(targets ? { targets } : {}),
  };

  const res = await goalApiRequest<{
    record?: { graphId: string; projectId: string; revision: number; digest: string };
    graph?: { graphId: string; projectId: string; revision: number; digest: string };
    validation?: unknown;
  }>(config, 'POST', '/graphs/create', body);

  if (!res.ok) return formatError(res, options.json);
  const record = res.data.record ?? res.data.graph;
  if (options.json) {
    return { code: 0, output: JSON.stringify(res.data, null, 2), data: res.data };
  }
  return {
    code: 0,
    output: [
      color.bold('Goal Graph Created'),
      `  graphId:   ${record?.graphId ?? 'unknown'}`,
      `  project:   ${record?.projectId ?? projectId}`,
      `  revision:  ${record?.revision ?? 1}`,
      `  digest:    ${record?.digest ?? '-'}`,
    ].join('\n'),
    data: res.data,
  };
}

export async function goalInspectCommand(
  graphId: string,
  options: {
    revision?: number;
    json?: boolean;
    url?: string;
    token?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<GoalCommandResult> {
  const config = resolveGoalCliConfig(options);
  const graphPath = `/graphs/${encodeURIComponent(graphId)}${options.revision !== undefined ? `/revisions/${options.revision}` : ''}`;
  const critPath = `/graphs/${encodeURIComponent(graphId)}/critical-path${options.revision !== undefined ? `?revision=${options.revision}` : ''}`;

  const [graphRes, critRes] = await Promise.all([
    goalApiRequest<{
      record?: {
        graphId: string;
        projectId?: string;
        revision: number;
        digest: string;
        name?: string;
        objective?: string;
        definition?: {
          name?: string;
          objective?: string;
          purpose?: string;
          targets?: any;
        };
        targets?: any;
      };
      graph?: any;
    }>(config, 'GET', graphPath),
    goalApiRequest<{
      graphId: string;
      revision: number;
      digest?: string;
      path?: string[];
      weight?: number;
      order?: string[];
    }>(config, 'GET', critPath),
  ]);

  if (!graphRes.ok) return formatError(graphRes, options.json);
  if (!critRes.ok) return formatError(critRes, options.json);

  const record = graphRes.data.record ?? graphRes.data.graph ?? graphRes.data;
  const def = record?.definition ?? {};
  const name = def.name ?? record?.name ?? record?.graphId ?? graphId;
  const objective = def.objective ?? def.purpose ?? record?.objective ?? '-';
  const pathArr = critRes.data?.path ?? [];
  const critPathStr = pathArr.length > 0 ? pathArr.join(' -> ') : '-';

  const rawTargets = def.targets ?? record?.targets ?? [];
  const targetList: Array<any> = Array.isArray(rawTargets)
    ? rawTargets
    : (typeof rawTargets === 'object' && rawTargets !== null)
      ? Object.entries(rawTargets).map(([id, val]: [string, any]) => ({ id, ...(typeof val === 'object' ? val : {}) }))
      : [];

  const rows = targetList.map((t) => {
    const id = t.id ?? t.targetId ?? '-';
    const stage = t.stage ?? '-';
    const priority = t.priority !== undefined ? String(t.priority) : '-';
    const executor = t.executor ?? '-';
    const deps = t.dependsOn ?? t.depends_on ?? [];
    const depsStr = Array.isArray(deps) ? (deps.join(',') || '-') : String(deps || '-');
    const app = t.requiresApproval ?? t.requires_approval ?? t.approval;
    const approvalStr = typeof app === 'string' ? app : (app ? 'yes' : 'no');
    const ext = t.external ?? t.external_dependency ?? t.externalDependency;
    const externalStr = typeof ext === 'string' ? ext : (ext ? 'yes' : 'no');
    const title = t.title ?? t.name ?? '-';
    return [id, stage, priority, executor, depsStr, approvalStr, externalStr, title];
  });

  const combinedData = {
    ...graphRes.data,
    record,
    criticalPath: critRes.data,
  };

  if (options.json) {
    return { code: 0, output: JSON.stringify(combinedData, null, 2), data: combinedData };
  }

  const lines = [
    color.bold(`Goal Graph: ${record?.graphId ?? graphId}`),
    `  graphId:       ${record?.graphId ?? graphId}`,
    `  name:          ${name}`,
    `  revision:      ${record?.revision ?? options.revision ?? 1}`,
    `  digest:        ${record?.digest ?? '-'}`,
    `  objective:     ${objective}`,
    `  critical path: ${critPathStr}`,
    '',
  ];

  if (rows.length === 0) {
    lines.push('  No targets.');
  } else {
    lines.push(table(
      ['ID', 'STAGE', 'PRIORITY', 'EXECUTOR', 'DEPENDS ON', 'APPROVAL', 'EXTERNAL', 'TITLE'],
      rows,
    ));
  }

  return { code: 0, output: lines.join('\n'), data: combinedData };
}

export async function goalResultsCommand(
  runId: string,
  options: {
    json?: boolean;
    url?: string;
    token?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<GoalCommandResult> {
  const config = resolveGoalCliConfig(options);
  let fullData: any;
  let run: any;
  let evidence: any[] = [];
  let artifacts: any[] = [];

  const resultsRes = await goalApiRequest<any>(
    config,
    'GET',
    `/runs/${encodeURIComponent(runId)}/results`,
  );

  if (resultsRes.ok) {
    fullData = resultsRes.data;
    run = resultsRes.data.run ?? resultsRes.data;
    evidence = Array.isArray(resultsRes.data.evidence) ? resultsRes.data.evidence : [];
    artifacts = Array.isArray(resultsRes.data.artifacts) ? resultsRes.data.artifacts : [];
  } else if (resultsRes.status === 404) {
    const [runRes, attemptsRes, evidenceRes] = await Promise.all([
      goalApiRequest<any>(config, 'GET', `/runs/${encodeURIComponent(runId)}`),
      goalApiRequest<any>(config, 'GET', `/runs/${encodeURIComponent(runId)}/attempts`),
      goalApiRequest<any>(config, 'GET', `/runs/${encodeURIComponent(runId)}/evidence`),
    ]);

    if (!runRes.ok) return formatError(runRes, options.json);

    run = runRes.data.run ?? runRes.data;
    const attempts = attemptsRes.ok ? (attemptsRes.data.attempts ?? attemptsRes.data ?? []) : [];
    evidence = evidenceRes.ok ? (evidenceRes.data.evidence ?? evidenceRes.data ?? []) : [];
    artifacts = [];

    fullData = {
      run,
      graph: runRes.data.graph,
      attempts,
      evidence,
      artifacts,
    };
  } else {
    return formatError(resultsRes, options.json);
  }

  const artifactList: Array<any> = [...artifacts];
  if (artifactList.length === 0 && evidence.length > 0) {
    for (const ev of evidence) {
      if (ev.artifactUri || ev.uri || ev.artifactDigest || ev.digest) {
        artifactList.push({
          targetId: ev.targetId ?? ev.target_id ?? '-',
          uri: ev.artifactUri ?? ev.uri ?? ev.artifact_uri ?? '-',
          digest: ev.artifactDigest ?? ev.digest ?? ev.artifact_digest ?? '-',
          size: ev.size ?? ev.byteSize ?? ev.bytes ?? '-',
        });
      }
    }
  }

  const verifiedEvidenceCount = evidence.filter((e) => {
    if (e.verified === false || e.validationResult === 'fail' || e.validationResult === 'invalid' || e.status === 'failed') {
      return false;
    }
    return true;
  }).length;

  if (options.json) {
    const payload = {
      ...fullData,
      verifiedEvidenceCount,
      artifacts: artifactList,
    };
    return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
  }

  const runObj = run ?? {};
  const lines = [
    color.bold(`Goal Run Results: ${runObj.runId ?? runId}`),
    `  graph:             ${runObj.graphId ?? '-'}${runObj.graphRevision !== undefined ? `@${runObj.graphRevision}` : ''}`,
    `  status:            ${runObj.status ?? 'unknown'}`,
    `  ledger:            rev ${runObj.ledgerRevision ?? 1}`,
    `  verified evidence: ${verifiedEvidenceCount}`,
    '',
    color.bold('Artifacts:'),
  ];

  const artifactRows = artifactList.map((a) => {
    const target = a.targetId ?? a.target_id ?? a.target ?? '-';
    const uri = a.uri ?? a.artifactUri ?? a.artifact_uri ?? a.path ?? '-';
    const digest = a.digest ?? a.artifactDigest ?? a.artifact_digest ?? a.sha256 ?? '-';
    const size = a.size !== undefined ? String(a.size) : (a.byteSize !== undefined ? String(a.byteSize) : (a.bytes !== undefined ? String(a.bytes) : '-'));
    return [target, uri, digest, size];
  });

  lines.push(table(
    ['TARGET', 'URI', 'DIGEST', 'SIZE'],
    artifactRows,
  ));

  const targetsObj = runObj.targets ?? fullData?.targets ?? {};
  const targetList: Array<any> = Array.isArray(targetsObj)
    ? targetsObj
    : Object.entries(targetsObj).map(([id, t]: [string, any]) => ({
        targetId: (typeof t === 'object' && t !== null ? t.targetId : undefined) ?? id,
        ...(typeof t === 'object' && t !== null ? t : { status: String(t) }),
      }));

  lines.push('', color.bold('Target Status:'));
  const targetRows = targetList.map((t: any) => [
    t.targetId ?? t.id ?? '-',
    t.status ?? '-',
  ]);

  if (targetRows.length === 0) {
    lines.push('  No targets.');
  } else {
    lines.push(table(['TARGET', 'STATUS'], targetRows));
  }

  return {
    code: 0,
    output: lines.join('\n'),
    data: {
      ...fullData,
      verifiedEvidenceCount,
      artifacts: artifactList,
    },
  };
}

export async function goalNobelCommand(
  options: {
    project?: string;
    start?: boolean;
    json?: boolean;
    url?: string;
    token?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<GoalCommandResult> {
  const config = resolveGoalCliConfig(options);
  const projectId = options.project ?? 'nobel-example';

  let seedRes: { status: number; ok: boolean; data: any } | null = null;
  try {
    seedRes = await goalApiRequest<any>(config, 'POST', '/graphs/seed-nobel', { projectId });
  } catch {
    seedRes = null;
  }

  let record: { graphId: string; projectId?: string; revision: number; digest?: string } | undefined;
  let importRes: GoalCommandResult | undefined;

  if (!seedRes || (!seedRes.ok && seedRes.status === 404)) {
    const candidates = [
      path.resolve(process.cwd(), 'packages/goals/fixtures/nobel_goal_graph.yaml'),
      path.resolve(process.cwd(), '../../packages/goals/fixtures/nobel_goal_graph.yaml'),
      typeof __dirname !== 'undefined'
        ? path.resolve(__dirname, '../../../../packages/goals/fixtures/nobel_goal_graph.yaml')
        : '',
      typeof __dirname !== 'undefined'
        ? path.resolve(__dirname, '../../../packages/goals/fixtures/nobel_goal_graph.yaml')
        : '',
    ].filter(Boolean);

    let fixturePath = candidates[0] ?? 'packages/goals/fixtures/nobel_goal_graph.yaml';
    let yamlContent: string | undefined;

    for (const cand of candidates) {
      try {
        yamlContent = await fs.readFile(cand, 'utf-8');
        fixturePath = cand;
        break;
      } catch {
        // try next candidate
      }
    }

    importRes = await goalImportCommand(fixturePath, {
      ...options,
      project: projectId,
      yamlContent,
    });

    if (importRes.code !== 0) {
      return importRes;
    }
    record = (importRes.data as any)?.record ?? (importRes.data as any)?.graph;
  } else if (!seedRes.ok) {
    return formatError(seedRes, options.json);
  } else {
    record = seedRes.data.record ?? seedRes.data.graph;
  }

  const graphId = record?.graphId ?? 'nobel-governance-continuous-goal-graph';
  const graphRevision = record?.revision ?? 1;

  if (options.start) {
    const startRes = await goalApiRequest<{
      run: { runId: string; graphId: string; graphRevision: number; status: string; ledgerRevision: number };
    }>(config, 'POST', '/runs', {
      graphId,
      graphRevision,
    });
    if (!startRes.ok) return formatError(startRes, options.json);
    const run = startRes.data.run;
    const combinedData = {
      record,
      run,
      ...(seedRes ? seedRes.data : (importRes?.data as any)),
    };
    if (options.json) {
      return { code: 0, output: JSON.stringify(combinedData, null, 2), data: combinedData };
    }
    const lines = [
      color.bold('Goal Graph Seeded (Nobel)'),
      `  graphId:   ${record?.graphId ?? graphId}`,
      `  project:   ${record?.projectId ?? projectId}`,
      `  revision:  ${record?.revision ?? graphRevision}`,
      `  digest:    ${record?.digest ?? '-'}`,
      '',
      color.bold(`Goal Run Started: ${run.runId}`),
      `  graph:     ${run.graphId}@${run.graphRevision}`,
      `  status:    ${run.status}`,
      `  revision:  ${run.ledgerRevision}`,
    ];
    return { code: 0, output: lines.join('\n'), data: combinedData };
  }

  const resultData = seedRes ? seedRes.data : (importRes?.data as any);
  if (options.json) {
    return { code: 0, output: JSON.stringify(resultData, null, 2), data: resultData };
  }
  return {
    code: 0,
    output: [
      color.bold('Goal Graph Seeded (Nobel)'),
      `  graphId:   ${record?.graphId ?? graphId}`,
      `  project:   ${record?.projectId ?? projectId}`,
      `  revision:  ${record?.revision ?? graphRevision}`,
      `  digest:    ${record?.digest ?? '-'}`,
    ].join('\n'),
    data: resultData,
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
    .command('create <name>')
    .description('Create a new Goal Studio graph definition')
    .option('-o, --objective <text>', 'Graph objective')
    .option('-p, --project <projectId>', 'Project ID', 'default')
    .option('-t, --target <title...>', 'Initial target titles')
    .option('--url <url>', 'Controller base URL')
    .option('--token <token>', 'Operator API token')
    .option('-j, --json', 'Output JSON')
    .action(async (name: string, opts) => {
      const res = await goalCreateCommand(name, opts);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  goal
    .command('inspect <graphId>')
    .description('Inspect a Goal Studio graph definition and critical path')
    .option('-r, --revision <revision>', 'Pin specific graph revision', (v) => parseInt(v, 10))
    .option('--url <url>', 'Controller base URL')
    .option('--token <token>', 'API token')
    .option('-j, --json', 'Output JSON')
    .action(async (graphId: string, opts) => {
      const res = await goalInspectCommand(graphId, opts);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  goal
    .command('nobel')
    .description('Seed and optionally run the Nobel governance continuous goal graph')
    .option('-p, --project <projectId>', 'Project ID', 'nobel-example')
    .option('--start', 'Immediately start a run after seeding')
    .option('--url <url>', 'Controller base URL')
    .option('--token <token>', 'Operator API token')
    .option('-j, --json', 'Output JSON')
    .action(async (opts) => {
      const res = await goalNobelCommand(opts);
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

  goal
    .command('results <runId>')
    .description('Display final execution results, evidence, and artifacts for a run')
    .option('--url <url>', 'Controller base URL')
    .option('--token <token>', 'API token')
    .option('-j, --json', 'Output JSON')
    .action(async (runId: string, opts) => {
      const res = await goalResultsCommand(runId, opts);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  for (const action of ['pause', 'resume', 'stop', 'cancel'] as const) {
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
