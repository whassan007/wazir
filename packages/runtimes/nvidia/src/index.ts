import type {
  AuthLoginResult,
  AuthMethod,
  AuthStatus,
  ChatMessage,
  DiscoveredModel,
  GenerationControl,
  GenerationEvent,
  GenerationRequest,
  HealthStatus,
  ProviderAuthAdapter,
  ProviderCredentialSource,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeInfo,
  StoredCredential,
  Usage,
} from '@wazir/runtimes-interfaces';
import {
  controlledGeneration,
  httpFailureEvent,
  isStoredCredential,
  normalizePromptCacheTelemetry,
  readRateLimitHeaders,
  redactProviderSecrets,
} from '@wazir/runtimes-interfaces';
import type { SecretBroker } from '@wazir/secrets';
import {
  classifyFailure,
  classifyHttpFailure,
  isProviderRetryable,
  parseRetryAfterMs,
  providerRetryDecision,
  resolveRetryPolicy,
  waitForRetry,
  type FailureClass,
  type RetryPolicy,
} from '@wazir/shared';

export const NVIDIA_PROVIDER_ID = 'nvidia' as const;
export const NVIDIA_DISPLAY_NAME = 'NVIDIA API Catalog';
export const NVIDIA_PROVIDER_TYPE = 'HOSTED_INFERENCE' as const;
export const NVIDIA_DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const NVIDIA_DEFAULT_API_KEY_ENV = 'NVIDIA_API_KEY';
export const NVIDIA_DEFAULT_MODEL_ID = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

export type NvidiaCapabilityConfidence = 'confirmed' | 'documented-family' | 'unknown';

export interface NvidiaCapabilityProvenance {
  source: 'curated' | 'remote-metadata' | 'explicit-override' | 'unknown-model';
  confidence: NvidiaCapabilityConfidence;
  contextWindowKnown: boolean;
  maxOutputTokensKnown: boolean;
  toolCallingStatus: 'confirmed' | 'unsupported' | 'unknown';
  structuredOutputStatus: 'confirmed' | 'unsupported' | 'unknown';
  visionStatus: 'confirmed' | 'unsupported' | 'unknown';
  reasoningStatus: 'confirmed' | 'unsupported' | 'unknown';
  thinkingKwargsStatus: 'confirmed' | 'unsupported' | 'unknown';
}

export interface NvidiaModelMetadata {
  id: string;
  name: string;
  family: string;
  parameters?: string;
  architecture?: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: string[];
  toolCalling: boolean;
  parallelToolCalls: boolean;
  structuredOutput: boolean;
  vision: boolean;
  audio: boolean;
  embedding: boolean;
  reasoning: boolean;
  supportsThinkingKwargs: boolean;
  supportsSeed: boolean;
  provenance: NvidiaCapabilityProvenance;
}

export interface NvidiaModelCapabilityOverride {
  name?: string;
  family?: string;
  parameters?: string;
  architecture?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: string[];
  toolCalling?: boolean;
  parallelToolCalls?: boolean;
  structuredOutput?: boolean;
  vision?: boolean;
  audio?: boolean;
  embedding?: boolean;
  reasoning?: boolean;
  supportsThinkingKwargs?: boolean;
  supportsSeed?: boolean;
}

const CONFIRMED_PROVENANCE: NvidiaCapabilityProvenance = {
  source: 'curated',
  confidence: 'confirmed',
  contextWindowKnown: true,
  maxOutputTokensKnown: true,
  toolCallingStatus: 'confirmed',
  structuredOutputStatus: 'confirmed',
  visionStatus: 'unsupported',
  reasoningStatus: 'confirmed',
  thinkingKwargsStatus: 'unsupported',
};

/**
 * Curated metadata for documented NVIDIA API Catalog models, with
 * `nvidia/nemotron-3.5-super-vl-120b-a12b` as the primary multimodal reasoning/coding model.
 */
export const CURATED_NVIDIA_MODELS: Record<string, NvidiaModelMetadata> = {
  [NVIDIA_DEFAULT_MODEL_ID]: {
    id: NVIDIA_DEFAULT_MODEL_ID,
    name: 'NVIDIA Nemotron 3.5 Super VL 120B A12B',
    family: 'nemotron',
    parameters: '120B (A12B MoE)',
    architecture: 'nemotron-vl-moe',
    contextWindow: 131072,
    maxOutputTokens: 16384,
    capabilities: [
      'generalChat',
      'coding',
      'reasoning',
      'vision',
      'code_analysis',
      'debugging',
      'review',
      'toolCalling',
      'structuredOutput',
    ],
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: true,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: true,
    supportsSeed: true,
    provenance: {
      ...CONFIRMED_PROVENANCE,
      visionStatus: 'confirmed',
      thinkingKwargsStatus: 'confirmed',
    },
  },
  'nvidia/llama-3.3-nemotron-super-49b-v1.5': {
    id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    name: 'Llama 3.3 Nemotron Super 49B v1.5',
    family: 'nemotron',
    parameters: '49B',
    architecture: 'llama-nemotron',
    contextWindow: 131072,
    maxOutputTokens: 16384,
    capabilities: [
      'generalChat',
      'coding',
      'reasoning',
      'code_analysis',
      'debugging',
      'review',
      'toolCalling',
      'structuredOutput',
    ],
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: true,
    supportsSeed: true,
    provenance: {
      ...CONFIRMED_PROVENANCE,
      thinkingKwargsStatus: 'confirmed',
    },
  },
  'nvidia/llama-3.3-nemotron-super-49b-v1': {
    id: 'nvidia/llama-3.3-nemotron-super-49b-v1',
    name: 'Llama 3.3 Nemotron Super 49B v1',
    family: 'nemotron',
    parameters: '49B',
    architecture: 'llama-nemotron',
    contextWindow: 131072,
    maxOutputTokens: 16384,
    capabilities: [
      'generalChat',
      'coding',
      'reasoning',
      'code_analysis',
      'debugging',
      'review',
      'toolCalling',
      'structuredOutput',
    ],
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: true,
    supportsSeed: true,
    provenance: {
      ...CONFIRMED_PROVENANCE,
      thinkingKwargsStatus: 'confirmed',
    },
  },
  'nvidia/llama-3.1-nemotron-ultra-253b-v1': {
    id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
    name: 'Llama 3.1 Nemotron Ultra 253B v1',
    family: 'nemotron',
    parameters: '253B',
    architecture: 'llama-nemotron',
    contextWindow: 131072,
    maxOutputTokens: 16384,
    capabilities: [
      'generalChat',
      'coding',
      'reasoning',
      'code_analysis',
      'debugging',
      'review',
      'toolCalling',
      'structuredOutput',
    ],
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: true,
    supportsSeed: true,
    provenance: {
      ...CONFIRMED_PROVENANCE,
      thinkingKwargsStatus: 'confirmed',
    },
  },
  'moonshotai/kimi-k2-instruct': {
    id: 'moonshotai/kimi-k2-instruct',
    name: 'Kimi K2 Instruct',
    family: 'kimi',
    parameters: '1T (32B active MoE)',
    architecture: 'kimi-moe',
    contextWindow: 131072,
    maxOutputTokens: 16384,
    capabilities: [
      'generalChat',
      'coding',
      'reasoning',
      'code_analysis',
      'debugging',
      'review',
      'toolCalling',
      'structuredOutput',
    ],
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: false,
    supportsSeed: true,
    provenance: { ...CONFIRMED_PROVENANCE },
  },
  'deepseek-ai/deepseek-v3.1': {
    id: 'deepseek-ai/deepseek-v3.1',
    name: 'DeepSeek V3.1',
    family: 'deepseek',
    parameters: '671B (37B active MoE)',
    architecture: 'deepseek-v3',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    capabilities: [
      'generalChat',
      'coding',
      'reasoning',
      'code_analysis',
      'debugging',
      'review',
      'toolCalling',
      'structuredOutput',
    ],
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: true,
    supportsSeed: true,
    provenance: {
      ...CONFIRMED_PROVENANCE,
      thinkingKwargsStatus: 'confirmed',
    },
  },
  'deepseek-ai/deepseek-r1': {
    id: 'deepseek-ai/deepseek-r1',
    name: 'DeepSeek R1',
    family: 'deepseek',
    parameters: '671B',
    architecture: 'deepseek-r1',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    capabilities: ['generalChat', 'coding', 'reasoning', 'code_analysis', 'debugging', 'review'],
    // DeepSeek R1 on NIM streams reasoning tokens (`reasoning_content`) and does not reliably support
    // native function-calling or strict JSON schema response_format across all NIM deployments.
    toolCalling: false,
    parallelToolCalls: false,
    structuredOutput: false,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: false,
    supportsSeed: true,
    provenance: {
      ...CONFIRMED_PROVENANCE,
      toolCallingStatus: 'unsupported',
      structuredOutputStatus: 'unsupported',
    },
  },
  'qwen/qwen3-coder-480b-a35b-instruct': {
    id: 'qwen/qwen3-coder-480b-a35b-instruct',
    name: 'Qwen3 Coder 480B A35B Instruct',
    family: 'qwen',
    parameters: '480B (A35B MoE)',
    architecture: 'qwen3-moe',
    contextWindow: 131072,
    maxOutputTokens: 16384,
    capabilities: [
      'generalChat',
      'coding',
      'reasoning',
      'code_analysis',
      'debugging',
      'review',
      'toolCalling',
      'structuredOutput',
    ],
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: false,
    supportsSeed: true,
    provenance: { ...CONFIRMED_PROVENANCE },
  },
  'meta/llama-3.3-70b-instruct': {
    id: 'meta/llama-3.3-70b-instruct',
    name: 'Llama 3.3 70B Instruct',
    family: 'llama',
    parameters: '70B',
    architecture: 'llama',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    capabilities: ['generalChat', 'coding', 'reasoning', 'code_analysis', 'review', 'toolCalling', 'structuredOutput'],
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: false,
    supportsSeed: true,
    provenance: { ...CONFIRMED_PROVENANCE },
  },
  'meta/llama-3.1-70b-instruct': {
    id: 'meta/llama-3.1-70b-instruct',
    name: 'Llama 3.1 70B Instruct',
    family: 'llama',
    parameters: '70B',
    architecture: 'llama',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    capabilities: ['generalChat', 'coding', 'reasoning', 'code_analysis', 'review', 'toolCalling', 'structuredOutput'],
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    supportsThinkingKwargs: false,
    supportsSeed: true,
    provenance: { ...CONFIRMED_PROVENANCE },
  },
  'meta/llama-3.2-90b-vision-instruct': {
    id: 'meta/llama-3.2-90b-vision-instruct',
    name: 'Llama 3.2 90B Vision Instruct',
    family: 'llama',
    parameters: '90B',
    architecture: 'mllama',
    contextWindow: 131072,
    maxOutputTokens: 4096,
    capabilities: ['generalChat', 'coding', 'vision', 'review'],
    // Vision-instruct MLLaMA endpoints on NIM often reject tool_calls when image content is present or unconfirmed.
    toolCalling: false,
    parallelToolCalls: false,
    structuredOutput: true,
    vision: true,
    audio: false,
    embedding: false,
    reasoning: false,
    supportsThinkingKwargs: false,
    supportsSeed: true,
    provenance: {
      ...CONFIRMED_PROVENANCE,
      toolCallingStatus: 'unsupported',
      visionStatus: 'confirmed',
      reasoningStatus: 'unsupported',
    },
  },
};

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Infers NVIDIA model metadata with explicit provenance and capability integrity:
 * - Curated models and explicit overrides have `confirmed` capability status.
 * - Remote `/v1/models` records that explicitly report capability flags (`supports_tool_calling`,
 *   `tool_calling`, `supports_vision`, `vision`, `structured_output`, `context_window`, `max_output_tokens`)
 *   are respected as `remote-metadata`.
 * - Unknown models without documented or remote capability confirmation do NOT falsely advertise
 *   vision, toolCalling, parallelToolCalls, structuredOutput, or thinking kwargs; uncertain capabilities
 *   are marked `unknown` in `meta.provenance` and `false` on the advertised boolean flags so unsupported
 *   features are never fabricated.
 */
