import { describe, it, expect } from 'vitest';
import { computeSmartEdit } from '../src/editMatcher.js';

describe('computeSmartEdit — Qwen Code 1.0 3-stage matcher', () => {
  it('Stage 1A: exact match replaces literally (including $& sequences) and produces compact diff', () => {
    const raw = 'const price = PLACEHOLDER;\nexport default price;\n';
    const res = computeSmartEdit(raw, 'PLACEHOLDER', "'$&100'");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.strategyUsed).toBe('exact');
    expect(res.nextContent).toBe("const price = '$&100';\nexport default price;\n");
    expect(res.diffSnippet).toContain('@@ -1,1 +1,1 @@');
  });

  it('Stage 1B: CRLF-normalized exact match preserves CRLF line endings', () => {
    const raw = 'function add(a, b) {\r\n  return a - b;\r\n}\r\n';
    const res = computeSmartEdit(raw, 'function add(a, b) {\n  return a - b;\n}', 'function add(a, b) {\n  return a + b;\n}');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.strategyUsed).toBe('crlf_normalized');
    expect(res.nextContent).toBe('function add(a, b) {\r\n  return a + b;\r\n}\r\n');
  });

  it('Stage 1 ambiguity: refuses multiple exact matches unless replaceAll is true', () => {
    const raw = 'const x = 1;\nconst y = 1;\n';
    const fail = computeSmartEdit(raw, '1', '2', false);
    expect(fail.ok).toBe(false);
    if (fail.ok) return;
    expect(fail.error).toContain('matched 2 locations');

    const all = computeSmartEdit(raw, '1', '2', true);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.nextContent).toBe('const x = 2;\nconst y = 2;\n');
    expect(all.count).toBe(2);
  });

  it('Stage 2: line-trimmed match handles indentation drift while preserving file indentation', () => {
    const raw = [
      'class Calculator {',
      '    computeTotal(items) {',
      '        let sum = 0;',
      '        return sum;',
      '    }',
      '}',
      '',
    ].join('\n');

    // Model supplied 2-space indent instead of 4/8-space indent
    const oldSnippet = ['  computeTotal(items) {', '    let sum = 0;', '    return sum;', '  }'].join('\n');
    const newSnippet = [
      '  computeTotal(items) {',
      '    let sum = 0;',
      '    for (const n of items) sum += n;',
      '    return sum;',
      '  }',
    ].join('\n');

    const res = computeSmartEdit(raw, oldSnippet, newSnippet);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.strategyUsed).toBe('line_trimmed');
    expect(res.nextContent).toContain('    computeTotal(items) {');
    expect(res.nextContent).toContain('      for (const n of items) sum += n;');
  });

  it('Stage 3: block-anchor match handles interior whitespace differences when anchors are unique', () => {
    const raw = [
      'export function validateRange(val: number) {',
      '  if (val < 0 ||   val > 100) {',
      '    throw new RangeError("out of bounds");',
      '  }',
      '  return val;',
      '}',
    ].join('\n');

    // Interior line has single space instead of triple space (`val < 0 || val > 100`)
    const oldSnippet = [
      'export function validateRange(val: number) {',
      '  if (val < 0 || val > 100) {',
      '    throw new RangeError("out of bounds");',
      '  }',
      '  return val;',
      '}',
    ].join('\n');
    const newSnippet = [
      'export function validateRange(val: number) {',
      '  if (val < 0 || val > 1000) {',
      '    throw new RangeError("out of bounds");',
      '  }',
      '  return val;',
      '}',
    ].join('\n');

    const res = computeSmartEdit(raw, oldSnippet, newSnippet);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.strategyUsed).toBe('block_anchor');
    expect(res.nextContent).toContain('val > 1000');
  });

  it('Failure diagnostics: includes "oldString not found in file" plus closest numbered lines', () => {
    const raw = ['line 1', 'function computeTax(amount) {', '  return amount * 0.08;', '}', 'line 5'].join('\n');
    const res = computeSmartEdit(raw, 'function computeTax(amount) {\n  return amount * 0.99;\n}', 'noop');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('oldString not found in file');
    expect(res.error).toContain('2: function computeTax(amount) {');
    expect(res.error).toContain('3:   return amount * 0.08;');
  });
});
