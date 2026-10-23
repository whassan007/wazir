import type { TaskType, PolicyRequirements } from '../types/task.js';
import type { ToolCallRecord, CheckRunRecord, ToolCallCheckpoint } from '../types/execution.js';
import type { CostStatus } from '../types/telemetry.js';
import type { AgentErrorKind, AgentResumeContext, TerminationReason } from '../types/agent.js';
import type { ExecutionEngine } from './executionEngine.js';
import type { CheckpointService } from './checkpointService.js';
import {
  type HandoffService,
  type PortableHandoff,
  type PortableHandoffBudgetLimits,
  type PortablePolicyContext,
  type PortableRemainingBudget,
  PORTABLE_HANDOFF_SCHEMA_VERSION,
  computePortableHandoffDigest,
  computeWorkspaceContentDigest,
  redactSecrets,
} from './handoffService.js';

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
  /** True if the external harness requires hosted cloud inference and cannot run locally. */
  hostedOnly?: boolean;
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

export interface ContinuationPromptOptions {
  targetHarnessId?: string;
  workspaceDrifted?: boolean;
  currentWorkspaceRevision?: string | number;
  validEvidenceIds?: string[];
  staleEvidenceIds?: string[];
  reconciledSideEffects?: string[];
  remainingBudget?: PortableRemainingBudget;
}

export interface WorkspaceRevalidationResult {
  drifted: boolean;
  currentRevision: string;
  currentDigest: string;
  validEvidenceIds: string[];
  staleEvidenceIds: string[];
  reasons: string[];
}

export interface PolicyValidationResult {
  valid: boolean;
  violations: string[];
  effectivePolicy: PortablePolicyContext;
}

export interface HarnessCompatibilityResult {
  compatible: boolean;
  harness?: HarnessDescriptor;
  reasons: string[];
}

export type HarnessResumeStatus = 'ready' | 'blocked' | 'rejected';

export type HarnessResumeFailureCode =
  | 'INVALID_HANDOFF'
  | 'UNRESOLVED_SIDE_EFFECTS'
  | 'BUDGET_EXHAUSTED'
  | 'POLICY_ESCALATION'
  | 'INCOMPATIBLE_HARNESS';

export interface HarnessResumeOptions {
  targetHarnessId?: string;
  targetModelId?: string;
  targetRuntimeId?: string;
  targetWorkerId?: string;
  taskType?: TaskType;
  requiredCapabilities?: HarnessCapability[];
  /** Optional max budget limits to compute remainingBudget = maxBudget - consumedBudget. */
  maxBudget?: PortableHandoffBudgetLimits;
  /** Target request policy override (checked strictly for non-escalation against handoff.policyContext). */
  policyOverride?: Partial<PortablePolicyContext>;
  /** Explicit workspace root or current revision/digest for revalidation. */
  workspaceRoot?: string;
  currentWorkspaceRevision?: string | number;
  currentWorkspaceDigest?: string;
  /** Tool call IDs whose side effects have been reconciled since handoff creation. */
  reconciledCallIds?: string[];
  requiredChecks?: string[];
  expectedArtifacts?: string[];
  mutationRequired?: boolean;
  attempt?: number;
  maxTurns?: number;
  maxAttempts?: number;
  allowFallback?: boolean;
  previousTermination?: string | null;
  lastError?: string | null;
  failingChecks?: string[];
  isCancelled?: () => boolean;
}

export interface HarnessResumeResult {
  status: HarnessResumeStatus;
  resumable: boolean;
  failureCode?: HarnessResumeFailureCode;
  executionId: string;
  taskId: string;
  sourceHarnessId: string;
  targetHarnessId: string;
  targetHarness?: HarnessDescriptor;
  request?: UnifiedExecutionRequest;
  resumeContext?: AgentResumeContext;
  continuationPrompt?: string;
  remainingBudget: PortableRemainingBudget;
  effectivePolicy: PortablePolicyContext;
  workspaceDrifted: boolean;
  evidenceInvalidated: boolean;
  validVerificationEvidenceIds: string[];
  staleVerificationEvidenceIds: string[];
  blockingSideEffects: ToolCallCheckpoint[];
  reasons: string[];
}

export interface HarnessResumeServiceOptions {
  handoffs?: HandoffService;
  executions?: ExecutionEngine;
  checkpoints?: CheckpointService;
  harnesses?: HarnessDescriptor[];
  defaultWorkspaceRoot?: string;
  isBinaryAvailable?: (binaryName: string) => boolean;
}

const DATA_CLASSIFICATION_RANK: Record<
  NonNullable<PolicyRequirements['dataClassification']>,
  number
> = {
  public: 0,
  internal: 1,
  sensitive: 2,
  restricted: 3,
};

