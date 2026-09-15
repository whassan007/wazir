import type { RuntimeRecord, RuntimeRegistration } from '../types/runtime.js';

export class RuntimeRegistry {
  private runtimes = new Map<string, RuntimeRecord>();

  register(registration: RuntimeRegistration): RuntimeRecord {
    const existing = this.runtimes.get(registration.id);
    const record: RuntimeRecord = {
      ...registration,
      health: existing?.health ?? 'degraded',
      loadedModels: existing?.loadedModels ?? [],
      lastCheckedAt: new Date(),
    };
    this.runtimes.set(record.id, record);
    return record;
  }

  update(
    id: string,
    patch: Partial<Pick<RuntimeRecord, 'health' | 'version' | 'loadedModels'>>,
  ): RuntimeRecord | undefined {
    const existing = this.runtimes.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: RuntimeRecord = { ...existing, ...patch, lastCheckedAt: new Date() };
    this.runtimes.set(id, updated);
    return updated;
  }

  get(id: string): RuntimeRecord | undefined {
    return this.runtimes.get(id);
  }

  list(): RuntimeRecord[] {
    return Array.from(this.runtimes.values()).sort((a, b) => a.id.localeCompare(b.id));
  }
}
