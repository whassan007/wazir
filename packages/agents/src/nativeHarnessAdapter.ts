import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentErrorKind,
  AgentResumeContext,
  AgentRunRequest,
  AgentRuntime,
  AgentTurn,
  CheckRunRecord,
  CostStatus,
  PolicyEffect,
  PolicyRequirements,
  TaskType,
  TerminationReason,
  ToolCallCheckpoint,
  ToolCallRecord,
  ToolResult,
  ToolSideEffectClass,
} from '@wazir/core';
import type { GenerationEvent } from '@wazir/runtimes-interfaces';
import { CodingAgent, type CodingAgentOptions } from './codingAgent.js';
import { ChatAgent } from './chatAgent.js';
import { StepAgent, type StepAgentOptions } from './stepAgent.js';

// ============================================================================
// Cross-Harness Execution Contract Types (matching SHARED-CONTRACTS.md v1.0.0)
// ============================================================================

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

// ============================================================================
// Native Harness Adapter Options & Hooks
// ============================================================================

export interface VerificationHookOutcome {
  verified: boolean;
  evidenceIds: string[];
  checks?: CheckRunRecord[];
}

export type VerifyOutcomeHook = (
  request: UnifiedExecutionRequest,
  turns: AgentTurn[],
  workspaceRevision: string,
) => Promise<VerificationHookOutcome> | VerificationHookOutcome;

export interface PricingRate {
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
}

export interface NativeHarnessAdapterOptions {
  /** Underlying Wazir-native AgentAdapter to wrap (defaults to CodingAgent). */
  agent?: AgentAdapter;
  /** Options forwarded when constructing the default CodingAgent. */
  codingAgentOptions?: CodingAgentOptions;
  /** Default runtime to execute against when execute(request) is called without an explicit runtime. */
  runtime?: AgentRuntime;
  /** Explicit harness ID override (defaults to `native:<agent.descriptor.name>` or `wazir-native`). */
  harnessId?: string;
  /** Default model ID when request.modelPreference is not provided. */
  defaultModelId?: string;
  /** Default runtime ID when request.runtimePreference is not provided. */
  defaultRuntimeId?: string;
  /** Whether the default runtime is a local zero-monetary-cost runtime (e.g., ollama, lmstudio). */
  isLocalRuntime?: boolean;
  /** Optional pricing table or rate for remote API cost calculation. */
  pricing?: PricingRate | Record<string, PricingRate>;
  /** Cost status override for priced remote API calls ('ACTUAL' | 'ESTIMATED'). */
  remoteCostStatus?: 'ACTUAL' | 'ESTIMATED';
  /**
   * Optional callback to inspect or compute physical workspace revision.
   * When omitted, the adapter inspects git/filesystem state and increments revision on confirmed physical mutations.
   */
  getWorkspaceRevision?: (workspaceRoot: string, currentRevision: number) => Promise<string | number> | string | number;
  /**
   * Checkpoint creation hook invoked on interruption, cancellation, or completion.
   */
  onCheckpoint?: (executionId: string) => Promise<string | undefined>;
  /**
   * Independent controller/verifier hook to confirm physical verification at the final workspaceRevision.
   * Apparent completion from the agent (`kind === 'done'`) remains `verified: false` unless this hook
   * (or explicit verification evidence) confirms `verified: true` with non-empty `evidenceIds` or passing checks.
   */
  verifyOutcome?: VerifyOutcomeHook;
  /**
   * Optional callback invoked on each AgentTurn yielded by the wrapped native agent.
   */
  onTurn?: (turn: AgentTurn) => void | Promise<void>;
  /**
   * Optional steering instruction provider forwarded to AgentRunRequest.
   */
  getSteeringInstruction?: () => string | undefined;
}

export interface NativeHarnessExecuteOptions {
  runtime?: AgentRuntime;
  onCheckpoint?: (executionId: string) => Promise<string | undefined>;
  verifyOutcome?: VerifyOutcomeHook;
  onTurn?: (turn: AgentTurn) => void | Promise<void>;
  verificationEvidenceIds?: string[];
  signal?: AbortSignal;
}

const CHECK_TOOL_NAMES = new Set<string>(['test', 'lint', 'typecheck', 'build']);
const READ_ONLY_TOOL_NAMES = new Set<string>(['read', 'glob', 'search', 'web_search', 'web_fetch']);
const IDEMPOTENT_WRITE_TOOL_NAMES = new Set<string>(['write', 'write_to_file']);
const LOCAL_RUNTIME_PATTERNS = /^(ollama|lmstudio|local|llamacpp|llama\.cpp|vllm-local|mlx)/i;

function classifyToolSideEffect(toolName: string, runtimeTools: AgentRuntime['tools']): ToolSideEffectClass {
  const found = runtimeTools.find((t) => t.name === toolName);
  const descriptorClass = (found as { descriptor?: { sideEffectClass?: ToolSideEffectClass } } | undefined)?.descriptor?.sideEffectClass;
  if (descriptorClass) return descriptorClass;
  if (READ_ONLY_TOOL_NAMES.has(toolName)) return 'READ_ONLY';
  if (IDEMPOTENT_WRITE_TOOL_NAMES.has(toolName)) return 'IDEMPOTENT_WRITE';
  return 'NON_IDEMPOTENT_WRITE';
}

