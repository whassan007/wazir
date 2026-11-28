import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FleetExecutionPlan } from './fleetPlanner.js';

export type FleetStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface FleetOperationRecord {
  id: string;
  summary: string;
  dryRun: boolean;
  status: 'running' | 'completed' | 'failed';
  stepStatuses: Record<number, FleetStepStatus>;
  logs: string[];
  startedAt: string;
  finishedAt?: string;
}

export interface SharedFleetState {
  schemaVersion: number;
  updatedAt: string;
  source: string;
  hosts: Array<{
    id: string;
    name: string;
    online: boolean;
    address?: string;
    latencyMS?: number;
    loadedModels: string[];
    installedModels: string[];
  }>;
}

export function resolveSharedFleetStatePath(wazirHome?: string): string {
  const home = wazirHome || process.env.WAZIR_HOME || path.join(os.homedir(), '.wazir');
  return path.join(home, 'fleet-state.json');
}

export function readSharedFleetState(wazirHome?: string): SharedFleetState | null {
  const filePath = resolveSharedFleetStatePath(wazirHome);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SharedFleetState;
  } catch {
    return null;
  }
}

export function writeSharedFleetState(state: SharedFleetState, wazirHome?: string): string {
  const filePath = resolveSharedFleetStatePath(wazirHome);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return filePath;
}

export function executeFleetPlanDryRun(plan: FleetExecutionPlan): FleetOperationRecord {
  const stepStatuses: Record<number, FleetStepStatus> = {};
  const logs: string[] = [];
  for (const step of plan.steps) {
    stepStatuses[step.id] = 'succeeded';
    logs.push(`[dry-run] step ${step.id}: ${step.title} (${step.detail})`);
  }
  const now = new Date().toISOString();
  return {
    id: plan.id,
    summary: plan.summary,
    dryRun: true,
    status: 'completed',
    stepStatuses,
    logs,
    startedAt: now,
    finishedAt: now,
  };
}
