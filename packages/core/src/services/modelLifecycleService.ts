import { ModelLifecycleError, type ModelLoadOptions, type ModelLoadPlan, type LoadEstimate, type ResourceReservation } from '../types/modelLifecycle.js';
import { PolicyEngine } from './policyEngine.js';
import type { ExecutionEngine } from './executionEngine.js';
import type {
  ModelInstance,
  ModelLifecycleEvent,
  ModelLifecycleEventType,
  ModelLifecycleState,
  ModelRecord,
} from '../types/model.js';
import type { TaskRequirements } from '../types/task.js';
import { estimateModelMemory } from '../types/model.js';
import type { ModelRegistry } from './modelRegistry.js';
import type { RuntimeRegistry } from './runtimeRegistry.js';
import type { ComputerRegistry } from './computerRegistry.js';
import type { AgentRegistry } from './agentRegistry.js';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';

export interface KeyValueStore {
  update?<T>(key: string, mutate: (current: T | undefined) => T): Promise<T>;
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<Array<{ key: string; value: unknown }>>;
}

export interface ModelLifecycleServiceDeps {
  models: ModelRegistry;
  runtimes: RuntimeRegistry;
  computers: ComputerRegistry;
  agents?: AgentRegistry;
  adapters: Map<string, RuntimeAdapter>;
  store?: KeyValueStore;
  policy?: PolicyEngine;
  executions?: ExecutionEngine;
  queuedAssignments?: () => Promise<Array<{ id: string; modelId: string; computerId: string; runtimeId?: string }>>;
  resources?: { reservePercent?: number; minimumReserveGiB?: number; minimumContext?: number; autoContext?: number };
  refreshResources?: (computerId: string) => Promise<void>;
}

export interface ModelReadiness {
  ready: boolean;
  totalModels: number;
  installedCount: number;
  readyCount: number;
  loadingCount: number;
  failedCount: number;
  unavailableCount: number;
  readyGenerativeModels: ModelRecord[];
  installedGenerativeModels: ModelRecord[];
  unloadedEligibleModels: ModelRecord[];
  runtimeHealth: Record<string, { status: string; message?: string }>;
}

export interface ResourceAssessment {
  modelId: string;
  estimatedMemoryGB: number;
  availableMemoryGB?: number;
  totalMemoryGB?: number;
  classification: 'SAFE' | 'WARNING' | 'INSUFFICIENT' | 'UNKNOWN';
  message: string;
}

export interface ModelRecommendation {
  model: ModelRecord;
  reasons: string[];
}

export interface RestoreResult {
  restored: string[];
  failed: string[];
  missing: string[];
}

const LAST_READY_MODELS_KEY = 'models/last_ready_set';

export class ModelLifecycleService {
  private inFlightLoads = new Map<string, Promise<ModelLoadPlan>>();
  private operations = new Set<string>();
  private reconciliation?: Promise<DiscoveredModelReconciliation>;
  private policy: PolicyEngine;
  private reservePercent: number;
  private minimumReserveBytes: number;
  private listeners = new Set<(event: ModelLifecycleEvent) => void>();

  constructor(private readonly deps: ModelLifecycleServiceDeps) {
    this.policy = deps.policy ?? new PolicyEngine({ projectRoot: process.cwd() });
    this.reservePercent = deps.resources?.reservePercent ?? 10;
    this.minimumReserveBytes = (deps.resources?.minimumReserveGiB ?? 8) * 1024 ** 3;
    if (!Number.isFinite(this.reservePercent) || this.reservePercent < 0 || this.reservePercent > 100 ||
      !Number.isFinite(this.minimumReserveBytes) || this.minimumReserveBytes < 0) throw new Error('INVALID_RESOURCE_CONFIG');
  }

