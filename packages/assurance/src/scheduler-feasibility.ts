/**
 * Scheduler feasibility & tool-capability integration for Formal Assurance
 * (docs/formal-assurance/FORMAL_ASSURANCE.md §2.4, DESIGN.md §2.2).
 *
 * Responsibilities:
 *  - Map `FormalTool` / `Obligation` to pinned tool capability strings (`tool:z3`, `tool:alloy`,
 *    `tool:dafny`, `tool:scenic`, `tool:verifai`, `tool:verifai.simulator`, `tool:gam`).
 *  - Advertise host capabilities from `ToolAvailability` / `DoctorReport` probes into `Computer.capabilities`.
 *  - Extend host feasibility set `F(t)` so a `Computer` host is in `F(t)` iff it advertises all
 *    required pinned tool capabilities (plus OS/arch/memory/policy constraints).
 *  - Score and prefer DGX/GX10-class unified memory hosts (`gb10`, `dgx`, NVIDIA unified memory)
 *    for heavy obligations (`verifai`, large `alloy` scopes, or `preferHostClass: 'dgx'`), while
 *    allowing small Z3 checks to run on any feasible host.
 *  - Bypass the model router (`routeModel`) for verification/solver tasks so zero model capacity
 *    is consumed.
 *  - Return an explicit `Verdict.NOT_RUN` unschedulable outcome when no host in the fleet has the
 *    required tool capability (never silently skipping or dispatching to an incapable host).
 */

import {
  FORMAL_TOOLS,
  type FormalTool,
  type Obligation,
  type ToolAvailability,
  Verdict,
  type VerificationResult,
} from './contracts';

export const TOOL_CAPABILITY_PREFIX = 'tool:' as const;

export const FORMAL_TOOL_CAPABILITIES = [
  'tool:z3',
  'tool:alloy',
  'tool:dafny',
  'tool:scenic',
  'tool:verifai',
  'tool:verifai.simulator',
  'tool:gam',
] as const;

export type FormalToolCapability = (typeof FORMAL_TOOL_CAPABILITIES)[number] | `tool:${string}`;

export type HostClassPreference = 'dgx' | 'any';

/** Default Alloy scope bound at or above which an obligation prefers a DGX/GX10-class host. */
export const DEFAULT_HEAVY_ALLOY_SCOPE_THRESHOLD = 6;

/** Minimal host representation compatible with `@wazir/core` `Computer`. */
export interface FeasibilityHost {
  id: string;
  name?: string;
  status?: 'online' | 'offline' | 'maintenance';
  local?: boolean;
  os?: {
    platform: string;
    architecture: string;
    version?: string;
  };
  hardware?: {
    cpu?: string;
    cpuCores?: number;
    memoryGB?: number;
    gpu?: {
      vendor?: 'apple' | 'nvidia' | 'amd' | 'intel' | 'unknown' | string;
      model?: string;
      memoryGB?: number;
      unifiedMemory?: boolean;
      cuda?: boolean;
    };
  };
  capabilities: string[];
  load?: {
    cpuPercent?: number;
    memoryAvailableGB?: number;
    gpuMemoryAvailableGB?: number;
    gpuMemoryUsedGB?: number;
  };
  health?: 'healthy' | 'degraded' | 'unavailable';
}

/** Task representation compatible with `@wazir/core` `Task`. */
export interface VerificationTaskLike {
  id: string;
  type?: string;
  role?: string;
  title?: string;
  input?: string;
  capabilities?: string[];
  requirements?: {
    toolCapabilities?: string[];
    agentCapabilities?: string[];
    capabilities?: string[];
    preferHostClass?: HostClassPreference;
    scope?: string | number;
    os?: string | string[];
    architecture?: string | string[];
    requiresGpu?: boolean;
    requiresCuda?: boolean;
    minimumMemoryGB?: number;
    minimumGPUMemoryGB?: number;
    localOnly?: boolean;
    agent?: string;
  };
  policy?: {
    allowedComputers?: string[];
    localOnly?: boolean;
  };
  execution?: {
    targetComputerId?: string;
    targetAgentId?: string;
    preferHostClass?: HostClassPreference;
  };
  assurance?: {
    obligationId?: string;
    propertyId?: string;
    specHash?: string;
    tool?: FormalTool | string;
    scope?: string | number;
    heavy?: boolean;
    requiresSimulator?: boolean;
    preferHostClass?: HostClassPreference;
  };
}

