/**
 * Resource caps (memory, CPU time, process count, output file size) for tool
 * subprocesses. The OS sandbox (sandbox.ts) restricts what a process can
 * *touch*; this restricts how much of the machine it can *consume* — neither
 * bwrap nor sandbox-exec apply rlimits on their own, so before this a
 * runaway or hostile tool invocation (a memory leak, a fork bomb, an
 * infinite CPU-bound loop that never produces output and so never trips
 * `maxBuffer`) had nothing capping it beyond the wall-clock `timeoutMs`,
 * which a CPU-bound spin with no output still runs into eventually but only
 * after consuming the box's memory/CPU for the whole timeout window.
 *
 * Implemented as a portable `ulimit` wrapper rather than a native binding:
 * bash's `ulimit` builtin sets POSIX rlimits (RLIMIT_AS, RLIMIT_CPU,
 * RLIMIT_NPROC, RLIMIT_FSIZE) on the shell itself, which `exec` then carries
 * into the real command with no extra process in the tree. This composes
 * with the existing sandbox wrapping: the ulimit'd bash becomes the command
 * bwrap/sandbox-exec wraps, so limits apply inside the sandbox's namespaces.
 */
export interface ResourceLimits {
  /** RLIMIT_AS — virtual address space, in MB. Best-effort: macOS bash often can't set this; failures are swallowed rather than blocking the command. */
  maxMemoryMB?: number;
  /** RLIMIT_CPU — total CPU seconds, not wall-clock time. Catches a spin loop long before timeoutMs would. */
  maxCpuSeconds?: number;
  /** RLIMIT_NPROC — max processes/threads for the invoking user in this shell's session. Fork-bomb protection. */
  maxProcesses?: number;
  /** RLIMIT_FSIZE — max size of any single file the process writes, in MB. */
  maxFileSizeMB?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * The limits applied when a caller doesn't specify its own — generous
 * enough not to break a real build/test run, tight enough to bound a
 * runaway one. `0` (or `WAZIR_RESOURCE_LIMITS=0`) disables a given limit.
 *
 * `maxMemoryMB` and `maxProcesses` are deliberately NOT enabled by default,
 * even though the type supports them (set explicitly via
 * `WAZIR_MAX_MEMORY_MB`/`WAZIR_MAX_PROCESSES` or a caller's own
 * `resourceLimits` to opt in) — both broke real commands during testing:
 *
 * - `maxMemoryMB` uses RLIMIT_AS (virtual address space). V8/Node reserves
 *   large virtual regions up front regardless of actual usage, so any
 *   command that spawns Node (`npm run ...`, most JS tooling) can fail
 *   outright under a cap that looks generous on paper.
 * - `maxProcesses` uses RLIMIT_NPROC, which counts ALL processes/threads for
 *   the real UID *system-wide*, not just this command's subprocess tree. On
 *   a shared dev machine or CI box already running hundreds of unrelated
 *   processes under the same user, a "512 process" cap is not a sandbox
 *   limit at all — it can trip immediately regardless of what the tool
 *   command itself does. This was caught directly: this repo's own dev
 *   session already had 1300+ processes/threads under its UID, so a default
 *   of 512 made every `npm run` spawn fail (`security.test.ts` went from
 *   passing to failing the moment this was enabled by default).
 */
export function defaultResourceLimits(): ResourceLimits {
  if ((process.env.WAZIR_RESOURCE_LIMITS ?? '1').trim().toLowerCase() === '0') {
    return {};
  }
  return {
    maxMemoryMB: envInt('WAZIR_MAX_MEMORY_MB', 0),
    maxCpuSeconds: envInt('WAZIR_MAX_CPU_SECONDS', 600),
    maxProcesses: envInt('WAZIR_MAX_PROCESSES', 0),
    maxFileSizeMB: envInt('WAZIR_MAX_FILE_SIZE_MB', 4096),
  };
}

function ulimitScript(limits: ResourceLimits): string {
  const parts: string[] = [];
  if (limits.maxMemoryMB) parts.push(`ulimit -v ${limits.maxMemoryMB * 1024} 2>/dev/null`);
  if (limits.maxCpuSeconds) parts.push(`ulimit -t ${limits.maxCpuSeconds} 2>/dev/null`);
  if (limits.maxProcesses) parts.push(`ulimit -u ${limits.maxProcesses} 2>/dev/null`);
  if (limits.maxFileSizeMB) parts.push(`ulimit -f ${limits.maxFileSizeMB * 1024} 2>/dev/null`);
  parts.push('exec "$@"');
  return parts.join('; ');
}

/**
 * Wraps `file args` so that, once spawned, the process runs under the given
 * rlimits. Pure: safe to unit test. No-op on win32 (no POSIX ulimit) or when
 * every limit is unset/zero — callers should check `applied` before
 * reporting a limit as active.
 */
export function wrapWithResourceLimits(
  file: string,
  args: string[],
  limits: ResourceLimits,
): { file: string; args: string[]; applied: boolean } {
  const active = Boolean(limits.maxMemoryMB || limits.maxCpuSeconds || limits.maxProcesses || limits.maxFileSizeMB);
  if (!active || process.platform === 'win32') {
    return { file, args, applied: false };
  }
  return {
    file: 'bash',
    args: ['-c', ulimitScript(limits), 'wazir-limited', file, ...args],
    applied: true,
  };
}
