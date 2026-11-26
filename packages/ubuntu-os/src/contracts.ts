/**
 * Wazir OS (Ubuntu 26.04.1 LTS) Shared Contracts (v1.0.0)
 * Agent 01 — Interface Stabilization
 */

export const UBUNTU_OS_CONTRACT_VERSION = '1.0.0' as const;

export type ShellMode = 'auto' | 'shell' | 'ai';

export type InputClassificationKind =
  | 'empty'
  | 'mode-switch'
  | 'forced-shell'
  | 'forced-ai'
  | 'shell-builtin'
  | 'shell-syntax'
  | 'shell-executable'
  | 'natural-language'
  | 'ambiguous';

export interface ClassifiedInput {
  raw: string;
  normalized: string;
  kind: InputClassificationKind;
  route: 'shell' | 'ai' | 'ambiguous' | 'control';
  modeChange?: ShellMode;
  reason: string;
  classifiedInMs: number;
}

export interface ExecutionBackendCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  checkpointResume: boolean;
  cancellation: boolean;
  sandboxed: boolean;
}

export interface BackendHealthStatus {
  healthy: boolean;
  latencyMs: number;
  message: string;
}

export interface BackendExecutionRequest {
  executionId: string;
  prompt: string;
  cwd: string;
  modelId?: string;
  providerId?: string;
  localOnly?: boolean;
  signal?: AbortSignal;
}

export interface BackendExecutionResult {
  executionId: string;
  backendId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'approval_required';
  output: string;
  evidenceIds: string[];
  error?: string;
  durationMs: number;
}

export interface ExecutionBackendAdapter {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source: 'native' | 'acp' | 'cli' | 'plugin';
  readonly capabilities: ExecutionBackendCapabilities;
  healthCheck(): Promise<BackendHealthStatus>;
  validateConfig(config: Record<string, unknown>): { valid: boolean; errors: string[] };
  execute(request: BackendExecutionRequest): Promise<BackendExecutionResult>;
}

export type InferenceProviderKind =
  | 'ollama'
  | 'lmstudio'
  | 'llama.cpp'
  | 'vllm'
  | 'openai-compatible'
  | 'anthropic'
  | 'google'
  | 'nvidia';

export type RoutingStrategy =
  | 'fixed'
  | 'fastest-local'
  | 'cost-aware'
  | 'capability-aware'
  | 'hardware-aware'
  | 'outcome-based'
  | 'local-only';

export interface InferenceEndpointConfig {
  id: string;
  kind: InferenceProviderKind;
  baseUrl: string;
  local: boolean;
  enabled: boolean;
  defaultModel?: string;
  contextWindow?: number;
  temperature?: number;
  topP?: number;
  gpuLayers?: number;
}

export interface VoiceTranscript {
  text: string;
  confidence: number;
  language: string;
  untrustedTranscript: true;
  requiresConfirmationForConsequential: true;
  durationMs: number;
}

export interface SpeechToTextAdapter {
  readonly id: string;
  readonly name: string;
  isAvailable(): Promise<boolean>;
  transcribeFile(audioPath: string, language?: string): Promise<VoiceTranscript>;
}

export interface TextToSpeechAdapter {
  readonly id: string;
  readonly name: string;
  isAvailable(): Promise<boolean>;
  speak(text: string, options?: { voice?: string; signal?: AbortSignal }): Promise<{ played: boolean; durationMs: number }>;
  stop(): void;
}

export interface WazirUbuntuSettings {
  shellMode: ShellMode;
  activeBackendId: string;
  routingStrategy: RoutingStrategy;
  localOnly: boolean;
  activeProviderId: string;
  defaultModelId?: string;
  voice: {
    pushToTalkShortcut: string;
    sttBackend: string;
    ttsBackend: string;
    ttsEnabled: boolean;
    microphoneDevice: string;
    voiceName: string;
  };
  approvalPolicy: 'read-only' | 'request-review' | 'auto-sandbox';
}
