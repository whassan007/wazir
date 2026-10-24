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

export interface LocalRuntimeSummary {
  runtimeId: string;
  type: string;
  health: 'healthy' | 'degraded' | 'unavailable';
  endpoint?: string;
  loadedCount: number;
  installedCount: number;
}

export interface LocalDiscoveredModel {
  modelId: string;
  name: string;
  provider: string;
  runtimeType: string;
  endpoint?: string;
  status: 'loaded' | 'installed' | 'unavailable';
  readinessLabel: 'Ready' | 'Can load' | 'Insufficient memory' | 'Runtime offline';
  loaded: boolean;
  installed: boolean;
  available: boolean;
  eligible: boolean;
  ineligibleReason?: string;
  memoryRequiredGB: number;
  contextMax: number;
  deviceLabel: string;
}

export interface LocalDiscoverySnapshot {
  deviceLabel: string;
  usableMemoryGB: number;
  totalMemoryGB: number;
  runtimeSummaryLabel: string;
  runtimes: LocalRuntimeSummary[];
  models: LocalDiscoveredModel[];
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

  discoverLocalModels(options?: { hardwareEligibility?: any; contextEstimator?: any }): LocalDiscoverySnapshot {
    const computers = this.deps.computers.list();
    const localComputer = computers.find(c => c.local === true) ?? computers[0];

    let deviceLabel = 'Apple Silicon (Unified Memory)';
    let totalMemoryGB = 32;
    let usableMemoryGB = 24;

    if (localComputer) {
      const hw = localComputer.hardware;
      const mem = hw?.memoryGB ?? 32;
      totalMemoryGB = mem;
      const gpuName = hw?.gpu?.model;
      const cpuName = hw?.cpu ?? (hw?.cpuCores ? `${hw.cpuCores}-core CPU` : undefined);
      const parts = [gpuName, cpuName, `${mem}GB Unified`].filter(Boolean);
      if (parts.length > 0) {
        deviceLabel = parts.join(' - ');
      } else if (localComputer.name) {
        deviceLabel = localComputer.name;
      }
      try {
        const snap = this.deps.computers.resourceSnapshot(localComputer.id);
        if (snap && snap.availableMemoryBytes > 0) {
          usableMemoryGB = Number((snap.availableMemoryBytes / (1024 ** 3)).toFixed(1));
        } else {
          usableMemoryGB = mem * 0.75;
        }
      } catch {
        usableMemoryGB = mem * 0.75;
      }
    }

    const runtimes = this.deps.runtimes.list();
    const runtimeSummaries: LocalRuntimeSummary[] = [];
    const runtimeSummaryParts: string[] = [];

    for (const rt of runtimes) {
      const instances = this.deps.models.list().flatMap(m => this.deps.models.instancesOf(m.id)).filter(i => i.runtimeId === rt.id);
      const loadedCount = instances.filter(i => i.loaded === true && i.health !== 'unavailable').length;
      const installedCount = instances.length - loadedCount;

      runtimeSummaries.push({
        runtimeId: rt.id,
        type: rt.runtimeKind || 'local',
        health: rt.health || 'degraded',
        endpoint: (rt as any).endpoint || (rt as any).baseUrl,
        loadedCount,
        installedCount: Math.max(0, installedCount),
      });

      runtimeSummaryParts.push(`${rt.id} (${rt.health || 'degraded'})`);
    }

    const runtimeSummaryLabel = runtimeSummaryParts.length > 0
      ? runtimeSummaryParts.join(', ')
      : 'No local runtime detected';

    const allModels = this.deps.models.list();
    const localGenerativeModels = allModels.filter(m => m.local !== false && !m.embedding);

    const discoveredModels: LocalDiscoveredModel[] = [];

    let residentMemoryUsedGB = 0;
    for (const m of localGenerativeModels) {
      const instances = this.deps.models.instancesOf(m.id);
      for (const inst of instances) {
        if (inst.loaded === true && inst.health !== 'unavailable') {
          const estMem = estimateModelMemory(m.parameters, m.id, m.quantization);
          const memReq = m.memory?.minSystemGB ?? m.memory?.minGpuGB ?? options?.contextEstimator?.estimateWeightsGB?.(m) ?? estMem.minSystemGB ?? 4;
          residentMemoryUsedGB += memReq;
        }
      }
    }

    const effectiveUsableMemory = usableMemoryGB + residentMemoryUsedGB;

    for (const m of localGenerativeModels) {
      const instances = this.deps.models.instancesOf(m.id);
      const estMem = estimateModelMemory(m.parameters, m.id, m.quantization);
      const memoryRequiredGB = m.memory?.minSystemGB ?? m.memory?.minGpuGB ?? options?.contextEstimator?.estimateWeightsGB?.(m) ?? estMem.minSystemGB ?? 4;
      const contextMax = (m as any).contextWindow ?? m.contextMax ?? 8192;

      let isLoaded = false;
      let isInstalled = false;
      let isUnavailable = false;
      let runtimeType = m.provider || 'ollama';
      let endpoint: string | undefined;

      if (instances.length === 0) {
        isInstalled = true;
      } else {
        for (const inst of instances) {
          const rt = this.deps.runtimes.get(inst.runtimeId);
          if (rt) {
            runtimeType = rt.runtimeKind || runtimeType;
            endpoint = (rt as any).endpoint || (rt as any).baseUrl;
          }

          const isRuntimeOffline = !rt || rt.health === 'unavailable';
          if (isRuntimeOffline || inst.health === 'unavailable' || inst.state === 'UNAVAILABLE') {
            isUnavailable = true;
          } else if (inst.loaded === true && inst.health === 'healthy' && (!rt || rt.health !== 'unavailable')) {
            isLoaded = true;
          } else if ((inst as any).installed !== false) {
            isInstalled = true;
          }
        }
      }

      const hasUnavailableRuntime = instances.some(inst => {
        const rt = this.deps.runtimes.get(inst.runtimeId);
        return rt && rt.health === 'unavailable';
      }) || (instances.length === 0 && runtimes.length > 0 && runtimes.every(rt => rt.health === 'unavailable'));

      if (hasUnavailableRuntime && !isLoaded) {
        isUnavailable = true;
        isInstalled = false;
      }

      let status: 'loaded' | 'installed' | 'unavailable' = 'installed';
      let readinessLabel: 'Ready' | 'Can load' | 'Insufficient memory' | 'Runtime offline' = 'Can load';
      let eligible = true;
      let ineligibleReason: string | undefined;

      if (isUnavailable) {
        status = 'unavailable';
        readinessLabel = 'Runtime offline';
        eligible = false;
        const rtId = instances[0]?.runtimeId ?? runtimeType;
        ineligibleReason = `Runtime ${rtId} is offline`;
      } else if (isLoaded) {
        status = 'loaded';
        readinessLabel = 'Ready';
        eligible = true;
      } else {
        status = 'installed';
        let customEligible = true;
        if (options?.hardwareEligibility && typeof options.hardwareEligibility.check === 'function') {
          const res = options.hardwareEligibility.check(m, { usableMemoryGB: effectiveUsableMemory });
          customEligible = res?.eligible ?? true;
          if (!customEligible) ineligibleReason = res?.reason;
        } else {
          if (memoryRequiredGB > effectiveUsableMemory) {
            customEligible = false;
            ineligibleReason = `insufficient memory: requires ${memoryRequiredGB.toFixed(1)}GB, ${effectiveUsableMemory.toFixed(1)}GB usable`;
          }
        }

        if (customEligible) {
          readinessLabel = 'Can load';
          eligible = true;
        } else {
          readinessLabel = 'Insufficient memory';
          eligible = false;
          ineligibleReason = ineligibleReason ?? `insufficient memory: requires ${memoryRequiredGB.toFixed(1)}GB, ${effectiveUsableMemory.toFixed(1)}GB usable`;
        }
      }

      discoveredModels.push({
        modelId: m.id,
        name: m.name || m.id,
        provider: m.provider || 'ollama',
        runtimeType,
        endpoint,
        status,
        readinessLabel,
        loaded: isLoaded,
        installed: isInstalled || status === 'installed' || status === 'loaded',
        available: !isUnavailable,
        eligible,
        ineligibleReason,
        memoryRequiredGB: Number(memoryRequiredGB.toFixed(1)),
        contextMax,
        deviceLabel,
      });
    }

    discoveredModels.sort((a, b) => {
      const rank = (model: LocalDiscoveredModel) => {
        if (model.status === 'loaded') return 0;
        if (model.status === 'installed' && model.eligible) return 1;
        if (model.status === 'installed' && !model.eligible) return 2;
        return 3;
      };
      return rank(a) - rank(b);
    });

    return {
      deviceLabel,
      usableMemoryGB: Number(usableMemoryGB.toFixed(1)),
      totalMemoryGB: Number(totalMemoryGB.toFixed(1)),
      runtimeSummaryLabel,
      runtimes: runtimeSummaries,
      models: discoveredModels,
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