  /**
   * Subscribe to model lifecycle events.
   */
  subscribe(listener: (event: ModelLifecycleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitEvent(
    type: ModelLifecycleEventType,
    modelId: string,
    extra: Partial<ModelLifecycleEvent> = {},
  ): void {
    const event: ModelLifecycleEvent = {
      type,
      modelId,
      timestamp: new Date(),
      ...extra,
      data: extra.data ?? (extra as Record<string, unknown>),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener failure should not break core lifecycle
      }
    }
  }

  isModelReady(modelId: string): boolean {
    return this.deps.models.isModelReady(modelId);
  }

  getModelState(modelId: string): ModelLifecycleState {
    return this.deps.models.getModelState(modelId);
  }

  /**
   * Evaluates the readiness of the model fleet across all connected runtimes.
   */
  getReadiness(): ModelReadiness {
    const allModels = this.deps.models.list();
    const instances = this.deps.models.listInstances();

    const runtimeHealth: Record<string, { status: string; message?: string }> = {};
    for (const runtime of this.deps.runtimes.list()) {
      runtimeHealth[runtime.id] = { status: runtime.health };
    }

    const readyGenerativeModels: ModelRecord[] = [];
    const installedGenerativeModels: ModelRecord[] = [];
    const unloadedEligibleModels: ModelRecord[] = [];

    let readyCount = 0;
    let loadingCount = 0;
    let failedCount = 0;
    let unavailableCount = 0;

    for (const model of allModels) {
      const modelInstances = this.deps.models.instancesOf(model.id);
      const isGenerative = !model.embedding;

      if (modelInstances.length > 0 && isGenerative) {
        installedGenerativeModels.push(model);
      }

      const hasReadyInstance = modelInstances.some(
        (i) => i.loaded && i.state === 'READY' && i.health === 'healthy',
      );

      if (hasReadyInstance) {
        readyCount++;
        if (isGenerative) {
          readyGenerativeModels.push(model);
        }
      } else if (isGenerative && modelInstances.length > 0) {
        unloadedEligibleModels.push(model);
      }

      if (modelInstances.some((i) => i.state === 'LOADING')) {
        loadingCount++;
      }
      if (modelInstances.some((i) => i.state === 'FAILED')) {
        failedCount++;
      }
      if (modelInstances.length > 0 && modelInstances.every((i) => i.health === 'unavailable' || i.state === 'UNAVAILABLE')) {
        unavailableCount++;
      }
    }

    return {
      ready: readyGenerativeModels.length > 0,
      totalModels: allModels.length,
      installedCount: installedGenerativeModels.length,
      readyCount,
      loadingCount,
      failedCount,
      unavailableCount,
      readyGenerativeModels,
      installedGenerativeModels,
      unloadedEligibleModels,
      runtimeHealth,
    };
  }

  /**
   * Returns models eligible for agent execution based on task requirements.
   */
  getEligibleModels(requirements: TaskRequirements = {}): ModelRecord[] {
    return this.deps.models.list().filter((m) => {
      // Must not be embedding-only for generative tasks
      if (m.embedding) return false;
      if (requirements.toolCalling && !m.toolCalling) return false;
      if (requirements.reasoning === 'high' && !m.reasoning) return false;
      if (requirements.vision && !m.vision) return false;
      return true;
    });
  }

  /**
   * Determines the recommended smallest useful set of installed models
   * providing reasonable coverage of registered agent requirements.
   *
   * Capability-based rather than model-name hard-coded.
   */
  getRecommendedModels(): ModelRecommendation[] {
    const installed = this.deps.models.list().filter((m) => !m.embedding && this.deps.models.instancesOf(m.id).length > 0);
    const recommendations: ModelRecommendation[] = [];
    const recommendedIds = new Set<string>();

    // 1. Coverage for coding agent: generative + toolCalling
    const toolCallingCandidates = installed.filter((m) => m.toolCalling);
    if (toolCallingCandidates.length > 0) {
      // Sort by contextMax, then name
      toolCallingCandidates.sort((a, b) => (b.contextMax ?? 0) - (a.contextMax ?? 0));
      const bestToolModel = toolCallingCandidates[0];
      recommendations.push({
        model: bestToolModel,
        reasons: [
          'generative',
          'tool calling',
          'satisfies wazir-coding requirement',
          `context window ${bestToolModel.contextMax.toLocaleString()} tokens`,
        ],
      });
      recommendedIds.add(bestToolModel.id);
    }

    // 2. Coverage for reasoning / planning agent: generative + reasoning
    const reasoningCandidates = installed.filter((m) => m.reasoning);
    if (reasoningCandidates.length > 0) {
      // Prefer one not already added, or best reasoning model
      const distinctReasoning = reasoningCandidates.find((m) => !recommendedIds.has(m.id)) ?? reasoningCandidates[0];
      if (!recommendedIds.has(distinctReasoning.id)) {
        recommendations.push({
          model: distinctReasoning,
          reasons: [
            'generative',
            'reasoning capability',
            'satisfies planning/architecture requirements',
            distinctReasoning.toolCalling ? 'tool calling supported' : 'design/analytical node',
          ],
        });
        recommendedIds.add(distinctReasoning.id);
      }
    }

    // 3. If no specific capabilities matched, recommend first available generative model
    if (recommendations.length === 0 && installed.length > 0) {
      recommendations.push({
        model: installed[0],
        reasons: ['generative model available for general chat and execution'],
      });
    }

    return recommendations;
  }

  /**
   * Assesses resource feasibility synchronously using cached model specs and computer hardware.
   */
  assessModelSync(modelId: string, targetComputerId?: string): ResourceAssessment {
    const instance = this.deps.models.instancesOf(modelId).find(i => !targetComputerId || i.computerId === targetComputerId);
    const snapshot = instance?.computerId ? this.deps.computers.resourceSnapshot(instance.computerId) : undefined;
    return { modelId, estimatedMemoryGB: 0, availableMemoryGB: snapshot?.availableMemoryBytes === undefined ? undefined : snapshot.availableMemoryBytes / 1024 ** 3,
      totalMemoryGB: snapshot ? snapshot.totalMemoryBytes / 1024 ** 3 : undefined,
      classification: 'UNKNOWN', message: 'Use estimate for context-aware admission; cached model size is not a load estimate.' };
  }

  async assessResources(modelIds: string | string[], targetComputerId?: string): Promise<ResourceAssessment[]> {
    return Promise.all((Array.isArray(modelIds) ? modelIds : [modelIds]).map(async modelId => {
      const { estimate } = await this.estimate(modelId, { computerId: targetComputerId });
      return { modelId, estimatedMemoryGB: (estimate.estimatedTotalMemory ?? 0) / 1024 ** 3,
        availableMemoryGB: estimate.currentlyAvailableMemory === undefined ? undefined : estimate.currentlyAvailableMemory / 1024 ** 3,
        classification: estimate.classification, message: estimate.classification };
    }));
  }

  list(): ModelInstance[] { return this.deps.models.listInstances(); }
  inspect(modelId: string) {
    return { model: this.deps.models.get(modelId), installations: this.deps.models.listInstallations().filter(i => i.modelId === modelId), instances: this.deps.models.instancesOf(modelId) };
  }
  private target(modelId: string, options: ModelLoadOptions = {}): ModelInstance {
    const candidates = this.deps.models.instancesOf(modelId).filter(i => i.computerId &&
      (!options.computerId || i.computerId === options.computerId) && (!options.runtimeId || i.runtimeId === options.runtimeId));
    candidates.sort((a, b) => Number(b.state === 'READY') - Number(a.state === 'READY') || a.id.localeCompare(b.id));
    const target = candidates[0];
    if (!target) throw new ModelLifecycleError('MODEL_NOT_INSTALLED');
    return target;
  }
  private async active(instance: ModelInstance, exclude?: string): Promise<string[]> {
    const live = await this.deps.executions?.list() ?? [];
    const persisted = await this.deps.store?.list('execution/') ?? [];
    const records = [...new Map([...persisted.map(e => e.value as import('../types/execution.js').ExecutionRecord), ...live].map(r => [r.execution.id, r])).values()];
    const queued = (await this.deps.queuedAssignments?.() ?? []).filter(r => r.id !== exclude && r.modelId === instance.modelId && r.computerId === instance.computerId && (!r.runtimeId || r.runtimeId === instance.runtimeId)).map(r => r.id);
    return [...queued, ...records.filter(r => r.execution.id !== exclude && r.execution.modelId === instance.modelId &&
      r.execution.runtimeId === instance.runtimeId && r.execution.computerId === instance.computerId &&
      !['completed', 'failed', 'cancelled'].includes(r.execution.status)).map(r => r.execution.id)];
  }

  async estimate(modelId: string, options: ModelLoadOptions = {}): Promise<ModelLoadPlan> {
    const candidates = this.deps.models.instancesOf(modelId).filter(i => i.computerId &&
      (!options.computerId || options.computerId === i.computerId) && (!options.runtimeId || options.runtimeId === i.runtimeId));
    candidates.sort((a, b) => Number(b.state === 'READY') - Number(a.state === 'READY') || a.id.localeCompare(b.id));
    let first: ModelLoadPlan | undefined;
    for (const i of candidates) {
      const plan = await this.estimateTarget(modelId, { ...options, computerId: i.computerId, runtimeId: i.runtimeId });
      first ??= plan;
      if (plan.admissionDecision.status === 'ADMITTED') return plan;
    }
    if (!first) throw new ModelLifecycleError('MODEL_NOT_INSTALLED');
    return first;
  }
  private async estimateTarget(modelId: string, options: ModelLoadOptions): Promise<ModelLoadPlan> {
    const i = this.target(modelId, options);
    const model = this.deps.models.getRequired(modelId);
    const runtime = this.deps.runtimes.get(i.runtimeId);
    const adapter = this.deps.adapters.get(i.runtimeId);
    const computer = this.deps.computers.get(i.computerId!);
    const installation = this.deps.models.getInstallation(i.installationId ?? i.id);
    const profile = installation?.profile;
    if (this.deps.store?.update) {
      const persisted = await this.deps.store.get('computer/' + i.computerId + '/reservations');
      if (Array.isArray(persisted) && computer) computer.reservations = persisted as ResourceReservation[];
    }
    const snapshot = this.deps.computers.resourceSnapshot(i.computerId!);
    const reasons: string[] = [];
    if (!computer || computer.status !== 'online' || computer.health !== 'healthy') reasons.push('COMPUTER_UNAVAILABLE');
    if (!runtime || runtime.health !== 'healthy' || !adapter || runtime.runtimeKind === 'hosted') reasons.push('RUNTIME_UNAVAILABLE');
    if (installation && !installation.installed) reasons.push('MODEL_NOT_INSTALLED');
    if (model.runtimeCompatibility !== 'any' && runtime && !model.runtimeCompatibility.includes(runtime.type)) reasons.push('MODEL_INCOMPATIBLE');
    if (['DRAINING', 'UNLOADING'].includes(i.state ?? '')) reasons.push('RESOURCE_BUSY');
    const minimum = Math.max(1, options.minimumContext ?? 0, this.deps.resources?.minimumContext ?? 4096,
      profile?.minimumContext ?? 0, profile?.runtimeMinimumContext ?? 0);
    const limit = Math.min(model.configuredContext ?? Infinity, model.contextMax || Infinity,
      profile?.maximumContext ?? Infinity, profile?.runtimeMaximumContext ?? Infinity);
    const requested = options.context;
    if ((requested !== undefined && (!Number.isSafeInteger(requested) || requested <= 0)) || !Number.isSafeInteger(minimum)) throw new ModelLifecycleError('CONTEXT_TOO_LARGE', ['invalid context']);
    const mode = options.mode ?? (requested !== undefined ? 'EXPLICIT' : 'AUTO');
    const desired = requested ?? (mode === 'MAX_SAFE' ? limit : Math.max(minimum, this.deps.resources?.autoContext ?? 32768));
    let context = Math.min(desired, limit);
    if (!Number.isSafeInteger(context)) throw new ModelLifecycleError('CONTEXT_TOO_LARGE', ['model context limit unknown']);
    if (requested !== undefined && requested > limit && !options.fit) reasons.push('CONTEXT_TOO_LARGE');
    if (context < minimum) reasons.push('CONTEXT_BELOW_TASK_MINIMUM');
    const available = snapshot.availableMemoryBytes;
    const safetyReserve = Math.max((available ?? 0) * this.reservePercent / 100, this.minimumReserveBytes);
    const held = snapshot.activeReservations.reduce((n, r) => n + r.memoryBytes, 0);
    const usable = available === undefined ? undefined : Math.max(0, available - safetyReserve - held);
    const estimateAt = async (candidateContext: number): Promise<LoadEstimate> => {
      let e: import('@wazir/runtimes-interfaces').ModelLoadEstimate = { source: 'UNKNOWN', confidence: 'unknown' };
      if (adapter?.estimateModelLoad) {
        try { e = await adapter.estimateModelLoad(i.runtimeModelId, candidateContext); } catch { /* unknown is denied below */ }
      }
      if (e.totalMemoryBytes === undefined && profile?.weightBytes !== undefined && profile.contextBytesPerToken !== undefined && profile.runtimeOverheadBytes !== undefined) {
        e = { weightBytes: profile.weightBytes, contextBytes: profile.contextBytesPerToken * candidateContext,
          overheadBytes: profile.runtimeOverheadBytes, totalMemoryBytes: profile.weightBytes + profile.contextBytesPerToken * candidateContext + profile.runtimeOverheadBytes,
          source: 'HEURISTIC', confidence: 'low' };
      }
      const total = e.totalMemoryBytes;
      const known = total !== undefined && Number.isFinite(total) && total > 0 && e.source !== 'UNKNOWN';
      const gpuHeld = snapshot.activeReservations.reduce((n, r) => n + r.vramBytes, 0);
      const gpuUnknown = !snapshot.unifiedMemory && snapshot.totalVramBytes !== undefined && (e.vramBytes === undefined || snapshot.availableVramBytes === undefined);
      const gpuInsufficient = !snapshot.unifiedMemory && e.vramBytes !== undefined && e.vramBytes > (snapshot.availableVramBytes ?? 0) - gpuHeld;
      const unknownBound = this.policy.options.modelLifecycle?.allowUnknownEstimate
        ? this.policy.options.modelLifecycle.unknownReservationBytes : undefined;
      return { modelId, runtimeId: i.runtimeId, computerId: i.computerId!, requestedContext: requested, candidateContext,
        weightMemory: e.weightBytes, contextMemory: e.contextBytes, runtimeOverhead: e.overheadBytes,
        estimatedTotalMemory: known ? total : undefined, estimatedVram: e.vramBytes,
        reservationMemoryBytes: known ? total : Number.isFinite(unknownBound) && (unknownBound ?? 0) > 0 ? unknownBound : undefined,
        currentlyAvailableMemory: available, safetyReserve, usableMemory: usable,
        postLoadAvailableMemory: known && available !== undefined ? available - total! - held : undefined,
        estimateSource: known ? e.source : 'UNKNOWN', confidence: known ? e.confidence : 'unknown',
        classification: !known || usable === undefined || gpuUnknown ? 'UNKNOWN' : total! > usable || gpuInsufficient ? 'INSUFFICIENT' : total! > usable * 0.9 ? 'WARNING' : 'SAFE' };
    };
    let estimate = await estimateAt(context);
    let safeContext: number | undefined;
    if (estimate.classification === 'INSUFFICIENT' && context >= minimum) {
      let low = minimum, high = context, best: LoadEstimate | undefined;
      // Monotonic context-memory search, with every candidate estimated by the runtime.
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const e = await estimateAt(mid);
        if (e.classification === 'SAFE' || e.classification === 'WARNING') { best = e; low = mid + 1; }
        else high = mid - 1;
      }
      safeContext = best?.candidateContext;
      if (best && (mode !== 'EXPLICIT' || options.fit)) { estimate = best; context = best.candidateContext; }
    } else if (estimate.classification !== 'UNKNOWN') safeContext = context;
    const reuse = i.state === 'READY' && i.loaded && i.health === 'healthy' &&
      i.contextTokens !== undefined && i.contextTokens >= minimum && (requested === undefined || i.contextTokens === context);
    if (!reuse) {
      if (!adapter?.loadModel || !adapter.inspectModel || !adapter.probeModel) reasons.push('UNSUPPORTED_CAPABILITY');
      if (i.loaded) reasons.push('CONTEXT_RELOAD_REQUIRED');
      if (estimate.classification === 'INSUFFICIENT') reasons.push('INSUFFICIENT_MEMORY');
      if (estimate.classification === 'UNKNOWN') {
        if (estimate.reservationMemoryBytes === undefined || usable === undefined ||
          (!snapshot.unifiedMemory && snapshot.totalVramBytes !== undefined)) reasons.push('ESTIMATE_UNKNOWN');
        else if (estimate.reservationMemoryBytes > usable) reasons.push('INSUFFICIENT_MEMORY');
      }
    }
    const policy = this.policy.checkModelLifecycle({ operation: 'load', modelId, computerId: i.computerId!, runtimeId: i.runtimeId,
      context, memoryBytes: estimate.estimatedTotalMemory, automatic: !!options.executionId });
    if (policy.decision !== 'allow') reasons.push('POLICY_DENIED');
    const plan: ModelLoadPlan = { modelId, installationId: installation?.id ?? i.id, instanceId: i.id,
      computerId: i.computerId!, runtimeId: i.runtimeId, requestedContext: requested, configuredContextLimit: model.configuredContext,
      modelContextLimit: model.contextMax, runtimeContextLimit: profile?.runtimeMaximumContext, machineSafeContext: safeContext,
      effectiveContext: reuse ? i.contextTokens! : context, minimumContext: minimum,
      contextReason: context < desired ? (context < Math.min(desired, limit) ? 'MACHINE_RESOURCE_LIMIT' : 'CONTEXT_LIMIT') : undefined,
      resourceSnapshot: snapshot, estimate, modelsToEvict: [], reuse,
      admissionDecision: { status: reasons.length ? 'DENIED' : 'ADMITTED', reasons } };
    if (options.evict && reasons.includes('INSUFFICIENT_MEMORY')) await this.planEviction(plan, options);
    return plan;
  }

