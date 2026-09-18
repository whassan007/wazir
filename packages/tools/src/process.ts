import { spawn } from 'node:child_process';

import { sandboxDegraded, sandboxStatus, wrapInSandbox, type SandboxMode, type WrappedCommand } from './sandbox.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** How the process was isolated from the host (`none` = plain host execution). */
  sandbox: SandboxMode;
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

  let wrapped: WrappedCommand;
  try {
    wrapped = options.unsandboxed
      ? { file, args, mode: 'none' }
      : wrapInSandbox(file, args, {
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
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const child = spawn(wrapped.file, wrapped.args, {
      cwd: spawnCwd,
      env: childEnvironment(options.env),
      // fd 3 carries the seccomp program to bwrap (`--seccomp 3`).
      stdio: wrapped.seccomp ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    if (wrapped.seccomp) {
      const feed = child.stdio[3] as NodeJS.WritableStream;
      feed.on('error', () => undefined); // bwrap exiting early closes the pipe; the exit code tells the story
      feed.end(wrapped.seccomp);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 120_000);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, durationMs: Date.now() - started, timedOut, sandbox: wrapped.mode });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > maxBuffer) {
        stdout = stdout.slice(0, maxBuffer);
        child.kill('SIGKILL');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > maxBuffer) {
        stderr = stderr.slice(0, maxBuffer);
      }
    });

    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(127);
    });

    child.on('close', (code) => finish(code ?? 1));
  });
}
