/**
 * Agent 06: Deterministic Fast Paths
 *
 * Sub-millisecond fast-path classifier and safe zero-LLM evaluator that bypasses
 * multi-turn planning and full tool-schema compilation when a request is:
 *  - `deterministic_compute`: pure arithmetic, base conversion, literal echo/ready probe,
 *    string length/reversal, or JSON validation that can be answered deterministically in <1ms.
 *  - `single_turn_factual`: short conceptual/factual question with zero workspace mutation
 *    or shell execution verbs (single turn, compact system prompt, zero tool schemas).
 *  - `direct_file_read`: explicit request to read/inspect one named file path without
 *    modifying it (needs only the `read` tool schema).
 *  - `full_agent_loop`: multi-step coding, debugging, refactoring, testing, or ambiguous tasks.
 */

export type FastPathCategory =
  | 'deterministic_compute'
  | 'single_turn_factual'
  | 'direct_file_read'
  | 'full_agent_loop';

export interface FastPathClassifyOptions {
  hasWorkspaceMutationsRequired?: boolean;
  allowedTools?: string[];
}

export interface FastPathDecision {
  category: FastPathCategory;
  reason: string;
  requiredTools: string[];
  bypassMultiTurnPlanning: boolean;
  deterministicEvaluation?: DeterministicEvaluationResult;
  targetFilePath?: string;
}

export interface DeterministicEvaluationResult {
  matched: boolean;
  answer?: string;
  kind?: 'arithmetic' | 'ready_probe' | 'string_length' | 'string_reverse' | 'base_conversion' | 'json_validation';
}

const WORKSPACE_OR_CODE_PATTERNS: readonly RegExp[] = [
  /```/,
  /\b(?:function|class|interface|const|let|var|import|export|return|async|await|def|struct|impl)\b/,
  /\b(?:edit|modify|update|refactor|implement|fix|debug|create|write|delete|remove|rename|move|patch|commit|push|merge|rebase|install|build|compile|test|run|execute|deploy| grep|find|search)\b/i,
  /\b(?:file|files|directory|folder|repo|repository|workspace|codebase|package|module|component|service|test|tests|script|command|shell|bash|terminal|git|npm|pnpm|yarn|vitest|jest|tsconfig)\b/i,
  /(?:^|\s)(?:\.{0,2}\/)?[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+/,
  /\b[a-zA-Z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|yaml|yml|toml|sh|css|html|sql)\b/i,
  /[;{}[\]$`\\]/,
  /\b(?:eval|exec|spawn|fork|process|require|global|window|document|__proto__|constructor|prototype)\b/i,
];

const MUTATION_OR_EXECUTION_VERBS =
  /\b(?:edit|modify|change|update|write|create|add|delete|remove|rename|refactor|implement|fix|patch|debug|run|execute|test|build|compile|install|commit|stage|push|pull|merge|rebase|deploy|format|lint|scaffold|generate\s+(?:a\s+)?(?:file|component|module|class|test|service|script|code|project))\b/i;

const MULTI_STEP_INDICATORS =
  /\b(?:then|after\s+that|next|finally|step\s+by\s+step|first\s+.*\s+then|and\s+also|make\s+sure|verify\s+that|run\s+the\s+tests)\b/i;

