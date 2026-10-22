import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn } from '@wazir/core';

/**
 * Regression coverage for P0-B (test/agy-execution-repair): a task whose contract is a
 * textual answer only ('chat', or mutationRequired: false) should be told it's allowed to
 * answer immediately instead of being pushed to produce a plan first — the turn loop already
 * accepts a `done` action during PLAN, so this is purely a prompting change, not a new control
 * path, keeping risk low.
 */

async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

function captureSystemPrompt(): { runtime: AgentRuntime; prompts: string[] } {
  const prompts: string[] = [];
  const runtime: AgentRuntime = {
    tools: [{ name: 'read', description: 'read a file', inputSchema: {} }],
    async *generate(request) {
      prompts.push(request.messages[0]?.content ?? '');
      const reply = '{"action":"done","summary":"42"}';
      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply };
    },
    async executeTool() {
      return { ok: true, output: 'ok', durationMs: 1 };
    },
  };
  return { runtime, prompts };
}

describe('CodingAgent.run — fast-answer prompt hint for textual-only tasks', () => {
  it('tells the model it may answer immediately for a chat-typed task that inspects the repo', async () => {
    const { runtime, prompts } = captureSystemPrompt();
    const agent = createCodingAgent();
    await drain(agent.run({
      modelId: 'fake-model', taskDescription: 'Inspect src/index.ts and tell me what it exports', taskType: 'chat',
      projectRoot: '/tmp/fake-project', maxTurns: 3,
    }, runtime));

    expect(prompts[0]).toContain('respond immediately with {"action":"done"');
  });

  it('tells the model it may answer immediately when mutationRequired is explicitly false', async () => {
    const { runtime, prompts } = captureSystemPrompt();
    const agent = createCodingAgent();
    await drain(agent.run({
      modelId: 'fake-model', taskDescription: 'Read src/index.ts and explain its architecture in one sentence', taskType: 'code_analysis',
      projectRoot: '/tmp/fake-project', maxTurns: 3, mutationRequired: false,
    }, runtime));

    expect(prompts[0]).toContain('respond immediately with {"action":"done"');
  });

  it('does NOT add the fast-answer hint for an ordinary coding task', async () => {
    const { runtime, prompts } = captureSystemPrompt();
    const agent = createCodingAgent();
    await drain(agent.run({
      modelId: 'fake-model', taskDescription: 'Edit src/index.ts to export a helper function', taskType: 'coding',
      projectRoot: '/tmp/fake-project', maxTurns: 3,
    }, runtime));

    expect(prompts[0]).not.toContain('respond immediately with {"action":"done"');
  });
});
