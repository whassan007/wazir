import { createHash, randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parse as parseShell } from 'shell-quote';
import type { KeyValueStore } from '@wazir/shared';
import {
  apportionAgentsLargestRemainder,
  buildLogicalAgentIds,
  inferPoolAgentPrefix,
  validateExecutionPlan,
} from './executionPlan.js';
import {
  IntelligentHardwareScheduler,
  parseHardUserConstraints,
} from './intelligentScheduler.js';
import type {
  AcceptanceState,
  CapabilityGraph,
  ClassifiedTaskProfile,
  DeclarativeExecutionPlan,
  DurableManagedTask,
  DurableTaskLease,
  ExecutionPlanPoolSpec,
  HardUserConstraints,
  PoolAllocationQuantities,
} from './types.js';

const DEFAULT_STORE_NAMESPACE = 'metaHarness:executionController:v1';
const DEFAULT_LEASE_DURATION_MS = 60_000;

const DEFAULT_ALLOWED_SHELL_BINARIES = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'rg',
  'grep',
  'find',
  'sort',
  'uniq',
  'cut',
  'echo',
  'git',
  'node',
  'npm',
  'npx',
  'tsc',
  'vitest',
  'pytest',
  'python',
  'python3',
  'cargo',
  'rustc',
  'go',
]);

const ALWAYS_FORBIDDEN_SHELL_BINARIES = new Set([
  'sudo',
  'su',
  'doas',
  'chown',
  'chroot',
  'mkfs',
  'fdisk',
  'dd',
  'mount',
  'umount',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'env',
  'printenv',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'scp',
  'sftp',
  'ftp',
  'iptables',
  'pfctl',
  'launchctl',
  'systemctl',
]);

export type WorkerSecurityViolationCode =
  | 'UNAUTHORIZED_SHELL_COMMAND'
  | 'SHELL_OPERATOR_OR_INJECTION_BLOCKED'
  | 'PATH_TRAVERSAL_OUTSIDE_WORKSPACE'
  | 'RESTRICTED_DATA_TO_CLOUD'
  | 'REPO_TO_CLOUD_FORBIDDEN'
  | 'LOCAL_ONLY_CLOUD_BLOCKED'
  | 'PAID_CLOUD_FORBIDDEN'
  | 'DISABLED_CLOUD_PROVIDER';

export interface WorkerSecurityViolation {
  code: WorkerSecurityViolationCode;
  detail: string;
  offendingValue?: string;
}

export interface EnforceWorkerSecurityGuardParams {
  workspaceRoot: string;
  targetKind: 'local_host' | 'cloud_provider';
  poolId?: string;
  providerId?: string;
  shellCommand?: string;
  allowedShellBinaries?: string[];
  allowShellChaining?: boolean;
  targetPaths?: string[];
  taskProfile?: Pick<
    ClassifiedTaskProfile,
    'taskId' | 'dataSensitivity' | 'requiresRepoAccess'
  >;
  constraints?: Partial<HardUserConstraints>;
  artifactContainsRestrictedData?: boolean;
  estimatedCloudCostUsd?: number;
}

export interface WorkerSecurityGuardDecision {
  allowed: boolean;
  violations: WorkerSecurityViolation[];
  sanitizedResolvedPaths: string[];
}

function resolveCanonicalWorkspaceRoot(workspaceRoot: string): string {
  const abs = path.resolve(workspaceRoot);
  if (existsSync(abs)) {
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  }
  return abs;
}

function isPathContainedInWorkspace(
  candidatePath: string,
  canonicalWorkspaceRoot: string,
  rawWorkspaceRoot: string,
): { ok: boolean; resolved: string; detail?: string } {
  if (candidatePath.includes('\0')) {
    return {
      ok: false,
      resolved: candidatePath,
      detail: 'Null byte detected in target path',
    };
  }

  if (candidatePath.startsWith('~')) {
    return {
      ok: false,
      resolved: candidatePath,
      detail: `Home-directory expansion '${candidatePath}' is outside workspace root`,
    };
  }

  const resolvedLexical = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(rawWorkspaceRoot, candidatePath);

  const checkAgainstRoot = (target: string, root: string): boolean => {
    if (target === root) return true;
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return target.startsWith(prefix);
  };

  if (
    !checkAgainstRoot(resolvedLexical, path.resolve(rawWorkspaceRoot)) &&
    !checkAgainstRoot(resolvedLexical, canonicalWorkspaceRoot)
  ) {
    return {
      ok: false,
      resolved: resolvedLexical,
      detail: `Path '${candidatePath}' resolves to '${resolvedLexical}', escaping workspace '${rawWorkspaceRoot}'`,
    };
  }

  // Check existing path or nearest existing ancestor for symlink traversal escape
  let probe = resolvedLexical;
  while (probe && probe !== path.dirname(probe)) {
    if (existsSync(probe)) {
      try {
        const real = realpathSync(probe);
        if (!checkAgainstRoot(real, canonicalWorkspaceRoot)) {
          return {
            ok: false,
            resolved: real,
            detail: `Symlink target '${real}' for '${candidatePath}' escapes workspace '${canonicalWorkspaceRoot}'`,
          };
        }
      } catch {
        // Ignore transient stat race; lexical check already passed
      }
      break;
    }
    probe = path.dirname(probe);
  }

  return { ok: true, resolved: resolvedLexical };
}

/**
 * Acceptance Test 14: Enforces strict worker execution security boundaries:
 * 1. Blocks unauthorized shell binaries, command injection operators, destructive flags,
 *    and shell path arguments escaping `workspaceRoot`.
 * 2. Blocks path traversal (`..`, absolute host paths, null bytes, symlinks) outside `workspaceRoot`.
 * 3. Blocks sending `restricted_local_only` data, confidential repositories (`neverSendRepoToCloud`),
 *    or any work to disabled cloud providers (strictly blocking `claude`).
 */
