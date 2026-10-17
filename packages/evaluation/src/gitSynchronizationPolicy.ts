import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { GIT_NO_HOOKS, type KeyValueStore } from '@wazir/shared';

const execFileAsync = promisify(execFile);

export type CommitPolicyMode = 'MANUAL_COMMIT' | 'AUTO_COMMIT' | 'NO_COMMIT';

export type CommitAuthorizationSource =
  | 'user_explicit'
  | 'trusted_config'
  | 'cli_flag'
  | 'default_fallback';

export type UntrustedAuthorizationSource =
  | 'previous_commit'
  | 'git_credentials'
  | 'git_remote'
  | 'agent_instruction'
  | 'readme'
  | 'source_comment'
  | 'untrusted_tool_output'
  | 'other_task';

export type CommitAuthorizationScope = 'task' | 'session' | 'project' | 'persistent';

export type CandidateLifecycleState =
  | 'IMPLEMENTING'
  | 'VERIFYING'
  | 'READY_FOR_REVIEW'
  | 'AWAITING_COMMIT_APPROVAL'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'KEPT_UNCOMMITTED'
  | 'DISCARDED'
  | 'CANCELLED'
  | 'BLOCKED_GIT_CONFLICT'
  | 'BLOCKED_SECRET_DETECTED'
  | 'BLOCKED_STALE_VERIFICATION'
  | 'COMMIT_FAILED';

export type ManualApprovalAction =
  | 'COMMIT'
  | 'REVISE'
  | 'KEEP_UNCOMMITTED'
  | 'DISCARD'
  | 'CANCEL';

export type GitCheckpointBoundary =
  | 'BEFORE_PLANNING'
  | 'BEFORE_WORKTREE'
  | 'BEFORE_APPLYING_CHANGES'
  | 'AFTER_AGENT_MODIFICATION'
  | 'BEFORE_FINAL_VERIFICATION'
  | 'BEFORE_COMMIT_APPROVAL_REQUEST'
  | 'BEFORE_STAGING_AND_COMMIT'
  | 'AFTER_INTERRUPTION_OR_RESTART';

export type RemoteTrackingState =
  | 'UP_TO_DATE'
  | 'AHEAD'
  | 'BEHIND'
  | 'DIVERGED'
  | 'NO_UPSTREAM'
  | 'REMOTE_UNAVAILABLE';

export type RemoteSyncStatus = 'SYNCED' | 'REMOTE_UNAVAILABLE' | 'NO_REMOTE' | 'SKIPPED';

export interface SeparatedPermissions {
  codeExecutionAuthorized: boolean;
  commitMode: CommitPolicyMode;
  commitAuthorized: boolean;
  pushAuthorized: boolean;
  mergeAuthorized: boolean;
  deploymentAuthorized: boolean;
}

export interface CommitAuthorizationGrant {
  mode: CommitPolicyMode;
  source: CommitAuthorizationSource | UntrustedAuthorizationSource | string;
  authorizingIdentity: string;
  scope: CommitAuthorizationScope;
  scopeTargetId?: string;
  authorizedAt: string;
  expiresAt?: string;
  repositoryRoot: string;
  allowedBranches?: string[];
  allowedWorktreePaths?: string[];
  boundCandidateRevision?: string;
  pushAuthorized?: boolean;
  mergeAuthorized?: boolean;
  deploymentAuthorized?: boolean;
}

export interface EffectiveCommitAuthorization {
  mode: CommitPolicyMode;
  source: CommitAuthorizationSource;
  authorizingIdentity: string;
  scope: CommitAuthorizationScope;
  scopeTargetId?: string;
  authorizedAt: string;
  expiresAt?: string;
  repositoryRoot: string;
  allowedBranches?: string[];
  allowedWorktreePaths?: string[];
  boundCandidateRevision?: string;
  permissions: SeparatedPermissions;
  downgradedReason?: string;
}

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
}

