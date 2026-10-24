import { createHash } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import type { ExecutionEvent, ExecutionRecord, ExecutionStatus } from '../types/execution.js';

/**
 * Agent 13: Historical State Retention
 *
 * Implements bounded storage growth, audit-safe event log compaction, and historical
 * execution pruning while strictly protecting:
 *  - All non-terminal executions (`created`, `assigned`, `running`, `waiting`, `paused`, etc.)
 *  - Any execution with an active lease or unresolved `TOOL_OUTCOME_UNKNOWN` / `tool.unknownOutcome`
 *  - Every verification, policy, lease, checkpoint, and terminal lifecycle event (`evidence` & audit trail)
 */

export interface HistoryRetentionPolicy {
  maxTotalExecutions: number;
  maxAgeMs: number;
  maxEventsPerTerminalExecution: number;
  readonly preserveNonTerminal: true;
  readonly preserveAuditAndVerificationEvidence: true;
}

export interface HistoryRetentionPolicyInput {
  maxTotalExecutions?: number;
  maxAgeMs?: number;
  maxEventsPerTerminalExecution?: number;
}

export const DEFAULT_HISTORY_RETENTION_POLICY: HistoryRetentionPolicy = {
  maxTotalExecutions: 200,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 604_800_000 ms (7 days)
  maxEventsPerTerminalExecution: 50,
  preserveNonTerminal: true,
  preserveAuditAndVerificationEvidence: true,
};

export interface ArchivedExecutionSummary {
  id: string;
  jobId: string | null;
  taskId: string;
  status: ExecutionStatus | string;
  createdAt: string;
  completedAt: string | null;
  verificationPassed: boolean;
  filesChangedCount: number;
  errorsCount: number;
  digest: string;
}

export interface CompactExecutionEventsResult {
  compacted: boolean;
  eventsBefore: number;
  eventsAfter: number;
  record: ExecutionRecord;
}

export interface EnforceRetentionOptions {
  nowMs?: number;
  activeLeaseExecutionIds?: ReadonlySet<string>;
}

export interface RetentionSweepResult {
  kept: ExecutionRecord[];
  archivedSummaries: ArchivedExecutionSummary[];
  prunedIds: string[];
  eventsCompactedCount: number;
  estimatedBytesReclaimed: number;
}

const TERMINAL_STATUSES = new Set<string>(['completed', 'failed', 'cancelled']);

const NON_TERMINAL_PROTECTED_STATUSES = new Set<string>([
  'created',
  'pending',
  'queued',
  'planning',
  'scheduled',
  'ready',
  'assigned',
  'running',
  'waiting',
  'waiting_for_approval',
  'verifying',
  'paused',
  'blocked',
]);

function getEventType(event: ExecutionEvent): string {
  return String(event.eventType ?? event.type ?? '');
}

/**
 * Determines whether an event is a critical audit, verification, policy, lease,
 * checkpoint, or lifecycle boundary event that must never be discarded during compaction.
 */
export function isCriticalAuditOrVerificationEvent(event: ExecutionEvent): boolean {
  const type = getEventType(event);
  if (
    type.startsWith('verification.') ||
    type.startsWith('VERIFICATION_') ||
    type.startsWith('policy.') ||
    type.startsWith('lease.') ||
    type === 'execution.created' ||
    type === 'execution.started' ||
    type === 'execution.completed' ||
    type === 'execution.failed' ||
    type === 'execution.cancelled' ||
    type === 'execution.checkpoint.created' ||
    type === 'execution.rollback.completed' ||
    type === 'execution.rollback.rejected' ||
    type === 'check.completed' ||
    type === 'evaluation.completed' ||
    type === 'termination.completed' ||
    type === 'completion.rejected' ||
    type === 'COMPLETION_REJECTED' ||
    type === 'evidence.stale' ||
    type === 'EVIDENCE_STALE' ||
    type === 'tool.call.outcome_unknown' ||
    type === 'tool.unknownOutcome'
  ) {
    return true;
  }
  return false;
}

/**
 * Checks whether an execution is non-terminal or has unresolved `TOOL_OUTCOME_UNKNOWN` state.
 */
