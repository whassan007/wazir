import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ResourceSnapshot, ResourceReservation } from '../types/modelLifecycle.js';
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
      resourceObservedAt: existing?.resourceObservedAt,
      reservations: existing?.reservations ?? [],
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
      resourceObservedAt: payload.load ? new Date() : computer.resourceObservedAt,
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

  /** Remote resources are observed from worker heartbeats, never inferred from host RAM. */
  resourceSnapshot(id: string, maxAgeMs = 30_000): ResourceSnapshot {
    const c = this.computers.get(id);
    if (!c) throw new Error('COMPUTER_UNAVAILABLE');
    const now = new Date();
    const observedAt = c.local ? now : c.resourceObservedAt ?? new Date(0);
    const fresh = now.getTime() - observedAt.getTime() <= maxAgeMs;
    const unifiedMemory = c.hardware.gpu?.unifiedMemory === true;
    const bytes = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n >= 0 ? n * 1024 ** 3 : undefined;
    // A sample collected after a completed allocation includes its resident memory.
    c.reservations = (c.reservations ?? []).filter(r => !r.settledAt || observedAt <= r.settledAt);
    return {
      computerId: id, totalMemoryBytes: bytes(c.hardware.memoryGB) ?? 0,
      availableMemoryBytes: c.local ? os.freemem() : fresh ? bytes(c.load?.memoryAvailableGB) : undefined,
      totalVramBytes: unifiedMemory ? undefined : bytes(c.hardware.gpu?.memoryGB),
      availableVramBytes: unifiedMemory ? undefined : fresh ? bytes(c.load?.gpuMemoryAvailableGB) : undefined,
      unifiedMemory, cpuUtilization: c.load?.cpuPercent, gpuUtilization: c.load?.gpuUtilizationPercent,
      activeReservations: (c.reservations ?? []).map(r => ({ ...r })), observedAt,
    };
  }

  /** Synchronous compare-and-reserve: no await between capacity check and commit. */
  reserve(computerId: string, instanceId: string, memoryBytes: number, vramBytes: number,
    reservePercent: number, minimumReserveBytes: number): ResourceReservation | undefined {
    const snapshot = this.resourceSnapshot(computerId);
    const available = snapshot.availableMemoryBytes;
    if (available === undefined || !Number.isFinite(memoryBytes) || memoryBytes < 0 || !Number.isFinite(vramBytes) || vramBytes < 0) return undefined;
    const held = snapshot.activeReservations.reduce((n, r) => n + r.memoryBytes, 0);
    const reserve = Math.max(available * reservePercent / 100, minimumReserveBytes);
    if (memoryBytes > available - reserve - held) return undefined;
    if (!snapshot.unifiedMemory && vramBytes > 0) {
      const gpuHeld = snapshot.activeReservations.reduce((n, r) => n + r.vramBytes, 0);
      if (snapshot.availableVramBytes === undefined || vramBytes > snapshot.availableVramBytes - gpuHeld) return undefined;
    }
    const reservation: ResourceReservation = { id: randomUUID(), instanceId, memoryBytes, vramBytes, createdAt: new Date() };
    this.computers.get(computerId)!.reservations!.push(reservation);
    return reservation;
  }

  settleReservation(computerId: string, id: string): void {
    const r = this.computers.get(computerId)?.reservations?.find(r => r.id === id);
    if (r) r.settledAt = new Date();
  }
  releaseReservation(computerId: string, id: string): void {
    const c = this.computers.get(computerId);
    if (c) c.reservations = c.reservations?.filter(r => r.id !== id);
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
