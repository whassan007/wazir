import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Command } from 'commander';
import {
  classifyShellInput,
  discoverOptionalShellTools,
  type OptionalShellToolStatus,
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

export interface ShellSessionState {
  cwd: string;
  previousCwd: string;
  env: Record<string, string>;
  aliases: Record<string, string>;
  history: string[];
  historyFile?: string;
  lastExitCode: number;
  routingMode: ShellRoutingMode;
  optionalTools: OptionalShellToolStatus[];
  activeChild?: ChildProcess;
  shouldExit?: boolean;
}

export interface CreateShellStateOptions {
  initialCwd?: string;
  env?: Record<string, string>;
  historyFile?: string;
  routingMode?: ShellRoutingMode;
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

export interface ExecuteShellLineOptions {
  confirmDestructiveAi?: (request: string, state: ShellSessionState) => Promise<boolean>;
  signal?: AbortSignal;
  shellExecutable?: string;
}

export async function executeShellLine(
  line: string,
  state: ShellSessionState,
  onAiRequest?: (request: string, state: ShellSessionState) => Promise<number>,
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
    state.lastExitCode = 0;
    return 0;
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
    const code = await onAiRequest(classified.command, state);
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
    const unquoted = rawArg ? unquoteShellArg(rawArg) : '~';
    const homeDir = state.env.HOME || os.homedir();
    const targetPath =
      unquoted === '-'
        ? state.previousCwd
        : path.resolve(state.cwd, expandTilde(unquoted, homeDir));
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      console.error(`cd: no such directory: ${rawArg || '~'}`);
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
      const v = unquoteShellArg(rest.slice(eq + 1));
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
    const v = unquoteShellArg(cmd.slice(eq + 1));
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

    const onAbort = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGINT');
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
    model: parsed.model,
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
      const { createStore } = await import('../engine.js');
      const { AgentRegistry, ComputerRegistry, ModelRegistry, RuntimeRegistry } = await import('@wazir/core');
      const store = await createStore();
      if (cmd === 'agents') {
        const agents = await new AgentRegistry(store).list();
        console.log(parsed.json ? JSON.stringify(agents, null, 2) : `Agents registered: ${agents.length}${agents.length ? '\n' + agents.map((a) => `  - ${a.id} (${a.status})`).join('\n') : ''}`);
        return 0;
      }
      if (cmd === 'models') {
        const models = await new ModelRegistry(store).list();
        console.log(parsed.json ? JSON.stringify(models, null, 2) : `Models registered: ${models.length}${models.length ? '\n' + models.map((m) => `  - ${m.id} (${m.family})`).join('\n') : ''}`);
        return 0;
      }
      const computers = await new ComputerRegistry(store).list();
      const runtimes = await new RuntimeRegistry(store).list();
      const payload = { computers, runtimes };
      console.log(parsed.json ? JSON.stringify(payload, null, 2) : `Fleet: ${computers.length} computer(s), ${runtimes.length} runtime(s)`);
      return 0;
    }

    default:
      return 1;
  }
}

export async function launchInteractiveWazirShell(options: {
  command?: string;
  ai?: boolean;
  tools?: boolean;
  version?: string;
  batch?: boolean;
} = {}): Promise<void> {
  const effectiveVersion =
    options.version && options.version !== '0.3.1' ? options.version : resolveAuthoritativePackageVersion();
  const wazirHome = process.env.WAZIR_HOME || path.join(os.homedir(), '.wazir');
  const state = createInitialShellState({
    initialCwd: process.cwd(),
    historyFile: path.join(wazirHome, 'shell_history'),
  });

  if (options.tools) {
    for (const tool of state.optionalTools) {
      console.log(`${tool.name.padEnd(10)} ${tool.available ? `available (${tool.executablePath})` : 'not installed'}`);
    }
    return;
  }

  const aiHandler = options.ai === false
    ? undefined
    : async (request: string, s: ShellSessionState) => {
        console.log(`[AI] Routing request: "${request}" (cwd: ${s.cwd})`);
        const previousCwd = process.cwd();
        try {
          if (fs.existsSync(s.cwd)) {
            process.chdir(s.cwd);
          }
          const { createEngine } = await import('../engine.js');
          const { executeTask } = await import('../run.js');
          const engine = await createEngine({ projectRoot: s.cwd, quiet: true });
          const outcome = await executeTask(engine, request, {});
          return outcome.success ? 0 : 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[wazir-ai] Execution failed: ${msg}`);
          const diag = new DiagnosticQueue();
          diag.enqueue({
            appVersion: effectiveVersion,
            errorCode: 'ERR_SHELL_AI_EXEC',
            failureCategory: 'command_routing',
            component: 'wa-shell',
            exceptionCategory: err instanceof Error ? err.name : 'Error',
            taskPhase: 'execute',
          });
          return 1;
        } finally {
          try {
            process.chdir(previousCwd);
          } catch {
            // ignore restore errors
          }
        }
      };

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

  const completer = (line: string): [string[], string] => {
    const builtins = [
      'loop ', 'graph ', 'goal ', 'jobs', 'status', 'inspect ', 'pause ', 'resume ', 'stop ',
      'agents', 'models', 'fleet', 'history', 'help',
      'cd ', 'pwd', 'export ', 'unset ', 'alias ', 'unalias ', 'tools', 'exit', 'quit',
      '/mode auto', '/mode shell', '/mode ai',
    ];
    const hits = builtins.filter((c) => c.startsWith(line));
    return [hits.length ? hits : builtins, line];
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `wazir:${path.basename(state.cwd) || '/'}$ `,
    completer,
  });

  rl.on('SIGINT', () => {
    if (state.activeChild && state.activeChild.exitCode === null) {
      state.activeChild.kill('SIGINT');
      return;
    }
    console.log('^C');
    rl.prompt();
  });

  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    await executeShellLine(trimmed, state, aiHandler);
    if (state.shouldExit) {
      rl.close();
      break;
    }
    rl.setPrompt(`wazir:${path.basename(state.cwd) || '/'}$ `);
    rl.prompt();
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
    .action(async (options: { command?: string; ai?: boolean; tools?: boolean }) => {
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