const DEFAULT_HARNESSES: HarnessDescriptor[] = [
  {
    harnessId: 'native',
    name: 'Wazir Native Coding Agent',
    version: '1.0.0',
    kind: 'native',
    capabilities: [
      'coding',
      'chat',
      'step-execution',
      'streaming',
      'tool-Forwarding',
      'checkpoint-resume',
      'cancellation',
      'mcp',
      'workspace-isolation',
    ],
    supportedTaskTypes: [
      'coding',
      'debugging',
      'review',
      'research',
      'architecture',
      'code_analysis',
      'document_analysis',
      'chat',
      'agent',
      'benchmark',
      'evaluation',
    ],
    supportedProtocols: ['native'],
    allowsModelSelection: true,
    defaultPermissionMode: 'edit',
  },
  {
    harnessId: 'native-harness',
    name: 'Wazir Native Harness',
    version: '1.0.0',
    kind: 'native',
    capabilities: [
      'coding',
      'chat',
      'step-execution',
      'streaming',
      'tool-Forwarding',
      'checkpoint-resume',
      'cancellation',
      'mcp',
      'workspace-isolation',
    ],
    supportedTaskTypes: [
      'coding',
      'debugging',
      'review',
      'research',
      'architecture',
      'code_analysis',
      'document_analysis',
      'chat',
      'agent',
      'benchmark',
      'evaluation',
    ],
    supportedProtocols: ['native'],
    allowsModelSelection: true,
    defaultPermissionMode: 'edit',
  },
  {
    harnessId: 'acp',
    name: 'ACP External Agent Harness',
    version: '1.0.0',
    kind: 'acp',
    capabilities: [
      'coding',
      'chat',
      'step-execution',
      'streaming',
      'tool-Forwarding',
      'checkpoint-resume',
      'cancellation',
      'mcp',
    ],
    supportedTaskTypes: [
      'coding',
      'debugging',
      'review',
      'research',
      'architecture',
      'code_analysis',
      'chat',
      'agent',
    ],
    supportedProtocols: ['acp'],
    allowsModelSelection: true,
    defaultPermissionMode: 'edit',
  },
  {
    harnessId: 'acp-harness',
    name: 'ACP External Agent Harness',
    version: '1.0.0',
    kind: 'acp',
    capabilities: [
      'coding',
      'chat',
      'step-execution',
      'streaming',
      'tool-Forwarding',
      'checkpoint-resume',
      'cancellation',
      'mcp',
    ],
    supportedTaskTypes: [
      'coding',
      'debugging',
      'review',
      'research',
      'architecture',
      'code_analysis',
      'chat',
      'agent',
    ],
    supportedProtocols: ['acp'],
    allowsModelSelection: true,
    defaultPermissionMode: 'edit',
  },
  {
    harnessId: 'claude-code',
    name: 'Claude Code ACP Harness',
    version: '1.0.0',
    kind: 'acp',
    capabilities: [
      'coding',
      'chat',
      'step-execution',
      'streaming',
      'tool-Forwarding',
      'checkpoint-resume',
      'cancellation',
      'mcp',
    ],
    supportedTaskTypes: [
      'coding',
      'debugging',
      'review',
      'research',
      'architecture',
      'code_analysis',
      'chat',
      'agent',
    ],
    supportedProtocols: ['acp', 'stdio-cli'],
    allowsModelSelection: true,
    defaultPermissionMode: 'edit',
  },
  {
    harnessId: 'codex',
    name: 'Codex ACP Harness',
    version: '1.0.0',
    kind: 'acp',
    capabilities: [
      'coding',
      'chat',
      'step-execution',
      'streaming',
      'checkpoint-resume',
      'cancellation',
    ],
    supportedTaskTypes: ['coding', 'debugging', 'review', 'code_analysis', 'agent'],
    supportedProtocols: ['acp', 'stdio-cli'],
    allowsModelSelection: true,
    defaultPermissionMode: 'edit',
  },
  {
    harnessId: 'gemini-cli',
    name: 'Gemini CLI ACP Harness',
    version: '1.0.0',
    kind: 'acp',
    capabilities: [
      'coding',
      'chat',
      'step-execution',
      'streaming',
      'tool-Forwarding',
      'checkpoint-resume',
      'cancellation',
      'mcp',
    ],
    supportedTaskTypes: [
      'coding',
      'debugging',
      'review',
      'research',
      'architecture',
      'code_analysis',
      'chat',
      'agent',
    ],
    supportedProtocols: ['acp', 'stdio-cli'],
    allowsModelSelection: true,
    defaultPermissionMode: 'edit',
  },
  {
    harnessId: 'external-cli',
    name: 'Generic External CLI Harness',
    version: '1.0.0',
    kind: 'external-cli',
    capabilities: ['coding', 'chat', 'checkpoint-resume', 'cancellation'],
    supportedTaskTypes: ['coding', 'debugging', 'review', 'chat'],
    supportedProtocols: ['stdio-cli'],
    allowsModelSelection: false,
    defaultPermissionMode: 'edit',
  },
];

const HOSTED_RUNTIMES = new Set(['anthropic', 'openai', 'google', 'gemini', 'nvidia', 'hosted', 'cloud']);

export class HarnessResumeService {
  private readonly handoffs?: HandoffService;
  private readonly executions?: ExecutionEngine;
  private readonly checkpoints?: CheckpointService;
  private readonly harnesses = new Map<string, HarnessDescriptor>();
  private readonly defaultWorkspaceRoot: string;
  private readonly isBinaryAvailable?: (binaryName: string) => boolean;

  constructor(options: HarnessResumeServiceOptions = {}) {
    this.handoffs = options.handoffs;
    this.executions = options.executions;
    this.checkpoints = options.checkpoints;
    this.defaultWorkspaceRoot = options.defaultWorkspaceRoot ?? process.cwd();
    this.isBinaryAvailable = options.isBinaryAvailable;

    for (const descriptor of DEFAULT_HARNESSES) {
      this.harnesses.set(descriptor.harnessId, structuredClone(descriptor));
    }
    for (const descriptor of options.harnesses ?? []) {
      this.harnesses.set(descriptor.harnessId, structuredClone(descriptor));
    }
  }

