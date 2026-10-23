import { describe, it, expect } from 'vitest';
import { ModelRegistry } from '../src/services/modelRegistry.js';
import { RuntimeRegistry } from '../src/services/runtimeRegistry.js';
import { ComputerRegistry } from '../src/services/computerRegistry.js';
import { ModelDiscoveryStatusService } from '../src/services/modelDiscoveryStatus.js';

describe('ModelDiscoveryStatusService', () => {
  it('hosted models report registered, available, loaded=0 correctly', () => {
    const models = new ModelRegistry();
    const runtimes = new RuntimeRegistry();
    const computers = new ComputerRegistry();

    for (let i = 1; i <= 85; i++) {
      models.register({
        id: `nvidia-model-${i}`,
        name: `NVIDIA Model ${i}`,
        provider: 'nvidia',
        local: false,
        contextWindow: 128000,
      });
    }

    const service = new ModelDiscoveryStatusService({ models, runtimes, computers });
    const fleet = service.getFleetStatus();

    expect(fleet.registeredCount).toBe(85);
    expect(fleet.availableCount).toBe(85);
    expect(fleet.loadedCount).toBe(0);
    expect(fleet.hostedAvailableCount).toBe(85);
  });

  it('local models only count as loaded when resident in a healthy local runtime on an online computer', () => {
    const models = new ModelRegistry();
    const runtimes = new RuntimeRegistry();
    const computers = new ComputerRegistry();

    models.register({
      id: 'local-llama',
      name: 'Llama 3 Local',
      provider: 'ollama',
      local: true,
      contextWindow: 8192,
    });

    computers.register({
      id: 'comp-1',
      name: 'Local Workstation',
      type: 'desktop',
      local: true,
      os: 'mac',
      hardware: { memoryGB: 32, cpuCores: 8 },
    });

    runtimes.register({
      id: 'ollama-rt',
      runtimeKind: 'local',
      version: '1.0',
    });

    runtimes.setHealth('ollama-rt', 'healthy');

    models.upsertInstance({
      id: 'inst-1',
      modelId: 'local-llama',
      runtimeId: 'ollama-rt',
      computerId: 'comp-1',
      loaded: true,
      state: 'READY',
      health: 'healthy',
    });

    const service = new ModelDiscoveryStatusService({
      models,
      runtimes,
      computers,
      activeModelIds: () => ['local-llama'],
    });

    const fleet = service.getFleetStatus();
    expect(fleet.registeredCount).toBe(1);
    expect(fleet.availableCount).toBe(1);
    expect(fleet.loadedCount).toBe(1);
    expect(fleet.activeCount).toBe(1);

    const summary = service.formatStartupSummary('auto', 'medium');
    expect(summary).toContain('1 registered');
    expect(summary).toContain('1 available');
    expect(summary).toContain('1 loaded');
  });

  it('detects stale registry entries and prunes them correctly', () => {
    const models = new ModelRegistry();
    const runtimes = new RuntimeRegistry();
    const computers = new ComputerRegistry();

    models.register({
      id: 'stale-model',
      name: 'Stale Model',
      provider: 'ollama',
      local: true,
    });

    computers.register({
      id: 'comp-offline',
      name: 'Offline Comp',
      type: 'desktop',
      local: true,
      os: 'mac',
      hardware: { memoryGB: 16, cpuCores: 4 },
    });
    computers.setOffline('comp-offline');

    models.upsertInstance({
      id: 'inst-stale',
      modelId: 'stale-model',
      computerId: 'comp-offline',
      loaded: false,
      state: 'UNAVAILABLE',
      health: 'unavailable',
    });

    const service = new ModelDiscoveryStatusService({ models, runtimes, computers });
    const stale = service.detectStaleEntries();
    expect(stale.length).toBe(1);
    expect(stale[0].modelId).toBe('stale-model');

    const pruned = service.pruneStaleInstances();
    expect(pruned).toContain('inst-stale');
  });

  it('discoverLocalModels distinguishes loaded, installed, insufficient memory, and unavailable models', () => {
    const models = new ModelRegistry();
    const runtimes = new RuntimeRegistry();
    const computers = new ComputerRegistry();

    computers.register({
      id: 'local-comp',
      name: 'Macbook Pro',
      type: 'desktop',
      local: true,
      os: 'mac',
      hardware: { cpu: 'Apple M3 Max', cpuCores: 16, memoryGB: 32, gpu: { vendor: 'apple', model: 'Apple M3 Max', memoryGB: 32, unifiedMemory: true } },
    });

    runtimes.register({ id: 'ollama', runtimeKind: 'ollama', version: '0.1.0' });
    runtimes.register({ id: 'lmstudio', runtimeKind: 'lmstudio', version: '0.2.0' });
    runtimes.setHealth('ollama', 'healthy');
    runtimes.setHealth('lmstudio', 'unavailable');

    // 1. Loaded model (ollama)
    models.register({
      id: 'llama3:8b',
      name: 'Llama 3 8B',
      provider: 'ollama',
      local: true,
      parameters: '8B',
      contextMax: 8192,
    });
    models.upsertInstance({
      id: 'inst-llama',
      modelId: 'llama3:8b',
      runtimeId: 'ollama',
      computerId: 'local-comp',
      loaded: true,
      state: 'READY',
      health: 'healthy',
    });

    // 2. Installed & eligible model (Can load)
    models.register({
      id: 'mistral:7b',
      name: 'Mistral 7B',
      provider: 'ollama',
      local: true,
      parameters: '7B',
      contextMax: 8192,
    });
    models.upsertInstance({
      id: 'inst-mistral',
      modelId: 'mistral:7b',
      runtimeId: 'ollama',
      computerId: 'local-comp',
      loaded: false,
      state: 'UNLOADED',
      health: 'healthy',
    });

    // 3. Installed but insufficient memory model
    models.register({
      id: 'llama3:70b',
      name: 'Llama 3 70B',
      provider: 'ollama',
      local: true,
      parameters: '70B',
      contextMax: 8192,
    });
    models.upsertInstance({
      id: 'inst-70b',
      modelId: 'llama3:70b',
      runtimeId: 'ollama',
      computerId: 'local-comp',
      loaded: false,
      state: 'UNLOADED',
      health: 'healthy',
    });

    // 4. Unavailable model on offline runtime (lmstudio)
    models.register({
      id: 'deepseek:70b',
      name: 'DeepSeek 70B',
      provider: 'lmstudio',
      local: true,
      parameters: '70B',
      contextMax: 8192,
    });
    models.upsertInstance({
      id: 'inst-ds',
      modelId: 'deepseek:70b',
      runtimeId: 'lmstudio',
      computerId: 'local-comp',
      loaded: false,
      state: 'UNAVAILABLE',
      health: 'unavailable',
    });

    const service = new ModelDiscoveryStatusService({ models, runtimes, computers });
    const snapshot = service.discoverLocalModels();

    expect(snapshot.deviceLabel).toContain('Apple M3 Max');
    expect(snapshot.runtimes.length).toBe(2);

    const loadedModel = snapshot.models.find(m => m.modelId === 'llama3:8b');
    expect(loadedModel?.status).toBe('loaded');
    expect(loadedModel?.readinessLabel).toBe('Ready');
    expect(loadedModel?.eligible).toBe(true);

    const canLoadModel = snapshot.models.find(m => m.modelId === 'mistral:7b');
    expect(canLoadModel?.status).toBe('installed');
    expect(canLoadModel?.readinessLabel).toBe('Can load');
    expect(canLoadModel?.eligible).toBe(true);

    const insufficientModel = snapshot.models.find(m => m.modelId === 'llama3:70b');
    expect(insufficientModel?.readinessLabel).toBe('Insufficient memory');
    expect(insufficientModel?.eligible).toBe(false);

    const offlineModel = snapshot.models.find(m => m.modelId === 'deepseek:70b');
    expect(offlineModel?.status).toBe('unavailable');
    expect(offlineModel?.readinessLabel).toBe('Runtime offline');
  });

  it('already-loaded local models do not falsely trigger insufficient memory due to self-consumption', () => {
    const models = new ModelRegistry();
    const runtimes = new RuntimeRegistry();
    const computers = new ComputerRegistry();

    computers.register({
      id: 'local-comp',
      name: 'Macbook',
      type: 'desktop',
      local: true,
      os: 'mac',
      hardware: { memoryGB: 16, cpuCores: 8 },
    });

    runtimes.register({ id: 'ollama', runtimeKind: 'ollama', version: '1.0' });
    runtimes.setHealth('ollama', 'healthy');

    models.register({
      id: 'large-model',
      name: 'Large Model',
      provider: 'ollama',
      local: true,
      parameters: '14B',
    });

    models.upsertInstance({
      id: 'inst-large',
      modelId: 'large-model',
      runtimeId: 'ollama',
      computerId: 'local-comp',
      loaded: true,
      state: 'READY',
      health: 'healthy',
    });

    const service = new ModelDiscoveryStatusService({ models, runtimes, computers });
    const snapshot = service.discoverLocalModels();

    const m = snapshot.models.find(mod => mod.modelId === 'large-model');
    expect(m?.status).toBe('loaded');
    expect(m?.readinessLabel).toBe('Ready');
    expect(m?.eligible).toBe(true);
  });

  it('empty runtime state produces clean snapshot with models [] and accurate runtimeSummaryLabel', () => {
    const models = new ModelRegistry();
    const runtimes = new RuntimeRegistry();
    const computers = new ComputerRegistry();

    const service = new ModelDiscoveryStatusService({ models, runtimes, computers });
    const snapshot = service.discoverLocalModels();

    expect(snapshot.models).toEqual([]);
    expect(snapshot.runtimeSummaryLabel).toBe('No local runtime detected');
  });
});

