import { createHash } from 'node:crypto';
import type { TaskType, PolicyRequirements } from './task.js';
import type {
  ToolCallRecord,
  CheckRunRecord,
  ExecutionRecord,
} from './execution.js';
import type { CostStatus } from './telemetry.js';
import type { AgentErrorKind, TerminationReason, AgentResumeContext } from './agent.js';

export const HARNESS_CONTRACT_SCHEMA_VERSION = 1 as const;

export type HarnessKind = 'native' | 'acp' | 'external-cli';

export type HarnessCapability =
  | 'coding'
  | 'chat'
  | 'step-execution'
  | 'streaming'
  | 'tool-Forwarding'
  | 'checkpoint-resume'
  | 'cancellation'
  | 'mcp'
  | 'workspace-isolation';

export interface HarnessDescriptor {
  harnessId: string;
  name: string;
  version: string;
  kind: HarnessKind;
  capabilities: HarnessCapability[];
  supportedTaskTypes: TaskType[];
  supportedProtocols: Array<'native' | 'acp' | 'stdio-cli'>;
  requiresBinary?: string;
  allowsModelSelection: boolean;
  defaultPermissionMode?: 'read' | 'edit' | 'full';
}

export interface UnifiedExecutionRequest {
  schemaVersion?: number;
  executionId: string;
  taskId: string;
  objective: string;
  taskType?: TaskType;

  harnessPreference?: string;
  modelPreference?: string;
  runtimePreference?: string;

  workspace: {
    root: string;
    revision: string | number;
  };

  constraints: {
    maxCostUSD?: number;
    maxDurationMs?: number;
    maxTokens?: number;
    maxAttempts?: number;
    maxTurns?: number;
    maxToolCalls?: number;
    allowFallback: boolean;
  };

  verification: {
    requiredChecks: string[];
    protectedPaths: string[];
    mutationRequired?: boolean;
    expectedArtifacts?: string[];
  };

  policyContext: PolicyRequirements | Record<string, unknown>;

  checkpointId?: string;
  resumeContext?: AgentResumeContext;
  isCancelled?: () => boolean;
}

export type UnifiedExecutionStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown';

export interface UnifiedArtifactRecord {
  path: string;
  hash?: string;
  kind?: 'file' | 'patch' | 'log' | 'evidence';
  createdAt?: string;
}

export interface UnifiedExecutionResult {
  schemaVersion: number;
  executionId: string;
  taskId: string;

  harnessId: string;
  harnessKind?: HarnessKind;
  modelId: string;
  runtimeId: string;

  status: UnifiedExecutionStatus;
  /** True only when independent controller verification passed at workspaceRevision. */
  verified?: boolean;
  terminationReason?: TerminationReason;
  errorKind?: AgentErrorKind;

  workspaceRevision: string;
  filesChanged?: string[];

  artifacts: UnifiedArtifactRecord[];
  toolCalls: ToolCallRecord[];
  checks?: CheckRunRecord[];

  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUSD?: number;
    costStatus?: CostStatus;
    durationMs: number;
    firstTokenLatencyMs?: number;
    modelCalls?: number;
  };

  verificationEvidenceIds: string[];

  checkpointId?: string;
  failureClassification?: string;
  errors?: string[];
  output?: string;
  provenance?: {
    startedAt: string;
    completedAt: string;
    contractDigest: string;
  };
}

export const VALID_HARNESS_KINDS: ReadonlySet<HarnessKind> = new Set([
  'native',
  'acp',
  'external-cli',
]);

export const VALID_EXECUTION_STATUSES: ReadonlySet<UnifiedExecutionStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
]);

export const VALID_COST_STATUSES: ReadonlySet<CostStatus> = new Set([
  'ACTUAL',
  'ESTIMATED',
  'UNKNOWN',
]);

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}

function isNonNegativeNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0;
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (typeof value === 'function') {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const v = record[key];
    if (v !== undefined && typeof v !== 'function') {
      out[key] = canonicalizeValue(v);
    }
  }
  return out;
}

/**
 * Computes a deterministic SHA-256 hex digest of a UnifiedExecutionRequest.
 * Normalizes schemaVersion and sorts object keys recursively while ignoring transient callbacks (isCancelled).
 */
