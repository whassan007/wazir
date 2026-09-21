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
    return (data.models ?? []).map((model) => {
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
        contextWindow: undefined,
        capabilities: ['generalChat'],
        toolCalling: inferToolCalling(model.name, family),
        structuredOutput: false,
        vision: (model.details?.families ?? []).includes('clip'),
        audio: false,
        embedding: (model.details?.families ?? []).some((f) => f.includes('bert') || f.includes('nomic-embed')),
        reasoning: inferReasoning(model.name),
      };
    });
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
      modelLoad: true,
      modelUnload: true,
      modelDownload: true,
      statefulChat: true,
      mcp: false,
    };
  }

  async getLoadedModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseURL}/api/ps`);
      if (!response.ok) return [];
      const data = (await response.json()) as { models?: Array<{ name: string }> };
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  async loadModel(modelId: string): Promise<void> {
    const response = await fetch(`${this.baseURL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, keep_alive: -1 }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Failed to load model '${modelId}' via Ollama: HTTP ${response.status} ${errText}`);
    }
  }

  async unloadModel(modelId: string): Promise<void> {
    const response = await fetch(`${this.baseURL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, keep_alive: 0 }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Failed to unload model '${modelId}' via Ollama: HTTP ${response.status} ${errText}`);
    }
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

    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/api/chat`, {
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
    } catch (error) {
      this.controllers.delete(requestId);
      if (controller.signal.aborted) {
        yield { type: 'error', error: 'cancelled' };
      } else {
        yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
      }
      return;
    } finally {
      // Keep the controller registered until the stream settles.
    }

    if (!response.ok || !response.body) {
      this.controllers.delete(requestId);
      yield { type: 'error', error: `Ollama API error: HTTP ${response.status}` };
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