export function inferNvidiaModelMetadata(
  modelId: string,
  remoteRecord?: Record<string, unknown>,
  override?: NvidiaModelCapabilityOverride,
): NvidiaModelMetadata {
  const remoteCtx =
    readPositiveNumber(remoteRecord?.context_window) ??
    readPositiveNumber(remoteRecord?.context_length) ??
    readPositiveNumber(remoteRecord?.max_model_len);
  const remoteMaxOut =
    readPositiveNumber(remoteRecord?.max_output_tokens) ??
    readPositiveNumber(remoteRecord?.max_completion_tokens) ??
    readPositiveNumber(remoteRecord?.max_tokens);

  const remoteCaps = (remoteRecord?.capabilities && typeof remoteRecord.capabilities === 'object'
    ? (remoteRecord.capabilities as Record<string, unknown>)
    : undefined);

  const remoteTools =
    readOptionalBoolean(remoteRecord?.tool_calling) ??
    readOptionalBoolean(remoteRecord?.supports_tools) ??
    readOptionalBoolean(remoteRecord?.function_calling) ??
    readOptionalBoolean(remoteCaps?.tools) ??
    readOptionalBoolean(remoteCaps?.tool_calling) ??
    readOptionalBoolean(remoteCaps?.function_calling);
  const remoteParallelTools =
    readOptionalBoolean(remoteRecord?.parallel_tool_calls) ??
    readOptionalBoolean(remoteCaps?.parallel_tool_calls);
  const remoteStructured =
    readOptionalBoolean(remoteRecord?.structured_output) ??
    readOptionalBoolean(remoteRecord?.json_schema) ??
    readOptionalBoolean(remoteCaps?.structured_output) ??
    readOptionalBoolean(remoteCaps?.json_schema);
  const remoteVision =
    readOptionalBoolean(remoteRecord?.vision) ??
    readOptionalBoolean(remoteRecord?.supports_vision) ??
    readOptionalBoolean(remoteCaps?.vision);
  const remoteReasoning =
    readOptionalBoolean(remoteRecord?.reasoning) ??
    readOptionalBoolean(remoteRecord?.supports_reasoning) ??
    readOptionalBoolean(remoteCaps?.reasoning);
  const remoteThinkingKwargs =
    readOptionalBoolean(remoteRecord?.supports_thinking_kwargs) ??
    readOptionalBoolean(remoteCaps?.thinking_kwargs);

  const curated = CURATED_NVIDIA_MODELS[modelId];
  if (curated) {
    const merged: NvidiaModelMetadata = {
      ...curated,
      ...(typeof remoteRecord?.name === 'string' && remoteRecord.name.trim() ? { name: remoteRecord.name } : {}),
      ...(remoteCtx ? { contextWindow: remoteCtx } : {}),
      ...(remoteMaxOut ? { maxOutputTokens: remoteMaxOut } : {}),
      ...(remoteTools !== undefined ? { toolCalling: remoteTools } : {}),
      ...(remoteParallelTools !== undefined ? { parallelToolCalls: remoteParallelTools } : {}),
      ...(remoteStructured !== undefined ? { structuredOutput: remoteStructured } : {}),
      ...(remoteVision !== undefined ? { vision: remoteVision } : {}),
      ...(remoteReasoning !== undefined ? { reasoning: remoteReasoning } : {}),
      ...(remoteThinkingKwargs !== undefined ? { supportsThinkingKwargs: remoteThinkingKwargs } : {}),
      provenance: { ...curated.provenance },
    };
    return applyCapabilityOverride(merged, override);
  }

  const lower = modelId.toLowerCase();
  const isEmbedding =
    lower.includes('embed') ||
    lower.includes('nv-embed') ||
    lower.includes('bge-') ||
    lower.includes('rerank') ||
    lower.includes('arctic-embed');

  // Known documented model families in the NVIDIA API Catalog
  const isKnownNemotron =
    lower.startsWith('nvidia/nemotron-') ||
    lower.startsWith('nvidia/llama-3.1-nemotron') ||
    lower.startsWith('nvidia/llama-3.3-nemotron');
  const isKnownVision =
    remoteVision === true ||
    lower.includes('-vl-') ||
    lower.endsWith('-vl') ||
    lower.includes('vision-instruct') ||
    lower.includes('neva-') ||
    lower.includes('vila-') ||
    lower.includes('paligemma') ||
    lower.includes('phi-3.5-vision') ||
    lower.includes('llama-3.2-11b-vision') ||
    lower.includes('llama-3.2-90b-vision');
  const isKnownToolCallingFamily =
    !isEmbedding &&
    (isKnownNemotron ||
      lower.startsWith('meta/llama-3.1-') ||
      lower.startsWith('meta/llama-3.3-') ||
      lower.startsWith('qwen/qwen2.5-') ||
      lower.startsWith('qwen/qwen3-') ||
      lower.startsWith('mistralai/mistral-') ||
      lower.startsWith('mistralai/mixtral-') ||
      lower.startsWith('moonshotai/kimi-')) &&
    !lower.includes('vision-instruct');
  const isKnownReasoningFamily =
    !isEmbedding &&
    (isKnownNemotron ||
      lower.includes('deepseek-r1') ||
      lower.includes('deepseek-v3.1') ||
      lower.includes('qwq') ||
      lower.includes('qwen3'));

  const family = isKnownNemotron || lower.includes('nemotron')
    ? 'nemotron'
    : lower.includes('llama')
      ? 'llama'
      : lower.includes('deepseek')
        ? 'deepseek'
        : lower.includes('qwen')
          ? 'qwen'
          : lower.includes('mistral') || lower.includes('mixtral')
            ? 'mistral'
            : lower.includes('gemma')
              ? 'gemma'
              : lower.includes('kimi')
                ? 'kimi'
                : modelId.split('/')[0] || 'nvidia';

  const hasRemoteMetadata =
    remoteCtx !== undefined ||
    remoteMaxOut !== undefined ||
    remoteTools !== undefined ||
    remoteStructured !== undefined ||
    remoteVision !== undefined ||
    remoteReasoning !== undefined;

  const toolCallingStatus: 'confirmed' | 'unsupported' | 'unknown' = isEmbedding
    ? 'unsupported'
    : remoteTools !== undefined
      ? remoteTools
        ? 'confirmed'
        : 'unsupported'
      : isKnownToolCallingFamily
        ? 'confirmed'
        : 'unknown';

  const structuredOutputStatus: 'confirmed' | 'unsupported' | 'unknown' = isEmbedding
    ? 'unsupported'
    : remoteStructured !== undefined
      ? remoteStructured
        ? 'confirmed'
        : 'unsupported'
      : isKnownToolCallingFamily
        ? 'confirmed'
        : 'unknown';

  const visionStatus: 'confirmed' | 'unsupported' | 'unknown' = isEmbedding
    ? 'unsupported'
    : remoteVision !== undefined
      ? remoteVision
        ? 'confirmed'
        : 'unsupported'
      : isKnownVision
        ? 'confirmed'
        : 'unsupported';

  const reasoningStatus: 'confirmed' | 'unsupported' | 'unknown' = isEmbedding
    ? 'unsupported'
    : remoteReasoning !== undefined
      ? remoteReasoning
        ? 'confirmed'
        : 'unsupported'
      : isKnownReasoningFamily
        ? 'confirmed'
        : 'unknown';

  const thinkingKwargsStatus: 'confirmed' | 'unsupported' | 'unknown' = isEmbedding
    ? 'unsupported'
    : remoteThinkingKwargs !== undefined
      ? remoteThinkingKwargs
        ? 'confirmed'
        : 'unsupported'
      : isKnownNemotron
        ? 'confirmed'
        : 'unsupported';

  const toolCalling = toolCallingStatus === 'confirmed';
  const structuredOutput = structuredOutputStatus === 'confirmed';
  const vision = visionStatus === 'confirmed';
  const reasoning = reasoningStatus === 'confirmed';
  const supportsThinkingKwargs = thinkingKwargsStatus === 'confirmed';
  const parallelToolCalls =
    toolCalling && (remoteParallelTools ?? (isKnownNemotron || lower.startsWith('meta/llama-3.3-') || lower.startsWith('qwen/qwen3-')));

  const capabilities: string[] = isEmbedding
    ? ['embedding']
    : [
        'generalChat',
        'coding',
        ...(reasoning ? ['reasoning', 'code_analysis', 'debugging', 'review'] : []),
        ...(vision ? ['vision'] : []),
        ...(toolCalling ? ['toolCalling'] : []),
        ...(structuredOutput ? ['structuredOutput'] : []),
      ];

  const baseMeta: NvidiaModelMetadata = {
    id: modelId,
    name: typeof remoteRecord?.name === 'string' && remoteRecord.name.trim() ? remoteRecord.name : modelId,
    family,
    contextWindow: remoteCtx ?? (isKnownNemotron || isKnownToolCallingFamily ? 131072 : 32768),
    maxOutputTokens: remoteMaxOut ?? (isKnownNemotron ? 16384 : 4096),
    capabilities,
    toolCalling,
    parallelToolCalls,
    structuredOutput,
    vision,
    audio: false,
    embedding: isEmbedding,
    reasoning,
    supportsThinkingKwargs,
    supportsSeed: !isEmbedding && (isKnownNemotron || isKnownToolCallingFamily),
    provenance: {
      source: hasRemoteMetadata ? 'remote-metadata' : 'unknown-model',
      confidence: hasRemoteMetadata || isKnownNemotron || isKnownToolCallingFamily ? 'documented-family' : 'unknown',
      contextWindowKnown: remoteCtx !== undefined || isKnownNemotron || isKnownToolCallingFamily,
      maxOutputTokensKnown: remoteMaxOut !== undefined || isKnownNemotron,
      toolCallingStatus,
      structuredOutputStatus,
      visionStatus,
      reasoningStatus,
      thinkingKwargsStatus,
    },
  };

  return applyCapabilityOverride(baseMeta, override);
}