export interface GitRemoteEntry {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitPreflightReport {
  ok: boolean;
  repositoryRoot: string;
  currentBranch: string;
  detachedHead: boolean;
  headSha: string;
  upstreamBranch?: string;
  upstreamSha?: string;
  remoteTrackingState: RemoteTrackingState;
  modifiedFiles: string[];
  stagedFiles: string[];
  untrackedFiles: string[];
  unmergedFiles: string[];
  isDirty: boolean;
  hasConflicts: boolean;
  worktrees: GitWorktreeEntry[];
  improvementBranches: string[];
  remotes: GitRemoteEntry[];
  remoteSyncStatus: RemoteSyncStatus;
  remoteError?: string;
  activeSessions: string[];
  blockedReason?: string;
  inspectedAt: string;
}

export interface GitBaselineRecord {
  attemptId: string;
  repositoryRoot: string;
  worktreePath: string;
  branch: string;
  baselineSha: string;
  upstreamBranch?: string;
  upstreamSha?: string;
  recordedAt: string;
  authorizedFiles: string[];
}

export interface GitCheckpointValidationResult {
  ok: boolean;
  boundary: GitCheckpointBoundary;
  headSha: string;
  branch: string;
  detachedHead: boolean;
  headChanged: boolean;
  branchChanged: boolean;
  remoteAdvanced: boolean;
  hasConflicts: boolean;
  conflictingFiles: string[];
  independentFiles: string[];
  unexpectedStagedFiles: string[];
  requiresReverification: boolean;
  blockedStatus?: 'BLOCKED_GIT_CONFLICT' | 'BLOCKED_STALE_BASELINE' | 'REMOTE_UNAVAILABLE';
  actionTaken: string;
  checkedAt: string;
}

export interface ImprovementCompletionSummary {
  attemptId: string;
  generatedAt: string;
  summary: {
    originalGoal: string;
    problemsIdentified: string[];
    changesImplemented: string[];
    filesModified: string[];
    architectureChanges: string[];
  };
  verification: {
    testsExecuted: Array<{ command: string; exitCode: number; durationMs: number }>;
    passedChecks: string[];
    failedChecks: string[];
    benchmarksAndImprovements: string[];
    edgeCasesTested: string[];
    remainingLimitations: string[];
    allPassed: boolean;
    verifiedAt: string;
    verifiedRevisionHash: string;
  };
  gitStatus: {
    repository: string;
    branch: string;
    baselineSha: string;
    candidateRevisionHash: string;
    changedFiles: string[];
    worktreePath: string;
    worktreeStatus: string;
    remoteSyncStatus: RemoteSyncStatus;
  };
  commitDecision: {
    effectiveCommitMode: CommitPolicyMode;
    authorizationSource: CommitAuthorizationSource;
    authorizationScope: CommitAuthorizationScope;
    qualifiesForCommit: boolean;
    userApprovalRequired: boolean;
    approvalPrompt?: string;
    permissions: SeparatedPermissions;
  };
}

export interface DurableCandidateRecord {
  attemptId: string;
  taskId?: string;
  state: CandidateLifecycleState;
  baseline: GitBaselineRecord;
  candidateRevisionHash: string;
  verifiedRevisionHash?: string;
  intendedFiles: string[];
  commitMessage: string;
  commitAuthorization: EffectiveCommitAuthorization;
  completionSummary: ImprovementCompletionSummary;
  commitSha?: string;
  committedAt?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommitExecutionResult {
  committed: boolean;
  state: CandidateLifecycleState;
  commitSha?: string;
  candidateRevisionHash: string;
  filesCommitted: string[];
  reason: string;
  reconciledFromPriorCommit?: boolean;
  completionSummary: ImprovementCompletionSummary;
}

export const MANUAL_APPROVAL_PROMPT =
  'Implementation and verification are complete. Would you like me to commit these changes?';

const TRUSTED_SOURCES = new Set<CommitAuthorizationSource>([
  'user_explicit',
  'trusted_config',
  'cli_flag',
  'default_fallback',
]);

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'OpenAI/API Secret Key', regex: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'GitHub Personal Access Token', regex: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/ },
  { name: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private Key Block', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Generic Secret Assignment', regex: /(?:api[_-]?key|secret[_-]?key|private[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-/.+=]{16,}['"]/i },
];

const PROHIBITED_FILENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
]);

async function runGitCommand(
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; allowHooks?: boolean } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const gitArgs = options.allowHooks ? args : [...GIT_NO_HOOKS, ...args];
  try {
    const { stdout, stderr } = await execFileAsync('git', gitArgs, {
      cwd,
      timeout: options.timeoutMs ?? 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
    return { ok: true, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: 0 };
  } catch (err: any) {
    const stdout = typeof err?.stdout === 'string' ? err.stdout.trimEnd() : '';
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trimEnd() : err instanceof Error ? err.message : String(err);
    const exitCode = typeof err?.code === 'number' ? err.code : 1;
    return { ok: false, stdout, stderr, exitCode };
  }
}

/**
 * Resolves the effective commit authorization mode and enforces strict separation
 * between execution, commit, push, merge, and deployment permissions.
 *
 * Never infers AUTO_COMMIT from previous commits, git credentials, git remotes,
 * agent instructions, READMEs, comments, untrusted tool output, or another task.
 */
export function resolveEffectiveCommitPolicy(
  grant: Partial<CommitAuthorizationGrant> | undefined,
  context: {
    repositoryRoot: string;
    taskId?: string;
    attemptId?: string;
    sessionId?: string;
    branch?: string;
    worktreePath?: string;
    now?: number;
  },
): EffectiveCommitAuthorization {
  const nowMs = context.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const normalizedRepo = path.resolve(context.repositoryRoot);

  const fallback = (reason?: string): EffectiveCommitAuthorization => ({
    mode: 'MANUAL_COMMIT',
    source: 'default_fallback',
    authorizingIdentity: 'system-default',
    scope: 'task',
    authorizedAt: nowIso,
    repositoryRoot: normalizedRepo,
    permissions: {
      codeExecutionAuthorized: true,
      commitMode: 'MANUAL_COMMIT',
      commitAuthorized: false,
      pushAuthorized: false,
      mergeAuthorized: false,
      deploymentAuthorized: false,
    },
    downgradedReason: reason,
  });

  if (!grant || !grant.mode) {
    return fallback();
  }

  if (grant.mode === 'NO_COMMIT') {
    return {
      mode: 'NO_COMMIT',
      source: TRUSTED_SOURCES.has(grant.source as CommitAuthorizationSource)
        ? (grant.source as CommitAuthorizationSource)
        : 'default_fallback',
      authorizingIdentity: grant.authorizingIdentity || 'operator',
      scope: grant.scope ?? 'task',
      scopeTargetId: grant.scopeTargetId,
      authorizedAt: grant.authorizedAt ?? nowIso,
      expiresAt: grant.expiresAt,
      repositoryRoot: normalizedRepo,
      permissions: {
        codeExecutionAuthorized: true,
        commitMode: 'NO_COMMIT',
        commitAuthorized: false,
        pushAuthorized: false,
        mergeAuthorized: false,
        deploymentAuthorized: false,
      },
    };
  }

  if (grant.mode === 'MANUAL_COMMIT') {
    return {
      mode: 'MANUAL_COMMIT',
      source: TRUSTED_SOURCES.has(grant.source as CommitAuthorizationSource)
        ? (grant.source as CommitAuthorizationSource)
        : 'default_fallback',
      authorizingIdentity: grant.authorizingIdentity || 'operator',
      scope: grant.scope ?? 'task',
      scopeTargetId: grant.scopeTargetId,
      authorizedAt: grant.authorizedAt ?? nowIso,
      expiresAt: grant.expiresAt,
      repositoryRoot: normalizedRepo,
      boundCandidateRevision: grant.boundCandidateRevision,
      permissions: {
        codeExecutionAuthorized: true,
        commitMode: 'MANUAL_COMMIT',
        commitAuthorized: Boolean(grant.boundCandidateRevision),
        pushAuthorized: false,
        mergeAuthorized: false,
        deploymentAuthorized: false,
      },
    };
  }

  // Validate AUTO_COMMIT strictly
  if (!grant.source || !TRUSTED_SOURCES.has(grant.source as CommitAuthorizationSource) || grant.source === 'default_fallback') {
    return fallback(`Untrusted or implicit commit authorization source '${grant.source ?? 'unknown'}' cannot enable AUTO_COMMIT`);
  }

  if (!grant.authorizingIdentity || !grant.authorizingIdentity.trim()) {
    return fallback('Missing authorizing identity for AUTO_COMMIT');
  }

  if (grant.repositoryRoot && path.resolve(grant.repositoryRoot) !== normalizedRepo) {
    return fallback(`Commit authorization repository mismatch (${grant.repositoryRoot} !== ${normalizedRepo})`);
  }

  if (grant.expiresAt) {
    const expMs = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expMs) || expMs <= nowMs) {
      return fallback('COMMIT_AUTHORIZATION_EXPIRED');
    }
  }

  if (grant.scope === 'task') {
    const currentTargets = [context.taskId, context.attemptId].filter(Boolean);
    if (!grant.scopeTargetId || !currentTargets.includes(grant.scopeTargetId)) {
      return fallback(
        `Task-scoped AUTO_COMMIT authorization for '${grant.scopeTargetId ?? 'unspecified'}' does not apply to current task '${context.taskId ?? context.attemptId ?? 'unknown'}'`,
      );
    }
  }