function hashObject(value: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(value ?? {})).digest('hex');
  } catch {
    return createHash('sha256').update(String(value)).digest('hex');
  }
}

function computeContractDigest(request: UnifiedExecutionRequest): string {
  const payload = {
    executionId: request.executionId,
    taskId: request.taskId,
    objective: request.objective,
    taskType: request.taskType ?? 'coding',
    workspace: request.workspace,
    constraints: request.constraints,
    verification: request.verification,
    policyContext: request.policyContext,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function parseInitialRevisionNumber(revision: string | number): number {
  if (typeof revision === 'number' && Number.isFinite(revision)) {
    return Math.max(0, Math.floor(revision));
  }
  const parsed = Number.parseInt(String(revision), 10);
  return Number.isFinite(parsed) && String(parsed) === String(revision).trim() ? Math.max(0, parsed) : 0;
}

/**
 * Best-effort physical git/filesystem fingerprint of a workspace root so that
 * tool calls (such as `shell` or `edit`) that mutate files on disk without
 * populating `ToolResult.fileMutations` are still detected as physical workspace revisions.
 */
function captureGitOrFsState(workspaceRoot: string): { gitStatus?: string; gitHead?: string; modifiedFiles: string[] } {
  if (!workspaceRoot || !existsSync(workspaceRoot)) {
    return { modifiedFiles: [] };
  }
  try {
    const gitHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim();
    const gitStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    const modifiedFiles = gitStatus
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        return parts[parts.length - 1] ?? '';
      })
      .filter(Boolean);
    return { gitHead, gitStatus, modifiedFiles };
  } catch {
    return { modifiedFiles: [] };
  }
}

function computeFileHashSafe(workspaceRoot: string, relOrAbsPath: string): string | undefined {
  try {
    const resolved = path.isAbsolute(relOrAbsPath) ? relOrAbsPath : path.resolve(workspaceRoot, relOrAbsPath);
    if (!existsSync(resolved)) return undefined;
    const st = statSync(resolved);
    if (!st.isFile()) return undefined;
    const content = readFileSync(resolved);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return undefined;
  }
}

function mapCapabilitiesFromAgent(descriptor: AgentDescriptor): HarnessCapability[] {
  const caps = new Set<HarnessCapability>([
    'streaming',
    'tool-Forwarding',
    'checkpoint-resume',
    'cancellation',
    'workspace-isolation',
  ]);
  if (descriptor.capabilities.includes('coding') || descriptor.taskTypes.includes('coding')) {
    caps.add('coding');
  }
  if (descriptor.capabilities.includes('generalChat') || descriptor.taskTypes.includes('chat')) {
    caps.add('chat');
  }
  if (descriptor.capabilities.includes('stepExecution') || descriptor.name === 'wazir-step') {
    caps.add('step-execution');
  }
  if (descriptor.permissions.includes('mcp')) {
    caps.add('mcp');
  }
  return [...caps];
}

function resolveFailureClassification(
  status: UnifiedExecutionStatus,
  terminationReason?: TerminationReason,
  errorKind?: AgentErrorKind,
  hasUnknownToolOutcome?: boolean,
): string | undefined {
  if (status === 'completed') return undefined;
  if (hasUnknownToolOutcome) return 'TOOL_OUTCOME_UNKNOWN';
  if (status === 'cancelled' || terminationReason === 'CANCELLED' || errorKind === 'cancelled') {
    return 'EXECUTION_CANCELLED';
  }
  if (status === 'interrupted') return 'EXECUTION_INTERRUPTED';
  if (terminationReason) return terminationReason;
  if (errorKind) return `AGENT_ERROR_${errorKind.toUpperCase()}`;
  return 'EXECUTION_FAILED';
}

/**
 * NativeHarnessAdapter wraps Wazir-native `AgentAdapter` implementations (`CodingAgent`,
 * `ChatAgent`, `StepAgent`, or custom `AgentAdapter`s) behind the unified cross-harness
 * execution contract (`UnifiedExecutionRequest` -> `UnifiedExecutionResult`).
 *
 * It preserves the underlying agent's turn loop without duplicating it, intercepting
 * `AgentRuntime.generate` and `AgentRuntime.executeTool` to record accurate telemetry
 * (tokens, first-token latency, model calls, monetary cost status), tool call checkpoints
 * (`STARTED` / `COMPLETED` / `FAILED` / `OUTCOME_UNKNOWN`), physical workspace revisions,
 * cooperative + abort cancellation, checkpoint creation hooks, and strict separation between
 * apparent model completion and controller-verified completion.
 */
export class NativeHarnessAdapter {
  readonly descriptor: HarnessDescriptor;
  private readonly agent: AgentAdapter;
  private readonly options: NativeHarnessAdapterOptions;
  private activeAbortController: AbortController | null = null;
  private cancelledManually = false;
  private lastToolCheckpoints: ToolCallCheckpoint[] = [];
  private lastTurns: AgentTurn[] = [];

