import type {
  AuthLoginResult,
  AuthMethod,
  AuthStatus,
  DiscoveredModel,
  GenerationEvent,
  GenerationRequest,
  HealthStatus,
  ProviderAuthAdapter,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeInfo,
  StoredCredential,
} from '@wazir/runtimes-interfaces';
import { isStoredCredential } from '@wazir/runtimes-interfaces';
import type { SecretBroker } from '@wazir/secrets';

const API_BASE = 'https://api.openai.com';
const SECRET_KEY = 'openai';

// OpenAI's /v1/models returns id/object/owned_by/created only — no
// capability or context-window metadata — so a small curated table fills
// the gap, same pattern as LM Studio's inferCapabilities() heuristic.
const DEFAULT_CAPABILITIES = { contextMax: 128_000, toolCalling: true, vision: false, reasoning: false, structuredOutput: true };
const MODEL_CAPABILITY_PREFIXES: Array<{
  prefix: string;
  contextMax: number;
  toolCalling: boolean;
  vision: boolean;
  reasoning: boolean;
  structuredOutput: boolean;
}> = [
  { prefix: 'o3', contextMax: 200_000, toolCalling: true, vision: true, reasoning: true, structuredOutput: true },
  { prefix: 'o1', contextMax: 200_000, toolCalling: true, vision: true, reasoning: true, structuredOutput: true },
  { prefix: 'gpt-4o', contextMax: 128_000, toolCalling: true, vision: true, reasoning: false, structuredOutput: true },
  { prefix: 'gpt-4-turbo', contextMax: 128_000, toolCalling: true, vision: true, reasoning: false, structuredOutput: true },
  { prefix: 'gpt-4', contextMax: 8_192, toolCalling: true, vision: false, reasoning: false, structuredOutput: true },
  { prefix: 'gpt-3.5', contextMax: 16_385, toolCalling: true, vision: false, reasoning: false, structuredOutput: false },
  { prefix: 'text-embedding', contextMax: 8_191, toolCalling: false, vision: false, reasoning: false, structuredOutput: false },
];

function inferModelCapabilities(id: string) {
  return MODEL_CAPABILITY_PREFIXES.find((m) => id.startsWith(m.prefix)) ?? DEFAULT_CAPABILITIES;
}

interface OpenAIModelListing {
  id: string;
  object?: string;
  owned_by?: string;
}

interface StreamDelta {
  content?: string;
  tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
}

interface StreamChunk {
  choices?: Array<{ delta?: StreamDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
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

/**
 * OpenAI API-key-only adapter. OAuth is deliberately NOT implemented here:
 * the OpenAI Platform API has no `/oauth/authorize` endpoint that mints API
 * credentials billed to a user's account — `auth.openai.com`'s OAuth surface
 * ("Sign in with ChatGPT") authenticates a *consumer identity into a ChatGPT
 * app* (Apps SDK / Custom GPT Actions / MCP servers ChatGPT connects to),
 * which is the opposite direction from what this adapter needs (Wazir
 * obtaining API access), and is not a documented mechanism for third-party
 * API credential issuance.
 */
export class OpenAIAdapter implements RuntimeAdapter, ProviderAuthAdapter {
  readonly id = 'openai';
  readonly type = 'openai' as const;
  readonly provider = 'openai' as const;
  readonly supportedMethods: AuthMethod[] = ['api-key'];
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly secrets: SecretBroker) {}

  // ==================== ProviderAuthAdapter ====================

  async loginWithApiKey(apiKey: string): Promise<AuthLoginResult> {
    const probe = await this.probeApiKey(apiKey);
    if (!probe.ok) {
      return { ok: false, status: { provider: 'openai', authenticated: false, eligible: false, reason: probe.reason }, error: probe.reason };
    }
    const stored: StoredCredential = {
      provider: 'openai',
      method: 'api-key',
      credential: { kind: 'api-key', apiKey },
      obtainedAt: new Date().toISOString(),
    };
    await this.secrets.putCredential(SECRET_KEY, JSON.stringify(stored));
    return { ok: true, status: { provider: 'openai', authenticated: true, method: 'api-key', eligible: true } };
  }

  async status(): Promise<AuthStatus> {
    const stored = await this.readStoredCredential();
    if (!stored) return { provider: 'openai', authenticated: false, eligible: false, reason: 'not authenticated' };
    return { provider: 'openai', authenticated: true, method: stored.method, eligible: true };
  }

  async logout(): Promise<void> {
    await this.secrets.deleteCredential(SECRET_KEY);
  }

  async discoverModels(): Promise<DiscoveredModel[]> {
    const stored = await this.readStoredCredential();
    if (!stored || stored.credential.kind !== 'api-key') return [];
    return this.listModelsWithKey(stored.credential.apiKey);
  }

  // ==================== RuntimeAdapter ====================

  async discover(): Promise<RuntimeInfo> {
    return { id: this.id, name: 'OpenAI', version: 'v1', url: API_BASE };
  }

  async healthCheck(): Promise<HealthStatus> {
    const stored = await this.readStoredCredential();
    if (!stored || stored.credential.kind !== 'api-key') {
      return { status: 'unavailable', message: 'not authenticated — run `wa auth login openai`' };
    }
    const probe = await this.probeApiKey(stored.credential.apiKey);
    return probe.ok ? { status: 'healthy' } : { status: 'unavailable', message: probe.reason };
  }

  async listModels(): Promise<DiscoveredModel[]> {
    return this.discoverModels();
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      chat: true,
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      embeddings: true,
      reasoning: true,
      modelLoad: false,
      modelUnload: false,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    };
  }

