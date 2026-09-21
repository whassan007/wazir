import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ModelStartupMode = 'prompt' | 'recommended' | 'restore' | 'none';

export interface ModelStartupConfig {
  mode?: ModelStartupMode;
}

export interface ModelsConfig {
  startup?: ModelStartupConfig;
}

export interface WazirConfig {
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

  try {
    const raw = readFileSync(configFile(), 'utf8');
    const fileConfig = JSON.parse(raw) as Partial<WazirConfig>;
    config.ollamaUrl = fileConfig.ollamaUrl ?? config.ollamaUrl;
    config.lmstudioUrl = fileConfig.lmstudioUrl ?? config.lmstudioUrl;
    config.apiUrl = fileConfig.apiUrl ?? config.apiUrl;
    config.apiToken = fileConfig.apiToken ?? config.apiToken;
    config.registrationToken = fileConfig.registrationToken ?? config.registrationToken;
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
    config.allowedMcpServers = fileConfig.allowedMcpServers ?? config.allowedMcpServers;
  } catch {
    // no config file — defaults + env win
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
