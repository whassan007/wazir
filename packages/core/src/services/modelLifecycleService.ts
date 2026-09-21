import os from 'node:os';
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
  private inFlightLoads = new Map<string, Promise<boolean>>();
  private listeners = new Set<(event: ModelLifecycleEvent) => void>();

  constructor(private readonly deps: ModelLifecycleServiceDeps) {}

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
        (i) => (i.loaded || i.state === 'READY') && i.health === 'healthy' && i.state !== 'FAILED' && i.state !== 'UNAVAILABLE',
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
  assessModelSync(modelId: string, targetComputerId: string = 'local'): ResourceAssessment {
    const computer = this.deps.computers.get(targetComputerId);
    let totalRAMGB = computer?.hardware?.memoryGB;
    let freeRAMGB: number | undefined;

    if (!totalRAMGB) {
      totalRAMGB = Math.round(os.totalmem() / (1024 ** 3));
      freeRAMGB = Math.round(os.freemem() / (1024 ** 3));
    } else {
      freeRAMGB = Math.round(totalRAMGB * 0.6);
    }

    const record = this.deps.models.get(modelId);
    let estimatedGB = 0;
    if (record) {
      const est = estimateModelMemory(record.parameters, record.id, record.quantization);
      estimatedGB = est.minSystemGB;
    }
    if (!estimatedGB) {
      estimatedGB = 8;
    }

    let classification: ResourceAssessment['classification'] = 'UNKNOWN';
    let message = '';

    if (freeRAMGB !== undefined && freeRAMGB > 0) {
      if (estimatedGB <= freeRAMGB * 0.75) {
        classification = 'SAFE';
        message = `Safe to load: ~${estimatedGB}GB required, ${freeRAMGB}GB available`;
      } else if (estimatedGB <= freeRAMGB) {
        classification = 'WARNING';
        message = `Tight memory bounds: ~${estimatedGB}GB required, ${freeRAMGB}GB available`;
      } else {
        classification = 'INSUFFICIENT';
        message = `Insufficient free memory: ~${estimatedGB}GB required, only ${freeRAMGB}GB available`;
      }
    } else {
      classification = 'UNKNOWN';
      message = 'Resource estimate unavailable';
    }

    return {
      modelId,
      estimatedMemoryGB: estimatedGB,
      availableMemoryGB: freeRAMGB,
      totalMemoryGB: totalRAMGB,
      classification,
      message,
    };
  }

  /**
   * Assesses resource feasibility before loading one or more models.
   */
  async assessResources(modelIds: string | string[], targetComputerId: string = 'local'): Promise<ResourceAssessment[]> {
    const ids = Array.isArray(modelIds) ? modelIds : [modelIds];
    const computer = this.deps.computers.get(targetComputerId);
    let totalRAMGB = computer?.hardware?.memoryGB;
    let freeRAMGB: number | undefined;

    if (!totalRAMGB) {
      totalRAMGB = Math.round(os.totalmem() / (1024 ** 3));
      freeRAMGB = Math.round(os.freemem() / (1024 ** 3));
    } else {
      freeRAMGB = Math.round(totalRAMGB * 0.6); // Reasonable assumption if exact freemem is unprobed
    }

    const results: ResourceAssessment[] = [];

    for (const modelId of ids) {
      const record = this.deps.models.get(modelId);
      const instance = this.deps.models.instancesOf(modelId)[0];
      const adapter = instance ? this.deps.adapters.get(instance.runtimeId) : undefined;

      let estimatedGB = 0;
      if (adapter?.estimateResources) {
        try {
          const est = await adapter.estimateResources(modelId);
          if (est.minMemoryGB) estimatedGB = est.minMemoryGB;
        } catch {
          // fallback
        }
      }

      if (!estimatedGB && record) {
        const est = estimateModelMemory(record.parameters, record.id, record.quantization);
        estimatedGB = est.minSystemGB;
      }

      if (!estimatedGB) {
        estimatedGB = 8; // default fallback
      }

      let classification: ResourceAssessment['classification'] = 'UNKNOWN';
      let message = '';

      if (freeRAMGB !== undefined && freeRAMGB > 0) {
        if (estimatedGB <= freeRAMGB * 0.75) {
          classification = 'SAFE';
          message = `Safe to load: ~${estimatedGB}GB required, ${freeRAMGB}GB available`;
        } else if (estimatedGB <= freeRAMGB) {
          classification = 'WARNING';
          message = `High memory usage: ~${estimatedGB}GB required of ${freeRAMGB}GB available`;
        } else {
          classification = 'INSUFFICIENT';
          message = `Insufficient memory: requires ~${estimatedGB}GB, only ${freeRAMGB}GB available`;
        }
      } else {
        classification = 'UNKNOWN';
        message = 'Resource estimate unavailable';
      }

      results.push({
        modelId,
        estimatedMemoryGB: estimatedGB,
        availableMemoryGB: freeRAMGB,
        totalMemoryGB: totalRAMGB,
        classification,
        message,
      });
    }

    return results;
  }

  /**
   * Loads a specific model into its target runtime.
   * Idempotent & concurrency-safe: duplicate concurrent calls return the same in-flight Promise.
   */
  async loadModel(
    modelId: string,
    options: { initiator?: string; timeoutMs?: number } = {},
  ): Promise<boolean> {
    // 1. Return immediately if already READY
    if (this.deps.models.isModelReady(modelId)) {
      return true;
    }

    // 2. Attach to existing in-flight load if one is already running
    const existing = this.inFlightLoads.get(modelId);
    if (existing) {
      return existing;
    }

    const loadPromise = (async () => {
      const instances = this.deps.models.instancesOf(modelId);
      if (instances.length === 0) {
        this.emitEvent('MODEL_LOAD_FAILED', modelId, {
          error: `No instance of model '${modelId}' found on any runtime`,
          initiator: options.initiator,
        });
        return false;
      }

      const instance = instances[0];
      const adapter = this.deps.adapters.get(instance.runtimeId);
      const computerId = instance.computerId;
      const runtimeId = instance.runtimeId;

      this.emitEvent('MODEL_LOAD_REQUESTED', modelId, {
        runtimeId,
        computerId,
        initiator: options.initiator,
      });

      // Update state to LOADING
      this.deps.models.setInstanceState(instance.id, 'LOADING');
      this.emitEvent('MODEL_LOADING', modelId, { runtimeId, computerId });

      try {
        if (adapter && typeof adapter.loadModel === 'function') {
          await adapter.loadModel(instance.runtimeModelId || modelId);
        }

        // Verification step: verify runtime reports it as loaded
        let verified = false;
        const maxWait = options.timeoutMs ?? 15_000;
        const start = Date.now();

        while (Date.now() - start < maxWait) {
          if (adapter && typeof adapter.getLoadedModels === 'function') {
            const loadedList = await adapter.getLoadedModels().catch(() => []);
            const isResident =
              loadedList.includes(modelId) ||
              loadedList.includes(instance.runtimeModelId) ||
              loadedList.some((id) => id.startsWith(modelId) || modelId.startsWith(id));

            if (isResident) {
              verified = true;
              break;
            }
          } else {
            // If adapter doesn't support getLoadedModels, assume loadModel succeeded
            verified = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        if (!verified) {
          throw new Error(`Runtime accepted load request, but model '${modelId}' was not detected as resident within ${maxWait}ms`);
        }

        // Successfully loaded & verified
        this.deps.models.setInstanceHealth(instance.id, {
          loaded: true,
          state: 'READY',
          health: 'healthy',
        });

        this.emitEvent('MODEL_READY', modelId, { runtimeId, computerId });
        await this.persistReadyModelSet().catch(() => {});
        return true;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.deps.models.setInstanceState(instance.id, 'FAILED', {
          error: errorMsg,
          health: 'degraded',
        });
        this.emitEvent('MODEL_LOAD_FAILED', modelId, {
          runtimeId,
          computerId,
          error: errorMsg,
        });
        return false;
      }
    })();

    this.inFlightLoads.set(modelId, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.inFlightLoads.delete(modelId);
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
  async unloadModel(modelId: string, options: { initiator?: string } = {}): Promise<boolean> {
    const instances = this.deps.models.instancesOf(modelId);
    if (instances.length === 0) return true;

    const instance = instances[0];
    const adapter = this.deps.adapters.get(instance.runtimeId);

    this.emitEvent('MODEL_UNLOAD_REQUESTED', modelId, {
      runtimeId: instance.runtimeId,
      computerId: instance.computerId,
      initiator: options.initiator,
    });

    this.deps.models.setInstanceState(instance.id, 'UNLOADING');

    try {
      if (adapter && typeof adapter.unloadModel === 'function') {
        await adapter.unloadModel(instance.runtimeModelId || modelId);
      }
      this.deps.models.setInstanceHealth(instance.id, {
        loaded: false,
        state: 'INSTALLED',
      });
      this.emitEvent('MODEL_UNLOADED', modelId, {
        runtimeId: instance.runtimeId,
        computerId: instance.computerId,
      });
      await this.persistReadyModelSet().catch(() => {});
      return true;
    } catch (err: any) {
      this.deps.models.setInstanceState(instance.id, 'FAILED', {
        error: err.message,
      });
      return false;
    }
  }

  /**
   * Restores the last known set of READY models from persistent store.
   */
  async restoreLastModelSet(options: { initiator?: string } = {}): Promise<RestoreResult> {
    this.emitEvent('MODEL_RESTORE_STARTED', 'all', { initiator: options.initiator });

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
  async discoverAndReconcile(): Promise<DiscoveredModelReconciliation> {
    let totalDiscovered = 0;
    let newlyRegistered = 0;
    const loadedSets = new Map<string, Set<string>>();

    for (const [runtimeId, adapter] of this.deps.adapters.entries()) {
      try {
        if (typeof adapter.getLoadedModels === 'function') {
          const loaded = await adapter.getLoadedModels().catch(() => []);
          loadedSets.set(runtimeId, new Set(loaded));
        }
      } catch {
        // best effort
      }

      try {
        const models = await adapter.listModels();
        totalDiscovered += models.length;

        const loadedModelIds = loadedSets.get(runtimeId) ?? new Set();

        for (const m of models) {
          const existing = this.deps.models.get(m.id);
          if (!existing) newlyRegistered++;

          const hasLoadedApi = typeof adapter?.getLoadedModels === 'function';
          const isLoaded = hasLoadedApi
            ? loadedModelIds.has(m.id) ||
              (m.name ? loadedModelIds.has(m.name) : false) ||
              Array.from(loadedModelIds).some((id) => id.startsWith(m.id) || m.id.startsWith(id))
            : existing
              ? (this.deps.models.instancesOf(m.id)[0]?.loaded ?? true)
              : true;

          const computerId = process.env.WAZIR_COMPUTER_ID ?? 'local';
          const instanceId = `${m.id}::${computerId}::${runtimeId}`;

          this.deps.models.upsertInstance({
            id: instanceId,
            modelId: m.id,
            computerId,
            runtimeId,
            runtimeModelId: m.id,
            loaded: isLoaded,
            state: isLoaded ? 'READY' : 'INSTALLED',
            health: 'healthy',
            contextTokens: m.contextWindow ?? 32_768,
          });

          this.emitEvent('MODEL_DISCOVERED', m.id, { runtimeId, computerId });
        }
      } catch {
        // runtime might be temporarily unreachable
      }
    }

    return { totalDiscovered, newlyRegistered };
  }
}

export interface DiscoveredModelReconciliation {
  totalDiscovered: number;
  newlyRegistered: number;
}
