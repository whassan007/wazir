import {
  apportionAgentsLargestRemainder,
  optimizeAgentAllocationForSpeed,
  resolveExecutionPlanAgainstGraph,
  validateExecutionPlan,
} from './executionPlan.js';
import { parseHardUserConstraints } from './intelligentScheduler.js';
import type {
  AcceptanceState,
  CapabilityGraph,
  ConcurrencyQualificationResult,
  DeclarativeExecutionPlan,
  ExecutionWorkerNode,
  HardUserConstraints,
  PhysicalHostNode,
  PoolAllocationQuantities,
  ReconciliationSnapshot,
  RuntimeProcessNode,
  RuntimeVerificationEvidence,
} from './types.js';

export type ReconciliationEvent = ReconciliationSnapshot['detectedEvents'][number];
export type ReconciliationEventKind = ReconciliationEvent['kind'];

export interface TargetHealthHysteresisState {
  targetId: string;
  committedState: AcceptanceState;
  lastObservedRawState: AcceptanceState;
  consecutiveFailures: number;
  recoveryCandidateSinceMs?: number;
  currentBackoffMs: number;
  nextProbeNotBeforeMs: number;
  lastTransitionAt: string;
}

export interface PreservedHostInventoryRecord {
  host: PhysicalHostNode;
  reachable: boolean;
  lastSeenOnlineAt: string;
  unreachableSince?: string;
  unreachableReason?: string;
}

export interface MetaHarnessReconcilerOptions {
  plan: DeclarativeExecutionPlan;
  minConsecutiveFailures?: number;
  recoveryCooldownMs?: number;
  baseProbeIntervalMs?: number;
  maxProbeIntervalMs?: number;
  backoffMultiplier?: number;
  maxStaleMs?: number;
  workerHeartbeatTimeoutMs?: number;
  gpuBusyThresholdPct?: number;
  maxHistorySnapshots?: number;
}

export interface ReconcileTickInput {
  graph: CapabilityGraph;
  actualQuantitiesByPool?: Record<string, PoolAllocationQuantities>;
  verificationEvidences?: RuntimeVerificationEvidence[];
  concurrencyQualifications?: ConcurrencyQualificationResult[];
  independentTaskCount?: number;
  nowIso?: string;
}

function isHealthyAcceptanceState(
  state: AcceptanceState,
  verifyExecutionCapability: boolean,
): boolean {
  if (
    state === 'EXECUTION_VERIFIED' ||
    state === 'CAPACITY_VERIFIED' ||
    state === 'SATURATED'
  ) {
    return true;
  }
  if (!verifyExecutionCapability && (state === 'MODEL_READY' || state === 'API_READY')) {
    return true;
  }
  return false;
}

/**
 * Part 6: Continuous Four-State Reconciliation Engine (`MetaHarnessReconciler`).
 *
 * Continuously reconciles:
 * 1. `desired` state (DeclarativeExecutionPlan + HardUserConstraints + speed-optimized targets)
 * 2. `discovered` state (live hosts + preserved last-known-good offline host inventory, runtimes, loaded models)
 * 3. `verified` state (hysteresis-filtered acceptance state & verified concurrency per pool)
 * 4. `actual` state (running, queued, completed, failed, and healthy saturation per pool)
 *
 * Implements exponential probe backoff (`baseProbeIntervalMs * multiplier^(failures-1)`),
 * failure hysteresis (`minConsecutiveFailures`), recovery cooldown hysteresis (`recoveryCooldownMs`),
 * and last-known-good physical host preservation when machines go unreachable.
 */
export class MetaHarnessReconciler {
  private plan: DeclarativeExecutionPlan;
  private readonly minConsecutiveFailures: number;
  private readonly recoveryCooldownMs: number;
  private readonly baseProbeIntervalMs: number;
  private readonly maxProbeIntervalMs: number;
  private readonly backoffMultiplier: number;
  private readonly maxStaleMs: number;
  private readonly workerHeartbeatTimeoutMs: number;
  private readonly gpuBusyThresholdPct: number;
  private readonly maxHistorySnapshots: number;

  private sequence = 0;
  private hasBaselineCycle = false;

