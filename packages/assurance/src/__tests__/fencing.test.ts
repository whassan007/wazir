import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { vi, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as coreServices from '../../../core/src/services/policyEngine.js';
import {
  PolicyEngine,
  SPEC_APPROVAL_FENCE_RULE,
  SPEC_AUTHOR_ROLE,
  SPEC_WRITE_FENCE_BLOCKER,
  SPEC_WRITE_FENCE_RULE,
  isSpecAuthorRole,
  isSpecPath,
  isSpecRelativePath,
  parseSpecManifestStatus,
  specFenceTouchedPaths,
  specWriteFenceBlocker,
} from '../../../core/src/services/policyEngine.js';

vi.mock('@wazir/core', () => coreServices);
import { VerifiedIntegrationCoordinator } from '../../../core/src/services/verifiedIntegrationCoordinator.js';
import { WorktreeManager } from '../../../core/src/services/worktreeManager.js';
import {
  createPolicyEngine as createFacadeEngine,
  evaluateSpecFence as facadeEvaluateSpecFence,
  isSpecAuthorRole as facadeIsSpecAuthorRole,
  registerSpecFence as facadeRegisterSpecFence,
  specWriteFenceBlocker as facadeSpecWriteFenceBlocker,
} from '../../../policies/src/index.js';
import {
  checkSpecMerge,
  createTaskRoleResolver,
  fenceTaskWorkspace,
  verifyTaskWorkspaceFence,
  type TrustedTaskRecord,
} from '../fencing.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
  });
  return stdout.trim();
}

async function initGitRepo(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@wazir.local']);
  await git(dir, ['config', 'user.name', 'Wazir Test']);
  const specDir = path.join(dir, 'specs', 'red_signal');
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    path.join(specDir, 'manifest.yaml'),
    'id: RED_SIGNAL_COMPLIANCE\nversion: "1.0"\nstatus: draft\nguarantee: "never cross on red"\n',
    'utf8',
  );
  await fs.writeFile(path.join(specDir, 'red_signal.als'), 'module red_signal\n', 'utf8');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'planner.ts'), 'export const stop = true;\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'initial commit']);
  return git(dir, ['rev-parse', 'HEAD']);
}