export interface HostFeasibilityEvaluation {
  hostId: string;
  feasible: boolean;
  isDgxClass: boolean;
  score: number;
  matchedCapabilities: string[];
  missingCapabilities: string[];
  reasons: string[];
  rejectionReasons: string[];
}

export interface ObligationScheduleOutcome {
  schedulable: boolean;
  verdict?: Verdict.NOT_RUN;
  selectedHostId?: string;
  selectedHost?: FeasibilityHost;
  selectedHostIsDgx?: boolean;
  preferDgx: boolean;
  bypassesModelRouter: true;
  modelId: undefined;
  modelCapacityConsumed: 0;
  requiredToolCapabilities: string[];
  missingCapabilities: string[];
  feasibleHosts: HostFeasibilityEvaluation[];
  rejectedHosts: HostFeasibilityEvaluation[];
  reasons: string[];
}

export function normalizePlatform(p: string): string {
  const s = p.toLowerCase().trim();
  if (['darwin', 'macos', 'mac', 'osx'].includes(s)) return 'darwin';
  if (['win32', 'windows', 'win'].includes(s)) return 'win32';
  if (['linux', 'ubuntu', 'debian'].includes(s)) return 'linux';
  return s;
}

export function normalizeArch(a: string): string {
  const s = a.toLowerCase().trim();
  if (['arm64', 'aarch64'].includes(s)) return 'arm64';
  if (['x64', 'x86_64', 'amd64'].includes(s)) return 'x64';
  return s;
}

/**
 * Normalizes a tool or capability identifier to the canonical `tool:<name>` format.
 */
export function toToolCapability(toolOrCap: FormalTool | string): FormalToolCapability {
  const trimmed = toolOrCap.trim().toLowerCase();
  if (trimmed.startsWith(TOOL_CAPABILITY_PREFIX)) {
    return trimmed as FormalToolCapability;
  }
  return `${TOOL_CAPABILITY_PREFIX}${trimmed}` as FormalToolCapability;
}

/**
 * Computes the list of `tool:*` capabilities advertised by a host given its probed tool availability map.
 */
export function advertiseHostToolCapabilities(
  availability: Partial<Record<FormalTool | 'verifai.simulator', ToolAvailability | boolean>>,
): FormalToolCapability[] {
  const advertised: FormalToolCapability[] = [];
  for (const tool of FORMAL_TOOLS) {
    const entry = availability[tool];
    const isAvail = typeof entry === 'boolean' ? entry : Boolean(entry?.available);
    if (isAvail) {
      advertised.push(toToolCapability(tool));
    }
  }
  const simEntry = availability['verifai.simulator'];
  const simAvail = typeof simEntry === 'boolean' ? simEntry : Boolean(simEntry?.available);
  if (simAvail) {
    advertised.push('tool:verifai.simulator');
  }
  return advertised;
}

/**
 * Extracts all required `tool:*` capabilities from an `Obligation` or `VerificationTaskLike`.
 */
export function getRequiredToolCapabilities(
  target: Obligation | VerificationTaskLike,
): FormalToolCapability[] {
  const caps = new Set<FormalToolCapability>();

  if ('artifactPath' in target && 'tool' in target && typeof target.tool === 'string') {
    // It's an Obligation
    caps.add(toToolCapability(target.tool));
    const meta = target.metadata ?? {};
    if (meta.requiresSimulator === true || meta.simulator === true) {
      caps.add('tool:verifai.simulator');
    }
    if (Array.isArray(meta.toolCapabilities)) {
      for (const c of meta.toolCapabilities) {
        if (typeof c === 'string' && c.trim()) {
          caps.add(toToolCapability(c));
        }
      }
    }
    return Array.from(caps);
  }

  const task = target as VerificationTaskLike;
  for (const c of task.requirements?.toolCapabilities ?? []) {
    if (c && c.trim()) caps.add(toToolCapability(c));
  }
  for (const c of task.requirements?.agentCapabilities ?? []) {
    if (c && c.trim().toLowerCase().startsWith(TOOL_CAPABILITY_PREFIX)) {
      caps.add(toToolCapability(c));
    }
  }
  for (const c of task.capabilities ?? []) {
    if (c && c.trim().toLowerCase().startsWith(TOOL_CAPABILITY_PREFIX)) {
      caps.add(toToolCapability(c));
    }
  }
  if (task.assurance?.tool) {
    caps.add(toToolCapability(task.assurance.tool));
  }
  if (task.assurance?.requiresSimulator) {
    caps.add('tool:verifai.simulator');
  }

  return Array.from(caps);
}

