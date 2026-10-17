import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('Headless DGX Self-Improvement Supervisor CLI & Controlled E2E Repair Cycle', () => {
  let tmpRoot: string;
  let repoDir: string;
  let configHome: string;
  const cliDistEntry = path.resolve(process.cwd(), 'apps/cli/dist/index.js');

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-improve-e2e-'));
    repoDir = path.join(tmpRoot, 'repo');
    configHome = path.join(tmpRoot, 'wazir-config');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(path.join(configHome, 'logs'), { recursive: true });

    // Seed a crash log so HARDEN observation detects real incident evidence
    await fs.writeFile(
      path.join(configHome, 'logs', 'crash-20261015.log'),
      'Error: ECONNRESET in worker stream (api_key=sk-secret123456)\n    at Socket.onError (worker.js:42:11)\n',
      'utf8',
    );

    // Initialize isolated Git repository with a real reproducible defect and node:test oracle
    execFileSync('git', ['init'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@wazir.local'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Wazir E2E'], { cwd: repoDir });

    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'tests'), { recursive: true });

    // Deliberate defect: clampScore returns value - max instead of Math.min(max, Math.max(min, value))
    await fs.writeFile(
      path.join(repoDir, 'src', 'score.mjs'),
      [
        'export function clampScore(value, min = 0, max = 100) {',
        '  if (value > max) return value - max;',
        '  if (value < min) return min;',
        '  return value;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    await fs.writeFile(
      path.join(repoDir, 'tests', 'score.test.mjs'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { clampScore } from '../src/score.mjs';",
        '',
        "test('clamps score to upper bound', () => {",
        '  assert.equal(clampScore(125, 0, 100), 100);',
        '  assert.equal(clampScore(-10, 0, 100), 0);',
        '  assert.equal(clampScore(50, 0, 100), 50);',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );

    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'Initial commit with reproducible clampScore defect'], {
      cwd: repoDir,
    });
  });

  afterEach(async () => {
    try {
      await execFileAsync(process.execPath, [cliDistEntry, 'improve', 'stop'], {
        cwd: repoDir,
        env: { ...process.env, WAZIR_HOME: configHome, WAZIR_IN_MEMORY: '1' },
      });
    } catch {
      // ignore if not running
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const runCli = async (args: string[]) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliDistEntry, ...args], {
      cwd: repoDir,
      env: {
        ...process.env,
        WAZIR_HOME: configHome,
        WAZIR_IN_MEMORY: '1',
        WAZIR_IMPROVE_IGNORE_LOAD: '1',
        WAZIR_IMPROVE_LIVE_POLLS: '1',
        WAZIR_IMPROVE_FOLLOW_POLLS: '1',
      },
      timeout: 30_000,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  };

  it('executes doctor, harden, optimize, evolve, failures, recommendations, history, and logs commands', async () => {
    const doctor = JSON.parse((await runCli(['improve', 'doctor'])).stdout);
    expect(doctor.serviceInstalledByThisCommand).toBe(false);
    expect(doctor.supervisorRunning).toBe(false);

    const unitOut = (await runCli(['improve', 'doctor', '--print-systemd-unit'])).stdout;
    expect(unitOut).toContain('[Unit]');
    expect(unitOut).toContain('improve start --foreground --continuous');

    // Run harden cycle without scope -> observes crash log, generates recommendation, blocks on missing scope
    const hardenState = JSON.parse((await runCli(['improve', 'run', '--mode', 'harden'])).stdout);
    expect(hardenState.phase).toBe('BLOCKED');
    expect(hardenState.cycles).toBe(1);

    // Run optimize cycle
    const optimizeState = JSON.parse((await runCli(['improve', 'run', '--mode', 'optimize'])).stdout);
    expect(optimizeState.phase).toBe('BLOCKED');
    expect(optimizeState.modes).toEqual(['optimize']);

    // Run evolve cycle without scope -> blocks cleanly requiring authorized feature scope
    const evolveState = JSON.parse((await runCli(['improve', 'run', '--mode', 'evolve'])).stdout);
    expect(evolveState.phase).toBe('BLOCKED');
    expect(evolveState.reason).toContain('EVOLVE requires an authorized feature scope');

    // Inspect failures (crash incident recorded and redacted)
    const failures = JSON.parse((await runCli(['improve', 'failures'])).stdout);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].kind).toBe('crash');
    expect(failures[0].summary).toContain('[REDACTED]');
    expect(failures[0].summary).not.toContain('sk-secret123456');

    // Inspect recommendations
    const recs = JSON.parse((await runCli(['improve', 'recommendations'])).stdout);
    expect(recs.length).toBeGreaterThan(0);

    // Inspect logs --follow
    const logs = (await runCli(['improve', 'logs', '--follow'])).stdout;
    expect(logs).toContain('"event":"phase"');
  }, 60_000);

  it('runs a controlled end-to-end HARDEN repair cycle on a real reproducible defect in an isolated worktree', async () => {
    const scopePath = path.join(tmpRoot, 'repair-scope.json');
    const scope = {
      version: 1,
      repository: repoDir,
      mode: 'harden',
      prompt: 'Fix clampScore upper bound return value in src/score.mjs so values > max return max.',
      files: ['src/score.mjs'],
      checks: [{ command: process.execPath, args: ['--test', 'tests/score.test.mjs'] }],
      agent: 'scoped-patch',
      patches: [
        {
          file: 'src/score.mjs',
          oldString: 'if (value > max) return value - max;',
          newString: 'if (value > max) return max;',
        },
      ],
      timeoutMs: 30000,
      maxTurns: 4,
    };
    await fs.writeFile(scopePath, JSON.stringify(scope, null, 2), 'utf8');

    const runOut = JSON.parse(
      (await runCli(['improve', 'run', '--mode', 'harden', '--scope', scopePath])).stdout,
    );
    expect(runOut.phase).toBe('STAGED');
    expect(runOut.reason).toContain('Real source repair passed independent checks');

    const history = JSON.parse((await runCli(['improve', 'history'])).stdout);
    expect(history.length).toBeGreaterThan(0);
    const latestAttempt = history[0];
    expect(latestAttempt.decision).toBe('STAGED');
    expect(latestAttempt.evidence.baseline[0].exitCode).toBe(1);
    expect(latestAttempt.evidence.candidate[0].exitCode).toBe(0);
    expect(latestAttempt.evidence.changed).toEqual(['src/score.mjs']);

    // Verify primary repository was NOT overwritten directly
    const primarySource = await fs.readFile(path.join(repoDir, 'src', 'score.mjs'), 'utf8');
    expect(primarySource).toContain('return value - max;');

    // Verify isolated candidate worktree contains the verified fix
    const candWorktreeDir = latestAttempt.evidence.worktree.worktreeDir;
    const candidateSource = await fs.readFile(path.join(candWorktreeDir, 'src', 'score.mjs'), 'utf8');
    expect(candidateSource).toContain('if (value > max) return max;');
  }, 60_000);

  it('starts background continuous supervisor, enforces singleton lease, supports status --live, pause, resume, and stop', async () => {
    const startRes = JSON.parse(
      (
        await runCli([
          'improve',
          'start',
          '--continuous',
          '--mode',
          'harden,optimize',
          '--interval',
          '2',
          '--max-cycles',
          '20',
        ])
      ).stdout,
    );
    expect(startRes.started).toBe(true);
    expect(startRes.pid).toBeGreaterThan(0);

    // Duplicate start must fail closed
    await expect(
      runCli(['improve', 'start', '--continuous', '--mode', 'harden']),
    ).rejects.toThrow();

    // Live status check
    const liveStatus = JSON.parse((await runCli(['improve', 'status', '--live'])).stdout);
    expect(liveStatus.running).toBe(true);
    expect(liveStatus.modes).toEqual(['harden', 'optimize']);

    // Pause
    const pauseRes = JSON.parse((await runCli(['improve', 'pause'])).stdout);
    expect(pauseRes.requested).toBe('pause');

    // Resume
    const resumeRes = JSON.parse((await runCli(['improve', 'resume'])).stdout);
    expect(resumeRes.requested).toBe('resume');

    // Stop
    const stopRes = JSON.parse((await runCli(['improve', 'stop'])).stdout);
    expect(stopRes.requested).toBe('stop');
    expect(stopRes.running).toBe(false);
  }, 60_000);

  it('rejects disqualified coding model nvidia/nemotron-3-nano-omni and executes authorized EVOLVE scope in isolated worktree', async () => {
    // 1. Disqualified model scope must fail closed
    const badModelScopePath = path.join(tmpRoot, 'bad-model-scope.json');
    await fs.writeFile(
      badModelScopePath,
      JSON.stringify(
        {
          version: 1,
          repository: repoDir,
          mode: 'harden',
          prompt: 'Attempt repair with disqualified nano model',
          files: ['src/score.mjs'],
          checks: [{ command: process.execPath, args: ['--test', 'tests/score.test.mjs'] }],
          agent: 'wazir-coding',
          model: 'nvidia/nemotron-3-nano-omni',
        },
        null,
        2,
      ),
      'utf8',
    );

    const badModelRun = JSON.parse(
      (await runCli(['improve', 'run', '--mode', 'harden', '--scope', badModelScopePath])).stdout,
    );
    expect(badModelRun.phase).toBe('FAILED');
    expect(badModelRun.reason).toContain('disqualified for multi-step source repair');

    // 2. Authorized EVOLVE scope in isolated worktree
    const evolveScopePath = path.join(tmpRoot, 'evolve-scope.json');
    await fs.writeFile(
      evolveScopePath,
      JSON.stringify(
        {
          version: 1,
          repository: repoDir,
          mode: 'evolve',
          authorizedFeature: 'Clamp score and support normalized percentage helper',
          prompt: 'Fix clampScore upper bound in src/score.mjs',
          files: ['src/score.mjs'],
          checks: [{ command: process.execPath, args: ['--test', 'tests/score.test.mjs'] }],
          agent: 'scoped-patch',
          patches: [
            {
              file: 'src/score.mjs',
              oldString: 'if (value > max) return value - max;',
              newString: 'if (value > max) return max;',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const evolveRun = JSON.parse(
      (await runCli(['improve', 'run', '--mode', 'evolve', '--scope', evolveScopePath])).stdout,
    );
    expect(evolveRun.phase).toBe('STAGED');

    // 2b. Rejecting an OPTIMIZE candidate that reduces tokens but breaks correctness
    const badOptScopePath = path.join(tmpRoot, 'bad-opt-scope.json');
    await fs.writeFile(
      badOptScopePath,
      JSON.stringify(
        {
          version: 1,
          repository: repoDir,
          mode: 'optimize',
          prompt: 'Reduce token overhead in clampScore',
          files: ['src/score.mjs'],
          checks: [{ command: process.execPath, args: ['--test', 'tests/score.test.mjs'] }],
          agent: 'scoped-patch',
          baselineMetrics: { inputTokens: 1200, outputTokens: 300, latencyMs: 900 },
          candidateMetrics: { inputTokens: 400, outputTokens: 80, latencyMs: 350 },
          patches: [
            {
              file: 'src/score.mjs',
              oldString: 'if (value < min) return min;',
              newString: 'if (value < min) return 0;',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    const badOptRun = JSON.parse(
      (await runCli(['improve', 'run', '--mode', 'optimize', '--scope', badOptScopePath])).stdout,
    );
    expect(badOptRun.phase).toBe('BLOCKED');
    expect(badOptRun.reason).toContain('Optimization candidate rejected due to correctness regression');

    // 3. Promoting a non-existent candidate via wa improve promote --json fails closed
    const promoteOut = JSON.parse(
      (await runCli(['improve', 'promote', 'cand-nonexistent-123', '--json'])).stdout,
    );
    expect(promoteOut.success).toBe(false);
    expect(promoteOut.reason).toContain('PROMOTION_DENIED');
  }, 60_000);

  it('enforces Git preflight, dirty working-tree protection, MANUAL_COMMIT approval, AUTO_COMMIT, and NO_COMMIT via CLI', async () => {
    // Dirty the user's primary working tree with an uncommitted change
    await fs.writeFile(path.join(repoDir, 'user-wip.txt'), 'uncommitted user work\n', 'utf8');

    const preflightOut = JSON.parse((await runCli(['improve', 'preflight', '--json'])).stdout);
    expect(preflightOut.ok).toBe(true);
    expect(preflightOut.isDirty).toBe(true);
    expect(preflightOut.untrackedFiles).toContain('user-wip.txt');

    // 1. Default MANUAL_COMMIT mode stages candidate in AWAITING_COMMIT_APPROVAL and asks for approval
    const manualScopePath = path.join(tmpRoot, 'manual-commit-scope.json');
    await fs.writeFile(
      manualScopePath,
      JSON.stringify(
        {
          version: 1,
          repository: repoDir,
          mode: 'harden',
          prompt: 'Manual commit approval test for clampScore',
          files: ['src/score.mjs'],
          checks: [{ command: process.execPath, args: ['--test', 'tests/score.test.mjs'] }],
          agent: 'scoped-patch',
          patches: [
            {
              file: 'src/score.mjs',
              oldString: 'if (value > max) return value - max;',
              newString: 'if (value > max) return max;',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const manualRun = JSON.parse(
      (await runCli(['improve', 'run', '--mode', 'harden', '--scope', manualScopePath])).stdout,
    );
    expect(manualRun.phase).toBe('STAGED');
    expect(manualRun.reason).toContain('MANUAL_COMMIT: awaiting user commit approval');
    expect(manualRun.lastCompletionSummary.commitDecision.effectiveCommitMode).toBe('MANUAL_COMMIT');
    expect(manualRun.lastCompletionSummary.commitDecision.approvalPrompt).toBe(
      'Implementation and verification are complete. Would you like me to commit these changes?',
    );

    // User's dirty file in primary repo is completely untouched
    expect(await fs.readFile(path.join(repoDir, 'user-wip.txt'), 'utf8')).toBe('uncommitted user work\n');

    // Inspect pending approvals via `wa improve approvals`
    const approvalsOut = JSON.parse((await runCli(['improve', 'approvals', '--json'])).stdout);
    expect(approvalsOut.effectiveCommitMode).toBe('MANUAL_COMMIT');
    expect(approvalsOut.pendingCount).toBe(1);
    const pendingCandidate = approvalsOut.pendingApprovals[0];
    expect(pendingCandidate.state).toBe('AWAITING_COMMIT_APPROVAL');

    // Approve and commit via `wa improve approve <attemptId> --action COMMIT --revision <hash>`
    const approveRes = JSON.parse(
      (
        await runCli([
          'improve',
          'approve',
          pendingCandidate.attemptId,
          '--action',
          'COMMIT',
          '--revision',
          pendingCandidate.candidateRevisionHash,
          '--json',
        ])
      ).stdout,
    );
    expect(approveRes.ok).toBe(true);
    expect(approveRes.state).toBe('COMMITTED');
    expect(approveRes.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // 2. Explicit AUTO_COMMIT mode commits verified candidate automatically
    const autoScopePath = path.join(tmpRoot, 'auto-commit-scope.json');
    await fs.writeFile(
      autoScopePath,
      JSON.stringify(
        {
          version: 1,
          repository: repoDir,
          mode: 'harden',
          prompt: 'Auto commit test for clampScore',
          files: ['src/score.mjs'],
          checks: [{ command: process.execPath, args: ['--test', 'tests/score.test.mjs'] }],
          agent: 'scoped-patch',
          patches: [
            {
              file: 'src/score.mjs',
              oldString: 'if (value > max) return value - max;',
              newString: 'if (value > max) return max;',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const autoRun = JSON.parse(
      (await runCli(['improve', 'run', '--mode', 'harden', '--scope', autoScopePath, '--auto-commit'])).stdout,
    );
    expect(autoRun.phase).toBe('STAGED');
    expect(autoRun.reason).toContain('AUTO_COMMIT:');

    // 3. NO_COMMIT mode preserves verified candidate uncommitted in worktree
    const noCommitScopePath = path.join(tmpRoot, 'no-commit-scope.json');
    await fs.writeFile(
      noCommitScopePath,
      JSON.stringify(
        {
          version: 1,
          repository: repoDir,
          mode: 'harden',
          prompt: 'No commit test for clampScore',
          files: ['src/score.mjs'],
          checks: [{ command: process.execPath, args: ['--test', 'tests/score.test.mjs'] }],
          agent: 'scoped-patch',
          patches: [
            {
              file: 'src/score.mjs',
              oldString: 'if (value > max) return value - max;',
              newString: 'if (value > max) return max;',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const noCommitRun = JSON.parse(
      (await runCli(['improve', 'run', '--mode', 'harden', '--scope', noCommitScopePath, '--no-commit'])).stdout,
    );
    expect(noCommitRun.phase).toBe('STAGED');
    expect(noCommitRun.reason).toContain('NO_COMMIT: preserved uncommitted in worktree');
  }, 60_000);
});
