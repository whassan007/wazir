import { describe, it, expect } from 'vitest';
import { createLMStudioAdapter } from '@wazir/runtimes-lmstudio';

describe('Runtime: LM Studio Adapter', () => {
  // Verify the LM Studio adapter can be instantiated with a URL
  it('createLMStudioAdapter returns RuntimeAdapter', async () => {
    const adapter = createLMStudioAdapter('http://localhost:1234/v1');
    
    expect(adapter).toBeDefined();
    expect(typeof adapter.discover).toBe('function');
    expect(typeof adapter.healthCheck).toBe('function');
    expect(typeof adapter.listModels).toBe('function');
    expect(typeof adapter.getCapabilities).toBe('function');
    expect(typeof adapter.generate).toBe('function');
  });

  it('LM Studio adapter has correct type identifier', async () => {
    const adapter = createLMStudioAdapter('http://localhost:1234/v1');
    
    // Type is set at construction time
    expect(adapter.type).toBe('lmstudio');
  });
});
