import type { ModelInstance, ModelRecord } from '../types/model.js';

export class ModelRegistry {
  private records = new Map<string, ModelRecord>();
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
    this.instances.set(instance.id, { ...instance, lastCheckedAt: new Date() });
    return instance;
  }

  setInstanceHealth(
    instanceId: string,
    patch: { loaded?: boolean; health?: ModelInstance['health']; contextTokens?: number; loadTimeMs?: number },
  ): ModelInstance | undefined {
    const existing = this.instances.get(instanceId);
    if (!existing) return undefined;
    const updated: ModelInstance = {
      ...existing,
      ...patch,
      lastCheckedAt: new Date(),
    };
    this.instances.set(instanceId, updated);
    if (patch.loaded === true) {
      updated.lastUsedAt = new Date();
    }
    return updated;
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

  listInstances(): ModelInstance[] {
    return Array.from(this.instances.values()).sort((a, b) => a.id.localeCompare(b.id));
  }
}