  constructor(options: NativeHarnessAdapterOptions = {}) {
    this.options = options;
    this.agent = options.agent ?? new CodingAgent(options.codingAgentOptions);

    const agentDesc = this.agent.descriptor;
    const harnessId = options.harnessId ?? (agentDesc.name.startsWith('wazir-') ? agentDesc.name : `native:${agentDesc.name}`);
    const supportedTaskTypes: TaskType[] =
      agentDesc.taskTypes.length > 0
        ? [...agentDesc.taskTypes]
        : ['coding', 'debugging', 'code_analysis', 'chat', 'research'];

    this.descriptor = {
      harnessId,
      name: agentDesc.description || `Wazir Native Harness (${agentDesc.name})`,
      version: agentDesc.version || '1.0.0',
      kind: 'native',
      capabilities: mapCapabilitiesFromAgent(agentDesc),
      supportedTaskTypes,
      supportedProtocols: ['native'],
      allowsModelSelection: true,
      defaultPermissionMode: 'edit',
    };
  }

  /**
   * Returns the underlying Wazir-native `AgentAdapter`.
   */
  getWrappedAgent(): AgentAdapter {
    return this.agent;
  }

  /**
   * Returns the tool call checkpoints recorded during the most recent execution.
   */
  getToolCheckpoints(): ToolCallCheckpoint[] {
    return structuredClone(this.lastToolCheckpoints);
  }

  /**
   * Returns the raw `AgentTurn` sequence yielded during the most recent execution.
   */
  getLastTurns(): AgentTurn[] {
    return [...this.lastTurns];
  }

  /**
   * Cooperatively cancels and aborts any in-flight execution on this adapter instance.
   */
  cancel(): void {
    this.cancelledManually = true;
    this.activeAbortController?.abort();
  }

  /**
   * Resets manual cancellation state before a new execution run.
   */
  resetCancellation(): void {
    this.cancelledManually = false;
  }

