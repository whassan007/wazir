import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isPreflightFresh, preflightAgent, type AgentPreflightResult } from '@wazir/agents';
import type { AgentAdapter } from '@wazir/core';
import { color } from './colors.js';
import { configDir } from './config.js';

type PreflightEngine = {
  agents: { list(): Array<{ descriptor: { name: string }; source: string }>; get(name: string): AgentAdapter | undefined };
};

const cacheFile = () => path.join(configDir(), 'agent-preflight.json');

export function loadPreflightCache(file = cacheFile()): Record<string, AgentPreflightResult> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { results?: Record<string, AgentPreflightResult> };
    return parsed.results && typeof parsed.results === 'object' ? parsed.results : {};
  } catch {
    return {};
  }
}

function savePreflightCache(results: Record<string, AgentPreflightResult>, file = cacheFile()): void {
  try {
    if (!existsSync(path.dirname(file))) mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, results }, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } catch {
    // The cache is an optimisation; a read-only config dir just means probing again next time.
  }
}

/** External agents only: native agents run on Wazir's own runtimes, covered by `wa doctor`. */
export function externalAgentNames(engine: PreflightEngine): string[] {
  return engine.agents.list().filter((a) => a.source === 'external').map((a) => a.descriptor.name);
}

/**
 * Probes the requested external agents (all of them by default), in parallel. A cached result
 * younger than the TTL is reused unless `fresh` is set. Unknown names are reported as UNKNOWN.
 */
export async function checkAgents(
  engine: PreflightEngine,
  names: string[] = [],
  options: { fresh?: boolean; timeoutMs?: number; file?: string } = {},
): Promise<AgentPreflightResult[]> {
  const external = externalAgentNames(engine);
  const targets = names.length ? names : external;
  const cache = loadPreflightCache(options.file);
  const results = await Promise.all(targets.map(async (name): Promise<AgentPreflightResult> => {
    const adapter = external.includes(name) ? engine.agents.get(name) : undefined;
    if (!adapter) {
      return { agent: name, status: 'UNKNOWN', detail: 'not a registered external agent (is its CLI installed?)', durationMs: 0, checkedAt: new Date().toISOString() };
    }
    const cached = cache[name];
    if (!options.fresh && cached && isPreflightFresh(cached)) return cached;
    return preflightAgent(adapter, { timeoutMs: options.timeoutMs });
  }));
  for (const r of results) if (r.status !== 'UNKNOWN') cache[r.agent] = r;
  savePreflightCache(cache, options.file);
  return results;
}

/** The cached result for an agent if it is fresh and says the agent cannot run; else undefined. */
export function knownAgentFailure(name: string, file?: string): AgentPreflightResult | undefined {
  const cached = loadPreflightCache(file)[name];
  return cached && isPreflightFresh(cached) && (cached.status === 'FAILED' || cached.status === 'BLOCKED') ? cached : undefined;
}

const paintStatus = (s: string) =>
  s === 'READY' ? color.green(s) : s === 'BLOCKED' ? color.yellow(s) : s === 'FAILED' ? color.red(s) : color.gray(s);

export function renderPreflight(results: AgentPreflightResult[]): string {
  if (results.length === 0) return 'No external agents are registered. Install claude, codex, qwen, gemini or agy to enable delegation.';
  const width = Math.max(5, ...results.map((r) => r.agent.length)) + 2;
  const lines = [color.bold(`${'AGENT'.padEnd(width)}${'STATUS'.padEnd(9)}DETAIL`)];
  for (const r of [...results].sort((a, b) => a.agent.localeCompare(b.agent))) {
    lines.push(`${r.agent.padEnd(width)}${paintStatus(r.status.padEnd(8))} ${r.detail}`);
    if (r.hint) lines.push(`${' '.repeat(width + 9)}${color.gray(`fix: ${r.hint}`)}`);
  }
  return lines.join('\n');
}

/** Message used when `wa run --agent X` is refused because of a known, fresh failure. */
export function refusalMessage(r: AgentPreflightResult): string {
  return [
    `Agent '${r.agent}' is ${r.status} (checked ${new Date(r.checkedAt).toLocaleTimeString()}): ${r.detail}`,
    ...(r.hint ? [`fix: ${r.hint}`] : []),
    `Re-check with 'wa agents check ${r.agent} --fresh', or run anyway with --force.`,
  ].join('\n');
}
