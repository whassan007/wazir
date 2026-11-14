import { z } from 'zod';
import type {
  AcceptanceState,
  CapabilityGraph,
  CodingAgentProviderNode,
  ConcurrencyQualificationResult,
  DeclarativeExecutionPlan,
  DurableManagedTask,
  EndpointResolutionResult,
  ExecutionPlanPoolSpec,
  InferenceEndpointNode,
  LoadedModelNode,
  MachineReadableExecutionReport,
  PhysicalHostNode,
  PoolAllocationQuantities,
  RoutingStrategyName,
  RuntimeVerificationEvidence,
  ServerAcceptanceRow,
} from './types.js';

export class ExecutionPlanValidationError extends Error {
  public readonly issues: string[];

  constructor(message: string, issues: string[] = [message]) {
    super(message);
    this.name = 'ExecutionPlanValidationError';
    this.issues = issues;
  }
}

const ROUTING_STRATEGIES: readonly [RoutingStrategyName, ...RoutingStrategyName[]] = [
  'local_first',
  'fastest_verified',
  'lowest_expected_cost',
  'highest_qualified_success',
  'strict_provider_allocation',
  'capability_cost_latency',
];

const ExecutionPlanPoolSpecSchema = z
  .object({
    id: z.string().min(1),
    share: z.number().min(0).max(100),
    enabled: z.boolean(),
    host: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    preferred_runtime: z.string().min(1).optional(),
    preferred_model: z.string().min(1).optional(),
    fallback_model: z.string().min(1).optional(),
    max_concurrent: z.number().int().min(0),
    agent_prefix: z.string().min(1).optional(),
  })
  .strict();

export const DeclarativeExecutionPlanSchema = z
  .object({
    apiVersion: z.literal('wazir.dev/v1'),
    kind: z.literal('ExecutionPlan'),
    metadata: z
      .object({
        name: z.string().min(1),
        version: z.number().int().min(1),
        description: z.string().optional(),
      })
      .strict(),
    spec: z
      .object({
        goal: z.string().min(1),
        execution: z
          .object({
            mode: z.enum(['autonomous', 'supervised', 'dry_run']),
            total_agents: z.number().int().min(1),
            speed_optimization: z.boolean().optional(),
            queue_when_saturated: z.boolean(),
            verify_outputs: z.boolean(),
            recover_failures: z.boolean(),
            max_repair_attempts: z.number().int().min(0),
            budget_usd: z.number().min(0).optional(),
            timeout_ms: z.number().int().min(1).optional(),
          })
          .strict(),
        discovery: z
          .object({
            refresh_before_execution: z.boolean(),
            authorized_hosts_only: z.boolean(),
            probe_runtimes: z.boolean(),
            enumerate_models: z.boolean(),
            test_real_inference: z.boolean(),
          })
          .strict(),
        pools: z.array(ExecutionPlanPoolSpecSchema).min(1),
        routing: z
          .object({
            strategy: z.enum(ROUTING_STRATEGIES),
            preserve_disabled_pools: z.boolean(),
            strict_shares: z.boolean().optional(),
            dynamic_health_checks: z.boolean(),
            verify_execution_capability: z.boolean(),
            require_resource_admission: z.boolean(),
            fallback_policy: z.enum(['none', 'compatible_authorized_pool', 'local_only']),
            prevent_gpu_double_counting: z.boolean(),
            constraints: z.array(z.string()).optional(),
          })
          .strict(),
        qualification: z
          .object({
            enabled: z.boolean(),
            real_execution_required: z.boolean(),
            independent_verification: z.boolean(),
            evidence_required: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

interface PreparedYamlLine {
  lineNo: number;
  indent: number;
  text: string;
}

/**
 * Strips inline `#` comments that appear outside single/double quotes and are
 * preceded by start-of-line or whitespace.
 */
function stripYamlComment(rawLine: string, lineNo: number): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (ch === '\\' && inDouble) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      if (inSingle && rawLine[i + 1] === "'") {
        i++;
        continue;
      }
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || rawLine[i - 1] === ' ' || rawLine[i - 1] === '\t') {
        return rawLine.slice(0, i).trimEnd();
      }
    }
  }
  if (inSingle || inDouble) {
    throw new ExecutionPlanValidationError(`Unclosed quoted string at YAML line ${lineNo}`);
  }
  return rawLine.trimEnd();
}

function parseDoubleQuotedScalar(raw: string, lineNo: number): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    throw new ExecutionPlanValidationError(`Malformed double-quoted string at YAML line ${lineNo}`);
  }
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      if (i + 1 >= raw.length - 1) {
        throw new ExecutionPlanValidationError(`Trailing backslash escape at YAML line ${lineNo}`);
      }
      const esc = raw[++i];
      switch (esc) {
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        default:
          out += esc;
          break;
      }
    } else if (ch === '"') {
      throw new ExecutionPlanValidationError(`Unescaped '"' inside double-quoted string at YAML line ${lineNo}`);
    } else {
      out += ch;
    }
  }
  return out;
}