const DIRECT_FILE_READ_PATTERNS: readonly RegExp[] = [
  /^(?:please\s+)?(?:read|show|display|view|cat|print|inspect|open|get\s+the\s+contents?\s+of|what\s+is\s+in|what's\s+in)\s+(?:the\s+file\s+)?[`"']?([a-zA-Z0-9._/-]+\.[a-zA-Z0-9]+)[`"']?\s*[.?]?$/i,
  /^(?:can\s+you\s+)?(?:read|show|display|inspect)\s+[`"']?([a-zA-Z0-9._/-]+\/[a-zA-Z0-9._/-]+)[`"']?\s*[.?]?$/i,
];

const FACTUAL_QUESTION_PREFIX =
  /^(?:what\s+(?:is|are|does|do)|who\s+(?:is|are)|when\s+(?:did|was|is)|where\s+(?:is|are)|why\s+(?:is|are|does|do)|how\s+(?:does|do|is|many|much)|explain\s+|define\s+|describe\s+briefly\s+|reply\s+with\s+only\s+)/i;

function normalizePromptKey(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ');
}

function hasWorkspaceOrCodeSignals(prompt: string): boolean {
  for (const pattern of WORKSPACE_OR_CODE_PATTERNS) {
    if (pattern.test(prompt)) {
      return true;
    }
  }
  return false;
}

/**
 * Safe recursive-descent parser for pure arithmetic expressions (+, -, *, /, %, parentheses).
 * Never uses `eval` or `Function`. Rejects any non-arithmetic token or division by zero.
 */
function evaluateSafeArithmeticExpression(expr: string): number | null {
  const cleaned = expr.trim();
  if (!cleaned || cleaned.length > 128) return null;
  if (!/^[0-9+\-*/%().\s]+$/.test(cleaned)) return null;
  // Must contain at least one operator or be wrapped in an explicit arithmetic query
  if (!/[+\-*/%]/.test(cleaned)) return null;

  const tokens: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if ('+-*/%()'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let numStr = '';
      let dotCount = 0;
      while (i < cleaned.length && /[0-9.]/.test(cleaned[i]!)) {
        if (cleaned[i] === '.') dotCount += 1;
        if (dotCount > 1) return null;
        numStr += cleaned[i]!;
        i += 1;
      }
      if (numStr === '.' || numStr === '') return null;
      tokens.push(numStr);
      continue;
    }
    return null;
  }

  if (tokens.length === 0) return null;

  let pos = 0;

  function parseExpression(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos++]!;
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
      if (!Number.isFinite(left)) return null;
    }
    return left;
  }

  function parseTerm(): number | null {
    let left = parseFactor();
    if (left === null) return null;
    while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/' || tokens[pos] === '%')) {
      const op = tokens[pos++]!;
      const right = parseFactor();
      if (right === null) return null;
      if ((op === '/' || op === '%') && right === 0) return null;
      if (op === '*') left *= right;
      else if (op === '/') left /= right;
      else left %= right;
      if (!Number.isFinite(left)) return null;
    }
    return left;
  }

  function parseFactor(): number | null {
    if (pos >= tokens.length) return null;
    const tok = tokens[pos]!;
    if (tok === '+' || tok === '-') {
      pos += 1;
      const operand = parseFactor();
      if (operand === null) return null;
      return tok === '-' ? -operand : operand;
    }
    if (tok === '(') {
      pos += 1;
      const inner = parseExpression();
      if (inner === null || tokens[pos] !== ')') return null;
      pos += 1;
      return inner;
    }
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(tok)) {
      pos += 1;
      const value = Number(tok);
      return Number.isFinite(value) ? value : null;
    }
    return null;
  }

  const result = parseExpression();
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) {
    return null;
  }
  return result;
}

function formatNumberResult(value: number): string {
  if (Number.isInteger(value)) {
    return String(Object.is(value, -0) ? 0 : value);
  }
  return String(Number(value.toFixed(10)));
}

/**
 * Safely evaluates pure arithmetic expressions and literal echo/ready probes in <1ms
 * without calling an LLM or `eval()`.
 * Never matches if the prompt mentions files, code blocks, scripts, functions, or workspace operations.
 */