function applyCapabilityOverride(
  meta: NvidiaModelMetadata,
  override?: NvidiaModelCapabilityOverride,
): NvidiaModelMetadata {
  if (!override) return meta;
  const toolCalling = override.toolCalling ?? meta.toolCalling;
  const structuredOutput = override.structuredOutput ?? meta.structuredOutput;
  const vision = override.vision ?? meta.vision;
  const reasoning = override.reasoning ?? meta.reasoning;
  const supportsThinkingKwargs = override.supportsThinkingKwargs ?? meta.supportsThinkingKwargs;
  const capSet = new Set<string>(override.capabilities ?? meta.capabilities);
  if (toolCalling) capSet.add('toolCalling');
  else capSet.delete('toolCalling');
  if (structuredOutput) capSet.add('structuredOutput');
  else capSet.delete('structuredOutput');
  if (vision) capSet.add('vision');
  else capSet.delete('vision');
  if (reasoning) capSet.add('reasoning');
  else capSet.delete('reasoning');

  return {
    ...meta,
    ...(override.name !== undefined ? { name: override.name } : {}),
    ...(override.family !== undefined ? { family: override.family } : {}),
    ...(override.parameters !== undefined ? { parameters: override.parameters } : {}),
    ...(override.architecture !== undefined ? { architecture: override.architecture } : {}),
    ...(override.contextWindow !== undefined ? { contextWindow: override.contextWindow } : {}),
    ...(override.maxOutputTokens !== undefined ? { maxOutputTokens: override.maxOutputTokens } : {}),
    capabilities: Array.from(capSet),
    toolCalling,
    parallelToolCalls: override.parallelToolCalls ?? (toolCalling ? meta.parallelToolCalls : false),
    structuredOutput,
    vision,
    audio: override.audio ?? meta.audio,
    embedding: override.embedding ?? meta.embedding,
    reasoning,
    supportsThinkingKwargs,
    supportsSeed: override.supportsSeed ?? meta.supportsSeed,
    provenance: {
      source: 'explicit-override',
      confidence: 'confirmed',
      contextWindowKnown: override.contextWindow !== undefined ? true : meta.provenance.contextWindowKnown,
      maxOutputTokensKnown: override.maxOutputTokens !== undefined ? true : meta.provenance.maxOutputTokensKnown,
      toolCallingStatus: override.toolCalling !== undefined ? (override.toolCalling ? 'confirmed' : 'unsupported') : meta.provenance.toolCallingStatus,
      structuredOutputStatus: override.structuredOutput !== undefined ? (override.structuredOutput ? 'confirmed' : 'unsupported') : meta.provenance.structuredOutputStatus,
      visionStatus: override.vision !== undefined ? (override.vision ? 'confirmed' : 'unsupported') : meta.provenance.visionStatus,
      reasoningStatus: override.reasoning !== undefined ? (override.reasoning ? 'confirmed' : 'unsupported') : meta.provenance.reasoningStatus,
      thinkingKwargsStatus: override.supportsThinkingKwargs !== undefined ? (override.supportsThinkingKwargs ? 'confirmed' : 'unsupported') : meta.provenance.thinkingKwargsStatus,
    },
  };
}

function toDiscoveredModel(meta: NvidiaModelMetadata): DiscoveredModel {
  return {
    id: meta.id,
    name: meta.name,
    family: meta.family,
    parameters: meta.parameters,
    architecture: meta.architecture,
    contextWindow: meta.provenance.contextWindowKnown ? meta.contextWindow : undefined,
    maxOutputTokens: meta.provenance.maxOutputTokensKnown ? meta.maxOutputTokens : undefined,
    capabilities: [...meta.capabilities],
    toolCalling: meta.toolCalling,
    structuredOutput: meta.structuredOutput,
    vision: meta.vision,
    audio: meta.audio,
    embedding: meta.embedding,
    reasoning: meta.reasoning,
  };
}

export interface NvidiaRequestCompatibilityResult {
  compatible: boolean;
  failureClass?: FailureClass;
  error?: string;
}

/**
 * Validates that a `GenerationRequest` does not require critical capabilities
 * (embedding vs chat, multimodal vision/audio, native tool calling, or strict JSON schema)
 * that the target NVIDIA model does not support or has not confirmed.
 * Never silently strips critical request requirements.
 */