function parseSingleQuotedScalar(raw: string, lineNo: number): string {
  if (raw.length < 2 || !raw.startsWith("'") || !raw.endsWith("'")) {
    throw new ExecutionPlanValidationError(`Malformed single-quoted string at YAML line ${lineNo}`);
  }
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i];
    if (ch === "'") {
      if (raw[i + 1] === "'") {
        out += "'";
        i++;
      } else {
        throw new ExecutionPlanValidationError(`Unescaped "'" inside single-quoted string at YAML line ${lineNo}`);
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function splitFlowItems(inner: string, lineNo: number): string[] {
  const trimmed = inner.trim();
  if (trimmed === '') return [];
  const items: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let depth = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && inDouble) {
      current += ch + (trimmed[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      if (inSingle && trimmed[i + 1] === "'") {
        current += "''";
        i++;
        continue;
      }
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        items.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (depth !== 0 || inSingle || inDouble) {
    throw new ExecutionPlanValidationError(`Malformed inline collection at YAML line ${lineNo}`);
  }
  if (current.trim().length > 0) {
    items.push(current.trim());
  }
  return items;
}

function parseYamlScalarOrInline(raw: string, lineNo: number): unknown {
  const s = raw.trim();
  if (s.startsWith('"')) {
    return parseDoubleQuotedScalar(s, lineNo);
  }
  if (s.startsWith("'")) {
    return parseSingleQuotedScalar(s, lineNo);
  }
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s.startsWith('[') && s.endsWith(']')) {
    return splitFlowItems(s.slice(1, -1), lineNo).map((part) => parseYamlScalarOrInline(part, lineNo));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const obj: Record<string, unknown> = {};
    for (const part of splitFlowItems(s.slice(1, -1), lineNo)) {
      const kv = splitMappingLine(part, lineNo);
      if (!kv || kv.rest === undefined) {
        throw new ExecutionPlanValidationError(`Invalid inline mapping entry '${part}' at YAML line ${lineNo}`);
      }
      obj[kv.key] = parseYamlScalarOrInline(kv.rest, lineNo);
    }
    return obj;
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

/**
 * Splits a YAML mapping line into `{ key, rest }` where `rest` is `undefined`
 * when no inline value follows `:` (i.e. nested block starts on the next line).
 * Crucially only treats `:` as a key separator when outside quotes and followed
 * by whitespace or end-of-line, preserving colons inside model tags or URLs
 * such as `qwen3-coder:30b`.
 */
function splitMappingLine(
  text: string,
  lineNo: number,
): { key: string; rest: string | undefined } | undefined {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && inDouble) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      if (inSingle && text[i + 1] === "'") {
        i++;
        continue;
      }
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === ':' && !inSingle && !inDouble) {
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\t') {
        const rawKey = text.slice(0, i).trim();
        if (!rawKey) {
          throw new ExecutionPlanValidationError(`Empty mapping key at YAML line ${lineNo}`);
        }
        let key: string;
        if (rawKey.startsWith('"')) key = parseDoubleQuotedScalar(rawKey, lineNo);
        else if (rawKey.startsWith("'")) key = parseSingleQuotedScalar(rawKey, lineNo);
        else key = rawKey;

        const remainder = text.slice(i + 1).trim();
        return { key, rest: remainder === '' ? undefined : remainder };
      }
    }
  }
  return undefined;
}

function isSequenceLine(text: string): boolean {
  return text === '-' || text.startsWith('- ') || text.startsWith('-\t');
}

/**
 * Zero-external-dependency strict YAML subset + JSON parser supporting nested
 * mappings, block object lists (`- id: ...`), string/scalar lists, inline flow
 * literals, comments (`#`), and quoted/unquoted scalars.
 */
export function parseStrictYamlOrJson(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new ExecutionPlanValidationError('ExecutionPlan content is empty');
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new ExecutionPlanValidationError(
        `Invalid JSON in ExecutionPlan: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const rawLines = content.replace(/\r\n/g, '\n').split('\n');
  const lines: PreparedYamlLine[] = [];

  for (let idx = 0; idx < rawLines.length; idx++) {
    const lineNo = idx + 1;
    const rawLine = rawLines[idx];

    let indent = 0;
    while (indent < rawLine.length && (rawLine[indent] === ' ' || rawLine[indent] === '\t')) {
      if (rawLine[indent] === '\t') {
        throw new ExecutionPlanValidationError(`Tabs are not allowed for YAML indentation at line ${lineNo}`);
      }
      indent++;
    }

    const stripped = stripYamlComment(rawLine, lineNo);
    const body = stripped.trim();
    if (!body) continue;
    if (indent === 0 && (body === '---' || body === '...')) continue;

    lines.push({ lineNo, indent, text: stripped.slice(indent) });
  }

  if (lines.length === 0) {
    throw new ExecutionPlanValidationError('YAML document contains no values');
  }

  let cursor = 0;

  function parseMultilineScalar(parentIndent: number, style: '|' | '>'): string {
    const collected: string[] = [];
    let blockIndent: number | undefined;
    while (cursor < lines.length) {
      const peek = lines[cursor];
      if (peek.indent <= parentIndent) break;
      if (blockIndent === undefined) blockIndent = peek.indent;
      collected.push(peek.text);
      cursor++;
    }
    return style === '|' ? collected.join('\n') : collected.join(' ');
  }

  function parseNode(expectedMinIndent: number): unknown {
    if (cursor >= lines.length) return null;
    const first = lines[cursor];
    if (first.indent < expectedMinIndent) {
      throw new ExecutionPlanValidationError(
        `Unexpected indentation (${first.indent} < ${expectedMinIndent}) at YAML line ${first.lineNo}`,
      );
    }
    if (isSequenceLine(first.text)) {
      return parseSequence(first.indent);
    }
    return parseMapping(first.indent);
  }

  function parseMapping(mapIndent: number, seed?: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = seed ? { ...seed } : {};

    while (cursor < lines.length) {
      const current = lines[cursor];
      if (current.indent < mapIndent) break;
      if (current.indent > mapIndent) {
        throw new ExecutionPlanValidationError(
          `Unexpected indentation ${current.indent} (expected ${mapIndent}) at YAML line ${current.lineNo}`,
        );
      }
      if (isSequenceLine(current.text)) break;

      const split = splitMappingLine(current.text, current.lineNo);
      if (!split) {
        throw new ExecutionPlanValidationError(
          `Expected 'key: value' mapping entry at YAML line ${current.lineNo}: '${current.text}'`,
        );
      }
      if (Object.prototype.hasOwnProperty.call(result, split.key)) {
        throw new ExecutionPlanValidationError(
          `Duplicate key '${split.key}' at YAML line ${current.lineNo}`,
        );
      }

      cursor++;

      if (split.rest === '|' || split.rest === '>') {
        result[split.key] = parseMultilineScalar(mapIndent, split.rest);
      } else if (split.rest !== undefined) {
        result[split.key] = parseYamlScalarOrInline(split.rest, current.lineNo);
      } else {
        if (cursor >= lines.length || lines[cursor].indent <= mapIndent) {
          throw new ExecutionPlanValidationError(
            `Mapping key '${split.key}' at YAML line ${current.lineNo} is missing a nested value or scalar`,
          );
        }
        result[split.key] = parseNode(mapIndent + 1);
      }
    }

    return result;
  }

  function parseSequence(seqIndent: number): unknown[] {
    const arr: unknown[] = [];

    while (cursor < lines.length) {
      const current = lines[cursor];
      if (current.indent < seqIndent) break;
      if (current.indent > seqIndent) {
        throw new ExecutionPlanValidationError(
          `Unexpected sequence indentation ${current.indent} (expected ${seqIndent}) at YAML line ${current.lineNo}`,
        );
      }
      if (!isSequenceLine(current.text)) break;

      const afterDash = current.text.slice(1).trim();
      cursor++;

      if (afterDash === '') {
        if (cursor >= lines.length || lines[cursor].indent <= seqIndent) {
          arr.push(null);
        } else {
          arr.push(parseNode(seqIndent + 1));
        }
        continue;
      }

      const inlineKv = splitMappingLine(afterDash, current.lineNo);
      if (inlineKv) {
        const itemIndent = current.indent + 2;
        const seedObj: Record<string, unknown> = {};
        if (inlineKv.rest === '|' || inlineKv.rest === '>') {
          seedObj[inlineKv.key] = parseMultilineScalar(seqIndent, inlineKv.rest);
        } else if (inlineKv.rest !== undefined) {
          seedObj[inlineKv.key] = parseYamlScalarOrInline(inlineKv.rest, current.lineNo);
        } else {
          if (cursor >= lines.length || lines[cursor].indent <= seqIndent) {
            throw new ExecutionPlanValidationError(
              `Sequence mapping key '${inlineKv.key}' at YAML line ${current.lineNo} has no value`,
            );
          }
          seedObj[inlineKv.key] = parseNode(itemIndent + 1);
        }

        if (cursor < lines.length && lines[cursor].indent > seqIndent) {
          const propIndent = lines[cursor].indent;
          arr.push(parseMapping(propIndent, seedObj));
        } else {
          arr.push(seedObj);
        }
      } else {
        arr.push(parseYamlScalarOrInline(afterDash, current.lineNo));
      }
    }

    return arr;
  }

  const parsed = parseNode(lines[0].indent);
  if (cursor < lines.length) {
    throw new ExecutionPlanValidationError(
      `Unexpected trailing YAML content at line ${lines[cursor].lineNo}: '${lines[cursor].text}'`,
    );
  }
  return parsed;
}

export function validateExecutionPlan(candidate: unknown): DeclarativeExecutionPlan {
  const parsed = DeclarativeExecutionPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    );
    throw new ExecutionPlanValidationError(
      `Invalid DeclarativeExecutionPlan schema: ${issues.join('; ')}`,
      issues,
    );
  }

  const plan = parsed.data as DeclarativeExecutionPlan;
  const semanticIssues: string[] = [];
  const seenPoolIds = new Set<string>();
  let enabledShareSum = 0;
  let enabledPoolCount = 0;

  const constraintsLower = (plan.spec.routing.constraints ?? []).map((c) => c.toLowerCase());
  const forbidsClaudeInConstraints = constraintsLower.some(
    (c) =>
      /\b(?:do\s+not|don't|never|no|zero|disable)\b.*\bclaude\b/.test(c) ||
      /\bclaude\b.*\b(?:disabled|0%|zero)\b/.test(c),
  );

  for (const pool of plan.spec.pools) {
    if (seenPoolIds.has(pool.id)) {
      semanticIssues.push(`Duplicate pool id '${pool.id}'`);
    }
    seenPoolIds.add(pool.id);

    const isClaudePool =
      pool.id.toLowerCase() === 'claude' || pool.provider?.toLowerCase() === 'claude';

    if (!pool.enabled) {
      if (Math.abs(pool.share) > 1e-6) {
        semanticIssues.push(
          `Disabled pool '${pool.id}' must have share === 0, received ${pool.share}`,
        );
      }
      if (isClaudePool && pool.max_concurrent !== 0) {
        semanticIssues.push(
          `Disabled 'claude' pool must have max_concurrent === 0, received ${pool.max_concurrent}`,
        );
      }
    } else {
      if (pool.share <= 0) {
        semanticIssues.push(
          `Enabled pool '${pool.id}' has share === ${pool.share}; disabled/0% pools must set enabled: false`,
        );
      }
      if (pool.max_concurrent <= 0) {
        semanticIssues.push(
          `Enabled pool '${pool.id}' must have max_concurrent >= 1, received ${pool.max_concurrent}`,
        );
      }
      if (!pool.host && !pool.provider) {
        semanticIssues.push(
          `Enabled pool '${pool.id}' must specify either 'host' (local) or 'provider' (cloud)`,
        );
      }
      if (isClaudePool && forbidsClaudeInConstraints) {
        semanticIssues.push(
          `Pool '${pool.id}' is enabled (share=${pool.share}%), violating hard routing constraint against Claude`,
        );
      }
      enabledShareSum += pool.share;
      enabledPoolCount++;
    }

    if (isClaudePool && pool.share === 0 && pool.max_concurrent !== 0) {
      semanticIssues.push(
        `Zero-share 'claude' pool must have max_concurrent === 0, received ${pool.max_concurrent}`,
      );
    }
  }

  if (enabledPoolCount === 0) {
    semanticIssues.push('ExecutionPlan must contain at least one enabled pool');
  } else if (Math.abs(enabledShareSum - 100) > 1e-6) {
    semanticIssues.push(
      `Enabled pool shares must sum to 100 (within 1e-6), received ${enabledShareSum}`,
    );
  }

  if (semanticIssues.length > 0) {
    throw new ExecutionPlanValidationError(
      `ExecutionPlan semantic validation failed: ${semanticIssues.join('; ')}`,
      semanticIssues,
    );
  }

  return plan;
}

export function parseExecutionPlanYamlOrJson(content: string): DeclarativeExecutionPlan {
  const raw = parseStrictYamlOrJson(content);
  return validateExecutionPlan(raw);
}

function formatYamlString(value: string, forceQuote = false): string {
  const safeUnquoted =
    !forceQuote &&
    value.length > 0 &&
    !/^(?:true|false|null|~|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(value) &&
    !/[:#\n\r\t"'[\]{},&*!|>%@`]/.test(value) &&
    value.trim() === value &&
    !value.startsWith('-');

  if (safeUnquoted) {
    return value;
  }
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function formatYamlModelOrIdentifier(value: string): string {
  if (
    value.length > 0 &&
    !/^(?:true|false|null|~|-?\d+(?:\.\d+)?)$/.test(value) &&
    !/[\s#"'\n\r\t[\]{},]/.test(value) &&
    !value.startsWith('-')
  ) {
    return value;
  }
  return formatYamlString(value, true);
}

export function serializeExecutionPlanYaml(plan: DeclarativeExecutionPlan): string {
  const validated = validateExecutionPlan(plan);
  const lines: string[] = [];

  lines.push(`apiVersion: ${validated.apiVersion}`);
  lines.push(`kind: ${validated.kind}`);
  lines.push('');
  lines.push('metadata:');
  lines.push(`  name: ${formatYamlModelOrIdentifier(validated.metadata.name)}`);
  lines.push(`  version: ${validated.metadata.version}`);
  if (validated.metadata.description !== undefined) {
    lines.push(`  description: ${formatYamlString(validated.metadata.description, true)}`);
  }
  lines.push('');
  lines.push('spec:');
  lines.push(`  goal: ${formatYamlString(validated.spec.goal, true)}`);
  lines.push('');
  lines.push('  execution:');
  lines.push(`    mode: ${validated.spec.execution.mode}`);
  lines.push(`    total_agents: ${validated.spec.execution.total_agents}`);
  if (validated.spec.execution.speed_optimization !== undefined) {
    lines.push(`    speed_optimization: ${validated.spec.execution.speed_optimization}`);
  }
  lines.push(`    queue_when_saturated: ${validated.spec.execution.queue_when_saturated}`);
  lines.push(`    verify_outputs: ${validated.spec.execution.verify_outputs}`);
  lines.push(`    recover_failures: ${validated.spec.execution.recover_failures}`);
  lines.push(`    max_repair_attempts: ${validated.spec.execution.max_repair_attempts}`);
  if (validated.spec.execution.budget_usd !== undefined) {
    lines.push(`    budget_usd: ${validated.spec.execution.budget_usd}`);
  }
  if (validated.spec.execution.timeout_ms !== undefined) {
    lines.push(`    timeout_ms: ${validated.spec.execution.timeout_ms}`);
  }
  lines.push('');
  lines.push('  discovery:');
  lines.push(`    refresh_before_execution: ${validated.spec.discovery.refresh_before_execution}`);
  lines.push(`    authorized_hosts_only: ${validated.spec.discovery.authorized_hosts_only}`);
  lines.push(`    probe_runtimes: ${validated.spec.discovery.probe_runtimes}`);
  lines.push(`    enumerate_models: ${validated.spec.discovery.enumerate_models}`);
  lines.push(`    test_real_inference: ${validated.spec.discovery.test_real_inference}`);
  lines.push('');
  lines.push('  pools:');

  validated.spec.pools.forEach((pool, idx) => {
    lines.push(`    - id: ${formatYamlModelOrIdentifier(pool.id)}`);
    lines.push(`      share: ${pool.share}`);
    lines.push(`      enabled: ${pool.enabled}`);
    if (pool.host !== undefined) {
      lines.push(`      host: ${formatYamlModelOrIdentifier(pool.host)}`);
    }
    if (pool.provider !== undefined) {
      lines.push(`      provider: ${formatYamlModelOrIdentifier(pool.provider)}`);
    }
    if (pool.preferred_runtime !== undefined) {
      lines.push(`      preferred_runtime: ${formatYamlModelOrIdentifier(pool.preferred_runtime)}`);
    }
    if (pool.preferred_model !== undefined) {
      lines.push(`      preferred_model: ${formatYamlModelOrIdentifier(pool.preferred_model)}`);
    }
    if (pool.fallback_model !== undefined) {
      lines.push(`      fallback_model: ${formatYamlModelOrIdentifier(pool.fallback_model)}`);
    }
    lines.push(`      max_concurrent: ${pool.max_concurrent}`);
    if (pool.agent_prefix !== undefined) {
      lines.push(`      agent_prefix: ${formatYamlModelOrIdentifier(pool.agent_prefix)}`);
    }
    if (idx < validated.spec.pools.length - 1) {
      lines.push('');
    }
  });

  lines.push('');
  lines.push('  routing:');
  lines.push(`    strategy: ${validated.spec.routing.strategy}`);
  lines.push(`    preserve_disabled_pools: ${validated.spec.routing.preserve_disabled_pools}`);
  if (validated.spec.routing.strict_shares !== undefined) {
    lines.push(`    strict_shares: ${validated.spec.routing.strict_shares}`);
  }
  lines.push(`    dynamic_health_checks: ${validated.spec.routing.dynamic_health_checks}`);
  lines.push(`    verify_execution_capability: ${validated.spec.routing.verify_execution_capability}`);
  lines.push(`    require_resource_admission: ${validated.spec.routing.require_resource_admission}`);
  lines.push(`    fallback_policy: ${validated.spec.routing.fallback_policy}`);
  lines.push(`    prevent_gpu_double_counting: ${validated.spec.routing.prevent_gpu_double_counting}`);
  if (validated.spec.routing.constraints !== undefined) {
    if (validated.spec.routing.constraints.length === 0) {
      lines.push('    constraints: []');
    } else {
      lines.push('    constraints:');
      for (const constraint of validated.spec.routing.constraints) {
        lines.push(`      - ${formatYamlString(constraint, true)}`);
      }
    }
  }
  lines.push('');
  lines.push('  qualification:');
  lines.push(`    enabled: ${validated.spec.qualification.enabled}`);
  lines.push(`    real_execution_required: ${validated.spec.qualification.real_execution_required}`);
  lines.push(`    independent_verification: ${validated.spec.qualification.independent_verification}`);
  lines.push(`    evidence_required: ${validated.spec.qualification.evidence_required}`);

  return `${lines.join('\n')}\n`;
}

const DEFAULT_POOL_PREFIX_MAP: Record<string, string> = {
  dgx_spark: 'D',
  mac_studio: 'M',
  macbook_pro: 'L',
  antigravity: 'A',
  codex: 'X',
  claude: 'C',
};

export function inferPoolAgentPrefix(pool: ExecutionPlanPoolSpec): string {
  if (pool.agent_prefix && pool.agent_prefix.trim().length > 0) {
    return pool.agent_prefix.trim();
  }
  const normalized = pool.id.toLowerCase();
  if (DEFAULT_POOL_PREFIX_MAP[normalized]) {
    return DEFAULT_POOL_PREFIX_MAP[normalized];
  }
  const letters = pool.id.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return letters.slice(0, 1) || 'P';
}

export function buildLogicalAgentIds(prefix: string, count: number): string[] {
  if (count <= 0) return [];
  const padWidth = Math.max(2, String(count).length);
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    ids.push(`${prefix}${String(i).padStart(padWidth, '0')}`);
  }
  return ids;
}

export interface PoolApportionmentEntry {
  poolId: string;
  poolIndex: number;
  enabled: boolean;
  sharePct: number;
  exactQuota: number;
  floorSeats: number;
  remainder: number;
  remainderSeatAwarded: boolean;
  allocatedAgents: number;
  agentPrefix: string;
  logicalAgentIds: string[];
}

export interface LargestRemainderApportionmentResult {
  totalAgents: number;
  allocatedTotal: number;
  remainderSeatsDistributed: number;
  byPool: Record<string, PoolApportionmentEntry>;
  orderedPools: PoolApportionmentEntry[];
  allLogicalAgentIds: string[];
  tieBreakRulesApplied: readonly [
    '1_disabled_pools_always_zero',
    '2_descending_fractional_remainder',
    '3_starvation_guard_floor_zero_first',
    '4_higher_share_percentage',
    '5_earlier_pool_index_then_lexicographical_id',
  ];
}

/**
 * Deterministic Hamilton / largest-remainder apportionment across arbitrary pool shares.
 *
 * Tie-breaking rules when `|r_a - r_b| < 1e-9`:
 * 1. Disabled pools (`!enabled || share <= 0`) ALWAYS receive `0` seats (`claude = 0`).
 * 2. Exact quota `q_i = (totalAgents * share_i) / shareSum`, initial `floor(q_i)`.
 * 3. Remaining `R = totalAgents - sum(floor(q_i))` seats awarded in descending `r_i = q_i - floor(q_i)`.
 * 4. Tie-breakers:
 *    (a) Enabled non-zero pool currently at `floor(q_i) === 0` wins first (prevents starving 5% pools like `codex` at scale 10).
 *    (b) Higher `share` percentage wins next.
 *    (c) Earlier pool index in plan, then lexicographical `id`, wins last.
 */
export function apportionProportionalShares(
  pools: ReadonlyArray<{
    id: string;
    share: number;
    enabled: boolean;
    agent_prefix?: string;
  }>,
  totalAgents: number,
): LargestRemainderApportionmentResult {
  if (!Number.isInteger(totalAgents) || totalAgents < 0) {
    throw new ExecutionPlanValidationError(
      `totalAgents must be a non-negative integer, received ${totalAgents}`,
    );
  }

  const activePools = pools.filter((p) => p.enabled && p.share > 0);
  const activeShareSum = activePools.reduce((acc, p) => acc + p.share, 0);

  if (totalAgents > 0 && (activePools.length === 0 || activeShareSum <= 0)) {
    throw new ExecutionPlanValidationError(
      'Cannot apportion positive agent count when no enabled pools have positive share',
    );
  }

  interface WorkingEntry {
    poolId: string;
    poolIndex: number;
    enabled: boolean;
    sharePct: number;
    exactQuota: number;
    floorSeats: number;
    remainder: number;
    remainderSeatAwarded: boolean;
    allocatedAgents: number;
    agentPrefix: string;
  }

  const working: WorkingEntry[] = pools.map((pool, idx) => {
    const isEligible = pool.enabled && pool.share > 0 && totalAgents > 0;
    const prefix = inferPoolAgentPrefix(pool as ExecutionPlanPoolSpec);
    if (!isEligible) {
      return {
        poolId: pool.id,
        poolIndex: idx,
        enabled: Boolean(pool.enabled && pool.share > 0),
        sharePct: pool.enabled ? pool.share : 0,
        exactQuota: 0,
        floorSeats: 0,
        remainder: 0,
        remainderSeatAwarded: false,
        allocatedAgents: 0,
        agentPrefix: prefix,
      };
    }

    const rawQuota = (totalAgents * pool.share) / activeShareSum;
    const snappedQuota =
      Math.abs(rawQuota - Math.round(rawQuota)) < 1e-9 ? Math.round(rawQuota) : rawQuota;
    const floorSeats = Math.floor(snappedQuota);
    const remainder = Math.max(0, snappedQuota - floorSeats);

    return {
      poolId: pool.id,
      poolIndex: idx,
      enabled: true,
      sharePct: pool.share,
      exactQuota: snappedQuota,
      floorSeats,
      remainder,
      remainderSeatAwarded: false,
      allocatedAgents: floorSeats,
      agentPrefix: prefix,
    };
  });

  const floorSum = working.reduce((sum, w) => sum + w.floorSeats, 0);
  const remainingSeats = Math.max(0, totalAgents - floorSum);

  if (remainingSeats > 0) {
    const eligibleIndices = working
      .map((w, idx) => ({ w, idx }))
      .filter(({ w }) => w.enabled && w.sharePct > 0);

    eligibleIndices.sort((a, b) => {
      const remDiff = b.w.remainder - a.w.remainder;
      if (Math.abs(remDiff) >= 1e-9) {
        return remDiff > 0 ? 1 : -1;
      }
      const aZeroFloor = a.w.floorSeats === 0 ? 1 : 0;
      const bZeroFloor = b.w.floorSeats === 0 ? 1 : 0;
      if (aZeroFloor !== bZeroFloor) {
        return bZeroFloor - aZeroFloor;
      }
      if (Math.abs(b.w.sharePct - a.w.sharePct) >= 1e-9) {
        return b.w.sharePct - a.w.sharePct;
      }
      if (a.w.poolIndex !== b.w.poolIndex) {
        return a.w.poolIndex - b.w.poolIndex;
      }
      return a.w.poolId.localeCompare(b.w.poolId);
    });

    for (let r = 0; r < remainingSeats; r++) {
      const target = eligibleIndices[r % eligibleIndices.length];
      target.w.allocatedAgents += 1;
      target.w.remainderSeatAwarded = true;
    }
  }

  const orderedPools: PoolApportionmentEntry[] = [];
  const byPool: Record<string, PoolApportionmentEntry> = {};
  const allLogicalAgentIds: string[] = [];

  for (const w of working) {
    const logicalAgentIds = w.enabled ? buildLogicalAgentIds(w.agentPrefix, w.allocatedAgents) : [];
    const entry: PoolApportionmentEntry = {
      poolId: w.poolId,
      poolIndex: w.poolIndex,
      enabled: w.enabled,
      sharePct: w.sharePct,
      exactQuota: w.exactQuota,
      floorSeats: w.floorSeats,
      remainder: w.remainder,
      remainderSeatAwarded: w.remainderSeatAwarded,
      allocatedAgents: w.enabled ? w.allocatedAgents : 0,
      agentPrefix: w.agentPrefix,
      logicalAgentIds,
    };
    orderedPools.push(entry);
    byPool[entry.poolId] = entry;
    allLogicalAgentIds.push(...logicalAgentIds);
  }

  return {
    totalAgents,
    allocatedTotal: orderedPools.reduce((sum, p) => sum + p.allocatedAgents, 0),
    remainderSeatsDistributed: remainingSeats,
    byPool,
    orderedPools,
    allLogicalAgentIds,
    tieBreakRulesApplied: [
      '1_disabled_pools_always_zero',
      '2_descending_fractional_remainder',
      '3_starvation_guard_floor_zero_first',
      '4_higher_share_percentage',
      '5_earlier_pool_index_then_lexicographical_id',
    ],
  };
}

export function apportionAgentsLargestRemainder(
  plan: DeclarativeExecutionPlan,
  totalAgentsOverride?: number,
): LargestRemainderApportionmentResult {
  const validated = validateExecutionPlan(plan);
  const totalAgents = totalAgentsOverride ?? validated.spec.execution.total_agents;
  return apportionProportionalShares(validated.spec.pools, totalAgents);
}

export interface ActiveShardAssignment {
  activeAgentId: string;
  poolId: string;
  coalescedLogicalAgentIds: string[];
  shardSize: number;
}

export interface PoolSpeedOptimizationDetail {
  poolId: string;
  enabled: boolean;
  sharePct: number;
  requestedLogicalAgents: number;
  speedOptimizedActiveAgents: number;
  configuredMaxConcurrent: number;
  estimatedQueueWavesBefore: number;
  estimatedQueueWavesAfter: number;
  logicalAgentIds: string[];
  activeAgentIds: string[];
  shards: ActiveShardAssignment[];
}

export interface SpeedOptimizationResult {
  speedOptimizationApplied: boolean;
  requestedLogicalAgents: number;
  speedOptimizedActiveAgents: number;
  effectiveConcurrencyCeiling: number;
  maxQueueWaves: number;
  independentTaskCount?: number;
  rationale: string;
  requestedApportionment: LargestRemainderApportionmentResult;
  activeApportionment: LargestRemainderApportionmentResult;
  byPool: Record<string, PoolSpeedOptimizationDetail>;
}

/**
 * Adjusts active execution wave size for speed optimization (coalescing micro-shards
 * when `requestedAgents` would create excessive serial queue waves on 1-slot/3-slot
 * local machines, or sizing down to `independentTaskCount` when fewer tasks exist)
 * while preserving exact FS5 pool ratios and keeping disabled pools strictly at `0`.
 */
export function optimizeAgentAllocationForSpeed(params: {
  plan: DeclarativeExecutionPlan;
  requestedAgents: number;
  independentTaskCount?: number;
  verifiedTotalConcurrency?: number;
  maxQueueWaves?: number;
}): SpeedOptimizationResult {
  const { plan, requestedAgents, independentTaskCount, verifiedTotalConcurrency } = params;
  const validated = validateExecutionPlan(plan);
  if (!Number.isInteger(requestedAgents) || requestedAgents < 1) {
    throw new ExecutionPlanValidationError(
      `requestedAgents must be an integer >= 1, received ${requestedAgents}`,
    );
  }

  const maxQueueWaves = Math.max(1, Math.floor(params.maxQueueWaves ?? 2));
  const enabledPools = validated.spec.pools.filter((p) => p.enabled && p.share > 0);
  const configuredTotalConcurrency = enabledPools.reduce((sum, p) => sum + p.max_concurrent, 0);
  const effectiveConcurrencyCeiling = Math.max(
    1,
    verifiedTotalConcurrency !== undefined
      ? Math.min(configuredTotalConcurrency, Math.max(1, Math.floor(verifiedTotalConcurrency)))
      : configuredTotalConcurrency,
  );

  const requestedApportionment = apportionAgentsLargestRemainder(validated, requestedAgents);
  const speedOptEnabled = validated.spec.execution.speed_optimization !== false;

  let targetActive = requestedAgents;
  const reasons: string[] = [];

  if (speedOptEnabled) {
    const waveCeiling = effectiveConcurrencyCeiling * maxQueueWaves;
    if (targetActive > waveCeiling) {
      targetActive = waveCeiling;
      reasons.push(
        `coalesced ${requestedAgents} logical shards to ${waveCeiling} (${effectiveConcurrencyCeiling} concurrent slots x ${maxQueueWaves} max waves)`,
      );
    }

    if (independentTaskCount !== undefined && independentTaskCount >= 1 && targetActive > independentTaskCount) {
      targetActive = independentTaskCount;
      reasons.push(`sized down to ${independentTaskCount} independent tasks`);
    }

    // Ensure non-zero enabled pools are not starved during wave coalescing unless independentTaskCount is smaller.
    const minActiveForRatio = enabledPools.length;
    if (
      targetActive < requestedAgents &&
      targetActive < minActiveForRatio &&
      (independentTaskCount === undefined || independentTaskCount >= minActiveForRatio)
    ) {
      targetActive = Math.min(requestedAgents, minActiveForRatio);
    }
  }

  const activeApportionment =
    targetActive === requestedAgents
      ? requestedApportionment
      : apportionAgentsLargestRemainder(validated, targetActive);

  const byPool: Record<string, PoolSpeedOptimizationDetail> = {};

  for (const pool of validated.spec.pools) {
    const reqEntry = requestedApportionment.byPool[pool.id];
    const actEntry = activeApportionment.byPool[pool.id];
    const reqIds = reqEntry.logicalAgentIds;
    const actIds = actEntry.logicalAgentIds;

    const shards: ActiveShardAssignment[] = [];
    if (actIds.length > 0) {
      const baseSize = Math.floor(reqIds.length / actIds.length);
      const extra = reqIds.length % actIds.length;
      let offset = 0;
      for (let i = 0; i < actIds.length; i++) {
        const take = baseSize + (i < extra ? 1 : 0);
        const coalesced = reqIds.slice(offset, offset + take);
        offset += take;
        shards.push({
          activeAgentId: actIds[i],
          poolId: pool.id,
          coalescedLogicalAgentIds: coalesced,
          shardSize: coalesced.length,
        });
      }
    }

    const wavesBefore =
      pool.enabled && pool.max_concurrent > 0 ? Math.ceil(reqIds.length / pool.max_concurrent) : 0;
    const wavesAfter =
      pool.enabled && pool.max_concurrent > 0 ? Math.ceil(actIds.length / pool.max_concurrent) : 0;

    byPool[pool.id] = {
      poolId: pool.id,
      enabled: pool.enabled,
      sharePct: pool.enabled ? pool.share : 0,
      requestedLogicalAgents: reqIds.length,
      speedOptimizedActiveAgents: actIds.length,
      configuredMaxConcurrent: pool.max_concurrent,
      estimatedQueueWavesBefore: wavesBefore,
      estimatedQueueWavesAfter: wavesAfter,
      logicalAgentIds: reqIds,
      activeAgentIds: actIds,
      shards,
    };
  }

  const speedOptimizationApplied = targetActive < requestedAgents;
  const rationale = speedOptimizationApplied
    ? `Speed optimization active: ${reasons.join('; ')} while preserving FS5 pool share proportions.`
    : speedOptEnabled
      ? `Requested ${requestedAgents} agents already fits within ${maxQueueWaves} queue wave(s) across ${effectiveConcurrencyCeiling} concurrent slots.`
      : 'Speed optimization disabled in ExecutionPlan; executing 1:1 logical agents.';

  return {
    speedOptimizationApplied,
    requestedLogicalAgents: requestedAgents,
    speedOptimizedActiveAgents: targetActive,
    effectiveConcurrencyCeiling,
    maxQueueWaves,
    independentTaskCount,
    rationale,
    requestedApportionment,
    activeApportionment,
    byPool,
  };
}

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const h = parsed.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return /(?:^|\/\/)(?:127\.0\.0\.1|localhost|\[?::1\]?)(?::|\/|$)/i.test(rawUrl);
  }
}

