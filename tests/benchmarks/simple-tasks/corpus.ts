/**
 * A089 — 50-Simple-Task Everyday Reliability Benchmark Corpus (`ST-001` .. `ST-050`)
 *
 * Defines 50 deterministic, realistic everyday software engineering tasks across 7 categories:
 *  1. `read_only_qa`         (`ST-001`..`ST-008`, 8 tasks): repo Q&A, zero edits allowed, zero verification tax
 *  2. `one_line_bugfix`      (`ST-009`..`ST-016`, 8 tasks): off-by-one, inverted boolean, Stage 2/3 fuzzy indentation shifts
 *  3. `symbol_rename`        (`ST-017`..`ST-023`, 7 tasks): multi-occurrence `edit` (`replaceAll`) / `multi_edit`
 *  4. `new_helper_function`  (`ST-024`..`ST-030`, 7 tasks): add exported helper + JSDoc cleanly
 *  5. `config_json_edit`     (`ST-031`..`ST-037`, 7 tasks): update `tsconfig.json` / `package.json` / `.env.example`
 *  6. `multi_file_read_edit` (`ST-038`..`ST-044`, 7 tasks): batch `read_many_files` (2-3 files) + coordinated caller/callee edits
 *  7. `targeted_shell_check` (`ST-045`..`ST-050`, 6 tasks): edit `.mjs` module + run `node --check` / inline `node -e` assertion
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GenerationEvent } from '@wazir/runtimes-interfaces';

export type SimpleTaskCategory =
  | 'read_only_qa'
  | 'one_line_bugfix'
  | 'symbol_rename'
  | 'new_helper_function'
  | 'config_json_edit'
  | 'multi_file_read_edit'
  | 'targeted_shell_check';

export interface QwenTurnAction {
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  text?: string;
}

export interface TaskGradeResult {
  passed: boolean;
  reason: string;
}

export interface SimpleBenchmarkTask {
  id: string;
  category: SimpleTaskCategory;
  title: string;
  prompt: string;
  initialFiles: Record<string, string>;
  /** Native structured tool-calling trajectory for `WazirQwenAgent` (`nativeToolCalling: true`). */
  qwenTurns: QwenTurnAction[];
  /**
   * Raw JSON-in-text trajectory for `LegacyJsonCodingAgent` (`nativeToolCalling: false`),
   * modeling realistic small/local-model raw text JSON emission (plan-phase friction,
   * single-tool serialization, nested-quote/multiline JSON-in-text jitter, and unavailable batch tools).
   */
  legacyRawTurns: string[];
  /** Deterministic disk + output grader executed after the agent finishes. */
  grade: (ctx: {
    workspaceRoot: string;
    agentSucceeded: boolean;
    finalContent: string;
    shellCommandsSucceeded: number;
  }) => TaskGradeResult;
}

export function emitQwenTurnEvents(step: QwenTurnAction): GenerationEvent[] {
  const events: GenerationEvent[] = [];
  if (step.text) {
    events.push({ type: 'token', content: step.text });
  }
  if (step.toolCalls && step.toolCalls.length > 0) {
    for (const tc of step.toolCalls) {
      events.push({
        type: 'tool_call',
        toolCallId: tc.id,
        toolName: tc.name,
        toolInput: tc.input,
      });
    }
    events.push({
      type: 'completed',
      finishReason: 'tool_calls',
      usage: { inputTokens: 280, outputTokens: 65, totalTokens: 345 },
    });
  } else {
    events.push({
      type: 'completed',
      finishReason: 'stop',
      usage: { inputTokens: 310, outputTokens: 45, totalTokens: 355 },
    });
  }
  return events;
}

export function emitLegacyTurnEvents(rawText: string): GenerationEvent[] {
  return [
    { type: 'token', content: rawText },
    {
      type: 'completed',
      finishReason: 'stop',
      usage: { inputTokens: 420, outputTokens: 85, totalTokens: 505 },
    },
  ];
}

function readWorkspaceFile(root: string, rel: string): string {
  const full = join(root, rel);
  if (!existsSync(full)) {
    throw new Error(`Missing expected file: ${rel}`);
  }
  return readFileSync(full, 'utf8');
}

function filesUnchanged(root: string, initialFiles: Record<string, string>): boolean {
  for (const [rel, expected] of Object.entries(initialFiles)) {
    const full = join(root, rel);
    if (!existsSync(full)) return false;
    if (readFileSync(full, 'utf8') !== expected) return false;
  }
  return true;
}

