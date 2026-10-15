import type {
  AgentAdapter,
  AgentDescriptor,
  AgentRunRequest,
  AgentRuntime,
  AgentTurn,
  PermissionOption,
  TerminationReason,
} from '@wazir/core';
import { AcpClientAdapter, type AcpClientOptions } from './acpClient.js';

/**
 * What a delegated agent may do without a human:
 * - `read`: read, search, think.
 * - `edit`: also edit, delete and move files (its working directory is the task's project root).
 * - `full`: also run commands, fetch from the network and anything else it asks for.
 * Only one-time grants are ever selected; an "always allow" option is never chosen.
 */
export type AcpPermissionMode = 'read' | 'edit' | 'full';

const ALLOWED_KINDS: Record<AcpPermissionMode, ReadonlySet<string>> = {
  read: new Set(['read', 'search', 'think']),
  edit: new Set(['read', 'search', 'think', 'edit', 'delete', 'move']),
  full: new Set(['read', 'search', 'think', 'edit', 'delete', 'move', 'execute', 'fetch', 'switch_mode', 'other']),
};

export function parseAcpPermissionMode(value: string | undefined): AcpPermissionMode {
  return value === 'read' || value === 'full' ? value : 'edit';
}

/** Decides an ACP permission request under `mode`. Unknown tool kinds are treated as `other`. */
export function decideAcpPermission(
  mode: AcpPermissionMode,
  toolKind: string | undefined,
  options: readonly PermissionOption[],
): { optionId?: string; cancelled?: boolean } {
  const kind = toolKind && ALLOWED_KINDS.full.has(toolKind) ? toolKind : 'other';
  if (!ALLOWED_KINDS[mode].has(kind)) return { cancelled: true };
  const once = options.find((o) => o.kind === 'proceed' && o.escalation === 'once');
  return once ? { optionId: once.optionId } : { cancelled: true };
}

export interface AcpAgentSpec {
  /** Wazir agent name, used with `--agent`. */
  name: string;
  description: string;
  /** Command that starts an ACP server on stdio, e.g. `qwen --acp`. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  capabilities?: string[];
  permissionMode?: AcpPermissionMode;
  /** Default wall-clock bound when the request sets none. */
  maxWallClockMs?: number;
  initTimeoutMs?: number;
  /** After a cancel, how long the agent gets to end its turn before the process is killed. */
  cancelGraceMs?: number;
  /** Test seam, passed through to AcpClientAdapter. */
  connect?: AcpClientOptions['connect'];
}

const DEFAULT_WALL_CLOCK_MS = 30 * 60_000;

/**
 * JSON-RPC errors from an agent carry the useful part in `data` (e.g. Qwen Code reports a
 * failed model call as "Internal error" with data.details "Connection error.").
 */
export function describeAcpError(error: unknown): string {
  if (!(error instanceof Error) && (typeof error !== 'object' || error === null)) return String(error);
  const e = error as { message?: string; data?: unknown };
  const base = e.message ?? String(error);
  const data = e.data as Record<string, unknown> | string | undefined;
  const detail = typeof data === 'string' ? data
    : data && typeof data === 'object' ? String(data.details ?? data.message ?? JSON.stringify(data)) : '';
  return detail && !base.includes(detail) ? `${base}: ${detail.slice(0, 500)}` : base;
}

/**
 * Runs a Wazir task through an external agent speaking the Agent Client Protocol (Claude Code,
 * Codex, Qwen Code, Gemini CLI, ...). One task is one ACP session and one prompt turn. Wazir stays
 * the control plane: it chooses the agent, answers every permission request under
 * `permissionMode`, enforces cancellation and the wall-clock bound, and always shuts the agent down.
 */
