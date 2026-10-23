import { createHash } from 'node:crypto';
import path from 'node:path';
import { redactSecrets } from '@wazir/shared';
import type { PolicyRequirements } from './task.js';
import type { ToolCallCheckpoint } from './execution.js';
import type { ExecutionCheckpoint } from './checkpoint.js';

export const PORTABLE_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const PORTABLE_HANDOFF_SCHEMA_VERSION = 1 as const;

export interface PortableBudgetState {
  tokensUsed: number;
  toolCallsUsed: number;
  modelCallsUsed: number;
  costUSD: number;
  costStatus: 'ACTUAL' | 'ESTIMATED' | 'UNKNOWN';
  durationMs: number;
}

export interface PortableRemainingBudget {
  maxTokens?: number | null;
  maxToolCalls?: number | null;
  maxModelCalls?: number | null;
  maxCostUSD?: number | null;
  maxDurationMs?: number | null;
}

export interface PortableActionSummary {
  actionId: string;
  kind: 'tool_call' | 'file_mutation' | 'verification_check' | 'plan_step';
  summary: string;
  toolName?: string;
  targetPath?: string;
  workspaceRevision: number;
  confirmed: boolean;
  at: string;
}

export interface PortableHandoff {
  schemaVersion: number;

  executionId: string;
  taskId: string;
  jobId?: string;

  sourceHarnessId: string;
  targetHarnessId?: string;
  sourceModelId?: string;
  sourceRuntimeId?: string;
  sourceWorkerId?: string;

  workspaceRevision: string;
  workspaceContentDigest: string;
  checkpointId: string;

  objective: string;
  completedActions: PortableActionSummary[];
  pendingActions: string[];
  filesChanged: string[];

  unresolvedSideEffects: ToolCallCheckpoint[];

  verificationEvidenceIds: string[];

  consumedBudget: PortableBudgetState;
  remainingBudget: PortableRemainingBudget;

  policyContext: PolicyRequirements;

  resumable: boolean;
  nonResumableReason?: string;

  createdAt: string;
  integrityDigest: string;
}

