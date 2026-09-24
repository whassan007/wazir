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
  version?: string;
  memory?: MemoryRequirements;
  runtimeCompatibility: RuntimeType[] | 'any';
  local: boolean;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Empirically measured behavior per task class, derived from Wazir's own execution
   * evidence (see `measureModelPerformance`). Never hand-entered or speculative; absent
   * until the model has actually run tasks of that class.
   */
  performance?: Record<string, ModelPerformanceProfile>;
}

/**
 * Measured from durable execution records. Rates are fractions in [0, 1] over the runs
 * that could observe them; a rate is null when no run could (e.g. no run ever built).
 */
export interface ModelPerformanceProfile {
  taskClass: string;
  /** Runs with a typed termination attributed to this model. */
  samples: number;
  /** Runs that ended VERIFICATION_PASSED/COMPLETED. */
  verifiedSuccessRate: number;
  /** First build check of a run passed, over runs that built. */
  firstPassBuildRate: number | null;
  /** First test check of a run passed, over runs that tested. */
  firstPassTestRate: number | null;
  /** Protocol-budget exhaustion (as termination or escalation cause) per run. */
  protocolFailureRate: number;
  /** NO_PROGRESS / REPEATED_ACTION (as termination or escalation cause) per run. */
  noProgressRate: number;
  /** Valid actions / attempted actions across runs that reported protocol metrics. */
  schemaReliability: number | null;
  medianToolCalls: number | null;
  medianDurationMs: number | null;
  measuredAt: Date;
}

export type ModelLifecycleState =
  | 'DISCOVERED'
  | 'INSTALLED'
  | 'LOADING'
  | 'LOADED'
  | 'READY'
  | 'DRAINING'
  | 'UNLOADED'
  | 'UNLOADING'
  | 'FAILED'
  | 'UNAVAILABLE';

export type ModelLifecycleEventType =
  | 'MODEL_INSTALLED' | 'MODEL_LOADED' | 'MODEL_UNLOADING' | 'MODEL_DRAINING'
  | 'MODEL_LOAD_PLAN_CREATED' | 'MODEL_ADMISSION_STARTED' | 'MODEL_ADMISSION_GRANTED' | 'MODEL_ADMISSION_DENIED'
  | 'MODEL_CONTEXT_SELECTED' | 'MODEL_CONTEXT_DOWNSHIFTED'
  | 'RESOURCE_RESERVATION_CREATED' | 'RESOURCE_RESERVATION_RELEASED'
  | 'MODEL_EVICTION_PLANNED' | 'MODEL_EVICTED' | 'MODEL_RECONCILED' | 'WAITING_FOR_MODEL' 
  | 'MODEL_DISCOVERED'
  | 'MODEL_LOAD_REQUESTED'
  | 'MODEL_LOADING'
  | 'MODEL_READY'
  | 'MODEL_LOAD_FAILED'
  | 'MODEL_UNLOAD_REQUESTED'
  | 'MODEL_UNLOADED'
  | 'MODEL_RESTORE_STARTED'
  | 'MODEL_RESTORE_COMPLETED';

export interface ModelLifecycleEvent {
  type: ModelLifecycleEventType;
  modelId: string;
  runtimeId?: string;
  computerId?: string;
  workerId?: string;
  initiator?: string;
  timestamp: Date;
  reason?: string;
  error?: string;
  data?: Record<string, unknown>;
}

/** A concrete serving of a model on a computer via a runtime. */
export interface ModelInstance {
  id: string;
  modelId: string;
  /** Absent for a hosted-provider instance (Anthropic/OpenAI/Google) — those
   *  have no Computer/hardware affinity by design (see HOSTED_RUNTIME_TYPES). */
  computerId?: string;
  runtimeId: string;
  runtimeModelId: string;
  loaded: boolean;
  state?: ModelLifecycleState;
  health: 'healthy' | 'degraded' | 'unavailable';
  contextTokens?: number;
  loadTimeMs?: number;
  lastUsedAt?: Date;
  lastCheckedAt?: Date;
  error?: string;
  installationId?: string;
  desired?: { state: 'READY' | 'UNLOADED'; contextTokens?: number };
  pinned?: boolean;
  residentMemoryBytes?: number;
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

/**
 * Estimates minimum system RAM needed to host a model based on parameter size,
 * quantization, and context/runtime overhead.
 */
export function estimateModelMemory(
  parameters?: string,
  modelId?: string,
  quantization?: string,
): { minSystemGB: number; minGpuGB?: number } {
  let paramBillion: number | undefined;
  if (parameters) {
    const match = parameters.trim().match(/^([0-9.]+)\s*([bBmM])?$/);
    if (match) {
      const num = parseFloat(match[1]);
      const unit = (match[2] ?? 'B').toUpperCase();
      if (unit === 'M') {
        paramBillion = num / 1000;
      } else {
        paramBillion = num;
      }
    }
  }

  if (paramBillion === undefined && modelId) {
    const match = modelId.match(/[:\-_]([0-9.]+)b(?::|[\-_]|$)/i);
    if (match) {
      paramBillion = parseFloat(match[1]);
    }
  }

  if (paramBillion !== undefined && !isNaN(paramBillion) && paramBillion > 0) {
    const is8Bit = quantization?.toLowerCase().includes('q8') || quantization?.toLowerCase().includes('8bit');
    const is16Bit = quantization?.toLowerCase().includes('16') || quantization?.toLowerCase().includes('f16');
    const bytesPerParam = is16Bit ? 2.2 : is8Bit ? 1.2 : 0.75;
    const estimatedGB = Math.max(1, Math.ceil(paramBillion * bytesPerParam + 1.5));
    return {
      minSystemGB: estimatedGB,
      minGpuGB: undefined,
    };
  }

  return {
    minSystemGB: 8,
    minGpuGB: undefined,
  };
}

/** An installation exists independently of any serving instance. */
export interface ModelInstallation {
  id: string;
  modelId: string;
  computerId: string;
  runtimeId: string;
  runtimeModelId: string;
  installed: boolean;
  observedAt: Date;
  profile?: ModelResourceProfile;
}
export interface ModelResourceProfile {
  modelId: string;
  runtimeId: string;
  parameterCount?: number;
  quantization?: string;
  weightBytes?: number;
  minimumContext?: number;
  maximumContext?: number;
  runtimeMaximumContext?: number;
  runtimeMinimumContext?: number;
  contextBytesPerToken?: number;
  runtimeOverheadBytes?: number;
  metadata: Record<string, unknown>;
}
