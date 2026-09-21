import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentPhase,
  AgentRunRequest,
  AgentRuntime,
  AgentTurn,
  ChatMessage,
  ModelProtocolMetrics,
} from '@wazir/core';
import {
  ModelProtocolAdapter,
  ACTION_START_PATTERN,
  normalizeToolArguments,
  validateToolActionSemantics,
} from './protocolAdapters.js';

export interface CodingAgentOptions {
  maxTurns?: number;
  maxRepairCycles?: number;
  maxTokensPerTurn?: number;
  temperature?: number;
  /**
   * Wall-clock budget for a single model turn, independent of the overall
   * job timeout. Small/local models can ramble in prose for minutes without
   * ever emitting the required JSON action; without this, one bad turn can
   * consume the entire job's timeout budget before the normal
   * invalid-response retry logic ever gets a second attempt.
   */
  modelTurnTimeoutMs?: number;
  /**
   * Number of consecutive tool calls with identical name+input that trips
   * the circuit breaker. A model stuck retrying the exact same shell
   * command or write is a much stronger and cheaper "stuck" signal than
   * waiting for a timeout or the turn cap.
   */
  toolRepeatLimit?: number;
  /**
   * Fraction of `contextTokens` (when the host provides it) at which older
   * turns are collapsed into one deterministic summary message. Keeps a
   * long-running task on a small local context window from silently
   * overflowing before it hits `maxTurns`.
   */
  contextCompactionRatio?: number;
  /**
   * If a turn accumulates this many characters of streamed output without
   * ever opening its one required JSON object, it is cancelled immediately
   * instead of running to `modelTurnTimeoutMs` or `maxTokensPerTurn`.
   * Observed on a local model: it re-derived an entire file's source as
   * prose "thinking" (5000+ chars, no `{` in sight) before ever producing
   * an action — well inside both the time and token budget, just wastefully
   * slow. `parseAction` only ever looks for the first `{...}` anyway, so
   * prose this long with none yet is a strong, cheap "not converging" signal.
   */
  maxProseBeforeActionChars?: number;
  /** Extra instructions appended to the system prompt. */
  systemPromptExtra?: string;
}

const CHECK_TOOLS = new Set(['test', 'lint', 'typecheck', 'build']);
const FILE_TOOLS = new Set(['write', 'edit']);
/**
 * Matches the start of the one required JSON action, e.g. `{"action":`.
 * Used (not a bare `{` check) so the prose-bailout heuristic below isn't
 * defeated by curly-brace languages: a model discussing/quoting C++/Java/JS
 * source in its reasoning will contain plenty of literal `{` characters
 * that have nothing to do with the action object it still hasn't emitted.
 */
const ACTION_START_RE = ACTION_START_PATTERN;

export interface ParsedAction {
  action: string;
  content?: string;
  tool?: string;
  input?: Record<string, unknown>;
  summary?: string;
  protocol?: string;
}

const CONTROL_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * Re-balances brackets outside of string literals. Local models frequently
 * emit `{"content":["a","b"}` or `{"content":["a","b"}]`; this closes what
 * is still open and drops closers that do not match. It also escapes raw
 * control characters (unescaped newlines/tabs) that models sometimes leave
 * inside multi-line string values, which JSON.parse otherwise rejects.
 */
function repairBrackets(text: string): string {
  const stack: string[] = [];
  let out = '';
  let inString = false;
  let escape = false;
  for (const char of text) {
    if (inString) {
      if (escape) {
        out += char;
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        out += char;
        continue;
      }
      if (char === '"') {
        inString = false;
        out += char;
        continue;
      }
      if (char < ' ') {
        out += CONTROL_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
        continue;
      }
      out += char;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
      out += char;
    } else if (char === '}' || char === ']') {
      if (stack.length === 0) continue;
      const expected = stack[stack.length - 1];
      if (char !== expected) {
        out += expected;
        stack.pop();
        if (stack.length > 0 && stack[stack.length - 1] === char) {
          stack.pop();
          out += char;
        }
        continue;
      }
      stack.pop();
      out += char;
    } else {
      out += char;
    }
  }
  if (inString) out += '"';
  while (stack.length > 0) out += stack.pop();
  return out;
}

