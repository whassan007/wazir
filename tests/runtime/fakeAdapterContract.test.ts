import { describe, it, expect } from 'vitest';
import { runRuntimeAdapterContractSuite } from './adapterContract.suite.js';
import { FakeRuntimeAdapter } from '../fakes/runtime.js';
import { executeRequest } from '@wazir/workers';

class OfflineFakeAdapter extends FakeRuntimeAdapter {
  override async healthCheck() {
    return { status: 'unavailable' as const, message: 'Simulated runtime offline' };
  }
  override async *generate(): AsyncIterable<any> {
    throw new Error('Connection refused: runtime offline');
  }
}

class DisconnectingFakeAdapter extends FakeRuntimeAdapter {
  override async *generate(): AsyncIterable<any> {
    yield { type: 'token', content: 'Starting...' };
    throw new Error('Socket closed unexpectedly');
  }
}

runRuntimeAdapterContractSuite({
  name: 'FakeRuntimeAdapter',
  createAdapter: () => new FakeRuntimeAdapter(),
  expectedType: 'openai-compatible',
  simulateFailure: {
    createOfflineAdapter: () => new OfflineFakeAdapter(),
    createDisconnectingAdapter: () => new DisconnectingFakeAdapter(),
  },
});

describe('Runtime Failure Injection: Model Unload / No Silent Fallback', () => {
  it('does not silently fall back to an alternate model when target model is unavailable', async () => {
    class ModelCheckingFakeAdapter extends FakeRuntimeAdapter {
      override async *generate(req: any): AsyncIterable<any> {
        if (req.modelId !== 'test-model:latest') {
          yield { type: 'error', error: `Model '${req.modelId}' is not loaded` };
          return;
        }
        yield { type: 'token', content: 'OK' };
        yield { type: 'completed' };
      }
    }

    const adapter = new ModelCheckingFakeAdapter();
    const outcome = await executeRequest(adapter, {
      taskId: 'unload-task',
      modelId: 'missing-model',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("Model 'missing-model' is not loaded");
    // Explicit assertion: must NOT silently succeed or switch models
    expect(outcome.output).not.toBe('OK');
  });
});
