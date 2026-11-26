import { constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  ExecutionEngine,
  type ExecutionEvent,
  type ExecutionRecord,
  type Job,
  type JobMessage,
  type JobNode,
} from '@wazir/core';
import { JsonFileStore, MemoryStore, type KeyValueStore } from '@wazir/shared';
import {
  WORKFLOW_STORE_KEYS,
  createGoalGraphStore,
  createLedgerStore,
  type GoalGraphRevisionRecord,
  type GoalRunLedger,
  type WorkflowPlanRecord,
} from '@wazir/goals';
import {
  AgentConfigurationDiscovery,
  effectivePreflightStatus,
  isPreflightFresh,
  type AgentPreflightResult,
} from '@wazir/agents';
import { loadPreflightCache } from '../agentPreflight.js';
import { color } from '../colors.js';
import { configDir } from '../config.js';
import { table } from './table.js';

export interface FabricCommandResult {
  code: number;
  output: string;
  data?: unknown;
}

interface CoordinationFabricLike {
  getStatus(): Promise<Record<string, unknown>> | Record<string, unknown>;
  diagnose(): Promise<Record<string, unknown>> | Record<string, unknown>;
  replayEvents(filter?: Record<string, unknown> | string): Promise<unknown[]> | unknown[];
  loadArtifact?(ref: string): Promise<unknown> | unknown;
  listOutbox(status?: string): Promise<unknown[]> | unknown[];
  listDeadLetters(): Promise<unknown[]> | unknown[];
  close(): Promise<void> | void;
}

interface MessageRouterLike {
  listMessages?(workflowId?: string, filter?: Record<string, unknown>): Promise<unknown[]> | unknown[];
  listDeadLetters?(): Promise<unknown[]> | unknown[];
}

interface ResourceReservationManagerLike {
  listActiveLeases?(workflowId?: string): Promise<unknown[]> | unknown[];
}

interface CoordinationEnvelopeLike {
  event_id?: string;
  id?: string;
  schema_version?: string;
  version?: number | string;
  type?: string;
  workflow_id?: string;
  workflowId?: string;
  jobId?: string;
  task_id?: string;
  taskId?: string;
  executionId?: string;
  execution_id?: string;
  correlation_id?: string;
  correlationId?: string;
  causation_id?: string;
  source_agent?: string;
  fromAgent?: string;
  from?: string;
  target_agent?: string;
  toAgent?: string;
  to?: string;
  agentId?: string;
  priority?: string;
  timestamp?: unknown;
  createdAt?: unknown;
  at?: unknown;
  payload?: unknown;
  data?: unknown;
  artifact_refs?: string[];
  artifactReferences?: string[];
  status?: string;
  [key: string]: unknown;
}

interface InboxMessageLike {
  messageId?: string;
  envelope?: CoordinationEnvelopeLike;
  status?: 'queued' | 'delivered' | 'acked' | 'dead_letter' | string;
  recipientAgent?: string;
  attempts?: number;
  visibleAt?: number;
  deliveredAt?: number;
  ackedAt?: number;
  lastError?: string;
}

interface OutboxEntryLike {
  id?: string;
  envelope?: CoordinationEnvelopeLike;
  status?: 'pending' | 'delivered' | 'failed' | 'dead_letter' | string;
  attempts?: number;
  lastError?: string;
  createdAt?: number;
  updatedAt?: number;
}

const DEFAULT_FABRIC_OP_TIMEOUT_MS = 600;
const DEFAULT_NATS_PROBE_TIMEOUT_MS = 250;
const STALE_CONSUMER_THRESHOLD_MS = 30_000;

function toIsoString(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function toTimestampMs(value: unknown): number {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeJobId(rawId: string): string {
  const trimmed = rawId.trim();
  return trimmed.startsWith('job/') ? trimmed.slice(4) : trimmed;
}

function resolveWorkspaceRoot(workspace?: string): string {
  return path.resolve(workspace ?? process.env.WAZIR_WORKSPACE_DIR ?? process.cwd());
}

function resolveFabricPaths(workspace?: string): {
  wazirHome: string;
  fabricDir: string;
  workspaceRoot: string;
} {
  const wazirHome = configDir();
  return {
    wazirHome,
    fabricDir: path.join(wazirHome, 'fabric'),
    workspaceRoot: resolveWorkspaceRoot(workspace),
  };
}

async function openFastStore(wazirHome: string): Promise<KeyValueStore> {
  if (process.env.WAZIR_DATABASE_URL) {
    const { createPool, runKvMigration, PostgresStore } = await import('@wazir/database');
    const pool = createPool({ connectionString: process.env.WAZIR_DATABASE_URL });
    await runKvMigration(pool);
    return new PostgresStore(pool);
  }
  if (process.env.WAZIR_IN_MEMORY === '1') {
    return new MemoryStore();
  }
  return new JsonFileStore(path.join(wazirHome, 'wazir.json'));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function redactNatsUrl(rawUrl: string): string {
  return rawUrl
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      try {
        const parsed = new URL(trimmed.includes('://') ? trimmed : `nats://${trimmed}`);
        if (parsed.username) parsed.username = '[REDACTED]';
        if (parsed.password) parsed.password = '[REDACTED]';
        return parsed.toString().replace(/\/$/, '');
      } catch {
        return trimmed.replace(/\/\/[^@/]+@/, '//[REDACTED]@');
      }
    })
    .join(',');
}

function parseNatsHostPort(rawUrl: string): { host: string; port: number } | undefined {
  const first = rawUrl.split(',')[0]?.trim();
  if (!first) return undefined;
  try {
    const parsed = new URL(first.includes('://') ? first : `nats://${first}`);
    const host = parsed.hostname || '127.0.0.1';
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : 4222;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
    return { host, port };
  } catch {
    return undefined;
  }
}

export async function probeNatsTcp(
  rawUrl: string | undefined,
  timeoutMs = DEFAULT_NATS_PROBE_TIMEOUT_MS,
): Promise<{
  configured: boolean;
  reachable: boolean;
  url?: string;
  host?: string;
  port?: number;
  latencyMs: number;
  error?: string;
}> {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    return { configured: false, reachable: false, latencyMs: 0 };
  }
  const target = parseNatsHostPort(trimmed);
  const redacted = redactNatsUrl(trimmed);
  if (!target) {
    return {
      configured: true,
      reachable: false,
      url: redacted,
      latencyMs: 0,
      error: 'Invalid WAZIR_NATS_URL format',
    };
  }

  const boundedMs = Math.max(10, Math.min(timeoutMs, DEFAULT_NATS_PROBE_TIMEOUT_MS));
  const started = performance.now();

  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: target.host, port: target.port });

    const finish = (reachable: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve({
        configured: true,
        reachable,
        url: redacted,
        host: target.host,
        port: target.port,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        ...(error ? { error } : {}),
      });
    };

    const timer = setTimeout(() => finish(false, `TCP probe timed out after ${boundedMs}ms`), boundedMs);
    if (typeof timer.unref === 'function') timer.unref();

    socket.once('connect', () => finish(true));
    socket.once('error', (err) => finish(false, err instanceof Error ? err.message : String(err)));
  });
}

async function getCoreExports(): Promise<Record<string, unknown>> {
  try {
    return (await import('@wazir/core')) as unknown as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function createFabricInstanceIfAvailable(params: {
  fabricDir?: string;
  store?: KeyValueStore;
  natsUrl?: string;
}): Promise<CoordinationFabricLike | undefined> {
  const core = await getCoreExports();
  const FabricCtor = core.CoordinationFabric as
    | (new (opts: {
        fabricDir?: string;
        store?: KeyValueStore;
        natsUrl?: string;
        connectTimeoutMs: number;
      }) => CoordinationFabricLike)
    | undefined;
  if (typeof FabricCtor !== 'function') return undefined;
  try {
    return new FabricCtor({
      fabricDir: params.fabricDir,
      store: params.store,
      natsUrl: params.natsUrl,
      connectTimeoutMs: DEFAULT_NATS_PROBE_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
}

async function createResourceReservationManagerIfAvailable(
  stateDir: string,
): Promise<ResourceReservationManagerLike | undefined> {
  const core = await getCoreExports();
  const MgrCtor = core.ResourceReservationManager as
    | (new (opts: { stateDir: string }) => ResourceReservationManagerLike)
    | undefined;
  if (typeof MgrCtor !== 'function') return undefined;
  try {
    return new MgrCtor({ stateDir });
  } catch {
    return undefined;
  }
}

async function createMessageRouterIfAvailable(params: {
  fabric?: CoordinationFabricLike;
  jobManager?: unknown;
}): Promise<MessageRouterLike | undefined> {
  if (!params.fabric) return undefined;
  const core = await getCoreExports();
  const RouterCtor = core.MessageRouter as
    | (new (opts: { fabric: unknown; jobManager?: unknown }) => MessageRouterLike)
    | undefined;
  if (typeof RouterCtor !== 'function') return undefined;
  try {
    const router = new RouterCtor({ fabric: params.fabric, jobManager: params.jobManager });
    if (typeof router.listMessages === 'function' || typeof router.listDeadLetters === 'function') {
      return router;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function closeFabricSafely(fabric: CoordinationFabricLike | undefined): Promise<void> {
  if (!fabric || typeof fabric.close !== 'function') return;
  await withTimeout(Promise.resolve(fabric.close()), 250, undefined);
}

function parseJsonOrJsonlText(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.messages)) return obj.messages;
      if (Array.isArray(obj.events)) return obj.events;
      if (Array.isArray(obj.items)) return obj.items;
      if (Array.isArray(obj.entries)) return obj.entries;
      return [obj];
    }
    return [];
  } catch {
    const rows: unknown[] = [];
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        rows.push(JSON.parse(l));
      } catch {
        // Ignore partial/malformed JSONL line during read-only inspection
      }
    }
    return rows;
  }
}

function readJsonRecordsFromTarget(targetPath: string, maxDepth = 3): unknown[] {
  if (!existsSync(targetPath)) return [];
  try {
    const st = statSync(targetPath);
    if (st.isFile()) {
      if (!targetPath.endsWith('.json') && !targetPath.endsWith('.jsonl')) return [];
      return parseJsonOrJsonlText(readFileSync(targetPath, 'utf8'));
    }
    if (!st.isDirectory() || maxDepth <= 0) return [];
    const results: unknown[] = [];
    for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
      if (entry.name.startsWith('.diagnose-') || entry.name.startsWith('.')) continue;
      const full = path.join(targetPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...readJsonRecordsFromTarget(full, maxDepth - 1));
      } else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))) {
        results.push(...parseJsonOrJsonlText(readFileSync(full, 'utf8')));
      }
    }
    return results;
  } catch {
    return [];
  }
}