  private readonly preservedHosts = new Map<string, PreservedHostInventoryRecord>();
  private readonly previousLoadedModelsByHost = new Map<string, Set<string>>();
  private readonly previousRuntimeProcesses = new Map<string, RuntimeProcessNode>();
  private readonly previousWorkers = new Map<string, ExecutionWorkerNode>();
  private readonly previousConflictSignaturesByHost = new Map<string, Set<string>>();
  private readonly poolHysteresis = new Map<string, TargetHealthHysteresisState>();
  private readonly snapshotHistory: ReconciliationSnapshot[] = [];

  constructor(options: MetaHarnessReconcilerOptions) {
    this.plan = validateExecutionPlan(options.plan);
    this.minConsecutiveFailures = Math.max(1, Math.floor(options.minConsecutiveFailures ?? 2));
    this.recoveryCooldownMs = Math.max(0, Math.floor(options.recoveryCooldownMs ?? 15_000));
    this.baseProbeIntervalMs = Math.max(100, Math.floor(options.baseProbeIntervalMs ?? 2_000));
    this.maxProbeIntervalMs = Math.max(
      this.baseProbeIntervalMs,
      Math.floor(options.maxProbeIntervalMs ?? 60_000),
    );
    this.backoffMultiplier = Math.max(1.1, options.backoffMultiplier ?? 2.0);
    this.maxStaleMs = Math.max(1_000, Math.floor(options.maxStaleMs ?? 300_000));
    this.workerHeartbeatTimeoutMs = Math.max(
      1_000,
      Math.floor(options.workerHeartbeatTimeoutMs ?? 45_000),
    );
    this.gpuBusyThresholdPct = Math.max(50, Math.min(100, options.gpuBusyThresholdPct ?? 85));
    this.maxHistorySnapshots = Math.max(1, Math.floor(options.maxHistorySnapshots ?? 50));
  }

  public updatePlan(nextPlan: DeclarativeExecutionPlan): void {
    this.plan = validateExecutionPlan(nextPlan);
  }

  public shouldProbeTarget(targetId: string, nowIso?: string): boolean {
    const state = this.poolHysteresis.get(targetId);
    if (!state) return true;
    if (state.committedState === 'DISABLED_BY_POLICY') return false;
    const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
    return nowMs >= state.nextProbeNotBeforeMs;
  }

  public getTargetBackoffState(targetId: string): TargetHealthHysteresisState | undefined {
    const s = this.poolHysteresis.get(targetId);
    return s ? structuredClone(s) : undefined;
  }

  public getLastKnownGoodHost(hostId: string): PreservedHostInventoryRecord | undefined {
    const rec = this.preservedHosts.get(hostId);
    return rec ? structuredClone(rec) : undefined;
  }

  public getAllPreservedHosts(): PreservedHostInventoryRecord[] {
    return Array.from(this.preservedHosts.values())
      .sort((a, b) => a.host.hostId.localeCompare(b.host.hostId))
      .map((r) => structuredClone(r));
  }

  public getLatestSnapshot(): ReconciliationSnapshot | undefined {
    if (this.snapshotHistory.length === 0) return undefined;
    return structuredClone(this.snapshotHistory[this.snapshotHistory.length - 1]);
  }

  public getSnapshotHistory(): ReconciliationSnapshot[] {
    return this.snapshotHistory.map((s) => structuredClone(s));
  }

  /**
   * Returns a `CapabilityGraph` where any previously discovered host that went offline
   * is still preserved as hardware inventory (marked with `'UNAVAILABLE'` endpoints)
   * rather than silently vanishing.
   */
  public getMergedInventoryGraph(latestGraph: CapabilityGraph): CapabilityGraph {
    const mergedHosts: Record<string, PhysicalHostNode> = structuredClone(latestGraph.hosts);
    for (const [hostId, preserved] of this.preservedHosts.entries()) {
      if (!mergedHosts[hostId]) {
        mergedHosts[hostId] = structuredClone(preserved.host);
      }
    }
    return {
      ...structuredClone(latestGraph),
      hosts: mergedHosts,
    };
  }

