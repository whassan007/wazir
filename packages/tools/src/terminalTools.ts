import type { Tool, ToolResult } from '@wazir/core';
import { TerminalSession, type ReadinessTier } from './terminalSession.js';

const sessions = new Map<string, TerminalSession>();

function getSession(sessionId: string): TerminalSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`No open terminal session '${sessionId}'`);
  return session;
}

function readinessNote(readiness: ReadinessTier): string {
  switch (readiness) {
    case 'PROMPT_MARKER': return 'confirmed: shell returned to its prompt';
    case 'STDIN_WAIT': return 'confirmed: shell is blocked reading stdin (Linux /proc evidence)';
    case 'IDLE_INFERRED': return 'inferred: no output for 200ms, but no prompt marker seen (possible full-screen program)';
    case 'TIMEOUT': return 'unsettled: max wait elapsed — the command may still be running';
  }
}

export const terminalOpenTool: Tool = {
  descriptor: {
    name: 'terminal_open',
    description:
      'Open a persistent, PTY-backed interactive shell session that stays alive across multiple ' +
      'terminal_send calls. Use for REPLs, watch-mode processes, or anything the one-shot `shell` ' +
      'tool cannot express (interactive prompts, long-lived foreground processes you need to poll).',
    inputSchema: {
      type: 'object',
      properties: {
        cols: { type: 'number', description: 'Terminal width in columns (default 120)' },
        rows: { type: 'number', description: 'Terminal height in rows (default 40)' },
      },
    },
    permissions: ['shell_execute'],
    riskLevel: 'high',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const session = new TerminalSession({
        cwd: ctx.projectRoot,
        env: ctx.env,
        cols: typeof input.cols === 'number' ? input.cols : undefined,
        rows: typeof input.rows === 'number' ? input.rows : undefined,
      });
      sessions.set(session.id, session);
      return {
        ok: true,
        output: `Opened terminal session ${session.id}`,
        durationMs: Date.now() - started,
        metadata: { sessionId: session.id },
      };
    } catch (err: unknown) {
      return {
        ok: false,
        output: `Failed to open terminal session: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - started,
      };
    }
  },
};

export const terminalSendTool: Tool = {
  descriptor: {
    name: 'terminal_send',
    description:
      'Send input to an open terminal session (from terminal_open) and wait for it to settle. ' +
      'Returns sanitized output produced since the last send/read on this session, plus how ' +
      'confidently the tool believes the shell is idle again (see `readiness` in metadata).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id returned by terminal_open' },
        input: { type: 'string', description: 'Text to send. A trailing Enter is added unless rawKeys is true.' },
        rawKeys: { type: 'boolean', description: 'Send input verbatim with no appended newline (e.g. Ctrl-C as \\u0003)' },
        maxWaitMs: { type: 'number', description: 'Maximum time to wait for the shell to settle (default 30000)' },
      },
      required: ['sessionId', 'input'],
    },
    permissions: ['shell_execute'],
    riskLevel: 'high',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    void ctx;
    const started = Date.now();
    const sessionId = String(input.sessionId ?? '');
    try {
      const session = getSession(sessionId);
      const result = await session.send(String(input.input ?? ''), {
        newline: input.rawKeys !== true,
        maxWaitMs: typeof input.maxWaitMs === 'number' ? input.maxWaitMs : undefined,
      });
      return {
        ok: true,
        output: result.output,
        durationMs: Date.now() - started,
        metadata: {
          sessionId,
          readiness: result.readiness,
          readinessNote: readinessNote(result.readiness),
          exitCode: result.exitCode,
          byteLength: result.byteLength,
          newlineCount: result.newlineCount,
        },
      };
    } catch (error) {
      return {
        ok: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  },
};

export const terminalCloseTool: Tool = {
  descriptor: {
    name: 'terminal_close',
    description: 'Gracefully close an open terminal session, escalating to a forced kill if it does not exit in time.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id returned by terminal_open' },
        graceMs: { type: 'number', description: 'Time to allow a graceful exit before SIGKILL (default 2000)' },
      },
      required: ['sessionId'],
    },
    permissions: ['shell_execute'],
    riskLevel: 'medium',
    environment: 'local',
  },
  async execute(input): Promise<ToolResult> {
    const started = Date.now();
    const sessionId = String(input.sessionId ?? '');
    const session = sessions.get(sessionId);
    if (!session) {
      return { ok: false, output: '', error: `No open terminal session '${sessionId}'`, durationMs: Date.now() - started };
    }
    await session.dispose(typeof input.graceMs === 'number' ? input.graceMs : undefined);
    sessions.delete(sessionId);
    return { ok: true, output: `Closed terminal session ${sessionId}`, durationMs: Date.now() - started };
  },
};
