import { describe, it, expect } from 'vitest';
import {
  IntelligentModelRanker,
  type IntelligentRoutingMode,
} from '../src/services/intelligentModelRanker.js';
import type { Computer } from '../src/types/computer.js';
import type { ModelRecord, ModelInstance } from '../src/types/model.js';

describe('IntelligentModelRanker and 7 Routing Modes', () => {
  const ranker = new IntelligentModelRanker();

  const createModel = (overrides: Partial<ModelRecord> = {}): ModelRecord => ({
    id: 'test-model',
    name: 'Test Model',
    provider: 'local',
    family: 'qwen',
    contextMax: 32768,
    capabilities: ['generalChat'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: false,
    runtimeCompatibility: 'any',
    local: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  const createComputer = (overrides: Partial<Computer> = {}): Computer => ({
    id: 'comp-1',
    name: 'Test Computer',
    type: 'workstation',
    status: 'online',
    local: true,
    health: 'healthy',
    os: { platform: 'darwin', architecture: 'arm64', version: '14.5' },
    hardware: {
      cpu: 'Apple M3',
      cpuCores: 12,
      memoryGB: 36,
      gpu: {
        vendor: 'apple',
        model: 'Apple M3',
        memoryGB: 36,
        unifiedMemory: true,
      },
    },
    load: {
      cpuPercent: 20,
      memoryUsedGB: 16,
      memoryAvailableGB: 20,
      gpuMemoryAvailableGB: 20,
    },
    runtimes: ['ollama', 'mlx'],
    models: [],
    capabilities: ['gpu', 'apple-silicon'],
    runtimeHealth: {},
    modelHealth: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  it('rejects 22GB model on 0.1GB RAM computer and admits if already loaded with sufficient KV cache', () => {
    const lowMemComputer = createComputer({
      load: {
        cpuPercent: 50,
        memoryUsedGB: 35.9,
        memoryAvailableGB: 0.1,
        gpuMemoryAvailableGB: 0.1,
      },
      runtimes: ['ollama'],
    });

    const heavyModel = createModel({
      id: 'qwen/qwen3.8-27b',
      name: 'Qwen 27B',
      parameters: '27B',
      quantization: 'Q4_K_M',
      memory: { minSystemGB: 22, minGpuGB: 22 },
    });

    // 1. Unloaded check -> should be rejected due to 0.1GB RAM
    const resultUnloaded = ranker.selectModel([heavyModel], lowMemComputer, [], { mode: 'AUTO' });
    expect(resultUnloaded.success).toBe(false);
    expect(resultUnloaded.selected).toBeUndefined();

    // 2. Already loaded check -> should be admitted since weights are resident and incremental KV fits in 0.1GB
    const loadedInstance: ModelInstance = {
      id: 'inst-1',
      modelId: 'qwen/qwen3.8-27b',
      computerId: lowMemComputer.id,
      runtimeId: 'ollama',
      runtimeModelId: 'qwen3.8-27b',
      loaded: true,
      state: 'READY',
      health: 'healthy',
    };

    const resultLoaded = ranker.selectModel([heavyModel], lowMemComputer, [loadedInstance], { mode: 'AUTO' });
    expect(resultLoaded.success).toBe(true);
    expect(resultLoaded.selected?.model.id).toBe('qwen/qwen3.8-27b');
    expect(resultLoaded.selected?.alreadyLoaded).toBe(true);
  });

  it('never silently overrides STRICT_MODEL when target is ineligible', () => {
    const tightComputer = createComputer({
      hardware: {
        cpu: 'Apple M3',
        cpuCores: 12,
        memoryGB: 36,
        gpu: { vendor: 'apple', model: 'Apple M3', memoryGB: 36, unifiedMemory: true },
      },
      load: {
        memoryAvailableGB: 30,
      },
    });

    const massiveModel = createModel({
      id: 'massive-70b',
      parameters: '70B',
      memory: { minSystemGB: 45 },
    });

    const backupModel = createModel({
      id: 'small-7b',
      parameters: '7B',
      memory: { minSystemGB: 5 },
    });

    const result = ranker.selectModel([massiveModel, backupModel], tightComputer, [], {
      mode: 'STRICT_MODEL',
      targetModelId: 'massive-70b',
    });

    expect(result.success).toBe(false);
    expect(result.selected).toBeUndefined();
    expect(result.reason).toContain('STRICT_MODEL never silently overrides');
    // backupModel is eligible, so alternatives should contain it
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.alternatives[0].model.id).toBe('small-7b');
  });

  it('successfully executes all 7 routing modes', () => {
    const computer = createComputer();
    const models = [
      createModel({ id: 'small-fast', parameters: '3B', memory: { minSystemGB: 3 } }),
      createModel({ id: 'mid-balanced', parameters: '14B', memory: { minSystemGB: 10 } }),
      createModel({ id: 'large-powerful', parameters: '32B', reasoning: true, memory: { minSystemGB: 22 } }),
      createModel({ id: 'cloud-hosted', local: false, provider: 'openai' }),
    ];

    const modes: IntelligentRoutingMode[] = [
      'AUTO',
      'FAST',
      'BALANCED',
      'POWERFUL',
      'LOCAL_FIRST',
      'LOADED_ONLY',
      'STRICT_MODEL',
    ];

    for (const mode of modes) {
      const options =
        mode === 'STRICT_MODEL'
          ? { mode, targetModelId: 'small-fast' }
          : mode === 'LOADED_ONLY'
            ? { mode, allowHostedProviders: true } // None loaded, so should fail or handle gracefully
            : { mode, allowHostedProviders: true };

      const result = ranker.selectModel(models, computer, [], options);
      if (mode === 'LOADED_ONLY') {
        expect(result.success).toBe(false); // No models loaded yet
      } else {
        expect(result.success).toBe(true);
        expect(result.selected).toBeDefined();
      }
    }
  });

  it('formats selection banner correctly', () => {
    const model = createModel({ id: 'qwen/qwen-7b' });
    const computer = createComputer();
    const ranked = ranker.rankModels([model], computer, [], { mode: 'AUTO' });
    const banner = ranker.formatSelectionBanner(ranked[0]);

    expect(banner).toContain('Selected: qwen/qwen-7b');
    expect(banner).toContain('Device: comp-1 (apple_unified)');
    expect(banner).toContain('Context:');
    expect(banner).toContain('Reason:');
  });

  it('performs Auto Local Routing correctly (excludes hosted models, prefers loaded, skips ineligible)', () => {
    const computer = createComputer({
      load: { memoryAvailableGB: 10 },
    });

    const localLoaded = createModel({ id: 'local-loaded', parameters: '7B', memory: { minSystemGB: 6 } });
    const localUnloaded = createModel({ id: 'local-unloaded', parameters: '7B', memory: { minSystemGB: 6 } });
    const hostedModel = createModel({ id: 'hosted-gpt', local: false, provider: 'openai' });
    const heavyIneligible = createModel({ id: 'heavy-ineligible', parameters: '70B', memory: { minSystemGB: 50 } });

    const instances: ModelInstance[] = [
      {
        id: 'inst-loaded',
        modelId: 'local-loaded',
        computerId: computer.id,
        runtimeId: 'ollama',
        runtimeModelId: 'local-loaded',
        loaded: true,
        state: 'READY',
        health: 'healthy',
      },
    ];

    const result = ranker.selectModel([hostedModel, heavyIneligible, localUnloaded, localLoaded], computer, instances, {
      mode: 'LOCAL_FIRST',
    });

    expect(result.success).toBe(true);
    expect(result.selected?.model.id).toBe('local-loaded');
    // Ensure hosted model was excluded from alternatives/selection
    expect(result.alternatives.some((c) => c.model.id === 'hosted-gpt')).toBe(false);
    expect(result.alternatives.some((c) => c.model.id === 'heavy-ineligible')).toBe(false);
  });

  it('handles specific local model selection under LOCAL_FIRST with targetModelId', () => {
    const computer = createComputer();
    const modelA = createModel({ id: 'local-model-a', memory: { minSystemGB: 4 } });
    const modelB = createModel({ id: 'local-model-b', memory: { minSystemGB: 4 } });

    // 1. When eligible, selects model-b
    const resEligible = ranker.selectModel([modelA, modelB], computer, [], {
      mode: 'LOCAL_FIRST',
      targetModelId: 'local-model-b',
    });
    expect(resEligible.success).toBe(true);
    expect(resEligible.selected?.model.id).toBe('local-model-b');

    // 2. When target is ineligible or missing, returns selected: undefined with local alternatives
    const tightComputer = createComputer({
      load: { memoryAvailableGB: 2 },
    });
    const lightA = createModel({ id: 'local-model-a', memory: { minSystemGB: 1.5 } });
    const heavyB = createModel({ id: 'local-model-b', memory: { minSystemGB: 25 } });

    const resIneligible = ranker.selectModel([lightA, heavyB], tightComputer, [], {
      mode: 'LOCAL_FIRST',
      targetModelId: 'local-model-b',
    });
    expect(resIneligible.success).toBe(false);
    expect(resIneligible.selected).toBeUndefined();
    expect(resIneligible.alternatives.length).toBeGreaterThan(0);
    expect(resIneligible.alternatives[0].model.id).toBe('local-model-a');
  });

  it('gives memory credit to already-loaded 14GB local model with low remaining free RAM under AUTO and LOCAL_FIRST', () => {
    const lowMemComp = createComputer({
      load: { memoryAvailableGB: 1.5 },
    });
    const model14GB = createModel({ id: 'model-14gb', parameters: '14B', memory: { minSystemGB: 14 } });

    const instances: ModelInstance[] = [
      {
        id: 'inst-14',
        modelId: 'model-14gb',
        computerId: lowMemComp.id,
        runtimeId: 'ollama',
        runtimeModelId: 'model-14gb',
        loaded: true,
        state: 'READY',
        health: 'healthy',
      },
    ];

    for (const mode of ['AUTO', 'LOCAL_FIRST'] as const) {
      const res = ranker.selectModel([model14GB], lowMemComp, instances, { mode });
      expect(res.success).toBe(true);
      expect(res.selected?.model.id).toBe('model-14gb');
      expect(res.selected?.alreadyLoaded).toBe(true);
    }
  });
});