function unwrapEnvelope(raw: unknown): {
  envelope?: CoordinationEnvelopeLike;
  inboxMeta?: InboxMessageLike;
  outboxMeta?: OutboxEntryLike;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const rec = raw as Record<string, unknown>;
  if (rec.envelope && typeof rec.envelope === 'object' && !Array.isArray(rec.envelope)) {
    const env = rec.envelope as CoordinationEnvelopeLike;
    if ('messageId' in rec || 'recipientAgent' in rec) {
      return { envelope: env, inboxMeta: rec as unknown as InboxMessageLike };
    }
    return { envelope: env, outboxMeta: rec as unknown as OutboxEntryLike };
  }
  return { envelope: rec as CoordinationEnvelopeLike };
}

function readFabricInboxes(fabricDir: string): {
  byAgent: Record<string, number>;
  unreadByAgent: Record<string, number>;
  pendingTotal: number;
  totalMessages: number;
  messages: Array<{ envelope: CoordinationEnvelopeLike; recipientAgent: string; status?: string; messageId?: string }>;
} {
  const inboxesDir = path.join(fabricDir, 'inboxes');
  const byAgent: Record<string, number> = {};
  const unreadByAgent: Record<string, number> = {};
  const messages: Array<{ envelope: CoordinationEnvelopeLike; recipientAgent: string; status?: string; messageId?: string }> = [];

  if (!existsSync(inboxesDir)) {
    return { byAgent, unreadByAgent, pendingTotal: 0, totalMessages: 0, messages };
  }

  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = readdirSync(inboxesDir, { withFileTypes: true });
  } catch {
    return { byAgent, unreadByAgent, pendingTotal: 0, totalMessages: 0, messages };
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const full = path.join(inboxesDir, entry.name);
    let fallbackAgent = entry.name;
    if (entry.isFile()) {
      if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) continue;
      fallbackAgent = entry.name.replace(/\.(?:jsonl|json)$/i, '');
    } else if (!entry.isDirectory()) {
      continue;
    }

    const rawItems = readJsonRecordsFromTarget(full, 2);
    for (const item of rawItems) {
      const { envelope, inboxMeta } = unwrapEnvelope(item);
      if (!envelope) continue;
      const agentName =
        (typeof inboxMeta?.recipientAgent === 'string' && inboxMeta.recipientAgent) ||
        (typeof envelope.target_agent === 'string' && envelope.target_agent) ||
        fallbackAgent;
      const status = inboxMeta?.status ?? envelope.status;
      byAgent[agentName] = (byAgent[agentName] ?? 0) + 1;
      const isPending =
        status === 'queued' ||
        status === 'delivered' ||
        (status === undefined && (item as Record<string, unknown>).acked !== true && (item as Record<string, unknown>).read !== true);
      if (isPending) {
        unreadByAgent[agentName] = (unreadByAgent[agentName] ?? 0) + 1;
      }
      messages.push({
        envelope,
        recipientAgent: agentName,
        status: typeof status === 'string' ? status : undefined,
        messageId: inboxMeta?.messageId,
      });
    }
  }

  const totalMessages = Object.values(byAgent).reduce((sum, count) => sum + count, 0);
  const pendingTotal = Object.values(unreadByAgent).reduce((sum, count) => sum + count, 0);
  return { byAgent, unreadByAgent, pendingTotal, totalMessages, messages };
}

function normalizeTaskBucket(status: string): 'running' | 'queued' | 'terminal' {
  const lower = status.toLowerCase();
  if (lower === 'running' || lower === 'active' || lower === 'verifying' || lower === 'repairing') {
    return 'running';
  }
  if (lower === 'completed' || lower === 'failed' || lower === 'cancelled' || lower === 'stopped' || lower === 'verified') {
    return 'terminal';
  }
  return 'queued';
}

function effectiveJobTaskStatus(task: Job['tasks'][number], node?: JobNode): string {
  const rawTaskStatus = String(task.status ?? 'pending');
  if (rawTaskStatus === 'pending' && node) {
    if (node.state === 'assigned') return 'assigned';
    if (node.state === 'blocked') return 'blocked';
    if (node.state === 'running') return 'running';
  }
  return rawTaskStatus;
}

interface UnifiedTaskRow {
  source: 'job' | 'workflow';
  jobId: string;
  jobTitle: string;
  taskId: string;
  title: string;
  status: string;
  bucket: 'running' | 'queued' | 'terminal';
  agentId?: string;
  modelId?: string;
  executionId?: string;
  dependencies: string[];
  blockers: string[];
  createdAt?: string;
  updatedAt?: string;
}

function loadWorkflowFilesFromDisk(
  dirs: string[],
): { runs: GoalRunLedger[]; plans: Map<string, WorkflowPlanRecord>; graphs: Map<string, GoalGraphRevisionRecord>; jobs: Job[] } {
  const runsById = new Map<string, GoalRunLedger>();
  const plans = new Map<string, WorkflowPlanRecord>();
  const graphs = new Map<string, GoalGraphRevisionRecord>();
  const jobsById = new Map<string, Job>();

  const ingestObject = (obj: unknown) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) ingestObject(item);
      return;
    }
    const rec = obj as Record<string, unknown>;
    if (typeof rec.runId === 'string' && rec.targets && typeof rec.targets === 'object' && typeof rec.graphId === 'string') {
      const run = rec as unknown as GoalRunLedger;
      if (!runsById.has(run.runId)) runsById.set(run.runId, run);
      return;
    }
    if (rec.run && typeof rec.run === 'object') {
      ingestObject(rec.run);
      if (rec.plan && typeof rec.plan === 'object') ingestObject(rec.plan);
      if (rec.graph && typeof rec.graph === 'object') ingestObject(rec.graph);
      return;
    }
    if (rec.format === 1 && typeof rec.graphId === 'string' && typeof rec.prompt === 'string' && typeof rec.runId === 'string') {
      plans.set(rec.runId, rec as unknown as WorkflowPlanRecord);
      return;
    }
    if (typeof rec.graphId === 'string' && typeof rec.revision === 'number' && rec.definition && typeof rec.definition === 'object') {
      const g = rec as unknown as GoalGraphRevisionRecord;
      graphs.set(`${g.graphId}@${g.revision}`, g);
      return;
    }
    if (typeof rec.id === 'string' && Array.isArray(rec.tasks) && rec.graph && typeof rec.graph === 'object') {
      const job = rec as unknown as Job;
      if (!jobsById.has(job.id)) jobsById.set(job.id, job);
      return;
    }
    for (const val of Object.values(rec)) {
      if (val && typeof val === 'object') ingestObject(val);
    }
  };

  for (const dir of dirs) {
    for (const item of readJsonRecordsFromTarget(dir, 3)) {
      ingestObject(item);
    }
  }

  return { runs: Array.from(runsById.values()), plans, graphs, jobs: Array.from(jobsById.values()) };
}

function matchesTaskStatusFilter(row: UnifiedTaskRow, rawFilter: string): boolean {
  const filter = rawFilter.trim().toLowerCase();
  const status = row.status.toLowerCase();
  if (status === filter) return true;
  if (filter === 'queued') {
    return row.bucket === 'queued';
  }
  if (filter === 'running') {
    return row.bucket === 'running';
  }
  if (filter === 'pending') {
    return status === 'pending' || status === 'queued' || status === 'eligible';
  }
  return false;
}