export function isProtectedExecutionRecord(
  record: ExecutionRecord,
  activeLeaseExecutionIds?: ReadonlySet<string>,
): boolean {
  const status = String(record.execution.status ?? '');
  if (!TERMINAL_STATUSES.has(status) || NON_TERMINAL_PROTECTED_STATUSES.has(status)) {
    return true;
  }

  if (activeLeaseExecutionIds?.has(record.execution.id)) {
    return true;
  }

  // Check if any tool call has unresolved unknown outcome
  for (const call of record.toolCalls ?? []) {
    const failureClass = String(call.failureClass ?? '');
    const err = String(call.error ?? '');
    if (
      failureClass === 'TOOL_OUTCOME_UNKNOWN' ||
      failureClass === 'OUTCOME_UNKNOWN' ||
      err.includes('TOOL_OUTCOME_UNKNOWN')
    ) {
      return true;
    }
  }

  // Check if there is an unresolved unknown-outcome event or active un-released lease
  let leaseDepth = 0;
  for (const event of record.events ?? []) {
    const type = getEventType(event);
    if (type === 'tool.call.outcome_unknown' || type === 'tool.unknownOutcome') {
      return true;
    }
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (
      data.state === 'OUTCOME_UNKNOWN' ||
      data.failureClass === 'TOOL_OUTCOME_UNKNOWN' ||
      data.outcome === 'TOOL_OUTCOME_UNKNOWN'
    ) {
      return true;
    }
    if (type === 'lease.acquired') leaseDepth += 1;
    if (type === 'lease.released') leaseDepth = Math.max(0, leaseDepth - 1);
  }
  if (leaseDepth > 0 && status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
    return true;
  }

  return false;
}

function estimateJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function toTimestampMs(value: Date | string | undefined): number {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function toIsoString(value: Date | string | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function computeArchivedSummary(record: ExecutionRecord): ArchivedExecutionSummary {
  const createdAtIso = toIsoString(record.execution.createdAt) ?? new Date(0).toISOString();
  const completedAtIso = toIsoString(record.execution.completedAt);

  const checksOk =
    (record.checks?.length ?? 0) > 0 && record.checks.every((check) => check.ok);
  const evalPassed = record.evaluation?.success === true;
  const hasVerificationPassEvent = (record.events ?? []).some((e) => {
    const t = getEventType(e);
    return t === 'verification.passed' || t === 'VERIFICATION_PASSED' || t === 'verification.completed';
  });
  const verificationPassed =
    evalPassed || checksOk || (record.execution.status === 'completed' && hasVerificationPassEvent);

  const filesChangedCount = record.filesChanged?.length ?? 0;
  const errorsCount = record.errors?.length ?? 0;

  const digestPayload = JSON.stringify({
    id: record.execution.id,
    jobId: record.execution.jobId ?? null,
    taskId: record.execution.taskId,
    status: record.execution.status,
    createdAt: createdAtIso,
    completedAt: completedAtIso,
    verificationPassed,
    filesChanged: record.filesChanged ?? [],
    errorsCount,
    evidenceIds: (record.evidence ?? []).map((ev) => ev.id ?? ev.type),
    policyCount: record.policyDecisions?.length ?? 0,
  });

  const digest = createHash('sha256').update(digestPayload).digest('hex').slice(0, 32);

  return {
    id: record.execution.id,
    jobId: record.execution.jobId ?? null,
    taskId: record.execution.taskId,
    status: record.execution.status,
    createdAt: createdAtIso,
    completedAt: completedAtIso,
    verificationPassed,
    filesChangedCount,
    errorsCount,
    digest,
  };
}

/**
 * Compacts verbose intermediate token/progress/tool-stdout events on terminal executions
 * while strictly preserving every critical audit/verification/checkpoint/lease event
 * and maintaining monotonic sequence ordering.
 */
export function compactExecutionEvents(
  record: ExecutionRecord,
  maxEvents: number = DEFAULT_HISTORY_RETENTION_POLICY.maxEventsPerTerminalExecution,
): CompactExecutionEventsResult {
  const effectiveMax = Math.max(1, maxEvents);
  const eventsBefore = record.events?.length ?? 0;

  // Never compact non-terminal or protected unknown-outcome executions
  if (isProtectedExecutionRecord(record) || eventsBefore <= effectiveMax) {
    return {
      compacted: false,
      eventsBefore,
      eventsAfter: eventsBefore,
      record,
    };
  }

  // Sort copy with original index to preserve monotonic sequence order
  const indexed = record.events.map((event, idx) => ({
    event,
    idx,
    seq: event.sequence ?? idx + 1,
    critical: isCriticalAuditOrVerificationEvent(event),
  }));

  indexed.sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.idx - b.idx));

  const criticalItems = indexed.filter((item) => item.critical);
  const nonCriticalItems = indexed.filter((item) => !item.critical);

  let selected: typeof indexed;
  if (criticalItems.length >= effectiveMax) {
    // Always preserve ALL critical audit/verification/lease/checkpoint events even if they exceed maxEvents
    selected = criticalItems;
  } else {
    const remainingBudget = effectiveMax - criticalItems.length;
    // Keep the most recent non-critical events (or first + tail) to fill the budget
    const keptNonCritical = nonCriticalItems.slice(-remainingBudget);
    selected = [...criticalItems, ...keptNonCritical].sort((a, b) =>
      a.seq !== b.seq ? a.seq - b.seq : a.idx - b.idx,
    );
  }

  if (selected.length === eventsBefore) {
    return {
      compacted: false,
      eventsBefore,
      eventsAfter: eventsBefore,
      record,
    };
  }

  const compactedEvents = selected.map((item) => structuredClone(item.event));
  const nextRecord: ExecutionRecord = {
    ...structuredClone(record),
    storageRevision: (record.storageRevision ?? 0) + 1,
    events: compactedEvents,
  };

  return {
    compacted: true,
    eventsBefore,
    eventsAfter: compactedEvents.length,
    record: nextRecord,
  };
}