  if (grant.scope === 'session' && grant.scopeTargetId && context.sessionId && grant.scopeTargetId !== context.sessionId) {
    return fallback(`Session-scoped AUTO_COMMIT authorization for '${grant.scopeTargetId}' does not match session '${context.sessionId}'`);
  }

  if (grant.allowedBranches && grant.allowedBranches.length > 0 && context.branch) {
    if (!grant.allowedBranches.includes(context.branch)) {
      return fallback(`Branch '${context.branch}' is outside allowedBranches (${grant.allowedBranches.join(', ')})`);
    }
  }

  if (grant.allowedWorktreePaths && grant.allowedWorktreePaths.length > 0 && context.worktreePath) {
    const resolvedWt = path.resolve(context.worktreePath);
    const allowed = grant.allowedWorktreePaths.some((p) => path.resolve(p) === resolvedWt);
    if (!allowed) {
      return fallback(`Worktree '${resolvedWt}' is outside allowedWorktreePaths`);
    }
  }

  return {
    mode: 'AUTO_COMMIT',
    source: grant.source as CommitAuthorizationSource,
    authorizingIdentity: grant.authorizingIdentity,
    scope: grant.scope ?? 'task',
    scopeTargetId: grant.scopeTargetId,
    authorizedAt: grant.authorizedAt ?? nowIso,
    expiresAt: grant.expiresAt,
    repositoryRoot: normalizedRepo,
    allowedBranches: grant.allowedBranches,
    allowedWorktreePaths: grant.allowedWorktreePaths,
    // AUTO_COMMIT never implies push, merge, or deployment authorization!
    permissions: {
      codeExecutionAuthorized: true,
      commitMode: 'AUTO_COMMIT',
      commitAuthorized: true,
      pushAuthorized: false,
      mergeAuthorized: false,
      deploymentAuthorized: false,
    },
  };
}

export function parseWorktreeListPorcelain(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  const blocks = output.trim().split(/\n\n+/).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    let wtPath = '';
    let head = '';
    let branch: string | undefined;
    let bare = false;
    let detached = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        branch = ref.replace(/^refs\/heads\//, '');
      } else if (line === 'bare') {
        bare = true;
      } else if (line === 'detached') {
        detached = true;
      }
    }
    if (wtPath) {
      entries.push({ path: wtPath, head, branch, bare, detached });
    }
  }
  return entries;
}

export function parseStatusPorcelainV1(output: string): {
  modifiedFiles: string[];
  stagedFiles: string[];
  untrackedFiles: string[];
  unmergedFiles: string[];
} {
  const modifiedFiles: string[] = [];
  const stagedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  const unmergedFiles: string[] = [];

  const conflictCodes = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
  const lines = output.split('\n').filter((line) => line.length >= 3);
  for (const line of lines) {
    const xy = line.slice(0, 2);
    const x = xy[0]!;
    const y = xy[1]!;
    const rawFile = line.slice(3).trim();
    const file = rawFile.includes(' -> ') ? rawFile.split(' -> ').pop()!.trim() : rawFile;

    if (conflictCodes.has(xy) || x === 'U' || y === 'U') {
      unmergedFiles.push(file);
      continue;
    }
    if (xy === '??') {
      untrackedFiles.push(file);
      continue;
    }
    if (x !== ' ' && x !== '?') {
      stagedFiles.push(file);
    }
    if (y !== ' ' && y !== '?') {
      modifiedFiles.push(file);
    }
  }

  return {
    modifiedFiles: [...new Set(modifiedFiles)],
    stagedFiles: [...new Set(stagedFiles)],
    untrackedFiles: [...new Set(untrackedFiles)],
    unmergedFiles: [...new Set(unmergedFiles)],
  };
}

export function parseGitRemotes(output: string): GitRemoteEntry[] {
  const map = new Map<string, GitRemoteEntry>();
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, kind] = match;
    const existing = map.get(name!) ?? { name: name!, fetchUrl: url!, pushUrl: url! };
    if (kind === 'fetch') existing.fetchUrl = url!;
    if (kind === 'push') existing.pushUrl = url!;
    map.set(name!, existing);
  }
  return [...map.values()];
}

/**
 * Mandatory Git Preflight Inspection (Section 2).
 *
 * Runs:
 * - git rev-parse --show-toplevel
 * - git branch --show-current
 * - git rev-parse HEAD
 * - git status --porcelain=v1
 * - git worktree list --porcelain
 * - git remote -v
 * - git fetch --prune origin (bounded by timeout when origin is configured)
 */