  /**
   * Registers or updates a target harness descriptor in the capability registry.
   */
  public registerHarness(descriptor: HarnessDescriptor): void {
    this.harnesses.set(descriptor.harnessId, structuredClone(descriptor));
  }

  /**
   * Retrieves a registered harness descriptor by ID.
   */
  public getHarness(harnessId: string): HarnessDescriptor | undefined {
    const h = this.harnesses.get(harnessId);
    return h ? structuredClone(h) : undefined;
  }

  /**
   * Builds a structured semantic continuation objective from durable execution facts
   * (completed actions, modified files, passing verification evidence at current revision,
   * and remaining pending subtasks) WITHOUT replaying raw model transcripts or assuming
   * KV cache portability across architectures.
   */
  public buildContinuationPrompt(
    handoff: PortableHandoff,
    options: ContinuationPromptOptions = {},
  ): string {
    const targetHarness = options.targetHarnessId ?? handoff.targetHarnessId ?? 'target-harness';
    const currentRev = String(options.currentWorkspaceRevision ?? handoff.workspaceRevision);
    const drifted = options.workspaceDrifted ?? false;
    const validEvidence =
      options.validEvidenceIds ?? (drifted ? [] : handoff.verificationEvidenceIds);
    const staleEvidence =
      options.staleEvidenceIds ?? (drifted ? handoff.verificationEvidenceIds : []);
    const budget = options.remainingBudget ?? handoff.remainingBudget;

    const confirmedActions = handoff.completedActions.filter((a) => a.confirmed);
    const actionLines =
      confirmedActions.length > 0
        ? confirmedActions.map(
            (a) =>
              `- [r${a.workspaceRevision}] (${a.kind}) ${redactSecrets(a.summary)}`,
          )
        : ['- None recorded'];

    const filesLines =
      handoff.filesChanged.length > 0
        ? handoff.filesChanged.map((f) => `- ${f}`)
        : ['- None modified yet'];

    const verificationSection: string[] = [];
    if (drifted) {
      verificationSection.push(
        `- STATUS: STALE / INVALIDATED (workspace drifted from checkpoint revision ${handoff.workspaceRevision} to ${currentRev})`,
      );
      if (staleEvidence.length > 0) {
        verificationSection.push(`- Invalidated Prior Evidence: ${staleEvidence.join(', ')}`);
      }
      verificationSection.push(
        `- Requirement: Re-verify all changes at current revision ${currentRev} before claiming completion.`,
      );
    } else if (validEvidence.length > 0) {
      verificationSection.push(
        `- Passing Evidence at Revision ${currentRev}: ${validEvidence.join(', ')}`,
      );
    } else {
      verificationSection.push(
        `- Passing Evidence at Revision ${currentRev}: None recorded (full verification required before completion)`,
      );
    }

    const pendingLines =
      handoff.pendingActions.length > 0
        ? handoff.pendingActions.map((step, idx) => `${idx + 1}. ${redactSecrets(step)}`)
        : ['1. Inspect current workspace state, complete remaining requirements, and run verification.'];

    const budgetParts: string[] = [];
    if (budget.maxTokens !== undefined && budget.maxTokens !== null) {
      budgetParts.push(`maxTokens=${budget.maxTokens}`);
    }
    if (budget.maxToolCalls !== undefined && budget.maxToolCalls !== null) {
      budgetParts.push(`maxToolCalls=${budget.maxToolCalls}`);
    }
    if (budget.maxModelCalls !== undefined && budget.maxModelCalls !== null) {
      budgetParts.push(`maxModelCalls=${budget.maxModelCalls}`);
    }
    if (budget.maxCostUSD !== undefined && budget.maxCostUSD !== null) {
      budgetParts.push(`maxCostUSD=${budget.maxCostUSD}`);
    }
    if (budget.maxDurationMs !== undefined && budget.maxDurationMs !== null) {
      budgetParts.push(`maxDurationMs=${budget.maxDurationMs}`);
    }

    const reconciledLines =
      options.reconciledSideEffects && options.reconciledSideEffects.length > 0
        ? ['', '## Reconciled Side Effects', ...options.reconciledSideEffects.map((r) => `- ${r}`)]
        : [];

    return [
      `# Cross-Harness Execution Continuation`,
      `Execution ID: ${handoff.executionId}`,
      `Task ID: ${handoff.taskId}`,
      `Handoff Route: ${handoff.sourceHarnessId} -> ${targetHarness}`,
      `Checkpoint: ${handoff.checkpointId} (Workspace Revision: ${currentRev})`,
      `Architecture Note: Semantic state transfer from durable controller facts only. Raw model transcript and prior KV cache are NOT replayed.`,
      ``,
      `## Primary Objective`,
      redactSecrets(handoff.objective),
      ``,
      `## Confirmed Completed Actions`,
      ...actionLines,
      ``,
      `## Modified Files in Workspace`,
      ...filesLines,
      ``,
      `## Verification Evidence Status`,
      ...verificationSection,
      ...reconciledLines,
      ``,
      `## Remaining Pending Subtasks`,
      ...pendingLines,
      ``,
      `## Remaining Execution Budgets`,
      budgetParts.length > 0 ? budgetParts.join(', ') : 'Unbounded (subject to host policy)',
    ].join('\n');
  }

