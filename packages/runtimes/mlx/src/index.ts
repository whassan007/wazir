import {
  controlledGeneration,
  formatOpenAIChatMessages,
  normalizePromptCacheTelemetry,
  type DiscoveredModel,
  type GenerationControl,
  type GenerationEvent,
  type GenerationRequest,
  type HealthStatus,
  type ModelLoadEstimate,
  type ResourceEstimate,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeInfo,
  type RuntimeModelInspection,
} from '@wazir/runtimes-interfaces';
import {
  classifyFailure,
  classifyHttpFailure,
  isProviderRetryable,
  providerRetryDecision,
  resolveRetryPolicy,
  waitForRetry,
} from '@wazir/shared';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MLX_DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1';
const DEFAULT_CONTEXT_WINDOW = 32_768;

interface OpenAIModel {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  max_model_len?: number;
}

interface StreamDelta {
  content?: string;
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface StreamChunk {
  choices?: Array<{
    delta?: StreamDelta;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  stats?: Record<string, unknown>;
}

interface CachedMLXMetadata {
  architecture?: string;
  contextWindow?: number;
  quantization?: string;
  quantizationBits?: number;
  weightBytes?: number;
  hiddenSize?: number;
  numLayers?: number;
  numAttentionHeads?: number;
  numKeyValueHeads?: number;
  vision?: boolean;
}

export interface MLXAdapterOptions {
  apiKey?: string;
  /** Optional explicit model ID passed to `mlx_lm.server --model <repo>` when `/v1/models` is empty or ambiguous. */
  defaultModel?: string;
  /** Override HuggingFace hub cache directory used for local config/weight inspection. */
  hfCacheDir?: string;
}

function normalizeMlxBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return MLX_DEFAULT_BASE_URL;
  try {
    const parsed = new URL(trimmed);
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/v1';
      return parsed.toString().replace(/\/+$/, '');
    }
  } catch {
    // Keep caller-supplied string when URL parsing fails (e.g. relative test mock URLs).
  }
  return trimmed;
}

function inferParameters(id: string): string | undefined {
  const match = /(?:^|[-_/])(\d+(?:\.\d+)?)\s*([bBmM])(?:$|[-_/])/i.exec(id);
  if (!match) return undefined;
  return `${match[1]}${match[2].toUpperCase()}`;
}

function parseParameterCount(id: string): number | undefined {
  const match = /(?:^|[-_/])(\d+(?:\.\d+)?)\s*([bBmM])(?:$|[-_/])/i.exec(id);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return match[2].toUpperCase() === 'B' ? n * 1e9 : n * 1e6;
}

function inferQuantization(id: string): { label?: string; bits?: number } {
  const lower = id.toLowerCase();
  const bitMatch = /(?:^|[-_/])(2|3|4|5|6|8)\s*bit(?:$|[-_/])/.exec(lower);
  if (bitMatch) {
    const bits = Number(bitMatch[1]);
    return { label: `${bits}bit`, bits };
  }
  const qMatch = /(?:^|[-_/])q(2|3|4|5|6|8)(?:_[0-9a-z_]+)?(?:$|[-_/])/.exec(lower);
  if (qMatch) {
    const bits = Number(qMatch[1]);
    return { label: `Q${bits}`, bits };
  }
  if (/(?:^|[-_/])bf16(?:$|[-_/])/.test(lower)) return { label: 'bf16', bits: 16 };
  if (/(?:^|[-_/])fp16(?:$|[-_/])/.test(lower)) return { label: 'fp16', bits: 16 };
  if (/(?:^|[-_/])fp8(?:$|[-_/])/.test(lower)) return { label: 'fp8', bits: 8 };
  return {};
}

function inferCapabilities(id: string): { toolCalling: boolean; reasoning: boolean; vision: boolean } {
  const lower = id.toLowerCase();
  const isEmbedding = /embed|bert|nomic|bge-|e5-/.test(lower);
  const toolCalling =
    !isEmbedding &&
    (/coder|code|qwen3|qwen2\.5|llama-3|mistral|mixtral|gemma-?[34]|deepseek|granite|nemotron|codestral|glm-4/.test(lower) ||
      true);
  const reasoning = /qwen3|deepseek-r1|.*-think|reasoner|qwq/.test(lower);
  const vision = /vl|vision|clip|gemma-?[34]|qwen3\.5|pixtral/.test(lower);
  return { toolCalling, reasoning, vision };
}