export function validateNvidiaRequestCompatibility(
  request: GenerationRequest,
  meta: NvidiaModelMetadata,
): NvidiaRequestCompatibilityResult {
  if (meta.embedding) {
    return {
      compatible: false,
      failureClass: 'NON_RECOVERABLE',
      error: `Model '${request.modelId}' is an embedding model and cannot execute chat completions. Select a generative model such as '${NVIDIA_DEFAULT_MODEL_ID}'.`,
    };
  }

  const hasImages = request.messages.some(
    (m) => Array.isArray((m as ChatMessage & { images?: unknown[] }).images) && (m as ChatMessage & { images?: unknown[] }).images!.length > 0,
  );
  if (hasImages && !meta.vision) {
    const statusNote = meta.provenance.visionStatus === 'unknown' ? 'has unconfirmed vision support' : 'does not support vision';
    return {
      compatible: false,
      failureClass: 'NON_RECOVERABLE',
      error: `Model '${request.modelId}' ${statusNote} and does not advertise vision capability for multimodal image input. Use '${NVIDIA_DEFAULT_MODEL_ID}' or configure modelCapabilities override if supported.`,
    };
  }

  const hasAudio = request.messages.some(
    (m) => Array.isArray((m as unknown as { audio?: unknown[] }).audio) && (m as unknown as { audio?: unknown[] }).audio!.length > 0,
  );
  if (hasAudio && !meta.audio) {
    return {
      compatible: false,
      failureClass: 'NON_RECOVERABLE',
      error: `Model '${request.modelId}' does not support audio input modality on NVIDIA chat completions.`,
    };
  }

  if (request.tools && request.tools.length > 0 && !meta.toolCalling) {
    const reason =
      meta.provenance.toolCallingStatus === 'unknown'
        ? `has unconfirmed tool-calling support (provenance: ${meta.provenance.source})`
        : 'does not support native tool calling';
    return {
      compatible: false,
      failureClass: 'NON_RECOVERABLE',
      error: `Model '${request.modelId}' ${reason}; refusing to silently drop ${request.tools.length} required tool definition(s). Choose a tool-capable NVIDIA model (e.g. '${NVIDIA_DEFAULT_MODEL_ID}') or explicitly configure toolCalling support.`,
    };
  }

  if (request.responseFormat && request.responseFormat.type !== 'text' && !meta.structuredOutput) {
    const reason =
      meta.provenance.structuredOutputStatus === 'unknown'
        ? `has unconfirmed structured output (${request.responseFormat.type}) support`
        : `does not support structured output (${request.responseFormat.type})`;
    return {
      compatible: false,
      failureClass: 'NON_RECOVERABLE',
      error: `Model '${request.modelId}' ${reason}; refusing to silently strip responseFormat '${request.responseFormat.type}'. Choose a model with structuredOutput support (e.g. '${NVIDIA_DEFAULT_MODEL_ID}') or configure modelCapabilities.`,
    };
  }

  return { compatible: true };
}

export interface NvidiaAdapterOptions {
  id?: string;
  baseURL?: string;
  secrets?: SecretBroker;
  /** Environment variable name for API key fallback (default: NVIDIA_API_KEY). */
  apiKeyEnv?: string;
  /** Optional environment map override for deterministic testing. */
  env?: NodeJS.ProcessEnv;
  /** Default model registered when configured (default: nvidia/nemotron-3.5-super-vl-120b-a12b). */
  defaultModel?: string;
  /** Explicitly configured models to include alongside discovered models or when enumeration is unavailable. */
  configuredModels?: string[];
  /** Explicit per-model capability and limit overrides. */
  modelCapabilities?: Record<string, NvidiaModelCapabilityOverride>;
  /** Default max output tokens when not specified on GenerationRequest (default: 16384). */
  defaultMaxOutputTokens?: number;
  /** Default bounded connect-phase retry count for transient HTTP 429/5xx/network errors (default: 2). */
  maxRetries?: number;
  /** Retry policy overrides for connect-phase retries. */
  retryPolicy?: Partial<RetryPolicy>;
  /** Per-request HTTP timeout in milliseconds when no signal/deadline is supplied (default: 60000). */
  requestTimeoutMs?: number;
  /** Whether to query /models during listModels()/discoverModels() (default: true). */
  discoverModelsRemote?: boolean;
  fetch?: typeof globalThis.fetch;
}

export interface ResolvedNvidiaCredential {
  apiKey: string;
  source: ProviderCredentialSource;
}

export class NvidiaAdapter implements RuntimeAdapter, ProviderAuthAdapter {
  readonly id: string;
  readonly type = 'nvidia' as const;
  readonly provider = 'nvidia' as const;
  readonly displayName = NVIDIA_DISPLAY_NAME;
  readonly providerType = NVIDIA_PROVIDER_TYPE;
  readonly supportedMethods: AuthMethod[] = ['api-key'];

  private readonly baseURL: string;
  private readonly secrets?: SecretBroker;
  private readonly apiKeyEnv: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultModel: string;
  private readonly configuredModels: string[];
  private readonly modelCapabilityOverrides: Map<string, NvidiaModelCapabilityOverride>;
  private readonly remoteModelRecords = new Map<string, Record<string, unknown>>();
  private readonly defaultMaxOutputTokens: number;
  private readonly defaultRetryPolicy: RetryPolicy;
  private readonly requestTimeoutMs: number;
  private readonly discoverModelsRemote: boolean;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly inflight = new Map<string, AbortController>();
  /** Remembers per-model unsupported optional request fields if the endpoint rejected them once. */
  private readonly unsupportedModelFields = new Map<string, Set<string>>();

