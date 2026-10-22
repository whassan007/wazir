import type {
  AuthLoginResult,
  AuthMethod,
  AuthStatus,
  ChatMessage,
  DiscoveredModel,
  GenerationControl,
  GenerationEvent,
  GenerationRequest,
  HealthStatus,
  ProviderAuthAdapter,
  ProviderCredentialSource,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeInfo,
  StoredCredential,
  Usage,
} from '@wazir/runtimes-interfaces';
import {
  controlledGeneration,
  httpFailureEvent,
  isStoredCredential,
  normalizePromptCacheTelemetry,
  readRateLimitHeaders,
  redactProviderSecrets,
} from '@wazir/runtimes-interfaces';
import {
  classifyFailure,
  classifyHttpFailure,
  parseRetryAfterMs,
  providerRetryDecision,
  resolveRetryPolicy,
  waitForRetry,
  type RetryPolicy,
} from '@wazir/shared';
import type { SecretBroker } from '@wazir/secrets';

export const NVIDIA_PROVIDER_ID = 'nvidia' as const;
export const NVIDIA_DISPLAY_NAME = 'NVIDIA API Catalog';
export const NVIDIA_PROVIDER_TYPE = 'HOSTED_INFERENCE' as const;
export const NVIDIA_DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const NVIDIA_DEFAULT_API_KEY_ENV = 'NVIDIA_API_KEY';
export const NVIDIA_DEFAULT_MODEL_ID = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

export interface NvidiaModelMetadata {
  id: string;
  name: string;
  family: string;
  parameters?: string;
  architecture?: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: string[];
  toolCalling: boolean;
  parallelToolCalls: boolean;
  structuredOutput: boolean;
  vision: boolean;
  audio: boolean;
  embedding: boolean;
  reasoning: boolean;
  supportsThinkingKwargs: boolean;
  supportsSeed: boolean;
}

/**
 * Curated metadata for NVIDIA API Catalog models, with `nvidia/nemotron-3.5-super-vl-120b-a12b`
 * as the primary initial multimodal reasoning/coding model.
 */
export const CURATED_NVIDIA_MODELS: Record<string, NvidiaModelMetadata> = {
  [NVIDIA_DEFAULT_MODEL_ID]: {
    id: NVIDIA_DEFAULT_MODEL_ID,
    name: 'NVIDIA Nemotron 3.5 Super VL 120B A12B',
    family: 'nemotron',
    parameters: '120B (A12B MoE)',
    architecture: 'nemotron-vl-moe',
    contextWindow: 131072,
    maxOutputTokens: 16384,
    capabilities: [
      'generalChat',
      'coding',
      'reasoning',
      'vision',
      'code_analysis',
      'debugging',
      'review',
    ],
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: true,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: true,
    supportsSeed: true,
  },
  'nvidia/llama-3.3-nemotron-super-49b-v1': {
    id: 'nvidia/llama-3.3-nemotron-super-49b-v1',
    name: 'Llama 3.3 Nemotron Super 49B v1',
    family: 'nemotron',
    parameters: '49B',
    architecture: 'llama-nemotron',
    contextWindow: 131072,
    maxOutputTokens: 16384,
    capabilities: ['generalChat', 'coding', 'reasoning', 'code_analysis', 'debugging', 'review'],
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: true,
    supportsSeed: true,
  },
  'nvidia/llama-3.1-nemotron-ultra-253b-v1': {
    id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
    name: 'Llama 3.1 Nemotron Ultra 253B v1',
    family: 'nemotron',
    parameters: '253B',
    architecture: 'llama-nemotron',
    contextWindow: 131072,
    maxOutputTokens: 16384,
    capabilities: ['generalChat', 'coding', 'reasoning', 'code_analysis', 'debugging', 'review'],
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: true,
    supportsSeed: true,
  },
};

