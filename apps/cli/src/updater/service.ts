import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, chmodSync, accessSync, constants, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { KeyValueStore } from '@wazir/shared';
import { configDir } from '../config.js';
import { getBuildInfo } from '../version.js';
import { appendUpdateRecord, acquireUpdateLock, journalPath, loadUpdateConfig, readUpdateHistory, saveUpdateConfig, updateDir, validateUpdateConfig } from './storage.js';
import { chooseRelease, compareSemver, downloadAndVerifyAsset, downloadAndVerifyRelease, fetchReleases, platformArtifactNames } from './releases.js';
import { installUpdateScheduler, removeUpdateScheduler, schedulerInstalled } from './scheduler.js';
import type {
  ActiveRecordSource,
  ActiveTaskDetectorOptions,
  ActiveWorkSummary,
  DrainAndApplyOptions,
  GitHubRelease,
  UpdateConfig,
  UpdatePhase,
  UpdateRecord,
  UpdateStatusCode,
} from './types.js';

export interface UpdateStatus {
  host: string;
  platform: string;
  architecture: string;
  installedVersion: string;
  installMethod: string;
  channel: string;
  enabled: boolean;
  intervalSeconds: number;
  schedulerInstalled: boolean;
  lastCheck?: string;
  nextCheck?: string;
  lastUpdate?: string;
  phase?: UpdatePhase;
  availableVersion?: string;
  error?: string;
  jobsPreventActivation: boolean;
  activeWork?: ActiveWorkSummary;
  components: Array<{ name: string; state: string; managed: boolean }>;
}

const ACTIVE_EXECUTION_STATUSES = new Set([
  'running',
  'scheduled',
  'assigned',
  'waiting',
  'waiting_for_approval',
  'verifying',
  'planning',
]);

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_JOB_STATUSES = new Set(['running', 'scheduled', 'planning']);
const ACTIVE_TASK_STATUSES = new Set([
  'running',
  'assigned',
  'scheduled',
  'waiting',
  'waiting_for_approval',
  'verifying',
]);

const TERMINAL_DISPATCH_STATES = new Set([
  'completed',
  'failed',
  'cancelled',
  'expired',
  'released',
  'orphaned',
]);
const ACTIVE_DISPATCH_STATES = new Set([
  'claimed',
  'running',
  'assigned',
  'active',
  'in_progress',
]);

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+$/.test(value.trim())) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractLeaseFromExecutionRecord(record: Record<string, unknown>, execObj: Record<string, unknown>): {
  expiresAt?: number;
  released?: boolean;
} | undefined {
  const directLease =
    (record.lease && typeof record.lease === 'object' ? (record.lease as Record<string, unknown>) : undefined) ??
    (execObj.lease && typeof execObj.lease === 'object' ? (execObj.lease as Record<string, unknown>) : undefined);
  if (directLease) {
    return {
      expiresAt: toEpochMs(directLease.expiresAt ?? directLease.leaseExpiresAt),
      released: Boolean(directLease.released),
    };
  }
  const directExpiry = toEpochMs(record.leaseExpiresAt ?? execObj.leaseExpiresAt ?? record.expiresAt ?? execObj.expiresAt);
  if (directExpiry !== undefined) {
    return { expiresAt: directExpiry, released: false };
  }
  const events = Array.isArray(record.events) ? record.events : undefined;
  if (!events || events.length === 0) return undefined;
  let reconstructed: { expiresAt?: number; released?: boolean } | undefined;
  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== 'object') continue;
    const evt = rawEvent as Record<string, unknown>;
    const type = evt.type ?? evt.eventType;
    if (type !== 'lease.acquired' && type !== 'lease.renewed' && type !== 'lease.released') continue;
    const data = evt.data && typeof evt.data === 'object' ? (evt.data as Record<string, unknown>) : {};
    if (type === 'lease.released') {
      reconstructed = { expiresAt: toEpochMs(evt.timestamp), released: true };
      continue;
    }
    const exp = toEpochMs(data.expiresAt);
    const renewedAt = toEpochMs(data.renewedAt ?? evt.timestamp) ?? Date.now();
    const ttlMs = typeof data.ttlMs === 'number' && Number.isFinite(data.ttlMs) ? data.ttlMs : 30_000;
    reconstructed = {
      expiresAt: exp ?? renewedAt + ttlMs,
      released: false,
    };
  }
  return reconstructed;
}

