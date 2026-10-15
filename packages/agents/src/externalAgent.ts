import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnGroupWatchdog } from './processWatchdog.js';
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentRunRequest,
  AgentRuntime,
  AgentTurn,
  TaskType,
} from '@wazir/core';

const MAX_CAPTURE = 20_000;

function quoteWindowsCmdArg(arg: string): string {
  if (!arg) return '""';
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function findBashOnWindows(envPath?: string): string {
  const dirs = (envPath ?? process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  const fallbacks = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ];
  return fallbacks.find((f) => existsSync(f)) ?? 'bash';
}

export function resolveExternalCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (process.platform !== 'win32') {
    return { command, args, windowsVerbatimArguments: false };
  }
  const env = options.env ?? process.env;
  const pathEnv = env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? '';
  const pathExt = (env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasSep = command.includes('/') || command.includes('\\');
  const candidates: string[] = [];
  if (hasSep) {
    const base = path.isAbsolute(command) ? command : path.resolve(options.cwd ?? process.cwd(), command);
    candidates.push(base);
    if (!path.extname(base)) {
      for (const ext of pathExt) {
        candidates.push(`${base}${ext}`);
        candidates.push(`${base}${ext.toLowerCase()}`);
      }
    }
  } else {
    const dirs = pathEnv.split(path.delimiter).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
    for (const dir of dirs) {
      const base = path.join(dir, command);
      if (path.extname(command)) {
        candidates.push(base);
      } else {
        for (const ext of pathExt) {
          candidates.push(`${base}${ext}`);
          candidates.push(`${base}${ext.toLowerCase()}`);
        }
        candidates.push(base);
      }
    }
  }
  const resolved = candidates.find((c) => existsSync(c)) ?? command;
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const comspec = env.ComSpec || env.COMSPEC || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    const cmdLine = [quoteWindowsCmdArg(resolved), ...args.map(quoteWindowsCmdArg)].join(' ');
    return { command: comspec, args: ['/d', '/s', '/c', `"${cmdLine}"`], windowsVerbatimArguments: true };
  }
  let isShellScript = /\.sh$/i.test(resolved);
  if (!isShellScript && existsSync(resolved)) {
    try {
      const head = readFileSync(resolved, { encoding: 'utf8', flag: 'r' }).slice(0, 64);
      if (head.startsWith('#!')) isShellScript = true;
    } catch {
      // ignore
    }
  }
  if (isShellScript) {
    return { command: findBashOnWindows(pathEnv), args: [resolved, ...args], windowsVerbatimArguments: false };
  }
  return { command: resolved, args, windowsVerbatimArguments: false };
}

export interface ExternalAgentSpec {
  name: string;
  version: string;
  description: string;
  /** Executable to run for a task, e.g. 'opencode' or 'bionic'. */
  command: string;
  args?: string[];
  taskTypes: TaskType[];
  capabilities: string[];
  timeoutMs?: number;
  /** Extra environment, e.g. a vendor CLI config dir selecting one account's login. */
  env?: Record<string, string>;
}

/**
 * Adapter for external agent harnesses (OpenCode, Bionic, ...).
 * External agents are OPTIONAL execution providers — Wazir remains the
 * control plane: it schedules the task, selects the model/computer, and
 * records the execution. The external process only provides the reasoning loop.
 */
export class ExternalAgentAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  private readonly spec: ExternalAgentSpec;

  constructor(spec: ExternalAgentSpec) {
    this.spec = spec;
    this.descriptor = {
      name: spec.name,
      version: spec.version,
      description: spec.description,
      capabilities: spec.capabilities,
      requiredTools: [],
      modelRequirements: { capabilities: [] },
      permissions: [],
      taskTypes: spec.taskTypes,
      strategy: 'external',
    };
  }

  async *run(request: AgentRunRequest, _runtime: AgentRuntime): AsyncIterable<AgentTurn> {
    const args = [...(this.spec.args ?? []), request.taskDescription];

    const timeoutMs = this.spec.timeoutMs ?? 600_000;
    const output = await new Promise<string | undefined>((resolve, reject) => {
      let captured = '';
      let stderr = '';
      let stopReason: 'timeout' | 'cancelled' | undefined;
      // Own process group (POSIX) so timeout/cancel reaches the harness's children too:
      // killing only the direct child leaves grandchildren holding the stdout pipe,
      // and 'close' then never fires.
      const detached = process.platform !== 'win32';
      const childEnv = this.spec.env ? { ...process.env, ...this.spec.env } : undefined;
      const resolved = resolveExternalCommand(this.spec.command, args, { cwd: request.projectRoot, env: childEnv });
      const child = spawn(resolved.command, resolved.args, {
        cwd: request.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
        detached,
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      });
      const stop = (reason: 'timeout' | 'cancelled') => {
        if (stopReason) return;
        stopReason = reason;
        if (process.platform === 'win32' && child.pid !== undefined) {
          try {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            return;
          } catch {
            // fall through
          }
        }
        try {
          if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      };
      // If Wazir itself dies, the detached group must not keep running unsupervised.
      const watchdog = detached && child.pid !== undefined ? spawnGroupWatchdog(process.pid, child.pid) : undefined;
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const cancelPoll = setInterval(() => { if (request.isCancelled?.()) stop('cancelled'); }, 250);
      const settle = () => {
        clearTimeout(timer);
        clearInterval(cancelPoll);
        try { watchdog?.kill('SIGKILL'); } catch { /* already gone */ }
      };
      // Only the first MAX_CAPTURE chars are reported, so stop buffering past that.
      const append = (chunk: string) => {
        if (captured.length < MAX_CAPTURE) captured += chunk.slice(0, MAX_CAPTURE - captured.length);
      };
      child.stdout.setEncoding('utf8').on('data', append);
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        append(chunk);
        stderr = (stderr + chunk).slice(-MAX_CAPTURE);
      });
      child.on('error', (error) => {
        settle();
        reject(error);
      });
      child.on('close', (code) => {
        settle();
        if (stopReason === 'cancelled') resolve(undefined);
        else if (stopReason === 'timeout') reject(new Error(`'${this.spec.command}' timed out after ${timeoutMs}ms`));
        else if (code === 0) resolve(captured);
        else {
          // The agent's own last words say why; an exit code alone is not diagnosable.
          const tail = (stderr || captured).trim().split('\n').slice(-3).join(' ').slice(-300);
          reject(new Error(`'${this.spec.command}' exited with code ${code}${tail ? `: ${tail}` : ''}`));
        }
      });
    });

    if (output === undefined || request.isCancelled?.()) {
      yield { kind: 'error', error: 'cancelled' };
      return;
    }

    yield { kind: 'message', content: output };
    yield { kind: 'done', content: `external agent '${this.descriptor.name}' completed` };
  }
}

