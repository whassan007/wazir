import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TerminalSession } from '../src/terminalSession.js';
import { terminalOpenTool, terminalSendTool, terminalCloseTool } from '../src/terminalTools.js';

describe('TerminalSession (real PTY)', () => {
  let cwd: string;
  const sessions: TerminalSession[] = [];

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-term-'));
  });

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.dispose(200)));
    await fs.rm(cwd, { recursive: true, force: true });
  });

  function open(): TerminalSession {
    const s = new TerminalSession({ cwd });
    sessions.push(s);
    return s;
  }

  it('runs a command and settles via the prompt marker, not just a timeout', async () => {
    const session = open();
    const result = await session.send('echo hello_wazir');
    expect(result.readiness).toBe('PROMPT_MARKER');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello_wazir');
  }, 15_000);

  it('reports a non-zero exit code through the marker', async () => {
    const session = open();
    const result = await session.send('false');
    expect(result.readiness).toBe('PROMPT_MARKER');
    expect(result.exitCode).toBe(1);
  }, 15_000);

  it('strips ANSI/control sequences from pending output', async () => {
    const session = open();
    const result = await session.send('printf "\\033[31mred\\033[0m\\n"');
    expect(result.output).toContain('red');
    expect(result.output).not.toContain('\u001b[31m');
  }, 15_000);

  it('clears pending output between sends (decoupled from scrollback)', async () => {
    const session = open();
    await session.send('echo first');
    const second = await session.send('echo second');
    expect(second.output).not.toContain('first');
    expect(second.output).toContain('second');
    // scrollback keeps the full history independently
    expect(session.scrollbackText()).toContain('first');
    expect(session.scrollbackText()).toContain('second');
  }, 15_000);

  it('persists shell state across sends (it is one session, not one-shot)', async () => {
    const session = open();
    await session.send('export WAZIR_TEST_VAR=persisted');
    const result = await session.send('echo $WAZIR_TEST_VAR');
    expect(result.output).toContain('persisted');
  }, 15_000);

  it('gracefully disposes and kills the underlying PTY', async () => {
    const session = open();
    await session.send('echo before-dispose');
    await session.dispose(500);
    await expect(session.send('echo after-dispose')).rejects.toThrow('TERMINAL_SESSION_DISPOSED');
  }, 15_000);
});

describe('terminal_open / terminal_send / terminal_close tools', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-term-tool-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  const ctx = () => ({ projectRoot: cwd });

  it('opens, sends, and closes a session end to end', async () => {
    const opened = await terminalOpenTool.execute({}, ctx() as any);
    expect(opened.ok).toBe(true);
    const sessionId = opened.metadata?.sessionId as string;
    expect(sessionId).toBeTruthy();

    const sent = await terminalSendTool.execute({ sessionId, input: 'echo tool_test' }, ctx() as any);
    expect(sent.ok).toBe(true);
    expect(sent.output).toContain('tool_test');
    expect(sent.metadata?.readiness).toBe('PROMPT_MARKER');

    const closed = await terminalCloseTool.execute({ sessionId }, ctx() as any);
    expect(closed.ok).toBe(true);

    const afterClose = await terminalSendTool.execute({ sessionId, input: 'echo nope' }, ctx() as any);
    expect(afterClose.ok).toBe(false);
  }, 20_000);

  it('rejects sending to an unknown session', async () => {
    const result = await terminalSendTool.execute({ sessionId: 'does-not-exist', input: 'echo x' }, ctx() as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does-not-exist');
  });
});