/**
 * Enforces retention across a collection of execution records:
 * 1. Protects all non-terminal executions, active leases, and unresolved unknown tool outcomes.
 * 2. Evicts terminal executions older than `maxAgeMs` or beyond `maxTotalExecutions` (oldest first),
 *    converting them into lightweight `ArchivedExecutionSummary` objects.
 * 3. Compacts verbose event logs on surviving terminal executions while preserving all audit/verification evidence.
 */
export function enforceRetention(
  records: ExecutionRecord[],
  options?: EnforceRetentionOptions & { policy?: HistoryRetentionPolicyInput },
): RetentionSweepResult {
  const policy: HistoryRetentionPolicy = {
    ...DEFAULT_HISTORY_RETENTION_POLICY,
    ...(options?.policy ?? {}),
    preserveNonTerminal: true,
    preserveAuditAndVerificationEvidence: true,
  };
  const nowMs = options?.nowMs ?? Date.now();
  const activeLeases = options?.activeLeaseExecutionIds;

  const protectedRecords: ExecutionRecord[] = [];
  const terminalCandidates: ExecutionRecord[] = [];

  for (const record of records) {
    if (isProtectedExecutionRecord(record, activeLeases)) {
      protectedRecords.push(record);
    } else {
      terminalCandidates.push(record);
    }
  }

  // Sort terminal candidates newest first by completedAt ?? startedAt ?? createdAt
  terminalCandidates.sort((a, b) => {
    const timeA =
      toTimestampMs(a.execution.completedAt) ||
      toTimestampMs(a.execution.startedAt) ||
      toTimestampMs(a.execution.createdAt);
    const timeB =
      toTimestampMs(b.execution.completedAt) ||
      toTimestampMs(b.execution.startedAt) ||
      toTimestampMs(b.execution.createdAt);
    return timeB - timeA;
  });

  const maxTerminalAllowed = Math.max(0, policy.maxTotalExecutions - protectedRecords.length);

  const survivingTerminals: ExecutionRecord[] = [];
  const evictedTerminals: ExecutionRecord[] = [];

  for (const record of terminalCandidates) {
    const refTimeMs =
      toTimestampMs(record.execution.completedAt) ||
      toTimestampMs(record.execution.startedAt) ||
      toTimestampMs(record.execution.createdAt);
    const ageMs = refTimeMs > 0 ? Math.max(0, nowMs - refTimeMs) : 0;
    const expiredByAge = refTimeMs > 0 && ageMs > policy.maxAgeMs;
    const exceededCount = survivingTerminals.length >= maxTerminalAllowed;

    if (expiredByAge || exceededCount) {
      evictedTerminals.push(record);
    } else {
      survivingTerminals.push(record);
    }
  }

  let eventsCompactedCount = 0;
  let estimatedBytesReclaimed = 0;

  const compactedSurvivors = survivingTerminals.map((record) => {
    const beforeBytes = estimateJsonBytes(record);
    const compaction = compactExecutionEvents(record, policy.maxEventsPerTerminalExecution);
    if (compaction.compacted) {
      eventsCompactedCount += compaction.eventsBefore - compaction.eventsAfter;
      const afterBytes = estimateJsonBytes(compaction.record);
      estimatedBytesReclaimed += Math.max(0, beforeBytes - afterBytes);
    }
    return compaction.record;
  });

  const archivedSummaries: ArchivedExecutionSummary[] = [];
  const prunedIds: string[] = [];

  for (const evicted of evictedTerminals) {
    const beforeBytes = estimateJsonBytes(evicted);
    const summary = computeArchivedSummary(evicted);
    const summaryBytes = estimateJsonBytes(summary);
    estimatedBytesReclaimed += Math.max(0, beforeBytes - summaryBytes);
    archivedSummaries.push(summary);
    prunedIds.push(evicted.execution.id);
  }

  const kept = [...protectedRecords, ...compactedSurvivors];

  return {
    kept,
    archivedSummaries,
    prunedIds,
    eventsCompactedCount,
    estimatedBytesReclaimed,
  };
}

