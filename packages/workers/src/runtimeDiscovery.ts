import type {
  DiscoveredModel,
  HealthStatus,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeInfo,
} from '@rook/runtimes-interfaces';
import { createOllamaAdapter } from '@rook/runtimes-ollama';
import { createLMStudioAdapter } from '@rook/runtimes-lmstudio';

export interface DiscoveredRuntime {
  id: string;
  info: RuntimeInfo;
  capabilities: RuntimeCapabilities;
  health: HealthStatus['status'];
  healthMessage?: string;
  models: DiscoveredModel[];
  adapter: RuntimeAdapter;
}

export interface AdapterConfig {
  ollamaUrl?: string;
  lmstudioUrl?: string;
  /** Extra adapters (e.g. remote runtimes) are appended as-is. */
  extra?: RuntimeAdapter[];
}

export function defaultAdapters(config: AdapterConfig = {}): RuntimeAdapter[] {
  const ollamaUrl = config.ollamaUrl ?? process.env.ROOK_OLLAMA_URL ?? 'http://localhost:11434';
  const lmstudioUrl = config.lmstudioUrl ?? process.env.ROOK_LMSTUDIO_URL ?? 'http://localhost:1234/v1';
  return [
    createOllamaAdapter(ollamaUrl),
    createLMStudioAdapter(lmstudioUrl),
    ...(config.extra ?? []),
  ];
}

const NO_CAPABILITIES: RuntimeCapabilities = {
  chat: false,
  streaming: false,
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

/**
 * Probes a set of runtime adapters and reports their real state.
 * Discovery never invents runtimes: unreachable adapters are reported as unavailable.
 */
export async function discoverRuntimes(adapters: RuntimeAdapter[]): Promise<DiscoveredRuntime[]> {
  const results: DiscoveredRuntime[] = [];

  for (const adapter of adapters) {
    let info: RuntimeInfo = { id: adapter.id, name: adapter.id, version: 'unknown' };
    let capabilities: RuntimeCapabilities = NO_CAPABILITIES;
    let health: HealthStatus['status'] = 'unavailable';
    let healthMessage: string | undefined;
    let models: DiscoveredModel[] = [];

    try {
      capabilities = await adapter.getCapabilities();
    } catch {
      // static capabilities should not fail; keep defaults
    }

    try {
      info = await adapter.discover();
      const check = await adapter.healthCheck();
      health = check.status;
      healthMessage = check.message;
      if (health === 'healthy' || health === 'degraded') {
        models = await adapter.listModels().catch(() => []);
      }
    } catch (error) {
      health = 'unavailable';
      healthMessage = error instanceof Error ? error.message : 'unreachable';
    }

    results.push({ id: adapter.id, info, capabilities, health, healthMessage, models, adapter });
  }

  return results.sort((a, b) => a.id.localeCompare(b.id));
}
