import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

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
  // No contextTokens: this proves recovery is reactive to what the runtime
  // itself reports, not dependent on the host having supplied a ceiling
  // compactIfNeeded's own proactive gate could key off.
};

describe('CodingAgent.run — reactive context-overflow recovery', () => {
  it('recovers from a runtime-reported context-length error by forcing compaction and retrying, instead of failing the task', async () => {
    let call = 0;
    const runtime: AgentRuntime = {
      tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
      async *generate(request) {
        call += 1;
        if (call === 3) {
          // Simulate a real provider's context-overflow response — this is
          // the exact shape modelTurn() throws when GenerationEvent carries
          // an 'error' (see the LM Studio/Ollama adapters' own HTTP error
          // messages for the real-world wording this pattern matches).
          yield { type: 'error', error: 'This model\'s maximum context length is 4096 tokens. Please reduce the length of the messages.' };
          return;
        }
        const reply =
          call === 1
            ? '{"action":"plan","content":"write the file"}'
            : call === 2
              ? '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"int main(){}"}}'
              : '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const agent = createCodingAgent({ maxTurns: 15 });
    const turns = await drain(agent.run(baseRequest, runtime));

    const recoveryTurn = turns.find((t) => t.kind === 'message' && t.content?.includes('context overflow recovery'));
    expect(recoveryTurn).toBeDefined();

    // The task did not fail outright — it kept going past the overflow.
    expect(turns.some((t) => t.kind === 'error')).toBe(false);
    // One extra generate() call for the forced retry after recovery.
    expect(call).toBeGreaterThan(3);
  });

  it('does not intercept an unrelated model error — only context-overflow-shaped ones', async () => {
    let call = 0;
    const runtime: AgentRuntime = {
      tools: [],
      async *generate() {
        call += 1;
        if (call === 1) {
          yield { type: 'error', error: 'internal server error: connection reset' };
          return;
        }
        yield { type: 'token', content: '{"action":"done","summary":"ok"}' };
        yield { type: 'completed', content: '{"action":"done","summary":"ok"}' };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const agent = createCodingAgent({ maxTurns: 5 });
    // The unrelated error is not context-overflow-shaped, so it is not
    // intercepted — it propagates out of run() exactly as it would have
    // before this change, rather than being silently swallowed or retried.
    await expect(drain(agent.run(baseRequest, runtime))).rejects.toThrow('connection reset');
  });
});
