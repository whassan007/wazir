// A minimal ACP agent over stdio for tests. FAKE_ACP_MODE selects its behaviour:
//   normal  - plan, a permitted edit that writes out.txt, an execute request, a thought, an answer
//   cancel  - waits for session/cancel, then ends the turn as cancelled
//   session-error - fails session/new (the real cause must not be masked)
//   hang    - ignores cancel and keeps a child process alive (pids written to FAKE_ACP_PIDS)
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';

const mode = process.env.FAKE_ACP_MODE ?? 'normal';
const sessions = new Map();
let cancelHook;

new AgentSideConnection((conn) => ({
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
  },
  async authenticate() { return {}; },
  async newSession(params) {
    if (mode === 'session-error') {
      process.stderr.write('fake agent: refusing to open a session\n');
      throw new Error('ORIGINAL_SESSION_FAILURE');
    }
    const sessionId = `fake-${sessions.size + 1}`;
    sessions.set(sessionId, params.cwd);
    return { sessionId };
  },
  async cancel() { cancelHook?.(); },
  async prompt({ sessionId, prompt }) {
    const cwd = sessions.get(sessionId);
    const update = (u) => conn.sessionUpdate({ sessionId, update: u });
    const options = [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ];
    if (mode === 'cancel') {
      await new Promise((resolve) => { cancelHook = resolve; });
      return { stopReason: 'cancelled' };
    }
    if (mode === 'hang') {
      const child = spawn('sleep', ['60'], { stdio: 'ignore' });
      writeFileSync(process.env.FAKE_ACP_PIDS, `${process.pid} ${child.pid}`);
      await new Promise(() => {});
    }
    if (mode === 'normal' && prompt?.some(part => part.type === 'text' && part.text.includes('Reply with the single word OK.'))) {
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
      return { stopReason: 'end_turn' };
    }
    await update({ sessionUpdate: 'plan', entries: [{ content: 'write out.txt', status: 'in_progress', priority: 'high' }] });
    await update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write out.txt', kind: 'edit', status: 'pending' });
    const edit = await conn.requestPermission({ sessionId, toolCall: { toolCallId: 't1', title: 'Write out.txt', kind: 'edit' }, options });
    if (edit.outcome.outcome === 'selected' && edit.outcome.optionId === 'yes') writeFileSync(path.join(cwd, 'out.txt'), 'written by fake agent\n');
    await update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: edit.outcome.outcome === 'selected' ? 'completed' : 'failed' });
    const exec = await conn.requestPermission({ sessionId, toolCall: { toolCallId: 't2', title: 'rm -rf /', kind: 'execute' }, options });
    await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'SECRET_THOUGHT' } });
    await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Done: wrote out.txt (exec ${exec.outcome.outcome})` } });
    return { stopReason: 'end_turn' };
  },
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