  /**
   * Executes a `UnifiedExecutionRequest` using the wrapped native `AgentAdapter`
   * and returns a normalized `UnifiedExecutionResult`.
   */
  async execute(
    request: UnifiedExecutionRequest,
    runtimeOrOptions?: AgentRuntime | NativeHarnessExecuteOptions,
  ): Promise<UnifiedExecutionResult> {
    const execOpts: NativeHarnessExecuteOptions =
      runtimeOrOptions && 'generate' in runtimeOrOptions && 'executeTool' in runtimeOrOptions
        ? { runtime: runtimeOrOptions }
        : (runtimeOrOptions ?? {});

    const baseRuntime = execOpts.runtime ?? this.options.runtime;
    if (!baseRuntime) {
      throw new Error('NativeHarnessAdapter.execute requires an AgentRuntime (via constructor options or execute parameter)');
    }

    this.cancelledManually = false;
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    if (execOpts.signal) {
      if (execOpts.signal.aborted) {
        this.cancelledManually = true;
        abortController.abort();
      } else {
        execOpts.signal.addEventListener(
          'abort',
          () => {
            this.cancelledManually = true;
            abortController.abort();
          },
          { once: true },
        );
      }
    }

    const isCancelled = (): boolean => {
      return Boolean(this.cancelledManually || abortController.signal.aborted || request.isCancelled?.());
    };

    const startedAtDate = new Date();
    const startTimeMs = Date.now();
    const contractDigest = computeContractDigest(request);

    let activeModelId =
      request.modelPreference ??
      this.options.defaultModelId ??
      'default-model';
    const runtimeId =
      request.runtimePreference ??
      (baseRuntime as { id?: string }).id ??
      this.options.defaultRuntimeId ??
      'native-runtime';

    const workspaceRoot = request.workspace.root;
    const initialRevisionStr = String(request.workspace.revision);
    let numericRevision = parseInitialRevisionNumber(request.workspace.revision);
    if (request.resumeContext && request.resumeContext.workspaceRevision > numericRevision) {
      numericRevision = request.resumeContext.workspaceRevision;
    }
    let currentWorkspaceRevisionStr =
      request.resumeContext && request.resumeContext.workspaceRevision > parseInitialRevisionNumber(request.workspace.revision)
        ? String(request.resumeContext.workspaceRevision)
        : initialRevisionStr;

    const filesChangedSet = new Set<string>(request.resumeContext?.filesChanged ?? []);
    const toolCalls: ToolCallRecord[] = [];
    const toolCheckpoints: ToolCallCheckpoint[] = [];
    const checks: CheckRunRecord[] = [];
    const errors: string[] = [];
    const turns: AgentTurn[] = [];

    let inputTokensTotal = 0;
    let outputTokensTotal = 0;
    let totalTokensTotal = 0;
    let sawTokenUsage = false;
    let modelCallsCount = 0;
    let firstTokenLatencyMs: number | undefined;
    let interruptedDuringModelOrTool = false;

    const refreshRevisionOnMutation = async (mutatedPaths: string[]): Promise<void> => {
      for (const p of mutatedPaths) {
        if (p) filesChangedSet.add(p);
      }
      numericRevision += 1;
      if (this.options.getWorkspaceRevision) {
        const rev = await this.options.getWorkspaceRevision(workspaceRoot, numericRevision);
        currentWorkspaceRevisionStr = String(rev);
      } else {
        currentWorkspaceRevisionStr = String(numericRevision);
      }
    };

    // Instrument AgentRuntime without duplicating the wrapped agent's turn loop
    const instrumentedRuntime: AgentRuntime = {
      tools: baseRuntime.tools,
      runtimeCapabilities: baseRuntime.runtimeCapabilities,
      getCapabilities: baseRuntime.getCapabilities ? () => baseRuntime.getCapabilities!() : undefined,
      getContextTokens: baseRuntime.getContextTokens ? () => baseRuntime.getContextTokens!() : undefined,
      cancelCurrentTurn: () => {
        baseRuntime.cancelCurrentTurn?.();
      },
      escalate: baseRuntime.escalate
        ? async (escalationReq) => {
            if (!request.constraints.allowFallback) {
              return { reason: 'Fallback disabled by UnifiedExecutionRequest.constraints.allowFallback=false' };
            }
            const decision = await baseRuntime.escalate!(escalationReq);
            if (decision.modelId) {
              activeModelId = decision.modelId;
            }
            return decision;
          }
        : undefined,
      generate: (genReq) => {
        const self = this;
        return (async function* (): AsyncGenerator<GenerationEvent> {
          if (isCancelled()) {
            baseRuntime.cancelCurrentTurn?.();
            return;
          }
          modelCallsCount += 1;
          if (genReq.modelId) {
            activeModelId = genReq.modelId;
          }
          const callStartMs = Date.now();
          let recordedFirstTokenForCall = false;
          let sawTerminalEvent = false;

          const abortListener = () => {
            baseRuntime.cancelCurrentTurn?.();
          };
          abortController.signal.addEventListener('abort', abortListener, { once: true });

          try {
            for await (const event of baseRuntime.generate(genReq)) {
              if (!recordedFirstTokenForCall && (event.type === 'token' || event.type === 'tool_call' || event.type === 'completed')) {
                recordedFirstTokenForCall = true;
                if (firstTokenLatencyMs === undefined) {
                  firstTokenLatencyMs = Math.max(0, Date.now() - callStartMs);
                }
              }
              if (event.type === 'completed') {
                sawTerminalEvent = true;
                if (event.usage) {
                  sawTokenUsage = true;
                  const inTok = event.usage.inputTokens ?? 0;
                  const outTok = event.usage.outputTokens ?? 0;
                  const totTok = event.usage.totalTokens ?? inTok + outTok;
                  inputTokensTotal += inTok;
                  outputTokensTotal += outTok;
                  totalTokensTotal += totTok;
                }
              }
              if (event.type === 'error') {
                sawTerminalEvent = true;
              }
              yield event;
              if (self.cancelledManually || abortController.signal.aborted) {
                baseRuntime.cancelCurrentTurn?.();
                break;
              }
            }
          } catch (err) {
            if (!sawTerminalEvent && !isCancelled()) {
              interruptedDuringModelOrTool = true;
            }
            throw err;
          } finally {
            abortController.signal.removeEventListener('abort', abortListener);
          }
        })();
      },
      executeTool: async (toolName: string, input: Record<string, unknown>): Promise<ToolResult> => {
        const callId = `call-${randomUUID()}`;
        const startedAt = new Date();
        const callStartMs = Date.now();
        const sideEffectClass = classifyToolSideEffect(toolName, baseRuntime.tools);

        // Enforce protected paths policy before dispatching mutating file tools
        if (request.verification.protectedPaths.length > 0 && sideEffectClass !== 'READ_ONLY') {
          const targetPath = typeof input.path === 'string' ? input.path : undefined;
          if (targetPath) {
            const normalizedTarget = path.normalize(targetPath).replace(/^(\.\/)+/, '');
            const isProtected = request.verification.protectedPaths.some((protectedPattern) => {
              const normProt = path.normalize(protectedPattern).replace(/^(\.\/)+/, '');
              return (
                normalizedTarget === normProt ||
                normalizedTarget.startsWith(`${normProt}/`) ||
                normalizedTarget.startsWith(`${normProt}${path.sep}`)
              );
            });
            if (isProtected) {
              const durationMs = Math.max(0, Date.now() - callStartMs);
              const deniedError = `POLICY_DENIED: path '${targetPath}' is protected by verification.protectedPaths`;
              const checkpoint: ToolCallCheckpoint = {
                executionId: request.executionId,
                stepId: callId,
                callId,
                toolName,
                argumentsHash: hashObject(input),
                startedAt,
                finishedAt: new Date(),
                state: 'FAILED',
                sideEffectClass,
                workspaceRevision: numericRevision,
                input: structuredClone(input),
              };
              toolCheckpoints.push(checkpoint);
              toolCalls.push({
                id: callId,
                callId,
                tool: toolName,
                input: structuredClone(input),
                ok: false,
                error: deniedError,
                output: '',
                policyEffect: 'deny',
                policyRule: 'verification.protectedPaths',
                durationMs,
                at: startedAt,
                cwd: workspaceRoot,
                projectRoot: workspaceRoot,
              });
              return {
                ok: false,
                output: '',
                error: deniedError,
                durationMs,
              };
            }
          }
        }

        const checkpoint: ToolCallCheckpoint = {
          executionId: request.executionId,
          stepId: callId,
          callId,
          toolName,
          argumentsHash: hashObject(input),
          startedAt,
          state: 'STARTED',
          sideEffectClass,
          workspaceRevision: numericRevision,
          input: structuredClone(input),
        };
        toolCheckpoints.push(checkpoint);

        const beforeGitState = sideEffectClass !== 'READ_ONLY' ? captureGitOrFsState(workspaceRoot) : undefined;
        const targetPath = typeof input.path === 'string' ? input.path : undefined;
        const beforeTargetHash =
          sideEffectClass !== 'READ_ONLY' && targetPath ? computeFileHashSafe(workspaceRoot, targetPath) : undefined;

        let result: ToolResult;
        try {
          result = await baseRuntime.executeTool(toolName, input);
        } catch (err) {
          const durationMs = Math.max(0, Date.now() - callStartMs);
          const errorMessage = err instanceof Error ? err.message : String(err);
          const isUnknownOutcome =
            sideEffectClass !== 'READ_ONLY' &&
            (/OUTCOME_UNKNOWN|INTERRUPTED|ECONNRESET|EPIPE|killed|aborted| crashed/i.test(errorMessage) || isCancelled());

          checkpoint.finishedAt = new Date();
          checkpoint.state = isUnknownOutcome ? 'OUTCOME_UNKNOWN' : 'FAILED';
          if (isUnknownOutcome) {
            interruptedDuringModelOrTool = true;
          }

          toolCalls.push({
            id: callId,
            callId,
            tool: toolName,
            input: structuredClone(input),
            ok: false,
            error: errorMessage,
            failureClass: isUnknownOutcome ? 'TOOL_OUTCOME_UNKNOWN' : undefined,
            policyEffect: 'allow',
            policyRule: 'native-harness-runtime',
            durationMs,
            at: startedAt,
            cwd: workspaceRoot,
            projectRoot: workspaceRoot,
          });
          throw err;
        }

        const durationMs = result.durationMs ?? Math.max(0, Date.now() - callStartMs);
        const outcomeUnknownFromResult =
          result.failureClass === 'TOOL_OUTCOME_UNKNOWN' ||
          (result.metadata && result.metadata.outcomeUnknown === true);

        checkpoint.finishedAt = new Date();
        if (outcomeUnknownFromResult) {
          checkpoint.state = 'OUTCOME_UNKNOWN';
          interruptedDuringModelOrTool = true;
        } else {
          checkpoint.state = result.ok ? 'COMPLETED' : 'FAILED';
        }

        const policyEffect: PolicyEffect =
          (result.metadata?.policyEffect as PolicyEffect | undefined) ??
          (result.error && /POLICY_DENIED|policy denied/i.test(result.error) ? 'deny' : 'allow');
        const policyRule =
          (result.metadata?.policyRule as string | undefined) ?? 'native-harness-runtime';

        // Detect physical workspace mutations
        const mutatedPaths: string[] = [];
        if (result.fileMutations && result.fileMutations.length > 0) {
          for (const mutation of result.fileMutations) {
            if (mutation.changed) {
              mutatedPaths.push(mutation.path);
            }
          }
        } else if (sideEffectClass !== 'READ_ONLY' && result.ok) {
          if (targetPath) {
            const afterTargetHash = computeFileHashSafe(workspaceRoot, targetPath);
            if (beforeTargetHash !== afterTargetHash || !existsSync(workspaceRoot)) {
              mutatedPaths.push(targetPath);
            } else if (toolName === 'write' || toolName === 'edit' || toolName === 'write_to_file' || toolName === 'replace_file_content') {
              mutatedPaths.push(targetPath);
            }
          }
          if (beforeGitState) {
            const afterGitState = captureGitOrFsState(workspaceRoot);
            if (
              afterGitState.gitHead !== beforeGitState.gitHead ||
              afterGitState.gitStatus !== beforeGitState.gitStatus
            ) {
              for (const modFile of afterGitState.modifiedFiles) {
                if (!mutatedPaths.includes(modFile)) {
                  mutatedPaths.push(modFile);
                }
              }
              if (mutatedPaths.length === 0 && targetPath) {
                mutatedPaths.push(targetPath);
              }
            }
          }
        }

        if (mutatedPaths.length > 0) {
          await refreshRevisionOnMutation(mutatedPaths);
        }

        if (CHECK_TOOL_NAMES.has(toolName)) {
          const checkOutput = result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n');
          // Skip recording missing script skips as check runs if CodingAgent ignores them
          const isSkippedMissingScript =
            !result.ok && checkOutput && /missing script|no such file|not found/i.test(checkOutput);
          if (!isSkippedMissingScript) {
            checks.push({
              workspaceRevision: numericRevision,
              name: toolName as CheckRunRecord['name'],
              command: typeof input.command === 'string' ? input.command : toolName,
              ok: result.ok,
              output: checkOutput,
              durationMs,
            });
          }
        }

        toolCalls.push({
          id: callId,
          callId,
          tool: toolName,
          input: structuredClone(input),
          output: result.output,
          ok: result.ok,
          error: result.error,
          failureClass: result.failureClass,
          policyEffect,
          policyRule,
          durationMs,
          at: startedAt,
          sandbox: result.metadata?.sandbox as string | undefined,
          shellInvocationId: result.metadata?.shellInvocationId as string | undefined,
          cwd: (result.metadata?.cwd as string | undefined) ?? workspaceRoot,
          projectRoot: workspaceRoot,
          exitCode: result.metadata?.exitCode as number | undefined,
        });

        return result;
      },
    };

    const agentRequest: AgentRunRequest = {
      modelId: activeModelId,
      taskDescription: request.objective,
      taskType: request.taskType ?? 'coding',
      projectRoot: workspaceRoot,
      maxTurns: request.constraints.maxTurns,
      maxWallClockMs: request.constraints.maxDurationMs,
      maxToolCalls: request.constraints.maxToolCalls,
      maxTokens: request.constraints.maxTokens,
      maxModelEscalations: request.constraints.allowFallback ? undefined : 0,
      resume: request.resumeContext,
      isCancelled,
      getSteeringInstruction: this.options.getSteeringInstruction,
      mutationRequired: request.verification.mutationRequired,
      expectedArtifacts: request.verification.expectedArtifacts,
      expectedEvidence: request.verification.requiredChecks,
    };

    let terminalTurn: AgentTurn | undefined;
    let thrownError: Error | undefined;

    try {
      for await (const turn of this.agent.run(agentRequest, instrumentedRuntime)) {
        turns.push(turn);
        if (turn.routeChange?.newModel) {
          activeModelId = turn.routeChange.newModel;
        }
        if (turn.kind === 'message' && typeof turn.content === 'string' && turn.content.startsWith('files-changed: ')) {
          const changedFile = turn.content.slice('files-changed: '.length).trim();
          if (changedFile && !filesChangedSet.has(changedFile)) {
            await refreshRevisionOnMutation([changedFile]);
          }
        }
        if (turn.kind === 'done' || turn.kind === 'error') {
          terminalTurn = turn;
        }
        const onTurnHook = execOpts.onTurn ?? this.options.onTurn;
        if (onTurnHook) {
          await onTurnHook(turn);
        }
      }
    } catch (err) {
      thrownError = err instanceof Error ? err : new Error(String(err));
      errors.push(thrownError.message);
    } finally {
      this.activeAbortController = null;
    }

    this.lastToolCheckpoints = toolCheckpoints;
    this.lastTurns = turns;

    // Determine whether any tool call ended in an unresolved / unknown state
    const hasUnknownToolOutcome = toolCheckpoints.some(
      (cp) => cp.state === 'STARTED' || cp.state === 'OUTCOME_UNKNOWN',
    );
    const hasNonReadOnlyUnknownOutcome = toolCheckpoints.some(
      (cp) => cp.sideEffectClass !== 'READ_ONLY' && (cp.state === 'STARTED' || cp.state === 'OUTCOME_UNKNOWN'),
    );

    // Map terminal state to UnifiedExecutionStatus, TerminationReason, AgentErrorKind
    let status: UnifiedExecutionStatus;
    let terminationReason: TerminationReason | undefined = terminalTurn?.terminationReason;
    let errorKind: AgentErrorKind | undefined = terminalTurn?.errorKind;
    let output: string | undefined = terminalTurn?.content;

    if (hasNonReadOnlyUnknownOutcome) {
      status = 'unknown';
      errorKind = errorKind ?? 'infrastructure';
      errors.push('One or more mutating tool calls ended with OUTCOME_UNKNOWN; reconciliation required before replay.');
    } else if (isCancelled() || terminationReason === 'CANCELLED' || errorKind === 'cancelled') {
      status = 'cancelled';
      terminationReason = 'CANCELLED';
      errorKind = 'cancelled';
      if (terminalTurn?.error && !errors.includes(terminalTurn.error)) {
        errors.push(terminalTurn.error);
      }
    } else if (thrownError || interruptedDuringModelOrTool) {
      const msg = thrownError?.message ?? terminalTurn?.error ?? 'Execution interrupted';
      if (/INCOMPLETE_PROVIDER_STREAM|INTERRUPTED|ECONNRESET|socket hang up|owner process exited/i.test(msg) || interruptedDuringModelOrTool) {
        status = 'interrupted';
        errorKind = errorKind ?? 'infrastructure';
      } else {
        status = 'failed';
        errorKind = errorKind ?? 'infrastructure';
      }
    } else if (!terminalTurn) {
      if (isCancelled()) {
        status = 'cancelled';
        terminationReason = 'CANCELLED';
        errorKind = 'cancelled';
      } else {
        status = 'interrupted';
        errorKind = 'infrastructure';
        errors.push('Agent stream ended without a terminal turn');
      }
    } else if (terminalTurn.kind === 'done') {
      status = 'completed';
      terminationReason = terminationReason ?? 'COMPLETED';
    } else {
      // terminalTurn.kind === 'error'
      if (terminalTurn.error) {
        errors.push(terminalTurn.error);
      }
      // StepAgent / legacy adapters may not stamp terminationReason on every error turn; infer deterministically
      if (!terminationReason && terminalTurn.error) {
        if (/turn limit|MAX_TURNS/i.test(terminalTurn.error)) {
          terminationReason = 'MAX_TURNS';
        } else if (/circuit breaker|REPEATED_ACTION/i.test(terminalTurn.error)) {
          terminationReason = 'REPEATED_ACTION';
        } else if (/failed to produce valid JSON action|MODEL_PROTOCOL_BUDGET_EXHAUSTED/i.test(terminalTurn.error)) {
          terminationReason = 'MODEL_PROTOCOL_BUDGET_EXHAUSTED';
        } else if (/POLICY_DENIED|policy denied/i.test(terminalTurn.error)) {
          terminationReason = 'POLICY_DENIED';
          errorKind = errorKind ?? 'policy';
        } else if (/verification failed/i.test(terminalTurn.error)) {
          terminationReason = 'VERIFICATION_FAILED';
          errorKind = errorKind ?? 'verification';
        }
      }
      if (
        errorKind === 'infrastructure' &&
        terminalTurn.error &&
        /INCOMPLETE_PROVIDER_STREAM|INTERRUPTED|ECONNRESET|socket hang up/i.test(terminalTurn.error)
      ) {
        status = 'interrupted';
      } else {
        status = 'failed';
      }
    }

    // Check required checks that may not have been run if status is 'completed'
    if (status === 'completed' && request.verification.requiredChecks.length > 0) {
      for (const reqCheck of request.verification.requiredChecks) {
        if (CHECK_TOOL_NAMES.has(reqCheck)) {
          const matchingChecks = checks.filter(
            (c) => c.name === reqCheck && (c.workspaceRevision ?? numericRevision) === numericRevision,
          );
          if (matchingChecks.some((c) => !c.ok)) {
            status = 'failed';
            terminationReason = 'VERIFICATION_FAILED';
            errorKind = 'verification';
            errors.push(`Required check '${reqCheck}' failed at workspace revision ${currentWorkspaceRevisionStr}`);
          }
        }
      }
    }

    // Invariant 1: Physical Execution Facts vs. Model Claims
    // Apparent completion (`status === 'completed'`) has `verified: false` unless independent verification
    // evidence at the final workspaceRevision is confirmed via verifyOutcome hook or explicit evidence IDs.
    const verificationEvidenceIds: string[] = [...(execOpts.verificationEvidenceIds ?? [])];
    let verified = false;

    const verifyHook = execOpts.verifyOutcome ?? this.options.verifyOutcome;
    if (status === 'completed' && verifyHook) {
      const hookOutcome = await verifyHook(request, turns, currentWorkspaceRevisionStr);
      if (hookOutcome.checks && hookOutcome.checks.length > 0) {
        for (const chk of hookOutcome.checks) {
          checks.push({
            ...chk,
            workspaceRevision: chk.workspaceRevision ?? numericRevision,
          });
        }
      }
      for (const id of hookOutcome.evidenceIds) {
        if (id && !verificationEvidenceIds.includes(id)) {
          verificationEvidenceIds.push(id);
        }
      }
      const allChecksPassAtCurrentRev =
        !hookOutcome.checks ||
        hookOutcome.checks.length === 0 ||
        hookOutcome.checks.every(
          (c) => c.ok && String(c.workspaceRevision ?? currentWorkspaceRevisionStr) === currentWorkspaceRevisionStr,
        );
      if (hookOutcome.verified && verificationEvidenceIds.length > 0 && allChecksPassAtCurrentRev) {
        verified = true;
        terminationReason = 'VERIFICATION_PASSED';
      } else if (!hookOutcome.verified) {
        verified = false;
        status = 'failed';
        terminationReason = 'VERIFICATION_FAILED';
        errorKind = 'verification';
        errors.push('Controller verification hook rejected apparent completion at final workspace revision');
      }
    } else if (status === 'completed' && verificationEvidenceIds.length > 0) {
      const currentRevChecks = checks.filter(
        (c) => String(c.workspaceRevision ?? currentWorkspaceRevisionStr) === currentWorkspaceRevisionStr,
      );
      const anyFailedCheck = currentRevChecks.some((c) => !c.ok);
      if (!anyFailedCheck) {
        verified = true;
        terminationReason = 'VERIFICATION_PASSED';
      }
    }

    // If the agent claimed VERIFICATION_PASSED internally (e.g. CodingAgent fast-path or internal check),
    // downgrade terminationReason to COMPLETED when verified is false so callers never confuse apparent
    // completion with controller-verified completion.
    if (status === 'completed' && !verified && terminationReason === 'VERIFICATION_PASSED') {
      terminationReason = 'COMPLETED';
    }

    // Checkpoint creation hook
    let checkpointId = request.checkpointId;
    const checkpointHook = execOpts.onCheckpoint ?? this.options.onCheckpoint;
    if (checkpointHook && (status === 'interrupted' || status === 'cancelled' || status === 'failed' || status === 'unknown' || status === 'completed')) {
      const createdCheckpointId = await checkpointHook(request.executionId);
      if (createdCheckpointId) {
        checkpointId = createdCheckpointId;
      }
    }

    // Build artifacts list from changed files and expected artifacts
    const artifacts: UnifiedArtifactRecord[] = [];
    const artifactPaths = new Set<string>([
      ...filesChangedSet,
      ...(request.verification.expectedArtifacts ?? []),
    ]);
    const completedAtIso = new Date().toISOString();
    for (const artPath of artifactPaths) {
      const hash = computeFileHashSafe(workspaceRoot, artPath);
      if (hash || filesChangedSet.has(artPath)) {
        artifacts.push({
          path: artPath,
          ...(hash ? { hash } : {}),
          kind: 'file',
          createdAt: completedAtIso,
        });
      }
    }

    // Usage & Monetary Cost calculation (Invariant 3: ACTUAL vs ESTIMATED vs UNKNOWN)
    const durationMs = Math.max(0, Date.now() - startTimeMs);
    const runStatsTokens = terminalTurn?.runStats?.tokensUsed;
    const priorConsumedTokens = request.resumeContext?.consumed.tokens ?? 0;
    const netRunStatsTokens =
      typeof runStatsTokens === 'number' && runStatsTokens >= priorConsumedTokens
        ? runStatsTokens - priorConsumedTokens
        : runStatsTokens;

    const effectiveTotalTokens = sawTokenUsage
      ? totalTokensTotal
      : typeof netRunStatsTokens === 'number' && netRunStatsTokens > 0
        ? netRunStatsTokens
        : undefined;

    const { costUSD, costStatus } = this.computeMonetaryCost(
      runtimeId,
      activeModelId,
      sawTokenUsage ? inputTokensTotal : undefined,
      sawTokenUsage ? outputTokensTotal : undefined,
    );

    // Check maxCostUSD constraint if cost is known
    if (
      status === 'completed' &&
      request.constraints.maxCostUSD !== undefined &&
      costUSD !== undefined &&
      costUSD > request.constraints.maxCostUSD
    ) {
      status = 'failed';
      verified = false;
      terminationReason = 'RESOURCE_EXHAUSTED';
      errorKind = 'other';
      errors.push(`Execution cost ($${costUSD.toFixed(6)}) exceeded maxCostUSD budget ($${request.constraints.maxCostUSD})`);
    }

    const failureClassification = resolveFailureClassification(
      status,
      terminationReason,
      errorKind,
      hasUnknownToolOutcome,
    );

    return {
      schemaVersion: request.schemaVersion ?? HARNESS_CONTRACT_SCHEMA_VERSION,
      executionId: request.executionId,
      taskId: request.taskId,
      harnessId: this.descriptor.harnessId,
      harnessKind: 'native',
      modelId: activeModelId,
      runtimeId,
      status,
      verified,
      terminationReason,
      errorKind,
      workspaceRevision: currentWorkspaceRevisionStr,
      filesChanged: [...filesChangedSet],
      artifacts,
      toolCalls,
      ...(checks.length > 0 ? { checks } : {}),
      usage: {
        ...(sawTokenUsage ? { inputTokens: inputTokensTotal, outputTokens: outputTokensTotal } : {}),
        ...(effectiveTotalTokens !== undefined ? { totalTokens: effectiveTotalTokens } : {}),
        ...(costUSD !== undefined ? { costUSD } : {}),
        costStatus,
        durationMs,
        ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
        modelCalls: modelCallsCount,
      },
      verificationEvidenceIds,
      ...(checkpointId ? { checkpointId } : {}),
      ...(failureClassification ? { failureClassification } : {}),
      ...(errors.length > 0 ? { errors } : {}),
      ...(output !== undefined ? { output } : {}),
      provenance: {
        startedAt: startedAtDate.toISOString(),
        completedAt: completedAtIso,
        contractDigest,
      },
    };
  }

