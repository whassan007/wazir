import Ajv, { type ValidateFunction } from 'ajv';
import { canonicalJson } from './canonical.js';

/**
 * JSON Schema validation for prompt input/output schemas. Uses ajv (draft-07,
 * the same library @wazir/core uses). It resolves from @wazir/goals through
 * the workspace's hoisted node_modules; see the agent-08 report for the
 * package.json declaration the coordinator should add.
 */
const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: true });
const cache = new Map<string, ValidateFunction>();
const MAX_CACHE = 256;

export interface SchemaIssue {
  path: string;
  message: string;
}

/** Returns undefined when `schema` compiles, otherwise a human-readable reason. */
export function checkSchema(schema: unknown): string | undefined {
  if (schema === undefined) return undefined;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return 'schema must be a JSON object';
  try {
    compile(schema as Record<string, unknown>);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

export function validateAgainstSchema(schema: Record<string, unknown>, value: unknown): SchemaIssue[] {
  const validate = compile(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => ({
    path: error.instancePath || '/',
    message: `${error.message ?? 'invalid'}${error.params && Object.keys(error.params).length ? ` ${JSON.stringify(error.params)}` : ''}`,
  }));
}

function compile(schema: Record<string, unknown>): ValidateFunction {
  const key = canonicalJson(schema);
  const hit = cache.get(key);
  if (hit) return hit;
  // Strip $id so re-compiling a schema under a different digest never collides in ajv's registry.
  const { $id: _ignored, ...rest } = schema as Record<string, unknown> & { $id?: unknown };
  const validate = ajv.compile(rest);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(key, validate);
  return validate;
}
