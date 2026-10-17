import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { VerifiedIntegrationCoordinator, WorktreeManager, type AgentIntegrationManifest, type IntegrationCandidateInput } from '../src/index.js';

const exec = promisify(execFile);
const checkNames = ['build', 'typecheck', 'unit-tests', 'integration-tests'];

describe('VerifiedIntegrationCoordinator', { timeout: 30_000 }, () => {
  let root = '';
  let candidateRoot = '';
  let agentWorktrees: string[] = [];
  let candidateWorktrees: string[] = [];
  let manager: WorktreeManager;
  let coordinator: VerifiedIntegrationCoordinator;

  afterEach(async () => {
    for (const dir of candidateWorktrees) await exec('git', ['worktree', 'remove', '--force', dir], { cwd: root }).catch(() => undefined);
    for (const dir of agentWorktrees) await exec('git', ['worktree', 'remove', '--force', dir], { cwd: root }).catch(() => undefined);
    if (root) await fs.rm(root, { recursive: true, force: true });
    if (candidateRoot) await fs.rm(candidateRoot, { recursive: true, force: true });
    root = ''; candidateRoot = ''; agentWorktrees = []; candidateWorktrees = [];
  });

  async function setup(files: Record<string, string> = { 'README.md': 'base\n' }) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integration-repo-'));
    candidateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-integration-candidates-'));
    await git(root, ['init', '-b', 'main']);
    await git(root, ['config', 'user.name', 'Wazir Test']);
    await git(root, ['config', 'user.email', 'test@wazir.ai']);
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    }
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'initial']);
    manager = new WorktreeManager();
    coordinator = new VerifiedIntegrationCoordinator({ candidateRootDir: candidateRoot });
  }

  async function agent(taskId: string, edits: Record<string, string | null>): Promise<IntegrationCandidateInput> {
    const worktree = await manager.createWorktree(root, 'multi', taskId);
    agentWorktrees.push(worktree.worktreeDir);
    for (const [name, content] of Object.entries(edits)) {
      const file = path.join(worktree.worktreeDir, name);
      if (content === null) await fs.rm(file, { force: true });
      else {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content);
      }
    }
    const committed = await manager.commitWorktree(worktree, `agent ${taskId}`);
    expect(committed.committed).toBe(true);
    const manifest = await coordinator.createManifest(worktree.worktreeDir, {
      taskId,
      agentId: `agent-${taskId}`,
      targetBranch: 'main',
      declaredOwnership: Object.keys(edits),
      testsExecuted: [testEvidence('agent-unit', committed.commitSha!)],
      verificationEvidence: [{ id: `verify-${taskId}`, status: 'PASS', sourceSha: committed.commitSha!, resultSha256: 'a'.repeat(64) }],
      outstandingRisks: [],
    });
    return { branch: worktree.branch, manifest };
  }

  async function validateCandidate(candidatePath: string) {
    candidateWorktrees.push(candidatePath);
    return checksFor(candidatePath);
  }

  it('records manifests and qualifies independent changes in a detached candidate', async () => {
    await setup();
    const a = await agent('task-a', { 'a.txt': 'from a\n' });
    const b = await agent('task-b', { 'b.txt': 'from b\n' });
    const targetBefore = await git(root, ['rev-parse', 'main']);
    const report = await coordinator.qualify(root, {
      targetBranch: 'main', expectedTargetSha: targetBefore, candidates: [b, a], verifyCandidate: validateCandidate,
    });
    expect(report.state).toBe('READY');
    expect(report.appliedBranches).toEqual([a.branch, b.branch]);
    expect((await fs.readFile(path.join(report.candidatePath, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('from a\n');
    expect((await fs.readFile(path.join(report.candidatePath, 'b.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('from b\n');
    expect(await git(root, ['rev-parse', 'main'])).toBe(targetBefore);
    expect((await coordinator.inspectJournal(root, report.integrationId)).candidateTreeSha).toBe(report.candidateTreeSha);
  });

  it('reports same-file conflicts before candidate qualification', async () => {
    await setup();
    const a = await agent('task-a', { 'README.md': 'from a\n' });
    const b = await agent('task-b', { 'README.md': 'from b\n' });
    const plan = await coordinator.plan(root, 'main', [a, b]);
    expect(plan.conflicts.some((conflict) => conflict.kind === 'same-file' && conflict.syntactic === 'conflict')).toBe(true);
    expect(plan.readyToBuildCandidate).toBe(false);
  });

  it('detects a rename/delete collision with an edit to the original path', async () => {
    await setup({ 'old-name.txt': 'original\n' });
    const rename = await manager.createWorktree(root, 'multi', 'rename');
    agentWorktrees.push(rename.worktreeDir);
    await git(rename.worktreeDir, ['mv', 'old-name.txt', 'new-name.txt']);
    await git(rename.worktreeDir, ['commit', '-m', 'rename file']);
    const renameManifest = await manifestFor(rename, 'rename');
    const edit = await agent('edit', { 'old-name.txt': 'edited\n' });
    const plan = await coordinator.plan(root, 'main', [{ branch: rename.branch, manifest: renameManifest }, edit]);
    expect(plan.conflicts.some((conflict) => conflict.kind === 'rename-delete')).toBe(true);
  }, 20_000);

  it('classifies competing package metadata changes as dependency conflicts', async () => {
    await setup({ 'package.json': '{"name":"fixture","dependencies":{"x":"1.0.0"}}\n' });
    const a = await agent('task-a', { 'package.json': '{"name":"fixture","dependencies":{"x":"2.0.0"}}\n' });
    const b = await agent('task-b', { 'package.json': '{"name":"fixture","dependencies":{"x":"3.0.0"}}\n' });
    const plan = await coordinator.plan(root, 'main', [a, b]);
    expect(plan.conflicts.some((conflict) => conflict.kind === 'dependency')).toBe(true);
  });

  it('blocks a candidate that changes a protected test oracle', async () => {
    await setup({ 'tests/oracle.test.ts': 'expect(true).toBe(true);\n' });
    const candidate = await agent('task-a', { 'tests/oracle.test.ts': 'expect(false).toBe(false);\n' });
    coordinator = new VerifiedIntegrationCoordinator({ candidateRootDir: candidateRoot, protectedPaths: ['tests/oracle.test.ts'] });
    const plan = await coordinator.plan(root, 'main', [candidate]);
    expect(plan.blockers.join(' ')).toContain('protected verification oracle');
  });

  it('protects test and fixture files by default from the evaluated agent', async () => {
    await setup({ 'src/module.ts': 'export const value = 1;\n', 'tests/module.test.ts': 'expect(value).toBe(1);\n' });
    const candidate = await agent('task-a', { 'src/module.ts': 'export const value = 2;\n', 'tests/module.test.ts': 'expect(value).toBe(2);\n' });
    const plan = await coordinator.plan(root, 'main', [candidate]);
    expect(plan.blockers.join(' ')).toContain('tests/module.test.ts');
  });

  it('labels a candidate based on an older target and qualifies against the recorded current target', async () => {
    await setup();
    const candidate = await agent('task-a', { 'agent.txt': 'agent\n' });
    await fs.writeFile(path.join(root, 'target.txt'), 'target advanced\n');
    await git(root, ['add', 'target.txt']);
    await git(root, ['commit', '-m', 'target advanced']);
    const targetSha = await git(root, ['rev-parse', 'main']);
    const plan = await coordinator.plan(root, 'main', [candidate]);
    expect(plan.candidates[0]?.staleBase).toBe(true);
    const report = await coordinator.qualify(root, { targetBranch: 'main', expectedTargetSha: targetSha, candidates: [candidate], verifyCandidate: validateCandidate });
    expect(report.state).toBe('READY');
    expect((await fs.readFile(path.join(report.candidatePath, 'target.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('target advanced\n');
  });

  it('rejects stale manifest evidence after an agent branch advances', async () => {
    await setup();
    const candidate = await agent('task-a', { 'a.txt': 'first\n' });
    const worktree = agentWorktrees[0]!;
    await fs.writeFile(path.join(worktree, 'later.txt'), 'unreported\n');
    await git(worktree, ['add', 'later.txt']);
    await git(worktree, ['commit', '-m', 'unreported change']);
    const errors = await coordinator.validateManifest(root, candidate.manifest, candidate.branch);
    expect(errors.join(' ')).toContain('stale head');
  });

  it('rejects changed-file hashes that do not match the candidate commit', async () => {
    await setup();
    const candidate = await agent('task-a', { 'a.txt': 'content\n' });
    candidate.manifest.fileHashes['a.txt'] = '0'.repeat(40);
    const errors = await coordinator.validateManifest(root, candidate.manifest, candidate.branch);
    expect(errors).toContain('file hashes do not match manifest head');
  });

  it('rejects malformed evidence and option-like branch refs without throwing', async () => {
    await setup();
    const candidate = await agent('task-a', { 'a.txt': 'content\n' });
    candidate.manifest.testsExecuted = [null as never];
    candidate.manifest.branch = '--all';
    const errors = await coordinator.validateManifest(root, candidate.manifest, candidate.branch);
    expect(errors.join(' ')).toContain('branch name is invalid');
    expect(errors.join(' ')).toContain('invalid test evidence');
  });

  it('orders declared dependencies before dependents deterministically', async () => {
    await setup();
    const dependency = await agent('task-z-dependency', { 'dependency.txt': 'base\n' });
    const dependent = await agent('task-a-dependent', { 'dependent.txt': 'follows dependency\n' });
    const plan = await coordinator.plan(root, 'main', [{ ...dependent, dependsOnTaskIds: ['task-z-dependency'] }, dependency]);
    expect(plan.candidates.map((candidate) => candidate.taskId)).toEqual(['task-z-dependency', 'task-a-dependent']);
  });

  it('keeps dirty target worktrees unchanged and refuses to qualify', async () => {
    await setup();
    const candidate = await agent('task-a', { 'a.txt': 'change\n' });
    await fs.writeFile(path.join(root, 'local.txt'), 'user data\n');
    const targetBefore = await git(root, ['rev-parse', 'main']);
    await expect(coordinator.qualify(root, {
      targetBranch: 'main', expectedTargetSha: targetBefore, candidates: [candidate], verifyCandidate: validateCandidate,
    })).rejects.toThrow('dirty target worktree');
    expect(await fs.readFile(path.join(root, 'local.txt'), 'utf8')).toBe('user data\n');
    expect(await git(root, ['rev-parse', 'main'])).toBe(targetBefore);
  });

  it('fails combined verification and leaves protected target unchanged', async () => {
    await setup();
    const a = await agent('task-a', { 'a.txt': 'change\n' });
    const targetBefore = await git(root, ['rev-parse', 'main']);
    const report = await coordinator.qualify(root, {
      targetBranch: 'main', expectedTargetSha: targetBefore, candidates: [a],
      verifyCandidate: async (candidatePath) => {
        candidateWorktrees.push(candidatePath);
        const checks = await checksFor(candidatePath);
        checks[1]!.status = 'FAIL';
        return checks;
      },
    });
    expect(report.state).toBe('FAILED');
    expect(report.error).toContain('typecheck');
    expect(await git(root, ['rev-parse', 'main'])).toBe(targetBefore);
  });

  it('rejects stale target identity when the target advances during verification', async () => {
    await setup();
    const candidate = await agent('task-a', { 'agent.txt': 'change\n' });
    const expectedTargetSha = await git(root, ['rev-parse', 'main']);
    const report = await coordinator.qualify(root, {
      targetBranch: 'main', expectedTargetSha, candidates: [candidate],
      verifyCandidate: async (candidatePath) => {
        candidateWorktrees.push(candidatePath);
        await fs.writeFile(path.join(root, 'concurrent.txt'), 'new target commit\n');
        await git(root, ['add', 'concurrent.txt']);
        await git(root, ['commit', '-m', 'target advanced during checks']);
        return checksFor(candidatePath);
      },
    });
    expect(report.state).toBe('STALE');
    expect(report.error).toContain('target branch moved');
  });

  it('returns conflict-assistant proposals without applying their patch', async () => {
    await setup();
    const a = await agent('task-a', { 'README.md': 'from a\n' });
    const b = await agent('task-b', { 'README.md': 'from b\n' });
    const plan = await coordinator.plan(root, 'main', [a, b]);
    const conflict = plan.conflicts[0]!;
    const proposal = await coordinator.analyzeConflict(root, plan, conflict, [a, b], async (context) => {
      expect(context.instruction).toContain('Do not modify files');
      expect(context.candidates).toHaveLength(2);
      return { analysis: 'Both branches replace the same line.', proposedPatch: 'diff --git a/README.md b/README.md' };
    });
    expect(proposal.applied).toBe(false);
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('base\n');
  });

  it('recovers an interrupted conflicted candidate after an explicit candidate-only resolution', async () => {
    await setup();
    const a = await agent('task-a', { 'README.md': 'from a\n' });
    const b = await agent('task-b', { 'README.md': 'from b\n' });
    const targetBefore = await git(root, ['rev-parse', 'main']);
    const report = await coordinator.qualify(root, {
      targetBranch: 'main', expectedTargetSha: targetBefore, candidates: [b, a], verifyCandidate: validateCandidate,
    });
    candidateWorktrees.push(report.candidatePath);
    expect(report.state).toBe('CONFLICTED');
    await exec('git', ['worktree', 'remove', '--force', report.candidatePath], { cwd: root });
    const reconstructed = await coordinator.continueQualification(root, report.integrationId, validateCandidate);
    expect(reconstructed.state).toBe('CONFLICTED');
    expect(reconstructed.appliedBranches).toHaveLength(1);
    const pathToResolve = path.join(report.candidatePath, 'README.md');
    await fs.writeFile(pathToResolve, 'reviewed resolution\n');
    await git(report.candidatePath, ['add', 'README.md']);
    await git(report.candidatePath, ['commit', '-m', 'operator reviewed resolution']);
    const resumed = await coordinator.continueQualification(root, report.integrationId, validateCandidate);
    expect(resumed.state).toBe('READY');
    expect(resumed.appliedBranches).toHaveLength(2);
    expect(await git(root, ['rev-parse', 'main'])).toBe(targetBefore);
  });

  async function manifestFor(worktree: { worktreeDir: string; branch: string }, taskId: string): Promise<AgentIntegrationManifest> {
    const head = await git(worktree.worktreeDir, ['rev-parse', 'HEAD']);
    return coordinator.createManifest(worktree.worktreeDir, {
      taskId, agentId: `agent-${taskId}`, targetBranch: 'main', declaredOwnership: ['old-name.txt', 'new-name.txt'],
      testsExecuted: [testEvidence('agent-unit', head)],
      verificationEvidence: [{ id: `verify-${taskId}`, status: 'PASS', sourceSha: head, resultSha256: 'a'.repeat(64) }], outstandingRisks: [],
    });
  }
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function checksFor(candidatePath: string) {
  const sourceSha = await git(candidatePath, ['rev-parse', 'HEAD']);
  const now = new Date().toISOString();
  return checkNames.map((name) => ({ name, status: 'PASS' as 'PASS' | 'FAIL', sourceSha, executionId: `${name}-${sourceSha.slice(0, 8)}`, completedAt: now, resultSha256: 'b'.repeat(64) }));
}

function testEvidence(name: string, sourceSha: string) {
  const now = new Date().toISOString();
  return { name, command: 'npm test -- --run', status: 'PASS' as const, sourceSha, runId: `run-${sourceSha.slice(0, 8)}`, runnerId: 'vitest-fixture', exitCode: 0, resultSha256: 'c'.repeat(64), startedAt: now, completedAt: now };
}
