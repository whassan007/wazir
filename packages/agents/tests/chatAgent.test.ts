import { describe, it, expect, vi } from 'vitest';
import { ChatAgent } from '../src/chatAgent.js';
import type { AgentRuntime, AgentRunRequest } from '@wazir/core';
const request: AgentRunRequest = { modelId: 'resident', taskDescription: '12+19', taskType: 'chat', projectRoot: '/tmp' };
const collect = async (agent: ChatAgent, runtime: AgentRuntime, req = request) => {
  const turns = []; for await (const turn of agent.run(req, runtime)) turns.push(turn); return turns;
};
const runtime = (generate: AgentRuntime['generate']): AgentRuntime => ({ generate, tools: [], executeTool: vi.fn(), cancelCurrentTurn: vi.fn() });
describe('scheduled conversational agent', () => {
  it('uses one pinned generation without tools or action envelopes', async () => {
    const r = runtime(async function* (q) { expect(q.modelId).toBe('resident'); expect(q.tools).toBeUndefined(); yield { type: 'token', content: '31' }; yield { type: 'completed' }; });
    expect(await collect(new ChatAgent(), r)).toEqual([expect.objectContaining({ kind: 'done', content: '31' })]);
    expect(r.executeTool).not.toHaveBeenCalled();
  });
  it('F01 bounds a stalled iterator and aborts it', async () => {
    const r = runtime(async function* () { await new Promise(() => {}); });
    const turns = await collect(new ChatAgent({ timeoutMs: 20 }), r);
    expect(turns.at(-1)).toMatchObject({ kind: 'error', terminationReason: 'MAX_WALL_CLOCK' });
    expect(r.cancelCurrentTurn).toHaveBeenCalled();
  });
  it('F02 propagates runtime disconnection', async () => {
    const turns = await collect(new ChatAgent(), runtime(async function* () { throw new Error('ECONNREFUSED'); }));
    expect(turns.at(-1)).toMatchObject({ kind: 'error', error: 'ECONNREFUSED' });
  });
  it('F04 cancels pending inference without waiting for another token', async () => {
    let cancelled = false;
    const r = runtime(async function* () { await new Promise(() => {}); });
    const timer = setTimeout(() => { cancelled = true; }, 10);
    const turns = await collect(new ChatAgent(), r, { ...request, isCancelled: () => cancelled });
    clearTimeout(timer);
    expect(turns.at(-1)).toMatchObject({ kind: 'error', terminationReason: 'CANCELLED' });
    expect(r.cancelCurrentTurn).toHaveBeenCalled();
  });
  it('F06 rejects empty completion and incomplete streams', async () => {
    for (const generate of [async function* () { yield { type: 'completed' as const }; }, async function* () { yield { type: 'token' as const, content: 'partial' }; }]) {
      expect((await collect(new ChatAgent(), runtime(generate))).at(-1)?.kind).toBe('error');
    }
  });
  it('never executes a runtime tool call', async () => {
    const r = runtime(async function* () { yield { type: 'tool_call', toolName: 'shell', toolInput: { command: 'exit 1' } }; });
    expect((await collect(new ChatAgent(), r)).at(-1)?.kind).toBe('error');
    expect(r.executeTool).not.toHaveBeenCalled();
  });
});
