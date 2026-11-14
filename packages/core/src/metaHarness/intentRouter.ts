import {
  analyzeAndOptimizeExecution,
  type ExecutionHistoryInput,
  type ExecutionOptimizationResult,
} from './autonomousRepair.js';
import {
  verifyDeliverableIndependently,
  type AcceptanceTestRecord,
  type ControlledFaultInjectionReport,
  type IndependentDeliverableVerificationResult,
  type MandatoryUserJourneysReport,
} from './qualificationSuite.js';
import type {
  CapabilityGraph,
  ClassifiedTaskProfile,
  DeclarativeExecutionPlan,
  DurableManagedTask,
  HardUserConstraints,
  LoadedModelNode,
  PhysicalHostNode,
  PoolAllocationQuantities,
  ReconciliationSnapshot,
  RuntimeProcessNode,
  ServerAcceptanceRow,
} from './types.js';
import {
  renderExecutionView,
  renderInfrastructureView,
  renderOptimizationView,
  renderQualificationView,
  type ProgressiveViewOptions,
} from './uxViews.js';

/**
 * Part 1.1 & Final Demonstration: Natural-Language Infrastructure & Execution
 * Intent Classifier and Shared Dispatcher.
 *
 * Ensures infrastructure, scheduling, verification, and self-improvement prompts
 * are recognized as first-class operational intents (never dumped into an
 * ordinary chat completion), and shares a single `MetaHarnessIntentHandlers`
 * interface across CLI, TUI, and HTTP API without duplicated business logic.
 */

export const META_HARNESS_INTENT_KINDS = [
  'DISCOVER_MACHINES',
  'QUERY_GPUS',
  'BEST_HOST_FOR_MODEL',
  'LIST_NETWORK_MODELS',
  'AVAILABLE_AGENT_CAPACITY',
  'INSPECT_HOST_EXECUTION',
  'FIND_INFERENCE_SERVERS',
  'CHECK_SCALE_FEASIBILITY',
  'FIND_IDLE_HARDWARE',
  'OPTIMIZE_FOR_COST',
  'CONFIGURE_ROUTING_POLICY',
  'DISTRIBUTE_PLAN',
  'IMPLEMENT_FEATURE',
  'VERIFY_EXECUTION',
  'IMPROVE_EXECUTION',
] as const;

export type MetaHarnessOperationalIntentKind = (typeof META_HARNESS_INTENT_KINDS)[number];

export type MetaHarnessIntentKind = MetaHarnessOperationalIntentKind | 'ORDINARY_PROMPT';

export interface ExtractedMetaHarnessIntentParams {
  /** Extracted model parameter count in billions, e.g. 35 from "35B model". */
  parameterBillions?: number;
  /** Whether the queried model hints at Mixture-of-Experts (e.g. "35B-A3B" or "MoE"). */
  isMoEHint?: boolean;
  /** Extracted target agent count, e.g. 20 or 100. */
  requestedAgents?: number;
  /** Normalized host identifier, e.g. 'dgx_spark', 'mac_studio', 'macbook_pro'. */
  targetHostId?: string;
  /** Normalized plan identifier, e.g. 'fs5'. */
  planName?: string;
  /** Requested runtime daemon types, e.g. ['ollama', 'lmstudio']. */
  runtimeTypes?: Array<RuntimeProcessNode['runtimeType']>;
  /** Preferred model family for routing policy, e.g. 'qwen'. */
  preferredModelFamily?: string;
  /** Extracted task type for routing policy, e.g. 'coding'. */
  taskType?: ClassifiedTaskProfile['taskType'];
  /** Route to local sovereign hardware first. */
  localFirst?: boolean;
  /** Restrict cloud agents to fallback/overflow/complex tasks only. */
  cloudOnlyWhenNecessary?: boolean;
  /** Feature specification text when intent === 'IMPLEMENT_FEATURE'. */
  featureSpecification?: string;
  /** Progressive disclosure `--detail` requested in prompt. */
  detailRequested?: boolean;
}

export interface ClassifiedMetaHarnessIntent {
  intent: MetaHarnessIntentKind;
  isOperationalIntent: boolean;
  confidence: number; // 0.0 .. 1.0
  normalizedInput: string;
  params: ExtractedMetaHarnessIntentParams;
  matchedRule: string;
}

export interface HostModelFitRecommendation {
  recommendedHostId: string | null;
  estimatedRequiredMemoryGB: number;
  rankedHosts: Array<{
    hostId: string;
    hostname: string;
    availableMemoryGB: number;
    totalMemoryGB: number;
    fitsInMemory: boolean;
    alreadyHasMatchingWarmModel: boolean;
    score: number;
    reason: string;
  }>;
}

export interface ScaleFeasibilityAssessment {
  requestedAgents: number;
  feasible: boolean;
  immediateVerifiedConcurrency: number;
  queueingRequired: boolean;
  estimatedWaves: number;
  acceptingPools: string[];
  unavailablePools: string[];
  zeroClaudeEnforced: true;
  explanation: string;
}

export interface RoutingPolicyUpdateSpec {
  taskType?: ClassifiedTaskProfile['taskType'];
  preferredModelFamily?: string;
  localFirst: boolean;
  cloudOnlyWhenNecessary: boolean;
  disabledProviders: string[];
}

/**
 * Shared state & action adapter used identically by CLI, TUI, and HTTP API.
 */