export class AcpAgentAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor;

  constructor(private readonly spec: AcpAgentSpec) {
    this.descriptor = {
      name: spec.name,
      version: 'acp',
      description: spec.description,
      capabilities: spec.capabilities ?? ['coding'],
      requiredTools: [],
      modelRequirements: { capabilities: [] },
      permissions: [],
      // Never auto-selected: an installed CLI must not silently change where tasks run.
      taskTypes: [],
      strategy: 'external',
    };
  }

  async *run(request: AgentRunRequest, _runtime: AgentRuntime): AsyncIterable<AgentTurn> {
    const mode = this.spec.permissionMode ?? 'edit';
    const queue: AgentTurn[] = [];
    let wake: (() => void) | undefined;
    const push = (turn: AgentTurn) => {
      queue.push(turn);
      wake?.();
    };
    let answer = '';
    const toolCalls = new Map<string, { title: string; startedAt?: number; terminal: boolean; emitted: boolean }>();

    const client = new AcpClientAdapter({
      name: this.spec.name,
      command: this.spec.command,
      args: this.spec.args,
      env: this.spec.env,
      cwd: request.projectRoot,
      initTimeoutMs: this.spec.initTimeoutMs,
      connect: this.spec.connect,
      onSessionUpdate: (_sessionId, update) => {
        const u = update as Record<string, any>;
        switch (u.sessionUpdate) {
          case 'agent_message_chunk':
          case 'agent_message':
            if (u.content?.type === 'text' && typeof u.content.text === 'string') answer += u.content.text;
            break;
          case 'tool_call': {
            const title = String(u.title ?? u.toolCallId ?? 'tool');
            if (u.toolCallId) {
              const id = String(u.toolCallId);
              const prior = toolCalls.get(id);
              if (prior) { prior.title = title; break; }
              toolCalls.set(id, { title, startedAt: Date.now(), terminal: false, emitted: true });
            }
            push({ kind: 'tool_call', tool: String(u.kind ?? 'other'), toolInput: { ...(u.toolCallId ? { callId: String(u.toolCallId) } : {}), title, ...(u.rawInput ? { input: u.rawInput } : {}) } });
            break;
          }
          case 'tool_call_update':
            if (['completed', 'failed', 'cancelled'].includes(String(u.status))) {
              const id = String(u.toolCallId ?? '');
              const prior = toolCalls.get(id);
              if (!prior?.terminal) {
                if (prior) prior.terminal = true;
                const title = String(u.title ?? prior?.title ?? id ?? 'tool');
                if (!prior?.emitted) push({ kind: 'tool_call', tool: String(u.kind ?? 'other'), toolInput: { ...(id ? { callId: id } : {}), title, ...(u.rawInput ? { input: u.rawInput } : {}) } });
                const content = Array.isArray(u.content) ? u.content.map((item: any) => item?.type === 'content' && item.content?.type === 'text' ? item.content.text : item?.type === 'text' ? item.text : '').filter(Boolean).join('\n') : '';
                const output = typeof u.rawOutput === 'string' ? u.rawOutput : content;
                const durationMs = prior?.startedAt === undefined ? 0 : Math.max(0, Date.now() - prior.startedAt);
                const status = String(u.status);
                push({ kind: 'tool_result', tool: title, toolResult: { ok: status === 'completed', output, durationMs, metadata: { acpToolCallId: id || undefined, acpStatus: status, durationMs: prior?.startedAt === undefined ? null : durationMs, ...(u.rawOutput !== undefined ? { rawOutput: u.rawOutput } : {}) }, ...(['failed', 'cancelled'].includes(status) ? { error: `ACP tool reported ${status}` } : {}) } });
              }
            }
            break;
          case 'plan':
            if (Array.isArray(u.entries)) {
              push({ kind: 'message', content: `Plan:\n${u.entries.map((e: any) => `- [${e.status ?? 'pending'}] ${e.content ?? ''}`).join('\n')}` });
            }
            break;
          default:
            break;
        }
      },
      onRequestPermission: async (req) => {
        const decision = decideAcpPermission(mode, req.toolKind, req.options);
        push({
          kind: 'message',
          content: `permission ${decision.optionId ? 'granted' : 'denied'} (mode=${mode}): ${req.toolKind ?? 'other'}: ${req.title}`,
        });
        return decision;
      },
    });

    const fail = (error: string, terminationReason: TerminationReason, errorKind: AgentTurn['errorKind']): AgentTurn =>
      ({ kind: 'error', error, terminationReason, errorKind });

    try {
      let sessionId: string;
      try {
        await client.ensureConnection();
        sessionId = await client.createSession({ cwd: request.projectRoot });
      } catch (error) {
        yield fail(`could not start ACP agent '${this.spec.name}': ${describeAcpError(error)}`,
          'RESOURCE_EXHAUSTED', 'infrastructure');
        return;
      }
      yield { kind: 'message', content: `delegated to ${this.spec.name} over ACP (session ${sessionId}, permissions=${mode})` };

      let settled: { stopReason: string } | { error: unknown } | undefined;
      client.runTurn(sessionId, request.taskDescription).then(
        (r) => { settled = r; wake?.(); },
        (error) => { settled = { error }; wake?.(); },
      );

      const deadline = Date.now() + (request.maxWallClockMs ?? this.spec.maxWallClockMs ?? DEFAULT_WALL_CLOCK_MS);
      const grace = this.spec.cancelGraceMs ?? 10_000;
      let stopRequested: { reason: 'cancelled' | 'timeout'; at: number } | undefined;
      while (!settled) {
        while (queue.length) yield queue.shift()!;
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 250);
        });
        wake = undefined;
        if (!stopRequested && (request.isCancelled?.() || Date.now() >= deadline)) {
          stopRequested = { reason: request.isCancelled?.() ? 'cancelled' : 'timeout', at: Date.now() };
          void client.cancelSession(sessionId).catch(() => undefined);
        }
        // An agent that ignores session/cancel is killed by close() below.
        if (stopRequested && Date.now() - stopRequested.at > grace) break;
      }
      while (queue.length) yield queue.shift()!;

      if (stopRequested?.reason === 'cancelled') {
        yield fail('cancelled', 'CANCELLED', 'cancelled');
        return;
      }
      if (stopRequested?.reason === 'timeout') {
        yield fail(`ACP agent '${this.spec.name}' exceeded its wall-clock bound`, 'MAX_WALL_CLOCK', 'other');
        return;
      }
      if (!settled) return; // unreachable: the loop only exits early after a stop request
      if ('error' in settled) {
        const message = describeAcpError(settled.error);
        yield fail(`ACP agent '${this.spec.name}' failed: ${message}`, 'RESOURCE_EXHAUSTED', 'infrastructure');
        return;
      }
      switch (settled.stopReason) {
        case 'end_turn':
          yield { kind: 'done', content: answer.trim() || `ACP agent '${this.spec.name}' completed`, terminationReason: 'COMPLETED' };
          return;
        case 'cancelled':
          yield fail('cancelled', 'CANCELLED', 'cancelled');
          return;
        case 'refusal':
          yield fail(`ACP agent '${this.spec.name}' refused the task`, 'POLICY_DENIED', 'policy');
          return;
        case 'max_tokens':
          yield fail(`ACP agent '${this.spec.name}' hit its token limit`, 'MAX_TOKENS', 'other');
          return;
        case 'max_turn_requests':
          yield fail(`ACP agent '${this.spec.name}' hit its turn limit`, 'MAX_TURNS', 'other');
          return;
        default:
          yield fail(`ACP agent '${this.spec.name}' stopped: ${settled.stopReason}`, 'RESOURCE_EXHAUSTED', 'other');
      }
    } finally {
      await client.close();
    }
  }
}
