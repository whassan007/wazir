/**
 * Wazir Meta-Harness Canonical Contracts (v1)
 *
 * Defines the 8 distinct infrastructure & execution entities, the 11-state
 * real-execution server acceptance state machine, declarative ExecutionPlan
 * schema types (wazir.dev/v1), 4-quantity allocation & queue accounting,
 * 4-state continuous reconciliation, and 4-pillar observability reports.
 */

export type AcceptanceState =
  | 'DISCOVERED'
  | 'REACHABLE'
  | 'API_READY'
  | 'MODEL_READY'
  | 'EXECUTION_VERIFIED'
  | 'CAPACITY_VERIFIED'
  | 'SATURATED'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'DISABLED_BY_POLICY'
  | 'UNKNOWN';

export type NetworkVisibilityScope =
  | 'loopback_only'
  | 'ssh_tunnel_forwarded'
  | 'lan'
  | 'tailscale'
  | 'cloud_api';

export type DiscoveryProvenance =
  | 'local_introspection'
  | 'registered_worker'
  | 'authorized_ssh'
  | 'tailscale_probe'
  | 'configured_endpoint'
  | 'runtime_discovery'
  | 'cloud_provider_api';

export interface PhysicalGpuDevice {
  gpuId: string; // Stable physical UUID (e.g. GPU-4d4d5fec-...) or host-scoped apple-gpu-0
  index: number;
  vendor: 'nvidia' | 'apple' | 'amd' | 'intel' | 'unknown';
  model: string;
  driverVersion?: string;
  cudaVersion?: string;
  metalSupported?: boolean;
  mpsSupported?: boolean;
  unifiedMemory: boolean;
  totalMemoryGB: number;
  availableMemoryGB?: number;
  usedMemoryGB?: number;
  utilizationPercent?: number;
  temperatureCelsius?: number;
}

export interface WorkloadConflict {
  pid?: number;
  processName: string;
  kind: 'simulation' | 'rendering' | 'training' | 'inference' | 'other';
  gpuId?: string;
  reservedVramGB: number;
  reservedRamGB: number;
  doNotInterrupt: boolean;
}

export interface CpuTopologyInfo {
  brand: string;
  architecture: string;
  logicalCores: number;
  physicalCores?: number;
  performanceCores?: number;
  efficiencyCores?: number;
  utilizationPercent: number;
}

export interface MemoryInventoryInfo {
  totalGB: number;
  availableGB: number;
  usedGB: number;
  unifiedMemory: boolean;
  pressureLevel: 'normal' | 'warn' | 'critical' | 'unknown';
  reservedBySystemGB: number;
  reservedByUserGB: number;
}

export interface DiskInventoryInfo {
  mountPoint: string;
  totalGB: number;
  freeGB: number;
  usedPercent: number;
}

/**
 * Entity 1: Physical Host (independent of IP address, hostname, or installed services).
 */
export interface PhysicalHostNode {
  kind: 'physical_host';
  machineId: string; // Stable hardware UUID hash independent of IP/hostname
  hostId: string; // Logical alias such as 'dgx_spark', 'mac_studio', 'macbook_pro'
  hostname: string;
  aliases: string[];
  os: {
    platform: 'linux' | 'darwin' | 'win32' | string;
    release: string;
    architecture: string;
    appleSiliconGeneration?: string;
  };
  cpu: CpuTopologyInfo;
  gpus: PhysicalGpuDevice[];
  memory: MemoryInventoryInfo;
  disk: DiskInventoryInfo;
  thermalState?: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
  networkIdentityIds: string[];
  localWorkerAvailable: boolean;
  workerIds: string[];
  runtimeIds: string[];
  workloadConflicts: WorkloadConflict[];
  resourceReservationsGB: {
    ramGB: number;
    vramByGpuId: Record<string, number>;
  };
  lastDiscoveredAt: string;
  provenance: DiscoveryProvenance[];
  confidence: number; // 0.0 .. 1.0
}

/**
 * Entity 2: Network Identity.
 */
export interface NetworkIdentityNode {
  kind: 'network_identity';
  networkId: string;
  hostId: string;
  machineId: string;
  address: string;
  scope: 'loopback' | 'lan' | 'tailscale' | 'ssh' | 'cloud';
  interfaceName?: string;
  sshTarget?: string;
  authorized: boolean;
}

