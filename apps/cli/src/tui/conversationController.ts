import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  formatWorkloadDistribution,
  DEFAULT_HARDWARE_DISTRIBUTION,
  type PendingApprovalRequest,
  type RoutingMode,
} from '@wazir/core';
import { sandboxStatus } from '@wazir/tools';
import type { RookEngine } from '../engine.js';
import type { ConversationTheme } from './theme.js';
import {
  CONVERSATION_SLASH_COMMANDS,
  matchSlashCompletions,
  matchFileMentionCompletions,
  filterSelectorOptions,
  detectGitBranch,
  type CompletionItem,
  type SelectorOption,
} from './completionEngine.js';
import {
  ActivityProjector,
  formatApprovalPreview,
  formatUsageAndCost,
} from './activityProjector.js';
import {
  sanitizeAssistantText,
  renderMarkdownMessage,
  renderUnifiedDiff,
} from './markdownRenderer.js';
import {
  saveConversationSession,
  loadConversationSession,
  listConversationSessions,
  reconcileSessionJobs,
  buildContextualTaskInput,
  type ConversationSessionRecord,
  type ConversationTurnRecord,
  type LinkedSessionJob,
} from './sessionStore.js';
import { truncateToDisplayWidth } from './unicode.js';

const execFileAsync = promisify(execFile);

export type PermissionMode = 'ask' | 'auto' | 'read-only';

export type InteractiveOverlayKind = 'model' | 'permissions' | 'resume' | 'palette';

export interface InteractiveOverlayState {
  kind: InteractiveOverlayKind;
  title: string;
  query: string;
  options: SelectorOption[];
  selectedIndex: number;
}

export interface ConversationToolEntry {
  tool: string;
  summary: string;
  ok: boolean;
  timestamp: string;
}

let cachedPtyAvailable: boolean | undefined;
export function checkNodePtyAvailable(): boolean {
  if (cachedPtyAvailable !== undefined) return cachedPtyAvailable;
  try {
    const isSea = Boolean((process as any).getBuiltinModule?.('node:sea')?.isSea?.());
    if (isSea) {
      cachedPtyAvailable = false;
      return false;
    }
    const req = createRequire(__filename);
    req.resolve('node-pty');
    cachedPtyAvailable = true;
  } catch {
    cachedPtyAvailable = false;
  }
  return cachedPtyAvailable;
}

export interface ConversationControllerInit {
  sessionId: string;
  projectRoot: string;
  permissionMode?: PermissionMode;
  routingMode?: RoutingMode;
  selectedModelId?: string;
  selectedAgentId?: string;
  distributionSpec?: string;
}

/**
 * Owns structured conversation session state, completions, interactive selectors,
 * explicit approval focus, active-run queue, and slash command rendering while
 * keeping `FleetTui` dashboard state cleanly separated.
 */
function formatModelWithProvider(id: string, provider?: string): string {
  if (!provider) return id;
  const prefix = `${provider.toLowerCase()}:`;
  const cleanId = id.toLowerCase().startsWith(prefix) ? id.slice(prefix.length) : id;
  return `${cleanId}/${provider}`;
}

export class ConversationController {
  sessionId: string;
  workspaceRoot: string;
  workspaceName: string;
  gitBranch?: string;
  permissionMode: PermissionMode;
  routingMode?: RoutingMode;
  selectedModelId?: string;
  selectedAgentId?: string;
  distributionSpec?: string;
  ascii: boolean;

  approvalFocused = false;
  overlay?: InteractiveOverlayState;
  completionItems: CompletionItem[] = [];
  completionIndex = 0;
  completionTrigger?: { kind: 'slash' | 'mention'; replaceStart: number; replaceEnd: number };

  readonly queuedPrompts: string[] = [];
  readonly activityProjector: ActivityProjector;

  turns: ConversationTurnRecord[] = [];
  toolHistory: ConversationToolEntry[] = [];
  jobRefs: LinkedSessionJob[] = [];
  createdAt: string;

  /** Live streaming prose preview for the active assistant turn */
  streamingPreview = '';

  constructor(init: ConversationControllerInit & { ascii?: boolean }) {
    this.sessionId = init.sessionId;
    this.workspaceRoot = path.resolve(init.projectRoot);
    this.workspaceName = path.basename(this.workspaceRoot) || 'workspace';
    this.gitBranch = detectGitBranch(this.workspaceRoot);
    this.permissionMode = init.permissionMode ?? 'ask';
    this.routingMode = init.routingMode;
    this.selectedModelId = init.selectedModelId;
    this.selectedAgentId = init.selectedAgentId;
    this.distributionSpec = init.distributionSpec;
    this.ascii = Boolean(init.ascii || process.env.WAZIR_ASCII === '1' || process.env.WAZIR_UNICODE === '0');
    this.createdAt = new Date().toISOString();
    this.activityProjector = new ActivityProjector(this.workspaceRoot);
  }

