import { describe, it, expect } from 'vitest';
import { createOllamaAdapter } from '@wazir/runtimes-ollama';

describe('Runtime: Ollama Adapter', () => {
  // Verify the Ollama adapter can be instantiated with a URL
  it('createOllamaAdapter returns RuntimeAdapter', async () => {
    const adapter = createOllamaAdapter('http://localhost:11434');
    
    expect(adapter).toBeDefined();
    expect(typeof adapter.discover).toBe('function');
    expect(typeof adapter.healthCheck).toBe('function');
    expect(typeof adapter.listModels).toBe('function');
    expect(typeof adapter.getCapabilities).toBe('function');
    expect(typeof adapter.generate).toBe('function');
  });

  it('Ollama adapter has correct type identifier', async () => {
    const adapter = createOllamaAdapter('http://localhost:11434');
    
    // Type is set at construction time
    expect(adapter.type).toBe('ollama');
  });
});
