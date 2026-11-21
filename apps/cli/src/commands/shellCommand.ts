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

export function registerShellAndMetaCommands(program: Command, cliVersion?: string): void {
  const effectiveVersion = cliVersion && cliVersion !== '0.3.1' ? cliVersion : resolveAuthoritativePackageVersion();

  program
    .command('shell')
    .description('Launch the universal AI-native Wazir Shell (! for shell, ? for AI, auto by default)')
    .option('-c, --command <cmd>', 'Execute a single command or natural-language request and exit')
    .option('--no-ai', 'Run strictly in offline native-shell mode')
    .option('--tools', 'List discovered optional shell enhancement tools (fzf, zoxide, rg, bat, atuin, lazygit) and exit')
    .action(async (options: { command?: string; ai?: boolean; tools?: boolean }) => {
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
            console.log(`[wazir-ai] Routing request: "${request}" (cwd: ${s.cwd})`);
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

      const availableEnhancements = state.optionalTools.filter((t) => t.available).map((t) => t.name);
      console.log(`Wazir Shell v${effectiveVersion} — Universal AI-Native Terminal`);
      console.log(`Tip: '! <cmd>' forces shell, '? <req>' forces AI, '/mode <auto|shell|ai>' switches mode, 'exit' quits.`);
      if (availableEnhancements.length > 0) {
        console.log(`Detected tools: ${availableEnhancements.join(', ')}\n`);
      } else {
        console.log('');
      }

      const completer = (line: string): [string[], string] => {
        const builtins = ['cd', 'pwd', 'export', 'unset', 'alias', 'unalias', 'history', 'tools', 'exit', 'quit', '/mode auto', '/mode shell', '/mode ai'];
        const hits = builtins.filter((c) => c.startsWith(line));
        return [hits.length ? hits : builtins, line];
      };

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `wa:${path.basename(state.cwd) || '/'}$ `,
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
        rl.setPrompt(`wa:${path.basename(state.cwd) || '/'}$ `);
        rl.prompt();
      }
      process.exitCode = state.lastExitCode;
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