export function computeRequestContractDigest(req: UnifiedExecutionRequest): string {
  const payload = {
    schemaVersion: req.schemaVersion ?? HARNESS_CONTRACT_SCHEMA_VERSION,
    executionId: req.executionId,
    taskId: req.taskId,
    objective: req.objective,
    taskType: req.taskType,
    harnessPreference: req.harnessPreference,
    modelPreference: req.modelPreference,
    runtimePreference: req.runtimePreference,
    workspace: req.workspace,
    constraints: req.constraints,
    verification: req.verification,
    policyContext: req.policyContext,
    checkpointId: req.checkpointId,
  };
  const canonicalJson = JSON.stringify(canonicalizeValue(payload));
  return createHash('sha256').update(canonicalJson).digest('hex');
}

/**
 * Validates a UnifiedExecutionRequest at runtime.
 */
export function validateUnifiedExecutionRequest(req: unknown): {
  valid: boolean;
  errors: string[];
  value?: UnifiedExecutionRequest;
} {
  const errors: string[] = [];
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    return { valid: false, errors: ['Request must be a non-null object'] };
  }

  const r = req as Record<string, unknown>;

  if (
    r.schemaVersion !== undefined &&
    r.schemaVersion !== HARNESS_CONTRACT_SCHEMA_VERSION
  ) {
    errors.push(
      `Unsupported schemaVersion: ${String(r.schemaVersion)} (expected ${HARNESS_CONTRACT_SCHEMA_VERSION})`,
    );
  }

  if (!isNonEmptyString(r.executionId)) {
    errors.push('executionId must be a non-empty string');
  }
  if (!isNonEmptyString(r.taskId)) {
    errors.push('taskId must be a non-empty string');
  }
  if (!isNonEmptyString(r.objective)) {
    errors.push('objective must be a non-empty string');
  }

  if (!r.workspace || typeof r.workspace !== 'object' || Array.isArray(r.workspace)) {
    errors.push('workspace must be a non-null object');
  } else {
    const ws = r.workspace as Record<string, unknown>;
    if (!isNonEmptyString(ws.root)) {
      errors.push('workspace.root must be a non-empty string');
    }
    const revValid =
      (typeof ws.revision === 'string' && ws.revision.trim().length > 0) ||
      (typeof ws.revision === 'number' && Number.isFinite(ws.revision) && ws.revision >= 0);
    if (!revValid) {
      errors.push('workspace.revision must be a non-empty string or non-negative number');
    }
  }

  if (!r.constraints || typeof r.constraints !== 'object' || Array.isArray(r.constraints)) {
    errors.push('constraints must be a non-null object');
  } else {
    const c = r.constraints as Record<string, unknown>;
    if (typeof c.allowFallback !== 'boolean') {
      errors.push('constraints.allowFallback must be a boolean');
    }
    for (const field of [
      'maxCostUSD',
      'maxDurationMs',
      'maxTokens',
      'maxAttempts',
      'maxTurns',
      'maxToolCalls',
    ] as const) {
      if (c[field] !== undefined && !isNonNegativeNumber(c[field])) {
        errors.push(`constraints.${field} must be a non-negative finite number`);
      }
    }
  }

  if (
    !r.verification ||
    typeof r.verification !== 'object' ||
    Array.isArray(r.verification)
  ) {
    errors.push('verification must be a non-null object');
  } else {
    const v = r.verification as Record<string, unknown>;
    if (!Array.isArray(v.requiredChecks) || !v.requiredChecks.every(isNonEmptyString)) {
      errors.push('verification.requiredChecks must be an array of non-empty strings');
    }
    if (!Array.isArray(v.protectedPaths) || !v.protectedPaths.every(isNonEmptyString)) {
      errors.push('verification.protectedPaths must be an array of non-empty strings');
    }
    if (v.mutationRequired !== undefined && typeof v.mutationRequired !== 'boolean') {
      errors.push('verification.mutationRequired must be a boolean when provided');
    }
    if (
      v.expectedArtifacts !== undefined &&
      (!Array.isArray(v.expectedArtifacts) || !v.expectedArtifacts.every(isNonEmptyString))
    ) {
      errors.push('verification.expectedArtifacts must be an array of non-empty strings');
    }
  }

  if (
    !r.policyContext ||
    typeof r.policyContext !== 'object' ||
    Array.isArray(r.policyContext)
  ) {
    errors.push('policyContext must be a non-null object');
  }

  if (r.isCancelled !== undefined && typeof r.isCancelled !== 'function') {
    errors.push('isCancelled must be a function when provided');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const normalized: UnifiedExecutionRequest = {
    ...(r as unknown as UnifiedExecutionRequest),
    schemaVersion: (r.schemaVersion as number | undefined) ?? HARNESS_CONTRACT_SCHEMA_VERSION,
  };

  return { valid: true, errors: [], value: normalized };
}

