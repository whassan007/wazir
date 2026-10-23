import { describe, expect, it } from 'vitest';
import { renderPrompt } from '../../src/prompts/index.js';
import { fixturePromptSeeds, makeStudio } from './helpers.js';

describe('seedFromGraph (nobel fixture prompts)', () => {
  const seeds = fixturePromptSeeds();

  it('the test extractor finds the fixture specialist prompts', () => {
    expect(seeds.length).toBeGreaterThanOrEqual(8);
    const keys = seeds.map((s) => s.executorKey);
    expect(keys).toEqual(expect.arrayContaining(['load_ledger', 'select_target', 'plan_target', 'formal_verify', 'research_author']));
    expect(seeds.find((s) => s.executorKey === 'select_target')?.template).toContain('{{target_ledger}}');
  });

  it('seeds every prompt at v1 with a derived input schema, and is idempotent', async () => {
    const { studio } = makeStudio();
    const first = await studio.seedFromGraph(seeds, 'system:seed');
    expect(first.every((r) => r.created && r.prompt.version === 1 && r.prompt.source === 'seed')).toBe(true);
    const select = await studio.latest('select_target');
    expect(select?.inputSchema).toEqual({ type: 'object', required: ['target_ledger', 'resource_limits'], properties: { target_ledger: {}, resource_limits: {} } });
    expect(() => renderPrompt(select!, { target_ledger: 'x' })).toThrow(/resource_limits/);
    expect((await studio.latest('load_ledger'))?.inputSchema).toBeUndefined(); // no variables

    const second = await studio.seedFromGraph(seeds, 'system:seed');
    expect(second.every((r) => !r.created && r.prompt.version === 1)).toBe(true);
    expect((await studio.list()).length).toBe(seeds.length);
  });

  it('re-seeding never reverts an operator edit; a changed seed appends a version', async () => {
    const { studio } = makeStudio();
    await studio.seedFromGraph(seeds, 'system:seed');
    const original = seeds.find((s) => s.executorKey === 'plan_target')!;
    await studio.publish({ ...original, template: `${original.template}\nOperator addendum.` }, 'user:op');
    await studio.seedFromGraph(seeds, 'system:seed');
    expect((await studio.latest('plan_target'))?.template).toContain('Operator addendum.');
    expect((await studio.history('plan_target')).length).toBe(2);

    const changed = seeds.map((s) => (s.executorKey === 'plan_target' ? { ...s, template: `${s.template}\nGraph v2 change.` } : s));
    const results = await studio.seedFromGraph(changed, 'system:seed');
    expect(results.filter((r) => r.created).map((r) => r.prompt.executorKey)).toEqual(['plan_target']);
    expect((await studio.latest('plan_target'))?.version).toBe(3);
  });

  it('accepts capabilities and schemas on seeds', async () => {
    const { studio } = makeStudio();
    const [result] = await studio.seedFromGraph([{ executorKey: 'formal_verify', role: 'formal_methods_engineer', template: 'Verify {{task}}', requiredCapabilities: ['reasoning', 'coding'], outputSchema: { type: 'object' } }], 'system:seed');
    expect(result.prompt).toMatchObject({ requiredCapabilities: ['coding', 'reasoning'], outputSchema: { type: 'object' } });
  });
});
