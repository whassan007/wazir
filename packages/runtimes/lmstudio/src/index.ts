import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);

function resolveLmsBin(): string {
  if (process.env.WAZIR_LMS_BIN && existsSync(process.env.WAZIR_LMS_BIN)) return process.env.WAZIR_LMS_BIN;
  if (process.env.LMS_BIN && existsSync(process.env.LMS_BIN)) return process.env.LMS_BIN;
  const homeLms = path.join(os.homedir(), '.lmstudio/bin/lms');
  if (existsSync(homeLms)) return homeLms;
  return 'lms';
}

interface OpenAIModel {
  id: string;
  object?: string;
  owned_by?: string;
}

interface StreamDelta {
  content?: string;
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

interface NativeModel {
  key: string; display_name?: string; max_context_length?: number; size_bytes?: number;
  params_string?: string; architecture?: string; type?: string; quantization?: { name?: string };
  capabilities?: { vision?: boolean; trained_for_tool_use?: boolean };
  loaded_instances: Array<{ id: string; config: { context_length?: number } }>;
}
export class LMStudioAdapter implements RuntimeAdapter {
  readonly id = 'lmstudio';
  readonly type = 'lmstudio' as const;
  private readonly baseURL: string;
  private readonly controllers = new Map<string, AbortController>();

  constructor(baseURL: string = 'http://localhost:1235/v1') {
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
    const diagnostics = {
      cliAvailable: false,
      serverRunning: false,
      endpoint: this.baseURL,
      apiReachable: false,
      installedModels: 0,
      loadedModels: 0,
      readyModels: 0,
      failureReason: ''
    };

    const lmsBin = resolveLmsBin();
    try {
      const { stdout } = await execFileAsync(lmsBin, ['ls'], { timeout: 3000 });
      diagnostics.cliAvailable = true;
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (/Local/.test(line)) {
          diagnostics.installedModels++;
          if (/LOADED/.test(line)) {
            diagnostics.loadedModels++;
          }
        }
      }
    } catch {
      diagnostics.cliAvailable = false;
    }

    try {
      const installed = await this.nativeModels();
      diagnostics.apiReachable = true;
      diagnostics.serverRunning = true;
      diagnostics.installedModels = installed.length;
      diagnostics.loadedModels = installed.reduce((count, model) => count + model.loaded_instances.length, 0);
      diagnostics.readyModels = diagnostics.loadedModels;
      return { status: 'healthy', diagnostics };
    } catch {
      // Older LM Studio versions may expose only the compatibility endpoint.
    }

    try {
      if (diagnostics.cliAvailable) {
        const { stdout } = await execFileAsync(lmsBin, ['server', 'status'], { timeout: 3000 });
        if (/running/.test(stdout.toLowerCase())) {
          diagnostics.serverRunning = true;
        }
      }
    } catch {
      // ignore
    }