  constructor(options: NvidiaAdapterOptions = {}) {
    this.id = options.id ?? NVIDIA_PROVIDER_ID;
    const rawBaseUrl = options.baseURL
      ?? options.env?.WAZIR_NVIDIA_BASE_URL
      ?? process.env.WAZIR_NVIDIA_BASE_URL
      ?? NVIDIA_DEFAULT_BASE_URL;
    this.baseURL = rawBaseUrl.replace(/\/$/, '');
    this.secrets = options.secrets;
    this.apiKeyEnv = options.apiKeyEnv ?? NVIDIA_DEFAULT_API_KEY_ENV;
    this.env = options.env ?? process.env;
    this.defaultModel = options.defaultModel ?? NVIDIA_DEFAULT_MODEL_ID;
    this.configuredModels = Array.from(
      new Set([this.defaultModel, ...(options.configuredModels ?? [])].filter((m) => m.trim().length > 0)),
    );
    this.modelCapabilityOverrides = new Map(Object.entries(options.modelCapabilities ?? {}));
    // Explicitly configured models without overrides get confirmed chat/tool/structured capabilities
    // only if they are curated or explicitly overridden; otherwise their provenance remains explicit.
    this.defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 16384;
    this.defaultRetryPolicy = resolveRetryPolicy({
      maxRetries: options.maxRetries ?? 2,
      initialDelayMs: 200,
      maxDelayMs: 4000,
      jitter: 0.1,
      ...options.retryPolicy,
    });
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.discoverModelsRemote = options.discoverModelsRemote ?? true;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  getEndpointUrl(): string {
    return this.baseURL;
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  getConfiguredModels(): string[] {
    return [...this.configuredModels];
  }

  getModelMetadata(modelId: string): NvidiaModelMetadata {
    const remote = this.remoteModelRecords.get(modelId);
    const override = this.modelCapabilityOverrides.get(modelId);
    return inferNvidiaModelMetadata(modelId, remote, override);
  }

  setModelCapabilityOverride(modelId: string, override: NvidiaModelCapabilityOverride): void {
    this.modelCapabilityOverrides.set(modelId, override);
  }

  private async readStored(): Promise<StoredCredential | null> {
    if (!this.secrets) return null;
    const raw = await this.secrets.getCredential('nvidia');
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isStoredCredential(parsed) && parsed.provider === 'nvidia' ? parsed : null;
    } catch {
      return null;
    }
  }

  async resolveCredential(): Promise<ResolvedNvidiaCredential | null> {
    const stored = await this.readStored();
    if (stored && stored.credential.kind === 'api-key' && stored.credential.apiKey.trim().length > 0) {
      return { apiKey: stored.credential.apiKey.trim(), source: 'secret-broker' };
    }
    const envKey = this.env[this.apiKeyEnv]?.trim();
    if (envKey && envKey.length > 0) {
      return { apiKey: envKey, source: 'env' };
    }
    return null;
  }

  async status(): Promise<AuthStatus> {
    const raw = this.secrets ? await this.secrets.getCredential('nvidia') : undefined;
    if (raw) {
      const stored = await this.readStored();
      if (!stored || stored.credential.kind !== 'api-key' || !stored.credential.apiKey.trim()) {
        const envKey = this.env[this.apiKeyEnv]?.trim();
        if (envKey) {
          return {
            provider: 'nvidia',
            authenticated: true,
            method: 'api-key',
            credentialSource: 'env',
            state: 'authenticated',
            eligible: true,
          };
        }
        return {
          provider: 'nvidia',
          authenticated: false,
          credentialSource: 'none',
          state: 'unavailable',
          eligible: false,
          reason: 'stored credential is corrupted; run `wa auth login nvidia` or set NVIDIA_API_KEY',
        };
      }
      return {
        provider: 'nvidia',
        authenticated: true,
        method: 'api-key',
        credentialSource: 'secret-broker',
        state: 'authenticated',
        eligible: true,
      };
    }

    const envKey = this.env[this.apiKeyEnv]?.trim();
    if (envKey) {
      return {
        provider: 'nvidia',
        authenticated: true,
        method: 'api-key',
        credentialSource: 'env',
        state: 'authenticated',
        eligible: true,
      };
    }

    return {
      provider: 'nvidia',
      authenticated: false,
      credentialSource: 'none',
      state: 'unavailable',
      eligible: false,
      reason: `not logged in (${this.apiKeyEnv} not set and no stored credential)`,
    };
  }

  async loginWithApiKey(apiKey: string): Promise<AuthLoginResult> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      return {
        ok: false,
        status: await this.status(),
        error: 'API key must not be empty',
      };
    }
    try {
      const res = await this.fetchImpl(`${this.baseURL}/models`, {
        headers: { Authorization: `Bearer ${trimmed}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          status: await this.status(),
          error: `NVIDIA rejected the API key (HTTP ${res.status})`,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          status: await this.status(),
          error: `NVIDIA validation call failed: HTTP ${res.status}`,
        };
      }
    } catch (err) {
      const msg = redactProviderSecrets(err instanceof Error ? err.message : String(err), [trimmed]);
      return {
        ok: false,
        status: await this.status(),
        error: `Could not reach NVIDIA to validate key: ${msg}`,
      };
    }

    const record: StoredCredential = {
      provider: 'nvidia',
      method: 'api-key',
      credential: { kind: 'api-key', apiKey: trimmed },
      obtainedAt: new Date().toISOString(),
    };
    if (this.secrets) {
      await this.secrets.putCredential('nvidia', JSON.stringify(record));
    }
    return { ok: true, status: await this.status() };
  }

  async logout(): Promise<void> {
    if (this.secrets) {
      await this.secrets.deleteCredential('nvidia');
    }
  }

  private getConfiguredFallbackModels(): DiscoveredModel[] {
    const ids = new Set<string>([this.defaultModel, ...this.configuredModels]);
    for (const curatedId of Object.keys(CURATED_NVIDIA_MODELS)) {
      ids.add(curatedId);
    }
    return Array.from(ids).map((id) => toDiscoveredModel(this.getModelMetadata(id)));
  }

  async discoverModels(): Promise<DiscoveredModel[]> {
    const cred = await this.resolveCredential();
    if (!cred) return [];
    if (!this.discoverModelsRemote) {
      return this.getConfiguredFallbackModels();
    }
    try {
      const res = await this.fetchImpl(`${this.baseURL}/models`, {
        headers: { Authorization: `Bearer ${cred.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return [];
        }
        return this.getConfiguredFallbackModels();
      }
      const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
      const remoteEntries = Array.isArray(data.data) ? data.data : [];
      const byId = new Map<string, DiscoveredModel>();

      // Ensure configured/default models are always present first.
      for (const fallback of this.getConfiguredFallbackModels().filter((model) =>
        model.id === this.defaultModel || this.configuredModels.includes(model.id))) {
        byId.set(fallback.id, fallback);
      }

      for (const entry of remoteEntries) {
        const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
        if (!id) continue;
        this.remoteModelRecords.set(id, entry);
        const meta = this.getModelMetadata(id);
        byId.set(id, toDiscoveredModel(meta));
      }

      return Array.from(byId.values());
    } catch {
      // Allow explicitly configured models when enumeration is unavailable
      return this.getConfiguredFallbackModels();
    }
  }

  async discover(): Promise<RuntimeInfo> {
    return {
      id: this.id,
      name: NVIDIA_DISPLAY_NAME,
      version: 'v1',
      url: this.baseURL,
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    const cred = await this.resolveCredential();
    if (!cred) {
      return {
        status: 'unavailable',
        reason: 'AUTH_REQUIRED',
        message: `not authenticated — set ${this.apiKeyEnv} or run \`wa auth login nvidia\``,
      };
    }
    try {
      const res = await this.fetchImpl(`${this.baseURL}/models`, {
        headers: { Authorization: `Bearer ${cred.apiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          status: 'unavailable',
          reason: 'AUTH_REQUIRED',
          message: `NVIDIA rejected the credential (HTTP ${res.status}); check ${this.apiKeyEnv} or re-run \`wa auth login nvidia\``,
        };
      }
      if (res.status === 429 || res.status >= 500) {
        const fallbackModels = this.getConfiguredFallbackModels();
        return {
          status: 'degraded',
          message: `NVIDIA API returned HTTP ${res.status}; configured models remain registered`,
          diagnostics: {
            cliAvailable: false,
            serverRunning: true,
            endpoint: this.baseURL,
            apiReachable: true,
            installedModels: fallbackModels.length,
            loadedModels: fallbackModels.length,
            readyModels: fallbackModels.length,
            failureReason: `HTTP_${res.status}`,
          },
        };
      }
      if (!res.ok) {
        return {
          status: 'degraded',
          reason: 'INVALID_RESPONSE',
          message: `HTTP ${res.status}`,
        };
      }
      const models = await this.discoverModels();
      return {
        status: 'healthy',
        diagnostics: {
          cliAvailable: false,
          serverRunning: true,
          endpoint: this.baseURL,
          apiReachable: true,
          installedModels: models.length,
          loadedModels: models.length,
          readyModels: models.length,
        },
      };
    } catch (err) {
      const safeErr = redactProviderSecrets(err instanceof Error ? err.message : String(err), [cred.apiKey]);
      return {
        status: 'unavailable',
        reason: 'API_UNREACHABLE',
        message: safeErr,
      };
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    return this.discoverModels();
  }

  async getLoadedModels(): Promise<string[]> {
    const models = await this.discoverModels();
    return models.map((m) => m.id);
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      chat: true,
      streaming: true,
      toolCalling: true,
      nativeToolCalling: true,
      parallelToolCalling: true,
      strictJsonSchema: true,
      streamingToolCalls: true,
      promptCaching: true,
      promptCacheTelemetry: true,
      cacheReadMetrics: true,
      cacheWriteMetrics: false,
      structuredOutput: true,
      vision: true,
      embeddings: false,
      reasoning: true,
      lifecycle: {
        discovery: true,
        inspection: false,
        contextControl: false,
        estimate: false,
        readinessProbe: true,
      },
      modelLoad: false,
      modelUnload: false,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    };
  }

  generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    return controlledGeneration(request, (generation, control) => this.generateControlled(generation, control));
  }

  private buildRequestBody(
    request: GenerationRequest,
    messages: Array<Record<string, unknown>>,
    meta: NvidiaModelMetadata,
    omittedFields: ReadonlySet<string>,
  ): Record<string, unknown> {
    const advanced = request as GenerationRequest & {
      seed?: number;
      parallelToolCalls?: boolean;
      enableThinking?: boolean;
      extraBody?: Record<string, unknown>;
    };
    const stream = request.stream ?? true;
    const requestedMaxTokens = request.maxTokens ?? this.defaultMaxOutputTokens;
    const maxTokens = meta.provenance.maxOutputTokensKnown
      ? Math.max(1, Math.min(requestedMaxTokens, meta.maxOutputTokens))
      : Math.max(1, Math.min(requestedMaxTokens, this.defaultMaxOutputTokens));

    const body: Record<string, unknown> = {
      model: request.modelId,
      messages,
      stream,
      temperature: request.temperature ?? 0.6,
      top_p: request.topP ?? 0.95,
      max_tokens: maxTokens,
    };

    if (stream && !omittedFields.has('stream_options')) {
      body.stream_options = { include_usage: true };
    }

    if (advanced.seed !== undefined && meta.supportsSeed && !omittedFields.has('seed')) {
      body.seed = advanced.seed;
    }

    if (request.tools && request.tools.length > 0 && meta.toolCalling) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      if (request.toolChoice !== undefined && !omittedFields.has('tool_choice')) {
        body.tool_choice = request.toolChoice;
      }
      const allowParallel = advanced.parallelToolCalls ?? meta.parallelToolCalls;
      if (allowParallel && meta.parallelToolCalls && !omittedFields.has('parallel_tool_calls')) {
        body.parallel_tool_calls = true;
      }
    }

    if (request.responseFormat && request.responseFormat.type !== 'text' && meta.structuredOutput) {
      body.response_format = request.responseFormat.type === 'json_schema' && request.responseFormat.json_schema
        ? { type: 'json_schema', json_schema: request.responseFormat.json_schema }
        : { type: 'json_object' };
    }

    // Reasoning / thinking template kwargs for models that support it (e.g. Nemotron 3.5 Super VL)
    const shouldSendThinking = (advanced.enableThinking ?? meta.supportsThinkingKwargs) && meta.supportsThinkingKwargs;
    if (!omittedFields.has('extra_body')) {
      const sanitizedExtra: Record<string, unknown> = {};
      if (advanced.extraBody && typeof advanced.extraBody === 'object') {
        for (const [k, v] of Object.entries(advanced.extraBody)) {
          if (k === 'chat_template_kwargs' && !meta.supportsThinkingKwargs) continue;
          sanitizedExtra[k] = v;
        }
      }
      if (shouldSendThinking || Object.keys(sanitizedExtra).length > 0) {
        const mergedExtra: Record<string, unknown> = {
          ...(shouldSendThinking ? { chat_template_kwargs: { enable_thinking: advanced.enableThinking ?? true } } : {}),
          ...sanitizedExtra,
        };
        body.extra_body = mergedExtra;
      }
    }

    return body;
  }

  private async *generateControlled(
    request: GenerationRequest,
    control: GenerationControl,
  ): AsyncIterable<GenerationEvent> {
    const cred = await this.resolveCredential();
    if (!cred) {
      yield {
        type: 'error',
        requestId: control.requestId,
        failureClass: 'AUTH_FAILED',
        error: `NVIDIA provider is not authenticated — set ${this.apiKeyEnv} or run \`wa auth login nvidia\``,
      };
      return;
    }

    const meta = this.getModelMetadata(request.modelId);
    const compatibility = validateNvidiaRequestCompatibility(request, meta);
    if (!compatibility.compatible) {
      yield {
        type: 'error',
        requestId: control.requestId,
        failureClass: compatibility.failureClass ?? 'NON_RECOVERABLE',
        error: compatibility.error ?? `Request is incompatible with model '${request.modelId}'`,
      };
      return;
    }

    const messages = formatMessages(request);
    const controller = control.controller;
    const requestId = control.requestId;
    this.inflight.set(requestId, controller);

    const stream = request.stream ?? true;
    const omittedFields = new Set<string>(this.unsupportedModelFields.get(request.modelId) ?? []);
    const retryPolicy = resolveRetryPolicy({
      ...this.defaultRetryPolicy,
      ...request.providerRetryPolicy,
      maxRetries: control.capRetries(
        request.providerRetryPolicy?.maxRetries ?? this.defaultRetryPolicy.maxRetries,
      ),
    });
    const maxAttempts = retryPolicy.maxRetries + 1;

    let res: Response | undefined;
    let lastErrorBody = '';
    let timedOutInFetch = false;

    try {
      // Connect phase: bounded retries ONLY before any response stream bytes are consumed.
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        yield control.startAttempt();
        control.assertActive();
        timedOutInFetch = false;

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const attemptAbort = new AbortController();
        const onParentAbort = () => attemptAbort.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', onParentAbort, { once: true });
        if (controller.signal.aborted) attemptAbort.abort(controller.signal.reason);
        if (this.requestTimeoutMs > 0) {
          timeoutId = setTimeout(() => {
            timedOutInFetch = true;
            attemptAbort.abort(new DOMException('NVIDIA request timed out', 'TimeoutError'));
          }, this.requestTimeoutMs);
        }

        try {
          let body = this.buildRequestBody(request, messages, meta, omittedFields);
          let candidate = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${cred.apiKey}`,
              Accept: stream ? 'text/event-stream' : 'application/json',
            },
            body: JSON.stringify(body),
            signal: attemptAbort.signal,
          });

          // Graceful optional-parameter fallback on HTTP 400 / 422 (never strips required tools/response_format)
          let fallbackCount = 0;
          while ((candidate.status === 400 || candidate.status === 422) && fallbackCount < 4) {
            const errBody = await candidate.text().catch(() => '');
            const criticalRejection = detectCriticalParameterRejection(errBody, body);
            if (criticalRejection) {
              yield {
                type: 'error',
                requestId,
                status: candidate.status,
                failureClass: 'NON_RECOVERABLE',
                rateLimit: readRateLimitHeaders(candidate.headers),
                error: redactProviderSecrets(
                  `NVIDIA model '${request.modelId}' rejected required capability '${criticalRejection}': HTTP ${candidate.status} ${errBody.slice(0, 260)}`,
                  [cred.apiKey],
                ),
              };
              return;
            }
            const unsupportedField = detectUnsupportedParameter(errBody, body);
            if (!unsupportedField || omittedFields.has(unsupportedField)) {
              lastErrorBody = errBody;
              res = candidate;
              break;
            }
            fallbackCount++;
            omittedFields.add(unsupportedField);
            this.unsupportedModelFields.set(request.modelId, new Set(omittedFields));
            body = this.buildRequestBody(request, messages, meta, omittedFields);
            candidate = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cred.apiKey}`,
                Accept: stream ? 'text/event-stream' : 'application/json',
              },
              body: JSON.stringify(body),
              signal: attemptAbort.signal,
            });
          }

