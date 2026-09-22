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

const API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const SECRET_KEY = 'anthropic';

// Anthropic's /v1/models endpoint returns id/display_name/created_at only —
// no capability or context-window metadata — so a small curated table fills
// the gap, same pattern as LM Studio's inferCapabilities() heuristic
// (packages/runtimes/lmstudio/src/index.ts). Keyed by id prefix; an
// unrecognized future model id still registers via the conservative
// `DEFAULT_CAPABILITIES` fallback rather than being dropped.
const DEFAULT_CAPABILITIES = { contextMax: 200_000, toolCalling: true, vision: false, reasoning: false };
const MODEL_CAPABILITY_PREFIXES: Array<{ prefix: string; contextMax: number; toolCalling: boolean; vision: boolean; reasoning: boolean }> = [
  { prefix: 'claude-opus-4', contextMax: 200_000, toolCalling: true, vision: true, reasoning: true },
  { prefix: 'claude-sonnet-4', contextMax: 200_000, toolCalling: true, vision: true, reasoning: true },
  { prefix: 'claude-haiku-4', contextMax: 200_000, toolCalling: true, vision: true, reasoning: false },
  { prefix: 'claude-3-7-sonnet', contextMax: 200_000, toolCalling: true, vision: true, reasoning: true },
  { prefix: 'claude-3-5-sonnet', contextMax: 200_000, toolCalling: true, vision: true, reasoning: false },
  { prefix: 'claude-3-5-haiku', contextMax: 200_000, toolCalling: true, vision: false, reasoning: false },
  { prefix: 'claude-3-opus', contextMax: 200_000, toolCalling: true, vision: true, reasoning: false },
];

function inferModelCapabilities(id: string): { contextMax: number; toolCalling: boolean; vision: boolean; reasoning: boolean } {
  const match = MODEL_CAPABILITY_PREFIXES.find((m) => id.startsWith(m.prefix));
  return match ?? DEFAULT_CAPABILITIES;
}

interface AnthropicModelListing {
  id: string;
  display_name?: string;
  created_at?: string;
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
 * Anthropic API-key-only adapter. OAuth is deliberately NOT implemented here:
 * Anthropic's own policy (updated Feb 2026) restricts OAuth authentication to
 * Claude Code and Claude.ai exclusively — third-party applications must use
 * an API key from console.anthropic.com. Building a browser-login option for
 * Anthropic would violate that policy and the "never emulate unsupported
 * provider authentication" rule this feature is built under.
 */
export class AnthropicAdapter implements RuntimeAdapter, ProviderAuthAdapter {
  readonly id = 'anthropic';
  readonly type = 'anthropic' as const;
  readonly provider = 'anthropic' as const;
  readonly supportedMethods: AuthMethod[] = ['api-key'];
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly secrets: SecretBroker) {}

  // ==================== ProviderAuthAdapter ====================

  async loginWithApiKey(apiKey: string): Promise<AuthLoginResult> {
    const probe = await this.probeApiKey(apiKey);
    if (!probe.ok) {
      return { ok: false, status: { provider: 'anthropic', authenticated: false, eligible: false, reason: probe.reason }, error: probe.reason };
    }
    const stored: StoredCredential = {
      provider: 'anthropic',
      method: 'api-key',
      credential: { kind: 'api-key', apiKey },
      obtainedAt: new Date().toISOString(),
    };
    await this.secrets.putCredential(SECRET_KEY, JSON.stringify(stored));
    return { ok: true, status: { provider: 'anthropic', authenticated: true, method: 'api-key', eligible: true } };
  }

  async status(): Promise<AuthStatus> {
    const stored = await this.readStoredCredential();
    if (!stored) return { provider: 'anthropic', authenticated: false, eligible: false, reason: 'not authenticated' };
    return { provider: 'anthropic', authenticated: true, method: stored.method, eligible: true };
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
    return { id: this.id, name: 'Anthropic', version: 'v1', url: API_BASE };
  }

  async healthCheck(): Promise<HealthStatus> {
    const stored = await this.readStoredCredential();
    if (!stored || stored.credential.kind !== 'api-key') {
      return { status: 'unavailable', message: 'not authenticated — run `wa auth login anthropic`' };
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
      structuredOutput: false,
      vision: true,
      embeddings: false,
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
      yield { type: 'error', error: 'not authenticated: run `wa auth login anthropic`' };
      return;
    }
    const apiKey = stored.credential.apiKey;

    const controller = new AbortController();
    const requestId = request.requestId ?? `anthropic-${Date.now()}`;
    this.controllers.set(requestId, controller);

    const system = request.systemPrompt;
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const message of request.messages) {
      if (message.role === 'system') continue; // folded into `system` above
      if (message.role === 'tool') {
        messages.push({ role: 'user', content: `[tool result: ${message.content}]` });
      } else {
        messages.push({ role: message.role, content: message.content });
      }
    }
    if (request.prompt) messages.push({ role: 'user', content: request.prompt });

    let response: Response;
    try {
      response = await fetch(`${API_BASE}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: request.modelId,
          system,
          messages,
          max_tokens: request.maxTokens ?? 4096,
          temperature: request.temperature,
          top_p: request.topP,
          stream: true,
          tools: request.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
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
      yield { type: 'error', error: `Anthropic API error: HTTP ${response.status} ${body.slice(0, 300)}` };
      return;
    }

    let full = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const pendingToolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
    const buffer = createSSEBuffer();

    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer.push(new TextDecoder().decode(value, { stream: true }));
        for (const payload of buffer.drain()) {
          let event: any;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }

          switch (event.type) {
            case 'message_start':
              inputTokens = event.message?.usage?.input_tokens ?? 0;
              break;
            case 'content_block_start':
              if (event.content_block?.type === 'tool_use') {
                pendingToolCalls.set(event.index, { id: event.content_block.id, name: event.content_block.name, arguments: '' });
              }
              break;
            case 'content_block_delta':
              if (event.delta?.type === 'text_delta' && event.delta.text) {
                full += event.delta.text;
                yield { type: 'token', content: event.delta.text };
              } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                const entry = pendingToolCalls.get(event.index) ?? { arguments: '' };
                entry.arguments += event.delta.partial_json;
                pendingToolCalls.set(event.index, entry);
              }
              break;
            case 'message_delta':
              outputTokens = event.usage?.output_tokens ?? outputTokens;
              break;
            default:
              break;
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

      yield { type: 'completed', content: full, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
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

  // ==================== internal ====================

  private async readStoredCredential(): Promise<StoredCredential | undefined> {
    const raw = await this.secrets.getCredential(SECRET_KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return isStoredCredential(parsed) && parsed.provider === 'anthropic' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async probeApiKey(apiKey: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const response = await fetch(`${API_BASE}/v1/models`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 401 || response.status === 403) return { ok: false, reason: 'invalid API key' };
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  private async listModelsWithKey(apiKey: string): Promise<DiscoveredModel[]> {
    try {
      const response = await fetch(`${API_BASE}/v1/models`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: AnthropicModelListing[] };
      return (data.data ?? []).map((model) => {
        const caps = inferModelCapabilities(model.id);
        return {
          id: model.id,
          name: model.display_name ?? model.id,
          capabilities: ['generalChat', 'coding'],
          contextWindow: caps.contextMax,
          toolCalling: caps.toolCalling,
          structuredOutput: false,
          vision: caps.vision,
          audio: false,
          embedding: false,
          reasoning: caps.reasoning,
        };
      });
    } catch {
      return [];
    }
  }
}

export function createAnthropicAdapter(secrets: SecretBroker): AnthropicAdapter {
  return new AnthropicAdapter(secrets);
}
