import { effectiveContextTokens } from '../types/model.js';
import type { Computer } from '../types/computer.js';
import type { ModelInstance, ModelRecord } from '../types/model.js';
import { HOSTED_RUNTIME_TYPES } from '../types/runtime.js';
import type { RoutingMode, Task } from '../types/task.js';
import type {
  ComputerRoutingDecision,
  ModelRoutingDecision,
  RoutingPolicyConfig,
  SchedulerDecision,
} from '../types/scheduler.js';
import { SchedulingError } from '../types/scheduler.js';
import type { AgentRegistry } from './agentRegistry.js';
import type { ComputerRegistry } from './computerRegistry.js';
import type { ModelRegistry } from './modelRegistry.js';
import type { ModelReliabilityTracker } from './modelReliability.js';
import type { PolicyEngine } from './policyEngine.js';
import type { RuntimeRegistry } from './runtimeRegistry.js';
import type { ModelIntelligenceService } from './modelIntelligenceService.js';
import { TaskCapabilityClassifier } from './taskCapabilityClassifier.js';
import { classifyWorkload, type ResourceRouter } from '../resources/router.js';
import type { WorkloadClass } from '../resources/types.js';
import type { ModelCapabilityCategory } from '../types/modelIntelligence.js';
import type {
  EmpiricalRoutingExplanation,
  EvaluatedCandidate,
  ProfileSegmentationKey,
  TaskCapabilityClassification,
} from '../types/modelIntelligence.js';

/** Measured profiles with fewer runs than this don't influence routing. */
const MIN_MEASURED_SAMPLES = 3;
const pct = (rate: number): string => `${Math.round(rate * 100)}%`;

export function normalizePlatform(p: string): string {
  const s = p.toLowerCase().trim();
  if (['darwin', 'macos', 'mac', 'osx'].includes(s)) return 'darwin';
  if (['win32', 'windows', 'win'].includes(s)) return 'win32';
  if (['linux', 'ubuntu', 'debian'].includes(s)) return 'linux';
  return s;
}

export function normalizeArch(a: string): string {
  const s = a.toLowerCase().trim();
  if (['arm64', 'aarch64'].includes(s)) return 'arm64';
  if (['x64', 'x86_64', 'amd64'].includes(s)) return 'x64';
  return s;
}

export interface SchedulerDeps {
  computers: ComputerRegistry;
  runtimes: RuntimeRegistry;
  models: ModelRegistry;
  agents?: AgentRegistry;
  /** Gates hosted-provider placement — see `scheduleComputer()`'s hosted branch. */
  policy: PolicyEngine;
  /**
   * Optional engine-wide routing policy (e.g. `routing.mode = 'provider_only'`, `provider = 'nvidia'`).
   */
  routing?: RoutingPolicyConfig;
  /**
   * Per-(model, task class) circuit breaker. An OPEN circuit removes the model from
   * capability routing for that task class; an explicit pin is still honored (no
   * silent substitution) but the open circuit is stated in the decision reasons.
   */
  reliability?: ModelReliabilityTracker;
  /**
   * Empirical Model Intelligence Service providing fine-grained capability profiles.
   */
  modelIntelligence?: ModelIntelligenceService;
  /**
   * Classifier for decomposing task capability requirements.
   */
  classifier?: TaskCapabilityClassifier;
  /**
   * Resource-aware routing: budget/quota/GPU constraints and cost/latency/capacity scoring
   * (see resources/router.ts). Absent = capability-only routing, as before.
   */
  resources?: { router: ResourceRouter; workloadFor?: (task: Task, category: ModelCapabilityCategory) => WorkloadClass };
}

export interface ScheduleInput {
  task: Task;
  /** Total tokens required (input + output reserve) from the context compiler. */
  requiredContextTokens?: number;
  /**
   * Models capability routing must not choose — e.g. the models a run already
   * tried before a failure-based escalation. Rejected with an explicit reason.
   */
  excludeModelIds?: readonly string[];
}

interface ScoredModel {
  record: ModelRecord;
  score: number;
  reasons: string[];
  rejected: string[];
}

interface ScoredPlacement {
  instance: ModelInstance;
  /** Absent for a hosted placement (no Computer). */
  computer?: Computer;
  score: number;
  reasons: string[];
}

interface ResolvedRoutingConstraint {
  mode: RoutingMode;
  provider?: string;
  defaultModel?: string;
  allowFallback: boolean;
}

/**
 * Deterministic two-phase scheduler.
 *
 * Phase 1 — MODEL ROUTING: "which model is appropriate for this task?"
 * Phase 2 — COMPUTER SCHEDULING: "where should that model run?"
 *
 * Rules enforced here:
 * - explicit model/computer pins are hard requirements (no silent fallback)
 * - provider_only routing fails closed when no eligible model from that provider exists
 * - every decision carries human-readable reasons
 * - ties are broken lexicographically so the same input always yields the same output
 */
export class Scheduler {
  private readonly classifier: TaskCapabilityClassifier;

  constructor(private readonly deps: SchedulerDeps) {
    this.classifier = deps.classifier ?? new TaskCapabilityClassifier();
  }

  public getRoutingPolicy(): RoutingPolicyConfig | undefined {
    return this.deps.routing;
  }

  private resolveRoutingConstraint(task: Task): ResolvedRoutingConstraint {
    const cfg = this.deps.routing;
    let mode: RoutingMode = 'AUTO';
    let provider: string | undefined;

    if (cfg?.mode === 'provider_only') {
      mode = 'PROVIDER_ONLY';
      provider = cfg.provider?.toLowerCase();
    } else if (cfg?.mode === 'local_only') {
      mode = 'LOCAL_ONLY';
    } else if (cfg?.mode === 'hybrid') {
      mode = 'HYBRID';
    }

    const taskMode = task.execution?.routingMode ?? (task.execution?.executionMode === 'local' ? 'LOCAL_ONLY' : undefined);
    if (taskMode) {
      if (taskMode === 'NVIDIA') {
        mode = 'PROVIDER_ONLY';
        provider = 'nvidia';
      } else if (taskMode === 'PROVIDER_ONLY') {
        mode = 'PROVIDER_ONLY';
        provider = (task.execution?.routingProvider ?? cfg?.provider ?? 'nvidia').toLowerCase();
      } else {
        // Note: if engine config enforces provider_only, task cannot weaken it to AUTO/HYBRID
        if (cfg?.mode === 'provider_only' && taskMode !== 'LOCAL_ONLY') {
          mode = 'PROVIDER_ONLY';
          provider = cfg.provider?.toLowerCase() ?? 'nvidia';
        } else {
          mode = taskMode;
        }
      }
    }

    const defaultModel =
      task.execution?.defaultModelId ??
      cfg?.defaultModel ??
      (mode === 'PROVIDER_ONLY' && provider === 'nvidia' ? 'nvidia/nemotron-3.5-super-vl-120b-a12b' : undefined);
    const allowFallback =
      task.execution?.allowFallback ??
      cfg?.allowFallback ??
      (mode === 'PROVIDER_ONLY' ? false : true);

    return { mode, provider, defaultModel, allowFallback };
  }

