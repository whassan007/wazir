import { classifyHttpFailure, parseRetryAfterMs } from '@wazir/shared';
export interface RuntimeInfo {
  id: string;
  name: string;
  version: string;
  url?: string;
}

export interface DiscoveredModel {
  /** Runtime-local model id, e.g. 'qwen3-coder:latest' or 'nvidia/nemotron-3.5-super-vl-120b-a12b'. */
  id: string;
  name?: string;
  family?: string;
  parameters?: string;
  architecture?: string;
  /** Reported context window when the runtime provides it. */
  contextWindow?: number;
  /** Maximum output tokens supported by the model when known. */
  maxOutputTokens?: number;
  /** Known capabilities, when the runtime/model metadata allows inference. */
  capabilities?: string[];
  toolCalling?: boolean;
  structuredOutput?: boolean;
  vision?: boolean;
  audio?: boolean;
  embedding?: boolean;
  reasoning?: boolean;
  quantization?: string;
  weightBytes?: number;
}

export interface RuntimeCapabilities {
  chat: boolean;
  streaming: boolean;
  toolCalling: boolean;
  nativeToolCalling?: boolean;
  parallelToolCalling?: boolean;
  strictJsonSchema?: boolean;
  streamingToolCalls?: boolean;
  promptCaching?: boolean;
  promptCacheTelemetry?: boolean;
  cacheReadMetrics?: boolean;
  cacheWriteMetrics?: boolean;
  structuredOutput: boolean;
  vision: boolean;
  embeddings: boolean;
  reasoning: boolean;
  lifecycle?: { discovery: boolean; inspection: boolean; contextControl: boolean; estimate: boolean; readinessProbe: boolean };
  modelLoad: boolean;
  modelUnload: boolean;
  modelDownload: boolean;
  statefulChat: boolean;
  mcp: boolean;
  audioInput?: boolean;
  audioOutput?: boolean;
  realtimeStreaming?: boolean;
}

export interface CapabilityRequirements {
  chat?: boolean;
  toolCalling?: boolean;
  vision?: boolean;
  audioInput?: boolean;
  audioOutput?: boolean;
  realtimeStreaming?: boolean;
  structuredOutput?: boolean;
  minContextTokens?: number;
}

/**
 * Validates that a model or runtime satisfies explicit capability requirements,
 * preventing silent failures on unsupported modalities (e.g. audio/realtime).
 */
export function validateModelCapabilities(
  capabilities: Partial<RuntimeCapabilities> | undefined,
  requirements: CapabilityRequirements,
): { compatible: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!capabilities) {
    return { compatible: false, missing: Object.keys(requirements) };
  }
  if (requirements.chat && !capabilities.chat) missing.push('chat');
  if (requirements.toolCalling && !capabilities.toolCalling && !capabilities.nativeToolCalling) {
    missing.push('toolCalling');
  }
  if (requirements.vision && !capabilities.vision) missing.push('vision');
  if (requirements.audioInput && !capabilities.audioInput) missing.push('audioInput');
  if (requirements.audioOutput && !capabilities.audioOutput) missing.push('audioOutput');
  if (requirements.realtimeStreaming && !capabilities.realtimeStreaming) missing.push('realtimeStreaming');
  if (requirements.structuredOutput && !capabilities.structuredOutput) missing.push('structuredOutput');

  return { compatible: missing.length === 0, missing };
}

export function supportsNativeToolCalling(capabilities?: Partial<RuntimeCapabilities>): boolean {
  if (!capabilities) return false;
  return Boolean(capabilities.nativeToolCalling ?? capabilities.toolCalling);
}

export interface RuntimeDiagnostics {
  cliAvailable: boolean;
  serverRunning: boolean;
  endpoint: string;
  apiReachable: boolean;
  installedModels: number;
  loadedModels: number;
  readyModels: number;
  failureReason?: string;
  errorDetail?: string;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unavailable';
  message?: string;
  reason?: 'API_UNREACHABLE' | 'CONNECTION_REFUSED' | 'CONNECTION_TIMEOUT' | 'DNS_FAILURE' | 'SERVER_STOPPED' | 'INVALID_RESPONSE' | 'AUTH_REQUIRED' | 'API_VERSION_UNSUPPORTED';
  diagnostics?: RuntimeDiagnostics;
}