// ============================================================================
// Category 1: Read-Only Q&A (`ST-001` .. `ST-008`, 8 tasks)
// ============================================================================
const READ_ONLY_QA_TASKS: SimpleBenchmarkTask[] = [
  {
    id: 'ST-001',
    category: 'read_only_qa',
    title: 'Explain return type of parseDuration',
    prompt: 'Explain what return type parseDuration has in src/duration.ts and when it returns null.',
    initialFiles: {
      'src/duration.ts': [
        'export interface DurationParts {',
        '  readonly minutes: number;',
        '  readonly seconds: number;',
        '}',
        '',
        'export function parseDuration(raw: string): DurationParts | null {',
        '  const m = /^(\\d+):(\\d{2})$/.exec(raw.trim());',
        '  if (!m) return null;',
        '  return { minutes: Number(m[1]), seconds: Number(m[2]) };',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st001_r1', name: 'read', input: { path: 'src/duration.ts' } }] },
      { text: 'parseDuration returns `DurationParts | null`. It returns `null` when the trimmed input does not match `/^(\\d+):(\\d{2})$/`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/duration.ts"}}',
      '{"action":"answer","content":"parseDuration returns DurationParts | null and returns null when regex matching fails."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, finalContent }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent run failed (e.g. false mutationRequired check)' };
      if (!filesUnchanged(workspaceRoot, READ_ONLY_QA_TASKS[0].initialFiles)) {
        return { passed: false, reason: 'Read-only Q&A mutated workspace files' };
      }
      const ok = /DurationParts\s*\|\s*null/.test(finalContent) && /null/i.test(finalContent);
      return { passed: ok, reason: ok ? 'Accurate return type & null condition' : 'Missing expected type details' };
    },
  },
  {
    id: 'ST-002',
    category: 'read_only_qa',
    title: 'Count named exports in mathExports.ts',
    prompt: 'Count how many named value or function exports exist in src/mathExports.ts.',
    initialFiles: {
      'src/mathExports.ts': [
        'export const GOLDEN_RATIO = 1.6180339887;',
        'export function add(a: number, b: number): number { return a + b; }',
        'export function sub(a: number, b: number): number { return a - b; }',
        'export function mul(a: number, b: number): number { return a * b; }',
        'export function div(a: number, b: number): number { return a / b; }',
        'function internalHelper(x: number): number { return x; }',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st002_r1', name: 'read', input: { path: 'src/mathExports.ts' } }] },
      { text: 'There are 5 named exports in `src/mathExports.ts`: `GOLDEN_RATIO`, `add`, `sub`, `mul`, and `div`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/mathExports.ts"}}',
      '{"action":"answer","content":"There are 5 named exports: GOLDEN_RATIO, add, sub, mul, and div."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, finalContent }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent run failed' };
      if (!filesUnchanged(workspaceRoot, READ_ONLY_QA_TASKS[1].initialFiles)) {
        return { passed: false, reason: 'Workspace mutated on Q&A task' };
      }
      const ok = /\b5\b/.test(finalContent) && finalContent.includes('GOLDEN_RATIO');
      return { passed: ok, reason: ok ? 'Exact export count 5 verified' : 'Wrong export count' };
    },
  },
  {
    id: 'ST-003',
    category: 'read_only_qa',
    title: 'Trace default telemetry port in serverConfig.ts',
    prompt: 'What default port does resolveServerConfig use in src/serverConfig.ts when env.TELEMETRY_PORT is undefined?',
    initialFiles: {
      'src/serverConfig.ts': [
        'const FALLBACK_PORT = 4317;',
        'export function resolveServerConfig(env: Record<string, string | undefined>) {',
        '  const parsed = Number(env.TELEMETRY_PORT);',
        '  return { port: Number.isInteger(parsed) && parsed > 0 ? parsed : FALLBACK_PORT };',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st003_r1', name: 'read', input: { path: 'src/serverConfig.ts' } }] },
      { text: 'When `env.TELEMETRY_PORT` is undefined, `resolveServerConfig` falls back to `FALLBACK_PORT`, which is `4317`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/serverConfig.ts"}}',
      '{"action":"answer","content":"It uses FALLBACK_PORT = 4317."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, finalContent }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent run failed' };
      if (!filesUnchanged(workspaceRoot, READ_ONLY_QA_TASKS[2].initialFiles)) {
        return { passed: false, reason: 'Workspace mutated on Q&A task' };
      }
      return { passed: finalContent.includes('4317'), reason: finalContent.includes('4317') ? 'Matched 4317' : 'Missing 4317' };
    },
  },
  {
    id: 'ST-004',
    category: 'read_only_qa',
    title: 'Check HTTP status mapping for RateLimitError',
    prompt: 'Which HTTP status code is returned for RateLimitError in src/httpErrors.ts?',
    initialFiles: {
      'src/httpErrors.ts': [
        "export type DomainErrorKind = 'NotFoundError' | 'RateLimitError' | 'ConflictError';",
        'export function statusForError(kind: DomainErrorKind): number {',
        '  switch (kind) {',
        "    case 'NotFoundError': return 404;",
        "    case 'ConflictError': return 409;",
        "    case 'RateLimitError': return 429;",
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st004_r1', name: 'read', input: { path: 'src/httpErrors.ts' } }] },
      { text: '`RateLimitError` maps to HTTP status code `429` in `statusForError`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/httpErrors.ts"}}',
      '{"action":"answer","content":"RateLimitError maps to 429."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, finalContent }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent run failed' };
      if (!filesUnchanged(workspaceRoot, READ_ONLY_QA_TASKS[3].initialFiles)) {
        return { passed: false, reason: 'Workspace mutated on Q&A task' };
      }
      return { passed: finalContent.includes('429'), reason: finalContent.includes('429') ? 'Matched 429' : 'Missing 429' };
    },
  },
  {
    id: 'ST-005',
    category: 'read_only_qa',
    title: 'Trace default maxRetries in retryPolicy.ts',
    prompt: 'What is the default maxRetries value in createRetryPolicy in src/retryPolicy.ts?',
    initialFiles: {
      'src/retryPolicy.ts': [
        'export const DEFAULT_MAX_RETRIES = 3;',
        'export function createRetryPolicy(opts?: { maxRetries?: number; baseDelayMs?: number }) {',
        '  return { maxRetries: opts?.maxRetries ?? DEFAULT_MAX_RETRIES, baseDelayMs: opts?.baseDelayMs ?? 250 };',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st005_r1', name: 'read', input: { path: 'src/retryPolicy.ts' } }] },
      { text: 'The default `maxRetries` value in `createRetryPolicy` is `3` (`DEFAULT_MAX_RETRIES`).' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/retryPolicy.ts"}}',
      '{"action":"answer","content":"The default maxRetries is 3."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, finalContent }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent run failed' };
      if (!filesUnchanged(workspaceRoot, READ_ONLY_QA_TASKS[4].initialFiles)) {
        return { passed: false, reason: 'Workspace mutated on Q&A task' };
      }
      return { passed: /\b3\b/.test(finalContent), reason: /\b3\b/.test(finalContent) ? 'Matched 3' : 'Missing 3' };
    },
  },
  {
    id: 'ST-006',
    category: 'read_only_qa',
    title: 'List CacheEvictionMode values in cacheTypes.ts',
    prompt: 'List all string literal values of CacheEvictionMode defined in src/cacheTypes.ts.',
    initialFiles: {
      'src/cacheTypes.ts': [
        "export type CacheEvictionMode = 'lru' | 'lfu' | 'fifo';",
        'export interface CacheOptions { mode: CacheEvictionMode; capacity: number; }',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st006_r1', name: 'read', input: { path: 'src/cacheTypes.ts' } }] },
      { text: 'The string literal values of `CacheEvictionMode` are `lru`, `lfu`, and `fifo`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/cacheTypes.ts"}}',
      '{"action":"answer","content":"lru, lfu, fifo"}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, finalContent }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent run failed' };
      if (!filesUnchanged(workspaceRoot, READ_ONLY_QA_TASKS[5].initialFiles)) {
        return { passed: false, reason: 'Workspace mutated on Q&A task' };
      }
      const ok = ['lru', 'lfu', 'fifo'].every((v) => finalContent.includes(v));
      return { passed: ok, reason: ok ? 'All 3 modes listed' : 'Missing modes' };
    },
  },
  {
    id: 'ST-007',
    category: 'read_only_qa',
    title: 'Inspect protocol-relative URL handling in urlGuard.ts',
    prompt: 'Does isSafeRedirectPath in src/urlGuard.ts allow protocol-relative paths starting with "//"?',
    initialFiles: {
      'src/urlGuard.ts': [
        'export function isSafeRedirectPath(candidate: string): boolean {',
        "  if (!candidate.startsWith('/')) return false;",
        "  if (candidate.startsWith('//') || candidate.startsWith('/\\\\')) return false;",
        '  return true;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st007_r1', name: 'read', input: { path: 'src/urlGuard.ts' } }] },
      { text: 'No (`false`). `isSafeRedirectPath` explicitly rejects paths starting with `"//"` or `"/\\\\"`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/urlGuard.ts"}}',
      '{"action":"answer","content":"No, it returns false for paths starting with //."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, finalContent }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent run failed' };
      if (!filesUnchanged(workspaceRoot, READ_ONLY_QA_TASKS[6].initialFiles)) {
        return { passed: false, reason: 'Workspace mutated on Q&A task' };
      }
      const ok = /\b(no|false|reject)/i.test(finalContent);
      return { passed: ok, reason: ok ? 'Correctly reported false/no' : 'Incorrect answer' };
    },
  },
  {
    id: 'ST-008',
    category: 'read_only_qa',
    title: 'Summarize compiler target and moduleResolution in tsconfig.json',
    prompt: 'Summarize the compilerOptions.target and compilerOptions.moduleResolution values in tsconfig.json.',
    initialFiles: {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
          },
        },
        null,
        2,
      ),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st008_r1', name: 'read', input: { path: 'tsconfig.json' } }] },
      { text: 'In `tsconfig.json`, `compilerOptions.target` is `"ES2022"` and `compilerOptions.moduleResolution` is `"NodeNext"`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"tsconfig.json"}}',
      '{"action":"answer","content":"target is ES2022 and moduleResolution is NodeNext."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, finalContent }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent run failed' };
      if (!filesUnchanged(workspaceRoot, READ_ONLY_QA_TASKS[7].initialFiles)) {
        return { passed: false, reason: 'Workspace mutated on Q&A task' };
      }
      const ok = finalContent.includes('ES2022') && finalContent.includes('NodeNext');
      return { passed: ok, reason: ok ? 'Matched ES2022 & NodeNext' : 'Missing tsconfig values' };
    },
  },
];

// ============================================================================
// Category 2: 1-Line Bugfix (`ST-009` .. `ST-016`, 8 tasks — incl. Stage 2/3 fuzzy indentation shifts)
// ============================================================================
const ONE_LINE_BUGFIX_TASKS: SimpleBenchmarkTask[] = [
  {
    id: 'ST-009',
    category: 'one_line_bugfix',
    title: 'Fix off-by-one loop bound in sumArray.ts',
    prompt: 'Fix the off-by-one bug in sumArray in src/sumArray.ts so it does not read past the end of items.',
    initialFiles: {
      'src/sumArray.ts': [
        'export function sumArray(items: readonly number[]): number {',
        '  let total = 0;',
        '  for (let i = 0; i <= items.length; i += 1) {',
        '    total += items[i];',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st009_r1', name: 'read', input: { path: 'src/sumArray.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st009_e1',
            name: 'edit',
            input: {
              path: 'src/sumArray.ts',
              oldString: '  for (let i = 0; i <= items.length; i += 1) {',
              newString: '  for (let i = 0; i < items.length; i += 1) {',
            },
          },
        ],
      },
      { text: 'Fixed the off-by-one loop condition in `sumArray` from `i <= items.length` to `i < items.length`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/sumArray.ts"}}',
      '{"action":"plan","content":"Replace <= with < in sumArray loop."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/sumArray.ts","oldString":"  for (let i = 0; i <= items.length; i += 1) {","newString":"  for (let i = 0; i < items.length; i += 1) {"}}',
      '{"action":"done","summary":"Fixed off-by-one loop bound."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/sumArray.ts');
      const ok = content.includes('i < items.length') && !content.includes('i <= items.length');
      return { passed: ok, reason: ok ? 'Loop bound fixed' : 'Off-by-one still present' };
    },
  },
  {
    id: 'ST-010',
    category: 'one_line_bugfix',
    title: 'Fix inverted expiration boolean in isExpired.ts',
    prompt: 'Fix the inverted boolean check in isTokenExpired in src/isExpired.ts (a token is expired when expiresAtMs <= nowMs).',
    initialFiles: {
      'src/isExpired.ts': [
        'export function isTokenExpired(expiresAtMs: number, nowMs: number): boolean {',
        '  return expiresAtMs > nowMs;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st010_r1', name: 'read', input: { path: 'src/isExpired.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st010_e1',
            name: 'edit',
            input: {
              path: 'src/isExpired.ts',
              oldString: '  return expiresAtMs > nowMs;',
              newString: '  return expiresAtMs <= nowMs;',
            },
          },
        ],
      },
      { text: 'Updated `isTokenExpired` to return `expiresAtMs <= nowMs`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/isExpired.ts"}}',
      '{"action":"plan","content":"Change > to <= in isTokenExpired."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/isExpired.ts","oldString":"  return expiresAtMs > nowMs;","newString":"  return expiresAtMs <= nowMs;"}}',
      '{"action":"done","summary":"Fixed boolean check."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/isExpired.ts');
      const ok = content.includes('expiresAtMs <= nowMs');
      return { passed: ok, reason: ok ? 'Boolean condition fixed' : 'Wrong operator' };
    },
  },
  {
    id: 'ST-011',
    category: 'one_line_bugfix',
    title: 'Fix rectangle area operator in rectArea.ts',
    prompt: 'Fix computeRectArea in src/rectArea.ts where + was mistakenly used instead of *.',
    initialFiles: {
      'src/rectArea.ts': [
        'export function computeRectArea(width: number, height: number): number {',
        '  if (width < 0 || height < 0) throw new RangeError("negative dimension");',
        '  return width + height;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st011_r1', name: 'read', input: { path: 'src/rectArea.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st011_e1',
            name: 'edit',
            input: {
              path: 'src/rectArea.ts',
              oldString: '  return width + height;',
              newString: '  return width * height;',
            },
          },
        ],
      },
      { text: 'Changed `width + height` to `width * height` in `computeRectArea`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/rectArea.ts"}}',
      '{"action":"plan","content":"Multiply width and height."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/rectArea.ts","oldString":"  return width + height;","newString":"  return width * height;"}}',
      '{"action":"done","summary":"Fixed area operator."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/rectArea.ts');
      const ok = content.includes('return width * height;');
      return { passed: ok, reason: ok ? 'Area multiplication fixed' : 'Still adding width + height' };
    },
  },
  {
    id: 'ST-012',
    category: 'one_line_bugfix',
    title: 'Fix falsy 0 timeout bug with Stage 2 indentation-shifted edit',
    prompt: 'Fix resolveTimeoutMs in src/timeout.ts so passing timeoutMs = 0 is preserved instead of falling back to 5000.',
    initialFiles: {
      'src/timeout.ts': [
        'export function resolveTimeoutMs(timeoutMs?: number): number {',
        '    const effective = timeoutMs || 5000;',
        '    return Math.max(0, effective);',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st012_r1', name: 'read', input: { path: 'src/timeout.ts' } }] },
      {
        // Deliberately 2-space indented oldString against 4-space file to exercise Stage 2 `line_trimmed` smart edit!
        toolCalls: [
          {
            id: 'st012_e1',
            name: 'edit',
            input: {
              path: 'src/timeout.ts',
              oldString: '  const effective = timeoutMs || 5000;\n  return Math.max(0, effective);',
              newString: '    const effective = timeoutMs ?? 5000;\n    return Math.max(0, effective);',
            },
          },
        ],
      },
      { text: 'Switched `||` to nullish coalescing `??` in `resolveTimeoutMs` so `0` is preserved.' },
    ],
    legacyRawTurns: [
      // Small local model emits markdown-wrapped JSON with unescaped raw newlines inside oldString (3 strikes -> protocol failure)
      '```json\n{"action":"tool","tool":"edit","input":{"path":"src/timeout.ts","oldString":"  const effective = timeoutMs || 5000;\n  return Math.max(0, effective);","newString":"  const effective = timeoutMs ?? 5000;\n  return Math.max(0, effective);"}}\n```',
      '```json\n{"action":"tool","tool":"edit","input":{"path":"src/timeout.ts","oldString":"    const effective = timeoutMs || 5000;\n    return Math.max(0, effective);","newString":"    const effective = timeoutMs ?? 5000;\n    return Math.max(0, effective);"}}\n```',
      '```json\n{"action":"tool","tool":"edit","input":{"path":"src/timeout.ts","oldString":"const effective = timeoutMs || 5000;\n","newString":"const effective = timeoutMs ?? 5000;\n"}}\n```',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/timeout.ts');
      const ok = content.includes('timeoutMs ?? 5000') && !content.includes('timeoutMs || 5000');
      return { passed: ok, reason: ok ? 'Nullish coalescing applied' : 'Falsy || bug remains' };
    },
  },
  {
    id: 'ST-013',
    category: 'one_line_bugfix',
    title: 'Fix upper clamp Math.min bug with Stage 2 whitespace-shifted edit',
    prompt: 'Fix clampValue in src/clamp.ts where the upper bound mistakenly used Math.max instead of Math.min.',
    initialFiles: {
      'src/clamp.ts': [
        'export function clampValue(val: number, min: number, max: number): number {',
        '    if (min > max) throw new Error("min > max");',
        '    return Math.max(min, Math.max(max, val));',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st013_r1', name: 'read', input: { path: 'src/clamp.ts' } }] },
      {
        // 2-space shifted snippet matched cleanly via Stage 2 `line_trimmed`
        toolCalls: [
          {
            id: 'st013_e1',
            name: 'edit',
            input: {
              path: 'src/clamp.ts',
              oldString: '  if (min > max) throw new Error("min > max");\n  return Math.max(min, Math.max(max, val));',
              newString: '    if (min > max) throw new Error("min > max");\n    return Math.max(min, Math.min(max, val));',
            },
          },
        ],
      },
      { text: 'Fixed `clampValue` to use `Math.min(max, val)` for the upper bound.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/clamp.ts"}}',
      // Small model tries calling edit before exiting plan phase (1st strike), then recovers via plan -> edit -> done
      '{"action":"tool","tool":"edit","input":{"path":"src/clamp.ts","oldString":"    return Math.max(min, Math.max(max, val));","newString":"    return Math.max(min, Math.min(max, val));"}}',
      '{"action":"plan","content":"Fix Math.max to Math.min in clampValue."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/clamp.ts","oldString":"    return Math.max(min, Math.max(max, val));","newString":"    return Math.max(min, Math.min(max, val));"}}',
      '{"action":"done","summary":"Fixed upper bound clamp."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/clamp.ts');
      const ok = content.includes('Math.max(min, Math.min(max, val))');
      return { passed: ok, reason: ok ? 'Clamp fixed' : 'Clamp still broken' };
    },
  },
  {
    id: 'ST-014',
    category: 'one_line_bugfix',
    title: 'Fix leap year century rule with Stage 3 block-anchor edit',
    prompt: 'Fix isLeapYear in src/leapYear.ts where divisible-by-100 years return true instead of false.',
    initialFiles: {
      'src/leapYear.ts': [
        'export function isLeapYear(year: number): boolean {',
        '  if (year % 400 === 0) return true;',
        '  // Century years not divisible by 400 are NOT leap years',
        '',
        '  if (year % 100 === 0) return true;',
        '  return year % 4 === 0;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st014_r1', name: 'read', input: { path: 'src/leapYear.ts' } }] },
      {
        // Exercises Stage 3 `block_anchor` (4-line oldString omits interior blank line against 5-line file span;
        // Stage 1 exact & Stage 2 line_trimmed both miss due to line-count mismatch, Stage 3 block_anchor matches!)
        toolCalls: [
          {
            id: 'st014_e1',
            name: 'edit',
            input: {
              path: 'src/leapYear.ts',
              oldString: [
                '  if (year % 400 === 0) return true;',
                '  // Century years not divisible by 400 are NOT leap years',
                '  if (year % 100 === 0) return true;',
                '  return year % 4 === 0;',
              ].join('\n'),
              newString: [
                '  if (year % 400 === 0) return true;',
                '  // Century years not divisible by 400 are NOT leap years',
                '  if (year % 100 === 0) return false;',
                '  return year % 4 === 0;',
              ].join('\n'),
            },
          },
        ],
      },
      { text: 'Fixed `isLeapYear` so `year % 100 === 0` returns `false`.' },
    ],
    legacyRawTurns: [
      // Raw JSON-in-text model emits unescaped multiline block 3 times -> protocol budget exhausted
      'Here is the fix for `{ year }`: ```json\n{"action":"tool","tool":"edit","input":{"path":"src/leapYear.ts","oldString":"if (year % 100 === 0) return true;\nreturn year % 4 === 0;","newString":"if (year % 100 === 0) return false;\nreturn year % 4 === 0;"}}\n```',
      'Let me retry:\n{"action":"tool","tool":"edit","input":{"path":"src/leapYear.ts","oldString":"  if (year % 100 === 0) return true;\n","newString":"  if (year % 100 === 0) return false;\n"}}',
      '{"action":"tool","tool":"edit","input":{"path":"src/leapYear.ts","oldString":"if (year % 100 === 0)\nreturn true;","newString":"if (year % 100 === 0)\nreturn false;"}}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/leapYear.ts');
      const ok = content.includes('if (year % 100 === 0) return false;') && content.includes('if (year % 400 === 0) return true;');
      return { passed: ok, reason: ok ? 'Century leap year fixed' : 'Century rule still wrong' };
    },
  },
  {
    id: 'ST-015',
    category: 'one_line_bugfix',
    title: 'Fix 1-based page offset bug in paginate.ts (Stage 2 shifted indentation)',
    prompt: 'Fix pageOffset in src/paginate.ts so 1-based page=1 yields offset 0 instead of 2 * pageSize.',
    initialFiles: {
      'src/paginate.ts': [
        'export function pageOffset(page: number, pageSize: number): number {',
        '    const safePage = Math.max(1, Math.trunc(page));',
        '    return (safePage + 1) * pageSize;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st015_r1', name: 'read', input: { path: 'src/paginate.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st015_e1',
            name: 'edit',
            input: {
              path: 'src/paginate.ts',
              oldString: '  const safePage = Math.max(1, Math.trunc(page));\n  return (safePage + 1) * pageSize;',
              newString: '    const safePage = Math.max(1, Math.trunc(page));\n    return (safePage - 1) * pageSize;',
            },
          },
        ],
      },
      { text: 'Fixed `pageOffset` to compute `(safePage - 1) * pageSize`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/paginate.ts"}}',
      '{"action":"plan","content":"Change safePage + 1 to safePage - 1."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/paginate.ts","oldString":"    return (safePage + 1) * pageSize;","newString":"    return (safePage - 1) * pageSize;"}}',
      '{"action":"done","summary":"Fixed pagination offset."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/paginate.ts');
      const ok = content.includes('(safePage - 1) * pageSize');
      return { passed: ok, reason: ok ? 'Page offset fixed' : 'Page offset still wrong' };
    },
  },
  {
    id: 'ST-016',
    category: 'one_line_bugfix',
    title: 'Fix slice offset in stripPrefix.ts (Stage 3 anchored block match)',
    prompt: 'Fix stripPrefix in src/stripPrefix.ts so stripping prefix "pre_" from "pre_id" returns "id" instead of "d".',
    initialFiles: {
      'src/stripPrefix.ts': [
        'export function stripPrefix(value: string, prefix: string): string {',
        '  if (!value.startsWith(prefix)) {',
        '    return value;',
        '  }',
        '  return value.slice(prefix.length + 1);',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st016_r1', name: 'read', input: { path: 'src/stripPrefix.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st016_e1',
            name: 'edit',
            input: {
              path: 'src/stripPrefix.ts',
              oldString: [
                '  if (!value.startsWith(prefix)) {',
                '      return value;',
                '  }',
                '  return value.slice(prefix.length + 1);',
              ].join('\n'),
              newString: [
                '  if (!value.startsWith(prefix)) {',
                '    return value;',
                '  }',
                '  return value.slice(prefix.length);',
              ].join('\n'),
            },
          },
        ],
      },
      { text: 'Removed the erroneous `+ 1` in `value.slice(prefix.length)` inside `stripPrefix`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/stripPrefix.ts"}}',
      '{"action":"plan","content":"Replace prefix.length + 1 with prefix.length."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/stripPrefix.ts","oldString":"  return value.slice(prefix.length + 1);","newString":"  return value.slice(prefix.length);"}}',
      '{"action":"done","summary":"Fixed stripPrefix slice index."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/stripPrefix.ts');
      const ok = content.includes('value.slice(prefix.length)') && !content.includes('prefix.length + 1');
      return { passed: ok, reason: ok ? 'Slice index fixed' : 'Off-by-one slice remains' };
    },
  },
];