/**
 * Parses the maximum numeric scope bound from an Alloy scope string (e.g. `"for 8 but 5 Int, 1..10 steps"` -> `10`).
 */
export function parseMaxScopeBound(scope?: string | number): number {
  if (typeof scope === 'number') return Number.isFinite(scope) ? scope : 0;
  if (typeof scope !== 'string' || !scope.trim()) return 0;
  const nums = scope.match(/\d+/g);
  if (!nums || nums.length === 0) return 0;
  return Math.max(...nums.map((n) => parseInt(n, 10)).filter(Number.isFinite));
}

/**
 * Determines whether an obligation or verification task is a heavy campaign
 * (`verifai`, large `alloy` scope >= threshold, or explicit `preferHostClass: 'dgx'`).
 * Small Z3 checks return `false` and can run on any feasible host.
 */
export function isHeavyObligation(
  target: Obligation | VerificationTaskLike,
  alloyScopeThreshold: number = DEFAULT_HEAVY_ALLOY_SCOPE_THRESHOLD,
): boolean {
  if ('artifactPath' in target && 'tool' in target && typeof target.tool === 'string') {
    const ob = target as Obligation;
    const meta = ob.metadata ?? {};
    if (meta.preferHostClass === 'dgx' || meta.heavy === true) return true;
    if (meta.preferHostClass === 'any') return false;
    if (ob.tool === 'verifai') return true;
    if (ob.tool === 'alloy' && parseMaxScopeBound(ob.scope) >= alloyScopeThreshold) {
      return true;
    }
    return false;
  }

  const task = target as VerificationTaskLike;
  const explicitPref =
    task.requirements?.preferHostClass ??
    task.execution?.preferHostClass ??
    task.assurance?.preferHostClass;
  if (explicitPref === 'dgx') return true;
  if (explicitPref === 'any') return false;
  if (task.assurance?.heavy === true) return true;

  const caps = getRequiredToolCapabilities(task);
  if (caps.includes('tool:verifai') || caps.includes('tool:verifai.simulator')) {
    return true;
  }
  const scopeVal = task.assurance?.scope ?? task.requirements?.scope;
  if (caps.includes('tool:alloy') && parseMaxScopeBound(scopeVal) >= alloyScopeThreshold) {
    return true;
  }
  if (scopeVal !== undefined && parseMaxScopeBound(scopeVal) >= alloyScopeThreshold) {
    return true;
  }
  return false;
}

/**
 * Returns true if the host is a DGX / GX10 / GB10 / NVIDIA unified-memory class host.
 */
export function isDgxClassHost(host: FeasibilityHost): boolean {
  const idName = `${host.id} ${host.name ?? ''}`.toLowerCase();
  if (/\b(dgx|gx10|gb10|spark)\b/.test(idName)) return true;
  const gpu = host.hardware?.gpu;
  if (gpu) {
    const model = (gpu.model ?? '').toLowerCase();
    if (/\b(gb10|gx10|dgx|grace\s*blackwell|gh200|gb200|h100|h200|b200)\b/.test(model)) {
      return true;
    }
    if ((gpu.vendor ?? '').toLowerCase() === 'nvidia' && gpu.unifiedMemory === true) {
      return true;
    }
  }
  const caps = (host.capabilities ?? []).map((c) => c.toLowerCase());
  return caps.some(
    (c) =>
      c === 'host:dgx' ||
      c === 'host:gx10' ||
      c === 'host:gb10' ||
      c === 'dgx' ||
      c === 'gx10' ||
      c === 'gb10',
  );
}

/**
 * Returns true when a task is a verification / solver task that must bypass the LLM model router.
 */
export function shouldBypassModelRouter(task: VerificationTaskLike): boolean {
  return task.type === 'verification' || task.role === 'verification';
}

