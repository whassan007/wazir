import {
  ModelLifecycleError,
  type ExecutionRecord,
  type ModelLoadOptions,
  type ModelLoadPlan,
} from '@wazir/core';
import { color } from '../colors.js';

export { table } from './table.js';

export function gib(bytes?: number): string {
  return bytes === undefined ? 'unknown' : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function formatAge(timestamp: Date): string {
  const diff = Date.now() - timestamp.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

export interface LifecycleCommandOptions {
  json?: boolean;
  wait?: boolean;
  computer?: string;
  runtime?: string;
  context?: string | number;
  fit?: boolean;
  evict?: boolean;
  dryRun?: boolean;
  drain?: boolean;
}

export function lifecycleOptions(options: LifecycleCommandOptions): ModelLoadOptions {
  const raw = options.context;
  let context: number | undefined;
  let mode: ModelLoadOptions['mode'] = 'AUTO';
  if (raw !== undefined) {
    if (String(raw).toLowerCase() === 'max-safe') mode = 'MAX_SAFE';
    else if (String(raw).toLowerCase() !== 'auto') {
      const match = String(raw).match(/^(\d+)(k)?$/i);
      if (!match) throw new ModelLifecycleError('CONTEXT_TOO_LARGE', ['invalid --context']);
      context = Number(match[1]) * (match[2] ? 1024 : 1);
      mode = 'EXPLICIT';
      if (!Number.isSafeInteger(context) || context <= 0) throw new ModelLifecycleError('CONTEXT_TOO_LARGE');
    }
  }
  return {
    computerId: options.computer,
    runtimeId: options.runtime,
    context,
    mode,
    fit: options.fit,
    evict: options.evict,
    dryRun: options.dryRun,
    initiator: 'cli',
    timeoutMs: options.wait ? 120_000 : undefined,
  };
}

export function formatModelLoadPlan(plan: ModelLoadPlan): string {
  const e = plan.estimate;
  return [
    'MODEL LOAD PLAN',
    '',
    `Model               ${plan.modelId}`,
    `Target              ${plan.computerId} / ${plan.runtimeId}`,
    '',
    'Resources',
    `  Available         ${gib(e.currentlyAvailableMemory)}`,
    `  Safety reserve    ${gib(e.safetyReserve)}`,
    `  Usable            ${gib(e.usableMemory)}`,
    '',
    'Context',
    `  Requested         ${plan.requestedContext ?? 'AUTO'}`,
    `  Model maximum     ${plan.modelContextLimit ?? 'unknown'}`,
    `  Runtime maximum   ${plan.runtimeContextLimit ?? 'unknown'}`,
    `  Machine safe      ${plan.machineSafeContext ?? 'unknown'}`,
    `  Selected          ${plan.effectiveContext}`,
    ...(plan.contextReason ? [`  Reason            ${plan.contextReason}`] : []),
    '',
    'Estimate',
    `  Weights           ${gib(e.weightMemory)}`,
    `  Context           ${gib(e.contextMemory)}`,
    `  Runtime overhead  ${gib(e.runtimeOverhead)}`,
    `  Total             ${gib(e.estimatedTotalMemory)}`,
    `  Source            ${e.estimateSource} (${e.confidence})`,
    '',
    `Admission           ${plan.admissionDecision.status}`,
    ...plan.admissionDecision.reasons.map((r) => `  ${r}`),
    ...plan.modelsToEvict.map((v) => `  Evict ${v.instanceId}: estimated reclaim ${gib(v.reclaimBytes)}`),
  ].join('\n');
}

export function formatTaskStatusRecord(
  record: ExecutionRecord | undefined,
  id: string,
  options?: { json?: boolean },
): { code: number; output: string } {
  if (!record) {
    const msg = `Task or execution '${id}' not found`;
    return {
      code: 1,
      output: options?.json ? JSON.stringify({ error: msg, id }) : color.red(msg),
    };
  }
  const payload = {
    id: record.task.id,
    executionId: record.execution.id,
    status: record.execution.status,
    type: record.task.type,
    agentId: record.execution.agentId,
    modelId: record.execution.modelId,
    runtimeId: record.execution.runtimeId,
    computerId: record.execution.computerId ?? null,
    createdAt: record.execution.createdAt,
    completedAt: record.execution.completedAt ?? null,
    filesChanged: record.filesChanged,
    errors: record.errors,
    result: record.result ?? null,
  };
  if (options?.json) {
    return { code: 0, output: JSON.stringify(payload, null, 2) };
  }
  const lines = [
    color.bold(`Task ${payload.id} (execution ${payload.executionId})`),
    `  status:    ${payload.status}`,
    `  type:      ${payload.type}`,
    `  agent:     ${payload.agentId}`,
    `  model:     ${payload.modelId} via ${payload.runtimeId}`,
    `  computer:  ${payload.computerId ?? 'hosted'}`,
    `  files:     ${payload.filesChanged.length}`,
  ];
  if (payload.errors.length > 0) {
    lines.push(`  errors:    ${payload.errors.join('; ')}`);
  }
  return { code: 0, output: lines.join('\n') };
}
