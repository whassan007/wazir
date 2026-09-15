import type { RuntimeType } from './runtime.js';
import type { ModelCapability } from './capability.js';

export type ModelFamily =
  | 'qwen'
  | 'gpt'
  | 'gemma'
  | 'nemotron'
  | 'llama'
  | 'mistral'
  | 'granite'
  | 'deepseek'
  | 'phi'
  | 'other';

export interface MemoryRequirements {
  minSystemGB?: number;
  minGpuGB?: number;
  quantization?: string;
}

/**
 * A first-class model record. A single record may have many instances
 * (one per computer/runtime pair) — see ModelInstance.
 */
export interface ModelRecord {
  id: string;
  name: string;
  provider: string;
  family: ModelFamily;
  architecture?: string;
  parameters?: string;
  /** Maximum context the model family supports. */
  contextMax: number;
  /** Operator-configured context (<= contextMax). Used when the runtime does not report it. */
  configuredContext?: number;
  capabilities: ModelCapability[];
  toolCalling: boolean;
  structuredOutput: boolean;
  vision: boolean;
  audio: boolean;
  embedding: boolean;
  reasoning: boolean;
  quantization?: string;
  memory?: MemoryRequirements;
  runtimeCompatibility: RuntimeType[] | 'any';
  local: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A concrete serving of a model on a computer via a runtime. */
export interface ModelInstance {
  id: string;
  modelId: string;
  computerId: string;
  runtimeId: string;
  runtimeModelId: string;
  loaded: boolean;
  health: 'healthy' | 'degraded' | 'unavailable';
  contextTokens?: number;
  loadTimeMs?: number;
  lastUsedAt?: Date;
  lastCheckedAt?: Date;
}

export interface ModelRequirements {
  capabilities?: ModelCapability[];
  minimumContext?: number;
  toolCalling?: boolean;
  structuredOutput?: boolean;
  vision?: boolean;
  audio?: boolean;
  reasoning?: boolean;
  minimumMemoryGB?: number;
}

/** The context a model is actually usable with: configured wins over the family maximum. */
export function effectiveContextTokens(model: Pick<ModelRecord, 'contextMax' | 'configuredContext'>): number {
  return model.configuredContext ?? model.contextMax;
}
