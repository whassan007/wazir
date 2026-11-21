import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface SlashCommandSpec {
  command: string;
  aliases?: readonly string[];
  summary: string;
  usage?: string;
  acceptsArgs?: boolean;
  tier: 'primary' | 'secondary';
}

export const CONVERSATION_SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    command: '/help',
    aliases: ['/?'],
    summary: 'Show commands, keyboard shortcuts, and newline keys',
    tier: 'primary',
  },
  {
    command: '/model',
    aliases: ['/models'],
    summary: 'Search and select model, external agent, or auto-routing',
    usage: '/model [id | auto | agent:<name>]',
    acceptsArgs: true,
    tier: 'primary',
  },
  {
    command: '/permissions',
    aliases: ['/perm'],
    summary: 'View or switch permission mode (ask, auto, read-only)',
    usage: '/permissions [ask | auto | read-only]',
    acceptsArgs: true,
    tier: 'primary',
  },
  {
    command: '/status',
    summary: 'Show workspace, branch, model route, hardware share, and usage',
    tier: 'primary',
  },
  {
    command: '/diff',
    summary: 'Show uncommitted workspace diff and modified files',
    usage: '/diff [--stat]',
    acceptsArgs: true,
    tier: 'primary',
  },
  {
    command: '/resume',
    summary: 'Resume a paused workflow run or previous conversation session',
    usage: '/resume [runId | session-id | --last]',
    acceptsArgs: true,
    tier: 'primary',
  },
  {
    command: '/loop',
    summary: 'Run a bounded iterative Loop workflow across items or until a condition',
    usage: '/loop <task>',
    acceptsArgs: true,
    tier: 'primary',
  },
  {
    command: '/graph',
    summary: 'Compile and execute a dependency-ordered DAG Graph workflow',
    usage: '/graph <goal>',
    acceptsArgs: true,
    tier: 'primary',
  },
  {
    command: '/goal',
    aliases: ['/goals'],
    summary: 'Auto-select single, loop, graph, or hybrid workflow or open Goal Studio',
    usage: '/goal [goal]',
    acceptsArgs: true,
    tier: 'primary',
  },
  {
    command: '/jobs',
    summary: 'List active and persisted Loop, Graph, and Goal workflow runs',
    usage: '/jobs [status | mode]',
    tier: 'primary',
  },
  {
    command: '/clear',
    summary: 'Clear visible transcript and start a fresh conversation turn',
    tier: 'primary',
  },
  {
    command: '/fleet',
    summary: 'Open the full-screen multi-agent fleet & DAG view',
    tier: 'primary',
  },
  {
    command: '/exit',
    aliases: ['/quit'],
    summary: 'Exit Wazir and restore terminal state',
    tier: 'primary',
  },
  {
    command: '/steer',
    summary: 'Steer the currently running task with refined guidance',
    usage: '/steer <instruction>',
    acceptsArgs: true,
    tier: 'secondary',
  },
  {
    command: '/doctor',
    summary: 'Check provider, runtime, and sandbox health',
    tier: 'secondary',
  },
  {
    command: '/logs',
    aliases: ['/details', '/tail'],
    summary: 'Expand detailed tool and execution events for the latest run',
    tier: 'secondary',
  },
  {
    command: '/tasks',
    summary: 'List tasks and execution statuses in this session',
    tier: 'secondary',
  },
  {
    command: '/compact',
    summary: 'Compact conversation history and active execution context window',
    tier: 'secondary',
  },
  {
    command: '/init',
    summary: 'Generate a workspace AGENTS.md guide from repository structure',
    usage: '/init [--force]',
    acceptsArgs: true,
    tier: 'secondary',
  },
  {
    command: '/undo',
    summary: 'Revert uncommitted file edits from the latest conversation turn',
    tier: 'secondary',
  },
  {
    command: '/copy',
    summary: 'Enter keyboard transcript copy mode (or drag-select with mouse)',
    tier: 'secondary',
  },
  {
    command: '/inspect',
    summary: 'Inspect workflow plan, loop cursor, critical path, targets, and evidence',
    usage: '/inspect <runId>',
    acceptsArgs: true,
    tier: 'secondary',
  },
  {
    command: '/pause',
    summary: 'Pause a running workflow run cleanly at its durable checkpoint',
    usage: '/pause <runId>',
    acceptsArgs: true,
    tier: 'secondary',
  },
  {
    command: '/stop',
    summary: 'Stop a workflow run cleanly and release its lease',
    usage: '/stop <runId>',
    acceptsArgs: true,
    tier: 'secondary',
  },
  {
    command: '/update',
    summary: 'Inspect Wazir version and update status',
    tier: 'secondary',
  },
];

export interface CompletionItem {
  insertText: string;
  label: string;
  detail: string;
  kind: 'command' | 'file' | 'reference';
  executeOnEnter?: boolean;
}

