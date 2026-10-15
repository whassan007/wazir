/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted for Wazir.
 */

import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { Readable, Writable } from 'node:stream';
import { spawnGroupWatchdog } from '../processWatchdog.js';
import {
  killProcessTree,
  terminateProcessTree,
  getSpawnCommand,
  sanitizeChildEnvironment,
  classifyOption,
  redactPermissionText,
  type PermissionOption,
  type SubagentActivity,
} from '@wazir/core';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from '@agentclientprotocol/sdk';

export const ACP_INIT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const MAX_PENDING_PROMPTS = 8;

export type AcpSessionStatus = 'idle' | 'generating' | 'tool' | 'permission' | 'completed' | 'cancelled' | 'disconnected' | 'failed';
export interface AcpSessionMessage {
  sequence: number;
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'permission' | 'status';
  text: string;
  status: 'queued' | 'sent' | 'completed' | 'failed';
  at: number;
}
export interface AcpSessionCapabilities {
  loadSession: boolean;
  availableModes: Array<{ id: string; name: string }>;
  currentModeId?: string;
  steering: 'queued_follow_up';
}
export interface AcpToolTelemetry {
  toolCallId: string;
  kind?: string;
  title?: string;
  status?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs: number | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  permissionDecision?: 'granted' | 'denied';
}

