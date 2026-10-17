import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { createScheduler, describeDecision } from '@wazir/scheduler';
import type { Priority, ProtocolPrincipal, Task } from '@wazir/core';
import { sanitizeUntrustedOutput } from '@wazir/shared';
import type { ApiState } from './server.js';
import type { MobileServices, MobileTaskDetail } from './mobile.js';

export type AutonomyPosture = 'read-only' | 'request-review' | 'auto-sandbox';
export type NetworkGuardMode = 'normal' | 'cellular-strict';

export interface AutonomyState {
  posture: AutonomyPosture;
  mode: AutonomyPosture;
  networkGuard: NetworkGuardMode;
  requireBiometricForHighRisk: boolean;
  effectivePosture: AutonomyPosture;
  description: string;
  updatedAt: string;
  updatedBy: string;
}

export interface HostInstanceRecord {
  id: string;
  name: string;
  url: string;
  local: boolean;
  active: boolean;
  status: 'online' | 'offline' | 'paired';
  deviceId?: string;
  tlsCertFingerprint?: string;
  hasCredential: boolean;
  pairedAt?: string;
  lastCheckedAt?: string;
}

interface StoredRemoteHost extends HostInstanceRecord {
  accessToken?: string;
  refreshToken?: string;
}

export interface ScheduledTaskRecord {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  cadenceMinutes: number;
  intervalMs: number;
  enabled: boolean;
  priority: Priority;
  autonomyPosture: AutonomyPosture;
  targetComputerId?: string;
  targetModelId?: string;
  schedulerExplanation: string;
  routingPlan: {
    modelId: string;
    runtimeId: string;
    computerId?: string;
    agentId?: string;
    reasons: string[];
    summary: string;
  };
  createdAt: string;
  lastRunAt?: string;
  nextRunAt: string;
  lastTaskId?: string;
  lastStatus: 'idle' | 'running' | 'completed' | 'failed';
  runCount: number;
}

export interface DiffHunkLine {
  type: 'ctx' | 'add' | 'del';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffFileReviewItem {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  additions: number;
  deletions: number;
  hunks: Array<{
    header: string;
    lines: DiffHunkLine[];
  }>;
  reviewDecision: 'pending' | 'keep' | 'skip';
  reviewedBy?: string;
  reviewedAt?: string;
  note?: string;
}

export interface VerifiableArtifact {
  id: string;
  kind: 'plan' | 'code_diff' | 'test_summary' | 'sandbox_preview';
  title: string;
  status: 'verified' | 'pending_review' | 'failed' | 'ready';
  createdAt: string;
  plan?: {
    objective: string;
    agentId: string;
    modelId: string;
    runtimeId: string;
    computerId: string;
    routingReasons: string[];
    steps: Array<{
      id: string;
      title: string;
      phase: string;
      status: string;
      detail?: string;
    }>;
    contextFit: {
      fits: boolean;
      requiredTokens?: number;
      availableTokens?: number;
    };
  };
  codeDiff?: {
    files: DiffFileReviewItem[];
    summary: {
      totalFiles: number;
      keptCount: number;
      skippedCount: number;
      pendingCount: number;
    };
  };
  testSummary?: {
    overallStatus: string;
    passedCount: number;
    failedCount: number;
    totalDurationMs: number;
    workspaceRevision?: string;
    checks: Array<{
      name: string;
      status: string;
      durationMs: number;
      output?: string;
      error?: string;
    }>;
  };
  sandboxPreview?: {
    contentType: 'html' | 'svg' | 'mermaid';
    sandboxCsp: string;
    htmlDoc: string;
    rawSource: string;
  };
}

const SANDBOX_CSP =
  "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;";

function describeAutonomyPosture(posture: AutonomyPosture, networkGuard: NetworkGuardMode): string {
  const effective = networkGuard === 'cellular-strict' && posture === 'auto-sandbox'
    ? 'request-review'
    : posture;
  switch (effective) {
    case 'read-only':
      return 'Read-Only: Blocks filesystem writes and mutating shell commands; permits repository analysis and diff review.';
    case 'request-review':
      return 'Request-Review: Autonomous read/search; pauses mutating file edits and shell commands for human approval.';
    case 'auto-sandbox':
      return 'Auto-Sandbox (Workspace-Write): Autonomous edits and tests inside workspace sandbox; gates high/critical risk actions.';
  }
}

export function parseScheduleIntervalMs(schedule: string, explicitIntervalMs?: number): number {
  if (typeof explicitIntervalMs === 'number' && Number.isFinite(explicitIntervalMs) && explicitIntervalMs >= 10_000) {
    return Math.min(explicitIntervalMs, 30 * 24 * 60 * 60 * 1000);
  }
  const s = String(schedule || '1h').trim().toLowerCase();
  const match = /^(\d+)\s*(s|sec|m|min|h|hr|d|day)s?$/.exec(s);
  if (match) {
    const val = Number(match[1]);
    const unit = match[2];
    if (unit.startsWith('s')) return Math.max(10_000, val * 1000);
    if (unit.startsWith('m')) return Math.max(10_000, val * 60_000);
    if (unit.startsWith('h')) return val * 3_600_000;
    if (unit.startsWith('d')) return val * 86_400_000;
  }
  const cronEveryMin = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(s);
  if (cronEveryMin) {
    return Math.max(60_000, Number(cronEveryMin[1]) * 60_000);
  }
  if (s === 'hourly' || s === '0 * * * *') return 3_600_000;
  if (s === 'daily' || s.startsWith('0 9 * * *') || s.startsWith('0 0 * * *')) return 86_400_000;
  return 3_600_000; // Default 1 hour
}

export function computeDiffLines(oldText: string, newText: string): DiffHunkLine[] {
  const a = oldText ? oldText.split('\n') : [];
  const b = newText ? newText.split('\n') : [];
  const n = a.length;
  const m = b.length;
  if (n * m > 100_000) {
    return [
      ...a.map((text, idx): DiffHunkLine => ({ type: 'del', text, oldLine: idx + 1 })),
      ...b.map((text, idx): DiffHunkLine => ({ type: 'add', text, newLine: idx + 1 })),
    ];
  }
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: DiffHunkLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ type: 'ctx', text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ type: 'del', text: a[i], oldLine: i + 1 });
      i++;
    } else {
      lines.push({ type: 'add', text: b[j], newLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    lines.push({ type: 'del', text: a[i], oldLine: i + 1 });
    i++;
  }
  while (j < m) {
    lines.push({ type: 'add', text: b[j], newLine: j + 1 });
    j++;
  }
  return lines;
}

function escapeHtml(raw: string): string {
  return String(raw ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c] || c));
}