export interface ChatImageInput {
  /** Image URL or base64 data URI (e.g. 'data:image/png;base64,...'). */
  url: string;
  /** Optional media type when known (e.g. 'image/png', 'image/jpeg'). */
  mediaType?: string;
  /** Optional detail hint for OpenAI-compatible vision APIs ('auto' | 'low' | 'high'). */
  detail?: 'auto' | 'low' | 'high';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  /** Optional multimodal image inputs for vision-capable models. */
  images?: ChatImageInput[];
  /** role 'tool': id of the assistant tool call this result answers (native tool protocol). */
  toolCallId?: string;
  /** role 'assistant': tool calls the model made in this turn (native tool protocol). */
  toolCalls?: Array<{ id?: string; name: string; arguments: unknown }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerationExecutionLimits {
  /** Maximum HTTP model-request admissions for this generation, including retries. */
  maxModelCalls?: number;
  /** Absolute deadline, also usable across a remote worker boundary. */
  deadlineAt?: number;
}

export interface GenerationRequest {
  executionLimits?: GenerationExecutionLimits;
  /** Local cancellation; serialize executionLimits, not this signal, for remote workers. */
  signal?: AbortSignal;
  /** Controller-owned provider retry budget, never supplied by model output. */
  providerRetryPolicy?: Partial<import('@wazir/shared').RetryPolicy>;
  modelId: string;
  messages: ChatMessage[];
  /** Convenience: prepended as a system message before `messages`. */
  systemPrompt?: string;
  /** Convenience: appended as a user message after `messages`. */
  prompt?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Deterministic sampling seed when supported by the provider/model. */
  seed?: number;
  /** Context window to request from the runtime (num_ctx / context length). */
  contextTokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  /** Whether parallel tool calls are allowed when supported by the provider/model. */
  parallelToolCalls?: boolean;
  /** Reasoning/thinking control for models supporting thinking mode (e.g. Nemotron enable_thinking). */
  enableThinking?: boolean;
  /** Provider-specific extra request body fields (merged safely when supported by the model). */
  extraBody?: Record<string, unknown>;
  responseFormat?: { type: 'text' | 'json_object' | 'json_schema'; json_schema?: Record<string, unknown> };
  /** Host-generated id used for cancellation. */
  requestId?: string;
  /** Attribution for resource accounting (task, workload class, agent). Never sent to the model. */
  resourceContext?: { taskId?: string; workload?: string; agent?: string };
}

/**
 * Provenance of a prompt-cache metric. UNKNOWN = provider may support caching but
 * reported nothing; UNSUPPORTED = provider/runtime has no prompt cache. Neither is
 * ever rendered as zero.
 */
export type CacheMetricStatus = 'OBSERVED' | 'ESTIMATED' | 'UNKNOWN' | 'UNSUPPORTED';

export interface CacheMetricValue {
  value?: number;
  status: CacheMetricStatus;
}

export interface PromptCacheMetrics {
  inputTokens: CacheMetricValue;
  cacheReadTokens: CacheMetricValue;
  cacheWriteTokens: CacheMetricValue;
  provider?: string;
  source?: CacheMetricStatus;
  hit?: boolean;
}

function hasCacheValue(m: CacheMetricValue | undefined): m is CacheMetricValue & { value: number } {
  return !!m && (m.status === 'OBSERVED' || m.status === 'ESTIMATED') && typeof m.value === 'number' && Number.isFinite(m.value);
}

/** Overall provenance of cache savings: weakest link across read + input. */
export function promptCacheSource(cache: PromptCacheMetrics | undefined): CacheMetricStatus {
  if (!cache) return 'UNKNOWN';
  const r = cache.cacheReadTokens.status;
  if (r === 'UNSUPPORTED') return 'UNSUPPORTED';
  if (!hasCacheValue(cache.cacheReadTokens) || !hasCacheValue(cache.inputTokens)) return 'UNKNOWN';
  return r === 'OBSERVED' && cache.inputTokens.status === 'OBSERVED' ? 'OBSERVED' : 'ESTIMATED';
}

/** Cache read / input tokens, or undefined when not computable from real telemetry. */
export function promptCacheReuse(cache: PromptCacheMetrics | undefined): number | undefined {
  if (!cache || !hasCacheValue(cache.cacheReadTokens) || !hasCacheValue(cache.inputTokens)) return undefined;
  if (cache.inputTokens.value <= 0) return undefined;
  return Math.min(1, cache.cacheReadTokens.value / cache.inputTokens.value);
}

export interface RawTelemetryInput {
  provider: string;
  inputTokens?: number;
  usage?: Record<string, unknown> | null;
  stats?: Record<string, unknown> | null;
  headers?: Headers | Record<string, string | undefined> | null;
}

/**
 * Normalizes prompt-cache telemetry from local and remote runtimes.
 * If cache telemetry is unavailable or malformed, gracefully falls back to UNKNOWN
 * without failing inference.
 */
export function normalizePromptCacheTelemetry(input: RawTelemetryInput): PromptCacheMetrics {
  try {
    const rawInputTokens = typeof input.inputTokens === 'number' && Number.isFinite(input.inputTokens) && input.inputTokens >= 0
      ? input.inputTokens
      : (typeof (input.usage as any)?.prompt_tokens === 'number' && Number.isFinite((input.usage as any).prompt_tokens) && (input.usage as any).prompt_tokens >= 0
        ? (input.usage as any).prompt_tokens
        : (typeof (input.usage as any)?.inputTokens === 'number' && Number.isFinite((input.usage as any).inputTokens) && (input.usage as any).inputTokens >= 0
          ? (input.usage as any).inputTokens
          : undefined));

    const inputTokensMetric: CacheMetricValue = rawInputTokens !== undefined
      ? { value: rawInputTokens, status: 'OBSERVED' }
      : { value: undefined, status: 'UNKNOWN' };

    const usage = input.usage ?? {};
    const promptDetails = (usage as any).prompt_tokens_details ?? (usage as any).promptTokensDetails ?? {};

    // 1. Inspect cache read tokens across supported schema variants
    let rawRead: number | undefined;
    if (typeof promptDetails.cached_tokens === 'number' && Number.isFinite(promptDetails.cached_tokens) && promptDetails.cached_tokens >= 0) {
      rawRead = promptDetails.cached_tokens;
    } else if (typeof promptDetails.cachedTokens === 'number' && Number.isFinite(promptDetails.cachedTokens) && promptDetails.cachedTokens >= 0) {
      rawRead = promptDetails.cachedTokens;
    } else if (typeof (usage as any).cached_tokens === 'number' && Number.isFinite((usage as any).cached_tokens) && (usage as any).cached_tokens >= 0) {
      rawRead = (usage as any).cached_tokens;
    } else if (typeof (usage as any).cache_read_tokens === 'number' && Number.isFinite((usage as any).cache_read_tokens) && (usage as any).cache_read_tokens >= 0) {
      rawRead = (usage as any).cache_read_tokens;
    } else if (typeof (usage as any).cacheReadTokens === 'number' && Number.isFinite((usage as any).cacheReadTokens) && (usage as any).cacheReadTokens >= 0) {
      rawRead = (usage as any).cacheReadTokens;
    } else if (typeof (usage as any).prompt_cache_hit_tokens === 'number' && Number.isFinite((usage as any).prompt_cache_hit_tokens) && (usage as any).prompt_cache_hit_tokens >= 0) {
      rawRead = (usage as any).prompt_cache_hit_tokens;
    }

    // 2. Inspect runtime debug/statistics endpoints metadata
    const stats = input.stats ?? {};
    if (rawRead === undefined) {
      if (typeof (stats as any).cached_tokens === 'number' && Number.isFinite((stats as any).cached_tokens) && (stats as any).cached_tokens >= 0) {
        rawRead = (stats as any).cached_tokens;
      } else if (typeof (stats as any).cache_read_tokens === 'number' && Number.isFinite((stats as any).cache_read_tokens) && (stats as any).cache_read_tokens >= 0) {
        rawRead = (stats as any).cache_read_tokens;
      }
    }

    // 3. Inspect headers if available
    const getHeader = (name: string): string | undefined => {
      if (!input.headers) return undefined;
      if (typeof (input.headers as Headers).get === 'function') {
        return (input.headers as Headers).get(name) ?? undefined;
      }
      return (input.headers as Record<string, string | undefined>)[name] ??
        (input.headers as Record<string, string | undefined>)[name.toLowerCase()];
    };

    if (rawRead === undefined) {
      const headerRead = getHeader('x-cache-read-tokens') ?? getHeader('x-cached-tokens') ?? getHeader('x-cache-hit-tokens') ?? getHeader('x-prompt-cache-read-tokens');
      if (headerRead !== undefined) {
        const parsed = Number(headerRead);
        if (Number.isFinite(parsed) && parsed >= 0) {
          rawRead = parsed;
        }
      }
    }

    // 4. Inspect cache write tokens
    let rawWrite: number | undefined;
    if (typeof promptDetails.cache_creation_input_tokens === 'number' && Number.isFinite(promptDetails.cache_creation_input_tokens) && promptDetails.cache_creation_input_tokens >= 0) {
      rawWrite = promptDetails.cache_creation_input_tokens;
    } else if (typeof promptDetails.cacheCreationInputTokens === 'number' && Number.isFinite(promptDetails.cacheCreationInputTokens) && promptDetails.cacheCreationInputTokens >= 0) {
      rawWrite = promptDetails.cacheCreationInputTokens;
    } else if (typeof (usage as any).cache_write_tokens === 'number' && Number.isFinite((usage as any).cache_write_tokens) && (usage as any).cache_write_tokens >= 0) {
      rawWrite = (usage as any).cache_write_tokens;
    } else if (typeof (usage as any).cacheWriteTokens === 'number' && Number.isFinite((usage as any).cacheWriteTokens) && (usage as any).cacheWriteTokens >= 0) {
      rawWrite = (usage as any).cacheWriteTokens;
    } else if (typeof (stats as any).cache_write_tokens === 'number' && Number.isFinite((stats as any).cache_write_tokens) && (stats as any).cache_write_tokens >= 0) {
      rawWrite = (stats as any).cache_write_tokens;
    } else {
      const headerWrite = getHeader('x-cache-write-tokens') ?? getHeader('x-cache-creation-tokens') ?? getHeader('x-prompt-cache-write-tokens');
      if (headerWrite !== undefined) {
        const parsed = Number(headerWrite);
        if (Number.isFinite(parsed) && parsed >= 0) {
          rawWrite = parsed;
        }
      }
    }

    const hasReadTelemetry = rawRead !== undefined;
    const hasWriteTelemetry = rawWrite !== undefined;

    if (!hasReadTelemetry && !hasWriteTelemetry) {
      return {
        inputTokens: inputTokensMetric,
        cacheReadTokens: { value: undefined, status: 'UNKNOWN' },
        cacheWriteTokens: { value: undefined, status: 'UNKNOWN' },
        provider: input.provider,
        source: 'UNKNOWN',
        hit: undefined,
      };
    }

    const cacheReadMetric: CacheMetricValue = hasReadTelemetry
      ? { value: rawRead, status: 'OBSERVED' }
      : { value: undefined, status: 'UNKNOWN' };

    const cacheWriteMetric: CacheMetricValue = hasWriteTelemetry
      ? { value: rawWrite, status: 'OBSERVED' }
      : { value: undefined, status: 'UNKNOWN' };

    let hit: boolean | undefined = undefined;
    if (hasReadTelemetry) {
      hit = rawRead! > 0;
    } else {
      const headerHit = getHeader('x-cache-hit');
      if (headerHit === 'true' || headerHit === '1') hit = true;
      else if (headerHit === 'false' || headerHit === '0') hit = false;
      else if (typeof (stats as any).cache_hit === 'boolean') hit = (stats as any).cache_hit;
    }

    return {
      inputTokens: inputTokensMetric,
      cacheReadTokens: cacheReadMetric,
      cacheWriteTokens: cacheWriteMetric,
      provider: input.provider,
      source: 'OBSERVED',
      hit,
    };
  } catch {
    // Telemetry failure must NOT fail inference
    return {
      inputTokens: { value: typeof input.inputTokens === 'number' ? input.inputTokens : undefined, status: 'UNKNOWN' },
      cacheReadTokens: { value: undefined, status: 'UNKNOWN' },
      cacheWriteTokens: { value: undefined, status: 'UNKNOWN' },
      provider: input.provider,
      source: 'UNKNOWN',
      hit: undefined,
    };
  }
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Hidden reasoning tokens billed as output, when the provider reports them. */
  reasoningTokens?: number;
  promptCache?: PromptCacheMetrics;
}

/**
 * Rate-limit state read from provider response headers (OpenAI `x-ratelimit-*`, Anthropic
 * `anthropic-ratelimit-*`). Provider-reported, so authoritative for API rate limits only:
 * it says nothing about subscription quotas or billing.
 */
export interface RateLimitObservation {
  source: 'provider-headers';
  limitRequests?: number;
  remainingRequests?: number;
  limitTokens?: number;
  remainingTokens?: number;
  /** ISO timestamps. */
  resetRequestsAt?: string;
  resetTokensAt?: string;
}

export interface GenerationEvent {
  failureClass?: import('@wazir/shared').FailureClass;
  retryExhausted?: boolean;
  requestId?: string;
  /** 'reasoning': model thinking, streamed for progress only; never part of the answer. */
  type: 'token' | 'reasoning' | 'tool_call' | 'completed' | 'error' | 'retry' | 'attempt_started';
  /** Controller-assigned physical HTTP attempt identity; admission precedes dispatch. */
  attempt?: number;
  attemptId?: string;
  /** 'error' from an HTTP response: its status code. */
  status?: number;
  /** 'error': provider-requested wait (Retry-After), in milliseconds. */
  retryAfterMs?: number;
  /** 'completed' / 'error': rate-limit headers the provider returned, if any. */
  rateLimit?: RateLimitObservation;
  /** 'completed' only: provider finish reason (e.g. stop, tool_calls, length, content_filter), or 'cancelled' when the stream was aborted. */
  finishReason?: string;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  usage?: Usage;
  promptCache?: PromptCacheMetrics;
  error?: string;
  /** 'retry' only: which attempt is about to run (2 = first retry) and how long the backoff before it was. */
  retryAttempt?: number;
  retryDelayMs?: number;
}

export interface ModelLoadEstimate {
  totalMemoryBytes?: number;
  vramBytes?: number;
  weightBytes?: number;
  contextBytes?: number;
  overheadBytes?: number;
  source: 'RUNTIME' | 'HEURISTIC' | 'UNKNOWN';
  confidence: 'high' | 'medium' | 'low' | 'unknown';
}
export interface RuntimeModelInspection {
  modelId: string;
  instanceId?: string;
  loaded: boolean;
  effectiveContext?: number;
  memoryBytes?: number;
}
export interface ResourceEstimate {
  minMemoryGB?: number;
  minGpuGB?: number;
}

/**
 * The stable provider contract. Wazir core never depends on a concrete
 * runtime — only on this interface. Adapters are replaceable.
 */
export interface RuntimeAdapter {
  readonly id: string;
  readonly type: 'ollama' | 'lmstudio' | 'openai-compatible' | 'llama-cpp' | 'anthropic' | 'openai' | 'google' | 'nvidia' | 'other';

