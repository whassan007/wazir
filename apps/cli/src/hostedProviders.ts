import {
  type ModelCapability,
  type ModelRecord,
  type ModelRegistry,
  type RuntimeRegistry,
} from '@wazir/core';
import { createAnthropicAdapter } from '@wazir/runtimes-anthropic';
import { createGoogleAdapter } from '@wazir/runtimes-google';
import { createNvidiaAdapter, inferNvidiaModelMetadata, NVIDIA_DEFAULT_BASE_URL, NVIDIA_DEFAULT_MODEL_ID } from '@wazir/runtimes-nvidia';
import { createOpenAIAdapter } from '@wazir/runtimes-openai';
import type { DiscoveredModel, ProviderAuthAdapter, ProviderId, RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { SecretBroker } from '@wazir/secrets';
import type { WazirConfig } from './config.js';

export type HostedAdapter = RuntimeAdapter & ProviderAuthAdapter;

export const PROVIDER_DISPLAY_NAME: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  nvidia: 'NVIDIA API Catalog',
};

export function createHostedProviders(config: WazirConfig, secrets: SecretBroker): Map<ProviderId, HostedAdapter> {
  const nvidiaCfg = config.providers?.nvidia;
  return new Map<ProviderId, HostedAdapter>([
    ['anthropic', createAnthropicAdapter(secrets)],
    ['openai', createOpenAIAdapter(secrets)],
    [
      'google',
      createGoogleAdapter(secrets, {
        clientId: config.providers?.google?.oauthClientId ?? process.env.WAZIR_GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: process.env.WAZIR_GOOGLE_OAUTH_CLIENT_SECRET,
      }),
    ],
    [
      'nvidia',
      createNvidiaAdapter({
        secrets,
        baseURL: nvidiaCfg?.baseUrl ?? process.env.WAZIR_NVIDIA_BASE_URL ?? NVIDIA_DEFAULT_BASE_URL,
        apiKeyEnv: nvidiaCfg?.apiKeyEnv ?? 'NVIDIA_API_KEY',
        defaultModel: nvidiaCfg?.defaultModel ?? process.env.WAZIR_NVIDIA_DEFAULT_MODEL ?? NVIDIA_DEFAULT_MODEL_ID,
        configuredModels: nvidiaCfg?.models,
        defaultMaxOutputTokens: nvidiaCfg?.limits?.maxOutputTokens,
        discoverModelsRemote: nvidiaCfg?.capabilities?.discoverOnStartup ?? true,
      }),
    ],
  ]);
}

function guessHostedFamily(provider: ProviderId, discovered: DiscoveredModel): ModelRecord['family'] {
  if (discovered.family) {
    const f = discovered.family.toLowerCase();
    if (f === 'llama' || f === 'qwen' || f === 'deepseek' || f === 'mistral' || f === 'gemma' || f === 'gpt' || f === 'nemotron') {
      return f as ModelRecord['family'];
    }
  }
  const lower = discovered.id.toLowerCase();
  if (lower.includes('nemotron')) return 'nemotron';
  if (lower.includes('llama')) return 'llama';
  if (lower.includes('qwen')) return 'qwen';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('mistral') || lower.includes('mixtral')) return 'mistral';
  if (lower.includes('gemma')) return 'gemma';
  return provider === 'openai' ? 'gpt' : 'other';
}

