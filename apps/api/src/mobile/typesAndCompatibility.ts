import { createHash, timingSafeEqual } from 'node:crypto';
import type { Priority, ProtocolScope } from '@wazir/core';
import { sanitizeUntrustedOutput } from '@wazir/shared';
import { wazirVersion } from '../version.js';

export const MOBILE_API_VERSION = '1.0.0';
export const MOBILE_PROTOCOL_VERSION = '1.0.0';
export const MIN_MOBILE_APP_VERSION = '0.1.0';
export const MIN_SUPPORTED_MOBILE_VERSION = MIN_MOBILE_APP_VERSION;
export const CONTROLLER_VERSION = process.env.WAZIR_VERSION?.trim() || wazirVersion();

export interface MobileCompatibilityInput {
  clientVersion?: string;
  protocolVersion?: string | number;
  controllerVersion?: string;
  minMobileAppVersion?: string;
  supportedProtocolVersion?: string | number;
}

export interface MobileCompatibilityResult {
  compatible: boolean;
  controllerVersion: string;
  minMobileAppVersion: string;
  minMobileVersion: string;
  protocolVersion: string;
  apiVersion: string;
  clientVersion: string;
  requestedProtocolVersion?: string;
  upgradeRequired?: 'client' | 'controller';
  code?: string;
  reason?: string;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseSemver(raw: string): ParsedSemver | undefined {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    raw.trim(),
  );
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (a.prerelease && b.prerelease) return a.prerelease.localeCompare(b.prerelease);
  return 0;
}

function parseProtocolMajor(raw: string): number | undefined {
  const trimmed = raw.trim().replace(/^v/i, '');
  if (/^(0|[1-9]\d*)$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(trimmed)) {
    return Number(trimmed.split('.')[0]);
  }
  const sem = parseSemver(trimmed);
  return sem?.major;
}

/**
 * Evaluates semver and protocol compatibility between a Wazir Mobile client and the controller.
 */
export function evaluateMobileCompatibility(input: MobileCompatibilityInput = {}): MobileCompatibilityResult {
  const controllerVersion = (input.controllerVersion ?? CONTROLLER_VERSION).trim();
  const minMobileAppVersion = (input.minMobileAppVersion ?? MIN_MOBILE_APP_VERSION).trim();
  const supportedProtocol = String(input.supportedProtocolVersion ?? MOBILE_PROTOCOL_VERSION).trim();
  const rawClientVersion =
    typeof input.clientVersion === 'string' && input.clientVersion.trim()
      ? input.clientVersion.trim()
      : undefined;
  const rawProtocolVersion =
    input.protocolVersion !== undefined &&
    input.protocolVersion !== null &&
    String(input.protocolVersion).trim() !== ''
      ? String(input.protocolVersion).trim()
      : undefined;

  const base: MobileCompatibilityResult = {
    compatible: true,
    controllerVersion,
    minMobileAppVersion,
    minMobileVersion: minMobileAppVersion,
    protocolVersion: supportedProtocol,
    apiVersion: MOBILE_API_VERSION,
    clientVersion: rawClientVersion ?? controllerVersion,
    ...(rawProtocolVersion ? { requestedProtocolVersion: rawProtocolVersion } : {}),
  };

  if (rawProtocolVersion !== undefined) {
    const supportedMajor = parseProtocolMajor(supportedProtocol) ?? 1;
    const requestedMajor = parseProtocolMajor(rawProtocolVersion);
    if (requestedMajor === undefined || requestedMajor !== supportedMajor) {
      const upgradeRequired: 'client' | 'controller' =
        requestedMajor !== undefined && requestedMajor > supportedMajor ? 'controller' : 'client';
      return {
        ...base,
        compatible: false,
        upgradeRequired,
        code: 'INCOMPATIBLE_PROTOCOL_VERSION',
        reason: `Unsupported mobile protocol version '${rawProtocolVersion}'; controller supports protocol version ${supportedProtocol}`,
      };
    }
  }

  if (rawClientVersion !== undefined) {
    const clientSemver = parseSemver(rawClientVersion);
    if (!clientSemver) {
      return {
        ...base,
        compatible: false,
        upgradeRequired: 'client',
        code: 'INVALID_CLIENT_VERSION',
        reason: `Malformed mobile client version '${rawClientVersion}'; expected semver major.minor.patch`,
      };
    }

    const minSemver = parseSemver(minMobileAppVersion) ?? { major: 0, minor: 1, patch: 0 };
    const controllerSemver = parseSemver(controllerVersion) ?? { major: 0, minor: 2, patch: 12 };

    if (compareSemver(clientSemver, minSemver) < 0) {
      return {
        ...base,
        compatible: false,
        upgradeRequired: 'client',
        code: 'CLIENT_UPGRADE_REQUIRED',
        reason: `Mobile client version ${rawClientVersion} is below minimum supported version ${minMobileAppVersion}; please upgrade the mobile app`,
      };
    }

    if (
      clientSemver.major > controllerSemver.major ||
      (clientSemver.major === controllerSemver.major && clientSemver.minor > controllerSemver.minor) ||
      compareSemver(clientSemver, controllerSemver) > 0
    ) {
      return {
        ...base,
        compatible: false,
        upgradeRequired: 'controller',
        code: 'CONTROLLER_UPGRADE_REQUIRED',
        reason: `Mobile client version ${rawClientVersion} requires a newer controller than ${controllerVersion}; please upgrade the Wazir controller`,
      };
    }
  }

  return base;
}