export interface AcpConnectionLike {
  initialize(params: Record<string, unknown>): Promise<Record<string, any>>;
  authenticate?(params: Record<string, unknown>): Promise<unknown>;
  newSession(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  loadSession?(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  prompt(params: Record<string, unknown>): Promise<{ stopReason?: string }>;
  cancel(params: Record<string, unknown>): Promise<void>;
  setSessionMode?(params: Record<string, unknown>): Promise<unknown>;
  extMethod?(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface AcpClientOptions {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  sessionMode?: string;
  /** Test seam: inject custom connection instead of spawning stdio process */
  connect?: (
    client: Client,
    onExit: (info: { code: number | null; signal: string | null }) => void,
  ) => Promise<AcpConnectionLike>;
  onActivity?: (activity: SubagentActivity) => void;
  /** Raw ACP `session/update` payloads (the `update` object), for adapters that map them. */
  onSessionUpdate?: (sessionId: string, update: Record<string, unknown>) => void;
  onTimelineEvent?: (sessionId: string, event: AcpSessionMessage) => void;
  onToolTelemetry?: (sessionId: string, tool: AcpToolTelemetry) => void;
  /** Bound for spawn + `initialize`; an `npx`-launched bridge may need to download first. */
  initTimeoutMs?: number;
  onRequestPermission?: (request: {
    requestId: string;
    sessionId: string;
    title: string;
    /** ACP tool kind of the call asking for permission (read, edit, execute, fetch, ...). */
    toolKind?: string;
    options: PermissionOption[];
  }) => Promise<{ optionId?: string; cancelled?: boolean }>;
}

export interface AcpSessionState {
  sessionId: string;
  generation: number;
  closed: boolean;
  busy: boolean;
  activeJobRef?: string;
  pendingPrompts: Array<{ jobRef: string; text: string }>;
  cwd?: string;
  status: AcpSessionStatus;
  sequence: number;
  messages: AcpSessionMessage[];
  tools: Map<string, AcpToolTelemetry>;
  capabilities: AcpSessionCapabilities;
}

export class AcpClientAdapter {
  readonly name: string;
  private readonly options: AcpClientOptions;
  private readonly sessions = new Map<string, AcpSessionState>();
  private connection?: AcpConnectionLike;
  private child?: ChildProcess;
  private generation = 0;
  private turnSeq = 0;
  private closing = false;
  private detached = false;
  /** Auth method ids the agent advertised in `initialize`. */
  private authMethodIds: string[] = [];
  private agentCapabilities: Record<string, any> = {};
  private stderrTail = '';

  /** Last ~4 KB of the agent's stderr, for diagnosing startup or protocol failures. */
  get stderr(): string {
    return this.stderrTail;
  }

  private signal(child: ChildProcess, sig: NodeJS.Signals): void {
    killProcessTree(child.pid, sig, this.detached);
  }

  constructor(options: AcpClientOptions) {
    this.name = options.name;
    this.options = options;
  }

  async ensureConnection(): Promise<AcpConnectionLike> {
    if (this.connection) return this.connection;

    if (this.options.connect) {
      this.generation += 1;
      const client = this.buildClient();
      this.agentCapabilities = { loadSession: false };
      this.connection = await this.options.connect(client, () => {
        this.handleProcessExit();
      });
      // Injected connections intentionally advertise no optional capabilities unless the test
      // or embedding caller exposes them on the returned initialize result by other means.
      return this.connection;
    }

    this.generation += 1;
    // Own process group: an `npx`-launched bridge runs the real agent as a grandchild,
    // which a signal to the direct child alone would orphan. stderr is captured (bounded)
    // rather than inherited so agent logs never corrupt the host terminal or TUI.
    const detached = process.platform !== 'win32';
    const spawnCmd = getSpawnCommand(this.options.command, this.options.args ?? [], { cwd: this.options.cwd });
    const child = spawn(spawnCmd.command, spawnCmd.args, {
      cwd: this.options.cwd,
      env: sanitizeChildEnvironment(this.options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached,
      // cross-spawn escapes Windows wrappers itself; shell:true would bypass its escaping.
    });
    this.detached = detached;
    // If Wazir itself dies, the agent and any commands it started must not keep running.
    // The watchdog exits by itself once the whole group is gone.
    if (detached && child.pid !== undefined) spawnGroupWatchdog(process.pid, child.pid);
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4_000);
    });

    this.child = child;

    child.on('exit', () => {
      this.handleProcessExit();
    });
    // Without a listener a spawn failure (e.g. ENOENT) is an uncaught 'error' event.
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once('error', (error) => {
        this.handleProcessExit();
        reject(error);
      });
    });
    spawnFailed.catch(() => undefined);

    const client = this.buildClient();
    if (!child.stdin || !child.stdout) {
      throw new Error(`Failed to initialize stdio for ACP agent '${this.name}'`);
    }

    const stdout = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stdin = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
    const stream = ndJsonStream(stdin, stdout);
    const conn = new ClientSideConnection(() => client, stream);

    let initTimer: NodeJS.Timeout | undefined;
    try {
      const init = await Promise.race([
        conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: 'wazir',
            version: '0.1.55',
          },
        }),
        spawnFailed,
        new Promise<never>((_, reject) => {
          initTimer = setTimeout(
            () => reject(new Error(`ACP agent '${this.name}' did not initialize within ${this.options.initTimeoutMs ?? ACP_INIT_TIMEOUT_MS}ms`)),
            this.options.initTimeoutMs ?? ACP_INIT_TIMEOUT_MS,
          );
        }),
      ]);
      const methods = (init as { authMethods?: Array<{ id?: unknown }> } | undefined)?.authMethods;
      this.authMethodIds = Array.isArray(methods) ? methods.map((m) => String(m?.id ?? '')).filter(Boolean) : [];
      this.agentCapabilities = (init as { agentCapabilities?: Record<string, any> } | undefined)?.agentCapabilities ?? {};
    } catch (error) {
      this.signal(child, 'SIGKILL');
      this.handleProcessExit();
      const tail = this.stderrTail.trim().split('\n').slice(-5).join('\n');
      if (tail && error instanceof Error) error.message += `\n[agent stderr]\n${redactPermissionText(tail)}`;
      throw error;
    } finally {
      clearTimeout(initTimer);
    }

    this.connection = conn as unknown as AcpConnectionLike;
    return this.connection;
  }

  async createSession(opts?: { cwd?: string }): Promise<string> {
    const conn = await this.ensureConnection();
    const cwd = opts?.cwd ?? this.options.cwd ?? process.cwd();

    let response: Record<string, unknown>;
    try {
      response = await conn.newSession({ cwd, mcpServers: [] });
    } catch (err) {
      // Retry after authenticating only with a method the agent advertised, and only when it
      // offers exactly one: guessing an id (the old 'default') replaced the real failure with
      // "Method not implemented". Anything else surfaces the original error with stderr.
      if (conn.authenticate && this.authMethodIds.length === 1) {
        await conn.authenticate({ methodId: this.authMethodIds[0] });
        response = await conn.newSession({ cwd, mcpServers: [] });
      } else {
        const tail = this.stderrTail.trim().split('\n').slice(-5).join('\n');
        if (tail && err instanceof Error && !err.message.includes('[agent stderr]')) {
          err.message += `\n[agent stderr]\n${redactPermissionText(tail)}`;
        }
        throw err;
      }
    }

    const sessionId = String(response.sessionId ?? '');
    if (!sessionId) {
      throw new Error(`ACP backend '${this.name}' returned invalid sessionId`);
    }

    const modes = (response.modes as { availableModes?: Array<{ id: string; name: string }>; currentModeId?: string } | undefined);
    const state: AcpSessionState = {
      sessionId,
      generation: this.generation,
      closed: false,
      busy: false,
      pendingPrompts: [],
      cwd,
      status: 'idle', sequence: 0, messages: [], tools: new Map(),
      capabilities: { loadSession: Boolean(this.agentCapabilities.loadSession), availableModes: (modes?.availableModes ?? []).map((m) => ({ id: String(m.id), name: String(m.name) })), currentModeId: modes?.currentModeId, steering: 'queued_follow_up' },
    };
    this.sessions.set(sessionId, state);
    return sessionId;
  }

  /** Loads an existing ACP session only when the agent advertised loadSession. */
  async loadSession(sessionId: string, opts?: { cwd?: string }): Promise<AcpSessionState> {
    const conn = await this.ensureConnection();
    const cwd = opts?.cwd ?? this.options.cwd ?? process.cwd();
    if (!this.agentCapabilities.loadSession || !conn.loadSession) throw new Error(`ACP agent '${this.name}' does not support session/load`);
    const response = await conn.loadSession({ sessionId, cwd, mcpServers: [] });
    const modes = (response.modes as { availableModes?: Array<{ id: string; name: string }>; currentModeId?: string } | undefined);
    const state: AcpSessionState = {
      sessionId, generation: this.generation, closed: false, busy: false, pendingPrompts: [], cwd,
      status: 'idle', sequence: 0, messages: [], tools: new Map(),
      capabilities: { loadSession: true, availableModes: (modes?.availableModes ?? []).map((m) => ({ id: String(m.id), name: String(m.name) })), currentModeId: modes?.currentModeId, steering: 'queued_follow_up' },
    };
    this.sessions.set(sessionId, state);
    return this.getSessionState(sessionId)!;
  }

  getSessionState(sessionId: string): AcpSessionState | undefined {
    const state = this.sessions.get(sessionId);
    return state ? { ...state, messages: state.messages.map((m) => ({ ...m })), tools: new Map([...state.tools].map(([id, tool]) => [id, { ...tool }])) } : undefined;
  }

  private record(state: AcpSessionState, kind: AcpSessionMessage['kind'], text: string, status: AcpSessionMessage['status'], id?: string): void {
    const event = { sequence: ++state.sequence, id: id ?? `${state.sessionId}:${state.sequence}`, kind, text: text.slice(0, 4_000), status, at: Date.now() };
    state.messages.push(event);
    this.options.onTimelineEvent?.(state.sessionId, event);
  }

  async prompt(sessionId: string, promptText: string): Promise<{ jobRef: string; status: 'accepted' | 'queued' }> {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed || state.generation !== this.generation) {
      throw new Error(`Session ${sessionId} is closed or invalidated`);
    }
    if (state.status === 'cancelled' || state.status === 'disconnected' || state.status === 'failed') {
      throw new Error(`Session ${sessionId} cannot accept a prompt while ${state.status}`);
    }

    this.turnSeq += 1;
    const jobRef = `turn-${this.turnSeq}`;

    if (!state.busy) {
      this.startTurn(state, jobRef, promptText);
      return { jobRef, status: 'accepted' };
    }

    if (state.pendingPrompts.length >= MAX_PENDING_PROMPTS) {
      throw new Error(`Session ${sessionId} queue is full (max ${MAX_PENDING_PROMPTS})`);
    }

    state.pendingPrompts.push({ jobRef, text: promptText });
    this.record(state, 'user', promptText, 'queued', jobRef);
    return { jobRef, status: 'queued' };
  }

  /** An active turn cannot be interrupted through stable ACP; steering is a queued follow-up. */
  steer(sessionId: string, instruction: string): Promise<{ jobRef: string; status: 'accepted' | 'queued' }> {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed) throw new Error(`Session ${sessionId} is closed or invalidated`);
    if (state.status === 'disconnected' || state.status === 'failed' || state.status === 'cancelled') throw new Error(`Session ${sessionId} cannot accept steering while ${state.status}`);
    return this.prompt(sessionId, instruction);
  }

  /**
   * Runs one prompt turn and resolves when the agent ends it, with the ACP stop reason
   * (end_turn, max_tokens, max_turn_requests, refusal, cancelled). Rejects if the
   * connection fails or the agent process exits mid-turn.
   */
  async runTurn(sessionId: string, promptText: string): Promise<{ stopReason: string }> {
    const state = this.sessions.get(sessionId);
    const conn = this.connection;
    if (!state || state.closed || !conn || state.generation !== this.generation) {
      throw new Error(`Session ${sessionId} is closed or invalidated`);
    }
    if (state.busy) throw new Error(`Session ${sessionId} already has an active turn`);
    state.busy = true;
    state.status = 'generating';
    this.record(state, 'user', promptText, 'sent');
    try {
      const exited = new Promise<never>((_, reject) => {
        this.child?.once('exit', (code, signal) => reject(new Error(
          `ACP agent '${this.name}' exited during the turn (${signal ?? `code ${code}`})` +
          (this.stderrTail.trim() ? `\n[agent stderr]\n${redactPermissionText(this.stderrTail.trim().split('\n').slice(-5).join('\n'))}` : ''),
        )));
      });
      exited.catch(() => undefined);
      const response = await Promise.race([conn.prompt({ sessionId, prompt: [{ type: 'text', text: promptText }] }), exited]);
      return { stopReason: String(response?.stopReason ?? 'end_turn') };
    } catch (error) {
      state.status = 'failed';
      throw error;
    } finally {
      state.busy = false;
      if (state.status === 'generating') state.status = 'idle';
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || !this.connection) return;
    state.status = 'cancelled';
    for (const pending of state.pendingPrompts.splice(0)) this.record(state, 'user', pending.text, 'failed', pending.jobRef);
    for (const event of state.messages) {
      if (event.kind === 'user' && event.status === 'queued') event.status = 'failed';
    }
    await this.connection.cancel({ sessionId });
    state.busy = false;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const state of this.sessions.values()) {
      state.closed = true;
    }

    const child = this.child;
    this.connection = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      await terminateProcessTree(child, {
        graceMs: KILL_GRACE_MS,
        wasDetached: this.detached,
      });
    }
  }

  /** Runs a turn in the background; a failed turn is reported as activity, never an unhandled rejection. */
  private startTurn(state: AcpSessionState, jobRef: string, text: string): void {
    this.sendPromptNow(state, jobRef, text).catch((error: unknown) => {
      this.options.onActivity?.({
        at: Date.now(),
        kind: 'status',
        text: `Turn failed (${jobRef}): ${redactPermissionText(error instanceof Error ? error.message : String(error)).slice(0, 500)}`,
      });
    });
  }

  private async sendPromptNow(state: AcpSessionState, jobRef: string, text: string): Promise<void> {
    const conn = this.connection;
    if (!conn || state.closed || state.generation !== this.generation) return;

    if (state.busy) {
      throw new Error('sendPromptNow called while a turn is already active');
    }

    state.busy = true;
    state.activeJobRef = jobRef;
    state.status = 'generating';
    this.record(state, 'user', text, 'sent', jobRef);

    this.options.onActivity?.({
      at: Date.now(),
      kind: 'message',
      text: `Turn started (${jobRef}): ${text.slice(0, 120)}`,
    });

    try {
      const response = await conn.prompt({
        sessionId: state.sessionId,
        prompt: [{ type: 'text', text }],
      });

      this.options.onActivity?.({
        at: Date.now(),
        kind: 'status',
        text: `Turn ended (${jobRef}): ${response?.stopReason ?? 'completed'}`,
      });
      state.status = response?.stopReason === 'cancelled' ? 'cancelled' : 'completed';
      this.record(state, 'status', `Turn ended: ${response?.stopReason ?? 'completed'}`, 'completed', jobRef);
    } catch (error) {
      state.status = 'failed';
      this.record(state, 'status', `Turn failed: ${redactPermissionText(error instanceof Error ? error.message : String(error))}`, 'failed', jobRef);
      throw error;
    } finally {
      state.busy = false;
      state.activeJobRef = undefined;

      // Drain next pending prompt if queued
      const next = state.pendingPrompts.shift();
      if (next && !state.closed && !['cancelled', 'disconnected', 'failed'].includes(state.status)) {
        this.startTurn(state, next.jobRef, next.text);
      } else if (next) {
        this.record(state, 'user', next.text, 'failed', next.jobRef);
        for (const pending of state.pendingPrompts.splice(0)) this.record(state, 'user', pending.text, 'failed', pending.jobRef);
      }
    }
  }

  private buildClient(): Client {
    return {
      sessionUpdate: async (params: any) => {
        const update = params?.update as Record<string, any> | undefined;
        if (!update || typeof update !== 'object') return;
        this.options.onSessionUpdate?.(String(params.sessionId ?? ''), update);
        const state = this.sessions.get(String(params.sessionId ?? ''));
        if (state) this.recordSessionUpdate(state, update);
        const activity = describeSessionUpdate(update);
        if (activity) this.options.onActivity?.({ at: Date.now(), ...activity });
      },
      requestPermission: async (params: Record<string, unknown>) => {
        const optionsList: PermissionOption[] = Array.isArray(params.options)
          ? params.options.filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null).map(classifyOption)
          : [];

        const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
        const title = redactPermissionText(String(toolCall.title ?? params.title ?? 'Permission requested'));
        let toolKind = typeof toolCall.kind === 'string' ? toolCall.kind
          : typeof params.toolKind === 'string' ? params.toolKind
          : typeof params.kind === 'string' ? params.kind : undefined;

        if (!toolKind) {
          const lowerTitle = title.toLowerCase();
          const toolName = String(toolCall.name ?? toolCall.tool ?? '').toLowerCase();
          if (/^edit|^write|^modify|^create|^delete|^move|^rename|edit_file|write_file|str_replace/i.test(lowerTitle) || /edit|write|replace|modify/i.test(toolName)) {
            toolKind = 'edit';
          } else if (/^read|^search|^find|^view|^inspect|read_file|grep|glob/i.test(lowerTitle) || /read|view|search/i.test(toolName)) {
            toolKind = 'read';
          } else if (/^run|^exec|^bash|^terminal|^sh|command/i.test(lowerTitle) || /bash|terminal|exec|run/i.test(toolName)) {
            toolKind = 'execute';
          } else if (/^fetch|^http|^curl|^download|^web/i.test(lowerTitle) || /fetch|http|web/i.test(toolName)) {
            toolKind = 'fetch';
          }
        }

        const requestId = String(params.requestId ?? `req-${Date.now()}`);
        const sessionId = String(params.sessionId ?? '');

        // Fail closed: approval needs an explicit operator decision naming an offered
        // option. No resolver, no decision, a resolver error, or an unknown optionId
        // all deny — a delegated agent must never be approved by default.
        const deny = { outcome: { outcome: 'cancelled' as const } };
        const state = this.sessions.get(sessionId);
        if (!this.options.onRequestPermission) {
          if (state) this.record(state, 'permission', `${toolKind ?? 'other'}: ${title}`, 'failed', requestId);
          return deny;
        }
        if (state) state.status = 'permission';
        let decision: { optionId?: string; cancelled?: boolean };
        try {
          decision = await this.options.onRequestPermission({
            requestId,
            sessionId,
            title,
            toolKind,
            options: optionsList,
          });
        } catch {
          if (state) this.record(state, 'permission', `${toolKind ?? 'other'}: ${title}`, 'failed', requestId);
          return deny;
        }
        if (decision.cancelled || !decision.optionId || !optionsList.some((o) => o.optionId === decision.optionId)) {
          if (state) this.record(state, 'permission', `${toolKind ?? 'other'}: ${title}`, 'failed', requestId);
          return deny;
        }
        if (state) {
          state.status = 'tool';
          this.record(state, 'permission', `${toolKind ?? 'other'}: ${title}`, 'completed', requestId);
        }
        return { outcome: { outcome: 'selected', optionId: decision.optionId } };
      },
    };
  }

  private handleProcessExit(): void {
    this.connection = undefined;
    this.child = undefined;
    for (const state of this.sessions.values()) {
      state.closed = true;
      state.busy = false;
      state.status = 'disconnected';
    }
  }

  private recordSessionUpdate(state: AcpSessionState, update: Record<string, any>): void {
    if (update.sessionUpdate === 'agent_message' || update.sessionUpdate === 'agent_message_chunk') {
      const text = update.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : '';
      if (text) this.record(state, 'assistant', text, 'completed');
    }
    if (update.sessionUpdate === 'tool_call') {
      const id = String(update.toolCallId ?? '');
      if (!id) return;
      const existing = state.tools.get(id);
      const tool = { ...existing, toolCallId: id, kind: update.kind ?? existing?.kind, title: update.title ?? existing?.title, status: update.status ?? existing?.status, startedAt: existing?.startedAt ?? Date.now(), durationMs: null, rawInput: update.rawInput ?? existing?.rawInput };
      state.tools.set(id, tool);
      state.status = 'tool';
      this.options.onToolTelemetry?.(state.sessionId, { ...tool });
      this.record(state, 'tool', tool.title ?? id, 'sent', id);
    } else if (update.sessionUpdate === 'tool_call_update') {
      const id = String(update.toolCallId ?? '');
      if (!id) return;
      const existing = state.tools.get(id) ?? { toolCallId: id, durationMs: null };
      const isTerminal = ['completed', 'failed', 'cancelled'].includes(String(update.status));
      const completedAt = isTerminal ? existing.completedAt ?? Date.now() : existing.completedAt;
      const durationMs = existing.startedAt !== undefined && completedAt !== undefined ? Math.max(0, completedAt - existing.startedAt) : null;
      const tool = { ...existing, kind: update.kind ?? existing.kind, title: update.title ?? existing.title, status: update.status ?? existing.status, rawInput: update.rawInput ?? existing.rawInput, rawOutput: update.rawOutput ?? existing.rawOutput, completedAt, durationMs };
      state.tools.set(id, tool);
      if (isTerminal && !existing.completedAt) this.record(state, 'tool', `${tool.title ?? id}: ${String(update.status)}`, update.status === 'failed' ? 'failed' : 'completed', id);
      this.options.onToolTelemetry?.(state.sessionId, { ...tool });
    }
  }
}