function registerHostedModel(models: ModelRegistry, provider: ProviderId, discovered: DiscoveredModel, config: WazirConfig): void {
  const capabilities: ModelCapability[] = ['generalChat', ...(discovered.capabilities ?? []), ...(config.modelCapabilities[discovered.id] ?? [])] as ModelCapability[];
  if (discovered.toolCalling) capabilities.push('toolCalling');
  if (discovered.reasoning) capabilities.push('reasoning');
  if (discovered.vision) capabilities.push('vision');
  if (discovered.embedding) capabilities.push('embedding');
  if (discovered.structuredOutput) capabilities.push('structuredOutput');

  const configured = config.modelContext[discovered.id];
  const contextMax = configured ?? discovered.contextWindow ?? 32_768;

  const record: ModelRecord = {
    id: discovered.id,
    name: discovered.name ?? discovered.id,
    provider,
    family: guessHostedFamily(provider, discovered),
    architecture: discovered.architecture,
    parameters: discovered.parameters,
    contextMax,
    configuredContext: configured,
    capabilities: Array.from(new Set(capabilities)),
    toolCalling: discovered.toolCalling ?? false,
    structuredOutput: discovered.structuredOutput ?? false,
    vision: discovered.vision ?? false,
    audio: discovered.audio ?? false,
    embedding: discovered.embedding ?? false,
    reasoning: discovered.reasoning ?? false,
    quantization: discovered.quantization,
    // Hosted providers have no local hardware footprint to size for.
    runtimeCompatibility: [provider],
    local: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  models.register(record);

  models.upsertInstance({
    // No computerId segment — a hosted instance has no Computer affinity.
    id: `${discovered.id}::hosted::${provider}`,
    modelId: discovered.id,
    runtimeId: provider,
    runtimeModelId: discovered.id,
    loaded: true, // hosted inference has no "load" step; always "ready" once authenticated
    state: 'READY',
    health: 'healthy',
    contextTokens: contextMax,
  });
}

/**
 * Registers one hosted provider's runtime (and, if authenticated, its
 * models) into the engine's live registries — the hosted-provider analog of
 * `engine.ts`'s `applyDiscoveredRuntime()`. Deliberately never touches
 * `ComputerRegistry` or `Worker` (see the "no fake Computers/Workers for
 * hosted providers" constraint): a hosted runtime is registered with
 * `runtimeKind: 'hosted'` and its model instances carry no `computerId`.
 *
 * `adapter.status()` is used here, not `healthCheck()` — status() is
 * local-only (reads the Secret Broker / env var, no network call), so authenticating
 * hosted providers never adds network latency to every `wa` command's
 * startup path. A real reachability probe only happens in `wa doctor` or `wa providers test`.
 */
export async function applyHostedProvider(
  provider: ProviderId,
  adapter: HostedAdapter,
  deps: { runtimes: RuntimeRegistry; models: ModelRegistry; config: WazirConfig },
): Promise<void> {
  const { runtimes, models, config } = deps;
  if (provider === 'nvidia' && config.providers?.nvidia?.enabled === false) {
    for (const instance of models.instancesForRuntime(provider)) {
      models.setInstanceState(instance.id, 'UNAVAILABLE', { health: 'unavailable' });
    }
    return;
  }

  const status = await adapter.status();
  const capabilities = await adapter.getCapabilities();
  const info = await adapter.discover().catch(() => ({ id: provider, name: PROVIDER_DISPLAY_NAME[provider], version: 'v1', url: undefined }));

  runtimes.register({
    id: provider,
    type: provider,
    name: PROVIDER_DISPLAY_NAME[provider],
    version: info.version ?? 'v1',
    url: info.url,
    runtimeKind: 'hosted',
    capabilities,
  });
  runtimes.update(provider, { health: status.authenticated && status.eligible ? 'healthy' : 'unavailable' });

  if (!status.authenticated || !status.eligible) {
    for (const instance of models.instancesForRuntime(provider)) {
      models.setInstanceState(instance.id, 'UNAVAILABLE', { health: 'unavailable' });
    }
    return;
  }

  let discovered: DiscoveredModel[] = [];
  try {
    discovered = await adapter.discoverModels();
  } catch {
    runtimes.update(provider, { health: 'degraded' });
    return;
  }

  // The configured default is a release contract: a provider's remote catalog
  // must not make the stable default disappear from local routing.
  if (provider === 'nvidia') {
    const defaultModel = (adapter as any).getDefaultModel?.() ?? NVIDIA_DEFAULT_MODEL_ID;
    if (!discovered.some((model) => model.id === defaultModel)) {
      const meta = inferNvidiaModelMetadata(defaultModel);
      discovered.unshift({
        id: meta.id,
        name: meta.name,
        family: meta.family,
        contextWindow: meta.contextWindow,
        maxOutputTokens: meta.maxOutputTokens,
        capabilities: meta.capabilities,
        toolCalling: meta.toolCalling,
        structuredOutput: meta.structuredOutput,
        vision: meta.vision,
        audio: meta.audio,
        embedding: meta.embedding,
        reasoning: meta.reasoning,
      });
    }
  }

  if (discovered.length === 0) {
    runtimes.update(provider, { health: 'degraded' });
    return;
  }

  for (const model of discovered) {
    registerHostedModel(models, provider, model, config);
  }
}