export async function tasksCommand(
  opts: { job?: string; status?: string; workspace?: string; json?: boolean } = {},
): Promise<FabricCommandResult> {
  try {
    const { wazirHome, workspaceRoot } = resolveFabricPaths(opts.workspace);
    const store = await openFastStore(wazirHome);

    const jobEntries = await store.list('job/');
    const jobsById = new Map<string, Job>();
    for (const entry of jobEntries) {
      const job = entry.value as Job | undefined;
      if (job && typeof job.id === 'string' && Array.isArray(job.tasks)) {
        jobsById.set(job.id, job);
      }
    }

    const ledger = createLedgerStore({ store, workspaceRoot });
    const graphs = createGoalGraphStore({ store, workspaceRoot });
    const storeRuns = await ledger.listRuns().catch(() => [] as GoalRunLedger[]);
    const planEntries = await store.list(WORKFLOW_STORE_KEYS.runsPrefix).catch(() => []);
    const plansByRunId = new Map<string, WorkflowPlanRecord>();
    for (const entry of planEntries) {
      const plan = entry.value as WorkflowPlanRecord | undefined;
      if (plan?.runId) plansByRunId.set(plan.runId, plan);
    }

    const diskWorkflows = loadWorkflowFilesFromDisk([
      path.join(workspaceRoot, '.wazir', 'workflows'),
      path.join(wazirHome, 'workflows'),
    ]);
    for (const job of diskWorkflows.jobs) {
      if (!jobsById.has(job.id)) jobsById.set(job.id, job);
    }
    for (const [runId, plan] of diskWorkflows.plans) {
      if (!plansByRunId.has(runId)) plansByRunId.set(runId, plan);
    }

    const runsById = new Map<string, GoalRunLedger>();
    for (const run of storeRuns) runsById.set(run.runId, run);
    for (const run of diskWorkflows.runs) {
      if (!runsById.has(run.runId)) runsById.set(run.runId, run);
    }

    const rows: UnifiedTaskRow[] = [];
    const seenKeys = new Set<string>();

    for (const job of jobsById.values()) {
      const nodesByTaskId = new Map<string, JobNode>();
      for (const node of job.graph?.nodes ?? []) {
        nodesByTaskId.set(node.taskId ?? node.id, node);
      }
      for (const task of job.tasks ?? []) {
        const dedupeKey = `${job.id}::${task.id}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);

        const node = nodesByTaskId.get(task.id);
        const status = effectiveJobTaskStatus(task, node);
        const blockers: string[] = [];
        if (node?.error) blockers.push(node.error);
        for (const dep of node?.dependencies ?? []) {
          const depNode = nodesByTaskId.get(dep);
          if (depNode && depNode.state !== 'completed') {
            blockers.push(`waiting on ${dep} (${depNode.state})`);
          }
        }

        rows.push({
          source: 'job',
          jobId: job.id,
          jobTitle: job.title,
          taskId: task.id,
          title: (task.title ?? task.input ?? task.id).slice(0, 80),
          status,
          bucket: normalizeTaskBucket(status),
          agentId: node?.agentId ?? task.execution?.targetAgentId,
          modelId: task.execution?.targetModelId,
          dependencies: node?.dependencies ?? [],
          blockers,
          createdAt: toIsoString(task.createdAt) ?? toIsoString(job.createdAt),
          updatedAt: toIsoString(task.updatedAt) ?? toIsoString(task.completedAt) ?? toIsoString(job.createdAt),
        });
      }
    }

    const graphCache = new Map<string, GoalGraphRevisionRecord | undefined>(diskWorkflows.graphs);
    for (const run of runsById.values()) {
      const graphKey = `${run.graphId}@${run.graphRevision}`;
      if (!graphCache.has(graphKey)) {
        graphCache.set(graphKey, await graphs.getRevision(run.graphId, run.graphRevision).catch(() => undefined));
      }
      const graphRev = graphCache.get(graphKey);
      const plan = plansByRunId.get(run.runId);
      const targetsById = new Map((graphRev?.definition?.targets ?? []).map((t) => [t.id, t]));

      for (const entry of Object.values(run.targets ?? {})) {
        const dedupeKey = `${run.runId}::${entry.targetId}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);

        const targetDef = targetsById.get(entry.targetId);
        const status = String(entry.status);
        rows.push({
          source: 'workflow',
          jobId: run.runId,
          jobTitle: plan?.prompt ?? graphRev?.definition?.name ?? run.graphId,
          taskId: entry.targetId,
          title: (targetDef?.title ?? entry.targetId).slice(0, 80),
          status,
          bucket: normalizeTaskBucket(status),
          executionId: entry.lastExecutionId,
          dependencies: targetDef?.dependsOn ?? [],
          blockers: Array.isArray(entry.blockers) ? entry.blockers : [],
          createdAt: toIsoString(run.createdAt),
          updatedAt: toIsoString(entry.updatedAt) ?? toIsoString(run.updatedAt),
        });
      }
    }

    let filtered = rows;
    if (opts.job) {
      const q = normalizeJobId(opts.job);
      const exact = filtered.filter((r) => r.jobId === q);
      filtered = exact.length > 0 ? exact : filtered.filter((r) => r.jobId.includes(q));
    }
    if (opts.status) {
      filtered = filtered.filter((r) => matchesTaskStatusFilter(r, opts.status!));
    }

    filtered.sort((a, b) => toTimestampMs(b.updatedAt ?? b.createdAt) - toTimestampMs(a.updatedAt ?? a.createdAt));

    const counts = {
      total: filtered.length,
      running: filtered.filter((r) => r.bucket === 'running').length,
      queued: filtered.filter((r) => r.bucket === 'queued').length,
      completed: filtered.filter((r) => r.status.toLowerCase() === 'completed').length,
      failed: filtered.filter((r) => r.status.toLowerCase() === 'failed').length,
      cancelled: filtered.filter((r) => {
        const s = r.status.toLowerCase();
        return s === 'cancelled' || s === 'stopped';
      }).length,
    };

    const payload = {
      ok: true,
      counts,
      jobsCount: jobsById.size,
      workflowsCount: runsById.size,
      tasks: filtered,
    };

    if (opts.json) {
      return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
    }

    if (filtered.length === 0) {
      return {
        code: 0,
        output: color.yellow(opts.job || opts.status ? 'No tasks matched the specified filters.' : 'No tasks recorded yet.'),
        data: payload,
      };
    }

    const lines: string[] = [
      color.bold(
        `Tasks (${counts.total}): running=${counts.running}, queued=${counts.queued}, completed=${counts.completed}, failed=${counts.failed}, cancelled=${counts.cancelled}`,
      ),
      '',
      table(
        ['JOB / RUN', 'TASK', 'STATUS', 'BUCKET', 'SOURCE', 'AGENT', 'UPDATED', 'TITLE'],
        filtered.map((r) => [
          r.jobId,
          r.taskId,
          r.status,
          r.bucket,
          r.source,
          r.agentId ?? '-',
          (r.updatedAt ?? r.createdAt ?? '-').replace('T', ' ').slice(0, 19),
          r.title.slice(0, 48),
        ]),
      ),
    ];

    return { code: 0, output: lines.join('\n'), data: payload };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      code: 1,
      output: opts.json ? JSON.stringify({ ok: false, error: { code: 'TASKS_ERROR', message } }, null, 2) : color.red(message),
    };
  }
}

interface DagNodeView {
  id: string;
  taskId?: string;
  type: string;
  state: string;
  taskStatus?: string;
  agentId?: string;
  dependencies: string[];
  children: string[];
  blockers: string[];
  error?: string;
  attempts?: number;
  title?: string;
}

interface DagEdgeView {
  from: string;
  to: string;
  condition: 'success' | 'failure' | 'always';
}

function buildJobDagInspection(job: Job): {
  kind: 'job';
  id: string;
  title: string;
  status: string;
  nodes: DagNodeView[];
  edges: DagEdgeView[];
  blockers: Array<{ nodeId: string; reasons: string[] }>;
} {
  const nodesById = new Map<string, JobNode>();
  for (const node of job.graph?.nodes ?? []) {
    nodesById.set(node.id, node);
    if (node.taskId) nodesById.set(node.taskId, node);
  }
  const tasksById = new Map((job.tasks ?? []).map((t) => [t.id, t]));

  const edges: DagEdgeView[] = [];
  const seenEdges = new Set<string>();
  for (const edge of job.graph?.edges ?? []) {
    const cond = edge.condition ?? 'always';
    const key = `${edge.from}->${edge.to}:${cond}`;
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      edges.push({ from: edge.from, to: edge.to, condition: cond });
    }
  }
  for (const node of job.graph?.nodes ?? []) {
    for (const dep of node.dependencies ?? []) {
      const existing = edges.some((e) => e.from === dep && e.to === node.id);
      if (!existing) {
        edges.push({ from: dep, to: node.id, condition: 'always' });
      }
    }
  }

  const blockers: Array<{ nodeId: string; reasons: string[] }> = [];
  const nodes: DagNodeView[] = (job.graph?.nodes ?? []).map((node) => {
    const task = tasksById.get(node.taskId ?? node.id);
    const nodeBlockers: string[] = [];
    if (node.error) nodeBlockers.push(node.error);
    if (node.state === 'blocked' && nodeBlockers.length === 0) {
      nodeBlockers.push('node is blocked');
    }
    if (node.state !== 'completed' && node.state !== 'cancelled') {
      for (const dep of node.dependencies ?? []) {
        const depNode = nodesById.get(dep);
        if (!depNode) {
          nodeBlockers.push(`missing dependency '${dep}'`);
        } else if (depNode.state !== 'completed') {
          nodeBlockers.push(`waiting on ${dep} (${depNode.state})`);
        }
      }
    }
    if (nodeBlockers.length > 0) {
      blockers.push({ nodeId: node.id, reasons: nodeBlockers });
    }
    return {
      id: node.id,
      taskId: node.taskId,
      type: node.type,
      state: node.state,
      taskStatus: task?.status,
      agentId: node.agentId ?? task?.execution?.targetAgentId,
      dependencies: [...(node.dependencies ?? [])],
      children: [...(node.children ?? [])],
      blockers: nodeBlockers,
      ...(node.error ? { error: node.error } : {}),
      ...(node.attempts ? { attempts: node.attempts.length } : {}),
      ...(task?.title || task?.input ? { title: (task.title ?? task.input).slice(0, 80) } : {}),
    };
  });

  return {
    kind: 'job',
    id: job.id,
    title: job.title,
    status: job.status,
    nodes,
    edges,
    blockers,
  };
}

function buildWorkflowDagInspection(
  run: GoalRunLedger,
  graphRev: GoalGraphRevisionRecord | undefined,
  plan: WorkflowPlanRecord | undefined,
): {
  kind: 'workflow';
  id: string;
  title: string;
  graphId: string;
  graphRevision: number;
  status: string;
  nodes: DagNodeView[];
  edges: DagEdgeView[];
  blockers: Array<{ nodeId: string; reasons: string[] }>;
} {
  const targets = graphRev?.definition?.targets ?? [];
  const childrenMap = new Map<string, string[]>();
  const edges: DagEdgeView[] = [];
  for (const t of targets) {
    for (const dep of t.dependsOn ?? []) {
      edges.push({ from: dep, to: t.id, condition: 'success' });
      const arr = childrenMap.get(dep) ?? [];
      arr.push(t.id);
      childrenMap.set(dep, arr);
    }
  }

  const blockers: Array<{ nodeId: string; reasons: string[] }> = [];
  const nodes: DagNodeView[] = (
    targets.length > 0
      ? targets.map((t) => ({ id: t.id, stage: t.stage, title: t.title, dependsOn: t.dependsOn, executor: t.executor }))
      : Object.keys(run.targets).map((id) => ({ id, stage: 'target', title: id, dependsOn: [], executor: 'workflow' }))
  ).map((t) => {
    const entry = run.targets[t.id];
    const state = entry?.status ?? 'queued';
    const nodeBlockers = [...(entry?.blockers ?? [])];
    if (state !== 'completed' && state !== 'stopped') {
      for (const dep of t.dependsOn) {
        const depState = run.targets[dep]?.status ?? 'unknown';
        if (depState !== 'completed') {
          nodeBlockers.push(`waiting on ${dep} (${depState})`);
        }
      }
    }
    if (state === 'needs_approval' && !nodeBlockers.some((b) => /approval/i.test(b))) {
      nodeBlockers.push('awaiting human approval');
    }
    if (nodeBlockers.length > 0) {
      blockers.push({ nodeId: t.id, reasons: nodeBlockers });
    }
    return {
      id: t.id,
      type: t.stage,
      state,
      agentId: t.executor,
      dependencies: [...t.dependsOn],
      children: childrenMap.get(t.id) ?? [],
      blockers: nodeBlockers,
      attempts: entry?.attempts ?? 0,
      title: t.title,
    };
  });

  return {
    kind: 'workflow',
    id: run.runId,
    title: plan?.prompt ?? graphRev?.definition?.name ?? run.graphId,
    graphId: run.graphId,
    graphRevision: run.graphRevision,
    status: run.status,
    nodes,
    edges,
    blockers,
  };
}

