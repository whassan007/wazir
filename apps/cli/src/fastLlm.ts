import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { selectFastLocalModel, type FastModelCandidate } from '@wazir/core';

export type FastRuntimeType = 'lmstudio' | 'ollama' | 'mlx' | 'openai_compatible';

export interface FastModelCacheEntry {
  candidate: FastModelCandidate;
  endpoint: string;
  runtimeType: FastRuntimeType;
  baseUrl: string;
  supportsReasoningToggle?: boolean;
  updatedAt: string;
}

export interface FastLlmBenchmarkResult {
  entries: FastModelCacheEntry[];
  selected?: FastModelCacheEntry;
  benchmarkedAt: string;
  errors: string[];
}

export interface StreamFastLocalCompletionOptions {
  sessionModel?: string;
  wazirHome?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onToken?: (token: string) => void;
  localOnly?: boolean;
  systemPrompt?: string;
  maxTokens?: number;
}

export interface StreamFastLocalCompletionResult {
  status: 'success' | 'error' | 'cancelled';
  output?: string;
  error?: string;
  model?: string;
  provider?: string;
  endpoint?: string;
  modelSelectionMs: number;
  modelLoadMs?: number;
  providerConnectionMs?: number;
  firstTokenMs?: number;
  tokenThroughputTps?: number;
  outputTokens?: number;
  timedOut?: boolean;
  fallbackFrom?: string;
}

interface RawFleetHostConfig {
  id?: string;
  name?: string;
  ollamaUrl?: string;
  lmstudioUrl?: string;
  mlxUrl?: string;
}

interface RawFastConfig {
  ollamaUrl?: string | null;
  lmstudioUrl?: string | null;
  mlxUrl?: string | null;
  strictLoopbackOnly?: boolean;
  networkAllowed?: boolean;
  localOnly?: boolean;
  fleetHosts?: RawFleetHostConfig[];
  routing?: {
    mode?: string;
    provider?: string;
    defaultModel?: string;
    fastModel?: string;
    strictLoopbackOnly?: boolean;
  };
  models?: {
    fastLocalModel?: string;
  };
}

interface ProbeEndpointTarget {
  hostId: string;
  endpoint: string;
  runtimeType: FastRuntimeType;
  baseUrl: string;
  apiRoot: string;
  isFleet: boolean;
  apiKey?: string;
}

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_LMSTUDIO_URL = 'http://127.0.0.1:1234/v1';
const DEFAULT_MLX_URL = 'http://127.0.0.1:8080/v1';
const DEFAULT_SYSTEM_PROMPT =
  'You are Wazir, a fast, precise AI systems shell assistant. Answer concisely and directly.';

const LOCAL_PROVIDER_NAMES = new Set(['local', 'ollama', 'lmstudio', 'mlx', 'openai_compatible']);
const HOSTED_PROVIDER_NAMES = new Set([
  'openai',
  'anthropic',
  'google',
  'gemini',
  'nvidia',
  'groq',
  'openrouter',
  'together',
  'bedrock',
  'vertex',
  'azure',
  'cohere',
  'mistral-api',
  'fireworks',
  'deepseek-api',
]);

interface InMemoryCacheRecord {
  mtimeMs: number | null;
  size: number | null;
  entries: FastModelCacheEntry[];
}

const memoryModelCache = new Map<string, InMemoryCacheRecord>();

function resolveWazirHome(wazirHome?: string, env?: Record<string, string | undefined>): string {
  if (wazirHome && wazirHome.trim()) {
    return path.resolve(wazirHome.trim());
  }
  const envMap = env ?? process.env;
  if (envMap.WAZIR_HOME && envMap.WAZIR_HOME.trim()) {
    return path.resolve(envMap.WAZIR_HOME.trim());
  }
  if (envMap.ROOK_HOME && envMap.ROOK_HOME.trim()) {
    return path.resolve(envMap.ROOK_HOME.trim());
  }
  const defaultWazir = path.join(os.homedir(), '.wazir');
  const legacyRook = path.join(os.homedir(), '.rook');
  return fs.existsSync(defaultWazir) || !fs.existsSync(legacyRook) ? defaultWazir : legacyRook;
}

export function getFastLatencyFilePath(wazirHome?: string): string {
  return path.join(resolveWazirHome(wazirHome), 'shell_latency.json');
}

export function getFastModelCachePath(wazirHome?: string): string {
  return path.join(resolveWazirHome(wazirHome), 'fast-model-cache.json');
}

function cloneCacheEntry(entry: FastModelCacheEntry): FastModelCacheEntry {
  return {
    ...entry,
    candidate: {
      ...entry.candidate,
      ...(entry.candidate.capabilities ? { capabilities: [...entry.candidate.capabilities] } : {}),
    },
  };
}

function isValidRuntimeType(value: unknown): value is FastRuntimeType {
  return value === 'lmstudio' || value === 'ollama' || value === 'mlx' || value === 'openai_compatible';
}

function normalizeCacheEntries(raw: unknown): FastModelCacheEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)
      ? (raw as { entries: unknown[] }).entries
      : [];

  const entries: FastModelCacheEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const candidate = rec.candidate as Record<string, unknown> | undefined;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.id !== 'string' ||
      !candidate.id.trim() ||
      typeof rec.endpoint !== 'string' ||
      !isValidRuntimeType(rec.runtimeType) ||
      typeof rec.baseUrl !== 'string' ||
      !rec.baseUrl.trim()
    ) {
      continue;
    }
    entries.push({
      candidate: { ...(candidate as unknown as FastModelCandidate) },
      endpoint: rec.endpoint,
      runtimeType: rec.runtimeType,
      baseUrl: rec.baseUrl,
      ...(typeof rec.supportsReasoningToggle === 'boolean'
        ? { supportsReasoningToggle: rec.supportsReasoningToggle }
        : {}),
      updatedAt: typeof rec.updatedAt === 'string' && rec.updatedAt ? rec.updatedAt : new Date().toISOString(),
    });
  }
  return entries;
}

export function loadCachedFastModels(wazirHome?: string): FastModelCacheEntry[] {
  const cachePath = getFastModelCachePath(wazirHome);
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as unknown;
    return normalizeCacheEntries(parsed);
  } catch {
    return [];
  }
}

export async function saveCachedFastModels(entries: FastModelCacheEntry[], wazirHome?: string): Promise<void> {
  const cachePath = getFastModelCachePath(wazirHome);
  const cloned = entries.map(cloneCacheEntry);
  const payload = JSON.stringify(
    {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: cloned,
    },
    null,
    2,
  );

  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, payload, 'utf8');
    await fs.promises.rename(tmpPath, cachePath);
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  try {
    const stat = await fs.promises.stat(cachePath);
    memoryModelCache.set(cachePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries: cloned,
    });
  } catch {
    memoryModelCache.set(cachePath, {
      mtimeMs: null,
      size: null,
      entries: cloned,
    });
  }
}