  refreshWorkspaceMeta(projectRoot?: string): void {
    if (projectRoot) {
      this.workspaceRoot = path.resolve(projectRoot);
    }
    this.workspaceName = path.basename(this.workspaceRoot) || 'workspace';
    this.gitBranch = detectGitBranch(this.workspaceRoot);
    this.activityProjector.setProjectRoot(this.workspaceRoot);
  }

  formatPermissionSummary(): string {
    const bullet = this.ascii ? '-' : '·';
    const sb = sandboxStatus();
    const sbLabel = sb.mode !== 'none' ? sb.mode : 'unsandboxed';
    const routeSuffix = this.routingMode ? ` ${bullet} ${this.routingMode.toLowerCase()}` : '';
    return `${this.permissionMode} ${bullet} ${sbLabel}${routeSuffix}`;
  }

  formatModelSummary(engine: RookEngine, activeAgent?: { computerId?: string; modelId?: string; agentId?: string }): string {
    const bullet = this.ascii ? '-' : '·';
    const ellipsis = this.ascii ? '...' : '…';
    if (engine.isBootstrapping) {
      return `connecting to providers${ellipsis}`;
    }
    if (activeAgent && activeAgent.modelId && activeAgent.modelId !== 'evaluating...') {
      return activeAgent.computerId && activeAgent.computerId !== 'evaluating...'
        ? `${activeAgent.modelId} ${bullet} ${activeAgent.computerId}`
        : activeAgent.modelId;
    }
    if (this.selectedAgentId) {
      return `agent:${this.selectedAgentId}`;
    }
    if (this.selectedModelId) {
      const m = engine.models?.get?.(this.selectedModelId);
      return m ? formatModelWithProvider(m.id, m.provider) : this.selectedModelId;
    }
    const readyModels = engine.models?.list?.().filter((m) => !m.embedding) ?? [];
    const extAgents = engine.agents?.list?.().filter((a) => a.source === 'external') ?? [];
    if (readyModels.length === 0 && (extAgents.length === 0 || !this.distributionSpec)) {
      return `no provider ${bullet} setup needed`;
    }
    if (readyModels.length === 1 && extAgents.length === 0) {
      return formatModelWithProvider(readyModels[0]!.id, readyModels[0]!.provider);
    }
    const dist = engine.workloadDistributor?.getConfig() ?? DEFAULT_HARDWARE_DISTRIBUTION;
    const hasHybridPools = extAgents.length > 0 && readyModels.length > 0;
    if (hasHybridPools) {
      const formatted = formatWorkloadDistribution(dist);
      return `auto (${this.ascii ? formatted.replace(/·/g, '-') : formatted})`;
    }
    if (readyModels.length > 0) {
      return `auto ${bullet} ${formatModelWithProvider(readyModels[0]!.id, readyModels[0]!.provider)}`;
    }
    return `auto ${bullet} ${extAgents.map((a) => a.descriptor.name).join(', ')}`;
  }

  /**
   * Updates contextual `/` or `@` completions for the current prompt & cursor.
   */
  updateCompletions(
    prompt: string,
    cursor: number,
    extraRefs: string[] = [],
  ): void {
    if (this.overlay) {
      this.completionItems = [];
      this.completionTrigger = undefined;
      return;
    }

    const slashState = matchSlashCompletions(prompt, cursor);
    if (slashState) {
      const before = prompt.slice(0, cursor);
      if (slashState.items.length === 1 && slashState.items[0]!.label === before) {
        this.completionItems = [];
        this.completionTrigger = undefined;
        return;
      }
      this.completionItems = slashState.items;
      this.completionIndex = Math.min(this.completionIndex, Math.max(0, slashState.items.length - 1));
      this.completionTrigger = {
        kind: 'slash',
        replaceStart: slashState.replaceStart,
        replaceEnd: slashState.replaceEnd,
      };
      return;
    }

    const mentionState = matchFileMentionCompletions(prompt, cursor, this.workspaceRoot, extraRefs);
    if (mentionState) {
      this.completionItems = mentionState.items;
      this.completionIndex = Math.min(this.completionIndex, Math.max(0, mentionState.items.length - 1));
      this.completionTrigger = {
        kind: 'mention',
        replaceStart: mentionState.replaceStart,
        replaceEnd: mentionState.replaceEnd,
      };
      return;
    }

    this.completionItems = [];
    this.completionIndex = 0;
    this.completionTrigger = undefined;
  }

