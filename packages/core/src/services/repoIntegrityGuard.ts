import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GIT_NO_HOOKS } from '@wazir/shared';

const execFileAsync = promisify(execFile);

export interface RepoHeadFingerprint {
  branch: string;
  sha: string;
}

/**
 * Snapshots the checked-out branch and commit of a project root, if it is a git
 * repository. Returns undefined for a non-git workspace (nothing to guard).
 */
export async function captureHeadFingerprint(projectRoot: string): Promise<RepoHeadFingerprint | undefined> {
  try {
    const [branch, sha] = await Promise.all([
      execFileAsync('git', [...GIT_NO_HOOKS, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot }).then((r) => r.stdout.trim()),
      execFileAsync('git', [...GIT_NO_HOOKS, 'rev-parse', 'HEAD^{commit}'], { cwd: projectRoot }).then((r) => r.stdout.trim()),
    ]);
    return { branch, sha };
  } catch {
    return undefined;
  }
}

/**
 * Compares a fingerprint taken before a task ran against the repository's current
 * state. Returns a human-readable description of unexpected drift, or undefined if
 * the checked-out branch and commit are unchanged (or the workspace isn't a git repo,
 * or the user switched branches themselves — only an unexplained commit move on the
 * *same* branch is reported, since branch switches are an ordinary user action).
 *
 * This exists as defense-in-depth: a 2026-10-17 audit observed a single `wa run` task
 * invocation coincide with an unauthorized merge commit landing on the user's checked-out
 * branch, with no trace in Wazir's own policy/audit/event logs. The exact trigger was not
 * isolated despite a thorough source audit (ruled out the updater, the documented
 * worktree-merge-back helpers, and the task's own tool-call log). Regardless of mechanism,
 * Wazir must never hand back a task result without telling the user their repository
 * history moved underneath them.
 */
export async function describeUnexpectedHeadDrift(
  projectRoot: string,
  before: RepoHeadFingerprint | undefined,
): Promise<string | undefined> {
  if (!before) return undefined;
  const after = await captureHeadFingerprint(projectRoot);
  if (!after) return undefined;
  if (after.branch !== before.branch) return undefined;
  if (after.sha === before.sha) return undefined;
  return (
    `repository integrity check failed: branch '${before.branch}' moved from ${before.sha} to ${after.sha} ` +
    `during this task, without going through an audited merge. Do not trust this task's result until you've ` +
    `inspected what changed (git log --oneline ${before.sha}..${after.sha}) and decided whether to keep or revert it.`
  );
}
