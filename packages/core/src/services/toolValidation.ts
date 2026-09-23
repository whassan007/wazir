import Ajv, { type ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';

/** Shared schema implementation for native and MCP tool contracts. */
export function compileToolSchema(schema: Record<string, unknown>): ValidateFunction {
  const Validator = schema.$schema === 'https://json-schema.org/draft/2020-12/schema' ? Ajv2020 : Ajv;
  const ajv = new Validator({ strict: false, allErrors: false, validateFormats: true, ownProperties: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

export function hashToolArguments(input: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(normalize(input)) ?? 'null').digest('hex');
}