/**
 * Entity 3: Execution Worker.
 */
export interface ExecutionWorkerNode {
  kind: 'execution_worker';
  workerId: string;
  hostId: string;
  machineId: string;
  status: 'online' | 'degraded' | 'offline';
  capabilities: string[];
  supportedTools: string[];
  browserCapable: boolean;
  lastHeartbeatAt: string;
  version: string;
}

/**
 * Entity 4: Runtime Process.
 */
export interface RuntimeProcessNode {
  kind: 'runtime_process';
  processNodeId: string;
  runtimeId: string;
  hostId: string;
  machineId: string;
  runtimeType: 'lmstudio' | 'ollama' | 'vllm' | 'openai-compatible' | 'llama-cpp' | 'other';
  version: string;
  pid?: number;
  running: boolean;
  /** Optional secondary role so an intentionally stopped secondary daemon does not mark the host unhealthy. */
  role: 'primary' | 'secondary';
}

/**
 * Explicit secure transport (such as an SSH local forward) bridging an origin host to a target host's loopback.
 */
export interface ConfiguredSecureTransport {
  transportId: string;
  type: 'ssh_tunnel' | 'worker_relay' | 'tailscale_direct';
  originHostId: string;
  localEndpointUrl: string;
  targetHostId: string;
  remoteLoopbackUrl: string;
  sshHostAlias?: string;
  verifiedActive: boolean;
}

/**
 * Entity 5: Inference API Endpoint (explicitly tracks network execution context).
 */
export interface InferenceEndpointNode {
  kind: 'inference_endpoint';
  endpointId: string;
  runtimeId: string;
  hostId: string; // Physical host where the inference engine actually executes
  machineId: string;
  rawUrl: string; // URL as configured on the host (e.g. http://127.0.0.1:1234/v1 on mac_studio)
  originContextHostId: string; // Machine from which `rawUrl` is valid (crucial for 127.0.0.1!)
  visibility: NetworkVisibilityScope;
  transport: 'http' | 'https' | 'ssh_tunnel' | 'worker_rpc';
  tunnelTransportId?: string;
  apiCompatibility: Array<'openai_chat' | 'lmstudio_v0' | 'ollama_native' | 'vllm_openai'>;
  acceptanceState: AcceptanceState;
  diagnosticMessage?: string;
  lastVerifiedAt?: string;
}

export interface EndpointResolutionResult {
  usable: boolean;
  callerHostId: string;
  targetHostId: string;
  resolvedUrl?: string;
  routeVia: 'direct' | 'local_loopback' | 'ssh_tunnel' | 'remote_worker' | 'cloud_api' | 'unreachable_loopback';
  reason: string;
}

/**
 * Entity 6: Loaded / Installed Model Node.
 */
export interface LoadedModelNode {
  kind: 'model_node';
  modelNodeId: string;
  modelId: string;
  runtimeId: string;
  hostId?: string; // Absent for cloud provider-managed models
  providerId?: string;
  residency: 'loaded' | 'installed_not_loaded' | 'provider_managed';
  parameterBillions?: number;
  isMoE: boolean;
  quantization?: string;
  estimatedWeightsGB: number;
  runtimeOverheadGB: number;
  kvCachePerSlotGB: number;
  maxContextTokens: number;
  loadedContextTokens?: number;
  capabilities: string[];
  toolCallingSupported: boolean;
  toolCallingVerified: boolean;
  visionSupported: boolean;
  measuredTokensPerSecond?: number;
  measuredFirstTokenLatencyMs?: number;
  measuredEndToEndLatencyMs?: number;
  lastSuccessfulInferenceAt?: string;
}

/**
 * Entity 7: Cloud Coding-Agent Provider (no fabricated GPU/RAM or invented quotas).
 */