/**
 * Converts an `Obligation` into a `VerificationTaskLike` node suitable for the Wazir DAG and `Scheduler`.
 */
export function obligationToVerificationTask(
  obligation: Obligation,
  options?: {
    preferHostClass?: HostClassPreference;
    requiresSimulator?: boolean;
    alloyScopeThreshold?: number;
  },
): VerificationTaskLike & { type: 'verification'; role: 'verification' } {
  const toolCaps = getRequiredToolCapabilities(obligation);
  if (options?.requiresSimulator && !toolCaps.includes('tool:verifai.simulator')) {
    toolCaps.push('tool:verifai.simulator');
  }
  const heavy = isHeavyObligation(obligation, options?.alloyScopeThreshold);
  const preferHostClass: HostClassPreference | undefined =
    options?.preferHostClass ?? (heavy ? 'dgx' : undefined);

  return {
    id: `verify:${obligation.id}`,
    type: 'verification',
    role: 'verification',
    title: `Verify ${obligation.propertyId} (${obligation.tool})`,
    input: `Run formal verification obligation ${obligation.id} for property ${obligation.propertyId} using ${obligation.tool} on ${obligation.artifactPath}`,
    capabilities: [...toolCaps],
    requirements: {
      toolCapabilities: [...toolCaps],
      preferHostClass,
      scope: obligation.scope,
      minimumMemoryGB: obligation.memoryLimitMb ? Math.ceil(obligation.memoryLimitMb / 1024) : undefined,
    },
    assurance: {
      obligationId: obligation.id,
      propertyId: obligation.propertyId,
      specHash: obligation.specHash,
      tool: obligation.tool,
      scope: obligation.scope,
      heavy,
      requiresSimulator: options?.requiresSimulator,
      preferHostClass,
    },
  };
}

/**
 * Evaluates whether a single `FeasibilityHost` belongs to the feasibility set `F(t)` for a
 * verification task or obligation, and computes its placement score.
 */
