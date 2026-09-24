import { summarizeExecution, type ExecutionRecord } from '@wazir/core';
import type { AgentCardState } from './fleetTui.js';

/**
 * The fleet TUI's agent card, rebuilt from an execution's durable record alone.
 *
 * The live TUI assembles cards from progress callbacks as a run happens — UI state,
 * never authoritative. This projection derives the same card, plus the controller
 * facts the TUI should be able to show, purely from persisted events and records, so
 * the view of any execution can be reconstructed after a restart and can never
 * disagree with execution truth. (The live TUI does not restore from it yet.)
 */
export interface ExecutionCardProjection extends AgentCardState {
  executionId: string;
  jobId: string | null;
  runtimeId: string;
  workspaceRevision: number;
  retries: number;
  repairPhases: number;
  escalations: number;
  longestNoProgressStreak: number | null;
  verification: { passing: string[]; failing: string[]; stale: number };
  terminationReason: string | null;
}

const STATUS: Record<string, AgentCardState['status']> = {
  queued: 'idle', scheduled: 'idle', waiting: 'idle', running: 'running',
  completed: 'completed', failed: 'failed', cancelled: 'cancelled',
};

export function projectExecutionCard(record: ExecutionRecord): ExecutionCardProjection {
  const summary = summarizeExecution(record);
  const events = [...record.events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  let phase = 'queued';
  let lastMessage = '';
  for (const event of events) {
    const type = event.eventType ?? event.type;
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (type === 'agent.phase' && typeof data.phase === 'string') phase = data.phase;
    if (type === 'agent.turn') {
      const text = typeof data.error === 'string' ? data.error : typeof data.content === 'string' ? data.content : '';
      if (text) lastMessage = text.split('\n')[0].slice(0, 200);
    }
  }
  const revision = summary.workspaceRevision;
  const latest = new Map<string, boolean>();
  let stale = 0;
  for (const check of record.checks) {
    if ((check.workspaceRevision ?? -1) === revision) latest.set(check.name, check.ok);
    else stale += 1;
  }
  const start = record.execution.startedAt ?? record.execution.createdAt;
  return {
    executionId: record.execution.id,
    jobId: record.execution.jobId ?? null,
    taskId: record.task.id,
    title: record.task.title ?? record.task.input.slice(0, 40),
    agentId: record.execution.agentId ?? 'unknown',
    computerId: record.execution.computerId ?? 'hosted',
    runtimeId: record.execution.runtimeId,
    // The model running now, not necessarily the one first scheduled.
    modelId: summary.models[summary.models.length - 1],
    phase,
    lastMessage,
    status: STATUS[record.execution.status] ?? 'idle',
    startedAt: start ? new Date(start) : undefined,
    completedAt: record.execution.completedAt ? new Date(record.execution.completedAt) : undefined,
    durationMs: summary.durations.totalMs ?? 0,
    filesChanged: [...record.filesChanged],
    usage: summary.tokens ?? undefined,
    modelCallCount: summary.counts.modelRequests,
    workspaceRevision: revision,
    retries: summary.counts.retries,
    repairPhases: summary.counts.repairPhases,
    escalations: summary.counts.escalations,
    longestNoProgressStreak: summary.agentRunStats?.longestNoProgressStreak ?? null,
    verification: {
      passing: [...latest].filter(([, ok]) => ok).map(([name]) => name).sort(),
      failing: [...latest].filter(([, ok]) => !ok).map(([name]) => name).sort(),
      stale,
    },
    terminationReason: summary.terminationReason,
  };
}
