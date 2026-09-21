/**
 * Model Protocol Adapter
 *
 * Sits between model/runtime output and canonical Wazir ToolActions.
 *
 * Different models emit tool calls in different native wire protocols:
 * - Gemma:    `<|tool_call>call:tool{tool:"shell","input":{"command":"..."}}` or
 *             `<|tool_call>call:shell{command:"..."}`
 * - Qwen:     `<tool_call>\n{"name":"shell","arguments":{"command":"..."}}\n</tool_call>`
 * - Anthropic: `<tool_use>\n<name>shell</name>\n<parameters>\n{"command":"..."}\n</parameters>\n</tool_use>`
 * - OpenAI:   `{"name":"shell","arguments":{"command":"..."}}` or `{"tool_calls":[...]}`
 * - Wazir:    `{"action":"tool","tool":"shell","input":{"command":"..."}}`
 *
 * This adapter normalizes all native protocols into a canonical Wazir action.
 */

export interface CanonicalAction {
  action: 'tool' | 'plan' | 'done' | 'answer' | string;
  tool?: string;
  input?: Record<string, unknown>;
  content?: string;
  summary?: string;
  protocol?: 'wazir' | 'gemma' | 'qwen' | 'anthropic' | 'openai';
}

/** Matches any action beginning (JSON or model-specific tool tags). */
export const ACTION_START_PATTERN = /(?:\{\s*"(?:action|tool|tool_calls|tools|name|type|function)"\s*:|<\|tool_call>|<tool_call>|<tool_use>)/;

const CONTROL_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * Re-balances brackets outside string literals and escapes unescaped control chars.
 */
export function repairBrackets(text: string): string {
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
      out += CONTROL_ESCAPES[char] ?? char;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
      out += char;
      continue;
    }
    if (char === '}' || char === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === char) {
        stack.pop();
        out += char;
      }
      continue;
    }
    out += char;
  }
  if (inString) out += '"';
  while (stack.length > 0) out += stack.pop()!;
  return out;
}

/**
 * Extracts the first balanced JSON object {...} from text.
 */
