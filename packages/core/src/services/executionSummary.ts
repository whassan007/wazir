import type { ExecutionRecord } from '../types/execution.js';

/**
 * Observability projection of one execution, derived entirely from its durable
 * record: generation start/complete events, classified retry events, tool-call and
 * check records, policy decisions, route changes, the typed termination event, the
 * agent-turn markers the controller emits, usage and the workspace revision.
 *
 * It carries identifiers, counts and durations only — no prompts, tool inputs or
 * outputs — so it is safe for generic telemetry. Detailed evidence stays in the
 * execution record itself.
 */
export interface ExecutionSummary {
  executionId: string;
  jobId: string | null;
  status: string;
  taskClass: string;
  /** Models in the order the run used them (more than one after an escalation). */
  models: string[];
  runtimeId: string;
  computerId: string | null;
  terminationReason: string | null;
  durations: {
    /** Wall clock from start to completion; null while running or when unrecorded. */
    totalMs: number | null;
    /** Time inside model generation, excluding retry backoff. */
    modelInferenceMs: number;
    /** Backoff delays scheduled by classified provider retries. */
    retryBackoffMs: number;
    /** All recorded tool dispatches (includes verification commands). */
    toolMs: number;
    /** Build/test/lint/typecheck checks — a subset of toolMs. */
    verificationMs: number;
    /**
     * totalMs minus inference, backoff and tools: time no recorded activity accounts
     * for (approval waits, model loading, harness overhead, gaps between turns).
     * A large value is itself a finding. Null when totalMs is.
     */
    unattributedMs: number | null;
  };
  counts: {
    modelRequests: number;
    /** A generation started but no completion was recorded (crash or kill mid-request). */
    unfinishedModelRequests: number;
    toolCalls: number;
    failedToolCalls: number;
    duplicateActionsBlocked: number;
    invalidActions: number;
    repairPhases: number;
    contextCompactions: number;
    retries: number;
    retriesExhausted: number;
    escalations: number;
    checks: number;
    failedChecks: number;
    policy: { allow: number; deny: number; ask: number };
  };
  tokens: { input: number; output: number; total: number } | null;
  contextTokens: number | null;
  workspaceRevision: number;
  filesChanged: number;
}

type AnyEvent = ExecutionRecord['events'][number];
const eventType = (e: AnyEvent): string => e.eventType ?? e.type;
const time = (value: Date | string | undefined): number | null => (value ? new Date(value).getTime() : null);

export function summarizeExecution(record: ExecutionRecord): ExecutionSummary {
  const events = [...record.events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  let modelRequests = 0;
  let inferenceMs = 0;
  const openGenerations: number[] = [];
  let retryBackoffMs = 0;
  let retries = 0;
  let retriesExhausted = 0;
  let duplicateActionsBlocked = 0;
  let invalidActions = 0;
  let repairPhases = 0;
  let contextCompactions = 0;
  const models = [record.execution.modelId];
  let escalations = 0;
  let terminationReason: string | null = null;

  for (const event of events) {
    const type = eventType(event);
    const at = time(event.timestamp);
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (type) {
      case 'generation.started':
        modelRequests += 1;
        if (at !== null) openGenerations.push(at);
        break;
      case 'generation.completed': {
        const started = openGenerations.shift();
        if (started !== undefined && at !== null) inferenceMs += Math.max(0, at - started);
        break;
      }
      case 'retry.scheduled':
        retries += 1;
        retryBackoffMs += typeof data.delay === 'number' ? data.delay : 0;
        break;
      case 'retry.exhausted':
        retriesExhausted += 1;
        break;
      case 'agent.turn': {
        const content = typeof data.content === 'string' ? data.content : '';
        if (content.startsWith('ACTION_BLOCKED_DUPLICATE')) duplicateActionsBlocked += 1;
        if (content.startsWith('INVALID_JSON_ACTION') || content.startsWith('ACTION_VALIDATION_FAILED')) invalidActions += 1;
        if (content.startsWith('context compacted') || content.startsWith('context overflow recovery')) contextCompactions += 1;
        break;
      }
      case 'agent.phase':
        if (data.phase === 'repair') repairPhases += 1;
        break;
      case 'model.route.changed':
        if (data.accepted === true && typeof data.newModel === 'string') {
          escalations += 1;
          models.push(data.newModel);
        }
        break;
      case 'termination.completed':
        if (typeof data.reason === 'string') terminationReason = data.reason;
        break;
      default:
        break;
    }
  }

  const start = time(record.execution.startedAt) ?? time(record.execution.createdAt);
  const end = time(record.execution.completedAt);
  const totalMs = start !== null && end !== null ? Math.max(0, end - start) : null;
  const modelInferenceMs = Math.max(0, inferenceMs - retryBackoffMs);
  const toolMs = record.toolCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0);
  const policy = { allow: 0, deny: 0, ask: 0 };
  for (const decision of record.policyDecisions) {
    if (decision.decision === 'allow' || decision.decision === 'deny' || decision.decision === 'ask') policy[decision.decision] += 1;
  }

  return {
    executionId: record.execution.id,
    jobId: record.execution.jobId ?? null,
    status: record.execution.status,
    taskClass: record.task.type,
    models,
    runtimeId: record.execution.runtimeId,
    computerId: record.execution.computerId ?? null,
    terminationReason,
    durations: {
      totalMs,
      // Backoff happens inside a generation request; report inference without it.
      modelInferenceMs,
      retryBackoffMs,
      toolMs,
      verificationMs: record.checks.reduce((sum, check) => sum + (check.durationMs ?? 0), 0),
      unattributedMs: totalMs === null ? null : Math.max(0, totalMs - modelInferenceMs - retryBackoffMs - toolMs),
    },
    counts: {
      modelRequests,
      unfinishedModelRequests: openGenerations.length,
      toolCalls: record.toolCalls.length,
      failedToolCalls: record.toolCalls.filter((call) => !call.ok).length,
      duplicateActionsBlocked,
      invalidActions,
      repairPhases,
      contextCompactions,
      retries,
      retriesExhausted,
      escalations,
      checks: record.checks.length,
      failedChecks: record.checks.filter((check) => !check.ok).length,
      policy,
    },
    tokens: record.usage ? { input: record.usage.input, output: record.usage.output, total: record.usage.total ?? record.usage.input + record.usage.output } : null,
    contextTokens: record.context?.finalInputTokens ?? null,
    workspaceRevision: record.workspaceState?.revision ?? 0,
    filesChanged: record.filesChanged.length,
  };
}
