import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { Command } from 'commander';
import {
  MUTATION_TOOLS,
  ShellLatencyTracker,
  WAZIR_SHELL_COMMANDS,
  classifyShellInput,
  classifyWithFastOrchestrator,
  discoverOptionalShellTools,
  evaluateSafeArithmetic,
  formatLocalDate,
  formatLocalTime,
  formatLocalTimeAndDate,
  isPathInside,
  terminateProcessTree,
  type ExecutionPhase,
  type OptionalShellToolStatus,
  type RoutingDecision,
  type ShellPermissionMode,
  type ShellRoutingMode,
} from '@wazir/core';
import {
  discoverFastLocalEndpoints,
  getFastLatencyFilePath,
  isFastHostedFallbackPermitted,
  loadCachedFastModels,
  streamFastLocalCompletion,
  triggerBackgroundFastModelWarmup,
  type FastModelCacheEntry,
} from '../fastLlm.js';
import { resolveAuthoritativePackageVersion } from '../version.js';

export interface ShellAiOutcomeSummary {
  success: boolean;
  executionId?: string;
  modelId?: string;
  runtimeId?: string;
  computerId?: string;
  result?: string;
  errors?: string[];
  reasons?: string[];
}

export interface ShellSessionState {
  cwd: string;
  previousCwd: string;
  env: Record<string, string>;
  aliases: Record<string, string>;
  history: string[];
  historyFile?: string;
  lastExitCode: number;
  routingMode: ShellRoutingMode;
  model?: string;
  permissionMode: ShellPermissionMode;
  optionalTools: OptionalShellToolStatus[];
  activeChild?: ChildProcess;
  shouldExit?: boolean;
  lastRunId?: string;
  lastAiOutcome?: ShellAiOutcomeSummary;
  debug?: boolean;
  latencyTracker?: ShellLatencyTracker;
  stickyModels?: Partial<Record<ExecutionPhase, string>>;
  fastModels?: FastModelCacheEntry[];
}

export interface CreateShellStateOptions {
  initialCwd?: string;
  env?: Record<string, string>;
  historyFile?: string;
  routingMode?: ShellRoutingMode;
  model?: string;
  permissionMode?: ShellPermissionMode;
  debug?: boolean;
}

export function getShellConfigPath(wazirHome?: string, env: Record<string, string | undefined> = process.env): string {
  const home = wazirHome || env.WAZIR_HOME || path.join(os.homedir(), '.wazir');
  return path.join(home, 'shell-config.json');
}

export function readShellDebugFlag(wazirHome?: string, env: Record<string, string | undefined> = process.env): boolean {
  const rawEnv = env.WAZIR_SHELL_DEBUG;
  if (rawEnv === '1' || rawEnv === 'true') return true;
  if (rawEnv === '0' || rawEnv === 'false') return false;
  try {
    const cfgPath = getShellConfigPath(wazirHome, env);
    if (!fs.existsSync(cfgPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { debug?: unknown };
    return parsed?.debug === true;
  } catch {
    return false;
  }
}

export async function writeShellDebugFlagAsync(
  debug: boolean,
  wazirHome?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  try {
    const cfgPath = getShellConfigPath(wazirHome, env);
    await fs.promises.mkdir(path.dirname(cfgPath), { recursive: true });
    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.promises.readFile(cfgPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // create fresh config object
    }
    existing.debug = debug;
    existing.updatedAt = new Date().toISOString();
    await fs.promises.writeFile(cfgPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  } catch {
    // non-fatal shell config persistence error
  }
}

export function formatRouteDecisionText(decision: RoutingDecision): string {
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

export function createInitialShellState(
  initialCwdOrOpts: string | CreateShellStateOptions = process.cwd(),
): ShellSessionState {
  const opts: CreateShellStateOptions =
    typeof initialCwdOrOpts === 'string' ? { initialCwd: initialCwdOrOpts } : initialCwdOrOpts;
  const initialCwd = opts.initialCwd ?? process.cwd();
  const env: Record<string, string> = {};
  const sourceEnv = opts.env ?? process.env;
  for (const [k, v] of Object.entries(sourceEnv)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.PWD = initialCwd;
  env.WAZIR_SHELL = '1';

  const history: string[] = [];
  if (opts.historyFile && fs.existsSync(opts.historyFile)) {
    try {
      const lines = fs
        .readFileSync(opts.historyFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      history.push(...lines.slice(-1000));
    } catch {
      // ignore unreadable history file
    }
  }

  return {
    cwd: initialCwd,
    previousCwd: initialCwd,
    env,
    aliases: {},
    history,
    historyFile: opts.historyFile,
    lastExitCode: 0,
    routingMode: opts.routingMode ?? 'auto',
    model: opts.model,
    permissionMode: opts.permissionMode ?? 'auto',
    optionalTools: discoverOptionalShellTools(env.PATH),
    debug: opts.debug ?? readShellDebugFlag(env.WAZIR_HOME, env),
    latencyTracker: new ShellLatencyTracker(),
    stickyModels: {},
  };
}

function expandTilde(target: string, homeDir = os.homedir()): string {
  if (target === '~') return homeDir;
  if (target.startsWith('~/')) return path.join(homeDir, target.slice(2));
  return target;
}

function unquoteShellArg(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\\ /g, ' ');
}

/** Expands $VAR and ${VAR} references against session env unless wrapped in literal single quotes. */
export function expandShellEnv(raw: string, env: Record<string, string>): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  const unquoted = unquoteShellArg(trimmed);
  return unquoted.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? '';
      return Object.prototype.hasOwnProperty.call(env, name) ? env[name]! : '';
    },
  );
}

/** Completes Wazir commands, shell builtins, control directives, aliases, and relative/absolute filesystem paths. */
export function completeShellInput(
  line: string,
  state: Pick<ShellSessionState, 'cwd' | 'aliases' | 'env'>,
): [string[], string] {
  const builtins = [
    ...Array.from(WAZIR_SHELL_COMMANDS).map((cmd) =>
      ['loop', 'graph', 'goal', 'inspect', 'pause', 'resume', 'stop'].includes(cmd) ? `${cmd} ` : cmd,
    ),
    'cd ', 'pwd', 'export ', 'unset ', 'alias ', 'unalias ', 'tools', 'exit', 'quit',
    '/mode auto', '/mode shell', '/mode ai',
    '/model ', '/permissions ask', '/permissions auto', '/permissions read-only',
    ...Object.keys(state.aliases),
  ];

  const hasSpace = /\s/.test(line);
  const lastSpaceIdx = line.search(/\S+$/);
  const currentToken = lastSpaceIdx >= 0 ? line.slice(lastSpaceIdx) : '';

  if (!hasSpace && !currentToken.startsWith('/') && !currentToken.startsWith('./') && !currentToken.startsWith('../') && !currentToken.startsWith('~/')) {
    const unique = Array.from(new Set(builtins));
    const hits = unique.filter((c) => c.startsWith(line));
    return [hits.length ? hits : unique, line];
  }

  if (line.startsWith('/')) {
    const controlCmds = builtins.filter((b) => b.startsWith('/'));
    const hits = controlCmds.filter((c) => c.startsWith(line));
    if (hits.length > 0 || !hasSpace) {
      return [hits.length ? hits : controlCmds, line];
    }
  }

  // Complete paths relative to session cwd for arguments or explicit path prefixes.
  const token = currentToken;
  const slashIdx = token.lastIndexOf('/');
  const dirPart = slashIdx >= 0 ? token.slice(0, slashIdx + 1) : '';
  const namePrefix = slashIdx >= 0 ? token.slice(slashIdx + 1) : token;
  const homeDir = state.env.HOME || os.homedir();
  const expandedDir = dirPart ? expandTilde(dirPart, homeDir) : '.';
  const searchDir = path.resolve(state.cwd, expandedDir);

  try {
    const entries = fs.readdirSync(searchDir, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.name.startsWith(namePrefix))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => `${dirPart}${entry.name}${entry.isDirectory() ? '/' : ''}`);
    return [matches, token];
  } catch {
    return [[], token];
  }
}

export type ShellAiHandler = (
  request: string,
  state: ShellSessionState,
  signal?: AbortSignal,
  decision?: RoutingDecision,
) => Promise<number>;

export interface ExecuteShellLineOptions {
  confirmDestructiveAi?: (request: string, state: ShellSessionState) => Promise<boolean>;
  signal?: AbortSignal;
  shellExecutable?: string;
  beforeExternalCommand?: () => void;
}

function handleInProcessShellBuiltin(cmd: string, state: ShellSessionState): number | null {
  if (cmd === 'exit' || cmd === 'quit' || cmd.startsWith('exit ')) {
    const arg = cmd.slice(4).trim();
    const parsedCode = arg ? Number.parseInt(arg, 10) : state.lastExitCode;
    const code = Number.isNaN(parsedCode) ? 0 : parsedCode;
    state.lastExitCode = code;
    state.shouldExit = true;
    return code;
  }

  if (cmd === 'pwd') {
    console.log(state.cwd);
    state.lastExitCode = 0;
    return 0;
  }

  if (cmd === 'tools' || cmd === 'wa-tools') {
    state.optionalTools = discoverOptionalShellTools(state.env.PATH);
    for (const tool of state.optionalTools) {
      console.log(`${tool.name.padEnd(10)} ${tool.available ? `available (${tool.executablePath})` : 'not installed'}`);
    }
    state.lastExitCode = 0;
    return 0;
  }

  // Only handle bare `cd` in-process; chained commands like `cd dir && ls` run in child subshell
  if ((cmd === 'cd' || cmd.startsWith('cd ')) && !/[|><;&`]|\$\(|&&|\|\|/.test(cmd)) {
    const rawArg = cmd.slice(2).trim();
    const expandedArg = rawArg ? expandShellEnv(rawArg, state.env) : '~';
    const homeDir = state.env.HOME || os.homedir();
    const targetPath =
      expandedArg === '-'
        ? state.previousCwd
        : path.resolve(state.cwd, expandTilde(expandedArg || '~', homeDir));
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      console.error(`cd: no such directory: ${expandedArg || rawArg || '~'}`);
      state.lastExitCode = 1;
      return 1;
    }
    state.previousCwd = state.cwd;
    state.cwd = targetPath;
    state.env.OLDPWD = state.previousCwd;
    state.env.PWD = targetPath;
    state.lastExitCode = 0;
    return 0;
  }

  if (cmd.startsWith('export ') && !/[|><;&`]|\$\(|&&|\|\|/.test(cmd)) {
    const rest = cmd.slice(7).trim();
    const eq = rest.indexOf('=');
    if (eq > 0) {
      const k = rest.slice(0, eq).trim();
      const v = expandShellEnv(rest.slice(eq + 1), state.env);
      state.env[k] = v;
      if (k === 'PATH') {
        state.optionalTools = discoverOptionalShellTools(v);
      }
    }
    state.lastExitCode = 0;
    return 0;
  }

  if (cmd.startsWith('unset ') && !/[|><;&`]|\$\(|&&|\|\|/.test(cmd)) {
    const keys = cmd.slice(6).trim().split(/\s+/).filter(Boolean);
    for (const k of keys) {
      delete state.env[k];
    }
    state.lastExitCode = 0;
    return 0;
  }

  if (cmd.startsWith('alias ') && !/[|><;&`]|\$\(|&&|\|\|/.test(cmd)) {
    const rest = cmd.slice(6).trim();
    const eq = rest.indexOf('=');
    if (eq > 0) {
      const k = rest.slice(0, eq).trim();
      const v = unquoteShellArg(rest.slice(eq + 1));
      state.aliases[k] = v;
    }
    state.lastExitCode = 0;
    return 0;
  }

  if (cmd.startsWith('unalias ') && !/[|><;&`]|\$\(|&&|\|\|/.test(cmd)) {
    const k = cmd.slice(8).trim();
    delete state.aliases[k];
    state.lastExitCode = 0;
    return 0;
  }

  if (cmd === 'history') {
    state.history.forEach((h, i) => console.log(`${String(i + 1).padStart(4)}  ${h}`));
    state.lastExitCode = 0;
    return 0;
  }

  // Bare ENV=VALUE assignment without a command
  if (/^[A-Za-z_][A-Za-z0-9_]*=[^|><;&`]*$/.test(cmd) && !/\s/.test(cmd)) {
    const eq = cmd.indexOf('=');
    const k = cmd.slice(0, eq).trim();
    const v = expandShellEnv(cmd.slice(eq + 1), state.env);
    state.env[k] = v;
    state.lastExitCode = 0;
    return 0;
  }

  return null;
}

function hasRecordedWorkflowFiles(cwd: string, wazirHome?: string): boolean {
  const dirs = [
    path.join(cwd, '.wazir', 'workflows'),
    path.join(wazirHome || path.join(os.homedir(), '.wazir'), 'workflows'),
  ];
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).some((entry) => entry.endsWith('.json'))) {
        return true;
      }
    } catch {
      // ignore unreadable workflow directories
    }
  }
  return false;
}