export function findHostInCapabilityGraph(
  graph: CapabilityGraph,
  hostRef: string,
): PhysicalHostNode | undefined {
  const normalized = hostRef.trim().toLowerCase();
  // Never trust raw URLs or literal IP addresses as live hosts unless they match a discovered entity!
  if (graph.hosts[hostRef]) return graph.hosts[hostRef];

  const sortedHostKeys = Object.keys(graph.hosts).sort();
  for (const key of sortedHostKeys) {
    const node = graph.hosts[key];
    if (
      node.hostId.toLowerCase() === normalized ||
      node.machineId.toLowerCase() === normalized ||
      node.hostname.toLowerCase() === normalized ||
      node.aliases.some((a) => a.toLowerCase() === normalized)
    ) {
      return node;
    }
  }
  return undefined;
}

/**
 * Resolves an `InferenceEndpointNode` from the caller (`graph.coordinatorHostId`)
 * without ever trusting foreign `127.0.0.1` loopback addresses directly across machines.
 */
export function resolveEndpointForCaller(
  graph: CapabilityGraph,
  endpoint: InferenceEndpointNode,
  authorizedHostsOnly: boolean,
): EndpointResolutionResult {
  const callerHostId = graph.coordinatorHostId;
  const targetHostId = endpoint.hostId;

  if (
    endpoint.acceptanceState === 'DISABLED_BY_POLICY' ||
    endpoint.acceptanceState === 'UNAVAILABLE'
  ) {
    return {
      usable: false,
      callerHostId,
      targetHostId,
      routeVia: 'unreachable_loopback',
      reason: endpoint.diagnosticMessage ?? `Endpoint ${endpoint.endpointId} is ${endpoint.acceptanceState}`,
    };
  }

  // Case 1: Endpoint executes on the coordinator host itself and is valid from coordinator context
  if (targetHostId === callerHostId && endpoint.originContextHostId === callerHostId) {
    return {
      usable: true,
      callerHostId,
      targetHostId,
      resolvedUrl: endpoint.rawUrl,
      routeVia: isLoopbackUrl(endpoint.rawUrl) ? 'local_loopback' : 'direct',
      reason: 'Local endpoint on coordinator host',
    };
  }

  // Case 2: SSH tunnel or forwarded endpoint explicitly originating on coordinatorHostId
  if (
    endpoint.originContextHostId === callerHostId &&
    (endpoint.visibility === 'ssh_tunnel_forwarded' || endpoint.transport === 'ssh_tunnel')
  ) {
    if (endpoint.tunnelTransportId) {
      const tunnel = graph.transports[endpoint.tunnelTransportId];
      if (!tunnel || !tunnel.verifiedActive) {
        return {
          usable: false,
          callerHostId,
          targetHostId,
          routeVia: 'unreachable_loopback',
          reason: `Configured SSH tunnel '${endpoint.tunnelTransportId}' is not verified active`,
        };
      }
    }
    return {
      usable: true,
      callerHostId,
      targetHostId,
      resolvedUrl: endpoint.rawUrl,
      routeVia: 'ssh_tunnel',
      reason: 'Reachable via verified SSH tunnel from coordinator host',
    };
  }

  // Case 3: Loopback-only endpoint whose originContextHostId is a REMOTE machine
  if (
    (endpoint.visibility === 'loopback_only' || isLoopbackUrl(endpoint.rawUrl)) &&
    endpoint.originContextHostId !== callerHostId
  ) {
    // Check if an active secure transport bridges callerHostId -> targetHostId
    const matchingTransport = Object.values(graph.transports)
      .sort((a, b) => a.transportId.localeCompare(b.transportId))
      .find(
        (t) =>
          t.originHostId === callerHostId &&
          t.targetHostId === targetHostId &&
          t.verifiedActive,
      );

    if (matchingTransport) {
      return {
        usable: true,
        callerHostId,
        targetHostId,
        resolvedUrl: matchingTransport.localEndpointUrl,
        routeVia: matchingTransport.type === 'ssh_tunnel' ? 'ssh_tunnel' : 'remote_worker',
        reason: `Bridged remote loopback via active transport '${matchingTransport.transportId}'`,
      };
    }

    // Check if an online execution worker runs directly on targetHostId
    const onlineWorker = Object.values(graph.workers)
      .sort((a, b) => a.workerId.localeCompare(b.workerId))
      .find((w) => w.hostId === targetHostId && w.status === 'online');

    if (onlineWorker) {
      return {
        usable: true,
        callerHostId,
        targetHostId,
        resolvedUrl: endpoint.rawUrl,
        routeVia: 'remote_worker',
        reason: `Routed via online remote worker '${onlineWorker.workerId}' on '${targetHostId}'`,
      };
    }

    return {
      usable: false,
      callerHostId,
      targetHostId,
      routeVia: 'unreachable_loopback',
      reason: `Endpoint '${endpoint.rawUrl}' is loopback-scoped to '${endpoint.originContextHostId}', not reachable from '${callerHostId}' without an active tunnel or remote worker`,
    };
  }

  // Case 4: LAN / Tailscale / Cloud API endpoint
  if (authorizedHostsOnly && targetHostId !== callerHostId) {
    const hostIdentities = Object.values(graph.networkIdentities).filter(
      (n) => n.hostId === targetHostId,
    );
    if (hostIdentities.length > 0 && !hostIdentities.some((n) => n.authorized)) {
      return {
        usable: false,
        callerHostId,
        targetHostId,
        routeVia: 'unreachable_loopback',
        reason: `Host '${targetHostId}' has no authorized network identity in CapabilityGraph`,
      };
    }
  }

  return {
    usable: true,
    callerHostId,
    targetHostId,
    resolvedUrl: endpoint.rawUrl,
    routeVia: endpoint.visibility === 'cloud_api' ? 'cloud_api' : 'direct',
    reason: `Direct ${endpoint.visibility} route verified in CapabilityGraph`,
  };
}