function formatDagInspection(
  dag: ReturnType<typeof buildJobDagInspection> | ReturnType<typeof buildWorkflowDagInspection>,
): string {
  const header =
    dag.kind === 'job'
      ? `Job DAG: ${dag.id} (${dag.title}) [${dag.status}]`
      : `Workflow DAG: ${dag.id} (${dag.graphId}@${dag.graphRevision}) [${dag.status}]`;
  const lines: string[] = [color.bold(header)];
  if (dag.kind === 'workflow') {
    lines.push(`  title:    ${dag.title}`);
  }
  lines.push(`  nodes:    ${dag.nodes.length}`);
  lines.push(`  edges:    ${dag.edges.length}`);
  lines.push(`  blockers: ${dag.blockers.length}`);

  lines.push('');
  lines.push(color.bold('Nodes:'));
  if (dag.nodes.length === 0) {
    lines.push('  (none)');
  } else {
    lines.push(
      table(
        ['NODE', 'TYPE', 'STATE', 'AGENT', 'DEPENDS ON', 'BLOCKERS'],
        dag.nodes.map((n) => [
          n.id,
          n.type,
          n.state,
          n.agentId ?? '-',
          n.dependencies.join(',') || '-',
          n.blockers.join('; ') || '-',
        ]),
      ),
    );
  }

  lines.push('');
  lines.push(color.bold('DAG Edges:'));
  if (dag.edges.length === 0) {
    lines.push('  (no dependency edges)');
  } else {
    for (const edge of dag.edges) {
      lines.push(`  ${edge.from} -> ${edge.to} [condition: ${edge.condition}]`);
    }
  }

  if (dag.blockers.length > 0) {
    lines.push('');
    lines.push(color.yellow('Blockers:'));
    for (const b of dag.blockers) {
      lines.push(`  - ${b.nodeId}: ${b.reasons.join('; ')}`);
    }
  }

  return lines.join('\n');
}

export async function inspectGraphCommand(
  idOrGoal: string,
  opts: { inspect?: boolean; workspace?: string; json?: boolean } = {},
): Promise<{ found: boolean; result: FabricCommandResult }> {
  const trimmed = idOrGoal.trim();
  const normalized = normalizeJobId(trimmed);
  const { wazirHome, workspaceRoot } = resolveFabricPaths(opts.workspace);
  const store = await openFastStore(wazirHome);

  let matchedJob = await store.get<Job>(`job/${normalized}`);
  if (!matchedJob && (normalized.startsWith('job-') || opts.inspect)) {
    const allJobs = await store.list('job/');
    const matches = allJobs
      .map((e) => e.value as Job | undefined)
      .filter((j): j is Job => Boolean(j && typeof j.id === 'string' && j.id.startsWith(normalized)));
    if (matches.length === 1) {
      matchedJob = matches[0];
    }
  }

  const diskWorkflows = loadWorkflowFilesFromDisk([
    path.join(workspaceRoot, '.wazir', 'workflows'),
    path.join(wazirHome, 'workflows'),
  ]);
  if (!matchedJob) {
    matchedJob = diskWorkflows.jobs.find((j) => j.id === normalized || ((normalized.startsWith('job-') || opts.inspect) && j.id.startsWith(normalized)));
  }

  if (matchedJob) {
    const dag = buildJobDagInspection(matchedJob);
    const payload = { ok: true, ...dag };
    return {
      found: true,
      result: {
        code: 0,
        output: opts.json ? JSON.stringify(payload, null, 2) : formatDagInspection(dag),
        data: payload,
      },
    };
  }

  const ledger = createLedgerStore({ store, workspaceRoot });
  const graphs = createGoalGraphStore({ store, workspaceRoot });
  let matchedRun = await ledger.getRun(normalized).catch(() => undefined);
  if (!matchedRun && (normalized.startsWith('run-') || opts.inspect)) {
    const runs = await ledger.listRuns().catch(() => [] as GoalRunLedger[]);
    const matches = runs.filter((r) => r.runId === normalized || r.runId.startsWith(normalized));
    if (matches.length === 1) matchedRun = matches[0];
  }
  if (!matchedRun) {
    matchedRun = diskWorkflows.runs.find((r) => r.runId === normalized || ((normalized.startsWith('run-') || opts.inspect) && r.runId.startsWith(normalized)));
  }

  if (matchedRun) {
    const graphRev =
      (await graphs.getRevision(matchedRun.graphId, matchedRun.graphRevision).catch(() => undefined)) ??
      diskWorkflows.graphs.get(`${matchedRun.graphId}@${matchedRun.graphRevision}`);
    const plan =
      (await store.get<WorkflowPlanRecord>(WORKFLOW_STORE_KEYS.run(matchedRun.runId)).catch(() => undefined)) ??
      diskWorkflows.plans.get(matchedRun.runId);
    const dag = buildWorkflowDagInspection(matchedRun, graphRev, plan);
    const payload = { ok: true, ...dag, ...(plan ? { plan } : {}) };
    return {
      found: true,
      result: {
        code: 0,
        output: opts.json ? JSON.stringify(payload, null, 2) : formatDagInspection(dag),
        data: payload,
      },
    };
  }

  const message = `No persisted job or workflow run found matching '${trimmed}'`;
  return {
    found: false,
    result: {
      code: 1,
      output: opts.json
        ? JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message } }, null, 2)
        : color.red(message),
    },
  };
}

export async function agentsStatusCommand(
  opts: { json?: boolean; trustProject?: boolean; workspace?: string } = {},
): Promise<FabricCommandResult> {
  try {
    const { wazirHome, fabricDir, workspaceRoot } = resolveFabricPaths(opts.workspace);
    const discovery = new AgentConfigurationDiscovery();
    const discovered = discovery.discover({
      cwd: workspaceRoot,
      trustedProject: Boolean(opts.trustProject),
    });
    const cache = loadPreflightCache(path.join(wazirHome, 'agent-preflight.json'));
    const inboxSummary = readFabricInboxes(fabricDir);

    const nativeAgents = [
      { agent: 'coding', source: 'native' as const, state: 'READY', health: 'READY', registered: true },
      { agent: 'chat', source: 'native' as const, state: 'READY', health: 'READY', registered: true },
      { agent: 'step', source: 'native' as const, state: 'READY', health: 'READY', registered: true },
    ];

    const seen = new Set<string>();
    const rows: Array<{
      agent: string;
      source: 'native' | 'external' | 'cached' | 'inbox';
      registered: boolean;
      state: string;
      health: string;
      authentication: 'VERIFIED' | 'UNKNOWN';
      executable?: string;
      model?: string;
      endpointLocality?: string;
      inboxCount: number;
      inboxPending: number;
      checkedAt?: string;
      diagnostics?: string[];
    }> = [];

    for (const nat of nativeAgents) {
      seen.add(nat.agent);
      rows.push({
        agent: nat.agent,
        source: nat.source,
        registered: nat.registered,
        state: nat.state,
        health: nat.health,
        authentication: 'VERIFIED',
        inboxCount: inboxSummary.byAgent[nat.agent] ?? 0,
        inboxPending: inboxSummary.unreadByAgent[nat.agent] ?? 0,
      });
    }

    for (const cfg of discovered) {
      seen.add(cfg.agent);
      const cached: AgentPreflightResult | undefined = cache[cfg.agent];
      const fresh = Boolean(cached && (!cached.fingerprint || cached.fingerprint === cfg.fingerprint) && isPreflightFresh(cached));
      const health = fresh && cached ? effectivePreflightStatus(cached) : cached ? cached.status : 'UNKNOWN';
      const state = fresh ? health : cfg.state;
      rows.push({
        agent: cfg.agent,
        source: 'external',
        registered: Boolean(cfg.executable),
        state,
        health,
        authentication: fresh && health === 'READY' ? 'VERIFIED' : 'UNKNOWN',
        executable: cfg.executable,
        model: cfg.model?.value,
        endpointLocality: cfg.endpointLocality,
        inboxCount: inboxSummary.byAgent[cfg.agent] ?? 0,
        inboxPending: inboxSummary.unreadByAgent[cfg.agent] ?? 0,
        checkedAt: cached?.checkedAt,
        diagnostics: cfg.diagnostics,
      });
    }

    for (const [agentName, cached] of Object.entries(cache)) {
      if (seen.has(agentName)) continue;
      seen.add(agentName);
      const fresh = isPreflightFresh(cached);
      const health = effectivePreflightStatus(cached);
      rows.push({
        agent: agentName,
        source: 'cached',
        registered: true,
        state: fresh ? health : 'STALE',
        health,
        authentication: fresh && health === 'READY' ? 'VERIFIED' : 'UNKNOWN',
        inboxCount: inboxSummary.byAgent[agentName] ?? 0,
        inboxPending: inboxSummary.unreadByAgent[agentName] ?? 0,
        checkedAt: cached.checkedAt,
      });
    }

    for (const [inboxAgent, count] of Object.entries(inboxSummary.byAgent)) {
      if (seen.has(inboxAgent)) continue;
      seen.add(inboxAgent);
      rows.push({
        agent: inboxAgent,
        source: 'inbox',
        registered: false,
        state: 'INBOX_ONLY',
        health: 'UNKNOWN',
        authentication: 'UNKNOWN',
        inboxCount: count,
        inboxPending: inboxSummary.unreadByAgent[inboxAgent] ?? 0,
      });
    }

    const payload = {
      ok: true,
      fabricDir,
      totalInboxMessages: inboxSummary.totalMessages,
      pendingInboxMessages: inboxSummary.pendingTotal,
      inboxes: inboxSummary.byAgent,
      agents: rows,
    };

    if (opts.json) {
      return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
    }

    const lines: string[] = [
      color.bold(`Agents (${rows.length}) | Coordination Inbox Messages: ${inboxSummary.totalMessages} (${inboxSummary.pendingTotal} pending)`),
      '',
      table(
        ['AGENT', 'SOURCE', 'REGISTERED', 'STATE', 'HEALTH', 'INBOX', 'MODEL', 'EXECUTABLE'],
        rows.map((r) => [
          r.agent,
          r.source,
          r.registered ? 'yes' : 'no',
          r.state,
          r.health,
          r.inboxPending > 0 ? `${r.inboxCount} (${r.inboxPending} pending)` : String(r.inboxCount),
          r.model ?? '-',
          r.executable ?? '-',
        ]),
      ),
    ];

    return { code: 0, output: lines.join('\n'), data: payload };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      code: 1,
      output: opts.json ? JSON.stringify({ ok: false, error: { code: 'AGENTS_ERROR', message } }, null, 2) : color.red(message),
    };
  }
}

interface NormalizedMessageRow {
  id: string;
  jobId: string;
  taskId?: string;
  fromAgent?: string;
  toAgent?: string;
  type: string;
  priority: string;
  status?: string;
  source: 'job' | 'router' | 'fabric-events' | 'fabric-inbox' | 'fabric-outbox';
  timestamp: string;
  payload: unknown;
  artifactReferences?: string[];
}

