import { MCPRegistry } from '@wazir/core';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AgentRegistry,
  governAdapter,
  ApprovalQueue,
  ComputerRegistry,
  ContextCompiler,
  ContextCompactionService,
  ContextRevisionService,
  PromptLayoutPlanner,
  OffloadStore,
  ExecutionEngine,
  persistExecutionRecord,
  ProvenanceManager,
  Job,
  JobManager,
  RecoveryManager,
  JobOrchestrator,
  ModelRegistry,
  ModelLifecycleService,
  HealthEvidenceLog,
  ModelReliabilityTracker,
  measureModelPerformance,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  WorktreeManager,
  CheckpointService,
  SolutionSearchService,
  TaskPlanner,
  createTaskPlanner,
  estimateModelMemory,
  TaskCapabilityClassifier,
  ModelIntelligenceService,
  FleetMemoryService,
  createFleetMemoryService,
  HandoffService,
  ModelPreferenceService,
  ModelDiscoveryStatusService,
  IntelligentModelRanker,
  HardwareEligibilityService,
  ContextMemoryEstimator,
  MetaHarnessService,
  type StructuredModelFleetStatus,
  type ModelPreferenceRecord,
  WorkloadDistributor,
  DEFAULT_HARDWARE_DISTRIBUTION,
  parseWorkloadDistribution,
} from '@wazir/core';
import type {
  ComputerRegistration,
  GPUInfo,
  ModelCapability,
  ModelLifecycleState,
  ModelRecord,
  RuntimeType,
} from '@wazir/core';
import type { DiscoveredModel, ProviderId } from '@wazir/runtimes-interfaces';
import {
  appendAuditEvent,
  MemoryStore,
  JsonFileStore,
  isExecutableOnPath,
  resolveExecutable,
  getSpawnCommand,
  type KeyValueStore,
} from '@wazir/shared';
import { ToolRegistry, defaultTools, createWebTools, createFleetMemoryTools } from '@wazir/tools';
import { localOutcomeInspector, reconcileLocalOutcomes } from './recovery.js';
import { createConfiguredWeb, primeCoreWebModule } from './web.js';
import * as coreModule from '@wazir/core';
import { globalStartupProfiler } from './startupProfiler.js';
import { AcpAgentAdapter, ChatAgent, createCodingAgent, createStepAgent, ExternalAgentAdapter, parseAcpPermissionMode } from '@wazir/agents';
import { createMLXAdapter, MLX_DEFAULT_BASE_URL } from '@wazir/runtimes-mlx';
import { createOllamaAdapter } from '@wazir/runtimes-ollama';
import { createLMStudioAdapter } from '@wazir/runtimes-lmstudio';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import { createSecretBroker, type SecretBroker } from '@wazir/secrets';
import {
  Worker,
  currentLoad,
  discoverDetailedLocalHost,
  discoverAuthorizedSshHost,
  type DiscoveredRuntime,
} from '@wazir/workers';
import { startLocalHeartbeat } from './localHeartbeat.js';
import { configDir, loadConfig, buildNvidiaHostedLimits, type FleetHostConfig, type WazirConfig } from './config.js';
import { applyHostedProvider, createHostedProviders, type HostedAdapter } from './hostedProviders.js';
import { syncRemoteInventory } from './remoteInventory.js';
import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { createResourceSystem, type ResourceSystem } from './resources.js';
import path from 'node:path';

import { EvaluationService, BenchmarkService, MetaOptimizerService } from '@wazir/evaluation';
import { VerificationEngine } from '@wazir/core';

export type EngineProfile = 'minimal' | 'interactive' | 'full';

export interface EngineOptions {
  profile?: EngineProfile;
  /** Override local hardware/runtime probing, including opting in for a minimal profile. */
  skipRuntimeDiscovery?: boolean;
  projectRoot?: string;
  quiet?: boolean;
  readOnlyLifecycle?: boolean;
  /** Skip background daemon intervals and redundant live model probes during one-shot CLI commands. */
  fastStartup?: boolean;
  /** How long an unanswered policy approval waits before it is denied (default 5 minutes). */
  approvalTimeoutMs?: number;
  /** Opt in to honouring `WAZIR_AUTO_APPROVE=1`; never on by default. */
  allowEnvAutoApprove?: boolean;
  /** Optional weighted hardware/agent distribution spec (e.g. "local:70,antigravity:15,codex:5"). */
  distributionSpec?: string;
}

export function resolveEngineProfile(options: EngineOptions): EngineProfile {
  return options.profile ?? (options.fastStartup && options.readOnlyLifecycle ? 'minimal' : 'full');
}

/** Cache successful construction while keeping service access synchronous. */
function memoizeService<T>(create: () => T): () => T {
  let value: T;
  let initialized = false;
  return () => {
    if (!initialized) {
      value = create();
      initialized = true;
    }
    return value;
  };
}

export interface RookEngine {
  config: WazirConfig;
  /** Accounts, token budgets, ledger and resource-aware routing. */
  resources: ResourceSystem;
  projectRoot: string;
  configDir: string;
  computers: ComputerRegistry;
  runtimes: RuntimeRegistry;
  models: ModelRegistry;
  lifecycle: ModelLifecycleService;
  /** Advisory evidence for runtime/model health diagnostics (see `wa health`). */
  health: HealthEvidenceLog;
  agents: AgentRegistry;
  tools: ToolRegistry;
  mcp: MCPRegistry;
  web?: import('@wazir/core').WebGroundingService;
  policy: PolicyEngine;
  scheduler: Scheduler;
  /** Per-(model, task class) circuit breaker, rebuilt from `termination.completed` events at startup. */
  reliability?: ModelReliabilityTracker;
  compiler: ContextCompiler;
  compaction?: ContextCompactionService;
  revision?: ContextRevisionService;
  layoutPlanner?: PromptLayoutPlanner;
  offloadStore?: OffloadStore;
  executions: ExecutionEngine & { store?: KeyValueStore };
  provenance: ProvenanceManager;
  approvalQueue: ApprovalQueue;
  orchestrator: JobOrchestrator & { store?: KeyValueStore };
  worktrees: WorktreeManager;
  checkpoints: CheckpointService;
  solutionSearch?: SolutionSearchService;
  evaluation?: EvaluationService;
  benchmark?: BenchmarkService;
  optimizer?: MetaOptimizerService;
  modelIntelligence?: ModelIntelligenceService;
  verification?: VerificationEngine;
  planner: TaskPlanner;
  adapters: Map<string, RuntimeAdapter>;
  discovered: DiscoveredRuntime[];
  worker: Worker;
  store: KeyValueStore;
  fleetMemory: FleetMemoryService;
  handoffs: HandoffService;
  secretBroker: SecretBroker;
  hostedAdapters: Map<ProviderId, HostedAdapter>;
  modelPreferences?: ModelPreferenceService;
  modelDiscoveryStatus?: ModelDiscoveryStatusService;
  modelRanker?: IntelligentModelRanker;
  hardwareEligibility?: HardwareEligibilityService;
  contextEstimator?: ContextMemoryEstimator;
  metaHarness?: MetaHarnessService;
  workloadDistributor?: WorkloadDistributor;
  isBootstrapping?: boolean;
}

function guessFamily(id: string, provider: string): ModelRecord['family'] {
  const lower = id.toLowerCase();
  if (lower.includes('qwen')) return 'qwen';
  if (lower.includes('gpt')) return 'gpt';
  if (lower.includes('gemma')) return 'gemma';
  if (lower.includes('nemotron')) return 'nemotron';
  if (lower.includes('llama')) return 'llama';
  if (lower.includes('mistral') || lower.includes('mixtral')) return 'mistral';
  if (lower.includes('granite')) return 'granite';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('phi')) return 'phi';
  return provider === 'ollama' ? 'qwen' : 'other';
}

const DEFAULT_CONTEXT = 32_768;
const execFileAsync = promisify(execFile);

let cachedPathEnv: string | undefined;
const onPathCache = new Map<string, boolean>();
const resolvedExecutableCache = new Map<string, string | null>();
let cachedAcpSpecs: Array<{ name: string; description: string; requires: string; command: string; args: string[]; initTimeoutMs?: number }> | undefined;

function ensurePathCacheCurrent(): void {
  const currentPath = process.env.PATH ?? '';
  if (cachedPathEnv !== currentPath) {
    cachedPathEnv = currentPath;
    onPathCache.clear();
    resolvedExecutableCache.clear();
    cachedAcpSpecs = undefined;
  }
}

function cachedResolveExecutable(bin: string): string | null {
  ensurePathCacheCurrent();
  if (resolvedExecutableCache.has(bin)) {
    return resolvedExecutableCache.get(bin)!;
  }
  const resolved = resolveExecutable(bin);
  resolvedExecutableCache.set(bin, resolved);
  return resolved;
}

