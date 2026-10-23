import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import {
  classifyOption,
  isPathInside,
  redactPermissionText,
  type AgentAdapter,
  type AgentDescriptor,
  type AgentErrorKind,
  type AgentResumeContext,
  type AgentRunRequest,
  type AgentRuntime,
  type AgentTurn,
  type CheckRunRecord,
  type CostStatus,
  type PermissionOption,
  type PolicyDecision,
  type PolicyEffect,
  type PolicyRequirements,
  type TaskType,
  type TerminationReason,
  type ToolCallRecord,
} from '@wazir/core';
import { AcpClientAdapter, type AcpClientOptions, type AcpConnectionLike } from './acp/acpClient.js';
import {
  decideAcpPermission,
  describeAcpError,
  type AcpPermissionMode,
} from './acp/acpAgentAdapter.js';
import {
  buildExternalHarnessDescriptor,
  discoverExternalHarnessCapabilities,
  getExternalHarnessPreset,
  HARNESS_CONTRACT_SCHEMA_VERSION,
  sanitizeHarnessEnvironment,
  type ExternalHarnessCapability,
  type ExternalHarnessDescriptor,
  type ExternalHarnessKind,
  type ExternalHarnessSpec,
} from './acp/acpHarnessCapabilities.js';
import { resolveExternalCommand } from './externalAgent.js';
import { spawnGroupWatchdog } from './processWatchdog.js';

export const MAX_EXTERNAL_OUTPUT_CHARS = 20_000;
const DEFAULT_WALL_CLOCK_MS = 30 * 60_000;

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

export interface UnifiedExecutionResult {
  schemaVersion: number;
  executionId: string;
  taskId: string;