function summarizePayload(payload: unknown): string {
  if (payload === undefined || payload === null) return '-';
  if (typeof payload === 'string') return payload.replace(/\s+/g, ' ').trim().slice(0, 60) || '-';
  try {
    return JSON.stringify(payload).slice(0, 60);
  } catch {
    return String(payload).slice(0, 60);
  }
}

function matchesAgentFilter(msg: NormalizedMessageRow, agentFilter: string): boolean {
  const target = agentFilter.trim().toLowerCase();
  return (
    (msg.fromAgent?.toLowerCase() ?? '') === target ||
    (msg.toAgent?.toLowerCase() ?? '') === target
  );
}

function toNormalizedMessage(
  raw: CoordinationEnvelopeLike,
  fallbackJobId: string,
  source: NormalizedMessageRow['source'],
  meta?: { recipientAgent?: string; status?: string; messageId?: string },
): NormalizedMessageRow {
  const payloadObj = raw.payload && typeof raw.payload === 'object' ? (raw.payload as Record<string, unknown>) : undefined;
  const jobId =
    (typeof raw.workflow_id === 'string' && raw.workflow_id) ||
    (typeof raw.jobId === 'string' && raw.jobId) ||
    (typeof raw.workflowId === 'string' && raw.workflowId) ||
    (typeof payloadObj?.jobId === 'string' && payloadObj.jobId) ||
    (typeof payloadObj?.workflowId === 'string' && payloadObj.workflowId) ||
    (typeof raw.correlation_id === 'string' && raw.correlation_id) ||
    (typeof raw.correlationId === 'string' && raw.correlationId) ||
    fallbackJobId;

  const taskId =
    (typeof raw.task_id === 'string' && raw.task_id) ||
    (typeof raw.taskId === 'string' && raw.taskId) ||
    (typeof payloadObj?.task_id === 'string' && payloadObj.task_id) ||
    (typeof payloadObj?.taskId === 'string' && payloadObj.taskId) ||
    undefined;

  const fromAgent =
    (typeof raw.source_agent === 'string' && raw.source_agent) ||
    (typeof raw.fromAgent === 'string' && raw.fromAgent) ||
    (typeof raw.from === 'string' && raw.from) ||
    (typeof payloadObj?.source_agent === 'string' && payloadObj.source_agent) ||
    (typeof payloadObj?.fromAgent === 'string' && payloadObj.fromAgent) ||
    undefined;

  const toAgent =
    (typeof raw.target_agent === 'string' && raw.target_agent) ||
    (typeof raw.toAgent === 'string' && raw.toAgent) ||
    (typeof raw.to === 'string' && raw.to) ||
    meta?.recipientAgent ||
    (typeof raw.agentId === 'string' && raw.agentId) ||
    (typeof payloadObj?.target_agent === 'string' && payloadObj.target_agent) ||
    (typeof payloadObj?.toAgent === 'string' && payloadObj.toAgent) ||
    undefined;

  const ts =
    toIsoString(raw.timestamp) ??
    toIsoString(raw.createdAt) ??
    toIsoString(raw.at) ??
    new Date(0).toISOString();

  const id =
    (typeof raw.event_id === 'string' && raw.event_id) ||
    (typeof raw.id === 'string' && raw.id) ||
    meta?.messageId ||
    `${source}:${jobId}:${taskId ?? ''}:${ts}:${String(raw.type ?? 'message')}`;

  const priority =
    (typeof raw.priority === 'string' && raw.priority) ||
    (typeof payloadObj?.priority === 'string' && payloadObj.priority) ||
    'normal';

  const artifactReferences = Array.isArray(raw.artifact_refs)
    ? raw.artifact_refs
    : Array.isArray(raw.artifactReferences)
      ? raw.artifactReferences
      : undefined;

  return {
    id,
    jobId,
    ...(taskId ? { taskId } : {}),
    ...(fromAgent ? { fromAgent } : {}),
    ...(toAgent ? { toAgent } : {}),
    type: typeof raw.type === 'string' ? raw.type : 'message',
    priority,
    ...(meta?.status ? { status: meta.status } : typeof raw.status === 'string' ? { status: raw.status } : {}),
    source,
    timestamp: ts,
    payload: raw.payload ?? raw.data ?? null,
    ...(artifactReferences ? { artifactReferences } : {}),
  };
}

function envelopeMatchesJobId(raw: CoordinationEnvelopeLike, targetJobId: string): boolean {
  const payloadObj = raw.payload && typeof raw.payload === 'object' ? (raw.payload as Record<string, unknown>) : undefined;
  const dataObj = raw.data && typeof raw.data === 'object' ? (raw.data as Record<string, unknown>) : undefined;
  const candidates = [
    raw.workflow_id,
    raw.jobId,
    raw.workflowId,
    raw.correlation_id,
    raw.correlationId,
    payloadObj?.workflow_id,
    payloadObj?.jobId,
    payloadObj?.workflowId,
    dataObj?.workflow_id,
    dataObj?.jobId,
    dataObj?.workflowId,
  ];
  return candidates.some((c) => typeof c === 'string' && normalizeJobId(c) === targetJobId);
}

export async function messagesCommand(
  jobId: string,
  opts: { agent?: string; task?: string; json?: boolean } = {},
): Promise<FabricCommandResult> {
  const { wazirHome, fabricDir } = resolveFabricPaths();
  const store = await openFastStore(wazirHome);
  const requestedId = normalizeJobId(jobId);
  let resolvedJobId = requestedId;
  let job = await store.get<Job>(`job/${requestedId}`);
  if (!job) {
    const jobEntries = await store.list('job/');
    const prefixMatches = jobEntries
      .map((e) => e.value as Job | undefined)
      .filter((j): j is Job => Boolean(j && typeof j.id === 'string' && (j.id === requestedId || j.id.startsWith(requestedId))));
    if (prefixMatches.length === 1) {
      job = prefixMatches[0];
      resolvedJobId = job!.id;
    }
  }

  let fabric: CoordinationFabricLike | undefined;
  try {
    const collected = new Map<string, NormalizedMessageRow>();
    const addMsg = (msg: NormalizedMessageRow) => {
      if (!collected.has(msg.id)) {
        collected.set(msg.id, msg);
      }
    };

    for (const jm of (job?.messages ?? []) as JobMessage[]) {
      addMsg(
        toNormalizedMessage(
          {
            id: jm.id,
            jobId: jm.jobId,
            taskId: jm.taskId,
            fromAgent: jm.fromAgent,
            toAgent: jm.toAgent,
            type: jm.type,
            payload: jm.payload,
            artifactReferences: jm.artifactReferences,
            priority: jm.priority,
            timestamp: jm.timestamp,
          },
          resolvedJobId,
          'job',
        ),
      );
    }

    const natsUrl = process.env.WAZIR_NATS_URL?.trim() || undefined;
    fabric = await createFabricInstanceIfAvailable({ fabricDir, store, natsUrl });
    const router = await createMessageRouterIfAvailable({
      fabric,
      jobManager: {
        get: (id: string) => (job && job.id === id ? job : undefined),
        list: () => (job ? [job] : []),
      },
    });

    if (router && typeof router.listMessages === 'function') {
      const routerMsgs = await withTimeout(
        Promise.resolve(
          router.listMessages(resolvedJobId, {
            ...(opts.agent ? { agentId: opts.agent } : {}),
          }),
        ),
        DEFAULT_FABRIC_OP_TIMEOUT_MS,
        [],
      );
      for (const item of routerMsgs) {
        const { envelope, inboxMeta } = unwrapEnvelope(item);
        if (envelope) {
          addMsg(
            toNormalizedMessage(envelope, resolvedJobId, 'router', {
              recipientAgent: inboxMeta?.recipientAgent,
              status: inboxMeta?.status,
              messageId: inboxMeta?.messageId,
            }),
          );
        }
      }
    }

    if (fabric && typeof fabric.replayEvents === 'function') {
      const fabricEvents = await withTimeout(
        Promise.resolve(fabric.replayEvents({ workflowId: resolvedJobId })),
        DEFAULT_FABRIC_OP_TIMEOUT_MS,
        [],
      );
      for (const item of fabricEvents) {
        const { envelope } = unwrapEnvelope(item);
        if (envelope && envelopeMatchesJobId(envelope, resolvedJobId)) {
          addMsg(toNormalizedMessage(envelope, resolvedJobId, 'fabric-events'));
        }
      }
    }

    const inboxData = readFabricInboxes(fabricDir);
    for (const item of inboxData.messages) {
      if (envelopeMatchesJobId(item.envelope, resolvedJobId)) {
        addMsg(
          toNormalizedMessage(item.envelope, resolvedJobId, 'fabric-inbox', {
            recipientAgent: item.recipientAgent,
            status: item.status,
            messageId: item.messageId,
          }),
        );
      }
    }

    for (const raw of readJsonRecordsFromTarget(path.join(fabricDir, 'outbox'), 2)) {
      const { envelope, outboxMeta } = unwrapEnvelope(raw);
      if (envelope && envelopeMatchesJobId(envelope, resolvedJobId)) {
        addMsg(toNormalizedMessage(envelope, resolvedJobId, 'fabric-outbox', { status: outboxMeta?.status }));
      }
    }

    for (const raw of readJsonRecordsFromTarget(path.join(fabricDir, 'events'), 2)) {
      const { envelope } = unwrapEnvelope(raw);
      if (envelope && envelopeMatchesJobId(envelope, resolvedJobId)) {
        addMsg(toNormalizedMessage(envelope, resolvedJobId, 'fabric-events'));
      }
    }

    let messages = Array.from(collected.values()).filter((m) => normalizeJobId(m.jobId) === resolvedJobId);
    if (opts.agent) {
      messages = messages.filter((m) => matchesAgentFilter(m, opts.agent!));
    }
    if (opts.task) {
      messages = messages.filter((m) => m.taskId === opts.task);
    }

    messages.sort((a, b) => toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp));

    const payload = {
      ok: true,
      jobId: resolvedJobId,
      foundJob: Boolean(job),
      count: messages.length,
      messages,
    };

    if (opts.json) {
      return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
    }

    if (messages.length === 0) {
      return {
        code: 0,
        output: color.yellow(`No messages found for '${resolvedJobId}'.`),
        data: payload,
      };
    }

    const lines: string[] = [
      color.bold(`Messages for ${resolvedJobId} (${messages.length})`),
      '',
      table(
        ['TIME', 'SOURCE', 'TYPE', 'FROM', 'TO', 'TASK', 'PRIORITY', 'PAYLOAD'],
        messages.map((m) => [
          m.timestamp.replace('T', ' ').slice(0, 19),
          m.source,
          m.type,
          m.fromAgent ?? '-',
          m.toAgent ?? '-',
          m.taskId ?? '-',
          m.priority,
          summarizePayload(m.payload),
        ]),
      ),
    ];

    return { code: 0, output: lines.join('\n'), data: payload };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      code: 1,
      output: opts.json ? JSON.stringify({ ok: false, error: { code: 'MESSAGES_ERROR', message } }, null, 2) : color.red(message),
    };
  } finally {
    await closeFabricSafely(fabric);
  }
}