/** True when `bin` is an executable on PATH. A lookup, not a launch: startup stays fast. */
function onPath(bin: string): boolean {
  ensurePathCacheCurrent();
  if (onPathCache.has(bin)) {
    return onPathCache.get(bin)!;
  }
  const found = isExecutableOnPath(bin);
  onPathCache.set(bin, found);
  return found;
}

/**
 * External coding agents reachable over the Agent Client Protocol. `requires` is the CLI that
 * must be installed (and signed in) for the agent to work; Claude Code speaks ACP through
 * Zed's pinned adapter, while Codex runs natively via `codex exec` so model updates in the
 * installed `codex` CLI work without waiting on third-party bridge releases.
 */
function acpAgentSpecs(): Array<{ name: string; description: string; requires: string; command: string; args: string[]; initTimeoutMs?: number }> {
  ensurePathCacheCurrent();
  if (cachedAcpSpecs) return cachedAcpSpecs;
  const npx = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const npxCommand = cachedResolveExecutable('npx') ?? (existsSync(npx) ? npx : 'npx');
  cachedAcpSpecs = [
    { name: 'claude-code', description: 'Claude Code over ACP (@zed-industries/claude-code-acp)', requires: 'claude',
      command: npxCommand, args: ['-y', '@zed-industries/claude-code-acp@0.16.2'], initTimeoutMs: 180_000 },
    { name: 'qwen-code', description: 'Qwen Code over ACP', requires: 'qwen', command: 'qwen', args: ['--acp'] },
    { name: 'gemini', description: 'Gemini CLI over ACP', requires: 'gemini', command: 'gemini', args: ['--acp'] },
  ];
  return cachedAcpSpecs;
}

function isLoopbackHttpUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '::1' || h.startsWith('127.');
  } catch {
    return false;
  }
}

function isGeminiCliConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WAZIR_ENABLE_GEMINI_ACP === '1') return true;
  if (env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || env.GOOGLE_GENAI_USE_VERTEXAI?.trim()) {
    return true;
  }
  const geminiDir = path.join(os.homedir(), '.gemini');
  try {
    if (existsSync(path.join(geminiDir, 'oauth_creds.json'))) return true;
    const dotEnv = path.join(geminiDir, '.env');
    if (existsSync(dotEnv)) {
      const text = readFileSync(dotEnv, 'utf8');
      if (/^\s*(GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*\S+/m.test(text)) return true;
    }
    const settingsFile = path.join(geminiDir, 'settings.json');
    if (existsSync(settingsFile)) {
      const parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, any>;
      const selected = parsed?.security?.auth?.selectedType ?? parsed?.authType;
      if (typeof selected === 'string' && selected.trim().length > 0) return true;
      if (parsed?.security?.auth?.useExternal === true) return true;
    }
  } catch {
    // Unreadable config is treated as unconfigured rather than crashing startup.
  }
  return false;
}

function pickLiveLocalModel(
  discovered: DiscoveredRuntime[],
  models: ModelRegistry,
  preferredRuntimeId?: string,
): { modelId: string; baseUrl: string; runtimeId: string } | undefined {
  const candidates = discovered.filter(
    (d) => d.health === 'healthy' && (d.id === 'lmstudio' || d.id === 'ollama'),
  );
  if (preferredRuntimeId) {
    candidates.sort((a, b) => (a.id === preferredRuntimeId ? -1 : b.id === preferredRuntimeId ? 1 : 0));
  }
  const instances = models.listInstances();
  for (const rt of candidates) {
    const generative = rt.models.filter((m) => !/embed|nomic-embed|bge-/i.test(m.id));
    if (generative.length === 0) continue;
    const loadedReady = generative.find((m) =>
      instances.some((inst) => inst.runtimeId === rt.id && inst.modelId === m.id && inst.loaded && inst.health === 'healthy'),
    );
    const qwenCandidate = generative.find((m) => /qwen/i.test(m.id));
    const chosen = loadedReady ?? qwenCandidate ?? generative[0]!;
    const rawUrl = rt.info.url ?? (rt.id === 'lmstudio' ? 'http://127.0.0.1:1234/v1' : 'http://127.0.0.1:11434/v1');
    const baseUrl = rawUrl.endsWith('/v1') ? rawUrl : `${rawUrl.replace(/\/+$/, '')}/v1`;
    return { modelId: chosen.id, baseUrl, runtimeId: rt.id };
  }
  return undefined;
}

function resolveQwenCodeLocalDefaults(
  discovered: DiscoveredRuntime[],
  models: ModelRegistry,
  env: NodeJS.ProcessEnv = process.env,
): { env?: Record<string, string>; modelId?: string } {
  if (env.QWEN_API_KEY?.trim() || env.DASHSCOPE_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()) {
    return {};
  }
  const qwenHome = env.QWEN_CODE_HOME || path.join(os.homedir(), '.qwen');
  const settingsFile = path.join(qwenHome, 'settings.json');
  try {
    if (!existsSync(settingsFile)) return {};
    const parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, any>;
    const selectedAuth = String(parsed?.security?.auth?.selectedType ?? parsed?.authType ?? '');
    if (selectedAuth && selectedAuth !== 'openai') return {};

    const declaredBaseUrl: string | undefined = parsed?.model?.baseUrl ?? parsed?.baseUrl;
    const openAiProviders: Array<Record<string, any>> = Array.isArray(parsed?.modelProviders?.openai)
      ? parsed.modelProviders.openai
      : [];
    const urls = [declaredBaseUrl, ...openAiProviders.map((p) => p?.baseUrl as string | undefined)].filter(Boolean) as string[];
    if (urls.length === 0 || !urls.every((u) => isLoopbackHttpUrl(u))) return {};

    const extraEnv: Record<string, string> = {};
    for (const providerEntry of openAiProviders) {
      const envKey = typeof providerEntry?.envKey === 'string' ? providerEntry.envKey.trim() : '';
      if (/^[A-Z][A-Z0-9_]{1,63}$/.test(envKey) && !env[envKey]?.trim()) {
        extraEnv[envKey] = 'lm-studio';
      }
    }
    if (!env.OPENAI_API_KEY?.trim()) {
      extraEnv.OPENAI_API_KEY = 'lm-studio';
    }

    const configuredModel = typeof parsed?.model?.name === 'string'
      ? parsed.model.name
      : typeof parsed?.model === 'string'
        ? parsed.model
        : undefined;
    const prefersLmStudio = urls.some((u) => u.includes(':1234'));
    const liveLocal = pickLiveLocalModel(discovered, models, prefersLmStudio ? 'lmstudio' : undefined);
    if (!liveLocal) {
      return Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {};
    }

    const runtimeHasConfigured = configuredModel
      ? discovered.some((d) => d.health === 'healthy' && d.models.some((m) => m.id === configuredModel))
      : false;
    if (!runtimeHasConfigured) {
      extraEnv.OPENAI_BASE_URL = liveLocal.baseUrl;
      return { env: extraEnv, modelId: liveLocal.modelId };
    }
    return Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {};
  } catch {
    return {};
  }
}

function resolveOpenCodeLocalEnv(
  discovered: DiscoveredRuntime[],
  models: ModelRegistry,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (env.OPENCODE_CONFIG_CONTENT?.trim()) return undefined;
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const configPath = path.join(xdgConfig, 'opencode', 'opencode.json');
  try {
    if (!existsSync(configPath)) return undefined;
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, any>;
    const declaredModel = typeof parsed?.model === 'string' ? parsed.model.trim() : '';
    if (!declaredModel.startsWith('lmstudio/')) return undefined;
    const lmstudioBaseUrl = parsed?.provider?.lmstudio?.options?.baseURL;
    if (lmstudioBaseUrl && !isLoopbackHttpUrl(lmstudioBaseUrl)) return undefined;
    const modelId = declaredModel.slice('lmstudio/'.length);
    const lmstudioRuntime = discovered.find((d) => d.id === 'lmstudio' && d.health === 'healthy');
    if (!lmstudioRuntime || lmstudioRuntime.models.some((m) => m.id === modelId)) return undefined;
    const live = pickLiveLocalModel([lmstudioRuntime], models, 'lmstudio');
    if (!live) return undefined;
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: `lmstudio/${live.modelId}`,
        small_model: `lmstudio/${live.modelId}`,
        provider: {
          lmstudio: {
            models: {
              [live.modelId]: { name: live.modelId, tool_call: true },
            },
          },
        },
      }),
    };
  } catch {
    return undefined;
  }
}

async function detectOpenCode(): Promise<boolean> {
  return Boolean(cachedResolveExecutable('opencode'));
}

export type FleetHostSpec = FleetHostConfig & {
  gpu?: Partial<GPUInfo> & { architecture?: string };
  unifiedMemory?: boolean;
  workerUrl?: string;
};

