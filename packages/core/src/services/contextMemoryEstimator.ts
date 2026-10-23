import type { ModelRecord } from '../types/model.js';
import type { RuntimeType } from '../types/runtime.js';
import { HOSTED_RUNTIME_TYPES } from '../types/runtime.js';

export const STANDARD_CONTEXT_TIERS: readonly number[] = [
  4_096,
  8_192,
  16_384,
  32_768,
  65_536,
  131_072,
] as const;

export const DEFAULT_UNKNOWN_CONTEXT_MAX = 8_192;
export const DEFAULT_CONSERVATIVE_WEIGHTS_GB = 4.5;
export const DEFAULT_CONSERVATIVE_KV_BYTES_PER_TOKEN = 131_072; // ~128 KB per token (approx 8B model)

function roundGB(val: number): number {
  return Number((Math.round(val * 1000) / 1000).toFixed(3));
}

export interface ContextAllocationPlan {
  modelId: string;
  eligible: boolean;
  fits: boolean;
  allocatedContextTokens: number;
  inputBudgetTokens: number;
  outputReserveTokens: number;
  advertisedContextMax: number;
  weightsMemoryGB: number;
  runtimeOverheadGB: number;
  kvCacheMemoryGB: number;
  totalRequiredMemoryGB: number;
  incrementalRequiredMemoryGB: number;
  downshiftedFromMax: boolean;
  reason: string;
  shortReason?: string;
}

export interface ContextEstimationInput {
  model: ModelRecord;
  estimatedInputTokens?: number;
  requiredMinimumContext?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  availableMemoryGB?: number;
  usableMemoryGB?: number;
  alreadyLoaded?: boolean;
  isAlreadyLoaded?: boolean;
  loadedContextTokens?: number;
  currentLoadedContextTokens?: number;
  loadedWeightsMemoryGB?: number;
}

export type ContextPlanParams = ContextEstimationInput;

/**
 * Parses parameter count in billions from parameters string, modelId, or name.
 */
export function parseParameterCountBillion(
  parameters?: string,
  modelId?: string,
  modelName?: string,
): number | undefined {
  if (parameters) {
    const match = parameters.trim().match(/^([0-9.]+)\s*([bBmM])?$/);
    if (match) {
      const num = parseFloat(match[1]);
      const unit = (match[2] ?? 'B').toUpperCase();
      if (!isNaN(num) && num > 0) {
        return unit === 'M' ? num / 1000 : num;
      }
    }
  }

  const checkString = (str?: string): number | undefined => {
    if (!str) return undefined;
    // Match patterns like "70b", "1.5b", "12b", "7B", "800M"
    const match = str.match(/(?:^|[:\-_/ ])([0-9.]+)\s*([bBmM])(?::|[\-_/ ]|$)/i);
    if (match) {
      const num = parseFloat(match[1]);
      const unit = match[2].toUpperCase();
      if (!isNaN(num) && num > 0) {
        return unit === 'M' ? num / 1000 : num;
      }
    }
    return undefined;
  };

  return checkString(modelId) ?? checkString(modelName);
}

/**
 * Returns estimated bytes per parameter based on quantization specifiers.
 */
export function getBytesPerParam(
  quantization?: string,
  modelId?: string,
  modelName?: string,
): number {
  const combined = `${quantization ?? ''} ${modelId ?? ''} ${modelName ?? ''}`.toLowerCase();

  if (combined.includes('32') || combined.includes('fp32') || combined.includes('f32')) {
    return 4.2;
  }
  if (combined.includes('16') || combined.includes('fp16') || combined.includes('f16') || combined.includes('bf16')) {
    return 2.1;
  }
  if (combined.includes('q8') || combined.includes('8bit') || combined.includes('int8') || combined.includes('8-bit')) {
    return 1.15;
  }
  if (combined.includes('q6') || combined.includes('6bit') || combined.includes('6-bit')) {
    return 0.85;
  }
  if (combined.includes('q5') || combined.includes('5bit') || combined.includes('5-bit')) {
    return 0.72;
  }
  if (combined.includes('q4') || combined.includes('4bit') || combined.includes('int4') || combined.includes('4-bit')) {
    return 0.60;
  }
  if (combined.includes('q3') || combined.includes('3bit') || combined.includes('3-bit')) {
    return 0.45;
  }
  if (combined.includes('q2') || combined.includes('2bit') || combined.includes('2-bit')) {
    return 0.35;
  }

  // Default to standard 4-bit (Q4_K_M) quantization for local models
  return 0.60;
}