  acceptCompletion(prompt: string): { nextPrompt: string; nextCursor: number; accepted?: CompletionItem } | null {
    if (!this.completionTrigger || this.completionItems.length === 0) return null;
    const item = this.completionItems[this.completionIndex] ?? this.completionItems[0]!;
    const { replaceStart, replaceEnd } = this.completionTrigger;
    const nextPrompt = prompt.slice(0, replaceStart) + item.insertText + prompt.slice(replaceEnd);
    const nextCursor = replaceStart + item.insertText.length;
    this.completionItems = [];
    this.completionIndex = 0;
    this.completionTrigger = undefined;
    return { nextPrompt, nextCursor, accepted: item };
  }

  openModelOverlay(engine: RookEngine): void {
    const dist = engine.workloadDistributor?.getConfig() ?? DEFAULT_HARDWARE_DISTRIBUTION;
    const options: SelectorOption[] = [
      {
        id: 'auto',
        label: 'auto (scheduler + hardware distribution)',
        detail: formatWorkloadDistribution(dist),
        badge: !this.selectedModelId && !this.selectedAgentId ? 'active' : undefined,
      },
    ];
    const bullet = this.ascii ? '-' : '·';
    for (const model of engine.models?.list?.() ?? []) {
      if (model.embedding) continue;
      const rawCtx = model.contextMax ?? (model as { contextWindow?: number }).contextWindow;
      const ctxPart =
        typeof rawCtx === 'number' && Number.isFinite(rawCtx) && rawCtx > 0
          ? `${Math.round(rawCtx / 1024)}k ctx`
          : 'ctx unknown';
      options.push({
        id: model.id,
        label: formatModelWithProvider(model.id, model.provider),
        detail: `${model.provider} ${bullet} ${ctxPart}`,
        badge: this.selectedModelId === model.id ? 'pinned' : undefined,
      });
    }
    for (const agent of engine.agents?.list?.() ?? []) {
      if (agent.source !== 'external') continue;
      const name = agent.descriptor.name;
      options.push({
        id: `agent:${name}`,
        label: `agent:${name}`,
        detail: agent.descriptor.description || 'external coding agent',
        badge: this.selectedAgentId === name ? 'pinned' : undefined,
      });
    }
    this.overlay = {
      kind: 'model',
      title: 'Select Model or Agent',
      query: '',
      options,
      selectedIndex: 0,
    };
  }

  openPermissionsOverlay(): void {
    const modes: Array<{ id: PermissionMode; label: string; detail: string }> = [
      { id: 'ask', label: 'ask', detail: 'Prompt before shell commands or protected writes (recommended)' },
      { id: 'auto', label: 'auto', detail: 'Auto-approve workspace edits & standard checks within policy' },
      { id: 'read-only', label: 'read-only', detail: 'Inspect & explain only; block file edits and shell mutations' },
    ];
    this.overlay = {
      kind: 'permissions',
      title: 'Permission Mode',
      query: '',
      options: modes.map((m) => ({
        id: m.id,
        label: m.label,
        detail: m.detail,
        badge: this.permissionMode === m.id ? 'active' : undefined,
      })),
      selectedIndex: Math.max(0, modes.findIndex((m) => m.id === this.permissionMode)),
    };
  }

  async openResumeOverlay(engine: RookEngine): Promise<boolean> {
    if (!engine.store) return false;
    const all = await listConversationSessions(engine.store);
    const sessions = all.slice(0, 20);
    if (sessions.length === 0) return false;
    const options: SelectorOption[] = [];
    for (const s of sessions) {
      const reconciled = await reconcileSessionJobs(engine, s);
      const latestJobState = reconciled.at(-1)?.state;
      const turnCount = s.turns.filter((m) => m.role === 'user').length;
      const updatedIso = typeof s.updatedAt === 'string' ? s.updatedAt : new Date(s.updatedAt).toISOString();
      const updated = updatedIso.slice(0, 16).replace('T', ' ');
      options.push({
        id: s.id,
        label: truncateToDisplayWidth(s.title || s.id, 46, '…'),
        detail: `${path.basename(s.projectRoot)} · ${turnCount} turn${turnCount === 1 ? '' : 's'} · ${updated}`,
        badge: latestJobState,
      });
    }
    this.overlay = {
      kind: 'resume',
      title: 'Resume Conversation Session',
      query: '',
      options,
      selectedIndex: 0,
    };
    return true;
  }

  openPaletteOverlay(): void {
    const options: SelectorOption[] = CONVERSATION_SLASH_COMMANDS.map((cmd) => ({
      id: cmd.command,
      label: cmd.usage ?? cmd.command,
      detail: cmd.summary,
    }));
    this.overlay = {
      kind: 'palette',
      title: 'QUICK ACTIONS (Ctrl+P)',
      query: '',
      options,
      selectedIndex: 0,
    };
  }

