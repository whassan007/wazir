import { renderCompactLogo, renderUnicodeMediumLogo, formatWorkspacePath, detectTerminalCapabilities } from '../brand.js';
import { color } from '../colors.js';
import { stringDisplayWidth, stripAnsi, truncateToDisplayWidth } from './unicode.js';
import type { RookEngine } from '../engine.js';
import type { ModelRecord, ModelInstance } from '@wazir/core';

export type ModelReadinessCategory =
  | 'LOCAL_LOADED'
  | 'LOCAL_INSTALLED_UNLOADED'
  | 'HOSTED_AVAILABLE'
  | 'HOSTED_UNAVAILABLE'
  | 'PROVIDER_ROUTING'
  | 'UNKNOWN';

export interface ClassifiedModelStatus {
  id: string;
  name: string;
  provider: string;
  local: boolean;
  category: ModelReadinessCategory;
  badge: string;
  ready: boolean;
  contextMax: number;
  toolCalling: boolean;
  reasoning: boolean;
  instances: Array<{
    runtimeId: string;
    computerId?: string;
    state?: string;
    health?: string;
    loaded?: boolean;
  }>;
  statusDetail: string;
}

const HOSTED_PROVIDER_IDS = new Set(['nvidia', 'anthropic', 'openai', 'google']);

/**
 * Classifies a model's operational readiness across local GPU memory, local disk (unloaded),
 * hosted cloud providers (including NVIDIA API Catalog), configured provider-only routing,
 * and unknown states.
 *
 * Crucial invariant: A hosted NVIDIA/cloud model must NEVER appear unavailable merely
 * because it is not resident in local GPU memory.
 */
