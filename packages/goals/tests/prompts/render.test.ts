import { describe, expect, it } from 'vitest';
import { GoalStudioFailure } from '../../src/contracts.js';
import { deriveInputSchema, lintPrompt, renderPrompt, templateVariables } from '../../src/prompts/index.js';
import { SELECT_DRAFT } from './helpers.js';

function renderError(fn: () => unknown): GoalStudioFailure {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GoalStudioFailure);
    return error as GoalStudioFailure;
  }
  throw new Error('expected render to fail');
}

describe('renderPrompt', () => {
  it('substitutes {{vars}}, JSON-encodes non-strings and leaves single braces literal', () => {
    const out = renderPrompt(SELECT_DRAFT, { target_ledger: { Y1: 'eligible' }, resource_limits: { maxRunMinutes: 30 } });
    expect(out.variables).toEqual(['target_ledger', 'resource_limits']);
    expect(out.text).toContain('"Y1": "eligible"');
    expect(out.text).toContain('"maxRunMinutes": 30');
    expect(out.text).toContain('Return {target_id, rationale}.');
    expect(out.text).not.toContain('{{');
  });

  it('supports dotted paths and whitespace inside braces', () => {
    expect(renderPrompt({ template: 'T={{ target.id }} / {{target.title}}' }, { target: { id: 'Y1.2', title: 'Proof' } }).text).toBe('T=Y1.2 / Proof');
  });

  it('rejects missing variables (no schema) with the missing list', () => {
    const error = renderError(() => renderPrompt({ template: 'A {{a}} B {{b}} C {{c.d}}' }, { a: 1, c: {} }));
    expect(error.code).toBe('VALIDATION');
    expect(error.details?.missing).toEqual(['b', 'c.d']);
  });

  it('validates inputs against inputSchema before rendering', () => {
    const error = renderError(() => renderPrompt(SELECT_DRAFT, { target_ledger: 'not-an-object', resource_limits: {} }));
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toMatch(/inputSchema/);
    expect((error.details?.schemaIssues as unknown[]).length).toBeGreaterThan(0);
    expect(renderError(() => renderPrompt(SELECT_DRAFT, { target_ledger: {} })).message).toMatch(/resource_limits/);
    expect(renderError(() => renderPrompt(SELECT_DRAFT, [] as unknown as Record<string, unknown>)).code).toBe('VALIDATION');
  });

  it('treats null as a present value but undefined as missing', () => {
    expect(renderPrompt({ template: 'v={{v}}' }, { v: null }).text).toBe('v=null');
    expect(renderError(() => renderPrompt({ template: 'v={{v}}' }, { v: undefined })).code).toBe('VALIDATION');
  });

  it('does not resolve inherited properties', () => {
    expect(renderError(() => renderPrompt({ template: '{{toString}}' }, {})).details?.missing).toEqual(['toString']);
  });
});

describe('template helpers', () => {
  it('templateVariables dedupes in first-appearance order', () => {
    expect(templateVariables('{{b}} {{a}} {{b}} {not} {{ a }}')).toEqual(['b', 'a']);
  });
  it('deriveInputSchema requires top-level roots', () => {
    expect(deriveInputSchema('{{task}} {{target.id}}')).toEqual({ type: 'object', required: ['task', 'target'], properties: { task: {}, target: {} } });
    expect(deriveInputSchema('no variables')).toBeUndefined();
  });
  it('lintPrompt flags undeclared vars and unused required inputs', () => {
    expect(lintPrompt(SELECT_DRAFT)).toEqual([]);
    const warnings = lintPrompt({ template: '{{x}}', inputSchema: { type: 'object', required: ['y'], properties: { y: {} }, additionalProperties: false } });
    expect(warnings.join('\n')).toMatch(/'x'.*additionalProperties is false/);
    expect(warnings.join('\n')).toMatch(/'y' is never used/);
  });
});
