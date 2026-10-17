import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WorktreeManager } from '@wazir/core';
import type { KeyValueStore } from '@wazir/shared';
import {
  computeCandidateRevisionHash,
  ensureAuthorizedCandidateBranch,
  executeVerifiedCandidateCommit,
  generateCompletionSummary,
  resolveEffectiveCommitPolicy,
  revalidateGitCheckpoint,
  runGitPreflight,
  scanCandidateForSecrets,
  type CommitAuthorizationGrant,
  type CommitPolicyMode,
  type DurableCandidateRecord,
  type GitBaselineRecord,
  type ImprovementMode,
  type SupervisorResult,
} from '@wazir/evaluation';
import type { RookEngine } from './engine.js';

export interface ScopedPatch {
  file: string;
  oldString: string;
  newString: string;
}

export interface RepairScope {
  version: 1;
  repository: string;
  mode: ImprovementMode;
  prompt: string;
  files: string[];
  checks: Array<{ command: string; args: string[] }>;
  agent: string;
  model?: string;
  patches?: ScopedPatch[];
  authorizedFeature?: string;
  timeoutMs?: number;
  maxTurns?: number;
  allowWeakModel?: boolean;
  baselineMetrics?: { inputTokens?: number; outputTokens?: number; latencyMs?: number };
  candidateMetrics?: { inputTokens?: number; outputTokens?: number; latencyMs?: number };
  configMutation?: {
    domain: 'routing' | 'context_policy' | 'tool_surfaces' | 'prompts';
    key: string;
    value: unknown;
    autoPromote?: boolean;
  };
  commitPolicy?: CommitPolicyMode;
  commitAuthorization?: Partial<CommitAuthorizationGrant>;
  offlinePolicy?: 'allow' | 'block';
}

const WEAK_CODING_MODELS = new Set([
  'nvidia/nemotron-3-nano-omni',
  'qwen2.5-7b-instruct',
]);

/**
 * No shell interpolation. Each subprocess has a wall-clock budget and its own
 * process group, terminated as a unit on cancellation or timeout.
 */
export async function boundedCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string; durationMs: number }> {
  if (signal?.aborted) throw new Error('Interrupted');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let output = '';
    let interrupted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (data: Buffer) => {
      output = (output + data.toString()).slice(-256_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const kill = (name: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    };
    const terminate = () => {
      interrupted = true;
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 2000);
    };
    const timer = setTimeout(terminate, timeoutMs);
    signal?.addEventListener('abort', terminate, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', terminate);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      // The group can outlive its leader; do not leave grandchildren running.
      kill('SIGKILL');
      cleanup();
      resolve({
        exitCode: interrupted ? 124 : (code ?? 1),
        output,
        durationMs: Date.now() - started,
      });
    });
  });
}

function canonicalRepoPath(targetPath: string): string {
  try {
    return realpathSync(path.resolve(targetPath));
  } catch {
    return path.resolve(targetPath);
  }
}

