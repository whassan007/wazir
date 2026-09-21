import type {
  AgentAdapter,
  AgentDescriptor,
  AgentPhase,
  AgentRunRequest,
  AgentRuntime,
  AgentTurn,
  ChatMessage,
} from '@wazir/core';

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
const ACTION_START_RE = /\{\s*"action"\s*:/;

export interface ParsedAction {
  action: string;
  content?: string;
  tool?: string;
  input?: Record<string, unknown>;
  summary?: string;
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
 * Slices out the first balanced `{...}` object starting at `text`'s first
 * `{`. Local models sometimes ignore the "exactly one JSON object" rule and
 * emit several objects back to back (e.g. one `read` per line); scanning to
 * the *last* `}` in the text would swallow all of them into one invalid
 * blob, so this stops at the first object's matching close brace instead.
 * If the object never balances (e.g. an unterminated array), it falls back
 * to everything from `start` onward so repairBrackets can still attempt it.
 */
function extractFirstObject(text: string): string | null {
  const start = text.indexOf('{');
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

export function parseAction(text: string): ParsedAction | null {
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const candidate = extractFirstObject(unfenced);
  if (!candidate) return null;

  const obj = tryParseObject(candidate);
  if (!obj || typeof obj.action !== 'string') return null;

  if (Array.isArray(obj.content)) {
    obj.content = obj.content.map((item) => String(item).trim()).filter(Boolean).join('\n');
  }
  if (Array.isArray(obj.summary)) {
    obj.summary = obj.summary.map((item) => String(item).trim()).filter(Boolean).join('\n');
  }
  return obj as unknown as ParsedAction;
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
  const altContainer = record.parameters ?? record.arguments ?? record.args;
  if (altContainer && typeof altContainer === 'object' && !Array.isArray(altContainer)) {
    return altContainer as Record<string, unknown>;
  }
  const { action: _action, tool: _tool, name: _name, content: _content, summary: _summary, ...rest } = record;
  return Object.keys(rest).length > 0 ? (rest as Record<string, unknown>) : undefined;
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
    if (action.tool === 'shell' && action.input) {
      action.input = coerceShellCommand(action.input);
    }
    return action;
  }
  if (toolNames.has(action.action)) {
    const { action: tool, input, ...rest } = action as ParsedAction & Record<string, unknown>;
    const normalizedInput = (input ?? (rest as Record<string, unknown>)) as Record<string, unknown>;
    return { action: 'tool', tool, input: tool === 'shell' ? coerceShellCommand(normalizedInput) : normalizedInput };
  }
  return action;
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
    /** Returns an error message once the same tool call repeats `toolRepeatLimit` times in a row, else null. */
    const checkCircuitBreaker = (tool: string, input: Record<string, unknown>): string | null => {
      const signature = `${tool}:${JSON.stringify(input)}`;
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

    const modelTurn = async (): Promise<{ content: string; timedOut: boolean }> => {
      let content = '';
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
        })) {
          if (event.type === 'token' && event.content) {
            content += event.content;
            if (!timedOut && content.length > this.maxProseBeforeActionChars && !ACTION_START_RE.test(content)) {
              timedOut = true;
              runtime.cancelCurrentTurn?.();
            }
          }
          if (event.type === 'error' && event.error) error = event.error;
        }
      } finally {
        clearTimeout(timer);
      }
      // A cancel-induced 'completed' with partial content is not an error —
      // only surface `error` when the turn didn't just hit its own timeout.
      if (error && !timedOut) throw new Error(error);
      return { content, timedOut };
    };

    const toolNames = new Set(runtime.tools.map((t) => t.name));
    const readAction = (raw: string): ParsedAction | null => normalizeAction(parseAction(raw), toolNames);
    const correctionMessage = (timedOut: boolean): string =>
      timedOut
        ? 'Your previous response took too long and was cut off before it produced a JSON action. Stop reasoning in prose — respond immediately with exactly one JSON object.'
        : 'Invalid response. Respond with exactly one JSON object as specified.';

    const pushAssistant = (content: string): void => {
      messages.push({ role: 'assistant', content });
    };

    // Chat templates treat a trailing assistant message as finished, so every
    // model turn must be preceded by a user message or the model replies with nothing.
    const pushContinue = (content: string): void => {
      messages.push({ role: 'user', content: `${content} Respond with exactly one JSON object.` });
    };

    const pushToolResult = (tool: string, result: { ok: boolean; output: string; error?: string }): void => {
      const body = result.ok ? result.output : `ERROR: ${[result.error, result.output].filter(Boolean).join('\n')}`;
      messages.push({
        role: 'user',
        content: `[tool result for ${tool} (ok=${result.ok})]\n${body.slice(0, 12000)}\nContinue. Respond with exactly one JSON object.`,
      });
    };

    // ==================== PLAN ====================
    yield { kind: 'phase', phase: 'plan' as AgentPhase };
    for (let i = 0; i < 3 && !plan; i++) {
      if (request.isCancelled?.()) break;
      const compactionNote = compactIfNeeded();
      if (compactionNote) yield { kind: 'message', content: compactionNote };
      const { content: raw, timedOut } = await modelTurn();
      // A cancel (manual or timeout) that lands during the model turn must not let
      // this turn's action run anyway — the check at the top of the loop already passed.
      if (request.isCancelled?.()) break;
      turnsUsed += 1;
      const action = readAction(raw);
      if (!action) {
        correctionCount += 1;
        messages.push({ role: 'user', content: correctionMessage(timedOut) });
        continue;
      }
      pushAssistant(raw);
      if (action.action === 'plan' && action.content) {
        plan = action.content;
        yield { kind: 'message', content: `Plan: ${plan}` };
        pushContinue('Plan accepted. Execute it now, one tool call per turn.');
        break;
      }
      if (action.action === 'done' || action.action === 'answer') {
        modelSummary = action.summary ?? action.content;
        break;
      }
      if (action.action === 'tool' && action.tool) {
        recordToolExecution(action.tool, action.input ?? {});
        const result = await runtime.executeTool(action.tool, action.input ?? {});
        yield { kind: 'tool_call', tool: action.tool, toolInput: action.input, toolResult: result };
        if (CHECK_TOOLS.has(action.tool)) {
          checkOutputs.push({ name: action.tool, ok: result.ok, output: result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n') });
        }
        pushToolResult(action.tool, result);
        continue;
      }
      messages.push({ role: 'user', content: 'Respond with exactly one JSON object as specified.' });
    }

    // ==================== WORK (inspect → implement → test → debug → repair) ====================
    yield { kind: 'phase', phase: 'implement' as AgentPhase };
    while (turnsUsed < maxTurns && !modelSummary) {
      if (request.isCancelled?.()) break;
      const steering = request.getSteeringInstruction?.();
      if (steering) {
        yield { kind: 'message', content: `[steered] ${steering}` };
        pushContinue(`User follow-up instruction: ${steering}`);
      }
      const compactionNote = compactIfNeeded();
      if (compactionNote) yield { kind: 'message', content: compactionNote };
      const { content: raw, timedOut } = await modelTurn();
      // A cancel (manual or timeout) that lands during the model turn must not let
      // this turn's action run anyway — the check at the top of the loop already passed.
      if (request.isCancelled?.()) break;
      turnsUsed += 1;
      const action = readAction(raw);

      if (!action) {
        correctionCount += 1;
        if (correctionCount >= 3) {
          yield { kind: 'error', error: 'model repeatedly failed to produce valid JSON actions' };
          break;
        }
        messages.push({ role: 'user', content: correctionMessage(timedOut) });
        continue;
      }

      pushAssistant(raw);

      if (action.action === 'done') {
        modelSummary = action.summary ?? 'completed';
        break;
      }
      if (action.action === 'answer') {
        modelSummary = action.content ?? 'completed';
        break;
      }
      if (action.action === 'plan') {
        plan = action.content ?? plan;
        pushContinue('Plan noted. Execute it now, one tool call per turn.');
        continue;
      }
      if (action.action === 'tool' && action.tool) {
        const breakerError = checkCircuitBreaker(action.tool, action.input ?? {});
        if (breakerError) {
          yield { kind: 'error', error: breakerError };
          break;
        }
        recordToolExecution(action.tool, action.input ?? {});
        const result = await runtime.executeTool(action.tool, action.input ?? {});
        yield { kind: 'tool_call', tool: action.tool, toolInput: action.input, toolResult: result };
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
    for (let cycle = 0; cycle <= this.maxRepairCycles; cycle++) {
      if (request.isCancelled?.()) break;
      yield { kind: 'phase', phase: (cycle === 0 ? 'verify' : 'repair') as AgentPhase };

      const failures: string[] = [];
      for (const check of ['test', 'lint', 'typecheck']) {
        if (request.isCancelled?.()) break;
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
        };
        return;
      }

      if (cycle === this.maxRepairCycles) {
        yield {
          kind: 'error',
          error: `verification failed after ${this.maxRepairCycles} repair cycle(s):\n${failures.join('\n---\n')}`,
        };
        return;
      }

      yield { kind: 'message', content: `Verification failed:\n${failures.join('\n---\n')}` };
      messages.push({
        role: 'user',
        content:
          `Verification of the current state FAILED:\n${failures.join('\n---\n')}\n\n` +
          'Debug the failures, repair the code with edit/write tools, re-run the checks, ' +
          'and when everything passes respond with {"action":"done","summary":"..."}.',
      });

      // bounded repair loop
      const repairLimit = Math.min(8, Math.max(4, maxTurns - turnsUsed));
      for (let i = 0; i < repairLimit; i++) {
        if (request.isCancelled?.()) break;
        const steering = request.getSteeringInstruction?.();
        if (steering) {
          yield { kind: 'message', content: `[steered] ${steering}` };
          pushContinue(`User follow-up instruction: ${steering}`);
        }
        const compactionNote = compactIfNeeded();
        if (compactionNote) yield { kind: 'message', content: compactionNote };
        const { content: raw, timedOut } = await modelTurn();
        // A cancel (manual or timeout) that lands during the model turn must not let
        // this turn's action run anyway — the check at the top of the loop already passed.
        if (request.isCancelled?.()) break;
        turnsUsed += 1;
        const action = readAction(raw);
        if (!action) {
          messages.push({ role: 'user', content: correctionMessage(timedOut) });
          continue;
        }
        pushAssistant(raw);
        if (action.action === 'done' || action.action === 'answer') {
          modelSummary = action.summary ?? action.content ?? modelSummary;
          break;
        }
        if (action.action === 'tool' && action.tool) {
          const breakerError = checkCircuitBreaker(action.tool, action.input ?? {});
          if (breakerError) {
            yield { kind: 'error', error: breakerError };
            break;
          }
          recordToolExecution(action.tool, action.input ?? {});
          const result = await runtime.executeTool(action.tool, action.input ?? {});
          yield { kind: 'tool_call', tool: action.tool, toolInput: action.input, toolResult: result };
          pushToolResult(action.tool, result);
          continue;
        }
        messages.push({ role: 'user', content: 'Respond with exactly one JSON object as specified.' });
      }
    }

    if (!modelSummary) {
      yield {
        kind: 'error',
        error: 'agent stopped without completing the task (turn budget or cancellation)',
      };
    }
  }
}

export function createCodingAgent(options: CodingAgentOptions = {}): CodingAgent {
  return new CodingAgent(options);
}