export function inferNvidiaModelMetadata(
  modelId: string,
  remoteRecord?: Record<string, unknown>,
  capabilityOverrides?: Partial<NvidiaModelMetadata>,
): NvidiaModelMetadata {
  const curated = CURATED_NVIDIA_MODELS[modelId];
  if (curated) {
    const remoteCtx = typeof remoteRecord?.context_window === 'number'
      ? remoteRecord.context_window
      : typeof remoteRecord?.context_length === 'number'
        ? remoteRecord.context_length
        : undefined;
    return {
      ...curated,
      ...(remoteCtx && remoteCtx > 0 ? { contextWindow: remoteCtx } : {}),
      ...(capabilityOverrides ?? {}),
    };
  }

  const lower = modelId.toLowerCase();
  const isVision = lower.includes('-vl') || lower.includes('vision') || lower.includes('vlm') || lower.includes('neva') || lower.includes('vila') || lower.includes('cosmos');
  const isEmbedding = lower.includes('embed') || lower.includes('nv-embed') || lower.includes('bge-');
  const isNonToolModel = isEmbedding || lower.includes('reward') || lower.includes('guard') || lower.includes('rerank') || lower.includes('parse');
  const isReasoning = lower.includes('nemotron') || lower.includes('deepseek-r1') || lower.includes('qwq') || lower.includes('reasoning') || lower.includes('thinking');
  const isNemotron = lower.includes('nemotron');
  const family = isNemotron
    ? 'nemotron'
    : lower.includes('llama')
      ? 'llama'
      : lower.includes('deepseek')
        ? 'deepseek'
        : lower.includes('qwen')
          ? 'qwen'
          : lower.includes('mistral') || lower.includes('mixtral')
            ? 'mistral'
            : lower.includes('gemma')
              ? 'gemma'
              : modelId.split('/')[0] || 'nvidia';

  const remoteCtx = typeof remoteRecord?.context_window === 'number'
    ? remoteRecord.context_window
    : typeof remoteRecord?.context_length === 'number'
      ? remoteRecord.context_length
      : undefined;

  const capabilities: string[] = isEmbedding
    ? ['embedding']
    : [
        'generalChat',
        'coding',
        ...(isReasoning ? ['reasoning', 'code_analysis', 'debugging', 'review'] : []),
        ...(isVision ? ['vision'] : []),
      ];

  const base: NvidiaModelMetadata = {
    id: modelId,
    name: typeof remoteRecord?.name === 'string' ? remoteRecord.name : modelId,
    family,
    contextWindow: remoteCtx && remoteCtx > 0 ? remoteCtx : 131072,
    maxOutputTokens: 16384,
    capabilities,
    toolCalling: !isNonToolModel,
    parallelToolCalls: !isNonToolModel && (isNemotron || lower.includes('llama-3') || lower.includes('qwen')),
    structuredOutput: !isEmbedding,
    vision: isVision,
    audio: false,
    embedding: isEmbedding,
    reasoning: isReasoning,
    supportsThinkingKwargs: isNemotron,
    supportsSeed: !isEmbedding,
  };
  return capabilityOverrides ? { ...base, ...capabilityOverrides } : base;
}

function toDiscoveredModel(meta: NvidiaModelMetadata): DiscoveredModel {
  return {
    id: meta.id,
    name: meta.name,
    family: meta.family,
    parameters: meta.parameters,
    architecture: meta.architecture,
    contextWindow: meta.contextWindow,
    maxOutputTokens: meta.maxOutputTokens,
    capabilities: [...meta.capabilities],
    toolCalling: meta.toolCalling,
    structuredOutput: meta.structuredOutput,
    vision: meta.vision,
    audio: meta.audio,
    embedding: meta.embedding,
    reasoning: meta.reasoning,
  };
}

export interface NvidiaAdapterOptions {
  id?: string;
  baseURL?: string;
  secrets?: SecretBroker;
  /** Environment variable name for API key fallback (default: NVIDIA_API_KEY). */
  apiKeyEnv?: string;
  /** Optional environment map override for deterministic testing. */
  env?: NodeJS.ProcessEnv;
  /** Default model registered when configured (default: nvidia/nemotron-3.5-super-vl-120b-a12b). */
  defaultModel?: string;
  /** Explicitly configured models to include alongside discovered models or when enumeration is unavailable. */
  configuredModels?: string[];
  /** Optional per-model capability overrides. */
  modelCapabilities?: Record<string, Partial<NvidiaModelMetadata>>;
  modelCapabilityOverrides?: Record<string, Partial<NvidiaModelMetadata>>;
  /** Default max output tokens when not specified on GenerationRequest (default: 16384). */
  defaultMaxOutputTokens?: number;
  /** Whether to query /models during listModels()/discoverModels() (default: true). */
  discoverModelsRemote?: boolean;
  /** Default per-attempt request timeout in milliseconds when not overridden (default: 120_000). */
  timeoutMs?: number;
  /** Default max retries shorthand (merged into retryPolicy.maxRetries). */
  maxRetries?: number;
  /** Default bounded retry policy for transient connect/429/5xx errors (default maxRetries: 0 unless configured or supplied on request). */
  retryPolicy?: Partial<RetryPolicy>;
  fetch?: typeof globalThis.fetch;
}

export interface ResolvedNvidiaCredential {
  apiKey: string;
  source: ProviderCredentialSource;
}

export class NvidiaAdapter implements RuntimeAdapter, ProviderAuthAdapter {
  readonly id: string;
  readonly type = 'nvidia' as const;
  readonly provider = 'nvidia' as const;
  readonly displayName = NVIDIA_DISPLAY_NAME;
  readonly providerType = NVIDIA_PROVIDER_TYPE;
  readonly supportedMethods: AuthMethod[] = ['api-key'];