  public reconcile(input: ReconcileTickInput): ReconciliationSnapshot {
    this.sequence += 1;
    const nowIso = input.nowIso ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso);
    const verifyExec = this.plan.spec.routing.verify_execution_capability;
    const events: ReconciliationEvent[] = [];

    // 1. Desired plane
    const hardConstraints: HardUserConstraints = parseHardUserConstraints(
      this.plan.spec.routing.constraints ?? [],
    );
    const requestedAgents = this.plan.spec.execution.total_agents;

    const resolved = resolveExecutionPlanAgainstGraph(this.plan, input.graph, {
      useSpeedOptimization: Boolean(this.plan.spec.execution.speed_optimization),
      independentTaskCount: input.independentTaskCount,
      verificationEvidences: input.verificationEvidences,
      concurrencyQualifications: input.concurrencyQualifications,
      maxStaleMs: this.maxStaleMs,
      nowIso,
    });

    const speedOpt = this.plan.spec.execution.speed_optimization
      ? optimizeAgentAllocationForSpeed({
          plan: this.plan,
          requestedAgents,
          independentTaskCount: input.independentTaskCount,
          verifiedTotalConcurrency:
            Object.values(resolved.poolBindings).reduce(
              (s, b) => s + (b.available ? b.effectiveConcurrentLimit : 0),
              0,
            ) || undefined,
        })
      : undefined;

    const effectiveAgents = speedOpt
      ? speedOpt.speedOptimizedActiveAgents
      : requestedAgents;
    const targetApportionment = apportionAgentsLargestRemainder(this.plan, effectiveAgents);
    const poolTargets: Record<string, number> = {};
    for (const pool of this.plan.spec.pools) {
      poolTargets[pool.id] = pool.enabled
        ? targetApportionment.byPool[pool.id].allocatedAgents
        : 0;
    }

    // 2. Discovered plane + LKG host preservation + infrastructure drift events
    const currentGraphHostIds = new Set<string>();
    const onlineHostIds: string[] = [];
    const unreachableHostIds: string[] = [];
    const loadedModelIdsByHost: Record<string, string[]> = {};

    const sortedGraphHosts = Object.values(input.graph.hosts).sort((a, b) =>
      a.hostId.localeCompare(b.hostId),
    );