interface TraceTimelineEntry {
  id: string;
  source: 'execution' | 'fabric';
  timestamp: string;
  sequence?: number;
  type: string;
  executionId?: string;
  taskId?: string;
  jobId?: string;
  agentId?: string;
  data?: unknown;
}

function matchesTraceCorrelation(raw: CoordinationEnvelopeLike, matchTokens: Set<string>): boolean {
  const payloadObj = raw.payload && typeof raw.payload === 'object' ? (raw.payload as Record<string, unknown>) : undefined;
  const dataObj = raw.data && typeof raw.data === 'object' ? (raw.data as Record<string, unknown>) : undefined;
  const fields = [
    raw.correlation_id,
    raw.correlationId,
    raw.task_id,
    raw.taskId,
    raw.executionId,
    raw.execution_id,
    payloadObj?.correlation_id,
    payloadObj?.correlationId,
    payloadObj?.task_id,
    payloadObj?.taskId,
    payloadObj?.executionId,
    payloadObj?.execution_id,
    dataObj?.correlation_id,
    dataObj?.correlationId,
    dataObj?.task_id,
    dataObj?.taskId,
    dataObj?.executionId,
    dataObj?.execution_id,
  ];
  return fields.some((val) => typeof val === 'string' && matchTokens.has(val));
}

export async function traceCommand(
  executionId: string,
  opts: { json?: boolean } = {},
): Promise<FabricCommandResult> {
  const { wazirHome, fabricDir } = resolveFabricPaths();
  const store = await openFastStore(wazirHome);
  const trimmedId = executionId.trim();

  let fabric: CoordinationFabricLike | undefined;
  try {
    const execEntries = await store.list('execution/');
    const loadedRecords = execEntries
      .map((e) => e.value as ExecutionRecord | undefined)
      .filter((r): r is ExecutionRecord => Boolean(r && r.execution && typeof r.execution.id === 'string'));

    const execEngine = new ExecutionEngine({
      load: async () => loadedRecords,
      fastStartup: true,
    });
    await execEngine.ready;

    let record = await execEngine.get(trimmedId);
    if (!record) {
      const all = await execEngine.list();
      record =
        all.find((r) => r.execution.id.startsWith(trimmedId)) ??
        all.find((r) => r.execution.id.includes(trimmedId)) ??
        all.find((r) => r.execution.taskId === trimmedId);
    }

    const resolvedExecId = record?.execution.id ?? trimmedId;
    const matchTokens = new Set<string>([trimmedId, resolvedExecId]);
    if (record?.execution.taskId) matchTokens.add(record.execution.taskId);

    const timeline: TraceTimelineEntry[] = [];
    const seenEventIds = new Set<string>();

    const pushTimeline = (entry: TraceTimelineEntry) => {
      if (seenEventIds.has(entry.id)) return;
      seenEventIds.add(entry.id);
      timeline.push(entry);
    };

    for (const ev of (record?.events ?? []) as ExecutionEvent[]) {
      const ts = toIsoString(ev.timestamp) ?? new Date(0).toISOString();
      pushTimeline({
        id: ev.eventId ?? ev.id ?? `exec:${resolvedExecId}:${ev.sequence ?? timeline.length}`,
        source: 'execution',
        timestamp: ts,
        ...(ev.sequence !== undefined ? { sequence: ev.sequence } : {}),
        type: ev.eventType ?? ev.type,
        executionId: ev.executionId,
        ...(record?.execution.taskId ? { taskId: record.execution.taskId } : {}),
        ...(ev.jobId ?? record?.execution.jobId ? { jobId: (ev.jobId ?? record?.execution.jobId) ?? undefined } : {}),
        ...(ev.agentId ?? record?.execution.agentId ? { agentId: ev.agentId ?? record?.execution.agentId } : {}),
        ...(ev.data !== undefined ? { data: ev.data } : {}),
      });
    }

    const natsUrl = process.env.WAZIR_NATS_URL?.trim() || undefined;
    fabric = await createFabricInstanceIfAvailable({ fabricDir, store, natsUrl });

    const fabricCandidates: CoordinationEnvelopeLike[] = [];
    if (fabric && typeof fabric.replayEvents === 'function') {
      const replayed = await withTimeout(
        Promise.resolve(fabric.replayEvents({})),
        DEFAULT_FABRIC_OP_TIMEOUT_MS,
        [],
      );
      for (const item of replayed) {
        const { envelope } = unwrapEnvelope(item);
        if (envelope) fabricCandidates.push(envelope);
      }
    }

    for (const subdir of ['events', 'outbox', 'inboxes']) {
      for (const item of readJsonRecordsFromTarget(path.join(fabricDir, subdir), 3)) {
        const { envelope } = unwrapEnvelope(item);
        if (envelope) fabricCandidates.push(envelope);
      }
    }

    for (const candidate of fabricCandidates) {
      if (!matchesTraceCorrelation(candidate, matchTokens)) continue;
      const payloadObj =
        candidate.payload && typeof candidate.payload === 'object'
          ? (candidate.payload as Record<string, unknown>)
          : undefined;
      const ts =
        toIsoString(candidate.timestamp) ??
        toIsoString(candidate.createdAt) ??
        toIsoString(candidate.at) ??
        new Date(0).toISOString();
      const id =
        (typeof candidate.event_id === 'string' && candidate.event_id) ||
        (typeof candidate.id === 'string' && candidate.id) ||
        `fabric:${ts}:${String(candidate.type ?? 'event')}:${String(candidate.correlation_id ?? candidate.correlationId ?? '')}`;

      pushTimeline({
        id,
        source: 'fabric',
        timestamp: ts,
        type: typeof candidate.type === 'string' ? candidate.type : 'fabric.event',
        executionId:
          (typeof candidate.executionId === 'string' && candidate.executionId) ||
          (typeof candidate.execution_id === 'string' && candidate.execution_id) ||
          (typeof payloadObj?.executionId === 'string' && payloadObj.executionId) ||
          (typeof payloadObj?.execution_id === 'string' && payloadObj.execution_id) ||
          resolvedExecId,
        taskId:
          (typeof candidate.task_id === 'string' && candidate.task_id) ||
          (typeof candidate.taskId === 'string' && candidate.taskId) ||
          (typeof payloadObj?.task_id === 'string' && payloadObj.task_id) ||
          (typeof payloadObj?.taskId === 'string' && payloadObj.taskId) ||
          record?.execution.taskId,
        jobId:
          (typeof candidate.workflow_id === 'string' && candidate.workflow_id) ||
          (typeof candidate.jobId === 'string' && candidate.jobId) ||
          (typeof candidate.workflowId === 'string' && candidate.workflowId) ||
          record?.execution.jobId,
        agentId:
          (typeof candidate.agentId === 'string' && candidate.agentId) ||
          (typeof candidate.target_agent === 'string' && candidate.target_agent) ||
          (typeof candidate.source_agent === 'string' && candidate.source_agent) ||
          (typeof candidate.toAgent === 'string' && candidate.toAgent) ||
          (typeof candidate.fromAgent === 'string' && candidate.fromAgent) ||
          record?.execution.agentId,
        data: candidate.payload ?? candidate.data ?? candidate,
      });
    }

    if (!record && timeline.length === 0) {
      const msg = `Execution '${trimmedId}' not found`;
      return {
        code: 1,
        output: opts.json ? JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: msg } }, null, 2) : color.red(msg),
      };
    }

    timeline.sort((a, b) => {
      const dt = toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp);
      if (dt !== 0) return dt;
      return (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER);
    });

    const payload = {
      ok: true,
      executionId: resolvedExecId,
      foundExecution: Boolean(record),
      status: record?.execution.status ?? null,
      taskId: record?.execution.taskId ?? null,
      jobId: record?.execution.jobId ?? null,
      agentId: record?.execution.agentId ?? null,
      modelId: record?.execution.modelId ?? null,
      createdAt: record ? toIsoString(record.execution.createdAt) ?? null : null,
      completedAt: record?.execution.completedAt ? toIsoString(record.execution.completedAt) ?? null : null,
      eventCount: timeline.length,
      events: timeline,
    };

    if (opts.json) {
      return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
    }

    const lines: string[] = [
      color.bold(`Trace: ${resolvedExecId}`),
      `  status:   ${payload.status ?? 'unknown'}`,
      `  task:     ${payload.taskId ?? '-'}`,
      `  job:      ${payload.jobId ?? '-'}`,
      `  agent:    ${payload.agentId ?? '-'}`,
      `  model:    ${payload.modelId ?? '-'}`,
      `  events:   ${timeline.length}`,
      '',
      table(
        ['TIME', 'SOURCE', 'SEQ', 'TYPE', 'AGENT', 'DETAIL'],
        timeline.map((ev) => [
          ev.timestamp.replace('T', ' ').slice(0, 23),
          ev.source,
          ev.sequence !== undefined ? String(ev.sequence) : '-',
          ev.type,
          ev.agentId ?? '-',
          summarizePayload(ev.data),
        ]),
      ),
    ];

    return { code: 0, output: lines.join('\n'), data: payload };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      code: 1,
      output: opts.json ? JSON.stringify({ ok: false, error: { code: 'TRACE_ERROR', message } }, null, 2) : color.red(message),
    };
  } finally {
    await closeFabricSafely(fabric);
  }
}