export const MAX_MOBILE_EVENTS = 1_000;
export const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_PAIRING_ATTEMPTS = 3;
export const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type MobileEventType =
  | 'task.created'
  | 'task.started'
  | 'task.phase_changed'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.blocked'
  | 'task.resumed'
  | 'model.selected'
  | 'model.loaded'
  | 'model.unloaded'
  | 'tool.started'
  | 'tool.executed'
  | 'tool.failed'
  | 'verification.started'
  | 'verification.passed'
  | 'verification.failed'
  | 'worker.connected'
  | 'worker.disconnected'
  | 'worker.heartbeat'
  | 'approval.requested'
  | 'approval.resolved'
  | 'approval.expired'
  | 'resource.warning'
  | 'resource.emergency_stop'
  | 'resource.resumed';

export interface MobileStreamEvent {
  sequence: number;
  eventId: string;
  timestamp: string;
  type: string;
  taskId?: string;
  executionId?: string;
  computerId?: string;
  approvalId?: string;
  agentId?: string;
  modelId?: string;
  status?: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface PairingSessionRecord {
  sessionId: string;
  secretHash: string;
  createdAt: string;
  expiresAt: number;
  status: 'waiting_for_device' | 'pending_operator_approval' | 'approved' | 'rejected' | 'claimed' | 'expired';
  attempts: number;
  scopes: ProtocolScope[];
  controllerUrl?: string;
  tlsCertFingerprint?: string;
  confirmationCode?: string;
  deviceRequest?: {
    deviceId: string;
    deviceName: string;
    deviceModel?: string;
    osVersion?: string;
    publicKeyFingerprint?: string;
    requestedAt: string;
  };
  issuedCredential?: {
    deviceId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: ProtocolScope[];
  };
}

export type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface MobileApprovalRecord {
  id: string;
  taskId?: string;
  taskTitle?: string;
  executionId?: string;
  agentId?: string;
  tool: string;
  operation: string;
  redactedArguments: Record<string, unknown>;
  argumentsHash: string;
  relevantResources: string[];
  riskClassification: ApprovalRiskLevel;
  requiresBiometric: boolean;
  rule: string;
  reasons: string[];
  expectedSideEffects: string;
  createdAt: string;
  expiresAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
}

export interface MobileTaskSummary {
  taskId: string;
  executionId?: string;
  jobId?: string;
  title: string;
  input: string;
  agentId: string;
  modelId: string;
  runtimeId: string;
  computerId: string;
  priority: Priority;
  state: 'running' | 'queued' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  phase: 'Planning' | 'Agent Execution' | 'Tool Calls' | 'Verification' | 'Completion' | 'Queued' | 'Blocked';
  currentOperation?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastActivityAt: string;
  elapsedMs: number;
  verificationStatus: 'PASS' | 'FAIL' | 'ERROR' | 'UNAVAILABLE' | 'PENDING';
  pendingApprovalIds: string[];
  supportedActions: Array<'cancel' | 'retry' | 'resume' | 'inspect' | 'logs'>;
}

export interface MobileTaskDetail extends MobileTaskSummary {
  repository?: string;
  policy?: Record<string, unknown>;
  resourceBudget?: {
    maxTokens?: number;
    maxCostUsd?: number;
    maxExecutionTimeSeconds?: number;
  };
  timeline: Array<{
    id: string;
    phase: string;
    title: string;
    status: string;
    timestamp: string;
    durationMs?: number;
    detail?: string;
  }>;
  reasoningSummaries: string[];
  toolCalls: Array<{
    callId: string;
    tool: string;
    status: 'running' | 'succeeded' | 'failed' | 'denied';
    input: Record<string, unknown>;
    output?: string;
    error?: string;
    durationMs: number;
    timestamp: string;
  }>;
  filesChanged: string[];
  verificationReport?: {
    status: string;
    checks: Array<{
      name: string;
      status: string;
      durationMs: number;
      output?: string;
      error?: string;
    }>;
    reasons: string[];
    workspaceRevision?: string;
    completedAt?: string;
  };
  errors: string[];
  resourceConsumption: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
    source: 'provider-reported' | 'estimated' | 'conservative';
  };
  finalOutput?: string;
  logs: Array<{
    sequence: number;
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    phase: string;
    message: string;
  }>;
}