function validateScope(value: any, repository: string): asserts value is RepairScope {
  if (value.version !== 1 || canonicalRepoPath(value.repository ?? '') !== canonicalRepoPath(repository)) {
    throw new Error('Scope version/repository mismatch');
  }
  if (!['harden', 'optimize', 'evolve'].includes(value.mode)) {
    throw new Error('Invalid scope mode');
  }
  if (value.mode === 'evolve' && (typeof value.authorizedFeature !== 'string' || !value.authorizedFeature.trim())) {
    throw new Error('EVOLVE scope requires authorizedFeature');
  }
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 16000) {
    throw new Error('Invalid bounded repair prompt');
  }
  if (typeof value.agent !== 'string' || !value.agent) {
    throw new Error('Explicit coding agent required');
  }
  if (value.agent === 'wazir-coding' && !value.model) {
    throw new Error('Explicit coding model required');
  }
  if (
    value.agent === 'wazir-coding' &&
    value.model &&
    WEAK_CODING_MODELS.has(value.model) &&
    !value.allowWeakModel
  ) {
    throw new Error(
      `Model '${value.model}' is disqualified for multi-step source repair due to recorded tool-protocol failures`,
    );
  }
  if (value.agent === 'scoped-patch') {
    if (
      !Array.isArray(value.patches) ||
      value.patches.length === 0 ||
      value.patches.some(
        (p: any) =>
          typeof p?.file !== 'string' ||
          typeof p?.oldString !== 'string' ||
          typeof p?.newString !== 'string' ||
          !p.oldString.length,
      )
    ) {
      throw new Error('scoped-patch agent requires non-empty patches array');
    }
  }
  if (
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 20 ||
    value.files.some(
      (file: unknown) =>
        typeof file !== 'string' ||
        path.isAbsolute(file) ||
        file.split(/[\\/]/).some((part) => part === '..' || part === '.git') ||
        /(^|\/)(test|tests|__tests__)(\/|\.)|\.(test|spec)\./i.test(file),
    )
  ) {
    throw new Error('Scope must name 1..20 source files; test oracles cannot be repair targets');
  }
  if (
    !Array.isArray(value.checks) ||
    !value.checks.length ||
    value.checks.length > 10 ||
    value.checks.some(
      (check: any) =>
        typeof check.command !== 'string' ||
        !check.command ||
        !Array.isArray(check.args) ||
        check.args.some((arg: unknown) => typeof arg !== 'string'),
    )
  ) {
    throw new Error('Independent check argv required');
  }
  if (!Number.isInteger(value.maxTurns ?? 8) || (value.maxTurns ?? 8) < 1 || (value.maxTurns ?? 8) > 20) {
    throw new Error('Turn budget must be 1..20');
  }
  if (
    !Number.isInteger(value.timeoutMs ?? 120000) ||
    (value.timeoutMs ?? 120000) < 1000 ||
    (value.timeoutMs ?? 120000) > 600000
  ) {
    throw new Error('Timeout budget must be 1000..600000ms');
  }
}

