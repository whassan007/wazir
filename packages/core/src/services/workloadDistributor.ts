import type { RoutingMode, ExecutionPreferences } from '../types/task.js';

export type WorkloadPoolKind =
  | 'local'
  | 'antigravity'
  | 'codex'
  | 'claude-code'
  | 'qwen-code'
  | 'qwen'
  | 'qwen-acp'
  | 'remote'
  | 'hosted'
  | 'auto';

export interface WorkloadShare {
  pool: WorkloadPoolKind | string;
  weight: number;
}

export interface WorkloadDistributionConfig {
  /** Weighted shares across hardware and agent pools, e.g. local:70, antigravity:15, codex:5 (+ auto:10). */
  shares: WorkloadShare[];
}

export interface AvailableWorkloadPools {
  /** True when at least one local/cluster hardware model or worker is online. */
  hasLocalHardware: boolean;
  /** Computer IDs available in the cluster (local workstation + remote nodes such as DGX). */
  hardwareComputerIds?: string[];
  /** Registered external/delegated agent IDs (e.g. 'antigravity', 'codex', 'claude-code'). */
  externalAgents: ReadonlySet<string> | readonly string[];
  /** Active routing mode constraint; LOCAL_ONLY and PROVIDER_ONLY forbid external agents. */
  routingMode?: RoutingMode;
  /** Explicit model or agent pin — always overrides weighted distribution. */
  pinnedModelId?: string;
  pinnedAgentId?: string;
}

export interface AllocatedWorkloadTarget {
  pool: string;
  targetAgentId?: string;
  targetComputerId?: string;
  routingMode?: RoutingMode;
  reason: string;
}

/**
 * Default fleet hardware & agent distribution requested for multi-hardware/multi-agent balance:
 * - 70% local hardware (local workstation / cluster GPU nodes)
 * - 15% Antigravity (`agy` ACP / headless agent)
 * - 5% Codex (`codex` ACP / CLI agent)
 * - 10% auto-routed scheduler reserve (overflow across all eligible local/remote/hosted capacity)
 */
export const DEFAULT_HARDWARE_DISTRIBUTION: WorkloadDistributionConfig = {
  shares: [
    { pool: 'local', weight: 70 },
    { pool: 'antigravity', weight: 15 },
    { pool: 'codex', weight: 5 },
    { pool: 'auto', weight: 10 },
  ],
};

export const DEFAULT_WORKLOAD_DISTRIBUTION = DEFAULT_HARDWARE_DISTRIBUTION;

/**
 * Resolves an external agent pool alias (such as `'qwen'`, `'qwen-code'`, `'qwen-acp'`,
 * `'agy'`, `'claude'`) against the registered external agent IDs.
 */
export function resolveMatchingExternalAgent(
  pool: string,
  externalAgents: ReadonlySet<string> | readonly string[],
): string | undefined {
  const extSet =
    externalAgents instanceof Set ? externalAgents : new Set(externalAgents);
  const key = pool.trim().toLowerCase();
  if (!key) return undefined;

  if (key === 'antigravity' || key === 'agy') {
    if (extSet.has('antigravity')) return 'antigravity';
    if (extSet.has('agy')) return 'agy';
    return undefined;
  }
  if (key === 'qwen' || key === 'qwen-code' || key === 'qwen-acp') {
    if (extSet.has('qwen-code')) return 'qwen-code';
    if (extSet.has('qwen')) return 'qwen';
    if (extSet.has('qwen-acp')) return 'qwen-acp';
    return undefined;
  }
  if (key === 'claude' || key === 'claude-code') {
    if (extSet.has('claude-code')) return 'claude-code';
    if (extSet.has('claude')) return 'claude';
    return undefined;
  }
  if (key === 'codex' || key === 'codex-acp') {
    if (extSet.has('codex')) return 'codex';
    if (extSet.has('codex-acp')) return 'codex-acp';
    return undefined;
  }
  if (extSet.has(key)) return key;
  if (extSet.has(pool)) return pool;
  return undefined;
}

export function matchesAgentPool(
  pool: string,
  externalAgents: ReadonlySet<string> | readonly string[],
): boolean {
  return resolveMatchingExternalAgent(pool, externalAgents) !== undefined;
}

/**
 * Parses a compact distribution spec such as `"local:70,antigravity:15,codex:5"`.
 * Unallocated percentage below 100 automatically flows into the `auto` scheduler pool
 * unless the caller explicitly specifies `auto:0`.
 */
function normalizeShares(shares: readonly WorkloadShare[]): WorkloadShare[] {
  const merged = new Map<string, number>();
  for (const s of shares) {
    if (!Number.isFinite(s.weight) || s.weight <= 0) continue;
    const key = s.pool.trim().toLowerCase();
    if (!key) continue;
    merged.set(key, Math.round(((merged.get(key) ?? 0) + s.weight) * 100) / 100);
  }
  return [...merged.entries()].map(([pool, weight]) => ({ pool, weight }));
}

