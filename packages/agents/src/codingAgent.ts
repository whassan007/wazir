import type {
  AgentAdapter,
  AgentDescriptor,
  AgentPhase,
  AgentRunRequest,
  AgentRuntime,
  AgentTurn,
  ChatMessage,
} from '@rook/core';

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

interface ParsedAction {
  action: string;
  content?: string;
  tool?: string;
  input?: Record<string, unknown>;
  summary?: string;
}

function parseAction(text: string): ParsedAction | null {
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
      if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
          if (obj && typeof obj.action === 'string') {
            return obj as unknown as ParsedAction;
          }
        } catch {
          return null;
        }
        return null;
      }
    }
  }
  return null;
}

export function buildSystemPrompt(projectRoot: string, tools: AgentRuntime['tools'], extra?: string): string {
  const toolLines = tools
    .map((t) => `- ${t.name}: ${t.description} input: ${JSON.stringify(t.inputSchema).slice(0, 240)}`)
    .join('\n');
  return [
    "You are Rook's native coding agent, executing inside a sandboxed project.",
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
 * Native Rook coding agent.
 *
 * Loop: PLAN → INSPECT → IMPLEMENT → TEST → DEBUG → REPAIR → VERIFY → COMPLETE
 *
 * - The model proposes one JSON action per turn (tool call, plan, or done).
 * - Every tool call is executed through the policy-gated runtime — the model
 *   can never bypass policy.
 * - Verification is deterministic: Rook itself re-runs the checks after the
 *   model reports done, and drives bounded repair cycles on failure.
 */
export class CodingAgent implements AgentAdapter {
  readonly descriptor: AgentDescriptor = {
    name: 'rook-coding',
    version: '0.1.0',
    description: 'Native Rook coding agent: plan, inspect, implement, test, repair, verify.',
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

    const pushAssistant = (content: string): void => {
      messages.push({ role: 'assistant', content });
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
      turnsUsed += 1;
      const action = parseAction(raw);
      if (!action) {
        correctionCount += 1;
        messages.push({ role: 'user', content: 'Invalid response. Respond with exactly one JSON object as specified.' });
        continue;
      }
      pushAssistant(raw);
      if (action.action === 'plan' && action.content) {
        plan = action.content;
        yield { kind: 'message', content: `Plan: ${plan}` };
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
    while (turnsUsed < this.maxTurns && !modelSummary) {
      if (request.isCancelled?.()) break;
      const raw = await modelTurn();
      turnsUsed += 1;
      const action = parseAction(raw);

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
      const repairLimit = Math.min(8, Math.max(4, this.maxTurns - turnsUsed));
      for (let i = 0; i < repairLimit; i++) {
        if (request.isCancelled?.()) break;
        const raw = await modelTurn();
        turnsUsed += 1;
        const action = parseAction(raw);
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