/**
 * Migrates legacy or unversioned execution result payloads to the current schema version (1).
 * Preserves semantic invariants without coercing UNKNOWN costs to 0.
 */
export function migrateUnifiedExecutionResult(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...raw };
  if (clone.schemaVersion === undefined || clone.schemaVersion === null || clone.schemaVersion === 0) {
    clone.schemaVersion = HARNESS_CONTRACT_SCHEMA_VERSION;
  }
  if (typeof clone.workspaceRevision === 'number' && Number.isFinite(clone.workspaceRevision)) {
    clone.workspaceRevision = String(clone.workspaceRevision);
  }
  if (!Array.isArray(clone.artifacts)) {
    clone.artifacts = [];
  }
  if (!Array.isArray(clone.toolCalls)) {
    clone.toolCalls = [];
  }
  if (!Array.isArray(clone.verificationEvidenceIds)) {
    clone.verificationEvidenceIds = [];
  }
  return clone;
}

/**
 * Normalizes a UnifiedExecutionResult to enforce semantic invariants:
 * - Apparent vs. verified completion: verified is true ONLY if status === 'completed' and verificationEvidenceIds is non-empty.
 * - Cost semantics: if costStatus === 'UNKNOWN', costUSD is stripped to undefined (never coerced to 0).
 * - Schema version defaulted to HARNESS_CONTRACT_SCHEMA_VERSION.
 */
export function normalizeExecutionResult(
  result: UnifiedExecutionResult,
): UnifiedExecutionResult {
  const evidenceIds = Array.isArray(result.verificationEvidenceIds)
    ? result.verificationEvidenceIds.filter(isNonEmptyString)
    : [];

  const canBeVerified =
    result.status === 'completed' && evidenceIds.length > 0;
  const normalizedVerified = result.verified === true && canBeVerified;

  const usage = { ...result.usage };
  if (usage.costStatus === 'UNKNOWN') {
    delete usage.costUSD;
  }

  return {
    ...result,
    schemaVersion: result.schemaVersion || HARNESS_CONTRACT_SCHEMA_VERSION,
    workspaceRevision: String(result.workspaceRevision),
    verified: normalizedVerified,
    verificationEvidenceIds: evidenceIds,
    artifacts: Array.isArray(result.artifacts) ? [...result.artifacts] : [],
    toolCalls: Array.isArray(result.toolCalls) ? [...result.toolCalls] : [],
    usage,
  };
}

/**
 * Strictly validates a UnifiedExecutionResult against the cross-harness contract invariants.
 */
