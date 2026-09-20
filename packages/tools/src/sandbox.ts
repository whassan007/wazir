import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, lstatSync, readFileSync } from 'node:fs';
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
 * Selection: `WAZIR_SANDBOX=auto|required|bwrap|sandbox-exec|none` (default
 * `auto`). `auto` warns and falls back to the host when no backend works;
 * `required` refuses to run tool processes at all in that case (fail closed —
 * the setting for shared or internet-facing deployments). A backend named
 * explicitly that cannot start is treated like `required`.
 *
 * On Linux the bwrap child additionally gets a seccomp denylist (see
 * `seccompFilter`) so that even a process that finds a kernel or bwrap bug
 * cannot reach for mount/ptrace/module/bpf syscalls. `WAZIR_SANDBOX_SECCOMP=0`
 * disables just the filter.
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
  /** Backend that was requested (`auto`/`required` resolve to the first usable one). */
  requested: string;
  /** Human-readable reason when the mode is `none` or differs from the request. */
  reason?: string;
  /** True when `mode` is `none` but the configuration forbids host execution. */
  required?: boolean;
  /** Whether bwrap children get the seccomp filter (Linux only). */
  seccomp?: boolean;
}

export interface WrappedCommand {
  file: string;
  args: string[];
  mode: SandboxMode;
  /** seccomp program to feed to bwrap on fd 3 (`--seccomp 3`). */
  seccomp?: Buffer;
}

/** Thrown by `wrapInSandbox` when the sandbox is required but unavailable. */
export class SandboxUnavailableError extends Error {
  constructor(status: SandboxStatus) {
    super(`tool sandbox required (WAZIR_SANDBOX=${status.requested}) but unavailable: ${status.reason ?? 'no backend'}`);
    this.name = 'SandboxUnavailableError';
  }
}