export function buildFleetHostHardware(hostSpec: FleetHostSpec): Pick<ComputerRegistration, 'type' | 'os' | 'hardware'> {
  const rawGpu = hostSpec.gpu;
  const descriptor = `${hostSpec.id} ${hostSpec.name ?? ''} ${hostSpec.cpu ?? ''} ${rawGpu?.model ?? ''}`;
  const isDgxOrGb10 = /dgx|gb10|grace/i.test(descriptor);
  const isAppleSilicon = /apple|m1|m2|m3|m4|mac/i.test(descriptor);
  const unifiedMemory =
    typeof rawGpu?.unifiedMemory === 'boolean'
      ? rawGpu.unifiedMemory
      : typeof hostSpec.unifiedMemory === 'boolean'
        ? hostSpec.unifiedMemory
        : isDgxOrGb10 || isAppleSilicon
          ? true
          : undefined;
  const memoryGB =
    typeof hostSpec.memoryGB === 'number' && Number.isFinite(hostSpec.memoryGB)
      ? hostSpec.memoryGB
      : isDgxOrGb10
        ? 128
        : 36;
  const vendor = rawGpu?.vendor ?? (isDgxOrGb10 ? 'nvidia' : isAppleSilicon ? 'apple' : 'unknown');
  const gpu =
    rawGpu || unifiedMemory !== undefined
      ? {
          vendor,
          model: rawGpu?.model ?? (isDgxOrGb10 ? 'NVIDIA GB10' : isAppleSilicon ? (hostSpec.cpu ?? 'Apple Silicon GPU') : 'Unknown GPU'),
          memoryGB: typeof rawGpu?.memoryGB === 'number' && Number.isFinite(rawGpu.memoryGB) ? rawGpu.memoryGB : memoryGB,
          ...(unifiedMemory !== undefined ? { unifiedMemory } : {}),
          ...(typeof rawGpu?.cuda === 'boolean' ? { cuda: rawGpu.cuda } : vendor === 'nvidia' ? { cuda: true } : {}),
          ...(rawGpu?.architecture ? { architecture: rawGpu.architecture } : {}),
        }
      : undefined;

  return {
    type: hostSpec.type ?? (isDgxOrGb10 ? 'server' : 'workstation'),
    os: {
      platform: hostSpec.platform ?? (isDgxOrGb10 ? 'linux' : 'darwin'),
      architecture: hostSpec.architecture ?? 'arm64',
      version: 'fleet',
    },
    hardware: {
      cpu: hostSpec.cpu ?? (isDgxOrGb10 ? 'NVIDIA Grace' : 'Apple Silicon'),
      cpuCores: hostSpec.cpuCores ?? (isDgxOrGb10 ? 20 : 14),
      memoryGB,
      ...(gpu ? { gpu: gpu as GPUInfo } : {}),
    },
  };
}

