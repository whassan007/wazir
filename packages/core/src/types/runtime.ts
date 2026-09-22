export type RuntimeType =
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible'
  | 'llama-cpp'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'other';

/** Runtimes registered with this kind have no `computerId`/hardware affinity
 *  and are never placed through the scheduler's Computer-resolution path —
 *  see `Scheduler.scheduleComputer()`. Absent means 'local' (every runtime
 *  registered before this field existed is local). */
export type RuntimeKind = 'local' | 'hosted';

export const HOSTED_RUNTIME_TYPES: ReadonlySet<RuntimeType> = new Set(['anthropic', 'openai', 'google']);

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
  /** Defaults to 'local' when absent (set by RuntimeRegistry.register()). */
  runtimeKind?: RuntimeKind;
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
  runtimeKind?: RuntimeKind;
  capabilities: RuntimeCapabilities;
}