/**
 * Human-readable summary of an ACP `session/update`, or undefined for updates that carry
 * nothing useful to show. Agent thoughts are deliberately not surfaced (they are not
 * answers, and other runtimes keep reasoning out of user-visible output too).
 */
export function describeSessionUpdate(update: Record<string, any>): Pick<SubagentActivity, 'kind' | 'text'> | undefined {
  const textOf = (content: any): string => (content?.type === 'text' && typeof content.text === 'string' ? content.text : '');
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_message': {
      const text = textOf(update.content);
      return text ? { kind: 'message', text: text.slice(0, 2_000) } : undefined;
    }
    case 'tool_call':
      return { kind: 'tool', text: `${update.kind ?? 'tool'}: ${String(update.title ?? update.toolCallId ?? '').slice(0, 300)}` };
    case 'tool_call_update':
      return update.status === 'completed' || update.status === 'failed'
        ? { kind: 'observation', text: `${String(update.title ?? update.toolCallId ?? 'tool')}: ${update.status}`.slice(0, 300) }
        : undefined;
    case 'plan':
      return Array.isArray(update.entries)
        ? { kind: 'plan', text: update.entries.map((e: any) => `[${e.status ?? 'pending'}] ${e.content ?? ''}`).join('\n').slice(0, 2_000) }
        : undefined;
    default:
      return undefined;
  }
}
