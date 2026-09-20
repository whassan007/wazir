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

export interface AgentTurn {
  kind: 'message' | 'tool_call' | 'tool_result' | 'phase' | 'done' | 'error';
  content?: string;
  tool?: string;
  toolInput?: unknown;
  toolResult?: ToolResult;
  phase?: AgentPhase;
  error?: string;
}

export interface AgentRunRequest {
  /** Chosen by the scheduler, never by the agent. */
  modelId: string;
  taskDescription: string;
  taskType: TaskType;
  projectRoot: string;
  maxTurns?: number;
  /** Set to true by the host when the user requested cancellation. */
  isCancelled?: () => boolean;
  /** Returns any pending mid-run user instruction, drained once per turn. */
  getSteeringInstruction?: () => string | undefined;
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