  private readonly baseURL: string;
  private readonly secrets?: SecretBroker;
  private readonly apiKeyEnv: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultModel: string;
  private readonly configuredModels: string[];
  private readonly modelCapabilities: Record<string, Partial<NvidiaModelMetadata>>;
  private readonly defaultMaxOutputTokens: number;
  private readonly discoverModelsRemote: boolean;
  private readonly timeoutMs?: number;
  private readonly defaultRetryPolicy: Partial<RetryPolicy>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly inflight = new Map<string, AbortController>();
  /** Remembers per-model unsupported request fields if the endpoint rejected them once. */
  private readonly unsupportedModelFields = new Map<string, Set<string>>();

  constructor(options: NvidiaAdapterOptions = {}) {
    this.id = options.id ?? NVIDIA_PROVIDER_ID;
    const rawBaseUrl = options.baseURL
      ?? options.env?.WAZIR_NVIDIA_BASE_URL
      ?? process.env.WAZIR_NVIDIA_BASE_URL
      ?? NVIDIA_DEFAULT_BASE_URL;
    this.baseURL = rawBaseUrl.replace(/\/$/, '');
    this.secrets = options.secrets;
    this.apiKeyEnv = options.apiKeyEnv ?? NVIDIA_DEFAULT_API_KEY_ENV;
    this.env = options.env ?? process.env;
    this.defaultModel = options.defaultModel ?? NVIDIA_DEFAULT_MODEL_ID;
    this.configuredModels = Array.from(
      new Set([this.defaultModel, ...(options.configuredModels ?? [])].filter((m) => m.trim().length > 0)),
    );
    this.modelCapabilities = {
      ...(options.modelCapabilities ?? {}),
      ...(options.modelCapabilityOverrides ?? {}),
    };
    this.defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 16384;
    this.discoverModelsRemote = options.discoverModelsRemote ?? true;
    this.timeoutMs = options.timeoutMs;
    this.defaultRetryPolicy = {
      maxRetries: options.maxRetries ?? options.retryPolicy?.maxRetries ?? 2,
      ...(options.retryPolicy ?? {}),
    };
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  getEndpointUrl(): string {
    return this.baseURL;
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  getConfiguredModels(): string[] {
    return [...this.configuredModels];
  }

  getModelMetadata(modelId: string, remoteRecord?: Record<string, unknown>): NvidiaModelMetadata {
    return inferNvidiaModelMetadata(modelId, remoteRecord, this.modelCapabilities[modelId]);
  }

  private async readStored(): Promise<StoredCredential | null> {
    if (!this.secrets) return null;
    const raw = await this.secrets.getCredential('nvidia');
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isStoredCredential(parsed) && parsed.provider === 'nvidia' ? parsed : null;
    } catch {
      return null;
    }
  }

  async resolveCredential(): Promise<ResolvedNvidiaCredential | null> {
    const stored = await this.readStored();
    if (stored && stored.credential.kind === 'api-key' && stored.credential.apiKey.trim().length > 0) {
      return { apiKey: stored.credential.apiKey.trim(), source: 'secret-broker' };
    }
    const envKey = this.env[this.apiKeyEnv]?.trim();
    if (envKey && envKey.length > 0) {
      return { apiKey: envKey, source: 'env' };
    }
    return null;
  }

  async status(): Promise<AuthStatus> {
    const raw = this.secrets ? await this.secrets.getCredential('nvidia') : undefined;
    if (raw) {
      const stored = await this.readStored();
      if (!stored || stored.credential.kind !== 'api-key') {
        const envKey = this.env[this.apiKeyEnv]?.trim();
        if (envKey) {
          return {
            provider: 'nvidia',
            authenticated: true,
            method: 'api-key',
            credentialSource: 'env',
            state: 'authenticated',
            eligible: true,
          };
        }
        return {
          provider: 'nvidia',
          authenticated: false,
          credentialSource: 'none',
          state: 'unavailable',
          eligible: false,
          reason: 'stored credential is corrupted; run `wa auth login nvidia` or set NVIDIA_API_KEY',
        };
      }
      return {
        provider: 'nvidia',
        authenticated: true,
        method: 'api-key',
        credentialSource: 'secret-broker',
        state: 'authenticated',
        eligible: true,
      };
    }

    const envKey = this.env[this.apiKeyEnv]?.trim();
    if (envKey) {
      return {
        provider: 'nvidia',
        authenticated: true,
        method: 'api-key',
        credentialSource: 'env',
        state: 'authenticated',
        eligible: true,
      };
    }

    return {
      provider: 'nvidia',
      authenticated: false,
      credentialSource: 'none',
      state: 'unavailable',
      eligible: false,
      reason: `not logged in (${this.apiKeyEnv} not set and no stored credential)`,
    };
  }

  async loginWithApiKey(apiKey: string): Promise<AuthLoginResult> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      return {
        ok: false,
        status: await this.status(),
        error: 'API key must not be empty',
      };
    }
    try {
      const res = await this.fetchImpl(`${this.baseURL}/models`, {
        headers: { Authorization: `Bearer ${trimmed}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          status: await this.status(),
          error: `NVIDIA rejected the API key (HTTP ${res.status})`,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          status: await this.status(),
          error: `NVIDIA validation call failed: HTTP ${res.status}`,
        };
      }
    } catch (err) {
      const msg = redactProviderSecrets(err instanceof Error ? err.message : String(err), [trimmed]);
      return {
        ok: false,
        status: await this.status(),
        error: `Could not reach NVIDIA to validate key: ${msg}`,
      };
    }

    const record: StoredCredential = {
      provider: 'nvidia',
      method: 'api-key',
      credential: { kind: 'api-key', apiKey: trimmed },
      obtainedAt: new Date().toISOString(),
    };
    if (this.secrets) {
      await this.secrets.putCredential('nvidia', JSON.stringify(record));
    }
    return { ok: true, status: await this.status() };
  }

  async logout(): Promise<void> {
    if (this.secrets) {
      await this.secrets.deleteCredential('nvidia');
    }
  }

  public getConfiguredFallbackModels(): DiscoveredModel[] {
    const ids = new Set<string>([this.defaultModel, ...this.configuredModels]);
    for (const curatedId of Object.keys(CURATED_NVIDIA_MODELS)) {
      ids.add(curatedId);
    }
    return Array.from(ids).map((id) => toDiscoveredModel(this.getModelMetadata(id)));
  }

  async discoverModels(): Promise<DiscoveredModel[]> {
    const cred = await this.resolveCredential();
    if (!cred) return [];
    if (!this.discoverModelsRemote) {
      return this.getConfiguredFallbackModels();
    }
    try {
      const res = await this.fetchImpl(`${this.baseURL}/models`, {
        headers: { Authorization: `Bearer ${cred.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return [];
        }
        return this.getConfiguredFallbackModels();
      }
      const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
      const remoteEntries = Array.isArray(data.data) ? data.data : [];
      const byId = new Map<string, DiscoveredModel>();

      // Ensure configured & default models are always present first
      for (const fallback of this.getConfiguredFallbackModels()) {
        byId.set(fallback.id, fallback);
      }

      for (const entry of remoteEntries) {
        const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
        if (!id) continue;
        const meta = this.getModelMetadata(id, entry);
        byId.set(id, toDiscoveredModel(meta));
      }

      return Array.from(byId.values());
    } catch {
      // Allow explicitly configured models when enumeration is unavailable
      return this.getConfiguredFallbackModels();
    }
  }

  async discover(): Promise<RuntimeInfo> {
    return {
      id: this.id,
      name: NVIDIA_DISPLAY_NAME,
      version: 'v1',
      url: this.baseURL,
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    const cred = await this.resolveCredential();
    if (!cred) {
      return {
        status: 'unavailable',
        reason: 'AUTH_REQUIRED',
        message: `not authenticated — set ${this.apiKeyEnv} or run \`wa auth login nvidia\``,
      };
    }
    try {
      const res = await this.fetchImpl(`${this.baseURL}/models`, {
        headers: { Authorization: `Bearer ${cred.apiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          status: 'unavailable',
          reason: 'AUTH_REQUIRED',
          message: `NVIDIA rejected the credential (HTTP ${res.status}); check ${this.apiKeyEnv} or re-run \`wa auth login nvidia\``,
        };
      }
      if (res.status === 429 || res.status >= 500) {
        const fallbackModels = this.getConfiguredFallbackModels();
        return {
          status: 'degraded',
          message: `NVIDIA API returned HTTP ${res.status}; configured models remain registered`,
          diagnostics: {
            cliAvailable: false,
            serverRunning: true,
            endpoint: this.baseURL,
            apiReachable: true,
            installedModels: fallbackModels.length,
            loadedModels: fallbackModels.length,
            readyModels: fallbackModels.length,
            failureReason: `HTTP_${res.status}`,
          },
        };
      }
      if (!res.ok) {
        return {
          status: 'degraded',
          reason: 'INVALID_RESPONSE',
          message: `HTTP ${res.status}`,
        };
      }
      const models = await this.discoverModels();
      return {
        status: 'healthy',
        diagnostics: {
          cliAvailable: false,
          serverRunning: true,
          endpoint: this.baseURL,
          apiReachable: true,
          installedModels: models.length,
          loadedModels: models.length,
          readyModels: models.length,
        },
      };
    } catch (err) {
      const safeErr = redactProviderSecrets(err instanceof Error ? err.message : String(err), [cred.apiKey]);
      return {
        status: 'unavailable',
        reason: 'API_UNREACHABLE',
        message: safeErr,
      };
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    return this.discoverModels();
  }

  async getLoadedModels(): Promise<string[]> {
    const models = await this.discoverModels();
    return models.map((m) => m.id);
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      chat: true,
      streaming: true,
      toolCalling: true,
      nativeToolCalling: true,
      parallelToolCalling: true,
      strictJsonSchema: true,
      streamingToolCalls: true,
      promptCaching: true,
      promptCacheTelemetry: true,
      cacheReadMetrics: true,
      cacheWriteMetrics: false,
      structuredOutput: true,
      vision: true,
      embeddings: false,
      reasoning: true,
      lifecycle: {
        discovery: true,
        inspection: false,
        contextControl: false,
        estimate: false,
        readinessProbe: true,
      },
      modelLoad: false,
      modelUnload: false,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    };
  }

  generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    return controlledGeneration(request, (generation, control) => this.generateControlled(generation, control));
  }

  private buildRequestBody(
    request: GenerationRequest,
    messages: Array<Record<string, unknown>>,
    meta: NvidiaModelMetadata,
    omittedFields: ReadonlySet<string>,
  ): Record<string, unknown> {
    const stream = request.stream ?? true;
    const maxTokens = request.maxTokens ?? Math.min(this.defaultMaxOutputTokens, meta.maxOutputTokens);
    const body: Record<string, unknown> = {
      model: request.modelId,
      messages,
      stream,
      temperature: request.temperature ?? 0.6,
      top_p: request.topP ?? 0.95,
      max_tokens: maxTokens,
    };

    if (stream && !omittedFields.has('stream_options')) {
      body.stream_options = { include_usage: true };
    }

    if (request.seed !== undefined && meta.supportsSeed && !omittedFields.has('seed')) {
      body.seed = request.seed;
    }

    if (request.tools && request.tools.length > 0 && meta.toolCalling) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      if (request.toolChoice !== undefined) {
        body.tool_choice = request.toolChoice;
      }
      const allowParallel = request.parallelToolCalls ?? meta.parallelToolCalls;
      if (allowParallel && meta.parallelToolCalls && !omittedFields.has('parallel_tool_calls')) {
        body.parallel_tool_calls = true;
      }
    }

    if (request.responseFormat && request.responseFormat.type !== 'text' && meta.structuredOutput) {
      body.response_format = request.responseFormat.type === 'json_schema' && request.responseFormat.json_schema
        ? { type: 'json_schema', json_schema: request.responseFormat.json_schema }
        : { type: 'json_object' };
    }

    // Reasoning / thinking template kwargs for models that support it (e.g. Nemotron 3.5 Super VL)
    const shouldSendThinking = (request.enableThinking ?? meta.supportsThinkingKwargs) && meta.supportsThinkingKwargs;
    if (!omittedFields.has('extra_body')) {
      if (shouldSendThinking || (request.extraBody && Object.keys(request.extraBody).length > 0)) {
        const mergedExtra: Record<string, unknown> = {
          ...(shouldSendThinking ? { chat_template_kwargs: { enable_thinking: request.enableThinking ?? true } } : {}),
          ...(request.extraBody ?? {}),
        };
        body.extra_body = mergedExtra;
      }
    }

    return body;
  }

  private async *generateControlled(
    request: GenerationRequest,
    control: GenerationControl,
  ): AsyncIterable<GenerationEvent> {
    const cred = await this.resolveCredential();
    if (!cred) {
      yield {
        type: 'error',
        requestId: control.requestId,
        failureClass: 'AUTH_FAILED',
        error: `NVIDIA provider is not authenticated — set ${this.apiKeyEnv} or run \`wa auth login nvidia\``,
      };
      return;
    }

    const meta = this.getModelMetadata(request.modelId);
    const messages = formatMessages(request);

    // Reject embedding models on chat completions endpoint
    if (meta.embedding) {
      yield {
        type: 'error',
        requestId: control.requestId,
        failureClass: 'NON_RECOVERABLE',
        error: `Model '${request.modelId}' is an embedding model and does not support chat completions`,
      };
      return;
    }

    // Check if request contains multimodal image inputs on a model that does not support vision
    const hasImages = request.messages.some((m) => Array.isArray(m.images) && m.images.length > 0);
    if (hasImages && !meta.vision) {
      yield {
        type: 'error',
        requestId: control.requestId,
        failureClass: 'NON_RECOVERABLE',
        error: `Model '${request.modelId}' does not advertise vision capability for multimodal image input`,
      };
      return;
    }

    // Check if request explicitly requires tool calling on a model that does not support tool calling
    const requiresTools =
      Array.isArray(request.tools) &&
      request.tools.length > 0 &&
      (request.toolChoice === 'required' ||
        (typeof request.toolChoice === 'object' && request.toolChoice !== null) ||
        !meta.toolCalling);
    if (requiresTools && !meta.toolCalling) {
      yield {
        type: 'error',
        requestId: control.requestId,
        failureClass: 'NON_RECOVERABLE',
        error: `Model '${request.modelId}' does not support native tool calling`,
      };
      return;
    }

    const controller = control.controller;
    const requestId = control.requestId;
    this.inflight.set(requestId, controller);
    if (request.signal) {
      if (request.signal.aborted) {
        controller.abort(request.signal.reason);
      } else {
        request.signal.addEventListener('abort', () => controller.abort(request.signal?.reason), { once: true });
      }
    }

    const stream = request.stream ?? true;
    const omittedFields = new Set<string>(this.unsupportedModelFields.get(request.modelId) ?? []);
    const configuredRetryPolicy = resolveRetryPolicy({
      maxRetries: 0,
      initialDelayMs: 250,
      maxDelayMs: 8000,
      ...this.defaultRetryPolicy,
      ...request.providerRetryPolicy,
    });
    const retryPolicy = {
      ...configuredRetryPolicy,
      maxRetries: control.capRetries(configuredRetryPolicy.maxRetries),
    };
    const maxAttempts = retryPolicy.maxRetries + 1;

    try {
      let res: Response | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        yield control.startAttempt();
        control.assertActive();

        const attemptSignal = this.timeoutMs
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)])
          : controller.signal;