export function validateUnifiedExecutionResult(res: unknown): {
  valid: boolean;
  errors: string[];
  value?: UnifiedExecutionResult;
} {
  const errors: string[] = [];
  if (!res || typeof res !== 'object' || Array.isArray(res)) {
    return { valid: false, errors: ['Result must be a non-null object'] };
  }

  const r = res as Record<string, unknown>;

  if (r.schemaVersion !== HARNESS_CONTRACT_SCHEMA_VERSION) {
    errors.push(
      `Invalid or unsupported schemaVersion: ${String(r.schemaVersion)} (expected ${HARNESS_CONTRACT_SCHEMA_VERSION})`,
    );
  }

  if (!isNonEmptyString(r.executionId)) {
    errors.push('executionId must be a non-empty string');
  }
  if (!isNonEmptyString(r.taskId)) {
    errors.push('taskId must be a non-empty string');
  }
  if (!isNonEmptyString(r.harnessId)) {
    errors.push('harnessId must be a non-empty string');
  }
  if (
    r.harnessKind !== undefined &&
    !VALID_HARNESS_KINDS.has(r.harnessKind as HarnessKind)
  ) {
    errors.push(
      `Invalid harnessKind: ${String(r.harnessKind)} (expected native, acp, or external-cli)`,
    );
  }
  if (!isNonEmptyString(r.modelId)) {
    errors.push('modelId must be a non-empty string');
  }
  if (!isNonEmptyString(r.runtimeId)) {
    errors.push('runtimeId must be a non-empty string');
  }

  if (
    typeof r.status !== 'string' ||
    !VALID_EXECUTION_STATUSES.has(r.status as UnifiedExecutionStatus)
  ) {
    errors.push(
      `Invalid status: ${String(r.status)} (expected completed, failed, cancelled, interrupted, or unknown)`,
    );
  }

  if (!isNonEmptyString(r.workspaceRevision)) {
    errors.push('workspaceRevision must be a non-empty string');
  }

  if (!Array.isArray(r.artifacts)) {
    errors.push('artifacts must be an array');
  } else {
    for (let i = 0; i < r.artifacts.length; i++) {
      const art = r.artifacts[i] as Record<string, unknown> | undefined;
      if (!art || typeof art !== 'object' || !isNonEmptyString(art.path)) {
        errors.push(`artifacts[${i}].path must be a non-empty string`);
      }
    }
  }

  if (!Array.isArray(r.toolCalls)) {
    errors.push('toolCalls must be an array');
  }

  if (!Array.isArray(r.verificationEvidenceIds)) {
    errors.push('verificationEvidenceIds must be an array');
  } else if (!r.verificationEvidenceIds.every(isNonEmptyString)) {
    errors.push('verificationEvidenceIds must contain only non-empty strings');
  }

  // Enforce Invariant 1: Physical Execution Facts vs. Model Claims
  if (r.verified === true) {
    if (r.status !== 'completed') {
      errors.push(
        `Invariant violation: verified cannot be true when status is '${String(r.status)}' (must be 'completed')`,
      );
    }
    if (
      !Array.isArray(r.verificationEvidenceIds) ||
      r.verificationEvidenceIds.length === 0
    ) {
      errors.push(
        'Invariant violation: verified cannot be true when verificationEvidenceIds is empty',
      );
    }
  }

  if (!r.usage || typeof r.usage !== 'object' || Array.isArray(r.usage)) {
    errors.push('usage must be a non-null object');
  } else {
    const u = r.usage as Record<string, unknown>;
    if (!isNonNegativeNumber(u.durationMs)) {
      errors.push('usage.durationMs must be a non-negative finite number');
    }
    for (const numField of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'firstTokenLatencyMs',
      'modelCalls',
    ] as const) {
      if (u[numField] !== undefined && !isNonNegativeNumber(u[numField])) {
        errors.push(`usage.${numField} must be a non-negative finite number`);
      }
    }

    if (
      u.costStatus !== undefined &&
      !VALID_COST_STATUSES.has(u.costStatus as CostStatus)
    ) {
      errors.push(
        `Invalid usage.costStatus: ${String(u.costStatus)} (expected ACTUAL, ESTIMATED, or UNKNOWN)`,
      );
    }

    // Enforce Invariant 3: Actual vs. Estimated vs. Unknown Monetary Costs
    if (u.costStatus === 'UNKNOWN' && u.costUSD !== undefined) {
      errors.push(
        'Invariant violation: usage.costUSD must be undefined when usage.costStatus is UNKNOWN (never coerce unknown cost to 0 or a number)',
      );
    }

    if (
      (u.costStatus === 'ACTUAL' || u.costStatus === 'ESTIMATED') &&
      !isNonNegativeNumber(u.costUSD)
    ) {
      errors.push(
        `usage.costUSD must be a non-negative finite number when usage.costStatus is ${String(u.costStatus)}`,
      );
    }

    if (u.costUSD !== undefined && !isNonNegativeNumber(u.costUSD)) {
      errors.push('usage.costUSD must be a non-negative finite number');
    }
  }

  if (r.provenance !== undefined) {
    if (typeof r.provenance !== 'object' || r.provenance === null || Array.isArray(r.provenance)) {
      errors.push('provenance must be a non-null object when provided');
    } else {
      const p = r.provenance as Record<string, unknown>;
      if (!isNonEmptyString(p.startedAt)) {
        errors.push('provenance.startedAt must be a non-empty string');
      }
      if (!isNonEmptyString(p.completedAt)) {
        errors.push('provenance.completedAt must be a non-empty string');
      }
      if (!isNonEmptyString(p.contractDigest)) {
        errors.push('provenance.contractDigest must be a non-empty string');
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    value: r as unknown as UnifiedExecutionResult,
  };
}

function mapExecutionStatusToUnified(status: ExecutionRecord['execution']['status']): UnifiedExecutionStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'paused':
    case 'blocked':
    case 'waiting':
    case 'waiting_for_approval':
      return 'interrupted';
    default:
      return 'unknown';
  }
}

/**
 * Converts a durable Wazir ExecutionRecord into a canonical UnifiedExecutionResult
 * without losing provenance, verification evidence, or telemetry semantics.
 */