export interface MetaHarnessIntentHandlers {
  /** Returns current capability graph (or discovers one if none cached). */
  getCapabilityGraph: () => Promise<CapabilityGraph> | CapabilityGraph;
  /** Triggers active multi-host hardware/runtime discovery. */
  discoverMachines?: () => Promise<{
    graph: CapabilityGraph;
    acceptanceRows?: ServerAcceptanceRow[];
  }>;
  /** Returns latest 11-state server acceptance rows. */
  getAcceptanceRows?: () => Promise<ServerAcceptanceRow[]> | ServerAcceptanceRow[];
  /** Returns active declarative execution plan (e.g. FS5). */
  getCurrentPlan?: (planName?: string) => Promise<DeclarativeExecutionPlan | undefined> | DeclarativeExecutionPlan | undefined;
  /** Returns current 4-quantity allocation & queue state per pool. */
  getPoolQuantities?: () =>
    | Promise<Record<string, PoolAllocationQuantities>>
    | Record<string, PoolAllocationQuantities>;
  /** Returns durable managed tasks across pools/hosts. */
  getManagedTasks?: () => Promise<DurableManagedTask[]> | DurableManagedTask[];
  /** Returns latest 4-state continuous reconciliation snapshot. */
  getReconciliationSnapshot?: () =>
    | Promise<ReconciliationSnapshot | undefined>
    | ReconciliationSnapshot
    | undefined;
  /** Distributes `requestedAgents` using `planName` (e.g. FS5). */
  distributePlan?: (
    planName: string,
    requestedAgents: number,
  ) => Promise<{
    plan: DeclarativeExecutionPlan;
    quantities: Record<string, PoolAllocationQuantities>;
    acceptanceRows?: ServerAcceptanceRow[];
    tasks?: DurableManagedTask[];
  }>;
  /** Applies a natural-language routing/cost policy update to shared controller state. */
  applyRoutingPolicy?: (policy: RoutingPolicyUpdateSpec) => Promise<{
    updatedPlan: DeclarativeExecutionPlan;
    constraints: HardUserConstraints;
    summary: string;
  }>;
  /** Executes a multi-agent feature implementation request. */
  implementFeature?: (featureSpecification: string) => Promise<{
    plan?: DeclarativeExecutionPlan;
    changedFiles: string[];
    verification?: IndependentDeliverableVerificationResult;
    summary: string;
  }>;
  /** Returns or runs independent verification & qualification state ("Did it work?"). */
  verifyExecution?: () => Promise<{
    verification?: IndependentDeliverableVerificationResult;
    journeys?: MandatoryUserJourneysReport;
    acceptanceTests?: AcceptanceTestRecord[];
    faults?: ControlledFaultInjectionReport;
    summary?: string;
  }>;
  /** Returns execution telemetry history for optimization ("Improve the execution."). */
  getExecutionHistory?: () => Promise<ExecutionHistoryInput> | ExecutionHistoryInput;
  /** Optional custom hook to persist an optimized plan after `analyzeAndOptimizeExecution`. */
  promoteOptimizedPlan?: (result: ExecutionOptimizationResult) => Promise<void> | void;
  /** Optional fallback for ordinary non-infrastructure prompts. */
  handleOrdinaryPrompt?: (input: string) => Promise<string>;
}

export interface MetaHarnessIntentDispatchResult<TData = unknown> {
  classification: ClassifiedMetaHarnessIntent;
  handledByMetaHarness: boolean;
  summary: string;
  renderedView: string;
  data: TData;
}

// ============================================================================
// Parameter Extraction Helpers
// ============================================================================

function extractParameterBillions(text: string): { billions?: number; isMoE?: boolean } {
  const moeMatch = /\b(\d+(?:\.\d+)?)\s*[bB]\s*-\s*[aA]\d+(?:\.\d+)?[bB]\b/.exec(text);
  if (moeMatch) {
    return { billions: Number(moeMatch[1]), isMoE: true };
  }
  const bMatch = /\b(\d+(?:\.\d+)?)\s*(?:[bB]\b|billion(?:\s+parameter)?s?\b)/.exec(text);
  if (bMatch) {
    return {
      billions: Number(bMatch[1]),
      isMoE: /\bmoe\b/i.test(text),
    };
  }
  return {};
}

function extractAgentCount(text: string): number | undefined {
  const m = /\b(\d{1,5})\s+(?:concurrent\s+|distributed\s+|parallel\s+)?(?:sub)?agents?\b/i.exec(
    text,
  );
  if (m) return Number(m[1]);
  const scaleMatch = /\bscale\s+(\d{1,5})\b/i.exec(text);
  if (scaleMatch) return Number(scaleMatch[1]);
  return undefined;
}

function extractTargetHostId(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/\bdgx(?:[\s_-]*spark)?\b/.test(lower) || /\bgb10\b/.test(lower)) return 'dgx_spark';
  if (/\bmac[\s_-]*studio\b/.test(lower) || /\bm4\s+max\b/.test(lower) || /\bon\s+(?:my\s+)?studio\b/.test(lower)) {
    return 'mac_studio';
  }
  if (
    /\bmacbook(?:[\s_-]*pro)?\b/.test(lower) ||
    /\bm5\s+pro\b/.test(lower) ||
    /\bon\s+(?:my\s+)?laptop\b/.test(lower)
  ) {
    return 'macbook_pro';
  }
  const explicitHost = /\bon\s+(?:host|machine|node)\s+([a-z0-9._-]+)\b/i.exec(text);
  if (explicitHost) return explicitHost[1];
  return undefined;
}

function extractPlanName(text: string): string | undefined {
  if (/\bfs5\b/i.test(text) || /\bforge[\s_-]*sovereign[\s_-]*5\b/i.test(text)) {
    return 'fs5';
  }
  const namedPlan = /\buse\s+(?:my\s+)?([a-z0-9_-]+)\s+(?:configuration|plan|profile)\b/i.exec(text);
  if (namedPlan) return namedPlan[1].toLowerCase();
  return undefined;
}

function extractRuntimeTypes(text: string): Array<RuntimeProcessNode['runtimeType']> {
  const lower = text.toLowerCase();
  const types: Array<RuntimeProcessNode['runtimeType']> = [];
  if (/\bollama\b/.test(lower)) types.push('ollama');
  if (/\blm\s*studio\b|\blmstudio\b/.test(lower)) types.push('lmstudio');
  if (/\bvllm\b/.test(lower)) types.push('vllm');
  if (/\bllama\.?cpp\b/.test(lower)) types.push('llama-cpp');
  if (/\bopenai[- ]compatible\b/.test(lower)) types.push('openai-compatible');
  return types;
}

function extractModelFamily(text: string): string | undefined {
  const m = /\b(qwen[\d.]*|gemma[\d.]*|deepseek|nemotron|llama[\d.]*|mistral)\b/i.exec(text);
  return m ? m[1].toLowerCase().replace(/[\d.]+$/, '') : undefined;
}

function extractTaskType(text: string): ClassifiedTaskProfile['taskType'] | undefined {
  const lower = text.toLowerCase();
  if (/\bcod(?:ing|e)\b/.test(lower)) return 'coding';
  if (/\bformat(?:ting)?\b/.test(lower)) return 'formatting';
  if (/\barchitect(?:ure)?\b/.test(lower)) return 'architecture';
  if (/\btest(?:ing|s)?\b/.test(lower)) return 'testing';
  if (/\bbrowser|playwright|e2e\b/.test(lower)) return 'browser_e2e';
  if (/\bcuda\b/.test(lower)) return 'cuda_gpu';
  if (/\bverif(?:y|ication)\b/.test(lower)) return 'verification';
  if (/\bresearch\b/.test(lower)) return 'research';
  return undefined;
}

/**
 * Deterministically classifies natural-language infrastructure, scheduling,
 * verification, and optimization requests into structured operational intents.
 */