          if (res === candidate && !candidate.ok) {
            // Already read lastErrorBody in the 400/422 loop and confirmed non-recoverable
            break;
          }

          if (!candidate.ok) {
            const errBody = await candidate.text().catch(() => '');
            lastErrorBody = errBody;
            const failureClass = classifyHttpFailure(candidate.status, errBody);
            const decision = providerRetryDecision(failureClass, attempt, retryPolicy);
            const retryAfterMs = parseRetryAfterMs(candidate.headers.get('retry-after'));
            const delayMs = retryAfterMs !== undefined
              ? Math.min(Math.max(retryAfterMs, decision.delayMs), retryPolicy.maxDelayMs * 2)
              : decision.delayMs;

            if (decision.retry) {
              yield {
                type: 'retry',
                requestId,
                status: candidate.status,
                failureClass,
                retryAttempt: decision.attempt,
                retryDelayMs: delayMs,
                retryAfterMs,
                rateLimit: readRateLimitHeaders(candidate.headers),
                error: redactProviderSecrets(`HTTP ${candidate.status} ${errBody.slice(0, 200)}`.trim(), [cred.apiKey]),
              };
              await waitForRetry(delayMs, controller.signal);
              continue;
            }
            res = candidate;
            break;
          }

          res = candidate;
          break;
        } catch (err) {
          if (controller.signal.aborted && !timedOutInFetch) {
            yield {
              type: 'error',
              requestId,
              failureClass: 'CANCELLED',
              error: 'cancelled',
            };
            return;
          }
          const failureClass: FailureClass = timedOutInFetch ? 'TIMEOUT' : classifyFailure(err);
          const safeMsg = redactProviderSecrets(
            timedOutInFetch ? `NVIDIA request timed out after ${this.requestTimeoutMs}ms` : err instanceof Error ? err.message : String(err),
            [cred.apiKey],
          );
          const decision = providerRetryDecision(failureClass, attempt, retryPolicy);
          if (decision.retry) {
            yield {
              type: 'retry',
              requestId,
              failureClass,
              retryAttempt: decision.attempt,
              retryDelayMs: decision.delayMs,
              error: safeMsg,
            };
            try {
              await waitForRetry(decision.delayMs, controller.signal);
            } catch {
              yield {
                type: 'error',
                requestId,
                failureClass: 'CANCELLED',
                error: 'cancelled',
              };
              return;
            }
            continue;
          }
          yield {
            type: 'error',
            requestId,
            retryAttempt: attempt,
            failureClass,
            retryExhausted: decision.reason === 'retry_budget_exhausted',
            error: safeMsg,
          };
          return;
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          controller.signal.removeEventListener('abort', onParentAbort);
        }
      }

      if (!res) {
        yield {
          type: 'error',
          requestId,
          failureClass: 'TRANSPORT',
          error: 'NVIDIA request failed to produce a response',
        };
        return;
      }

      if (!res.ok) {
        const safeErrBody = redactProviderSecrets(lastErrorBody, [cred.apiKey]);
        const failureEvent = httpFailureEvent('NVIDIA', res, safeErrBody, requestId);
        const failureClass = failureEvent.failureClass ?? classifyHttpFailure(res.status, safeErrBody);
        yield {
          ...failureEvent,
          failureClass,
          retryExhausted: maxAttempts > 1 && isProviderRetryable(failureClass),
        };
        return;
      }

      const rateLimit = readRateLimitHeaders(res.headers);

      if (!stream) {
        let payload: Record<string, unknown>;
        try {
          payload = (await res.json()) as Record<string, unknown>;
        } catch (err) {
          yield {
            type: 'error',
            requestId,
            failureClass: 'MODEL_PROTOCOL',
            rateLimit,
            error: redactProviderSecrets(
              `INVALID_PROVIDER_RESPONSE: malformed JSON response from NVIDIA (${err instanceof Error ? err.message : String(err)})`,
              [cred.apiKey],
            ),
          };
          return;
        }

        if (payload.error && typeof payload.error === 'object') {
          const errObj = payload.error as Record<string, unknown>;
          const errMsg = typeof errObj.message === 'string' ? errObj.message : JSON.stringify(errObj);
          const errStatus = typeof errObj.code === 'number' ? errObj.code : 500;
          yield {
            type: 'error',
            requestId,
            status: errStatus,
            failureClass: classifyHttpFailure(errStatus, errMsg),
            rateLimit,
            error: redactProviderSecrets(`NVIDIA error payload: ${errMsg}`, [cred.apiKey]),
          };
          return;
        }

        const choices = Array.isArray(payload.choices) ? (payload.choices as Array<Record<string, unknown>>) : [];
        if (choices.length === 0) {
          yield {
            type: 'error',
            requestId,
            failureClass: 'EMPTY_RESPONSE',
            rateLimit,
            error: 'EMPTY_PROVIDER_RESPONSE: NVIDIA response contained no choices',
          };
          return;
        }
        const firstChoice = choices[0] ?? {};
        const message = (firstChoice.message as Record<string, unknown> | undefined) ?? {};
        const reasoningText = typeof message.reasoning_content === 'string'
          ? message.reasoning_content
          : typeof message.reasoning === 'string'
            ? message.reasoning
            : undefined;
        if (reasoningText) {
          yield { type: 'reasoning', requestId, content: reasoningText };
        }
        const contentText = typeof message.content === 'string' ? message.content : undefined;
        if (contentText) {
          yield { type: 'token', requestId, content: contentText };
        }
        const toolCalls = Array.isArray(message.tool_calls)
          ? (message.tool_calls as Array<Record<string, unknown>>)
          : [];
        const validToolCalls: Array<{ id: string; name: string; input: unknown }> = [];
        for (const [idx, tc] of toolCalls.entries()) {
          const fn = (tc.function as Record<string, unknown> | undefined) ?? {};
          const name = typeof fn.name === 'string' ? fn.name.trim() : '';
          if (!name) {
            yield {
              type: 'error',
              requestId,
              failureClass: 'MODEL_PROTOCOL',
              rateLimit,
              error: `INVALID_TOOL_CALL: tool call at index ${idx} is missing function name`,
            };
            return;
          }
          const rawArgs = typeof fn.arguments === 'string' ? fn.arguments.trim() : '';
          let parsedArgs: unknown = {};
          if (rawArgs.length > 0) {
            try {
              parsedArgs = JSON.parse(rawArgs);
            } catch {
              yield {
                type: 'error',
                requestId,
                failureClass: 'MODEL_PROTOCOL',
                rateLimit,
                error: `INVALID_TOOL_CALL_ARGUMENTS: tool '${name}' returned truncated or invalid JSON arguments: ${redactProviderSecrets(rawArgs.slice(0, 160), [cred.apiKey])}`,
              };
              return;
            }
          }
          validToolCalls.push({
            id: typeof tc.id === 'string' && tc.id.trim().length > 0 ? tc.id : `call_${idx}`,
            name,
            input: parsedArgs,
          });
        }

        if (!contentText && !reasoningText && validToolCalls.length === 0) {
          yield {
            type: 'error',
            requestId,
            failureClass: 'EMPTY_RESPONSE',
            rateLimit,
            error: 'EMPTY_PROVIDER_RESPONSE: NVIDIA response contained no content, reasoning, or tool calls',
          };
          return;
        }

        if (request.responseFormat?.type === 'json_object' || request.responseFormat?.type === 'json_schema') {
          if (contentText && validToolCalls.length === 0) {
            try {
              JSON.parse(contentText);
            } catch {
              yield {
                type: 'error',
                requestId,
                failureClass: 'MODEL_PROTOCOL',
                rateLimit,
                error: `INVALID_STRUCTURED_OUTPUT: model '${request.modelId}' returned non-JSON content for responseFormat '${request.responseFormat.type}'`,
              };
              return;
            }
          }
        }

        for (const tc of validToolCalls) {
          yield {
            type: 'tool_call',
            requestId,
            toolCallId: tc.id,
            toolName: tc.name,
            toolInput: tc.input,
          };
        }

        const usage = extractUsage(payload.usage as Record<string, unknown> | undefined, res.headers);
        const finishReason = typeof firstChoice.finish_reason === 'string' ? firstChoice.finish_reason : 'stop';
        yield {
          type: 'completed',
          requestId,
          content: contentText ?? '',
          finishReason,
          ...(usage ? { usage, promptCache: usage.promptCache } : {}),
          rateLimit,
        };
        return;
      }

      if (!res.body) {
        yield {
          type: 'error',
          requestId,
          failureClass: 'MODEL_PROTOCOL',
          rateLimit,
          error: 'NVIDIA response had no body',
        };
        return;
      }

      const toolSlots = new Map<number, { id?: string; name: string; args: string }>();
      let nextUnindexedSlot = 0;
      let usage: Usage | undefined;
      let finishReason: string | undefined;
      let fullContent = '';
      let fullReasoning = '';
      let streamDone = false;
      let chunkCount = 0;

      for await (const data of readSseDataLines(res.body, controller.signal)) {
        control.assertActive();
        if (data === '[DONE]') {
          streamDone = true;
          break;
        }
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(data) as Record<string, unknown>;
        } catch {
          yield {
            type: 'error',
            requestId,
            failureClass: 'MODEL_PROTOCOL',
            rateLimit,
            error: redactProviderSecrets(
              `INVALID_PROVIDER_STREAM: malformed SSE JSON chunk from NVIDIA: ${data.slice(0, 160)}`,
              [cred.apiKey],
            ),
          };
          return;
        }
        chunkCount++;

        // Handle mid-stream error frames emitted by NVIDIA / NIM gateways
        if (chunk.error && typeof chunk.error === 'object') {
          const errObj = chunk.error as Record<string, unknown>;
          const errMsg = typeof errObj.message === 'string'
            ? errObj.message
            : typeof errObj.detail === 'string'
              ? errObj.detail
              : JSON.stringify(errObj);
          const status = typeof errObj.status === 'number'
            ? errObj.status
            : typeof errObj.code === 'number'
              ? errObj.code
              : 500;
          yield {
            type: 'error',
            requestId,
            status,
            failureClass: classifyHttpFailure(status, errMsg),
            rateLimit,
            error: redactProviderSecrets(`NVIDIA stream error: ${errMsg}`, [cred.apiKey]),
          };
          return;
        }
        if (typeof chunk.error === 'string' && chunk.error.trim().length > 0) {
          yield {
            type: 'error',
            requestId,
            failureClass: classifyHttpFailure(500, chunk.error),
            rateLimit,
            error: redactProviderSecrets(`NVIDIA stream error: ${chunk.error}`, [cred.apiKey]),
          };
          return;
        }

        if (chunk.usage && typeof chunk.usage === 'object') {
          const extracted = extractUsage(chunk.usage as Record<string, unknown>, res.headers);
          if (extracted) usage = extracted;
        }

        const choices = Array.isArray(chunk.choices) ? (chunk.choices as Array<Record<string, unknown>>) : [];
        const choice = choices[0];
        if (!choice) continue;

        if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        // Reasoning stream support (Nemotron / DeepSeek delta.reasoning_content)
        const reasoningDelta = typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : undefined;
        if (reasoningDelta && reasoningDelta.length > 0) {
          fullReasoning += reasoningDelta;
          yield { type: 'reasoning', requestId, content: reasoningDelta };
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          fullContent += delta.content;
          yield { type: 'token', requestId, content: delta.content };
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            let idx: number;
            if (typeof tc.index === 'number' && Number.isInteger(tc.index) && tc.index >= 0) {
              idx = tc.index;
              nextUnindexedSlot = Math.max(nextUnindexedSlot, idx + 1);
            } else if (typeof tc.id === 'string' && tc.id.trim().length > 0) {
              // Match existing slot by tool call ID or allocate a new slot if a new ID appears without index
              const existing = [...toolSlots.entries()].find(([, s]) => s.id === tc.id);
              if (existing) {
                idx = existing[0];
              } else {
                idx = nextUnindexedSlot++;
              }
            } else {
              idx = Math.max(0, nextUnindexedSlot - 1);
            }

            let slot = toolSlots.get(idx);
            if (!slot) {
              slot = { name: '', args: '' };
              toolSlots.set(idx, slot);
            }
            if (typeof tc.id === 'string' && tc.id.trim().length > 0) slot.id = tc.id;
            const fn = tc.function as Record<string, unknown> | undefined;
            if (fn) {
              if (typeof fn.name === 'string' && fn.name.length > 0) {
                // Avoid duplicating function name if an endpoint repeats the full name in subsequent chunks
                if (!slot.name) {
                  slot.name = fn.name;
                } else if (fn.name !== slot.name) {
                  slot.name += fn.name;
                }
              }
              if (typeof fn.arguments === 'string') slot.args += fn.arguments;
            }
          }
        }
      }

      // A clean socket EOF without [DONE] or finish_reason is an interrupted/truncated stream.
      // Never report an incomplete stream as completed or dispatch partially streamed tool calls.
      if (!streamDone && !finishReason) {
        yield {
          type: 'error',
          requestId,
          failureClass: 'TRANSPORT',
          rateLimit,
          error: 'INCOMPLETE_PROVIDER_STREAM: stream ended before [DONE] or finish_reason completion marker',
        };
        return;
      }

      // Validate and assemble all streamed tool calls before emitting any tool_call or completed event.
      const assembledToolCalls: Array<{ id: string; name: string; input: unknown }> = [];
      for (const [index, slot] of [...toolSlots.entries()].sort((a, b) => a[0] - b[0])) {
        const trimmedName = slot.name.trim();
        if (!trimmedName) {
          yield {
            type: 'error',
            requestId,
            failureClass: 'MODEL_PROTOCOL',
            rateLimit,
            error: `INVALID_TOOL_CALL_STREAM: tool call at index ${index} streamed arguments without a function name`,
          };
          return;
        }
        const rawArgs = slot.args.trim();
        let parsed: unknown = {};
        if (rawArgs.length > 0) {
          try {
            parsed = JSON.parse(rawArgs);
          } catch {
            yield {
              type: 'error',
              requestId,
              failureClass: 'MODEL_PROTOCOL',
              rateLimit,
              error: `INVALID_TOOL_CALL_ARGUMENTS: tool '${trimmedName}' streamed malformed or truncated JSON arguments: ${redactProviderSecrets(rawArgs.slice(0, 160), [cred.apiKey])}`,
            };
            return;
          }
        }
        assembledToolCalls.push({
          id: slot.id ?? `tool-${index}`,
          name: trimmedName,
          input: parsed,
        });
      }

      // Reject empty stream responses that produced no content, no reasoning, and no tool calls.
      if (chunkCount === 0 || (!fullContent && !fullReasoning && assembledToolCalls.length === 0)) {
        yield {
          type: 'error',
          requestId,
          failureClass: 'EMPTY_RESPONSE',
          rateLimit,
          error: 'EMPTY_PROVIDER_RESPONSE: NVIDIA stream completed without content, reasoning, or tool calls',
        };
        return;
      }

      if (request.responseFormat?.type === 'json_object' || request.responseFormat?.type === 'json_schema') {
        if (fullContent && assembledToolCalls.length === 0) {
          try {
            JSON.parse(fullContent);
          } catch {
            yield {
              type: 'error',
              requestId,
              failureClass: 'MODEL_PROTOCOL',
              rateLimit,
              error: `INVALID_STRUCTURED_OUTPUT: model '${request.modelId}' streamed non-JSON content for responseFormat '${request.responseFormat.type}'`,
            };
            return;
          }
        }
      }

      for (const tc of assembledToolCalls) {
        yield {
          type: 'tool_call',
          requestId,
          toolCallId: tc.id,
          toolName: tc.name,
          toolInput: tc.input,
        };
      }

      yield {
        type: 'completed',
        requestId,
        content: fullContent,
        finishReason: finishReason ?? (assembledToolCalls.length > 0 ? 'tool_calls' : 'stop'),
        ...(usage ? { usage, promptCache: usage.promptCache } : {}),
        rateLimit,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'GenerationLimitError') {
        throw err;
      }
      const isCancelled = controller.signal.aborted && !timedOutInFetch;
      const failureClass: FailureClass = isCancelled
        ? 'CANCELLED'
        : timedOutInFetch
          ? 'TIMEOUT'
          : classifyFailure(err) === 'NON_RECOVERABLE'
            ? 'TRANSPORT'
            : classifyFailure(err);
      const safeMessage = redactProviderSecrets(
        isCancelled ? 'cancelled' : err instanceof Error ? err.message : String(err),
        [cred.apiKey],
      );
      yield {
        type: 'error',
        requestId,
        failureClass,
        error: safeMessage,
      };
    } finally {
      controller.abort();
      this.inflight.delete(requestId);
    }
  }

  async cancel(requestId: string): Promise<void> {
    const c = this.inflight.get(requestId);
    if (c) {
      c.abort();
      this.inflight.delete(requestId);
    }
  }
}

