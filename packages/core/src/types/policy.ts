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
  tool?: string;
  command?: string;
  reasons: string[];
}

export interface PolicyRule {
  id: string;
  scope?: string;
  pattern?: string;
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
   * Whether executable artifacts inside the project root (e.g. ./main, ./build/app)
   * can be executed without requiring interactive approval. Defaults to true.
   */
  allowWorkspaceArtifactExecution?: boolean;
  /**
   * Approves 'ask' decisions interactively. When absent, 'ask' is
   * escalated to 'deny' — Wazir never silently allows.
   */
  approveCallback?: (request: PolicyActionRequest, decision: PolicyDecision) => Promise<boolean>;
  /** Non-blocking approval queue for multi-agent execution. */
  approvalQueue?: {
    enqueue: (request: PolicyActionRequest, decision: PolicyDecision) => Promise<boolean>;
    /** When false, 'ask' falls through to `approveCallback` (if any) instead of waiting on the queue. */
    hasSubscribers?: boolean;
  };
}
