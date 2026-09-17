export interface ResourceState {
  cpuPercent: number;
  memoryUsedGB: number;
  memoryAvailableGB: number;
  gpuUtilizationPercent?: number;
  gpuMemoryUsedGB?: number;
  gpuMemoryAvailableGB?: number;
}

export type RuntimeHealthStatus = 'healthy' | 'unhealthy' | 'unknown' | 'degraded';

export interface RuntimeHealth {
  status: RuntimeHealthStatus;
  message?: string;
}

export interface ModelHealth {
  loaded: boolean;
  loadTimeMs?: number;
  lastUsedAt?: Date;
}

export interface ResourceAvailability {
  computerId: string;
  timestamp: Date;
  resources: ResourceState;
  runtimes: Record<string, RuntimeHealth>;
  models: Record<string, ModelHealth>;
}
