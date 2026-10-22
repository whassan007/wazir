import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

/**
 * Regression coverage for a live-audit finding (2026-10-17, test/agy-mac-gemma): a trivial
 * prompt ("What is 23 + 19?") that made zero real file changes was still run through the full
 * build/test/lint/typecheck battery against the whole project — 3m40s of unrelated monorepo
 * build failures (a Tauri desktop build reaching for the network) for a one-token answer.
 * VERIFY already fails a mutation-required task with "no code modifications" when nothing
 * changed; running checks in that case adds nothing and only wastes time / produces noise.
 */

async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

const baseRequest: Omit<AgentRunRequest, 'maxTurns'> = {
  modelId: 'fake-model',
  taskDescription: 'Update src/index.ts to fix the calculation bug.',
  taskType: 'coding',
  projectRoot: '/tmp/fake-project',
};

describe('CodingAgent.run — verify phase skips build/test/lint/typecheck when nothing changed', () => {
  it('a coding task that answers without writing any file does not run the check battery and surfaces the answer', async () => {
    const executed: string[] = [];
    const runtime: AgentRuntime = {
      tools: [{ name: 'shell', description: 'run a shell command', inputSchema: {} }],
      async *generate() {
        const reply = '{"action":"done","summary":"42"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name): Promise<ToolResult> {
        executed.push(name);
        return { ok: true, output: `ok:${name}`, durationMs: 1 };
      },
    };
    const agent = createCodingAgent();
    const turns = await drain(agent.run({ ...baseRequest, maxTurns: 5 }, runtime));
    const last = turns.at(-1);

    // The existing, correct failure signal must still fire — nothing was written, so this
    // was never a legitimate completion for a mutation-required coding task.
    expect(last?.kind).toBe('error');
    expect(last?.error).toContain('no code modifications');
    expect(last?.content).toBe('42');
    // But it must not have wasted time running build/test/lint/typecheck to get there.
    expect(executed).not.toContain('build');
    expect(executed).not.toContain('test');
    expect(executed).not.toContain('lint');
    expect(executed).not.toContain('typecheck');
  });

  it('a coding task that modifies a file still runs the check battery during VERIFY', async () => {
    const executed: string[] = [];
    let turn = 0;
    const runtime: AgentRuntime = {
      tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
      async *generate() {
        turn += 1;
        const reply =
          turn === 1
            ? '{"action":"plan","content":"update src/index.ts"}'
            : turn === 2
              ? '{"action":"tool","tool":"write","input":{"path":"src/index.ts","content":"export const x = 42;"}}'
              : '{"action":"done","summary":"updated"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name): Promise<ToolResult> {
        executed.push(name);
        return { ok: true, output: `ok:${name}`, durationMs: 1 };
      },
    };
    const agent = createCodingAgent();
    const turns = await drain(agent.run({ ...baseRequest, maxTurns: 5 }, runtime));
    const last = turns.at(-1);

    expect(last?.kind).toBe('done');
    expect(executed).toContain('build');
    expect(executed).toContain('test');
  });
});
