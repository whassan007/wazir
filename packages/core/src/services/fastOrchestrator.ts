import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import {
  classifyShellInput,
  discoverOptionalShellTools,
  type ShellClassification,
  type ShellRoutingMode,
  type WazirShellCommandName,
} from './shellClassifier.js';
import {
  LIQUID_SHELL_MODEL_ID,
  LIQUID_SHELL_PROVIDER,
  executeLiquidShellRequest,
  isLiquidShellEligibleRequest,
  resolveEmbeddedAssetLocations,
} from './liquidShellOrchestrator.js';
import { computeLatencyPercentiles } from './telemetryService.js';
import { expandUserCustomCommand, getUserCustomCommand } from './userCommandService.js';

export type ExecutionTier = 0 | 1 | 2 | 3;

export type Tier0IntentKind =
  | 'time_now'
  | 'time_today'
  | 'day_today'
  | 'date'
  | 'version'
  | 'whoami'
  | 'pwd'
  | 'hostname'
  | 'help'
  | 'models'
  | 'jobs'
  | 'status'
  | 'agents'
  | 'fleet'
  | 'history'
  | 'tools'
  | 'arithmetic'
  | 'debug_toggle'
  | 'route_explain'
  | 'latency_report'
  | 'theme'
  | 'commands'
  | 'menu'
  | 'custom_command'
  | 'shell_builtin'
  | 'control';

export interface RoutingDecision {
  tier: ExecutionTier;
  handler: string;
  reason: string;
  model?: string;
  provider?: string;
  confidence: number;
  normalizedInput: string;
  requiresConfirmation?: boolean;
  tier0Kind?: Tier0IntentKind;
  tier0Payload?: string;
  wazirCommand?: WazirShellCommandName;
  wazirArgs?: string;
  shellCommand?: string;
  ambiguous?: boolean;
}

export interface LatencyMeasurement {
  id: string;
  timestamp: string;
  input: string;
  tier: ExecutionTier;
  handler: string;
  inputToDispatchMs: number;
  classificationMs: number;
  modelSelectionMs?: number;
  modelLoadMs?: number;
  providerConnectionMs?: number;
  firstTokenMs?: number;
  totalExecutionMs: number;
  orchestrationOverheadMs: number;
  shellCommandMs?: number;
  tokenThroughputTps?: number;
  outputTokens?: number;
  toolInvocationCount?: number;
  status: 'success' | 'error' | 'cancelled';
  error?: string;
  timedOut?: boolean;
  model?: string;
  provider?: string;
}

export type LatencyMeasurementInput = Omit<LatencyMeasurement, 'id' | 'timestamp'> & {
  id?: string;
  timestamp?: string;
};

export interface ExecutionResult {
  status: 'success' | 'error' | 'cancelled';
  output?: string;
  error?: string;
  exitCode?: number;
  durationMs: number;
  decision?: RoutingDecision;
  telemetry?: LatencyMeasurement;
}

export interface Tier0MatchContext {
  sessionMode?: ShellRoutingMode;
  cwd?: string;
  packageVersion?: string;
  now?: Date;
  timeZone?: string;
  debugEnabled?: boolean;
  history?: readonly string[];
}

export interface FastOrchestratorClassifyOptions extends Tier0MatchContext {
  pinnedModel?: string;
  overrideModel?: string;
  forceTier3?: boolean;
  localOnly?: boolean;
  models?: FastModelCandidate[];
  env?: Record<string, string | undefined>;
}

export interface MetricPercentileStats {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface TierLatencySummary {
  tier: ExecutionTier;
  count: number;
  successCount: number;
  errorCount: number;
  cancelledCount: number;
  timeoutCount: number;
  errorRate: number;
  timeoutRate: number;
  metrics: {
    inputToDispatchMs: MetricPercentileStats;
    classificationMs: MetricPercentileStats;
    orchestrationOverheadMs: MetricPercentileStats;
    firstTokenMs: MetricPercentileStats;
    totalExecutionMs: MetricPercentileStats;
    shellCommandMs: MetricPercentileStats;
  };
}

export interface ModelLatencySummary {
  model: string;
  provider?: string;
  calls: number;
  errors: number;
  timeouts: number;
  ttft: MetricPercentileStats;
  tps: MetricPercentileStats;
  totalExecutionMs: MetricPercentileStats;
}

export interface ShellLatencySummary {
  capacity: number;
  totalSamples: number;
  errorRate: number;
  timeoutRate: number;
  metrics: {
    inputToDispatchMs: MetricPercentileStats;
    classificationMs: MetricPercentileStats;
    orchestrationOverheadMs: MetricPercentileStats;
    firstTokenMs: MetricPercentileStats;
    totalExecutionMs: MetricPercentileStats;
    shellCommandMs: MetricPercentileStats;
  };
  byTier: Record<ExecutionTier, TierLatencySummary>;
  byModel: Record<string, ModelLatencySummary>;
}

export interface FastModelCandidate {
  id: string;
  name?: string;
  provider?: string;
  family?: string;
  local?: boolean;
  hosted?: boolean;
  loaded?: boolean;
  state?: string;
  health?: 'healthy' | 'degraded' | 'unavailable';
  available?: boolean;
  embedding?: boolean;
  capabilities?: string[];
  parameters?: string;
  parameterBillions?: number;
  measuredTtftMs?: number;
  measuredTps?: number;
  memoryHeadroomGB?: number;
  availableMemoryGB?: number;
  requiredMemoryGB?: number;
  contextMax?: number;
}

export interface FastModelSelectionOptions {
  overrideModel?: string;
  env?: Record<string, string | undefined>;
  localOnly?: boolean;
  privacyMode?: 'local-only' | 'standard';
  maxParamBillions?: number;
  strictOverride?: boolean;
}

export interface RankedFastModelCandidate {
  candidate: FastModelCandidate;
  eligible: boolean;
  score: number;
  isLocal: boolean;
  isLoaded: boolean;
  parameterBillions?: number;
  memoryHeadroomGB?: number;
  reasons: string[];
  rejectionReasons: string[];
}

export interface FastModelSelectionResult {
  selected?: FastModelCandidate;
  model?: string;
  provider?: string;
  reason: string;
  ranked: RankedFastModelCandidate[];
  rejected: RankedFastModelCandidate[];
}

const HOSTED_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'gemini',
  'nvidia',
  'groq',
  'openrouter',
  'together',
  'bedrock',
  'vertex',
  'azure',
  'cohere',
  'mistral-api',
  'fireworks',
  'deepseek-api',
]);

const TIER3_WAZIR_COMMANDS = new Set<WazirShellCommandName>([
  'loop',
  'graph',
  'goal',
  'inspect',
  'pause',
  'resume',
  'stop',
]);