function isAcceptableState(
  state: AcceptanceState,
  verifyExecutionCapability: boolean,
): boolean {
  if (
    state === 'EXECUTION_VERIFIED' ||
    state === 'CAPACITY_VERIFIED' ||
    state === 'SATURATED'
  ) {
    return true;
  }
  if (!verifyExecutionCapability && (state === 'MODEL_READY' || state === 'API_READY')) {
    return true;
  }
  return false;
}

export interface ResolvedPoolBinding {
  poolId: string;
  enabled: boolean;
  targetKind: 'local_host' | 'cloud_provider' | 'disabled';
  available: boolean;
  hostNode?: PhysicalHostNode;
  providerNode?: CodingAgentProviderNode;
  selectedEndpoint?: InferenceEndpointNode;
  endpointResolution?: EndpointResolutionResult;
  selectedRuntimeId?: string;
  selectedModel?: LoadedModelNode;
  acceptanceState: AcceptanceState;
  configuredMaxConcurrent: number;
  verifiedSafeConcurrent?: number;
  effectiveConcurrentLimit: number;
  unavailabilityReason?: string;
  lastVerifiedAt?: string;
  evidenceIds: string[];
}

export interface ResolveExecutionPlanOptions {
  totalAgentsOverride?: number;
  useSpeedOptimization?: boolean;
  independentTaskCount?: number;
  strictSharesOverride?: boolean;
  throwOnStrictShareFailure?: boolean;
  maxStaleMs?: number;
  nowIso?: string;
  verificationEvidences?: RuntimeVerificationEvidence[];
  concurrencyQualifications?: ConcurrencyQualificationResult[];
}