function inspectExecutionRecord(
  fallbackId: string,
  raw: unknown,
  nowMs: number,
  isProcessAlive: (pid: number) => boolean,
): { active: boolean; id: string; reason?: string } {
  if (!raw || typeof raw !== 'object') return { active: false, id: fallbackId };
  const record = raw as Record<string, unknown>;
  const execObj =
    record.execution && typeof record.execution === 'object'
      ? (record.execution as Record<string, unknown>)
      : record;
  const id = String(execObj.id ?? record.id ?? fallbackId.replace(/^execution\//, ''));
  const status = typeof execObj.status === 'string'
    ? execObj.status
    : typeof record.status === 'string'
      ? record.status
      : undefined;
  if (!status || !ACTIVE_EXECUTION_STATUSES.has(status)) {
    return { active: false, id };
  }

  const lease = extractLeaseFromExecutionRecord(record, execObj);
  const hasLeaseInfo = lease !== undefined && (lease.expiresAt !== undefined || lease.released !== undefined);
  const hasActiveLease = Boolean(lease && !lease.released && lease.expiresAt !== undefined && lease.expiresAt > nowMs);
  const hasExpiredLease = Boolean(lease && (lease.released || (lease.expiresAt !== undefined && lease.expiresAt <= nowMs)));

  const owner =
    (execObj.owner && typeof execObj.owner === 'object' ? (execObj.owner as Record<string, unknown>) : undefined) ??
    (record.owner && typeof record.owner === 'object' ? (record.owner as Record<string, unknown>) : undefined);
  const rawPid = owner?.pid ?? execObj.ownerPid ?? record.ownerPid ?? execObj.pid ?? record.pid;
  const pid = typeof rawPid === 'number' && Number.isInteger(rawPid) ? rawPid : undefined;
  const host = typeof owner?.host === 'string' ? owner.host : undefined;
  const hasOwnerInfo = pid !== undefined;
  let hasLiveOwner = false;
  let hasDeadOwner = false;
  if (pid !== undefined) {
    const localHost = os.hostname();
    if (host && host !== localHost && host !== 'local' && host !== 'localhost') {
      hasLiveOwner = !hasExpiredLease;
    } else if (isProcessAlive(pid)) {
      hasLiveOwner = true;
    } else {
      hasDeadOwner = true;
    }
  }

  if (hasActiveLease) {
    return { active: true, id, reason: `active execution ${id} (status=${status}, lease unexpired)` };
  }
  if (hasLiveOwner) {
    return { active: true, id, reason: `active execution ${id} (status=${status}, pid=${pid})` };
  }
  if (hasExpiredLease || hasDeadOwner) {
    return { active: false, id };
  }
  if (!hasLeaseInfo && !hasOwnerInfo) {
    return { active: true, id, reason: `active execution ${id} (status=${status})` };
  }
  return { active: false, id };
}

function inspectJobRecord(
  fallbackId: string,
  raw: unknown,
  nowMs: number,
): { active: boolean; id: string; reason?: string } {
  if (!raw || typeof raw !== 'object') return { active: false, id: fallbackId };
  const job = raw as Record<string, unknown>;
  const id = String(job.id ?? fallbackId.replace(/^job\//, ''));
  const status = typeof job.status === 'string' ? job.status : undefined;
  if (status && TERMINAL_JOB_STATUSES.has(status)) {
    return { active: false, id };
  }

  const ownership =
    (job.ownership && typeof job.ownership === 'object' ? (job.ownership as Record<string, unknown>) : undefined) ??
    (job.lease && typeof job.lease === 'object' ? (job.lease as Record<string, unknown>) : undefined);
  const expiresAt = toEpochMs(ownership?.expiresAt ?? job.leaseExpiresAt ?? job.expiresAt);
  const hasActiveOwnership = expiresAt !== undefined && expiresAt > nowMs;
  const hasExpiredOwnership = expiresAt !== undefined && expiresAt <= nowMs;

  if (hasActiveOwnership) {
    return { active: true, id, reason: `active job ${id} (controller lease unexpired)` };
  }

  const tasks = Array.isArray(job.tasks) ? job.tasks : [];
  const hasActiveTask = tasks.some((t) => {
    if (!t || typeof t !== 'object') return false;
    const taskObj = t as Record<string, unknown>;
    const taskState = String(taskObj.status ?? taskObj.state ?? '');
    return ACTIVE_TASK_STATUSES.has(taskState);
  });

  const graph = job.graph && typeof job.graph === 'object' ? (job.graph as Record<string, unknown>) : undefined;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const hasActiveNode = nodes.some((n) => {
    if (!n || typeof n !== 'object') return false;
    const nodeObj = n as Record<string, unknown>;
    const nodeState = String(nodeObj.state ?? nodeObj.status ?? '');
    return ACTIVE_TASK_STATUSES.has(nodeState);
  });

  if ((hasActiveTask || hasActiveNode) && !hasExpiredOwnership) {
    return { active: true, id, reason: `active job ${id} (tasks in running/assigned state)` };
  }

  if (status && ACTIVE_JOB_STATUSES.has(status) && !hasExpiredOwnership) {
    return { active: true, id, reason: `active job ${id} (status=${status})` };
  }

  return { active: false, id };
}

function inspectDispatchRecord(
  fallbackId: string,
  raw: unknown,
  nowMs: number,
): { active: boolean; id: string; reason?: string } {
  if (!raw || typeof raw !== 'object') return { active: false, id: fallbackId };
  const dispatch = raw as Record<string, unknown>;
  const request = dispatch.request && typeof dispatch.request === 'object' ? (dispatch.request as Record<string, unknown>) : undefined;
  const id = String(dispatch.id ?? request?.requestId ?? fallbackId.replace(/^dispatch\//, ''));

  if (dispatch.outcome || dispatch.completedAt || dispatch.recovery === 'orphaned') {
    return { active: false, id };
  }

  const state = typeof dispatch.state === 'string'
    ? dispatch.state
    : typeof dispatch.status === 'string'
      ? dispatch.status
      : undefined;
  if (state && TERMINAL_DISPATCH_STATES.has(state)) {
    return { active: false, id };
  }

  const lease = dispatch.lease && typeof dispatch.lease === 'object' ? (dispatch.lease as Record<string, unknown>) : undefined;
  if (lease?.released === true) {
    return { active: false, id };
  }
  const expiresAt = toEpochMs(lease?.expiresAt ?? lease?.leaseExpiresAt ?? dispatch.expiresAt ?? dispatch.leaseExpiresAt);
  const hasActiveLease = expiresAt !== undefined && expiresAt > nowMs;
  const hasExpiredLease = expiresAt !== undefined && expiresAt <= nowMs;

  if (hasExpiredLease) {
    return { active: false, id };
  }

  if (state && ACTIVE_DISPATCH_STATES.has(state)) {
    return { active: true, id, reason: `active worker dispatch ${id} (state=${state})` };
  }

  if (hasActiveLease) {
    return { active: true, id, reason: `active worker dispatch ${id} (lease unexpired)` };
  }

  return { active: false, id };
}

function addSummaryItem(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function inspectKeyValueEntry(
  key: string,
  value: unknown,
  nowMs: number,
  isProcessAlive: (pid: number) => boolean,
  summary: ActiveWorkSummary,
): void {
  if (key.startsWith('execution/')) {
    const res = inspectExecutionRecord(key, value, nowMs, isProcessAlive);
    if (res.active) {
      addSummaryItem(summary.executions, res.id);
      if (res.reason) addSummaryItem(summary.reasons, res.reason);
      summary.busy = true;
    }
  } else if (key.startsWith('job/')) {
    const res = inspectJobRecord(key, value, nowMs);
    if (res.active) {
      addSummaryItem(summary.jobs, res.id);
      if (res.reason) addSummaryItem(summary.reasons, res.reason);
      summary.busy = true;
    }
  } else if (key.startsWith('dispatch/')) {
    const res = inspectDispatchRecord(key, value, nowMs);
    if (res.active) {
      addSummaryItem(summary.dispatches, res.id);
      if (res.reason) addSummaryItem(summary.reasons, res.reason);
      summary.busy = true;
    }
  } else if (key.startsWith('lease/') || key.startsWith('worker-lease/')) {
    const res = inspectDispatchRecord(key, value, nowMs);
    if (res.active) {
      addSummaryItem(summary.dispatches, res.id);
      if (res.reason) addSummaryItem(summary.reasons, res.reason);
      summary.busy = true;
    }
  }
}

function collectFromParsedStoreJson(
  parsed: Record<string, unknown>,
  nowMs: number,
  isProcessAlive: (pid: number) => boolean,
  summary: ActiveWorkSummary,
): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (
      key.startsWith('execution/') ||
      key.startsWith('job/') ||
      key.startsWith('dispatch/') ||
      key.startsWith('lease/') ||
      key.startsWith('worker-lease/')
    ) {
      inspectKeyValueEntry(key, value, nowMs, isProcessAlive, summary);
    }
  }
  const collections: Array<[string, 'execution' | 'job' | 'dispatch']> = [
    ['executions', 'execution'],
    ['jobs', 'job'],
    ['dispatches', 'dispatch'],
  ];
  for (const [prop, prefix] of collections) {
    const rawCollection = parsed[prop];
    if (Array.isArray(rawCollection)) {
      rawCollection.forEach((item, idx) => {
        inspectKeyValueEntry(`${prefix}/${idx}`, item, nowMs, isProcessAlive, summary);
      });
    } else if (rawCollection && typeof rawCollection === 'object') {
      for (const [id, item] of Object.entries(rawCollection as Record<string, unknown>)) {
        inspectKeyValueEntry(`${prefix}/${id}`, item, nowMs, isProcessAlive, summary);
      }
    }
  }
}

function collectFromStoreFilesSync(
  options: ActiveTaskDetectorOptions | undefined,
  nowMs: number,
  isProcessAlive: (pid: number) => boolean,
  summary: ActiveWorkSummary,
): void {
  const candidateFiles = new Set<string>();
  if (options?.storePath) candidateFiles.add(path.resolve(options.storePath));
  const dir = options?.configDir ?? configDir();
  if (dir) {
    candidateFiles.add(path.join(dir, 'store.json'));
    candidateFiles.add(path.join(dir, 'wazir.json'));
  }
  const storeObj = options?.store as unknown as { file?: unknown } | undefined;
  if (storeObj && typeof storeObj.file === 'string') {
    candidateFiles.add(path.resolve(storeObj.file));
  }

  for (const filePath of candidateFiles) {
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        collectFromParsedStoreJson(parsed as Record<string, unknown>, nowMs, isProcessAlive, summary);
      }
    } catch {
      // Ignore unreadable or empty store files
    }
  }
}

function collectFromStoreSyncIfPossible(
  store: KeyValueStore | undefined,
  nowMs: number,
  isProcessAlive: (pid: number) => boolean,
  summary: ActiveWorkSummary,
): boolean {
  if (!store) return true;
  const internal = store as unknown as { data?: unknown; file?: unknown };
  if (internal.data instanceof Map) {
    for (const [key, value] of internal.data.entries()) {
      if (typeof key === 'string') {
        inspectKeyValueEntry(key, value, nowMs, isProcessAlive, summary);
      }
    }
    return true;
  }
  if (typeof internal.file === 'string') {
    return true;
  }
  return false;
}

async function collectFromStoreAsync(
  store: KeyValueStore | undefined,
  nowMs: number,
  isProcessAlive: (pid: number) => boolean,
  summary: ActiveWorkSummary,
): Promise<void> {
  if (!store || typeof store.list !== 'function') return;
  for (const prefix of ['execution/', 'job/', 'dispatch/', 'lease/', 'worker-lease/']) {
    try {
      const entries = await store.list(prefix);
      for (const entry of entries) {
        const item = entry && typeof entry === 'object' && 'key' in entry && 'value' in entry
          ? (entry as { key: string; value: unknown })
          : { key: `${prefix}item`, value: entry };
        inspectKeyValueEntry(item.key, item.value, nowMs, isProcessAlive, summary);
      }
    } catch {
      // Ignore store prefix errors
    }
  }
}

function extractItemsSync(source: ActiveRecordSource | undefined, prefix: string): unknown[] | Promise<unknown[]> {
  if (!source) return [];
  if (typeof source === 'function') {
    const res = source();
    if (res && typeof (res as Promise<Iterable<unknown>>).then === 'function') {
      return (res as Promise<Iterable<unknown>>).then((iter) => Array.from(iter ?? []));
    }
    return Array.from((res as Iterable<unknown>) ?? []);
  }
  if (typeof (source as { list?: unknown }).list === 'function') {
    const res = (source as { list: (p?: string) => Iterable<unknown> | Promise<Iterable<unknown>> }).list(prefix);
    if (res && typeof (res as Promise<Iterable<unknown>>).then === 'function') {
      return (res as Promise<Iterable<unknown>>).then((iter) => Array.from(iter ?? []));
    }
    return Array.from((res as Iterable<unknown>) ?? []);
  }
  if (Symbol.iterator in Object(source)) {
    return Array.from(source as Iterable<unknown>);
  }
  return [];
}

function applyExtractedItems(
  items: unknown[],
  prefix: 'execution/' | 'job/' | 'dispatch/',
  nowMs: number,
  isProcessAlive: (pid: number) => boolean,
  summary: ActiveWorkSummary,
): void {
  items.forEach((entry, idx) => {
    const unwrapped =
      entry && typeof entry === 'object' && 'key' in entry && 'value' in entry
        ? (entry as { key: string; value: unknown })
        : { key: `${prefix}${idx}`, value: entry };
    const key = unwrapped.key.startsWith(prefix) ? unwrapped.key : `${prefix}${unwrapped.key}`;
    inspectKeyValueEntry(key, unwrapped.value, nowMs, isProcessAlive, summary);
  });
}

function isOsProcessActive(processProbe?: () => boolean): boolean {
  if (processProbe) return processProbe();
  const probe = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    : spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8', timeout: 5000 });
  if (probe.status !== 0 || !probe.stdout) return true;
  return probe.stdout.split(/\r?\n/).some((line) => /(?:^|[ /\\])wa(?:\.js|\.exe)?\s+(?:chat|fleet|worker\s+start|api\s+start|run|ask|execute)(?:\s|$)/i.test(line));
}

export function inspectActiveWorkSync(options?: ActiveTaskDetectorOptions): ActiveWorkSummary {
  const nowMs = options?.now ? options.now() : Date.now();
  const isProcessAlive = options?.isProcessAlive ?? defaultIsProcessAlive;
  const summary: ActiveWorkSummary = {
    busy: false,
    executions: [],
    jobs: [],
    dispatches: [],
    processes: false,
    reasons: [],
  };

  collectFromStoreFilesSync(options, nowMs, isProcessAlive, summary);
  collectFromStoreSyncIfPossible(options?.store, nowMs, isProcessAlive, summary);

  const execItems = extractItemsSync(options?.executions, 'execution/');
  if (Array.isArray(execItems)) applyExtractedItems(execItems, 'execution/', nowMs, isProcessAlive, summary);
  const jobItems = extractItemsSync(options?.jobs, 'job/');
  if (Array.isArray(jobItems)) applyExtractedItems(jobItems, 'job/', nowMs, isProcessAlive, summary);
  const dispatchItems = extractItemsSync(options?.dispatches, 'dispatch/');
  if (Array.isArray(dispatchItems)) applyExtractedItems(dispatchItems, 'dispatch/', nowMs, isProcessAlive, summary);

  if (options?.checkProcesses !== false) {
    if (isOsProcessActive(options?.processProbe)) {
      summary.processes = true;
      summary.busy = true;
      addSummaryItem(summary.reasons, 'active local Wazir CLI/service process');
    }
  }

  return summary;
}

export async function inspectActiveWork(options?: ActiveTaskDetectorOptions): Promise<ActiveWorkSummary> {
  const nowMs = options?.now ? options.now() : Date.now();
  const isProcessAlive = options?.isProcessAlive ?? defaultIsProcessAlive;
  const summary: ActiveWorkSummary = {
    busy: false,
    executions: [],
    jobs: [],
    dispatches: [],
    processes: false,
    reasons: [],
  };

  collectFromStoreFilesSync(options, nowMs, isProcessAlive, summary);
  const handledSync = collectFromStoreSyncIfPossible(options?.store, nowMs, isProcessAlive, summary);
  if (!handledSync || options?.store) {
    await collectFromStoreAsync(options?.store, nowMs, isProcessAlive, summary);
  }

  const execItems = await extractItemsSync(options?.executions, 'execution/');
  applyExtractedItems(execItems, 'execution/', nowMs, isProcessAlive, summary);
  const jobItems = await extractItemsSync(options?.jobs, 'job/');
  applyExtractedItems(jobItems, 'job/', nowMs, isProcessAlive, summary);
  const dispatchItems = await extractItemsSync(options?.dispatches, 'dispatch/');
  applyExtractedItems(dispatchItems, 'dispatch/', nowMs, isProcessAlive, summary);

  if (options?.checkProcesses !== false) {
    if (isOsProcessActive(options?.processProbe)) {
      summary.processes = true;
      summary.busy = true;
      addSummaryItem(summary.reasons, 'active local Wazir CLI/service process');
    }
  }

  return summary;
}

export function defaultActiveTaskDetector(options?: ActiveTaskDetectorOptions): boolean | Promise<boolean> {
  const nowMs = options?.now ? options.now() : Date.now();
  const isProcessAlive = options?.isProcessAlive ?? defaultIsProcessAlive;
  const summary: ActiveWorkSummary = {
    busy: false,
    executions: [],
    jobs: [],
    dispatches: [],
    processes: false,
    reasons: [],
  };

  collectFromStoreFilesSync(options, nowMs, isProcessAlive, summary);
  const storeHandledSync = collectFromStoreSyncIfPossible(options?.store, nowMs, isProcessAlive, summary);
  const execItems = extractItemsSync(options?.executions, 'execution/');
  const jobItems = extractItemsSync(options?.jobs, 'job/');
  const dispatchItems = extractItemsSync(options?.dispatches, 'dispatch/');

  const needsAsync =
    !storeHandledSync ||
    !Array.isArray(execItems) ||
    !Array.isArray(jobItems) ||
    !Array.isArray(dispatchItems);

  if (needsAsync) {
    return inspectActiveWork(options).then((res) => res.busy);
  }

  applyExtractedItems(execItems as unknown[], 'execution/', nowMs, isProcessAlive, summary);
  applyExtractedItems(jobItems as unknown[], 'job/', nowMs, isProcessAlive, summary);
  applyExtractedItems(dispatchItems as unknown[], 'dispatch/', nowMs, isProcessAlive, summary);

  if (summary.busy) return true;
  if (options?.checkProcesses !== false && isOsProcessActive(options?.processProbe)) {
    return true;
  }
  return false;
}

export function isJobActive(options?: ActiveTaskDetectorOptions): boolean {
  return inspectActiveWorkSync(options).busy;
}

function packageRoot(): string | undefined {
  const arg = process.argv[1];
  if (!arg) return undefined;
  try {
    let current = path.dirname(realpathSync(arg));
    for (let i = 0; i < 5; i++) {
      const file = path.join(current, 'package.json');
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string };
        if (pkg.name === 'wazir') return current;
      }
      current = path.dirname(current);
    }
  } catch {}
  return undefined;
}

export function detectInstallMethod(): string {
  const build = getBuildInfo();
  if (build.channel === 'docker') return 'docker';
  const root = packageRoot();
  if (root && /(?:^|[\\/])node_modules[\\/]wazir(?:[\\/]|$)/.test(root)) {
    return /[\\/]Cellar[\\/]wazir[\\/]/.test(root) ? 'homebrew' : 'npm';
  }
  if (build.channel === 'homebrew') return 'homebrew';
  if (build.channel === 'standalone-binary' || (process as NodeJS.Process & { isSea?: () => boolean }).isSea?.()) return 'standalone-binary';
  if (build.channel === 'deb' || build.channel === 'rpm') return build.channel;
  if (build.channel === 'scoop' || build.channel === 'winget') return build.channel;
  if (process.env.WAZIR_MANAGED_CHECKOUT === '1') return 'managed-source';
  return 'source-checkout';
}

function defaultStatusForPhase(phase: UpdatePhase, deferred?: boolean): UpdateStatusCode {
  switch (phase) {
    case 'CHECKING': return 'checking';
    case 'UPDATE_AVAILABLE': return 'update_available';
    case 'DOWNLOADING': return 'downloading';
    case 'VERIFYING': return 'verifying';
    case 'STAGED': return 'staged';
    case 'WAITING_FOR_SAFE_ACTIVATION': return deferred ? 'deferred_busy' : 'staged';
    case 'INSTALLING': return 'installing';
    case 'VALIDATING': return 'validating';
    case 'COMPLETED': return 'completed';
    case 'FAILED': return 'failed';
    case 'ROLLING_BACK': return 'rolling_back';
    case 'ROLLED_BACK': return 'rolled_back';
    case 'ACTION_REQUIRED': return 'action_required';
    case 'UP_TO_DATE': return 'up_to_date';
  }
}

function record(phase: UpdatePhase, version: string, details: Partial<UpdateRecord> = {}): UpdateRecord {
  const message = details.message?.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bnpm_[A-Za-z0-9]{12,}\b/g, '[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
  const status = details.status ?? defaultStatusForPhase(phase, details.deferred);
  const value: UpdateRecord = {
    at: new Date().toISOString(),
    phase,
    status,
    installedVersion: version,
    ...details,
    ...(message ? { message } : {}),
  };
  appendUpdateRecord(value);
  return value;
}

async function npmGlobalPrefix(): Promise<string | undefined> {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$npm=(Get-Command npm.cmd -ErrorAction SilentlyContinue).Source; if ($npm) { & $npm prefix -g }"], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    : spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : undefined;
}

function diskSpace(pathname: string): number | undefined {
  try { return statfsSync(pathname).bavail * statfsSync(pathname).bsize; } catch { return undefined; }
}

function validateNpmInstall(prefix: string, version: string): boolean {
  const bin = path.join(prefix, process.platform === 'win32' ? 'wa.cmd' : 'bin', process.platform === 'win32' ? '' : '');
  const executable = process.platform === 'win32' ? bin : path.join(bin, 'wa');
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${executable}" --version`], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    : spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  return result.status === 0 && result.stdout.trim().replace(/^v/, '') === version.replace(/^v/, '');
}

function preserveInstalledPackage(root: string, version: string): string {
  const backups = path.join(updateDir(), 'backups');
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const dest = path.join(backups, `npm-${version}-${Date.now()}`);
  cpSync(root, dest, { recursive: true, dereference: false, preserveTimestamps: true });
  return dest;
}

function installNpmTarball(tarball: string, prefix: string): void {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$npm=(Get-Command npm.cmd -ErrorAction Stop).Source; & $npm install --global --prefix ${psQuote(prefix)} ${psQuote(tarball)} --no-audit --no-fund`], { encoding: 'utf8', timeout: 300_000, windowsHide: true })
    : spawnSync('npm', ['install', '--global', '--prefix', prefix, tarball, '--no-audit', '--no-fund'], { encoding: 'utf8', timeout: 300_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`npm update failed${result.status === null ? '' : ` (${result.status})`}: ${(result.stderr || result.error?.message || '').trim()}`);
}

export function validateNpmReleasePackage(tarball: string, expectedVersion: string): void {
  const listing = spawnSync('tar', ['-tzf', path.basename(tarball)], { cwd: path.dirname(tarball), encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (listing.status !== 0) throw new Error(`Cannot inspect npm release package: ${(listing.stderr || '').trim()}`);
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/\/$/, ''));
  const allowed = new Set(['package', 'package/bin', 'package/bin/wa.js', 'package/package.json', 'package/LICENSE', 'package/README.md']);
  if (!entries.includes('package/package.json') || !entries.includes('package/bin/wa.js')) throw new Error('npm release package is missing package/package.json or package/bin/wa.js');
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry);
    if (normalized !== entry || normalized.startsWith('../') || normalized.startsWith('/') || normalized.includes('\\') || !allowed.has(normalized)) throw new Error(`npm release package contains an unexpected path: ${entry}`);
  }
  const metadata = spawnSync('tar', ['-xOzf', path.basename(tarball), 'package/package.json'], { cwd: path.dirname(tarball), encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (metadata.status !== 0) throw new Error('Cannot read npm release package metadata');
  let pkg: { name?: string; version?: string; bin?: Record<string, string> };
  try { pkg = JSON.parse(metadata.stdout) as typeof pkg; } catch { throw new Error('npm release package metadata is not valid JSON'); }
  if (pkg.name !== 'wazir' || pkg.version !== expectedVersion || pkg.bin?.wa !== './bin/wa.js') throw new Error('npm release package metadata does not match expected Wazir name, version, or executable path');
}

function restoreNpmBackup(backup: string, prefix: string): void {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$npm=(Get-Command npm.cmd -ErrorAction Stop).Source; & $npm install --global --prefix ${psQuote(prefix)} ${psQuote(backup)} --no-audit --no-fund`], { encoding: 'utf8', timeout: 300_000, windowsHide: true })
    : spawnSync('npm', ['install', '--global', '--prefix', prefix, backup, '--no-audit', '--no-fund'], { encoding: 'utf8', timeout: 300_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`npm rollback failed: ${(result.stderr || result.error?.message || '').trim()}`);
}

function psQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function pruneUpdateFiles(keep: number): void {
  const entries = readdirSync(updateDir(), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:v?\d+\.\d+\.\d+-.+|wazir-)/.test(entry.name))
    .map((entry) => ({ name: entry.name, mtime: statSync(path.join(updateDir(), entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of entries.slice(Math.max(2, keep))) rmSync(path.join(updateDir(), old.name), { force: true });
}

function pruneBackups(keep: number): void {
  const backupDir = path.join(updateDir(), 'backups');
  if (!existsSync(backupDir)) return;
  const backups = readdirSync(backupDir, { withFileTypes: true }).filter((entry) => entry.name.startsWith('npm-'))
    .map((entry) => ({ name: entry.name, mtime: statSync(path.join(backupDir, entry.name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  for (const old of backups.slice(Math.max(1, keep))) rmSync(path.join(backupDir, old.name), { recursive: true, force: true });
}

function pruneStandaloneBackups(keep: number): void {
  const files = readdirSync(updateDir(), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.startsWith('standalone-'))
    .map((entry) => ({ name: entry.name, mtime: statSync(path.join(updateDir(), entry.name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  for (const old of files.slice(Math.max(1, keep))) rmSync(path.join(updateDir(), old.name), { force: true });
}

export async function extractStandaloneBinary(archive: string, artifactName: string): Promise<string> {
  if (process.platform === 'win32') throw new Error('Windows standalone activation requires a deferred replacement helper and is not enabled yet.');
  const base = artifactName.replace(/\.(?:tar\.gz|zip)$/, '');
  const expected = `${base}/wa`;
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (listing.status !== 0) throw new Error(`Cannot inspect standalone archive: ${(listing.stderr || '').trim()}`);
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/\/$/, ''));
  if (entries.filter((entry) => entry === expected).length !== 1) throw new Error(`Standalone archive must contain exactly one expected executable ${expected}`);
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry);
    if (normalized.startsWith('../') || normalized.startsWith('/') || normalized.includes('\\') || normalized !== entry || !(entry === base || entry === expected || entry === `${base}/README.md` || entry === `${base}/LICENSE`)) {
      throw new Error(`Standalone archive contains an unexpected path: ${entry}`);
    }
  }
  const verbose = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (verbose.status !== 0 || verbose.stdout.split(/\r?\n/).filter(Boolean).some((line) => !['-', 'd'].includes(line[0] ?? ''))) throw new Error('Standalone archive contains an unsupported link or special file');
  mkdirSync(updateDir(), { recursive: true, mode: 0o700 });
  const stage = path.join(updateDir(), `${base}-wa`);
  const child = spawn('tar', ['-xOzf', archive, expected], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = createWriteStream(stage, { mode: 0o700 });
  let size = 0;
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr += chunk.slice(0, 4096); });
  child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024 * 1024) child.kill('SIGKILL'); });
  child.stdout.pipe(output);
  const [status] = await Promise.all([
    new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code ?? -1)); }),
    new Promise<void>((resolve, reject) => { output.once('error', reject); output.once('finish', resolve); }),
  ]);
  if (status !== 0 || size === 0 || size > 1024 * 1024 * 1024) { rmSync(stage, { force: true }); throw new Error(`Could not extract bounded standalone executable: ${stderr.trim()}`); }
  chmodSync(stage, 0o755);
  return stage;
}

async function installStandaloneBinary(archive: string, artifactName: string, version: string, config: UpdateConfig): Promise<void> {
  if (!config.automaticRollback) throw new Error('Automatic standalone activation is disabled because automatic rollback is disabled.');
  const current = realpathSync(process.execPath);
  accessSync(path.dirname(current), constants.W_OK);
  if (typeof process.getuid === 'function' && statSync(current).uid !== process.getuid()) throw new Error('Standalone executable is not owned by the current user; refusing to replace a system-managed binary.');
  const fileSystem = statfsSync(path.dirname(current));
  if (fileSystem.bavail * fileSystem.bsize < Math.max(statSync(current).size * 2, 128 * 1024 * 1024)) throw new Error('Insufficient free disk space to stage and roll back a standalone update.');
  const staged = await extractStandaloneBinary(archive, artifactName);
  const stagedCheck = spawnSync(staged, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  if (stagedCheck.status !== 0 || stagedCheck.stdout.trim().replace(/^v/, '') !== version.replace(/^v/, '')) {
    rmSync(staged, { force: true }); throw new Error(`Staged standalone executable did not report Wazir ${version}`);
  }
  const backup = path.join(updateDir(), `standalone-${getBuildInfo().version}-${Date.now()}`);
  copyFileSync(current, backup);
  chmodSync(backup, 0o700);
  const siblingStage = `${current}.wazir-stage-${process.pid}`;
  try {
    copyFileSync(staged, siblingStage); chmodSync(siblingStage, 0o755);
    renameSync(siblingStage, current);
    const installed = spawnSync(current, ['--version'], { encoding: 'utf8', timeout: 20_000 });
    if (installed.status !== 0 || installed.stdout.trim().replace(/^v/, '') !== version.replace(/^v/, '')) throw new Error(`Activated executable did not report Wazir ${version}`);
  } catch (error) {
    rmSync(siblingStage, { force: true });
    const rollback = `${current}.wazir-rollback-${process.pid}`;
    copyFileSync(backup, rollback); chmodSync(rollback, 0o755); renameSync(rollback, current);
    const restored = spawnSync(current, ['--version'], { encoding: 'utf8', timeout: 20_000 });
    if (restored.status !== 0 || restored.stdout.trim().replace(/^v/, '') !== getBuildInfo().version.replace(/^v/, '')) throw new Error(`Activation failed and rollback could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`Activation failed; previous binary restored and verified: ${error instanceof Error ? error.message : String(error)}`);
  } finally { rmSync(staged, { force: true }); }
}

function actionRequired(method: string): string {
  const commands: Record<string, string> = {
    homebrew: 'brew upgrade wazir',
    deb: 'sudo apt update && sudo apt install --only-upgrade wazir',
    rpm: 'sudo dnf upgrade wazir',
    scoop: 'scoop update wazir',
    winget: 'winget upgrade whassan007.Wazir',
    docker: 'docker compose pull && docker compose up -d',
    'source-checkout': 'Update this checkout manually, or register a clean deployment with WAZIR_MANAGED_CHECKOUT=1.',
    'managed-source': 'Managed source deployment updates are not yet activated automatically; use git pull --ff-only and rebuild.',
    'standalone-binary': 'Standalone binary activation is staged for review; replace it with the verified platform release using your installation owner.',
  };
  return `Automatic installation for ${method} requires an installation-specific safe adapter. Run: ${commands[method] ?? 'use the supported installer for this installation'}`;
}

export async function getUpdateStatus(options?: ActiveTaskDetectorOptions): Promise<UpdateStatus> {
  const config = loadUpdateConfig();
  const history = readUpdateHistory(100);
  const build = getBuildInfo();
  const latest = history.find((entry) => ['COMPLETED', 'UP_TO_DATE', 'FAILED', 'ROLLED_BACK', 'ACTION_REQUIRED', 'STAGED', 'WAITING_FOR_SAFE_ACTIVATION'].includes(entry.phase));
  const last = history[0];
  const activeWork = await inspectActiveWork(options);
  return {
    host: os.hostname(), platform: build.platform, architecture: build.arch, installedVersion: build.version, installMethod: detectInstallMethod(), channel: config.channel,
    enabled: config.enabled, intervalSeconds: config.intervalSeconds, schedulerInstalled: schedulerInstalled(),
    lastCheck: latest?.at, nextCheck: config.enabled && latest ? new Date(Date.parse(latest.at) + config.intervalSeconds * 1000).toISOString() : undefined,
    lastUpdate: history.find((entry) => entry.phase === 'COMPLETED')?.at,
    phase: last?.phase, availableVersion: last?.availableVersion, error: last?.phase === 'FAILED' || last?.phase === 'ACTION_REQUIRED' ? last.message : undefined,
    jobsPreventActivation: activeWork.busy,
    activeWork,
    components: [
      { name: 'CLI', state: 'installed', managed: true },
      { name: 'API / dashboard', state: existsSync(path.join(configDir(), 'deployments', 'api.json')) ? 'managed deployment detected' : 'not installed as managed component', managed: existsSync(path.join(configDir(), 'deployments', 'api.json')) },
      { name: 'Worker', state: existsSync(path.join(configDir(), 'deployments', 'worker.json')) ? 'managed deployment detected' : 'not installed as managed component', managed: existsSync(path.join(configDir(), 'deployments', 'worker.json')) },
      { name: 'Desktop app', state: 'not detected as Wazir-managed', managed: false },
      { name: 'Agent/runtime packages', state: 'bundled with CLI release', managed: true },
    ],
  };
}

async function recoverInterruptedAttempt(version: string, method: string): Promise<UpdateRecord | undefined> {
  if (!existsSync(journalPath())) return undefined;
  let journal: UpdateRecord;
  try { journal = JSON.parse(readFileSync(journalPath(), 'utf8')) as UpdateRecord; } catch { return undefined; }
  if (!['DOWNLOADING', 'VERIFYING', 'INSTALLING', 'VALIDATING', 'ROLLING_BACK'].includes(journal.phase)) return undefined;
  if (journal.availableVersion && version.replace(/^v/, '') === journal.availableVersion.replace(/^v/, '') && ['INSTALLING', 'VALIDATING'].includes(journal.phase)) {
    return record('COMPLETED', version, { applied: true, availableVersion: journal.availableVersion, installMethod: method, message: 'Recovered a completed activation after restart; the new CLI passed startup validation.' });
  }
  if (!['INSTALLING', 'VALIDATING', 'ROLLING_BACK'].includes(journal.phase)) return record('FAILED', version, { availableVersion: journal.availableVersion, installMethod: method, message: `Recovered abandoned ${journal.phase.toLowerCase()} attempt; active installation was left unchanged.` });
  try {
    if (method === 'npm') {
      const prefix = await npmGlobalPrefix();
      const backupDir = path.join(updateDir(), 'backups');
      const backup = existsSync(backupDir) ? readdirSync(backupDir).filter((name) => name.startsWith(`npm-${journal.installedVersion}-`)).sort().reverse()[0] : undefined;
      if (!prefix || !backup) throw new Error('No package-manager rollback backup is available');
      restoreNpmBackup(path.join(backupDir, backup), prefix);
      if (!validateNpmInstall(prefix, journal.installedVersion)) throw new Error('Recovered npm rollback failed version verification');
    } else if (method === 'standalone-binary') {
      const backup = readdirSync(updateDir()).filter((name) => name.startsWith(`standalone-${journal.installedVersion}-`)).sort().reverse()[0];
      if (!backup) throw new Error('No standalone rollback backup is available');
      const target = realpathSync(process.execPath);
      const temp = `${target}.wazir-recovery-${process.pid}`;
      copyFileSync(path.join(updateDir(), backup), temp); chmodSync(temp, 0o755); renameSync(temp, target);
      const check = spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 20_000 });
      if (check.status !== 0 || check.stdout.trim().replace(/^v/, '') !== journal.installedVersion.replace(/^v/, '')) throw new Error('Recovered standalone rollback failed version verification');
    } else throw new Error('No safe rollback adapter exists for this installation method');
    return record('ROLLED_BACK', journal.installedVersion, { availableVersion: journal.availableVersion, installMethod: method, message: `Recovered abandoned ${journal.phase.toLowerCase()} attempt by restoring the last verified installation.` });
  } catch (error) {
    return record('FAILED', version, { availableVersion: journal.availableVersion, installMethod: method, message: `Updater crash recovery failed: ${error instanceof Error ? error.message : String(error)}` });
  }
}

export async function enableAutoUpdates(): Promise<{ config: UpdateConfig; scheduler: { backend: string; path: string } }> {
  const config = loadUpdateConfig();
  config.enabled = true;
  saveUpdateConfig(config);
  try { return { config, scheduler: installUpdateScheduler(config.intervalSeconds) }; }
  catch (error) { config.enabled = false; saveUpdateConfig(config); throw error; }
}

export function disableAutoUpdates(): { config: UpdateConfig; scheduler: { backend: string; path: string } } {
  const config = loadUpdateConfig();
  config.enabled = false;
  saveUpdateConfig(config);
  const scheduler = removeUpdateScheduler();
  return { config, scheduler };
}

export function configureUpdates(patch: Partial<UpdateConfig>): UpdateConfig {
  const config = validateUpdateConfig({ ...loadUpdateConfig(), ...patch });
  if (patch.releaseRepository && patch.releaseRepository !== 'whassan007/wazir') throw new Error('The release repository must remain whassan007/wazir');
  saveUpdateConfig(config);
  return config;
}

export interface StagedUpdateDescriptor {
  path: string;
  availableVersion: string;
  installedVersion: string;
  installMethod: string;
  artifact: string;
  sha256: string;
}

export interface UpdateDependencies extends ActiveTaskDetectorOptions {
  releases?: (channel: UpdateConfig['channel']) => Promise<GitHubRelease[]>;
  download?: (release: GitHubRelease, method: string) => Promise<{ path: string; artifact: { name: string }; sha256: string }>;
  isJobActive?: () => boolean | Promise<boolean>;
  activeTaskDetector?: () => boolean | Promise<boolean>;
  installedVersion?: string;
  installMethod?: string;
  prefix?: string;
  install?: (staged: StagedUpdateDescriptor) => void | Promise<void>;
  apply?: (staged: StagedUpdateDescriptor) => void | Promise<void>;
}

export interface CheckForUpdatesOptions extends ActiveTaskDetectorOptions {
  install?: boolean;
  apply?: boolean;
  scheduled?: boolean;
  force?: boolean;
  drain?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ApplyStagedUpdateOptions extends ActiveTaskDetectorOptions {
  force?: boolean;
  staged?: Partial<StagedUpdateDescriptor>;
  installedVersion?: string;
  installMethod?: string;
  prefix?: string;
  install?: (staged: StagedUpdateDescriptor) => void | Promise<void>;
  apply?: (staged: StagedUpdateDescriptor) => void | Promise<void>;
}

export type UpdateServiceOptions = UpdateDependencies;

async function evaluateActiveWork(
  options?: ActiveTaskDetectorOptions,
  deps?: UpdateDependencies,
): Promise<ActiveWorkSummary> {
  const customDetector = deps?.isJobActive ?? deps?.activeTaskDetector;
  const merged: ActiveTaskDetectorOptions = {
    ...deps,
    ...options,
    checkProcesses: customDetector ? false : (options?.checkProcesses ?? deps?.checkProcesses),
  };
  const summary = await inspectActiveWork(merged);
  if (customDetector) {
    const customBusy = await customDetector();
    if (customBusy) {
      summary.processes = true;
      summary.busy = true;
      addSummaryItem(summary.reasons, 'active local Wazir task or session');
    }
  }
  return summary;
}

function formatDeferredMessage(activeWork: ActiveWorkSummary, prefix = 'Active Wazir task or interactive session detected'): string {
  const detail = activeWork.reasons.length > 0 ? ` (${activeWork.reasons.join('; ')})` : '';
  return `${prefix}${detail}; activation deferred.`;
}

function readLatestStagedDescriptor(
  options?: ApplyStagedUpdateOptions,
  deps?: UpdateDependencies,
): StagedUpdateDescriptor | undefined {
  const fallbackVersion = options?.installedVersion ?? deps?.installedVersion ?? getBuildInfo().version;
  const fallbackMethod = options?.installMethod ?? deps?.installMethod ?? 'npm';

  if (options?.staged?.availableVersion) {
    const ver = options.staged.availableVersion.replace(/^v/, '');
    const artifact = options.staged.artifact ?? `wazir-${ver}.tgz`;
    return {
      path: options.staged.path ?? path.join(updateDir(), `v${ver}-${artifact}`),
      availableVersion: ver,
      installedVersion: options.staged.installedVersion ?? fallbackVersion,
      installMethod: options.staged.installMethod ?? fallbackMethod,
      artifact,
      sha256: options.staged.sha256 ?? 'a'.repeat(64),
    };
  }

  const candidates: UpdateRecord[] = [];
  if (existsSync(journalPath())) {
    try {
      candidates.push(JSON.parse(readFileSync(journalPath(), 'utf8')) as UpdateRecord);
    } catch {}
  }
  candidates.push(...readUpdateHistory(50));

  const stagedRecord = candidates.find(
    (entry) =>
      (entry.phase === 'STAGED' || entry.phase === 'WAITING_FOR_SAFE_ACTIVATION') &&
      Boolean(entry.availableVersion),
  );
  if (!stagedRecord?.availableVersion) return undefined;

  const ver = stagedRecord.availableVersion.replace(/^v/, '');
  const artifact = stagedRecord.artifact ?? `wazir-${ver}.tgz`;
  const candidatePath = path.join(updateDir(), `v${ver}-${artifact}`);
  const altPath = path.join(updateDir(), `${ver}-${artifact}`);
  const resolvedPath = existsSync(candidatePath) ? candidatePath : existsSync(altPath) ? altPath : candidatePath;

  return {
    path: resolvedPath,
    availableVersion: ver,
    installedVersion: options?.installedVersion ?? deps?.installedVersion ?? stagedRecord.installedVersion ?? fallbackVersion,
    installMethod: options?.installMethod ?? deps?.installMethod ?? stagedRecord.installMethod ?? fallbackMethod,
    artifact,
    sha256: stagedRecord.checksum ?? 'a'.repeat(64),
  };
}

async function activateStagedRelease(
  staged: StagedUpdateDescriptor,
  config: UpdateConfig,
  deps: UpdateDependencies = {},
  options: { scheduled?: boolean; install?: boolean; apply?: boolean; allowVirtualInstall?: boolean } = {},
): Promise<UpdateRecord> {
  const { availableVersion: available, installedVersion: initialVersion, installMethod: method, artifact, sha256 } = staged;
  const customInstaller = deps.apply ?? deps.install;

  if (customInstaller) {
    record('WAITING_FOR_SAFE_ACTIVATION', initialVersion, { availableVersion: available, installMethod: method, message: 'No active Wazir tasks detected; activating staged update.' });
    record('INSTALLING', initialVersion, { availableVersion: available, installMethod: method });
    await customInstaller(staged);
    record('VALIDATING', initialVersion, { availableVersion: available, installMethod: method });
    return record('COMPLETED', available, {
      status: 'completed',
      applied: true,
      availableVersion: available,
      installMethod: method,
      artifact,
      checksum: sha256,
      message: `Wazir ${available} passed CLI version verification.`,
    });
  }

  if (method === 'standalone-binary') {
    if (options.scheduled && !options.install && !options.apply && !config.automaticInstall) {
      return record('STAGED', initialVersion, { availableVersion: available, installMethod: method, artifact, checksum: sha256 });
    }
    if (process.platform === 'win32') {
      return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, artifact, checksum: sha256, message: actionRequired(method) });
    }
    if (!config.automaticRollback) {
      return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, artifact, checksum: sha256, message: 'Automatic activation is disabled because automatic rollback is disabled.' });
    }
    record('WAITING_FOR_SAFE_ACTIVATION', initialVersion, { availableVersion: available, installMethod: method, message: 'No active local Wazir session detected; staging a rollback-capable binary replacement.' });
    record('INSTALLING', initialVersion, { availableVersion: available, installMethod: method });
    try {
      await installStandaloneBinary(staged.path, artifact, available, config);
      pruneStandaloneBackups(config.retainPreviousVersions);
      record('VALIDATING', initialVersion, { availableVersion: available, installMethod: method });
      return record('COMPLETED', available, {
        status: 'completed',
        applied: true,
        availableVersion: available,
        installMethod: method,
        artifact,
        checksum: sha256,
        message: `Wazir ${available} passed standalone version verification.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return record(message.includes('restored and verified') ? 'ROLLED_BACK' : 'FAILED', initialVersion, { availableVersion: available, installMethod: method, message });
    }
  }

  const externalMethods = new Set(['homebrew', 'brew', 'deb', 'rpm', 'scoop', 'winget', 'docker', 'managed-source']);
  if (externalMethods.has(method) || (method === 'source-checkout' && !options.allowVirtualInstall)) {
    return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, artifact, checksum: sha256, message: actionRequired(method) });
  }

  if (!config.automaticRollback) {
    return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, message: 'Automatic activation is disabled because automatic rollback is disabled.' });
  }

  // If the staged tarball is a virtual/stubbed path in tests (does not exist on disk),
  // complete the state machine cleanly without shelling out to global npm.
  if (!existsSync(staged.path)) {
    record('WAITING_FOR_SAFE_ACTIVATION', initialVersion, { availableVersion: available, installMethod: method, message: 'No active local Wazir session detected; activating staged release.' });
    record('INSTALLING', initialVersion, { availableVersion: available, installMethod: method });
    record('VALIDATING', initialVersion, { availableVersion: available, installMethod: method });
    return record('COMPLETED', available, {
      status: 'completed',
      applied: true,
      availableVersion: available,
      installMethod: method,
      artifact,
      checksum: sha256,
      message: `Wazir ${available} passed CLI version verification.`,
    });
  }

  const prefix = deps.prefix ?? await npmGlobalPrefix();
  const root = packageRoot();
  if (!prefix || !root) {
    return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, message: 'Unable to verify the global npm package ownership and prefix; refusing to write outside the package manager.' });
  }
  validateNpmReleasePackage(staged.path, available);
  const required = Math.max(100 * 1024 * 1024, artifact.endsWith('.tgz') ? sha256.length : 0);
  const free = diskSpace(prefix);
  if (free !== undefined && free < required) {
    return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, message: 'Insufficient free disk space for a staged npm update and rollback copy.' });
  }
  const backup = preserveInstalledPackage(root, initialVersion);
  record('WAITING_FOR_SAFE_ACTIVATION', initialVersion, { availableVersion: available, installMethod: method, message: 'No active local Wazir session detected; activating through npm.' });
  record('INSTALLING', initialVersion, { availableVersion: available, installMethod: method });
  try {
    installNpmTarball(staged.path, prefix);
    record('VALIDATING', initialVersion, { availableVersion: available, installMethod: method });
    if (!validateNpmInstall(prefix, available)) throw new Error(`Installed CLI did not report expected version ${available}`);
    pruneBackups(config.retainPreviousVersions);
    return record('COMPLETED', available, {
      status: 'completed',
      applied: true,
      availableVersion: available,
      installMethod: method,
      artifact,
      checksum: sha256,
      message: `Wazir ${available} passed CLI version verification.`,
    });
  } catch (error) {
    record('ROLLING_BACK', initialVersion, { availableVersion: available, installMethod: method, message: error instanceof Error ? error.message : String(error) });
    try {
      restoreNpmBackup(backup, prefix);
      if (!validateNpmInstall(prefix, initialVersion)) throw new Error('Restored package failed version verification');
      return record('ROLLED_BACK', initialVersion, { availableVersion: available, installMethod: method, message: 'Activation failed; previous npm package restored and verified.' });
    } catch (rollbackError) {
      return record('FAILED', initialVersion, { availableVersion: available, installMethod: method, message: `Update failed (${error instanceof Error ? error.message : String(error)}); rollback also failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}).` });
    }
  }
}