export interface PortableCheckpointEnvelope extends PortableHandoff {
  worktreeState: ExecutionCheckpoint['worktreeState'];
  verificationState: ExecutionCheckpoint['verificationState'];
  contextSnapshot?: ExecutionCheckpoint['contextSnapshot'];
  planState?: ExecutionCheckpoint['planState'];
  provenanceCursor?: number;
  evidenceReferences?: ExecutionCheckpoint['evidenceReferences'];
  parentCheckpointId?: string;
  workspaceRoot?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface PortableCheckpointValidationResult {
  valid: boolean;
  ok: boolean;
  errors: string[];
  reason?: string;
  envelope?: PortableCheckpointEnvelope;
}

const INLINE_KV_SECRET_RE =
  /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|bearer[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|token|secret|password|passwd|authorization|credential)(\s*[:=]\s*)([^\s,;'"]+)/gi;

const SECRET_OBJECT_KEY_RE =
  /^(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|bearer[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|secret|password|passwd|credential|credentials|authorization|token)$/i;

/**
 * Scrubs secret/token patterns from free-form text (action summaries, objectives, metadata strings).
 */
export function redactPortableText(text: string): string {
  if (!text) return text;
  const firstPass = redactSecrets(text);
  return firstPass.replace(
    INLINE_KV_SECRET_RE,
    (_match, key: string, sep: string, val: string) => {
      if (val === '[REDACTED]' || val.startsWith('[REDACTED')) {
        return `${key}${sep}${val}`;
      }
      return `${key}${sep}[REDACTED]`;
    },
  );
}

/**
 * Deeply clones and redacts secret/token material from strings and object properties
 * before portable checkpoint serialization.
 */
export function redactPortableValue<T>(value: T): T {
  if (typeof value === 'string') {
    return redactPortableText(value) as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPortableValue(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (SECRET_OBJECT_KEY_RE.test(k) && typeof v === 'string') {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactPortableValue(v);
      }
    }
    return out as T;
  }
  return value;
}

/**
 * Computes deterministic SHA-256 digest of workspace file snapshot and revision.
 * Matches `CheckpointService.computeDigest` byte-for-byte.
 */
export function computeWorkspaceContentDigest(
  filesSnapshot: Record<string, string>,
  workspaceRevision: number | string,
): string {
  const hash = createHash('sha256');
  const sortedEntries = Object.entries(filesSnapshot ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [filePath, content] of sortedEntries) {
    hash.update(JSON.stringify([filePath, content]));
  }
  hash.update(`rev:${workspaceRevision}\n`);
  return hash.digest('hex');
}

function canonicalizeForDigest(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForDigest(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const val = record[key];
      if (val === undefined) continue;
      out[key] = canonicalizeForDigest(val);
    }
    return out;
  }
  return value;
}

/**
 * Computes deterministic SHA-256 integrity digest across all fields of a
 * PortableCheckpointEnvelope or PortableHandoff (excluding `integrityDigest` itself).
 */
export function computePortableCheckpointDigest(
  envelope:
    | Omit<PortableCheckpointEnvelope, 'integrityDigest'>
    | Omit<PortableHandoff, 'integrityDigest'>
    | Record<string, unknown>,
): string {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope as Record<string, unknown>)) {
    if (key === 'integrityDigest' || value === undefined) continue;
    copy[key] = value;
  }
  const canonical = canonicalizeForDigest(copy);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export const computePortableHandoffDigest = computePortableCheckpointDigest;

/**
 * Classifies whether a portable checkpoint or handoff can be safely resumed automatically,
 * and supplies an explicit `nonResumableReason` when `resumable` is `false`.
 */
export function classifyPortableResumability(input: {
  status?: string;
  unresolvedSideEffects: ToolCallCheckpoint[];
  remainingBudget: PortableRemainingBudget;
}): { resumable: boolean; nonResumableReason?: string } {
  const reasons: string[] = [];

  if (input.status === 'completed' || input.status === 'cancelled') {
    reasons.push(`Execution is already in terminal status '${input.status}'`);
  }

  const blockingCalls = (input.unresolvedSideEffects ?? []).filter(
    (call) =>
      call.sideEffectClass !== 'READ_ONLY' &&
      (call.state === 'OUTCOME_UNKNOWN' || call.state === 'STARTED'),
  );
  if (blockingCalls.length > 0) {
    const first = blockingCalls[0];
    reasons.push(
      `Unresolved non-read-only side effect: tool '${first.toolName}' (callId '${first.callId}', sideEffectClass '${first.sideEffectClass}', state '${first.state}') requires reconciliation before resume`,
    );
  }

  const rem = input.remainingBudget ?? {};
  const exhaustedDimensions: string[] = [];
  if (rem.maxTokens !== undefined && rem.maxTokens !== null && rem.maxTokens <= 0) {
    exhaustedDimensions.push('maxTokens');
  }
  if (rem.maxToolCalls !== undefined && rem.maxToolCalls !== null && rem.maxToolCalls <= 0) {
    exhaustedDimensions.push('maxToolCalls');
  }
  if (rem.maxModelCalls !== undefined && rem.maxModelCalls !== null && rem.maxModelCalls <= 0) {
    exhaustedDimensions.push('maxModelCalls');
  }
  if (rem.maxCostUSD !== undefined && rem.maxCostUSD !== null && rem.maxCostUSD <= 0) {
    exhaustedDimensions.push('maxCostUSD');
  }
  if (rem.maxDurationMs !== undefined && rem.maxDurationMs !== null && rem.maxDurationMs <= 0) {
    exhaustedDimensions.push('maxDurationMs');
  }
  if (exhaustedDimensions.length > 0) {
    reasons.push(`Budget exhausted: ${exhaustedDimensions.join(', ')}`);
  }

  if (reasons.length > 0) {
    return {
      resumable: false,
      nonResumableReason: reasons.join('; '),
    };
  }

  return { resumable: true };
}

function isUnsafeSnapshotPath(relative: string): boolean {
  if (!relative || relative.includes('\\') || relative.includes('\0')) return true;
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) return true;
  const parts = relative.split('/');
  return parts.some(
    (p) => !p || p === '.' || p === '..' || p === '.git' || p === '.wazir' || p === 'node_modules',
  );
}

/**
 * Validates a raw PortableCheckpointEnvelope (or deserialized JSON object) for:
 * - structural completeness
 * - supported schema version (`PORTABLE_CHECKPOINT_SCHEMA_VERSION === 1`)
 * - safe snapshot paths and deterministic `workspaceContentDigest` binding
 * - resumability invariants
 * - cryptographic `integrityDigest` verification
 */
export function validatePortableCheckpoint(raw: unknown): PortableCheckpointValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      ok: false,
      errors: ['CORRUPTED_CHECKPOINT: envelope must be a non-null object'],
      reason: 'CORRUPTED_CHECKPOINT: envelope must be a non-null object',
    };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.schemaVersion !== 'number') {
    errors.push('INVALID_SCHEMA_VERSION: schemaVersion must be a number');
  } else if (obj.schemaVersion !== PORTABLE_CHECKPOINT_SCHEMA_VERSION) {
    errors.push(
      `UNSUPPORTED_SCHEMA_VERSION: expected ${PORTABLE_CHECKPOINT_SCHEMA_VERSION}, got ${obj.schemaVersion}`,
    );
  }

  const requiredStrings = [
    'executionId',
    'taskId',
    'sourceHarnessId',
    'workspaceContentDigest',
    'checkpointId',
    'createdAt',
    'integrityDigest',
  ] as const;

  for (const field of requiredStrings) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).trim() === '') {
      errors.push(`INVALID_FIELD: '${field}' must be a non-empty string`);
    }
  }

  if (typeof obj.objective !== 'string') {
    errors.push(`INVALID_FIELD: 'objective' must be a string`);
  }

  if (
    typeof obj.workspaceRevision !== 'string' &&
    typeof obj.workspaceRevision !== 'number'
  ) {
    errors.push(`INVALID_FIELD: 'workspaceRevision' must be a string or number`);
  } else if (String(obj.workspaceRevision).trim() === '') {
    errors.push(`INVALID_FIELD: 'workspaceRevision' must not be empty`);
  }

  if (typeof obj.createdAt === 'string' && !Number.isFinite(new Date(obj.createdAt).getTime())) {
    errors.push(`INVALID_FIELD: 'createdAt' must be a valid ISO timestamp`);
  }

  const requiredArrays = [
    'completedActions',
    'pendingActions',
    'filesChanged',
    'unresolvedSideEffects',
    'verificationEvidenceIds',
  ] as const;

  for (const arrField of requiredArrays) {
    if (!Array.isArray(obj[arrField])) {
      errors.push(`INVALID_FIELD: '${arrField}' must be an array`);
    }
  }

  if (!obj.consumedBudget || typeof obj.consumedBudget !== 'object' || Array.isArray(obj.consumedBudget)) {
    errors.push(`INVALID_FIELD: 'consumedBudget' must be an object`);
  } else {
    const cb = obj.consumedBudget as Record<string, unknown>;
    for (const numField of ['tokensUsed', 'toolCallsUsed', 'modelCallsUsed', 'costUSD', 'durationMs'] as const) {
      if (typeof cb[numField] !== 'number' || !Number.isFinite(cb[numField] as number) || (cb[numField] as number) < 0) {
        errors.push(`INVALID_BUDGET: 'consumedBudget.${numField}' must be a non-negative finite number`);
      }
    }
    if (cb.costStatus !== 'ACTUAL' && cb.costStatus !== 'ESTIMATED' && cb.costStatus !== 'UNKNOWN') {
      errors.push(`INVALID_BUDGET: 'consumedBudget.costStatus' must be ACTUAL, ESTIMATED, or UNKNOWN`);
    }
  }

  if (!obj.remainingBudget || typeof obj.remainingBudget !== 'object' || Array.isArray(obj.remainingBudget)) {
    errors.push(`INVALID_FIELD: 'remainingBudget' must be an object`);
  }

  if (!obj.policyContext || typeof obj.policyContext !== 'object' || Array.isArray(obj.policyContext)) {
    errors.push(`INVALID_FIELD: 'policyContext' must be an object`);
  }

  if (typeof obj.resumable !== 'boolean') {
    errors.push(`INVALID_FIELD: 'resumable' must be a boolean`);
  } else if (obj.resumable === false && (typeof obj.nonResumableReason !== 'string' || !obj.nonResumableReason.trim())) {
    errors.push(`INVALID_RESUMABILITY: 'nonResumableReason' is required when 'resumable' is false`);
  }

  if (Array.isArray(obj.unresolvedSideEffects) && obj.remainingBudget && typeof obj.remainingBudget === 'object') {
    const planStatus =
      obj.planState && typeof obj.planState === 'object'
        ? ((obj.planState as Record<string, unknown>).status as string | undefined)
        : undefined;
    const expectedResumability = classifyPortableResumability({
      status: planStatus,
      unresolvedSideEffects: obj.unresolvedSideEffects as ToolCallCheckpoint[],
      remainingBudget: obj.remainingBudget as PortableRemainingBudget,
    });
    if (!expectedResumability.resumable && obj.resumable === true) {
      errors.push(
        `INVALID_RESUMABILITY: checkpoint cannot be marked resumable (${expectedResumability.nonResumableReason})`,
      );
    }
  }

  if (obj.worktreeState !== undefined) {
    if (!obj.worktreeState || typeof obj.worktreeState !== 'object' || Array.isArray(obj.worktreeState)) {
      errors.push(`INVALID_WORKTREE_STATE: 'worktreeState' must be an object`);
    } else {
      const wt = obj.worktreeState as Record<string, unknown>;
      if (!wt.filesSnapshot || typeof wt.filesSnapshot !== 'object' || Array.isArray(wt.filesSnapshot)) {
        errors.push(`INVALID_WORKTREE_STATE: 'worktreeState.filesSnapshot' must be an object`);
      } else {
        const snapshot = wt.filesSnapshot as Record<string, unknown>;
        for (const [relPath, content] of Object.entries(snapshot)) {
          if (typeof content !== 'string' || isUnsafeSnapshotPath(relPath)) {
            errors.push(`UNSAFE_CHECKPOINT_PATH: '${relPath}'`);
          }
        }
        if (
          typeof obj.workspaceContentDigest === 'string' &&
          (typeof obj.workspaceRevision === 'string' || typeof obj.workspaceRevision === 'number')
        ) {
          const computedWorkspaceDigest = computeWorkspaceContentDigest(
            snapshot as Record<string, string>,
            obj.workspaceRevision,
          );
          if (computedWorkspaceDigest !== obj.workspaceContentDigest) {
            errors.push(
              `WORKSPACE_CONTENT_DIGEST_MISMATCH: expected '${computedWorkspaceDigest}', got '${obj.workspaceContentDigest}'`,
            );
          }
        }
      }
    }
  }

  if (typeof obj.integrityDigest === 'string' && obj.integrityDigest.length > 0) {
    const expectedIntegrity = computePortableCheckpointDigest(obj);
    if (expectedIntegrity !== obj.integrityDigest) {
      errors.push(
        `INTEGRITY_DIGEST_MISMATCH: expected '${expectedIntegrity}', got '${obj.integrityDigest}'`,
      );
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      ok: false,
      errors,
      reason: errors.join('; '),
    };
  }

  const normalized = structuredClone(obj) as unknown as PortableCheckpointEnvelope;
  normalized.workspaceRevision = String(normalized.workspaceRevision);
  if (Array.isArray(normalized.unresolvedSideEffects)) {
    normalized.unresolvedSideEffects = normalized.unresolvedSideEffects.map((call) => ({
      ...call,
      startedAt: call.startedAt instanceof Date ? call.startedAt : new Date(call.startedAt),
      ...(call.finishedAt !== undefined
        ? { finishedAt: call.finishedAt instanceof Date ? call.finishedAt : new Date(call.finishedAt) }
        : {}),
    }));
  }

  return {
    valid: true,
    ok: true,
    errors: [],
    envelope: normalized,
  };
}