  private isModelOfProvider(record: ModelRecord, provider: string): boolean {
    const p = provider.toLowerCase();
    if (record.provider?.toLowerCase() === p) return true;
    if (Array.isArray(record.runtimeCompatibility) && record.runtimeCompatibility.some((r) => r.toLowerCase() === p)) {
      return true;
    }
    return false;
  }

  plan(input: ScheduleInput): SchedulerDecision {
    const { task } = input;
    const requiredContext = input.requiredContextTokens ?? task.requirements.minimumContext ?? 0;
    const routing = this.resolveRoutingConstraint(task);

    let agentId: string | undefined;
    let agentReasons: string[] = [];
    if (this.deps.agents) {
      const resolution = this.deps.agents.resolveForTask(task);
      const agentInfo = this.deps.agents.list().find((a) => a.descriptor.name === resolution.agent.descriptor.name);
      if (routing.mode === 'PROVIDER_ONLY' && agentInfo?.source === 'external') {
        throw new SchedulingError(
          `External delegated agent '${resolution.agent.descriptor.name}' is not permitted under provider_only routing (${routing.provider ?? 'nvidia'}). External agents manage their own model selection and cannot bypass provider restrictions.`,
          [`agent '${resolution.agent.descriptor.name}' is external and bypasses provider_only (${routing.provider ?? 'nvidia'}) routing`],
        );
      }
      agentId = resolution.agent.descriptor.name;
      agentReasons = resolution.reasons;
    }

    const modelDecision = this.routeModel(task, requiredContext, input.excludeModelIds ?? [], routing);
    const record = this.deps.models.getRequired(modelDecision.modelId);
    const instance = this.deps.models
      .instancesOf(record.id)
      .find((i) => i.id === modelDecision.modelInstanceId);
    if (!instance) {
      throw new SchedulingError(`Selected model instance '${modelDecision.modelInstanceId}' is no longer registered`);
    }

    const computerDecision = this.scheduleComputer(task, record, requiredContext, routing);
    const placed =
      this.deps.models
        .instancesOf(record.id)
        .find((i) => i.runtimeId === computerDecision.runtimeId && i.computerId === computerDecision.computerId) ??
      instance;
    modelDecision.modelInstanceId = placed.id;
    const resourceType =
      computerDecision.resourceType ??
      (computerDecision.placementKind === 'hosted' ? 'HOSTED_API_INFERENCE' : 'LOCAL_GPU_INFERENCE');

    return {
      agentId,
      modelId: record.id,
      modelInstanceId: placed.id,
      readiness: placed.state === 'READY' ? 'READY_NOW' : 'LOADABLE',
      runtimeId: computerDecision.runtimeId,
      computerId: computerDecision.computerId,
      resourceType,
      modelDecision,
      computerDecision: {
        ...computerDecision,
        resourceType,
      },
      reasons: [
        ...agentReasons,
        `model: ${modelDecision.reasons.join(' | ')}`,
        `computer: ${computerDecision.reasons.join(' | ')}`,
      ],
      decidedAt: new Date(),
    };
  }

  // ==================== PHASE 1: MODEL ROUTING ====================