  private async planEviction(plan: ModelLoadPlan, options: ModelLoadOptions): Promise<void> {
    const candidates: Array<{ instanceId: string; reclaimBytes: number }> = [];
    for (const i of this.deps.models.instanceOn(plan.computerId)) {
      if (i.id === plan.instanceId || !i.loaded || i.pinned || i.state !== 'READY' || this.operations.has(i.id) ||
        await this.active(i).then(a => a.length > 0) || !i.residentMemoryBytes) continue;
      if (this.policy.checkModelLifecycle({ operation: 'evict', modelId: i.modelId, computerId: plan.computerId, runtimeId: i.runtimeId }).decision !== 'allow') continue;
      candidates.push({ instanceId: i.id, reclaimBytes: i.residentMemoryBytes });
    }
    const shortfall = (plan.estimate.estimatedTotalMemory ?? Infinity) - (plan.estimate.usableMemory ?? 0);
    // Prefer a single sufficient victim; otherwise largest first minimizes victim count.
    const one = candidates.filter(c => c.reclaimBytes >= shortfall).sort((a, b) => a.reclaimBytes - b.reclaimBytes)[0];
    let selected = one ? [one] : candidates.sort((a, b) => b.reclaimBytes - a.reclaimBytes);
    if (!one) { let sum = 0; selected = selected.filter(c => { if (sum >= shortfall) return false; sum += c.reclaimBytes; return true; }); }
    if (selected.reduce((n, c) => n + c.reclaimBytes, 0) < shortfall) return;
    plan.modelsToEvict = selected;
    // This is a conditional plan, not permission to allocate without fresh post-eviction admission.
    plan.admissionDecision.reasons = plan.admissionDecision.reasons.filter(r => r !== 'INSUFFICIENT_MEMORY');
    plan.admissionDecision.status = plan.admissionDecision.reasons.length ? 'DENIED' : 'ADMITTED';
  }

