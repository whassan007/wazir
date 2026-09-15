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
}

export interface RuntimeCapabilities {
  chat: boolean;
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  vision: boolean;
  embeddings: boolean;
  reasoning: boolean;
  modelLoad: boolean;
  modelUnload: boolean;
  modelDownload: boolean;
  statefulChat: boolean;
  mcp: boolean;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unavailable';
  message?: string;
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
  type: 'token' | 'tool_call' | 'completed' | 'error';
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  usage?: Usage;
  error?: string;
}

export interface ResourceEstimate {
  minMemoryGB?: number;
  minGpuGB?: number;
}

/**
 * The stable provider contract. Rook core never depends on a concrete
 * runtime — only on this interface. Adapters are replaceable.
 */
export interface RuntimeAdapter {
  readonly id: string;
  readonly type: 'ollama' | 'lmstudio' | 'openai-compatible' | 'other';

  discover(): Promise<RuntimeInfo>;
  healthCheck(): Promise<HealthStatus>;
  listModels(): Promise<DiscoveredModel[]>;
  getCapabilities(): Promise<RuntimeCapabilities>;

  generate(request: GenerationRequest): AsyncIterable<GenerationEvent>;

  loadModel?(modelId: string): Promise<void>;
  unloadModel?(modelId: string): Promise<void>;
  getLoadedModels?(): Promise<string[]>;
  estimateResources?(modelId: string): Promise<ResourceEstimate>;

  cancel?(requestId: string): Promise<void>;
}
