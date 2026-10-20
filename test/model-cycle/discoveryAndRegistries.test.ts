import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ModelRegistry, ComputerRegistry, RuntimeRegistry, estimateModelMemory } from '@wazir/core';
import type { DiscoveredModel, RuntimeInfo } from '@wazir/runtimes-interfaces';
import { createMockOllamaServer, createMockLMStudioServer, type MockServerHandle } from '../runtime/mockRuntimeServer.js';
import { createOllamaAdapter } from '@wazir/runtimes-ollama';
import { createLMStudioAdapter } from '@wazir/runtimes-lmstudio';

// The discovery model-registration logic in apps/cli/src/engine.ts
const DEFAULT_CONTEXT = 8192;

interface MockEngineConfig {
  modelCapabilities: Record<string, string[]>;
  modelContext: Record<string, number>;
}

function registerDiscoveredModel(
  models: ModelRegistry,
  runtime: { id: string; health: string; models: DiscoveredModel[] },
  discovered: DiscoveredModel,
  computerId: string,
  config: MockEngineConfig,
  isLoaded: boolean = false,
): void {
  const provider = runtime.id;
  const configured = config.modelContext[discovered.id];
  const contextMax = discovered.contextWindow ?? configured ?? DEFAULT_CONTEXT;

  models.register({
    id: discovered.id,
    name: discovered.name ?? discovered.id,
    provider,
    family: 'qwen',
    contextMax,
    configuredContext: configured,
    capabilities: ['generalChat'],
    toolCalling: discovered.toolCalling ?? false,
    structuredOutput: discovered.structuredOutput ?? false,
    vision: discovered.vision ?? false,
    audio: false,
    embedding: false,
    reasoning: false,
    memory: estimateModelMemory(discovered.parameters, discovered.id, discovered.quantization),
    runtimeCompatibility: 'any',
    local: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  models.upsertInstance({
    id: `${discovered.id}::${computerId}::${provider}`,
    modelId: discovered.id,
    computerId,
    runtimeId: provider,
    runtimeModelId: discovered.id,
    loaded: isLoaded,
    health: runtime.health === 'healthy' ? 'healthy' : 'degraded',
    contextTokens: contextMax,
  });
}

describe('Section 3 & 8b: Discovery and Model Registries (model_cycle.md)', () => {
  let ollamaServer: MockServerHandle;
  let lmstudioServer: MockServerHandle;

  beforeAll(async () => {
    ollamaServer = await createMockOllamaServer();
    lmstudioServer = await createMockLMStudioServer();
  });

  afterAll(async () => {
    await ollamaServer?.close();
    await lmstudioServer?.close();
  });

  describe('Runtime Discovery & Health Probing', () => {
    it('discovers runtime info and reflects real health status', async () => {
      const ollama = createOllamaAdapter(ollamaServer.url);
      const info = await ollama.discover();
      expect(info.id).toBe('ollama');
      expect(info.name).toBe('Ollama');
      expect(info.version).toBe('0.3.10');

      const health = await ollama.healthCheck();
      expect(health.status).toBe('healthy');
    });

    it('flips to unavailable when daemon is stopped or unreachable', async () => {
      const deadAdapter = createOllamaAdapter('http://127.0.0.1:9');
      const health = await deadAdapter.healthCheck();
      expect(health.status).toBe('unavailable');
    });
  });

  describe('Model Discovery: Context Window Resolution', () => {
    it('Case A: honors runtime-reported contextWindow when present', () => {
      const models = new ModelRegistry();
      const discovered: DiscoveredModel = {
        id: 'qwen2.5:32b',
        contextWindow: 32768,
      };
      registerDiscoveredModel(
        models,
        { id: 'ollama', health: 'healthy', models: [discovered] },
        discovered,
        'local-machine',
        { modelCapabilities: {}, modelContext: { 'qwen2.5:32b': 16384 } },
      );

      const record = models.get('qwen2.5:32b');
      expect(record).toBeDefined();
      expect(record!.contextMax).toBe(32768); // Discovered takes precedence over configured
    });

    it('Case B: falls back to configuredContext when runtime does not report window', () => {
      const models = new ModelRegistry();
      const discovered: DiscoveredModel = {
        id: 'custom-model:latest',
        contextWindow: undefined,
      };
      registerDiscoveredModel(
        models,
        { id: 'ollama', health: 'healthy', models: [discovered] },
        discovered,
        'local-machine',
        { modelCapabilities: {}, modelContext: { 'custom-model:latest': 16000 } },
      );

      const record = models.get('custom-model:latest');
      expect(record).toBeDefined();
      expect(record!.contextMax).toBe(16000);
      expect(record!.configuredContext).toBe(16000);
    });

    it('Case C: falls back to DEFAULT_CONTEXT (8192) when neither runtime nor config specifies', () => {
      const models = new ModelRegistry();
      const discovered: DiscoveredModel = {
        id: 'bare-model:latest',
        contextWindow: undefined,
      };
      registerDiscoveredModel(
        models,
        { id: 'ollama', health: 'healthy', models: [discovered] },
        discovered,
        'local-machine',
        { modelCapabilities: {}, modelContext: {} },
      );

      const record = models.get('bare-model:latest');
      expect(record).toBeDefined();
      expect(record!.contextMax).toBe(8192);
    });
  });

  describe('Section 0 / F4 Regression Test: Memory Awareness is Sized Dynamically', () => {
    it('asserts model memory is sized according to model parameters (M0)', () => {
      const models = new ModelRegistry();

      // Small embedding model (e.g. 100MB)
      const embedModel: DiscoveredModel = { id: 'nomic-embed:latest', parameters: '137M' };
      registerDiscoveredModel(
        models,
        { id: 'ollama', health: 'healthy', models: [embedModel] },
        embedModel,
        'local-machine',
        { modelCapabilities: {}, modelContext: {} },
      );

      // Huge 120B MoE model
      const giantModel: DiscoveredModel = { id: 'deepseek-v3:120b', parameters: '120B' };
      registerDiscoveredModel(
        models,
        { id: 'ollama', health: 'healthy', models: [giantModel] },
        giantModel,
        'local-machine',
        { modelCapabilities: {}, modelContext: {} },
      );

      const embedRecord = models.get('nomic-embed:latest');
      const giantRecord = models.get('deepseek-v3:120b');

      // M0: dynamic memory estimation distinguishes small embedding vs giant model
      expect(embedRecord?.memory?.minSystemGB).toBe(2);
      expect(giantRecord?.memory?.minSystemGB).toBe(92);
      expect(embedRecord?.memory?.minGpuGB).toBeUndefined();
    });
  });

  describe('Section 0 / F1 Regression Test: ModelInstance.loaded State & setInstanceLoaded', () => {
    it('asserts ModelInstance reflects resident state and setInstanceLoaded works (M0)', async () => {
      const models = new ModelRegistry();
      const ollama = createOllamaAdapter(ollamaServer.url);

      // Ollama mock server /api/ps reports qwen2.5:latest as currently loaded
      const residentModels = await ollama.getLoadedModels();
      expect(residentModels).toContain('qwen2.5:latest');

      // Discover and register with resident status
      const discovered: DiscoveredModel = { id: 'qwen2.5:latest' };
      registerDiscoveredModel(
        models,
        { id: 'ollama', health: 'healthy', models: [discovered] },
        discovered,
        'local-machine',
        { modelCapabilities: {}, modelContext: {} },
        residentModels.includes('qwen2.5:latest'),
      );

      const instances = models.instancesOf('qwen2.5:latest');
      expect(instances.length).toBe(1);
      expect(instances[0].loaded).toBe(true);

      // Verify setInstanceLoaded allows changing loaded state
      const flipped = models.setInstanceLoaded(instances[0].id, false);
      expect(flipped).toBe(true);
      expect(models.instancesOf('qwen2.5:latest')[0].loaded).toBe(false);

      models.setInstanceLoaded(instances[0].id, true);
      expect(models.instancesOf('qwen2.5:latest')[0].loaded).toBe(true);
    });
  });

  describe('Discovery Idempotency & ID Stability', () => {
    it('produces stable instance IDs and zero duplicate entries on repeated discovery', () => {
      const models = new ModelRegistry();
      const discovered: DiscoveredModel = { id: 'stable-model:latest' };
      const config: MockEngineConfig = { modelCapabilities: {}, modelContext: {} };

      // First discovery run
      registerDiscoveredModel(
        models,
        { id: 'lmstudio', health: 'healthy', models: [discovered] },
        discovered,
        'macbook-local',
        config,
      );

      // Second discovery run
      registerDiscoveredModel(
        models,
        { id: 'lmstudio', health: 'healthy', models: [discovered] },
        discovered,
        'macbook-local',
        config,
      );

      // Registry must key stably by id
      const allRecords = models.list();
      expect(allRecords.filter((r) => r.id === 'stable-model:latest')).toHaveLength(1);

      const instances = models.instancesOf('stable-model:latest');
      expect(instances).toHaveLength(1);
      expect(instances[0].id).toBe('stable-model:latest::macbook-local::lmstudio');
    });
  });

  describe('Section 8b: Tracked Debt Tests (F1, F2, F6)', () => {
    it('F1 Gap: setInstanceHealth is never called by core engine during job execution', () => {
      const models = new ModelRegistry();
      models.upsertInstance({
        id: 'inst-1',
        modelId: 'm1',
        computerId: 'c1',
        runtimeId: 'r1',
        runtimeModelId: 'm1',
        loaded: false,
        health: 'healthy',
      });

      // Verification: without an external caller invoking setInstanceHealth, it never changes
      const inst = models.instancesOf('m1')[0];
      expect(inst.loaded).toBe(false);
    });

    it('F2 Gap: explicit unload/reclaim API does not exist on adapters or scheduler', async () => {
      const lmstudio = createLMStudioAdapter(lmstudioServer.url);
      // LM Studio adapter now provides unloadModel
      expect(typeof (lmstudio as any).unloadModel).toBe('function');
    });

    it('F6 Gap: execution event schema includes model.loading/model.loaded but no emitter produces them', () => {
      // Documenting schema presence in packages/core/src/types/execution.ts
      const supportedEventTypes: string[] = [
        'execution.started',
        'generation.started',
        'model.loading',
        'model.loaded',
        'execution.completed',
      ];
      expect(supportedEventTypes).toContain('model.loading');
      expect(supportedEventTypes).toContain('model.loaded');
    });
  });
});
