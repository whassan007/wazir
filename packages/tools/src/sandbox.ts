import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * OS-level sandbox for tool subprocesses (security review F-27).
 *
 * The policy engine decides *whether* a command may run; this decides *what
 * it can touch when it does*. Every `shell`/`git`/check-tool subprocess is
 * wrapped so that:
 *
 * - only the project directory (and a private /tmp) is writable — the rest
 *   of the filesystem is read-only;
 * - the operator's home directory is hidden, except for well-known toolchain
 *   directories (`~/.nvm`, `~/.cargo`, ...) so `node`/`npm`/`cargo` keep
 *   working — `~/.ssh`, `~/.aws`, `~/.wazir` and friends are not visible;
 * - the network is unreachable unless the policy allows it;
 * - runtime sockets under /run (docker.sock, agent sockets) are hidden;
 * - the process runs in its own PID/IPC/UTS namespaces where the OS allows.
 *
 * Backends: `bwrap` (bubblewrap) on Linux, `sandbox-exec` on macOS. Neither
 * is guaranteed to be usable (bubblewrap needs unprivileged user namespaces,
 * which Ubuntu ≥ 23.10 restricts via AppArmor; containers usually block them
 * too), so availability is probed once and the effective mode is reported in
 * every tool result's metadata and by `wa doctor`. The fallback is `none`,
 * i.e. the pre-existing host execution, never a silent half-sandbox.
 *
 * Selection: `WAZIR_SANDBOX=auto|bwrap|sandbox-exec|none` (default `auto`).
 * A backend named explicitly that cannot start is an error, not a fallback.
 */
export type SandboxMode = 'bwrap' | 'sandbox-exec' | 'none';

export interface SandboxOptions {
  /** Directory the command may write to (bound read-write). */
  projectRoot: string;
  /** Working directory inside the sandbox; must be inside projectRoot or a temp dir. */
  cwd: string;
  /** Whether outbound network access is permitted. Default false. */
  networkAllowed?: boolean;
  /** Extra directories to expose read-only (e.g. a runtime's model cache). */
  readOnlyPaths?: string[];
  /** Extra directories to expose read-write. */
  readWritePaths?: string[];
}

export interface SandboxStatus {
  mode: SandboxMode;
  /** Backend that was requested (`auto` resolves to the first usable one). */
  requested: string;
  /** Human-readable reason when the mode is `none` or differs from the request. */
  reason?: string;
}

export interface WrappedCommand {
  file: string;
  args: string[];
  mode: SandboxMode;
}

// Toolchain locations under $HOME that tools legitimately need. Everything
// else in the home directory is masked.
const HOME_TOOLCHAIN_DIRS = [
  '.nvm', '.volta', '.fnm', '.n', '.bun', '.deno', '.local/bin', '.local/share/pnpm', '.local/share/mise', '.asdf',
  '.cargo', '.rustup', '.go', 'go', '.pyenv', '.rbenv', '.sdkman', '.gradle', '.m2', '.yarn', '.config/yarn',
];
// Caches under $HOME that package managers write to.
const HOME_CACHE_DIRS = ['.npm', '.cache/pnpm', '.cache/yarn', '.cache/pip', '.cache/go-build', '.cargo/registry', '.bun/install/cache'];

let probed: SandboxStatus | undefined;

function requestedMode(): string {
  const value = (process.env.WAZIR_SANDBOX ?? 'auto').trim().toLowerCase();
  return value || 'auto';
}

function onPath(binary: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function probeBwrap(): { ok: boolean; reason?: string } {
  if (process.platform !== 'linux') return { ok: false, reason: 'bwrap is Linux-only' };
  const bin = onPath('bwrap');
  if (!bin) return { ok: false, reason: 'bwrap (bubblewrap) is not installed' };
  const result = spawnSync(bin, ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent', '--', '/bin/true'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 5_000,
  });
  if (result.status === 0) return { ok: true };
  const stderr = String(result.stderr ?? '').trim().split('\n')[0];
  let hint = '';
  if (/uid map|user namespaces|userns|Operation not permitted/i.test(stderr)) {
    hint = ' — unprivileged user namespaces are disabled (on Ubuntu: `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`, or install the bubblewrap AppArmor profile; inside a container, run with `--security-opt seccomp=unconfined --cap-add SYS_ADMIN` or rely on the container as the boundary with WAZIR_SANDBOX=none)';
  }
  return { ok: false, reason: `bwrap cannot start: ${stderr || `exit ${result.status}`}${hint}` };
}

