import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { MemoryStore, JsonFileStore } from '@wazir/shared';
import {
  MANUAL_APPROVAL_PROMPT,
  SelfImprovementSupervisor,
  computeCandidateRevisionHash,
  ensureAuthorizedCandidateBranch,
  executeVerifiedCandidateCommit,
  formatCompletionSummaryReport,
  generateCompletionSummary,
  handleManualCommitApproval,
  reconcileCandidateAfterRestart,
  resolveEffectiveCommitPolicy,
  revalidateGitCheckpoint,
  runGitPreflight,
  scanCandidateForSecrets,
  type DurableCandidateRecord,
  type GitBaselineRecord,
} from '../src/index.js';

describe('Mandatory Git Synchronization, Verification, and Commit Authorization Policy', () => {
  let tmpRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-git-policy-'));
    repoDir = path.join(tmpRoot, 'repo');
    await fs.mkdir(repoDir, { recursive: true });

    execFileSync('git', ['init'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@wazir.local'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Wazir Test'], { cwd: repoDir });

    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('performs Git preflight and discovers repository root, branch, HEAD, dirty files, worktrees, and remotes', async () => {
    // Modify tracked file, stage a file, and add untracked file
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'src', 'staged.ts'), 'export const staged = true;\n', 'utf8');
    execFileSync('git', ['add', 'src/staged.ts'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, 'untracked.txt'), 'user note\n', 'utf8');

    const report = await runGitPreflight(repoDir, { fetchRemote: false });
    expect(report.ok).toBe(true);
    expect(await fs.realpath(report.repositoryRoot)).toBe(await fs.realpath(repoDir));
    expect(report.detachedHead).toBe(false);
    expect(report.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(report.isDirty).toBe(true);
    expect(report.modifiedFiles).toContain('src/app.ts');
    expect(report.stagedFiles).toContain('src/staged.ts');
    expect(report.untrackedFiles).toContain('untracked.txt');
    expect(report.hasConflicts).toBe(false);
    expect(report.worktrees.length).toBeGreaterThanOrEqual(1);
  });

  it('distinguishes REMOTE_UNAVAILABLE from local Git errors and applies offlinePolicy', async () => {
    execFileSync('git', ['remote', 'add', 'origin', 'file:///nonexistent/wazir/remote.git'], { cwd: repoDir });

    const allowedOffline = await runGitPreflight(repoDir, {
      fetchRemote: true,
      fetchTimeoutMs: 3_000,
      offlinePolicy: 'allow',
    });
    expect(allowedOffline.remoteSyncStatus).toBe('REMOTE_UNAVAILABLE');
    expect(allowedOffline.remoteTrackingState).toBe('REMOTE_UNAVAILABLE');
    expect(allowedOffline.ok).toBe(true);

    const blockedOffline = await runGitPreflight(repoDir, {
      fetchRemote: true,
      fetchTimeoutMs: 3_000,
      offlinePolicy: 'block',
    });
    expect(blockedOffline.remoteSyncStatus).toBe('REMOTE_UNAVAILABLE');
    expect(blockedOffline.ok).toBe(false);
    expect(blockedOffline.blockedReason).toContain('REMOTE_UNAVAILABLE');
  });

  it('detects unresolved merge conflicts and blocks with BLOCKED_GIT_CONFLICT', async () => {
    const baseBranch = execFileSync('git', ['branch', '--show-current'], { cwd: repoDir }).toString().trim();
    execFileSync('git', ['checkout', '-b', 'conflict-branch'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const value = "branch-a";\n', 'utf8');
    execFileSync('git', ['commit', '-am', 'Branch A change'], { cwd: repoDir });

    execFileSync('git', ['checkout', baseBranch], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const value = "branch-b";\n', 'utf8');
    execFileSync('git', ['commit', '-am', 'Branch B change'], { cwd: repoDir });

    try {
      execFileSync('git', ['merge', 'conflict-branch'], { cwd: repoDir });
    } catch {
      // expected merge conflict
    }

    const report = await runGitPreflight(repoDir, { fetchRemote: false });
    expect(report.hasConflicts).toBe(true);
    expect(report.unmergedFiles).toContain('src/app.ts');
    expect(report.ok).toBe(false);
    expect(report.blockedReason).toContain('BLOCKED_GIT_CONFLICT');
  });

  it('detects baseline SHA changes, remote advancement, and concurrent agent changes at Git checkpoints', async () => {
    const remoteBare = path.join(tmpRoot, 'remote.git');
    execFileSync('git', ['init', '--bare', remoteBare]);
    execFileSync('git', ['remote', 'add', 'origin', remoteBare], { cwd: repoDir });
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repoDir }).toString().trim();
    execFileSync('git', ['push', '-u', 'origin', branch], { cwd: repoDir });

    const initialPreflight = await runGitPreflight(repoDir, { fetchRemote: true });
    const baseline: GitBaselineRecord = {
      attemptId: 'att-1',
      repositoryRoot: repoDir,
      worktreePath: repoDir,
      branch: initialPreflight.currentBranch,
      baselineSha: initialPreflight.headSha,
      upstreamBranch: initialPreflight.upstreamBranch,
      upstreamSha: initialPreflight.upstreamSha,
      recordedAt: new Date().toISOString(),
      authorizedFiles: ['src/app.ts'],
    };

    // 1. Another agent modifies an unauthorized file in the worktree
    await fs.writeFile(path.join(repoDir, 'src', 'other-agent.ts'), 'export const other = 1;\n', 'utf8');
    const concurrentCheck = await revalidateGitCheckpoint(baseline, 'AFTER_AGENT_MODIFICATION', {
      allowAuthorizedFileMutations: false,
    });
    expect(concurrentCheck.ok).toBe(false);
    expect(concurrentCheck.conflictingFiles).toContain('src/other-agent.ts');
    expect(concurrentCheck.blockedStatus).toBe('BLOCKED_GIT_CONFLICT');
    await fs.unlink(path.join(repoDir, 'src', 'other-agent.ts'));

    // 2. Remote branch advances during execution
    const cloneDir = path.join(tmpRoot, 'collaborator');
    execFileSync('git', ['clone', remoteBare, cloneDir]);
    execFileSync('git', ['config', 'user.email', 'collab@wazir.local'], { cwd: cloneDir });
    execFileSync('git', ['config', 'user.name', 'Collaborator'], { cwd: cloneDir });
    await fs.writeFile(path.join(cloneDir, 'README.md'), '# Remote update\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: cloneDir });
    execFileSync('git', ['commit', '-m', 'Remote advance'], { cwd: cloneDir });
    execFileSync('git', ['push', 'origin', branch], { cwd: cloneDir });

    const remoteCheck = await revalidateGitCheckpoint(baseline, 'BEFORE_FINAL_VERIFICATION', {
      fetchRemote: true,
    });
    expect(remoteCheck.remoteAdvanced).toBe(true);
    expect(remoteCheck.requiresReverification).toBe(true);

    // 3. Baseline HEAD SHA changes unexpectedly
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const value = 99;\n', 'utf8');
    execFileSync('git', ['commit', '-am', 'Unexpected local commit'], { cwd: repoDir });
    const headCheck = await revalidateGitCheckpoint(baseline, 'BEFORE_STAGING_AND_COMMIT');
    expect(headCheck.ok).toBe(false);
    expect(headCheck.headChanged).toBe(true);
    expect(headCheck.blockedStatus).toBe('BLOCKED_STALE_BASELINE');
  });

  it('enforces commit authorization rules, separated permissions, task-scope isolation, and expiration fallback', () => {
    const now = Date.parse('2026-10-16T22:00:00Z');

    // Default is MANUAL_COMMIT
    const def = resolveEffectiveCommitPolicy(undefined, { repositoryRoot: repoDir, now });
    expect(def.mode).toBe('MANUAL_COMMIT');
    expect(def.permissions).toEqual({
      codeExecutionAuthorized: true,
      commitMode: 'MANUAL_COMMIT',
      commitAuthorized: false,
      pushAuthorized: false,
      mergeAuthorized: false,
      deploymentAuthorized: false,
    });

    // Untrusted sources cannot enable AUTO_COMMIT
    for (const untrustedSource of [
      'previous_commit',
      'git_credentials',
      'git_remote',
      'agent_instruction',
      'readme',
      'source_comment',
      'untrusted_tool_output',
      'other_task',
    ] as const) {
      const resolved = resolveEffectiveCommitPolicy(
        {
          mode: 'AUTO_COMMIT',
          source: untrustedSource,
          authorizingIdentity: 'agent',
          scope: 'task',
          scopeTargetId: 'task-1',
          repositoryRoot: repoDir,
        },
        { repositoryRoot: repoDir, taskId: 'task-1', now },
      );
      expect(resolved.mode).toBe('MANUAL_COMMIT');
      expect(resolved.downgradedReason).toContain('Untrusted or implicit commit authorization source');
    }

    // Grant for a different task must not be reused
    const wrongTask = resolveEffectiveCommitPolicy(
      {
        mode: 'AUTO_COMMIT',
        source: 'user_explicit',
        authorizingIdentity: 'wael',
        scope: 'task',
        scopeTargetId: 'task-alpha',
        repositoryRoot: repoDir,
      },
      { repositoryRoot: repoDir, taskId: 'task-beta', now },
    );
    expect(wrongTask.mode).toBe('MANUAL_COMMIT');
    expect(wrongTask.downgradedReason).toContain("does not apply to current task 'task-beta'");

    // Expired authorization returns to MANUAL_COMMIT
    const expired = resolveEffectiveCommitPolicy(
      {
        mode: 'AUTO_COMMIT',
        source: 'user_explicit',
        authorizingIdentity: 'wael',
        scope: 'task',
        scopeTargetId: 'task-1',
        expiresAt: '2026-10-16T21:59:00Z',
        repositoryRoot: repoDir,
      },
      { repositoryRoot: repoDir, taskId: 'task-1', now },
    );
    expect(expired.mode).toBe('MANUAL_COMMIT');
    expect(expired.downgradedReason).toBe('COMMIT_AUTHORIZATION_EXPIRED');

    // Valid explicit AUTO_COMMIT is honored and never implies push, merge, or deploy
    const validAuto = resolveEffectiveCommitPolicy(
      {
        mode: 'AUTO_COMMIT',
        source: 'user_explicit',
        authorizingIdentity: 'wael',
        scope: 'task',
        scopeTargetId: 'task-1',
        expiresAt: '2026-10-16T23:00:00Z',
        repositoryRoot: repoDir,
      },
      { repositoryRoot: repoDir, taskId: 'task-1', now },
    );
    expect(validAuto.mode).toBe('AUTO_COMMIT');
    expect(validAuto.permissions.commitAuthorized).toBe(true);
    expect(validAuto.permissions.pushAuthorized).toBe(false);
    expect(validAuto.permissions.mergeAuthorized).toBe(false);
    expect(validAuto.permissions.deploymentAuthorized).toBe(false);

    // NO_COMMIT mode
    const noCommit = resolveEffectiveCommitPolicy(
      {
        mode: 'NO_COMMIT',
        source: 'user_explicit',
        authorizingIdentity: 'wael',
        scope: 'task',
        repositoryRoot: repoDir,
      },
      { repositoryRoot: repoDir, now },
    );
    expect(noCommit.mode).toBe('NO_COMMIT');
    expect(noCommit.permissions.commitAuthorized).toBe(false);
  });

  it('creates an authorized candidate branch when repository is in detached HEAD state', async () => {
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();
    execFileSync('git', ['checkout', '--detach', headSha], { cwd: repoDir });

    const preflight = await runGitPreflight(repoDir, { fetchRemote: false });
    expect(preflight.detachedHead).toBe(true);

    const ensured = await ensureAuthorizedCandidateBranch(repoDir, 'candidate-detached-1');
    expect(ensured.createdFromDetachedHead).toBe(true);
    expect(ensured.branch).toBe('wazir/candidate-detached-1');

    const afterBranch = execFileSync('git', ['branch', '--show-current'], { cwd: repoDir }).toString().trim();
    expect(afterBranch).toBe('wazir/candidate-detached-1');
  });

  it('executes manual approval workflow (COMMIT, REVISE, KEEP_UNCOMMITTED, DISCARD confirmation, CANCEL), binds approval to revision, and rejects stale verification', async () => {
    const storePath = path.join(tmpRoot, 'state.json');
    const store = new JsonFileStore(storePath);
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repoDir }).toString().trim();

    // Modify intended file
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const value = 42;\n', 'utf8');
    const revHash = await computeCandidateRevisionHash(repoDir, ['src/app.ts']);

    const baseline: GitBaselineRecord = {
      attemptId: 'cand-manual-1',
      repositoryRoot: repoDir,
      worktreePath: repoDir,
      branch,
      baselineSha: baseSha,
      recordedAt: new Date().toISOString(),
      authorizedFiles: ['src/app.ts'],
    };
    const auth = resolveEffectiveCommitPolicy(undefined, { repositoryRoot: repoDir, attemptId: 'cand-manual-1' });
    const summary = generateCompletionSummary({
      attemptId: 'cand-manual-1',
      originalGoal: 'Update value to 42',
      problemsIdentified: ['value was 1'],
      changesImplemented: ['Updated src/app.ts value to 42'],
      filesModified: ['src/app.ts'],
      testsExecuted: [{ command: 'npm test', exitCode: 0, durationMs: 12 }],
      verifiedRevisionHash: revHash,
      baseline,
      candidateRevisionHash: revHash,
      worktreeStatus: 'READY',
      remoteSyncStatus: 'NO_REMOTE',
      commitAuthorization: auth,
    });

    const formatted = formatCompletionSummaryReport(summary);
    expect(formatted).toContain('### Summary');
    expect(formatted).toContain('### Verification');
    expect(formatted).toContain('### Git status');
    expect(formatted).toContain('### Commit decision');
    expect(formatted).toContain(MANUAL_APPROVAL_PROMPT);

    const record: DurableCandidateRecord = {
      attemptId: 'cand-manual-1',
      state: 'AWAITING_COMMIT_APPROVAL',
      baseline,
      candidateRevisionHash: revHash,
      verifiedRevisionHash: revHash,
      intendedFiles: ['src/app.ts'],
      commitMessage: 'fix(app): update value to 42',
      commitAuthorization: auth,
      completionSummary: summary,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.put('supervisor/git-candidates/cand-manual-1', record);

    // 1. DISCARD without confirmation must be refused
    const discardDenied = await handleManualCommitApproval({
      attemptId: 'cand-manual-1',
      action: 'DISCARD',
      store,
      confirmDiscard: false,
    });
    expect(discardDenied.ok).toBe(false);
    expect(discardDenied.reason).toContain('DISCARD_CONFIRMATION_REQUIRED');

    // 2. REVISE transitions back to IMPLEMENTING
    const revised = await handleManualCommitApproval({
      attemptId: 'cand-manual-1',
      action: 'REVISE',
      store,
    });
    expect(revised.ok).toBe(true);
    expect(revised.state).toBe('IMPLEMENTING');

    // Restore to AWAITING_COMMIT_APPROVAL
    record.state = 'AWAITING_COMMIT_APPROVAL';
    await store.put('supervisor/git-candidates/cand-manual-1', record);

    // 3. KEEP_UNCOMMITTED preserves worktree without committing
    const kept = await handleManualCommitApproval({
      attemptId: 'cand-manual-1',
      action: 'KEEP_UNCOMMITTED',
      store,
    });
    expect(kept.ok).toBe(true);
    expect(kept.state).toBe('KEPT_UNCOMMITTED');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim()).toBe(baseSha);

    // Restore to AWAITING_COMMIT_APPROVAL
    record.state = 'AWAITING_COMMIT_APPROVAL';
    await store.put('supervisor/git-candidates/cand-manual-1', record);

    // 4. User changes file after review -> invalidates approval and verification
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const value = 999; // post-review edit\n', 'utf8');
    const staleCommit = await handleManualCommitApproval({
      attemptId: 'cand-manual-1',
      action: 'COMMIT',
      store,
      approvedRevisionHash: revHash,
    });
    expect(staleCommit.ok).toBe(false);
    expect(staleCommit.state).toBe('BLOCKED_STALE_VERIFICATION');
    expect(staleCommit.reason).toContain('STALE_VERIFICATION');

    // Restore verified content and AWAITING_COMMIT_APPROVAL
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const value = 42;\n', 'utf8');
    record.state = 'AWAITING_COMMIT_APPROVAL';
    await store.put('supervisor/git-candidates/cand-manual-1', record);

    // 5. Approved COMMIT with matching revision hash commits cleanly
    const committed = await handleManualCommitApproval({
      attemptId: 'cand-manual-1',
      action: 'COMMIT',
      store,
      approvedRevisionHash: revHash,
    });
    expect(committed.ok).toBe(true);
    expect(committed.state).toBe('COMMITTED');
    expect(committed.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(committed.commitSha).not.toBe(baseSha);
  });

  it('prevents staging unrelated files staged by another agent, blocks secrets, and respects Git hooks', async () => {
    const store = new MemoryStore();
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repoDir }).toString().trim();

    // 1. Secret detection blocks commit
    await fs.writeFile(
      path.join(repoDir, 'src', 'app.ts'),
      'export const apiKey = "sk-liveSecretKey1234567890abcdef";\n',
      'utf8',
    );
    const secretScan = await scanCandidateForSecrets(repoDir, ['src/app.ts']);
    expect(secretScan.clean).toBe(false);
    expect(secretScan.findings[0]?.reason).toContain('OpenAI/API Secret Key');

    // Restore clean change
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const value = 7;\n', 'utf8');
    const revHash = await computeCandidateRevisionHash(repoDir, ['src/app.ts']);

    const baseline: GitBaselineRecord = {
      attemptId: 'cand-hook-1',
      repositoryRoot: repoDir,
      worktreePath: repoDir,
      branch,
      baselineSha: baseSha,
      recordedAt: new Date().toISOString(),
      authorizedFiles: ['src/app.ts'],
    };
    const auth = resolveEffectiveCommitPolicy(
      {
        mode: 'AUTO_COMMIT',
        source: 'user_explicit',
        authorizingIdentity: 'wael',
        scope: 'task',
        scopeTargetId: 'cand-hook-1',
        repositoryRoot: repoDir,
      },
      { repositoryRoot: repoDir, taskId: 'cand-hook-1' },
    );
    const summary = generateCompletionSummary({
      attemptId: 'cand-hook-1',
      originalGoal: 'Update value to 7',
      problemsIdentified: ['value was 1'],
      changesImplemented: ['Set value = 7'],
      filesModified: ['src/app.ts'],
      testsExecuted: [{ command: 'npm test', exitCode: 0, durationMs: 10 }],
      verifiedRevisionHash: revHash,
      baseline,
      candidateRevisionHash: revHash,
      worktreeStatus: 'READY',
      remoteSyncStatus: 'NO_REMOTE',
      commitAuthorization: auth,
    });

    const makeRecord = (): DurableCandidateRecord => ({
      attemptId: 'cand-hook-1',
      state: 'AWAITING_COMMIT_APPROVAL',
      baseline,
      candidateRevisionHash: revHash,
      verifiedRevisionHash: revHash,
      intendedFiles: ['src/app.ts'],
      commitMessage: 'fix(app): set value to 7',
      commitAuthorization: auth,
      completionSummary: summary,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 2. Another agent stages an unrelated file -> commit must block and not include it
    await fs.writeFile(path.join(repoDir, 'src', 'unrelated.ts'), 'export const rogue = true;\n', 'utf8');
    execFileSync('git', ['add', 'src/unrelated.ts'], { cwd: repoDir });

    const stagedConflictRes = await executeVerifiedCandidateCommit({
      record: makeRecord(),
      store,
    });
    expect(stagedConflictRes.committed).toBe(false);
    expect(stagedConflictRes.state).toBe('BLOCKED_GIT_CONFLICT');
    expect(stagedConflictRes.reason).toContain('src/unrelated.ts');

    // Clean up unrelated file
    execFileSync('git', ['reset', 'src/unrelated.ts'], { cwd: repoDir });
    await fs.unlink(path.join(repoDir, 'src', 'unrelated.ts'));

    // 3. Install a failing pre-commit hook -> hooks must remain enabled and block commit
    const hooksDir = path.join(repoDir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const preCommitPath = path.join(hooksDir, 'pre-commit');
    await fs.writeFile(preCommitPath, '#!/bin/sh\necho "PRE_COMMIT_HOOK_BLOCKED" >&2\nexit 1\n', {
      mode: 0o755,
    });

    const hookFailRes = await executeVerifiedCandidateCommit({
      record: makeRecord(),
      store,
    });
    expect(hookFailRes.committed).toBe(false);
    expect(hookFailRes.state).toBe('COMMIT_FAILED');
    expect(hookFailRes.reason).toContain('PRE_COMMIT_HOOK_BLOCKED');
    // Changes must be retained in the worktree
    expect(await fs.readFile(path.join(repoDir, 'src', 'app.ts'), 'utf8')).toBe('export const value = 7;\n');

    // Remove failing pre-commit hook -> commit succeeds
    await fs.unlink(preCommitPath);
    const hookPassRes = await executeVerifiedCandidateCommit({
      record: makeRecord(),
      store,
    });
    expect(hookPassRes.committed).toBe(true);
    expect(hookPassRes.state).toBe('COMMITTED');
    expect(hookPassRes.filesCommitted).toEqual(['src/app.ts']);
  });

  it('reconciles interrupted COMMITTING candidate and preserves pending approvals across supervisor restart', async () => {
    const store = new MemoryStore();
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repoDir }).toString().trim();

    // Simulate a commit that succeeded on disk right before the process crashed while state was COMMITTING
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const value = 100;\n', 'utf8');
    const revHash = await computeCandidateRevisionHash(repoDir, ['src/app.ts']);
    execFileSync('git', ['add', 'src/app.ts'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'fix(app): crash recovery commit'], { cwd: repoDir });
    const actualCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();

    const baseline: GitBaselineRecord = {
      attemptId: 'cand-crash-1',
      repositoryRoot: repoDir,
      worktreePath: repoDir,
      branch,
      baselineSha: baseSha,
      recordedAt: new Date().toISOString(),
      authorizedFiles: ['src/app.ts'],
    };
    const auth = resolveEffectiveCommitPolicy(undefined, { repositoryRoot: repoDir });
    const summary = generateCompletionSummary({
      attemptId: 'cand-crash-1',
      originalGoal: 'Crash recovery test',
      problemsIdentified: [],
      changesImplemented: ['Updated app.ts'],
      filesModified: ['src/app.ts'],
      testsExecuted: [{ command: 'npm test', exitCode: 0, durationMs: 5 }],
      verifiedRevisionHash: revHash,
      baseline,
      candidateRevisionHash: revHash,
      worktreeStatus: 'COMMITTING',
      remoteSyncStatus: 'NO_REMOTE',
      commitAuthorization: auth,
    });

    await store.put('supervisor/git-candidates/cand-crash-1', {
      attemptId: 'cand-crash-1',
      state: 'COMMITTING',
      baseline,
      candidateRevisionHash: revHash,
      verifiedRevisionHash: revHash,
      intendedFiles: ['src/app.ts'],
      commitMessage: 'fix(app): crash recovery commit',
      commitAuthorization: auth,
      completionSummary: summary,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies DurableCandidateRecord);

    const reconciled = await reconcileCandidateAfterRestart(
      (await store.get<DurableCandidateRecord>('supervisor/git-candidates/cand-crash-1'))!,
      store,
    );
    expect(reconciled.state).toBe('COMMITTED');
    expect(reconciled.commitSha).toBe(actualCommitSha);

    // Also test a second candidate in AWAITING_COMMIT_APPROVAL surviving SelfImprovementSupervisor.initialize()
    const currentHash = await computeCandidateRevisionHash(repoDir, ['src/app.ts']);
    await store.put('supervisor/git-candidates/cand-pending-2', {
      attemptId: 'cand-pending-2',
      state: 'AWAITING_COMMIT_APPROVAL',
      baseline: { ...baseline, attemptId: 'cand-pending-2', baselineSha: actualCommitSha },
      candidateRevisionHash: currentHash,
      verifiedRevisionHash: currentHash,
      intendedFiles: ['src/app.ts'],
      commitMessage: 'fix(app): pending approval',
      commitAuthorization: auth,
      completionSummary: summary,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies DurableCandidateRecord);

    const supervisor = new SelfImprovementSupervisor({
      store,
      busy: async () => false,
      observe: async () => [],
    });
    const initSnap = await supervisor.initialize(['harden']);
    expect(initSnap.phase).toBe('AWAITING_COMMIT_APPROVAL');
    expect(initSnap.pendingApprovalIds).toContain('cand-pending-2');
  });
});