  discover(): Promise<RuntimeInfo>;
  healthCheck(): Promise<HealthStatus>;
  listModels(): Promise<DiscoveredModel[]>;
  getCapabilities(): Promise<RuntimeCapabilities>;

  generate(request: GenerationRequest): AsyncIterable<GenerationEvent>;

  loadModel?(modelId: string, options?: { contextTokens?: number }): Promise<void>;
  inspectModel?(modelId: string): Promise<RuntimeModelInspection>;
  probeModel?(modelId: string, contextTokens: number): Promise<boolean>;
  estimateModelLoad?(modelId: string, contextTokens: number): Promise<ModelLoadEstimate>;
  unloadModel?(modelId: string): Promise<void>;
  getLoadedModels?(): Promise<string[]>;
  estimateResources?(modelId: string): Promise<ResourceEstimate>;
  startServer?(): Promise<void>;

  cancel?(requestId: string): Promise<void>;
}

export * from './auth.js';

/**
 * Redacts API keys, Bearer tokens, and provider secret prefixes (e.g. nvapi-*, sk-*)
 * from error messages, logs, and diagnostic payloads.
 */
export function redactProviderSecrets(input: string, extraSecretValues: Array<string | undefined> = []): string {
  if (!input) return input;
  let redacted = input
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bnvapi-[A-Za-z0-9_-]{8,}\b/g, 'nvapi-[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[REDACTED]');
  for (const secret of extraSecretValues) {
    if (secret && secret.trim().length >= 6) {
      redacted = redacted.split(secret.trim()).join('[REDACTED]');
    }
  }
  return redacted;
}