    for (const host of sortedGraphHosts) {
      currentGraphHostIds.add(host.hostId);

      const discoveredAgeMs = nowMs - Date.parse(host.lastDiscoveredAt);
      const isHostStale =
        !host.lastDiscoveredAt ||
        !Number.isFinite(discoveredAgeMs) ||
        discoveredAgeMs > this.maxStaleMs;

      // Determine whether host has any reachable endpoint or online worker or is coordinator
      const hostEndpoints = Object.values(input.graph.endpoints).filter(
        (ep) => ep.hostId === host.hostId || ep.machineId === host.machineId,
      );
      const hasOnlineEndpoint = hostEndpoints.some(
        (ep) => ep.acceptanceState !== 'UNAVAILABLE' && ep.acceptanceState !== 'DISABLED_BY_POLICY',
      );
      const hasOnlineWorker = Object.values(input.graph.workers).some(
        (w) => w.hostId === host.hostId && w.status === 'online',
      );
      const isReachable =
        !isHostStale &&
        (host.hostId === input.graph.coordinatorHostId ||
          hasOnlineEndpoint ||
          hasOnlineWorker ||
          hostEndpoints.length === 0);

      if (isHostStale) {
        events.push({
          at: nowIso,
          kind: 'STALE_INVENTORY_INVALIDATED',
          targetId: host.hostId,
          detail: `Host '${host.hostId}' lastDiscoveredAt (${host.lastDiscoveredAt}) exceeded maxStaleMs (${this.maxStaleMs}ms)`,
        });
      }

      const previouslyKnown = this.preservedHosts.get(host.hostId);
      if (!previouslyKnown && this.hasBaselineCycle && isReachable) {
        events.push({
          at: nowIso,
          kind: 'NEW_MACHINE_AVAILABLE',
          targetId: host.hostId,
          detail: `New physical machine '${host.hostId}' (${host.machineId}) joined capability graph`,
        });
      } else if (previouslyKnown && !previouslyKnown.reachable && isReachable) {
        events.push({
          at: nowIso,
          kind: 'NEW_MACHINE_AVAILABLE',
          targetId: host.hostId,
          detail: `Previously unreachable machine '${host.hostId}' is back online`,
        });
      }

      if (isReachable) {
        onlineHostIds.push(host.hostId);
        this.preservedHosts.set(host.hostId, {
          host: structuredClone(host),
          reachable: true,
          lastSeenOnlineAt: nowIso,
        });
      } else {
        unreachableHostIds.push(host.hostId);
        this.preservedHosts.set(host.hostId, {
          host: previouslyKnown ? previouslyKnown.host : structuredClone(host),
          reachable: false,
          lastSeenOnlineAt: previouslyKnown?.lastSeenOnlineAt ?? host.lastDiscoveredAt,
          unreachableSince: previouslyKnown?.unreachableSince ?? nowIso,
          unreachableReason: isHostStale
            ? 'Inventory stale'
            : 'All host endpoints and workers unreachable',
        });
      }

      // Check GPU contention / busy state
      const busyGpu = host.gpus.find(
        (g) => (g.utilizationPercent ?? 0) >= this.gpuBusyThresholdPct,
      );
      const prevConflicts = this.previousConflictSignaturesByHost.get(host.hostId) ?? new Set<string>();
      const curConflictSigs = new Set(
        host.workloadConflicts.map((c) => `${c.processName}:${c.pid ?? 'nopid'}`),
      );
      const hasNewConflict = host.workloadConflicts.some(
        (c) => !prevConflicts.has(`${c.processName}:${c.pid ?? 'nopid'}`),
      );
      this.previousConflictSignaturesByHost.set(host.hostId, curConflictSigs);

      if (
        busyGpu ||
        host.memory.pressureLevel === 'critical' ||
        hasNewConflict
      ) {
        const reasonParts: string[] = [];
        if (busyGpu) {
          reasonParts.push(
            `GPU '${busyGpu.model}' utilization=${busyGpu.utilizationPercent}%`,
          );
        }
        if (host.memory.pressureLevel === 'critical') {
          reasonParts.push('memory pressure=critical');
        }
        if (hasNewConflict) {
          reasonParts.push(
            `workload conflicts=[${host.workloadConflicts.map((c) => c.processName).join(', ')}]`,
          );
        }
        events.push({
          at: nowIso,
          kind: 'GPU_BUSY',
          targetId: host.hostId,
          detail: `Resource contention detected on '${host.hostId}': ${reasonParts.join('; ')}`,
        });
      }

      // Track loaded models and detect MODEL_UNLOADED
      const currentLoadedModels = Object.values(input.graph.models)
        .filter((m) => m.hostId === host.hostId && m.residency === 'loaded')
        .map((m) => m.modelId)
        .sort();
      loadedModelIdsByHost[host.hostId] = currentLoadedModels;

      const prevLoadedSet = this.previousLoadedModelsByHost.get(host.hostId);
      if (prevLoadedSet) {
        const curSet = new Set(currentLoadedModels);
        for (const oldModelId of prevLoadedSet) {
          if (!curSet.has(oldModelId)) {
            events.push({
              at: nowIso,
              kind: 'MODEL_UNLOADED',
              targetId: `${host.hostId}:${oldModelId}`,
              detail: `Model '${oldModelId}' is no longer loaded in memory on host '${host.hostId}'`,
            });
          }
        }
      }
      this.previousLoadedModelsByHost.set(host.hostId, new Set(currentLoadedModels));
    }

    // Preserve hosts that vanished from input.graph.hosts as unreachable LKG inventory!
    for (const [preservedHostId, record] of this.preservedHosts.entries()) {
      if (!currentGraphHostIds.has(preservedHostId)) {
        if (record.reachable) {
          record.reachable = false;
          record.unreachableSince = nowIso;
          record.unreachableReason = 'Host absent from latest discovery graph; preserving last-known-good inventory';
        }
        unreachableHostIds.push(preservedHostId);
        loadedModelIdsByHost[preservedHostId] = [];

        const prevLoaded = this.previousLoadedModelsByHost.get(preservedHostId);
        if (prevLoaded && prevLoaded.size > 0) {
          for (const oldModelId of prevLoaded) {
            events.push({
              at: nowIso,
              kind: 'MODEL_UNLOADED',
              targetId: `${preservedHostId}:${oldModelId}`,
              detail: `Host '${preservedHostId}' went offline; loaded model '${oldModelId}' invalidated`,
            });
          }
          this.previousLoadedModelsByHost.set(preservedHostId, new Set());
        }
      }
    }

