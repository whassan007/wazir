import path from 'node:path';
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentRunRequest,
  AgentRuntime,
  AgentTurn,
  PermissionOption,
  TerminationReason,
} from '@wazir/core';
import type { EndpointLocality } from '../configurationDiscovery.js';
import { AcpClientAdapter, type AcpClientOptions } from './acpClient.js';
import {
  AcpSessionEventCollector,
  type AcpSessionHandoffMetadata,
  type NormalizedAcpStreamEvent,
} from './acpEventMapper.js';
import {
  checkAcpPrivacyEligibility,
  resolveQwenAcpLaunchArgs,
} from './acpHarnessCapabilities.js';

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
  /** Optional explicit model ID to request when launching the external ACP CLI. */
  modelId?: string;
  /** Optional ACP session ID to resume (`--resume`). */
  resumeSessionId?: string;
  /** Optional pre-classified endpoint locality for FH-A8-02 privacy checks. */
  endpointLocality?: EndpointLocality;
  /** Default wall-clock bound when the request sets none. */
  maxWallClockMs?: number;
  initTimeoutMs?: number;
  /** After a cancel, how long the agent gets to end its turn before the process is killed. */
  cancelGraceMs?: number;
  /** Test seam, passed through to AcpClientAdapter. */
  connect?: AcpClientOptions['connect'];
  /** Optional observer receiving normalized ACP stream events (`thought`, `diff`, `session_handoff`, ...). */
  onAcpStreamEvent?: (event: NormalizedAcpStreamEvent) => void;
}

const DEFAULT_WALL_CLOCK_MS = 30 * 60_000;
const SAFE_CLI_VALUE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,127}$/;