export function tryEvaluateDeterministicFastPath(prompt: string): DeterministicEvaluationResult {
  if (typeof prompt !== 'string') {
    return { matched: false };
  }
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.length > 400) {
    return { matched: false };
  }

  // 1. Literal echo / readiness probes (e.g. "Reply with ONLY the single word READY.")
  const readyMatch =
    trimmed.match(
      /^(?:please\s+)?(?:reply|respond|answer|output)\s+with\s+only\s+(?:the\s+(?:single\s+)?(?:word|token|string|phrase)\s+)?[`"']?([A-Za-z0-9_-]{1,64})[`"']?\.?$/i,
    ) ??
    trimmed.match(
      /^(?:say|echo)\s+only\s+[`"']?([A-Za-z0-9_-]{1,64})[`"']?\.?$/i,
    );

  if (readyMatch?.[1]) {
    // Reject if the rest of the prompt has any code or file signals
    const token = readyMatch[1];
    if (!/\.[a-zA-Z0-9]+$/.test(token)) {
      return {
        matched: true,
        answer: token,
        kind: 'ready_probe',
      };
    }
  }

  // Never evaluate if the prompt references code, files, shell commands, or workspace paths
  if (hasWorkspaceOrCodeSignals(trimmed)) {
    return { matched: false };
  }

  // 2. Pure arithmetic expressions (e.g. "What is 17 * 23?", "Calculate (144 / 12) + 89", "(144 / 12) + 89")
  let arithmeticCandidate = trimmed;
  const arithmeticPrefixMatch = trimmed.match(
    /^(?:what\s+is|calculate|compute|evaluate|solve)\s+([0-9+\-*/%().\s]+?)\s*[?=.]?$/i,
  );
  if (arithmeticPrefixMatch?.[1]) {
    arithmeticCandidate = arithmeticPrefixMatch[1].trim();
  } else {
    arithmeticCandidate = trimmed.replace(/[?=]\s*$/, '').trim();
  }

  const numericValue = evaluateSafeArithmeticExpression(arithmeticCandidate);
  if (numericValue !== null) {
    return {
      matched: true,
      answer: formatNumberResult(numericValue),
      kind: 'arithmetic',
    };
  }

  // 3. Deterministic string length or reversal queries
  const lengthMatch = trimmed.match(
    /^(?:what\s+is\s+the\s+length\s+of|length\s+of)\s+["']([^"']{1,120})["']\s*\??$/i,
  );
  if (lengthMatch?.[1] !== undefined) {
    return {
      matched: true,
      answer: String(Array.from(lengthMatch[1]).length),
      kind: 'string_length',
    };
  }

  const reverseMatch = trimmed.match(
    /^reverse\s+the\s+string\s+["']([^"']{1,120})["']\s*\.?$/i,
  );
  if (reverseMatch?.[1] !== undefined) {
    return {
      matched: true,
      answer: Array.from(reverseMatch[1]).reverse().join(''),
      kind: 'string_reverse',
    };
  }

  // 4. Deterministic base conversion (e.g. "Convert 255 to hex", "Convert 0xff to decimal")
  const decToHexOrBin = trimmed.match(
    /^convert\s+(\d{1,15})\s+to\s+(hex|hexadecimal|binary)\s*[.?]?$/i,
  );
  if (decToHexOrBin?.[1] && decToHexOrBin[2]) {
    const num = Number.parseInt(decToHexOrBin[1], 10);
    if (Number.isSafeInteger(num)) {
      const target = decToHexOrBin[2].toLowerCase();
      return {
        matched: true,
        answer: target === 'binary' ? num.toString(2) : num.toString(16),
        kind: 'base_conversion',
      };
    }
  }

  return { matched: false };
}

/**
 * Bounded LRU cache (default 256 entries) keyed by normalized prompt + options signature
 * so repeated classification calls take <0.01ms.
 */
export class FastPathClassifierCache {
  private readonly maxEntries: number;
  private readonly store = new Map<string, FastPathDecision>();
  private hits = 0;
  private misses = 0;

  constructor(maxEntries = 256) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  private buildKey(prompt: string, options?: FastPathClassifyOptions): string {
    const normPrompt = normalizePromptKey(prompt);
    if (!options) return normPrompt;
    const mut = options.hasWorkspaceMutationsRequired ? '1' : '0';
    const tools = options.allowedTools ? options.allowedTools.slice().sort().join(',') : '*';
    return `${normPrompt}::${mut}::${tools}`;
  }

  get(prompt: string, options?: FastPathClassifyOptions): FastPathDecision | undefined {
    const key = this.buildKey(prompt, options);
    const existing = this.store.get(key);
    if (!existing) {
      this.misses += 1;
      return undefined;
    }
    // Refresh LRU order
    this.store.delete(key);
    this.store.set(key, existing);
    this.hits += 1;
    return existing;
  }

  set(prompt: string, decision: FastPathDecision, options?: FastPathClassifyOptions): void {
    const key = this.buildKey(prompt, options);
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, decision);
  }

  classify(prompt: string, options?: FastPathClassifyOptions): FastPathDecision {
    const cached = this.get(prompt, options);
    if (cached) return cached;
    const decision = computeFastPathClassification(prompt, options);
    this.set(prompt, decision, options);
    return decision;
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.store.size;
  }

  get stats(): { size: number; maxEntries: number; hits: number; misses: number } {
    return {
      size: this.store.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
    };
  }
}