export async function runGitPreflight(
  projectRoot: string,
  options: {
    fetchRemote?: boolean;
    fetchTimeoutMs?: number;
    offlinePolicy?: 'allow' | 'block';
    activeSessions?: string[];
  } = {},
): Promise<GitPreflightReport> {
  const inspectedAt = new Date().toISOString();
  const topLevelRes = await runGitCommand(['rev-parse', '--show-toplevel'], projectRoot);
  if (!topLevelRes.ok || !topLevelRes.stdout.trim()) {
    throw new Error(`LOCAL_GIT_ERROR: Not a valid Git repository at '${projectRoot}': ${topLevelRes.stderr}`);
  }
  const repositoryRoot = topLevelRes.stdout.trim();

  const branchRes = await runGitCommand(['branch', '--show-current'], repositoryRoot);
  if (!branchRes.ok) {
    throw new Error(`LOCAL_GIT_ERROR: Failed to inspect current branch: ${branchRes.stderr}`);
  }
  const currentBranch = branchRes.stdout.trim();
  const detachedHead = currentBranch.length === 0;

  const headRes = await runGitCommand(['rev-parse', 'HEAD'], repositoryRoot);
  if (!headRes.ok || !headRes.stdout.trim()) {
    throw new Error(`LOCAL_GIT_ERROR: Failed to resolve HEAD SHA: ${headRes.stderr}`);
  }
  const headSha = headRes.stdout.trim();

  const statusRes = await runGitCommand(['status', '--porcelain=v1'], repositoryRoot);
  if (!statusRes.ok) {
    throw new Error(`LOCAL_GIT_ERROR: Failed to inspect working tree status: ${statusRes.stderr}`);
  }
  const { modifiedFiles, stagedFiles, untrackedFiles, unmergedFiles } = parseStatusPorcelainV1(statusRes.stdout);

  const worktreeRes = await runGitCommand(['worktree', 'list', '--porcelain'], repositoryRoot);
  if (!worktreeRes.ok) {
    throw new Error(`LOCAL_GIT_ERROR: Failed to list worktrees: ${worktreeRes.stderr}`);
  }
  const worktrees = parseWorktreeListPorcelain(worktreeRes.stdout);

  const remoteRes = await runGitCommand(['remote', '-v'], repositoryRoot);
  if (!remoteRes.ok) {
    throw new Error(`LOCAL_GIT_ERROR: Failed to inspect remotes: ${remoteRes.stderr}`);
  }
  const remotes = parseGitRemotes(remoteRes.stdout);

  const branchesRes = await runGitCommand(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], repositoryRoot);
  const allBranches = branchesRes.ok ? branchesRes.stdout.split('\n').map((b) => b.trim()).filter(Boolean) : [];
  const improvementBranches = allBranches.filter(
    (b) => b.startsWith('wazir/') || b.startsWith('improve') || b.includes('self-improvement'),
  );

  let remoteSyncStatus: RemoteSyncStatus = 'NO_REMOTE';
  let remoteError: string | undefined;
  const hasOrigin = remotes.some((r) => r.name === 'origin');

  if (hasOrigin) {
    if (options.fetchRemote === false) {
      remoteSyncStatus = 'SKIPPED';
    } else {
      const fetchRes = await runGitCommand(['fetch', '--prune', 'origin'], repositoryRoot, {
        timeoutMs: options.fetchTimeoutMs ?? 10_000,
      });
      if (fetchRes.ok) {
        remoteSyncStatus = 'SYNCED';
      } else {
        remoteSyncStatus = 'REMOTE_UNAVAILABLE';
        remoteError = fetchRes.stderr || 'Failed to fetch origin';
      }
    }
  }

  let upstreamBranch: string | undefined;
  let upstreamSha: string | undefined;
  let remoteTrackingState: RemoteTrackingState = 'NO_UPSTREAM';

  if (remoteSyncStatus === 'REMOTE_UNAVAILABLE') {
    remoteTrackingState = 'REMOTE_UNAVAILABLE';
  } else if (!detachedHead) {
    const upRes = await runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repositoryRoot);
    if (upRes.ok && upRes.stdout.trim()) {
      upstreamBranch = upRes.stdout.trim();
      const upShaRes = await runGitCommand(['rev-parse', upstreamBranch], repositoryRoot);
      if (upShaRes.ok && upShaRes.stdout.trim()) {
        upstreamSha = upShaRes.stdout.trim();
        const countsRes = await runGitCommand(['rev-list', '--left-right', '--count', `${headSha}...${upstreamSha}`], repositoryRoot);
        if (countsRes.ok) {
          const [aheadStr, behindStr] = countsRes.stdout.trim().split(/\s+/);
          const ahead = Number(aheadStr ?? 0);
          const behind = Number(behindStr ?? 0);
          if (ahead === 0 && behind === 0) remoteTrackingState = 'UP_TO_DATE';
          else if (ahead > 0 && behind === 0) remoteTrackingState = 'AHEAD';
          else if (ahead === 0 && behind > 0) remoteTrackingState = 'BEHIND';
          else remoteTrackingState = 'DIVERGED';
        }
      }
    }
  }

  const hasConflicts = unmergedFiles.length > 0;
  const isDirty = modifiedFiles.length > 0 || stagedFiles.length > 0 || untrackedFiles.length > 0 || hasConflicts;

  let blockedReason: string | undefined;
  if (hasConflicts) {
    blockedReason = 'BLOCKED_GIT_CONFLICT: Working tree has unresolved merge conflicts';
  } else if (remoteSyncStatus === 'REMOTE_UNAVAILABLE' && options.offlinePolicy === 'block') {
    blockedReason = `REMOTE_UNAVAILABLE: Offline policy blocks execution when remote is unreachable (${remoteError ?? 'fetch failed'})`;
  }

  return {
    ok: !blockedReason,
    repositoryRoot,
    currentBranch,
    detachedHead,
    headSha,
    upstreamBranch,
    upstreamSha,
    remoteTrackingState,
    modifiedFiles,
    stagedFiles,
    untrackedFiles,
    unmergedFiles,
    isDirty,
    hasConflicts,
    worktrees,
    improvementBranches,
    remotes,
    remoteSyncStatus,
    remoteError,
    activeSessions: options.activeSessions ?? [],
    blockedReason,
    inspectedAt,
  };
}

/**
 * Ensures an authorized candidate branch is checked out if the worktree is in detached HEAD state.
 */
export async function ensureAuthorizedCandidateBranch(
  worktreeDir: string,
  candidateBranchName: string,
): Promise<{ branch: string; createdFromDetachedHead: boolean }> {
  const branchRes = await runGitCommand(['branch', '--show-current'], worktreeDir);
  if (branchRes.ok && branchRes.stdout.trim().length > 0) {
    return { branch: branchRes.stdout.trim(), createdFromDetachedHead: false };
  }
  const safeBranch = candidateBranchName.startsWith('wazir/')
    ? candidateBranchName
    : `wazir/${candidateBranchName}`;
  const checkoutRes = await runGitCommand(['checkout', '-B', safeBranch], worktreeDir);
  if (!checkoutRes.ok) {
    throw new Error(`Failed to create authorized candidate branch '${safeBranch}' from detached HEAD: ${checkoutRes.stderr}`);
  }
  return { branch: safeBranch, createdFromDetachedHead: true };
}

/**
 * Revalidates Git state at execution checkpoints (Section 3).
 */
