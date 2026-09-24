import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ChatMessage, ToolResult } from '@wazir/core';

/**
 * Phase 2: a failed model attempt is an execution fact, not a canonical assistant
 * message. It stays in execution history (the yielded turn's `raw`), the next request
 * carries one repair note, and once a valid action is accepted the failure is gone
 * from every later request.
 */
async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

const baseRequest: AgentRunRequest = {
  modelId: 'fake-model',
  taskDescription: 'write main.cpp',
  taskType: 'coding',
  projectRoot: '/tmp/fake-project',
};

const MALFORMED_1 = 'I think I should write the file now, let me explain at length';
const MALFORMED_2 = '{"action":"tool","tool":"write","input":{}}';

function runtimeWith(replies: string[]): { runtime: AgentRuntime; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let n = 0;
  const runtime: AgentRuntime = {
    tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
    async *generate(request) {
      seen.push(request.messages);
      const reply = replies[Math.min(n, replies.length - 1)];
      n += 1;
      yield { type: 'token', content: reply };
      yield { type: 'completed', content: reply };
    },
    async executeTool(): Promise<ToolResult> {
      return { ok: true, output: 'ok', durationMs: 1 };
    },
  };
  return { runtime, seen };
}

describe('CodingAgent.run — model attempts vs. model context', () => {
  it('keeps failed attempts in execution history but out of later model context', async () => {
    const { runtime, seen } = runtimeWith([
      '{"action":"plan","content":"write it"}',
      MALFORMED_1,
      MALFORMED_2,
      '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"int main(){}"}}',
      '{"action":"done","summary":"done"}',
    ]);

    const turns = await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

    // Execution history: both failed attempts are recorded verbatim.
    const raws = turns.map((t) => t.raw);
    expect(raws).toContain(MALFORMED_1);
    expect(raws).toContain(MALFORMED_2);

    const text = (msgs: ChatMessage[]) => msgs.map((m) => m.content).join('\n');

    // Request 3 (after the unparseable attempt): one repair note, no assistant copy of it.
    expect(seen[2].some((m) => m.role === 'assistant' && m.content === MALFORMED_1)).toBe(false);
    expect(text(seen[2]).match(/previous response rejected/g)).toHaveLength(1);

    // Request 4 (after a second, different failure): the note is replaced, not accumulated.
    expect(text(seen[3]).match(/previous response rejected/g)).toHaveLength(1);
    expect(text(seen[3])).toContain('ACTION_VALIDATION_FAILED');
    expect(seen[3].some((m) => m.content === MALFORMED_2)).toBe(false);

    // Request 5 (after the valid write was accepted): no trace of the failures.
    expect(text(seen[4])).not.toContain('previous response rejected');
    expect(text(seen[4])).not.toContain(MALFORMED_1);
    expect(seen[4].filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([
      '{"action":"plan","content":"write it"}',
      '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"int main(){}"}}',
    ]);
  });

  it('never sends two consecutive user messages because of a rejected attempt', async () => {
    const { runtime, seen } = runtimeWith([
      '{"action":"plan","content":"write it"}',
      MALFORMED_1,
      '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"x"}}',
      '{"action":"done","summary":"done"}',
    ]);

    await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

    for (const request of seen.slice(1)) {
      for (let i = 1; i < request.length; i++) {
        expect(request[i].role === 'user' && request[i - 1].role === 'user').toBe(false);
      }
    }
  });
});