export interface ResolvedExecutionPlan {
  plan: DeclarativeExecutionPlan;
  feasible: boolean;
  strictSharesMode: boolean;
  strictSharesSatisfied: boolean;
  requestedAgents: number;
  scheduledAgents: number;
  unscheduledAgents: number;
  intendedVsFeasibleDelta: Record<string, number>;
  poolBindings: Record<string, ResolvedPoolBinding>;
  poolQuantities: Record<string, PoolAllocationQuantities>;
  acceptanceRows: ServerAcceptanceRow[];
  speedOptimization?: SpeedOptimizationResult;
  warnings: string[];
}

/**
 * Dynamically resolves a `DeclarativeExecutionPlan` against a live `CapabilityGraph`
 * without ever trusting static YAML host strings or URLs as live endpoints.
 *
 * Enforces:
 * - Zero Claude (`0` allocation on disabled pools even under total cluster outage)
 * - GPU/host deduplication (`prevent_gpu_double_counting`)
 * - `strict_shares: true` vs `fallback_policy: 'compatible_authorized_pool' | 'local_only'`
 */
export function resolveExecutionPlanAgainstGraph(
  plan: DeclarativeExecutionPlan,
  graph: CapabilityGraph,
  options: ResolveExecutionPlanOptions = {},
): ResolvedExecutionPlan {
  const validated = validateExecutionPlan(plan);
  const nowMs = options.nowIso ? Date.parse(options.nowIso) : Date.parse(graph.generatedAt) || Date.now();
  const maxStaleMs = options.maxStaleMs;
  const verifyExec = validated.spec.routing.verify_execution_capability;
  const authorizedOnly = validated.spec.discovery.authorized_hosts_only;
  const strictSharesMode =
    options.strictSharesOverride ??
    Boolean(validated.spec.routing.strict_shares) ??
    validated.spec.routing.fallback_policy === 'none';

  const constraintsLower = (validated.spec.routing.constraints ?? []).map((c) => c.toLowerCase());
  const localOnlyConstraint =
    validated.spec.routing.fallback_policy === 'local_only' ||
    constraintsLower.some(
      (c) =>
        /\buse\s+only\s+local\b/.test(c) ||
        /\blocal\s+machines?\s+only\b/.test(c) ||
        /\bnever\s+send\b.*\bcloud\b/.test(c) ||
        /\bdo\s+not\s+use\s+paid\s+cloud\b/.test(c),
    );

  const evidences = options.verificationEvidences ?? [];
  const qualifications = options.concurrencyQualifications ?? [];

  // Track physical machine/GPU capacity already claimed across pools to prevent GPU double counting
  const claimedMachineConcurrency = new Map<string, number>();
  const poolBindings: Record<string, ResolvedPoolBinding> = {};
  const warnings: string[] = [];

  for (const pool of validated.spec.pools) {
    if (!pool.enabled || pool.share <= 0 || pool.id.toLowerCase() === 'claude' && !pool.enabled) {
      poolBindings[pool.id] = {
        poolId: pool.id,
        enabled: false,
        targetKind: 'disabled',
        available: false,
        acceptanceState: 'DISABLED_BY_POLICY',
        configuredMaxConcurrent: 0,
        verifiedSafeConcurrent: 0,
        effectiveConcurrentLimit: 0,
        unavailabilityReason: 'Pool disabled by ExecutionPlan policy (0% share)',
        evidenceIds: [],
      };
      continue;
    }

    if (pool.provider && !pool.host) {
      // Cloud provider pool
      const providerNode =
        graph.cloudProviders[pool.provider] ??
        Object.values(graph.cloudProviders).find(
          (p) => p.providerId.toLowerCase() === pool.provider!.toLowerCase(),
        );

      if (!providerNode) {
        poolBindings[pool.id] = {
          poolId: pool.id,
          enabled: true,
          targetKind: 'cloud_provider',
          available: false,
          acceptanceState: 'UNAVAILABLE',
          configuredMaxConcurrent: pool.max_concurrent,
          effectiveConcurrentLimit: 0,
          unavailabilityReason: `Cloud provider '${pool.provider}' not discovered in CapabilityGraph`,
          evidenceIds: [],
        };
        continue;
      }

      if (providerNode.disabledByPolicy) {
        poolBindings[pool.id] = {
          poolId: pool.id,
          enabled: true,
          targetKind: 'cloud_provider',
          available: false,
          providerNode,
          acceptanceState: 'DISABLED_BY_POLICY',
          configuredMaxConcurrent: pool.max_concurrent,
          verifiedSafeConcurrent: 0,
          effectiveConcurrentLimit: 0,
          unavailabilityReason:
            providerNode.diagnostic ?? `Cloud provider '${pool.provider}' disabled by policy`,
          evidenceIds: [],
        };
        continue;
      }

      if (!providerNode.enabled) {
        poolBindings[pool.id] = {
          poolId: pool.id,
          enabled: true,
          targetKind: 'cloud_provider',
          available: false,
          providerNode,
          acceptanceState: providerNode.acceptanceState ?? 'UNAVAILABLE',
          configuredMaxConcurrent: pool.max_concurrent,
          verifiedSafeConcurrent: 0,
          effectiveConcurrentLimit: 0,
          unavailabilityReason:
            providerNode.diagnostic ?? `Cloud provider '${pool.provider}' is not configured or authenticated`,
          evidenceIds: [],
        };
        continue;
      }

      const staleCloud =
        maxStaleMs !== undefined &&
        providerNode.lastAcceptedRequestAt !== undefined &&
        nowMs - Date.parse(providerNode.lastAcceptedRequestAt) > maxStaleMs;

      const authOk =
        providerNode.authStatus === 'authenticated' || providerNode.authStatus === 'cli_available';
      const stateOk = isAcceptableState(providerNode.acceptanceState, verifyExec);
      const localBlocked =
        constraintsLower.some(
          (c) => /\buse\s+only\s+local\b/.test(c) || /\blocal\s+machines?\s+only\b/.test(c),
        );

      const providerEvidences = evidences.filter((e) => e.providerId === providerNode.providerId);
      const verifiedConc =
        providerNode.observedConcurrency > 0
          ? providerNode.observedConcurrency
          : providerNode.configuredMaxConcurrent > 0
            ? providerNode.configuredMaxConcurrent
            : undefined;
      const effectiveLimit =
        authOk && stateOk && !staleCloud && !localBlocked
          ? Math.min(pool.max_concurrent, verifiedConc ?? pool.max_concurrent)
          : 0;

      const available = effectiveLimit > 0;
      const unavailabilityReason = !available
        ? localBlocked
          ? 'Blocked by local-machines-only hard constraint'
          : staleCloud
            ? `Provider '${providerNode.providerId}' verification is stale`
            : !authOk
              ? `Provider '${providerNode.providerId}' authStatus is '${providerNode.authStatus}'`
              : providerNode.diagnostic ??
                `Provider '${providerNode.providerId}' acceptance state is '${providerNode.acceptanceState}'`
        : undefined;

      poolBindings[pool.id] = {
        poolId: pool.id,
        enabled: true,
        targetKind: 'cloud_provider',
        available,
        providerNode,
        selectedRuntimeId: providerNode.providerId,
        acceptanceState: staleCloud ? 'UNAVAILABLE' : providerNode.acceptanceState,
        configuredMaxConcurrent: pool.max_concurrent,
        verifiedSafeConcurrent: verifiedConc,
        effectiveConcurrentLimit: effectiveLimit,
        unavailabilityReason,
        lastVerifiedAt: providerNode.lastAcceptedRequestAt,
        evidenceIds: providerEvidences.map((e) => e.evidenceId),
      };
      continue;
    }

    // Local hardware host pool
    const hostKey = pool.host ?? pool.id;
    const hostNode = findHostInCapabilityGraph(graph, hostKey);
    if (!hostNode) {
      poolBindings[pool.id] = {
        poolId: pool.id,
        enabled: true,
        targetKind: 'local_host',
        available: false,
        acceptanceState: 'UNAVAILABLE',
        configuredMaxConcurrent: pool.max_concurrent,
        effectiveConcurrentLimit: 0,
        unavailabilityReason: `Host '${hostKey}' was not discovered in live CapabilityGraph`,
        evidenceIds: [],
      };
      continue;
    }

    const hostStale =
      maxStaleMs !== undefined &&
      (!hostNode.lastDiscoveredAt || nowMs - Date.parse(hostNode.lastDiscoveredAt) > maxStaleMs);

    if (hostStale) {
      poolBindings[pool.id] = {
        poolId: pool.id,
        enabled: true,
        targetKind: 'local_host',
        available: false,
        hostNode,
        acceptanceState: 'UNAVAILABLE',
        configuredMaxConcurrent: pool.max_concurrent,
        effectiveConcurrentLimit: 0,
        unavailabilityReason: `Host '${hostNode.hostId}' inventory is stale (lastDiscoveredAt=${hostNode.lastDiscoveredAt})`,
        evidenceIds: [],
      };
      continue;
    }

    // Candidate endpoints on this physical host
    const hostEndpoints = Object.values(graph.endpoints)
      .filter((ep) => ep.hostId === hostNode.hostId || ep.machineId === hostNode.machineId)
      .sort((a, b) => a.endpointId.localeCompare(b.endpointId));

    let chosenEndpoint: InferenceEndpointNode | undefined;
    let chosenResolution: EndpointResolutionResult | undefined;

    for (const ep of hostEndpoints) {
      const runtimeProc = graph.runtimeProcesses[ep.runtimeId];
      const matchesPreferredRuntime =
        !pool.preferred_runtime ||
        ep.runtimeId.toLowerCase().includes(pool.preferred_runtime.toLowerCase()) ||
        runtimeProc?.runtimeType === pool.preferred_runtime;

      const resolution = resolveEndpointForCaller(graph, ep, authorizedOnly);
      const epStale =
        maxStaleMs !== undefined &&
        ep.lastVerifiedAt !== undefined &&
        nowMs - Date.parse(ep.lastVerifiedAt) > maxStaleMs;

      if (resolution.usable && !epStale && isAcceptableState(ep.acceptanceState, verifyExec)) {
        if (!chosenEndpoint || matchesPreferredRuntime) {
          chosenEndpoint = ep;
          chosenResolution = resolution;
          if (matchesPreferredRuntime) break;
        }
      } else if (!chosenResolution) {
        chosenResolution = resolution;
      }
    }

    if (!chosenEndpoint || !chosenResolution || !chosenResolution.usable) {
      const diag =
        (chosenResolution && !chosenResolution.usable ? chosenResolution.reason : undefined) ??
        hostEndpoints[0]?.diagnosticMessage ??
        `No reachable verified inference endpoint on host '${hostNode.hostId}'`;
      poolBindings[pool.id] = {
        poolId: pool.id,
        enabled: true,
        targetKind: 'local_host',
        available: false,
        hostNode,
        endpointResolution: chosenResolution,
        acceptanceState: hostEndpoints[0]?.acceptanceState ?? 'UNAVAILABLE',
        configuredMaxConcurrent: pool.max_concurrent,
        effectiveConcurrentLimit: 0,
        unavailabilityReason: diag,
        evidenceIds: [],
      };
      continue;
    }

    // Select warm loaded model first, then fallback/installed
    const hostModels = Object.values(graph.models)
      .filter(
        (m) =>
          m.hostId === hostNode.hostId &&
          (!chosenEndpoint || m.runtimeId === chosenEndpoint.runtimeId),
      )
      .sort((a, b) => a.modelId.localeCompare(b.modelId));

    const findModelByRef = (ref: string | undefined, loadedOnly: boolean): LoadedModelNode | undefined => {
      if (!ref) return undefined;
      const lower = ref.toLowerCase();
      return hostModels.find(
        (m) =>
          (!loadedOnly || m.residency === 'loaded') &&
          (m.modelId.toLowerCase() === lower || m.modelNodeId.toLowerCase() === lower),
      );
    };

    const selectedModel =
      findModelByRef(pool.preferred_model, true) ??
      findModelByRef(pool.fallback_model, true) ??
      hostModels.find((m) => m.residency === 'loaded') ??
      findModelByRef(pool.preferred_model, false) ??
      findModelByRef(pool.fallback_model, false);

    // Verified safe concurrency from qualification results or execution slots
    const qual = qualifications.find(
      (q) =>
        q.runtimeId === chosenEndpoint!.runtimeId &&
        (!selectedModel || q.modelId === selectedModel.modelId),
    );
    const matchingSlots = Object.values(graph.executionSlots).filter(
      (s) =>
        (s.poolId === pool.id || s.hostId === hostNode.hostId) && s.state !== 'disabled',
    );

    let verifiedSafeConcurrent: number | undefined = qual?.verifiedSafeConcurrency;
    if (verifiedSafeConcurrent === undefined && matchingSlots.length > 0) {
      verifiedSafeConcurrent = matchingSlots.length;
    }

    // Resource admission & GPU double-counting prevention
    let memorySlotCap = pool.max_concurrent;
    if (
      validated.spec.routing.require_resource_admission &&
      selectedModel &&
      hostNode.memory.totalGB > 0
    ) {
      const conflictRamGB = hostNode.workloadConflicts.reduce((s, c) => s + c.reservedRamGB, 0);
      const conflictVramGB = hostNode.workloadConflicts.reduce((s, c) => s + c.reservedVramGB, 0);
      const usableMemGB = Math.max(
        0,
        hostNode.memory.availableGB -
          hostNode.resourceReservationsGB.ramGB -
          conflictRamGB -
          (hostNode.memory.unifiedMemory ? conflictVramGB : 0),
      );
      const baseNeeded =
        selectedModel.residency === 'loaded'
          ? 0
          : selectedModel.estimatedWeightsGB + selectedModel.runtimeOverheadGB;
      const kvPerSlot = Math.max(0.25, selectedModel.kvCachePerSlotGB || 0.5);
      if (usableMemGB < baseNeeded + kvPerSlot && selectedModel.residency !== 'loaded') {
        memorySlotCap = 0;
      } else if (selectedModel.kvCachePerSlotGB > 0) {
        const headroom = Math.max(0, usableMemGB - baseNeeded);
        memorySlotCap = Math.max(
          selectedModel.residency === 'loaded' ? 1 : 0,
          Math.floor(headroom / kvPerSlot),
        );
      }
    }

    let rawEffectiveLimit = Math.min(
      pool.max_concurrent,
      verifiedSafeConcurrent ?? pool.max_concurrent,
      memorySlotCap,
    );

    if (validated.spec.routing.prevent_gpu_double_counting) {
      const physicalKey =
        hostNode.gpus.length > 0
          ? `${hostNode.machineId}:${hostNode.gpus[0].gpuId}`
          : hostNode.machineId;
      const alreadyClaimed = claimedMachineConcurrency.get(physicalKey) ?? 0;
      const physicalCeiling = Math.max(pool.max_concurrent, verifiedSafeConcurrent ?? pool.max_concurrent);
      const remainingPhysical = Math.max(0, physicalCeiling - alreadyClaimed);
      if (alreadyClaimed > 0 && rawEffectiveLimit > remainingPhysical) {
        warnings.push(
          `Prevented GPU double-counting on '${physicalKey}' for pool '${pool.id}' (clamped ${rawEffectiveLimit} -> ${remainingPhysical})`,
        );
        rawEffectiveLimit = remainingPhysical;
      }
      claimedMachineConcurrency.set(physicalKey, alreadyClaimed + rawEffectiveLimit);
    }

    const hostEvidences = evidences.filter(
      (e) => e.hostId === hostNode.hostId || e.runtimeId === chosenEndpoint!.runtimeId,
    );
    const evidenceIds = Array.from(
      new Set([
        ...hostEvidences.map((e) => e.evidenceId),
        ...(qual ? [qual.evidenceId] : []),
      ]),
    );

    poolBindings[pool.id] = {
      poolId: pool.id,
      enabled: true,
      targetKind: 'local_host',
      available: rawEffectiveLimit > 0,
      hostNode,
      selectedEndpoint: chosenEndpoint,
      endpointResolution: chosenResolution,
      selectedRuntimeId: chosenEndpoint.runtimeId,
      selectedModel,
      acceptanceState: chosenEndpoint.acceptanceState,
      configuredMaxConcurrent: pool.max_concurrent,
      verifiedSafeConcurrent,
      effectiveConcurrentLimit: rawEffectiveLimit,
      unavailabilityReason:
        rawEffectiveLimit <= 0
          ? `Insufficient verified or admitted concurrency on host '${hostNode.hostId}'`
          : undefined,
      lastVerifiedAt: qual?.qualifiedAt ?? chosenEndpoint.lastVerifiedAt,
      evidenceIds,
    };
  }

  const requestedAgents = options.totalAgentsOverride ?? validated.spec.execution.total_agents;
  const verifiedTotalConc = Object.values(poolBindings).reduce(
    (sum, b) => sum + (b.available ? b.effectiveConcurrentLimit : 0),
    0,
  );

  const speedOptimization =
    options.useSpeedOptimization || validated.spec.execution.speed_optimization
      ? optimizeAgentAllocationForSpeed({
          plan: validated,
          requestedAgents,
          independentTaskCount: options.independentTaskCount,
          verifiedTotalConcurrency: verifiedTotalConc > 0 ? verifiedTotalConc : undefined,
        })
      : undefined;

  const targetCount = options.useSpeedOptimization && speedOptimization
    ? speedOptimization.speedOptimizedActiveAgents
    : requestedAgents;

  const baseApportionment = apportionAgentsLargestRemainder(validated, targetCount);

  // Compute feasible allocation per pool according to strict_shares vs fallback_policy
  const feasibleByPool: Record<string, number> = {};
  const reroutedFromByPool: Record<string, string[]> = {};
  let unscheduledAgents = 0;

  for (const pool of validated.spec.pools) {
    const binding = poolBindings[pool.id];
    const intended = baseApportionment.byPool[pool.id].allocatedAgents;
    if (!pool.enabled || !binding.available) {
      feasibleByPool[pool.id] = 0;
    } else {
      feasibleByPool[pool.id] = intended;
    }
  }

  const unavailableActivePools = validated.spec.pools.filter(
    (p) => p.enabled && baseApportionment.byPool[p.id].allocatedAgents > 0 && !poolBindings[p.id].available,
  );

  if (unavailableActivePools.length > 0) {
    const displacedSeats = unavailableActivePools.reduce(
      (sum, p) => sum + baseApportionment.byPool[p.id].allocatedAgents,
      0,
    );

    if (strictSharesMode || validated.spec.routing.fallback_policy === 'none') {
      unscheduledAgents = displacedSeats;
      for (const up of unavailableActivePools) {
        warnings.push(
          `Strict shares active: pool '${up.id}' unavailable (${poolBindings[up.id].unavailabilityReason}); ${baseApportionment.byPool[up.id].allocatedAgents} agent(s) left unscheduled.`,
        );
      }
    } else {
      // Eligible healthy fallback pools: NEVER disabled pools (NEVER claude!), and honor local_only!
      const fallbackCandidates = validated.spec.pools.filter((p) => {
        if (!p.enabled || p.share <= 0) return false;
        if (p.id.toLowerCase() === 'claude' || p.provider?.toLowerCase() === 'claude') return false;
        const b = poolBindings[p.id];
        if (!b.available || b.effectiveConcurrentLimit <= 0) return false;
        if (localOnlyConstraint && b.targetKind !== 'local_host') return false;
        return true;
      });

      if (fallbackCandidates.length === 0) {
        unscheduledAgents = displacedSeats;
        warnings.push(
          `No compatible authorized healthy fallback pool available for ${displacedSeats} displaced agent(s); disabled pools remain at 0.`,
        );
      } else {
        const spillover = apportionProportionalShares(fallbackCandidates, displacedSeats);
        const failedIds = unavailableActivePools.map((u) => u.id);
        for (const candidate of fallbackCandidates) {
          const extra = spillover.byPool[candidate.id].allocatedAgents;
          if (extra > 0) {
            feasibleByPool[candidate.id] = (feasibleByPool[candidate.id] ?? 0) + extra;
            reroutedFromByPool[candidate.id] = [...failedIds];
          }
        }
      }
    }
  }

  const intendedVsFeasibleDelta: Record<string, number> = {};
  const poolQuantities: Record<string, PoolAllocationQuantities> = {};
  const acceptanceRows: ServerAcceptanceRow[] = [];

  for (const pool of validated.spec.pools) {
    const binding = poolBindings[pool.id];
    const intended = baseApportionment.byPool[pool.id].allocatedAgents;
    const feasible = pool.enabled ? (feasibleByPool[pool.id] ?? 0) : 0;
    intendedVsFeasibleDelta[pool.id] = feasible - intended;

    const prefix = inferPoolAgentPrefix(pool);
    const assignedLogicalAgentIds = pool.enabled ? buildLogicalAgentIds(prefix, feasible) : [];

    poolQuantities[pool.id] = {
      poolId: pool.id,
      enabled: pool.enabled,
      targetSharePct: pool.enabled ? pool.share : 0,
      targetAllocation: intended,
      feasibleAllocation: feasible,
      admittedAgents: 0,
      runningAgents: 0,
      queuedAgents: 0,
      completedAgents: 0,
      failedAgents: 0,
      configuredMaxConcurrent: pool.max_concurrent,
      verifiedSafeConcurrent: binding.verifiedSafeConcurrent,
      effectiveConcurrentLimit: binding.effectiveConcurrentLimit,
      assignedLogicalAgentIds,
      reroutedFromPools: reroutedFromByPool[pool.id],
      unavailabilityReason: binding.unavailabilityReason,
    };

    acceptanceRows.push({
      pool: pool.id,
      host: binding.hostNode?.hostId ?? binding.providerNode?.providerId ?? pool.host ?? pool.provider ?? 'disabled',
      endpoint: binding.endpointResolution?.resolvedUrl ?? binding.providerNode?.providerId ?? 'none',
      runtime: binding.selectedRuntimeId ?? pool.preferred_runtime ?? 'none',
      model:
        binding.selectedModel?.modelId ??
        binding.providerNode?.supportedModelsOrModes[0] ??
        'unobserved',
      targetSharePct: pool.enabled ? pool.share : 0,
      assigned: feasible,
      admitted: 0,
      running: 0,
      queued: 0,
      completed: 0,
      failed: 0,
      capacity: binding.effectiveConcurrentLimit,
      configuredMaxConcurrent: pool.max_concurrent,
      verifiedConcurrency: binding.verifiedSafeConcurrent,
      status: binding.acceptanceState,
      lastVerifiedAt: binding.lastVerifiedAt,
      evidenceIds: binding.evidenceIds,
      diagnostic: binding.unavailabilityReason,
    });
  }

  const scheduledAgents = Object.values(feasibleByPool).reduce((s, v) => s + v, 0);
  const strictSharesSatisfied = Object.values(intendedVsFeasibleDelta).every((d) => d === 0);
  const feasible = unscheduledAgents === 0 && scheduledAgents === targetCount;

  if (strictSharesMode && !strictSharesSatisfied && options.throwOnStrictShareFailure) {
    throw new ExecutionPlanValidationError(
      `Strict share allocation unfeasible: ${unscheduledAgents} agent(s) could not be scheduled (${JSON.stringify(intendedVsFeasibleDelta)})`,
    );
  }

  return {
    plan: validated,
    feasible,
    strictSharesMode,
    strictSharesSatisfied,
    requestedAgents,
    scheduledAgents,
    unscheduledAgents,
    intendedVsFeasibleDelta,
    poolBindings,
    poolQuantities,
    acceptanceRows,
    speedOptimization,
    warnings,
  };
}