  filteredOverlayOptions(): SelectorOption[] {
    if (!this.overlay) return [];
    return filterSelectorOptions(this.overlay.options, this.overlay.query);
  }

  /**
   * Builds live tray lines (approval preview, active overlay selector, completion popup,
   * queued follow-up indicator, and live streaming prose preview) to render cleanly above composer.
   */
  buildTrayLines(
    columns: number,
    theme: ConversationTheme,
    pendingApprovals: PendingApprovalRequest[],
    showApprovalDetails = false,
  ): string[] {
    const safeCols = Math.max(20, columns - 2);
    const g = theme.glyphs;
    const lines: string[] = [];

    // 1. Live streaming assistant text preview (up to 4 lines while streaming)
    if (this.streamingPreview) {
      const previewLines = renderMarkdownMessage(this.streamingPreview, safeCols, theme, { indent: 2 });
      const tail = previewLines.slice(-4);
      for (const l of tail) {
        lines.push(l);
      }
    }

    // 2. Queued active-run prompts indicator
    if (this.queuedPrompts.length > 0) {
      const nextQueued = truncateToDisplayWidth(this.queuedPrompts[0]!, Math.max(14, safeCols - 34), g.ellipsis);
      lines.push(
        `  ${theme.muted(`Queued (${this.queuedPrompts.length}): "${nextQueued}" ${g.bullet} /queue clear to drop`)}`,
      );
    }

    // 3. Explicit approval preview with command or inline diff
    if (pendingApprovals.length > 0) {
      const preview = formatApprovalPreview(pendingApprovals[0]!, safeCols, theme, {
        focused: this.approvalFocused,
        queueLength: pendingApprovals.length,
        showDetails: showApprovalDetails,
        projectRoot: this.workspaceRoot,
      });
      lines.push(`  ${preview.header}`);
      lines.push(preview.ruleSummary);
      lines.push(...preview.detailLines);
      lines.push(preview.actionHint);
    }

    // 4. Interactive overlay (searchable /model, /permissions, /resume, Ctrl+P palette)
    if (this.overlay) {
      const filtered = this.filteredOverlayOptions();
      const queryDisplay = this.overlay.query
        ? `${theme.accent(this.overlay.query)}`
        : theme.muted('type to filter…');
      lines.push(
        `  ${theme.bold(this.overlay.title)} ${theme.muted(`${g.bullet}`)} ${queryDisplay} ${theme.muted(`(↑/↓ · Enter · Esc)`)}`,
      );
      if (filtered.length === 0) {
        lines.push(`    ${theme.muted('No matching items.')}`);
      } else {
        const clampedIdx = Math.max(0, Math.min(filtered.length - 1, this.overlay.selectedIndex));
        const windowSize = 6;
        const start = Math.max(0, Math.min(clampedIdx - windowSize + 1, filtered.length - windowSize));
        const visible = filtered.slice(start, start + windowSize);
        for (let i = 0; i < visible.length; i++) {
          const opt = visible[i]!;
          const isSel = start + i === clampedIdx;
          const pointer = isSel ? theme.accent(g.selected) : ' ';
          const badge = opt.badge ? ` ${theme.accent(`[${opt.badge}]`)}` : '';
          const label = isSel ? theme.bold(theme.accent(opt.label)) : opt.label;
          const detailBudget = Math.max(10, safeCols - opt.label.length - (opt.badge ? opt.badge.length + 4 : 0) - 10);
          const detail = opt.detail
            ? ` ${theme.muted(truncateToDisplayWidth(opt.detail, detailBudget, g.ellipsis))}`
            : '';
          lines.push(`  ${pointer} ${label}${badge}${detail}`);
        }
      }
      return lines;
    }

    // 5. Contextual `/` slash or `@` file completion tray
    if (this.completionItems.length > 0) {
      const clampedIdx = Math.max(0, Math.min(this.completionItems.length - 1, this.completionIndex));
      const shown = this.completionItems.slice(0, 6);
      for (let i = 0; i < shown.length; i++) {
        const item = shown[i]!;
        const isSel = i === clampedIdx;
        const pointer = isSel ? theme.accent(g.selected) : ' ';
        const label = isSel ? theme.bold(theme.accent(item.label)) : item.label;
        const detail = item.detail
          ? `  ${theme.muted(truncateToDisplayWidth(item.detail, Math.max(12, safeCols - item.label.length - 10), g.ellipsis))}`
          : '';
        lines.push(`  ${pointer} ${label}${detail}`);
      }
    }

    return lines;
  }

  updateStreamingToken(rawBuffer: string): void {
    const trimmed = rawBuffer.trimStart();
    if (!trimmed || trimmed.startsWith('{')) {
      return;
    }
    const clean = sanitizeAssistantText(rawBuffer, { streaming: true });
    if (clean) {
      this.streamingPreview = clean;
    } else {
      this.streamingPreview = '';
    }
  }

