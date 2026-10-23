import { describe, expect, it } from 'vitest';
import { diffJson, diffLines } from '../../src/prompts/index.js';
import { makeStudio, SELECT_DRAFT } from './helpers.js';

describe('diffLines', () => {
  it('produces equal/remove/add lines with line numbers', () => {
    const lines = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
    expect(lines).toEqual([
      { op: 'equal', text: 'a', aLine: 1, bLine: 1 },
      { op: 'remove', text: 'b', aLine: 2 },
      { op: 'add', text: 'B', bLine: 2 },
      { op: 'equal', text: 'c', aLine: 3, bLine: 3 },
      { op: 'equal', text: 'd', aLine: 4, bLine: 4 },
      { op: 'add', text: 'e', bLine: 5 },
    ]);
  });
  it('identical text is all equal; reconstructs both sides', () => {
    expect(diffLines('x\ny', 'x\ny').every((line) => line.op === 'equal')).toBe(true);
    const a = 'one\ntwo\nthree\nfour\nfive';
    const b = 'zero\none\nthree\nfour!\nfive\nsix';
    const lines = diffLines(a, b);
    expect(lines.filter((l) => l.op !== 'add').map((l) => l.text).join('\n')).toBe(a);
    expect(lines.filter((l) => l.op !== 'remove').map((l) => l.text).join('\n')).toBe(b);
  });
});

describe('diffJson', () => {
  it('reports added, removed and changed paths', () => {
    expect(diffJson({ a: 1, b: { c: 2 }, arr: [1] }, { a: 1, b: { c: 3, d: 4 }, arr: [1, 2] })).toEqual([
      { path: '/arr', kind: 'changed', from: [1], to: [1, 2] },
      { path: '/b/c', kind: 'changed', from: 2, to: 3 },
      { path: '/b/d', kind: 'added', to: 4 },
    ]);
    expect(diffJson(undefined, { type: 'object' })).toEqual([{ path: '/', kind: 'added', to: { type: 'object' } }]);
    expect(diffJson({ x: 1 }, undefined)).toEqual([{ path: '/', kind: 'removed', from: { x: 1 } }]);
  });
});

describe('PromptAdmin.diff', () => {
  it('diffs template, role, capabilities and schemas between versions', async () => {
    const { studio } = makeStudio();
    await studio.publish(SELECT_DRAFT, 'a');
    await studio.publish({
      ...SELECT_DRAFT,
      role: 'scheduler_v2',
      template: SELECT_DRAFT.template.replace('choose a target', 'choose the best target'),
      requiredCapabilities: ['reasoning', 'coding'],
      outputSchema: { ...SELECT_DRAFT.outputSchema, required: ['target_id'] },
    }, 'a');
    const diff = await studio.diff('select_target', 1, 2);
    expect(diff.identical).toBe(false);
    expect(diff.template).toMatchObject({ added: 1, removed: 1 });
    expect(diff.role).toEqual({ from: 'portfolio_scheduler', to: 'scheduler_v2' });
    expect(diff.requiredCapabilities).toEqual({ added: ['coding'], removed: ['generalChat'] });
    expect(diff.inputSchema).toEqual([]);
    expect(diff.outputSchema).toEqual([{ path: '/required', kind: 'changed', from: ['target_id', 'rationale'], to: ['target_id'] }]);
    expect((await studio.diff('select_target', 2, 2)).identical).toBe(true);
  });
});