  /**
   * Computes remaining budget (`remainingBudget = maxBudget - consumedBudget`)
   * and checks whether any budget dimension is exhausted (`<= 0`).
   */
  public computeRemainingBudget(
    handoff: PortableHandoff,
    maxBudgetOverride?: PortableHandoffBudgetLimits,
  ): {
    remaining: PortableRemainingBudget;
    exhausted: string[];
    canResume: boolean;
  } {
    const consumed = handoff.consumedBudget;
    const prior = handoff.remainingBudget ?? {};

    const remaining: PortableRemainingBudget = {
      maxTokens:
        maxBudgetOverride?.maxTokens !== undefined
          ? maxBudgetOverride.maxTokens - consumed.tokensUsed
          : (prior.maxTokens ?? null),
      maxToolCalls:
        maxBudgetOverride?.maxToolCalls !== undefined
          ? maxBudgetOverride.maxToolCalls - consumed.toolCallsUsed
          : (prior.maxToolCalls ?? null),
      maxModelCalls:
        maxBudgetOverride?.maxModelCalls !== undefined
          ? maxBudgetOverride.maxModelCalls - consumed.modelCallsUsed
          : (prior.maxModelCalls ?? null),
      maxCostUSD:
        maxBudgetOverride?.maxCostUSD !== undefined
          ? Number((maxBudgetOverride.maxCostUSD - consumed.costUSD).toFixed(6))
          : (prior.maxCostUSD ?? null),
      maxDurationMs:
        maxBudgetOverride?.maxDurationMs !== undefined
          ? maxBudgetOverride.maxDurationMs - consumed.durationMs
          : (prior.maxDurationMs ?? null),
    };

    const exhausted: string[] = [];
    for (const [key, value] of Object.entries(remaining)) {
      if (typeof value === 'number' && value <= 0) {
        exhausted.push(`${key} (remaining: ${value})`);
      }
    }

    return {
      remaining,
      exhausted,
      canResume: exhausted.length === 0,
    };
  }

  /**
   * Prevents authorization escalation across harness handoffs:
   * verifies that the target harness/request policy cannot weaken `localOnly`,
   * `dataClassification`, `allowedTools`, `protectedPaths`, or `allowHostedProviders`
   * (as well as networkAccess / toolAccess) from `handoff.policyContext`.
   */
  public validatePolicyNonEscalation(
    basePolicy: PortablePolicyContext,
    targetOverride?: Partial<PortablePolicyContext>,
    targetHarness?: HarnessDescriptor,
    targetRuntimeId?: string,
  ): PolicyValidationResult {
    const violations: string[] = [];
    const effective: PortablePolicyContext = structuredClone(basePolicy ?? {});

    if (targetOverride) {
      // 1. localOnly cannot be weakened from true to false
      if (basePolicy.localOnly === true && targetOverride.localOnly === false) {
        violations.push(
          "POLICY_ESCALATION: cannot weaken 'localOnly' from true to false on handoff resume",
        );
      } else if (targetOverride.localOnly === true) {
        effective.localOnly = true;
      }

      // 2. dataClassification cannot be downgraded to a less restrictive tier
      if (basePolicy.dataClassification && targetOverride.dataClassification) {
        const baseRank = DATA_CLASSIFICATION_RANK[basePolicy.dataClassification];
        const targetRank = DATA_CLASSIFICATION_RANK[targetOverride.dataClassification];
        if (targetRank < baseRank) {
          violations.push(
            `POLICY_ESCALATION: cannot downgrade 'dataClassification' from '${basePolicy.dataClassification}' to '${targetOverride.dataClassification}'`,
          );
        } else {
          effective.dataClassification = targetOverride.dataClassification;
        }
      } else if (targetOverride.dataClassification) {
        effective.dataClassification = targetOverride.dataClassification;
      }

      // 3. allowHostedProviders cannot be escalated to true when base forbids it or when localOnly/sensitive
      const baseAllowsHosted = basePolicy.allowHostedProviders === true;
      if (!baseAllowsHosted && targetOverride.allowHostedProviders === true) {
        violations.push(
          "POLICY_ESCALATION: cannot enable 'allowHostedProviders' when source policy had it disabled",
        );
      } else if (
        targetOverride.allowHostedProviders === true &&
        (effective.localOnly === true ||
          effective.dataClassification === 'sensitive' ||
          effective.dataClassification === 'restricted')
      ) {
        violations.push(
          "POLICY_ESCALATION: cannot enable 'allowHostedProviders' when localOnly is true or dataClassification is sensitive/restricted",
        );
      } else if (targetOverride.allowHostedProviders === false) {
        effective.allowHostedProviders = false;
      }

      // 4. allowedTools cannot add tools outside basePolicy.allowedTools
      if (Array.isArray(basePolicy.allowedTools)) {
        if (targetOverride.allowedTools !== undefined) {
          if (!Array.isArray(targetOverride.allowedTools)) {
            violations.push(
              "POLICY_ESCALATION: cannot clear 'allowedTools' restriction on handoff resume",
            );
          } else {
            const baseSet = new Set(basePolicy.allowedTools);
            const unauthorizedTools = targetOverride.allowedTools.filter((t) => !baseSet.has(t));
            if (unauthorizedTools.length > 0) {
              violations.push(
                `POLICY_ESCALATION: target policy attempted to add unauthorized tools to 'allowedTools': ${unauthorizedTools.join(', ')}`,
              );
            } else {
              effective.allowedTools = [...targetOverride.allowedTools];
            }
          }
        }
      } else if (Array.isArray(targetOverride.allowedTools)) {
        effective.allowedTools = [...targetOverride.allowedTools];
      }

      // 5. protectedPaths cannot drop any path protected by basePolicy.protectedPaths
      if (Array.isArray(basePolicy.protectedPaths) && basePolicy.protectedPaths.length > 0) {
        if (targetOverride.protectedPaths !== undefined) {
          if (!Array.isArray(targetOverride.protectedPaths)) {
            violations.push(
              "POLICY_ESCALATION: cannot clear 'protectedPaths' restriction on handoff resume",
            );
          } else {
            const targetSet = new Set(targetOverride.protectedPaths);
            const droppedPaths = basePolicy.protectedPaths.filter((p) => !targetSet.has(p));
            if (droppedPaths.length > 0) {
              violations.push(
                `POLICY_ESCALATION: target policy attempted to remove protected paths from 'protectedPaths': ${droppedPaths.join(', ')}`,
              );
            } else {
              effective.protectedPaths = [
                ...new Set([...basePolicy.protectedPaths, ...targetOverride.protectedPaths]),
              ];
            }
          }
        }
      } else if (Array.isArray(targetOverride.protectedPaths)) {
        effective.protectedPaths = [...targetOverride.protectedPaths];
      }

      // Additional boolean restrictions (networkAccess, toolAccess, allowSubagentDispatch)
      if (basePolicy.networkAccess === false && targetOverride.networkAccess === true) {
        violations.push("POLICY_ESCALATION: cannot enable 'networkAccess' when disabled by source policy");
      } else if (targetOverride.networkAccess === false) {
        effective.networkAccess = false;
      }

      if (basePolicy.toolAccess === false && targetOverride.toolAccess === true) {
        violations.push("POLICY_ESCALATION: cannot enable 'toolAccess' when disabled by source policy");
      } else if (targetOverride.toolAccess === false) {
        effective.toolAccess = false;
      }
    }

    // Check target harness / runtime against localOnly & allowHostedProviders constraints
    if (targetHarness?.hostedOnly) {
      if (effective.localOnly === true) {
        violations.push(
          `POLICY_ESCALATION: target harness '${targetHarness.harnessId}' requires hosted execution but policy enforces 'localOnly'`,
        );
      }
      if (effective.allowHostedProviders !== true) {
        violations.push(
          `POLICY_ESCALATION: target harness '${targetHarness.harnessId}' requires hosted providers but 'allowHostedProviders' is not enabled`,
        );
      }
    }

    if (targetRuntimeId) {
      const rtLower = targetRuntimeId.toLowerCase();
      if (HOSTED_RUNTIMES.has(rtLower)) {
        if (effective.localOnly === true) {
          violations.push(
            `POLICY_ESCALATION: target runtime '${targetRuntimeId}' is hosted but policy enforces 'localOnly'`,
          );
        }
        if (effective.allowHostedProviders !== true) {
          violations.push(
            `POLICY_ESCALATION: target runtime '${targetRuntimeId}' requires 'allowHostedProviders: true'`,
          );
        }
      }
    }

    return {
      valid: violations.length === 0,
      violations,
      effectivePolicy: effective,
    };
  }

