import { describe, expect, it, vi } from 'vitest';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import { ComputerRegistry } from '../src/services/computerRegistry.js';
import { ModelLifecycleService } from '../src/services/modelLifecycleService.js';
import { ModelRegistry } from '../src/services/modelRegistry.js';
import { PolicyEngine } from '../src/services/policyEngine.js';
import { RuntimeRegistry } from '../src/services/runtimeRegistry.js';

const GiB = 1024 ** 3;

function registerDgxHost(computers: ComputerRegistry, id = 'dgx_spark', explicitUnified?: boolean) {
  return computers.register({
    id,
    name: 'DGX Spark',
    type: 'server',
    local: false,
    os: { platform: 'linux', architecture: 'arm64', version: '6.8.0' },
    hardware: {
      cpu: 'NVIDIA Grace',
      cpuCores: 20,
      memoryGB: 128,
      gpu: {
        vendor: 'nvidia',
        model: 'NVIDIA GB10',
        memoryGB: 128,
        cuda: true,
        ...(explicitUnified !== undefined ? { unifiedMemory: explicitUnified } : {}),
      },
    },
  });
}

describe('remote DGX unified-memory and telemetry admission', () => {
  it('reports DGX unified memory with undefined VRAM and populated system memory', () => {
    const computers = new ComputerRegistry();
    registerDgxHost(computers, 'dgx_spark');

    const observedAt = new Date();
    computers.heartbeat('dgx_spark', {
      load: {
        cpuPercent: 18,
        memoryUsedGB: 24,
        memoryAvailableGB: 104,
        gpuUtilizationPercent: 42,
      },
      telemetryTimestamp: observedAt,
      telemetrySource: 'ollama:/api/ps',
    });

    const snapshot = computers.resourceSnapshot('dgx_spark');
    expect(snapshot.unifiedMemory).toBe(true);
    expect(snapshot.totalVramBytes).toBeUndefined();
    expect(snapshot.availableVramBytes).toBeUndefined();
    expect(snapshot.totalMemoryBytes).toBe(128 * GiB);
    expect(snapshot.availableMemoryBytes).toBe(104 * GiB);
    expect(snapshot.telemetryFresh).toBe(true);
    expect(snapshot.telemetryTimestamp).toEqual(observedAt);
    expect(snapshot.telemetrySource).toBe('ollama:/api/ps');
  });

  it('flags stale remote telemetry as telemetryFresh: false and clears availableMemoryBytes', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const computers = new ComputerRegistry();
      registerDgxHost(computers, 'dgx_spark', true);

      const initialTs = new Date();
      computers.heartbeat('dgx_spark', {
        load: { cpuPercent: 10, memoryUsedGB: 28, memoryAvailableGB: 100 },
        telemetryTimestamp: initialTs,
        telemetrySource: 'worker:/telemetry',
      });
      expect(computers.resourceSnapshot('dgx_spark').telemetryFresh).toBe(true);

      // Advance beyond the 30s default freshness window
      vi.advanceTimersByTime(31_000);

      const stale = computers.resourceSnapshot('dgx_spark');
      expect(stale.telemetryFresh).toBe(false);
      expect(stale.telemetryTimestamp).toEqual(initialTs);
      expect(stale.availableMemoryBytes).toBeUndefined();
      expect(stale.totalVramBytes).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes stale remote telemetry before admission in ModelLifecycleService', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const computers = new ComputerRegistry();
      registerDgxHost(computers, 'dgx_spark', true);

      // Seed stale telemetry from an earlier time
      computers.heartbeat('dgx_spark', {
        load: { cpuPercent: 5, memoryUsedGB: 20, memoryAvailableGB: 108 },
        telemetryTimestamp: new Date(Date.now() - 60_000),
        telemetrySource: 'ollama:/api/ps',
      });
      expect(computers.resourceSnapshot('dgx_spark').telemetryFresh).toBe(false);

      const models = new ModelRegistry();
      const runtimes = new RuntimeRegistry();
      const caps = {
        chat: true, streaming: true, toolCalling: true, structuredOutput: false,
        vision: false, embeddings: false, reasoning: false,
        modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false,
      };
      runtimes.register({
        id: 'dgx_spark:ollama',
        type: 'ollama',
        name: 'ollama',
        version: '1',
        computerId: 'dgx_spark',
        capabilities: caps,
      });
      runtimes.update('dgx_spark:ollama', { health: 'healthy' });

      const loaded = new Map<string, number>();
      const adapter = {
        id: 'dgx_spark:ollama',
        type: 'ollama',
        discover: async () => ({ id: 'dgx_spark:ollama', name: 'ollama', version: '1' }),
        healthCheck: async () => ({ status: 'healthy' }),
        getCapabilities: async () => caps,
        listModels: async () => [{ id: 'llama3.3:70b', contextWindow: 131072 }],
        estimateModelLoad: vi.fn(async () => ({ totalMemoryBytes: 42 * GiB, source: 'RUNTIME', confidence: 'high' })),
        loadModel: vi.fn(async (id: string, opts: { contextTokens: number }) => { loaded.set(id, opts.contextTokens); }),
        unloadModel: vi.fn(async (id: string) => { loaded.delete(id); }),
        inspectModel: vi.fn(async (id: string) => ({
          modelId: id,
          loaded: loaded.has(id),
          effectiveContext: loaded.get(id),
          memoryBytes: 42 * GiB,
        })),
        probeModel: vi.fn(async () => true),
        async *generate() { yield { type: 'completed', content: 'ok' }; },
      } as unknown as RuntimeAdapter;

      models.register({
        id: 'llama3.3:70b',
        name: 'llama3.3:70b',
        provider: 'ollama',
        family: 'llama',
        contextMax: 131072,
        capabilities: ['generalChat'],
        toolCalling: true,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        runtimeCompatibility: ['ollama'],
        local: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      models.upsertInstallation({
        id: 'inst-1',
        modelId: 'llama3.3:70b',
        computerId: 'dgx_spark',
        runtimeId: 'dgx_spark:ollama',
        runtimeModelId: 'llama3.3:70b',
        installed: true,
        observedAt: new Date(),
      });
      models.upsertInstance({
        id: 'inst-1',
        installationId: 'inst-1',
        modelId: 'llama3.3:70b',
        computerId: 'dgx_spark',
        runtimeId: 'dgx_spark:ollama',
        runtimeModelId: 'llama3.3:70b',
        loaded: false,
        state: 'INSTALLED',
        health: 'healthy',
      });

      const refreshResources = vi.fn(async (computerId: string) => {
        if (computerId === 'dgx_spark') {
          computers.heartbeat('dgx_spark', {
            load: { cpuPercent: 14, memoryUsedGB: 32, memoryAvailableGB: 96 },
            telemetryTimestamp: new Date(),
            telemetrySource: 'ollama:/api/ps',
          });
        }
      });

      const lifecycle = new ModelLifecycleService({
        models,
        computers,
        runtimes,
        adapters: new Map([['dgx_spark:ollama', adapter]]),
        policy: new PolicyEngine({ projectRoot: '/tmp' }),
        refreshResources,
      });

      const plan = await lifecycle.load('llama3.3:70b', { computerId: 'dgx_spark' });
      expect(refreshResources).toHaveBeenCalledWith('dgx_spark');
      expect(plan.admissionDecision.status).toBe('ADMITTED');
      const refreshed = computers.resourceSnapshot('dgx_spark');
      expect(refreshed.telemetryFresh).toBe(true);
      expect(refreshed.availableMemoryBytes).toBe(96 * GiB);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps unknown memory as undefined and distinguishes it from zero', () => {
    const computers = new ComputerRegistry();
    registerDgxHost(computers, 'dgx_spark', true);

    // Never received any telemetry
    const initial = computers.resourceSnapshot('dgx_spark');
    expect(initial.availableMemoryBytes).toBeUndefined();
    expect(initial.telemetryFresh).toBe(false);
    expect(initial.telemetryTimestamp).toBeUndefined();

    // Heartbeat with missing memoryAvailableGB must stay undefined, not 0
    computers.heartbeat('dgx_spark', {
      load: { cpuPercent: 25 } as never,
      telemetrySource: 'partial-probe',
    });
    const partial = computers.resourceSnapshot('dgx_spark');
    expect(partial.availableMemoryBytes).toBeUndefined();
    expect(partial.telemetryFresh).toBe(true);

    // Explicit 0 GiB available must be 0, distinguishable from undefined
    computers.heartbeat('dgx_spark', {
      load: { cpuPercent: 95, memoryUsedGB: 128, memoryAvailableGB: 0 },
      telemetrySource: 'worker:/telemetry',
    });
    const exhausted = computers.resourceSnapshot('dgx_spark');
    expect(exhausted.availableMemoryBytes).toBe(0);
    expect(exhausted.availableMemoryBytes).not.toBeUndefined();
    expect(exhausted.telemetryFresh).toBe(true);
  });
});
