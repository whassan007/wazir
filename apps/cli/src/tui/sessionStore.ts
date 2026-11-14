import path from 'node:path';
import type { RoutingMode } from '@wazir/core';
import type { KeyValueStore } from '@wazir/shared';
import type { RookEngine } from '../engine.js';
import { detectGitBranch } from './completionEngine.js';

export type ConversationPermissionMode = 'ask' | 'auto' | 'read-only';

export type RestoredJobState = 'completed' | 'failed' | 'interrupted' | 'still-owned';

export interface ConversationTurnRecord {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  jobId?: string;
  executionIds?: string[];
  toolSummaries?: string[];
  filesChanged?: string[];
  status?: 'running' | 'completed' | 'failed' | 'interrupted';
}

export interface LinkedSessionJob {
  jobId: string;
  prompt: string;
  taskIds: string[];
  executionIds: string[];
  recordedStatus: 'running' | 'completed' | 'failed' | 'cancelled';
  ownerWorkerId?: string;
  updatedAt: string;
}

export interface ConversationSessionRecord {
  version: 1;
  id: string;
  title: string;
  projectRoot: string;
  gitBranch?: string;
  createdAt: string;
  updatedAt: string;
  selectedModelId?: string;
  selectedAgentId?: string;
  routingMode?: RoutingMode;
  permissionMode: ConversationPermissionMode;
  distributionSpec?: string;
  turns: ConversationTurnRecord[];
  jobs: LinkedSessionJob[];
}

export interface ReconciledJobInspection {
  jobId: string;
  prompt: string;
  state: RestoredJobState;
  detail: string;
  filesChanged: string[];
}

const SESSION_PREFIX = 'conversation/session/';

export function createConversationSession(params: {
  id: string;
  projectRoot: string;
  selectedModelId?: string;
  selectedAgentId?: string;
  routingMode?: RoutingMode;
  permissionMode?: ConversationPermissionMode;
  distributionSpec?: string;
}): ConversationSessionRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: params.id,
    title: 'New conversation',
    projectRoot: path.resolve(params.projectRoot),
    gitBranch: detectGitBranch(params.projectRoot),
    createdAt: now,
    updatedAt: now,
    selectedModelId: params.selectedModelId,
    selectedAgentId: params.selectedAgentId,
    routingMode: params.routingMode,
    permissionMode: params.permissionMode ?? 'ask',
    distributionSpec: params.distributionSpec,
    turns: [],
    jobs: [],
  };
}

export async function saveConversationSession(
  store: KeyValueStore | undefined,
  session: ConversationSessionRecord,
): Promise<void> {
  if (!store) return;
  session.updatedAt = new Date().toISOString();
  // Bound persisted turns so session files remain compact over multi-hour sessions
  if (session.turns.length > 200) {
    session.turns = session.turns.slice(-200);
  }
  await store.put(`${SESSION_PREFIX}${session.id}`, session);
}

export async function loadConversationSession(
  store: KeyValueStore | undefined,
  sessionId: string,
): Promise<ConversationSessionRecord | undefined> {
  if (!store) return undefined;
  const direct = await store.get<ConversationSessionRecord>(`${SESSION_PREFIX}${sessionId}`);
  if (direct && typeof direct === 'object' && direct.id) return direct;

  // Support prefix matching (e.g. `wa resume conv-abc1` matching `conv-abc12345`)
  const all = await listConversationSessions(store);
  return all.find((s) => s.id === sessionId || s.id.startsWith(sessionId));
}

export async function listConversationSessions(
  store: KeyValueStore | undefined,
  options: { projectRoot?: string; includeEmpty?: boolean } = {},
): Promise<ConversationSessionRecord[]> {
  if (!store) return [];
  const entries = await store.list(SESSION_PREFIX);
  const normalizedProject = options.projectRoot ? path.resolve(options.projectRoot) : undefined;

  const sessions = entries
    .map((e) => e.value as Partial<ConversationSessionRecord> | null | undefined)
    .filter((s): s is ConversationSessionRecord => Boolean(s && typeof s === 'object' && typeof s.id === 'string'))
    .filter((s) => options.includeEmpty || s.turns.length > 0 || s.jobs.length > 0)
    .filter((s) => !normalizedProject || path.resolve(s.projectRoot) === normalizedProject);

  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sessions;
}

/**
 * Purely read-only reconciliation of persisted jobs associated with a resumed conversation.
 * Distinguishes `completed`, `failed`, `interrupted`, and `still-owned` jobs without ever
 * re-executing a tool call, shell command, or model turn.
 */
