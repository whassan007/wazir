import { performance } from 'node:perf_hooks';
import {
  findHostInCapabilityGraph,
  resolveEndpointForCaller,
  validateExecutionPlan,
} from './executionPlan.js';
import type {
  AcceptanceState,
  CapabilityGraph,
  ClassifiedTaskProfile,
  CodingAgentProviderNode,
  ConcurrencyQualificationResult,
  DeclarativeExecutionPlan,
  EndpointResolutionResult,
  ExecutionPlanPoolSpec,
  HardUserConstraints,
  InferenceEndpointNode,
  LoadedModelNode,
  PhysicalHostNode,
  RoutingStrategyName,
} from './types.js';

const KNOWN_PROVIDERS = [
  'claude',
  'anthropic',
  'codex',
  'openai',
  'antigravity',
  'google',
  'gemini',
  'nvidia',
  'opencode',
] as const;

const KNOWN_MODEL_FAMILIES = [
  'qwen',
  'deepseek',
  'llama',
  'gemma',
  'nemotron',
  'mistral',
  'codestral',
  'phi',
] as const;

function normalizePoolAlias(rawTarget: string): string {
  const cleaned = rawTarget
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .trim();

  if (/\bdgx(?:\s+spark)?\b/.test(cleaned) || cleaned === 'dgx_spark') {
    return 'dgx_spark';
  }
  if (/\bmac\s*studio\b/.test(cleaned) || cleaned === 'studio' || cleaned === 'mac_studio') {
    return 'mac_studio';
  }
  if (
    /\bmacbook(?:\s+pro)?\b/.test(cleaned) ||
    cleaned === 'laptop' ||
    cleaned === 'mbp' ||
    cleaned === 'macbook_pro'
  ) {
    return 'macbook_pro';
  }
  if (/\bantigravity\b/.test(cleaned)) {
    return 'antigravity';
  }
  if (/\bcodex\b/.test(cleaned)) {
    return 'codex';
  }
  if (/\bclaude\b/.test(cleaned)) {
    return 'claude';
  }
  return cleaned.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeWorkloadName(rawWorkload: string): string {
  return rawWorkload
    .trim()
    .toLowerCase()
    .replace(/[.!?,;]+$/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Parses natural-language hard user routing constraints into a deterministic
 * `HardUserConstraints` structure enforced as non-negotiable admissibility gates.
 */
export function parseHardUserConstraints(constraints: string[]): HardUserConstraints {
  const disabledSet = new Set<string>();
  let localMachinesOnly = false;
  let paidCloudAllowed = true;
  let neverSendRepoToCloud = false;
  const pinnedPoolShares: Record<string, number> = {};
  const protectedWorkloadSet = new Set<string>();
  let preferredModelFamily: string | undefined;
  let maxBudgetUsd: number | undefined;

  for (const raw of constraints) {
    const line = raw.trim();
    if (!line) continue;
    const lower = line.toLowerCase();

    // 1. Disabled providers ("Do not use Claude", "Never use Anthropic", "Zero Claude", etc.)
    for (const provider of KNOWN_PROVIDERS) {
      const escaped = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const forbidRe = new RegExp(
        `\\b(?:do\\s+not\\s+use|don't\\s+use|never\\s+use|disable|no|zero|forbid|ban|exclude)\\s+(?:any\\s+)?${escaped}\\b`,
        'i',
      );
      const trailingDisableRe = new RegExp(
        `\\b${escaped}\\s+(?:is\\s+)?(?:disabled|forbidden|banned|0%)\\b`,
        'i',
      );
      if (forbidRe.test(lower) || trailingDisableRe.test(lower)) {
        if (provider === 'anthropic') {
          disabledSet.add('claude');
          disabledSet.add('anthropic');
        } else {
          disabledSet.add(provider);
        }
      }
    }

    // 2. Local machines only ("Use only local machines", "Local hardware only", "No cloud agents")
    if (
      /\buse\s+only\s+local\b/.test(lower) ||
      /\bonly\s+local\s+(?:machines?|hardware|hosts?|pools?|models?)\b/.test(lower) ||
      /\blocal\s+(?:machines?|hardware|hosts?)\s+only\b/.test(lower) ||
      /\b(?:do\s+not|don't|never)\s+use\s+(?:any\s+)?cloud\s+(?:agents?|models?|pools?)\b/.test(lower) ||
      /\bno\s+cloud\s+(?:agents?|execution)\b/.test(lower)
    ) {
      localMachinesOnly = true;
    }

    // 3. Paid cloud restriction ("Do not use paid cloud providers", "No paid cloud", "Zero cloud spend")
    if (
      /\b(?:do\s+not|don't|never)\s+use\s+paid\s+cloud\b/.test(lower) ||
      /\bno\s+paid\s+cloud\b/.test(lower) ||
      /\bzero\s+(?:paid\s+)?cloud\s+(?:cost|spend)\b/.test(lower) ||
      /\bfree\s+cloud\s+only\b/.test(lower)
    ) {
      paidCloudAllowed = false;
      if (maxBudgetUsd === undefined) {
        maxBudgetUsd = 0;
      }
    }

    // 4. Repository confidentiality ("Never send this repository to a cloud agent")
    if (
      /\b(?:never|do\s+not|don't)\s+(?:send|upload|share|transmit|expose)\s+(?:this\s+|the\s+)?(?:repo|repository|codebase|source\s+code)\b.*\bcloud\b/.test(
        lower,
      ) ||
      /\bkeep\s+(?:this\s+|the\s+)?(?:repo|repository|codebase)\s+local\b/.test(lower)
    ) {
      neverSendRepoToCloud = true;
    }

    // 5. Pinned pool share ("Keep 35% of agents on DGX", "Allocate 25% to Mac Studio")
    const shareRegex =
      /(?:keep|maintain|pin|allocate|assign|reserve|route)?\s*(\d+(?:\.\d+)?)\s*%\s*(?:of\s+(?:the\s+)?(?:agents?|tasks?|subagents?|work)\s+)?(?:on|to|for|at)\s+([a-zA-Z0-9_\s-]+?)(?:[.!,;]|$|\s+and\s+)/gi;
    let shareMatch: RegExpExecArray | null;
    while ((shareMatch = shareRegex.exec(line)) !== null) {
      const pct = Number(shareMatch[1]);
      const poolAlias = normalizePoolAlias(shareMatch[2]);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100 && poolAlias) {
        pinnedPoolShares[poolAlias] = pct;
      }
    }

    // 6. Protected workloads ("Do not interrupt Isaac Sim", "Do not disturb Blender")
    const workloadMatch =
      /\b(?:do\s+not|don't|never)\s+(?:interrupt|disturb|evict|impact|disrupt|kill|stop)\s+([a-zA-Z0-9_.\s-]+?)(?:[.!,;]|$)/i.exec(
        line,
      );
    if (workloadMatch) {
      const wl = normalizeWorkloadName(workloadMatch[1]);
      if (wl && !KNOWN_PROVIDERS.includes(wl as (typeof KNOWN_PROVIDERS)[number])) {
        protectedWorkloadSet.add(wl);
      }
    }

    // 7. Preferred model family ("Use Qwen unless the task requires another model", "Route coding tasks to local Qwen models...")
    for (const family of KNOWN_MODEL_FAMILIES) {
      const famRe = new RegExp(
        `\\b(?:use\\s+|prefer\\s+|prioritize\\s+|default\\s+to\\s+|route\\s+[a-z\\s]*?to\\s+(?:local\\s+)?)${family}\\b`,
        'i',
      );
      if (famRe.test(lower)) {
        preferredModelFamily = family;
        break;
      }
    }

    // 8. Explicit USD budget ("Max budget $5.00", "Budget <= $2.50")
    const budgetMatch =
      /\b(?:max(?:imum)?\s+budget|budget(?:\s+limit|\s+cap)?|under|at\s+most)\s*(?:of\s*|<=?\s*)?\$\s*(\d+(?:\.\d+)?)/i.exec(
        line,
      );
    if (budgetMatch) {
      const usd = Number(budgetMatch[1]);
      if (Number.isFinite(usd) && usd >= 0) {
        maxBudgetUsd = maxBudgetUsd === undefined ? usd : Math.min(maxBudgetUsd, usd);
      }
    }
  }

  return {
    disabledProviders: Array.from(disabledSet).sort(),
    localMachinesOnly,
    paidCloudAllowed,
    neverSendRepoToCloud,
    pinnedPoolShares,
    protectedWorkloads: Array.from(protectedWorkloadSet).sort(),
    ...(preferredModelFamily ? { preferredModelFamily } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
  };
}

export interface ClassifyTaskRequirementsInput {
  taskId: string;
  prompt: string;
  title?: string;
  explicitOs?: 'linux' | 'darwin' | 'win32';
  requiresTools?: boolean;
  dataSensitivity?: 'public' | 'internal' | 'restricted_local_only';
  dependsOn?: string[];
  priority?: number;
  maxCostUsd?: number;
  requiresRepoAccess?: boolean;
}

/**
 * Classifies a task prompt and explicit metadata into a structured `ClassifiedTaskProfile`
 * covering formatting, architecture, coding, testing, verification, research,
 * CUDA/NVIDIA GPU workloads, browser E2E, and macOS native UI tasks.
 */
export function classifyTaskRequirements(
  input: ClassifyTaskRequirementsInput,
): ClassifiedTaskProfile {
  const prompt = input.prompt.trim();
  const lower = prompt.toLowerCase();

  const hasCudaSignal =
    /\b(?:cuda|nvcc|cudnn|tensorrt|nccl|triton|cupy|isaac\s*sim|nvidia\s+gpu|gpu\s+kernel|ptx)\b/.test(
      lower,
    );
  const hasBrowserSignal =
    /\b(?:playwright|cypress|puppeteer|selenium|browser\s+e2e|web\s+e2e|headless\s+browser|headless\s+chrome|chromium\s+e2e|dom\s+snapshot)\b/.test(
      lower,
    );
  const hasMacUiSignal =
    /\b(?:swiftui|xcuitest|xcodebuild|xcode|appkit|cocoa|macos\s+ui|mac\s+ui|mac\s+desktop\s+app|metal\s+shader)\b/.test(
      lower,
    );
  const hasFormattingSignal =
    /\b(?:prettier|eslint\s+--fix|clang-format|rustfmt|gofmt|black\s+format|reformat|whitespace\s+only|sort\s+imports|fix\s+indentation|formatting\s+pass|fix\s+typos?)\b/.test(
      lower,
    );
  const hasArchitectureSignal =
    /\b(?:architecture|system\s+design|distributed\s+protocol|consensus|meta-harness\s+design|cross-cutting\s+refactor|multi-package\s+design|rfc|threat\s+model|formal\s+spec)\b/.test(
      lower,
    );
  const hasVerificationSignal =
    /\b(?:qualification\s+gate|independent\s+verification|verify\s+compliance|acceptance\s+gate|audit\s+verification|release\s+gate)\b/.test(
      lower,
    );
  const hasTestingSignal =
    /\b(?:pytest|vitest|jest|hypothesis|property-based\s+test|unit\s+tests?|integration\s+tests?|regression\s+tests?|test\s+coverage)\b/.test(
      lower,
    );
  const hasResearchSignal =
    /\b(?:literature\s+review|survey|research\s+report|investigate\s+options|compare\s+approaches)\b/.test(
      lower,
    ) && !/\b(?:implement|write|edit|refactor|fix)\b/.test(lower);

  let taskType: ClassifiedTaskProfile['taskType'] = 'coding';
  if (hasCudaSignal) {
    taskType = 'cuda_gpu';
  } else if (hasBrowserSignal) {
    taskType = 'browser_e2e';
  } else if (hasMacUiSignal) {
    taskType = 'mac_ui';
  } else if (hasArchitectureSignal) {
    taskType = 'architecture';
  } else if (hasFormattingSignal && !hasTestingSignal) {
    taskType = 'formatting';
  } else if (hasVerificationSignal) {
    taskType = 'verification';
  } else if (hasTestingSignal) {
    taskType = 'testing';
  } else if (hasResearchSignal) {
    taskType = 'research';
  }

  const requiresNvidiaCuda = taskType === 'cuda_gpu' || hasCudaSignal;
  const requiresBrowser = taskType === 'browser_e2e' || hasBrowserSignal;

  let requiredOs: 'linux' | 'darwin' | 'win32' | undefined = input.explicitOs;
  if (!requiredOs) {
    if (requiresNvidiaCuda || /\blinux[-\s]only\b|\bubuntu\b|\bsystemd\b/.test(lower)) {
      requiredOs = 'linux';
    } else if (taskType === 'mac_ui' || /\bmacos[-\s]only\b|\bdarwin\b/.test(lower)) {
      requiredOs = 'darwin';
    } else if (/\bwindows[-\s]only\b|\bwin32\b|\bpowershell\b/.test(lower)) {
      requiredOs = 'win32';
    }
  }

  const requiredTools = new Set<string>();
  const requiredCapabilities = new Set<string>();

  const needsTools =
    input.requiresTools ??
    (taskType !== 'research' && taskType !== 'formatting');

  if (needsTools) {
    requiredTools.add('read_file');
    requiredTools.add('write_file');
    if (input.requiresTools === true) {
      requiredCapabilities.add('tool_calling');
    }
  }

  switch (taskType) {
    case 'cuda_gpu':
      requiredTools.add('shell');
      requiredCapabilities.add('cuda');
      requiredCapabilities.add('gpu_compute');
      requiredCapabilities.add('coding');
      break;
    case 'browser_e2e':
      requiredTools.add('browser');
      requiredTools.add('shell');
      requiredCapabilities.add('browser');
      requiredCapabilities.add('testing');
      break;
    case 'mac_ui':
      requiredTools.add('shell');
      requiredCapabilities.add('macos_native');
      requiredCapabilities.add('coding');
      break;
    case 'architecture':
      requiredCapabilities.add('architecture');
      requiredCapabilities.add('reasoning');
      break;
    case 'testing':
    case 'verification':
      requiredTools.add('shell');
      requiredCapabilities.add('testing');
      break;
    case 'formatting':
      requiredCapabilities.add('formatting');
      break;
    case 'research':
      requiredTools.add('read_file');
      requiredCapabilities.add('research');
      break;
    case 'coding':
    default:
      requiredTools.add('shell');
      requiredCapabilities.add('coding');
      break;
  }

  let minimumMemoryGB = 8;
  let requiredContextTokens = 16_384;
  let expectedDurationMs = 45_000;

  if (taskType === 'formatting') {
    minimumMemoryGB = 4;
    requiredContextTokens = 8_192;
    expectedDurationMs = 12_000;
  } else if (taskType === 'architecture') {
    minimumMemoryGB = 16;
    requiredContextTokens = 32_768;
    expectedDurationMs = 90_000;
  } else if (taskType === 'cuda_gpu') {
    minimumMemoryGB = 16;
    requiredContextTokens = 16_384;
    expectedDurationMs = 75_000;
  } else if (taskType === 'browser_e2e') {
    minimumMemoryGB = 8;
    requiredContextTokens = 16_384;
    expectedDurationMs = 60_000;
  }

  const inferredRestricted =
    /\b(?:restricted_local_only|confidential|secret|proprietary|never\s+send\s+to\s+cloud|air[-\s]?gapped)\b/.test(
      lower,
    );
  const dataSensitivity: ClassifiedTaskProfile['dataSensitivity'] =
    input.dataSensitivity ?? (inferredRestricted ? 'restricted_local_only' : 'internal');

  const verificationCriteria: string[] = [];
  if (taskType === 'cuda_gpu') {
    verificationCriteria.push('nvidia_cuda_execution_exit_0');
  }
  if (taskType === 'browser_e2e') {
    verificationCriteria.push('browser_e2e_assertions_passed');
  }
  if (taskType === 'testing' || taskType === 'verification') {
    verificationCriteria.push('deterministic_test_suite_exit_0');
  }
  if (taskType === 'coding' || taskType === 'architecture' || taskType === 'mac_ui') {
    verificationCriteria.push('typecheck_and_build_clean');
  }
  if (verificationCriteria.length === 0) {
    verificationCriteria.push('output_schema_valid');
  }

  const title =
    input.title ??
    (prompt.length <= 72 ? prompt : `${prompt.slice(0, 69).trimEnd()}...`);

  return {
    taskId: input.taskId,
    title,
    taskType,
    requiredTools: Array.from(requiredTools).sort(),
    ...(requiredOs ? { requiredOs } : {}),
    requiresNvidiaCuda,
    requiresBrowser,
    minimumMemoryGB,
    requiredContextTokens,
    expectedDurationMs,
    requiredCapabilities: Array.from(requiredCapabilities).sort(),
    requiresRepoAccess: input.requiresRepoAccess ?? true,
    dataSensitivity,
    ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
    dependsOn: [...(input.dependsOn ?? [])],
    verificationCriteria,
    priority: input.priority ?? 5,
  };
}

export interface HistoricalRouteObservation {
  poolId?: string;
  hostId?: string;
  providerId?: string;
  runtimeId?: string;
  modelId: string;
  taskType?: ClassifiedTaskProfile['taskType'];
  sampleCount: number;
  successCount: number;
  avgLatencyMs?: number;
  avgTokensPerSecond?: number;
  toolCallSuccessRate?: number;
}

export interface RouteScoreBreakdown {
  expectedSuccessProbability: number;
  verifiedCapabilityScore: number;
  latencyScore: number;
  localResourceScore: number;
  costScore: number;
  contentionScore: number;
  historicalReliabilityScore: number;
  dataLocalitySecurityScore: number;
  priorityDeadlineScore: number;
  shareBalanceBonus: number;
}

export interface ScoredRouteCandidate {
  poolId: string;
  targetKind: 'local_host' | 'cloud_provider';
  hostId?: string;
  providerId?: string;
  runtimeId: string;
  modelId: string;
  endpointUrl: string;
  routeVia: EndpointResolutionResult['routeVia'];
  acceptanceState: AcceptanceState;
  totalScore: number;
  breakdown: RouteScoreBreakdown;
  estimatedCostUsd: number;
  estimatedLatencyMs: number;
  historicalSampleCount: number;
  historicalReliabilityUsed: boolean;
  needsPilotProbe: boolean;
  effectiveConcurrentLimit: number;
  currentRunningInPool: number;
  willQueue: boolean;
}

export interface RejectedRouteCandidate {
  poolId: string;
  targetId: string;
  runtimeId: string;
  modelId: string;
  rejectionCodes: string[];
  reason: string;
}

export interface TaskRoutingDecision {
  taskId: string;
  scheduled: boolean;
  selectedRoute?: ScoredRouteCandidate;
  rankedAlternatives: ScoredRouteCandidate[];
  rejectedCandidates: RejectedRouteCandidate[];
  strategyUsed: RoutingStrategyName;
  needsPilotProbe: boolean;
  unscheduledReason?: string;
}

export interface ScheduleBatchResult {
  decisions: TaskRoutingDecision[];
  byTaskId: Record<string, TaskRoutingDecision>;
  assignedCountByPool: Record<string, number>;
  unscheduledTaskIds: string[];
  pilotProbeTaskIds: string[];
  cloudProviderCostUsd: number;
  localHardwareUtilizationPct: Record<string, number>;
  operationalOverheadMs: number;
}

export interface IntelligentSchedulerOptions {
  defaultMaxStaleMs?: number;
  historicalObservations?: HistoricalRouteObservation[];
  concurrencyQualifications?: ConcurrencyQualificationResult[];
}

export interface ScheduleContextOptions {
  strategyOverride?: RoutingStrategyName;
  additionalConstraints?: string[];
  maxStaleMs?: number;
  maxBudgetUsd?: number;
  currentCloudSpendUsd?: number;
  activeRunningByPool?: Record<string, number>;
  assignedSoFarByPool?: Record<string, number>;
  deadlineMs?: number;
  nowIso?: string;
}

interface StrategyWeightVector {
  success: number;
  capability: number;
  latency: number;
  localResource: number;
  cost: number;
  contention: number;
  historical: number;
  locality: number;
  priorityDeadline: number;
  shareBalance: number;
}

const STRATEGY_WEIGHTS: Record<RoutingStrategyName, StrategyWeightVector> = {
  local_first: {
    success: 0.14,
    capability: 0.16,
    latency: 0.08,
    localResource: 0.12,
    cost: 0.22,
    contention: 0.06,
    historical: 0.05,
    locality: 0.15,
    priorityDeadline: 0.02,
    shareBalance: 0.0,
  },
  fastest_verified: {
    success: 0.14,
    capability: 0.14,
    latency: 0.36,
    localResource: 0.06,
    cost: 0.04,
    contention: 0.16,
    historical: 0.04,
    locality: 0.02,
    priorityDeadline: 0.04,
    shareBalance: 0.0,
  },
  lowest_expected_cost: {
    success: 0.12,
    capability: 0.12,
    latency: 0.06,
    localResource: 0.08,
    cost: 0.44,
    contention: 0.05,
    historical: 0.04,
    locality: 0.07,
    priorityDeadline: 0.02,
    shareBalance: 0.0,
  },
  highest_qualified_success: {
    success: 0.34,
    capability: 0.30,
    latency: 0.06,
    localResource: 0.05,
    cost: 0.03,
    contention: 0.05,
    historical: 0.13,
    locality: 0.02,
    priorityDeadline: 0.02,
    shareBalance: 0.0,
  },
  strict_provider_allocation: {
    success: 0.10,
    capability: 0.12,
    latency: 0.06,
    localResource: 0.04,
    cost: 0.06,
    contention: 0.06,
    historical: 0.04,
    locality: 0.04,
    priorityDeadline: 0.02,
    shareBalance: 0.46,
  },
  capability_cost_latency: {
    success: 0.18,
    capability: 0.22,
    latency: 0.16,
    localResource: 0.08,
    cost: 0.14,
    contention: 0.08,
    historical: 0.06,
    locality: 0.05,
    priorityDeadline: 0.03,
    shareBalance: 0.08,
  },
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundDeterministic(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function estimateCloudTokensForTask(task: ClassifiedTaskProfile): {
  inputK: number;
  outputK: number;
} {
  switch (task.taskType) {
    case 'formatting':
      return { inputK: 1.5, outputK: 0.8 };
    case 'architecture':
      return { inputK: 10.0, outputK: 4.5 };
    case 'browser_e2e':
    case 'cuda_gpu':
    case 'testing':
    case 'verification':
      return { inputK: 5.0, outputK: 2.0 };
    case 'research':
      return { inputK: 6.0, outputK: 3.0 };
    case 'coding':
    case 'mac_ui':
    default:
      return { inputK: 4.5, outputK: 2.2 };
  }
}

function isAcceptableForScheduling(
  state: AcceptanceState,
  verifyExecutionCapability: boolean,
): boolean {
  if (
    state === 'EXECUTION_VERIFIED' ||
    state === 'CAPACITY_VERIFIED' ||
    state === 'SATURATED'
  ) {
    return true;
  }
  if (!verifyExecutionCapability && (state === 'MODEL_READY' || state === 'API_READY')) {
    return true;
  }
  return false;
}

/**
 * Hardware-, capability-, cost-, latency-, and security-aware scheduler for the
 * Wazir Meta-Harness. Strictly enforces 0% Claude, stale inventory rejection,
 * empirical-only historical scoring (`sampleCount >= 3`, never using parameter
 * count as a substitute for measured capability), bounded pilot probes, and
 * deterministic lexicographical tie-breaking.
 */
export class IntelligentHardwareScheduler {
  private readonly defaultMaxStaleMs: number;
  private readonly observations: HistoricalRouteObservation[];
  private readonly qualifications: ConcurrencyQualificationResult[];

  constructor(options: IntelligentSchedulerOptions = {}) {
    this.defaultMaxStaleMs = options.defaultMaxStaleMs ?? 300_000;
    this.observations = [...(options.historicalObservations ?? [])];
    this.qualifications = [...(options.concurrencyQualifications ?? [])];
  }

  public recordObservation(observation: HistoricalRouteObservation): void {
    this.observations.push({ ...observation });
  }

  private lookupHistoricalStats(
    poolId: string,
    runtimeId: string,
    modelId: string,
    taskType: ClassifiedTaskProfile['taskType'],
  ): {
    sampleCount: number;
    empiricalSuccessRate?: number;
    avgLatencyMs?: number;
    avgTokensPerSecond?: number;
    toolCallSuccessRate?: number;
  } {
    const exactMatches = this.observations.filter(
      (o) =>
        o.modelId.toLowerCase() === modelId.toLowerCase() &&
        (!o.poolId || o.poolId === poolId) &&
        (!o.runtimeId || o.runtimeId === runtimeId) &&
        (!o.taskType || o.taskType === taskType),
    );

    const modelMatches =
      exactMatches.length > 0
        ? exactMatches
        : this.observations.filter((o) => o.modelId.toLowerCase() === modelId.toLowerCase());

    if (modelMatches.length === 0) {
      return { sampleCount: 0 };
    }

    const totalSamples = modelMatches.reduce((s, o) => s + Math.max(0, o.sampleCount), 0);
    const totalSuccess = modelMatches.reduce((s, o) => s + Math.max(0, o.successCount), 0);

    // STRICT RULE: Only use historical reliability when sampleCount >= 3!
    if (totalSamples < 3) {
      return { sampleCount: totalSamples };
    }

    const latSamples = modelMatches
      .filter((o) => o.avgLatencyMs !== undefined && o.sampleCount > 0);
    const avgLatencyMs =
      latSamples.length > 0
        ? latSamples.reduce((s, o) => s + o.avgLatencyMs! * o.sampleCount, 0) /
          latSamples.reduce((s, o) => s + o.sampleCount, 0)
        : undefined;

    const tpsSamples = modelMatches
      .filter((o) => o.avgTokensPerSecond !== undefined && o.sampleCount > 0);
    const avgTokensPerSecond =
      tpsSamples.length > 0
        ? tpsSamples.reduce((s, o) => s + o.avgTokensPerSecond! * o.sampleCount, 0) /
          tpsSamples.reduce((s, o) => s + o.sampleCount, 0)
        : undefined;

    const toolSamples = modelMatches
      .filter((o) => o.toolCallSuccessRate !== undefined && o.sampleCount > 0);
    const toolCallSuccessRate =
      toolSamples.length > 0
        ? toolSamples.reduce((s, o) => s + o.toolCallSuccessRate! * o.sampleCount, 0) /
          toolSamples.reduce((s, o) => s + o.sampleCount, 0)
        : undefined;

    return {
      sampleCount: totalSamples,
      empiricalSuccessRate: clamp01(totalSuccess / totalSamples),
      avgLatencyMs,
      avgTokensPerSecond,
      toolCallSuccessRate,
    };
  }

  public scheduleTask(
    task: ClassifiedTaskProfile,
    plan: DeclarativeExecutionPlan,
    graph: CapabilityGraph,
    context: ScheduleContextOptions = {},
  ): TaskRoutingDecision {
    const validatedPlan = validateExecutionPlan(plan);
    const strategy = context.strategyOverride ?? validatedPlan.spec.routing.strategy;
    const weights = STRATEGY_WEIGHTS[strategy];
    const maxStaleMs = context.maxStaleMs ?? this.defaultMaxStaleMs;
    const nowMs = context.nowIso
      ? Date.parse(context.nowIso)
      : Date.parse(graph.generatedAt) || Date.now();

    const combinedConstraintStrings = [
      ...(validatedPlan.spec.routing.constraints ?? []),
      ...(context.additionalConstraints ?? []),
    ];
    const hardConstraints = parseHardUserConstraints(combinedConstraintStrings);

    const effectiveBudgetCap = [
      validatedPlan.spec.execution.budget_usd,
      hardConstraints.maxBudgetUsd,
      context.maxBudgetUsd,
    ]
      .filter((v): v is number => v !== undefined && Number.isFinite(v))
      .reduce<number | undefined>((min, v) => (min === undefined ? v : Math.min(min, v)), undefined);

    const currentSpendUsd = context.currentCloudSpendUsd ?? 0;
    const runningByPool = context.activeRunningByPool ?? {};
    const assignedSoFarByPool = context.assignedSoFarByPool ?? {};
    const totalAssignedSoFar = Object.values(assignedSoFarByPool).reduce((s, v) => s + v, 0);

    const scoredCandidates: ScoredRouteCandidate[] = [];
    const rejectedCandidates: RejectedRouteCandidate[] = [];

    // Canonical pool ordering for complete determinism
    const sortedPools = [...validatedPlan.spec.pools].sort((a, b) => a.id.localeCompare(b.id));

    for (const pool of sortedPools) {
      const isClaude =
        pool.id.toLowerCase() === 'claude' || pool.provider?.toLowerCase() === 'claude';

      // Hard Gate 1: Disabled pool / Zero Claude rule
      if (!pool.enabled || pool.share <= 0) {
        rejectedCandidates.push({
          poolId: pool.id,
          targetId: pool.host ?? pool.provider ?? pool.id,
          runtimeId: pool.preferred_runtime ?? 'disabled',
          modelId: pool.preferred_model ?? 'disabled',
          rejectionCodes: isClaude
            ? ['POOL_DISABLED', 'DISABLED_BY_POLICY_CLAUDE_ZERO']
            : ['POOL_DISABLED'],
          reason: `Pool '${pool.id}' is disabled in ExecutionPlan (0% share)`,
        });
        continue;
      }

      if (
        isClaude &&
        (hardConstraints.disabledProviders.includes('claude') ||
          validatedPlan.spec.routing.preserve_disabled_pools) &&
        !pool.enabled
      ) {
        rejectedCandidates.push({
          poolId: pool.id,
          targetId: 'claude',
          runtimeId: 'claude',
          modelId: 'claude',
          rejectionCodes: ['DISABLED_BY_POLICY_CLAUDE_ZERO'],
          reason: 'Claude is strictly disabled by policy',
        });
        continue;
      }

      // Check pinned pool shares if set to 0% in hard constraints
      if (
        Object.prototype.hasOwnProperty.call(hardConstraints.pinnedPoolShares, pool.id) &&
        hardConstraints.pinnedPoolShares[pool.id] <= 0
      ) {
        rejectedCandidates.push({
          poolId: pool.id,
          targetId: pool.host ?? pool.provider ?? pool.id,
          runtimeId: pool.preferred_runtime ?? 'none',
          modelId: pool.preferred_model ?? 'none',
          rejectionCodes: ['PINNED_SHARE_ZERO'],
          reason: `Pool '${pool.id}' pinned to 0% by hard user constraint`,
        });
        continue;
      }

      if (pool.provider && !pool.host) {
        this.evaluateCloudProviderCandidates({
          pool,
          task,
          validatedPlan,
          graph,
          hardConstraints,
          strategy,
          weights,
          nowMs,
          maxStaleMs,
          effectiveBudgetCap,
          currentSpendUsd,
          runningByPool,
          assignedSoFarByPool,
          totalAssignedSoFar,
          deadlineMs: context.deadlineMs,
          scoredCandidates,
          rejectedCandidates,
        });
      } else {
        this.evaluateLocalHostCandidates({
          pool,
          task,
          validatedPlan,
          graph,
          hardConstraints,
          strategy,
          weights,
          nowMs,
          maxStaleMs,
          runningByPool,
          assignedSoFarByPool,
          totalAssignedSoFar,
          deadlineMs: context.deadlineMs,
          scoredCandidates,
          rejectedCandidates,
        });
      }
    }

    // Deterministic sorting: descending totalScore (snapped to 1e-9), then lexicographical tie-breakers
    scoredCandidates.sort((a, b) => {
      const scoreDiff = b.totalScore - a.totalScore;
      if (Math.abs(scoreDiff) > 1e-9) {
        return scoreDiff > 0 ? 1 : -1;
      }
      const poolCmp = a.poolId.localeCompare(b.poolId);
      if (poolCmp !== 0) return poolCmp;
      const targetA = a.hostId ?? a.providerId ?? '';
      const targetB = b.hostId ?? b.providerId ?? '';
      const targetCmp = targetA.localeCompare(targetB);
      if (targetCmp !== 0) return targetCmp;
      const rtCmp = a.runtimeId.localeCompare(b.runtimeId);
      if (rtCmp !== 0) return rtCmp;
      const modelCmp = a.modelId.localeCompare(b.modelId);
      if (modelCmp !== 0) return modelCmp;
      return a.endpointUrl.localeCompare(b.endpointUrl);
    });

    if (scoredCandidates.length === 0) {
      const summaryReasons = rejectedCandidates
        .map((r) => `${r.poolId}[${r.rejectionCodes.join(',')}]`)
        .join('; ');
      return {
        taskId: task.taskId,
        scheduled: false,
        rankedAlternatives: [],
        rejectedCandidates,
        strategyUsed: strategy,
        needsPilotProbe: false,
        unscheduledReason: `No admissible candidate route for task '${task.taskId}': ${summaryReasons}`,
      };
    }

    const selected = scoredCandidates[0];
    return {
      taskId: task.taskId,
      scheduled: true,
      selectedRoute: selected,
      rankedAlternatives: scoredCandidates.slice(1),
      rejectedCandidates,
      strategyUsed: strategy,
      needsPilotProbe: selected.needsPilotProbe,
    };
  }

  public scheduleBatch(
    tasks: ClassifiedTaskProfile[],
    plan: DeclarativeExecutionPlan,
    graph: CapabilityGraph,
    context: ScheduleContextOptions = {},
  ): ScheduleBatchResult {
    const startPerf = performance.now();
    const validatedPlan = validateExecutionPlan(plan);

    // Deterministic topological + priority + taskId ordering
    const orderedTasks = this.orderTasksDeterministically(tasks);

    const assignedCountByPool: Record<string, number> = {};
    for (const p of validatedPlan.spec.pools) {
      assignedCountByPool[p.id] = context.assignedSoFarByPool?.[p.id] ?? 0;
    }
    const simulatedRunningByPool: Record<string, number> = {
      ...(context.activeRunningByPool ?? {}),
    };

    let cumulativeCloudCostUsd = context.currentCloudSpendUsd ?? 0;
    const decisions: TaskRoutingDecision[] = [];
    const byTaskId: Record<string, TaskRoutingDecision> = {};
    const unscheduledTaskIds: string[] = [];
    const pilotProbeTaskIds: string[] = [];

    for (const task of orderedTasks) {
      const decision = this.scheduleTask(task, validatedPlan, graph, {
        ...context,
        currentCloudSpendUsd: cumulativeCloudCostUsd,
        activeRunningByPool: simulatedRunningByPool,
        assignedSoFarByPool: assignedCountByPool,
      });

      decisions.push(decision);
      byTaskId[task.taskId] = decision;

      if (decision.scheduled && decision.selectedRoute) {
        const route = decision.selectedRoute;
        assignedCountByPool[route.poolId] = (assignedCountByPool[route.poolId] ?? 0) + 1;
        const curRun = simulatedRunningByPool[route.poolId] ?? 0;
        if (curRun < route.effectiveConcurrentLimit) {
          simulatedRunningByPool[route.poolId] = curRun + 1;
        }
        cumulativeCloudCostUsd += route.estimatedCostUsd;
        if (decision.needsPilotProbe) {
          pilotProbeTaskIds.push(task.taskId);
        }
      } else {
        unscheduledTaskIds.push(task.taskId);
      }
    }

    const batchCloudCostUsd = roundDeterministic(
      decisions.reduce((sum, d) => sum + (d.selectedRoute?.estimatedCostUsd ?? 0), 0),
    );

    const localHardwareUtilizationPct: Record<string, number> = {};
    const sortedHostIds = Object.keys(graph.hosts).sort();
    for (const hostKey of sortedHostIds) {
      const host = graph.hosts[hostKey];
      const matchingPools = validatedPlan.spec.pools.filter(
        (p) => p.enabled && p.host && findHostInCapabilityGraph(graph, p.host)?.hostId === host.hostId,
      );
      const totalHostSlots = matchingPools.reduce((s, p) => s + p.max_concurrent, 0);
      const usedHostSlots = matchingPools.reduce(
        (s, p) => s + Math.min(p.max_concurrent, simulatedRunningByPool[p.id] ?? 0),
        0,
      );
      localHardwareUtilizationPct[host.hostId] =
        totalHostSlots > 0 ? roundDeterministic(Math.min(100, (usedHostSlots / totalHostSlots) * 100)) : 0;
    }

    const operationalOverheadMs = Math.max(0, roundDeterministic(performance.now() - startPerf));

    return {
      decisions,
      byTaskId,
      assignedCountByPool,
      unscheduledTaskIds,
      pilotProbeTaskIds,
      cloudProviderCostUsd: batchCloudCostUsd,
      localHardwareUtilizationPct,
      operationalOverheadMs,
    };
  }

  private orderTasksDeterministically(tasks: ClassifiedTaskProfile[]): ClassifiedTaskProfile[] {
    const byId = new Map<string, ClassifiedTaskProfile>();
    for (const t of tasks) {
      byId.set(t.taskId, t);
    }

    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const t of tasks) {
      let deg = 0;
      for (const dep of t.dependsOn) {
        if (byId.has(dep)) {
          deg++;
          const list = dependents.get(dep) ?? [];
          list.push(t.taskId);
          dependents.set(dep, list);
        }
      }
      inDegree.set(t.taskId, deg);
    }

    const ready = tasks
      .filter((t) => (inDegree.get(t.taskId) ?? 0) === 0)
      .sort((a, b) => (b.priority !== a.priority ? b.priority - a.priority : a.taskId.localeCompare(b.taskId)));

    const result: ClassifiedTaskProfile[] = [];
    const visited = new Set<string>();

    while (ready.length > 0) {
      const next = ready.shift()!;
      if (visited.has(next.taskId)) continue;
      visited.add(next.taskId);
      result.push(next);

      for (const childId of dependents.get(next.taskId) ?? []) {
        const rem = (inDegree.get(childId) ?? 1) - 1;
        inDegree.set(childId, rem);
        if (rem === 0) {
          const childTask = byId.get(childId)!;
          ready.push(childTask);
          ready.sort((a, b) =>
            b.priority !== a.priority ? b.priority - a.priority : a.taskId.localeCompare(b.taskId),
          );
        }
      }
    }

    // Append any remaining tasks (in case of external/cyclic refs) in deterministic order
    if (result.length < tasks.length) {
      const remaining = tasks
        .filter((t) => !visited.has(t.taskId))
        .sort((a, b) =>
          b.priority !== a.priority ? b.priority - a.priority : a.taskId.localeCompare(b.taskId),
        );
      result.push(...remaining);
    }

    return result;
  }

  private evaluateLocalHostCandidates(params: {
    pool: ExecutionPlanPoolSpec;
    task: ClassifiedTaskProfile;
    validatedPlan: DeclarativeExecutionPlan;
    graph: CapabilityGraph;
    hardConstraints: HardUserConstraints;
    strategy: RoutingStrategyName;
    weights: StrategyWeightVector;
    nowMs: number;
    maxStaleMs: number;
    runningByPool: Record<string, number>;
    assignedSoFarByPool: Record<string, number>;
    totalAssignedSoFar: number;
    deadlineMs?: number;
    scoredCandidates: ScoredRouteCandidate[];
    rejectedCandidates: RejectedRouteCandidate[];
  }): void {
    const {
      pool,
      task,
      validatedPlan,
      graph,
      hardConstraints,
      strategy,
      weights,
      nowMs,
      maxStaleMs,
      runningByPool,
      assignedSoFarByPool,
      totalAssignedSoFar,
      deadlineMs,
      scoredCandidates,
      rejectedCandidates,
    } = params;

    const hostKey = pool.host ?? pool.id;
    const hostNode: PhysicalHostNode | undefined = findHostInCapabilityGraph(graph, hostKey);

    if (!hostNode) {
      rejectedCandidates.push({
        poolId: pool.id,
        targetId: hostKey,
        runtimeId: pool.preferred_runtime ?? 'unknown',
        modelId: pool.preferred_model ?? 'unknown',
        rejectionCodes: ['HOST_NOT_DISCOVERED'],
        reason: `Local host '${hostKey}' is absent from CapabilityGraph`,
      });
      return;
    }

    // Stale host inventory check (Acceptance Test 13)
    const discoveredMs = Date.parse(hostNode.lastDiscoveredAt);
    if (!Number.isFinite(discoveredMs) || nowMs - discoveredMs > maxStaleMs) {
      rejectedCandidates.push({
        poolId: pool.id,
        targetId: hostNode.hostId,
        runtimeId: pool.preferred_runtime ?? 'unknown',
        modelId: pool.preferred_model ?? 'unknown',
        rejectionCodes: ['STALE_INVENTORY'],
        reason: `Host '${hostNode.hostId}' lastDiscoveredAt (${hostNode.lastDiscoveredAt}) is older than maxStaleMs (${maxStaleMs}ms)`,
      });
      return;
    }

    // OS admissibility check
    if (task.requiredOs && hostNode.os.platform !== task.requiredOs) {
      rejectedCandidates.push({
        poolId: pool.id,
        targetId: hostNode.hostId,
        runtimeId: pool.preferred_runtime ?? 'unknown',
        modelId: pool.preferred_model ?? 'unknown',
        rejectionCodes: ['OS_MISMATCH'],
        reason: `Task requires OS '${task.requiredOs}', but host '${hostNode.hostId}' runs '${hostNode.os.platform}'`,
      });
      return;
    }

    // NVIDIA CUDA check
    if (task.requiresNvidiaCuda) {
      const hasNvidiaGpu = hostNode.gpus.some(
        (g) => g.vendor === 'nvidia' && (Boolean(g.cudaVersion) || hostNode.os.platform === 'linux'),
      );
      if (!hasNvidiaGpu) {
        rejectedCandidates.push({
          poolId: pool.id,
          targetId: hostNode.hostId,
          runtimeId: pool.preferred_runtime ?? 'unknown',
          modelId: pool.preferred_model ?? 'unknown',
          rejectionCodes: ['MISSING_NVIDIA_CUDA'],
          reason: `Task requires NVIDIA CUDA GPU, which host '${hostNode.hostId}' lacks`,
        });
        return;
      }
    }

    // Browser E2E worker check
    if (task.requiresBrowser) {
      const hasBrowserWorker = Object.values(graph.workers).some(
        (w) => w.hostId === hostNode.hostId && w.status === 'online' && w.browserCapable,
      );
      if (!hasBrowserWorker) {
        rejectedCandidates.push({
          poolId: pool.id,
          targetId: hostNode.hostId,
          runtimeId: pool.preferred_runtime ?? 'unknown',
          modelId: pool.preferred_model ?? 'unknown',
          rejectionCodes: ['MISSING_BROWSER_CAPABILITY'],
          reason: `Task requires browser automation, and host '${hostNode.hostId}' has no online browser-capable worker`,
        });
        return;
      }
    }

    // Protected workload conflict gate (e.g. "Do not interrupt Isaac Sim")
    const matchingProtectedConflict = hostNode.workloadConflicts.find((c) => {
      const normProc = normalizeWorkloadName(c.processName);
      const explicitlyProtected = hardConstraints.protectedWorkloads.some(
        (pw) => normProc.includes(pw) || pw.includes(normProc),
      );
      return explicitlyProtected || c.doNotInterrupt;
    });

    const conflictRamGB = hostNode.workloadConflicts.reduce((s, c) => s + c.reservedRamGB, 0);
    const conflictVramGB = hostNode.workloadConflicts.reduce((s, c) => s + c.reservedVramGB, 0);
    const effectiveAvailableRamGB = Math.max(
      0,
      hostNode.memory.availableGB -
        hostNode.resourceReservationsGB.ramGB -
        conflictRamGB -
        (hostNode.memory.unifiedMemory ? conflictVramGB : 0),
    );

    if (matchingProtectedConflict) {
      const normProc = normalizeWorkloadName(matchingProtectedConflict.processName);
      const namedInConstraint = hardConstraints.protectedWorkloads.some(
        (pw) => normProc.includes(pw) || pw.includes(normProc),
      );
      const highGpuPressure = hostNode.gpus.some((g) => (g.utilizationPercent ?? 0) >= 85);
      if (
        (namedInConstraint && (highGpuPressure || hostNode.memory.pressureLevel === 'critical' || effectiveAvailableRamGB < task.minimumMemoryGB)) ||
        hostNode.memory.pressureLevel === 'critical'
      ) {
        rejectedCandidates.push({
          poolId: pool.id,
          targetId: hostNode.hostId,
          runtimeId: pool.preferred_runtime ?? 'unknown',
          modelId: pool.preferred_model ?? 'unknown',
          rejectionCodes: ['PROTECTED_WORKLOAD_CONFLICT'],
          reason: `Protected workload '${matchingProtectedConflict.processName}' is active on '${hostNode.hostId}'`,
        });
        return;
      }
    }

    const hostEndpoints: InferenceEndpointNode[] = Object.values(graph.endpoints)
      .filter((ep) => ep.hostId === hostNode.hostId || ep.machineId === hostNode.machineId)
      .sort((a, b) => a.endpointId.localeCompare(b.endpointId));

    if (hostEndpoints.length === 0) {
      rejectedCandidates.push({
        poolId: pool.id,
        targetId: hostNode.hostId,
        runtimeId: pool.preferred_runtime ?? 'none',
        modelId: pool.preferred_model ?? 'none',
        rejectionCodes: ['NO_ENDPOINT_DISCOVERED'],
        reason: `No inference endpoints discovered on host '${hostNode.hostId}'`,
      });
      return;
    }

    for (const endpoint of hostEndpoints) {
      // Stale endpoint verification check (Acceptance Test 13)
      if (endpoint.lastVerifiedAt !== undefined) {
        const verifiedMs = Date.parse(endpoint.lastVerifiedAt);
        if (!Number.isFinite(verifiedMs) || nowMs - verifiedMs > maxStaleMs) {
          rejectedCandidates.push({
            poolId: pool.id,
            targetId: hostNode.hostId,
            runtimeId: endpoint.runtimeId,
            modelId: pool.preferred_model ?? 'unknown',
            rejectionCodes: ['STALE_INVENTORY'],
            reason: `Endpoint '${endpoint.endpointId}' lastVerifiedAt (${endpoint.lastVerifiedAt}) exceeded maxStaleMs (${maxStaleMs}ms)`,
          });
          continue;
        }
      }

      const resolution = resolveEndpointForCaller(
        graph,
        endpoint,
        validatedPlan.spec.discovery.authorized_hosts_only,
      );
      if (!resolution.usable || !resolution.resolvedUrl) {
        rejectedCandidates.push({
          poolId: pool.id,
          targetId: hostNode.hostId,
          runtimeId: endpoint.runtimeId,
          modelId: pool.preferred_model ?? 'unknown',
          rejectionCodes: ['ENDPOINT_UNREACHABLE'],
          reason: resolution.reason,
        });
        continue;
      }

      if (
        !isAcceptableForScheduling(
          endpoint.acceptanceState,
          validatedPlan.spec.routing.verify_execution_capability,
        )
      ) {
        rejectedCandidates.push({
          poolId: pool.id,
          targetId: hostNode.hostId,
          runtimeId: endpoint.runtimeId,
          modelId: pool.preferred_model ?? 'unknown',
          rejectionCodes: ['ACCEPTANCE_STATE_NOT_VERIFIED'],
          reason: `Endpoint '${endpoint.endpointId}' state is '${endpoint.acceptanceState}'`,
        });
        continue;
      }

      const runtimeModels: LoadedModelNode[] = Object.values(graph.models)
        .filter((m) => m.hostId === hostNode.hostId && m.runtimeId === endpoint.runtimeId)
        .sort((a, b) => a.modelId.localeCompare(b.modelId));

      if (runtimeModels.length === 0) {
        rejectedCandidates.push({
          poolId: pool.id,
          targetId: hostNode.hostId,
          runtimeId: endpoint.runtimeId,
          modelId: pool.preferred_model ?? 'none',
          rejectionCodes: ['NO_MODELS_ON_RUNTIME'],
          reason: `No discovered models on runtime '${endpoint.runtimeId}'`,
        });
        continue;
      }

      for (const model of runtimeModels) {
        const rejectionCodes: string[] = [];

        // Context window check
        const effectiveCtx = model.loadedContextTokens ?? model.maxContextTokens;
        if (effectiveCtx < task.requiredContextTokens) {
          rejectionCodes.push('INSUFFICIENT_CONTEXT_WINDOW');
        }

        // Tool calling check
        const requiresToolCall =
          task.requiredCapabilities.includes('tool_calling') ||
          (validatedPlan.spec.routing.verify_execution_capability &&
            task.requiredTools.includes('shell') &&
            task.taskType !== 'formatting' &&
            !model.toolCallingSupported);

        if (task.requiredCapabilities.includes('tool_calling') && !model.toolCallingSupported) {
          rejectionCodes.push('TOOL_CALLING_UNSUPPORTED');
        } else if (requiresToolCall && !model.toolCallingSupported) {
          rejectionCodes.push('TOOL_CALLING_UNSUPPORTED');
        }

        // Resource admission check
        const coldLoadGB =
          model.residency === 'loaded'
            ? model.kvCachePerSlotGB
            : model.estimatedWeightsGB + model.runtimeOverheadGB + model.kvCachePerSlotGB;

        if (
          validatedPlan.spec.routing.require_resource_admission &&
          model.residency !== 'loaded' &&
          effectiveAvailableRamGB < coldLoadGB
        ) {
          rejectionCodes.push('INSUFFICIENT_MEMORY_FOR_MODEL_ADMISSION');
        }

        const qual = this.qualifications.find(
          (q) => q.runtimeId === endpoint.runtimeId && q.modelId === model.modelId,
        );
        const effectiveConc = Math.min(
          pool.max_concurrent,
          qual?.verifiedSafeConcurrency ?? pool.max_concurrent,
        );
        const currentRun = runningByPool[pool.id] ?? 0;

        if (effectiveConc <= 0) {
          rejectionCodes.push('ZERO_VERIFIED_CAPACITY');
        } else if (currentRun >= effectiveConc && !validatedPlan.spec.execution.queue_when_saturated) {
          rejectionCodes.push('POOL_SATURATED_NO_QUEUE');
        }

        if (rejectionCodes.length > 0) {
          rejectedCandidates.push({
            poolId: pool.id,
            targetId: hostNode.hostId,
            runtimeId: endpoint.runtimeId,
            modelId: model.modelId,
            rejectionCodes,
            reason: `Model '${model.modelId}' on '${hostNode.hostId}' failed gates: ${rejectionCodes.join(', ')}`,
          });
          continue;
        }

        // Compute multi-factor scores (NEVER using parameterBillions for capability!)
        const hist = this.lookupHistoricalStats(pool.id, endpoint.runtimeId, model.modelId, task.taskType);
        const needsPilotProbe = hist.sampleCount < 3;
        const historicalReliabilityScore =
          hist.empiricalSuccessRate !== undefined ? hist.empiricalSuccessRate : 0.5;

        const capScore = this.computeLocalCapabilityScore(pool, model, task, hardConstraints);
        const expectedSuccessProbability = clamp01(
          hist.empiricalSuccessRate !== undefined
            ? 0.55 * hist.empiricalSuccessRate + 0.45 * capScore
            : 0.72 * capScore + (model.toolCallingVerified ? 0.14 : 0.05) + (model.residency === 'loaded' ? 0.08 : 0.0),
        );

        const measuredLatMs =
          hist.avgLatencyMs ??
          model.measuredEndToEndLatencyMs ??
          qual?.endToEndLatencyMsP50 ??
          (model.measuredTokensPerSecond && model.measuredTokensPerSecond > 0
            ? (500 / model.measuredTokensPerSecond) * 1000 + (model.measuredFirstTokenLatencyMs ?? 150)
            : model.residency === 'loaded'
              ? 1_800
              : 6_500);

        const queuePenaltyMs =
          currentRun >= effectiveConc
            ? ((currentRun - effectiveConc + 1) / Math.max(1, effectiveConc)) * measuredLatMs
            : 0;
        const estimatedLatencyMs = Math.round(measuredLatMs + queuePenaltyMs);
        const latencyScore = clamp01(1 / (1 + estimatedLatencyMs / 4_000));

        const memRatio = hostNode.memory.totalGB > 0 ? effectiveAvailableRamGB / hostNode.memory.totalGB : 0.5;
        const pressureFactor =
          hostNode.memory.pressureLevel === 'normal'
            ? 1.0
            : hostNode.memory.pressureLevel === 'warn'
              ? 0.65
              : hostNode.memory.pressureLevel === 'critical'
                ? 0.2
                : 0.8;
        const thermalFactor =
          !hostNode.thermalState || hostNode.thermalState === 'nominal'
            ? 1.0
            : hostNode.thermalState === 'fair'
              ? 0.85
              : 0.5;
        const localResourceScore = clamp01((0.5 + 0.5 * clamp01(memRatio * 2)) * pressureFactor * thermalFactor);

        // Local sovereign hardware monetary API cost is strictly $0.00!
        const costScore = 1.0;

        const slotLoadRatio = effectiveConc > 0 ? currentRun / effectiveConc : 1;
        const gpuUtil =
          hostNode.gpus.length > 0
            ? Math.max(...hostNode.gpus.map((g) => (g.utilizationPercent ?? 0) / 100))
            : hostNode.cpu.utilizationPercent / 100;
        const conflictPenalty = hostNode.workloadConflicts.length > 0 ? 0.18 : 0;
        const contentionScore = clamp01(
          1 - 0.55 * Math.min(1.2, slotLoadRatio) - 0.27 * clamp01(gpuUtil) - conflictPenalty,
        );

        const dataLocalitySecurityScore =
          resolution.routeVia === 'local_loopback'
            ? 1.0
            : resolution.routeVia === 'ssh_tunnel' || resolution.routeVia === 'remote_worker'
              ? 0.96
              : 0.92;

        const urgentFactor = clamp01(task.priority / 10);
        const deadlineTightness =
          deadlineMs !== undefined && deadlineMs > 0
            ? clamp01(1 - estimatedLatencyMs / deadlineMs)
            : latencyScore;
        const priorityDeadlineScore = clamp01(0.5 * deadlineTightness + 0.5 * (1 - Math.min(1, slotLoadRatio)) * urgentFactor + 0.25 * (1 - urgentFactor));

        const shareBalanceBonus = this.computeShareDeficitScore(
          pool,
          hardConstraints,
          assignedSoFarByPool,
          totalAssignedSoFar,
        );

        const rawComposite =
          weights.success * expectedSuccessProbability +
          weights.capability * capScore +
          weights.latency * latencyScore +
          weights.localResource * localResourceScore +
          weights.cost * costScore +
          weights.contention * contentionScore +
          weights.historical * historicalReliabilityScore +
          weights.locality * dataLocalitySecurityScore +
          weights.priorityDeadline * priorityDeadlineScore +
          weights.shareBalance * shareBalanceBonus +
          (strategy === 'local_first' ? 0.12 : 0);

        const totalScore = roundDeterministic(rawComposite);

        scoredCandidates.push({
          poolId: pool.id,
          targetKind: 'local_host',
          hostId: hostNode.hostId,
          runtimeId: endpoint.runtimeId,
          modelId: model.modelId,
          endpointUrl: resolution.resolvedUrl,
          routeVia: resolution.routeVia,
          acceptanceState: endpoint.acceptanceState,
          totalScore,
          breakdown: {
            expectedSuccessProbability: roundDeterministic(expectedSuccessProbability),
            verifiedCapabilityScore: roundDeterministic(capScore),
            latencyScore: roundDeterministic(latencyScore),
            localResourceScore: roundDeterministic(localResourceScore),
            costScore,
            contentionScore: roundDeterministic(contentionScore),
            historicalReliabilityScore: roundDeterministic(historicalReliabilityScore),
            dataLocalitySecurityScore: roundDeterministic(dataLocalitySecurityScore),
            priorityDeadlineScore: roundDeterministic(priorityDeadlineScore),
            shareBalanceBonus: roundDeterministic(shareBalanceBonus),
          },
          estimatedCostUsd: 0,
          estimatedLatencyMs,
          historicalSampleCount: hist.sampleCount,
          historicalReliabilityUsed: !needsPilotProbe,
          needsPilotProbe,
          effectiveConcurrentLimit: effectiveConc,
          currentRunningInPool: currentRun,
          willQueue: currentRun >= effectiveConc,
        });
      }
    }
  }

  private evaluateCloudProviderCandidates(params: {
    pool: ExecutionPlanPoolSpec;
    task: ClassifiedTaskProfile;
    validatedPlan: DeclarativeExecutionPlan;
    graph: CapabilityGraph;
    hardConstraints: HardUserConstraints;
    strategy: RoutingStrategyName;
    weights: StrategyWeightVector;
    nowMs: number;
    maxStaleMs: number;
    effectiveBudgetCap?: number;
    currentSpendUsd: number;
    runningByPool: Record<string, number>;
    assignedSoFarByPool: Record<string, number>;
    totalAssignedSoFar: number;
    deadlineMs?: number;
    scoredCandidates: ScoredRouteCandidate[];
    rejectedCandidates: RejectedRouteCandidate[];
  }): void {
    const {
      pool,
      task,
      validatedPlan,
      graph,
      hardConstraints,
      weights,
      nowMs,
      maxStaleMs,
      effectiveBudgetCap,
      currentSpendUsd,
      runningByPool,
      assignedSoFarByPool,
      totalAssignedSoFar,
      deadlineMs,
      scoredCandidates,
      rejectedCandidates,
    } = params;

    const providerKey = pool.provider!;
    const providerNode: CodingAgentProviderNode | undefined =
      graph.cloudProviders[providerKey] ??
      Object.values(graph.cloudProviders).find(
        (p) => p.providerId.toLowerCase() === providerKey.toLowerCase(),
      );

    if (!providerNode) {
      rejectedCandidates.push({
        poolId: pool.id,
        targetId: providerKey,
        runtimeId: providerKey,
        modelId: pool.preferred_model ?? providerKey,
        rejectionCodes: ['PROVIDER_NOT_DISCOVERED'],
        reason: `Cloud provider '${providerKey}' not present in CapabilityGraph`,
      });
      return;
    }

    const rejectionCodes: string[] = [];
    const providerLower = providerNode.providerId.toLowerCase();

    if (!providerNode.enabled || providerNode.disabledByPolicy || providerLower === 'claude' && !pool.enabled) {
      rejectionCodes.push(
        providerLower === 'claude' ? 'DISABLED_BY_POLICY_CLAUDE_ZERO' : 'PROVIDER_DISABLED_BY_POLICY',
      );
    }

    if (hardConstraints.disabledProviders.includes(providerLower)) {
      rejectionCodes.push('DISABLED_PROVIDER_CONSTRAINT');
    }

    if (hardConstraints.localMachinesOnly || validatedPlan.spec.routing.fallback_policy === 'local_only') {
      rejectionCodes.push('LOCAL_MACHINES_ONLY_CONSTRAINT');
    }

    if (task.dataSensitivity === 'restricted_local_only') {
      rejectionCodes.push('RESTRICTED_LOCAL_ONLY_DATA');
    }

    if (hardConstraints.neverSendRepoToCloud && task.requiresRepoAccess) {
      rejectionCodes.push('NEVER_SEND_REPO_TO_CLOUD');
    }

    if (
      task.requiresRepoAccess &&
      task.dataSensitivity !== 'public' &&
      !providerNode.dataHandling.allowsConfidentialRepo
    ) {
      rejectionCodes.push('PROVIDER_DISALLOWS_CONFIDENTIAL_REPO');
    }

    if (task.requiresNvidiaCuda) {
      rejectionCodes.push('MISSING_NVIDIA_CUDA');
    }

    if (task.requiredOs === 'darwin' || task.requiredOs === 'win32') {
      rejectionCodes.push('OS_MISMATCH');
    }

    if (
      task.requiresBrowser &&
      !providerNode.taskCapabilities.includes('browser') &&
      !providerNode.taskCapabilities.includes('browser_e2e')
    ) {
      rejectionCodes.push('MISSING_BROWSER_CAPABILITY');
    }

    if (task.requiredCapabilities.includes('tool_calling') && !providerNode.toolSupport) {
      rejectionCodes.push('TOOL_CALLING_UNSUPPORTED');
    }

    if (
      providerNode.authStatus !== 'authenticated' &&
      providerNode.authStatus !== 'cli_available'
    ) {
      rejectionCodes.push('PROVIDER_UNAUTHENTICATED');
    }

    if (providerNode.lastAcceptedRequestAt !== undefined) {
      const acceptedMs = Date.parse(providerNode.lastAcceptedRequestAt);
      if (!Number.isFinite(acceptedMs) || nowMs - acceptedMs > maxStaleMs) {
        rejectionCodes.push('STALE_INVENTORY');
      }
    }

    if (
      !isAcceptableForScheduling(
        providerNode.acceptanceState,
        validatedPlan.spec.routing.verify_execution_capability,
      )
    ) {
      rejectionCodes.push('ACCEPTANCE_STATE_NOT_VERIFIED');
    }

    if (
      providerNode.exposedQuotas &&
      ((providerNode.exposedQuotas.requestsRemaining !== undefined &&
        providerNode.exposedQuotas.requestsRemaining <= 0) ||
        (providerNode.exposedQuotas.tokensRemaining !== undefined &&
          providerNode.exposedQuotas.tokensRemaining <= 0))
    ) {
      rejectionCodes.push('CLOUD_QUOTA_EXHAUSTED');
    }

    const tokenEst = estimateCloudTokensForTask(task);
    const hasExplicitZeroRate =
      providerNode.estimatedCostPer1kInputUsd === 0 &&
      providerNode.estimatedCostPer1kOutputUsd === 0;
    const estimatedCostUsd = roundDeterministic(
      tokenEst.inputK * (providerNode.estimatedCostPer1kInputUsd ?? 0) +
        tokenEst.outputK * (providerNode.estimatedCostPer1kOutputUsd ?? 0),
    );

    if (!hardConstraints.paidCloudAllowed && (!hasExplicitZeroRate || estimatedCostUsd > 0)) {
      rejectionCodes.push('PAID_CLOUD_DISALLOWED');
    }

    if (task.maxCostUsd !== undefined && estimatedCostUsd > task.maxCostUsd + 1e-9) {
      rejectionCodes.push('TASK_MAX_COST_EXCEEDED');
    }

    if (
      effectiveBudgetCap !== undefined &&
      currentSpendUsd + estimatedCostUsd > effectiveBudgetCap + 1e-9 &&
      estimatedCostUsd > 0
    ) {
      rejectionCodes.push('BUDGET_EXCEEDED');
    }

    const effectiveConc = Math.min(
      pool.max_concurrent,
      providerNode.configuredMaxConcurrent > 0
        ? providerNode.configuredMaxConcurrent
        : pool.max_concurrent,
    );
    const currentRun = runningByPool[pool.id] ?? 0;
    if (effectiveConc <= 0) {
      rejectionCodes.push('ZERO_VERIFIED_CAPACITY');
    } else if (currentRun >= effectiveConc && !validatedPlan.spec.execution.queue_when_saturated) {
      rejectionCodes.push('POOL_SATURATED_NO_QUEUE');
    }

    const candidateModes =
      providerNode.supportedModelsOrModes.length > 0
        ? [...providerNode.supportedModelsOrModes].sort()
        : [pool.preferred_model ?? providerNode.providerId];

    if (rejectionCodes.length > 0) {
      rejectedCandidates.push({
        poolId: pool.id,
        targetId: providerNode.providerId,
        runtimeId: providerNode.providerId,
        modelId: candidateModes[0],
        rejectionCodes,
        reason: `Cloud provider '${providerNode.providerId}' failed gates: ${rejectionCodes.join(', ')}`,
      });
      return;
    }

    // Score best mode for this cloud provider
    const selectedMode = candidateModes[0];
    const hist = this.lookupHistoricalStats(
      pool.id,
      providerNode.providerId,
      selectedMode,
      task.taskType,
    );
    const needsPilotProbe = hist.sampleCount < 3;
    const historicalReliabilityScore =
      hist.empiricalSuccessRate !== undefined ? hist.empiricalSuccessRate : 0.5;

    const capScore = this.computeCloudCapabilityScore(providerNode, selectedMode, task, hardConstraints);
    const expectedSuccessProbability = clamp01(
      hist.empiricalSuccessRate !== undefined
        ? 0.55 * hist.empiricalSuccessRate + 0.45 * capScore
        : 0.78 * capScore + (providerNode.toolSupport ? 0.12 : 0),
    );

    const baseLatMs = hist.avgLatencyMs ?? providerNode.estimatedLatencyMs ?? 3_200;
    const queuePenaltyMs =
      currentRun >= effectiveConc
        ? ((currentRun - effectiveConc + 1) / Math.max(1, effectiveConc)) * baseLatMs
        : 0;
    const estimatedLatencyMs = Math.round(baseLatMs + queuePenaltyMs);
    const latencyScore = clamp01(1 / (1 + estimatedLatencyMs / 4_000));

    // Cloud does not consume local RAM/VRAM, neutral local resource score (local_first still favors local via cost + locality)
    const localResourceScore = 0.65;
    const costScore = estimatedCostUsd === 0 ? 0.85 : clamp01(1 / (1 + estimatedCostUsd * 25));

    const slotLoadRatio = effectiveConc > 0 ? currentRun / effectiveConc : 1;
    const contentionScore = clamp01(1 - 0.65 * Math.min(1.2, slotLoadRatio));

    const dataLocalitySecurityScore = providerNode.dataHandling.zeroDataRetention ? 0.55 : 0.38;

    const urgentFactor = clamp01(task.priority / 10);
    const deadlineTightness =
      deadlineMs !== undefined && deadlineMs > 0
        ? clamp01(1 - estimatedLatencyMs / deadlineMs)
        : latencyScore;
    const priorityDeadlineScore = clamp01(
      0.5 * deadlineTightness + 0.5 * (1 - Math.min(1, slotLoadRatio)) * urgentFactor + 0.25 * (1 - urgentFactor),
    );

    const shareBalanceBonus = this.computeShareDeficitScore(
      pool,
      hardConstraints,
      assignedSoFarByPool,
      totalAssignedSoFar,
    );

    const rawComposite =
      weights.success * expectedSuccessProbability +
      weights.capability * capScore +
      weights.latency * latencyScore +
      weights.localResource * localResourceScore +
      weights.cost * costScore +
      weights.contention * contentionScore +
      weights.historical * historicalReliabilityScore +
      weights.locality * dataLocalitySecurityScore +
      weights.priorityDeadline * priorityDeadlineScore +
      weights.shareBalance * shareBalanceBonus;

    scoredCandidates.push({
      poolId: pool.id,
      targetKind: 'cloud_provider',
      providerId: providerNode.providerId,
      runtimeId: providerNode.providerId,
      modelId: selectedMode,
      endpointUrl: `cloud://${providerNode.providerId}`,
      routeVia: 'cloud_api',
      acceptanceState: providerNode.acceptanceState,
      totalScore: roundDeterministic(rawComposite),
      breakdown: {
        expectedSuccessProbability: roundDeterministic(expectedSuccessProbability),
        verifiedCapabilityScore: roundDeterministic(capScore),
        latencyScore: roundDeterministic(latencyScore),
        localResourceScore: roundDeterministic(localResourceScore),
        costScore: roundDeterministic(costScore),
        contentionScore: roundDeterministic(contentionScore),
        historicalReliabilityScore: roundDeterministic(historicalReliabilityScore),
        dataLocalitySecurityScore: roundDeterministic(dataLocalitySecurityScore),
        priorityDeadlineScore: roundDeterministic(priorityDeadlineScore),
        shareBalanceBonus: roundDeterministic(shareBalanceBonus),
      },
      estimatedCostUsd,
      estimatedLatencyMs,
      historicalSampleCount: hist.sampleCount,
      historicalReliabilityUsed: !needsPilotProbe,
      needsPilotProbe,
      effectiveConcurrentLimit: effectiveConc,
      currentRunningInPool: currentRun,
      willQueue: currentRun >= effectiveConc,
    });
  }

  /**
   * Computes verified model capability strictly from declared/verified task capabilities,
   * tool-calling verification, warm residency, and preferred model family — NEVER from
   * `parameterBillions`.
   */
  private computeLocalCapabilityScore(
    pool: ExecutionPlanPoolSpec,
    model: LoadedModelNode,
    task: ClassifiedTaskProfile,
    hardConstraints: HardUserConstraints,
  ): number {
    const capsLower = new Set(model.capabilities.map((c) => c.toLowerCase()));
    let score = 0.55;

    if (capsLower.has(task.taskType)) {
      score += 0.20;
    } else if (
      (task.taskType === 'coding' || task.taskType === 'testing' || task.taskType === 'formatting') &&
      (capsLower.has('coding') || capsLower.has('code') || model.modelId.toLowerCase().includes('coder'))
    ) {
      score += 0.16;
    }

    const matchedReqCaps = task.requiredCapabilities.filter((rc) => capsLower.has(rc.toLowerCase()));
    if (task.requiredCapabilities.length > 0) {
      score += 0.12 * (matchedReqCaps.length / task.requiredCapabilities.length);
    }

    if (model.toolCallingVerified) {
      score += 0.08;
    } else if (model.toolCallingSupported) {
      score += 0.04;
    }

    if (pool.preferred_model && model.modelId.toLowerCase() === pool.preferred_model.toLowerCase()) {
      score += 0.05;
    }

    if (
      hardConstraints.preferredModelFamily &&
      model.modelId.toLowerCase().includes(hardConstraints.preferredModelFamily.toLowerCase())
    ) {
      score += 0.10;
    }

    if (task.taskType === 'formatting') {
      // Lightweight fast local models are ideal for mechanical formatting tasks
      score += 0.08;
    }

    return clamp01(score);
  }

  private computeCloudCapabilityScore(
    provider: CodingAgentProviderNode,
    selectedMode: string,
    task: ClassifiedTaskProfile,
    hardConstraints: HardUserConstraints,
  ): number {
    const capsLower = new Set(provider.taskCapabilities.map((c) => c.toLowerCase()));
    let score = 0.62;

    if (capsLower.has(task.taskType)) {
      score += 0.22;
    }
    if (task.taskType === 'architecture' && (capsLower.has('architecture') || provider.providerId === 'antigravity')) {
      score += 0.14;
    }
    if ((task.taskType === 'testing' || task.taskType === 'verification') && (capsLower.has('testing') || provider.providerId === 'codex')) {
      score += 0.14;
    }
    if (provider.toolSupport) {
      score += 0.06;
    }
    if (
      hardConstraints.preferredModelFamily &&
      !selectedMode.toLowerCase().includes(hardConstraints.preferredModelFamily.toLowerCase()) &&
      (task.taskType === 'coding' || task.taskType === 'formatting')
    ) {
      // Honor "Use Qwen unless the task requires another model"
      score -= 0.12;
    }

    return clamp01(score);
  }

  private computeShareDeficitScore(
    pool: ExecutionPlanPoolSpec,
    hardConstraints: HardUserConstraints,
    assignedSoFarByPool: Record<string, number>,
    totalAssignedSoFar: number,
  ): number {
    const targetPct =
      Object.prototype.hasOwnProperty.call(hardConstraints.pinnedPoolShares, pool.id)
        ? hardConstraints.pinnedPoolShares[pool.id]
        : pool.share;

    if (targetPct <= 0) return 0;
    const targetFrac = targetPct / 100;
    if (totalAssignedSoFar <= 0) {
      return clamp01(targetFrac);
    }
    const currentCount = assignedSoFarByPool[pool.id] ?? 0;
    const currentFrac = currentCount / totalAssignedSoFar;
    const deficit = targetFrac - currentFrac;
    return clamp01(0.5 + deficit * 1.5);
  }
}