const EXPLANATORY_OPENING_RE =
  /^(?:(?:please|can\s+you|could\s+you|would\s+you)\s+)?(?:what(?:'s|\s+is|\s+are|\s+does|\s+do|\s+did|\s+was|\s+were|\s+would|\s+could|\s+should)|why(?:\s+is|\s+are|\s+does|\s+do|\s+did|\s+would)?|how(?:\s+does|\s+do|\s+is|\s+are|\s+to|\s+can|\s+would)?|explain|summarize|summarise|define|compare|contrast|translate|describe|tell\s+me\s+(?:about|what|why|how)|give\s+me\s+(?:a|an)\s+(?:summary|overview|explanation)|difference\s+between|what\s+is\s+the\s+difference)\b/i;

const LOCAL_ENVIRONMENT_OR_REPO_REF_RE =
  /\b(?:this|the|my|our|current|local)\s+(?:repo|repository|codebase|workspace|worktree|project|directory|directories|folder|folders|file|files|branch|commit|commits|diff|build|tests?|suite|test\s+suite|app|application|server|environment|machine|computer|system|os|operating\s+system)\b|\b(?:operating\s+system|am\s+i\s+running|on\s+(?:this|my)\s+machine|in\s+(?:this|the)\s+(?:repo|repository|codebase|workspace|directory|project)|in\s+wazir|last\s+commit|latest\s+commit|recent\s+commits?|git\s+(?:status|diff|log|blame|branch|show)|failing\s+tests?|broken\s+tests?|unused\s+imports?)\b/i;

const FILE_PATH_OR_CODE_FILE_RE =
  /(?:^|[\s'"`(])(?:\.{1,2}\/[\w./-]+|~\/[\w./-]+|\/(?:usr|etc|var|tmp|opt|bin|sbin|home|Users|src|packages|apps|test|tests|docs|scripts)\/[\w./-]*|(?:src|packages|apps|lib|dist|tests?|docs|scripts|config)\/[\w./-]+|[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cpp|cc|cxx|c|h|hpp|json|md|yaml|yml|toml|sh|bash|zsh|html|css|scss|sql|txt|xml|ini|cfg|conf|lock|env))\b/i;

const MULTI_AGENT_OR_WORKFLOW_RE =
  /\b(?:\d+\s+agents?|multi[- ]?agent|subagents?|orchestrat(?:e|ion)|improvement\s+graph|workflow\s+dag)\b/i;

const TIER3_ENGINEERING_OR_ACTION_RE =
  /\b(?:build|implement|refactor|fix|repair|debug|patch|deploy|migrate|install|uninstall|delete|remove|wipe|purge|destroy|create|write|edit|modify|update|rename|inspect|audit|review|analyze|analyse|profile|benchmark|diagnose|investigate|find|search|run|execute|test|compile|lint|typecheck)\b/i;

const STANDALONE_SNIPPET_INTENT_RE =
  /\b(?:write|implement|generate|provide|show)\s+(?:me\s+)?(?:a|an)\s+(?:[\w+#-]+\s+){0,3}(?:function|method|snippet|helper|class|expression|regex|query|algorithm|one-liner)\b/i;

function normalizeWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

function hasUnquotedShellOperator(input: string): boolean {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '|' || ch === '>' || ch === '<' || ch === ';' || ch === '&' || ch === '`') {
      return true;
    }
    if (ch === '$' && input[i + 1] === '(') {
      return true;
    }
  }
  return false;
}

function resolveEffectiveTimeZone(timeZone?: string): string | undefined {
  if (timeZone && timeZone.trim()) {
    return timeZone.trim();
  }
  const envTz = process.env.TZ;
  if (envTz && envTz.trim()) {
    return envTz.trim();
  }
  return undefined;
}

function normalizeIntlSpaces(formatted: string): string {
  return formatted.replace(/[\u202f\u00a0]/g, ' ');
}

function formatWithOptionalTz(
  date: Date,
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string {
  const effectiveTz = resolveEffectiveTimeZone(timeZone);
  try {
    return normalizeIntlSpaces(
      new Intl.DateTimeFormat('en-US', {
        ...options,
        ...(effectiveTz ? { timeZone: effectiveTz } : {}),
      }).format(date),
    );
  } catch {
    return normalizeIntlSpaces(new Intl.DateTimeFormat('en-US', options).format(date));
  }
}

/**
 * Formats the local wall-clock time (e.g., `2:01 PM PST`) using Intl.DateTimeFormat,
 * respecting OS timezone, `process.env.TZ`, and DST. Always formats the supplied Date
 * (defaulting to a fresh `new Date()` at call time).
 */
export function formatLocalTime(date: Date = new Date(), timeZone?: string): string {
  return formatWithOptionalTz(date, timeZone, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

/**
 * Formats the local date (e.g., `Saturday, November 21, 2026`) using Intl.DateTimeFormat,
 * respecting OS timezone, `process.env.TZ`, and DST.
 */
export function formatLocalDate(date: Date = new Date(), timeZone?: string): string {
  return formatWithOptionalTz(date, timeZone, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Formats the local wall-clock time and full date (e.g., `2:01 PM PST, Saturday, November 21, 2026`).
 */
export function formatLocalTimeAndDate(date: Date = new Date(), timeZone?: string): string {
  return `${formatLocalTime(date, timeZone)}, ${formatLocalDate(date, timeZone)}`;
}

let cachedPackageVersion: string | undefined;

/** Resolves the authoritative Wazir package version from workspace package.json files. */
export function resolveWazirPackageVersion(): string {
  if (cachedPackageVersion) {
    return cachedPackageVersion;
  }
  const currentDir = typeof __dirname === 'string' ? __dirname : process.cwd();
  const candidates = [
    path.resolve(currentDir, '../../../../package.json'),
    path.resolve(currentDir, '../../../package.json'),
    path.resolve(currentDir, '../../package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        if (parsed?.version && (parsed.name === 'wazir' || parsed.name === '@wazir/core' || parsed.name === '@wazir/cli')) {
          cachedPackageVersion = parsed.version;
          return parsed.version;
        }
      }
    } catch {
      // try next candidate
    }
  }
  cachedPackageVersion = '0.4.0';
  return cachedPackageVersion;
}

function safeUsername(): string {
  try {
    const info = os.userInfo();
    if (info.username) return info.username;
  } catch {
    // fall back to environment when /etc/passwd lookup is unavailable
  }
  return process.env.USER || process.env.USERNAME || 'unknown';
}

type ArithToken =
  | { type: 'number'; value: number }
  | { type: 'op'; value: '+' | '-' | '*' | '/' | '%' }
  | { type: 'lparen' }
  | { type: 'rparen' };

function stripArithmeticQuestionWrapper(input: string): string {
  let expr = input.trim();
  expr = expr.replace(/^(?:what(?:'s|\s+is)|calculate|compute|evaluate)\s+/i, '').trim();
  expr = expr.replace(/[?=]+\s*$/g, '').trim();
  return expr;
}

function tokenizeArithmetic(expr: string): ArithToken[] | null {
  if (!expr || expr.length > 512) {
    return null;
  }
  const tokens: ArithToken[] = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i += 1;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let end = i;
      let sawDot = false;
      let sawDigit = false;
      while (end < expr.length) {
        const c = expr[end]!;
        if (c >= '0' && c <= '9') {
          sawDigit = true;
          end += 1;
        } else if (c === '.') {
          if (sawDot) return null; // Reject multiple decimal points such as 1.2.3
          sawDot = true;
          end += 1;
        } else {
          break;
        }
      }
      if (!sawDigit) return null;
      // Reject numbers immediately followed by alphabetic/identifier characters (e.g. 12px, 0x10)
      if (end < expr.length && /[A-Za-z_]/.test(expr[end]!)) {
        return null;
      }
      const num = Number(expr.slice(i, end));
      if (!Number.isFinite(num)) {
        return null;
      }
      tokens.push({ type: 'number', value: num });
      i = end;
      continue;
    }
    // Reject any non-arithmetic token
    return null;
  }

  return tokens.length > 0 ? tokens : null;
}

/**
 * Evaluates pure arithmetic expressions (`+`, `-`, `*`, `/`, `%`, parentheses, decimals, unary `+/-`)
 * using a recursive-descent parser without `eval` or `Function`.
 * Returns `null` on invalid tokens, syntax errors, division/modulo by zero, or non-finite results.
 */
export function evaluateSafeArithmetic(rawInput: string): number | null {
  const expr = stripArithmeticQuestionWrapper(rawInput);
  const tokens = tokenizeArithmetic(expr);
  if (!tokens) return null;

  let pos = 0;
  let depth = 0;
  const MAX_DEPTH = 64;

  const peek = (): ArithToken | undefined => tokens[pos];
  const consume = (): ArithToken | undefined => {
    const tok = tokens[pos];
    pos += 1;
    return tok;
  };

  const parseExpression = (): number | null => {
    let left = parseTerm();
    if (left === null) return null;
    while (true) {
      const tok = peek();
      if (tok?.type === 'op' && (tok.value === '+' || tok.value === '-')) {
        consume();
        const right = parseTerm();
        if (right === null) return null;
        left = tok.value === '+' ? left + right : left - right;
        if (!Number.isFinite(left)) return null;
      } else {
        break;
      }
    }
    return left;
  };

  const parseTerm = (): number | null => {
    let left = parseUnary();
    if (left === null) return null;
    while (true) {
      const tok = peek();
      if (tok?.type === 'op' && (tok.value === '*' || tok.value === '/' || tok.value === '%')) {
        consume();
        const right = parseUnary();
        if (right === null) return null;
        if (tok.value === '*') {
          left = left * right;
        } else if (tok.value === '/') {
          if (right === 0) return null;
          left = left / right;
        } else {
          if (right === 0) return null;
          left = left % right;
        }
        if (!Number.isFinite(left)) return null;
      } else {
        break;
      }
    }
    return left;
  };

  const parseUnary = (): number | null => {
    const tok = peek();
    if (tok?.type === 'op' && (tok.value === '+' || tok.value === '-')) {
      consume();
      const inner = parseUnary();
      if (inner === null) return null;
      const val = tok.value === '-' ? -inner : inner;
      return Object.is(val, -0) ? 0 : val;
    }
    return parsePrimary();
  };

  const parsePrimary = (): number | null => {
    const tok = peek();
    if (!tok) return null;
    if (tok.type === 'number') {
      consume();
      return tok.value;
    }
    if (tok.type === 'lparen') {
      depth += 1;
      if (depth > MAX_DEPTH) return null;
      consume();
      const inner = parseExpression();
      if (inner === null) return null;
      const closing = consume();
      if (closing?.type !== 'rparen') return null;
      depth -= 1;
      return inner;
    }
    return null;
  };

  const value = parseExpression();
  if (value === null || pos !== tokens.length || !Number.isFinite(value)) {
    return null;
  }
  return Object.is(value, -0) ? 0 : value;
}

function formatArithmeticValue(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  // Normalize binary floating-point artifacts (e.g., 0.1 + 0.2 -> 0.3)
  return String(Number(value.toPrecision(12)));
}

function hasBinaryArithmeticOperator(rawInput: string): boolean {
  const expr = stripArithmeticQuestionWrapper(rawInput);
  const tokens = tokenizeArithmetic(expr);
  if (!tokens) return false;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.type === 'op' && i > 0) {
      const prev = tokens[i - 1]!;
      if (prev.type === 'number' || prev.type === 'rparen') {
        return true;
      }
    }
  }
  return false;
}

function isBareShellSessionBuiltin(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  if (lower === 'exit' || lower === 'quit' || /^exit\s+\S+$/.test(lower)) {
    return true;
  }
  if (lower === 'pwd' || lower === 'cd' || lower.startsWith('cd ')) {
    return true;
  }
  if (
    lower.startsWith('export ') ||
    lower.startsWith('unset ') ||
    lower.startsWith('alias ') ||
    lower.startsWith('unalias ')
  ) {
    return true;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=[^|><;&`]*$/.test(normalized) && !/\s/.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * Tier 0 deterministic intent registry (`matchTier0Intent`).
 * Never uses an LLM. Enforces strict guardrails against shell operators,
 * explicit `!`/`\`/`os:`/`sh:`/`?` escapes, and `/mode shell` / `/mode ai` overrides.
 */
export function matchTier0Intent(
  rawInput: string,
  contextOrMode: Tier0MatchContext | ShellRoutingMode = {},
): RoutingDecision | null {
  const context: Tier0MatchContext =
    typeof contextOrMode === 'string' ? { sessionMode: contextOrMode } : contextOrMode;
  const sessionMode: ShellRoutingMode = context.sessionMode ?? 'auto';
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeWhitespace(trimmed);
  const lower = normalized.toLowerCase();
  const now = context.now ?? new Date();
  const cwd = context.cwd ?? process.cwd();
  const pkgVersion = context.packageVersion ?? resolveWazirPackageVersion();

  // Control directives (/mode, /model, /permissions) always operate regardless of sessionMode
  if (/^\/mode\s+(shell|ai|auto)$/i.test(normalized)) {
    const nextMode = lower.split(/\s+/)[1]!;
    return {
      tier: 0,
      handler: 'tier0-control',
      reason: `session mode switch to '${nextMode}'`,
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'control',
      tier0Payload: nextMode,
    };
  }
  if (/^\/model(?:\s+\S.*)?$/i.test(normalized)) {
    const modelArg = normalized.slice(6).trim();
    return {
      tier: 0,
      handler: 'tier0-control',
      reason: modelArg ? `model pinned to '${modelArg}'` : 'show current shell model',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'control',
      tier0Payload: modelArg,
    };
  }
  if (/^\/permissions\s+(ask|auto|read-only)$/i.test(normalized)) {
    const perm = lower.split(/\s+/)[1]!;
    return {
      tier: 0,
      handler: 'tier0-control',
      reason: `permission mode set to '${perm}'`,
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'control',
      tier0Payload: perm,
    };
  }

  // Explicit collision/mode prefixes must bypass Tier 0
  if (
    trimmed.startsWith('!') ||
    trimmed.startsWith('?') ||
    /^\\[A-Za-z0-9._-]/.test(trimmed) ||
    /^(?:os|sh):/i.test(trimmed)
  ) {
    return null;
  }

  // Unquoted shell operators always route to Tier 1 native shell
  if (hasUnquotedShellOperator(trimmed)) {
    return null;
  }

  // Coordinated Theme Engine (/theme, theme ...)
  const themeMatch = /^(?:(?:wa|wazir)\s+)?\/?theme(?:\s+(.+))?$/i.exec(normalized);
  if (themeMatch) {
    const args = (themeMatch[1] ?? '').trim();
    return {
      tier: 0,
      handler: 'tier0-theme',
      reason: args ? `theme command '${args}'` : 'show active theme',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'theme',
      tier0Payload: args,
      wazirArgs: args,
    };
  }

  // User extension directory (/commands, commands ...)
  const commandsMatch = /^(?:(?:wa|wazir)\s+)?\/?commands(?:\s+(.+))?$/i.exec(normalized);
  if (commandsMatch) {
    const args = (commandsMatch[1] ?? '').trim();
    return {
      tier: 0,
      handler: 'tier0-commands',
      reason: args ? `custom commands '${args}'` : 'list custom commands',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'commands',
      tier0Payload: args,
      wazirArgs: args,
    };
  }

  // Universal Command Palette (/menu, menu ...)
  const menuMatch = /^(?:(?:wa|wazir)\s+)?\/?menu(?:\s+(.+))?$/i.exec(normalized);
  if (menuMatch) {
    const args = (menuMatch[1] ?? '').trim();
    return {
      tier: 0,
      handler: 'tier0-menu',
      reason: 'universal command palette',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'menu',
      tier0Payload: args,
      wazirArgs: args,
    };
  }

  // Agent-malleable user custom commands (~/.wazir/commands/*.json or ~/.wazir/bin/*)
  if (sessionMode !== 'ai') {
    const firstSpace = normalized.search(/\s/);
    const firstToken = firstSpace === -1 ? normalized : normalized.slice(0, firstSpace);
    const restArgs = firstSpace === -1 ? '' : normalized.slice(firstSpace + 1).trim();
    const customCmd = getUserCustomCommand(firstToken, {
      wazirHome: (context as { env?: NodeJS.ProcessEnv }).env?.WAZIR_HOME,
      env: (context as { env?: NodeJS.ProcessEnv }).env,
    });
    if (customCmd && customCmd.mode !== 'ai') {
      const expanded = expandUserCustomCommand(customCmd, restArgs);
      return {
        tier: 0,
        handler: 'tier0-custom-command',
        reason: `User custom command '${customCmd.name}' (${customCmd.source ?? 'manifest'})`,
        confidence: 1,
        normalizedInput: normalized,
        requiresConfirmation: Boolean(customCmd.confirm),
        tier0Kind: 'custom_command',
        tier0Payload: expanded,
        shellCommand: expanded,
      };
    }
  }

  // Observability / diagnostic Tier 0 commands (allowed in all session modes unless escaped/piped)
  const debugMatch = /^(?:(?:wa|wazir)\s+)?\/?debug(?:\s+(on|off|status))?$/i.exec(normalized);
  if (debugMatch) {
    const modeArg = (debugMatch[1] ?? 'status').toLowerCase();
    return {
      tier: 0,
      handler: 'tier0-debug',
      reason: `fast orchestrator debug directive '${modeArg}'`,
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'debug_toggle',
      tier0Payload: modeArg,
    };
  }

  const routeMatch = /^(?:(?:wa|wazir)\s+)?\/?route(?:\s+(.+))?$/i.exec(normalized);
  if (routeMatch) {
    let expr = (routeMatch[1] ?? '').trim();
    if (
      expr.length >= 2 &&
      ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'")))
    ) {
      const quoteChar = expr[0]!;
      let closedEarly = false;
      let escaped = false;
      for (let i = 1; i < expr.length - 1; i += 1) {
        const ch = expr[i]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\' && quoteChar === '"') {
          escaped = true;
          continue;
        }
        if (ch === quoteChar) {
          closedEarly = true;
          break;
        }
      }
      if (!closedEarly) {
        expr = expr.slice(1, -1).trim();
      }
    }
    return {
      tier: 0,
      handler: 'tier0-route',
      reason: 'explain routing classification without execution',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'route_explain',
      tier0Payload: expr,
    };
  }

  const latencyMatch = /^(?:(?:wa|wazir)\s+)?\/?latency(?:\s+(--json|reset))?$/i.exec(normalized);
  if (latencyMatch) {
    const subArg = (latencyMatch[1] ?? '').toLowerCase();
    return {
      tier: 0,
      handler: 'tier0-latency',
      reason: subArg === 'reset' ? 'reset latency telemetry' : 'display shell latency report',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'latency_report',
      tier0Payload: subArg,
    };
  }

  // Always allow exit/quit regardless of /mode shell or /mode ai
  if (lower === 'exit' || lower === 'quit' || /^exit\s+-?\d+$/.test(lower)) {
    return {
      tier: 0,
      handler: 'tier0-shell-builtin',
      reason: `shell session exit builtin '${lower}'`,
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'shell_builtin',
      tier0Payload: normalized,
      shellCommand: normalized,
    };
  }

  // In /mode ai, only control directives, observability commands, and exit/quit match Tier 0
  if (sessionMode === 'ai') {
    return null;
  }

  // Shell session builtins (in both 'auto' and 'shell' modes)
  if (isBareShellSessionBuiltin(normalized)) {
    if (lower === 'pwd') {
      return {
        tier: 0,
        handler: 'tier0-builtin',
        reason: 'deterministic working directory builtin (pwd)',
        confidence: 1,
        normalizedInput: normalized,
        requiresConfirmation: false,
        tier0Kind: 'pwd',
        tier0Payload: cwd,
        shellCommand: normalized,
      };
    }
    return {
      tier: 0,
      handler: 'tier0-shell-builtin',
      reason: 'deterministic shell session state builtin',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'shell_builtin',
      tier0Payload: normalized,
      shellCommand: normalized,
    };
  }

  // In explicit /mode shell, non-builtin inputs (including "what time is it today", "jobs", etc.) route to Tier 1 shell
  if (sessionMode === 'shell') {
    return null;
  }

  // 1. Clock & Calendar intents (anchored exact patterns; never substring match)
  if (
    /^(?:what\s+time\s+is\s+it(?:\s+(?:right\s+)?now)?|what(?:'s|s|\s+is)\s+the\s+time(?:\s+(?:right\s+)?now)?|current\s+time|local\s+time|time\s+now|tell\s+me\s+the\s+time(?:\s+please)?)\s*\??$/i.test(
      normalized,
    )
  ) {
    return {
      tier: 0,
      handler: 'tier0-clock',
      reason: 'deterministic Tier 0 local clock intent',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'time_now',
      tier0Payload: formatLocalTime(now, context.timeZone),
    };
  }

  if (
    /^(?:what\s+time\s+is\s+it\s+today|what(?:'s|s|\s+is)\s+the\s+time\s+today|(?:what(?:'s|\s+is)\s+the\s+)?(?:current\s+)?(?:time\s+and\s+date|date\s+and\s+time))\s*\??$/i.test(
      normalized,
    )
  ) {
    return {
      tier: 0,
      handler: 'tier0-clock',
      reason: 'deterministic Tier 0 local clock and date intent',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'time_today',
      tier0Payload: formatLocalTimeAndDate(now, context.timeZone),
    };
  }

  if (
    /^(?:what\s+day\s+is\s+(?:it\s+)?today|what\s+day\s+is\s+it|what(?:'s|s|\s+is)\s+the\s+day\s+today|today'?s\s+date|what\s+is\s+today'?s\s+date|what'?s\s+today'?s\s+date|what\s+date\s+is\s+it(?:\s+today)?)\s*\??$/i.test(
      normalized,
    )
  ) {
    return {
      tier: 0,
      handler: 'tier0-clock',
      reason: 'deterministic Tier 0 local calendar date intent',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'day_today',
      tier0Payload: formatLocalDate(now, context.timeZone),
    };
  }

  if (
    /^(?:current\s+date|date\s+today|what(?:'s|s|\s+is)\s+the\s+date(?:\s+today)?)\s*\??$/i.test(
      normalized,
    )
  ) {
    return {
      tier: 0,
      handler: 'tier0-clock',
      reason: 'deterministic Tier 0 local date intent',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'date',
      tier0Payload: formatLocalDate(now, context.timeZone),
    };
  }

  // 2. Host & Identity builtins
  if (/^(?:version|wa\s+version|wa\s+--version|wa\s+-V|wazir\s+version|wazir\s+--version|wazir\s+-V)$/i.test(normalized)) {
    return {
      tier: 0,
      handler: 'tier0-builtin',
      reason: 'deterministic Wazir version builtin',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'version',
      tier0Payload: `Wazir v${pkgVersion}`,
    };
  }

  if (/^(?:whoami|who\s+am\s+i)\s*\??$/i.test(normalized)) {
    return {
      tier: 0,
      handler: 'tier0-builtin',
      reason: 'deterministic current user identity builtin',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'whoami',
      tier0Payload: safeUsername(),
    };
  }

  if (
    /^(?:where\s+am\s+i|what\s+directory\s+am\s+i\s+in|which\s+directory\s+am\s+i\s+in|what\s+folder\s+am\s+i\s+in|what\s+is\s+my\s+current\s+directory|current\s+directory|working\s+directory)\s*\??$/i.test(
      normalized,
    )
  ) {
    return {
      tier: 0,
      handler: 'tier0-builtin',
      reason: 'deterministic working directory intent',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'pwd',
      tier0Payload: cwd,
    };
  }

  if (/^(?:hostname|what\s+is\s+my\s+hostname)\s*\??$/i.test(normalized)) {
    return {
      tier: 0,
      handler: 'tier0-builtin',
      reason: 'deterministic machine hostname builtin',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'hostname',
      tier0Payload: os.hostname(),
    };
  }

  // 3. Read-only Wazir & Shell inspection builtins
  if (/^(?:wa\s+|wazir\s+)?help(?:\s+(?!(?:me|us)\b).+)?$/i.test(normalized) || /^(?:wa|wazir)\s+--help$/i.test(normalized)) {
    const args = normalized.replace(/^(?:(?:wa|wazir)\s+)?(?:--)?help\s*/i, '').trim();
    return {
      tier: 0,
      handler: 'tier0-builtin',
      reason: 'deterministic Wazir help builtin',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'help',
      tier0Payload: args,
      wazirCommand: 'help',
      wazirArgs: args,
    };
  }

  if (/^(?:wa\s+|wazir\s+)?models(?:\s+list)?(?:\s+--json)?$/i.test(normalized)) {
    const args = normalized.replace(/^(?:(?:wa|wazir)\s+)?models\s*/i, '').trim();
    return {
      tier: 0,
      handler: 'tier0-builtin',
      reason: 'deterministic Wazir models listing builtin',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'models',
      tier0Payload: args,
      wazirCommand: 'models',
      wazirArgs: args,
    };
  }

  if (/^(?:wa\s+|wazir\s+)?jobs(?:\s+(?:--json|--status\s+\S+|--mode\s+\S+))*$/i.test(normalized)) {
    const args = normalized.replace(/^(?:(?:wa|wazir)\s+)?jobs\s*/i, '').trim();
    return {
      tier: 0,
      handler: 'tier0-builtin',
      reason: 'deterministic Wazir jobs listing builtin',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'jobs',
      tier0Payload: args,
      wazirCommand: 'jobs',
      wazirArgs: args,
    };
  }

  const statusMatch = /^(?:(?:wa|wazir)\s+)?status(?:\s+(.+))?$/i.exec(normalized);
  if (statusMatch) {
    const args = (statusMatch[1] ?? '').trim();
    const argTokens = args ? args.split(/\s+/) : [];
    // Accept bare `status`, `status --json`, or `status <run-id> [--json]`; reject prose sentences
    const validStatusArgs =
      argTokens.length === 0 ||
      argTokens.every((tok) => tok === '--json' || /^[A-Za-z0-9._:-]+$/.test(tok)) && argTokens.filter((t) => !t.startsWith('--')).length <= 1;
    if (validStatusArgs) {
      return {
        tier: 0,
        handler: 'tier0-builtin',
        reason: args ? `deterministic Wazir status lookup for '${args}'` : 'deterministic Wazir status builtin',
        confidence: 1,
        normalizedInput: normalized,
        requiresConfirmation: false,
        tier0Kind: 'status',
        tier0Payload: args,
        wazirCommand: 'status',
        wazirArgs: args,
      };
    }
  }

  if (/^(?:wa\s+|wazir\s+)?agents(?:\s+--json)?$/i.test(normalized)) {
    const args = normalized.replace(/^(?:(?:wa|wazir)\s+)?agents\s*/i, '').trim();
    return {
      tier: 0,
      handler: 'tier0-builtin',
      reason: 'deterministic Wazir agents listing builtin',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'agents',
      tier0Payload: args,
      wazirCommand: 'agents',
      wazirArgs: args,
    };
  }

  if (/^(?:wa\s+|wazir\s+)?fleet(?:\s+--json)?$/i.test(normalized)) {
    const args = normalized.replace(/^(?:(?:wa|wazir)\s+)?fleet\s*/i, '').trim();
    return {
      tier: 0,
      handler: 'tier0-builtin',
      reason: 'deterministic Wazir fleet status builtin',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'fleet',
      tier0Payload: args,
      wazirCommand: 'fleet',
      wazirArgs: args,
    };
  }

  if (/^(?:wa\s+|wazir\s+)?history(?:\s+--runs|\s+--json)?$/i.test(normalized)) {
    const args = normalized.replace(/^(?:(?:wa|wazir)\s+)?history\s*/i, '').trim();
    return {
      tier: 0,
      handler: 'tier0-builtin',
      reason: 'deterministic shell/run history builtin',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'history',
      tier0Payload: args,
      wazirCommand: 'history',
      wazirArgs: args,
    };
  }

  if (/^(?:tools|wa-tools|wa\s+tools)$/i.test(normalized)) {
    return {
      tier: 0,
      handler: 'tier0-builtin',
      reason: 'deterministic optional shell tools inspection builtin',
      confidence: 1,
      normalizedInput: normalized,
      requiresConfirmation: false,
      tier0Kind: 'tools',
      tier0Payload: '',
    };
  }

  // 4. Safe deterministic arithmetic (requires at least one binary operator so plain numbers don't hijack input)
  if (hasBinaryArithmeticOperator(normalized)) {
    const result = evaluateSafeArithmetic(normalized);
    if (result !== null) {
      return {
        tier: 0,
        handler: 'tier0-arithmetic',
        reason: 'deterministic safe arithmetic evaluation',
        confidence: 1,
        normalizedInput: normalized,
        requiresConfirmation: false,
        tier0Kind: 'arithmetic',
        tier0Payload: formatArithmeticValue(result),
      };
    }
  }

  return null;
}

const NATURAL_DATE_PHRASE_RE =
  /^date\s+(?:of|for|when|in|on|from|that|this|the|a|an|my|our|last|latest)\b/i;

function needsTier3Orchestration(request: string, classified: ShellClassification, forceTier3?: boolean): {
  tier3: boolean;
  reason: string;
} {
  if (forceTier3) {
    return { tier3: true, reason: 'explicitly forced to Tier 3 agent orchestration' };
  }

  const trimmed = request.trim();
  if (!trimmed) {
    return { tier3: false, reason: 'empty AI query routed to fast local LLM' };
  }

  if (FILE_PATH_OR_CODE_FILE_RE.test(trimmed)) {
    return { tier3: true, reason: 'references workspace files or paths requiring tool access' };
  }

  if (LOCAL_ENVIRONMENT_OR_REPO_REF_RE.test(trimmed)) {
    return { tier3: true, reason: 'requires live workspace, repository, or OS environment context' };
  }

  if (MULTI_AGENT_OR_WORKFLOW_RE.test(trimmed)) {
    return { tier3: true, reason: 'requests multi-agent or workflow graph orchestration' };
  }

  const isExplanatory = EXPLANATORY_OPENING_RE.test(trimmed);
  if (isExplanatory) {
    return { tier3: false, reason: 'straightforward explanatory/conversational query without workspace tools' };
  }

  if (STANDALONE_SNIPPET_INTENT_RE.test(trimmed) && !/\bfile\b|\brepo\b|\bworkspace\b|\bdirectory\b/i.test(trimmed)) {
    return { tier3: false, reason: 'standalone code snippet request without workspace mutation' };
  }

  if (classified.requiresConfirmation) {
    return { tier3: true, reason: 'potentially destructive request requires governed Tier 3 orchestration' };
  }

  if (TIER3_ENGINEERING_OR_ACTION_RE.test(trimmed)) {
    return { tier3: true, reason: 'engineering, mutation, or tool-requiring action routed to Tier 3 agent orchestration' };
  }

  if (trimmed.length > 600) {
    return { tier3: true, reason: 'long complex prompt routed to Tier 3 agent orchestration' };
  }

  return { tier3: false, reason: 'straightforward conversational/factual query routed to Tier 2 fast local LLM' };
}

function buildAiRoutingDecision(
  aiRequest: string,
  normalizedInput: string,
  classified: ShellClassification,
  options: FastOrchestratorClassifyOptions,
): RoutingDecision {
  if (!options.forceTier3 && isLiquidShellEligibleRequest(aiRequest)) {
    return {
      tier: 2,
      handler: 'wazir-shell-mini',
      reason: 'Path B bundled Liquid AI shell intent router (wazir-shell-mini)',
      model: options.overrideModel ?? options.pinnedModel ?? LIQUID_SHELL_MODEL_ID,
      provider: LIQUID_SHELL_PROVIDER,
      confidence: 0.96,
      normalizedInput,
      requiresConfirmation: classified.requiresConfirmation,
    };
  }

  const complexity = needsTier3Orchestration(aiRequest, classified, options.forceTier3);

  if (complexity.tier3) {
    return {
      tier: 3,
      handler: 'agent-orchestration',
      reason: complexity.reason,
      model: options.overrideModel ?? options.pinnedModel,
      confidence: 0.9,
      normalizedInput,
      requiresConfirmation: classified.requiresConfirmation,
    };
  }

  let selectedModel = options.overrideModel ?? options.pinnedModel;
  let selectedProvider: string | undefined;
  if (options.models && options.models.length > 0) {
    const fastSelection = selectFastLocalModel(options.models, {
      overrideModel: selectedModel,
      localOnly: options.localOnly,
      env: options.env,
    });
    if (fastSelection.selected) {
      selectedModel = fastSelection.selected.id;
      selectedProvider = fastSelection.selected.provider;
    }
  }

  return {
    tier: 2,
    handler: 'fast-local-llm',
    reason: complexity.reason,
    model: selectedModel,
    provider: selectedProvider,
    confidence: 0.92,
    normalizedInput,
    requiresConfirmation: classified.requiresConfirmation,
  };
}

/**
 * Classifies user input into ExecutionTier 0 (deterministic registry), Tier 1 (native OS shell or ambiguous),
 * Tier 2 (fast local LLM), or Tier 3 (full agent/workflow orchestration).
 */
export function classifyWithFastOrchestrator(
  rawInput: string,
  optionsOrMode: FastOrchestratorClassifyOptions | ShellRoutingMode = {},
): RoutingDecision {
  const options: FastOrchestratorClassifyOptions =
    typeof optionsOrMode === 'string' ? { sessionMode: optionsOrMode } : optionsOrMode;
  const sessionMode: ShellRoutingMode = options.sessionMode ?? 'auto';
  const normalizedInput = normalizeWhitespace(rawInput);

  if (!normalizedInput) {
    return {
      tier: 0,
      handler: 'tier0-noop',
      reason: 'empty input',
      confidence: 1,
      normalizedInput: '',
      requiresConfirmation: false,
    };
  }

  // Tier 0: deterministic auditable intent registry (never uses LLM)
  const tier0 = matchTier0Intent(rawInput, options);
  if (tier0) {
    return tier0;
  }

  // Delegate base shell/AI/wazir/control/ambiguous classification to shellClassifier
  const classified = classifyShellInput(rawInput.trim(), sessionMode);

  if (classified.mode === 'control') {
    return {
      tier: 0,
      handler: 'tier0-control',
      reason: classified.reason,
      confidence: 1,
      normalizedInput,
      requiresConfirmation: false,
      tier0Kind: 'control',
      tier0Payload: classified.modeChange ?? classified.modelChange ?? classified.permissionChange ?? '',
    };
  }

  if (classified.mode === 'ambiguous') {
    return {
      tier: 1,
      handler: 'ambiguous',
      reason: classified.reason,
      confidence: 0.2,
      normalizedInput,
      requiresConfirmation: classified.requiresConfirmation,
      ambiguous: true,
      shellCommand: classified.command,
    };
  }

  if (classified.mode === 'shell') {
    if (!classified.explicit && !hasUnquotedShellOperator(normalizedInput) && NATURAL_DATE_PHRASE_RE.test(normalizedInput)) {
      return buildAiRoutingDecision(normalizedInput, normalizedInput, classified, options);
    }
    return {
      tier: 1,
      handler: 'native-shell',
      reason: classified.reason,
      confidence: classified.explicit ? 1 : 0.95,
      normalizedInput,
      requiresConfirmation: false,
      shellCommand: classified.command,
    };
  }

  if (classified.mode === 'wazir' && classified.wazirCommand) {
    if (!TIER3_WAZIR_COMMANDS.has(classified.wazirCommand)) {
      return {
        tier: 0,
        handler: 'tier0-builtin',
        reason: classified.reason,
        confidence: 1,
        normalizedInput,
        requiresConfirmation: classified.requiresConfirmation,
        tier0Kind: classified.wazirCommand as Tier0IntentKind,
        tier0Payload: classified.wazirArgs ?? '',
        wazirCommand: classified.wazirCommand,
        wazirArgs: classified.wazirArgs,
      };
    }
    return {
      tier: 3,
      handler: 'wazir-workflow',
      reason: classified.reason,
      model: options.overrideModel ?? options.pinnedModel,
      confidence: 1,
      normalizedInput,
      requiresConfirmation: classified.requiresConfirmation,
      wazirCommand: classified.wazirCommand,
      wazirArgs: classified.wazirArgs,
    };
  }

  // classified.mode === 'ai': split cleanly between Tier 2 (fast-local-llm) and Tier 3 (agent-orchestration)
  return buildAiRoutingDecision(classified.command, normalizedInput, classified, options);
}

function toMetricPercentileStats(samples: number[]): MetricPercentileStats {
  const p = computeLatencyPercentiles(samples);
  return {
    count: p.count,
    min: p.minMs,
    p50: p.p50Ms,
    p95: p.p95Ms,
    p99: p.p99Ms,
    max: p.maxMs,
    mean: p.meanMs,
  };
}

function sanitizeMetricValue(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * Bounded ring-buffer latency tracker recording all 13 observability metrics across all 4 tiers,
 * computing per-tier counts, error/timeout rates, percentile breakdowns, per-model TTFT/TPS stats,
 * and human-readable or JSON reports.
 */
export class ShellLatencyTracker {
  private readonly capacity: number;
  private readonly buffer: Array<LatencyMeasurement | undefined>;
  private head = 0;
  private size = 0;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(maxSamplesOrOptions: number | { maxSamples?: number } = 2000) {
    const rawCap =
      typeof maxSamplesOrOptions === 'number'
        ? maxSamplesOrOptions
        : (maxSamplesOrOptions.maxSamples ?? 2000);
    this.capacity = Math.max(1, Math.floor(rawCap));
    this.buffer = new Array<LatencyMeasurement | undefined>(this.capacity);
  }

  public record(input: LatencyMeasurementInput): LatencyMeasurement {
    const measurement: LatencyMeasurement = {
      ...input,
      id: input.id ?? randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      inputToDispatchMs: sanitizeMetricValue(input.inputToDispatchMs) ?? 0,
      classificationMs: sanitizeMetricValue(input.classificationMs) ?? 0,
      modelSelectionMs: sanitizeMetricValue(input.modelSelectionMs),
      modelLoadMs: sanitizeMetricValue(input.modelLoadMs),
      providerConnectionMs: sanitizeMetricValue(input.providerConnectionMs),
      firstTokenMs: sanitizeMetricValue(input.firstTokenMs),
      totalExecutionMs: sanitizeMetricValue(input.totalExecutionMs) ?? 0,
      orchestrationOverheadMs: sanitizeMetricValue(input.orchestrationOverheadMs) ?? 0,
      shellCommandMs: sanitizeMetricValue(input.shellCommandMs),
      tokenThroughputTps: sanitizeMetricValue(input.tokenThroughputTps),
      outputTokens: sanitizeMetricValue(input.outputTokens),
      toolInvocationCount: sanitizeMetricValue(input.toolInvocationCount),
    };

    this.buffer[this.head] = measurement;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size += 1;
    }
    return measurement;
  }

  public getMeasurements(): LatencyMeasurement[] {
    const out: LatencyMeasurement[] = [];
    if (this.size === 0) return out;
    const start = this.size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.size; i += 1) {
      const entry = this.buffer[(start + i) % this.capacity];
      if (entry) out.push({ ...entry });
    }
    return out;
  }

  public exportSnapshot(): { version: 1; capacity: number; measurements: LatencyMeasurement[] } {
    return {
      version: 1,
      capacity: this.capacity,
      measurements: this.getMeasurements(),
    };
  }

  public importSnapshot(data: unknown): number {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return 0;
    }
    const obj = data as Record<string, unknown>;
    if (obj.version !== undefined && obj.version !== 1) {
      return 0;
    }
    if (!Array.isArray(obj.measurements)) {
      return 0;
    }

    const isNonNegFinite = (val: unknown): val is number =>
      typeof val === 'number' && Number.isFinite(val) && val >= 0;

    const valid: LatencyMeasurementInput[] = [];
    for (const rawItem of obj.measurements) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
      const item = rawItem as Record<string, unknown>;
      if (typeof item.input !== 'string') continue;
      if (item.tier !== 0 && item.tier !== 1 && item.tier !== 2 && item.tier !== 3) continue;
      if (typeof item.handler !== 'string' || !item.handler) continue;
      if (item.status !== 'success' && item.status !== 'error' && item.status !== 'cancelled') continue;
      if (
        !isNonNegFinite(item.inputToDispatchMs) ||
        !isNonNegFinite(item.classificationMs) ||
        !isNonNegFinite(item.totalExecutionMs) ||
        !isNonNegFinite(item.orchestrationOverheadMs)
      ) {
        continue;
      }

      const clean: LatencyMeasurementInput = {
        ...(typeof item.id === 'string' && item.id ? { id: item.id } : {}),
        ...(typeof item.timestamp === 'string' && item.timestamp ? { timestamp: item.timestamp } : {}),
        input: item.input,
        tier: item.tier,
        handler: item.handler,
        inputToDispatchMs: item.inputToDispatchMs,
        classificationMs: item.classificationMs,
        totalExecutionMs: item.totalExecutionMs,
        orchestrationOverheadMs: item.orchestrationOverheadMs,
        status: item.status,
      };
      if (isNonNegFinite(item.modelSelectionMs)) clean.modelSelectionMs = item.modelSelectionMs;
      if (isNonNegFinite(item.modelLoadMs)) clean.modelLoadMs = item.modelLoadMs;
      if (isNonNegFinite(item.providerConnectionMs)) clean.providerConnectionMs = item.providerConnectionMs;
      if (isNonNegFinite(item.firstTokenMs)) clean.firstTokenMs = item.firstTokenMs;
      if (isNonNegFinite(item.shellCommandMs)) clean.shellCommandMs = item.shellCommandMs;
      if (isNonNegFinite(item.tokenThroughputTps)) clean.tokenThroughputTps = item.tokenThroughputTps;
      if (isNonNegFinite(item.outputTokens)) clean.outputTokens = item.outputTokens;
      if (isNonNegFinite(item.toolInvocationCount)) clean.toolInvocationCount = item.toolInvocationCount;
      if (typeof item.error === 'string') clean.error = item.error;
      if (typeof item.timedOut === 'boolean') clean.timedOut = item.timedOut;
      if (typeof item.model === 'string') clean.model = item.model;
      if (typeof item.provider === 'string') clean.provider = item.provider;

      valid.push(clean);
    }

    const toLoad = valid.slice(-this.capacity);
    for (const entry of toLoad) {
      this.record(entry);
    }
    return toLoad.length;
  }

  public loadFromFileSync(filePath: string): number {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) return 0;
      return this.importSnapshot(JSON.parse(raw) as unknown);
    } catch {
      return 0;
    }
  }

  public flushToFileAsync(filePath: string): Promise<void> {
    const run = async () => {
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      const payload = JSON.stringify(this.exportSnapshot(), null, 2);
      const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(tmpPath, payload, 'utf8');
        await fs.promises.rename(tmpPath, filePath);
      } catch (err) {
        await fs.promises.unlink(tmpPath).catch(() => undefined);
        throw err;
      }
    };
    const next = this.flushChain.then(run, run);
    this.flushChain = next.catch(() => undefined);
    return next;
  }

  public clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.size = 0;
  }

  public reset(): void {
    this.clear();
  }

  public get count(): number {
    return this.size;
  }

  private summarizeMetrics(entries: LatencyMeasurement[]) {
    const collect = (picker: (m: LatencyMeasurement) => number | undefined): number[] => {
      const values: number[] = [];
      for (const m of entries) {
        const val = picker(m);
        if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
          values.push(val);
        }
      }
      return values;
    };

    return {
      inputToDispatchMs: toMetricPercentileStats(collect((m) => m.inputToDispatchMs)),
      classificationMs: toMetricPercentileStats(collect((m) => m.classificationMs)),
      orchestrationOverheadMs: toMetricPercentileStats(collect((m) => m.orchestrationOverheadMs)),
      firstTokenMs: toMetricPercentileStats(collect((m) => m.firstTokenMs)),
      totalExecutionMs: toMetricPercentileStats(collect((m) => m.totalExecutionMs)),
      shellCommandMs: toMetricPercentileStats(collect((m) => m.shellCommandMs)),
    };
  }

  public getSummary(): ShellLatencySummary {
    const entries = this.getMeasurements();
    const totalSamples = entries.length;
    const totalErrors = entries.filter((m) => m.status === 'error').length;
    const totalTimeouts = entries.filter((m) => m.timedOut === true).length;

    const buildTierSummary = (tier: ExecutionTier): TierLatencySummary => {
      const tierEntries = entries.filter((m) => m.tier === tier);
      const count = tierEntries.length;
      const successCount = tierEntries.filter((m) => m.status === 'success').length;
      const errorCount = tierEntries.filter((m) => m.status === 'error').length;
      const cancelledCount = tierEntries.filter((m) => m.status === 'cancelled').length;
      const timeoutCount = tierEntries.filter((m) => m.timedOut === true).length;
      return {
        tier,
        count,
        successCount,
        errorCount,
        cancelledCount,
        timeoutCount,
        errorRate: count > 0 ? Number((errorCount / count).toFixed(4)) : 0,
        timeoutRate: count > 0 ? Number((timeoutCount / count).toFixed(4)) : 0,
        metrics: this.summarizeMetrics(tierEntries),
      };
    };

    const byModelBuckets = new Map<string, LatencyMeasurement[]>();
    for (const m of entries) {
      if (!m.model) continue;
      let bucket = byModelBuckets.get(m.model);
      if (!bucket) {
        bucket = [];
        byModelBuckets.set(m.model, bucket);
      }
      bucket.push(m);
    }

    const byModel: Record<string, ModelLatencySummary> = {};
    for (const [model, bucket] of [...byModelBuckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const ttftSamples = bucket
        .map((m) => m.firstTokenMs)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
      const tpsSamples = bucket
        .map((m) => m.tokenThroughputTps)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
      const execSamples = bucket
        .map((m) => m.totalExecutionMs)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
      const provider = bucket.find((m) => m.provider)?.provider;

      byModel[model] = {
        model,
        ...(provider ? { provider } : {}),
        calls: bucket.length,
        errors: bucket.filter((m) => m.status === 'error').length,
        timeouts: bucket.filter((m) => m.timedOut === true).length,
        ttft: toMetricPercentileStats(ttftSamples),
        tps: toMetricPercentileStats(tpsSamples),
        totalExecutionMs: toMetricPercentileStats(execSamples),
      };
    }

    return {
      capacity: this.capacity,
      totalSamples,
      errorRate: totalSamples > 0 ? Number((totalErrors / totalSamples).toFixed(4)) : 0,
      timeoutRate: totalSamples > 0 ? Number((totalTimeouts / totalSamples).toFixed(4)) : 0,
      metrics: this.summarizeMetrics(entries),
      byTier: {
        0: buildTierSummary(0),
        1: buildTierSummary(1),
        2: buildTierSummary(2),
        3: buildTierSummary(3),
      },
      byModel,
    };
  }

  public formatReport(options: { json?: boolean } = {}): string {
    const summary = this.getSummary();
    if (options.json) {
      return JSON.stringify(summary, null, 2);
    }

    const fmtMetric = (name: string, s: MetricPercentileStats) =>
      `  ${name.padEnd(24)} n=${String(s.count).padEnd(5)} min=${s.min.toFixed(2)}ms p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms p99=${s.p99.toFixed(2)}ms max=${s.max.toFixed(2)}ms mean=${s.mean.toFixed(2)}ms`;

    const lines: string[] = [
      `Wazir Shell Latency Report (samples: ${summary.totalSamples}/${summary.capacity}, errorRate: ${(summary.errorRate * 100).toFixed(1)}%, timeoutRate: ${(summary.timeoutRate * 100).toFixed(1)}%)`,
      'Overall Metrics:',
      fmtMetric('inputToDispatchMs', summary.metrics.inputToDispatchMs),
      fmtMetric('classificationMs', summary.metrics.classificationMs),
      fmtMetric('orchestrationOverheadMs', summary.metrics.orchestrationOverheadMs),
      fmtMetric('firstTokenMs', summary.metrics.firstTokenMs),
      fmtMetric('totalExecutionMs', summary.metrics.totalExecutionMs),
      fmtMetric('shellCommandMs', summary.metrics.shellCommandMs),
      'Per-Tier Breakdown:',
    ];

    for (const tier of [0, 1, 2, 3] as ExecutionTier[]) {
      const t = summary.byTier[tier];
      lines.push(
        `  Tier ${tier}: count=${t.count} errors=${t.errorCount} timeouts=${t.timeoutCount} p50=${t.metrics.totalExecutionMs.p50.toFixed(2)}ms p95=${t.metrics.totalExecutionMs.p95.toFixed(2)}ms`,
      );
    }

    const modelEntries = Object.values(summary.byModel);
    if (modelEntries.length > 0) {
      lines.push('Per-Model Stats:');
      for (const m of modelEntries) {
        lines.push(
          `  ${m.model}: calls=${m.calls} errors=${m.errors} ttft_p50=${m.ttft.p50.toFixed(2)}ms tps_mean=${m.tps.mean.toFixed(2)}`,
        );
      }
    }

    return lines.join('\n');
  }
}

function isEmbeddingCandidate(c: FastModelCandidate): boolean {
  if (c.embedding === true) return true;
  const caps = c.capabilities ?? [];
  if (caps.includes('embedding') && !caps.includes('chat') && !caps.includes('coding')) {
    return true;
  }
  const idLower = `${c.id} ${c.name ?? ''} ${c.family ?? ''}`.toLowerCase();
  return /\bembed(?:ding)?\b|nomic-embed|mxbai-embed|bge-|e5-|all-minilm/.test(idLower);
}

function isLocalCandidate(c: FastModelCandidate): boolean {
  if (c.local === false || c.hosted === true) return false;
  if (c.local === true) return true;
  if (c.provider && HOSTED_PROVIDERS.has(c.provider.toLowerCase())) {
    return false;
  }
  return true;
}

function extractParameterBillions(c: FastModelCandidate): number | undefined {
  if (typeof c.parameterBillions === 'number' && Number.isFinite(c.parameterBillions) && c.parameterBillions > 0) {
    return c.parameterBillions;
  }
  if (c.parameters) {
    const match = c.parameters.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([bBmM])?$/);
    if (match) {
      const num = Number.parseFloat(match[1]!);
      const unit = (match[2] ?? 'B').toUpperCase();
      if (Number.isFinite(num) && num > 0) {
        return unit === 'M' ? num / 1000 : num;
      }
    }
  }
  const idMatch = `${c.id} ${c.name ?? ''}`.match(/(?:^|[:\-_/\s])([0-9]+(?:\.[0-9]+)?)\s*([bm])(?=$|[:\-_/\s])/i);
  if (idMatch) {
    const num = Number.parseFloat(idMatch[1]!);
    const unit = idMatch[2]!.toUpperCase();
    if (Number.isFinite(num) && num > 0) {
      return unit === 'M' ? num / 1000 : num;
    }
  }
  return undefined;
}

function resolveMemoryHeadroomGB(c: FastModelCandidate): number | undefined {
  if (typeof c.memoryHeadroomGB === 'number' && Number.isFinite(c.memoryHeadroomGB)) {
    return c.memoryHeadroomGB;
  }
  if (
    typeof c.availableMemoryGB === 'number' &&
    Number.isFinite(c.availableMemoryGB) &&
    typeof c.requiredMemoryGB === 'number' &&
    Number.isFinite(c.requiredMemoryGB)
  ) {
    return c.availableMemoryGB - c.requiredMemoryGB;
  }
  return undefined;
}

/**
 * Selects the optimal fast local model for Tier 2 conversational/explanatory inference,
 * scoring candidates by explicit override (`options.overrideModel`, `WAZIR_FAST_MODEL`),
 * residency (`loaded === true`), measured TTFT, parameter size (preferring <= 35B over 70B+,
 * excluding embedding models), throughput (`measuredTps`), memory headroom, and `localOnly` policy.
 */
export function selectFastLocalModel(
  candidates: FastModelCandidate[],
  options: FastModelSelectionOptions = {},
): FastModelSelectionResult {
  const envMap = options.env ?? process.env;
  const rawOverride = options.overrideModel?.trim() || envMap.WAZIR_FAST_MODEL?.trim() || '';
  const override = rawOverride && rawOverride.toLowerCase() !== 'auto' ? rawOverride : '';
  const localOnly = options.localOnly === true || options.privacyMode === 'local-only';
  const maxFastParamB = options.maxParamBillions ?? 35;

  const ranked: RankedFastModelCandidate[] = [];
  const rejected: RankedFastModelCandidate[] = [];

  for (const candidate of candidates) {
    const isLocal = isLocalCandidate(candidate);
    const isLoaded = candidate.loaded === true || candidate.state === 'READY' || candidate.state === 'LOADED';
    const paramB = extractParameterBillions(candidate);
    const headroomGB = resolveMemoryHeadroomGB(candidate);
    const rejectionReasons: string[] = [];
    const reasons: string[] = [];

    if (localOnly && !isLocal) {
      rejectionReasons.push(`hosted/remote model '${candidate.id}' excluded by localOnly privacy policy`);
    }
    if (isEmbeddingCandidate(candidate)) {
      rejectionReasons.push(`embedding model '${candidate.id}' excluded from fast inference`);
    }
    if (candidate.available === false || candidate.health === 'unavailable' || candidate.state === 'UNAVAILABLE' || candidate.state === 'FAILED') {
      rejectionReasons.push(`model '${candidate.id}' is unavailable`);
    }
    if (headroomGB !== undefined && headroomGB < 0) {
      rejectionReasons.push(`insufficient memory headroom (${headroomGB.toFixed(2)} GB)`);
    }

    if (rejectionReasons.length > 0) {
      rejected.push({
        candidate,
        eligible: false,
        score: -1000,
        isLocal,
        isLoaded,
        parameterBillions: paramB,
        memoryHeadroomGB: headroomGB,
        reasons,
        rejectionReasons,
      });
      continue;
    }

    let score = 0;

    if (isLocal) {
      score += 100;
      reasons.push('local (+100)');
    } else {
      reasons.push('hosted (+0)');
    }

    if (isLoaded) {
      score += 120;
      reasons.push('resident/loaded (+120)');
    }

    if (paramB !== undefined) {
      if (paramB <= maxFastParamB) {
        const sizeBonus = 60 + Math.max(0, (maxFastParamB - paramB) * 0.5);
        score += sizeBonus;
        reasons.push(`${paramB}B <= ${maxFastParamB}B (+${sizeBonus.toFixed(1)})`);
      } else if (paramB < 70) {
        score -= 20;
        reasons.push(`${paramB}B > ${maxFastParamB}B (-20)`);
      } else {
        score -= 80;
        reasons.push(`heavy ${paramB}B >= 70B (-80)`);
      }
    }

    if (typeof candidate.measuredTtftMs === 'number' && Number.isFinite(candidate.measuredTtftMs) && candidate.measuredTtftMs >= 0) {
      const ttftScore = Math.max(-40, 40 - candidate.measuredTtftMs / 50);
      score += ttftScore;
      reasons.push(`ttft=${candidate.measuredTtftMs}ms (${ttftScore >= 0 ? '+' : ''}${ttftScore.toFixed(1)})`);
    }

    if (typeof candidate.measuredTps === 'number' && Number.isFinite(candidate.measuredTps) && candidate.measuredTps > 0) {
      const tpsScore = Math.min(35, candidate.measuredTps * 0.35);
      score += tpsScore;
      reasons.push(`tps=${candidate.measuredTps} (+${tpsScore.toFixed(1)})`);
    }

    if (headroomGB !== undefined) {
      if (headroomGB < 2) {
        score -= 25;
        reasons.push(`low memory headroom=${headroomGB.toFixed(1)}GB (-25)`);
      } else {
        const memScore = Math.min(20, headroomGB);
        score += memScore;
        reasons.push(`headroom=${headroomGB.toFixed(1)}GB (+${memScore.toFixed(1)})`);
      }
    }

    ranked.push({
      candidate,
      eligible: true,
      score: Number(score.toFixed(4)),
      isLocal,
      isLoaded,
      parameterBillions: paramB,
      memoryHeadroomGB: headroomGB,
      reasons,
      rejectionReasons: [],
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.isLoaded !== b.isLoaded) return a.isLoaded ? -1 : 1;
    const ttftA = a.candidate.measuredTtftMs ?? Number.POSITIVE_INFINITY;
    const ttftB = b.candidate.measuredTtftMs ?? Number.POSITIVE_INFINITY;
    if (ttftA !== ttftB) return ttftA - ttftB;
    const paramA = a.parameterBillions ?? Number.POSITIVE_INFINITY;
    const paramB = b.parameterBillions ?? Number.POSITIVE_INFINITY;
    if (paramA !== paramB) return paramA - paramB;
    return a.candidate.id.localeCompare(b.candidate.id);
  });

  if (override) {
    const matchExact = (entry: RankedFastModelCandidate) =>
      entry.candidate.id === override || entry.candidate.name === override;
    const matchFold = (entry: RankedFastModelCandidate) =>
      entry.candidate.id.toLowerCase() === override.toLowerCase() ||
      entry.candidate.name?.toLowerCase() === override.toLowerCase();

    const rejectedMatch = rejected.find(matchExact) ?? rejected.find(matchFold);
    if (rejectedMatch) {
      return {
        selected: undefined,
        reason: `Explicit override model '${override}' rejected: ${rejectedMatch.rejectionReasons.join('; ')}`,
        ranked,
        rejected,
      };
    }

    const eligibleMatch = ranked.find(matchExact) ?? ranked.find(matchFold);
    if (eligibleMatch) {
      return {
        selected: eligibleMatch.candidate,
        model: eligibleMatch.candidate.id,
        provider: eligibleMatch.candidate.provider,
        reason: `Explicit override model '${override}' selected`,
        ranked,
        rejected,
      };
    }

    if (options.strictOverride !== false) {
      return {
        selected: undefined,
        reason: `Explicit override model '${override}' not found in candidate list`,
        ranked,
        rejected,
      };
    }
  }

  const best = ranked[0];
  if (!best) {
    const summaryReason =
      rejected.length > 0
        ? `No eligible fast local model found (${rejected.map((r) => r.rejectionReasons.join('; ')).join(' | ')})`
        : 'No candidate models available';
    return {
      selected: undefined,
      reason: summaryReason,
      ranked,
      rejected,
    };
  }

  return {
    selected: best.candidate,
    model: best.candidate.id,
    provider: best.candidate.provider,
    reason: `Selected '${best.candidate.id}' (score=${best.score}): ${best.reasons.join(', ')}`,
    ranked,
    rejected,
  };
}

/** Stateful wrapper around `selectFastLocalModel` that can also incorporate observed telemetry. */
export class FastModelSelector {
  private readonly defaultOptions: FastModelSelectionOptions;
  private readonly tracker?: ShellLatencyTracker;

  constructor(options: FastModelSelectionOptions & { tracker?: ShellLatencyTracker } = {}) {
    const { tracker, ...rest } = options;
    this.defaultOptions = rest;
    this.tracker = tracker;
  }

  public select(
    candidates: FastModelCandidate[],
    options: FastModelSelectionOptions = {},
  ): FastModelSelectionResult {
    const merged: FastModelSelectionOptions = { ...this.defaultOptions, ...options };
    if (!this.tracker) {
      return selectFastLocalModel(candidates, merged);
    }

    const summary = this.tracker.getSummary();
    const enriched = candidates.map((candidate) => {
      const observed = summary.byModel[candidate.id];
      if (!observed) return candidate;
      return {
        ...candidate,
        measuredTtftMs: candidate.measuredTtftMs ?? (observed.ttft.count > 0 ? observed.ttft.p50 : undefined),
        measuredTps: candidate.measuredTps ?? (observed.tps.count > 0 ? observed.tps.mean : undefined),
      };
    });
    return selectFastLocalModel(enriched, merged);
  }
}

export interface FastOrchestratorOptions {
  cwd?: string;
  sessionMode?: ShellRoutingMode;
  debug?: boolean;
  packageVersion?: string;
  timeZone?: string;
  pinnedModel?: string;
  localOnly?: boolean;
  latencyTracker?: ShellLatencyTracker;
  maxLatencySamples?: number;
  models?: FastModelCandidate[];
  history?: string[];
  env?: Record<string, string | undefined>;
  executeShell?: (
    command: string,
    decision: RoutingDecision,
    signal?: AbortSignal,
  ) => Promise<{
    output?: string;
    error?: string;
    exitCode?: number;
    status?: 'success' | 'error' | 'cancelled';
    shellCommandMs?: number;
  }>;
  executeFastLlm?: (
    prompt: string,
    decision: RoutingDecision,
    signal?: AbortSignal,
  ) => Promise<{
    output?: string;
    error?: string;
    status?: 'success' | 'error' | 'cancelled';
    model?: string;
    provider?: string;
    modelSelectionMs?: number;
    modelLoadMs?: number;
    providerConnectionMs?: number;
    firstTokenMs?: number;
    tokenThroughputTps?: number;
    outputTokens?: number;
    timedOut?: boolean;
  }>;
  executeTier3?: (
    request: string,
    decision: RoutingDecision,
    signal?: AbortSignal,
  ) => Promise<{
    output?: string;
    error?: string;
    exitCode?: number;
    status?: 'success' | 'error' | 'cancelled';
    model?: string;
    provider?: string;
    modelSelectionMs?: number;
    modelLoadMs?: number;
    providerConnectionMs?: number;
    firstTokenMs?: number;
    tokenThroughputTps?: number;
    outputTokens?: number;
    toolInvocationCount?: number;
    timedOut?: boolean;
  }>;
  tier0Providers?: Partial<Record<Tier0IntentKind, (decision: RoutingDecision) => Promise<string> | string>>;
  onDebugTrace?: (decision: RoutingDecision, telemetry: LatencyMeasurement) => void;
}

export interface FastOrchestratorDispatchOptions extends FastOrchestratorClassifyOptions {
  signal?: AbortSignal;
}

async function runDefaultNativeShell(
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<{ output: string; error?: string; exitCode: number; status: 'success' | 'error' | 'cancelled'; shellCommandMs: number }> {
  const defaultPosixShell = fs.existsSync('/bin/zsh')
    ? '/bin/zsh'
    : fs.existsSync('/bin/bash')
      ? '/bin/bash'
      : '/bin/sh';
  const shellExe = env.SHELL || process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : defaultPosixShell);
  const shellArgs = process.platform === 'win32' && /cmd(?:\.exe)?$/i.test(shellExe) ? ['/d', '/s', '/c', command] : ['-c', command];
  const shellStart = performance.now();

  return new Promise((resolve) => {
    const child = spawn(shellExe, shellArgs, {
      cwd,
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let cancelled = false;

    const onAbort = () => {
      cancelled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // already exited
      }
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('exit', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const shellCommandMs = Math.max(0, performance.now() - shellStart);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trimEnd();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trimEnd();
      const exitCode = typeof code === 'number' ? code : cancelled ? 130 : 1;
      resolve({
        output: stdout,
        error: stderr || undefined,
        exitCode,
        status: cancelled ? 'cancelled' : exitCode === 0 ? 'success' : 'error',
        shellCommandMs,
      });
    });

    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const shellCommandMs = Math.max(0, performance.now() - shellStart);
      resolve({
        output: '',
        error: err.message,
        exitCode: 127,
        status: cancelled ? 'cancelled' : 'error',
        shellCommandMs,
      });
    });
  });
}

function stripAiPrefix(normalizedInput: string): string {
  return normalizedInput.startsWith('?') ? normalizedInput.slice(1).trim() : normalizedInput;
}

function unquoteSimpleShellValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\\ /g, ' ');
}

function formatRouteExplanation(decision: RoutingDecision): string {
  const lines = [
    `Tier: ${decision.tier} (${decision.handler})`,
    `Reason: ${decision.reason}`,
    `Confidence: ${decision.confidence}`,
    `Normalized Input: ${decision.normalizedInput}`,
  ];
  if (decision.tier0Kind) lines.push(`Tier 0 Intent: ${decision.tier0Kind}`);
  if (decision.wazirCommand) lines.push(`Wazir Command: ${decision.wazirCommand}`);
  if (decision.model) lines.push(`Model: ${decision.model}${decision.provider ? ` (${decision.provider})` : ''}`);
  if (decision.requiresConfirmation) lines.push('Requires Confirmation: true');
  if (decision.ambiguous) lines.push('Ambiguous: true');
  return lines.join('\n');
}

/**
 * Four-tier dispatcher integrating Tier 0 deterministic intent execution, Tier 1 native shell,
 * Tier 2 fast local LLM selection/execution, Tier 3 full agent/workflow orchestration,
 * and complete 13-metric latency observability via `ShellLatencyTracker`.
 */
export class FastOrchestrator {
  public readonly latencyTracker: ShellLatencyTracker;
  public readonly modelSelector: FastModelSelector;
  private cwd: string;
  private sessionMode: ShellRoutingMode;
  private debug: boolean;
  private readonly packageVersion: string;
  private readonly timeZone?: string;
  private pinnedModel?: string;
  private localOnly: boolean;
  private models: FastModelCandidate[];
  private history: string[];
  private env: Record<string, string | undefined>;
  private readonly executeShell?: FastOrchestratorOptions['executeShell'];
  private readonly executeFastLlm?: FastOrchestratorOptions['executeFastLlm'];
  private readonly executeTier3?: FastOrchestratorOptions['executeTier3'];
  private readonly tier0Providers?: FastOrchestratorOptions['tier0Providers'];
  private readonly onDebugTrace?: FastOrchestratorOptions['onDebugTrace'];

  constructor(options: FastOrchestratorOptions = {}) {
    this.latencyTracker = options.latencyTracker ?? new ShellLatencyTracker(options.maxLatencySamples ?? 2000);
    this.cwd = options.cwd ?? process.cwd();
    this.sessionMode = options.sessionMode ?? 'auto';
    this.debug = options.debug ?? false;
    this.packageVersion = options.packageVersion ?? resolveWazirPackageVersion();
    this.timeZone = options.timeZone;
    this.pinnedModel = options.pinnedModel;
    this.localOnly = options.localOnly ?? false;
    this.models = options.models ?? [];
    this.history = [...(options.history ?? [])];
    this.env = { ...(options.env ?? {}) };
    this.executeShell = options.executeShell;
    this.executeFastLlm = options.executeFastLlm;
    this.executeTier3 = options.executeTier3;
    this.tier0Providers = options.tier0Providers;
    this.onDebugTrace = options.onDebugTrace;
    this.modelSelector = new FastModelSelector({
      localOnly: this.localOnly,
      overrideModel: this.pinnedModel,
      env: this.env,
      tracker: this.latencyTracker,
    });
  }

  public isDebugEnabled(): boolean {
    return this.debug;
  }

  public setDebugEnabled(enabled: boolean): void {
    this.debug = enabled;
  }

  public getSessionMode(): ShellRoutingMode {
    return this.sessionMode;
  }

  public setSessionMode(mode: ShellRoutingMode): void {
    this.sessionMode = mode;
  }

  public getPinnedModel(): string | undefined {
    return this.pinnedModel;
  }

  public setModels(models: FastModelCandidate[]): void {
    this.models = [...models];
  }

  public classify(rawInput: string, overrideOptions: FastOrchestratorClassifyOptions = {}): RoutingDecision {
    return classifyWithFastOrchestrator(rawInput, {
      sessionMode: this.sessionMode,
      cwd: this.cwd,
      packageVersion: this.packageVersion,
      timeZone: this.timeZone,
      debugEnabled: this.debug,
      pinnedModel: this.pinnedModel,
      localOnly: this.localOnly,
      models: this.models,
      history: this.history,
      env: this.env,
      ...overrideOptions,
    });
  }

  public async execute(rawInput: string, options: FastOrchestratorDispatchOptions = {}): Promise<ExecutionResult> {
    return this.dispatch(rawInput, options);
  }

  public async dispatch(rawInput: string, options: FastOrchestratorDispatchOptions = {}): Promise<ExecutionResult> {
    const startPerf = performance.now();
    const classStart = performance.now();
    const decision = this.classify(rawInput, options);
    const classificationMs = Math.max(0, performance.now() - classStart);

    if (decision.normalizedInput) {
      this.history.push(decision.normalizedInput);
    }

    let status: 'success' | 'error' | 'cancelled' = 'success';
    let output: string | undefined;
    let error: string | undefined;
    let exitCode = 0;
    let modelSelectionMs: number | undefined;
    let modelLoadMs: number | undefined;
    let providerConnectionMs: number | undefined;
    let firstTokenMs: number | undefined;
    let shellCommandMs: number | undefined;
    let tokenThroughputTps: number | undefined;
    let outputTokens: number | undefined;
    let toolInvocationCount: number | undefined = 0;
    let timedOut: boolean | undefined;
    let model = decision.model;
    let provider = decision.provider;

    let inputToDispatchMs = Math.max(0, performance.now() - startPerf);

    if (decision.tier === 0) {
      const workStart = performance.now();
      const customProvider = decision.tier0Kind ? this.tier0Providers?.[decision.tier0Kind] : undefined;

      if (decision.handler === 'tier0-noop') {
        output = '';
      } else if (decision.tier0Kind === 'debug_toggle') {
        const modeArg = decision.tier0Payload ?? 'status';
        if (modeArg === 'on') {
          this.debug = true;
        } else if (modeArg === 'off') {
          this.debug = false;
        }
        output = `FastOrchestrator debug mode: ${this.debug ? 'on' : 'off'}`;
      } else if (decision.tier0Kind === 'route_explain') {
        const targetExpr = decision.tier0Payload ?? '';
        if (!targetExpr) {
          output = 'Usage: route <command-or-prompt>';
          status = 'error';
          exitCode = 1;
          error = 'Missing expression to route';
        } else {
          const explained = this.classify(targetExpr, options);
          output = formatRouteExplanation(explained);
        }
      } else if (decision.tier0Kind === 'latency_report') {
        const sub = decision.tier0Payload ?? '';
        if (sub === 'reset') {
          this.latencyTracker.reset();
          output = 'Latency telemetry reset.';
        } else {
          output = this.latencyTracker.formatReport({ json: sub === '--json' });
        }
      } else if (decision.tier0Kind === 'control') {
        if (/^\/mode\s+/i.test(decision.normalizedInput)) {
          const nextMode = decision.tier0Payload as ShellRoutingMode;
          this.sessionMode = nextMode;
          output = `Routing mode set to: ${this.sessionMode}`;
        } else if (/^\/model/i.test(decision.normalizedInput)) {
          const arg = decision.tier0Payload ?? '';
          if (!arg) {
            output = `Current model: ${this.pinnedModel ?? 'auto'}`;
          } else if (arg.toLowerCase() === 'auto') {
            this.pinnedModel = undefined;
            output = 'Model reset to: auto';
          } else {
            this.pinnedModel = arg;
            output = `Model pinned to: ${this.pinnedModel}`;
          }
        } else if (/^\/permissions/i.test(decision.normalizedInput)) {
          output = `Permission mode set to: ${decision.tier0Payload}`;
        }
      } else if (customProvider) {
        output = await customProvider(decision);
      } else if (
        decision.tier0Kind === 'time_now' ||
        decision.tier0Kind === 'time_today' ||
        decision.tier0Kind === 'day_today' ||
        decision.tier0Kind === 'date'
      ) {
        const now = options.now ?? new Date();
        const tz = options.timeZone ?? this.timeZone;
        if (decision.tier0Kind === 'time_now') output = formatLocalTime(now, tz);
        else if (decision.tier0Kind === 'time_today') output = formatLocalTimeAndDate(now, tz);
        else output = formatLocalDate(now, tz);
      } else if (decision.tier0Kind === 'tools') {
        const tools = discoverOptionalShellTools(this.env.PATH ?? process.env.PATH);
        output = tools
          .map((t) => `${t.name.padEnd(10)} ${t.available ? `available (${t.executablePath})` : 'not installed'}`)
          .join('\n');
      } else if (decision.tier0Kind === 'history') {
        output =
          this.history.length > 0
            ? this.history.map((entry, idx) => `${String(idx + 1).padStart(4)}  ${entry}`).join('\n')
            : 'No command history recorded yet.';
      } else if (decision.tier0Kind === 'help') {
        output = [
          `Wazir v${this.packageVersion} — FastOrchestrator 4-Tier Shell`,
          'Tier 0: time, date, version, whoami, pwd, hostname, arithmetic, debug, route, latency, help, models, jobs, status, agents, fleet, history, tools',
          'Tier 1: native OS shell commands, pipelines, ! <cmd>, \\<cmd>, os:<cmd>, sh:<cmd>',
          'Tier 2: fast local LLM conversational & explanatory queries',
          'Tier 3: agent & Wazir workflow orchestration (loop, graph, goal, inspect, pause, resume, stop)',
        ].join('\n');
      } else if (decision.tier0Kind === 'shell_builtin') {
        const cmd = decision.shellCommand ?? decision.normalizedInput;
        const lowerCmd = cmd.toLowerCase();
        if (lowerCmd === 'exit' || lowerCmd === 'quit' || lowerCmd.startsWith('exit ')) {
          const arg = cmd.slice(4).trim();
          const parsed = arg ? Number.parseInt(arg, 10) : 0;
          exitCode = Number.isNaN(parsed) ? 0 : parsed;
          output = '';
        } else if (lowerCmd === 'cd' || lowerCmd.startsWith('cd ')) {
          const targetArg = cmd.slice(2).trim() || os.homedir();
          const unquoted = unquoteSimpleShellValue(targetArg);
          const expanded = unquoted === '~'
            ? os.homedir()
            : unquoted.startsWith('~/')
              ? path.join(os.homedir(), unquoted.slice(2))
              : unquoted;
          const resolved = path.resolve(this.cwd, expanded);
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            status = 'error';
            exitCode = 1;
            error = `cd: no such directory: ${unquoted}`;
          } else {
            this.cwd = resolved;
            this.env.PWD = resolved;
            output = '';
          }
        } else if (lowerCmd.startsWith('export ')) {
          const rest = cmd.slice(7).trim();
          const eq = rest.indexOf('=');
          if (eq > 0) {
            const k = rest.slice(0, eq).trim();
            const v = unquoteSimpleShellValue(rest.slice(eq + 1));
            this.env[k] = v;
          }
          output = '';
        } else if (lowerCmd.startsWith('unset ')) {
          for (const k of cmd.slice(6).trim().split(/\s+/).filter(Boolean)) {
            delete this.env[k];
          }
          output = '';
        } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd) && !/\s/.test(cmd)) {
          const eq = cmd.indexOf('=');
          this.env[cmd.slice(0, eq).trim()] = unquoteSimpleShellValue(cmd.slice(eq + 1));
          output = '';
        } else {
          output = '';
        }
      } else {
        output = decision.tier0Payload ?? '';
      }

      const workMs = Math.max(0, performance.now() - workStart);
      const totalExecutionMs = Math.max(0, performance.now() - startPerf);
      const telemetry = this.latencyTracker.record({
        input: rawInput,
        tier: 0,
        handler: decision.handler,
        inputToDispatchMs,
        classificationMs,
        totalExecutionMs,
        orchestrationOverheadMs: Math.max(0, totalExecutionMs - workMs),
        toolInvocationCount: 0,
        status,
        ...(error ? { error } : {}),
      });
      if (this.debug) this.onDebugTrace?.(decision, telemetry);
      return { status, output, error, exitCode, durationMs: totalExecutionMs, decision, telemetry };
    }

    if (decision.tier === 1) {
      if (decision.ambiguous) {
        status = 'error';
        exitCode = 2;
        error = `Ambiguous input "${decision.normalizedInput}". Prefix with '! ' for shell or '? ' for AI.`;
        const totalExecutionMs = Math.max(0, performance.now() - startPerf);
        const telemetry = this.latencyTracker.record({
          input: rawInput,
          tier: 1,
          handler: decision.handler,
          inputToDispatchMs,
          classificationMs,
          totalExecutionMs,
          orchestrationOverheadMs: totalExecutionMs,
          toolInvocationCount: 0,
          status,
          error,
        });
        if (this.debug) this.onDebugTrace?.(decision, telemetry);
        return { status, error, exitCode, durationMs: totalExecutionMs, decision, telemetry };
      }

      const cmd = decision.shellCommand ?? decision.normalizedInput;
      const shellStart = performance.now();
      const shellRes = this.executeShell
        ? await this.executeShell(cmd, decision, options.signal)
        : await runDefaultNativeShell(cmd, this.cwd, this.env, options.signal);
      shellCommandMs = shellRes.shellCommandMs ?? Math.max(0, performance.now() - shellStart);
      output = shellRes.output;
      error = shellRes.error;
      exitCode = shellRes.exitCode ?? (shellRes.status === 'error' ? 1 : 0);
      status = shellRes.status ?? (exitCode === 0 ? 'success' : 'error');

      const totalExecutionMs = Math.max(0, performance.now() - startPerf);
      const telemetry = this.latencyTracker.record({
        input: rawInput,
        tier: 1,
        handler: decision.handler,
        inputToDispatchMs,
        classificationMs,
        shellCommandMs,
        totalExecutionMs,
        orchestrationOverheadMs: Math.max(0, totalExecutionMs - shellCommandMs),
        toolInvocationCount: 0,
        status,
        ...(error ? { error } : {}),
      });
      if (this.debug) this.onDebugTrace?.(decision, telemetry);
      return { status, output, error, exitCode, durationMs: totalExecutionMs, decision, telemetry };
    }

    if (decision.tier === 2) {
      if (this.models.length > 0 && !model) {
        const selStart = performance.now();
        const selection = this.modelSelector.select(this.models, {
          overrideModel: options.overrideModel ?? this.pinnedModel,
          localOnly: options.localOnly ?? this.localOnly,
          env: options.env ?? this.env,
        });
        modelSelectionMs = Math.max(0, performance.now() - selStart);
        model = selection.model;
        provider = selection.provider;
      }
      inputToDispatchMs = Math.max(0, performance.now() - startPerf);

      if (!this.executeFastLlm) {
        status = 'error';
        exitCode = 1;
        error = 'No Tier 2 fast local LLM executor configured';
      } else {
        const llmStart = performance.now();
        const llmRes = await this.executeFastLlm(stripAiPrefix(decision.normalizedInput), { ...decision, model, provider }, options.signal);
        const llmWorkMs = Math.max(0, performance.now() - llmStart);
        status = llmRes.status ?? 'success';
        output = llmRes.output;
        error = llmRes.error;
        exitCode = status === 'success' ? 0 : status === 'cancelled' ? 130 : 1;
        model = llmRes.model ?? model;
        provider = llmRes.provider ?? provider;
        modelSelectionMs = llmRes.modelSelectionMs ?? modelSelectionMs;
        modelLoadMs = llmRes.modelLoadMs;
        providerConnectionMs = llmRes.providerConnectionMs;
        firstTokenMs = llmRes.firstTokenMs;
        tokenThroughputTps = llmRes.tokenThroughputTps;
        outputTokens = llmRes.outputTokens;
        timedOut = llmRes.timedOut;

        const totalExecutionMs = Math.max(0, performance.now() - startPerf);
        const telemetry = this.latencyTracker.record({
          input: rawInput,
          tier: 2,
          handler: decision.handler,
          inputToDispatchMs,
          classificationMs,
          modelSelectionMs,
          modelLoadMs,
          providerConnectionMs,
          firstTokenMs,
          totalExecutionMs,
          orchestrationOverheadMs: Math.max(0, totalExecutionMs - llmWorkMs),
          tokenThroughputTps,
          outputTokens,
          toolInvocationCount: 0,
          status,
          ...(error ? { error } : {}),
          ...(timedOut !== undefined ? { timedOut } : {}),
          ...(model ? { model } : {}),
          ...(provider ? { provider } : {}),
        });
        if (this.debug) this.onDebugTrace?.(decision, telemetry);
        return {
          status,
          output,
          error,
          exitCode,
          durationMs: totalExecutionMs,
          decision: { ...decision, model, provider },
          telemetry,
        };
      }

      const totalExecutionMs = Math.max(0, performance.now() - startPerf);
      const telemetry = this.latencyTracker.record({
        input: rawInput,
        tier: 2,
        handler: decision.handler,
        inputToDispatchMs,
        classificationMs,
        modelSelectionMs,
        totalExecutionMs,
        orchestrationOverheadMs: totalExecutionMs,
        toolInvocationCount: 0,
        status,
        error,
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
      });
      if (this.debug) this.onDebugTrace?.(decision, telemetry);
      return { status, error, exitCode, durationMs: totalExecutionMs, decision: { ...decision, model, provider }, telemetry };
    }

    // Tier 3: Full agent or Wazir workflow orchestration
    if (!this.executeTier3) {
      status = 'error';
      exitCode = 1;
      error = 'No Tier 3 orchestration executor configured';
      const totalExecutionMs = Math.max(0, performance.now() - startPerf);
      const telemetry = this.latencyTracker.record({
        input: rawInput,
        tier: 3,
        handler: decision.handler,
        inputToDispatchMs,
        classificationMs,
        totalExecutionMs,
        orchestrationOverheadMs: totalExecutionMs,
        toolInvocationCount: 0,
        status,
        error,
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
      });
      if (this.debug) this.onDebugTrace?.(decision, telemetry);
      return { status, error, exitCode, durationMs: totalExecutionMs, decision, telemetry };
    }

    const tier3Start = performance.now();
    const tier3Res = await this.executeTier3(stripAiPrefix(decision.normalizedInput), decision, options.signal);
    const tier3WorkMs = Math.max(0, performance.now() - tier3Start);
    status = tier3Res.status ?? 'success';
    output = tier3Res.output;
    error = tier3Res.error;
    exitCode = tier3Res.exitCode ?? (status === 'success' ? 0 : status === 'cancelled' ? 130 : 1);
    model = tier3Res.model ?? model;
    provider = tier3Res.provider ?? provider;
    modelSelectionMs = tier3Res.modelSelectionMs;
    modelLoadMs = tier3Res.modelLoadMs;
    providerConnectionMs = tier3Res.providerConnectionMs;
    firstTokenMs = tier3Res.firstTokenMs;
    tokenThroughputTps = tier3Res.tokenThroughputTps;
    outputTokens = tier3Res.outputTokens;
    toolInvocationCount = tier3Res.toolInvocationCount ?? 0;
    timedOut = tier3Res.timedOut;

    const totalExecutionMs = Math.max(0, performance.now() - startPerf);
    const telemetry = this.latencyTracker.record({
      input: rawInput,
      tier: 3,
      handler: decision.handler,
      inputToDispatchMs,
      classificationMs,
      modelSelectionMs,
      modelLoadMs,
      providerConnectionMs,
      firstTokenMs,
      totalExecutionMs,
      orchestrationOverheadMs: Math.max(0, totalExecutionMs - tier3WorkMs),
      tokenThroughputTps,
      outputTokens,
      toolInvocationCount,
      status,
      ...(error ? { error } : {}),
      ...(timedOut !== undefined ? { timedOut } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    });
    if (this.debug) this.onDebugTrace?.(decision, telemetry);
    return {
      status,
      output,
      error,
      exitCode,
      durationMs: totalExecutionMs,
      decision: { ...decision, model, provider },
      telemetry,
    };
  }
}
