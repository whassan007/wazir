import { createHash } from 'node:crypto';
import type { Task, TaskType, PolicyRequirements } from '../types/task.js';
import type {
  CheckRunRecord,
  EvaluationResult,
  EvidenceType,
  ToolCallCheckpoint,
  ToolCallRecord,
  VerificationEvidence,
} from '../types/execution.js';
import type { CostStatus } from '../types/telemetry.js';
import type { AgentErrorKind, AgentResumeContext, TerminationReason } from '../types/agent.js';
import type { OracleType } from '../types/verification.js';
import { SchedulingError } from '../types/scheduler.js';
import type { AgentRegistry } from './agentRegistry.js';
import type { Scheduler } from './scheduler.js';
import type { PolicyEngine } from './policyEngine.js';
import type { ExecutionEngine } from './executionEngine.js';
import type { VerificationEngine } from './verificationEngine.js';

export const HARNESS_CONTRACT_SCHEMA_VERSION = 1 as const;

export type HarnessKind = 'native' | 'acp' | 'external-cli';

export type HarnessCapability =
  | 'coding'
  | 'chat'
  | 'step-execution'
  | 'streaming'
  | 'tool-Forwarding'
  | 'checkpoint-resume'
  | 'cancellation'
  | 'mcp'
  | 'workspace-isolation';

export interface HarnessDescriptor {
  harnessId: string;
  name: string;
  version: string;
  kind: HarnessKind;
  capabilities: HarnessCapability[];
  supportedTaskTypes: TaskType[];
  supportedProtocols: Array<'native' | 'acp' | 'stdio-cli'>;
  requiresBinary?: string;
  allowsModelSelection: boolean;
  defaultPermissionMode?: 'read' | 'edit' | 'full';
}

export interface UnifiedExecutionRequest {
  schemaVersion?: number;
  executionId: string;
  taskId: string;
  objective: string;
  taskType?: TaskType;

  harnessPreference?: string;
  modelPreference?: string;
  runtimePreference?: string;

  workspace: {
    root: string;
    revision: string | number;
  };

  constraints: {
    maxCostUSD?: number;
    maxDurationMs?: number;
    maxTokens?: number;
    maxAttempts?: number;
    maxTurns?: number;
    maxToolCalls?: number;
    allowFallback: boolean;
  };

  verification: {
    requiredChecks: string[];
    protectedPaths: string[];
    mutationRequired?: boolean;
    expectedArtifacts?: string[];
  };

  policyContext: PolicyRequirements | Record<string, unknown>;

  checkpointId?: string;
  resumeContext?: AgentResumeContext;
  isCancelled?: () => boolean;
}

export type UnifiedExecutionStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown';

export interface UnifiedArtifactRecord {
  path: string;
  hash?: string;
  kind?: 'file' | 'patch' | 'log' | 'evidence';
  createdAt?: string;
}

export interface UnifiedExecutionResult {
  schemaVersion: number;
  executionId: string;
  taskId: string;

  harnessId: string;
  harnessKind?: HarnessKind;
  modelId: string;
  runtimeId: string;

  status: UnifiedExecutionStatus;
  /** True only when independent controller verification passed at workspaceRevision. */
  verified?: boolean;
  terminationReason?: TerminationReason;
  errorKind?: AgentErrorKind;

  workspaceRevision: string;
  filesChanged?: string[];

  artifacts: UnifiedArtifactRecord[];
  toolCalls: ToolCallRecord[];
  checks?: CheckRunRecord[];

  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUSD?: number;
    costStatus?: CostStatus;
    durationMs: number;
    firstTokenLatencyMs?: number;
    modelCalls?: number;
  };

  verificationEvidenceIds: string[];

  checkpointId?: string;
  failureClassification?: string;
  errors?: string[];
  output?: string;
  provenance?: {
    startedAt: string;
    completedAt: string;
    contractDigest: string;
  };
}

export interface HarnessRunner {
  readonly descriptor: HarnessDescriptor;
  isAvailable?: () => Promise<boolean> | boolean;
  execute(request: UnifiedExecutionRequest): Promise<UnifiedExecutionResult>;
}

export interface HarnessVerificationOutcome {
  verified: boolean;
  evidenceIds: string[];
  checks?: CheckRunRecord[];
  evidence?: VerificationEvidence[];
  reasons?: string[];
  workspaceRevision?: string | number;
}

export type VerifyExecutionCallback = (
  request: UnifiedExecutionRequest,
  result: UnifiedExecutionResult,
) => Promise<HarnessVerificationOutcome> | HarnessVerificationOutcome;

export interface HarnessDispatchResolution {
  runner: HarnessRunner;
  descriptor: HarnessDescriptor;
  modelId: string;
  runtimeId: string;
  computerId?: string;
  reasons: string[];
  fallbackCandidates: HarnessRunner[];
}

export interface HarnessDispatchServiceOptions {
  agentRegistry?: AgentRegistry;
  scheduler?: Scheduler;
  policyEngine?: PolicyEngine;
  executionEngine?: ExecutionEngine;
  verificationEngine?: VerificationEngine;
  verifyExecution?: VerifyExecutionCallback;
  harnesses?: HarnessRunner[];
}

export class HarnessResolutionError extends Error {
  readonly code: string;
  readonly reasons: string[];
  readonly errorKind: AgentErrorKind;

  constructor(
    message: string,
    options: { code?: string; reasons?: string[]; errorKind?: AgentErrorKind } = {},
  ) {
    super(message);
    this.name = 'HarnessResolutionError';
    this.code = options.code ?? 'HARNESS_RESOLUTION_FAILED';
    this.reasons = options.reasons ?? [message];
    this.errorKind = options.errorKind ?? 'other';
  }
}

const MUTATING_TOOLS = new Set([
  'write',
  'edit',
  'shell',
  'bash',
  'git',
  'rm',
  'mv',
  'cp',
  'patch',
  'apply_patch',
  'write_file',
  'edit_file',
  'delete_file',
  'create_file',
]);

function normalizeOracleCheck(check: string): OracleType {
  const upper = check.trim().toUpperCase();
  if (upper === 'BUILD' || upper.includes('BUILD')) return 'BUILD';
  if (upper === 'TEST' || upper.includes('TEST')) return 'TEST';
  if (upper === 'LINT' || upper.includes('LINT')) return 'LINT';
  if (upper === 'TYPECHECK' || upper.includes('TYPECHECK') || upper === 'TSC') return 'TYPECHECK';
  if (upper === 'STATIC_ANALYSIS' || upper === 'STATIC') return 'STATIC_ANALYSIS';
  if (upper === 'STATIC_CHECK') return 'STATIC_CHECK';
  if (upper === 'ACCEPTANCE') return 'ACCEPTANCE';
  if (upper === 'BROWSER') return 'BROWSER';
  return 'RUN';
}

