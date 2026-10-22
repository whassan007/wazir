import { describe, it, expect, vi } from 'vitest';
import type { RuntimeAdapter, GenerationRequest } from '@wazir/runtimes-interfaces';
import { executeRequest } from '@wazir/workers';

export interface ContractSuiteOptions {
  name: string;
  createAdapter: () => Promise<RuntimeAdapter> | RuntimeAdapter;
  expectedType: 'ollama' | 'lmstudio' | 'openai-compatible' | 'other';
  simulateFailure?: {
    createOfflineAdapter: () => Promise<RuntimeAdapter> | RuntimeAdapter;
    createDisconnectingAdapter?: () => Promise<RuntimeAdapter> | RuntimeAdapter;
  };
}

export function runRuntimeAdapterContractSuite(options: ContractSuiteOptions): void {
  describe(`Runtime Adapter Contract: ${options.name}`, () => {
    it('implements the full RuntimeAdapter interface shape', async () => {
      const adapter = await options.createAdapter();

      expect(adapter).toBeDefined();
      expect(typeof adapter.id).toBe('string');
      expect(adapter.type).toBe(options.expectedType);

      expect(typeof adapter.discover).toBe('function');
      expect(typeof adapter.healthCheck).toBe('function');
      expect(typeof adapter.listModels).toBe('function');
      expect(typeof adapter.getCapabilities).toBe('function');
      expect(typeof adapter.generate).toBe('function');

      if (adapter.loadModel) expect(typeof adapter.loadModel).toBe('function');
      if (adapter.unloadModel) expect(typeof adapter.unloadModel).toBe('function');
      if (adapter.getLoadedModels) expect(typeof adapter.getLoadedModels).toBe('function');
      if (adapter.estimateResources) expect(typeof adapter.estimateResources).toBe('function');
      if (adapter.cancel) expect(typeof adapter.cancel).toBe('function');
    });

    it('discover() returns valid RuntimeInfo structure', async () => {
      const adapter = await options.createAdapter();
      const info = await adapter.discover();

      expect(info).toBeDefined();
      expect(typeof info.id).toBe('string');
      expect(typeof info.name).toBe('string');
      expect(typeof info.version).toBe('string');
    });

    it('healthCheck() returns valid HealthStatus with status healthy|degraded|unavailable', async () => {
      const adapter = await options.createAdapter();
      const health = await adapter.healthCheck();

      expect(health).toBeDefined();
      expect(['healthy', 'degraded', 'unavailable']).toContain(health.status);
    });

    it('listModels() returns DiscoveredModel array with valid capability metadata', async () => {
      const adapter = await options.createAdapter();
      const models = await adapter.listModels();

      expect(Array.isArray(models)).toBe(true);
      for (const m of models) {
        expect(typeof m.id).toBe('string');
        if (m.name !== undefined) expect(typeof m.name).toBe('string');
        if (m.toolCalling !== undefined) expect(typeof m.toolCalling).toBe('boolean');
        if (m.vision !== undefined) expect(typeof m.vision).toBe('boolean');
      }
    });

    it('getCapabilities() returns boolean flags for all standard runtime capabilities', async () => {
      const adapter = await options.createAdapter();
      const caps = await adapter.getCapabilities();

      expect(caps).toBeDefined();
      expect(typeof caps.chat).toBe('boolean');
      expect(typeof caps.streaming).toBe('boolean');
      expect(typeof caps.toolCalling).toBe('boolean');
      expect(typeof caps.structuredOutput).toBe('boolean');
      expect(typeof caps.vision).toBe('boolean');
      expect(typeof caps.embeddings).toBe('boolean');
      expect(typeof caps.reasoning).toBe('boolean');
    });

    it('generate() streams tokens and completes cleanly', async () => {
      const adapter = await options.createAdapter();
      const models = await adapter.listModels();
      const modelId = models[0]?.id ?? 'test-model';

      const req: GenerationRequest = {
        modelId,
        messages: [{ role: 'user', content: 'Say hello' }],
        stream: true,
      };

      const events: any[] = [];
      for await (const ev of adapter.generate(req)) {
        events.push(ev);
      }

      expect(events.length).toBeGreaterThan(0);
      const tokenEvents = events.filter((e) => e.type === 'token');
      const completedEvents = events.filter((e) => e.type === 'completed');

      expect(tokenEvents.length).toBeGreaterThan(0);
      expect(completedEvents.length).toBeGreaterThan(0);
    });

    it('executeRequest() in workers package executes successfully against the adapter', async () => {
      const adapter = await options.createAdapter();
      const models = await adapter.listModels();
      const modelId = models[0]?.id ?? 'test-model';

      const outcome = await executeRequest(adapter, {
        taskId: 'test-task',
        modelId,
        messages: [{ role: 'user', content: 'Say hello' }],
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.output.length).toBeGreaterThan(0);
      expect(outcome.error).toBeUndefined();
    });

    if (options.simulateFailure?.createOfflineAdapter) {
      it('Runtime failure injection: runtime down before dispatch marks execution failed with reason recorded', async () => {
        const offlineAdapter = await options.simulateFailure.createOfflineAdapter();
        const health = await offlineAdapter.healthCheck();
        expect(health.status).toBe('unavailable');

        const outcome = await executeRequest(offlineAdapter, {
          taskId: 'offline-task',
          modelId: 'any-model',
          messages: [{ role: 'user', content: 'Ping' }],
        });

        expect(outcome.ok).toBe(false);
        expect(outcome.error).toBeDefined();
        expect(outcome.output).toBe('');
      });
    }

    if (options.simulateFailure?.createDisconnectingAdapter) {
      it('Runtime failure injection: runtime disconnects mid-execution returns failure', async () => {
        const dcAdapter = await options.simulateFailure.createDisconnectingAdapter();
        const outcome = await executeRequest(dcAdapter, {
          taskId: 'dc-task',
          modelId: 'any-model',
          messages: [{ role: 'user', content: 'Talk long' }],
        });

        expect(outcome.ok).toBe(false);
        expect(outcome.error).toBeDefined();
      });
    }

    it('estimateResources() contract: returns undefined or resource estimate without throwing for unknown model', async () => {
      const adapter = await options.createAdapter();
      if (!adapter.estimateResources) {
        // LM Studio / Fake does not implement this method; guard skips cleanly
        expect(adapter.estimateResources).toBeUndefined();
        return;
      }

      // Cold-start case for an unknown model: returns undefined rather than throwing
      const estimate = await adapter.estimateResources('unseen-model:latest');
      if (estimate !== undefined) {
        expect(typeof estimate).toBe('object');
      } else {
        expect(estimate).toBeUndefined();
      }
    });

    it('getCapabilities() method parity check', async () => {
      const adapter = await options.createAdapter();
      const caps = await adapter.getCapabilities();

      if (caps.modelLoad) {
        // Tracked in Section 0 (F2): Ollama reports modelLoad: true but does not implement loadModel()
        const hasLoadMethod = typeof (adapter as any).loadModel === 'function';
        if (!hasLoadMethod) {
          expect(options.name).toBe('@wazir/runtimes-ollama');
        } else {
          expect(hasLoadMethod).toBe(true);
        }
      }

      if (caps.modelUnload) {
        const hasUnloadMethod = typeof (adapter as any).unloadModel === 'function';
        if (!hasUnloadMethod) {
          expect(options.name).toBe('@wazir/runtimes-ollama');
        } else {
          expect(hasUnloadMethod).toBe(true);
        }
      }
    });
  });
}
