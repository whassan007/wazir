import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LimitSpec, Pricing, RoutingPolicyConfig } from '@wazir/core';

export type ModelStartupMode = 'prompt' | 'recommended' | 'restore' | 'none' | 'explicit';

export interface ModelStartupConfig {
  mode?: ModelStartupMode;
  models?: Array<{ modelId: string; computerId?: string; runtimeId?: string; context?: number }>;
}

export interface ModelsConfig {
  startup?: ModelStartupConfig;
}

export interface GoogleProviderConfig {
  /** Google Cloud "Desktop app" OAuth client id — not secret, but there is no
   *  shared/public Wazir client; each operator registers their own
   *  (ai.google.dev/gemini-api/docs/oauth). Required only for `--oauth` login;
   *  API-key auth needs none of this. */
  oauthClientId?: string;
}

export interface NvidiaProviderConfig {
  enabled?: boolean;
  type?: 'openai_compatible';
  baseUrl?: string;
  apiKeyEnv?: string;
  defaultModel?: string;
  models?: string[];
  routing?: {
    eligibleForAuto?: boolean;
    allowFallback?: boolean;
  };
  capabilities?: {
    discoverOnStartup?: boolean;
    refreshPeriodMinutes?: number;
  };
  limits?: LimitSpec[] | {
    maxConcurrentRequests?: number;
    maxRetries?: number;
    maxOutputTokens?: number;
    maxTokens?: number;
    maxRequests?: number;
    maxCostUsd?: number;
    window?: import('@wazir/core').WindowSpec;
  };
  pricing?: Pricing | Record<string, Pricing>;
  privacy?: {
    allowHostedInference?: boolean;
  };
}

export interface ProvidersConfig {
  /** Engine-wide default for PolicyRequirements.allowHostedProviders when a
   *  task/command omits it. Off by default — hosted routing is opt-in. */
  allowHostedProviders?: boolean;
  google?: GoogleProviderConfig;
  nvidia?: NvidiaProviderConfig;
}

export type RoutingConfig = RoutingPolicyConfig;

export interface WazirConfig {
  web?: import('@wazir/core').WebConfig;
  resources?: { memory?: { reservePercent?: number; minimumReserveGiB?: number }; minimumContext?: number; autoContext?: number };
  modelLifecyclePolicy?: import('@wazir/core').PolicyEngineOptions['modelLifecycle'];
  mcp?: { autoConnect?: boolean };
  ollamaUrl?: string;
  lmstudioUrl?: string;
  /** Control-plane API base URL. When set, the engine pulls remote computers/runtimes/models
   * into its registries so the Scheduler can place tasks on them, and dispatches non-local
   * tasks through the API's task-pull loop instead of running everything in-process. */
  apiUrl?: string;
  /** Operator bearer token for the control-plane API (`WAZIR_API_TOKEN`). */
  apiToken?: string;
  /** Cluster registration token for workers (`WAZIR_REGISTRATION_TOKEN`). */
  registrationToken?: string;
  /** Per-model context window overrides (tokens). */
  modelContext: Record<string, number>;
  /** Per-model extra capability tags. */
  modelCapabilities: Record<string, string[]>;
  /** Model readiness and startup behavior. */
  models?: ModelsConfig;
  networkAllowed: boolean;
  allowCommands: string[];
  denyCommands: string[];
  allowedMcpServers: string[];
  /** Hosted-provider (Anthropic/OpenAI/Google/NVIDIA) routing configuration. */
  providers?: ProvidersConfig;
  /** Deterministic model placement and provider-only routing policy. */
  routing?: RoutingConfig;
  /** Context compaction and token optimization settings. */
  context?: import('@wazir/core').ContextConfig;
}