/**
 * Part 9: Builds a `CONFIGURATION_ONLY` report directly from a declarative plan.
 * Never fabricates hardware IDs, model IDs, runtime health, or verified concurrency.
 */
export function buildConfigurationReportJson(
  plan: DeclarativeExecutionPlan,
  generatedAt: string = new Date().toISOString(),
): MachineReadableExecutionReport {
  const validated = validateExecutionPlan(plan);
  const requestedAgents = validated.spec.execution.total_agents;
  const apportionment = apportionAgentsLargestRemainder(validated, requestedAgents);
  const speedOpt =
    validated.spec.execution.speed_optimization
      ? optimizeAgentAllocationForSpeed({ plan: validated, requestedAgents })
      : undefined;

  const configuredConcurrencyLimit = validated.spec.pools
    .filter((p) => p.enabled && p.share > 0)
    .reduce((sum, p) => sum + p.max_concurrent, 0);

  const pools: MachineReadableExecutionReport['pools'] = {};
  for (const pool of validated.spec.pools) {
    const entry = apportionment.byPool[pool.id];
    pools[pool.id] = {
      target_share: pool.enabled ? pool.share : 0,
      assigned_agents: entry.allocatedAgents,
      configured_max_concurrent: pool.max_concurrent,
      enabled: pool.enabled,
    };
  }

  return {
    plan: validated.metadata.name,
    reportMode: 'CONFIGURATION_ONLY',
    generatedAt,
    allocation: {
      requested_agents: requestedAgents,
      assigned_agents: apportionment.allocatedTotal,
      ...(speedOpt ? { speed_optimized_active_agents: speedOpt.speedOptimizedActiveAgents } : {}),
      configured_concurrency_limit: configuredConcurrencyLimit,
    },
    pools,
    qualification: {
      status: 'PENDING_LIVE_VERIFICATION',
    },
  };
}

