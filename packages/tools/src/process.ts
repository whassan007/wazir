import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

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
 *
 * Before this, a timeout/cancel/maxBuffer kill only ever hit the immediate
 * child (`child.kill(signal)`), which on POSIX only signals that one PID —
 * anything it forked (a test runner's workers, a dev server, `npm`'s own
 * child) inherits the parent's process group and keeps running as an orphan
 * once the immediate child dies. Spawning with `detached: true` makes the
 * child the leader of its own new process group (pgid === its pid), so
 * `process.kill(-pid, signal)` reaches every descendant in one call. Windows
 * has no equivalent of process groups; `taskkill /T` walks the actual
 * process tree instead.
 */
function killProcessGroup(child: import('node:child_process').ChildProcess, signal: NodeJS.Signals, wasDetached: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // best effort — fall through to killing just the direct child
      try { child.kill(signal); } catch { /* already gone */ }
    }
    return;
  }
  if (!wasDetached) {
    // Not its own group leader (bwrap path — see the spawn() call): a direct
    // kill is bwrap's own documented shutdown path, not a fallback.
    try { child.kill(signal); } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Group kill fails if the child never actually became its own group
    // leader (e.g. exited before spawn finished setpgid) — the direct kill
    // below is what child.kill() would have done anyway.
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

let warnedDegraded = false;

// Variables a child needs to behave like a normal shell session. Everything
// else in the operator's environment (API keys, database URLs, cloud
// credentials) stays out of the child so a tool call cannot read it back
// into an execution record (security review F-13). Extra names can be
// forwarded with WAZIR_CHILD_ENV=NAME1,NAME2.
const CHILD_ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TZ', 'LANG', 'LANGUAGE',
  'TMPDIR', 'TMP', 'TEMP', 'PWD', 'COLUMNS', 'LINES', 'DISPLAY', 'EDITOR', 'PAGER',
  'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'NVM_DIR', 'NVM_BIN', 'VOLTA_HOME', 'FNM_DIR',
  'CI', 'FORCE_COLOR', 'NO_COLOR', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'ComSpec', 'PATHEXT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'npm_config_cache', 'NPM_CONFIG_CACHE', 'PNPM_HOME', 'YARN_CACHE_FOLDER', 'CARGO_HOME', 'RUSTUP_HOME', 'GOPATH', 'GOROOT', 'GOCACHE', 'PYTHONPATH', 'VIRTUAL_ENV', 'JAVA_HOME',
]);
const CHILD_ENV_ALLOW_PREFIXES = ['LC_', 'XDG_'];

/** The reduced environment tool subprocesses run with. */
export function childEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const passthrough = new Set(
    (process.env.WAZIR_CHILD_ENV ?? '').split(',').map((name) => name.trim()).filter(Boolean),
  );
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (CHILD_ENV_ALLOW.has(name) || passthrough.has(name) || CHILD_ENV_ALLOW_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      env[name] = value;
    }
  }
  return { ...env, ...extra };
}

export function runShell(command: string, options: RunOptions): Promise<CommandResult> {
  const shell = process.platform === 'win32' ? 'cmd' : 'sh';
  const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];
  return runProcess(shell, args, options);
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

    const detachedGroup = process.platform !== 'win32' && wrapped.mode !== 'bwrap';
    const child = spawn(wrapped.file, wrapped.args, {
      cwd: spawnCwd,
      env: childEnv,
      // fd 3 carries the seccomp program to bwrap (`--seccomp 3`).
      stdio: wrapped.seccomp ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      // Makes the child the leader of its own process group on POSIX, so a
      // timeout/cancel/overflow kill can reach its descendants too (see
      // killProcessGroup). Skipped for bwrap: it calls setsid() itself for
      // --new-session, which can conflict with Node's pre-exec setpgid()
      // on the same process — bwrap already has its own kill safety net
      // (--die-with-parent, PID-namespace teardown), so a direct SIGKILL to
      // it (killProcessGroup's fallback when there's no group) is sufficient
      // and doesn't fight bwrap's own session setup. No effect on Windows;
      // taskkill /T there doesn't need it.
      detached: detachedGroup,
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