export interface CodingAgentProviderNode {
  kind: 'coding_agent_provider';
  providerId: string; // 'antigravity' | 'codex' | 'claude' | 'openai' | 'google' | 'nvidia' | 'opencode'
  displayName: string;
  enabled: boolean;
  disabledByPolicy: boolean;
  authStatus: 'authenticated' | 'cli_available' | 'unauthenticated' | 'disabled' | 'unknown';
  authMethod?: 'api_key' | 'oauth' | 'cli_session' | 'coordinator_channel' | 'none';
  supportedModelsOrModes: string[];
  taskCapabilities: string[];
  toolSupport: boolean;
  artifactSupport: boolean;
  /** Only populated when actually exposed by provider headers or explicit user config — never invented. */
  exposedQuotas?: {
    requestsLimit?: number;
    requestsRemaining?: number;
    tokensLimit?: number;
    tokensRemaining?: number;
    resetAt?: string;
    source: 'provider_headers' | 'user_configured';
  };
  observedConcurrency: number;
  configuredMaxConcurrent: number;
  estimatedCostPer1kInputUsd?: number;
  estimatedCostPer1kOutputUsd?: number;
  estimatedLatencyMs?: number;
  dataHandling: {
    allowsConfidentialRepo: boolean;
    zeroDataRetention?: boolean;
    restrictedPathsBlocked: boolean;
  };
  acceptanceState: AcceptanceState;
  lastAcceptedRequestAt?: string;
  diagnostic?: string;
}

/**
 * Entity 8: Agent Execution Slot.
 */
export interface AgentExecutionSlotNode {
  kind: 'agent_execution_slot';
  slotId: string;
  poolId: string;
  slotIndex: number;
  targetKind: 'local_host' | 'cloud_provider';
  hostId?: string;
  gpuId?: string;
  runtimeId?: string;
  providerId?: string;
  state: 'idle' | 'reserved' | 'running' | 'saturated' | 'disabled';
  assignedLogicalAgentId?: string;
  assignedTaskId?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  reservedRamGB: number;
  reservedVramGB: number;
}

export interface CapabilityGraph {
  schemaVersion: 'wazir.capability-graph/v1';
  generatedAt: string;
  coordinatorHostId: string;
  hosts: Record<string, PhysicalHostNode>;
  networkIdentities: Record<string, NetworkIdentityNode>;
  workers: Record<string, ExecutionWorkerNode>;
  runtimeProcesses: Record<string, RuntimeProcessNode>;
  endpoints: Record<string, InferenceEndpointNode>;
  transports: Record<string, ConfiguredSecureTransport>;
  models: Record<string, LoadedModelNode>;
  cloudProviders: Record<string, CodingAgentProviderNode>;
  executionSlots: Record<string, AgentExecutionSlotNode>;
}

export interface RuntimeVerificationEvidence {
  evidenceId: string;
  runtimeId: string;
  hostId?: string;
  providerId?: string;
  endpointUrl: string;
  modelId?: string;
  state: AcceptanceState;
  httpStatus?: number;
  connectivityOk: boolean;
  modelsEnumerated: boolean;
  modelLoadedConfirmed: boolean;
  inferenceExecuted: boolean;
  responseContractValid: boolean;
  toolCallTested: boolean;
  toolCallPassed?: boolean;
  cancellationTested: boolean;
  cancellationPassed?: boolean;
  startupLatencyMs?: number;
  firstTokenLatencyMs?: number;
  endToEndLatencyMs?: number;
  tokensPerSecond?: number;
  verifiedAt: string;
  error?: string;
}

export interface ConcurrencyQualificationResult {
  runtimeId: string;
  hostId?: string;
  modelId: string;
  testedConcurrencyLevels: number[];
  verifiedSafeConcurrency: number;
  acceptedRequests: number;
  successfulCompletions: number;
  inFlightPeak: number;
  queuedPeak: number;
  firstTokenLatencyMsP50?: number;
  endToEndLatencyMsP50: number;
  endToEndLatencyMsP95: number;
  tokensPerSecondAggregate?: number;
  gpuMemoryUsedPeakGB?: number;
  memoryExhaustionDetected: boolean;
  errorRate: number;
  timeoutRate: number;
  recoveredAfterLoad: boolean;
  state: AcceptanceState;
  qualifiedAt: string;
  evidenceId: string;
}

/**
 * Declarative ExecutionPlan Schema (apiVersion: wazir.dev/v1, kind: ExecutionPlan).
 */
export type RoutingStrategyName =
  | 'local_first'
  | 'fastest_verified'
  | 'lowest_expected_cost'
  | 'highest_qualified_success'
  | 'strict_provider_allocation'
  | 'capability_cost_latency';