export function validateRoutingConfig(raw: unknown, _source?: string): RoutingConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid routing config: expected an object');
  }
  const obj = raw as Record<string, unknown>;
  const rawMode = typeof obj.mode === 'string' ? obj.mode.trim().toLowerCase() : 'auto';
  const validModes = new Set(['provider_only', 'auto', 'local_only', 'hybrid', 'nvidia']);
  if (!validModes.has(rawMode)) {
    throw new Error(`Invalid routing.mode '${String(obj.mode)}': must be one of provider_only, auto, local_only, hybrid`);
  }
  const mode: RoutingConfig['mode'] = rawMode === 'nvidia' ? 'provider_only' : (rawMode as RoutingConfig['mode']);
  const provider =
    typeof obj.provider === 'string' && obj.provider.trim()
      ? obj.provider.trim().toLowerCase()
      : rawMode === 'nvidia'
      ? 'nvidia'
      : undefined;
  if (mode === 'provider_only' && !provider) {
    throw new Error("Invalid routing config: routing.provider is required when routing.mode is 'provider_only'");
  }
  const defaultModel =
    typeof obj.defaultModel === 'string' && obj.defaultModel.trim() ? obj.defaultModel.trim() : undefined;
  if (obj.allowFallback !== undefined && typeof obj.allowFallback !== 'boolean') {
    throw new Error('Invalid routing.allowFallback: expected a boolean');
  }
  const allowFallback = obj.allowFallback as boolean | undefined;
  return {
    mode,
    ...(provider ? { provider } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(allowFallback !== undefined ? { allowFallback } : {}),
  };
}

export function buildNvidiaHostedLimits(nvidia?: NvidiaProviderConfig): LimitSpec[] | undefined {
  const lim = nvidia?.limits;
  if (!lim) return undefined;
  if (Array.isArray(lim)) {
    return lim.map((item) => ({
      unit: item.unit,
      window: item.window === 'daily' ? 'day' : item.window,
      limit: item.limit,
      source: item.source ?? 'configured',
      hard: item.hard,
      thresholds: item.thresholds,
      note: item.note,
    }));
  }
  const rawWin = lim.window ?? 'day';
  const window: import('@wazir/core').WindowSpec = rawWin === 'daily' ? 'day' : rawWin;
  const specs: LimitSpec[] = [];
  if (typeof lim.maxTokens === 'number' && Number.isFinite(lim.maxTokens) && lim.maxTokens > 0) {
    specs.push({ window, unit: 'tokens', limit: lim.maxTokens, source: 'configured' });
  }
  if (typeof lim.maxRequests === 'number' && Number.isFinite(lim.maxRequests) && lim.maxRequests > 0) {
    specs.push({ window, unit: 'requests', limit: lim.maxRequests, source: 'configured' });
  }
  if (typeof lim.maxCostUsd === 'number' && Number.isFinite(lim.maxCostUsd) && lim.maxCostUsd > 0) {
    specs.push({ window, unit: 'cost_usd', limit: lim.maxCostUsd, source: 'configured' });
  }
  return specs.length > 0 ? specs : undefined;
}

export function configDir(): string {
  if (process.env.WAZIR_HOME) return process.env.WAZIR_HOME;
  if (process.env.ROOK_HOME) {
    console.warn('[DEPRECATION] ROOK_HOME is deprecated; use WAZIR_HOME.');
    return process.env.ROOK_HOME;
  }
  const defaultWazir = path.join(os.homedir(), '.wazir');
  const legacyRook = path.join(os.homedir(), '.rook');
  return existsSync(defaultWazir) || !existsSync(legacyRook) ? defaultWazir : legacyRook;
}

export function configFile(): string {
  return path.join(configDir(), 'config.json');
}

export function loadEnvFiles(): void {
  const envPaths = [
    path.join(configDir(), '.env'),
    path.join(process.cwd(), '.env'),
  ];

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    } catch {
      // ignore read errors
    }
  }
}

