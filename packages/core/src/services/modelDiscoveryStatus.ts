import type { ModelRegistry } from './modelRegistry.js';
import type { RuntimeRegistry } from './runtimeRegistry.js';
import type { ComputerRegistry } from './computerRegistry.js';
import { estimateModelMemory } from '../types/model.js';

export type ModelStatusCategory = 'REGISTERED' | 'AVAILABLE' | 'LOADED' | 'ACTIVE';

export interface ModelDiscoveryEntry {
  modelId: string;
  name: string;
  provider: string;
  local: boolean;
  registered: boolean;
  available: boolean;
  loaded: boolean;
  active: boolean;
  stale: boolean;
  staleReason?: string;
  contextMax: number;
  estimatedMemoryGB: number;
  runtimeIds: string[];
  computerIds: string[];
  statusSummary: string;
}

export interface StructuredModelFleetStatus {
  registeredCount: number;
  availableCount: number;
  loadedCount: number;
  activeCount: number;
  hostedAvailableCount: number;
  staleCount: number;
  entries: ModelDiscoveryEntry[];
  startupBannerCounts: {
    registered: number;
    available: number;
    loaded: number;
    active: number;
  };
}

export interface ModelDiscoveryStatusDeps {
  models: ModelRegistry;
  runtimes: RuntimeRegistry;
  computers: ComputerRegistry;
  activeModelIds?: () => Iterable<string>;
}

export class ModelDiscoveryStatusService {
  constructor(private readonly deps: ModelDiscoveryStatusDeps) {}

  getFleetStatus(): StructuredModelFleetStatus {
    const allModels = this.deps.models.list();
    const activeSet = new Set<string>();
    if (this.deps.activeModelIds) {
      for (const id of this.deps.activeModelIds()) {
        activeSet.add(id);
      }
    }

    let registeredCount = 0;
    let availableCount = 0;
    let loadedCount = 0;
    let activeCount = 0;
    let hostedAvailableCount = 0;
    let staleCount = 0;

    const entries: ModelDiscoveryEntry[] = [];

    for (const model of allModels) {
      registeredCount++;
      const instances = this.deps.models.instancesOf(model.id);
      const isLocal = model.local !== false;
      const isHosted = !isLocal || model.provider === 'hosted' || model.provider === 'nvidia' || instances.some(i => !i.computerId);

      let available = false;
      let loaded = false;
      let stale = false;
      let staleReason: string | undefined;

      const runtimeIdsSet = new Set<string>();
      const computerIdsSet = new Set<string>();

      if (isHosted) {
        available = true;
        hostedAvailableCount++;
        availableCount++;
      } else {
        if (instances.length === 0) {
          available = false;
        } else {
          for (const inst of instances) {
            if (inst.runtimeId) runtimeIdsSet.add(inst.runtimeId);
            if (inst.computerId) computerIdsSet.add(inst.computerId);

            const runtime = this.deps.runtimes.get(inst.runtimeId);
            const computer = inst.computerId ? this.deps.computers.get(inst.computerId) : undefined;

            if (inst.health === 'unavailable' || inst.state === 'UNAVAILABLE' || inst.state === 'FAILED') {
              stale = true;
              staleReason = staleReason ?? `Instance ${inst.id} is ${inst.state}/${inst.health}`;
            }
            if (runtime && runtime.health === 'unavailable') {
              stale = true;
              staleReason = staleReason ?? `Runtime ${runtime.id} is unavailable`;
            }
            if (inst.computerId && (!computer || computer.status !== 'online')) {
              stale = true;
              staleReason = staleReason ?? `Computer ${inst.computerId} is offline`;
            }

            const isRuntimeHealthy = !runtime || runtime.health !== 'unavailable';
            const isComputerHealthy = !inst.computerId || (computer && computer.status === 'online');

            if (isRuntimeHealthy && isComputerHealthy && inst.health !== 'unavailable' && inst.state !== 'UNAVAILABLE') {
              available = true;
            }

            // STRICT INVARIANT: ONLY local runtime models confirmed resident in local RAM/VRAM with loaded === true && Boolean(computerId) && health === 'healthy'
            if (
              inst.loaded === true &&
              Boolean(inst.computerId) &&
              inst.health === 'healthy' &&
              isRuntimeHealthy &&
              isComputerHealthy
            ) {
              loaded = true;
            }
          }
          if (available) availableCount++;
        }
      }

      if (loaded) {
        loadedCount++;
      }

      const active = activeSet.has(model.id) || instances.some(i => activeSet.has(i.id));
      if (active) {
        activeCount++;
      }

      if (stale) {
        staleCount++;
      }

      const estMem = estimateModelMemory(model.parameters, model.id, model.quantization);
      const estGB = model.memory?.minSystemGB ?? model.memory?.minGpuGB ?? estMem.minSystemGB ?? 4;

      const statusSummary = `registered=${registeredCount} available=${available} loaded=${loaded} active=${active}`;

      entries.push({
        modelId: model.id,
        name: model.name || model.id,
        provider: model.provider || 'unknown',
        local: !isHosted,
        registered: true,
        available,
        loaded,
        active,
        stale,
        staleReason,
        contextMax: (model as unknown as { contextWindow?: number }).contextWindow ?? model.contextMax ?? 8192,
        estimatedMemoryGB: Number(estGB.toFixed(2)),
        runtimeIds: Array.from(runtimeIdsSet),
        computerIds: Array.from(computerIdsSet),
        statusSummary,
      });
    }

    return {
      registeredCount,
      availableCount,
      loadedCount,
      activeCount,
      hostedAvailableCount,
      staleCount,
      entries,
      startupBannerCounts: {
        registered: registeredCount,
        available: availableCount,
        loaded: loadedCount,
        active: activeCount,
      },
    };
  }

  detectStaleEntries(): ModelDiscoveryEntry[] {
    const status = this.getFleetStatus();
    return status.entries.filter(e => e.stale);
  }

  pruneStaleInstances(): string[] {
    const staleEntries = this.detectStaleEntries();
    const pruned: string[] = [];
    for (const entry of staleEntries) {
      const instances = this.deps.models.instancesOf(entry.modelId);
      for (const inst of instances) {
        if (!inst.loaded) {
          pruned.push(inst.id);
        }
      }
    }
    return pruned;
  }

  formatStartupSummary(selectedMode: string, reasoningEffort: string): string {
    const fleet = this.getFleetStatus();
    const reg = fleet.startupBannerCounts.registered;
    const avail = fleet.startupBannerCounts.available;
    const loaded = fleet.startupBannerCounts.loaded;

    return `WAZIR
Autonomous coding assistant

Ready · Auto routing

Models: ${reg} registered
        ${avail} available
        ${loaded} loaded

Selected: ${selectedMode}
Reasoning: ${reasoningEffort}

Enter to send · /model · /help · /exit`;
  }
}
