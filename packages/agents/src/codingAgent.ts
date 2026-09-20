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
  /** Extra instructions appended to the system prompt. */
  systemPromptExtra?: string;
}

const CHECK_TOOLS = new Set(['test', 'lint', 'typecheck', 'build']);
const FILE_TOOLS = new Set(['write', 'edit']);

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

/** Accepts `{"action":"read",...}` as shorthand for `{"action":"tool","tool":"read",...}`. */
export function normalizeAction(action: ParsedAction | null, toolNames: Set<string>): ParsedAction | null {
  if (!action) return null;
  if (action.action === 'tool') {
    const alias = (action as unknown as { name?: unknown }).name;
    if (!action.tool && typeof alias === 'string') {
      action.tool = alias;
    }
    return action;
  }
  if (toolNames.has(action.action)) {
    const { action: tool, input, ...rest } = action as ParsedAction & Record<string, unknown>;
    return { action: 'tool', tool, input: input ?? (rest as Record<string, unknown>) };
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
  private readonly systemPromptExtra?: string;

  constructor(options: CodingAgentOptions = {}) {
    this.maxTurns = options.maxTurns ?? 30;
    this.maxRepairCycles = options.maxRepairCycles ?? 2;
    this.maxTokensPerTurn = options.maxTokensPerTurn ?? 4096;
    this.temperature = options.temperature ?? 0.2;
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

    const modelTurn = async (): Promise<string> => {
      let content = '';
      let error: string | undefined;
      for await (const event of runtime.generate({
        modelId: request.modelId,
        messages,
        maxTokens: this.maxTokensPerTurn,
        temperature: this.temperature,
      })) {
        if (event.type === 'token' && event.content) content += event.content;
        if (event.type === 'error' && event.error) error = event.error;
      }
      if (error) throw new Error(error);
      return content;
    };

    const toolNames = new Set(runtime.tools.map((t) => t.name));
    const readAction = (raw: string): ParsedAction | null => normalizeAction(parseAction(raw), toolNames);

    const pushAssistant = (content: string): void => {
      messages.push({ role: 'assistant', content });
    };

    // Chat templates treat a trailing assistant message as finished, so every
    // model turn must be preceded by a user message or the model replies with nothing.
    const pushContinue = (content: string): void => {
      messages.push({ role: 'user', content: `${content} Respond with exactly one JSON object.` });
    };

    const pushToolResult = (tool: string, result: { ok: boolean; output: string; error?: string }): void => {
      const body = result.ok ? result.output : `ERROR: ${result.error ?? result.output}`;
      messages.push({
        role: 'user',
        content: `[tool result for ${tool} (ok=${result.ok})]\n${body.slice(0, 12000)}\nContinue. Respond with exactly one JSON object.`,
      });
    };

    // ==================== PLAN ====================
    yield { kind: 'phase', phase: 'plan' as AgentPhase };
    for (let i = 0; i < 3 && !plan; i++) {
      if (request.isCancelled?.()) break;
      const raw = await modelTurn();
      // A cancel (manual or timeout) that lands during the model turn must not let
      // this turn's action run anyway — the check at the top of the loop already passed.
      if (request.isCancelled?.()) break;
      turnsUsed += 1;
      const action = readAction(raw);
      if (!action) {
        correctionCount += 1;
        messages.push({ role: 'user', content: 'Invalid response. Respond with exactly one JSON object as specified.' });
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
        const result = await runtime.executeTool(action.tool, action.input ?? {});
        yield { kind: 'tool_call', tool: action.tool, toolInput: action.input, toolResult: result };
        if (CHECK_TOOLS.has(action.tool)) {
          checkOutputs.push({ name: action.tool, ok: result.ok, output: result.ok ? result.output : result.error ?? result.output });
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
      const raw = await modelTurn();
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
        messages.push({ role: 'user', content: 'Invalid response. Respond with exactly one JSON object as specified.' });
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
        const result = await runtime.executeTool(action.tool, action.input ?? {});
        yield { kind: 'tool_call', tool: action.tool, toolInput: action.input, toolResult: result };
        if (CHECK_TOOLS.has(action.tool)) {
          checkOutputs.push({ name: action.tool, ok: result.ok, output: result.ok ? result.output : result.error ?? result.output });
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
        const output = result.ok ? result.output : result.error ?? result.output;
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
        const raw = await modelTurn();
        // A cancel (manual or timeout) that lands during the model turn must not let
        // this turn's action run anyway — the check at the top of the loop already passed.
        if (request.isCancelled?.()) break;
        turnsUsed += 1;
        const action = readAction(raw);
        if (!action) {
          messages.push({ role: 'user', content: 'Invalid response. Respond with exactly one JSON object as specified.' });
          continue;
        }
        pushAssistant(raw);
        if (action.action === 'done' || action.action === 'answer') {
          modelSummary = action.summary ?? action.content ?? modelSummary;
          break;
        }
        if (action.action === 'tool' && action.tool) {
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