export function enforceWorkerSecurityGuard(
  params: EnforceWorkerSecurityGuardParams,
): WorkerSecurityGuardDecision {
  const violations: WorkerSecurityViolation[] = [];
  const sanitizedResolvedPaths: string[] = [];

  const rawRoot = path.resolve(params.workspaceRoot);
  const canonicalRoot = resolveCanonicalWorkspaceRoot(params.workspaceRoot);

  const isCloudDestination =
    params.targetKind === 'cloud_provider' || Boolean(params.providerId);
  const providerLower = (params.providerId ?? params.poolId ?? '').toLowerCase();

  // 1. Cloud provider & confidential data boundary enforcement
  if (
    providerLower === 'claude' ||
    (params.constraints?.disabledProviders ?? []).some(
      (p) => p.toLowerCase() === providerLower && providerLower.length > 0,
    )
  ) {
    violations.push({
      code: 'DISABLED_CLOUD_PROVIDER',
      detail: `Execution on disabled provider '${params.providerId ?? params.poolId}' is strictly forbidden by policy`,
      offendingValue: params.providerId ?? params.poolId,
    });
  }

  if (isCloudDestination) {
    if (params.constraints?.localMachinesOnly) {
      violations.push({
        code: 'LOCAL_ONLY_CLOUD_BLOCKED',
        detail: 'Cloud execution blocked by localMachinesOnly hard constraint',
        offendingValue: params.providerId ?? params.poolId,
      });
    }

    if (
      params.taskProfile?.dataSensitivity === 'restricted_local_only' ||
      params.artifactContainsRestrictedData
    ) {
      violations.push({
        code: 'RESTRICTED_DATA_TO_CLOUD',
        detail: `Task or artifact marked restricted_local_only cannot be sent to cloud provider '${params.providerId ?? params.poolId}'`,
        offendingValue: params.taskProfile?.taskId,
      });
    }

    if (
      params.constraints?.neverSendRepoToCloud &&
      (params.taskProfile?.requiresRepoAccess ?? true)
    ) {
      violations.push({
        code: 'REPO_TO_CLOUD_FORBIDDEN',
        detail: `Repository access task cannot be transmitted to cloud provider '${params.providerId ?? params.poolId}' under neverSendRepoToCloud`,
        offendingValue: params.taskProfile?.taskId,
      });
    }

    if (
      params.constraints?.paidCloudAllowed === false &&
      (params.estimatedCloudCostUsd ?? 0) > 0
    ) {
      violations.push({
        code: 'PAID_CLOUD_FORBIDDEN',
        detail: `Paid cloud execution ($${params.estimatedCloudCostUsd}) blocked by paidCloudAllowed=false`,
        offendingValue: String(params.estimatedCloudCostUsd),
      });
    }
  }

  // 2. Explicit file/artifact target path containment
  for (const targetPath of params.targetPaths ?? []) {
    const check = isPathContainedInWorkspace(targetPath, canonicalRoot, rawRoot);
    if (!check.ok) {
      violations.push({
        code: 'PATH_TRAVERSAL_OUTSIDE_WORKSPACE',
        detail: check.detail ?? `Path '${targetPath}' escapes workspace root`,
        offendingValue: targetPath,
      });
    } else {
      sanitizedResolvedPaths.push(check.resolved);
    }
  }

  // 3. Shell command verification
  if (params.shellCommand !== undefined) {
    const cmd = params.shellCommand.trim();
    if (!cmd) {
      violations.push({
        code: 'UNAUTHORIZED_SHELL_COMMAND',
        detail: 'Empty shell command is not permitted',
      });
    } else {
      // Detect subshells, command substitution, or newlines prior to tokenization
      if (/`|\$\(|\n|\r/.test(cmd)) {
        violations.push({
          code: 'SHELL_OPERATOR_OR_INJECTION_BLOCKED',
          detail: 'Subshell expansion (`...` or $(...)) or multiline injection is forbidden',
          offendingValue: cmd,
        });
      }

      const parsedEntries = parseShell(cmd, {});
      const allowedSet = params.allowedShellBinaries
        ? new Set(params.allowedShellBinaries)
        : DEFAULT_ALLOWED_SHELL_BINARIES;

      const stringTokens: string[] = [];
      let sawOperator = false;

      for (const entry of parsedEntries) {
        if (typeof entry === 'string') {
          stringTokens.push(entry);
        } else if (entry && typeof entry === 'object' && 'op' in entry) {
          sawOperator = true;
          if (!params.allowShellChaining) {
            violations.push({
              code: 'SHELL_OPERATOR_OR_INJECTION_BLOCKED',
              detail: `Shell control/redirection operator '${String(entry.op)}' is blocked`,
              offendingValue: String(entry.op),
            });
          }
        }
      }

      if (stringTokens.length === 0 && !sawOperator) {
        violations.push({
          code: 'UNAUTHORIZED_SHELL_COMMAND',
          detail: 'Unable to resolve executable binary from shell command',
          offendingValue: cmd,
        });
      } else if (stringTokens.length > 0) {
        const rawBinary = stringTokens[0];
        const binaryBase = path.basename(rawBinary);

        if (rawBinary.includes('/') || rawBinary.includes('\\')) {
          const binPathCheck = isPathContainedInWorkspace(rawBinary, canonicalRoot, rawRoot);
          if (!binPathCheck.ok) {
            violations.push({
              code: 'UNAUTHORIZED_SHELL_COMMAND',
              detail: `Executable path '${rawBinary}' outside workspace is not authorized`,
              offendingValue: rawBinary,
            });
          }
        }

        if (ALWAYS_FORBIDDEN_SHELL_BINARIES.has(binaryBase) || !allowedSet.has(binaryBase)) {
          violations.push({
            code: 'UNAUTHORIZED_SHELL_COMMAND',
            detail: `Shell binary '${binaryBase}' is not in the authorized worker command allowlist`,
            offendingValue: binaryBase,
          });
        }

        // Block destructive `rm` or `git push --force` / `find -exec` escalations
        if (binaryBase === 'find' && stringTokens.some((t) => /^-?(?:exec|execdir|ok|okdir|delete)$/.test(t))) {
          violations.push({
            code: 'UNAUTHORIZED_SHELL_COMMAND',
            detail: `Dangerous 'find' execution/deletion flag in '${cmd}'`,
            offendingValue: cmd,
          });
        }

        if (
          (binaryBase === 'node' || binaryBase === 'python' || binaryBase === 'python3') &&
          stringTokens.some((t) => t === '-e' || t === '--eval' || t === '-c')
        ) {
          violations.push({
            code: 'UNAUTHORIZED_SHELL_COMMAND',
            detail: `Inline code evaluation flag ('-e'/'-c') on '${binaryBase}' is blocked by worker guard`,
            offendingValue: cmd,
          });
        }

        // Inspect path-like arguments in shell command for workspace escape
        for (let i = 1; i < stringTokens.length; i++) {
          const arg = stringTokens[i];
          if (arg.startsWith('-')) {
            const eqIdx = arg.indexOf('=');
            if (eqIdx > 0) {
              const flagVal = arg.slice(eqIdx + 1);
              if (flagVal.startsWith('/') || flagVal.startsWith('..') || flagVal.startsWith('~')) {
                const pCheck = isPathContainedInWorkspace(flagVal, canonicalRoot, rawRoot);
                if (!pCheck.ok) {
                  violations.push({
                    code: 'PATH_TRAVERSAL_OUTSIDE_WORKSPACE',
                    detail: pCheck.detail ?? `Shell flag path '${flagVal}' escapes workspace`,
                    offendingValue: flagVal,
                  });
                }
              }
            }
            continue;
          }

          if (
            arg.startsWith('/') ||
            arg.startsWith('../') ||
            arg === '..' ||
            arg.includes('/../') ||
            arg.startsWith('~')
          ) {
            const pCheck = isPathContainedInWorkspace(arg, canonicalRoot, rawRoot);
            if (!pCheck.ok) {
              violations.push({
                code: 'PATH_TRAVERSAL_OUTSIDE_WORKSPACE',
                detail: pCheck.detail ?? `Shell argument '${arg}' escapes workspace`,
                offendingValue: arg,
              });
            }
          }
        }
      }
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
    sanitizedResolvedPaths,
  };
}

function toIsoTimestamp(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === 'string') {
    return val;
  }
  return new Date().toISOString();
}

function toOptionalIsoTimestamp(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') return val;
  return undefined;
}

/**
 * Normalizes any `Date` objects revived by `JsonFileStore.reviveDatesInPlace` back
 * to canonical ISO-8601 strings so `DurableManagedTask` and `DurableTaskLease`
 * preserve exact runtime string types across process restarts.
 */
function normalizeManagedTaskDates(task: DurableManagedTask): DurableManagedTask {
  const lease: DurableTaskLease | undefined = task.lease
    ? {
        ...task.lease,
        acquiredAt: toIsoTimestamp(task.lease.acquiredAt),
        heartbeatAt: toIsoTimestamp(task.lease.heartbeatAt),
        expiresAt: toIsoTimestamp(task.lease.expiresAt),
      }
    : undefined;

  return {
    ...task,
    ...(lease ? { lease } : { lease: undefined }),
    startedAt: toOptionalIsoTimestamp(task.startedAt),
    completedAt: toOptionalIsoTimestamp(task.completedAt),
  };
}

export interface CheckpointEnvelope {
  taskId: string;
  checkpointId: string;
  epoch: number;
  workerId: string;
  savedAt: string;
  payload: unknown;
}

interface PoolRuntimeConfigState {
  poolId: string;
  enabled: boolean;
  targetSharePct: number;
  targetAllocation: number;
  feasibleAllocation: number;
  configuredMaxConcurrent: number;
  verifiedSafeConcurrent?: number;
  effectiveConcurrentLimit: number;
  acceptanceState: AcceptanceState;
  assignedLogicalAgentIds: string[];
  reroutedFromPools: string[];
  unavailabilityReason?: string;
}

interface PersistedControllerState {
  version: 1;
  planName: string;
  globalEpoch: number;
  updatedAt: string;
  pools: Record<string, PoolRuntimeConfigState>;
  tasks: Record<string, DurableManagedTask>;
  admittedTaskPoolMap: Record<string, string>;
  fencedEpochWatermarkByTask: Record<string, number>;
  completedReceiptsByHash: Record<string, { taskId: string; epoch: number; committedAt: string }>;
  checkpoints: Record<string, CheckpointEnvelope>;
}

function normalizePersistedState(raw: PersistedControllerState): PersistedControllerState {
  const normalizedTasks: Record<string, DurableManagedTask> = {};
  for (const [taskId, task] of Object.entries(raw.tasks ?? {})) {
    normalizedTasks[taskId] = normalizeManagedTaskDates(task);
  }
  const normalizedCheckpoints: Record<string, CheckpointEnvelope> = {};
  for (const [k, cp] of Object.entries(raw.checkpoints ?? {})) {
    normalizedCheckpoints[k] = {
      ...cp,
      savedAt: toIsoTimestamp(cp.savedAt),
    };
  }
  const normalizedReceipts: Record<string, { taskId: string; epoch: number; committedAt: string }> = {};
  for (const [h, r] of Object.entries(raw.completedReceiptsByHash ?? {})) {
    normalizedReceipts[h] = {
      ...r,
      committedAt: toIsoTimestamp(r.committedAt),
    };
  }

  return {
    ...raw,
    updatedAt: toIsoTimestamp(raw.updatedAt),
    tasks: normalizedTasks,
    checkpoints: normalizedCheckpoints,
    completedReceiptsByHash: normalizedReceipts,
  };
}

export function computeCompletionReceiptHash(params: {
  taskId: string;
  idempotencyKey: string;
  outputSummary: string;
  changedFiles?: string[];
}): string {
  const canonicalPayload = JSON.stringify({
    taskId: params.taskId,
    idempotencyKey: params.idempotencyKey,
    outputSummary: params.outputSummary,
    changedFiles: [...(params.changedFiles ?? [])].sort(),
  });
  return createHash('sha256').update(canonicalPayload).digest('hex');
}

export interface DistributedExecutionControllerOptions {
  store: KeyValueStore;
  plan: DeclarativeExecutionPlan;
  namespace?: string;
  defaultLeaseDurationMs?: number;
  verifiedSafeConcurrencyByPool?: Record<string, number>;
}

export interface SubmitTaskInput {
  profile: ClassifiedTaskProfile;
  assignedPoolId: string;
  logicalAgentId?: string;
  maxAttempts?: number;
}

export interface ClaimTaskParams {
  poolId: string;
  workerId: string;
  hostId?: string;
  runtimeId: string;
  modelId: string;
  leaseDurationMs?: number;
  nowIso?: string;
}

export interface ClaimTaskResult {
  claimed: boolean;
  reason?:
    | 'POOL_DISABLED'
    | 'POOL_UNAVAILABLE'
    | 'POOL_AT_CONCURRENCY_LIMIT'
    | 'NO_READY_TASKS_IN_POOL';
  task?: DurableManagedTask;
  lease?: DurableTaskLease;
  resumeCheckpoint?: CheckpointEnvelope;
  poolQuantities: PoolAllocationQuantities;
}

export interface RenewHeartbeatParams {
  taskId: string;
  leaseToken: string;
  epoch: number;
  extendMs?: number;
  checkpointId?: string;
  checkpointPayload?: unknown;
  nowIso?: string;
}

export interface RenewHeartbeatResult {
  renewed: boolean;
  reason?: 'TASK_NOT_FOUND' | 'TASK_NOT_RUNNING' | 'FENCED_STALE_LEASE_OR_EPOCH' | 'LEASE_EXPIRED';
  lease?: DurableTaskLease;
}

export interface CompleteTaskParams {
  taskId: string;
  leaseToken: string;
  epoch: number;
  idempotencyKey?: string;
  outputSummary: string;
  changedFiles?: string[];
  verificationPassed?: boolean;
  verificationEvidenceId?: string;
  cloudCostUsd?: number;
  nowIso?: string;
}

export interface CompleteTaskResult {
  accepted: boolean;
  idempotentDuplicate: boolean;
  reason?:
    | 'TASK_NOT_FOUND'
    | 'FENCED_STALE_LEASE_OR_EPOCH'
    | 'VERIFICATION_FAILED_REQUEUED'
    | 'VERIFICATION_FAILED_TERMINAL';
  receiptHash?: string;
  task?: DurableManagedTask;
}

export interface SweepExpiredLeasesResult {
  sweptAt: string;
  expiredTaskIds: string[];
  requeuedTaskIds: string[];
  failedTerminalTaskIds: string[];
}

export interface FailoverResult {
  reroutedTaskIds: string[];
  reroutedToPoolByTaskId: Record<string, string>;
  unschedulableTaskIds: string[];
}

/**
 * Durable distributed execution controller backed by `@wazir/shared` `KeyValueStore`
 * (`MemoryStore` or `JsonFileStore`).
 *
 * Implements:
 * - Four distinct quantities per pool (`targetAllocation`, `admittedAgents`, `runningAgents`, `completedAgents`) + `queuedAgents` & `failedAgents`
 * - Strict per-pool concurrency admission (`runningAgents <= effectiveConcurrentLimit`)
 * - Atomic CAS task claiming, monotonic fencing `epoch` + `leaseToken`, heartbeats, lease sweeps, and checkpoint recovery
 * - Idempotent completion receipts (`idempotencyReceiptHash`) rejecting late/fenced zombie workers
 * - Dependency-DAG ordered execution, cancellation, and capability-aware failover with strict `claude = 0`
 */
export class DistributedExecutionController {
  private readonly store: KeyValueStore;
  private readonly plan: DeclarativeExecutionPlan;
  private readonly stateKey: string;
  private readonly defaultLeaseDurationMs: number;
  private readonly initialVerifiedConc: Record<string, number>;
  private mutexChain: Promise<unknown> = Promise.resolve();

  constructor(options: DistributedExecutionControllerOptions) {
    this.store = options.store;
    this.plan = validateExecutionPlan(options.plan);
    this.stateKey = `${options.namespace ?? DEFAULT_STORE_NAMESPACE}:${this.plan.metadata.name}`;
    this.defaultLeaseDurationMs = options.defaultLeaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.initialVerifiedConc = { ...(options.verifiedSafeConcurrencyByPool ?? {}) };
  }

  private buildInitialState(nowIso: string): PersistedControllerState {
    const apportionment = apportionAgentsLargestRemainder(this.plan);
    const pools: Record<string, PoolRuntimeConfigState> = {};

    for (const specPool of this.plan.spec.pools) {
      const entry = apportionment.byPool[specPool.id];
      const isClaudeDisabled =
        (specPool.id.toLowerCase() === 'claude' || specPool.provider?.toLowerCase() === 'claude') &&
        (!specPool.enabled || specPool.share <= 0);
      const enabled = Boolean(specPool.enabled && specPool.share > 0 && !isClaudeDisabled);
      const verifiedSafe = enabled ? this.initialVerifiedConc[specPool.id] : 0;
      const effectiveLimit = enabled
        ? Math.max(
            0,
            Math.min(specPool.max_concurrent, verifiedSafe ?? specPool.max_concurrent),
          )
        : 0;

      pools[specPool.id] = {
        poolId: specPool.id,
        enabled,
        targetSharePct: enabled ? specPool.share : 0,
        targetAllocation: entry.allocatedAgents,
        feasibleAllocation: entry.allocatedAgents,
        configuredMaxConcurrent: enabled ? specPool.max_concurrent : 0,
        ...(verifiedSafe !== undefined ? { verifiedSafeConcurrent: verifiedSafe } : {}),
        effectiveConcurrentLimit: effectiveLimit,
        acceptanceState: enabled
          ? verifiedSafe !== undefined
            ? 'CAPACITY_VERIFIED'
            : 'EXECUTION_VERIFIED'
          : 'DISABLED_BY_POLICY',
        assignedLogicalAgentIds: [...entry.logicalAgentIds],
        reroutedFromPools: [],
      };
    }

    return {
      version: 1,
      planName: this.plan.metadata.name,
      globalEpoch: 0,
      updatedAt: nowIso,
      pools,
      tasks: {},
      admittedTaskPoolMap: {},
      fencedEpochWatermarkByTask: {},
      completedReceiptsByHash: {},
      checkpoints: {},
    };
  }

  private async atomicMutate<R>(
    fn: (state: PersistedControllerState) => R,
    nowIso: string = new Date().toISOString(),
  ): Promise<R> {
    const run = async (): Promise<R> => {
      let result!: R;
      if (typeof this.store.update === 'function') {
        await this.store.update<PersistedControllerState>(this.stateKey, (existing) => {
          const state = existing
            ? normalizePersistedState(existing)
            : this.buildInitialState(nowIso);
          result = fn(state);
          state.updatedAt = nowIso;
          return state;
        });
      } else {
        const existing = await this.store.get<PersistedControllerState>(this.stateKey);
        const state = existing
          ? normalizePersistedState(existing)
          : this.buildInitialState(nowIso);
        result = fn(state);
        state.updatedAt = nowIso;
        await this.store.put(this.stateKey, state);
      }
      return result;
    };

    const next = this.mutexChain.then(run, run);
    this.mutexChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async readState(nowIso: string = new Date().toISOString()): Promise<PersistedControllerState> {
    const existing = await this.store.get<PersistedControllerState>(this.stateKey);
    if (!existing) {
      return this.atomicMutate((s) => structuredClone(s), nowIso);
    }
    return normalizePersistedState(existing);
  }

  public async initialize(nowIso: string = new Date().toISOString()): Promise<void> {
    await this.atomicMutate(() => undefined, nowIso);
  }

  private promoteDependencySatisfiedTasks(state: PersistedControllerState): void {
    for (const task of Object.values(state.tasks)) {
      if (task.state !== 'pending_dependencies') continue;
      const depsMet = task.profile.dependsOn.every((depId) => {
        const depTask = state.tasks[depId];
        return depTask && depTask.state === 'completed' && depTask.verificationPassed !== false;
      });
      if (depsMet) {
        task.state = 'queued';
        state.admittedTaskPoolMap[task.taskId] = task.assignedPoolId;
      }
    }
  }

  private assertNoDependencyCycles(
    existingTasks: Record<string, DurableManagedTask>,
    newInputs: SubmitTaskInput[],
  ): void {
    const graphDeps = new Map<string, string[]>();
    for (const t of Object.values(existingTasks)) {
      graphDeps.set(t.taskId, [...t.profile.dependsOn]);
    }
    for (const inp of newInputs) {
      graphDeps.set(inp.profile.taskId, [...inp.profile.dependsOn]);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();

    const dfs = (nodeId: string): void => {
      if (visited.has(nodeId)) return;
      if (visiting.has(nodeId)) {
        throw new Error(`Circular task dependency detected involving '${nodeId}'`);
      }
      visiting.add(nodeId);
      for (const dep of graphDeps.get(nodeId) ?? []) {
        if (graphDeps.has(dep)) {
          dfs(dep);
        }
      }
      visiting.delete(nodeId);
      visited.add(nodeId);
    };

    for (const id of graphDeps.keys()) {
      dfs(id);
    }
  }

  private computeQuantitiesForPoolFromState(
    state: PersistedControllerState,
    poolId: string,
  ): PoolAllocationQuantities {
    const poolCfg = state.pools[poolId];
    if (!poolCfg) {
      throw new Error(`Unknown pool '${poolId}' in ExecutionPlan '${this.plan.metadata.name}'`);
    }

    const poolTasks = Object.values(state.tasks).filter(
      (t) => (t.executedPoolId ?? t.assignedPoolId) === poolId,
    );

    const runningAgents = poolTasks.filter(
      (t) => t.state === 'running' || t.state === 'verifying',
    ).length;
    const queuedAgents = poolTasks.filter(
      (t) => t.state === 'queued' || t.state === 'admitted',
    ).length;
    const completedAgents = poolTasks.filter(
      (t) => t.state === 'completed' && t.verificationPassed !== false,
    ).length;
    const failedAgents = poolTasks.filter((t) => t.state === 'failed').length;

    const admittedAgents = Object.entries(state.admittedTaskPoolMap).filter(
      ([taskId, admittedPool]) => {
        if (admittedPool !== poolId) return false;
        const t = state.tasks[taskId];
        return Boolean(t && t.state !== 'cancelled' && t.state !== 'pending_dependencies');
      },
    ).length;

    return {
      poolId: poolCfg.poolId,
      enabled: poolCfg.enabled,
      targetSharePct: poolCfg.targetSharePct,
      targetAllocation: poolCfg.targetAllocation,
      feasibleAllocation: poolCfg.feasibleAllocation,
      admittedAgents,
      runningAgents,
      queuedAgents,
      completedAgents,
      failedAgents,
      configuredMaxConcurrent: poolCfg.configuredMaxConcurrent,
      ...(poolCfg.verifiedSafeConcurrent !== undefined
        ? { verifiedSafeConcurrent: poolCfg.verifiedSafeConcurrent }
        : {}),
      effectiveConcurrentLimit: poolCfg.effectiveConcurrentLimit,
      assignedLogicalAgentIds: [...poolCfg.assignedLogicalAgentIds],
      ...(poolCfg.reroutedFromPools.length > 0
        ? { reroutedFromPools: [...poolCfg.reroutedFromPools] }
        : {}),
      ...(poolCfg.unavailabilityReason
        ? { unavailabilityReason: poolCfg.unavailabilityReason }
        : {}),
    };
  }

  public async setPoolVerifiedConcurrency(
    poolId: string,
    verifiedSafeConcurrent: number,
    acceptanceState?: AcceptanceState,
  ): Promise<PoolAllocationQuantities> {
    return this.atomicMutate((state) => {
      const poolCfg = state.pools[poolId];
      if (!poolCfg) {
        throw new Error(`Unknown pool '${poolId}'`);
      }
      if (!poolCfg.enabled || poolId.toLowerCase() === 'claude') {
        poolCfg.verifiedSafeConcurrent = 0;
        poolCfg.effectiveConcurrentLimit = 0;
        poolCfg.acceptanceState = 'DISABLED_BY_POLICY';
        return this.computeQuantitiesForPoolFromState(state, poolId);
      }

      const clampedVerified = Math.max(0, Math.floor(verifiedSafeConcurrent));
      poolCfg.verifiedSafeConcurrent = clampedVerified;
      poolCfg.effectiveConcurrentLimit = Math.min(
        poolCfg.configuredMaxConcurrent,
        clampedVerified,
      );
      if (acceptanceState) {
        poolCfg.acceptanceState = acceptanceState;
      }
      return this.computeQuantitiesForPoolFromState(state, poolId);
    });
  }

  public async submitTasks(
    inputs: SubmitTaskInput[],
    nowIso: string = new Date().toISOString(),
  ): Promise<DurableManagedTask[]> {
    return this.atomicMutate((state) => {
      this.assertNoDependencyCycles(state.tasks, inputs);

      const created: DurableManagedTask[] = [];
      const perPoolSeq: Record<string, number> = {};
      for (const t of Object.values(state.tasks)) {
        perPoolSeq[t.assignedPoolId] = (perPoolSeq[t.assignedPoolId] ?? 0) + 1;
      }

      for (const item of inputs) {
        const poolCfg = state.pools[item.assignedPoolId];
        if (!poolCfg) {
          throw new Error(`Cannot submit task '${item.profile.taskId}' to unknown pool '${item.assignedPoolId}'`);
        }
        if (!poolCfg.enabled || item.assignedPoolId.toLowerCase() === 'claude') {
          throw new Error(
            `Cannot submit task '${item.profile.taskId}' to disabled pool '${item.assignedPoolId}' (0% policy)`,
          );
        }
        if (state.tasks[item.profile.taskId]) {
          throw new Error(`Task '${item.profile.taskId}' already exists in controller`);
        }

        const seq = (perPoolSeq[item.assignedPoolId] ?? 0) + 1;
        perPoolSeq[item.assignedPoolId] = seq;

        const specPool = this.plan.spec.pools.find((p) => p.id === item.assignedPoolId)!;
        const prefix = inferPoolAgentPrefix(specPool);
        const defaultAgentId = buildLogicalAgentIds(prefix, seq)[seq - 1];
        const logicalAgentId = item.logicalAgentId ?? defaultAgentId;

        if (!poolCfg.assignedLogicalAgentIds.includes(logicalAgentId)) {
          poolCfg.assignedLogicalAgentIds.push(logicalAgentId);
        }

        const hasUnmetDeps = item.profile.dependsOn.some((depId) => {
          const dep = state.tasks[depId];
          return !dep || dep.state !== 'completed' || dep.verificationPassed === false;
        });

        const initialState: DurableManagedTask['state'] = hasUnmetDeps
          ? 'pending_dependencies'
          : 'queued';

        const managed: DurableManagedTask = {
          taskId: item.profile.taskId,
          logicalAgentId,
          assignedPoolId: item.assignedPoolId,
          profile: structuredClone(item.profile),
          state: initialState,
          attempt: 0,
          maxAttempts: item.maxAttempts ?? Math.max(1, 1 + this.plan.spec.execution.max_repair_attempts),
          cloudCostUsd: 0,
        };

        state.tasks[managed.taskId] = managed;
        if (initialState === 'queued') {
          state.admittedTaskPoolMap[managed.taskId] = item.assignedPoolId;
        }
        created.push(structuredClone(managed));
      }

      this.promoteDependencySatisfiedTasks(state);
      return created.map((c) => structuredClone(state.tasks[c.taskId]));
    }, nowIso);
  }

  /**
   * Atomically claims the next eligible task in `params.poolId` using CAS + monotonic
   * fencing `epoch` and `leaseToken`, strictly enforcing `runningAgents <= effectiveConcurrentLimit`.
   */
  public async claimTask(params: ClaimTaskParams): Promise<ClaimTaskResult> {
    const nowIso = params.nowIso ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso);
    const leaseDurationMs = params.leaseDurationMs ?? this.defaultLeaseDurationMs;

    return this.atomicMutate((state) => {
      this.promoteDependencySatisfiedTasks(state);

      const poolCfg = state.pools[params.poolId];
      if (!poolCfg) {
        throw new Error(`Unknown pool '${params.poolId}'`);
      }

      if (!poolCfg.enabled || params.poolId.toLowerCase() === 'claude') {
        return {
          claimed: false,
          reason: 'POOL_DISABLED',
          poolQuantities: this.computeQuantitiesForPoolFromState(state, params.poolId),
        };
      }

      if (
        poolCfg.acceptanceState === 'UNAVAILABLE' ||
        poolCfg.acceptanceState === 'DISABLED_BY_POLICY' ||
        poolCfg.effectiveConcurrentLimit <= 0
      ) {
        return {
          claimed: false,
          reason: 'POOL_UNAVAILABLE',
          poolQuantities: this.computeQuantitiesForPoolFromState(state, params.poolId),
        };
      }

      const preQuantities = this.computeQuantitiesForPoolFromState(state, params.poolId);
      if (preQuantities.runningAgents >= poolCfg.effectiveConcurrentLimit) {
        return {
          claimed: false,
          reason: 'POOL_AT_CONCURRENCY_LIMIT',
          poolQuantities: preQuantities,
        };
      }

      const readyCandidates = Object.values(state.tasks)
        .filter(
          (t) =>
            t.assignedPoolId === params.poolId &&
            (t.state === 'queued' || t.state === 'admitted'),
        )
        .sort((a, b) =>
          b.profile.priority !== a.profile.priority
            ? b.profile.priority - a.profile.priority
            : a.taskId.localeCompare(b.taskId),
        );

      if (readyCandidates.length === 0) {
        return {
          claimed: false,
          reason: 'NO_READY_TASKS_IN_POOL',
          poolQuantities: preQuantities,
        };
      }

      const chosen = readyCandidates[0];
      state.globalEpoch += 1;
      const prevTaskWatermark = state.fencedEpochWatermarkByTask[chosen.taskId] ?? 0;
      const nextEpoch = Math.max(state.globalEpoch, prevTaskWatermark + 1);
      state.globalEpoch = nextEpoch;
      state.fencedEpochWatermarkByTask[chosen.taskId] = nextEpoch;

      const leaseToken = `lease_${chosen.taskId}_e${nextEpoch}_${randomBytes(6).toString('hex')}`;
      const expiresAtIso = new Date(nowMs + leaseDurationMs).toISOString();

      const lease: DurableTaskLease = {
        taskId: chosen.taskId,
        logicalAgentId: chosen.logicalAgentId,
        poolId: params.poolId,
        workerId: params.workerId,
        ...(params.hostId ? { hostId: params.hostId } : {}),
        runtimeId: params.runtimeId,
        modelId: params.modelId,
        epoch: nextEpoch,
        leaseToken,
        acquiredAt: nowIso,
        heartbeatAt: nowIso,
        expiresAt: expiresAtIso,
      };

      chosen.state = 'running';
      chosen.executedPoolId = params.poolId;
      chosen.attempt += 1;
      chosen.lease = lease;
      if (!chosen.startedAt) {
        chosen.startedAt = nowIso;
      }
      state.admittedTaskPoolMap[chosen.taskId] = params.poolId;

      const resumeCheckpoint = chosen.checkpointId
        ? state.checkpoints[`${chosen.taskId}:${chosen.checkpointId}`]
        : undefined;

      return {
        claimed: true,
        task: structuredClone(chosen),
        lease: structuredClone(lease),
        ...(resumeCheckpoint ? { resumeCheckpoint: structuredClone(resumeCheckpoint) } : {}),
        poolQuantities: this.computeQuantitiesForPoolFromState(state, params.poolId),
      };
    }, nowIso);
  }

  public async renewHeartbeat(params: RenewHeartbeatParams): Promise<RenewHeartbeatResult> {
    const nowIso = params.nowIso ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso);
    const extendMs = params.extendMs ?? this.defaultLeaseDurationMs;

    return this.atomicMutate((state) => {
      const task = state.tasks[params.taskId];
      if (!task) {
        return { renewed: false, reason: 'TASK_NOT_FOUND' };
      }
      if ((task.state !== 'running' && task.state !== 'verifying') || !task.lease) {
        return { renewed: false, reason: 'TASK_NOT_RUNNING' };
      }

      const watermark = state.fencedEpochWatermarkByTask[task.taskId] ?? 0;
      if (
        task.lease.epoch !== params.epoch ||
        task.lease.leaseToken !== params.leaseToken ||
        params.epoch < watermark
      ) {
        return { renewed: false, reason: 'FENCED_STALE_LEASE_OR_EPOCH' };
      }

      if (Date.parse(task.lease.expiresAt) <= nowMs) {
        return { renewed: false, reason: 'LEASE_EXPIRED' };
      }

      task.lease.heartbeatAt = nowIso;
      task.lease.expiresAt = new Date(nowMs + extendMs).toISOString();

      if (params.checkpointId) {
        task.checkpointId = params.checkpointId;
        state.checkpoints[`${task.taskId}:${params.checkpointId}`] = {
          taskId: task.taskId,
          checkpointId: params.checkpointId,
          epoch: params.epoch,
          workerId: task.lease.workerId,
          savedAt: nowIso,
          payload: structuredClone(params.checkpointPayload ?? null),
        };
      }

      return {
        renewed: true,
        lease: structuredClone(task.lease),
      };
    }, nowIso);
  }

  public async saveCheckpoint(params: {
    taskId: string;
    leaseToken: string;
    epoch: number;
    checkpointId: string;
    payload: unknown;
    nowIso?: string;
  }): Promise<{ saved: boolean; reason?: string; checkpoint?: CheckpointEnvelope }> {
    const nowIso = params.nowIso ?? new Date().toISOString();
    return this.atomicMutate((state) => {
      const task = state.tasks[params.taskId];
      if (!task || !task.lease) {
        return { saved: false, reason: 'TASK_OR_LEASE_NOT_ACTIVE' };
      }
      const watermark = state.fencedEpochWatermarkByTask[task.taskId] ?? 0;
      if (
        task.lease.epoch !== params.epoch ||
        task.lease.leaseToken !== params.leaseToken ||
        params.epoch < watermark
      ) {
        return { saved: false, reason: 'FENCED_STALE_LEASE_OR_EPOCH' };
      }

      const env: CheckpointEnvelope = {
        taskId: params.taskId,
        checkpointId: params.checkpointId,
        epoch: params.epoch,
        workerId: task.lease.workerId,
        savedAt: nowIso,
        payload: structuredClone(params.payload),
      };
      task.checkpointId = params.checkpointId;
      state.checkpoints[`${params.taskId}:${params.checkpointId}`] = env;
      return { saved: true, checkpoint: structuredClone(env) };
    }, nowIso);
  }

  public async getCheckpoint(
    taskId: string,
    checkpointId: string,
  ): Promise<CheckpointEnvelope | undefined> {
    const state = await this.readState();
    const cp = state.checkpoints[`${taskId}:${checkpointId}`];
    return cp ? structuredClone(cp) : undefined;
  }

  /**
   * Sweeps expired task leases, bumping the fencing epoch watermark so timed-out
   * zombie workers can never commit late, and re-queues tasks with checkpoint state intact.
   */
  public async sweepExpiredLeases(params: { nowIso?: string } = {}): Promise<SweepExpiredLeasesResult> {
    const nowIso = params.nowIso ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso);

    return this.atomicMutate((state) => {
      const expiredTaskIds: string[] = [];
      const requeuedTaskIds: string[] = [];
      const failedTerminalTaskIds: string[] = [];

      for (const task of Object.values(state.tasks)) {
        if ((task.state !== 'running' && task.state !== 'verifying') || !task.lease) {
          continue;
        }
        const expMs = Date.parse(task.lease.expiresAt);
        if (expMs <= nowMs) {
          expiredTaskIds.push(task.taskId);
          // Fence off the expired worker permanently by advancing watermark past its epoch
          state.globalEpoch += 1;
          const fencedWatermark = Math.max(state.globalEpoch, task.lease.epoch + 1);
          state.globalEpoch = fencedWatermark;
          state.fencedEpochWatermarkByTask[task.taskId] = fencedWatermark;
          task.lease = undefined;

          if (this.plan.spec.execution.recover_failures && task.attempt < task.maxAttempts) {
            task.state = 'queued';
            task.error = 'Lease expired; recovered to queue with fencing epoch incremented';
            requeuedTaskIds.push(task.taskId);
          } else {
            task.state = 'failed';
            task.completedAt = nowIso;
            task.error = 'Lease expired and max recovery attempts exhausted';
            failedTerminalTaskIds.push(task.taskId);
          }
        }
      }

      return {
        sweptAt: nowIso,
        expiredTaskIds,
        requeuedTaskIds,
        failedTerminalTaskIds,
      };
    }, nowIso);
  }

  /**
   * Commits a task completion guarded by monotonic fencing (`epoch` + `leaseToken`) and
   * SHA-256 `idempotencyReceiptHash` (Acceptance Test 9).
   *
   * - Identical retry of an already-committed receipt returns `{ accepted: true, idempotentDuplicate: true }`
   *   without double-counting `completedAgents` or `cloudCostUsd`.
   * - Stale/timed-out worker with superseded `epoch` or `leaseToken` is strictly rejected
   *   with `{ accepted: false, reason: 'FENCED_STALE_LEASE_OR_EPOCH' }`.
   */
  public async completeTask(params: CompleteTaskParams): Promise<CompleteTaskResult> {
    const nowIso = params.nowIso ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso);

    return this.atomicMutate((state) => {
      const task = state.tasks[params.taskId];
      if (!task) {
        return {
          accepted: false,
          idempotentDuplicate: false,
          reason: 'TASK_NOT_FOUND',
        };
      }

      const idempotencyKey = params.idempotencyKey ?? `${params.leaseToken}:${params.epoch}`;
      const receiptHash = computeCompletionReceiptHash({
        taskId: params.taskId,
        idempotencyKey,
        outputSummary: params.outputSummary,
        changedFiles: params.changedFiles,
      });

      // Idempotent retry check: exact same receipt already committed for this task
      if (
        task.state === 'completed' &&
        task.idempotencyReceiptHash === receiptHash &&
        state.completedReceiptsByHash[receiptHash]?.taskId === task.taskId
      ) {
        return {
          accepted: true,
          idempotentDuplicate: true,
          receiptHash,
          task: structuredClone(task),
        };
      }

      const watermark = state.fencedEpochWatermarkByTask[task.taskId] ?? 0;

      // Fencing check: task must currently hold the exact active lease & current epoch
      if (
        (task.state !== 'running' && task.state !== 'verifying') ||
        !task.lease ||
        task.lease.leaseToken !== params.leaseToken ||
        task.lease.epoch !== params.epoch ||
        params.epoch < watermark
      ) {
        return {
          accepted: false,
          idempotentDuplicate: false,
          reason: 'FENCED_STALE_LEASE_OR_EPOCH',
          task: structuredClone(task),
        };
      }

      const verificationRequired =
        this.plan.spec.execution.verify_outputs &&
        this.plan.spec.qualification.independent_verification;
      const verificationPassed = params.verificationPassed ?? true;

      if (verificationRequired && !verificationPassed) {
        // Fence current attempt and re-queue for repair if attempts remain
        state.globalEpoch += 1;
        state.fencedEpochWatermarkByTask[task.taskId] = Math.max(
          state.globalEpoch,
          params.epoch + 1,
        );
        task.lease = undefined;
        task.verificationPassed = false;
        task.cloudCostUsd += params.cloudCostUsd ?? 0;

        if (this.plan.spec.execution.recover_failures && task.attempt < task.maxAttempts) {
          task.state = 'queued';
          task.error = 'Independent output verification failed; re-queued for repair';
          return {
            accepted: false,
            idempotentDuplicate: false,
            reason: 'VERIFICATION_FAILED_REQUEUED',
            task: structuredClone(task),
          };
        }

        task.state = 'failed';
        task.completedAt = nowIso;
        task.error = 'Independent output verification failed and maxAttempts reached';
        return {
          accepted: false,
          idempotentDuplicate: false,
          reason: 'VERIFICATION_FAILED_TERMINAL',
          task: structuredClone(task),
        };
      }

      const startedMs = task.startedAt ? Date.parse(task.startedAt) : Date.parse(task.lease.acquiredAt);
      task.state = 'completed';
      task.idempotencyReceiptHash = receiptHash;
      task.outputSummary = params.outputSummary;
      task.changedFiles = params.changedFiles ? [...params.changedFiles] : [];
      task.verificationPassed = verificationPassed;
      if (params.verificationEvidenceId) {
        task.verificationEvidenceId = params.verificationEvidenceId;
      }
      task.completedAt = nowIso;
      task.latencyMs = Math.max(0, nowMs - startedMs);
      task.cloudCostUsd += params.cloudCostUsd ?? 0;
      task.error = undefined;

      // Advance watermark so no older/same lease can ever re-mutate this task except idempotent duplicate check
      state.globalEpoch += 1;
      state.fencedEpochWatermarkByTask[task.taskId] = Math.max(
        state.globalEpoch,
        params.epoch + 1,
      );
      task.lease = undefined;
      state.completedReceiptsByHash[receiptHash] = {
        taskId: task.taskId,
        epoch: params.epoch,
        committedAt: nowIso,
      };

      this.promoteDependencySatisfiedTasks(state);

      return {
        accepted: true,
        idempotentDuplicate: false,
        receiptHash,
        task: structuredClone(task),
      };
    }, nowIso);
  }

  public async failTask(params: {
    taskId: string;
    leaseToken?: string;
    epoch?: number;
    error: string;
    graph?: CapabilityGraph;
    allowFailover?: boolean;
    nowIso?: string;
  }): Promise<{ task: DurableManagedTask; reroutedToPoolId?: string }> {
    const nowIso = params.nowIso ?? new Date().toISOString();

    return this.atomicMutate((state) => {
      const task = state.tasks[params.taskId];
      if (!task) {
        throw new Error(`Task '${params.taskId}' not found`);
      }

      if (params.leaseToken !== undefined || params.epoch !== undefined) {
        if (
          !task.lease ||
          task.lease.leaseToken !== params.leaseToken ||
          task.lease.epoch !== params.epoch
        ) {
          throw new Error(`Stale lease or fencing epoch when reporting failure for '${params.taskId}'`);
        }
      }

      state.globalEpoch += 1;
      state.fencedEpochWatermarkByTask[task.taskId] = Math.max(
        state.globalEpoch,
        (task.lease?.epoch ?? 0) + 1,
      );
      task.lease = undefined;
      task.error = params.error;

      const canRetry =
        this.plan.spec.execution.recover_failures && task.attempt < task.maxAttempts;

      if (!canRetry) {
        task.state = 'failed';
        task.completedAt = nowIso;
        return { task: structuredClone(task) };
      }

      if (
        params.allowFailover &&
        params.graph &&
        this.plan.spec.routing.fallback_policy !== 'none' &&
        !this.plan.spec.routing.strict_shares
      ) {
        const altPoolId = this.selectCapabilityAwareFailoverPool(
          state,
          task,
          task.assignedPoolId,
          params.graph,
          nowIso,
        );
        if (altPoolId && altPoolId !== task.assignedPoolId) {
          const prevPool = task.assignedPoolId;
          task.assignedPoolId = altPoolId;
          task.executedPoolId = undefined;
          task.state = 'queued';
          state.admittedTaskPoolMap[task.taskId] = altPoolId;
          const destCfg = state.pools[altPoolId];
          if (destCfg && !destCfg.reroutedFromPools.includes(prevPool)) {
            destCfg.reroutedFromPools.push(prevPool);
          }
          return { task: structuredClone(task), reroutedToPoolId: altPoolId };
        }
      }

      task.state = 'queued';
      return { task: structuredClone(task) };
    }, nowIso);
  }

  /**
   * Acceptance Test 7: Marks a pool unavailable and performs capability-aware failover
   * of its queued and in-flight tasks across compatible authorized healthy pools,
   * NEVER routing any task to `claude` or any disabled pool even under total cluster outage.
   */
  public async markPoolUnavailableAndFailover(params: {
    poolId: string;
    reason: string;
    graph: CapabilityGraph;
    nowIso?: string;
  }): Promise<FailoverResult> {
    const nowIso = params.nowIso ?? new Date().toISOString();

    return this.atomicMutate((state) => {
      const failedPoolCfg = state.pools[params.poolId];
      if (!failedPoolCfg) {
        throw new Error(`Unknown pool '${params.poolId}'`);
      }

      failedPoolCfg.acceptanceState = 'UNAVAILABLE';
      failedPoolCfg.effectiveConcurrentLimit = 0;
      failedPoolCfg.unavailabilityReason = params.reason;

      const reroutedTaskIds: string[] = [];
      const reroutedToPoolByTaskId: Record<string, string> = {};
      const unschedulableTaskIds: string[] = [];

      const affectedTasks = Object.values(state.tasks)
        .filter(
          (t) =>
            t.assignedPoolId === params.poolId &&
            (t.state === 'queued' ||
              t.state === 'admitted' ||
              t.state === 'running' ||
              t.state === 'pending_dependencies'),
        )
        .sort((a, b) => a.taskId.localeCompare(b.taskId));

      for (const task of affectedTasks) {
        if (task.lease) {
          state.globalEpoch += 1;
          state.fencedEpochWatermarkByTask[task.taskId] = Math.max(
            state.globalEpoch,
            task.lease.epoch + 1,
          );
          task.lease = undefined;
        }

        if (
          this.plan.spec.routing.fallback_policy === 'none' ||
          this.plan.spec.routing.strict_shares
        ) {
          task.state = 'failed';
          task.completedAt = nowIso;
          task.error = `Pool '${params.poolId}' unavailable and fallback disabled by strict_shares/fallback_policy`;
          unschedulableTaskIds.push(task.taskId);
          continue;
        }

        const targetPoolId = this.selectCapabilityAwareFailoverPool(
          state,
          task,
          params.poolId,
          params.graph,
          nowIso,
        );

        if (!targetPoolId) {
          task.state = 'failed';
          task.completedAt = nowIso;
          task.error = `No compatible authorized non-disabled failover pool available after '${params.poolId}' went offline (disabled pools remain strictly at 0)`;
          unschedulableTaskIds.push(task.taskId);
          continue;
        }

        task.assignedPoolId = targetPoolId;
        task.executedPoolId = undefined;
        if (task.state === 'running') {
          task.state = 'queued';
        }
        if (task.state === 'queued' || task.state === 'admitted') {
          state.admittedTaskPoolMap[task.taskId] = targetPoolId;
        }
        const destPool = state.pools[targetPoolId];
        if (destPool && !destPool.reroutedFromPools.includes(params.poolId)) {
          destPool.reroutedFromPools.push(params.poolId);
        }

        reroutedTaskIds.push(task.taskId);
        reroutedToPoolByTaskId[task.taskId] = targetPoolId;
      }

      return {
        reroutedTaskIds,
        reroutedToPoolByTaskId,
        unschedulableTaskIds,
      };
    }, nowIso);
  }

  private selectCapabilityAwareFailoverPool(
    state: PersistedControllerState,
    task: DurableManagedTask,
    excludePoolId: string,
    graph: CapabilityGraph,
    nowIso: string,
  ): string | undefined {
    const hardConstraints = parseHardUserConstraints(this.plan.spec.routing.constraints ?? []);

    // Filter plan pools to healthy, enabled, non-Claude, non-excluded pools
    const candidatePools: ExecutionPlanPoolSpec[] = this.plan.spec.pools.filter((p) => {
      if (p.id === excludePoolId) return false;
      if (!p.enabled || p.share <= 0) return false;
      if (p.id.toLowerCase() === 'claude' || p.provider?.toLowerCase() === 'claude') return false;
      if (hardConstraints.disabledProviders.includes((p.provider ?? p.id).toLowerCase())) {
        return false;
      }
      const runtimeCfg = state.pools[p.id];
      if (!runtimeCfg || !runtimeCfg.enabled || runtimeCfg.effectiveConcurrentLimit <= 0) {
        return false;
      }
      if (
        runtimeCfg.acceptanceState === 'UNAVAILABLE' ||
        runtimeCfg.acceptanceState === 'DISABLED_BY_POLICY'
      ) {
        return false;
      }
      if (this.plan.spec.routing.fallback_policy === 'local_only' && Boolean(p.provider && !p.host)) {
        return false;
      }
      return true;
    });

    if (candidatePools.length === 0) {
      return undefined;
    }

    // Re-normalize candidate shares to 100% on a synthetic sub-plan so IntelligentHardwareScheduler evaluates exact capability gates
    const shareSum = candidatePools.reduce((s, p) => s + p.share, 0);
    const normalizedPools: ExecutionPlanPoolSpec[] = candidatePools.map((p, idx) => ({
      ...p,
      share:
        idx === candidatePools.length - 1
          ? Math.max(
              0.0001,
              100 -
                candidatePools
                  .slice(0, -1)
                  .reduce((acc, prev) => acc + (prev.share / shareSum) * 100, 0),
            )
          : (p.share / shareSum) * 100,
    }));

    const failoverPlan: DeclarativeExecutionPlan = {
      ...this.plan,
      spec: {
        ...this.plan.spec,
        pools: normalizedPools,
      },
    };

    const activeRunningByPool: Record<string, number> = {};
    for (const p of normalizedPools) {
      activeRunningByPool[p.id] = this.computeQuantitiesForPoolFromState(state, p.id).runningAgents;
    }

    const scheduler = new IntelligentHardwareScheduler();
    const decision = scheduler.scheduleTask(task.profile, failoverPlan, graph, {
      activeRunningByPool,
      nowIso,
    });

    if (!decision.scheduled || !decision.selectedRoute) {
      return undefined;
    }

    const chosenPoolId = decision.selectedRoute.poolId;
    // Final defense-in-depth invariant: NEVER return claude or disabled pool
    const origSpec = this.plan.spec.pools.find((p) => p.id === chosenPoolId);
    if (!origSpec || !origSpec.enabled || origSpec.share <= 0 || chosenPoolId.toLowerCase() === 'claude') {
      return undefined;
    }
    return chosenPoolId;
  }

  public async cancelTask(
    taskId: string,
    reason = 'Cancelled by operator',
    nowIso: string = new Date().toISOString(),
  ): Promise<DurableManagedTask> {
    return this.atomicMutate((state) => {
      const task = state.tasks[taskId];
      if (!task) {
        throw new Error(`Task '${taskId}' not found`);
      }
      if (task.state === 'completed') {
        return structuredClone(task);
      }

      if (task.lease) {
        state.globalEpoch += 1;
        state.fencedEpochWatermarkByTask[task.taskId] = Math.max(
          state.globalEpoch,
          task.lease.epoch + 1,
        );
        task.lease = undefined;
      }

      task.state = 'cancelled';
      task.completedAt = nowIso;
      task.error = reason;
      return structuredClone(task);
    }, nowIso);
  }

  public async cancelAll(
    reason = 'Execution wave cancelled',
    nowIso: string = new Date().toISOString(),
  ): Promise<string[]> {
    return this.atomicMutate((state) => {
      const cancelledIds: string[] = [];
      for (const task of Object.values(state.tasks)) {
        if (task.state === 'completed' || task.state === 'cancelled') continue;
        if (task.lease) {
          state.globalEpoch += 1;
          state.fencedEpochWatermarkByTask[task.taskId] = Math.max(
            state.globalEpoch,
            task.lease.epoch + 1,
          );
          task.lease = undefined;
        }
        task.state = 'cancelled';
        task.completedAt = nowIso;
        task.error = reason;
        cancelledIds.push(task.taskId);
      }
      return cancelledIds.sort();
    }, nowIso);
  }

  public async getTask(taskId: string): Promise<DurableManagedTask | undefined> {
    const state = await this.readState();
    const t = state.tasks[taskId];
    return t ? structuredClone(t) : undefined;
  }

  public async listTasks(filterPoolId?: string): Promise<DurableManagedTask[]> {
    const state = await this.readState();
    return Object.values(state.tasks)
      .filter((t) => !filterPoolId || (t.executedPoolId ?? t.assignedPoolId) === filterPoolId)
      .sort((a, b) => a.taskId.localeCompare(b.taskId))
      .map((t) => structuredClone(t));
  }

  public async getQueuedTasks(poolId?: string): Promise<DurableManagedTask[]> {
    const state = await this.readState();
    return Object.values(state.tasks)
      .filter(
        (t) =>
          (t.state === 'queued' || t.state === 'admitted') &&
          (!poolId || t.assignedPoolId === poolId),
      )
      .sort((a, b) =>
        b.profile.priority !== a.profile.priority
          ? b.profile.priority - a.profile.priority
          : a.taskId.localeCompare(b.taskId),
      )
      .map((t) => structuredClone(t));
  }

  public async getPoolQuantities(poolId: string): Promise<PoolAllocationQuantities> {
    const state = await this.readState();
    return this.computeQuantitiesForPoolFromState(state, poolId);
  }

  public async getAllPoolQuantities(): Promise<Record<string, PoolAllocationQuantities>> {
    const state = await this.readState();
    const out: Record<string, PoolAllocationQuantities> = {};
    for (const pool of this.plan.spec.pools) {
      out[pool.id] = this.computeQuantitiesForPoolFromState(state, pool.id);
    }
    return out;
  }
}
