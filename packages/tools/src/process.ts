import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { killProcessTree, sanitizeChildEnvironment, getSpawnCommand } from '@wazir/shared';

import { sandboxDegraded, sandboxStatus, wrapInSandbox, type SandboxMode, type WrappedCommand } from './sandbox.js';
import { defaultResourceLimits, wrapWithResourceLimits, type ResourceLimits } from './resourceLimits.js';
import { SpillingBuffer } from './outputSpill.js';
import { randomBytes } from 'node:crypto';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** How the process was isolated from the host (`none` = plain host execution). */
  sandbox: SandboxMode;
  /** Whether an rlimit cap (memory/CPU/process count/file size) was applied. */
  resourceLimited: boolean;
  /** True once stdout or stderr exceeded maxBuffer and was spilled to disk instead of being held in memory or killing the process. */
  outputSpilled: boolean;
  /** Absolute paths to the full spilled output, when outputSpilled is true. */
  spillPaths?: { stdout?: string; stderr?: string };
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  maxBuffer?: number;
  /**
   * Directory the command may write to. Defaults to `cwd`. Set explicitly
   * when `cwd` is a subdirectory of the project.
   */
  projectRoot?: string;
  /** Allow outbound network from the child (default false). */
  networkAllowed?: boolean;
  /** Skip the OS sandbox for this call (e.g. orchestrator-internal git). */
  unsandboxed?: boolean;
  /** Memory/CPU/process/file-size caps. Defaults to defaultResourceLimits(); pass {} to disable. */
  resourceLimits?: ResourceLimits;
  /** Kills the process (group) early on abort, same path as a timeout. */
  signal?: AbortSignal;
  /** Identifies the run for output-spill pathing (`.wazir/runs/<runId>/outputs/`). Defaults to a random id when spilling is actually needed. */
  runId?: string;
}

/**
 * Kills `child` and everything it spawned, not just the direct child.
 */
function killProcessGroup(child: import('node:child_process').ChildProcess, signal: NodeJS.Signals, wasDetached: boolean): void {
  killProcessTree(child.pid, signal, wasDetached);
}

let warnedDegraded = false;

export function childEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  return sanitizeChildEnvironment(extra);
}

export function runShell(command: string, options: RunOptions): Promise<CommandResult> {
  const shell = process.platform === 'win32' ? (process.env.ComSpec || process.env.COMSPEC || 'cmd.exe') : 'sh';
  const args = process.platform === 'win32' ? ['/d', '/c', command] : ['-c', command];
  return runProcess(shell, args, options, process.platform === 'win32');
}

export function runFile(
  file: string,
  args: string[],
  options: RunOptions,
): Promise<CommandResult> {
  return runProcess(file, args, options);
}

