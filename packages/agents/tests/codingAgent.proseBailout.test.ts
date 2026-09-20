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
  taskDescription: 'create a pascal file that implements quicksort',
  taskType: 'coding',
  projectRoot: '/tmp/fake-project',
};

/**
 * Real transcript: a local model re-derived an entire source file as prose
 * "thinking" — 5000+ chars streamed with no `{` anywhere — well inside both
 * the per-turn timeout and the token budget, just wastefully slow. This
 * fake keeps streaming plain prose (never a JSON object) until cancelled,
 * mirroring that failure mode without needing a real 90-second wait.
 */
function ramblingRuntime(): { runtime: AgentRuntime; counters: { cancelCalls: number; charsAtCancel: number } } {
  const counters = { cancelCalls: 0, charsAtCancel: 0 };
  let cancelled = false;
  const runtime: AgentRuntime = {
    tools: [],
    cancelCurrentTurn() {
      counters.cancelCalls += 1;
      cancelled = true;
    },
    async *generate() {
      let sent = 0;
      const chunk = 'Wait, let me reconsider the array bounds and re-derive the whole procedure once more. ';
      while (!cancelled && sent < 20_000) {
        yield { type: 'token', content: chunk };
        sent += chunk.length;
      }
      counters.charsAtCancel = sent;
      yield { type: 'completed', content: 'cut off mid-ramble' };
    },
    async executeTool(): Promise<ToolResult> {
      return { ok: true, output: 'ok', durationMs: 0 };
    },
  };
  return { runtime, counters };
}

describe('CodingAgent.run — prose-before-action bailout', () => {
  it('cancels a turn that streams a lot of prose without ever opening a JSON object', async () => {
    const agent = createCodingAgent({ maxProseBeforeActionChars: 2_000, modelTurnTimeoutMs: 90_000, maxTurns: 10 });
    const { runtime, counters } = ramblingRuntime();

    const turns = await drain(agent.run(baseRequest, runtime));

    expect(counters.cancelCalls).toBeGreaterThan(0);
    // Proof it bailed on the char-count heuristic, not by luck running to the
    // fake's own 20,000-char ceiling.
    expect(counters.charsAtCancel).toBeLessThan(3_000);
    expect(turns.some((t) => t.kind === 'error' && t.error?.includes('repeatedly failed'))).toBe(true);
  });

  it('does not bail on a short, normal preamble before the JSON action', async () => {
    let cancelCalls = 0;
    const runtime: AgentRuntime = {
      tools: [],
      cancelCurrentTurn() {
        cancelCalls += 1;
      },
      async *generate() {
        const reply = 'Let me check the file first. {"action":"done","summary":"ok"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: '', durationMs: 0 };
      },
    };

    await drain(createCodingAgent({ maxProseBeforeActionChars: 2_000 }).run(baseRequest, runtime));

    expect(cancelCalls).toBe(0);
  });

  it('does not bail once the JSON object has actually started, however long the preamble was', async () => {
    let cancelCalls = 0;
    const runtime: AgentRuntime = {
      tools: [],
      cancelCurrentTurn() {
        cancelCalls += 1;
      },
      async *generate() {
        const preamble = 'thinking out loud for a while. '.repeat(80); // > 2000 chars
        const reply = `${preamble}{"action":"done","summary":"ok"}`;
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: '', durationMs: 0 };
      },
    };

    await drain(createCodingAgent({ maxProseBeforeActionChars: 2_000 }).run(baseRequest, runtime));

    // The whole reply (preamble + JSON) arrives as one token event in this
    // fake, so the `{` is already present by the time the length check runs —
    // proof the heuristic only fires on prose that never converges, not on
    // any long turn.
    expect(cancelCalls).toBe(0);
  });
});
