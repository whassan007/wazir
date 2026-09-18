import type {
  Computer,
  ComputerRegistration,
  ModelHealth,
  ResourceState,
  RuntimeHealth,
} from '../types/index.js';

export interface HeartbeatPayload {
  load?: ResourceState;
  runtimeHealth?: Record<string, RuntimeHealth>;
  modelHealth?: Record<string, ModelHealth>;
  runtimes?: string[];
  models?: string[];
}

export class ComputerRegistry {
  private computers = new Map<string, Computer>();

  register(registration: ComputerRegistration): Computer {
    const now = new Date();
    const existing = this.computers.get(registration.id);

    const updated: Computer = {
      id: registration.id,
      name: registration.name,
      type: registration.type,
      status: 'online',
      local: existing?.local ?? registration.local ?? false,
      os: registration.os,
      hardware: registration.hardware,
      runtimes: registration.runtimes ?? existing?.runtimes ?? [],
      models: registration.models ?? existing?.models ?? [],
      capabilities: registration.capabilities ?? existing?.capabilities ?? [],
      load: existing?.load,
      runtimeHealth: existing?.runtimeHealth ?? {},
      modelHealth: existing?.modelHealth ?? {},
      health: existing?.health ?? 'healthy',
      network: registration.network ?? existing?.network,
      policyRestrictions: registration.policyRestrictions ?? existing?.policyRestrictions,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastHeartbeat: now,
    };

    this.computers.set(registration.id, updated);
    return updated;
  }

  heartbeat(computerId: string, payload: HeartbeatPayload = {}): Computer | undefined {
    const computer = this.computers.get(computerId);
    if (!computer) {
      return undefined;
    }

    const updated: Computer = {
      ...computer,
      status: 'online',
      load: payload.load ?? computer.load,
      runtimeHealth: { ...computer.runtimeHealth, ...(payload.runtimeHealth ?? {}) },
      modelHealth: { ...computer.modelHealth, ...(payload.modelHealth ?? {}) },
      runtimes: payload.runtimes ?? computer.runtimes,
      models: payload.models ?? computer.models,
      updatedAt: new Date(),
      lastHeartbeat: new Date(),
    };

    this.computers.set(computerId, updated);
    return updated;
  }

  setOffline(computerId: string): boolean {
    const computer = this.computers.get(computerId);
    if (!computer) {
      return false;
    }
    this.computers.set(computerId, { ...computer, status: 'offline', updatedAt: new Date() });
    return true;
  }

  get(id: string): Computer | undefined {
    return this.computers.get(id);
  }

  list(): Computer[] {
    return Array.from(this.computers.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  listOnline(): Computer[] {
    return this.list().filter((c) => c.status === 'online');
  }

  checkHeartbeats(thresholds: { staleMs?: number; offlineMs?: number } = {}): {
    healthy: string[];
    stale: string[];
    offline: string[];
  } {
    const staleMs = thresholds.staleMs ?? 30_000;
    const offlineMs = thresholds.offlineMs ?? 60_000;
    const now = Date.now();

    const result = { healthy: [] as string[], stale: [] as string[], offline: [] as string[] };

    for (const [id, comp] of this.computers.entries()) {
      const last = comp.lastHeartbeat ? comp.lastHeartbeat.getTime() : comp.createdAt.getTime();
      const elapsed = now - last;

      if (elapsed >= offlineMs) {
        comp.status = 'offline';
        comp.health = 'unavailable';
        comp.updatedAt = new Date(now);
        result.offline.push(id);
      } else if (elapsed >= staleMs) {
        comp.status = 'online';
        comp.health = 'degraded';
        comp.updatedAt = new Date(now);
        result.stale.push(id);
      } else {
        comp.status = 'online';
        comp.health = 'healthy';
        result.healthy.push(id);
      }
    }

    return result;
  }
}
