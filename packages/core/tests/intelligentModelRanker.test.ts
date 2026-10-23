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
});