        let body = this.buildRequestBody(request, messages, meta, omittedFields);
        try {
          let candidate = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${cred.apiKey}`,
              Accept: stream ? 'text/event-stream' : 'application/json',
            },
            body: JSON.stringify(body),
            signal: attemptSignal,
          });

          // Graceful parameter fallback if an OpenAI-compatible model endpoint rejects optional parameters
          if (candidate.status === 400) {
            const errBody = await candidate.text().catch(() => '');
            const unsupportedField = detectUnsupportedParameter(errBody, body);
            if (unsupportedField && !omittedFields.has(unsupportedField)) {
              omittedFields.add(unsupportedField);
              this.unsupportedModelFields.set(request.modelId, new Set(omittedFields));
              body = this.buildRequestBody(request, messages, meta, omittedFields);
              candidate = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${cred.apiKey}`,
                  Accept: stream ? 'text/event-stream' : 'application/json',
                },
                body: JSON.stringify(body),
                signal: attemptSignal,
              });
            } else {
              yield httpFailureEvent('NVIDIA', candidate, redactProviderSecrets(errBody, [cred.apiKey]), requestId);
              return;
            }
          }

          if (!candidate.ok) {
            const errBody = await candidate.text().catch(() => '');
            const safeErrBody = redactProviderSecrets(errBody, [cred.apiKey]);
            const failureClass = classifyHttpFailure(candidate.status, safeErrBody);
            const decision = providerRetryDecision(failureClass, attempt, retryPolicy);
            if (decision.retry) {
              const retryAfterMs = parseRetryAfterMs(candidate.headers.get('retry-after'));
              const delayMs = retryAfterMs !== undefined
                ? Math.min(retryPolicy.maxDelayMs, Math.max(decision.delayMs, retryAfterMs))
                : decision.delayMs;
              yield {
                type: 'retry',
                requestId,
                status: candidate.status,
                failureClass,
                retryAfterMs,
                rateLimit: readRateLimitHeaders(candidate.headers),
                retryAttempt: decision.attempt,
                retryDelayMs: delayMs,
                error: `NVIDIA API error: HTTP ${candidate.status} ${safeErrBody.slice(0, 200)}`,
              };
              await waitForRetry(delayMs, controller.signal);
              continue;
            }
            const failEv = httpFailureEvent('NVIDIA', candidate, safeErrBody, requestId);
            yield {
              ...failEv,
              ...(attempt > 1 ? { retryExhausted: decision.reason === 'retry_budget_exhausted' } : {}),
            };
            return;
          }

          res = candidate;
          break;
        } catch (err) {
          if (controller.signal.aborted) {
            yield {
              type: 'error',
              requestId,
              failureClass: 'CANCELLED',
              error: 'cancelled',
            };
            return;
          }
          const isTimeout =
            (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) ||
            (attemptSignal.aborted && !controller.signal.aborted);
          const failureClass = isTimeout ? 'TIMEOUT' : classifyFailure(err);
          const safeErr = redactProviderSecrets(
            err instanceof Error ? err.message : String(err),
            [cred.apiKey],
          );
          const decision = providerRetryDecision(failureClass, attempt, retryPolicy);
          if (decision.retry) {
            yield {
              type: 'retry',
              requestId,
              failureClass,
              retryAttempt: decision.attempt,
              retryDelayMs: decision.delayMs,
              error: safeErr,
            };
            await waitForRetry(decision.delayMs, controller.signal);
            continue;
          }
          yield {
            type: 'error',
            requestId,
            failureClass,
            ...(attempt > 1 ? { retryExhausted: decision.reason === 'retry_budget_exhausted' } : {}),
            error: safeErr,
          };
          return;
        }
      }

      if (!res) return;

      const rateLimit = readRateLimitHeaders(res.headers);

      if (!stream) {
        const payload = (await res.json()) as Record<string, unknown>;
        const choices = Array.isArray(payload.choices) ? (payload.choices as Array<Record<string, unknown>>) : [];
        const firstChoice = choices[0] ?? {};
        const message = (firstChoice.message as Record<string, unknown> | undefined) ?? {};
        const reasoningText = typeof message.reasoning_content === 'string'
          ? message.reasoning_content
          : typeof message.reasoning === 'string'
            ? message.reasoning
            : undefined;
        if (reasoningText) {
          yield { type: 'reasoning', requestId, content: reasoningText };
        }
        const contentText = typeof message.content === 'string' ? message.content : undefined;
        if (contentText) {
          yield { type: 'token', requestId, content: contentText };
        }
        const toolCalls = Array.isArray(message.tool_calls)
          ? (message.tool_calls as Array<Record<string, unknown>>)
          : [];
        for (const tc of toolCalls) {
          const fn = (tc.function as Record<string, unknown> | undefined) ?? {};
          const rawArgs = typeof fn.arguments === 'string' ? fn.arguments : '{}';
          let parsedArgs: unknown = rawArgs;
          try {
            parsedArgs = JSON.parse(rawArgs);
          } catch {
            // preserve raw string if malformed JSON
          }
          yield {
            type: 'tool_call',
            requestId,
            toolCallId: typeof tc.id === 'string' ? tc.id : undefined,
            toolName: typeof fn.name === 'string' ? fn.name : 'unknown',
            toolInput: parsedArgs,
          };
        }

        const usage = extractUsage(payload.usage as Record<string, unknown> | undefined, res.headers);
        const finishReason = typeof firstChoice.finish_reason === 'string' ? firstChoice.finish_reason : 'stop';
        yield {
          type: 'completed',
          requestId,
          content: contentText ?? '',
          finishReason,
          usage: usage ?? { inputTokens: 0, outputTokens: 0 },
          promptCache: usage?.promptCache,
          rateLimit,
        };
        return;
      }

      if (!res.body) {
        yield {
          type: 'error',
          requestId,
          failureClass: 'MODEL_PROTOCOL',
          error: 'NVIDIA response had no body',
        };
        return;
      }

      const toolSlots = new Map<number, { id?: string; name: string; args: string }>();
      let usage: Usage | undefined;
      let finishReason: string | undefined;
      let sawDoneMarker = false;
      let fullContent = '';

      for await (const payload of readSseDataLines(res.body)) {
        if (payload === '[DONE]') {
          sawDoneMarker = true;
          break;
        }
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          throw new Error('MALFORMED_PROVIDER_STREAM: invalid JSON in SSE data line');
        }

        if (chunk.usage && typeof chunk.usage === 'object') {
          usage = extractUsage(chunk.usage as Record<string, unknown>, res.headers);
        }

        const choices = Array.isArray(chunk.choices) ? (chunk.choices as Array<Record<string, unknown>>) : [];
        const choice = choices[0];
        if (!choice) continue;

        if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        // Reasoning stream support (Nemotron delta.reasoning_content)
        const reasoningDelta = typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : undefined;
        if (reasoningDelta && reasoningDelta.length > 0) {
          yield { type: 'reasoning', requestId, content: reasoningDelta };
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          fullContent += delta.content;
          yield { type: 'token', requestId, content: delta.content };
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            let slot = toolSlots.get(idx);
            if (!slot) {
              slot = { name: '', args: '' };
              toolSlots.set(idx, slot);
            }
            if (typeof tc.id === 'string') slot.id = tc.id;
            const fn = tc.function as Record<string, unknown> | undefined;
            if (fn) {
              if (typeof fn.name === 'string') slot.name += fn.name;
              if (typeof fn.arguments === 'string') slot.args += fn.arguments;
            }
          }
        }
      }

      if (!sawDoneMarker && !finishReason) {
        throw new Error('INCOMPLETE_PROVIDER_STREAM: stream closed before terminal completion marker');
      }

      for (const [index, slot] of [...toolSlots.entries()].sort((a, b) => a[0] - b[0])) {
        if (!slot.name) continue;
        let parsed: unknown = slot.args;
        try {
          parsed = slot.args ? JSON.parse(slot.args) : {};
        } catch {
          // leave raw string for agent repair loop
        }
        yield {
          type: 'tool_call',
          requestId,
          toolCallId: slot.id ?? `tool-${index}`,
          toolName: slot.name,
          toolInput: parsed,
        };
      }

      yield {
        type: 'completed',
        requestId,
        content: fullContent,
        finishReason: finishReason ?? 'stop',
        usage: usage ?? { inputTokens: 0, outputTokens: 0 },
        promptCache: usage?.promptCache,
        rateLimit,
      };
    } catch (err) {
      const safeMessage = redactProviderSecrets(
        controller.signal.aborted ? 'cancelled' : err instanceof Error ? err.message : String(err),
        [cred.apiKey],
      );
      yield {
        type: 'error',
        requestId,
        failureClass: controller.signal.aborted ? 'CANCELLED' : 'TRANSPORT',
        error: safeMessage,
      };
    } finally {
      controller.abort();
      this.inflight.delete(requestId);
    }
  }

  async cancel(requestId: string): Promise<void> {
    const c = this.inflight.get(requestId);
    if (c) {
      c.abort();
      this.inflight.delete(requestId);
    }
  }
}

