import { describe, it, expect, beforeEach } from 'vitest';
import { Worker } from '../src/worker.js';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';

describe('Worker', () => {
  let worker: Worker;

  beforeEach(() => {
    worker = new Worker({
      computerId: 'test-computer',
      name: 'Test Worker',
      adapters: [],
    });
  });

  it('registers with proper status', () => {
    expect(worker.info.computerId).toBe('test-computer');
    expect(worker.info.status).toBe('offline'); // Not started yet
  });

  it('has version info', () => {
    expect(worker.info.version).toBeDefined();
  });

  it('reports offline before start() and online after', async () => {
    expect(worker.info.status).toBe('offline');
    await worker.start();
    expect(worker.info.status).toBe('online');
    await worker.stop();
    expect(worker.info.status).toBe('offline');
  });
});

function fakeAdapter(id: string, modelIds: string[]): RuntimeAdapter & { cancelledIds: string[] } {
  const cancelledIds: string[] = [];
  return {
    id,
    type: 'other',
    cancelledIds,
    async discover() {
      return { id, name: id, version: '1.0' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async listModels() {
      return modelIds.map((m) => ({ id: m, name: m }));
    },
    async getCapabilities() {
      return {
        chat: true,
        streaming: true,
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        embeddings: false,
        reasoning: false,
        modelLoad: false,
        modelUnload: false,
        modelDownload: false,
        statefulChat: false,
        mcp: false,
      };
    },
    async *generate() {
      yield { type: 'completed' as const, content: 'ok' };
    },
    async cancel(requestId: string) {
      cancelledIds.push(requestId);
    },
  };
}

describe('Worker — adapter selection and cancellation', () => {
  it('adapterForModel finds the runtime that actually lists the requested model', async () => {
    const ollama = fakeAdapter('ollama', ['qwen3-coder']);
    const lmstudio = fakeAdapter('lmstudio', ['llama-3']);
    const worker = new Worker({ computerId: 'c1', name: 'w1', adapters: [ollama, lmstudio] });
    await worker.start();

    expect(worker.adapterForModel('qwen3-coder')).toBe(ollama);
    expect(worker.adapterForModel('llama-3')).toBe(lmstudio);
  });

  it('falls back to the first healthy runtime for an unlisted model id', async () => {
    const ollama = fakeAdapter('ollama', ['qwen3-coder']);
    const worker = new Worker({ computerId: 'c1', name: 'w1', adapters: [ollama] });
    await worker.start();

    // Not in ollama's model list, but ollama is the only healthy runtime.
    expect(worker.adapterForModel('some-other-model')).toBe(ollama);
  });

  it('cancel() forwards the requestId to every discovered adapter, not just one', async () => {
    const ollama = fakeAdapter('ollama', ['qwen3-coder']);
    const lmstudio = fakeAdapter('lmstudio', ['llama-3']);
    const worker = new Worker({ computerId: 'c1', name: 'w1', adapters: [ollama, lmstudio] });
    await worker.start();

    await worker.cancel('req-123');

    expect(ollama.cancelledIds).toEqual(['req-123']);
    expect(lmstudio.cancelledIds).toEqual(['req-123']);
  });

  it('cancel() does not throw when an adapter has no cancel support', async () => {
    const noCancel: RuntimeAdapter = {
      id: 'bare',
      type: 'other',
      async discover() {
        return { id: 'bare', name: 'bare', version: '1.0' };
      },
      async healthCheck() {
        return { status: 'healthy' };
      },
      async listModels() {
        return [];
      },
      async getCapabilities() {
        return {
          chat: true,
          streaming: true,
          toolCalling: false,
          structuredOutput: false,
          vision: false,
          embeddings: false,
          reasoning: false,
          modelLoad: false,
          modelUnload: false,
          modelDownload: false,
          statefulChat: false,
          mcp: false,
        };
      },
      async *generate() {
        yield { type: 'completed' as const, content: 'ok' };
      },
      // no `cancel` method at all
    };
    const worker = new Worker({ computerId: 'c1', name: 'w1', adapters: [noCancel] });
    await worker.start();

    await expect(worker.cancel('req-1')).resolves.toBeUndefined();
  });
});

describe('Worker — refreshRuntime', () => {
  it('re-probes a known runtime and picks up newly available models without a full restart', async () => {
    let healthy = false;
    const lmstudio: RuntimeAdapter = {
      id: 'lmstudio',
      type: 'other',
      async discover() {
        return { id: 'lmstudio', name: 'lmstudio', version: '1.0' };
      },
      async healthCheck() {
        return healthy ? { status: 'healthy' } : { status: 'unavailable', message: 'connection refused' };
      },
      async listModels() {
        return healthy ? [{ id: 'gemma-4', name: 'gemma-4' }] : [];
      },
      async getCapabilities() {
        return {
          chat: true,
          streaming: true,
          toolCalling: false,
          structuredOutput: false,
          vision: false,
          embeddings: false,
          reasoning: false,
          modelLoad: false,
          modelUnload: false,
          modelDownload: false,
          statefulChat: false,
          mcp: false,
        };
      },
      async *generate() {
        yield { type: 'completed' as const, content: 'ok' };
      },
    };
    const worker = new Worker({ computerId: 'c1', name: 'w1', adapters: [lmstudio] });
    await worker.start();

    expect(worker.discovered.find((r) => r.id === 'lmstudio')?.health).toBe('unavailable');
    expect(worker.adapterForModel('gemma-4')).toBeUndefined();

    healthy = true;
    const refreshed = await worker.refreshRuntime('lmstudio');

    expect(refreshed?.health).toBe('healthy');
    expect(refreshed?.models.map((m) => m.id)).toEqual(['gemma-4']);
    expect(worker.discovered.find((r) => r.id === 'lmstudio')?.health).toBe('healthy');
    expect(worker.adapterForModel('gemma-4')).toBe(lmstudio);
  });

  it('returns undefined for a runtime id the worker was never configured with', async () => {
    const worker = new Worker({ computerId: 'c1', name: 'w1', adapters: [] });
    await worker.start();
    expect(await worker.refreshRuntime('nonexistent')).toBeUndefined();
  });
});
