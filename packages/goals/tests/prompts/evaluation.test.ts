import { describe, expect, it } from 'vitest';
import { evaluatePrompt, parseJsonOutput, type PromptEvalCase, type PromptRunner } from '../../src/prompts/index.js';
import { makeStudio, SELECT_DRAFT } from './helpers.js';

/** Deterministic fake model: picks the first eligible target id it sees in the rendered prompt. */
const fakeRunner: PromptRunner = async ({ rendered, prompt }) => {
  const match = /"(Y[0-9.]+)": "eligible"/.exec(rendered);
  if (prompt.template.includes('BROKEN')) return { output: 'I refuse to answer in JSON', modelId: 'fake-1' };
  return { output: match ? `\`\`\`json\n{"target_id":"${match[1]}","rationale":"eligible"}\n\`\`\`` : '{"target_id":null}', modelId: 'fake-1', costUsd: 0 };
};

const CASES: PromptEvalCase[] = [
  { id: 'picks-eligible', inputs: { target_ledger: { 'Y1.1': 'completed', 'Y1.2': 'eligible' }, resource_limits: {} }, expect: { subset: { target_id: 'Y1.2' }, contains: ['Y1.2'] } },
  { id: 'idle', inputs: { target_ledger: {}, resource_limits: {} }, expect: { equals: { target_id: null } } },
  { id: 'missing-input-rejected', inputs: { target_ledger: {} }, expect: { renderFails: true } },
];

describe('parseJsonOutput', () => {
  it('parses raw JSON, fenced JSON and objects; rejects prose', () => {
    expect(parseJsonOutput('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonOutput('Here:\n```json\n{"a":2}\n```')).toEqual({ ok: true, value: { a: 2 } });
    expect(parseJsonOutput({ a: 3 })).toEqual({ ok: true, value: { a: 3 } });
    expect(parseJsonOutput('nope')).toEqual({ ok: false });
  });
});

describe('evaluatePrompt', () => {
  it('runs cases with an injected runner and checks outputSchema + expectations', async () => {
    const { studio } = makeStudio();
    const def = (await studio.publish(SELECT_DRAFT, 'a')).prompt;
    const result = await evaluatePrompt(def, CASES, fakeRunner, { runnerId: 'fake' });
    expect(result).toMatchObject({ promptId: 'select_target', version: 1, digest: def.digest, runnerId: 'fake' });
    const byId = Object.fromEntries(result.cases.map((c) => [c.caseId, c]));
    expect(byId['picks-eligible'].passed).toBe(true);
    expect(byId['picks-eligible'].output).toEqual({ target_id: 'Y1.2', rationale: 'eligible' });
    expect(byId['picks-eligible'].checks.map((c) => c.name)).toEqual(['render', 'outputSchema', 'contains:Y1.2', 'subset']);
    // {"target_id":null} violates outputSchema (string, rationale required) even though `equals` passes.
    expect(byId.idle.passed).toBe(false);
    expect(byId.idle.checks.find((c) => c.name === 'outputSchema')?.passed).toBe(false);
    expect(byId.idle.checks.find((c) => c.name === 'equals')?.passed).toBe(true);
    expect(byId['missing-input-rejected'].passed).toBe(true);
    expect(result.summary).toMatchObject({ total: 3, passed: 2, failed: 1 });
  });

  it('records runner failures, timeouts, non-JSON output and unexpected render success as failed checks', async () => {
    const { studio } = makeStudio();
    const def = (await studio.publish({ ...SELECT_DRAFT, template: `${SELECT_DRAFT.template} BROKEN` }, 'a')).prompt;
    const throwing: PromptRunner = async () => { throw new Error('worker offline'); };
    const hanging: PromptRunner = () => new Promise(() => undefined);
    const ok = CASES[0];
    expect((await evaluatePrompt(def, [ok], throwing)).cases[0]).toMatchObject({ passed: false, error: 'worker offline' });
    expect((await evaluatePrompt(def, [ok], hanging, { timeoutMs: 20 })).cases[0].error).toMatch(/timed out/);
    const prose = (await evaluatePrompt(def, [ok], fakeRunner)).cases[0];
    expect(prose.passed).toBe(false);
    expect(prose.checks.find((c) => c.name === 'json')?.passed).toBe(false);
    const unexpected = (await evaluatePrompt(def, [{ id: 'x', inputs: ok.inputs, expect: { renderFails: true } }], fakeRunner)).cases[0];
    expect(unexpected.passed).toBe(false);
  });

  it('supports notContains, matches and opting out of schema validation', async () => {
    const { studio } = makeStudio();
    const def = (await studio.publish(SELECT_DRAFT, 'a')).prompt;
    const result = await evaluatePrompt(def, [{ id: 'm', inputs: CASES[1].inputs, expect: { validateOutputSchema: false, matches: 'target_id"\\s*:\\s*null', notContains: ['Y9'] } }], fakeRunner);
    expect(result.cases[0].passed).toBe(true);
  });

  it('rejects malformed case lists', async () => {
    const { studio } = makeStudio();
    const def = (await studio.publish(SELECT_DRAFT, 'a')).prompt;
    await expect(evaluatePrompt(def, [], fakeRunner)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(evaluatePrompt(def, [{ id: 'a', inputs: {} }, { id: 'a', inputs: {} }], fakeRunner)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(evaluatePrompt(def, [{ id: 'a', inputs: {}, expect: { matches: '(' } }], fakeRunner)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(evaluatePrompt(def, [{ id: 'a' } as unknown as PromptEvalCase], fakeRunner)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('PromptAdmin evaluation', () => {
  it('canEvaluate is false and evaluate throws INTERNAL without a runner', async () => {
    const { studio } = makeStudio();
    await studio.publish(SELECT_DRAFT, 'a');
    expect(studio.canEvaluate).toBe(false);
    await expect(studio.evaluate('select_target', 1, CASES, 'a')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('stores evaluation results per version and compares two versions on the same cases', async () => {
    const { studio } = makeStudio({ runner: fakeRunner, runnerId: 'fake' });
    expect(studio.canEvaluate).toBe(true);
    await studio.publish(SELECT_DRAFT, 'a');
    await studio.publish({ ...SELECT_DRAFT, template: `${SELECT_DRAFT.template} BROKEN` }, 'a');

    const latest = await studio.evaluate('select_target', undefined, CASES, 'user:op');
    expect(latest.version).toBe(2);
    const comparison = await studio.compareVersions('select_target', 1, 2, CASES, 'user:op');
    expect(comparison.perCase).toEqual([
      { caseId: 'picks-eligible', a: true, b: false, change: 'regressed' },
      { caseId: 'idle', a: false, b: false, change: 'same-fail' },
      { caseId: 'missing-input-rejected', a: true, b: true, change: 'same-pass' },
    ]);
    expect(comparison.diff.template.added).toBe(1);

    const all = await studio.evaluations('select_target');
    expect(all).toHaveLength(3);
    expect((await studio.evaluations('select_target', 1)).map((r) => r.version)).toEqual([1]);
    expect(all.every((r) => r.actor === 'user:op' && r.runnerId === 'fake')).toBe(true);
    // Evaluation records do not leak into version history.
    expect((await studio.history('select_target')).length).toBe(2);
  });
});