export interface ExecutionPlanPoolSpec {
  id: string;
  share: number; // Percentage 0..100; enabled pools must sum to 100
  enabled: boolean;
  host?: string;
  provider?: string;
  preferred_runtime?: string;
  preferred_model?: string;
  fallback_model?: string;
  max_concurrent: number;
  agent_prefix?: string; // e.g. D, M, L, A, X
}

export interface DeclarativeExecutionPlan {
  apiVersion: 'wazir.dev/v1';
  kind: 'ExecutionPlan';
  metadata: {
    name: string;
    version: number;
    description?: string;
  };
  spec: {
    goal: string;
    execution: {
      mode: 'autonomous' | 'supervised' | 'dry_run';
      total_agents: number;
      speed_optimization?: boolean;
      queue_when_saturated: boolean;
      verify_outputs: boolean;
      recover_failures: boolean;
      max_repair_attempts: number;
      budget_usd?: number;
      timeout_ms?: number;
    };
    discovery: {
      refresh_before_execution: boolean;
      authorized_hosts_only: boolean;
      probe_runtimes: boolean;
      enumerate_models: boolean;
      test_real_inference: boolean;
    };
    pools: ExecutionPlanPoolSpec[];
    routing: {
      strategy: RoutingStrategyName;
      preserve_disabled_pools: boolean;
      strict_shares?: boolean;
      dynamic_health_checks: boolean;
      verify_execution_capability: boolean;
      require_resource_admission: boolean;
      fallback_policy: 'none' | 'compatible_authorized_pool' | 'local_only';
      prevent_gpu_double_counting: boolean;
      constraints?: string[];
    };
    qualification: {
      enabled: boolean;
      real_execution_required: boolean;
      independent_verification: boolean;
      evidence_required: boolean;
    };
  };
}

/**
 * Four distinct allocation/execution quantities per pool (Part 3.3).
 */
export interface PoolAllocationQuantities {
  poolId: string;
  enabled: boolean;
  targetSharePct: number;
  targetAllocation: number; // 1. Target allocation
  feasibleAllocation: number;
  admittedAgents: number; // 2. Admitted agents (running + queued after admission)
  runningAgents: number; // 3. Currently running agents (strictly <= verified safe capacity)
  queuedAgents: number; // Waiting in observable queue
  completedAgents: number; // 4. Independently verified completions
  failedAgents: number;
  configuredMaxConcurrent: number;
  verifiedSafeConcurrent?: number;
  effectiveConcurrentLimit: number;
  assignedLogicalAgentIds: string[];
  reroutedFromPools?: string[];
  unavailabilityReason?: string;
}

export interface ServerAcceptanceRow {
  pool: string;
  host: string;
  endpoint: string;
  runtime: string;
  model: string;
  targetSharePct: number;
  assigned: number;
  admitted: number;
  running: number;
  queued: number;
  completed: number;
  failed: number;
  capacity: number;
  configuredMaxConcurrent: number;
  verifiedConcurrency?: number;
  status: AcceptanceState;
  lastVerifiedAt?: string;
  evidenceIds: string[];
  diagnostic?: string;
}

export interface HardUserConstraints {
  disabledProviders: string[];
  localMachinesOnly: boolean;
  paidCloudAllowed: boolean;
  neverSendRepoToCloud: boolean;
  pinnedPoolShares: Record<string, number>;
  protectedWorkloads: string[]; // e.g. ['isaac_sim']
  preferredModelFamily?: string; // e.g. 'qwen'
  maxBudgetUsd?: number;
}

export interface ClassifiedTaskProfile {
  taskId: string;
  title: string;
  taskType: 'coding' | 'formatting' | 'architecture' | 'testing' | 'browser_e2e' | 'cuda_gpu' | 'mac_ui' | 'verification' | 'research';
  requiredTools: string[];
  requiredOs?: 'linux' | 'darwin' | 'win32';
  requiresNvidiaCuda: boolean;
  requiresBrowser: boolean;
  minimumMemoryGB: number;
  requiredContextTokens: number;
  expectedDurationMs: number;
  requiredCapabilities: string[];
  requiresRepoAccess: boolean;
  dataSensitivity: 'public' | 'internal' | 'restricted_local_only';
  maxCostUsd?: number;
  dependsOn: string[];
  verificationCriteria: string[];
  priority: number;
}

