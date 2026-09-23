import type { ModelInstallation, ModelInstance, ModelRecord } from '../types/model.js';

export class ModelRegistry {
  private records = new Map<string, ModelRecord>();
  private installations = new Map<string, ModelInstallation>();
  upsertInstallation(installation: ModelInstallation): void { this.installations.set(installation.id, installation); }
  listInstallations(): ModelInstallation[] { return [...this.installations.values()]; }
  getInstallation(id: string): ModelInstallation | undefined { return this.installations.get(id); }

  private instances = new Map<string, ModelInstance>();

  register(record: ModelRecord): ModelRecord {
    const now = new Date();
    const existing = this.records.get(record.id);
    const merged: ModelRecord = {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(merged.id, merged);
    return merged;
  }

  upsertInstance(instance: ModelInstance): ModelInstance {
    instance = { ...this.instances.get(instance.id), ...instance };
    this.instances.set(instance.id, { ...instance, lastCheckedAt: new Date() });
    return instance;
  }

  setInstanceHealth(
    instanceId: string,
    patch: {
      loaded?: boolean;
      state?: import('../types/model.js').ModelLifecycleState;
      health?: ModelInstance['health'];
      contextTokens?: number;
      loadTimeMs?: number;
      error?: string;
    },
  ): ModelInstance | undefined {
    const existing = this.instances.get(instanceId);
    if (!existing) return undefined;
    const isNowLoaded =
      patch.loaded !== undefined
        ? patch.loaded
        : patch.state === 'READY' || patch.state === 'LOADED'
          ? true
          : patch.state === 'UNLOADED' || patch.state === 'INSTALLED' || patch.state === 'DISCOVERED'
            ? false
            : existing.loaded;

    const updated: ModelInstance = {
      ...existing,
      ...patch,
      loaded: isNowLoaded,
      lastCheckedAt: new Date(),
    };
    this.instances.set(instanceId, updated);
    if (isNowLoaded) {
      updated.lastUsedAt = new Date();
    }
    return updated;
  }

  setInstanceLoaded(instanceId: string, loaded: boolean): boolean {
    const updated = this.setInstanceHealth(instanceId, {
      loaded,
      state: loaded ? 'LOADED' : 'UNLOADED',
    });
    return updated !== undefined;
  }

  setInstanceState(
    instanceId: string,
    state: import('../types/model.js').ModelLifecycleState,
    extra?: { error?: string; health?: ModelInstance['health']; contextTokens?: number; loadTimeMs?: number },
  ): ModelInstance | undefined {
    return this.setInstanceHealth(instanceId, { state, ...extra });
  }

  isModelReady(modelId: string): boolean {
    const instances = this.instancesOf(modelId);
    return instances.some(
      (i) => i.loaded && i.state === 'READY' && i.health === 'healthy',
    );
  }

  getModelState(modelId: string): import('../types/model.js').ModelLifecycleState {
    const instances = this.instancesOf(modelId);
    if (instances.length === 0) return 'DISCOVERED';
    if (instances.some((i) => i.state === 'READY' && i.health === 'healthy')) return 'READY';
    if (instances.some((i) => i.state === 'LOADING')) return 'LOADING';
    if (instances.some((i) => i.state === 'DRAINING')) return 'DRAINING';
    if (instances.some((i) => i.state === 'UNLOADING')) return 'UNLOADING';
    if (instances.some((i) => i.state === 'FAILED')) return 'FAILED';
    if (instances.every((i) => i.health === 'unavailable' || i.state === 'UNAVAILABLE')) return 'UNAVAILABLE';
    if (instances.some((i) => i.loaded)) return 'LOADED';
    if (instances.some((i) => i.state === 'UNLOADED')) return 'UNLOADED';
    return 'INSTALLED';
  }

  listReady(): ModelRecord[] {
    return this.list().filter((m) => this.isModelReady(m.id));
  }

  listInstalled(): ModelRecord[] {
    return this.list().filter((m) => this.instancesOf(m.id).length > 0);
  }

  get(id: string): ModelRecord | undefined {
    return this.records.get(id);
  }

  getRequired(id: string): ModelRecord {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Unknown model: ${id}`);
    }
    return record;
  }

  list(): ModelRecord[] {
    return Array.from(this.records.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  instancesOf(modelId: string): ModelInstance[] {
    return Array.from(this.instances.values())
      .filter((i) => i.modelId === modelId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  instanceOn(computerId: string, runtimeId?: string): ModelInstance[] {
    return Array.from(this.instances.values())
      .filter((i) => i.computerId === computerId && (!runtimeId || i.runtimeId === runtimeId))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  instancesForRuntime(runtimeId: string): ModelInstance[] {
    return Array.from(this.instances.values())
      .filter((i) => i.runtimeId === runtimeId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  listInstances(): ModelInstance[] {
    return Array.from(this.instances.values()).sort((a, b) => a.id.localeCompare(b.id));
  }
}