  async *generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    const stored = await this.readStoredCredential();
    if (!stored || stored.credential.kind !== 'api-key') {
      yield { type: 'error', error: 'not authenticated: run `wa auth login openai`' };
      return;
    }
    const apiKey = stored.credential.apiKey;

    const controller = new AbortController();
    const requestId = request.requestId ?? `openai-${Date.now()}`;
    this.controllers.set(requestId, controller);

    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    for (const message of request.messages) {
      if (message.role === 'tool') {
        messages.push({ role: 'user', content: `[tool result: ${message.content}]` });
      } else {
        messages.push({ role: message.role, content: message.content });
      }
    }
    if (request.prompt) messages.push({ role: 'user', content: request.prompt });

    let response: Response;
    try {
      response = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: request.modelId,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: request.temperature,
          top_p: request.topP,
          max_tokens: request.maxTokens,
          tools: request.tools?.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      this.controllers.delete(requestId);
      yield { type: 'error', error: controller.signal.aborted ? 'cancelled' : error instanceof Error ? error.message : String(error) };
      return;
    }

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      this.controllers.delete(requestId);
      yield { type: 'error', error: `OpenAI API error: HTTP ${response.status} ${body.slice(0, 300)}` };
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
          let chunk: StreamChunk;
          try {
            chunk = JSON.parse(payload) as StreamChunk;
          } catch {
            continue;
          }

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
        yield { type: 'tool_call', toolCallId: entry.id ?? `tool-${index}`, toolName: entry.name ?? 'unknown', toolInput: parsed };
      }

      yield { type: 'completed', content: full, usage: usage ?? { inputTokens: 0, outputTokens: 0 } };
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

  // ==================== internal ====================

  private async readStoredCredential(): Promise<StoredCredential | undefined> {
    const raw = await this.secrets.getCredential(SECRET_KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return isStoredCredential(parsed) && parsed.provider === 'openai' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async probeApiKey(apiKey: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const response = await fetch(`${API_BASE}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 401) return { ok: false, reason: 'invalid API key' };
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  private async listModelsWithKey(apiKey: string): Promise<DiscoveredModel[]> {
    try {
      const response = await fetch(`${API_BASE}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: OpenAIModelListing[] };
      return (data.data ?? [])
        .filter((model) => !/^(whisper|tts|dall-e|text-moderation)/.test(model.id))
        .map((model) => {
          const caps = inferModelCapabilities(model.id);
          const isEmbedding = model.id.startsWith('text-embedding');
          return {
            id: model.id,
            name: model.id,
            capabilities: isEmbedding ? ['embedding'] : ['generalChat', 'coding'],
            contextWindow: caps.contextMax,
            toolCalling: caps.toolCalling,
            structuredOutput: caps.structuredOutput,
            vision: caps.vision,
            audio: false,
            embedding: isEmbedding,
            reasoning: caps.reasoning,
          };
        });
    } catch {
      return [];
    }
  }
}

export function createOpenAIAdapter(secrets: SecretBroker): OpenAIAdapter {
  return new OpenAIAdapter(secrets);
}