function runProcess(
  file: string,
  args: string[],
  options: RunOptions,
  windowsVerbatimArguments = false,
): Promise<CommandResult> {
  const started = Date.now();
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;

  const limits = options.resourceLimits ?? defaultResourceLimits();
  const limited = wrapWithResourceLimits(file, args, limits);

  let wrapped: WrappedCommand;
  try {
    wrapped = options.unsandboxed
      ? { file: limited.file, args: limited.args, mode: 'none' }
      : wrapInSandbox(limited.file, limited.args, {
          projectRoot: options.projectRoot ?? options.cwd,
          cwd: options.cwd,
          networkAllowed: options.networkAllowed ?? false,
          // Project check scripts commonly invoke the same Node binary as Wazir.
          // On macOS runners that binary lives under the user's toolcache, which
          // the Seatbelt profile otherwise hides along with the rest of $HOME.
          readOnlyPaths: [path.dirname(process.execPath)],
        });
  } catch (error) {
    // WAZIR_SANDBOX=required with no usable backend: refuse rather than run on the host.
    return Promise.reject(error);
  }
  if (!options.unsandboxed && wrapped.mode === 'none' && !warnedDegraded && sandboxDegraded()) {
    warnedDegraded = true;
    console.error(`[wazir] tool sandbox unavailable — running tool processes directly on the host (${sandboxStatus().reason ?? 'no backend'})`);
  }
  // bwrap sets the working directory itself (--chdir) and the host cwd may
  // not exist inside the sandbox mount tree in the same form.
  const spawnCwd = wrapped.mode === 'bwrap' ? undefined : options.cwd;

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;

    const project = path.resolve(options.projectRoot ?? options.cwd);
    const wazirTmp = path.join(project, '.wazir', 'tmp');
    const wazirHome = path.join(project, '.wazir', 'home');
    const wazirCache = path.join(project, '.wazir', 'cache');
    const runId = options.runId ?? randomBytes(6).toString('hex');
    const runDir = path.join(project, '.wazir', 'runs', runId, 'outputs');
    const stdoutBuffer = new SpillingBuffer({ runDir, fileName: 'stdout.log', spillThresholdBytes: maxBuffer });
    const stderrBuffer = new SpillingBuffer({ runDir, fileName: 'stderr.log', spillThresholdBytes: maxBuffer });

    try {
      if (!existsSync(wazirTmp)) mkdirSync(wazirTmp, { recursive: true });
      if (!existsSync(wazirHome)) mkdirSync(wazirHome, { recursive: true });
      if (!existsSync(wazirCache)) mkdirSync(wazirCache, { recursive: true });
    } catch {
      // Best effort in case project directory is read-only
    }

    const normalizedEnv: Record<string, string> = {};
    if (existsSync(wazirTmp)) normalizedEnv.TMPDIR = wazirTmp;
    if (existsSync(wazirHome)) normalizedEnv.HOME = wazirHome;
    if (existsSync(wazirCache)) normalizedEnv.XDG_CACHE_HOME = wazirCache;

    const childEnv = childEnvironment({ ...normalizedEnv, ...(options.env ?? {}) });

    const spawnCmd = wrapped.mode === 'none'
      ? getSpawnCommand(wrapped.file, wrapped.args, { cwd: spawnCwd, envPath: childEnv.PATH || childEnv.Path })
      : { command: wrapped.file, args: wrapped.args, useShell: false };
    const detachedGroup = process.platform !== 'win32' && wrapped.mode !== 'bwrap';

    const child = spawn(spawnCmd.command, spawnCmd.args, {
      cwd: spawnCwd,
      env: childEnv,
      // fd 3 carries the seccomp program to bwrap (`--seccomp 3`).
      stdio: wrapped.seccomp ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      detached: detachedGroup,
      shell: spawnCmd.useShell,
      // cmd.exe parses a command string itself. Node's usual Windows argument
      // escaping rewrites embedded quotes to backslash-quote, which cmd treats
      // literally and then fails to find quoted executables/paths.
      windowsVerbatimArguments,
    });
    if (wrapped.seccomp) {
      const feed = child.stdio[3] as NodeJS.WritableStream;
      feed.on('error', () => undefined); // bwrap exiting early closes the pipe; the exit code tells the story
      feed.end(wrapped.seccomp);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, 'SIGKILL', detachedGroup);
    }, options.timeoutMs ?? 120_000);

    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      killProcessGroup(child, 'SIGKILL', detachedGroup);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void Promise.all([stdoutBuffer.finish(), stderrBuffer.finish()]).then(([stdoutResult, stderrResult]) => {
        const outputSpilled = stdoutResult.spilled || stderrResult.spilled;
        resolve({
          code: cancelled && code === 0 ? 1 : code,
          stdout: stdoutResult.preview,
          stderr: stderrResult.preview,
          durationMs: Date.now() - started,
          timedOut,
          sandbox: wrapped.mode,
          resourceLimited: limited.applied,
          outputSpilled,
          spillPaths: outputSpilled ? { stdout: stdoutResult.filePath, stderr: stderrResult.filePath } : undefined,
        });
      });
    };

    // Overflow used to SIGKILL the process outright — a noisy-but-passing
    // test run with verbose output became a hard failure with no way to see
    // what actually happened. Now output past maxBuffer streams to disk
    // (SpillingBuffer) instead, and the process is left to run to its own
    // natural conclusion (still bounded by timeoutMs).
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer.push(chunk.toString());
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer.push(chunk.toString());
    });

    child.on('error', (error) => {
      stderrBuffer.push(`\n${error.message}`);
      finish(127);
    });

    child.on('close', (code) => finish(code ?? 1));
  });
}
