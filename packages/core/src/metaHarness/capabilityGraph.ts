import type {
  AcceptanceState,
  AgentExecutionSlotNode,
  CapabilityGraph,
  CodingAgentProviderNode,
  ConfiguredSecureTransport,
  DiscoveryProvenance,
  ExecutionWorkerNode,
  InferenceEndpointNode,
  LoadedModelNode,
  NetworkIdentityNode,
  PhysicalGpuDevice,
  PhysicalHostNode,
  RuntimeProcessNode,
  WorkloadConflict,
} from './types.js';
import { classifyUrlVisibility, isLoopbackUrl } from './networkContext.js';

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

export function estimateParameterBillionsFromId(modelId: string, explicitParams?: string | number): {
  parameterBillions?: number;
  activeParameterBillions?: number;
  isMoE: boolean;
} {
  if (typeof explicitParams === 'number' && Number.isFinite(explicitParams) && explicitParams > 0) {
    const isMoE = /a\d+(\.\d+)?b|moe|mixtral|agentworld|coder-next/i.test(modelId);
    return { parameterBillions: explicitParams, isMoE };
  }
  const combined = `${explicitParams ?? ''} ${modelId}`;
  const moeMatch = combined.match(/(\d+(?:\.\d+)?)\s*b[-_ ]a(\d+(?:\.\d+)?)\s*b/i);
  if (moeMatch) {
    return {
      parameterBillions: Number.parseFloat(moeMatch[1]),
      activeParameterBillions: Number.parseFloat(moeMatch[2]),
      isMoE: true,
    };
  }
  const paramMatch = combined.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*b(?:[^a-z0-9]|$)/i);
  const parameterBillions = paramMatch ? Number.parseFloat(paramMatch[1]) : undefined;
  const isMoE = /moe|mixtral|agentworld|qwen3-coder-next/i.test(combined);
  return { parameterBillions, isMoE };
}

export function estimateFootprintForModel(params: {
  modelId: string;
  parameterBillions?: number;
  quantization?: string;
  weightBytes?: number;
  contextTokens?: number;
}): {
  estimatedWeightsGB: number;
  runtimeOverheadGB: number;
  kvCachePerSlotGB: number;
} {
  const quant = (params.quantization ?? params.modelId).toLowerCase();
  const bytesPerParam =
    /fp16|bf16|f16/.test(quant)
      ? 2.0
      : /q8|8bit|int8|fp8/.test(quant)
        ? 1.05
        : /q6/.test(quant)
          ? 0.82
          : /q5/.test(quant)
            ? 0.72
            : /q3|3bit/.test(quant)
              ? 0.48
              : 0.62; // Q4 default

  let estimatedWeightsGB = 0;
  if (typeof params.weightBytes === 'number' && params.weightBytes > 0) {
    estimatedWeightsGB = round2(params.weightBytes / (1024 ** 3));
  } else if (typeof params.parameterBillions === 'number' && params.parameterBillions > 0) {
    estimatedWeightsGB = round2(params.parameterBillions * bytesPerParam);
  } else {
    estimatedWeightsGB = 4.0;
  }

  const runtimeOverheadGB = round2(Math.max(0.6, Math.min(4.0, estimatedWeightsGB * 0.08)));
  const ctxScale = Math.max(1, (params.contextTokens ?? 8192) / 8192);
  const paramRef = params.parameterBillions ?? Math.max(4, estimatedWeightsGB / bytesPerParam);
  const baseKvPer8k = paramRef >= 65 ? 1.6 : paramRef >= 25 ? 0.9 : paramRef >= 12 ? 0.55 : 0.3;
  const kvCachePerSlotGB = round2(baseKvPer8k * ctxScale);

  return { estimatedWeightsGB, runtimeOverheadGB, kvCachePerSlotGB };
}

export interface CloudProviderDiscoveryInput {
  providerId: 'antigravity' | 'codex' | 'claude' | 'openai' | 'google' | 'nvidia' | 'opencode' | string;
  displayName?: string;
  enabled?: boolean;
  disabledByPolicy?: boolean;
  authStatus?: CodingAgentProviderNode['authStatus'];
  authMethod?: CodingAgentProviderNode['authMethod'];
  supportedModelsOrModes?: string[];
  taskCapabilities?: string[];
  toolSupport?: boolean;
  artifactSupport?: boolean;
  exposedQuotas?: CodingAgentProviderNode['exposedQuotas'];
  observedConcurrency?: number;
  configuredMaxConcurrent?: number;
  estimatedCostPer1kInputUsd?: number;
  estimatedCostPer1kOutputUsd?: number;
  estimatedLatencyMs?: number;
  allowsConfidentialRepo?: boolean;
  zeroDataRetention?: boolean;
  restrictedPathsBlocked?: boolean;
  acceptanceState?: AcceptanceState;
  lastAcceptedRequestAt?: string;
  diagnostic?: string;
}

export interface DiscoverCloudProvidersOptions {
  env?: Record<string, string | undefined>;
  disabledProviders?: string[];
  cliAvailability?: Partial<Record<string, boolean>>;
  coordinatorChannelActive?: boolean;
  overrides?: Record<string, Partial<CloudProviderDiscoveryInput>>;
}