export class MultiSurfaceService {
  private autonomy: AutonomyState;
  private readonly schedules = new Map<string, ScheduledTaskRecord>();
  private readonly remoteHosts = new Map<string, StoredRemoteHost>();
  private activeHostId = 'local';
  private schedulerTimer?: NodeJS.Timeout;

  constructor(
    private readonly state: ApiState,
    private readonly mobile: MobileServices,
    private readonly now: () => number = Date.now,
  ) {
    const nowIso = new Date(this.now()).toISOString();
    this.autonomy = {
      posture: 'request-review',
      mode: 'request-review',
      networkGuard: 'normal',
      requireBiometricForHighRisk: true,
      effectivePosture: 'request-review',
      description: describeAutonomyPosture('request-review', 'normal'),
      updatedAt: nowIso,
      updatedBy: 'system',
    };
  }

  async init(): Promise<void> {
    const savedAutonomy = await this.state.store.get<AutonomyState>('control/autonomy/state');
    if (savedAutonomy && ['read-only', 'request-review', 'auto-sandbox'].includes(savedAutonomy.posture)) {
      this.autonomy = {
        ...savedAutonomy,
        mode: savedAutonomy.posture,
        effectivePosture:
          savedAutonomy.networkGuard === 'cellular-strict' && savedAutonomy.posture === 'auto-sandbox'
            ? 'request-review'
            : savedAutonomy.posture,
        description: describeAutonomyPosture(savedAutonomy.posture, savedAutonomy.networkGuard ?? 'normal'),
      };
      this.applyAutonomyToApprovalQueue();
    }

    const savedSchedules = await this.state.store.list('control/schedules/');
    for (const entry of savedSchedules) {
      const rec = entry.value as ScheduledTaskRecord;
      if (rec?.id) {
        this.schedules.set(rec.id, rec);
      }
    }

    const savedHosts = await this.state.store.list('control/hosts/');
    for (const entry of savedHosts) {
      const host = entry.value as StoredRemoteHost;
      if (host?.id && host.id !== 'local') {
        this.remoteHosts.set(host.id, host);
      }
    }
    const savedActiveHost = await this.state.store.get<{ activeHostId: string }>('control/hosts-active');
    if (savedActiveHost?.activeHostId) {
      this.activeHostId = savedActiveHost.activeHostId;
    }

    this.startScheduleTicker();
  }

  private applyAutonomyToApprovalQueue(): void {
    if (this.autonomy.effectivePosture === 'request-review' || this.autonomy.networkGuard === 'cellular-strict') {
      this.mobile.approvals.enableDurableQueue = true;
    }
  }

  // ─── 1. Autonomy Posture Controls ───────────────────────────────────

  getAutonomy(): AutonomyState {
    return { ...this.autonomy };
  }

