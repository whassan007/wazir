import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createOllamaAdapter } from '@wazir/runtimes-ollama';
import { runRuntimeAdapterContractSuite } from './adapterContract.suite.js';
import { createMockOllamaServer, type MockServerHandle } from './mockRuntimeServer.js';
import { executeRequest } from '@wazir/workers';

let mockServer: MockServerHandle;
let disconnectServer: MockServerHandle;

beforeAll(async () => {
  mockServer = await createMockOllamaServer();
  disconnectServer = await createMockOllamaServer();
  disconnectServer.simulateDisconnectOnChat = true;
});

afterAll(async () => {
  await mockServer?.close();
  await disconnectServer?.close();
});

runRuntimeAdapterContractSuite({
  name: '@wazir/runtimes-ollama',
  createAdapter: () => createOllamaAdapter(mockServer.url),
  expectedType: 'ollama',
  simulateFailure: {
    createOfflineAdapter: () => createOllamaAdapter('http://127.0.0.1:1'),
    createDisconnectingAdapter: () => createOllamaAdapter(disconnectServer.url),
  },
});

describe('Ollama Adapter: Failure Injection & Wire Semantics', () => {
  it('does not silently switch models when requested model unloads or is not found', async () => {
    const adapter = createOllamaAdapter(mockServer.url);
    const outcome = await executeRequest(adapter, {
      taskId: 'unloaded-model-task',
      modelId: 'nonexistent-model',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeDefined();
    expect(outcome.error).toMatch(/404|not found/i);
  });

  it('Section 7 / F3: forwards GenerationRequest.contextTokens as options.num_ctx in /api/chat payload', async () => {
    const adapter = createOllamaAdapter(mockServer.url);

    // Call 1: contextTokens = 2048
    for await (const _ of adapter.generate({
      modelId: 'qwen2.5:latest',
      messages: [{ role: 'user', content: 'hello' }],
      contextTokens: 2048,
    })) {}
    expect(mockServer.lastRequestBody?.options?.num_ctx).toBe(2048);

    // Call 2: contextTokens = 8192 on the same model
    for await (const _ of adapter.generate({
      modelId: 'qwen2.5:latest',
      messages: [{ role: 'user', content: 'hello again' }],
      contextTokens: 8192,
    })) {}
    expect(mockServer.lastRequestBody?.options?.num_ctx).toBe(8192);
  });

  it('Section 8a: getLoadedModels() queries /api/ps and returns resident model ids', async () => {
    const adapter = createOllamaAdapter(mockServer.url);
    const loaded = await adapter.getLoadedModels();
    expect(loaded).toEqual(['qwen2.5:latest']);
  });

  it('Section 0 / F2 Tracked Gap: reports modelLoad and modelUnload capabilities but lacks methods', async () => {
    const adapter = createOllamaAdapter(mockServer.url);
    const caps = await adapter.getCapabilities();
    expect(caps.modelLoad).toBe(true);
    expect(caps.modelUnload).toBe(true);
    // Method implementations are missing (tracked gap F2)
    expect((adapter as any).loadModel).toBeUndefined();
    expect((adapter as any).unloadModel).toBeUndefined();
  });
});
