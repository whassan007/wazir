import { describe, expect, it } from 'vitest';
import {
  classifyFastPath,
  FastPathClassifierCache,
  tryEvaluateDeterministicFastPath,
} from '../src/fastPathClassifier.js';

describe('fastPathClassifier (Agent 06)', () => {
  it('evaluates pure arithmetic expressions deterministically without eval()', () => {
    const res1 = tryEvaluateDeterministicFastPath('What is 17 * 23?');
    expect(res1).toEqual({
      matched: true,
      answer: '391',
      kind: 'arithmetic',
    });

    const res2 = tryEvaluateDeterministicFastPath('(144 / 12) + 89');
    expect(res2).toEqual({
      matched: true,
      answer: '101',
      kind: 'arithmetic',
    });

    const res3 = tryEvaluateDeterministicFastPath('Calculate (50 - 14) * 3 / 2');
    expect(res3).toEqual({
      matched: true,
      answer: '54',
      kind: 'arithmetic',
    });

    const decision = classifyFastPath('What is 17 * 23?');
    expect(decision.category).toBe('deterministic_compute');
    expect(decision.bypassMultiTurnPlanning).toBe(true);
    expect(decision.requiredTools).toEqual([]);
    expect(decision.deterministicEvaluation?.answer).toBe('391');
  });

  it('evaluates literal echo and READY probes deterministically', () => {
    const probe = tryEvaluateDeterministicFastPath('Reply with ONLY the single word READY.');
    expect(probe).toEqual({
      matched: true,
      answer: 'READY',
      kind: 'ready_probe',
    });

    const decision = classifyFastPath('Reply with ONLY the single word READY.');
    expect(decision.category).toBe('deterministic_compute');
    expect(decision.deterministicEvaluation?.answer).toBe('READY');
    expect(decision.requiredTools).toEqual([]);
  });

  it('evaluates deterministic string length, string reversal, and base conversion', () => {
    expect(tryEvaluateDeterministicFastPath('What is the length of "antigravity"?')).toEqual({
      matched: true,
      answer: '11',
      kind: 'string_length',
    });

    expect(tryEvaluateDeterministicFastPath('Reverse the string "wazir"')).toEqual({
      matched: true,
      answer: 'rizaw',
      kind: 'string_reverse',
    });

    expect(tryEvaluateDeterministicFastPath('Convert 255 to hex')).toEqual({
      matched: true,
      answer: 'ff',
      kind: 'base_conversion',
    });
  });

  it('classifies short conceptual/factual questions as single_turn_factual with zero tools', () => {
    const d1 = classifyFastPath('What is the difference between TCP and UDP?');
    expect(d1.category).toBe('single_turn_factual');
    expect(d1.bypassMultiTurnPlanning).toBe(true);
    expect(d1.requiredTools).toEqual([]);

    const d2 = classifyFastPath('Explain Big-O notation in simple terms');
    expect(d2.category).toBe('single_turn_factual');
    expect(d2.requiredTools).toEqual([]);
  });

  it('classifies explicit single-file inspection prompts as direct_file_read requiring only the read tool', () => {
    const d1 = classifyFastPath('Read packages/core/src/index.ts');
    expect(d1.category).toBe('direct_file_read');
    expect(d1.requiredTools).toEqual(['read']);
    expect(d1.targetFilePath).toBe('packages/core/src/index.ts');
    expect(d1.bypassMultiTurnPlanning).toBe(true);

    const d2 = classifyFastPath('Please show the file README.md.');
    expect(d2.category).toBe('direct_file_read');
    expect(d2.requiredTools).toEqual(['read']);
    expect(d2.targetFilePath).toBe('README.md');
  });

  it('falls back to full_agent_loop for coding, refactoring, debugging, testing, or mutation tasks', () => {
    expect(
      classifyFastPath('Refactor packages/agents/src/codingAgent.ts to reduce complexity and run the tests').category,
    ).toBe('full_agent_loop');

    expect(
      classifyFastPath('Fix the failing unit test in packages/core/tests/scheduler.test.ts').category,
    ).toBe('full_agent_loop');

    expect(
      classifyFastPath('What is the capital of France?', { hasWorkspaceMutationsRequired: true }).category,
    ).toBe('full_agent_loop');
  });

  it('rejects code-injection strings, workspace file mentions, and division by zero in deterministic evaluator', () => {
    expect(tryEvaluateDeterministicFastPath('1 + 1; process.exit(1)').matched).toBe(false);
    expect(tryEvaluateDeterministicFastPath('eval("7 * 7")').matched).toBe(false);
    expect(tryEvaluateDeterministicFastPath('What is 10 / 0?').matched).toBe(false);
    expect(tryEvaluateDeterministicFastPath('What is 17 * 23 in packages/core/index.ts?').matched).toBe(false);
    expect(tryEvaluateDeterministicFastPath('```js\n17 * 23\n```').matched).toBe(false);
    expect(classifyFastPath('1 + 1; process.exit(1)').category).toBe('full_agent_loop');
  });

  it('maintains bounded LRU cache and serves repeated classifications in sub-millisecond time', () => {
    const cache = new FastPathClassifierCache(3);

    const r1 = cache.classify('What is 12 + 34?');
    expect(r1.category).toBe('deterministic_compute');
    expect(cache.stats).toEqual({ size: 1, maxEntries: 3, hits: 0, misses: 1 });

    // Hit on normalized whitespace
    const r1Repeat = cache.classify('   What   is 12 + 34?  ');
    expect(r1Repeat).toBe(r1);
    expect(cache.stats.hits).toBe(1);

    cache.classify('What is 5 * 5?');
    cache.classify('What is 6 * 6?');
    expect(cache.size).toBe(3);

    // Refresh 'What is 12 + 34?' so 'What is 5 * 5?' becomes the oldest entry
    cache.get('What is 12 + 34?');
    cache.classify('What is 7 * 7?');
    expect(cache.size).toBe(3);
    expect(cache.get('What is 5 * 5?')).toBeUndefined();
    expect(cache.get('What is 12 + 34?')).toBeDefined();

    // Benchmark 1,000 cached lookups (<10ms total, i.e., <0.01ms per lookup)
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      cache.classify('What is 12 + 34?');
    }
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(25);
  });
});