  async load(modelId: string, options: ModelLoadOptions = {}): Promise<ModelLoadPlan> {
    if (options.dryRun) return this.estimate(modelId, options);
    const placement = await this.estimate(modelId, options);
    const i = this.target(modelId, { computerId: placement.computerId, runtimeId: placement.runtimeId });
    const existing = this.inFlightLoads.get(i.id);
    if (existing) {
      await existing;
      return this.load(modelId, options);
    }
    if (this.operations.has(i.id)) throw new ModelLifecycleError('RESOURCE_BUSY');
    this.operations.add(i.id);
    const promise = this.performLoad(i, options);
    this.inFlightLoads.set(i.id, promise);
    try { return await promise; } finally { this.inFlightLoads.delete(i.id); this.operations.delete(i.id); }
  }

  private async performLoad(i: ModelInstance, options: ModelLoadOptions): Promise<ModelLoadPlan> {
    const modelId = i.modelId;
    const extra = { runtimeId: i.runtimeId, computerId: i.computerId, initiator: options.initiator, data: { executionId: options.executionId } };
    this.emitEvent('MODEL_LOAD_REQUESTED', modelId, extra);
    this.emitEvent('MODEL_ADMISSION_STARTED', modelId, extra);
    await this.deps.refreshResources?.(i.computerId!);
    let plan = await this.estimate(modelId, { ...options, computerId: i.computerId, runtimeId: i.runtimeId });
    this.emitEvent('MODEL_LOAD_PLAN_CREATED', modelId, { ...extra, data: { ...plan, executionId: options.executionId } });
    const deny = (reason?: string): never => {
      if (reason) plan.admissionDecision = { status: 'DENIED', reasons: [reason] };
      this.emitEvent('MODEL_ADMISSION_DENIED', modelId, { ...extra, reason: plan.admissionDecision.reasons.join(','), data: { ...plan, executionId: options.executionId } });
      throw new ModelLifecycleError('MODEL_ADMISSION_DENIED', plan.admissionDecision.reasons, plan);
    };
    if (plan.admissionDecision.status === 'DENIED') deny();
    const adapter = this.deps.adapters.get(i.runtimeId)!;
    if ((await adapter.healthCheck()).status !== 'healthy') deny('RUNTIME_UNAVAILABLE');
    if (plan.reuse) {
      await this.verify(i, plan.effectiveContext);
      return plan;
    }
    if (plan.modelsToEvict.length) {
      this.emitEvent('MODEL_EVICTION_PLANNED', modelId, { ...extra, data: { modelsToEvict: plan.modelsToEvict } });
      for (const victim of plan.modelsToEvict) {
        const v = this.list().find(i => i.id === victim.instanceId)!;
        await this.unload(v.modelId, { computerId: v.computerId, runtimeId: v.runtimeId, eviction: true });
        this.emitEvent('MODEL_EVICTED', v.modelId, { computerId: v.computerId, runtimeId: v.runtimeId });
      }
      await this.deps.refreshResources?.(i.computerId!);
      const victims = plan.modelsToEvict;
      plan = await this.estimate(modelId, { ...options, computerId: i.computerId, runtimeId: i.runtimeId, evict: false });
      plan.modelsToEvict = victims;
      if (plan.admissionDecision.status === 'DENIED') deny();
    }
    let reservation: ResourceReservation | undefined;
    const reserve = () => { reservation = this.deps.computers.reserve(i.computerId!, i.id, plan.estimate.reservationMemoryBytes!,
      plan.estimate.estimatedVram ?? 0, this.reservePercent, this.minimumReserveBytes); };
    if (this.deps.store) {
      if (!this.deps.store.update) deny('RESOURCE_RESERVATION_FAILED');
      await this.deps.store.update!<ResourceReservation[]>('computer/' + i.computerId + '/reservations', current => {
        this.deps.computers.get(i.computerId!)!.reservations = current ?? [];
        reserve();
        return this.deps.computers.get(i.computerId!)!.reservations!;
      });
    } else reserve();
    if (!reservation) deny('RESOURCE_RESERVATION_FAILED');
    plan.reservation = reservation;
    this.emitEvent('RESOURCE_RESERVATION_CREATED', modelId, { ...extra, data: { reservation } });
    this.emitEvent('MODEL_ADMISSION_GRANTED', modelId, extra);
    this.emitEvent('MODEL_CONTEXT_SELECTED', modelId, { ...extra, data: { requestedContext: plan.requestedContext, effectiveContext: plan.effectiveContext } });
    if (plan.requestedContext !== undefined && plan.effectiveContext < plan.requestedContext) {
      this.emitEvent('MODEL_CONTEXT_DOWNSHIFTED', modelId, { ...extra, reason: plan.contextReason,
        data: { requestedContext: plan.requestedContext, effectiveContext: plan.effectiveContext } });
    }
    i.desired = { state: 'READY', contextTokens: plan.effectiveContext };
    try { await this.persistIntent(i); } catch (e) { await this.finishReservation(i, reservation!.id, true); throw e; }
    this.deps.models.setInstanceState(i.id, 'LOADING');
    this.emitEvent('MODEL_LOADING', modelId, extra);
    let attempted = false;
    try {
      attempted = true;
      await adapter.loadModel!(i.runtimeModelId, { contextTokens: plan.effectiveContext });
      const observed = await adapter.inspectModel!(i.runtimeModelId);
      this.deps.models.setInstanceHealth(i.id, { loaded: observed.loaded, state: observed.loaded ? 'LOADED' : 'UNLOADED', contextTokens: observed.effectiveContext });
      this.emitEvent('MODEL_LOADED', modelId, extra);
      await this.verify(i, plan.effectiveContext);
      const current = this.list().find(x => x.id === i.id)!;
      this.deps.models.upsertInstance({ ...current, residentMemoryBytes: observed.memoryBytes ?? plan.estimate.estimatedTotalMemory });
      await this.finishReservation(i, reservation!.id, false);
      await this.deps.refreshResources?.(i.computerId!);
      this.emitEvent('MODEL_READY', modelId, extra);
      await this.persistReadyModelSet();
      return plan;
    } catch (error) {
      this.deps.models.setInstanceState(i.id, 'FAILED', { health: 'degraded', error: error instanceof Error ? error.message : String(error) });
      this.emitEvent('MODEL_LOAD_FAILED', modelId, { ...extra, reason: error instanceof ModelLifecycleError ? error.code : 'RUNTIME_LOAD_FAILED' });
      // A timeout may have allocated memory. Keep the reservation until runtime inspection proves absence.
      const observed = attempted ? await adapter.inspectModel?.(i.runtimeModelId).catch(() => undefined) : undefined;
      if (!attempted || observed?.loaded === false) await this.finishReservation(i, reservation!.id, true);
      else if (observed?.loaded) await this.finishReservation(i, reservation!.id, false);
      throw error instanceof ModelLifecycleError ? error : new ModelLifecycleError('RUNTIME_LOAD_FAILED');
    }
  }