export function classifyModelReadiness(
  model: ModelRecord & { displayName?: string; contextWindow?: number },
  instances: ModelInstance[],
  engine?: Partial<RookEngine>,
): ClassifiedModelStatus {
  const id = model.id;
  const name = model.name || model.displayName || model.id;
  const provider = model.provider || 'unknown';
  const isHostedProvider = HOSTED_PROVIDER_IDS.has(provider.toLowerCase()) || model.local === false;
  const isLocal = !isHostedProvider;
  const contextMax = model.contextMax ?? model.contextWindow ?? 32_768;
  const toolCalling = Boolean(model.toolCalling || model.capabilities?.includes('toolCalling' as any));
  const reasoning = Boolean(model.reasoning || model.capabilities?.includes('reasoning' as any));

  const modelInstances = instances.filter((i) => i.modelId === id);
  const runtime = engine?.runtimes?.get?.(provider);
  const discoveredRuntime = engine?.discovered?.find?.((d) => d.id === provider);
  const runtimeHealth = runtime?.health ?? discoveredRuntime?.health;

  let category: ModelReadinessCategory = 'UNKNOWN';
  let badge = color.gray('UNKNOWN');
  let ready = false;
  let statusDetail = 'Availability unknown';

  if (isLocal) {
    const loadedReady = modelInstances.some(
      (i) => i.loaded && (i.state === 'READY' || i.state === 'LOADED' || !i.state) && (i.health === 'healthy' || !i.health),
    );
    const anyLoaded = modelInstances.some((i) => i.loaded);
    if (loadedReady || anyLoaded) {
      category = 'LOCAL_LOADED';
      badge = color.green('READY (LOCAL GPU)');
      ready = true;
      const inst = modelInstances.find((i) => i.loaded) ?? modelInstances[0];
      statusDetail = inst
        ? `Loaded in GPU memory on ${inst.computerId ?? 'local'} (${inst.runtimeId})`
        : 'Loaded in local GPU memory';
    } else if (modelInstances.length > 0 || provider === 'local' || provider === 'ollama' || provider === 'lmstudio' || provider === 'vllm' || provider === 'mlx') {
      category = 'LOCAL_INSTALLED_UNLOADED';
      badge = color.yellow('INSTALLED (UNLOADED)');
      ready = false;
      statusDetail = 'Installed locally (on disk, unloaded from GPU memory)';
    } else {
      category = 'UNKNOWN';
      badge = color.gray('UNKNOWN');
      ready = false;
      statusDetail = 'Local runtime state unknown';
    }
  } else {
    // Hosted provider model (e.g., nvidia, anthropic, openai, google)
    const hasReadyInstance = modelInstances.some(
      (i) => (i.state === 'READY' || i.loaded) && i.health !== 'unavailable',
    );
    const hasUnavailableInstance = modelInstances.some(
      (i) => i.state === 'UNAVAILABLE' || i.health === 'unavailable',
    );
    const nvidiaDisabled =
      provider.toLowerCase() === 'nvidia' &&
      (engine?.config as any)?.providers?.nvidia?.enabled === false;
    const hasNvidiaEnvKey =
      provider.toLowerCase() === 'nvidia' &&
      Boolean(process.env.NVIDIA_API_KEY || (engine?.config as any)?.providers?.nvidia?.apiKey);

    if (nvidiaDisabled || hasUnavailableInstance || runtimeHealth === 'unavailable') {
      category = 'HOSTED_UNAVAILABLE';
      badge = color.red('UNAVAILABLE (HOSTED)');
      ready = false;
      statusDetail = nvidiaDisabled
        ? `Hosted provider ${provider} disabled in config`
        : `Hosted provider ${provider} unavailable or unauthenticated`;
    } else if (hasReadyInstance || runtimeHealth === 'healthy' || hasNvidiaEnvKey) {
      category = 'HOSTED_AVAILABLE';
      badge = color.green('AVAILABLE (HOSTED)');
      ready = true;
      statusDetail = `Hosted via ${provider.toUpperCase()} API (cloud endpoint ready, no local VRAM required)`;
    } else if (runtime || (engine?.config as any)?.providers?.[provider]) {
      category = 'PROVIDER_ROUTING';
      badge = color.cyan('PROVIDER ROUTING');
      ready = true;
      statusDetail = `Configured provider-only routing via ${provider}`;
    } else if (modelInstances.length === 0 && !runtime) {
      // Registered in ModelRegistry directly as a hosted provider model without explicit runtime health
      category = 'HOSTED_AVAILABLE';
      badge = color.green('AVAILABLE (HOSTED)');
      ready = true;
      statusDetail = `Hosted model registered for ${provider} routing`;
    } else {
      category = 'UNKNOWN';
      badge = color.gray('UNKNOWN');
      ready = false;
      statusDetail = `Hosted provider ${provider} status unknown`;
    }
  }

  return {
    id,
    name,
    provider,
    local: isLocal,
    category,
    badge,
    ready,
    contextMax,
    toolCalling,
    reasoning,
    instances: modelInstances.map((i) => ({
      runtimeId: i.runtimeId,
      computerId: i.computerId,
      state: i.state,
      health: i.health,
      loaded: i.loaded,
    })),
    statusDetail,
  };
}

export interface MissionSnapshot {
  workspace: string;
  version?: string;
  activeContext?: string;
  routingPolicy?: string;
  agents: number;
  running: number;
  ready: number;
  installed: number;
  computers: number;
  fleetNodes?: Array<{ id: string; gpu?: string; health?: string }>;
  jobs: Array<{ id: string; title: string; status: string }>;
  models: Array<{
    id?: string;
    name: string;
    provider: string;
    ready: boolean;
    category?: ModelReadinessCategory;
    badge?: string;
    local?: boolean;
  }>;
  runtimes: Array<{ name: string; health: string; kind?: string }>;
  approvals: number;
  inputTokens: number;
  outputTokens: number;
  events: Array<{ time: string; kind: string; text: string }>;
  evidence: string[];
}

