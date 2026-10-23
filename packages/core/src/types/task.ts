import type { ModelCapability } from './capability.js';

export type TaskType =
  | 'chat'
  | 'coding'
  | 'research'
  | 'review'
  | 'debugging'
  | 'architecture'
  | 'code_analysis'
  | 'document_analysis'
  | 'benchmark'
  | 'evaluation'
  | 'agent';

export type Priority = 'low' | 'normal' | 'high' | 'critical';

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'planning'
  | 'scheduled'
  | 'ready'
  | 'running'
  | 'waiting_for_approval'
  | 'verifying'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export type WorkspaceMode = 'clean' | 'repository' | 'continue' | 'shared';

export interface TaskRequirements {
  /** Agent skills, separate from model inference capabilities. All are required. */
  agentCapabilities?: string[];
  capabilities?: ModelCapability[];
  reasoning?: 'low' | 'medium' | 'high';
  vision?: boolean;
  toolCalling?: boolean;
  minimumContext?: number;
  minimumMemoryGB?: number;
  minimumGPUMemoryGB?: number;
  localOnly?: boolean;
  mutationRequired?: boolean;
  expectedArtifacts?: string[];
  runtimePreset?: string;
  /** Operating system requirement (e.g. 'darwin', 'win32', 'linux', 'macos', 'windows'). */
  os?: string | string[];
  /** CPU architecture requirement (e.g. 'arm64', 'x64'). */
  architecture?: string | string[];
  /** Requires GPU acceleration. */
  requiresGpu?: boolean;
  /** Requires NVIDIA CUDA support. */
  requiresCuda?: boolean;
  /** Specific agent required. */
  agent?: string;
}

export interface PolicyRequirements {
  dataClassification?: 'public' | 'internal' | 'sensitive' | 'restricted';
  localOnly?: boolean;
  allowedComputers?: string[];
  allowedRuntimes?: string[];
  allowedModels?: string[];
  networkAccess?: boolean;
  toolAccess?: boolean;
  allowSubagentDispatch?: boolean;
  maxExecutionTimeSeconds?: number;
  projectRoot?: string;
  /**
   * Explicit opt-in for routing this task to a hosted provider
   * (Anthropic/OpenAI/Google/NVIDIA). Deny-by-default: routing to a hosted-only
   * model requires this to be `true` (directly, or via the engine-wide
   * `PolicyEngineOptions.allowHostedProvidersDefault`) even when `localOnly`
   * is unset. `localOnly: true` or `dataClassification` in
   * ('sensitive'|'restricted') always override this back to `false`,
   * regardless of its value — see `PolicyEngine.checkHostedEligibility()`.
   */
  allowHostedProviders?: boolean;
}

export type RoutingMode =
  | 'AUTO'
  | 'LOCAL_ONLY'
  | 'NVIDIA'
  | 'HYBRID'
  | 'PROVIDER_ONLY'
  | 'FAST'
  | 'BALANCED'
  | 'POWERFUL'
  | 'LOCAL_FIRST'
  | 'LOADED_ONLY'
  | 'STRICT_MODEL'
  | 'CUSTOM'
  | 'COST_AWARE'
  | 'QUALITY_FIRST'
  | 'LATENCY_FIRST'
  | 'auto'
  | 'fast'
  | 'balanced'
  | 'powerful'
  | 'local'
  | 'local_first'
  | 'loaded_only'
  | 'strict_model'
  | 'custom'
  | 'cost_aware'
  | 'quality_first'
  | 'latency_first';

export interface ExecutionPreferences {
  targetComputerId?: string;
  targetRuntimeId?: string;
  targetModelId?: string;
  targetAgentId?: string;
  executionMode?: 'automatic' | 'local' | 'fastest' | 'highestQuality';
  /** Explicit provider/locality routing mode. */
  routingMode?: RoutingMode;
  /** Reasoning effort level ('low' | 'medium' | 'high'). */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Target provider when routingMode is PROVIDER_ONLY (e.g. 'nvidia'). */
  routingProvider?: string;
  /** Preferred default model when targetModelId is not explicitly pinned. */
  defaultModelId?: string;
  /** Whether fallback/escalation to other models is allowed (default: true unless provider_only sets false). */
  allowFallback?: boolean;
  runtimePreset?: string;
}

export interface Task {
  id: string;
  type: TaskType;
  title?: string;
  input: string;
  requirements: TaskRequirements;
  capabilities?: string[];
  expectedEvidence?: string[];
  expectedArtifacts?: string[];
  acceptanceContract?: import('./execution.js').AcceptanceContract;
  mutationRequired?: boolean;
  workspaceMode?: WorkspaceMode;
  contextFrom?: string[];
  policy?: PolicyRequirements;
  execution?: ExecutionPreferences;
  /** Per-task override of the agent's model-turn budget; falls back to the runner/agent default. */
  maxTurns?: number;
  /** Per-task override of the agent's repair-cycle budget; falls back to the agent default. */
  maxRepairCycles?: number;
  /** Per-task override of the job-level retry budget; falls back to `job.maxRetries`. */
  maxRetries?: number;
  priority: Priority;
  status: TaskStatus;
  createdAt: Date;
  updatedAt?: Date;
  completedAt?: Date;
}
