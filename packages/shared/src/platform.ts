import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync, type ChildProcess } from 'node:child_process';

export const isWindows = process.platform === 'win32';
export const isMacOS = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/** Null device path for git and shell operations ('NUL' on Windows, '/dev/null' on POSIX). */
export const GIT_NULL_DEVICE = isWindows ? 'NUL' : '/dev/null';

/** Git options to prevent executing repository hooks during orchestrator git actions. */
export const GIT_NO_HOOKS = ['-c', `core.hooksPath=${GIT_NULL_DEVICE}`, '-c', 'core.fsmonitor=false'];

/**
 * Checks whether `target` is inside `root` (or is `root` itself).
 * Correctly handles Windows case-insensitivity, different drive letters,
 * and relative path traversals ('..').
 */
export function isPathInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Checks if a process is still alive via signal 0.
 */
export function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Native Windows taskkill path locator.
 */
export function getWindowsTaskkillPath(): string {
  const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  const candidate = path.join(sysRoot, 'System32', 'taskkill.exe');
  return existsSync(candidate) ? candidate : 'taskkill';
}

/**
 * Kills a process and all its descendants.
 * On Windows, taskkill /pid <pid> /T /F walks and terminates the process tree.
 * On POSIX, a detached process group (-pid) is signaled with direct PID fallback.
 */
export function killProcessTree(
  target: number | ChildProcess | { pid?: number; kill?: (sig: NodeJS.Signals) => void } | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
  wasDetached = true,
): void {
  if (target === undefined) return;
  const pid = typeof target === 'number' ? target : target.pid;
  if (pid === undefined || pid <= 0) return;

  if (isWindows) {
    try {
      const taskkill = getWindowsTaskkillPath();
      spawnSync(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      if (typeof target === 'object' && typeof target.kill === 'function') {
        try { target.kill(signal); } catch { /* process already exited */ }
      } else {
        try { process.kill(pid, signal); } catch { /* process already exited */ }
      }
    }
    return;
  }

  if (wasDetached) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Process was not its own group leader; fall through to direct signal
    }
  }

  if (typeof target === 'object' && typeof target.kill === 'function') {
    try { target.kill(signal); } catch { /* process already exited */ }
  } else {
    try { process.kill(pid, signal); } catch { /* process already exited */ }
  }
}

/**
 * Stops a process tree gracefully (SIGTERM), waits up to `graceMs`, and escalates to SIGKILL.
 * Verifies that the process has actually terminated before returning.
 */