function getWarmCachedFastModels(wazirHome?: string, env?: Record<string, string | undefined>): FastModelCacheEntry[] {
  const home = resolveWazirHome(wazirHome, env);
  const cachePath = path.join(home, 'fast-model-cache.json');
  const cached = memoryModelCache.get(cachePath);

  try {
    const stat = fs.statSync(cachePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.entries.map(cloneCacheEntry);
    }
    const diskEntries = loadCachedFastModels(home);
    memoryModelCache.set(cachePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries: diskEntries.map(cloneCacheEntry),
    });
    return diskEntries;
  } catch {
    if (cached) {
      if (cached.mtimeMs !== null) {
        memoryModelCache.delete(cachePath);
        return [];
      }
      return cached.entries.map(cloneCacheEntry);
    }
    return [];
  }
}

function readFastConfig(wazirHome?: string, env?: Record<string, string | undefined>): RawFastConfig {
  const home = resolveWazirHome(wazirHome, env);
  const configPath = path.join(home, 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RawFastConfig) : {};
  } catch {
    return {};
  }
}

export function isFastHostedFallbackPermitted(options?: {
  wazirHome?: string;
  env?: Record<string, string | undefined>;
}): boolean {
  const env = options?.env ?? process.env;
  if (env.WAZIR_LOCAL_ONLY === '1' || env.WAZIR_LOCAL_ONLY === 'true') {
    return false;
  }
  const config = readFastConfig(options?.wazirHome, env);
  if (config.networkAllowed === false || config.localOnly === true) {
    return false;
  }
  if (config.routing?.mode?.trim().toLowerCase() === 'local_only') {
    return false;
  }
  return true;
}

function normalizeOverrideValue(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'auto') {
    return undefined;
  }
  return trimmed;
}

function looksLikeHostedModelId(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.startsWith('nvidia/') ||
    lower.startsWith('openai/') ||
    lower.startsWith('anthropic/') ||
    lower.startsWith('google/') ||
    lower.startsWith('gemini/') ||
    lower.startsWith('gpt-') ||
    lower.startsWith('claude-') ||
    lower.startsWith('o1-') ||
    lower.startsWith('o3-') ||
    lower.startsWith('o4-')
  );
}

export function resolveConfiguredFastModelOverride(options?: {
  sessionModel?: string;
  wazirHome?: string;
  env?: Record<string, string | undefined>;
}): string | undefined {
  const env = options?.env ?? process.env;
  const fromSession = normalizeOverrideValue(options?.sessionModel);
  if (fromSession) return fromSession;

  const fromEnv = normalizeOverrideValue(env.WAZIR_FAST_MODEL);
  if (fromEnv) return fromEnv;

  const config = readFastConfig(options?.wazirHome, env);
  const fromRoutingFast = normalizeOverrideValue(config.routing?.fastModel);
  if (fromRoutingFast) return fromRoutingFast;

  const fromModelsFast = normalizeOverrideValue(config.models?.fastLocalModel);
  if (fromModelsFast) return fromModelsFast;

  const defaultModel = normalizeOverrideValue(config.routing?.defaultModel);
  if (!defaultModel) return undefined;

  const routingMode = config.routing?.mode?.trim().toLowerCase();
  const routingProvider = config.routing?.provider?.trim().toLowerCase();
  if (routingMode === 'provider_only') return undefined;
  if (routingProvider && HOSTED_PROVIDER_NAMES.has(routingProvider)) return undefined;
  if (looksLikeHostedModelId(defaultModel)) return undefined;

  const isExplicitLocalOrFast =
    routingMode === 'local_only' ||
    routingMode === 'fast' ||
    (routingProvider !== undefined && LOCAL_PROVIDER_NAMES.has(routingProvider));

  return isExplicitLocalOrFast ? defaultModel : undefined;
}

function isEmbeddingModelId(id: string): boolean {
  return /\bembed(?:ding)?\b|nomic-embed|mxbai-embed|bge-|e5-|all-minilm/i.test(id);
}

function isEmbeddingCandidate(candidate: FastModelCandidate): boolean {
  if (candidate.embedding === true) return true;
  const caps = candidate.capabilities ?? [];
  if (caps.includes('embedding') && !caps.includes('chat') && !caps.includes('coding')) {
    return true;
  }
  return isEmbeddingModelId(`${candidate.id} ${candidate.name ?? ''} ${candidate.family ?? ''}`);
}

function isReasoningModelId(id: string): boolean {
  return /qwen3|deepseek-r1|qwq|reasoner|-think/i.test(id);
}

function extractParametersString(id: string): string | undefined {
  const match = /(?:^|[:\-_/\s])(\d+(?:\.\d+)?)\s*([bBmM])(?=$|[:\-_/\s])/.exec(id);
  if (!match) return undefined;
  return `${match[1]}${match[2]!.toUpperCase()}`;
}

function parseParameterBillions(parameters?: string, id?: string): number | undefined {
  const source = parameters?.trim();
  if (source) {
    const match = /^([0-9]+(?:\.[0-9]+)?)\s*([bBmM])?$/.exec(source);
    if (match) {
      const val = Number.parseFloat(match[1]!);
      const unit = (match[2] ?? 'B').toUpperCase();
      if (Number.isFinite(val) && val > 0) {
        return unit === 'M' ? val / 1000 : val;
      }
    }
  }
  if (id) {
    const inferred = extractParametersString(id);
    if (inferred) return parseParameterBillions(inferred);
  }
  return undefined;
}

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.startsWith('127.');
  } catch {
    return false;
  }
}

