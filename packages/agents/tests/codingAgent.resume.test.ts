import { describe, expect, it } from 'vitest';
import { createCodingAgent, resumeBriefing } from '../src/codingAgent.js';
import type { AgentResumeContext, AgentRunRequest, AgentRuntime, AgentTurn, ChatMessage, ToolResult } from '@wazir/core';

/** Phase 21: a resumed run continues the execution instead of starting over. */
const resume: AgentResumeContext = {
  executionId: 'exec-1', attempt: 2, workspaceRevision: 3, filesChanged: ['sort.cpp'],
  consumed: { toolCalls: 4, tokens: 1000 }, verification: { passing: ['build'], failing: ['test'], stale: 1 },
  previousTermination: 'NO_PROGRESS', lastError: 'NO_PROGRESS: 6 consecutive tool calls\nmore', reconciled: ["'write' APPLIED: exact content"],
};
const baseRequest: AgentRunRequest = { modelId: 'm', taskDescription: 'fix the sort', taskType: 'coding', projectRoot: '/tmp/p', maxTurns: 20 };

async function run(replies: string[], request: AgentRunRequest, options = {}) {
  const seen: ChatMessage[][] = [];
  let n = 0;
  const executed: string[] = [];
  const runtime: AgentRuntime = {
    tools: [{ name: 'read', description: 'r', inputSchema: {} }],
    async *generate(req) {
      seen.push(req.messages);
      const reply = replies[Math.min(n++, replies.length - 1)];
      yield { type: 'token', content: reply };
      yield { type: 'completed', content: reply };
    },
    async executeTool(name): Promise<ToolResult> { executed.push(name); return { ok: true, output: `ok ${executed.length}`, durationMs: 1 }; },
  };
  const turns: AgentTurn[] = [];
  for await (const t of createCodingAgent(options).run(request, runtime)) turns.push(t);
  return { turns, seen, executed };
}

describe('CodingAgent resume', () => {
  it('briefs the model with controller facts only', () => {
    const text = resumeBriefing(resume);
    expect(text).toContain('RESUMING execution exec-1 (attempt 2)');
    expect(text).toContain('(NO_PROGRESS)');
    expect(text).toContain('Files already changed on disk: sort.cpp');
    expect(text).toContain('passing at this revision: build; failing: test; 1 older result(s) are stale');
    expect(text).toContain('Last recorded error: NO_PROGRESS: 6 consecutive tool calls');
    expect(text).not.toContain('more');
  });

  it('puts the briefing in the first request and treats prior changes as already made', async () => {
    const { turns, seen } = await run(['{"action":"plan","content":"verify"}', '{"action":"tool","tool":"read","input":{"path":"sort.cpp"}}', '{"action":"done","summary":"verified"}'], { ...baseRequest, resume });
    expect(seen[0][1].content).toContain('RESUMING execution exec-1');
    // No write happened in this attempt, yet verification doesn't fail as "no code modifications".
    expect(turns.at(-1)).toMatchObject({ kind: 'done', terminationReason: 'VERIFICATION_PASSED' });
  });

  it('counts prior tool-call and token consumption against execution-wide budgets', async () => {
    const reads = Array.from({ length: 10 }, (_, i) => `{"action":"tool","tool":"read","input":{"path":"f${i}"}}`);
    const { turns, executed } = await run(['{"action":"plan","content":"p"}', ...reads], { ...baseRequest, resume, maxToolCalls: 6 });
    expect(turns.at(-1)?.terminationReason).toBe('MAX_TOOL_CALLS');
    // 4 consumed before + 2 now = 6.
    expect(executed.filter((t) => t === 'read')).toHaveLength(2);
    expect(turns.at(-1)?.runStats).toMatchObject({ toolCalls: 6, tokensUsed: 1000 });
  });
});