/**
 * Validates and returns the typed PortableCheckpointEnvelope, or throws an Error on failure.
 */
export function assertValidPortableCheckpoint(raw: unknown): PortableCheckpointEnvelope {
  const result = validatePortableCheckpoint(raw);
  if (!result.valid || !result.envelope) {
    throw new Error(`INVALID_PORTABLE_CHECKPOINT: ${result.errors.join('; ')}`);
  }
  return result.envelope;
}

/**
 * Extracts a canonical `PortableHandoff` with recomputed `integrityDigest` from a `PortableCheckpointEnvelope`.
 */
export function toPortableHandoff(envelope: PortableCheckpointEnvelope): PortableHandoff {
  const base: Omit<PortableHandoff, 'integrityDigest'> = {
    schemaVersion: PORTABLE_HANDOFF_SCHEMA_VERSION,
    executionId: envelope.executionId,
    taskId: envelope.taskId,
    ...(envelope.jobId !== undefined ? { jobId: envelope.jobId } : {}),
    sourceHarnessId: envelope.sourceHarnessId,
    ...(envelope.targetHarnessId !== undefined ? { targetHarnessId: envelope.targetHarnessId } : {}),
    ...(envelope.sourceModelId !== undefined ? { sourceModelId: envelope.sourceModelId } : {}),
    ...(envelope.sourceRuntimeId !== undefined ? { sourceRuntimeId: envelope.sourceRuntimeId } : {}),
    ...(envelope.sourceWorkerId !== undefined ? { sourceWorkerId: envelope.sourceWorkerId } : {}),
    workspaceRevision: String(envelope.workspaceRevision),
    workspaceContentDigest: envelope.workspaceContentDigest,
    checkpointId: envelope.checkpointId,
    objective: envelope.objective,
    completedActions: structuredClone(envelope.completedActions),
    pendingActions: [...envelope.pendingActions],
    filesChanged: [...envelope.filesChanged],
    unresolvedSideEffects: structuredClone(envelope.unresolvedSideEffects),
    verificationEvidenceIds: [...envelope.verificationEvidenceIds],
    consumedBudget: structuredClone(envelope.consumedBudget),
    remainingBudget: structuredClone(envelope.remainingBudget),
    policyContext: structuredClone(envelope.policyContext),
    resumable: envelope.resumable,
    ...(envelope.nonResumableReason !== undefined
      ? { nonResumableReason: envelope.nonResumableReason }
      : {}),
    createdAt: envelope.createdAt,
  };
  return {
    ...base,
    integrityDigest: computePortableHandoffDigest(base),
  };
}
