import type {
  DiscoveredModel,
  GenerationEvent,
  GenerationRequest,
  HealthStatus,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeInfo,
} from '@wazir/runtimes-interfaces';

interface OpenAIModel {
  id: string;
  object?: string;
  owned_by?: string;
}

interface StreamDelta {
  content?: string;
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
}

function inferCapabilities(id: string): { toolCalling: boolean; reasoning: boolean; vision: boolean } {
  const lower = id.toLowerCase();
  const toolCalling =
    /coder|code|qwen3|llama-3|mistral|mixtral|gemma-?3|deepseek|granite|nemotron|codestral/.test(lower) ||
    !/embed|bert|nomic/.test(lower);
  const reasoning = /qwen3|deepseek-r1|.*-think|reasoner/.test(lower);
  const vision = /vl|vision|clip|gemma-?3/.test(lower);
  return { toolCalling, reasoning, vision };
}

export class LMStudioAdapter implements RuntimeAdapter {
  readonly id = 'lmstudio';
  readonly type = 'lmstudio' as const;
  private readonly baseURL: string;
  private readonly controllers = new Map<string, AbortController>();

  constructor(baseURL: string = 'http://localhost:1234/v1') {
    this.baseURL = baseURL.replace(/\/+$/, '');
  }

  async discover(): Promise<RuntimeInfo> {
    const response = await fetch(`${this.baseURL}/models`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      throw new Error(`LM Studio /models responded ${response.status}`);
    }
    return {
      id: this.id,
      name: 'LM Studio',
      version: 'unknown',
      url: this.baseURL.replace(/\/v1$/, ''),
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const response = await fetch(`${this.baseURL}/models`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) {
        return { status: 'unavailable', message: `HTTP ${response.status}` };
      }
      const data = (await response.json()) as { data?: OpenAIModel[] };
      if (!data.data || data.data.length === 0) {
        return { status: 'degraded', message: 'no models available' };
      }
      return { status: 'healthy' };
    } catch (error) {
      return { status: 'unavailable', message: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    try {
      const response = await fetch(`${this.baseURL}/models`);
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: OpenAIModel[] };
      return (data.data ?? []).map((model) => {
        const capabilities = inferCapabilities(model.id);
        return {
          id: model.id,
          name: model.id,
          capabilities: ['generalChat'],
          toolCalling: capabilities.toolCalling,
          structuredOutput: true,
          vision: capabilities.vision,
          audio: false,
          embedding: /embed|bert|nomic/.test(model.id.toLowerCase()),
          reasoning: capabilities.reasoning,
        };
      });
    } catch {
      return [];
    }
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      chat: true,
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      embeddings: false,
      reasoning: true,
      modelLoad: false,
      modelUnload: false,
      modelDownload: false,
      statefulChat: true,
      mcp: false,
    };
  }

  async getLoadedModels(): Promise<string[]> {
    const models = await this.listModels();
    return models.map((m) => m.id);
  }

  async *generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    const controller = new AbortController();
    const requestId = request.requestId ?? `lmstudio-${Date.now()}`;
    this.controllers.set(requestId, controller);

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

    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.modelId,
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
    }

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      this.controllers.delete(requestId);
      yield { type: 'error', error: `LM Studio API error: HTTP ${response.status} ${body.slice(0, 300)}` };
      return;
    }

    let full = '';
    let usage: GenerationEvent['usage'];
    const pendingToolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
    const buffer = createSSEBuffer();

    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer.push(new TextDecoder().decode(value, { stream: true }));
        for (const payload of buffer.drain()) {
          if (payload === '[DONE]') continue;
          const chunk = JSON.parse(payload) as StreamChunk;

          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            full += delta.content;
            yield { type: 'token', content: delta.content };
          }
          for (const call of delta?.tool_calls ?? []) {
            const entry = pendingToolCalls.get(call.index) ?? { arguments: '' };
            if (call.id) entry.id = call.id;
            if (call.function?.name) entry.name = call.function.name;
            if (call.function?.arguments) entry.arguments += call.function.arguments;
            pendingToolCalls.set(call.index, entry);
          }

          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens,
            };
          }
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

      if (full.length > 0 || pendingToolCalls.size > 0) {
        yield {
          type: 'completed',
          content: full,
          usage: usage ?? { inputTokens: 0, outputTokens: 0 },
        };
      }
    } catch (error) {
      if (controller.signal.aborted) {
        yield { type: 'completed', content: full, usage: usage ?? { inputTokens: 0, outputTokens: 0 } };
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

export function createLMStudioAdapter(baseURL?: string): RuntimeAdapter {
  return new LMStudioAdapter(baseURL);
}
