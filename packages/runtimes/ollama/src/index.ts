import { controlledGeneration, type GenerationControl } from '@wazir/runtimes-interfaces';
import type {
  DiscoveredModel,
  GenerationEvent,
  GenerationRequest,
  HealthStatus,
  PromptCacheMetrics,
  ResourceEstimate,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeInfo,
} from '@wazir/runtimes-interfaces';
import { normalizePromptCacheTelemetry } from '@wazir/runtimes-interfaces';
import { classifyFailure, classifyHttpFailure, isProviderRetryable, providerRetryDecision, resolveRetryPolicy, waitForRetry } from '@wazir/shared';

interface OllamaModelDetails {
  parent_model?: string;
  format?: string;
  family?: string;
  families?: string[];
  parameter_size?: string;
  quantization_level?: string;
}

interface OllamaTagModel {
  name: string;
  model: string;
  size: number;
  details?: OllamaModelDetails;
}

interface OllamaChatMessage {
  role: string;
  content?: string;
  tool_calls?: Array<{
    function: { name: string; arguments: unknown };
  }>;
}

interface OllamaChatLine {
  model?: string;
  message?: OllamaChatMessage;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  error?: string;
}

const TOOL_CAPABLE_FAMILIES = new Set([
  'qwen', 'llama', 'mistral', 'mixtral', 'gemma', 'gemma4', 'deepseek', 'phi', 'granite', 'nemotron', 'codestral',
]);

function inferToolCalling(id: string, family?: string): boolean {
  if (id.includes('embed') || id.includes('bert')) return false;
  if (family && TOOL_CAPABLE_FAMILIES.has(family)) return true;
  if (family === 'gemma' || family === 'phi') return true;
  return false;
}

function inferReasoning(id: string): boolean {
  return /qwen3|deepseek-r1|.*-think|reasoner/i.test(id);
}

function normalizeModelId(name: string): string {
  const [base] = name.split(':');
  return base;
}