export function evaluateHostFeasibility(
  host: FeasibilityHost,
  target: Obligation | VerificationTaskLike,
  options?: { alloyScopeThreshold?: number },
): HostFeasibilityEvaluation {
  const task: VerificationTaskLike =
    'artifactPath' in target && 'tool' in target
      ? obligationToVerificationTask(target as Obligation, {
          alloyScopeThreshold: options?.alloyScopeThreshold,
        })
      : (target as VerificationTaskLike);

  const requiredCaps = getRequiredToolCapabilities(task);
  const preferDgx = isHeavyObligation(task, options?.alloyScopeThreshold);
  const dgx = isDgxClassHost(host);

  const rejectionReasons: string[] = [];
  const reasons: string[] = [];

  if (host.status && host.status !== 'online') {
    rejectionReasons.push(`${host.id}: host status is '${host.status}' (must be online)`);
  }
  if (host.health === 'unavailable') {
    rejectionReasons.push(`${host.id}: host health is 'unavailable'`);
  }

  if (task.execution?.targetComputerId && host.id !== task.execution.targetComputerId) {
    rejectionReasons.push(
      `${host.id}: does not match pinned targetComputerId '${task.execution.targetComputerId}'`,
    );
  }

  if (task.policy?.allowedComputers && !task.policy.allowedComputers.includes(host.id)) {
    rejectionReasons.push(`${host.id}: not in policy allowedComputers`);
  }

  if ((task.policy?.localOnly || task.requirements?.localOnly) && !host.local) {
    rejectionReasons.push(`${host.id}: localOnly policy requires a local host`);
  }

  if (task.requirements?.os && host.os?.platform) {
    const rawOs = task.requirements.os;
    const reqList = (Array.isArray(rawOs) ? rawOs : [rawOs]).map(normalizePlatform);
    const hostOs = normalizePlatform(host.os.platform);
    if (!reqList.includes(hostOs)) {
      rejectionReasons.push(
        `${host.id}: OS '${host.os.platform}' does not match required '${Array.isArray(rawOs) ? rawOs.join(',') : rawOs}'`,
      );
    }
  }

  if (task.requirements?.architecture && host.os?.architecture) {
    const rawArch = task.requirements.architecture;
    const reqList = (Array.isArray(rawArch) ? rawArch : [rawArch]).map(normalizeArch);
    const hostArch = normalizeArch(host.os.architecture);
    if (!reqList.includes(hostArch)) {
      rejectionReasons.push(
        `${host.id}: architecture '${host.os.architecture}' does not match required '${Array.isArray(rawArch) ? rawArch.join(',') : rawArch}'`,
      );
    }
  }

  if (task.requirements?.requiresGpu && !host.hardware?.gpu) {
    rejectionReasons.push(`${host.id}: task requires GPU, but host has no GPU`);
  }
  if (task.requirements?.requiresCuda && (!host.hardware?.gpu || !host.hardware.gpu.cuda)) {
    rejectionReasons.push(`${host.id}: task requires CUDA GPU`);
  }

  if (
    task.requirements?.minimumMemoryGB !== undefined &&
    host.hardware?.memoryGB !== undefined &&
    host.hardware.memoryGB < task.requirements.minimumMemoryGB
  ) {
    rejectionReasons.push(
      `${host.id}: memory ${host.hardware.memoryGB}GB < required ${task.requirements.minimumMemoryGB}GB`,
    );
  }

  if (
    task.requirements?.minimumGPUMemoryGB !== undefined &&
    task.requirements.minimumGPUMemoryGB > 0
  ) {
    const gpuMem = host.hardware?.gpu?.memoryGB ?? 0;
    if (gpuMem < task.requirements.minimumGPUMemoryGB) {
      rejectionReasons.push(
        `${host.id}: GPU memory ${gpuMem}GB < required ${task.requirements.minimumGPUMemoryGB}GB`,
      );
    }
  }

  const hostCapSet = new Set((host.capabilities ?? []).map((c) => c.trim().toLowerCase()));
  const matchedCapabilities: string[] = [];
  const missingCapabilities: string[] = [];

  for (const reqCap of requiredCaps) {
    const norm = toToolCapability(reqCap);
    const bare = norm.slice(TOOL_CAPABILITY_PREFIX.length);
    if (hostCapSet.has(norm) || hostCapSet.has(bare)) {
      matchedCapabilities.push(norm);
    } else {
      missingCapabilities.push(norm);
    }
  }

  if (missingCapabilities.length > 0) {
    rejectionReasons.push(
      `${host.id}: missing required pinned tool capabilities (${missingCapabilities.join(', ')})`,
    );
  }

  const feasible = rejectionReasons.length === 0;
  if (!feasible) {
    return {
      hostId: host.id,
      feasible: false,
      isDgxClass: dgx,
      score: 0,
      matchedCapabilities,
      missingCapabilities,
      reasons: [],
      rejectionReasons,
    };
  }

  let score = host.health === 'degraded' ? 0 : 2;
  reasons.push('bypassed model router (solver/verification task requires no LLM model)');

  if (matchedCapabilities.length > 0) {
    reasons.push(`advertises required pinned tools: ${matchedCapabilities.join(', ')}`);
  }

  if (preferDgx) {
    if (dgx) {
      score += 10;
      reasons.push(`DGX/GX10-class host '${host.id}' preferred for heavy verification campaign (+10)`);
    } else {
      reasons.push(`non-DGX host '${host.id}' eligible as fallback for heavy verification campaign`);
    }
  } else {
    if (host.local) {
      score += 1;
      reasons.push('local host preferred for lightweight solver check (+1)');
    }
    if (dgx) {
      score += 0.5;
      reasons.push('DGX/GX10-class hardware available (+0.5)');
    }
  }

  const cpuPercent = host.load?.cpuPercent ?? 0;
  score += Math.max(0, 1 - cpuPercent / 100);
  reasons.push(`CPU load ${Math.round(cpuPercent)}%`);

  return {
    hostId: host.id,
    feasible: true,
    isDgxClass: dgx,
    score,
    matchedCapabilities,
    missingCapabilities: [],
    reasons,
    rejectionReasons: [],
  };
}

/**
 * Computes the feasibility set `F(t)` of hosts that satisfy all pinned tool and hardware constraints.
 */
export function computeFeasibilitySet<H extends FeasibilityHost>(
  hosts: readonly H[],
  target: Obligation | VerificationTaskLike,
  options?: { alloyScopeThreshold?: number },
): H[] {
  return hosts.filter((h) => evaluateHostFeasibility(h, target, options).feasible);
}