  private computeMonetaryCost(
    runtimeId: string,
    modelId: string,
    inputTokens?: number,
    outputTokens?: number,
  ): { costUSD?: number; costStatus: CostStatus } {
    const isLocal =
      this.options.isLocalRuntime === true ||
      (this.options.isLocalRuntime === undefined && LOCAL_RUNTIME_PATTERNS.test(runtimeId));

    if (isLocal) {
      return { costUSD: 0, costStatus: 'ACTUAL' };
    }

    if (this.options.pricing && inputTokens !== undefined && outputTokens !== undefined) {
      let rate: PricingRate | undefined;
      if ('inputCostPerMillionUsd' in this.options.pricing) {
        rate = this.options.pricing as PricingRate;
      } else {
        const table = this.options.pricing as Record<string, PricingRate>;
        rate = table[modelId] ?? table[`${runtimeId}:${modelId}`] ?? table['*'];
      }
      if (rate) {
        const costUSD = Number(
          (
            (inputTokens / 1_000_000) * rate.inputCostPerMillionUsd +
            (outputTokens / 1_000_000) * rate.outputCostPerMillionUsd
          ).toFixed(8),
        );
        return {
          costUSD,
          costStatus: this.options.remoteCostStatus ?? 'ESTIMATED',
        };
      }
    }

    return { costUSD: undefined, costStatus: 'UNKNOWN' };
  }
}

export function createNativeCodingHarnessAdapter(
  options: Omit<NativeHarnessAdapterOptions, 'agent'> & { codingAgentOptions?: CodingAgentOptions } = {},
): NativeHarnessAdapter {
  return new NativeHarnessAdapter({
    ...options,
    agent: new CodingAgent(options.codingAgentOptions),
  });
}

export function createNativeChatHarnessAdapter(
  options: Omit<NativeHarnessAdapterOptions, 'agent'> & { timeoutMs?: number } = {},
): NativeHarnessAdapter {
  return new NativeHarnessAdapter({
    ...options,
    agent: new ChatAgent({ timeoutMs: options.timeoutMs }),
  });
}

export function createNativeStepHarnessAdapter(
  options: Omit<NativeHarnessAdapterOptions, 'agent'> & { stepAgentOptions?: StepAgentOptions } = {},
): NativeHarnessAdapter {
  return new NativeHarnessAdapter({
    ...options,
    agent: new StepAgent(options.stepAgentOptions),
  });
}
