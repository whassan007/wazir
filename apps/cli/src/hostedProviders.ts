import {
  type ModelCapability,
  type ModelRecord,
  type ModelRegistry,
  type RuntimeRegistry,
} from '@wazir/core';
import { createAnthropicAdapter } from '@wazir/runtimes-anthropic';
import { createGoogleAdapter } from '@wazir/runtimes-google';
import { createOpenAIAdapter } from '@wazir/runtimes-openai';
import type { DiscoveredModel, ProviderAuthAdapter, ProviderId, RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { SecretBroker } from '@wazir/secrets';
import type { WazirConfig } from './config.js';

export type HostedAdapter = RuntimeAdapter & ProviderAuthAdapter;

const PROVIDER_DISPLAY_NAME: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
};

export function createHostedProviders(config: WazirConfig, secrets: SecretBroker): Map<ProviderId, HostedAdapter> {
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
  ]);
}

function guessHostedFamily(provider: ProviderId): ModelRecord['family'] {
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
    family: guessHostedFamily(provider),
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
 * local-only (reads the Secret Broker, no network call), so authenticating
 * three extra providers never adds network latency to every `wa` command's
 * startup path. A real reachability probe only happens in `wa doctor`.
 */
export async function applyHostedProvider(
  provider: ProviderId,
  adapter: HostedAdapter,
  deps: { runtimes: RuntimeRegistry; models: ModelRegistry; config: WazirConfig },
): Promise<void> {
  const { runtimes, models, config } = deps;
  const status = await adapter.status();
  const capabilities = await adapter.getCapabilities();

  runtimes.register({
    id: provider,
    type: provider,
    name: PROVIDER_DISPLAY_NAME[provider],
    version: 'v1',
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

  // The adapters' own discoverModels() swallows transient network/API
  // failures into an empty array rather than throwing (matching the
  // existing LM Studio/Ollama adapter convention) — so an authenticated but
  // currently-unreachable provider would otherwise still show 'healthy' with
  // zero models, which is misleading in `wa status`/`wa doctor`. Treat that
  // the same as the throw path above: authenticated credential, but nothing
  // usable came back.
  if (discovered.length === 0) {
    runtimes.update(provider, { health: 'degraded' });
    return;
  }

  for (const model of discovered) {
    registerHostedModel(models, provider, model, config);
  }
}
