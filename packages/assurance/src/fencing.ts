/**
 * Spec write fencing (FORMAL_ASSURANCE.md §2.2, DESIGN.md §1.5).
 *
 * The authoritative, role-aware fence lives in the core `PolicyEngine`
 * (Layer A: `spec-write-fence-deny`), `WorktreeManager` (Layer A: read-only
 * spec directory + sandbox rules) and `VerifiedIntegrationCoordinator`
 * (Layer B: `SPEC_WRITE_FENCE` merge blocker), exposed through
 * `@wazir/policies`. This module only wires those pieces together for an
 * assurance task. It takes them as injected instances, so `@wazir/assurance`
 * neither re-implements the rules nor makes core depend on it (DESIGN_REVIEW
 * finding 3).
 *
 * Roles always come from the persisted task record. A role carried by an
 * agent (manifest, tool input, environment) is never consulted.
 */

export type AssuranceTaskRole = 'spec-author' | 'implementation' | 'repair' | 'verification';

/** The persisted task record, as stored by the job manager. Only `role` matters to the fence. */
export interface TrustedTaskRecord {
  id: string;
  role?: string;
}

export interface SpecFenceDecision {
  decision: 'allow' | 'ask' | 'deny';
  rule: string;
  reasons: string[];
}

/** The subset of the core `PolicyEngine` the fence uses. */
export interface SpecFencePolicyEngine {
  registerSpecFence(executionId: string, registration: { role?: string; requiredIsolation?: string }): void;
  clearSpecFence(executionId: string): void;
  evaluateSpecFence(request: { tool: string; input: Record<string, unknown>; executionId?: string; projectRoot?: string }): SpecFenceDecision | null;
}

export interface SpecReadOnlyFenceInfo {
  role?: string;
  readOnlyPaths: string[];
  bwrapArgs: string[];
  seatbeltRules: string[];
  requiredIsolation: string;
  identities: Array<{ path: string; dev: number; ino: number }>;
}

/** The subset of the core `WorktreeManager` the fence uses. */
export interface SpecFenceWorktrees {
  applySpecReadOnlyFence(worktreeDir: string, role?: string): Promise<SpecReadOnlyFenceInfo | undefined>;
  verifySpecReadOnlyFence(fence: SpecReadOnlyFenceInfo): Promise<string[]>;
}

/** The subset of the core `VerifiedIntegrationCoordinator` the fence uses. */
export interface SpecFenceMergeGate {
  checkSpecWriteFence(repository: string, targetRef: string, branch: string, taskId: string): Promise<{ touchedSpecPaths: string[]; role?: string; blockers: string[] }>;
}

export interface FencedTaskWorkspace {
  task: TrustedTaskRecord;
  executionId: string;
  /** Absent only for `spec-author` tasks. */
  fence?: SpecReadOnlyFenceInfo;
}

/**
 * Applies Layer A to a task's worktree: makes `specs/` read-only (unless the
 * persisted role is `spec-author`) and registers the trusted role, plus the
 * sandbox requirement, with the policy engine for `executionId`. With that
 * requirement registered, the engine fails closed (`isolation-unavailable`)
 * when the execution is not running under an OS sandbox.
 */
export async function fenceTaskWorkspace(options: {
  engine: SpecFencePolicyEngine;
  worktrees: SpecFenceWorktrees;
  worktreeDir: string;
  executionId: string;
  task: TrustedTaskRecord;
}): Promise<FencedTaskWorkspace> {
  const { engine, worktrees, worktreeDir, executionId, task } = options;
  const fence = await worktrees.applySpecReadOnlyFence(worktreeDir, task.role);
  engine.registerSpecFence(executionId, { role: task.role, requiredIsolation: fence?.requiredIsolation });
  return { task, executionId, fence };
}

/** Re-checks a fenced worktree (permissions restored, directory replaced or symlinked). */
export async function verifyTaskWorkspaceFence(worktrees: SpecFenceWorktrees, workspace: FencedTaskWorkspace): Promise<string[]> {
  return workspace.fence ? worktrees.verifySpecReadOnlyFence(workspace.fence) : [];
}

/**
 * Layer B: the `SPEC_WRITE_FENCE` blockers for a task's branch. The gate looks
 * up the role through its own trusted resolver, keyed by `task.id`.
 */
export async function checkSpecMerge(
  gate: SpecFenceMergeGate,
  repository: string,
  targetRef: string,
  branch: string,
  task: TrustedTaskRecord,
): Promise<string[]> {
  return (await gate.checkSpecWriteFence(repository, targetRef, branch, task.id)).blockers;
}

/**
 * Builds a `resolveTaskRole` lookup over persisted task records for the
 * policy engine and the integration coordinator. Unknown ids resolve to
 * undefined, which the fence treats as denied.
 */
export function createTaskRoleResolver(tasks: Iterable<TrustedTaskRecord>): (taskId: string) => string | undefined {
  const roles = new Map<string, string | undefined>();
  for (const task of tasks) roles.set(task.id, task.role);
  return (taskId: string) => roles.get(taskId);
}
