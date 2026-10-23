import { GoalStudioFailure, type PromptDefinition } from '../contracts.js';
import { validateAgainstSchema } from './schema.js';

/** `{{name}}` or `{{a.b}}`. Single braces (e.g. `Return {a, b}`) are literal text. */
const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g;

/** Distinct template variables in order of first appearance. */
export function templateVariables(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(VARIABLE)) seen.add(match[1]);
  return [...seen];
}

function lookup(inputs: Record<string, unknown>, path: string): unknown {
  let current: unknown = inputs;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export interface RenderedPrompt {
  text: string;
  variables: string[];
}

/**
 * Renders a prompt template. Inputs are validated against `inputSchema` first,
 * then every `{{var}}` must resolve to a defined value. Either failure throws
 * GoalStudioFailure('VALIDATION') with the issues in `details`.
 */
export function renderPrompt(def: Pick<PromptDefinition, 'template' | 'inputSchema'> & Partial<Pick<PromptDefinition, 'id' | 'version'>>, inputs: Record<string, unknown>): RenderedPrompt {
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new GoalStudioFailure('VALIDATION', 'prompt inputs must be an object');
  }
  if (def.inputSchema) {
    const issues = validateAgainstSchema(def.inputSchema, inputs);
    if (issues.length) {
      throw new GoalStudioFailure('VALIDATION', `prompt inputs do not match inputSchema: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`, {
        details: { promptId: def.id, version: def.version, schemaIssues: issues },
      });
    }
  }
  const variables = templateVariables(def.template);
  const missing = variables.filter((name) => lookup(inputs, name) === undefined);
  if (missing.length) {
    throw new GoalStudioFailure('VALIDATION', `missing template variables: ${missing.join(', ')}`, {
      details: { promptId: def.id, version: def.version, missing },
    });
  }
  const text = def.template.replace(VARIABLE, (_whole, name: string) => stringify(lookup(inputs, name)));
  return { text, variables };
}

/** Default input schema for a template without one: an object requiring each top-level variable. */
export function deriveInputSchema(template: string): Record<string, unknown> | undefined {
  const roots = [...new Set(templateVariables(template).map((name) => name.split('.')[0]))];
  if (!roots.length) return undefined;
  return {
    type: 'object',
    required: roots,
    properties: Object.fromEntries(roots.map((name) => [name, {}])),
  };
}

/** Non-fatal authoring warnings: variables the schema does not declare, required inputs the template never uses. */
export function lintPrompt(def: Pick<PromptDefinition, 'template' | 'inputSchema'>): string[] {
  const warnings: string[] = [];
  const roots = [...new Set(templateVariables(def.template).map((name) => name.split('.')[0]))];
  const schema = def.inputSchema as { properties?: Record<string, unknown>; required?: unknown; additionalProperties?: unknown } | undefined;
  if (!schema) return warnings;
  const declared = schema.properties ? Object.keys(schema.properties) : [];
  if (schema.properties && schema.additionalProperties === false) {
    for (const name of roots) if (!declared.includes(name)) warnings.push(`template variable '${name}' is not declared in inputSchema.properties and additionalProperties is false`);
  } else if (schema.properties) {
    for (const name of roots) if (!declared.includes(name)) warnings.push(`template variable '${name}' is not declared in inputSchema.properties`);
  }
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) if (typeof name === 'string' && !roots.includes(name)) warnings.push(`required input '${name}' is never used by the template`);
  }
  return warnings;
}