// ============================================================================
// Category 3: Symbol Rename (`ST-017` .. `ST-023`, 7 tasks)
// ============================================================================
const SYMBOL_RENAME_TASKS: SimpleBenchmarkTask[] = [
  {
    id: 'ST-017',
    category: 'symbol_rename',
    title: 'Rename calcTax to calculateTax across billing.ts',
    prompt: 'Rename the function calcTax and all of its internal call sites in src/billing.ts to calculateTax.',
    initialFiles: {
      'src/billing.ts': [
        'export function calcTax(cents: number, rate: number): number {',
        '  return Math.round(cents * rate);',
        '}',
        '',
        'export function invoiceTotal(subtotalCents: number, rate: number): number {',
        '  return subtotalCents + calcTax(subtotalCents, rate);',
        '}',
        '',
        'export function previewTaxBreakdown(items: number[], rate: number): number[] {',
        '  return items.map((c) => calcTax(c, rate));',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st017_r1', name: 'read', input: { path: 'src/billing.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st017_e1',
            name: 'edit',
            input: {
              path: 'src/billing.ts',
              oldString: 'calcTax',
              newString: 'calculateTax',
              replaceAll: true,
            },
          },
        ],
      },
      { text: 'Renamed `calcTax` to `calculateTax` across all 3 occurrences in `src/billing.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/billing.ts"}}',
      '{"action":"plan","content":"Rename calcTax to calculateTax."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/billing.ts","oldString":"calcTax","newString":"calculateTax","replaceAll":true}}',
      '{"action":"done","summary":"Renamed calcTax to calculateTax."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/billing.ts');
      const ok = !/\bcalcTax\b/.test(content) && (content.match(/\bcalculateTax\b/g) ?? []).length === 3;
      return { passed: ok, reason: ok ? 'All 3 occurrences renamed' : 'Incomplete rename' };
    },
  },
  {
    id: 'ST-018',
    category: 'symbol_rename',
    title: 'Rename usrId to userId across session.ts',
    prompt: 'Rename the property and parameter usrId to userId everywhere in src/session.ts.',
    initialFiles: {
      'src/session.ts': [
        'export interface SessionRecord {',
        '  readonly usrId: string;',
        '  readonly issuedAt: number;',
        '}',
        '',
        'export function createSession(usrId: string, now: number): SessionRecord {',
        '  if (!usrId.trim()) throw new Error("empty usrId");',
        '  return { usrId, issuedAt: now };',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st018_r1', name: 'read', input: { path: 'src/session.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st018_e1',
            name: 'edit',
            input: { path: 'src/session.ts', oldString: 'usrId', newString: 'userId', replaceAll: true },
          },
        ],
      },
      { text: 'Renamed `usrId` to `userId` throughout `src/session.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/session.ts"}}',
      '{"action":"plan","content":"Replace usrId with userId."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/session.ts","oldString":"usrId","newString":"userId","replaceAll":true}}',
      '{"action":"done","summary":"Renamed usrId to userId."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/session.ts');
      const ok = !/\busrId\b/.test(content) && (content.match(/\buserId\b/g) ?? []).length >= 4;
      return { passed: ok, reason: ok ? 'usrId renamed everywhere' : 'usrId still present' };
    },
  },
  {
    id: 'ST-019',
    category: 'symbol_rename',
    title: 'Rename MAX_CONN to MAX_CONNECTIONS in pool.ts',
    prompt: 'Rename the constant MAX_CONN to MAX_CONNECTIONS across src/pool.ts.',
    initialFiles: {
      'src/pool.ts': [
        'export const MAX_CONN = 16;',
        'export function canAcquire(active: number): boolean {',
        '  return active < MAX_CONN;',
        '}',
        'export function remainingSlots(active: number): number {',
        '  return Math.max(0, MAX_CONN - active);',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st019_r1', name: 'read', input: { path: 'src/pool.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st019_e1',
            name: 'edit',
            input: { path: 'src/pool.ts', oldString: 'MAX_CONN', newString: 'MAX_CONNECTIONS', replaceAll: true },
          },
        ],
      },
      { text: 'Renamed `MAX_CONN` to `MAX_CONNECTIONS` across `src/pool.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/pool.ts"}}',
      '{"action":"plan","content":"Rename MAX_CONN to MAX_CONNECTIONS."}',
      // Without replaceAll, legacy model tries single edit on ambiguous 3-occurrence token twice -> validation/tool failure
      '{"action":"tool","tool":"edit","input":{"path":"src/pool.ts","oldString":"MAX_CONN","newString":"MAX_CONNECTIONS"}}',
      '{"action":"tool","tool":"edit","input":{"path":"src/pool.ts","oldString":"MAX_CONN","newString":"MAX_CONNECTIONS","replaceAll":true}}',
      '{"action":"done","summary":"Renamed MAX_CONN."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/pool.ts');
      const ok = !/\bMAX_CONN\b/.test(content) && (content.match(/\bMAX_CONNECTIONS\b/g) ?? []).length === 3;
      return { passed: ok, reason: ok ? 'MAX_CONNECTIONS renamed' : 'Incomplete rename' };
    },
  },
  {
    id: 'ST-020',
    category: 'symbol_rename',
    title: 'Dual symbol rename in money.ts via multi_edit',
    prompt: 'In src/money.ts, rename DEFAULT_CCY to DEFAULT_CURRENCY and fmtCurrency to formatCurrency.',
    initialFiles: {
      'src/money.ts': [
        "export const DEFAULT_CCY = 'USD';",
        'export function fmtCurrency(amount: number, ccy: string = DEFAULT_CCY): string {',
        '  return `${ccy} ${amount.toFixed(2)}`;',
        '}',
        'export function fmtZero(): string {',
        '  return fmtCurrency(0, DEFAULT_CCY);',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st020_r1', name: 'read', input: { path: 'src/money.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st020_me1',
            name: 'multi_edit',
            input: {
              path: 'src/money.ts',
              edits: [
                { oldString: 'DEFAULT_CCY', newString: 'DEFAULT_CURRENCY', replaceAll: true },
                { oldString: 'fmtCurrency', newString: 'formatCurrency', replaceAll: true },
              ],
            },
          },
        ],
      },
      { text: 'Atomically renamed `DEFAULT_CCY` -> `DEFAULT_CURRENCY` and `fmtCurrency` -> `formatCurrency` via `multi_edit`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/money.ts"}}',
      '{"action":"plan","content":"Use multi_edit to rename both symbols."}',
      // LegacyJsonCodingAgent does not expose multi_edit in its surface -> 3 rejected tool attempts -> protocol budget exhausted!
      '{"action":"tool","tool":"multi_edit","input":{"path":"src/money.ts","edits":[{"oldString":"DEFAULT_CCY","newString":"DEFAULT_CURRENCY","replaceAll":true}]}}',
      '{"action":"tool","tool":"multi_edit","input":{"path":"src/money.ts","edits":[{"oldString":"fmtCurrency","newString":"formatCurrency","replaceAll":true}]}}',
      '{"action":"tool","tool":"multi_edit","input":{"path":"src/money.ts","edits":[]}}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/money.ts');
      const ok =
        !/\bDEFAULT_CCY\b/.test(content) &&
        !/\bfmtCurrency\b/.test(content) &&
        content.includes('DEFAULT_CURRENCY') &&
        content.includes('formatCurrency');
      return { passed: ok, reason: ok ? 'Both symbols renamed cleanly' : 'Symbols not renamed' };
    },
  },
  {
    id: 'ST-021',
    category: 'symbol_rename',
    title: 'Rename recursive parseCfg to parseConfig in cfgParser.ts',
    prompt: 'Rename parseCfg (including its recursive call) to parseConfig in src/cfgParser.ts.',
    initialFiles: {
      'src/cfgParser.ts': [
        'export function parseCfg(raw: Record<string, unknown>): Record<string, unknown> {',
        '  const out: Record<string, unknown> = {};',
        '  for (const [k, v] of Object.entries(raw)) {',
        "    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? parseCfg(v as Record<string, unknown>) : v;",
        '  }',
        '  return out;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st021_r1', name: 'read', input: { path: 'src/cfgParser.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st021_e1',
            name: 'edit',
            input: { path: 'src/cfgParser.ts', oldString: 'parseCfg', newString: 'parseConfig', replaceAll: true },
          },
        ],
      },
      { text: 'Renamed `parseCfg` and its recursive call to `parseConfig`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/cfgParser.ts"}}',
      '{"action":"plan","content":"Rename parseCfg to parseConfig."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/cfgParser.ts","oldString":"parseCfg","newString":"parseConfig","replaceAll":true}}',
      '{"action":"done","summary":"Renamed parseCfg."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/cfgParser.ts');
      const ok = !/\bparseCfg\b/.test(content) && (content.match(/\bparseConfig\b/g) ?? []).length === 2;
      return { passed: ok, reason: ok ? 'Recursive rename complete' : 'Incomplete rename' };
    },
  },
  {
    id: 'ST-022',
    category: 'symbol_rename',
    title: 'Dual rename EvtPayload and emitEvt in emitter.ts via multi_edit',
    prompt: 'Rename EvtPayload to EventPayload and emitEvt to emitEvent in src/emitter.ts.',
    initialFiles: {
      'src/emitter.ts': [
        'export interface EvtPayload { readonly topic: string; readonly seq: number; }',
        'export function emitEvt(listeners: Array<(e: EvtPayload) => void>, evt: EvtPayload): number {',
        '  for (const fn of listeners) fn(evt);',
        '  return listeners.length;',
        '}',
        'export function broadcastBatch(listeners: Array<(e: EvtPayload) => void>, batch: EvtPayload[]): number {',
        '  return batch.reduce((acc, e) => acc + emitEvt(listeners, e), 0);',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st022_r1', name: 'read', input: { path: 'src/emitter.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st022_me1',
            name: 'multi_edit',
            input: {
              path: 'src/emitter.ts',
              edits: [
                { oldString: 'EvtPayload', newString: 'EventPayload', replaceAll: true },
                { oldString: 'emitEvt', newString: 'emitEvent', replaceAll: true },
              ],
            },
          },
        ],
      },
      { text: 'Renamed `EvtPayload` -> `EventPayload` and `emitEvt` -> `emitEvent` in `src/emitter.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/emitter.ts"}}',
      '{"action":"plan","content":"Rename EvtPayload and emitEvt sequentially."}',
      // Emits two JSON objects in one turn (parallel text jitter), gets correction, then finishes sequentially
      '{"action":"tool","tool":"edit","input":{"path":"src/emitter.ts","oldString":"EvtPayload","newString":"EventPayload","replaceAll":true}}\n{"action":"tool","tool":"edit","input":{"path":"src/emitter.ts","oldString":"emitEvt","newString":"emitEvent","replaceAll":true}}',
      '{"action":"tool","tool":"edit","input":{"path":"src/emitter.ts","oldString":"EvtPayload","newString":"EventPayload","replaceAll":true}}',
      '{"action":"tool","tool":"edit","input":{"path":"src/emitter.ts","oldString":"emitEvt","newString":"emitEvent","replaceAll":true}}',
      '{"action":"done","summary":"Renamed both symbols."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/emitter.ts');
      const ok =
        !/\bEvtPayload\b/.test(content) &&
        !/\bemitEvt\b/.test(content) &&
        content.includes('EventPayload') &&
        content.includes('emitEvent');
      return { passed: ok, reason: ok ? 'Renamed both symbols' : 'Symbols remaining' };
    },
  },
  {
    id: 'ST-023',
    category: 'symbol_rename',
    title: 'Rename fetchUsrProfile to fetchUserProfile in profileClient.ts',
    prompt: 'Rename fetchUsrProfile to fetchUserProfile across src/profileClient.ts.',
    initialFiles: {
      'src/profileClient.ts': [
        'export async function fetchUsrProfile(id: string): Promise<{ id: string; active: boolean }> {',
        '  return { id, active: true };',
        '}',
        'export async function fetchManyProfiles(ids: string[]) {',
        '  return Promise.all(ids.map((id) => fetchUsrProfile(id)));',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st023_r1', name: 'read', input: { path: 'src/profileClient.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st023_e1',
            name: 'edit',
            input: { path: 'src/profileClient.ts', oldString: 'fetchUsrProfile', newString: 'fetchUserProfile', replaceAll: true },
          },
        ],
      },
      { text: 'Renamed `fetchUsrProfile` to `fetchUserProfile` in `src/profileClient.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/profileClient.ts"}}',
      '{"action":"plan","content":"Rename fetchUsrProfile to fetchUserProfile."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/profileClient.ts","oldString":"fetchUsrProfile","newString":"fetchUserProfile","replaceAll":true}}',
      '{"action":"done","summary":"Renamed fetchUsrProfile."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/profileClient.ts');
      const ok = !/\bfetchUsrProfile\b/.test(content) && (content.match(/\bfetchUserProfile\b/g) ?? []).length === 2;
      return { passed: ok, reason: ok ? 'Renamed fetchUserProfile' : 'Incomplete rename' };
    },
  },
];