  private routeModel(
    task: Task,
    requiredContext: number,
    excludeModelIds: readonly string[] = [],
    routing: ResolvedRoutingConstraint = this.resolveRoutingConstraint(task),
  ): ModelRoutingDecision {
    const records = this.deps.models.list();
    if (records.length === 0) {
      throw new SchedulingError('No models are registered', ['model registry is empty']);
    }

    const classification = this.classifier.classify(task);
    const requiredCapability = classification.primaryCategory;

    const scored: ScoredModel[] = records.map((record) => {
      const result = this.scoreModel(task, record, requiredContext, classification, routing);
      if (excludeModelIds.includes(record.id)) result.rejected.push('excluded: already tried by this execution');
      return result;
    });

    if (this.deps.resources) {
      const { router, workloadFor } = this.deps.resources;
      const workload = workloadFor?.(task, requiredCapability) ?? classifyWorkload(task, requiredCapability);
      const capable = scored.filter((s) => s.rejected.length === 0);
      const all = router.assess({
        task, workload, estimatedInputTokens: Math.max(requiredContext, 1),
        candidates: capable.map((s) => {
          const resState = this.residency(s.record.id, requiredContext);
          const placementEst = this.estimatePlacement(s.record, requiredContext);
          return {
            modelId: s.record.id,
            runtimeId: this.preferredRuntime(s.record.id),
            capabilityScore: Math.max(0, s.score),
            residency: resState,
            verifiedSuccessRate: this.measuredSuccessRate(s.record, task, requiredCapability),
            estimatedLoadMs: resState === 'ready' ? 0 : placementEst.estimatedLoadMs,
            evictionRequired: placementEst.evictionRequired,
            kvCacheFits: placementEst.kvCacheFits,
          };
        }),
      });
      for (const a of all) {
        const s = capable.find((c) => c.record.id === a.modelId)!;
        if (!a.admissible) {
          s.rejected.push(`resource: ${a.reasons.join('; ')}`);
          continue;
        }
        const f = a.factors!;
        const isDefaultPreferred = routing.defaultModel && s.record.id === routing.defaultModel;
        s.reasons.push(`resource (${workload}, account ${a.accountId}): score ${a.score} = quality ${f.quality.toFixed(2)}, reliability ${f.reliability.toFixed(2)}, capacity ${f.capacity.toFixed(2)}, cost ${f.cost.toFixed(2)}, latency ${f.latency.toFixed(2)}, quota risk ${f.quotaRisk.toFixed(2)}`);
        s.score = Math.round(a.score! * 1000) / 10 + (isDefaultPreferred ? 100 : 0);
      }
      const chosen = all.filter((a) => a.admissible).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      router.record(task.id, workload, chosen, all);
    }

    const eligible = scored.filter((s) => s.rejected.length === 0);
    const rejected = scored.filter((s) => s.rejected.length > 0);

    const evaluatedCandidates: EvaluatedCandidate[] = [];
    const policyConstraintsApplied: string[] = [
      'hosted-provider-gate',
      'execution-policy-bounds',
      ...(routing.mode === 'PROVIDER_ONLY' ? [`provider-only:${routing.provider ?? 'nvidia'}`] : []),
    ];
    const resourceConstraintsApplied: string[] = ['context-headroom-requirement', 'concurrency-limits', 'gpu-memory'];

    for (const s of scored) {
      const record = s.record;
      const instances = this.deps.models.instancesOf(record.id);
      const runtimeId = instances[0]?.runtimeId ?? 'unknown';
      const segKey: ProfileSegmentationKey = {
        model: record.id,
        runtime: runtimeId,
        quantization: record.quantization,
        modelVersion: (record as unknown as Record<string, unknown>).version as string | undefined,
        wazirProtocolVersion: '1.0.0',
      };
      const profile = this.deps.modelIntelligence?.getProfile(segKey);
      const m = profile?.categoryMeasurements?.find((c) => c.category === requiredCapability);
      const cond =
        classification.language && profile?.conditionalMeasurements?.byLanguage?.[classification.language]
          ? profile.conditionalMeasurements.byLanguage[classification.language].find((c) => c.category === requiredCapability)
          : undefined;

      const isEligible = s.rejected.length === 0;
      const policyRejection = s.rejected.find((r) => r.includes('hosted') || r.includes('policy') || r.includes('provider_only') || r.includes('routingMode'));
      const resourceRejection = s.rejected.find((r) => r.includes('context') || r.includes('instance') || r.includes('memory') || r.includes('resource:'));

      evaluatedCandidates.push({
        modelId: record.id,
        runtimeId,
        profileFound: !!profile,
        isStale: !!profile?.isStale,
        staleReason: profile?.staleReason,
        categoryScore: m ? m.score : undefined,
        conditionalScore: cond ? cond.score : undefined,
        effectiveScore: s.score,
        confidence: m ? m.confidence : (profile ? profile.confidence : undefined),
        sampleCount: m ? m.sampleCount : 0,
        policyAllowed: !policyRejection,
        policyRejection,
        resourceAllowed: !resourceRejection,
        resourceRejection,
        eligible: isEligible,
        reasons: isEligible ? s.reasons : s.rejected,
      });
    }

    const preferred = task.execution?.targetModelId;
    if (preferred) {
      const match = eligible.find((s) => s.record.id === preferred);
      if (!match) {
        const detail =
          rejected.find((s) => s.record.id === preferred)?.rejected.join('; ') ??
          `model '${preferred}' is not registered`;
        throw new SchedulingError(
          `Requested model '${preferred}' is not eligible. ${detail}. No silent fallback will be performed.`,
          [detail],
        );
      }
      const instance = this.selectInstance(match.record);
      const circuit = this.deps.reliability?.status(preferred, task.type);

      const explanation: EmpiricalRoutingExplanation = {
        requiredCapability,
        phase: classification.phase,
        language: classification.language,
        candidateModels: records.map((r) => r.id),
        evaluatedCandidates,
        selectedModelId: preferred,
        selectionReason: `Explicitly requested model '${preferred}' satisfied all hard constraints`,
        policyConstraintsApplied,
        resourceConstraintsApplied,
      };

      return {
        modelId: preferred,
        modelInstanceId: instance.id,
        strategy: 'explicit',
        score: match.score,
        empiricalExplanation: explanation,
        reasons: [
          `explicitly requested model '${preferred}'`,
          `required capability: ${requiredCapability}`,
          ...match.reasons,
          ...(circuit && circuit.state !== 'CLOSED' ? [`warning: ${task.type} ${circuit.reason}`] : []),
        ],
      };
    }

    // When allowFallback is false and defaultModel was already tried (excluded during escalation), fail closed!
    if (!routing.allowFallback && routing.defaultModel && excludeModelIds.includes(routing.defaultModel)) {
      throw new SchedulingError(
        `Fallback is disabled (allowFallback=false) after default model '${routing.defaultModel}' failed. No silent fallback will be performed.`,
        [`allowFallback=false prevents switching away from '${routing.defaultModel}'`],
      );
    }

    if (eligible.length === 0) {
      const modeDesc =
        routing.mode === 'PROVIDER_ONLY'
          ? ` under provider_only (${routing.provider ?? 'nvidia'}) routing`
          : '';
      throw new SchedulingError(
        `No model satisfies the task requirements${modeDesc}. No silent fallback will be performed.`,
        rejected.flatMap((s) => [`${s.record.id}: ${s.rejected.join('; ')}`]),
      );
    }

    eligible.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
    const best = eligible[0];
    const instance = this.selectInstance(best.record);

    const explanation: EmpiricalRoutingExplanation = {
      requiredCapability,
      phase: classification.phase,
      language: classification.language,
      candidateModels: records.map((r) => r.id),
      evaluatedCandidates,
      selectedModelId: best.record.id,
      selectionReason: `Selected model '${best.record.id}' with highest verified evidence score (${best.score}) for required capability '${requiredCapability}'`,
      policyConstraintsApplied,
      resourceConstraintsApplied,
    };

    return {
      modelId: best.record.id,
      modelInstanceId: instance.id,
      strategy: this.deps.modelIntelligence ? 'empirical_profile' : 'capability_match',
      score: best.score,
      empiricalExplanation: explanation,
      reasons: [
        `required capability: ${requiredCapability}`,
        ...(classification.language ? [`language: ${classification.language}`] : []),
        ...(classification.phase ? [`phase: ${classification.phase}`] : []),
        ...best.reasons,
      ],
    };
  }

