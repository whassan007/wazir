import { normalizeToolArguments } from '../protocolAdapters.js';

/**
 * Habitual tool names emitted by Qwen, Claude, and Gemini models mapped to
 * Wazir's canonical tool names (Decision #2: keep Wazir canonical names on schemas,
 * normalize aliases transparently at dispatch).
 */
const HABITUAL_TOOL_ALIASES: Readonly<Record<string, string>> = {
  read_file: 'read',
  view_file: 'read',
  read_many: 'read_many_files',
  write_file: 'write',
  create_file: 'write',
  write_to_file: 'write',
  replace: 'edit',
  str_replace: 'edit',
  edit_file: 'edit',
  replace_file_content: 'edit',
  multiedit: 'multi_edit',
  grep: 'search',
  grep_search: 'search',
  ripgrep: 'search',
  list_directory: 'glob',
  find_by_name: 'glob',
  run_shell_command: 'shell',
  execute_command: 'shell',
  bash: 'shell',
  todowrite: 'todo_write',
  write_todos: 'todo_write',
  task: 'dispatch_subagent',
  subagent: 'dispatch_subagent',
};
/**
 * Resolves a model-emitted tool name to an exposed canonical tool name when possible.
 * If `rawName` is already in `availableNames`, returns it unchanged.
 * If `rawName` matches a known habitual alias whose canonical target IS in `availableNames`,
 * returns the canonical target; otherwise returns `rawName` so unknown-tool guards still fire.
 */
export function normalizeQwenToolAlias(rawName: string, availableNames: ReadonlySet<string>): string {
  const trimmed = rawName.trim();
  if (availableNames.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (availableNames.has(lower)) return lower;
  const target = HABITUAL_TOOL_ALIASES[lower];
  if (target && availableNames.has(target)) {
    return target;
  }
  return trimmed;
}

/**
 * Normalizes snake_case / alternate parameter keys from Qwen/Claude/Gemini into
 * Wazir's canonical tool input shape without clobbering canonical keys already set.
 */
export function normalizeQwenToolInput(toolName: string, rawInput: unknown): Record<string, unknown> {
  let obj: Record<string, unknown> = {};
  if (typeof rawInput === 'string') {
    try {
      const parsed = JSON.parse(rawInput);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      obj = {};
    }
  } else if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    obj = { ...(rawInput as Record<string, unknown>) };
  }

  // Common snake_case aliases from Qwen Code / Claude Code (delete alias keys so strict JSON Schema validators pass)
  if (obj.path === undefined) {
    if (typeof obj.file_path === 'string') {
      obj.path = obj.file_path;
      delete obj.file_path;
    } else if (typeof obj.filepath === 'string') {
      obj.path = obj.filepath;
      delete obj.filepath;
    } else if (typeof obj.absolute_path === 'string') {
      obj.path = obj.absolute_path;
      delete obj.absolute_path;
    }
  }

  if (toolName === 'edit') {
    if (obj.oldString === undefined) {
      if (typeof obj.old_string === 'string') {
        obj.oldString = obj.old_string;
        delete obj.old_string;
      } else if (typeof obj.old_str === 'string') {
        obj.oldString = obj.old_str;
        delete obj.old_str;
      }
    }
    if (obj.newString === undefined) {
      if (typeof obj.new_string === 'string') {
        obj.newString = obj.new_string;
        delete obj.new_string;
      } else if (typeof obj.new_str === 'string') {
        obj.newString = obj.new_str;
        delete obj.new_str;
      }
    }
    if (obj.replaceAll === undefined && typeof obj.replace_all === 'boolean') {
      obj.replaceAll = obj.replace_all;
      delete obj.replace_all;
    }
  } else if (toolName === 'multi_edit' && Array.isArray(obj.edits)) {
    obj.edits = obj.edits.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const e = { ...(entry as Record<string, unknown>) };
      if (e.oldString === undefined && typeof e.old_string === 'string') {
        e.oldString = e.old_string;
        delete e.old_string;
      }
      if (e.newString === undefined && typeof e.new_string === 'string') {
        e.newString = e.new_string;
        delete e.new_string;
      }
      if (e.replaceAll === undefined && typeof e.replace_all === 'boolean') {
        e.replaceAll = e.replace_all;
        delete e.replace_all;
      }
      return e;
    });
  } else if (toolName === 'read_many_files') {
    if (obj.paths === undefined && Array.isArray(obj.files)) {
      obj.paths = obj.files;
      delete obj.files;
    }
  } else if (toolName === 'dispatch_subagent') {
    if (obj.description === undefined && typeof obj.prompt === 'string') {
      obj.description = obj.prompt;
      delete obj.prompt;
    }
    if (obj.role === undefined && typeof obj.subagent_type === 'string') {
      if (obj.subagent_type === 'plan') {
        obj.role = 'plan';
      } else if (obj.subagent_type === 'worker' || obj.subagent_type === 'general-purpose' || obj.subagent_type === 'coder') {
        obj.role = 'worker';
      } else {
        obj.role = 'explore';
      }
      delete obj.subagent_type;
    }
  }

  return normalizeToolArguments(toolName, obj);
}

