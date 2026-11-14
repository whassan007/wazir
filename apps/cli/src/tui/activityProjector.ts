import path from 'node:path';
import type { PendingApprovalRequest } from '@wazir/core';
import type { ConversationTheme } from './theme.js';
import { buildInlineEditPreview, renderUnifiedDiff } from './markdownRenderer.js';
import { truncateToDisplayWidth } from './unicode.js';

export type ActivityCategory = 'read' | 'search' | 'edit' | 'command' | 'test' | 'web' | 'plan' | 'other';

export interface CoalescedActivityItem {
  id: string;
  category: ActivityCategory;
  status: 'running' | 'completed' | 'failed';
  label: string;
  detail?: string;
  startedAt: number;
  completedAt?: number;
  count: number;
  targets: string[];
}

export interface ApprovalPreviewBlock {
  header: string;
  ruleSummary: string;
  detailLines: string[];
  actionHint: string;
}

function shortTargetPath(rawPath: unknown, projectRoot?: string): string {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return '';
  const trimmed = rawPath.trim();
  if (projectRoot && path.isAbsolute(trimmed)) {
    const rel = path.relative(projectRoot, trimmed);
    if (rel && !rel.startsWith('..')) return rel;
  }
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

function classifyCommandLabel(cmd: string, presentTense: boolean): { category: ActivityCategory; label: string } {
  const clean = cmd.trim().replace(/\s+/g, ' ');
  if (!clean) {
    return { category: 'command', label: presentTense ? 'Running command' : 'Ran command' };
  }
  if (/\b(vitest|jest|pytest|cargo\s+test|go\s+test|npm\s+test|npm\s+run\s+test|pnpm\s+test|bun\s+test|mocha)\b/i.test(clean)) {
    return { category: 'test', label: presentTense ? 'Running tests' : 'Ran tests' };
  }
  if (/\b(tsc|typecheck|npm\s+run\s+build|pnpm\s+build|cargo\s+check|cargo\s+build|eslint|lint)\b/i.test(clean)) {
    return { category: 'test', label: presentTense ? 'Running build & checks' : 'Ran build & checks' };
  }
  const preview = clean.length > 44 ? `${clean.slice(0, 43)}…` : clean;
  return {
    category: 'command',
    label: presentTense ? `Running ${preview}` : `Ran ${preview}`,
  };
}

/**
 * Translates raw tool names + inputs into calm, plain-language activity phrases
 * ("Read 4 files", "Editing router.ts", "Running tests", "Searching for handleKey")
 * without leaking internal JSON action envelopes into the conversation transcript.
 */
export class ActivityProjector {
  private items: CoalescedActivityItem[] = [];
  private activeItem?: CoalescedActivityItem;
  private pendingCoalesced?: {
    category: 'read' | 'search';
    count: number;
    firstTarget?: string;
  };
  private seq = 0;

  constructor(private projectRoot?: string) {}

  setProjectRoot(projectRoot: string): void {
    this.projectRoot = projectRoot;
  }

  reset(): void {
    this.items = [];
    this.activeItem = undefined;
    this.pendingCoalesced = undefined;
  }

  getItems(): readonly CoalescedActivityItem[] {
    return this.items;
  }

  getActiveLabel(fallback?: string): string {
    if (this.activeItem) return this.activeItem.label;
    if (!fallback) return 'Thinking';
    // Strip internal phase/JSON noise from fallback strings
    const cleaned = fallback
      .replace(/^Tool:\s*/i, '')
      .replace(/^phase:\s*/i, '')
      .trim();
    if (!cleaned || cleaned.startsWith('{')) return 'Thinking';
    if (/^plan$/i.test(cleaned) || /planning/i.test(cleaned)) return 'Planning approach';
    if (/^verify|test$/i.test(cleaned)) return 'Running verification checks';
    return cleaned;
  }

  flushPending(): { kind: 'success'; text: string } | null {
    if (!this.pendingCoalesced) {
      this.activeItem = undefined;
      return null;
    }
    const pc = this.pendingCoalesced;
    this.pendingCoalesced = undefined;
    this.activeItem = undefined;
    const text =
      pc.category === 'read'
        ? pc.count > 1
          ? `Read ${pc.count} files`
          : `Read ${pc.firstTarget ?? '1 file'}`
        : pc.count > 1
          ? `Searched ${pc.count} patterns`
          : `Searched${pc.firstTarget ? ` for "${pc.firstTarget}"` : ' codebase'}`;
    return { kind: 'success', text };
  }

  observeProgress(
    p: { kind?: string; phase?: string; content?: string; tool?: string; error?: string },
    metadata?: Record<string, unknown>,
  ): { kind: 'info' | 'success' | 'error'; text: string; priorText?: string } | null {
    if (p.kind === 'token' || p.kind === 'usage') return null;

    const VALIDATION_PREFIXES = ['ACTION_VALIDATION_FAILED:', 'ACTION_BLOCKED_DUPLICATE:', 'INVALID_JSON_ACTION:'];
    if (p.content && VALIDATION_PREFIXES.some((prefix) => p.content!.startsWith(prefix))) {
      return null;
    }

    if (p.error) {
      const prior = this.flushPending();
      this.activeItem = undefined;
      const errLine = p.error.split(/\r?\n/, 1)[0] ?? 'Step failed';
      const label = p.tool
        ? `${this.describeTool(p.tool, metadata, false).label} failed — ${errLine}`
        : errLine;
      return { kind: 'error', text: label, priorText: prior?.text };
    }

    if (p.tool) {
      const past = this.describeTool(p.tool, metadata, false);
      const present = this.describeTool(p.tool, metadata, true);

      if (past.category === 'read' || past.category === 'search') {
        if (this.pendingCoalesced && this.pendingCoalesced.category === past.category) {
          this.pendingCoalesced.count += 1;
          const liveLabel =
            past.category === 'read'
              ? `Reading ${this.pendingCoalesced.count} files`
              : `Searching (${this.pendingCoalesced.count} queries)`;
          if (this.activeItem) {
            this.activeItem.label = liveLabel;
            this.activeItem.count = this.pendingCoalesced.count;
          }
          return null;
        }
        const prior = this.flushPending();
        this.pendingCoalesced = {
          category: past.category,
          count: 1,
          firstTarget: past.target,
        };
        this.activeItem = {
          id: `act-${++this.seq}`,
          category: past.category,
          status: 'running',
          label: present.label,
          detail: present.target,
          startedAt: Date.now(),
          count: 1,
          targets: past.target ? [past.target] : [],
        };
        return prior ? { kind: 'success', text: prior.text } : null;
      }

      const prior = this.flushPending();
      this.activeItem = {
        id: `act-${++this.seq}`,
        category: past.category,
        status: 'running',
        label: present.label,
        detail: present.target,
        startedAt: Date.now(),
        count: 1,
        targets: past.target ? [past.target] : [],
      };
      return { kind: 'success', text: past.label, priorText: prior?.text };
    }

    if (p.phase === 'test' || p.phase === 'verify') {
      const prior = this.flushPending();
      this.activeItem = {
        id: `act-${++this.seq}`,
        category: 'test',
        status: 'running',
        label: 'Running verification checks',
        startedAt: Date.now(),
        count: 1,
        targets: [],
      };
      return prior ? { kind: 'success', text: prior.text } : null;
    }

    if (p.phase === 'plan') {
      this.activeItem = {
        id: `act-${++this.seq}`,
        category: 'plan',
        status: 'running',
        label: 'Planning approach',
        startedAt: Date.now(),
        count: 1,
        targets: [],
      };
      return null;
    }

    return null;
  }

  recordToolStart(tool: string, input?: Record<string, unknown>, now = Date.now()): CoalescedActivityItem {
    const described = this.describeTool(tool, input, true);
    const item: CoalescedActivityItem = {
      id: `act-${++this.seq}`,
      category: described.category,
      status: 'running',
      label: described.label,
      detail: described.target,
      startedAt: now,
      count: 1,
      targets: described.target ? [described.target] : [],
    };
    this.activeItem = item;
    return item;
  }

  recordToolOutcome(
    tool: string,
    options: {
      input?: Record<string, unknown>;
      error?: string;
      projectRoot?: string;
      now?: number;
    } = {},
  ): { item: CoalescedActivityItem; coalesced: boolean; transcriptLine: string; diffLines?: string[] } {
    const now = options.now ?? Date.now();
    const root = options.projectRoot ?? this.projectRoot;
    const described = this.describeTool(tool, options.input, false, root);
    this.activeItem = undefined;

    if (options.error) {
      const failed: CoalescedActivityItem = {
        id: `act-${++this.seq}`,
        category: described.category,
        status: 'failed',
        label: `${described.label} failed`,
        detail: options.error.split(/\r?\n/, 1)[0],
        startedAt: now,
        completedAt: now,
        count: 1,
        targets: described.target ? [described.target] : [],
      };
      this.items.push(failed);
      return {
        item: failed,
        coalesced: false,
        transcriptLine: `${failed.label}${failed.detail ? ` — ${failed.detail}` : ''}`,
      };
    }

    const prev = this.items.at(-1);
    if (
      prev &&
      prev.status === 'completed' &&
      prev.category === 'read' &&
      described.category === 'read'
    ) {
      prev.count += 1;
      prev.completedAt = now;
      if (described.target && prev.targets.length < 25 && !prev.targets.includes(described.target)) {
        prev.targets.push(described.target);
      }
      prev.label = prev.count > 1
        ? `Read ${prev.count} files`
        : `Read ${prev.targets[0] ?? 'file'}`;
      return {
        item: prev,
        coalesced: true,
        transcriptLine: prev.label,
      };
    }

    if (
      prev &&
      prev.status === 'completed' &&
      prev.category === 'search' &&
      described.category === 'search'
    ) {
      prev.count += 1;
      prev.completedAt = now;
      prev.label = `Searched ${prev.count} patterns`;
      return {
        item: prev,
        coalesced: true,
        transcriptLine: prev.label,
      };
    }

    const completed: CoalescedActivityItem = {
      id: `act-${++this.seq}`,
      category: described.category,
      status: 'completed',
      label: described.label,
      detail: described.target,
      startedAt: now,
      completedAt: now,
      count: 1,
      targets: described.target ? [described.target] : [],
    };
    this.items.push(completed);

    return {
      item: completed,
      coalesced: false,
      transcriptLine: completed.label,
      diffLines: described.diffPreviewLines,
    };
  }

  private describeTool(
    rawTool: string,
    input?: Record<string, unknown>,
    presentTense = false,
    projectRoot = this.projectRoot,
  ): { category: ActivityCategory; label: string; target?: string; diffPreviewLines?: string[] } {
    const tool = rawTool.toLowerCase();
    const targetPath = shortTargetPath(
      input?.path ?? input?.file_path ?? input?.filePath ?? input?.target_file,
      projectRoot,
    );

    if (tool === 'read' || tool === 'read_file' || tool === 'view_file') {
      return {
        category: 'read',
        target: targetPath || undefined,
        label: presentTense
          ? `Reading ${targetPath || 'file'}`
          : `Read ${targetPath || '1 file'}`,
      };
    }

    if (tool === 'glob' || tool === 'list_dir' || tool === 'ls' || tool === 'find_by_name') {
      const pattern = typeof input?.pattern === 'string' ? input.pattern : targetPath;
      return {
        category: 'read',
        target: pattern || undefined,
        label: presentTense
          ? `Exploring ${pattern || 'workspace files'}`
          : `Listed ${pattern || 'workspace files'}`,
      };
    }

    if (tool === 'search' || tool === 'grep' || tool === 'grep_search' || tool === 'ripgrep') {
      const pattern = typeof input?.pattern === 'string'
        ? input.pattern
        : typeof input?.query === 'string'
          ? input.query
          : '';
      const shortPat = pattern.length > 28 ? `${pattern.slice(0, 27)}…` : pattern;
      return {
        category: 'search',
        target: shortPat || undefined,
        label: presentTense
          ? `Searching${shortPat ? ` for "${shortPat}"` : ' codebase'}`
          : `Searched${shortPat ? ` for "${shortPat}"` : ' codebase'}`,
      };
    }

    if (tool === 'edit' || tool === 'edit_file' || tool === 'replace') {
      return {
        category: 'edit',
        target: targetPath || undefined,
        label: presentTense
          ? `Editing ${targetPath || 'file'}`
          : `Edited ${targetPath || 'file'}`,
      };
    }

    if (tool === 'write' || tool === 'write_file' || tool === 'create_file') {
      return {
        category: 'edit',
        target: targetPath || undefined,
        label: presentTense
          ? `Writing ${targetPath || 'file'}`
          : `Wrote ${targetPath || 'file'}`,
      };
    }

    if (tool === 'shell' || tool === 'bash' || tool === 'run_shell_command' || tool === 'command') {
      const cmd = typeof input?.command === 'string' ? input.command : '';
      return classifyCommandLabel(cmd, presentTense);
    }

    if (tool === 'test' || tool === 'lint' || tool === 'typecheck' || tool === 'build') {
      const noun = tool === 'test' ? 'tests' : tool;
      return {
        category: 'test',
        label: presentTense ? `Running ${noun}` : `Ran ${noun}`,
      };
    }

    if (tool === 'web_search' || tool === 'web_fetch') {
      const q = typeof input?.query === 'string' ? input.query : typeof input?.url === 'string' ? input.url : '';
      const shortQ = q.length > 36 ? `${q.slice(0, 35)}…` : q;
      return {
        category: 'web',
        target: shortQ || undefined,
        label: presentTense
          ? `${tool === 'web_search' ? 'Searching web' : 'Fetching'}${shortQ ? `: ${shortQ}` : ''}`
          : `${tool === 'web_search' ? 'Searched web' : 'Fetched'}${shortQ ? `: ${shortQ}` : ''}`,
      };
    }

    return {
      category: 'other',
      label: presentTense ? `Running ${rawTool}` : `Completed ${rawTool}`,
    };
  }
}

/**
 * Formats a policy approval request with the exact shell command or file diff preview
 * and explicit focus semantics so ordinary typing never accidentally approves or denies.
 */
export function formatApprovalPreview(
  req: PendingApprovalRequest,
  columns: number,
  theme: ConversationTheme,
  options: { focused: boolean; queueLength: number; showDetails?: boolean; projectRoot?: string } = {
    focused: false,
    queueLength: 1,
  },
): ApprovalPreviewBlock {
  const safeCols = Math.max(24, columns - 4);
  const queueTag = options.queueLength > 1 ? ` (1/${options.queueLength})` : '';
  const focusBadge = options.focused
    ? theme.warning('[FOCUSED]')
    : theme.muted('[Tab to focus]');
  const rule = req.rule || 'policy-ask';
  const reasonText = req.reasons?.length ? req.reasons.join('; ') : 'Requires operator confirmation';

  const header = `${theme.warning(theme.glyphs.approval)} ${theme.bold(`Approval required${queueTag}`)} ${theme.glyphs.bullet} ${theme.code(req.tool)} ${focusBadge}`;
  const ruleSummary = `  ${theme.muted(`Policy ${rule}: ${truncateToDisplayWidth(reasonText, Math.max(16, safeCols - 12), theme.glyphs.ellipsis)}`)}`;

  const detailLines: string[] = [];
  const tool = req.tool.toLowerCase();

  if (tool === 'shell' || tool === 'bash' || typeof req.input?.command === 'string') {
    const cmd = String(req.input?.command ?? '').trim();
    detailLines.push(`  ${theme.muted('$')} ${theme.code(truncateToDisplayWidth(cmd || JSON.stringify(req.input), safeCols - 4, theme.glyphs.ellipsis))}`);
  } else if (tool === 'edit' || tool === 'write') {
    const filePath = shortTargetPath(req.input?.path, options.projectRoot) || String(req.input?.path ?? 'file');
    const oldStr = typeof req.input?.oldString === 'string' ? req.input.oldString : '';
    const newStr =
      typeof req.input?.newString === 'string'
        ? req.input.newString
        : typeof req.input?.content === 'string'
          ? req.input.content
          : '';
    const rendered = buildInlineEditPreview(
      filePath,
      oldStr,
      newStr,
      safeCols - 2,
      theme,
      options.showDetails ? 20 : 8,
    );
    for (const line of rendered) {
      detailLines.push(line);
    }
  } else {
    const summary = JSON.stringify(req.input ?? {});
    detailLines.push(`  ${theme.muted(truncateToDisplayWidth(summary, safeCols - 2, theme.glyphs.ellipsis))}`);
  }

  const actionHint = options.focused
    ? `  ${theme.accent('y')} approve ${theme.glyphs.bullet} ${theme.accent('n')} deny ${theme.glyphs.bullet} ${theme.accent('v')} details ${theme.glyphs.bullet} ${theme.accent('Tab')} return to composer`
    : `  ${theme.muted(`Press Tab to focus approval (y/n), or run /approve · /deny (typing stays in composer)`)}`;

  return {
    header,
    ruleSummary,
    detailLines,
    actionHint,
  };
}

/**
 * Formats token and cost telemetry honestly: never fabricates $0.00 when cost is unmeasured.
 */
export function formatUsageAndCost(usage?: { input?: number; output?: number; total?: number }, costUsd?: number | null): string {
  const tokensText =
    usage && ((usage.input ?? 0) > 0 || (usage.output ?? 0) > 0 || (usage.total ?? 0) > 0)
      ? `${(usage.input ?? 0).toLocaleString()} in / ${(usage.output ?? 0).toLocaleString()} out (${(usage.total ?? (usage.input ?? 0) + (usage.output ?? 0)).toLocaleString()} total)`
      : 'unknown';
  const costText =
    typeof costUsd === 'number' && Number.isFinite(costUsd)
      ? `$${costUsd.toFixed(4)}`
      : 'unknown';
  return `Tokens: ${tokensText} · Cost: ${costText}`;
}
