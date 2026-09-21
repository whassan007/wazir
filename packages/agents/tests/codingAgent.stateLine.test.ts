import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ChatMessage, ToolResult } from '@wazir/core';

async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

const baseRequest: AgentRunRequest = {
  modelId: 'fake-model',
  taskDescription: 'build a c++ program that sorts an array',
  taskType: 'coding',
  projectRoot: '/tmp/fake-project',
};

/**
 * A compact, deterministic execution-state line ("[state] turn N/M | files changed: ... |
 * last action: ...") is now appended to every "continue" message, so the model can track
 * progress from one line instead of re-deriving it from the whole conversation history —
 * previously this summary only ever existed once, inside the context-compaction message,
 * and only after the context had already grown past the compaction threshold.
 */
describe('CodingAgent.run — per-turn execution state summary', () => {
  it('tells the model its turn budget and which files have actually changed after a tool call', async () => {
    let calls = 0;
    const seenMessages: ChatMessage[][] = [];
    const runtime: AgentRuntime = {
      tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
      async *generate(request) {
        calls += 1;
        seenMessages.push(request.messages);
        const reply =
          calls === 1
            ? '{"action":"plan","content":"write it"}'
            : calls === 2
              ? '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"int main(){}"}}'
              : '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    await drain(createCodingAgent({ maxTurns: 15 }).run(baseRequest, runtime));

    // Input to call 3 (index 2), right after main.cpp was written on call 2. The plan
    // -> work transition already appended one [state] message earlier in the same
    // array, so take the *last* one — the one reflecting the write that just happened.
    const afterWrite = seenMessages[2];
    const stateMessage = [...afterWrite].reverse().find((m) => m.content.includes('[state]'));
    expect(stateMessage).toBeDefined();
    expect(stateMessage!.content).toContain('turn 2/15');
    expect(stateMessage!.content).toContain('files changed: main.cpp');
    expect(stateMessage!.content).toContain('last action: write(ok)');
  });

  it('reports "files changed: none" before anything has actually been written', async () => {
    let calls = 0;
    const seenMessages: ChatMessage[][] = [];
    const runtime: AgentRuntime = {
      tools: [{ name: 'glob', description: 'find files', inputSchema: {} }],
      async *generate(request) {
        calls += 1;
        seenMessages.push(request.messages);
        const reply =
          calls === 1
            ? '{"action":"plan","content":"look around"}'
            : calls === 2
              ? '{"action":"tool","tool":"glob","input":{"pattern":"*.cpp"}}'
              : '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: '(no matches)', durationMs: 1 };
      },
    };

    await drain(createCodingAgent({ maxTurns: 15 }).run(baseRequest, runtime));

    const afterGlob = seenMessages[2];
    const stateMessage = [...afterGlob].reverse().find((m) => m.content.includes('[state]'));
    expect(stateMessage?.content).toContain('files changed: none');
    expect(stateMessage?.content).toContain('last action: glob(ok)');
  });
});
