import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  jobId: string;
  taskId: string;
  worktreeDir: string;
  branch: string;
  baseBranch: string;
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
 * - Every agent receives an isolated worktree (`.wazir/worktrees/<jobId>-<taskId>`)
 *   on a dedicated branch (`wazir/<jobId>/<taskId>`).
 * - Concurrent file writes never collide.
 * - Merge-back story:
 *   - 'review' (default): Agent commits verified changes to its branch; the TUI/CLI
 *     surfaces diffs and lets the user review/merge without risky auto-overwrites.
 *   - 'auto': Attempts clean merge-back sequentially, aborting and flagging conflicts
 *     if git encounters merge conflicts.
 */
export class WorktreeManager {
  private readonly rootOverride?: string;

  constructor(options: WorktreeManagerOptions = {}) {
    this.rootOverride = options.worktreeRootDir;
  }

  async isGitRepo(projectRoot: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: projectRoot,
      });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async getCurrentBranch(projectRoot: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
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

  async createWorktree(
    projectRoot: string,
    jobId: string,
    taskId: string,
  ): Promise<WorktreeInfo> {
    const isGit = await this.isGitRepo(projectRoot);
    const rootDir = this.getWorktreeRootDir(projectRoot);
    await fs.mkdir(rootDir, { recursive: true });

    const worktreeDir = path.resolve(rootDir, `${jobId}-${taskId}`);
    const branch = `wazir/${jobId}/${taskId}`;
    const baseBranch = isGit ? await this.getCurrentBranch(projectRoot) : 'none';

    if (!isGit) {
      // Fallback for non-git projects: copy directory
      await fs.mkdir(worktreeDir, { recursive: true });
      await fs.cp(projectRoot, worktreeDir, {
        recursive: true,
        filter: (source) => !source.includes('.wazir') && !source.includes('node_modules'),
      });
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

    // Clean up any stale worktree directory if it exists
    await this.cleanupDirectory(worktreeDir);

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
      // Create new branch and worktree from HEAD
      await execFileAsync(
        'git',
        ['worktree', 'add', '-b', branch, worktreeDir, 'HEAD'],
        { cwd: projectRoot },
      );
    } catch (error) {
      // If branch already exists (e.g. on resume/retry), attach to existing branch
      try {
        await execFileAsync(
          'git',
          ['worktree', 'add', worktreeDir, branch],
          { cwd: projectRoot },
        );
      } catch {
        // Fallback: force create worktree
        await execFileAsync(
          'git',
          ['worktree', 'add', '--force', '-B', branch, worktreeDir, 'HEAD'],
          { cwd: projectRoot },
        );
      }
    }

    return {
      jobId,
      taskId,
      worktreeDir,
      branch,
      baseBranch,
      isGit: true,
      createdAt: new Date(),
    };
  }

  async commitWorktree(
    info: WorktreeInfo,
    commitMessage: string,
  ): Promise<WorktreeCommitResult> {
    if (!info.isGit) {
      return { committed: false, files: [] };
    }

    try {
      const { stdout: status } = await execFileAsync(
        'git',
        ['status', '--porcelain'],
        { cwd: info.worktreeDir },
      );

      const lines = status.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        return { committed: false, files: [] };
      }

      const files = lines.map((l) => l.slice(3).trim());

      await execFileAsync('git', ['add', '-A'], { cwd: info.worktreeDir });
      await execFileAsync('git', ['commit', '-m', commitMessage], {
        cwd: info.worktreeDir,
      });

      const { stdout: sha } = await execFileAsync(
        'git',
        ['rev-parse', 'HEAD'],
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
        ['diff', 'HEAD~1..HEAD'],
        { cwd: info.worktreeDir },
      );
      return stdout;
    } catch {
      try {
        const { stdout } = await execFileAsync('git', ['diff'], { cwd: info.worktreeDir });
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
      // Checkout target branch
      await execFileAsync('git', ['checkout', target], { cwd: projectRoot });

      // Merge branch
      await execFileAsync(
        'git',
        ['merge', '--no-ff', branch, '-m', `Merge branch '${branch}' into ${target}`],
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
        const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], {
          cwd: projectRoot,
        });
        conflicts = status
          .trim()
          .split('\n')
          .filter((l) => l.startsWith('UU') || l.startsWith('AA') || l.startsWith('UD'))
          .map((l) => l.slice(3).trim());

        // Abort failed merge to leave repo clean
        await execFileAsync('git', ['merge', '--abort'], { cwd: projectRoot });
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
          ['worktree', 'remove', '--force', info.worktreeDir],
          { cwd: path.dirname(info.worktreeDir) },
        );
      } catch {
        // fallback to manual fs cleanup
      }
    }
    await this.cleanupDirectory(info.worktreeDir);
  }

  private async cleanupDirectory(targetPath: string): Promise<void> {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function createWorktreeManager(options: WorktreeManagerOptions = {}): WorktreeManager {
  return new WorktreeManager(options);
}