export function loadConfig(): WazirConfig {
  loadEnvFiles();
  const defaults: WazirConfig = {
    modelContext: {},
    modelCapabilities: {},
    networkAllowed: false,
    allowCommands: [],
    denyCommands: [],
    allowedMcpServers: [],
  };

  const config: WazirConfig = { ...defaults, modelContext: {}, modelCapabilities: {} };

  const ollamaUrl = process.env.WAZIR_OLLAMA_URL ?? process.env.ROOK_OLLAMA_URL;
  if (process.env.ROOK_OLLAMA_URL && !process.env.WAZIR_OLLAMA_URL) {
    console.warn('[DEPRECATION] ROOK_OLLAMA_URL is deprecated; use WAZIR_OLLAMA_URL.');
  }
  if (ollamaUrl) config.ollamaUrl = ollamaUrl;

  const lmstudioUrl = process.env.WAZIR_LMSTUDIO_URL ?? process.env.ROOK_LMSTUDIO_URL;
  if (process.env.ROOK_LMSTUDIO_URL && !process.env.WAZIR_LMSTUDIO_URL) {
    console.warn('[DEPRECATION] ROOK_LMSTUDIO_URL is deprecated; use WAZIR_LMSTUDIO_URL.');
  }
  if (lmstudioUrl) config.lmstudioUrl = lmstudioUrl;

  const apiUrl = process.env.WAZIR_API_URL ?? process.env.ROOK_API_URL;
  if (process.env.ROOK_API_URL && !process.env.WAZIR_API_URL) {
    console.warn('[DEPRECATION] ROOK_API_URL is deprecated; use WAZIR_API_URL.');
  }
  if (apiUrl) config.apiUrl = apiUrl;
  if (process.env.WAZIR_API_TOKEN) config.apiToken = process.env.WAZIR_API_TOKEN;
  if (process.env.WAZIR_REGISTRATION_TOKEN) config.registrationToken = process.env.WAZIR_REGISTRATION_TOKEN;

  const envStartupMode = (process.env.WAZIR_MODEL_STARTUP_MODE || process.env.ROOK_MODEL_STARTUP_MODE) as ModelStartupMode | undefined;
  if (envStartupMode) {
    config.models = { startup: { mode: envStartupMode } };
  }

  if (process.env.WAZIR_ALLOW_HOSTED_PROVIDERS === '1') {
    config.providers = { ...config.providers, allowHostedProviders: true };
  }
  if (process.env.WAZIR_GOOGLE_OAUTH_CLIENT_ID) {
    config.providers = {
      ...config.providers,
      google: { ...config.providers?.google, oauthClientId: process.env.WAZIR_GOOGLE_OAUTH_CLIENT_ID },
    };
  }
  if (process.env.WAZIR_NVIDIA_BASE_URL || process.env.WAZIR_NVIDIA_DEFAULT_MODEL || process.env.NVIDIA_API_KEY) {
    config.providers = {
      ...config.providers,
      nvidia: {
        enabled: true,
        type: 'openai_compatible',
        baseUrl: process.env.WAZIR_NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
        apiKeyEnv: 'NVIDIA_API_KEY',
        defaultModel: process.env.WAZIR_NVIDIA_DEFAULT_MODEL ?? 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        ...config.providers?.nvidia,
      },
    };
  }

  try {
    const raw = readFileSync(configFile(), 'utf8');
    const fileConfig = JSON.parse(raw) as Partial<WazirConfig>;
    config.resources = fileConfig.resources;
    config.web = fileConfig.web;
    config.modelLifecyclePolicy = fileConfig.modelLifecyclePolicy;
    // Environment overrides config.json: `wa init` writes localhost URLs to the file, and
    // the documented container setup relies on WAZIR_*_URL pointing elsewhere.
    config.ollamaUrl = ollamaUrl ?? fileConfig.ollamaUrl ?? config.ollamaUrl;
    config.lmstudioUrl = lmstudioUrl ?? fileConfig.lmstudioUrl ?? config.lmstudioUrl;
    config.apiUrl = apiUrl ?? fileConfig.apiUrl ?? config.apiUrl;
    config.apiToken = process.env.WAZIR_API_TOKEN ?? fileConfig.apiToken ?? config.apiToken;
    config.registrationToken = process.env.WAZIR_REGISTRATION_TOKEN ?? fileConfig.registrationToken ?? config.registrationToken;
    config.modelContext = { ...config.modelContext, ...(fileConfig.modelContext ?? {}) };
    config.modelCapabilities = { ...config.modelCapabilities, ...(fileConfig.modelCapabilities ?? {}) };
    if (fileConfig.models) {
      config.models = {
        ...config.models,
        startup: {
          ...config.models?.startup,
          ...fileConfig.models.startup,
        },
      };
    }
    config.networkAllowed = fileConfig.networkAllowed ?? config.networkAllowed;
    config.allowCommands = fileConfig.allowCommands ?? config.allowCommands;
    config.denyCommands = fileConfig.denyCommands ?? config.denyCommands;
    config.mcp = fileConfig.mcp ?? { autoConnect: true };
    config.allowedMcpServers = fileConfig.allowedMcpServers ?? config.allowedMcpServers;
    if (fileConfig.providers) {
      const mergedNvidia: NvidiaProviderConfig | undefined =
        config.providers?.nvidia || fileConfig.providers.nvidia
          ? {
              ...config.providers?.nvidia,
              ...fileConfig.providers.nvidia,
              ...(process.env.WAZIR_NVIDIA_BASE_URL ? { baseUrl: process.env.WAZIR_NVIDIA_BASE_URL } : {}),
              ...(process.env.WAZIR_NVIDIA_DEFAULT_MODEL ? { defaultModel: process.env.WAZIR_NVIDIA_DEFAULT_MODEL } : {}),
            }
          : undefined;
      const allowHosted =
        process.env.WAZIR_ALLOW_HOSTED_PROVIDERS === '1'
          ? true
          : (fileConfig.providers.allowHostedProviders ??
             fileConfig.providers.nvidia?.privacy?.allowHostedInference ??
             config.providers?.allowHostedProviders);
      config.providers = {
        ...config.providers,
        ...fileConfig.providers,
        ...(allowHosted !== undefined ? { allowHostedProviders: allowHosted } : {}),
        google: { ...config.providers?.google, ...fileConfig.providers.google },
        ...(mergedNvidia ? { nvidia: mergedNvidia } : {}),
      };
    }
    if (fileConfig.routing) {
      config.routing = validateRoutingConfig(fileConfig.routing);
    }
    if (fileConfig.context) {
      config.context = fileConfig.context;
    }
  } catch {
    // no config file or invalid JSON — defaults + env win
  }

  // Env overrides for provider-only / routing configuration
  if (process.env.WAZIR_NVIDIA_ONLY === '1' || process.env.WAZIR_ROUTING_MODE) {
    const envMode = process.env.WAZIR_NVIDIA_ONLY === '1' ? 'provider_only' : process.env.WAZIR_ROUTING_MODE!;
    const envProvider =
      process.env.WAZIR_NVIDIA_ONLY === '1'
        ? 'nvidia'
        : (process.env.WAZIR_ROUTING_PROVIDER ?? config.routing?.provider ?? (envMode.toLowerCase() === 'nvidia' ? 'nvidia' : undefined));
    config.routing = validateRoutingConfig({
      ...config.routing,
      mode: envMode,
      provider: envProvider,
      defaultModel:
        process.env.WAZIR_NVIDIA_DEFAULT_MODEL ??
        config.routing?.defaultModel ??
        config.providers?.nvidia?.defaultModel,
      allowFallback:
        process.env.WAZIR_ROUTING_ALLOW_FALLBACK !== undefined
          ? process.env.WAZIR_ROUTING_ALLOW_FALLBACK === '1'
          : (config.routing?.allowFallback ?? (process.env.WAZIR_NVIDIA_ONLY === '1' ? false : undefined)),
    });
  }

  // When routing.mode === 'provider_only' for nvidia, ensure providers.nvidia is enabled and defaultModel is aligned
  if (config.routing?.mode === 'provider_only' && config.routing.provider === 'nvidia') {
    const defaultModel =
      config.routing.defaultModel ??
      config.providers?.nvidia?.defaultModel ??
      process.env.WAZIR_NVIDIA_DEFAULT_MODEL ??
      'nvidia/nemotron-3.5-super-vl-120b-a12b';
    config.routing.defaultModel = defaultModel;
    config.providers = {
      ...config.providers,
      allowHostedProviders: config.providers?.allowHostedProviders ?? true,
      nvidia: {
        enabled: true,
        type: 'openai_compatible',
        baseUrl: process.env.WAZIR_NVIDIA_BASE_URL ?? config.providers?.nvidia?.baseUrl ?? 'https://integrate.api.nvidia.com/v1',
        apiKeyEnv: config.providers?.nvidia?.apiKeyEnv ?? 'NVIDIA_API_KEY',
        defaultModel,
        ...config.providers?.nvidia,
      },
    };
  }

  // Ensure default mode is 'prompt' if not set
  if (!config.models?.startup?.mode) {
    config.models = {
      ...config.models,
      startup: {
        ...config.models?.startup,
        mode: 'prompt',
      },
    };
  }

  return config;
}
