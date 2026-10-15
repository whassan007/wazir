import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

const request: AgentRunRequest = { modelId: 'fake-model', taskDescription: 'write main.cpp', taskType: 'coding', projectRoot: '/tmp/fake-project' };
const reset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

function runtime(failOn: Set<number>) {
  let call = 0;
  const executed: string[] = [];
  const rt: AgentRuntime = {
    tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
    async *generate() {
      call += 1;
      const reply = call === 1 ? '{"action":"plan","content":"write"}'
        : executed.length === 0 ? '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"int main(){}"}}'
          : '{"action":"done","summary":"done"}';
      yield { type: 'token', content: reply.slice(0, 10) };
      // The transport drops after real output started streaming.
      if (failOn.has(call)) throw reset();
      yield { type: 'token', content: reply.slice(10) };
      yield { type: 'completed', content: reply };
    },
    async executeTool(name): Promise<ToolResult> { executed.push(name); return { ok: true, output: 'ok', durationMs: 1 }; },
  };
  return { rt, calls: () => call, executed };
}

describe('CodingAgent.run — interrupted model stream', () => {
  it('re-requests a generation cut by a connection reset, records it, and never runs the partial turn', async () => {
    const { rt, calls, executed } = runtime(new Set([2]));
    const turns = await drain(createCodingAgent({ maxTurns: 10 }).run(request, rt));
    expect(turns.some((t) => t.kind === 'message' && /model stream interrupted \(ECONNRESET: socket hang up\); retry 1\/2/.test(t.content ?? ''))).toBe(true);
    expect(turns.some((t) => t.kind === 'error')).toBe(false);
    expect(executed.filter((n) => n === 'write')).toEqual(['write']);
    expect(calls()).toBeGreaterThan(3);
  });

  it('gives up after two retries instead of looping', async () => {
    const { rt } = runtime(new Set([2, 3, 4, 5, 6]));
    await expect(drain(createCodingAgent({ maxTurns: 10 }).run(request, rt))).rejects.toThrow('socket hang up');
  });
});
