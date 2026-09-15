import { createOllamaAdapter } from '@rook/runtimes-ollama';
import { createLMStudioAdapter } from '@rook/runtimes-lmstudio';

export interface HardwareInfo {
  cpu: string;
  memoryGB: number;
  gpu?: {
    vendor: 'apple' | 'nvidia' | 'amd' | 'intel';
    model: string;
    memoryGB: number;
    unifiedMemory?: boolean;
    cuda?: boolean;
  };
}

export interface OSInfo {
  platform: 'darwin' | 'linux' | 'win32';
  architecture: string;
  version: string;
}

export class HardwareDiscovery {
  async discover(): Promise<HardwareInfo> {
    return {
      cpu: this.getCPUInfo(),
      memoryGB: this.getMemoryGB(),
      gpu: await this.getGPUInfo()
    };
  }

  private getCPUInfo(): string {
    // Implementation would use os.cpus() and platform-specific queries
    return 'Intel Core i9-13900K';
  }

  private getMemoryGB(): number {
    // Implementation would read from OS memory info
    return 64;
  }

  private async getGPUInfo(): Promise<HardwareInfo['gpu'] | undefined> {
    // Implementation would query GPU vendor, model, and memory
    return {
      vendor: 'nvidia',
      model: 'RTX 4090',
      memoryGB: 24,
      cuda: true
    };
  }
}

export class RuntimeDiscovery {
  async discover(): Promise<string[]> {
    const availableRuntimes: string[] = [];
    
    try {
      const ollama = createOllamaAdapter();
      await ollama.healthCheck();
      availableRuntimes.push('ollama');
    } catch {
      // Ollama not available
    }

    try {
      const lmstudio = createLMStudioAdapter();
      await lmstudio.healthCheck();
      availableRuntimes.push('lmstudio');
    } catch {
      // LM Studio not available
    }

    return availableRuntimes;
  }
}

export class ModelDiscovery {
  async discover(runtimeId: string): Promise<any[]> {
    const adapter = runtimeId === 'ollama' 
      ? createOllamaAdapter() 
      : createLMStudioAdapter();

    try {
      const models = await adapter.listModels();
      return models.map(m => ({
        ...m,
        runtime: runtimeId
      }));
    } catch {
      return [];
    }
  }
}

export class CapabilityDiscovery {
  async discover(runtimeId: string, modelId: string): Promise<string[]> {
    const adapter = runtimeId === 'ollama' 
      ? createOllamaAdapter() 
      : createLMStudioAdapter();

    try {
      const capabilities = await adapter.getCapabilities();
      
      // Map runtime capabilities to normalized capability taxonomy
      return this.mapCapabilities(capabilities);
    } catch {
      return [];
    }
  }

  private mapCapabilities(runtimeCapabilities: any): string[] {
    const mapping: Record<string, string[]> = {
      chat: ['general_chat'],
      streaming: [],
      tool_calling: ['tool_calling'],
      structured_output: ['structured_output'],
      vision: ['vision'],
      embeddings: ['embedding'],
      reasoning: ['reasoning']
    };

    const result: string[] = [];

    for (const [key, capabilities] of Object.entries(mapping)) {
      if (runtimeCapabilities[key as keyof typeof runtimeCapabilities]) {
        result.push(...capabilities);
      }
    }

    return result;
  }
}

export async function discoverAll(): Promise<any> {
  const hardwareDiscovery = new HardwareDiscovery();
  const runtimeDiscovery = new RuntimeDiscovery();
  const modelDiscovery = new ModelDiscovery();
  const capabilityDiscovery = new CapabilityDiscovery();

  const [hardware, runtimes] = await Promise.all([
    hardwareDiscovery.discover(),
    runtimeDiscovery.discover()
  ]);

  const models: any[] = [];
  for (const runtime of runtimes) {
    const runtimeModels = await modelDiscovery.discover(runtime);
    models.push(...runtimeModels);

    // Discover capabilities for each model
    for (const model of runtimeModels) {
      const capabilities = await capabilityDiscovery.discover(runtime, model.id);
      model.capabilities = capabilities;
    }
  }

  return {
    hardware,
    runtimes,
    models
  };
}