export async function executeRepairScope(params: {
  scope: string;
  id: string;
  modes: ImprovementMode[];
  engine: RookEngine;
  store: KeyValueStore;
  signal: AbortSignal;
  directory: string;
  commitAuthorization?: Partial<CommitAuthorizationGrant>;
  offlinePolicy?: 'allow' | 'block';
}): Promise<SupervisorResult> {
  const scopeText = await fs.readFile(params.scope, 'utf8');
  if (scopeText.length > 64000) throw new Error('Scope exceeds 64KB');
  const scope: unknown = JSON.parse(scopeText);
  validateScope(scope, params.engine.projectRoot);
  if (!params.modes.includes(scope.mode)) {
    return { decision: 'INCONCLUSIVE', reason: 'Scope mode is not enabled' };
  }
  if (scope.mode === 'optimize' && !scope.patches && !scope.checks.length) {
    return { decision: 'INCONCLUSIVE', reason: 'Comparable measured optimization adapter is not configured' };
  }

  // Mandatory Git Preflight BEFORE_PLANNING / BEFORE_WORKTREE
  const offlinePolicy = params.offlinePolicy ?? scope.offlinePolicy ?? 'allow';
  const preflight = await runGitPreflight(params.engine.projectRoot, {
    fetchRemote: true,
    fetchTimeoutMs: 5_000,
    offlinePolicy,
  });
  await params.store.put(`supervisor/git-preflight/${params.id}`, preflight);
  if (!preflight.ok) {
    return {
      decision: 'REJECTED',
      reason: preflight.blockedReason ?? 'BLOCKED_GIT_CONFLICT: Git preflight failed',
      evidence: { preflight },
    };
  }

  const key = 'supervisor/scopes/' + createHash('sha256').update(scopeText).digest('hex');
  const prior = await params.store.get(key);
  if (prior) {
    return {
      decision: 'INCONCLUSIVE',
      reason: 'Scope already attempted; inspect retained evidence and authorize a revised scope before retry',
    };
  }
  // Claim before any potentially mutating/external work; interrupted attempts are never replayed.
  await params.store.put(key, { attemptId: params.id, claimedAt: new Date().toISOString() });

  const timeoutMs = scope.timeoutMs ?? 120000;
  const manager = new WorktreeManager({ worktreeRootDir: path.join(params.directory, 'candidates') });
  if (!(await manager.isGitRepo(params.engine.projectRoot))) {
    throw new Error('Repair requires a Git repository');
  }
  const worktree = await manager.createWorktree(params.engine.projectRoot, `improve-${params.id}`);
  const ensuredBranch = await ensureAuthorizedCandidateBranch(worktree.worktreeDir, worktree.branch);
  worktree.branch = ensuredBranch.branch;
  await params.store.put(`supervisor/workspaces/${params.id}`, worktree);
  const cwd = worktree.worktreeDir;

  const git = async (args: string[]) => {
    const result = await boundedCommand('git', args, cwd, 10000, params.signal);
    if (result.exitCode !== 0) throw new Error('Candidate Git inspection failed');
    return result.output.trim();
  };

  const baseSha = await git(['rev-parse', 'HEAD']);
  const baselineRecord: GitBaselineRecord = {
    attemptId: params.id,
    repositoryRoot: preflight.repositoryRoot,
    worktreePath: cwd,
    branch: worktree.branch,
    baselineSha: baseSha,
    upstreamBranch: preflight.upstreamBranch,
    upstreamSha: preflight.upstreamSha,
    recordedAt: new Date().toISOString(),
    authorizedFiles: [...scope.files],
  };

  // Checkpoint: BEFORE_APPLYING_CHANGES
  const preApplyCheckpoint = await revalidateGitCheckpoint(baselineRecord, 'BEFORE_APPLYING_CHANGES', {
    offlinePolicy,
  });
  if (!preApplyCheckpoint.ok) {
    return {
      decision: 'REJECTED',
      reason: preApplyCheckpoint.actionTaken,
      evidence: { worktree, baseSha, preflight, checkpoint: preApplyCheckpoint },
    };
  }

  const runChecks = async () => {
    const results = [];
    for (const check of scope.checks) {
      results.push(await boundedCommand(check.command, check.args, cwd, Math.min(timeoutMs, 60000), params.signal));
    }
    return results;
  };

  const baseline = await runChecks();
  if (scope.mode === 'harden' && !baseline.some((result) => result.exitCode === 1)) {
    return {
      decision: 'INCONCLUSIVE',
      reason: 'Independent oracle did not reproduce the defect (expected exit 1)',
      evidence: {
        worktree,
        baseSha,
        baseline: baseline.map(({ output, ...result }) => result),
      },
    };
  }
  if (baseline.some((result) => ![0, 1].includes(result.exitCode))) {
    return {
      decision: 'INCONCLUSIVE',
      reason: 'Baseline infrastructure/check failed; repair not attempted',
    };
  }

  let agentExitCode = 0;
  if (scope.agent === 'scoped-patch' && scope.patches) {
    try {
      for (const patch of scope.patches) {
        if (!scope.files.includes(patch.file)) {
          throw new Error(`Patch target '${patch.file}' is outside authorized scope.files`);
        }
        const target = path.join(cwd, patch.file);
        const content = await fs.readFile(target, 'utf8');
        if (!content.includes(patch.oldString)) {
          throw new Error(`oldString not found in '${patch.file}'`);
        }
        await fs.writeFile(target, content.replace(patch.oldString, patch.newString), 'utf8');
      }
    } catch {
      agentExitCode = 1;
    }
  } else {
    const cliEntry = path.resolve(process.argv[1]);
    const args = [
      cliEntry,
      'task',
      'run',
      `${scope.mode.toUpperCase()} scoped repair. ${
        scope.mode === 'harden' ? 'Repair the reproduced defect; do not add features.' : scope.authorizedFeature ?? ''
      }\n${scope.prompt}\nOnly modify these source files: ${scope.files.join(
        ', ',
      )}. Preserve all independent tests and other files. Do not commit, merge, push, or alter Git metadata.`,
      '--type',
      'coding',
      '--agent',
      scope.agent,
      '--max-turns',
      String(scope.maxTurns ?? 8),
      '--json',
    ];
    if (scope.model) args.push('--model', scope.model);
    const agent = await boundedCommand(process.execPath, args, cwd, timeoutMs, params.signal);
    agentExitCode = agent.exitCode;
  }

  // Capture evidence before independent checks; narration or child exit 0 alone is insufficient.
  const changed = [
    ...new Set(
      (await git(['diff', '--name-only', baseSha]))
        .split('\n')
        .concat((await git(['ls-files', '--others', '--exclude-standard'])).split('\n')),
    ),
  ].filter(Boolean);

  if (!changed.length || changed.some((file) => !scope.files.includes(file))) {
    return {
      decision: 'REJECTED',
      reason: 'Repair changed no source or modified files outside the authorized scope',
      evidence: { worktree, baseSha, changed, agentExitCode },
    };
  }

  // Checkpoint: BEFORE_FINAL_VERIFICATION
  const preVerifyCheckpoint = await revalidateGitCheckpoint(baselineRecord, 'BEFORE_FINAL_VERIFICATION', {
    allowAuthorizedFileMutations: true,
    offlinePolicy,
  });
  if (!preVerifyCheckpoint.ok) {
    return {
      decision: 'REJECTED',
      reason: preVerifyCheckpoint.actionTaken,
      evidence: { worktree, baseSha, changed, agentExitCode, checkpoint: preVerifyCheckpoint },
    };
  }

  const fingerprint = await computeCandidateRevisionHash(cwd, scope.files);
  const candidate = await runChecks();
  const postVerifyFingerprint = await computeCandidateRevisionHash(cwd, scope.files);
  const stable = fingerprint === postVerifyFingerprint;
  const passed = agentExitCode === 0 && candidate.every((result) => result.exitCode === 0) && stable;

  // Scan candidate for secrets before allowing staging/review/commit
  const secretScan = await scanCandidateForSecrets(cwd, changed);
  if (!secretScan.clean) {
    return {
      decision: 'REJECTED',
      reason: `BLOCKED_SECRET_DETECTED: Candidate contains secrets or prohibited files (${secretScan.findings.map((f) => `${f.file}: ${f.reason}`).join('; ')})`,
      evidence: {
        worktree,
        baseSha,
        fingerprint,
        changed,
        agentExitCode,
        secretFindings: secretScan.findings,
      },
    };
  }

  // Resolve effective commit authorization policy
  const rawGrant: Partial<CommitAuthorizationGrant> | undefined =
    params.commitAuthorization ??
    scope.commitAuthorization ??
    (scope.commitPolicy
      ? {
          mode: scope.commitPolicy,
          source: 'trusted_config',
          authorizingIdentity: 'scope-config',
          scope: 'task',
          scopeTargetId: params.id,
          repositoryRoot: preflight.repositoryRoot,
        }
      : undefined);

  const effectiveAuth = resolveEffectiveCommitPolicy(rawGrant, {
    repositoryRoot: preflight.repositoryRoot,
    taskId: params.id,
    attemptId: params.id,
    branch: worktree.branch,
    worktreePath: cwd,
  });

  const benchmarksAndImprovements: string[] = [];
  if (scope.baselineMetrics && scope.candidateMetrics) {
    const baseTokens = (scope.baselineMetrics.inputTokens ?? 0) + (scope.baselineMetrics.outputTokens ?? 0);
    const candTokens = (scope.candidateMetrics.inputTokens ?? 0) + (scope.candidateMetrics.outputTokens ?? 0);
    const baseLatency = scope.baselineMetrics.latencyMs ?? 0;
    const candLatency = scope.candidateMetrics.latencyMs ?? 0;
    benchmarksAndImprovements.push(
      `Tokens: ${baseTokens} -> ${candTokens}, Latency: ${baseLatency}ms -> ${candLatency}ms`,
    );
  }

  const completionSummary = generateCompletionSummary({
    attemptId: params.id,
    originalGoal: scope.prompt,
    problemsIdentified: [`Scoped ${scope.mode.toUpperCase()} target in ${scope.files.join(', ')}`],
    changesImplemented: [`Modified ${changed.join(', ')} via ${scope.agent}`],
    filesModified: changed,
    testsExecuted: scope.checks.map((c, idx) => ({
      command: `${c.command} ${c.args.join(' ')}`,
      exitCode: candidate[idx]?.exitCode ?? 1,
      durationMs: candidate[idx]?.durationMs ?? 0,
    })),
    benchmarksAndImprovements,
    verifiedRevisionHash: passed ? postVerifyFingerprint : '',
    baseline: baselineRecord,
    candidateRevisionHash: postVerifyFingerprint,
    worktreeStatus: passed ? 'VERIFIED_ISOLATED_WORKTREE' : 'VERIFICATION_FAILED',
    remoteSyncStatus: preflight.remoteSyncStatus,
    commitAuthorization: effectiveAuth,
  });

  if (scope.mode === 'optimize') {
    if (!passed) {
      return {
        decision: 'REJECTED',
        reason: 'Optimization candidate rejected due to correctness regression',
        completionSummary,
        evidence: {
          worktree,
          baseSha,
          fingerprint,
          changed,
          agentExitCode,
          baselineMetrics: scope.baselineMetrics,
          candidateMetrics: scope.candidateMetrics,
          baseline: baseline.map(({ output, ...result }) => result),
          candidate: candidate.map(({ output, ...result }) => result),
          completionSummary,
        },
      };
    }
    if (scope.baselineMetrics && scope.candidateMetrics) {
      const baseTokens = (scope.baselineMetrics.inputTokens ?? 0) + (scope.baselineMetrics.outputTokens ?? 0);
      const candTokens = (scope.candidateMetrics.inputTokens ?? 0) + (scope.candidateMetrics.outputTokens ?? 0);
      const baseLatency = scope.baselineMetrics.latencyMs ?? 0;
      const candLatency = scope.candidateMetrics.latencyMs ?? 0;
      const tokensImproved = baseTokens > 0 && candTokens < baseTokens;
      const latencyImproved = baseLatency > 0 && candLatency < baseLatency;
      if (!tokensImproved && !latencyImproved) {
        return {
          decision: 'REJECTED',
          reason: 'Optimization candidate did not improve measured efficiency metrics',
          completionSummary,
          evidence: {
            worktree,
            baseSha,
            fingerprint,
            changed,
            agentExitCode,
            baselineMetrics: scope.baselineMetrics,
            candidateMetrics: scope.candidateMetrics,
            baseline: baseline.map(({ output, ...result }) => result),
            candidate: candidate.map(({ output, ...result }) => result),
            completionSummary,
          },
        };
      }
    }
    if (scope.configMutation?.autoPromote) {
      const activeCfg = params.engine.optimizer?.getActiveConfig?.() ?? { id: 'cfg-default' };
      await params.store.put(`meta/rollback/${params.id}`, activeCfg);
      const promotedCfg = {
        ...activeCfg,
        id: `cfg-${params.id}`,
        [scope.configMutation.key]: scope.configMutation.value,
      };
      await params.store.put('meta_optimizer/active_config', promotedCfg);
      return {
        decision: 'QUALIFIED',
        reason: 'Policy-authorized reversible config optimization qualified and promoted',
        completionSummary,
        evidence: {
          worktree,
          baseSha,
          fingerprint,
          changed,
          agentExitCode,
          promotedConfigId: promotedCfg.id,
          baselineMetrics: scope.baselineMetrics,
          candidateMetrics: scope.candidateMetrics,
          baseline: baseline.map(({ output, ...result }) => result),
          candidate: candidate.map(({ output, ...result }) => result),
          completionSummary,
        },
      };
    }
  }

  if (!passed) {
    return {
      decision: 'REJECTED',
      reason: 'Agent, independent verification, or revision stability failed',
      completionSummary,
      evidence: {
        worktree,
        baseSha,
        fingerprint,
        changed,
        agentExitCode,
        baseline: baseline.map(({ output, ...result }) => result),
        candidate: candidate.map(({ output, ...result }) => result),
        completionSummary,
      },
    };
  }

  // Persist durable candidate record and apply Commit Policy (MANUAL_COMMIT | AUTO_COMMIT | NO_COMMIT)
  const commitMessage = `${scope.mode === 'harden' ? 'fix' : scope.mode === 'optimize' ? 'perf' : 'feat'}(${scope.mode}): ${scope.prompt.split('\n')[0]!.slice(0, 72)}`;
  const nowIso = new Date().toISOString();
  const candidateRecord: DurableCandidateRecord = {
    attemptId: params.id,
    taskId: params.id,
    state:
      effectiveAuth.mode === 'NO_COMMIT'
        ? 'KEPT_UNCOMMITTED'
        : 'AWAITING_COMMIT_APPROVAL',
    baseline: baselineRecord,
    candidateRevisionHash: postVerifyFingerprint,
    verifiedRevisionHash: postVerifyFingerprint,
    intendedFiles: changed,
    commitMessage,
    commitAuthorization: effectiveAuth,
    completionSummary,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await params.store.put(`supervisor/git-candidates/${params.id}`, candidateRecord);

  let commitSha: string | undefined;
  let commitState = candidateRecord.state;

  if (effectiveAuth.mode === 'AUTO_COMMIT') {
    const commitRes = await executeVerifiedCandidateCommit({
      record: candidateRecord,
      store: params.store,
    });
    commitSha = commitRes.commitSha;
    commitState = commitRes.state;
    if (!commitRes.committed) {
      return {
        decision: 'REJECTED',
        reason: commitRes.reason,
        completionSummary,
        evidence: {
          worktree,
          baseSha,
          fingerprint,
          changed,
          agentExitCode,
          commitPolicyMode: effectiveAuth.mode,
          commitState,
          baseline: baseline.map(({ output, ...result }) => result),
          candidate: candidate.map(({ output, ...result }) => result),
          completionSummary,
        },
      };
    }
  }

  const baseReason =
    scope.mode === 'optimize'
      ? 'Optimization candidate passed independent checks and efficiency comparison; isolated candidate retained for review'
      : 'Real source repair passed independent checks; isolated candidate retained for review';

  const reasonSuffix =
    effectiveAuth.mode === 'AUTO_COMMIT' && commitSha
      ? ` (AUTO_COMMIT: ${commitSha.slice(0, 12)})`
      : effectiveAuth.mode === 'NO_COMMIT'
        ? ' (NO_COMMIT: preserved uncommitted in worktree)'
        : ' (MANUAL_COMMIT: awaiting user commit approval)';

  return {
    decision: 'STAGED',
    reason: `${baseReason}${reasonSuffix}`,
    commitSha,
    completionSummary,
    evidence: {
      worktree,
      baseSha,
      fingerprint,
      changed,
      agentExitCode,
      commitPolicyMode: effectiveAuth.mode,
      commitState,
      commitSha,
      approvalRequired: effectiveAuth.mode === 'MANUAL_COMMIT',
      approvalPrompt: completionSummary.commitDecision.approvalPrompt,
      baselineMetrics: scope.baselineMetrics,
      candidateMetrics: scope.candidateMetrics,
      baseline: baseline.map(({ output, ...result }) => result),
      candidate: candidate.map(({ output, ...result }) => result),
      completionSummary,
    },
  };
}
