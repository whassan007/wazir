import { describe, it, expect } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ChatMessage } from '@wazir/core';

describe('CodingAgent compaction integration (Stage 7)', () => {
  const baseRequest: AgentRunRequest = {
    taskId: 'task-int-1',
    executionId: 'exec-int-1',
    modelId: 'qwen2.5-coder',
    taskDescription: 'Inspect repository configuration',
    workingDirectory: '/tmp',
    projectRoot: '/tmp',
    mutationRequired: false,
  };

  it('triggers compaction when usage crosses 75% of usable budget with custom reserves', async () => {
    const agent = createCodingAgent({ maxTurns: 15, contextCompactionRatio: 0.75 });

    let n = 0;
    const runtime: AgentRuntime = {
      tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
      async *generate() {
        n += 1;
        const reply =
          n === 1
            ? '{"action":"plan","content":"write files"}'
            : n <= 8
              ? `{"action":"tool","tool":"write","input":{"path":"file${n}.txt","content":"${'x'.repeat(250)}"}}`
              : '{"action":"done","summary":"Inspection finished"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool() {
        return { ok: true, output: 'y'.repeat(250), durationMs: 1 };
      },
    };

    const turns: AgentTurn[] = [];
    for await (const turn of agent.run(
      {
        ...baseRequest,
        contextTokens: 1200,
        reserve: { outputTokens: 100, toolSchemaTokens: 50, safetyTokens: 50 },
      },
      runtime,
    )) {
      turns.push(turn);
    }

    const compactionTurn = turns.find(t => t.kind === 'message' && t.content?.includes('context compacted'));
    expect(compactionTurn).toBeDefined();

    const doneTurn = turns.find(t => t.kind === 'done' && t.content?.includes('Inspection finished'));
    expect(doneTurn).toBeDefined();
  });

  it('omits malformed model attempts from subsequent model context', async () => {
    const agent = createCodingAgent({ maxTurns: 5 });

    let attempts = 0;
    const seenHistories: ChatMessage[][] = [];

    const runtime: AgentRuntime = {
      tools: [{ name: 'read', description: 'read', inputSchema: {} }],
      async *generate(req) {
        attempts++;
        seenHistories.push([...req.messages]);

        if (attempts === 1) {
          yield { type: 'token', content: 'I am thinking in prose without any JSON...' };
          yield { type: 'completed' };
        } else if (attempts === 2) {
          yield { type: 'token', content: JSON.stringify({ action: 'plan', content: 'Establish plan' }) };
          yield { type: 'completed' };
        } else {
          yield { type: 'token', content: JSON.stringify({ action: 'done', summary: 'Finished task' }) };
          yield { type: 'completed' };
        }
      },
      async executeTool() {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const turns: AgentTurn[] = [];
    for await (const turn of agent.run(baseRequest, runtime)) {
      turns.push(turn);
    }

    // Turn 1 yielded the invalid action message as execution evidence
    const invalidTurn = turns.find(t => t.kind === 'message' && t.content?.includes('INVALID_JSON_ACTION'));
    expect(invalidTurn).toBeDefined();

    // But subsequent model requests in seenHistories do NOT accumulate the malformed attempt as an assistant message
    expect(seenHistories.length).toBeGreaterThanOrEqual(2);
    const secondReqAssistantMessages = seenHistories[1].filter(m => m.role === 'assistant');
    expect(secondReqAssistantMessages.some(m => m.content.includes('I am thinking in prose'))).toBe(false);
  });
});