export interface DurableTaskLease {
  taskId: string;
  logicalAgentId: string;
  poolId: string;
  workerId: string;
  hostId?: string;
  runtimeId: string;
  modelId: string;
  epoch: number;
  leaseToken: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface DurableManagedTask {
  taskId: string;
  logicalAgentId: string;
  assignedPoolId: string;
  executedPoolId?: string;
  profile: ClassifiedTaskProfile;
  state: 'pending_dependencies' | 'queued' | 'admitted' | 'running' | 'verifying' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  maxAttempts: number;
  lease?: DurableTaskLease;
  checkpointId?: string;
  idempotencyReceiptHash?: string;
  outputSummary?: string;
  changedFiles?: string[];
  verificationPassed?: boolean;
  verificationEvidenceId?: string;
  startedAt?: string;
  completedAt?: string;
  latencyMs?: number;
  cloudCostUsd: number;
  error?: string;
}

/**
 * Part 6: Four-State Continuous Reconciliation Snapshot.
 */
export interface ReconciliationSnapshot {
  reconciledAt: string;
  sequence: number;
  desired: {
    planName: string;
    requestedAgents: number;
    effectiveAgents: number;
    speedOptimized: boolean;
    poolTargets: Record<string, number>;
    constraints: HardUserConstraints;
  };
  discovered: {
    hostCount: number;
    onlineHostIds: string[];
    unreachableHostIds: string[];
    runtimeCount: number;
    loadedModelIdsByHost: Record<string, string[]>;
  };
  verified: {
    acceptanceByPool: Record<string, AcceptanceState>;
    verifiedConcurrencyByPool: Record<string, number>;
    lastVerifiedAtByPool: Record<string, string | undefined>;
  };
  actual: {
    quantitiesByPool: Record<string, PoolAllocationQuantities>;
    totalRunning: number;
    totalQueued: number;
    totalCompleted: number;
    totalFailed: number;
    healthySaturationPools: string[];
  };
  detectedEvents: Array<{
    at: string;
    kind:
      | 'MODEL_UNLOADED'
      | 'RUNTIME_RESTARTED'
      | 'WORKER_DISAPPEARED'
      | 'GPU_BUSY'
      | 'CLOUD_RATE_LIMITED'
      | 'QUEUED_TASK_READY'
      | 'NEW_MACHINE_AVAILABLE'
      | 'RUNTIME_RECOVERED'
      | 'STALE_INVENTORY_INVALIDATED';
    targetId: string;
    detail: string;
  }>;
}

/**
 * Part 9: Machine-Readable Execution & Qualification Report.
 */
export interface MachineReadableExecutionReport {
  plan: string;
  reportMode: 'CONFIGURATION_ONLY' | 'LIVE_OBSERVED_EXECUTION';
  generatedAt: string;
  allocation: {
    requested_agents: number;
    assigned_agents: number;
    speed_optimized_active_agents?: number;
    configured_concurrency_limit: number;
    verified_concurrency_limit?: number;
  };
  pools: Record<
    string,
    {
      target_share: number;
      assigned_agents: number;
      configured_max_concurrent: number;
      enabled: boolean;
      // Live observed fields (only populated after discovery/acceptance/execution — never fabricated!)
      observed?: {
        physical_hardware_id?: string;
        host_summary?: string;
        endpoint?: string;
        runtime_health: AcceptanceState;
        actual_model_id?: string;
        verified_concurrency?: number;
        admitted_tasks: number;
        running_tasks: number;
        queued_tasks: number;
        completed_tasks: number;
        failed_requests: number;
        avg_latency_ms?: number;
        tokens_per_second?: number;
        verified_at?: string;
        evidence_artifact_ids: string[];
      };
    }
  >;
  cost_and_utilization?: {
    cloud_provider_cost_usd: number;
    local_hardware_utilization_pct: Record<string, number>;
    operational_overhead_ms: number;
  };
  qualification: {
    status:
      | 'PENDING_LIVE_VERIFICATION'
      | 'EXECUTION_VERIFIED'
      | 'QUALIFICATION_PASSED'
      | 'DEGRADED_PARTIAL'
      | 'FAILED';
    journeys_passed?: string[];
    acceptance_tests_passed?: string[];
    evidence_artifacts?: string[];
  };
}