    try {
      const response = await fetch(`${this.baseURL}/models`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) {
        diagnostics.apiReachable = true;
        return { 
          status: 'unavailable', 
          message: `HTTP ${response.status}`, 
          reason: 'INVALID_RESPONSE',
          diagnostics 
        };
      }
      diagnostics.apiReachable = true;
      diagnostics.serverRunning = true; 
      
      const data = (await response.json()) as { data?: OpenAIModel[] };
      if (!data.data) {
        diagnostics.readyModels = 0;
        return { status: 'degraded', message: 'model inventory unavailable', diagnostics };
      }
      diagnostics.readyModels = data.data.length;
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
        diagnostics
      };
    }
  }

  async startServer(): Promise<void> {
    const lmsBin = resolveLmsBin();
    try {
      const child = execFile(lmsBin, ['server', 'start']);
      child.unref();
      for (let i = 0; i < 20; i++) {
        try {
          const res = await fetch(`${this.baseURL}/models`, { signal: AbortSignal.timeout(1000) });
          if (res.ok) return;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error("Server started but API did not become reachable in time");
    } catch (err: any) {
      throw new Error(`Failed to start LM Studio server: ${err.message || String(err)}`);
    }
  }

  private async nativeModels(): Promise<NativeModel[]> {
    const response = await fetch(`${this.baseURL.replace(/\/v1$/, '')}/api/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`RUNTIME_UNAVAILABLE: LM Studio models HTTP ${response.status}`);
    const data = await response.json() as { models?: NativeModel[] };
    if (!Array.isArray(data.models)) throw new Error('RUNTIME_UNAVAILABLE: invalid model inventory');
    return data.models;
  }
  async listModels(): Promise<DiscoveredModel[]> {
    try {
      const models = await this.nativeModels();
      return models.map(m => ({ id: m.key, name: m.display_name ?? m.key, contextWindow: m.max_context_length,
        weightBytes: m.size_bytes, parameters: m.params_string, architecture: m.architecture,
        quantization: m.quantization?.name, embedding: m.type === 'embedding',
        toolCalling: m.capabilities?.trained_for_tool_use, vision: m.capabilities?.vision }));
    } catch { /* older runtimes may still expose inventory through v0 */ }

    // 1. Try LM Studio v0 API which returns rich metadata for all installed models
    try {
      const host = this.baseURL.replace(/\/v1\/?$/, '');
      const response = await fetch(`${host}/api/v0/models`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const data = (await response.json()) as {
          data?: Array<{
            id: string;
            type?: string;
            arch?: string;
            quantization?: string;
            max_context_length?: number;
            capabilities?: string[];
          }>;
        };
        if (Array.isArray(data.data) && data.data.length > 0) {
          return data.data.map((model) => {
            const capabilities = inferCapabilities(model.id);
            const isEmbedding = model.type === 'embeddings' || /embed|bert|nomic/.test(model.id.toLowerCase());
            const hasToolUse = (model.capabilities ?? []).includes('tool_use') || capabilities.toolCalling;
            return {
              id: model.id,
              name: model.id,
              architecture: model.arch,
              quantization: model.quantization,
              contextWindow: model.max_context_length,
              capabilities: ['generalChat'],
              toolCalling: isEmbedding ? false : hasToolUse,
              structuredOutput: true,
              vision: model.type === 'vlm' || capabilities.vision,
              audio: false,
              embedding: isEmbedding,
              reasoning: capabilities.reasoning,
            };
          });
        }
      }
    } catch {
      // fallback to OpenAI compatible /models
    }

    // 2. Fallback to /models
    try {
      const response = await fetch(`${this.baseURL}/models`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: OpenAIModel[] };
      return (data.data ?? []).map((model) => {
        const capabilities = inferCapabilities(model.id);
        const isEmbedding = /embed|bert|nomic/.test(model.id.toLowerCase());
        return {
          id: model.id,
          name: model.id,
          capabilities: ['generalChat'],
          toolCalling: isEmbedding ? false : capabilities.toolCalling,
          structuredOutput: true,
          vision: capabilities.vision,
          audio: false,
          embedding: isEmbedding,
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
      nativeToolCalling: true,
      parallelToolCalling: true,
      strictJsonSchema: true,
      streamingToolCalls: true,
      promptCaching: false,
      structuredOutput: true,
      vision: true,
      embeddings: false,
      reasoning: true,
      lifecycle: { discovery: true, inspection: true, contextControl: true, estimate: true, readinessProbe: true },
      modelLoad: true,
      modelUnload: true,
      modelDownload: false,
      statefulChat: true,
      mcp: false,
    };
  }

  async getLoadedModels(): Promise<string[]> {
    return (await this.nativeModels()).filter(m => m.loaded_instances.length > 0).map(m => m.key);
  }
  async inspectModel(modelId: string): Promise<import('@wazir/runtimes-interfaces').RuntimeModelInspection> {
    const model = (await this.nativeModels()).find(m => m.key === modelId || m.loaded_instances.some(i => i.id === modelId));
    const instances = model?.loaded_instances ?? [];
    if (instances.length > 1) throw new Error('RESOURCE_BUSY: multiple runtime instances require explicit selection');
    return { modelId, loaded: instances.length === 1, instanceId: instances[0]?.id,
      effectiveContext: instances[0]?.config.context_length };
  }
  async loadModel(modelId: string, options: { contextTokens?: number } = {}): Promise<void> {
    const response = await fetch(`${this.baseURL.replace(/\/v1$/, '')}/api/v1/models/load`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model: modelId, context_length: options.contextTokens, echo_load_config: true }),
    });
    if (!response.ok) throw new Error(`RUNTIME_LOAD_FAILED: LM Studio HTTP ${response.status}`);
    await response.json();
  }
  async unloadModel(modelId: string): Promise<void> {
    const state = await this.inspectModel(modelId);
    if (!state.loaded) return;
    const response = await fetch(`${this.baseURL.replace(/\/v1$/, '')}/api/v1/models/unload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ instance_id: state.instanceId }),
    });
    if (!response.ok) throw new Error(`RUNTIME_UNLOAD_FAILED: LM Studio HTTP ${response.status}`);
    await response.json();
  }
  async probeModel(modelId: string, contextTokens: number): Promise<boolean> {
    const state = await this.inspectModel(modelId);
    if (!state.loaded || state.effectiveContext !== contextTokens) return false;
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ model: state.instanceId, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 1, stream: false }),
    });
    if (!response.ok) return false;
    const data = await response.json() as { choices?: unknown[] };
    return Array.isArray(data.choices) && data.choices.length > 0;
  }
  async estimateModelLoad(modelId: string, contextTokens: number): Promise<import('@wazir/runtimes-interfaces').ModelLoadEstimate> {
    // The REST API does not expose estimation. The diagnostic CLI supports a target host.
    // Never let a remote endpoint accidentally estimate against the local daemon.
    const endpoint = new URL(this.baseURL);
    try {
      const { stdout, stderr } = await execFileAsync(resolveLmsBin(), ['load', modelId, '--estimate-only', '--context-length', String(contextTokens), '--host', endpoint.hostname, '--port', endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80')], { timeout: 15_000 });
      const output = stdout + '\n' + stderr;
      const parse = (label: string): number | undefined => {
        const match = output.match(new RegExp(label + ':\\s*([0-9.]+)\\s*([GM]i?B)', 'i'));
        if (!match) return undefined;
        const scale = match[2].toUpperCase().startsWith('G') ? 1024 ** 3 : 1024 ** 2;
        return Number(match[1]) * scale;
      };
      const totalMemoryBytes = parse('Estimated Total Memory');
      if (totalMemoryBytes !== undefined) return { totalMemoryBytes, vramBytes: parse('Estimated GPU Memory'), source: 'RUNTIME', confidence: 'medium' };
    } catch { /* unavailable CLI/estimator remains unknown */ }
    return { source: 'UNKNOWN', confidence: 'unknown' };
  }

  async estimateResources(modelId: string): Promise<ResourceEstimate> {
    const e = await this.estimateModelLoad(modelId, 4096);
    return { minMemoryGB: e.totalMemoryBytes === undefined ? undefined : e.totalMemoryBytes / 1024 ** 3 };
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

    // Connect with retry: LM Studio legitimately takes seconds to lazily swap
    // a model into VRAM and can refuse connections or 5xx during that
    // window. Scoped to *this* fetch only — once the response streams back
    // and we start reading tokens from it, a retry would duplicate or drop
    // output the caller may have already consumed, so nothing past this
    // point is retried.
    let response: Response | undefined;
    const retryPolicy = resolveRetryPolicy({ maxRetries: 3, initialDelayMs: 250, maxDelayMs: 8000, ...request.providerRetryPolicy });
    const maxAttempts = retryPolicy.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const candidate = await fetch(`${this.baseURL}/chat/completions`, {
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
            tool_choice: request.toolChoice,
            response_format: request.responseFormat,
          }),
          signal: controller.signal,
        });
        const decision = providerRetryDecision(classifyFailure({ status: candidate.status }), attempt, retryPolicy);
        if (decision.retry) {
          await candidate.text().catch(() => undefined); // drain so the connection can be reused
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
      const failureClass = classifyFailure({ status: response?.status });
      yield { type: 'error', requestId, retryAttempt: maxAttempts, failureClass, retryExhausted: isProviderRetryable(failureClass), error: `LM Studio API error: HTTP ${response?.status ?? 'unknown'} ${body.slice(0, 300)}` };
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
          const text = delta?.content || delta?.reasoning_content;
          if (text) {
            full += text;
            yield { type: 'token', content: text };
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

      yield {
        type: 'completed',
        content: full,
        usage: usage ?? { inputTokens: 0, outputTokens: 0 },
      };
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
