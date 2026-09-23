export interface RuntimeInfo {
  id: string;
  name: string;
  version: string;
  url?: string;
}

export interface DiscoveredModel {
  /** Runtime-local model id, e.g. 'qwen3-coder:latest' or 'qwen/qwen3-coder-next'. */
  id: string;
  name?: string;
  family?: string;
  parameters?: string;
  architecture?: string;
  /** Reported context window when the runtime provides it. */
  contextWindow?: number;
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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerationRequest {
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
  /** Context window to request from the runtime (num_ctx / context length). */
  contextTokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  /** Host-generated id used for cancellation. */
  requestId?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export interface GenerationEvent {
  failureClass?: import('@wazir/shared').FailureClass;
  retryExhausted?: boolean;
  requestId?: string;
  type: 'token' | 'tool_call' | 'completed' | 'error' | 'retry';
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  usage?: Usage;
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
  readonly type: 'ollama' | 'lmstudio' | 'openai-compatible' | 'llama-cpp' | 'anthropic' | 'openai' | 'google' | 'other';

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