const DEFAULT_CLOUD_PROVIDER_CATALOG: Array<{
  providerId: string;
  displayName: string;
  envKeys: string[];
  cliName?: string;
  defaultAuthMethod: CodingAgentProviderNode['authMethod'];
  supportedModelsOrModes: string[];
  taskCapabilities: string[];
  toolSupport: boolean;
  artifactSupport: boolean;
  configuredMaxConcurrent: number;
  estimatedCostPer1kInputUsd?: number;
  estimatedCostPer1kOutputUsd?: number;
  allowsConfidentialRepo: boolean;
}> = [
  {
    providerId: 'antigravity',
    displayName: 'Gemini Antigravity Cloud',
    envKeys: ['ANTIGRAVITY_SESSION', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    cliName: 'agy',
    defaultAuthMethod: 'coordinator_channel',
    supportedModelsOrModes: ['inherit', 'pro', 'flash', 'flash_lite'],
    taskCapabilities: ['architecture', 'coding', 'mac_ui', 'verification', 'research'],
    toolSupport: true,
    artifactSupport: true,
    configuredMaxConcurrent: 4,
    allowsConfidentialRepo: true,
  },
  {
    providerId: 'codex',
    displayName: 'OpenAI Codex Agent',
    envKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    cliName: 'codex',
    defaultAuthMethod: 'cli_session',
    supportedModelsOrModes: ['codex-mini-latest', 'gpt-5-codex'],
    taskCapabilities: ['testing', 'verification', 'coding', 'browser_e2e'],
    toolSupport: true,
    artifactSupport: false,
    configuredMaxConcurrent: 2,
    allowsConfidentialRepo: true,
  },
  {
    providerId: 'claude',
    displayName: 'Anthropic Claude',
    envKeys: ['ANTHROPIC_API_KEY'],
    cliName: 'claude',
    defaultAuthMethod: 'none',
    supportedModelsOrModes: [],
    taskCapabilities: [],
    toolSupport: true,
    artifactSupport: false,
    configuredMaxConcurrent: 0,
    allowsConfidentialRepo: false,
  },
  {
    providerId: 'openai',
    displayName: 'OpenAI API',
    envKeys: ['OPENAI_API_KEY'],
    defaultAuthMethod: 'api_key',
    supportedModelsOrModes: ['gpt-4.1', 'o4-mini'],
    taskCapabilities: ['coding', 'testing', 'research'],
    toolSupport: true,
    artifactSupport: false,
    configuredMaxConcurrent: 4,
    allowsConfidentialRepo: false,
  },
  {
    providerId: 'google',
    displayName: 'Google Gemini API',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    defaultAuthMethod: 'api_key',
    supportedModelsOrModes: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    taskCapabilities: ['architecture', 'coding', 'research'],
    toolSupport: true,
    artifactSupport: false,
    configuredMaxConcurrent: 4,
    allowsConfidentialRepo: false,
  },
  {
    providerId: 'nvidia',
    displayName: 'NVIDIA NIM Cloud API',
    envKeys: ['NVIDIA_API_KEY', 'NGC_API_KEY'],
    defaultAuthMethod: 'api_key',
    supportedModelsOrModes: ['nvidia/llama-3.3-nemotron-super-49b-v1'],
    taskCapabilities: ['coding', 'cuda_gpu', 'research'],
    toolSupport: true,
    artifactSupport: false,
    configuredMaxConcurrent: 4,
    allowsConfidentialRepo: false,
  },
  {
    providerId: 'opencode',
    displayName: 'OpenCode CLI Agent',
    envKeys: ['OPENCODE_API_KEY'],
    cliName: 'opencode',
    defaultAuthMethod: 'cli_session',
    supportedModelsOrModes: ['default'],
    taskCapabilities: ['coding', 'formatting'],
    toolSupport: true,
    artifactSupport: false,
    configuredMaxConcurrent: 2,
    allowsConfidentialRepo: true,
  },
];

/**
 * Builds the 8-entity Wazir Meta-Harness `CapabilityGraph`, strictly deduplicating
 * physical machines by `machineId` so multiple runtimes or network paths on the same
 * hardware attach to a single `PhysicalHostNode`.
 */
export class CapabilityGraphBuilder {
  private readonly coordinatorHostId: string;
  private readonly hostsById = new Map<string, PhysicalHostNode>();
  private readonly hostIdByMachineId = new Map<string, string>();
  private readonly hostIdByAlias = new Map<string, string>();
  private readonly networkIdentities = new Map<string, NetworkIdentityNode>();
  private readonly workers = new Map<string, ExecutionWorkerNode>();
  private readonly runtimeProcesses = new Map<string, RuntimeProcessNode>();
  private readonly endpoints = new Map<string, InferenceEndpointNode>();
  private readonly transports = new Map<string, ConfiguredSecureTransport>();
  private readonly models = new Map<string, LoadedModelNode>();
  private readonly cloudProviders = new Map<string, CodingAgentProviderNode>();
  private readonly executionSlots = new Map<string, AgentExecutionSlotNode>();

  constructor(options: { coordinatorHostId?: string } = {}) {
    this.coordinatorHostId = options.coordinatorHostId ?? 'local-coordinator';
  }

  private resolveCanonicalHostId(hostIdOrAlias?: string, machineId?: string): string | undefined {
    if (machineId && this.hostIdByMachineId.has(machineId)) {
      return this.hostIdByMachineId.get(machineId);
    }
    if (hostIdOrAlias) {
      if (this.hostsById.has(hostIdOrAlias)) return hostIdOrAlias;
      const byAlias = this.hostIdByAlias.get(hostIdOrAlias.toLowerCase());
      if (byAlias) return byAlias;
    }
    return hostIdOrAlias;
  }

  /**
   * Inserts or merges a physical host, deduplicating strictly by `machineId` so two runtimes
   * or addresses on the same physical machine NEVER create two `PhysicalHostNode` entries.
   */
  upsertHost(host: PhysicalHostNode): PhysicalHostNode {
    const existingHostId = this.hostIdByMachineId.get(host.machineId);
    if (!existingHostId) {
      const cloned: PhysicalHostNode = {
        ...host,
        kind: 'physical_host',
        aliases: [...new Set([host.hostname, ...host.aliases].filter(Boolean))],
        gpus: host.gpus.map((g) => ({ ...g })),
        networkIdentityIds: [...new Set(host.networkIdentityIds)],
        workerIds: [...new Set(host.workerIds)],
        runtimeIds: [...new Set(host.runtimeIds)],
        workloadConflicts: host.workloadConflicts.map((c) => ({ ...c })),
        resourceReservationsGB: {
          ramGB: host.resourceReservationsGB.ramGB,
          vramByGpuId: { ...host.resourceReservationsGB.vramByGpuId },
        },
        provenance: [...new Set(host.provenance)],
      };
      this.hostsById.set(cloned.hostId, cloned);
      this.hostIdByMachineId.set(cloned.machineId, cloned.hostId);
      this.hostIdByAlias.set(cloned.hostId.toLowerCase(), cloned.hostId);
      if (cloned.hostname) {
        this.hostIdByAlias.set(cloned.hostname.toLowerCase(), cloned.hostId);
      }
      for (const alias of cloned.aliases) {
        this.hostIdByAlias.set(alias.toLowerCase(), cloned.hostId);
      }
      return cloned;
    }

    const canonical = this.hostsById.get(existingHostId)!;
    const mergedAliases = new Set<string>([
      ...canonical.aliases,
      host.hostId,
      host.hostname,
      ...host.aliases,
    ].filter(Boolean));
    canonical.aliases = [...mergedAliases];
    for (const alias of canonical.aliases) {
      this.hostIdByAlias.set(alias.toLowerCase(), canonical.hostId);
    }

    canonical.networkIdentityIds = [...new Set([...canonical.networkIdentityIds, ...host.networkIdentityIds])];
    canonical.workerIds = [...new Set([...canonical.workerIds, ...host.workerIds])];
    canonical.runtimeIds = [...new Set([...canonical.runtimeIds, ...host.runtimeIds])];
    canonical.provenance = [...new Set([...canonical.provenance, ...host.provenance])] as DiscoveryProvenance[];
    canonical.localWorkerAvailable = canonical.localWorkerAvailable || host.localWorkerAvailable;

    // Prefer higher-confidence hardware telemetry without EVER summing total RAM or GPU VRAM
    if (host.confidence >= canonical.confidence && host.memory.totalGB > 0) {
      canonical.cpu = { ...host.cpu };
      canonical.memory = { ...host.memory };
      canonical.disk = host.disk.totalGB > 0 ? { ...host.disk } : canonical.disk;
      canonical.os = { ...host.os };
      canonical.thermalState = host.thermalState ?? canonical.thermalState;
      canonical.confidence = Math.max(canonical.confidence, host.confidence);
      canonical.lastDiscoveredAt = host.lastDiscoveredAt;
    }

    // Deduplicate physical GPUs by gpuId (never duplicate VRAM across two discovery paths)
    const gpuById = new Map<string, PhysicalGpuDevice>();
    for (const g of canonical.gpus) gpuById.set(g.gpuId, g);
    for (const g of host.gpus) {
      const prev = gpuById.get(g.gpuId);
      gpuById.set(g.gpuId, prev ? { ...prev, ...g, totalMemoryGB: g.totalMemoryGB || prev.totalMemoryGB } : { ...g });
    }
    canonical.gpus = [...gpuById.values()];

    // Deduplicate workload conflicts by pid + processName
    const conflictByKey = new Map<string, WorkloadConflict>();
    for (const c of [...canonical.workloadConflicts, ...host.workloadConflicts]) {
      const key = `${c.pid ?? 'nopid'}:${c.processName}:${c.gpuId ?? 'nogpu'}`;
      conflictByKey.set(key, { ...c });
    }
    canonical.workloadConflicts = [...conflictByKey.values()];

    // Recompute non-overlapping reservations (max rather than sum for same GPU)
    canonical.resourceReservationsGB.ramGB = Math.max(
      canonical.resourceReservationsGB.ramGB,
      host.resourceReservationsGB.ramGB,
    );
    for (const [gpuId, vram] of Object.entries(host.resourceReservationsGB.vramByGpuId)) {
      canonical.resourceReservationsGB.vramByGpuId[gpuId] = Math.max(
        canonical.resourceReservationsGB.vramByGpuId[gpuId] ?? 0,
        vram,
      );
    }

    return canonical;
  }

  addNetworkIdentity(identity: NetworkIdentityNode): NetworkIdentityNode {
    const canonicalHostId = this.resolveCanonicalHostId(identity.hostId, identity.machineId) ?? identity.hostId;
    const host = this.hostsById.get(canonicalHostId);
    const normalized: NetworkIdentityNode = {
      ...identity,
      kind: 'network_identity',
      hostId: canonicalHostId,
      machineId: host?.machineId ?? identity.machineId,
    };
    this.networkIdentities.set(normalized.networkId, normalized);
    if (host && !host.networkIdentityIds.includes(normalized.networkId)) {
      host.networkIdentityIds.push(normalized.networkId);
    }
    this.hostIdByAlias.set(normalized.address.toLowerCase(), canonicalHostId);
    return normalized;
  }

  addWorker(worker: ExecutionWorkerNode): ExecutionWorkerNode {
    const canonicalHostId = this.resolveCanonicalHostId(worker.hostId, worker.machineId) ?? worker.hostId;
    const host = this.hostsById.get(canonicalHostId);
    const normalized: ExecutionWorkerNode = {
      ...worker,
      kind: 'execution_worker',
      hostId: canonicalHostId,
      machineId: host?.machineId ?? worker.machineId,
    };
    this.workers.set(normalized.workerId, normalized);
    if (host) {
      if (!host.workerIds.includes(normalized.workerId)) {
        host.workerIds.push(normalized.workerId);
      }
      if (normalized.status === 'online' && canonicalHostId === this.coordinatorHostId) {
        host.localWorkerAvailable = true;
      }
    }
    return normalized;
  }

  addRuntimeProcess(runtimeProcess: RuntimeProcessNode): RuntimeProcessNode {
    const canonicalHostId =
      this.resolveCanonicalHostId(runtimeProcess.hostId, runtimeProcess.machineId) ?? runtimeProcess.hostId;
    const host = this.hostsById.get(canonicalHostId);
    const normalized: RuntimeProcessNode = {
      ...runtimeProcess,
      kind: 'runtime_process',
      hostId: canonicalHostId,
      machineId: host?.machineId ?? runtimeProcess.machineId,
    };
    this.runtimeProcesses.set(normalized.processNodeId, normalized);
    if (host && !host.runtimeIds.includes(normalized.runtimeId)) {
      host.runtimeIds.push(normalized.runtimeId);
    }
    return normalized;
  }

  addTransport(transport: ConfiguredSecureTransport): ConfiguredSecureTransport {
    const originHostId = this.resolveCanonicalHostId(transport.originHostId) ?? transport.originHostId;
    const targetHostId = this.resolveCanonicalHostId(transport.targetHostId) ?? transport.targetHostId;
    const normalized: ConfiguredSecureTransport = {
      ...transport,
      originHostId,
      targetHostId,
    };
    this.transports.set(normalized.transportId, normalized);
    return normalized;
  }

  addEndpoint(
    endpoint: Omit<InferenceEndpointNode, 'kind' | 'visibility'> & {
      kind?: 'inference_endpoint';
      visibility?: InferenceEndpointNode['visibility'];
    },
  ): InferenceEndpointNode {
    const canonicalHostId = this.resolveCanonicalHostId(endpoint.hostId, endpoint.machineId) ?? endpoint.hostId;
    const canonicalOriginHostId =
      this.resolveCanonicalHostId(endpoint.originContextHostId) ?? endpoint.originContextHostId;
    const host = this.hostsById.get(canonicalHostId);
    const hasTunnel = Boolean(endpoint.tunnelTransportId) || (isLoopbackUrl(endpoint.rawUrl) && canonicalOriginHostId !== canonicalHostId);
    const visibility = endpoint.visibility ?? classifyUrlVisibility(endpoint.rawUrl, hasTunnel);

    const normalized: InferenceEndpointNode = {
      ...endpoint,
      kind: 'inference_endpoint',
      hostId: canonicalHostId,
      originContextHostId: canonicalOriginHostId,
      machineId: host?.machineId ?? endpoint.machineId,
      visibility,
    };
    this.endpoints.set(normalized.endpointId, normalized);
    if (host && !host.runtimeIds.includes(normalized.runtimeId)) {
      host.runtimeIds.push(normalized.runtimeId);
    }
    return normalized;
  }

  addModel(
    model: Omit<LoadedModelNode, 'kind' | 'estimatedWeightsGB' | 'runtimeOverheadGB' | 'kvCachePerSlotGB' | 'isMoE'> & {
      kind?: 'model_node';
      estimatedWeightsGB?: number;
      runtimeOverheadGB?: number;
      kvCachePerSlotGB?: number;
      isMoE?: boolean;
      weightBytes?: number;
    },
  ): LoadedModelNode {
    const canonicalHostId = model.hostId ? (this.resolveCanonicalHostId(model.hostId) ?? model.hostId) : undefined;
    const paramMeta = estimateParameterBillionsFromId(model.modelId, model.parameterBillions);
    const footprint = estimateFootprintForModel({
      modelId: model.modelId,
      parameterBillions: model.parameterBillions ?? paramMeta.parameterBillions,
      quantization: model.quantization,
      weightBytes: model.weightBytes,
      contextTokens: model.loadedContextTokens ?? model.maxContextTokens,
    });

    const normalized: LoadedModelNode = {
      kind: 'model_node',
      modelNodeId: model.modelNodeId,
      modelId: model.modelId,
      runtimeId: model.runtimeId,
      hostId: canonicalHostId,
      providerId: model.providerId,
      residency: model.residency,
      parameterBillions: model.parameterBillions ?? paramMeta.parameterBillions,
      isMoE: model.isMoE ?? paramMeta.isMoE,
      quantization: model.quantization,
      estimatedWeightsGB:
        model.residency === 'provider_managed' ? 0 : (model.estimatedWeightsGB ?? footprint.estimatedWeightsGB),
      runtimeOverheadGB:
        model.residency === 'provider_managed' ? 0 : (model.runtimeOverheadGB ?? footprint.runtimeOverheadGB),
      kvCachePerSlotGB:
        model.residency === 'provider_managed' ? 0 : (model.kvCachePerSlotGB ?? footprint.kvCachePerSlotGB),
      maxContextTokens: model.maxContextTokens,
      loadedContextTokens: model.loadedContextTokens,
      capabilities: [...model.capabilities],
      toolCallingSupported: model.toolCallingSupported,
      toolCallingVerified: model.toolCallingVerified,
      visionSupported: model.visionSupported,
      measuredTokensPerSecond: model.measuredTokensPerSecond,
      measuredFirstTokenLatencyMs: model.measuredFirstTokenLatencyMs,
      measuredEndToEndLatencyMs: model.measuredEndToEndLatencyMs,
      lastSuccessfulInferenceAt: model.lastSuccessfulInferenceAt,
    };
    this.models.set(normalized.modelNodeId, normalized);
    return normalized;
  }

  /**
   * Registers a cloud coding-agent provider truthfully without fabricating local GPU/RAM or quotas.
   */
  addCloudProvider(input: CloudProviderDiscoveryInput): CodingAgentProviderNode {
    const disabledByPolicy = Boolean(input.disabledByPolicy);
    const enabled = disabledByPolicy ? false : (input.enabled ?? true);
    const acceptanceState: AcceptanceState = disabledByPolicy
      ? 'DISABLED_BY_POLICY'
      : !enabled
        ? 'UNAVAILABLE'
        : (input.acceptanceState ?? 'DISCOVERED');

    const node: CodingAgentProviderNode = {
      kind: 'coding_agent_provider',
      providerId: input.providerId,
      displayName: input.displayName ?? input.providerId,
      enabled,
      disabledByPolicy,
      authStatus: disabledByPolicy ? 'disabled' : (input.authStatus ?? 'unknown'),
      authMethod: disabledByPolicy ? 'none' : input.authMethod,
      supportedModelsOrModes: disabledByPolicy ? [] : [...(input.supportedModelsOrModes ?? [])],
      taskCapabilities: disabledByPolicy ? [] : [...(input.taskCapabilities ?? [])],
      toolSupport: input.toolSupport ?? true,
      artifactSupport: input.artifactSupport ?? false,
      // Never invent provider quotas: only attach when explicitly supplied from real headers or user config.
      exposedQuotas: input.exposedQuotas ? { ...input.exposedQuotas } : undefined,
      observedConcurrency: disabledByPolicy ? 0 : (input.observedConcurrency ?? 0),
      configuredMaxConcurrent: disabledByPolicy ? 0 : (input.configuredMaxConcurrent ?? 1),
      estimatedCostPer1kInputUsd: input.estimatedCostPer1kInputUsd,
      estimatedCostPer1kOutputUsd: input.estimatedCostPer1kOutputUsd,
      estimatedLatencyMs: input.estimatedLatencyMs,
      dataHandling: {
        allowsConfidentialRepo: input.allowsConfidentialRepo ?? false,
        zeroDataRetention: input.zeroDataRetention,
        restrictedPathsBlocked: input.restrictedPathsBlocked ?? true,
      },
      acceptanceState,
      lastAcceptedRequestAt: input.lastAcceptedRequestAt,
      diagnostic: disabledByPolicy
        ? (input.diagnostic ?? `Provider '${input.providerId}' is strictly disabled by policy (0% share)`)
        : input.diagnostic,
    };
    this.cloudProviders.set(node.providerId, node);
    return node;
  }

  /**
   * Discovers standard cloud coding-agent providers (`antigravity`, `codex`, `claude`, `openai`,
   * `google`, `nvidia`, `opencode`) truthfully from environment/CLI signals while enforcing policy disables.
   */
  discoverCloudProviders(options: DiscoverCloudProvidersOptions = {}): CodingAgentProviderNode[] {
    const env = options.env ?? (process.env as Record<string, string | undefined>);
    const disabledSet = new Set((options.disabledProviders ?? ['claude']).map((p) => p.toLowerCase()));
    const coordinatorActive = options.coordinatorChannelActive ?? true;
    const discovered: CodingAgentProviderNode[] = [];

    for (const spec of DEFAULT_CLOUD_PROVIDER_CATALOG) {
      const override = options.overrides?.[spec.providerId] ?? {};
      const isDisabledByPolicy =
        override.disabledByPolicy ?? disabledSet.has(spec.providerId.toLowerCase());

      if (isDisabledByPolicy) {
        discovered.push(
          this.addCloudProvider({
            providerId: spec.providerId,
            displayName: spec.displayName,
            enabled: false,
            disabledByPolicy: true,
            authStatus: 'disabled',
            authMethod: 'none',
            configuredMaxConcurrent: 0,
            acceptanceState: 'DISABLED_BY_POLICY',
            diagnostic: `Provider '${spec.providerId}' is disabled by Forge Sovereign-5 policy (0 slots)`,
            ...override,
          }),
        );
        continue;
      }

      const hasApiKey = spec.envKeys.some((k) => Boolean(env[k]?.trim()));
      const hasCli = spec.cliName ? Boolean(options.cliAvailability?.[spec.cliName]) : false;

      let authStatus: CodingAgentProviderNode['authStatus'] = 'unauthenticated';
      let authMethod: CodingAgentProviderNode['authMethod'] = spec.defaultAuthMethod;
      let acceptanceState: AcceptanceState = 'UNAVAILABLE';
      let enabled = false;

      if (spec.providerId === 'antigravity' && coordinatorActive) {
        authStatus = 'authenticated';
        authMethod = 'coordinator_channel';
        acceptanceState = 'API_READY';
        enabled = true;
      } else if (hasApiKey) {
        authStatus = 'authenticated';
        authMethod = 'api_key';
        acceptanceState = 'DISCOVERED';
        enabled = true;
      } else if (hasCli) {
        authStatus = 'cli_available';
        authMethod = 'cli_session';
        acceptanceState = 'DISCOVERED';
        enabled = true;
      }

      discovered.push(
        this.addCloudProvider({
          providerId: spec.providerId,
          displayName: spec.displayName,
          enabled,
          disabledByPolicy: false,
          authStatus,
          authMethod,
          supportedModelsOrModes: spec.supportedModelsOrModes,
          taskCapabilities: spec.taskCapabilities,
          toolSupport: spec.toolSupport,
          artifactSupport: spec.artifactSupport,
          configuredMaxConcurrent: spec.configuredMaxConcurrent,
          estimatedCostPer1kInputUsd: spec.estimatedCostPer1kInputUsd,
          estimatedCostPer1kOutputUsd: spec.estimatedCostPer1kOutputUsd,
          allowsConfidentialRepo: spec.allowsConfidentialRepo,
          acceptanceState,
          ...override,
        }),
      );
    }
    return discovered;
  }

  addExecutionSlot(slot: AgentExecutionSlotNode): AgentExecutionSlotNode {
    const canonicalHostId = slot.hostId ? (this.resolveCanonicalHostId(slot.hostId) ?? slot.hostId) : undefined;
    const normalized: AgentExecutionSlotNode = {
      ...slot,
      kind: 'agent_execution_slot',
      hostId: canonicalHostId,
    };
    this.executionSlots.set(normalized.slotId, normalized);
    return normalized;
  }

  build(): CapabilityGraph {
    const toRecord = <T>(map: Map<string, T>): Record<string, T> => {
      const out: Record<string, T> = {};
      for (const [k, v] of map.entries()) {
        out[k] = v;
      }
      return out;
    };

    return {
      schemaVersion: 'wazir.capability-graph/v1',
      generatedAt: new Date().toISOString(),
      coordinatorHostId: this.resolveCanonicalHostId(this.coordinatorHostId) ?? this.coordinatorHostId,
      hosts: toRecord(this.hostsById),
      networkIdentities: toRecord(this.networkIdentities),
      workers: toRecord(this.workers),
      runtimeProcesses: toRecord(this.runtimeProcesses),
      endpoints: toRecord(this.endpoints),
      transports: toRecord(this.transports),
      models: toRecord(this.models),
      cloudProviders: toRecord(this.cloudProviders),
      executionSlots: toRecord(this.executionSlots),
    };
  }
}

export interface SharedGpuAdmissionOptions {
  /** Fraction of physical VRAM/UMA reserved as OOM safety headroom (default 0.05 = 5%). */
  safetyHeadroomRatio?: number;
  /** Minimum fixed safety headroom in GB (default 1.0 GB). */
  minSafetyHeadroomGB?: number;
  /** Explicit protected workload substrings (e.g. ['isaac_sim', 'carla']). */
  protectedWorkloads?: string[];
}

export interface GpuSlotAdmissionRequest {
  slotId: string;
  poolId: string;
  slotIndex?: number;
  hostId: string;
  runtimeId: string;
  modelId: string;
  gpuId?: string;
  logicalAgentId?: string;
  taskId?: string;
  requiredWeightsGB?: number;
  runtimeOverheadGB?: number;
  kvCachePerSlotGB?: number;
  isAlreadyLoaded?: boolean;
  safetyHeadroomGB?: number;
}

export interface GpuSlotAdmissionDecision {
  admitted: boolean;
  slot?: AgentExecutionSlotNode;
  hostId: string;
  gpuId: string;
  unifiedMemory: boolean;
  alreadyResident: boolean;
  chargedWeightsGB: number;
  chargedOverheadGB: number;
  chargedKvCacheGB: number;
  totalChargedGB: number;
  remainingUsableGB: number;
  protectedConflictNames: string[];
  reason: string;
}

export interface GpuBudgetSummary {
  hostId: string;
  machineId: string;
  gpuId: string;
  unifiedMemory: boolean;
  totalMemoryGB: number;
  baselineUsedGB: number;
  protectedWorkloadReservedGB: number;
  safetyHeadroomGB: number;
  admittedWeightsAndOverheadGB: number;
  admittedKvCacheGB: number;
  totalReservedByControllerGB: number;
  usableFreeGB: number;
  activeSlotCount: number;
  sharedRuntimeIds: string[];
  activeConflicts: WorkloadConflict[];
}

interface ActiveSlotAccounting {
  slotId: string;
  poolId: string;
  hostId: string;
  gpuPoolKey: string;
  gpuId: string;
  unifiedMemory: boolean;
  runtimeId: string;
  modelId: string;
  modelKey: string;
  chargedWeightsGB: number;
  chargedOverheadGB: number;
  chargedKvCacheGB: number;
}

interface ColdLoadedModelAccounting {
  modelKey: string;
  gpuPoolKey: string;
  weightsGB: number;
  overheadGB: number;
  slotIds: Set<string>;
}

/**
 * Shared physical GPU VRAM / Unified Memory admission controller across ALL runtimes
 * (`ollama`, `lmstudio`, `vllm`) and protected simulation/training workloads (`isaac-sim`, `CarlaUE4`, etc.)
 * executing on the same physical device.
 */
export class SharedGpuAdmissionController {
  private readonly safetyHeadroomRatio: number;
  private readonly minSafetyHeadroomGB: number;
  private readonly protectedSubstrings: string[];
  private readonly activeSlots = new Map<string, ActiveSlotAccounting>();
  private readonly coldLoadedModels = new Map<string, ColdLoadedModelAccounting>();

  constructor(
    private readonly graph: CapabilityGraph,
    options: SharedGpuAdmissionOptions = {},
  ) {
    this.safetyHeadroomRatio = options.safetyHeadroomRatio ?? 0.05;
    this.minSafetyHeadroomGB = options.minSafetyHeadroomGB ?? 1.0;
    this.protectedSubstrings = (options.protectedWorkloads ?? []).map((s) => s.toLowerCase());
  }

  private resolveTargetGpu(host: PhysicalHostNode, requestedGpuId?: string): {
    gpuId: string;
    gpuPoolKey: string;
    unifiedMemory: boolean;
    totalMemoryGB: number;
    observedUsedGB: number;
  } {
    const unified = host.memory.unifiedMemory || host.gpus.some((g) => g.unifiedMemory);
    if (unified) {
      const gpu = (requestedGpuId ? host.gpus.find((g) => g.gpuId === requestedGpuId) : host.gpus[0]);
      const gpuId = gpu?.gpuId ?? `${host.hostId}-uma-0`;
      const totalMemoryGB = host.memory.totalGB || gpu?.totalMemoryGB || 0;
      const observedAvailableGB =
        host.memory.availableGB > 0 || host.memory.usedGB > 0
          ? host.memory.availableGB
          : Math.max(0, totalMemoryGB - host.memory.usedGB);
      const observedUsedGB = Math.max(0, round2(totalMemoryGB - observedAvailableGB));
      // All unified-memory allocations on this machine share ONE physical memory pool
      return {
        gpuId,
        gpuPoolKey: `${host.machineId}::UMA`,
        unifiedMemory: true,
        totalMemoryGB,
        observedUsedGB,
      };
    }

    const gpu =
      (requestedGpuId ? host.gpus.find((g) => g.gpuId === requestedGpuId) : undefined) ?? host.gpus[0];
    if (!gpu) {
      const totalMemoryGB = host.memory.totalGB;
      const observedUsedGB = Math.max(0, round2(totalMemoryGB - host.memory.availableGB));
      return {
        gpuId: `${host.hostId}-cpu-ram`,
        gpuPoolKey: `${host.machineId}::RAM`,
        unifiedMemory: false,
        totalMemoryGB,
        observedUsedGB,
      };
    }

    const totalMemoryGB = gpu.totalMemoryGB;
    let observedUsedGB = 0;
    if (typeof gpu.usedMemoryGB === 'number' && Number.isFinite(gpu.usedMemoryGB)) {
      observedUsedGB = gpu.usedMemoryGB;
    } else if (typeof gpu.availableMemoryGB === 'number' && Number.isFinite(gpu.availableMemoryGB)) {
      observedUsedGB = Math.max(0, totalMemoryGB - gpu.availableMemoryGB);
    }
    return {
      gpuId: gpu.gpuId,
      gpuPoolKey: `${host.machineId}::GPU::${gpu.gpuId}`,
      unifiedMemory: false,
      totalMemoryGB,
      observedUsedGB: round2(observedUsedGB),
    };
  }

  private getProtectedConflictsForPool(
    host: PhysicalHostNode,
    gpuId: string,
    unifiedMemory: boolean,
  ): { conflicts: WorkloadConflict[]; reservedGB: number } {
    const matching = host.workloadConflicts.filter((c) => {
      const matchesGpu = unifiedMemory || !c.gpuId || c.gpuId === gpuId;
      if (!matchesGpu) return false;
      const namedProtected = this.protectedSubstrings.some((sub) =>
        c.processName.toLowerCase().replace(/[-_]/g, '').includes(sub.replace(/[-_]/g, '')),
      );
      return c.doNotInterrupt || namedProtected;
    });

    const conflictsSumGB = matching.reduce(
      (sum, c) => sum + (unifiedMemory ? Math.max(c.reservedVramGB, c.reservedRamGB) : c.reservedVramGB),
      0,
    );
    const explicitGpuReserved = unifiedMemory
      ? Math.max(
          host.resourceReservationsGB.ramGB,
          Object.values(host.resourceReservationsGB.vramByGpuId).reduce((s, v) => s + v, 0),
        )
      : (host.resourceReservationsGB.vramByGpuId[gpuId] ?? 0);

    return {
      conflicts: matching,
      // Take max so identical reservations reported in both workloadConflicts and resourceReservationsGB are never double-counted
      reservedGB: round2(Math.max(conflictsSumGB, explicitGpuReserved)),
    };
  }

  private getBaselineResidentModelsGB(hostId: string, unifiedMemory: boolean): number {
    let sum = 0;
    for (const model of Object.values(this.graph.models)) {
      if (model.hostId === hostId && model.residency === 'loaded') {
        sum += model.estimatedWeightsGB + model.runtimeOverheadGB;
      }
    }
    // On unified memory, also include OS system reservation if observedUsedGB wasn't reported
    if (unifiedMemory) {
      const host = this.graph.hosts[hostId];
      sum += host?.memory.reservedBySystemGB ?? 0;
    }
    return round2(sum);
  }

  getGpuBudgetSummary(hostId: string, gpuId?: string): GpuBudgetSummary {
    const host = this.graph.hosts[hostId];
    if (!host) {
      throw new Error(`Unknown hostId '${hostId}' in CapabilityGraph`);
    }

    const pool = this.resolveTargetGpu(host, gpuId);
    const { conflicts, reservedGB: protectedWorkloadReservedGB } = this.getProtectedConflictsForPool(
      host,
      pool.gpuId,
      pool.unifiedMemory,
    );
    const residentModelsGB = this.getBaselineResidentModelsGB(host.hostId, pool.unifiedMemory);

    // Baseline used memory before controller admissions: max of live observed usage and known resident + protected footprint
    const accountedBaselineGB = round2(protectedWorkloadReservedGB + residentModelsGB);
    const baselineUsedGB = round2(Math.max(pool.observedUsedGB, accountedBaselineGB));

    let admittedWeightsAndOverheadGB = 0;
    for (const cold of this.coldLoadedModels.values()) {
      if (cold.gpuPoolKey === pool.gpuPoolKey) {
        admittedWeightsAndOverheadGB += cold.weightsGB + cold.overheadGB;
      }
    }

    let admittedKvCacheGB = 0;
    let activeSlotCount = 0;
    for (const slot of this.activeSlots.values()) {
      if (slot.gpuPoolKey === pool.gpuPoolKey) {
        admittedKvCacheGB += slot.chargedKvCacheGB;
        activeSlotCount += 1;
      }
    }

    admittedWeightsAndOverheadGB = round2(admittedWeightsAndOverheadGB);
    admittedKvCacheGB = round2(admittedKvCacheGB);
    const totalReservedByControllerGB = round2(admittedWeightsAndOverheadGB + admittedKvCacheGB);

    const safetyHeadroomGB =
      pool.totalMemoryGB > 0
        ? round2(Math.max(this.minSafetyHeadroomGB, pool.totalMemoryGB * this.safetyHeadroomRatio))
        : 0;

    const usableFreeGB = Math.max(
      0,
      round2(pool.totalMemoryGB - baselineUsedGB - totalReservedByControllerGB - safetyHeadroomGB),
    );

    return {
      hostId: host.hostId,
      machineId: host.machineId,
      gpuId: pool.gpuId,
      unifiedMemory: pool.unifiedMemory,
      totalMemoryGB: pool.totalMemoryGB,
      baselineUsedGB,
      protectedWorkloadReservedGB,
      safetyHeadroomGB,
      admittedWeightsAndOverheadGB,
      admittedKvCacheGB,
      totalReservedByControllerGB,
      usableFreeGB,
      activeSlotCount,
      sharedRuntimeIds: [...host.runtimeIds],
      activeConflicts: conflicts,
    };
  }

  admitSlot(request: GpuSlotAdmissionRequest): GpuSlotAdmissionDecision {
    const host = this.graph.hosts[request.hostId];
    if (!host) {
      return {
        admitted: false,
        hostId: request.hostId,
        gpuId: request.gpuId ?? 'unknown',
        unifiedMemory: false,
        alreadyResident: false,
        chargedWeightsGB: 0,
        chargedOverheadGB: 0,
        chargedKvCacheGB: 0,
        totalChargedGB: 0,
        remainingUsableGB: 0,
        protectedConflictNames: [],
        reason: `Host '${request.hostId}' not found in capability graph`,
      };
    }

    const pool = this.resolveTargetGpu(host, request.gpuId);
    const budget = this.getGpuBudgetSummary(host.hostId, pool.gpuId);

    const effectiveSafetyHeadroomGB =
      request.safetyHeadroomGB !== undefined ? round2(request.safetyHeadroomGB) : budget.safetyHeadroomGB;
    const availableBeforeRequestGB = Math.max(
      0,
      round2(
        pool.totalMemoryGB -
          budget.baselineUsedGB -
          budget.totalReservedByControllerGB -
          effectiveSafetyHeadroomGB,
      ),
    );

    const matchingGraphModel = Object.values(this.graph.models).find(
      (m) => m.hostId === host.hostId && m.runtimeId === request.runtimeId && m.modelId === request.modelId,
    );

    const defaultFootprint = estimateFootprintForModel({ modelId: request.modelId });
    const weightsGB = round2(
      request.requiredWeightsGB ?? matchingGraphModel?.estimatedWeightsGB ?? defaultFootprint.estimatedWeightsGB,
    );
    const overheadGB = round2(
      request.runtimeOverheadGB ?? matchingGraphModel?.runtimeOverheadGB ?? defaultFootprint.runtimeOverheadGB,
    );
    const kvCacheGB = round2(
      request.kvCachePerSlotGB ?? matchingGraphModel?.kvCachePerSlotGB ?? defaultFootprint.kvCachePerSlotGB,
    );

    const modelKey = `${host.machineId}::${request.runtimeId}::${request.modelId}`;
    const alreadyColdAdmitted = this.coldLoadedModels.has(modelKey);
    const alreadyGraphLoaded =
      request.isAlreadyLoaded ?? (matchingGraphModel?.residency === 'loaded');
    const alreadyResident = alreadyGraphLoaded || alreadyColdAdmitted;

    const chargedWeightsGB = alreadyResident ? 0 : weightsGB;
    const chargedOverheadGB = alreadyResident ? 0 : overheadGB;
    const chargedKvCacheGB = kvCacheGB;
    const totalChargedGB = round2(chargedWeightsGB + chargedOverheadGB + chargedKvCacheGB);
    const protectedConflictNames = budget.activeConflicts.map((c) => c.processName);

    if (totalChargedGB > availableBeforeRequestGB) {
      const conflictNote =
        protectedConflictNames.length > 0
          ? ` (protected workloads active: ${protectedConflictNames.join(', ')} reserving ${budget.protectedWorkloadReservedGB}GB)`
          : '';
      return {
        admitted: false,
        hostId: host.hostId,
        gpuId: pool.gpuId,
        unifiedMemory: pool.unifiedMemory,
        alreadyResident,
        chargedWeightsGB,
        chargedOverheadGB,
        chargedKvCacheGB,
        totalChargedGB,
        remainingUsableGB: availableBeforeRequestGB,
        protectedConflictNames,
        reason: `GPU/UMA admission denied on '${host.hostId}' (${pool.gpuId}): requires ${totalChargedGB}GB (${alreadyResident ? 'warm KV slot' : 'cold weights+overhead+KV'}) > ${availableBeforeRequestGB}GB usable after ${effectiveSafetyHeadroomGB}GB headroom${conflictNote}`,
      };
    }

    if (!alreadyResident) {
      this.coldLoadedModels.set(modelKey, {
        modelKey,
        gpuPoolKey: pool.gpuPoolKey,
        weightsGB: chargedWeightsGB,
        overheadGB: chargedOverheadGB,
        slotIds: new Set([request.slotId]),
      });
    } else if (alreadyColdAdmitted) {
      this.coldLoadedModels.get(modelKey)!.slotIds.add(request.slotId);
    }

    this.activeSlots.set(request.slotId, {
      slotId: request.slotId,
      poolId: request.poolId,
      hostId: host.hostId,
      gpuPoolKey: pool.gpuPoolKey,
      gpuId: pool.gpuId,
      unifiedMemory: pool.unifiedMemory,
      runtimeId: request.runtimeId,
      modelId: request.modelId,
      modelKey,
      chargedWeightsGB,
      chargedOverheadGB,
      chargedKvCacheGB,
    });

    const slotNode: AgentExecutionSlotNode = {
      kind: 'agent_execution_slot',
      slotId: request.slotId,
      poolId: request.poolId,
      slotIndex: request.slotIndex ?? budget.activeSlotCount,
      targetKind: 'local_host',
      hostId: host.hostId,
      gpuId: pool.gpuId,
      runtimeId: request.runtimeId,
      state: request.taskId ? 'running' : 'reserved',
      assignedLogicalAgentId: request.logicalAgentId,
      assignedTaskId: request.taskId,
      reservedRamGB: pool.unifiedMemory ? totalChargedGB : 0,
      reservedVramGB: totalChargedGB,
    };
    this.graph.executionSlots[slotNode.slotId] = slotNode;

    const remainingUsableGB = Math.max(0, round2(availableBeforeRequestGB - totalChargedGB));
    return {
      admitted: true,
      slot: slotNode,
      hostId: host.hostId,
      gpuId: pool.gpuId,
      unifiedMemory: pool.unifiedMemory,
      alreadyResident,
      chargedWeightsGB,
      chargedOverheadGB,
      chargedKvCacheGB,
      totalChargedGB,
      remainingUsableGB,
      protectedConflictNames,
      reason: `Admitted slot '${request.slotId}' on '${host.hostId}' (${pool.gpuId}): charged ${totalChargedGB}GB (${alreadyResident ? 'resident model, KV-only' : 'cold load + KV'}), ${remainingUsableGB}GB remaining`,
    };
  }

  releaseSlot(slotId: string, options: { unloadColdModel?: boolean } = {}): boolean {
    const active = this.activeSlots.get(slotId);
    if (!active) return false;
    this.activeSlots.delete(slotId);

    const cold = this.coldLoadedModels.get(active.modelKey);
    if (cold) {
      cold.slotIds.delete(slotId);
      if (cold.slotIds.size === 0 && (options.unloadColdModel ?? true)) {
        this.coldLoadedModels.delete(active.modelKey);
      }
    }

    const existingNode = this.graph.executionSlots[slotId];
    if (existingNode) {
      existingNode.state = 'idle';
      existingNode.assignedLogicalAgentId = undefined;
      existingNode.assignedTaskId = undefined;
      existingNode.reservedRamGB = 0;
      existingNode.reservedVramGB = 0;
    }
    return true;
  }
}

export interface HostModelFitRecommendation {
  hostId: string;
  machineId: string;
  hostname: string;
  fits: boolean;
  alreadyWarmModelIds: string[];
  estimatedRequiredColdGB: number;
  usableMemoryGB: number;
  totalMemoryGB: number;
  unifiedMemory: boolean;
  estimatedMaxSafeSlots: number;
  score: number;
  rationale: string;
}

/**
 * Ranks physical hosts in a `CapabilityGraph` for running a model of `paramBillions` parameters
 * (e.g., `"Which machine is best for running a 35B model?"`), accounting for warm resident models,
 * unified vs discrete GPU memory, protected simulation conflicts, and safety headroom.
 */
export function findBestHostsForModelSize(
  graph: CapabilityGraph,
  paramBillions: number,
  options: { quantization?: string; contextTokens?: number; requireNvidiaCuda?: boolean } = {},
): HostModelFitRecommendation[] {
  const controller = new SharedGpuAdmissionController(graph);
  const footprint = estimateFootprintForModel({
    modelId: `${paramBillions}b`,
    parameterBillions: paramBillions,
    quantization: options.quantization ?? 'q4',
    contextTokens: options.contextTokens ?? 8192,
  });
  const requiredColdGB = round2(
    footprint.estimatedWeightsGB + footprint.runtimeOverheadGB + footprint.kvCachePerSlotGB,
  );

  const recommendations: HostModelFitRecommendation[] = [];

  for (const host of Object.values(graph.hosts)) {
    const hasCuda = host.gpus.some((g) => g.vendor === 'nvidia');
    if (options.requireNvidiaCuda && !hasCuda) {
      recommendations.push({
        hostId: host.hostId,
        machineId: host.machineId,
        hostname: host.hostname,
        fits: false,
        alreadyWarmModelIds: [],
        estimatedRequiredColdGB: requiredColdGB,
        usableMemoryGB: 0,
        totalMemoryGB: host.memory.totalGB,
        unifiedMemory: host.memory.unifiedMemory,
        estimatedMaxSafeSlots: 0,
        score: -1,
        rationale: `Host '${host.hostId}' lacks required NVIDIA CUDA GPU`,
      });
      continue;
    }

    const budget = controller.getGpuBudgetSummary(host.hostId);
    const warmComparableModels = Object.values(graph.models).filter(
      (m) =>
        m.hostId === host.hostId &&
        m.residency === 'loaded' &&
        typeof m.parameterBillions === 'number' &&
        Math.abs(m.parameterBillions - paramBillions) <= Math.max(5, paramBillions * 0.25),
    );
    const alreadyWarmModelIds = warmComparableModels.map((m) => m.modelId);

    const fitsWarm =
      alreadyWarmModelIds.length > 0 && budget.usableFreeGB >= footprint.kvCachePerSlotGB;
    const fitsCold = budget.usableFreeGB >= requiredColdGB;
    const fits = fitsWarm || fitsCold;

    let estimatedMaxSafeSlots = 0;
    if (fitsWarm) {
      estimatedMaxSafeSlots = Math.max(
        1,
        Math.floor(budget.usableFreeGB / Math.max(0.25, footprint.kvCachePerSlotGB)),
      );
    } else if (fitsCold) {
      const remainingAfterLoad = Math.max(
        0,
        budget.usableFreeGB - (footprint.estimatedWeightsGB + footprint.runtimeOverheadGB),
      );
      estimatedMaxSafeSlots = Math.max(
        1,
        Math.floor(remainingAfterLoad / Math.max(0.25, footprint.kvCachePerSlotGB)),
      );
    }

    const verifiedEndpoints = Object.values(graph.endpoints).filter(
      (ep) =>
        ep.hostId === host.hostId &&
        (ep.acceptanceState === 'EXECUTION_VERIFIED' ||
          ep.acceptanceState === 'CAPACITY_VERIFIED' ||
          ep.acceptanceState === 'MODEL_READY' ||
          ep.acceptanceState === 'API_READY'),
    ).length;

    let score = 0;
    if (fits) {
      score += 100;
      score += Math.min(80, budget.usableFreeGB);
      if (alreadyWarmModelIds.length > 0) score += 45;
      if (hasCuda) score += 15;
      score += Math.min(20, verifiedEndpoints * 10);
      score -= budget.activeConflicts.length * 25;
    } else {
      score = round2(budget.usableFreeGB - requiredColdGB);
    }

    const rationale = fits
      ? alreadyWarmModelIds.length > 0
        ? `Host '${host.hostId}' already has warm ~${paramBillions}B model(s) [${alreadyWarmModelIds.join(', ')}] with ${budget.usableFreeGB}GB usable headroom (~${estimatedMaxSafeSlots} safe slots)`
        : `Host '${host.hostId}' can cold-load a ${paramBillions}B model (${requiredColdGB}GB required <= ${budget.usableFreeGB}GB usable of ${budget.totalMemoryGB}GB, ~${estimatedMaxSafeSlots} safe slots)`
      : `Host '${host.hostId}' has ${budget.usableFreeGB}GB usable (< ${requiredColdGB}GB needed for ${paramBillions}B cold load)`;

    recommendations.push({
      hostId: host.hostId,
      machineId: host.machineId,
      hostname: host.hostname,
      fits,
      alreadyWarmModelIds,
      estimatedRequiredColdGB: requiredColdGB,
      usableMemoryGB: budget.usableFreeGB,
      totalMemoryGB: budget.totalMemoryGB,
      unifiedMemory: budget.unifiedMemory,
      estimatedMaxSafeSlots,
      score: round2(score),
      rationale,
    });
  }

  return recommendations.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    return b.score - a.score;
  });
}
