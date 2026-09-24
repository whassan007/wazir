import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

/**
 * Terminal turns carry the controller's own run totals, and an ordinary failed
 * verification has a typed reason instead of none.
 */
async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}
const baseRequest: AgentRunRequest = { modelId: 'm', taskDescription: 'fix it', taskType: 'coding', projectRoot: '/tmp/p', maxTurns: 20 };

function runtime(replies: string[], execute: (name: string) => ToolResult): AgentRuntime {
  let n = 0;
  return {
    tools: [{ name: 'write', description: 'w', inputSchema: {} }, { name: 'glob', description: 'g', inputSchema: {} }],
    async *generate() {
      const reply = replies[Math.min(n++, replies.length - 1)];
      yield { type: 'token', content: reply };
      yield { type: 'completed', content: reply, usage: { inputTokens: 100, outputTokens: 10 } };
    },
    async executeTool(name) { return execute(name); },
  };
}
const WRITE = '{"action":"tool","tool":"write","input":{"path":"a.cpp","content":"x"}}';

describe('CodingAgent terminal turns', () => {
  it('a failed controller verification ends with VERIFICATION_FAILED and harness-counted run stats', async () => {
    const rt = runtime(['{"action":"plan","content":"p"}', WRITE, '{"action":"done","summary":"all tests pass"}'], (name) =>
      name === 'test' ? { ok: false, output: 'FAIL sort', error: 'test exited with code 1', durationMs: 1 } : { ok: true, output: 'ok', durationMs: 1 });

    const turns = await drain(createCodingAgent().run(baseRequest, rt));
    const last = turns.at(-1)!;

    expect(last.kind).toBe('error');
    expect(last.terminationReason).toBe('VERIFICATION_FAILED');
    // The model's "all tests pass" claim did not count as evidence.
    expect(last.runStats).toEqual({ turns: 3, toolCalls: 1, tokensUsed: 330, longestNoProgressStreak: 0, duplicateActionsBlocked: 0, modelEscalations: 0 });
    // Non-terminal turns are not stamped.
    expect(turns.slice(0, -1).some((t) => t.runStats)).toBe(false);
  });

  it('records the longest no-progress streak and blocked duplicates', async () => {
    const replies = ['{"action":"plan","content":"p"}', ...['a', 'b', 'c'].map((p) => `{"action":"tool","tool":"glob","input":{"pattern":"${p}"}}`),
      '{"action":"tool","tool":"glob","input":{"pattern":"z"}}', '{"action":"tool","tool":"glob","input":{"pattern":"z"}}', '{"action":"tool","tool":"glob","input":{"pattern":"z"}}'];
    const rt = runtime(replies, () => ({ ok: true, output: '', durationMs: 1 }));

    const turns = await drain(createCodingAgent({ toolRepeatLimit: 3, maxNoProgressIterations: 50 }).run(baseRequest, rt));
    const stats = turns.at(-1)!.runStats!;

    expect(turns.at(-1)!.terminationReason).toBe('REPEATED_ACTION');
    expect(stats.duplicateActionsBlocked).toBe(2);
    // a (new), b, c, z, z -> four consecutive calls that taught nothing new.
    expect(stats.longestNoProgressStreak).toBe(4);
  });
});