  harnessId: string;
  harnessKind?: ExternalHarnessKind | 'native';
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

export type PolicyEvaluatorCallback = (
  toolName: string,
  input: Record<string, unknown>,
  projectRoot: string,
) =>
  | { allowed: boolean; reason?: string; rule?: string }
  | Promise<{ allowed: boolean; reason?: string; rule?: string }>;

export interface PolicyEngineLike {
  evaluate?: (request: {
    tool: string;
    input: Record<string, unknown>;
    executionId?: string;
    projectRoot?: string;
  }) => PolicyDecision | Promise<PolicyDecision>;
}

export interface ExternalVerificationOutcome {
  verified: boolean;
  workspaceRevision?: string | number;
  filesChanged?: string[];
  checks?: CheckRunRecord[];
  verificationEvidenceIds?: string[];
  artifacts?: UnifiedArtifactRecord[];
  reasons?: string[];
}

export type ExternalVerificationHook = (params: {
  request: UnifiedExecutionRequest;
  workspaceRevision: string;
  filesChanged: string[];
  toolCalls: ToolCallRecord[];
  output: string;
}) => ExternalVerificationOutcome | Promise<ExternalVerificationOutcome>;

export interface ExternalHarnessAdapterOptions extends Partial<ExternalHarnessSpec> {
  /** Preset ID ('qwen-code' | 'codex' | 'claude-code' | 'opencode') or custom harnessId */
  preset?: string;
  /** Policy evaluator callback invoked on every tool/permission request */
  policyEvaluator?: PolicyEvaluatorCallback;
  /** Wazir PolicyEngine instance (optional alternative/complement to policyEvaluator) */
  policyEngine?: PolicyEngineLike;
  /** Independent controller verification hook. Without it, `verified` is ALWAYS false. */
  verifyHook?: ExternalVerificationHook;
  /** Test seam for ACP connection injection */
  connect?: AcpClientOptions['connect'];
  /** Optional explicit pricing / cost reporter; otherwise subscription/external CLI defaults to UNKNOWN */
  costReporter?: () => { costUSD?: number; costStatus: CostStatus; inputTokens?: number; outputTokens?: number };
  /** Base environment override for testing environment sanitization */
  baseEnv?: NodeJS.ProcessEnv;
  /** Custom binary resolver for testing */
  resolveBinary?: (command: string, envPath?: string) => string | undefined;
}

function appendBounded(current: string, chunk: string, maxChars: number): string {
  if (current.length >= maxChars) return current;
  return current + chunk.slice(0, maxChars - current.length);
}

function computeContractDigest(request: UnifiedExecutionRequest, harnessId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: request.schemaVersion ?? HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: request.executionId,
        taskId: request.taskId,
        harnessId,
        objective: request.objective,
        workspaceRoot: request.workspace.root,
        workspaceRevision: String(request.workspace.revision),
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

function matchesProtectedPath(
  candidatePath: string,
  projectRoot: string,
  protectedPaths: readonly string[],
): string | undefined {
  if (!candidatePath) return undefined;
  const resolvedCandidate = path.resolve(projectRoot, candidatePath);
  const relCandidate = path.relative(projectRoot, resolvedCandidate).replace(/\\/g, '/');

  for (const rawProtected of protectedPaths) {
    if (!rawProtected) continue;
    const normalizedProtected = rawProtected.replace(/\\/g, '/').replace(/^\.\//, '');
    const resolvedProtected = path.resolve(projectRoot, normalizedProtected);
    if (
      resolvedCandidate === resolvedProtected ||
      isPathInside(resolvedProtected, resolvedCandidate) ||
      relCandidate === normalizedProtected ||
      relCandidate.startsWith(`${normalizedProtected}/`) ||
      candidatePath.includes(normalizedProtected)
    ) {
      return rawProtected;
    }
  }
  return undefined;
}

function extractCandidatePathsFromTool(
  title: string,
  rawInput: Record<string, unknown>,
): string[] {
  const candidates = new Set<string>();
  for (const key of ['path', 'filePath', 'file', 'target', 'targetPath', 'destination', 'source']) {
    const val = rawInput[key];
    if (typeof val === 'string' && val.trim()) {
      candidates.add(val.trim());
    }
  }
  // Also extract file-like tokens from title (e.g. "Write .env", "Edit config/secrets.json")
  const tokens = title.split(/\s+/);
  for (const tok of tokens) {
    const cleaned = tok.replace(/^['"`(]+|['"`),:;]+$/g, '');
    if (
      cleaned &&
      (cleaned.includes('/') ||
        cleaned.includes('\\') ||
        cleaned.startsWith('.') ||
        /\.[a-zA-Z0-9]{1,8}$/.test(cleaned))
    ) {
      candidates.add(cleaned);
    }
  }
  return [...candidates];
}

/**
 * Unified External Harness Adapter supporting both ACP harnesses (`qwen-code`, `codex`,
 * `claude-code`, generic ACP) and external CLI subprocess harnesses (`opencode`, generic CLI).
 *
 * Enforces Wazir control-plane invariants:
 * - Never grants `always` permissions; only one-shot (`once`) approvals permitted by both
 *   `AcpPermissionMode` and `PolicyEngine` / `policyEvaluator` and `protectedPaths`.
 * - Strips unauthorized secrets from child environment variables.
 * - Bounds stdout/stderr buffers to prevent memory exhaustion.
 * - Never self-certifies completion (`verified: false` unless an independent `verifyHook` passes).
 * - Reports `costStatus: 'UNKNOWN'` (`costUSD: undefined`) for subscription/unpriced external harnesses.
 */
export class ExternalHarnessAdapter implements AgentAdapter {
  readonly spec: ExternalHarnessSpec;
  readonly harnessDescriptor: ExternalHarnessDescriptor;
  readonly descriptor: AgentDescriptor;
  private readonly options: ExternalHarnessAdapterOptions;

  constructor(options: ExternalHarnessAdapterOptions) {
    const baseSpec = getExternalHarnessPreset(options.preset ?? options.harnessId ?? 'external', options);
    this.spec = baseSpec;
    this.options = options;
    this.harnessDescriptor = buildExternalHarnessDescriptor(this.spec);
    this.descriptor = {
      name: this.spec.harnessId,
      version: this.spec.version ?? (this.spec.kind === 'acp' ? 'acp' : 'external'),
      description: this.spec.description ?? this.spec.name,
      capabilities: (this.spec.capabilities ?? ['coding']) as string[],
      requiredTools: [],
      modelRequirements: { capabilities: [] },
      permissions: [],
      // Never auto-selected for unpinned tasks without explicit harness/agent selection
      taskTypes: this.spec.supportedTaskTypes ?? [],
      strategy: 'external',
    };
  }

  /**
   * Executes a `UnifiedExecutionRequest` against the external harness and returns a
   * normalized `UnifiedExecutionResult`.
   */
  async execute(request: UnifiedExecutionRequest): Promise<UnifiedExecutionResult> {
    const startedAtDate = new Date();
    const startedMs = startedAtDate.getTime();
    const maxOutputChars = this.spec.maxOutputChars ?? MAX_EXTERNAL_OUTPUT_CHARS;
    const contractDigest = computeContractDigest(request, this.spec.harnessId);

    const modelId =
      request.modelPreference ?? this.spec.defaultModelId ?? `${this.spec.harnessId}-external`;
    const runtimeId =
      request.runtimePreference ?? this.spec.defaultRuntimeId ?? `${this.spec.protocol}:${this.spec.harnessId}`;
    const initialRevision = String(request.workspace.revision ?? 0);

    const finalizeResult = (
      partial: Omit<
        UnifiedExecutionResult,
        | 'schemaVersion'
        | 'executionId'
        | 'taskId'
        | 'harnessId'
        | 'harnessKind'
        | 'modelId'
        | 'runtimeId'
        | 'provenance'
      >,
    ): UnifiedExecutionResult => {
      const completedAtDate = new Date();
      return {
        schemaVersion: request.schemaVersion ?? HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: request.executionId,
        taskId: request.taskId,
        harnessId: this.spec.harnessId,
        harnessKind: this.spec.kind,
        modelId,
        runtimeId,
        ...partial,
        provenance: {
          startedAt: startedAtDate.toISOString(),
          completedAt: completedAtDate.toISOString(),
          contractDigest,
        },
      };
    };

    const resolveUsage = (durationMs: number, firstTokenLatencyMs?: number, modelCalls = 1) => {
      if (this.options.costReporter) {
        const reported = this.options.costReporter();
        return {
          inputTokens: reported.inputTokens,
          outputTokens: reported.outputTokens,
          totalTokens:
            reported.inputTokens !== undefined && reported.outputTokens !== undefined
              ? reported.inputTokens + reported.outputTokens
              : undefined,
          costUSD: reported.costStatus === 'UNKNOWN' ? undefined : reported.costUSD,
          costStatus: reported.costStatus,
          durationMs,
          firstTokenLatencyMs,
          modelCalls,
        };
      }
      // Invariant 3: Unpriced remote or subscription CLI inference has costStatus: 'UNKNOWN' and costUSD: undefined
      return {
        costUSD: undefined,
        costStatus: 'UNKNOWN' as CostStatus,
        durationMs,
        firstTokenLatencyMs,
        modelCalls,
      };
    };

    // Check immediate cancellation before spawning
    if (request.isCancelled?.()) {
      return finalizeResult({
        status: 'cancelled',
        verified: false,
        terminationReason: 'CANCELLED',
        errorKind: 'cancelled',
        workspaceRevision: initialRevision,
        filesChanged: [],
        artifacts: [],
        toolCalls: [],
        verificationEvidenceIds: [],
        failureClassification: 'CANCELLED',
        errors: ['Execution cancelled before harness launch'],
        output: '',
        usage: resolveUsage(Date.now() - startedMs, undefined, 0),
      });
    }

    // Discover capabilities, environment sanitization, and binary presence (unless custom `connect` test seam is injected)
    const policyCtx = (request.policyContext ?? {}) as PolicyRequirements & Record<string, unknown>;
    const maxMode: AcpPermissionMode | undefined =
      policyCtx.toolAccess === false
        ? 'read'
        : policyCtx.networkAccess === false && this.spec.permissionMode === 'full'
          ? 'edit'
          : undefined;

    const discovery = discoverExternalHarnessCapabilities(this.spec, {
      cwd: request.workspace.root,
      env: this.options.baseEnv ?? process.env,
      resolveBinary: this.options.resolveBinary,
      requestedPermissionMode: this.spec.permissionMode ?? 'edit',
      maxPermissionMode: maxMode,
    });

    if (discovery.failureClassification === 'ENVIRONMENT_BLOCKED') {
      return finalizeResult({
        status: 'failed',
        verified: false,
        terminationReason: 'POLICY_DENIED',
        errorKind: 'policy',
        workspaceRevision: initialRevision,
        filesChanged: [],
        artifacts: [],
        toolCalls: [],
        verificationEvidenceIds: [],
        failureClassification: 'ENVIRONMENT_BLOCKED',
        errors: discovery.diagnostics,
        output: '',
        usage: resolveUsage(Date.now() - startedMs, undefined, 0),
      });
    }

    if (!this.options.connect && !discovery.binaryFound) {
      return finalizeResult({
        status: 'failed',
        verified: false,
        terminationReason: 'RESOURCE_EXHAUSTED',
        errorKind: 'infrastructure',
        workspaceRevision: initialRevision,
        filesChanged: [],
        artifacts: [],
        toolCalls: [],
        verificationEvidenceIds: [],
        failureClassification: 'BINARY_NOT_FOUND',
        errors:
          discovery.diagnostics.length > 0
            ? discovery.diagnostics
            : [`Required binary '${this.spec.command}' not found`],
        output: '',
        usage: resolveUsage(Date.now() - startedMs, undefined, 0),
      });
    }

    if (this.spec.protocol === 'acp') {
      return this.executeAcp(
        request,
        discovery.sanitizedEnv,
        discovery.effectivePermissionMode,
        maxOutputChars,
        startedMs,
        initialRevision,
        resolveUsage,
        finalizeResult,
      );
    }

    return this.executeCli(
      request,
      discovery.sanitizedEnv,
      maxOutputChars,
      startedMs,
      initialRevision,
      resolveUsage,
      finalizeResult,
    );
  }

  private async evaluatePermissionRequest(
    request: UnifiedExecutionRequest,
    mode: AcpPermissionMode,
    permReq: {
      requestId: string;
      sessionId: string;
      title: string;
      toolKind?: string;
      rawInput?: Record<string, unknown>;
      options: PermissionOption[];
    },
  ): Promise<{
    optionId?: string;
    cancelled?: boolean;
    policyEffect: PolicyEffect;
    policyRule: string;
    reason?: string;
  }> {
    const toolKind = permReq.toolKind ?? 'other';
    const rawInput = permReq.rawInput ?? { title: permReq.title };
    const protectedPaths = request.verification?.protectedPaths ?? [];
    const policyCtx = (request.policyContext ?? {}) as PolicyRequirements & Record<string, unknown>;

    // 1. Enforce networkAccess policy restriction
    if (policyCtx.networkAccess === false && toolKind === 'fetch') {
      return {
        cancelled: true,
        policyEffect: 'deny',
        policyRule: 'policy.networkAccess.denied',
        reason: `Network access is disabled by policyContext for '${permReq.title}'`,
      };
    }

    // 2. Enforce protectedPaths on any file-mutating or shell operation
    if (protectedPaths.length > 0) {
      const candidatePaths = extractCandidatePathsFromTool(permReq.title, rawInput);
      for (const candidate of candidatePaths) {
        const matchedProtected = matchesProtectedPath(
          candidate,
          request.workspace.root,
          protectedPaths,
        );
        if (matchedProtected && toolKind !== 'read' && toolKind !== 'search' && toolKind !== 'think') {
          return {
            cancelled: true,
            policyEffect: 'deny',
            policyRule: `protected_path:${matchedProtected}`,
            reason: `Access to protected path '${matchedProtected}' is denied`,
          };
        }
      }
      // Also check if title directly references a protected path on non-read tools
      if (toolKind !== 'read' && toolKind !== 'search' && toolKind !== 'think') {
        for (const prot of protectedPaths) {
          if (prot && permReq.title.includes(prot)) {
            return {
              cancelled: true,
              policyEffect: 'deny',
              policyRule: `protected_path:${prot}`,
              reason: `Operation '${permReq.title}' touches protected path '${prot}'`,
            };
          }
        }
      }
    }

    // 3. Evaluate against Wazir PolicyEngine if provided
    if (this.options.policyEngine?.evaluate) {
      const decision = await this.options.policyEngine.evaluate({
        tool: toolKind,
        input: { title: permReq.title, ...rawInput },
        executionId: request.executionId,
        projectRoot: request.workspace.root,
      });
      if (decision.decision !== 'allow') {
        return {
          cancelled: true,
          policyEffect: 'deny',
          policyRule: decision.rule || 'policy_engine.denied',
          reason: decision.reasons?.join('; ') || `Denied by PolicyEngine (${decision.decision})`,
        };
      }
    }

    // 4. Evaluate against policyEvaluator callback if provided
    if (this.options.policyEvaluator) {
      const evalResult = await this.options.policyEvaluator(
        toolKind,
        { title: permReq.title, ...rawInput },
        request.workspace.root,
      );
      if (!evalResult.allowed) {
        return {
          cancelled: true,
          policyEffect: 'deny',
          policyRule: evalResult.rule ?? 'policy_evaluator.denied',
          reason: evalResult.reason ?? `Denied by policyEvaluator for tool '${toolKind}'`,
        };
      }
    }

    // 5. Evaluate against AcpPermissionMode and NEVER select 'always' escalation
    const nonAlwaysOptions = permReq.options.filter((o) => o.escalation !== 'always');
    const modeDecision = decideAcpPermission(mode, permReq.toolKind, nonAlwaysOptions);
    if (!modeDecision.optionId || modeDecision.cancelled) {
      return {
        cancelled: true,
        policyEffect: 'deny',
        policyRule: `acp_permission_mode:${mode}`,
        reason: `Denied under ACP permission mode '${mode}' for tool kind '${toolKind}'`,
      };
    }

    return {
      optionId: modeDecision.optionId,
      policyEffect: 'allow',
      policyRule: `acp_permission_mode:${mode}:once`,
    };
  }

  private async executeAcp(
    request: UnifiedExecutionRequest,
    sanitizedEnv: Record<string, string>,
    mode: AcpPermissionMode,
    maxOutputChars: number,
    startedMs: number,
    initialRevision: string,
    resolveUsage: (
      durationMs: number,
      firstTokenLatencyMs?: number,
      modelCalls?: number,
    ) => UnifiedExecutionResult['usage'],
    finalizeResult: (
      partial: Omit<
        UnifiedExecutionResult,
        | 'schemaVersion'
        | 'executionId'
        | 'taskId'
        | 'harnessId'
        | 'harnessKind'
        | 'modelId'
        | 'runtimeId'
        | 'provenance'
      >,
    ) => UnifiedExecutionResult,
  ): Promise<UnifiedExecutionResult> {
    let output = '';
    let firstTokenLatencyMs: number | undefined;
    const toolCalls: ToolCallRecord[] = [];
    const pendingToolCalls = new Map<string, ToolCallRecord>();
    const filesChanged = new Set<string>();
    const errors: string[] = [];
    let policyDeniedReason: string | undefined;
    let reportedAcpVersion: number | undefined;
    let processExitedUnexpectedly = false;

    const expectedAcpVersion = this.spec.expectedAcpProtocolVersion ?? PROTOCOL_VERSION;
    const maxToolCalls = request.constraints?.maxToolCalls;
    let toolBudgetExceeded = false;

    const customConnect: AcpClientOptions['connect'] | undefined = this.options.connect
      ? async (client, onExit) => {
          const rawConn = await this.options.connect!(client, (info) => {
            if (info.code !== 0 || info.signal) {
              processExitedUnexpectedly = true;
            }
            onExit(info);
          });
          // Wrap initialize if not already called to inspect protocolVersion
          const origInit = rawConn.initialize.bind(rawConn);
          rawConn.initialize = async (params: Record<string, unknown>) => {
            const res = await origInit(params);
            if (res && typeof res.protocolVersion === 'number') {
              reportedAcpVersion = res.protocolVersion;
            }
            return res;
          };
          return rawConn;
        }
      : undefined;

    const client = new AcpClientAdapter({
      name: this.spec.harnessId,
      command: this.spec.command,
      args: this.spec.args,
      env: sanitizedEnv,
      cwd: request.workspace.root,
      initTimeoutMs: this.spec.initTimeoutMs,
      connect: customConnect,
      onSessionUpdate: (_sessionId, update) => {
        const u = update as Record<string, any>;
        switch (u.sessionUpdate) {
          case 'agent_message_chunk':
          case 'agent_message': {
            if (u.content?.type === 'text' && typeof u.content.text === 'string') {
              if (firstTokenLatencyMs === undefined && u.content.text.length > 0) {
                firstTokenLatencyMs = Date.now() - startedMs;
              }
              output = appendBounded(output, u.content.text, maxOutputChars);
            }
            break;
          }
          case 'tool_call': {
            const callId = String(u.toolCallId ?? `tc-${toolCalls.length + 1}`);
            const title = String(u.title ?? callId);
            const toolKind = String(u.kind ?? 'other');
            const rawInput =
              u.rawInput && typeof u.rawInput === 'object'
                ? (u.rawInput as Record<string, unknown>)
                : { title };
            const record: ToolCallRecord = {
              id: callId,
              callId,
              tool: toolKind,
              input: { title, ...rawInput },
              ok: false,
              policyEffect: 'allow',
              policyRule: `acp:${mode}`,
              durationMs: 0,
              at: new Date(),
              cwd: request.workspace.root,
              projectRoot: request.workspace.root,
            };
            pendingToolCalls.set(callId, record);
            toolCalls.push(record);

            if (maxToolCalls !== undefined && toolCalls.length > maxToolCalls) {
              toolBudgetExceeded = true;
            }
            break;
          }
          case 'tool_call_update': {
            const callId = String(u.toolCallId ?? '');
            const existing = pendingToolCalls.get(callId);
            if (u.status === 'completed' || u.status === 'failed') {
              const ok = u.status === 'completed';
              if (existing) {
                existing.ok = ok;
                existing.output = String(u.output ?? u.title ?? existing.tool);
                existing.durationMs = Math.max(0, Date.now() - existing.at.getTime());
                if (!ok && !existing.error) {
                  existing.error = `Tool call ${callId} failed`;
                }
              } else {
                toolCalls.push({
                  id: callId || `tc-${toolCalls.length + 1}`,
                  callId: callId || undefined,
                  tool: String(u.title ?? 'tool'),
                  input: { title: u.title },
                  output: String(u.output ?? u.title ?? ''),
                  ok,
                  error: ok ? undefined : `Tool call failed`,
                  policyEffect: 'allow',
                  policyRule: `acp:${mode}`,
                  durationMs: 0,
                  at: new Date(),
                  cwd: request.workspace.root,
                  projectRoot: request.workspace.root,
                });
              }

              // Track candidate file mutations when edit/write tool calls complete
              if (ok && (existing?.tool === 'edit' || existing?.tool === 'write' || /write|edit/i.test(String(u.title ?? '')))) {
                const inputObj = (existing?.input ?? { title: String(u.title ?? '') }) as Record<string, unknown>;
                const extracted = extractCandidatePathsFromTool(String(inputObj.title ?? u.title ?? ''), inputObj);
                for (const p of extracted) {
                  filesChanged.add(p);
                }
              }
            }
            break;
          }
          default:
            break;
        }
      },
      onRequestPermission: async (req) => {
        const existing =
          pendingToolCalls.get(req.requestId) ??
          [...pendingToolCalls.values()].reverse().find((tc) => tc.input && (tc.input as any).title === req.title);

        const rawInput =
          existing && typeof existing.input === 'object' && existing.input !== null
            ? (existing.input as Record<string, unknown>)
            : { title: req.title };

        const decision = await this.evaluatePermissionRequest(request, mode, {
          ...req,
          rawInput,
        });

        if (existing) {
          existing.policyEffect = decision.policyEffect;
          existing.policyRule = decision.policyRule;
          if (decision.cancelled) {
            existing.ok = false;
            existing.error = decision.reason ?? 'Permission denied';
          }
        } else {
          const permCallId = `perm-${toolCalls.length + 1}`;
          const rec: ToolCallRecord = {
            id: permCallId,
            callId: permCallId,
            tool: req.toolKind ?? 'other',
            input: rawInput,
            ok: !decision.cancelled,
            error: decision.cancelled ? decision.reason ?? 'Permission denied' : undefined,
            policyEffect: decision.policyEffect,
            policyRule: decision.policyRule,
            durationMs: 0,
            at: new Date(),
            cwd: request.workspace.root,
            projectRoot: request.workspace.root,
          };
          pendingToolCalls.set(permCallId, rec);
          toolCalls.push(rec);
        }

        if (decision.cancelled && decision.reason && decision.policyRule.startsWith('protected_path:')) {
          policyDeniedReason = decision.reason;
        } else if (
          decision.cancelled &&
          decision.reason &&
          (decision.policyRule.startsWith('policy_engine') ||
            decision.policyRule.startsWith('policy_evaluator') ||
            decision.policyRule.startsWith('policy.') ||
            !decision.policyRule.startsWith('acp_permission_mode:'))
        ) {
          policyDeniedReason = decision.reason;
        }

        return decision.cancelled ? { cancelled: true } : { optionId: decision.optionId };
      },
    });

    try {
      let sessionId: string;
      try {
        const conn = await client.ensureConnection();
        // When using custom connect, initialize might not have been invoked by AcpClientAdapter.ensureConnection()
        if (this.options.connect) {
          const initRes = await conn.initialize({
            protocolVersion: expectedAcpVersion,
            clientCapabilities: {},
            clientInfo: { name: 'wazir', version: '0.2.13' },
          });
          if (initRes && typeof initRes.protocolVersion === 'number') {
            reportedAcpVersion = initRes.protocolVersion;
          }
        }
        if (reportedAcpVersion !== undefined && reportedAcpVersion !== expectedAcpVersion) {
          return finalizeResult({
            status: 'failed',
            verified: false,
            terminationReason: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED',
            errorKind: 'protocol',
            workspaceRevision: initialRevision,
            filesChanged: [],
            artifacts: [],
            toolCalls,
            verificationEvidenceIds: [],
            failureClassification: 'ACP_PROTOCOL_INCOMPATIBLE',
            errors: [
              `ACP protocol version mismatch for '${this.spec.harnessId}': expected ${expectedAcpVersion}, received ${reportedAcpVersion}`,
            ],
            output,
            usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 0),
          });
        }
        sessionId = await client.createSession({ cwd: request.workspace.root });
      } catch (error) {
        const desc = describeAcpError(error);
        const isEnoent = /ENOENT|not found|cannot find/i.test(desc);
        const isProtocolVersion = /protocol version|incompatible protocol|unsupported protocol/i.test(desc);
        return finalizeResult({
          status: 'failed',
          verified: false,
          terminationReason: isProtocolVersion ? 'MODEL_PROTOCOL_BUDGET_EXHAUSTED' : 'RESOURCE_EXHAUSTED',
          errorKind: isProtocolVersion ? 'protocol' : 'infrastructure',
          workspaceRevision: initialRevision,
          filesChanged: [],
          artifacts: [],
          toolCalls,
          verificationEvidenceIds: [],
          failureClassification: isEnoent
            ? 'BINARY_NOT_FOUND'
            : isProtocolVersion
              ? 'ACP_PROTOCOL_INCOMPATIBLE'
              : 'HARNESS_INIT_FAILED',
          errors: [`Could not start ACP harness '${this.spec.harnessId}': ${desc}`],
          output,
          usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 0),
        });
      }

      let settled: { stopReason: string } | { error: unknown } | undefined;
      client.runTurn(sessionId, request.objective).then(
        (r) => {
          settled = r;
        },
        (error) => {
          settled = { error };
        },
      );

      const wallClockMs =
        request.constraints?.maxDurationMs ?? this.spec.maxWallClockMs ?? DEFAULT_WALL_CLOCK_MS;
      const deadline = startedMs + wallClockMs;
      const grace = this.spec.cancelGraceMs ?? 2_000;
      let stopRequested: { reason: 'cancelled' | 'timeout' | 'tool_budget'; at: number } | undefined;

      while (!settled) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (!stopRequested) {
          if (request.isCancelled?.()) {
            stopRequested = { reason: 'cancelled', at: Date.now() };
            void client.cancelSession(sessionId).catch(() => undefined);
          } else if (toolBudgetExceeded) {
            stopRequested = { reason: 'tool_budget', at: Date.now() };
            void client.cancelSession(sessionId).catch(() => undefined);
          } else if (Date.now() >= deadline) {
            stopRequested = { reason: 'timeout', at: Date.now() };
            void client.cancelSession(sessionId).catch(() => undefined);
          }
        }
        if (stopRequested && Date.now() - stopRequested.at > grace) {
          break;
        }
      }

      if (stopRequested?.reason === 'cancelled') {
        return finalizeResult({
          status: 'cancelled',
          verified: false,
          terminationReason: 'CANCELLED',
          errorKind: 'cancelled',
          workspaceRevision: initialRevision,
          filesChanged: [...filesChanged],
          artifacts: [],
          toolCalls,
          verificationEvidenceIds: [],
          failureClassification: 'CANCELLED',
          errors: ['Execution cancelled by caller'],
          output,
          usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
        });
      }

      if (stopRequested?.reason === 'tool_budget') {
        return finalizeResult({
          status: 'failed',
          verified: false,
          terminationReason: 'MAX_TOOL_CALLS',
          errorKind: 'other',
          workspaceRevision: initialRevision,
          filesChanged: [...filesChanged],
          artifacts: [],
          toolCalls,
          verificationEvidenceIds: [],
          failureClassification: 'MAX_TOOL_CALLS_EXCEEDED',
          errors: [`ACP harness '${this.spec.harnessId}' exceeded maxToolCalls (${maxToolCalls})`],
          output,
          usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
        });
      }

      if (stopRequested?.reason === 'timeout') {
        return finalizeResult({
          status: 'failed',
          verified: false,
          terminationReason: 'MAX_WALL_CLOCK',
          errorKind: 'other',
          workspaceRevision: initialRevision,
          filesChanged: [...filesChanged],
          artifacts: [],
          toolCalls,
          verificationEvidenceIds: [],
          failureClassification: 'TIMEOUT',
          errors: [`ACP harness '${this.spec.harnessId}' exceeded wall-clock bound (${wallClockMs}ms)`],
          output,
          usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
        });
      }

      if (!settled || 'error' in settled) {
        const message = settled && 'error' in settled ? describeAcpError(settled.error) : 'Unknown harness termination';
        const isCrashOrSignal =
          processExitedUnexpectedly || /exited during the turn|signal|SIG|killed|crashed|interrupted/i.test(message);
        return finalizeResult({
          status: isCrashOrSignal ? 'interrupted' : 'failed',
          verified: false,
          terminationReason: 'RESOURCE_EXHAUSTED',
          errorKind: 'infrastructure',
          workspaceRevision: initialRevision,
          filesChanged: [...filesChanged],
          artifacts: [],
          toolCalls,
          verificationEvidenceIds: [],
          failureClassification: isCrashOrSignal ? 'SUBPROCESS_INTERRUPTED' : 'HARNESS_EXECUTION_ERROR',
          errors: [`ACP harness '${this.spec.harnessId}' failed: ${message}`],
          output,
          usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
        });
      }

      if (settled.stopReason === 'cancelled') {
        return finalizeResult({
          status: 'cancelled',
          verified: false,
          terminationReason: 'CANCELLED',
          errorKind: 'cancelled',
          workspaceRevision: initialRevision,
          filesChanged: [...filesChanged],
          artifacts: [],
          toolCalls,
          verificationEvidenceIds: [],
          failureClassification: 'CANCELLED',
          errors: ['ACP session ended with stopReason=cancelled'],
          output,
          usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
        });
      }

      if (settled.stopReason === 'refusal' || policyDeniedReason) {
        const errText =
          policyDeniedReason ?? `ACP harness '${this.spec.harnessId}' refused or was denied by policy`;
        return finalizeResult({
          status: 'failed',
          verified: false,
          terminationReason: 'POLICY_DENIED',
          errorKind: 'policy',
          workspaceRevision: initialRevision,
          filesChanged: [...filesChanged],
          artifacts: [],
          toolCalls,
          verificationEvidenceIds: [],
          failureClassification: 'PERMISSION_DENIED',
          errors: [errText],
          output,
          usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
        });
      }

      if (settled.stopReason === 'max_tokens') {
        return finalizeResult({
          status: 'failed',
          verified: false,
          terminationReason: 'MAX_TOKENS',
          errorKind: 'other',
          workspaceRevision: initialRevision,
          filesChanged: [...filesChanged],
          artifacts: [],
          toolCalls,
          verificationEvidenceIds: [],
          failureClassification: 'MAX_TOKENS',
          errors: [`ACP harness '${this.spec.harnessId}' hit max_tokens`],
          output,
          usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
        });
      }

      if (settled.stopReason === 'max_turn_requests') {
        return finalizeResult({
          status: 'failed',
          verified: false,
          terminationReason: 'MAX_TURNS',
          errorKind: 'other',
          workspaceRevision: initialRevision,
          filesChanged: [...filesChanged],
          artifacts: [],
          toolCalls,
          verificationEvidenceIds: [],
          failureClassification: 'MAX_TURNS',
          errors: [`ACP harness '${this.spec.harnessId}' hit max_turn_requests`],
          output,
          usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
        });
      }

      // Apparent completion: Invariant 1 requires verified: false unless independent controller verifyHook passes
      let verified = false;
      let finalRevision =
        filesChanged.size > 0 && !Number.isNaN(Number(initialRevision))
          ? String(Number(initialRevision) + 1)
          : initialRevision;
      let finalFilesChanged = [...filesChanged];
      let checks: CheckRunRecord[] | undefined;
      let verificationEvidenceIds: string[] = [];
      let artifacts: UnifiedArtifactRecord[] = [];
      let terminationReason: TerminationReason = 'COMPLETED';

      if (this.options.verifyHook) {
        const verification = await this.options.verifyHook({
          request,
          workspaceRevision: finalRevision,
          filesChanged: finalFilesChanged,
          toolCalls,
          output: output.trim(),
        });
        verified = Boolean(verification.verified);
        if (verification.workspaceRevision !== undefined) {
          finalRevision = String(verification.workspaceRevision);
        }
        if (verification.filesChanged) {
          finalFilesChanged = verification.filesChanged;
        }
        if (verification.checks) {
          checks = verification.checks;
        }
        if (verification.verificationEvidenceIds) {
          verificationEvidenceIds = verification.verificationEvidenceIds;
        }
        if (verification.artifacts) {
          artifacts = verification.artifacts;
        }
        terminationReason = verified ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED';
        if (!verified && verification.reasons?.length) {
          errors.push(...verification.reasons);
        }
      }

      return finalizeResult({
        status: this.options.verifyHook && !verified ? 'failed' : 'completed',
        verified,
        terminationReason,
        errorKind: this.options.verifyHook && !verified ? 'verification' : undefined,
        workspaceRevision: finalRevision,
        filesChanged: finalFilesChanged,
        artifacts,
        toolCalls,
        checks,
        verificationEvidenceIds,
        failureClassification: this.options.verifyHook && !verified ? 'VERIFICATION_FAILED' : undefined,
        errors: errors.length > 0 ? errors : undefined,
        output: output.trim() || `ACP harness '${this.spec.harnessId}' completed`,
        usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
      });
    } finally {
      await client.close();
    }
  }

  private async executeCli(
    request: UnifiedExecutionRequest,
    sanitizedEnv: Record<string, string>,
    maxOutputChars: number,
    startedMs: number,
    initialRevision: string,
    resolveUsage: (
      durationMs: number,
      firstTokenLatencyMs?: number,
      modelCalls?: number,
    ) => UnifiedExecutionResult['usage'],
    finalizeResult: (
      partial: Omit<
        UnifiedExecutionResult,
        | 'schemaVersion'
        | 'executionId'
        | 'taskId'
        | 'harnessId'
        | 'harnessKind'
        | 'modelId'
        | 'runtimeId'
        | 'provenance'
      >,
    ) => UnifiedExecutionResult,
  ): Promise<UnifiedExecutionResult> {
    const args = [...(this.spec.args ?? []), request.objective];
    const timeoutMs =
      request.constraints?.maxDurationMs ?? this.spec.maxWallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    let firstTokenLatencyMs: number | undefined;

    // Pre-execution policy check for CLI invocation
    if (this.options.policyEvaluator) {
      const decision = await this.options.policyEvaluator(
        'execute',
        { command: this.spec.command, args },
        request.workspace.root,
      );
      if (!decision.allowed) {
        return finalizeResult({
          status: 'failed',
          verified: false,
          terminationReason: 'POLICY_DENIED',
          errorKind: 'policy',
          workspaceRevision: initialRevision,
          filesChanged: [],
          artifacts: [],
          toolCalls: [],
          verificationEvidenceIds: [],
          failureClassification: 'PERMISSION_DENIED',
          errors: [decision.reason ?? `CLI harness '${this.spec.harnessId}' denied by policyEvaluator`],
          output: '',
          usage: resolveUsage(Date.now() - startedMs, undefined, 0),
        });
      }
    }

    const cliOutcome = await new Promise<{
      outcome: 'completed' | 'cancelled' | 'timeout' | 'crashed' | 'failed' | 'enoent';
      stdout: string;
      stderr: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      errorMessage?: string;
    }>((resolve) => {
      let stdout = '';
      let stderr = '';
      let stopReason: 'timeout' | 'cancelled' | undefined;
      const detached = process.platform !== 'win32';
      const resolved = resolveExternalCommand(this.spec.command, args, {
        cwd: request.workspace.root,
        env: sanitizedEnv,
      });

      let child;
      try {
        child = spawn(resolved.command, resolved.args, {
          cwd: request.workspace.root,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: sanitizedEnv,
          detached,
          windowsVerbatimArguments: resolved.windowsVerbatimArguments,
        });
      } catch (err) {
        resolve({
          outcome: 'enoent',
          stdout: '',
          stderr: '',
          exitCode: null,
          signal: null,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      const stop = (reason: 'timeout' | 'cancelled') => {
        if (stopReason) return;
        stopReason = reason;
        if (process.platform === 'win32' && child.pid !== undefined) {
          try {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            return;
          } catch {
            // fall through
          }
        }
        try {
          if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      };

      const watchdog =
        detached && child.pid !== undefined ? spawnGroupWatchdog(process.pid, child.pid) : undefined;
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const cancelPoll = setInterval(() => {
        if (request.isCancelled?.()) stop('cancelled');
      }, 50);

      const settle = () => {
        clearTimeout(timer);
        clearInterval(cancelPoll);
        try {
          watchdog?.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      };

      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        if (firstTokenLatencyMs === undefined && chunk.length > 0) {
          firstTokenLatencyMs = Date.now() - startedMs;
        }
        stdout = appendBounded(stdout, chunk, maxOutputChars);
      });

      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-maxOutputChars);
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        settle();
        const isEnoent = error.code === 'ENOENT' || /ENOENT/i.test(error.message);
        resolve({
          outcome: isEnoent ? 'enoent' : 'failed',
          stdout,
          stderr,
          exitCode: null,
          signal: null,
          errorMessage: error.message,
        });
      });

      child.on('close', (code, signal) => {
        settle();
        if (stopReason === 'cancelled') {
          resolve({ outcome: 'cancelled', stdout, stderr, exitCode: code, signal });
        } else if (stopReason === 'timeout') {
          resolve({
            outcome: 'timeout',
            stdout,
            stderr,
            exitCode: code,
            signal,
            errorMessage: `'${this.spec.command}' timed out after ${timeoutMs}ms`,
          });
        } else if (signal) {
          resolve({
            outcome: 'crashed',
            stdout,
            stderr,
            exitCode: code,
            signal,
            errorMessage: `'${this.spec.command}' terminated by signal ${signal}`,
          });
        } else if (code === 0) {
          resolve({ outcome: 'completed', stdout, stderr, exitCode: 0, signal: null });
        } else {
          const tail = redactPermissionText(
            (stderr || stdout).trim().split('\n').slice(-3).join(' ').slice(-300),
          );
          resolve({
            outcome: 'failed',
            stdout,
            stderr,
            exitCode: code,
            signal,
            errorMessage: `'${this.spec.command}' exited with code ${code}${tail ? `: ${tail}` : ''}`,
          });
        }
      });
    });

    if (cliOutcome.outcome === 'enoent') {
      return finalizeResult({
        status: 'failed',
        verified: false,
        terminationReason: 'RESOURCE_EXHAUSTED',
        errorKind: 'infrastructure',
        workspaceRevision: initialRevision,
        filesChanged: [],
        artifacts: [],
        toolCalls: [],
        verificationEvidenceIds: [],
        failureClassification: 'BINARY_NOT_FOUND',
        errors: [cliOutcome.errorMessage ?? `Binary '${this.spec.command}' not found`],
        output: cliOutcome.stdout,
        usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 0),
      });
    }

    if (cliOutcome.outcome === 'cancelled' || request.isCancelled?.()) {
      return finalizeResult({
        status: 'cancelled',
        verified: false,
        terminationReason: 'CANCELLED',
        errorKind: 'cancelled',
        workspaceRevision: initialRevision,
        filesChanged: [],
        artifacts: [],
        toolCalls: [],
        verificationEvidenceIds: [],
        failureClassification: 'CANCELLED',
        errors: ['CLI harness execution cancelled'],
        output: cliOutcome.stdout,
        usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
      });
    }

    if (cliOutcome.outcome === 'timeout') {
      return finalizeResult({
        status: 'failed',
        verified: false,
        terminationReason: 'MAX_WALL_CLOCK',
        errorKind: 'other',
        workspaceRevision: initialRevision,
        filesChanged: [],
        artifacts: [],
        toolCalls: [],
        verificationEvidenceIds: [],
        failureClassification: 'TIMEOUT',
        errors: [cliOutcome.errorMessage ?? `Timed out after ${timeoutMs}ms`],
        output: cliOutcome.stdout,
        usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
      });
    }

    if (cliOutcome.outcome === 'crashed') {
      return finalizeResult({
        status: 'interrupted',
        verified: false,
        terminationReason: 'RESOURCE_EXHAUSTED',
        errorKind: 'infrastructure',
        workspaceRevision: initialRevision,
        filesChanged: [],
        artifacts: [],
        toolCalls: [],
        verificationEvidenceIds: [],
        failureClassification: 'SUBPROCESS_INTERRUPTED',
        errors: [cliOutcome.errorMessage ?? 'Subprocess terminated by signal'],
        output: cliOutcome.stdout,
        usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
      });
    }

    if (cliOutcome.outcome === 'failed') {
      return finalizeResult({
        status: 'failed',
        verified: false,
        terminationReason: 'RESOURCE_EXHAUSTED',
        errorKind: 'infrastructure',
        workspaceRevision: initialRevision,
        filesChanged: [],
        artifacts: [],
        toolCalls: [],
        verificationEvidenceIds: [],
        failureClassification: 'SUBPROCESS_NON_ZERO_EXIT',
        errors: [cliOutcome.errorMessage ?? 'Subprocess exited with non-zero code'],
        output: cliOutcome.stdout,
        usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
      });
    }

    // Apparent completion: verify via independent controller verifyHook if provided
    let verified = false;
    let finalRevision = initialRevision;
    let finalFilesChanged: string[] = [];
    let checks: CheckRunRecord[] | undefined;
    let verificationEvidenceIds: string[] = [];
    let artifacts: UnifiedArtifactRecord[] = [];
    let terminationReason: TerminationReason = 'COMPLETED';
    const errors: string[] = [];

    if (this.options.verifyHook) {
      const verification = await this.options.verifyHook({
        request,
        workspaceRevision: finalRevision,
        filesChanged: finalFilesChanged,
        toolCalls: [],
        output: cliOutcome.stdout,
      });
      verified = Boolean(verification.verified);
      if (verification.workspaceRevision !== undefined) {
        finalRevision = String(verification.workspaceRevision);
      }
      if (verification.filesChanged) {
        finalFilesChanged = verification.filesChanged;
      }
      if (verification.checks) {
        checks = verification.checks;
      }
      if (verification.verificationEvidenceIds) {
        verificationEvidenceIds = verification.verificationEvidenceIds;
      }
      if (verification.artifacts) {
        artifacts = verification.artifacts;
      }
      terminationReason = verified ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED';
      if (!verified && verification.reasons?.length) {
        errors.push(...verification.reasons);
      }
    }

    return finalizeResult({
      status: this.options.verifyHook && !verified ? 'failed' : 'completed',
      verified,
      terminationReason,
      errorKind: this.options.verifyHook && !verified ? 'verification' : undefined,
      workspaceRevision: finalRevision,
      filesChanged: finalFilesChanged,
      artifacts,
      toolCalls: [],
      checks,
      verificationEvidenceIds,
      failureClassification: this.options.verifyHook && !verified ? 'VERIFICATION_FAILED' : undefined,
      errors: errors.length > 0 ? errors : undefined,
      output: cliOutcome.stdout,
      usage: resolveUsage(Date.now() - startedMs, firstTokenLatencyMs, 1),
    });
  }

  /**
   * Implements `AgentAdapter.run` for backward compatibility with existing Wazir AgentRegistry
   * callers while delegating to `execute()`.
   */
  async *run(request: AgentRunRequest, _runtime: AgentRuntime): AsyncIterable<AgentTurn> {
    const unifiedReq: UnifiedExecutionRequest = {
      schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
      executionId: request.resume?.executionId ?? `exec-${Date.now()}`,
      taskId: `task-${Date.now()}`,
      objective: request.taskDescription,
      taskType: request.taskType,
      harnessPreference: this.spec.harnessId,
      modelPreference: request.modelId,
      workspace: {
        root: request.projectRoot,
        revision: request.resume?.workspaceRevision ?? 0,
      },
      constraints: {
        maxDurationMs: request.maxWallClockMs,
        maxTurns: request.maxTurns,
        maxToolCalls: request.maxToolCalls,
        maxTokens: request.maxTokens,
        allowFallback: false,
      },
      verification: {
        requiredChecks: [],
        protectedPaths: [],
        mutationRequired: request.mutationRequired,
        expectedArtifacts: request.expectedArtifacts,
      },
      policyContext: {
        projectRoot: request.projectRoot,
      },
      resumeContext: request.resume,
      isCancelled: request.isCancelled,
    };

    const result = await this.execute(unifiedReq);

    for (const tc of result.toolCalls) {
      yield {
        kind: 'tool_call',
        tool: tc.tool,
        toolInput: tc.input,
      };
      yield {
        kind: 'tool_result',
        tool: tc.tool,
        toolResult: {
          ok: tc.ok,
          output: tc.output ?? '',
          error: tc.error,
          durationMs: tc.durationMs,
        },
      };
    }

    if (result.output) {
      yield {
        kind: 'message',
        content: result.output,
      };
    }

    if (result.status === 'completed') {
      yield {
        kind: 'done',
        content: result.output || `External harness '${this.spec.harnessId}' completed`,
        terminationReason: result.terminationReason ?? 'COMPLETED',
      };
    } else {
      yield {
        kind: 'error',
        error: result.errors?.[0] ?? `External harness '${this.spec.harnessId}' ${result.status}`,
        terminationReason: result.terminationReason ?? 'RESOURCE_EXHAUSTED',
        errorKind: result.errorKind ?? 'other',
      };
    }
  }
}

export {
  type ExternalHarnessCapability,
  type ExternalHarnessDescriptor,
  type ExternalHarnessKind,
  type ExternalHarnessSpec,
};
