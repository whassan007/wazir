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

export interface TaskRequirements {
  capabilities?: ModelCapability[];
  reasoning?: 'low' | 'medium' | 'high';
  vision?: boolean;
  toolCalling?: boolean;
  minimumContext?: number;
  minimumMemoryGB?: number;
  minimumGPUMemoryGB?: number;
  localOnly?: boolean;
}

export interface PolicyRequirements {
  dataClassification?: 'public' | 'internal' | 'sensitive' | 'restricted';
  localOnly?: boolean;
  allowedComputers?: string[];
  allowedRuntimes?: string[];
  allowedModels?: string[];
  networkAccess?: boolean;
  toolAccess?: boolean;
  maxExecutionTimeSeconds?: number;
  projectRoot?: string;
}

export interface ExecutionPreferences {
  targetComputerId?: string;
  targetRuntimeId?: string;
  targetModelId?: string;
  targetAgentId?: string;
  executionMode?: 'automatic' | 'local' | 'fastest' | 'highestQuality';
}

export interface Task {
  id: string;
  type: TaskType;
  title?: string;
  input: string;
  requirements: TaskRequirements;
  capabilities?: string[];
  expectedEvidence?: string[];
  contextFrom?: string[];
  policy?: PolicyRequirements;
  execution?: ExecutionPreferences;
  priority: Priority;
  status: TaskStatus;
  createdAt: Date;
  updatedAt?: Date;
  completedAt?: Date;
}