export class HistoryRetentionService {
  readonly policy: HistoryRetentionPolicy;

  constructor(policyInput?: HistoryRetentionPolicyInput) {
    this.policy = {
      maxTotalExecutions:
        policyInput?.maxTotalExecutions ?? DEFAULT_HISTORY_RETENTION_POLICY.maxTotalExecutions,
      maxAgeMs: policyInput?.maxAgeMs ?? DEFAULT_HISTORY_RETENTION_POLICY.maxAgeMs,
      maxEventsPerTerminalExecution:
        policyInput?.maxEventsPerTerminalExecution ??
        DEFAULT_HISTORY_RETENTION_POLICY.maxEventsPerTerminalExecution,
      preserveNonTerminal: true,
      preserveAuditAndVerificationEvidence: true,
    };
  }

  compactExecutionEvents(
    record: ExecutionRecord,
    maxEvents?: number,
  ): CompactExecutionEventsResult {
    return compactExecutionEvents(
      record,
      maxEvents ?? this.policy.maxEventsPerTerminalExecution,
    );
  }

  enforceRetention(
    records: ExecutionRecord[],
    options?: EnforceRetentionOptions,
  ): RetentionSweepResult {
    return enforceRetention(records, {
      ...options,
      policy: this.policy,
    });
  }

  /**
   * Reads `execution/` keys from `KeyValueStore`, applies `enforceRetention`,
   * persists `archive/execution/<id>` summaries, deletes pruned full records,
   * and updates compacted terminal records.
   */
  async sweepStore(
    store: KeyValueStore,
    options?: EnforceRetentionOptions,
  ): Promise<RetentionSweepResult> {
    const entries = await store.list('execution/');
    const records: ExecutionRecord[] = [];
    const keyById = new Map<string, string>();
    const originalEventCounts = new Map<string, number>();

    for (const entry of entries) {
      const value = entry.value as ExecutionRecord | undefined;
      if (value && typeof value === 'object' && value.execution?.id) {
        records.push(value);
        keyById.set(value.execution.id, entry.key);
        originalEventCounts.set(value.execution.id, value.events?.length ?? 0);
      }
    }

    const result = this.enforceRetention(records, options);

    // 1. Persist lightweight archived summaries and delete pruned full execution records
    for (const summary of result.archivedSummaries) {
      await store.put(`archive/execution/${summary.id}`, summary);
    }
    for (const prunedId of result.prunedIds) {
      const key = keyById.get(prunedId) ?? `execution/${prunedId}`;
      await store.delete(key);
    }

    // 2. Persist any surviving terminal records whose event logs were compacted
    for (const keptRecord of result.kept) {
      const prevCount = originalEventCounts.get(keptRecord.execution.id);
      if (prevCount !== undefined && keptRecord.events.length < prevCount) {
        const key = keyById.get(keptRecord.execution.id) ?? `execution/${keptRecord.execution.id}`;
        await store.put(key, keptRecord);
      }
    }

    return result;
  }
}

export async function sweepStore(
  store: KeyValueStore,
  options?: EnforceRetentionOptions & { policy?: HistoryRetentionPolicyInput },
): Promise<RetentionSweepResult> {
  const service = new HistoryRetentionService(options?.policy);
  return service.sweepStore(store, options);
}