  clearStreamingPreview(): void {
    this.streamingPreview = '';
  }

  recordUserMessage(content: string, jobId?: string): void {
    this.turns.push({
      id: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      jobId,
      status: 'running',
    });
  }

  recordAssistantMessage(content: string, jobId?: string, _modelId?: string): void {
    const clean = sanitizeAssistantText(content);
    if (!clean) return;
    const recentToolSummaries = this.toolHistory.slice(-6).map((t) => t.summary);
    this.turns.push({
      id: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'assistant',
      content: clean,
      timestamp: new Date().toISOString(),
      jobId,
      toolSummaries: recentToolSummaries.length > 0 ? recentToolSummaries : undefined,
      status: 'completed',
    });
  }

  recordJobState(
    jobId: string,
    prompt: string,
    status: LinkedSessionJob['recordedStatus'],
    extra: { taskIds?: string[]; executionIds?: string[]; filesChanged?: string[]; ownerWorkerId?: string } = {},
  ): void {
    const now = new Date().toISOString();
    const existing = this.jobRefs.find((j) => j.jobId === jobId);
    if (existing) {
      existing.recordedStatus = status;
      existing.updatedAt = now;
      if (extra.taskIds) existing.taskIds = extra.taskIds;
      if (extra.executionIds) existing.executionIds = extra.executionIds;
      if (extra.ownerWorkerId) existing.ownerWorkerId = extra.ownerWorkerId;
    } else {
      this.jobRefs.push({
        jobId,
        prompt,
        taskIds: extra.taskIds ?? extra.executionIds ?? [],
        executionIds: extra.executionIds ?? [],
        recordedStatus: status,
        ownerWorkerId: extra.ownerWorkerId,
        updatedAt: now,
      });
    }
    const matchingUserTurn = [...this.turns].reverse().find((t) => t.jobId === jobId && t.role === 'user');
    if (matchingUserTurn) {
      matchingUserTurn.status =
        status === 'completed'
          ? 'completed'
          : status === 'failed'
            ? 'failed'
            : status === 'cancelled'
              ? 'interrupted'
              : 'running';
      if (extra.filesChanged?.length) {
        matchingUserTurn.filesChanged = extra.filesChanged;
      }
    }
  }

  toSessionRecord(): ConversationSessionRecord {
    const firstUser = this.turns.find((m) => m.role === 'user')?.content ?? 'New conversation';
    return {
      version: 1,
      id: this.sessionId,
      title: firstUser.replace(/\s+/g, ' ').slice(0, 72),
      projectRoot: this.workspaceRoot,
      gitBranch: this.gitBranch,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      selectedModelId: this.selectedModelId,
      selectedAgentId: this.selectedAgentId,
      routingMode: this.routingMode,
      permissionMode: this.permissionMode,
      distributionSpec: this.distributionSpec,
      turns: this.turns.slice(-120),
      jobs: this.jobRefs.slice(-40),
    };
  }

  async persist(engine: RookEngine): Promise<void> {
    if (!engine.store || engine.isBootstrapping) return;
    if (this.turns.length === 0 && this.toolHistory.length === 0 && this.jobRefs.length === 0) return;
    await saveConversationSession(engine.store, this.toSessionRecord()).catch(() => undefined);
  }

