import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLMStudioAdapter } from '@wazir/runtimes-lmstudio';
import { runRuntimeAdapterContractSuite } from './adapterContract.suite.js';
import { createMockLMStudioServer, type MockServerHandle } from './mockRuntimeServer.js';
import { executeRequest } from '@wazir/workers';

let mockServer: MockServerHandle;
let disconnectServer: MockServerHandle;

beforeAll(async () => {
  mockServer = await createMockLMStudioServer();
  disconnectServer = await createMockLMStudioServer();
  disconnectServer.simulateDisconnectOnChat = true;
});

afterAll(async () => {
  await mockServer?.close();
  await disconnectServer?.close();
});

runRuntimeAdapterContractSuite({
  name: '@wazir/runtimes-lmstudio',
  createAdapter: () => createLMStudioAdapter(mockServer.url),
  expectedType: 'lmstudio',
  simulateFailure: {
    createOfflineAdapter: () => createLMStudioAdapter('http://127.0.0.1:1/v1'),
    createDisconnectingAdapter: () => createLMStudioAdapter(disconnectServer.url),
  },
});

describe('LM Studio Adapter: Failure Injection & Wire Semantics', () => {
  it('does not silently switch models when requested model unloads or is not found', async () => {
    const adapter = createLMStudioAdapter(mockServer.url);
    const outcome = await executeRequest(adapter, {
      taskId: 'unloaded-model-task',
      modelId: 'nonexistent-model',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeDefined();
    expect(outcome.error?.toLowerCase()).toContain('not found');
  });

  it('Section 7 / F3: never sends context-length / num_ctx in /chat/completions payload regardless of contextTokens', async () => {
    const adapter = createLMStudioAdapter(mockServer.url);

    for await (const _ of adapter.generate({
      modelId: 'qwen2.5-coder-7b-instruct',
      messages: [{ role: 'user', content: 'hello' }],
      contextTokens: 8192,
    })) {}

    const req = mockServer.lastRequestBody;
    expect(req).toBeDefined();
    // In LM Studio adapter, contextTokens is never passed to OpenAI completions endpoint
    expect(req.num_ctx).toBeUndefined();
    expect(req.contextTokens).toBeUndefined();
    expect(req.context_window).toBeUndefined();
  });

  it('Section 0 / F2: getCapabilities() accurately reports modelLoad: false and modelUnload: false', async () => {
    const adapter = createLMStudioAdapter(mockServer.url);
    const caps = await adapter.getCapabilities();
    expect(caps.modelLoad).toBe(false);
    expect(caps.modelUnload).toBe(false);
  });

  it('Section 8a: getLoadedModels() returns discovered models', async () => {
    const adapter = createLMStudioAdapter(mockServer.url);
    const loaded = await adapter.getLoadedModels();
    expect(loaded).toEqual(['qwen2.5-coder-7b-instruct']);
  });
});