  private async finishReservation(i: ModelInstance, reservationId: string, release: boolean): Promise<void> {
    const mutate = (current: ResourceReservation[] = []) => current.flatMap(r => r.id !== reservationId ? [r] : release ? [] : [{ ...r, settledAt: new Date() }]);
    const c = this.deps.computers.get(i.computerId!)!;
    c.reservations = this.deps.store?.update
      ? await this.deps.store.update<ResourceReservation[]>('computer/' + i.computerId + '/reservations', mutate)
      : mutate(c.reservations);
    if (release) this.emitEvent('RESOURCE_RESERVATION_RELEASED', i.modelId, { computerId: i.computerId, runtimeId: i.runtimeId, data: { reservationId } });
  }

  private async verify(i: ModelInstance, context: number): Promise<void> {
    const adapter = this.deps.adapters.get(i.runtimeId);
    const observed = await adapter?.inspectModel?.(i.runtimeModelId);
    if (!observed?.loaded || observed.effectiveContext !== context || !await adapter?.probeModel?.(i.runtimeModelId, context)) {
      this.deps.models.setInstanceHealth(i.id, { loaded: observed?.loaded ?? false, state: 'FAILED', health: 'degraded', contextTokens: observed?.effectiveContext });
      throw new ModelLifecycleError('MODEL_READINESS_FAILED');
    }
    this.deps.models.setInstanceHealth(i.id, { loaded: true, state: 'READY', health: 'healthy', contextTokens: context });
  }