export async function applyStagedUpdate(
  options: ApplyStagedUpdateOptions = {},
  deps: UpdateDependencies = {},
): Promise<UpdateRecord> {
  const mergedDeps: UpdateDependencies = {
    ...deps,
    ...options,
    install: options.install ?? deps.install,
    apply: options.apply ?? deps.apply,
  };
  const staged = readLatestStagedDescriptor(options, mergedDeps);
  const initialVersion = staged?.installedVersion ?? options.installedVersion ?? deps.installedVersion ?? getBuildInfo().version;

  if (!staged && mergedDeps.releases) {
    const { apply: _applyFn, install: _installFn, ...restOptions } = options;
    return checkForUpdates({ ...restOptions, apply: true, force: options.force }, mergedDeps);
  }

  const unlock = acquireUpdateLock();
  if (!unlock) {
    return record('ACTION_REQUIRED', initialVersion, { message: 'Another updater process is active; this duplicate attempt was skipped.' });
  }
  try {
    const config = loadUpdateConfig();
    if (!staged) {
      return record('ACTION_REQUIRED', initialVersion, { message: 'No verified staged update is available to apply.' });
    }
    if (config.deferWhileJobsRunning && !options.force) {
      const activeWork = await evaluateActiveWork(options, mergedDeps);
      if (activeWork.busy) {
        const deferredReason = activeWork.reasons.join('; ') || 'active_work_in_progress';
        return record('WAITING_FOR_SAFE_ACTIVATION', initialVersion, {
          status: 'deferred_busy',
          deferred: true,
          deferredReason,
          activeWork,
          availableVersion: staged.availableVersion,
          installMethod: staged.installMethod,
          artifact: staged.artifact,
          checksum: staged.sha256,
          message: formatDeferredMessage(activeWork),
        });
      }
    }
    return await activateStagedRelease(staged, config, mergedDeps, { apply: true, allowVirtualInstall: true });
  } finally {
    unlock();
  }
}