  /**
   * Resolves target harness capabilities and verifies compatibility with the task's
   * requirements and external agent constraints.
   */
  public resolveTargetHarness(
    targetHarnessId: string,
    options: {
      taskType?: TaskType;
      requiredCapabilities?: HarnessCapability[];
      policyContext?: PortablePolicyContext;
    } = {},
  ): HarnessCompatibilityResult {
    const harness = this.harnesses.get(targetHarnessId);
    if (!harness) {
      return {
        compatible: false,
        reasons: [`TARGET_HARNESS_NOT_FOUND: harness '${targetHarnessId}' is not registered`],
      };
    }

    const reasons: string[] = [];
    const taskType = options.taskType ?? 'coding';

    if (!harness.supportedTaskTypes.includes(taskType)) {
      reasons.push(
        `UNSUPPORTED_TASK_TYPE: harness '${targetHarnessId}' does not support task type '${taskType}'`,
      );
    }

    const requiredCaps = options.requiredCapabilities ?? ['checkpoint-resume'];
    for (const cap of requiredCaps) {
      if (!harness.capabilities.includes(cap)) {
        reasons.push(
          `MISSING_HARNESS_CAPABILITY: harness '${targetHarnessId}' lacks required capability '${cap}'`,
        );
      }
    }

    if (harness.requiresBinary && this.isBinaryAvailable && !this.isBinaryAvailable(harness.requiresBinary)) {
      reasons.push(
        `MISSING_EXTERNAL_BINARY: harness '${targetHarnessId}' requires binary '${harness.requiresBinary}' which is not available`,
      );
    }

    if (options.policyContext?.toolAccess === false && harness.defaultPermissionMode === 'full') {
      reasons.push(
        `EXTERNAL_CONSTRAINT_VIOLATION: harness '${targetHarnessId}' has defaultPermissionMode='full' which conflicts with toolAccess=false`,
      );
    }

    return {
      compatible: reasons.length === 0,
      harness: structuredClone(harness),
      reasons,
    };
  }