function canonicalOllamaTag(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function getArchValue(info: Record<string, unknown>, suffix: string): unknown {
  const arch = typeof info['general.architecture'] === 'string' ? info['general.architecture'].trim() : '';
  if (arch) {
    const exactKey = `${arch}.${suffix}`;
    if (info[exactKey] !== undefined) {
      return info[exactKey];
    }
  }
  const dotSuffix = `.${suffix}`;
  for (const [key, value] of Object.entries(info)) {
    if (key.includes('.vision.') || key.includes('.mmproj.') || key.startsWith('vision.') || key.startsWith('mmproj.')) {
      continue;
    }
    if (key.endsWith(dotSuffix) || key === suffix) {
      return value;
    }
  }
  return undefined;
}

function resolveKvBytesPerElem(kvQuant: unknown): number {
  if (typeof kvQuant !== 'string') return 2;
  const normalized = kvQuant.trim().toLowerCase();
  if (normalized === 'f32' || normalized === 'fp32') return 4;
  if (normalized === 'f16' || normalized === 'fp16' || normalized === 'bf16') return 2;
  if (normalized.startsWith('q8') || normalized === 'int8') return 1;
  if (normalized.startsWith('q4') || normalized === 'int4') return 0.5;
  return 2;
}

export class OllamaAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly type = 'ollama' as const;
  private readonly baseURL: string;
  private readonly controllers = new Map<string, AbortController>();
  private modelSizes = new Map<string, number>();
  private detectedCapabilities = {
    promptCacheTelemetry: false,
    cacheReadMetrics: false,
    cacheWriteMetrics: false,
  };

  constructor(baseURL: string = 'http://localhost:11434', options: { id?: string } = {}) {
    this.id = options.id?.trim() || 'ollama';
    this.baseURL = baseURL.replace(/\/+$/, '');
  }

  async discover(): Promise<RuntimeInfo> {
    const response = await fetch(`${this.baseURL}/api/version`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      throw new Error(`Ollama /api/version responded ${response.status}`);
    }
    const data = (await response.json()) as { version?: string };
    return {
      id: this.id,
      name: 'Ollama',
      version: data.version ?? 'unknown',
      url: this.baseURL,
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const response = await fetch(`${this.baseURL}/api/version`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) {
        return { status: 'unavailable', message: `HTTP ${response.status}` };
      }
      return { status: 'healthy' };
    } catch (error) {
      return { status: 'unavailable', message: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    const [tagsResponse, runningList] = await Promise.all([
      fetch(`${this.baseURL}/api/tags`, { signal: AbortSignal.timeout(5000) }),
      this.runningModels().catch(() => [] as Array<{ name: string; model?: string; context_length?: number; size?: number; size_vram?: number }>),
    ]);
    if (!tagsResponse.ok) {
      return [];
    }
    const runningByTag = new Map<string, { name: string; context_length?: number; size?: number; size_vram?: number }>();
    for (const running of runningList) {
      if (running.name) {
        runningByTag.set(running.name, running);
        runningByTag.set(canonicalOllamaTag(running.name), running);
      }
      const runningModelKey = (running as { model?: string }).model;
      if (runningModelKey) {
        runningByTag.set(runningModelKey, running);
        runningByTag.set(canonicalOllamaTag(runningModelKey), running);
      }
    }
    const data = (await tagsResponse.json()) as { models?: OllamaTagModel[] };
    return Promise.all((data.models ?? []).map(async (model) => {
      const details = await this.showModel(model.name).catch(() => ({} as { model_info?: Record<string, unknown>; size?: number; capabilities?: string[] }));
      const info = details.model_info ?? {};
      const showCaps = Array.isArray(details.capabilities) ? details.capabilities : [];
      const context = getArchValue(info, 'context_length');
      const size =
        (isPositiveFiniteNumber(model.size) ? model.size : undefined) ??
        (isPositiveFiniteNumber(details.size) ? details.size : undefined) ??
        (isPositiveFiniteNumber(info['general.file_size']) ? info['general.file_size'] : undefined) ??
        0;
      if (size > 0) {
        this.modelSizes.set(model.name, size);
        this.modelSizes.set(normalizeModelId(model.name), size);
      }
      const family = model.details?.family;
      const runningMatch =
        runningByTag.get(model.name) ??
        runningByTag.get(canonicalOllamaTag(model.name)) ??
        (model.model ? (runningByTag.get(model.model) ?? runningByTag.get(canonicalOllamaTag(model.model))) : undefined);
      return {
        id: model.name,
        name: model.name,
        family,
        parameters: model.details?.parameter_size,
        quantization: model.details?.quantization_level,
        contextWindow: typeof context === 'number' ? context : undefined,
        contextLimitSource: typeof context === 'number' ? 'runtime-discovered' : 'default-unknown',
        weightBytes: size,
        capabilities: ['generalChat'],
        toolCalling: showCaps.includes('tools') || inferToolCalling(model.name, family),
        structuredOutput: false,
        vision: showCaps.includes('vision') || (model.details?.families ?? []).includes('clip'),
        audio: false,
        embedding: (model.details?.families ?? []).some((f) => f.includes('bert') || f.includes('nomic-embed')),
        reasoning: showCaps.includes('thinking') || inferReasoning(model.name),
        loaded: Boolean(runningMatch),
        effectiveContext: runningMatch?.context_length,
      };
    }));
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      chat: true,
      streaming: true,
      toolCalling: true,
      nativeToolCalling: true,
      parallelToolCalling: false,
      strictJsonSchema: false,
      streamingToolCalls: false,
      promptCaching: this.detectedCapabilities.promptCacheTelemetry,
      promptCacheTelemetry: this.detectedCapabilities.promptCacheTelemetry,
      cacheReadMetrics: this.detectedCapabilities.cacheReadMetrics,
      cacheWriteMetrics: this.detectedCapabilities.cacheWriteMetrics,
      structuredOutput: false,
      vision: true,
      embeddings: true,
      reasoning: true,
      lifecycle: { discovery: true, inspection: true, contextControl: true, estimate: false, readinessProbe: true },
      modelLoad: true,
      modelUnload: true,
      modelDownload: true,
      statefulChat: true,
      mcp: false,
    };
  }

  private async showModel(modelId: string): Promise<{ model_info?: Record<string, unknown>; size?: number; capabilities?: string[] }> {
    const response = await fetch(`${this.baseURL}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('MODEL_NOT_INSTALLED');
    return await response.json() as { model_info?: Record<string, unknown>; size?: number; capabilities?: string[] };
  }

  private cacheModelSize(modelId: string, size: number): void {
    this.modelSizes.set(modelId, size);
    this.modelSizes.set(canonicalOllamaTag(modelId), size);
    this.modelSizes.set(normalizeModelId(modelId), size);
  }

  private async resolveWeightBytes(
    modelId: string,
    showDetails: { model_info?: Record<string, unknown>; size?: number },
  ): Promise<number | undefined> {
    const cached =
      this.modelSizes.get(modelId) ??
      this.modelSizes.get(canonicalOllamaTag(modelId)) ??
      this.modelSizes.get(normalizeModelId(modelId));
    if (isPositiveFiniteNumber(cached)) return cached;

    if (isPositiveFiniteNumber(showDetails.size)) {
      this.cacheModelSize(modelId, showDetails.size);
      return showDetails.size;
    }

    const fileSize = showDetails.model_info?.['general.file_size'];
    if (isPositiveFiniteNumber(fileSize)) {
      this.cacheModelSize(modelId, fileSize);
      return fileSize;
    }

    try {
      const response = await fetch(`${this.baseURL}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return undefined;
      const data = (await response.json()) as { models?: OllamaTagModel[] };
      const models = data.models ?? [];
      for (const m of models) {
        if (isPositiveFiniteNumber(m.size)) {
          this.cacheModelSize(m.name, m.size);
        }
      }
      const canonical = canonicalOllamaTag(modelId);
      const base = normalizeModelId(modelId);
      const match =
        models.find((m) => m.name === modelId || m.model === modelId) ??
        models.find((m) => canonicalOllamaTag(m.name) === canonical || (m.model ? canonicalOllamaTag(m.model) === canonical : false)) ??
        models.find((m) => normalizeModelId(m.name) === base);
      return match && isPositiveFiniteNumber(match.size) ? match.size : undefined;
    } catch {
      return undefined;
    }
  }
  private async runningModels(): Promise<Array<{ name: string; context_length?: number; size?: number; size_vram?: number }>> {
    const response = await fetch(`${this.baseURL}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`RUNTIME_UNAVAILABLE: Ollama HTTP ${response.status}`);
    const data = await response.json() as { models?: Array<{ name: string; context_length?: number; size?: number; size_vram?: number }> };
    if (!Array.isArray(data.models)) throw new Error('RUNTIME_UNAVAILABLE: invalid residency response');
    return data.models;
  }
  async getLoadedModels(): Promise<string[]> { return (await this.runningModels()).map(m => m.name); }
  async inspectModel(modelId: string): Promise<import('@wazir/runtimes-interfaces').RuntimeModelInspection> {
    const m = (await this.runningModels()).find(m => normalizeModelId(m.name) === normalizeModelId(modelId));
    return { modelId, loaded: !!m, effectiveContext: m?.context_length, memoryBytes: m?.size };
  }
  async loadModel(modelId: string, options: { contextTokens?: number } = {}): Promise<void> {
    const response = await fetch(`${this.baseURL}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model: modelId, stream: false, keep_alive: -1, options: { num_ctx: options.contextTokens } }),
    });
    if (!response.ok) throw new Error(`RUNTIME_LOAD_FAILED: Ollama HTTP ${response.status}`);
    await response.json();
  }
  async unloadModel(modelId: string): Promise<void> {
    const response = await fetch(`${this.baseURL}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ model: modelId, stream: false, keep_alive: 0 }),
    });
    if (!response.ok) throw new Error(`RUNTIME_UNLOAD_FAILED: Ollama HTTP ${response.status}`);
    await response.json();
  }
  async probeModel(modelId: string, contextTokens: number): Promise<boolean> {
    const state = await this.inspectModel(modelId);
    if (!state.loaded || state.effectiveContext !== contextTokens) return false;
    const response = await fetch(`${this.baseURL}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ model: modelId, prompt: 'Reply OK.', stream: false, keep_alive: -1, options: { num_ctx: contextTokens, num_predict: 1 } }),
    });
    if (!response.ok) return false;
    return (await response.json() as { done?: boolean }).done === true;
  }
  async estimateModelLoad(modelId: string, contextTokens: number): Promise<import('@wazir/runtimes-interfaces').ModelLoadEstimate> {
    if (!isPositiveFiniteNumber(contextTokens)) {
      return { source: 'UNKNOWN', confidence: 'unknown' };
    }
    // Ollama has no pre-load estimation endpoint. Use architecture metadata only;
    // file size alone is insufficient to estimate the KV cache at a chosen context.
    const showDetails = await this.showModel(modelId);
    const info = showDetails.model_info ?? {};
    const weightBytes = await this.resolveWeightBytes(modelId, showDetails);
    const layers = getArchValue(info, 'block_count');
    const kvHeadsRaw = getArchValue(info, 'attention.head_count_kv');
    if (!isPositiveFiniteNumber(weightBytes) || !isPositiveFiniteNumber(layers)) {
      return { source: 'UNKNOWN', confidence: 'unknown' };
    }

    let totalKvHeads: number;
    if (isPositiveFiniteNumber(kvHeadsRaw)) {
      totalKvHeads = layers * kvHeadsRaw;
    } else if (Array.isArray(kvHeadsRaw) && kvHeadsRaw.length > 0 && kvHeadsRaw.every(isPositiveFiniteNumber)) {
      const sumKvHeads = kvHeadsRaw.reduce((sum, h) => sum + h, 0);
      totalKvHeads = kvHeadsRaw.length === layers ? sumKvHeads : (sumKvHeads / kvHeadsRaw.length) * layers;
    } else if (kvHeadsRaw === null || kvHeadsRaw === undefined) {
      // Ollama /api/show serializes GGUF per-layer array tensors (such as gemma4.attention.head_count_kv) as null.
      // Fall back to a conservative MHA upper bound using attention.head_count when available.
      const headsFallback = getArchValue(info, 'attention.head_count');
      if (!isPositiveFiniteNumber(headsFallback)) {
        return { source: 'UNKNOWN', confidence: 'unknown' };
      }
      totalKvHeads = layers * headsFallback;
    } else {
      return { source: 'UNKNOWN', confidence: 'unknown' };
    }

    const keyLengthRaw = getArchValue(info, 'attention.key_length');
    const valueLengthRaw = getArchValue(info, 'attention.value_length');
    if (keyLengthRaw !== undefined && !isPositiveFiniteNumber(keyLengthRaw)) {
      return { source: 'UNKNOWN', confidence: 'unknown' };
    }
    if (valueLengthRaw !== undefined && !isPositiveFiniteNumber(valueLengthRaw)) {
      return { source: 'UNKNOWN', confidence: 'unknown' };
    }

    let keyDim = keyLengthRaw as number | undefined;
    let valueDim = valueLengthRaw as number | undefined;
    if (keyDim === undefined || valueDim === undefined) {
      const heads = getArchValue(info, 'attention.head_count');
      const embedding = getArchValue(info, 'embedding_length');
      if (!isPositiveFiniteNumber(heads) || !isPositiveFiniteNumber(embedding)) {
        return { source: 'UNKNOWN', confidence: 'unknown' };
      }
      const fallbackHeadDim = embedding / heads;
      keyDim ??= fallbackHeadDim;
      valueDim ??= fallbackHeadDim;
    }

    const kvQuant = getArchValue(info, 'attention.kv_quant') ?? info['general.kv_quant'] ?? info['kv_quant'];
    const bytesPerElem = resolveKvBytesPerElem(kvQuant);
    const contextBytes = Math.ceil(totalKvHeads * (keyDim + valueDim) * bytesPerElem * contextTokens);
    const overheadBytes = Math.max(1024 ** 3, weightBytes * 0.15);
    const totalMemoryBytes = weightBytes + contextBytes + overheadBytes;
    return { weightBytes, contextBytes, overheadBytes, totalMemoryBytes, vramBytes: totalMemoryBytes, source: 'HEURISTIC', confidence: 'low' };
  }

  async estimateResources(modelId: string): Promise<ResourceEstimate> {
    const bytes = this.modelSizes.get(modelId) ?? this.modelSizes.get(normalizeModelId(modelId));
    if (!bytes) return {};
    const gb = bytes / (1024 ** 3);
    return { minMemoryGB: Math.ceil(gb * 1.5), minGpuGB: undefined };
  }

  generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    return controlledGeneration(request, (generation, control) => this.generateControlled(generation, control));
  }

  private async *generateControlled(request: GenerationRequest, control: GenerationControl): AsyncIterable<GenerationEvent> {
    const controller = control.controller;
    const requestId = control.requestId;
    this.controllers.set(requestId, controller);

    const messages = this.buildMessages(request);

    // Connect with retry, scoped to this fetch only — see the equivalent
    // comment in the LM Studio adapter's generate(). Ollama has the same
    // lazy-model-load window (it can refuse connections or 5xx while
    // swapping a model into memory) that motivated this.
    let response: Response | undefined;
    const configuredRetryPolicy = resolveRetryPolicy({ maxRetries: 3, initialDelayMs: 250, maxDelayMs: 8000, ...request.providerRetryPolicy });
    const retryPolicy = { ...configuredRetryPolicy, maxRetries: control.capRetries(configuredRetryPolicy.maxRetries) };
    const maxAttempts = retryPolicy.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      yield control.startAttempt();
      try {
        control.assertActive();
        const candidate = await fetch(`${this.baseURL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: request.modelId,
            messages,
            stream: true,
            tools: request.tools?.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            options: {
              temperature: request.temperature,
              top_p: request.topP,
              num_predict: request.maxTokens,
              num_ctx: request.contextTokens,
            },
          }),
          signal: controller.signal,
        });
        const decision = providerRetryDecision(classifyFailure({ status: candidate.status }), attempt, retryPolicy);
        if (decision.retry) {
          await candidate.text().catch(() => undefined);
          yield { type: 'retry', requestId, failureClass: decision.failureClass, retryAttempt: decision.attempt, retryDelayMs: decision.delayMs, error: `HTTP ${candidate.status}` };
          await waitForRetry(decision.delayMs, controller.signal);
          continue;
        }
        response = candidate;
        break;
      } catch (error) {
        if (controller.signal.aborted) {
          this.controllers.delete(requestId);
          yield { type: 'error', error: 'cancelled' };
          return;
        }
        const decision = providerRetryDecision(classifyFailure(error), attempt, retryPolicy);
        if (decision.retry) {
          yield { type: 'retry', requestId, failureClass: decision.failureClass, retryAttempt: decision.attempt, retryDelayMs: decision.delayMs, error: error instanceof Error ? error.message : String(error) };
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
        yield { type: 'error', requestId, retryAttempt: attempt, failureClass: decision.failureClass, retryExhausted: decision.reason === 'retry_budget_exhausted', error: error instanceof Error ? error.message : String(error) };
        return;
      }
    }

    if (!response || !response.ok || !response.body) {
      const body = await response?.text().catch(() => '') ?? '';
      this.controllers.delete(requestId);
      const failureClass = response ? classifyHttpFailure(response.status, body) : classifyFailure({ status: undefined });
      yield { type: 'error', requestId, status: response?.status, retryAttempt: maxAttempts, failureClass, retryExhausted: isProviderRetryable(failureClass), error: `Ollama API error: HTTP ${response?.status ?? 'unknown'} ${body.slice(0, 300)}` };
      return;
    }

    let full = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let lastDoneLine: OllamaChatLine | undefined;
    const responseHeaders = response.headers;
    const buffer = createLineBuffer();

    try {
      // One decoder per stream: {stream: true} only reassembles multi-byte characters
      // split across chunks when the same decoder instance sees every chunk.
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer.push(decoder.decode(value, { stream: true }));
        for (const line of buffer.drain()) {
          let parsed: OllamaChatLine;
          try {
            parsed = JSON.parse(line) as OllamaChatLine;
          } catch {
            throw new Error('INVALID_PROVIDER_STREAM: malformed JSON line');
          }
          if (parsed.error) {
            throw new Error(parsed.error);
          }
          const content = parsed.message?.content;
          if (content) {
            full += content;
            yield { type: 'token', content };
          }
          let callIndex = 0;
          for (const call of parsed.message?.tool_calls ?? []) {
            const rawId = (call as { id?: string }).id;
            yield {
              type: 'tool_call',
              toolCallId: rawId ?? `ollama-call-${callIndex++}`,
              toolName: call.function.name,
              toolInput: call.function.arguments,
            };
          }
          if (parsed.done) {
            inputTokens = parsed.prompt_eval_count ?? 0;
            outputTokens = parsed.eval_count ?? 0;
            lastDoneLine = parsed;
          }
        }
      }

      if (!lastDoneLine) throw new Error('INCOMPLETE_PROVIDER_STREAM: missing done marker');
      const promptCache = normalizePromptCacheTelemetry({
        provider: 'ollama',
        inputTokens,
        usage: lastDoneLine as Record<string, any>,
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
        content: full,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cacheReadTokens: promptCache.cacheReadTokens.value,
          cacheWriteTokens: promptCache.cacheWriteTokens.value,
          promptCache,
        },
        promptCache,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        const promptCache = normalizePromptCacheTelemetry({
          provider: 'ollama',
          inputTokens,
          usage: lastDoneLine as Record<string, any>,
          headers: responseHeaders,
        });
        yield {
          type: 'completed',
          content: full,
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
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
      // Also reached when the consumer stops iterating early: abort so the provider
      // stops generating instead of streaming into a closed reader. No-op once done.
      controller.abort();
      this.controllers.delete(requestId);
    }
  }

  async cancel(requestId: string): Promise<void> {
    this.controllers.get(requestId)?.abort();
  }

  private buildMessages(request: GenerationRequest): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    for (const message of request.messages) {
      if (message.role === 'tool') {
        if (message.toolCallId || message.name) {
          messages.push({
            role: 'tool',
            content: message.content,
            ...(message.name ? { tool_name: message.name } : {}),
            ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
          });
        } else {
          messages.push({ role: 'user', content: `[tool result: ${message.content}]` });
        }
      } else if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: message.content ?? '',
          tool_calls: message.toolCalls.map((tc) => {
            let parsedArgs: unknown = tc.arguments ?? {};
            if (typeof parsedArgs === 'string') {
              try {
                parsedArgs = JSON.parse(parsedArgs);
              } catch {
                parsedArgs = { raw: parsedArgs };
              }
            }
            return {
              ...(tc.id ? { id: tc.id } : {}),
              type: 'function',
              function: {
                name: tc.name,
                arguments: parsedArgs && typeof parsedArgs === 'object' ? parsedArgs : {},
              },
            };
          }),
        });
      } else {
        messages.push({ role: message.role, content: message.content });
      }
    }
    if (request.prompt) {
      messages.push({ role: 'user', content: request.prompt });
    }
    return messages;
  }
}

interface LineBuffer {
  push(chunk: string): void;
  drain(): string[];
}

function createLineBuffer(): LineBuffer {
  let pending = '';
  return {
    push(chunk: string) {
      pending += chunk;
    },
    drain(): string[] {
      const lines: string[] = [];
      let index = pending.indexOf('\n');
      while (index !== -1) {
        const line = pending.slice(0, index).trim();
        if (line) lines.push(line);
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
      return lines;
    },
  };
}

export function createOllamaAdapter(baseURL?: string, options?: { id?: string }): RuntimeAdapter {
  return new OllamaAdapter(baseURL, options);
}