// ============================================================================
// Category 4: New Helper Function + JSDoc (`ST-024` .. `ST-030`, 7 tasks)
// ============================================================================
const NEW_HELPER_TASKS: SimpleBenchmarkTask[] = [
  {
    id: 'ST-024',
    category: 'new_helper_function',
    title: 'Add slugify helper + JSDoc to strings.ts',
    prompt: 'Add an exported helper function slugify(input: string): string with JSDoc to src/strings.ts that lowercases text and replaces non-alphanumeric runs with hyphens.',
    initialFiles: {
      'src/strings.ts': [
        'export function trimSlashes(path: string): string {',
        "  return path.replace(/^\\/+|\\/+$/g, '');",
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st024_r1', name: 'read', input: { path: 'src/strings.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st024_e1',
            name: 'edit',
            input: {
              path: 'src/strings.ts',
              oldString: "export function trimSlashes(path: string): string {\n  return path.replace(/^\\/+|\\/+$/g, '');\n}",
              newString: [
                'export function trimSlashes(path: string): string {',
                "  return path.replace(/^\\/+|\\/+$/g, '');",
                '}',
                '',
                '/**',
                ' * Converts an arbitrary string into a URL-safe lowercase hyphenated slug.',
                ' */',
                'export function slugify(input: string): string {',
                "  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
                '}',
              ].join('\n'),
            },
          },
        ],
      },
      { text: 'Added exported `slugify(input: string): string` with JSDoc to `src/strings.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/strings.ts"}}',
      '{"action":"plan","content":"Add slugify with JSDoc."}',
      // Unescaped regex backslashes & literal newlines in raw JSON-in-text break JSON.parse 3 times
      '{"action":"tool","tool":"edit","input":{"path":"src/strings.ts","oldString":"export function trimSlashes","newString":"/**\n * Slugify\n */\nexport function slugify(s: string) { return s.replace(/[^a-z0-9]+/g, \'-\'); }\nexport function trimSlashes"}}',
      '{"action":"tool","tool":"edit","input":{"path":"src/strings.ts","oldString":"return path.replace(/^\\/+|\\/+$/g, \'\');","newString":"return path.replace(/^\\/+|\\/+$/g, \'\');\n/** JSDoc */\nexport function slugify"}}',
      '{"action":"tool","tool":"write","input":{"path":"src/strings.ts","content":"/**\n * Slugify\n */\nexport function slugify(input: string): string {\n  return input;\n}"}}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/strings.ts');
      const ok =
        content.includes('/**') &&
        content.includes('export function slugify(input: string): string') &&
        content.includes('trimSlashes');
      return { passed: ok, reason: ok ? 'slugify + JSDoc added cleanly' : 'Missing slugify or JSDoc' };
    },
  },
  {
    id: 'ST-025',
    category: 'new_helper_function',
    title: 'Add chunkArray<T> helper + JSDoc to arrays.ts',
    prompt: 'Add an exported generic function chunkArray<T>(items: readonly T[], size: number): T[][] with JSDoc to src/arrays.ts.',
    initialFiles: {
      'src/arrays.ts': [
        'export function lastItem<T>(items: readonly T[]): T | undefined {',
        '  return items[items.length - 1];',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st025_r1', name: 'read', input: { path: 'src/arrays.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st025_e1',
            name: 'edit',
            input: {
              path: 'src/arrays.ts',
              oldString: 'export function lastItem<T>(items: readonly T[]): T | undefined {\n  return items[items.length - 1];\n}',
              newString: [
                'export function lastItem<T>(items: readonly T[]): T | undefined {',
                '  return items[items.length - 1];',
                '}',
                '',
                '/**',
                ' * Splits `items` into contiguous chunks of length at most `size`.',
                ' */',
                'export function chunkArray<T>(items: readonly T[], size: number): T[][] {',
                '  if (size <= 0) throw new RangeError("size must be positive");',
                '  const chunks: T[][] = [];',
                '  for (let i = 0; i < items.length; i += size) {',
                '    chunks.push(items.slice(i, i + size));',
                '  }',
                '  return chunks;',
                '}',
              ].join('\n'),
            },
          },
        ],
      },
      { text: 'Added `chunkArray<T>` with JSDoc and positive-size guard to `src/arrays.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/arrays.ts"}}',
      '{"action":"plan","content":"Append chunkArray with JSDoc."}',
      '{"action":"tool","tool":"write","input":{"path":"src/arrays.ts","content":"export function lastItem<T>(items: readonly T[]): T | undefined {\\n  return items[items.length - 1];\\n}\\n\\n/**\\n * Splits items into chunks.\\n */\\nexport function chunkArray<T>(items: readonly T[], size: number): T[][] {\\n  const out: T[][] = [];\\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\\n  return out;\\n}\\n"}}',
      '{"action":"done","summary":"Added chunkArray."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/arrays.ts');
      const ok = content.includes('/**') && content.includes('export function chunkArray<T>') && content.includes('lastItem');
      return { passed: ok, reason: ok ? 'chunkArray + JSDoc verified' : 'Missing chunkArray or JSDoc' };
    },
  },
  {
    id: 'ST-026',
    category: 'new_helper_function',
    title: 'Add median helper + JSDoc to stats.ts',
    prompt: 'Add an exported function median(values: readonly number[]): number with JSDoc to src/stats.ts.',
    initialFiles: {
      'src/stats.ts': [
        'export function mean(values: readonly number[]): number {',
        '  if (values.length === 0) return 0;',
        '  return values.reduce((a, b) => a + b, 0) / values.length;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st026_r1', name: 'read', input: { path: 'src/stats.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st026_e1',
            name: 'edit',
            input: {
              path: 'src/stats.ts',
              oldString: '  return values.reduce((a, b) => a + b, 0) / values.length;\n}',
              newString: [
                '  return values.reduce((a, b) => a + b, 0) / values.length;',
                '}',
                '',
                '/**',
                ' * Computes the statistical median of a numeric array without mutating the input.',
                ' */',
                'export function median(values: readonly number[]): number {',
                '  if (values.length === 0) return 0;',
                '  const sorted = [...values].sort((a, b) => a - b);',
                '  const mid = Math.floor(sorted.length / 2);',
                '  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];',
                '}',
              ].join('\n'),
            },
          },
        ],
      },
      { text: 'Added exported `median` function with JSDoc to `src/stats.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/stats.ts"}}',
      '{"action":"plan","content":"Add median function."}',
      '{"action":"tool","tool":"write","input":{"path":"src/stats.ts","content":"export function mean(values: readonly number[]): number {\\n  if (values.length === 0) return 0;\\n  return values.reduce((a, b) => a + b, 0) / values.length;\\n}\\n/**\\n * Computes median.\\n */\\nexport function median(values: readonly number[]): number {\\n  const s = [...values].sort((a, b) => a - b);\\n  const m = Math.floor(s.length / 2);\\n  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];\\n}\\n"}}',
      '{"action":"done","summary":"Added median."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/stats.ts');
      const ok = content.includes('/**') && content.includes('export function median(values: readonly number[]): number') && content.includes('mean');
      return { passed: ok, reason: ok ? 'median + JSDoc verified' : 'Missing median or JSDoc' };
    },
  },
  {
    id: 'ST-027',
    category: 'new_helper_function',
    title: 'Add capitalizeWords helper + JSDoc to textCase.ts',
    prompt: 'Add an exported function capitalizeWords(text: string): string with JSDoc to src/textCase.ts.',
    initialFiles: {
      'src/textCase.ts': [
        'export function lowerFirst(text: string): string {',
        '  return text ? text[0].toLowerCase() + text.slice(1) : text;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st027_r1', name: 'read', input: { path: 'src/textCase.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st027_e1',
            name: 'edit',
            input: {
              path: 'src/textCase.ts',
              oldString: 'export function lowerFirst(text: string): string {\n  return text ? text[0].toLowerCase() + text.slice(1) : text;\n}',
              newString: [
                'export function lowerFirst(text: string): string {',
                '  return text ? text[0].toLowerCase() + text.slice(1) : text;',
                '}',
                '',
                '/**',
                ' * Uppercases the first character of every whitespace-delimited word.',
                ' */',
                'export function capitalizeWords(text: string): string {',
                "  return text.replace(/\\b[a-z]/g, (ch) => ch.toUpperCase());",
                '}',
              ].join('\n'),
            },
          },
        ],
      },
      { text: 'Added `capitalizeWords` with JSDoc to `src/textCase.ts`.' },
    ],
    legacyRawTurns: [
      // Raw JSON-in-text model emits single-backslash `\b` inside JSON string (interpreted as ASCII backspace 0x08 instead of regex word boundary!)
      '{"action":"tool","tool":"read","input":{"path":"src/textCase.ts"}}',
      '{"action":"plan","content":"Add capitalizeWords."}',
      '{"action":"tool","tool":"write","input":{"path":"src/textCase.ts","content":"export function lowerFirst(text: string): string { return text; }\\n/** JSDoc */\\nexport function capitalizeWords(text: string): string { return text.replace(/\\b[a-z]/g, (c) => c.toUpperCase()); }"}}',
      '{"action":"done","summary":"Added capitalizeWords."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/textCase.ts');
      // Must not corrupt regex `\b` into literal ASCII backspace `\x08`!
      const ok =
        content.includes('/**') &&
        content.includes('export function capitalizeWords(text: string): string') &&
        content.includes('\\b[a-z]') &&
        !content.includes('\x08');
      return { passed: ok, reason: ok ? 'capitalizeWords + intact regex verified' : 'Corrupted regex or missing JSDoc' };
    },
  },
  {
    id: 'ST-028',
    category: 'new_helper_function',
    title: 'Add pickKeys generic helper + JSDoc to objects.ts',
    prompt: 'Add an exported generic function pickKeys<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> with JSDoc to src/objects.ts.',
    initialFiles: {
      'src/objects.ts': [
        'export function hasOwn(obj: object, key: PropertyKey): boolean {',
        '  return Object.prototype.hasOwnProperty.call(obj, key);',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st028_r1', name: 'read', input: { path: 'src/objects.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st028_e1',
            name: 'edit',
            input: {
              path: 'src/objects.ts',
              oldString: 'export function hasOwn(obj: object, key: PropertyKey): boolean {\n  return Object.prototype.hasOwnProperty.call(obj, key);\n}',
              newString: [
                'export function hasOwn(obj: object, key: PropertyKey): boolean {',
                '  return Object.prototype.hasOwnProperty.call(obj, key);',
                '}',
                '',
                '/**',
                ' * Returns a shallow copy containing only the specified `keys` present on `obj`.',
                ' */',
                'export function pickKeys<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {',
                '  const out = {} as Pick<T, K>;',
                '  for (const key of keys) {',
                '    if (hasOwn(obj, key)) out[key] = obj[key];',
                '  }',
                '  return out;',
                '}',
              ].join('\n'),
            },
          },
        ],
      },
      { text: 'Added `pickKeys` generic helper with JSDoc to `src/objects.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/objects.ts"}}',
      '{"action":"plan","content":"Add pickKeys."}',
      '{"action":"tool","tool":"write","input":{"path":"src/objects.ts","content":"export function hasOwn(obj: object, key: PropertyKey): boolean { return Object.prototype.hasOwnProperty.call(obj, key); }\\n/** Picks keys */\\nexport function pickKeys<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {\\n  const out = {} as Pick<T, K>;\\n  for (const k of keys) if (hasOwn(obj, k)) out[k] = obj[k];\\n  return out;\\n}\\n"}}',
      '{"action":"done","summary":"Added pickKeys."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/objects.ts');
      const ok = content.includes('/**') && content.includes('export function pickKeys<T extends object, K extends keyof T>');
      return { passed: ok, reason: ok ? 'pickKeys + JSDoc verified' : 'Missing pickKeys or JSDoc' };
    },
  },
  {
    id: 'ST-029',
    category: 'new_helper_function',
    title: 'Add formatBytes helper + JSDoc to units.ts',
    prompt: 'Add an exported function formatBytes(bytes: number): string with JSDoc to src/units.ts.',
    initialFiles: {
      'src/units.ts': [
        'export const BYTES_PER_KIB = 1024;',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st029_r1', name: 'read', input: { path: 'src/units.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st029_e1',
            name: 'edit',
            input: {
              path: 'src/units.ts',
              oldString: 'export const BYTES_PER_KIB = 1024;',
              newString: [
                'export const BYTES_PER_KIB = 1024;',
                '',
                '/**',
                ' * Formats a byte count into a human-readable IEC unit string (B, KiB, MiB, GiB).',
                ' */',
                'export function formatBytes(bytes: number): string {',
                "  if (bytes < BYTES_PER_KIB) return `${bytes} B`;",
                "  const units = ['KiB', 'MiB', 'GiB'];",
                '  let val = bytes / BYTES_PER_KIB;',
                '  let idx = 0;',
                '  while (val >= BYTES_PER_KIB && idx < units.length - 1) {',
                '    val /= BYTES_PER_KIB;',
                '    idx += 1;',
                '  }',
                '  return `${val.toFixed(1)} ${units[idx]}`;',
                '}',
              ].join('\n'),
            },
          },
        ],
      },
      { text: 'Added `formatBytes` with JSDoc to `src/units.ts`.' },
    ],
    legacyRawTurns: [
      // Raw JSON-in-text unescaped template backticks + multiline JSDoc jitter fails 3 times
      'I will add `{ formatBytes }`:\n```json\n{"action":"tool","tool":"edit","input":{"path":"src/units.ts","oldString":"export const BYTES_PER_KIB = 1024;","newString":"export const BYTES_PER_KIB = 1024;\n/**\n * Formats bytes\n */\nexport function formatBytes(bytes: number): string { return `${bytes} B`; }"}}\n```',
      '{"action":"tool","tool":"edit","input":{"path":"src/units.ts","oldString":"export const BYTES_PER_KIB = 1024;","newString":"export const BYTES_PER_KIB = 1024;\n/** JSDoc */\nexport function formatBytes(bytes: number): string {\n  return `${bytes} B`;\n}"}}',
      '{"action":"tool","tool":"write","input":{"path":"src/units.ts","content":"export const BYTES_PER_KIB = 1024;\nexport function formatBytes(bytes: number): string {\n  return `${bytes} B`;\n}"}}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/units.ts');
      const ok = content.includes('/**') && content.includes('export function formatBytes(bytes: number): string');
      return { passed: ok, reason: ok ? 'formatBytes + JSDoc verified' : 'Missing formatBytes or JSDoc' };
    },
  },
  {
    id: 'ST-030',
    category: 'new_helper_function',
    title: 'Add isPalindrome helper + JSDoc to palindromes.ts',
    prompt: 'Add an exported function isPalindrome(input: string): boolean with JSDoc to src/palindromes.ts.',
    initialFiles: {
      'src/palindromes.ts': [
        'export function normalizeAlphaNum(input: string): string {',
        "  return input.toLowerCase().replace(/[^a-z0-9]/g, '');",
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st030_r1', name: 'read', input: { path: 'src/palindromes.ts' } }] },
      {
        toolCalls: [
          {
            id: 'st030_e1',
            name: 'edit',
            input: {
              path: 'src/palindromes.ts',
              oldString: "export function normalizeAlphaNum(input: string): string {\n  return input.toLowerCase().replace(/[^a-z0-9]/g, '');\n}",
              newString: [
                'export function normalizeAlphaNum(input: string): string {',
                "  return input.toLowerCase().replace(/[^a-z0-9]/g, '');",
                '}',
                '',
                '/**',
                ' * Checks whether `input` reads identically forward and backward (case/punctuation-insensitive).',
                ' */',
                'export function isPalindrome(input: string): boolean {',
                '  const clean = normalizeAlphaNum(input);',
                "  return clean === [...clean].reverse().join('');",
                '}',
              ].join('\n'),
            },
          },
        ],
      },
      { text: 'Added exported `isPalindrome` with JSDoc to `src/palindromes.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/palindromes.ts"}}',
      '{"action":"plan","content":"Add isPalindrome."}',
      '{"action":"tool","tool":"write","input":{"path":"src/palindromes.ts","content":"export function normalizeAlphaNum(input: string): string {\\n  return input.toLowerCase().replace(/[^a-z0-9]/g, \'\');\\n}\\n/** Checks palindrome */\\nexport function isPalindrome(input: string): boolean {\\n  const c = normalizeAlphaNum(input);\\n  return c === [...c].reverse().join(\'\');\\n}\\n"}}',
      '{"action":"done","summary":"Added isPalindrome."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/palindromes.ts');
      const ok = content.includes('/**') && content.includes('export function isPalindrome(input: string): boolean');
      return { passed: ok, reason: ok ? 'isPalindrome + JSDoc verified' : 'Missing isPalindrome or JSDoc' };
    },
  },
];

