/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted for Wazir.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
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
  onRequestPermission?: (request: {
    requestId: string;
    sessionId: string;
    title: string;
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
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'inherit'],
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
      await Promise.race([
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
            () => reject(new Error(`ACP agent '${this.name}' did not initialize within ${ACP_INIT_TIMEOUT_MS}ms`)),
            ACP_INIT_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      this.handleProcessExit();
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
      if (conn.authenticate) {
        await conn.authenticate({ methodId: 'default' });
        response = await conn.newSession({ cwd, mcpServers: [] });
      } else {
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
          try {
            child.kill('SIGKILL');
          } catch {
            finish();
          }
        }, KILL_GRACE_MS);
        const deadline = setTimeout(finish, KILL_GRACE_MS * 2);
        child.once('exit', finish);
        try {
          child.kill('SIGTERM');
        } catch {
          finish();
        }
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
        const text = String(params.update ?? params.text ?? JSON.stringify(params));
        this.options.onActivity?.({
          at: Date.now(),
          kind: 'tool',
          text: text.slice(0, 500),
        });
      },
      requestPermission: async (params: Record<string, unknown>) => {
        const optionsList = Array.isArray(params.options)
          ? params.options.filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null).map(classifyOption)
          : [];

        const title = redactPermissionText(String(params.title ?? 'Permission requested'));
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