  /**
   * Revalidates verification evidence against current physical workspace state:
   * compares current physical workspace revision/digest against `handoff.workspaceRevision`
   * and `handoff.workspaceContentDigest`. If the workspace changed outside the checkpoint,
   * marks prior verification evidence stale.
   */
  public async revalidateWorkspace(
    handoff: PortableHandoff,
    options: {
      workspaceRoot?: string;
      currentWorkspaceRevision?: string | number;
      currentWorkspaceDigest?: string;
    } = {},
  ): Promise<WorkspaceRevalidationResult> {
    const record = this.executions ? await this.executions.get(handoff.executionId) : undefined;
    const workspaceRoot =
      options.workspaceRoot ??
      record?.execution.workspaceRoot ??
      handoff.policyContext?.projectRoot ??
      this.defaultWorkspaceRoot;

    const currentRev =
      options.currentWorkspaceRevision !== undefined
        ? String(options.currentWorkspaceRevision)
        : record?.workspaceState?.revision !== undefined
          ? String(record.workspaceState.revision)
          : handoff.workspaceRevision;

    let currentDigest = options.currentWorkspaceDigest;
    if (!currentDigest) {
      currentDigest = await computeWorkspaceContentDigest({
        workspaceRoot,
        revision: currentRev,
        filesChanged: record?.filesChanged ?? handoff.filesChanged,
        contentFingerprint: record?.workspaceState?.contentFingerprint,
      });
    }

    const reasons: string[] = [];
    const revisionMismatch = String(currentRev) !== String(handoff.workspaceRevision);
    const digestMismatch = currentDigest !== handoff.workspaceContentDigest;
    const drifted = revisionMismatch || digestMismatch;

    if (revisionMismatch) {
      reasons.push(
        `WORKSPACE_REVISION_DRIFT: handoff recorded revision '${handoff.workspaceRevision}', current workspace is at '${currentRev}'`,
      );
    }
    if (digestMismatch) {
      reasons.push(
        `WORKSPACE_DIGEST_DRIFT: physical workspace content digest '${currentDigest.slice(0, 12)}...' differs from checkpoint digest '${handoff.workspaceContentDigest.slice(0, 12)}...'`,
      );
    }

    return {
      drifted,
      currentRevision: String(currentRev),
      currentDigest,
      validEvidenceIds: drifted ? [] : [...handoff.verificationEvidenceIds],
      staleEvidenceIds: drifted ? [...handoff.verificationEvidenceIds] : [],
      reasons,
    };
  }

