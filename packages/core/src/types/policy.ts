export type PolicyEffect = 'allow' | 'ask' | 'deny';

export interface PolicyActionRequest {
  tool: string;
  input: Record<string, unknown>;
  executionId?: string;
  projectRoot?: string;
}

export interface PolicyDecision {
  decision: PolicyEffect;
  rule: string;
  reasons: string[];
}

export interface PolicyRule {
  id: string;
  description: string;
  effect: PolicyEffect;
}

export interface PolicyEngineOptions {
  projectRoot: string;
  networkAllowed?: boolean;
  /** Extra shell command prefixes that are always allowed. */
  allowCommands?: string[];
  /** Extra shell command prefixes that are always denied. */
  denyCommands?: string[];
  allowedMcpServers?: string[];
  /**
   * Approves 'ask' decisions interactively. When absent, 'ask' is
   * escalated to 'deny' — Rook never silently allows.
   */
  approveCallback?: (request: PolicyActionRequest, decision: PolicyDecision) => Promise<boolean>;
}
