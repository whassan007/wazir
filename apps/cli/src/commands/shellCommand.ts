import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import type { Command } from 'commander';
import {
  MUTATION_TOOLS,
  WAZIR_SHELL_COMMANDS,
  classifyShellInput,
  discoverOptionalShellTools,
  isPathInside,
  terminateProcessTree,
  type OptionalShellToolStatus,
  type ShellPermissionMode,
  type ShellRoutingMode,
} from '@wazir/core';
import {
  DIAGNOSTIC_NOTICE_VERSION,
  DiagnosticQueue,
  getFirstLaunchDisclosureText,
  hasAcceptedDiagnostics,
  readConsentRecord,
  recordConsentAcceptance,
  recordConsentDecline,
} from '@wazir/observability';
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
}

export interface CreateShellStateOptions {
  initialCwd?: string;
  env?: Record<string, string>;
  historyFile?: string;
  routingMode?: ShellRoutingMode;
  model?: string;
  permissionMode?: ShellPermissionMode;
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
) => Promise<number>;

export interface ExecuteShellLineOptions {
  confirmDestructiveAi?: (request: string, state: ShellSessionState) => Promise<boolean>;
  signal?: AbortSignal;
  shellExecutable?: string;
}

export async function executeShellLine(
  line: string,
  state: ShellSessionState,
  onAiRequest?: ShellAiHandler,
  options: ExecuteShellLineOptions = {},
): Promise<number> {
  const trimmed = line.trim();
  if (!trimmed) return 0;
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

  const classified = classifyShellInput(expanded, state.routingMode);

  if (classified.mode === 'control') {
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
    return 0;
  }

  if (classified.mode === 'wazir' && classified.wazirCommand) {
    const code = await executeWazirShellCommand(
      classified.wazirCommand,
      classified.wazirArgs ?? '',
      state,
      onAiRequest,
      options,
    );
    state.lastExitCode = code;
    return code;
  }

  if (classified.mode === 'ambiguous') {
    console.error(
      `[wazir-shell] Ambiguous input: "${classified.command}". Prefix with '! ' to execute in native shell or '? ' to route to Wazir AI.`,
    );
    state.lastExitCode = 2;
    return 2;
  }

  if (classified.mode === 'ai') {
    if (!onAiRequest) {
      console.log(`[wazir-ai] AI execution unavailable offline. Prefix with '!' to run as shell.`);
      state.lastExitCode = 1;
      return 1;
    }
    if (classified.requiresConfirmation && options.confirmDestructiveAi) {
      const approved = await options.confirmDestructiveAi(classified.command, state);
      if (!approved) {
        console.error(`[wazir-ai] Rejected destructive AI request: "${classified.command}"`);
        state.lastExitCode = 130;
        return 130;
      }
    }
    const code = await onAiRequest(classified.command, state, options.signal);
    state.lastExitCode = code;
    return code;
  }

  const cmd = classified.command;
  if (!cmd) {
    state.lastExitCode = 0;
    return 0;
  }

  // Handle exit / quit builtins
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

  // Builtin inspection of optional developer tools (never auto-installs anything)
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

  return new Promise<number>((resolve) => {
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
      const exitCode =
        typeof code === 'number'
          ? code
          : signal === 'SIGINT'
            ? 130
            : signal === 'SIGTERM'
              ? 143
              : 1;
      state.lastExitCode = exitCode;
      resolve(exitCode);
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
    'Wazir Shell — Interactive Native OS + AI + Loop + Graph + Goal Shell',
    '',
    'Reserved Wazir Commands (precedence 1):',
    '  loop "<task>"         Execute an iterative bounded Loop with independent verification',
    '  graph "<goal>"        Construct & execute an acyclic DAG workflow',
    '  goal "<goal>"         Analyze intent, pick Single/Loop/Graph/Hybrid, and run',
    '  jobs                  List persistent Loop/Graph/Goal runs across Shell, CLI & Web',
    '  status [run-id]       Show workflow or workspace runtime status',
    '  inspect <run-id>      Inspect DAG, Loop cursor, targets, blockers & evidence',
    '  pause <run-id>        Pause an active run cleanly in the shared store',
    '  resume <run-id>       Resume a paused run from its durable checkpoint',
    '  stop <run-id>         Stop an active or paused run cleanly',
    '  agents | models | fleet   Inspect live fleet registries',
    '  history [--runs]      Show shell command history',
    '  help                  Show this help screen',
    '',
    'Overrides & OS Collision Escapes:',
    '  !<cmd>, \\<cmd>, os:<cmd>, sh:<cmd>   Force OS shell execution (bypass Wazir commands)',
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
  _aiHandler?: (request: string, state: ShellSessionState) => Promise<number>,
  _options?: ExecuteShellLineOptions,
): Promise<number> {
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

  return async (request: string, s: ShellSessionState, signal?: AbortSignal): Promise<number> => {
    currentState = s;
    console.log(`[AI] Routing request: "${request}" (cwd: ${s.cwd})`);
    const previousCwd = process.cwd();
    const wazirHome = s.env.WAZIR_HOME || process.env.WAZIR_HOME || '';
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
        return 1;
      }

      const runOnce = (modelOverride?: string) =>
        executeTask(engine!, request, {
          model: modelOverride ?? s.model,
          agent: 'wazir-coding',
          signal,
          quiet: true,
        });

      let outcome = await runOnce();

      if (!outcome.success && !s.model) {
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

      const dec = outcome.decision;
      const modelId = dec?.modelId ?? s.model ?? 'unknown';
      const runtimeId = dec?.runtimeId ?? 'unknown';
      const computerId = dec?.computerId ?? (runtimeId === 'nvidia' ? 'hosted(nvidia)' : 'local');
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

      console.log(
        `[wazir-ai] model=${modelId} runtime=${runtimeId} computer=${computerId} executionId=${outcome.executionId} success=${outcome.success}`,
      );
      if (outcome.result && outcome.result.trim()) {
        console.log(outcome.result.trimEnd());
      }
      if (!outcome.success) {
        const details = [...(outcome.errors ?? []), ...(outcome.reasons ?? [])].filter(Boolean);
        if (details.length > 0) {
          console.error(`[wazir-ai] Failed: ${details.join(' | ')}`);
        }
        return signal?.aborted ? 130 : 1;
      }
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wazir-ai] Execution failed: ${msg}`);
      s.lastAiOutcome = { success: false, errors: [msg], reasons: [msg] };
      const diag = new DiagnosticQueue();
      diag.enqueue({
        appVersion: effectiveVersion,
        errorCode: 'ERR_SHELL_AI_EXEC',
        failureCategory: 'command_routing',
        component: 'wa-shell',
        exceptionCategory: err instanceof Error ? err.name : 'Error',
        taskPhase: 'execute',
      });
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
    process.exitCode = state.lastExitCode;
    return;
  }

  const availableEnhancements = state.optionalTools.filter((t) => t.available).map((t) => t.name);
  console.log(`Wazir Shell v${effectiveVersion} — Native OS + AI + Loop + Graph + Goal Shell`);
  console.log(`Reserved: loop | graph | goal | jobs | status | inspect | pause | resume | stop | help`);
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

  try {
    while (!state.shouldExit) {
      const promptText = `wazir:${path.basename(state.cwd) || '/'}$ `;
      const lineResult = await new Promise<{ type: 'line'; value: string } | { type: 'eof' }>((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: promptText,
          completer,
          history: [...state.history].reverse(),
        });
        let settled = false;
        rl.on('SIGINT', () => {
          console.log('^C');
          rl.prompt();
        });
        rl.on('line', (rawLine) => {
          if (settled) return;
          settled = true;
          rl.close();
          if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
            process.stdin.setRawMode(false);
          }
          resolve({ type: 'line', value: rawLine });
        });
        rl.on('close', () => {
          if (settled) return;
          settled = true;
          resolve({ type: 'eof' });
        });
        rl.prompt();
      });

      if (lineResult.type === 'eof') {
        break;
      }

      const trimmed = lineResult.value.trim();
      await executeShellLine(trimmed, state, aiHandler);
      if (state.shouldExit) {
        break;
      }
      process.stdin.resume();
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
  process.exitCode = state.lastExitCode;
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
    .action(async (options: { command?: string; ai?: boolean; tools?: boolean; model?: string; permissions?: string }) => {
      await launchInteractiveWazirShell({ ...options, version: effectiveVersion });
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
    .action(() => {
      const record = readConsentRecord();
      const queue = new DiagnosticQueue();
      console.log(JSON.stringify({
        noticeVersion: DIAGNOSTIC_NOTICE_VERSION,
        accepted: hasAcceptedDiagnostics(),
        record,
        queuedEvents: queue.readAllValid().length,
      }, null, 2));
    });
  diag
    .command('notice')
    .description('Print the first-launch diagnostic & licensing disclosure')
    .action(() => {
      console.log(getFirstLaunchDisclosureText());
    });
  diag
    .command('accept')
    .option('--rich', 'Also opt in to rich analytics')
    .description('Record affirmative acceptance of diagnostic terms')
    .action((opts: { rich?: boolean }) => {
      const rec = recordConsentAcceptance({ richAnalytics: Boolean(opts.rich) });
      console.log(`Diagnostics consent accepted (version ${rec.noticeVersion}, id ${rec.installationId}).`);
    });
  diag
    .command('decline')
    .description('Decline diagnostic telemetry (disables all diagnostic event collection)')
    .action(() => {
      recordConsentDecline();
      new DiagnosticQueue().clear();
      console.log('Diagnostics declined. Telemetry disabled and local queue cleared.');
    });
  diag
    .command('purge')
    .description('Clear local diagnostic event queue')
    .action(() => {
      new DiagnosticQueue().clear();
      console.log('Local diagnostic queue purged.');
    });
}