function detectUnsupportedParameter(errBody: string, sentBody: Record<string, unknown>): string | undefined {
  const lower = errBody.toLowerCase();
  const candidates = ['extra_body', 'parallel_tool_calls', 'stream_options', 'seed'];
  for (const field of candidates) {
    if (field in sentBody && (lower.includes(field) || lower.includes('chat_template_kwargs') || lower.includes('enable_thinking'))) {
      if ((lower.includes('chat_template_kwargs') || lower.includes('enable_thinking')) && 'extra_body' in sentBody) {
        return 'extra_body';
      }
      if (lower.includes(field)) {
        return field;
      }
    }
  }
  return undefined;
}

function extractUsage(u: Record<string, unknown> | undefined, headers: Headers): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const promptTokens = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
  const completionTokens = typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;

  const promptDetails = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = u.completion_tokens_details as Record<string, unknown> | undefined;
  const cached = typeof promptDetails?.cached_tokens === 'number' ? promptDetails.cached_tokens : undefined;
  const reasoning = typeof completionDetails?.reasoning_tokens === 'number' ? completionDetails.reasoning_tokens : undefined;
  const inputTokens = promptTokens ?? 0;
  const outputTokens = completionTokens ?? 0;
  const promptCache = normalizePromptCacheTelemetry({
    provider: 'nvidia',
    inputTokens,
    usage: u,
    headers,
  });

  return {
    inputTokens,
    outputTokens,
    totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : inputTokens + outputTokens,
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    promptCache,
  };
}

