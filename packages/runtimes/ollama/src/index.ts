import type {
  DiscoveredModel,
  GenerationEvent,
  GenerationRequest,
  HealthStatus,
  ResourceEstimate,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeInfo,
} from '@wazir/runtimes-interfaces';
import { classifyFailure, isProviderRetryable, providerRetryDecision, resolveRetryPolicy, waitForRetry } from '@wazir/shared';

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
  'qwen', 'llama', 'mistral', 'mixtral', 'gemma', 'deepseek', 'phi', 'granite', 'nemotron', 'codestral',
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

export class OllamaAdapter implements RuntimeAdapter {
  readonly id = 'ollama';
  readonly type = 'ollama' as const;
  private readonly baseURL: string;
  private readonly controllers = new Map<string, AbortController>();
  private modelSizes = new Map<string, number>();

  constructor(baseURL: string = 'http://localhost:11434') {
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
    const response = await fetch(`${this.baseURL}/api/tags`);
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { models?: OllamaTagModel[] };
    return Promise.all((data.models ?? []).map(async (model) => {
      const details = await this.showModel(model.name).catch(() => ({}));
      const info = (details as { model_info?: Record<string, unknown> }).model_info ?? {};
      const context = Object.entries(info).find(([key]) => key.endsWith('.context_length'))?.[1];
      const size = model.size ?? 0;
      this.modelSizes.set(model.name, size);
      this.modelSizes.set(normalizeModelId(model.name), size);
      const family = model.details?.family;
      return {
        id: model.name,
        name: model.name,
        family,
        parameters: model.details?.parameter_size,
        quantization: model.details?.quantization_level,
        contextWindow: typeof context === 'number' ? context : undefined,
        weightBytes: size,
        capabilities: ['generalChat'],
        toolCalling: inferToolCalling(model.name, family),
        structuredOutput: false,
        vision: (model.details?.families ?? []).includes('clip'),
        audio: false,
        embedding: (model.details?.families ?? []).some((f) => f.includes('bert') || f.includes('nomic-embed')),
        reasoning: inferReasoning(model.name),
      };
    }));
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      chat: true,
      streaming: true,
      toolCalling: true,
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

  private async showModel(modelId: string): Promise<{ model_info?: Record<string, unknown> }> {
    const response = await fetch(`${this.baseURL}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('MODEL_NOT_INSTALLED');
    return await response.json() as { model_info?: Record<string, unknown> };
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
    // Ollama has no pre-load estimation endpoint. Use architecture metadata only;
    // file size alone is insufficient to estimate the KV cache at a chosen context.
    const info = (await this.showModel(modelId)).model_info ?? {};
    const get = (suffix: string) => Object.entries(info).find(([k]) => k.endsWith(suffix))?.[1];
    const weightBytes = this.modelSizes.get(modelId) ?? this.modelSizes.get(normalizeModelId(modelId));
    const layers = get('.block_count'), heads = get('.attention.head_count'), kvHeads = get('.attention.head_count_kv'), embedding = get('.embedding_length');
    if (!weightBytes || ![layers, heads, kvHeads, embedding].every(n => typeof n === 'number' && n > 0)) return { source: 'UNKNOWN', confidence: 'unknown' };
    const contextBytes = 2 * 2 * Number(layers) * Number(kvHeads) * Number(embedding) / Number(heads) * contextTokens;
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

  async *generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    const controller = new AbortController();
    const requestId = request.requestId ?? `ollama-${Date.now()}`;
    this.controllers.set(requestId, controller);

    const messages = this.buildMessages(request);

    // Connect with retry, scoped to this fetch only — see the equivalent
    // comment in the LM Studio adapter's generate(). Ollama has the same
    // lazy-model-load window (it can refuse connections or 5xx while
    // swapping a model into memory) that motivated this.
    let response: Response | undefined;
    const retryPolicy = resolveRetryPolicy({ maxRetries: 3, initialDelayMs: 250, maxDelayMs: 8000, ...request.providerRetryPolicy });
    const maxAttempts = retryPolicy.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
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
      this.controllers.delete(requestId);
      const failureClass = classifyFailure({ status: response?.status });
      yield { type: 'error', requestId, retryAttempt: maxAttempts, failureClass, retryExhausted: isProviderRetryable(failureClass), error: `Ollama API error: HTTP ${response?.status ?? 'unknown'}` };
      return;
    }

    let full = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const buffer = createLineBuffer();

    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer.push(new TextDecoder().decode(value, { stream: true }));
        for (const line of buffer.drain()) {
          const parsed = JSON.parse(line) as OllamaChatLine;
          if (parsed.error) {
            yield { type: 'error', error: parsed.error };
            continue;
          }
          const content = parsed.message?.content;
          if (content) {
            full += content;
            yield { type: 'token', content };
          }
          for (const call of parsed.message?.tool_calls ?? []) {
            yield {
              type: 'tool_call',
              toolName: call.function.name,
              toolInput: call.function.arguments,
            };
          }
          if (parsed.done) {
            inputTokens = parsed.prompt_eval_count ?? 0;
            outputTokens = parsed.eval_count ?? 0;
          }
        }
      }
      yield {
        type: 'completed',
        content: full,
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      };
    } catch (error) {
      if (controller.signal.aborted) {
        yield { type: 'completed', content: full, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
      } else {
        yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      this.controllers.delete(requestId);
    }
  }

  async cancel(requestId: string): Promise<void> {
    this.controllers.get(requestId)?.abort();
  }

  private buildMessages(request: GenerationRequest): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    for (const message of request.messages) {
      if (message.role === 'tool') {
        messages.push({ role: 'user', content: `[tool result: ${message.content}]` });
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

export function createOllamaAdapter(baseURL?: string): RuntimeAdapter {
  return new OllamaAdapter(baseURL);
}
