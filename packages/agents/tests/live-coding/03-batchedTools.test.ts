import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';
import { createCodingAgent } from '../../src/codingAgent.js';

async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const out: AgentTurn[] = [];
  for await (const t of turns) out.push(t);
  return out;
}

describe('LIVE-CODE-03: Batched Tool Execution & Parallel Call Guardrails (Release Gate G3)', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects uncoalesced parallel native tool calls in a single turn and recovers cleanly on sequential reissue', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-live03-batch-'));
    await fs.writeFile(path.join(projectRoot, 'a.txt'), 'alpha');
    await fs.writeFile(path.join(projectRoot, 'b.txt'), 'beta');

    const agent = createCodingAgent();
    const executedReads: string[] = [];
    let turn = 0;

    const runtime: AgentRuntime = {
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
      runtimeCapabilities: { toolCalling: true, nativeToolCalling: true },
      getCapabilities: () => ({ toolCalling: true, nativeToolCalling: true }),
      async *generate() {
        turn += 1;
        if (turn === 1) {
          // Emit two parallel native tool calls in a single turn
          yield { type: 'tool_call' as const, toolCallId: 'c1', toolName: 'read', toolInput: { path: 'a.txt' } };
          yield { type: 'tool_call' as const, toolCallId: 'c2', toolName: 'read', toolInput: { path: 'b.txt' } };
          yield { type: 'completed' as const, content: '', finishReason: 'tool_calls' };
        } else if (turn === 2) {
          yield { type: 'tool_call' as const, toolCallId: 'c3', toolName: 'read', toolInput: { path: 'a.txt' } };
          yield { type: 'completed' as const, content: '', finishReason: 'tool_calls' };
        } else if (turn === 3) {
          yield { type: 'tool_call' as const, toolCallId: 'c4', toolName: 'read', toolInput: { path: 'b.txt' } };
          yield { type: 'completed' as const, content: '', finishReason: 'tool_calls' };
        } else {
          yield {
            type: 'tool_call' as const,
            toolCallId: 'c5',
            toolName: 'done',
            toolInput: { summary: 'Read both files: alpha and beta' },
          };
          yield { type: 'completed' as const, content: '', finishReason: 'tool_calls' };
        }
      },
      async executeTool(name, input): Promise<ToolResult> {
        if (name === 'read') {
          const p = String(input.path);
          executedReads.push(p);
          const content = await fs.readFile(path.join(projectRoot, p), 'utf8');
          return { ok: true, output: content, durationMs: 1 };
        }
        return { ok: true, output: '', durationMs: 1 };
      },
    };

    const turns = await drain(
      agent.run(
        {
          modelId: 'fake-model',
          taskDescription: 'Read a.txt and b.txt and summarize their contents.',
          taskType: 'code_analysis',
          mutationRequired: false,
          projectRoot,
          maxTurns: 8,
        },
        runtime,
      ),
    );

    // Turn 1's parallel batch must be rejected without executing either call
    const rejectionMsg = turns.find(
      (t) => t.kind === 'message' && t.content?.includes('PARALLEL_TOOL_CALLS_REJECTED: 2 calls in one turn'),
    );
    expect(rejectionMsg).toBeDefined();

    // Subsequent sequential reads execute deterministically in order
    expect(executedReads).toEqual(['a.txt', 'b.txt']);

    const doneTurn = turns.find((t) => t.kind === 'done');
    expect(doneTurn).toBeDefined();
    expect(doneTurn?.content).toContain('alpha and beta');
  });
});