export async function revalidateGitCheckpoint(
  baseline: GitBaselineRecord,
  boundary: GitCheckpointBoundary,
  options: {
    fetchRemote?: boolean;
    fetchTimeoutMs?: number;
    offlinePolicy?: 'allow' | 'block';
    allowAuthorizedFileMutations?: boolean;
  } = {},
): Promise<GitCheckpointValidationResult> {
  const checkedAt = new Date().toISOString();
  const targetDir = existsSync(baseline.worktreePath) ? baseline.worktreePath : baseline.repositoryRoot;

  const preflight = await runGitPreflight(targetDir, {
    fetchRemote: options.fetchRemote ?? false,
    fetchTimeoutMs: options.fetchTimeoutMs,
    offlinePolicy: options.offlinePolicy,
  });

  const headChanged = preflight.headSha !== baseline.baselineSha;
  const branchChanged = !preflight.detachedHead && preflight.currentBranch !== baseline.branch;
  const remoteAdvanced = Boolean(
    baseline.upstreamSha &&
      preflight.upstreamSha &&
      preflight.upstreamSha !== baseline.upstreamSha,
  );

  const authorizedSet = new Set(baseline.authorizedFiles);
  const allWorkingChanges = [...new Set([...preflight.modifiedFiles, ...preflight.untrackedFiles])];
  const conflictingFiles = allWorkingChanges.filter((f) => !authorizedSet.has(f));
  const independentFiles = allWorkingChanges.filter((f) => authorizedSet.has(f));

  // Detect files staged in the index before Wazir's own staging step
  const unexpectedStagedFiles =
    boundary === 'BEFORE_STAGING_AND_COMMIT' || boundary === 'BEFORE_COMMIT_APPROVAL_REQUEST'
      ? preflight.stagedFiles.filter((f) => !authorizedSet.has(f))
      : preflight.stagedFiles;

  let blockedStatus: GitCheckpointValidationResult['blockedStatus'];
  let actionTaken = 'Git checkpoint validated cleanly';
  let requiresReverification = false;

  if (preflight.hasConflicts) {
    blockedStatus = 'BLOCKED_GIT_CONFLICT';
    actionTaken = `Stopped mutations: unresolved merge conflicts in ${preflight.unmergedFiles.join(', ')}`;
  } else if (preflight.blockedReason?.startsWith('REMOTE_UNAVAILABLE')) {
    blockedStatus = 'REMOTE_UNAVAILABLE';
    actionTaken = preflight.blockedReason;
  } else if (headChanged || branchChanged) {
    blockedStatus = 'BLOCKED_STALE_BASELINE';
    requiresReverification = true;
    actionTaken = `Stopped mutations: baseline ${baseline.baselineSha.slice(0, 8)} (${baseline.branch}) changed to ${preflight.headSha.slice(0, 8)} (${preflight.currentBranch || 'DETACHED'})`;
  } else if (unexpectedStagedFiles.length > 0) {
    blockedStatus = 'BLOCKED_GIT_CONFLICT';
    requiresReverification = true;
    actionTaken = `Detected unexpected staged files in index (${unexpectedStagedFiles.join(', ')}); refusing to include unrelated staged files`;
  } else if (!options.allowAuthorizedFileMutations && conflictingFiles.length > 0 && targetDir === baseline.worktreePath) {
    blockedStatus = 'BLOCKED_GIT_CONFLICT';
    requiresReverification = true;
    actionTaken = `Detected unauthorized file modifications in candidate worktree (${conflictingFiles.join(', ')})`;
  } else if (remoteAdvanced) {
    requiresReverification = true;
    actionTaken = `Remote upstream advanced from ${baseline.upstreamSha?.slice(0, 8)} to ${preflight.upstreamSha?.slice(0, 8)}; re-verification required`;
  }

  return {
    ok: !blockedStatus,
    boundary,
    headSha: preflight.headSha,
    branch: preflight.currentBranch,
    detachedHead: preflight.detachedHead,
    headChanged,
    branchChanged,
    remoteAdvanced,
    hasConflicts: preflight.hasConflicts,
    conflictingFiles,
    independentFiles,
    unexpectedStagedFiles,
    requiresReverification,
    blockedStatus,
    actionTaken,
    checkedAt,
  };
}

/**
 * Computes a deterministic SHA-256 revision hash over the worktree HEAD SHA and the exact
 * content of each intended candidate file. Any post-verification or post-review file edit
 * changes this hash and invalidates stale verification/approval.
 */
export async function computeCandidateRevisionHash(
  worktreeDir: string,
  intendedFiles: string[],
): Promise<string> {
  const headRes = await runGitCommand(['rev-parse', 'HEAD'], worktreeDir);
  const headSha = headRes.ok ? headRes.stdout.trim() : 'unknown-head';
  const hash = createHash('sha256');
  hash.update(`head:${headSha}\n`);

  const sortedFiles = [...intendedFiles].sort();
  for (const relFile of sortedFiles) {
    const absPath = path.join(worktreeDir, relFile);
    try {
      const stat = await fs.lstat(absPath);
      if (stat.isFile()) {
        const content = await fs.readFile(absPath);
        hash.update(`file:${relFile}:${content.length}:`);
        hash.update(content);
        hash.update('\n');
      } else {
        hash.update(`nonfile:${relFile}\n`);
      }
    } catch {
      hash.update(`missing:${relFile}\n`);
    }
  }
  return hash.digest('hex');
}

/**
 * Scans candidate files for accidentally introduced secrets or prohibited credential files.
 */
export async function scanCandidateForSecrets(
  worktreeDir: string,
  files: string[],
): Promise<{ clean: boolean; findings: Array<{ file: string; reason: string }> }> {
  const findings: Array<{ file: string; reason: string }> = [];

  for (const relFile of files) {
    const base = path.basename(relFile);
    if (PROHIBITED_FILENAMES.has(base) || base.endsWith('.pem') || base.endsWith('.key')) {
      findings.push({ file: relFile, reason: `Prohibited credential/secret file '${base}'` });
      continue;
    }
    const absPath = path.join(worktreeDir, relFile);
    try {
      const content = await fs.readFile(absPath, 'utf8');
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(content)) {
          findings.push({ file: relFile, reason: `Matched ${pattern.name}` });
        }
      }
    } catch {
      // ignore missing/deleted file
    }
  }

  return {
    clean: findings.length === 0,
    findings,
  };
}

/**
 * Builds the mandatory Completion Summary before committing or requesting commit approval (Section 7).
 */