export interface BuildLiveExecutionReportParams {
  plan: DeclarativeExecutionPlan;
  graph: CapabilityGraph;
  resolvedPlan?: ResolvedExecutionPlan;
  poolQuantities?: Record<string, PoolAllocationQuantities>;
  tasks?: DurableManagedTask[];
  verificationEvidences?: RuntimeVerificationEvidence[];
  concurrencyQualifications?: ConcurrencyQualificationResult[];
  costAndUtilization?: {
    cloud_provider_cost_usd: number;
    local_hardware_utilization_pct: Record<string, number>;
    operational_overhead_ms: number;
  };
  qualificationStatus?: MachineReadableExecutionReport['qualification']['status'];
  journeysPassed?: string[];
  acceptanceTestsPassed?: string[];
  generatedAt?: string;
}

/**
 * Part 9: Builds a `LIVE_OBSERVED_EXECUTION` report strictly from independently observed
 * hardware entities, live verification evidence, concurrency qualifications, and durable
 * task execution records — never fabricating unobserved fields.
 */
export function buildLiveExecutionReportJson(
  params: BuildLiveExecutionReportParams,
): MachineReadableExecutionReport {
  const validated = validateExecutionPlan(params.plan);
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const evidences = params.verificationEvidences ?? [];
  const qualifications = params.concurrencyQualifications ?? [];
  const tasks = params.tasks ?? [];

  const resolved =
    params.resolvedPlan ??
    resolveExecutionPlanAgainstGraph(validated, params.graph, {
      verificationEvidences: evidences,
      concurrencyQualifications: qualifications,
      nowIso: generatedAt,
    });

  const quantitiesMap = params.poolQuantities ?? resolved.poolQuantities;

  const configuredConcurrencyLimit = validated.spec.pools
    .filter((p) => p.enabled && p.share > 0)
    .reduce((sum, p) => sum + p.max_concurrent, 0);

  let hasAnyVerified = false;
  let verifiedConcurrencySum = 0;

  const poolsReport: MachineReadableExecutionReport['pools'] = {};
  const allEvidenceIds = new Set<string>();

  for (const pool of validated.spec.pools) {
    const binding = resolved.poolBindings[pool.id];
    const q = quantitiesMap[pool.id];

    const poolTasks = tasks.filter(
      (t) => (t.executedPoolId ?? t.assignedPoolId) === pool.id,
    );
    const completedTasks = poolTasks.filter((t) => t.state === 'completed' && t.verificationPassed !== false);
    const runningTasksCount = q ? q.runningAgents : poolTasks.filter((t) => t.state === 'running' || t.state === 'verifying').length;
    const queuedTasksCount = q ? q.queuedAgents : poolTasks.filter((t) => t.state === 'queued' || t.state === 'admitted').length;
    const completedCount = q ? q.completedAgents : completedTasks.length;
    const failedCount = q ? q.failedAgents : poolTasks.filter((t) => t.state === 'failed').length;
    const admittedCount = q ? q.admittedAgents : runningTasksCount + queuedTasksCount + completedCount;

    if (binding?.verifiedSafeConcurrent !== undefined) {
      hasAnyVerified = true;
      verifiedConcurrencySum += binding.verifiedSafeConcurrent;
    }

    // Strictly populate observed fields ONLY when backed by real entities / measurements
    const hostNode = binding?.hostNode;
    const providerNode = binding?.providerNode;
    const poolEvidences = evidences.filter(
      (e) =>
        (hostNode && e.hostId === hostNode.hostId) ||
        (providerNode && e.providerId === providerNode.providerId) ||
        (binding?.selectedRuntimeId && e.runtimeId === binding.selectedRuntimeId),
    );
    const poolQual = qualifications.find(
      (cq) =>
        (hostNode && cq.hostId === hostNode.hostId) ||
        (binding?.selectedRuntimeId && cq.runtimeId === binding.selectedRuntimeId),
    );

    const evidenceArtifactIds = Array.from(
      new Set([
        ...(binding?.evidenceIds ?? []),
        ...poolEvidences.map((e) => e.evidenceId),
        ...(poolQual ? [poolQual.evidenceId] : []),
        ...completedTasks
          .map((t) => t.verificationEvidenceId)
          .filter((id): id is string => Boolean(id)),
      ]),
    );
    for (const id of evidenceArtifactIds) {
      allEvidenceIds.add(id);
    }

    // Actual model ID only from observed execution lease, verification evidence, or loaded/managed model node
    const taskModelId = poolTasks.find((t) => t.lease?.modelId)?.lease?.modelId;
    const evidenceModelId = poolEvidences.find((e) => e.inferenceExecuted && e.modelId)?.modelId;
    const loadedModelId =
      binding?.selectedModel &&
      (binding.selectedModel.residency === 'loaded' ||
        binding.selectedModel.residency === 'provider_managed')
        ? binding.selectedModel.modelId
        : undefined;
    const actualModelId = taskModelId ?? evidenceModelId ?? poolQual?.modelId ?? loadedModelId;

    // Observed latency & tokens/sec strictly from measured tasks or real inference probes
    const taskLatencies = completedTasks
      .map((t) => t.latencyMs)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const evidenceLatencies = poolEvidences
      .map((e) => e.endToEndLatencyMs)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const latencySamples = taskLatencies.length > 0 ? taskLatencies : evidenceLatencies;
    const avgLatencyMs =
      latencySamples.length > 0
        ? latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length
        : poolQual?.endToEndLatencyMsP50;

    const tpsSamples = poolEvidences
      .map((e) => e.tokensPerSecond)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const tokensPerSecond =
      poolQual?.tokensPerSecondAggregate ??
      (tpsSamples.length > 0
        ? tpsSamples.reduce((a, b) => a + b, 0) / tpsSamples.length
        : binding?.selectedModel?.measuredTokensPerSecond);

    const verifiedAt =
      poolQual?.qualifiedAt ??
      poolEvidences[0]?.verifiedAt ??
      binding?.lastVerifiedAt;

    const hostSummary = hostNode
      ? `${hostNode.hostname} (${hostNode.os.platform}/${hostNode.os.architecture}, ${hostNode.memory.totalGB}GB RAM)`
      : providerNode
        ? `${providerNode.displayName} (${providerNode.authStatus})`
        : undefined;

    const resolvedEndpointUrl = binding?.endpointResolution?.usable
      ? binding.endpointResolution.resolvedUrl
      : undefined;

    poolsReport[pool.id] = {
      target_share: pool.enabled ? pool.share : 0,
      assigned_agents: q ? q.feasibleAllocation : 0,
      configured_max_concurrent: pool.max_concurrent,
      enabled: pool.enabled,
      observed: {
        ...(hostNode ? { physical_hardware_id: hostNode.machineId } : {}),
        ...(hostSummary ? { host_summary: hostSummary } : {}),
        ...(resolvedEndpointUrl ? { endpoint: resolvedEndpointUrl } : {}),
        runtime_health: pool.enabled
          ? (binding?.acceptanceState ?? 'UNKNOWN')
          : 'DISABLED_BY_POLICY',
        ...(actualModelId ? { actual_model_id: actualModelId } : {}),
        ...(binding?.verifiedSafeConcurrent !== undefined
          ? { verified_concurrency: binding.verifiedSafeConcurrent }
          : {}),
        admitted_tasks: admittedCount,
        running_tasks: runningTasksCount,
        queued_tasks: queuedTasksCount,
        completed_tasks: completedCount,
        failed_requests: failedCount,
        ...(avgLatencyMs !== undefined ? { avg_latency_ms: avgLatencyMs } : {}),
        ...(tokensPerSecond !== undefined ? { tokens_per_second: tokensPerSecond } : {}),
        ...(verifiedAt ? { verified_at: verifiedAt } : {}),
        evidence_artifact_ids: evidenceArtifactIds,
      },
    };
  }

  // Derive cost and local utilization if not explicitly supplied
  const derivedCloudCost = tasks.reduce((sum, t) => sum + (t.cloudCostUsd || 0), 0);
  const derivedLocalUtil: Record<string, number> = {};
  for (const host of Object.values(params.graph.hosts)) {
    const hostPools = validated.spec.pools.filter(
      (p) => poolBindingsMatchHost(resolved.poolBindings[p.id], host.hostId),
    );
    const cap = hostPools.reduce(
      (s, p) => s + (resolved.poolBindings[p.id]?.effectiveConcurrentLimit ?? 0),
      0,
    );
    const active = hostPools.reduce(
      (s, p) => s + (quantitiesMap[p.id]?.runningAgents ?? 0),
      0,
    );
    derivedLocalUtil[host.hostId] = cap > 0 ? Math.min(100, (active / cap) * 100) : 0;
  }

  const totalAssigned = Object.values(quantitiesMap).reduce(
    (sum, q) => sum + q.feasibleAllocation,
    0,
  );
  const totalCompleted = Object.values(quantitiesMap).reduce(
    (sum, q) => sum + q.completedAgents,
    0,
  );
  const totalFailed = Object.values(quantitiesMap).reduce(
    (sum, q) => sum + q.failedAgents,
    0,
  );

  let inferredStatus: MachineReadableExecutionReport['qualification']['status'];
  if (params.qualificationStatus) {
    inferredStatus = params.qualificationStatus;
  } else if (totalCompleted > 0 && totalFailed === 0 && allEvidenceIds.size > 0) {
    inferredStatus = 'QUALIFICATION_PASSED';
  } else if (hasAnyVerified || allEvidenceIds.size > 0) {
    inferredStatus = totalFailed > 0 ? 'DEGRADED_PARTIAL' : 'EXECUTION_VERIFIED';
  } else if (!resolved.feasible && totalAssigned === 0) {
    inferredStatus = 'FAILED';
  } else {
    inferredStatus = 'PENDING_LIVE_VERIFICATION';
  }

  return {
    plan: validated.metadata.name,
    reportMode: 'LIVE_OBSERVED_EXECUTION',
    generatedAt,
    allocation: {
      requested_agents: validated.spec.execution.total_agents,
      assigned_agents: totalAssigned,
      ...(resolved.speedOptimization
        ? { speed_optimized_active_agents: resolved.speedOptimization.speedOptimizedActiveAgents }
        : {}),
      configured_concurrency_limit: configuredConcurrencyLimit,
      ...(hasAnyVerified ? { verified_concurrency_limit: verifiedConcurrencySum } : {}),
    },
    pools: poolsReport,
    cost_and_utilization: params.costAndUtilization ?? {
      cloud_provider_cost_usd: derivedCloudCost,
      local_hardware_utilization_pct: derivedLocalUtil,
      operational_overhead_ms: 0,
    },
    qualification: {
      status: inferredStatus,
      ...(params.journeysPassed ? { journeys_passed: params.journeysPassed } : {}),
      ...(params.acceptanceTestsPassed
        ? { acceptance_tests_passed: params.acceptanceTestsPassed }
        : {}),
      evidence_artifacts: Array.from(allEvidenceIds).sort(),
    },
  };
}

function poolBindingsMatchHost(
  binding: ResolvedPoolBinding | undefined,
  hostId: string,
): boolean {
  return Boolean(binding && binding.hostNode && binding.hostNode.hostId === hostId);
}
