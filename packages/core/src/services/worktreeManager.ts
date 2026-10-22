import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { GIT_NO_HOOKS, isWindowsReservedName, isPathInside } from '@wazir/shared';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  jobId: string;
  taskId?: string;
  worktreeDir: string;
  branch: string;
  baseBranch: string;
  /** Exact commit this worktree was created from (undefined for legacy/non-Git workspaces). */
  baseSha?: string;
  isGit: boolean;
  createdAt: Date;
}

export interface WorktreeCommitResult {
  committed: boolean;
  commitSha?: string;
  files: string[];
  message?: string;
}

export interface WorktreeMergeResult {
  success: boolean;
  mergedBranch: string;
  targetBranch: string;
  conflicts?: string[];
  error?: string;
}

export interface WorktreeManagerOptions {
  worktreeRootDir?: string;
}

/**
 * Git Worktree Isolation per Agent.
 *
 * Provides dedicated filesystem and branch isolation for concurrent agents:
 * - Every agent receives an isolated worktree (`.wazir/worktrees/<jobId>-<taskId>`
 *   or `.wazir/worktrees/<jobId>` for shared-job execution)
 *   on a dedicated branch (`wazir/<jobId>/<taskId>` or `wazir/<jobId>`).
 * - Concurrent file writes never collide.
 * - Merge-back story:
 *   - 'review' (default): Agent commits verified changes to its branch; the TUI/CLI
 *     reports the branch name and commit sha for human review/merge.
 *   - 'auto' (optional flag): Merges successfully completed worktrees back into
 *     the target branch automatically.
 */

export class WorktreeManager {
  private readonly rootOverride?: string;
  private readonly jobWorktrees = new Map<string, WorktreeInfo>();

  constructor(options: WorktreeManagerOptions = {}) {
    this.rootOverride = options.worktreeRootDir;
  }

