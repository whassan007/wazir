import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { GIT_NO_HOOKS, isWindowsReservedName, isPathInside } from '@wazir/shared';
import { DEFAULT_SPEC_DIRS, isSpecAuthorRole, normalizeSpecDirs } from './policyEngine.js';

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
  /** Trusted task role the worktree was created for (WFA §1.5). */
  role?: string;
  /** Read-only spec fence applied to this worktree; absent only for `spec-author` tasks. */
  specFence?: SpecReadOnlyFence;
}

/**
 * Layer A of the spec write fence for one worktree. File permissions alone do
 * not stop an owning process (it can `chmod u+w` or rename the directory), so
 * callers must also run the task under the OS sandbox with the rules below and
 * propagate `requiredIsolation` to the policy engine, which then fails closed
 * when no sandbox is active. The merge fence is the independent backstop.
 */
export interface SpecReadOnlyFence {
  role?: string;
  /** Absolute spec directories made read-only (created empty when absent). */
  readOnlyPaths: string[];
  /** bwrap arguments; place them after the worktree's writable `--bind` so they take precedence. */
  bwrapArgs: string[];
  /** Seatbelt rules; append them after the profile's project write allowances (later rules win). */
  seatbeltRules: string[];
  /** Isolation the policy engine must require for this execution. */
  requiredIsolation: 'os';
  /** Identity of each fenced directory at fence time, used to detect replacement. */
  identities: Array<{ path: string; dev: number; ino: number }>;
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
  /** Repository-relative spec directories fenced read-only for non-`spec-author` tasks (default `['specs']`). */
  specDirs?: string[];
}

export interface CreateWorktreeOptions {
  /**
   * Persisted task role from the trusted task record. Every role except
   * `spec-author` — including a missing one — gets a read-only spec fence.
   */
  role?: string;
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
  private readonly specDirs: string[];

  constructor(options: WorktreeManagerOptions = {}) {
    this.rootOverride = options.worktreeRootDir;
    this.specDirs = normalizeSpecDirs(options.specDirs ?? DEFAULT_SPEC_DIRS);
  }

  /**
   * Makes every spec directory of `worktreeDir` read-only (`chmod -R a-w`,
   * creating it first when absent so the task cannot create one) and returns
   * the sandbox rules that make the fence binding. Returns undefined for a
   * `spec-author` role. Refuses a spec directory that is a symlink.
   */
  async applySpecReadOnlyFence(worktreeDir: string, role?: string): Promise<SpecReadOnlyFence | undefined> {
    if (isSpecAuthorRole(role) || this.specDirs.length === 0) return undefined;
    const root = path.resolve(worktreeDir);
    const readOnlyPaths: string[] = [];
    const identities: SpecReadOnlyFence['identities'] = [];
    for (const dir of this.specDirs) {
      const specDir = path.join(root, ...dir.split('/'));
      if (!isPathInside(root, specDir)) throw new Error(`spec directory '${dir}' escapes worktree '${root}'`);
      const existing = await fs.lstat(specDir).catch(() => undefined);
      if (existing?.isSymbolicLink()) throw new Error(`refusing to fence '${specDir}': spec directory is a symlink`);
      if (existing && !existing.isDirectory()) throw new Error(`refusing to fence '${specDir}': spec path is not a directory`);
      if (!existing) await fs.mkdir(specDir, { recursive: true });
      await setTreeWritable(specDir, false);
      const stat = await fs.stat(specDir);
      readOnlyPaths.push(specDir);
      identities.push({ path: specDir, dev: stat.dev, ino: stat.ino });
    }
    const real = await Promise.all(readOnlyPaths.map((dir) => fs.realpath(dir).catch(() => dir)));
    const all = [...new Set([...readOnlyPaths, ...real])];
    const q = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return {
      role,
      readOnlyPaths,
      bwrapArgs: all.flatMap((dir) => ['--ro-bind', dir, dir]),
      seatbeltRules: all.map((dir) => `(deny file-write* (subpath ${q(dir)}))`),
      requiredIsolation: 'os',
      identities,
    };
  }

