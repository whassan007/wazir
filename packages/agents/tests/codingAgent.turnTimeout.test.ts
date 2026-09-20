import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

/**
 * A fake `AgentRuntime` whose `generate()` never completes on its own —
 * it streams one token then hangs until `cancelCurrentTurn()` is called,
 * at which point it yields a `completed` event with whatever content had
 * accumulated (mirroring how the real LM Studio / Ollama adapters behave
 * when aborted mid-stream: `completed` with partial content, not `error`).
 * This reproduces a small/local model that rambles in prose forever
 * without ever emitting the required JSON action.
 */
function hangingRuntime(): { runtime: AgentRuntime; counters: { cancelCalls: number; generateCalls: number } } {
  const counters = { cancelCalls: 0, generateCalls: 0 };
  let release: (() => void) | undefined;
  const runtime: AgentRuntime = {
    tools: [{ name: 'read', description: 'read a file', inputSchema: {} }],
    cancelCurrentTurn() {
      counters.cancelCalls += 1;
      release?.();
    },
    async *generate() {
      counters.generateCalls += 1;
      yield { type: 'token', content: 'Actually, I will try one thing. If that fails I will try another. ' };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield { type: 'completed', content: 'Actually, I will try one thing. If that fails I will try another. (cut off)' };
    },
    async executeTool(name): Promise<ToolResult> {
      return { ok: true, output: `ok:${name}`, durationMs: 1 };
    },
  };
  return { runtime, counters };
}

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

describe('CodingAgent.run — per-turn timeout', () => {
  it('cancels a turn that exceeds modelTurnTimeoutMs instead of hanging until the job-level timeout', async () => {
    const agent = createCodingAgent({ modelTurnTimeoutMs: 10, maxTurns: 10 });
    const { runtime, counters } = hangingRuntime();

    const turns = await drain(agent.run(baseRequest, runtime));

    expect(counters.cancelCalls).toBeGreaterThan(0);
    // correctionCount carries over from PLAN into WORK, so 3 straight
    // timed-out/unparseable turns trip the existing repeated-failure guard
    // instead of the loop hanging or silently burning all of maxTurns.
    expect(turns.some((t) => t.kind === 'error' && t.error?.includes('repeatedly failed'))).toBe(true);
    expect(counters.generateCalls).toBeLessThan(10);
  });

  it('never cancels a turn that completes well within the timeout', async () => {
    const agent = createCodingAgent({ modelTurnTimeoutMs: 5_000 });
    let cancelCalls = 0;
    const runtime: AgentRuntime = {
      tools: [],
      cancelCurrentTurn() {
        cancelCalls += 1;
      },
      async *generate() {
        yield { type: 'token', content: '{"action":"done","summary":"ok"}' };
        yield { type: 'completed', content: '{"action":"done","summary":"ok"}' };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: '', durationMs: 0 };
      },
    };

    await drain(agent.run(baseRequest, runtime));

    expect(cancelCalls).toBe(0);
  });
});