  /**
   * Prepares and validates a cross-harness resumption from a PortableHandoff,
   * returning a ready-to-execute UnifiedExecutionRequest and AgentResumeContext
   * bound to the same executionId and taskId (or blocking/rejecting when unsafe).
   */
  public async prepareResume(
    handoff: PortableHandoff,
    options: HarnessResumeOptions = {},
  ): Promise<HarnessResumeResult> {
    const targetHarnessId =
      options.targetHarnessId ?? handoff.targetHarnessId ?? handoff.sourceHarnessId ?? 'native';

    // 1. Verify portable handoff schemaVersion and integrityDigest
    const integrityErrors: string[] = [];
    if (handoff.schemaVersion !== PORTABLE_HANDOFF_SCHEMA_VERSION) {
      integrityErrors.push(
        `UNSUPPORTED_SCHEMA_VERSION: expected ${PORTABLE_HANDOFF_SCHEMA_VERSION}, got ${String(handoff.schemaVersion)}`,
      );
    }
    const expectedDigest = computePortableHandoffDigest(handoff);
    if (handoff.integrityDigest !== expectedDigest) {
      integrityErrors.push(
        `INTEGRITY_DIGEST_MISMATCH: expected '${expectedDigest}', got '${handoff.integrityDigest}'`,
      );
    }
    if (integrityErrors.length > 0) {
      return {
        status: 'rejected',
        resumable: false,
        failureCode: 'INVALID_HANDOFF',
        executionId: handoff.executionId,
        taskId: handoff.taskId,
        sourceHarnessId: handoff.sourceHarnessId,
        targetHarnessId,
        remainingBudget: structuredClone(handoff.remainingBudget ?? {}),
        effectivePolicy: structuredClone(handoff.policyContext ?? {}),
        workspaceDrifted: false,
        evidenceInvalidated: false,
        validVerificationEvidenceIds: [],
        staleVerificationEvidenceIds: [],
        blockingSideEffects: [],
        reasons: integrityErrors,
      };
    }

    // 2. Check for unreconciled non-READ_ONLY side effects -> block resumption (`status: 'blocked'`)
    const reconciledIds = new Set<string>(options.reconciledCallIds ?? []);
    if (this.executions) {
      try {
        for (const chk of this.executions.toolCheckpoints(handoff.executionId)) {
          if (chk.state === 'COMPLETED' || chk.state === 'FAILED') {
            reconciledIds.add(chk.callId);
          }
        }
      } catch {
        // execution may reside on another worker and not be in local engine
      }
    }

    const blockingSideEffects = (handoff.unresolvedSideEffects ?? []).filter(
      (call) =>
        call.sideEffectClass !== 'READ_ONLY' &&
        (call.state === 'STARTED' || call.state === 'OUTCOME_UNKNOWN') &&
        !reconciledIds.has(call.callId),
    );

    if (blockingSideEffects.length > 0) {
      const reasons = blockingSideEffects.map(
        (call) =>
          `UNRESOLVED_SIDE_EFFECT: non-READ_ONLY tool '${call.toolName}' (callId='${call.callId}', class='${call.sideEffectClass}', state='${call.state}') at revision ${call.workspaceRevision} must be reconciled before resuming`,
      );
      return {
        status: 'blocked',
        resumable: false,
        failureCode: 'UNRESOLVED_SIDE_EFFECTS',
        executionId: handoff.executionId,
        taskId: handoff.taskId,
        sourceHarnessId: handoff.sourceHarnessId,
        targetHarnessId,
        remainingBudget: structuredClone(handoff.remainingBudget ?? {}),
        effectivePolicy: structuredClone(handoff.policyContext ?? {}),
        workspaceDrifted: false,
        evidenceInvalidated: false,
        validVerificationEvidenceIds: [...handoff.verificationEvidenceIds],
        staleVerificationEvidenceIds: [],
        blockingSideEffects: structuredClone(blockingSideEffects),
        reasons,
      };
    }

    // 3. Resolve target harness capabilities & compatibility
    const record = this.executions ? await this.executions.get(handoff.executionId) : undefined;
    const taskType = options.taskType ?? record?.task.type ?? 'coding';
    const harnessCompatibility = this.resolveTargetHarness(targetHarnessId, {
      taskType,
      requiredCapabilities: options.requiredCapabilities,
      policyContext: handoff.policyContext,
    });

    if (!harnessCompatibility.compatible || !harnessCompatibility.harness) {
      return {
        status: 'rejected',
        resumable: false,
        failureCode: 'INCOMPATIBLE_HARNESS',
        executionId: handoff.executionId,
        taskId: handoff.taskId,
        sourceHarnessId: handoff.sourceHarnessId,
        targetHarnessId,
        targetHarness: harnessCompatibility.harness,
        remainingBudget: structuredClone(handoff.remainingBudget ?? {}),
        effectivePolicy: structuredClone(handoff.policyContext ?? {}),
        workspaceDrifted: false,
        evidenceInvalidated: false,
        validVerificationEvidenceIds: [...handoff.verificationEvidenceIds],
        staleVerificationEvidenceIds: [],
        blockingSideEffects: [],
        reasons: harnessCompatibility.reasons,
      };
    }

    // 4. Prevent authorization / policy escalation
    const policyCheck = this.validatePolicyNonEscalation(
      handoff.policyContext,
      options.policyOverride,
      harnessCompatibility.harness,
      options.targetRuntimeId ?? handoff.sourceRuntimeId,
    );

    if (!policyCheck.valid) {
      return {
        status: 'rejected',
        resumable: false,
        failureCode: 'POLICY_ESCALATION',
        executionId: handoff.executionId,
        taskId: handoff.taskId,
        sourceHarnessId: handoff.sourceHarnessId,
        targetHarnessId,
        targetHarness: harnessCompatibility.harness,
        remainingBudget: structuredClone(handoff.remainingBudget ?? {}),
        effectivePolicy: policyCheck.effectivePolicy,
        workspaceDrifted: false,
        evidenceInvalidated: false,
        validVerificationEvidenceIds: [...handoff.verificationEvidenceIds],
        staleVerificationEvidenceIds: [],
        blockingSideEffects: [],
        reasons: policyCheck.violations,
      };
    }

    // 5. Carry forward remaining budgets & refuse resume if any budget is exhausted (<= 0)
    const budgetCheck = this.computeRemainingBudget(handoff, options.maxBudget);
    if (!budgetCheck.canResume) {
      return {
        status: 'rejected',
        resumable: false,
        failureCode: 'BUDGET_EXHAUSTED',
        executionId: handoff.executionId,
        taskId: handoff.taskId,
        sourceHarnessId: handoff.sourceHarnessId,
        targetHarnessId,
        targetHarness: harnessCompatibility.harness,
        remainingBudget: budgetCheck.remaining,
        effectivePolicy: policyCheck.effectivePolicy,
        workspaceDrifted: false,
        evidenceInvalidated: false,
        validVerificationEvidenceIds: [...handoff.verificationEvidenceIds],
        staleVerificationEvidenceIds: [],
        blockingSideEffects: [],
        reasons: [
          `BUDGET_EXHAUSTED: cannot resume execution '${handoff.executionId}' because remaining budget is exhausted for: ${budgetCheck.exhausted.join(', ')}`,
        ],
      };
    }

    // 6. Revalidate workspace revision & content digest
    const revalidation = await this.revalidateWorkspace(handoff, {
      workspaceRoot: options.workspaceRoot,
      currentWorkspaceRevision: options.currentWorkspaceRevision,
      currentWorkspaceDigest: options.currentWorkspaceDigest,
    });

    const reconciledDescriptions = (handoff.unresolvedSideEffects ?? [])
      .filter((c) => reconciledIds.has(c.callId))
      .map((c) => `Reconciled '${c.toolName}' (${c.callId})`);

    // 7. Build structured semantic continuation prompt without raw model transcript replay
    const continuationPrompt = this.buildContinuationPrompt(handoff, {
      targetHarnessId,
      workspaceDrifted: revalidation.drifted,
      currentWorkspaceRevision: revalidation.currentRevision,
      validEvidenceIds: revalidation.validEvidenceIds,
      staleEvidenceIds: revalidation.staleEvidenceIds,
      reconciledSideEffects: reconciledDescriptions,
      remainingBudget: budgetCheck.remaining,
    });

    const workspaceRoot =
      options.workspaceRoot ??
      record?.execution.workspaceRoot ??
      policyCheck.effectivePolicy.projectRoot ??
      this.defaultWorkspaceRoot;

    const numericRevision = Number.isFinite(Number(revalidation.currentRevision))
      ? Number(revalidation.currentRevision)
      : 0;

    // Build AgentResumeContext bound to same executionId
    const resumeContext: AgentResumeContext = {
      executionId: handoff.executionId,
      attempt: options.attempt ?? 2,
      workspaceRevision: numericRevision,
      filesChanged: [...handoff.filesChanged],
      consumed: {
        toolCalls: handoff.consumedBudget.toolCallsUsed,
        tokens: handoff.consumedBudget.tokensUsed,
      },
      verification: {
        passing: [...revalidation.validEvidenceIds],
        failing: [...(options.failingChecks ?? [])],
        stale: revalidation.drifted
          ? Math.max(1, revalidation.staleEvidenceIds.length)
          : revalidation.staleEvidenceIds.length,
      },
      previousTermination: options.previousTermination ?? handoff.nonResumableReason ?? null,
      lastError: options.lastError ?? null,
      reconciled: reconciledDescriptions,
    };

    const requiredChecks = new Set<string>(options.requiredChecks ?? []);
    if (revalidation.drifted) {
      requiredChecks.add('build');
      requiredChecks.add('test');
    } else if (requiredChecks.size === 0 && revalidation.validEvidenceIds.length === 0) {
      requiredChecks.add('test');
    }

    // Build ready-to-execute UnifiedExecutionRequest bound to the SAME executionId and taskId
    const request: UnifiedExecutionRequest = {
      schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
      executionId: handoff.executionId,
      taskId: handoff.taskId,
      objective: continuationPrompt,
      taskType,
      harnessPreference: targetHarnessId,
      modelPreference: options.targetModelId ?? handoff.sourceModelId ?? record?.execution.modelId,
      runtimePreference:
        options.targetRuntimeId ?? handoff.sourceRuntimeId ?? record?.execution.runtimeId,
      workspace: {
        root: workspaceRoot,
        revision: numericRevision,
      },
      constraints: {
        ...(budgetCheck.remaining.maxCostUSD !== null &&
        budgetCheck.remaining.maxCostUSD !== undefined
          ? { maxCostUSD: budgetCheck.remaining.maxCostUSD }
          : {}),
        ...(budgetCheck.remaining.maxDurationMs !== null &&
        budgetCheck.remaining.maxDurationMs !== undefined
          ? { maxDurationMs: budgetCheck.remaining.maxDurationMs }
          : {}),
        ...(budgetCheck.remaining.maxTokens !== null &&
        budgetCheck.remaining.maxTokens !== undefined
          ? { maxTokens: budgetCheck.remaining.maxTokens }
          : {}),
        ...(budgetCheck.remaining.maxToolCalls !== null &&
        budgetCheck.remaining.maxToolCalls !== undefined
          ? { maxToolCalls: budgetCheck.remaining.maxToolCalls }
          : {}),
        ...(options.maxTurns !== undefined
          ? { maxTurns: options.maxTurns }
          : budgetCheck.remaining.maxModelCalls !== null &&
              budgetCheck.remaining.maxModelCalls !== undefined
            ? { maxTurns: budgetCheck.remaining.maxModelCalls }
            : {}),
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        allowFallback: options.allowFallback ?? true,
      },
      verification: {
        requiredChecks: [...requiredChecks],
        protectedPaths: [...(policyCheck.effectivePolicy.protectedPaths ?? [])],
        mutationRequired:
          options.mutationRequired ??
          record?.task.mutationRequired ??
          handoff.filesChanged.length === 0,
        ...(options.expectedArtifacts ?? record?.task.expectedArtifacts
          ? { expectedArtifacts: options.expectedArtifacts ?? record?.task.expectedArtifacts }
          : {}),
      },
      policyContext: structuredClone(policyCheck.effectivePolicy),
      checkpointId: handoff.checkpointId,
      resumeContext,
      ...(options.isCancelled ? { isCancelled: options.isCancelled } : {}),
    };

    const reasons = [
      `READY: resuming execution '${handoff.executionId}' (task '${handoff.taskId}') from '${handoff.sourceHarnessId}' on '${targetHarnessId}' at revision ${revalidation.currentRevision}`,
      ...revalidation.reasons,
    ];

    return {
      status: 'ready',
      resumable: true,
      executionId: handoff.executionId,
      taskId: handoff.taskId,
      sourceHarnessId: handoff.sourceHarnessId,
      targetHarnessId,
      targetHarness: harnessCompatibility.harness,
      request,
      resumeContext,
      continuationPrompt,
      remainingBudget: budgetCheck.remaining,
      effectivePolicy: policyCheck.effectivePolicy,
      workspaceDrifted: revalidation.drifted,
      evidenceInvalidated: revalidation.drifted,
      validVerificationEvidenceIds: revalidation.validEvidenceIds,
      staleVerificationEvidenceIds: revalidation.staleEvidenceIds,
      blockingSideEffects: [],
      reasons,
    };
  }

  /**
   * Resumes a PortableHandoff (or looks up by executionId from HandoffService if a string is provided).
   */
  public async resume(
    handoffOrExecutionId: PortableHandoff | string,
    options: HarnessResumeOptions = {},
  ): Promise<HarnessResumeResult> {
    let handoff: PortableHandoff;
    if (typeof handoffOrExecutionId === 'string') {
      if (!this.handoffs) {
        throw new Error(
          `Cannot resolve portable handoff '${handoffOrExecutionId}' without a configured HandoffService`,
        );
      }
      const found = await this.handoffs.getPortableHandoff(handoffOrExecutionId);
      if (!found) {
        throw new Error(`Portable handoff for execution '${handoffOrExecutionId}' not found`);
      }
      handoff = found;
    } else {
      handoff = handoffOrExecutionId;
    }

    return this.prepareResume(handoff, options);
  }
}
