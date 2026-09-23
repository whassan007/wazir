import type { ChatMessage } from './conversation.js';
import type { ToolDefinition } from '@wazir/runtimes-interfaces';

export interface WorkerInfo {
  id: string;
  computerId: string;
  version: string;
  status: 'online' | 'offline';
  runtimes: string[];
  models: string[];
  lastHeartbeat?: Date;
}

/**
 * An authorized execution request the control plane sends to a worker.
 * Workers execute exactly what they are told — they never schedule.
 */
export interface WorkerExecutionRequest {
  providerRetryPolicy?: Partial<import('@wazir/shared').RetryPolicy>;
  /** Opaque claim fencing token assigned by the control plane. */
  leaseToken?: string;
  executionId: string;
  requestId: string;
  modelId: string;
  runtimeId?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  contextTokens?: number;
  timeoutMs?: number;
}

export type WorkerEventType =
  | 'retry'
  | 'lease_acquired'
  | 'lease_renewed'
  | 'started'
  | 'token'
  | 'tool_call'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkerExecutionEvent {
  executionId: string;
  type: WorkerEventType;
  data?: unknown;
  at: Date;
}