export function generateCompletionSummary(params: {
  attemptId: string;
  originalGoal: string;
  problemsIdentified: string[];
  changesImplemented: string[];
  filesModified: string[];
  architectureChanges?: string[];
  testsExecuted: Array<{ command: string; exitCode: number; durationMs: number }>;
  benchmarksAndImprovements?: string[];
  edgeCasesTested?: string[];
  remainingLimitations?: string[];
  verifiedRevisionHash: string;
  verifiedAt?: string;
  baseline: GitBaselineRecord;
  candidateRevisionHash: string;
  worktreeStatus: string;
  remoteSyncStatus: RemoteSyncStatus;
  commitAuthorization: EffectiveCommitAuthorization;
}): ImprovementCompletionSummary {
  const passedChecks = params.testsExecuted.filter((t) => t.exitCode === 0).map((t) => t.command);
  const failedChecks = params.testsExecuted.filter((t) => t.exitCode !== 0).map((t) => `${t.command} (exit ${t.exitCode})`);
  const allPassed =
    params.testsExecuted.length > 0 &&
    failedChecks.length === 0 &&
    params.filesModified.length > 0 &&
    params.verifiedRevisionHash === params.candidateRevisionHash;

  const userApprovalRequired = params.commitAuthorization.mode === 'MANUAL_COMMIT';
  const qualifiesForCommit =
    allPassed &&
    params.commitAuthorization.mode !== 'NO_COMMIT' &&
    params.filesModified.every((f) => params.baseline.authorizedFiles.includes(f));

  return {
    attemptId: params.attemptId,
    generatedAt: new Date().toISOString(),
    summary: {
      originalGoal: params.originalGoal,
      problemsIdentified: params.problemsIdentified,
      changesImplemented: params.changesImplemented,
      filesModified: params.filesModified,
      architectureChanges: params.architectureChanges ?? [],
    },
    verification: {
      testsExecuted: params.testsExecuted,
      passedChecks,
      failedChecks,
      benchmarksAndImprovements: params.benchmarksAndImprovements ?? [],
      edgeCasesTested: params.edgeCasesTested ?? [],
      remainingLimitations: params.remainingLimitations ?? [],
      allPassed,
      verifiedAt: params.verifiedAt ?? new Date().toISOString(),
      verifiedRevisionHash: params.verifiedRevisionHash,
    },
    gitStatus: {
      repository: params.baseline.repositoryRoot,
      branch: params.baseline.branch,
      baselineSha: params.baseline.baselineSha,
      candidateRevisionHash: params.candidateRevisionHash,
      changedFiles: params.filesModified,
      worktreePath: params.baseline.worktreePath,
      worktreeStatus: params.worktreeStatus,
      remoteSyncStatus: params.remoteSyncStatus,
    },
    commitDecision: {
      effectiveCommitMode: params.commitAuthorization.mode,
      authorizationSource: params.commitAuthorization.source,
      authorizationScope: params.commitAuthorization.scope,
      qualifiesForCommit,
      userApprovalRequired,
      approvalPrompt: userApprovalRequired && qualifiesForCommit ? MANUAL_APPROVAL_PROMPT : undefined,
      permissions: params.commitAuthorization.permissions,
    },
  };
}

export function formatCompletionSummaryReport(report: ImprovementCompletionSummary): string {
  const lines = [
    '=======================================================',
    `WAZIR SELF-IMPROVEMENT COMPLETION SUMMARY (${report.attemptId})`,
    '=======================================================',
    '### Summary',
    `- Original goal:        ${report.summary.originalGoal}`,
    `- Problems identified:  ${report.summary.problemsIdentified.join('; ') || 'None'}`,
    `- Changes implemented:  ${report.summary.changesImplemented.join('; ') || 'None'}`,
    `- Files modified:       ${report.summary.filesModified.join(', ') || 'None'}`,
    `- Architecture changes: ${report.summary.architectureChanges.join('; ') || 'None'}`,
    '',
    '### Verification',
    `- Tests executed:       ${report.verification.testsExecuted.length}`,
    `- Passed checks:        ${report.verification.passedChecks.join(', ') || 'None'}`,
    `- Failed checks:        ${report.verification.failedChecks.join(', ') || 'None'}`,
    `- Benchmarks/Metrics:   ${report.verification.benchmarksAndImprovements.join('; ') || 'N/A'}`,
    `- Edge cases tested:    ${report.verification.edgeCasesTested.join('; ') || 'Standard oracle suite'}`,
    `- Remaining limits:     ${report.verification.remainingLimitations.join('; ') || 'None'}`,
    `- Verified revision:    ${report.verification.verifiedRevisionHash.slice(0, 16)}`,
    '',
    '### Git status',
    `- Repository:           ${report.gitStatus.repository}`,
    `- Branch:               ${report.gitStatus.branch}`,
    `- Baseline SHA:         ${report.gitStatus.baselineSha}`,
    `- Candidate revision:   ${report.gitStatus.candidateRevisionHash.slice(0, 16)}`,
    `- Changed files:        ${report.gitStatus.changedFiles.join(', ') || 'None'}`,
    `- Worktree status:      ${report.gitStatus.worktreeStatus} (${report.gitStatus.worktreePath})`,
    `- Remote sync status:   ${report.gitStatus.remoteSyncStatus}`,
    '',
    '### Commit decision',
    `- Effective mode:       ${report.commitDecision.effectiveCommitMode}`,
    `- Auth source/scope:    ${report.commitDecision.authorizationSource} (${report.commitDecision.authorizationScope})`,
    `- Qualifies for commit: ${report.commitDecision.qualifiesForCommit ? 'YES' : 'NO'}`,
    `- Approval required:    ${report.commitDecision.userApprovalRequired ? 'YES' : 'NO'}`,
    `- Separated perms:      exec=${report.commitDecision.permissions.codeExecutionAuthorized} commit=${report.commitDecision.permissions.commitAuthorized} push=${report.commitDecision.permissions.pushAuthorized} merge=${report.commitDecision.permissions.mergeAuthorized} deploy=${report.commitDecision.permissions.deploymentAuthorized}`,
  ];
  if (report.commitDecision.approvalPrompt) {
    lines.push('', report.commitDecision.approvalPrompt);
  }
  lines.push('=======================================================');
  return lines.join('\n');
}

/**
 * Executes isolated staging, secret scanning, and hook-enabled Git commit for a verified candidate
 * (Sections 8 & 9).
 */