export interface MissionHeaderOptions {
  version?: string;
  computers?: number;
  agents?: number;
  activeAgents?: number;
  concurrencyLimit?: number;
  readyModels?: number;
  installedModels?: number;
  selectedModelId?: string;
  activeContext?: string;
  approvals?: number;
  infraHealthy?: boolean;
}

/** Read-only projection. No sample workers, guessed prices, or synthetic verification. */
export function renderMissionControl(s: MissionSnapshot, width: number, height: number): string[] {
  const lines: string[] = [];
  const dense = height < 23;
  const section = (title: string) => color.bold(color.cyan(`  ${title}`));
  const caps = detectTerminalCapabilities({ columns: width });
  const fullLogo = width >= 76 && height >= 38;
  if (fullLogo) {
    const logo = renderUnicodeMediumLogo(caps.colorMode).split('\n');
    const intro = [
      color.bold('MISSION CONTROL'),
      'Autonomous Agent Orchestration',
      '',
      `${s.running} executing / ${s.agents} agents registered`,
      `${s.ready} ready / ${s.installed} models discovered`,
      `${s.computers} computers / ${s.runtimes.length} runtimes`,
      s.approvals ? color.yellow(`${s.approvals} approvals need review → Tab`) : color.green('Approval queue clear'),
      s.routingPolicy ? `Routing: ${s.routingPolicy}` : '',
      'Enter a task below to start.',
      '!command runs in this workspace.',
      'Tab views · 5 models · 6 evidence',
    ];
    logo.forEach((line, i) =>
      lines.push(
        line +
          ' '.repeat(Math.max(1, 38 - line.replace(/\x1b\[[0-9;]*m/g, '').length)) +
          (intro[i] ?? ''),
      ),
    );
  } else {
    lines.push(`  ${renderCompactLogo({ colorMode: caps.colorMode, unicode: caps.unicode, maxWidth: width })}`);
    lines.push(
      width >= 72
        ? `  ${s.running} executing · ${s.ready} READY / ${s.installed} MODELS · ${s.ready}/${s.installed} models ready · ${s.approvals} approvals`
        : `  ${s.running} executing · ${s.ready}/${s.installed} models ready · ${s.approvals} approvals`,
    );
  }
  if (s.fleetNodes?.length) {
    lines.push(`  models:shards:Health °C█Cap:Avail:RAM:GB ${s.fleetNodes.map((n) => `${n.id} ${n.gpu ?? 'CPU'}`).join('|')}`);
  }
  if (!dense) lines.push('');
  lines.push(section('EXECUTION MONITOR'));
  if (!s.jobs.length) lines.push('  No jobs yet. Describe a task in the prompt.');
  for (const job of s.jobs.slice(0, dense ? 1 : 3)) {
    const status = job.status.toUpperCase();
    const badge = /FAIL|ERROR/.test(status)
      ? color.red(status)
      : /COMPLETE/.test(status)
        ? color.green(status)
        : color.cyan(status);
    lines.push(`  ${badge}  ${job.title}  ${color.gray(job.id)}`);
  }
  if (!dense) lines.push(color.gray('  ↑↓ select · Enter inspect · [ / ] cycle tasks · Enter full output'));
  if (!dense) lines.push('');
  lines.push(section('MODELS & PROVIDERS'));
  const modelLimit = dense ? 1 : 3;
  if (!s.models.length) lines.push(color.yellow('  No models discovered. /refresh or /model to configure.'));
  for (const m of s.models.slice(0, modelLimit)) {
    const readinessLabel = m.badge
      ? `${m.ready ? color.green('READY') : color.yellow('NOT READY')} [${m.badge}]`
      : m.ready
        ? color.green('READY')
        : color.yellow('NOT READY');
    lines.push(`  ${readinessLabel}  ${m.name}  ${color.gray(m.provider)}`);
  }
  if (s.models.length > modelLimit) {
    lines.push(color.gray(`  +${s.models.length - modelLimit} models · 5 opens model intelligence`));
  }
  for (const r of s.runtimes.slice(0, dense ? 0 : 2)) {
    lines.push(`  ${r.name} · ${r.health === 'healthy' ? color.green(r.health) : color.yellow(r.health)}`);
  }
  lines.push(
    `  Session tokens ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out · Cost: unreported`,
  );
  if (!dense) lines.push('');
  lines.push(section('ACTIVITY & TOOL CALLS'));
  if (!s.events.length) lines.push(color.gray('  Waiting for execution events. Tab opens the live timeline.'));
  for (const e of s.events.slice(dense ? -1 : -3)) {
    lines.push(`  ${e.time} ${color.cyan(e.kind.toUpperCase())} ${e.text}`);
  }
  if (!dense) lines.push('');
  lines.push(section('VERIFICATION EVIDENCE'));
  lines.push(
    ...(s.evidence.length
      ? s.evidence.map((e) => `  ${e}`)
      : [color.gray('  No verification recorded. 6 opens checks and provenance.')]),
  );
  // Keep the operational sections reachable on short terminals instead of letting
  // a decorative logo consume the content viewport.
  return lines.slice(0, height);
}

export function missionHeader(
  workspace: string,
  view: string,
  width: number,
  opts: MissionHeaderOptions = {},
): string[] {
  const compCount = opts.computers ?? 0;
  const agentCount = opts.agents ?? 0;
  const activeCount = opts.activeAgents ?? 0;
  const limit = opts.concurrencyLimit ?? 4;
  const readyCount = opts.readyModels ?? 0;
  const installedCount = opts.installedModels ?? 0;
  const ver = opts.version ? ` v${opts.version.replace(/^v/, '')}` : '';
  const routingTag = opts.selectedModelId ? `Model: ${opts.selectedModelId}` : 'Model: auto';
  const contextTag = opts.activeContext ? `Ctx: ${opts.activeContext}` : 'Ctx: idle';
  const workerStatus = activeCount >= limit ? color.yellow('BUSY') : color.green('AVAILABLE');
  const readyTag = readyCount > 0 ? color.green(`${readyCount} READY`) : color.yellow('0 READY');
  const modelSummary = `${readyTag} / ${installedCount} MODELS`;
  const approvalAlert =
    opts.approvals && opts.approvals > 0 ? color.bold(color.yellow(` [! ${opts.approvals} APPROVALS]`)) : '';

  const logo = renderCompactLogo({ maxWidth: 20, colorMode: detectTerminalCapabilities().colorMode });
  const line1 =
    width >= 88
      ? ` ${logo}  ${color.bold('MISSION CONTROL')}${color.gray(ver)} · ${color.bold('WAZIR - CONTROL - WORKER:')} ${compCount} COMPUTERS ${agentCount} AGENTS ${modelSummary} · Agents ${activeCount}/${limit} - ${workerStatus}${approvalAlert}`
      : ` ${logo}  ${color.bold('MISSION CONTROL')}${color.gray(ver)} · ${readyTag} / ${installedCount} MODELS${approvalAlert}`;

  const wsMax = Math.max(12, width - 48);
  const wsFormatted = formatWorkspacePath(workspace, wsMax);
  const line2 =
    width >= 76
      ? ` ${wsFormatted}  ${color.cyan(`[View: ${view.toUpperCase()}]`)}  ${color.magenta(routingTag)}  ${color.gray(contextTag)}`
      : ` ${wsFormatted}  ${color.cyan(`[View: ${view.toUpperCase()}]`)}`;

  const line3 = color.gray(
    ' 1 Home   Tab Views   5 Models   6 Evidence   7/g Goals   [ / ] Tasks   / Filter   ? Help',
  );

  const clamp = (str: string): string => {
    if (stringDisplayWidth(str) <= width) return str;
    return truncateToDisplayWidth(str, Math.max(1, width), '');
  };

  return [clamp(line1), clamp(line2), clamp(line3)];
}