  /**
   * Checks that a fence still holds: each spec directory exists, is the same
   * directory (not replaced or symlinked) and nothing in it is writable.
   * Returns human-readable violations; empty when intact.
   */
  async verifySpecReadOnlyFence(fence: SpecReadOnlyFence): Promise<string[]> {
    const violations: string[] = [];
    for (const identity of fence.identities) {
      const stat = await fs.lstat(identity.path).catch(() => undefined);
      if (!stat) { violations.push(`${identity.path}: spec directory is missing`); continue; }
      if (stat.isSymbolicLink()) { violations.push(`${identity.path}: spec directory was replaced by a symlink`); continue; }
      if (stat.dev !== identity.dev || stat.ino !== identity.ino) violations.push(`${identity.path}: spec directory was replaced`);
      for (const entry of await listTree(identity.path)) {
        if (!entry.stat.isSymbolicLink() && (entry.stat.mode & 0o222) !== 0) violations.push(`${entry.path}: write permission restored`);
      }
    }
    return violations;
  }

  /** Restores owner write permission on fenced spec directories so the worktree can be removed. */
  async releaseSpecReadOnlyFence(worktreeDir: string): Promise<void> {
    for (const dir of this.specDirs) {
      const specDir = path.join(path.resolve(worktreeDir), ...dir.split('/'));
      const stat = await fs.lstat(specDir).catch(() => undefined);
      if (stat?.isDirectory()) await setTreeWritable(specDir, true).catch(() => undefined);
    }
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
    options: CreateWorktreeOptions = {},
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
      ? (await execFileAsync('git', [...GIT_NO_HOOKS, 'rev-parse', 'HEAD^{commit}'], { cwd: projectRoot })).stdout.trim()
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
      const specFence = await this.applySpecReadOnlyFence(worktreeDir, options.role);
      return {
        jobId,
        taskId,
        worktreeDir,
        branch,
        baseBranch,
        isGit: false,
        createdAt: new Date(),
        role: options.role,
        specFence,
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
    const specFence = await this.applySpecReadOnlyFence(worktreeDir, options.role);

    return {
      jobId,
      taskId,
      worktreeDir,
      branch,
      baseBranch,
      baseSha,
      isGit: true,
      createdAt: new Date(),
      role: options.role,
      specFence,
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
    await this.releaseSpecReadOnlyFence(info.worktreeDir);
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
    await this.releaseSpecReadOnlyFence(resolved);
    try {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore
    }
  }
}

type TreeEntry = { path: string; stat: import('node:fs').Stats };

/** Lists `dir` and everything under it without following symlinks. */
async function listTree(dir: string): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  const walk = async (current: string): Promise<void> => {
    const stat = await fs.lstat(current);
    out.push({ path: current, stat });
    if (!stat.isDirectory()) return;
    for (const name of await fs.readdir(current)) await walk(path.join(current, name));
  };
  await walk(dir);
  return out;
}

/**
 * `chmod -R a-w` (or `u+w` when restoring) without following symlinks, which
 * could otherwise point the chmod at files outside the worktree.
 */
async function setTreeWritable(dir: string, writable: boolean): Promise<void> {
  if (writable) {
    // Parents first, so their children become reachable for writing.
    for (const entry of await listTree(dir)) {
      if (!entry.stat.isSymbolicLink()) await fs.chmod(entry.path, (entry.stat.mode | 0o200) & 0o7777);
    }
    return;
  }
  // Children first; a read-only directory is still traversable.
  for (const entry of (await listTree(dir)).reverse()) {
    if (!entry.stat.isSymbolicLink()) await fs.chmod(entry.path, entry.stat.mode & ~0o222 & 0o7777);
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