// Toolchain locations under $HOME that tools legitimately need. Everything
// else in the home directory is masked.
const HOME_TOOLCHAIN_DIRS = [
  '.nvm', '.volta', '.fnm', '.n', '.bun', '.deno', '.local/bin', '.local/share/pnpm', '.local/share/mise', '.asdf',
  '.cargo', '.rustup', '.go', 'go', '.pyenv', '.rbenv', '.sdkman', '.gradle', '.m2', '.yarn', '.config/yarn',
];
// Caches under $HOME that package managers write to. `Library/Caches` is macOS's
// general-purpose per-user cache directory — notably where Apple's clang/Xcode
// toolchain keeps its module cache (`~/Library/Caches/org.llvm.clang.<id>/ModuleCache`,
// among others). Without it, a sandboxed `g++`/`clang++` invocation on macOS can fail
// outright with "Operation not permitted" trying to touch its own cache, even compiling
// a trivial file with no explicit module usage. Cache data is disposable and non-
// sensitive by definition (unlike `Library/Preferences` or `Application Support`, which
// hold real app state), so exposing the whole directory — rather than guessing the exact
// versioned/hashed subpath a given clang build uses — is the safe, robust version of this
// fix. No-op on Linux: `existingDirs()` only binds paths that actually exist.
const HOME_CACHE_DIRS = ['.npm', '.cache/pnpm', '.cache/yarn', '.cache/pip', '.cache/go-build', '.cargo/registry', '.bun/install/cache', 'Library/Caches'];
// Host directories with no legitimate use for a tool process: other users'
// homes, removable media, mounted shares, service data. Masked entirely
// (the project and the operator's toolchains are re-bound afterwards).
const MASKED_HOST_DIRS = ['/home', '/Users', '/root', '/mnt', '/media', '/srv'];

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
  const result = spawnSync(bin, ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-user', '--unshare-pid', '--disable-userns', '--die-with-parent', '--', '/bin/true'], {
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
  const seccomp = process.platform === 'linux' && seccompEnabled();
  // An explicitly named backend must work: falling back silently would turn
  // a deliberate hardening choice into host execution.
  if (requested === 'bwrap') {
    const probe = probeBwrap();
    probed = probe.ok ? { mode: 'bwrap', requested, seccomp } : { mode: 'none', requested, reason: probe.reason, required: true };
    return probed;
  }
  if (requested === 'sandbox-exec') {
    const probe = probeSandboxExec();
    probed = probe.ok ? { mode: 'sandbox-exec', requested } : { mode: 'none', requested, reason: probe.reason, required: true };
    return probed;
  }
  if (requested !== 'auto' && requested !== 'required') {
    probed = { mode: 'none', requested, reason: `unknown WAZIR_SANDBOX value '${requested}' (use auto|required|bwrap|sandbox-exec|none)`, required: true };
    return probed;
  }

  const attempts: string[] = [];
  if (process.platform === 'linux') {
    const probe = probeBwrap();
    if (probe.ok) {
      probed = { mode: 'bwrap', requested, seccomp };
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
  probed = { mode: 'none', requested, reason: attempts.join('; '), required: requested === 'required' };
  return probed;
}

/** True when the requested backend could not be used and execution fell back to the host. */
export function sandboxDegraded(status: SandboxStatus = sandboxStatus()): boolean {
  return status.mode === 'none' && status.requested !== 'none';
}

/** True when tool processes must not run at all because the sandbox is unavailable. */
export function sandboxRequired(status: SandboxStatus = sandboxStatus()): boolean {
  return status.mode === 'none' && status.required === true;
}

/** For a git worktree, the main repository's `.git` directory that holds its metadata. */
function worktreeGitDir(project: string): string | undefined {
  const dotGit = path.join(project, '.git');
  try {
    if (!lstatSync(dotGit).isFile()) return undefined;
    const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!match) return undefined;
    const gitdir = path.resolve(project, match[1].trim()); // <main>/.git/worktrees/<name>
    const common = path.resolve(gitdir, '..', '..'); // <main>/.git
    return path.basename(common) === '.git' && existsSync(common) ? common : gitdir;
  } catch {
    return undefined;
  }
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

  // Mask other users' homes, mounts and service data, then the operator's
  // home, then re-expose only toolchains (ro) and caches (rw).
  const resolvedHome = path.resolve(home);
  for (const dir of MASKED_HOST_DIRS) if (isRealDirectory(dir)) args.push('--tmpfs', dir);
  args.push('--tmpfs', resolvedHome);
  for (const dir of existingDirs(resolvedHome, HOME_TOOLCHAIN_DIRS)) args.push('--ro-bind', dir, dir);
  for (const dir of existingDirs(resolvedHome, HOME_CACHE_DIRS)) args.push('--bind', dir, dir);
  for (const dir of options.readOnlyPaths ?? []) if (existsSync(dir)) args.push('--ro-bind', dir, dir);

  // The project is the only writable tree besides /tmp; it must come after the
  // home mask because it usually lives under $HOME.
  args.push('--bind', project, project);
  // A git worktree keeps its index/HEAD under the main repository's .git
  // (`.git` is a file with `gitdir: ...`); expose just that slice read-write
  // so `git add`/`commit` inside the worktree keep working.
  const gitCommon = worktreeGitDir(project);
  if (gitCommon && !isInside(project, gitCommon)) args.push('--bind', gitCommon, gitCommon);
  for (const dir of options.readWritePaths ?? []) if (existsSync(dir)) args.push('--bind', dir, dir);

  // Temp dirs outside /tmp (macOS-style or TMPDIR overrides) stay writable.
  const tmp = path.resolve(platformTmp);
  if (tmp !== '/tmp' && !isInside(project, tmp) && existsSync(tmp)) args.push('--bind', tmp, tmp);

  const cwd = path.resolve(options.cwd);
  args.push(
    '--chdir', isInside(project, cwd) || isInside(tmp, cwd) ? cwd : project,
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    // No nested user namespaces: blocks the mount/setns tricks a process
    // could otherwise use to rearrange its own view (bwrap ≥ 0.8).
    '--disable-userns',
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
    const seccomp = status.seccomp ? seccompFilter() : undefined;
    const base = bwrapArgs(options);
    // `--seccomp` must precede `--`; the caller feeds the program on fd 3.
    const wrapped = seccomp ? [...base.slice(0, -1), '--seccomp', '3', '--'] : base;
    return { file: 'bwrap', args: [...wrapped, file, ...args], mode: 'bwrap', seccomp };
  }
  if (status.mode === 'sandbox-exec') {
    return { file: 'sandbox-exec', args: ['-p', seatbeltProfile(options), file, ...args], mode: 'sandbox-exec' };
  }
  if (sandboxRequired(status)) throw new SandboxUnavailableError(status);
  return { file, args, mode: 'none' };
}

// ---------------------------------------------------------------------------
// seccomp filter for bwrap (`--seccomp FD`)
//
// bubblewrap installs the filter in the child right before exec, so it only
// constrains the tool process, not bwrap's own namespace setup. The filter is
// a denylist: everything is allowed except syscalls that only exist to
// rearrange the sandbox or reach into other processes / the kernel —
// mount family, pivot_root, ptrace + process_vm_*, setns/unshare + clone
// with CLONE_NEW* flags, module loading, kexec/reboot, bpf, perf,
// userfaultfd, kernel keyrings, clock setting. Denied calls fail with EPERM
// (clone3 with ENOSYS so glibc falls back to clone, which is inspected).
//
// The program is hand-assembled classic BPF so no native dependency
// (libseccomp) is needed; `SECCOMP_SYSCALLS` is the source of truth.
// ---------------------------------------------------------------------------

const AUDIT_ARCH = { x64: 0xc000003e, arm64: 0xc00000b7 } as const;
const X32_SYSCALL_BIT = 0x40000000;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const EPERM = 1;
const ENOSYS = 38;
// BPF opcodes
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const JSET_K = 0x45;
const RET_K = 0x06;
// struct seccomp_data offsets (little-endian; low word of args[0])
const OFF_NR = 0;
const OFF_ARCH = 4;
const OFF_ARG0_LO = 16;
// CLONE_NEWNS | NEWCGROUP | NEWUTS | NEWIPC | NEWUSER | NEWPID | NEWNET
const CLONE_NEW_MASK = 0x20000 | 0x2000000 | 0x4000000 | 0x8000000 | 0x10000000 | 0x20000000 | 0x40000000;

/** Syscall numbers per architecture: [x86_64, aarch64]. */
export const SECCOMP_SYSCALLS: Record<string, [number, number]> = {
  // namespaces / mounts
  mount: [165, 40], umount2: [166, 39], pivot_root: [155, 41], setns: [308, 268], unshare: [272, 97],
  open_tree: [428, 428], move_mount: [429, 429], fsopen: [430, 430], fsconfig: [431, 431], fsmount: [432, 432], fspick: [433, 433], mount_setattr: [442, 442],
  open_by_handle_at: [304, 265],
  // other processes
  ptrace: [101, 117], process_vm_readv: [310, 270], process_vm_writev: [311, 271],
  // kernel
  init_module: [175, 105], finit_module: [313, 273], delete_module: [176, 106],
  kexec_load: [246, 104], kexec_file_load: [320, 294], reboot: [169, 142], swapon: [167, 224], swapoff: [168, 225], acct: [163, 89],
  bpf: [321, 280], perf_event_open: [298, 241], userfaultfd: [323, 282],
  add_key: [248, 217], request_key: [249, 218], keyctl: [250, 219],
  settimeofday: [164, 170], clock_settime: [227, 112], adjtimex: [159, 171], clock_adjtime: [305, 266],
};
const SYSCALL_CLONE: [number, number] = [56, 220];
const SYSCALL_CLONE3: [number, number] = [435, 435];

type BpfArch = keyof typeof AUDIT_ARCH;

function bpfArch(arch: string = process.arch): BpfArch | undefined {
  return arch === 'x64' || arch === 'arm64' ? arch : undefined;
}

/** True when a seccomp filter will be attached to bwrap children. */
export function seccompEnabled(arch: string = process.arch): boolean {
  const value = (process.env.WAZIR_SANDBOX_SECCOMP ?? '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(value) && bpfArch(arch) !== undefined;
}

/**
 * Classic-BPF seccomp program for `arch` (`x64` | `arm64`), as bwrap reads it
 * from `--seccomp FD`. Pure: safe to unit test. Returns undefined for
 * architectures without a syscall table here (the sandbox then runs without
 * a filter; the mount/userns restrictions still apply).
 */
export function seccompFilter(arch: string = process.arch): Buffer | undefined {
  const target = bpfArch(arch);
  if (!target) return undefined;
  const column = target === 'x64' ? 0 : 1;
  const insns: Array<[number, number, number, number]> = []; // code, jt, jf, k
  const emit = (code: number, jt: number, jf: number, k: number) => insns.push([code, jt, jf, k]);

  // Placeholders for the jump targets are patched once the layout is known.
  emit(LD_W_ABS, 0, 0, OFF_ARCH);
  emit(JEQ_K, 1, 0, AUDIT_ARCH[target]);
  emit(RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS);
  emit(LD_W_ABS, 0, 0, OFF_NR);
  if (target === 'x64') {
    // x32 ABI reuses numbers with bit 30 set; there is no legitimate use here.
    emit(JGE_K, 0, 1, X32_SYSCALL_BIT);
    emit(RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS);
  }
  const denied = Object.values(SECCOMP_SYSCALLS).map((numbers) => numbers[column]).sort((a, b) => a - b);
  const firstDeny = insns.length;
  for (const nr of denied) emit(JEQ_K, 0, 0, nr); // jt patched → EPERM
  // clone3 → ENOSYS (glibc retries with clone); clone with CLONE_NEW* → EPERM
  const clone3 = insns.length;
  emit(JEQ_K, 0, 0, SYSCALL_CLONE3[column]); // jt patched → ENOSYS
  const clone = insns.length;
  emit(JEQ_K, 0, 0, SYSCALL_CLONE[column]); // jf patched → ALLOW
  emit(LD_W_ABS, 0, 0, OFF_ARG0_LO);
  emit(JSET_K, 0, 0, CLONE_NEW_MASK); // jt patched → EPERM, jf → ALLOW
  const retAllow = insns.length;
  emit(RET_K, 0, 0, SECCOMP_RET_ALLOW);
  const retEperm = insns.length;
  emit(RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  const retEnosys = insns.length;
  emit(RET_K, 0, 0, SECCOMP_RET_ERRNO | ENOSYS);

  const jumpTo = (from: number, to: number) => to - from - 1;
  for (let i = firstDeny; i < clone3; i += 1) insns[i][1] = jumpTo(i, retEperm);
  insns[clone3][1] = jumpTo(clone3, retEnosys);
  insns[clone][2] = jumpTo(clone, retAllow);
  insns[clone + 2][1] = jumpTo(clone + 2, retEperm);
  insns[clone + 2][2] = jumpTo(clone + 2, retAllow);

  const program = Buffer.alloc(insns.length * 8);
  insns.forEach(([code, jt, jf, k], i) => {
    if (jt > 255 || jf > 255) throw new Error('seccomp filter too large for 8-bit jump offsets');
    program.writeUInt16LE(code, i * 8);
    program.writeUInt8(jt, i * 8 + 2);
    program.writeUInt8(jf, i * 8 + 3);
    program.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return program;
}

/** Resets the cached probe (tests). */
export function resetSandboxProbe(): void {
  probed = undefined;
}
