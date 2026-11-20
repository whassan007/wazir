import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SpotlightCategory =
  | 'terminal'
  | 'code'
  | 'models'
  | 'engine'
  | 'fleet'
  | 'sessions'
  | 'surface'
  | 'ai-task'
  | 'status';

export interface SpotlightMatch {
  id: string;
  text: string;
  subtext: string;
  iconName: string;
  category: SpotlightCategory;
  /** KRunner relevance 0.0..1.0 */
  relevance: number;
  /** Whether executing this match requires policy-governed AI orchestration */
  requiresAi: boolean;
  actionPayload: {
    kind: 'exec-terminal' | 'open-file' | 'open-url' | 'dispatch-ai' | 'switch-engine' | 'noop';
    target: string;
    args?: string[];
  };
}

export interface SpotlightOptions {
  apiBaseUrl?: string;
  webBaseUrl?: string;
  workspaceRoots?: string[];
  operatorToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_API_BASE = 'http://127.0.0.1:4800';
const DEFAULT_WEB_BASE = 'http://127.0.0.1:4801';

export function resolveOperatorToken(explicit?: string): string | undefined {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  if (process.env.WAZIR_OPERATOR_TOKEN?.trim()) return process.env.WAZIR_OPERATOR_TOKEN.trim();
  try {
    const tokenPath = path.join(os.homedir(), '.wazir', 'local-operator.token');
    if (fs.existsSync(tokenPath)) {
      const raw = fs.readFileSync(tokenPath, 'utf8').trim();
      if (raw.length > 0) return raw;
    }
  } catch {
    // Non-fatal: offline or unauthenticated mode
  }
  return undefined;
}

async function fetchApiJson<T>(
  baseUrl: string,
  endpoint: string,
  options: SpotlightOptions,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1200;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const token = resolveOperatorToken(options.operatorToken);

  try {
    const res = await fetchFn(`${baseUrl}${endpoint}`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function searchCodeDeterministic(
  query: string,
  workspaceRoots: string[],
  limit = 8,
): SpotlightMatch[] {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const matches: SpotlightMatch[] = [];
  for (const root of workspaceRoots) {
    if (!fs.existsSync(root)) continue;
    const rg = spawnSync(
      'rg',
      ['--no-heading', '--line-number', '--max-count', '2', '--max-filesize', '512K', trimmed, root],
      { encoding: 'utf8', timeout: 1000 },
    );
    if (rg.status === 0 && rg.stdout) {
      const lines = rg.stdout.split('\n').filter(Boolean).slice(0, limit - matches.length);
      for (const line of lines) {
        const firstColon = line.indexOf(':');
        const secondColon = line.indexOf(':', firstColon + 1);
        if (firstColon === -1 || secondColon === -1) continue;
        const filePath = line.slice(0, firstColon);
        const lineNum = line.slice(firstColon + 1, secondColon);
        const preview = line.slice(secondColon + 1).trim().slice(0, 90);
        matches.push({
          id: `code:${filePath}:${lineNum}`,
          text: `${path.basename(filePath)}:${lineNum}`,
          subtext: `${path.relative(root, filePath) || filePath} — ${preview}`,
          iconName: 'text-x-script',
          category: 'code',
          relevance: 0.9,
          requiresAi: false,
          actionPayload: {
            kind: 'open-file',
            target: filePath,
            args: [lineNum],
          },
        });
      }
    }
    if (matches.length >= limit) break;
  }
  return matches;
}

const SURFACE_SHORTCUTS: Array<{
  keywords: string[];
  id: string;
  text: string;
  subtext: string;
  iconName: string;
  urlHash: string;
}> = [
  {
    keywords: ['mission control', 'goal studio', 'goals', 'wazir'],
    id: 'surface:mission-control',
    text: 'Wazir Mission Control',
    subtext: 'Open Goal Studio & autonomous run orchestration',
    iconName: 'wazir',
    urlHash: '/goal-studio/',
  },
  {
    keywords: ['fleet', 'nodes', 'workers', 'wazir'],
    id: 'surface:fleet',
    text: 'Wazir Fleet',
    subtext: 'Inspect local & remote compute nodes, models, and workers',
    iconName: 'network-server',
    urlHash: '/#fleet',
  },
  {
    keywords: ['monitor', 'agents', 'executions', 'wazir'],
    id: 'surface:monitor',
    text: 'Wazir Agent Monitor',
    subtext: 'Live agent executions, SSE streams, and verification logs',
    iconName: 'utilities-system-monitor',
    urlHash: '/#executions',
  },
  {
    keywords: ['approvals', 'review', 'policy', 'wazir'],
    id: 'surface:approvals',
    text: 'Wazir Approvals',
    subtext: 'Review pending policy-gated tool and shell approvals',
    iconName: 'security-high',
    urlHash: '/#approvals',
  },
  {
    keywords: ['settings', 'preferences', 'autonomy', 'wazir'],
    id: 'surface:settings',
    text: 'Wazir Settings',
    subtext: 'Configure theme, autonomy posture, SSH hosts, and model routing',
    iconName: 'configure',
    urlHash: '/#settings',
  },
];

/**
 * Evaluates a Spotlight query deterministically first.
 * Only explicit AI prefixes (`wazir:`, `ai:`, `? `) route to Wazir AI orchestration.
 */
export async function querySpotlight(
  rawQuery: string,
  options: SpotlightOptions = {},
): Promise<SpotlightMatch[]> {
  const query = rawQuery.trim();
  if (!query) return [];

  const apiBase = options.apiBaseUrl ?? DEFAULT_API_BASE;
  const webBase = options.webBaseUrl ?? DEFAULT_WEB_BASE;
  const workspaceRoots = options.workspaceRoots ?? [process.cwd()];

  // 1. Deterministic Terminal Command (`> cmd` or `sh:cmd`)
  if (query.startsWith('>') || query.toLowerCase().startsWith('sh:')) {
    const cmd = (query.startsWith('>') ? query.slice(1) : query.slice(3)).trim();
    if (!cmd) return [];
    return [
      {
        id: `terminal:${cmd}`,
        text: `Run in Wazir Terminal: ${cmd}`,
        subtext: 'Deterministic shell execution (no LLM)',
        iconName: 'utilities-terminal',
        category: 'terminal',
        relevance: 1.0,
        requiresAi: false,
        actionPayload: {
          kind: 'exec-terminal',
          target: cmd,
        },
      },
    ];
  }

  // 2. Deterministic Repository / Source-Code Search (`repo:` or `code:`)
  if (query.toLowerCase().startsWith('repo:') || query.toLowerCase().startsWith('code:')) {
    const term = query.slice(5).trim();
    const codeMatches = searchCodeDeterministic(term, workspaceRoots);
    if (codeMatches.length > 0) return codeMatches;
    return [
      {
        id: `code:none:${term}`,
        text: `No source matches for "${term}"`,
        subtext: `Searched ${workspaceRoots.join(', ')} (deterministic ripgrep)`,
        iconName: 'edit-find',
        category: 'code',
        relevance: 0.4,
        requiresAi: false,
        actionPayload: { kind: 'noop', target: '' },
      },
    ];
  }

  // 3. Deterministic Model Selection & Availability (`@model` or `models`)
  if (query.startsWith('@') || query.toLowerCase() === 'models' || query.toLowerCase().startsWith('model ')) {
    const filter = (query.startsWith('@') ? query.slice(1) : query.replace(/^models?\s*/i, '')).trim().toLowerCase();
    const res = await fetchApiJson<{ models?: Array<{ id: string; name?: string; status?: string; provider?: string }> }>(
      apiBase,
      '/api/v1/models',
      options,
    );
    if (!res.ok) {
      return [
        {
          id: 'models:offline',
          text: 'Wazir Models unavailable (control plane offline)',
          subtext: `API ${apiBase} unreachable (${res.error}). Desktop & shell remain operational.`,
          iconName: 'dialog-warning',
          category: 'status',
          relevance: 0.5,
          requiresAi: false,
          actionPayload: { kind: 'noop', target: '' },
        },
      ];
    }
    const models = (res.data.models ?? []).filter((m) =>
      !filter || m.id.toLowerCase().includes(filter) || (m.name ?? '').toLowerCase().includes(filter),
    );
    return models.slice(0, 8).map((m) => ({
      id: `model:${m.id}`,
      text: `Model: ${m.name ?? m.id}`,
      subtext: `Provider: ${m.provider ?? 'local'} • Status: ${m.status ?? 'available'}`,
      iconName: 'cpu',
      category: 'models' as const,
      relevance: 0.95,
      requiresAi: false,
      actionPayload: { kind: 'open-url' as const, target: `${webBase}/#models` },
    }));
  }

  // 3b. Deterministic OS Engine Switch / Status (`engine`, `engine:<id>`, `use <liquid|gemma4|qwen|nemo|auto>`)
  const lowerQuery = query.toLowerCase();
  if (
    lowerQuery === 'engine' ||
    lowerQuery === 'engines' ||
    lowerQuery.startsWith('engine:') ||
    /^use\s+(liquid|gemma4|qwen|nemo|super-nemo|auto)\b/.test(lowerQuery)
  ) {
    const ENGINE_OPTIONS = [
      { id: 'auto', aliases: ['auto'], label: 'Auto (Per-Job Smart Engine)', sub: 'Liquid AI for edge/quick, Gemma 4 for general, Qwen for code, Super Nemo for deep reasoning' },
      { id: 'liquid-light', aliases: ['liquid', 'liquid-light', 'lfm'], label: 'Liquid AI (Light / Edge)', sub: 'Ultra-fast local/offline engine (LFM2 / small edge models)' },
      { id: 'gemma4-generic', aliases: ['gemma4', 'gemma4-generic', 'gemma'], label: 'Gemma 4 (Generic / Balanced)', sub: 'Balanced multimodal & everyday desktop assistant' },
      { id: 'qwen-coder', aliases: ['qwen', 'qwen-coder'], label: 'Qwen (Coding & Agentic)', sub: 'Code-specialized repository & tool-calling engine' },
      { id: 'super-nemo', aliases: ['nemo', 'super-nemo', 'nemotron'], label: 'Super Nemo (Deep Reasoning)', sub: 'High-capacity Nemotron Super engine for architecture & formal tasks' },
    ];
    const arg = lowerQuery.replace(/^(engine:?|engines|use)\s*/, '').trim();
    const filtered = arg
      ? ENGINE_OPTIONS.filter((e) => e.id.includes(arg) || e.aliases.some((a) => a.includes(arg)))
      : ENGINE_OPTIONS;
    return (filtered.length > 0 ? filtered : ENGINE_OPTIONS).map((e) => ({
      id: `engine:${e.id}`,
      text: `Switch Wazir OS Engine: ${e.label}`,
      subtext: e.sub,
      iconName: 'cpu',
      category: 'engine' as const,
      relevance: 0.96,
      requiresAi: false,
      actionPayload: {
        kind: 'switch-engine' as const,
        target: e.id,
      },
    }));
  }

  // 4. Deterministic Active Agents & Remote Workers (`fleet`, `agents`, `workers`)
  const lower = query.toLowerCase();
  if (lower === 'fleet' || lower === 'agents' || lower === 'workers') {
    const [workersRes, agentsRes] = await Promise.all([
      fetchApiJson<{ workers?: Array<{ id: string; status?: string; host?: string }> }>(apiBase, '/api/v1/workers', options),
      fetchApiJson<{ agents?: Array<{ id: string; name?: string; status?: string }> }>(apiBase, '/api/v1/agents', options),
    ]);
    if (!workersRes.ok && !agentsRes.ok) {
      return [
        {
          id: 'fleet:offline',
          text: 'Wazir Fleet offline',
          subtext: `Cannot reach ${apiBase}. Start wazir-api.service or open Wazir Desktop.`,
          iconName: 'network-offline',
          category: 'status',
          relevance: 0.6,
          requiresAi: false,
          actionPayload: { kind: 'open-url', target: `${webBase}/#fleet` },
        },
      ];
    }
    const matches: SpotlightMatch[] = [];
    for (const w of (workersRes.ok ? workersRes.data.workers ?? [] : []).slice(0, 5)) {
      matches.push({
        id: `worker:${w.id}`,
        text: `Worker: ${w.id}`,
        subtext: `Host: ${w.host ?? 'local'} • Status: ${w.status ?? 'ready'}`,
        iconName: 'network-server',
        category: 'fleet',
        relevance: 0.92,
        requiresAi: false,
        actionPayload: { kind: 'open-url', target: `${webBase}/#fleet` },
      });
    }
    for (const a of (agentsRes.ok ? agentsRes.data.agents ?? [] : []).slice(0, 5)) {
      matches.push({
        id: `agent:${a.id}`,
        text: `Agent: ${a.name ?? a.id}`,
        subtext: `Status: ${a.status ?? 'idle'}`,
        iconName: 'system-users',
        category: 'fleet',
        relevance: 0.9,
        requiresAi: false,
        actionPayload: { kind: 'open-url', target: `${webBase}/#executions` },
      });
    }
    return matches.length > 0 ? matches : [
      {
        id: 'fleet:empty',
        text: 'Wazir Fleet Online (0 active workers)',
        subtext: 'Open Wazir Fleet dashboard to inspect nodes',
        iconName: 'wazir',
        category: 'fleet',
        relevance: 0.8,
        requiresAi: false,
        actionPayload: { kind: 'open-url', target: `${webBase}/#fleet` },
      },
    ];
  }

  // 5. Deterministic Recent Sessions & Execution History (`sessions`, `runs`, `history`)
  if (lower === 'sessions' || lower === 'runs' || lower === 'history') {
    const res = await fetchApiJson<{ executions?: Array<{ id: string; status?: string; input?: string }> }>(
      apiBase,
      '/api/v1/executions',
      options,
    );
    if (!res.ok) {
      return [
        {
          id: 'sessions:offline',
          text: 'Recent Sessions unavailable (API offline)',
          subtext: `API ${apiBase} unreachable (${res.error})`,
          iconName: 'dialog-warning',
          category: 'status',
          relevance: 0.5,
          requiresAi: false,
          actionPayload: { kind: 'noop', target: '' },
        },
      ];
    }
    const items = (res.data.executions ?? []).slice(0, 6);
    return items.map((ex) => ({
      id: `session:${ex.id}`,
      text: `Session ${ex.id.slice(0, 10)} (${ex.status ?? 'unknown'})`,
      subtext: (ex.input ?? 'Execution record').slice(0, 90),
      iconName: 'view-history',
      category: 'sessions' as const,
      relevance: 0.88,
      requiresAi: false,
      actionPayload: { kind: 'open-url' as const, target: `${webBase}/#executions` },
    }));
  }

  // 6. Policy-Governed Natural-Language AI Task (`wazir:`, `ai:`, or `? `)
  if (lower.startsWith('wazir:') || lower.startsWith('ai:') || query.startsWith('? ')) {
    const task = query.replace(/^(wazir:|ai:|\?\s*)/i, '').trim();
    if (!task) return [];
    return [
      {
        id: `ai:${task}`,
        text: `Ask Wazir AI: ${task}`,
        subtext: 'Executes via policy-governed Wazir orchestration & verification pipeline',
        iconName: 'wazir',
        category: 'ai-task',
        relevance: 0.96,
        requiresAi: true,
        actionPayload: {
          kind: 'dispatch-ai',
          target: task,
        },
      },
    ];
  }

  // 7. Surface Shortcuts (deterministic substring match)
  const surfaceHits: SpotlightMatch[] = [];
  for (const s of SURFACE_SHORTCUTS) {
    if (s.keywords.some((k) => k.includes(lower) || lower.includes(k))) {
      surfaceHits.push({
        id: s.id,
        text: s.text,
        subtext: s.subtext,
        iconName: s.iconName,
        category: 'surface',
        relevance: 0.85,
        requiresAi: false,
        actionPayload: {
          kind: 'open-url',
          target: `${webBase}${s.urlHash}`,
        },
      });
    }
  }
  return surfaceHits;
}

/** Executes a selected Spotlight match safely. */
export async function executeSpotlightMatch(
  match: SpotlightMatch,
  options: SpotlightOptions = {},
): Promise<{ executed: boolean; detail: string }> {
  const apiBase = options.apiBaseUrl ?? DEFAULT_API_BASE;
  const fetchFn = options.fetchImpl ?? fetch;

  if (match.actionPayload.kind === 'switch-engine') {
    const token = resolveOperatorToken(options.operatorToken);
    if (!token) {
      return {
        executed: false,
        detail: 'Operator credential required to switch Wazir OS engine',
      };
    }
    try {
      const res = await fetchFn(`${apiBase}/api/v1/os/engine`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ activeEngineId: match.actionPayload.target }),
      });
      if (!res.ok) {
        return { executed: false, detail: `Engine switch rejected (${res.status})` };
      }
      return { executed: true, detail: `Wazir OS engine set to ${match.actionPayload.target}` };
    } catch (err) {
      return {
        executed: false,
        detail: err instanceof Error ? err.message : 'Control plane unreachable',
      };
    }
  }

  if (match.actionPayload.kind === 'dispatch-ai') {
    const token = resolveOperatorToken(options.operatorToken);
    if (!token) {
      return {
        executed: false,
        detail: 'Operator credential required for policy-governed AI execution',
      };
    }
    try {
      const res = await fetchFn(`${apiBase}/api/v1/tasks/dispatch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          input: match.actionPayload.target,
          source: 'wazir-spotlight',
        }),
      });
      if (!res.ok) {
        return { executed: false, detail: `Dispatch rejected (${res.status})` };
      }
      return { executed: true, detail: 'Dispatched to Wazir policy-governed orchestrator' };
    } catch (err) {
      return {
        executed: false,
        detail: err instanceof Error ? err.message : 'Control plane unreachable',
      };
    }
  }

  return { executed: true, detail: `${match.actionPayload.kind}:${match.actionPayload.target}` };
}
