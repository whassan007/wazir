import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  InferenceEndpointConfig,
  RoutingStrategy,
  WazirUbuntuSettings,
} from './contracts.js';

export const DEFAULT_UBUNTU_SETTINGS: WazirUbuntuSettings = {
  shellMode: 'auto',
  activeBackendId: 'wazir-native',
  routingStrategy: 'capability-aware',
  localOnly: false,
  activeProviderId: 'ollama',
  voice: {
    pushToTalkShortcut: 'Super+Alt+V',
    sttBackend: 'whisper.cpp',
    ttsBackend: 'piper',
    ttsEnabled: false,
    microphoneDevice: 'default',
    voiceName: 'en_US-lessac-medium',
  },
  approvalPolicy: 'request-review',
};

export const DEFAULT_INFERENCE_ENDPOINTS: InferenceEndpointConfig[] = [
  {
    id: 'ollama',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    local: true,
    enabled: true,
    contextWindow: 32768,
    temperature: 0.2,
  },
  {
    id: 'lmstudio',
    kind: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    local: true,
    enabled: true,
    contextWindow: 32768,
    temperature: 0.2,
  },
  {
    id: 'llama.cpp',
    kind: 'llama.cpp',
    baseUrl: 'http://127.0.0.1:8081/v1',
    local: true,
    enabled: true,
    contextWindow: 16384,
    temperature: 0.2,
  },
  {
    id: 'vllm',
    kind: 'vllm',
    baseUrl: 'http://127.0.0.1:8000/v1',
    local: true,
    enabled: false,
    contextWindow: 65536,
    temperature: 0.2,
  },
];

export function defaultUbuntuSettingsPath(): string {
  const home = process.env.WAZIR_HOME?.trim() || path.join(os.homedir(), '.wazir');
  return path.join(home, 'ubuntu-settings.json');
}

export function loadUbuntuSettings(filePath = defaultUbuntuSettingsPath()): WazirUbuntuSettings {
  try {
    if (!fs.existsSync(filePath)) return structuredClone(DEFAULT_UBUNTU_SETTINGS);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<WazirUbuntuSettings>;
    return {
      ...DEFAULT_UBUNTU_SETTINGS,
      ...parsed,
      voice: {
        ...DEFAULT_UBUNTU_SETTINGS.voice,
        ...(parsed.voice ?? {}),
      },
    };
  } catch {
    return structuredClone(DEFAULT_UBUNTU_SETTINGS);
  }
}

export function saveUbuntuSettings(
  settings: WazirUbuntuSettings,
  filePath = defaultUbuntuSettingsPath(),
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

export function selectEndpointByStrategy(
  endpoints: InferenceEndpointConfig[],
  strategy: RoutingStrategy,
  localOnly: boolean,
  preferredId?: string,
): InferenceEndpointConfig | null {
  const eligible = endpoints.filter((e) => e.enabled && (!localOnly && strategy !== 'local-only' ? true : e.local));
  if (eligible.length === 0) return null;

  if ((strategy === 'fixed' || preferredId) && preferredId) {
    const exact = eligible.find((e) => e.id === preferredId);
    if (exact) return exact;
  }
  if (strategy === 'fastest-local' || strategy === 'local-only') {
    const local = eligible.filter((e) => e.local);
    if (local.length > 0) return local[0];
  }
  return eligible[0];
}