async function fetchJsonWithTimeout(url: string, headers?: Record<string, string>): Promise<Record<string, any> | undefined> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return undefined;
    const data = await res.json();
    return data && typeof data === 'object' ? (data as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

export async function refreshRemoteHostTelemetry(
  computers: ComputerRegistry,
  hostId: string,
  hostSpec: FleetHostSpec,
  hostAdapters: RuntimeAdapter[] = [],
  apiConfig?: { apiUrl?: string; apiToken?: string },
): Promise<boolean> {
  const comp = computers.get(hostId);
  if (!comp || comp.local) return false;

  if (hostSpec.workerUrl) {
    const base = hostSpec.workerUrl.replace(/\/+$/, '');
    for (const pathSuffix of ['/telemetry', '/health']) {
      const payload = await fetchJsonWithTimeout(`${base}${pathSuffix}`);
      const loadObj = (payload?.load ?? payload) as Record<string, any> | undefined;
      const availGB =
        typeof loadObj?.memoryAvailableGB === 'number' && Number.isFinite(loadObj.memoryAvailableGB)
          ? loadObj.memoryAvailableGB
          : typeof payload?.memory?.availableBytes === 'number' && Number.isFinite(payload.memory.availableBytes)
            ? payload.memory.availableBytes / 1024 ** 3
            : undefined;
      if (availGB !== undefined) {
        const totalGB = comp.hardware.memoryGB > 0 ? comp.hardware.memoryGB : 0;
        const usedGB =
          typeof loadObj?.memoryUsedGB === 'number' && Number.isFinite(loadObj.memoryUsedGB)
            ? loadObj.memoryUsedGB
            : totalGB > 0
              ? Math.max(0, totalGB - availGB)
              : 0;
        computers.heartbeat(hostId, {
          load: {
            cpuPercent: typeof loadObj?.cpuPercent === 'number' && Number.isFinite(loadObj.cpuPercent) ? loadObj.cpuPercent : 0,
            memoryUsedGB: usedGB,
            memoryAvailableGB: availGB,
            ...(typeof loadObj?.gpuUtilizationPercent === 'number' ? { gpuUtilizationPercent: loadObj.gpuUtilizationPercent } : {}),
          },
          telemetryTimestamp: payload?.observedAt ? new Date(String(payload.observedAt)) : new Date(),
          telemetrySource: `worker:${pathSuffix}`,
        });
        return true;
      }
    }
  }

  if (apiConfig?.apiUrl) {
    const base = apiConfig.apiUrl.replace(/\/+$/, '');
    const headers = apiConfig.apiToken ? { Authorization: `Bearer ${apiConfig.apiToken}` } : undefined;
    const remoteComp = await fetchJsonWithTimeout(`${base}/api/computers/${encodeURIComponent(hostId)}`, headers);
    const remoteLoad = remoteComp?.load as Record<string, any> | undefined;
    if (remoteLoad && typeof remoteLoad.memoryAvailableGB === 'number' && Number.isFinite(remoteLoad.memoryAvailableGB)) {
      computers.heartbeat(hostId, {
        load: {
          cpuPercent: typeof remoteLoad.cpuPercent === 'number' ? remoteLoad.cpuPercent : 0,
          memoryUsedGB: typeof remoteLoad.memoryUsedGB === 'number' ? remoteLoad.memoryUsedGB : 0,
          memoryAvailableGB: remoteLoad.memoryAvailableGB,
          ...(typeof remoteLoad.gpuUtilizationPercent === 'number' ? { gpuUtilizationPercent: remoteLoad.gpuUtilizationPercent } : {}),
        },
        telemetryTimestamp: remoteComp?.resourceObservedAt ? new Date(String(remoteComp.resourceObservedAt)) : new Date(),
        telemetrySource: 'control-plane:/api/computers',
      });
      return true;
    }
  }

  let residentBytes = 0;
  let probedSource: string | undefined;
  if (hostSpec.ollamaUrl) {
    const base = hostSpec.ollamaUrl.replace(/\/+$/, '');
    const ps = await fetchJsonWithTimeout(`${base}/api/ps`);
    if (ps && Array.isArray(ps.models)) {
      probedSource = 'ollama:/api/ps';
      for (const m of ps.models as Array<Record<string, any>>) {
        const sz = typeof m.size === 'number' && Number.isFinite(m.size) ? m.size : (typeof m.size_vram === 'number' && Number.isFinite(m.size_vram) ? m.size_vram : 0);
        residentBytes += Math.max(0, sz);
      }
    }
  } else if (hostSpec.lmstudioUrl) {
    const base = hostSpec.lmstudioUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const data = await fetchJsonWithTimeout(`${base}/api/v0/models`);
    if (data && Array.isArray(data.data)) {
      probedSource = 'lmstudio:/api/v0/models';
      for (const m of data.data as Array<Record<string, any>>) {
        if (m.state === 'loaded') {
          const sz = typeof m.size_bytes === 'number' ? m.size_bytes : (typeof m.memory_bytes === 'number' ? m.memory_bytes : 0);
          residentBytes += Math.max(0, sz);
        }
      }
    }
  } else if (hostAdapters.length > 0) {
    for (const adapter of hostAdapters) {
      try {
        const listed = await adapter.listModels();
        probedSource = `adapter:${adapter.type}`;
        for (const m of listed) {
          const inspected = await adapter.inspectModel?.(m.id).catch(() => undefined);
          if (inspected?.loaded && typeof inspected.memoryBytes === 'number' && Number.isFinite(inspected.memoryBytes)) {
            residentBytes += Math.max(0, inspected.memoryBytes);
          }
        }
      } catch {
        // Ignore unreachable adapter
      }
    }
  }

  if (probedSource && comp.hardware.memoryGB > 0) {
    const residentGB = residentBytes / 1024 ** 3;
    const memoryUsedGB = Number(residentGB.toFixed(3));
    const memoryAvailableGB = Math.max(0, Number((comp.hardware.memoryGB - residentGB).toFixed(3)));
    computers.heartbeat(hostId, {
      load: {
        cpuPercent: comp.load?.cpuPercent ?? 0,
        memoryUsedGB,
        memoryAvailableGB,
      },
      telemetryTimestamp: new Date(),
      telemetrySource: probedSource,
    });
    return true;
  }

  return false;
}

export async function createEngine(options: EngineOptions = {}): Promise<RookEngine> {
  const profile = resolveEngineProfile(options);
  const skipRuntimeDiscovery = options.skipRuntimeDiscovery ?? (profile === 'minimal');
  globalStartupProfiler.mark('engine.start', options.fastStartup ? 'fastStartup' : 'full');
  const config = loadConfig();
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  globalStartupProfiler.mark('engine.config');

  // ---- registries -----------------------------------------------------
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();

  // ---- persistence ----------------------------------------------------
  // WAZIR_DATABASE_URL > WAZIR_IN_MEMORY=1 > the default local JSON file
  // store — first backend that's configured wins.
  const store: KeyValueStore = await createStore();
  const engineConfigDir = configDir();
  globalStartupProfiler.mark('engine.store');

  const provenance = new ProvenanceManager(store);
  const executions = new ExecutionEngine({
    provenanceManager: provenance,
    workspace: projectRoot,
    fastStartup: options.fastStartup,
    persist: (record) => persistExecutionRecord(store, `execution/${record.execution.id}`, record),
    load: async () => {
      const entries = await store.list('execution/');
      return entries.map((e) => e.value as never);
    },
  }) as any;
  executions.store = store; // Attach store for Block persistence

  // Fleet-shared durable memory: facts recorded by `remember_fact` are keyed by project
  // root and backed by the same KeyValueStore as everything else — any agent working in
  // the same project, on this machine or (with a shared PostgresStore) any other machine
  // in the fleet, can `recall_facts` them. See FleetMemoryService.
  const fleetMemory = createFleetMemoryService(store);
  for (const tool of createFleetMemoryTools(fleetMemory)) tools.register(tool);

  // ---- local computer + runtimes + models ------------------------------
  // Every model request passes resource admission and accounting: adapters are governed
  // once, here, so all call paths (CLI, TUI, fleet, worker lookups) share the same gate.
  const resources = createResourceSystem(engineConfigDir);
  const govern = (adapter: RuntimeAdapter) => governAdapter(adapter, { budget: resources.budget, resolveAccount: resources.resolveAccount });
  const adapterList: RuntimeAdapter[] = [
    createMLXAdapter(config.mlxUrl ?? MLX_DEFAULT_BASE_URL),
    createOllamaAdapter(config.ollamaUrl ?? 'http://localhost:11434'),
    createLMStudioAdapter(config.lmstudioUrl ?? 'http://localhost:1234/v1'),
  ].map(govern);

  // await executions.ready;

  // The worker owns discovery on this machine; the engine reads its results.
  const worker = new Worker({
    computerId: process.env.WAZIR_COMPUTER_ID ?? 'local',
    name: process.env.WAZIR_COMPUTER_NAME ?? os.hostname() ?? 'local',
    adapters: adapterList,
  });
  if (!skipRuntimeDiscovery) await worker.start();
  globalStartupProfiler.mark('engine.discovery');
  const discovered = worker.discovered;
  const adapterById = new Map(discovered.map((d) => [d.id, d.adapter]));
  // Do not access worker.hardwareReport here: its fallback performs full hardware discovery.
  const cpus = skipRuntimeDiscovery ? os.cpus() : [];
  const hardware = skipRuntimeDiscovery ? {
    os: { platform: process.platform, architecture: process.arch, version: process.version },
    hardware: { cpu: cpus[0]?.model ?? 'unknown', cpuCores: cpus.length, memoryGB: Math.max(1, Math.round(os.totalmem() / (1024 ** 3))) },
  } : worker.hardwareReport!;

  const localComputer: ComputerRegistration = {
    id: process.env.WAZIR_COMPUTER_ID ?? 'local',
    name: process.env.WAZIR_COMPUTER_NAME ?? os.hostname() ?? 'local',
    type: 'workstation',
    local: true,
    os: hardware.os,
    hardware: hardware.hardware,
    runtimes: worker.info.runtimes,
    models: worker.info.models,
    capabilities: ['localExecution'],
  };
  computers.register(localComputer);

  for (const discoveredRuntime of discovered) {
    await applyDiscoveredRuntime(discoveredRuntime, { runtimes, computers, models, config, computerId: localComputer.id });
  }

  // ---- direct fleet hardware hosts (e.g. Mac Studio, DGX Spark) ----------
  const onlineFleetHostIds: string[] = [];
  const fleetRuntimeIds: string[] = [];
  const fleetHostRefreshers = new Map<string, () => Promise<boolean>>();
  if (!skipRuntimeDiscovery && config.fleetHosts && config.fleetHosts.length > 0) {
    await Promise.all(
      config.fleetHosts.map(async (rawHostSpec) => {
        const hostSpec = rawHostSpec as FleetHostSpec;
        const hostId = hostSpec.id.trim();
        if (!hostId || hostId === localComputer.id) return;
        const hostAdapters: RuntimeAdapter[] = [];
        if (hostSpec.mlxUrl) {
          hostAdapters.push(govern(withRuntimeId(createMLXAdapter(hostSpec.mlxUrl), `${hostId}:mlx`)));
        }
        if (hostSpec.ollamaUrl) {
          hostAdapters.push(govern(withRuntimeId(createOllamaAdapter(hostSpec.ollamaUrl), `${hostId}:ollama`)));
        }
        if (hostSpec.lmstudioUrl) {
          hostAdapters.push(govern(withRuntimeId(createLMStudioAdapter(hostSpec.lmstudioUrl), `${hostId}:lmstudio`)));
        }
        if (hostAdapters.length === 0) return;

        const hostWorker = new Worker({
          computerId: hostId,
          name: hostSpec.name ?? hostId,
          adapters: hostAdapters,
        });
        await hostWorker.start();
        const reachableRuntimes = hostWorker.discovered.filter((d) => d.health !== 'unavailable');
        if (reachableRuntimes.length === 0) return;

        const hostHw = buildFleetHostHardware(hostSpec);
        computers.register({
          id: hostId,
          name: hostSpec.name ?? hostId,
          type: hostHw.type,
          local: false,
          os: hostHw.os,
          hardware: hostHw.hardware,
          runtimes: hostWorker.info.runtimes,
          models: hostWorker.info.models,
          capabilities: ['localExecution'],
        });
        const refreshHost = () =>
          refreshRemoteHostTelemetry(computers, hostId, hostSpec, hostAdapters, {
            apiUrl: config.apiUrl,
            apiToken: config.apiToken,
          });
        fleetHostRefreshers.set(hostId, refreshHost);
        await refreshHost().catch(() => false);
        onlineFleetHostIds.push(hostId);

        for (const hostRuntime of hostWorker.discovered) {
          discovered.push(hostRuntime);
          fleetRuntimeIds.push(hostRuntime.id);
          adapterById.set(hostRuntime.id, hostRuntime.adapter);
          await applyDiscoveredRuntime(hostRuntime, { runtimes, computers, models, config, computerId: hostId });
        }
      }),
    );
  }

  // ---- hosted providers (Anthropic/OpenAI/Google) ------------------------
  // Deliberately registered only into `runtimes`/`models`/`adapterById` —
  // NEVER into `computers` or `worker`. A hosted provider has no hardware to
  // model as a Computer; see Scheduler.scheduleComputer()'s hosted branch and
  // hostedProviders.ts's docstring for the invariant this depends on: nothing
  // that searches `worker.adapterForModel()` can ever reach a hosted adapter,
  // since the worker's own discovery list is strictly local/hardware-bound.
  const secretBroker = await getSharedSecretBroker(engineConfigDir);
  const hostedAdapters = createHostedProviders(config, secretBroker, { fastStartup: options.fastStartup });
  for (const [id, rawAdapter] of hostedAdapters) {
    const adapter = govern(rawAdapter);
    adapterById.set(id, adapter);
    await applyHostedProvider(id, rawAdapter, { runtimes, models, config });
  }

  // ---- remote inventory (optional distributed mode) ---------------------
  // Without this, the Scheduler can only ever see the computer this CLI
  // invocation is running on. When a control-plane API is configured, pull
  // its known computers/runtimes/models/instances in so a task can be placed
  // on — and later dispatched to — a remote machine.
  if (config.apiUrl) {
    const sync = await syncRemoteInventory(config.apiUrl, localComputer.id, { computers, runtimes, models }, { token: config.apiToken });
    if (sync.errors.length > 0 && !options.quiet) {
      console.error(`[wazir] remote inventory sync from ${config.apiUrl} had errors:`);
      for (const error of sync.errors) console.error(`  - ${error}`);
    }
  }

  // ---- agents -----------------------------------------------------------
  agents.register(createCodingAgent({ webCapabilities: config.web?.enabled ? ['web.search', 'web.fetch'] : [] }), 'native');
  agents.register(new ChatAgent(), 'native');
  agents.register(createStepAgent(), 'native');

  // OpenCode is an optional external execution provider: Wazir still owns
  // scheduling, policy, and history — OpenCode only supplies the reasoning
  // loop for a task that explicitly asks for it (`wa task run --agent
  // opencode` / `wa ask --agent opencode`). `taskTypes: []` means it is
  // never auto-selected by `AgentRegistry.resolveForTask`, so installing the
  // `opencode` binary can't silently change where an un-pinned task lands.
  // Only registered when the binary is actually reachable, mirroring how
  // Ollama/LM Studio runtimes are auto-discovered rather than assumed.
  if (await detectOpenCode()) {
    const openCodeEnv = resolveOpenCodeLocalEnv(discovered, models);
    agents.register(
      new ExternalAgentAdapter({
        name: 'opencode',
        version: 'external',
        description: 'OpenCode terminal coding agent, invoked as an external process',
        command: 'opencode',
        args: ['run', '--standalone', '--title', 'wazir'],
        ...(openCodeEnv ? { env: openCodeEnv } : {}),
        taskTypes: [],
        capabilities: ['coding'],
      }),
      'external',
    );
  }

  // ACP delegation (Claude Code, Qwen Code, Gemini CLI). Same contract as OpenCode:
  // registered only when the CLI is installed and selected only with `--agent <name>`.
  // Wazir answers every permission request the agent makes, under WAZIR_ACP_PERMISSIONS
  // (read | edit | full; default edit, which never allows shell commands).
  const acpPermissionMode = parseAcpPermissionMode(process.env.WAZIR_ACP_PERMISSIONS);
  const qwenLocalDefaults = onPath('qwen') ? resolveQwenCodeLocalDefaults(discovered, models) : {};
  for (const spec of acpAgentSpecs()) {
    if (!onPath(spec.requires) || agents.get(spec.name)) continue;
    if (spec.name === 'gemini' && !isGeminiCliConfigured()) continue;
    const extra = spec.name === 'qwen-code' ? qwenLocalDefaults : {};
    agents.register(
      new AcpAgentAdapter({
        ...spec,
        ...(extra.env ? { env: extra.env } : {}),
        ...(extra.modelId ? { modelId: extra.modelId } : {}),
        permissionMode: acpPermissionMode,
      }),
      'external',
    );
  }

  // Codex runs directly through `codex exec` on the user's installed `codex` CLI so newer
  // account models work immediately without waiting on third-party ACP bridge releases.
  const codexExecArgs = acpPermissionMode === 'read'
    ? ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never']
    : acpPermissionMode === 'full'
      ? ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral', '--color', 'never']
      : ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--color', 'never'];
  if (onPath('codex') && !agents.get('codex')) {
    agents.register(
      new ExternalAgentAdapter({
        name: 'codex',
        version: 'external',
        description: 'OpenAI Codex CLI (codex exec), headless non-interactive mode',
        command: 'codex',
        args: codexExecArgs,
        modelFlag: '--model',
        taskTypes: [],
        capabilities: ['coding'],
      }),
      'external',
    );
  }

  // Additional subscription logins: a configured subscription account may name an agent
  // instance like `claude-code@work`, with env selecting that login (CLAUDE_CONFIG_DIR,
  // CODEX_HOME, ...). Each instance is its own agent, so its usage is accounted separately.
  for (const account of resources.accounts.list().filter((a) => a.kind === 'subscription' && a.enabled !== false)) {
    for (const instance of account.agents ?? []) {
      const [base] = instance.split('@');
      if (!instance.includes('@') || agents.get(instance)) continue;
      if (base === 'codex' && onPath('codex')) {
        agents.register(
          new ExternalAgentAdapter({
            name: instance,
            version: 'external',
            description: `OpenAI Codex CLI (codex exec) — account ${account.id}`,
            command: 'codex',
            args: codexExecArgs,
            modelFlag: '--model',
            env: account.env,
            taskTypes: [],
            capabilities: ['coding'],
          }),
          'external',
        );
        continue;
      }
      const spec = acpAgentSpecs().find((s) => s.name === base);
      if (!spec || !onPath(spec.requires)) continue;
      agents.register(new AcpAgentAdapter({ ...spec, name: instance, description: `${spec.description} — account ${account.id}`, env: account.env, permissionMode: acpPermissionMode }), 'external');
    }
  }

  // Antigravity (`agy`) has no ACP mode, so it runs as a headless external process and its
  // own permission model applies. WAZIR_ACP_PERMISSIONS maps onto its flags: `read` plans
  // only, `edit` (default) accepts edits with headless command requests auto-denied
  // (--sandbox), `full` auto-approves every tool.
  if (onPath('agy') && !agents.get('antigravity')) {
    const agyMode = acpPermissionMode === 'read' ? ['--sandbox', '--mode', 'plan']
      : acpPermissionMode === 'full' ? ['--mode', 'accept-edits', '--dangerously-skip-permissions']
        : ['--sandbox', '--mode', 'accept-edits'];
    agents.register(
      new ExternalAgentAdapter({
        name: 'antigravity',
        version: 'external',
        description: 'Google Antigravity CLI (agy), headless print mode',
        command: 'agy',
        args: [...agyMode, '--output-format', 'text', '-p'],
        modelFlag: '--model',
        taskTypes: [],
        capabilities: ['coding'],
      }),
      'external',
    );
  }

  // ---- approval queue & policy -------------------------------------------
  // Questions nobody answers are denied after a bounded wait, and
  // `WAZIR_AUTO_APPROVE` is only honoured when the caller explicitly opts in.
  const approvalQueue = new ApprovalQueue({
    defaultTimeoutMs: options.approvalTimeoutMs ?? 5 * 60_000,
    allowEnvAutoApprove: options.allowEnvAutoApprove ?? false,
  });
  const hostedAuthorizedDefault = Boolean(
    config.providers?.allowHostedProviders ||
    config.providers?.nvidia?.privacy?.allowHostedInference ||
    (config.routing?.mode === 'provider_only' && config.routing?.provider),
  );
  const policy = new PolicyEngine({
    projectRoot,
    modelLifecycle: config.modelLifecyclePolicy,
    web: config.web?.policy,
    networkAllowed: config.networkAllowed,
    allowCommands: config.allowCommands,
    denyCommands: config.denyCommands,
    allowedMcpServers: config.allowedMcpServers,
    allowWorkspaceArtifactExecution: true,
    allowHostedProvidersDefault: hostedAuthorizedDefault,
    approvalQueue,
    approveCallback: async (request, decision) => {
      const { createApprover } = await import('./approve.js');
      return createApprover(request, decision);
    },
  });

  const mcp = new MCPRegistry({
    directory: engineConfigDir, tools, policy, secrets: secretBroker,
    autoConnect: config.mcp?.autoConnect ?? true,
    onAuthRequired: async (id, ctx) => {
      if (ctx.executionId) await executions.recordEvent(ctx.executionId, 'mcp.event', { event: 'WAITING_FOR_AUTH', serverId: id });
      if (!process.stdin.isTTY) throw new Error('MCP_AUTH_REQUIRED');
      const { authenticateMCP } = await import('./mcp.js');
      await authenticateMCP(mcp, id);
    },
  });
  mcp.on('event', event => {
    if (event.executionId) void executions.recordEvent(event.executionId, 'mcp.event', event).catch(() => undefined);
  });
  if (!options.fastStartup || existsSync(path.join(engineConfigDir, 'mcp.json')) || (config.allowedMcpServers?.length ?? 0) > 0) {
    await mcp.initialize().catch(() => { if (!options.quiet) console.error('[wazir] MCP registry unavailable; run wa mcp doctor.'); });
  }
  const web = config.web?.enabled ? createConfiguredWeb(config.web, policy, mcp, engineConfigDir, executions, store) : undefined;
  if (web) for (const tool of createWebTools(web)) tools.register(tool);

  // ---- scheduler ----------------------------------------------------------
  const classifier = new TaskCapabilityClassifier();
  const getModelIntelligence = memoizeService(() => new ModelIntelligenceService({ classifier, store }));
  const reliability = new ModelReliabilityTracker();
  const nvidiaLimits = buildNvidiaHostedLimits(config.providers?.nvidia);
  // Accounts for anything not configured: local runtimes, hosted APIs (paid only if hosted
  // providers were already authorised), and delegated agents (subscriptions, limits unknown).
  resources.accounts.addImplicit({
    localRuntimes: [...new Set([...adapterList.map((a) => a.id), ...fleetRuntimeIds])],
    hostedRuntimes: [...hostedAdapters.keys()],
    agents: agents.list().filter((a) => a.source === 'external').map((a) => a.descriptor.name),
    hostedAuthorized: hostedAuthorizedDefault,
    hostedConcurrency: {
      nvidia: (!Array.isArray(config.providers?.nvidia?.limits) ? config.providers?.nvidia?.limits?.maxConcurrentRequests : undefined) ?? 2,
    },
    hostedLimits: nvidiaLimits ? { nvidia: nvidiaLimits } : undefined,
    hostedPricing: config.providers?.nvidia?.pricing ? { nvidia: config.providers.nvidia.pricing } : undefined,
  });

  const hardwareEligibility = new HardwareEligibilityService();
  const contextEstimator = new ContextMemoryEstimator();
  const modelRanker = new IntelligentModelRanker(hardwareEligibility, contextEstimator);
  const prefFilePath = path.join(engineConfigDir, 'model-preference.json');
  const prefKvStore = {
    get: async (k: string) => {
      const val = await store.get<unknown>(k);
      if (val === undefined || val === null) return null;
      return typeof val === 'string' ? val : JSON.stringify(val);
    },
    set: async (k: string, v: string) => {
      await store.put(k, v);
    },
  };
  const modelPreferences = new ModelPreferenceService({
    configFilePath: prefFilePath,
    kvStore: prefKvStore,
    kvKey: 'models/preferences',
  });
  if (!(modelPreferences as any).loadPersistentPreference) {
    (modelPreferences as any).loadPersistentPreference = async function (this: any) {
      if (prefKvStore) {
        try {
          const raw = await prefKvStore.get('models/preferences');
          if (raw) {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (parsed && typeof parsed === 'object') {
              this.persistentPreference = this.migrateLegacyConfig(parsed);
            }
          }
        } catch {
          // ignore
        }
      }
      return this.persistentPreference;
    };
  }
  await (modelPreferences as any).loadPersistentPreference();

  const modelDiscoveryStatus = new ModelDiscoveryStatusService({
    models,
    runtimes,
    computers,
  });
  const origFormatStartupSummary = modelDiscoveryStatus.formatStartupSummary.bind(modelDiscoveryStatus);
  (modelDiscoveryStatus as any).formatStartupSummary = function (arg1?: any, arg2?: any) {
    if (arg1 && typeof arg1 === 'object') {
      const reg = arg1.registeredCount ?? arg1.startupBannerCounts?.registered ?? 0;
      const avail = arg1.availableCount ?? arg1.startupBannerCounts?.available ?? 0;
      const loaded = arg1.loadedCount ?? arg1.startupBannerCounts?.loaded ?? 0;
      return `Models: ${reg} registered, ${avail} available, ${loaded} loaded`;
    }
    return origFormatStartupSummary(arg1 ?? 'auto', arg2 ?? 'medium');
  };

  const scheduler = new Scheduler({
    computers,
    runtimes,
    models,
    policy,
    agents,
    reliability,
    get modelIntelligence() { return getModelIntelligence(); },
    resources: { router: resources.router },
    routing: config.routing,
    ranker: modelRanker,
    hardwareEligibility,
    contextEstimator,
    preferences: modelPreferences,
  });

  // ---- jobs & orchestration -----------------------------------------------
  const jobManager = new JobManager({ store, lazy: Boolean(options.fastStartup) });
  if (!options.fastStartup) {
    await jobManager.ready;
  }

  const worktrees = new WorktreeManager();
  const checkpoints = new CheckpointService({
    store,
    executionEngine: executions,
    worktreeManager: worktrees,
    provenanceManager: provenance,
    defaultWorkspaceRoot: projectRoot,
    lazy: Boolean(options.fastStartup),
  });
  if (!options.fastStartup) {
    await checkpoints.ready;
  }

  const handoffs = new HandoffService({ store, executions, checkpoints, projectRoot, lazy: Boolean(options.fastStartup) });
  if (!options.fastStartup) {
    await handoffs.ready;
  }

  const orchestrator = new JobOrchestrator({
    scheduler,
    executionEngine: executions,
    checkpointService: checkpoints,
    policy,
    agents,
    models,
    runtimes,
    computers,
    jobManager,
  }) as any;
  orchestrator.store = store; // Attach store for Block persistence
  const planner = createTaskPlanner();

  const lifecycle = new ModelLifecycleService({
    models,
    runtimes,
    computers,
    agents,
    adapters: adapterById,
    store, policy, executions,
    resources: { ...config.resources?.memory, minimumContext: config.resources?.minimumContext, autoContext: config.resources?.autoContext },
    refreshResources: async computerId => {
      const comp = computers.get(computerId);
      if (!comp) return;
      if (comp.local) {
        computers.heartbeat(computerId, { load: currentLoad(), telemetrySource: 'local-os' });
        return;
      }
      const refreshRemote = fleetHostRefreshers.get(computerId);
      if (refreshRemote) {
        await refreshRemote();
      } else if (config.apiUrl) {
        await refreshRemoteHostTelemetry(computers, computerId, { id: computerId }, [], {
          apiUrl: config.apiUrl,
          apiToken: config.apiToken,
        });
      }
    },
  });

  const health = new HealthEvidenceLog();
  lifecycle.subscribe(event => health.onLifecycleEvent(event));
  lifecycle.subscribe(event => {
    if (options.fastStartup && (event.type === 'MODEL_DISCOVERED' || event.type === 'MODEL_RECONCILED')) return;
    void appendAuditEvent({ type: 'model_lifecycle', details: { ...event } }).catch(() => undefined);
    const executionId = event.data?.executionId;
    if (typeof executionId === 'string') void executions.recordEvent(executionId, 'model.lifecycle', event).catch(() => undefined);
  });
  await executions.ready;
  const executionHistory = await executions.list();
  reliability.hydrate(executionHistory);
  if (options.fastStartup) {
    health.deferHydration(() => health.hydrateFromExecutions(executionHistory));
  } else {
    health.hydrateFromExecutions(executionHistory);
  }
  await lifecycle.discoverAndReconcile({
    verify: !options.readOnlyLifecycle,
    fastStartup: options.fastStartup ?? true,
    preDiscovered: new Map(discovered.map((d) => [d.id, { health: d.health, models: d.models }])),
  });
  // After discovery so every model is registered; register() preserves the profiles.
  for (const [modelId, profiles] of measureModelPerformance(executionHistory)) models.setPerformance(modelId, profiles);
  if (!options.readOnlyLifecycle && !options.fastStartup) {
    await lifecycle.applyStartupPolicy(config.models?.startup);
    lifecycle.startReconciliation();
    const inspectOutcome = localOutcomeInspector(projectRoot, localComputer.id);
    await reconcileLocalOutcomes(executions, inspectOutcome);
    // Heartbeat before sweeping: the sweep must never find this live process's own worker offline.
    startLocalHeartbeat(computers, localComputer.id, currentLoad);
    for (const fleetHostId of onlineFleetHostIds) {
      const refreshRemote = fleetHostRefreshers.get(fleetHostId);
      if (!refreshRemote) continue;
      const timer = setInterval(() => {
        void refreshRemote().catch(() => undefined);
      }, 15_000);
      timer.unref?.();
    }
    new RecoveryManager({ computers, executions, jobManager, orchestrator, inspectToolOutcome: inspectOutcome }).start();
  }

  const getOffloadStore = memoizeService(() => new OffloadStore({
    workspace: projectRoot,
    enabled: config.context?.offload?.enabled ?? true,
  }));

  const getCompaction = memoizeService(() => new ContextCompactionService({
    engine: executions,
    config: config.context?.compaction,
    defaultReserves: config.context?.reserve as any,
  }));

  const getLayoutPlanner = memoizeService(() => new PromptLayoutPlanner());

  const getRevision = memoizeService(() => new ContextRevisionService({
    compiler,
    compactionService: getCompaction(),
    layoutPlanner: getLayoutPlanner(),
    engine: executions,
    config: {
      enabled: config.context?.revision?.enabled ?? true,
      autoThreshold: config.context?.revision?.autoThreshold ?? 0.75,
      targetUtilization: config.context?.revision?.targetUtilization ?? 0.50,
      preserveRecentTailRatio: config.context?.revision?.preserveRecentTailRatio ?? 0.50,
      layoutStrategy: config.context?.layout?.strategy ?? 'CACHE_STABLE_PREFIX',
    },
  }));

  const getEvaluation = memoizeService(() => new EvaluationService());
  const getBenchmark = memoizeService(() => new BenchmarkService(getEvaluation()));
  const getVerification = memoizeService(() => new VerificationEngine({ projectRoot }));

  const getSolutionSearch = memoizeService(() => new SolutionSearchService({
    checkpointService: checkpoints,
    worktreeManager: worktrees,
    executionEngine: executions,
    evaluationService: getEvaluation(),
    verificationEngine: getVerification(),
    provenanceManager: provenance,
    defaultProjectRoot: projectRoot,
  }));

  const getOptimizer = memoizeService(() => new MetaOptimizerService({
    benchmarkService: getBenchmark(),
    evaluationService: getEvaluation(),
    verificationEngine: getVerification(),
    worktreeManager: worktrees,
    checkpointService: checkpoints,
    policyEngine: policy,
    store,
  }));
  if (profile !== 'minimal' && !skipRuntimeDiscovery) {
    getOffloadStore();
    getCompaction();
    getLayoutPlanner();
    getRevision();
  }
  globalStartupProfiler.mark('engine.ready');
  globalStartupProfiler.emitIfEnabled();

  const metaHarness = new MetaHarnessService({
    store,
    projectRoot,
    configDir: engineConfigDir,
    hostDiscoveryDriver: {
      discoverLocalHost: (opts) => discoverDetailedLocalHost(opts),
      discoverSshHost: (opts) => discoverAuthorizedSshHost(opts),
    },
    cliEntrypointPath: process.argv[1],
  });

  const rawDistribution = options.distributionSpec ?? process.env.WAZIR_HARDWARE_DISTRIBUTION;
  const workloadDistributor = new WorkloadDistributor(
    rawDistribution ? parseWorkloadDistribution(rawDistribution) : DEFAULT_HARDWARE_DISTRIBUTION,
  );

  return {
    config,
    resources,
    projectRoot,
    configDir: engineConfigDir,
    web,
    get compaction() { return getCompaction(); },
    get revision() { return getRevision(); },
    get layoutPlanner() { return getLayoutPlanner(); },
    get offloadStore() { return getOffloadStore(); },
    computers,
    runtimes,
    models,
    lifecycle,
    health,
    agents,
    tools,
    policy,
    scheduler,
    reliability,
    compiler,
    executions,
    provenance,
    approvalQueue,
    orchestrator,
    worktrees,
    checkpoints,
    get solutionSearch() { return getSolutionSearch(); },
    get evaluation() { return getEvaluation(); },
    get benchmark() { return getBenchmark(); },
    get optimizer() { return getOptimizer(); },
    get modelIntelligence() { return getModelIntelligence(); },
    get verification() { return getVerification(); },
    planner,
    adapters: adapterById,
    discovered,
    worker,
    store,
    fleetMemory,
    handoffs,
    secretBroker,
    hostedAdapters,
    mcp,
    modelPreferences,
    modelDiscoveryStatus,
    modelRanker,
    hardwareEligibility,
    contextEstimator,
    metaHarness,
    workloadDistributor,
    isBootstrapping: false,
  };
}

/**
 * Constructs a zero-I/O, synchronous bootstrap RookEngine (< 2ms) so interactive
 * `wa` / `wazir` can render the header and editable composer immediately while slow
 * runtime/provider discovery completes asynchronously in the background.
 */
export function createBootstrapEngine(projectRoot?: string, distributionSpec?: string): RookEngine {
  const resolvedRoot = path.resolve(projectRoot ?? process.cwd());
  const engineConfigDir = configDir();
  const config = loadConfig();
  const store = new MemoryStore();
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();
  const provenance = new ProvenanceManager(store);
  const executions = new ExecutionEngine({
    provenanceManager: provenance,
    workspace: resolvedRoot,
    fastStartup: true,
  }) as ExecutionEngine & { store?: KeyValueStore };
  executions.store = store;
  const approvalQueue = new ApprovalQueue({ defaultTimeoutMs: 5 * 60_000, allowEnvAutoApprove: false });
  const policy = new PolicyEngine({
    projectRoot: resolvedRoot,
    approvalQueue,
    allowWorkspaceArtifactExecution: true,
  });
  const resources = createResourceSystem(engineConfigDir);
  const scheduler = new Scheduler({
    computers,
    runtimes,
    models,
    policy,
    agents,
    resources: { router: resources.router },
    routing: config.routing,
  });
  const jobManager = new JobManager({ store, lazy: true });
  const worktrees = new WorktreeManager();
  const checkpoints = new CheckpointService({
    store,
    executionEngine: executions,
    worktreeManager: worktrees,
    provenanceManager: provenance,
    defaultWorkspaceRoot: resolvedRoot,
    lazy: true,
  });
  const handoffs = new HandoffService({ store, executions, checkpoints, projectRoot: resolvedRoot, lazy: true });
  const orchestrator = new JobOrchestrator({
    scheduler,
    executionEngine: executions,
    checkpointService: checkpoints,
    policy,
    agents,
    models,
    runtimes,
    computers,
    jobManager,
  }) as JobOrchestrator & { store?: KeyValueStore };
  orchestrator.store = store;
  const adapters = new Map<string, RuntimeAdapter>();
  const lifecycle = new ModelLifecycleService({
    models,
    runtimes,
    computers,
    agents,
    adapters,
    store,
    policy,
    executions,
  });
  const health = new HealthEvidenceLog();
  const planner = createTaskPlanner();
  const fleetMemory = createFleetMemoryService(store);
  const mcp = new MCPRegistry({
    directory: engineConfigDir,
    tools,
    policy,
    secrets: {
      backendName: 'memory',
      getSecret: async () => null,
      setSecret: async () => undefined,
      deleteSecret: async () => false,
      listSecretKeys: async () => [],
    } as unknown as SecretBroker,
    autoConnect: false,
  });
  const rawDist = distributionSpec ?? process.env.WAZIR_HARDWARE_DISTRIBUTION;
  const workloadDistributor = new WorkloadDistributor(
    rawDist ? parseWorkloadDistribution(rawDist) : DEFAULT_HARDWARE_DISTRIBUTION,
  );
  return {
    config,
    resources,
    projectRoot: resolvedRoot,
    configDir: engineConfigDir,
    computers,
    runtimes,
    models,
    lifecycle,
    health,
    agents,
    tools,
    mcp,
    policy,
    scheduler,
    compiler,
    executions,
    provenance,
    approvalQueue,
    orchestrator,
    worktrees,
    checkpoints,
    planner,
    adapters,
    discovered: [],
    worker: new Worker({ computerId: 'local', name: 'local', adapters: [] }),
    store,
    fleetMemory,
    handoffs,
    secretBroker: {
      backendName: 'probing',
      getSecret: async () => null,
      setSecret: async () => undefined,
      deleteSecret: async () => false,
      listSecretKeys: async () => [],
    } as unknown as SecretBroker,
    hostedAdapters: new Map(),
    workloadDistributor,
    isBootstrapping: true,
  };
}

export async function createStandaloneMetaHarnessService(options: {
  projectRoot?: string;
  localOnlyDiscovery?: boolean;
} = {}): Promise<MetaHarnessService> {
  const store = await createStore();
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  return new MetaHarnessService({
    store,
    projectRoot,
    configDir: configDir(),
    localOnlyDiscovery: options.localOnlyDiscovery,
    hostDiscoveryDriver: {
      discoverLocalHost: (opts) => discoverDetailedLocalHost(opts),
      discoverSshHost: (opts) => discoverAuthorizedSshHost(opts),
    },
    cliEntrypointPath: process.argv[1],
  });
}

/**
 * Registers one discovered runtime (and, if reachable, its models) into the engine's
 * live registries. Shared by createEngine()'s initial discovery pass and refreshRuntime()
 * so re-probing a runtime after the fact (e.g. the operator starts LM Studio's server
 * from within the TUI) goes through the exact same registration logic, not a copy of it.
 */
function withRuntimeId(adapter: RuntimeAdapter, runtimeId: string): RuntimeAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'id') return runtimeId;
      if (prop === 'discover') {
        return async () => ({ ...(await target.discover()), id: runtimeId });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function applyDiscoveredRuntime(
  discoveredRuntime: DiscoveredRuntime,
  deps: { runtimes: RuntimeRegistry; computers: ComputerRegistry; models: ModelRegistry; config: WazirConfig; computerId: string },
): Promise<void> {
  const { runtimes, computers, models, config, computerId } = deps;
  const baseId = discoveredRuntime.id.includes(':')
    ? discoveredRuntime.id.slice(discoveredRuntime.id.lastIndexOf(':') + 1)
    : discoveredRuntime.id;
  const runtimeType: RuntimeType =
    baseId === 'mlx'
      ? 'mlx'
      : baseId === 'ollama'
        ? 'ollama'
        : baseId === 'lmstudio'
          ? 'lmstudio'
          : 'other';

  const existing = runtimes.get(discoveredRuntime.id);
  runtimes.register({
    id: existing?.id ?? discoveredRuntime.id,
    type: runtimeType,
    name: discoveredRuntime.info.name,
    version: discoveredRuntime.info.version,
    url: discoveredRuntime.info.url,
    computerId,
    capabilities: {
      chat: discoveredRuntime.capabilities.chat,
      streaming: discoveredRuntime.capabilities.streaming,
      toolCalling: discoveredRuntime.capabilities.toolCalling,
      structuredOutput: discoveredRuntime.capabilities.structuredOutput,
      vision: discoveredRuntime.capabilities.vision,
      embeddings: discoveredRuntime.capabilities.embeddings,
      reasoning: discoveredRuntime.capabilities.reasoning,
      modelLoad: discoveredRuntime.capabilities.modelLoad,
      modelUnload: discoveredRuntime.capabilities.modelUnload,
      modelDownload: discoveredRuntime.capabilities.modelDownload,
      statefulChat: discoveredRuntime.capabilities.statefulChat,
      mcp: discoveredRuntime.capabilities.mcp,
    },
  });

  runtimes.update(discoveredRuntime.id, { health: discoveredRuntime.health });

  if (discoveredRuntime.health !== 'unavailable') {
    computers.heartbeat(computerId, {
      runtimeHealth: { [discoveredRuntime.id]: { status: discoveredRuntime.health === 'healthy' ? 'healthy' : 'unhealthy' } },
    });

    let loadedModelIds = new Set<string>();
    const hasLoadedFlagOnAll =
      discoveredRuntime.models.length === 0 ||
      discoveredRuntime.models.every((m) => typeof m.loaded === 'boolean');
    if (hasLoadedFlagOnAll) {
      loadedModelIds = new Set(discoveredRuntime.models.filter((m) => m.loaded).map((m) => m.id));
    } else {
      try {
        if (discoveredRuntime.adapter?.getLoadedModels) {
          const loaded = await discoveredRuntime.adapter.getLoadedModels();
          loadedModelIds = new Set(loaded);
        }
      } catch {
        // Best effort query for resident models
      }
    }

    for (const discoveredModel of discoveredRuntime.models) {
      registerModel(models, discoveredRuntime, discoveredModel, computerId, config, loadedModelIds);
    }
  } else {
    computers.heartbeat(computerId, {
      runtimeHealth: { [discoveredRuntime.id]: { status: 'unhealthy' } },
    });
    for (const inst of models.instancesForRuntime(discoveredRuntime.id)) {
      models.setInstanceState(inst.id, 'UNAVAILABLE', { health: 'unavailable' });
    }
  }
}

/**
 * Re-probes one runtime (e.g. after the operator starts LM Studio's server from within
 * `wa chat`) and updates the engine's live registries in place — no engine/process
 * restart needed. Only refreshes a runtime that was already configured at startup.
 */
export async function refreshRuntime(engine: RookEngine, runtimeId: string): Promise<{ ok: boolean; message: string }> {
  const refreshed = await engine.worker.refreshRuntime(runtimeId);
  if (!refreshed) {
    return { ok: false, message: `runtime '${runtimeId}' is not configured` };
  }

  const idx = engine.discovered.findIndex((d) => d.id === runtimeId);
  if (idx !== -1) engine.discovered[idx] = refreshed;
  else engine.discovered.push(refreshed);
  engine.adapters.set(refreshed.id, refreshed.adapter);

  await applyDiscoveredRuntime(refreshed, {
    runtimes: engine.runtimes,
    computers: engine.computers,
    models: engine.models,
    config: engine.config,
    computerId: process.env.WAZIR_COMPUTER_ID ?? 'local',
  });

  await engine.lifecycle.reconcile();
  if (refreshed.health === 'unavailable') {
    return { ok: false, message: refreshed.healthMessage ?? `${runtimeId} is unreachable` };
  }
  return { ok: true, message: `${refreshed.id}: ${refreshed.health}, ${refreshed.models.length} model(s) available` };
}

function registerModel(
  models: ModelRegistry,
  runtime: { id: string; health: string; models: DiscoveredModel[] },
  discovered: DiscoveredModel,
  computerId: string,
  config: WazirConfig,
  loadedModelIds: Set<string> = new Set(),
): void {
  const provider = runtime.id;
  const capabilities: ModelCapability[] = dedupe([
    'generalChat',
    ...(discovered.capabilities ?? []),
    ...(config.modelCapabilities[discovered.id] ?? []),
  ] as ModelCapability[]);

  if (discovered.toolCalling) capabilities.push('toolCalling');
  if (discovered.reasoning) capabilities.push('reasoning');
  if (discovered.vision) capabilities.push('vision');
  if (discovered.embedding) capabilities.push('embedding');
  if (discovered.structuredOutput) capabilities.push('structuredOutput');

  const configured = config.modelContext[discovered.id];
  const contextMax = discovered.contextWindow ?? configured ?? DEFAULT_CONTEXT;
  const contextLimitSource: ModelRecord['contextLimitSource'] =
    discovered.contextWindow !== undefined
      ? (discovered.contextLimitSource ?? 'provider-documented')
      : configured !== undefined
        ? 'operator-configured'
        : 'default-unknown';

  const existingRecord = models.get(discovered.id);
  const localPriority = (p: string): number => (p === 'mlx' ? 1 : p === 'ollama' ? 2 : p === 'lmstudio' ? 3 : 4);
  const effectiveProvider =
    existingRecord && existingRecord.local && localPriority(existingRecord.provider) < localPriority(provider)
      ? existingRecord.provider
      : provider;
  const currentCompat: RuntimeType[] | 'any' =
    provider === 'mlx'
      ? ['mlx']
      : provider === 'ollama'
        ? ['ollama']
        : provider === 'lmstudio'
          ? ['lmstudio']
          : 'any';
  const mergedCompat: RuntimeType[] | 'any' =
    currentCompat === 'any' || existingRecord?.runtimeCompatibility === 'any'
      ? 'any'
      : Array.isArray(existingRecord?.runtimeCompatibility)
        ? dedupe([...existingRecord.runtimeCompatibility, ...currentCompat])
        : currentCompat;

  const record: ModelRecord = {
    id: discovered.id,
    name: discovered.name ?? existingRecord?.name ?? discovered.id,
    provider: effectiveProvider,
    family: guessFamily(discovered.id, effectiveProvider),
    architecture: discovered.architecture ?? existingRecord?.architecture,
    parameters: discovered.parameters ?? existingRecord?.parameters,
    contextMax: Math.max(contextMax, existingRecord?.contextMax ?? 0),
    maxOutputTokens: discovered.maxOutputTokens ?? existingRecord?.maxOutputTokens,
    configuredContext: configured,
    maxInputTokens: discovered.maxInputTokens ?? existingRecord?.maxInputTokens,
    contextAccounting: discovered.contextAccounting ?? existingRecord?.contextAccounting,
    contextLimitSource,
    capabilities: existingRecord ? dedupe([...existingRecord.capabilities, ...capabilities]) : capabilities,
    toolCalling: Boolean(discovered.toolCalling || existingRecord?.toolCalling),
    structuredOutput: Boolean(discovered.structuredOutput || existingRecord?.structuredOutput),
    vision: Boolean(discovered.vision || existingRecord?.vision),
    audio: Boolean(discovered.audio || existingRecord?.audio),
    embedding: Boolean(discovered.embedding || existingRecord?.embedding),
    reasoning: Boolean(discovered.reasoning || existingRecord?.reasoning),
    quantization: discovered.quantization ?? existingRecord?.quantization,
    memory: estimateModelMemory(discovered.parameters ?? existingRecord?.parameters, discovered.id, discovered.quantization ?? existingRecord?.quantization),
    runtimeCompatibility: mergedCompat,
    local: true,
    createdAt: existingRecord?.createdAt ?? new Date(),
    updatedAt: new Date(),
  };

  models.register(record);

  const isLoaded =
    loadedModelIds.has(discovered.id) ||
    (discovered.name ? loadedModelIds.has(discovered.name) : false) ||
    false;

  const state: ModelLifecycleState =
    runtime.health === 'unavailable'
      ? 'UNAVAILABLE'
      : isLoaded
      ? 'LOADED'
      : 'INSTALLED';

  models.upsertInstance({
    id: `${discovered.id}::${computerId}::${provider}`,
    modelId: discovered.id,
    computerId,
    runtimeId: provider,
    runtimeModelId: discovered.id,
    loaded: isLoaded,
    state,
    health: runtime.health === 'healthy' ? 'healthy' : 'degraded',
    contextTokens: undefined,
  });
}

let cachedDefaultSecretBroker: Promise<SecretBroker> | undefined;
let cachedDefaultSecretDir: string | undefined;

function getSharedSecretBroker(secretsDir: string): Promise<SecretBroker> {
  if (cachedDefaultSecretDir !== secretsDir || !cachedDefaultSecretBroker) {
    cachedDefaultSecretDir = secretsDir;
    cachedDefaultSecretBroker = createSecretBroker({ secretsDir });
  }
  return cachedDefaultSecretBroker;
}

let cachedDefaultStore: Promise<KeyValueStore> | undefined;
let cachedDefaultStoreKey: string | undefined;

export async function createStore(): Promise<KeyValueStore> {
  if (process.env.WAZIR_DATABASE_URL) {
    const { createPool, runKvMigration, PostgresStore } = await import('@wazir/database');
    const pool = createPool({ connectionString: process.env.WAZIR_DATABASE_URL });
    await runKvMigration(pool);
    return new PostgresStore(pool);
  }
  if (process.env.WAZIR_IN_MEMORY === '1') {
    return new MemoryStore();
  }
  const storePath = path.join(configDir(), 'wazir.json');
  if (cachedDefaultStoreKey === storePath && cachedDefaultStore) {
    return cachedDefaultStore;
  }
  cachedDefaultStoreKey = storePath;
  cachedDefaultStore = Promise.resolve(new JsonFileStore(storePath));
  return cachedDefaultStore;
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