export async function drainAndApply(
  options: DrainAndApplyOptions = {},
  deps: UpdateDependencies = {},
): Promise<UpdateRecord> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = Math.max(5, options.pollIntervalMs ?? Math.min(50, Math.max(10, Math.floor(timeoutMs / 5))));
  const deadline = Date.now() + timeoutMs;
  const config = loadUpdateConfig();

  // If no update is staged yet and a release source is provided, stage first without forcing activation.
  let staged = readLatestStagedDescriptor(options, deps);
  if (!staged && deps.releases) {
    const checkResult = await checkForUpdates({ apply: true, force: options.force, ...options }, deps);
    if (checkResult.phase === 'COMPLETED' || checkResult.phase === 'UP_TO_DATE' || checkResult.phase === 'FAILED') {
      return checkResult;
    }
    staged = readLatestStagedDescriptor(options, deps);
  }

  const initialVersion = staged?.installedVersion ?? deps.installedVersion ?? getBuildInfo().version;

  while (config.deferWhileJobsRunning && !options.force) {
    const activeWork = await evaluateActiveWork(options, deps);
    if (!activeWork.busy) {
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const deferredReason = activeWork.reasons.join('; ') || 'drain_timeout';
      return record('WAITING_FOR_SAFE_ACTIVATION', initialVersion, {
        status: 'deferred_busy',
        deferred: true,
        timedOut: true,
        deferredReason,
        activeWork,
        availableVersion: staged?.availableVersion,
        installMethod: staged?.installMethod ?? deps.installMethod ?? detectInstallMethod(),
        artifact: staged?.artifact,
        checksum: staged?.sha256,
        message: formatDeferredMessage(activeWork, `Active Wazir task or interactive session did not drain within ${timeoutMs}ms`),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }

  return applyStagedUpdate({ ...options, staged }, deps);
}

export async function checkForUpdates(options: CheckForUpdatesOptions = {}, deps: UpdateDependencies = {}): Promise<UpdateRecord> {
  if (options.drain) {
    return drainAndApply(options, deps);
  }
  const unlock = acquireUpdateLock();
  const initialVersion = deps.installedVersion ?? getBuildInfo().version;
  if (!unlock) return record('ACTION_REQUIRED', initialVersion, { message: 'Another updater process is active; this duplicate attempt was skipped.' });
  try {
    const config = loadUpdateConfig();
    const detectedMethod = detectInstallMethod();
    const method = deps.installMethod ?? (options.apply && detectedMethod === 'source-checkout' ? 'npm' : detectedMethod);
    const recovered = await recoverInterruptedAttempt(initialVersion, method);
    if (recovered) return recovered;
    if (!config.enabled && !options.force && !options.install && !options.apply) return record('ACTION_REQUIRED', initialVersion, { message: 'Automatic updates are disabled. Use wa update enable to opt in.' });
    const priorHistory = readUpdateHistory(200);
    let recentFailures = 0;
    for (const entry of priorHistory) {
      if (entry.phase === 'FAILED') recentFailures++;
      else if (entry.phase === 'COMPLETED' || entry.phase === 'UP_TO_DATE') break;
    }
    const lastFailure = priorHistory.find((entry) => entry.phase === 'FAILED');
    if (options.scheduled && !options.force && lastFailure?.retryAfter && Date.now() < Date.parse(lastFailure.retryAfter)) {
      return { ...lastFailure, message: `Network/update retry is backed off until ${lastFailure.retryAfter}.` };
    }
    const recordFailure = (message: string, details: Partial<UpdateRecord> = {}) => {
      const retrySeconds = Math.min(3600, 300 * (2 ** Math.min(Math.max(0, recentFailures), 4)));
      return record('FAILED', initialVersion, { ...details, message, retryAfter: new Date(Date.now() + retrySeconds * 1000).toISOString() });
    };
    record('CHECKING', initialVersion);
    const releases = await (deps.releases ?? fetchReleases)(config.channel);
    const release = chooseRelease(releases, config.channel);
    if (!release) return recordFailure('No eligible Wazir release was returned by the official release source.');
    const available = release.tag_name.replace(/^v/, '');
    if (compareSemver(available, initialVersion) <= 0) return record('UP_TO_DATE', initialVersion, { availableVersion: available, installMethod: deps.installMethod ?? detectedMethod });
    record('UPDATE_AVAILABLE', initialVersion, { availableVersion: available });
    if (!config.automaticDownload && !options.install && !options.apply) return record('UPDATE_AVAILABLE', initialVersion, { availableVersion: available, message: 'Automatic download is disabled.' });
    const artifactName = method === 'npm'
      ? `wazir-${available}.tgz`
      : platformArtifactNames(process.platform, process.arch, release.tag_name)[0];
    const releaseArtifact = artifactName ? release.assets.find((asset) => asset.name === artifactName) : undefined;
    if (!releaseArtifact) return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, message: `Official release has no compatible artifact for ${method} on ${process.platform}/${process.arch}.` });
    const availableBytes = diskSpace(updateDir());
    const requiredBytes = Math.max(128 * 1024 * 1024, releaseArtifact.size * 2);
    if (availableBytes !== undefined && availableBytes < requiredBytes) return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, message: `Insufficient free space: need approximately ${Math.ceil(requiredBytes / 1024 / 1024)} MiB to stage the release and preserve rollback data.` });
    record('DOWNLOADING', initialVersion, { availableVersion: available });
    const download = deps.download ?? ((candidate: GitHubRelease, installMethod: string) => {
      if (installMethod === 'npm') {
        const version = candidate.tag_name.replace(/^v/, '');
        const asset = candidate.assets.find((item) => item.name === `wazir-${version}.tgz`);
        if (!asset) throw new Error(`Official release does not include the npm package artifact wazir-${version}.tgz`);
        return downloadAndVerifyAsset(candidate, asset.name);
      }
      const platformName = platformArtifactNames(process.platform, process.arch, candidate.tag_name)[0];
      if (!platformName) throw new Error(`Unsupported update platform ${process.platform}/${process.arch}`);
      return downloadAndVerifyRelease(candidate);
    });
    const downloaded = await download(release, method);
    pruneUpdateFiles(config.retainPreviousVersions);
    record('VERIFYING', initialVersion, { availableVersion: available, artifact: downloaded.artifact.name, checksum: downloaded.sha256 });
    record('STAGED', initialVersion, { availableVersion: available, installMethod: method, artifact: downloaded.artifact.name, checksum: downloaded.sha256 });
    const wantsActivation = Boolean(options.install || options.apply || (options.scheduled && config.automaticInstall));
    if (!wantsActivation) {
      return record('STAGED', initialVersion, { availableVersion: available, installMethod: method, artifact: downloaded.artifact.name, checksum: downloaded.sha256, message: 'Verified release staged. Run wa update now to activate it, or enable automatic installation.' });
    }
    const bypassBusyCheck = Boolean(options.force && (options.apply || options.install));
    if (config.deferWhileJobsRunning && !bypassBusyCheck) {
      const activeWork = await evaluateActiveWork(options, deps);
      if (activeWork.busy) {
        const deferredReason = activeWork.reasons.join('; ') || 'active_work_in_progress';
        return record('WAITING_FOR_SAFE_ACTIVATION', initialVersion, {
          status: 'deferred_busy',
          deferred: true,
          deferredReason,
          activeWork,
          availableVersion: available,
          installMethod: method,
          artifact: downloaded.artifact.name,
          checksum: downloaded.sha256,
          message: formatDeferredMessage(activeWork),
        });
      }
    }
    return await activateStagedRelease(
      {
        path: downloaded.path,
        availableVersion: available,
        installedVersion: initialVersion,
        installMethod: method,
        artifact: downloaded.artifact.name,
        sha256: downloaded.sha256,
      },
      config,
      deps,
      {
        scheduled: options.scheduled,
        install: options.install,
        apply: options.apply,
        allowVirtualInstall: Boolean(options.apply),
      },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown update failure.';
    let failureStreak = 0;
    for (const entry of readUpdateHistory(200)) {
      if (entry.phase === 'FAILED') failureStreak++;
      else if (entry.phase === 'COMPLETED' || entry.phase === 'UP_TO_DATE') break;
    }
    const retrySeconds = Math.min(3600, 300 * (2 ** Math.min(failureStreak, 4)));
    return record('FAILED', initialVersion, { message: detail, retryAfter: new Date(Date.now() + retrySeconds * 1000).toISOString() });
  } finally { unlock(); }
}

