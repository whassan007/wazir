import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type PreflightErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_PERMISSION_DENIED'
  | 'TEMP_DIRECTORY_UNWRITABLE'
  | 'SHELL_UNAVAILABLE'
  | 'COMPILER_UNAVAILABLE'
  | 'COMPILER_PROBE_FAILED'
  | 'ENVIRONMENT_DEGRADED';

export interface PreflightCheckResult {
  ok: boolean;
  code?: PreflightErrorCode;
  failureClass: 'infrastructure';
  reason?: string;
  tmpDir?: string;
  compilerAvailable?: boolean;
  details?: Record<string, unknown>;
}

export interface PreflightOptions {
  workspace: string;
  taskPrompt?: string;
  capabilities?: string[];
  requiredTools?: string[];
  /** Skip compiler probe execution if true (e.g. for non-code tasks). */
  skipCompilerProbe?: boolean;
}

/**
 * Worker Preflight Service
 *
 * Runs deterministic infrastructure validation BEFORE handing control to any model.
 * Verifies:
 * 1. Workspace directory exists and is readable/writable.
 * 2. .wazir/tmp temp directory is established and writable.
 * 3. System shell is available.
 * 4. Compiler probe (for C++ / compiled tasks) actually compiles a minimal program.
 *
 * If any check fails, execution fails immediately with an infrastructure error
 * rather than asking the LLM to meta-debug broken host infrastructure.
 */
export async function runWorkerPreflight(options: PreflightOptions): Promise<PreflightCheckResult> {
  const { workspace } = options;

  // 1. Workspace existence and permissions
  try {
    const stat = await fs.stat(workspace);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        failureClass: 'infrastructure',
        code: 'WORKSPACE_NOT_FOUND',
        reason: `Workspace path is not a directory: '${workspace}'`,
      };
    }
  } catch (err: any) {
    return {
      ok: false,
      failureClass: 'infrastructure',
      code: 'WORKSPACE_NOT_FOUND',
      reason: `Workspace path does not exist: '${workspace}' (${err?.message ?? String(err)})`,
    };
  }

  try {
    await fs.access(workspace, fsConstants.R_OK | fsConstants.W_OK);
  } catch (err) {
    return {
      ok: false,
      failureClass: 'infrastructure',
      code: 'WORKSPACE_PERMISSION_DENIED',
      reason: `Execution workspace '${workspace}' is not readable and writable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Normalized temp directory (.wazir/tmp, .wazir/home, .wazir/cache)
  const tmpDir = path.join(workspace, '.wazir', 'tmp');
  const homeDir = path.join(workspace, '.wazir', 'home');
  const cacheDir = path.join(workspace, '.wazir', 'cache');

  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(cacheDir, { recursive: true });

    // Probe writability by writing and unlinking a temporary file
    const probeFile = path.join(tmpDir, `.preflight_probe_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
    await fs.writeFile(probeFile, 'wazir_preflight_ok\n', 'utf8');
    await fs.unlink(probeFile);
  } catch (err) {
    return {
      ok: false,
      failureClass: 'infrastructure',
      code: 'TEMP_DIRECTORY_UNWRITABLE',
      reason: `Workspace temp directory '${tmpDir}' is not writable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. Shell availability
  const isWindows = process.platform === 'win32';
  if (!isWindows) {
    const shellPath = process.env.SHELL || '/bin/sh';
    try {
      await fs.access(shellPath, fsConstants.X_OK);
    } catch {
      try {
        await fs.access('/bin/sh', fsConstants.X_OK);
      } catch {
        return {
          ok: false,
          failureClass: 'infrastructure',
          code: 'SHELL_UNAVAILABLE',
          reason: `System shell '${shellPath}' is not executable.`,
        };
      }
    }
  }

  // 4. Toolchain & Compiler Probes
  let compilerAvailable = false;
  if (!options.skipCompilerProbe) {
    const lowerPrompt = (options.taskPrompt ?? '').toLowerCase();
    const isCpp =
      options.capabilities?.some((c) => c.toLowerCase().includes('cpp') || c.toLowerCase().includes('c++')) ||
      /\b(c\+\+|cpp|g\+\+|clang\+\+|quick_sort|quicksort|sort.*array)\b/i.test(lowerPrompt);

    if (isCpp) {
      // Find compiler: try g++ then clang++
      let compiler: string | undefined;
      for (const candidate of ['g++', 'clang++']) {
        try {
          await execFileAsync(candidate, ['--version'], { timeout: 3000 });
          compiler = candidate;
          break;
        } catch {
          // not found or error, try next
        }
      }

      if (!compiler) {
        return {
          ok: false,
          failureClass: 'infrastructure',
          code: 'COMPILER_UNAVAILABLE',
          reason: 'C++ compiler (neither g++ nor clang++) is available on PATH.',
        };
      }
      compilerAvailable = true;

      // Run live compile probe
      const probeSrc = path.join(tmpDir, `.cpp_probe_${Date.now()}.cpp`);
      const probeBin = path.join(tmpDir, `.cpp_probe_${Date.now()}`);

      try {
        await fs.writeFile(probeSrc, 'int main(){return 0;}\n', 'utf8');
        await execFileAsync(compiler, [probeSrc, '-o', probeBin], {
          cwd: workspace,
          env: {
            ...process.env,
            TMPDIR: tmpDir,
            HOME: homeDir,
            XDG_CACHE_HOME: cacheDir,
          },
          timeout: 5000,
        });
      } catch (err: any) {
        const stderr = (err?.stderr ?? err?.message ?? '').toString();
        const isTempFailure = /unable to make temporary file|permission denied|read-only file system/i.test(stderr);
        return {
          ok: false,
          failureClass: 'infrastructure',
          code: isTempFailure ? 'TEMP_DIRECTORY_UNWRITABLE' : 'COMPILER_PROBE_FAILED',
          reason: isTempFailure
            ? `C++ compiler probe failed because temporary directory is unwritable under the current environment/sandbox:\n${stderr}`
            : `C++ compiler probe failed to compile minimal program:\n${stderr}`,
        };
      } finally {
        await fs.unlink(probeSrc).catch(() => {});
        await fs.unlink(probeBin).catch(() => {});
      }
    }
  }

  return {
    ok: true,
    failureClass: 'infrastructure',
    tmpDir,
    compilerAvailable,
  };
}