  /**
   * Restores a saved session WITHOUT replaying any side effects, and reconciles
   * any referenced jobs (`completed`, `failed`, `interrupted`, `still-owned`).
   */
  async restoreSession(
    engine: RookEngine,
    sessionIdOrLast: string,
    theme: ConversationTheme,
    columns: number,
  ): Promise<{ ok: boolean; transcriptText: string; record?: ConversationSessionRecord }> {
    if (!engine.store) {
      return { ok: false, transcriptText: 'Session storage is not available in this environment.' };
    }
    let record: ConversationSessionRecord | undefined;
    if (sessionIdOrLast === '--last' || sessionIdOrLast === 'last') {
      const workspaceSessions = await listConversationSessions(engine.store, {
        projectRoot: this.workspaceRoot,
      });
      if (workspaceSessions.length > 0) {
        record = workspaceSessions[0];
      } else {
        const allSessions = await listConversationSessions(engine.store);
        record = allSessions[0];
      }
    } else {
      record = await loadConversationSession(engine.store, sessionIdOrLast);
    }

    if (!record) {
      return {
        ok: false,
        transcriptText: `No saved conversation session found${sessionIdOrLast !== '--last' ? ` matching "${sessionIdOrLast}"` : ''}.`,
      };
    }

    this.sessionId = record.id;
    this.createdAt = record.createdAt;
    if (record.selectedModelId !== undefined) this.selectedModelId = record.selectedModelId;
    if (record.selectedAgentId !== undefined) this.selectedAgentId = record.selectedAgentId;
    if (record.routingMode !== undefined) this.routingMode = record.routingMode;
    if (record.permissionMode !== undefined) this.permissionMode = record.permissionMode;
    this.turns = [...record.turns];
    this.jobRefs = [...record.jobs];

    const reconciled = await reconcileSessionJobs(engine, record);
    for (const r of reconciled) {
      const ref = this.jobRefs.find((j) => j.jobId === r.jobId);
      if (ref) {
        if (r.state === 'completed') ref.recordedStatus = 'completed';
        else if (r.state === 'failed') ref.recordedStatus = 'failed';
        else if (r.state === 'interrupted') ref.recordedStatus = 'cancelled';
      }
    }

    const g = theme.glyphs;
    const userTurnCount = record.turns.filter((m) => m.role === 'user').length;
    const out: string[] = [
      `${theme.accent(g.success)} ${theme.bold(`Resumed session ${record.id}`)} ${theme.muted(`(${userTurnCount} turn${userTurnCount === 1 ? '' : 's'} · no side effects replayed)`)}`,
    ];

    const recentMessages = record.turns.slice(-6);
    for (const msg of recentMessages) {
      if (msg.role === 'user') {
        out.push(`\n  ${theme.accent(g.userPrompt)} ${theme.bold(msg.content)}`);
      } else if (msg.role === 'assistant') {
        out.push('');
        out.push(...renderMarkdownMessage(msg.content, Math.max(24, columns - 2), theme, { indent: 4 }));
      }
    }

    if (reconciled.length > 0) {
      out.push('');
      out.push(`  ${theme.muted('Session jobs:')}`);
      for (const job of reconciled.slice(-4)) {
        const badge =
          job.state === 'completed'
            ? theme.success(`${g.success} completed`)
            : job.state === 'failed'
              ? theme.error(`${g.error} failed`)
              : job.state === 'still-owned'
                ? theme.accent(`${g.running} still-owned`)
                : theme.warning(`${g.warning} interrupted`);
        out.push(`    ${badge} ${theme.muted(`${g.bullet} ${job.prompt}`)} ${theme.muted(`— ${job.detail}`)}`);
      }
    }

    return { ok: true, transcriptText: out.join('\n'), record };
  }

  buildContextualPrompt(
    currentPrompt: string,
    fileMentions: Array<{ relativePath: string; content: string; truncated: boolean }> = [],
  ): string {
    return buildContextualTaskInput({
      session: this.toSessionRecord(),
      userPrompt: currentPrompt,
      fileMentions,
      permissionMode: this.permissionMode,
    });
  }

  formatHelpText(theme: ConversationTheme): string {
    const g = theme.glyphs;
    return [
      `${theme.bold('Commands')}`,
      `  ${theme.code('/model [id|auto]')}          Select or pin a model or external agent (${theme.muted('searchable on TTY')})`,
      `  ${theme.code('/permissions [mode]')}       Switch permission mode: ${theme.code('ask')} ${g.bullet} ${theme.code('auto')} ${g.bullet} ${theme.code('read-only')}`,
      `  ${theme.code('/status')}                   Inspect workspace, routing, 70/15/5 distribution, capabilities & usage`,
      `  ${theme.code('/diff [path]')}              Show git working-tree changes as a unified diff`,
      `  ${theme.code('/init [--force]')}           Generate a concise AGENTS.md guide for this workspace`,
      `  ${theme.code('/compact')}                  Compact older conversation turns to free context window`,
      `  ${theme.code('/undo')}                     Revert uncommitted file edits from the latest turn`,
      `  ${theme.code('/resume [id|--last]')}       Resume a saved conversation session without replaying side effects`,
      `  ${theme.code('/clear')}                    Clear visible transcript and start a fresh turn context`,
      `  ${theme.code('/fleet')}                    Open the multi-agent Fleet Mission Control dashboard`,
      `  ${theme.code('/logs')} ${g.bullet} ${theme.code('/doctor')}            Expand detailed tool logs or run runtime diagnostics`,
      `  ${theme.code('/approve')} ${g.bullet} ${theme.code('/deny')}          Approve or deny a pending policy request`,
      `  ${theme.code('/steer <msg>')} ${g.bullet} ${theme.code('/queue <msg>')} Steer the active run or queue a follow-up request`,
      `  ${theme.code('/exit')}                     Exit Wazir cleanly`,
      '',
      `${theme.bold('Composer & Shortcuts')}`,
      `  ${theme.code('@path/to/file')}             Attach workspace file context with fuzzy completion`,
      `  ${theme.code('!<command>')}                Run an inline shell command in the project root`,
      `  ${theme.code('Ctrl+J')} / ${theme.code('Alt+Enter')}        Insert a newline (also ${theme.code('Shift+Enter')} or trailing ${theme.code('\\')} + ${theme.code('Enter')})`,
      `  ${theme.code('Tab')}                       Accept ${theme.code('/')} or ${theme.code('@')} completion, or focus a pending approval`,
      `  ${theme.code('Ctrl+P')}                    Open searchable Quick Actions palette`,
      `  ${theme.code('Esc')}                       Interrupt active run, close selector, or clear draft`,
    ].join('\n');
  }

