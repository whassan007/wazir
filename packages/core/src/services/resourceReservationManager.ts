import { randomUUID } from 'node:crypto';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { JsonFileStore, isPathInside } from '@wazir/shared';
import type { ResourceLease } from '../types/coordination.js';

export class ResourceConflictError extends Error {
  readonly code = 'RESOURCE_CONFLICT' as const;
  readonly conflictingResource: string;

  constructor(conflictingResource: string, message?: string) {
    super(message ?? `Resource conflict on '${conflictingResource}'`);
    this.name = 'ResourceConflictError';
    this.conflictingResource = conflictingResource;
  }
}

export class StaleFencingTokenError extends Error {
  readonly code = 'STALE_FENCING_TOKEN' as const;
  readonly resourceKey: string;
  readonly expectedMinToken: number;
  readonly actualToken: number;

  constructor(resourceKey: string, expectedMinToken: number, actualToken: number, message?: string) {
    super(
      message ??
        `Stale fencing token ${actualToken} for resource '${resourceKey}' (expected >= ${expectedMinToken})`,
    );
    this.name = 'StaleFencingTokenError';
    this.resourceKey = resourceKey;
    this.expectedMinToken = expectedMinToken;
    this.actualToken = actualToken;
  }
}

export class ResourceLeaseExpiredError extends Error {
  readonly code = 'RESOURCE_LEASE_EXPIRED' as const;
  readonly leaseId: string;

  constructor(leaseId: string, message?: string) {
    super(message ?? `Resource lease '${leaseId}' is expired or no longer active`);
    this.name = 'ResourceLeaseExpiredError';
    this.leaseId = leaseId;
  }
}

export interface GpuSlotReservation {
  computerId: string;
  gpuId?: string;
  gpuMemoryGB?: number;
}

export interface ModelSlotReservation {
  runtimeId: string;
  modelId: string;
  maxConcurrentSlots?: number;
}

export interface ComputeBudgetReservation {
  computerId: string;
  cpuCores?: number;
  memoryGB?: number;
}

export interface GitRepoReservation {
  repoPath: string;
  mode?: 'read' | 'write';
}

export interface WorktreeReservation {
  worktreePath: string;
  mode?: 'read' | 'write';
}

export interface WorkspacePathReservation {
  path: string;
  mode: 'read' | 'write';
}

export interface ReservationRequest {
  workerId: string;
  workflowId?: string;
  taskId?: string;
  ttlMs?: number;
  gpuSlots?: GpuSlotReservation[];
  modelSlots?: ModelSlotReservation[];
  computeBudgets?: ComputeBudgetReservation[];
  gitRepos?: GitRepoReservation[];
  worktrees?: WorktreeReservation[];
  workspacePaths?: WorkspacePathReservation[];
  exclusiveResources?: string[];
  gpuSlot?: GpuSlotReservation;
  modelSlot?: ModelSlotReservation;
  computeBudget?: ComputeBudgetReservation;
  gitRepo?: GitRepoReservation;
  worktree?: WorktreeReservation;
}

export interface ComputeCapacity {
  cpuCores: number;
  memoryGB: number;
  gpuMemoryGB?: number;
  gpuCount?: number;
}

export interface ResourceReservationManagerOptions {
  defaultTtlMs?: number;
  stateDir?: string;
  now?: () => number;
}

interface NormalizedGpuSlot {
  key: string;
  computerId: string;
  gpuId?: string;
  gpuMemoryGB?: number;
  exclusive: boolean;
}

interface NormalizedModelSlot {
  key: string;
  runtimeId: string;
  modelId: string;
  maxConcurrentSlots: number;
}

interface NormalizedComputeBudget {
  key: string;
  computerId: string;
  cpuCores: number;
  memoryGB: number;
}

interface NormalizedPathMode {
  key: string;
  canonicalPath: string;
  mode: 'read' | 'write';
}

interface InternalLeaseRecord {
  leaseId: string;
  workerId: string;
  workflowId?: string;
  taskId?: string;
  fencingToken: number;
  resourceKeys: string[];
  writeKeys: string[];
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
  ttlMs: number;
  gpuSlots: NormalizedGpuSlot[];
  modelSlots: NormalizedModelSlot[];
  computeBudgets: NormalizedComputeBudget[];
  gitRepos: NormalizedPathMode[];
  worktrees: NormalizedPathMode[];
  workspacePaths: NormalizedPathMode[];
  exclusiveResources: string[];
}

interface ExpiredLeaseMarker {
  expiredAt: number;
  fencingToken: number;
  resourceKeys: string[];
}

interface PersistedReservationState {
  version: 1;
  globalFencingCounter: number;
  fencingCounters: Record<string, number>;
  writeFencingCounters: Record<string, number>;
  leases: Record<string, InternalLeaseRecord>;
  expiredLeaseIds: Record<string, ExpiredLeaseMarker>;
}

