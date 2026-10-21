import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { captureHeadFingerprint, describeUnexpectedHeadDrift } from '../src/index.js';

const execFileAsync = promisify(execFile);

describe('repo integrity guard — detects unexpected HEAD movement on the checked-out branch', () => {
  let tmpRepo: string;

  afterEach(async () => {
    if (tmpRepo) await fs.rm(tmpRepo, { recursive: true, force: true }).catch(() => undefined);
  });

  async function initGitRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-repo-guard-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Wazir Test'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@wazir.ai'], { cwd: dir });
    await fs.writeFile(path.join(dir, 'README.md'), '# Initial Repository\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: dir });
    return dir;
  }

  it('reports no drift when nothing happens', async () => {
    tmpRepo = await initGitRepo();
    const before = await captureHeadFingerprint(tmpRepo);
    expect(before?.branch).toBe('main');
    expect(await describeUnexpectedHeadDrift(tmpRepo, before)).toBeUndefined();
  });

  it('reports no drift for ordinary uncommitted working-tree changes', async () => {
    tmpRepo = await initGitRepo();
    const before = await captureHeadFingerprint(tmpRepo);
    await fs.writeFile(path.join(tmpRepo, 'README.md'), '# Edited\n');
    expect(await describeUnexpectedHeadDrift(tmpRepo, before)).toBeUndefined();
  });

  it('reports drift when the checked-out branch gains a new commit', async () => {
    tmpRepo = await initGitRepo();
    const before = await captureHeadFingerprint(tmpRepo);
    await fs.writeFile(path.join(tmpRepo, 'other.txt'), 'surprise\n');
    await execFileAsync('git', ['add', 'other.txt'], { cwd: tmpRepo });
    await execFileAsync('git', ['commit', '-m', 'unexpected commit'], { cwd: tmpRepo });
    const drift = await describeUnexpectedHeadDrift(tmpRepo, before);
    expect(drift).toBeDefined();
    expect(drift).toContain('main');
    expect(drift).toContain(before!.sha);
  });

  it('reports drift for a merge, exactly the real-world case this guards against', async () => {
    tmpRepo = await initGitRepo();
    await execFileAsync('git', ['checkout', '-b', 'side'], { cwd: tmpRepo });
    await fs.writeFile(path.join(tmpRepo, 'feature.txt'), 'feature\n');
    await execFileAsync('git', ['add', 'feature.txt'], { cwd: tmpRepo });
    await execFileAsync('git', ['commit', '-m', 'feature work'], { cwd: tmpRepo });
    await execFileAsync('git', ['checkout', 'main'], { cwd: tmpRepo });

    const before = await captureHeadFingerprint(tmpRepo);
    await execFileAsync('git', ['merge', '--no-ff', '--no-edit', 'side'], { cwd: tmpRepo });
    const drift = await describeUnexpectedHeadDrift(tmpRepo, before);
    expect(drift).toBeDefined();
  });

  it('does not flag a deliberate branch switch as drift', async () => {
    tmpRepo = await initGitRepo();
    await execFileAsync('git', ['checkout', '-b', 'other-branch'], { cwd: tmpRepo });
    const before = await captureHeadFingerprint(tmpRepo);
    await execFileAsync('git', ['checkout', 'main'], { cwd: tmpRepo });
    expect(await describeUnexpectedHeadDrift(tmpRepo, before)).toBeUndefined();
  });

  it('is a no-op for a non-git directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-not-a-repo-'));
    try {
      expect(await captureHeadFingerprint(dir)).toBeUndefined();
      expect(await describeUnexpectedHeadDrift(dir, { branch: 'main', sha: 'deadbeef' })).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