function resolveHfHubCacheDir(explicitDir?: string): string {
  if (explicitDir) return explicitDir;
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  if (process.env.HUGGINGFACE_HUB_CACHE) return process.env.HUGGINGFACE_HUB_CACHE;
  if (process.env.HF_HOME) return path.join(process.env.HF_HOME, 'hub');
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

function resolveSnapshotDir(modelId: string, hfCacheDir: string): string | undefined {
  if (path.isAbsolute(modelId) && existsSync(path.join(modelId, 'config.json'))) {
    return modelId;
  }
  if (!modelId.includes('/')) return undefined;
  const repoDir = path.join(hfCacheDir, `models--${modelId.replace(/\//g, '--')}`);
  const snapshotsDir = path.join(repoDir, 'snapshots');
  if (!existsSync(snapshotsDir)) return undefined;
  try {
    const mainRefPath = path.join(repoDir, 'refs', 'main');
    if (existsSync(mainRefPath)) {
      const rev = readFileSync(mainRefPath, 'utf8').trim();
      const candidate = path.join(snapshotsDir, rev);
      if (rev && existsSync(path.join(candidate, 'config.json'))) return candidate;
    }
    const entries = readdirSync(snapshotsDir);
    for (const entry of entries) {
      const candidate = path.join(snapshotsDir, entry);
      if (existsSync(path.join(candidate, 'config.json'))) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readCachedMLXMetadata(modelId: string, hfCacheDir: string): CachedMLXMetadata | undefined {
  const snapshotDir = resolveSnapshotDir(modelId, hfCacheDir);
  if (!snapshotDir) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path.join(snapshotDir, 'config.json'), 'utf8')) as Record<string, any>;
    const textCfg = (raw.text_config && typeof raw.text_config === 'object' ? raw.text_config : raw) as Record<string, any>;
    const numProp = (obj: Record<string, any>, key: string): number | undefined =>
      typeof obj[key] === 'number' && Number.isFinite(obj[key]) && obj[key] > 0 ? obj[key] : undefined;

    const contextWindow =
      numProp(textCfg, 'max_position_embeddings') ??
      numProp(raw, 'max_position_embeddings') ??
      numProp(textCfg, 'seq_length') ??
      numProp(raw, 'max_sequence_length');

    const quantObj = (raw.quantization ?? raw.quantization_config ?? textCfg.quantization) as Record<string, any> | undefined;
    const quantizationBits = quantObj ? numProp(quantObj, 'bits') : undefined;
    const quantization = quantizationBits ? `${quantizationBits}bit` : undefined;

    let weightBytes = 0;
    for (const file of readdirSync(snapshotDir)) {
      if (file.endsWith('.safetensors')) {
        try {
          weightBytes += statSync(path.join(snapshotDir, file)).size;
        } catch {
          // ignore broken symlink / transient cache entry
        }
      }
    }

    const architecture =
      (typeof raw.model_type === 'string' && raw.model_type) ||
      (Array.isArray(raw.architectures) && typeof raw.architectures[0] === 'string' ? raw.architectures[0] : undefined);

    return {
      architecture,
      contextWindow,
      quantization,
      quantizationBits,
      weightBytes: weightBytes > 0 ? weightBytes : undefined,
      hiddenSize: numProp(textCfg, 'hidden_size') ?? numProp(raw, 'hidden_size'),
      numLayers: numProp(textCfg, 'num_hidden_layers') ?? numProp(raw, 'num_hidden_layers'),
      numAttentionHeads: numProp(textCfg, 'num_attention_heads') ?? numProp(raw, 'num_attention_heads'),
      numKeyValueHeads:
        numProp(textCfg, 'num_key_value_heads') ??
        numProp(raw, 'num_key_value_heads') ??
        numProp(textCfg, 'num_attention_heads') ??
        numProp(raw, 'num_attention_heads'),
      vision: Boolean(raw.vision_config),
    };
  } catch {
    return undefined;
  }
}

/**
 * Stateful streaming splitter that separates leading `<think>...</think>` blocks emitted
 * inside `delta.content` (common on `mlx_lm.server` for Qwen3 / Qwen3.5 chat templates)
 * into `reasoning` chunks so chain-of-thought never leaks into final `token` content.
 */
class ThinkStreamFilter {
  private mode: 'detect' | 'thinking' | 'answer' = 'detect';
  private pending = '';

  push(text: string): Array<{ kind: 'reasoning' | 'token'; content: string }> {
    if (!text) return [];
    if (this.mode === 'answer') {
      return [{ kind: 'token', content: text }];
    }

    this.pending += text;
    const out: Array<{ kind: 'reasoning' | 'token'; content: string }> = [];

    if (this.mode === 'detect') {
      const trimmedStart = this.pending.replace(/^\s+/, '');
      if (!trimmedStart) {
        // Only whitespace seen so far; wait cleanly unless buffer grows large.
        if (this.pending.length > 32) {
          this.mode = 'answer';
          const flushed = this.pending;
          this.pending = '';
          out.push({ kind: 'token', content: flushed });
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
        out.push({ kind: 'token', content: flushed });
        return out;
      }
    }

    if (this.mode === 'thinking') {
      const closeIdx = this.pending.indexOf('</think>');
      if (closeIdx !== -1) {
        const thought = this.pending.slice(0, closeIdx);
        if (thought) out.push({ kind: 'reasoning', content: thought });
        const after = this.pending.slice(closeIdx + '</think>'.length).replace(/^\s*\r?\n/, '');
        this.pending = '';
        this.mode = 'answer';
        if (after) out.push({ kind: 'token', content: after });
        return out;
      }
      // Keep up to 7 chars buffered in case `</think>` straddles two SSE chunks.
      const safeLen = Math.max(0, this.pending.length - 7);
      if (safeLen > 0) {
        out.push({ kind: 'reasoning', content: this.pending.slice(0, safeLen) });
        this.pending = this.pending.slice(safeLen);
      }
    }

    return out;
  }

  flush(): Array<{ kind: 'reasoning' | 'token'; content: string }> {
    if (!this.pending) return [];
    const leftover = this.pending;
    this.pending = '';
    if (this.mode === 'thinking') {
      return [{ kind: 'reasoning', content: leftover }];
    }
    this.mode = 'answer';
    return [{ kind: 'token', content: leftover }];
  }
}

interface SSEBuffer {
  push(chunk: string): void;
  drain(): string[];
}

function createSSEBuffer(): SSEBuffer {
  let pending = '';
  return {
    push(chunk: string) {
      pending += chunk;
    },
    drain(): string[] {
      const payloads: string[] = [];
      let index = pending.indexOf('\n');
      while (index !== -1) {
        const line = pending.slice(0, index).trim();
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data) payloads.push(data);
        }
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
      return payloads;
    },
  };
}

export class MLXAdapter implements RuntimeAdapter {
  readonly id = 'mlx';
  readonly type = 'mlx' as const;
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly defaultModel?: string;
  private readonly hfCacheDir: string;
  private readonly controllers = new Map<string, AbortController>();
  private modelsCache?: { expiresAt: number; promise: Promise<OpenAIModel[]> };
  private readonly metadataCache = new Map<string, CachedMLXMetadata | null>();
  private activeModelId?: string;
  private activeContextTokens?: number;
  private unloadedModelIds = new Set<string>();
  private detectedCapabilities = {
    promptCacheTelemetry: false,
    cacheReadMetrics: false,
    cacheWriteMetrics: false,
  };

  constructor(baseURL: string = MLX_DEFAULT_BASE_URL, options: MLXAdapterOptions = {}) {
    this.baseURL = normalizeMlxBaseUrl(baseURL);
    this.apiKey = options.apiKey ?? (process.env.WAZIR_MLX_API_KEY || undefined);
    this.defaultModel = options.defaultModel ?? (process.env.WAZIR_MLX_MODEL || undefined);
    this.hfCacheDir = resolveHfHubCacheDir(options.hfCacheDir);
    if (this.defaultModel) {
      this.activeModelId = this.defaultModel;
    }
  }

  private headers(json = false): Record<string, string> {
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private getCachedMetadata(modelId: string): CachedMLXMetadata | undefined {
    if (this.metadataCache.has(modelId)) {
      return this.metadataCache.get(modelId) ?? undefined;
    }
    const meta = readCachedMLXMetadata(modelId, this.hfCacheDir);
    this.metadataCache.set(modelId, meta ?? null);
    return meta;
  }

  private async fetchModels(force = false): Promise<OpenAIModel[]> {
    const now = Date.now();
    if (!force && this.modelsCache && this.modelsCache.expiresAt > now) {
      return this.modelsCache.promise;
    }
    const promise = (async () => {
      const response = await fetch(`${this.baseURL}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) {
        throw new Error(`RUNTIME_UNAVAILABLE: MLX /models responded HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { data?: OpenAIModel[] };
      const list = Array.isArray(payload.data) ? [...payload.data] : [];
      if (this.defaultModel && !list.some((m) => m.id === this.defaultModel)) {
        list.unshift({ id: this.defaultModel, object: 'model', owned_by: 'mlx' });
      }
      if (!this.activeModelId && list.length === 1 && !this.unloadedModelIds.has(list[0].id)) {
        this.activeModelId = list[0].id;
      }
      return list;
    })();
    this.modelsCache = { expiresAt: now + 1500, promise };
    try {
      return await promise;
    } catch (err) {
      if (this.modelsCache?.promise === promise) {
        this.modelsCache = undefined;
      }
      throw err;
    }
  }

  async discover(): Promise<RuntimeInfo> {
    await this.fetchModels();
    return {
      id: this.id,
      name: 'MLX Server',
      version: 'v1',
      url: this.baseURL.replace(/\/v1$/, ''),
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    const diagnostics = {
      cliAvailable: false,
      serverRunning: false,
      endpoint: this.baseURL,
      apiReachable: false,
      installedModels: 0,
      loadedModels: 0,
      readyModels: 0,
      failureReason: '',
    };
    try {
      const response = await fetch(`${this.baseURL}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) {
        diagnostics.apiReachable = true;
        return {
          status: 'unavailable',
          message: `HTTP ${response.status}`,
          reason: 'INVALID_RESPONSE',
          diagnostics,
        };
      }
      diagnostics.apiReachable = true;
      diagnostics.serverRunning = true;
      const payload = (await response.json()) as { data?: OpenAIModel[] };
      if (!Array.isArray(payload.data)) {
        return { status: 'degraded', message: 'model inventory unavailable', diagnostics };
      }
      const ids = new Set(payload.data.map((m) => m.id));
      if (this.defaultModel) ids.add(this.defaultModel);
      diagnostics.installedModels = ids.size;
      diagnostics.readyModels = ids.size;
      if (!this.activeModelId && ids.size === 1) {
        const only = [...ids][0];
        if (!this.unloadedModelIds.has(only)) this.activeModelId = only;
      }
      diagnostics.loadedModels = this.activeModelId && ids.has(this.activeModelId) ? 1 : 0;
      return { status: 'healthy', diagnostics };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      const isTimeout = msg.includes('timeout');
      diagnostics.failureReason = msg;
      return {
        status: 'unavailable',
        message: msg,
        reason: isRefused ? 'CONNECTION_REFUSED' : isTimeout ? 'CONNECTION_TIMEOUT' : 'API_UNREACHABLE',
        diagnostics,
      };
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    let rawModels: OpenAIModel[];
    try {
      rawModels = await this.fetchModels();
    } catch {
      return [];
    }

    return rawModels.map((model) => {
      const inferred = inferCapabilities(model.id);
      const quant = inferQuantization(model.id);
      const cached = this.getCachedMetadata(model.id);
      const isEmbedding = /embed|bert|nomic|bge-|e5-/.test(model.id.toLowerCase());
      const contextWindow = model.max_model_len ?? cached?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const isLoaded = this.activeModelId === model.id && !this.unloadedModelIds.has(model.id);
      return {
        id: model.id,
        name: model.id,
        architecture: cached?.architecture,
        parameters: inferParameters(model.id),
        quantization: cached?.quantization ?? quant.label,
        contextWindow,
        contextLimitSource: model.max_model_len
          ? 'runtime-discovered'
          : cached?.contextWindow
            ? 'provider-documented'
            : 'default-unknown',
        weightBytes: cached?.weightBytes,
        capabilities: ['generalChat'],
        toolCalling: isEmbedding ? false : inferred.toolCalling,
        structuredOutput: !isEmbedding,
        vision: cached?.vision ?? inferred.vision,
        audio: false,
        embedding: isEmbedding,
        reasoning: inferred.reasoning,
        loaded: isLoaded,
        effectiveContext: isLoaded ? (this.activeContextTokens ?? contextWindow) : undefined,
      };
    });
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      chat: true,
      streaming: true,
      toolCalling: true,
      nativeToolCalling: true,
      parallelToolCalling: true,
      strictJsonSchema: false,
      streamingToolCalls: true,
      promptCaching: this.detectedCapabilities.promptCacheTelemetry,
      promptCacheTelemetry: this.detectedCapabilities.promptCacheTelemetry,
      cacheReadMetrics: this.detectedCapabilities.cacheReadMetrics,
      cacheWriteMetrics: this.detectedCapabilities.cacheWriteMetrics,
      structuredOutput: true,
      vision: false,
      embeddings: false,
      reasoning: true,
      lifecycle: {
        discovery: true,
        inspection: true,
        contextControl: false,
        estimate: true,
        readinessProbe: true,
      },
      modelLoad: true,
      modelUnload: true,
      modelDownload: true,
      statefulChat: false,
      mcp: false,
    };
  }

  async getLoadedModels(): Promise<string[]> {
    const models = await this.fetchModels();
    if (this.activeModelId && models.some((m) => m.id === this.activeModelId) && !this.unloadedModelIds.has(this.activeModelId)) {
      return [this.activeModelId];
    }
    return [];
  }

  async inspectModel(modelId: string): Promise<RuntimeModelInspection> {
    const models = await this.fetchModels();
    const match = models.find((m) => m.id === modelId);
    const cached = this.getCachedMetadata(modelId);
    const isLoaded = Boolean(match && this.activeModelId === modelId && !this.unloadedModelIds.has(modelId));
    const defaultCtx = match?.max_model_len ?? cached?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    return {
      modelId,
      instanceId: isLoaded ? modelId : undefined,
      loaded: isLoaded,
      effectiveContext: isLoaded ? (this.activeContextTokens ?? defaultCtx) : undefined,
      memoryBytes: cached?.weightBytes,
    };
  }

  async loadModel(modelId: string, options: { contextTokens?: number } = {}): Promise<void> {
    this.modelsCache = undefined;
    // `mlx_lm.server` loads (or hot-swaps) the requested model in `ModelProvider.load()`
    // upon receiving `/v1/chat/completions`, returning HTTP 200 once weights are resident.
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.headers(true),
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'OK' }],
        max_tokens: 1,
        stream: false,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`RUNTIME_LOAD_FAILED: MLX HTTP ${response.status} ${body.slice(0, 200)}`.trim());
    }
    await response.json().catch(() => undefined);
    this.unloadedModelIds.delete(modelId);
    this.activeModelId = modelId;
    const cached = this.getCachedMetadata(modelId);
    this.activeContextTokens = options.contextTokens ?? cached?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.modelsCache = undefined;
  }

  async unloadModel(modelId: string): Promise<void> {
    // `mlx_lm.server` has no REST unload endpoint; mark unloaded in adapter state so Wazir
    // lifecycle eviction/unload bookkeeping transitions cleanly and swaps on next loadModel().
    await this.fetchModels();
    this.unloadedModelIds.add(modelId);
    if (this.activeModelId === modelId) {
      this.activeModelId = undefined;
      this.activeContextTokens = undefined;
    }
    this.modelsCache = undefined;
  }

  async probeModel(modelId: string, contextTokens: number): Promise<boolean> {
    try {
      const state = await this.inspectModel(modelId);
      if (!state.loaded) return false;
      if (state.effectiveContext !== undefined && state.effectiveContext !== contextTokens) {
        return false;
      }
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.headers(true),
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Reply OK.' }],
          max_tokens: 1,
          stream: false,
        }),
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { choices?: unknown[]; usage?: Record<string, any>; stats?: Record<string, any> };
      if (data.usage || data.stats) {
        try {
          const pc = normalizePromptCacheTelemetry({
            provider: 'mlx',
            usage: data.usage,
            stats: data.stats,
            headers: response.headers,
          });
          if (pc.cacheReadTokens.status === 'OBSERVED') {
            this.detectedCapabilities.promptCacheTelemetry = true;
            this.detectedCapabilities.cacheReadMetrics = true;
          }
          if (pc.cacheWriteTokens.status === 'OBSERVED') {
            this.detectedCapabilities.cacheWriteMetrics = true;
          }
        } catch {
          // Telemetry detection failure must never affect readiness probing.
        }
      }
      this.activeModelId = modelId;
      this.activeContextTokens = contextTokens;
      return Array.isArray(data.choices) && data.choices.length > 0;
    } catch {
      return false;
    }
  }

  async estimateModelLoad(modelId: string, contextTokens: number): Promise<ModelLoadEstimate> {
    const cached = this.getCachedMetadata(modelId);
    const quant = inferQuantization(modelId);
    const bits = cached?.quantizationBits ?? quant.bits ?? 6;
    const paramCount = parseParameterCount(modelId);
    const weightBytes =
      cached?.weightBytes ??
      (paramCount !== undefined ? Math.round((paramCount * bits) / 8) : 6 * 1024 ** 3);

    let contextBytes: number;
    if (
      cached?.numLayers &&
      cached?.numAttentionHeads &&
      cached?.numKeyValueHeads &&
      cached?.hiddenSize
    ) {
      // FP16 KV cache: 2 (K+V) * 2 bytes * layers * kv_heads * head_dim * tokens
      const headDim = cached.hiddenSize / cached.numAttentionHeads;
      contextBytes = Math.round(2 * 2 * cached.numLayers * cached.numKeyValueHeads * headDim * contextTokens);
    } else {
      // Conservative ~128 KiB/token KV cache heuristic for 7B-14B class models
      const scale = paramCount ? Math.max(0.5, Math.min(4, paramCount / 8e9)) : 1;
      contextBytes = Math.round(128 * 1024 * scale * contextTokens);
    }

    const overheadBytes = Math.round(Math.max(512 * 1024 ** 2, weightBytes * 0.12));
    const totalMemoryBytes = weightBytes + contextBytes + overheadBytes;
    return {
      weightBytes,
      contextBytes,
      overheadBytes,
      totalMemoryBytes,
      vramBytes: totalMemoryBytes,
      source: 'HEURISTIC',
      confidence: cached?.weightBytes ? 'medium' : paramCount ? 'low' : 'low',
    };
  }

  async estimateResources(modelId: string): Promise<ResourceEstimate> {
    const e = await this.estimateModelLoad(modelId, 4096);
    return {
      minMemoryGB: e.totalMemoryBytes !== undefined ? e.totalMemoryBytes / 1024 ** 3 : undefined,
    };
  }

  generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    return controlledGeneration(request, (generation, control) => this.generateControlled(generation, control));
  }

  private async *generateControlled(
    request: GenerationRequest,
    control: GenerationControl,
  ): AsyncIterable<GenerationEvent> {
    const controller = control.controller;
    const requestId = control.requestId;
    this.controllers.set(requestId, controller);
    const resolvedModelId = request.modelId || this.activeModelId || this.defaultModel || 'default_model';
    const messages = formatOpenAIChatMessages(request);

    let response: Response | undefined;
    const configuredRetryPolicy = resolveRetryPolicy({
      maxRetries: 3,
      initialDelayMs: 250,
      maxDelayMs: 8000,
      ...request.providerRetryPolicy,
    });
    const retryPolicy = {
      ...configuredRetryPolicy,
      maxRetries: control.capRetries(configuredRetryPolicy.maxRetries),
    };
    const maxAttempts = retryPolicy.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      yield control.startAttempt();
      try {
        control.assertActive();
        const candidate = await fetch(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: this.headers(true),
          body: JSON.stringify({
            model: resolvedModelId,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            temperature: request.temperature,
            top_p: request.topP,
            max_tokens: request.maxTokens,
            tools: request.tools?.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            parallel_tool_calls:
              request.tools?.length && request.parallelToolCalls !== undefined
                ? request.parallelToolCalls
                : undefined,
            tool_choice: request.toolChoice,
            response_format: request.responseFormat,
          }),
          signal: controller.signal,
        });
        const decision = providerRetryDecision(classifyFailure({ status: candidate.status }), attempt, retryPolicy);
        if (decision.retry) {
          await candidate.text().catch(() => undefined);
          yield {
            type: 'retry',
            requestId,
            failureClass: decision.failureClass,
            retryAttempt: decision.attempt,
            retryDelayMs: decision.delayMs,
            error: `HTTP ${candidate.status}`,
          };
          await waitForRetry(decision.delayMs, controller.signal);
          continue;
        }
        response = candidate;
        break;
      } catch (error) {
        if (controller.signal.aborted) {
          this.controllers.delete(requestId);
          yield { type: 'error', requestId, failureClass: 'CANCELLED', error: 'cancelled' };
          return;
        }
        const decision = providerRetryDecision(classifyFailure(error), attempt, retryPolicy);
        if (decision.retry) {
          yield {
            type: 'retry',
            requestId,
            failureClass: decision.failureClass,
            retryAttempt: decision.attempt,
            retryDelayMs: decision.delayMs,
            error: error instanceof Error ? error.message : String(error),
          };
          try {
            await waitForRetry(decision.delayMs, controller.signal);
          } catch {
            this.controllers.delete(requestId);
            yield { type: 'error', requestId, failureClass: 'CANCELLED', error: 'cancelled' };
            return;
          }
          continue;
        }
        this.controllers.delete(requestId);
        yield {
          type: 'error',
          requestId,
          retryAttempt: attempt,
          failureClass: decision.failureClass,
          retryExhausted: decision.reason === 'retry_budget_exhausted',
          error: error instanceof Error ? error.message : String(error),
        };
        return;
      }
    }

    if (!response || !response.ok || !response.body) {
      const body = (await response?.text().catch(() => '')) ?? '';
      this.controllers.delete(requestId);
      const failureClass = response ? classifyHttpFailure(response.status, body) : classifyFailure({ status: undefined });
      yield {
        type: 'error',
        requestId,
        status: response?.status,
        retryAttempt: maxAttempts,
        failureClass,
        retryExhausted: isProviderRetryable(failureClass),
        error: `MLX Server API error: HTTP ${response?.status ?? 'unknown'} ${body.slice(0, 300)}`,
      };
      return;
    }

    this.unloadedModelIds.delete(resolvedModelId);
    this.activeModelId = resolvedModelId;

    let full = '';
    let usage: GenerationEvent['usage'];
    let rawUsageChunk: Record<string, any> | undefined;
    let rawStatsChunk: Record<string, any> | undefined;
    const responseHeaders = response.headers;
    const pendingToolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
    let finishReason: string | undefined;
    let streamDone = false;
    const buffer = createSSEBuffer();
    const thinkFilter = new ThinkStreamFilter();

    try {
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer.push(decoder.decode(value, { stream: true }));
        for (const payload of buffer.drain()) {
          if (payload === '[DONE]') {
            streamDone = true;
            continue;
          }
          let chunk: StreamChunk;
          try {
            chunk = JSON.parse(payload) as StreamChunk;
          } catch {
            throw new Error('INVALID_PROVIDER_STREAM: malformed JSON chunk');
          }

          const finish = chunk.choices?.[0]?.finish_reason;
          if (finish) finishReason = finish;
          const delta = chunk.choices?.[0]?.delta;
          const explicitReasoning = delta?.reasoning_content ?? delta?.reasoning;
          if (explicitReasoning) {
            yield { type: 'reasoning', content: explicitReasoning };
          }
          if (delta?.content) {
            for (const segment of thinkFilter.push(delta.content)) {
              if (segment.kind === 'reasoning') {
                yield { type: 'reasoning', content: segment.content };
              } else {
                full += segment.content;
                yield { type: 'token', content: segment.content };
              }
            }
          }
          for (const call of delta?.tool_calls ?? []) {
            const entry = pendingToolCalls.get(call.index) ?? { arguments: '' };
            if (call.id) entry.id = call.id;
            if (call.function?.name) entry.name = call.function.name;
            if (call.function?.arguments) entry.arguments += call.function.arguments;
            pendingToolCalls.set(call.index, entry);
          }

          if (chunk.usage) {
            rawUsageChunk = chunk.usage;
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens,
            };
          }
          if (chunk.stats) {
            rawStatsChunk = chunk.stats as Record<string, any>;
          }
        }
      }

      if (!streamDone && !finishReason) {
        throw new Error('INCOMPLETE_PROVIDER_STREAM: missing completion marker');
      }

      for (const segment of thinkFilter.flush()) {
        if (segment.kind === 'reasoning') {
          yield { type: 'reasoning', content: segment.content };
        } else {
          full += segment.content;
          yield { type: 'token', content: segment.content };
        }
      }

      for (const [index, entry] of [...pendingToolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        let parsed: unknown = entry.arguments;
        try {
          parsed = entry.arguments ? JSON.parse(entry.arguments) : {};
        } catch {
          parsed = entry.arguments;
        }
        yield {
          type: 'tool_call',
          toolCallId: entry.id ?? `tool-${index}`,
          toolName: entry.name ?? 'unknown',
          toolInput: parsed,
        };
      }

      const promptCache = normalizePromptCacheTelemetry({
        provider: 'mlx',
        inputTokens: usage?.inputTokens ?? 0,
        usage: rawUsageChunk,
        stats: rawStatsChunk,
        headers: responseHeaders,
      });

      if (promptCache.cacheReadTokens.status === 'OBSERVED') {
        this.detectedCapabilities.promptCacheTelemetry = true;
        this.detectedCapabilities.cacheReadMetrics = true;
      }
      if (promptCache.cacheWriteTokens.status === 'OBSERVED') {
        this.detectedCapabilities.cacheWriteMetrics = true;
      }

      yield {
        type: 'completed',
        finishReason,
        content: full,
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          totalTokens: usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)),
          cacheReadTokens: promptCache.cacheReadTokens.value,
          cacheWriteTokens: promptCache.cacheWriteTokens.value,
          promptCache,
        },
        promptCache,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        const promptCache = normalizePromptCacheTelemetry({
          provider: 'mlx',
          inputTokens: usage?.inputTokens ?? 0,
          usage: rawUsageChunk,
          stats: rawStatsChunk,
          headers: responseHeaders,
        });
        yield {
          type: 'completed',
          finishReason: 'cancelled',
          content: full,
          usage: {
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            totalTokens: usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)),
            cacheReadTokens: promptCache.cacheReadTokens.value,
            cacheWriteTokens: promptCache.cacheWriteTokens.value,
            promptCache,
          },
          promptCache,
        };
      } else {
        yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      controller.abort();
      this.controllers.delete(requestId);
    }
  }

  async cancel(requestId: string): Promise<void> {
    this.controllers.get(requestId)?.abort();
  }
}

export function createMLXAdapter(baseURL?: string, options?: MLXAdapterOptions): RuntimeAdapter {
  return new MLXAdapter(baseURL, options);
}