const DEFAULT_TTL_MS = 30_000;
const MAX_EXPIRED_HISTORY = 2000;
const STATE_STORE_KEY = 'reservations';
const KNOWN_KEY_PREFIXES = [
  'gpu:',
  'model:',
  'compute:',
  'git-repo:',
  'worktree:',
  'workspace:',
  'exclusive:',
];

const inProcessStateDirQueues = new Map<string, Promise<unknown>>();

function createEmptyState(): PersistedReservationState {
  return {
    version: 1,
    globalFencingCounter: 0,
    fencingCounters: {},
    writeFencingCounters: {},
    leases: {},
    expiredLeaseIds: {},
  };
}

function normalizeState(raw: PersistedReservationState | undefined): PersistedReservationState {
  if (!raw || typeof raw !== 'object') {
    return createEmptyState();
  }
  return {
    version: 1,
    globalFencingCounter: typeof raw.globalFencingCounter === 'number' ? raw.globalFencingCounter : 0,
    fencingCounters: { ...(raw.fencingCounters ?? {}) },
    writeFencingCounters: { ...(raw.writeFencingCounters ?? {}) },
    leases: { ...(raw.leases ?? {}) },
    expiredLeaseIds: { ...(raw.expiredLeaseIds ?? {}) },
  };
}

function canonicalizePath(inputPath: string, depth = 0): string {
  const resolved = path.resolve(inputPath);
  if (depth > 32) {
    return resolved;
  }
  try {
    return realpathSync(resolved);
  } catch {
    try {
      const stat = lstatSync(resolved);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(resolved);
        const nextTarget = path.isAbsolute(target) ? target : path.resolve(path.dirname(resolved), target);
        return canonicalizePath(nextTarget, depth + 1);
      }
    } catch {
      // Fall through to ancestor walk when path does not exist.
    }
    const trailing: string[] = [];
    let current = resolved;
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      trailing.unshift(path.basename(current));
      current = parent;
      try {
        const realAncestor = realpathSync(current);
        return path.join(realAncestor, ...trailing);
      } catch {
        // Walk up until an existing ancestor is found so symlinks like /tmp -> /private/tmp resolve.
      }
    }
  }
}

function pathsOverlap(a: string, b: string): boolean {
  return isPathInside(a, b) || isPathInside(b, a);
}

function extractWorkspacePathFromKey(key: string): string | undefined {
  if (key.startsWith('workspace:')) return key.slice('workspace:'.length);
  return undefined;
}

function toResourceLease(record: InternalLeaseRecord): ResourceLease {
  const lease = {
    leaseId: record.leaseId,
    workerId: record.workerId,
    ...(record.workflowId !== undefined ? { workflowId: record.workflowId } : {}),
    ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
    fencingToken: record.fencingToken,
    resourceKeys: [...record.resourceKeys],
    acquiredAt: record.acquiredAt,
    renewedAt: record.renewedAt,
    expiresAt: record.expiresAt,
  };
  return lease as ResourceLease;
}

function pruneExpiredHistory(history: Record<string, ExpiredLeaseMarker>): void {
  const keys = Object.keys(history);
  if (keys.length <= MAX_EXPIRED_HISTORY) return;
  keys.sort((a, b) => history[a].expiredAt - history[b].expiredAt);
  const removeCount = keys.length - MAX_EXPIRED_HISTORY;
  for (let i = 0; i < removeCount; i++) {
    delete history[keys[i]];
  }
}

/**
 * Coordinates exclusive and bounded-capacity reservations across compute,
 * models, git worktrees/repos, workspace paths, and external resources with
 * monotonic fencing tokens and optional cross-process file-backed durability.
 */
export class ResourceReservationManager {
  private readonly defaultTtlMs: number;
  private readonly now: () => number;
  private readonly stateDir?: string;
  private readonly store?: JsonFileStore;
  private readonly computeCapacities = new Map<string, ComputeCapacity>();
  private memoryState: PersistedReservationState = createEmptyState();
  private instanceQueue: Promise<unknown> = Promise.resolve();