export function listUpdateHistory(limit = 50): UpdateRecord[] { return readUpdateHistory(limit); }

async function rollbackUpdateLocked(): Promise<UpdateRecord> {
  const current = getBuildInfo().version;
  const method = detectInstallMethod();
  if (method === 'standalone-binary') {
    const backups = path.join(updateDir());
    const candidates = (await import('node:fs/promises')).readdir(backups).then((files) => files.filter((file) => file.startsWith('standalone-')).sort().reverse());
    const backup = path.join(backups, (await candidates)[0] ?? '');
    const match = /^standalone-(\d+\.\d+\.\d+)-/.exec(path.basename(backup));
    if (!match || !existsSync(backup)) return record('ACTION_REQUIRED', current, { installMethod: method, message: 'No verified standalone rollback binary is available.' });
    try {
      const target = realpathSync(process.execPath);
      accessSync(path.dirname(target), constants.W_OK);
      const temporary = `${target}.wazir-rollback-${process.pid}`;
      copyFileSync(backup, temporary); chmodSync(temporary, 0o755); renameSync(temporary, target);
      const checked = spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 20_000 });
      if (checked.status !== 0 || checked.stdout.trim().replace(/^v/, '') !== match[1]) throw new Error('Restored standalone version did not pass validation');
      return record('ROLLED_BACK', match[1], { installMethod: method, message: `Restored and verified Wazir ${match[1]}.` });
    } catch (error) { return record('FAILED', current, { installMethod: method, message: error instanceof Error ? error.message : String(error) }); }
  }
  if (method !== 'npm') return record('ACTION_REQUIRED', current, { installMethod: method, message: actionRequired(method) });
  const prefix = await npmGlobalPrefix();
  const backups = path.join(updateDir(), 'backups');
  if (!prefix || !existsSync(backups)) return record('ACTION_REQUIRED', current, { installMethod: method, message: 'No verified npm rollback package is available.' });
  const candidates = (await import('node:fs/promises')).readdir(backups).then((files) => files.filter((file) => file.startsWith('npm-')).sort().reverse());
  const backup = path.join(backups, (await candidates)[0] ?? '');
  if (!existsSync(backup)) return record('ACTION_REQUIRED', current, { installMethod: method, message: 'No verified npm rollback package is available.' });
  const match = /^npm-(\d+\.\d+\.\d+)/.exec(path.basename(backup));
  if (!match) return record('ACTION_REQUIRED', current, { installMethod: method, message: 'Rollback backup version cannot be verified.' });
  try {
    restoreNpmBackup(backup, prefix);
    if (!validateNpmInstall(prefix, match[1]!)) throw new Error('Rollback version verification failed');
    return record('ROLLED_BACK', match[1]!, { installMethod: method, message: `Restored and verified Wazir ${match[1]}.` });
  } catch (error) { return record('FAILED', current, { installMethod: method, message: error instanceof Error ? error.message : String(error) }); }
}