/**
 * Estimates model weight memory in GB based on model parameters, quantization, and memory records.
 */
export function estimateWeightsGB(model: ModelRecord): number {
  if (model.memory?.minGpuGB !== undefined && model.memory.minGpuGB > 0) {
    return model.memory.minGpuGB;
  }

  const paramBillion = parseParameterCountBillion(model.parameters, model.id, model.name);
  if (paramBillion !== undefined && paramBillion > 0) {
    const bytesPerParam = getBytesPerParam(
      model.quantization ?? model.memory?.quantization,
      model.id,
      model.name,
    );
    const rawGB = paramBillion * bytesPerParam;
    return Math.round(rawGB * 100) / 100;
  }

  if (model.memory?.minSystemGB !== undefined && model.memory.minSystemGB > 0) {
    // minSystemGB typically accounts for weights + ~1.5GB runtime overhead
    return Math.max(0.5, Math.round((model.memory.minSystemGB - 1.5) * 100) / 100);
  }

  if (model.local === false) {
    return 0;
  }

  return DEFAULT_CONSERVATIVE_WEIGHTS_GB;
}

/**
 * Estimates runtime overhead in GB. Hosted models require 0GB local overhead,
 * while local runtimes require ~0.5 - 1.5GB.
 */
export function estimateRuntimeOverheadGB(
  model: ModelRecord,
  runtimeType?: RuntimeType,
): number {
  const rt =
    runtimeType ??
    (Array.isArray(model.runtimeCompatibility) && model.runtimeCompatibility.length > 0
      ? model.runtimeCompatibility[0]
      : undefined);

  if (rt && HOSTED_RUNTIME_TYPES.has(rt)) {
    return 0;
  }
  if (model.local === false && (!rt || HOSTED_RUNTIME_TYPES.has(rt))) {
    return 0;
  }

  if (rt === 'llama-cpp') {
    return 0.5;
  }
  if (rt === 'lmstudio') {
    return 1.2;
  }
  if (rt === 'ollama') {
    return 0.8;
  }
  if (rt === 'openai-compatible') {
    return 0.8;
  }

  return 0.8;
}

/**
 * Estimates KV-cache bytes per token scaling with parameter count and attention layers.
 */
export function estimateKvCacheBytesPerToken(paramBillion?: number): number {
  if (!paramBillion || paramBillion <= 0) {
    return DEFAULT_CONSERVATIVE_KV_BYTES_PER_TOKEN;
  }
  if (paramBillion <= 2) {
    // ~1B - 2B (e.g. Qwen 1.5B: 28 layers, 2 KV heads, dim 128, fp16)
    return 28_672;
  }
  if (paramBillion <= 4) {
    // ~3B (e.g. Llama 3.2 3B: 28 layers, 8 KV heads, dim 128, fp16)
    return 57_344;
  }
  if (paramBillion <= 10) {
    // ~7B - 8B (e.g. Llama 3 8B: 32 layers, 8 KV heads, dim 128, fp16)
    return 131_072;
  }
  if (paramBillion <= 16) {
    // ~12B - 14B (e.g. Mistral NeMo 12B, Qwen 14B: 40 layers, 8 KV heads, dim 128, fp16)
    return 163_840;
  }
  if (paramBillion <= 35) {
    // ~27B - 32B (e.g. Gemma 2 27B: 46 layers, 16 KV heads, dim 128, fp16)
    return 376_832;
  }
  // 70B+ (e.g. Llama 3 70B: 80 layers, 8 KV heads, dim 128, fp16)
  return 327_680;
}