function readLocalLeases(fabricDir: string): Array<Record<string, unknown>> {
  const nowMs = Date.now();
  const candidates: Array<Record<string, unknown>> = [];

  for (const item of [
    ...readJsonRecordsFromTarget(path.join(fabricDir, 'leases'), 2),
    ...readJsonRecordsFromTarget(path.join(fabricDir, 'reservations'), 2),
    ...readJsonRecordsFromTarget(path.join(fabricDir, 'leases.json'), 1),
    ...readJsonRecordsFromTarget(path.join(fabricDir, 'reservations.json'), 1),
  ]) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      candidates.push(item as Record<string, unknown>);
    }
  }

  // Also inspect ResourceReservationManager's JsonFileStore file (`resource-reservations.json`)
  const resStoreFile = path.join(fabricDir, 'resource-reservations.json');
  if (existsSync(resStoreFile)) {
    try {
      const parsed = JSON.parse(readFileSync(resStoreFile, 'utf8')) as Record<string, unknown>;
      const resState = parsed?.reservations as { leases?: Record<string, Record<string, unknown>> } | undefined;
      if (resState?.leases && typeof resState.leases === 'object') {
        for (const lease of Object.values(resState.leases)) {
          if (lease && typeof lease === 'object') candidates.push(lease);
        }
      }
    } catch {
      // ignore unreadable reservation store
    }
  }

  return candidates.filter((rec) => {
    if (rec.released === true || rec.status === 'released' || rec.status === 'expired') return false;
    const exp = toTimestampMs(rec.expiresAt);
    if (exp > 0 && exp <= nowMs) return false;
    return true;
  });
}

function readStaleConsumers(fabricDir: string): Array<string | Record<string, unknown>> {
  const nowMs = Date.now();
  const raw = [
    ...readJsonRecordsFromTarget(path.join(fabricDir, 'consumers'), 2),
    ...readJsonRecordsFromTarget(path.join(fabricDir, 'consumers.json'), 1),
  ];
  const stale: Array<string | Record<string, unknown>> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const lastSeen = toTimestampMs(rec.lastHeartbeatAt ?? rec.lastSeenAt ?? rec.heartbeatAt ?? rec.updatedAt);
    const expires = toTimestampMs(rec.expiresAt);
    const pid = typeof rec.pid === 'number' ? rec.pid : undefined;
    let deadPid = false;
    if (pid && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EPERM') deadPid = true;
      }
    }
    const isExpired = expires > 0 && expires <= nowMs;
    const isIdleStale = lastSeen > 0 && nowMs - lastSeen > STALE_CONSUMER_THRESHOLD_MS;
    if (deadPid || isExpired || isIdleStale || rec.stale === true) {
      stale.push(typeof rec.consumerId === 'string' ? rec.consumerId : rec);
    }
  }
  return stale;
}

export async function fabricStatusCommand(opts: { json?: boolean } = {}): Promise<FabricCommandResult> {
  const { wazirHome, fabricDir } = resolveFabricPaths();
  const store = await openFastStore(wazirHome);
  const rawNatsUrl = process.env.WAZIR_NATS_URL?.trim() || undefined;
  let fabric: CoordinationFabricLike | undefined;

  try {
    fabric = await createFabricInstanceIfAvailable({ fabricDir, store, natsUrl: rawNatsUrl });
    const rawFabricStatus = fabric
      ? await withTimeout(Promise.resolve(fabric.getStatus()), DEFAULT_FABRIC_OP_TIMEOUT_MS, undefined)
      : undefined;

    const outboxFromFabric =
      fabric && typeof fabric.listOutbox === 'function'
        ? await withTimeout(Promise.resolve(fabric.listOutbox()), DEFAULT_FABRIC_OP_TIMEOUT_MS, undefined)
        : undefined;
    const dlqFromFabric =
      fabric && typeof fabric.listDeadLetters === 'function'
        ? await withTimeout(Promise.resolve(fabric.listDeadLetters()), DEFAULT_FABRIC_OP_TIMEOUT_MS, undefined)
        : undefined;

    const router = await createMessageRouterIfAvailable({ fabric });
    const dlqFromRouter =
      !dlqFromFabric && router && typeof router.listDeadLetters === 'function'
        ? await withTimeout(Promise.resolve(router.listDeadLetters()), DEFAULT_FABRIC_OP_TIMEOUT_MS, undefined)
        : undefined;

    const reservationMgr = existsSync(path.join(fabricDir, 'resource-reservations.json'))
      ? await createResourceReservationManagerIfAvailable(fabricDir)
      : undefined;
    const activeLeasesFromMgr =
      reservationMgr && typeof reservationMgr.listActiveLeases === 'function'
        ? await withTimeout(Promise.resolve(reservationMgr.listActiveLeases()), DEFAULT_FABRIC_OP_TIMEOUT_MS, undefined)
        : undefined;

    const natsProbe = await probeNatsTcp(rawNatsUrl, DEFAULT_NATS_PROBE_TIMEOUT_MS);

    const outboxDiskEntries = readJsonRecordsFromTarget(path.join(fabricDir, 'outbox'), 2).filter(
      (item): item is OutboxEntryLike => Boolean(item && typeof item === 'object' && !Array.isArray(item)),
    );
    const dlqDisk = [
      ...readJsonRecordsFromTarget(path.join(fabricDir, 'dlq'), 2),
      ...readJsonRecordsFromTarget(path.join(fabricDir, 'dead-letters'), 2),
      ...readJsonRecordsFromTarget(path.join(fabricDir, 'deadLetters'), 2),
    ];
    const inboxSummary = readFabricInboxes(fabricDir);

    const outboxPending = Array.isArray(outboxFromFabric)
      ? outboxFromFabric.filter((e) => {
          const s = (e as OutboxEntryLike)?.status;
          return s === 'pending' || s === 'failed';
        }).length
      : typeof rawFabricStatus?.outboxPending === 'number'
        ? rawFabricStatus.outboxPending
        : outboxDiskEntries.filter((e) => e.status === 'pending' || e.status === 'failed' || e.status === undefined).length;

    const dlqItems = dlqFromFabric ?? dlqFromRouter ?? dlqDisk;
    const dlqCount = Array.isArray(dlqItems)
      ? dlqItems.length
      : typeof rawFabricStatus?.dlqCount === 'number'
        ? rawFabricStatus.dlqCount
        : typeof rawFabricStatus?.outboxDeadLetters === 'number'
          ? rawFabricStatus.outboxDeadLetters
          : dlqDisk.length;

    const activeLeases = Array.isArray(activeLeasesFromMgr) ? activeLeasesFromMgr : readLocalLeases(fabricDir);
    const staleConsumers = Array.isArray(rawFabricStatus?.staleConsumers)
      ? (rawFabricStatus.staleConsumers as Array<string | Record<string, unknown>>)
      : readStaleConsumers(fabricDir);

    const transport =
      typeof rawFabricStatus?.transport === 'string'
        ? rawFabricStatus.transport
        : rawNatsUrl
          ? 'nats-jetstream'
          : existsSync(fabricDir)
            ? 'durable-local'
            : 'in-process';

    const rawCircuit =
      (typeof rawFabricStatus?.circuitState === 'string' && rawFabricStatus.circuitState) ||
      (rawFabricStatus?.broker &&
      typeof rawFabricStatus.broker === 'object' &&
      typeof (rawFabricStatus.broker as Record<string, unknown>).circuitState === 'string'
        ? String((rawFabricStatus.broker as Record<string, unknown>).circuitState)
        : undefined);

    const brokerCircuitState = rawNatsUrl
      ? !natsProbe.reachable
        ? 'open'
        : rawCircuit ?? 'closed'
      : rawCircuit ?? 'not-configured';

    const payload = {
      ok: true,
      fabricDir,
      exists: existsSync(fabricDir),
      transport,
      natsUrl: rawNatsUrl ? redactNatsUrl(rawNatsUrl) : null,
      natsReachable: rawNatsUrl ? natsProbe.reachable : null,
      brokerCircuitState,
      outbox: {
        pending: outboxPending,
        dlq: dlqCount,
      },
      inboxes: {
        totalMessages: inboxSummary.totalMessages,
        pendingMessages: inboxSummary.pendingTotal,
        byAgent: inboxSummary.byAgent,
        pendingByAgent: inboxSummary.unreadByAgent,
      },
      activeLeases: {
        count: activeLeases.length,
        leases: activeLeases,
      },
      staleConsumers: {
        count: staleConsumers.length,
        consumers: staleConsumers,
      },
      ...(rawFabricStatus ? { fabricStatus: rawFabricStatus } : {}),
    };

    if (opts.json) {
      return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
    }

    const lines: string[] = [
      color.bold('Coordination Fabric Status'),
      `  fabricDir:       ${fabricDir}${payload.exists ? '' : ' (not yet initialized)'}`,
      `  transport:       ${transport}`,
      `  broker circuit:  ${brokerCircuitState}`,
      ...(rawNatsUrl
        ? [
            `  nats:            ${payload.natsUrl} (${natsProbe.reachable ? color.green(`reachable ${natsProbe.latencyMs}ms`) : color.yellow(`offline: ${natsProbe.error ?? 'unreachable'}`)})`,
          ]
        : []),
      `  outbox pending:  ${outboxPending}`,
      `  outbox DLQ:      ${dlqCount}`,
      `  inbox messages:  ${inboxSummary.totalMessages} (${inboxSummary.pendingTotal} pending)`,
      `  active leases:   ${activeLeases.length}`,
      `  stale consumers: ${staleConsumers.length}`,
    ];

    const agentNames = Object.keys(inboxSummary.byAgent).sort();
    if (agentNames.length > 0) {
      lines.push('');
      lines.push(color.bold('Inboxes:'));
      for (const name of agentNames) {
        const pending = inboxSummary.unreadByAgent[name] ?? 0;
        lines.push(`  ${name}: ${inboxSummary.byAgent[name]}${pending > 0 ? ` (${pending} pending)` : ''}`);
      }
    }

    return { code: 0, output: lines.join('\n'), data: payload };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      code: 1,
      output: opts.json ? JSON.stringify({ ok: false, error: { code: 'FABRIC_STATUS_ERROR', message } }, null, 2) : color.red(message),
    };
  } finally {
    await closeFabricSafely(fabric);
  }
}

interface DiagnoseCheckResult {
  name: string;
  ok: boolean;
  status: 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
  durationMs: number;
  detail: string;
  data?: unknown;
}

function validateCoordinationEnvelopeFallback(env: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { valid: false, errors: ['Envelope must be a non-null object'] };
  }
  const rec = env as Record<string, unknown>;
  if (typeof rec.event_id !== 'string' || !rec.event_id.trim()) errors.push('Missing string event_id');
  if (typeof rec.schema_version !== 'string' || !/^1\.\d+$/.test(rec.schema_version)) {
    errors.push('Invalid schema_version');
  }
  if (typeof rec.type !== 'string' || !rec.type.trim()) errors.push('Missing string type');
  if (typeof rec.workflow_id !== 'string' || !rec.workflow_id.trim()) errors.push('Missing string workflow_id');
  if (typeof rec.correlation_id !== 'string' || !rec.correlation_id.trim()) errors.push('Missing string correlation_id');
  if (typeof rec.timestamp !== 'string' || !Number.isFinite(Date.parse(rec.timestamp))) {
    errors.push('Invalid ISO timestamp');
  }
  if (!('payload' in rec) || rec.payload === undefined) errors.push('Missing payload');
  if (!Array.isArray(rec.artifact_refs)) errors.push('Missing artifact_refs array');
  return { valid: errors.length === 0, errors };
}