  async isGitRepo(projectRoot: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', [...GIT_NO_HOOKS, 'rev-parse', '--is-inside-work-tree'], {
        cwd: projectRoot,
      });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async getCurrentBranch(projectRoot: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', [...GIT_NO_HOOKS, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: projectRoot,
      });
      return stdout.trim();
    } catch {
      return 'main';
    }
  }

  getWorktreeRootDir(projectRoot: string): string {
    return this.rootOverride ?? path.join(projectRoot, '.wazir', 'worktrees');
  }

  async getOrCreateJobWorktree(
    projectRoot: string,
    jobId: string,
  ): Promise<WorktreeInfo> {
    const existing = this.jobWorktrees.get(jobId);
    if (existing) {
      const exists = await fs.access(existing.worktreeDir).then(() => true).catch(() => false);
      if (exists) return existing;
    }
    const info = await this.createWorktree(projectRoot, jobId);
    this.jobWorktrees.set(jobId, info);
    return info;
  }

  async createWorktree(
    projectRoot: string,
    jobId: string,
    taskId?: string,
    baselineCommit?: string,
  ): Promise<WorktreeInfo> {
    assertSafeId('jobId', jobId);
    if (taskId !== undefined) assertSafeId('taskId', taskId);
    const isGit = await this.isGitRepo(projectRoot);
    const rootDir = path.resolve(this.getWorktreeRootDir(projectRoot));
    await fs.mkdir(rootDir, { recursive: true });

    const worktreeDir = path.resolve(rootDir, taskId ? `${jobId}-${taskId}` : jobId);
    // Belt and braces: the ids are validated above, but the directory that
    // gets `rm -rf`'d below must never be anything but a child of rootDir.
    const rel = path.relative(rootDir, worktreeDir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`worktree path '${worktreeDir}' escapes '${rootDir}'`);
    }
    if (await fs.access(worktreeDir).then(() => true).catch(() => false)) {
      throw new Error(`refusing to replace existing worktree path '${worktreeDir}'`);
    }
    const branch = taskId ? `wazir/${jobId}/${taskId}` : `wazir/${jobId}`;
    const baseBranch = isGit ? await this.getCurrentBranch(projectRoot) : 'none';
    const baseSha = isGit
      ? (await execFileAsync('git', [...GIT_NO_HOOKS, 'rev-parse', '--verify', `${baselineCommit ?? 'HEAD'}^{commit}`], { cwd: projectRoot })).stdout.trim()
      : undefined;

    if (!isGit) {
      // Fallback for non-git projects: copy directory entries excluding .wazir
      await fs.mkdir(worktreeDir, { recursive: true });
      const entries = await fs.readdir(projectRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.wazir' || entry.name === 'node_modules' || entry.name === '.git') {
          continue;
        }
        const srcPath = path.join(projectRoot, entry.name);
        const destPath = path.join(worktreeDir, entry.name);
        await fs.cp(srcPath, destPath, { recursive: true });
      }
      await fs.mkdir(path.join(worktreeDir, '.wazir', 'tmp'), { recursive: true });
      await fs.mkdir(path.join(worktreeDir, '.wazir', 'home'), { recursive: true });
      await fs.mkdir(path.join(worktreeDir, '.wazir', 'cache'), { recursive: true });
      return {
        jobId,
        taskId,
        worktreeDir,
        branch,
        baseBranch,
        isGit: false,
        createdAt: new Date(),
      };
    }

    // Ensure .wazir is excluded from git tracking so worktree directories do not dirty git status
    try {
      const excludeFile = path.join(projectRoot, '.git', 'info', 'exclude');
      const excludeExists = await fs.access(excludeFile).then(() => true).catch(() => false);
      if (excludeExists) {
        const content = await fs.readFile(excludeFile, 'utf8');
        if (!content.includes('.wazir')) {
          await fs.appendFile(excludeFile, '\n.wazir/\n');
        }
      }
    } catch {
      // ignore
    }

    try {
      // Create new branch and worktree from the exact commit recorded above.
      await execFileAsync(
        'git',
        [...GIT_NO_HOOKS, 'worktree', 'add', '-b', branch, worktreeDir, baseSha!],
        { cwd: projectRoot },
      );
    } catch (error) {
      if (baselineCommit) throw error; // Races must never attach a pre-existing branch.
      // If branch already exists (e.g. on resume/retry), attach to existing branch
      try {
        await execFileAsync(
          'git',
          [...GIT_NO_HOOKS, 'worktree', 'add', worktreeDir, branch],
          { cwd: projectRoot },
        );
      } catch (attachError) {
        throw new Error(`could not create or attach worktree '${worktreeDir}' on '${branch}'; refusing to reset an existing branch: ${attachError instanceof Error ? attachError.message : String(attachError)}`);
      }
    }

    await fs.mkdir(path.join(worktreeDir, '.wazir', 'tmp'), { recursive: true });
    await fs.mkdir(path.join(worktreeDir, '.wazir', 'home'), { recursive: true });
    await fs.mkdir(path.join(worktreeDir, '.wazir', 'cache'), { recursive: true });

    return {
      jobId,
      taskId,
      worktreeDir,
      branch,
      baseBranch,
      baseSha,
      isGit: true,
      createdAt: new Date(),
    };
  }

  /**
   * Creates a pristine, initially empty workspace for clean test/execution runs.
   * Free of any dirty artifacts from prior runs or repository contents.
   */
  async createCleanWorkspace(
    projectRoot: string,
    jobId: string,
    taskId?: string,
  ): Promise<WorktreeInfo> {
    assertSafeId('jobId', jobId);
    if (taskId !== undefined) assertSafeId('taskId', taskId);
    const rootDir = path.resolve(this.getWorktreeRootDir(projectRoot));
    await fs.mkdir(rootDir, { recursive: true });

    const worktreeDir = path.resolve(rootDir, taskId ? `clean-${jobId}-${taskId}` : `clean-${jobId}`);
    if (!worktreeDir.startsWith(rootDir + path.sep)) {
      throw new Error(`workspace path '${worktreeDir}' escapes '${rootDir}'`);
    }

    await this.cleanupDirectory(worktreeDir);
    await fs.mkdir(worktreeDir, { recursive: true });

    // Initialize environment subdirectories: .wazir/tmp, .wazir/home, .wazir/cache
    await fs.mkdir(path.join(worktreeDir, '.wazir', 'tmp'), { recursive: true });
    await fs.mkdir(path.join(worktreeDir, '.wazir', 'home'), { recursive: true });
    await fs.mkdir(path.join(worktreeDir, '.wazir', 'cache'), { recursive: true });

    return {
      jobId,
      taskId,
      worktreeDir,
      branch: taskId ? `wazir/clean/${jobId}/${taskId}` : `wazir/clean/${jobId}`,
      baseBranch: 'none',
      isGit: false,
      createdAt: new Date(),
    };
  }

  async commitWorktree(
    info: WorktreeInfo,
    commitMessage: string,
    options?: { intendedFiles?: string[]; enableHooks?: boolean },
  ): Promise<WorktreeCommitResult> {
    if (!info.isGit) {
      return { committed: false, files: [] };
    }

    try {
      const { stdout: status } = await execFileAsync(
        'git',
        [...GIT_NO_HOOKS, 'status', '--porcelain'],
        { cwd: info.worktreeDir },
      );

      const lines = status.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        return { committed: false, files: [] };
      }

      const files =
        options?.intendedFiles && options.intendedFiles.length > 0
          ? options.intendedFiles
          : lines.map((l) => l.slice(3).trim());

      if (options?.intendedFiles && options.intendedFiles.length > 0) {
        await execFileAsync('git', [...GIT_NO_HOOKS, 'reset'], { cwd: info.worktreeDir });
        await execFileAsync('git', [...GIT_NO_HOOKS, 'add', '--', ...options.intendedFiles], {
          cwd: info.worktreeDir,
        });
      } else {
        await execFileAsync('git', [...GIT_NO_HOOKS, 'add', '-A'], { cwd: info.worktreeDir });
      }

      const commitArgs = options?.enableHooks
        ? ['commit', '-m', commitMessage]
        : [...GIT_NO_HOOKS, 'commit', '-m', commitMessage];
      await execFileAsync('git', commitArgs, {
        cwd: info.worktreeDir,
      });

      const { stdout: sha } = await execFileAsync(
        'git',
        [...GIT_NO_HOOKS, 'rev-parse', 'HEAD'],
        { cwd: info.worktreeDir },
      );

      return {
        committed: true,
        commitSha: sha.trim(),
        files,
        message: commitMessage,
      };
    } catch (err) {
      return {
        committed: false,
        files: [],
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async diffWorktree(info: WorktreeInfo): Promise<string> {
    if (!info.isGit) return '';
    try {
      const { stdout } = await execFileAsync(
        'git',
        [...GIT_NO_HOOKS, 'diff', 'HEAD~1..HEAD'],
        { cwd: info.worktreeDir },
      );
      return stdout;
    } catch {
      try {
        const { stdout } = await execFileAsync('git', [...GIT_NO_HOOKS, 'diff'], { cwd: info.worktreeDir });
        return stdout;
      } catch {
        return '';
      }
    }
  }

  async mergeBranch(
    projectRoot: string,
    branch: string,
    targetBranch?: string,
  ): Promise<WorktreeMergeResult> {
    const target = targetBranch ?? (await this.getCurrentBranch(projectRoot));
    try {
      const { stdout: status } = await execFileAsync('git', [...GIT_NO_HOOKS, 'status', '--porcelain'], { cwd: projectRoot });
      if (status.trim()) throw new Error('refusing to merge into a dirty target worktree');
      // Checkout target branch
      await execFileAsync('git', [...GIT_NO_HOOKS, 'checkout', target], { cwd: projectRoot });

      // Merge branch
      await execFileAsync(
        'git',
        [...GIT_NO_HOOKS, 'merge', '--no-ff', branch, '-m', `Merge branch '${branch}' into ${target}`],
        { cwd: projectRoot },
      );

      return {
        success: true,
        mergedBranch: branch,
        targetBranch: target,
      };
    } catch (error) {
      // Check for conflict
      let conflicts: string[] = [];
      try {
        const { stdout: status } = await execFileAsync('git', [...GIT_NO_HOOKS, 'status', '--porcelain'], {
          cwd: projectRoot,
        });
        conflicts = status
          .trim()
          .split('\n')
          .filter((l) => l.startsWith('UU') || l.startsWith('AA') || l.startsWith('UD'))
          .map((l) => l.slice(3).trim());

        // Abort failed merge to leave repo clean
        await execFileAsync('git', [...GIT_NO_HOOKS, 'merge', '--abort'], { cwd: projectRoot });
      } catch {
        // ignore cleanup error
      }

      return {
        success: false,
        mergedBranch: branch,
        targetBranch: target,
        conflicts,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async removeWorktree(info: WorktreeInfo): Promise<void> {
    if (info.isGit) {
      try {
        await execFileAsync(
          'git',
          [...GIT_NO_HOOKS, 'worktree', 'remove', '--force', info.worktreeDir],
          { cwd: path.dirname(info.worktreeDir) },
        );
      } catch {
        // fallback to manual fs cleanup
      }
    }
    await this.cleanupDirectory(info.worktreeDir);
  }

  private async cleanupDirectory(targetPath: string): Promise<void> {
    // Only ever delete inside a `.wazir/worktrees` tree (or the configured
    // override); never a path handed in from elsewhere.
    const resolved = path.resolve(targetPath);
    const allowedRoot = this.rootOverride ? path.resolve(this.rootOverride) : undefined;
    const underOverride = allowedRoot !== undefined && isPathInside(allowedRoot, resolved) && resolved !== allowedRoot;
    const parts = resolved.split(/[/\\]/).map((p) => p.toLowerCase());
    const underDefault = parts.includes('worktrees') && parts.includes('.wazir');
    if (!underOverride && !underDefault) {
      throw new Error(`refusing to remove '${resolved}': not a Wazir worktree directory`);
    }
    try {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore
    }
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Ids become path segments and git branch names; keep them boring. */
function assertSafeId(label: string, value: string): void {
  if (!SAFE_ID.test(value) || value.includes('..') || isWindowsReservedName(value) || value.endsWith('.') || value.endsWith(' ')) {
    throw new Error(`invalid ${label} '${value}': must match ${SAFE_ID} and not be a Windows reserved name or contain trailing dots/spaces`);
  }
}

export function createWorktreeManager(options: WorktreeManagerOptions = {}): WorktreeManager {
  return new WorktreeManager(options);
}
