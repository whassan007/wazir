import type { ModelRequirements } from './model.js';
import type { TaskType } from './task.js';
import type { ToolPermission } from './tool.js';
import type { ChatMessage } from './conversation.js';
import type { GenerationEvent } from '@wazir/runtimes-interfaces';
import type { ToolResult } from './tool.js';

export interface AgentDescriptor {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  requiredTools: string[];
  optionalTools?: string[];
  modelRequirements: ModelRequirements;
  permissions: ToolPermission[];
  taskTypes: TaskType[];
  /** Named execution strategy, e.g. 'plan-inspect-implement-test-repair-verify'. */
  strategy: string;
}

export interface AgentInfo {
  descriptor: AgentDescriptor;
  source: 'native' | 'external';
  registeredAt: Date;
}

export type AgentPhase =
  | 'plan'
  | 'inspect'
  | 'implement'
  | 'test'
  | 'debug'
  | 'repair'
  | 'verify'
  | 'complete';

/**
 * Coarse classification of why a turn/run failed, independent of the free-text `error`
 * message. Lets a consumer (retry policy, TUI, `wa executions inspect`) tell "the model
 * never produced a parseable/complete action" apart from "a real check failed" apart from
 * "policy said no" without parsing prose — previously all three surfaced as an
 * indistinguishable string, which is why a policy denial and a genuine test failure both
 * got the same retry treatment until jobOrchestrator's own separate `isPolicyDenial`
 * string-sniff was added.
 */
export type AgentErrorKind = 'protocol' | 'verification' | 'policy' | 'cancelled' | 'infrastructure' | 'other';

/**
 * Explicit, controller-owned reason a run stopped — finer-grained than `AgentErrorKind`
 * and set on success as well as failure, so a caller never has to infer "why did this
 * stop" from prose. The model cannot choose or extend this; it is assigned only at the
 * specific budget/policy/verification checkpoints the harness itself enforces.
 */
export type TerminationReason =
  | 'COMPLETED'
  | 'VERIFICATION_PASSED'
  | 'MAX_TURNS'
  | 'MAX_MODEL_CALLS'
  | 'MAX_TOOL_CALLS'
  | 'MAX_TOKENS'
  | 'MAX_WALL_CLOCK'
  | 'MAX_REPAIRS'
  | 'MAX_RETRIES'
  | 'NO_PROGRESS'
  | 'REPEATED_ACTION'
  | 'MODEL_PROTOCOL_BUDGET_EXHAUSTED'
  | 'POLICY_DENIED'
  | 'CANCELLED'
  | 'RESOURCE_EXHAUSTED';

export interface ModelProtocolMetrics {
  actionAttempts: number;
  validActions: number;
  validationErrors: number;
  malformedActions: number;
  adherenceRate: number;
}

export interface AgentTurn {
  kind: 'message' | 'tool_call' | 'tool_result' | 'phase' | 'done' | 'error';
  content?: string;
  tool?: string;
  toolInput?: unknown;
  toolResult?: ToolResult;
  phase?: AgentPhase;
  error?: string;
  /** Coarse failure class; only meaningful when `kind === 'error'`. */
  errorKind?: AgentErrorKind;
  /** Set only on a terminal `'done'` or `'error'` turn — why the run actually stopped. */
  terminationReason?: TerminationReason;
  /** The exact raw model response text this turn was produced from, when applicable —
   *  e.g. for `tool_call` (what the model said before it was parsed into the tool call)
   *  and for a `message`/`error` turn reporting an unparseable response. Lets an operator
   *  inspect what the model actually said instead of reconstructing it from the parsed
   *  action alone. */
  raw?: string;
  /** Model protocol adherence metrics for capability catalog tracking. */
  protocolMetrics?: ModelProtocolMetrics;
  /** Set on the turn reporting a controller-driven model switch mid-run. */
  routeChange?: ModelRouteChange;
}

/** Why the controller asked the host for a different model mid-run. */
export interface ModelEscalationRequest {
  currentModelId: string;
  /** Every model this run has used so far, including the current one. */
  triedModelIds: string[];
  failureClass: TerminationReason;
  reason: string;
}

/**
 * The host's answer. `modelId` absent means escalation was declined; `reason`
 * is required either way so the decision is explainable.
 */
export interface ModelEscalationDecision {
  modelId?: string;
  reason: string;
}

export interface ModelRouteChange {
  previousModel: string;
  newModel: string;
  failureClass: TerminationReason;
  reason: string;
  routeDecision: string;
}

export interface AgentRunRequest {
  /** Chosen by the scheduler, never by the agent. */
  modelId: string;
  taskDescription: string;
  taskType: TaskType;
  projectRoot: string;
  maxTurns?: number;
  /** Per-request override of the agent's repair-cycle budget; falls back to the agent default. */
  maxRepairCycles?: number;
  /** Per-request override of the agent's wall-clock budget; falls back to the agent default. */
  maxWallClockMs?: number;
  /** Per-request override of the agent's total tool-call budget; falls back to the agent default. */
  maxToolCalls?: number;
  /** Per-request override of the agent's total token budget; falls back to the agent default. */
  maxTokens?: number;
  /** Per-request override of the agent's semantic no-progress threshold; falls back to the agent default. */
  maxNoProgressIterations?: number;
  /** Per-request override of how many mid-run model escalations the agent may request. */
  maxModelEscalations?: number;
  /** The model's context window, when known — enables mid-run compaction. */
  contextTokens?: number;
  /** Set to true by the host when the user requested cancellation. */
  isCancelled?: () => boolean;
  /** Returns any pending mid-run user instruction, drained once per turn. */
  getSteeringInstruction?: () => string | undefined;
  /** Whether the task requires creating or modifying code/files. If false, zero file changes is valid. */
  mutationRequired?: boolean;
  expectedArtifacts?: string[];
  expectedEvidence?: string[];
  /** Depth of subagent nesting (0 = root agent, 1 = direct subagent). */
  subagentDepth?: number;
}

/**
 * The execution environment an agent runs inside. Agents never choose
 * computers, models or authorize actions — the control plane provides all of it.
 */
export interface AgentRuntime {
  generate(
    request: {
      modelId: string;
      messages: ChatMessage[];
      maxTokens?: number;
      temperature?: number;
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    },
  ): AsyncIterable<GenerationEvent>;
  executeTool(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;
  readonly tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  /**
   * Best-effort abort of whichever `generate()` call is currently in flight.
   * Lets the agent enforce a per-turn wall-clock budget independent of the
   * overall job timeout — a model that rambles without ever emitting a
   * parseable action would otherwise burn the whole job on one turn.
   */
  cancelCurrentTurn?(): void;
  /**
   * Controller hook for failure-based model escalation. The agent calls it when the
   * current model exhausts its protocol budget or stops making progress; the host
   * (which owns routing and placement) either names a model the same runtime can
   * serve now, or declines with a reason. Absent means escalation is unsupported.
   */
  escalate?(request: ModelEscalationRequest): Promise<ModelEscalationDecision>;
}

export interface AgentAdapter {
  readonly descriptor: AgentDescriptor;
  run(request: AgentRunRequest, runtime: AgentRuntime): AsyncIterable<AgentTurn>;
}