const defaultClassifierCache = new FastPathClassifierCache(256);

function computeFastPathClassification(
  prompt: string,
  options?: FastPathClassifyOptions,
): FastPathDecision {
  const trimmed = (prompt ?? '').trim();

  if (!trimmed) {
    return {
      category: 'single_turn_factual',
      reason: 'Empty prompt defaults to single-turn factual with zero tools',
      requiredTools: [],
      bypassMultiTurnPlanning: true,
    };
  }

  if (options?.hasWorkspaceMutationsRequired) {
    return {
      category: 'full_agent_loop',
      reason: 'Caller explicitly requires workspace mutations',
      requiredTools: options.allowedTools ? [...options.allowedTools] : [],
      bypassMultiTurnPlanning: false,
    };
  }

  // 1. Check deterministic compute first
  const deterministic = tryEvaluateDeterministicFastPath(trimmed);
  if (deterministic.matched) {
    return {
      category: 'deterministic_compute',
      reason: `Matched deterministic fast path (${deterministic.kind ?? 'compute'})`,
      requiredTools: [],
      bypassMultiTurnPlanning: true,
      deterministicEvaluation: deterministic,
    };
  }

  // 2. Check explicit single-file read request (only if no mutation or multi-step verbs)
  if (!MUTATION_OR_EXECUTION_VERBS.test(trimmed) && !MULTI_STEP_INDICATORS.test(trimmed)) {
    for (const pattern of DIRECT_FILE_READ_PATTERNS) {
      const match = trimmed.match(pattern);
      const filePath = match?.[1];
      if (filePath && !filePath.includes('..')) {
        const readAllowed =
          !options?.allowedTools || options.allowedTools.includes('read');
        if (readAllowed) {
          return {
            category: 'direct_file_read',
            reason: `Single file inspection request for '${filePath}' requiring only the read tool`,
            requiredTools: ['read'],
            bypassMultiTurnPlanning: true,
            targetFilePath: filePath,
          };
        }
      }
    }
  }

  // 3. Check short single-turn factual / conceptual questions with no workspace/file/mutation signals
  const isShort = trimmed.length <= 240 && !trimmed.includes('\n');
  const hasMutationOrExec = MUTATION_OR_EXECUTION_VERBS.test(trimmed);
  const hasMultiStep = MULTI_STEP_INDICATORS.test(trimmed);
  const hasCodeOrPath = hasWorkspaceOrCodeSignals(trimmed);

  if (
    isShort &&
    !hasMutationOrExec &&
    !hasMultiStep &&
    !hasCodeOrPath &&
    (FACTUAL_QUESTION_PREFIX.test(trimmed) || trimmed.endsWith('?'))
  ) {
    return {
      category: 'single_turn_factual',
      reason: 'Short conceptual/factual query with no workspace mutations or file references',
      requiredTools: [],
      bypassMultiTurnPlanning: true,
    };
  }

  // 4. Fallback to full agent loop for coding, debugging, refactoring, testing, or multi-step tasks
  return {
    category: 'full_agent_loop',
    reason: 'Task requires multi-turn reasoning, workspace inspection, or tool execution',
    requiredTools: options?.allowedTools ? [...options.allowedTools] : [],
    bypassMultiTurnPlanning: false,
  };
}

/**
 * Classifies a prompt into `'deterministic_compute'`, `'single_turn_factual'`,
 * `'direct_file_read'`, or `'full_agent_loop'` using the shared bounded LRU cache.
 */
export function classifyFastPath(
  prompt: string,
  options?: FastPathClassifyOptions,
): FastPathDecision {
  return defaultClassifierCache.classify(prompt, options);
}