    // Check endpoint verification staleness
    for (const ep of Object.values(input.graph.endpoints).sort((a, b) =>
      a.endpointId.localeCompare(b.endpointId),
    )) {
      if (ep.lastVerifiedAt) {
        const age = nowMs - Date.parse(ep.lastVerifiedAt);
        if (!Number.isFinite(age) || age > this.maxStaleMs) {
          events.push({
            at: nowIso,
            kind: 'STALE_INVENTORY_INVALIDATED',
            targetId: ep.endpointId,
            detail: `Endpoint '${ep.endpointId}' lastVerifiedAt (${ep.lastVerifiedAt}) exceeded maxStaleMs (${this.maxStaleMs}ms)`,
          });
        }
      }
    }

    // Detect RUNTIME_RESTARTED
    for (const proc of Object.values(input.graph.runtimeProcesses).sort((a, b) =>
      a.processNodeId.localeCompare(b.processNodeId),
    )) {
      const prevProc = this.previousRuntimeProcesses.get(proc.processNodeId);
      if (prevProc) {
        const pidChanged =
          prevProc.pid !== undefined &&
          proc.pid !== undefined &&
          prevProc.pid !== proc.pid &&
          proc.running;
        const restartedFromStopped = !prevProc.running && proc.running;
        if (pidChanged || restartedFromStopped) {
          events.push({
            at: nowIso,
            kind: 'RUNTIME_RESTARTED',
            targetId: proc.runtimeId,
            detail: pidChanged
              ? `Runtime '${proc.runtimeId}' on '${proc.hostId}' restarted (PID ${prevProc.pid} -> ${proc.pid})`
              : `Runtime '${proc.runtimeId}' on '${proc.hostId}' transitioned stopped -> running`,
          });
        }
      }
      this.previousRuntimeProcesses.set(proc.processNodeId, structuredClone(proc));
    }

    // Detect WORKER_DISAPPEARED
    const currentWorkerIds = new Set<string>();
    for (const worker of Object.values(input.graph.workers).sort((a, b) =>
      a.workerId.localeCompare(b.workerId),
    )) {
      currentWorkerIds.add(worker.workerId);
      const prevWorker = this.previousWorkers.get(worker.workerId);
      const heartbeatAge = nowMs - Date.parse(worker.lastHeartbeatAt);
      const timedOut =
        !Number.isFinite(heartbeatAge) || heartbeatAge > this.workerHeartbeatTimeoutMs;

      if (
        prevWorker &&
        prevWorker.status === 'online' &&
        (worker.status === 'offline' || timedOut)
      ) {
        events.push({
          at: nowIso,
          kind: 'WORKER_DISAPPEARED',
          targetId: worker.workerId,
          detail:
            worker.status === 'offline'
              ? `Worker '${worker.workerId}' on '${worker.hostId}' reported offline`
              : `Worker '${worker.workerId}' heartbeat timed out (${heartbeatAge}ms > ${this.workerHeartbeatTimeoutMs}ms)`,
        });
      }
      this.previousWorkers.set(worker.workerId, structuredClone(worker));
    }

    for (const [prevWorkerId, prevWorker] of this.previousWorkers.entries()) {
      if (!currentWorkerIds.has(prevWorkerId) && prevWorker.status === 'online') {
        events.push({
          at: nowIso,
          kind: 'WORKER_DISAPPEARED',
          targetId: prevWorkerId,
          detail: `Worker '${prevWorkerId}' on '${prevWorker.hostId}' disappeared from CapabilityGraph`,
        });
        this.previousWorkers.set(prevWorkerId, {
          ...prevWorker,
          status: 'offline',
        });
      }
    }