export interface ManagedMobileTask {
  taskId: string;
  executionId: string;
  jobId: string;
  title: string;
  input: string;
  repository: string;
  agentId: string;
  modelId: string;
  runtimeId: string;
  computerId: string;
  priority: Priority;
  state: 'running' | 'queued' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  phase: 'Planning' | 'Agent Execution' | 'Tool Calls' | 'Verification' | 'Completion' | 'Queued' | 'Blocked';
  currentOperation?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastActivityAt: string;
  verificationStatus: 'PASS' | 'FAIL' | 'ERROR' | 'UNAVAILABLE' | 'PENDING';
  policy?: Record<string, unknown>;
  resourceBudget?: {
    maxTokens?: number;
    maxCostUsd?: number;
    maxExecutionTimeSeconds?: number;
  };
  timeline: MobileTaskDetail['timeline'];
  reasoningSummaries: string[];
  toolCalls: MobileTaskDetail['toolCalls'];
  filesChanged: string[];
  verificationReport?: MobileTaskDetail['verificationReport'];
  errors: string[];
  resourceConsumption: MobileTaskDetail['resourceConsumption'];
  finalOutput?: string;
  logs: MobileTaskDetail['logs'];
  plannedOperations?: Array<{
    tool?: { name: string; input: Record<string, unknown> };
    verify?: string[];
  }>;
}

const SECRET_KEY_PATTERN = /(password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key|credential|cookie)/i;
const BEARER_VALUE_PATTERN = /(Bearer\s+[A-Za-z0-9._~+/=-]+|mob_(?:at|rt)_[A-Fa-f0-9]+|nvapi-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{12,})/g;

export function redactSensitiveArguments(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    return sanitizeUntrustedOutput(input.replace(BEARER_VALUE_PATTERN, '[REDACTED]'));
  }
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveArguments(item));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSensitiveArguments(v);
    }
  }
  return out;
}

export function computeArgumentsHash(params: {
  tool: string;
  input: Record<string, unknown>;
  taskId?: string;
  executionId?: string;
}): string {
  const canonical = JSON.stringify({
    tool: params.tool,
    input: sortObjectKeys(params.input),
    taskId: params.taskId ?? '',
    executionId: params.executionId ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function sortObjectKeys(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    out[k] = sortObjectKeys(v);
  }
  return out;
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export function classifyApprovalRisk(tool: string, input: Record<string, unknown>, rule: string): {
  riskClassification: ApprovalRiskLevel;
  requiresBiometric: boolean;
  operation: string;
  relevantResources: string[];
  expectedSideEffects: string;
} {
  const resources: string[] = [];
  if (typeof input.path === 'string') resources.push(input.path);
  if (typeof input.file === 'string') resources.push(input.file);
  if (typeof input.target === 'string') resources.push(input.target);
  const cmd = typeof input.command === 'string' ? input.command : '';

  if (tool === 'shell') {
    const highRiskPattern = /\b(rm|chmod|chown|docker|kubectl|npm|pnpm|yarn|pip|brew|apt|cargo\s+install|cmake\s+--install|curl|wget|ssh)\b/i;
    const criticalPattern = /\b(rm\s+-rf|sudo|dd|mkfs|systemctl|launchctl)\b/i;
    const risk: ApprovalRiskLevel = criticalPattern.test(cmd)
      ? 'critical'
      : highRiskPattern.test(cmd) || rule.includes('protected')
        ? 'high'
        : 'high';
    return {
      riskClassification: risk,
      requiresBiometric: true,
      operation: cmd ? `shell: ${cmd.slice(0, 120)}` : 'Execute shell command',
      relevantResources: resources.length ? resources : ['project workspace'],
      expectedSideEffects: 'Executes a process in the controller project workspace that may modify files or invoke local build/runtime binaries.',
    };
  }

  if (tool === 'write' || tool === 'edit') {
    const isProtected = rule.includes('protected') || resources.some((r) => /(\.git|package\.json|\.env|wazir)/i.test(r));
    const risk: ApprovalRiskLevel = isProtected ? 'high' : 'medium';
    return {
      riskClassification: risk,
      requiresBiometric: risk === 'high',
      operation: `${tool}: ${resources.join(', ') || 'workspace file'}`,
      relevantResources: resources,
      expectedSideEffects: isProtected
        ? 'Modifies a protected project configuration, manifest, or repository control file.'
        : 'Modifies source files inside the controller workspace.',
    };
  }

  if (tool === 'git') {
    const subcommand = typeof input.subcommand === 'string' ? input.subcommand : cmd;
    const isHigh = /\b(reset|rebase|merge|checkout|stash)\b/i.test(String(subcommand));
    const risk: ApprovalRiskLevel = isHigh ? 'high' : 'medium';
    return {
      riskClassification: risk,
      requiresBiometric: risk === 'high',
      operation: `git ${String(subcommand || '').slice(0, 80)}`.trim(),
      relevantResources: resources.length ? resources : ['.git'],
      expectedSideEffects: 'Mutates local Git working tree, staging index, or branch state.',
    };
  }

  return {
    riskClassification: 'medium',
    requiresBiometric: false,
    operation: `${tool}`,
    relevantResources: resources,
    expectedSideEffects: `Executes tool '${tool}' on the Wazir controller.`,
  };
}