  /** Whether a model is resident with enough context (`ready`), loaded too small (`reload`), or not loaded. */
  private residency(modelId: string, requiredContext: number): 'ready' | 'reload' | 'load' {
    const instances = this.deps.models.instancesOf(modelId);
    const loaded = instances.filter((i) => i.loaded);
    if (loaded.some((i) => i.contextTokens === undefined || i.contextTokens >= requiredContext)) return 'ready';
    return loaded.length ? 'reload' : 'load';
  }

  /** Runtime of the instance a model would run on: a ready instance first. */
  private preferredRuntime(modelId: string): string {
    const instances = this.deps.models.instancesOf(modelId);
    return (instances.find((i) => i.state === 'READY') ?? instances.find((i) => i.loaded) ?? instances[0])?.runtimeId ?? 'unknown';
  }

  /** Empirical verified success rate from ModelIntelligenceService or legacy record.performance. */
  private measuredSuccessRate(
    record: ModelRecord,
    task: Task,
    category: ModelCapabilityCategory,
  ): number | undefined {
    if (this.deps.modelIntelligence) {
      const instances = this.deps.models.instancesOf(record.id);
      const runtimeId = instances[0]?.runtimeId ?? 'unknown';
      const segKey: ProfileSegmentationKey = {
        model: record.id,
        runtime: runtimeId,
        quantization: record.quantization,
        modelVersion: (record as unknown as Record<string, unknown>).version as string | undefined,
        wazirProtocolVersion: '1.0.0',
      };
      const profile = this.deps.modelIntelligence.getProfile(segKey);
      if (profile && !profile.isStale) {
        const m = profile.categoryMeasurements.find((c) => c.category === category);
        if (m && m.sampleCount >= 2 && Number.isFinite(m.score)) {
          return m.score;
        }
      }
    }
    const measured = record.performance?.[task.type];
    if (measured && measured.samples >= MIN_MEASURED_SAMPLES && Number.isFinite(measured.verifiedSuccessRate)) {
      return measured.verifiedSuccessRate;
    }
    return undefined;
  }

  /**
   * Estimates incremental KV-cache GPU memory (GB) beyond base context (default 8192 tokens
   * or the currently loaded context window).
   */
  private estimateKvCacheGB(record: ModelRecord, requiredContext: number, baseCoveredContext = 8192): number {
    if (requiredContext <= baseCoveredContext) return 0;
    const extraTokens = requiredContext - baseCoveredContext;
    const baseWeightGB = Math.max(4, record.memory?.minGpuGB ?? record.memory?.minSystemGB ?? 8);
    // ~25% of base weight footprint per 32k additional context tokens
    return Number(((extraTokens / 32768) * (baseWeightGB * 0.25)).toFixed(2));
  }

  /**
   * Estimates cold-start load time, eviction requirement, and whether KV cache fits on at least one
   * candidate instance for ResourceRouter assessment.
   */
  private estimatePlacement(
    record: ModelRecord,
    requiredContext: number,
  ): { estimatedLoadMs: number; evictionRequired: boolean; kvCacheFits: boolean } {
    const instances = this.deps.models.instancesOf(record.id);
    if (instances.length === 0) {
      return { estimatedLoadMs: 0, evictionRequired: false, kvCacheFits: true };
    }

    let bestLoadMs = Number.POSITIVE_INFINITY;
    let anyEviction = false;
    let anyKvFits = false;

    for (const instance of instances) {
      const runtime = this.deps.runtimes.get(instance.runtimeId);
      const isHosted = runtime?.runtimeKind === 'hosted' || !instance.computerId;
      if (isHosted) {
        anyKvFits = true;
        bestLoadMs = Math.min(bestLoadMs, 0);
        continue;
      }
      const computer = this.deps.computers.get(instance.computerId!);
      if (!computer || computer.status !== 'online') continue;

      const baseWeightGB = record.memory?.minGpuGB ?? 0;
      const loadMs = instance.loaded
        ? 0
        : (instance.loadTimeMs ?? Math.max(1500, Math.round(baseWeightGB * 400)));
      bestLoadMs = Math.min(bestLoadMs, loadMs);

      const gpuTotalGB = computer.hardware.gpu?.memoryGB;
      const reservedGpuGB = (computer.reservations ?? []).reduce(
        (acc, r) => acc + (r.settledAt ? 0 : (r.vramBytes ?? 0) / 1024 ** 3 + ((r as unknown as { gpuMemoryGB?: number }).gpuMemoryGB ?? 0)),
        0,
      );
      const usableGpuGB =
        computer.load?.gpuMemoryAvailableGB !== undefined
          ? Math.max(0, computer.load.gpuMemoryAvailableGB - reservedGpuGB)
          : gpuTotalGB !== undefined && computer.load?.gpuMemoryUsedGB !== undefined
            ? Math.max(0, gpuTotalGB - computer.load.gpuMemoryUsedGB - reservedGpuGB)
            : gpuTotalGB !== undefined && reservedGpuGB > 0
              ? Math.max(0, gpuTotalGB - reservedGpuGB)
              : undefined;

      const coveredContext = instance.loaded ? (instance.contextTokens ?? 8192) : 8192;
      const kvCacheGB =
        computer.hardware.gpu && (baseWeightGB > 0 || usableGpuGB !== undefined)
          ? this.estimateKvCacheGB(record, requiredContext, coveredContext)
          : 0;
      const neededGpuGB = (instance.loaded ? 0 : baseWeightGB) + kvCacheGB;

      if (usableGpuGB !== undefined && neededGpuGB > usableGpuGB) {
        // Check if total GPU could fit weights + KV cache if other non-reserved models were evicted
        const unreservedTotal = Math.max(0, (gpuTotalGB ?? usableGpuGB) - reservedGpuGB);
        if (!instance.loaded && baseWeightGB + kvCacheGB <= unreservedTotal && (computer.load?.gpuMemoryUsedGB ?? 0) > 0) {
          anyEviction = true;
          anyKvFits = true;
        }
      } else if (gpuTotalGB !== undefined && baseWeightGB > 0 && baseWeightGB + kvCacheGB > gpuTotalGB) {
        // Total GPU cannot fit weights + KV cache
      } else {
        anyKvFits = true;
      }
    }

    return {
      estimatedLoadMs: Number.isFinite(bestLoadMs) ? bestLoadMs : 0,
      evictionRequired: anyEviction,
      kvCacheFits: anyKvFits,
    };
  }

