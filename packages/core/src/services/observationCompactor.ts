import type { ToolResult } from '../types/tool.js';

/**
 * Normalizes large tool observations before they enter the next model request.
 *
 * The complete raw output is never discarded here — callers keep the original
 * `ToolResult` as execution evidence (the agent's `tool_call` turn, the engine's
 * tool-call records). This only decides what the *model* sees: a compact,
 * actionable projection instead of thousands of lines of compiler/test noise.
 * Output already within budget passes through unchanged.
 */

export type ObservationKind = 'check' | 'diff' | 'search' | 'file' | 'generic';

export interface CompactedObservation {
  /** Model-visible text. */
  text: string;
  kind: ObservationKind;
  compacted: boolean;
  rawChars: number;
}

export interface ObservationCompactorOptions {
  /** Output at or below this many characters is passed through verbatim (default 4000). */
  maxChars?: number;
  /** Primary diagnostics listed individually in a failure summary (default 5). */
  maxPrimaryErrors?: number;
}

const CHECK_TOOLS = new Set(['build', 'test', 'lint', 'typecheck']);
const SEARCH_TOOLS = new Set(['search', 'glob', 'grep']);
const FILE_TOOLS = new Set(['read']);

const EXIT_CODE_RE = /exited with code (-?\d+)/i;
// gcc/clang `file:line:col: error: msg`, tsc `file(line,col): error TSxxxx: msg`, eslint-style `file:line:col  error  msg`.
const LOCATED_DIAGNOSTIC_RES: RegExp[] = [
  /^(?<file>[^\s:()]+):(?<line>\d+):\d+:?\s+(?:fatal )?error:\s+(?<message>.+)$/,
  /^(?<file>[^\s()]+)\((?<line>\d+),\d+\):\s+error\s+(?<message>TS\d+:.+)$/,
  /^\s*(?<line>\d+):\d+\s+error\s+(?<message>.+)$/,
];
const FAILED_TEST_RE = /^\s*(?:FAIL|✗|×|FAILED|not ok)\s+(.+)$/;
const GENERIC_ERROR_RE = /\b(error|exception|traceback|assert(ion)?error|undefined reference|segmentation fault)\b/i;

interface Diagnostic {
  file?: string;
  line?: number;
  message: string;
}

function classify(tool: string, input: Record<string, unknown>): ObservationKind {
  if (CHECK_TOOLS.has(tool)) return 'check';
  if (SEARCH_TOOLS.has(tool)) return 'search';
  if (FILE_TOOLS.has(tool)) return 'file';
  const command = typeof input.command === 'string' ? input.command : '';
  if (tool === 'git' || /^\s*git\s+(diff|status|show|log)\b/.test(command)) return 'diff';
  // Lookahead rather than a trailing \b: `g++`/`clang++` end in a non-word character.
  if (/(^|[\s/;&|])(make|cmake|g\+\+|gcc|clang\+?\+?|tsc|cargo|go (build|test)|npm (run|test)|pnpm|yarn|pytest|vitest|jest|eslint|mvn|gradle)(?=\s|$)/.test(command)) {
    return 'check';
  }
  return 'generic';
}

