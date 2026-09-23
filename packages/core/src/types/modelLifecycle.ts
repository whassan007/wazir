export type ContextMode = 'AUTO' | 'EXPLICIT' | 'MAX_SAFE';
export interface ModelLoadOptions {
  computerId?: string;
  runtimeId?: string;
  context?: number;
  mode?: ContextMode;
  fit?: boolean;
  minimumContext?: number;
  evict?: boolean;
  dryRun?: boolean;
  initiator?: string;
  executionId?: string;
  timeoutMs?: number;
}
export interface ResourceReservation {
  id: string;
  instanceId: string;
  memoryBytes: number;
  vramBytes: number;
  createdAt: Date;
  settledAt?: Date;
}
export interface ResourceSnapshot {
  computerId: string;
  totalMemoryBytes: number;
  availableMemoryBytes?: number;
  totalVramBytes?: number;
  availableVramBytes?: number;
  unifiedMemory: boolean;
  cpuUtilization?: number;
  gpuUtilization?: number;
  activeReservations: ResourceReservation[];
  observedAt: Date;
}
export interface LoadEstimate {
  modelId: string;
  computerId: string;
  runtimeId: string;
  requestedContext?: number;
  candidateContext: number;
  weightMemory?: number;
  contextMemory?: number;
  runtimeOverhead?: number;
  estimatedTotalMemory?: number;
  estimatedVram?: number;
  currentlyAvailableMemory?: number;
  safetyReserve: number;
  usableMemory?: number;
  postLoadAvailableMemory?: number;
  estimateSource: 'RUNTIME' | 'HEURISTIC' | 'UNKNOWN';
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  classification: 'SAFE' | 'WARNING' | 'INSUFFICIENT' | 'UNKNOWN';
}
export interface ModelLoadPlan {
  modelId: string;
  installationId: string;
  instanceId: string;
  computerId: string;
  runtimeId: string;
  requestedContext?: number;
  configuredContextLimit?: number;
  modelContextLimit?: number;
  runtimeContextLimit?: number;
  machineSafeContext?: number;
  effectiveContext: number;
  minimumContext: number;
  contextReason?: string;
  resourceSnapshot: ResourceSnapshot;
  estimate: LoadEstimate;
  modelsToEvict: Array<{ instanceId: string; reclaimBytes: number }>;
  reservation?: ResourceReservation;
  reuse: boolean;
  admissionDecision: { status: 'ADMITTED' | 'DENIED'; reasons: string[] };
}
export class ModelLifecycleError extends Error {
  constructor(public readonly code: string, public readonly reasons: string[] = [], public readonly plan?: ModelLoadPlan) {
    super([code, ...reasons].join(': '));
    this.name = 'ModelLifecycleError';
  }
}
