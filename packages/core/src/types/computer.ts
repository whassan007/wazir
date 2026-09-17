import type { ModelHealth, ResourceState, RuntimeHealth } from './resource.js';

export type ComputerType = 'workstation' | 'server' | 'laptop' | 'virtual-machine' | 'remote-worker';
export type ComputerStatus = 'online' | 'offline' | 'maintenance';
export type HealthLevel = 'healthy' | 'degraded' | 'unavailable';

export interface GPUInfo {
  vendor: 'apple' | 'nvidia' | 'amd' | 'intel' | 'unknown';
  model: string;
  memoryGB: number;
  unifiedMemory?: boolean;
  cuda?: boolean;
}

export interface HardwareInfo {
  cpu: string;
  cpuCores: number;
  memoryGB: number;
  gpu?: GPUInfo;
}

export interface OSInfo {
  platform: string;
  architecture: string;
  version: string;
}

export interface NetworkInfo {
  reachable: boolean;
  latencyMs?: number;
}

export interface PolicyRestrictions {
  allowed?: string[];
  denied?: string[];
}

export interface Computer {
  id: string;
  name: string;
  type: ComputerType;
  status: ComputerStatus;
  /** True when this computer is the host running the control plane (used by local-only policy). */
  local: boolean;
  os: OSInfo;
  hardware: HardwareInfo;
  runtimes: string[];
  models: string[];
  capabilities: string[];
  load?: ResourceState;
  runtimeHealth: Record<string, RuntimeHealth>;
  modelHealth: Record<string, ModelHealth>;
  health: HealthLevel;
  network?: NetworkInfo;
  policyRestrictions?: PolicyRestrictions;
  createdAt: Date;
  updatedAt: Date;
  lastHeartbeat?: Date;
}

export interface ComputerRegistration {
  id: string;
  name: string;
  type: ComputerType;
  local?: boolean;
  os: OSInfo;
  hardware: HardwareInfo;
  capabilities?: string[];
  network?: NetworkInfo;
  policyRestrictions?: PolicyRestrictions;
  runtimes?: string[];
  models?: string[];
}