function formatMessages(request: GenerationRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (request.systemPrompt) {
    out.push({ role: 'system', content: request.systemPrompt });
  }
  for (const m of request.messages) {
    out.push(formatSingleMessage(m));
  }
  if (request.prompt) {
    out.push({ role: 'user', content: request.prompt });
  }
  return out;
}

function formatSingleMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.toolCallId ?? 'call_0',
      content: m.content,
    };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
        },
      })),
    };
  }
  if (Array.isArray(m.images) && m.images.length > 0) {
    const contentParts: Array<Record<string, unknown>> = [];
    if (m.content && m.content.trim().length > 0) {
      contentParts.push({ type: 'text', text: m.content });
    }
    for (const img of m.images) {
      if (!img?.url) continue;
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: img.url,
          ...(img.detail ? { detail: img.detail } : {}),
        },
      });
    }
    return {
      role: m.role,
      content: contentParts,
      ...(m.name ? { name: m.name } : {}),
    };
  }
  return {
    role: m.role,
    content: m.content,
    ...(m.name ? { name: m.name } : {}),
  };
}

async function* readSseDataLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload) yield payload;
        }
      }
    }
    buf += decoder.decode();
    if (buf.trim().length > 0) {
      for (const rawLine of buf.split(/\r?\n/)) {
        const line = rawLine.replace(/\r$/, '').trim();
        if (!line) continue;
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (!payload) {
            throw new Error('MALFORMED_PROVIDER_STREAM: truncated trailing SSE line');
          }
          yield payload;
        } else if (!line.startsWith(':')) {
          throw new Error('MALFORMED_PROVIDER_STREAM: truncated trailing SSE line');
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function createNvidiaAdapter(options: NvidiaAdapterOptions = {}): NvidiaAdapter {
  return new NvidiaAdapter(options);
}