  formatStatusReport(
    engine: RookEngine,
    theme: ConversationTheme,
    usage?: { input?: number; output?: number; total?: number },
    costUsd?: number | null,
  ): string {
    const g = theme.glyphs;
    const sb = sandboxStatus();
    const ptyOk = checkNodePtyAvailable();
    const secretBackend = engine.secretBroker?.backendName ?? 'unknown';
    const dist = engine.workloadDistributor?.getConfig() ?? DEFAULT_HARDWARE_DISTRIBUTION;
    const models = engine.models?.list?.().filter((m) => !m.embedding) ?? [];
    const extAgents = engine.agents?.list?.().filter((a) => a.source === 'external').map((a) => a.descriptor.name) ?? [];
    const computers = engine.computers?.list?.() ?? [];
    const routingMode = this.routingMode ?? (engine.config.routing?.mode?.toUpperCase() ?? 'AUTO');
    const userTurnCount = this.turns.filter((m) => m.role === 'user').length;

    return [
      `${theme.bold('Session Status')}`,
      `  Workspace:      ${this.workspaceRoot}${this.gitBranch ? ` (${this.gitBranch})` : ''}`,
      `  Session:        ${this.sessionId} (${userTurnCount} user turn${userTurnCount === 1 ? '' : 's'})`,
      `  Model / Agent:  ${this.formatModelSummary(engine)}`,
      `  Routing:        ${routingMode}`,
      `  Distribution:   ${formatWorkloadDistribution(dist)}`,
      `  Permissions:    ${this.permissionMode} ${g.bullet} sandbox: ${sb.mode !== 'none' ? `${sb.mode} (active)` : `unavailable (${sb.reason ?? 'fallback'})`}`,
      `  Capabilities:   secrets=${secretBackend} ${g.bullet} pty=${ptyOk ? 'node-pty (native)' : 'pipe-fallback (degraded)'}`,
      `  Inventory:      ${computers.length} computer(s) ${g.bullet} ${models.length} model(s) ${g.bullet} external agents: ${extAgents.length ? extAgents.join(', ') : 'none'}`,
      `  Usage:          ${formatUsageAndCost(usage, costUsd)}`,
    ].join('\n');
  }