// ============================================================================
// Category 5: Config / JSON / Package Edit (`ST-031` .. `ST-037`, 7 tasks)
// ============================================================================
const CONFIG_JSON_TASKS: SimpleBenchmarkTask[] = [
  {
    id: 'ST-031',
    category: 'config_json_edit',
    title: 'Enable noImplicitOverride and noFallthroughCasesInSwitch in tsconfig.json',
    prompt: 'Update tsconfig.json to add "noImplicitOverride": true and "noFallthroughCasesInSwitch": true inside compilerOptions while preserving valid JSON.',
    initialFiles: {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            strict: true,
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ) + '\n',
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st031_r1', name: 'read', input: { path: 'tsconfig.json' } }] },
      {
        toolCalls: [
          {
            id: 'st031_e1',
            name: 'edit',
            input: {
              path: 'tsconfig.json',
              oldString: '    "strict": true\n  },',
              newString: '    "strict": true,\n    "noImplicitOverride": true,\n    "noFallthroughCasesInSwitch": true\n  },',
            },
          },
        ],
      },
      { text: 'Enabled `noImplicitOverride` and `noFallthroughCasesInSwitch` in `tsconfig.json`.' },
    ],
    legacyRawTurns: [
      // Nested double-quotes inside raw JSON-in-text break small-model JSON serialization!
      '{"action":"tool","tool":"read","input":{"path":"tsconfig.json"}}',
      '{"action":"plan","content":"Update compilerOptions in tsconfig.json."}',
      '{"action":"tool","tool":"edit","input":{"path":"tsconfig.json","oldString":"  "strict": true","newString":"  "strict": true, "noImplicitOverride": true"}}',
      '{"action":"tool","tool":"edit","input":{"path":"tsconfig.json","oldString":"    "strict": true","newString":"    "strict": true,\n    "noImplicitOverride": true"}}',
      '{"action":"tool","tool":"write","input":{"path":"tsconfig.json","content":"{"compilerOptions":{"strict":true}}"}}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      try {
        const parsed = JSON.parse(readWorkspaceFile(workspaceRoot, 'tsconfig.json'));
        const ok =
          parsed.compilerOptions?.strict === true &&
          parsed.compilerOptions?.noImplicitOverride === true &&
          parsed.compilerOptions?.noFallthroughCasesInSwitch === true &&
          Array.isArray(parsed.include);
        return { passed: ok, reason: ok ? 'Valid tsconfig.json with flags' : 'Missing flags in tsconfig.json' };
      } catch (e) {
        return { passed: false, reason: `Invalid JSON: ${String(e)}` };
      }
    },
  },
  {
    id: 'ST-032',
    category: 'config_json_edit',
    title: 'Add typecheck and bench scripts to package.json',
    prompt: 'Update package.json to add "typecheck": "tsc --noEmit" and "bench": "vitest bench" under scripts.',
    initialFiles: {
      'package.json': JSON.stringify(
        {
          name: '@acme/widget',
          version: '1.2.0',
          scripts: {
            test: 'vitest run',
          },
        },
        null,
        2,
      ) + '\n',
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st032_r1', name: 'read', input: { path: 'package.json' } }] },
      {
        toolCalls: [
          {
            id: 'st032_e1',
            name: 'edit',
            input: {
              path: 'package.json',
              oldString: '    "test": "vitest run"\n  }',
              newString: '    "test": "vitest run",\n    "typecheck": "tsc --noEmit",\n    "bench": "vitest bench"\n  }',
            },
          },
        ],
      },
      { text: 'Added `typecheck` and `bench` scripts to `package.json`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"package.json"}}',
      '{"action":"plan","content":"Add typecheck and bench scripts."}',
      '{"action":"tool","tool":"edit","input":{"path":"package.json","oldString":"    \\"test\\": \\"vitest run\\"\\n  }","newString":"    \\"test\\": \\"vitest run\\",\\n    \\"typecheck\\": \\"tsc --noEmit\\",\\n    \\"bench\\": \\"vitest bench\\"\\n  }"}}',
      '{"action":"done","summary":"Updated package.json scripts."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      try {
        const pkg = JSON.parse(readWorkspaceFile(workspaceRoot, 'package.json'));
        const ok =
          pkg.name === '@acme/widget' &&
          pkg.scripts?.test === 'vitest run' &&
          pkg.scripts?.typecheck === 'tsc --noEmit' &&
          pkg.scripts?.bench === 'vitest bench';
        return { passed: ok, reason: ok ? 'package.json scripts valid' : 'Missing scripts' };
      } catch (e) {
        return { passed: false, reason: `Invalid JSON: ${String(e)}` };
      }
    },
  },
  {
    id: 'ST-033',
    category: 'config_json_edit',
    title: 'Append REDIS_URL and CACHE_TTL_SECONDS to config/.env.example',
    prompt: 'Update config/.env.example to add REDIS_URL=redis://localhost:6379 and CACHE_TTL_SECONDS=300 while keeping existing variables intact.',
    initialFiles: {
      'config/.env.example': 'NODE_ENV=development\nPORT=3000\n',
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st033_r1', name: 'read', input: { path: 'config/.env.example' } }] },
      {
        toolCalls: [
          {
            id: 'st033_e1',
            name: 'edit',
            input: {
              path: 'config/.env.example',
              oldString: 'NODE_ENV=development\nPORT=3000',
              newString: 'NODE_ENV=development\nPORT=3000\nREDIS_URL=redis://localhost:6379\nCACHE_TTL_SECONDS=300',
            },
          },
        ],
      },
      { text: 'Added `REDIS_URL` and `CACHE_TTL_SECONDS` to `config/.env.example`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"config/.env.example"}}',
      '{"action":"plan","content":"Append env vars."}',
      '{"action":"tool","tool":"write","input":{"path":"config/.env.example","content":"NODE_ENV=development\\nPORT=3000\\nREDIS_URL=redis://localhost:6379\\nCACHE_TTL_SECONDS=300\\n"}}',
      '{"action":"done","summary":"Updated config/.env.example."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const env = readWorkspaceFile(workspaceRoot, 'config/.env.example');
      const ok =
        env.includes('NODE_ENV=development') &&
        env.includes('PORT=3000') &&
        env.includes('REDIS_URL=redis://localhost:6379') &&
        env.includes('CACHE_TTL_SECONDS=300');
      return { passed: ok, reason: ok ? 'config/.env.example updated' : 'Missing env entries' };
    },
  },
  {
    id: 'ST-034',
    category: 'config_json_edit',
    title: 'Add engines.node and sideEffects: false to package.json',
    prompt: 'Update package.json to set "sideEffects": false and "engines": { "node": ">=22.0.0" }.',
    initialFiles: {
      'package.json': JSON.stringify(
        {
          name: '@acme/core-utils',
          version: '0.4.1',
          type: 'module',
        },
        null,
        2,
      ) + '\n',
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st034_r1', name: 'read', input: { path: 'package.json' } }] },
      {
        toolCalls: [
          {
            id: 'st034_e1',
            name: 'edit',
            input: {
              path: 'package.json',
              oldString: '  "type": "module"\n}',
              newString: '  "type": "module",\n  "sideEffects": false,\n  "engines": {\n    "node": ">=22.0.0"\n  }\n}',
            },
          },
        ],
      },
      { text: 'Added `"sideEffects": false` and `"engines": { "node": ">=22.0.0" }` to `package.json`.' },
    ],
    legacyRawTurns: [
      // Nested JSON object inside JSON-in-text unescaped quotes failure
      '{"action":"tool","tool":"read","input":{"path":"package.json"}}',
      '{"action":"plan","content":"Add sideEffects and engines."}',
      '{"action":"tool","tool":"write","input":{"path":"package.json","content":"{"name":"@acme/core-utils","sideEffects":false,"engines":{"node":">=22.0.0"}}"}}',
      '{"action":"tool","tool":"edit","input":{"path":"package.json","oldString":""type": "module"","newString":""type": "module", "sideEffects": false"}}',
      '{"action":"tool","tool":"write","input":{"path":"package.json","content":"{\n  "name": "@acme/core-utils"\n}"}}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      try {
        const pkg = JSON.parse(readWorkspaceFile(workspaceRoot, 'package.json'));
        const ok = pkg.type === 'module' && pkg.sideEffects === false && pkg.engines?.node === '>=22.0.0';
        return { passed: ok, reason: ok ? 'engines & sideEffects valid' : 'Missing fields' };
      } catch (e) {
        return { passed: false, reason: `Invalid JSON: ${String(e)}` };
      }
    },
  },
  {
    id: 'ST-035',
    category: 'config_json_edit',
    title: 'Update prettier.config.json formatting options',
    prompt: 'Update prettier.config.json so singleQuote is true, printWidth is 100, and trailingComma is "all".',
    initialFiles: {
      'prettier.config.json': JSON.stringify(
        {
          singleQuote: false,
          printWidth: 80,
          trailingComma: 'es5',
        },
        null,
        2,
      ) + '\n',
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st035_r1', name: 'read', input: { path: 'prettier.config.json' } }] },
      {
        toolCalls: [
          {
            id: 'st035_e1',
            name: 'edit',
            input: {
              path: 'prettier.config.json',
              oldString: '  "singleQuote": false,\n  "printWidth": 80,\n  "trailingComma": "es5"',
              newString: '  "singleQuote": true,\n  "printWidth": 100,\n  "trailingComma": "all"',
            },
          },
        ],
      },
      { text: 'Updated `prettier.config.json` with `singleQuote: true`, `printWidth: 100`, and `trailingComma: "all"`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"prettier.config.json"}}',
      '{"action":"plan","content":"Update prettier.config.json."}',
      '{"action":"tool","tool":"write","input":{"path":"prettier.config.json","content":"{\\n  \\"singleQuote\\": true,\\n  \\"printWidth\\": 100,\\n  \\"trailingComma\\": \\"all\\"\\n}\\n"}}',
      '{"action":"done","summary":"Updated prettier.config.json."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      try {
        const cfg = JSON.parse(readWorkspaceFile(workspaceRoot, 'prettier.config.json'));
        const ok = cfg.singleQuote === true && cfg.printWidth === 100 && cfg.trailingComma === 'all';
        return { passed: ok, reason: ok ? 'Prettier config valid' : 'Wrong prettier values' };
      } catch (e) {
        return { passed: false, reason: `Invalid JSON: ${String(e)}` };
      }
    },
  },
  {
    id: 'ST-036',
    category: 'config_json_edit',
    title: 'Exclude test and spec files in tsconfig.build.json',
    prompt: 'Update tsconfig.build.json so exclude includes "**/*.test.ts" and "**/*.spec.ts" in addition to "dist".',
    initialFiles: {
      'tsconfig.build.json': JSON.stringify(
        {
          extends: './tsconfig.json',
          compilerOptions: { noEmit: false, outDir: 'dist' },
          exclude: ['dist'],
        },
        null,
        2,
      ) + '\n',
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st036_r1', name: 'read', input: { path: 'tsconfig.build.json' } }] },
      {
        toolCalls: [
          {
            id: 'st036_e1',
            name: 'edit',
            input: {
              path: 'tsconfig.build.json',
              oldString: '  "exclude": [\n    "dist"\n  ]',
              newString: '  "exclude": [\n    "dist",\n    "**/*.test.ts",\n    "**/*.spec.ts"\n  ]',
            },
          },
        ],
      },
      { text: 'Added `"**/*.test.ts"` and `"**/*.spec.ts"` to `exclude` in `tsconfig.build.json`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"tsconfig.build.json"}}',
      '{"action":"plan","content":"Update exclude array."}',
      '{"action":"tool","tool":"write","input":{"path":"tsconfig.build.json","content":"{\\n  \\"extends\\": \\"./tsconfig.json\\",\\n  \\"compilerOptions\\": { \\"noEmit\\": false, \\"outDir\\": \\"dist\\" },\\n  \\"exclude\\": [\\"dist\\", \\"**/*.test.ts\\", \\"**/*.spec.ts\\"]\\n}\\n"}}',
      '{"action":"done","summary":"Updated tsconfig.build.json."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      try {
        const cfg = JSON.parse(readWorkspaceFile(workspaceRoot, 'tsconfig.build.json'));
        const ex: unknown[] = cfg.exclude ?? [];
        const ok =
          cfg.extends === './tsconfig.json' &&
          ex.includes('dist') &&
          ex.includes('**/*.test.ts') &&
          ex.includes('**/*.spec.ts');
        return { passed: ok, reason: ok ? 'Exclude patterns verified' : 'Missing exclude globs' };
      } catch (e) {
        return { passed: false, reason: `Invalid JSON: ${String(e)}` };
      }
    },
  },
  {
    id: 'ST-037',
    category: 'config_json_edit',
    title: 'Update burstLimit and retryAfterHeader in config/rate-limits.json',
    prompt: 'Edit config/rate-limits.json to raise burstLimit from 20 to 50 and add "retryAfterHeader": true.',
    initialFiles: {
      'config/rate-limits.json': JSON.stringify(
        {
          windowSeconds: 60,
          burstLimit: 20,
        },
        null,
        2,
      ) + '\n',
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st037_r1', name: 'read', input: { path: 'config/rate-limits.json' } }] },
      {
        toolCalls: [
          {
            id: 'st037_e1',
            name: 'edit',
            input: {
              path: 'config/rate-limits.json',
              oldString: '  "windowSeconds": 60,\n  "burstLimit": 20',
              newString: '  "windowSeconds": 60,\n  "burstLimit": 50,\n  "retryAfterHeader": true',
            },
          },
        ],
      },
      { text: 'Updated `burstLimit` to `50` and added `"retryAfterHeader": true` in `config/rate-limits.json`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"config/rate-limits.json"}}',
      '{"action":"plan","content":"Update rate-limits.json."}',
      // Trailing comma JSON syntax mistake inside written JSON file!
      '{"action":"tool","tool":"write","input":{"path":"config/rate-limits.json","content":"{\\n  \\"windowSeconds\\": 60,\\n  \\"burstLimit\\": 50,\\n  \\"retryAfterHeader\\": true,\\n}"}}',
      '{"action":"done","summary":"Updated rate-limits.json."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      try {
        const cfg = JSON.parse(readWorkspaceFile(workspaceRoot, 'config/rate-limits.json'));
        const ok = cfg.windowSeconds === 60 && cfg.burstLimit === 50 && cfg.retryAfterHeader === true;
        return { passed: ok, reason: ok ? 'rate-limits.json valid' : 'Wrong values' };
      } catch (e) {
        return { passed: false, reason: `Invalid JSON written: ${String(e)}` };
      }
    },
  },
];

