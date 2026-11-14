import path from 'node:path';

export interface DelegatedGrant {
  id: string;
  parentAgentId: string;
  childAgentId: string;
  allowedTools: readonly string[];
  capabilities: readonly string[];
  pathScopes: readonly string[];
  canDelegate: boolean;
  /** Maximum number of edges below this grant's parent principal. */
  maxDepth: number;
  expiresAt?: number;
  revoked?: boolean;
}

export interface DelegatedApproval {
  id: string;
  agentId: string;
  tool: string;
  oneTime?: boolean;
  consumed?: boolean;
}

export interface DelegatedAction {
  agentId: string;
  tool: string;
  capability?: string;
  path?: string;
  approvalId?: string;
}

export interface DelegatedDecision {
  allowed: boolean;
  reason: string;
}

/** In-memory authority for grants issued by the controller, never by tool input. */
export class DelegatedPolicyGate {
  private readonly grants = new Map<string, DelegatedGrant>();
  private readonly approvals = new Map<string, DelegatedApproval>();

  constructor(private readonly now: () => number = Date.now) {}

  registerGrant(grant: DelegatedGrant): DelegatedDecision {
    if (!grant.id || !grant.parentAgentId || !grant.childAgentId || grant.parentAgentId === grant.childAgentId ||
        this.grants.has(grant.childAgentId) || !Number.isInteger(grant.maxDepth) || grant.maxDepth < 1) {
      return { allowed: false, reason: 'invalid or duplicate delegation grant' };
    }
    const ancestors = this.chain(grant.parentAgentId);
    if (!ancestors) return { allowed: false, reason: 'delegation chain contains a cycle' };
    if (ancestors.some((ancestor) => ancestor.childAgentId === grant.childAgentId)) {
      return { allowed: false, reason: 'delegation chain contains a cycle' };
    }
    for (let i = 0; i < ancestors.length; i++) {
      const ancestor = ancestors[i];
      if (ancestor.revoked || (ancestor.expiresAt !== undefined && ancestor.expiresAt <= this.now())) {
        return { allowed: false, reason: `ancestor grant '${ancestor.id}' is revoked or expired` };
      }
      if (!ancestor.canDelegate) return { allowed: false, reason: `ancestor grant '${ancestor.id}' forbids delegation` };
      if (i + 2 > ancestor.maxDepth) return { allowed: false, reason: `ancestor grant '${ancestor.id}' exceeds maxDepth` };
      if (!grant.allowedTools.every((tool) => ancestor.allowedTools.includes(tool)) ||
          !grant.capabilities.every((capability) => ancestor.capabilities.includes(capability)) ||
          !grant.pathScopes.every((scope) => ancestor.pathScopes.some((parentScope) => inside(parentScope, scope)))) {
        return { allowed: false, reason: `grant exceeds ancestor '${ancestor.id}' scope` };
      }
    }
    this.grants.set(grant.childAgentId, { ...grant, allowedTools: [...grant.allowedTools], capabilities: [...grant.capabilities], pathScopes: [...grant.pathScopes] });
    return { allowed: true, reason: 'grant registered' };
  }

  revokeGrant(childAgentId: string): void {
    const grant = this.grants.get(childAgentId);
    if (grant) this.grants.set(childAgentId, { ...grant, revoked: true });
  }

  registerApproval(approval: DelegatedApproval): void {
    if (!approval.id || this.approvals.has(approval.id)) throw new Error('invalid or duplicate approval');
    this.approvals.set(approval.id, { ...approval });
  }

  evaluate(action: DelegatedAction): DelegatedDecision {
    const chain = this.chain(action.agentId);
    if (!chain || chain.length === 0) return { allowed: false, reason: 'no valid delegation chain' };
    for (let i = 0; i < chain.length; i++) {
      const grant = chain[i];
      if (grant.revoked || (grant.expiresAt !== undefined && grant.expiresAt <= this.now())) {
        return { allowed: false, reason: `grant '${grant.id}' is revoked or expired` };
      }
      if (i + 1 > grant.maxDepth) return { allowed: false, reason: `grant '${grant.id}' exceeds maxDepth` };
      if (i > 0 && !grant.canDelegate) return { allowed: false, reason: `grant '${grant.id}' forbids delegation` };
      if (!grant.allowedTools.includes(action.tool) ||
          (action.capability !== undefined && !grant.capabilities.includes(action.capability)) ||
          (action.path !== undefined && !grant.pathScopes.some((scope) => inside(scope, action.path!)))) {
        return { allowed: false, reason: `action exceeds grant '${grant.id}' scope` };
      }
    }
    if (action.approvalId !== undefined) {
      const approval = this.approvals.get(action.approvalId);
      if (!approval || approval.agentId !== action.agentId || approval.tool !== action.tool || approval.consumed) {
        return { allowed: false, reason: 'approval is missing, mismatched, or consumed' };
      }
      if (approval.oneTime !== false) approval.consumed = true;
    }
    return { allowed: true, reason: 'authorized by complete delegation chain' };
  }

  private chain(agentId: string): DelegatedGrant[] | null {
    const result: DelegatedGrant[] = [];
    const visited = new Set<string>();
    let current = agentId;
    while (this.grants.has(current)) {
      if (visited.has(current)) return null;
      visited.add(current);
      const grant = this.grants.get(current)!;
      result.push(grant);
      current = grant.parentAgentId;
    }
    return result;
  }
}

function inside(scope: string, candidate: string): boolean {
  const root = path.resolve(scope);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