function tryParseObject(candidate: string): Record<string, unknown> | null {
  for (const attempt of [candidate, repairBrackets(candidate)]) {
    try {
      const obj = JSON.parse(attempt) as unknown;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Slices out the first balanced `{...}` object starting at `text`'s first `{"action":`
 * (falling back to its first bare `{` if that never appears). Local models routinely
 * preface the real action with a sentence of prose reasoning first — and when that prose
 * itself contains a brace (quoting the task, e.g. "sorts the array {5,3,1,4,2}", or a code
 * snippet), starting from the *first* `{` in the whole text grabs that unrelated brace
 * instead — `{5,3,1,4,2}` is not valid JSON, so the real action a few lines later was
 * never even attempted, and every turn read as "model produced no JSON action" even
 * though it plainly had, every time (confirmed live: raw model output captured via
 * AgentTurn.raw showed a well-formed `{"action":"plan",...}` on every single "invalid"
 * turn). Local models frequently ignore the "exactly one JSON object" rule too, emitting
 * several back to back (e.g. one `read` per line); scanning to the *last* `}` in the text
 * would swallow all of them into one invalid blob, so this stops at the first object's
 * matching close brace instead. If the object never balances (e.g. an unterminated
 * array), it falls back to everything from `start` onward so repairBrackets can still
 * attempt it.
 */
function extractFirstObject(text: string): string | null {
  const actionMatch = text.search(ACTION_START_RE);
  const start = actionMatch !== -1 ? actionMatch : text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

export function parseAction(text: string, toolNames: Set<string> = new Set()): ParsedAction | null {
  const canonical = ModelProtocolAdapter.parse(text, toolNames);
  if (canonical) {
    return canonical as unknown as ParsedAction;
  }
  return null;
}

/**
 * Quotes a single shell argument the POSIX-safe way: wrap in single quotes,
 * escaping any embedded single quote as `'\''`. Anything made only of
 * shell-safe characters is left bare for readability.
 */
function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9_.\-/=:@%,]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Local/small models frequently send the `shell` tool's command as an argv
 * array (`{"command":["mkdir","-p","x"]}`) — the shape many other
 * tool-calling conventions use — instead of the single string the policy
 * engine and the tool itself require (`typeof input.command === 'string'`).
 * An array silently becomes `''` downstream, producing a confusing
 * "empty shell command" denial that repeats every retry since the model
 * has no reason to change its formatting. Coercing it here, once, fixes
 * every consumer instead of teaching each one to tolerate the array shape.
 */
function coerceShellCommand(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.command === 'string') return input;
  if (Array.isArray(input.command)) {
    return { ...input, command: input.command.map((part) => quoteShellArg(String(part))).join(' ') };
  }
  // Some models use `cmd` despite the schema naming the field `command`.
  if (typeof input.cmd === 'string' && input.command === undefined) {
    return { ...input, command: input.cmd };
  }
  return input;
}

/**
 * When a tool action has no `input` object, the model either flattened the
 * arguments as sibling fields (`{"action":"tool","tool":"shell","command":"..."}`,
 * forgetting the `input` wrapper) or used a differently-named container from
 * another tool-calling convention (`parameters`/`arguments`/`args`). Either
 * way the real arguments still exist on the object — without this, every
 * call site's `action.input ?? {}` silently drops them, and the tool runs
 * with no arguments at all instead of the ones the model actually gave it.
 */
function collectStrayInput(action: ParsedAction): Record<string, unknown> | undefined {
  const record = action as unknown as Record<string, unknown>;
  const altContainer = record.parameters ?? record.arguments ?? record.args ?? record.input;
  if (altContainer && typeof altContainer === 'object' && !Array.isArray(altContainer)) {
    return altContainer as Record<string, unknown>;
  }
  const { action: _action, tool: _tool, name: _name, summary: _summary, protocol: _protocol, ...rest } = record;
  return Object.keys(rest).length > 0 ? (rest as Record<string, unknown>) : undefined;
}

/**
 * Some models (observed live on nvidia/nemotron-3-nano-omni) wrap the real arguments in
 * an extra `content` object instead of putting them directly on `input`:
 * `{"tool":"shell","input":{"content":{"command":"ls -la"}}}` instead of the schema's
 * `{"tool":"shell","input":{"command":"ls -la"}}`. Nothing reads `input.content.command`,
 * so the tool sees no `command` at all and the call is denied as empty — confirmed via a
 * live repro whose recorded tool call was exactly `input: { content: { command: "ls -la" } }`.
 * Only unwraps when `content` is the *sole* key and holds a plain object: `write`'s own
 * `content` field is a plain string that always sits alongside `path` (never the only key,
 * never itself an object), so a legitimate write call can never match this.
 */
function unwrapContentWrapper(input: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(input);
  if (keys.length === 1 && keys[0] === 'content') {
    const inner = input.content;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
  }
  return input;
}

/** Accepts `{"action":"read",...}` as shorthand for `{"action":"tool","tool":"read",...}`. */
export function normalizeAction(action: ParsedAction | null, toolNames: Set<string>): ParsedAction | null {
  if (!action) return null;
  if (action.action === 'tool') {
    const alias = (action as unknown as { name?: unknown }).name;
    if (!action.tool && typeof alias === 'string') {
      action.tool = alias;
    }
    if (!action.input) {
      action.input = collectStrayInput(action);
    }
    if (action.input) {
      action.input = unwrapContentWrapper(action.input);
    }
    if (action.tool) {
      action.input = normalizeToolArguments(action.tool, action.input ?? {});
      const { action: act, tool: t, input: inp, protocol } = action as unknown as Record<string, unknown>;
      return {
        action: act as string,
        tool: t as string,
        input: (inp as Record<string, unknown>) ?? {},
        ...(protocol ? { protocol: protocol as string } : {}),
      };
    }
    return action;
  }
  if (toolNames.has(action.action)) {
    const { action: tool, input, ...rest } = action as ParsedAction & Record<string, unknown>;
    let normalizedInput = (input ?? (rest as Record<string, unknown>)) as Record<string, unknown>;
    normalizedInput = unwrapContentWrapper(normalizedInput);
    normalizedInput = normalizeToolArguments(tool, normalizedInput);
    return { action: 'tool', tool, input: normalizedInput };
  }
  return action;
}

// Required-field checks for built-in tools.
export const REQUIRED_TOOL_FIELDS: Record<string, string[]> = {
  read: ['path'],
  write: ['path', 'content'],
  shell: ['command'],
  glob: ['pattern'],
};

export function missingRequiredFields(tool: string, input: Record<string, unknown>): string[] {
  const required = REQUIRED_TOOL_FIELDS[tool];
  if (!required) return [];
  return required.filter((field) => input[field] === undefined || input[field] === null);
}

export function validationFailureMessage(
  tool: string,
  errorReason: string,
  attemptNumber: number = 1,
): { ok: false; output: string } {
  const schemas: Record<string, { schema: string; example: string }> = {
    glob: {
      schema: 'pattern (required non-empty string), path (optional string)',
      example: '{"action":"tool","tool":"glob","input":{"pattern":"**/*"}}',
    },
    shell: {
      schema: 'command (required non-empty string)',
      example: '{"action":"tool","tool":"shell","input":{"command":"g++ -o main main.cpp"}}',
    },
    read: {
      schema: 'path (required non-empty string)',
      example: '{"action":"tool","tool":"read","input":{"path":"src/main.cpp"}}',
    },
    write: {
      schema: 'path (required non-empty string), content (required string)',
      example: '{"action":"tool","tool":"write","input":{"path":"src/main.cpp","content":"..."}}',
    },
    edit: {
      schema: 'path (required non-empty string), oldString (required string), newString (required string)',
      example: '{"action":"tool","tool":"edit","input":{"path":"src/main.cpp","oldString":"...","newString":"..."}}',
    },
  };

  const info = schemas[tool];
  const schemaPart = info ? `\nRequired schema for '${tool}':\n  ${info.schema}\nExample:\n  ${info.example}` : '';

  if (attemptNumber > 1) {
    return {
      ok: false,
      output:
        `ACTION_VALIDATION_FAILED (Attempt ${attemptNumber}): '${tool}' ${errorReason}.${schemaPart}\n` +
        `Respond ONLY with a corrected tool call JSON object. Do not explain. Do not plan.`,
    };
  }

  return {
    ok: false,
    output:
      `ACTION_VALIDATION_FAILED: '${tool}' ${errorReason}.${schemaPart}\n` +
      `Respond ONLY with a corrected {"action":"tool","tool":"${tool}","input":{...}} that satisfies the schema. Do not repeat the same incomplete call.`,
  };
}

export function buildSystemPrompt(projectRoot: string, tools: AgentRuntime['tools'], extra?: string): string {
  const toolLines = tools
    .map((t) => `- ${t.name}: ${t.description} input: ${JSON.stringify(t.inputSchema).slice(0, 240)}`)
    .join('\n');
  return [
    "You are Wazir's native coding agent, executing inside a sandboxed project.",
    'You act in phases: plan, inspect, implement, test, debug, repair, verify, complete.',
    'Each turn you MUST output exactly one JSON object and nothing else. No markdown fences, no commentary.',
    'Allowed shapes:',
    '{"action":"plan","content":"short step list"}',
    '{"action":"tool","tool":"<tool name>","input":{...}}',
    '{"action":"done","summary":"what was accomplished and how it was verified"}',
    'Tools available:',
    toolLines,
    'Rules:',
    '- Inspect the repository before editing it.',
    '- Make minimal, correct changes.',
    '- After implementing, run the test/lint/typecheck tools and fix any failures.',
    '- Never fabricate tool results or claim checks you did not run.',
    '- Respond with a tool call until the work is done, then respond with {"action":"done",...}.',
    `Project root: ${projectRoot}`,
    extra ? extra : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Native Wazir coding agent.
 *
 * Loop: PLAN → INSPECT → IMPLEMENT → TEST → DEBUG → REPAIR → VERIFY → COMPLETE
 *
 * - The model proposes one JSON action per turn (tool call, plan, or done).
 * - Every tool call is executed through the policy-gated runtime — the model
 *   can never bypass policy.
 * - Verification is deterministic: Wazir itself re-runs the checks after the
 *   model reports done, and drives bounded repair cycles on failure.
 */
export class CodingAgent implements AgentAdapter {
  readonly descriptor: AgentDescriptor = {
    name: 'wazir-coding',
    version: '0.1.0',
    description: 'Native Wazir coding agent: plan, inspect, implement, test, repair, verify.',
    capabilities: ['coding', 'agenticExecution', 'codeAnalysis'],
    requiredTools: ['read', 'write', 'edit', 'search', 'glob', 'shell', 'git', 'test', 'lint', 'typecheck', 'build'],
    modelRequirements: {
      capabilities: ['coding'],
      minimumContext: 8192,
    },
    permissions: [
      'filesystem_read',
      'filesystem_write',
      'shell_execute',
      'git_execute',
      'test_run',
      'build_run',
    ],
    taskTypes: ['coding', 'debugging', 'code_analysis'],
    strategy: 'plan-inspect-implement-test-repair-verify',
  };

  private readonly maxTurns: number;
  private readonly maxRepairCycles: number;
  private readonly maxTokensPerTurn: number;
  private readonly temperature: number;
  private readonly modelTurnTimeoutMs: number;
  private readonly toolRepeatLimit: number;
  private readonly contextCompactionRatio: number;
  private readonly maxProseBeforeActionChars: number;
  private readonly systemPromptExtra?: string;

  constructor(options: CodingAgentOptions = {}) {
    this.maxTurns = options.maxTurns ?? 30;
    this.maxRepairCycles = options.maxRepairCycles ?? 2;
    this.maxTokensPerTurn = options.maxTokensPerTurn ?? 4096;
    this.temperature = options.temperature ?? 0.2;
    this.modelTurnTimeoutMs = options.modelTurnTimeoutMs ?? 90_000;
    this.toolRepeatLimit = options.toolRepeatLimit ?? 3;
    this.contextCompactionRatio = options.contextCompactionRatio ?? 0.7;
    this.maxProseBeforeActionChars = options.maxProseBeforeActionChars ?? 2_000;
    this.systemPromptExtra = options.systemPromptExtra;
  }

  async *run(
    request: AgentRunRequest,
    runtime: AgentRuntime,
  ): AsyncIterable<AgentTurn> {
    // A caller-supplied per-task limit overrides the agent's own default —
    // `this.maxTurns` must stay untouched since one CodingAgent instance is
    // shared across many concurrent/sequential runs.
    const maxTurns = request.maxTurns ?? this.maxTurns;
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(request.projectRoot, runtime.tools, this.systemPromptExtra) },
      {
        role: 'user',
        content:
          `Task: ${request.taskDescription}\n\n` +
          'Start with a plan. You may inspect the repository with read/glob/search tools first. ' +
          'Respond now with either a plan or a tool call.',
      },
    ];

    let turnsUsed = 0;
    let plan: string | null = null;
    let modelSummary: string | undefined;
    const checkOutputs: Array<{ name: string; ok: boolean; output: string }> = [];
    let correctionCount = 0;

    // ---- circuit breaker: same tool + same input called back to back ----
    let lastToolSignature: string | null = null;
    let repeatedToolCount = 0;
    const toolCallCounts = new Map<string, number>();
    const filesChangedSet = new Set<string>();
    const recordToolExecution = (tool: string, input: Record<string, unknown>): void => {
      toolCallCounts.set(tool, (toolCallCounts.get(tool) ?? 0) + 1);
      if (FILE_TOOLS.has(tool) && typeof input.path === 'string') filesChangedSet.add(input.path);
    };
    
    const canonicalize = (obj: any): any => {
      if (Array.isArray(obj)) return obj.map(canonicalize);
      if (obj && typeof obj === 'object') {
        return Object.keys(obj).sort().reduce((result: any, key) => {
          result[key] = canonicalize(obj[key]);
          return result;
        }, {});
      }
      return obj;
    };

    /** Returns an error message once the same tool call repeats `toolRepeatLimit` times in a row, else null. */
    const checkCircuitBreaker = (tool: string, input: Record<string, unknown>): string | null => {
      const signature = `${tool}:${JSON.stringify(canonicalize(input))}`;
      repeatedToolCount = signature === lastToolSignature ? repeatedToolCount + 1 : 1;
      lastToolSignature = signature;
      if (repeatedToolCount < this.toolRepeatLimit) return null;
      return `circuit breaker: model called ${tool} with identical input ${repeatedToolCount} times in a row without making progress`;
    };

    // ---- context compaction: keep `messages` under the model's context window ----
    const estimateTokens = (msgs: ChatMessage[]): number =>
      Math.ceil(msgs.reduce((sum, m) => sum + m.content.length, 0) / 4);
    const compactIfNeeded = (): string | null => {
      const contextTokens = request.contextTokens;
      const KEEP_RECENT = 6;
      const KEEP_HEAD = 2; // system prompt + initial task message
      if (!contextTokens || messages.length <= KEEP_HEAD + KEEP_RECENT) return null;
      const budget = Math.floor(contextTokens * this.contextCompactionRatio) - this.maxTokensPerTurn;
      const before = estimateTokens(messages);
      if (before <= budget) return null;
      const head = messages.slice(0, KEEP_HEAD);
      const tail = messages.slice(-KEEP_RECENT);
      const collapsedCount = messages.length - head.length - tail.length;
      if (collapsedCount <= 0) return null;
      const summary: ChatMessage = {
        role: 'user',
        content:
          `[context compacted: ${collapsedCount} earlier turn(s) summarized to stay under the context window]\n` +
          `Tool calls so far: ${[...toolCallCounts.entries()].map(([n, c]) => `${n}×${c}`).join(', ') || 'none'}\n` +
          `Files changed: ${[...filesChangedSet].join(', ') || 'none'}\n` +
          `Checks run: ${checkOutputs.map((c) => `${c.name}=${c.ok ? 'pass' : 'fail'}`).join(', ') || 'none'}\n` +
          (plan ? `Plan: ${plan}\n` : '') +
          'Continue the task from exactly where you left off.',
      };
      messages.length = 0;
      messages.push(...head, summary, ...tail);
      const after = estimateTokens(messages);
      const reduction = before > 0 ? Math.round((1 - after / before) * 100) : 0;
      return `context compacted: ${collapsedCount} turn(s) -> 1 summary (~${before}->~${after} tokens, ${reduction}% smaller)`;
    };

    const modelTurn = async (): Promise<{
      content: string;
      toolCall?: { name: string; input: Record<string, unknown> };
      timedOut: boolean;
    }> => {
      let content = '';
      let toolCall: { name: string; input: Record<string, unknown> } | undefined;
      let error: string | undefined;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        runtime.cancelCurrentTurn?.();
      }, this.modelTurnTimeoutMs);
      try {
        for await (const event of runtime.generate({
          modelId: request.modelId,
          messages,
          maxTokens: this.maxTokensPerTurn,
          temperature: this.temperature,
          tools: runtime.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema as Record<string, unknown>,
          })),
        })) {
          if (event.type === 'token' && event.content) {
            content += event.content;
            if (!timedOut && content.length > this.maxProseBeforeActionChars && !ACTION_START_RE.test(content)) {
              timedOut = true;
              runtime.cancelCurrentTurn?.();
            }
          }
          if (event.type === 'tool_call' && event.toolName) {
            let input: Record<string, unknown> = {};
            if (event.toolInput && typeof event.toolInput === 'object' && !Array.isArray(event.toolInput)) {
              input = event.toolInput as Record<string, unknown>;
            } else if (typeof event.toolInput === 'string') {
              input = tryParseObject(event.toolInput) ?? { command: event.toolInput };
            }
            toolCall = { name: event.toolName, input };
          }
          if (event.type === 'error' && event.error) error = event.error;
        }
      } finally {
        clearTimeout(timer);
      }
      // A cancel-induced 'completed' with partial content is not an error —
      // only surface `error` when the turn didn't just hit its own timeout.
      if (error && !timedOut) throw new Error(error);
      return { content, toolCall, timedOut };
    };

    const toolNames = new Set(runtime.tools.map((t) => t.name));
    const readAction = (raw: string): ParsedAction | null => normalizeAction(parseAction(raw, toolNames), toolNames);
    const correctionMessage = (timedOut: boolean): string =>
      timedOut
        ? 'Your previous response took too long and was cut off before it produced a JSON action. Stop reasoning in prose — respond immediately with exactly one JSON object.'
        : 'Invalid response. Respond with exactly one JSON object as specified.';

    const pushAssistant = (content: string): void => {
      messages.push({ role: 'assistant', content });
    };

    // Compact, deterministic execution state — turn budget, files actually touched, what
    // the last action was — appended to every "continue" message so the model can track
    // progress from one line instead of re-deriving it from the full conversation history.
    const stateLine = (lastAction?: string): string =>
      `[state] turn ${turnsUsed}/${maxTurns} | files changed: ${[...filesChangedSet].join(', ') || 'none'}` +
      (lastAction ? ` | last action: ${lastAction}` : '');

    // Chat templates treat a trailing assistant message as finished, so every
    // model turn must be preceded by a user message or the model replies with nothing.
    const pushContinue = (content: string): void => {
      messages.push({ role: 'user', content: `${content} ${stateLine()}\nRespond with exactly one JSON object.` });
    };

    const pushToolResult = (tool: string, result: { ok: boolean; output: string; error?: string }): void => {
      const body = result.ok ? result.output : `ERROR: ${[result.error, result.output].filter(Boolean).join('\n')}`;
      messages.push({
        role: 'user',
        content: `[tool result for ${tool} (ok=${result.ok})]\n${body.slice(0, 12000)}\n${stateLine(`${tool}(${result.ok ? 'ok' : 'failed'})`)}\nContinue. Respond with exactly one JSON object.`,
      });
    };

    let actionAttempts = 0;
    let validActions = 0;
    let validationErrors = 0;
    let malformedActions = 0;
    let consecutiveValidationFailures = 0;
    let lastValidationKey = '';

    const currentMetrics = (): ModelProtocolMetrics => ({
      actionAttempts,
      validActions,
      validationErrors,
      malformedActions,
      adherenceRate: actionAttempts > 0 ? Number((validActions / actionAttempts).toFixed(3)) : 1.0,
    });

    const validateAction = (
      tool: string,
      input: Record<string, unknown>,
    ): { ok: true } | { ok: false; reason: string; toolMessage: string; attempts: number } => {
      const missingFields = missingRequiredFields(tool, input);
      if (missingFields.length > 0) {
        const failureKey = `${tool}:${missingFields.join(',')}`;
        consecutiveValidationFailures = (lastValidationKey === failureKey ? consecutiveValidationFailures : 0) + 1;
        lastValidationKey = failureKey;
        return {
          ok: false,
          reason: `missing ${missingFields.join(', ')}`,
          toolMessage: `is missing required argument(s): ${missingFields.join(', ')}`,
          attempts: consecutiveValidationFailures,
        };
      }

      const semantic = validateToolActionSemantics(tool, input);
      if (!semantic.ok) {
        const reason = semantic.reason ?? 'invalid arguments';
        const failureKey = `${tool}:${reason}`;
        consecutiveValidationFailures = (lastValidationKey === failureKey ? consecutiveValidationFailures : 0) + 1;
        lastValidationKey = failureKey;
        return {
          ok: false,
          reason,
          toolMessage: reason,
          attempts: consecutiveValidationFailures,
        };
      }

      consecutiveValidationFailures = 0;
      lastValidationKey = '';
      return { ok: true };
    };

    // ==================== PLAN ====================
    yield { kind: 'phase', phase: 'plan' as AgentPhase };
    let planEstablished = false;
    let planExplorationCount = 0;
    for (let i = 0; i < 3 && !plan; i++) {
      if (request.isCancelled?.()) return;
      const compactionNote = compactIfNeeded();
      if (compactionNote) yield { kind: 'message', content: compactionNote };
      const { content: raw, toolCall, timedOut } = await modelTurn();
      if (request.isCancelled?.()) return;
      turnsUsed += 1;
      actionAttempts += 1;
      const action = toolCall
        ? normalizeAction({ action: 'tool', tool: toolCall.name, input: toolCall.input }, toolNames)
        : readAction(raw);

      if (!action) {
        correctionCount += 1;
        malformedActions += 1;
        if (correctionCount >= 3) {
          yield { kind: 'error', error: 'model repeatedly failed to produce valid JSON actions', errorKind: 'protocol', raw, protocolMetrics: currentMetrics() };
          return;
        }
        yield { kind: 'message', content: 'INVALID_JSON_ACTION: model response did not parse as a JSON action', raw };
        messages.push({ role: 'user', content: correctionMessage(timedOut) });
        continue;
      }
      pushAssistant(raw);
      if (action.action === 'plan' && action.content) {
        validActions += 1;
        plan = action.content;
        planEstablished = true;
        yield { kind: 'message', content: `Plan: ${plan}`, raw };
        pushContinue('Plan accepted. Execute it now, one tool call per turn.');
        break;
      }
      if (action.action === 'done' || action.action === 'answer') {
        validActions += 1;
        modelSummary = action.summary ?? action.content;
        break;
      }
      if (action.action === 'tool' && action.tool) {
        const val = validateAction(action.tool, action.input ?? {});
        if (val.ok === false) {
          validationErrors += 1;
          if (val.attempts >= 3) {
            yield { kind: 'error', error: `protocol recovery failed: '${action.tool}' repeatedly failed validation (${val.reason})`, errorKind: 'protocol', raw, protocolMetrics: currentMetrics() };
            return;
          }
          yield { kind: 'message', content: `ACTION_VALIDATION_FAILED: '${action.tool}' ${val.reason}`, tool: action.tool, raw };
          pushToolResult(action.tool, validationFailureMessage(action.tool, val.toolMessage, val.attempts));
          continue;
        }

        validActions += 1;
        recordToolExecution(action.tool, action.input ?? {});
        const result = await runtime.executeTool(action.tool, action.input ?? {});
        yield { kind: 'tool_call', tool: action.tool, toolInput: action.input, toolResult: result, raw };
        if (CHECK_TOOLS.has(action.tool)) {
          checkOutputs.push({ name: action.tool, ok: result.ok, output: result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n') });
        }
        if (FILE_TOOLS.has(action.tool) && typeof (action.input as { path?: unknown })?.path === 'string') {
          yield { kind: 'message', content: `files-changed: ${(action.input as { path: string }).path}` };
        }
        if (result.ok) {
          planExplorationCount += 1;
        }
        pushToolResult(action.tool, result);
        continue;
      }
      messages.push({ role: 'user', content: 'Respond with exactly one JSON object as specified.' });
    }

    // Evidence check: only advance to implement if a plan was established or exploration occurred.
    if (!planEstablished && planExplorationCount === 0 && !modelSummary) {
      if (turnsUsed >= maxTurns || malformedActions + validationErrors >= 3) {
        yield {
          kind: 'error',
          error: 'model failed to produce a valid plan or inspection action during planning phase',
          errorKind: 'protocol',
          protocolMetrics: currentMetrics(),
        };
        return;
      }
    }

    // ==================== WORK (inspect → implement → test → debug → repair) ====================
    yield { kind: 'phase', phase: 'implement' as AgentPhase };
    while (turnsUsed < maxTurns && !modelSummary) {
      if (request.isCancelled?.()) return;
      const steering = request.getSteeringInstruction?.();
      if (steering) {
        yield { kind: 'message', content: `[steered] ${steering}` };
        pushContinue(`User follow-up instruction: ${steering}`);
      }
      const compactionNote = compactIfNeeded();
      if (compactionNote) yield { kind: 'message', content: compactionNote };
      const { content: raw, toolCall, timedOut } = await modelTurn();
      if (request.isCancelled?.()) return;
      turnsUsed += 1;
      actionAttempts += 1;
      const action = toolCall
        ? normalizeAction({ action: 'tool', tool: toolCall.name, input: toolCall.input }, toolNames)
        : readAction(raw);

      if (!action) {
        correctionCount += 1;
        malformedActions += 1;
        if (correctionCount >= 3) {
          yield { kind: 'error', error: 'model repeatedly failed to produce valid JSON actions', errorKind: 'protocol', raw, protocolMetrics: currentMetrics() };
          return;
        }
        yield { kind: 'message', content: 'INVALID_JSON_ACTION: model response did not parse as a JSON action', raw };
        messages.push({ role: 'user', content: correctionMessage(timedOut) });
        continue;
      }

      pushAssistant(raw);

      if (action.action === 'done') {
        validActions += 1;
        modelSummary = action.summary ?? 'completed';
        break;
      }
      if (action.action === 'answer') {
        validActions += 1;
        modelSummary = action.content ?? 'completed';
        break;
      }
      if (action.action === 'plan') {
        validActions += 1;
        plan = action.content ?? plan;
        pushContinue('Plan noted. Execute it now, one tool call per turn.');
        continue;
      }
      if (action.action === 'tool' && action.tool) {
        const breakerError = checkCircuitBreaker(action.tool, action.input ?? {});
        if (breakerError) {
          validationErrors += 1;
          yield { kind: 'message', content: `ACTION_BLOCKED_DUPLICATE: '${action.tool}' repeated ${this.toolRepeatLimit} times`, tool: action.tool, raw };
          pushToolResult(action.tool, {
            ok: false,
            output: `ACTION_BLOCKED_DUPLICATE: You have attempted this exact action ${this.toolRepeatLimit} times. You must use a different tool or different arguments.`
          });
          continue;
        }

        const val = validateAction(action.tool, action.input ?? {});
        if (val.ok === false) {
          validationErrors += 1;
          if (val.attempts >= 3) {
            yield { kind: 'error', error: `protocol recovery failed: '${action.tool}' repeatedly failed validation (${val.reason})`, errorKind: 'protocol', raw, protocolMetrics: currentMetrics() };
            return;
          }
          yield { kind: 'message', content: `ACTION_VALIDATION_FAILED: '${action.tool}' ${val.reason}`, tool: action.tool, raw };
          pushToolResult(action.tool, validationFailureMessage(action.tool, val.toolMessage, val.attempts));
          continue;
        }

        validActions += 1;
        recordToolExecution(action.tool, action.input ?? {});
        const result = await runtime.executeTool(action.tool, action.input ?? {});
        yield { kind: 'tool_call', tool: action.tool, toolInput: action.input, toolResult: result, raw };
        if (CHECK_TOOLS.has(action.tool)) {
          checkOutputs.push({ name: action.tool, ok: result.ok, output: result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n') });
        }
        if (FILE_TOOLS.has(action.tool) && typeof (action.input as { path?: unknown })?.path === 'string') {
          yield { kind: 'message', content: `files-changed: ${(action.input as { path: string }).path}` };
        }
        pushToolResult(action.tool, result);
        continue;
      }

      messages.push({ role: 'user', content: 'Respond with exactly one JSON object as specified.' });
    }

    // ==================== VERIFY (deterministic, host-side) ====================
    if (request.isCancelled?.()) return;
    yield { kind: 'phase', phase: 'verify' as AgentPhase };

    const failures: string[] = [];

    const mutationRequired = request.mutationRequired ?? true;
    if (mutationRequired && filesChangedSet.size === 0) {
      failures.push('Agent declared completion but produced no code modifications.');
    }

    if (request.expectedArtifacts && request.expectedArtifacts.length > 0) {
      for (const artifact of request.expectedArtifacts) {
        const fullPath = path.resolve(request.projectRoot, artifact);
        if (!existsSync(fullPath)) {
          failures.push(`Expected artifact '${artifact}' was not created.`);
        }
      }
    }

    for (const check of ['test', 'lint', 'typecheck']) {
      if (request.isCancelled?.()) return;
      const result = await runtime.executeTool(check, {});
      const output = result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n');
      if (output && /missing script|no such file|not found/i.test(output) && !result.ok) {
        // project does not define this check — not applicable, not a failure
        continue;
      }
      if (!result.ok) {
        failures.push(`${check}: ${output.slice(0, 4000)}`);
      }
    }

    if (failures.length === 0) {
      yield { kind: 'phase', phase: 'complete' as AgentPhase };
      yield {
        kind: 'done',
        content: modelSummary ?? 'Task completed. Verification checks passed.',
        protocolMetrics: currentMetrics(),
      };
      return;
    }

    yield {
      kind: 'error',
      error: `verification failed:\n${failures.join('\n---\n')}`,
      errorKind: 'verification',
      protocolMetrics: currentMetrics(),
    };
  }
}

export function createCodingAgent(options: CodingAgentOptions = {}): CodingAgent {
  return new CodingAgent(options);
}