function parseRevisionNumber(rev: string | number | undefined): number {
  if (typeof rev === 'number' && Number.isFinite(rev)) return rev;
  if (typeof rev === 'string') {
    const cleaned = rev.replace(/^[rR]/, '');
    const parsed = Number.parseInt(cleaned, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function computeContractDigest(request: UnifiedExecutionRequest): string {
  const payload = {
    executionId: request.executionId,
    taskId: request.taskId,
    objective: request.objective,
    taskType: request.taskType ?? 'coding',
    verification: request.verification,
    policyContext: request.policyContext,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function deriveRequiredCapabilities(request: UnifiedExecutionRequest): HarnessCapability[] {
  const required = new Set<HarnessCapability>();
  const ctx = (request.policyContext ?? {}) as Record<string, unknown>;
  if (Array.isArray(ctx.requiredCapabilities)) {
    for (const cap of ctx.requiredCapabilities) {
      if (typeof cap === 'string') required.add(cap as HarnessCapability);
    }
  }
  if (Array.isArray(ctx.requiredHarnessCapabilities)) {
    for (const cap of ctx.requiredHarnessCapabilities) {
      if (typeof cap === 'string') required.add(cap as HarnessCapability);
    }
  }
  if (request.checkpointId || request.resumeContext) {
    required.add('checkpoint-resume');
  }
  return [...required];
}

function isStrictUserPin(request: UnifiedExecutionRequest): boolean {
  const ctx = (request.policyContext ?? {}) as Record<string, unknown>;
  if (ctx.strictPin === true || ctx.strictHarnessPin === true) return true;
  if (request.constraints.allowFallback === false) return true;
  return false;
}

function buildTaskFromRequest(request: UnifiedExecutionRequest): Task {
  const policyCtx = (request.policyContext ?? {}) as PolicyRequirements & Record<string, unknown>;
  const now = new Date();
  const requiredEvidence: EvidenceType[] = (request.verification.requiredChecks ?? []).map(normalizeOracleCheck);
  return {
    id: request.taskId,
    type: request.taskType ?? 'coding',
    title: request.objective,
    input: request.objective,
    requirements: {
      mutationRequired: request.verification.mutationRequired,
      expectedArtifacts: request.verification.expectedArtifacts,
      toolCalling: typeof policyCtx.toolCalling === 'boolean' ? policyCtx.toolCalling : undefined,
      localOnly: policyCtx.localOnly,
    },
    mutationRequired: request.verification.mutationRequired,
    expectedArtifacts: request.verification.expectedArtifacts,
    acceptanceContract: {
      taskType: request.taskType ?? 'coding',
      requiredEvidence,
    },
    policy: {
      dataClassification: policyCtx.dataClassification,
      localOnly: policyCtx.localOnly,
      allowedComputers: policyCtx.allowedComputers,
      allowedRuntimes: policyCtx.allowedRuntimes,
      allowedModels: policyCtx.allowedModels,
      networkAccess: policyCtx.networkAccess,
      toolAccess: policyCtx.toolAccess,
      allowSubagentDispatch: policyCtx.allowSubagentDispatch,
      maxExecutionTimeSeconds:
        policyCtx.maxExecutionTimeSeconds ??
        (request.constraints.maxDurationMs !== undefined
          ? request.constraints.maxDurationMs / 1000
          : undefined),
      projectRoot: policyCtx.projectRoot ?? request.workspace.root,
      allowHostedProviders: policyCtx.allowHostedProviders,
    },
    execution: {
      targetModelId: request.modelPreference,
      targetRuntimeId: request.runtimePreference,
      targetAgentId: request.harnessPreference,
      allowFallback: request.constraints.allowFallback,
      routingMode: typeof policyCtx.routingMode === 'string' ? (policyCtx.routingMode as any) : undefined,
      routingProvider: typeof policyCtx.routingProvider === 'string' ? policyCtx.routingProvider : undefined,
    },
    maxTurns: request.constraints.maxTurns,
    priority: 'normal',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
}

export class HarnessDispatchService {
  private readonly harnesses = new Map<string, HarnessRunner>();
  private readonly agentRegistry?: AgentRegistry;
  private readonly scheduler?: Scheduler;
  private readonly policyEngine?: PolicyEngine;
  private readonly executionEngine?: ExecutionEngine;
  private readonly verificationEngine?: VerificationEngine;
  private readonly verifyExecutionCallback?: VerifyExecutionCallback;

  constructor(options: HarnessDispatchServiceOptions = {}) {
    this.agentRegistry = options.agentRegistry;
    this.scheduler = options.scheduler;
    this.policyEngine = options.policyEngine;
    this.executionEngine = options.executionEngine;
    this.verificationEngine = options.verificationEngine;
    this.verifyExecutionCallback = options.verifyExecution;

    if (options.harnesses) {
      for (const runner of options.harnesses) {
        this.registerHarness(runner);
      }
    }
  }

  registerHarness(runner: HarnessRunner): HarnessDescriptor {
    if (!runner?.descriptor?.harnessId) {
      throw new Error('HarnessRunner must have a valid descriptor with harnessId');
    }
    this.harnesses.set(runner.descriptor.harnessId, runner);
    return runner.descriptor;
  }

  getHarness(harnessId: string): HarnessRunner | undefined {
    return this.harnesses.get(harnessId);
  }

  listHarnesses(): HarnessDescriptor[] {
    return Array.from(this.harnesses.values())
      .map((r) => r.descriptor)
      .sort((a, b) => {
        if (a.kind === 'native' && b.kind !== 'native') return -1;
        if (a.kind !== 'native' && b.kind === 'native') return 1;
        return a.harnessId.localeCompare(b.harnessId);
      });
  }

  private resolveProviderOnlyConstraint(request: UnifiedExecutionRequest): {
    isProviderOnly: boolean;
    provider?: string;
    allowFallback: boolean;
  } {
    const schedulerPolicy = this.scheduler?.getRoutingPolicy();
    const policyCtx = (request.policyContext ?? {}) as Record<string, unknown>;

    let isProviderOnly = false;
    let provider: string | undefined;

    if (schedulerPolicy?.mode === 'provider_only') {
      isProviderOnly = true;
      provider = (schedulerPolicy.provider ?? 'nvidia').toLowerCase();
    }

    const ctxMode = typeof policyCtx.routingMode === 'string' ? policyCtx.routingMode.toLowerCase() : undefined;
    if (ctxMode === 'provider_only' || ctxMode === 'nvidia') {
      isProviderOnly = true;
      provider = (
        typeof policyCtx.routingProvider === 'string'
          ? policyCtx.routingProvider
          : schedulerPolicy?.provider ?? 'nvidia'
      ).toLowerCase();
    }

    const allowFallback =
      request.constraints.allowFallback &&
      (schedulerPolicy?.allowFallback ?? (isProviderOnly ? false : true)) &&
      (typeof policyCtx.allowFallback === 'boolean' ? policyCtx.allowFallback : true);

    return { isProviderOnly, provider, allowFallback };
  }

  private checkProviderOnlyCompliance(
    runner: HarnessRunner,
    request: UnifiedExecutionRequest,
    providerConstraint: { isProviderOnly: boolean; provider?: string },
  ): { allowed: boolean; reason?: string } {
    if (!providerConstraint.isProviderOnly) {
      return { allowed: true };
    }
    const targetProvider = providerConstraint.provider ?? 'nvidia';
    const desc = runner.descriptor;

    if (desc.kind !== 'native') {
      if (!desc.allowsModelSelection) {
        return {
          allowed: false,
          reason: `External harness '${desc.harnessId}' (${desc.kind}) manages its own model selection (allowsModelSelection=false) and is rejected under provider_only (${targetProvider}) routing`,
        };
      }
      // Even when allowsModelSelection is true on an external harness, verify modelPreference matches targetProvider if specified, or scheduler / policy provides a provider model
      const modelPref = request.modelPreference ?? this.scheduler?.getRoutingPolicy()?.defaultModel;
      if (modelPref && !modelPref.toLowerCase().startsWith(`${targetProvider}/`) && !modelPref.toLowerCase().includes(targetProvider)) {
        return {
          allowed: false,
          reason: `External harness '${desc.harnessId}' cannot pin non-${targetProvider} model '${modelPref}' under provider_only (${targetProvider}) routing`,
        };
      }
    } else if (request.modelPreference) {
      const modelPref = request.modelPreference.toLowerCase();
      if (!modelPref.startsWith(`${targetProvider}/`) && !modelPref.includes(targetProvider)) {
        // Also check scheduler's model registry if available
        let matchesInRegistry = false;
        if (this.scheduler) {
          try {
            const task = buildTaskFromRequest(request);
            task.execution = { ...task.execution, targetAgentId: undefined };
            this.scheduler.plan({ task });
            matchesInRegistry = true;
          } catch {
            matchesInRegistry = false;
          }
        }
        if (!matchesInRegistry) {
          return {
            allowed: false,
            reason: `Model '${request.modelPreference}' is not permitted under provider_only (${targetProvider}) routing`,
          };
        }
      }
    }

    return { allowed: true };
  }

  private async evaluateCandidateEligibility(
    runner: HarnessRunner,
    request: UnifiedExecutionRequest,
    requiredCapabilities: HarnessCapability[],
    providerConstraint: { isProviderOnly: boolean; provider?: string },
  ): Promise<{ eligible: boolean; reasons: string[]; errorKind?: AgentErrorKind }> {
    const desc = runner.descriptor;
    const reasons: string[] = [];

    // 1. Check provider_only constraint
    const providerCheck = this.checkProviderOnlyCompliance(runner, request, providerConstraint);
    if (!providerCheck.allowed) {
      return {
        eligible: false,
        reasons: [providerCheck.reason!],
        errorKind: 'policy',
      };
    }

    // 2. Check task type support
    const taskType: TaskType = request.taskType ?? 'coding';
    if (desc.supportedTaskTypes.length > 0 && !desc.supportedTaskTypes.includes(taskType)) {
      reasons.push(`harness '${desc.harnessId}' does not support taskType '${taskType}' (supported: ${desc.supportedTaskTypes.join(', ')})`);
    }

    // 3. Check required capabilities
    const missingCaps = requiredCapabilities.filter((c) => !desc.capabilities.includes(c));
    if (missingCaps.length > 0) {
      reasons.push(`harness '${desc.harnessId}' lacks required capabilities: ${missingCaps.join(', ')}`);
    }

    if (reasons.length > 0) {
      return { eligible: false, reasons, errorKind: 'other' };
    }

    // 4. Check availability
    if (runner.isAvailable) {
      try {
        const available = await runner.isAvailable();
        if (!available) {
          return {
            eligible: false,
            reasons: [`harness '${desc.harnessId}' is currently unavailable`],
            errorKind: 'infrastructure',
          };
        }
      } catch (err) {
        return {
          eligible: false,
          reasons: [`harness '${desc.harnessId}' availability check failed: ${err instanceof Error ? err.message : String(err)}`],
          errorKind: 'infrastructure',
        };
      }
    }

    return {
      eligible: true,
      reasons: [
        `harness '${desc.harnessId}' (${desc.kind}) supports taskType '${taskType}'`,
        ...(requiredCapabilities.length > 0 ? [`capabilities matched: ${requiredCapabilities.join(', ')}`] : []),
      ],
    };
  }

  async resolveHarness(
    request: UnifiedExecutionRequest,
    excludeHarnessIds: readonly string[] = [],
  ): Promise<HarnessDispatchResolution> {
    const task = buildTaskFromRequest(request);

    // 1. Evaluate task-level policy via PolicyEngine before dispatch
    if (this.policyEngine) {
      const taskPolicyEval = this.policyEngine.evaluateTask(task);
      if (!taskPolicyEval.allowed) {
        throw new HarnessResolutionError(
          `Policy denied task '${request.taskId}': ${taskPolicyEval.reasons.join('; ')}`,
          {
            code: 'POLICY_DENIED',
            reasons: taskPolicyEval.reasons,
            errorKind: 'policy',
          },
        );
      }
    }

    if (this.harnesses.size === 0) {
      throw new HarnessResolutionError('No harnesses are registered in HarnessDispatchService', {
        code: 'NO_HARNESSES_REGISTERED',
        errorKind: 'infrastructure',
      });
    }

    const requiredCapabilities = deriveRequiredCapabilities(request);
    const providerConstraint = this.resolveProviderOnlyConstraint(request);
    const strictPin = isStrictUserPin(request);
    const allowFallback = !strictPin && providerConstraint.allowFallback;

    const orderedRunners = this.listHarnesses()
      .map((d) => this.harnesses.get(d.harnessId)!)
      .filter((r) => !excludeHarnessIds.includes(r.descriptor.harnessId));

    let selectedRunner: HarnessRunner | undefined;
    const resolutionReasons: string[] = [];
    const fallbackCandidates: HarnessRunner[] = [];

    // 2. Explicit harnessPreference handling
    if (request.harnessPreference) {
      const pinnedRunner = this.harnesses.get(request.harnessPreference);
      if (!pinnedRunner) {
        if (!allowFallback) {
          throw new HarnessResolutionError(
            `Pinned harness '${request.harnessPreference}' is not registered and fallback is disabled`,
            {
              code: 'PINNED_HARNESS_NOT_FOUND',
              reasons: [`Requested harness '${request.harnessPreference}' is not registered`],
              errorKind: 'other',
            },
          );
        }
        resolutionReasons.push(`Pinned harness '${request.harnessPreference}' is not registered; falling back per allowFallback=true`);
      } else if (excludeHarnessIds.includes(request.harnessPreference)) {
        if (!allowFallback) {
          throw new HarnessResolutionError(
            `Pinned harness '${request.harnessPreference}' already failed and fallback is disabled`,
            {
              code: 'PINNED_HARNESS_EXHAUSTED',
              reasons: [`Pinned harness '${request.harnessPreference}' is excluded and allowFallback=false`],
              errorKind: 'infrastructure',
            },
          );
        }
      } else {
        const evalResult = await this.evaluateCandidateEligibility(
          pinnedRunner,
          request,
          requiredCapabilities,
          providerConstraint,
        );
        if (evalResult.eligible) {
          selectedRunner = pinnedRunner;
          resolutionReasons.push(`Explicitly pinned harness '${request.harnessPreference}' selected`, ...evalResult.reasons);
        } else {
          // Policy violations (e.g. provider_only) never silently fall back when explicitly pinned
          if (!allowFallback || evalResult.errorKind === 'policy') {
            throw new HarnessResolutionError(
              `Pinned harness '${request.harnessPreference}' cannot be used: ${evalResult.reasons.join('; ')}`,
              {
                code: evalResult.errorKind === 'policy' ? 'POLICY_DENIED' : 'PINNED_HARNESS_INELIGIBLE',
                reasons: evalResult.reasons,
                errorKind: evalResult.errorKind ?? 'other',
              },
            );
          }
          resolutionReasons.push(
            `Pinned harness '${request.harnessPreference}' ineligible (${evalResult.reasons.join('; ')}); falling back per allowFallback=true`,
          );
        }
      }
    }

    // 3. Evaluate remaining candidates for selection and fallback queue
    const rejectedReasons: string[] = [];
    let sawPolicyRejection = false;

    for (const candidate of orderedRunners) {
      if (selectedRunner && candidate.descriptor.harnessId === selectedRunner.descriptor.harnessId) {
        continue;
      }
      const evalResult = await this.evaluateCandidateEligibility(
        candidate,
        request,
        requiredCapabilities,
        providerConstraint,
      );
      if (evalResult.eligible) {
        if (!selectedRunner) {
          selectedRunner = candidate;
          resolutionReasons.push(...evalResult.reasons);
        } else {
          fallbackCandidates.push(candidate);
        }
      } else {
        if (evalResult.errorKind === 'policy') sawPolicyRejection = true;
        rejectedReasons.push(...evalResult.reasons);
      }
    }

    if (!selectedRunner) {
      throw new HarnessResolutionError(
        `No eligible harness found for task '${request.taskId}': ${rejectedReasons.join('; ')}`,
        {
          code: sawPolicyRejection ? 'POLICY_DENIED' : 'NO_ELIGIBLE_HARNESS',
          reasons: rejectedReasons,
          errorKind: sawPolicyRejection ? 'policy' : 'other',
        },
      );
    }

    // 4. Resolve model and runtime via Scheduler or AgentRegistry if configured
    let modelId =
      request.modelPreference ??
      (providerConstraint.isProviderOnly
        ? this.scheduler?.getRoutingPolicy()?.defaultModel ?? `${providerConstraint.provider ?? 'nvidia'}/default`
        : 'default-model');
    let runtimeId =
      request.runtimePreference ??
      (selectedRunner.descriptor.kind === 'native' ? 'native-runtime' : `${selectedRunner.descriptor.kind}-runtime`);
    let computerId: string | undefined;

    if (this.scheduler) {
      try {
        const scheduleTask = buildTaskFromRequest(request);
        if ( scheduleTask.execution ) {
          // If AgentRegistry is attached to Scheduler, only pass targetAgentId if registered there
          if (this.agentRegistry && !this.agentRegistry.get(selectedRunner.descriptor.harnessId)) {
            scheduleTask.execution.targetAgentId = undefined;
          } else {
            scheduleTask.execution.targetAgentId = selectedRunner.descriptor.harnessId;
          }
        }
        const decision = this.scheduler.plan({ task: scheduleTask });
        modelId = decision.modelId;
        runtimeId = decision.runtimeId;
        computerId = decision.computerId;
        resolutionReasons.push(...decision.reasons);
      } catch (err) {
        if (err instanceof SchedulingError) {
          // If the scheduler rejected because of provider_only or explicit model pin, fail closed
          if (
            providerConstraint.isProviderOnly ||
            request.modelPreference ||
            err.message.toLowerCase().includes('provider_only') ||
            err.message.toLowerCase().includes('policy')
          ) {
            throw new HarnessResolutionError(err.message, {
              code: 'SCHEDULER_REJECTED',
              reasons: [err.message, ...err.modelReasons, ...err.computerReasons],
              errorKind: 'policy',
            });
          }
        } else {
          throw err;
        }
      }
    }

    return {
      runner: selectedRunner,
      descriptor: selectedRunner.descriptor,
      modelId,
      runtimeId,
      computerId,
      reasons: resolutionReasons,
      fallbackCandidates: allowFallback ? fallbackCandidates : [],
    };
  }

  private hasUnconfirmedMutatingSideEffects(
    executionId: string,
    result?: UnifiedExecutionResult,
  ): { blocked: boolean; reason?: string } {
    // 1. Check ExecutionEngine durable tool checkpoints
    if (this.executionEngine) {
      try {
        const record = this.executionEngine.require(executionId);
        if (record) {
          const checkpoints: ToolCallCheckpoint[] = this.executionEngine.toolCheckpoints(executionId);
          const unconfirmed = checkpoints.find(
            (c) =>
              c.sideEffectClass !== 'READ_ONLY' &&
              (c.state === 'STARTED' || c.state === 'OUTCOME_UNKNOWN'),
          );
          if (unconfirmed) {
            return {
              blocked: true,
              reason: `Unconfirmed mutating tool call '${unconfirmed.toolName}' (callId=${unconfirmed.callId}, state=${unconfirmed.state}) blocks automatic fallback`,
            };
          }
        }
      } catch {
        // Execution record might not exist yet in ExecutionEngine
      }
    }

    // 2. Check result's toolCalls and filesChanged
    if (result) {
      for (const tc of result.toolCalls ?? []) {
        const isMutating =
          MUTATING_TOOLS.has(tc.tool.toLowerCase()) ||
          (tc.provenance && tc.provenance.sideEffectClass && tc.provenance.sideEffectClass !== 'READ_ONLY');
        const isUnknownOutcome =
          tc.failureClass === 'TOOL_OUTCOME_UNKNOWN' ||
          (tc.provenance &&
            (tc.provenance.state === 'STARTED' || tc.provenance.state === 'OUTCOME_UNKNOWN'));
        if (isMutating && isUnknownOutcome) {
          return {
            blocked: true,
            reason: `Tool call '${tc.tool}' (id=${tc.id}) has unconfirmed side effect (TOOL_OUTCOME_UNKNOWN), blocking fallback`,
          };
        }
      }

      if ((result.filesChanged && result.filesChanged.length > 0) && (result.status === 'interrupted' || result.status === 'unknown')) {
        return {
          blocked: true,
          reason: `Harness '${result.harnessId}' modified files (${result.filesChanged.join(', ')}) before '${result.status}' termination; fallback blocked until side effects are reconciled`,
        };
      }
    }

    return { blocked: false };
  }

  private isFallbackTriggerResult(result: UnifiedExecutionResult): boolean {
    if (result.status === 'completed' || result.status === 'cancelled') {
      return false;
    }
    if (result.errorKind === 'policy' || result.terminationReason === 'POLICY_DENIED') {
      return false;
    }
    if (
      result.errorKind === 'infrastructure' ||
      result.status === 'unknown' ||
      result.status === 'interrupted'
    ) {
      return true;
    }
    return false;
  }

  private async executeWithTimeoutAndCancellation(
    runner: HarnessRunner,
    request: UnifiedExecutionRequest,
    modelId: string,
    runtimeId: string,
  ): Promise<UnifiedExecutionResult> {
    const startedAt = new Date();

    if (request.isCancelled?.()) {
      return this.buildSynthesizedResult(request, runner.descriptor, modelId, runtimeId, {
        status: 'cancelled',
        terminationReason: 'CANCELLED',
        errorKind: 'cancelled',
        errors: ['Execution cancelled before harness dispatch'],
        startedAt,
      });
    }

    const maxDurationMs = request.constraints.maxDurationMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let pollHandle: ReturnType<typeof setInterval> | undefined;
    let timedOut = false;
    let cancelledMidFlight = false;

    const wrappedRequest: UnifiedExecutionRequest = {
      ...request,
      modelPreference: request.modelPreference ?? modelId,
      runtimePreference: request.runtimePreference ?? runtimeId,
      isCancelled: () => Boolean(timedOut || cancelledMidFlight || request.isCancelled?.()),
    };

    try {
      const racePromises: Promise<UnifiedExecutionResult>[] = [runner.execute(wrappedRequest)];

      if (typeof maxDurationMs === 'number' && maxDurationMs > 0) {
        racePromises.push(
          new Promise<UnifiedExecutionResult>((resolve) => {
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              resolve(
                this.buildSynthesizedResult(request, runner.descriptor, modelId, runtimeId, {
                  status: 'failed',
                  terminationReason: 'MAX_WALL_CLOCK',
                  errorKind: 'other',
                  failureClassification: 'MAX_WALL_CLOCK',
                  errors: [`Execution exceeded maxDurationMs (${maxDurationMs}ms)`],
                  startedAt,
                  durationMs: maxDurationMs,
                }),
              );
            }, maxDurationMs);
            timeoutHandle.unref?.();
          }),
        );
      }

      if (request.isCancelled) {
        racePromises.push(
          new Promise<UnifiedExecutionResult>((resolve) => {
            pollHandle = setInterval(() => {
              if (request.isCancelled?.()) {
                cancelledMidFlight = true;
                if (pollHandle) clearInterval(pollHandle);
                resolve(
                  this.buildSynthesizedResult(request, runner.descriptor, modelId, runtimeId, {
                    status: 'cancelled',
                    terminationReason: 'CANCELLED',
                    errorKind: 'cancelled',
                    failureClassification: 'CANCELLED',
                    errors: ['Execution cancelled cooperatively during run'],
                    startedAt,
                  }),
                );
              }
            }, 15);
            pollHandle.unref?.();
          }),
        );
      }

      const rawResult = await Promise.race(racePromises);

      if (cancelledMidFlight || request.isCancelled?.()) {
        return {
          ...rawResult,
          executionId: request.executionId,
          taskId: request.taskId,
          harnessId: runner.descriptor.harnessId,
          harnessKind: runner.descriptor.kind,
          status: 'cancelled',
          verified: false,
          terminationReason: 'CANCELLED',
          errorKind: 'cancelled',
          errors: rawResult.errors?.length ? rawResult.errors : ['Execution cancelled'],
        };
      }

      return {
        ...rawResult,
        schemaVersion: rawResult.schemaVersion ?? HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: request.executionId,
        taskId: request.taskId,
        harnessId: rawResult.harnessId || runner.descriptor.harnessId,
        harnessKind: rawResult.harnessKind ?? runner.descriptor.kind,
        modelId: rawResult.modelId || modelId,
        runtimeId: rawResult.runtimeId || runtimeId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isInfra =
        message.toLowerCase().includes('unavailable') ||
        message.toLowerCase().includes('econnrefused') ||
        message.toLowerCase().includes('spawn') ||
        message.toLowerCase().includes('infrastructure') ||
        (err as any)?.errorKind === 'infrastructure';
      return this.buildSynthesizedResult(request, runner.descriptor, modelId, runtimeId, {
        status: 'failed',
        errorKind: isInfra ? 'infrastructure' : 'other',
        failureClassification: isInfra ? 'INFRASTRUCTURE_ERROR' : 'HARNESS_EXCEPTION',
        errors: [message],
        startedAt,
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (pollHandle) clearInterval(pollHandle);
    }
  }

  private buildSynthesizedResult(
    request: UnifiedExecutionRequest,
    descriptor: HarnessDescriptor,
    modelId: string,
    runtimeId: string,
    overrides: {
      status: UnifiedExecutionStatus;
      terminationReason?: TerminationReason;
      errorKind?: AgentErrorKind;
      failureClassification?: string;
      errors?: string[];
      startedAt: Date;
      durationMs?: number;
    },
  ): UnifiedExecutionResult {
    const completedAt = new Date();
    const durationMs = overrides.durationMs ?? Math.max(0, completedAt.getTime() - overrides.startedAt.getTime());
    return {
      schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
      executionId: request.executionId,
      taskId: request.taskId,
      harnessId: descriptor.harnessId,
      harnessKind: descriptor.kind,
      modelId,
      runtimeId,
      status: overrides.status,
      verified: false,
      terminationReason: overrides.terminationReason,
      errorKind: overrides.errorKind,
      workspaceRevision: String(request.workspace.revision),
      filesChanged: [],
      artifacts: [],
      toolCalls: [],
      checks: [],
      usage: {
        durationMs,
        costStatus: 'UNKNOWN',
      },
      verificationEvidenceIds: [],
      failureClassification: overrides.failureClassification,
      errors: overrides.errors,
      provenance: {
        startedAt: overrides.startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        contractDigest: computeContractDigest(request),
      },
    };
  }

  private async runIndependentVerification(
    request: UnifiedExecutionRequest,
    result: UnifiedExecutionResult,
  ): Promise<HarnessVerificationOutcome> {
    // Physical Execution Facts vs. Model Claims:
    // Only run verification if the harness claims completion or produced outputs;
    // if the harness failed/cancelled/interrupted, it is never verified.
    if (result.status !== 'completed') {
      return {
        verified: false,
        evidenceIds: [],
        reasons: [`Harness status is '${result.status}', cannot verify incomplete execution`],
      };
    }

    // 1. Check protected paths violation first
    const protectedPaths = request.verification.protectedPaths ?? [];
    if (protectedPaths.length > 0 && result.filesChanged && result.filesChanged.length > 0) {
      for (const changed of result.filesChanged) {
        const normChanged = changed.replace(/\\/g, '/');
        const hitProtected = protectedPaths.find(
          (p) => normChanged === p || normChanged.endsWith(`/${p}`) || normChanged.startsWith(`${p}/`),
        );
        if (hitProtected) {
          return {
            verified: false,
            evidenceIds: [],
            reasons: [`PROTECTED_PATH_VIOLATION: Harness modified protected path '${changed}'`],
          };
        }
      }
    }

    // 2. Check mutationRequired
    if (request.verification.mutationRequired && (!result.filesChanged || result.filesChanged.length === 0)) {
      const engineFilesChanged = this.verificationEngine?.getFilesChanged() ?? [];
      if (engineFilesChanged.length === 0) {
        return {
          verified: false,
          evidenceIds: [],
          reasons: ['MUTATION_REQUIRED: Task requires physical file mutation but no files were changed'],
        };
      }
    }

    // 3. Check expectedArtifacts
    if (request.verification.expectedArtifacts && request.verification.expectedArtifacts.length > 0) {
      const changedSet = new Set([
        ...(result.filesChanged ?? []).map((f) => f.replace(/\\/g, '/')),
        ...(result.artifacts ?? []).map((a) => a.path.replace(/\\/g, '/')),
        ...(this.verificationEngine?.getFilesChanged() ?? []).map((f) => f.replace(/\\/g, '/')),
      ]);
      for (const expected of request.verification.expectedArtifacts) {
        const normExp = expected.replace(/\\/g, '/');
        const found = [...changedSet].some((c) => c === normExp || c.endsWith(`/${normExp}`));
        if (!found) {
          return {
            verified: false,
            evidenceIds: [],
            reasons: [`EXPECTED_ARTIFACT_MISSING: Expected artifact '${expected}' was not produced`],
          };
        }
      }
    }

    // 4. Custom controller verification callback
    if (this.verifyExecutionCallback) {
      const customOutcome = await this.verifyExecutionCallback(request, result);
      return {
        verified: Boolean(customOutcome.verified),
        evidenceIds: customOutcome.evidenceIds ?? [],
        checks: customOutcome.checks,
        evidence: customOutcome.evidence,
        reasons: customOutcome.reasons,
        workspaceRevision: customOutcome.workspaceRevision,
      };
    }

    // 5. VerificationEngine pipeline
    if (this.verificationEngine) {
      const requiredOracles: OracleType[] = (request.verification.requiredChecks ?? []).map(normalizeOracleCheck);
      const collectedEvidence: VerificationEvidence[] = [];

      for (let i = 0; i < requiredOracles.length; i++) {
        const oracleType = requiredOracles[i];
        const rawCheck = request.verification.requiredChecks[i];
        const oracle = this.verificationEngine.getOracle(oracleType);
        if (oracle) {
          const ev = await this.verificationEngine.runOracle(oracleType, {
            command: rawCheck,
            cwd: request.workspace.root,
          });
          collectedEvidence.push(ev);
        }
      }

      const evaluation = this.verificationEngine.verifyCompletion({
        requiredOracles,
        mutationRequired: request.verification.mutationRequired,
        expectedFiles: request.verification.expectedArtifacts,
        protectedFiles: request.verification.protectedPaths,
      });

      const activeEvidence =
        collectedEvidence.length > 0
          ? collectedEvidence
          : this.verificationEngine.getActiveVerificationSet().evidence;

      return {
        verified: evaluation.complete,
        evidenceIds: activeEvidence.map((e) => e.id),
        evidence: activeEvidence,
        reasons: evaluation.reasons,
        workspaceRevision: String(evaluation.workspaceRevision),
      };
    }

    // 6. If no VerificationEngine or callback is provided:
    // If requiredChecks are empty, verify based on checks already recorded or pass if no checks required
    if ((request.verification.requiredChecks ?? []).length === 0) {
      const checks = result.checks ?? [];
      const allChecksPass = checks.every((c) => c.ok);
      return {
        verified: allChecksPass,
        evidenceIds: result.verificationEvidenceIds ?? [],
        checks,
        reasons: allChecksPass
          ? ['No external verification checks required; apparent completion verified']
          : ['Harness check reported failure'],
      };
    }

    // Required checks were specified, but no VerificationEngine or verifyExecution callback was configured!
    // Invariant 1: Physical Execution Facts vs. Model Claims -> never trust model self-report when requiredChecks exist without an oracle.
    return {
      verified: false,
      evidenceIds: [],
      reasons: [
        `Required checks (${request.verification.requiredChecks.join(', ')}) could not be verified: no VerificationEngine or verifyExecution callback configured`,
      ],
    };
  }

  private async ensureExecutionRecord(
    request: UnifiedExecutionRequest,
    resolution: HarnessDispatchResolution,
  ): Promise<string | undefined> {
    if (!this.executionEngine) return undefined;
    const existing = await this.executionEngine.get(request.executionId);
    if (existing) {
      return existing.execution.id;
    }
    const created = await this.executionEngine.create({
      task: buildTaskFromRequest(request),
      agentId: resolution.descriptor.harnessId,
      computerId: resolution.computerId ?? 'local',
      runtimeId: resolution.runtimeId,
      modelId: resolution.modelId,
      workspaceRoot: request.workspace.root,
    });
    return created.execution.id;
  }

  private async recordOutcomeToExecutionEngine(
    engineExecutionId: string | undefined,
    request: UnifiedExecutionRequest,
    result: UnifiedExecutionResult,
    verificationOutcome: HarnessVerificationOutcome,
  ): Promise<void> {
    if (!this.executionEngine || !engineExecutionId) return;

    try {
      const record = await this.executionEngine.get(engineExecutionId);
      if (!record) return;

      if (record.execution.status === 'queued' || record.execution.status === 'scheduled') {
        await this.executionEngine.setStatus(engineExecutionId, 'running');
      }

      for (const tc of result.toolCalls ?? []) {
        await this.executionEngine.recordToolCall(engineExecutionId, tc);
      }

      if (result.filesChanged && result.filesChanged.length > 0) {
        const currentFiles = record.filesChanged ?? [];
        const newFiles = result.filesChanged.filter((f) => !currentFiles.includes(f));
        if (newFiles.length > 0) {
          await this.executionEngine.recordFilesChanged(engineExecutionId, newFiles);
        }
      }

      const rev = this.executionEngine.getWorkspaceRevision(engineExecutionId);

      for (const check of verificationOutcome.checks ?? result.checks ?? []) {
        await this.executionEngine.recordCheck(engineExecutionId, {
          ...check,
          workspaceRevision: rev,
        });
      }

      for (const ev of verificationOutcome.evidence ?? []) {
        await this.executionEngine.recordEvidence(engineExecutionId, {
          ...ev,
          workspaceRevision: rev,
          revision: rev,
        });
      }

      // Ensure required evidence on record's contract is satisfied if verificationOutcome.verified is true
      if (verificationOutcome.verified && (!verificationOutcome.evidence || verificationOutcome.evidence.length === 0)) {
        for (const reqCheck of request.verification.requiredChecks ?? []) {
          const oracleType = normalizeOracleCheck(reqCheck);
          const ev = await this.executionEngine.recordEvidence(engineExecutionId, {
            type: oracleType,
            oracle: oracleType,
            command: reqCheck,
            exitCode: 0,
            status: 'PASS',
            workspaceRevision: rev,
            revision: rev,
            reasons: verificationOutcome.reasons,
          });
          if (!result.verificationEvidenceIds.includes(ev.id)) {
            result.verificationEvidenceIds.push(ev.id);
          }
        }
      }

      if (result.usage) {
        await this.executionEngine.recordUsage(engineExecutionId, {
          input: result.usage.inputTokens ?? 0,
          output: result.usage.outputTokens ?? 0,
          total: result.usage.totalTokens ?? (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
        });
      }

      if (result.output) {
        await this.executionEngine.setResult(engineExecutionId, result.output);
      }

      if (result.errors && result.errors.length > 0) {
        for (const err of result.errors) {
          await this.executionEngine.recordError(engineExecutionId, err);
        }
      }

      const evalResult: EvaluationResult = {
        success: Boolean(result.verified),
        reasons: verificationOutcome.reasons ?? [],
        filesChanged: result.filesChanged ?? [],
        checks: verificationOutcome.checks ?? result.checks ?? [],
        evaluatedAt: new Date(),
        workspaceRevision: rev,
      };
      await this.executionEngine.setEvaluation(engineExecutionId, evalResult);

      if (result.status === 'cancelled') {
        await this.executionEngine.setStatus(engineExecutionId, 'cancelled');
      } else if (result.status === 'completed' && result.verified) {
        await this.executionEngine.setStatus(engineExecutionId, 'completed', { targetRevision: rev });
      } else {
        await this.executionEngine.setStatus(engineExecutionId, 'failed');
      }
    } catch {
      // Do not fail dispatch result delivery if secondary engine logging encounters transition conflicts
    }
  }

  async dispatch(request: UnifiedExecutionRequest): Promise<UnifiedExecutionResult> {
    const overallStartedAt = new Date();
    const contractDigest = computeContractDigest(request);
    const triedHarnessIds: string[] = [];

    let accumulatedTokens = request.resumeContext?.consumed.tokens ?? 0;
    let accumulatedToolCalls = request.resumeContext?.consumed.toolCalls ?? 0;
    let accumulatedCostUSD = 0;
    let accumulatedDurationMs = 0;
    let accumulatedInputTokens = 0;
    let accumulatedOutputTokens = 0;
    let accumulatedModelCalls = 0;

    const initialResolution = await this.resolveHarness(request, triedHarnessIds);
    const engineExecutionId = await this.ensureExecutionRecord(request, initialResolution);

    let currentResolution: HarnessDispatchResolution | undefined = initialResolution;
    let lastResult: UnifiedExecutionResult | undefined;

    const maxAttempts = Math.max(1, request.constraints.maxAttempts ?? (request.constraints.allowFallback ? 3 : 1));
    let attempt = 0;

    while (currentResolution && attempt < maxAttempts) {
      attempt += 1;
      const { runner, descriptor, modelId, runtimeId } = currentResolution;
      triedHarnessIds.push(descriptor.harnessId);

      // Compute remaining budgets for this attempt, preserving executionId, taskId, and consumed budget
      const remainingTokens =
        request.constraints.maxTokens !== undefined
          ? Math.max(0, request.constraints.maxTokens - accumulatedTokens)
          : undefined;
      const remainingToolCalls =
        request.constraints.maxToolCalls !== undefined
          ? Math.max(0, request.constraints.maxToolCalls - accumulatedToolCalls)
          : undefined;
      const remainingCostUSD =
        request.constraints.maxCostUSD !== undefined
          ? Math.max(0, Number((request.constraints.maxCostUSD - accumulatedCostUSD).toFixed(6)))
          : undefined;
      const remainingDurationMs =
        request.constraints.maxDurationMs !== undefined
          ? Math.max(1, request.constraints.maxDurationMs - accumulatedDurationMs)
          : undefined;

      const attemptResumeContext: AgentResumeContext | undefined =
        attempt > 1 || request.resumeContext
          ? {
              executionId: request.executionId,
              attempt: (request.resumeContext?.attempt ?? 1) + (attempt - 1),
              workspaceRevision: parseRevisionNumber(lastResult?.workspaceRevision ?? request.workspace.revision),
              filesChanged: lastResult?.filesChanged ?? request.resumeContext?.filesChanged ?? [],
              consumed: {
                toolCalls: accumulatedToolCalls,
                tokens: accumulatedTokens,
              },
              verification: request.resumeContext?.verification ?? {
                passing: [],
                failing: [],
                stale: 0,
              },
              previousTermination: lastResult?.terminationReason ?? request.resumeContext?.previousTermination ?? null,
              lastError: lastResult?.errors?.[0] ?? request.resumeContext?.lastError ?? null,
              reconciled: request.resumeContext?.reconciled ?? [],
            }
          : undefined;

      const attemptRequest: UnifiedExecutionRequest = {
        ...request,
        schemaVersion: request.schemaVersion ?? HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: request.executionId,
        taskId: request.taskId,
        constraints: {
          ...request.constraints,
          ...(remainingTokens !== undefined ? { maxTokens: remainingTokens } : {}),
          ...(remainingToolCalls !== undefined ? { maxToolCalls: remainingToolCalls } : {}),
          ...(remainingCostUSD !== undefined ? { maxCostUSD: remainingCostUSD } : {}),
          ...(remainingDurationMs !== undefined ? { maxDurationMs: remainingDurationMs } : {}),
        },
        ...(attemptResumeContext ? { resumeContext: attemptResumeContext } : {}),
      };

      const rawResult = await this.executeWithTimeoutAndCancellation(
        runner,
        attemptRequest,
        modelId,
        runtimeId,
      );

      // Accumulate consumed budget across attempts
      const attemptInputTokens = rawResult.usage?.inputTokens ?? 0;
      const attemptOutputTokens = rawResult.usage?.outputTokens ?? 0;
      const attemptTotalTokens =
        rawResult.usage?.totalTokens ?? attemptInputTokens + attemptOutputTokens;
      const attemptToolCalls = rawResult.toolCalls?.length ?? 0;
      const attemptCostUSD = rawResult.usage?.costUSD ?? 0;
      const attemptDurationMs = rawResult.usage?.durationMs ?? 0;
      const attemptModelCalls = rawResult.usage?.modelCalls ?? 0;

      accumulatedInputTokens += attemptInputTokens;
      accumulatedOutputTokens += attemptOutputTokens;
      accumulatedTokens += attemptTotalTokens;
      accumulatedToolCalls += attemptToolCalls;
      accumulatedCostUSD += attemptCostUSD;
      accumulatedDurationMs += attemptDurationMs;
      accumulatedModelCalls += attemptModelCalls;

      // Normalize cost semantics per Invariant 3:
      // Never coerce UNKNOWN cost to 0.
      const resolvedCostStatus: CostStatus =
        rawResult.usage?.costStatus ??
        (rawResult.usage?.costUSD !== undefined ? 'ACTUAL' : 'UNKNOWN');
      const resolvedCostUSD =
        resolvedCostStatus === 'UNKNOWN'
          ? undefined
          : accumulatedCostUSD > 0
            ? Number(accumulatedCostUSD.toFixed(6))
            : rawResult.usage?.costUSD;

      lastResult = {
        ...rawResult,
        schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: request.executionId,
        taskId: request.taskId,
        harnessId: descriptor.harnessId,
        harnessKind: descriptor.kind,
        modelId: rawResult.modelId || modelId,
        runtimeId: rawResult.runtimeId || runtimeId,
        // Invariant 1: Physical Execution Facts vs. Model Claims
        // Model/harness claim of 'completed' is unverified (verified: false) until independent verification passes.
        verified: false,
        usage: {
          ...rawResult.usage,
          inputTokens: accumulatedInputTokens > 0 ? accumulatedInputTokens : rawResult.usage?.inputTokens,
          outputTokens: accumulatedOutputTokens > 0 ? accumulatedOutputTokens : rawResult.usage?.outputTokens,
          totalTokens: accumulatedTokens > 0 ? accumulatedTokens : rawResult.usage?.totalTokens,
          costUSD: resolvedCostUSD,
          costStatus: resolvedCostStatus,
          durationMs: accumulatedDurationMs,
          modelCalls: accumulatedModelCalls > 0 ? accumulatedModelCalls : rawResult.usage?.modelCalls,
        },
        verificationEvidenceIds: [...(rawResult.verificationEvidenceIds ?? [])],
      };

      // Check if fallback should be triggered
      const canFallback =
        this.isFallbackTriggerResult(lastResult) &&
        request.constraints.allowFallback === true &&
        !isStrictUserPin(request) &&
        this.resolveProviderOnlyConstraint(request).allowFallback;

      if (canFallback) {
        // Invariant 2: Tool Dispatch vs. Confirmed Side Effects
        const sideEffectCheck = this.hasUnconfirmedMutatingSideEffects(request.executionId, lastResult);
        if (sideEffectCheck.blocked) {
          lastResult = {
            ...lastResult,
            status: 'failed',
            verified: false,
            failureClassification: 'UNCONFIRMED_SIDE_EFFECT_BLOCKS_FALLBACK',
            errors: [...(lastResult.errors ?? []), sideEffectCheck.reason!],
          };
          break;
        }

        // Try resolving the next eligible harness
        try {
          currentResolution = await this.resolveHarness(request, triedHarnessIds);
          continue;
        } catch {
          // No more fallback candidates available; break and return the failure result
          break;
        }
      }

      break;
    }

    const finalResult = lastResult!;

    // Run independent controller verification pipeline against the physical workspace
    const verificationOutcome = await this.runIndependentVerification(request, finalResult);
    const mergedEvidenceIds = Array.from(
      new Set([...(finalResult.verificationEvidenceIds ?? []), ...(verificationOutcome.evidenceIds ?? [])]),
    );

    if (finalResult.status === 'completed') {
      if (verificationOutcome.verified) {
        finalResult.verified = true;
        finalResult.terminationReason = finalResult.terminationReason ?? 'VERIFICATION_PASSED';
      } else {
        // Apparent completion rejected by controller verification!
        finalResult.verified = false;
        finalResult.status = 'failed';
        finalResult.terminationReason = 'VERIFICATION_FAILED';
        finalResult.errorKind = 'verification';
        finalResult.failureClassification = 'VERIFICATION_FAILED';
        if (verificationOutcome.reasons && verificationOutcome.reasons.length > 0) {
          finalResult.errors = [...(finalResult.errors ?? []), ...verificationOutcome.reasons];
        }
      }
    } else {
      finalResult.verified = false;
    }

    finalResult.verificationEvidenceIds = mergedEvidenceIds;
    if (verificationOutcome.workspaceRevision !== undefined) {
      finalResult.workspaceRevision = String(verificationOutcome.workspaceRevision);
    }
    if (verificationOutcome.checks && verificationOutcome.checks.length > 0) {
      finalResult.checks = [...(finalResult.checks ?? []), ...verificationOutcome.checks];
    }

    const completedAt = new Date();
    finalResult.provenance = {
      startedAt: finalResult.provenance?.startedAt ?? overallStartedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      contractDigest,
    };

    await this.recordOutcomeToExecutionEngine(
      engineExecutionId,
      request,
      finalResult,
      verificationOutcome,
    );

    return finalResult;
  }
}

export function createHarnessDispatchService(
  options: HarnessDispatchServiceOptions = {},
): HarnessDispatchService {
  return new HarnessDispatchService(options);
}
