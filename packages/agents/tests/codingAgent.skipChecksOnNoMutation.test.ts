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
  taskDescription: 'What is 23 + 19? Return only the number.',
  taskType: 'coding',
  projectRoot: '/tmp/fake-project',
};

describe('CodingAgent.run — verify phase skips build/test/lint/typecheck when nothing changed', () => {
  it('a coding task that answers without writing any file does not run the check battery', async () => {
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
    // But it must not have wasted time running build/test/lint/typecheck to get there.
    expect(executed).not.toContain('build');
    expect(executed).not.toContain('test');
    expect(executed).not.toContain('lint');
    expect(executed).not.toContain('typecheck');
  });

  it('a verify-only task (mutationRequired: false) with no changes still runs the check battery', async () => {
    // The opposite case: when a task explicitly does not expect a mutation (e.g. "just run
    // the test suite and tell me if it's green"), checks must still run even though nothing
    // was written — skipping them here would defeat the point of the task.
    const executed: string[] = [];
    const runtime: AgentRuntime = {
      tools: [{ name: 'shell', description: 'run a shell command', inputSchema: {} }],
      async *generate() {
        const reply = '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name): Promise<ToolResult> {
        executed.push(name);
        return { ok: true, output: `ok:${name}`, durationMs: 1 };
      },
    };
    const agent = createCodingAgent();
    const turns = await drain(agent.run({ ...baseRequest, mutationRequired: false, maxTurns: 5 }, runtime));
    const last = turns.at(-1);

    expect(last?.kind).toBe('done');
    expect(executed).toContain('build');
    expect(executed).toContain('test');
  });
});