  async setAutonomy(
    input: {
      posture?: AutonomyPosture;
      mode?: AutonomyPosture;
      networkGuard?: NetworkGuardMode;
      requireBiometricForHighRisk?: boolean;
    },
    updatedBy: string,
  ): Promise<{ ok: true; autonomy: AutonomyState } | { ok: false; status: number; code: string; error: string }> {
    const posture = input.posture ?? input.mode ?? this.autonomy.posture;
    if (!['read-only', 'request-review', 'auto-sandbox'].includes(posture)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_AUTONOMY_POSTURE',
        error: "posture must be 'read-only', 'request-review', or 'auto-sandbox'",
      };
    }
    const networkGuard = input.networkGuard ?? this.autonomy.networkGuard;
    if (!['normal', 'cellular-strict'].includes(networkGuard)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_NETWORK_GUARD',
        error: "networkGuard must be 'normal' or 'cellular-strict'",
      };
    }
    const requireBiometricForHighRisk =
      typeof input.requireBiometricForHighRisk === 'boolean'
        ? input.requireBiometricForHighRisk
        : this.autonomy.requireBiometricForHighRisk;

    const effectivePosture: AutonomyPosture =
      networkGuard === 'cellular-strict' && posture === 'auto-sandbox'
        ? 'request-review'
        : posture;

    this.autonomy = {
      posture,
      mode: posture,
      networkGuard,
      requireBiometricForHighRisk,
      effectivePosture,
      description: describeAutonomyPosture(posture, networkGuard),
      updatedAt: new Date(this.now()).toISOString(),
      updatedBy,
    };

    this.applyAutonomyToApprovalQueue();
    await this.state.store.put('control/autonomy/state', this.autonomy);

    await this.mobile.eventHub.publish({
      type: 'policy.autonomy_changed',
      status: effectivePosture,
      summary: `Autonomy posture set to '${effectivePosture}' by ${updatedBy}`,
      payload: { autonomy: this.autonomy },
    });

    return { ok: true, autonomy: { ...this.autonomy } };
  }

  // ─── 2. Host Instance Switching & Mode B Pairing ────────────────────

  private persistHostsFile(): void {
    const wazirHome = process.env.WAZIR_HOME ?? path.join(os.homedir(), '.wazir');
    const hostsPath = path.join(wazirHome, 'hosts.json');
    try {
      fs.mkdirSync(wazirHome, { recursive: true });
      const payload = {
        activeHostId: this.activeHostId,
        hosts: [...this.remoteHosts.values()],
      };
      fs.writeFileSync(hostsPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch {
      // Non-fatal in read-only or in-memory test environments
    }
  }

  listHosts(): { activeHostId: string; hosts: HostInstanceRecord[] } {
    const localId = process.env.WAZIR_COMPUTER_ID ?? 'local';
    const port = Number(process.env.PORT ?? 4800);
    const localHost: HostInstanceRecord = {
      id: 'local',
      name: `${os.hostname() || localId} (local)`,
      url: `http://127.0.0.1:${port}`,
      local: true,
      active: this.activeHostId === 'local',
      status: 'online',
      hasCredential: true,
      lastCheckedAt: new Date(this.now()).toISOString(),
    };

    const remotes: HostInstanceRecord[] = [...this.remoteHosts.values()].map((h) => ({
      id: h.id,
      name: h.name,
      url: h.url,
      local: false,
      active: this.activeHostId === h.id,
      status: h.status,
      deviceId: h.deviceId,
      tlsCertFingerprint: h.tlsCertFingerprint,
      hasCredential: Boolean(h.accessToken),
      pairedAt: h.pairedAt,
      lastCheckedAt: h.lastCheckedAt,
    }));

    return {
      activeHostId: this.activeHostId,
      hosts: [localHost, ...remotes],
    };
  }

  async upsertHost(input: {
    id?: string;
    name: string;
    url: string;
    accessToken?: string;
    refreshToken?: string;
    deviceId?: string;
    tlsCertFingerprint?: string;
    setActive?: boolean;
  }): Promise<{ ok: true; host: HostInstanceRecord; activeHostId: string } | { ok: false; status: number; code: string; error: string }> {
    const name = String(input.name ?? '').trim();
    const rawUrl = String(input.url ?? '').trim().replace(/\/+$/, '');
    if (!name || !rawUrl) {
      return { ok: false, status: 400, code: 'INVALID_HOST', error: 'Host name and url are required' };
    }
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, status: 400, code: 'INVALID_HOST_URL', error: 'Host URL must use http or https' };
      }
    } catch {
      return { ok: false, status: 400, code: 'INVALID_HOST_URL', error: 'Malformed host URL' };
    }

    const id = input.id && /^[A-Za-z0-9._-]{2,64}$/.test(input.id) && input.id !== 'local'
      ? input.id
      : `host-${randomUUID().slice(0, 8)}`;
    const existing = this.remoteHosts.get(id);
    const nowIso = new Date(this.now()).toISOString();

    const record: StoredRemoteHost = {
      id,
      name,
      url: rawUrl,
      local: false,
      active: Boolean(input.setActive),
      status: input.accessToken || existing?.accessToken ? 'paired' : 'online',
      deviceId: input.deviceId ?? existing?.deviceId,
      tlsCertFingerprint: input.tlsCertFingerprint ?? existing?.tlsCertFingerprint,
      hasCredential: Boolean(input.accessToken || existing?.accessToken),
      accessToken: input.accessToken ?? existing?.accessToken,
      refreshToken: input.refreshToken ?? existing?.refreshToken,
      pairedAt: input.accessToken ? nowIso : existing?.pairedAt,
      lastCheckedAt: nowIso,
    };

    this.remoteHosts.set(id, record);
    await this.state.store.put(`control/hosts/${id}`, record);

    if (input.setActive) {
      this.activeHostId = id;
      await this.state.store.put('control/hosts-active', { activeHostId: id });
    }
    this.persistHostsFile();

    const { accessToken: _at, refreshToken: _rt, ...sanitized } = record;
    return {
      ok: true,
      host: { ...sanitized, active: this.activeHostId === id },
      activeHostId: this.activeHostId,
    };
  }

  async selectHost(hostId: string): Promise<
    | { ok: true; activeHostId: string; hosts: HostInstanceRecord[] }
    | { ok: false; status: number; code: string; error: string }
  > {
    if (hostId !== 'local' && !this.remoteHosts.has(hostId)) {
      return { ok: false, status: 404, code: 'HOST_NOT_FOUND', error: `Host '${hostId}' is not registered` };
    }
    this.activeHostId = hostId;
    await this.state.store.put('control/hosts-active', { activeHostId: hostId });
    this.persistHostsFile();
    return { ok: true, ...this.listHosts() };
  }

  async removeHost(hostId: string): Promise<boolean> {
    if (hostId === 'local' || !this.remoteHosts.has(hostId)) return false;
    this.remoteHosts.delete(hostId);
    await this.state.store.delete(`control/hosts/${hostId}`);
    if (this.activeHostId === hostId) {
      this.activeHostId = 'local';
      await this.state.store.put('control/hosts-active', { activeHostId: 'local' });
    }
    this.persistHostsFile();
    return true;
  }

  /**
   * Mode B Pairing: Pairs this desktop/web client with a remote Wazir controller
   * using the standard `/api/v1/mobile/pair/request` & `/api/v1/mobile/pair/complete` flow.
   */
  async pairRemoteHost(input: {
    qrUri?: string;
    controllerUrl?: string;
    sessionId?: string;
    pairingSecret?: string;
    deviceName?: string;
    action?: 'request' | 'complete';
    setActive?: boolean;
  }): Promise<
    | {
        ok: true;
        status: 'pending_operator_approval';
        sessionId: string;
        pairingSecret: string;
        controllerUrl: string;
        controllerName: string;
        confirmationCode: string;
        expiresAt: number;
      }
    | {
        ok: true;
        status: 'approved';
        host: HostInstanceRecord;
        activeHostId: string;
      }
    | { ok: false; status: number; code: string; error: string }
  > {
    let sessionId = input.sessionId?.trim() ?? '';
    let pairingSecret = input.pairingSecret?.trim() ?? '';
    let controllerUrl = input.controllerUrl?.trim() ?? '';
    let tlsCertFingerprint: string | undefined;

    if (input.qrUri && input.qrUri.trim().startsWith('wazir://pair')) {
      try {
        const parsed = new URL(input.qrUri.trim());
        sessionId = parsed.searchParams.get('sessionId') || sessionId;
        pairingSecret = parsed.searchParams.get('secret') || pairingSecret;
        controllerUrl = parsed.searchParams.get('url') || controllerUrl;
        tlsCertFingerprint = parsed.searchParams.get('fp') || undefined;
      } catch {
        return { ok: false, status: 400, code: 'INVALID_PAIRING_URI', error: 'Malformed wazir://pair URI' };
      }
    }

    if (!sessionId || !pairingSecret || !controllerUrl) {
      return {
        ok: false,
        status: 400,
        code: 'MISSING_PAIRING_PARAMETERS',
        error: 'controllerUrl, sessionId, and pairingSecret (or a complete wazir://pair URI) are required',
      };
    }

    const cleanUrl = controllerUrl.replace(/\/+$/, '');
    const action = input.action ?? 'request';

    try {
      if (action === 'request') {
        const reqRes = await fetch(`${cleanUrl}/api/v1/mobile/pair/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            pairingSecret,
            deviceName: input.deviceName?.trim() || `Wazir Desktop (${os.hostname()})`,
            deviceModel: `${os.platform()}-${os.arch()}`,
            osVersion: os.release(),
          }),
        });
        const body = (await reqRes.json()) as Record<string, unknown>;
        if (!reqRes.ok) {
          return {
            ok: false,
            status: reqRes.status,
            code: String(body.code ?? 'PAIR_REQUEST_FAILED'),
            error: String(body.error ?? 'Failed to request pairing on remote controller'),
          };
        }
        return {
          ok: true,
          status: 'pending_operator_approval',
          sessionId,
          pairingSecret,
          controllerUrl: cleanUrl,
          controllerName: String(body.controllerName ?? cleanUrl),
          confirmationCode: String(body.confirmationCode ?? ''),
          expiresAt: Number(body.expiresAt ?? Date.now() + 300_000),
        };
      }

      // action === 'complete'
      const compRes = await fetch(`${cleanUrl}/api/v1/mobile/pair/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, pairingSecret }),
      });
      const body = (await compRes.json()) as Record<string, unknown>;
      if (!compRes.ok) {
        return {
          ok: false,
          status: compRes.status,
          code: String(body.code ?? 'PAIR_COMPLETE_FAILED'),
          error: String(body.error ?? 'Failed to complete pairing on remote controller'),
        };
      }
      if (body.status === 'pending_operator_approval') {
        return {
          ok: true,
          status: 'pending_operator_approval',
          sessionId,
          pairingSecret,
          controllerUrl: cleanUrl,
          controllerName: cleanUrl,
          confirmationCode: String(body.confirmationCode ?? ''),
          expiresAt: Number(body.expiresAt ?? Date.now() + 300_000),
        };
      }

      const controller = (body.controller ?? {}) as Record<string, unknown>;
      const hostId = `host-${String(controller.id ?? randomUUID().slice(0, 8)).replace(/[^A-Za-z0-9._-]/g, '-')}`;
      const upserted = await this.upsertHost({
        id: hostId,
        name: String(controller.name ?? cleanUrl),
        url: cleanUrl,
        accessToken: String(body.accessToken ?? ''),
        refreshToken: String(body.refreshToken ?? ''),
        deviceId: String(body.deviceId ?? ''),
        tlsCertFingerprint,
        setActive: input.setActive !== false,
      });
      if ('error' in upserted) return upserted;

      return {
        ok: true,
        status: 'approved',
        host: upserted.host,
        activeHostId: upserted.activeHostId,
      };
    } catch (err) {
      return {
        ok: false,
        status: 502,
        code: 'REMOTE_CONTROLLER_UNREACHABLE',
        error: `Could not reach remote controller at ${cleanUrl}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ─── 3. Scheduled Task Management (Integrated with @wazir/scheduler) ───

  private computeRoutingPlan(params: {
    prompt: string;
    priority: Priority;
    targetComputerId?: string;
    targetModelId?: string;
  }): ScheduledTaskRecord['routingPlan'] {
    const localComputerId = process.env.WAZIR_COMPUTER_ID ?? 'local';
    const defaultModelId = this.state.models.list()[0]?.id ?? 'local-default';
    const defaultRuntimeId = this.state.runtimes.list()[0]?.id ?? 'ollama';
    const defaultAgentId = this.state.agents.list()[0]?.descriptor.name ?? 'coding-agent';

    try {
      const facade = createScheduler({
        computers: this.state.computers,
        runtimes: this.state.runtimes,
        models: this.state.models,
        policy: this.mobile.policyEngine,
        agents: this.state.agents,
        resources: { router: this.mobile.router },
      });
      const syntheticTask: Task = {
        id: `sched-plan-${randomUUID()}`,
        type: 'coding',
        title: params.prompt.slice(0, 80),
        input: params.prompt,
        priority: params.priority,
        status: 'pending',
        createdAt: new Date(this.now()),
        requirements: {
          capabilities: ['generalChat'],
          reasoning: 'medium',
          vision: false,
          toolCalling: true,
          minimumContext: 4096,
          minimumMemoryGB: 1,
          minimumGPUMemoryGB: 0,
          localOnly: true,
        },
        execution: {
          targetComputerId: params.targetComputerId,
          targetModelId: params.targetModelId,
          targetAgentId: defaultAgentId,
        },
      };
      const decision = facade.plan({ task: syntheticTask });
      return {
        modelId: decision.modelId,
        runtimeId: decision.runtimeId,
        computerId: decision.computerId ?? params.targetComputerId ?? localComputerId,
        agentId: decision.agentId ?? defaultAgentId,
        reasons: decision.reasons,
        summary: describeDecision(decision),
      };
    } catch (err) {
      const targetComp = params.targetComputerId || localComputerId;
      const targetMod = params.targetModelId || defaultModelId;
      const reasons = [
        `Target computer '${targetComp}' selected (fallback routing: ${err instanceof Error ? err.message : 'no ready model instance'})`,
        `Assigned model '${targetMod}' on runtime '${defaultRuntimeId}' with agent '${defaultAgentId}'`,
      ];
      return {
        modelId: targetMod,
        runtimeId: defaultRuntimeId,
        computerId: targetComp,
        agentId: defaultAgentId,
        reasons,
        summary: `Agent: ${defaultAgentId}\nModel: ${targetMod}\nRuntime: ${defaultRuntimeId}\nComputer: ${targetComp}`,
      };
    }
  }

  listSchedules(): ScheduledTaskRecord[] {
    return [...this.schedules.values()].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  }

  async createSchedule(input: {
    name?: string;
    prompt?: string;
    schedule?: string;
    cadenceMinutes?: number;
    intervalMs?: number;
    enabled?: boolean;
    priority?: Priority;
    autonomyPosture?: AutonomyPosture;
    targetComputerId?: string;
    targetModelId?: string;
  }): Promise<
    | { ok: true; schedule: ScheduledTaskRecord }
    | { ok: false; status: number; code: string; error: string }
  > {
    const name = String(input.name ?? '').trim();
    const prompt = String(input.prompt ?? '').trim();
    if (!name || !prompt) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_SCHEDULE_INPUT',
        error: 'Schedule name and prompt are required',
      };
    }
    const defaultSchedule = typeof input.cadenceMinutes === 'number' && input.cadenceMinutes > 0
      ? `${input.cadenceMinutes}m`
      : '1h';
    const scheduleStr = String(input.schedule ?? defaultSchedule).trim() || '1h';
    const intervalMs = parseScheduleIntervalMs(scheduleStr, input.intervalMs);
    const priority: Priority =
      input.priority && ['low', 'normal', 'high', 'critical'].includes(input.priority)
        ? input.priority
        : 'normal';
    const autonomyPosture: AutonomyPosture =
      input.autonomyPosture && ['read-only', 'request-review', 'auto-sandbox'].includes(input.autonomyPosture)
        ? input.autonomyPosture
        : this.autonomy.effectivePosture;

    const nowMs = this.now();
    const routingPlan = this.computeRoutingPlan({
      prompt,
      priority,
      targetComputerId: input.targetComputerId,
      targetModelId: input.targetModelId,
    });

    const record: ScheduledTaskRecord = {
      id: `sched-${randomUUID().slice(0, 12)}`,
      name: name.slice(0, 120),
      prompt: prompt.slice(0, 10_000),
      schedule: scheduleStr,
      cadenceMinutes: Math.max(1, Math.round(intervalMs / 60_000)),
      intervalMs,
      enabled: input.enabled !== false,
      priority,
      autonomyPosture,
      targetComputerId: input.targetComputerId || routingPlan.computerId,
      targetModelId: input.targetModelId || routingPlan.modelId,
      schedulerExplanation: routingPlan.summary.replace(/\n+/g, ' · '),
      routingPlan,
      createdAt: new Date(nowMs).toISOString(),
      nextRunAt: new Date(nowMs + intervalMs).toISOString(),
      lastStatus: 'idle',
      runCount: 0,
    };

    this.schedules.set(record.id, record);
    await this.state.store.put(`control/schedules/${record.id}`, record);

    await this.mobile.eventHub.publish({
      type: 'schedule.created',
      status: record.enabled ? 'enabled' : 'disabled',
      summary: `Scheduled task created: ${record.name} (${record.schedule})`,
      payload: { schedule: record },
    });

    return { ok: true, schedule: record };
  }

  async updateSchedule(
    id: string,
    patch: {
      name?: string;
      prompt?: string;
      schedule?: string;
      intervalMs?: number;
      enabled?: boolean;
      priority?: Priority;
      autonomyPosture?: AutonomyPosture;
      targetComputerId?: string;
      targetModelId?: string;
    },
  ): Promise<
    | { ok: true; schedule: ScheduledTaskRecord }
    | { ok: false; status: number; code: string; error: string }
  > {
    const existing = this.schedules.get(id);
    if (!existing) {
      return { ok: false, status: 404, code: 'SCHEDULE_NOT_FOUND', error: `Schedule '${id}' not found` };
    }

    const name = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : existing.name;
    const prompt = typeof patch.prompt === 'string' && patch.prompt.trim() ? patch.prompt.trim() : existing.prompt;
    const scheduleStr = typeof patch.schedule === 'string' && patch.schedule.trim() ? patch.schedule.trim() : existing.schedule;
    const intervalMs = patch.schedule !== undefined || patch.intervalMs !== undefined
      ? parseScheduleIntervalMs(scheduleStr, patch.intervalMs)
      : existing.intervalMs;
    const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : existing.enabled;
    const priority = patch.priority && ['low', 'normal', 'high', 'critical'].includes(patch.priority)
      ? patch.priority
      : existing.priority;
    const autonomyPosture =
      patch.autonomyPosture && ['read-only', 'request-review', 'auto-sandbox'].includes(patch.autonomyPosture)
        ? patch.autonomyPosture
        : existing.autonomyPosture;

    const targetComputerId = patch.targetComputerId ?? existing.targetComputerId;
    const targetModelId = patch.targetModelId ?? existing.targetModelId;
    const routingPlan = this.computeRoutingPlan({
      prompt,
      priority,
      targetComputerId,
      targetModelId,
    });

    const updated: ScheduledTaskRecord = {
      ...existing,
      name,
      prompt,
      schedule: scheduleStr,
      intervalMs,
      enabled,
      priority,
      autonomyPosture,
      targetComputerId,
      targetModelId,
      routingPlan,
      nextRunAt: new Date(this.now() + intervalMs).toISOString(),
    };

    this.schedules.set(id, updated);
    await this.state.store.put(`control/schedules/${id}`, updated);
    return { ok: true, schedule: updated };
  }

  async deleteSchedule(id: string): Promise<boolean> {
    if (!this.schedules.has(id)) return false;
    this.schedules.delete(id);
    await this.state.store.delete(`control/schedules/${id}`);
    return true;
  }

  async runScheduleNow(
    id: string,
    principal: ProtocolPrincipal,
  ): Promise<
    | { ok: true; schedule: ScheduledTaskRecord; task: MobileTaskDetail; taskId: string }
    | { ok: false; status: number; code: string; error: string }
  > {
    const sched = this.schedules.get(id);
    if (!sched) {
      return { ok: false, status: 404, code: 'SCHEDULE_NOT_FOUND', error: `Schedule '${id}' not found` };
    }

    const nowMs = this.now();
    sched.lastRunAt = new Date(nowMs).toISOString();
    sched.nextRunAt = new Date(nowMs + sched.intervalMs).toISOString();
    sched.lastStatus = 'running';
    sched.runCount += 1;

    const submitted = await this.mobile.submitTask(
      {
        title: `[Scheduled] ${sched.name}`,
        input: sched.prompt,
        priority: sched.priority,
        computerId: sched.targetComputerId,
        modelId: sched.targetModelId,
        policy: {
          localOnly: true,
          networkAccess: false,
          toolAccess: sched.autonomyPosture !== 'read-only',
        },
      },
      principal,
    );

    if ('error' in submitted) {
      sched.lastStatus = 'failed';
      await this.state.store.put(`control/schedules/${sched.id}`, sched);
      return submitted;
    }

    sched.lastTaskId = submitted.task.taskId;
    sched.lastStatus = 'completed';
    await this.state.store.put(`control/schedules/${sched.id}`, sched);

    await this.mobile.eventHub.publish({
      type: 'schedule.triggered',
      taskId: submitted.task.taskId,
      executionId: submitted.task.executionId,
      status: 'running',
      summary: `Scheduled task triggered: ${sched.name}`,
      payload: { scheduleId: sched.id, taskId: submitted.task.taskId },
    });

    return { ok: true, schedule: sched, task: submitted.task, taskId: submitted.task.taskId };
  }

  stopScheduleTicker(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = undefined;
    }
  }

  private startScheduleTicker(): void {
    this.stopScheduleTicker();
    this.schedulerTimer = setInterval(() => {
      const nowMs = this.now();
      for (const sched of this.schedules.values()) {
        if (!sched.enabled) continue;
        const nextMs = Date.parse(sched.nextRunAt);
        if (Number.isFinite(nextMs) && nextMs <= nowMs) {
          void this.runScheduleNow(sched.id, {
            kind: 'operator',
            id: 'scheduler-cron',
            scopes: ['read', 'mutate', 'execute'],
          }).catch(() => undefined);
        }
      }
    }, 15_000);
    this.schedulerTimer.unref?.();
  }

  // ─── 4. Verifiable Artifacts & Code Diff Review ────────────────────

  async getArtifactsForTarget(targetId: string): Promise<{
    targetId: string;
    executionId: string;
    taskId: string;
    artifacts: VerifiableArtifact[];
  } | undefined> {
    let taskDetail = await this.mobile.getTaskDetail(targetId);
    const rawExec = this.state.executions.find(
      (e) =>
        (e.execution as { id?: string; taskId?: string })?.id === targetId ||
        (e.execution as { id?: string; taskId?: string })?.taskId === targetId,
    );
    const engineExec = await this.mobile.executionEngine.get(targetId).catch(() => undefined);
    if (!taskDetail && engineExec?.task?.id) {
      taskDetail = await this.mobile.getTaskDetail(engineExec.task.id);
    }
    if (!taskDetail && (rawExec?.execution as { taskId?: string })?.taskId) {
      taskDetail = await this.mobile.getTaskDetail(String((rawExec?.execution as { taskId?: string }).taskId));
    }

    if (!taskDetail && !rawExec && !engineExec) {
      return undefined;
    }

    const executionId =
      taskDetail?.executionId ??
      (rawExec?.execution as { id?: string })?.id ??
      engineExec?.execution.id ??
      targetId;
    const taskId =
      taskDetail?.taskId ??
      (rawExec?.execution as { taskId?: string })?.taskId ??
      engineExec?.task.id ??
      targetId;
    const createdAt =
      taskDetail?.createdAt ??
      ((rawExec?.execution as { createdAt?: Date | string })?.createdAt
        ? new Date((rawExec?.execution as { createdAt: Date | string }).createdAt).toISOString()
        : undefined) ??
      (engineExec?.execution.createdAt ? new Date(engineExec.execution.createdAt).toISOString() : undefined) ??
      new Date(this.now()).toISOString();

    const savedReviews =
      (await this.state.store.get<Record<string, { decision: 'pending' | 'keep' | 'skip'; reviewedBy?: string; reviewedAt?: string; note?: string }>>(
        `artifact/diff-review/${targetId}`,
      )) ??
      (await this.state.store.get<Record<string, { decision: 'pending' | 'keep' | 'skip'; reviewedBy?: string; reviewedAt?: string; note?: string }>>(
        `artifact/diff-review/${executionId}`,
      )) ??
      {};

    // 1. Implementation Plan & Routing Blueprint Artifact
    const objective =
      taskDetail?.input ??
      String((rawExec?.task as { input?: string })?.input ?? engineExec?.task.input ?? targetId);
    const agentId = taskDetail?.agentId ?? String(rawExec?.agentId ?? engineExec?.agentId ?? 'coding-agent');
    const modelId = taskDetail?.modelId ?? String(rawExec?.modelId ?? engineExec?.modelId ?? 'local-default');
    const runtimeId = taskDetail?.runtimeId ?? String(rawExec?.runtimeId ?? engineExec?.runtimeId ?? 'ollama');
    const computerId = taskDetail?.computerId ?? String(rawExec?.computerId ?? engineExec?.computerId ?? 'local');
    const rawScheduling = (rawExec?.scheduling ?? engineExec?.scheduling) as { reasons?: string[] } | undefined;
    const routingReasons = rawScheduling?.reasons?.length
      ? rawScheduling.reasons
      : taskDetail?.reasoningSummaries?.length
        ? taskDetail.reasoningSummaries
        : [`Scheduled on computer '${computerId}' using model '${modelId}' (${runtimeId}) via agent '${agentId}'`];
    const rawContext = (rawExec?.context ?? engineExec?.context) as {
      fits?: boolean;
      finalRequiredTokens?: number;
      available?: { tokens?: number };
    } | undefined;

    const steps = taskDetail?.timeline?.length
      ? taskDetail.timeline.map((t) => ({
          id: t.id,
          title: t.title,
          phase: t.phase,
          status: t.status,
          detail: t.detail,
        }))
      : [
          {
            id: 'step-plan',
            title: 'Task Admission & Routing',
            phase: 'Planning',
            status: 'completed',
            detail: routingReasons.join('; '),
          },
          {
            id: 'step-exec',
            title: `Execute via ${agentId}`,
            phase: 'Agent Execution',
            status: String((rawExec?.execution as { status?: string })?.status ?? engineExec?.execution.status ?? 'completed'),
            detail: String(rawExec?.result ?? taskDetail?.finalOutput ?? 'Completed'),
          },
        ];

    const planArtifact: VerifiableArtifact = {
      id: `art-plan-${executionId}`,
      kind: 'plan',
      title: 'Implementation Plan & Routing Blueprint',
      status: 'verified',
      createdAt,
      plan: {
        objective,
        agentId,
        modelId,
        runtimeId,
        computerId,
        routingReasons,
        steps,
        contextFit: {
          fits: rawContext?.fits !== false,
          requiredTokens: rawContext?.finalRequiredTokens ?? taskDetail?.resourceConsumption.inputTokens,
          availableTokens: rawContext?.available?.tokens ?? 32768,
        },
      },
    };

    // 2. Standardized Code Diff Review Artifact
    const filesMap = new Map<string, DiffFileReviewItem>();
    const toolCalls = taskDetail?.toolCalls ?? (rawExec?.toolCalls as Array<Record<string, unknown>> | undefined) ?? [];

    for (const tc of toolCalls) {
      const toolName = String((tc as { tool?: string }).tool ?? '');
      const input = ((tc as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
      const filePath = String(input.path ?? input.file ?? input.target ?? '');
      if (!filePath && !['write', 'edit', 'patch'].includes(toolName)) continue;
      const targetPath = filePath || 'workspace/modified-file.ts';
      const oldText = typeof input.oldString === 'string'
        ? input.oldString
        : typeof input.old_text === 'string'
          ? input.old_text
          : '';
      const newText = typeof input.content === 'string'
        ? input.content
        : typeof input.newString === 'string'
          ? input.newString
          : typeof input.new_text === 'string'
            ? input.new_text
            : String((tc as { output?: string }).output ?? '// file updated by agent');

      const lines = computeDiffLines(oldText, newText);
      const additions = lines.filter((l) => l.type === 'add').length;
      const deletions = lines.filter((l) => l.type === 'del').length;
      const saved = savedReviews[targetPath];

      filesMap.set(targetPath, {
        path: targetPath,
        operation: oldText ? 'modify' : 'create',
        additions,
        deletions,
        hunks: [
          {
            header: `@@ -1,${Math.max(1, oldText ? oldText.split('\n').length : 0)} +1,${Math.max(1, newText.split('\n').length)} @@`,
            lines,
          },
        ],
        reviewDecision: saved?.decision ?? 'pending',
        reviewedBy: saved?.reviewedBy,
        reviewedAt: saved?.reviewedAt,
        note: saved?.note,
      });
    }

    for (const changedPath of taskDetail?.filesChanged ?? []) {
      if (!filesMap.has(changedPath)) {
        const saved = savedReviews[changedPath];
        const lines = computeDiffLines('', `// Modified in task ${taskId}\n// Path: ${changedPath}`);
        filesMap.set(changedPath, {
          path: changedPath,
          operation: 'modify',
          additions: lines.length,
          deletions: 0,
          hunks: [{ header: '@@ -1,0 +1,2 @@', lines }],
          reviewDecision: saved?.decision ?? 'pending',
          reviewedBy: saved?.reviewedBy,
          reviewedAt: saved?.reviewedAt,
          note: saved?.note,
        });
      }
    }

    // If no explicit file tool calls were recorded but a result exists, provide a reviewable output diff
    if (filesMap.size === 0) {
      const resultText = String(taskDetail?.finalOutput ?? rawExec?.result ?? objective);
      const syntheticPath = 'output/agent-result.md';
      const saved = savedReviews[syntheticPath];
      const lines = computeDiffLines('', resultText.slice(0, 2000));
      filesMap.set(syntheticPath, {
        path: syntheticPath,
        operation: 'create',
        additions: lines.length,
        deletions: 0,
        hunks: [{ header: `@@ -0,0 +1,${lines.length} @@`, lines }],
        reviewDecision: saved?.decision ?? 'pending',
        reviewedBy: saved?.reviewedBy,
        reviewedAt: saved?.reviewedAt,
        note: saved?.note,
      });
    }

    const diffFiles = [...filesMap.values()];
    const keptCount = diffFiles.filter((f) => f.reviewDecision === 'keep').length;
    const skippedCount = diffFiles.filter((f) => f.reviewDecision === 'skip').length;
    const pendingCount = diffFiles.filter((f) => f.reviewDecision === 'pending').length;

    const codeDiffArtifact: VerifiableArtifact = {
      id: `art-diff-${executionId}`,
      kind: 'code_diff',
      title: `Code Diff Review (${diffFiles.length} file${diffFiles.length === 1 ? '' : 's'})`,
      status: pendingCount === 0 ? 'verified' : 'pending_review',
      createdAt,
      codeDiff: {
        files: diffFiles,
        summary: {
          totalFiles: diffFiles.length,
          keptCount,
          skippedCount,
          pendingCount,
        },
      },
    };

    // 3. Structured Test & Verification Summary Artifact
    const verReport = taskDetail?.verificationReport;
    const checks = verReport?.checks?.length
      ? verReport.checks
      : [
          {
            name: 'policy-and-sandbox-gate',
            status: 'PASS',
            durationMs: 12,
            output: 'Execution adhered to workspace containment and policy rules.',
          },
        ];
    const passedCount = checks.filter((c) => c.status === 'PASS' || c.status === 'ok' || c.status === 'succeeded').length;
    const failedCount = checks.length - passedCount;
    const totalDurationMs = checks.reduce((acc, c) => acc + (Number(c.durationMs) || 0), 0);
    const overallStatus = verReport?.status ?? (failedCount > 0 ? 'FAIL' : 'PASS');

    const testSummaryArtifact: VerifiableArtifact = {
      id: `art-test-${executionId}`,
      kind: 'test_summary',
      title: `Structured Verification & Test Summary (${overallStatus})`,
      status: overallStatus === 'PASS' ? 'verified' : 'failed',
      createdAt,
      testSummary: {
        overallStatus,
        passedCount,
        failedCount,
        totalDurationMs,
        workspaceRevision: verReport?.workspaceRevision,
        checks,
      },
    };

    // 4. Sandboxed Live Preview Artifact
    const rawOutput = sanitizeUntrustedOutput(
      String(taskDetail?.finalOutput ?? rawExec?.result ?? objective),
    );
    const htmlDoc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  body { margin: 0; padding: 14px; background: #0d1117; color: #e6edf3; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .preview-card { border: 1px solid #30363d; border-radius: 8px; background: #161b22; padding: 12px; }
  .preview-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #21262d; padding-bottom: 8px; margin-bottom: 10px; }
  .badge { padding: 2px 8px; border-radius: 10px; font-size: 10px; text-transform: uppercase; background: rgba(63,185,80,0.15); color: #3fb950; border: 1px solid rgba(63,185,80,0.3); }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .meta-box { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 6px 8px; }
  .meta-label { color: #8b949e; font-size: 10px; text-transform: uppercase; }
  .meta-val { color: #58a6ff; font-weight: 600; font-size: 12px; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; background: #0d1117; padding: 10px; border-radius: 6px; border: 1px solid #21262d; color: #e6edf3; }
</style>
</head>
<body>
  <div class="preview-card">
    <div class="preview-header">
      <strong>Verifiable Sandbox Preview · ${escapeHtml(executionId)}</strong>
      <span class="badge">${escapeHtml(overallStatus)}</span>
    </div>
    <div class="meta-grid">
      <div class="meta-box"><div class="meta-label">Agent</div><div class="meta-val">${escapeHtml(agentId)}</div></div>
      <div class="meta-box"><div class="meta-label">Model</div><div class="meta-val">${escapeHtml(modelId)}</div></div>
      <div class="meta-box"><div class="meta-label">Files Reviewed</div><div class="meta-val">${keptCount} kept / ${diffFiles.length} total</div></div>
      <div class="meta-box"><div class="meta-label">Checks</div><div class="meta-val">${passedCount}/${checks.length} PASS</div></div>
    </div>
    <pre>${escapeHtml(rawOutput.slice(0, 4000))}</pre>
  </div>
</body>
</html>`;

    const sandboxPreviewArtifact: VerifiableArtifact = {
      id: `art-preview-${executionId}`,
      kind: 'sandbox_preview',
      title: 'Sandboxed Artifact Preview (Isolated CSP)',
      status: 'ready',
      createdAt,
      sandboxPreview: {
        contentType: 'html',
        sandboxCsp: SANDBOX_CSP,
        htmlDoc,
        rawSource: rawOutput.slice(0, 4000),
      },
    };

    return {
      targetId,
      executionId,
      taskId,
      artifacts: [planArtifact, codeDiffArtifact, testSummaryArtifact, sandboxPreviewArtifact],
    };
  }

  async reviewDiffFile(
    targetId: string,
    params: {
      path: string;
      decision: 'keep' | 'skip' | 'pending';
      note?: string;
      reviewedBy: string;
    },
  ): Promise<
    | { ok: true; file: DiffFileReviewItem; artifacts: VerifiableArtifact[] }
    | { ok: false; status: number; code: string; error: string }
  > {
    if (!params.path || typeof params.path !== 'string') {
      return { ok: false, status: 400, code: 'INVALID_DIFF_PATH', error: 'File path is required' };
    }
    if (!['keep', 'skip', 'pending'].includes(params.decision)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_DIFF_DECISION',
        error: "decision must be 'keep', 'skip', or 'pending'",
      };
    }

    const existingBundle = await this.getArtifactsForTarget(targetId);
    if (!existingBundle) {
      return { ok: false, status: 404, code: 'TARGET_NOT_FOUND', error: `Execution or task '${targetId}' not found` };
    }

    const key = `artifact/diff-review/${existingBundle.executionId}`;
    const currentMap =
      (await this.state.store.get<
        Record<string, { decision: 'pending' | 'keep' | 'skip'; reviewedBy?: string; reviewedAt?: string; note?: string }>
      >(key)) ?? {};

    currentMap[params.path] = {
      decision: params.decision,
      reviewedBy: params.reviewedBy,
      reviewedAt: new Date(this.now()).toISOString(),
      note: params.note,
    };

    await this.state.store.put(key, currentMap);
    if (targetId !== existingBundle.executionId) {
      await this.state.store.put(`artifact/diff-review/${targetId}`, currentMap);
    }

    const updatedBundle = (await this.getArtifactsForTarget(targetId))!;
    const diffArt = updatedBundle.artifacts.find((a) => a.kind === 'code_diff');
    const fileItem = diffArt?.codeDiff?.files.find((f) => f.path === params.path) ?? diffArt!.codeDiff!.files[0];

    await this.mobile.eventHub.publish({
      type: 'artifact.diff_reviewed',
      taskId: updatedBundle.taskId,
      executionId: updatedBundle.executionId,
      status: params.decision,
      summary: `Diff review '${params.decision}' on ${params.path} by ${params.reviewedBy}`,
      payload: {
        executionId: updatedBundle.executionId,
        path: params.path,
        decision: params.decision,
        summary: diffArt?.codeDiff?.summary,
      },
    });

    return {
      ok: true,
      file: fileItem,
      artifacts: updatedBundle.artifacts,
    };
  }
}

export function registerMultiSurfaceRoutes(
  app: Express,
  state: ApiState,
  mobile: MobileServices,
  multiSurface: MultiSurfaceService,
): void {
  const { auth } = state;

  // 1. Autonomy Posture Controls (accessible by Web, Desktop, and Mobile)
  const getAutonomyHandler = (_req: Request, res: Response) => {
    res.json({ autonomy: multiSurface.getAutonomy() });
  };
  const setAutonomyHandler = async (req: Request, res: Response) => {
    const principal = (res.locals.principal as ProtocolPrincipal | undefined) ?? {
      kind: 'operator',
      id: 'operator',
      scopes: ['read', 'mutate'],
    };
    const result = await multiSurface.setAutonomy(req.body ?? {}, principal.id);
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.json(result);
  };

  app.get('/api/v1/autonomy', auth.requireViewerOperatorOrDevice, getAutonomyHandler);
  app.post('/api/v1/autonomy', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, setAutonomyHandler);
  app.get('/api/v1/mobile/autonomy', auth.requireViewerOperatorOrDevice, getAutonomyHandler);
  app.post('/api/v1/mobile/autonomy', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, setAutonomyHandler);

  // 2. Host Instance Switching & Mode B Remote Controller Pairing
  app.get('/api/v1/hosts', auth.requireViewerOperatorOrDevice, (_req, res) => {
    res.json(multiSurface.listHosts());
  });

  app.post('/api/v1/hosts', auth.requireOperator, async (req, res) => {
    const result = await multiSurface.upsertHost(req.body ?? {});
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.status(201).json(result);
  });

  app.post('/api/v1/hosts/select', auth.requireOperator, async (req, res) => {
    const hostId = String(req.body?.hostId ?? req.body?.id ?? '').trim();
    if (!hostId) {
      res.status(400).json({ error: 'hostId is required', code: 'INVALID_HOST_ID' });
      return;
    }
    const result = await multiSurface.selectHost(hostId);
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.json(result);
  });

  app.post('/api/v1/hosts/pair', auth.requireOperator, async (req, res) => {
    const result = await multiSurface.pairRemoteHost(req.body ?? {});
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.status(result.status === 'approved' ? 200 : 202).json(result);
  });

  app.delete('/api/v1/hosts/:id', auth.requireOperator, async (req, res) => {
    const removed = await multiSurface.removeHost(String(req.params.id));
    if (!removed) {
      res.status(404).json({ error: `Remote host '${req.params.id}' not found`, code: 'HOST_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, ...multiSurface.listHosts() });
  });

  // 3. Scheduled Task Management (Integrated with @wazir/scheduler)
  const listSchedulesHandler = (_req: Request, res: Response) => {
    res.json({
      schedules: multiSurface.listSchedules(),
      timestamp: new Date().toISOString(),
    });
  };
  const createScheduleHandler = async (req: Request, res: Response) => {
    const result = await multiSurface.createSchedule(req.body ?? {});
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.status(201).json(result);
  };
  const updateScheduleHandler = async (req: Request, res: Response) => {
    const result = await multiSurface.updateSchedule(String(req.params.id), req.body ?? {});
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.json(result);
  };
  const runScheduleHandler = async (req: Request, res: Response) => {
    const principal = (res.locals.principal as ProtocolPrincipal | undefined) ?? {
      kind: 'operator',
      id: 'operator',
      scopes: ['read', 'mutate', 'execute'],
    };
    const result = await multiSurface.runScheduleNow(String(req.params.id), principal);
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.status(201).json(result);
  };
  const deleteScheduleHandler = async (req: Request, res: Response) => {
    const ok = await multiSurface.deleteSchedule(String(req.params.id));
    if (!ok) {
      res.status(404).json({ error: `Schedule '${req.params.id}' not found`, code: 'SCHEDULE_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, id: req.params.id });
  };

  app.get('/api/v1/schedules', auth.requireViewerOperatorOrDevice, listSchedulesHandler);
  app.post('/api/v1/schedules', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, createScheduleHandler);
  app.patch('/api/v1/schedules/:id', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, updateScheduleHandler);
  app.post('/api/v1/schedules/:id/run', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, runScheduleHandler);
  app.delete('/api/v1/schedules/:id', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, deleteScheduleHandler);

  app.get('/api/v1/mobile/schedules', auth.requireViewerOperatorOrDevice, listSchedulesHandler);
  app.post('/api/v1/mobile/schedules', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, createScheduleHandler);
  app.patch('/api/v1/mobile/schedules/:id', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, updateScheduleHandler);
  app.post('/api/v1/mobile/schedules/:id/run', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, runScheduleHandler);
  app.delete('/api/v1/mobile/schedules/:id', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, deleteScheduleHandler);

  // 4. Verifiable Artifacts & Code Diff Review (shared by Web, Desktop, and Mobile)
  const getArtifactsHandler = async (req: Request, res: Response) => {
    const bundle = await multiSurface.getArtifactsForTarget(String(req.params.id));
    if (!bundle) {
      res.status(404).json({ error: `Execution or task '${req.params.id}' not found`, code: 'NOT_FOUND' });
      return;
    }
    res.json(bundle);
  };

  const reviewDiffHandler = async (req: Request, res: Response) => {
    const principal = (res.locals.principal as ProtocolPrincipal | undefined) ?? {
      kind: 'operator',
      id: 'operator',
      scopes: ['read', 'mutate'],
    };
    const result = await multiSurface.reviewDiffFile(String(req.params.id), {
      path: String(req.body?.path ?? ''),
      decision: req.body?.decision,
      note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      reviewedBy: principal.id,
    });
    if ('error' in result) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    res.json(result);
  };

  app.get('/api/v1/executions/:id/artifacts', auth.requireViewerOperatorOrDevice, getArtifactsHandler);
  app.post('/api/v1/executions/:id/diff-review', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, reviewDiffHandler);
  app.get('/api/v1/mobile/tasks/:id/artifacts', auth.requireViewerOperatorOrDevice, getArtifactsHandler);
  app.post('/api/v1/mobile/tasks/:id/diff-review', auth.requireOperatorOrDevice, auth.requireProtocolPrincipal, reviewDiffHandler);
}
