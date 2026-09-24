import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

const baseRequest: Omit<AgentRunRequest, 'contextTokens'> = {
  modelId: 'fake-model',
  taskDescription: 'build a c++ program that sorts an array',
  taskType: 'coding',
  projectRoot: '/tmp/fake-project',
};

/**
 * Each turn writes a distinct file with a long-ish body, so `messages` grows
 * by a large, known amount every turn (the tool result is echoed back into
 * the conversation) — enough to blow through a deliberately tiny
 * `contextTokens` budget within a handful of turns.
 */
function growingRuntime(): { runtime: AgentRuntime; messageLengthsSeen: number[] } {
  let n = 0;
  const messageLengthsSeen: number[] = [];
  const runtime: AgentRuntime = {
    tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
    async *generate(request) {
      messageLengthsSeen.push(request.messages.reduce((sum, m) => sum + m.content.length, 0));
      n += 1;
      const reply =
        n === 1
          ? '{"action":"plan","content":"write files"}'
          : n <= 9
            ? `{"action":"tool","tool":"write","input":{"path":"file${n}.txt","content":"${'x'.repeat(300)}"}}`
            : '{"action":"done","summary":"ok"}';
      yield { type: 'token', content: reply };
      yield { type: 'completed', content: reply };
    },
    async executeTool(): Promise<ToolResult> {
      return { ok: true, output: 'y'.repeat(300), durationMs: 1 };
    },
  };
  return { runtime, messageLengthsSeen };
}

describe('CodingAgent.run — context compaction', () => {
  it('collapses older turns into a summary once the estimated token usage crosses the compaction ratio', async () => {
    const agent = createCodingAgent({ maxTurns: 15 });
    const { runtime, messageLengthsSeen } = growingRuntime();

    // Small context window (in tokens; ~4 chars/token) so the accumulating
    // write/tool-result turns cross the compaction threshold well before
    // maxTurns is reached.
    const turns = await drain(agent.run({ ...baseRequest, contextTokens: 800 }, runtime));

    const compactionTurn = turns.find((t) => t.kind === 'message' && t.content?.includes('context compacted'));
    expect(compactionTurn).toBeDefined();

    // Keeping the last few turns verbatim means compaction plateaus the
    // prompt size rather than shrinking it below its own steady-state floor —
    // the real proof it's working is that per-turn growth collapses from
    // "every turn's full write+tool-result body" to "roughly break-even"
    // once it kicks in, instead of growing by the same amount forever.
    const earlyGrowth = messageLengthsSeen[2] - messageLengthsSeen[1];
    const lateGrowth = messageLengthsSeen.at(-1)! - messageLengthsSeen.at(-2)!;
    expect(lateGrowth).toBeLessThan(earlyGrowth / 4);
  });

  it('never compacts when the host does not report a contextTokens ceiling', async () => {
    const agent = createCodingAgent({ maxTurns: 15 });
    const { runtime } = growingRuntime();

    const turns = await drain(agent.run(baseRequest, runtime));

    expect(turns.some((t) => t.kind === 'message' && t.content?.includes('context compacted'))).toBe(false);
  });

  // Regression: the ratio gate was missing, so any run whose host reported a context
  // window compacted on every turn (observed live: 28 compactions in 30 model requests),
  // discarding recent context and re-sending file contents each turn.
  it('does not compact at all while usage stays well under the window', async () => {
    const agent = createCodingAgent({ maxTurns: 20 });
    const { runtime, messageLengthsSeen } = growingRuntime();

    const turns = await drain(agent.run({ ...baseRequest, contextTokens: 32_768 }, runtime));

    expect(turns.some((t) => t.kind === 'message' && t.content?.includes('context compacted'))).toBe(false);
    // The transcript simply grows: every earlier turn is still there.
    for (let i = 1; i < messageLengthsSeen.length; i++) expect(messageLengthsSeen[i]).toBeGreaterThan(messageLengthsSeen[i - 1]);
  });

  it('compacts only once the ratio is crossed, not from the first turns', async () => {
    const agent = createCodingAgent({ maxTurns: 20, contextCompactionRatio: 0.7 });
    const { runtime, messageLengthsSeen } = growingRuntime();

    const turns = await drain(agent.run({ ...baseRequest, contextTokens: 2_000 }, runtime));
    const compactions = turns.filter((t) => t.kind === 'message' && t.content?.includes('context compacted'));

    expect(compactions.length).toBeGreaterThan(0);
    // Several real turns happen before the transcript reaches 70% of the window
    // (before the fix, compaction started on the third model request)...
    const first = turns.findIndex((t) => t.kind === 'message' && t.content?.includes('context compacted'));
    expect(turns.slice(0, first).filter((t) => t.kind === 'tool_call').length).toBeGreaterThanOrEqual(3);
    // ...and it stays a response to pressure, not a per-turn routine.
    expect(compactions.length).toBeLessThan(messageLengthsSeen.length / 2);
  });

  it('refuses a compaction that would not shrink the transcript', async () => {
    // One huge read keeps the active file content (re-embedded by the summary) larger
    // than everything it would replace, so compacting could only lose history.
    let n = 0;
    const runtime: AgentRuntime = {
      tools: [{ name: 'read', description: 'read', inputSchema: {} }, { name: 'write', description: 'write', inputSchema: {} }],
      async *generate() {
        n += 1;
        const reply = n === 1 ? '{"action":"plan","content":"p"}'
          : n === 2 ? '{"action":"tool","tool":"read","input":{"path":"big.txt"}}'
          : n <= 5 ? `{"action":"tool","tool":"write","input":{"path":"f${n}.txt","content":"x"}}`
          : '{"action":"done","summary":"ok"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name): Promise<ToolResult> {
        return { ok: true, output: name === 'read' ? 'z'.repeat(20_000) : 'ok', durationMs: 1 };
      },
    };

    const turns = await drain(createCodingAgent({ maxTurns: 20 }).run({ ...baseRequest, contextTokens: 1_000 }, runtime));

    expect(turns.some((t) => t.kind === 'message' && t.content?.includes('context compacted'))).toBe(false);
  });
});