export async function fabricDiagnoseCommand(opts: { json?: boolean } = {}): Promise<FabricCommandResult> {
  const { fabricDir } = resolveFabricPaths();
  const rawNatsUrl = process.env.WAZIR_NATS_URL?.trim() || undefined;
  const checks: DiagnoseCheckResult[] = [];
  const probeRoot = path.join(fabricDir, 'tmp', `diagnose-${process.pid}-${randomUUID().slice(0, 8)}`);
  let diagFabric: CoordinationFabricLike | undefined;

  try {
    // 1. fabricDir readability & writability
    const t0 = performance.now();
    let dirWritable = false;
    try {
      await fs.mkdir(probeRoot, { recursive: true, mode: 0o700 });
      await fs.access(fabricDir, constants.R_OK | constants.W_OK);
      const rwFile = path.join(probeRoot, 'rw-check.json');
      const token = randomUUID();
      await fs.writeFile(rwFile, JSON.stringify({ token }), { mode: 0o600 });
      const readBack = JSON.parse(await fs.readFile(rwFile, 'utf8')) as { token?: string };
      if (readBack.token !== token) throw new Error('Read-back verification mismatch');
      dirWritable = true;
      checks.push({
        name: 'fabricDir',
        ok: true,
        status: 'PASS',
        durationMs: Math.round(performance.now() - t0),
        detail: `Readable and writable (${fabricDir})`,
      });
    } catch (err) {
      checks.push({
        name: 'fabricDir',
        ok: false,
        status: 'FAIL',
        durationMs: Math.round(performance.now() - t0),
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Envelope schema validation self-check
    const t1 = performance.now();
    try {
      const core = await getCoreExports();
      const validateFn =
        typeof core.validateCoordinationEnvelope === 'function'
          ? (core.validateCoordinationEnvelope as (e: unknown) => { valid: boolean; errors: string[] })
          : validateCoordinationEnvelopeFallback;

      const validSample = {
        event_id: `evt-${randomUUID()}`,
        schema_version: '1.0',
        type: 'agent.message',
        workflow_id: 'job-diagnose',
        task_id: 'task-diagnose',
        source_agent: 'diagnose',
        target_agent: 'diagnose-sink',
        correlation_id: 'corr-diagnose',
        timestamp: new Date().toISOString(),
        payload: { ok: true },
        artifact_refs: [],
      };
      const validCheck = validateFn(validSample);
      const invalidCheck = validateFn({ bad: true });
      if (!validCheck.valid || invalidCheck.valid) {
        throw new Error(`Envelope schema self-check failed: ${validCheck.errors.join('; ')}`);
      }
      checks.push({
        name: 'envelopeSchema',
        ok: true,
        status: 'PASS',
        durationMs: Math.round(performance.now() - t1),
        detail: 'Envelope schema accepts valid v1.0 envelope and rejects malformed envelope',
      });
    } catch (err) {
      checks.push({
        name: 'envelopeSchema',
        ok: false,
        status: 'FAIL',
        durationMs: Math.round(performance.now() - t1),
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. Local outbox/inbox roundtrip in isolated temp/diagnose subdir
    const t2 = performance.now();
    try {
      const isolatedDir = dirWritable
        ? path.join(probeRoot, 'roundtrip')
        : await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-fabric-diag-'));
      try {
        diagFabric = await createFabricInstanceIfAvailable({
          fabricDir: isolatedDir,
          store: new MemoryStore(),
        });
        let fabricDiagResult: Record<string, unknown> | undefined;
        if (diagFabric && typeof diagFabric.diagnose === 'function') {
          fabricDiagResult = await withTimeout(
            Promise.resolve(diagFabric.diagnose()),
            DEFAULT_FABRIC_OP_TIMEOUT_MS,
            undefined,
          );
          if (fabricDiagResult && fabricDiagResult.ok === false) {
            throw new Error('CoordinationFabric.diagnose() reported failure in isolated subdir');
          }
        }

        const outboxDir = path.join(isolatedDir, 'outbox');
        const inboxDir = path.join(isolatedDir, 'inboxes', 'diag-agent');
        await fs.mkdir(outboxDir, { recursive: true, mode: 0o700 });
        await fs.mkdir(inboxDir, { recursive: true, mode: 0o700 });

        const nonce = randomUUID();
        const envelope = {
          event_id: `evt-diag-${nonce}`,
          schema_version: '1.0',
          type: 'agent.message',
          workflow_id: 'job-diagnose-roundtrip',
          task_id: 'task-diagnose',
          source_agent: 'diagnose-sender',
          target_agent: 'diag-agent',
          correlation_id: 'corr-diagnose-roundtrip',
          timestamp: new Date().toISOString(),
          payload: { probe: 'roundtrip', nonce },
          artifact_refs: [],
        };
        const outFile = path.join(outboxDir, `${envelope.event_id}.json`);
        const inFile = path.join(inboxDir, 'inbox.json');
        await fs.writeFile(outFile, JSON.stringify({ id: envelope.event_id, envelope, status: 'pending', attempts: 0 }), {
          mode: 0o600,
        });
        await fs.writeFile(
          inFile,
          JSON.stringify([{ messageId: `msg-${nonce}`, envelope, status: 'queued', recipientAgent: 'diag-agent', attempts: 0, maxDeliveries: 3, visibleAt: Date.now() }]),
          { mode: 0o600 },
        );
        const received = JSON.parse(await fs.readFile(inFile, 'utf8')) as Array<{ envelope: typeof envelope }>;
        if (!Array.isArray(received) || received[0]?.envelope?.event_id !== envelope.event_id || received[0]?.envelope?.payload?.nonce !== nonce) {
          throw new Error('Local outbox/inbox roundtrip payload mismatch');
        }
        await fs.unlink(outFile);
        await fs.unlink(inFile);

        checks.push({
          name: 'outboxInboxRoundtrip',
          ok: true,
          status: 'PASS',
          durationMs: Math.round(performance.now() - t2),
          detail: fabricDiagResult
            ? 'Local outbox/inbox roundtrip and CoordinationFabric.diagnose() succeeded'
            : 'Local outbox/inbox roundtrip succeeded in isolated diagnose subdir',
          ...(fabricDiagResult ? { data: fabricDiagResult } : {}),
        });
      } finally {
        await closeFabricSafely(diagFabric);
        diagFabric = undefined;
        if (!dirWritable) {
          await fs.rm(isolatedDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } catch (err) {
      checks.push({
        name: 'outboxInboxRoundtrip',
        ok: false,
        status: 'FAIL',
        durationMs: Math.round(performance.now() - t2),
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // 4. Resource lease store check
    const t3 = performance.now();
    try {
      let leaseCount = 0;
      const leaseStoreExists = existsSync(path.join(fabricDir, 'resource-reservations.json'));
      const mgr = leaseStoreExists ? await createResourceReservationManagerIfAvailable(fabricDir) : undefined;
      if (mgr && typeof mgr.listActiveLeases === 'function') {
        const active = await withTimeout(Promise.resolve(mgr.listActiveLeases()), DEFAULT_FABRIC_OP_TIMEOUT_MS, []);
        leaseCount = Array.isArray(active) ? active.length : 0;
      } else {
        leaseCount = readLocalLeases(fabricDir).length;
      }
      checks.push({
        name: 'leaseStore',
        ok: true,
        status: 'PASS',
        durationMs: Math.round(performance.now() - t3),
        detail: `Resource lease store readable (${leaseCount} active lease(s))`,
        data: { activeLeases: leaseCount },
      });
    } catch (err) {
      checks.push({
        name: 'leaseStore',
        ok: false,
        status: 'FAIL',
        durationMs: Math.round(performance.now() - t3),
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // 5. Bounded non-blocking NATS TCP probe (<= 250ms)
    const natsProbe = await probeNatsTcp(rawNatsUrl, DEFAULT_NATS_PROBE_TIMEOUT_MS);
    if (!natsProbe.configured) {
      checks.push({
        name: 'natsProbe',
        ok: true,
        status: 'SKIP',
        durationMs: 0,
        detail: 'WAZIR_NATS_URL not configured; using durable-local transport',
        data: natsProbe,
      });
    } else if (natsProbe.reachable) {
      checks.push({
        name: 'natsProbe',
        ok: true,
        status: 'PASS',
        durationMs: natsProbe.latencyMs,
        detail: `Connected to ${natsProbe.host}:${natsProbe.port} in ${natsProbe.latencyMs}ms`,
        data: natsProbe,
      });
    } else {
      checks.push({
        name: 'natsProbe',
        ok: true,
        status: 'WARN',
        durationMs: natsProbe.latencyMs,
        detail: `NATS unreachable at ${natsProbe.url} (${natsProbe.error ?? 'offline'}); durable-local fallback active`,
        data: natsProbe,
      });
    }

    const localFailures = checks.filter((c) => !c.ok);
    const degraded = checks.some((c) => c.status === 'WARN');
    const ok = localFailures.length === 0;
    const payload = {
      ok,
      degraded,
      fabricDir,
      natsConfigured: natsProbe.configured,
      natsReachable: natsProbe.configured ? natsProbe.reachable : null,
      checks,
    };

    if (opts.json) {
      return { code: ok ? 0 : 1, output: JSON.stringify(payload, null, 2), data: payload };
    }

    const lines: string[] = [
      color.bold(`Coordination Fabric Diagnostics (${ok ? (degraded ? 'DEGRADED' : 'HEALTHY') : 'FAILED'})`),
      `  fabricDir: ${fabricDir}`,
      '',
      table(
        ['CHECK', 'STATUS', 'TIME', 'DETAIL'],
        checks.map((c) => [c.name, c.status, `${c.durationMs}ms`, c.detail]),
      ),
    ];

    return { code: ok ? 0 : 1, output: lines.join('\n'), data: payload };
  } finally {
    await closeFabricSafely(diagFabric);
    await fs.rm(probeRoot, { recursive: true, force: true }).catch(() => undefined);
    const tmpParent = path.join(fabricDir, 'tmp');
    try {
      if (existsSync(tmpParent) && readdirSync(tmpParent).length === 0) {
        await fs.rmdir(tmpParent).catch(() => undefined);
      }
    } catch {
      // ignore cleanup failure
    }
  }
}