export async function terminateProcessTree(
  target: number | ChildProcess | { pid?: number; kill?: (sig: NodeJS.Signals) => void } | undefined,
  options: { graceMs?: number; signal?: NodeJS.Signals; wasDetached?: boolean } = {},
): Promise<boolean> {
  if (target === undefined) return true;
  const pid = typeof target === 'number' ? target : target.pid;
  if (pid === undefined || pid <= 0 || !isProcessAlive(pid)) return true;

  const graceMs = options.graceMs ?? 1500;
  const wasDetached = options.wasDetached ?? (!isWindows);

  if (isWindows) {
    try {
      const taskkill = getWindowsTaskkillPath();
      spawnSync(taskkill, ['/pid', String(pid), '/T'], { stdio: 'ignore', windowsHide: true });
    } catch {
      if (typeof target === 'object' && typeof target.kill === 'function') {
        try { target.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
  } else {
    killProcessTree(target, 'SIGTERM', wasDetached);
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  killProcessTree(target, 'SIGKILL', wasDetached);

  const forceDeadline = Date.now() + 1000;
  while (Date.now() < forceDeadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  return !isProcessAlive(pid);
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (isWindows) {
      // On Windows, any readable file with an executable extension in PATHEXT is executable
      accessSync(filePath, fsConstants.R_OK);
      return true;
    }
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function getWindowsPathext(): string[] {
  const raw = getEnvCaseInsensitive('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD;.VBS;.JS';
  return raw
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
}

/**
 * Case-insensitive lookup of an environment variable key.
 */
export function getEnvCaseInsensitive(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[key] !== undefined) return env[key];
  const upper = key.toUpperCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === upper) return v;
  }
  return undefined;
}

/**
 * Resolves an executable binary name or path against PATH and PATHEXT.
 * Returns the absolute or qualified executable path if found, or undefined.
 */
export function resolveExecutable(bin: string, envPath?: string): string | undefined {
  if (!bin) return undefined;

  // If path contains directory separators, test direct path (and PATHEXT extensions on Windows)
  if (path.isAbsolute(bin) || bin.includes('/') || (isWindows && bin.includes('\\'))) {
    const resolved = path.resolve(bin);
    if (isExecutableFile(resolved)) return resolved;
    if (isWindows) {
      for (const ext of getWindowsPathext()) {
        const withExt = resolved + ext;
        if (isExecutableFile(withExt)) return withExt;
      }
    }
    return undefined;
  }

  const rawPath = envPath ?? getEnvCaseInsensitive('PATH') ?? '';
  const dirs = rawPath
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  const exts = isWindows ? getWindowsPathext() : [''];

  for (const dir of dirs) {
    // If bin already ends with one of the extensions
    if (isWindows) {
      const lowerBin = bin.toLowerCase();
      const hasExt = exts.some((ext) => lowerBin.endsWith(ext.toLowerCase()));
      if (hasExt) {
        const candidate = path.join(dir, bin);
        if (isExecutableFile(candidate)) return candidate;
      }
    }

    for (const ext of exts) {
      const candidate = path.join(dir, isWindows && ext ? bin + ext : bin);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  return undefined;
}

/**
 * Checks whether an executable exists on PATH.
 */
export function isExecutableOnPath(bin: string, envPath?: string): boolean {
  return resolveExecutable(bin, envPath) !== undefined;
}

/** Standard variables allowed in child tool environments. */
export const DEFAULT_CHILD_ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TZ', 'LANG', 'LANGUAGE',
  'TMPDIR', 'TMP', 'TEMP', 'PWD', 'COLUMNS', 'LINES', 'DISPLAY', 'EDITOR', 'PAGER',
  'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'NVM_DIR', 'NVM_BIN', 'VOLTA_HOME', 'FNM_DIR',
  'CI', 'FORCE_COLOR', 'NO_COLOR',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'npm_config_cache', 'NPM_CONFIG_CACHE', 'PNPM_HOME', 'YARN_CACHE_FOLDER',
  'CARGO_HOME', 'RUSTUP_HOME', 'GOPATH', 'GOROOT', 'GOCACHE', 'PYTHONPATH',
  'VIRTUAL_ENV', 'JAVA_HOME',
]);

const DEFAULT_CHILD_ENV_PREFIXES = ['LC_', 'XDG_'];

/**
 * Produces a reduced, sanitized environment for child processes.
 * Case-insensitively checks allow-list names so Windows environments with `Path`
 * or `SystemRoot` are properly preserved.
 */
export function sanitizeChildEnvironment(
  extra: Record<string, string> = {},
  options: {
    allowList?: Set<string>;
    prefixes?: string[];
    passthroughEnv?: string;
  } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const allowList = options.allowList ?? DEFAULT_CHILD_ENV_ALLOW;
  const prefixes = options.prefixes ?? DEFAULT_CHILD_ENV_PREFIXES;

  const upperAllow = new Set([...allowList].map((k) => k.toUpperCase()));
  const passthrough = new Set(
    (options.passthroughEnv ?? process.env.WAZIR_CHILD_ENV ?? '')
      .split(',')
      .map((name) => name.trim().toUpperCase())
      .filter(Boolean),
  );

  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (
      upperAllow.has(upper) ||
      passthrough.has(upper) ||
      prefixes.some((p) => upper.startsWith(p.toUpperCase()))
    ) {
      env[name] = value;
    }
  }

  // Ensure PATH is always present on Windows if any casing existed
  if (isWindows && !env.PATH && !env.Path && !env.path) {
    const foundPath = getEnvCaseInsensitive('PATH');
    if (foundPath) env.PATH = foundPath;
  }

  return { ...env, ...extra };
}

/**
 * Returns true if the file path is a Windows batch script (.cmd or .bat).
 */
export function isBatchScript(filePath: string): boolean {
  if (!isWindows) return false;
  const ext = path.extname(filePath).toUpperCase();
  return ext === '.CMD' || ext === '.BAT';
}

/**
 * Returns spawn parameters adjusted for Windows batch scripts (.cmd/.bat) and executable resolution.
 * On Windows, batch files cannot be spawned directly without shell/cmd wrapper.
 */
export function getSpawnCommand(
  command: string,
  args: string[] = [],
  options: { cwd?: string; envPath?: string } = {},
): { command: string; args: string[]; useShell: boolean; isCmdOrBat: boolean; resolved?: string } {
  const resolved = resolveExecutable(command, options.envPath);
  const target = resolved ?? command;
  const batch = isBatchScript(target);
  return {
    command: target,
    args,
    useShell: batch,
    isCmdOrBat: batch,
    resolved,
  };
}

const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * Checks whether a filename or path segment is a Windows reserved name
 * (CON, PRN, AUX, NUL, COM1-9, LPT1-9) or contains illegal trailing characters.
 */
export function isWindowsReservedName(name: string): boolean {
  if (!isWindows) return false;
  const base = path.basename(name).trim();
  if (WINDOWS_RESERVED_NAMES.test(base)) return true;
  if (base.endsWith('.') || base.endsWith(' ')) return true;
  return false;
}

/**
 * Normalizes a path for case-insensitive comparison on Windows.
 */
export function normalizePathForComparison(p: string): string {
  const resolved = path.resolve(p);
  return isWindows ? resolved.toLowerCase() : resolved;
}

/**
 * Quotes an argument safely for Windows cmd.exe / CommandLineToArgvW.
 */
export function quoteWindowsArg(arg: string): string {
  if (!arg) return '""';
  if (!/[\s"\\<>&|^%!]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Quotes an argument safely for POSIX shells.
 */
export function quotePosixArg(arg: string): string {
  if (!arg) return "''";
  if (!/[\s'"\\$`!#*?&;|<>()~[\]{}]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