const num = (v: string | null): number | undefined => {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Converts a reset value (RFC 3339 timestamp, seconds, or durations like "1m30s", "250ms") to ISO. */
function resetToIso(v: string | null, now: number): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) {
    const at = Date.parse(t);
    return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
  }
  if (/^\d+(\.\d+)?$/.test(t)) return new Date(now + Number(t) * 1000).toISOString();
  let ms = 0;
  let matched = false;
  for (const [, n, unit] of t.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    ms += Number(n) * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1);
  }
  return matched ? new Date(now + ms).toISOString() : undefined;
}

/** Reads OpenAI- or Anthropic-style rate-limit headers; undefined when none are present. */
export function readRateLimitHeaders(headers: Headers | undefined, now = Date.now()): RateLimitObservation | undefined {
  if (!headers) return undefined;
  const h = (name: string) => headers.get(name);
  const obs: RateLimitObservation = {
    source: 'provider-headers',
    limitRequests: num(h('x-ratelimit-limit-requests') ?? h('anthropic-ratelimit-requests-limit')),
    remainingRequests: num(h('x-ratelimit-remaining-requests') ?? h('anthropic-ratelimit-requests-remaining')),
    limitTokens: num(h('x-ratelimit-limit-tokens') ?? h('anthropic-ratelimit-tokens-limit')),
    remainingTokens: num(h('x-ratelimit-remaining-tokens') ?? h('anthropic-ratelimit-tokens-remaining')),
    resetRequestsAt: resetToIso(h('x-ratelimit-reset-requests') ?? h('anthropic-ratelimit-requests-reset'), now),
    resetTokensAt: resetToIso(h('x-ratelimit-reset-tokens') ?? h('anthropic-ratelimit-tokens-reset'), now),
  };
  const any = Object.entries(obs).some(([k, v]) => k !== 'source' && v !== undefined);
  return any ? obs : undefined;
}

/**
 * The error event for a failed HTTP response: status, failure class (auth, quota, rate
 * limit, context overflow, ...), Retry-After and rate-limit headers, plus a bounded body.
 */
export function httpFailureEvent(provider: string, response: Response, body: string, requestId?: string): GenerationEvent {
  const safeBody = redactProviderSecrets(body);
  const failureClass = classifyHttpFailure(response.status, safeBody);
  return {
    type: 'error',
    requestId,
    status: response.status,
    failureClass,
    retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
    rateLimit: readRateLimitHeaders(response.headers),
    error: `${provider} API error: HTTP ${response.status} ${safeBody.slice(0, 300)}`,
  };
}

export * from './generationControl.js';
export * from './auth.js';