/**
 * Detects if a 400/422 error from an NVIDIA endpoint rejected a *critical* capability
 * (`tools` or `response_format`) so the adapter fails with an actionable error instead of
 * silently stripping required parameters.
 */
function detectCriticalParameterRejection(errBody: string, sentBody: Record<string, unknown>): string | undefined {
  const lower = errBody.toLowerCase();
  if (
    'tools' in sentBody &&
    (lower.includes('tool_calls') ||
      lower.includes('tools is not supported') ||
      lower.includes('function calling is not supported') ||
      lower.includes('does not support tools') ||
      lower.includes('does not support function') ||
      (lower.includes('extra inputs are not permitted') && lower.includes('tools')))
  ) {
    return 'tools';
  }
  if (
    'response_format' in sentBody &&
    (lower.includes('response_format') ||
      lower.includes('json_schema') ||
      lower.includes('structured output is not supported'))
  ) {
    return 'response_format';
  }
  return undefined;
}

function detectUnsupportedParameter(errBody: string, sentBody: Record<string, unknown>): string | undefined {
  const lower = errBody.toLowerCase();
  if (
    'extra_body' in sentBody &&
    (lower.includes('extra_body') || lower.includes('chat_template_kwargs') || lower.includes('enable_thinking'))
  ) {
    return 'extra_body';
  }
  const optionalCandidates = ['parallel_tool_calls', 'stream_options', 'seed', 'tool_choice'];
  for (const field of optionalCandidates) {
    if (field in sentBody && lower.includes(field)) {
      return field;
    }
  }
  return undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function extractUsage(u: Record<string, unknown> | undefined, headers: Headers): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const promptTokens =
    readNonNegativeInteger(u.prompt_tokens) ??
    readNonNegativeInteger(u.input_tokens) ??
    readNonNegativeInteger(u.inputTokens);
  const completionTokens =
    readNonNegativeInteger(u.completion_tokens) ??
    readNonNegativeInteger(u.output_tokens) ??
    readNonNegativeInteger(u.outputTokens);
  if (promptTokens === undefined && completionTokens === undefined) return undefined;

  const promptDetails = (u.prompt_tokens_details ?? u.promptTokensDetails) as Record<string, unknown> | undefined;
  const completionDetails = (u.completion_tokens_details ?? u.completionTokensDetails) as Record<string, unknown> | undefined;
  const cached =
    readNonNegativeInteger(promptDetails?.cached_tokens) ??
    readNonNegativeInteger(promptDetails?.cachedTokens) ??
    readNonNegativeInteger(u.cached_tokens) ??
    readNonNegativeInteger(u.cache_read_tokens);
  const cacheWrite =
    readNonNegativeInteger(promptDetails?.cache_creation_input_tokens) ??
    readNonNegativeInteger(u.cache_write_tokens);
  const reasoning =
    readNonNegativeInteger(completionDetails?.reasoning_tokens) ??
    readNonNegativeInteger(completionDetails?.reasoningTokens) ??
    readNonNegativeInteger(u.reasoning_tokens);
  const inputTokens = promptTokens ?? 0;
  const outputTokens = completionTokens ?? 0;
  const totalTokens = readNonNegativeInteger(u.total_tokens) ?? inputTokens + outputTokens;

  // Ignore meaningless 0/0 usage placeholders emitted on non-final chunks by some OpenAI-compatible gateways
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0 && cached === undefined && reasoning === undefined) {
    return undefined;
  }

  const promptCache = normalizePromptCacheTelemetry({
    provider: 'nvidia',
    inputTokens: promptTokens,
    usage: u,
    headers,
  });

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    promptCache,
  };
}