    // Detect CLOUD_RATE_LIMITED
    for (const provider of Object.values(input.graph.cloudProviders).sort((a, b) =>
      a.providerId.localeCompare(b.providerId),
    )) {
      if (!provider.enabled || provider.disabledByPolicy) continue;
      const diagRateLimited = Boolean(
        provider.diagnostic &&
          /\b(?:429|rate[\s_-]*limit(?:ed)?|too\s+many\s+requests|quota[\s_-]*exceeded|resource[\s_-]*exhausted)\b/i.test(
            provider.diagnostic,
          ),
      );
      const quotaZero = Boolean(
        provider.exposedQuotas &&
          ((provider.exposedQuotas.requestsRemaining !== undefined &&
            provider.exposedQuotas.requestsRemaining <= 0) ||
            (provider.exposedQuotas.tokensRemaining !== undefined &&
              provider.exposedQuotas.tokensRemaining <= 0)),
      );

      if (diagRateLimited || quotaZero) {
        events.push({
          at: nowIso,
          kind: 'CLOUD_RATE_LIMITED',
          targetId: provider.providerId,
          detail:
            provider.diagnostic ??
            `Cloud provider '${provider.providerId}' exhausted exposed request/token quota`,
        });
      }
    }

    // 3. Verified plane with Hysteresis + Exponential Backoff
    const acceptanceByPool: Record<string, AcceptanceState> = {};
    const verifiedConcurrencyByPool: Record<string, number> = {};
    const lastVerifiedAtByPool: Record<string, string | undefined> = {};

