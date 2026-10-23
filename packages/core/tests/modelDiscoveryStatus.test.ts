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
});