/**
 * Schedules a formal verification obligation or task across the fleet of hosts:
 *  - Filters `hosts` to the feasibility set `F(t)` requiring all `tool:*` capabilities.
 *  - Ranks feasible hosts (preferring DGX/GX10-class hosts for heavy campaigns, and any feasible
 *    host for small Z3 checks).
 *  - Bypasses the model router (`modelId: undefined`, `modelCapacityConsumed: 0`).
 *  - If `F(t)` is empty, returns `{ schedulable: false, verdict: Verdict.NOT_RUN }` with explicit
 *    missing tool diagnostics — never silently skipping or dispatching to an incapable host.
 */
export function scheduleVerificationObligation(
  hosts: readonly FeasibilityHost[],
  target: Obligation | VerificationTaskLike,
  options?: { alloyScopeThreshold?: number },
): ObligationScheduleOutcome {
  const requiredToolCapabilities = getRequiredToolCapabilities(target);
  const preferDgx = isHeavyObligation(target, options?.alloyScopeThreshold);

  const evaluations = hosts.map((host) => evaluateHostFeasibility(host, target, options));
  const feasibleHosts = evaluations
    .filter((e) => e.feasible)
    .sort((a, b) => b.score - a.score || a.hostId.localeCompare(b.hostId));
  const rejectedHosts = evaluations.filter((e) => !e.feasible);

  if (feasibleHosts.length === 0) {
    const missingSet = new Set<string>();
    for (const r of rejectedHosts) {
      for (const m of r.missingCapabilities) missingSet.add(m);
    }
    if (missingSet.size === 0) {
      for (const c of requiredToolCapabilities) missingSet.add(c);
    }
    const missingCapabilities = Array.from(missingSet);
    const targetId = 'id' in target ? target.id : 'unknown';
    const rejectionSummary =
      rejectedHosts.length > 0
        ? rejectedHosts.flatMap((r) => r.rejectionReasons).join('; ')
        : 'no hosts registered in fleet';

    return {
      schedulable: false,
      verdict: Verdict.NOT_RUN,
      selectedHostId: undefined,
      selectedHost: undefined,
      selectedHostIsDgx: undefined,
      preferDgx,
      bypassesModelRouter: true,
      modelId: undefined,
      modelCapacityConsumed: 0,
      requiredToolCapabilities,
      missingCapabilities,
      feasibleHosts: [],
      rejectedHosts,
      reasons: [
        `NOT_RUN: obligation '${targetId}' is unschedulable because no host in F(t) satisfies required capabilities (${requiredToolCapabilities.join(', ') || 'none'}). ${rejectionSummary}`,
      ],
    };
  }

  const best = feasibleHosts[0]!;
  const selectedHost = hosts.find((h) => h.id === best.hostId);

  return {
    schedulable: true,
    verdict: undefined,
    selectedHostId: best.hostId,
    selectedHost,
    selectedHostIsDgx: best.isDgxClass,
    preferDgx,
    bypassesModelRouter: true,
    modelId: undefined,
    modelCapacityConsumed: 0,
    requiredToolCapabilities,
    missingCapabilities: [],
    feasibleHosts,
    rejectedHosts,
    reasons: best.reasons,
  };
}

/**
 * Builds an explicit `VerificationResult` with `Verdict.NOT_RUN` when the scheduler determines
 * that no host in `F(t)` has the required pinned tool capability.
 */
export function buildUnschedulableNotRunResult(
  obligation: Obligation,
  outcome: ObligationScheduleOutcome,
  inputHash = 'unschedulable',
): VerificationResult {
  return {
    verdict: Verdict.NOT_RUN,
    tool: obligation.tool,
    toolVersion: 'unavailable',
    scope: obligation.scope,
    assumptions: obligation.assumptions,
    elapsedMs: 0,
    inputHash,
    stderr: outcome.reasons.join('\n'),
    metadata: {
      unschedulable: true,
      requiredToolCapabilities: outcome.requiredToolCapabilities,
      missingCapabilities: outcome.missingCapabilities,
      rejectedHosts: outcome.rejectedHosts.map((r) => ({
        hostId: r.hostId,
        rejectionReasons: r.rejectionReasons,
      })),
    },
  };
}
