import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { WorktreeManager } from '../src/index.js';

const execFileAsync = promisify(execFile);

describe('WorktreeManager — git worktree isolation per agent', () => {
  let tmpRepo: string;

  afterEach(async () => {
    if (tmpRepo) {
      await fs.rm(tmpRepo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function initGitRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-wt-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Wazir Test'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@wazir.ai'], { cwd: dir });

    // Initial commit
    await fs.writeFile(path.join(dir, 'README.md'), '# Initial Repository\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: dir });
    return dir;
  }

  it('creates isolated worktrees with independent branches for concurrent agents', async () => {
    tmpRepo = await initGitRepo();
    const manager = new WorktreeManager();

    // Create worktrees for two concurrent agents
    const wt1 = await manager.createWorktree(tmpRepo, 'job-abc', 'task-1');
    const wt2 = await manager.createWorktree(tmpRepo, 'job-abc', 'task-2');

    expect(wt1.isGit).toBe(true);
    expect(wt2.isGit).toBe(true);
    expect(wt1.branch).toBe('wazir/job-abc/task-1');
    expect(wt2.branch).toBe('wazir/job-abc/task-2');
    expect(wt1.worktreeDir).not.toBe(wt2.worktreeDir);

    // Agent 1 writes a file
    await fs.writeFile(path.join(wt1.worktreeDir, 'agent1.txt'), 'hello from agent 1\n');
    const commit1 = await manager.commitWorktree(wt1, 'Agent 1 work');
    expect(commit1.committed).toBe(true);
    expect(commit1.files).toContain('agent1.txt');

    // Agent 2 writes a different file
    await fs.writeFile(path.join(wt2.worktreeDir, 'agent2.txt'), 'hello from agent 2\n');
    const commit2 = await manager.commitWorktree(wt2, 'Agent 2 work');
    expect(commit2.committed).toBe(true);
    expect(commit2.files).toContain('agent2.txt');

    // Prove isolation: agent 1's worktree does NOT contain agent 2's file
    await expect(fs.access(path.join(wt1.worktreeDir, 'agent2.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(wt2.worktreeDir, 'agent1.txt'))).rejects.toThrow();

    // Test diff
    const diff1 = await manager.diffWorktree(wt1);
    expect(diff1).toContain('hello from agent 1');

    // Merge both cleanly into main
    const merge1 = await manager.mergeBranch(tmpRepo, wt1.branch, 'main');
    expect(merge1.success).toBe(true);

    const merge2 = await manager.mergeBranch(tmpRepo, wt2.branch, 'main');
    expect(merge2.success).toBe(true);

    // Verify main now has both files
    const mainAgent1 = await fs.readFile(path.join(tmpRepo, 'agent1.txt'), 'utf8');
    const mainAgent2 = await fs.readFile(path.join(tmpRepo, 'agent2.txt'), 'utf8');
    expect(mainAgent1).toBe('hello from agent 1\n');
    expect(mainAgent2).toBe('hello from agent 2\n');

    // Clean up worktrees
    await manager.removeWorktree(wt1);
    await manager.removeWorktree(wt2);

    await expect(fs.access(wt1.worktreeDir)).rejects.toThrow();
    await expect(fs.access(wt2.worktreeDir)).rejects.toThrow();
  });

  it('detects merge conflicts safely without corrupting the working tree', async () => {
    tmpRepo = await initGitRepo();
    const manager = new WorktreeManager();

    const wt1 = await manager.createWorktree(tmpRepo, 'job-conf', 'task-1');
    const wt2 = await manager.createWorktree(tmpRepo, 'job-conf', 'task-2');

    // Both modify README.md in conflicting ways
    await fs.writeFile(path.join(wt1.worktreeDir, 'README.md'), '# Version from Agent 1\n');
    await manager.commitWorktree(wt1, 'Agent 1 change');

    await fs.writeFile(path.join(wt2.worktreeDir, 'README.md'), '# Version from Agent 2\n');
    await manager.commitWorktree(wt2, 'Agent 2 change');

    // Merge wt1 first
    const m1 = await manager.mergeBranch(tmpRepo, wt1.branch, 'main');
    expect(m1.success).toBe(true);

    // Merge wt2 second -> should detect conflict, abort merge, and report conflict
    const m2 = await manager.mergeBranch(tmpRepo, wt2.branch, 'main');
    expect(m2.success).toBe(false);
    expect(m2.conflicts).toBeDefined();

    // Verify repo is clean (merge was safely aborted)
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: tmpRepo });
    expect(status.trim()).toBe('');

    await manager.removeWorktree(wt1);
    await manager.removeWorktree(wt2);
  });
});