export function extractFirstObject(text: string): string | null {
  const actionMatch = text.search(ACTION_START_PATTERN);
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

/**
 * Robust JSON parse attempt with bracket repair, unquoted key recovery,
 * and trailing comma removal.
 */
export function tryParseObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Continue to repair
  }

  // Repair brackets and control escapes
  const repaired = repairBrackets(trimmed);
  try {
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Continue to relaxed JSON fixes
  }

  // Handle unquoted keys: { command: "..." } -> { "command": "..." }
  const quoteKeys = repaired
    .replace(/([{,]\s*)([a-zA-Z0-9_$-]+)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(quoteKeys);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Gemma Wire Protocol Adapter
 *
 * Handles:
 * - `<|tool_call>call:tool{tool:"shell","input":{"command":"mkdir -p test"}}...`
 * - `<|tool_call>call:shell{command:"mkdir -p test"}...`
 * - `<|tool_call>{"name":"shell","arguments":{"command":"mkdir -p test"}}...`
 */
export function parseGemmaProtocol(text: string, toolNames: Set<string>): CanonicalAction | null {
  if (!text.includes('<|tool_call>')) return null;

  const markerIdx = text.indexOf('<|tool_call>');
  const snippet = text.slice(markerIdx + '<|tool_call>'.length).trim();

  // Pattern 1: call:targetName{...}
  const callMatch = snippet.match(/^call:([a-zA-Z0-9_.-]+)\s*(\{[\s\S]*)/);
  if (callMatch) {
    const target = callMatch[1];
    const rawObj = extractFirstObject(callMatch[2]);
    if (rawObj) {
      const parsed = tryParseObject(rawObj);
      if (parsed) {
        if (target === 'tool') {
          const tool = (parsed.tool ?? parsed.name ?? parsed.action) as string | undefined;
          const input = (parsed.input ?? parsed.arguments ?? parsed.parameters ?? parsed) as Record<string, unknown>;
          if (tool) {
            const cleanInput = (input === parsed) ? { ...parsed } : input;
            delete (cleanInput as Record<string, unknown>).tool;
            delete (cleanInput as Record<string, unknown>).name;
            delete (cleanInput as Record<string, unknown>).action;
            return { action: 'tool', tool, input: cleanInput, protocol: 'gemma' };
          }
        } else {
          // target is the tool name, e.g. call:shell{...}
          return { action: 'tool', tool: target, input: parsed, protocol: 'gemma' };
        }
      }
    }
  }

  // Pattern 2: <|tool_call>{...}
  const rawObj = extractFirstObject(snippet);
  if (rawObj) {
    const parsed = tryParseObject(rawObj);
    if (parsed) {
      const tool = (parsed.name ?? parsed.tool ?? parsed.action) as string | undefined;
      const input = (parsed.arguments ?? parsed.input ?? parsed.parameters ?? parsed) as Record<string, unknown>;
      if (tool && (toolNames.has(tool) || tool === 'tool')) {
        return {
          action: 'tool',
          tool: tool === 'tool' ? (parsed.tool as string) : tool,
          input: input === parsed ? undefined : input,
          protocol: 'gemma',
        };
      }
    }
  }

  return null;
}

/**
 * Qwen / ChatML Wire Protocol Adapter
 *
 * Handles:
 * - `<tool_call>\n{"name":"shell","arguments":{"command":"..."}}\n</tool_call>`
 */
export function parseQwenProtocol(text: string): CanonicalAction | null {
  const match = text.match(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/);
  if (!match) return null;

  const rawObj = extractFirstObject(match[1]);
  if (!rawObj) return null;

  const parsed = tryParseObject(rawObj);
  if (!parsed) return null;

  const tool = (parsed.name ?? parsed.tool ?? parsed.action) as string | undefined;
  const rawInput = parsed.arguments ?? parsed.input ?? parsed.parameters;
  let input: Record<string, unknown> | undefined;
  if (typeof rawInput === 'string') {
    try {
      input = JSON.parse(rawInput);
    } catch {
      input = { command: rawInput };
    }
  } else if (rawInput && typeof rawInput === 'object') {
    input = rawInput as Record<string, unknown>;
  }

  if (tool) {
    return { action: 'tool', tool, input: input ?? {}, protocol: 'qwen' };
  }

  return null;
}

/**
 * Anthropic Wire Protocol Adapter
 *
 * Handles:
 * - `<tool_use>\n<name>shell</name>\n<parameters>\n{"command":"..."}\n</parameters>\n</tool_use>`
 */
export function parseAnthropicProtocol(text: string): CanonicalAction | null {
  const match = text.match(/<tool_use>\s*<name>(.*?)<\/name>\s*<(?:parameters|input)>([\s\S]*?)<\/(?:parameters|input)>\s*<\/tool_use>/);
  if (!match) return null;

  const tool = match[1].trim();
  const rawParams = match[2].trim();
  const parsed = tryParseObject(rawParams) ?? {};

  return { action: 'tool', tool, input: parsed, protocol: 'anthropic' };
}

/**
 * OpenAI Wire Protocol Adapter
 *
 * Handles:
 * - `{"name":"shell","arguments":{"command":"..."}}`
 * - `{"tool_calls":[{"function":{"name":"shell","arguments":"..."}}]}`
 */
export function parseOpenAiProtocol(obj: Record<string, unknown>): CanonicalAction | null {
  // Nested tool_calls array
  if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
    const first = obj.tool_calls[0] as Record<string, unknown>;
    const fn = (first.function ?? first) as Record<string, unknown>;
    const tool = (fn.name ?? fn.tool) as string | undefined;
    let input: Record<string, unknown> = {};
    if (typeof fn.arguments === 'string') {
      try { input = JSON.parse(fn.arguments); } catch {}
    } else if (typeof fn.arguments === 'object' && fn.arguments) {
      input = fn.arguments as Record<string, unknown>;
    }
    if (tool) {
      return { action: 'tool', tool, input, protocol: 'openai' };
    }
  }

  // Nested function object
  if (obj.function && typeof obj.function === 'object') {
    const fn = obj.function as Record<string, unknown>;
    const tool = (fn.name ?? fn.tool) as string | undefined;
    let input: Record<string, unknown> = {};
    if (typeof fn.arguments === 'string') {
      try { input = JSON.parse(fn.arguments); } catch {}
    } else if (typeof fn.arguments === 'object' && fn.arguments) {
      input = fn.arguments as Record<string, unknown>;
    }
    if (tool) {
      return { action: 'tool', tool, input, protocol: 'openai' };
    }
  }

  // Top-level function calling format
  if (typeof obj.name === 'string' && (obj.arguments !== undefined || obj.parameters !== undefined)) {
    const tool = obj.name;
    let input: Record<string, unknown> = {};
    const raw = obj.arguments ?? obj.parameters;
    if (typeof raw === 'string') {
      try { input = JSON.parse(raw); } catch { input = { command: raw }; }
    } else if (typeof raw === 'object' && raw) {
      input = raw as Record<string, unknown>;
    }
    return { action: 'tool', tool, input, protocol: 'openai' };
  }

  return null;
}

/**
 * Main Protocol Adapter Entrypoint.
 *
 * Translates model output in any recognized wire protocol into a canonical Wazir action.
 */
export class ModelProtocolAdapter {
  static parse(raw: string, toolNames: Set<string>): CanonicalAction | null {
    // 1. Gemma native protocol (<|tool_call>...)
    const gemma = parseGemmaProtocol(raw, toolNames);
    if (gemma) return gemma;

    // 2. Qwen native protocol (<tool_call>...)
    const qwen = parseQwenProtocol(raw);
    if (qwen) return qwen;

    // 3. Anthropic native protocol (<tool_use>...)
    const anthropic = parseAnthropicProtocol(raw);
    if (anthropic) return anthropic;

    // 4. JSON action extraction
    const unfenced = raw.replace(/```(?:json)?/gi, '');
    const candidate = extractFirstObject(unfenced);
    if (!candidate) return null;

    const obj = tryParseObject(candidate);
    if (!obj) return null;

    // Check OpenAI format
    const openai = parseOpenAiProtocol(obj);
    if (openai) return openai;

    // Standard Wazir format: preserve all original keys so normalizeAction can inspect sibling fields
    if (typeof obj.action === 'string') {
      if (Array.isArray(obj.content)) {
        obj.content = obj.content.map((c) => String(c).trim()).filter(Boolean).join('\n');
      }
      if (Array.isArray(obj.summary)) {
        obj.summary = obj.summary.map((s) => String(s).trim()).filter(Boolean).join('\n');
      }
      if (obj.action === 'tool' && typeof obj.tool === 'string' && obj.input && typeof obj.input === 'object' && !Array.isArray(obj.input)) {
        obj.input = normalizeToolArguments(obj.tool, obj.input as Record<string, unknown>);
      }
      return obj as unknown as CanonicalAction;
    }

    // Shorthand tool format where tool name is top-level: {"tool":"shell","command":"..."}
    if (typeof obj.tool === 'string') {
      const { tool, ...rest } = obj;
      const input = (obj.input && typeof obj.input === 'object' && !Array.isArray(obj.input))
        ? obj.input as Record<string, unknown>
        : rest;
      return { action: 'tool', tool, input: normalizeToolArguments(tool, input), protocol: 'wazir' };
    }

    // Shorthand tool format where tool name is the action: {"shell":"...", ...} or name in toolNames
    for (const toolName of toolNames) {
      if (obj[toolName] !== undefined) {
        const val = obj[toolName];
        const input = typeof val === 'object' && val && !Array.isArray(val)
          ? val as Record<string, unknown>
          : { [toolName === 'shell' ? 'command' : 'path']: val };
        return { action: 'tool', tool: toolName, input: normalizeToolArguments(toolName, input), protocol: 'wazir' };
      }
    }

    return null;
  }
}

export function quoteShellArg(arg: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Normalizes tool arguments across model dialects and argument alias conventions.
 *
 * For example:
 * - `glob`: maps `content`, `query`, `glob`, `file_pattern`, `match`, etc. to `pattern`
 * - `shell`: maps `content`, `cmd`, `script`, `run`, `code`, `exec` to `command`, coerces arrays
 * - `read`: maps `file`, `filepath`, `filePath`, `filename`, `fileName`, `target`, `content` to `path`
 * - `write`: maps `file`/`target` to `path`, and `text`/`code`/`data`/`body`/`contents` to `content`
 * - `edit`: maps `file` to `path`, `old_string`/`find`/`original` to `oldString`, `new_string`/`replace` to `newString`
 */
export function normalizeToolArguments(tool: string, rawInput: Record<string, unknown>): Record<string, unknown> {
  let input = { ...rawInput };

  // 1. Unwrap nested containers: { input: {...} }, { arguments: {...} }, { parameters: {...} }, { args: {...} }
  const nested = input.input ?? input.arguments ?? input.parameters ?? input.args;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    input = { ...input, ...(nested as Record<string, unknown>) };
    delete input.input;
    delete input.arguments;
    delete input.parameters;
    delete input.args;
  }

  // Unwrap { content: { ... } } if content holds an object
  if (input.content && typeof input.content === 'object' && !Array.isArray(input.content)) {
    input = { ...input, ...(input.content as Record<string, unknown>) };
  }

  // 2. Per-tool dialect mappings
  switch (tool) {
    case 'glob': {
      if (input.pattern === undefined || input.pattern === null) {
        const candidate = input.content ?? input.query ?? input.glob ?? input.file_pattern ?? input.path_pattern ?? input.match ?? input.search;
        if (typeof candidate === 'string') {
          input.pattern = candidate;
        }
      }
      if (input.path === undefined || input.path === null) {
        const candidate = input.cwd ?? input.dir ?? input.directory ?? input.root;
        if (typeof candidate === 'string') {
          input.path = candidate;
        }
      }
      // Clean up alias keys
      delete input.content;
      delete input.query;
      delete input.glob;
      delete input.file_pattern;
      delete input.path_pattern;
      delete input.match;
      delete input.search;
      delete input.cwd;
      delete input.dir;
      delete input.directory;
      delete input.root;
      break;
    }

    case 'shell': {
      // Coerce argv array
      if (Array.isArray(input.command)) {
        input.command = input.command.map((part) => quoteShellArg(String(part))).join(' ');
      }
      if (input.command === undefined || input.command === null) {
        const candidate = input.content ?? input.cmd ?? input.script ?? input.run ?? input.code ?? input.exec;
        if (typeof candidate === 'string') {
          input.command = candidate;
        } else if (Array.isArray(candidate)) {
          input.command = candidate.map((part) => quoteShellArg(String(part))).join(' ');
        }
      }
      delete input.content;
      delete input.cmd;
      delete input.script;
      delete input.run;
      delete input.code;
      delete input.exec;
      break;
    }

    case 'read':
    case 'read_file':
    case 'view_file': {
      if (input.path === undefined || input.path === null) {
        const candidate = input.file ?? input.filepath ?? input.filePath ?? input.filename ?? input.fileName ?? input.target ?? input.AbsolutePath;
        if (typeof candidate === 'string') {
          input.path = candidate;
        } else if (typeof input.content === 'string' && !input.content.includes('\n') && input.content.trim().length > 0) {
          // If model gave content: "Makefile"
          input.path = input.content.trim();
        }
      }
      delete input.file;
      delete input.filepath;
      delete input.filePath;
      delete input.filename;
      delete input.fileName;
      delete input.target;
      delete input.AbsolutePath;
      delete input.content;
      break;
    }

    case 'write':
    case 'write_to_file': {
      if (input.path === undefined || input.path === null) {
        const candidate = input.file ?? input.filepath ?? input.filePath ?? input.filename ?? input.fileName ?? input.target ?? input.TargetFile;
        if (typeof candidate === 'string') {
          input.path = candidate;
        }
      }
      if (input.content === undefined || input.content === null) {
        const candidate = input.text ?? input.code ?? input.data ?? input.body ?? input.contents ?? input.CodeContent;
        if (typeof candidate === 'string') {
          input.content = candidate;
        }
      }
      delete input.file;
      delete input.filepath;
      delete input.filePath;
      delete input.filename;
      delete input.fileName;
      delete input.target;
      delete input.TargetFile;
      delete input.text;
      delete input.code;
      delete input.data;
      delete input.body;
      delete input.contents;
      delete input.CodeContent;
      break;
    }

    case 'edit':
    case 'replace_file_content': {
      if (input.path === undefined || input.path === null) {
        const candidate = input.file ?? input.filepath ?? input.filePath ?? input.filename ?? input.fileName ?? input.TargetFile;
        if (typeof candidate === 'string') {
          input.path = candidate;
        }
      }
      if (input.oldString === undefined || input.oldString === null) {
        const candidate = input.old_string ?? input.oldText ?? input.find ?? input.original ?? input.TargetContent;
        if (typeof candidate === 'string') {
          input.oldString = candidate;
        }
      }
      if (input.newString === undefined || input.newString === null) {
        const candidate = input.new_string ?? input.newText ?? input.replace ?? input.replacement ?? input.ReplacementContent;
        if (typeof candidate === 'string') {
          input.newString = candidate;
        }
      }
      delete input.file;
      delete input.filepath;
      delete input.filePath;
      delete input.filename;
      delete input.fileName;
      delete input.TargetFile;
      delete input.old_string;
      delete input.oldText;
      delete input.find;
      delete input.original;
      delete input.TargetContent;
      delete input.new_string;
      delete input.newText;
      delete input.replace;
      delete input.replacement;
      delete input.ReplacementContent;
      break;
    }
  }

  return input;
}

export interface SemanticValidationResult {
  ok: boolean;
  reason?: string;
}

const PLACEHOLDER_PATTERNS = [
  /^(\.{2,}|…)$/,                                         // .., ..., ...., …
  /^<[^>]+>$/,                                            // <command>, <your command>, <file>
  /^\[[^\]]+\]$/,                                         // [command], [your command here]
  /^(TODO|FIXME|PLACEHOLDER|TBD)\b/i,                     // TODO, FIXME, etc.
  /^(your\s+(shell\s+)?command(\s+here)?|insert\s+command\s+here|command\s+here|your_command_here)$/i,
  /^(your\s+code\s+here|insert\s+code\s+here|path\/to\/file|path\/to\/filename)$/i,
];

/**
 * Semantic validation of tool action arguments.
 * Rejects empty strings, placeholders, and dummy inputs that pass structural syntax checks.
 */
export function validateToolActionSemantics(
  tool: string,
  input: Record<string, unknown>,
): SemanticValidationResult {
  if (tool === 'shell') {
    if (typeof input.command !== 'string') {
      return { ok: false, reason: "'shell' requires a string command" };
    }
    const trimmed = input.command.trim();
    // Present-but-blank command (e.g. command: "") is left to the policy engine,
    // which produces the plain-language 'Blocked: empty shell command' in the TUI.
    if (trimmed.length === 0) {
      return { ok: true };
    }
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          ok: false,
          reason: `Shell command is a placeholder ('${trimmed}'). You must specify the actual shell command to execute.`,
        };
      }
    }
  }

  if (tool === 'glob') {
    if (typeof input.pattern !== 'string') {
      return { ok: false, reason: "'glob' requires a string pattern" };
    }
    const trimmed = input.pattern.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: 'Glob pattern cannot be empty' };
    }
    if (/^(\.{2,}|…|<[^>]+>|\[[^\]]+\]|TODO|FIXME)$/i.test(trimmed)) {
      return {
        ok: false,
        reason: `Glob pattern is a placeholder ('${trimmed}'). You must specify a real search pattern like '**/*' or '*.cpp'.`,
      };
    }
  }

  if (tool === 'read' || tool === 'read_file' || tool === 'view_file') {
    if (typeof input.path !== 'string') {
      return { ok: false, reason: `'${tool}' requires a string file path` };
    }
    const trimmed = input.path.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: 'File path cannot be empty' };
    }
    if (/^(\.{2,}|…|<[^>]+>|path\/to\/file|your_file_here|TODO|FIXME)$/i.test(trimmed)) {
      return {
        ok: false,
        reason: `File path is a placeholder ('${trimmed}'). You must specify a real file path.`,
      };
    }
  }

  if (tool === 'write' || tool === 'write_to_file') {
    if (typeof input.path !== 'string') {
      return { ok: false, reason: `'${tool}' requires a string file path` };
    }
    const trimmed = input.path.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: 'File path cannot be empty' };
    }
    if (/^(\.{2,}|…|<[^>]+>|path\/to\/file|your_file_here|TODO|FIXME)$/i.test(trimmed)) {
      return {
        ok: false,
        reason: `File path is a placeholder ('${trimmed}'). You must specify a real file path.`,
      };
    }
  }

  return { ok: true };
}