export function classifyMetaHarnessIntent(input: string): ClassifiedMetaHarnessIntent {
  const trimmed = input.trim();
  const withoutAddressing = trimmed.replace(/^wazir[,:\s]+/i, '').trim();
  const detailRequested = /\s--detail\b|\bin\s+detail\b/i.test(trimmed);

  const modelSize = extractParameterBillions(withoutAddressing);
  const requestedAgents = extractAgentCount(withoutAddressing);
  const targetHostId = extractTargetHostId(withoutAddressing);
  const planName = extractPlanName(withoutAddressing);
  const runtimeTypes = extractRuntimeTypes(withoutAddressing);
  const preferredModelFamily = extractModelFamily(withoutAddressing);
  const taskType = extractTaskType(withoutAddressing);

  const baseParams: ExtractedMetaHarnessIntentParams = {
    ...(modelSize.billions !== undefined ? { parameterBillions: modelSize.billions } : {}),
    ...(modelSize.isMoE !== undefined ? { isMoEHint: modelSize.isMoE } : {}),
    ...(requestedAgents !== undefined ? { requestedAgents } : {}),
    ...(targetHostId !== undefined ? { targetHostId } : {}),
    ...(planName !== undefined ? { planName } : {}),
    ...(runtimeTypes.length > 0 ? { runtimeTypes } : {}),
    ...(preferredModelFamily !== undefined ? { preferredModelFamily } : {}),
    ...(taskType !== undefined ? { taskType } : {}),
    ...(detailRequested ? { detailRequested: true } : {}),
  };

  // 1. DISTRIBUTE_PLAN ("Use my FS5 configuration and distribute 20 agents." / "100 agents")
  if (
    (/\b(?:distribute|dispatch|launch|allocate|spawn)\b/i.test(withoutAddressing) &&
      (requestedAgents !== undefined || planName !== undefined)) ||
    (planName !== undefined && requestedAgents !== undefined)
  ) {
    return {
      intent: 'DISTRIBUTE_PLAN',
      isOperationalIntent: true,
      confidence: 0.98,
      normalizedInput: withoutAddressing,
      params: {
        ...baseParams,
        planName: planName ?? 'fs5',
        requestedAgents: requestedAgents ?? 20,
      },
      matchedRule: 'distribute_plan_and_agents',
    };
  }

  // 2. CHECK_SCALE_FEASIBILITY ("Can I execute 100 agents using my current infrastructure?")
  if (
    requestedAgents !== undefined &&
    (/\b(?:can\s+i|is\s+it\s+feasible|feasible|support|handle|capacity\s+for|enough\s+(?:hardware|infrastructure))\b/i.test(
      withoutAddressing,
    ) ||
      /\busing\s+my\s+current\s+infrastructure\b/i.test(withoutAddressing))
  ) {
    return {
      intent: 'CHECK_SCALE_FEASIBILITY',
      isOperationalIntent: true,
      confidence: 0.97,
      normalizedInput: withoutAddressing,
      params: baseParams,
      matchedRule: 'scale_feasibility_query',
    };
  }

  // 3. BEST_HOST_FOR_MODEL ("Which machine is best for running a 35B model?")
  if (
    modelSize.billions !== undefined &&
    /\b(?:which|what|best|recommend|where\s+should\s+i\s+run|can\s+run)\b.*\b(?:machine|host|hardware|node|device|gpu|mac|dgx)\b|\b(?:best|fastest|suitable)\s+(?:machine|host)\s+for\b/i.test(
      withoutAddressing,
    )
  ) {
    return {
      intent: 'BEST_HOST_FOR_MODEL',
      isOperationalIntent: true,
      confidence: 0.97,
      normalizedInput: withoutAddressing,
      params: baseParams,
      matchedRule: 'best_host_for_parameter_size',
    };
  }

  // 4. CONFIGURE_ROUTING_POLICY ("Route coding tasks to local Qwen models and use cloud agents only when necessary.")
  if (
    /\b(?:route|prefer|send|assign|pin)\b.*\b(?:tasks?|models?|local|cloud|pools?)\b/i.test(
      withoutAddressing,
    ) ||
    /\buse\s+cloud\s+agents?\s+only\s+when\s+necessary\b/i.test(withoutAddressing)
  ) {
    return {
      intent: 'CONFIGURE_ROUTING_POLICY',
      isOperationalIntent: true,
      confidence: 0.96,
      normalizedInput: withoutAddressing,
      params: {
        ...baseParams,
        localFirst: /\blocal\b/i.test(withoutAddressing),
        cloudOnlyWhenNecessary: /\bonly\s+when\s+necessary|fallback|overflow\b/i.test(
          withoutAddressing,
        ),
      },
      matchedRule: 'configure_routing_policy',
    };
  }

  // 5. OPTIMIZE_FOR_COST ("Optimize my distributed execution for cost.")
  if (
    /\b(?:optimize|minimize|reduce|lower|cut)\b.*\b(?:cost|spend|budget|cloud\s+bill|dollars?|cheaper|cheaply)\b/i.test(
      withoutAddressing,
    )
  ) {
    return {
      intent: 'OPTIMIZE_FOR_COST',
      isOperationalIntent: true,
      confidence: 0.96,
      normalizedInput: withoutAddressing,
      params: {
        ...baseParams,
        localFirst: true,
        cloudOnlyWhenNecessary: true,
      },
      matchedRule: 'optimize_for_cost',
    };
  }

  // 5b. IMPLEMENT_FEATURE ("Implement a small multi-file feature...", "Implement this software feature...")
  if (
    /^(?:implement|build|develop|create|add)\s+(?:this\s+|the\s+|a\s+|an\s+)?(?:[a-z0-9_-]+\s+){0,4}feature\b/i.test(
      withoutAddressing,
    ) ||
    /\bimplement\s+(?:this|a|the)\s+(?:[a-z0-9_-]+\s+){0,4}feature\b/i.test(withoutAddressing)
  ) {
    return {
      intent: 'IMPLEMENT_FEATURE',
      isOperationalIntent: true,
      confidence: 0.96,
      normalizedInput: withoutAddressing,
      params: {
        ...baseParams,
        featureSpecification: withoutAddressing,
      },
      matchedRule: 'implement_feature',
    };
  }

  // 5c. Broad DISCOVER_MACHINES when explicitly discovering machines/hardware/cluster
  // ("Discover my machines.", "Discover all my machines, GPUs, runtimes, and models.")
  if (
    runtimeTypes.length === 0 &&
    /\b(?:discover|scan|introspect|inventory|enumerate)\b.*\b(?:my\s+)?(?:machines?|hosts?|hardware|cluster|infrastructure)\b/i.test(
      withoutAddressing,
    )
  ) {
    return {
      intent: 'DISCOVER_MACHINES',
      isOperationalIntent: true,
      confidence: 0.98,
      normalizedInput: withoutAddressing,
      params: baseParams,
      matchedRule: 'discover_machines',
    };
  }

  // 6. FIND_INFERENCE_SERVERS ("Find all available Ollama and LM Studio servers.")
  if (
    runtimeTypes.length > 0 ||
    /\b(?:find|list|discover|show|probe|check)\b.*\b(?:inference\s+servers?|ollama|lm\s*studio|vllm|endpoints?|runtimes?)\b/i.test(
      withoutAddressing,
    )
  ) {
    return {
      intent: 'FIND_INFERENCE_SERVERS',
      isOperationalIntent: true,
      confidence: 0.96,
      normalizedInput: withoutAddressing,
      params: baseParams,
      matchedRule: 'find_inference_servers',
    };
  }

  // 7. INSPECT_HOST_EXECUTION ("What is currently executing on my DGX?")
  if (
    targetHostId !== undefined &&
    /\b(?:what(?:'s|\s+is)|show|inspect|list|status)\b.*\b(?:executing|running|active|happening|tasks?|jobs?|workloads?)\b/i.test(
      withoutAddressing,
    )
  ) {
    return {
      intent: 'INSPECT_HOST_EXECUTION',
      isOperationalIntent: true,
      confidence: 0.97,
      normalizedInput: withoutAddressing,
      params: baseParams,
      matchedRule: 'inspect_host_execution',
    };
  }

  // 8. AVAILABLE_AGENT_CAPACITY ("Which machines can accept additional agents?")
  if (
    /\b(?:accept|run|take|host|admit)\s+(?:additional|more|extra|new)\s+(?:sub)?agents?\b/i.test(
      withoutAddressing,
    ) ||
    /\b(?:spare|available|remaining|free)\s+(?:agent\s+)?(?:capacity|slots?|concurrency)\b/i.test(
      withoutAddressing,
    )
  ) {
    return {
      intent: 'AVAILABLE_AGENT_CAPACITY',
      isOperationalIntent: true,
      confidence: 0.96,
      normalizedInput: withoutAddressing,
      params: baseParams,
      matchedRule: 'available_agent_capacity',
    };
  }

  // 9. FIND_IDLE_HARDWARE ("Which hardware is idle?")
  if (
    /\b(?:which|what|show|find|list)\b.*\b(?:idle|unused|unutilized|free)\b.*\b(?:hardware|machines?|hosts?|gpus?|nodes?)?\b|\b(?:hardware|machines?|hosts?|gpus?)\s+(?:is|are)\s+idle\b/i.test(
      withoutAddressing,
    )
  ) {
    return {
      intent: 'FIND_IDLE_HARDWARE',
      isOperationalIntent: true,
      confidence: 0.96,
      normalizedInput: withoutAddressing,
      params: baseParams,
      matchedRule: 'find_idle_hardware',
    };
  }

  // 10. QUERY_GPUS ("What GPUs do I have available?")
  if (
    /\b(?:what|which|list|show|inspect|available)\b.*\bgpus?\b|\bvram\b|\bunified\s+memory\s+gpus?\b/i.test(
      withoutAddressing,
    )
  ) {
    return {
      intent: 'QUERY_GPUS',
      isOperationalIntent: true,
      confidence: 0.97,
      normalizedInput: withoutAddressing,
      params: baseParams,
      matchedRule: 'query_gpus',
    };
  }

  // 11. LIST_NETWORK_MODELS ("What models are installed across my network?")
  if (
    /\b(?:what|which|list|show|enumerate)\b.*\bmodels?\b.*\b(?:installed|loaded|available|network|machines?|hosts?|warm|cold)\b|\bmodels?\s+(?:are\s+)?(?:installed|loaded)\b/i.test(
      withoutAddressing,
    )
  ) {
    return {
      intent: 'LIST_NETWORK_MODELS',
      isOperationalIntent: true,
      confidence: 0.96,
      normalizedInput: withoutAddressing,
      params: baseParams,
      matchedRule: 'list_network_models',
    };
  }

  // 12. DISCOVER_MACHINES ("Discover my machines.", "Wazir, discover my machines.")
  if (
    /\b(?:discover|scan|introspect|inventory|enumerate)\b.*\b(?:my\s+)?(?:machines?|hosts?|hardware|cluster|devices?|network|infrastructure)\b|\bwhat\s+(?:machines?|hardware)\s+do\s+i\s+have\b/i.test(
      withoutAddressing,
    )
  ) {
    return {
      intent: 'DISCOVER_MACHINES',
      isOperationalIntent: true,
      confidence: 0.98,
      normalizedInput: withoutAddressing,
      params: baseParams,
      matchedRule: 'discover_machines',
    };
  }

  // 13. VERIFY_EXECUTION ("Did it work?")
  if (
    /^(?:did\s+it\s+work\??|does\s+(?:it|wazir)\s+(?:really\s+)?work\??|verify\s+(?:the\s+)?(?:execution|deliverables?|output|run)|show\s+qualification(?:\s+status)?)[.?!]*$/i.test(
      withoutAddressing,
    ) ||
    /\bdid\s+it\s+work\b/i.test(withoutAddressing)
  ) {
    return {
      intent: 'VERIFY_EXECUTION',
      isOperationalIntent: true,
      confidence: 0.97,
      normalizedInput: withoutAddressing,
      params: baseParams,
      matchedRule: 'verify_execution',
    };
  }

  // 14. IMPROVE_EXECUTION ("Improve the execution.")
  if (
    /^(?:improve|optimize|tune|self-improve)\s+(?:the\s+|my\s+)?execution[.?!]*$/i.test(
      withoutAddressing,
    ) ||
    /\bimprove\s+(?:the\s+)?execution\b/i.test(withoutAddressing)
  ) {
    return {
      intent: 'IMPROVE_EXECUTION',
      isOperationalIntent: true,
      confidence: 0.97,
      normalizedInput: withoutAddressing,
      params: baseParams,
      matchedRule: 'improve_execution',
    };
  }

  // 15. IMPLEMENT_FEATURE ("Implement this software feature...")
  if (
    /^(?:implement|build|develop|create|add)\s+(?:this\s+|the\s+|a\s+)?(?:software\s+)?feature\b/i.test(
      withoutAddressing,
    ) ||
    /\bimplement\s+this\s+software\s+feature\b/i.test(withoutAddressing)
  ) {
    return {
      intent: 'IMPLEMENT_FEATURE',
      isOperationalIntent: true,
      confidence: 0.94,
      normalizedInput: withoutAddressing,
      params: {
        ...baseParams,
        featureSpecification: withoutAddressing,
      },
      matchedRule: 'implement_feature',
    };
  }

  return {
    intent: 'ORDINARY_PROMPT',
    isOperationalIntent: false,
    confidence: 0.5,
    normalizedInput: withoutAddressing,
    params: baseParams,
    matchedRule: 'fallback_ordinary_prompt',
  };
}

// ============================================================================
// Pure Domain Evaluation Helpers (Shared Across CLI, TUI, and API)
// ============================================================================

function computeEffectiveHostAvailableMemoryGB(host: PhysicalHostNode): {
  availableGB: number;
  totalGB: number;
} {
  const conflictVram = host.workloadConflicts.reduce((a, c) => a + c.reservedVramGB, 0);
  const conflictRam = host.workloadConflicts.reduce((a, c) => a + c.reservedRamGB, 0);

  if (host.gpus.length > 0 && !host.memory.unifiedMemory) {
    const totalVram = host.gpus.reduce((a, g) => a + g.totalMemoryGB, 0);
    const rawAvail = host.gpus.reduce(
      (a, g) => a + (g.availableMemoryGB ?? Math.max(0, g.totalMemoryGB - (g.usedMemoryGB ?? 0))),
      0,
    );
    return {
      availableGB: Math.max(0, rawAvail - conflictVram),
      totalGB: totalVram,
    };
  }

  return {
    availableGB: Math.max(0, host.memory.availableGB - Math.max(conflictRam, conflictVram)),
    totalGB: host.memory.totalGB,
  };
}

/**
 * Ranks discovered physical hosts for running an N-billion parameter model
 * (estimating Q4/Q8 weights + KV cache + runtime overhead and checking warm models).
 */
export function evaluateBestHostForModel(
  graph: CapabilityGraph,
  parameterBillions: number,
  isMoE = false,
): HostModelFitRecommendation {
  // Realistic Q4_K_M/Q6 footprint: ~0.65 GB per 1B params + 2.5GB KV/runtime overhead
  const estimatedRequiredMemoryGB = Number((parameterBillions * 0.65 + 2.5).toFixed(1));
  const models = Object.values(graph.models);

  const rankedHosts = Object.values(graph.hosts)
    .map((host) => {
      const mem = computeEffectiveHostAvailableMemoryGB(host);
      const warmMatch = models.some(
        (m) =>
          m.hostId === host.hostId &&
          m.residency === 'loaded' &&
          m.parameterBillions !== undefined &&
          Math.abs(m.parameterBillions - parameterBillions) <= 5,
      );

      // If already warm in memory on this host, its weights are already accounted for!
      const fitsInMemory = warmMatch || mem.availableGB >= estimatedRequiredMemoryGB;
      const headroomGB = mem.availableGB - (warmMatch ? 2.0 : estimatedRequiredMemoryGB);
      let score = fitsInMemory ? 100 + headroomGB : mem.availableGB - estimatedRequiredMemoryGB;
      if (warmMatch) score += 50;
      if (isMoE && host.memory.unifiedMemory) score += 10;
      if (host.workloadConflicts.some((c) => c.doNotInterrupt)) score -= 25;

      const reasonParts: string[] = [
        `${mem.availableGB.toFixed(1)}/${mem.totalGB.toFixed(1)}GB available`,
      ];
      if (warmMatch) reasonParts.push(`already has ~${parameterBillions}B model warm in memory`);
      if (!fitsInMemory) {
        reasonParts.push(`insufficient memory (requires ~${estimatedRequiredMemoryGB}GB)`);
      }

      return {
        hostId: host.hostId,
        hostname: host.hostname,
        availableMemoryGB: Number(mem.availableGB.toFixed(2)),
        totalMemoryGB: Number(mem.totalGB.toFixed(2)),
        fitsInMemory,
        alreadyHasMatchingWarmModel: warmMatch,
        score: Number(score.toFixed(2)),
        reason: reasonParts.join('; '),
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = rankedHosts.find((h) => h.fitsInMemory) ?? null;

  return {
    recommendedHostId: best ? best.hostId : null,
    estimatedRequiredMemoryGB,
    rankedHosts,
  };
}

/**
 * Evaluates whether `requestedAgents` can be executed across current verified
 * infrastructure (with observable queueing when `requestedAgents > immediateVerifiedConcurrency`).
 */
export function assessScaleFeasibility(
  requestedAgents: number,
  graph: CapabilityGraph,
  acceptanceRows: ServerAcceptanceRow[] = [],
  plan?: DeclarativeExecutionPlan,
): ScaleFeasibilityAssessment {
  const acceptingStates = new Set([
    'API_READY',
    'MODEL_READY',
    'EXECUTION_VERIFIED',
    'CAPACITY_VERIFIED',
  ]);

  let immediateConcurrency = 0;
  const acceptingPools: string[] = [];
  const unavailablePools: string[] = [];

  if (acceptanceRows.length > 0) {
    for (const row of acceptanceRows) {
      if (row.pool === 'claude' || row.status === 'DISABLED_BY_POLICY') continue;
      if (acceptingStates.has(row.status)) {
        acceptingPools.push(row.pool);
        immediateConcurrency += row.verifiedConcurrency ?? row.configuredMaxConcurrent;
      } else {
        unavailablePools.push(`${row.pool} (${row.status})`);
      }
    }
  } else if (plan) {
    for (const pool of plan.spec.pools) {
      if (!pool.enabled || pool.id === 'claude') continue;
      acceptingPools.push(pool.id);
      immediateConcurrency += pool.max_concurrent;
    }
  } else {
    immediateConcurrency = Object.keys(graph.hosts).length * 2;
  }

  const queueEnabled = plan?.spec.execution.queue_when_saturated ?? true;
  const feasible = immediateConcurrency > 0 && (requestedAgents <= immediateConcurrency || queueEnabled);
  const queueingRequired = requestedAgents > immediateConcurrency;
  const estimatedWaves =
    immediateConcurrency > 0 ? Math.ceil(requestedAgents / immediateConcurrency) : 0;

  const explanation = feasible
    ? queueingRequired
      ? `Yes — ${requestedAgents} logical agents are feasible across ${acceptingPools.length} active pool(s) (${acceptingPools.join(', ')}) with ${immediateConcurrency} concurrent slots (~${estimatedWaves} queued waves; claude=0%).`
      : `Yes — all ${requestedAgents} agents can run immediately within ${immediateConcurrency} verified concurrent slots across ${acceptingPools.join(', ')} (claude=0%).`
    : `No — zero accepting execution pools are currently available (${unavailablePools.join(', ') || 'none discovered'}).`;

  return {
    requestedAgents,
    feasible,
    immediateVerifiedConcurrency: immediateConcurrency,
    queueingRequired,
    estimatedWaves,
    acceptingPools,
    unavailablePools,
    zeroClaudeEnforced: true,
    explanation,
  };
}

// ============================================================================
// Shared Intent Dispatcher (Single Entry Point for CLI, TUI, and HTTP API)
// ============================================================================

export async function dispatchMetaHarnessIntent(
  input: string,
  handlers: MetaHarnessIntentHandlers,
  viewOpts: ProgressiveViewOptions = {},
): Promise<MetaHarnessIntentDispatchResult> {
  const classification = classifyMetaHarnessIntent(input);
  const effectiveOpts: ProgressiveViewOptions = {
    ...viewOpts,
    detail: viewOpts.detail ?? classification.params.detailRequested ?? false,
  };

  if (!classification.isOperationalIntent || classification.intent === 'ORDINARY_PROMPT') {
    const reply = handlers.handleOrdinaryPrompt
      ? await handlers.handleOrdinaryPrompt(input)
      : 'Prompt classified as ordinary non-infrastructure request.';
    return {
      classification,
      handledByMetaHarness: false,
      summary: reply,
      renderedView: reply,
      data: { reply },
    };
  }

  switch (classification.intent) {
    case 'DISCOVER_MACHINES': {
      const discovered = handlers.discoverMachines
        ? await handlers.discoverMachines()
        : {
            graph: await handlers.getCapabilityGraph(),
            acceptanceRows: (await handlers.getAcceptanceRows?.()) ?? [],
          };
      const rows = discovered.acceptanceRows ?? (await handlers.getAcceptanceRows?.()) ?? [];
      const rendered = renderInfrastructureView(discovered.graph, rows, effectiveOpts);
      const hostCount = Object.keys(discovered.graph.hosts).length;
      return {
        classification,
        handledByMetaHarness: true,
        summary: `Discovered ${hostCount} sovereign physical machine(s).`,
        renderedView: rendered,
        data: { graph: discovered.graph, acceptanceRows: rows },
      };
    }

    case 'QUERY_GPUS': {
      const graph = await handlers.getCapabilityGraph();
      const gpuInventory = Object.values(graph.hosts).flatMap((host) =>
        host.gpus.map((gpu) => ({
          hostId: host.hostId,
          hostname: host.hostname,
          ...gpu,
        })),
      );
      const lines = [
        `## Available GPUs & Unified Memory Accelerators (${gpuInventory.length})`,
        ...gpuInventory.map(
          (g) =>
            `- \`${g.hostId}\` — **${g.model}** (${g.vendor}, ${g.availableMemoryGB !== undefined ? `${g.availableMemoryGB.toFixed(1)}/` : ''}${g.totalMemoryGB}GB${g.unifiedMemory ? ' Unified Memory' : ' VRAM'}, util=${g.utilizationPercent ?? 0}%)`,
        ),
      ];
      if (gpuInventory.length === 0) {
        lines.push('- No physical GPUs discovered in current CapabilityGraph.');
      }
      return {
        classification,
        handledByMetaHarness: true,
        summary: `Found ${gpuInventory.length} GPU/Unified-Memory accelerator(s) across ${Object.keys(graph.hosts).length} host(s).`,
        renderedView: lines.join('\n'),
        data: { gpus: gpuInventory },
      };
    }

    case 'BEST_HOST_FOR_MODEL': {
      const graph = await handlers.getCapabilityGraph();
      const billions = classification.params.parameterBillions ?? 30;
      const recommendation = evaluateBestHostForModel(
        graph,
        billions,
        classification.params.isMoEHint ?? false,
      );
      const lines = [
        `## Best Machine for ${billions}B${classification.params.isMoEHint ? ' MoE' : ''} Model (~${recommendation.estimatedRequiredMemoryGB}GB footprint)`,
        recommendation.recommendedHostId
          ? `**Recommended Host**: \`${recommendation.recommendedHostId}\``
          : '**Recommended Host**: None — no discovered host currently has enough free memory.',
        '',
        ...recommendation.rankedHosts.map(
          (h, idx) =>
            `${idx + 1}. \`${h.hostId}\` (${h.hostname}): ${h.fitsInMemory ? 'FITS' : 'INSUFFICIENT'} — ${h.reason}`,
        ),
      ];
      return {
        classification,
        handledByMetaHarness: true,
        summary: recommendation.recommendedHostId
          ? `Best host for ${billions}B model: ${recommendation.recommendedHostId}.`
          : `No host currently fits a ${billions}B model (~${recommendation.estimatedRequiredMemoryGB}GB).`,
        renderedView: lines.join('\n'),
        data: recommendation,
      };
    }

    case 'LIST_NETWORK_MODELS': {
      const graph = await handlers.getCapabilityGraph();
      const models: LoadedModelNode[] = Object.values(graph.models);
      const loaded = models.filter((m) => m.residency === 'loaded');
      const installed = models.filter((m) => m.residency === 'installed_not_loaded');
      const lines = [
        `## Models Across Network (${loaded.length} Warm Loaded, ${installed.length} Installed Cold)`,
        ...models.map(
          (m) =>
            `- \`${m.modelId}\` on \`${m.hostId ?? m.providerId ?? 'unknown'}\` [${m.residency}] (toolsVerified=${m.toolCallingVerified}${m.measuredTokensPerSecond ? `, ${m.measuredTokensPerSecond.toFixed(1)} tok/s` : ''})`,
        ),
      ];
      return {
        classification,
        handledByMetaHarness: true,
        summary: `Enumerated ${models.length} model(s) (${loaded.length} warm loaded, ${installed.length} cold installed).`,
        renderedView: lines.join('\n'),
        data: { models, loadedCount: loaded.length, installedCount: installed.length },
      };
    }

    case 'AVAILABLE_AGENT_CAPACITY': {
      const graph = await handlers.getCapabilityGraph();
      const quantities = (await handlers.getPoolQuantities?.()) ?? {};
      const rows = (await handlers.getAcceptanceRows?.()) ?? [];

      const capacityItems: Array<{
        poolOrHost: string;
        running: number;
        limit: number;
        availableSlots: number;
        status: string;
      }> = [];

      if (Object.keys(quantities).length > 0) {
        for (const q of Object.values(quantities)) {
          if (!q.enabled || q.poolId === 'claude') continue;
          const avail = Math.max(0, q.effectiveConcurrentLimit - q.runningAgents);
          capacityItems.push({
            poolOrHost: q.poolId,
            running: q.runningAgents,
            limit: q.effectiveConcurrentLimit,
            availableSlots: avail,
            status: q.unavailabilityReason ? 'UNAVAILABLE' : avail > 0 ? 'ACCEPTING_ADDITIONAL' : 'SATURATED',
          });
        }
      } else {
        for (const r of rows) {
          if (r.pool === 'claude' || r.status === 'DISABLED_BY_POLICY') continue;
          const limit = r.verifiedConcurrency ?? r.configuredMaxConcurrent;
          const avail =
            r.status === 'UNAVAILABLE' ? 0 : Math.max(0, limit - r.running);
          capacityItems.push({
            poolOrHost: r.pool,
            running: r.running,
            limit,
            availableSlots: avail,
            status: r.status,
          });
        }
      }

      const acceptingAdditional = capacityItems.filter((c) => c.availableSlots > 0);
      const totalSpareSlots = acceptingAdditional.reduce((a, c) => a + c.availableSlots, 0);
      const lines = [
        `## Available Additional Agent Capacity (${totalSpareSlots} Immediate Spare Slot(s) across ${Object.keys(graph.hosts).length} Host(s))`,
        ...capacityItems.map(
          (c) =>
            `- \`${c.poolOrHost}\`: **${c.availableSlots}** spare slot(s) (${c.running}/${c.limit} running, status=\`${c.status}\`)`,
        ),
      ];
      return {
        classification,
        handledByMetaHarness: true,
        summary: `${acceptingAdditional.length} pool(s) can immediately accept ${totalSpareSlots} additional agent(s).`,
        renderedView: lines.join('\n'),
        data: { capacityItems, totalSpareSlots },
      };
    }

    case 'INSPECT_HOST_EXECUTION': {
      const targetHostId = classification.params.targetHostId ?? 'dgx_spark';
      const graph = await handlers.getCapabilityGraph();
      const tasks = (await handlers.getManagedTasks?.()) ?? [];
      const host = graph.hosts[targetHostId];
      const hostTasks = tasks.filter(
        (t) =>
          t.lease?.hostId === targetHostId ||
          (t.executedPoolId ?? t.assignedPoolId) === targetHostId,
      );
      const activeTasks = hostTasks.filter((t) => t.state === 'running' || t.state === 'verifying');
      const queuedTasks = hostTasks.filter((t) => t.state === 'queued');
      const warmModels = Object.values(graph.models).filter(
        (m) => m.hostId === targetHostId && m.residency === 'loaded',
      );

      const lines = [
        `## Active Execution on \`${targetHostId}\`${host ? ` (${host.hostname})` : ''}`,
        `- Warm Loaded Models: ${warmModels.map((m) => `\`${m.modelId}\``).join(', ') || 'none'}`,
        `- Running Tasks: **${activeTasks.length}** | Queued: **${queuedTasks.length}** | Total Assigned: **${hostTasks.length}**`,
        ...activeTasks.map(
          (t) =>
            `  - \`${t.logicalAgentId}\` (\`${t.taskId}\`): ${t.profile.title} [model=\`${t.lease?.modelId ?? 'default'}\`]`,
        ),
      ];
      if (host && host.workloadConflicts.length > 0) {
        lines.push(
          `- External Workloads: ${host.workloadConflicts.map((w) => `\`${w.processName}\` (${w.reservedVramGB}GB VRAM)`).join(', ')}`,
        );
      }

      return {
        classification,
        handledByMetaHarness: true,
        summary: `Host ${targetHostId}: ${activeTasks.length} running task(s), ${queuedTasks.length} queued, ${warmModels.length} warm model(s).`,
        renderedView: lines.join('\n'),
        data: { targetHostId, host, activeTasks, queuedTasks, warmModels },
      };
    }

    case 'FIND_INFERENCE_SERVERS': {
      const graph = await handlers.getCapabilityGraph();
      const filterTypes = classification.params.runtimeTypes;
      const runtimes = Object.values(graph.runtimeProcesses).filter(
        (r) => !filterTypes || filterTypes.length === 0 || filterTypes.includes(r.runtimeType),
      );
      const endpoints = Object.values(graph.endpoints).filter((ep) =>
        runtimes.some((r) => r.runtimeId === ep.runtimeId),
      );

      const lines = [
        `## Discovered Inference Servers (${endpoints.length} Endpoint(s))`,
        ...endpoints.map((ep) => {
          const rt = graph.runtimeProcesses[ep.runtimeId];
          return `- \`${ep.hostId}\` — \`${rt?.runtimeType ?? ep.runtimeId}\` at \`${ep.rawUrl}\` (origin=\`${ep.originContextHostId}\`, scope=\`${ep.visibility}\`, state=\`${ep.acceptanceState}\`)`;
        }),
      ];
      return {
        classification,
        handledByMetaHarness: true,
        summary: `Found ${endpoints.length} inference endpoint(s)${filterTypes?.length ? ` matching ${filterTypes.join(', ')}` : ''}.`,
        renderedView: lines.join('\n'),
        data: { runtimes, endpoints },
      };
    }

    case 'CHECK_SCALE_FEASIBILITY': {
      const requested = classification.params.requestedAgents ?? 100;
      const graph = await handlers.getCapabilityGraph();
      const rows = (await handlers.getAcceptanceRows?.()) ?? [];
      const plan = await handlers.getCurrentPlan?.();
      const feasibility = assessScaleFeasibility(requested, graph, rows, plan);
      return {
        classification,
        handledByMetaHarness: true,
        summary: feasibility.explanation,
        renderedView: `## Scale Feasibility (${requested} Agents)\n\n${feasibility.explanation}`,
        data: feasibility,
      };
    }

    case 'FIND_IDLE_HARDWARE': {
      const graph = await handlers.getCapabilityGraph();
      const tasks = (await handlers.getManagedTasks?.()) ?? [];
      const busyHostIds = new Set(
        tasks
          .filter((t) => t.state === 'running' || t.state === 'verifying')
          .map((t) => t.lease?.hostId ?? t.executedPoolId ?? t.assignedPoolId),
      );

      const idleHosts = Object.values(graph.hosts).filter((h) => {
        const hasRunningTask = busyHostIds.has(h.hostId);
        const lowCpu = h.cpu.utilizationPercent < 20;
        const lowGpu = h.gpus.every((g) => (g.utilizationPercent ?? 0) < 15);
        const noConflict = h.workloadConflicts.length === 0;
        return !hasRunningTask && lowCpu && lowGpu && noConflict;
      });

      const lines = [
        `## Idle Hardware (${idleHosts.length} Idle Host(s))`,
        ...(idleHosts.length > 0
          ? idleHosts.map(
              (h) =>
                `- \`${h.hostId}\` (${h.hostname}): CPU=${h.cpu.utilizationPercent}%, RAM free=${h.memory.availableGB.toFixed(1)}GB`,
            )
          : ['- All discovered physical hosts currently have active tasks or workloads.']),
      ];

      return {
        classification,
        handledByMetaHarness: true,
        summary: `${idleHosts.length} physical machine(s) currently idle.`,
        renderedView: lines.join('\n'),
        data: { idleHosts },
      };
    }

    case 'OPTIMIZE_FOR_COST':
    case 'CONFIGURE_ROUTING_POLICY': {
      const policySpec: RoutingPolicyUpdateSpec = {
        taskType: classification.params.taskType,
        preferredModelFamily: classification.params.preferredModelFamily,
        localFirst: classification.params.localFirst ?? true,
        cloudOnlyWhenNecessary: classification.params.cloudOnlyWhenNecessary ?? true,
        disabledProviders: ['claude'],
      };

      if (handlers.applyRoutingPolicy) {
        const applied = await handlers.applyRoutingPolicy(policySpec);
        return {
          classification,
          handledByMetaHarness: true,
          summary: applied.summary,
          renderedView: `## Updated Routing & Cost Policy\n\n- ${applied.summary}\n- Strategy: \`${applied.updatedPlan.spec.routing.strategy}\`\n- Zero-Claude Policy: \`claude=0% (DISABLED_BY_POLICY)\``,
          data: applied,
        };
      }

      const plan = await handlers.getCurrentPlan?.();
      const updatedPlan = plan ? structuredClone(plan) : undefined;
      if (updatedPlan) {
        updatedPlan.spec.routing.strategy =
          classification.intent === 'OPTIMIZE_FOR_COST' ? 'lowest_expected_cost' : 'local_first';
      }
      const summary = `Configured ${classification.intent === 'OPTIMIZE_FOR_COST' ? 'lowest_expected_cost' : 'local_first'} routing${policySpec.preferredModelFamily ? ` preferring local ${policySpec.preferredModelFamily} models` : ''}${policySpec.taskType ? ` for ${policySpec.taskType} tasks` : ''}, using cloud only when necessary (claude=0%).`;
      return {
        classification,
        handledByMetaHarness: true,
        summary,
        renderedView: `## Routing Policy Updated\n\n- ${summary}`,
        data: { policySpec, updatedPlan },
      };
    }

    case 'DISTRIBUTE_PLAN': {
      const planName = classification.params.planName ?? 'fs5';
      const requestedAgents = classification.params.requestedAgents ?? 20;

      if (handlers.distributePlan) {
        const distributed = await handlers.distributePlan(planName, requestedAgents);
        const reconciliation = await handlers.getReconciliationSnapshot?.();
        const rendered = renderExecutionView(
          distributed.plan,
          distributed.quantities,
          distributed.tasks ?? [],
          reconciliation,
          effectiveOpts,
        );
        return {
          classification,
          handledByMetaHarness: true,
          summary: `Distributed ${requestedAgents} agents under plan "${planName}" (0% Claude).`,
          renderedView: rendered,
          data: distributed,
        };
      }

      const existingPlan = await handlers.getCurrentPlan?.(planName);
      const quantities = (await handlers.getPoolQuantities?.()) ?? {};
      const tasks = (await handlers.getManagedTasks?.()) ?? [];
      if (existingPlan) {
        const cloned = structuredClone(existingPlan);
        cloned.spec.execution.total_agents = requestedAgents;
        const rendered = renderExecutionView(cloned, quantities, tasks, undefined, effectiveOpts);
        return {
          classification,
          handledByMetaHarness: true,
          summary: `Prepared ${requestedAgents}-agent distribution on plan "${cloned.metadata.name}".`,
          renderedView: rendered,
          data: { plan: cloned, quantities, tasks },
        };
      }

      return {
        classification,
        handledByMetaHarness: true,
        summary: `Requested distribution of ${requestedAgents} agents on plan "${planName}" (no active plan loaded yet).`,
        renderedView: `Plan \`${planName}\` requested for **${requestedAgents}** agents.`,
        data: { planName, requestedAgents },
      };
    }

    case 'IMPLEMENT_FEATURE': {
      const spec = classification.params.featureSpecification ?? input;
      if (handlers.implementFeature) {
        const outcome = await handlers.implementFeature(spec);
        return {
          classification,
          handledByMetaHarness: true,
          summary: outcome.summary,
          renderedView: `## Feature Implementation & Verification\n\n- ${outcome.summary}\n- Changed Files: ${outcome.changedFiles.map((f) => `\`${f}\``).join(', ') || 'none'}\n- Independent Verification: \`${outcome.verification ? (outcome.verification.passed ? 'PASSED' : 'FAILED') : 'PENDING'}\``,
          data: outcome,
        };
      }
      return {
        classification,
        handledByMetaHarness: true,
        summary: `Queued feature implementation request across distributed orchestration pipeline.`,
        renderedView: `## Feature Implementation Dispatched\n\nSpecification: ${spec}`,
        data: { featureSpecification: spec },
      };
    }

    case 'VERIFY_EXECUTION': {
      if (handlers.verifyExecution) {
        const qual = await handlers.verifyExecution();
        const rendered = renderQualificationView(
          qual.journeys ?? [],
          qual.acceptanceTests ?? [],
          qual.faults ?? [],
          [],
          effectiveOpts,
        );
        return {
          classification,
          handledByMetaHarness: true,
          summary: qual.summary ?? 'Completed independent execution & qualification verification.',
          renderedView: rendered,
          data: qual,
        };
      }

      // Fallback: run independent verification over live acceptanceRows, quantities, and tasks
      const acceptanceRows = (await handlers.getAcceptanceRows?.()) ?? [];
      const poolQuantities = (await handlers.getPoolQuantities?.()) ?? {};
      const managedTasks = (await handlers.getManagedTasks?.()) ?? [];
      const plan = await handlers.getCurrentPlan?.();

      const independentCheck = await verifyDeliverableIndependently({
        producingAgentId: 'distributed-wave-agents',
        verifierId: 'intent-router-independent-verifier',
        acceptanceRows,
        poolQuantities,
        managedTasks,
        plan,
      });

      const summary = independentCheck.passed
        ? `Yes — independent verification PASSED (evidenceId=${independentCheck.evidenceId}).`
        : `Independent verification FAILED: ${independentCheck.failureReasons.join('; ')}`;

      return {
        classification,
        handledByMetaHarness: true,
        summary,
        renderedView: `## Independent Execution Verification\n\n- Status: **${independentCheck.passed ? 'VERIFIED PASS' : 'FAILED'}**\n- Summary: ${summary}`,
        data: independentCheck,
      };
    }

    case 'IMPROVE_EXECUTION': {
      const currentPlan = await handlers.getCurrentPlan?.();
      const history: ExecutionHistoryInput = handlers.getExecutionHistory
        ? await handlers.getExecutionHistory()
        : {
            observations: [],
            acceptanceRows: (await handlers.getAcceptanceRows?.()) ?? [],
            poolQuantities: (await handlers.getPoolQuantities?.()) ?? {},
          };

      if (!currentPlan) {
        return {
          classification,
          handledByMetaHarness: true,
          summary: 'Cannot optimize execution before an ExecutionPlan is loaded.',
          renderedView: 'Load an `ExecutionPlan` (e.g. `fs5`) before running self-improvement.',
          data: { history },
        };
      }

      const optResult = analyzeAndOptimizeExecution(history, currentPlan);
      if (optResult.promotedImprovements.length > 0 && handlers.promoteOptimizedPlan) {
        await handlers.promoteOptimizedPlan(optResult);
      }

      const rendered = renderOptimizationView(
        optResult.observedMetrics,
        optResult.candidates,
        optResult.observedMetrics.costBreakdown,
        effectiveOpts,
      );

      return {
        classification,
        handledByMetaHarness: true,
        summary: optResult.summary,
        renderedView: rendered,
        data: optResult,
      };
    }
  }
}