/**
 * Estimates KV-cache memory in GB for a given context token count.
 */
export function estimateKvCacheGB(model: ModelRecord, contextTokens: number): number {
  if (contextTokens <= 0) {
    return 0;
  }
  if (model.local === false && !model.parameters) {
    return 0;
  }

  const paramBillion = parseParameterCountBillion(model.parameters, model.id, model.name);
  const bytesPerToken = estimateKvCacheBytesPerToken(paramBillion);
  const totalBytes = bytesPerToken * contextTokens;
  const gb = totalBytes / (1024 * 1024 * 1024);
  return Math.round(gb * 100) / 100;
}

/**
 * Selects the smallest sufficient context configuration and plans memory allocation.
 */
export function planContextAllocation(params: ContextPlanParams): ContextAllocationPlan {
  return new ContextMemoryEstimator().planContextAllocation(params);
}

/**
 * Estimator service managing model context memory planning and allocation.
 */
export class ContextMemoryEstimator {
  public estimateWeightsGB(model: ModelRecord): number {
    return estimateWeightsGB(model);
  }

  public estimateRuntimeOverheadGB(model: ModelRecord, runtimeType?: RuntimeType): number {
    return estimateRuntimeOverheadGB(model, runtimeType);
  }

  public estimateKvCacheGB(model: ModelRecord, contextTokens: number): number {
    return estimateKvCacheGB(model, contextTokens);
  }

  public static planContextAllocation(params: ContextPlanParams): ContextAllocationPlan {
    return new ContextMemoryEstimator().planContextAllocation(params);
  }