  async renderGitDiff(targetPath: string | undefined, columns: number, theme: ConversationTheme): Promise<string> {
    const argsBase = targetPath ? ['--', targetPath] : [];
    try {
      const statusRes = await execFileAsync('git', ['status', '--short', ...argsBase], {
        cwd: this.workspaceRoot,
        timeout: 5_000,
      });
      let diffText = '';
      try {
        const diffRes = await execFileAsync('git', ['diff', 'HEAD', '--no-color', ...argsBase], {
          cwd: this.workspaceRoot,
          timeout: 8_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        diffText = diffRes.stdout;
      } catch {
        const fallbackRes = await execFileAsync('git', ['diff', '--no-color', ...argsBase], {
          cwd: this.workspaceRoot,
          timeout: 8_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        diffText = fallbackRes.stdout;
      }

      const shortStatus = statusRes.stdout.trim();
      if (!shortStatus && !diffText.trim()) {
        return `  ${theme.muted('Working tree clean — no uncommitted changes.')}`;
      }

      const lines: string[] = [`${theme.bold('Workspace Changes')}`];
      if (shortStatus) {
        for (const sLine of shortStatus.split(/\r?\n/).slice(0, 15)) {
          lines.push(`  ${theme.muted(sLine)}`);
        }
      }
      if (diffText.trim()) {
        lines.push('');
        const rendered = renderUnifiedDiff(diffText, Math.max(24, columns - 4), theme, { indent: 2, maxLines: 120 });
        lines.push(...rendered);
      }
      return lines.join('\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      return `  ${theme.warning(`Unable to read git diff in ${this.workspaceName}: ${msg}`)}`;
    }
  }

  compactConversation(theme: ConversationTheme): { compactedTurns: number; message: string } {
    const g = theme.glyphs;
    const keepCount = 4;
    if (this.turns.length <= keepCount) {
      return {
        compactedTurns: 0,
        message: `  ${theme.muted(`Conversation is already compact (${this.turns.length} turn item${this.turns.length === 1 ? '' : 's'}).`)}`,
      };
    }
    const older = this.turns.slice(0, this.turns.length - keepCount);
    const recent = this.turns.slice(-keepCount);
    const summaryLines = older
      .map((t) => `- ${t.role}: ${t.content.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
      .slice(-8);
    const summaryTurn = {
      id: `turn-compact-${Date.now().toString(36)}`,
      role: 'assistant' as const,
      content: `[Compacted ${older.length} earlier conversation items]\n${summaryLines.join('\n')}`,
      timestamp: new Date().toISOString(),
      status: 'completed' as const,
    };
    this.turns = [summaryTurn, ...recent];
    return {
      compactedTurns: older.length,
      message: `  ${theme.success(g.success)} Compacted ${older.length} earlier turn item(s) into a concise summary (kept latest ${recent.length} verbatim).`,
    };
  }

  async generateWorkspaceAgentsMd(force: boolean, theme: ConversationTheme): Promise<string> {
    const g = theme.glyphs;
    if (this.permissionMode === 'read-only') {
      return `  ${theme.error(g.error)} /init blocked in read-only permission mode. Run ${theme.code('/permissions ask')} first.`;
    }
    const targetPath = path.join(this.workspaceRoot, 'AGENTS.md');
    if (!force) {
      try {
        await fs.access(targetPath);
        return `  ${theme.warning(g.warning)} AGENTS.md already exists in ${this.workspaceName}. Run ${theme.code('/init --force')} to overwrite it.`;
      } catch {
        // Does not exist; proceed
      }
    }

    let projectTitle = this.workspaceName;
    const commands: string[] = [];
    try {
      const pkgRaw = await fs.readFile(path.join(this.workspaceRoot, 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgRaw) as { name?: string; scripts?: Record<string, string> };
      if (pkg.name) projectTitle = pkg.name;
      const scripts = pkg.scripts ?? {};
      for (const key of ['build', 'test', 'typecheck', 'lint', 'check']) {
        if (scripts[key]) commands.push(`- \`npm run ${key}\` — \`${scripts[key]}\``);
      }
    } catch {
      // Non-Node workspace or no package.json
    }

    const entries = await fs.readdir(this.workspaceRoot, { withFileTypes: true }).catch(() => []);
    const topDirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
      .map((e) => e.name)
      .sort()
      .slice(0, 12);

    const content = [
      `# AGENTS.md — ${projectTitle}`,
      '',
      '## Commands',
      ...(commands.length > 0 ? commands : ['- Inspect repository build/test scripts before mutating files.']),
      '',
      '## Repository Layout',
      ...(topDirs.length > 0 ? topDirs.map((d) => `- \`${d}/\``) : ['- Single-directory workspace']),
      '',
      '## Working Conventions',
      '- Read target and caller files (`read` / `read_many_files`) before applying `edit` or `multi_edit`.',
      '- Run targeted verification checks immediately after modifying code.',
      '- Keep changes minimal, focused, and strictly inside the workspace root.',
      '',
    ].join('\n');

    await fs.writeFile(targetPath, content, 'utf8');
    return `  ${theme.success(g.success)} Generated ${theme.bold('AGENTS.md')} for ${projectTitle} (${topDirs.length} directories indexed).`;
  }

  async undoLastTurnChanges(theme: ConversationTheme): Promise<string> {
    const g = theme.glyphs;
    if (this.permissionMode === 'read-only') {
      return `  ${theme.error(g.error)} /undo blocked in read-only permission mode.`;
    }
    const lastEditedTurn = [...this.turns]
      .reverse()
      .find((t) => t.role === 'user' && Array.isArray(t.filesChanged) && t.filesChanged.length > 0);
    const rawFiles = lastEditedTurn?.filesChanged ?? [];
    const safeRelFiles = rawFiles
      .map((f) => (path.isAbsolute(f) ? path.relative(this.workspaceRoot, f) : f))
      .filter((rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel));

    if (safeRelFiles.length === 0) {
      return `  ${theme.muted('No recorded file edits from a recent conversation turn to undo.')}`;
    }

    try {
      await execFileAsync('git', ['checkout', '--', ...safeRelFiles], {
        cwd: this.workspaceRoot,
        timeout: 8_000,
      });
      if (lastEditedTurn) {
        lastEditedTurn.filesChanged = [];
      }
      return `  ${theme.success(g.success)} Reverted ${safeRelFiles.length} file(s) from the latest turn: ${safeRelFiles.join(', ')}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      return `  ${theme.error(g.error)} Unable to revert files via git checkout: ${msg}`;
    }
  }
}