function buildEffectiveLaunchArgs(
  spec: AcpAgentSpec,
  requestedModelId: string | undefined,
  requestedResumeSessionId: string | undefined,
): string[] | undefined {
  const isQwenCommand =
    spec.name === 'qwen-code' ||
    spec.name === 'qwen' ||
    path.basename(spec.command).toLowerCase() === 'qwen';
  const baseArgs = spec.args;

  if (
    isQwenCommand &&
    (baseArgs === undefined || (baseArgs.length === 1 && baseArgs[0] === '--acp'))
  ) {
    return resolveQwenAcpLaunchArgs({
      modelId: requestedModelId,
      resumeSessionId: requestedResumeSessionId,
    });
  }

  if (!baseArgs) {
    const extra: string[] = [];
    if (requestedResumeSessionId && SAFE_CLI_VALUE_PATTERN.test(requestedResumeSessionId)) {
      extra.push('--resume', requestedResumeSessionId);
    }
    return extra.length > 0 ? extra : undefined;
  }

  const nextArgs = [...baseArgs];
  if (
    isQwenCommand &&
    requestedModelId &&
    requestedModelId !== 'external' &&
    requestedModelId !== 'qwen-code-external' &&
    SAFE_CLI_VALUE_PATTERN.test(requestedModelId) &&
    !nextArgs.includes('--model')
  ) {
    nextArgs.push('--model', requestedModelId);
  }
  if (
    requestedResumeSessionId &&
    SAFE_CLI_VALUE_PATTERN.test(requestedResumeSessionId) &&
    !nextArgs.includes('--resume')
  ) {
    nextArgs.push('--resume', requestedResumeSessionId);
  }
  return nextArgs;
}

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
  private latestSessionHandoff?: AcpSessionHandoffMetadata;
  private latestCollector?: AcpSessionEventCollector;

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

  getLastSessionHandoff(): AcpSessionHandoffMetadata | undefined {
    return this.latestSessionHandoff;
  }

  getLastCollector(): AcpSessionEventCollector | undefined {
    return this.latestCollector;
  }

  async *run(request: AgentRunRequest, _runtime: AgentRuntime): AsyncIterable<AgentTurn> {
    const fail = (error: string, terminationReason: TerminationReason, errorKind: AgentTurn['errorKind']): AgentTurn =>
      ({ kind: 'error', error, terminationReason, errorKind });

    const reqAny = request as unknown as Record<string, any>;
    const localOnly = Boolean(
      reqAny.localOnly === true ||
        reqAny.constraints?.localOnly === true ||
        reqAny.routingMode === 'LOCAL_ONLY' ||
        reqAny.executionPreferences?.routingMode === 'LOCAL_ONLY',
    );
    const dataClassification =
      typeof reqAny.dataClassification === 'string'
        ? reqAny.dataClassification
        : typeof reqAny.constraints?.dataClassification === 'string'
          ? reqAny.constraints.dataClassification
          : undefined;

    const privacyEligibility = checkAcpPrivacyEligibility({
      harnessId: this.spec.name,
      localOnly,
      dataClassification,
      env: this.spec.env,
      endpointLocality: reqAny.endpointLocality ?? this.spec.endpointLocality,
    });
    if (!privacyEligibility.allowed) {
      yield fail(
        privacyEligibility.reason ?? `ACP agent '${this.spec.name}' denied by local-only privacy policy`,
        'POLICY_DENIED',
        'policy',
      );
      return;
    }

    const mode = this.spec.permissionMode ?? 'edit';
    const queue: AgentTurn[] = [];
    let wake: (() => void) | undefined;
    const push = (turn: AgentTurn) => {
      queue.push(turn);
      wake?.();
    };

    const requestedResumeSessionId =
      typeof reqAny.resumeSessionId === 'string' && reqAny.resumeSessionId.trim().length > 0
        ? reqAny.resumeSessionId.trim()
        : typeof reqAny.acpSessionId === 'string' && reqAny.acpSessionId.trim().length > 0
          ? reqAny.acpSessionId.trim()
          : this.spec.resumeSessionId;
    const rawReqModelId = typeof request.modelId === 'string' ? request.modelId.trim() : '';
    const requestedModelId =
      rawReqModelId && rawReqModelId !== 'external' && rawReqModelId !== 'qwen-code-external'
        ? rawReqModelId
        : this.spec.modelId;

    const effectiveArgs = buildEffectiveLaunchArgs(
      this.spec,
      requestedModelId,
      requestedResumeSessionId,
    );

    const collector = new AcpSessionEventCollector();
    this.latestCollector = collector;
    let activeSessionId = '';
    const requestEventCallback =
      typeof reqAny.onAcpStreamEvent === 'function'
        ? (reqAny.onAcpStreamEvent as (ev: NormalizedAcpStreamEvent) => void)
        : undefined;

    const emitStreamEvent = (ev: NormalizedAcpStreamEvent) => {
      this.spec.onAcpStreamEvent?.(ev);
      requestEventCallback?.(ev);
    };

    const client = new AcpClientAdapter({
      name: this.spec.name,
      command: this.spec.command,
      args: effectiveArgs,
      env: this.spec.env,
      cwd: request.projectRoot,
      initTimeoutMs: this.spec.initTimeoutMs,
      connect: this.spec.connect,
      onSessionUpdate: (sid, update) => {
        const mapped = collector.ingest(sid || activeSessionId, update);
        if (mapped.handoff) {
          this.latestSessionHandoff = collector.getHandoff();
        }
        for (const ev of mapped.events) {
          emitStreamEvent(ev);
        }
        for (const turn of mapped.turns) {
          push(turn);
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

    try {
      let sessionId: string;
      try {
        await client.ensureConnection();
        sessionId = await client.createSession({ cwd: request.projectRoot });
        activeSessionId = sessionId;
      } catch (error) {
        yield fail(`could not start ACP agent '${this.spec.name}': ${describeAcpError(error)}`,
          'RESOURCE_EXHAUSTED', 'infrastructure');
        return;
      }
      const handoff = collector.recordSessionHandoff({
        acpSessionId: sessionId,
        resumeSessionId: requestedResumeSessionId,
        modelId: requestedModelId,
      });
      this.latestSessionHandoff = handoff;
      emitStreamEvent({ kind: 'session_handoff', acpSessionId: sessionId, handoff });

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
      const answer = collector.getAnswer();
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
