import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_CONDITIONS, firstStop, type StopCondition } from '../src/stopConditions.js';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

/** Phase 12: stop conditions are one controller-owned, composable list. */
const limits = { maxWallClockMs: 1000, maxToolCalls: 5, maxTokens: 100, maxNoProgressIterations: 3 };
const idle = { elapsedMs: 0, turns: 0, toolCalls: 0, tokensUsed: 0, noProgressStreak: 0 };

describe('firstStop', () => {
  it('only evaluates conditions declared for the checkpoint', () => {
    const over = { ...idle, elapsedMs: 5000, toolCalls: 9, tokensUsed: 500, noProgressStreak: 9 };
    expect(firstStop(DEFAULT_STOP_CONDITIONS, 'before_turn', over, limits)?.reason).toBe('MAX_WALL_CLOCK');
    expect(firstStop(DEFAULT_STOP_CONDITIONS, 'after_model_turn', over, limits)?.reason).toBe('MAX_TOKENS');
    expect(firstStop(DEFAULT_STOP_CONDITIONS, 'before_tool', over, limits)?.reason).toBe('MAX_TOOL_CALLS');
    expect(firstStop(DEFAULT_STOP_CONDITIONS, 'after_tool', over, limits)?.reason).toBe('NO_PROGRESS');
  });

  it('returns null while every budget holds', () => {
    for (const checkpoint of ['before_turn', 'after_model_turn', 'before_tool', 'after_tool'] as const) {
      expect(firstStop(DEFAULT_STOP_CONDITIONS, checkpoint, idle, limits)).toBeNull();
    }
  });

  it('never lets an exhausted budget be escalated around; only no-progress may try another model', () => {
    const escalatable = DEFAULT_STOP_CONDITIONS.filter((c) => c.escalatable).map((c) => c.reason);
    expect(escalatable).toEqual(['NO_PROGRESS']);
  });

  it('evaluates in declaration order', () => {
    const a: StopCondition = { reason: 'RESOURCE_EXHAUSTED', checkpoint: 'before_turn', escalatable: false, check: () => 'first' };
    const b: StopCondition = { reason: 'CANCELLED', checkpoint: 'before_turn', escalatable: false, check: () => 'second' };
    expect(firstStop([a, b], 'before_turn', idle, limits)).toEqual({ reason: 'RESOURCE_EXHAUSTED', message: 'first', escalatable: false });
  });
});

describe('CodingAgent with composed stop conditions', () => {
  it('a caller-supplied condition stops the run with its typed reason, alongside the defaults', async () => {
    let n = 0;
    const runtime: AgentRuntime = {
      tools: [{ name: 'glob', description: 'g', inputSchema: {} }],
      async *generate() {
        n += 1;
        const reply = n === 1 ? '{"action":"plan","content":"p"}' : `{"action":"tool","tool":"glob","input":{"pattern":"p${n}"}}`;
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> { return { ok: true, output: `found ${n}`, durationMs: 1 }; },
    };
    const maxTwoTurns: StopCondition = {
      reason: 'RESOURCE_EXHAUSTED', checkpoint: 'before_turn', escalatable: false,
      check: (s) => (s.turns >= 3 ? 'resource ceiling reached' : null),
    };
    const request: AgentRunRequest = { modelId: 'm', taskDescription: 't', taskType: 'coding', projectRoot: '/tmp/p', maxTurns: 50 };

    const turns: AgentTurn[] = [];
    for await (const t of createCodingAgent({ stopConditions: [...DEFAULT_STOP_CONDITIONS, maxTwoTurns] }).run(request, runtime)) turns.push(t);

    expect(turns.at(-1)).toMatchObject({ kind: 'error', terminationReason: 'RESOURCE_EXHAUSTED', error: 'resource ceiling reached' });
    expect(turns.at(-1)?.runStats?.turns).toBe(3);
  });
});