describe('Spec write fencing (FORMAL_ASSURANCE.md §2.2, DESIGN.md §1.5)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-spec-fencing-'));
  });

  afterEach(async () => {
    // Restore permissions in case any test left a read-only spec dir in tmpRoot
    const restore = async (dir: string): Promise<void> => {
      const stat = await fs.lstat(dir).catch(() => undefined);
      if (!stat || stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        await fs.chmod(dir, (stat.mode | 0o700) & 0o7777).catch(() => undefined);
        for (const name of await fs.readdir(dir).catch(() => [])) {
          await restore(path.join(dir, name));
        }
      } else {
        await fs.chmod(dir, (stat.mode | 0o600) & 0o7777).catch(() => undefined);
      }
    };
    await restore(tmpRoot);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  describe('1. Layer A — PolicyEngine classification & path/symlink resolution', () => {
    it('denies write and edit tools targeting specs/red_signal/red_signal.als for implementation, repair, verification, missing, or unknown roles', async () => {
      const tasks: TrustedTaskRecord[] = [
        { id: 'exec-impl', role: 'implementation' },
        { id: 'exec-repair', role: 'repair' },
        { id: 'exec-verify', role: 'verification' },
        { id: 'exec-missing' },
        { id: 'exec-unknown', role: 'rogue-role' },
      ];
      const engine = new PolicyEngine({
        projectRoot: tmpRoot,
        resolveTaskRole: createTaskRoleResolver(tasks),
        // Provide an approver that always says yes to prove spec-write-fence-deny is non-overridable ('deny', never 'ask')
        approveCallback: async () => true,
      });

      for (const executionId of ['exec-impl', 'exec-repair', 'exec-verify', 'exec-missing', 'exec-unknown', 'unregistered-id', undefined]) {
        for (const tool of ['write', 'edit']) {
          const decision = engine.classify({
            tool,
            input: { path: 'specs/red_signal/red_signal.als', content: 'tampered' },
            executionId,
            projectRoot: tmpRoot,
          });
          expect(decision.decision).toBe('deny');
          expect(decision.rule).toBe(SPEC_WRITE_FENCE_RULE);
          expect(decision.reasons.join(' ')).toContain(SPEC_AUTHOR_ROLE);

          const authDecision = await engine.authorize({
            tool,
            input: { path: 'specs/red_signal/red_signal.als', content: 'tampered' },
            executionId,
            projectRoot: tmpRoot,
          });
          expect(authDecision.decision).toBe('deny');
          expect(authDecision.rule).toBe(SPEC_WRITE_FENCE_RULE);
        }
      }
    });

    it('denies writes via relative paths, dot-dot segments, case variations, and symlinks pointing into specs/', async () => {
      const specDir = path.join(tmpRoot, 'specs', 'red_signal');
      await fs.mkdir(specDir, { recursive: true });
      const specFile = path.join(specDir, 'red_signal.als');
      await fs.writeFile(specFile, 'module red_signal\n', 'utf8');

      const srcDir = path.join(tmpRoot, 'src');
      await fs.mkdir(srcDir, { recursive: true });

      // Symlink to the file inside specs/
      const symlinkToFile = path.join(srcDir, 'alias.als');
      await fs.symlink(specFile, symlinkToFile);

      // Symlink to the directory inside specs/
      const symlinkToDir = path.join(srcDir, 'linked_spec_dir');
      await fs.symlink(specDir, symlinkToDir);

      // Dangling symlink pointing to a not-yet-created file inside specs/
      const danglingSymlink = path.join(srcDir, 'dangling_new.als');
      await fs.symlink(path.join(specDir, 'new_spec.als'), danglingSymlink);

      const engine = new PolicyEngine({ projectRoot: tmpRoot });
      engine.registerSpecFence('exec-impl', { role: 'implementation' });

      const sneakyPaths = [
        './specs/red_signal/red_signal.als',
        'src/../specs/red_signal/red_signal.als',
        'SPECS/red_signal/red_signal.als',
        'Specs/red_signal/new_file.dfy',
        path.join(tmpRoot, 'specs', 'red_signal', 'red_signal.als'),
        'src/alias.als',
        'src/linked_spec_dir/red_signal.als',
        'src/linked_spec_dir/brand_new.py',
        'src/dangling_new.als',
      ];

      for (const targetPath of sneakyPaths) {
        expect(isSpecPath(tmpRoot, targetPath)).toBe(true);
        const decision = engine.classify({
          tool: 'edit',
          input: { path: targetPath, content: 'hacked' },
          executionId: 'exec-impl',
          projectRoot: tmpRoot,
        });
        expect(decision.decision, `expected deny for path: ${targetPath}`).toBe('deny');
        expect(decision.rule).toBe(SPEC_WRITE_FENCE_RULE);
      }
    });

    it('denies shell commands, redirections, command substitutions, globs, git writes, and custom tools that touch specs/ for non-spec-author roles, while allowing read-only inspection', () => {
      const engine = new PolicyEngine({ projectRoot: tmpRoot });
      engine.registerSpecFence('exec-repair', { role: 'repair' });

      const deniedShellCommands = [
        'echo "tamper" > specs/red_signal/red_signal.als',
        'cat src/planner.ts >> specs/red_signal/red_signal.als',
        'cp src/planner.ts specs/red_signal/red_signal.als',
        'mv src/planner.ts specs/red_signal/red_signal.als',
        'rm -f specs/red_signal/red_signal.als',
        'sed -i "" "s/true/false/" specs/red_signal/red_signal.als',
        'python3 -c "open(\'specs/red_signal/red_signal.als\', \'w\').write(\'x\')"',
        'sort -o specs/red_signal/red_signal.als src/planner.ts',
        'find specs -delete',
        'echo $(rm specs/red_signal/red_signal.als)',
        'rm sp*cs/red_signal/red_signal.als',
      ];

      for (const command of deniedShellCommands) {
        const decision = engine.classify({
          tool: 'shell',
          input: { command },
          executionId: 'exec-repair',
          projectRoot: tmpRoot,
        });
        expect(decision.decision, `expected shell deny for: ${command}`).toBe('deny');
        expect(decision.rule).toBe(SPEC_WRITE_FENCE_RULE);
      }

      // Read-only shell commands on specs/ remain allowed
      const allowedReadCommands = [
        'cat specs/red_signal/red_signal.als',
        'rg "module" specs/red_signal/red_signal.als',
        'ls specs/red_signal',
      ];
      for (const command of allowedReadCommands) {
        const decision = engine.classify({
          tool: 'shell',
          input: { command },
          executionId: 'exec-repair',
          projectRoot: tmpRoot,
        });
        expect(decision.decision, `expected shell allow for: ${command}`).toBe('allow');
      }

      // Git write touching specs/ is denied with spec-write-fence-deny, whereas git status/diff on specs/ is allowed
      const gitCheckoutSpec = engine.classify({
        tool: 'git',
        input: { args: ['checkout', '--', 'specs/red_signal/red_signal.als'] },
        executionId: 'exec-repair',
        projectRoot: tmpRoot,
      });
      expect(gitCheckoutSpec.decision).toBe('deny');
      expect(gitCheckoutSpec.rule).toBe(SPEC_WRITE_FENCE_RULE);

      const gitDiffSpec = engine.classify({
        tool: 'git',
        input: { args: ['diff', 'specs/red_signal/red_signal.als'] },
        executionId: 'exec-repair',
        projectRoot: tmpRoot,
      });
      expect(gitDiffSpec.decision).toBe('allow');

      // Read tool on specs/ is allowed for implementation/repair tasks
      const readSpec = engine.classify({
        tool: 'read',
        input: { path: 'specs/red_signal/red_signal.als' },
        executionId: 'exec-repair',
        projectRoot: tmpRoot,
      });
      expect(readSpec.decision).toBe('allow');

      // Ordinary implementation file writes remain allowed for implementation/repair tasks
      const writeSrc = engine.classify({
        tool: 'write',
        input: { path: 'src/planner.ts', content: 'export const stop = true;\n' },
        executionId: 'exec-repair',
        projectRoot: tmpRoot,
      });
      expect(writeSrc.decision).toBe('allow');

      // Custom/MCP tool mentioning specs/ is denied by the spec fence
      const mcpWriteSpec = engine.classify({
        tool: 'mcp:fs:write_file',
        input: { target: 'specs/red_signal/red_signal.als', text: 'x' },
        executionId: 'exec-repair',
        projectRoot: tmpRoot,
      });
      expect(mcpWriteSpec.decision).toBe('deny');
      expect(mcpWriteSpec.rule).toBe(SPEC_WRITE_FENCE_RULE);
    });

    it('exposes the spec fence helpers cleanly through @wazir/policies', () => {
      const engine = createFacadeEngine({ projectRoot: tmpRoot });
      facadeRegisterSpecFence(engine, 'exec-impl', { role: 'implementation' });
      expect(facadeIsSpecAuthorRole('spec-author')).toBe(true);
      expect(facadeIsSpecAuthorRole('implementation')).toBe(false);
      expect(facadeIsSpecAuthorRole(undefined)).toBe(false);

      const fenceDecision = facadeEvaluateSpecFence(engine, {
        tool: 'write',
        input: { path: 'specs/red_signal/red_signal.als', content: 'x' },
        executionId: 'exec-impl',
        projectRoot: tmpRoot,
      });
      expect(fenceDecision?.decision).toBe('deny');
      expect(fenceDecision?.rule).toBe(SPEC_WRITE_FENCE_RULE);

      const blocker = facadeSpecWriteFenceBlocker('task-1', 'repair', [
        { path: 'specs/red_signal/red_signal.als' },
      ]);
      expect(blocker).toContain(SPEC_WRITE_FENCE_BLOCKER);
    });
  });

  describe('2. Worktree read-only permissions & OS sandbox bind arguments', () => {
    it('applies chmod -R a-w, generates bwrap --ro-bind and seatbelt deny rules, and enforces requiredIsolation for non-spec-author tasks', async () => {
      const repoDir = path.join(tmpRoot, 'repo');
      await initGitRepo(repoDir);

      const worktrees = new WorktreeManager({
        worktreeRootDir: path.join(tmpRoot, 'worktrees'),
      });
      const engine = new PolicyEngine({ projectRoot: repoDir });

      const wtInfo = await worktrees.createWorktree(repoDir, 'job-1', 'task-impl', { role: 'implementation' });
      expect(wtInfo.role).toBe('implementation');
      expect(wtInfo.specFence).toBeDefined();

      const fenced = await fenceTaskWorkspace({
        engine,
        worktrees,
        worktreeDir: wtInfo.worktreeDir,
        executionId: 'exec-impl',
        task: { id: 'task-impl', role: 'implementation' },
      });

      expect(fenced.fence).toBeDefined();
      const fence = fenced.fence!;
      const fencedSpecDir = path.join(wtInfo.worktreeDir, 'specs');
      const fencedAlsFile = path.join(fencedSpecDir, 'red_signal', 'red_signal.als');

      expect(fence.readOnlyPaths).toContain(fencedSpecDir);
      expect(fence.requiredIsolation).toBe('os');

      // bwrap args include --ro-bind for the spec directory
      expect(fence.bwrapArgs).toContain('--ro-bind');
      expect(fence.bwrapArgs).toContain(fencedSpecDir);

      // Seatbelt rules include (deny file-write* (subpath "..."))
      expect(fence.seatbeltRules.some((r) => r.includes('(deny file-write*') && r.includes(fencedSpecDir))).toBe(true);

      // Verify permissions on disk have no write bits (0o222 === 0)
      const dirStat = await fs.stat(fencedSpecDir);
      const fileStat = await fs.stat(fencedAlsFile);
      expect(dirStat.mode & 0o222).toBe(0);
      expect(fileStat.mode & 0o222).toBe(0);

      // Integrity verification reports zero violations when untouched
      expect(await verifyTaskWorkspaceFence(worktrees, fenced)).toEqual([]);

      // If permissions are tampered with out-of-band, verifyTaskWorkspaceFence detects the violation
      await fs.chmod(fencedAlsFile, 0o644);
      const violations = await verifyTaskWorkspaceFence(worktrees, fenced);
      expect(violations.some((v) => v.includes('write permission restored'))).toBe(true);

      // Because fenceTaskWorkspace registered requiredIsolation: 'os', executing without an active sandbox fails closed
      const unsandboxedWrite = engine.classify({
        tool: 'write',
        input: { path: 'src/planner.ts', content: 'export const stop = false;\n' },
        executionId: 'exec-impl',
        effectiveIsolation: 'none',
        projectRoot: wtInfo.worktreeDir,
      });
      expect(unsandboxedWrite.decision).toBe('deny');
      expect(unsandboxedWrite.rule).toBe('isolation-unavailable');

      // With an active OS sandbox (e.g. seatbelt or bwrap), normal writes outside specs/ are allowed
      const sandboxedWrite = engine.classify({
        tool: 'write',
        input: { path: 'src/planner.ts', content: 'export const stop = false;\n' },
        executionId: 'exec-impl',
        effectiveIsolation: 'seatbelt',
        projectRoot: wtInfo.worktreeDir,
      });
      expect(sandboxedWrite.decision).toBe('allow');

      // Clean removal restores write permissions and removes the worktree
      await worktrees.removeWorktree(wtInfo);
      await expect(fs.access(wtInfo.worktreeDir)).rejects.toThrow();
    });

    it('leaves specs/ writable and omits read-only fence for spec-author worktrees', async () => {
      const repoDir = path.join(tmpRoot, 'repo-author');
      await initGitRepo(repoDir);

      const worktrees = new WorktreeManager({
        worktreeRootDir: path.join(tmpRoot, 'worktrees-author'),
      });
      const engine = new PolicyEngine({ projectRoot: repoDir });

      const wtInfo = await worktrees.createWorktree(repoDir, 'job-2', 'task-author', { role: 'spec-author' });
      expect(wtInfo.specFence).toBeUndefined();

      const fenced = await fenceTaskWorkspace({
        engine,
        worktrees,
        worktreeDir: wtInfo.worktreeDir,
        executionId: 'exec-author',
        task: { id: 'task-author', role: 'spec-author' },
      });
      expect(fenced.fence).toBeUndefined();
      expect(await verifyTaskWorkspaceFence(worktrees, fenced)).toEqual([]);

      const alsFile = path.join(wtInfo.worktreeDir, 'specs', 'red_signal', 'red_signal.als');
      const stat = await fs.stat(alsFile);
      expect(stat.mode & 0o200).not.toBe(0);

      await worktrees.removeWorktree(wtInfo);
    });
  });

  describe('3. Layer B — Out-of-band edit rejection at merge/integration time (SPEC_WRITE_FENCE)', () => {
    it('rejects out-of-band spec edits in an implementation or repair worktree at checkSpecWriteFence and plan() time', async () => {
      const repoDir = path.join(tmpRoot, 'repo-merge');
      await initGitRepo(repoDir);

      const tasks: TrustedTaskRecord[] = [
        { id: 'task-impl', role: 'implementation' },
        { id: 'task-repair', role: 'repair' },
        { id: 'task-author', role: 'spec-author' },
      ];
      const coordinator = new VerifiedIntegrationCoordinator({
        candidateRootDir: path.join(tmpRoot, 'candidates'),
        resolveTaskRole: createTaskRoleResolver(tasks),
      });

      // Create an implementation branch and perform an out-of-band edit to specs/red_signal/red_signal.als
      await git(repoDir, ['checkout', '-b', 'wazir/job-1/task-impl']);
      await fs.writeFile(
        path.join(repoDir, 'specs', 'red_signal', 'red_signal.als'),
        'module red_signal // weakened out-of-band!\n',
        'utf8',
      );
      await git(repoDir, ['add', '-A']);
      await git(repoDir, ['commit', '-m', 'out-of-band spec weakening']);
      const implHead = await git(repoDir, ['rev-parse', 'HEAD']);
      const now = new Date().toISOString();
      const sha256 = 'a'.repeat(64);

      const implManifest = await coordinator.createManifest(repoDir, {
        taskId: 'task-impl',
        agentId: 'agent-1',
        targetBranch: 'main',
        declaredOwnership: ['specs/red_signal/red_signal.als'],
        testsExecuted: [
          {
            name: 'unit-tests',
            command: 'vitest',
            status: 'PASS',
            sourceSha: implHead,
            runId: 'run-1',
            runnerId: 'runner-1',
            exitCode: 0,
            resultSha256: sha256,
            startedAt: now,
            completedAt: now,
          },
        ],
        verificationEvidence: [
          {
            id: 'ev-1',
            status: 'PASS',
            sourceSha: implHead,
            resultSha256: sha256,
          },
        ],
        outstandingRisks: [],
      });
      await git(repoDir, ['checkout', 'main']);

      // Direct check via checkSpecMerge / checkSpecWriteFence
      const blockers = await checkSpecMerge(
        coordinator,
        repoDir,
        'main',
        'wazir/job-1/task-impl',
        { id: 'task-impl', role: 'implementation' },
      );
      expect(blockers.length).toBeGreaterThan(0);
      expect(blockers[0]).toContain(SPEC_WRITE_FENCE_BLOCKER);
      expect(blockers[0]).toContain('specs/red_signal/red_signal.als');

      // Also check for repair role on the same branch
      const repairCheck = await coordinator.checkSpecWriteFence(
        repoDir,
        'main',
        'wazir/job-1/task-impl',
        'task-repair',
      );
      expect(repairCheck.touchedSpecPaths).toEqual(['specs/red_signal/red_signal.als']);
      expect(repairCheck.role).toBe('repair');
      expect(repairCheck.blockers[0]).toContain(SPEC_WRITE_FENCE_BLOCKER);

      // Full integration plan rejects the candidate with SPEC_WRITE_FENCE
      const plan = await coordinator.plan(repoDir, 'main', [
        { branch: 'wazir/job-1/task-impl', manifest: implManifest },
      ]);
      expect(plan.readyToBuildCandidate).toBe(false);
      expect(plan.blockers.some((b) => b.includes(SPEC_WRITE_FENCE_BLOCKER))).toBe(true);
    });
  });

  describe('4. spec-author permissions & human-only approval gate', () => {
    it('allows a spec-author task to edit draft/reviewed specs in specs/, while denying status: approved or retired in Layer A and Layer B', async () => {
      const repoDir = path.join(tmpRoot, 'repo-spec-author');
      await initGitRepo(repoDir);

      const tasks: TrustedTaskRecord[] = [{ id: 'task-author', role: 'spec-author' }];
      const resolver = createTaskRoleResolver(tasks);
      const engine = new PolicyEngine({
        projectRoot: repoDir,
        resolveTaskRole: resolver,
      });
      const coordinator = new VerifiedIntegrationCoordinator({
        candidateRootDir: path.join(tmpRoot, 'candidates-author'),
        resolveTaskRole: resolver,
      });

      // Layer A: spec-author is allowed to edit .als files and draft/reviewed manifest.yaml in specs/
      const editAlsDecision = engine.classify({
        tool: 'edit',
        input: { path: 'specs/red_signal/red_signal.als', content: 'module red_signal\nsig Vehicle {}\n' },
        executionId: 'task-author',
        projectRoot: repoDir,
      });
      expect(editAlsDecision.decision).toBe('allow');

      const writeDraftManifest = engine.classify({
        tool: 'write',
        input: {
          path: 'specs/red_signal/manifest.yaml',
          content: 'id: RED_SIGNAL_COMPLIANCE\nversion: "1.1"\nstatus: draft\n',
        },
        executionId: 'task-author',
        projectRoot: repoDir,
      });
      expect(writeDraftManifest.decision).toBe('allow');

      const writeReviewedManifest = engine.classify({
        tool: 'write',
        input: {
          path: 'specs/red_signal/manifest.yaml',
          content: 'id: RED_SIGNAL_COMPLIANCE\nversion: "1.1"\nstatus: reviewed\n',
        },
        executionId: 'task-author',
        projectRoot: repoDir,
      });
      expect(writeReviewedManifest.decision).toBe('allow');

      // Layer A: spec-author is denied from writing status: approved or status: retired directly
      for (const forbiddenStatus of ['approved', 'retired']) {
        const selfApproveDecision = engine.classify({
          tool: 'write',
          input: {
            path: 'specs/red_signal/manifest.yaml',
            content: `id: RED_SIGNAL_COMPLIANCE\nversion: "1.1"\nstatus: ${forbiddenStatus}\n`,
          },
          executionId: 'task-author',
          projectRoot: repoDir,
        });
        expect(selfApproveDecision.decision).toBe('deny');
        expect(selfApproveDecision.rule).toBe(SPEC_APPROVAL_FENCE_RULE);
      }

      // Layer B: Branch with valid draft spec edits by spec-author passes checkSpecWriteFence
      await git(repoDir, ['checkout', '-b', 'wazir/job-author/draft-update']);
      await fs.writeFile(
        path.join(repoDir, 'specs', 'red_signal', 'red_signal.als'),
        'module red_signal\nsig Vehicle {}\n',
        'utf8',
      );
      await git(repoDir, ['add', '-A']);
      await git(repoDir, ['commit', '-m', 'refine draft spec']);

      const draftBlockers = await checkSpecMerge(
        coordinator,
        repoDir,
        'main',
        'wazir/job-author/draft-update',
        { id: 'task-author', role: 'spec-author' },
      );
      expect(draftBlockers).toEqual([]);

      // Layer B: If spec-author commits status: approved out-of-band, checkSpecWriteFence blocks the merge
      await fs.writeFile(
        path.join(repoDir, 'specs', 'red_signal', 'manifest.yaml'),
        'id: RED_SIGNAL_COMPLIANCE\nversion: "1.1"\nstatus: approved\nguarantee: "never cross on red"\n',
        'utf8',
      );
      await git(repoDir, ['add', '-A']);
      await git(repoDir, ['commit', '-m', 'attempt self-approval']);

      const approvalBlockers = await checkSpecMerge(
        coordinator,
        repoDir,
        'main',
        'wazir/job-author/draft-update',
        { id: 'task-author', role: 'spec-author' },
      );
      expect(approvalBlockers.length).toBe(1);
      expect(approvalBlockers[0]).toContain(SPEC_WRITE_FENCE_BLOCKER);
      expect(approvalBlockers[0]).toContain("status 'approved'");
      expect(approvalBlockers[0]).toContain('only human approval');
    });

    it('parses YAML and JSON manifest statuses deterministically and fails closed on ambiguous manifests', () => {
      expect(parseSpecManifestStatus('id: X\nstatus: draft\n', 'manifest.yaml')).toBe('draft');
      expect(parseSpecManifestStatus('id: X\nstatus: "reviewed" # comment\n', 'manifest.yml')).toBe('reviewed');
      expect(parseSpecManifestStatus('{"id":"X","status":"approved"}', 'manifest.json')).toBe('approved');
      // Duplicate status keys in YAML fail closed (undefined)
      expect(parseSpecManifestStatus('status: draft\nstatus: approved\n', 'manifest.yaml')).toBeUndefined();
      // Malformed JSON fails closed
      expect(parseSpecManifestStatus('{bad json', 'manifest.json')).toBeUndefined();

      expect(isSpecRelativePath('specs/red_signal/red_signal.als')).toBe(true);
      expect(isSpecRelativePath('src/index.ts')).toBe(false);
      expect(specFenceTouchedPaths([
        { path: 'src/a.ts' },
        { path: 'moved.als', previousPath: 'specs/red_signal/red_signal.als' },
      ])).toEqual(['specs/red_signal/red_signal.als']);
      expect(isSpecAuthorRole('spec-author')).toBe(true);
      expect(specWriteFenceBlocker('t1', 'spec-author', ['specs/a.als'])).toBeNull();
      expect(specWriteFenceBlocker('t1', 'implementation', ['specs/a.als'])).toContain(SPEC_WRITE_FENCE_BLOCKER);
    });
  });
});