function probeSandboxExec(): { ok: boolean; reason?: string } {
  if (process.platform !== 'darwin') return { ok: false, reason: 'sandbox-exec is macOS-only' };
  const bin = onPath('sandbox-exec') ?? (existsSync('/usr/bin/sandbox-exec') ? '/usr/bin/sandbox-exec' : undefined);
  if (!bin) return { ok: false, reason: 'sandbox-exec is not available' };
  const result = spawnSync(bin, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore', timeout: 5_000 });
  return result.status === 0 ? { ok: true } : { ok: false, reason: `sandbox-exec cannot start (exit ${result.status})` };
}

/** Resolves (once) which sandbox backend this process can actually use. */
export function sandboxStatus(refresh = false): SandboxStatus {
  if (probed && !refresh) return probed;
  const requested = requestedMode();

  if (requested === 'none') {
    probed = { mode: 'none', requested, reason: 'disabled by WAZIR_SANDBOX=none' };
    return probed;
  }
  if (requested === 'bwrap') {
    const probe = probeBwrap();
    probed = probe.ok ? { mode: 'bwrap', requested } : { mode: 'none', requested, reason: probe.reason };
    return probed;
  }
  if (requested === 'sandbox-exec') {
    const probe = probeSandboxExec();
    probed = probe.ok ? { mode: 'sandbox-exec', requested } : { mode: 'none', requested, reason: probe.reason };
    return probed;
  }
  if (requested !== 'auto') {
    probed = { mode: 'none', requested, reason: `unknown WAZIR_SANDBOX value '${requested}' (use auto|bwrap|sandbox-exec|none)` };
    return probed;
  }

  const attempts: string[] = [];
  if (process.platform === 'linux') {
    const probe = probeBwrap();
    if (probe.ok) {
      probed = { mode: 'bwrap', requested };
      return probed;
    }
    attempts.push(probe.reason ?? 'bwrap unavailable');
  } else if (process.platform === 'darwin') {
    const probe = probeSandboxExec();
    if (probe.ok) {
      probed = { mode: 'sandbox-exec', requested };
      return probed;
    }
    attempts.push(probe.reason ?? 'sandbox-exec unavailable');
  } else {
    attempts.push(`no sandbox backend for ${process.platform}`);
  }
  probed = { mode: 'none', requested, reason: attempts.join('; ') };
  return probed;
}

/** True when the requested backend could not be used and execution fell back to the host. */
export function sandboxDegraded(status: SandboxStatus = sandboxStatus()): boolean {
  return status.mode === 'none' && status.requested !== 'none';
}

function isRealDirectory(target: string): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

function existingDirs(base: string, relatives: string[]): string[] {
  return relatives.map((rel) => path.join(base, rel)).filter((dir) => existsSync(dir));
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** bubblewrap argument list for `options`. Pure: safe to unit test. */
export function bwrapArgs(options: SandboxOptions, home: string = os.homedir(), platformTmp: string = os.tmpdir()): string[] {
  const project = path.resolve(options.projectRoot);
  const args: string[] = [
    // Read-only view of the whole host filesystem as the base layer...
    '--ro-bind', '/', '/',
    // ...with fresh device/proc nodes and a private, writable /tmp.
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
  ];
  // Hide runtime sockets (docker.sock, ssh/gpg agents, dbus) — a read-only
  // bind still allows connect(2) on a unix socket. `/var/run` and `/var/tmp`
  // are often symlinks (to /run, /tmp); tmpfs can only go on a real directory.
  for (const dir of ['/var/tmp', '/run', '/var/run']) {
    if (isRealDirectory(dir)) args.push('--tmpfs', dir);
  }
  if (options.networkAllowed && existsSync('/run/systemd/resolve')) {
    args.push('--ro-bind', '/run/systemd/resolve', '/run/systemd/resolve'); // systemd-resolved stub resolver
  }

  // Mask the home directory, then re-expose only toolchains (ro) and caches (rw).
  const resolvedHome = path.resolve(home);
  args.push('--tmpfs', resolvedHome);
  for (const dir of existingDirs(resolvedHome, HOME_TOOLCHAIN_DIRS)) args.push('--ro-bind', dir, dir);
  for (const dir of existingDirs(resolvedHome, HOME_CACHE_DIRS)) args.push('--bind', dir, dir);
  for (const dir of options.readOnlyPaths ?? []) if (existsSync(dir)) args.push('--ro-bind', dir, dir);

  // The project is the only writable tree besides /tmp; it must come after the
  // home mask because it usually lives under $HOME.
  args.push('--bind', project, project);
  for (const dir of options.readWritePaths ?? []) if (existsSync(dir)) args.push('--bind', dir, dir);

  // Temp dirs outside /tmp (macOS-style or TMPDIR overrides) stay writable.
  const tmp = path.resolve(platformTmp);
  if (tmp !== '/tmp' && !isInside(project, tmp) && existsSync(tmp)) args.push('--bind', tmp, tmp);

  const cwd = path.resolve(options.cwd);
  args.push(
    '--chdir', isInside(project, cwd) || isInside(tmp, cwd) ? cwd : project,
    '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    ...(options.networkAllowed ? [] : ['--unshare-net']),
    '--die-with-parent',
    '--new-session',
    '--',
  );
  return args;
}

/** sandbox-exec (Seatbelt) profile for `options`. Pure: safe to unit test. */
export function seatbeltProfile(options: SandboxOptions, home: string = os.homedir(), platformTmp: string = os.tmpdir()): string {
  const q = (p: string) => `"${path.resolve(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const project = path.resolve(options.projectRoot);
  const resolvedHome = path.resolve(home);
  const tmp = path.resolve(platformTmp);
  const rules: string[] = [
    '(version 1)',
    '(allow default)',
    // Home is hidden except for toolchains/caches and the project itself.
    `(deny file-read* file-write* (subpath ${q(resolvedHome)}))`,
    ...existingDirs(resolvedHome, HOME_TOOLCHAIN_DIRS).map((dir) => `(allow file-read* (subpath ${q(dir)}))`),
    ...existingDirs(resolvedHome, HOME_CACHE_DIRS).map((dir) => `(allow file-read* file-write* (subpath ${q(dir)}))`),
    ...(options.readOnlyPaths ?? []).map((dir) => `(allow file-read* (subpath ${q(dir)}))`),
    // Everything outside the project and temp dirs is read-only.
    '(deny file-write*)',
    `(allow file-write* (subpath ${q(project)}))`,
    `(allow file-write* (subpath ${q(tmp)}))`,
    '(allow file-write* (subpath "/tmp"))',
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/dev"))',
    `(allow file-read* (subpath ${q(project)}))`,
    ...(options.readWritePaths ?? []).map((dir) => `(allow file-read* file-write* (subpath ${q(dir)}))`),
    // Runtime sockets.
    `(deny file-read* file-write* (subpath "/private/var/run/docker.sock"))`,
    `(deny file-read* file-write* (subpath "/var/run/docker.sock"))`,
  ];
  if (!options.networkAllowed) {
    rules.push('(deny network*)');
  }
  return rules.join('\n');
}

/**
 * Wraps `file args` in the active sandbox. Returns the command unchanged (mode
 * `none`) when no backend is usable — callers record `mode` so the execution
 * history says which it was.
 */
export function wrapInSandbox(file: string, args: string[], options: SandboxOptions): WrappedCommand {
  const status = sandboxStatus();
  if (status.mode === 'bwrap') {
    return { file: 'bwrap', args: [...bwrapArgs(options), file, ...args], mode: 'bwrap' };
  }
  if (status.mode === 'sandbox-exec') {
    return { file: 'sandbox-exec', args: ['-p', seatbeltProfile(options), file, ...args], mode: 'sandbox-exec' };
  }
  return { file, args, mode: 'none' };
}

/** Resets the cached probe (tests). */
export function resetSandboxProbe(): void {
  probed = undefined;
}