    for (const pool of this.plan.spec.pools) {
      if (!pool.enabled || pool.share <= 0 || pool.id.toLowerCase() === 'claude') {
        acceptanceByPool[pool.id] = 'DISABLED_BY_POLICY';
        verifiedConcurrencyByPool[pool.id] = 0;
        lastVerifiedAtByPool[pool.id] = undefined;
        this.poolHysteresis.set(pool.id, {
          targetId: pool.id,
          committedState: 'DISABLED_BY_POLICY',
          lastObservedRawState: 'DISABLED_BY_POLICY',
          consecutiveFailures: 0,
          currentBackoffMs: this.maxProbeIntervalMs,
          nextProbeNotBeforeMs: Number.MAX_SAFE_INTEGER,
          lastTransitionAt: nowIso,
        });
        continue;
      }

      const binding = resolved.poolBindings[pool.id];
      const rawState: AcceptanceState = binding?.acceptanceState ?? 'UNAVAILABLE';
      const rawHealthy =
        Boolean(binding?.available) && isHealthyAcceptanceState(rawState, verifyExec);

      const prevHyst = this.poolHysteresis.get(pool.id);

      if (!prevHyst) {
        // Initial observation establishes baseline state
        const initialBackoff = rawHealthy ? this.baseProbeIntervalMs : this.baseProbeIntervalMs;
        const nextHyst: TargetHealthHysteresisState = {
          targetId: pool.id,
          committedState: rawState,
          lastObservedRawState: rawState,
          consecutiveFailures: rawHealthy ? 0 : 1,
          currentBackoffMs: initialBackoff,
          nextProbeNotBeforeMs: nowMs + initialBackoff,
          lastTransitionAt: nowIso,
        };
        this.poolHysteresis.set(pool.id, nextHyst);
        acceptanceByPool[pool.id] = rawState;
        verifiedConcurrencyByPool[pool.id] = rawHealthy ? binding.effectiveConcurrentLimit : 0;
        lastVerifiedAtByPool[pool.id] = binding?.lastVerifiedAt;
        continue;
      }

      const wasCommittedHealthy = isHealthyAcceptanceState(
        prevHyst.committedState,
        verifyExec,
      );

      if (!rawHealthy) {
        const failures = prevHyst.consecutiveFailures + 1;
        const expBackoff = Math.min(
          this.maxProbeIntervalMs,
          Math.round(
            this.baseProbeIntervalMs * Math.pow(this.backoffMultiplier, Math.max(0, failures - 1)),
          ),
        );

        let nextCommitted = prevHyst.committedState;
        let lastTransitionAt = prevHyst.lastTransitionAt;

        if (failures >= this.minConsecutiveFailures || !wasCommittedHealthy) {
          nextCommitted = rawState === 'DEGRADED' ? 'DEGRADED' : 'UNAVAILABLE';
          if (nextCommitted !== prevHyst.committedState) {
            lastTransitionAt = nowIso;
          }
        } else {
          // Within hysteresis grace window: mark DEGRADED rather than thrashing to UNAVAILABLE
          nextCommitted = 'DEGRADED';
        }

        this.poolHysteresis.set(pool.id, {
          targetId: pool.id,
          committedState: nextCommitted,
          lastObservedRawState: rawState,
          consecutiveFailures: failures,
          recoveryCandidateSinceMs: undefined,
          currentBackoffMs: expBackoff,
          nextProbeNotBeforeMs: nowMs + expBackoff,
          lastTransitionAt,
        });

        acceptanceByPool[pool.id] = nextCommitted;
        verifiedConcurrencyByPool[pool.id] =
          nextCommitted === 'UNAVAILABLE' ? 0 : binding?.effectiveConcurrentLimit ?? 0;
        lastVerifiedAtByPool[pool.id] = binding?.lastVerifiedAt;
      } else {
        // Raw probe is healthy!
        if (wasCommittedHealthy && prevHyst.consecutiveFailures === 0) {
          this.poolHysteresis.set(pool.id, {
            targetId: pool.id,
            committedState: rawState,
            lastObservedRawState: rawState,
            consecutiveFailures: 0,
            recoveryCandidateSinceMs: undefined,
            currentBackoffMs: this.baseProbeIntervalMs,
            nextProbeNotBeforeMs: nowMs + this.baseProbeIntervalMs,
            lastTransitionAt:
              rawState !== prevHyst.committedState ? nowIso : prevHyst.lastTransitionAt,
          });
          acceptanceByPool[pool.id] = rawState;
          verifiedConcurrencyByPool[pool.id] = binding.effectiveConcurrentLimit;
          lastVerifiedAtByPool[pool.id] = binding.lastVerifiedAt;
        } else if (wasCommittedHealthy && prevHyst.consecutiveFailures > 0) {
          // Transient blip cleared before minConsecutiveFailures tripped
          this.poolHysteresis.set(pool.id, {
            targetId: pool.id,
            committedState: rawState,
            lastObservedRawState: rawState,
            consecutiveFailures: 0,
            recoveryCandidateSinceMs: undefined,
            currentBackoffMs: this.baseProbeIntervalMs,
            nextProbeNotBeforeMs: nowMs + this.baseProbeIntervalMs,
            lastTransitionAt: nowIso,
          });
          acceptanceByPool[pool.id] = rawState;
          verifiedConcurrencyByPool[pool.id] = binding.effectiveConcurrentLimit;
          lastVerifiedAtByPool[pool.id] = binding.lastVerifiedAt;
        } else {
          // Pool was committed UNHEALTHY (UNAVAILABLE or DEGRADED after failures >= minConsecutiveFailures).
          // Enforce recoveryCooldownMs hysteresis before promoting back to active routing!
          const candidateSince = prevHyst.recoveryCandidateSinceMs ?? nowMs;
          const elapsedRecoveryMs = nowMs - candidateSince;

          if (elapsedRecoveryMs >= this.recoveryCooldownMs) {
            this.poolHysteresis.set(pool.id, {
              targetId: pool.id,
              committedState: rawState,
              lastObservedRawState: rawState,
              consecutiveFailures: 0,
              recoveryCandidateSinceMs: undefined,
              currentBackoffMs: this.baseProbeIntervalMs,
              nextProbeNotBeforeMs: nowMs + this.baseProbeIntervalMs,
              lastTransitionAt: nowIso,
            });
            acceptanceByPool[pool.id] = rawState;
            verifiedConcurrencyByPool[pool.id] = binding.effectiveConcurrentLimit;
            lastVerifiedAtByPool[pool.id] = binding.lastVerifiedAt;

            events.push({
              at: nowIso,
              kind: 'RUNTIME_RECOVERED',
              targetId: pool.id,
              detail: `Pool '${pool.id}' recovered to '${rawState}' after ${elapsedRecoveryMs}ms stability cooldown`,
            });
          } else {
            // Still in recovery cooldown window; hold prior committed state to prevent thrash
            const remainingCooldown = Math.max(100, this.recoveryCooldownMs - elapsedRecoveryMs);
            this.poolHysteresis.set(pool.id, {
              ...prevHyst,
              lastObservedRawState: rawState,
              recoveryCandidateSinceMs: candidateSince,
              nextProbeNotBeforeMs: nowMs + Math.min(this.baseProbeIntervalMs, remainingCooldown),
            });
            acceptanceByPool[pool.id] = prevHyst.committedState;
            verifiedConcurrencyByPool[pool.id] = 0;
            lastVerifiedAtByPool[pool.id] = binding.lastVerifiedAt;
          }
        }
      }
    }