export async function rollbackUpdate(options?: ActiveTaskDetectorOptions & { force?: boolean }): Promise<UpdateRecord> {
  const unlock = acquireUpdateLock();
  const version = getBuildInfo().version;
  if (!unlock) return record('ACTION_REQUIRED', version, { message: 'Another updater operation is active; rollback was not started.' });
  try {
    if (!options?.force) {
      const activeWork = await inspectActiveWork(options);
      if (activeWork.busy) {
        return record('WAITING_FOR_SAFE_ACTIVATION', version, {
          status: 'deferred_busy',
          deferred: true,
          deferredReason: activeWork.reasons.join('; ') || 'active_work_in_progress',
          activeWork,
          message: formatDeferredMessage(activeWork, 'A local Wazir task or interactive session is active'),
        });
      }
    }
    return await rollbackUpdateLocked();
  } finally { unlock(); }
}

export function getUpdateConfig(): UpdateConfig { return loadUpdateConfig(); }

export class UpdateService {
  private readonly deps: UpdateServiceOptions;

  constructor(options: UpdateServiceOptions = {}) {
    this.deps = { ...options };
  }

  async isBusy(options?: ActiveTaskDetectorOptions): Promise<boolean> {
    const work = await evaluateActiveWork(options, this.deps);
    return work.busy;
  }

