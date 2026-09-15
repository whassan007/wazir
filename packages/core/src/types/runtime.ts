export type RuntimeType = 'ollama' | 'lmstudio' | 'openai-compatible' | 'llama-cpp' | 'other';

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

export interface RuntimeRecord {
  id: string;
  type: RuntimeType;
  name: string;
  version: string;
  url?: string;
  computerId?: string;
  health: 'healthy' | 'degraded' | 'unavailable';
  capabilities: RuntimeCapabilities;
  loadedModels: string[];
  lastCheckedAt?: Date;
}

export interface RuntimeRegistration {
  id: string;
  type: RuntimeType;
  name: string;
  version: string;
  url?: string;
  computerId?: string;
  capabilities: RuntimeCapabilities;
}