export function fromExecutionRecordToUnifiedResult(
  record: ExecutionRecord,
  options?: {
    harnessId?: string;
    harnessKind?: HarnessKind;
    costUSD?: number;
    costStatus?: CostStatus;
    terminationReason?: TerminationReason;
    errorKind?: AgentErrorKind;
    checkpointId?: string;
  },
): UnifiedExecutionResult {
  const exec = record.execution;
  const status = mapExecutionStatusToUnified(exec.status);

  const currentRevisionNum =
    record.workspaceState?.revision ??
    record.evaluation?.workspaceRevision ??
    0;
  const workspaceRevision = String(currentRevisionNum);

  const allEvidence = record.evidence ?? record.evaluation?.evidence ?? [];
  const passingEvidenceAtRevision = allEvidence.filter(
    (ev) =>
      (ev.workspaceRevision ?? ev.revision) === currentRevisionNum &&
      (ev.status === 'PASS' || (ev.status === undefined && ev.exitCode === 0)),
  );
  const verificationEvidenceIds = passingEvidenceAtRevision.map((ev) => ev.id);

  // Verified is true ONLY when status === 'completed', evaluation succeeded (if present),
  // and non-empty controller verification evidence exists at the current workspace revision.
  const evalPassed = record.evaluation ? record.evaluation.success : true;
  const verified =
    status === 'completed' &&
    evalPassed &&
    verificationEvidenceIds.length > 0;

  const startedAtDate = exec.startedAt ?? exec.createdAt;
  const completedAtDate = exec.completedAt ?? new Date();
  const durationMs = Math.max(
    0,
    completedAtDate.getTime() - startedAtDate.getTime(),
  );

  const artifacts: UnifiedArtifactRecord[] = (record.filesChanged ?? []).map(
    (filePath) => {
      const mutation = record.mutationHistory
        ?.slice()
        .reverse()
        .find((m) => m.path === filePath);
      return {
        path: filePath,
        kind: 'file',
        ...(mutation ? { createdAt: mutation.at.toISOString() } : {}),
      };
    },
  );

  const isLocalRuntime = ['ollama', 'lmstudio', 'local', 'vllm', 'llamacpp', 'mlx'].some(
    (prefix) => exec.runtimeId.toLowerCase().includes(prefix),
  );

  let costStatus: CostStatus =
    options?.costStatus ?? (isLocalRuntime ? 'ACTUAL' : 'UNKNOWN');
  let costUSD: number | undefined =
    options?.costUSD !== undefined
      ? options.costUSD
      : isLocalRuntime
        ? 0
        : undefined;

  if (costStatus === 'UNKNOWN') {
    costUSD = undefined;
  }

  const inputTokens = record.usage?.input;
  const outputTokens = record.usage?.output;
  const totalTokens =
    record.usage?.total ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);

  const contractDigest =
    record.executionContract?.digest ??
    computeRequestContractDigest({
      executionId: exec.id,
      taskId: exec.taskId,
      objective: record.task.title ?? record.task.input,
      taskType: record.task.type,
      workspace: {
        root: exec.workspaceRoot ?? record.task.policy?.projectRoot ?? '.',
        revision: workspaceRevision,
      },
      constraints: {
        allowFallback: record.task.execution?.allowFallback ?? true,
        maxTurns: record.task.maxTurns,
      },
      verification: {
        requiredChecks: record.task.expectedEvidence ?? [],
        protectedPaths: [],
        mutationRequired:
          record.task.mutationRequired ?? record.task.requirements?.mutationRequired,
        expectedArtifacts:
          record.task.expectedArtifacts ?? record.task.requirements?.expectedArtifacts,
      },
      policyContext: record.task.policy ?? {},
    });

  return {
    schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
    executionId: exec.id,
    taskId: exec.taskId,
    harnessId: options?.harnessId ?? exec.agentId ?? 'wazir-native',
    harnessKind: options?.harnessKind ?? 'native',
    modelId: exec.modelId,
    runtimeId: exec.runtimeId,
    status,
    verified,
    ...(options?.terminationReason
      ? { terminationReason: options.terminationReason }
      : {}),
    ...(options?.errorKind ? { errorKind: options.errorKind } : {}),
    workspaceRevision,
    filesChanged: [...(record.filesChanged ?? [])],
    artifacts,
    toolCalls: [...(record.toolCalls ?? [])],
    checks: [...(record.checks ?? [])],
    usage: {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(costUSD !== undefined ? { costUSD } : {}),
      costStatus,
      durationMs,
      ...(record.totalModelCalls !== undefined
        ? { modelCalls: record.totalModelCalls }
        : {}),
    },
    verificationEvidenceIds,
    ...(options?.checkpointId ? { checkpointId: options.checkpointId } : {}),
    ...(record.errors.length > 0 ? { errors: [...record.errors] } : {}),
    ...(record.result !== undefined ? { output: record.result } : {}),
    provenance: {
      startedAt: startedAtDate.toISOString(),
      completedAt: completedAtDate.toISOString(),
      contractDigest,
    },
  };
}