  public planContextAllocation(params: ContextPlanParams): ContextAllocationPlan {
    const { model } = params;
    const isHosted = model.local === false;
    const isAlreadyLoaded = params.isAlreadyLoaded ?? params.alreadyLoaded ?? false;
    const loadedContextTokens = params.currentLoadedContextTokens ?? params.loadedContextTokens;
    const availableMem = params.usableMemoryGB ?? params.availableMemoryGB;

    // 1. Output reserve tokens based on reasoningEffort
    const reasoningEffort = params.reasoningEffort ?? 'medium';
    let outputReserveTokens =
      reasoningEffort === 'low' ? 1024 : reasoningEffort === 'high' ? 4096 : 2048;
    if (model.maxOutputTokens !== undefined && model.maxOutputTokens > 0) {
      outputReserveTokens = Math.min(outputReserveTokens, model.maxOutputTokens);
    }

    // 2. Minimum required context
    const inputTokens = Math.max(0, params.estimatedInputTokens ?? 0);
    let minimumRequiredContext = inputTokens + outputReserveTokens;
    if (params.requiredMinimumContext !== undefined && params.requiredMinimumContext > 0) {
      minimumRequiredContext = Math.max(minimumRequiredContext, params.requiredMinimumContext);
    }

    // 3. Advertised and effective max context
    const advertisedContextMax =
      model.contextMax && model.contextMax > 0 ? model.contextMax : DEFAULT_UNKNOWN_CONTEXT_MAX;
    const configuredContext =
      model.configuredContext && model.configuredContext > 0 ? model.configuredContext : undefined;
    const effectiveContextMax =
      configuredContext !== undefined
        ? Math.min(configuredContext, advertisedContextMax)
        : advertisedContextMax;

    // 4. Weights and runtime overhead
    const weightsMemoryGB = isHosted ? 0 : this.estimateWeightsGB(model);
    const runtimeType =
      Array.isArray(model.runtimeCompatibility) && model.runtimeCompatibility.length > 0
        ? model.runtimeCompatibility[0]
        : undefined;
    const runtimeOverheadGB = isHosted ? 0 : this.estimateRuntimeOverheadGB(model, runtimeType);

    // 5. Check if minimum required context exceeds effective max
    if (minimumRequiredContext > effectiveContextMax) {
      const baseKv = isHosted ? 0 : this.estimateKvCacheGB(model, effectiveContextMax);
      const totalMem = Math.round((weightsMemoryGB + runtimeOverheadGB + baseKv) * 100) / 100;
      return {
        modelId: model.id,
        eligible: false,
        fits: false,
        allocatedContextTokens: 0,
        inputBudgetTokens: 0,
        outputReserveTokens,
        advertisedContextMax,
        weightsMemoryGB,
        runtimeOverheadGB,
        kvCacheMemoryGB: baseKv,
        totalRequiredMemoryGB: totalMem,
        incrementalRequiredMemoryGB: isAlreadyLoaded ? baseKv : totalMem,
        downshiftedFromMax: false,
        reason: `Minimum required context (${minimumRequiredContext}) exceeds model context limit (${effectiveContextMax})`,
        shortReason: 'Context limit exceeded',
      };
    }

    // 6. Build candidate tiers
    const tiers: number[] = [];
    for (const t of STANDARD_CONTEXT_TIERS) {
      if (t <= effectiveContextMax) {
        tiers.push(t);
      }
    }
    if (!tiers.includes(effectiveContextMax) && effectiveContextMax >= minimumRequiredContext) {
      tiers.push(effectiveContextMax);
    }
    if (tiers.length === 0) {
      tiers.push(effectiveContextMax);
    }
    const candidateTiers = Array.from(new Set(tiers)).sort((a, b) => a - b);
    const sufficientTiers = candidateTiers.filter((t) => t >= minimumRequiredContext);

    if (sufficientTiers.length === 0) {
      const kv = isHosted ? 0 : this.estimateKvCacheGB(model, effectiveContextMax);
      const totalMem = Math.round((weightsMemoryGB + runtimeOverheadGB + kv) * 100) / 100;
      return {
        modelId: model.id,
        eligible: false,
        fits: false,
        allocatedContextTokens: 0,
        inputBudgetTokens: 0,
        outputReserveTokens,
        advertisedContextMax,
        weightsMemoryGB,
        runtimeOverheadGB,
        kvCacheMemoryGB: kv,
        totalRequiredMemoryGB: totalMem,
        incrementalRequiredMemoryGB: isAlreadyLoaded ? kv : totalMem,
        downshiftedFromMax: false,
        reason: `No supported context tier satisfies required minimum context ${minimumRequiredContext}`,
        shortReason: 'No matching tier',
      };
    }

    // 7. Iterate through sufficient tiers in ascending order to find the smallest that fits in availableMemoryGB
    for (const tier of sufficientTiers) {
      const kvCacheMemoryGB = isHosted ? 0 : this.estimateKvCacheGB(model, tier);
      const totalRequiredMemoryGB =
        Math.round((weightsMemoryGB + runtimeOverheadGB + kvCacheMemoryGB) * 100) / 100;

      let incrementalRequiredMemoryGB: number;
      if (isHosted) {
        incrementalRequiredMemoryGB = 0;
      } else if (isAlreadyLoaded) {
        const residentWeights = params.loadedWeightsMemoryGB ?? weightsMemoryGB;
        const incrementalWeights = Math.max(0, Math.round((weightsMemoryGB - residentWeights) * 100) / 100);
        let incrementalKv = kvCacheMemoryGB;
        if (loadedContextTokens !== undefined && loadedContextTokens > 0) {
          const loadedKv = this.estimateKvCacheGB(model, loadedContextTokens);
          incrementalKv = Math.max(0, Math.round((kvCacheMemoryGB - loadedKv) * 100) / 100);
        }
        incrementalRequiredMemoryGB = Math.round((incrementalWeights + incrementalKv) * 100) / 100;
      } else {
        incrementalRequiredMemoryGB = totalRequiredMemoryGB;
      }

      const memoryNeededToFit = isAlreadyLoaded
        ? incrementalRequiredMemoryGB
        : totalRequiredMemoryGB;
      const fitsInMemory =
        availableMem === undefined || memoryNeededToFit <= availableMem;

      if (fitsInMemory) {
        const allocatedContextTokens = tier;
        const inputBudgetTokens = Math.max(0, allocatedContextTokens - outputReserveTokens);
        const downshiftedFromMax = allocatedContextTokens < advertisedContextMax;
        const reason = downshiftedFromMax
          ? `Allocated smallest sufficient context ${allocatedContextTokens} tokens (downshifted from max ${advertisedContextMax} to conserve memory: ${totalRequiredMemoryGB}GB required${availableMem !== undefined ? ` vs ${availableMem}GB available` : ''})`
          : `Allocated context ${allocatedContextTokens} tokens satisfying required minimum ${minimumRequiredContext} (${totalRequiredMemoryGB}GB required)`;

        return {
          modelId: model.id,
          eligible: true,
          fits: true,
          allocatedContextTokens,
          inputBudgetTokens,
          outputReserveTokens,
          advertisedContextMax,
          weightsMemoryGB,
          runtimeOverheadGB,
          kvCacheMemoryGB,
          totalRequiredMemoryGB,
          incrementalRequiredMemoryGB,
          downshiftedFromMax,
          reason,
          shortReason: isAlreadyLoaded ? 'Loaded' : 'Fits',
        };
      }
    }

    // 8. If even the smallest sufficient tier cannot fit in availableMemoryGB
    const smallestTier = sufficientTiers[0];
    const kvCacheMemoryGB = isHosted ? 0 : this.estimateKvCacheGB(model, smallestTier);
    const totalRequiredMemoryGB =
      Math.round((weightsMemoryGB + runtimeOverheadGB + kvCacheMemoryGB) * 100) / 100;
    let incrementalRequiredMemoryGB: number;
    if (isHosted) {
      incrementalRequiredMemoryGB = 0;
    } else if (isAlreadyLoaded) {
      const residentWeights = params.loadedWeightsMemoryGB ?? weightsMemoryGB;
      const incrementalWeights = Math.max(0, Math.round((weightsMemoryGB - residentWeights) * 100) / 100);
      let incrementalKv = kvCacheMemoryGB;
      if (loadedContextTokens !== undefined && loadedContextTokens > 0) {
        const loadedKv = this.estimateKvCacheGB(model, loadedContextTokens);
        incrementalKv = Math.max(0, Math.round((kvCacheMemoryGB - loadedKv) * 100) / 100);
      }
      incrementalRequiredMemoryGB = Math.round((incrementalWeights + incrementalKv) * 100) / 100;
    } else {
      incrementalRequiredMemoryGB = totalRequiredMemoryGB;
    }
    const memoryNeeded = isAlreadyLoaded
      ? incrementalRequiredMemoryGB
      : totalRequiredMemoryGB;

    const avail = availableMem !== undefined ? roundGB(availableMem) : 0;
    const needed = roundGB(memoryNeeded);
    const weightsGB = roundGB(weightsMemoryGB);
    const kvOverheadGB = roundGB(kvCacheMemoryGB + runtimeOverheadGB);

    const shortReason = `Insufficient memory (needs ${needed}GB, ${avail}GB avail)`;
    const reason = `Insufficient memory: required ${memoryNeeded}GB exceeds available ${availableMem}GB for minimum sufficient context ${smallestTier} (available memory ${avail}GB < required ${needed}GB: weights ${weightsGB}GB + KV/overhead ${kvOverheadGB}GB)`;

    return {
      modelId: model.id,
      eligible: false,
      fits: false,
      allocatedContextTokens: 0,
      inputBudgetTokens: 0,
      outputReserveTokens,
      advertisedContextMax,
      weightsMemoryGB,
      runtimeOverheadGB,
      kvCacheMemoryGB,
      totalRequiredMemoryGB,
      incrementalRequiredMemoryGB,
      downshiftedFromMax: false,
      reason,
      shortReason,
    };
  }
}