  private effectivePolicyForHosted(task: Task, providerId: string, routing: ResolvedRoutingConstraint) {
    const basePolicy = task.policy;
    // If localOnly or sensitive/restricted is set, never override — PolicyEngine will rightly deny.
    if (basePolicy?.localOnly || basePolicy?.dataClassification === 'sensitive' || basePolicy?.dataClassification === 'restricted') {
      return basePolicy;
    }
    // If provider_only mode is explicitly configured for this provider, or the user explicitly pinned this hosted model/runtime:
    const explicitlyRequestedHosted =
      (routing.mode === 'PROVIDER_ONLY' && (!routing.provider || routing.provider === providerId.toLowerCase())) ||
      task.execution?.targetRuntimeId === providerId;
    if (explicitlyRequestedHosted && basePolicy?.allowHostedProviders === undefined) {
      return { ...basePolicy, allowHostedProviders: true };
    }
    return basePolicy;
  }

  private scoreModel(
    task: Task,
    record: ModelRecord,
    requiredContext: number,
    classification?: TaskCapabilityClassification,
    routing: ResolvedRoutingConstraint = this.resolveRoutingConstraint(task),
  ): ScoredModel {
    const reasons: string[] = [];
    const rejected: string[] = [];
    const requiredCapabilities = task.requirements.capabilities ?? [];

    for (const capability of requiredCapabilities) {
      if (record.capabilities.includes(capability)) {
        reasons.push(`${capability} capability: present`);
      } else {
        rejected.push(`${capability} capability: missing`);
      }
    }

    if (task.requirements.toolCalling && !record.toolCalling) {
      rejected.push('tool calling: required but unsupported');
    } else if (task.requirements.toolCalling && record.toolCalling) {
      reasons.push('tool calling: supported');
    }

    if (task.requirements.vision && !record.vision) {
      rejected.push('vision: required but unsupported');
    }
    if (task.requirements.reasoning === 'high' && !record.reasoning) {
      rejected.push('strong reasoning: required but unsupported');
    }

    const context = effectiveContextTokens(record);
    if (requiredContext > 0) {
      if (context >= requiredContext) {
        reasons.push(`context ${context} >= required ${requiredContext}`);
      } else {
        rejected.push(`context ${context} < required ${requiredContext}`);
      }
    }

    if (task.policy?.allowedModels && !task.policy.allowedModels.includes(record.id)) {
      rejected.push(`policy: model '${record.id}' is not in allowedModels`);
    }

    // A model only servable by a hosted provider must clear the hosted
    // eligibility gate here in Phase 1, not just in Phase 2's computer
    // placement.
    const isHostedOnly =
      Array.isArray(record.runtimeCompatibility) &&
      record.runtimeCompatibility.length > 0 &&
      record.runtimeCompatibility.every((t) => HOSTED_RUNTIME_TYPES.has(t));
    if (isHostedOnly) {
      const providerId = record.runtimeCompatibility[0];
      const effectivePolicy =
        task.execution?.targetModelId === record.id &&
        !task.policy?.localOnly &&
        task.policy?.dataClassification !== 'sensitive' &&
        task.policy?.dataClassification !== 'restricted' &&
        task.policy?.allowHostedProviders === undefined
          ? { ...task.policy, allowHostedProviders: true }
          : this.effectivePolicyForHosted(task, providerId, routing);
      const gate = this.deps.policy.checkHostedEligibility(effectivePolicy, providerId);
      if (!gate.allowed) {
        rejected.push(gate.reason);
      } else {
        reasons.push(gate.reason);
      }
    }

    if (routing.mode === 'LOCAL_ONLY' && (record.local === false || isHostedOnly)) {
      rejected.push(`routingMode=LOCAL_ONLY: hosted model '${record.id}' is not permitted`);
    } else if (routing.mode === 'PROVIDER_ONLY') {
      const targetProvider = routing.provider ?? 'nvidia';
      const matchesProvider = this.isModelOfProvider(record, targetProvider);
      // Strictly reject any model not belonging to targetProvider — even if explicitly pinned!
      if (!matchesProvider) {
        rejected.push(`routing.mode=provider_only (${targetProvider}): model '${record.id}' (provider '${record.provider}') is not permitted`);
      } else {
        reasons.push(`routing.mode=provider_only (${targetProvider}): eligible ${targetProvider} model`);
      }
    } else if (routing.mode === 'HYBRID') {
      reasons.push(`routingMode=HYBRID: ${record.local === false ? 'hosted' : 'local'} model eligible`);
    }

    const circuit = this.deps.reliability?.status(record.id, task.type);
    if (circuit?.state === 'OPEN' && task.execution?.targetModelId !== record.id) {
      rejected.push(`${task.type} ${circuit.reason}`);
    } else if (circuit?.state === 'HALF_OPEN') {
      reasons.push(`${task.type} ${circuit.reason}`);
    }

    if (rejected.length > 0) {
      return { record, score: 0, reasons, rejected };
    }

    let score = 0;
    score += requiredCapabilities.filter((c) => record.capabilities.includes(c)).length * 2;
    if (record.toolCalling) score += 1;
    if (routing.mode === 'PROVIDER_ONLY' && this.isModelOfProvider(record, routing.provider ?? 'nvidia')) {
      score += 5;
    }
    if (routing.defaultModel && record.id === routing.defaultModel) {
      score += 50;
      reasons.push(`configured defaultModel '${routing.defaultModel}' preferred`);
    }

    // Empirical Model Intelligence Profile integration
    if (this.deps.modelIntelligence && classification) {
      const instances = this.deps.models.instancesOf(record.id);
      const runtimeId = instances[0]?.runtimeId ?? 'unknown';
      const segKey: ProfileSegmentationKey = {
        model: record.id,
        runtime: runtimeId,
        quantization: record.quantization,
        modelVersion: (record as unknown as Record<string, unknown>).version as string | undefined,
        wazirProtocolVersion: '1.0.0',
      };
      const profile = this.deps.modelIntelligence.getProfile(segKey);
      if (profile?.isStale) {
        reasons.push(`empirical profile stale: ${profile.staleReason} (evidence ignored for active routing)`);
      } else if (profile) {
        const m = profile.categoryMeasurements.find((c) => c.category === classification.primaryCategory);
        if (m && m.sampleCount >= 2) {
          const evidenceWeight = Math.round(m.score * 5 * m.confidence);
          score += evidenceWeight;
          reasons.push(
            `empirical evidence [${classification.primaryCategory}]: score ${(m.score * 100).toFixed(0)}%, ` +
              `confidence ${(m.confidence * 100).toFixed(0)}% across ${m.sampleCount} samples (+${evidenceWeight})`,
          );
        } else if (m) {
          reasons.push(`empirical evidence [${classification.primaryCategory}]: insufficient samples (${m.sampleCount} < 2)`);
        }

        if (classification.language && profile.conditionalMeasurements?.byLanguage?.[classification.language]) {
          const cond = profile.conditionalMeasurements.byLanguage[classification.language].find(
            (c) => c.category === classification.primaryCategory,
          );
          if (cond && cond.sampleCount >= 2) {
            const condBonus = Math.round(cond.score * 2 * cond.confidence);
            score += condBonus;
            reasons.push(
              `empirical conditional [lang=${classification.language}]: score ${(cond.score * 100).toFixed(0)}% (+${condBonus})`,
            );
          }
        }
      } else {
        reasons.push(`empirical evidence [${classification.primaryCategory}]: unmeasured (neutral baseline)`);
      }
    } else {
      // Measured evidence from legacy record.performance if modelIntelligence is not configured
      const measured = record.performance?.[task.type];
      if (measured && measured.samples >= MIN_MEASURED_SAMPLES) {
        score += Math.round(measured.verifiedSuccessRate * 2) - (measured.protocolFailureRate >= 0.5 ? 1 : 0);
        reasons.push(
          `measured ${task.type}: ${pct(measured.verifiedSuccessRate)} verified over ${measured.samples} runs, ` +
            `protocol failures ${pct(measured.protocolFailureRate)}` +
            (measured.firstPassBuildRate !== null ? `, first-pass build ${pct(measured.firstPassBuildRate)}` : ''),
        );
      }
    }

    if (requiredContext > 0 && context >= requiredContext * 2) {
      score += 1;
      reasons.push('context headroom: at least 2x the requirement');
    }

    const loadedInstance = this.deps.models
      .instancesOf(record.id)
      .find((i) => i.loaded && i.health === 'healthy');
    if (loadedInstance) {
      const bonus = loadedInstance.state === 'READY' ? 30 : 15;
      score += bonus;
      reasons.push(`instance on '${loadedInstance.computerId ?? loadedInstance.runtimeId}' already loaded${loadedInstance.state === 'READY' ? ' and ready' : ''} (+${bonus})`);
    } else if (this.deps.models.instancesOf(record.id).length > 0) {
      reasons.push('available instance will be loaded on demand');
    } else {
      rejected.push('no running instance on any computer');
    }

    return { record, score, reasons, rejected };
  }