  constructor(options: ResourceReservationManagerOptions = {}) {
    const ttl = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`Invalid defaultTtlMs '${ttl}': must be a positive finite number`);
    }
    this.defaultTtlMs = ttl;
    this.now = options.now ?? Date.now;
    if (options.stateDir) {
      this.stateDir = path.resolve(options.stateDir);
      this.store = new JsonFileStore(path.join(this.stateDir, 'resource-reservations.json'), {
        coalesceWrites: false,
      });
    }
  }

  registerComputeCapacity(computerId: string, cap: ComputeCapacity): void {
    if (!computerId) {
      throw new Error('computerId is required');
    }
    if (!Number.isFinite(cap.cpuCores) || cap.cpuCores < 0) {
      throw new Error(`Invalid cpuCores '${cap.cpuCores}' for computer '${computerId}'`);
    }
    if (!Number.isFinite(cap.memoryGB) || cap.memoryGB < 0) {
      throw new Error(`Invalid memoryGB '${cap.memoryGB}' for computer '${computerId}'`);
    }
    if (cap.gpuMemoryGB !== undefined && (!Number.isFinite(cap.gpuMemoryGB) || cap.gpuMemoryGB < 0)) {
      throw new Error(`Invalid gpuMemoryGB '${cap.gpuMemoryGB}' for computer '${computerId}'`);
    }
    if (cap.gpuCount !== undefined && (!Number.isFinite(cap.gpuCount) || cap.gpuCount < 0)) {
      throw new Error(`Invalid gpuCount '${cap.gpuCount}' for computer '${computerId}'`);
    }
    this.computeCapacities.set(computerId, { ...cap });
  }

  async acquire(request: ReservationRequest): Promise<ResourceLease> {
    if (!request.workerId) {
      throw new Error('workerId is required to acquire a resource lease');
    }
    const ttlMs = request.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`Invalid ttlMs '${ttlMs}': must be a positive finite number`);
    }

    const normalized = this.normalizeRequest(request);

    return this.withSerializedUpdate((state) => {
      const now = this.now();
      this.reclaimExpiredInState(state, now);

      this.assertNoConflicts(state, normalized);

      const allKeys = this.collectResourceKeys(normalized);
      const writeKeys = this.collectWriteKeys(normalized);
      const maxExistingForKeys = this.maxTokenForKeys(state, allKeys, normalized.workspacePaths);
      const fencingToken = Math.max(state.globalFencingCounter, maxExistingForKeys) + 1;

      state.globalFencingCounter = fencingToken;
      for (const key of allKeys) {
        state.fencingCounters[key] = fencingToken;
      }
      for (const key of writeKeys) {
        state.writeFencingCounters[key] = fencingToken;
      }

      const leaseId = `rlease-${randomUUID()}`;
      const record: InternalLeaseRecord = {
        leaseId,
        workerId: request.workerId,
        ...(request.workflowId !== undefined ? { workflowId: request.workflowId } : {}),
        ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
        fencingToken,
        resourceKeys: allKeys,
        writeKeys,
        acquiredAt: now,
        renewedAt: now,
        expiresAt: now + ttlMs,
        ttlMs,
        gpuSlots: normalized.gpuSlots,
        modelSlots: normalized.modelSlots,
        computeBudgets: normalized.computeBudgets,
        gitRepos: normalized.gitRepos,
        worktrees: normalized.worktrees,
        workspacePaths: normalized.workspacePaths,
        exclusiveResources: normalized.exclusiveResources,
      };
      state.leases[leaseId] = record;

      return toResourceLease(record);
    });
  }

  async renew(leaseId: string, workerId: string, extendMs?: number): Promise<ResourceLease> {
    if (extendMs !== undefined && (!Number.isFinite(extendMs) || extendMs <= 0)) {
      throw new Error(`Invalid extendMs '${extendMs}': must be a positive finite number`);
    }
    return this.withSerializedUpdate((state) => {
      const now = this.now();
      const record = state.leases[leaseId];
      if (!record) {
        throw new ResourceLeaseExpiredError(leaseId);
      }
      if (record.expiresAt <= now) {
        this.expireLeaseInState(state, record, now);
        throw new ResourceLeaseExpiredError(leaseId);
      }
      if (record.workerId !== workerId) {
        throw new StaleFencingTokenError(
          record.resourceKeys[0] ?? leaseId,
          record.fencingToken,
          record.fencingToken,
          `Worker '${workerId}' does not own resource lease '${leaseId}' (owned by '${record.workerId}')`,
        );
      }
      const extension = extendMs ?? record.ttlMs ?? this.defaultTtlMs;
      record.renewedAt = now;
      record.expiresAt = now + extension;
      return toResourceLease(record);
    });
  }

  async heartbeat(leaseId: string, workerId: string, extendMs?: number): Promise<ResourceLease> {
    return this.renew(leaseId, workerId, extendMs);
  }

  async release(leaseId: string, workerId?: string, fencingToken?: number): Promise<void> {
    await this.withSerializedUpdate((state) => {
      const record = state.leases[leaseId];
      if (!record) {
        return;
      }
      if (workerId !== undefined && record.workerId !== workerId) {
        throw new StaleFencingTokenError(
          record.resourceKeys[0] ?? leaseId,
          record.fencingToken,
          fencingToken ?? record.fencingToken,
          `Worker '${workerId}' cannot release lease '${leaseId}' owned by '${record.workerId}'`,
        );
      }
      if (fencingToken !== undefined && fencingToken !== record.fencingToken) {
        throw new StaleFencingTokenError(
          record.resourceKeys[0] ?? leaseId,
          record.fencingToken,
          fencingToken,
          `Fencing token ${fencingToken} does not match lease '${leaseId}' token ${record.fencingToken}`,
        );
      }
      delete state.leases[leaseId];
      state.expiredLeaseIds[leaseId] = {
        expiredAt: this.now(),
        fencingToken: record.fencingToken,
        resourceKeys: [...record.resourceKeys],
      };
      pruneExpiredHistory(state.expiredLeaseIds);
    });
  }

  async validateFence(leaseId: string, workerId: string, fencingToken: number): Promise<void> {
    await this.withSerializedUpdate((state) => {
      const now = this.now();
      const record = state.leases[leaseId];
      if (!record) {
        const former = state.expiredLeaseIds[leaseId];
        if (former) {
          for (const key of former.resourceKeys) {
            const currentToken = this.lookupHighWaterForKey(state, key, true);
            if (currentToken > fencingToken) {
              throw new ResourceLeaseExpiredError(
                leaseId,
                `Resource lease '${leaseId}' expired and resource '${key}' moved to fencing token ${currentToken}`,
              );
            }
          }
        }
        throw new ResourceLeaseExpiredError(leaseId);
      }

      if (record.expiresAt <= now) {
        this.expireLeaseInState(state, record, now);
        throw new ResourceLeaseExpiredError(leaseId);
      }

      if (record.workerId !== workerId) {
        throw new StaleFencingTokenError(
          record.resourceKeys[0] ?? leaseId,
          record.fencingToken,
          fencingToken,
          `Worker '${workerId}' does not own lease '${leaseId}' (owned by '${record.workerId}')`,
        );
      }

      if (!Number.isFinite(fencingToken) || fencingToken !== record.fencingToken) {
        throw new StaleFencingTokenError(
          record.resourceKeys[0] ?? leaseId,
          record.fencingToken,
          fencingToken,
        );
      }

      // Check whether any write-protected key on this lease was superseded externally.
      for (const key of record.writeKeys) {
        const writeToken = this.lookupHighWaterForKey(state, key, true);
        if (writeToken > fencingToken) {
          throw new StaleFencingTokenError(key, writeToken, fencingToken);
        }
      }
    });
  }

  async assertFencedWrite(resourceKey: string, fencingToken: number): Promise<void> {
    await this.withSerializedUpdate((state) => {
      const candidateKeys = this.expandCandidateKeys(resourceKey);
      let highWater = 0;
      let matchedKey = resourceKey;

      for (const candidate of candidateKeys) {
        const token = this.lookupHighWaterForKey(state, candidate, false);
        if (token > highWater) {
          highWater = token;
          matchedKey = candidate;
        }
      }

      if (!Number.isFinite(fencingToken) || fencingToken <= 0 || fencingToken < highWater) {
        throw new StaleFencingTokenError(matchedKey, Math.max(1, highWater), fencingToken);
      }

      const canonicalKey = candidateKeys[0];
      if (fencingToken > (state.fencingCounters[canonicalKey] ?? 0)) {
        state.fencingCounters[canonicalKey] = fencingToken;
      }
      if (fencingToken > (state.writeFencingCounters[canonicalKey] ?? 0)) {
        state.writeFencingCounters[canonicalKey] = fencingToken;
      }
      if (fencingToken > state.globalFencingCounter) {
        state.globalFencingCounter = fencingToken;
      }
    });
  }

  async reclaimExpired(now?: number): Promise<ResourceLease[]> {
    const effectiveNow = now ?? this.now();
    return this.withSerializedUpdate((state) => this.reclaimExpiredInState(state, effectiveNow));
  }

  async listActiveLeases(workflowId?: string): Promise<ResourceLease[]> {
    const state = await this.readCurrentState();
    const now = this.now();
    const active: ResourceLease[] = [];
    for (const record of Object.values(state.leases)) {
      if (record.expiresAt <= now) continue;
      if (workflowId !== undefined && record.workflowId !== workflowId) continue;
      active.push(toResourceLease(record));
    }
    return active.sort((a, b) => a.fencingToken - b.fencingToken);
  }

  private async readCurrentState(): Promise<PersistedReservationState> {
    if (!this.store) {
      return this.memoryState;
    }
    return this.runInQueue(async () => normalizeState(await this.store!.get<PersistedReservationState>(STATE_STORE_KEY)));
  }

  private async withSerializedUpdate<T>(fn: (state: PersistedReservationState) => T): Promise<T> {
    return this.runInQueue(async () => {
      if (!this.store) {
        const draft = structuredClone(this.memoryState);
        const result = fn(draft);
        this.memoryState = draft;
        return result;
      }
      let output!: T;
      await this.store.update<PersistedReservationState>(STATE_STORE_KEY, (current) => {
        const next = normalizeState(current);
        output = fn(next);
        return next;
      });
      return output;
    });
  }

  private async runInQueue<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.stateDir) {
      const next = this.instanceQueue.catch(() => undefined).then(fn);
      this.instanceQueue = next;
      return next;
    }
    const prev = inProcessStateDirQueues.get(this.stateDir) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    inProcessStateDirQueues.set(this.stateDir, next);
    try {
      return await next;
    } finally {
      if (inProcessStateDirQueues.get(this.stateDir) === next) {
        inProcessStateDirQueues.delete(this.stateDir);
      }
    }
  }

  private reclaimExpiredInState(state: PersistedReservationState, now: number): ResourceLease[] {
    const reclaimed: ResourceLease[] = [];
    for (const record of Object.values(state.leases)) {
      if (record.expiresAt <= now) {
        this.expireLeaseInState(state, record, now);
        reclaimed.push(toResourceLease(record));
      }
    }
    return reclaimed;
  }

  private expireLeaseInState(state: PersistedReservationState, record: InternalLeaseRecord, now: number): void {
    delete state.leases[record.leaseId];
    state.expiredLeaseIds[record.leaseId] = {
      expiredAt: now,
      fencingToken: record.fencingToken,
      resourceKeys: [...record.resourceKeys],
    };
    pruneExpiredHistory(state.expiredLeaseIds);
  }

  private normalizeRequest(request: ReservationRequest): {
    gpuSlots: NormalizedGpuSlot[];
    modelSlots: NormalizedModelSlot[];
    computeBudgets: NormalizedComputeBudget[];
    gitRepos: NormalizedPathMode[];
    worktrees: NormalizedPathMode[];
    workspacePaths: NormalizedPathMode[];
    exclusiveResources: string[];
  } {
    const rawGpuSlots = request.gpuSlots ?? (request.gpuSlot ? [request.gpuSlot] : []);
    const gpuSlots: NormalizedGpuSlot[] = rawGpuSlots.map((slot) => {
      if (slot.gpuMemoryGB !== undefined && (!Number.isFinite(slot.gpuMemoryGB) || slot.gpuMemoryGB < 0)) {
        throw new Error(`Invalid gpuMemoryGB '${slot.gpuMemoryGB}'`);
      }
      return {
        key: slot.gpuId !== undefined ? `gpu:${slot.computerId}:${slot.gpuId}` : `gpu:${slot.computerId}`,
        computerId: slot.computerId,
        ...(slot.gpuId !== undefined ? { gpuId: slot.gpuId } : {}),
        ...(slot.gpuMemoryGB !== undefined ? { gpuMemoryGB: slot.gpuMemoryGB } : {}),
        exclusive: slot.gpuMemoryGB === undefined,
      };
    });

    const rawModelSlots = request.modelSlots ?? (request.modelSlot ? [request.modelSlot] : []);
    const modelSlots: NormalizedModelSlot[] = rawModelSlots.map((slot) => {
      const maxSlots = slot.maxConcurrentSlots ?? 1;
      if (!Number.isFinite(maxSlots) || maxSlots < 1) {
        throw new Error(`Invalid maxConcurrentSlots '${maxSlots}'`);
      }
      return {
        key: `model:${slot.runtimeId}:${slot.modelId}`,
        runtimeId: slot.runtimeId,
        modelId: slot.modelId,
        maxConcurrentSlots: maxSlots,
      };
    });

    const rawComputeBudgets = request.computeBudgets ?? (request.computeBudget ? [request.computeBudget] : []);
    const computeBudgets: NormalizedComputeBudget[] = rawComputeBudgets.map((budget) => {
      const cpuCores = budget.cpuCores ?? 0;
      const memoryGB = budget.memoryGB ?? 0;
      if (!Number.isFinite(cpuCores) || cpuCores < 0) {
        throw new Error(`Invalid cpuCores '${cpuCores}'`);
      }
      if (!Number.isFinite(memoryGB) || memoryGB < 0) {
        throw new Error(`Invalid memoryGB '${memoryGB}'`);
      }
      return {
        key: `compute:${budget.computerId}`,
        computerId: budget.computerId,
        cpuCores,
        memoryGB,
      };
    });

    const rawGitRepos = request.gitRepos ?? (request.gitRepo ? [request.gitRepo] : []);
    const gitRepos: NormalizedPathMode[] = rawGitRepos.map((repo) => {
      const canonicalPath = canonicalizePath(repo.repoPath);
      return {
        key: `git-repo:${canonicalPath}`,
        canonicalPath,
        mode: repo.mode ?? 'write',
      };
    });

    const rawWorktrees = request.worktrees ?? (request.worktree ? [request.worktree] : []);
    const worktrees: NormalizedPathMode[] = rawWorktrees.map((wt) => {
      const canonicalPath = canonicalizePath(wt.worktreePath);
      return {
        key: `worktree:${canonicalPath}`,
        canonicalPath,
        mode: wt.mode ?? 'write',
      };
    });

    const workspacePaths: NormalizedPathMode[] = (request.workspacePaths ?? []).map((wp) => {
      const canonicalPath = canonicalizePath(wp.path);
      return {
        key: `workspace:${canonicalPath}`,
        canonicalPath,
        mode: wp.mode,
      };
    });

    const exclusiveResources = [...new Set(request.exclusiveResources ?? [])];

    return {
      gpuSlots,
      modelSlots,
      computeBudgets,
      gitRepos,
      worktrees,
      workspacePaths,
      exclusiveResources,
    };
  }

  private assertNoConflicts(
    state: PersistedReservationState,
    req: ReturnType<ResourceReservationManager['normalizeRequest']>,
  ): void {
    const activeLeases = Object.values(state.leases);

    // 1. GPU slots
    if (req.gpuSlots.length > 0) {
      const addedGpuMemByComputer = new Map<string, number>();
      const addedWholeSlotsByComputer = new Map<string, number>();
      const addedNamedGpusByComputer = new Map<string, Set<string>>();
      const addedExclusiveNamedByComputer = new Map<string, Set<string>>();

      for (const slot of req.gpuSlots) {
        const cap = this.computeCapacities.get(slot.computerId);
        const activeOnComp = activeLeases.flatMap((l) => l.gpuSlots.filter((g) => g.computerId === slot.computerId));

        if (slot.gpuMemoryGB !== undefined) {
          const usedMem =
            activeOnComp.reduce((sum, g) => sum + (g.gpuMemoryGB ?? 0), 0) +
            (addedGpuMemByComputer.get(slot.computerId) ?? 0);
          if (cap) {
            const avail = cap.gpuMemoryGB ?? 0;
            if (usedMem + slot.gpuMemoryGB > avail) {
              throw new ResourceConflictError(
                slot.key,
                `Insufficient GPU memory on '${slot.computerId}': requested ${slot.gpuMemoryGB}GB, used ${usedMem}GB / ${avail}GB`,
              );
            }
          }
          addedGpuMemByComputer.set(slot.computerId, (addedGpuMemByComputer.get(slot.computerId) ?? 0) + slot.gpuMemoryGB);
        }

        if (slot.gpuId !== undefined) {
          const activeSameGpu = activeOnComp.filter((g) => g.gpuId === slot.gpuId);
          const alreadyExclusiveSameGpu =
            activeSameGpu.some((g) => g.exclusive) ||
            (addedExclusiveNamedByComputer.get(slot.computerId)?.has(slot.gpuId) ?? false);
          if (alreadyExclusiveSameGpu || (slot.exclusive && (activeSameGpu.length > 0 || (addedNamedGpusByComputer.get(slot.computerId)?.has(slot.gpuId) ?? false)))) {
            throw new ResourceConflictError(slot.key, `GPU slot '${slot.gpuId}' on '${slot.computerId}' is already leased`);
          }
          const unnamedExclusiveCount =
            activeOnComp.filter((g) => g.gpuId === undefined && g.exclusive).length +
            (addedWholeSlotsByComputer.get(slot.computerId) ?? 0);
          const maxGpus = cap?.gpuCount ?? 1;
          const usedGpuNames = new Set(activeOnComp.map((g) => g.gpuId).filter((id): id is string => id !== undefined));
          for (const extra of addedNamedGpusByComputer.get(slot.computerId) ?? []) {
            usedGpuNames.add(extra);
          }
          const newNamedCount = usedGpuNames.has(slot.gpuId) ? usedGpuNames.size : usedGpuNames.size + 1;
          if (unnamedExclusiveCount + newNamedCount > maxGpus) {
            throw new ResourceConflictError(
              slot.key,
              `GPU slot count exceeded on '${slot.computerId}' (limit ${maxGpus})`,
            );
          }
          const set = addedNamedGpusByComputer.get(slot.computerId) ?? new Set<string>();
          set.add(slot.gpuId);
          addedNamedGpusByComputer.set(slot.computerId, set);
          if (slot.exclusive) {
            const exSet = addedExclusiveNamedByComputer.get(slot.computerId) ?? new Set<string>();
            exSet.add(slot.gpuId);
            addedExclusiveNamedByComputer.set(slot.computerId, exSet);
          }
        } else if (slot.gpuMemoryGB === undefined) {
          const maxGpus = cap?.gpuCount ?? 1;
          const activeUnnamedCount = activeOnComp.filter((g) => g.gpuId === undefined && g.exclusive).length;
          const activeNamedCount = new Set(activeOnComp.map((g) => g.gpuId).filter((id): id is string => id !== undefined)).size;
          const addedNamedCount = addedNamedGpusByComputer.get(slot.computerId)?.size ?? 0;
          const addedWhole = addedWholeSlotsByComputer.get(slot.computerId) ?? 0;
          if (activeUnnamedCount + activeNamedCount + addedNamedCount + addedWhole + 1 > maxGpus) {
            throw new ResourceConflictError(
              slot.key,
              `No free GPU slot available on '${slot.computerId}' (limit ${maxGpus})`,
            );
          }
          addedWholeSlotsByComputer.set(slot.computerId, addedWhole + 1);
        }
      }
    }

    // 2. Model slots
    if (req.modelSlots.length > 0) {
      const addedModelCounts = new Map<string, number>();
      const addedModelLimits = new Map<string, number>();
      for (const slot of req.modelSlots) {
        const activeMatches = activeLeases.flatMap((l) => l.modelSlots.filter((m) => m.key === slot.key));
        const activeCount = activeMatches.length + (addedModelCounts.get(slot.key) ?? 0);
        const minActiveLimit = activeMatches.reduce((min, m) => Math.min(min, m.maxConcurrentSlots), Infinity);
        const minAddedLimit = addedModelLimits.get(slot.key) ?? Infinity;
        const effectiveMax = Math.min(slot.maxConcurrentSlots, minActiveLimit, minAddedLimit);
        if (activeCount + 1 > effectiveMax) {
          throw new ResourceConflictError(
            slot.key,
            `Model concurrency limit reached for '${slot.runtimeId}/${slot.modelId}' (limit ${effectiveMax})`,
          );
        }
        addedModelCounts.set(slot.key, (addedModelCounts.get(slot.key) ?? 0) + 1);
        addedModelLimits.set(slot.key, effectiveMax);
      }
    }

    // 3. Compute budgets
    if (req.computeBudgets.length > 0) {
      const addedCpuByComp = new Map<string, number>();
      const addedMemByComp = new Map<string, number>();
      for (const budget of req.computeBudgets) {
        const cap = this.computeCapacities.get(budget.computerId);
        if (cap) {
          const activeOnComp = activeLeases.flatMap((l) =>
            l.computeBudgets.filter((b) => b.computerId === budget.computerId),
          );
          const usedCpu =
            activeOnComp.reduce((sum, b) => sum + b.cpuCores, 0) + (addedCpuByComp.get(budget.computerId) ?? 0);
          const usedMem =
            activeOnComp.reduce((sum, b) => sum + b.memoryGB, 0) + (addedMemByComp.get(budget.computerId) ?? 0);
          if (budget.cpuCores > 0 && usedCpu + budget.cpuCores > cap.cpuCores) {
            throw new ResourceConflictError(
              budget.key,
              `Insufficient CPU cores on '${budget.computerId}': requested ${budget.cpuCores}, used ${usedCpu}/${cap.cpuCores}`,
            );
          }
          if (budget.memoryGB > 0 && usedMem + budget.memoryGB > cap.memoryGB) {
            throw new ResourceConflictError(
              budget.key,
              `Insufficient memory on '${budget.computerId}': requested ${budget.memoryGB}GB, used ${usedMem}GB/${cap.memoryGB}GB`,
            );
          }
        }
        addedCpuByComp.set(budget.computerId, (addedCpuByComp.get(budget.computerId) ?? 0) + budget.cpuCores);
        addedMemByComp.set(budget.computerId, (addedMemByComp.get(budget.computerId) ?? 0) + budget.memoryGB);
      }
    }

    // 4. Git repos
    for (const repo of req.gitRepos) {
      for (const lease of activeLeases) {
        for (const existing of lease.gitRepos) {
          if (existing.canonicalPath === repo.canonicalPath && (repo.mode === 'write' || existing.mode === 'write')) {
            throw new ResourceConflictError(
              repo.canonicalPath,
              `Git repository '${repo.canonicalPath}' is already locked (${existing.mode}) by worker '${lease.workerId}'`,
            );
          }
        }
      }
    }

    // 5. Worktrees
    for (const wt of req.worktrees) {
      for (const lease of activeLeases) {
        for (const existing of lease.worktrees) {
          if (existing.canonicalPath === wt.canonicalPath && (wt.mode === 'write' || existing.mode === 'write')) {
            throw new ResourceConflictError(
              wt.canonicalPath,
              `Git worktree '${wt.canonicalPath}' is already locked (${existing.mode}) by worker '${lease.workerId}'`,
            );
          }
        }
      }
    }

    // 6. Mutable workspace paths (ancestor/descendant overlap)
    for (const wp of req.workspacePaths) {
      for (const lease of activeLeases) {
        for (const existing of lease.workspacePaths) {
          if (pathsOverlap(wp.canonicalPath, existing.canonicalPath)) {
            if (wp.mode === 'write' || existing.mode === 'write') {
              throw new ResourceConflictError(
                wp.canonicalPath,
                `Workspace path '${wp.canonicalPath}' (${wp.mode}) conflicts with active ${existing.mode} lock on '${existing.canonicalPath}' held by '${lease.workerId}'`,
              );
            }
          }
        }
      }
    }

    // 7. Exclusive external resources
    for (const resName of req.exclusiveResources) {
      for (const lease of activeLeases) {
        if (lease.exclusiveResources.includes(resName)) {
          throw new ResourceConflictError(
            resName,
            `Exclusive resource '${resName}' is already leased by worker '${lease.workerId}'`,
          );
        }
      }
    }
  }

  private collectResourceKeys(req: ReturnType<ResourceReservationManager['normalizeRequest']>): string[] {
    const keys: string[] = [];
    for (const g of req.gpuSlots) keys.push(g.key);
    for (const m of req.modelSlots) keys.push(m.key);
    for (const c of req.computeBudgets) keys.push(c.key);
    for (const r of req.gitRepos) keys.push(r.key);
    for (const w of req.worktrees) keys.push(w.key);
    for (const p of req.workspacePaths) keys.push(p.key);
    for (const e of req.exclusiveResources) keys.push(`exclusive:${e}`);
    return [...new Set(keys)];
  }

  private collectWriteKeys(req: ReturnType<ResourceReservationManager['normalizeRequest']>): string[] {
    const keys: string[] = [];
    for (const g of req.gpuSlots) {
      if (g.exclusive) keys.push(g.key);
    }
    for (const r of req.gitRepos) {
      if (r.mode === 'write') keys.push(r.key);
    }
    for (const w of req.worktrees) {
      if (w.mode === 'write') keys.push(w.key);
    }
    for (const p of req.workspacePaths) {
      if (p.mode === 'write') keys.push(p.key);
    }
    for (const e of req.exclusiveResources) keys.push(`exclusive:${e}`);
    return [...new Set(keys)];
  }

  private maxTokenForKeys(
    state: PersistedReservationState,
    keys: string[],
    workspacePaths: NormalizedPathMode[],
  ): number {
    let maxToken = 0;
    for (const key of keys) {
      const val = state.fencingCounters[key] ?? 0;
      if (val > maxToken) maxToken = val;
    }
    if (workspacePaths.length > 0) {
      for (const [k, v] of Object.entries(state.fencingCounters)) {
        const existingPath = extractWorkspacePathFromKey(k);
        if (!existingPath) continue;
        if (workspacePaths.some((wp) => pathsOverlap(wp.canonicalPath, existingPath))) {
          if (v > maxToken) maxToken = v;
        }
      }
    }
    return maxToken;
  }

  private lookupHighWaterForKey(state: PersistedReservationState, key: string, writeOnly: boolean): number {
    const table = writeOnly ? state.writeFencingCounters : state.fencingCounters;
    let maxVal = table[key] ?? 0;
    const wsPath = extractWorkspacePathFromKey(key);
    if (wsPath) {
      for (const [k, v] of Object.entries(table)) {
        const otherPath = extractWorkspacePathFromKey(k);
        if (otherPath && pathsOverlap(wsPath, otherPath) && v > maxVal) {
          maxVal = v;
        }
      }
    }
    return maxVal;
  }

  private expandCandidateKeys(resourceKey: string): string[] {
    const hasKnownPrefix = KNOWN_KEY_PREFIXES.some((prefix) => resourceKey.startsWith(prefix));
    if (hasKnownPrefix) {
      const wsPath = extractWorkspacePathFromKey(resourceKey);
      if (wsPath) {
        return [`workspace:${canonicalizePath(wsPath)}`, resourceKey];
      }
      return [resourceKey];
    }
    const canonical = canonicalizePath(resourceKey);
    return [
      resourceKey,
      `exclusive:${resourceKey}`,
      `workspace:${canonical}`,
      `git-repo:${canonical}`,
      `worktree:${canonical}`,
    ];
  }
}

export function createResourceReservationManager(
  options: ResourceReservationManagerOptions = {},
): ResourceReservationManager {
  return new ResourceReservationManager(options);
}