export async function executeVerifiedCandidateCommit(params: {
  record: DurableCandidateRecord;
  store: KeyValueStore;
  approvedRevisionHash?: string;
}): Promise<CommitExecutionResult> {
  const { record, store } = params;
  const worktreeDir = record.baseline.worktreePath;

  const saveRecord = async (next: DurableCandidateRecord) => {
    next.updatedAt = new Date().toISOString();
    await store.put(`supervisor/git-candidates/${next.attemptId}`, next);
  };

  // 1. Ensure candidate has actual changes (no-op check)
  if (!record.intendedFiles.length) {
    return {
      committed: false,
      state: record.state,
      candidateRevisionHash: record.candidateRevisionHash,
      filesCommitted: [],
      reason: 'NO_CHANGES: No files were modified; refusing to create an empty commit',
      completionSummary: record.completionSummary,
    };
  }

  // 2. Ensure detached HEAD is resolved to an authorized candidate branch before committing
  if (existsSync(worktreeDir)) {
    const ensured = await ensureAuthorizedCandidateBranch(worktreeDir, record.baseline.branch || `improve-${record.attemptId}`);
    record.baseline.branch = ensured.branch;
  }

  // 3. Revalidate candidate revision hash and verification freshness
  const currentRevisionHash = await computeCandidateRevisionHash(worktreeDir, record.intendedFiles);
  if (
    !record.verifiedRevisionHash ||
    currentRevisionHash !== record.verifiedRevisionHash ||
    currentRevisionHash !== record.candidateRevisionHash
  ) {
    record.state = 'BLOCKED_STALE_VERIFICATION';
    record.failureReason = 'STALE_VERIFICATION: Candidate files changed after verification; re-verification required before commit';
    await saveRecord(record);
    return {
      committed: false,
      state: record.state,
      candidateRevisionHash: currentRevisionHash,
      filesCommitted: [],
      reason: record.failureReason,
      completionSummary: record.completionSummary,
    };
  }

  if (params.approvedRevisionHash && params.approvedRevisionHash !== currentRevisionHash) {
    record.state = 'BLOCKED_STALE_VERIFICATION';
    record.failureReason = `STALE_APPROVAL: Approved revision '${params.approvedRevisionHash.slice(0, 12)}' does not match current candidate revision '${currentRevisionHash.slice(0, 12)}'`;
    await saveRecord(record);
    return {
      committed: false,
      state: record.state,
      candidateRevisionHash: currentRevisionHash,
      filesCommitted: [],
      reason: record.failureReason,
      completionSummary: record.completionSummary,
    };
  }

  if (!record.completionSummary.verification.allPassed) {
    record.state = 'BLOCKED_STALE_VERIFICATION';
    record.failureReason = 'UNVERIFIED_CANDIDATE: Verification checks did not pass';
    await saveRecord(record);
    return {
      committed: false,
      state: record.state,
      candidateRevisionHash: currentRevisionHash,
      filesCommitted: [],
      reason: record.failureReason,
      completionSummary: record.completionSummary,
    };
  }

  // 4. Revalidate Git checkpoint immediately before staging and committing
  const checkpoint = await revalidateGitCheckpoint(record.baseline, 'BEFORE_STAGING_AND_COMMIT', {
    allowAuthorizedFileMutations: true,
  });
  if (!checkpoint.ok) {
    record.state = checkpoint.blockedStatus === 'BLOCKED_GIT_CONFLICT' ? 'BLOCKED_GIT_CONFLICT' : 'BLOCKED_STALE_VERIFICATION';
    record.failureReason = checkpoint.actionTaken;
    await saveRecord(record);
    return {
      committed: false,
      state: record.state,
      candidateRevisionHash: currentRevisionHash,
      filesCommitted: [],
      reason: checkpoint.actionTaken,
      completionSummary: record.completionSummary,
    };
  }

  // Also ensure no unauthorized untracked/modified files exist in the candidate worktree
  if (checkpoint.conflictingFiles.length > 0) {
    record.state = 'BLOCKED_GIT_CONFLICT';
    record.failureReason = `UNEXPECTED_WORKTREE_CHANGES: Unrelated files modified or staged (${checkpoint.conflictingFiles.join(', ')})`;
    await saveRecord(record);
    return {
      committed: false,
      state: record.state,
      candidateRevisionHash: currentRevisionHash,
      filesCommitted: [],
      reason: record.failureReason,
      completionSummary: record.completionSummary,
    };
  }

  // 5. Scan candidate files for secrets and prohibited files
  const secretScan = await scanCandidateForSecrets(worktreeDir, record.intendedFiles);
  if (!secretScan.clean) {
    record.state = 'BLOCKED_SECRET_DETECTED';
    record.failureReason = `BLOCKED_SECRET_DETECTED: ${secretScan.findings.map((f) => `${f.file} (${f.reason})`).join('; ')}`;
    await saveRecord(record);
    return {
      committed: false,
      state: record.state,
      candidateRevisionHash: currentRevisionHash,
      filesCommitted: [],
      reason: record.failureReason,
      completionSummary: record.completionSummary,
    };
  }

  // 6. Transition to COMMITTING durability checkpoint BEFORE invoking git commit
  record.state = 'COMMITTING';
  await saveRecord(record);

  // 7. Unstage any pre-existing index state and stage ONLY intended files
  await runGitCommand(['reset'], worktreeDir);
  const addRes = await runGitCommand(['add', '--', ...record.intendedFiles], worktreeDir);
  if (!addRes.ok) {
    record.state = 'COMMIT_FAILED';
    record.failureReason = `Failed to stage intended files: ${addRes.stderr}`;
    await saveRecord(record);
    return {
      committed: false,
      state: record.state,
      candidateRevisionHash: currentRevisionHash,
      filesCommitted: [],
      reason: record.failureReason,
      completionSummary: record.completionSummary,
    };
  }

  // 8. Verify staged diff contains ONLY intended files and is non-empty
  const stagedNamesRes = await runGitCommand(['diff', '--cached', '--name-only'], worktreeDir);
  const stagedFiles = stagedNamesRes.stdout.split('\n').map((f) => f.trim()).filter(Boolean);
  if (stagedFiles.length === 0) {
    record.state = 'KEPT_UNCOMMITTED';
    record.failureReason = 'NO_CHANGES: Staged diff is empty; no commit created';
    await saveRecord(record);
    return {
      committed: false,
      state: record.state,
      candidateRevisionHash: currentRevisionHash,
      filesCommitted: [],
      reason: record.failureReason,
      completionSummary: record.completionSummary,
    };
  }

  const intendedSet = new Set(record.intendedFiles);
  const extraStaged = stagedFiles.filter((f) => !intendedSet.has(f));
  if (extraStaged.length > 0) {
    await runGitCommand(['reset'], worktreeDir);
    record.state = 'BLOCKED_GIT_CONFLICT';
    record.failureReason = `STAGING_ISOLATION_VIOLATION: Refusing to commit unrelated staged files (${extraStaged.join(', ')})`;
    await saveRecord(record);
    return {
      committed: false,
      state: record.state,
      candidateRevisionHash: currentRevisionHash,
      filesCommitted: [],
      reason: record.failureReason,
      completionSummary: record.completionSummary,
    };
  }

  // 9. Commit with Git hooks ENABLED (allowHooks: true -> does NOT pass -c core.hooksPath=/dev/null or --no-verify)
  const commitRes = await runGitCommand(['commit', '-m', record.commitMessage], worktreeDir, {
    allowHooks: true,
    timeoutMs: 30_000,
  });
  if (!commitRes.ok) {
    record.state = 'COMMIT_FAILED';
    record.failureReason = `GIT_COMMIT_OR_HOOK_FAILED: ${commitRes.stderr || commitRes.stdout}`;
    await saveRecord(record);
    return {
      committed: false,
      state: record.state,
      candidateRevisionHash: currentRevisionHash,
      filesCommitted: [],
      reason: record.failureReason,
      completionSummary: record.completionSummary,
    };
  }

  // 10. Confirm commit SHA and verify committed tree contains only intended changes
  const shaRes = await runGitCommand(['rev-parse', 'HEAD'], worktreeDir);
  const commitSha = shaRes.stdout.trim();
  const committedFilesRes = await runGitCommand(['diff-tree', '--no-commit-id', '--name-only', '-r', commitSha], worktreeDir);
  const committedFiles = committedFilesRes.stdout.split('\n').map((f) => f.trim()).filter(Boolean);

  record.state = 'COMMITTED';
  record.commitSha = commitSha;
  record.committedAt = new Date().toISOString();
  record.failureReason = undefined;
  await saveRecord(record);

  return {
    committed: true,
    state: 'COMMITTED',
    commitSha,
    candidateRevisionHash: currentRevisionHash,
    filesCommitted: committedFiles.length > 0 ? committedFiles : stagedFiles,
    reason: `Committed verified changes as ${commitSha}`,
    completionSummary: record.completionSummary,
  };
}

