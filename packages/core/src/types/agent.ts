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
  /** The exact raw model response text this turn was produced from, when applicable —
   *  e.g. for `tool_call` (what the model said before it was parsed into the tool call)
   *  and for a `message`/`error` turn reporting an unparseable response. Lets an operator
   *  inspect what the model actually said instead of reconstructing it from the parsed
   *  action alone. */
  raw?: string;
  /** Model protocol adherence metrics for capability catalog tracking. */
  protocolMetrics?: ModelProtocolMetrics;
}

export interface AgentRunRequest {
  /** Chosen by the scheduler, never by the agent. */
  modelId: string;
  taskDescription: string;
  taskType: TaskType;
  projectRoot: string;
  maxTurns?: number;
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
}

export interface AgentAdapter {
  readonly descriptor: AgentDescriptor;
  run(request: AgentRunRequest, runtime: AgentRuntime): AsyncIterable<AgentTurn>;
}