  private selectInstance(record: ModelRecord): ModelInstance {
    const instances = this.deps.models.instancesOf(record.id).filter(i => !['DRAINING', 'UNLOADING'].includes(i.state ?? ''));
    if (instances.length === 0) {
      throw new SchedulingError(
        `Model '${record.id}' is registered but has no running instance on any computer`,
        ['model has no instances'],
      );
    }

    const online = new Set(this.deps.computers.listOnline().map((c) => c.id));
    // A hosted instance has no computerId, so it is never a member of `online`
    // by construction (Set.has(undefined) is always false) — treat "no
    // computer to be online" as trivially satisfied for those instances,
    // otherwise every hosted instance would be wrongly excluded from both
    // preference passes below.
    const isOnline = (i: ModelInstance): boolean => !i.computerId || online.has(i.computerId);
    const instance =
      instances.find((i) => i.loaded && i.health === 'healthy' && isOnline(i)) ??
      instances.find((i) => i.health !== 'unavailable' && isOnline(i)) ??
      instances[0];

    return instance;
  }

  // ==================== PHASE 2: COMPUTER SCHEDULING ====================

  private scheduleComputer(
    task: Task,
    record: ModelRecord,
    requiredContext = 0,
    routing: ResolvedRoutingConstraint = this.resolveRoutingConstraint(task),
  ): ComputerRoutingDecision {
    const instances = this.deps.models.instancesOf(record.id);
    const failures: string[] = [];
    const placements: ScoredPlacement[] = [];

    for (const instance of instances) {
      if (['DRAINING', 'UNLOADING', 'LOADING'].includes(instance.state ?? '')) {
        failures.push(`${instance.id}: lifecycle operation in progress`); continue;
      }
      if (task.execution?.targetComputerId && instance.computerId !== task.execution.targetComputerId) continue;
      if (task.execution?.targetRuntimeId && instance.runtimeId !== task.execution.targetRuntimeId) {
        failures.push(`${instance.runtimeId}: does not match targetRuntimeId '${task.execution.targetRuntimeId}'`);
        continue;
      }
      const runtime = this.deps.runtimes.get(instance.runtimeId);
      const isHosted = runtime?.runtimeKind === 'hosted' || !instance.computerId;

      if (routing.mode === 'PROVIDER_ONLY') {
        const targetProvider = routing.provider ?? 'nvidia';
        if (instance.runtimeId.toLowerCase() !== targetProvider && runtime?.type?.toLowerCase() !== targetProvider) {
          failures.push(`${instance.runtimeId}: runtime is not '${targetProvider}' (required by provider_only routing)`);
          continue;
        }
      }

      if (isHosted) {
        if (routing.mode === 'LOCAL_ONLY') {
          failures.push(`${instance.runtimeId}: hosted runtime is not permitted when routingMode is LOCAL_ONLY`);
          continue;
        }
        const effectivePolicy =
          task.execution?.targetModelId === record.id &&
          !task.policy?.localOnly &&
          task.policy?.dataClassification !== 'sensitive' &&
          task.policy?.dataClassification !== 'restricted' &&
          task.policy?.allowHostedProviders === undefined
            ? { ...task.policy, allowHostedProviders: true }
            : this.effectivePolicyForHosted(task, instance.runtimeId, routing);
        const gate = this.deps.policy.checkHostedEligibility(effectivePolicy, instance.runtimeId);
        if (!gate.allowed) {
          failures.push(gate.reason);
          continue;
        }
        if (task.requirements?.os) {
          failures.push(`${instance.runtimeId}: hosted provider has no OS identity, cannot satisfy OS requirement '${task.requirements.os}'`);
          continue;
        }
        if (task.requirements?.architecture) {
          failures.push(`${instance.runtimeId}: hosted provider has no CPU architecture, cannot satisfy architecture requirement '${task.requirements.architecture}'`);
          continue;
        }
        if (task.requirements?.requiresCuda) {
          failures.push(`${instance.runtimeId}: hosted provider cannot satisfy CUDA GPU requirement`);
          continue;
        }
        if (task.requirements?.requiresGpu) {
          failures.push(`${instance.runtimeId}: hosted provider cannot satisfy local GPU requirement`);
          continue;
        }
        // allowedComputers/allowedRuntimes still apply — a hosted provider
        // simply has no computer identity to check against allowedComputers.
        if (effectivePolicy?.allowedComputers) {
          failures.push(`${instance.runtimeId}: hosted provider has no computer identity, cannot satisfy allowedComputers`);
          continue;
        }
        if (effectivePolicy?.allowedRuntimes && !effectivePolicy.allowedRuntimes.includes(instance.runtimeId)) {
          failures.push(`${instance.runtimeId}: not in allowedRuntimes`);
          continue;
        }
        if (!runtime || runtime.health === 'unavailable') {
          failures.push(`${instance.runtimeId}: not authenticated or unreachable (run 'wa auth login ${instance.runtimeId}')`);
          continue;
        }
        if (instance.health === 'unavailable') {
          failures.push(`${instance.runtimeId}: model instance reports unavailable`);
          continue;
        }
        if (record.runtimeCompatibility && record.runtimeCompatibility !== 'any' && Array.isArray(record.runtimeCompatibility)) {
          const runtimeType = runtime.type ?? instance.runtimeId;
          if (!record.runtimeCompatibility.includes(runtimeType as any)) {
            failures.push(`${instance.runtimeId}: runtime type '${runtimeType}' incompatible with model runtimeCompatibility`);
            continue;
          }
        }

        placements.push({
          instance,
          computer: undefined,
          score: runtime.health === 'healthy' ? 2 : 1,
          reasons: [`hosted provider '${instance.runtimeId}' authenticated and eligible`, gate.reason],
        });
        continue;
      }

      const computer = this.deps.computers.get(instance.computerId!);
      if (!computer || computer.status !== 'online') {
        failures.push(`${instance.computerId}: computer is offline or unknown`);
        continue;
      }

      // Heterogeneous OS Compatibility
      if (task.requirements?.os) {
        const rawReqOs = task.requirements.os;
        const reqOsList = (Array.isArray(rawReqOs) ? rawReqOs : [rawReqOs]).map(normalizePlatform);
        const compOs = normalizePlatform(computer.os.platform);
        if (!reqOsList.includes(compOs)) {
          failures.push(`${computer.id}: OS platform '${computer.os.platform}' does not match required OS '${Array.isArray(rawReqOs) ? rawReqOs.join(',') : rawReqOs}'`);
          continue;
        }
      }

      // Heterogeneous CPU Architecture Compatibility
      if (task.requirements?.architecture) {
        const rawArch = task.requirements.architecture;
        const reqArchList = (Array.isArray(rawArch) ? rawArch : [rawArch]).map(normalizeArch);
        const compArch = normalizeArch(computer.os.architecture);
        if (!reqArchList.includes(compArch)) {
          failures.push(`${computer.id}: architecture '${computer.os.architecture}' does not match required architecture '${Array.isArray(rawArch) ? rawArch.join(',') : rawArch}'`);
          continue;
        }
      }

      // Heterogeneous GPU & CUDA Requirements
      if (task.requirements?.requiresGpu && !computer.hardware.gpu) {
        failures.push(`${computer.id}: task requires GPU acceleration, but computer has no GPU`);
        continue;
      }
      if (task.requirements?.requiresCuda && (!computer.hardware.gpu || !computer.hardware.gpu.cuda)) {
        failures.push(`${computer.id}: task requires NVIDIA CUDA, but computer GPU does not support CUDA`);
        continue;
      }

      const policy = task.policy;
      if (policy?.allowedComputers && !policy.allowedComputers.includes(computer.id)) {
        failures.push(`${computer.id}: not in allowedComputers`);
        continue;
      }
      if (policy?.localOnly && !computer.local) {
        failures.push(`${computer.id}: local-only policy requires a local computer`);
        continue;
      }
      if (policy?.allowedRuntimes && !policy.allowedRuntimes.includes(instance.runtimeId)) {
        failures.push(`${computer.id}: runtime '${instance.runtimeId}' not in allowedRuntimes`);
        continue;
      }

      if (runtime && runtime.health === 'unavailable') {
        failures.push(`${computer.id}: runtime '${runtime.id}' is unavailable`);
        continue;
      }
      if (instance.health === 'unavailable') {
        failures.push(`${computer.id}: model instance reports unavailable`);
        continue;
      }

      if (record.runtimeCompatibility && record.runtimeCompatibility !== 'any' && Array.isArray(record.runtimeCompatibility)) {
        const runtimeType = runtime?.type ?? instance.runtimeId;
        if (!record.runtimeCompatibility.includes(runtimeType as any)) {
          failures.push(`${computer.id}: runtime type '${runtimeType}' incompatible with model runtimeCompatibility`);
          continue;
        }
      }

      const taskMinSystemGB = task.requirements?.minimumMemoryGB ?? 0;
      const requiredSystemGB = Math.max(record.memory?.minSystemGB ?? 0, taskMinSystemGB);
      if (requiredSystemGB > computer.hardware.memoryGB) {
        failures.push(`${computer.id}: memory ${computer.hardware.memoryGB}GB < required ${requiredSystemGB}GB`);
        continue;
      }

      const reservedSystemGB = (computer.reservations ?? []).reduce(
        (acc, r) => acc + (r.settledAt ? 0 : (r.memoryBytes ?? 0) / 1024 ** 3 + ((r as unknown as { memoryGB?: number }).memoryGB ?? 0)),
        0,
      );
      const usableSystemGB =
        computer.load?.memoryAvailableGB !== undefined
          ? Math.max(0, computer.load.memoryAvailableGB - reservedSystemGB)
          : undefined;

      if (!instance.loaded && usableSystemGB !== undefined && requiredSystemGB > usableSystemGB) {
        failures.push(`${computer.id}: available memory ${usableSystemGB}GB < required ${requiredSystemGB}GB`);
        continue;
      }

      const taskMinGpuGB = task.requirements?.minimumGPUMemoryGB ?? 0;
      const requiredGpuGB = Math.max(record.memory?.minGpuGB ?? 0, taskMinGpuGB);
      const gpuGB = computer.hardware.gpu?.memoryGB ?? 0;
      if (requiredGpuGB > 0 && gpuGB < requiredGpuGB) {
        failures.push(`${computer.id}: GPU memory ${gpuGB}GB < required ${requiredGpuGB}GB`);
        continue;
      }

      // KV-cache VRAM & active GPU reservation enforcement before dispatch
      const reservedGpuGB = (computer.reservations ?? []).reduce(
        (acc, r) => acc + (r.settledAt ? 0 : (r.vramBytes ?? 0) / 1024 ** 3 + ((r as unknown as { gpuMemoryGB?: number }).gpuMemoryGB ?? 0)),
        0,
      );
      const usableGpuGB =
        computer.load?.gpuMemoryAvailableGB !== undefined
          ? Math.max(0, computer.load.gpuMemoryAvailableGB - reservedGpuGB)
          : computer.hardware.gpu && computer.load?.gpuMemoryUsedGB !== undefined
            ? Math.max(0, gpuGB - computer.load.gpuMemoryUsedGB - reservedGpuGB)
            : computer.hardware.gpu && reservedGpuGB > 0
              ? Math.max(0, gpuGB - reservedGpuGB)
              : undefined;

      const coveredContext = instance.loaded ? (instance.contextTokens ?? 8192) : 8192;
      const kvCacheGB =
        computer.hardware.gpu && (requiredGpuGB > 0 || usableGpuGB !== undefined)
          ? this.estimateKvCacheGB(record, requiredContext, coveredContext)
          : 0;
      const neededGpuGB = (instance.loaded ? 0 : requiredGpuGB) + kvCacheGB;

      if (computer.hardware.gpu && requiredGpuGB > 0 && requiredGpuGB + kvCacheGB > gpuGB) {
        failures.push(
          `${computer.id}: GPU memory ${gpuGB}GB cannot fit model (${requiredGpuGB}GB) + KV cache (${kvCacheGB}GB) for context ${requiredContext}`,
        );
        continue;
      }

      if (usableGpuGB !== undefined && neededGpuGB > usableGpuGB) {
        if (kvCacheGB > 0 && (instance.loaded || requiredGpuGB <= usableGpuGB)) {
          failures.push(
            `${computer.id}: usable GPU memory ${usableGpuGB}GB cannot fit KV cache (${kvCacheGB}GB) for target context ${requiredContext}`,
          );
          continue;
        }
        failures.push(
          `${computer.id}: usable GPU memory ${usableGpuGB}GB < required ${neededGpuGB}GB (weights ${instance.loaded ? 0 : requiredGpuGB}GB + KV cache ${kvCacheGB}GB)`,
        );
        continue;
      }

      const reasons: string[] = [];
      let score = instance.health === 'healthy' ? 1 : 0;

      if (instance.state === 'READY' || instance.loaded) {
        score += 2;
        reasons.push(`model already loaded via '${instance.runtimeId}' (no load latency)`);
      } else {
        const estimatedLoadMs = instance.loadTimeMs ?? Math.max(1500, Math.round(requiredGpuGB * 400));
        const coldStartPenalty = Math.min(1.5, estimatedLoadMs / 20_000);
        score -= coldStartPenalty;
        reasons.push(`model will be loaded via '${instance.runtimeId}' (est. cold start ${estimatedLoadMs}ms)`);
      }

      if (kvCacheGB > 0) {
        reasons.push(`estimated KV cache ${kvCacheGB}GB fits for context ${requiredContext}`);
      }

      const cpuPercent = computer.load?.cpuPercent ?? 0;
      score += Math.max(0, 1 - cpuPercent / 100);
      reasons.push(`current CPU load ${Math.round(cpuPercent)}%`);

      if (computer.load?.memoryAvailableGB !== undefined) {
        reasons.push(`available RAM ${computer.load.memoryAvailableGB}GB`);
        if (requiredSystemGB > 0 && computer.load.memoryAvailableGB >= requiredSystemGB * 2) {
          score += 0.5;
        }
      }

      if (computer.local) {
        score += 1;
        reasons.push('local computer (lowest latency)');
      }

      if (runtime?.health === 'healthy') {
        score += 1;
        reasons.push(`runtime '${runtime.id}' is healthy`);
      }

      if (computer.health === 'degraded') {
        score -= 1;
        reasons.push('computer reports degraded health');
      }

      // Heterogeneous affinity bonuses
      if (task.requirements?.os) {
        score += 1.5;
        reasons.push(`OS '${computer.os.platform}' matches task requirements`);
      }
      if (task.requirements?.architecture) {
        score += 1.0;
        reasons.push(`architecture '${computer.os.architecture}' matches task requirements`);
      }
      if (task.requirements?.requiresCuda && computer.hardware.gpu?.cuda) {
        score += 2.0;
        reasons.push(`NVIDIA CUDA acceleration active (${computer.hardware.gpu.model})`);
      }
      if (computer.hardware.gpu?.unifiedMemory) {
        score += 0.5;
        reasons.push('unified memory architecture available for model working set');
      }

      placements.push({ instance, computer, score, reasons });
    }

    if (placements.length === 0) {
      const details = failures.length > 0 ? ` ${failures.join('; ')}.` : '';
      throw new SchedulingError(
        `No computer can host model '${record.id}'.${details} No silent fallback will be performed.`,
        [],
        failures,
      );
    }

    placements.sort(
      (a, b) => b.score - a.score || (a.computer?.id ?? a.instance.runtimeId).localeCompare(b.computer?.id ?? b.instance.runtimeId),
    );
    const best = placements[0];

    return {
      computerId: best.computer?.id,
      runtimeId: best.instance.runtimeId,
      placementKind: best.computer ? 'local' : 'hosted',
      resourceType: best.computer ? 'LOCAL_GPU_INFERENCE' : 'HOSTED_API_INFERENCE',
      score: best.score,
      reasons: best.reasons,
    };
  }
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  return new Scheduler(deps);
}
