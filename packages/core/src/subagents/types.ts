/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted for Wazir.
 */

export const SUBAGENT_STATUSES = [
  'queued',
  'starting',
  'running',
  'monitoring',
  'waiting',
  'delivering',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];

export const SUBAGENT_FILTERS = [
  'all',
  'running',
  'completed',
  'needsAttention',
] as const;

export type SubagentFilter = (typeof SUBAGENT_FILTERS)[number];

export type SubagentActivity = {
  at: number;
  kind: 'status' | 'message' | 'plan' | 'tool' | 'observation' | 'notification';
  text: string;
};

export type SubagentPermission = {
  requestHandle: string;
  title: string;
  titleTruncated?: boolean;
  backend?: string;
  sessionId?: string;
  details?: string;
  alwaysScope?: string;
  choices: Array<{
    decision: 'allow' | 'deny';
    scope?: 'once' | 'always';
  }>;
};

export const SUBAGENT_STOP_REASONS = [
  'stopping',
  'unsupported',
  'untracked',
  'ended',
] as const;

export type SubagentTask = {
  id: string;
  kind: 'harness' | 'proactive' | 'search' | 'visual' | 'canary' | 'repair';
  title: string;
  status: SubagentStatus;
  createdAt: number;
  updatedAt: number;
  backend?: string;
  sessionId?: string;
  source?: string;
  request: string;
  activity: string;
  output: string;
  outputMessage?: string;
  outputTruncated?: boolean;
  events: SubagentActivity[];
  triggerCount?: number;
  pendingNotifications?: number;
  notification?:
    | 'queued'
    | 'preparing'
    | 'speaking'
    | 'delivered'
    | 'undelivered';
  remainingSec?: number;
  canStop?: boolean;
  stopReason?: (typeof SUBAGENT_STOP_REASONS)[number];
  permissions?: SubagentPermission[];
  permissionsOmitted?: number;
};

export type SubagentsSnapshot = {
  revision: number;
  deliveryRevision?: number;
  reportRevision?: number;
  pendingUnassignedPermissions?: number;
  counts: {
    running: number;
    completed: number;
    needsAttention: number;
    failed: number;
    cancelled: number;
    interrupted: number;
  };
  tasks: SubagentTask[];
  omitted: number;
};

export const MAX_SUBAGENTS_SNAPSHOT_BYTES = 240 * 1024;
export const MAX_SUBAGENT_TASKS = 32;
export const MAX_SUBAGENT_PERMISSIONS = 8;
export const MAX_SUBAGENTS_REQUEST_BYTES = 4 * 1024;
export const MAX_SUBAGENTS_CONTROL_BYTES = 1024 * 1024;
