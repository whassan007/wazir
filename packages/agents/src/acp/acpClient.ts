/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted for Wazir.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { spawnGroupWatchdog } from '../processWatchdog.js';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from '@agentclientprotocol/sdk';
import {
  classifyOption,
  redactPermissionText,
  type PermissionOption,
  type SubagentActivity,
} from '@wazir/core';

export const ACP_INIT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const MAX_PENDING_PROMPTS = 8;

export interface AcpConnectionLike {
  initialize(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  authenticate?(params: Record<string, unknown>): Promise<unknown>;
  newSession(params: Record<string, unknown>): Promise<Record<string, unknown>>;
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
  private stderrTail = '';

  /** Last ~4 KB of the agent's stderr, for diagnosing startup or protocol failures. */
  get stderr(): string {
    return this.stderrTail;
  }

  private signal(child: ChildProcess, sig: NodeJS.Signals): void {
    try {
      if (this.detached && child.pid !== undefined) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try { child.kill(sig); } catch { /* already gone */ }
    }
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
      this.connection = await this.options.connect(client, () => {
        this.handleProcessExit();
      });
      return this.connection;
    }

    this.generation += 1;
    // Own process group: an `npx`-launched bridge runs the real agent as a grandchild,
    // which a signal to the direct child alone would orphan. stderr is captured (bounded)
    // rather than inherited so agent logs never corrupt the host terminal or TUI.
    const detached = process.platform !== 'win32';
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached,
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

    const state: AcpSessionState = {
      sessionId,
      generation: this.generation,
      closed: false,
      busy: false,
      pendingPrompts: [],
      cwd,
    };
    this.sessions.set(sessionId, state);
    return sessionId;
  }

  async prompt(sessionId: string, promptText: string): Promise<{ jobRef: string; status: 'accepted' | 'queued' }> {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed || state.generation !== this.generation) {
      throw new Error(`Session ${sessionId} is closed or invalidated`);
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
    return { jobRef, status: 'queued' };
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
    } finally {
      state.busy = false;
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || !this.connection) return;
    await this.connection.cancel({ sessionId });
    state.busy = false;
    state.pendingPrompts = [];
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const state of this.sessions.values()) {
      state.closed = true;
    }

    const child = this.child;
    this.connection = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(escalate);
          clearTimeout(deadline);
          resolve();
        };
        const escalate = setTimeout(() => {
          this.signal(child, 'SIGKILL');
        }, KILL_GRACE_MS);
        const deadline = setTimeout(finish, KILL_GRACE_MS * 2);
        child.once('exit', finish);
        this.signal(child, 'SIGTERM');
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
    } finally {
      state.busy = false;
      state.activeJobRef = undefined;

      // Drain next pending prompt if queued
      const next = state.pendingPrompts.shift();
      if (next && !state.closed) {
        this.startTurn(state, next.jobRef, next.text);
      }
    }
  }

  private buildClient(): Client {
    return {
      sessionUpdate: async (params: any) => {
        const update = params?.update as Record<string, any> | undefined;
        if (!update || typeof update !== 'object') return;
        this.options.onSessionUpdate?.(String(params.sessionId ?? ''), update);
        const activity = describeSessionUpdate(update);
        if (activity) this.options.onActivity?.({ at: Date.now(), ...activity });
      },
      requestPermission: async (params: Record<string, unknown>) => {
        const optionsList = Array.isArray(params.options)
          ? params.options.filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null).map(classifyOption)
          : [];

        const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
        const title = redactPermissionText(String(toolCall.title ?? params.title ?? 'Permission requested'));
        const toolKind = typeof toolCall.kind === 'string' ? toolCall.kind : undefined;
        const requestId = String(params.requestId ?? `req-${Date.now()}`);
        const sessionId = String(params.sessionId ?? '');

        // Fail closed: approval needs an explicit operator decision naming an offered
        // option. No resolver, no decision, a resolver error, or an unknown optionId
        // all deny — a delegated agent must never be approved by default.
        const deny = { outcome: { outcome: 'cancelled' as const } };
        if (!this.options.onRequestPermission) return deny;
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
          return deny;
        }
        if (decision.cancelled || !decision.optionId) return deny;
        if (!optionsList.some((o) => o.optionId === decision.optionId)) return deny;
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