  async activateExecution(executionId: string, minimumContext: number): Promise<number> {
    const executions = this.deps.executions;
    if (!executions) throw new ModelLifecycleError('EXECUTION_NOT_FOUND');
    const record = executions.require(executionId);
    const e = record.execution;
    if (!e.computerId || this.deps.runtimes.get(e.runtimeId)?.runtimeKind === 'hosted') return minimumContext;
    await executions.setStatus(executionId, 'waiting');
    await executions.recordEvent(executionId, 'WAITING_FOR_MODEL', { modelId: e.modelId, taskId: e.taskId });
    try {
      const plan = await this.ensureReady(e.modelId, { computerId: e.computerId, runtimeId: e.runtimeId, minimumContext, executionId });
      await executions.setStatus(executionId, 'scheduled');
      return plan.effectiveContext;
    } catch (err) {
      await executions.recordError(executionId, err instanceof Error ? err.message : String(err));
      await executions.setStatus(executionId, 'failed');
      throw err;
    }
  }

  async ensureReady(modelId: string, options: ModelLoadOptions = {}): Promise<ModelLoadPlan> {
    this.emitEvent('WAITING_FOR_MODEL', modelId, { data: { executionId: options.executionId } });
    return this.load(modelId, options);
  }
  /** Compatibility wrapper for existing interactive callers. Structured callers use load(). */
  async loadModel(modelId: string, options: ModelLoadOptions = {}): Promise<boolean> {
    try { await this.load(modelId, options); return true; }
    catch (e) {
      const i = this.deps.models.instancesOf(modelId).find(i => !options.runtimeId || i.runtimeId === options.runtimeId);
      if (i) i.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /**
   * Loads all recommended models.
   */
  async loadRecommendedModels(options: { initiator?: string } = {}): Promise<Map<string, boolean>> {
    const recommended = this.getRecommendedModels();
    const results = new Map<string, boolean>();

    for (const rec of recommended) {
      const ok = await this.loadModel(rec.model.id, options);
      results.set(rec.model.id, ok);
    }

    return results;
  }

  /**
   * Loads all eligible installed generative models.
   */
  async loadAllEligibleModels(options: { initiator?: string } = {}): Promise<Map<string, boolean>> {
    const eligible = this.getEligibleModels();
    const results = new Map<string, boolean>();

    for (const model of eligible) {
      const ok = await this.loadModel(model.id, options);
      results.set(model.id, ok);
    }

    return results;
  }

  /**
   * Unloads a model from its host runtime.
   */
  async unload(modelId: string, options: ModelLoadOptions & { drain?: boolean; eviction?: boolean } = {}): Promise<void> {
    const i = this.target(modelId, options);
    if (this.operations.has(i.id)) throw new ModelLifecycleError('RESOURCE_BUSY');
    if (options.eviction && i.pinned) throw new ModelLifecycleError('MODEL_IN_USE', ['PINNED']);
    const decision = this.policy.checkModelLifecycle({ operation: options.eviction ? 'evict' : 'unload', modelId, computerId: i.computerId!, runtimeId: i.runtimeId });
    if (decision.decision !== 'allow') throw new ModelLifecycleError('POLICY_DENIED', decision.reasons);
    const adapter = this.deps.adapters.get(i.runtimeId);
    if (!adapter?.unloadModel || !adapter.inspectModel) throw new ModelLifecycleError('UNSUPPORTED_CAPABILITY');
    this.operations.add(i.id);
    try {
      const active = await this.active(i);
      if (active.length && !options.drain) throw new ModelLifecycleError('MODEL_IN_USE', active);
      this.emitEvent('MODEL_UNLOAD_REQUESTED', modelId, { computerId: i.computerId, runtimeId: i.runtimeId });
      if (options.drain) {
        this.deps.models.setInstanceState(i.id, 'DRAINING');
        this.emitEvent('MODEL_DRAINING', modelId, { data: { activeExecutions: active } });
        const deadline = Date.now() + (options.timeoutMs ?? 300_000);
        while ((await this.active(i)).length) {
          if (Date.now() >= deadline) throw new ModelLifecycleError('MODEL_IN_USE', ['DRAIN_TIMEOUT']);
          await new Promise(r => setTimeout(r, 50));
        }
      }
      // Publish the assignment barrier before the last active-use check.
      this.deps.models.setInstanceState(i.id, 'UNLOADING');
      if ((await this.active(i)).length) throw new ModelLifecycleError('MODEL_IN_USE');
      i.desired = { state: 'UNLOADED' };
      await this.persistIntent(i);
      this.emitEvent('MODEL_UNLOADING', modelId, { computerId: i.computerId, runtimeId: i.runtimeId });
      await adapter.unloadModel(i.runtimeModelId);
      if ((await adapter.inspectModel(i.runtimeModelId)).loaded) throw new ModelLifecycleError('RUNTIME_UNLOAD_FAILED');
      this.deps.models.setInstanceHealth(i.id, { loaded: false, state: 'UNLOADED' });
      for (const r of this.deps.computers.resourceSnapshot(i.computerId!).activeReservations) {
        if (r.instanceId === i.id) {
          await this.finishReservation(i, r.id, true);
          this.emitEvent('RESOURCE_RESERVATION_RELEASED', modelId, { data: { reservationId: r.id } });
        }
      }
      this.emitEvent('MODEL_UNLOADED', modelId, { computerId: i.computerId, runtimeId: i.runtimeId });
      await this.persistReadyModelSet();
    } catch (e) {
      if (!(e instanceof ModelLifecycleError)) {
        this.deps.models.setInstanceState(i.id, 'FAILED', { health: 'degraded' });
        throw new ModelLifecycleError('RUNTIME_UNLOAD_FAILED');
      }
      throw e;
    } finally { this.operations.delete(i.id); }
  }
  async unloadModel(modelId: string, options: ModelLoadOptions & { drain?: boolean } = {}): Promise<boolean> {
    try { await this.unload(modelId, options); return true; } catch { return false; }
  }
  async reload(modelId: string, options: ModelLoadOptions = {}) { await this.unload(modelId, options); return this.load(modelId, options); }
  async drain(modelId: string, options: ModelLoadOptions = {}) { return this.unload(modelId, { ...options, drain: true }); }
  async pin(modelId: string, options: ModelLoadOptions = {}) {
    const i = this.target(modelId, options); i.pinned = true; await this.persistIntent(i);
  }
  async unpin(modelId: string, options: ModelLoadOptions = {}) {
    const i = this.target(modelId, options); i.pinned = false; await this.persistIntent(i);
  }
  private async persistIntent(i: ModelInstance): Promise<void> {
    await this.deps.store?.put('models/intent/' + i.id, { desired: i.desired, pinned: i.pinned });
    const current = this.list().find(x => x.id === i.id);
    if (current) this.deps.models.upsertInstance({ ...current, desired: i.desired, pinned: i.pinned });
  }

  async applyStartupPolicy(config: { mode?: 'none' | 'restore' | 'recommended' | 'explicit' | 'prompt'; models?: Array<{ modelId: string; computerId?: string; runtimeId?: string; context?: number }> } = {}): Promise<RestoreResult> {
    if (!config.mode || config.mode === 'none' || config.mode === 'prompt') return { restored: [], failed: [], missing: [] };
    if (config.mode === 'restore') return this.restoreLastModelSet({ initiator: 'startup' });
    const targets = config.mode === 'explicit' ? config.models ?? [] : this.getRecommendedModels().map(r => ({ modelId: r.model.id }));
    const result: RestoreResult = { restored: [], failed: [], missing: [] };
    for (const target of targets) {
      try { await this.load(target.modelId, { ...target, initiator: 'startup' }); result.restored.push(target.modelId); }
      catch { result.failed.push(target.modelId); }
    }
    return result;
  }

  /**
   * Restores the last known set of READY models from persistent store.
   */
  async restoreLastModelSet(options: { initiator?: string } = {}): Promise<RestoreResult> {
    this.emitEvent('MODEL_RESTORE_STARTED', 'all', { initiator: options.initiator });

    const desired = this.list().filter(i => i.desired?.state === 'READY');
    if (desired.length) {
      const result: RestoreResult = { restored: [], failed: [], missing: [] };
      for (const instance of desired) {
        try {
          await this.load(instance.modelId, { ...options, computerId: instance.computerId,
            runtimeId: instance.runtimeId, context: instance.desired?.contextTokens });
          result.restored.push(instance.id);
        } catch { result.failed.push(instance.id); }
      }
      return result;
    }
    let modelIds: string[] = [];
    if (this.deps.store) {
      try {
        const stored = await this.deps.store.get(LAST_READY_MODELS_KEY);
        if (Array.isArray(stored)) {
          modelIds = stored.filter((id) => typeof id === 'string');
        }
      } catch {
        // store unavailable
      }
    }

    const result: RestoreResult = { restored: [], failed: [], missing: [] };

    for (const id of modelIds) {
      const record = this.deps.models.get(id);
      if (!record || this.deps.models.instancesOf(id).length === 0) {
        result.missing.push(id);
        continue;
      }

      const ok = await this.loadModel(id, options);
      if (ok) {
        result.restored.push(id);
      } else {
        result.failed.push(id);
      }
    }

    this.emitEvent('MODEL_RESTORE_COMPLETED', 'all', {
      reason: `Restored ${result.restored.length}, failed ${result.failed.length}, missing ${result.missing.length}`,
    });

    return result;
  }

  /**
   * Persists the IDs of all currently READY models.
   */
  async persistReadyModelSet(): Promise<void> {
    if (!this.deps.store) return;
    const readyIds = this.deps.models.listReady().map((m) => m.id);
    await this.deps.store.put(LAST_READY_MODELS_KEY, readyIds);
  }

  /**
   * Discovers and reconciles all models across all registered runtime adapters.
   */
  async discoverAndReconcile(options: { verify?: boolean } = {}): Promise<DiscoveredModelReconciliation> {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.reconcileObserved(options.verify !== false);
    try { return await this.reconciliation; } finally { this.reconciliation = undefined; }
  }
  discover() { return this.discoverAndReconcile(); }
  reconcile() { return this.discoverAndReconcile(); }
  startReconciliation(intervalMs = 30_000): () => void {
    const timer = setInterval(() => { void this.reconcile().catch(() => undefined); }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
  private async reconcileObserved(verify = true): Promise<DiscoveredModelReconciliation> {
    let totalDiscovered = 0, newlyRegistered = 0;
    for (const [runtimeId, adapter] of this.deps.adapters) {
      const runtime = this.deps.runtimes.get(runtimeId);
      if (!runtime?.computerId || runtime.runtimeKind === 'hosted') continue;
      const computerId = runtime.computerId;
      try {
        if ((await adapter.healthCheck()).status !== 'healthy') throw new Error('RUNTIME_UNAVAILABLE');
        this.deps.runtimes.update(runtimeId, { health: 'healthy' });
        const discovered = await adapter.listModels();
        totalDiscovered += discovered.length;
        const seen = new Set<string>();
        for (const m of discovered) {
          seen.add(m.id);
          if (!this.deps.models.get(m.id)) {
            newlyRegistered++;
            this.deps.models.register({ id: m.id, name: m.name ?? m.id, provider: runtimeId, family: 'other',
              contextMax: m.contextWindow ?? 0, parameters: m.parameters, quantization: m.quantization,
              capabilities: ['generalChat'], toolCalling: m.toolCalling ?? false, structuredOutput: m.structuredOutput ?? false,
              vision: m.vision ?? false, audio: m.audio ?? false, embedding: m.embedding ?? false, reasoning: m.reasoning ?? false,
              runtimeCompatibility: [runtime.type], local: true, createdAt: new Date(), updatedAt: new Date() });
          }
          const existing = this.deps.models.instancesOf(m.id).find(i => i.computerId === computerId && i.runtimeId === runtimeId);
          const installationId = existing?.installationId ?? `${m.id}::${computerId}::${runtimeId}`;
          const previousInstallation = this.deps.models.getInstallation(installationId);
          this.deps.models.upsertInstallation({ id: installationId, modelId: m.id, computerId, runtimeId,
            runtimeModelId: m.id, installed: true, observedAt: new Date(),
            profile: { ...previousInstallation?.profile, modelId: m.id, runtimeId, weightBytes: m.weightBytes,
              maximumContext: m.contextWindow, quantization: m.quantization, metadata: previousInstallation?.profile?.metadata ?? {} } });
          if (existing && this.operations.has(existing.id)) continue;
          const id = existing?.id ?? installationId;
          const intent = await this.deps.store?.get('models/intent/' + id) as { desired?: ModelInstance['desired']; pinned?: boolean } | undefined;
          const observed = await adapter.inspectModel?.(m.id);
          const loaded = observed?.loaded ?? false;
          const i: ModelInstance = { ...existing, ...intent, id, installationId, modelId: m.id, runtimeModelId: m.id,
            computerId, runtimeId, loaded, state: loaded ? 'LOADED' : existing?.loaded || existing?.state === 'READY' ? 'UNLOADED' : 'INSTALLED',
            health: 'healthy', contextTokens: observed?.effectiveContext, residentMemoryBytes: observed?.memoryBytes ?? existing?.residentMemoryBytes };
          this.deps.models.upsertInstance(i);
          if (verify && loaded && observed?.effectiveContext && existing?.state !== 'DRAINING' &&
            (!i.desired?.contextTokens || i.desired.contextTokens === observed.effectiveContext)) {
            try { await this.verify(i, observed.effectiveContext); } catch { /* failure is observed, never READY */ }
          }
          if (existing?.state === 'DRAINING' && loaded) this.deps.models.setInstanceState(id, 'DRAINING');
          this.emitEvent(existing ? 'MODEL_RECONCILED' : 'MODEL_DISCOVERED', m.id, { runtimeId, computerId });
        }
        for (const i of this.deps.models.instancesForRuntime(runtimeId)) {
          if (!seen.has(i.runtimeModelId) && !this.operations.has(i.id)) {
            this.deps.models.setInstanceHealth(i.id, { loaded: false, state: 'UNAVAILABLE', health: 'unavailable' });
            const installation = this.deps.models.getInstallation(i.installationId ?? i.id);
            if (installation) this.deps.models.upsertInstallation({ ...installation, installed: false, observedAt: new Date() });
          }
        }
      } catch {
        this.deps.runtimes.update(runtimeId, { health: 'unavailable' });
        for (const i of this.deps.models.instancesForRuntime(runtimeId)) {
          if (!this.operations.has(i.id)) this.deps.models.setInstanceState(i.id, 'UNAVAILABLE', { health: 'unavailable' });
        }
      }
    }
    return { totalDiscovered, newlyRegistered };
  }
}
export interface DiscoveredModelReconciliation { totalDiscovered: number; newlyRegistered: number; }
