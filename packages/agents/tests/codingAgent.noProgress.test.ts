import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import { observationFingerprint } from '../src/diagnostics.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

/**
 * Regression coverage for semantic no-progress detection (Phase 13) and REPEATED_ACTION
 * termination. The exact-repeat circuit breaker (codingAgent.circuitBreaker.test.ts)
 * only catches byte-identical calls; these cover syntactically different calls that
 * teach the agent nothing new and change nothing on disk.
 */
async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

const baseRequest: AgentRunRequest = {
  modelId: 'fake-model',
  taskDescription: 'fix the c++ sort',
  taskType: 'coding',
  projectRoot: '/tmp/fake-project',
};

function scriptedRuntime(
  replies: (n: number) => string,
  execute: (name: string, input: Record<string, unknown>) => ToolResult,
): { runtime: AgentRuntime; counters: { executed: number } } {
  const counters = { executed: 0 };
  let n = 0;
  const runtime: AgentRuntime = {
    tools: [
      { name: 'glob', description: 'glob', inputSchema: {} },
      { name: 'shell', description: 'shell', inputSchema: {} },
      { name: 'write', description: 'write', inputSchema: {} },
    ],
    async *generate() {
      n += 1;
      const reply = replies(n);
      yield { type: 'token', content: reply };
      yield { type: 'completed', content: reply };
    },
    async executeTool(name, input): Promise<ToolResult> {
      counters.executed += 1;
      return execute(name, input);
    },
  };
  return { runtime, counters };
}

describe('observationFingerprint', () => {
  it('collapses differently-worded empty results into one fingerprint', () => {
    const a = observationFingerprint({ ok: true, output: '' });
    const b = observationFingerprint({ ok: true, output: 'No matches found.' });
    const c = observationFingerprint({ ok: true, output: '  none \n' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('distinguishes genuinely different successful observations', () => {
    expect(observationFingerprint({ ok: true, output: 'src/a.cpp' })).not.toBe(
      observationFingerprint({ ok: true, output: 'src/b.cpp' }),
    );
  });
});

describe('CodingAgent.run — semantic no-progress', () => {
  it('stops with NO_PROGRESS when syntactically different searches keep returning nothing', async () => {
    const searches = [
      '{"action":"tool","tool":"glob","input":{"pattern":"*.cpp"}}',
      '{"action":"tool","tool":"glob","input":{"pattern":"**/*.cpp"}}',
      '{"action":"tool","tool":"shell","input":{"command":"find . -name \'*.cpp\'"}}',
      '{"action":"tool","tool":"glob","input":{"pattern":"src/**/*.cpp"}}',
      '{"action":"tool","tool":"shell","input":{"command":"ls *.cpp"}}',
    ];
    const { runtime, counters } = scriptedRuntime(
      (n) => (n === 1 ? '{"action":"plan","content":"find sources"}' : searches[(n - 2) % searches.length]),
      (name) => ({ ok: true, output: name === 'glob' ? 'No matches found.' : '', durationMs: 1 }),
    );

    const turns = await drain(
      createCodingAgent({ maxNoProgressIterations: 3, toolRepeatLimit: 10 }).run({ ...baseRequest, maxTurns: 50 }, runtime),
    );
    const last = turns.at(-1);

    expect(last?.kind).toBe('error');
    expect(last?.terminationReason).toBe('NO_PROGRESS');
    // First empty result is new information; the next 3 are not.
    expect(counters.executed).toBe(4);
  });

  it('a physical file change resets the no-progress streak', async () => {
    let n = 0;
    const { runtime } = scriptedRuntime(
      () => {
        n += 1;
        if (n === 1) return '{"action":"plan","content":"p"}';
        if (n === 4) return '{"action":"tool","tool":"write","input":{"path":"a.cpp","content":"int main(){}"}}';
        if (n >= 6) return '{"action":"done","summary":"done"}';
        return `{"action":"tool","tool":"glob","input":{"pattern":"p${n}"}}`;
      },
      (name, input) =>
        name === 'write'
          ? { ok: true, output: 'written', durationMs: 1, fileMutations: [{ path: String(input.path), attempted: true, succeeded: true, existedBefore: false, existsAfter: true, beforeHash: 'a', afterHash: 'b', changed: true }] }
          : { ok: true, output: '', durationMs: 1 },
    );

    const turns = await drain(
      createCodingAgent({ maxNoProgressIterations: 2 }).run({ ...baseRequest, maxTurns: 50, mutationRequired: false }, runtime),
    );

    expect(turns.some((t) => t.terminationReason === 'NO_PROGRESS')).toBe(false);
  });

  it('a per-request maxNoProgressIterations overrides the constructor default', async () => {
    const { runtime, counters } = scriptedRuntime(
      (n) => (n === 1 ? '{"action":"plan","content":"p"}' : `{"action":"tool","tool":"glob","input":{"pattern":"x${n}"}}`),
      () => ({ ok: true, output: '', durationMs: 1 }),
    );

    const turns = await drain(
      createCodingAgent({ maxNoProgressIterations: 50 }).run({ ...baseRequest, maxTurns: 50, maxNoProgressIterations: 1 }, runtime),
    );

    expect(turns.at(-1)?.terminationReason).toBe('NO_PROGRESS');
    expect(counters.executed).toBe(2);
  });
});

describe('CodingAgent.run — repeated action', () => {
  it('terminates with REPEATED_ACTION when the model ignores the duplicate-action correction', async () => {
    const { runtime, counters } = scriptedRuntime(
      (n) => (n === 1 ? '{"action":"plan","content":"p"}' : '{"action":"tool","tool":"shell","input":{"command":"make"}}'),
      // Novel output each time, so only the exact-repeat path can stop this.
      () => ({ ok: false, output: `attempt ${counters.executed}`, error: 'failed', durationMs: 1 }),
    );

    const turns = await drain(
      createCodingAgent({ toolRepeatLimit: 3, maxNoProgressIterations: 50 }).run({ ...baseRequest, maxTurns: 50 }, runtime),
    );
    const last = turns.at(-1);

    expect(last?.kind).toBe('error');
    expect(last?.terminationReason).toBe('REPEATED_ACTION');
    expect(counters.executed).toBe(2);
  });
});