function extractDiagnostics(lines: string[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    let matched = false;
    for (const re of LOCATED_DIAGNOSTIC_RES) {
      const m = re.exec(line);
      if (m?.groups) {
        diagnostics.push({
          file: m.groups.file,
          line: m.groups.line ? Number(m.groups.line) : undefined,
          message: m.groups.message.trim(),
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const failed = FAILED_TEST_RE.exec(line);
    if (failed) diagnostics.push({ message: `test failed: ${failed[1].trim()}` });
  }
  if (diagnostics.length > 0) return diagnostics;
  // Nothing structured — fall back to lines that at least look like errors.
  for (const raw of lines) {
    if (GENERIC_ERROR_RE.test(raw)) diagnostics.push({ message: raw.trim() });
  }
  return diagnostics;
}

function headTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const omittedLines = text.slice(half, text.length - half).split('\n').length - 1;
  return `${head}\n… [${text.length - 2 * half} chars / ~${omittedLines} lines omitted; full output retained as execution evidence] …\n${tail}`;
}

function summarizeFailure(tool: string, input: Record<string, unknown>, result: ToolResult, maxPrimary: number, maxChars: number): string {
  const combined = [result.error, result.output].filter(Boolean).join('\n');
  const lines = combined.split('\n');
  const diagnostics = extractDiagnostics(lines);
  const exitCode = EXIT_CODE_RE.exec(result.error ?? combined)?.[1];
  const command = typeof input.command === 'string' ? input.command : tool;
  const failedFiles = [...new Set(diagnostics.map((d) => d.file).filter((f): f is string => Boolean(f)))];
  const out: string[] = [];
  if (exitCode !== undefined) out.push(`exitCode: ${exitCode}`);
  out.push(`failedCommand: ${command}`);
  if (failedFiles.length > 0) out.push('failedFiles:', ...failedFiles.slice(0, 10).map((f) => `  - ${f}`));
  if (diagnostics.length > 0) {
    out.push('primaryErrors:');
    for (const d of diagnostics.slice(0, maxPrimary)) {
      const where = d.file ? `${d.file}${d.line !== undefined ? `:${d.line}` : ''}: ` : d.line !== undefined ? `line ${d.line}: ` : '';
      out.push(`  - ${where}${d.message}`);
    }
    if (diagnostics.length > maxPrimary) out.push(`additionalErrors: ${diagnostics.length - maxPrimary}`);
  }
  // A short tail keeps summary lines like "3 failed, 12 passed" the parsers above don't know.
  const tailBudget = Math.max(400, Math.floor(maxChars / 4));
  out.push('outputTail:', combined.slice(-tailBudget));
  out.push(`[compacted from ${combined.length} chars; full output retained as execution evidence]`);
  return out.join('\n');
}

function summarizeSearch(result: ToolResult, maxChars: number): string {
  const lines = result.output.split('\n').filter((l) => l.trim().length > 0);
  const shown: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > maxChars - 200) break;
    shown.push(line);
    size += line.length + 1;
  }
  return [
    `matches: ${lines.length}`,
    ...shown,
    ...(shown.length < lines.length ? [`… ${lines.length - shown.length} more matches omitted; narrow the search to see them`] : []),
  ].join('\n');
}

function summarizeDiff(result: ToolResult, maxChars: number): string {
  const text = result.output;
  const files: Array<{ file: string; added: number; removed: number }> = [];
  let current: { file: string; added: number; removed: number } | null = null;
  for (const line of text.split('\n')) {
    const header = /^diff --git a\/(\S+) b\//.exec(line);
    if (header) {
      current = { file: header[1], added: 0, removed: 0 };
      files.push(current);
    } else if (current && line.startsWith('+') && !line.startsWith('+++')) current.added += 1;
    else if (current && line.startsWith('-') && !line.startsWith('---')) current.removed += 1;
  }
  if (files.length === 0) return headTail(text, maxChars);
  const header = ['changedFiles:', ...files.map((f) => `  - ${f.file} (+${f.added} -${f.removed})`)].join('\n');
  return `${header}\n${headTail(text, Math.max(500, maxChars - header.length - 100))}`;
}

export class ObservationCompactor {
  private readonly maxChars: number;
  private readonly maxPrimaryErrors: number;

  constructor(options: ObservationCompactorOptions = {}) {
    this.maxChars = options.maxChars ?? 4000;
    this.maxPrimaryErrors = options.maxPrimaryErrors ?? 5;
  }

  compact(tool: string, input: Record<string, unknown>, result: ToolResult): CompactedObservation {
    const kind = classify(tool, input);
    const raw = result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n');
    const rawChars = raw.length;
    if (rawChars <= this.maxChars) return { text: raw, kind, compacted: false, rawChars };

    let text: string;
    if (!result.ok && (kind === 'check' || kind === 'generic')) {
      text = summarizeFailure(tool, input, result, this.maxPrimaryErrors, this.maxChars);
    } else if (kind === 'search') {
      text = summarizeSearch(result, this.maxChars);
    } else if (kind === 'diff') {
      text = summarizeDiff(result, this.maxChars);
    } else {
      text = headTail(raw, this.maxChars);
    }
    if (!result.ok && !text.startsWith('exitCode') && !text.includes('failedCommand')) text = `ERROR\n${text}`;
    return { text, kind, compacted: true, rawChars };
  }
}