function normalizeOpenAiBaseUrl(rawUrl: string): { baseUrl: string; apiRoot: string } {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    if (!cleanPath || cleanPath === '') {
      const apiRoot = `${parsed.origin}`;
      return { baseUrl: `${apiRoot}/v1`, apiRoot };
    }
    if (cleanPath.endsWith('/v1')) {
      const prefix = cleanPath.slice(0, -3);
      return {
        baseUrl: `${parsed.origin}${cleanPath}`,
        apiRoot: `${parsed.origin}${prefix}`,
      };
    }
    return {
      baseUrl: `${parsed.origin}${cleanPath}`,
      apiRoot: `${parsed.origin}${cleanPath}`,
    };
  } catch {
    return {
      baseUrl: trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`,
      apiRoot: trimmed.replace(/\/v1$/, ''),
    };
  }
}

function normalizeOllamaBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  return trimmed;
}

function normalizeHostKey(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.startsWith('127.')) {
      return '__local__';
    }
    return host;
  } catch {
    return rawUrl;
  }
}

function canonicalOllamaTag(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

async function fetchJsonWithTimeout<T>(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeLmStudioEndpoint(
  target: ProbeEndpointTarget,
  timeoutMs: number,
  nowIso: string,
): Promise<FastModelCacheEntry[]> {
  const headers = target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : undefined;

  interface NativeModel {
    key?: string;
    id?: string;
    display_name?: string;
    params_string?: string;
    size_bytes?: number;
    max_context_length?: number;
    type?: string;
    state?: string;
    loaded_instances?: Array<{ id?: string; config?: { context_length?: number } }>;
    capabilities?:
      | string[]
      | {
          vision?: boolean;
          trained_for_tool_use?: boolean;
          reasoning?: boolean;
        };
  }

  const nativePayload = await fetchJsonWithTimeout<{ models?: NativeModel[]; data?: NativeModel[] }>(
    `${target.apiRoot}/api/v1/models`,
    timeoutMs,
    headers,
  );
  const nativeList = nativePayload?.models ?? nativePayload?.data;
  if (Array.isArray(nativeList)) {
    return nativeList
      .filter((m) => Boolean((m.key ?? m.id)?.trim()))
      .map((m) => {
        const id = (m.key ?? m.id)!.trim();
        const isLoaded =
          (Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0) ||
          m.state === 'loaded' ||
          m.state === 'READY';
        const isEmbedding = m.type === 'embedding' || m.type === 'embeddings' || isEmbeddingModelId(id);
        const capObj = !Array.isArray(m.capabilities) && m.capabilities && typeof m.capabilities === 'object'
          ? m.capabilities
          : undefined;
        const capArr = Array.isArray(m.capabilities) ? m.capabilities : [];
        const reasoningCap = Boolean(capObj?.reasoning || capArr.includes('reasoning'));
        const supportsReasoningToggle = reasoningCap || isReasoningModelId(id);
        const caps: string[] = isEmbedding ? ['embedding'] : ['chat'];
        if (supportsReasoningToggle && !isEmbedding) caps.push('reasoning');
        if (capObj?.vision || capArr.includes('vision')) caps.push('vision');
        if (capObj?.trained_for_tool_use || capArr.includes('tool_use')) caps.push('tool_use');

        const parameters = m.params_string ?? extractParametersString(id);
        const parameterBillions = parseParameterBillions(parameters, id);
        const candidate: FastModelCandidate = {
          id,
          name: m.display_name ?? id,
          provider: 'lmstudio',
          local: true,
          loaded: isLoaded,
          available: true,
          health: 'healthy',
          embedding: isEmbedding,
          capabilities: caps,
          ...(parameters ? { parameters } : {}),
          ...(parameterBillions !== undefined ? { parameterBillions } : {}),
          ...(typeof m.max_context_length === 'number' ? { contextMax: m.max_context_length } : {}),
        };
        return {
          candidate,
          endpoint: target.endpoint,
          runtimeType: target.runtimeType,
          baseUrl: target.baseUrl,
          supportsReasoningToggle,
          updatedAt: nowIso,
        };
      });
  }

  interface OpenAiModelItem {
    id?: string;
    state?: string;
    loaded?: boolean;
    max_model_len?: number;
    loaded_instances?: unknown[];
    capabilities?: { reasoning?: boolean } | string[];
  }
  const compatPayload = await fetchJsonWithTimeout<{ data?: OpenAiModelItem[] }>(
    `${target.baseUrl}/models`,
    timeoutMs,
    headers,
  );
  if (!compatPayload || !Array.isArray(compatPayload.data)) {
    return [];
  }

  const models = compatPayload.data.filter((m) => Boolean(m.id?.trim()));
  return models.map((m) => {
    const id = m.id!.trim();
    const isLoaded =
      m.loaded === true ||
      m.state === 'loaded' ||
      m.state === 'READY' ||
      (Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0) ||
      (models.length === 1 && m.loaded === undefined && m.state === undefined && m.loaded_instances === undefined);
    const isEmbedding = isEmbeddingModelId(id);
    const capObj = !Array.isArray(m.capabilities) && m.capabilities && typeof m.capabilities === 'object'
      ? m.capabilities
      : undefined;
    const capArr = Array.isArray(m.capabilities) ? m.capabilities : [];
    const supportsReasoningToggle = Boolean(capObj?.reasoning || capArr.includes('reasoning')) || isReasoningModelId(id);
    const parameters = extractParametersString(id);
    const parameterBillions = parseParameterBillions(parameters, id);
    return {
      candidate: {
        id,
        name: id,
        provider: 'lmstudio',
        local: true,
        loaded: isLoaded,
        available: true,
        health: 'healthy',
        embedding: isEmbedding,
        capabilities: isEmbedding ? ['embedding'] : supportsReasoningToggle ? ['chat', 'reasoning'] : ['chat'],
        ...(parameters ? { parameters } : {}),
        ...(parameterBillions !== undefined ? { parameterBillions } : {}),
        ...(typeof m.max_model_len === 'number' ? { contextMax: m.max_model_len } : {}),
      },
      endpoint: target.endpoint,
      runtimeType: target.runtimeType,
      baseUrl: target.baseUrl,
      supportsReasoningToggle,
      updatedAt: nowIso,
    };
  });
}

async function probeOllamaEndpoint(
  target: ProbeEndpointTarget,
  timeoutMs: number,
  nowIso: string,
): Promise<FastModelCacheEntry[]> {
  interface OllamaModelEntry {
    name?: string;
    model?: string;
    size?: number;
    context_length?: number;
    details?: {
      family?: string;
      families?: string[];
      parameter_size?: string;
    };
  }

  const [psPayload, tagsPayload] = await Promise.all([
    fetchJsonWithTimeout<{ models?: OllamaModelEntry[] }>(`${target.baseUrl}/api/ps`, timeoutMs),
    fetchJsonWithTimeout<{ models?: OllamaModelEntry[] }>(`${target.baseUrl}/api/tags`, timeoutMs),
  ]);

  if (!psPayload && !tagsPayload) {
    return [];
  }

  const runningByKey = new Map<string, OllamaModelEntry>();
  const psModels = Array.isArray(psPayload?.models) ? psPayload.models : [];
  for (const rm of psModels) {
    const key = rm.name ?? rm.model;
    if (!key) continue;
    runningByKey.set(key, rm);
    runningByKey.set(canonicalOllamaTag(key), rm);
    if (rm.model) {
      runningByKey.set(rm.model, rm);
      runningByKey.set(canonicalOllamaTag(rm.model), rm);
    }
  }

  const seenIds = new Set<string>();
  const merged: Array<{ item: OllamaModelEntry; loaded: boolean }> = [];
  const tagsModels = Array.isArray(tagsPayload?.models) ? tagsPayload.models : [];

  for (const tm of tagsModels) {
    const id = (tm.name ?? tm.model)?.trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const loaded =
      runningByKey.has(id) ||
      runningByKey.has(canonicalOllamaTag(id)) ||
      (tm.model ? runningByKey.has(tm.model) || runningByKey.has(canonicalOllamaTag(tm.model)) : false);
    const runningInfo =
      runningByKey.get(id) ??
      runningByKey.get(canonicalOllamaTag(id)) ??
      (tm.model ? runningByKey.get(tm.model) : undefined);
    merged.push({
      item: {
        ...tm,
        details: tm.details ?? runningInfo?.details,
        context_length: tm.context_length ?? runningInfo?.context_length,
      },
      loaded,
    });
  }

  for (const rm of psModels) {
    const id = (rm.name ?? rm.model)?.trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    merged.push({ item: rm, loaded: true });
  }

  return merged.map(({ item, loaded }) => {
    const id = (item.name ?? item.model)!.trim();
    const families = item.details?.families ?? [];
    const family = item.details?.family;
    const isEmbedding =
      families.some((f) => /embed|bert/i.test(f)) || isEmbeddingModelId(id);
    const parameters = item.details?.parameter_size ?? extractParametersString(id);
    const parameterBillions = parseParameterBillions(parameters, id);
    const supportsReasoningToggle = isReasoningModelId(id);
    return {
      candidate: {
        id,
        name: id,
        provider: 'ollama',
        ...(family ? { family } : {}),
        local: true,
        loaded,
        available: true,
        health: 'healthy',
        embedding: isEmbedding,
        capabilities: isEmbedding ? ['embedding'] : supportsReasoningToggle ? ['chat', 'reasoning'] : ['chat'],
        ...(parameters ? { parameters } : {}),
        ...(parameterBillions !== undefined ? { parameterBillions } : {}),
        ...(typeof item.context_length === 'number' ? { contextMax: item.context_length } : {}),
      },
      endpoint: target.endpoint,
      runtimeType: target.runtimeType,
      baseUrl: target.baseUrl,
      supportsReasoningToggle,
      updatedAt: nowIso,
    };
  });
}

async function probeMlxEndpoint(
  target: ProbeEndpointTarget,
  timeoutMs: number,
  nowIso: string,
  env: Record<string, string | undefined>,
): Promise<FastModelCacheEntry[]> {
  interface MlxModelItem {
    id?: string;
    loaded?: boolean;
    state?: string;
    max_model_len?: number;
  }
  const headers = target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : undefined;
  const payload = await fetchJsonWithTimeout<{ data?: MlxModelItem[] }>(
    `${target.baseUrl}/models`,
    timeoutMs,
    headers,
  );
  if (!payload || !Array.isArray(payload.data)) {
    return [];
  }

  const list = payload.data.filter((m) => Boolean(m.id?.trim()));
  const configuredMlxModel = env.WAZIR_MLX_MODEL?.trim();

  return list.map((m) => {
    const id = m.id!.trim();
    const isLoaded =
      m.loaded === true ||
      m.state === 'loaded' ||
      m.state === 'READY' ||
      (m.loaded !== false && list.length === 1) ||
      (Boolean(configuredMlxModel) && id === configuredMlxModel);
    const isEmbedding = isEmbeddingModelId(id);
    const supportsReasoningToggle = isReasoningModelId(id);
    const parameters = extractParametersString(id);
    const parameterBillions = parseParameterBillions(parameters, id);
    return {
      candidate: {
        id,
        name: id,
        provider: 'mlx',
        local: true,
        loaded: isLoaded,
        available: true,
        health: 'healthy',
        embedding: isEmbedding,
        capabilities: isEmbedding ? ['embedding'] : supportsReasoningToggle ? ['chat', 'reasoning'] : ['chat'],
        ...(parameters ? { parameters } : {}),
        ...(parameterBillions !== undefined ? { parameterBillions } : {}),
        ...(typeof m.max_model_len === 'number' ? { contextMax: m.max_model_len } : {}),
      },
      endpoint: target.endpoint,
      runtimeType: target.runtimeType,
      baseUrl: target.baseUrl,
      supportsReasoningToggle,
      updatedAt: nowIso,
    };
  });
}

function buildProbeTargets(options?: {
  wazirHome?: string;
  env?: Record<string, string | undefined>;
  includeFleet?: boolean;
}): ProbeEndpointTarget[] {
  const env = options?.env ?? process.env;
  const config = readFastConfig(options?.wazirHome, env);

  const strictLoopbackOnly = Boolean(
    config.strictLoopbackOnly ||
      config.routing?.strictLoopbackOnly ||
      env.WAZIR_STRICT_LOOPBACK_ONLY === '1',
  );

  const rawTargets: ProbeEndpointTarget[] = [];

  const pushLmStudio = (rawUrl: string, hostId: string, isFleet: boolean) => {
    const { baseUrl, apiRoot } = normalizeOpenAiBaseUrl(rawUrl);
    rawTargets.push({
      hostId,
      endpoint: `${hostId}:lmstudio`,
      runtimeType: 'lmstudio',
      baseUrl,
      apiRoot,
      isFleet,
      apiKey: env.WAZIR_LMSTUDIO_API_KEY || undefined,
    });
  };
  const pushOllama = (rawUrl: string, hostId: string, isFleet: boolean) => {
    const baseUrl = normalizeOllamaBaseUrl(rawUrl);
    rawTargets.push({
      hostId,
      endpoint: `${hostId}:ollama`,
      runtimeType: 'ollama',
      baseUrl,
      apiRoot: baseUrl,
      isFleet,
    });
  };
  const pushMlx = (rawUrl: string, hostId: string, isFleet: boolean) => {
    const { baseUrl, apiRoot } = normalizeOpenAiBaseUrl(rawUrl);
    rawTargets.push({
      hostId,
      endpoint: `${hostId}:mlx`,
      runtimeType: 'mlx',
      baseUrl,
      apiRoot,
      isFleet,
      apiKey: env.WAZIR_MLX_API_KEY || undefined,
    });
  };

  const resolveConfiguredUrl = (
    envVal: string | undefined,
    cfgVal: string | null | undefined,
    fallback: string,
  ): string | undefined => {
    if (envVal !== undefined) {
      return envVal.trim() ? envVal.trim() : undefined;
    }
    if (cfgVal === null) return undefined;
    if (cfgVal !== undefined) {
      return cfgVal.trim() ? cfgVal.trim() : undefined;
    }
    return fallback;
  };

  const lmstudioUrl = resolveConfiguredUrl(
    env.WAZIR_LMSTUDIO_URL ?? env.ROOK_LMSTUDIO_URL,
    config.lmstudioUrl,
    DEFAULT_LMSTUDIO_URL,
  );
  const ollamaUrl = resolveConfiguredUrl(
    env.WAZIR_OLLAMA_URL ?? env.ROOK_OLLAMA_URL,
    config.ollamaUrl,
    DEFAULT_OLLAMA_URL,
  );
  const mlxUrl = resolveConfiguredUrl(env.WAZIR_MLX_URL, config.mlxUrl, DEFAULT_MLX_URL);

  if (lmstudioUrl) pushLmStudio(lmstudioUrl, 'local', false);
  if (ollamaUrl) pushOllama(ollamaUrl, 'local', false);
  if (mlxUrl) pushMlx(mlxUrl, 'local', false);

  if (options?.includeFleet !== false) {
    let fleetHosts: RawFleetHostConfig[] = Array.isArray(config.fleetHosts) ? config.fleetHosts : [];
    if (env.WAZIR_FLEET_HOSTS) {
      try {
        const parsed = JSON.parse(env.WAZIR_FLEET_HOSTS) as unknown;
        if (Array.isArray(parsed)) {
          fleetHosts = parsed.filter((h): h is RawFleetHostConfig => Boolean(h && typeof h === 'object'));
        }
      } catch {
        // fall back to config.json fleetHosts
      }
    }
    for (const host of fleetHosts) {
      const hostId = host.id?.trim();
      if (!hostId) continue;
      if (host.lmstudioUrl?.trim()) pushLmStudio(host.lmstudioUrl, hostId, true);
      if (host.ollamaUrl?.trim()) pushOllama(host.ollamaUrl, hostId, true);
      if (host.mlxUrl?.trim()) pushMlx(host.mlxUrl, hostId, true);
    }
  }

  const seen = new Set<string>();
  const deduped: ProbeEndpointTarget[] = [];
  for (const target of rawTargets) {
    if (strictLoopbackOnly && !isLoopbackUrl(target.baseUrl)) {
      continue;
    }
    const key = `${target.runtimeType}|${target.baseUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

export async function discoverFastLocalEndpoints(options?: {
  wazirHome?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  includeFleet?: boolean;
}): Promise<FastModelCacheEntry[]> {
  const env = options?.env ?? process.env;
  if (env.WAZIR_SKIP_RUNTIME_DISCOVERY === '1') {
    return [];
  }

  const targets = buildProbeTargets({
    wazirHome: options?.wazirHome,
    env,
    includeFleet: options?.includeFleet,
  });
  if (targets.length === 0) return [];

  const nowIso = new Date().toISOString();
  const batches = await Promise.all(
    targets.map(async (target) => {
      const timeoutMs = options?.timeoutMs ?? (target.isFleet ? 1300 : 900);
      try {
        if (target.runtimeType === 'lmstudio') {
          return await probeLmStudioEndpoint(target, timeoutMs, nowIso);
        }
        if (target.runtimeType === 'ollama') {
          return await probeOllamaEndpoint(target, timeoutMs, nowIso);
        }
        return await probeMlxEndpoint(target, timeoutMs, nowIso, env);
      } catch {
        return [] as FastModelCacheEntry[];
      }
    }),
  );

  return batches.flat();
}

/**
 * Stateful streaming filter that removes leading `<think>...</think>` blocks from
 * reasoning-capable models without delaying normal non-thinking token chunks.
 */
class ThinkStreamFilter {
  private mode: 'detect' | 'thinking' | 'answer' = 'detect';
  private pending = '';
  private trimLeadingWhitespaceAfterThink = false;

  push(text: string): string[] {
    if (!text) return [];
    if (this.mode === 'answer') {
      if (this.trimLeadingWhitespaceAfterThink) {
        const trimmed = text.replace(/^\s+/, '');
        if (!trimmed) return [];
        this.trimLeadingWhitespaceAfterThink = false;
        return [trimmed];
      }
      return [text];
    }

    this.pending += text;
    const out: string[] = [];

    if (this.mode === 'detect') {
      const trimmedStart = this.pending.replace(/^\s+/, '');
      if (!trimmedStart) {
        if (this.pending.length > 32) {
          this.mode = 'answer';
          const flushed = this.pending;
          this.pending = '';
          out.push(flushed);
        }
        return out;
      }
      if ('<think>'.startsWith(trimmedStart) && trimmedStart.length < '<think>'.length) {
        return out;
      }
      if (trimmedStart.startsWith('<think>')) {
        this.pending = trimmedStart.slice('<think>'.length).replace(/^\r?\n/, '');
        this.mode = 'thinking';
      } else {
        this.mode = 'answer';
        const flushed = this.pending;
        this.pending = '';
        out.push(flushed);
        return out;
      }
    }

    if (this.mode === 'thinking') {
      const closeIdx = this.pending.indexOf('</think>');
      if (closeIdx !== -1) {
        const afterRaw = this.pending.slice(closeIdx + '</think>'.length);
        this.pending = '';
        this.mode = 'answer';
        const after = afterRaw.replace(/^\s+/, '');
        if (after) {
          out.push(after);
        } else {
          this.trimLeadingWhitespaceAfterThink = true;
        }
        return out;
      }
      // Retain up to 7 trailing chars so a split `</think>` tag across chunks still matches.
      if (this.pending.length > 7) {
        this.pending = this.pending.slice(-7);
      }
    }

    return out;
  }

  flush(): string[] {
    if (!this.pending) return [];
    const leftover = this.pending;
    this.pending = '';
    if (this.mode === 'thinking') {
      return [];
    }
    this.mode = 'answer';
    return [leftover];
  }
}

interface LineBuffer {
  push(chunk: string): void;
  drain(flushRemainder?: boolean): string[];
}

function createLineBuffer(): LineBuffer {
  let pending = '';
  return {
    push(chunk: string) {
      pending += chunk;
    },
    drain(flushRemainder = false): string[] {
      const lines: string[] = [];
      let index = pending.indexOf('\n');
      while (index !== -1) {
        const line = pending.slice(0, index).trim();
        if (line) lines.push(line);
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
      if (flushRemainder) {
        const tail = pending.trim();
        pending = '';
        if (tail) lines.push(tail);
      }
      return lines;
    },
  };
}

interface SingleAttemptOptions {
  prompt: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
  env: Record<string, string | undefined>;
  onToken?: (token: string) => void;
}

interface SingleAttemptResult {
  status: 'success' | 'error' | 'cancelled';
  output?: string;
  error?: string;
  modelLoadMs?: number;
  providerConnectionMs?: number;
  firstTokenMs?: number;
  tokenThroughputTps?: number;
  outputTokens?: number;
  timedOut?: boolean;
  emittedAnyToken: boolean;
}

async function executeStreamingRequest(
  entry: FastModelCacheEntry,
  opts: SingleAttemptOptions,
): Promise<SingleAttemptResult> {
  if (opts.signal?.aborted) {
    return { status: 'cancelled', error: 'cancelled', emittedAnyToken: false };
  }

  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  if (opts.signal) {
    opts.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  timer.unref?.();

  const shouldDisableThinking =
    entry.supportsReasoningToggle === true || isReasoningModelId(entry.candidate.id);
  const baseSystemPrompt = opts.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const effectiveSystemPrompt =
    shouldDisableThinking &&
    !baseSystemPrompt.includes('/no_think') &&
    !baseSystemPrompt.includes('/think')
      ? `${baseSystemPrompt}\n/no_think`
      : baseSystemPrompt;

  const isOllama = entry.runtimeType === 'ollama';
  const apiKey =
    entry.runtimeType === 'lmstudio'
      ? opts.env.WAZIR_LMSTUDIO_API_KEY
      : entry.runtimeType === 'mlx'
        ? opts.env.WAZIR_MLX_API_KEY
        : undefined;

  const url = isOllama ? `${entry.baseUrl}/api/chat` : `${entry.baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const messages = [
    { role: 'system', content: effectiveSystemPrompt },
    { role: 'user', content: opts.prompt },
  ];

  const body = isOllama
    ? JSON.stringify({
        model: entry.candidate.id,
        messages,
        stream: true,
        options: {
          temperature: opts.temperature,
          num_predict: opts.maxTokens,
        },
      })
    : JSON.stringify({
        model: entry.candidate.id,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
      });

  const reqStart = performance.now();
  let emittedAnyToken = false;
  let providerConnectionMs: number | undefined;
  let firstTokenPerf: number | undefined;
  let firstTokenMs: number | undefined;
  let modelLoadMs: number | undefined = entry.candidate.loaded ? 0 : undefined;
  let reportedOutputTokens: number | undefined;
  let visibleChunkCount = 0;
  let output = '';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    const headersPerf = performance.now();
    providerConnectionMs = Math.max(0, headersPerf - reqStart);

    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => '');
      return {
        status: 'error',
        error: `Endpoint ${entry.endpoint} HTTP ${response.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`,
        providerConnectionMs,
        emittedAnyToken: false,
      };
    }

    const filter = new ThinkStreamFilter();
    const lineBuffer = createLineBuffer();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();

    const emitVisible = (chunk: string) => {
      if (!chunk) return;
      if (firstTokenPerf === undefined) {
        firstTokenPerf = performance.now();
        firstTokenMs = Math.max(0, firstTokenPerf - reqStart);
      }
      visibleChunkCount += 1;
      emittedAnyToken = true;
      output += chunk;
      opts.onToken?.(chunk);
    };

    const processLines = (lines: string[]) => {
      for (const line of lines) {
        if (isOllama) {
          let parsed: {
            message?: { content?: string };
            response?: string;
            done?: boolean;
            eval_count?: number;
            load_duration?: number;
            error?: string;
          };
          try {
            parsed = JSON.parse(line) as typeof parsed;
          } catch {
            continue;
          }
          if (parsed.error) {
            throw new Error(parsed.error);
          }
          const deltaText = parsed.message?.content ?? parsed.response;
          if (deltaText) {
            for (const visible of filter.push(deltaText)) {
              emitVisible(visible);
            }
          }
          if (parsed.done) {
            if (typeof parsed.eval_count === 'number' && parsed.eval_count > 0) {
              reportedOutputTokens = parsed.eval_count;
            }
            if (typeof parsed.load_duration === 'number' && Number.isFinite(parsed.load_duration)) {
              modelLoadMs = Math.max(0, parsed.load_duration / 1_000_000);
            }
          }
        } else {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let chunk: {
            error?: { message?: string } | string;
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            usage?: { completion_tokens?: number };
          };
          try {
            chunk = JSON.parse(payload) as typeof chunk;
          } catch {
            continue;
          }
          if (chunk.error) {
            const msg = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? JSON.stringify(chunk.error));
            throw new Error(msg);
          }
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) {
            for (const visible of filter.push(content)) {
              emitVisible(visible);
            }
          }
          if (typeof chunk.usage?.completion_tokens === 'number' && chunk.usage.completion_tokens > 0) {
            reportedOutputTokens = chunk.usage.completion_tokens;
          }
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer.push(decoder.decode(value, { stream: true }));
      processLines(lineBuffer.drain(false));
    }
    const tail = decoder.decode();
    if (tail) lineBuffer.push(tail);
    processLines(lineBuffer.drain(true));
    for (const flushed of filter.flush()) {
      emitVisible(flushed);
    }

    if (!output.trim()) {
      return {
        status: 'error',
        error: `Model '${entry.candidate.id}' returned an empty response.`,
        modelLoadMs,
        providerConnectionMs,
        firstTokenMs,
        emittedAnyToken,
      };
    }

    const streamEndPerf = performance.now();
    const outputTokens = reportedOutputTokens ?? Math.max(1, Math.ceil(output.trim().length / 4));
    const decodeWindowMs =
      visibleChunkCount > 1 && firstTokenPerf !== undefined
        ? Math.max(1, streamEndPerf - firstTokenPerf)
        : Math.max(1, streamEndPerf - headersPerf);
    const tokenThroughputTps = Number((outputTokens / (decodeWindowMs / 1000)).toFixed(2));

    return {
      status: 'success',
      output,
      modelLoadMs,
      providerConnectionMs,
      firstTokenMs,
      tokenThroughputTps,
      outputTokens,
      emittedAnyToken,
    };
  } catch (err) {
    if (opts.signal?.aborted) {
      return {
        status: 'cancelled',
        error: 'cancelled',
        output: output || undefined,
        providerConnectionMs,
        firstTokenMs,
        emittedAnyToken,
      };
    }
    if (timedOut) {
      return {
        status: 'error',
        error: `Fast local LLM request to '${entry.candidate.id}' timed out after ${opts.timeoutMs}ms`,
        timedOut: true,
        providerConnectionMs,
        firstTokenMs,
        emittedAnyToken,
      };
    }
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      providerConnectionMs,
      firstTokenMs,
      emittedAnyToken,
    };
  } finally {
    clearTimeout(timer);
    if (opts.signal) {
      opts.signal.removeEventListener('abort', onParentAbort);
    }
  }
}

async function runHostSequentialBenchmarks(
  entries: FastModelCacheEntry[],
  timeoutMs: number,
  env: Record<string, string | undefined>,
  errors: string[],
): Promise<number> {
  const byHost = new Map<string, FastModelCacheEntry[]>();
  for (const entry of entries) {
    const key = normalizeHostKey(entry.baseUrl);
    let bucket = byHost.get(key);
    if (!bucket) {
      bucket = [];
      byHost.set(key, bucket);
    }
    bucket.push(entry);
  }

  let successCount = 0;
  await Promise.all(
    [...byHost.values()].map(async (hostEntries) => {
      for (const entry of hostEntries) {
        const res = await executeStreamingRequest(entry, {
          prompt: 'Reply with OK',
          systemPrompt: 'Answer directly.\n/no_think',
          maxTokens: 16,
          temperature: 0,
          timeoutMs,
          env,
        });
        if (res.status === 'success' && res.output?.trim()) {
          entry.candidate.measuredTtftMs =
            res.firstTokenMs !== undefined ? Number(res.firstTokenMs.toFixed(2)) : undefined;
          entry.candidate.measuredTps = res.tokenThroughputTps;
          entry.candidate.health = 'healthy';
          entry.candidate.available = true;
          entry.updatedAt = new Date().toISOString();
          successCount += 1;
        } else {
          entry.candidate.health = 'unavailable';
          entry.candidate.available = false;
          errors.push(`${entry.candidate.id} (${entry.endpoint}): ${res.error ?? 'benchmark failed'}`);
        }
      }
    }),
  );

  return successCount;
}

export async function benchmarkFastLocalModels(options?: {
  wazirHome?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  includeFleet?: boolean;
  forceRefresh?: boolean;
}): Promise<FastLlmBenchmarkResult> {
  const env = options?.env ?? process.env;
  const discovered = await discoverFastLocalEndpoints({
    wazirHome: options?.wazirHome,
    env,
    timeoutMs: options?.timeoutMs !== undefined ? Math.min(options.timeoutMs, 1500) : undefined,
    includeFleet: options?.includeFleet,
  });

  const nonEmbeddingEntries = discovered.filter((entry) => !isEmbeddingCandidate(entry.candidate));
  const loadedEntries = nonEmbeddingEntries.filter(
    (entry) => entry.candidate.loaded === true || entry.candidate.state === 'READY' || entry.candidate.state === 'LOADED',
  );
  const unloadedEntries = nonEmbeddingEntries.filter((entry) => !loadedEntries.includes(entry));

  const benchmarkTimeoutMs = options?.timeoutMs ?? 4500;
  const errors: string[] = [];

  let loadedSuccesses = 0;
  if (loadedEntries.length > 0) {
    loadedSuccesses = await runHostSequentialBenchmarks(loadedEntries, benchmarkTimeoutMs, env, errors);
  }

  if (loadedSuccesses === 0 && unloadedEntries.length > 0) {
    const smallUnloaded = unloadedEntries
      .map((entry) => ({
        entry,
        paramB: parseParameterBillions(entry.candidate.parameters, entry.candidate.id),
      }))
      .filter((item) => item.paramB !== undefined && item.paramB <= 10)
      .sort((a, b) => (a.paramB ?? 99) - (b.paramB ?? 99))
      .slice(0, 2)
      .map((item) => item.entry);

    if (smallUnloaded.length > 0) {
      await runHostSequentialBenchmarks(smallUnloaded, benchmarkTimeoutMs, env, errors);
    }
  }

  const selection = selectFastLocalModel(
    nonEmbeddingEntries.map((entry) => entry.candidate),
    { env },
  );
  const selectedEntry = selection.selected
    ? nonEmbeddingEntries.find((entry) => entry.candidate === selection.selected)
    : undefined;

  await saveCachedFastModels(nonEmbeddingEntries, options?.wazirHome).catch(() => undefined);

  return {
    entries: nonEmbeddingEntries,
    ...(selectedEntry ? { selected: selectedEntry } : {}),
    benchmarkedAt: new Date().toISOString(),
    errors,
  };
}

function recordObservedFastModelMetrics(
  entries: FastModelCacheEntry[],
  targetEntry: FastModelCacheEntry,
  result: Pick<SingleAttemptResult, 'status' | 'firstTokenMs' | 'tokenThroughputTps'>,
  wazirHome?: string,
): void {
  if (result.status === 'success') {
    targetEntry.candidate.health = 'healthy';
    targetEntry.candidate.available = true;
    if (typeof result.firstTokenMs === 'number' && Number.isFinite(result.firstTokenMs)) {
      targetEntry.candidate.measuredTtftMs = Number(result.firstTokenMs.toFixed(2));
    }
    if (typeof result.tokenThroughputTps === 'number' && Number.isFinite(result.tokenThroughputTps)) {
      targetEntry.candidate.measuredTps = result.tokenThroughputTps;
    }
    targetEntry.updatedAt = new Date().toISOString();
  } else if (result.status === 'error') {
    targetEntry.candidate.health = 'unavailable';
    targetEntry.candidate.available = false;
    targetEntry.updatedAt = new Date().toISOString();
  }
  const cachePath = getFastModelCachePath(wazirHome);
  memoryModelCache.set(cachePath, {
    mtimeMs: null,
    size: null,
    entries: entries.map(cloneCacheEntry),
  });
  void saveCachedFastModels(entries, wazirHome).catch(() => undefined);
}

const activeWarmups = new Map<string, Promise<FastModelCacheEntry[]>>();

/**
 * Triggers non-blocking background discovery of local/fleet fast endpoints so Tier 0 stays instant
 * while Tier 2 warm cache is ready before the first conversational query.
 */
export function triggerBackgroundFastModelWarmup(options?: {
  wazirHome?: string;
  env?: Record<string, string | undefined>;
}): Promise<FastModelCacheEntry[]> {
  const env = options?.env ?? process.env;
  if (env.WAZIR_SKIP_RUNTIME_DISCOVERY === '1') {
    return Promise.resolve([]);
  }
  const home = resolveWazirHome(options?.wazirHome, env);
  const existing = activeWarmups.get(home);
  if (existing) return existing;

  const job = (async () => {
    try {
      const entries = await discoverFastLocalEndpoints({
        wazirHome: home,
        env,
        timeoutMs: 900,
      });
      if (entries.length > 0) {
        const cachedByKey = new Map<string, FastModelCacheEntry>(
          getWarmCachedFastModels(home, env).map((e) => [`${e.baseUrl}|${e.candidate.id}`, e]),
        );
        for (const entry of entries) {
          const prev = cachedByKey.get(`${entry.baseUrl}|${entry.candidate.id}`);
          if (prev?.candidate.measuredTtftMs !== undefined && entry.candidate.measuredTtftMs === undefined) {
            entry.candidate.measuredTtftMs = prev.candidate.measuredTtftMs;
            entry.candidate.measuredTps = prev.candidate.measuredTps;
          }
        }
        await saveCachedFastModels(entries, home).catch(() => undefined);
      }
      return entries;
    } catch {
      return [];
    } finally {
      activeWarmups.delete(home);
    }
  })();
  activeWarmups.set(home, job);
  return job;
}

export async function streamFastLocalCompletion(
  request: string,
  options?: StreamFastLocalCompletionOptions,
): Promise<StreamFastLocalCompletionResult> {
  if (options?.signal?.aborted) {
    return {
      status: 'cancelled',
      error: 'cancelled',
      modelSelectionMs: 0,
    };
  }

  const env = options?.env ?? process.env;
  const config = readFastConfig(options?.wazirHome, env);
  const localOnly = options?.localOnly ?? (config.routing?.mode?.trim().toLowerCase() === 'local_only');
  const overrideModel = resolveConfiguredFastModelOverride({
    sessionModel: options?.sessionModel,
    wazirHome: options?.wazirHome,
    env,
  });

  const selStart = performance.now();
  let entries = getWarmCachedFastModels(options?.wazirHome, env);
  let usedWarmCache = entries.length > 0;

  if (!usedWarmCache) {
    entries = await discoverFastLocalEndpoints({
      wazirHome: options?.wazirHome,
      env,
      timeoutMs: 900,
    });
    if (entries.length > 0) {
      await saveCachedFastModels(entries, options?.wazirHome).catch(() => undefined);
    }
  }

  let selection = selectFastLocalModel(
    entries.map((entry) => entry.candidate),
    {
      overrideModel,
      env,
      localOnly,
      strictOverride: true,
    },
  );

  // If an explicit model override missed warm cache, do one fresh discovery pass before failing closed.
  if (overrideModel && !selection.selected && usedWarmCache) {
    const freshEntries = await discoverFastLocalEndpoints({
      wazirHome: options?.wazirHome,
      env,
      timeoutMs: 900,
    });
    if (freshEntries.length > 0) {
      entries = freshEntries;
      await saveCachedFastModels(entries, options?.wazirHome).catch(() => undefined);
      selection = selectFastLocalModel(
        entries.map((entry) => entry.candidate),
        {
          overrideModel,
          env,
          localOnly,
          strictOverride: true,
        },
      );
    }
  }

  const modelSelectionMs = Math.max(0, performance.now() - selStart);

  if (!selection.selected) {
    if (overrideModel) {
      return {
        status: 'error',
        error: `Requested fast model '${overrideModel}' is not registered or reachable on local/fleet endpoints.`,
        modelSelectionMs,
      };
    }
    return {
      status: 'error',
      error: 'No fast local LLM is reachable in this environment. Start LM Studio, Ollama, or MLX, or configure a fleet host.',
      modelSelectionMs,
    };
  }

  const entryByCandidate = new Map<FastModelCandidate, FastModelCacheEntry>(
    entries.map((entry) => [entry.candidate, entry]),
  );
  const primaryEntry = entryByCandidate.get(selection.selected);
  if (!primaryEntry) {
    return {
      status: 'error',
      error: 'No fast local LLM is reachable in this environment. Start LM Studio, Ollama, or MLX, or configure a fleet host.',
      modelSelectionMs,
    };
  }

  const timeoutMs = options?.timeoutMs ?? 30_000;
  const maxTokens = options?.maxTokens ?? 512;
  const systemPrompt = options?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const hasFallback = !overrideModel && selection.ranked.some((item) => item.candidate !== primaryEntry.candidate);
  const primaryTimeoutMs =
    options?.timeoutMs ??
    (hasFallback && primaryEntry.candidate.measuredTtftMs === undefined ? 5_500 : timeoutMs);

  const primaryResult = await executeStreamingRequest(primaryEntry, {
    prompt: request,
    systemPrompt,
    maxTokens,
    temperature: 0.2,
    timeoutMs: primaryTimeoutMs,
    signal: options?.signal,
    env,
    onToken: options?.onToken,
  });

  if (primaryResult.status === 'success') {
    recordObservedFastModelMetrics(entries, primaryEntry, primaryResult, options?.wazirHome);
    return {
      status: 'success',
      output: primaryResult.output,
      model: primaryEntry.candidate.id,
      provider: primaryEntry.candidate.provider,
      endpoint: primaryEntry.endpoint,
      modelSelectionMs,
      modelLoadMs: primaryResult.modelLoadMs,
      providerConnectionMs: primaryResult.providerConnectionMs,
      firstTokenMs: primaryResult.firstTokenMs,
      tokenThroughputTps: primaryResult.tokenThroughputTps,
      outputTokens: primaryResult.outputTokens,
    };
  }

  if (primaryResult.status === 'cancelled' || options?.signal?.aborted) {
    return {
      status: 'cancelled',
      output: primaryResult.output,
      error: primaryResult.error ?? 'cancelled',
      model: primaryEntry.candidate.id,
      provider: primaryEntry.candidate.provider,
      endpoint: primaryEntry.endpoint,
      modelSelectionMs,
      providerConnectionMs: primaryResult.providerConnectionMs,
      firstTokenMs: primaryResult.firstTokenMs,
    };
  }

  recordObservedFastModelMetrics(entries, primaryEntry, primaryResult, options?.wazirHome);

  // Fallback ONCE to the next highest-ranked eligible local candidate when no override was pinned
  // and no tokens were emitted to the caller yet. When warm cache fails, refresh live endpoints
  // first if the cached fallback isn't loaded so newly loaded local models are found immediately.
  if (!overrideModel && !primaryResult.emittedAnyToken) {
    const failedKeys = new Set<string>([`${primaryEntry.baseUrl}|${primaryEntry.candidate.id}`]);
    const cachedFallbackCandidate = selection.ranked.find(
      (item) => item.candidate !== primaryEntry.candidate,
    )?.candidate;
    const cachedFallbackEntry = cachedFallbackCandidate
      ? entryByCandidate.get(cachedFallbackCandidate)
      : undefined;

    let fallbackEntry = cachedFallbackEntry;
    if (
      usedWarmCache &&
      env.WAZIR_SKIP_RUNTIME_DISCOVERY !== '1' &&
      (!fallbackEntry || !fallbackEntry.candidate.loaded)
    ) {
      const freshEntries = await discoverFastLocalEndpoints({
        wazirHome: options?.wazirHome,
        env,
        timeoutMs: 900,
      });
      if (freshEntries.length > 0) {
        entries = freshEntries;
        await saveCachedFastModels(entries, options?.wazirHome).catch(() => undefined);
        const freshMap = new Map<FastModelCandidate, FastModelCacheEntry>(
          entries.map((entry) => [entry.candidate, entry]),
        );
        const eligibleFresh = entries
          .filter((entry) => !failedKeys.has(`${entry.baseUrl}|${entry.candidate.id}`))
          .map((entry) => entry.candidate);
        const freshSelection = selectFastLocalModel(eligibleFresh, {
          env,
          localOnly,
        });
        if (freshSelection.selected) {
          fallbackEntry = freshMap.get(freshSelection.selected);
        }
      }
    }

    if (fallbackEntry && !failedKeys.has(`${fallbackEntry.baseUrl}|${fallbackEntry.candidate.id}`)) {
      const fallbackResult = await executeStreamingRequest(fallbackEntry, {
        prompt: request,
        systemPrompt,
        maxTokens,
        temperature: 0.2,
        timeoutMs,
        signal: options?.signal,
        env,
        onToken: options?.onToken,
      });

      if (fallbackResult.status === 'success') {
        recordObservedFastModelMetrics(entries, fallbackEntry, fallbackResult, options?.wazirHome);
        return {
          status: 'success',
          output: fallbackResult.output,
          model: fallbackEntry.candidate.id,
          provider: fallbackEntry.candidate.provider,
          endpoint: fallbackEntry.endpoint,
          modelSelectionMs,
          modelLoadMs: fallbackResult.modelLoadMs,
          providerConnectionMs: fallbackResult.providerConnectionMs,
          firstTokenMs: fallbackResult.firstTokenMs,
          tokenThroughputTps: fallbackResult.tokenThroughputTps,
          outputTokens: fallbackResult.outputTokens,
          fallbackFrom: primaryEntry.candidate.id,
        };
      }

      if (fallbackResult.status === 'cancelled' || options?.signal?.aborted) {
        return {
          status: 'cancelled',
          output: fallbackResult.output,
          error: fallbackResult.error ?? 'cancelled',
          model: fallbackEntry.candidate.id,
          provider: fallbackEntry.candidate.provider,
          endpoint: fallbackEntry.endpoint,
          modelSelectionMs,
          providerConnectionMs: fallbackResult.providerConnectionMs,
          firstTokenMs: fallbackResult.firstTokenMs,
          fallbackFrom: primaryEntry.candidate.id,
        };
      }

      recordObservedFastModelMetrics(entries, fallbackEntry, fallbackResult, options?.wazirHome);
      return {
        status: 'error',
        error: fallbackResult.error ?? primaryResult.error,
        model: fallbackEntry.candidate.id,
        provider: fallbackEntry.candidate.provider,
        endpoint: fallbackEntry.endpoint,
        modelSelectionMs,
        providerConnectionMs: fallbackResult.providerConnectionMs,
        firstTokenMs: fallbackResult.firstTokenMs,
        timedOut: fallbackResult.timedOut,
        fallbackFrom: primaryEntry.candidate.id,
      };
    }
  }

  return {
    status: 'error',
    error: primaryResult.error,
    model: primaryEntry.candidate.id,
    provider: primaryEntry.candidate.provider,
    endpoint: primaryEntry.endpoint,
    modelSelectionMs,
    providerConnectionMs: primaryResult.providerConnectionMs,
    firstTokenMs: primaryResult.firstTokenMs,
    timedOut: primaryResult.timedOut,
  };
}