/**
 * Reconciles a candidate that was interrupted while in COMMITTING or AWAITING_COMMIT_APPROVAL state
 * (e.g. commit succeeded on disk right before process crash, or supervisor restarted while waiting for approval).
 */
export async function reconcileCandidateAfterRestart(
  record: DurableCandidateRecord,
  store: KeyValueStore,
): Promise<DurableCandidateRecord> {
  const worktreeDir = record.baseline.worktreePath;
  if (!existsSync(worktreeDir)) {
    return record;
  }

  if (record.state === 'COMMITTING') {
    const headRes = await runGitCommand(['rev-parse', 'HEAD'], worktreeDir);
    const currentHead = headRes.ok ? headRes.stdout.trim() : '';
    if (currentHead && currentHead !== record.baseline.baselineSha) {
      // The commit succeeded before the crash! Reconcile to COMMITTED without re-running git commit.
      record.state = 'COMMITTED';
      record.commitSha = currentHead;
      record.committedAt = record.committedAt ?? new Date().toISOString();
      record.failureReason = undefined;
      record.updatedAt = new Date().toISOString();
      await store.put(`supervisor/git-candidates/${record.attemptId}`, record);
      return record;
    }
    // Commit did not complete before crash; return to AWAITING_COMMIT_APPROVAL or READY_FOR_REVIEW
    record.state = 'AWAITING_COMMIT_APPROVAL';
    record.updatedAt = new Date().toISOString();
    await store.put(`supervisor/git-candidates/${record.attemptId}`, record);
  }

  if (record.state === 'AWAITING_COMMIT_APPROVAL') {
    const currentHash = await computeCandidateRevisionHash(worktreeDir, record.intendedFiles);
    if (currentHash !== record.candidateRevisionHash) {
      record.state = 'BLOCKED_STALE_VERIFICATION';
      record.failureReason = 'STALE_VERIFICATION: Candidate files were modified while awaiting approval';
      record.updatedAt = new Date().toISOString();
      await store.put(`supervisor/git-candidates/${record.attemptId}`, record);
    }
  }

  return record;
}

/**
 * Handles a manual approval workflow decision (`COMMIT`, `REVISE`, `KEEP_UNCOMMITTED`, `DISCARD`, `CANCEL`)
 * for a candidate in `AWAITING_COMMIT_APPROVAL` (Section 8).
 */
export async function handleManualCommitApproval(params: {
  attemptId: string;
  action: ManualApprovalAction;
  store: KeyValueStore;
  approvedRevisionHash?: string;
  confirmDiscard?: boolean;
}): Promise<{
  ok: boolean;
  state: CandidateLifecycleState;
  commitSha?: string;
  reason: string;
  record?: DurableCandidateRecord;
}> {
  const key = `supervisor/git-candidates/${params.attemptId}`;
  const existing = await params.store.get<DurableCandidateRecord>(key);
  if (!existing) {
    return {
      ok: false,
      state: 'CANCELLED',
      reason: `Candidate '${params.attemptId}' not found`,
    };
  }

  const record = await reconcileCandidateAfterRestart(existing, params.store);
  if (record.state === 'COMMITTED') {
    return {
      ok: true,
      state: 'COMMITTED',
      commitSha: record.commitSha,
      reason: `Candidate '${params.attemptId}' was already committed (${record.commitSha})`,
      record,
    };
  }

  switch (params.action) {
    case 'COMMIT': {
      // Check if authorization expired; if not, bind manual approval to exact candidate revision
      record.commitAuthorization = {
        ...record.commitAuthorization,
        boundCandidateRevision: params.approvedRevisionHash ?? record.candidateRevisionHash,
        permissions: {
          ...record.commitAuthorization.permissions,
          commitAuthorized: true,
        },
      };
      const res = await executeVerifiedCandidateCommit({
        record,
        store: params.store,
        approvedRevisionHash: params.approvedRevisionHash ?? record.candidateRevisionHash,
      });
      return {
        ok: res.committed,
        state: res.state,
        commitSha: res.commitSha,
        reason: res.reason,
        record,
      };
    }
    case 'REVISE': {
      record.state = 'IMPLEMENTING';
      record.updatedAt = new Date().toISOString();
      await params.store.put(key, record);
      return {
        ok: true,
        state: 'IMPLEMENTING',
        reason: `Candidate '${params.attemptId}' returned to IMPLEMENTING for revision`,
        record,
      };
    }
    case 'KEEP_UNCOMMITTED': {
      record.state = 'KEPT_UNCOMMITTED';
      record.updatedAt = new Date().toISOString();
      await params.store.put(key, record);
      return {
        ok: true,
        state: 'KEPT_UNCOMMITTED',
        reason: `Preserved verified changes uncommitted in worktree '${record.baseline.worktreePath}'`,
        record,
      };
    }
    case 'DISCARD': {
      if (!params.confirmDiscard) {
        return {
          ok: false,
          state: record.state,
          reason: 'DISCARD_CONFIRMATION_REQUIRED: Pass confirmDiscard=true (--confirm-discard) before destructive worktree deletion',
          record,
        };
      }
      if (existsSync(record.baseline.worktreePath)) {
        await runGitCommand(['worktree', 'remove', '--force', record.baseline.worktreePath], record.baseline.repositoryRoot);
        await fs.rm(record.baseline.worktreePath, { recursive: true, force: true }).catch(() => undefined);
      }
      record.state = 'DISCARDED';
      record.updatedAt = new Date().toISOString();
      await params.store.put(key, record);
      return {
        ok: true,
        state: 'DISCARDED',
        reason: `Discarded candidate worktree '${record.baseline.worktreePath}' after explicit confirmation`,
        record,
      };
    }
    case 'CANCEL': {
      record.state = 'CANCELLED';
      record.updatedAt = new Date().toISOString();
      await params.store.put(key, record);
      return {
        ok: true,
        state: 'CANCELLED',
        reason: `Cancelled task '${params.attemptId}' while retaining recoverable state at '${record.baseline.worktreePath}'`,
        record,
      };
    }
  }
}
