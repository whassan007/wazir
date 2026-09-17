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
