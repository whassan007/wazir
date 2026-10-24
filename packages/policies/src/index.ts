import {
  PolicyEngine,
  type PolicyActionRequest,
  type PolicyDecision,
  type PolicyEngineOptions,
} from '@wazir/core';
import type { Task } from '@wazir/core';

/**
 * @wazir/policies — policy enforcement facade over the core PolicyEngine.
 *
 * Agents propose actions; the policy engine authorizes them; tools execute
 * only what is authorized. Models never bypass this layer.
 */
export { PolicyEngine };
export type { PolicyActionRequest, PolicyDecision, PolicyEngineOptions };

export function createPolicyEngine(options: PolicyEngineOptions): PolicyEngine {
  return new PolicyEngine(options);
}

export async function authorize(
  engine: PolicyEngine,
  request: PolicyActionRequest,
): Promise<PolicyDecision> {
  return engine.authorize(request);
}

export function evaluateTask(engine: PolicyEngine, task: Task): { allowed: boolean; reasons: string[] } {
  return engine.evaluateTask(task);
}

// ---------------------------------------------------------------------------
// Spec write fence (WFA §1.5). The authoritative implementation lives in the
// core PolicyEngine; these helpers only expose it. `@wazir/assurance` composes
// them through injected instances and never re-implements the rules.
// ---------------------------------------------------------------------------

export type SpecFenceRegistration = Parameters<PolicyEngine['registerSpecFence']>[1];

/** Records the trusted, persisted role of an execution. Call from task setup, never from agent input. */
export function registerSpecFence(engine: PolicyEngine, executionId: string, registration: SpecFenceRegistration): void {
  engine.registerSpecFence(executionId, registration);
}

/** The `spec-write-fence-deny` / `spec-approval-human-only-deny` decision for a request, or null when the fence does not apply. */
export function evaluateSpecFence(engine: PolicyEngine, request: PolicyActionRequest): PolicyDecision | null {
  return engine.evaluateSpecFence(request);
}

/** Only the persisted `spec-author` role may change specifications; missing or unknown roles are fenced. */
export function isSpecAuthorRole(role: unknown): boolean {
  return PolicyEngine.isSpecAuthorRole(role);
}

/** The `SPEC_WRITE_FENCE: ...` merge blocker for a task's changed paths, or null when allowed. */
export function specWriteFenceBlocker(
  taskId: string,
  role: string | undefined,
  changes: ReadonlyArray<{ path: string; previousPath?: string }>,
  specDirs?: readonly string[],
): string | null {
  return PolicyEngine.specWriteFenceBlocker(taskId, role, PolicyEngine.specFenceTouchedPaths(changes, specDirs));
}
