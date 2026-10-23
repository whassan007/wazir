import { describe, expect, it, vi } from 'vitest';
import {
  ChatAgent,
  createCodingAgent,
  createStepAgent,
  isConversationalFastPathRequest,
} from '../src/index.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

describe('ISS-006: Fast-path classification and expected-file/mutation guardrails', () => {
  it('returns false for question-phrased or multi-clause workspace mutation requests', () => {
    expect(isConversationalFastPathRequest('Can you fix the bug in the login handler?')).toBe(false);
    expect(isConversationalFastPathRequest('Why is auth failing? Update the configuration')).toBe(false);
    expect(isConversationalFastPathRequest('Can you patch the regression in the router?')).toBe(false);
    expect(isConversationalFastPathRequest('What is causing the crash? Modify the controller to handle null')).toBe(false);
    expect(isConversationalFastPathRequest('Could you add a validation check to the middleware?')).toBe(false);
    expect(isConversationalFastPathRequest('Fix the authentication bug?')).toBe(false);
  });

  it('returns false when expectedFiles or mutationRequired is set, even when type is chat', () => {
    expect(
      isConversationalFastPathRequest('What is 2 + 2?', {
        type: 'chat',
        mutationRequired: true,
      }),
    ).toBe(false);

    expect(
      isConversationalFastPathRequest('Reply with hello', {
        type: 'chat',
        expectedFiles: ['foo.ts'],
      }),
    ).toBe(false);

    expect(
      isConversationalFastPathRequest('Explain the architecture', {
        expectedFiles: ['docs/arch.md'],
      }),
    ).toBe(false);
  });

  it('preserves fast-path classification for genuine conversational, arithmetic, and inline snippet prompts', () => {
    expect(isConversationalFastPathRequest('What is 23 + 19?')).toBe(true);
    expect(isConversationalFastPathRequest('Explain how to fix this function')).toBe(true);
    expect(isConversationalFastPathRequest('Write a function that removes duplicates')).toBe(true);
    expect(isConversationalFastPathRequest('Find and fix the bug in this Python function: def f(x): return x - 1')).toBe(true);
    expect(isConversationalFastPathRequest('Reply with 4', { type: 'chat' })).toBe(true);
  });

  it('ChatAgent rejects requests with mutationRequired: true or expectedArtifacts with VERIFICATION_FAILED', async () => {
    const generate = vi.fn(async function* () {
      yield { type: 'token' as const, content: 'hello' };
      yield { type: 'completed' as const, content: 'hello' };
    });
    const runtime: AgentRuntime = {
      generate,
      tools: [],
      executeTool: vi.fn(),
      cancelCurrentTurn: vi.fn(),
    };
    const agent = new ChatAgent();

    const mutationTurns = await drain(
      agent.run(
        {
          modelId: 'test-model',
          taskDescription: 'Reply with hello',
          taskType: 'chat',
          projectRoot: '/tmp/test',
          mutationRequired: true,
        },
        runtime,
      ),
    );
    expect(mutationTurns).toHaveLength(1);
    expect(mutationTurns[0]).toMatchObject({
      kind: 'error',
      terminationReason: 'VERIFICATION_FAILED',
    });
    expect(mutationTurns[0].error).toContain('ChatAgent cannot satisfy file mutation or expected-artifact requirements');
    expect(generate).not.toHaveBeenCalled();

    const artifactTurns = await drain(
      agent.run(
        {
          modelId: 'test-model',
          taskDescription: 'Reply with hello',
          taskType: 'chat',
          projectRoot: '/tmp/test',
          expectedArtifacts: ['foo.ts'],
        },
        runtime,
      ),
    );
    expect(artifactTurns).toHaveLength(1);
    expect(artifactTurns[0]).toMatchObject({
      kind: 'error',
      terminationReason: 'VERIFICATION_FAILED',
    });
    expect(artifactTurns[0].error).toContain('ChatAgent cannot satisfy file mutation or expected-artifact requirements');
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('ISS-007: Terminal provider completion and partial streaming timeout safety', () => {
  it('ChatAgent rejects silent EOF streams that emit tokens without a completed event', async () => {
    const runtime: AgentRuntime = {
      async *generate() {
        yield { type: 'token', content: 'partial answer before connection dropped' };
      },
      tools: [],
      executeTool: vi.fn(),
      cancelCurrentTurn: vi.fn(),
    };
    const turns = await drain(
      new ChatAgent().run(
        {
          modelId: 'test-model',
          taskDescription: 'What is 12 + 19?',
          taskType: 'chat',
          projectRoot: '/tmp/test',
        },
        runtime,
      ),
    );
    expect(turns.some((t) => t.kind === 'done')).toBe(false);
    expect(turns.at(-1)).toMatchObject({
      kind: 'error',
      error: expect.stringContaining('INCOMPLETE_PROVIDER_STREAM'),
    });
  });

  it('CodingAgent conversational fast-path rejects silent EOF streams instead of returning partial output as VERIFICATION_PASSED', async () => {
    const runtime: AgentRuntime = {
      tools: [],
      async *generate() {
        yield { type: 'token', content: 'partial fast-path answer without completed event' };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: '', durationMs: 0 };
      },
    };
    const agent = createCodingAgent();
    await expect(
      drain(
        agent.run(
          {
            modelId: 'test-model',
            taskDescription: 'What is 12 + 19?',
            taskType: 'chat',
            projectRoot: '/tmp/test',
          },
          runtime,
        ),
      ),
    ).rejects.toThrow(/INCOMPLETE_PROVIDER_STREAM/);
  });

  it('CodingAgent conversational fast-path does NOT return truncated partial output as VERIFICATION_PASSED when fastTimedOut triggers mid-stream', async () => {
    let cancelCalls = 0;
    let release: (() => void) | undefined;
    const runtime: AgentRuntime = {
      tools: [],
      cancelCurrentTurn() {
        cancelCalls += 1;
        release?.();
      },
      async *generate() {
        yield { type: 'token', content: 'Truncated partial answer before timeout...' };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { type: 'completed', content: 'Truncated partial answer before timeout...' };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: '', durationMs: 0 };
      },
    };

    const agent = createCodingAgent({ modelTurnTimeoutMs: 15, maxTurns: 4 });
    const turns = await drain(
      agent.run(
        {
          modelId: 'test-model',
          taskDescription: 'What is 12 + 19?',
          taskType: 'chat',
          projectRoot: '/tmp/test',
        },
        runtime,
      ),
    );

    expect(cancelCalls).toBeGreaterThan(0);
    expect(turns.some((t) => t.kind === 'done')).toBe(false);
    expect(turns.at(-1)?.kind).toBe('error');
  });

  it('CodingAgent standard modelTurn rejects silent EOF streams without a completed event', async () => {
    const runtime: AgentRuntime = {
      tools: [{ name: 'write', description: 'write file', inputSchema: {} }],
      async *generate() {
        yield { type: 'token', content: '{"action":"done","summary":"premature eof"}' };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: '', durationMs: 0 };
      },
    };
    const agent = createCodingAgent();
    await expect(
      drain(
        agent.run(
          {
            modelId: 'test-model',
            taskDescription: 'Create src/index.ts',
            taskType: 'coding',
            projectRoot: '/tmp/test',
            mutationRequired: true,
          },
          runtime,
        ),
      ),
    ).rejects.toThrow(/INCOMPLETE_PROVIDER_STREAM/);
  });

  it('StepAgent surfaces INCOMPLETE_PROVIDER_STREAM error when stream ends without completed event', async () => {
    const runtime: AgentRuntime = {
      tools: [{ name: 'write', description: 'write file', inputSchema: {} }],
      async *generate() {
        yield { type: 'token', content: '{"action":"done","summary":"premature eof"}' };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: '', durationMs: 0 };
      },
    };
    const agent = createStepAgent();
    const turns = await drain(
      agent.run(
        {
          modelId: 'test-model',
          taskDescription: 'Create src/main.cpp',
          taskType: 'coding',
          projectRoot: '/tmp/test',
        },
        runtime,
      ),
    );

    expect(turns.some((t) => t.kind === 'done')).toBe(false);
    expect(turns.at(-1)).toMatchObject({
      kind: 'error',
      error: expect.stringContaining('INCOMPLETE_PROVIDER_STREAM'),
    });
  });
});
