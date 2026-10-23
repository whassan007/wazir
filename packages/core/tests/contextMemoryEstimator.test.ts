import { describe, it, expect } from 'vitest';
import {
  ContextMemoryEstimator,
  estimateWeightsGB,
  estimateRuntimeOverheadGB,
  estimateKvCacheGB,
  planContextAllocation,
  parseParameterCountBillion,
  getBytesPerParam,
  STANDARD_CONTEXT_TIERS,
  DEFAULT_UNKNOWN_CONTEXT_MAX,
  DEFAULT_CONSERVATIVE_WEIGHTS_GB,
} from '../src/services/contextMemoryEstimator.js';
import type { ModelRecord } from '../src/types/model.js';

function mockModel(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    id: 'test-model',
    name: 'Test Model',
    provider: 'local',
    family: 'llama',
    contextMax: 131_072,
    capabilities: ['generalChat'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    local: true,
    runtimeCompatibility: ['ollama'],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as ModelRecord;
}

describe('contextMemoryEstimator', () => {
  describe('parameter and quantization parsing', () => {
    it('parses parameter count from parameters string, modelId, and model name', () => {
      expect(parseParameterCountBillion('7B')).toBe(7);
      expect(parseParameterCountBillion('1.5b')).toBe(1.5);
      expect(parseParameterCountBillion('70B')).toBe(70);
      expect(parseParameterCountBillion('800M')).toBe(0.8);
      expect(parseParameterCountBillion(undefined, 'qwen2.5:1.5b')).toBe(1.5);
      expect(parseParameterCountBillion(undefined, 'llama3:70b-instruct-q4_0')).toBe(70);
      expect(parseParameterCountBillion(undefined, 'mistral-12b-instruct')).toBe(12);
      expect(parseParameterCountBillion(undefined, undefined, 'Gemma 2 27B')).toBe(27);
      expect(parseParameterCountBillion(undefined, 'unknown-model')).toBeUndefined();
    });

    it('determines bytes per parameter across quantization levels', () => {
      expect(getBytesPerParam('FP32')).toBe(4.2);
      expect(getBytesPerParam('FP16')).toBe(2.1);
      expect(getBytesPerParam('Q8_0')).toBe(1.15);
      expect(getBytesPerParam('Q6_K')).toBe(0.85);
      expect(getBytesPerParam('Q5_K_M')).toBe(0.72);
      expect(getBytesPerParam('Q4_K_M')).toBe(0.60);
      expect(getBytesPerParam('Q3_K_M')).toBe(0.45);
      expect(getBytesPerParam('Q2_K')).toBe(0.35);
      expect(getBytesPerParam(undefined)).toBe(0.60); // default 4-bit
    });
  });

  describe('estimateWeightsGB', () => {
    it('estimates weight memory across standard model sizes at 4-bit quantization', () => {
      const m1_5b = mockModel({ parameters: '1.5B', quantization: 'q4_k_m' });
      const m7b = mockModel({ parameters: '7B', quantization: 'q4_k_m' });
      const m12b = mockModel({ parameters: '12B', quantization: 'q4_k_m' });
      const m27b = mockModel({ parameters: '27B', quantization: 'q4_k_m' });
      const m70b = mockModel({ parameters: '70B', quantization: 'q4_k_m' });

      expect(estimateWeightsGB(m1_5b)).toBe(0.9);
      expect(estimateWeightsGB(m7b)).toBe(4.2);
      expect(estimateWeightsGB(m12b)).toBe(7.2);
      expect(estimateWeightsGB(m27b)).toBe(16.2);
      expect(estimateWeightsGB(m70b)).toBe(42.0);
    });

    it('estimates weight memory across different quantizations for the same model size', () => {
      const q4 = mockModel({ parameters: '7B', quantization: 'q4_k_m' });
      const q5 = mockModel({ parameters: '7B', quantization: 'q5_k_m' });
      const q8 = mockModel({ parameters: '7B', quantization: 'q8_0' });
      const fp16 = mockModel({ parameters: '7B', quantization: 'fp16' });

      expect(estimateWeightsGB(q4)).toBe(4.2);
      expect(estimateWeightsGB(q5)).toBe(5.04);
      expect(estimateWeightsGB(q8)).toBe(8.05);
      expect(estimateWeightsGB(fp16)).toBe(14.7);
    });

    it('respects explicit memory requirements when provided', () => {
      const model = mockModel({
        parameters: '7B',
        memory: { minGpuGB: 5.5 },
      });
      expect(estimateWeightsGB(model)).toBe(5.5);
    });

    it('returns 0 for hosted remote models', () => {
      const hostedModel = mockModel({
        local: false,
        provider: 'anthropic',
        runtimeCompatibility: ['anthropic'],
      });
      expect(estimateWeightsGB(hostedModel)).toBe(0);
    });

    it('falls back to conservative default when model parameters and memory are unknown', () => {
      const unknownModel = mockModel({
        id: 'generic-local',
        parameters: undefined,
        memory: undefined,
      });
      expect(estimateWeightsGB(unknownModel)).toBe(DEFAULT_CONSERVATIVE_WEIGHTS_GB);
    });
  });

  describe('estimateRuntimeOverheadGB', () => {
    it('estimates local runtime overheads in the ~0.5 to 1.5GB range', () => {
      const llamaCpp = mockModel({ runtimeCompatibility: ['llama-cpp'] });
      const ollama = mockModel({ runtimeCompatibility: ['ollama'] });
      const lmstudio = mockModel({ runtimeCompatibility: ['lmstudio'] });
      const openaiComp = mockModel({ runtimeCompatibility: ['openai-compatible'] });

      expect(estimateRuntimeOverheadGB(llamaCpp, 'llama-cpp')).toBe(0.5);
      expect(estimateRuntimeOverheadGB(ollama, 'ollama')).toBe(0.8);
      expect(estimateRuntimeOverheadGB(lmstudio, 'lmstudio')).toBe(1.2);
      expect(estimateRuntimeOverheadGB(openaiComp, 'openai-compatible')).toBe(0.8);

      // Default local overhead when runtimeType is omitted
      expect(estimateRuntimeOverheadGB(llamaCpp)).toBe(0.5);
      expect(estimateRuntimeOverheadGB(mockModel({ runtimeCompatibility: 'any' }))).toBe(0.8);
    });

    it('returns 0GB runtime overhead for hosted runtimes', () => {
      const hostedModel = mockModel({ local: false, runtimeCompatibility: ['anthropic'] });
      expect(estimateRuntimeOverheadGB(hostedModel, 'anthropic')).toBe(0);
      expect(estimateRuntimeOverheadGB(hostedModel, 'openai')).toBe(0);
      expect(estimateRuntimeOverheadGB(hostedModel, 'google')).toBe(0);
      expect(estimateRuntimeOverheadGB(hostedModel, 'nvidia')).toBe(0);
      expect(estimateRuntimeOverheadGB(hostedModel)).toBe(0);
    });
  });

  describe('estimateKvCacheGB', () => {
    it('estimates KV cache memory scaling across model sizes and context tokens', () => {
      const m1_5b = mockModel({ parameters: '1.5B' });
      const m7b = mockModel({ parameters: '7B' });
      const m12b = mockModel({ parameters: '12B' });
      const m27b = mockModel({ parameters: '27B' });
      const m70b = mockModel({ parameters: '70B' });

      // 4096 tokens
      expect(estimateKvCacheGB(m1_5b, 4096)).toBe(0.11);
      expect(estimateKvCacheGB(m7b, 4096)).toBe(0.5);
      expect(estimateKvCacheGB(m12b, 4096)).toBe(0.63);
      expect(estimateKvCacheGB(m27b, 4096)).toBe(1.44);
      expect(estimateKvCacheGB(m70b, 4096)).toBe(1.25);

      // 32768 tokens
      expect(estimateKvCacheGB(m7b, 32768)).toBe(4.0);
      expect(estimateKvCacheGB(m70b, 32768)).toBe(10.0);

      // 131072 (128k) tokens
      expect(estimateKvCacheGB(m1_5b, 131072)).toBe(3.5);
      expect(estimateKvCacheGB(m7b, 131072)).toBe(16.0);
      expect(estimateKvCacheGB(m12b, 131072)).toBe(20.0);
      expect(estimateKvCacheGB(m27b, 131072)).toBe(46.0);
      expect(estimateKvCacheGB(m70b, 131072)).toBe(40.0);
    });

    it('returns 0 when context tokens is 0 or negative', () => {
      const m7b = mockModel({ parameters: '7B' });
      expect(estimateKvCacheGB(m7b, 0)).toBe(0);
      expect(estimateKvCacheGB(m7b, -100)).toBe(0);
    });
  });

  describe('planContextAllocation - Smallest sufficient context tier selection', () => {
    const estimator = new ContextMemoryEstimator();

    it('selects the smallest sufficient tier (4096) for a short prompt rather than allocating 128k KV cache', () => {
      const m7b = mockModel({
        parameters: '7B',
        quantization: 'q4_k_m',
        contextMax: 131_072,
        runtimeCompatibility: ['ollama'],
      });

      // Short prompt: 500 input tokens, low reasoning effort (1024 output reserve) -> min required = 1524
      const plan = estimator.planContextAllocation({
        model: m7b,
        estimatedInputTokens: 500,
        reasoningEffort: 'low',
        availableMemoryGB: 32,
      });

      expect(plan.eligible).toBe(true);
      expect(plan.allocatedContextTokens).toBe(4096);
      expect(plan.advertisedContextMax).toBe(131_072);
      expect(plan.downshiftedFromMax).toBe(true);
      expect(plan.outputReserveTokens).toBe(1024);
      expect(plan.inputBudgetTokens).toBe(3072); // 4096 - 1024
      expect(plan.weightsMemoryGB).toBe(4.2);
      expect(plan.runtimeOverheadGB).toBe(0.8);
      expect(plan.kvCacheMemoryGB).toBe(0.5); // 0.5 GB instead of 16 GB for 128k!
      expect(plan.totalRequiredMemoryGB).toBe(5.5);
      expect(plan.reason).toContain('Allocated smallest sufficient context 4096');
    });

    it('selects the 8192 tier when prompt + reserve exceeds 4096 but fits in 8192', () => {
      const m7b = mockModel({
        parameters: '7B',
        quantization: 'q4_k_m',
        contextMax: 131_072,
        runtimeCompatibility: ['ollama'],
      });

      // Medium prompt: 3500 input tokens, medium effort (2048 output reserve) -> min required = 5548
      const plan = planContextAllocation({
        model: m7b,
        estimatedInputTokens: 3500,
        reasoningEffort: 'medium',
      });

      expect(plan.eligible).toBe(true);
      expect(plan.allocatedContextTokens).toBe(8192);
      expect(plan.downshiftedFromMax).toBe(true);
      expect(plan.outputReserveTokens).toBe(2048);
      expect(plan.inputBudgetTokens).toBe(6144);
      expect(plan.kvCacheMemoryGB).toBe(1.0);
      expect(plan.totalRequiredMemoryGB).toBe(6.0);
    });

    it('selects higher tiers when high reasoning effort or large prompt requires it', () => {
      const m7b = mockModel({
        parameters: '7B',
        quantization: 'q4_k_m',
        contextMax: 131_072,
      });

      // High effort (4096 output reserve) + 15000 input tokens -> min required = 19096
      const plan = estimator.planContextAllocation({
        model: m7b,
        estimatedInputTokens: 15_000,
        reasoningEffort: 'high',
      });

      expect(plan.eligible).toBe(true);
      expect(plan.allocatedContextTokens).toBe(32_768);
      expect(plan.outputReserveTokens).toBe(4096);
      expect(plan.downshiftedFromMax).toBe(true);
      expect(plan.kvCacheMemoryGB).toBe(4.0);
    });
  });

  describe('planContextAllocation - Downshifting and memory rejection', () => {
    it('successfully downshifts when 128k KV cache exceeds available memory but 4096 fits', () => {
      const m7b = mockModel({
        parameters: '7B',
        quantization: 'q4_k_m',
        contextMax: 131_072,
        runtimeCompatibility: ['ollama'],
      });

      // On 10GB RAM machine:
      // 128k KV cache is 16GB (total = 4.2 + 0.8 + 16 = 21GB, which would OOM).
      // But 4096 context is 0.5GB (total = 5.5GB <= 10GB).
      const plan = planContextAllocation({
        model: m7b,
        estimatedInputTokens: 1000,
        reasoningEffort: 'medium', // reserve 2048 -> min required 3048 -> tier 4096
        availableMemoryGB: 10,
      });

      expect(plan.eligible).toBe(true);
      expect(plan.allocatedContextTokens).toBe(4096);
      expect(plan.downshiftedFromMax).toBe(true);
      expect(plan.totalRequiredMemoryGB).toBe(5.5);
      expect(plan.totalRequiredMemoryGB).toBeLessThanOrEqual(10);
    });

    it('rejects when even the minimum required context exceeds available memory', () => {
      const m7b = mockModel({
        parameters: '7B',
        quantization: 'q4_k_m',
        contextMax: 131_072,
        runtimeCompatibility: ['ollama'],
      });

      // Available memory is only 4GB, but 7B at 4096 needs 5.5GB (4.2 + 0.8 + 0.5)
      const plan = planContextAllocation({
        model: m7b,
        estimatedInputTokens: 500,
        reasoningEffort: 'low',
        availableMemoryGB: 4.0,
      });

      expect(plan.eligible).toBe(false);
      expect(plan.allocatedContextTokens).toBe(0);
      expect(plan.totalRequiredMemoryGB).toBe(5.5);
      expect(plan.reason).toContain('Insufficient memory');
      expect(plan.reason).toContain('required 5.5GB exceeds available 4GB');
    });

    it('handles already-loaded models with incremental KV cache requirements', () => {
      const m7b = mockModel({
        parameters: '7B',
        quantization: 'q4_k_m',
        contextMax: 131_072,
        runtimeCompatibility: ['ollama'],
      });

      // Weights and overhead already loaded. Expanding from 4096 to 8192 context:
      // KV cache at 8192 is 1.0GB, at 4096 was 0.5GB -> delta = 0.5GB incremental
      const plan = planContextAllocation({
        model: m7b,
        estimatedInputTokens: 4000,
        reasoningEffort: 'medium', // min required 6048 -> tier 8192
        alreadyLoaded: true,
        loadedContextTokens: 4096,
        availableMemoryGB: 1.0, // Remaining memory after weights are loaded
      });

      expect(plan.eligible).toBe(true);
      expect(plan.allocatedContextTokens).toBe(8192);
      expect(plan.incrementalRequiredMemoryGB).toBe(0.5);
      expect(plan.totalRequiredMemoryGB).toBe(6.0);
    });
  });

  describe('planContextAllocation - Fallbacks and constraints', () => {
    it('uses conservative default 8192 when contextMax is unknown or 0', () => {
      const unknownContextModel = mockModel({
        contextMax: 0,
        parameters: '7B',
      });

      const plan = planContextAllocation({
        model: unknownContextModel,
        estimatedInputTokens: 500,
      });

      expect(plan.eligible).toBe(true);
      expect(plan.advertisedContextMax).toBe(DEFAULT_UNKNOWN_CONTEXT_MAX); // 8192
      expect(plan.allocatedContextTokens).toBe(4096);
    });

    it('uses conservative fallbacks when parameter metadata is unknown', () => {
      const uncalibratedModel = mockModel({
        parameters: undefined,
        id: 'mystery-model',
        contextMax: 32_768,
      });

      const plan = planContextAllocation({
        model: uncalibratedModel,
        estimatedInputTokens: 1000,
      });

      expect(plan.eligible).toBe(true);
      expect(plan.weightsMemoryGB).toBe(DEFAULT_CONSERVATIVE_WEIGHTS_GB); // 4.5
      expect(plan.allocatedContextTokens).toBe(4096);
    });

    it('respects model.maxOutputTokens when clamping reasoning effort reservations', () => {
      const clampedOutputModel = mockModel({
        parameters: '7B',
        maxOutputTokens: 512, // Provider-capped output
      });

      const plan = planContextAllocation({
        model: clampedOutputModel,
        estimatedInputTokens: 1000,
        reasoningEffort: 'high', // would normally be 4096
      });

      expect(plan.outputReserveTokens).toBe(512); // clamped to 512
      expect(plan.allocatedContextTokens).toBe(4096);
      expect(plan.inputBudgetTokens).toBe(3584); // 4096 - 512
    });

    it('rejects allocation when requiredMinimumContext exceeds model context ceiling', () => {
      const smallWindowModel = mockModel({
        contextMax: 4096,
      });

      const plan = planContextAllocation({
        model: smallWindowModel,
        estimatedInputTokens: 3500,
        reasoningEffort: 'medium', // 2048 output reserve -> min required 5548 > 4096
      });

      expect(plan.eligible).toBe(false);
      expect(plan.allocatedContextTokens).toBe(0);
      expect(plan.reason).toContain('exceeds model context limit');
    });

    it('handles hosted models with 0GB device memory footprint', () => {
      const hostedModel = mockModel({
        id: 'claude-3-5-sonnet',
        local: false,
        provider: 'anthropic',
        contextMax: 200_000,
        runtimeCompatibility: ['anthropic'],
      });

      const plan = planContextAllocation({
        model: hostedModel,
        estimatedInputTokens: 2000,
        availableMemoryGB: 1.0, // Constrained local memory doesn't block hosted model
      });

      expect(plan.eligible).toBe(true);
      expect(plan.weightsMemoryGB).toBe(0);
      expect(plan.runtimeOverheadGB).toBe(0);
      expect(plan.kvCacheMemoryGB).toBe(0);
      expect(plan.totalRequiredMemoryGB).toBe(0);
      expect(plan.incrementalRequiredMemoryGB).toBe(0);
    });
  });

  describe('Loaded-model incremental memory and ineligibility reporting', () => {
    const estimator = new ContextMemoryEstimator();

    const model14gb = mockModel({
      id: 'qwen-14b',
      parameters: '14B',
      memory: { minGpuGB: 14 },
    });

    it('marks unloaded 14GB model on 1.5GB available memory as eligible: false and fits: false with Insufficient memory', () => {
      const plan = estimator.planContextAllocation({
        model: model14gb,
        availableMemoryGB: 1.5,
        isAlreadyLoaded: false,
      });

      expect(plan.eligible).toBe(false);
      expect(plan.fits).toBe(false);
      expect(plan.shortReason).toContain('Insufficient memory');
      expect(plan.reason).toContain('Insufficient memory');
    });

    it('marks already-loaded 14GB model on 1.5GB remaining memory as eligible: true and fits: true (reusing resident weights)', () => {
      const plan = estimator.planContextAllocation({
        model: model14gb,
        availableMemoryGB: 1.5,
        isAlreadyLoaded: true,
        loadedWeightsMemoryGB: 14,
        estimatedInputTokens: 500,
        reasoningEffort: 'low', // 4096 context tier
      });

      expect(plan.eligible).toBe(true);
      expect(plan.fits).toBe(true);
      expect(plan.incrementalRequiredMemoryGB).toBeLessThanOrEqual(1.5);
    });

    it('rejects qwen/qwen3.8-27b requiring ~22GB on 0.1GB available memory with clear shortReason and detailed reason', () => {
      const qwen27b = mockModel({
        id: 'qwen/qwen3.8-27b',
        parameters: '27B',
        memory: { minGpuGB: 19.76 }, // 19.76GB weights + 0.8GB overhead + 1.44GB KV = 22.0GB required
      });

      const plan = estimator.planContextAllocation({
        model: qwen27b,
        availableMemoryGB: 0.1,
      });

      expect(plan.eligible).toBe(false);
      expect(plan.fits).toBe(false);
      expect(plan.totalRequiredMemoryGB).toBe(22);
      expect(plan.shortReason).toContain('Insufficient memory');
      expect(plan.shortReason).toContain('0.1');
      expect(plan.reason).toContain('available memory 0.1GB < required 22GB');
    });

    it('supports ContextEstimationInput with currentLoadedContextTokens and usableMemoryGB', () => {
      const plan = estimator.planContextAllocation({
        model: model14gb,
        usableMemoryGB: 1.5,
        isAlreadyLoaded: true,
        currentLoadedContextTokens: 4096,
        estimatedInputTokens: 500,
        reasoningEffort: 'low',
      });

      expect(plan.eligible).toBe(true);
      expect(plan.fits).toBe(true);
      expect(plan.incrementalRequiredMemoryGB).toBe(0);
    });
  });
});