export function parseWorkloadDistribution(spec: string): WorkloadDistributionConfig {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error('Distribution specification cannot be empty (example: "local:70,antigravity:15,codex:5").');
  }
  const rawShares: WorkloadShare[] = [];
  let hasExplicitAuto = false;
  for (const rawPart of trimmed.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = /^([a-zA-Z0-9_-]+)\s*[:=]\s*(\d+(?:\.\d+)?)%?$/.exec(part);
    if (!match) {
      throw new Error(
        `Invalid distribution entry '${part}'. Expected '<pool>:<weight>' such as 'local:70,antigravity:15,codex:5'.`,
      );
    }
    const pool = match[1]!.toLowerCase();
    const weight = Number(match[2]);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`Invalid weight '${match[2]}' for pool '${pool}'. Weight must be a non-negative number.`);
    }
    if (pool === 'auto') hasExplicitAuto = true;
    if (weight > 0) {
      rawShares.push({ pool, weight });
    }
  }
  const shares = normalizeShares(rawShares);
  if (shares.length === 0) {
    throw new Error('Distribution specification must include at least one positive weight.');
  }
  const total = shares.reduce((sum, s) => sum + s.weight, 0);
  if (!hasExplicitAuto && total < 100) {
    shares.push({ pool: 'auto', weight: Math.round((100 - total) * 100) / 100 });
  }
  return { shares: normalizeShares(shares) };
}

export function formatWorkloadDistribution(config: WorkloadDistributionConfig): string {
  const total = config.shares.reduce((sum, s) => sum + s.weight, 0) || 1;
  return config.shares
    .filter((s) => s.weight > 0)
    .map((s) => `${s.pool} ${Math.round((s.weight / total) * 100)}%`)
    .join(' · ');
}

/**
 * Deterministic Smooth Weighted Round-Robin (Nginx SWRR) distributor across hardware
 * computers and delegated external agents (`antigravity`, `codex`, etc.).
 *
 * Respects hard policy and pin invariants:
 * - Explicit `pinnedModelId` or `pinnedAgentId` is never overridden.
 * - `LOCAL_ONLY` and `PROVIDER_ONLY` / `NVIDIA` routing modes never dispatch to external agents.
 * - Offline/uninstalled pools are filtered out and remaining eligible weights re-normalize cleanly.
 */
export class WorkloadDistributor {
  private readonly currentWeights = new Map<string, number>();
  private hardwareCursor = 0;

  private config: WorkloadDistributionConfig;

  constructor(config: WorkloadDistributionConfig = DEFAULT_HARDWARE_DISTRIBUTION) {
    this.config = { shares: normalizeShares(config.shares) };
  }

  getConfig(): WorkloadDistributionConfig {
    return this.config;
  }

  setConfig(config: WorkloadDistributionConfig): void {
    this.config = { shares: normalizeShares(config.shares) };
    this.currentWeights.clear();
  }

  eligibleShares(available: AvailableWorkloadPools): WorkloadShare[] {
    const extSet =
      available.externalAgents instanceof Set
        ? available.externalAgents
        : new Set(available.externalAgents);
    const forbidExternal =
      available.routingMode === 'LOCAL_ONLY' ||
      available.routingMode === 'PROVIDER_ONLY' ||
      available.routingMode === 'NVIDIA';

    const eligible = this.config.shares.filter((share) => {
      if (share.weight <= 0) return false;
      if (share.pool === 'local') {
        return available.hasLocalHardware || (available.hardwareComputerIds?.length ?? 0) > 0;
      }
      if (share.pool === 'auto') {
        return available.hasLocalHardware || (!forbidExternal && extSet.size > 0);
      }
      return !forbidExternal && matchesAgentPool(share.pool, extSet);
    });

    if (eligible.length > 0) return eligible;
    return [{ pool: 'auto', weight: 100 }];
  }

  next(available: AvailableWorkloadPools): AllocatedWorkloadTarget {
    const forbidExternal =
      available.routingMode === 'LOCAL_ONLY' ||
      available.routingMode === 'PROVIDER_ONLY' ||
      available.routingMode === 'NVIDIA';

    if (available.pinnedAgentId && !forbidExternal) {
      const resolvedPin =
        resolveMatchingExternalAgent(available.pinnedAgentId, available.externalAgents) ??
        available.pinnedAgentId;
      return {
        pool: resolvedPin,
        targetAgentId: resolvedPin,
        routingMode: available.routingMode,
        reason: `explicit agent pin (${resolvedPin})`,
      };
    }
    if (available.pinnedModelId) {
      return {
        pool: 'pinned-model',
        routingMode: available.routingMode,
        reason: `explicit model pin (${available.pinnedModelId})`,
      };
    }

    const shares = this.eligibleShares(available);
    let totalWeight = 0;
    let bestPool = shares[0]!;
    let bestCurrent = -Infinity;

    for (const share of shares) {
      totalWeight += share.weight;
      const nextWeight = (this.currentWeights.get(share.pool) ?? 0) + share.weight;
      this.currentWeights.set(share.pool, nextWeight);
      if (nextWeight > bestCurrent) {
        bestCurrent = nextWeight;
        bestPool = share;
      }
    }

    this.currentWeights.set(bestPool.pool, bestCurrent - totalWeight);
    return this.materializeTarget(bestPool, totalWeight, available);
  }

