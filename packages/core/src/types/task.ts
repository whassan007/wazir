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
  | 'planning'
  | 'scheduled'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export type WorkspaceMode = 'clean' | 'repository' | 'continue' | 'shared';

export interface TaskRequirements {
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
   * (Anthropic/OpenAI/Google). Deny-by-default: routing to a hosted-only
   * model requires this to be `true` (directly, or via the engine-wide
   * `PolicyEngineOptions.allowHostedProvidersDefault`) even when `localOnly`
   * is unset. `localOnly: true` or `dataClassification` in
   * ('sensitive'|'restricted') always override this back to `false`,
   * regardless of its value — see `PolicyEngine.checkHostedEligibility()`.
   */
  allowHostedProviders?: boolean;
}

export interface ExecutionPreferences {
  targetComputerId?: string;
  targetRuntimeId?: string;
  targetModelId?: string;
  targetAgentId?: string;
  executionMode?: 'automatic' | 'local' | 'fastest' | 'highestQuality';
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
  priority: Priority;
  status: TaskStatus;
  createdAt: Date;
  updatedAt?: Date;
  completedAt?: Date;
}