export interface ParsedXmlToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

const TOOL_CALL_BLOCK_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
const QWEN3_FN_RE = /<function\s*=\s*([A-Za-z0-9_.:-]+)\s*>([\s\S]*?)<\/function>/i;
const QWEN3_PARAM_RE = /<parameter\s*=\s*([A-Za-z0-9_.-]+)\s*>([\s\S]*?)<\/parameter>/gi;

/**
 * Fallback parser for local vLLM / llama.cpp / Ollama servers serving Qwen2.5/Qwen3
 * without `--enable-auto-tool-choice`, where `<tool_call>...</tool_call>` blocks
 * arrive inside `delta.content` instead of structured `tool_call` SSE events.
 */
export function parseXmlToolCalls(content: string, turnIndex = 0): {
  calls: ParsedXmlToolCall[];
  strippedContent: string;
} {
  if (!content || !content.includes('<tool_call>')) {
    return { calls: [], strippedContent: content };
  }

  const calls: ParsedXmlToolCall[] = [];
  let idx = 0;
  TOOL_CALL_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOOL_CALL_BLOCK_RE.exec(content)) !== null) {
    const inner = match[1].trim();
    // Format A: Qwen2.5 JSON inside <tool_call>{"name": "...", "arguments": {...}}</tool_call>
    if (inner.startsWith('{')) {
      try {
        const parsed = JSON.parse(inner) as { name?: unknown; arguments?: unknown; parameters?: unknown };
        if (typeof parsed.name === 'string' && parsed.name.trim()) {
          const rawArgs = parsed.arguments ?? parsed.parameters ?? {};
          const input =
            rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : typeof rawArgs === 'string'
                ? (JSON.parse(rawArgs) as Record<string, unknown>)
                : {};
          calls.push({
            id: `xml-call-${turnIndex}-${idx++}`,
            name: parsed.name.trim(),
            input,
          });
          continue;
        }
      } catch {
        // Fall through to Format B check
      }
    }

    // Format B: Qwen3Coder XML <function=read><parameter=path>foo.ts</parameter></function>
    const fnMatch = QWEN3_FN_RE.exec(inner);
    if (fnMatch) {
      const fnName = fnMatch[1].trim();
      const paramsBody = fnMatch[2];
      const input: Record<string, unknown> = {};
      QWEN3_PARAM_RE.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = QWEN3_PARAM_RE.exec(paramsBody)) !== null) {
        const key = pm[1].trim();
        let valText = pm[2];
        if (valText.startsWith('\n')) valText = valText.slice(1);
        if (valText.endsWith('\n')) valText = valText.slice(0, -1);
        try {
          const maybeJson = JSON.parse(valText);
          if (typeof maybeJson === 'number' || typeof maybeJson === 'boolean' || Array.isArray(maybeJson) || (maybeJson && typeof maybeJson === 'object')) {
            input[key] = maybeJson;
            continue;
          }
        } catch {
          // treat as literal string
        }
        input[key] = valText;
      }
      calls.push({
        id: `xml-call-${turnIndex}-${idx++}`,
        name: fnName,
        input,
      });
    }
  }

  if (calls.length === 0) {
    return { calls: [], strippedContent: content };
  }

  const strippedContent = content.replace(TOOL_CALL_BLOCK_RE, '').trim();
  return { calls, strippedContent };
}