function formatMessages(request: GenerationRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (request.systemPrompt) {
    out.push({ role: 'system', content: request.systemPrompt });
  }
  for (const m of request.messages) {
    out.push(formatSingleMessage(m));
  }
  if (request.prompt) {
    out.push({ role: 'user', content: request.prompt });
  }
  return out;
}

function formatSingleMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.toolCallId ?? 'call_0',
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
        },
      })),
    };
  }
  if (Array.isArray(m.images) && m.images.length > 0) {
    const contentParts: Array<Record<string, unknown>> = [];
    if (typeof m.content === 'string' && m.content.length > 0) {
      contentParts.push({ type: 'text', text: m.content });
    }
    for (const img of m.images) {
      if (!img?.url) continue;
      const rawUrl = img.url.trim();
      if (!rawUrl) continue;
      const normalizedUrl =
        rawUrl.startsWith('data:') || rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
          ? rawUrl
          : `data:${img.mediaType ?? 'image/png'};base64,${rawUrl}`;
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: normalizedUrl,
          ...(img.detail ? { detail: img.detail } : {}),
        },
      });
    }
    return {
      role: m.role,
      content: contentParts,
      ...(m.name ? { name: m.name } : {}),
    };
  }
  return {
    role: m.role,
    content: m.content,
    ...(m.name ? { name: m.name } : {}),
  };
}

/**
 * Reads SSE `data:` payloads from a ReadableStream, supporting:
 * - Arbitrarily chunked multi-byte UTF-8 sequences
 * - Both `\n` and `\r\n` line endings
 * - Multi-line `data:` lines within a single SSE event frame
 * - Comment/keep-alive lines (`: ping`) and `event:` metadata lines
 * - Immediate cancellation via AbortSignal
 */
async function* readSseDataLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let eventDataLines: string[] = [];

  const flushEvent = (): string | undefined => {
    if (eventDataLines.length === 0) return undefined;
    const joined = eventDataLines.join('\n').trim();
    eventDataLines = [];
    return joined.length > 0 ? joined : undefined;
  };

  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const rawLine = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        const trimmed = rawLine.trim();
        if (trimmed === '') {
          const payload = flushEvent();
          if (payload !== undefined) {
            yield payload;
            if (payload === '[DONE]') return;
          }
          continue;
        }
        if (rawLine.startsWith(':')) {
          // SSE comment / keep-alive heartbeat
          continue;
        }
        if (rawLine.startsWith('data:')) {
          const content = rawLine.slice(5).trimStart();
          if (content === '[DONE]') {
            const prior = flushEvent();
            if (prior !== undefined) yield prior;
            yield '[DONE]';
            return;
          }
          // If the previous data line was already a complete JSON object or [DONE], flush it immediately
          // so endpoints that omit blank lines between `data: {...}\ndata: {...}` frames still stream per-line.
          if (eventDataLines.length > 0) {
            const candidate = eventDataLines.join('\n').trim();
            if (candidate.startsWith('{') && candidate.endsWith('}')) {
              try {
                JSON.parse(candidate);
                const flushed = flushEvent();
                if (flushed !== undefined) yield flushed;
              } catch {
                // Multi-line JSON payload across consecutive data: lines; keep accumulating
              }
            }
          }
          eventDataLines.push(content);
        }
      }
    }
    buf += decoder.decode();
    const tailLines = buf.split(/\r?\n/);
    for (const rawLine of tailLines) {
      if (rawLine.startsWith('data:')) {
        const content = rawLine.slice(5).trimStart();
        if (content === '[DONE]') {
          const prior = flushEvent();
          if (prior !== undefined) yield prior;
          yield '[DONE]';
          return;
        }
        if (eventDataLines.length > 0) {
          const candidate = eventDataLines.join('\n').trim();
          if (candidate.startsWith('{') && candidate.endsWith('}')) {
            try {
              JSON.parse(candidate);
              const flushed = flushEvent();
              if (flushed !== undefined) yield flushed;
            } catch {
              // keep accumulating
            }
          }
        }
        eventDataLines.push(content);
      }
    }
    const finalPayload = flushEvent();
    if (finalPayload !== undefined) {
      yield finalPayload;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore cancel errors on already-closed streams
    }
    reader.releaseLock();
  }
}

export function createNvidiaAdapter(options: NvidiaAdapterOptions = {}): NvidiaAdapter {
  return new NvidiaAdapter(options);
}