export interface ActiveCompletionState {
  trigger: 'slash' | 'mention';
  replaceStart: number;
  replaceEnd: number;
  query: string;
  items: CompletionItem[];
  selectedIndex: number;
}

export interface SelectorOption {
  id: string;
  label: string;
  detail: string;
  badge?: string;
  current?: boolean;
}

export interface InteractiveSelectorState {
  kind: 'model' | 'permissions' | 'resume' | 'palette';
  title: string;
  placeholder: string;
  query: string;
  options: SelectorOption[];
  selectedIndex: number;
}

export function filterSelectorOptions(options: readonly SelectorOption[], query: string): SelectorOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  const scored: Array<{ opt: SelectorOption; score: number }> = [];
  for (const opt of options) {
    const hay = `${opt.label} ${opt.id} ${opt.detail} ${opt.badge ?? ''}`.toLowerCase();
    const labelLower = opt.label.toLowerCase();
    if (labelLower === q || opt.id.toLowerCase() === q) {
      scored.push({ opt, score: 100 });
    } else if (labelLower.startsWith(q) || opt.id.toLowerCase().startsWith(q)) {
      scored.push({ opt, score: 80 });
    } else if (hay.includes(q)) {
      scored.push({ opt, score: 60 });
    } else if (fuzzySubsequence(q, hay)) {
      scored.push({ opt, score: 30 });
    }
  }
  scored.sort((a, b) => b.score - a.score || (b.opt.current ? 1 : 0) - (a.opt.current ? 1 : 0));
  return scored.map((s) => s.opt);
}

function fuzzySubsequence(needle: string, haystack: string): boolean {
  let ni = 0;
  for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
    if (haystack[hi] === needle[ni]) ni++;
  }
  return ni === needle.length;
}

/**
 * Matches `/` slash commands when the prompt begins with `/` and has no space before `cursor`.
 */
export function matchSlashCompletions(prompt: string, cursor: number): ActiveCompletionState | null {
  const before = prompt.slice(0, cursor);
  if (!before.startsWith('/') || /\s/.test(before) || prompt.includes('\n')) {
    return null;
  }
  const query = before.slice(1).toLowerCase();
  const matches: Array<{ spec: SlashCommandSpec; score: number }> = [];

  for (const spec of CONVERSATION_SLASH_COMMANDS) {
    const bare = spec.command.slice(1).toLowerCase();
    const aliasHit = spec.aliases?.some((a) => a.slice(1).toLowerCase().startsWith(query)) ?? false;
    const tierBonus = spec.tier === 'primary' ? 10 : 0;
    if (!query) {
      matches.push({ spec, score: 50 + tierBonus });
    } else if (bare === query) {
      matches.push({ spec, score: 120 + tierBonus });
    } else if (bare.startsWith(query) || aliasHit) {
      matches.push({ spec, score: 90 + tierBonus });
    } else if (bare.includes(query) || spec.summary.toLowerCase().includes(query)) {
      matches.push({ spec, score: 45 + tierBonus });
    } else if (fuzzySubsequence(query, bare)) {
      matches.push({ spec, score: 25 + tierBonus });
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.score - a.score);

  const items: CompletionItem[] = matches.slice(0, 8).map(({ spec }) => ({
    insertText: spec.acceptsArgs ? `${spec.command} ` : spec.command,
    label: spec.command,
    detail: spec.summary,
    kind: 'command',
    executeOnEnter:
      !spec.acceptsArgs ||
      spec.command === '/model' ||
      spec.command === '/permissions' ||
      spec.command === '/resume' ||
      spec.command === '/diff' ||
      spec.command === '/goal' ||
      spec.command === '/jobs',
  }));

  return {
    trigger: 'slash',
    replaceStart: 0,
    replaceEnd: cursor,
    query,
    items,
    selectedIndex: 0,
  };
}

interface CachedWorkspaceFiles {
  root: string;
  at: number;
  files: string[];
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', '.fa', '.next', 'coverage', 'target', '.turbo', '.wazir']);
let workspaceFileCache: CachedWorkspaceFiles | undefined;

export function invalidateWorkspaceFileCache(): void {
  workspaceFileCache = undefined;
}

export function listWorkspaceFiles(projectRoot: string, maxFiles = 2000): string[] {
  const now = Date.now();
  if (workspaceFileCache && workspaceFileCache.root === projectRoot && now - workspaceFileCache.at < 5000) {
    return workspaceFileCache.files;
  }

  let files: string[] = [];
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 800,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    });
    files = out
      .split(/\r?\n/)
      .filter((f) => f.length > 0 && !f.startsWith('.fa/') && !f.startsWith('node_modules/') && !f.startsWith('dist/'))
      .slice(0, maxFiles);
  } catch {
    // Bounded filesystem walk fallback outside git repos
    const walk = (dir: string, depth: number): void => {
      if (depth > 4 || files.length >= maxFiles) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles) break;
        if (entry.name.startsWith('.') && entry.name !== '.env.example') {
          if (entry.isDirectory()) continue;
        }
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          walk(path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          const rel = path.relative(projectRoot, path.join(dir, entry.name)).split(path.sep).join('/');
          files.push(rel);
        }
      }
    };
    walk(projectRoot, 0);
  }

  workspaceFileCache = { root: projectRoot, at: now, files };
  return files;
}

