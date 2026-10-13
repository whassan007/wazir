import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentConfigurationDiscovery, ExternalAgentAdapter, isPreflightFresh, preflightAgent, type AgentPreflightResult } from '@wazir/agents';
import type { AgentAdapter } from '@wazir/core';
import { color } from './colors.js';
import { configDir } from './config.js';

type PreflightEngine = {
  projectRoot?: string;
  resources?: { accounts: { candidates(target: { agent: string }): Array<{ env?: Record<string, string> }> } };
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

export function invalidateAgentPreflight(name?: string, file = cacheFile()): void {
  const cache = loadPreflightCache(file);
  if (name) delete cache[name];
  savePreflightCache(name ? cache : {}, file);
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
    const env = { ...process.env, ...engine.resources?.accounts.candidates({ agent: name })[0]?.env };
    const config = new AgentConfigurationDiscovery().discover({ cwd: engine.projectRoot, env }).find(a => a.agent === name.split('@')[0]);
    const cached = cache[name];
    if (!options.fresh && cached && cached.fingerprint === config?.fingerprint && isPreflightFresh(cached)) return cached;
    if (config?.state === 'BLOCKED') return { agent: name, status: 'BLOCKED', detail: 'Invalid native configuration; validate it with the vendor CLI.', durationMs: 0, checkedAt: new Date().toISOString(), fingerprint: config.fingerprint };
    const result = await preflightAgent(adapter, { timeoutMs: options.timeoutMs, env });
    if (config?.executable) {
      const versionAdapter = new ExternalAgentAdapter({ name: 'version-inspection', version: '', description: '', command: config.executable, taskTypes: [], capabilities: [], timeoutMs: 3000, env });
      try {
        for await (const turn of versionAdapter.run({ taskDescription: '--version', projectRoot: os.tmpdir(), maxWallClockMs: 3000 } as any, {} as any)) {
          if (turn.kind === 'message') result.version = turn.content?.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b/)?.[0];
        }
      } catch { /* Version inspection is optional and does not invalidate a completed task. */ }
    }
    // Vendor errors may echo secrets. Persist only controlled diagnostics for discovered agents.
    if (config && result.status !== 'READY') result.detail = result.hint ?? 'Agent execution failed; inspect diagnostics using the vendor CLI.';
    return { ...result, fingerprint: config?.fingerprint };
  }));
  for (const r of results) if (r.status !== 'UNKNOWN') cache[r.agent] = r;
  savePreflightCache(cache, options.file);
  return results;
}

/** The cached result for an agent if it is fresh and says the agent cannot run; else undefined. */
export function knownAgentFailure(name: string, file?: string): AgentPreflightResult | undefined {
  const cached = loadPreflightCache(file)[name];
  if (cached?.fingerprint) {
    // Profile environments must be resolved by checkAgents with the account registry.
    if (name.includes('@')) return undefined;
    const config = new AgentConfigurationDiscovery().discover().find(a => a.agent === name);
    if (config?.fingerprint !== cached.fingerprint) return undefined;
  }
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
