import type { RuntimeAdapter, GenerationRequest, GenerationEvent } from '@wazir/runtimes-interfaces';

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly id = 'fake-runtime';
  readonly type: 'openai-compatible' | 'other' = 'openai-compatible';

  async discover() {
    return { id: this.id, name: 'Fake Runtime', version: '0.1.0' };
  }

  async healthCheck() {
    return { status: 'healthy', message: 'OK' };
  }

  async listModels() {
    return [
      { id: 'test-model:latest', name: 'Test Model', family: 'qwen', contextWindow: 32768, toolCalling: false, vision: false },
    ];
  }

  async getCapabilities() {
    return {
      chat: true,
      streaming: true,
      toolCalling: false,
      structuredOutput: false,
      vision: false,
      embeddings: false,
      reasoning: false,
      modelLoad: true,
      modelUnload: true,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    };
  }

  async *generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    // Return a deterministic response
    if (request.stream) {
      yield { type: 'token', content: 'Hello' };
      yield { type: 'tool_call', toolCallId: 'call-1', toolName: request.tools?.[0]?.name };
      yield { type: 'completed' };
    } else {
      // Non-streaming: just return completion
      yield { type: 'token', content: 'Hello, world!' };
      yield { type: 'completed' };
    }
  }

  async loadModel?(modelId: string): Promise<void> {
    // No-op for fake
  }

  async unloadModel?(modelId: string): Promise<void> {
    // No-op for fake
  }

  async getLoadedModels?(): Promise<string[]> {
    return ['test-model:latest'];
  }
}

export function createFakeRuntimeAdapter(): RuntimeAdapter {
  return new FakeRuntimeAdapter();
}