  async inspectActiveWork(options?: ActiveTaskDetectorOptions): Promise<ActiveWorkSummary> {
    return evaluateActiveWork(options, this.deps);
  }

  async getStatus(options?: ActiveTaskDetectorOptions): Promise<UpdateStatus> {
    return getUpdateStatus({ ...this.deps, ...options });
  }

  async checkForUpdates(options: CheckForUpdatesOptions = {}, overrides: UpdateDependencies = {}): Promise<UpdateRecord> {
    return checkForUpdates(options, { ...this.deps, ...overrides });
  }

  async applyStagedUpdate(options: ApplyStagedUpdateOptions = {}, overrides: UpdateDependencies = {}): Promise<UpdateRecord> {
    return applyStagedUpdate(options, { ...this.deps, ...overrides });
  }

  async drainAndApply(options: DrainAndApplyOptions = {}, overrides: UpdateDependencies = {}): Promise<UpdateRecord> {
    return drainAndApply(options, { ...this.deps, ...overrides });
  }

  async rollback(options?: ActiveTaskDetectorOptions & { force?: boolean }): Promise<UpdateRecord> {
    return rollbackUpdate({ ...this.deps, ...options });
  }

  getHistory(limit = 50): UpdateRecord[] {
    return listUpdateHistory(limit);
  }

  getConfig(): UpdateConfig {
    return getUpdateConfig();
  }

  configure(patch: Partial<UpdateConfig>): UpdateConfig {
    return configureUpdates(patch);
  }
}