export async function reconcileSessionJobs(
  engine: Pick<RookEngine, 'orchestrator' | 'executions' | 'worker'> & { store?: KeyValueStore },
  session: ConversationSessionRecord,
): Promise<ReconciledJobInspection[]> {
  const results: ReconciledJobInspection[] = [];
  const currentWorkerId = engine.worker?.id;
  const nowMs = Date.now();

  const inspectRecord = (rec: any, filesChanged: Set<string>): boolean => {
    if (!rec || typeof rec !== 'object') return false;
    for (const f of rec.filesChanged ?? []) filesChanged.add(f);
    const recStatus = rec.execution?.status;
    const workerId = rec.execution?.workerId;
    const rawTs = (rec.execution as { updatedAt?: Date | string } | undefined)?.updatedAt
      ?? rec.execution?.completedAt
      ?? rec.execution?.startedAt
      ?? rec.execution?.createdAt;
    const updatedMs = rawTs ? new Date(rawTs).getTime() : 0;
    return Boolean(
      recStatus === 'running' &&
      workerId &&
      workerId !== currentWorkerId &&
      nowMs - updatedMs < 60_000,
    );
  };

  for (const linked of session.jobs) {
    const liveJob = engine.orchestrator?.getJob?.(linked.jobId);
    const status = liveJob?.status ?? linked.recordedStatus;
    const filesChanged = new Set<string>();

    let hasLiveForeignLease = false;
    for (const taskId of linked.taskIds) {
      try {
        const recs = (await engine.executions?.listByTask?.(taskId)) ?? [];
        for (const rec of recs) {
          if (inspectRecord(rec, filesChanged)) {
            hasLiveForeignLease = true;
          }
        }
      } catch {
        // Ignore missing execution records
      }
    }
    if (!hasLiveForeignLease && engine.store && linked.executionIds.length > 0) {
      for (const execId of linked.executionIds) {
        try {
          const persisted = await engine.store.get(`execution/${execId}`);
          if (inspectRecord(persisted, filesChanged)) {
            hasLiveForeignLease = true;
          }
        } catch {
          // Ignore missing persisted record
        }
      }
    }

    if (status === 'completed') {
      results.push({
        jobId: linked.jobId,
        prompt: linked.prompt,
        state: 'completed',
        detail: filesChanged.size > 0 ? `completed (${filesChanged.size} file${filesChanged.size === 1 ? '' : 's'} changed)` : 'completed',
        filesChanged: [...filesChanged],
      });
    } else if (status === 'failed') {
      results.push({
        jobId: linked.jobId,
        prompt: linked.prompt,
        state: 'failed',
        detail: 'failed in prior run',
        filesChanged: [...filesChanged],
      });
    } else if (status === 'running' && hasLiveForeignLease) {
      results.push({
        jobId: linked.jobId,
        prompt: linked.prompt,
        state: 'still-owned',
        detail: `still running under active worker (${linked.ownerWorkerId ?? 'background worker'})`,
        filesChanged: [...filesChanged],
      });
    } else {
      // Was 'running', 'pending', or 'cancelled' with no live worker lease -> interrupted!
      results.push({
        jobId: linked.jobId,
        prompt: linked.prompt,
        state: 'interrupted',
        detail: 'interrupted before completion (side effects not replayed)',
        filesChanged: [...filesChanged],
      });
    }
  }

  return results;
}

/**
 * Builds multi-turn task input that preserves conversation history, tool outcomes,
 * modified files, and `@file` attachments while keeping bounded token usage.
 */
export function buildContextualTaskInput(params: {
  session: ConversationSessionRecord;
  userPrompt: string;
  fileMentions?: Array<{ relativePath: string; content: string; truncated: boolean }>;
  permissionMode?: ConversationPermissionMode;
  maxHistoryChars?: number;
}): string {
  const maxChars = params.maxHistoryChars ?? 12_000;
  const priorTurns = params.session.turns.filter(
    (t) => (t.role === 'user' || t.role === 'assistant') && t.content.trim().length > 0,
  );

  const sections: string[] = [];

  if (params.permissionMode === 'read-only') {
    sections.push(
      '[Permission constraint: READ-ONLY mode is active. Inspect, search, and explain code only; do NOT modify, write, or delete files or run mutating shell commands.]',
    );
  }

  if (priorTurns.length > 0) {
    // Exclude the current userPrompt if it was just appended as the final turn
    const historyTurns =
      priorTurns.at(-1)?.role === 'user' && priorTurns.at(-1)?.content === params.userPrompt
        ? priorTurns.slice(0, -1)
        : priorTurns;

    if (historyTurns.length > 0) {
      const formattedTurns: string[] = [];
      let used = 0;
      for (let i = historyTurns.length - 1; i >= 0; i--) {
        const t = historyTurns[i]!;
        const speaker = t.role === 'user' ? 'User' : 'Assistant';
        const snippet = t.content.length > 2400 ? `${t.content.slice(0, 2400)}…` : t.content;
        const toolsLine = t.toolSummaries?.length ? `\n  Tools: ${t.toolSummaries.slice(0, 6).join('; ')}` : '';
        const filesLine = t.filesChanged?.length ? `\n  Files changed: ${t.filesChanged.join(', ')}` : '';
        const statusLine = t.status && t.status !== 'completed' ? ` [${t.status}]` : '';
        const block = `${speaker}${statusLine}: ${snippet}${toolsLine}${filesLine}`;
        if (used + block.length > maxChars && formattedTurns.length > 0) {
          formattedTurns.unshift(`(Earlier ${i + 1} conversation turn(s) omitted for context budget)`);
          break;
        }
        formattedTurns.unshift(block);
        used += block.length;
      }

      sections.push(
        `Conversation history in this session (workspace: ${params.session.projectRoot}):\n` +
          formattedTurns.join('\n\n'),
      );
    }
  }

  if (params.fileMentions && params.fileMentions.length > 0) {
    const fileBlocks = params.fileMentions.map(
      (f) =>
        `Referenced file @${f.relativePath}${f.truncated ? ' (truncated)' : ''}:\n\`\`\`\n${f.content}\n\`\`\``,
    );
    sections.push(fileBlocks.join('\n\n'));
  }

  if (sections.length === 0) {
    return params.userPrompt;
  }

  sections.push(`Current user request:\n${params.userPrompt}`);
  return sections.join('\n\n---\n\n');
}