    // 4. Actual plane + healthy saturation vs QUEUED_TASK_READY detection
    const quantitiesByPool: Record<string, PoolAllocationQuantities> = {};
    const healthySaturationPools: string[] = [];
    let totalRunning = 0;
    let totalQueued = 0;
    let totalCompleted = 0;
    let totalFailed = 0;

    for (const pool of this.plan.spec.pools) {
      const baseQ = input.actualQuantitiesByPool?.[pool.id] ?? resolved.poolQuantities[pool.id];
      const committedConc = verifiedConcurrencyByPool[pool.id] ?? 0;
      const committedAcc = acceptanceByPool[pool.id];

      const mergedQ: PoolAllocationQuantities = {
        ...baseQ,
        effectiveConcurrentLimit: pool.enabled
          ? input.actualQuantitiesByPool?.[pool.id]?.effectiveConcurrentLimit ?? committedConc
          : 0,
      };

      quantitiesByPool[pool.id] = mergedQ;
      totalRunning += mergedQ.runningAgents;
      totalQueued += mergedQ.queuedAgents;
      totalCompleted += mergedQ.completedAgents;
      totalFailed += mergedQ.failedAgents;

      if (!pool.enabled) continue;

      const poolHealthy = isHealthyAcceptanceState(committedAcc, verifyExec);
      const effLimit = mergedQ.effectiveConcurrentLimit;

      if (
        poolHealthy &&
        effLimit > 0 &&
        mergedQ.runningAgents >= effLimit &&
        mergedQ.queuedAgents > 0
      ) {
        healthySaturationPools.push(pool.id);
      } else if (
        poolHealthy &&
        effLimit > 0 &&
        mergedQ.queuedAgents > 0 &&
        mergedQ.runningAgents < effLimit
      ) {
        events.push({
          at: nowIso,
          kind: 'QUEUED_TASK_READY',
          targetId: pool.id,
          detail: `Pool '${pool.id}' has ${mergedQ.queuedAgents} queued task(s) and ${effLimit - mergedQ.runningAgents} open execution slot(s)`,
        });
      }
    }

    this.hasBaselineCycle = true;

    const snapshot: ReconciliationSnapshot = {
      reconciledAt: nowIso,
      sequence: this.sequence,
      desired: {
        planName: this.plan.metadata.name,
        requestedAgents,
        effectiveAgents,
        speedOptimized: Boolean(speedOpt?.speedOptimizationApplied),
        poolTargets,
        constraints: hardConstraints,
      },
      discovered: {
        hostCount: this.preservedHosts.size,
        onlineHostIds: onlineHostIds.sort(),
        unreachableHostIds: Array.from(new Set(unreachableHostIds)).sort(),
        runtimeCount: Object.values(input.graph.runtimeProcesses).filter((r) => r.running).length,
        loadedModelIdsByHost,
      },
      verified: {
        acceptanceByPool,
        verifiedConcurrencyByPool,
        lastVerifiedAtByPool,
      },
      actual: {
        quantitiesByPool,
        totalRunning,
        totalQueued,
        totalCompleted,
        totalFailed,
        healthySaturationPools: healthySaturationPools.sort(),
      },
      detectedEvents: events,
    };

    this.snapshotHistory.push(structuredClone(snapshot));
    if (this.snapshotHistory.length > this.maxHistorySnapshots) {
      this.snapshotHistory.shift();
    }

    return snapshot;
  }
}
