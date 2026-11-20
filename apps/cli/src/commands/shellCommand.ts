import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { classifyShellInput } from '@wazir/core';
import {
  DIAGNOSTIC_NOTICE_VERSION,
  DiagnosticQueue,
  getFirstLaunchDisclosureText,
  hasAcceptedDiagnostics,
  readConsentRecord,
  recordConsentAcceptance,
  recordConsentDecline,
} from '@wazir/observability';

export interface ShellSessionState {
  cwd: string;
  env: Record<string, string>;
  aliases: Record<string, string>;
  history: string[];
  lastExitCode: number;
}

export function createInitialShellState(initialCwd = process.cwd()): ShellSessionState {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  return {
    cwd: initialCwd,
    env,
    aliases: {},
    history: [],
    lastExitCode: 0,
  };
}

function expandTilde(target: string): string {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/')) return path.join(os.homedir(), target.slice(2));
  return target;
}

export async function executeShellLine(
  line: string,
  state: ShellSessionState,
  onAiRequest?: (request: string, state: ShellSessionState) => Promise<number>,
): Promise<number> {
  const trimmed = line.trim();
  if (!trimmed) return 0;
  state.history.push(trimmed);

  // Expand simple alias on first token
  const parts = trimmed.split(/\s+/);
  const expanded = state.aliases[parts[0] ?? '']
    ? `${state.aliases[parts[0] ?? '']} ${parts.slice(1).join(' ')}`.trim()
    : trimmed;

  const classified = classifyShellInput(expanded);

  if (classified.mode === 'ai') {
    if (!onAiRequest) {
      console.log(`[wazir-ai] AI execution unavailable offline. Prefix with '!' to run as shell.`);
      state.lastExitCode = 1;
      return 1;
    }
    const code = await onAiRequest(classified.command, state);
    state.lastExitCode = code;
    return code;
  }

  const cmd = classified.command;
  if (cmd === 'pwd') {
    console.log(state.cwd);
    state.lastExitCode = 0;
    return 0;
  }
  if (cmd === 'cd' || cmd.startsWith('cd ')) {
    const rawTarget = cmd.slice(2).trim() || '~';
    const nextDir = path.resolve(state.cwd, expandTilde(rawTarget));
    if (!fs.existsSync(nextDir) || !fs.statSync(nextDir).isDirectory()) {
      console.error(`cd: no such directory: ${rawTarget}`);
      state.lastExitCode = 1;
      return 1;
    }
    state.cwd = nextDir;
    state.env.PWD = nextDir;
    state.lastExitCode = 0;
    return 0;
  }
  if (cmd.startsWith('export ')) {
    const rest = cmd.slice(7).trim();
    const eq = rest.indexOf('=');
    if (eq > 0) {
      const k = rest.slice(0, eq).trim();
      const v = rest.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      state.env[k] = v;
    }
    state.lastExitCode = 0;
    return 0;
  }
  if (cmd.startsWith('unset ')) {
    const k = cmd.slice(6).trim();
    delete state.env[k];
    state.lastExitCode = 0;
    return 0;
  }
  if (cmd.startsWith('alias ')) {
    const rest = cmd.slice(6).trim();
    const eq = rest.indexOf('=');
    if (eq > 0) {
      const k = rest.slice(0, eq).trim();
      const v = rest.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      state.aliases[k] = v;
    }
    state.lastExitCode = 0;
    return 0;
  }
  if (cmd === 'history') {
    state.history.forEach((h, i) => console.log(`${String(i + 1).padStart(4)}  ${h}`));
    state.lastExitCode = 0;
    return 0;
  }

  const userShell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh');
  return new Promise<number>((resolve) => {
    const child = spawn(userShell, ['-c', cmd], {
      cwd: state.cwd,
      env: state.env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      const exitCode = code ?? 0;
      state.lastExitCode = exitCode;
      resolve(exitCode);
    });
    child.on('error', (err) => {
      console.error(`wazir shell error: ${err.message}`);
      state.lastExitCode = 127;
      resolve(127);
    });
  });
}

export function registerShellAndMetaCommands(program: Command, cliVersion: string): void {
  program
    .command('shell')
    .description('Launch the universal AI-native Wazir Shell (! for shell, ? for AI, auto by default)')
    .option('-c, --command <cmd>', 'Execute a single command or natural-language request and exit')
    .option('--no-ai', 'Run strictly in offline native-shell mode')
    .action(async (options: { command?: string; ai?: boolean }) => {
      const state = createInitialShellState(process.cwd());
      const aiHandler = options.ai === false
        ? undefined
        : async (request: string, s: ShellSessionState) => {
            console.log(`[wazir-ai] Routing request: "${request}" (cwd: ${s.cwd})`);
            try {
              const { createEngine } = await import('../engine.js');
              const { executeTask } = await import('../run.js');
              const engine = await createEngine({ quiet: true });
              const outcome = await executeTask(engine, request, {});
              return outcome.success ? 0 : 1;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[wazir-ai] Execution failed: ${msg}`);
              const diag = new DiagnosticQueue();
              diag.enqueue({
                appVersion: cliVersion,
                errorCode: 'ERR_SHELL_AI_EXEC',
                failureCategory: 'command_routing',
                component: 'wa-shell',
                exceptionCategory: err instanceof Error ? err.name : 'Error',
                taskPhase: 'execute',
              });
              return 1;
            }
          };

      if (options.command) {
        const code = await executeShellLine(options.command, state, aiHandler);
        process.exitCode = code;
        return;
      }

      console.log(`Wazir Shell v${cliVersion} — Universal AI-Native Terminal`);
      console.log(`Tip: '! <cmd>' forces shell, '? <req>' forces AI, 'exit' quits.\n`);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `wa:${path.basename(state.cwd)}$ `,
      });

      rl.on('SIGINT', () => {
        console.log('^C');
        rl.prompt();
      });

      rl.prompt();
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed === 'exit' || trimmed === 'quit') {
          rl.close();
          break;
        }
        await executeShellLine(trimmed, state, aiHandler);
        rl.setPrompt(`wa:${path.basename(state.cwd)}$ `);
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
        version: cliVersion,
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