// ============================================================================
// Category 6: Multi-File Read + Edit (`ST-038` .. `ST-044`, 7 tasks)
// ============================================================================
const MULTI_FILE_TASKS: SimpleBenchmarkTask[] = [
  {
    id: 'ST-038',
    category: 'multi_file_read_edit',
    title: 'Thread countryCode parameter across taxRate.ts and checkout.ts',
    prompt: 'Inspect src/taxRate.ts and src/checkout.ts, add countryCode: string to getTaxRate (returning 0.2 for "GB" and 0.08 otherwise), and pass order.countryCode in computeCheckoutTotal.',
    initialFiles: {
      'src/taxRate.ts': [
        'export function getTaxRate(): number {',
        '  return 0.08;',
        '}',
        '',
      ].join('\n'),
      'src/checkout.ts': [
        "import { getTaxRate } from './taxRate.js';",
        'export function computeCheckoutTotal(order: { subtotal: number; countryCode: string }): number {',
        '  return order.subtotal * (1 + getTaxRate());',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      {
        toolCalls: [
          { id: 'st038_rm1', name: 'read_many_files', input: { paths: ['src/taxRate.ts', 'src/checkout.ts'] } },
        ],
      },
      {
        toolCalls: [
          {
            id: 'st038_e1',
            name: 'edit',
            input: {
              path: 'src/taxRate.ts',
              oldString: 'export function getTaxRate(): number {\n  return 0.08;\n}',
              newString: 'export function getTaxRate(countryCode: string): number {\n  return countryCode === "GB" ? 0.2 : 0.08;\n}',
            },
          },
          {
            id: 'st038_e2',
            name: 'edit',
            input: {
              path: 'src/checkout.ts',
              oldString: '  return order.subtotal * (1 + getTaxRate());',
              newString: '  return order.subtotal * (1 + getTaxRate(order.countryCode));',
            },
          },
        ],
      },
      { text: 'Added `countryCode` parameter to `getTaxRate` and updated `computeCheckoutTotal` in `src/checkout.ts`.' },
    ],
    legacyRawTurns: [
      // Legacy lacks read_many_files; tries calling read_many_files -> rejected -> falls back to sequential reads + edits
      '{"action":"tool","tool":"read_many_files","input":{"paths":["src/taxRate.ts","src/checkout.ts"]}}',
      '{"action":"tool","tool":"read","input":{"path":"src/taxRate.ts"}}',
      '{"action":"tool","tool":"read","input":{"path":"src/checkout.ts"}}',
      '{"action":"plan","content":"Update taxRate.ts and checkout.ts sequentially."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/taxRate.ts","oldString":"export function getTaxRate(): number {\\n  return 0.08;\\n}","newString":"export function getTaxRate(countryCode: string): number {\\n  return countryCode === \\"GB\\" ? 0.2 : 0.08;\\n}"}}',
      '{"action":"tool","tool":"edit","input":{"path":"src/checkout.ts","oldString":"  return order.subtotal * (1 + getTaxRate());","newString":"  return order.subtotal * (1 + getTaxRate(order.countryCode));"}}',
      '{"action":"done","summary":"Updated both files."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const callee = readWorkspaceFile(workspaceRoot, 'src/taxRate.ts');
      const caller = readWorkspaceFile(workspaceRoot, 'src/checkout.ts');
      const ok = callee.includes('getTaxRate(countryCode: string)') && callee.includes('0.2') && caller.includes('getTaxRate(order.countryCode)');
      return { passed: ok, reason: ok ? 'Caller & callee updated' : 'Mismatch across files' };
    },
  },
  {
    id: 'ST-039',
    category: 'multi_file_read_edit',
    title: 'Add fatal LogLevel across types.ts, logger.ts, and audit.ts',
    prompt: 'Read src/types.ts, src/logger.ts, and src/audit.ts; add "fatal" to LogLevel, map "fatal" to weight 40 in levelWeight, and return true for "fatal" in shouldAlertOps.',
    initialFiles: {
      'src/types.ts': "export type LogLevel = 'info' | 'warn' | 'error';\n",
      'src/logger.ts': [
        "import type { LogLevel } from './types.js';",
        'export function levelWeight(level: LogLevel): number {',
        "  if (level === 'error') return 30;",
        "  if (level === 'warn') return 20;",
        '  return 10;',
        '}',
        '',
      ].join('\n'),
      'src/audit.ts': [
        "import type { LogLevel } from './types.js';",
        'export function shouldAlertOps(level: LogLevel): boolean {',
        "  return level === 'error';",
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      {
        toolCalls: [
          { id: 'st039_rm1', name: 'read_many_files', input: { paths: ['src/types.ts', 'src/logger.ts', 'src/audit.ts'] } },
        ],
      },
      {
        toolCalls: [
          {
            id: 'st039_e1',
            name: 'edit',
            input: {
              path: 'src/types.ts',
              oldString: "export type LogLevel = 'info' | 'warn' | 'error';",
              newString: "export type LogLevel = 'info' | 'warn' | 'error' | 'fatal';",
            },
          },
          {
            id: 'st039_e2',
            name: 'edit',
            input: {
              path: 'src/logger.ts',
              oldString: "  if (level === 'error') return 30;",
              newString: "  if (level === 'fatal') return 40;\n  if (level === 'error') return 30;",
            },
          },
          {
            id: 'st039_e3',
            name: 'edit',
            input: {
              path: 'src/audit.ts',
              oldString: "  return level === 'error';",
              newString: "  return level === 'error' || level === 'fatal';",
            },
          },
        ],
      },
      { text: 'Added `"fatal"` to `LogLevel` across `types.ts`, `logger.ts`, and `audit.ts`.' },
    ],
    legacyRawTurns: [
      // Legacy model tries read_many_files 3 times -> MODEL_PROTOCOL_BUDGET_EXHAUSTED!
      '{"action":"tool","tool":"read_many_files","input":{"paths":["src/types.ts","src/logger.ts","src/audit.ts"]}}',
      '{"action":"tool","tool":"read_files","input":{"paths":["src/types.ts","src/logger.ts"]}}',
      '{"action":"tool","tool":"batch_read","input":{"files":["src/types.ts"]}}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const t = readWorkspaceFile(workspaceRoot, 'src/types.ts');
      const l = readWorkspaceFile(workspaceRoot, 'src/logger.ts');
      const a = readWorkspaceFile(workspaceRoot, 'src/audit.ts');
      const ok = t.includes("'fatal'") && l.includes("if (level === 'fatal') return 40;") && a.includes("level === 'fatal'");
      return { passed: ok, reason: ok ? '3-file LogLevel update verified' : 'Incomplete multi-file update' };
    },
  },
  {
    id: 'ST-040',
    category: 'multi_file_read_edit',
    title: 'Include algorithm metadata in computeDigest and tokenVerifier',
    prompt: 'Inspect src/hash.ts and src/tokenVerifier.ts; update computeDigest to return { algorithm: "sha256", hex } and update verifyDigestHeader to check digest.algorithm === "sha256".',
    initialFiles: {
      'src/hash.ts': [
        'export function computeDigest(payload: string): { hex: string } {',
        '  return { hex: `h_${payload.length}` };',
        '}',
        '',
      ].join('\n'),
      'src/tokenVerifier.ts': [
        "import { computeDigest } from './hash.js';",
        'export function verifyDigestHeader(payload: string, expectedHex: string): boolean {',
        '  const digest = computeDigest(payload);',
        '  return digest.hex === expectedHex;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      {
        toolCalls: [
          { id: 'st040_rm1', name: 'read_many_files', input: { paths: ['src/hash.ts', 'src/tokenVerifier.ts'] } },
        ],
      },
      {
        toolCalls: [
          {
            id: 'st040_e1',
            name: 'edit',
            input: {
              path: 'src/hash.ts',
              oldString: 'export function computeDigest(payload: string): { hex: string } {\n  return { hex: `h_${payload.length}` };\n}',
              newString: "export function computeDigest(payload: string): { algorithm: 'sha256'; hex: string } {\n  return { algorithm: 'sha256', hex: `h_${payload.length}` };\n}",
            },
          },
          {
            id: 'st040_e2',
            name: 'edit',
            input: {
              path: 'src/tokenVerifier.ts',
              oldString: '  return digest.hex === expectedHex;',
              newString: "  return digest.algorithm === 'sha256' && digest.hex === expectedHex;",
            },
          },
        ],
      },
      { text: 'Updated `computeDigest` and `verifyDigestHeader` across `src/hash.ts` and `src/tokenVerifier.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/hash.ts"}}',
      '{"action":"tool","tool":"read","input":{"path":"src/tokenVerifier.ts"}}',
      '{"action":"plan","content":"Update hash.ts and tokenVerifier.ts."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/hash.ts","oldString":"export function computeDigest(payload: string): { hex: string } {\\n  return { hex: `h_${payload.length}` };\\n}","newString":"export function computeDigest(payload: string): { algorithm: \'sha256\'; hex: string } {\\n  return { algorithm: \'sha256\', hex: `h_${payload.length}` };\\n}"}}',
      '{"action":"tool","tool":"edit","input":{"path":"src/tokenVerifier.ts","oldString":"  return digest.hex === expectedHex;","newString":"  return digest.algorithm === \'sha256\' && digest.hex === expectedHex;"}}',
      '{"action":"done","summary":"Updated digest return shape and verifier."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const h = readWorkspaceFile(workspaceRoot, 'src/hash.ts');
      const v = readWorkspaceFile(workspaceRoot, 'src/tokenVerifier.ts');
      const ok = h.includes('algorithm') && h.includes('sha256') && v.includes("digest.algorithm === 'sha256'");
      return { passed: ok, reason: ok ? 'Digest + verifier coordinated' : 'Mismatch' };
    },
  },
  {
    id: 'ST-041',
    category: 'multi_file_read_edit',
    title: 'Thread optional requestId into AppError across errors.ts and router.ts',
    prompt: 'Inspect src/errors.ts and src/router.ts; add optional readonly requestId?: string parameter to AppError and pass req.id in handleNotFound.',
    initialFiles: {
      'src/errors.ts': [
        'export class AppError extends Error {',
        '  constructor(message: string, readonly statusCode: number) {',
        '    super(message);',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/router.ts': [
        "import { AppError } from './errors.js';",
        'export function handleNotFound(req: { id: string; path: string }): AppError {',
        '  return new AppError(`No route: ${req.path}`, 404);',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      {
        toolCalls: [
          { id: 'st041_rm1', name: 'read_many_files', input: { paths: ['src/errors.ts', 'src/router.ts'] } },
        ],
      },
      {
        toolCalls: [
          {
            id: 'st041_e1',
            name: 'edit',
            input: {
              path: 'src/errors.ts',
              oldString: '  constructor(message: string, readonly statusCode: number) {',
              newString: '  constructor(message: string, readonly statusCode: number, readonly requestId?: string) {',
            },
          },
          {
            id: 'st041_e2',
            name: 'edit',
            input: {
              path: 'src/router.ts',
              oldString: '  return new AppError(`No route: ${req.path}`, 404);',
              newString: '  return new AppError(`No route: ${req.path}`, 404, req.id);',
            },
          },
        ],
      },
      { text: 'Added `requestId?: string` to `AppError` and passed `req.id` in `handleNotFound`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/errors.ts"}}',
      '{"action":"tool","tool":"read","input":{"path":"src/router.ts"}}',
      '{"action":"plan","content":"Update AppError and router.ts."}',
      // Forgets second file edit before declaring done!
      '{"action":"tool","tool":"edit","input":{"path":"src/errors.ts","oldString":"  constructor(message: string, readonly statusCode: number) {","newString":"  constructor(message: string, readonly statusCode: number, readonly requestId?: string) {"}}',
      '{"action":"done","summary":"Updated AppError."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const e = readWorkspaceFile(workspaceRoot, 'src/errors.ts');
      const r = readWorkspaceFile(workspaceRoot, 'src/router.ts');
      const ok = e.includes('requestId?: string') && r.includes('404, req.id');
      return { passed: ok, reason: ok ? 'Both AppError and router updated' : 'Caller router.ts not updated' };
    },
  },
  {
    id: 'ST-042',
    category: 'multi_file_read_edit',
    title: 'Rename MIN_PASSWORD_LEN -> MIN_PASSWORD_LENGTH = 12 across 3 files',
    prompt: 'Inspect src/constants.ts, src/validator.ts, and src/form.ts; rename MIN_PASSWORD_LEN to MIN_PASSWORD_LENGTH and raise its value from 8 to 12 across all three files.',
    initialFiles: {
      'src/constants.ts': 'export const MIN_PASSWORD_LEN = 8;\n',
      'src/validator.ts': [
        "import { MIN_PASSWORD_LEN } from './constants.js';",
        'export function isValidPassword(pw: string): boolean {',
        '  return pw.length >= MIN_PASSWORD_LEN;',
        '}',
        '',
      ].join('\n'),
      'src/form.ts': [
        "import { MIN_PASSWORD_LEN } from './constants.js';",
        'export function passwordHint(): string {',
        '  return `At least ${MIN_PASSWORD_LEN} characters`;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      {
        toolCalls: [
          { id: 'st042_rm1', name: 'read_many_files', input: { paths: ['src/constants.ts', 'src/validator.ts', 'src/form.ts'] } },
        ],
      },
      {
        toolCalls: [
          {
            id: 'st042_e1',
            name: 'edit',
            input: { path: 'src/constants.ts', oldString: 'export const MIN_PASSWORD_LEN = 8;', newString: 'export const MIN_PASSWORD_LENGTH = 12;' },
          },
          {
            id: 'st042_e2',
            name: 'edit',
            input: { path: 'src/validator.ts', oldString: 'MIN_PASSWORD_LEN', newString: 'MIN_PASSWORD_LENGTH', replaceAll: true },
          },
          {
            id: 'st042_e3',
            name: 'edit',
            input: { path: 'src/form.ts', oldString: 'MIN_PASSWORD_LEN', newString: 'MIN_PASSWORD_LENGTH', replaceAll: true },
          },
        ],
      },
      { text: 'Renamed `MIN_PASSWORD_LEN` to `MIN_PASSWORD_LENGTH` (`12`) across `constants.ts`, `validator.ts`, and `form.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/constants.ts"}}',
      '{"action":"tool","tool":"read","input":{"path":"src/validator.ts"}}',
      '{"action":"tool","tool":"read","input":{"path":"src/form.ts"}}',
      '{"action":"plan","content":"Update all 3 files."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/constants.ts","oldString":"export const MIN_PASSWORD_LEN = 8;","newString":"export const MIN_PASSWORD_LENGTH = 12;"}}',
      '{"action":"tool","tool":"edit","input":{"path":"src/validator.ts","oldString":"MIN_PASSWORD_LEN","newString":"MIN_PASSWORD_LENGTH","replaceAll":true}}',
      '{"action":"tool","tool":"edit","input":{"path":"src/form.ts","oldString":"MIN_PASSWORD_LEN","newString":"MIN_PASSWORD_LENGTH","replaceAll":true}}',
      '{"action":"done","summary":"Updated all 3 files."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const c = readWorkspaceFile(workspaceRoot, 'src/constants.ts');
      const v = readWorkspaceFile(workspaceRoot, 'src/validator.ts');
      const f = readWorkspaceFile(workspaceRoot, 'src/form.ts');
      const ok =
        c.includes('MIN_PASSWORD_LENGTH = 12') &&
        !/\bMIN_PASSWORD_LEN\b/.test(c + v + f) &&
        v.includes('MIN_PASSWORD_LENGTH') &&
        f.includes('MIN_PASSWORD_LENGTH');
      return { passed: ok, reason: ok ? 'All 3 files updated cleanly' : 'Stale MIN_PASSWORD_LEN reference' };
    },
  },
  {
    id: 'ST-043',
    category: 'multi_file_read_edit',
    title: 'Export monotonicNowMs in clock.ts and adopt in scheduler.ts',
    prompt: 'Inspect src/clock.ts and src/scheduler.ts; export monotonicNowMs() using performance.now() in src/clock.ts and switch elapsedMs in src/scheduler.ts from Date.now() to monotonicNowMs().',
    initialFiles: {
      'src/clock.ts': [
        'export function wallClockIso(): string {',
        '  return new Date().toISOString();',
        '}',
        '',
      ].join('\n'),
      'src/scheduler.ts': [
        'export function elapsedMs(startedAtMs: number): number {',
        '  return Date.now() - startedAtMs;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      {
        toolCalls: [
          { id: 'st043_rm1', name: 'read_many_files', input: { paths: ['src/clock.ts', 'src/scheduler.ts'] } },
        ],
      },
      {
        toolCalls: [
          {
            id: 'st043_e1',
            name: 'edit',
            input: {
              path: 'src/clock.ts',
              oldString: 'export function wallClockIso(): string {\n  return new Date().toISOString();\n}',
              newString: 'export function wallClockIso(): string {\n  return new Date().toISOString();\n}\n\nexport function monotonicNowMs(): number {\n  return performance.now();\n}',
            },
          },
          {
            id: 'st043_e2',
            name: 'edit',
            input: {
              path: 'src/scheduler.ts',
              oldString: 'export function elapsedMs(startedAtMs: number): number {\n  return Date.now() - startedAtMs;\n}',
              newString: "import { monotonicNowMs } from './clock.js';\nexport function elapsedMs(startedAtMs: number): number {\n  return monotonicNowMs() - startedAtMs;\n}",
            },
          },
        ],
      },
      { text: 'Exported `monotonicNowMs` in `src/clock.ts` and updated `elapsedMs` in `src/scheduler.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/clock.ts"}}',
      '{"action":"tool","tool":"read","input":{"path":"src/scheduler.ts"}}',
      '{"action":"plan","content":"Add monotonicNowMs and use in scheduler.ts."}',
      '{"action":"tool","tool":"write","input":{"path":"src/clock.ts","content":"export function wallClockIso(): string { return new Date().toISOString(); }\\nexport function monotonicNowMs(): number { return performance.now(); }\\n"}}',
      '{"action":"tool","tool":"write","input":{"path":"src/scheduler.ts","content":"import { monotonicNowMs } from \'./clock.js\';\\nexport function elapsedMs(startedAtMs: number): number { return monotonicNowMs() - startedAtMs; }\\n"}}',
      '{"action":"done","summary":"Switched scheduler to monotonicNowMs."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const c = readWorkspaceFile(workspaceRoot, 'src/clock.ts');
      const s = readWorkspaceFile(workspaceRoot, 'src/scheduler.ts');
      const ok = c.includes('export function monotonicNowMs') && s.includes('monotonicNowMs()') && !s.includes('Date.now()');
      return { passed: ok, reason: ok ? 'Clock + scheduler updated' : 'Mismatch' };
    },
  },
  {
    id: 'ST-044',
    category: 'multi_file_read_edit',
    title: 'Bump wire SCHEMA_VERSION from 1 to 2 across serializer.ts and deserializer.ts',
    prompt: 'Read src/serializer.ts and src/deserializer.ts and bump SCHEMA_VERSION from 1 to 2 in both modules.',
    initialFiles: {
      'src/serializer.ts': [
        'export const SCHEMA_VERSION = 1;',
        'export function encodeFrame(body: string): string {',
        '  return `v${SCHEMA_VERSION}:${body}`;',
        '}',
        '',
      ].join('\n'),
      'src/deserializer.ts': [
        'export const EXPECTED_SCHEMA_VERSION = 1;',
        'export function decodeFrame(frame: string): string {',
        '  const prefix = `v${EXPECTED_SCHEMA_VERSION}:`;',
        '  if (!frame.startsWith(prefix)) throw new Error("version mismatch");',
        '  return frame.slice(prefix.length);',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      {
        toolCalls: [
          { id: 'st044_rm1', name: 'read_many_files', input: { paths: ['src/serializer.ts', 'src/deserializer.ts'] } },
        ],
      },
      {
        toolCalls: [
          {
            id: 'st044_e1',
            name: 'edit',
            input: { path: 'src/serializer.ts', oldString: 'export const SCHEMA_VERSION = 1;', newString: 'export const SCHEMA_VERSION = 2;' },
          },
          {
            id: 'st044_e2',
            name: 'edit',
            input: { path: 'src/deserializer.ts', oldString: 'export const EXPECTED_SCHEMA_VERSION = 1;', newString: 'export const EXPECTED_SCHEMA_VERSION = 2;' },
          },
        ],
      },
      { text: 'Bumped wire schema version constants from `1` to `2` in both `serializer.ts` and `deserializer.ts`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/serializer.ts"}}',
      '{"action":"tool","tool":"read","input":{"path":"src/deserializer.ts"}}',
      '{"action":"plan","content":"Bump schema version in both files."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/serializer.ts","oldString":"export const SCHEMA_VERSION = 1;","newString":"export const SCHEMA_VERSION = 2;"}}',
      '{"action":"tool","tool":"edit","input":{"path":"src/deserializer.ts","oldString":"export const EXPECTED_SCHEMA_VERSION = 1;","newString":"export const EXPECTED_SCHEMA_VERSION = 2;"}}',
      '{"action":"done","summary":"Bumped wire version."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const ser = readWorkspaceFile(workspaceRoot, 'src/serializer.ts');
      const des = readWorkspaceFile(workspaceRoot, 'src/deserializer.ts');
      const ok = ser.includes('SCHEMA_VERSION = 2') && des.includes('EXPECTED_SCHEMA_VERSION = 2');
      return { passed: ok, reason: ok ? 'Symmetric wire version 2 verified' : 'Asymmetric wire version' };
    },
  },
];

// ============================================================================
// Category 7: Targeted Shell Check (`ST-045` .. `ST-050`, 6 tasks)
// ============================================================================
const TARGETED_SHELL_TASKS: SimpleBenchmarkTask[] = [
  {
    id: 'ST-045',
    category: 'targeted_shell_check',
    title: 'Fix fib(0) base case in fibonacci.mjs and verify via node',
    prompt: 'Fix fib(n) in src/fibonacci.mjs so fib(0) returns 0 and fib(1) returns 1, then run node --check and an inline assertion via shell.',
    initialFiles: {
      'src/fibonacci.mjs': [
        'export function fib(n) {',
        '  if (n <= 1) return 1;',
        '  return fib(n - 1) + fib(n - 2);',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st045_r1', name: 'read', input: { path: 'src/fibonacci.mjs' } }] },
      {
        toolCalls: [
          {
            id: 'st045_e1',
            name: 'edit',
            input: {
              path: 'src/fibonacci.mjs',
              oldString: '  if (n <= 1) return 1;',
              newString: '  if (n <= 0) return 0;\n  if (n === 1) return 1;',
            },
          },
          {
            id: 'st045_sh1',
            name: 'shell',
            input: {
              command: 'node --check src/fibonacci.mjs && node --input-type=module -e "import { fib } from \'./src/fibonacci.mjs\'; if (fib(0) !== 0 || fib(6) !== 8) process.exit(1);"',
            },
          },
        ],
      },
      { text: 'Fixed `fib(0)` base case in `src/fibonacci.mjs` and verified `fib(0) === 0` and `fib(6) === 8` with `node`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/fibonacci.mjs"}}',
      '{"action":"plan","content":"Fix fib base case and run node check."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/fibonacci.mjs","oldString":"  if (n <= 1) return 1;","newString":"  if (n <= 0) return 0;\\n  if (n === 1) return 1;"}}',
      '{"action":"tool","tool":"shell","input":{"command":"node --check src/fibonacci.mjs"}}',
      '{"action":"done","summary":"Fixed and checked fibonacci.mjs."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, shellCommandsSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/fibonacci.mjs');
      const ok = content.includes('return 0') && shellCommandsSucceeded >= 1;
      return { passed: ok, reason: ok ? 'fib fixed & shell verified' : 'Missing fix or shell check' };
    },
  },
  {
    id: 'ST-046',
    category: 'targeted_shell_check',
    title: 'Fix ampersand escaping order in escapeHtml.mjs and verify via node',
    prompt: 'Fix escapeHtml in src/escapeHtml.mjs so "&" is escaped BEFORE "<" and ">" (preventing "&lt;" from turning into "&amp;lt;"), and verify via shell.',
    initialFiles: {
      'src/escapeHtml.mjs': [
        'export function escapeHtml(str) {',
        "  return str.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;');",
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st046_r1', name: 'read', input: { path: 'src/escapeHtml.mjs' } }] },
      {
        toolCalls: [
          {
            id: 'st046_e1',
            name: 'edit',
            input: {
              path: 'src/escapeHtml.mjs',
              oldString: "  return str.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;');",
              newString: "  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');",
            },
          },
          {
            id: 'st046_sh1',
            name: 'shell',
            input: {
              command: 'node --check src/escapeHtml.mjs && node --input-type=module -e "import { escapeHtml } from \'./src/escapeHtml.mjs\'; if (escapeHtml(\'<b>&</b>\') !== \'&lt;b&gt;&amp;&lt;/b&gt;\') process.exit(1);"',
            },
          },
        ],
      },
      { text: 'Fixed `escapeHtml` replacement order and verified output with `node`.' },
    ],
    legacyRawTurns: [
      // Unescaped nested quotes inside `node -e "..."` inside raw JSON-in-text!
      '{"action":"tool","tool":"read","input":{"path":"src/escapeHtml.mjs"}}',
      '{"action":"plan","content":"Fix escapeHtml order and test with node."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/escapeHtml.mjs","oldString":"  return str.replace(/</g, \'&lt;\').replace(/>/g, \'&gt;\').replace(/&/g, \'&amp;\');","newString":"  return str.replace(/&/g, \'&amp;\').replace(/</g, \'&lt;\').replace(/>/g, \'&gt;\');"}}',
      '{"action":"tool","tool":"shell","input":{"command":"node -e "import(\'./src/escapeHtml.mjs\')""}}',
      '{"action":"tool","tool":"shell","input":{"command":"node -e "const x = "test";""}}',
      '{"action":"tool","tool":"shell","input":{"command":"node -e "process.exit(0)""}}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, shellCommandsSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/escapeHtml.mjs');
      const ok = content.indexOf('&amp;') < content.indexOf('&lt;') && shellCommandsSucceeded >= 1;
      return { passed: ok, reason: ok ? 'escapeHtml fixed & verified' : 'Wrong order or missing shell check' };
    },
  },
  {
    id: 'ST-047',
    category: 'targeted_shell_check',
    title: 'Decode URI components in parseQueryString (query.mjs) and verify via node',
    prompt: 'Fix parseQuery in src/query.mjs so "+" and percent-encoded values are decoded via decodeURIComponent, and verify with node.',
    initialFiles: {
      'src/query.mjs': [
        'export function parseQuery(qs) {',
        "  const clean = qs.replace(/^\\?/, '');",
        '  if (!clean) return {};',
        '  const out = {};',
        "  for (const part of clean.split('&')) {",
        "    const [k, v = ''] = part.split('=');",
        '    out[k] = v;',
        '  }',
        '  return out;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st047_r1', name: 'read', input: { path: 'src/query.mjs' } }] },
      {
        toolCalls: [
          {
            id: 'st047_e1',
            name: 'edit',
            input: {
              path: 'src/query.mjs',
              oldString: '    out[k] = v;',
              newString: "    out[decodeURIComponent(k.replace(/\\+/g, ' '))] = decodeURIComponent(v.replace(/\\+/g, ' '));",
            },
          },
          {
            id: 'st047_sh1',
            name: 'shell',
            input: {
              command: 'node --check src/query.mjs && node --input-type=module -e "import { parseQuery } from \'./src/query.mjs\'; const r = parseQuery(\'?q=hello+world%21\'); if (r.q !== \'hello world!\') process.exit(1);"',
            },
          },
        ],
      },
      { text: 'Updated `parseQuery` to decode `+` and percent-encoded components and verified via `node`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/query.mjs"}}',
      '{"action":"plan","content":"Decode query keys and values."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/query.mjs","oldString":"    out[k] = v;","newString":"    out[decodeURIComponent(k.replace(/\\\\+/g, \' \'))] = decodeURIComponent(v.replace(/\\\\+/g, \' \'));"}}',
      '{"action":"tool","tool":"shell","input":{"command":"node --check src/query.mjs"}}',
      '{"action":"done","summary":"Fixed parseQuery."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, shellCommandsSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/query.mjs');
      const ok = content.includes('decodeURIComponent') && shellCommandsSucceeded >= 1;
      return { passed: ok, reason: ok ? 'parseQuery fixed & verified' : 'Missing decodeURIComponent or check' };
    },
  },
  {
    id: 'ST-048',
    category: 'targeted_shell_check',
    title: 'Fix recursive deepFreeze in deepFreeze.mjs and verify via node',
    prompt: 'Fix deepFreeze in src/deepFreeze.mjs so nested plain objects are recursively frozen, and verify via shell using node.',
    initialFiles: {
      'src/deepFreeze.mjs': [
        'export function deepFreeze(obj) {',
        '  return Object.freeze(obj);',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st048_r1', name: 'read', input: { path: 'src/deepFreeze.mjs' } }] },
      {
        toolCalls: [
          {
            id: 'st048_e1',
            name: 'edit',
            input: {
              path: 'src/deepFreeze.mjs',
              oldString: 'export function deepFreeze(obj) {\n  return Object.freeze(obj);\n}',
              newString: [
                'export function deepFreeze(obj) {',
                "  if (obj && typeof obj === 'object') {",
                '    for (const val of Object.values(obj)) {',
                "      if (val && typeof val === 'object' && !Object.isFrozen(val)) deepFreeze(val);",
                '    }',
                '    return Object.freeze(obj);',
                '  }',
                '  return obj;',
                '}',
              ].join('\n'),
            },
          },
          {
            id: 'st048_sh1',
            name: 'shell',
            input: {
              command: 'node --check src/deepFreeze.mjs && node --input-type=module -e "import { deepFreeze } from \'./src/deepFreeze.mjs\'; const x = deepFreeze({ nested: { a: 1 } }); if (!Object.isFrozen(x.nested)) process.exit(1);"',
            },
          },
        ],
      },
      { text: 'Implemented recursive `deepFreeze` and verified `Object.isFrozen(x.nested)` via `node`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/deepFreeze.mjs"}}',
      '{"action":"plan","content":"Recursively freeze nested objects."}',
      '{"action":"tool","tool":"write","input":{"path":"src/deepFreeze.mjs","content":"export function deepFreeze(obj) {\\n  if (obj && typeof obj === \'object\') {\\n    for (const v of Object.values(obj)) if (v && typeof v === \'object\') deepFreeze(v);\\n    return Object.freeze(obj);\\n  }\\n  return obj;\\n}\\n"}}',
      '{"action":"tool","tool":"shell","input":{"command":"node --check src/deepFreeze.mjs"}}',
      '{"action":"done","summary":"Fixed deepFreeze."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, shellCommandsSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/deepFreeze.mjs');
      const ok = content.includes('Object.values') && content.includes('deepFreeze(') && shellCommandsSucceeded >= 1;
      return { passed: ok, reason: ok ? 'deepFreeze recursive & verified' : 'Not recursive or unchecked' };
    },
  },
  {
    id: 'ST-049',
    category: 'targeted_shell_check',
    title: 'Fix step increment bug in counter.mjs and verify via node',
    prompt: 'Fix createStepCounter in src/counter.mjs so next() increments by step instead of 1, and verify with node --check and an inline assertion.',
    initialFiles: {
      'src/counter.mjs': [
        'export function createStepCounter(start = 0, step = 1) {',
        '  let value = start;',
        '  return {',
        '    next() {',
        '      value += 1;',
        '      return value;',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st049_r1', name: 'read', input: { path: 'src/counter.mjs' } }] },
      {
        toolCalls: [
          {
            id: 'st049_e1',
            name: 'edit',
            input: {
              path: 'src/counter.mjs',
              oldString: '      value += 1;',
              newString: '      value += step;',
            },
          },
          {
            id: 'st049_sh1',
            name: 'shell',
            input: {
              command: 'node --check src/counter.mjs && node --input-type=module -e "import { createStepCounter } from \'./src/counter.mjs\'; const c = createStepCounter(10, 5); if (c.next() !== 15 || c.next() !== 20) process.exit(1);"',
            },
          },
        ],
      },
      { text: 'Fixed `createStepCounter` to increment by `step` and verified via `node`.' },
    ],
    legacyRawTurns: [
      '{"action":"tool","tool":"read","input":{"path":"src/counter.mjs"}}',
      '{"action":"plan","content":"Increment by step."}',
      '{"action":"tool","tool":"edit","input":{"path":"src/counter.mjs","oldString":"      value += 1;","newString":"      value += step;"}}',
      '{"action":"tool","tool":"shell","input":{"command":"node --check src/counter.mjs"}}',
      '{"action":"done","summary":"Fixed counter step."}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, shellCommandsSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/counter.mjs');
      const ok = content.includes('value += step;') && shellCommandsSucceeded >= 1;
      return { passed: ok, reason: ok ? 'Step increment verified' : 'Missing step fix' };
    },
  },
  {
    id: 'ST-050',
    category: 'targeted_shell_check',
    title: 'Fix numeric segment comparison in semver.mjs and verify via node',
    prompt: 'Fix compareSemver in src/semver.mjs so "1.10.0" compares greater than "1.2.0" (numeric segment compare instead of string compare), and verify via shell.',
    initialFiles: {
      'src/semver.mjs': [
        'export function compareSemver(a, b) {',
        "  const pa = a.split('.');",
        "  const pb = b.split('.');",
        '  for (let i = 0; i < 3; i += 1) {',
        '    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;',
        '  }',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    qwenTurns: [
      { toolCalls: [{ id: 'st050_r1', name: 'read', input: { path: 'src/semver.mjs' } }] },
      {
        toolCalls: [
          {
            id: 'st050_e1',
            name: 'edit',
            input: {
              path: 'src/semver.mjs',
              oldString: "  const pa = a.split('.');\n  const pb = b.split('.');",
              newString: "  const pa = a.split('.').map(Number);\n  const pb = b.split('.').map(Number);",
            },
          },
          {
            id: 'st050_sh1',
            name: 'shell',
            input: {
              command: 'node --check src/semver.mjs && node --input-type=module -e "import { compareSemver } from \'./src/semver.mjs\'; if (compareSemver(\'1.10.0\', \'1.2.0\') !== 1) process.exit(1);"',
            },
          },
        ],
      },
      { text: 'Converted semver segments with `.map(Number)` in `compareSemver` and verified `"1.10.0" > "1.2.0"` via `node`.' },
    ],
    legacyRawTurns: [
      // Raw JSON-in-text fails 3 times due to unescaped quotes in shell command / prose jitter
      'To fix `{ pa, pb }`:\n```json\n{"action":"tool","tool":"edit","input":{"path":"src/semver.mjs","oldString":"const pa = a.split(\'.\');\nconst pb = b.split(\'.\');","newString":"const pa = a.split(\'.\').map(Number);\nconst pb = b.split(\'.\').map(Number);"}}\n```',
      '{"action":"tool","tool":"edit","input":{"path":"src/semver.mjs","oldString":"const pa = a.split(\'.\');\n","newString":"const pa = a.split(\'.\').map(Number);\n"}}',
      '{"action":"tool","tool":"shell","input":{"command":"node -e "console.log(1)""}}',
    ],
    grade: ({ workspaceRoot, agentSucceeded, shellCommandsSucceeded }) => {
      if (!agentSucceeded) return { passed: false, reason: 'Agent failed' };
      const content = readWorkspaceFile(workspaceRoot, 'src/semver.mjs');
      const ok = content.includes('map(Number)') && shellCommandsSucceeded >= 1;
      return { passed: ok, reason: ok ? 'Numeric semver compare verified' : 'Lexicographical bug remains' };
    },
  },
];

export const SIMPLE_TASKS_CORPUS: readonly SimpleBenchmarkTask[] = [
  ...READ_ONLY_QA_TASKS,
  ...ONE_LINE_BUGFIX_TASKS,
  ...SYMBOL_RENAME_TASKS,
  ...NEW_HELPER_TASKS,
  ...CONFIG_JSON_TASKS,
  ...MULTI_FILE_TASKS,
  ...TARGETED_SHELL_TASKS,
];