  allocateBatch(count: number, available: AvailableWorkloadPools): AllocatedWorkloadTarget[] {
    const out: AllocatedWorkloadTarget[] = [];
    for (let i = 0; i < count; i++) {
      out.push(this.next(available));
    }
    return out;
  }

  applyToExecutionPreferences(
    base: ExecutionPreferences | undefined,
    available: AvailableWorkloadPools,
  ): ExecutionPreferences {
    if (base?.targetModelId || base?.targetAgentId || available.pinnedModelId || available.pinnedAgentId) {
      return {
        ...base,
        ...(available.pinnedModelId && !base?.targetModelId ? { targetModelId: available.pinnedModelId } : {}),
        ...(available.pinnedAgentId && !base?.targetAgentId ? { targetAgentId: available.pinnedAgentId } : {}),
        ...(available.routingMode && !base?.routingMode ? { routingMode: available.routingMode } : {}),
      };
    }
    const target = this.next(available);
    return {
      ...base,
      ...(target.targetAgentId ? { targetAgentId: target.targetAgentId } : {}),
      ...(target.targetComputerId && !base?.targetComputerId ? { targetComputerId: target.targetComputerId } : {}),
      ...(target.routingMode ?? available.routingMode ? { routingMode: target.routingMode ?? available.routingMode } : {}),
    };
  }

  private materializeTarget(
    chosen: WorkloadShare,
    totalWeight: number,
    available: AvailableWorkloadPools,
  ): AllocatedWorkloadTarget {
    const sharePct = Math.round((chosen.weight / Math.max(1, totalWeight)) * 100);
    const computers = available.hardwareComputerIds ?? [];
    if (chosen.pool === 'local') {
      const targetComputerId =
        computers.length > 1 ? computers[this.hardwareCursor++ % computers.length] : computers[0];
      return {
        pool: 'local',
        targetComputerId,
        routingMode: available.routingMode ?? 'LOCAL_ONLY',
        reason: `weighted distribution selected local hardware (${sharePct}% share${targetComputerId ? ` on ${targetComputerId}` : ''})`,
      };
    }
    if (chosen.pool === 'antigravity' || chosen.pool === 'agy') {
      const targetAgentId = resolveMatchingExternalAgent(chosen.pool, available.externalAgents) ?? 'antigravity';
      return {
        pool: 'antigravity',
        targetAgentId,
        routingMode: available.routingMode,
        reason: `weighted distribution selected Antigravity (${sharePct}% share)`,
      };
    }
    if (chosen.pool === 'codex' || chosen.pool === 'codex-acp') {
      const targetAgentId = resolveMatchingExternalAgent(chosen.pool, available.externalAgents) ?? 'codex';
      return {
        pool: 'codex',
        targetAgentId,
        routingMode: available.routingMode,
        reason: `weighted distribution selected Codex (${sharePct}% share)`,
      };
    }
    if (chosen.pool === 'qwen' || chosen.pool === 'qwen-code' || chosen.pool === 'qwen-acp') {
      const targetAgentId = resolveMatchingExternalAgent(chosen.pool, available.externalAgents) ?? 'qwen-code';
      return {
        pool: 'qwen-code',
        targetAgentId,
        routingMode: available.routingMode,
        reason: `weighted distribution selected Qwen Code (${sharePct}% share)`,
      };
    }
    if (chosen.pool === 'claude' || chosen.pool === 'claude-code') {
      const targetAgentId = resolveMatchingExternalAgent(chosen.pool, available.externalAgents) ?? 'claude-code';
      return {
        pool: 'claude-code',
        targetAgentId,
        routingMode: available.routingMode,
        reason: `weighted distribution selected Claude Code (${sharePct}% share)`,
      };
    }
    if (chosen.pool === 'auto') {
      return {
        pool: 'auto',
        routingMode: available.routingMode,
        reason: `weighted distribution selected scheduler auto-route (${sharePct}% share)`,
      };
    }
    const resolvedTarget = resolveMatchingExternalAgent(chosen.pool, available.externalAgents) ?? chosen.pool;
    return {
      pool: chosen.pool,
      targetAgentId: resolvedTarget,
      routingMode: available.routingMode,
      reason: `weighted distribution selected ${chosen.pool} (${sharePct}% share)`,
    };
  }
}