/**
 * Matches `@` file and entity mentions immediately preceding `cursor`.
 */
export function matchFileMentionCompletions(
  prompt: string,
  cursor: number,
  projectRoot: string,
  extraReferences: readonly string[] = [],
): ActiveCompletionState | null {
  const before = prompt.slice(0, cursor);
  const match = /(?:^|\s)(@([a-zA-Z0-9_./:-]*))$/.exec(before);
  if (!match) return null;

  const fullToken = match[1]!;
  const query = (match[2] ?? '').toLowerCase();
  const replaceStart = cursor - fullToken.length;
  const replaceEnd = cursor;

  const files = listWorkspaceFiles(projectRoot);
  const scored: Array<{ item: CompletionItem; score: number }> = [];

  for (const rel of files) {
    const lower = rel.toLowerCase();
    const base = path.posix.basename(lower);
    let score = 0;
    if (!query) {
      // Prefer shallow top-level / key files when bare `@` is typed
      const depth = rel.split('/').length;
      score = Math.max(10, 50 - depth * 8);
    } else if (base === query || lower === query) {
      score = 120;
    } else if (base.startsWith(query)) {
      score = 95 - Math.min(20, rel.length / 8);
    } else if (lower.startsWith(query)) {
      score = 85;
    } else if (lower.includes(query)) {
      score = 65 - Math.min(20, rel.length / 10);
    } else if (query.length >= 2 && fuzzySubsequence(query, lower)) {
      score = 35;
    }
    if (score > 0) {
      scored.push({
        score,
        item: {
          insertText: `@${rel} `,
          label: `@${rel}`,
          detail: 'workspace file',
          kind: 'file',
        },
      });
    }
  }

  for (const ref of extraReferences) {
    const cleanRef = ref.startsWith('@') ? ref : `@${ref}`;
    const lower = cleanRef.slice(1).toLowerCase();
    if (!query && !cleanRef.startsWith('@file:')) {
      scored.push({
        score: 20,
        item: { insertText: `${cleanRef} `, label: cleanRef, detail: 'session reference', kind: 'reference' },
      });
    } else if (query && lower.includes(query)) {
      scored.push({
        score: cleanRef.startsWith('@job:') || cleanRef.startsWith('@model:') ? 75 : 40,
        item: { insertText: `${cleanRef} `, label: cleanRef, detail: 'session reference', kind: 'reference' },
      });
    }
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));

  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const { item } of scored) {
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    items.push(item);
    if (items.length >= 8) break;
  }

  return {
    trigger: 'mention',
    replaceStart,
    replaceEnd,
    query,
    items,
    selectedIndex: 0,
  };
}

/**
 * Resolves `@path/to/file` mentions in a user prompt into bounded file excerpts
 * so mentioning `@apps/cli/src/index.ts` gives the coding agent immediate file context.
 */
export function resolvePromptFileMentions(
  prompt: string,
  projectRoot: string,
  maxBytesPerFile = 12_000,
  maxTotalBytes = 32_000,
): Array<{ relativePath: string; content: string; truncated: boolean }> {
  const tokens = prompt.match(/(?:^|\s)@([a-zA-Z0-9_./-]+)/g) ?? [];
  const results: Array<{ relativePath: string; content: string; truncated: boolean }> = [];
  const seen = new Set<string>();
  let usedBytes = 0;

  for (const rawToken of tokens) {
    const relCandidate = rawToken.trim().slice(1).replace(/^file:/, '');
    if (!relCandidate || relCandidate.includes(':') || seen.has(relCandidate)) continue;
    const abs = path.resolve(projectRoot, relCandidate);
    const relFromRoot = path.relative(projectRoot, abs);
    if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) continue;

    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      seen.add(relCandidate);
      const remaining = maxTotalBytes - usedBytes;
      if (remaining <= 0) break;
      const limit = Math.min(maxBytesPerFile, remaining);
      const raw = readFileSync(abs, 'utf8');
      const truncated = raw.length > limit;
      const slice = truncated ? raw.slice(0, limit) : raw;
      usedBytes += slice.length;
      results.push({
        relativePath: relFromRoot.split(path.sep).join('/'),
        content: slice,
        truncated,
      });
    } catch {
      // Ignore non-existent @mentions
    }
  }

  return results;
}

export function detectGitBranch(projectRoot: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}