export async function executeShellLine(
  line: string,
  state: ShellSessionState,
  onAiRequest?: ShellAiHandler,
  options: ExecuteShellLineOptions = {},
): Promise<number> {
  const startPerf = performance.now();
  const trimmed = line.trim();
  if (!trimmed) return 0;

  const tracker = (state.latencyTracker ??= new ShellLatencyTracker());
  state.stickyModels ??= {};

  state.history.push(trimmed);
  if (state.historyFile) {
    try {
      fs.mkdirSync(path.dirname(state.historyFile), { recursive: true });
      fs.appendFileSync(state.historyFile, `${trimmed}\n`, 'utf8');
    } catch {
      // non-fatal history persistence error
    }
  }

  // Expand simple alias on first token unless explicitly prefixed with ! or ?
  const parts = trimmed.split(/\s+/);
  const firstPart = parts[0] ?? '';
  const expanded =
    !trimmed.startsWith('!') && !trimmed.startsWith('?') && state.aliases[firstPart]
      ? `${state.aliases[firstPart]} ${parts.slice(1).join(' ')}`.trim()
      : trimmed;

  if (state.fastModels === undefined) {
    state.fastModels = loadCachedFastModels(state.env.WAZIR_HOME);
  }

  const classStart = performance.now();
  const decision = classifyWithFastOrchestrator(expanded, {
    sessionMode: state.routingMode,
    cwd: state.cwd,
    packageVersion: resolveAuthoritativePackageVersion(),
    timeZone: state.env.TZ,
    debugEnabled: state.debug,
    history: state.history,
    pinnedModel: state.model,
    models: state.fastModels.map((entry) => entry.candidate),
    env: state.env,
  });
  const classificationMs = Math.max(0, performance.now() - classStart);
  const inputToDispatchMs = Math.max(0, performance.now() - startPerf);

  if (state.debug) {
    console.log(
      `[wazir-debug] tier=${decision.tier} handler=${decision.handler} reason="${decision.reason}"${decision.model ? ` model=${decision.model}` : ''}`,
    );
  }

  const recordMetric = (
    tier: 0 | 1 | 2 | 3,
    handler: string,
    opts: {
      status?: 'success' | 'error' | 'cancelled';
      error?: string;
      workMs?: number;
      shellCommandMs?: number;
      model?: string;
      provider?: string;
    } = {},
  ) => {
    const totalExecutionMs = Math.max(0, performance.now() - startPerf);
    const workMs = opts.workMs ?? opts.shellCommandMs ?? totalExecutionMs;
    tracker.record({
      input: trimmed,
      tier,
      handler,
      inputToDispatchMs,
      classificationMs,
      totalExecutionMs,
      orchestrationOverheadMs: Math.max(0, totalExecutionMs - workMs),
      ...(opts.shellCommandMs !== undefined ? { shellCommandMs: opts.shellCommandMs } : {}),
      toolInvocationCount: 0,
      status: opts.status ?? 'success',
      ...(opts.error ? { error: opts.error } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
    });
  };

  if (decision.tier === 0) {
    const workStart = performance.now();
    switch (decision.tier0Kind) {
      case 'control': {
        const classified = classifyShellInput(expanded, state.routingMode);
        if (classified.modeChange) {
          state.routingMode = classified.modeChange;
          console.log(`[wazir-shell] Routing mode set to: ${state.routingMode}`);
        }
        if (classified.modelChange !== undefined) {
          if (!classified.modelChange) {
            console.log(`[wazir-shell] Current model: ${state.model ?? 'auto (scheduler)'}`);
          } else if (classified.modelChange.toLowerCase() === 'auto') {
            state.model = undefined;
            console.log('[wazir-shell] Model reset to: auto (scheduler)');
          } else {
            state.model = classified.modelChange;
            console.log(`[wazir-shell] Model pinned to: ${state.model}`);
          }
        }
        if (classified.permissionChange) {
          state.permissionMode = classified.permissionChange;
          console.log(`[wazir-shell] Permission mode set to: ${state.permissionMode}`);
        }
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'time_now': {
        console.log(formatLocalTime(new Date(), state.env.TZ));
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'time_today':
      case 'date': {
        console.log(formatLocalTimeAndDate(new Date(), state.env.TZ));
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'day_today': {
        console.log(formatLocalDate(new Date(), state.env.TZ));
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'version': {
        console.log(`Wazir v${resolveAuthoritativePackageVersion()}`);
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'whoami': {
        console.log(state.env.USER || state.env.LOGNAME || os.userInfo().username);
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'hostname': {
        console.log(os.hostname());
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'pwd': {
        console.log(state.cwd);
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'arithmetic': {
        const computed = decision.tier0Payload ?? (() => {
          const val = evaluateSafeArithmetic(expanded);
          return val === null ? null : String(val);
        })();
        if (computed === null) {
          console.error(`Invalid arithmetic expression: ${expanded}`);
          state.lastExitCode = 1;
          recordMetric(0, decision.handler, { status: 'error', error: 'Invalid arithmetic expression', workMs: performance.now() - workStart });
          return 1;
        }
        console.log(computed);
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'debug_toggle': {
        const modeArg = (decision.tier0Payload ?? 'status').toLowerCase();
        if (modeArg === 'on') {
          state.debug = true;
          state.env.WAZIR_SHELL_DEBUG = '1';
          void writeShellDebugFlagAsync(true, state.env.WAZIR_HOME, state.env);
        } else if (modeArg === 'off') {
          state.debug = false;
          state.env.WAZIR_SHELL_DEBUG = '0';
          void writeShellDebugFlagAsync(false, state.env.WAZIR_HOME, state.env);
        }
        console.log(`Debug mode: ${state.debug ? 'on' : 'off'}`);
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'route_explain': {
        const targetExpr = (decision.tier0Payload ?? '').trim();
        if (!targetExpr) {
          console.error('Usage: route "<command-or-prompt>"');
          state.lastExitCode = 1;
          recordMetric(0, decision.handler, { status: 'error', error: 'Missing expression to route', workMs: performance.now() - workStart });
          return 1;
        }
        const explained = classifyWithFastOrchestrator(targetExpr, {
          sessionMode: state.routingMode,
          cwd: state.cwd,
          packageVersion: resolveAuthoritativePackageVersion(),
          timeZone: state.env.TZ,
          debugEnabled: state.debug,
          history: state.history,
          pinnedModel: state.model,
          models: state.fastModels.map((entry) => entry.candidate),
          env: state.env,
        });
        console.log(formatRouteDecisionText(explained));
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'latency_report': {
        const sub = (decision.tier0Payload ?? '').trim().toLowerCase();
        const latencyPath = getFastLatencyFilePath(state.env.WAZIR_HOME);
        if (sub === 'reset') {
          tracker.reset();
          void tracker.flushToFileAsync(latencyPath);
          console.log('Latency telemetry reset.');
        } else {
          if (tracker.getSummary().totalSamples === 0) {
            tracker.loadFromFileSync(latencyPath);
          }
          console.log(tracker.formatReport({ json: sub === '--json' || sub === 'json' }));
        }
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'help': {
        console.log(shellHelpText());
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'tools': {
        state.optionalTools = discoverOptionalShellTools(state.env.PATH);
        for (const tool of state.optionalTools) {
          console.log(`${tool.name.padEnd(10)} ${tool.available ? `available (${tool.executablePath})` : 'not installed'}`);
        }
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'history': {
        const rawArgs = (decision.wazirArgs ?? '').trim();
        if (rawArgs.includes('--runs') || rawArgs.includes('--json')) {
          const code = await executeWazirShellCommand('history', rawArgs, state, onAiRequest, options);
          state.lastExitCode = code;
          recordMetric(0, decision.handler, { status: code === 0 ? 'success' : 'error', workMs: performance.now() - workStart });
          return code;
        }
        if (state.history.length === 0) {
          console.log('No command history recorded yet.');
        } else {
          state.history.forEach((entry, idx) => {
            console.log(`${String(idx + 1).padStart(4)}  ${entry}`);
          });
        }
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'models': {
        const rawArgs = (decision.wazirArgs ?? '').trim();
        const wantJson = rawArgs.includes('--json') || rawArgs.includes('-j');
        const wantRefresh = rawArgs.includes('--refresh');
        let entries = !wantRefresh && state.fastModels.length > 0 ? state.fastModels : loadCachedFastModels(state.env.WAZIR_HOME);
        if ((entries.length === 0 || wantRefresh) && state.env.WAZIR_SKIP_RUNTIME_DISCOVERY !== '1') {
          entries = await discoverFastLocalEndpoints({
            wazirHome: state.env.WAZIR_HOME,
            env: state.env,
            timeoutMs: 1200,
          });
          if (entries.length > 0) {
            state.fastModels = entries;
          }
        }
        if (entries.length > 0 && !wantJson) {
          console.log(
            `Fast local/fleet models (${entries.length}):\n` +
              entries
                .map((e) => {
                  const loadedTag = e.candidate.loaded ? 'loaded' : 'unloaded';
                  const ttft = e.candidate.measuredTtftMs !== undefined ? `, ttft=${Math.round(e.candidate.measuredTtftMs)}ms` : '';
                  const tps = e.candidate.measuredTps !== undefined ? `, tps=${e.candidate.measuredTps.toFixed(1)}` : '';
                  return `  - ${e.candidate.id} [${e.endpoint}, ${loadedTag}${ttft}${tps}]`;
                })
                .join('\n'),
          );
          state.lastExitCode = 0;
          recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
          return 0;
        }
        if (wantJson && entries.length > 0) {
          console.log(JSON.stringify(entries.map((e) => ({ id: e.candidate.id, endpoint: e.endpoint, runtimeType: e.runtimeType, loaded: e.candidate.loaded, measuredTtftMs: e.candidate.measuredTtftMs, measuredTps: e.candidate.measuredTps })), null, 2));
          state.lastExitCode = 0;
          recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
          return 0;
        }
        if (onAiRequest && state.env.WAZIR_SKIP_RUNTIME_DISCOVERY !== '1') {
          const code = await executeWazirShellCommand('models', rawArgs, state, onAiRequest, options);
          state.lastExitCode = code;
          recordMetric(0, decision.handler, { status: code === 0 ? 'success' : 'error', workMs: performance.now() - workStart });
          return code;
        }
        console.log(wantJson ? '[]' : 'No local/cached models discovered.');
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'status':
      case 'jobs': {
        const wazirCmd = decision.wazirCommand ?? decision.tier0Kind;
        const rawArgs = (decision.wazirArgs ?? '').trim();
        if (rawArgs || (wazirCmd === 'jobs' && hasRecordedWorkflowFiles(state.cwd, state.env.WAZIR_HOME))) {
          const code = await executeWazirShellCommand(wazirCmd, rawArgs, state, onAiRequest, options);
          state.lastExitCode = code;
          recordMetric(0, decision.handler, { status: code === 0 ? 'success' : 'error', workMs: performance.now() - workStart });
          return code;
        }
        if (wazirCmd === 'jobs') {
          console.log('No workflow runs recorded.');
        } else {
          const summary = tracker.getSummary();
          console.log(
            `Wazir v${resolveAuthoritativePackageVersion()} | mode=${state.routingMode} | model=${state.model ?? 'auto'} | cwd=${state.cwd} | fast-models=${state.fastModels.length} | commands=${summary.totalSamples} | debug=${state.debug ? 'on' : 'off'}`,
          );
        }
        state.lastExitCode = 0;
        recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
        return 0;
      }

      case 'agents':
      case 'fleet': {
        const wazirCmd = decision.wazirCommand ?? decision.tier0Kind;
        const code = await executeWazirShellCommand(wazirCmd, decision.wazirArgs ?? '', state, onAiRequest, options);
        state.lastExitCode = code;
        recordMetric(0, decision.handler, { status: code === 0 ? 'success' : 'error', workMs: performance.now() - workStart });
        return code;
      }

      case 'shell_builtin': {
        const builtinCmd = (decision.shellCommand ?? decision.normalizedInput).trim();
        const builtinCode = handleInProcessShellBuiltin(builtinCmd, state);
        if (builtinCode !== null) {
          recordMetric(0, decision.handler, {
            status: builtinCode === 0 ? 'success' : 'error',
            workMs: performance.now() - workStart,
          });
          return builtinCode;
        }
        break;
      }

      default: {
        if (decision.tier0Payload !== undefined) {
          if (decision.tier0Payload.length > 0) console.log(decision.tier0Payload);
          state.lastExitCode = 0;
          recordMetric(0, decision.handler, { workMs: performance.now() - workStart });
          return 0;
        }
        break;
      }
    }
  }

  if (decision.tier === 2 || decision.tier === 3) {
    if (decision.handler === 'wazir-workflow' && decision.wazirCommand) {
      const wfStart = performance.now();
      const code = await executeWazirShellCommand(
        decision.wazirCommand,
        decision.wazirArgs ?? '',
        state,
        onAiRequest,
        options,
      );
      state.lastExitCode = code;
      recordMetric(3, decision.handler, {
        status: code === 0 ? 'success' : 'error',
        workMs: performance.now() - wfStart,
      });
      void tracker.flushToFileAsync(getFastLatencyFilePath(state.env.WAZIR_HOME));
      return code;
    }

    const aiRequest = decision.normalizedInput.startsWith('?')
      ? decision.normalizedInput.slice(1).trim()
      : decision.normalizedInput;

    if (!onAiRequest) {
      console.log(`[wazir-ai] AI execution unavailable offline. Prefix with '!' to run as shell.`);
      state.lastExitCode = 1;
      recordMetric(decision.tier, decision.handler, {
        status: 'error',
        error: 'AI execution unavailable offline',
      });
      return 1;
    }

    if (decision.requiresConfirmation && options.confirmDestructiveAi) {
      const approved = await options.confirmDestructiveAi(aiRequest, state);
      if (!approved) {
        console.error(`[wazir-ai] Rejected destructive AI request: "${aiRequest}"`);
        state.lastExitCode = 130;
        recordMetric(decision.tier, decision.handler, {
          status: 'cancelled',
          error: 'Rejected destructive AI request',
        });
        return 130;
      }
    }

    const beforeCount = tracker.getSummary().totalSamples;
    const code = await onAiRequest(aiRequest, state, options.signal, decision);
    state.lastExitCode = code;
    if (tracker.getSummary().totalSamples === beforeCount) {
      recordMetric(decision.tier, decision.handler, {
        status: code === 0 ? 'success' : code === 130 ? 'cancelled' : 'error',
      });
    }
    void tracker.flushToFileAsync(getFastLatencyFilePath(state.env.WAZIR_HOME));
    return code;
  }

  // Tier 1: ambiguous or native OS shell command
  if (decision.ambiguous) {
    const ambiguousCmd = decision.shellCommand ?? decision.normalizedInput;
    const msg = `[wazir-shell] Ambiguous input: "${ambiguousCmd}". Prefix with '! ' to execute in native shell or '? ' to route to Wazir AI.`;
    console.error(msg);
    state.lastExitCode = 2;
    recordMetric(1, decision.handler, { status: 'error', error: msg });
    return 2;
  }

  const cmd = (decision.shellCommand ?? decision.normalizedInput).trim();
  if (!cmd) {
    state.lastExitCode = 0;
    return 0;
  }

  const isExplicitExternalEscape =
    expanded.startsWith('!') || /^\\[A-Za-z0-9._-]/.test(expanded) || /^(?:os|sh):/i.test(expanded);
  if (!isExplicitExternalEscape || cmd === 'history') {
    const builtinCode = handleInProcessShellBuiltin(cmd, state);
    if (builtinCode !== null) {
      recordMetric(0, 'tier0-builtin', {
        status: builtinCode === 0 ? 'success' : 'error',
      });
      return builtinCode;
    }
  }

  options.beforeExternalCommand?.();

  const defaultPosixShell = fs.existsSync('/bin/zsh')
    ? '/bin/zsh'
    : fs.existsSync('/bin/bash')
      ? '/bin/bash'
      : '/bin/sh';
  const userShell =
    options.shellExecutable ||
    state.env.SHELL ||
    process.env.SHELL ||
    (process.platform === 'win32' ? 'cmd.exe' : defaultPosixShell);
  const shellArgs = process.platform === 'win32' && /cmd(?:\.exe)?$/i.test(userShell) ? ['/d', '/s', '/c', cmd] : ['-c', cmd];

  const shellStart = performance.now();
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(userShell, shellArgs, {
      cwd: state.cwd,
      env: state.env,
      stdio: 'inherit',
    });
    state.activeChild = child;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      if (child.exitCode === null && child.signalCode === null) {
        terminateChildProcessTree(child, 'SIGINT');
        if (!escalationTimer) {
          escalationTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              void terminateProcessTree(child, { graceMs: 300 });
            }
          }, 400);
          escalationTimer.unref?.();
        }
      }
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.on('exit', (code, signal) => {
      if (escalationTimer) {
        clearTimeout(escalationTimer);
        escalationTimer = undefined;
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      state.activeChild = undefined;
      const resolvedExitCode =
        typeof code === 'number'
          ? code
          : signal === 'SIGINT'
            ? 130
            : signal === 'SIGTERM'
              ? 143
              : 1;
      state.lastExitCode = resolvedExitCode;
      resolve(resolvedExitCode);
    });
    child.on('error', (err) => {
      if (escalationTimer) {
        clearTimeout(escalationTimer);
        escalationTimer = undefined;
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      state.activeChild = undefined;
      console.error(`wazir shell error: ${err.message}`);
      state.lastExitCode = 127;
      resolve(127);
    });
  });

  const shellCommandMs = Math.max(0, performance.now() - shellStart);
  recordMetric(1, decision.handler, {
    shellCommandMs,
    workMs: shellCommandMs,
    status: exitCode === 0 ? 'success' : exitCode === 130 ? 'cancelled' : 'error',
  });
  void tracker.flushToFileAsync(getFastLatencyFilePath(state.env.WAZIR_HOME));
  return exitCode;
}

function collectDescendantPids(rootPid: number): number[] {
  if (process.platform === 'win32') return [];
  const visited = new Set<number>([rootPid]);
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
  const ordered: number[] = [];

  while (queue.length > 0 && ordered.length < 64) {
    const current = queue.shift()!;
    if (current.depth >= 5) continue;
    try {
      const out = execFileSync('pgrep', ['-P', String(current.pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split(/\s+/)) {
        const childPid = Number.parseInt(line.trim(), 10);
        if (Number.isInteger(childPid) && childPid > 0 && !visited.has(childPid)) {
          visited.add(childPid);
          ordered.push(childPid);
          queue.push({ pid: childPid, depth: current.depth + 1 });
        }
      }
    } catch {
      // pgrep exits non-zero when process has no children
    }
  }

  return ordered.reverse();
}

/** Propagates termination signals across descendant child processes before signaling the shell process. */
export function terminateChildProcessTree(
  child: ChildProcess | undefined,
  signal: NodeJS.Signals = 'SIGINT',
): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid && process.platform !== 'win32') {
    for (const descPid of collectDescendantPids(pid)) {
      try {
        process.kill(descPid, signal);
      } catch {
        // already exited
      }
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already exited
  }
}

function stripOuterQuotes(value: string): string {
  const t = value.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function shellHelpText(): string {
  return [
    'Wazir Shell — Interactive 4-Tier Native OS + Fast LLM + Agent Shell',
    '',
    'Tier 0 Instant Builtins (<50 ms):',
    '  what time is it | today | what day is today | version | pwd | whoami | hostname',
    '  2 + 2                 Safe deterministic arithmetic evaluator',
    '  models | status | jobs | agents | fleet | history | tools | help',
    '  route "<expr>"        Explain routing tier and model selection without executing',
    '  latency [--json|reset] Show 13-metric shell dispatch & inference latency report',
    '  debug on|off|status   Toggle routing/model debug trace lines',
    '',
    'Tier 3 Reserved Wazir Commands (precedence 1):',
    '  loop "<task>"         Execute an iterative bounded Loop with independent verification',
    '  graph "<goal>"        Construct & execute an acyclic DAG workflow',
    '  goal "<goal>"         Analyze intent, pick Single/Loop/Graph/Hybrid, and run',
    '  inspect | pause | resume | stop <run-id>',
    '',
    'Overrides & OS Collision Escapes:',
    '  !<cmd>, \\<cmd>, os:<cmd>, sh:<cmd>   Force OS shell execution (Tier 1)',
    '  ?<prompt>                             Force AI execution',
    '  /mode auto | shell | ai               Switch session routing mode',
    '  /model <id|auto>                      Pin or inspect AI model for this shell session',
    '  /permissions ask | auto | read-only   Set AI tool permission policy for this session',
  ].join('\n');
}

export async function executeWazirShellCommand(
  cmd: string,
  rawArgs: string,
  state: ShellSessionState,
  _aiHandler?: ShellAiHandler,
  _options?: ExecuteShellLineOptions,
): Promise<number> {
  if (cmd === 'help') {
    console.log(shellHelpText());
    return 0;
  }
  const wf = await import('../workflowRuntime.js');
  const cmds = await import('./workflowCommands.js');
  const parsed = wf.parseShellWorkflowArgs(rawArgs);
  const runOpts = {
    workspace: parsed.workspace ?? state.cwd,
    mode: parsed.mode,
    maxIterations: parsed.maxIterations,
    concurrency: parsed.concurrency,
    budget: parsed.budget,
    duration: parsed.duration,
    repairs: parsed.repairs,
    model: parsed.model ?? state.model,
    computer: parsed.computer,
    items: parsed.items,
    until: parsed.until,
    verify: parsed.verify.length > 0 ? parsed.verify : undefined,
    dryRun: parsed.dryRun,
    detach: parsed.detach || parsed.background,
    json: parsed.json,
    approveAll: parsed.approveAll,
    originInterface: 'shell' as const,
  };

  switch (cmd) {
    case 'help': {
      console.log(shellHelpText());
      return 0;
    }

    case 'history': {
      if (state.history.length === 0) {
        console.log('No command history recorded yet.');
      } else {
        state.history.forEach((entry, idx) => {
          console.log(`${String(idx + 1).padStart(4)}  ${entry}`);
        });
      }
      return 0;
    }

    case 'loop': {
      if (parsed.help || !parsed.prompt) {
        console.log('Usage: loop "<task>" [--max-iterations N] [--concurrency N] [--budget USD] [--dry-run] [--detach] [--json]');
        return parsed.help ? 0 : 1;
      }
      console.log(`[LOOP] Running workflow in ${runOpts.workspace}...`);
      const res = await cmds.loopCommand(parsed.prompt, runOpts);
      console.log(res.output);
      const data = res.data as { runId?: string } | undefined;
      if (data?.runId) (state as ShellSessionState & { lastRunId?: string }).lastRunId = data.runId;
      return res.code;
    }

    case 'graph': {
      if (parsed.help || !parsed.prompt) {
        console.log('Usage: graph "<goal>" [--concurrency N] [--budget USD] [--dry-run] [--detach] [--json]');
        return parsed.help ? 0 : 1;
      }
      console.log(`[GRAPH] Constructing DAG in ${runOpts.workspace}...`);
      const res = await cmds.graphCommand(parsed.prompt, runOpts);
      console.log(res.output);
      const data = res.data as { runId?: string } | undefined;
      if (data?.runId) (state as ShellSessionState & { lastRunId?: string }).lastRunId = data.runId;
      return res.code;
    }

    case 'goal': {
      if (parsed.help || parsed.positionals.length === 0) {
        console.log('Usage: goal [run] "<goal>" [--mode auto|single|loop|graph|hybrid] [--dry-run] [--detach] [--json]');
        return parsed.help ? 0 : 1;
      }
      const sub = parsed.positionals[0]?.toLowerCase();
      if (sub === 'run') {
        const subPrompt = parsed.positionals.slice(1).join(' ').trim();
        console.log(`[GOAL] Compiling goal in ${runOpts.workspace}...`);
        const res = await cmds.runWorkflowCommand(subPrompt, { ...runOpts, defaultRequestedMode: 'auto' });
        console.log(res.output);
        const data = res.data as { runId?: string } | undefined;
        if (data?.runId) (state as ShellSessionState & { lastRunId?: string }).lastRunId = data.runId;
        return res.code;
      }
      if (sub === 'inspect' || sub === 'status' || sub === 'pause' || sub === 'resume' || sub === 'stop') {
        return executeWazirShellCommand(
          sub,
          parsed.positionals.slice(1).join(' '),
          state,
        );
      }
      console.log(`[GOAL] Compiling goal in ${runOpts.workspace}...`);
      const res = await cmds.runWorkflowCommand(parsed.prompt, { ...runOpts, defaultRequestedMode: 'auto' });
      console.log(res.output);
      const data = res.data as { runId?: string } | undefined;
      if (data?.runId) (state as ShellSessionState & { lastRunId?: string }).lastRunId = data.runId;
      return res.code;
    }

    case 'jobs': {
      const res = await cmds.workflowJobsCommand({
        status: parsed.status,
        mode: parsed.mode,
        workspace: state.cwd,
        json: parsed.json,
      });
      console.log(res.output);
      return res.code;
    }

    case 'status': {
      const targetRunId = parsed.positionals[0] || (state as ShellSessionState & { lastRunId?: string }).lastRunId;
      if (targetRunId) {
        const res = await cmds.workflowStatusCommand(stripOuterQuotes(targetRunId), {
          workspace: state.cwd,
          json: parsed.json,
        });
        console.log(res.output);
        return res.code;
      }
      const jobsRes = await cmds.workflowJobsCommand({ workspace: state.cwd, json: parsed.json });
      console.log(jobsRes.output);
      return jobsRes.code;
    }

    case 'inspect': {
      const targetRunId = parsed.positionals[0] || (state as ShellSessionState & { lastRunId?: string }).lastRunId;
      if (!targetRunId) {
        console.error('Usage: inspect <run-id>');
        return 1;
      }
      const res = await cmds.workflowInspectCommand(stripOuterQuotes(targetRunId), {
        workspace: state.cwd,
        json: parsed.json,
      });
      console.log(res.output);
      return res.code;
    }

    case 'pause': {
      const targetRunId = parsed.positionals[0] || (state as ShellSessionState & { lastRunId?: string }).lastRunId;
      if (!targetRunId) {
        console.error('Usage: pause <run-id>');
        return 1;
      }
      const res = await cmds.workflowPauseCommand(stripOuterQuotes(targetRunId), {
        reason: parsed.reason,
        workspace: state.cwd,
        json: parsed.json,
      });
      console.log(res.output);
      return res.code;
    }

    case 'resume': {
      const targetRunId = parsed.positionals[0] || (state as ShellSessionState & { lastRunId?: string }).lastRunId;
      if (!targetRunId) {
        console.error('Usage: resume <run-id>');
        return 1;
      }
      const res = await cmds.workflowResumeCommand(stripOuterQuotes(targetRunId), {
        detach: parsed.detach || parsed.background,
        workspace: state.cwd,
        json: parsed.json,
      });
      console.log(res.output);
      return res.code;
    }

    case 'stop': {
      const targetRunId = parsed.positionals[0] || (state as ShellSessionState & { lastRunId?: string }).lastRunId;
      if (!targetRunId) {
        console.error('Usage: stop <run-id>');
        return 1;
      }
      const res = await cmds.workflowStopCommand(stripOuterQuotes(targetRunId), {
        reason: parsed.reason,
        workspace: state.cwd,
        json: parsed.json,
      });
      console.log(res.output);
      return res.code;
    }

    case 'agents':
    case 'models':
    case 'fleet': {
      const { createEngine } = await import('../engine.js');
      const engine = await createEngine({ readOnlyLifecycle: true, quiet: true, projectRoot: state.cwd });
      if (cmd === 'agents') {
        const agents = engine.agents.list();
        console.log(
          parsed.json
            ? JSON.stringify(agents, null, 2)
            : `Agents registered: ${agents.length}${agents.length ? '\n' + agents.map((a) => `  - ${a.descriptor.name} (${a.source})`).join('\n') : ''}`,
        );
        return 0;
      }
      if (cmd === 'models') {
        const models = engine.models.list();
        console.log(
          parsed.json
            ? JSON.stringify(models, null, 2)
            : `Models registered: ${models.length}${models.length ? '\n' + models.map((m) => `  - ${m.id} (${m.family})`).join('\n') : ''}`,
        );
        return 0;
      }
      const computers = engine.computers.list();
      const runtimes = engine.runtimes.list();
      const payload = { computers, runtimes };
      console.log(parsed.json ? JSON.stringify(payload, null, 2) : `Fleet: ${computers.length} computer(s), ${runtimes.length} runtime(s)`);
      return 0;
    }

    default:
      return 1;
  }
}

export interface CreateShellAiHandlerOptions {
  confirmToolApproval?: (request: { tool: string; input: unknown; reason: string }) => Promise<boolean>;
  interactive?: boolean;
  version?: string;
  fastStartup?: boolean;
  skipRuntimeDiscovery?: boolean;
}

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'rev-parse',
  'describe',
  'ls-files',
]);

function isMutatingToolRequest(tool: string, input: unknown): boolean {
  if (MUTATION_TOOLS.has(tool) || tool === 'shell' || tool === 'terminal_open' || tool === 'terminal_send') {
    return true;
  }
  if (tool === 'git') {
    const rec = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const rawArgs = rec.args;
    const sub = Array.isArray(rawArgs)
      ? String(rawArgs[0] ?? '').trim().toLowerCase()
      : String(rec.subcommand ?? rec.command ?? rawArgs ?? '')
          .trim()
          .split(/\s+/)[0]
          ?.toLowerCase() ?? '';
    return sub ? !READ_ONLY_GIT_SUBCOMMANDS.has(sub) : true;
  }
  return false;
}

const SAFE_AUTO_TEST_COMMAND_RE =
  /^(?:npm\s+(?:test|run\s+(?:test|build|lint|typecheck))(?:\s+--[A-Za-z0-9_-]+)*|node\s+(?:--experimental-strip-types\s+)?(?:--import\s+[A-Za-z0-9_./-]+\s+)?--test(?:\s+[A-Za-z0-9_./-]+)*|npx\s+(?:vitest\s+run|tsc\s+--noEmit)(?:\s+[A-Za-z0-9_./-]+)*)$/;

function stripProjectRootCdPrefix(cmd: string, projectRoot?: string): string {
  if (!projectRoot) return cmd;
  const match = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*(.+)$/.exec(cmd);
  if (!match) return cmd;
  const targetDir = unquoteShellArg(match[1]!);
  try {
    const resolvedTarget = fs.realpathSync(path.resolve(projectRoot, targetDir));
    const resolvedRoot = fs.realpathSync(projectRoot);
    if (resolvedTarget === resolvedRoot || isPathInside(resolvedRoot, resolvedTarget)) {
      return match[2]!.trim();
    }
  } catch {
    // ignore unresolvable path
  }
  return cmd;
}

/** Wraps a PolicyEngine instance so Wazir Shell's /permissions modes govern AI tool calls safely. */
export function attachShellPermissionPolicy(
  policy: import('@wazir/core').PolicyEngine,
  getPermissionMode: () => ShellPermissionMode,
  options: Pick<CreateShellAiHandlerOptions, 'confirmToolApproval' | 'interactive'> = {},
): void {
  const baseAuthorize = policy.authorize.bind(policy);
  policy.authorize = async (policyReq) => {
    const activePerm = getPermissionMode();
    if (activePerm === 'read-only' && isMutatingToolRequest(policyReq.tool, policyReq.input)) {
      const classified = policy.classify(policyReq);
      if (classified.decision === 'deny') {
        return classified;
      }
      return {
        ...classified,
        decision: 'deny',
        rule: 'shell-read-only-policy-deny',
        reasons: [
          ...classified.reasons,
          `shell permission mode 'read-only' forbids mutating tool '${policyReq.tool}'`,
        ],
      };
    }
    if (activePerm === 'ask' && isMutatingToolRequest(policyReq.tool, policyReq.input)) {
      const classified = policy.classify(policyReq);
      if (classified.decision === 'deny') {
        return classified;
      }
      const reason = `shell permission mode 'ask' requires approval for tool '${policyReq.tool}'`;
      let approved = false;
      if (options.confirmToolApproval) {
        approved = await options.confirmToolApproval({
          tool: policyReq.tool,
          input: policyReq.input,
          reason,
        });
      } else if (options.interactive && process.stdin.isTTY) {
        const { createApprover } = await import('../approve.js');
        const ans = await createApprover(policyReq, {
          ...classified,
          decision: 'ask',
          rule: 'shell-ask-mode',
          reasons: [reason],
        });
        approved = ans === true;
      }
      if (!approved) {
        return {
          ...classified,
          decision: 'deny',
          rule: 'shell-ask-mode-denied',
          reasons: [...classified.reasons, `${reason}; denied`],
        };
      }
      return {
        ...classified,
        decision: 'allow',
        rule: 'shell-ask-mode+user-approved',
        reasons: [...classified.reasons, 'approved by user in shell ask mode'],
      };
    }
    if (activePerm === 'auto' && policyReq.tool === 'shell') {
      const rawCmd = String((policyReq.input as Record<string, unknown> | undefined)?.command ?? '').trim();
      const cmd = stripProjectRootCdPrefix(rawCmd, policyReq.projectRoot);
      if (SAFE_AUTO_TEST_COMMAND_RE.test(cmd) && !/[;&|`$><\n\\]/.test(cmd)) {
        const classified = policy.classify(policyReq);
        if (classified.decision === 'ask') {
          return {
            ...classified,
            decision: 'allow',
            rule: 'shell-auto-test-runner-allow',
            reasons: [...classified.reasons, 'authorized safe workspace test/check command in shell auto permission mode'],
          };
        }
        return classified;
      }
    }
    return baseAuthorize(policyReq);
  };
}

/** Creates an AI request handler backed by RookEngine, executeTask, and shell permission policy. */
export function createShellAiHandler(handlerOpts: CreateShellAiHandlerOptions = {}): ShellAiHandler {
  const effectiveVersion = handlerOpts.version ?? resolveAuthoritativePackageVersion();
  const engineCache = new Map<string, Awaited<ReturnType<typeof import('../engine.js').createEngine>>>();
  let currentState: ShellSessionState | undefined;

  return async (
    request: string,
    s: ShellSessionState,
    signal?: AbortSignal,
    decision?: RoutingDecision,
  ): Promise<number> => {
    currentState = s;
    const wazirHome = s.env.WAZIR_HOME || process.env.WAZIR_HOME || '';
    const isDebug = Boolean(
      s.debug ||
      s.env.WAZIR_SHELL_DEBUG === '1' ||
      s.env.WAZIR_SHELL_DEBUG === 'true',
    );
    const tracker = (s.latencyTracker ??= new ShellLatencyTracker());
    s.stickyModels ??= {};

    if (isDebug) {
      console.log(`[AI] Routing request: "${request}" (cwd: ${s.cwd})`);
    }

    const requestStartPerf = performance.now();
    const classificationDecision = decision ?? classifyWithFastOrchestrator(request, {
      sessionMode: s.routingMode,
      cwd: s.cwd,
      packageVersion: effectiveVersion,
      timeZone: s.env.TZ,
      debugEnabled: isDebug,
      history: s.history,
      pinnedModel: s.model,
      env: s.env,
    });

    const isTier2Eligible =
      classificationDecision.tier === 2 &&
      !(s.model && (s.model.startsWith('nvidia/') || s.model.startsWith('external:')));

    if (isTier2Eligible) {
      const dispatchReadyPerf = performance.now();
      let streamedAnyToken = false;
      let endedWithNewline = false;

      const fastRes = await streamFastLocalCompletion(request, {
        sessionModel: s.model,
        wazirHome: wazirHome || undefined,
        env: s.env,
        signal,
        onToken: (token) => {
          streamedAnyToken = true;
          endedWithNewline = token.endsWith('\n');
          process.stdout.write(token);
        },
      });

      if (streamedAnyToken && !endedWithNewline) {
        process.stdout.write('\n');
      }

      if (fastRes.status === 'success') {
        if (!streamedAnyToken && fastRes.output?.trim()) {
          console.log(fastRes.output.trimEnd());
        }
        const totalExecutionMs = Math.max(0, performance.now() - requestStartPerf);
        const providerWorkMs = Math.max(0, totalExecutionMs - fastRes.modelSelectionMs);
        tracker.record({
          input: request,
          tier: 2,
          handler: 'fast-local-llm',
          inputToDispatchMs: Math.max(0, dispatchReadyPerf - requestStartPerf),
          classificationMs: 0,
          modelSelectionMs: fastRes.modelSelectionMs,
          modelLoadMs: fastRes.modelLoadMs,
          providerConnectionMs: fastRes.providerConnectionMs,
          firstTokenMs: fastRes.firstTokenMs,
          totalExecutionMs,
          orchestrationOverheadMs: Math.max(0, totalExecutionMs - providerWorkMs),
          tokenThroughputTps: fastRes.tokenThroughputTps,
          outputTokens: fastRes.outputTokens,
          toolInvocationCount: 0,
          status: 'success',
          model: fastRes.model,
          provider: fastRes.provider,
        });
        s.lastAiOutcome = {
          success: true,
          modelId: fastRes.model,
          runtimeId: fastRes.provider,
          computerId: fastRes.endpoint ?? 'local',
          result: fastRes.output,
        };
        if (isDebug) {
          console.log(
            `[wazir-ai] model=${fastRes.model ?? 'unknown'} runtime=${fastRes.provider ?? 'unknown'} computer=${fastRes.endpoint ?? 'local'} ttftMs=${Math.round(fastRes.firstTokenMs ?? 0)} tps=${(fastRes.tokenThroughputTps ?? 0).toFixed(1)} success=true`,
          );
        }
        void tracker.flushToFileAsync(getFastLatencyFilePath(wazirHome || undefined));
        return 0;
      }

      if (fastRes.status === 'cancelled') {
        console.error('[wazir-ai] Request cancelled.');
        const totalExecutionMs = Math.max(0, performance.now() - requestStartPerf);
        tracker.record({
          input: request,
          tier: 2,
          handler: 'fast-local-llm',
          inputToDispatchMs: Math.max(0, dispatchReadyPerf - requestStartPerf),
          classificationMs: 0,
          modelSelectionMs: fastRes.modelSelectionMs,
          totalExecutionMs,
          orchestrationOverheadMs: totalExecutionMs,
          toolInvocationCount: 0,
          status: 'cancelled',
          error: fastRes.error ?? 'cancelled',
          model: fastRes.model,
          provider: fastRes.provider,
        });
        s.lastAiOutcome = {
          success: false,
          modelId: fastRes.model,
          runtimeId: fastRes.provider,
          errors: [fastRes.error ?? 'cancelled'],
          reasons: ['cancelled'],
        };
        void tracker.flushToFileAsync(getFastLatencyFilePath(wazirHome || undefined));
        return 130;
      }

      const skipDiscovery = handlerOpts.skipRuntimeDiscovery ?? s.env.WAZIR_SKIP_RUNTIME_DISCOVERY === '1';
      const hasHostedKey = Boolean(
        s.env.NVIDIA_API_KEY ||
        s.env.NVAPI_KEY ||
        s.env.OPENAI_API_KEY ||
        s.env.ANTHROPIC_API_KEY ||
        process.env.NVIDIA_API_KEY ||
        process.env.NVAPI_KEY,
      );
      const allowHostedFallback =
        hasHostedKey &&
        isFastHostedFallbackPermitted({
          wazirHome: wazirHome || undefined,
          env: s.env,
        });
      if (skipDiscovery || s.model || !allowHostedFallback) {
        const rawErr = fastRes.error || 'No qualifying local model is available.';
        const errMsg = !s.model && /No fast local LLM/i.test(rawErr)
          ? `No AI models or providers are configured or reachable (${rawErr})`
          : rawErr;
        console.error(`[wazir-ai] ${errMsg} Native shell commands ('! <cmd>') remain operational.`);
        const totalExecutionMs = Math.max(0, performance.now() - requestStartPerf);
        tracker.record({
          input: request,
          tier: 2,
          handler: 'fast-local-llm',
          inputToDispatchMs: Math.max(0, dispatchReadyPerf - requestStartPerf),
          classificationMs: 0,
          modelSelectionMs: fastRes.modelSelectionMs,
          totalExecutionMs,
          orchestrationOverheadMs: totalExecutionMs,
          toolInvocationCount: 0,
          status: 'error',
          error: errMsg,
          timedOut: fastRes.timedOut,
          model: fastRes.model,
          provider: fastRes.provider,
        });
        s.lastAiOutcome = {
          success: false,
          modelId: fastRes.model,
          runtimeId: fastRes.provider,
          errors: [errMsg],
          reasons: [errMsg],
        };
        void tracker.flushToFileAsync(getFastLatencyFilePath(wazirHome || undefined));
        return 1;
      }
      if (isDebug) {
        console.log(`[wazir-debug] Tier 2 local LLM unavailable (${fastRes.error}); falling back to Tier 3 engine.`);
      }
    }

    const previousCwd = process.cwd();
    const prevHomeEnv = process.env.WAZIR_HOME;
    const skipDiscovery = handlerOpts.skipRuntimeDiscovery ?? s.env.WAZIR_SKIP_RUNTIME_DISCOVERY === '1';

    try {
      if (fs.existsSync(s.cwd)) {
        process.chdir(s.cwd);
      }
      if (s.env.WAZIR_HOME && s.env.WAZIR_HOME !== process.env.WAZIR_HOME) {
        process.env.WAZIR_HOME = s.env.WAZIR_HOME;
      }

      const { createEngine } = await import('../engine.js');
      const { executeTask } = await import('../run.js');
      const cacheKey = `${path.resolve(s.cwd)}::${wazirHome}::${skipDiscovery ? 'skip' : 'live'}`;
      let engine = engineCache.get(cacheKey);
      if (!engine) {
        engine = await createEngine({
          projectRoot: s.cwd,
          quiet: true,
          fastStartup: handlerOpts.fastStartup ?? true,
          skipRuntimeDiscovery: skipDiscovery,
        });
        attachShellPermissionPolicy(engine.policy, () => currentState?.permissionMode ?? 'auto', handlerOpts);
        engineCache.set(cacheKey, engine);
      }

      const registeredModels = engine.models.list();
      if (registeredModels.length === 0) {
        const msg = 'No AI models or providers are configured or reachable in this environment.';
        console.error(`[wazir-ai] ${msg} Native shell commands ('! <cmd>') remain operational.`);
        s.lastAiOutcome = { success: false, errors: [msg], reasons: [msg] };
        const totalExecutionMs = Math.max(0, performance.now() - requestStartPerf);
        tracker.record({
          input: request,
          tier: 3,
          handler: 'tier3-orchestration',
          inputToDispatchMs: totalExecutionMs,
          classificationMs: 0,
          totalExecutionMs,
          orchestrationOverheadMs: totalExecutionMs,
          toolInvocationCount: 0,
          status: 'error',
          error: msg,
        });
        return 1;
      }

      if (
        s.model &&
        !s.model.startsWith('external:') &&
        !(s.model.startsWith('nvidia/') && engine.hostedAdapters.has('nvidia')) &&
        !engine.models.get(s.model) &&
        !registeredModels.some((m) => m.id === s.model)
      ) {
        const msg = `Requested model '${s.model}' is not registered or reachable. Run 'models' to inspect available models.`;
        console.error(`[wazir-ai] ${msg}`);
        s.lastAiOutcome = { success: false, modelId: s.model, errors: [msg], reasons: [msg] };
        const totalExecutionMs = Math.max(0, performance.now() - requestStartPerf);
        tracker.record({
          input: request,
          tier: 3,
          handler: 'tier3-orchestration',
          inputToDispatchMs: totalExecutionMs,
          classificationMs: 0,
          totalExecutionMs,
          orchestrationOverheadMs: totalExecutionMs,
          toolInvocationCount: 0,
          status: 'error',
          error: msg,
          model: s.model,
        });
        return 1;
      }

      const dispatchReadyMs = Math.max(0, performance.now() - requestStartPerf);
      const stickyCodingModel = s.stickyModels?.coding;
      const runOnce = (modelOverride?: string) =>
        executeTask(engine!, request, {
          model: modelOverride ?? s.model ?? stickyCodingModel,
          agent: 'wazir-coding',
          signal,
          quiet: true,
        });

      const taskStartPerf = performance.now();
      let outcome = await runOnce();

      if (!outcome.success && !s.model) {
        s.stickyModels.coding = undefined;
        const combinedReasons = [...(outcome.errors ?? []), ...(outcome.reasons ?? [])].join(' ');
        if (/MODEL_ADMISSION_DENIED|INSUFFICIENT_MEMORY|resource exhaustion|no runtime/i.test(combinedReasons)) {
          const failedModelId = outcome.decision?.modelId;
          const loadedInstance = engine.lifecycle
            .list()
            .find(
              (inst) =>
                (inst.loaded || inst.state === 'READY' || inst.state === 'LOADED') &&
                inst.modelId !== failedModelId &&
                engine!.runtimes.get(inst.runtimeId)?.health !== 'unavailable',
            );
          if (loadedInstance) {
            outcome = await runOnce(loadedInstance.modelId);
          }
        }
      }

      const taskWorkMs = Math.max(0, performance.now() - taskStartPerf);
      const dec = outcome.decision;
      const modelId = dec?.modelId ?? s.model ?? 'unknown';
      const runtimeId = dec?.runtimeId ?? 'unknown';
      const computerId = dec?.computerId ?? (runtimeId === 'nvidia' ? 'hosted(nvidia)' : 'local');
      if (outcome.success && dec?.modelId && !s.model) {
        s.stickyModels.coding = dec.modelId;
      }
      s.lastAiOutcome = {
        success: outcome.success,
        executionId: outcome.executionId,
        modelId,
        runtimeId,
        computerId,
        result: outcome.result,
        errors: outcome.errors,
        reasons: outcome.reasons,
      };

      const totalExecutionMs = Math.max(0, performance.now() - requestStartPerf);
      tracker.record({
        input: request,
        tier: 3,
        handler: 'tier3-orchestration',
        inputToDispatchMs: dispatchReadyMs,
        classificationMs: 0,
        totalExecutionMs,
        orchestrationOverheadMs: Math.max(0, totalExecutionMs - taskWorkMs),
        toolInvocationCount: 0,
        status: outcome.success ? 'success' : signal?.aborted ? 'cancelled' : 'error',
        ...(outcome.errors?.length ? { error: outcome.errors.join(' | ') } : {}),
        model: modelId !== 'unknown' ? modelId : undefined,
        provider: runtimeId !== 'unknown' ? runtimeId : undefined,
      });
      void tracker.flushToFileAsync(getFastLatencyFilePath(wazirHome || undefined));

      if (isDebug) {
        console.log(
          `[wazir-ai] model=${modelId} runtime=${runtimeId} computer=${computerId} executionId=${outcome.executionId} success=${outcome.success}`,
        );
      }
      if (outcome.result && outcome.result.trim()) {
        console.log(outcome.result.trimEnd());
      }
      if (!outcome.success) {
        const details = [...(outcome.errors ?? []), ...(outcome.reasons ?? [])].filter(Boolean);
        console.error(`[wazir-ai] Failed: ${details.length > 0 ? details.join(' | ') : 'Task completed without output.'}`);
        return signal?.aborted ? 130 : 1;
      }
      if (!outcome.result || !outcome.result.trim()) {
        console.log('(completed)');
      }
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wazir-ai] Execution failed: ${msg}`);
      s.lastAiOutcome = { success: false, errors: [msg], reasons: [msg] };
      const totalExecutionMs = Math.max(0, performance.now() - requestStartPerf);
      tracker.record({
        input: request,
        tier: 3,
        handler: 'tier3-orchestration',
        inputToDispatchMs: totalExecutionMs,
        classificationMs: 0,
        totalExecutionMs,
        orchestrationOverheadMs: totalExecutionMs,
        toolInvocationCount: 0,
        status: signal?.aborted ? 'cancelled' : 'error',
        error: msg,
      });
      void tracker.flushToFileAsync(getFastLatencyFilePath(wazirHome || undefined));
      try {
        const { DiagnosticQueue } = await import('@wazir/observability');
        const diag = new DiagnosticQueue();
        diag.enqueue({
          appVersion: effectiveVersion,
          errorCode: 'ERR_SHELL_AI_EXEC',
          failureCategory: 'command_routing',
          component: 'wa-shell',
          exceptionCategory: err instanceof Error ? err.name : 'Error',
          taskPhase: 'execute',
        });
      } catch {
        // non-fatal diagnostics error
      }
      return signal?.aborted ? 130 : 1;
    } finally {
      if (prevHomeEnv === undefined) {
        delete process.env.WAZIR_HOME;
      } else {
        process.env.WAZIR_HOME = prevHomeEnv;
      }
      try {
        process.chdir(previousCwd);
      } catch {
        // ignore restore errors
      }
    }
  };
}

export async function launchInteractiveWazirShell(options: {
  command?: string;
  ai?: boolean;
  tools?: boolean;
  version?: string;
  batch?: boolean;
  model?: string;
  permissions?: string;
  debug?: boolean;
} = {}): Promise<void> {
  const effectiveVersion =
    options.version && options.version !== '0.3.1' ? options.version : resolveAuthoritativePackageVersion();
  const wazirHome = process.env.WAZIR_HOME || path.join(os.homedir(), '.wazir');
  const rawPerm = options.permissions?.trim().toLowerCase();
  if (rawPerm && rawPerm !== 'ask' && rawPerm !== 'auto' && rawPerm !== 'read-only') {
    console.error(`[wazir-shell] Invalid permission mode '${options.permissions}'. Expected: ask | auto | read-only`);
    process.exitCode = 1;
    return;
  }
  const permissionMode: ShellPermissionMode =
    rawPerm === 'ask' || rawPerm === 'read-only' ? rawPerm : 'auto';
  const state = createInitialShellState({
    initialCwd: process.cwd(),
    historyFile: path.join(wazirHome, 'shell_history'),
    model: options.model,
    permissionMode,
    debug: options.debug,
  });

  if (options.tools) {
    for (const tool of state.optionalTools) {
      console.log(`${tool.name.padEnd(10)} ${tool.available ? `available (${tool.executablePath})` : 'not installed'}`);
    }
    return;
  }

  const aiHandler = options.ai === false
    ? undefined
    : createShellAiHandler({
        interactive: !options.command && !options.batch && Boolean(process.stdin.isTTY),
        version: effectiveVersion,
      });

  if (options.command) {
    const code = await executeShellLine(options.command, state, aiHandler);
    await state.latencyTracker?.flushToFileAsync(getFastLatencyFilePath(wazirHome)).catch(() => undefined);
    process.exitCode = code;
    return;
  }

  if (options.batch || !process.stdin.isTTY) {
    const rlBatch = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
    for await (const line of rlBatch) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await executeShellLine(trimmed, state, aiHandler);
      if (state.shouldExit) break;
    }
    await state.latencyTracker?.flushToFileAsync(getFastLatencyFilePath(wazirHome)).catch(() => undefined);
    process.exitCode = state.lastExitCode;
    return;
  }

  // Non-blocking background discovery to keep local LLM cache warm without delaying Tier 0
  if (options.ai !== false) {
    void triggerBackgroundFastModelWarmup({ wazirHome, env: state.env });
  }

  const availableEnhancements = state.optionalTools.filter((t) => t.available).map((t) => t.name);
  console.log(`Wazir Shell v${effectiveVersion} — Fast 4-Tier OS + Local LLM + Agent Shell`);
  console.log(`Instant:  what time is it | version | pwd | 2+2 | route | latency | debug on|off`);
  console.log(`Escapes:  '! <cmd>' / '\\<cmd>' / 'os:<cmd>' for OS shell · '? <req>' for AI · '/mode <auto|shell|ai>'`);
  if (availableEnhancements.length > 0) {
    console.log(`Detected tools: ${availableEnhancements.join(', ')}\n`);
  } else {
    console.log('');
  }

  const completer = (line: string): [string[], string] => completeShellInput(line, state);

  const onSigint = () => {
    if (state.activeChild && state.activeChild.exitCode === null) {
      terminateChildProcessTree(state.activeChild, 'SIGINT');
    }
  };
  process.on('SIGINT', onSigint);

  // Persistent readline session across Tier 0/2/3 commands; closes and yields TTY cleanly before Tier 1 child processes.
  let rl: readline.Interface | undefined;
  let eofReached = false;
  const lineQueue: string[] = [];
  let lineWaiter: ((res: { type: 'line'; value: string } | { type: 'eof' }) => void) | undefined;

  const closeActiveRl = () => {
    if (!rl) return;
    const current = rl;
    rl = undefined;
    current.removeAllListeners();
    current.close();
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
  };

  const ensureRl = (): readline.Interface => {
    if (rl) return rl;
    const instance = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer,
      history: [...state.history].reverse(),
      historySize: 1000,
    });
    instance.on('SIGINT', () => {
      if (state.activeChild && state.activeChild.exitCode === null) {
        terminateChildProcessTree(state.activeChild, 'SIGINT');
        return;
      }
      console.log('^C');
      instance.prompt();
    });
    instance.on('line', (rawLine) => {
      if (lineWaiter) {
        const resolve = lineWaiter;
        lineWaiter = undefined;
        resolve({ type: 'line', value: rawLine });
      } else {
        lineQueue.push(rawLine);
      }
    });
    instance.on('close', () => {
      if (rl === instance) {
        rl = undefined;
      }
      eofReached = true;
      if (lineWaiter) {
        const resolve = lineWaiter;
        lineWaiter = undefined;
        resolve({ type: 'eof' });
      }
    });
    rl = instance;
    return instance;
  };

  try {
    while (!state.shouldExit) {
      const promptText = `wa:${path.basename(state.cwd) || '/'}$ `;
      let lineResult: { type: 'line'; value: string } | { type: 'eof' };

      if (lineQueue.length > 0) {
        lineResult = { type: 'line', value: lineQueue.shift()! };
      } else if (eofReached) {
        lineResult = { type: 'eof' };
      } else {
        const activeRl = ensureRl();
        activeRl.setPrompt(promptText);
        process.stdin.resume();
        activeRl.resume();
        activeRl.prompt();
        lineResult = await new Promise<{ type: 'line'; value: string } | { type: 'eof' }>((resolve) => {
          if (lineQueue.length > 0) {
            resolve({ type: 'line', value: lineQueue.shift()! });
            return;
          }
          lineWaiter = resolve;
        });
      }

      if (lineResult.type === 'eof') {
        break;
      }

      if (rl) {
        rl.pause();
      }

      const trimmed = lineResult.value.trim();
      await executeShellLine(trimmed, state, aiHandler, {
        beforeExternalCommand: closeActiveRl,
      });
      if (state.shouldExit) {
        break;
      }
    }
  } finally {
    closeActiveRl();
    process.removeListener('SIGINT', onSigint);
    await state.latencyTracker?.flushToFileAsync(getFastLatencyFilePath(wazirHome)).catch(() => undefined);
  }
  process.exitCode = state.lastExitCode;
}

export async function runFastRouteCli(promptParts: string[], options: { json?: boolean; mode?: ShellRoutingMode } = {}): Promise<number> {
  const expr = promptParts.join(' ').trim();
  if (!expr) {
    console.error('Usage: wa route "<command-or-prompt>"');
    return 1;
  }
  const cachedModels = loadCachedFastModels();
  const decision = classifyWithFastOrchestrator(expr, {
    sessionMode: options.mode ?? 'auto',
    cwd: process.cwd(),
    packageVersion: resolveAuthoritativePackageVersion(),
    timeZone: process.env.TZ,
    models: cachedModels.map((entry) => entry.candidate),
    env: process.env,
  });
  if (options.json) {
    console.log(JSON.stringify(decision, null, 2));
  } else {
    console.log(formatRouteDecisionText(decision));
  }
  return 0;
}

export async function runFastLatencyCli(options: { json?: boolean; reset?: boolean } = {}): Promise<number> {
  const tracker = new ShellLatencyTracker();
  const latencyPath = getFastLatencyFilePath();
  if (options.reset) {
    tracker.reset();
    await tracker.flushToFileAsync(latencyPath);
    console.log('Latency telemetry reset.');
    return 0;
  }
  tracker.loadFromFileSync(latencyPath);
  console.log(tracker.formatReport({ json: options.json }));
  return 0;
}

export async function runFastDebugCli(action: string = 'status'): Promise<number> {
  const normalized = action.trim().toLowerCase();
  if (normalized !== 'on' && normalized !== 'off' && normalized !== 'status') {
    console.error(`Usage: wa debug <on|off|status> (got '${action}')`);
    return 1;
  }
  if (normalized === 'on') {
    await writeShellDebugFlagAsync(true);
    console.log('Debug mode: on');
    return 0;
  }
  if (normalized === 'off') {
    await writeShellDebugFlagAsync(false);
    console.log('Debug mode: off');
    return 0;
  }
  console.log(`Debug mode: ${readShellDebugFlag() ? 'on' : 'off'}`);
  return 0;
}

export function registerShellAndMetaCommands(program: Command, cliVersion?: string): void {
  const effectiveVersion = cliVersion && cliVersion !== '0.3.1' ? cliVersion : resolveAuthoritativePackageVersion();

  program
    .command('shell')
    .description('Launch the universal AI-native Wazir Shell (! for shell, ? for AI, auto by default)')
    .option('-c, --command <cmd>', 'Execute a single command or natural-language request and exit')
    .option('--no-ai', 'Run strictly in offline native-shell mode')
    .option('--tools', 'List discovered optional shell enhancement tools (fzf, zoxide, rg, bat, atuin, lazygit) and exit')
    .option('-m, --model <model>', 'Pin a specific model ID for AI and workflow commands in the shell session')
    .option('--permissions <mode>', 'Set AI tool permission mode: ask | auto | read-only')
    .option('--debug', 'Enable FastOrchestrator routing and latency debug traces')
    .action(async (options: { command?: string; ai?: boolean; tools?: boolean; model?: string; permissions?: string; debug?: boolean }) => {
      await launchInteractiveWazirShell({ ...options, version: effectiveVersion });
    });

  program
    .command('route <prompt...>')
    .description('Explain which FastOrchestrator tier and model handles a command or prompt without executing it')
    .option('-j, --json', 'Output routing decision as JSON')
    .action(async (promptParts: string[], opts: { json?: boolean }) => {
      process.exitCode = await runFastRouteCli(promptParts, opts);
    });

  program
    .command('latency')
    .description('Display recorded FastOrchestrator dispatch and execution latency percentiles')
    .option('-j, --json', 'Output latency metrics as JSON')
    .option('--reset', 'Reset stored shell latency metrics')
    .action(async (opts: { json?: boolean; reset?: boolean }) => {
      process.exitCode = await runFastLatencyCli(opts);
    });

  program
    .command('debug [state]')
    .description('Inspect or toggle persistent shell routing debug traces (on | off | status)')
    .action(async (stateArg: string = 'status') => {
      process.exitCode = await runFastDebugCli(stateArg);
    });

  program
    .command('about')
    .description('Display Wazir AI OS version, attribution, credits, and licensing summary')
    .option('-j, --json', 'Output JSON')
    .action((options: { json?: boolean }) => {
      const info = {
        name: 'Wazir AI OS',
        version: effectiveVersion,
        repository: 'https://github.com/whassan007/wazir',
        website: 'https://wazir.wael.bot',
        author: 'Wael Hassan (whassan007)',
        license: 'AGPL-3.0-only (existing core/CLI/API); source-available noncommercial + commercial authorization for new standalone modules',
        thirdParty: 'Includes selective Apache-2.0 components adapted from QwenLM/qwen-code',
      };
      if (options.json) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      console.log(`${info.name} v${info.version}`);
      console.log(`Author:     ${info.author}`);
      console.log(`Repository: ${info.repository}`);
      console.log(`Website:    ${info.website}`);
      console.log(`License:    ${info.license}`);
      console.log(`Notices:    ${info.thirdParty}`);
    });

  program
    .command('license')
    .description('Show Wazir AI OS license, commercial authorization, and third-party notices')
    .action(() => {
      console.log('Wazir AI OS Licensing Summary');
      console.log('----------------------------');
      console.log('1. Existing Core/CLI/API/Desktop/Mobile: GNU Affero General Public License v3.0 (AGPL-3.0-only).');
      console.log('2. Selective Qwen Code Transplant: Apache-2.0 (Alibaba Group / QwenLM).');
      console.log('3. Commercial Authorization: Required for commercial deployment of Wazir-branded noncommercial modules.');
      console.log('   Request commercial authorization at: https://wazir.wael.bot/licensing');
    });

  const diag = program.command('diagnostics').description('Manage Wazir diagnostic consent and local event queue');
  diag
    .command('status')
    .description('Show current diagnostic consent and local queue status')
    .action(async () => {
      const obs = await import('@wazir/observability');
      const record = obs.readConsentRecord();
      const queue = new obs.DiagnosticQueue();
      console.log(JSON.stringify({
        noticeVersion: obs.DIAGNOSTIC_NOTICE_VERSION,
        accepted: obs.hasAcceptedDiagnostics(),
        record,
        queuedEvents: queue.readAllValid().length,
      }, null, 2));
    });
  diag
    .command('notice')
    .description('Print the first-launch diagnostic & licensing disclosure')
    .action(async () => {
      const obs = await import('@wazir/observability');
      console.log(obs.getFirstLaunchDisclosureText());
    });
  diag
    .command('accept')
    .option('--rich', 'Also opt in to rich analytics')
    .description('Record affirmative acceptance of diagnostic terms')
    .action(async (opts: { rich?: boolean }) => {
      const obs = await import('@wazir/observability');
      const rec = obs.recordConsentAcceptance({ richAnalytics: Boolean(opts.rich) });
      console.log(`Diagnostics consent accepted (version ${rec.noticeVersion}, id ${rec.installationId}).`);
    });
  diag
    .command('decline')
    .description('Decline diagnostic telemetry (disables all diagnostic event collection)')
    .action(async () => {
      const obs = await import('@wazir/observability');
      obs.recordConsentDecline();
      new obs.DiagnosticQueue().clear();
      console.log('Diagnostics declined. Telemetry disabled and local queue cleared.');
    });
  diag
    .command('purge')
    .description('Clear local diagnostic event queue')
    .action(async () => {
      const obs = await import('@wazir/observability');
      new obs.DiagnosticQueue().clear();
      console.log('Local diagnostic queue purged.');
    });
}
